import SwiftUI

/// "Zekktris Poke" — a standalone watchOS app for quickly nudging a recent DM
/// peer. It is intentionally tiny: the iPhone app pushes the auth token, the
/// API base URL, and the list of pokeable DM peers over WatchConnectivity; the
/// watch picks a person, swipes through the poke variants, and calls
/// POST /channels/:id/poke directly.
@main
struct ZekktrisWatchApp: App {
    @StateObject private var sync = WatchSyncStore()

    var body: some Scene {
        WindowGroup {
            ContentView()
                .environmentObject(sync)
        }
    }
}
