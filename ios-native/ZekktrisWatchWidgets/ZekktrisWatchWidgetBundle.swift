import WidgetKit
import SwiftUI
import AppIntents

/// watchOS widget/complication bundle — the same trio as the phone, sized for
/// the watch face + Smart Stack: one-tap Quick Poke, Open DM, and a Streaks
/// readout. Reads everything from the watch App Group the watch app publishes.
@main
struct ZekktrisWatchWidgetBundle: WidgetBundle {
    var body: some Widget {
        WatchPokeComplication()
        WatchMessageComplication()
        WatchStreaksComplication()
    }
}

// MARK: - Quick Poke

struct WatchPokeEntry: TimelineEntry {
    let date: Date
    let friend: WatchFriendEntity?
    let pokeType: WatchWidgetPokeType
}

struct WatchPokeProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> WatchPokeEntry {
        WatchPokeEntry(date: Date(), friend: nil, pokeType: .poke)
    }
    func snapshot(for configuration: WatchPokeConfigIntent, in context: Context) async -> WatchPokeEntry {
        WatchPokeEntry(date: Date(), friend: configuration.friend, pokeType: configuration.pokeType)
    }
    func timeline(for configuration: WatchPokeConfigIntent, in context: Context) async -> Timeline<WatchPokeEntry> {
        Timeline(entries: [WatchPokeEntry(date: Date(), friend: configuration.friend, pokeType: configuration.pokeType)], policy: .never)
    }
    // Required on watchOS (no default, unlike iOS). No auto-suggestions — the
    // user adds the complication and picks a friend.
    func recommendations() -> [AppIntentRecommendation<WatchPokeConfigIntent>] { [] }
}

struct WatchPokeComplication: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ZekktrisWatchPoke", intent: WatchPokeConfigIntent.self, provider: WatchPokeProvider()) { entry in
            WatchPokeView(entry: entry)
        }
        .configurationDisplayName("Quick Poke")
        .description("One tap to poke a chosen friend.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular])
    }
}

// MARK: - Open DM

struct WatchMessageEntry: TimelineEntry {
    let date: Date
    let friend: WatchFriendEntity?
}

struct WatchMessageProvider: AppIntentTimelineProvider {
    func placeholder(in context: Context) -> WatchMessageEntry {
        WatchMessageEntry(date: Date(), friend: nil)
    }
    func snapshot(for configuration: WatchMessageConfigIntent, in context: Context) async -> WatchMessageEntry {
        WatchMessageEntry(date: Date(), friend: configuration.friend)
    }
    func timeline(for configuration: WatchMessageConfigIntent, in context: Context) async -> Timeline<WatchMessageEntry> {
        Timeline(entries: [WatchMessageEntry(date: Date(), friend: configuration.friend)], policy: .never)
    }
    func recommendations() -> [AppIntentRecommendation<WatchMessageConfigIntent>] { [] }
}

struct WatchMessageComplication: Widget {
    var body: some WidgetConfiguration {
        AppIntentConfiguration(kind: "ZekktrisWatchMessage", intent: WatchMessageConfigIntent.self, provider: WatchMessageProvider()) { entry in
            WatchMessageView(entry: entry)
        }
        .configurationDisplayName("Open DM")
        .description("Open a chosen friend's chat on the watch.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

// MARK: - Streaks

struct WatchStreaksEntry: TimelineEntry {
    let date: Date
    let rows: [WatchWidgetDM]
}

struct WatchStreaksProvider: TimelineProvider {
    func placeholder(in context: Context) -> WatchStreaksEntry {
        WatchStreaksEntry(date: Date(), rows: [])
    }
    func getSnapshot(in context: Context, completion: @escaping (WatchStreaksEntry) -> Void) {
        completion(load())
    }
    func getTimeline(in context: Context, completion: @escaping (Timeline<WatchStreaksEntry>) -> Void) {
        completion(Timeline(entries: [load()], policy: .never))
    }
    private func load() -> WatchStreaksEntry {
        let rows = WatchWidgetBridge.dms()
            .filter { $0.streak > 0 }
            .sorted { $0.streak > $1.streak }
        return WatchStreaksEntry(date: Date(), rows: rows)
    }
}

struct WatchStreaksComplication: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "ZekktrisWatchStreaks", provider: WatchStreaksProvider()) { entry in
            WatchStreaksView(entry: entry)
        }
        .configurationDisplayName("Streaks")
        .description("Your top DM streaks.")
        .supportedFamilies([.accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}
