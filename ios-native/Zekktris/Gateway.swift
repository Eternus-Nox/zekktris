import Foundation

/// Realtime gateway client over `URLSessionWebSocketTask`, mirroring the
/// protocol in `packages/client/src/gateway.ts`:
///
///   server → HELLO (op 7, d.heartbeat_interval)
///   client → IDENTIFY (op 2, d:{ token, properties })  + start heartbeats
///   server → DISPATCH READY (op 0, t:"READY")  … then DISPATCH events
///   client → HEARTBEAT (op 1, d:{ seq }) every interval
///
/// Stage 1 surfaces dispatch events through `onEvent(name, rawData)` where
/// `rawData` is the JSON of the frame's `d`. Robustness mirrors the web
/// client: exponential reconnect backoff (1s→30s + jitter, reset on READY),
/// a HEARTBEAT_ACK watchdog that detects zombie sockets, and `forceReconnect()`
/// for app-foreground recovery.
@MainActor
final class Gateway: ObservableObject {
    enum Status: String {
        case idle, connecting, identifying, ready, reconnecting, closed
    }

    @Published private(set) var status: Status = .idle

    /// Invoked on the main actor for every DISPATCH frame.
    /// `data` is the serialized `d` payload (decode it into the right model).
    var onEvent: ((_ name: String, _ data: Data) -> Void)?

    private let urlSession = URLSession(configuration: .default)
    private var task: URLSessionWebSocketTask?
    private var heartbeatTask: Task<Void, Never>?
    private var reconnectTask: Task<Void, Never>?
    /// Fires if no HEARTBEAT_ACK arrives within `heartbeatAckTimeoutMs` of a
    /// heartbeat send, indicating the socket is a zombie (silent TCP death,
    /// common on mobile network switches / backgrounding, with no close event).
    private var ackWatchdogTask: Task<Void, Never>?
    private var lastSeq: Int?
    /// Logical session id from the last READY/RESUMED. Persisted across socket
    /// drops so an AUTOMATIC reconnect can attempt RESUME; nil → IDENTIFY fresh.
    /// Cleared on an intentional connect()/disconnect() and when the server
    /// rejects a resume. Mirrors the web client (gateway.ts).
    private var sessionId: String?
    /// True between sending RESUME and receiving RESUMED/INVALID_SESSION — lets
    /// the INVALID_SESSION handler tell "resume rejected → fall back to
    /// IDENTIFY" from "IDENTIFY rejected → fatal".
    private var resuming = false
    private var token: String?
    private var tokenObserver: NSObjectProtocol?
    private var intentionallyClosed = false
    /// Guards the IDENTIFY-rejected → one-shot-token-refresh recovery so a
    /// server that keeps rejecting (genuine revoke) can't loop forever.
    /// Reset to false on a successful READY.
    private var identifyRefreshAttempted = false
    /// Dedups reconnect scheduling so the zombie-watchdog and a real close
    /// event racing each other can't double-advance the backoff. Reset when a
    /// socket opens.
    private var reconnectScheduled = false

    /// Exponential backoff, mirroring the web client: start at 1s, double on
    /// each failed attempt up to a 30s cap (+ jitter), reset to 1s on a
    /// successful READY so a brief blip doesn't leave us in a slow-retry state.
    private var backoffMs = 1_000
    private let maxBackoffMs = 30_000
    private let heartbeatAckTimeoutMs = 10_000

    /// A SEPARATE, much slower backoff for AUTH failures (IDENTIFY rejected and
    /// the one-shot token refresh didn't rescue it). Distinct from `backoffMs`
    /// (transport) because a genuine revoke must not hot-loop the server: 30s →
    /// 5min is slow enough to cost nothing, quick enough that a transient blip
    /// heals by itself. Reset on READY/RESUMED.
    private var authBackoffMs = 30_000
    private let maxAuthBackoffMs = 300_000

    // MARK: Lifecycle

