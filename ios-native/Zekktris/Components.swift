import SwiftUI
import Foundation

/// Circular user avatar that loads a remote image and falls back to the
/// initial letter on a tinted disc. Optionally shows a presence dot.
struct Avatar: View {
    let url: String?
    let name: String
    var size: CGFloat = 40
    /// When set, draws a presence dot in the bottom-trailing corner.
    var status: String? = nil
    /// Background color the dot's ring blends into (match the surface).
    var ringColor: Color = Theme.bg2
    /// When true, clips to a rounded square (for the server rail) instead of
    /// a circle. Defaults to a circle everywhere else.
    var squircle: Bool = false
    /// Cosmetic ring/glow decoration id (see Avatar.decorations); nil/"none" = none.
    var decoration: String? = nil

    var body: some View {
        Group {
            if let resolved = assetURL(url) {
                AsyncImage(url: resolved) { phase in
                    switch phase {
                    case .success(let image):
                        image.resizable().scaledToFill()
                    default:
                        placeholder
                    }
                }
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(squircle ? AnyShape(RoundedRectangle(cornerRadius: size * 0.33, style: .continuous)) : AnyShape(Circle()))
        .overlay { decorationOverlay }
        .overlay(alignment: .bottomTrailing) {
            if let status {
                PresenceDot(status: status, ring: ringColor)
                    .frame(width: max(10, size * 0.3), height: max(10, size * 0.3))
                    .offset(x: 1, y: 1)
            }
        }
    }

    @ViewBuilder
    private var decorationOverlay: some View {
        if let deco = decoration, deco != "none", !deco.isEmpty {
            if squircle {
                decoStroke(RoundedRectangle(cornerRadius: size * 0.33, style: .continuous), deco)
            } else {
                decoStroke(Circle(), deco)
            }
        }
    }

    @ViewBuilder
    private func decoStroke<S: InsettableShape>(_ shape: S, _ deco: String) -> some View {
        if let cols = Avatar.decoGradient(deco) {
            shape.strokeBorder(AngularGradient(colors: cols, center: .center), lineWidth: max(2, size * 0.05))
        } else if let c = Avatar.decoColor(deco) {
            shape.strokeBorder(c, lineWidth: max(2, size * 0.05))
                .shadow(color: deco == "ring" ? .clear : c.opacity(0.6), radius: deco == "ring" ? 0 : size * 0.12)
        }
    }

    static let decorations: [(id: String, label: String)] = [
        ("none", "None"), ("ring", "Accent"), ("glow", "Accent glow"), ("gold", "Gold"),
        ("rose", "Rose"), ("violet", "Violet"), ("lime", "Lime"),
        ("aurora", "Aurora"), ("sunset", "Sunset"), ("emerald", "Emerald"),
    ]
    static func decoColor(_ id: String) -> Color? {
        switch id {
        case "ring", "glow": return Theme.accent
        case "gold": return Color(hex: 0xF4C95B)
        case "rose": return Color(hex: 0xEC5FB5)
        case "violet": return Color(hex: 0x9D7BFF)
        case "lime": return Color(hex: 0x7EE787)
        default: return nil
        }
    }
    static func decoGradient(_ id: String) -> [Color]? {
        switch id {
        case "aurora": return [Color(hex: 0x3DD7EC), Color(hex: 0x9D7BFF), Color(hex: 0xEC5FB5), Color(hex: 0x3DD7EC)]
        case "sunset": return [Color(hex: 0xFFD13D), Color(hex: 0xEC5FB5), Color(hex: 0x9D7BFF), Color(hex: 0xFFD13D)]
        case "emerald": return [Color(hex: 0x7EE787), Color(hex: 0x3DD7EC), Color(hex: 0x7EE787)]
        default: return nil
        }
    }

    private var placeholder: some View {
        ZStack {
            Theme.bg3
            Text(String(name.prefix(1)).uppercased())
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundColor(Theme.ink2)
        }
    }
}

/// Small status indicator dot with a ring that blends into its background.
struct PresenceDot: View {
    let status: String
    var ring: Color = Theme.bg2
    var body: some View {
        Circle()
            .fill(presenceColor(status))
            .overlay(Circle().strokeBorder(ring, lineWidth: 2))
    }
}

func presenceColor(_ status: String) -> Color {
    switch status {
    case "online": return Theme.online
    case "idle": return Color(hex: 0xF0B232)
    case "dnd": return Theme.danger
    default: return Theme.ink4 // offline / invisible / unknown
    }
}

/// Squircle guild icon for the server rail. Shows the icon image, or the
/// guild's initials, and an accent ring/indicator when selected.
struct GuildIcon: View {
    let guild: Guild
    let isSelected: Bool
    var size: CGFloat = 48

    var body: some View {
        Group {
            if let resolved = assetURL(guild.iconUrl) {
                AsyncImage(url: resolved) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFill()
                    default: initials
                    }
                }
            } else {
                initials
            }
        }
        .frame(width: size, height: size)
        .background(Theme.bg3)
        .clipShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .strokeBorder(isSelected ? Theme.accent : Color.clear, lineWidth: 2)
        )
        .animation(.easeOut(duration: 0.15), value: isSelected)
    }

    private var initials: some View {
        Text(guildInitials(guild.name))
            .font(.system(size: size * 0.34, weight: .semibold))
            .foregroundColor(Theme.ink1)
    }
}

