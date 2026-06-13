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
    /// if we never connected or were intentionally closed.
    func forceReconnect() {
        guard token != nil, !intentionallyClosed else { return }
        reconnectTask?.cancel(); reconnectTask = nil
        ackWatchdogTask?.cancel(); ackWatchdogTask = nil
        heartbeatTask?.cancel(); heartbeatTask = nil
        backoffMs = 1_000
        // Drop the old socket (possibly a zombie). Its pending receive will
        // fail, but the identity check in receive() ignores non-current tasks.
        let dead = task
        task = nil
        dead?.cancel(with: .goingAway, reason: nil)
        openSocket()
    }

    private func openSocket() {
        guard token != nil else { return }
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
            // here. Previously this latched closed permanently — realtime stayed
            // dead (no messages/presence) until app relaunch while REST kept
            // working off the cookie. Attempt ONE token refresh and reconnect;
            // only latch closed if the refresh itself fails (genuine
            // revoke/ban/logout — the refresh cookie is dead too).
            heartbeatTask?.cancel(); heartbeatTask = nil
            ackWatchdogTask?.cancel(); ackWatchdogTask = nil
            if identifyRefreshAttempted {
                intentionallyClosed = true
                status = .closed
                return
            }
            identifyRefreshAttempted = true
            status = .connecting
            Task { @MainActor in
                if await APIClient.shared.refreshAccessToken() {
                    // refreshAccessToken sets APIClient.shared.token synchronously
                    // before returning; read it directly rather than waiting on
                    // the (async) notification observer.
                    self.token = APIClient.shared.token
                    self.sessionId = nil
                    self.lastSeq = nil
                    self.resuming = false
                    self.openSocket()
                } else {
                    self.intentionallyClosed = true
                    self.status = .closed
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
                resuming = false
                // A live session means the token worked — re-arm the one-shot
                // IDENTIFY-refresh recovery for any future expiry.
                identifyRefreshAttempted = false
                if let d = obj["d"] as? [String: Any], let sid = d["session_id"] as? String {
                    sessionId = sid
                }
            }
            // RESUMED only signals "you're caught up"; the missed events already
            // arrived ahead of it as their own DISPATCH frames and were applied
            // by the normal handlers. Do NOT forward RESUMED — that keeps the
            // READY full-resync (loadGuilds/loadDMs/… in AppStore) from firing on
            // a successful resume, which is the whole point of resuming.
            if t == "RESUMED" { return }
            let payload = obj["d"]
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
            guard let self, !self.intentionallyClosed else { return }
            self.openSocket()
        }
    }
}
