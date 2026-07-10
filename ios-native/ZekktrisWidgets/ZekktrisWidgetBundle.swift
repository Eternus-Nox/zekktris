import WidgetKit
import SwiftUI
import AppIntents

/// Widget extension entry point. Three focused widgets:
///  • Quick Poke — pick one friend, single-button one-tap poke (no list).
///  • Open DM    — pick one friend, single button that opens the chat.
///  • Streaks    — a list of your current streaks (the only list widget).
@main
struct ZekktrisWidgetBundle: WidgetBundle {
    var body: some Widget {
        PokeWidget()
        MessageWidget()
        StreaksWidget()
    }
}

// MARK: - Quick Poke

struct PokeEntry: TimelineEntry {
    let date: Date
    let friend: FriendEntity?
    let pokeType: WidgetPokeType
    let avatar: UIImage?
}

struct PokeProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> PokeEntry {
        PokeEntry(date: Date(), friend: nil, pokeType: .poke, avatar: nil)
    }
    func snapshot(for configuration: PokeConfigIntent, in context: Context) async -> PokeEntry {
        await make(configuration)
    }
    func timeline(for configuration: PokeConfigIntent, in context: Context) async -> Timeline<PokeEntry> {
        Timeline(entries: [await make(configuration)], policy: .never)
    }
    private func make(_ c: PokeConfigIntent) async -> PokeEntry {
        let avatar = await WidgetImageLoader.shared.image(for: c.friend?.avatarURL)
        return PokeEntry(date: Date(), friend: c.friend, pokeType: c.pokeType, avatar: avatar)
    }
}

struct PokeWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ZekktrisPoke", intent: PokeConfigIntent.self, provider: PokeProvider()) { entry in
            PokeWidgetView(entry: entry)
        }
        .configurationDisplayName("Quick Poke")
        .description("One tap to poke a chosen friend.")
        .supportedFamilies([.systemSmall])
    }
}

// MARK: - Open DM

struct MessageEntry: TimelineEntry {
    let date: Date
    let friend: FriendEntity?
    let avatar: UIImage?
}

struct MessageProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> MessageEntry {
        MessageEntry(date: Date(), friend: nil, avatar: nil)
    }
    func snapshot(for configuration: MessageConfigIntent, in context: Context) async -> MessageEntry {
        await make(configuration)
    }
    func timeline(for configuration: MessageConfigIntent, in context: Context) async -> Timeline<MessageEntry> {
        Timeline(entries: [await make(configuration)], policy: .never)
    }
    private func make(_ c: MessageConfigIntent) async -> MessageEntry {
        let avatar = await WidgetImageLoader.shared.image(for: c.friend?.avatarURL)
        return MessageEntry(date: Date(), friend: c.friend, avatar: avatar)
    }
}

struct MessageWidget: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ZekktrisMessage", intent: MessageConfigIntent.self, provider: MessageProvider()) { entry in
            MessageWidgetView(entry: entry)
        }
        .configurationDisplayName("Open DM")
        .description("One tap to open a chosen friend's chat.")
        .supportedFamilies([.systemSmall])
    }
}

// MARK: - Streaks (list)

struct StreakRow: Identifiable {
    let id: String
    let name: String
    let streak: Int
    let avatar: UIImage?
}

struct StreaksEntry: TimelineEntry {
    let date: Date
    let rows: [StreakRow]
}

struct StreaksProvider: TimelineProvider {
    func placeholder(in context: Context) -> StreaksEntry {
        StreaksEntry(date: Date(), rows: [])
    }
    func getSnapshot(in context: Context, completion: @escaping (StreaksEntry) -> Void) {
        Task { completion(await load()) }
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<StreaksEntry>) -> Void) {
        Task { completion(Timeline(entries: [await load()], policy: .never)) }
    }
    private func load() async -> StreaksEntry {
        let dms = WidgetBridge.recentDMs()
            .filter { $0.streak > 0 }
            .sorted { $0.streak > $1.streak }
            .prefix(5)
        var rows: [StreakRow] = []
        for dm in dms {
            let avatar = await WidgetImageLoader.shared.image(for: dm.avatarURL)
            rows.append(StreakRow(id: dm.id, name: dm.name, streak: dm.streak, avatar: avatar))
        }
        return StreaksEntry(date: Date(), rows: rows)
    }
}

struct StreaksWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ZekktrisStreaks", provider: StreaksProvider()) { entry in
            StreaksWidgetView(entry: entry)
        }
        .configurationDisplayName("Streaks")
        .description("Your current DM streaks at a glance.")
        .supportedFamilies([.systemSmall, .systemMedium])
    }
}
