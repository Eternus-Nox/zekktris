import Foundation
import WatchConnectivity
import WatchKit
import WidgetKit

/// A DM peer the watch can poke or message: the DM channel id + display name,
/// plus (for E2EE DMs) the base64 of the 32-byte channel key relayed from the
/// phone so the watch can encrypt outgoing / decrypt incoming text itself.
struct PokeTarget: Identifiable, Codable, Hashable {
    let id: String   // DM channel id
    let name: String
    /// Current DM streak (consecutive days you've both messaged). 0 = none, so
    /// the wrist can show what level you're at — and what you'd break.
    var streak: Int = 0
    /// Whether this DM is end-to-end encrypted. Separate from the key so the
    /// watch can REFUSE to send plaintext to an E2EE DM whose key the phone
    /// couldn't relay (locked / no key), instead of silently leaking.
    var e2ee: Bool = false
    /// base64 of the 32-byte AES key for an E2EE DM; nil if the phone didn't
    /// have the key to relay.
    var e2eeKeyBase64: String? = nil

    /// The peer's @username and the name on their linked Contacts card —
    /// what Siri matches a spoken name against. Nil from an older phone build.
    var username: String? = nil
    var contactName: String? = nil

    /// Decoded 32-byte key, or nil if absent/bad.
    var e2eeKey: Data? {
        guard let b64 = e2eeKeyBase64, let d = Data(base64Encoded: b64), d.count == 32 else { return nil }
        return d
    }
}

/// A transient incoming-poke flash — the full-screen emoji shown on top,
/// optionally captioned with who sent it.
struct PokeFlash: Identifiable, Equatable {
    let id = UUID()
    let emoji: String
    var name: String? = nil
}

/// Receives the auth token + API base URL + poke targets from the paired
/// iPhone over WatchConnectivity. `applicationContext` is persisted by the
/// system (the LATEST one is redelivered on activation), and `publishToWidget`
/// writes the token and the per-DM E2EE keys to the watch's app-group keychain
/// (after-first-unlock) so the complications and Siri extensions can use them.
/// So the credentials live on the watch's storage, not only in memory.
@MainActor
final class WatchSyncStore: NSObject, ObservableObject {
    @Published var token: String?
    @Published var apiBaseURL: String?
    @Published var targets: [PokeTarget] = []
    /// Set when the phone relays an incoming poke (only while the watch app is
    /// reachable). Drives the on-top emoji flash + the haptic wave.
    @Published var incomingPoke: PokeFlash?
    /// Set from a widget/complication deep link (zekktris://friend/<id>) so the
    /// root view can navigate to that friend. Cleared once consumed.
    @Published var pendingFriendId: String?

    override init() {
        super.init()
        // SEED FROM THE APP GROUP FIRST. WCSession.activate() is asynchronous
        // and applicationContext is only redelivered once activation finishes,
        // so a cold-launched watch app starts with no token at all — which is
        // why the FIRST send after opening the app failed and the next one
        // worked. Worse, with the phone unreachable (out of range, or its app
        // not running) the context may never arrive and the send fails outright.
        //
        // The token is already persisted in the app-group keychain for the
        // widget's one-tap poke; the app simply was not reading it back. So the
        // last known credentials are available immediately, and the WC sync
        // below refreshes them rather than being the only source.
        // CREDENTIALS ONLY. Deliberately NOT the targets: WatchWidgetDM carries
        // no e2ee flag, and PokeTarget.e2ee defaults to false — seeding from it
        // would mark every encrypted DM as plaintext and let the watch send
        // unencrypted into an E2EE channel, which is the exact leak that flag
        // exists to prevent. Targets stay authoritative from the phone.
        token = WatchWidgetBridge.token()
        apiBaseURL = WatchWidgetBridge.baseURL()

        guard WCSession.isSupported() else { return }
        WCSession.default.delegate = self
        WCSession.default.activate()
    }

    private func apply(_ ctx: [String: Any]) {
        if let t = ctx["token"] as? String { token = t.isEmpty ? nil : t }
        if let u = ctx["apiBaseURL"] as? String, !u.isEmpty { apiBaseURL = u }
        if let data = ctx["targets"] as? Data,
           let list = try? JSONDecoder().decode([PokeTarget].self, from: data) {
            targets = list
        }
        publishToWidget()
    }

    /// Mirror the latest token + API base URL + DM list to the watch App Group
    /// so the widget/complication can poke + open DMs without the app running,
    /// then reload its timelines. The token lands in the app-group keychain
    /// (encrypted) — the price of one-tap-from-the-face.
    private func publishToWidget() {
        let dms = targets.map {
            WatchWidgetDM(
                id: $0.id, name: $0.name, streak: $0.streak,
                e2ee: $0.e2ee, username: $0.username, contactName: $0.contactName,
            )
        }
        WatchWidgetBridge.publish(dms: dms, baseURL: apiBaseURL, token: token)
        // The Siri extension is its own process and can't read this app's
        // memory, so the per-DM keys it needs to encrypt go to the app-group
        // keychain — the same arrangement the phone uses for its notification
        // extension. Keys for DMs no longer in the list are removed.
        WatchWidgetBridge.publishKeys(
            Dictionary(uniqueKeysWithValues: targets.compactMap { t in
                t.e2eeKeyBase64.map { (t.id, $0) }
            })
        )
        WidgetCenter.shared.reloadAllTimelines()
        // The Siri phrases and the person list they match against live in the
        // ZekktrisWatchAppIntents extension, which reads this same App Group —
        // so publishing here is all the app has to do. (The app cannot refresh
        // Siri's name index directly: the provider type is the extension's.)
    }

