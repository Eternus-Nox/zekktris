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
        // A MISSING flag is not "plaintext" — it means this conversation was
        // published to the App Group by a build that predates the flag, so
        // whether it is encrypted is simply unknown. Defaulting to false there
        // would send plaintext into an encrypted DM the first time Siri is used
        // after an update, which is the one outcome this whole path exists to
        // prevent. Refuse; the app republishes the list on its next foreground.
        guard let isE2EE = target.isE2EE else {
            completion(INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
            return
        }
        // Only value types cross into the task: capturing the intent (or self)
        // here is the non-Sendable capture that builds locally and errors in a
        // stricter-concurrency build.
        let channelId = target.id
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
        return rank(heard: heard, in: all)
    }

    /// The ranking itself, with the conversation list passed in — pure, so the
    /// tests can exercise it without an App Group.
    static func rank(heard: String, in all: [WidgetDM]) -> [WidgetDM] {
        let spoken = normalize(heard)
        guard !spoken.isEmpty else { return [] }

        let ranked = all
            .map { (dm: $0, score: bestScore(spoken: spoken, dm: $0)) }
            .filter { $0.score >= minScore }
            .sorted { $0.score > $1.score }
        guard let best = ranked.first else { return [] }
        // One candidate, or one clearly ahead of the rest: send to it.
        if ranked.count == 1 || best.score - ranked[1].score >= clearWinnerMargin {
            return [best.dm]
        }
        // Too close to call — let Siri ask which one.
        return ranked.prefix(3).map { $0.dm }
    }

    /// Below this, a name is a different name rather than a mangled one.
    static let minScore = 0.55
    /// How far ahead the leader must be to skip the "which one?" question.
    static let clearWinnerMargin = 0.12

    /// Best fit across everything we know this person by.
    static func bestScore(spoken: String, dm: WidgetDM) -> Double {
        var best = 0.0
        for candidate in [dm.name, dm.peerUsername].compactMap({ $0 }) {
            best = max(best, score(spoken: spoken, candidate: normalize(candidate)))
        }
        return best
    }

    /// 0...1, ordered so that the confident kinds of match always outrank a
    /// merely similar-looking one.
    static func score(spoken: String, candidate: String) -> Double {
        guard !spoken.isEmpty, !candidate.isEmpty else { return 0 }
        if spoken == candidate { return 1 }
        if candidate.hasPrefix(spoken) { return 0.95 }
        let tokens = candidate
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
        if tokens.contains(spoken) { return 0.93 }
        if tokens.contains(where: { $0.hasPrefix(spoken) }) { return 0.9 }
        if candidate.contains(spoken) { return 0.8 }
        // Fall back to how much editing it would take. Spaces are dropped
        // first: Siri writes "alex morgan" where the username is
        // "alexjmorgan94", and the space is not a real difference.
        let squashed = spoken.filter { $0.isLetter || $0.isNumber }
        var best = ratio(squashed, candidate)
        for token in tokens { best = max(best, ratio(squashed, token)) }
        return best
    }

    /// Similarity as 1 - (edits / longest), so it is comparable across lengths.
    private static func ratio(_ a: String, _ b: String) -> Double {
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        let distance = Double(levenshtein(Array(a), Array(b)))
        return max(0, 1 - distance / Double(max(a.count, b.count)))
    }

    /// Plain edit distance, one row at a time — the strings here are names, so
    /// the quadratic cost is nothing and it avoids a dependency.
    private static func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var previous = Array(0...b.count)
        var current = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            current[0] = i
            for j in 1...b.count {
                let substitution = previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)
                current[j] = min(previous[j] + 1, current[j - 1] + 1, substitution)
            }
            swap(&previous, &current)
        }
        return previous[b.count]
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
