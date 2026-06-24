import SwiftUI
import WatchKit

/// Root: a list of recent DM peers to poke. Empty/locked states guide the user
/// to open the phone app (which syncs the token + targets).
struct ContentView: View {
    @EnvironmentObject private var sync: WatchSyncStore

    var body: some View {
        NavigationStack {
            Group {
                if sync.token == nil {
                    notice(
                        systemImage: "iphone.gen3.radiowaves.left.and.right",
                        text: "Open Zekktris on your iPhone to sync."
                    )
                } else if sync.targets.isEmpty {
                    notice(systemImage: "hand.point.right", text: "No recent DMs to poke yet.")
                } else {
                    List(sync.targets) { target in
                        NavigationLink(value: target) { Text(target.name).lineLimit(1) }
                    }
                }
            }
            .navigationTitle("Poke")
            .navigationDestination(for: PokeTarget.self) { PokePager(target: $0) }
        }
        // Got poked: the enlarged emoji flashes ON TOP of whatever screen
        // you're on (paired with the haptic wave in WatchSyncStore).
        .overlay {
            if let poke = sync.incomingPoke {
                ZStack {
                    Color.black.opacity(0.55).ignoresSafeArea()
                    Text(poke.emoji)
                        .font(.system(size: 90))
                        .transition(.scale(scale: 0.4).combined(with: .opacity))
                        .id(poke.id)
                }
                .allowsHitTesting(false)
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.6), value: sync.incomingPoke?.id)
    }

    private func notice(systemImage: String, text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage).font(.title3).foregroundStyle(.secondary)
            Text(text).font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
        .padding()
    }
}

/// Swipe (vertical-page / Digital Crown) through the poke variants; tap the
/// big emoji to send. A success/failure haptic confirms.
struct PokePager: View {
    @EnvironmentObject private var sync: WatchSyncStore
    let target: PokeTarget
    @State private var sending = false
    @State private var sentVariant: PokeVariant?

    var body: some View {
        TabView {
            ForEach(PokeVariant.allCases) { variant in
                Button { send(variant) } label: {
                    VStack(spacing: 8) {
                        Text(variant.emoji).font(.system(size: 60))
                        Text(sentVariant == variant ? "Sent!" : variant.label)
                            .font(.headline)
                            .foregroundStyle(sentVariant == variant ? Color.green : Color.primary)
                    }
                }
                .buttonStyle(.plain)
                .disabled(sending)
            }
        }
        .tabViewStyle(.verticalPage)
        .navigationTitle(target.name)
    }

    private func send(_ variant: PokeVariant) {
        guard !sending, let token = sync.token, let base = sync.apiBaseURL else { return }
        sending = true
        WKInterfaceDevice.current().play(.click)
        Task {
            let ok = await WatchPokeAPI.poke(
                baseURL: base, token: token, channelId: target.id, pokeType: variant.rawValue
            )
            await MainActor.run {
                sending = false
                if ok {
                    sentVariant = variant
                    WKInterfaceDevice.current().play(.success)
                } else {
                    WKInterfaceDevice.current().play(.failure)
                }
            }
            try? await Task.sleep(nanoseconds: 1_300_000_000)
            await MainActor.run { if sentVariant == variant { sentVariant = nil } }
        }
    }
}
