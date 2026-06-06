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
    /// Stable id used for the deterministic fallback tone (web hashes the
    /// user/guild id). When nil, the name is hashed instead.
    var toneId: String? = nil

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
        .clipShape(squircle ? AnyShape(RoundedRectangle(cornerRadius: size * Theme.squircleFraction, style: .continuous)) : AnyShape(Circle()))
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
                decoStroke(RoundedRectangle(cornerRadius: size * Theme.squircleFraction, style: .continuous), deco)
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
        // Web parity (lib/avatar.ts): deterministic FNV-1a tone keyed by
        // the same id string the web hashes, plus two-word initials. The
        // id used on web is the user/guild id; fall back to the name when
        // no id is available so old call sites still render something.
        let tone = avatarTone(toneId ?? name)
        return ZStack {
            tone.bg
            Text(avatarInitials(name))
                .font(.zkSans(size * 0.36, weight: .semibold))
                .foregroundColor(tone.fg)
        }
    }
}

// ── Deterministic avatar tones (port of web lib/avatar.ts) ──────────────────
// Same FNV-1a 32-bit hash over the id, same 8-color palette (Tailwind
// rose-700…pink-700 with their -50 text pairs), so a given user renders the
// identical fallback color on web and iOS.
struct AvatarTone { let bg: Color; let fg: Color }

private let avatarPalette: [AvatarTone] = [
    AvatarTone(bg: Color(hex: 0xBE123C), fg: Color(hex: 0xFFF1F2)), // rose-700 / rose-50
    AvatarTone(bg: Color(hex: 0xD97706), fg: Color(hex: 0xFFFBEB)), // amber-600 / amber-50
    AvatarTone(bg: Color(hex: 0x047857), fg: Color(hex: 0xECFDF5)), // emerald-700 / emerald-50
    AvatarTone(bg: Color(hex: 0x0F766E), fg: Color(hex: 0xF0FDFA)), // teal-700 / teal-50
    AvatarTone(bg: Color(hex: 0x0369A1), fg: Color(hex: 0xF0F9FF)), // sky-700 / sky-50
    AvatarTone(bg: Color(hex: 0x4338CA), fg: Color(hex: 0xEEF2FF)), // indigo-700 / indigo-50
    AvatarTone(bg: Color(hex: 0x7E22CE), fg: Color(hex: 0xFAF5FF)), // purple-700 / purple-50
    AvatarTone(bg: Color(hex: 0xBE185D), fg: Color(hex: 0xFDF2F8)), // pink-700 / pink-50
]

/// FNV-1a 32-bit over UTF-16 code units — byte-for-byte the web's hash
/// (charCodeAt ^ then Math.imul by the FNV prime), including the
/// Math.abs(Int32) behavior via `magnitude`.
func avatarTone(_ id: String?) -> AvatarTone {
    guard let id, !id.isEmpty else { return avatarPalette[0] }
    var hash = Int32(bitPattern: 0x811c9dc5)
    for u in id.utf16 {
        hash ^= Int32(u)
        hash = hash &* Int32(bitPattern: 0x01000193)
    }
    return avatarPalette[Int(hash.magnitude) % avatarPalette.count]
}

/// Two-word initials, matching web `avatarInitials` ("My Cool Server" → "MC",
/// empty → "?").
func avatarInitials(_ name: String?) -> String {
    guard let name else { return "?" }
    let letters = name.split(whereSeparator: { $0.isWhitespace })
        .prefix(2)
        .compactMap { $0.first.map { String($0).uppercased() } }
        .joined()
    return letters.isEmpty ? "?" : letters
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
    // Web parity (ProfileCard.tsx): emerald-500 / amber-500 / red-500 / ink-3.
    switch status {
    case "online": return Theme.online
    case "idle": return Theme.idle
    case "dnd": return Theme.dnd
    default: return Theme.offline // offline / invisible / unknown
    }
}

/// Squircle guild icon for the server rail, matching the web GuildTile:
///   - With an icon image: bg-2 tile; when active, a 1px accent-glow ring
///     plus a soft outer glow.
///   - Without an icon: deterministic tone tile (same FNV-1a hash as web)
///     at 90% opacity; when active, an accent→accent-2 gradient with the
///     initials in bg-0.
struct GuildIcon: View {
    let guild: Guild
    let isSelected: Bool
    var size: CGFloat = 48

    private var radius: CGFloat { size * Theme.squircleFraction }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }

    var body: some View {
        Group {
            if let resolved = assetURL(guild.iconUrl) {
                AsyncImage(url: resolved) { phase in
                    switch phase {
                    case .success(let image): image.resizable().scaledToFill()
                    default: Color.clear
                    }
                }
                .frame(width: size, height: size)
                .background(Theme.bg2)
            } else if isSelected {
                LinearGradient(colors: [Theme.accent, Theme.accent2],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                    .frame(width: size, height: size)
                    .overlay(initials(color: Theme.bg0))
            } else {
                let tone = avatarTone(guild.id)
                tone.bg.opacity(0.9)
                    .frame(width: size, height: size)
                    .overlay(initials(color: tone.fg))
            }
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(isSelected ? Theme.accentGlow : Color.clear, lineWidth: 1))
        .shadow(color: isSelected ? Theme.accentGlow : .clear, radius: 14, x: 0, y: 8)
        .animation(.easeOut(duration: 0.15), value: isSelected)
    }

    private func initials(color: Color) -> some View {
        Text(guildInitials(guild.name))
            .font(.zkSans(size * 0.34, weight: .semibold))
            .foregroundColor(color)
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
