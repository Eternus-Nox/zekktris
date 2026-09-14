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

    private static var map: [String: String] {
        (defaults?.dictionary(forKey: key) as? [String: String]) ?? [:]
    }

    /// The Contacts identifier for a Zekktris user id, if one was linked.
    static func contactId(forUserId userId: String) -> String? { map[userId] }

    static func set(contactId: String, forUserId userId: String) {
        var next = map
        next[userId] = contactId
        defaults?.set(next, forKey: key)
    }

    static func clear(userId: String) {
        var next = map
        next.removeValue(forKey: userId)
        defaults?.set(next, forKey: key)
    }
}
