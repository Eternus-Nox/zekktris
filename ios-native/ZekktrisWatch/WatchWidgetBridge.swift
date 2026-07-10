import Foundation

/// One DM peer surfaced in the watch widget / complication.
struct WatchWidgetDM: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let streak: Int
}

/// Bridges the watch app and its widget extension (separate processes) over the
/// watch-side App Group. The app publishes the DM list + API base URL (to
/// app-group `UserDefaults`) and the auth token (to the app-group keychain);
/// the widget reads them to poke / open DMs on its own — so a complication on
/// the watch face works without the app running.
enum WatchWidgetBridge {
    static let dmsKey = "watch.widget.dms"
    static let baseURLKey = "watch.widget.baseURL"
    static let tokenKey = "watch.widget.token"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: AppGroupConfig.identifier) }
    private static var keychain: KeychainStore { KeychainStore(accessGroup: AppGroupConfig.identifier) }

    static func publish(dms: [WatchWidgetDM], baseURL: String?, token: String?) {
        if let data = try? JSONEncoder().encode(dms) { defaults?.set(data, forKey: dmsKey) }
        defaults?.set(baseURL, forKey: baseURLKey)
        if let token, !token.isEmpty { keychain.set(token, for: tokenKey) } else { keychain.delete(tokenKey) }
    }

    static func dms() -> [WatchWidgetDM] {
        guard let data = defaults?.data(forKey: dmsKey),
              let list = try? JSONDecoder().decode([WatchWidgetDM].self, from: data) else { return [] }
        return list
    }
    static func baseURL() -> String? { defaults?.string(forKey: baseURLKey) }
    static func token() -> String? { keychain.get(tokenKey) }
}