    func connect(token: String) {
        self.token = token
        intentionallyClosed = false
        // A fresh connect() is a NEW logical session — never resume into it.
        // (Automatic reconnects go through openSocket() directly and DO keep
        // sessionId/lastSeq so they can RESUME; connect() is login/app-start.)
        sessionId = nil
        lastSeq = nil
        resuming = false
        reconnectTask?.cancel(); reconnectTask = nil
        // Track access-token rotations (15-min expiry + cookie refresh) so
        // the next IDENTIFY — e.g. after a reconnect — uses a live token
        // instead of the one we connected with.
        if tokenObserver == nil {
            tokenObserver = NotificationCenter.default.addObserver(
                forName: APIClient.tokenRefreshedNotification, object: nil, queue: .main
            ) { [weak self] note in
                guard let fresh = note.object as? String else { return }
                Task { @MainActor in self?.token = fresh }
            }
        }
        openSocket()
    }

    func disconnect() {
        intentionallyClosed = true
        heartbeatTask?.cancel(); heartbeatTask = nil
        reconnectTask?.cancel(); reconnectTask = nil
        ackWatchdogTask?.cancel(); ackWatchdogTask = nil
        task?.cancel(with: .goingAway, reason: nil)
        task = nil
        backoffMs = 1_000
        // Intentional disconnect ends the logical session; the next connect
        // IDENTIFYs fresh rather than resuming a now-stale session.
        sessionId = nil
        lastSeq = nil
        resuming = false
        status = .closed
    }

    /// Force an immediate reconnect, bypassing the backoff wait. Called when
    /// the app returns to the foreground: iOS suspends sockets in the
    /// background and the death frequently arrives with no close event, so the
    /// only reliable recovery is to tear the socket down and reconnect. No-op
    /// if we never connected.
    ///
    /// Crucially this CLEARS the `intentionallyClosed` / `identifyRefreshAttempted`
    /// latches. Those latch true when an IDENTIFY is rejected (expired token)
    /// and the one-shot token refresh fails — which on a cold foreground is
    /// often just a transient network race, not a real revoke. Without clearing
    /// them, that one failure permanently wedged the gateway closed: every
    /// later foreground `forceReconnect()` hit the old `!intentionallyClosed`
    /// guard and no-op'd, so realtime stayed dead (no new messages) until the
    /// app was relaunched — while REST kept working off the cookie, which is
    /// why leaving+re-entering a conversation (a REST fetch) still worked. A
    /// foreground is an explicit "reconnect now" and the right moment to retry
    /// IDENTIFY + refresh again. Safe: a real sign-out goes through
    /// `disconnect()` + store `stop()`, after which `currentUserId` is nil so
    /// `foregroundReconnect` never calls this.
    func forceReconnect() {
        guard token != nil else { return }
        intentionallyClosed = false
        identifyRefreshAttempted = false
        reconnectTask?.cancel(); reconnectTask = nil
        ackWatchdogTask?.cancel(); ackWatchdogTask = nil
        heartbeatTask?.cancel(); heartbeatTask = nil
        backoffMs = 1_000
        authBackoffMs = 30_000
        // Drop the old socket (possibly a zombie). Its pending receive will
        // fail, but the identity check in receive() ignores non-current tasks.
        let dead = task
        task = nil
        dead?.cancel(with: .goingAway, reason: nil)
        openSocket()
    }

    private func openSocket() {
        guard token != nil else { return }
        // Never leave a previous socket dangling. openSocket() is reached from
        // several paths (cold connect, transport reconnect, auth retry, and the
        // refresh-success branch); overwriting `task` without cancelling would
        // strand a zombie receive loop on the old socket. `forceReconnect()`
        // already does this itself, so this is a no-op there.
        if let old = task {
            task = nil
            old.cancel(with: .goingAway, reason: nil)
        }
        reconnectScheduled = false
        status = .connecting
        let t = urlSession.webSocketTask(with: Config.gatewayURL)
        task = t
        t.resume()
        receive()
    }

    // MARK: Receive loop

