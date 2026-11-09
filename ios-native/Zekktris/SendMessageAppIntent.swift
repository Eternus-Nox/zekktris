import AppIntents

/// "Hey Siri, message Sam on Zekktris" on the iPhone, as an APP INTENT.
///
/// WHY THIS EXISTS ALONGSIDE ZekktrisIntents. That target is the SiriKit
/// Messaging extension (`INSendMessageIntent`), which is what works on iOS 26
/// today. Apple deprecated SiriKit at WWDC 2026: the new Siri reaches apps only
/// through App Intents and does not see Intents extensions at all, which is
/// already the case on watchOS — Siri there answers "you'll need an app for
/// that" no matter how the extension is configured. Rather than wait for the
/// iPhone to go the same way, both paths ship: SiriKit keeps serving the Siri
/// that still uses it, and this serves the one that doesn't.
///
/// This mirrors the watch (WatchSendMessageAppIntent) deliberately — same
/// entity shape, same matching, same refusal to put plaintext in an encrypted
/// DM — so the two stay comparable when one of them needs a fix.
struct SendMessageAppIntent: AppIntent {
    static var title: LocalizedStringResource = "Send a Message"
    static var description = IntentDescription("Send a Zekktris direct message.")
    /// Sends in the background. Siri asking for a message and then throwing you
    /// into the app to watch it send would defeat the point.
    static var openAppWhenRun = false

    @Parameter(title: "To", requestValueDialog: "Who do you want to message?")
    var recipient: ZekktrisPeer

    @Parameter(title: "Message", requestValueDialog: "What do you want to say?")
    var message: String

    init() {}
    init(recipient: ZekktrisPeer, message: String) {
        self.recipient = recipient
        self.message = message
    }

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$message) to \(\.$recipient)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        guard let dm = WidgetBridge.siriDMs().first(where: { $0.id == recipient.channelId }) else {
            return .result(dialog: "I couldn't find that conversation.")
        }
        // A recent DM keeps its first name even when an older DM shares it
        // (see ZekktrisPeerQuery.groups), so a bare first name, or anyone
        // outside the recent list, is confirmed by name before sending, as the
        // watch does. "No" ends the intent without sending.
        let recent = Set(WidgetBridge.recentDMs().map(\.id))
        let spokenFirst = recipient.id.hasSuffix(ZekktrisPeer.firstNameSuffix)
        let firstKey = ZekktrisPeerQuery.firstName(of: dm)?.lowercased()
        let sharedFirst = spokenFirst && firstKey != nil && WidgetBridge.siriDMs().contains {
            $0.id != dm.id && ZekktrisPeerQuery.firstName(of: $0)?.lowercased() == firstKey
        }
        if !recent.contains(dm.id) || sharedFirst {
            let fullName = dm.contactName ?? dm.name
            try await requestConfirmation(
                result: .result(dialog: "Send it to \(fullName)?"),
                confirmationActionName: .send,
            )
        }
        // nil means the published entry predates the flag. Unknown is treated
        // as encrypted, never as plaintext.
        let isE2EE = dm.isE2EE ?? true
        // Not a read: Siri or a Shortcuts automation sends without the
        // conversation on screen (see QuickReply.deliver).
        switch await QuickReply.deliver(channelId: dm.id, text: message, isE2EE: isE2EE, notARead: true) {
        case .sent:
            return .result(dialog: "Sent to \(recipient.name).")
        case .empty:
            return .result(dialog: "There was nothing to send.")
        case .needsApp(let why), .failed(let why):
            return .result(dialog: "\(why)")
        }
    }
}

/// Someone with a one-to-one DM, as Siri sees them.
///
/// The name here is the LINKED CONTACT name when the account has been linked to
/// a card, because a name spoken inside a shortcut phrase is matched against an
/// index built from these, not by asking the app. That is the same reason
/// contact linking exists for the SiriKit path — there it feeds
/// `INPerson.contactIdentifier`; here it feeds what gets published.
///
/// A linked DM is published twice (see `groups()`): under the card name and
/// under the Zekktris name, so either is understood. A unique first name is
/// published as well. The aliases carry a suffixed id and `channelId` strips
/// it back off.
struct ZekktrisPeer: AppEntity, Identifiable {
    /// The DM channel id, "<channel id>|zk" for the Zekktris-name alias, or
    /// "<channel id>|fn" for the first-name alias.
    let id: String
    let name: String