    /// Handle a `zekktris://friend/<id>` (or `/dm/<id>`) deep link from a
    /// widget/complication — stash the id for the root view to navigate to.
    func handleURL(_ url: URL) {
        guard url.scheme == "zekktris" else { return }
        let id = url.pathComponents.first(where: { $0 != "/" }) ?? ""
        if !id.isEmpty { pendingFriendId = id }
    }

    /// Actively PULL the freshest token + targets from the phone right before we
    /// act, so the watch never sends / pokes / loads on a stale or missing
    /// token. Sends a `refresh` message with a reply handler (which wakes the
    /// phone app in the background) and applies the reply. Best-effort: a no-op
    /// when the phone is unreachable (we keep whatever the last push gave us),
    /// and bounded by `timeout` so a wedged phone never hangs a wrist action.
    func requestFreshSync(timeout: TimeInterval = 4) async {
        guard WCSession.isSupported() else { return }
        let session = WCSession.default
        // Activation is ASYNCHRONOUS. Returning here because it has not finished
        // yet is the other half of the first-send failure: the pull was skipped,
        // so nothing refreshed the token before the request went out. Wait for
        // it, bounded — the caller already tolerates up to `timeout`.
        var waited: TimeInterval = 0
        while session.activationState != .activated, waited < 2 {
            try? await Task.sleep(nanoseconds: 100_000_000)
            waited += 0.1
        }
        // Still not reachable (phone asleep or out of range) is fine now: the
        // seeded credentials from the app group carry the send on their own.
        guard session.activationState == .activated, session.isReachable else { return }
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            var finished = false
            // All three completion paths run on the main thread (the reply /
            // error handlers hop to MainActor, the timeout is on the main queue),
            // so this flag needs no further synchronization.
            func finish() {
                if finished { return }
                finished = true
                cont.resume()
            }
            session.sendMessage(
                ["kind": "refresh"],
                replyHandler: { reply in Task { @MainActor in self.apply(reply); finish() } },
                errorHandler: { _ in Task { @MainActor in finish() } }
            )
            DispatchQueue.main.asyncAfter(deadline: .now() + timeout) { finish() }
        }
    }

    /// Pull a fresh token from the phone, then hand back the current
    /// (token, base) — or nil if we still have none (phone never synced and is
    /// unreachable). The one call a wrist action awaits before hitting the API.
    func credentials() async -> (token: String, base: String)? {
        await requestFreshSync()
        guard let t = token, let b = apiBaseURL else { return nil }
        return (t, b)
    }

    /// Flash the full-screen emoji on top + play a three-beat haptic wave when
    /// the phone relays a poke. Auto-clears after the takeover has registered.
    private func flashIncomingPoke(_ emoji: String, from name: String?) {
        let flash = PokeFlash(emoji: emoji, name: name)
        incomingPoke = flash
        // ~1 second of haptic for a poke — longer + stronger than a message so
        // the two are distinguishable on the wrist.
        playHapticWave(count: 6, interval: 0.16)
        Task {
            try? await Task.sleep(nanoseconds: 2_200_000_000)
            if incomingPoke?.id == flash.id { incomingPoke = nil }
        }
    }

    /// 2–3 quick taps when the phone relays an incoming DM message.
    private func buzzIncomingMessage() {
        playHapticWave(count: 3, interval: 0.18)
    }

    /// Play `count` notification haptics spaced `interval` seconds apart.
    /// watchOS haptics are fixed short pulses, so a sustained buzz is several
    /// in a row.
    private func playHapticWave(count: Int, interval: Double) {
        let device = WKInterfaceDevice.current()
        for i in 0..<count {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * interval) {
                device.play(.notification)
            }
        }
    }
}

extension WatchSyncStore: WCSessionDelegate {
    nonisolated func session(
        _ session: WCSession,
        activationDidCompleteWith activationState: WCSessionActivationState,
        error: Error?
    ) {
        // Grab whatever the phone last synced (delivered even if the watch was
        // just launched).
        let ctx = session.receivedApplicationContext
        Task { @MainActor in self.apply(ctx) }
    }

    nonisolated func session(
        _ session: WCSession,
        didReceiveApplicationContext applicationContext: [String: Any]
    ) {
        Task { @MainActor in self.apply(applicationContext) }
    }

    // Live poke relay from the phone (sent only while the watch app is
    // reachable). Triggers the on-top flash + haptic wave.
    nonisolated func session(_ session: WCSession, didReceiveMessage message: [String: Any]) {
        switch message["kind"] as? String {
        case "poke":
            let emoji = message["emoji"] as? String ?? "👉"
            let name = message["name"] as? String
            Task { @MainActor in self.flashIncomingPoke(emoji, from: name) }
        case "message":
            // Incoming DM relayed from the phone — buzz the wrist (2–3 taps).
            Task { @MainActor in self.buzzIncomingMessage() }
        default:
            return
        }
    }
}
