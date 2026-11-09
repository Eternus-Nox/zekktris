import AppIntents

/// Sending a DM from the wrist by voice, as an APP INTENT.
///
/// WHY THIS EXISTS ALONGSIDE ZekktrisWatchIntents. The SiriKit route
/// (`INSendMessageIntent`, an Intents extension) is what the iPhone uses and it
/// works there. On the watch the same setup gets "You'll need an app for me to
/// help with that" — Siri never reaches the extension. Apple deprecated SiriKit
/// at WWDC 2026 and the new Siri routes through App Intents only, so rather
/// than keep chasing the old path on a platform that has already moved, the
/// watch gets an App Intent with a spoken shortcut phrase. That is the same
/// mechanism as the Poke complication, which does run on this watch without
/// opening the app — so it is the one path proven to work here.
///
/// The SiriKit extension is kept for the iPhone, where it still works today.
///
/// Lives in the ZekktrisWatchAppIntents EXTENSION, not the watch app: from the
/// app, Siri could match and fill this intent but never run it (see
/// ZekktrisWatchAppIntentsExtension).
struct WatchSendMessageAppIntent: AppIntent {
    static var title: LocalizedStringResource = "Send a Message"
    static var description = IntentDescription("Send a Zekktris direct message.")
    /// Sends from the intent itself — no app launch, which is the whole point.
    static var openAppWhenRun = false

    @Parameter(title: "To", requestValueDialog: "Who do you want to message?")
    var recipient: WatchSiriPeer

    @Parameter(title: "Message", requestValueDialog: "What do you want to say?")
    var message: String

    init() {}
    init(recipient: WatchSiriPeer, message: String) {
        self.recipient = recipient
        self.message = message
    }

    static var parameterSummary: some ParameterSummary {
        Summary("Send \(\.$message) to \(\.$recipient)")
    }

    func perform() async throws -> some IntentResult & ProvidesDialog {
        // Names spoken INSIDE a phrase are matched against an index Siri holds,
        // refreshed only when told. The provider lives in this extension, so
        // the watch app can't ask for that — this is the only place it
        // happens, so whoever the phone has relayed since the last refresh is
        // sayable by name from the next time on (the newest of them; see
        // suggestedEntities). A phrase without a name never depends on it:
        // Siri asks who, and the answer goes through entities(matching:)
        // below. On every way out, a failed one included: "I couldn't find
        // that conversation" is exactly when the index is likely stale.
        defer { ZekktrisWatchShortcuts.updateAppShortcutParameters() }
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return .result(dialog: "There was nothing to send.")
        }
        // The intent token, then the access token (see WatchWidgetBridge.perform).
        let authorizations = WatchWidgetBridge.authorizations()
        guard !authorizations.isEmpty, let base = WatchWidgetBridge.baseURL(), !base.isEmpty else {
            // The watch only has credentials once the phone app has run and
            // synced them, so this is "open Zekktris on your phone", not an error.
            return .result(dialog: "Open Zekktris on your iPhone first, then try again.")
        }
        guard let dm = WatchWidgetBridge.siriDMs().first(where: { $0.id == recipient.channelId }) else {
            return .result(dialog: "I couldn't find that conversation.")
        }
        // One of the 12 most recent DMs, which the phone relays as poke
        // targets, rather than one known only from the directory.
        let relayed = WatchWidgetBridge.dms().contains { $0.id == dm.id }
        // An encrypted DM without a key must fail, never fall back to plaintext.
        guard let encrypted = dm.e2ee else {
            return .result(dialog: "Open Zekktris on your watch once, then try again.")
        }
        let key = encrypted ? WatchWidgetBridge.e2eeKey(forChannel: dm.id) : nil
        if encrypted, key == nil {
            // Keys come only from the phone, and only for the poke targets.
            // For one of those the key was locked on the phone; opening the
            // chat there unlocks it and sends it over. A DM known only from
            // the directory never gets a key here, so sending it from the
            // phone is the only honest answer.
            return .result(dialog: relayed
                ? "Open that chat in Zekktris on your iPhone, then try again."
                : "That chat is encrypted. Send it from Zekktris on your iPhone.")
        }
        // An older DM is read back, by its full name, before anything goes.
        // It was picked from a couple of hundred names rather than the dozen
        // messaged lately — by a bare first name or a one-word account name,
        // or by a "who?" answer fuzzy-matched against all of them — and this
        // path has no other confirmation, so a wrong pick would go out
        // silently. "No" ends the intent without sending.
        if !relayed {
            let fullName = dm.contactName ?? dm.name
            try await requestConfirmation(
                result: .result(dialog: "Send it to \(fullName)?"),
                confirmationActionName: .send,
            )
        }
        let ok = await WatchPokeAPI.sendMessage(
            baseURL: base, authorizations: authorizations, channelId: dm.id,
            content: text, e2ee: encrypted, e2eeKey: key,
        )
        return .result(dialog: ok ? "Sent to \(recipient.name)." : "That didn't send.")
    }
}

