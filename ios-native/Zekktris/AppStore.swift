import Foundation
import SwiftUI
import UIKit
import os

/// Diagnostic log for the 1:1 call ring path. Visible in Console.app
/// (filter subsystem com.zekktris.native, category "calls") even when the
/// app runs outside Xcode — used to pin where an incoming ring is dropped.
private let callLog = Logger(subsystem: "com.zekktris.native", category: "calls")

/// A drill-down destination beyond the root channel/DM list.
enum Route: Hashable {
    case messages(Channel)
    case threadList(Channel)
    case voice(Channel)
}

/// What the content column shows at its root: the normal channel/DM list,
/// or the Mentions / Saved views (which keep the server rail visible).
enum RailContent: Equatable {
    case normal
    case mentions
    case saved
}

/// An in-app ringing 1:1 DM call, surfaced from a VOICE_STATE_UPDATE.
struct IncomingCall: Identifiable {
    let id = UUID()
    let channelId: String
    let callerId: String
    let callerName: String
    let channel: Channel
}

/// Holds the live application data — the user's guilds, the selected guild's
/// channels, and the selected channel's messages — and wires the gateway so
/// incoming `MESSAGE_CREATE` events append in real time.
@MainActor
final class AppStore: ObservableObject {
    @Published var guilds: [Guild] = []
    /// Per-device custom guild-rail order (ids). Matches the web, which also
    /// keeps this client-side. Empty = natural API order.
    @Published var guildOrder: [String] = UserDefaults.standard.stringArray(forKey: "zk.guildOrder") ?? []