    private func receive() {
        guard let task else { return }
        task.receive { [weak self] result in
            guard let self else { return }
            switch result {
            case .failure:
                Task { @MainActor in
                    // Ignore failures from a socket we've already replaced
                    // (e.g. after forceReconnect or the zombie watchdog).
                    guard self.task === task else { return }
                    self.handleClose()
                }
            case .success(let message):
                Task { @MainActor in
                    guard self.task === task else { return }
                    switch message {
                    case .string(let text):
                        self.handleFrame(text)
                    case .data(let data):
                        if let text = String(data: data, encoding: .utf8) { self.handleFrame(text) }
                    @unknown default:
                        break
                    }
                    // Re-arm for the next frame unless we've torn down.
                    if !self.intentionallyClosed, self.task != nil { self.receive() }
                }
            }
        }
    }

    // MARK: Frame handling

    private func handleFrame(_ text: String) {
        guard let data = text.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let op = obj["op"] as? Int
        else { return }

        if let s = obj["s"] as? Int { lastSeq = s }

        switch op {
        case 7: // HELLO
            let interval = (obj["d"] as? [String: Any])?["heartbeat_interval"] as? Int ?? 30_000
            startHeartbeat(intervalMs: interval)
            // If we hold a retained session + last seq (an automatic reconnect),
            // try RESUME to replay the events we missed; otherwise IDENTIFY
            // fresh. A server that can't resume replies INVALID_SESSION and we
            // transparently fall back. Mirrors the web client.
            if canResume() { sendResume() } else { sendIdentify() }
        case 8: // HEARTBEAT_ACK — socket is alive; disarm the zombie watchdog.
            ackWatchdogTask?.cancel(); ackWatchdogTask = nil
        case 6: // INVALID_SESSION
            if resuming {
                // Our RESUME couldn't be satisfied (unknown/expired session, gap
                // too large, a different node, or malformed). Fall back to a
                // fresh IDENTIFY on this SAME open socket — fully transparent;
                // the READY that follows runs the usual reconnect resync. NOT
                // fatal. (A revoked/banned token instead gets a server-side
                // close after this frame; the IDENTIFY send then no-ops and the
                // close drives a normal reconnect → IDENTIFY → fatal, exactly as
                // the web client behaves.)
                resuming = false
                sessionId = nil
                lastSeq = nil
                sendIdentify()
                return
            }
            // IDENTIFY itself was rejected. The common, RECOVERABLE cause is a
            // simply-expired access token: tokens live ~15 min and only refresh
            // on REST 401s, so after the app idles in the background past expiry
            // the foreground reconnect IDENTIFYs with a stale token and lands
            // here. Attempt ONE immediate token refresh and reconnect; if that
            // refresh fails, fall back to the SLOW auth retry. Never latch —
            // `refreshAccessToken()` returns false for a dropped packet, a 5xx
            // and a genuine revoke ALIKE, so latching on it wedged realtime dead
            // (send worked over REST, receive never did) for the rest of the
            // foreground session. See `scheduleAuthRetry`.
            heartbeatTask?.cancel(); heartbeatTask = nil
            ackWatchdogTask?.cancel(); ackWatchdogTask = nil
            if identifyRefreshAttempted {
                scheduleAuthRetry()
                return
            }
            identifyRefreshAttempted = true
            status = .connecting
            Task { @MainActor in
                let ok = await APIClient.shared.refreshAccessToken()
                // This Task is not stored, so `disconnect()` cannot cancel it. A
                // sign-out landing during the refresh round-trip would otherwise
                // reopen the socket for a signed-out user. Re-check after the await.
                guard !self.intentionallyClosed, self.token != nil else { return }
                if ok {
                    // refreshAccessToken sets APIClient.shared.token synchronously
                    // before returning; read it directly rather than waiting on
                    // the (async) notification observer.
                    self.token = APIClient.shared.token
                    self.sessionId = nil
                    self.lastSeq = nil
                    self.resuming = false
                    self.openSocket()
                } else {
                    self.scheduleAuthRetry()
                }
            }
        case 0: // DISPATCH
            guard let t = obj["t"] as? String else { return }
            // READY (fresh identify) or RESUMED (replay caught us up) both mean
            // the connection is live; reset backoff, clear the resuming flag, and
            // capture the session id so the NEXT reconnect can attempt a resume.
            if t == "READY" || t == "RESUMED" {
                status = .ready
                backoffMs = 1_000
                authBackoffMs = 30_000
                resuming = false
                // A live session means the token worked — re-arm the one-shot
                // IDENTIFY-refresh recovery for any future expiry.
                identifyRefreshAttempted = false
                if let d = obj["d"] as? [String: Any], let sid = d["session_id"] as? String {
                    sessionId = sid
                }
            }
            // RESUMED signals "you're caught up": the missed events normally
            // arrive ahead of it as their own DISPATCH frames. We still FORWARD
            // it (as a distinct `t`, so it never hits the READY full-resync —
            // that stays keyed on "READY") so AppStore can defensively reconcile
            // the OPEN conversation: a resume replay that's incomplete at the
            // edge would otherwise leave the visible chat missing a message
            // until the user backs out and re-enters. The reconcile is a cheap
            // `after`-cursor fetch (usually a no-op), NOT the heavy re-bootstrap.
            let payload = obj["d"]
            // The isValidJSONObject pre-check is NOT redundant, despite looking
            // like it. `data(withJSONObject:)` does not *throw* on an invalid
            // top-level type — it raises NSInvalidArgumentException, an ObjC
            // exception that `try?` cannot catch, which aborts the process. And
            // a JSON `null` reaches here as a non-nil `NSNull()`, sailing right
            // through `if let payload`. One malformed frame would kill the app.
            if let payload, JSONSerialization.isValidJSONObject(payload),
               let dData = try? JSONSerialization.data(withJSONObject: payload) {
                onEvent?(t, dData)
            } else {
                onEvent?(t, Data("null".utf8))
            }
        default:
            break
        }
    }

