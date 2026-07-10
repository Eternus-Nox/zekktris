import SwiftUI
import WatchKit

/// Root: a list of recent DM peers. Tap one to message or poke them.
/// Empty/locked states guide the user to open the phone app (which syncs the
/// token + targets).
struct ContentView: View {
    @EnvironmentObject private var sync: WatchSyncStore
    @State private var path: [PokeTarget] = []

    var body: some View {
        NavigationStack(path: $path) {
            Group {
                if sync.token == nil {
                    notice(
                        systemImage: "iphone.gen3.radiowaves.left.and.right",
                        text: "Open Zekktris on your iPhone to sync."
                    )
                } else if sync.targets.isEmpty {
                    notice(systemImage: "bubble.left.and.bubble.right", text: "No recent DMs yet.")
                } else {
                    List(sync.targets) { target in
                        NavigationLink(value: target) {
                            HStack(spacing: 6) {
                                Text(target.name).lineLimit(1)
                                if target.streak > 0 {
                                    Spacer(minLength: 4)
                                    StreakChip(days: target.streak)
                                }
                            }
                        }
                    }
                }
            }
            .navigationTitle("Friends")
            .navigationDestination(for: PokeTarget.self) { FriendScreen(target: $0) }
            // Open-DM complication deep link → jump to that friend.
            .onChange(of: sync.pendingFriendId) { _, id in
                guard let id, let target = sync.targets.first(where: { $0.id == id }) else { return }
                path = [target]
                sync.pendingFriendId = nil
            }
        }
        // Got poked: a FULL-SCREEN emoji takeover on top of whatever screen
        // you're on (paired with the haptic wave in WatchSyncStore). The emoji
        // scales to the watch face via GeometryReader so it fills the screen on
        // every size (40–49mm), instead of a fixed point size. Native Text, not
        // a PNG — an emoji glyph renders razor-sharp at any size and the relay
        // payload stays a few bytes.
        .overlay {
            if let poke = sync.incomingPoke {
                GeometryReader { geo in
                    let side = min(geo.size.width, geo.size.height)
                    ZStack {
                        LinearGradient(
                            colors: [Color.black, Color(white: 0.08)],
                            startPoint: .top, endPoint: .bottom
                        )
                        .ignoresSafeArea()
                        VStack(spacing: 4) {
                            Text(poke.emoji)
                                .font(.system(size: side * 0.7))
                                .minimumScaleFactor(0.5)
                                .lineLimit(1)
                            if let name = poke.name, !name.isEmpty {
                                Text("from \(name)")
                                    .font(.caption2)
                                    .foregroundStyle(.white.opacity(0.85))
                                    .lineLimit(1)
                            }
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .ignoresSafeArea()
                .transition(.scale(scale: 0.5).combined(with: .opacity))
                .id(poke.id)
                .allowsHitTesting(false)
            }
        }
        .animation(.spring(response: 0.4, dampingFraction: 0.6), value: sync.incomingPoke?.id)
        // On open, pull the latest token + DM list from the phone (if reachable)
        // so a cold launch populates right away instead of stalling on
        // "Open Zekktris on your iPhone" until the phone next foregrounds.
        .task { await sync.requestFreshSync() }
    }

    private func notice(systemImage: String, text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: systemImage).font(.title3).foregroundStyle(.secondary)
            Text(text).font(.footnote).multilineTextAlignment(.center).foregroundStyle(.secondary)
        }
        .padding()
    }
}

/// Amber flame + day count on an amber-tinted plate — the wrist's at-a-glance
/// read on a DM streak, mirroring the in-app `StreakChip` (plasmaAmber pill with
/// a rounded border) so it looks the same everywhere.
struct StreakChip: View {
    let days: Int
    private static let amber = Color(red: 1.0, green: 0.69, blue: 0.0) // 0xFFB000
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "flame.fill").font(.system(size: 9, weight: .bold))
                .foregroundStyle(Self.amber)
            Text("\(days)").font(.system(size: 11, weight: .semibold).monospacedDigit())
                .foregroundStyle(.white)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2)
        .background(Self.amber.opacity(0.16), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(Self.amber.opacity(0.4), lineWidth: 1)
        )
    }
}

/// Tapped a friend: choose to send a real message (dictate/scribble) or a poke.
struct FriendScreen: View {
    let target: PokeTarget

    var body: some View {
        List {
            NavigationLink {
                PokePager(target: target)
            } label: {
                Label("Poke", systemImage: "hand.point.right.fill")
            }
            NavigationLink {
                MessageComposer(target: target)
            } label: {
                Label("Message", systemImage: "bubble.left.fill")
            }
            NavigationLink {
                MessagesView(target: target)
            } label: {
                Label("Messages", systemImage: "text.bubble")
            }
        }
        .navigationTitle(target.name)
    }
}