    /// Guilds in the user's preferred order: saved ids first (in order), then
    /// any not-yet-ordered guild appended in natural order.
    var orderedGuilds: [Guild] {
        guard !guildOrder.isEmpty else { return guilds }
        var byId = Dictionary(guilds.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var result: [Guild] = []
        for id in guildOrder {
            if let g = byId.removeValue(forKey: id) { result.append(g) }
        }
        for g in guilds where byId[g.id] != nil { result.append(g) }
        return result
    }
    func setGuildOrder(_ ids: [String]) {
        guildOrder = ids
        UserDefaults.standard.set(ids, forKey: "zk.guildOrder")
    }

    /// Locally-collapsed folder ids (per-device, like the web).
    @Published var collapsedFolders: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "zk.collapsedFolders") ?? [])
    func toggleFolderCollapsed(_ id: String) {
        if collapsedFolders.contains(id) { collapsedFolders.remove(id) } else { collapsedFolders.insert(id) }
        UserDefaults.standard.set(Array(collapsedFolders), forKey: "zk.collapsedFolders")
    }

    /// Active full-page rail destination (Discover / Admin / Settings…).
    /// Hosted inline on iPad/Mac (rail stays visible), full-screen on iPhone.
    @Published var railPage: RailPage?

    /// Open a rail page; tapping its icon again closes it (the wide
    /// layout's exit affordance — the back chevron is phone-only).
    func toggleRailPage(_ page: RailPage) {
        railPage = (railPage == page) ? nil : page
    }

    /// Locally-collapsed channel-list categories (per-device, like the web).
    @Published var collapsedCategories: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "zk.collapsedCategories") ?? [])
    func toggleCategoryCollapsed(_ id: String) {
        if collapsedCategories.contains(id) { collapsedCategories.remove(id) } else { collapsedCategories.insert(id) }
        UserDefaults.standard.set(Array(collapsedCategories), forKey: "zk.collapsedCategories")
    }
    @Published var channels: [Channel] = []
    @Published var messages: [Message] = []

    @Published var selectedGuild: Guild?
    @Published var selectedChannel: Channel?

    /// Direct-message channels for the current user.
    @Published var dms: [Channel] = []
    @Published var relationships: [Relationship] = []
    @Published var loadingRelationships = false
    @Published var mentions: [Mention] = []
    @Published var loadingMentions = false
    @Published var discoverable: [DiscoverableGuild] = []
    @Published var loadingDiscoverable = false
    @Published var adminStats: AdminStats?
    @Published var loadingAdminStats = false
    @Published var adminUsers: [AdminUser] = []
    @Published var loadingAdminUsers = false
    @Published var adminGuilds: [AdminGuild] = []
    @Published var loadingAdminGuilds = false
    @Published var adminStorage: AdminStorage?
    @Published var loadingAdminStorage = false
    @Published var storageGcResult: String?
    @Published var guildStickers: [Sticker] = []
    @Published var guildEmojis: [GuildEmoji] = []
    @Published var emojiImages: [String: UIImage] = [:]
    private var emojiInFlight: Set<String> = []
    @Published var channelWebhooks: [Webhook] = []
    @Published var loadingWebhooks = false
    @Published var scheduledMessages: [ScheduledMessage] = []
    @Published var loadingScheduled = false
    @Published var channelOverrides: [PermissionOverride] = []
    @Published var loadingOverrides = false
    @Published var selfAssignableRoles: [Role] = []
    @Published var loadingSelfRoles = false
    @Published var reactionRoles: [ReactionRoleMapping] = []
    @Published var loadingReactionRoles = false
    @Published var events: [ScheduledEvent] = []
    @Published var loadingEvents = false
    @Published var eventAttendees: [EventRsvp] = []
    @Published var loadingAttendees = false
    @Published var myEvents: [MyEvent] = []
    @Published var loadingMyEvents = false
    @Published var switcherChannels: [Channel] = []
    @Published var loadingSwitcher = false

    /// Resolve a `:name:` token to a guild emoji.
    var emojiByName: [String: GuildEmoji] {
        var m: [String: GuildEmoji] = [:]
        for e in guildEmojis { m[e.name] = e }
        return m
    }

    /// Active theme id (matches the web `THEMES` ids). Persisted in
    /// UserDefaults; setting it via `setTheme` re-renders the UI.
    @Published var themeId: String = UserDefaults.standard.string(forKey: "zk.theme") ?? "default"

    /// Process-wide reference so the PushKit VoIP handler can connect the
    /// gateway from a background launch (no SwiftUI scene exists then). Weak so
    /// it never keeps the store alive on its own.
    static weak var shared: AppStore?

    init() {
        // Apply the saved theme before the first render so there's no flash
        // of the default palette on launch.
        Theme.current = ThemePalette.palette(for: themeId)
        wireCallKit()
        wirePushRouting()
        Self.shared = self
    }

    /// CallKit → store: the system call screen's Answer/End/Mute drive the
    /// same paths as the in-app buttons.
    private func wireCallKit() {
        CallManager.shared.onAnswer = { [weak self] channelId in
            guard let self else { return }
            // Do NOT report the CallKit call ended here. Reporting ended on
            // answer (it used reason .declinedElsewhere) tore down the
            // AVAudioSession CallKit had just activated, leaving the answered
            // call with no audio. The CallKit call now stays active for the
            // call's lifetime; CallManager gates the LiveKit audio engine off
            // until CallKit's didActivate fires (see CallManager). Hangup
            // still flows through onEnd → leaveCurrentVoice → callEnded.
            if let call = self.incomingCall, call.channelId == channelId {
                self.incomingCall = nil
                self.openVoice(call.channel)
            } else if let dm = self.dms.first(where: { $0.id == channelId }) {
                // Answered from a notification before the gateway ring
                // arrived — join directly.
                self.openVoice(dm)
            } else {
                // Cold start: a VoIP push relaunched the app and the user
                // answered from the lock screen before the gateway ring
                // (incomingCall) or the DM list (dms) were ready. Without
                // this the CallKit UI dismissed and nothing joined — the
                // caller kept ringing into a dead end. Load DMs once and
                // join. Mirrors handleIncomingCall's loadDMs-and-retry.
                Task { [weak self] in
                    guard let self else { return }
                    await self.loadDMs()
                    if let dm = self.dms.first(where: { $0.id == channelId }) {
                        self.openVoice(dm)
                    }
                }
            }
        }
        CallManager.shared.onEnd = { [weak self] channelId in
            guard let self else { return }
            if let call = self.incomingCall, call.channelId == channelId {
                self.incomingCall = nil
                Task { await self.api.declineCall(channelId: channelId) }
            } else if self.voiceChannelId == channelId {
                Task { await self.leaveCurrentVoice() }
            }
        }
        CallManager.shared.onSetMuted = { [weak self] muted in
            guard let self else { return }
            Task {
                if self.voice.isMuted != muted { await self.toggleVoiceMute() }
            }
        }
        CallManager.shared.onAudioActivated = { [weak self] in
            guard let self else { return }
            // CallKit just activated the session — make sure the mic is
            // actually capturing on it (the room connected with the engine
            // gated, so the initial publish may not have started capture).
            Task { await self.voice.ensureMicEnabled() }
        }
        NotificationDelegate.shared.visibleChannelId = { [weak self] in
            self?.selectedChannel?.id
        }
    }

    /// Notification taps / call actions → store navigation.
    private func wirePushRouting() {
        NotificationCenter.default.addObserver(
            forName: .zkOpenChannel, object: nil, queue: .main
        ) { [weak self] note in
            guard let dict = note.object as? [String: Any],
                  let channelId = dict["channelId"] as? String else { return }
            let autojoin = (dict["autojoin"] as? Bool) ?? false
            Task { @MainActor in self?.openFromPush(channelId: channelId, autojoin: autojoin) }
        }
        NotificationCenter.default.addObserver(
            forName: .zkCallAction, object: nil, queue: .main
        ) { [weak self] note in
            guard let dict = note.object as? [String: Any],
                  let channelId = dict["channelId"] as? String,
                  let action = dict["action"] as? String else { return }
            Task { @MainActor in
                guard let self else { return }
                if action == "accept" {
                    CallManager.shared.answerFromApp(channelId: channelId)
                } else {
                    self.incomingCall = nil
                    CallManager.shared.callEnded(channelId: channelId, remoteEnded: false)
                    await self.api.declineCall(channelId: channelId)
                }
            }
        }
    }

    /// Navigate to a channel from a notification tap; loads DMs first when
    /// the target isn't in memory yet (cold launch).
    func openFromPush(channelId: String, autojoin: Bool) {
        func open(_ ch: Channel) {
            if ch.isDM { showDMs() }
            if autojoin { openVoice(ch) } else { selectChannel(ch) }
        }
        if let dm = dms.first(where: { $0.id == channelId }) { open(dm); return }
        if let ch = channels.first(where: { $0.id == channelId }) { open(ch); return }
        Task {
            await loadDMs()
            if let dm = dms.first(where: { $0.id == channelId }) { open(dm) }
        }
    }

    func setTheme(_ id: String) {
        Theme.current = ThemePalette.palette(for: id)
        themeId = id
        UserDefaults.standard.set(id, forKey: "zk.theme")
        applyAppIcon(for: id)
    }

    /// Switch the home-screen icon to match the theme's accent scheme. iOS
    /// shows a system alert whenever the icon actually changes; the guard
    /// avoids redundant calls. Not called on launch — iOS persists the
    /// chosen icon across launches on its own.
    private func applyAppIcon(for id: String) {
        guard UIApplication.shared.supportsAlternateIcons else { return }
        let scheme = (id == "default" || id == "oled")
            ? "default" : id.replacingOccurrences(of: "-oled", with: "")
        let iconName: String?
        switch scheme {
        case "sunset": iconName = "IconSunset"
        case "forest": iconName = "IconForest"
        case "crimson": iconName = "IconCrimson"
        case "blossom": iconName = "IconBlossom"
        case "amethyst": iconName = "IconAmethyst"
        default: iconName = nil  // primary AppIcon
        }
        if UIApplication.shared.alternateIconName == iconName { return }
        UIApplication.shared.setAlternateIconName(iconName)
    }
    @Published var family: FamilySummary?
    @Published var loadingFamily = false
    /// Per-child restriction settings (childId → restrictions), loaded when a
    /// parent opens a child's controls.
    @Published var childRestrictions: [String: ChildRestrictions] = [:]
    @Published var members: [String: GuildMember] = [:]
    /// Roles for the selected guild (drives name colors + hoisted sections).
    @Published var roles: [Role] = []
    /// When non-nil, a ProfileCard sheet is shown for this user.
    @Published var profileUser: PublicUser?
    /// Drives the guild member-list sheet.
    @Published var showMembers = false
    /// The message the composer is currently replying to (nil = not replying).
    @Published var replyingTo: Message?
    /// Pinned messages for the open channel + its loading flag.
    @Published var pins: [Message] = []
    @Published var loadingPins = false
    /// When non-nil, a full-screen image viewer is shown.
    @Published var lightbox: LightboxImage?
    /// Saved messages (bookmarks) + which loaded message ids are saved.
    @Published var saved: [SavedMessageItem] = []
    @Published var loadingSaved = false
    @Published var savedIds: Set<String> = []
    /// Live presence map: userId → status ("online"/"idle"/"dnd"/"offline").
    @Published var presence: [String: String] = [:]
    /// Per-user typing expiry for the *selected* channel (userId → when it lapses).
    @Published var typing: [String: Date] = [:]
    /// True when the DMs surface (rather than a guild) is selected.
    @Published var inDMs = false
    @Published var railContent: RailContent = .normal

    /// Navigation drill-down beyond the root list (message views, thread lists).
    @Published var stack: [Route] = []
    /// Threads / posts for the current thread-list route.
    @Published var threadList: [Channel] = []

    /// Voice: connected channel id, the roster of voice states, and flags.
    @Published var voiceChannelId: String?
    @Published var voiceStates: [VoiceState] = []
    /// Global per-user voice presence (every channel, not just the active
    /// call) — powers the participant lists under voice rows in the channel
    /// sidebar, mirroring the web's voiceStatesByUser map.
    @Published var voiceStatesByUser: [String: VoiceState] = [:]
    @Published var voiceConnecting = false
    @Published var voiceTokenMissing = false
    /// Re-entrancy guard: leaveCurrentVoice has many overlapping callers and
    /// must run exactly once per teardown (concurrent Room teardowns crashed
    /// the LiveKit audio worker). Not @Published — internal serialization only.
    private var isLeavingVoice = false
    @Published var stageParticipants: [StageParticipant] = []
    @Published var stageChannelId: String?
    @Published var stageConnecting = false
    @Published var stageTokenMissing = false
    @Published var myStageSpeaker = false
    @Published var incomingCall: IncomingCall?
    let voice = VoiceManager()

    @Published var loadingGuilds = false
    @Published var loadingDMs = false
    @Published var loadingChannels = false
    @Published var loadingMessages = false
    /// True while fetching an older page; gates the load-older trigger.
    @Published var loadingOlder = false
    /// False once a page returns fewer than the limit (no more history).
    @Published var hasMoreMessages = true
    /// After prepending an older page, set to the previously-oldest message id
    /// so the message list can restore the scroll position (avoid a jump).
    @Published var pendingScrollAnchorId: String?
    /// Per-channel read markers (channelId → ReadState), driving unread dots
    /// and mention badges on channels and DMs.
    @Published var readStates: [String: ReadState] = [:]
    /// Frozen last-read message id for the open channel, captured before acking,
    /// so the "New messages" divider stays put where the user left off.
    @Published var unreadBoundaryId: String?
    @Published var loadingThreads = false
    @Published var uploading = false
    @Published var searching = false
    @Published var searchResults: [Message] = []
    // Cross-DM search (spans every DM conversation) — separate from the
    // per-channel search state above so the two never bleed into each other.
    @Published var dmSearching = false
    @Published var dmSearchResults: [Message] = []
    // Active auth sessions (Settings → Active Sessions).
    @Published var sessions: [UserSession] = []
    @Published var sessionsLoading = false
    @Published var errorText: String?

    // ── E2EE (DMs) ──────────────────────────────────────────────────────────
    /// Decrypted plaintext by message id (only populated for encrypted ones).
    @Published var decrypted: [String: String] = [:]
    /// Bumped whenever a channel key is added/removed so views re-render.
    @Published private(set) var e2eeUnlockVersion = 0
    /// Last unlock/enable error, surfaced by the unlock UI.
    @Published var e2eeError: String?

    /// In-memory key cache (channelId → raw 32-byte key); backed by Keychain.
    private var e2eeKeyCache: [String: Data] = [:]
    private let keychain = KeychainStore()

    let api = APIClient.shared
    let gateway = Gateway()

    /// Current user's id — set at start; used to attribute reaction events.
    var currentUserId: String?
    /// The signed-in user, used to author optimistic message placeholders.
    @Published var currentUser: SelfUser?

    // MARK: Automatic presence (online ↔ idle)
    //
    // "Online" is an AUTOMATIC mode: while the chosen status is online the app
    // flips to idle (5+ min without UI interaction and not talking) and back to
    // online on activity. A MANUALLY chosen idle, dnd, and invisible are all
    // manual and untouched (tracked via `autoSetIdle` so a user-set idle is
    // never auto-bounced to online). Offline is handled by the gateway
    // disconnect (background/close). Pushes go through `autoStatusPush`
    // (wired to Session.setStatus) so it reuses the normal status path; the
    // chosen status is read via `currentChosenStatus`. AFK voice-channel
    // relocation is a separate, already-built server sweep (guilds.afkChannelId).
    static let autoIdleThresholdSeconds: TimeInterval = 300
    /// Pushes an effective status to the server (set by the app to Session.setStatus).
    var autoStatusPush: ((String) async -> Void)?
    /// Reads the user's current chosen status (set by the app to Session.currentUser.status).
    var currentChosenStatus: (() -> String)?
    private var lastInteractionAt = Date()
    private var appActive = true
    /// True only when the auto-presence machine itself moved the user to
    /// "idle" (online → idle on inactivity). Mirrors the web client's
    /// `autoSetRef`: it lets us restore idle → online when the user becomes
    /// active again WITHOUT ever stomping a manually-chosen "idle" (or dnd /
    /// invisible). Cleared on any manual status pick (noteManualStatusChange).
    private var autoSetIdle = false
    private var autoPresenceTimer: Timer?
    /// Becomes true after the first gateway READY. A later READY means we
    /// reconnected after a drop, so we re-sync state (events were missed while
    /// disconnected) — mirroring the web client re-bootstrapping on reconnect.
    private var didInitialReady = false

    var gatewayStatus: Gateway.Status { gateway.status }

    // MARK: Lifecycle

    func start(token: String, user: SelfUser?) {
        currentUserId = user?.id
        currentUser = user
        gateway.onEvent = { [weak self] name, data in
            self?.handleEvent(name, data)
        }
        gateway.connect(token: token)
        Task { await loadGuilds() }
        Task { await loadDMs() }
        Task { await loadReadStates() }
        startAutoPresence()
    }

    /// Callers (e.g. a 1:1 ring) whose hangup arrived before `dms` was loaded
    /// on a cold VoIP launch — the channel can't be resolved yet, so we stash
    /// the caller id and dismiss the CallKit ring once `dms` loads.
    private var pendingCallerCancels: Set<String> = []

    /// Connect the gateway from a background VoIP launch (PushKit) so the
    /// caller's hangup arrives as a normal event while iOS grants runtime for
    /// the active CallKit ring (no fragile cancel push needed).
    func ensureGatewayConnected(token: String, user: SelfUser?) {
        if currentUserId == nil {
            // Cold: never started this process — full start (connects + loads
            // DMs so the cancel can resolve the channel from the caller).
            start(token: token, user: user)
        } else {
            // Warm: the socket may be an iOS-suspended zombie — revive it so
            // the hangup event actually arrives.
            gateway.forceReconnect()
        }
    }

    /// Called when the app returns to the foreground. iOS commonly kills the
    /// gateway socket in the background with no close event, so we force an
    /// immediate reconnect. No-op if signed out.
    func foregroundReconnect() {
        guard currentUserId != nil else { return }
        gateway.forceReconnect()
    }

    // MARK: Automatic presence state machine

    /// Pure decision: the status to push, or nil when auto shouldn't act.
    /// The auto-machine only ever touches the online↔idle band, and ONLY for
    /// transitions it owns:
    ///   • chosen "online" + inactive  → "idle"   (auto-away)
    ///   • auto-set "idle" + active     → "online" (auto-return)
    /// A MANUALLY chosen "idle" (autoSetIdle == false), or "dnd"/"invisible",
    /// is left alone so the user's pick persists across launches/reconnects.
    /// Backgrounded → nil (the gateway disconnect sets offline; don't fight it).
    static func desiredAutoStatus(
        chosen: String,
        autoSetIdle: Bool,
        appActive: Bool,
        secondsSinceInteraction: TimeInterval,
        talking: Bool
    ) -> String? {
        guard appActive else { return nil }
        let active = talking || secondsSinceInteraction < autoIdleThresholdSeconds
        if chosen == "online" {
            return active ? nil : "idle"
        }
        if chosen == "idle", autoSetIdle {
            return active ? "online" : nil
        }
        // Manual idle, dnd, invisible: never auto-act.
        return nil
    }

    /// The user manually picked a status — surrender automatic idle control so
    /// the choice sticks (a manual "idle" must not be auto-bounced to online,
    /// and a manual "online" re-enables auto-away from a clean slate).
    func noteManualStatusChange() { autoSetIdle = false }

    /// Record a user interaction (resets the idle clock). `evaluate: false` is
    /// the cheap hot path for app-wide touch/scroll — it ONLY bumps the
    /// timestamp (this fires constantly during scroll), letting the 60s tick
    /// handle transitions. Discrete actions (send, open channel) use the
    /// default `true` for a prompt re-evaluate (e.g. idle→online immediately).
    func noteInteraction(evaluate: Bool = true) {
        lastInteractionAt = Date()
        if evaluate { evaluateAutoPresence() }
    }

    /// Foreground/background transitions feed the state machine.
    func setAppActive(_ active: Bool) {
        appActive = active
        if active { lastInteractionAt = Date() }
        evaluateAutoPresence()
    }

    private func startAutoPresence() {
        appActive = true
        lastInteractionAt = Date()
        autoPresenceTimer?.invalidate()
        // Re-check periodically so the idle transition fires without a UI event
        // (and talking/idle changes are caught within the interval).
        autoPresenceTimer = Timer.scheduledTimer(withTimeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.evaluateAutoPresence() }
        }
        evaluateAutoPresence()
    }

    private func stopAutoPresence() {
        autoPresenceTimer?.invalidate()
        autoPresenceTimer = nil
    }

    /// Compute the desired auto status and push it if it differs from the
    /// current chosen status. No-op when auto shouldn't act.
    func evaluateAutoPresence() {
        guard let uid = currentUserId else { return }
        let chosen = currentChosenStatus?() ?? "online"
        let talking = voice.speakingUserIds.contains(uid)
        let secs = Date().timeIntervalSince(lastInteractionAt)
        guard let desired = Self.desiredAutoStatus(
            chosen: chosen, autoSetIdle: autoSetIdle, appActive: appActive,
            secondsSinceInteraction: secs, talking: talking
        ) else { return }
        guard desired != chosen else { return }
        // Track which side of the auto-away transition we drove so a manual
        // idle is never mistaken for an auto idle on the next evaluation.
        if desired == "idle" { autoSetIdle = true }
        else if desired == "online" { autoSetIdle = false }
        Task { await autoStatusPush?(desired) }
    }

    func stop() {
        stopAutoPresence()
        gateway.disconnect()
        currentUserId = nil
        currentUser = nil
        didInitialReady = false
        readStates = [:]
        unreadBoundaryId = nil
        guilds = []
        channels = []
        messages = []
        dms = []
        relationships = []
        typing = [:]
        searchResults = []
        dmSearchResults = []
        sessions = []
        mentions = []
        discoverable = []
        adminStats = nil
        family = nil
        members = [:]
        roles = []
        profileUser = nil
        showMembers = false
        replyingTo = nil
        pins = []
        lightbox = nil
        saved = []
        savedIds = []
        presence = [:]
        inDMs = false
        stack = []
        threadList = []
        voiceChannelId = nil
        voiceStates = []
        voiceStatesByUser = [:]
        voiceTokenMissing = false
        incomingCall = nil
        stageChannelId = nil
        stageParticipants = []
        myStageSpeaker = false
        stageTokenMissing = false
        Task { await voice.disconnect() }
        currentUserId = nil
        selectedGuild = nil
        selectedChannel = nil
        decrypted = [:]
        e2eeKeyCache = [:]
        e2eeError = nil
    }

    // MARK: Selection

    func selectGuild(_ guild: Guild) {
        railPage = nil
        railContent = .normal
        inDMs = false
        resetStack()
        selectedChannel = nil
        // Wide layout: re-tapping the current guild shouldn't blank the
        // detail pane — land back on its first text channel.
        if guild.id == selectedGuild?.id {
            if isWideLayout, let first = channels.first(where: { $0.isText && !$0.isThread }) {
                selectChannel(first)
            }
            return
        }
        guard guild.id != selectedGuild?.id else { return }
        selectedGuild = guild
        channels = []
        messages = []
        members = [:]
        Task { await loadChannels(guild) }
        Task { await loadMembers(guild) }
        Task { await loadRoles(guild) }
    }

    func showDMs() {
        railPage = nil
        railContent = .normal
        inDMs = true
        resetStack()
        selectedChannel = nil
        if dms.isEmpty { Task { await loadDMs() } }
    }

    func showMentions() { railPage = nil; railContent = .mentions; resetStack() }
    func showSaved() { railPage = nil; railContent = .saved; resetStack() }

    // MARK: Navigation stack

    /// True when MainView is presenting the persistent three-pane layout
    /// (iPad / Mac, regular width). Changes route semantics from push
    /// (drill-down) to replace (master-detail) and hides back buttons.
    @Published var isWideLayout = false

    func selectChannel(_ channel: Channel) { noteInteraction(); push(.messages(channel)) }
    func openThreads(_ parent: Channel) { push(.threadList(parent)) }
    func clearChannel() { pop() }

    func push(_ route: Route) {
        // Wide layout: sidebar selections REPLACE the detail pane instead of
        // stacking. Drill-downs within the detail (forum post -> its thread)
        // still stack so "back to posts" works: we only replace when the
        // current top is a leaf the sidebar owns (messages/voice) or empty.
        if isWideLayout {
            // Navigating to content always exits the mentions/saved inbox in
            // the wide layout (there's no back affordance to return through;
            // the rail highlight should track the visible pane).
            railContent = .normal
            switch stack.last {
            case nil, .messages?, .voice?:
                stack = [route]
            case .threadList?:
                // From a forum's post list, opening a post stacks; switching
                // channels from the sidebar replaces.
                if case .messages(let c) = route, c.isThread {
                    stack.append(route)
                } else {
                    stack = [route]
                }
            }
            return
        }
        stack.append(route)
    }
    func pop() { if !stack.isEmpty { stack.removeLast() } }
    private func resetStack() { stack = []; threadList = [] }

    /// Called by MessageListView.onAppear to load the channel it shows.
    /// Guarded by id so a re-appear (keyboard etc.) doesn't reload.
    func openChannel(_ channel: Channel) {
        guard selectedChannel?.id != channel.id else { return }
        selectedChannel = channel
        messages = []
        // Drop decrypted E2EE plaintext from the channel we're leaving —
        // it otherwise stayed resident for the whole session (only relock/
        // sign-out cleared it), defeating the "plaintext doesn't linger in
        // memory" intent and growing unbounded. decryptVisible() repopulates
        // for the new channel right after loadMessages.
        decrypted = [:]
        typing = [:]
        replyingTo = nil
        pins = []
        hasMoreMessages = true
        loadingOlder = false
        pendingScrollAnchorId = nil
        // Freeze the unread boundary (last-read id) before we ack on open, but
        // only when the channel actually has unread messages past it.
        if let prevRead = readStates[channel.id]?.lastMessageId,
           let last = channel.lastMessageId, snowflakeGreater(last, than: prevRead) {
            unreadBoundaryId = prevRead
        } else {
            unreadBoundaryId = nil
        }
        // If a locally cached key no longer matches this DM's verifier (it was
        // re-keyed, or belonged to a different password), drop it so we prompt
        // for the password rather than silently failing to decrypt.
        purgeStaleE2EEKey(channel)
        Task { await loadMessages(channel); await loadSavedMembership(messages.map { $0.id }); markChannelRead(channel) }
        Task { await loadPins(channel) }
    }

    /// Resolved status for a user — live presence wins over the DTO fallback.
    func status(for userId: String?, fallback: String? = nil) -> String {
        if let userId, let s = presence[userId] { return s }
        return fallback ?? "offline"
    }

    // MARK: Loading

    func loadGuilds() async {
        loadingGuilds = true; errorText = nil
        defer { loadingGuilds = false }
        do {
            guilds = try await api.guilds()
            // Auto-select the first guild for a faster first paint.
            if selectedGuild == nil, let first = guilds.first {
                selectGuild(first)
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func loadDMs() async {
        loadingDMs = true
        defer { loadingDMs = false }
        // Snapshot presence BEFORE the network call suspends. Any gateway
        // PRESENCE_UPDATE applied while we're awaiting mutates `presence`
        // (same MainActor, so it's serialized, not a data race) — diffing
        // against this snapshot tells us which users got a fresher live
        // status mid-fetch. See the merge note below.
        let presenceBefore = presence
        do {
            let fetched = try await api.listDMs()
            // Most-recently-active first. Numeric snowflake comparison — plain
            // string > is wrong across id-length boundaries ("99" > "100").
            // Channels with no messages fall back to their own id (creation).
            dms = fetched.sorted {
                snowflakeGreater($0.lastMessageId ?? $0.id, than: $1.lastMessageId ?? $1.id)
            }
            // A caller's hangup may have arrived before `dms` loaded on a cold
            // VoIP launch — now that DMs are here, dismiss those CallKit rings.
            if !pendingCallerCancels.isEmpty {
                for callerId in pendingCallerCancels {
                    if let cid = dms.first(where: {
                        $0.type == "dm" && ($0.recipients?.contains(where: { $0.id == callerId }) ?? false)
                    })?.id {
                        CallManager.shared.remoteCancelled(channelId: cid)
                        if incomingCall?.channelId == cid { incomingCall = nil }
                    }
                }
                pendingCallerCancels.removeAll()
            }
            // Merge presence — DON'T blindly overwrite with REST.
            //
            // REST status is the point-in-time DB baseline, but a live
            // PRESENCE_UPDATE that lands WHILE this fetch is in flight is
            // fresher and must win. Otherwise locking the phone mid-load
            // downgrades a just-online friend back to the stale snapshot, so
            // they show offline until the next event (the bug). We also can't
            // just keep the live map (the old "only-when-missing" guard let a
            // single MISSED update pin a user offline forever).
            //
            // No timestamps exist on the map or the REST status, so we infer
            // freshness by diffing across the await: `presenceBefore` is the
            // pre-suspend snapshot; `presence` now includes any events applied
            // during the network call. Per recipient:
            //   • status changed during the fetch  → a live event won; keep it
            //   • status unchanged during the fetch → apply the REST baseline
            //     (this still repairs a stale/missed-event entry — the whole
            //     reason REST seeding exists).
            var seeded = presence
            for dm in dms {
                for r in dm.recipients ?? [] {
                    guard let s = r.status else { continue }
                    let changedDuringFetch = presence[r.id] != presenceBefore[r.id]
                    if !changedDuringFetch { seeded[r.id] = s }
                }
            }
            // Single assignment — per-entry writes publish N times and
            // re-render every observer once per recipient.
            if seeded != presence { presence = seeded }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Reorder sibling channels within a group (a category, or the
    /// uncategorized top level). Optimistically renumbers local positions so
    /// the list re-sorts immediately; reverts via reload on failure.
    func reorderChannels(_ ordered: [Channel], parentId: String?) async {
        guard let g = selectedGuild else { return }
        var payload: [[String: Any]] = []
        for (i, c) in ordered.enumerated() {
            var entry: [String: Any] = ["id": c.id, "position": i]
            if let parentId { entry["parentId"] = parentId } else { entry["parentId"] = NSNull() }
            payload.append(entry)
        }
        for (i, c) in ordered.enumerated() {
            if let idx = channels.firstIndex(where: { $0.id == c.id }) {
                channels[idx].position = i
                channels[idx].parentId = parentId
            }
        }
        do { try await api.reorderChannels(guildId: g.id, channels: payload) }
        catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            await loadChannels(g)
        }
    }

    func loadChannels(_ guild: Guild) async {
        loadingChannels = true
        defer { loadingChannels = false }
        do {
            let all = try await api.channels(guildId: guild.id)
            // Only this guild, sorted by the server-provided position.
            channels = all.sorted { ($0.position ?? 0) < ($1.position ?? 0) }
            // Wide layout (iPad/Mac): land on the first text channel like the
            // web's "/" route, so the detail pane isn't an empty placeholder.
            if isWideLayout, stack.isEmpty, guild.id == selectedGuild?.id,
               let first = channels.first(where: { $0.isText && !$0.isThread }) {
                selectChannel(first)
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func loadMessages(_ channel: Channel) async {
        loadingMessages = true
        defer { loadingMessages = false }
        do {
            let fetched = try await api.messages(channelId: channel.id, limit: 50)
            // The API returns newest-first; show oldest-first (bottom = newest).
            guard channel.id == selectedChannel?.id else { return }
            var merged = fetched.sorted { $0.createdAt < $1.createdAt }
            // Keep anything that arrived over the gateway while the fetch was
            // in flight (it's in `messages` but not in the page) — replacing
            // the array outright dropped those rows.
            let fetchedIds = Set(merged.map { $0.id })
            let live = messages.filter {
                $0.channelId == channel.id && !fetchedIds.contains($0.id)
            }
            if !live.isEmpty {
                merged.append(contentsOf: live)
                merged.sort { $0.createdAt < $1.createdAt }
            }
            messages = merged
            // A full page implies there may be older history to page back into.
            hasMoreMessages = fetched.count >= 50
            decryptVisible()
        } catch {
            // Access to the open channel was revoked (made private / deleted)
            // out from under us — the server denies the read. Pop out so its
            // stale on-screen history isn't left readable. (Defense-in-depth on
            // top of the CHANNEL_DELETE pop and the reconnect re-validate.)
            if let status = (error as? APIError)?.status, status == 403 || status == 404,
               channel.id == selectedChannel?.id {
                clearChannel()
            } else {
                errorText = (error as? APIError)?.message ?? error.localizedDescription
            }
        }
    }

    /// Page back into older history: fetch the 50 messages before the current
    /// oldest and prepend them, mirroring the web's infinite scroll. Records a
    /// scroll anchor so the list can hold the user's position after prepend.
    func loadOlderMessages() async {
        guard let channel = selectedChannel, !loadingOlder, !loadingMessages,
              hasMoreMessages, let oldest = messages.first else { return }
        loadingOlder = true
        defer { loadingOlder = false }
        do {
            let older = try await api.messages(channelId: channel.id, limit: 50, before: oldest.id)
            guard channel.id == selectedChannel?.id else { return }
            if older.isEmpty { hasMoreMessages = false; return }
            let sorted = older.sorted { $0.createdAt < $1.createdAt }
            let existing = Set(messages.map { $0.id })
            let fresh = sorted.filter { !existing.contains($0.id) }
            if fresh.isEmpty { hasMoreMessages = false; return }
            pendingScrollAnchorId = oldest.id
            messages.insert(contentsOf: fresh, at: 0)
            hasMoreMessages = older.count >= 50
            decryptVisible()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    // MARK: Read state / unread

    func loadReadStates() async {
        guard let states = try? await api.listReadStates() else { return }
        var map: [String: ReadState] = [:]
        for s in states { map[s.channelId] = s }
        readStates = map
    }

    /// Pending coalesced server acks, keyed by channel id. Each MESSAGE_CREATE
    /// in the open channel calls markChannelRead; without coalescing that was
    /// one POST /ack per incoming message in a busy channel. The local marker
    /// updates immediately (UI stays correct); the network ack trails on a
    /// short timer and always sends the NEWEST marker at fire time.
    private var pendingAckTasks: [String: Task<Void, Never>] = [:]

    /// Mark a channel read up to its newest known message and ack server-side.
    func markChannelRead(_ channel: Channel) {
        let newest = (channel.id == selectedChannel?.id ? messages.last?.id : nil) ?? channel.lastMessageId
        guard let last = newest, !last.isEmpty else { return }
        if let rs = readStates[channel.id], rs.lastMessageId == last, (rs.mentionCount ?? 0) == 0 { return }
        readStates[channel.id] = ReadState(channelId: channel.id, lastMessageId: last, mentionCount: 0)
        // Trailing-debounce the server ack (1s). Cancelling the prior task
        // also removes the interleaved-response race: at most one ack per
        // channel is in flight, carrying the newest local marker.
        pendingAckTasks[channel.id]?.cancel()
        let channelId = channel.id
        pendingAckTasks[channelId] = Task { [weak self] in
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            guard !Task.isCancelled, let self else { return }
            self.pendingAckTasks[channelId] = nil
            guard let marker = self.readStates[channelId]?.lastMessageId, !marker.isEmpty else { return }
            if let rs = try? await self.api.ackChannel(channelId: channelId, messageId: marker) {
                // Only apply if the server marker is >= the local one — a slow
                // response for an older ack must not regress a newer marker
                // (the server itself upserts with GREATEST).
                let local = self.readStates[channelId]?.lastMessageId
                let apply: Bool
                if let serverMarker = rs.lastMessageId, let localMarker = local {
                    apply = serverMarker == localMarker || snowflakeGreater(serverMarker, than: localMarker)
                } else {
                    apply = (local == nil)
                }
                if apply { self.readStates[channelId] = rs }
            }
        }
    }

    /// True when a channel has messages newer than the user's last ack.
    func isChannelUnread(_ channel: Channel) -> Bool {
        guard let last = channel.lastMessageId, !last.isEmpty else { return false }
        if channel.id == selectedChannel?.id { return false }
        guard let rs = readStates[channel.id], let read = rs.lastMessageId, !read.isEmpty else {
            return true
        }
        return snowflakeGreater(last, than: read)
    }

    func mentionCount(for channelId: String) -> Int {
        readStates[channelId]?.mentionCount ?? 0
    }

    /// Keep a channel/DM's lastMessageId current as messages arrive, so unread
    /// indicators react even for channels that aren't open.
    private func bumpChannelLastMessage(_ channelId: String, _ messageId: String) {
        if let i = channels.firstIndex(where: { $0.id == channelId }),
           (channels[i].lastMessageId.map { snowflakeGreater(messageId, than: $0) } ?? true) {
            channels[i].lastMessageId = messageId
        }
        if let i = dms.firstIndex(where: { $0.id == channelId }),
           (dms[i].lastMessageId.map { snowflakeGreater(messageId, than: $0) } ?? true) {
            dms[i].lastMessageId = messageId
        }
    }

    // MARK: Threads / forums

    func loadThreads(_ parent: Channel) async {
        loadingThreads = true
        defer { loadingThreads = false }
        do {
            // Server returns active-first, then archived.
            threadList = try await api.threads(channelId: parent.id)
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func createForumPost(in forum: Channel, title: String, content: String) async -> Channel? {
        do {
            let result = try await api.createForumPost(forumChannelId: forum.id, title: title, content: content)
            threadList.insert(result.post, at: 0)
            return result.post
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            return nil
        }
    }

    func createThread(from message: Message, in channel: Channel, name: String?) async -> Channel? {
        do {
            return try await api.createThread(channelId: channel.id, messageId: message.id, name: name)
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            return nil
        }
    }

    // MARK: Voice

    func openVoice(_ channel: Channel) {
        if channel.isE2EE && e2eeKey(for: channel) == nil {
            e2eeError = "Unlock this conversation to start an encrypted call."
            return
        }
        push(.voice(channel))
        if channel.isStage {
            if stageChannelId != channel.id { Task { await joinStage(channel) } }
        } else if voiceChannelId != channel.id {
            Task { await joinVoice(channel) }
        }
    }

    func joinVoice(_ channel: Channel) async {
        voiceConnecting = true
        voiceTokenMissing = false
        defer { voiceConnecting = false }
        do {
            // One room at a time: properly leave a stage (server + SFU) before
            // joining voice — otherwise the server keeps us in the stage roster
            // and the old LiveKit room stays connected.
            if stageChannelId != nil { await leaveStage() }
            // Own the channel BEFORE the network round-trip so the outgoing
            // "Calling…" overlay (outgoingCall) and the CallKit End handler can
            // reference it while the join is in flight — without this, an End
            // pressed mid-join saw voiceChannelId == nil and failed to hang up.
            voiceChannelId = channel.id
            let res = try await api.joinVoice(channelId: channel.id)
            // Abort if a leave/hangup raced the in-flight join (voiceChannelId
            // was cleared/changed) — otherwise we'd connect a room nobody's in.
            guard voiceChannelId == channel.id else { return }
            voiceStates = res.channelVoiceStates
            // Merge the authoritative snapshot into the sidebar presence map.
            for vs in res.channelVoiceStates { voiceStatesByUser[vs.userId] = vs }
            // (CallKit is ring-only now — outgoing calls don't register a
            // system call; the in-app Calling… overlay handles the UX and
            // LiveKit keeps full ownership of the audio session.)
            if let token = res.token, let url = res.wsUrl, !token.isEmpty, !url.isEmpty {
                let key: Data? = channel.isE2EE ? e2eeKey(for: channel) : nil
                await voice.connect(url: url, token: token, e2eeKey: key)
                // Leave raced the connect — tear the just-connected room back down.
                guard voiceChannelId == channel.id else { await voice.disconnect(); return }
            } else {
                voiceTokenMissing = true
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            voiceChannelId = nil
        }
    }

    func leaveCurrentVoice() async {
        // Collapse the many overlapping teardown triggers (red button, CallKit
        // End, the 1:1 auto-end Task, READY reconciliation, self-evict) into a
        // single teardown. Without this, two leaveCurrentVoice runs raced into
        // two Room teardowns and crashed LiveKit's audio worker thread.
        guard !isLeavingVoice else { return }
        isLeavingVoice = true
        defer { isLeavingVoice = false }
        let id = voiceChannelId
        voiceChannelId = nil
        voiceStates = []
        voiceTokenMissing = false
        // For a 1:1 DM, purge the whole channel's presence rows — not just our
        // own — so a missed peer LEAVE can't strand a stale callee row that
        // makes the NEXT outgoing call think the callee already answered (the
        // "caller dropped straight into the call" bug). Guild/group voice keeps
        // other participants visible in the sidebar after we leave, so there we
        // only remove ourselves.
        if let id, let dm = dms.first(where: { $0.id == id }), dm.type == "dm" {
            voiceStatesByUser = voiceStatesByUser.filter { $0.value.channelId != id }
        } else if let uid = currentUserId {
            voiceStatesByUser.removeValue(forKey: uid)
        }
        popVoiceRoutes()
        if let id { CallManager.shared.callEnded(channelId: id, remoteEnded: false) }
        await voice.disconnect()
        if let id { await api.leaveVoice(channelId: id) }
    }

    /// Remove any voice screens from the navigation stack — hanging up
    /// should never leave the user stranded on a dead call UI.
    private func popVoiceRoutes() {
        stack.removeAll { route in
            if case .voice = route { return true }
            return false
        }
    }

    /// Upload a new icon/banner for the selected guild (MANAGE_GUILD).
    func uploadGuildImage(kind: String, filename: String, contentType: String, data: Data) async -> String? {
        guard let guild = selectedGuild else { return "No server selected." }
        do {
            let updated: Guild = kind == "banner"
                ? try await api.uploadGuildBanner(guildId: guild.id, filename: filename, contentType: contentType, data: data)
                : try await api.uploadGuildIcon(guildId: guild.id, filename: filename, contentType: contentType, data: data)
            if let i = guilds.firstIndex(where: { $0.id == updated.id }) { guilds[i] = updated }
            selectedGuild = updated
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Stage channels

    func joinStage(_ channel: Channel) async {
        stageConnecting = true
        stageTokenMissing = false
        defer { stageConnecting = false }
        do {
            // Leaving any plain voice room first (one LiveKit room at a time).
            // Must be a REAL leave: tell the server and disconnect the SFU —
            // otherwise we stay in the old voice roster and keep receiving the
            // old room's audio under the stage UI.
            if voiceChannelId != nil { await leaveCurrentVoice() }
            let res = try await api.joinStage(channelId: channel.id)
            stageChannelId = channel.id
            myStageSpeaker = res.participant.isSpeaker
            if let token = res.token, let url = res.wsUrl, !token.isEmpty, !url.isEmpty {
                await voice.connect(url: url, token: token, publishMic: res.participant.isSpeaker)
            } else {
                stageTokenMissing = true
            }
            await refreshStage()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            stageChannelId = nil
        }
    }
    func refreshStage() async {
        guard let id = stageChannelId else { return }
        guard let res = try? await api.listStageParticipants(channelId: id) else { return }
        stageParticipants = res.participants
        // If a moderator flipped my speaker status, re-fetch a token gated on
        // the new role and reconnect (audience↔speaker needs a new publish grant).
        if let uid = currentUserId, let me = res.participants.first(where: { $0.userId == uid }), me.isSpeaker != myStageSpeaker {
            myStageSpeaker = me.isSpeaker
            if let again = try? await api.joinStage(channelId: id),
               let token = again.token, let url = again.wsUrl, !token.isEmpty, !url.isEmpty {
                await voice.connect(url: url, token: token, publishMic: me.isSpeaker)
            }
        }
    }
    func leaveStage() async {
        let id = stageChannelId
        stageChannelId = nil
        stageParticipants = []
        stageTokenMissing = false
        myStageSpeaker = false
        if let uid = currentUserId { voiceStatesByUser.removeValue(forKey: uid) }
        popVoiceRoutes()
        await voice.disconnect()
        if let id { await api.leaveStage(channelId: id) }
    }
    func raiseStageHand() async {
        guard let id = stageChannelId else { return }
        do { try await api.raiseHand(channelId: id); await refreshStage() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func lowerStageHand() async {
        guard let id = stageChannelId else { return }
        do { try await api.lowerHand(channelId: id); await refreshStage() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func setStageSpeaker(_ userId: String, isSpeaker: Bool) async {
        guard let id = stageChannelId else { return }
        do { try await api.setStageSpeaker(channelId: id, userId: userId, isSpeaker: isSpeaker); await refreshStage() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    var myStageHandRaised: Bool {
        guard let uid = currentUserId else { return false }
        return stageParticipants.first(where: { $0.userId == uid })?.handRaised ?? false
    }

    // MARK: Call overlay (outgoing ring + minimized bar)

    /// The voice or stage channel we're currently connected to, if any.
    var activeVoiceOrStageId: String? { stageChannelId ?? voiceChannelId }
    var activeCallChannel: Channel? {
        guard let id = activeVoiceOrStageId else { return nil }
        return channels.first(where: { $0.id == id }) ?? dms.first(where: { $0.id == id })
    }
    /// True when the screen on top is the voice/stage screen for the active call.
    var isViewingActiveCall: Bool {
        guard let id = activeVoiceOrStageId, case .voice(let ch)? = stack.last else { return false }
        return ch.id == id
    }
    /// When set, we're the caller of a 1:1 DM and the callee hasn't answered.
    var outgoingCall: (channel: Channel, callee: PublicUser)? {
        guard let cid = voiceChannelId, let dm = dms.first(where: { $0.id == cid }) else { return nil }
        let others = dm.recipients ?? []
        guard others.count == 1, let callee = others.first else { return nil }
        // Read the callee's presence from the GLOBAL voice map, not the
        // channel-scoped `voiceStates` array. `voiceStatesByUser` is upserted
        // BEFORE the `voiceChannelId` guard in applyVoiceState, so it captures
        // the callee answering even in the race where their JOIN arrives while
        // our own REST join is still in flight (web mirrors this via
        // voiceStatesForChannel). Reading `voiceStates` left the overlay stuck
        // on "Calling…" after the callee answered.
        if voiceStatesByUser.values.contains(where: { $0.channelId == cid && $0.userId == callee.id }) { return nil }
        return (dm, callee)
    }
    func leaveActiveCall() async {
        if stageChannelId != nil { await leaveStage() } else { await leaveCurrentVoice() }
    }
    func returnToActiveCall() {
        if let ch = activeCallChannel { push(.voice(ch)) }
    }

    func toggleVoiceMute() async {
        await voice.toggleMute()
        if let id = voiceChannelId {
            await api.updateVoiceState(channelId: id, selfMute: voice.isMuted, selfDeaf: nil)
        }
    }

    func toggleVoiceDeafen() async {
        await voice.toggleDeafen()
        if let id = voiceChannelId {
            await api.updateVoiceState(channelId: id, selfMute: voice.isMuted, selfDeaf: voice.isDeafened)
        }
    }

    func toggleVoiceCamera() async {
        await voice.toggleCamera()
    }

    private func applyVoiceState(_ vs: VoiceState) {
        // Global sidebar presence map: channelId == nil means "left voice".
        if vs.channelId == nil {
            voiceStatesByUser.removeValue(forKey: vs.userId)
        } else {
            voiceStatesByUser[vs.userId] = vs
        }
        guard let active = voiceChannelId else { return }
        // Stable join order: update IN PLACE (planetary seating — first-in
        // stays closest; remove+append used to shuffle a user to the
        // outermost orbit on every mute toggle). Removals compact the
        // order so the next joiner inherits the freed orbit.
        if let i = voiceStates.firstIndex(where: { $0.userId == vs.userId }) {
            if vs.channelId == active { voiceStates[i] = vs }
            else { voiceStates.remove(at: i) }
        } else if vs.channelId == active {
            voiceStates.append(vs)
        }



        // 1:1 DM auto-end (web parity): when no other participant remains in
        // our active 1:1 DM call, hang up our side too instead of stranding a
        // solo call. Keyed on "no non-self peer left" rather than `wasInCall`
        // so it still fires when the peer's JOIN lost the voiceChannelId race
        // (never added to voiceStates). If the DM isn't cached yet (cold-start
        // answer before loadDMs), resolve it once and re-check — mirrors
        // handleIncomingCall's loadDMs-and-retry. group_dm / guild voice are
        // intentionally excluded (they legitimately keep one person).
        if vs.userId != currentUserId, vs.channelId != active {
            let peerStillPresent = voiceStates.contains { $0.userId != currentUserId && $0.channelId == active }
            if !peerStillPresent {
                if let dm = dms.first(where: { $0.id == active }) {
                    if dm.type == "dm" { Task { await leaveCurrentVoice() } }
                } else {
                    Task { [weak self] in
                        await self?.loadDMs()
                        guard let self, self.voiceChannelId == active,
                              let dm = self.dms.first(where: { $0.id == active }), dm.type == "dm",
                              !self.voiceStates.contains(where: { $0.userId != self.currentUserId && $0.channelId == active })
                        else { return }
                        await self.leaveCurrentVoice()
                    }
                }
            }
        }

        // Server evicted US (callee declined the call, a kick, or a
        // moderator disconnect): our own state going nil while we still
        // think we're connected means hang up locally — otherwise the
        // SFU connection and the call UI linger.
        if vs.userId == currentUserId, vs.channelId == nil {
            Task { await leaveCurrentVoice() }
        }
    }

    /// Participants currently in a given voice/stage channel (sidebar rows).
    func voiceParticipants(in channelId: String) -> [VoiceState] {
        voiceStatesByUser.values
            .filter { $0.channelId == channelId }
            .sorted { $0.userId < $1.userId }
    }

    /// Total unread mention count across all channels (rail badge).
    var totalMentionCount: Int {
        readStates.values.reduce(0) { $0 + ($1.mentionCount ?? 0) }
    }

    /// If the gateway reports OUR voice state moved to a channel different from
    /// the one we're connected to, a moderator dragged us (the server already
    /// evicted us from the old SFU room). Disconnect and rejoin the new one,
    /// mirroring the web's self-move handling. Best-effort: if the target
    /// channel isn't in the loaded set (a cross-guild move) we skip rather than
    /// guess, leaving the user to rejoin manually.
    private func handleVoiceSelfMove(_ vs: VoiceState) {
        guard vs.userId == currentUserId,
              let newId = vs.channelId,
              let connected = voiceChannelId,
              connected != newId,
              let target = channels.first(where: { $0.id == newId })
                ?? dms.first(where: { $0.id == newId })
        else { return }
        Task {
            await voice.disconnect()
            await joinVoice(target)
        }
    }

    // MARK: 1:1 calls (in-app ringing)

    /// Detect an incoming DM call from a VOICE_STATE_UPDATE: someone *else*
    /// joined voice on a DM we're a recipient of, and we're not already in it.
    /// Apply the `voice_states` snapshot from a READY frame. The READY `d`
    /// payload uses a snake_case `voice_states` key whose elements are the
    /// camelCase VoiceState DTOs the gateway sends live. Rebuilds the global
    /// presence map, reconciles our own call state, and replays any in-flight
    /// ring that we missed while the socket was down.
    private func applyReadyVoiceStates(_ data: Data) {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let rows = obj["voice_states"] as? [[String: Any]] else { return }
        let states: [VoiceState] = rows.compactMap { row in
            guard let d = try? JSONSerialization.data(withJSONObject: row) else { return nil }
            return try? JSONDecoder().decode(VoiceState.self, from: d)
        }
        // Rebuild the sidebar/DM voice-presence map from the authoritative
        // snapshot (channelId == nil shouldn't appear here, but guard anyway).
        var map: [String: VoiceState] = [:]
        for vs in states where vs.channelId != nil { map[vs.userId] = vs }
        voiceStatesByUser = map

        // Reconcile our OWN call: if we believe we're in a call but the
        // snapshot doesn't list us there, it ended while we were suspended —
        // tear the dead call down locally so the stale voiceChannelId stops
        // swallowing future rings (and our own call button works again).
        if let active = voiceChannelId,
           !states.contains(where: { $0.userId == currentUserId && $0.channelId == active }) {
            callLog.info("READY: reconcile stale voiceChannelId \(active, privacy: .public) (not in snapshot) — leaving")
            Task { await leaveCurrentVoice() }
        } else if let active = voiceChannelId,
                  let dm = dms.first(where: { $0.id == active }), dm.type == "dm",
                  states.contains(where: { $0.userId == currentUserId && $0.channelId == active }),
                  !states.contains(where: { $0.userId != currentUserId && $0.channelId == active }) {
            // We're still in a 1:1 DM call per the snapshot, but the PEER is
            // gone from it — they left while our socket was down, so the live
            // LEAVE never reached us. The READY snapshot omits a left peer's
            // row (server sends no row), so this is the reconnect-gap fix for
            // "call doesn't hang up when the other person leaves."
            callLog.info("READY: 1:1 peer gone from snapshot — leaving")
            Task { await leaveCurrentVoice() }
        }

        // Replay incoming-call detection for 1:1 DM rings that survive only in
        // this snapshot (the live VOICE_STATE_UPDATE arrived on our dead
        // socket). Gate on the local DM list so guild-voice rows don't trigger
        // a wasted loadDMs; handleIncomingCall re-applies the self/dup guards.
        for vs in states where vs.userId != currentUserId {
            if let ch = dms.first(where: { $0.id == vs.channelId }), ch.type == "dm" {
                handleIncomingCall(vs)
            }
        }
    }

    private func handleIncomingCall(_ vs: VoiceState) {
        guard let channelId = vs.channelId else {
            // Caller hung up / declined (leftDto carries channelId=null).
            // Resolve the channel even when `incomingCall` is nil — that's the
            // case when the ring came via a PushKit VoIP push (app backgrounded)
            // and the in-app ring state was never set, which left the CallKit
            // ring stuck. Prefer the live incomingCall, else map caller → the
            // 1:1 DM whose other recipient is them. remoteCancelled no-ops when
            // no CallKit UUID maps the channel, so a wrong/absent match is safe.
            let cid = (vs.userId == incomingCall?.callerId ? incomingCall?.channelId : nil)
                ?? dms.first(where: {
                    $0.type == "dm" && ($0.recipients?.contains(where: { $0.id == vs.userId }) ?? false)
                })?.id
            if let cid {
                CallManager.shared.remoteCancelled(channelId: cid)
                if incomingCall?.channelId == cid { incomingCall = nil }
            } else {
                // dms not loaded yet (cold VoIP launch) — remember the caller and
                // dismiss once loadDMs resolves the channel.
                pendingCallerCancels.insert(vs.userId)
            }
            return
        }
        callLog.info("ring? caller=\(vs.userId, privacy: .public) ch=\(channelId, privacy: .public) me=\(self.currentUserId ?? "nil", privacy: .public) inVoice=\(self.voiceChannelId ?? "nil", privacy: .public)")
        guard vs.userId != currentUserId,
              voiceChannelId != channelId,
              incomingCall?.channelId != channelId else {
            callLog.info("ring dropped by guard (self/already-in-channel/dup)")
            return
        }
        // The DM may not be cached yet (first-ever call from this person,
        // or the ring raced the initial loadDMs). Fetch and retry ONCE
        // instead of silently dropping the ring — this was the main
        // "some calls don't come through" failure.
        guard let dm = dms.first(where: { $0.id == channelId }) else {
            callLog.info("DM \(channelId, privacy: .public) not cached (\(self.dms.count) DMs); loadDMs + retry")
            Task { [weak self] in
                await self?.loadDMs()
                guard let self,
                      self.voiceChannelId != channelId,
                      self.incomingCall?.channelId != channelId,
                      let dm = self.dms.first(where: { $0.id == channelId })
                else {
                    callLog.error("ring dropped: DM \(channelId, privacy: .public) still not found after loadDMs (\(self?.dms.count ?? -1) DMs)")
                    return
                }
                self.presentIncomingCall(dm: dm, callerId: vs.userId)
            }
            return
        }
        presentIncomingCall(dm: dm, callerId: vs.userId)
    }

    private func presentIncomingCall(dm: Channel, callerId: String) {
        let channelId = dm.id
        let callerName = dm.recipients?.first(where: { $0.id == callerId })?.name ?? dm.dmTitle
        // Ring policy: the system (CallKit) call screen rings ONLY when the
        // app isn't frontmost — in the foreground the in-app overlay is the
        // ring. This also keeps CallKit's audio-session ownership away from
        // live calls (it silenced both directions). Settings → Notifications
        // can turn the system ring off entirely.
        let ringEnabled = UserDefaults.standard.object(forKey: "zk.notifyCalls") == nil
            || UserDefaults.standard.bool(forKey: "zk.notifyCalls")
        callLog.info("presenting ring from \(callerName, privacy: .public) (ch \(channelId, privacy: .public), ringEnabled=\(ringEnabled), fg=\(UIApplication.shared.applicationState == .active))")
        if ringEnabled && UIApplication.shared.applicationState != .active {
            CallManager.shared.reportIncoming(channelId: channelId, callerName: callerName)
        }
        incomingCall = IncomingCall(
            channelId: channelId,
            callerId: callerId,
            callerName: callerName,
            channel: dm
        )
    }

    func acceptCall() {
        guard let call = incomingCall else { return }
        // Route through CallKit (falls back to direct answer): onAnswer
        // clears incomingCall and joins.
        CallManager.shared.answerFromApp(channelId: call.channelId)
    }

    func declineCall() {
        guard let call = incomingCall else { return }
        CallManager.shared.endFromApp(channelId: call.channelId)
    }

    // MARK: Channel updates

    /// Merge a CHANNEL_UPDATE into local state. Keeps DM E2EE fields current so
    /// a re-keyed conversation re-prompts (and a freshly-enabled one locks).
    private func handleChannelUpdate(_ updated: Channel) {
        if let i = dms.firstIndex(where: { $0.id == updated.id }) {
            // The gateway Channel DTO never carries `streak` (it's only
            // attached on the REST DM list), so a wholesale replace here
            // would WIPE a loaded streak on any unrelated CHANNEL_UPDATE
            // (e.g. an E2EE toggle/re-key). Carry the old value forward.
            var u = updated
            if u.streak == nil { u.streak = dms[i].streak }
            dms[i] = u
        }
        if let j = channels.firstIndex(where: { $0.id == updated.id }) {
            channels[j] = updated
        }
        if selectedChannel?.id == updated.id {
            selectedChannel = updated
            // A re-key (new salt/verifier) invalidates any cached key.
            purgeStaleE2EEKey(updated)
            // If we still hold a valid key, decrypt anything already loaded.
            decryptVisible()
            // Re-evaluate the lock gate (e.g. E2EE was just turned on/off).
            e2eeUnlockVersion += 1
        }
    }

    // MARK: Reactions

    /// Toggle the current user's reaction for an emoji, optimistically.
    func toggleReaction(_ message: Message, emoji: String) async {
        guard let channelId = selectedChannel?.id,
              let mi = messages.firstIndex(where: { $0.id == message.id }) else { return }
        let hasMine = (messages[mi].reactions ?? []).first(where: { $0.emoji == emoji })?.me == true
        applyReaction(messageId: message.id, emoji: emoji, delta: hasMine ? -1 : 1, isMe: true)
        do {
            if hasMine {
                try await api.removeReaction(channelId: channelId, messageId: message.id, emoji: emoji)
            } else {
                try await api.addReaction(channelId: channelId, messageId: message.id, emoji: emoji)
            }
        } catch {
            // Revert on failure.
            applyReaction(messageId: message.id, emoji: emoji, delta: hasMine ? 1 : -1, isMe: true)
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Apply a reaction event from the gateway. Our own reactions are skipped
    /// (already applied optimistically); others adjust the count only.
    private func handleReactionEvent(add: Bool, channelId: String, messageId: String, userId: String?, emoji: String) {
        guard channelId == selectedChannel?.id else { return }
        if let userId, userId == currentUserId { return }
        applyReaction(messageId: messageId, emoji: emoji, delta: add ? 1 : -1, isMe: false)
    }

    private func applyReaction(messageId: String, emoji: String, delta: Int, isMe: Bool) {
        guard let mi = messages.firstIndex(where: { $0.id == messageId }) else { return }
        var reactions = messages[mi].reactions ?? []
        if let ri = reactions.firstIndex(where: { $0.emoji == emoji }) {
            var r = reactions[ri]
            r.count += delta
            if isMe { r.me = delta > 0 }
            if r.count <= 0 {
                reactions.remove(at: ri)
            } else {
                reactions[ri] = r
            }
        } else if delta > 0 {
            reactions.append(ReactionAggregate(emoji: emoji, count: 1, me: isMe))
        }
        messages[mi].reactions = reactions
    }

    // MARK: Sending

    func send(_ raw: String) async {
        let content = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !content.isEmpty, let channel = selectedChannel else { return }
        noteInteraction()
        let nonce = UUID().uuidString

        // For E2EE DMs, encrypt before sending; remember the plaintext so the
        // optimistic echo renders decrypted immediately.
        var wire = content
        if channel.isE2EE {
            guard let key = e2eeKey(for: channel) else {
                e2eeError = "Unlock this conversation to send."
                return
            }
            guard let enc = E2EE.encrypt(content, key: key) else {
                errorText = "Encryption failed."
                return
            }
            wire = enc
        }

        let replyId = replyingTo?.id

        // Optimistic placeholder: shows instantly, keyed by the nonce so the
        // confirmed message replaces it. Plaintext is mapped so E2EE renders.
        let placeholder = Message(
            optimisticNonce: nonce, channelId: channel.id, content: content,
            author: selfPublicUser, authorId: currentUserId,
            replyToId: replyId, createdAt: isoNow()
        )
        decrypted[nonce] = content
        messages.append(placeholder)
        replyingTo = nil

        do {
            let message = try await api.sendMessage(channelId: channel.id, content: wire, nonce: nonce, replyToId: replyId)
            if channel.id == selectedChannel?.id {
                decrypted[message.id] = content
                upsert(message)
            }
        } catch {
            markSendFailed(nonce)
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Retry a previously-failed optimistic message, reusing its nonce (== id)
    /// so the server dedupes if the first attempt actually landed.
    func retrySend(_ messageId: String) async {
        guard let idx = messages.firstIndex(where: { $0.id == messageId && $0.sendState == "failed" }),
              let channel = selectedChannel else { return }
        let placeholder = messages[idx]
        let plaintext = decrypted[messageId] ?? placeholder.content ?? ""
        var wire = plaintext
        if channel.isE2EE {
            guard let key = e2eeKey(for: channel), let enc = E2EE.encrypt(plaintext, key: key) else {
                errorText = "Encryption failed."
                return
            }
            wire = enc
        }
        messages[idx].sendState = "sending"
        do {
            let message = try await api.sendMessage(channelId: channel.id, content: wire, nonce: messageId, replyToId: placeholder.replyToId)
            if channel.id == selectedChannel?.id {
                decrypted[message.id] = plaintext
                upsert(message)
            }
        } catch {
            markSendFailed(messageId)
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Remove a failed optimistic message from the list.
    func discardFailed(_ messageId: String) {
        messages.removeAll { $0.id == messageId && $0.sendState != nil }
    }

    private func markSendFailed(_ id: String) {
        if let idx = messages.firstIndex(where: { $0.id == id }) {
            messages[idx].sendState = "failed"
        }
    }

    /// The signed-in user as a PublicUser, for authoring optimistic messages.
    private var selfPublicUser: PublicUser? {
        guard let u = currentUser else { return nil }
        return PublicUser(
            id: u.id, username: u.username, displayName: u.displayName,
            avatarUrl: u.avatarUrl, status: u.status, isBot: false,
            customStatus: u.customStatus, customStatusEmoji: u.customStatusEmoji,
            avatarDecoration: u.avatarDecoration
        )
    }

    /// Current time as an ISO-8601 string for optimistic placeholders.
    private func isoNow() -> String {
        ISO8601DateFormatter().string(from: Date())
    }

    /// Send a sticker as its own message. Not available in E2EE channels
    /// (the sticker reference is stored server-side in plaintext).
    func sendSticker(_ sticker: Sticker) async {
        guard let channel = selectedChannel else { return }
        if channel.isE2EE { errorText = "Stickers aren't available in encrypted channels."; return }
        let nonce = UUID().uuidString
        do {
            let message = try await api.sendMessage(channelId: channel.id, content: "", nonce: nonce, stickerId: sticker.id)
            if channel.id == selectedChannel?.id { upsert(message); replyingTo = nil }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Load the current guild's sticker set for the picker.
    func loadStickers() async {
        guard let g = selectedGuild else { guildStickers = []; return }
        do { guildStickers = try await api.listGuildStickers(guildId: g.id) }
        catch { guildStickers = [] }
    }

    /// Load the current guild's custom emoji (for the picker + inline render).
    func loadEmojis() async {
        guard let g = selectedGuild else { guildEmojis = []; return }
        do { guildEmojis = try await api.listGuildEmojis(guildId: g.id) }
        catch { guildEmojis = [] }
    }

    func uploadEmoji(name: String, filename: String, contentType: String, data: Data) async -> String? {
        guard let g = selectedGuild else { return "No server selected." }
        do {
            let e = try await api.uploadGuildEmoji(guildId: g.id, name: name, filename: filename, contentType: contentType, data: data)
            guildEmojis.append(e)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func deleteEmoji(_ e: GuildEmoji) async {
        guard let g = selectedGuild else { return }
        do { try await api.deleteGuildEmoji(guildId: g.id, emojiId: e.id); guildEmojis.removeAll { $0.id == e.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func uploadSticker(name: String, description: String?, filename: String, contentType: String, data: Data) async -> String? {
        guard let g = selectedGuild else { return "No server selected." }
        do {
            let s = try await api.uploadGuildSticker(guildId: g.id, name: name, description: description, filename: filename, contentType: contentType, data: data)
            guildStickers.append(s)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func deleteSticker(_ s: Sticker) async {
        guard let g = selectedGuild else { return }
        do { try await api.deleteGuildSticker(guildId: g.id, stickerId: s.id); guildStickers.removeAll { $0.id == s.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// Return a cached, inline-sized image for a custom emoji, kicking off a
    /// one-time download (which republishes `emojiImages`) when not present.
    func emojiImage(for emoji: GuildEmoji) -> UIImage? {
        if let img = emojiImages[emoji.id] { return img }
        if !emojiInFlight.contains(emoji.id), let url = assetURL(emoji.url) {
            emojiInFlight.insert(emoji.id)
            Task { [weak self] in
                let data = try? await URLSession.shared.data(from: url).0
                let img = data.flatMap { AppStore.resizedEmoji($0, points: 20) }
                self?.emojiInFlight.remove(emoji.id)
                if let img { self?.emojiImages[emoji.id] = img }
            }
        }
        return nil
    }

    /// Downscale raw image data to a square `points`-pt image at screen scale,
    /// so it renders at a sensible size when interpolated inline in `Text`.
    static func resizedEmoji(_ data: Data, points: CGFloat) -> UIImage? {
        guard let img = UIImage(data: data) else { return nil }
        let target = CGSize(width: points, height: points)
        let fmt = UIGraphicsImageRendererFormat.default()
        let renderer = UIGraphicsImageRenderer(size: target, format: fmt)
        return renderer.image { _ in img.draw(in: CGRect(origin: .zero, size: target)) }
    }

    // MARK: Webhooks

    func loadWebhooks(_ channelId: String) async {
        loadingWebhooks = true
        defer { loadingWebhooks = false }
        do { channelWebhooks = try await api.listChannelWebhooks(channelId: channelId) }
        catch { channelWebhooks = [] }
    }
    func createWebhook(channelId: String, name: String) async -> Webhook? {
        do {
            let wh = try await api.createWebhook(channelId: channelId, name: name)
            channelWebhooks.insert(wh, at: 0)
            return wh
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription; return nil }
    }
    func deleteWebhook(_ wh: Webhook) async {
        do { try await api.deleteWebhook(webhookId: wh.id); channelWebhooks.removeAll { $0.id == wh.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Scheduled messages

    func loadScheduled() async {
        loadingScheduled = true
        defer { loadingScheduled = false }
        do { scheduledMessages = try await api.listScheduledMessages() }
        catch { scheduledMessages = [] }
    }
    func scheduleMessage(content: String, at date: Date) async -> String? {
        guard let channel = selectedChannel else { return "No channel selected." }
        if channel.isE2EE { return "Scheduling isn't available in encrypted channels." }
        let iso = ISO8601DateFormatter().string(from: date)
        do {
            let sm = try await api.scheduleMessage(channelId: channel.id, content: content, scheduledFor: iso)
            scheduledMessages.append(sm)
            scheduledMessages.sort { $0.scheduledFor < $1.scheduledFor }
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func cancelScheduled(_ sm: ScheduledMessage) async {
        do { try await api.cancelScheduledMessage(id: sm.id); scheduledMessages.removeAll { $0.id == sm.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Channel permission overrides

    func loadChannelOverrides(_ channelId: String) async {
        loadingOverrides = true
        defer { loadingOverrides = false }
        do { channelOverrides = try await api.listChannelOverrides(channelId: channelId) }
        catch { channelOverrides = [] }
    }
    func saveChannelOverride(channelId: String, targetId: String, allow: UInt64, deny: UInt64) async -> String? {
        do {
            try await api.putChannelOverride(
                channelId: channelId, targetId: targetId, type: "role",
                allow: Permissions.serialize(allow), deny: Permissions.serialize(deny)
            )
            await loadChannelOverrides(channelId)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// Send an image (or file) attachment via multipart, with an optional
    /// caption. Not used for E2EE channels (the composer hides the picker
    /// there, since attachment encryption isn't implemented).
    func sendImage(data: Data, filename: String, contentType: String, caption: String) async {
        guard let channel = selectedChannel else { return }
        let nonce = UUID().uuidString
        uploading = true
        defer { uploading = false }
        do {
            var sendData = data
            var sendName = filename
            var sendType = contentType
            var wireCaption = caption
            if channel.isE2EE {
                // Same key + AES-GCM as the message text; the .zke suffix
                // tells recipients to decrypt before rendering. The server
                // only ever sees ciphertext.
                guard let key = e2eeKey(for: channel) else {
                    e2eeError = "Unlock this conversation to send."
                    return
                }
                guard let enc = E2EE.encryptData(data, key: key) else {
                    errorText = "Encryption failed."
                    return
                }
                sendData = enc
                sendName = filename + ".zke"
                sendType = "application/octet-stream"
                if !caption.isEmpty {
                    guard let encCaption = E2EE.encrypt(caption, key: key) else {
                        errorText = "Encryption failed."
                        return
                    }
                    wireCaption = encCaption
                }
            }
            let file = UploadFile(data: sendData, filename: sendName, contentType: sendType)
            let message = try await api.sendMessageMultipart(
                channelId: channel.id, content: wireCaption, nonce: nonce, files: [file], replyToId: replyingTo?.id
            )
            if channel.id == selectedChannel?.id {
                upsert(message)
                if channel.isE2EE, !caption.isEmpty { decrypted[message.id] = caption }
                replyingTo = nil
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Fetch + decrypt an encrypted attachment (.zke) with the channel key.
    /// Returns nil when the key isn't unlocked or the blob doesn't verify.
    func decryptedAttachmentData(_ attachment: Attachment, in channel: Channel) async -> Data? {
        guard channel.isE2EE, let key = e2eeKey(for: channel),
              let url = assetURL(attachment.url) else { return nil }
        guard let (blob, _) = try? await URLSession.shared.data(from: url) else { return nil }
        return E2EE.decryptData(blob, key: key)
    }

    /// Send a recorded voice message: the audio file plus its duration and
    /// waveform. Not available in E2EE channels.
    func sendVoiceMessage(fileURL: URL, duration: Int, waveform: String) async {
        guard let channel = selectedChannel else { return }
        if channel.isE2EE { errorText = "Voice messages aren't available in encrypted channels."; return }
        guard let data = try? Data(contentsOf: fileURL) else { errorText = "Couldn't read recording."; return }
        let nonce = UUID().uuidString
        uploading = true
        defer { uploading = false }
        do {
            let file = UploadFile(data: data, filename: "voice-message.m4a", contentType: "audio/mp4")
            let message = try await api.sendMessageMultipart(
                channelId: channel.id, content: "", nonce: nonce, files: [file],
                replyToId: replyingTo?.id,
                voiceMessage: ["durationSeconds": duration, "waveform": waveform]
            )
            if channel.id == selectedChannel?.id {
                upsert(message)
                replyingTo = nil
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Edit one of the current user's messages. Re-encrypts for E2EE channels.
    func editMessage(_ message: Message, newContent: String) async {
        let trimmed = newContent.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let channel = selectedChannel else { return }
        var wire = trimmed
        if channel.isE2EE {
            guard let key = e2eeKey(for: channel) else {
                e2eeError = "Unlock this conversation to edit."
                return
            }
            guard let enc = E2EE.encrypt(trimmed, key: key) else {
                errorText = "Encryption failed."
                return
            }
            wire = enc
        }
        do {
            let updated = try await api.editMessage(channelId: channel.id, messageId: message.id, content: wire)
            if channel.isE2EE { decrypted[message.id] = trimmed }
            if channel.id == selectedChannel?.id { upsert(updated) }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Delete one of the current user's messages.
    func deleteMessage(_ message: Message) async {
        guard let channel = selectedChannel else { return }
        do {
            try await api.deleteMessage(channelId: channel.id, messageId: message.id)
            removeMessage(id: message.id)
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    private func removeMessage(id: String) {
        messages.removeAll { $0.id == id }
        decrypted[id] = nil
    }

    // MARK: Polls

    /// Toggle the current user's vote on a poll option. For single-choice
    /// polls the server retracts any prior vote automatically. Updated tallies
    /// arrive via MESSAGE_UPDATE.
    func togglePollVote(message: Message, option: PollOption) async {
        guard let channel = selectedChannel, let poll = message.poll else { return }
        let voted = poll.myVotes.contains(option.id)
        do {
            if voted {
                try await api.removePollVote(channelId: channel.id, pollId: poll.id, optionId: option.id)
            } else {
                try await api.voteOnPoll(channelId: channel.id, pollId: poll.id, optionId: option.id)
            }
            // Record our own ballot locally. The MESSAGE_UPDATE broadcast is
            // shared by every recipient and carries no per-user vote state
            // (upsert preserves local myVotes), so without this the user's
            // selection would never render.
            if let mi = messages.firstIndex(where: { $0.id == message.id }),
               var p = messages[mi].poll, p.id == poll.id {
                if voted {
                    p.myVotes.removeAll { $0 == option.id }
                } else {
                    if !p.multipleChoice { p.myVotes = [] }
                    p.myVotes.append(option.id)
                }
                messages[mi].poll = p
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Create a poll in the current channel. Not used for E2EE channels (the
    /// composer hides the poll button there).
    func sendPoll(question: String, options: [String], multipleChoice: Bool, durationHours: Int) async {
        guard let channel = selectedChannel else { return }
        let nonce = UUID().uuidString
        do {
            let message = try await api.sendPoll(
                channelId: channel.id, question: question, options: options,
                multipleChoice: multipleChoice, durationHours: durationHours, nonce: nonce
            )
            if channel.id == selectedChannel?.id { upsert(message) }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    // MARK: Search

    func searchMessages(_ query: String) async {
        guard let channel = selectedChannel else { return }
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { searchResults = []; return }
        searching = true
        defer { searching = false }
        do {
            searchResults = try await api.searchMessages(channelId: channel.id, query: q)
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            searchResults = []
        }
    }

    func clearSearch() { searchResults = [] }

    /// Cross-DM search — spans every DM conversation via /users/@me/dms/search
    /// (same server FTS as the per-channel search).
    func searchDMs(_ query: String) async {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { dmSearchResults = []; return }
        dmSearching = true
        defer { dmSearching = false }
        do {
            dmSearchResults = try await api.searchDirectMessages(query: q)
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            dmSearchResults = []
        }
    }

    func clearDMSearch() { dmSearchResults = [] }

    // MARK: Active sessions

    /// Load the current user's active auth sessions (GET /users/@me/sessions).
    func loadSessions() async {
        sessionsLoading = true
        defer { sessionsLoading = false }
        do {
            sessions = try await api.listSessions()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Revoke one session (DELETE /users/@me/sessions/:id). On success drop it
    /// from the list; on failure surface the message via errorText.
    func revokeSession(_ s: UserSession) async {
        do {
            try await api.revokeSession(id: s.id)
            sessions.removeAll { $0.id == s.id }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    // MARK: Typing

    func triggerTyping() {
        guard let channel = selectedChannel else { return }
        Task { await api.triggerTyping(channelId: channel.id) }
    }

    private func handleTypingStart(channelId: String, userId: String?) {
        guard channelId == selectedChannel?.id, let userId, userId != currentUserId else { return }
        typing[userId] = Date().addingTimeInterval(8)
        // Drop the entry ~8s after the latest keystroke (later events bump it).
        Task { [weak self] in
            try? await Task.sleep(nanoseconds: 8_000_000_000)
            guard let self else { return }
            if let expiry = self.typing[userId], expiry <= Date() {
                self.typing[userId] = nil
            }
        }
    }

    // MARK: Friends

    func loadRelationships() async {
        loadingRelationships = true
        defer { loadingRelationships = false }
        do {
            relationships = try await api.listRelationships()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func startDM(with user: PublicUser) async -> Channel? {
        do {
            let channel = try await api.openDM(recipientId: user.id)
            if !dms.contains(where: { $0.id == channel.id }) {
                dms.insert(channel, at: 0)
            }
            return channel
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            return nil
        }
    }

    /// Returns nil on success, or an error message to show inline.
    func addFriend(username: String) async -> String? {
        let name = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty else { return "Enter a username." }
        do {
            try await api.sendFriendRequestByUsername(name)
            await loadRelationships()
            return nil
        } catch {
            return (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func acceptFriend(_ user: PublicUser) async {
        do {
            try await api.acceptFriendRequest(targetId: user.id)
            await loadRelationships()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func removeFriend(_ user: PublicUser) async {
        do {
            try await api.removeFriend(targetId: user.id)
            await loadRelationships()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func blockUser(_ user: PublicUser) async {
        do {
            try await api.blockUser(targetId: user.id)
            await loadRelationships()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    func unblockUser(_ user: PublicUser) async {
        do {
            try await api.unblockUser(targetId: user.id)
            await loadRelationships()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    // MARK: Mentions

    func loadMentions() async {
        loadingMentions = true
        defer { loadingMentions = false }
        do {
            mentions = try await api.listMentions()
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Best-effort navigation to a mention's channel (works when it's already
    /// loaded among the current guild's channels or the DM list).
    func openMention(_ mention: Mention) {
        if let ch = channels.first(where: { $0.id == mention.channelId })
            ?? dms.first(where: { $0.id == mention.channelId }) {
            selectChannel(ch)
        }
    }

    // MARK: Server creation / join / discovery

    func createServer(name: String, description: String?,
                      icon: (data: Data, ext: String, mime: String)? = nil,
                      banner: (data: Data, ext: String, mime: String)? = nil) async {
        do {
            let result = try await api.createGuild(name: name, description: description)
            let gid = result.guild.id
            // Upload the optional picture + banner to the freshly-created guild
            // before reloading, so the loaded guild already carries them.
            if let icon {
                _ = try? await api.uploadGuildIcon(guildId: gid, filename: "icon.\(icon.ext)",
                                                   contentType: icon.mime, data: icon.data)
            }
            if let banner {
                _ = try? await api.uploadGuildBanner(guildId: gid, filename: "banner.\(banner.ext)",
                                                     contentType: banner.mime, data: banner.data)
            }
            await loadGuilds()
            if let guild = guilds.first(where: { $0.id == gid }) {
                selectGuild(guild)
            } else {
                selectGuild(result.guild)
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Import a guild backup/template file as a NEW server (clone). On success
    /// the new guild is loaded + selected and this returns nil; on failure it
    /// returns the error message so the import sheet can show it inline.
    func importServer(backup: Data, name: String?) async -> String? {
        do {
            let result = try await api.importGuild(backup: backup, nameOverride: name)
            await loadGuilds()
            if let guild = guilds.first(where: { $0.id == result.guild.id }) {
                selectGuild(guild)
            } else {
                selectGuild(result.guild)
            }
            return nil
        } catch {
            let msg = (error as? APIError)?.message ?? error.localizedDescription
            errorText = msg
            return msg
        }
    }

    /// Strip a pasted invite URL down to the bare code. Shared by preview + join
    /// so both resolve the same code.
    private func cleanInviteCode(_ code: String) -> String {
        code.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "https://zekktris.com/invite/", with: "")
            .replacingOccurrences(of: "zekktris.com/invite/", with: "")
    }

    /// Public preview of an invite (GET /invites/:code) so the user sees the
    /// server before joining. Returns nil (and sets errorText) on failure.
    func previewInvite(_ code: String) async -> InvitePreview? {
        let cleaned = cleanInviteCode(code)
        guard !cleaned.isEmpty else { return nil }
        do {
            return try await api.previewInvite(code: cleaned)
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            return nil
        }
    }

    /// Accept an invite. Returns true on success (guild loaded + selected).
    @discardableResult
    func joinByInvite(code: String) async -> Bool {
        let cleaned = cleanInviteCode(code)
        guard !cleaned.isEmpty else { return false }
        do {
            let result = try await api.acceptInvite(code: cleaned)
            await loadGuilds()
            if let guild = guilds.first(where: { $0.id == result.guildId }) {
                selectGuild(guild)
            }
            return true
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            return false
        }
    }

    func loadDiscoverable(q: String? = nil, category: String? = nil) async {
        loadingDiscoverable = true
        defer { loadingDiscoverable = false }
        do { discoverable = try await api.listDiscoverable(q: q, category: category) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// Guild Settings → Discovery opt-in (MANAGE_GUILD). Returns an error
    /// string on failure; GUILD_UPDATE propagates the new state.
    func setGuildDiscovery(discoverable: Bool, description: String?, category: String?) async -> String? {
        guard let guild = selectedGuild else { return "No server selected." }
        do {
            try await api.setGuildDiscovery(
                guildId: guild.id, discoverable: discoverable,
                description: description, category: category)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }

    func joinDiscoverable(_ guild: DiscoverableGuild) async {
        do {
            try await api.joinDiscoverable(guildId: guild.id)
            await loadGuilds()
            discoverable.removeAll { $0.id == guild.id }
            if let g = guilds.first(where: { $0.id == guild.id }) { selectGuild(g) }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    // MARK: Admin (instance)

    func loadAdminStats() async {
        loadingAdminStats = true
        defer { loadingAdminStats = false }
        do { adminStats = try await api.adminStats() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func loadAdminUsers(q: String, bannedOnly: Bool) async {
        loadingAdminUsers = true
        defer { loadingAdminUsers = false }
        do { adminUsers = try await api.adminListUsers(q: q, bannedOnly: bannedOnly) }
        catch {
            adminUsers = []
            errorText = "Couldn't load users: \((error as? APIError)?.message ?? error.localizedDescription)"
        }
    }
    private func patchAdminUser(_ id: String, _ mutate: (inout AdminUser) -> Void) {
        if let i = adminUsers.firstIndex(where: { $0.id == id }) { mutate(&adminUsers[i]) }
    }
    func adminBan(_ u: AdminUser) async {
        do { try await api.adminBanUser(userId: u.id)
             patchAdminUser(u.id) { $0.bannedAt = ISO8601DateFormatter().string(from: Date()) } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func adminUnban(_ u: AdminUser) async {
        do { try await api.adminUnbanUser(userId: u.id); patchAdminUser(u.id) { $0.bannedAt = nil } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func adminToggleAdmin(_ u: AdminUser) async {
        let newVal = !u.isAdmin
        do { try await api.adminSetAdmin(userId: u.id, isAdmin: newVal); patchAdminUser(u.id) { $0.isAdmin = newVal } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func adminLogout(_ u: AdminUser) async {
        do { try await api.adminLogoutUser(userId: u.id) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func adminDeleteUser(_ u: AdminUser) async {
        do { try await api.adminDeleteUser(userId: u.id); adminUsers.removeAll { $0.id == u.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func loadAdminGuilds(q: String) async {
        loadingAdminGuilds = true
        defer { loadingAdminGuilds = false }
        do { adminGuilds = try await api.adminListGuilds(q: q) }
        catch { adminGuilds = [] }
    }
    func adminDeleteGuild(_ g: AdminGuild) async {
        do { try await api.adminDeleteGuild(guildId: g.id); adminGuilds.removeAll { $0.id == g.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func loadAdminStorage() async {
        loadingAdminStorage = true
        defer { loadingAdminStorage = false }
        do { adminStorage = try await api.adminStorage() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func runStorageGc() async {
        do {
            let r = try await api.adminStorageGc()
            storageGcResult = "Scanned \(r.scanned) files, deleted \(r.deleted)."
            await loadAdminStorage()
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Per-file storage browser

    @Published var storageItems: [StorageItem] = []
    @Published var loadingStorageItems = false
    @Published var storageSort = "size"
    @Published var storageHasMore = false
    private var storagePage = 1

    func loadStorageItems(reset: Bool) async {
        if reset { storagePage = 1 }
        loadingStorageItems = true
        defer { loadingStorageItems = false }
        do {
            let listing = try await api.adminStorageItems(page: storagePage, sort: storageSort)
            if reset { storageItems = listing.items }
            else { storageItems.append(contentsOf: listing.items) }
            storageHasMore = listing.items.count >= 50
            storagePage += 1
        } catch {
            if reset { storageItems = [] }
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
    func setStorageSort(_ sort: String) async {
        guard sort != storageSort else { return }
        storageSort = sort
        await loadStorageItems(reset: true)
    }
    func deleteStorageItem(_ item: StorageItem) async {
        do {
            try await api.adminDeleteStorageItem(id: item.id)
            storageItems.removeAll { $0.id == item.id }
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func compressStorageItem(_ item: StorageItem) async {
        do {
            try await api.adminCompressStorageItem(id: item.id)
            await loadStorageItems(reset: true)
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Family / parental controls

    func loadFamily() async {
        loadingFamily = true
        defer { loadingFamily = false }
        do { family = try await api.familyMe() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func familyRequestLink(username: String) async {
        let u = username.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !u.isEmpty else { return }
        do { try await api.familyRequestLink(username: u); await loadFamily() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func familyAccept(_ user: FamilyUser) async {
        do { try await api.familyAcceptLink(parentId: user.id); await loadFamily() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func familyRemove(_ user: FamilyUser) async {
        do { try await api.familyRemoveLink(otherId: user.id); await loadFamily() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func loadChildRestrictions(_ childId: String) async {
        do { childRestrictions[childId] = try await api.familyChildRestrictions(childId: childId) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    /// Apply a child's restrictions (optimistically), reverting via the server's
    /// echoed value on success or surfacing an error on failure.
    func setChildRestrictions(_ childId: String, _ r: ChildRestrictions) async {
        childRestrictions[childId] = r
        do { childRestrictions[childId] = try await api.familySetRestrictions(childId: childId, r) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Guild members (name resolution)

    func loadMembers(_ guild: Guild) async {
        do {
            let list = try await api.listMembers(guildId: guild.id)
            var map: [String: GuildMember] = [:]
            for m in list { map[m.userId] = m }
            members = map
            // Point-in-time presence seeding, same rule as loadDMs: the
            // fresh REST status overwrites the map so member dots converge
            // on every (re)load even when live deltas were missed.
            var seeded = presence
            for m in list {
                if let s = m.user.status { seeded[m.userId] = s }
            }
            if seeded != presence { presence = seeded }
        } catch {
            // Non-fatal — names just fall back to a generic label.
        }
    }

    /// Display name for a user id from the loaded guild members (nickname wins),
    /// or nil if we don't have them.
    func memberName(_ userId: String) -> String? {
        guard let m = members[userId] else { return nil }
        return m.nickname ?? m.user.name
    }
    func memberUser(_ userId: String) -> PublicUser? { members[userId]?.user }

    // MARK: Channel management (owner-gated client-side; server enforces perms)

    // MARK: Permissions

    /// Effective guild permission bits for a member. Owner and any role
    /// with ADMINISTRATOR expand to all bits; otherwise the OR of @everyone
    /// plus the member's assigned roles. Mirrors computeMemberGuildPerms.
    func memberPermissions(_ userId: String) -> UInt64 {
        guard let guild = selectedGuild else { return 0 }
        if guild.ownerId == userId { return Permissions.allBits }
        let memberRoleIds = Set(members[userId]?.roleIds ?? [])
        var acc: UInt64 = 0
        for r in roles where r.id == guild.id || memberRoleIds.contains(r.id) {
            acc |= Permissions.parse(r.permissions)
        }
        if Permissions.has(acc, Permissions.ADMINISTRATOR) { return Permissions.allBits }
        return acc
    }
    var myPermissions: UInt64 { currentUserId.map { memberPermissions($0) } ?? 0 }
    // Guild-management permissions must be FALSE while the foreground channel
    // is a direct message — `selectedGuild`/`roles`/`members` linger from the
    // last-viewed server (showDMs / "Message"-from-profile don't clear them),
    // which otherwise let you e.g. assign yourself a role inside a DM. Derive
    // the DM context from the nav stack (reliable across every DM-entry path,
    // unlike the `inDMs` flag which startDM→push doesn't set).
    var isViewingDM: Bool {
        if inDMs { return true }
        switch stack.last {
        case .messages(let ch)?, .threadList(let ch)?, .voice(let ch)?:
            return ch.isDM
        case nil:
            return false
        }
    }
    func iHavePermission(_ bit: Int) -> Bool {
        !isViewingDM && Permissions.has(myPermissions, bit)
    }

    /// Gated client-side; the server still enforces the real check. Owner
    /// short-circuits (covers servers where our member row isn't loaded).
    var canManageChannels: Bool {
        guard let g = selectedGuild, !isViewingDM else { return false }
        if g.ownerId == currentUserId { return true }
        return iHavePermission(Permissions.MANAGE_CHANNELS)
    }
    var canManageRoles: Bool {
        guard let g = selectedGuild, !isViewingDM else { return false }
        if g.ownerId == currentUserId { return true }
        return iHavePermission(Permissions.MANAGE_ROLES)
    }
    var canKickMembers: Bool {
        guard let g = selectedGuild, !isViewingDM else { return false }
        if g.ownerId == currentUserId { return true }
        return iHavePermission(Permissions.KICK_MEMBERS)
    }
    var canBanMembers: Bool {
        guard let g = selectedGuild, !isViewingDM else { return false }
        if g.ownerId == currentUserId { return true }
        return iHavePermission(Permissions.BAN_MEMBERS)
    }
    var canModerateMembers: Bool {
        guard let g = selectedGuild, !isViewingDM else { return false }
        if g.ownerId == currentUserId { return true }
        return iHavePermission(Permissions.MODERATE_MEMBERS)
    }

    // MARK: Member moderation

    func kickMember(_ userId: String) async {
        guard let g = selectedGuild else { return }
        do {
            try await api.kickMember(guildId: g.id, userId: userId)
            members[userId] = nil
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func banMember(_ userId: String) async {
        guard let g = selectedGuild else { return }
        do {
            try await api.banMember(guildId: g.id, userId: userId)
            members[userId] = nil
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    /// File a report against a member of the current guild. `reason` is one of
    /// spam | harassment | nsfw | violence | other. Surfaces to moderators in
    /// the guild settings → Reports queue.
    func reportUser(_ userId: String, reason: String, details: String? = nil) async {
        guard let g = selectedGuild else { return }
        do {
            _ = try await api.createReport(guildId: g.id, targetType: "user",
                                           targetUserId: userId, reason: reason, details: details)
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    /// Time a member out for `minutes` (0 clears the timeout).
    func timeoutMember(_ userId: String, minutes: Int) async {
        guard let g = selectedGuild else { return }
        let until = minutes > 0
            ? ISO8601DateFormatter().string(from: Date().addingTimeInterval(Double(minutes) * 60))
            : nil
        do {
            let updated = try await api.timeoutMember(guildId: g.id, userId: userId, until: until)
            members[userId] = updated
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    var isGuildOwner: Bool {
        !isViewingDM && selectedGuild?.ownerId != nil && selectedGuild?.ownerId == currentUserId
    }
    var canManageGuild: Bool {
        if isGuildOwner { return true }
        return iHavePermission(Permissions.MANAGE_GUILD)
    }
    var canManageWebhooks: Bool {
        if isGuildOwner { return true }
        return iHavePermission(Permissions.MANAGE_WEBHOOKS)
    }
    var canManageEmojis: Bool {
        if isGuildOwner { return true }
        return iHavePermission(Permissions.MANAGE_EMOJIS)
    }
    var canManageEvents: Bool {
        if isGuildOwner { return true }
        return iHavePermission(Permissions.MANAGE_EVENTS)
    }

    // MARK: Guild settings

    func editGuild(name: String, description: String, rulesContent: String? = nil) async -> String? {
        guard let g = selectedGuild else { return nil }
        var patch: [String: Any] = ["name": name]
        patch["description"] = description.isEmpty ? NSNull() : description
        if let rules = rulesContent {
            patch["rulesContent"] = rules.isEmpty ? NSNull() : rules
        }
        do {
            let updated = try await api.patchGuild(guildId: g.id, patch: patch)
            selectedGuild = updated
            if let i = guilds.firstIndex(where: { $0.id == updated.id }) { guilds[i] = updated }
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// True when our membership in the active guild is still pending rules
    /// acknowledgement (onboarding gate).
    var amPendingOnboarding: Bool {
        guard let uid = currentUserId else { return false }
        return members[uid]?.membershipState == "pending"
    }
    func acknowledgeOnboarding() async {
        guard let g = selectedGuild, let uid = currentUserId else { return }
        do {
            try await api.acknowledgeOnboarding(guildId: g.id)
            members[uid]?.membershipState = "active"
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: DM settings

    @Published var dmTtl: Int?
    /// This user's notification-preview choice for the open DM. nil = not set
    /// (use the E2EE-aware default).
    @Published var dmNotifShowContent: Bool?
    @Published var loadingDmSettings = false

    func loadDmSettings(_ channelId: String) async {
        loadingDmSettings = true
        defer { loadingDmSettings = false }
        do {
            let settings = try await api.getDmSettings(channelId: channelId)
            dmTtl = settings.ttlSecondsAfterRead
            dmNotifShowContent = settings.notificationShowContent
        } catch {
            dmTtl = nil
            dmNotifShowContent = nil
        }
    }
    func setDmTtl(_ channelId: String, _ seconds: Int?) async {
        let prev = dmTtl
        dmTtl = seconds
        do { try await api.updateDmSettings(channelId: channelId, ttlSecondsAfterRead: seconds) }
        catch { dmTtl = prev; errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    /// Set this user's notification-preview choice for the open DM (private).
    /// Persist the notification-preview choice. The caller applies the
    /// optimistic value SYNCHRONOUSLY (so the Toggle doesn't snap back when
    /// SwiftUI re-reads its binding); this only writes through to the server
    /// and reverts to `fallback` if that write fails.
    func persistDmNotifShowContent(_ channelId: String, _ value: Bool?, fallback: Bool?) async {
        do { try await api.setDmNotificationPreview(channelId: channelId, showContent: value) }
        catch { dmNotifShowContent = fallback; errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func closeDM(_ channel: Channel) async {
        do {
            try await api.closeDM(channelId: channel.id)
            dms.removeAll { $0.id == channel.id }
            if selectedChannel?.id == channel.id { clearChannel() }
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func deleteSelectedGuild() async {
        guard let g = selectedGuild else { return }
        do { try await api.deleteGuild(guildId: g.id); guilds.removeAll { $0.id == g.id }; showDMs() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func leaveSelectedGuild() async {
        guard let g = selectedGuild else { return }
        do { try await api.leaveGuild(guildId: g.id); guilds.removeAll { $0.id == g.id }; showDMs() }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func createInvite(channel: Channel, maxUses: Int?, ttlSeconds: Int?) async -> Invite? {
        do { return try await api.createInvite(channelId: channel.id, maxUses: maxUses, ttlSeconds: ttlSeconds) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription; return nil }
    }

    func createChannel(type: String, name: String, parentId: String?,
                       topic: String?, linkUrl: String?) async -> String? {
        guard let guild = selectedGuild else { return "No server selected." }
        do {
            _ = try await api.createGuildChannel(guildId: guild.id, type: type, name: name,
                                                 parentId: parentId, topic: topic, linkUrl: linkUrl)
            await loadChannels(guild)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }

    func editChannel(_ channel: Channel, name: String, topic: String, parentId: String?, rateLimitPerUser: Int? = nil) async -> String? {
        guard let guild = selectedGuild else { return nil }
        var patch: [String: Any] = ["name": name]
        patch["topic"] = topic.isEmpty ? NSNull() : topic
        if !channel.isCategory {
            patch["parentId"] = parentId ?? NSNull()
            if let slow = rateLimitPerUser { patch["rateLimitPerUser"] = slow }
        }
        do {
            _ = try await api.patchChannel(channelId: channel.id, patch: patch)
            await loadChannels(guild)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }

    func deleteChannel(_ channel: Channel) async {
        guard let guild = selectedGuild else { return }
        do {
            try await api.deleteChannel(channelId: channel.id)
            if selectedChannel?.id == channel.id { clearChannel() }
            await loadChannels(guild)
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Roles

    func loadRoles(_ guild: Guild) async {
        do { roles = try await api.listRoles(guildId: guild.id) }
        catch { roles = [] }
    }

    private func color(fromRGB rgb: Int) -> Color {
        Color(hex: UInt32(max(0, min(0xFFFFFF, rgb))))
    }

    /// A role's display color, or nil when it has none (0).
    func roleColor(_ role: Role) -> Color? {
        role.color == 0 ? nil : color(fromRGB: role.color)
    }

    /// The color a member's name should paint in — the highest-position
    /// role they hold that has a non-zero color (@everyone never paints).
    func memberColor(_ userId: String) -> Color? {
        guard let rids = members[userId]?.roleIds, !rids.isEmpty else { return nil }
        let assigned = Set(rids)
        var best: Role?
        for r in roles {
            if r.id == selectedGuild?.id { continue }
            guard assigned.contains(r.id), r.color != 0 else { continue }
            if best == nil || r.position > best!.position { best = r }
        }
        guard let b = best else { return nil }
        return color(fromRGB: b.color)
    }

    func memberHasRole(_ userId: String, _ roleId: String) -> Bool {
        members[userId]?.roleIds?.contains(roleId) == true
    }

    func createRole(name: String, color: Int, hoist: Bool, mentionable: Bool, permissions: String) async -> String? {
        guard let guild = selectedGuild else { return "No server selected." }
        do {
            _ = try await api.createRole(guildId: guild.id, name: name, color: color, hoist: hoist, mentionable: mentionable, permissions: permissions)
            await loadRoles(guild); return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func editRole(_ role: Role, name: String, color: Int, hoist: Bool, mentionable: Bool, selfAssignable: Bool, permissions: String) async -> String? {
        guard let guild = selectedGuild else { return nil }
        let patch: [String: Any] = ["name": name, "color": color, "hoist": hoist, "mentionable": mentionable, "selfAssignable": selfAssignable, "permissions": permissions]
        do {
            _ = try await api.patchRole(guildId: guild.id, roleId: role.id, patch: patch)
            await loadRoles(guild); return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func deleteRole(_ role: Role) async {
        guard let guild = selectedGuild else { return }
        do { try await api.deleteRole(guildId: guild.id, roleId: role.id); await loadRoles(guild) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// Grant/revoke a role for a member, then update the cached member.
    func toggleMemberRole(_ userId: String, role: Role) async {
        guard let guild = selectedGuild else { return }
        var set = Set(members[userId]?.roleIds ?? [])
        if set.contains(role.id) { set.remove(role.id) } else { set.insert(role.id) }
        do {
            let updated = try await api.patchMemberRoles(guildId: guild.id, userId: userId, roleIds: Array(set))
            members[userId] = updated
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Self-assignable + reaction roles

    func loadSelfAssignableRoles() async {
        guard let g = selectedGuild else { selfAssignableRoles = []; return }
        loadingSelfRoles = true
        defer { loadingSelfRoles = false }
        do { selfAssignableRoles = try await api.listSelfAssignableRoles(guildId: g.id) }
        catch { selfAssignableRoles = [] }
    }
    func toggleSelfRole(_ role: Role) async {
        guard let g = selectedGuild, let uid = currentUserId else { return }
        let have = memberHasRole(uid, role.id)
        do {
            if have { try await api.revokeSelfRole(guildId: g.id, roleId: role.id) }
            else { try await api.assignSelfRole(guildId: g.id, roleId: role.id) }
            var set = Set(members[uid]?.roleIds ?? [])
            if have { set.remove(role.id) } else { set.insert(role.id) }
            members[uid]?.roleIds = Array(set)
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    func loadReactionRoles() async {
        guard let g = selectedGuild else { reactionRoles = []; return }
        loadingReactionRoles = true
        defer { loadingReactionRoles = false }
        do { reactionRoles = try await api.listReactionRoles(guildId: g.id) }
        catch { reactionRoles = [] }
    }
    func addReactionRole(messageId: String, channelId: String, emoji: String, roleId: String) async -> String? {
        guard let g = selectedGuild else { return "No server selected." }
        do {
            try await api.upsertReactionRole(guildId: g.id, messageId: messageId, channelId: channelId, emoji: emoji, roleId: roleId)
            await loadReactionRoles()
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func deleteReactionRole(_ m: ReactionRoleMapping) async {
        guard let g = selectedGuild else { return }
        do { try await api.deleteReactionRole(guildId: g.id, messageId: m.messageId, emoji: m.emoji); reactionRoles.removeAll { $0.id == m.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Scheduled events

    func loadEvents() async {
        guard let g = selectedGuild else { events = []; return }
        loadingEvents = true
        defer { loadingEvents = false }
        do { events = try await api.listEvents(guildId: g.id) }
        catch { events = [] }
    }
    func createEvent(name: String, description: String?, startAt: Date, endAt: Date?, locationKind: String, channelId: String?, locationText: String?) async -> String? {
        guard let g = selectedGuild else { return "No server selected." }
        let iso = ISO8601DateFormatter()
        var body: [String: Any] = ["name": name, "startAt": iso.string(from: startAt), "locationKind": locationKind]
        if let d = description, !d.isEmpty { body["description"] = d }
        if let e = endAt { body["endAt"] = iso.string(from: e) }
        if locationKind == "voice_channel", let c = channelId { body["locationChannelId"] = c }
        if locationKind == "external", let t = locationText, !t.isEmpty { body["locationText"] = t }
        do {
            let ev = try await api.createEvent(guildId: g.id, body: body)
            events.append(ev); events.sort { $0.startAt < $1.startAt }
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func updateEvent(_ ev: ScheduledEvent, name: String, description: String?, startAt: Date, endAt: Date?, locationKind: String, channelId: String?, locationText: String?) async -> String? {
        guard let g = selectedGuild else { return "No server selected." }
        let iso = ISO8601DateFormatter()
        var patch: [String: Any] = ["name": name, "startAt": iso.string(from: startAt), "locationKind": locationKind]
        patch["description"] = (description?.isEmpty == false) ? description! : NSNull()
        patch["endAt"] = endAt.map { iso.string(from: $0) } ?? NSNull()
        if locationKind == "voice_channel" {
            patch["locationChannelId"] = channelId ?? NSNull(); patch["locationText"] = NSNull()
        } else {
            patch["locationText"] = (locationText?.isEmpty == false) ? locationText! : NSNull(); patch["locationChannelId"] = NSNull()
        }
        do {
            let updated = try await api.updateEvent(guildId: g.id, eventId: ev.id, patch: patch)
            replaceEvent(updated)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func cancelEvent(_ ev: ScheduledEvent) async {
        guard let g = selectedGuild else { return }
        do { let updated = try await api.updateEvent(guildId: g.id, eventId: ev.id, patch: ["status": "canceled"]); replaceEvent(updated) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func deleteEvent(_ ev: ScheduledEvent) async {
        guard let g = selectedGuild else { return }
        do { try await api.deleteEvent(guildId: g.id, eventId: ev.id); events.removeAll { $0.id == ev.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func rsvpEvent(_ ev: ScheduledEvent, status: String) async {
        guard let g = selectedGuild else { return }
        do {
            if ev.myRsvp == status { try await api.clearEventRsvp(guildId: g.id, eventId: ev.id) }
            else { try await api.rsvpEvent(guildId: g.id, eventId: ev.id, status: status) }
            await loadEvents()
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    private func replaceEvent(_ ev: ScheduledEvent) {
        if let i = events.firstIndex(where: { $0.id == ev.id }) { events[i] = ev }
        else { events.append(ev) }
    }

    func loadEventAttendees(_ event: ScheduledEvent, status: String) async {
        guard let g = selectedGuild else { eventAttendees = []; return }
        loadingAttendees = true
        defer { loadingAttendees = false }
        do { eventAttendees = try await api.listEventAttendees(guildId: g.id, eventId: event.id, status: status) }
        catch { eventAttendees = [] }
    }
    func loadMyEvents() async {
        loadingMyEvents = true
        defer { loadingMyEvents = false }
        do { myEvents = try await api.listMyUpcomingEvents() }
        catch { myEvents = [] }
    }

    // MARK: Quick switcher

    /// Gather channels across every guild (reusing the loaded set for the
    /// current guild) so the switcher can jump anywhere.
    func loadSwitcherChannels() async {
        loadingSwitcher = true
        defer { loadingSwitcher = false }
        // Fetch all guilds concurrently — the previous serial loop made the
        // switcher's open latency the SUM of every guild's round-trip.
        // Results keyed by guild id so ordering stays deterministic
        // (guild-list order) regardless of response arrival.
        let current = selectedGuild?.id
        let currentChannels = channels
        let api = self.api
        let fetched = await withTaskGroup(of: (String, [Channel]).self) { group -> [String: [Channel]] in
            for g in guilds where g.id != current {
                let gid = g.id
                group.addTask {
                    (gid, (try? await api.channels(guildId: gid)) ?? [])
                }
            }
            var out: [String: [Channel]] = [:]
            for await (gid, chs) in group { out[gid] = chs }
            return out
        }
        var all: [Channel] = []
        for g in guilds {
            if g.id == current {
                all.append(contentsOf: currentChannels)
            } else {
                all.append(contentsOf: fetched[g.id] ?? [])
            }
        }
        switcherChannels = all
    }
    func jumpToChannel(_ channel: Channel) {
        if let gid = channel.guildId, gid != selectedGuild?.id, let g = guilds.first(where: { $0.id == gid }) {
            selectGuild(g)
        }
        selectChannel(channel)
    }
    func jumpToGuild(_ guild: Guild) { selectGuild(guild) }
    func jumpToDM(_ dm: Channel) { showDMs(); selectChannel(dm) }

    // MARK: Profile cards

    func openProfile(_ user: PublicUser) { profileUser = user }

    func openLightbox(_ url: URL) { lightbox = LightboxImage(url: url) }
    /// Open the full-screen viewer for an already-decoded image (E2EE images,
    /// which have no plaintext URL).
    func openLightbox(image: UIImage) { lightbox = LightboxImage(image: image) }

    // MARK: Forwarding

    /// Forward a message into another channel, then jump there so the
    /// forward is visible. Targets are limited to channels we can reach.
    func forwardMessage(_ message: Message, to channel: Channel) async {
        do {
            _ = try await api.sendMessage(channelId: channel.id, content: "",
                                          nonce: UUID().uuidString, forwardFromMessageId: message.id)
            selectChannel(channel)
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    // MARK: Saved messages

    func loadSaved() async {
        loadingSaved = true
        defer { loadingSaved = false }
        do { saved = try await api.listSavedMessages() }
        catch { saved = [] }
    }
    func isSaved(_ messageId: String) -> Bool { savedIds.contains(messageId) }
    func toggleSave(_ message: Message) async {
        let wasSaved = savedIds.contains(message.id)
        do {
            if wasSaved {
                try await api.unsaveMessage(messageId: message.id)
                savedIds.remove(message.id)
                saved.removeAll { $0.message.id == message.id }
            } else {
                try await api.saveMessage(messageId: message.id)
                savedIds.insert(message.id)
            }
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func loadSavedMembership(_ ids: [String]) async {
        guard !ids.isEmpty else { return }
        do { savedIds.formUnion(try await api.savedMembership(messageIds: ids)) }
        catch {}
    }

    // MARK: Replies

    func setReply(_ message: Message) { replyingTo = message }
    func cancelReply() { replyingTo = nil }

    /// Resolve a replied-to message from the loaded message list (for
    /// rendering the small quoted preview). Nil if it isn't loaded.
    func repliedMessage(for message: Message) -> Message? {
        guard let rid = message.replyToId else { return nil }
        return messages.first(where: { $0.id == rid })
    }

    // MARK: Pins

    func loadPins(_ channel: Channel) async {
        loadingPins = true
        defer { loadingPins = false }
        do { pins = try await api.listPinnedMessages(channelId: channel.id) }
        catch { pins = [] }
    }

    func togglePin(_ message: Message) async {
        guard let channel = selectedChannel else { return }
        do {
            if message.pinned == true {
                try await api.unpinMessage(channelId: channel.id, messageId: message.id)
            } else {
                try await api.pinMessage(channelId: channel.id, messageId: message.id)
            }
            // Refresh both the pin list and the message's own pinned flag.
            await loadPins(channel)
            if let idx = messages.firstIndex(where: { $0.id == message.id }) {
                messages[idx].pinned = !(message.pinned == true)
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Relationship type with a user ("friend" | "incoming_request" |
    /// "outgoing_request" | "blocked"), or nil if none.
    func relationshipType(with userId: String) -> String? {
        relationships.first(where: { $0.user.id == userId })?.type
    }

    // MARK: Gateway events

    private func handleEvent(_ name: String, _ data: Data) {
        switch name {
        case "READY":
            // Consume the voice_states snapshot the server ships in READY.
            // Without this, two things broke after a reconnect: (a) a stale
            // voiceChannelId (a call that ended while we were suspended, whose
            // self-left event hit a dead socket) was never cleared, so
            // handleIncomingCall's `voiceChannelId != channelId` guard
            // permanently swallowed future rings for that DM; (b) a ring that
            // arrived during the socket gap — recoverable only from this
            // snapshot on a fresh IDENTIFY — was thrown away. The web client
            // consumes voice_states here too (VOICE_STATES_SET).
            applyReadyVoiceStates(data)
            if didInitialReady {
                // A READY after the first one means we reconnected following a
                // drop. Re-sync state, since dispatch events were missed while
                // the socket was down (the web client re-bootstraps here too).
                Task { await loadGuilds() }
                Task { await loadDMs() }
                Task { await loadReadStates() }
                // Re-pull the (server-filtered) channel list and re-validate the
                // open channel: a channel may have been made PRIVATE while we
                // were disconnected (offline clients aren't sent the per-user
                // CHANNEL_DELETE — they must refresh on reconnect, like web). If
                // our open channel is no longer visible, pop out of it instead
                // of leaving a now-private channel on screen.
                if let c = selectedChannel {
                    Task {
                        if let g = selectedGuild, !c.isDM { await loadChannels(g) }
                        if c.isDM || channels.contains(where: { $0.id == c.id }) {
                            await loadMessages(c)
                        } else {
                            clearChannel()
                        }
                    }
                }
                // Presence deltas missed while suspended are unrecoverable
                // (no resume/replay) — refetch members so guild status dots
                // converge from the REST snapshot.
                if let g = selectedGuild { Task { await loadMembers(g) } }
            }
            didInitialReady = true
        case "MESSAGE_CREATE":
            let message: Message
            do {
                message = try JSONDecoder().decode(Message.self, from: data)
            } catch {
                // A decode failure must be LOUD in development (it
                // silently swallowed webhook/system messages before) and
                // self-healing in production: refetch the visible channel
                // so the missed message still appears.
                #if DEBUG
                print("[zk] MESSAGE_CREATE decode failed: \(error)\n\(String(data: data.prefix(600), encoding: .utf8) ?? "<binary>")")
                #endif
                if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                   let cid = obj["channelId"] as? String {
                    if let mid = obj["id"] as? String, !mid.isEmpty {
                        bumpChannelLastMessage(cid, mid)
                    }
                    if cid == selectedChannel?.id, let c = selectedChannel {
                        Task { await loadMessages(c) }
                    }
                }
                return
            }
            bumpChannelLastMessage(message.channelId, message.id)
            // A user's message supersedes their typing indicator (web parity).
            if let author = message.authorId ?? message.author?.id {
                typing.removeValue(forKey: author)
                // Our OWN message must never light an unread dot for us —
                // advance our local read marker immediately (the message we
                // just sent from THIS or another device). The server also
                // advances it on create, but doing it locally clears the dot
                // without a round-trip. Guarded by snowflakeGreater so an
                // out-of-order echo can't regress the marker.
                if author == currentUserId {
                    let prev = readStates[message.channelId]?.lastMessageId
                    if prev == nil || snowflakeGreater(message.id, than: prev!) {
                        readStates[message.channelId] = ReadState(
                            channelId: message.channelId, lastMessageId: message.id, mentionCount: 0)
                    }
                }
            }
            if message.channelId == selectedChannel?.id {
                upsert(message)
                if let c = selectedChannel { markChannelRead(c) }
            }
        case "MESSAGE_UPDATE":
            // Payload is the full Message DTO (camelCase), e.g. edits/pins.
            if let m = try? JSONDecoder().decode(Message.self, from: data),
               m.channelId == selectedChannel?.id {
                upsert(m)
            }
        case "DM_STREAK_UPDATE":
            // Payload snake_case: { channel_id, streak }. Update the streak
            // chip live instead of waiting for the next DM-list fetch.
            if let d = jsonDict(data), let cid = d["channel_id"] as? String,
               let streak = d["streak"] as? Int {
                if let i = dms.firstIndex(where: { $0.id == cid }) { dms[i].streak = streak }
                if selectedChannel?.id == cid { selectedChannel?.streak = streak }
            }
        case "MESSAGE_DELETE":
            // Payload is snake_case: { id, channel_id }.
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let cid = obj["channel_id"] as? String, cid == selectedChannel?.id,
               let id = obj["id"] as? String {
                removeMessage(id: id)
            }
        case "MESSAGE_DELETE_BULK":
            // Payload is snake_case: { ids, channel_id }.
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let cid = obj["channel_id"] as? String, cid == selectedChannel?.id,
               let ids = obj["ids"] as? [String] {
                for id in ids { removeMessage(id: id) }
            }
        case "PRESENCE_UPDATE":
            // Server payload is snake_case: { user_id, guild_id, status }.
            // Skip the write when nothing changed — every @Published mutation
            // re-renders all observing views, and presence echoes are the
            // single most frequent event on a busy instance.
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let uid = obj["user_id"] as? String,
               let status = obj["status"] as? String,
               presence[uid] != status {
                presence[uid] = status
            }
        case "TYPING_START":
            // Server payload is snake_case: { channel_id, user_id }.
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let cid = obj["channel_id"] as? String {
                handleTypingStart(channelId: cid, userId: obj["user_id"] as? String)
            }
        case "VOICE_STATE_UPDATE":
            // Payload is the camelCase VoiceState DTO (channelId null = left).
            if let vs = try? JSONDecoder().decode(VoiceState.self, from: data) {
                callLog.info("VOICE_STATE_UPDATE recv user=\(vs.userId, privacy: .public) ch=\(vs.channelId ?? "nil", privacy: .public)")
                handleVoiceSelfMove(vs)
                applyVoiceState(vs)
                handleIncomingCall(vs)
            } else {
                callLog.error("VOICE_STATE_UPDATE decode FAILED: \(String(data: data.prefix(300), encoding: .utf8) ?? "<binary>", privacy: .public)")
            }
        case "CHANNEL_UPDATE":
            // Full channel DTO. Among other things this propagates E2EE
            // enable / disable / re-key to the other recipient *and* to our
            // other devices, so they pick up the current salt + verifier
            // without waiting for a relaunch.
            if let updated = try? JSONDecoder().decode(Channel.self, from: data) {
                handleChannelUpdate(updated)
            }
        case "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE":
            // Payload is snake_case: { channel_id, message_id, user_id, emoji }.
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let cid = obj["channel_id"] as? String,
               let mid = obj["message_id"] as? String,
               let emoji = obj["emoji"] as? String {
                handleReactionEvent(
                    add: name == "MESSAGE_REACTION_ADD",
                    channelId: cid, messageId: mid,
                    userId: obj["user_id"] as? String, emoji: emoji
                )
            }
        case "MESSAGE_REACTION_REMOVE_ALL":
            // All reactions cleared on one message — patch that row in place.
            // The previous full loadMessages() refetch reloaded the whole
            // channel (and reset scroll-adjacent state) for a one-field change.
            if let d = jsonDict(data), (d["channel_id"] as? String) == selectedChannel?.id,
               let mid = d["message_id"] as? String,
               let idx = messages.firstIndex(where: { $0.id == mid }) {
                messages[idx].reactions = []
            }
        case "MESSAGE_POLL_UPDATE":
            // Poll closed/updated (payload carries channel_id, message_id).
            if let d = jsonDict(data), (d["channel_id"] as? String) == selectedChannel?.id,
               let c = selectedChannel { Task { await loadMessages(c) } }
        case "CHANNEL_PINS_UPDATE":
            // Pins changed (payload: { channel_id, last_pin_timestamp }).
            if let d = jsonDict(data), (d["channel_id"] as? String) == selectedChannel?.id,
               let c = selectedChannel { Task { await loadPins(c) } }
        case "CHANNEL_CREATE", "CHANNEL_DELETE":
            // Channel added/removed: DMs go to the DM list, guild channels to
            // the open guild's channel list. A CHANNEL_DELETE also arrives when
            // a channel is made PRIVATE for us (override change) — not just on
            // real deletion — so pop out of it if we're inside, otherwise we'd
            // keep reading the already-loaded history of a now-private channel.
            if let ch = try? JSONDecoder().decode(Channel.self, from: data) {
                if let gid = ch.guildId {
                    // Immediate pop for the direct match (the common case).
                    if name == "CHANNEL_DELETE", ch.id == selectedChannel?.id { clearChannel() }
                    if gid == selectedGuild?.id, let g = selectedGuild {
                        Task {
                            await loadChannels(g)
                            // Category-cascade: a private parent drops its
                            // children without a direct id match above. If our
                            // open guild channel is no longer in the filtered
                            // list, it lost visibility — pop out. Guard on
                            // guildId so a stale-guild event never pops a DM.
                            if let sel = selectedChannel, sel.guildId == gid,
                               !channels.contains(where: { $0.id == sel.id }) {
                                clearChannel()
                            }
                        }
                    }
                } else {
                    Task { await loadDMs() }
                }
            }
        case "CHANNEL_ACK":
            // Cross-device read-state sync: server echoes our ack to all our clients.
            if let rs = try? JSONDecoder().decode(ReadState.self, from: data) {
                readStates[rs.channelId] = rs
            }
        case "GUILD_CREATE", "GUILD_DELETE":
            // Joined/left/created/deleted a guild — refresh the rail.
            Task { await loadGuilds() }
        case "GUILD_MEMBER_ADD", "GUILD_MEMBER_REMOVE":
            // Refresh the member list if it's open for the affected guild.
            if showMembers, let g = selectedGuild, let d = jsonDict(data),
               ((d["guildId"] as? String) ?? (d["guild_id"] as? String)) == g.id {
                Task { await loadMembers(g) }
            }
        case "USER_UPDATE":
            // A user's name/avatar/status changed. Coarser than the web's
            // in-place patch: refresh the open member list so rows update.
            if showMembers, let g = selectedGuild { Task { await loadMembers(g) } }
        case "GUILD_EMOJIS_UPDATE":
            if let d = jsonDict(data), (d["guild_id"] as? String) == selectedGuild?.id {
                Task { await loadEmojis() }
            }
        case "GUILD_STICKERS_UPDATE":
            if let d = jsonDict(data), (d["guild_id"] as? String) == selectedGuild?.id {
                Task { await loadStickers() }
            }
        case "STAGE_PARTICIPANTS_UPDATE":
            // Stage roster changed; refresh if we're viewing that stage.
            if let d = jsonDict(data), (d["channel_id"] as? String) == stageChannelId {
                Task { await refreshStage() }
            }
        case "SCHEDULED_EVENT_CREATE", "SCHEDULED_EVENT_UPDATE", "SCHEDULED_EVENT_DELETE":
            // Refresh the open guild's events, but only if already loaded —
            // matching the web, which doesn't pre-populate guilds whose events
            // modal was never opened.
            if !events.isEmpty, let g = selectedGuild, let d = jsonDict(data),
               ((d["guildId"] as? String) ?? (d["guild_id"] as? String)) == g.id {
                Task { await loadEvents() }
            }
        case "GUILD_UPDATE":
            // Full guild DTO: name/icon/banner/description edits, live.
            if let g = try? JSONDecoder().decode(Guild.self, from: data) {
                if let i = guilds.firstIndex(where: { $0.id == g.id }) { guilds[i] = g }
                if selectedGuild?.id == g.id { selectedGuild = g }
            }
        case "GUILD_MEMBER_UPDATE":
            // Full member DTO: nickname / role changes, live.
            if let m = try? JSONDecoder().decode(GuildMember.self, from: data),
               m.guildId == nil || m.guildId == selectedGuild?.id {
                members[m.userId] = m
            }
        case "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE":
            // Full role DTO. Only the selected guild's roles are held locally.
            if let r = try? JSONDecoder().decode(Role.self, from: data),
               r.guildId == nil || r.guildId == selectedGuild?.id {
                if let i = roles.firstIndex(where: { $0.id == r.id }) {
                    roles[i] = r
                } else {
                    roles.append(r)
                }
            }
        case "GUILD_ROLE_DELETE":
            // Payload is snake_case: { guild_id, role_id }.
            if let d = jsonDict(data),
               (d["guild_id"] as? String) == selectedGuild?.id,
               let rid = d["role_id"] as? String {
                roles.removeAll { $0.id == rid }
            }
        case "MESSAGE_DELIVERED", "MESSAGE_VIEWED":
            // DM read receipts, sent to the message author. Payload is
            // snake_case: { channel_id, message_ids[], delivered_at|viewed_at }.
            if let d = jsonDict(data),
               let cid = d["channel_id"] as? String, cid == selectedChannel?.id,
               let ids = d["message_ids"] as? [String] {
                let idSet = Set(ids)
                for i in messages.indices where idSet.contains(messages[i].id) {
                    if name == "MESSAGE_VIEWED" {
                        messages[i].viewedAt = d["viewed_at"] as? String
                        if messages[i].deliveredAt == nil {
                            messages[i].deliveredAt = messages[i].viewedAt
                        }
                    } else {
                        messages[i].deliveredAt = d["delivered_at"] as? String
                    }
                }
            }
        case "DM_SETTINGS_UPDATE":
            // Cross-device sync of the DM auto-delete TTL. Payload is
            // camelCase: { channelId, ttlSecondsAfterRead }.
            if let d = jsonDict(data),
               let cid = d["channelId"] as? String, cid == selectedChannel?.id {
                dmTtl = d["ttlSecondsAfterRead"] as? Int
            }
        case "FAMILY_REQUEST_CREATE", "FAMILY_FLAG_CREATE":
            // Parental-controls activity: refresh the summary if it's loaded
            // so badges/requests appear without reopening the Family screen.
            if family != nil { Task { await loadFamily() } }
        default:
            break
        }
    }

    /// Parse a gateway `d` payload into a JSON dictionary for snake_case-shaped
    /// events that aren't full model DTOs.
    private func jsonDict(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// Insert a message keeping the list sorted, replacing any existing row
    /// with the same id (prevents duplicate REST + gateway echoes).
    private func upsert(_ message: Message) {
        // If this confirmed message echoes the nonce of an optimistic
        // placeholder, replace the placeholder in place (its id == the nonce).
        if let nonce = message.nonce,
           let phIdx = messages.firstIndex(where: { $0.id == nonce && $0.sendState != nil }) {
            messages[phIdx] = message
            decryptOne(message)
            return
        }
        if let idx = messages.firstIndex(where: { $0.id == message.id }) {
            // Gateway MESSAGE_UPDATE fans ONE DTO to every channel member, so
            // it carries no per-recipient state: poll.myVotes arrives empty
            // and reactions[].me arrives false for everyone. Keep what this
            // device already knows about the current user (REST loads,
            // reaction events, and togglePollVote are the per-self truth).
            var incoming = message
            let prev = messages[idx]
            if var p = incoming.poll, let oldP = prev.poll, p.id == oldP.id, !oldP.myVotes.isEmpty {
                p.myVotes = oldP.myVotes
                incoming.poll = p
            }
            if var rs = incoming.reactions, let oldRs = prev.reactions {
                let mine = Set(oldRs.filter { $0.me }.map { $0.emoji })
                if !mine.isEmpty {
                    for i in rs.indices where mine.contains(rs[i].emoji) { rs[i].me = true }
                    incoming.reactions = rs
                }
            }
            messages[idx] = incoming
        } else {
            messages.append(message)
            messages.sort { $0.createdAt < $1.createdAt }
        }
        decryptOne(message)
    }

    // MARK: E2EE

    enum MessageDisplay {
        case text(String)
        case locked        // encrypted, no key on this device
        case undecryptable // key present but couldn't decrypt (legacy/wrong key)
    }

    /// How to render a message's content, applying DM decryption.
    func display(for message: Message, in channel: Channel) -> MessageDisplay {
        // `e2eeUnlockVersion` is read so SwiftUI re-evaluates after an unlock.
        _ = e2eeUnlockVersion
        let content = message.text
        guard E2EE.isEncrypted(content) else { return .text(content) }
        guard e2eeKey(for: channel) != nil else { return .locked }
        if let pt = decrypted[message.id] { return .text(pt) }
        return .undecryptable
    }

    /// Cached/stored key for a channel, or nil if locked on this device.
    func e2eeKey(for channelId: String) -> Data? {
        if let k = e2eeKeyCache[channelId] { return k }
        guard let b64 = keychain.get(e2eeKeychainKey(channelId)),
              let bytes = Data(base64Encoded: b64), bytes.count == E2EE.keyBytes else { return nil }
        e2eeKeyCache[channelId] = bytes
        return bytes
    }

    func hasE2EEKey(for channelId: String) -> Bool { e2eeKey(for: channelId) != nil }

    /// The key for `channel`, but only when it still matches the channel's
    /// current verifier. A stale key — from an old password, a re-keyed DM, or
    /// a different salt — returns nil so the conversation re-prompts for the
    /// password instead of silently failing to decrypt. Mirrors the web client,
    /// which always re-checks the cached key against `channel.e2eeVerifier`.
    func e2eeKey(for channel: Channel) -> Data? {
        guard let key = e2eeKey(for: channel.id) else { return nil }
        if let expected = channel.e2eeVerifier, E2EE.verifier(forKey: key) != expected {
            return nil
        }
        return key
    }

    func hasE2EEKey(for channel: Channel) -> Bool { e2eeKey(for: channel) != nil }

    /// Forget a cached key that no longer matches the channel's verifier (e.g.
    /// the DM was disabled + re-enabled with a new password). Safe to call from
    /// actions; bumps the unlock version so the UI re-evaluates the lock state.
    func purgeStaleE2EEKey(_ channel: Channel) {
        guard channel.isE2EE, let key = e2eeKey(for: channel.id),
              let expected = channel.e2eeVerifier,
              E2EE.verifier(forKey: key) != expected else { return }
        relockE2EE(channel.id)
    }

    /// Derive + verify + store a key from the user's password. Returns false
    /// (and sets `e2eeError`) when the password doesn't match the verifier.
    @discardableResult
    func unlockE2EE(_ channel: Channel, password: String) async -> Bool {
        e2eeError = nil
        guard let salt = channel.e2eeSalt else {
            e2eeError = "This conversation isn't set up for encryption."
            return false
        }
        // PBKDF2 at 250k iterations takes ~100-500ms — run it off the main
        // actor (AppStore is @MainActor) or the whole UI janks for the
        // duration on older devices. deriveKey is a pure static function,
        // safe to hop.
        guard let key = await Self.deriveKeyOffMain(password: password, saltBase64: salt) else {
            e2eeError = "Couldn't derive a key."
            return false
        }
        if let expected = channel.e2eeVerifier, E2EE.verifier(forKey: key) != expected {
            e2eeError = "Incorrect password."
            return false
        }
        storeKey(key, for: channel.id)
        decryptVisible()
        return true
    }

    /// PBKDF2 on a background task — see unlockE2EE.
    nonisolated private static func deriveKeyOffMain(
        password: String, saltBase64: String
    ) async -> Data? {
        await Task.detached(priority: .userInitiated) {
            E2EE.deriveKey(password: password, saltBase64: saltBase64)
        }.value
    }

    /// Turn on E2EE for a DM: generate salt, derive key, upload salt+verifier,
    /// store the key locally, and flip the channel's local state.
    func enableE2EE(_ channel: Channel, password: String) async -> Bool {
        e2eeError = nil
        let salt = E2EE.generateSalt()
        guard let key = await Self.deriveKeyOffMain(password: password, saltBase64: salt) else {
            e2eeError = "Couldn't derive a key."
            return false
        }
        let verifier = E2EE.verifier(forKey: key)
        do {
            try await api.enableDmE2EE(channelId: channel.id, salt: salt, verifier: verifier)
            storeKey(key, for: channel.id)
            applyE2EEState(channelId: channel.id, enabled: true, salt: salt, verifier: verifier)
            return true
        } catch {
            e2eeError = (error as? APIError)?.message ?? error.localizedDescription
            return false
        }
    }

    /// Turn E2EE off for a DM. The server purges the encrypted history and
    /// broadcasts CHANNEL_UPDATE; we drop the local key and clear decrypted
    /// plaintext immediately so nothing lingers in memory.
    ///
    /// The server now requires proof we know the passphrase: we send the
    /// verifier derived from the cached key. If this device is locked (no
    /// key), we can't prove it — abort and surface an error so the user
    /// unlocks first rather than silently failing.
    func disableE2EE(_ channel: Channel) async {
        guard let key = e2eeKey(for: channel.id) else {
            e2eeError = "Unlock this conversation first to turn off encryption."
            return
        }
        e2eeError = nil
        do {
            try await api.disableDmE2EE(channelId: channel.id, verifier: E2EE.verifier(forKey: key))
        } catch {
            e2eeError = (error as? APIError)?.message ?? "Could not disable encryption."
            return
        }
        relockE2EE(channel.id)
        applyE2EEState(channelId: channel.id, enabled: false, salt: nil, verifier: nil)
        if selectedChannel?.id == channel.id {
            await loadMessages(channel)
        }
    }

    /// Forget the local key (re-locks this device).
    func relockE2EE(_ channelId: String) {
        e2eeKeyCache.removeValue(forKey: channelId)
        keychain.delete(e2eeKeychainKey(channelId))
        for m in messages where m.channelId == channelId {
            decrypted.removeValue(forKey: m.id)
        }
        e2eeUnlockVersion += 1
    }

    private func storeKey(_ key: Data, for channelId: String) {
        e2eeKeyCache[channelId] = key
        keychain.set(key.base64EncodedString(), for: e2eeKeychainKey(channelId))
        e2eeUnlockVersion += 1
    }

    /// Keychain key for a channel's E2EE key, scoped by account so a key
    /// derived under one login is never visible to a different account that
    /// later signs in on the same device.
    private func e2eeKeychainKey(_ channelId: String) -> String {
        "e2ee.\(currentUserId ?? "anon").\(channelId)"
    }

    // MARK: E2EE key backup / restore (cross-client with web)

    /// Bundle every stored DM key for this account into the web-compatible
    /// backup format (E2EE.encodeKeyBackup). Returns nil when this device has
    /// no keys. The Keychain is the source of truth — storeKey always writes
    /// there — so this captures keys even for DMs not currently loaded.
    func exportE2EEKeysJSON() -> Data? {
        let prefix = "e2ee.\(currentUserId ?? "anon")."
        var keys: [String: Data] = [:]
        for (account, b64) in keychain.allValues(prefix: prefix) {
            let channelId = String(account.dropFirst(prefix.count))
            guard !channelId.isEmpty,
                  let bytes = Data(base64Encoded: b64), bytes.count == E2EE.keyBytes else { continue }
            keys[channelId] = bytes
        }
        guard !keys.isEmpty else { return nil }
        let exportedAt = ISO8601DateFormatter().string(from: Date())
        return E2EE.encodeKeyBackup(keys: keys, exportedAt: exportedAt)
    }

    /// Restore keys from a backup file. Returns the channel ids restored, or
    /// nil when the file isn't a valid Zekktris keys backup. Each restored key
    /// is written to both the cache and the Keychain (storeKey). Mirrors web's
    /// importAllDmKeys.
    @discardableResult
    func importE2EEKeysJSON(_ data: Data) -> [String]? {
        guard let keys = E2EE.decodeKeyBackup(data) else { return nil }
        var restored: [String] = []
        for (channelId, bytes) in keys {
            storeKey(bytes, for: channelId)
            restored.append(channelId)
        }
        if !restored.isEmpty { decryptVisible() }
        return restored
    }

    private func decryptVisible() {
        guard let ch = selectedChannel, let key = e2eeKey(for: ch) else { return }
        for m in messages where E2EE.isDecryptable(m.text) && decrypted[m.id] == nil {
            if let pt = E2EE.decrypt(m.text, key: key) { decrypted[m.id] = pt }
        }
    }

    private func decryptOne(_ message: Message) {
        guard E2EE.isDecryptable(message.text), decrypted[message.id] == nil else { return }
        let channel = selectedChannel?.id == message.channelId
            ? selectedChannel
            : dms.first(where: { $0.id == message.channelId })
        guard let channel, let key = e2eeKey(for: channel) else { return }
        if let pt = E2EE.decrypt(message.text, key: key) { decrypted[message.id] = pt }
    }

    private func applyE2EEState(channelId: String, enabled: Bool, salt: String?, verifier: String?) {
        if selectedChannel?.id == channelId {
            selectedChannel?.e2eeEnabled = enabled
            selectedChannel?.e2eeSalt = salt
            selectedChannel?.e2eeVerifier = verifier
        }
        if let i = dms.firstIndex(where: { $0.id == channelId }) {
            dms[i].e2eeEnabled = enabled
            dms[i].e2eeSalt = salt
            dms[i].e2eeVerifier = verifier
        }
    }
}
