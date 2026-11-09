import Foundation

/// One DM contact surfaced in the Home/Lock-Screen widget.
struct WidgetDM: Codable, Identifiable, Hashable {
    let id: String       // DM channel id
    let name: String
    let streak: Int      // consecutive-day streak (0 = none)
    /// Fully-qualified avatar URL for the DM peer (nil if none) — the widget
    /// fetches + caches it to show the real profile picture. Optional so older
    /// published payloads (pre-avatar) still decode.
    var avatarURL: String?
    /// Whether this conversation is end-to-end encrypted. The Siri extension
    /// needs it to decide between sending the text and encrypting it first —
    /// and, when it can't find the key, to refuse rather than put plaintext in
    /// an encrypted DM.
    var isE2EE: Bool?
    /// The peer's USER id (the channel id is `id`). Lets Siri match a donated
    /// `zekktris:<userId>` person handle back to this conversation.
    var peerUserId: String?
    /// The peer's @username. `name` is their DISPLAY name, and someone talking
    /// to Siri may say either — so both are matched against.
    var peerUsername: String?
    /// The name on the Contacts card this account was linked to, when there is
    /// one. This is what a person actually SAYS — "Sam Rivera" rather than
    /// "SRivera1337" — so it is matched ahead of everything else.
    var contactName: String?
}

/// Data shared between the Zekktris app and its WidgetKit extension. The widget
/// runs in a SEPARATE process, so it can't read the app's in-memory state — the
/// app publishes the recent DM list (to the app-group `UserDefaults`) and the
/// auth token (to the app-group keychain) here, and the widget reads them back
/// to render contacts and fire a one-tap poke.
///
/// Provisioning: relies on the existing `group.com.zekktris.native` App Group
/// (see `AppGroupConfig`) being enabled on the widget target too — XcodeGen
/// declares the entitlement; it must also be on the App ID in the portal.
enum WidgetBridge {
    static let recentDMsKey = "widget.recentDMs"
    /// Keychain account for the token COPY the widget reads (kept distinct from
    /// the app's own token entry so clearing one never disturbs the other).
    static let tokenKey = "widget.authToken"
    /// Keychain accounts for the INTENT token and when it expires (ISO-8601,
    /// as the server sent it). The copy above is the 15-minute access token,
    /// and nothing outside the app can refresh it, so Siri and the widget
    /// failed once the app had been idle that long. The intent token is what
    /// the server mints for exactly these processes: 30 days, good only for
    /// the DM list, a DM send and a poke, and dead the moment the session is.
    /// The app keeps it fresh (AppStore.ensureIntentToken); an older server
    /// has no such token, and then only the copy above is sent.
    static let intentTokenKey = "widget.intentToken"
    static let intentTokenExpiresAtKey = "widget.intentTokenExpiresAt"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: AppGroupConfig.identifier)
    }
    private static var keychain: KeychainStore {
        KeychainStore(accessGroup: AppGroupConfig.identifier)
    }

    /// Publish from the app (cheap + idempotent; call whenever the DM list or
    /// token changes). A nil/empty token clears the stored credential so a
    /// logged-out widget can't poke.
    static func publish(dms: [WidgetDM], token: String?) {
        if let data = try? JSONEncoder().encode(dms) {
            defaults?.set(data, forKey: recentDMsKey)
        }
        if let token, !token.isEmpty {
            keychain.set(token, for: tokenKey)
        } else {
            keychain.delete(tokenKey)
        }
    }

    static func recentDMs() -> [WidgetDM] {
        guard let data = defaults?.data(forKey: recentDMsKey),
              let list = try? JSONDecoder().decode([WidgetDM].self, from: data) else { return [] }
        return list
    }

    static func token() -> String? { keychain.get(tokenKey) }

    /// Store the intent token, or with nil delete it (sign-out, an older
    /// server). Written by the app; an extension only ever deletes one the
    /// server has refused (see `perform`).
    static func publishIntentToken(_ token: String?, expiresAt: String?) {
        if let token, !token.isEmpty {
            keychain.set(token, for: intentTokenKey)
            if let expiresAt, !expiresAt.isEmpty {
                keychain.set(expiresAt, for: intentTokenExpiresAtKey)
            } else {
                keychain.delete(intentTokenExpiresAtKey)
            }
        } else {
            keychain.delete(intentTokenKey)
            keychain.delete(intentTokenExpiresAtKey)
        }
    }

    static func intentToken() -> String? {
        guard let t = keychain.get(intentTokenKey), !t.isEmpty else { return nil }
        return t
    }

    /// When the intent token expires, exactly as the server wrote it.
    static func intentTokenExpiresAt() -> String? { keychain.get(intentTokenExpiresAtKey) }

    /// The same, as a date. nil when there is no token or the stamp can't be
    /// read, which the app treats as "mint a new one".
    static func intentTokenExpiry() -> Date? {
        guard let stamp = intentTokenExpiresAt() else { return nil }
        // The server writes Date.toISOString(), which has milliseconds;
        // accept the plain form too.
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: stamp) { return date }
        iso.formatOptions = [.withInternetDateTime]
        return iso.date(from: stamp)
    }

    /// The `Authorization` values an extension can send, best first: the
    /// intent token, then the access-token copy. Empty means signed out, or
    /// that this process can't read the App Group.
    static func authorizations() -> [String] {
        var out: [String] = []
        if let t = intentToken() { out.append("Intent \(t)") }
        if let t = token(), !t.isEmpty { out.append("Bearer \(t)") }
        return out
    }

    /// One request from an extension or widget, authorized with the best
    /// credential the App Group holds. An intent token answered 401 (expired,
    /// revoked, or a server that no longer knows the scheme) is retried once
    /// with the Bearer copy, and deleted, so the app mints a fresh one on its
    /// next foreground instead of keeping a dead one until it nears expiry.
    /// nil means there was no credential, or the request never completed.
    static func perform(_ request: URLRequest) async -> (data: Data, response: HTTPURLResponse)? {
        let auths = authorizations()
        guard let first = auths.first,
              let answer = await attempt(request, authorization: first) else { return nil }
        guard answer.response.statusCode == 401, first.hasPrefix("Intent ") else { return answer }
        // Only the token that was refused: the app may have stored a new one
        // while this request was out.
        if let stored = intentToken(), first == "Intent \(stored)" {
            publishIntentToken(nil, expiresAt: nil)
        }
        guard auths.count > 1, let retry = await attempt(request, authorization: auths[1]) else {
            return answer
        }
        return retry
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
}

