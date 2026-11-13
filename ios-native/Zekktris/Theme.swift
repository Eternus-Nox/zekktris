import SwiftUI

extension Color {
    /// Build a Color from a 0xRRGGBB hex literal.
    init(hex: UInt32, alpha: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }

    /// Parse a "#rrggbb" (or "rrggbb") hex string, e.g. a server-stored
    /// name-tag color. Returns nil for malformed input so callers can fall
    /// back to the theme accent.
    init?(hexString: String) {
        var s = hexString.trimmingCharacters(in: .whitespacesAndNewlines)
        if s.hasPrefix("#") { s.removeFirst() }
        guard s.count == 6, let v = UInt32(s, radix: 16) else { return nil }
        self.init(hex: v)
    }
}

/// A full set of themeable colors. Mirrors the web app's per-theme CSS
/// variables: every theme picks one of two background ladders (navy or
/// OLED black) and one of six accent trios. Ink/danger/status colors are
/// shared across all themes, so they live on `Theme` directly rather than
/// here.
///
/// Source of truth: apps/web/tailwind.config.js (`--c-*` channel values in
/// apps/web/src/index.css). Values here are byte-exact to the web hexes.
struct ThemePalette {
    let bg0, bg1, bg2, bg3: Color
    let line, lineSoft: Color
    let accent, accentSoft, accent2, accent3: Color

    struct Accents { let a1, a2, a3, soft: UInt32 }

    /// Accent trios, keyed by the base scheme name (matching the web).
    /// Web source: the [data-theme] blocks in index.css. `soft` is
    /// `--c-accent-soft`. The app themes only: Zekk Pet colours have their
    /// own table (ZekkPetPalette.colors), so don't add pet colours here.
    static let accentSchemes: [String: Accents] = [
        "default":  Accents(a1: 0x3DD7EC, a2: 0x9D7BFF, a3: 0xEC5FB5, soft: 0x2DB6C8),
        "sunset":   Accents(a1: 0xFF8A3D, a2: 0xFFD13D, a3: 0xFF7A7A, soft: 0xE0702A),
        "forest":   Accents(a1: 0x3D9BFF, a2: 0x4FDD8F, a3: 0x3DD8C0, soft: 0x2D7FE0),
        "crimson":  Accents(a1: 0xFF4D4D, a2: 0x9AA3B8, a3: 0xFF8080, soft: 0xE03A3A),
        "blossom":  Accents(a1: 0xFF5FA2, a2: 0xFFB088, a3: 0xFF9ECF, soft: 0xE0468A),
        "amethyst": Accents(a1: 0xA855F7, a2: 0xF5B942, a3: 0xD8A7FF, soft: 0x8B3FD6),
    ]

    /// The accent trio of a theme id like "sunset-oled" (an OLED theme has
    /// the same accents as its navy twin).
    static func accents(for id: String) -> Accents {
        let schemeKey: String = {
            if id == "oled" || id == "default" { return "default" }
            return id.replacingOccurrences(of: "-oled", with: "")
        }()
        return accentSchemes[schemeKey] ?? accentSchemes["default"]!
    }

    /// Resolve a theme id like "sunset-oled" into a concrete palette.
    static func palette(for id: String) -> ThemePalette {
        let oled = (id == "oled") || id.hasSuffix("-oled")
        let acc = accents(for: id)
        if oled {
            // Web OLED ladder: --c-bg-0..3 + --c-line (opaque, like
            // Tailwind's `border-line`).
            return ThemePalette(
                bg0: Color(hex: 0x000000), bg1: Color(hex: 0x06080C),
                bg2: Color(hex: 0x0D1017), bg3: Color(hex: 0x161B26),
                line: Color(hex: 0x242B3C), lineSoft: Theme.zkLineSoft,
                accent: Color(hex: acc.a1), accentSoft: Color(hex: acc.soft),
                accent2: Color(hex: acc.a2), accent3: Color(hex: acc.a3))
        }
        // Web navy ladder. `line` is Tailwind `--c-line: 42 52 80` = #2A3450,
        // used OPAQUE by `border-line` (the dominant divider everywhere).
        // The translucent oklch `--zk-line` used by glass panels is the
        // separate fixed token `Theme.glassLine` below.
        return ThemePalette(
            bg0: Color(hex: 0x0A0F1C), bg1: Color(hex: 0x0E1422),
            bg2: Color(hex: 0x131A2A), bg3: Color(hex: 0x1C2438),
            line: Color(hex: 0x2A3450), lineSoft: Theme.zkLineSoft,
            accent: Color(hex: acc.a1), accentSoft: Color(hex: acc.soft),
            accent2: Color(hex: acc.a2), accent3: Color(hex: acc.a3))
    }
}

