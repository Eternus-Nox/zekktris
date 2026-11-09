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
    /// for) so the watch can encrypt/decrypt on its own. Stored on the watch
    /// like the auth token: the system persists the applicationContext it rides
    /// in, and the watch app writes each key to its app-group keychain
    /// (WatchWidgetBridge.publishKeys) so the Siri extensions can encrypt.
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

/// One entry of the watch's Siri directory (context key "siriDirectory"):
/// EVERY 1:1 DM, not only the 12 poke targets, so Siri on the wrist can reach
/// anyone the phone can. Never a key: keys ride only with the targets, and a
/// directory DM that is encrypted and has none still refuses to send.
struct WatchDirectoryEntry: Codable {
    let channelId: String
    let userId: String
    let name: String
    let username: String
    var contactName: String?
    let e2ee: Bool
}

/// Everything the phone hands the watch. Built by the app (AppStore
/// .watchSnapshot) for both the push and the pull, so they never differ.
struct WatchSnapshot {
    /// The 15-minute access token: the watch app's own sends refresh it by
    /// pulling, and it is the fallback for a server without intent tokens.
    var token: String?
    /// The long-lived token the watch's Siri extensions and complication send
    /// as `Authorization: Intent`, and when it expires (ISO-8601). nil when
    /// the server predates them.
    var intentToken: String?
    var intentTokenExpiresAt: String?
    var targets: [WatchTargetTuple]
    var directory: [WatchDirectoryEntry]

    /// What a sign-out sends: every credential and list emptied.
    static var signedOut: WatchSnapshot {
        WatchSnapshot(token: nil, intentToken: nil, intentTokenExpiresAt: nil, targets: [], directory: [])
    }
}

/// Pushes the auth token + API base URL + recent DM targets to the paired
/// Apple Watch over WatchConnectivity, so the "Zekktris" watch app can message
/// or nudge a DM peer without the phone in the loop. Alongside them: the
/// intent token (the credential the watch's Siri extensions and complication
/// can keep using once the access token has expired) and the Siri directory
/// of every 1:1 DM.
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
/// The token is NOT memory-only on the watch: applicationContext is persisted
/// by the system, and the watch app stores the token (and the per-DM E2EE keys)
/// in its app-group keychain so the complications and Siri extensions can act
/// without the app running. See WatchWidgetBridge on the watch side.
@MainActor
final class WatchSync: NSObject {
    static let shared = WatchSync()
    private var started = false

    /// Rebuilds the CURRENT token + poke targets on demand. Set by the app so a
    /// watch "refresh" pull always answers with live values (not a stale cache),
    /// even if the phone hasn't pushed a context in a while or its token rotated
    /// since the last push. The single source of truth for the pull path.
    var snapshotProvider: (@MainActor () -> WatchSnapshot)?

    /// The last context we built — the fallback reply if no provider is wired,
    /// and what is resent once activation completes.
    private var lastContext: [String: Any] = [:]

    /// Ceiling on the encoded directory. The context also answers the watch's
    /// "refresh" pull, as a message reply, and those are capped at about 64 KB;
    /// past that the reply fails outright and the watch loses its token too.
    /// At about 150 bytes an entry this is some 200 DMs, newest first.
    private static let directoryByteBudget = 30_000

    /// Activate the WCSession once (no-op if the device has no watch support).
    func start() {
        guard WCSession.isSupported(), !started else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
        started = true
    }

    /// Build the WatchConnectivity payload — shared by the proactive push
    /// (`sync`) and the on-demand pull (refresh reply) so both are identical.
    private func buildContext(_ snapshot: WatchSnapshot) -> [String: Any] {
        var ctx: [String: Any] = [
            "token": snapshot.token ?? "",
            "apiBaseURL": Config.apiBaseURL,
            // Always present, "" when there is none, so a sign-out or an older
            // server clears the watch's copy rather than leaving it in place.
            "intentToken": snapshot.intentToken ?? "",
            "intentTokenExpiresAt": snapshot.intentTokenExpiresAt ?? "",
        ]
        if let data = try? JSONEncoder().encode(
            snapshot.targets.map {
                WatchPokeTarget(
                    id: $0.id, name: $0.name, streak: $0.streak, e2ee: $0.e2ee,
                    e2eeKeyBase64: $0.e2eeKeyBase64,
                    username: $0.username, contactName: $0.contactName,
                )
            }
        ) {
            ctx["targets"] = data
        }
        if let data = Self.encodeDirectory(snapshot.directory) {
            ctx["siriDirectory"] = data
        }
        return ctx
    }

    /// The directory as JSON, trimmed from the oldest end until it fits the
    /// budget (see `directoryByteBudget`).
    private static func encodeDirectory(_ entries: [WatchDirectoryEntry]) -> Data? {
        var list = entries
        var data = try? JSONEncoder().encode(list)
        while let encoded = data, encoded.count > directoryByteBudget, !list.isEmpty {
            list.removeLast(max(1, list.count / 10))
            data = try? JSONEncoder().encode(list)
        }
        return data
    }

    /// Sync the current tokens + poke targets + Siri directory to the watch.
    /// Cheap + coalesced — safe to call on login, foreground, DM-list changes,
    /// and token refresh.
    func sync(_ snapshot: WatchSnapshot) {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        let ctx = buildContext(snapshot)
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
                ctx = self.buildContext(snap)
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

    // A sync() made before activation finished was only remembered (it can't
    // be sent until then), so send it now. Without this, a sign-in on a cold
    // launch could leave the watch on the previous context until the next
    // foreground or DM load.
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        guard activationState == .activated else { return }
        Task { @MainActor in
            guard !self.lastContext.isEmpty else { return }
            try? WCSession.default.updateApplicationContext(self.lastContext)
        }
    }
    // iOS-only delegate methods (required to compile on iOS). On a watch swap,
    // re-activate so the new watch resumes receiving context.
    nonisolated func sessionDidBecomeInactive(_ session: WCSession) {}
    nonisolated func sessionDidDeactivate(_ session: WCSession) {
        WCSession.default.activate()
    }
}
