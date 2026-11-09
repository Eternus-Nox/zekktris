import AppIntents
import WidgetKit

// MARK: - Friend (a recent DM peer you pick when editing a widget)

/// A pickable friend, backed by the recent-DM list the app publishes to the
/// App Group. Used as the configurable parameter of the Poke + Open-DM widgets
/// so each widget targets ONE person (no on-widget list).
struct FriendEntity: AppEntity, Identifiable {
    let id: String          // DM channel id
    let name: String
    let avatarURL: String?

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Friend")
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    static var defaultQuery = FriendQuery()
}

struct FriendQuery: EntityQuery {
    func entities(for identifiers: [FriendEntity.ID]) async throws -> [FriendEntity] {
        WidgetBridge.recentDMs()
            .filter { identifiers.contains($0.id) }
            .map { FriendEntity(id: $0.id, name: $0.name, avatarURL: $0.avatarURL) }
    }
    func suggestedEntities() async throws -> [FriendEntity] {
        WidgetBridge.recentDMs().map { FriendEntity(id: $0.id, name: $0.name, avatarURL: $0.avatarURL) }
    }
}

// MARK: - Poke style (the "customized" part of the poke widget)

enum WidgetPokeType: String, AppEnum {
    case poke, heart, wave, like, fire

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Poke")
    static var caseDisplayRepresentations: [WidgetPokeType: DisplayRepresentation] = [
        .poke:  "👉 Poke",
        .heart: "❤️ Heart",
        .wave:  "👋 Wave",
        .like:  "👍 Like",
        .fire:  "🔥 Fire",
    ]

    var emoji: String {
        switch self {
        case .poke:  return "👉"
        case .heart: return "❤️"
        case .wave:  return "👋"
        case .like:  return "👍"
        case .fire:  return "🔥"
        }
    }
}

// MARK: - Configuration intents (edit the widget → choose who + how)

struct PokeConfigIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Quick Poke"
    static var description = IntentDescription("Poke a chosen friend with a single tap.")
    @Parameter(title: "Friend") var friend: FriendEntity?
    @Parameter(title: "Poke", default: .poke) var pokeType: WidgetPokeType
}

struct MessageConfigIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Open DM"
    static var description = IntentDescription("Open a chosen friend's direct messages.")
    @Parameter(title: "Friend") var friend: FriendEntity?
}

// MARK: - Action intent (the one-tap poke; runs WITHOUT launching the app)

struct QuickPokeIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Poke"
    static var description = IntentDescription("Send a poke to a friend.")
    static var openAppWhenRun = false

    @Parameter(title: "Channel") var channelId: String
    @Parameter(title: "Poke") var pokeType: String

    init() {}
    init(channelId: String, pokeType: String = "poke") {
        self.channelId = channelId
        self.pokeType = pokeType
    }

    func perform() async throws -> some IntentResult {
        if !channelId.isEmpty {
            await WidgetPokeAPI.poke(channelId: channelId, pokeType: pokeType)
        }
        return .result()
    }
}

/// Minimal POST for the widget — mirrors the watch's WatchPokeAPI. Authorized
/// by WidgetBridge.perform: the long-lived intent token when the app has
/// minted one, else the access-token copy, which has no refresh here (an
/// expired one just fails and the app re-publishes on its next foreground).
enum WidgetPokeAPI {
    static func poke(channelId: String, pokeType: String) async {
        guard let url = URL(string: "\(Config.apiBaseURL)/channels/\(channelId)/poke") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["pokeType": pokeType])
        _ = await WidgetBridge.perform(req)
    }
}