/// A Zekk Pet's colours, as 0xRRGGBB (ZekkPet.swift draws with them): body =
/// its colour's accent, belly = the accent mixed 55% toward white, outline =
/// 60% toward black, accent (antenna balls, stars) = its second colour. A
/// per-channel sRGB lerp rounded half up, in integers — what the web's
/// color-mix computes. A pet has ONE colour of its own, stored with it on the
/// server (PetDTO.color, picked by the inviter), so both people in the DM see
/// the same egg whatever Appearance theme each of them uses: it's built from
/// the pet's colour id (forPet), never from the viewer's theme (store.themeId)
/// or the static Theme.current. Only the pet art takes it; the pet card's
/// chrome (buttons, level bar, checkmarks) stays in the viewer's theme.
struct ZekkPetPalette: Equatable {
    let body: UInt32
    let belly: UInt32
    let outline: UInt32
    let accent: UInt32

    /// One pet colour: its id (what the server stores, and what PetDTO.color
    /// and a pet notice's metadata.petColor carry), its name in the egg
    /// picker, and its two accents.
    struct PetColor: Identifiable, Hashable {
        let id: String
        let label: String
        let a1: UInt32
        let a2: UInt32
    }

    /// Every pet colour, in the egg picker's order: a mirror of PET_COLOR_IDS
    /// and PET_PALETTES in packages/shared/src/pets.ts (Android carries the
    /// same table); keep them in sync. They're the six theme accent families
    /// (a1/a2 as in ThemePalette.accentSchemes), so a pet looks exactly as it
    /// did in that theme when pets followed the viewer's theme. Its own table
    /// rather than a lookup in accentSchemes: that one is the app themes'
    /// (palettes, app icons), and an id it doesn't know silently becomes
    /// "default" there. The ids are stored server-side: never rename or
    /// remove one (colours may only be added).
    static let colors: [PetColor] = [
        PetColor(id: "default",  label: "Abyssal",  a1: 0x3DD7EC, a2: 0x9D7BFF),
        PetColor(id: "sunset",   label: "Sunset",   a1: 0xFF8A3D, a2: 0xFFD13D),
        PetColor(id: "forest",   label: "Forest",   a1: 0x3D9BFF, a2: 0x4FDD8F),
        PetColor(id: "crimson",  label: "Crimson",  a1: 0xFF4D4D, a2: 0x9AA3B8),
        PetColor(id: "blossom",  label: "Blossom",  a1: 0xFF5FA2, a2: 0xFFB088),
        PetColor(id: "amethyst", label: "Amethyst", a1: 0xA855F7, a2: 0xF5B942),
    ]

    /// The order channelColorId picks from (the shared
    /// PET_CHANNEL_COLOR_ORDER). Frozen, and kept apart from `colors`, which
    /// may grow: it decides the colour of every pet nobody picked one for
    /// (the server backfilled the pets adopted before colours existed with
    /// it), so adding colours must not change it.
    private static let channelColorOrder = ["default", "sunset", "forest", "crimson", "blossom", "amethyst"]

    /// The colour with this id; nil for one this build doesn't know.
    static func color(_ id: String?) -> PetColor? {
        guard let id else { return nil }
        return colors.first { $0.id == id }
    }

