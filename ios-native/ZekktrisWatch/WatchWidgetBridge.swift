import Foundation

/// One DM peer surfaced in the watch widget / complication.
struct WatchWidgetDM: Codable, Identifiable, Hashable {
    let id: String
    let name: String
    let streak: Int
    /// Whether the DM is end-to-end encrypted. The Siri extension needs it to
    /// know whether to encrypt — and must refuse, not guess, when it is nil
    /// (written by a build that predated the field). Optional for that reason.
    var e2ee: Bool? = nil
    /// Names Siri matches against, alongside `name`.
    var username: String? = nil
    var contactName: String? = nil
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

    // ── Per-DM E2EE keys, for the Siri extension ────────────────────────────

    private static let keyPrefix = "watch.e2ee."
    private static let keyIndexKey = "watch.e2ee.index"

    /// Replace the stored keys with exactly `keys` (channel id → base64 key).
    /// Keys for DMs that dropped out of the list are deleted rather than left
    /// behind, so a key lives on the watch only while its DM is one of the
    /// conversations the phone relays.
    static func publishKeys(_ keys: [String: String]) {
        let previous = Set(defaults?.stringArray(forKey: keyIndexKey) ?? [])
        for gone in previous.subtracting(keys.keys) { keychain.delete(keyPrefix + gone) }
        for (channelId, b64) in keys { keychain.set(b64, for: keyPrefix + channelId) }
        defaults?.set(Array(keys.keys), forKey: keyIndexKey)
    }

    /// The 32-byte key for an encrypted DM, or nil when the phone had none to
    /// relay (the conversation is locked there too).
    static func e2eeKey(forChannel channelId: String) -> Data? {
        guard let b64 = keychain.get(keyPrefix + channelId),
              let key = Data(base64Encoded: b64), key.count == 32 else { return nil }
        return key
    }
}
