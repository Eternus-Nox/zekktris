import Foundation

/// Poke/nudge variants — emoji + label. Mirror of the server `POKE_VARIANTS`
/// (@zekktris/db), the iOS `PokeVariant` (Models.swift), and the web table.
/// Duplicated deliberately (the watch target shares no code with the iOS app);
/// keep all four in sync. The `rawValue` is the `pokeType` the API expects.
enum PokeVariant: String, CaseIterable, Identifiable {
    case poke, heart, wave, like, fire
    var id: String { rawValue }
    var emoji: String {
        switch self {
        case .poke: return "👉"
        case .heart: return "❤️"
        case .wave: return "👋"
        case .like: return "👍"
        case .fire: return "🔥"
        }
    }
    var label: String {
        switch self {
        case .poke: return "Poke"
        case .heart: return "Heart"
        case .wave: return "Wave"
        case .like: return "Like"
        case .fire: return "Fire"
        }
    }
}