    /// The DM's own pet colour (the shared petColorForChannel): its channel
    /// id mod 6 into the frozen order. Channel ids are positive decimal
    /// snowflakes; one that won't parse gets "default".
    static func channelColorId(_ channelId: String) -> String {
        guard let id = UInt64(channelId) else { return "default" }
        return channelColorOrder[Int(id % UInt64(channelColorOrder.count))]
    }

    /// The colour to draw a pet (or a pet notice) in (the shared
    /// resolvePetColor): its own colour when it's one this build knows;
    /// otherwise — none from an older server, a notice from before pets had
    /// colours, or a newer server's colour this build lacks — its DM's
    /// colour, which every app works out the same way, so both people (and
    /// every app) still agree.
    static func resolveColorId(_ color: String?, channelId: String) -> String {
        if let known = Self.color(color) { return known.id }
        return channelColorId(channelId)
    }

    /// The palette a pet is drawn in: forPet(pet.color, channelId: pet.channelId)
    /// — or, for a notice, its metadata.petColor and message.channelId.
    static func forPet(_ color: String?, channelId: String) -> ZekkPetPalette {
        forColor(resolveColorId(color, channelId: channelId))
    }

    /// The palette of a colour id (the first colour's for one this build
    /// doesn't know; forPet never passes one).
    static func forColor(_ id: String) -> ZekkPetPalette {
        let c = color(id) ?? colors[0]
        return ZekkPetPalette(body: c.a1,
                              belly: mix(c.a1, toward: 0xFF, percent: 55),
                              outline: mix(c.a1, toward: 0x00, percent: 60),
                              accent: c.a2)
    }

    /// The pet colour of an Appearance theme's family: the theme id without
    /// its "-oled" ("sunset-oled" → "sunset"), "oled" → "default", anything
    /// else this build doesn't know → "default". The egg picker starts on
    /// it, so the egg first shows in the inviter's own colours.
    static func colorId(forTheme themeId: String) -> String {
        if themeId == "oled" { return "default" }
        let family = themeId.hasSuffix("-oled") ? String(themeId.dropLast(5)) : themeId
        return color(family)?.id ?? "default"
    }

    /// `percent`% of the way from `rgb` toward `target` (0 or 255), per
    /// channel: (x·(100−p) + target·p + 50) / 100.
    static func mix(_ rgb: UInt32, toward target: UInt32, percent: UInt32) -> UInt32 {
        var out: UInt32 = 0
        for shift in [UInt32(16), 8, 0] {
            let x = (rgb >> shift) & 0xFF
            out |= ((x * (100 - percent) + target * percent + 50) / 100) << shift
        }
        return out
    }
}

/// A selectable theme, mirroring the web `THEMES` list.
struct ThemeOption: Identifiable, Hashable {
    let id: String
    let label: String
    let group: String
    let oled: Bool
}

/// The 12 themes offered in Settings (6 accent schemes × navy/OLED).
let ZKThemes: [ThemeOption] = [
    ThemeOption(id: "default",       label: "Abyssal Navy", group: "Default",          oled: false),
    ThemeOption(id: "oled",          label: "Abyssal OLED", group: "Default",          oled: true),
    ThemeOption(id: "sunset",        label: "Sunset",       group: "Orange & Yellow",  oled: false),
    ThemeOption(id: "sunset-oled",   label: "Sunset OLED",  group: "Orange & Yellow",  oled: true),
    ThemeOption(id: "forest",        label: "Forest",       group: "Green & Blue",     oled: false),
    ThemeOption(id: "forest-oled",   label: "Forest OLED",  group: "Green & Blue",     oled: true),
    ThemeOption(id: "crimson",       label: "Crimson",      group: "Red & Grey",       oled: false),
    ThemeOption(id: "crimson-oled",  label: "Crimson OLED", group: "Red & Grey",       oled: true),
    ThemeOption(id: "blossom",       label: "Blossom",      group: "Pink & Peach",     oled: false),
    ThemeOption(id: "blossom-oled",  label: "Blossom OLED", group: "Pink & Peach",     oled: true),
    ThemeOption(id: "amethyst",      label: "Amethyst",     group: "Purple & Gold",    oled: false),
    ThemeOption(id: "amethyst-oled", label: "Amethyst OLED",group: "Purple & Gold",    oled: true),
]