/// First letters of up to the first two words of a name (e.g. "My Cool
/// Server" → "MC"), used for icon placeholders.
func guildInitials(_ name: String) -> String {
    let words = name.split(separator: " ").prefix(2)
    let letters = words.compactMap { $0.first }.map(String.init)
    return letters.joined().uppercased()
}

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let isoFormatterNoFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

private let timeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "h:mm a"
    return f
}()

/// Parse an ISO timestamp from the API into a short local time string.
/// Returns "" if the value can't be parsed.
func shortTime(_ iso: String) -> String {
    let date = isoFormatter.date(from: iso) ?? isoFormatterNoFraction.date(from: iso)
    guard let date else { return "" }
    return timeFormatter.string(from: date)
}

private let dateDividerFormatter: DateFormatter = {
    let f = DateFormatter(); f.dateStyle = .long; f.timeStyle = .none; return f
}()

/// Parse an ISO timestamp (fractional or plain) into a Date, or nil.
func messageDate(_ iso: String) -> Date? {
    isoFormatter.date(from: iso) ?? isoFormatterNoFraction.date(from: iso)
}

/// "Today" / "Yesterday" / "January 5, 2026" label for a message date divider.
func dateDividerLabel(_ iso: String) -> String {
    guard let date = messageDate(iso) else { return "" }
    let cal = Calendar.current
    if cal.isDateInToday(date) { return "Today" }
    if cal.isDateInYesterday(date) { return "Yesterday" }
    return dateDividerFormatter.string(from: date)
}

/// True if two ISO timestamps fall on different calendar days.
func isDifferentDay(_ a: String, _ b: String) -> Bool {
    guard let da = messageDate(a), let db = messageDate(b) else { return false }
    return !Calendar.current.isDate(da, inSameDayAs: db)
}

/// Numeric snowflake comparison (ids are monotonic numeric strings).
func snowflakeGreater(_ a: String, than b: String) -> Bool {
    if let ai = UInt64(a), let bi = UInt64(b) { return ai > bi }
    if a.count != b.count { return a.count > b.count }
    return a > b
}

// ── Password strength (approximate port of the web meter) ───────────────────
func passwordStrength(_ pw: String) -> Int {
    if pw.isEmpty { return 0 }
    var score = 0
    if pw.count >= 8 { score += 1 }
    if pw.count >= 12 { score += 1 }
    let hasUpper = pw.range(of: "[A-Z]", options: .regularExpression) != nil
    let hasLower = pw.range(of: "[a-z]", options: .regularExpression) != nil
    if hasUpper && hasLower { score += 1 }
    if pw.range(of: "[0-9]", options: .regularExpression) != nil { score += 1 }
    if pw.range(of: "[^A-Za-z0-9]", options: .regularExpression) != nil { score += 1 }
    return min(4, score)
}

func passwordStrengthLabel(_ score: Int) -> String {
    ["", "Weak", "Fair", "Good", "Strong"][max(0, min(4, score))]
}

func passwordStrengthColor(_ score: Int) -> Color {
    switch score {
    case 0: return Theme.ink4
    case 1: return Theme.danger
    case 2: return Theme.accent3
    case 3: return Theme.accent2
    default: return Theme.accent
    }
}
