import SwiftUI

extension Color {
    /// Build a Color from a 0xRRGGBB hex literal.
    init(hex: UInt32, alpha: Double = 1) {
        let r = Double((hex >> 16) & 0xFF) / 255.0
        let g = Double((hex >> 8) & 0xFF) / 255.0
        let b = Double(hex & 0xFF) / 255.0
        self.init(.sRGB, red: r, green: g, blue: b, opacity: alpha)
    }
}

/// A full set of themeable colors. Mirrors the web app's per-theme CSS
/// variables: every theme picks one of two background ladders (navy or
/// OLED black) and one of six accent trios. Ink/danger/online are shared
/// across all themes, so they live on `Theme` directly rather than here.
struct ThemePalette {
    let bg0, bg1, bg2, bg3: Color
    let line, lineSoft: Color
    let accent, accentSoft, accent2, accent3: Color

    struct Accents { let a1, a2, a3, soft: UInt32 }

    /// Accent trios, keyed by the base scheme name (matching the web).
    static let accentSchemes: [String: Accents] = [
        "default":  Accents(a1: 0x3DD7EC, a2: 0x9D7BFF, a3: 0xEC5FB5, soft: 0x2DB6C8),
        "sunset":   Accents(a1: 0xFF8A3D, a2: 0xFFD13D, a3: 0xFF7A7A, soft: 0xE0702A),
        "forest":   Accents(a1: 0x3D9BFF, a2: 0x4FDD8F, a3: 0x3DD8C0, soft: 0x2E7DD6),
        "crimson":  Accents(a1: 0xFF4D4D, a2: 0x9AA3B8, a3: 0xFF8080, soft: 0xD63A3A),
        "blossom":  Accents(a1: 0xFF5FA2, a2: 0xFFB088, a3: 0xFF9ECF, soft: 0xE04A88),
        "amethyst": Accents(a1: 0xA855F7, a2: 0xF5B942, a3: 0xD8A7FF, soft: 0x8B3FE0),
    ]

    /// Resolve a theme id like "sunset-oled" into a concrete palette.
    static func palette(for id: String) -> ThemePalette {
        let oled = (id == "oled") || id.hasSuffix("-oled")
        let schemeKey: String = {
            if id == "oled" || id == "default" { return "default" }
            return id.replacingOccurrences(of: "-oled", with: "")
        }()
        let acc = accentSchemes[schemeKey] ?? accentSchemes["default"]!
        if oled {
            return ThemePalette(
                bg0: Color(hex: 0x000000), bg1: Color(hex: 0x06080C),
                bg2: Color(hex: 0x0D1017), bg3: Color(hex: 0x161B26),
                line: Color(hex: 0x242B3C, alpha: 0.6), lineSoft: Color(hex: 0x242B3C, alpha: 0.3),
                accent: Color(hex: acc.a1), accentSoft: Color(hex: acc.soft),
                accent2: Color(hex: acc.a2), accent3: Color(hex: acc.a3))
        }
        return ThemePalette(
            bg0: Color(hex: 0x0A0F1C), bg1: Color(hex: 0x0E1422),
            bg2: Color(hex: 0x131A2A), bg3: Color(hex: 0x1C2438),
            line: Color(hex: 0x37425E, alpha: 0.45), lineSoft: Color(hex: 0x49567A, alpha: 0.20),
            accent: Color(hex: acc.a1), accentSoft: Color(hex: acc.soft),
            accent2: Color(hex: acc.a2), accent3: Color(hex: acc.a3))
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
/// `ThemePalette` (`Theme.current`); ink, danger, and online are shared
/// across every theme. Call sites keep using `Theme.bg0`, `Theme.accent`,
/// etc. unchanged — only the source of those values became dynamic.
enum Theme {
    /// The active palette. Set via `AppStore.setTheme(_:)`; views re-render
    /// because that also publishes a change on the observed store.
    static var current: ThemePalette = ThemePalette.palette(for: "default")

    // Surfaces (palette-driven)
    static var bg0: Color { current.bg0 }
    static var bg1: Color { current.bg1 }
    static var bg2: Color { current.bg2 }
    static var bg3: Color { current.bg3 }

    // Ink (text) — shared across themes
    static let ink1 = Color(hex: 0xF3F6FA)
    static let ink2 = Color(hex: 0xB0BAC9)
    static let ink3 = Color(hex: 0x6F7B91)
    static let ink4 = Color(hex: 0x4A5468)

    // Accents (palette-driven)
    static var accent: Color { current.accent }
    static var accentSoft: Color { current.accentSoft }
    static var accent2: Color { current.accent2 }
    static var accent3: Color { current.accent3 }

    // Borders (palette-driven)
    static var line: Color { current.line }
    static var lineSoft: Color { current.lineSoft }

    // Shared status colors
    static let danger = Color(hex: 0xFF5C5C)
    static let online = Color(hex: 0x3BA55D)
}
