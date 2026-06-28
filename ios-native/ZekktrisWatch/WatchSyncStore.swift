import Foundation
import WatchConnectivity
import WatchKit

/// A DM peer the watch can poke: the DM channel id + a display name.
struct PokeTarget: Identifiable, Codable, Hashable {
    let id: String   // DM channel id
    let name: String
}

/// A transient incoming-poke flash — the full-screen emoji shown on top,
/// optionally captioned with who sent it.
struct PokeFlash: Identifiable, Equatable {
    let id = UUID()
    let emoji: String
    var name: String? = nil
}

/// Receives the auth token + API base URL + poke targets from the paired
/// iPhone over WatchConnectivity. We rely on `applicationContext` (the system
/// persists the LATEST one and redelivers it on activation), so the token is
/// held only IN MEMORY here — never written to the watch's own storage.
@MainActor
final class WatchSyncStore: NSObject, ObservableObject {
    @Published var token: String?
    @Published var apiBaseURL: String?
    @Published var targets: [PokeTarget] = []
    /// Set when the phone relays an incoming poke (only while the watch app is
    /// reachable). Drives the on-top emoji flash + the haptic wave.
    @Published var incomingPoke: PokeFlash?

    override init() {
        super.init()
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
