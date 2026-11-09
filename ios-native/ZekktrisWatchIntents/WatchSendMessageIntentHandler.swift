import Foundation
import Intents
import os.log

/// Console.app: subsystem `com.zekktris.native.watchkitapp.intents`. Every
/// refusal logs which precondition failed; from the wrist they all look alike.
private let watchSiriLog = Logger(subsystem: "com.zekktris.native.watchkitapp.intents", category: "siri")

/// Resolve + send for Siri on the watch.
///
/// Everything it needs is published by the watch app to the watch App Group:
/// the DM list and the Siri directory of every 1:1 DM (each with its
/// encryption flag and the names it goes by), the intent token and the access
/// token, the API base URL, and — in the app-group keychain — the per-DM keys.
/// Matching is SiriMatching, the same code the iPhone uses, so a name resolves
/// to the same person on both.
///
/// THE RULE: never plaintext into an encrypted conversation. WatchPokeAPI's
/// send already refuses that on its own; this handler additionally refuses when
/// it can't even tell whether a DM is encrypted, and hands the user to the
/// phone when the key isn't on the watch.
final class WatchSendMessageIntentHandler: NSObject, INSendMessageIntentHandling {

    func resolveRecipients(
        for intent: INSendMessageIntent,
        with completion: @escaping ([INSendMessageRecipientResolutionResult]) -> Void
    ) {
        let people = intent.recipients ?? []
        guard !people.isEmpty else {
            completion([INSendMessageRecipientResolutionResult.needsValue()])
            return
        }
        // Every DM the phone knows, not only the 12 the watch can poke.
        let dms = WatchWidgetBridge.siriDMs()
        completion(people.map { person in
            let matches = WatchSiri.matches(for: person, in: dms)
            if matches.isEmpty { return .unsupported(forReason: .noValidHandle) }
            if matches.count == 1 { return .success(with: WatchSiri.person(for: matches[0])) }
            return .disambiguation(with: matches.map { WatchSiri.person(for: $0) })
        })
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
        let ready = !WatchWidgetBridge.authorizations().isEmpty
            && WatchWidgetBridge.baseURL()?.isEmpty == false
        if !ready {
            // The watch app publishes these once the phone has synced to it.
            // Missing means it never has — open the watch app with the phone
            // nearby once.
            watchSiriLog.error("no token or base URL in the watch app group")
        }
        completion(INSendMessageIntentResponse(code: ready ? .ready : .failureRequiringAppLaunch,
                                               userActivity: nil))
    }

    func handle(
        intent: INSendMessageIntent,
        completion: @escaping (INSendMessageIntentResponse) -> Void
    ) {
        let text = (intent.content ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            completion(INSendMessageIntentResponse(code: .failure, userActivity: nil))
            return
        }
        // The intent token, then the access token (see WatchWidgetBridge.perform).
        let authorizations = WatchWidgetBridge.authorizations()
        guard !authorizations.isEmpty,
              let baseURL = WatchWidgetBridge.baseURL(), !baseURL.isEmpty else {
            watchSiriLog.error("no token or base URL — cannot send without the app")
            completion(INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
            return
        }
        guard let dm = WatchSiri.target(for: intent, in: WatchWidgetBridge.siriDMs()) else {
            watchSiriLog.error("no conversation matched")
            completion(INSendMessageIntentResponse(code: .failure, userActivity: nil))
            return
        }
        // Unknown is not "plaintext": the list was written by a build that
        // didn't record the flag. Refuse rather than guess.
        guard let isE2EE = dm.e2ee else {
            watchSiriLog.error("encryption state unknown for this conversation")
            completion(INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
            return
        }
        // Keys come only from the phone, and only for its 12 most recent DMs,
        // so an encrypted DM found in the directory alone lands here too.
        let key = isE2EE ? WatchWidgetBridge.e2eeKey(forChannel: dm.id) : nil
        if isE2EE && key == nil {
            watchSiriLog.error("encrypted conversation with no key on the watch")
            completion(INSendMessageIntentResponse(code: .failureRequiringAppLaunch, userActivity: nil))
            return
        }
        // Value types only across the task boundary.
        let channelId = dm.id
        Task {
            let sent = await WatchPokeAPI.sendMessage(
                baseURL: baseURL, authorizations: authorizations, channelId: channelId,
                content: text, e2ee: isE2EE, e2eeKey: key,
            )
            if !sent { watchSiriLog.error("send failed") }
            completion(INSendMessageIntentResponse(code: sent ? .success : .failure, userActivity: nil))
        }
    }
}

/// Who Siri means, on the watch — a thin adapter over SiriMatching.
enum WatchSiri {
    static func candidates(_ dms: [WatchWidgetDM]) -> [SiriCandidate] {
        dms.map {
            SiriCandidate(id: $0.id, names: [$0.contactName, $0.name, $0.username].compactMap { $0 })
        }
    }

    /// A handle, when present, is tried before the display name: from a linked
    /// contact card it IS the username, while the display name is the card's
    /// real name — the same ordering the iPhone uses.
    static func matches(for person: INPerson, in dms: [WatchWidgetDM]) -> [WatchWidgetDM] {
        let byId = Dictionary(dms.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        // Our own resolution result round-trips its conversation id here.
        if let id = person.customIdentifier, let hit = byId[id] { return [hit] }
        var heard: [String] = []
        if let handle = person.personHandle?.value, !handle.isEmpty { heard.append(handle) }
        if !person.displayName.isEmpty { heard.append(person.displayName) }
        for name in heard {
            let hits = SiriMatching.rank(heard: name, in: candidates(dms)).compactMap { byId[$0.id] }
            if !hits.isEmpty { return hits }
        }
        return []
    }

    static func target(for intent: INSendMessageIntent, in dms: [WatchWidgetDM]) -> WatchWidgetDM? {
        if let conversationId = intent.conversationIdentifier,
           let hit = dms.first(where: { $0.id == conversationId }) {
            return hit
        }
        guard let person = intent.recipients?.first else { return nil }
        return matches(for: person, in: dms).first
    }

    static func person(for dm: WatchWidgetDM) -> INPerson {
        INPerson(
            personHandle: INPersonHandle(value: dm.username ?? dm.id, type: .unknown),
            nameComponents: nil,
            displayName: dm.contactName ?? dm.name,
            image: nil,
            contactIdentifier: nil,
            // Carries the conversation id back into handle(), so the send goes
            // to exactly the person Siri confirmed rather than a re-match.
            customIdentifier: dm.id,
        )
    }
}