/// Design tokens. Surfaces, accents, and lines are driven by the active
/// `ThemePalette` (`Theme.current`); ink, danger, and status colors are
/// shared across every theme. Call sites keep using `Theme.bg0`,
/// `Theme.accent`, etc. unchanged — only the source of those values became
/// dynamic.
enum Theme {
    /// The active palette. Set via `AppStore.setTheme(_:)`; views re-render
    /// because that also publishes a change on the observed store.
    static var current: ThemePalette = ThemePalette.palette(for: "default")

    // ── Surfaces (palette-driven) ────────────────────────────────────────
    static var bg0: Color { current.bg0 }
    static var bg1: Color { current.bg1 }
    static var bg2: Color { current.bg2 }
    static var bg3: Color { current.bg3 }

    // ── Ink (text) — shared across themes ───────────────────────────────
    // Web Tailwind: ink.1 #f3f6fa, ink.2 #b5becf, ink.3 #7a849a. ink4 is
    // the web's CSS-var-only `--zk-ink-4` (oklch 0.42 0.030 265 → #454D5E),
    // used for disabled/ghost text.
    static let ink1 = Color(hex: 0xF3F6FA)
    static let ink2 = Color(hex: 0xB5BECF)
    static let ink3 = Color(hex: 0x7A849A)
    static let ink4 = Color(hex: 0x454D5E)

    // ── Accents (palette-driven) ─────────────────────────────────────────
    static var accent: Color { current.accent }
    static var accentSoft: Color { current.accentSoft }
    static var accent2: Color { current.accent2 }
    static var accent3: Color { current.accent3 }
    /// Web `--accent-glow`: the active accent at 45% alpha. Used for
    /// active-row outer glows, focus rings, selection tints.
    static var accentGlow: Color { current.accent.opacity(0.45) }

    // ── Borders ──────────────────────────────────────────────────────────
    /// Tailwind `border-line` — the dominant opaque divider (per-palette).
    static var line: Color { current.line }
    /// Web `--zk-line-soft` — oklch(0.50 0.05 265 / 0.18). Fixed across
    /// themes (the OLED blocks don't override it). Header strips etc.
    static var lineSoft: Color { current.lineSoft }
    static let zkLineSoft = Color(hex: 0x556380, alpha: 0.18)
    /// Web `--zk-line` — oklch(0.36 0.045 265 / 0.45). Glass-panel border.
    static let glassLine = Color(hex: 0x313D55, alpha: 0.45)
    /// Web `--zk-line-glow` — oklch(0.60 0.08 265 / 0.35). Hover edge glow.
    static let lineGlow = Color(hex: 0x697FB1, alpha: 0.35)

    // ── Status / semantic (web Tailwind defaults) ────────────────────────
    /// Destructive accents: web uses red-500 for solid/danger surfaces and
    /// red-400 for danger text on dark backgrounds.
    static let danger = Color(hex: 0xEF4444)      // red-500
    static let dangerSoft = Color(hex: 0xF87171)  // red-400
    /// Warning accent (amber-500) — used for reversible-but-serious actions
    /// like channel purge, distinct from the red destructive/delete accent.
    static let warning = Color(hex: 0xF59E0B)     // amber-500
    /// Presence dots: emerald-500 / amber-500 / red-500 / ink-3 on web.
    static let online = Color(hex: 0x10B981)      // emerald-500
    static let idle = Color(hex: 0xF59E0B)        // amber-500
    static let dnd = Color(hex: 0xEF4444)         // red-500
    static let offline = ink3
    /// Success text/badges (emerald-400 on web for "saved" toasts etc.).
    static let success = Color(hex: 0x34D399)     // emerald-400

