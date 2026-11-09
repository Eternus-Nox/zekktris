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

/// One entry of the phone's Siri directory (context key "siriDirectory"):
/// EVERY 1:1 DM, not only the 12 the watch can poke, so Siri on the wrist can
/// reach anyone the phone can. Mirror of the phone's WatchDirectoryEntry
/// (WatchSync.swift). It never carries a key — keys ride only with the poke
/// targets — so an encrypted DM that is in the directory alone still refuses
/// to send. Everything but the id and name is optional so one odd entry can't
/// fail the whole list, and a missing `e2ee` is unknown, which refuses.
struct WatchDirectoryEntry: Codable, Hashable {
    let channelId: String
    var userId: String? = nil
    let name: String
    var username: String? = nil
    var contactName: String? = nil
    var e2ee: Bool? = nil
}

/// Bridges the watch app and its widget extension (separate processes) over the
/// watch-side App Group. The app publishes the DM list + API base URL (to
/// app-group `UserDefaults`) and the auth tokens (to the app-group keychain);
/// the widget reads them to poke / open DMs on its own — so a complication on
/// the watch face works without the app running. The two Siri extensions read
/// the same items, plus the Siri directory and the per-DM keys.
enum WatchWidgetBridge {
    static let dmsKey = "watch.widget.dms"
    static let baseURLKey = "watch.widget.baseURL"
    static let tokenKey = "watch.widget.token"
    /// Keychain accounts for the INTENT token and when it expires (ISO-8601,
    /// as the server sent it). The token above is the phone's 15-minute access
    /// token, and nothing on the watch can refresh it, so Siri and the Poke
    /// complication failed once the phone app had been idle that long. The
    /// intent token lives 30 days, opens only the DM list, a DM send and a
    /// poke, and dies with the session. An older server has none, and then
    /// only the access token is sent.
    static let intentTokenKey = "watch.widget.intentToken"
    static let intentTokenExpiresAtKey = "watch.widget.intentTokenExpiresAt"
    /// The Siri directory (see WatchDirectoryEntry). Names only, so it sits in
    /// `UserDefaults` beside the DM list rather than in the keychain.
    static let directoryKey = "watch.widget.siriDirectory"

    private static var defaults: UserDefaults? { UserDefaults(suiteName: AppGroupConfig.identifier) }
    private static var keychain: KeychainStore { KeychainStore(accessGroup: AppGroupConfig.identifier) }

    static func publish(baseURL: String?, token: String?) {
        defaults?.set(baseURL, forKey: baseURLKey)
        store(token, for: tokenKey)
    }

    static func publishDMs(_ dms: [WatchWidgetDM]) {
        if let data = try? JSONEncoder().encode(dms) { defaults?.set(data, forKey: dmsKey) }
    }

    /// Store the intent token, or with nil delete it (sign-out, an older server).
    static func publishIntentToken(_ token: String?, expiresAt: String?) {
        if let token, !token.isEmpty {
            store(token, for: intentTokenKey)
            store(expiresAt, for: intentTokenExpiresAtKey)
        } else {
            keychain.delete(intentTokenKey)
            keychain.delete(intentTokenExpiresAtKey)
        }
    }

    static func publishDirectory(_ entries: [WatchDirectoryEntry]) {
        if let data = try? JSONEncoder().encode(entries) { defaults?.set(data, forKey: directoryKey) }
    }

    /// Write a keychain item, or delete it for nil / empty — but only when it
    /// changed. A write is a delete then an add, and the app now applies the
    /// phone's context in the background as well, so a Siri extension reading
    /// in between would find no token (or no key) at all.
    private static func store(_ value: String?, for account: String) {
        guard let value, !value.isEmpty else {
            keychain.delete(account)
            return
        }
        if keychain.get(account) != value { keychain.set(value, for: account) }
    }

    static func dms() -> [WatchWidgetDM] {
        guard let data = defaults?.data(forKey: dmsKey),
              let list = try? JSONDecoder().decode([WatchWidgetDM].self, from: data) else { return [] }
        return list
    }
    static func baseURL() -> String? { defaults?.string(forKey: baseURLKey) }
    static func token() -> String? { keychain.get(tokenKey) }

    static func intentToken() -> String? {
        guard let t = keychain.get(intentTokenKey), !t.isEmpty else { return nil }
        return t
    }

    /// When the intent token expires, exactly as the server wrote it.
    static func intentTokenExpiresAt() -> String? { keychain.get(intentTokenExpiresAtKey) }

    static func directory() -> [WatchDirectoryEntry] {
        guard let data = defaults?.data(forKey: directoryKey),
              let list = try? JSONDecoder().decode([WatchDirectoryEntry].self, from: data) else { return [] }
        return list
    }

    /// Every DM Siri on the wrist can address: the poke targets first (they
    /// are the most recent, and the only ones with keys), then the rest of the
    /// directory. Both Siri paths match against this, not `dms()` alone, which
    /// left anyone outside the 12 most recent conversations unreachable.
    static func siriDMs() -> [WatchWidgetDM] {
        var out = dms()
        var seen = Set(out.map(\.id))
        for entry in directory() where seen.insert(entry.channelId).inserted {
            out.append(WatchWidgetDM(
                id: entry.channelId, name: entry.name, streak: 0, e2ee: entry.e2ee,
                username: entry.username?.isEmpty == false ? entry.username : nil,
                contactName: entry.contactName?.isEmpty == false ? entry.contactName : nil,
            ))
        }
        return out
    }

    // ── Authorization, for every request the watch makes ────────────────────

    /// The `Authorization` values a request can carry, best first: the intent
    /// token, then the access token. Empty means signed out or never synced.
    static func authorizations(intentToken: String?, accessToken: String?) -> [String] {
        var out: [String] = []
        if let t = intentToken, !t.isEmpty { out.append("Intent \(t)") }
        if let t = accessToken, !t.isEmpty { out.append("Bearer \(t)") }
        return out
    }

    /// The same, from what the watch app last published — for the Siri
    /// extensions and the complication, which run without it.
    static func authorizations() -> [String] {
        authorizations(intentToken: intentToken(), accessToken: token())
    }

    /// One request, sent with the first of `authorizations`. An intent token
    /// answered 401 (expired, revoked, or a server that doesn't know the
    /// scheme) is retried once with the next, the access token. A 401 comes
    /// back before the server does anything, so the retry can't send a
    /// message twice. nil means there was no credential, or the request never
    /// completed.
    static func perform(
        _ request: URLRequest, authorizations: [String]
    ) async -> (data: Data, response: HTTPURLResponse)? {
        guard let first = authorizations.first,
              let answer = await attempt(request, authorization: first) else { return nil }
        guard answer.response.statusCode == 401, first.hasPrefix("Intent "), authorizations.count > 1 else {
            return answer
        }
        return await attempt(request, authorization: authorizations[1]) ?? answer
    }

    private static func attempt(
        _ request: URLRequest, authorization: String
    ) async -> (data: Data, response: HTTPURLResponse)? {
        var req = request
        req.setValue(authorization, forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse else { return nil }
        return (data, http)
    }

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
        for (channelId, b64) in keys { store(b64, for: keyPrefix + channelId) }
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
