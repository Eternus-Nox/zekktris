import Foundation
import WatchConnectivity

/// JSON shape sent to the watch — mirror of the watch's `PokeTarget`.
private struct WatchPokeTarget: Codable {
    let id: String   // DM channel id
    let name: String
}

/// Pushes the auth token + API base URL + recent DM targets to the paired
/// Apple Watch over WatchConnectivity, so the "Zekktris" watch app can message
/// or nudge a DM peer without the phone in the loop. Uses `updateApplicationContext`
/// (latest-wins, persisted + redelivered by the system on watch launch), so
/// the watch holds the token only in memory.
@MainActor
final class WatchSync: NSObject {
    static let shared = WatchSync()
    private var started = false

    /// Activate the WCSession once (no-op if the device has no watch support).
    func start() {
        guard WCSession.isSupported(), !started else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        started = true
    }

    /// Sync the current token + poke targets to the watch. Cheap + coalesced —
    /// safe to call on login, foreground, DM-list changes, and token refresh.
    func sync(token: String?, targets: [(id: String, name: String)]) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated else { return }
        var ctx: [String: Any] = [
            "token": token ?? "",
            "apiBaseURL": Config.apiBaseURL,
        ]
        if let data = try? JSONEncoder().encode(targets.map { WatchPokeTarget(id: $0.id, name: $0.name) }) {
            ctx["targets"] = data
        }
        try? session.updateApplicationContext(ctx)
    }

    /// Relay an incoming poke to the watch so it can flash the emoji full-screen
    /// + buzz — ONLY while the watch app is reachable (foreground). When it
    /// isn't, the mirrored push notification taps the wrist instead, so we skip.
    /// `name` captions the flash ("from Alice"); a few bytes, so we never ship
    /// an image — the watch renders the emoji natively at full size.
    func sendPoke(emoji: String, name: String) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(["kind": "poke", "emoji": emoji, "name": name], replyHandler: nil, errorHandler: nil)
    }

    /// Relay the FACT that a DM message arrived to the watch so it buzzes
    /// (2–3 taps) — ONLY while the watch app is reachable (foreground). When it
    /// isn't, the mirrored push notification taps the wrist instead, so we skip.
    /// No content is shipped (privacy); the watch's Messages view fetches on
    /// demand.
    func sendIncomingMessage() {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        guard session.activationState == .activated, session.isReachable else { return }
        session.sendMessage(["kind": "message"], replyHandler: nil, errorHandler: nil)
    }
}

extension WatchSync: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {}
    // iOS-only delegate methods (required to compile on iOS). On a watch swap,
    // re-activate so the new watch resumes receiving context.
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }
}
