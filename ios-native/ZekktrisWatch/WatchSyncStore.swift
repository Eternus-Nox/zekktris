import Foundation
import WatchConnectivity

/// A DM peer the watch can poke: the DM channel id + a display name.
struct PokeTarget: Identifiable, Codable, Hashable {
    let id: String   // DM channel id
    let name: String
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
}
