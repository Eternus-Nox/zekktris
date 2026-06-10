import SwiftUI
import UIKit
import Foundation

/// Circular user avatar that loads a remote image and falls back to the
/// initial letter on a tinted disc. Optionally shows a presence dot.
/// Image loader that actually retries. SwiftUI's AsyncImage parks in its
/// failure phase forever after one transient network error — which reads
/// as "assets randomly don't load" until the view happens to be rebuilt.
/// This loads through URLSession.shared (hitting the enlarged URLCache
/// from AppDelegate), retries with backoff, and re-attempts whenever the
/// view reappears or the URL changes.
struct RetryingImage: View {
    let url: URL
    @State private var image: UIImage?
    /// Which URL the current `image` belongs to. A recycled LazyVStack row
    /// rebinds this view to a different url, but `@State` survives the
    /// rebind — without this guard the `image == nil` check skipped the
    /// reload and the PREVIOUS row's image (someone else's avatar) stayed
    /// on screen permanently.
    @State private var loadedURL: URL?

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.clear
            }
        }
        .task(id: url) {
            if loadedURL != url {
                image = nil // drop the stale image while the right one loads
                loadedURL = url
            }
            if image == nil { image = await Self.load(url) }
        }
    }

    /// Fetch with up to 3 attempts (0.6s / 1.2s backoff between them).
    static func load(_ url: URL, attempts: Int = 3) async -> UIImage? {
        var request = URLRequest(url: url)
        request.cachePolicy = .returnCacheDataElseLoad
        for attempt in 1...attempts {
            if Task.isCancelled { return nil }
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse,
                   !(200...299).contains(http.statusCode) {
                    throw URLError(.badServerResponse)
                }
                if let img = UIImage(data: data) { return img }
                throw URLError(.cannotDecodeContentData)
            } catch {
                guard attempt < attempts else { return nil }
                try? await Task.sleep(nanoseconds: UInt64(attempt) * 600_000_000)
            }
        }
        return nil
    }
}

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
                // Placeholder underneath; the retrying loader fades the
                // real image in over it (AsyncImage parked forever in its
                // failure phase after one transient blip — "assets
                // randomly don't load").
                placeholder.overlay { RetryingImage(url: resolved) }
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