    // MARK: Send

    private func sendIdentify() {
        guard let token else { return }
        resuming = false
        status = .identifying
        let frame: [String: Any] = [
            "op": 2,
            "d": [
                "token": token,
                "properties": ["os": "iOS", "browser": "Zekktris-iOS", "device": "ios"],
            ],
        ]
        send(frame)
    }

    /// We can RESUME only when a prior connection handed us a session id and we
    /// recorded at least one seq to replay from.
    private func canResume() -> Bool {
        sessionId != nil && lastSeq != nil
    }

    private func sendResume() {
        guard let token, let sid = sessionId, let seq = lastSeq else {
            // Missing any piece → nothing to resume from; IDENTIFY fresh.
            sendIdentify()
            return
        }
        resuming = true
        status = .identifying
        send(["op": 4, "d": ["token": token, "session_id": sid, "seq": seq]])
    }

    private func sendHeartbeat() {
        var d: [String: Any] = [:]
        d["seq"] = lastSeq ?? NSNull()
        send(["op": 1, "d": d])
        armAckWatchdog()
    }

    /// After each heartbeat, expect a HEARTBEAT_ACK within the timeout. If none
    /// arrives the connection is a zombie (no close event will fire), so tear
    /// it down and reconnect through the normal backoff path.
    private func armAckWatchdog() {
        ackWatchdogTask?.cancel()
        let timeoutNs = UInt64(heartbeatAckTimeoutMs) * 1_000_000
        ackWatchdogTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: timeoutNs)
            guard let self, !Task.isCancelled, !self.intentionallyClosed else { return }
            self.heartbeatTask?.cancel(); self.heartbeatTask = nil
            let dead = self.task
            self.task = nil
            dead?.cancel(with: .abnormalClosure, reason: nil)
            self.scheduleReconnect()
        }
    }

    private func send(_ frame: [String: Any]) {
        guard let task,
              let data = try? JSONSerialization.data(withJSONObject: frame),
              let text = String(data: data, encoding: .utf8)
        else { return }
        task.send(.string(text)) { _ in /* errors surface via receive() */ }
    }

    // MARK: Heartbeat / reconnect

    private func startHeartbeat(intervalMs: Int) {
        heartbeatTask?.cancel()
        let intervalNs = UInt64(max(1_000, intervalMs)) * 1_000_000
        heartbeatTask = Task { [weak self] in
            // Random initial offset so reconnect storms don't synchronize.
            try? await Task.sleep(nanoseconds: UInt64.random(in: 0...intervalNs))
            while !Task.isCancelled {
                self?.sendHeartbeat()
                try? await Task.sleep(nanoseconds: intervalNs)
            }
        }
    }

    private func handleClose() {
        heartbeatTask?.cancel(); heartbeatTask = nil
        ackWatchdogTask?.cancel(); ackWatchdogTask = nil
        task = nil
        if intentionallyClosed {
            status = .closed
            return
        }
        scheduleReconnect()
    }

    /// IDENTIFY was rejected and a token refresh didn't rescue it.
    ///
    /// This must NOT latch the socket closed. `APIClient.refreshAccessToken()`
    /// returns `false` indistinguishably for a dropped packet, a 5xx, a decode
    /// failure, and a real revoke — so treating it as "genuine revoke/ban" meant
    /// a single network blip during a token refresh killed realtime for the rest
    /// of the foreground session. `handleClose`, `scheduleReconnect` and the ack
    /// watchdog all bail on `intentionallyClosed`, and only a foreground
    /// transition or a push tap calls `forceReconnect()` — so a user sitting in
    /// an open DM never recovered: REST sends kept working off the refresh
    /// cookie while nothing inbound ever arrived. (`ba6ce6c` fixed only the
    /// foreground half of this; this fixes the sitting-still half.)
    ///
    /// Instead: retry on a slow, escalating backoff (30s → 5min). A genuine
    /// revoke costs one cheap request per interval until a REST 401 signs the
    /// user out; a transient blip heals on its own within 30s.
    /// `intentionallyClosed` is now reserved for `disconnect()` (real sign-out),
    /// which cancels `reconnectTask` and so cancels this retry too.
    private func scheduleAuthRetry() {
        heartbeatTask?.cancel(); heartbeatTask = nil
        ackWatchdogTask?.cancel(); ackWatchdogTask = nil
        reconnectTask?.cancel()
        // Tear the rejected socket down OURSELVES. The server sends
        // INVALID_SESSION and then immediately closes; if we left `task` alive,
        // that close would surface in receive() as a .failure, pass the
        // `self.task === task` identity check, and run handleClose() →
        // scheduleReconnect() — which cancels the auth retry we're about to arm
        // and replaces this slow ladder with the 1s→30s TRANSPORT backoff. The
        // result would be a connect+IDENTIFY hammer every ≤30s against a revoked
        // token: exactly the hot loop this function exists to prevent. Nil'ing
        // `task` first makes receive()'s identity check reject the close.
        let dead = task
        task = nil
        dead?.cancel(with: .goingAway, reason: nil)
        status = .reconnecting
        let delayMs = min(maxAuthBackoffMs, authBackoffMs) + Int.random(in: 0...1_000)
        authBackoffMs = min(maxAuthBackoffMs, authBackoffMs * 2)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            guard let self, !Task.isCancelled, !self.intentionallyClosed else { return }
            // Re-arm the one-shot refresh so the next IDENTIFY can try again.
            self.identifyRefreshAttempted = false
            self.sessionId = nil
            self.lastSeq = nil
            self.resuming = false
            self.openSocket()
        }
    }

    private func scheduleReconnect() {
        guard !reconnectScheduled, !intentionallyClosed else { return }
        reconnectScheduled = true
        status = .reconnecting
        reconnectTask?.cancel()
        // Current delay (capped) + jitter; then advance the backoff for next time.
        let delayMs = min(maxBackoffMs, backoffMs) + Int.random(in: 0...500)
        backoffMs = min(maxBackoffMs, backoffMs * 2)
        reconnectTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            // `!Task.isCancelled` is REQUIRED, not belt-and-braces: `try?`
            // swallows the CancellationError that `Task.sleep` throws when this
            // task is cancelled, so without it a CANCELLED reconnect still falls
            // through and opens a socket. `forceReconnect()` and
            // `scheduleAuthRetry()` both cancel this task and then open/schedule
            // their own — cancellation must actually abort. (The ack watchdog and
            // the auth retry already guard this way.)
            guard let self, !Task.isCancelled, !self.intentionallyClosed else { return }
            self.openSocket()
        }
    }
}
