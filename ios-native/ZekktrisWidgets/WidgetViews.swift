import SwiftUI
import WidgetKit

/// Standalone palette for the widget (the app's per-user `Theme` lives in the
/// app target). Zekktris default scheme — cyan accent on the navy ladder, plus
/// the in-app amber for streaks.
enum WidgetTheme {
    static let bg = Color(hex: 0x0E1422)
    static let ink1 = Color(hex: 0xF3F6FA)
    static let ink2 = Color(hex: 0xB5BECF)
    static let accent = Color(hex: 0x3DD7EC)
    static let amber = Color(hex: 0xFFB000)   // Theme.plasmaAmber
}

extension Color {
    init(hex: UInt) {
        self.init(
            .sRGB,
            red: Double((hex >> 16) & 0xFF) / 255,
            green: Double((hex >> 8) & 0xFF) / 255,
            blue: Double(hex & 0xFF) / 255,
            opacity: 1
        )
    }
}

/// The real profile picture (cached by WidgetImageLoader), falling back to a
/// tinted initial when there's no avatar / it hasn't loaded yet.
struct AvatarView: View {
    let image: UIImage?
    let name: String
    let size: CGFloat

    private var letter: String { String(name.first.map(Character.init) ?? "?").uppercased() }
    private var tint: Color {
        let palette: [UInt] = [0x3DD7EC, 0x9D7BFF, 0xEC5FB5, 0x4FDD8F, 0xFFB000]
        var h = 5381; for b in name.utf8 { h = (h &* 33) &+ Int(b) }
        return Color(hex: palette[abs(h) % palette.count])
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                tint.opacity(0.85).overlay(
                    Text(letter)
                        .font(.system(size: size * 0.42, weight: .bold))
                        .foregroundStyle(.white)
                )
            }
        }
        .frame(width: size, height: size)
        .clipShape(Circle())
        .overlay(Circle().strokeBorder(.white.opacity(0.12), lineWidth: 1))
    }
}

/// Streak pill — mirrors the in-app `StreakChip`: amber flame + count on a
/// rounded amber-tinted plate with an amber border.
struct StreakPill: View {
    let days: Int
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "flame.fill").font(.system(size: 9, weight: .bold))
                .foregroundStyle(WidgetTheme.amber)
            Text("\(min(days, 10_000))")
                .font(.system(size: 10, weight: .semibold).monospacedDigit())
                .foregroundStyle(WidgetTheme.ink1)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2.5)
        .background(WidgetTheme.amber.opacity(0.16), in: RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(WidgetTheme.amber.opacity(0.4), lineWidth: 1)
        )
    }
}

/// Prompt shown when a configurable widget has no friend picked yet.
private struct PickFriendPrompt: View {
    let systemImage: String
    let verb: String
    var body: some View {
        VStack(spacing: 6) {
            Image(systemName: systemImage).font(.system(size: 22)).foregroundStyle(WidgetTheme.accent)
            Text("Touch and hold,\nEdit Widget,\nthen pick who to \(verb).")
                .font(.system(size: 11)).multilineTextAlignment(.center)
                .foregroundStyle(WidgetTheme.ink2)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

// MARK: - Quick Poke (one friend, one tap, no list)

struct PokeWidgetView: View {
    let entry: PokeEntry
    var body: some View {
        Group {
            if let friend = entry.friend {
                // The WHOLE widget is the poke button — one tap, app stays closed.
                Button(intent: QuickPokeIntent(channelId: friend.id, pokeType: entry.pokeType.rawValue)) {
                    VStack(spacing: 8) {
                        ZStack(alignment: .bottomTrailing) {
                            AvatarView(image: entry.avatar, name: friend.name, size: 56)
                            Text(entry.pokeType.emoji)
                                .font(.system(size: 20))
                                .padding(3)
                                .background(WidgetTheme.bg, in: Circle())
                                .offset(x: 4, y: 4)
                        }
                        Text(friend.name)
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundStyle(WidgetTheme.ink1)
                            .lineLimit(1)
                        Text("Tap to \(entry.pokeType.rawValue)")
                            .font(.system(size: 10)).foregroundStyle(WidgetTheme.ink2)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
                .buttonStyle(.plain)
            } else {
                PickFriendPrompt(systemImage: "hand.point.right.fill", verb: "poke")
            }
        }
        .containerBackground(WidgetTheme.bg, for: .widget)
    }
}

// MARK: - Open DM (one friend, one tap → opens the chat)

struct MessageWidgetView: View {
    let entry: MessageEntry
    var body: some View {
        Group {
            if let friend = entry.friend {
                VStack(spacing: 8) {
                    ZStack(alignment: .bottomTrailing) {
                        AvatarView(image: entry.avatar, name: friend.name, size: 56)
                        Image(systemName: "bubble.left.fill")
                            .font(.system(size: 14))
                            .foregroundStyle(.white)
                            .padding(5)
                            .background(WidgetTheme.accent, in: Circle())
                            .overlay(Circle().strokeBorder(WidgetTheme.bg, lineWidth: 2))
                            .offset(x: 4, y: 4)
                    }
                    Text(friend.name)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(WidgetTheme.ink1)
                        .lineLimit(1)
                    Text("Tap to message")
                        .font(.system(size: 10)).foregroundStyle(WidgetTheme.ink2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // Whole widget opens the app at this DM's composer.
                .widgetURL(URL(string: "zekktris://dm/\(friend.id)"))
            } else {
                PickFriendPrompt(systemImage: "bubble.left.and.bubble.right.fill", verb: "message")
            }
        }
        .containerBackground(WidgetTheme.bg, for: .widget)
    }
}

// MARK: - Streaks (the only list — your current streaks)

struct StreaksWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: StreaksEntry

    private var maxRows: Int { family == .systemSmall ? 3 : 5 }

    var body: some View {
        Group {
            if entry.rows.isEmpty {
                VStack(spacing: 6) {
                    Image(systemName: "flame.fill").font(.system(size: 22)).foregroundStyle(WidgetTheme.amber)
                    Text("No streaks yet").font(.system(size: 12)).foregroundStyle(WidgetTheme.ink2)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                VStack(spacing: family == .systemSmall ? 6 : 8) {
                    ForEach(entry.rows.prefix(maxRows)) { row in
                        HStack(spacing: 8) {
                            AvatarView(image: row.avatar, name: row.name, size: 26)
                            Text(row.name)
                                .font(.system(size: 13, weight: .medium))
                                .foregroundStyle(WidgetTheme.ink1)
                                .lineLimit(1)
                            Spacer(minLength: 4)
                            StreakPill(days: row.streak)
                        }
                    }
                    Spacer(minLength: 0)
                }
            }
        }
        .containerBackground(WidgetTheme.bg, for: .widget)
    }
}
