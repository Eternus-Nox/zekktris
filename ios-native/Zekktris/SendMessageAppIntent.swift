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
        guard let dm = WidgetBridge.recentDMs().first(where: { $0.id == recipient.channelId }) else {
            return .result(dialog: "I couldn't find that conversation.")
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
/// A linked DM is published twice (see `all()`): under the card name and under
/// the Zekktris name, so either is understood. The alias carries a suffixed id
/// and `channelId` strips it back off.
struct ZekktrisPeer: AppEntity, Identifiable {
    /// The DM channel id, or "<channel id>|zk" for the alias.
    let id: String
    let name: String

    static let aliasSuffix = "|zk"
    var channelId: String {
        id.hasSuffix(Self.aliasSuffix) ? String(id.dropLast(Self.aliasSuffix.count)) : id
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

    func entities(matching string: String) async throws -> [ZekktrisPeer] {
        let dms = WidgetBridge.recentDMs()
        let candidates = dms.map {
            SiriCandidate(id: $0.id, names: [$0.contactName, $0.name, $0.peerUsername].compactMap { $0 })
        }
        let byChannel = Dictionary(grouping: Self.all(), by: \.channelId)
        return SiriMatching.rank(heard: string, in: candidates).compactMap { byChannel[$0.id]?.first }
    }

    func suggestedEntities() async throws -> [ZekktrisPeer] { Self.all() }

    /// One entry per DM, plus a second under the Zekktris name when a linked
    /// card name differs — so both are understood.
    static func all() -> [ZekktrisPeer] {
        WidgetBridge.recentDMs().flatMap { dm -> [ZekktrisPeer] in
            guard let card = dm.contactName, !card.isEmpty,
                  card.caseInsensitiveCompare(dm.name) != .orderedSame else {
                return [ZekktrisPeer(id: dm.id, name: dm.name)]
            }
            return [
                ZekktrisPeer(id: dm.id, name: card),
                ZekktrisPeer(id: dm.id + ZekktrisPeer.aliasSuffix, name: dm.name),
            ]
        }
    }
}

/// The spoken phrases, matching the SiriKit examples in
/// en.lproj/AppIntentVocabulary.plist so the same sentences keep working
/// whichever Siri the phone is running.
///
/// Every phrase must contain `\(.applicationName)`, which is also what routes
/// "message Sam" to Zekktris rather than to Messages. The message body cannot
/// be spoken inline — App Shortcuts take one parameter per phrase, and only
/// from a published list — so Siri asks for it after the name.
struct ZekktrisShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendMessageAppIntent(),
            phrases: [
                "Send a \(.applicationName) message to \(\.$recipient)",
                "Send a message to \(\.$recipient) on \(.applicationName)",
                "Message \(\.$recipient) on \(.applicationName)",
                "Tell \(\.$recipient) something on \(.applicationName)",
                "Send a message with \(.applicationName)",
                "Send a \(.applicationName) message",
            ],
            shortTitle: "Send a Message",
            systemImageName: "bubble.left.and.bubble.right.fill",
        )
    }
}
