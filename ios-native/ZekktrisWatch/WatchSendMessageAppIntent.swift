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
        let text = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else {
            return .result(dialog: "There was nothing to send.")
        }
        guard let token = WatchWidgetBridge.token(), let base = WatchWidgetBridge.baseURL() else {
            // The watch only has credentials once the phone app has run and
            // synced them, so this is "open Zekktris on your phone", not an error.
            return .result(dialog: "Open Zekktris on your iPhone first, then try again.")
        }
        guard let dm = WatchWidgetBridge.dms().first(where: { $0.id == recipient.id }) else {
            return .result(dialog: "I couldn't find that conversation.")
        }
        // An encrypted DM without a key must fail, never fall back to plaintext.
        // The phone publishes per-DM keys into the watch keychain; a DM that
        // predates that write has none yet.
        guard let encrypted = dm.e2ee else {
            return .result(dialog: "Open Zekktris on your watch once, then try again.")
        }
        let key = encrypted ? WatchWidgetBridge.e2eeKey(forChannel: dm.id) : nil
        if encrypted, key == nil {
            return .result(dialog: "That chat is encrypted. Open it on your watch once, then try again.")
        }
        let ok = await WatchPokeAPI.sendMessage(
            baseURL: base, token: token, channelId: dm.id,
            content: text, e2ee: encrypted, e2eeKey: key,
        )
        return .result(dialog: ok ? "Sent to \(recipient.name)." : "That didn't send.")
    }
}

/// A DM the watch can send to. Backed by the same App Group list the poke
/// complication reads, so Siri offers exactly the people the watch knows about.
struct WatchSiriPeer: AppEntity, Identifiable {
    let id: String              // DM channel id
    let name: String

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
        WatchWidgetBridge.dms()
            .filter { identifiers.contains($0.id) }
            .map { WatchSiriPeer(id: $0.id, name: $0.name) }
    }

    func entities(matching string: String) async throws -> [WatchSiriPeer] {
        let dms = WatchWidgetBridge.dms()
        let candidates = dms.map {
            SiriCandidate(id: $0.id, names: [$0.contactName, $0.name, $0.username].compactMap { $0 })
        }
        let ranked = SiriMatching.rank(heard: string, in: candidates)
        let byId = Dictionary(uniqueKeysWithValues: dms.map { ($0.id, $0) })
        return ranked.compactMap { hit in
            byId[hit.id].map { WatchSiriPeer(id: $0.id, name: $0.name) }
        }
    }

    func suggestedEntities() async throws -> [WatchSiriPeer] {
        WatchWidgetBridge.dms().map { WatchSiriPeer(id: $0.id, name: $0.name) }
    }
}

/// The spoken phrases. App Shortcuts are registered from the APP target (not an
/// extension), which is why this lives here and not beside the widgets.
///
/// Every phrase has to contain `\(.applicationName)` — that is the framework's
/// rule, and it is also what makes "with Zekktris" the thing that routes a
/// plain "send a message" to us instead of to Messages.
struct ZekktrisWatchShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: WatchSendMessageAppIntent(),
            phrases: [
                // The wrist's versions of the iPhone's example phrases. The
                // NAME can be spoken inline because the recipient is an
                // AppEntity and its values are indexed (see
                // updateAppShortcutParameters in WatchSyncStore); what cannot
                // be inlined is the message body — App Shortcuts allow one
                // parameter per phrase and only for enumerable types — so Siri
                // asks "what do you want to say?" after it has the person.
                "Send a \(.applicationName) message to \(\.$recipient)",
                "Send a message to \(\.$recipient) on \(.applicationName)",
                "Message \(\.$recipient) on \(.applicationName)",
                "Tell \(\.$recipient) something on \(.applicationName)",
                // And without a name, for "send a message" then being asked who.
                "Send a message with \(.applicationName)",
                "Send a \(.applicationName) message",
            ],
            shortTitle: "Send a Message",
            systemImageName: "bubble.left.and.bubble.right.fill",
        )
    }
}
