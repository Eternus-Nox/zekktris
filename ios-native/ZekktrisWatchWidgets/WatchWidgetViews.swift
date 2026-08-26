import SwiftUI
import WidgetKit

private let amber = Color(red: 1.0, green: 0.69, blue: 0.0) // 0xFFB000

// MARK: - Quick Poke (one tap, no app launch)

struct WatchPokeView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchPokeEntry

    var body: some View {
        if let friend = entry.friend {
            Button(intent: WatchPokeActionIntent(channelId: friend.id, pokeType: entry.pokeType.rawValue)) {
                switch family {
                case .accessoryCircular:
                    ZStack {
                        AccessoryWidgetBackground()
                        Text(entry.pokeType.emoji).font(.title2)
                    }
                default: // rectangular
                    HStack(spacing: 8) {
                        Text(entry.pokeType.emoji).font(.title3)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Poke").font(.headline)
                            Text(friend.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                }
            }
            .buttonStyle(.plain)
        } else {
            WatchUnconfigured(symbol: "hand.point.right.fill", text: "Pick a friend", family: family)
        }
    }
}

// MARK: - Open DM (opens the watch app at that friend)

struct WatchMessageView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchMessageEntry

    var body: some View {
        Group {
            if let friend = entry.friend {
                switch family {
                case .accessoryCircular:
                    ZStack { AccessoryWidgetBackground(); Image(systemName: "bubble.left.fill").font(.title3) }
                case .accessoryInline:
                    Label(friend.name, systemImage: "bubble.left.fill")
                default:
                    HStack(spacing: 8) {
                        Image(systemName: "bubble.left.fill").font(.title3)
                        VStack(alignment: .leading, spacing: 1) {
                            Text("Message").font(.headline)
                            Text(friend.name).font(.caption2).foregroundStyle(.secondary).lineLimit(1)
                        }
                        Spacer(minLength: 0)
                    }
                }
            } else {
                WatchUnconfigured(symbol: "bubble.left.and.bubble.right.fill", text: "Pick a friend", family: family)
            }
        }
        // Whole complication opens the watch app at this DM.
        .widgetURL(entry.friend.flatMap { URL(string: "zekktris://friend/\($0.id)") })
    }
}

// MARK: - Streaks readout

struct WatchStreaksView: View {
    @Environment(\.widgetFamily) private var family
    let entry: WatchStreaksEntry

    var body: some View {
        if let top = entry.rows.first {
            switch family {
            case .accessoryCircular:
                ZStack {
                    AccessoryWidgetBackground()
                    VStack(spacing: -1) {
                        Image(systemName: "flame.fill").font(.system(size: 12)).foregroundStyle(amber)
                        Text("\(top.streak)").font(.system(size: 16, weight: .bold))
                    }
                }
            case .accessoryInline:
                Label("\(top.streak)d · \(top.name)", systemImage: "flame.fill")
            default:
                VStack(alignment: .leading, spacing: 2) {
                    ForEach(entry.rows.prefix(3)) { r in
                        HStack(spacing: 4) {
                            Image(systemName: "flame.fill").font(.caption2).foregroundStyle(amber)
                            Text(r.name).font(.caption2).lineLimit(1)
                            Spacer(minLength: 2)
                            Text("\(r.streak)").font(.caption2).fontWeight(.semibold)
                        }
                    }
                }
            }
        } else {
            // The empty branch IS the placeholder pass: `placeholder(in:)` returns
            // `rows: []`, so this is what the watch-face complication picker draws,
            // under `.redacted(reason: .placeholder)`. Without `.unredacted()` the
            // flame becomes a grey square inside AccessoryWidgetBackground's circle.
            // Only the empty branches need it — the populated ones above are never
            // reached by that pass, and marking them would instead punch them
            // through Always-On PRIVACY redaction, which is not wanted.
            switch family {
            case .accessoryCircular: ZStack { AccessoryWidgetBackground(); Image(systemName: "flame").foregroundStyle(amber).unredacted() }
            case .accessoryInline: Label("No streaks", systemImage: "flame")
            default: Text("No streaks yet").font(.caption2).foregroundStyle(.secondary)
            }
        }
    }
}

/// Shared "not configured yet" placeholder.
///
/// This is also what every provider's `placeholder(in:)` renders (friend == nil),
/// i.e. what the watch-face complication picker shows. WidgetKit draws that
/// pass with `.redacted(reason: .placeholder)`, which turns the SF Symbol into a
/// grey rounded square — leaving only `AccessoryWidgetBackground`'s circle
/// around it. `.unredacted()` on the glyph keeps the symbol visible; the label
/// stays redactable so Always-On privacy redaction still hides it.
struct WatchUnconfigured: View {
    let symbol: String
    let text: String
    let family: WidgetFamily
    var body: some View {
        switch family {
        case .accessoryCircular:
            ZStack { AccessoryWidgetBackground(); Image(systemName: symbol).unredacted() }
        case .accessoryInline:
            Label(text, systemImage: symbol)
        default:
            HStack(spacing: 6) { Image(systemName: symbol); Text(text).font(.caption2) }
        }
    }
}