/// A DM the watch can send to. Backed by the App Group: the list the poke
/// complication reads plus the Siri directory of every other 1:1 DM
/// (WatchWidgetBridge.siriDMs), so the answer to "who?" can be anyone the
/// phone knows about. The names that can be said inside a phrase are the most
/// recent ones only (see suggestedEntities).
///
/// CONTACT LINKING. The phone relays the name on the linked Contacts card with
/// each DM, and that name is what this presents when there is one — because a
/// name spoken INSIDE a phrase ("message Sam Rivera on Zekktris") is matched
/// against an index built from these titles, not by asking the app. An account
/// name Siri has never been told about cannot be recognised there, which is the
/// whole reason contact linking exists on the phone.
///
/// A linked DM is published TWICE (see WatchSiriPeerQuery.groups): once under
/// the card name, once under the Zekktris name, so either one is understood. A
/// unique first name is published as well. The aliases carry a suffixed id and
/// `channelId` strips it back off.
struct WatchSiriPeer: AppEntity, Identifiable {
    /// Entity id: the DM channel id, or "<channel id>|zk" for the alias.
    let id: String
    /// What Siri says and matches — the linked card name, or the display name.
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
    static var defaultQuery = WatchSiriPeerQuery()
}

/// `EntityStringQuery`, not a plain `EntityQuery`: the string form is what Siri
/// calls with a spoken name, and it is where the loose matching lives. Exact
/// display names would mean saying the account name exactly; SiriMatching is
/// the same ranking the iPhone extension uses (linked contact name, display
/// name, username; a length-aware fuzzy floor so "Mom" can't land on "Tom").
struct WatchSiriPeerQuery: EntityStringQuery {
    func entities(for identifiers: [String]) async throws -> [WatchSiriPeer] {
        Self.all().filter { identifiers.contains($0.id) }
    }

    /// Searches EVERY 1:1 DM (WatchWidgetBridge.siriDMs), not only the ones
    /// offered in `suggestedEntities`: the answer to "Who do you want to
    /// message?" comes here. `entities(for:)` covers them all as well.
    func entities(matching string: String) async throws -> [WatchSiriPeer] {
        let dms = WatchWidgetBridge.siriDMs()
        let candidates = dms.map {
            SiriCandidate(id: $0.id, names: [$0.contactName, $0.name, $0.username].compactMap { $0 })
        }
        let ranked = SiriMatching.rank(heard: string, in: candidates)
        let byChannel = Dictionary(grouping: Self.all(), by: \.channelId)
        // The card-named entry first, which is the one `all()` puts first.
        return ranked.compactMap { byChannel[$0.id]?.first }
    }

    func suggestedEntities() async throws -> [WatchSiriPeer] { Self.suggested() }

    /// How many entities Siri's phrase index is offered. Apple allows about
    /// 1000 App Shortcut phrases per locale, and a phrase that names the
    /// recipient counts once for every suggested entity — 9 of them do (see
    /// ZekktrisWatchShortcuts), so 9 x 70 = 630 plus the 3 without a name:
    /// well short of the limit however long the directory gets. The poke
    /// targets always fit (12, at most 3 names each). Change this with the
    /// phrase list.
    static let suggestionLimit = 70

    /// Every DM under every name it goes by, for `entities(for:)` and
    /// `entities(matching:)`.
    static func all() -> [WatchSiriPeer] { groups().flatMap { $0.peers } }

    /// What Siri's index is given: the poke targets, then the newest of the
    /// directory, as many as fit `suggestionLimit`, each with all of its names
    /// or not at all. A directory DM never takes a name that is already
    /// given out, so "Sam" stays with the Sam Rivera messaged every day and an
    /// old chat with an account called just "Sam" can't take it over. That
    /// chat is still reachable by its other names, or by answering "who?".
    static func suggested() -> [WatchSiriPeer] {
        var out: [WatchSiriPeer] = []
        var given = Set<String>()
        for group in groups() {
            let peers = group.recent
                ? group.peers
                : group.peers.filter { !given.contains($0.name.lowercased()) }
            guard out.count + peers.count <= suggestionLimit else { break }
            out += peers
            given.formUnion(peers.map { $0.name.lowercased() })
        }
        return out
    }

