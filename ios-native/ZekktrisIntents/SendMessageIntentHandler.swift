import Foundation
import Intents
import os.log

/// Console.app / Xcode: filter on subsystem `com.zekktris.native.intents`.
/// Every refusal logs WHICH precondition failed, because the symptom Siri
/// shows the user ("you'll have to continue in the app") is the same for all
/// of them.
private let siriLog = Logger(subsystem: "com.zekktris.native.intents", category: "siri")

/// Resolve + send for Siri's `INSendMessageIntent`.
///
/// Everything it needs already exists because the app publishes it for the
/// widget and the watch: the recent DM list and the auth token live in the App
/// Group (see WidgetShared.swift), and the per-conversation E2EE keys live in
/// the app-group keychain (the same place the Notification Service Extension
/// reads them to decrypt previews).
///
/// THE RULE THAT MATTERS: never send plaintext into an encrypted conversation.
/// If the DM is E2EE and this process cannot find its key, the send is refused
/// with `failureRequiringAppLaunch` so Siri hands the user to the app instead —
/// the same choice the notification quick-reply makes.
final class SendMessageIntentHandler: NSObject, INSendMessageIntentHandling {

    // MARK: Resolution

    func resolveRecipients(
        for intent: INSendMessageIntent,
        with completion: @escaping ([INSendMessageRecipientResolutionResult]) -> Void
    ) {
        let people = intent.recipients ?? []
        guard !people.isEmpty else {
            completion([INSendMessageRecipientResolutionResult.needsValue()])
            return
        }
        var results: [INSendMessageRecipientResolutionResult] = []
        for person in people {
            let matches = SiriDirectory.matches(for: person)
            if matches.isEmpty {
                // Nobody by that name in the conversations this device knows
                // about. `noValidHandle` is what makes Siri say it can't find
                // them, rather than silently sending to the wrong person.
                results.append(.unsupported(forReason: .noValidHandle))
            } else if matches.count == 1 {
                results.append(.success(with: SiriDirectory.person(for: matches[0])))
            } else {
                results.append(.disambiguation(with: matches.map { SiriDirectory.person(for: $0) }))
            }
        }
        completion(results)
    }