/// Dictate / scribble a text DM and send it straight from the wrist.
struct MessageComposer: View {
    @EnvironmentObject private var sync: WatchSyncStore
    @Environment(\.dismiss) private var dismiss
    let target: PokeTarget
    @State private var text = ""
    @State private var sending = false
    @State private var sent = false
    @State private var failed = false

    var body: some View {
        // Scrollable so a long dictated message can be read in full (it grows
        // and wraps) and the Send button is always reachable below it. The
        // field starts several lines tall so you can see the whole message
        // before sending it.
        ScrollView {
            VStack(spacing: 10) {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(4...20)
                    .frame(minHeight: 84, alignment: .top)
                Button { send() } label: {
                    if sending {
                        ProgressView()
                    } else {
                        Label(sent ? "Sent!" : (failed ? "Retry" : "Send"), systemImage: "paperplane.fill")
                            .frame(maxWidth: .infinity)
                    }
                }
                // Green once it lands, red if the send failed (tap to retry),
                // accent otherwise.
                .tint(sent ? .green : (failed ? .red : .accentColor))
                .disabled(sending || text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding(.horizontal)
        }
        .navigationTitle(target.name)
    }

    private func send() {
        let body = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !sending, !body.isEmpty else { return }
        sending = true
        failed = false
        WKInterfaceDevice.current().play(.click)
        Task {
            // Pull a live token from the phone first so a stale/rotated one
            // doesn't silently drop the send. One attempt only — a message POST
            // isn't idempotent, so we never auto-retry (would risk a duplicate);
            // the red "Retry" button lets the user decide.
            guard let creds = await sync.credentials() else {
                await MainActor.run {
                    sending = false
                    failed = true
                    WKInterfaceDevice.current().play(.failure)
                }
                return
            }
            let ok = await WatchPokeAPI.sendMessage(
                baseURL: creds.base, token: creds.token, channelId: target.id, content: body,
                e2ee: target.e2ee, e2eeKey: target.e2eeKey
            )
            await MainActor.run {
                sending = false
                if ok {
                    sent = true
                    text = ""
                    WKInterfaceDevice.current().play(.success)
                } else {
                    failed = true
                    WKInterfaceDevice.current().play(.failure)
                }
            }
            // On success, pop back to the friend after a beat so the "Sent!"
            // confirmation is visible.
            try? await Task.sleep(nanoseconds: 900_000_000)
            await MainActor.run { if sent { dismiss() } }
        }
    }
}

/// Read the last handful of messages in this DM straight from the wrist.
/// Fetches on appear via the synced token; newest at the top.
struct MessagesView: View {
    @EnvironmentObject private var sync: WatchSyncStore
    let target: PokeTarget
    @State private var messages: [WatchMessage] = []
    @State private var loading = true
    @State private var failed = false

    var body: some View {
        Group {
            if loading {
                ProgressView()
            } else if failed {
                notice("Couldn’t load messages.")
            } else if messages.isEmpty {
                notice("No messages yet.")
            } else {
                List(messages) { m in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(m.author)
                            .font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        Text(m.content).font(.footnote)
                    }
                    .padding(.vertical, 2)
                }
            }
        }
        .navigationTitle("Messages")
        .task { await load() }
    }

    private func notice(_ s: String) -> some View {
        Text(s).font(.footnote).foregroundStyle(.secondary)
            .multilineTextAlignment(.center).padding()
    }

    private func load() async {
        guard let creds = await sync.credentials() else {
            await MainActor.run { loading = false; failed = true }
            return
        }
        var result = await WatchPokeAPI.fetchMessages(baseURL: creds.base, token: creds.token, channelId: target.id, e2eeKey: target.e2eeKey)
        if result == nil {
            // A read is idempotent, so one refresh + retry is safe — recovers a
            // token that expired since the last sync, or a transient miss.
            if let creds2 = await sync.credentials() {
                result = await WatchPokeAPI.fetchMessages(baseURL: creds2.base, token: creds2.token, channelId: target.id, e2eeKey: target.e2eeKey)
            }
        }
        await MainActor.run {
            loading = false
            if let result { messages = result } else { failed = true }
        }
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
        guard !sending else { return }
        sending = true
        WKInterfaceDevice.current().play(.click)
        Task {
            // Pull a live token from the phone first so a stale/rotated one
            // doesn't drop the poke.
            guard let creds = await sync.credentials() else {
                await MainActor.run { sending = false; WKInterfaceDevice.current().play(.failure) }
                return
            }
            let ok = await WatchPokeAPI.poke(
                baseURL: creds.base, token: creds.token, channelId: target.id, pokeType: variant.rawValue
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
