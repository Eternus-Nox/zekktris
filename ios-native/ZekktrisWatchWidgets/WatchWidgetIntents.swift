import AppIntents
import WidgetKit

// MARK: - Friend picker (backed by the watch App Group)

struct WatchFriendEntity: AppEntity, Identifiable {
    let id: String          // DM channel id
    let name: String

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Friend")
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    static var defaultQuery = WatchFriendQuery()
}

struct WatchFriendQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [WatchFriendEntity] {
        WatchWidgetBridge.dms().filter { identifiers.contains($0.id) }
            .map { WatchFriendEntity(id: $0.id, name: $0.name) }
    }
    func suggestedEntities() async throws -> [WatchFriendEntity] {
        WatchWidgetBridge.dms().map { WatchFriendEntity(id: $0.id, name: $0.name) }
    }
}

// MARK: - Poke style

enum WatchWidgetPokeType: String, AppEnum {
    case poke, heart, wave, like, fire
    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Poke")
    static var caseDisplayRepresentations: [WatchWidgetPokeType: DisplayRepresentation] = [
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

// MARK: - Configuration intents (edit the complication → choose who + how)

struct WatchPokeConfigIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Quick Poke"
    static var description = IntentDescription("Poke a chosen friend with one tap.")
    @Parameter(title: "Friend") var friend: WatchFriendEntity?
    @Parameter(title: "Poke", default: .poke) var pokeType: WatchWidgetPokeType
}

struct WatchMessageConfigIntent: WidgetConfigurationIntent {
    static var title: LocalizedStringResource = "Open DM"
    static var description = IntentDescription("Open a chosen friend's chat on the watch.")
    @Parameter(title: "Friend") var friend: WatchFriendEntity?
}

// MARK: - Action intent (one-tap poke; runs without opening the app)

struct WatchPokeActionIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Poke"
    static var openAppWhenRun = false

    @Parameter(title: "Channel") var channelId: String
    @Parameter(title: "Poke") var pokeType: String

    init() {}
    init(channelId: String, pokeType: String = "poke") {
        self.channelId = channelId
        self.pokeType = pokeType
    }

    func perform() async throws -> some IntentResult {
        if !channelId.isEmpty, let token = WatchWidgetBridge.token(), let base = WatchWidgetBridge.baseURL() {
            await WatchWidgetPokeAPI.poke(baseURL: base, token: token, channelId: channelId, pokeType: pokeType)
        }
        return .result()
    }
}

enum WatchWidgetPokeAPI {
    static func poke(baseURL: String, token: String, channelId: String, pokeType: String) async {
        guard let url = URL(string: "\(baseURL)/channels/\(channelId)/poke") else { return }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["pokeType": pokeType])
        _ = try? await URLSession.shared.data(for: req)
    }
}