    // ── Fixed plasma palette (web --zk-cyan/violet/… as rendered sRGB) ──
    // These are the raw oklch accents the web uses for glow/pulse effects
    // regardless of the active theme (zk-alien-pulse, gradient strokes).
    static let plasmaCyan = Color(hex: 0x00DDFF)     // oklch(0.82 0.16 215)
    static let plasmaViolet = Color(hex: 0xA688FF)   // oklch(0.72 0.20 290)
    static let plasmaMagenta = Color(hex: 0xF363DA)  // oklch(0.72 0.22 335)
    static let plasmaLime = Color(hex: 0x89F670)     // oklch(0.88 0.20 140)
    static let plasmaAmber = Color(hex: 0xFFB000)    // oklch(0.82 0.18 75)
    static let plasmaRose = Color(hex: 0xFF5B59)     // oklch(0.72 0.22 25)

    // ── Glass panel (web .glass / .glass-edge; fixed across themes) ─────
    /// Top/bottom stops of the .glass background gradient (55% alpha).
    static let glassTop = Color(hex: 0x232D45, alpha: 0.55)    // oklch(0.30 0.045 265 / .55)
    static let glassBottom = Color(hex: 0x0A1121, alpha: 0.55) // oklch(0.18 0.035 265 / .55)
    /// Top sheen highlight (oklch 0.95 0.02 265 at 6% → transparent 30%).
    static let glassSheen = Color(hex: 0xE8EFFC, alpha: 0.06)

    // ── Abyss ambient background (web .abyss; fixed across themes) ──────
    /// Corner aurora tints (already include the web's alpha).
    static let auroraViolet = Color(hex: 0x764BE5, alpha: 0.18)  // 12% 8%
    static let auroraCyan = Color(hex: 0x00B7E3, alpha: 0.16)    // 92% 14%
    static let auroraMagenta = Color(hex: 0xDA4BC3, alpha: 0.12) // 78% 92%
    static let auroraTeal = Color(hex: 0x00BEC1, alpha: 0.10)    // 18% 86%
    /// Starfield dot color (alpha applied per-dot: .6/.5/.4/.5/.4/.3).
    static let starlight = Color(hex: 0xEBEEF5)

    // ── Radii ladder (web --r-*) ─────────────────────────────────────────
    static let rXS: CGFloat = 4
    static let rSM: CGFloat = 6
    static let rMD: CGFloat = 10
    static let rLG: CGFloat = 14
    static let rXL: CGFloat = 20
    /// Web .zk-modal — fixed 14px radius for modals/large panels.
    static let rModal: CGFloat = 14
    /// Web .zk-squircle — 30% of the tile's size.
    static let squircleFraction: CGFloat = 0.30

    // ── Jump/flash highlight (web .jump-highlight / .message-flash) ─────
    /// Amber flash when jumping to a pinned/search-result message
    /// (rgba(245,158,11,0.25) at peak).
    static let jumpFlash = Color(hex: 0xF59E0B, alpha: 0.25)
}

extension View {
    /// Web `.row-active`: accent-tinted background, 2px leading accent
    /// rail-pin, and a soft outer glow. Apply to selected list rows
    /// (channels, DMs) on top of their base shape.
    func rowActive(_ active: Bool, cornerRadius: CGFloat = Theme.rSM) -> some View {
        self
            .background(
                RoundedRectangle(cornerRadius: cornerRadius, style: .continuous)
                    .fill(active ? Theme.accent.opacity(0.10) : Color.clear)
            )
            .overlay(alignment: .leading) {
                if active {
                    RoundedRectangle(cornerRadius: 1)
                        .fill(Theme.accent)
                        .frame(width: 2)
                }
            }
            .shadow(color: active ? Theme.accentGlow : .clear, radius: 6)
    }
}

// ── Typography (web: Space Grotesk UI / JetBrains Mono chrome) ──────────────
// The web rebases rem to 15px, so Tailwind's text-sm (0.875rem) = 13.1px,
// text-xs = 11.25px, text-base = 15px. The helpers below mirror those
// rendered sizes, mapping SwiftUI weights onto the four bundled static
// faces (400/500/600/700 — exactly the weights the web loads from Google
// Fonts). If the bundle is missing the fonts for any reason, everything
// falls back to the system face so the app never renders blank text.
private enum ZKFontBook {
    static let sansAvailable: Bool = UIFont(name: "SpaceGrotesk-Regular", size: 12) != nil
    static let monoAvailable: Bool = UIFont(name: "JetBrainsMono-Regular", size: 12) != nil