/// Ambient deep-space backdrop, porting the web's `.abyss` canvas: four
/// blurred plasma auroras anchored near the corners plus a sparse starfield.
/// Mount once behind the shell; every column above it uses a translucent
/// fill (bg-0/85, bg-2/85, bg-1/90) so the nebula glows through exactly
/// like the web's backdrop-blur columns.
struct AbyssBackground: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                aurora(Theme.auroraViolet, rx: 0.60, ry: 0.50, at: CGPoint(x: 0.12, y: 0.08), in: geo.size)
                aurora(Theme.auroraCyan, rx: 0.50, ry: 0.40, at: CGPoint(x: 0.92, y: 0.14), in: geo.size)
                aurora(Theme.auroraMagenta, rx: 0.40, ry: 0.30, at: CGPoint(x: 0.78, y: 0.92), in: geo.size)
                aurora(Theme.auroraTeal, rx: 0.35, ry: 0.28, at: CGPoint(x: 0.18, y: 0.86), in: geo.size)

                // Starfield (positions + alphas from the web's ::after dots).
                ForEach(Array(Self.stars.enumerated()), id: \.offset) { _, star in
                    Circle()
                        .fill(Theme.starlight.opacity(star.alpha))
                        .frame(width: 2, height: 2)
                        .position(x: star.x * w, y: star.y * h)
                }
            }
            // Flatten the blurred gradients into one offscreen texture so the
            // 40pt blur is paid once, not on every compositor pass.
            .drawingGroup()
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    private static let stars: [(x: CGFloat, y: CGFloat, alpha: Double)] = [
        (0.24, 0.30, 0.6), (0.80, 0.12, 0.5), (0.62, 0.78, 0.4),
        (0.14, 0.70, 0.5), (0.92, 0.56, 0.4), (0.46, 0.22, 0.3),
    ]

    /// One blurred aurora blob. CSS radial-gradient radii are % of the box
    /// dimensions; we model the ellipse as a scaled circle so the radial
    /// gradient stays smooth, then blur generously like the web (40px).
    private func aurora(_ color: Color, rx: CGFloat, ry: CGFloat, at unit: CGPoint, in size: CGSize) -> some View {
        let rW = size.width * rx
        let rH = size.height * ry
        return Ellipse()
            .fill(
                EllipticalGradient(
                    colors: [color, .clear],
                    center: .center,
                    startRadiusFraction: 0,
                    endRadiusFraction: 0.5
                )
            )
            .frame(width: rW * 2, height: rH * 2)
            .position(x: unit.x * size.width, y: unit.y * size.height)
            .blur(radius: 40)
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

// ── Speaking indicator (web .zk-alien-pulse, themed) ────────────────────────
// Three concentric rings expand outward and fade on a 1.4s ease-out cycle —
// the web's multi-layer sonar ripple. Colors follow the ACTIVE THEME's
// accent trio (accent / accent-2 / accent-3), so Sunset pulses orange,
// Forest pulses blue/green, etc. On the default theme this resolves to the
// same cyan→violet→magenta the web ships.
struct AlienPulse: ViewModifier {
    let active: Bool
    @State private var animating = false

    func body(content: Content) -> some View {
        content
            .overlay {
                if active {
                    ZStack {
                        pulseRing(Theme.accent, alpha: 0.55, spread: 5)
                        pulseRing(Theme.accent2, alpha: 0.40, spread: 10)
                        pulseRing(Theme.accent3, alpha: 0.25, spread: 16)
                        // Resting edge so the avatar reads "live" between pulses.
                        Circle().strokeBorder(Theme.accent.opacity(0.7), lineWidth: 2)
                    }
                    .onAppear { animating = true }
                    .onDisappear { animating = false }
                }
            }
    }

    @ViewBuilder
    private func pulseRing(_ color: Color, alpha: Double, spread: CGFloat) -> some View {
        GeometryReader { geo in
            let d = min(geo.size.width, geo.size.height)
            Circle()
                .stroke(color.opacity(animating ? 0 : alpha), lineWidth: 2.5)
                .scaleEffect(animating ? (d + spread * 2) / d : 1)
                .animation(
                    .easeOut(duration: 1.4).repeatForever(autoreverses: false),
                    value: animating
                )
        }
    }
}

extension View {
    /// Web `.zk-alien-pulse`: apply to circular avatars while speaking.
    func alienPulse(_ active: Bool) -> some View {
        modifier(AlienPulse(active: active))
    }
}

// ── Emoji picker (web EmojiPicker parity: recent / unicode categories /
//    server emoji, with name search) ──────────────────────────────────────────

enum EmojiCatalog {
    /// Compact unicode catalog: (glyph, searchable name). Ordered into the
    /// same category groups the web picker uses.
    static let categories: [(name: String, symbol: String, emoji: [(String, String)])] = [
        ("Smileys", "face.smiling", [
            ("😀","grinning"),("😃","smiley"),("😄","smile"),("😁","grin"),("😆","laughing"),("😅","sweat smile"),
            ("😂","joy"),("🤣","rofl"),("🙂","slight smile"),("😉","wink"),("😊","blush"),("😇","innocent"),
            ("🥰","hearts face"),("😍","heart eyes"),("🤩","star struck"),("😘","kiss"),("😋","yum"),("😜","winking tongue"),
            ("🤪","zany"),("🤔","thinking"),("🤨","raised eyebrow"),("😐","neutral"),("😏","smirk"),("🙄","eye roll"),
            ("😬","grimace"),("😴","sleeping"),("🤒","sick"),("🤯","mind blown"),("😎","sunglasses"),("🥳","party face"),
            ("😢","cry"),("😭","sob"),("😡","rage"),("🤬","cursing"),("😱","scream"),("😳","flushed"),
            ("🥺","pleading"),("😈","smiling imp"),("💀","skull"),("👻","ghost"),("🤖","robot"),("💩","poop"),
        ]),
        ("People", "hand.raised", [
            ("👍","thumbs up"),("👎","thumbs down"),("👌","ok hand"),("✌️","victory"),("🤞","crossed fingers"),
            ("🤘","rock on"),("🤙","call me"),("👈","point left"),("👉","point right"),("👆","point up"),
            ("👇","point down"),("✋","raised hand"),("🖐️","hand splayed"),("👋","wave"),("🤝","handshake"),
            ("🙏","pray thanks"),("👏","clap"),("🙌","raised hands"),("💪","muscle flex"),("🫶","heart hands"),
            ("🤷","shrug"),("🤦","facepalm"),("🧠","brain"),("👀","eyes"),("👑","crown"),("🫡","salute"),
        ]),
        ("Nature", "leaf", [
            ("🐶","dog"),("🐱","cat"),("🐭","mouse"),("🐹","hamster"),("🐰","rabbit"),("🦊","fox"),
            ("🐻","bear"),("🐼","panda"),("🐨","koala"),("🐯","tiger"),("🦁","lion"),("🐸","frog"),
            ("🐵","monkey"),("🐔","chicken"),("🐧","penguin"),("🦄","unicorn"),("🐝","bee"),("🦋","butterfly"),
            ("🌵","cactus"),("🌲","evergreen"),("🌹","rose"),("🌻","sunflower"),("🍀","clover luck"),("🍄","mushroom"),
            ("🌙","moon"),("⭐","star"),("🌈","rainbow"),("⚡","zap lightning"),("🔥","fire"),("❄️","snowflake"),
            ("💧","droplet"),("🌊","wave water"),
        ]),
        ("Food", "fork.knife", [
            ("🍎","apple"),("🍌","banana"),("🍉","watermelon"),("🍇","grapes"),("🍓","strawberry"),("🍒","cherries"),
            ("🍑","peach"),("🥭","mango"),("🍍","pineapple"),("🥑","avocado"),("🍔","burger"),("🍟","fries"),
            ("🍕","pizza"),("🌭","hotdog"),("🌮","taco"),("🌯","burrito"),("🍜","ramen noodles"),("🍣","sushi"),
            ("🍩","donut"),("🍪","cookie"),("🎂","birthday cake"),("🍰","cake"),("🍫","chocolate"),("🍿","popcorn"),
            ("☕","coffee"),("🍺","beer"),("🍷","wine"),("🥤","cup straw"),
        ]),
        ("Travel", "car", [
            ("🚗","car"),("🚕","taxi"),("🚌","bus"),("🏎️","race car"),("🚓","police car"),("🚑","ambulance"),
            ("🚒","fire engine"),("🚲","bike"),("🏍️","motorcycle"),("✈️","airplane"),("🚀","rocket"),("🛸","ufo"),
            ("🚁","helicopter"),("⛵","sailboat"),("🚢","ship"),("🗽","statue liberty"),("🗼","tokyo tower"),("🏰","castle"),
            ("🏝️","desert island"),("⛰️","mountain"),("🏠","house"),("🌋","volcano"),
        ]),
        ("Activity", "gamecontroller", [
            ("⚽","soccer"),("🏀","basketball"),("🏈","football"),("⚾","baseball"),("🎾","tennis"),("🏐","volleyball"),
            ("🎱","8ball"),("🏓","ping pong"),("🥊","boxing"),("⛳","golf"),("🎣","fishing"),("🎽","running"),
            ("🛹","skateboard"),("🎿","ski"),("🏆","trophy"),("🥇","gold medal"),("🎯","dart target"),("🎮","video game"),
            ("🕹️","joystick"),("🎲","dice"),("♟️","chess"),("🎰","slot machine"),("🎳","bowling"),("🎤","microphone sing"),
            ("🎧","headphones"),("🎸","guitar"),("🎹","piano"),("🥁","drum"),("🎨","art palette"),("🎬","clapper movie"),
        ]),
        ("Objects", "lightbulb", [
            ("⌚","watch"),("📱","phone"),("💻","laptop"),("⌨️","keyboard"),("🖥️","desktop"),("🖨️","printer"),
            ("📷","camera"),("🎥","movie camera"),("🔍","magnifier search"),("💡","bulb idea"),("🔦","flashlight"),("📚","books"),
            ("📝","memo note"),("✏️","pencil"),("📌","pushpin"),("📎","paperclip"),("🔒","lock"),("🔑","key"),
            ("🔨","hammer"),("🛠️","tools"),("⚙️","gear"),("🧲","magnet"),("💣","bomb"),("🧪","test tube"),
            ("💊","pill"),("💰","money bag"),("💎","gem diamond"),("📦","package"),("🎁","gift"),("🎈","balloon"),
            ("🎉","party popper tada"),("🎊","confetti"),
        ]),
        ("Symbols", "heart", [
            ("❤️","red heart"),("🧡","orange heart"),("💛","yellow heart"),("💚","green heart"),("💙","blue heart"),
            ("💜","purple heart"),("🖤","black heart"),("🤍","white heart"),("💔","broken heart"),("💕","two hearts"),
            ("💖","sparkling heart"),("💯","hundred"),("💢","anger"),("💥","collision boom"),("💫","dizzy"),("💦","sweat drops"),
            ("✨","sparkles"),("❗","exclamation"),("❓","question"),("✅","check mark"),("❌","cross mark"),("⚠️","warning"),
            ("🚫","prohibited"),("♻️","recycle"),("🔞","18 plus"),("🆒","cool"),("🆕","new"),("🆓","free"),
        ]),
        ("Flags", "flag", [
            ("🏁","checkered flag"),("🚩","triangular flag"),("🏴‍☠️","pirate flag"),("🏳️","white flag"),
            ("🏳️‍🌈","rainbow flag"),("🇺🇸","usa"),("🇬🇧","uk"),("🇨🇦","canada"),("🇦🇺","australia"),("🇩🇪","germany"),
            ("🇫🇷","france"),("🇪🇸","spain"),("🇮🇹","italy"),("🇯🇵","japan"),("🇰🇷","korea"),("🇧🇷","brazil"),
            ("🇲🇽","mexico"),("🇮🇳","india"),
        ]),
    ]

    static let recentKey = "zk.recentEmoji"
    static func recents() -> [String] {
        UserDefaults.standard.stringArray(forKey: recentKey) ?? []
    }
    static func pushRecent(_ emoji: String) {
        var r = recents()
        r.removeAll { $0 == emoji }
        r.insert(emoji, at: 0)
        if r.count > 24 { r = Array(r.prefix(24)) }
        UserDefaults.standard.set(r, forKey: recentKey)
    }
}

/// Unified emoji picker sheet (web EmojiPicker parity): search across
/// unicode + server emoji, a Recently Used row, unicode category sections,
/// and the guild's custom emoji. Calls back with either a literal unicode
/// glyph or a `:name:` token for custom emoji.
struct EmojiPickerSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let onPick: (String) -> Void

    @State private var query = ""
    private let cols = [GridItem(.adaptive(minimum: 44), spacing: 6)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if query.trimmingCharacters(in: .whitespaces).isEmpty {
                        if !EmojiCatalog.recents().isEmpty {
                            section("RECENTLY USED") {
                                grid(EmojiCatalog.recents().map { ($0, "") })
                            }
                        }
                        if !store.guildEmojis.isEmpty {
                            section("SERVER") { customGrid(store.guildEmojis) }
                        }
                        ForEach(EmojiCatalog.categories, id: \.name) { cat in
                            section(cat.name.uppercased()) { grid(cat.emoji) }
                        }
                    } else {
                        let q = query.lowercased()
                        let unicodeHits = EmojiCatalog.categories.flatMap(\.emoji)
                            .filter { $0.1.contains(q) }
                        let customHits = store.guildEmojis.filter { $0.name.lowercased().contains(q) }
                        if unicodeHits.isEmpty && customHits.isEmpty {
                            Text("No emoji found")
                                .font(.zkSans(13)).foregroundColor(Theme.ink3)
                                .frame(maxWidth: .infinity).padding(.top, 24)
                        }
                        if !customHits.isEmpty { section("SERVER") { customGrid(customHits) } }
                        if !unicodeHits.isEmpty { section("EMOJI") { grid(unicodeHits) } }
                    }
                }
                .padding(12)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search emoji")
            .navigationTitle("Add Reaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadEmojis() }
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.zkMono(10.5))
                .tracking(Theme.capTracking(10.5))
                .foregroundColor(Theme.ink3)
            content()
        }
    }

    private func grid(_ items: [(String, String)]) -> some View {
        LazyVGrid(columns: cols, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                Button {
                    EmojiCatalog.pushRecent(item.0)
                    onPick(item.0)
                } label: {
                    Text(item.0)
                        .font(.system(size: 28))
                        .frame(width: 44, height: 44)
                        .background(Theme.bg2)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func customGrid(_ emojis: [GuildEmoji]) -> some View {
        LazyVGrid(columns: cols, spacing: 6) {
            ForEach(emojis) { e in
                Button {
                    onPick(":\(e.name):")
                } label: {
                    Group {
                        if let img = store.emojiImage(for: e) {
                            Image(uiImage: img).resizable().scaledToFit()
                        } else {
                            AsyncImage(url: assetURL(e.url)) { phase in
                                if case .success(let image) = phase {
                                    image.resizable().scaledToFit()
                                } else {
                                    Text(":\(e.name):").font(.zkSans(9)).foregroundColor(Theme.ink3)
                                }
                            }
                        }
                    }
                    .padding(8)
                    .frame(width: 44, height: 44)
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
        }
    }
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
