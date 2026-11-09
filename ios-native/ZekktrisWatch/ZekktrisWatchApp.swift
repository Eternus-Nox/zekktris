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
        // The phone pushed a context while this app wasn't running: take it
        // now, so the tokens, DM list and keys the Siri extensions and the
        // complications read are current without anyone opening the app.
        .backgroundTask(.watchConnectivity) {
            await sync.applyReceivedContext()
        }
    }

    /// Siri authorisation is PER DEVICE: granting it on the iPhone does not
    /// authorise the watch, and until the watch itself is authorised Siri on
    /// the wrist answers "you don't have an app for that" — it never reaches
    /// ZekktrisWatchIntents. Asking here is the only way to get the prompt on
    /// the watch; requires NSSiriUsageDescription in the watch app's Info.plist
    /// (without it this call traps).
    private func requestSiriAuthorizationIfNeeded() {
        guard INPreferences.siriAuthorizationStatus() == .notDetermined else { return }
        INPreferences.requestSiriAuthorization { _ in }
    }
}