/// Which Contacts card a Zekktris account was linked to.
///
/// Siri ties a conversation to a person's CARD through
/// `INPerson.contactIdentifier` — that is the documented way to tell it "this
/// account is that contact". Without it, an instant-message entry on the card
/// is just text: Siri hears "Sam Rivera", looks for a way to reach Sam
/// Rivera, finds no phone number and says it has no address for him.
///
/// Lives in the App Group so the Siri extension can stamp the same identifier
/// on the recipients it resolves. Written by ContactsLink (app side only —
/// this file is compiled into extensions that must not link ContactsUI).
enum ContactLinks {
    private static let key = "contacts.userToCard"

    private static var defaults: UserDefaults? {
        UserDefaults(suiteName: AppGroupConfig.identifier)
    }

    /// userId → ["id": contact identifier, "name": what the card is called].
    /// Older builds stored a bare identifier string; those still read.
    private static var map: [String: Any] {
        (defaults?.dictionary(forKey: key)) ?? [:]
    }

    private static func entry(_ userId: String) -> [String: String]? {
        switch map[userId] {
        case let dict as [String: String]: return dict
        case let id as String: return ["id": id]   // written before names were kept
        default: return nil
        }
    }

    /// The Contacts identifier for a Zekktris user id, if one was linked.
    static func contactId(forUserId userId: String) -> String? { entry(userId)?["id"] }

    /// What that card is CALLED — the whole point of linking. Siri matches a
    /// spoken name against the names on our donated conversations, so this is
    /// what makes "message Sam Rivera on Zekktris" resolve, with or without
    /// an instant-message entry on the card.
    static func contactName(forUserId userId: String) -> String? {
        entry(userId)?["name"]?.isEmpty == false ? entry(userId)?["name"] : nil
    }

    static func set(contactId: String, contactName: String?, forUserId userId: String) {
        var next = map
        var value = ["id": contactId]
        if let contactName, !contactName.isEmpty { value["name"] = contactName }
        next[userId] = value
        defaults?.set(next, forKey: key)
    }

    static func clear(userId: String) {
        var next = map
        next.removeValue(forKey: userId)
        defaults?.set(next, forKey: key)
    }
}