    func resolveContent(
        for intent: INSendMessageIntent,
        with completion: @escaping (INStringResolutionResult) -> Void
    ) {
        let text = (intent.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        completion(text.isEmpty ? .needsValue() : .success(with: text))
    }

    func confirm(
        intent: INSendMessageIntent,
        completion: @escaping (INSendMessageIntentResponse) -> Void
    ) {
        // No token means signed out (or the app has never published one) —
        // say so now rather than after Siri has read the message back.
        let signedIn = (WidgetBridge.token()?.isEmpty == false)
        if !signedIn {
            // The app publishes the token to the app-group keychain on sign-in,
            // on foreground and on every refresh. Missing here means either the
            // user is signed out, or this extension cannot read the App Group —
            // check that `group.com.zekktris.native` is on the App ID for
            // com.zekktris.native.intents, not just on the app's.
            siriLog.error("no token in the app group — cannot send without the app")
        }
        completion(INSendMessageIntentResponse(code: signedIn ? .ready : .failureRequiringAppLaunch,
                                               userActivity: nil))
    }

    // MARK: Send

    func handle(
        intent: INSendMessageIntent,
        completion: @escaping (INSendMessageIntentResponse) -> Void
    ) {
        let text = (intent.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            completion(INSendMessageIntentResponse(code: .failure, userActivity: nil))
            return
        }
        guard let token = WidgetBridge.token(), !token.isEmpty else {
            siriLog.error("no token in the app group — cannot send without the app")
            completion(INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
            return
        }
        // Only value types cross into the task: capturing the intent (or self)
        // here is the non-Sendable capture that builds locally and errors in a
        // stricter-concurrency build.
        let conversationId = intent.conversationIdentifier
        let candidates = intent.recipients?.first
            .map { SiriDirectory.spokenCandidates(for: $0) } ?? []
        Task {
            guard let target = await SiriDirectory.resolve(
                conversationId: conversationId, candidates: candidates, token: token,
            ) else {
                siriLog.error("nothing matched \(candidates.joined(separator: "/"), privacy: .private)")
                completion(INSendMessageIntentResponse(code: .failure, userActivity: nil))
                return
            }
            let result = await SiriSendAPI.send(
                channelId: target.id, text: text, isE2EE: target.isE2EE, token: token,
            )
            switch result {
            case .sent:
                completion(INSendMessageIntentResponse(code: .success, userActivity: nil))
            case .needsApp:
                // Locked conversation: the key for it isn't on this device, so
                // only the app can send. This is the one case where telling the
                // user to open the app is the correct answer.
                completion(INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
            case .failed:
                completion(INSendMessageIntentResponse(code: .failure, userActivity: nil))
            }
        }
    }
}

// MARK: - Who Siri is talking about

enum SiriDirectory {
    /// Namespace for `INPersonHandle.value`. MUST match
    /// `ShareSuggestions.handleScheme` in QuickReply.swift — the app donates
    /// conversations with these handles, and this is the other end of that.
    /// Duplicated rather than shared because compiling QuickReply.swift in
    /// would drag the whole APIClient into the extension.
    static let handleScheme = "zekktris"

    static func userId(fromHandle value: String) -> String? {
        let prefix = "\(handleScheme):"
        guard value.hasPrefix(prefix) else { return nil }
        let id = String(value.dropFirst(prefix.count))
        return id.isEmpty ? nil : id
    }

    /// One conversation, known to be a 1:1 DM, with its encryption state
    /// settled — everything the send needs.
    struct Target {
        let id: String
        let isE2EE: Bool
    }

    /// The conversation Siri means.
    ///
    /// The App Group snapshot is the FAST path, not the source of truth. It can
    /// be stale (the app hasn't foregrounded since sign-in) or written by a
    /// build that didn't record whether a DM is encrypted — and treating either
    /// as "no such conversation" is what made Siri fall back to "you'll have to
    /// open the app" for something it could have simply sent. So when the
    /// snapshot can't answer confidently, ask the server: the token is right
    /// here, and the channel list says which DMs exist and which are encrypted.
    static func resolve(conversationId: String?, candidates: [String], token: String) async -> Target? {
        let snapshot = WidgetBridge.recentDMs()
        if let conversationId {
            // A donated conversation. Trust it only when the snapshot also
            // knows the encryption state, since guessing that is unsafe.
            if let hit = snapshot.first(where: { $0.id == conversationId }), let e2ee = hit.isE2EE {
                return Target(id: hit.id, isE2EE: e2ee)
            }
            if let remote = await SiriRemote.directMessages(token: token)
                .first(where: { $0.id == conversationId }) {
                return Target(id: remote.id, isE2EE: remote.isE2EE)
            }
        }
        for candidate in candidates {
            // A donated handle names the peer outright.
            if let id = userId(fromHandle: candidate),
               let hit = snapshot.first(where: { $0.peerUserId == id }), let e2ee = hit.isE2EE {
                return Target(id: hit.id, isE2EE: e2ee)
            }
            if let hit = rank(heard: candidate, in: snapshot).first, let e2ee = hit.isE2EE {
                return Target(id: hit.id, isE2EE: e2ee)
            }
        }
        // Nothing usable locally — the server knows.
        let remote = await SiriRemote.directMessages(token: token)
        for candidate in candidates {
            if let hit = rank(heard: candidate, in: remote.map(\.asWidgetDM)).first,
               let match = remote.first(where: { $0.id == hit.id }) {
                return Target(id: match.id, isE2EE: match.isE2EE)
            }
        }
        return nil
    }

    /// The conversation Siri means, from the snapshot alone. Used by recipient
    /// resolution, which runs before the send and only needs a name.
    static func target(for intent: INSendMessageIntent) -> WidgetDM? {
        let all = WidgetBridge.recentDMs()
        if let conversationId = intent.conversationIdentifier,
           let hit = all.first(where: { $0.id == conversationId }) {
            return hit
        }
        guard let person = intent.recipients?.first else { return nil }
        return matches(for: person).first
    }

    /// Conversations that could be the person Siri heard, best first.
    ///
    /// You should not have to say someone's whole username out loud, so this
    /// SCORES every conversation and takes the closest rather than demanding an
    /// exact string. "Alex" finds "alexjmorgan94"; "alex morgan" still finds it
    /// through edit distance, because Siri writes spoken names with spaces that
    /// a username does not have.
    ///
    /// Matching this loosely is safe because Siri always reads the recipient
    /// back — "your message to Alex, ready to send?" — before anything is sent,
    /// so a wrong guess is visible to the user rather than silently delivered.
    /// A near-tie still asks, since that is the case where reading one name
    /// back would hide the fact that there were two.
    ///
    /// Only ever searches one-to-one DMs: the list it reads is published with a
    /// `type == "dm"` filter (see AppStore.syncWidgets), so group DMs and
    /// server channels cannot be addressed by voice at all.
    static func matches(for person: INPerson) -> [WidgetDM] {
        let all = WidgetBridge.recentDMs()
        for candidate in spokenCandidates(for: person) {
            // A donated conversation carries our own handle, so this is exact.
            if let id = userId(fromHandle: candidate) {
                let byId = all.filter { $0.peerUserId == id }
                if !byId.isEmpty { return byId }
            }
            let hits = rank(heard: candidate, in: all)
            if !hits.isEmpty { return hits }
        }
        return []
    }

    /// Everything this INPerson could be matched by, most precise first.
    ///
    /// The HANDLE leads. When a contact card carries a "Zekktris" instant
    /// message entry, iOS passes that username as the handle and the contact's
    /// REAL name as the display name — and the real name ("Mom") matches no
    /// conversation title, while the handle is exactly the username. Ordering
    /// it first is what makes "message Mom on Zekktris" work.
    ///
    /// `displayName` is non-optional on INPerson: it can be EMPTY when Siri
    /// heard a handle rather than a name, never nil.
    static func spokenCandidates(for person: INPerson) -> [String] {
        var out: [String] = []
        if let handle = person.personHandle?.value, !handle.isEmpty { out.append(handle) }
        if !person.displayName.isEmpty { out.append(person.displayName) }
        return out
    }

    /// The ranking itself, with the conversation list passed in — pure, so the
    /// tests can exercise it without an App Group.
    static func rank(heard: String, in all: [WidgetDM]) -> [WidgetDM] {
        let candidates = all.map {
            SiriCandidate(id: $0.id, names: [$0.contactName, $0.name, $0.peerUsername].compactMap { $0 })
        }
        let byId = Dictionary(all.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        return SiriMatching.rank(heard: heard, in: candidates).compactMap { byId[$0.id] }
    }

    static func person(for dm: WidgetDM) -> INPerson {
        let handle = INPersonHandle(
            value: dm.peerUserId.map { "\(handleScheme):\($0)" } ?? dm.id,
            type: .unknown,
        )
        return INPerson(
            personHandle: handle,
            nameComponents: nil,
            displayName: dm.name,
            image: nil,
            // Same reason as the donation: this is what lets Siri show, and
            // match, the person's real contact card.
            contactIdentifier: dm.peerUserId.flatMap { ContactLinks.contactId(forUserId: $0) },
            customIdentifier: dm.id,
        )
    }

}

// MARK: - Sending

enum SiriSendAPI {
    /// What happened, at the granularity Siri can act on: sending the user to
    /// the app is only right when the app is genuinely the only thing that can
    /// do it, and saying so when the network merely hiccuped is what makes the
    /// feature feel like it doesn't work.
    enum Outcome {
        case sent
        /// Only the app can proceed — the conversation is locked here, or the
        /// published token is no longer valid and only the app can refresh it.
        case needsApp
        case failed
    }

    /// POST the message. Mirrors QuickReply.send (the notification reply path),
    /// including its refusal to put plaintext in an encrypted conversation, but
    /// with a standalone URLSession call rather than the app's APIClient.
    static func send(channelId: String, text: String, isE2EE: Bool, token: String) async -> Outcome {
        var wire = text
        if isE2EE {
            guard let key = e2eeKey(forChannel: channelId) else {
                siriLog.error("encrypted conversation with no key on this device")
                return .needsApp
            }
            guard let encrypted = E2EE.encrypt(text, key: key) else {
                siriLog.error("encryption failed")
                return .failed
            }
            wire = encrypted
        }
        guard let url = URL(string: "\(Config.apiBaseURL)/channels/\(channelId)/messages") else {
            return .failed
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        let body: [String: Any] = [
            "content": wire,
            "nonce": UUID().uuidString,
            // Dictated to Siri (or CarPlay, which runs this same intent) with
            // the conversation never on screen, so this send isn't a read: it
            // must not start the countdown of a disappearing message the user
            // hasn't seen. Unlike QuickReply.send, whose notification showed
            // the message being answered.
            "notARead": true,
        ]
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (_, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse else {
            siriLog.error("send request never completed")
            return .failed
        }
        if (200..<300).contains(http.statusCode) { return .sent }
        // A stale published token: the app refreshes it on foreground, and
        // nothing out here can.
        if http.statusCode == 401 {
            siriLog.error("token rejected — the app needs to refresh it")
            return .needsApp
        }
        siriLog.error("send failed, HTTP \(http.statusCode)")
        return .failed
    }

    /// Per-DM key by channel id, from the app-group keychain where the app
    /// stores it as `e2ee.<userId>.<channelId>` — the signed-in user id isn't
    /// known in this process, so match on the channel suffix. Same lookup as
    /// QuickReply's.
    private static func e2eeKey(forChannel channelId: String) -> Data? {
        let suffix = ".\(channelId)"
        let store = KeychainStore(accessGroup: AppGroupConfig.identifier)
        for (account, b64) in store.allValues(prefix: "e2ee.") where account.hasSuffix(suffix) {
            if let bytes = Data(base64Encoded: b64), bytes.count == E2EE.keyBytes { return bytes }
        }
        return nil
    }
}

// MARK: - Asking the server directly

/// The DM list, straight from the API.
///
/// The extension has a token, so it never has to be stranded by a stale App
/// Group snapshot. This is also the authoritative answer for whether a
/// conversation is encrypted — the one thing that must not be guessed.
enum SiriRemote {
    struct Conversation {
        let id: String
        let isE2EE: Bool
        let displayName: String
        let username: String?
        let peerUserId: String?

        /// Reuse the same ranking the snapshot path uses, including the linked
        /// contact's name — which the App Group knows even for a conversation
        /// this list was fetched fresh from the server.
        var asWidgetDM: WidgetDM {
            WidgetDM(
                id: id, name: displayName, streak: 0, avatarURL: nil,
                isE2EE: isE2EE, peerUserId: peerUserId, peerUsername: username,
                contactName: peerUserId.flatMap { ContactLinks.contactName(forUserId: $0) },
            )
        }
    }

    /// One-to-one DMs only — `type == "dm"` excludes group DMs, and server
    /// channels are not in this endpoint's response at all.
    static func directMessages(token: String) async -> [Conversation] {
        guard let url = URL(string: "\(Config.apiBaseURL)/users/@me/channels") else { return [] }
        var req = URLRequest(url: url)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard let (data, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse,
              (200..<300).contains(http.statusCode),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let channels = root["channels"] as? [[String: Any]] else {
            siriLog.error("could not read the DM list from the server")
            return []
        }
        return channels.compactMap { channel in
            guard (channel["type"] as? String) == "dm",
                  let id = channel["id"] as? String else { return nil }
            let recipients = (channel["recipients"] as? [[String: Any]]) ?? []
            let peer = recipients.first
            let display = (peer?["displayName"] as? String)
                ?? (peer?["username"] as? String)
                ?? (channel["name"] as? String)
                ?? ""
            guard !display.isEmpty else { return nil }
            return Conversation(
                id: id,
                isE2EE: (channel["e2eeEnabled"] as? Bool) ?? false,
                displayName: display,
                username: peer?["username"] as? String,
                peerUserId: peer?["id"] as? String,
            )
        }
    }
}
