import Foundation
import WatchConnectivity

/// JSON shape sent to the watch — mirror of the watch's `PokeTarget`.
private struct WatchPokeTarget: Codable {
    let id: String   // DM channel id
    let name: String
    /// Current DM streak (days) so the watch can show what level you're at.
    var streak: Int
    /// Whether this DM is E2EE — so the watch refuses to send plaintext to it
    /// even when we couldn't relay a key.
    var e2ee: Bool
    /// base64 of the 32-byte E2EE channel key (only for E2EE DMs we hold a key
    /// for) so the watch can encrypt/decrypt on its own. Held in memory on the
    /// watch like the auth token (relayed via applicationContext).
    var e2eeKeyBase64: String?
    /// The peer's @username and the name on their linked Contacts card, so Siri
    /// on the WATCH can match a spoken name exactly the way the phone does.
    /// Optional, so an older watch build simply ignores them.
    var username: String?
    var contactName: String?
}

/// One DM target as the phone hands it to the sync.
typealias WatchTargetTuple = (
    id: String, name: String, streak: Int, e2ee: Bool, e2eeKeyBase64: String?,
    username: String?, contactName: String?
)

/// Pushes the auth token + API base URL + recent DM targets to the paired
/// Apple Watch over WatchConnectivity, so the "Zekktris" watch app can message
/// or nudge a DM peer without the phone in the loop.
///
/// Two delivery paths, both required for reliability:
///   • PUSH  — `updateApplicationContext` (latest-wins, persisted + redelivered
///     on watch launch). Best-effort; may be minutes stale if the phone hasn't
///     foregrounded or the token rotated since.
///   • PULL  — the watch sends a `{"kind":"refresh"}` message with a reply
///     handler right before it acts; we answer with LIVE values from
///     `snapshotProvider`. This wakes the phone app in the background, so the
///     watch never sends/pokes on a stale or missing token when the phone is
///     reachable. This is what fixes the "watch won't send / can't load" misses.
///
/// The token is held only in memory on the watch.
@MainActor
final class WatchSync: NSObject {
    static let shared = WatchSync()
    private var started = false

    /// Rebuilds the CURRENT token + poke targets on demand. Set by the app so a
    /// watch "refresh" pull always answers with live values (not a stale cache),
    /// even if the phone hasn't pushed a context in a while or its token rotated
    /// since the last push. The single source of truth for the pull path.
    var snapshotProvider: (@MainActor () -> (token: String?, targets: [WatchTargetTuple]))?

    /// The last context we built — the fallback reply if no provider is wired.
    private var lastContext: [String: Any] = [:]

    /// Activate the WCSession once (no-op if the device has no watch support).
    func start() {
        guard WCSession.isSupported(), !started else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        started = true
    }

    /// Build the WatchConnectivity payload — shared by the proactive push
    /// (`sync`) and the on-demand pull (refresh reply) so both are identical.
    private func buildContext(token: String?, targets: [WatchTargetTuple]) -> [String: Any] {
        var ctx: [String: Any] = [
            "token": token ?? "",
            "apiBaseURL": Config.apiBaseURL,
        ]
        if let data = try? JSONEncoder().encode(
            targets.map {
                WatchPokeTarget(
                    id: $0.id, name: $0.name, streak: $0.streak, e2ee: $0.e2ee,
                    e2eeKeyBase64: $0.e2eeKeyBase64,
                    username: $0.username, contactName: $0.contactName,
                )
            }
        ) {
            ctx["targets"] = data
        }
        return ctx
    }

    /// Sync the current token + poke targets to the watch. Cheap + coalesced —
    /// safe to call on login, foreground, DM-list changes, and token refresh.
    func sync(token: String?, targets: [WatchTargetTuple]) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        let ctx = buildContext(token: token, targets: targets)
        lastContext = ctx
        guard session.activationState == .activated else { return }
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
    // PULL: the watch asks for the freshest token + targets right before it
    // sends / pokes / loads. We answer from the live snapshot provider (falling
    // back to the last pushed context), and opportunistically re-push it so the
    // next cold watch launch starts fresh too. The system wakes this app in the
    // background to service the reply, so it works with the phone app closed.
    nonisolated func session(
        _ session: WCSession,
        didReceiveMessage message: [String: Any],
        replyHandler: @escaping ([String: Any]) -> Void
    ) {
        guard (message["kind"] as? String) == "refresh" else {
            replyHandler([:])
            return
        }
        Task { @MainActor in
            let ctx: [String: Any]
            if let snap = self.snapshotProvider?() {
                ctx = self.buildContext(token: snap.token, targets: snap.targets)
                self.lastContext = ctx
                let s = WCSession.default
                if s.activationState == .activated {
                    try? s.updateApplicationContext(ctx)
                }
            } else {
                ctx = self.lastContext
            }
            replyHandler(ctx)
        }
    }

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