    /// One group per DM, in `siriDMs()` order (the poke targets, then the rest
    /// of the directory, newest first): the card name or the display name,
    /// then the Zekktris name when a linked card's differs — so both "message
    /// Sam Rivera on Zekktris" and "message SRivera1337 on Zekktris" are
    /// understood — then a first name. `recent` marks a poke target.
    static func groups() -> [(peers: [WatchSiriPeer], recent: Bool)] {
        let targets = WatchWidgetBridge.dms()
        let dms = WatchWidgetBridge.siriDMs(targets: targets)
        let recentIds = Set(targets.map(\.id))
        let named = dms.map(names(of:))
        // FIRST NAMES, because Siri on Apple Watch matches a phrase EXACTLY.
        // The iPhone forgives "message Sam" for a published "Sam
        // Rivera"; the watch does not, and an unmatched phrase falls through to
        // "You'll need an app for me to help with that". So a linked card's
        // first name is published too (or the display name's, when it is a
        // real two-word name) — but only when it is unambiguous, because an
        // ambiguous first name would send to whichever one Siri picked.
        //
        // In two tiers. A poke target's has to be unique among the targets
        // and clash with none of their names, as before there was a directory:
        // that is someone messaged lately, and an old chat with a Sam in it
        // must not take "Sam" away from Sam Rivera. A directory DM's has to be
        // unique among EVERY DM and clash with no name at all — counted over
        // the whole list, not what `suggestionLimit` keeps, so a DM cut from
        // the index can't make it look unambiguous.
        let recentCounts = tally(targets.compactMap(firstName(of:)))
        let allCounts = tally(dms.compactMap(firstName(of:)))
        let recentTaken = Set(targets.flatMap(names(of:)).map { $0.name.lowercased() })
        let allTaken = Set(named.joined().map { $0.name.lowercased() })
        return zip(dms, named).map { dm, peers -> (peers: [WatchSiriPeer], recent: Bool) in
            let recent = recentIds.contains(dm.id)
            guard let first = firstName(of: dm) else { return (peers: peers, recent: recent) }
            let key = first.lowercased()
            let unambiguous = recent
                ? recentCounts[key] == 1 && !recentTaken.contains(key)
                : allCounts[key] == 1 && !allTaken.contains(key)
            guard unambiguous else { return (peers: peers, recent: recent) }
            let alias = WatchSiriPeer(id: dm.id + WatchSiriPeer.firstNameSuffix, name: first)
            return (peers: peers + [alias], recent: recent)
        }
    }

    /// The card name (or the display name), plus the Zekktris name when a
    /// linked card's differs.
    private static func names(of dm: WatchWidgetDM) -> [WatchSiriPeer] {
        guard let card = dm.contactName, !card.isEmpty,
              card.caseInsensitiveCompare(dm.name) != .orderedSame else {
            return [WatchSiriPeer(id: dm.id, name: dm.name)]
        }
        return [
            WatchSiriPeer(id: dm.id, name: card),
            WatchSiriPeer(id: dm.id + WatchSiriPeer.aliasSuffix, name: dm.name),
        ]
    }

    /// The first word of the name a DM is published under, when it is a real
    /// first name rather than the whole name.
    private static func firstName(of dm: WatchWidgetDM) -> String? {
        let full = (dm.contactName?.isEmpty == false ? dm.contactName : nil) ?? dm.name
        guard let first = full.split(separator: " ").first.map(String.init),
              first.count >= 2,
              first.caseInsensitiveCompare(full) != .orderedSame else { return nil }
        return first
    }

    /// How many times each name occurs, case-insensitively.
    private static func tally(_ words: [String]) -> [String: Int] {
        Dictionary(grouping: words, by: { $0.lowercased() }).mapValues(\.count)
    }
}

/// The spoken phrases. Declared in the App Intents extension, beside the intent
/// they invoke — an App Intents extension may own its App Shortcuts, and there
/// must be only one provider per app, so the watch app itself declares none.
///
/// Every phrase has to contain `\(.applicationName)`, exactly once — that is
/// the framework's rule, and it is also what makes "with Zekktris" the thing
/// that routes a plain "send a message" to us instead of to Messages.
///
/// The wrist matches these EXACTLY, so a word order that isn't listed gets
/// "You'll need an app for me to help with that". That is what "Send a message
/// on Zekktris to Sam" got, so the orders people actually say are listed too.
/// Keep this list the same as the iPhone's (ZekktrisShortcuts).
struct ZekktrisWatchShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: WatchSendMessageAppIntent(),
            phrases: [
                // The wrist's versions of the iPhone's example phrases. The
                // NAME can be spoken inline because the recipient is an
                // AppEntity and its suggested values are indexed (see
                // WatchSiriPeerQuery.suggestedEntities, and the refresh in
                // perform); what cannot be inlined is the message body — App
                // Shortcuts allow one parameter per phrase and only for
                // enumerable types — so Siri asks "what do you want to say?"
                // after it has the person.
                "Send a \(.applicationName) message to \(\.$recipient)",
                "Send a message to \(\.$recipient) on \(.applicationName)",
                "Message \(\.$recipient) on \(.applicationName)",
                "Tell \(\.$recipient) something on \(.applicationName)",
                "Send a message on \(.applicationName) to \(\.$recipient)",
                "Send a message to \(.applicationName) to \(\.$recipient)",
                "Send \(\.$recipient) a message on \(.applicationName)",
                "Send a message to \(\.$recipient) with \(.applicationName)",
                "Message \(\.$recipient) with \(.applicationName)",
                // And without a name, for "send a message" then being asked who.
                "Send a message with \(.applicationName)",
                "Send a \(.applicationName) message",
                "Send a message on \(.applicationName)",
            ],
            shortTitle: "Send a Message",
            systemImageName: "bubble.left.and.bubble.right.fill",
        )
    }
}
