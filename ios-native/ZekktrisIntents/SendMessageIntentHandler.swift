import Foundation
import Intents

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
        completion(INSendMessageIntentResponse(code: signedIn ? .ready : .failureRequiringAppLaunch,
                                               userActivity: nil))
    }

    // MARK: Send

    func handle(
        intent: INSendMessageIntent,
        completion: @escaping (INSendMessageIntentResponse) -> Void
    ) {
        let text = (intent.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty,
              let target = SiriDirectory.target(for: intent),
              let token = WidgetBridge.token(), !token.isEmpty
        else {
            completion(INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
            return
        }
        // Only value types cross into the task: capturing the intent (or self)
        // here is the non-Sendable capture that builds locally and errors in a
        // stricter-concurrency build.
        let channelId = target.id
        let isE2EE = target.isE2EE ?? false
        Task {
            let sent = await SiriSendAPI.send(
                channelId: channelId, text: text, isE2EE: isE2EE, token: token,
            )
            completion(INSendMessageIntentResponse(
                code: sent ? .success : .failureRequiringAppLaunch, userActivity: nil,
            ))
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

    /// The conversation Siri means: the donated conversation id when there is
    /// one, otherwise the named recipient.
    static func target(for intent: INSendMessageIntent) -> WidgetDM? {
        let all = WidgetBridge.recentDMs()
        if let conversationId = intent.conversationIdentifier,
           let hit = all.first(where: { $0.id == conversationId }) {
            return hit
        }
        guard let person = intent.recipients?.first else { return nil }
        return matches(for: person).first
    }

    /// Conversations that could be the person Siri heard. An exact name match
    /// wins outright; otherwise every prefix match is offered for
    /// disambiguation, which is what turns "message Sam" into Siri asking
    /// "which Sam?" instead of guessing.
    static func matches(for person: INPerson) -> [WidgetDM] {
        let all = WidgetBridge.recentDMs()
        // A donated conversation carries our own handle, so this is exact.
        if let handle = person.personHandle?.value, let id = userId(fromHandle: handle) {
            let byId = all.filter { $0.peerUserId == id }
            if !byId.isEmpty { return byId }
        }
        // `displayName` is non-optional on INPerson — it can be EMPTY (Siri
        // heard a handle rather than a name), never nil, so the fallback has to
        // test for empty rather than coalesce.
        let heard = person.displayName.isEmpty
            ? (person.personHandle?.value ?? "")
            : person.displayName
        let spoken = normalize(heard)
        guard !spoken.isEmpty else { return [] }
        let exact = all.filter { normalize($0.name) == spoken }
        if !exact.isEmpty { return exact }
        return all.filter { normalize($0.name).hasPrefix(spoken) || normalize($0.name).contains(spoken) }
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
            contactIdentifier: nil,
            customIdentifier: dm.id,
        )
    }

    /// Case- and accent-insensitive, so "José" matches "jose".
    private static func normalize(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

// MARK: - Sending

enum SiriSendAPI {
    /// POST the message. Mirrors QuickReply.send (the notification reply path),
    /// including its refusal to put plaintext in an encrypted conversation, but
    /// with a standalone URLSession call rather than the app's APIClient.
    static func send(channelId: String, text: String, isE2EE: Bool, token: String) async -> Bool {
        var wire = text
        if isE2EE {
            guard let key = e2eeKey(forChannel: channelId),
                  let encrypted = E2EE.encrypt(text, key: key) else { return false }
            wire = encrypted
        }
        guard let url = URL(string: "\(Config.apiBaseURL)/channels/\(channelId)/messages") else {
            return false
        }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: [
            "content": wire,
            "nonce": UUID().uuidString,
        ])
        guard let (_, response) = try? await URLSession.shared.data(for: req),
              let http = response as? HTTPURLResponse else { return false }
        return (200..<300).contains(http.statusCode)
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
