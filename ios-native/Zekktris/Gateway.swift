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
    private var token: String?
    private var tokenObserver: NSObjectProtocol?
    private var intentionallyClosed = false
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
            sendIdentify()
        case 8: // HEARTBEAT_ACK — socket is alive; disarm the zombie watchdog.
            ackWatchdogTask?.cancel(); ackWatchdogTask = nil
        case 6: // INVALID_SESSION
            intentionallyClosed = true
            status = .closed
            heartbeatTask?.cancel(); heartbeatTask = nil
            ackWatchdogTask?.cancel(); ackWatchdogTask = nil
        case 0: // DISPATCH
            guard let t = obj["t"] as? String else { return }
            if t == "READY" { status = .ready; backoffMs = 1_000 }
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
