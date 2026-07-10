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
        }
    }
}