    static let aliasSuffix = "|zk"
    static let firstNameSuffix = "|fn"
    /// The DM this refers to, whichever of the names was spoken.
    var channelId: String {
        for suffix in [Self.aliasSuffix, Self.firstNameSuffix] where id.hasSuffix(suffix) {
            return String(id.dropLast(suffix.count))
        }
        return id
    }

    static var typeDisplayRepresentation = TypeDisplayRepresentation(name: "Person")
    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(name)") }
    static var defaultQuery = ZekktrisPeerQuery()
}

/// `EntityStringQuery` so a SPOKEN name goes through the same ranking the
/// SiriKit extension uses — contact name, display name, username, with the
/// length-aware fuzzy floor that keeps "Mom" off "Tom".
struct ZekktrisPeerQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [ZekktrisPeer] {
        Self.all().filter { identifiers.contains($0.id) }
    }

    /// Searches EVERY 1:1 DM (WidgetBridge.siriDMs), not only the ones
    /// offered in `suggestedEntities`: the answer to "Who do you want to
    /// message?" comes here. `entities(for:)` covers them all as well.
    func entities(matching string: String) async throws -> [ZekktrisPeer] {
        let dms = WidgetBridge.siriDMs()
        let candidates = dms.map {
            SiriCandidate(id: $0.id, names: [$0.contactName, $0.name, $0.peerUsername].compactMap { $0 })
        }
        let byChannel = Dictionary(grouping: Self.all(), by: \.channelId)
        return SiriMatching.rank(heard: string, in: candidates).compactMap { byChannel[$0.id]?.first }
    }

    func suggestedEntities() async throws -> [ZekktrisPeer] { Self.suggested() }

    /// How many entities Siri's phrase index is offered. Apple allows about
    /// 1000 App Shortcut phrases per locale, and a phrase that names the
    /// recipient counts once for every suggested entity — 9 of them do (see
    /// ZekktrisShortcuts), so 9 x 90 = 810 plus the 3 without a name stays
    /// under it however many DMs there are. 90 is also the most the 30 recent
    /// DMs can need (3 names each), so they always fit whole and the rest of
    /// the directory fills what is left. Change this with the phrase list.
    static let suggestionLimit = 90

    /// Every DM, ready for `entities(for:)`.
    static func all() -> [ZekktrisPeer] { groups().flatMap { $0 } }

    /// The most recent DMs that fit `suggestionLimit`, each with all of its
    /// names or not at all, so whichever one is spoken works. The recent DMs
    /// come first and are offered as they are; a directory DM is offered
    /// without any name already given out, so an older DM titled "Sam" can't
    /// take "Sam" from a recent Sam Rivera.
    static func suggested() -> [ZekktrisPeer] {
        let recent = Set(WidgetBridge.recentDMs().map(\.id))
        var out: [ZekktrisPeer] = []
        var published = Set<String>()
        for group in groups() {
            let isRecent = group.first.map { recent.contains($0.channelId) } ?? false
            let kept = isRecent ? group : group.filter { !published.contains($0.name.lowercased()) }
            guard out.count + kept.count <= suggestionLimit else { break }
            out += kept
            published.formUnion(kept.map { $0.name.lowercased() })
        }
        return out
    }

    /// One group per DM, newest first: the card name (or the display name),
    /// the Zekktris name when a linked card's differs — so both are
    /// understood — and a first name.
    static func groups() -> [[ZekktrisPeer]] {
        let dms = WidgetBridge.siriDMs()
        let recent = Set(WidgetBridge.recentDMs().map(\.id))
        let named = dms.map { dm -> [ZekktrisPeer] in
            guard let card = dm.contactName, !card.isEmpty,
                  card.caseInsensitiveCompare(dm.name) != .orderedSame else {
                return [ZekktrisPeer(id: dm.id, name: dm.name)]
            }
            return [
                ZekktrisPeer(id: dm.id, name: card),
                ZekktrisPeer(id: dm.id + ZekktrisPeer.aliasSuffix, name: dm.name),
            ]
        }
        // FIRST NAMES, in two tiers like the watch (WatchSiriPeerQuery.groups).
        // A name spoken inside a phrase is matched against this published
        // list, so "Send a message on Zekktris to Sam" found nothing for a DM
        // published only as "Sam Rivera". A linked card's first name is
        // published too (or the display name's, when it is a real two-word
        // name). A RECENT DM gets it when no other recent DM shares it or uses
        // it as a name — an older DM sharing it doesn't take it away, and
        // perform() confirms by full name when one does. Any other DM gets it
        // only when no DM at all shares it.
        let isRecent = dms.map { recent.contains($0.id) }
        func key(_ s: String) -> String { s.lowercased() }
        let recentCounts = Dictionary(
            grouping: zip(dms, isRecent).filter(\.1).compactMap { firstName(of: $0.0) }, by: key,
        ).mapValues(\.count)
        let recentTaken = Set(zip(named, isRecent).filter(\.1).flatMap { $0.0 }.map { key($0.name) })
        let allCounts = Dictionary(grouping: dms.compactMap(firstName(of:)), by: key).mapValues(\.count)
        let allTaken = Set(named.joined().map { key($0.name) })
        return zip(zip(dms, named), isRecent).map { pair, recentDM -> [ZekktrisPeer] in
            let (dm, peers) = pair
            guard let first = firstName(of: dm) else { return peers }
            let k = key(first)
            let unique = recentDM
                ? recentCounts[k] == 1 && !recentTaken.contains(k)
                : allCounts[k] == 1 && !allTaken.contains(k)
            guard unique else { return peers }
            return peers + [ZekktrisPeer(id: dm.id + ZekktrisPeer.firstNameSuffix, name: first)]
        }
    }

    /// The first word of the name a DM is published under, when it is a real
    /// first name rather than the whole name.
    fileprivate static func firstName(of dm: WidgetDM) -> String? {
        let full = (dm.contactName?.isEmpty == false ? dm.contactName : nil) ?? dm.name
        guard let first = full.split(separator: " ").first.map(String.init),
              first.count >= 2,
              first.caseInsensitiveCompare(full) != .orderedSame else { return nil }
        return first
    }
}