    static func sansName(for weight: Font.Weight) -> String {
        switch weight {
        case .black, .heavy, .bold: return "SpaceGrotesk-Bold"
        case .semibold: return "SpaceGrotesk-SemiBold"
        case .medium: return "SpaceGrotesk-Medium"
        default: return "SpaceGrotesk-Regular"
        }
    }

    static func monoName(for weight: Font.Weight) -> String {
        switch weight {
        case .black, .heavy, .bold, .semibold: return "JetBrainsMono-SemiBold"
        case .medium: return "JetBrainsMono-Medium"
        default: return "JetBrainsMono-Regular"
        }
    }

    /// Space Grotesk with the web's OpenType features enabled
    /// (font-feature-settings: 'ss01', 'cv11' — single-story 'a' and the
    /// disambiguated lowercase 'l'). Built via CTFont feature attributes;
    /// falls back to the plain face if descriptor creation fails.
    static func sansUIFont(size: CGFloat, weight: Font.Weight) -> UIFont? {
        guard let base = UIFont(name: sansName(for: weight), size: size) else { return nil }
        let features: [[UIFontDescriptor.FeatureKey: Any]] = [
            [.type: kStylisticAlternativesType, .selector: kStylisticAltOneOnSelector], // ss01
        ]
        let descriptor = base.fontDescriptor.addingAttributes([.featureSettings: features])
        return UIFont(descriptor: descriptor, size: size)
    }
}

extension Font {
    /// Space Grotesk — the web's UI face (with ss01 enabled, matching the
    /// web's font-feature-settings).
    static func zkSans(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        guard ZKFontBook.sansAvailable, let ui = ZKFontBook.sansUIFont(size: size, weight: weight) else {
            return .system(size: size, weight: weight)
        }
        return Font(ui)
    }

    /// JetBrains Mono — timestamps, code, channel-id chips ("machine voice").
    /// Web pairs it with +0.01em letter-spacing (apply `.tracking` at the
    /// call site via `Theme.monoTracking(size)` when it matters).
    static func zkMono(_ size: CGFloat, weight: Font.Weight = .regular) -> Font {
        guard ZKFontBook.monoAvailable else {
            return .system(size: size, weight: weight, design: .monospaced)
        }
        return .custom(ZKFontBook.monoName(for: weight), fixedSize: size)
    }
}

extension Theme {
    /// Web `.zk-mono` letter-spacing: 0.01em at the given font size.
    static func monoTracking(_ size: CGFloat) -> CGFloat { size * 0.01 }
    /// Web `.zk-cap` letter-spacing: 0.14em (uppercase mono labels).
    static func capTracking(_ size: CGFloat) -> CGFloat { size * 0.14 }
}

/// The two smiley glyphs by name. Since iOS 26 the system symbols ship a
/// dark-appearance version of "face.smiling" and of "face.smiling.inverse"
/// that swaps them: in dark appearance "face.smiling" draws the solid disc and
/// "face.smiling.inverse" the line drawing ("face.smiling.fill" is an alias
/// of ".inverse"). In light appearance, and on every iOS before 26, it is the
/// other way round. A plain "face.smiling" therefore turned into a heavy blob
/// beside the outline icons around it (the attach menu's Sticker row, the
/// composer's emoji button), and a ".fill" badge into a thin outline.
///
/// These names are right only because the app is dark-only (ZekktrisApp's
/// `.preferredColorScheme(.dark)`). A view that can render in light
/// appearance on iOS 26+ must pick by its color scheme as well.
enum SmileySymbol {
    /// The line-drawn smiley, for rows of outline icons.
    static var outline: String {
        if #available(iOS 26.0, *) { return "face.smiling.inverse" }
        return "face.smiling"
    }

    /// The solid smiley, for filled glyphs such as badges.
    static var filled: String {
        if #available(iOS 26.0, *) { return "face.smiling" }
        return "face.smiling.inverse"
    }
}
