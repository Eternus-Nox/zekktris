import Intents
import SwiftUI

/// The "Zekktris" watchOS companion — a standalone app for quickly messaging or
/// nudging a recent DM peer. It is intentionally tiny: the iPhone app pushes the
/// auth token, the API base URL, and the list of DM peers over WatchConnectivity;
/// the watch picks a person, then either sends a dictated message or a poke.
@main
struct ZekktrisWatchApp: App {
    @StateObject private var sync = WatchSyncStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(sync)
                .onOpenURL { sync.handleURL($0) }
                .task { requestSiriAuthorizationIfNeeded() }
        }
    }

    /// Siri authorisation is per device and a SiriKit concept. The watch's
    /// Siri send now runs through App Intents (ZekktrisWatchAppIntents), which
    /// does not need it; this stays because it is harmless and the watch's
    /// signing already carries the Siri entitlement. Requires
    /// NSSiriUsageDescription in the watch app's Info.plist (traps without it).
    private func requestSiriAuthorizationIfNeeded() {
        guard INPreferences.siriAuthorizationStatus() == .notDetermined else { return }
        INPreferences.requestSiriAuthorization { _ in }
    }
}