/// The spoken phrases, matching the SiriKit examples in
/// en.lproj/AppIntentVocabulary.plist so the same sentences keep working
/// whichever Siri the phone is running.
///
/// Every phrase must contain `\(.applicationName)`, exactly once, which is
/// also what routes "message Sam" to Zekktris rather than to Messages. The
/// message body cannot be spoken inline — App Shortcuts take one parameter per
/// phrase, and only from a published list — so Siri asks for it after the
/// name.
///
/// A sentence that matches none of these, on a Siri that only routes through
/// App Intents, gets "you'll need an app for that". That is what "Send a
/// message on Zekktris to Sam" got, so the word orders people actually use are
/// listed too, not only the ones Apple's examples suggest. Keep this list the
/// same as the watch's (ZekktrisWatchShortcuts).
///
/// Each phrase that names the recipient counts against Apple's phrase limit
/// once per suggested person, so adding one means revisiting
/// `ZekktrisPeerQuery.suggestionLimit`.
struct ZekktrisShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendMessageAppIntent(),
            phrases: [
                "Send a \(.applicationName) message to \(\.$recipient)",
                "Send a message to \(\.$recipient) on \(.applicationName)",
                "Message \(\.$recipient) on \(.applicationName)",
                "Tell \(\.$recipient) something on \(.applicationName)",
                "Send a message on \(.applicationName) to \(\.$recipient)",
                "Send a message to \(.applicationName) to \(\.$recipient)",
                "Send \(\.$recipient) a message on \(.applicationName)",
                "Send a message to \(\.$recipient) with \(.applicationName)",
                "Message \(\.$recipient) with \(.applicationName)",
                "Send a message with \(.applicationName)",
                "Send a \(.applicationName) message",
                "Send a message on \(.applicationName)",
            ],
            shortTitle: "Send a Message",
            systemImageName: "bubble.left.and.bubble.right.fill",
        )
    }
}
