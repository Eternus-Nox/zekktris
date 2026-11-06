import Foundation
import SwiftUI
import UIKit
import UserNotifications
import Photos
import WidgetKit
import os

/// Diagnostic log for the 1:1 call ring path. Visible in Console.app
/// (filter subsystem com.zekktris.native, category "calls") even when the
/// app runs outside Xcode — used to pin where an incoming ring is dropped.
private let callLog = Logger(subsystem: "com.zekktris.native", category: "calls")

/// Upload-preparation log — before/after byte counts for every picked photo or
/// video, plus any video export that fell back to the original. Visible in
/// Console.app (subsystem com.zekktris.native, category "media") so the storage
/// win can be confirmed on a real device without instrumenting the server.
/// Sizes only; no filenames, no pixels, nothing derived from message content.
private let mediaLog = Logger(subsystem: "com.zekktris.native", category: "media")

/// Small haptic helpers. Centralized so message/poke feedback is consistent.
enum Haptics {
    /// 2–3 quick taps for an incoming message from someone else.
    @MainActor static func incomingMessage() {
        let gen = UIImpactFeedbackGenerator(style: .medium)
        gen.prepare()
        for i in 0..<3 {
            DispatchQueue.main.asyncAfter(deadline: .now() + Double(i) * 0.16) {
                gen.impactOccurred()
            }
        }
    }

    /// A single firm tap when a poke arrives.
    @MainActor static func poke() {
        let gen = UIImpactFeedbackGenerator(style: .heavy)
        gen.prepare()
        gen.impactOccurred()
    }

    /// A light tap — used for push-to-talk press/release feedback.
    @MainActor static func light() {
        let gen = UIImpactFeedbackGenerator(style: .light)
        gen.prepare()
        gen.impactOccurred()
    }
}

/// Saves images to the Photos library via PhotoKit with an explicit add-only
/// authorization request. The old `UIImageWriteToSavedPhotosAlbum` silently
/// no-ops when add-only access hasn't been granted yet (and offers no error
/// callback) — that's why received photos sometimes never appeared in the
/// gallery. This mirrors the working video-save path.
enum PhotoSaver {
    /// Save raw image bytes verbatim — preserves the original format/quality
    /// (incl. animated GIFs). Preferred whenever we already hold the Data.
    @discardableResult
    static func save(data: Data) async -> Bool {
        guard await ensureAddAccess() else { return false }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.forAsset().addResource(with: .photo, data: data, options: nil)
            }
            return true
        } catch {
            // addResource(.photo) only accepts JPEG/PNG/GIF/HEIC. Non-E2EE
            // images are server-compressed to WEBP, which it rejects — that's
            // why those saves silently failed. Fall back to a decoded UIImage
            // (iOS decodes WebP), which re-encodes to a Photos-native format.
            if let img = UIImage(data: data) { return await save(img) }
            return false
        }
    }

    /// Save a decoded UIImage (used when only an in-memory image is available,
    /// e.g. an already-decrypted E2EE page).
    @discardableResult
    static func save(_ image: UIImage) async -> Bool {
        guard await ensureAddAccess() else { return false }
        do {
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.creationRequestForAsset(from: image)
            }
            return true
        } catch {
            return false
        }
    }

    private static func ensureAddAccess() async -> Bool {
        if PHPhotoLibrary.authorizationStatus(for: .addOnly) == .notDetermined {
            _ = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        }
        let auth = PHPhotoLibrary.authorizationStatus(for: .addOnly)
        return auth == .authorized || auth == .limited
    }
}

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

/// A poke that just arrived — the transient top banner shown on the phone
/// (the watch gets the big-emoji flash instead). No history; purely a nudge.
struct PokeBanner: Identifiable, Equatable {
    let id = UUID()
    let emoji: String
    let name: String
    /// The DM channel the poke arrived on — tap the banner to open the sender.
    let channelId: String
    /// poke|heart|wave|like|fire — tap the emoji to send the SAME one back.
    let pokeType: String
}

/// An achievement that just unlocked — the transient top celebration banner
/// shown on the phone (mirrors the poke banner). Purely a nudge; the badge
/// itself lives in the achievements gallery.
struct AchievementBanner: Identifiable, Equatable {
    let id = UUID()
    let achievementId: String
    let name: String
    let detail: String
}

/// A device-login user code that arrived by deep link and is waiting on the
/// approval screen. Carries ONLY the (public) short code — the deviceCode that
/// actually collects a session never leaves the device that started the
/// request, and nothing here approves anything on its own.
struct PendingDeviceLogin: Identifiable, Equatable {
    let id = UUID()
    let userCode: String
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
        // Close the members drawer too (this rail path bypasses resetStack),
        // so every rail action consistently dismisses it.
        showMembers = false
        railPage = (railPage == page) ? nil : page
    }

    /// Locally-collapsed channel-list categories (per-device, like the web).
    @Published var collapsedCategories: Set<String> = Set(UserDefaults.standard.stringArray(forKey: "zk.collapsedCategories") ?? [])
    func toggleCategoryCollapsed(_ id: String) {
        if collapsedCategories.contains(id) { collapsedCategories.remove(id) } else { collapsedCategories.insert(id) }
        UserDefaults.standard.set(Array(collapsedCategories), forKey: "zk.collapsedCategories")
    }
    /// True only while bumpChannelLastMessage updates a channel's lastMessageId.
    /// That's not a sort key and doesn't affect <#channel> mention labels, so the
    /// didSet skips the O(n log n) re-sort AND the mentionContextVersion bump —
    /// the bump would otherwise re-render every open message row on EVERY inbound
    /// message in ANY channel (it's part of MessageRowData's Equatable key).
    private var bumpingLastMessage = false
    @Published var channels: [Channel] = [] {
        // Memoize the position-sorted order so the channel list doesn't re-sort
        // on every SwiftUI render. The list derives categories + per-category
        // rows from `sortedChannels`, each of which used to re-run this O(n log n)
        // sort — so a content-heavy server re-sorted ~once per category on every
        // state change (presence churn included), the Mac slowdown. Recomputed
        // only when `channels` actually changes.
        didSet {
            if bumpingLastMessage { return } // lastMessageId-only bump (see below)
            sortedChannels = channels.sorted { a, b in
                let pa = a.position ?? 0, pb = b.position ?? 0
                return pa != pb ? pa < pb : a.id < b.id
            }
            // Group the sorted channels once (single order-preserving pass) so
            // the sidebar indexes per-category instead of re-filtering
            // sortedChannels for every category on every render. Same predicates
            // as ChannelListView's sortedCategories / uncategorizedChannels /
            // channels(in:).
            var cats: [Channel] = []
            var uncat: [Channel] = []
            var byParent: [String: [Channel]] = [:]
            for c in sortedChannels {
                if c.isCategory { cats.append(c); continue }
                if c.isThread { continue }
                if let pid = c.parentId { byParent[pid, default: []].append(c) }
                else { uncat.append(c) }
            }
            categoryChannels = cats
            uncategorizedChannels = uncat
            channelsByCategory = byParent
            // id → Channel for O(1) <#channel> mention-label resolution (was a
            // linear store.channels.first(where:) per mention token per render).
            // All channels incl. categories/threads so any id resolves.
            var byId: [String: Channel] = [:]
            byId.reserveCapacity(channels.count)
            for c in channels { byId[c.id] = c }
            channelById = byId
            // Channel renames feed <#channel> mention labels in message rows.
            mentionContextVersion &+= 1
        }
    }
    /// id → Channel for O(1) mention-label lookup — see the `channels` didSet.
    @Published private(set) var channelById: [String: Channel] = [:]
    /// `channels` pre-sorted by (position, id) — see the didSet on `channels`.
    @Published private(set) var sortedChannels: [Channel] = []
    /// Sidebar groupings derived once in the `channels` didSet (single pass) so
    /// ChannelListView indexes into them instead of re-filtering sortedChannels
    /// per category on every render.
    @Published private(set) var categoryChannels: [Channel] = []
    @Published private(set) var uncategorizedChannels: [Channel] = []
    @Published private(set) var channelsByCategory: [String: [Channel]] = [:]
    @Published var messages: [Message] = [] {
        didSet { if !suppressIndexRebuild { rebuildMessageIndex() } }
    }
    /// id → Message lookup kept in lockstep with `messages`. Whole-array
    /// assignments/insert/remove rebuild it (didSet); in-place single-element
    /// subscript writes go through `mutateMessage(at:)`, which patches only the
    /// touched id — avoiding an O(N) rebuild per reaction/receipt/poll/pin.
    private var messagesById: [String: Message] = [:]
    private var suppressIndexRebuild = false

    private func rebuildMessageIndex() {
        var idx = [String: Message](minimumCapacity: messages.count)
        // first(where:) returns the FIRST match; preserve that by not
        // overwriting an id already inserted from an earlier element.
        for m in messages where idx[m.id] == nil { idx[m.id] = m }
        messagesById = idx
    }

    /// Mutate one already-present message in place WITHOUT a full index rebuild.
    /// The element's id is unchanged, so it maps to the same slot — the
    /// first-occurrence invariant holds. The @Published republish still fires
    /// (SwiftUI sees the array write) exactly as before.
    private func mutateMessage(at idx: Int, _ body: (inout Message) -> Void) {
        suppressIndexRebuild = true
        body(&messages[idx])
        suppressIndexRebuild = false
        messagesById[messages[idx].id] = messages[idx]
    }
    /// Per-channel snapshot of the last-viewed message list, keyed by channel id.
    /// Seeds `messages` synchronously on reopen so a revisited conversation paints
    /// instantly while loadMessages refreshes in the background. Not @Published
    /// (views read `messages`, never this); per-session, cleared on stop().
    private var messageCache: [String: [Message]] = [:]
    /// Channel-id recency for messageCache, most-recent last. Bounds the cache
    /// to MESSAGE_CACHE_MAX channels so a long session that visits hundreds of
    /// conversations doesn't grow the cache without limit (each entry is up to
    /// 100 Message structs). The selected channel is never evicted.
    private var messageCacheLRU: [String] = []
    private let messageCacheMax = 48
    /// True for the single render in which we open a channel we already have
    /// cached — lets MainView skip the route cross-fade so a cached open POPS
    /// instead of fading. Set in selectChannel before the push, reset in openChannel.
    @Published var openingCachedChannel = false

    @Published var selectedGuild: Guild?
    @Published var selectedChannel: Channel?

    /// A poke just arrived — drives the transient top banner (foreground only).
    /// The watch gets the big-emoji flash; the phone shows this small banner.
    @Published var pokeBanner: PokeBanner?

    /// The last poke received in each DM, as its emoji, waiting to be seen.
    ///
    /// The banner above lasts five seconds, which means a poke sent while the
    /// phone was in a pocket left no trace at all. This is the trace: the DM
    /// row shows the emoji until that conversation is opened.
    ///
    /// Deliberately not persisted — a nudge, not a ledger. Surviving a relaunch
    /// would make it a second unread system to clear.
    @Published var pokePills: [String: String] = [:]

    /// An achievement just unlocked — drives the transient top celebration
    /// banner (foreground only). Set by the ACHIEVEMENT_UNLOCK gateway event.
    @Published var achievementBanner: AchievementBanner?

    /// A `zekktris://device-login?code=…` link arrived — RootView presents the
    /// approval screen for it. Set ONLY by handleDeepLink; it carries a code to
    /// look up, never a decision. Cleared when the sheet closes.
    @Published var pendingDeviceLogin: PendingDeviceLogin?

    /// Direct-message channels for the current user.
    @Published var dms: [Channel] = []
    @Published var relationships: [Relationship] = []
    /// Personal DM nicknames: [targetUserId: nickname]. Viewer-private labels
    /// shown in place of a user's name in direct messages only. Hydrated at
    /// login (like relationships) and applied wherever a DM peer renders.
    @Published var dmNicknames: [String: String] = [:]
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
    @Published var guildEmojis: [GuildEmoji] = [] {
        // Keep the name→emoji lookup in sync here (cheap, only when the emoji
        // list actually changes) instead of rebuilding the dictionary on every
        // read — emojiByName is hit per message + per reaction during render.
        didSet {
            emojiByName = Dictionary(
                guildEmojis.map { ($0.name, $0) }, uniquingKeysWith: { _, latest in latest }
            )
            emojiCatalogVersion &+= 1
        }
    }
    @Published var emojiImages: [String: UIImage] = [:] {
        // Custom-emoji renders fill this dict ASYNCHRONOUSLY after first use.
        // Bump the catalog version so value-type message rows (which read
        // emojiImage(for:) through a non-observing plain store ref) re-render
        // when an image finally arrives — otherwise a row that doesn't
        // otherwise change would keep showing the literal `:name:` text.
        didSet { emojiCatalogVersion &+= 1 }
    }
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

    /// Resolve a `:name:` token to a guild emoji. Cached from `guildEmojis`
    /// (kept current by its didSet) rather than rebuilt on each access.
    @Published private(set) var emojiByName: [String: GuildEmoji] = [:]

    /// Monotonic change signals for state that value-type message rows resolve
    /// at RENDER time (through a non-observing plain store ref) rather than
    /// snapshotting field-by-field. MessageRow reads the emoji catalog
    /// (emojiByName/emojiImage) and the mention name maps (channels/roles/
    /// members) lazily; bumping these in the relevant didSet lets a row's
    /// Equatable data differ so it re-renders when those maps change, without
    /// the row having to observe the whole store. See MessageRowData.
    @Published private(set) var emojiCatalogVersion = 0
    @Published private(set) var mentionContextVersion = 0

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
        // Share Suggestions are switched off (see `ShareSuggestions
        // .donationsEnabled`), but a build that shipped with them ON may have
        // written contacts into this device's system share/Siri index — turning
        // donation off removes none of them. One-shot per install, then a single
        // UserDefaults read on every launch after.
        ShareSuggestions.purgeLegacyDonationsIfNeeded()
        wireCallKit()
        wirePushRouting()
        Self.shared = self
    }

    /// CallKit → store: the system call screen's Answer/End/Mute drive the
    /// same paths as the in-app buttons. Also the call-level events VoiceManager
    /// raises itself (LiveKit dropping the call, a forced mic mute).
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
            // Go straight through openVoice — the SAME path the in-app Answer
            // button uses — so a CallKit answer behaves identically to an
            // in-app answer (which works for E2EE calls). A previous guard
            // ended the CallKit call when the E2EE key wasn't immediately
            // available; that made E2EE calls UN-answerable from the lock
            // screen (the app opened but nothing connected). openVoice reads
            // the key (keychain, AfterFirstUnlock — readable here) at connect
            // time, exactly like the in-app path.
            if let call = self.incomingCall, call.channelId == channelId {
                // Locked E2EE with NO key on this device (never unlocked): openVoice
                // would just set e2eeError and return, leaving the CallKit call
                // "answered" but connected to nothing while the caller keeps
                // ringing. End the CallKit call + decline server-side instead so
                // the caller stops. Uses the SAME keychain-backed e2eeKey check
                // openVoice uses at connect time, so a key that IS present (just
                // not in memory yet) still answers normally — no regression to the
                // old "E2EE calls unanswerable" guard.
                if call.channel.isE2EE && self.e2eeKey(for: call.channel) == nil {
                    self.e2eeError = "Unlock this conversation to answer the encrypted call."
                    CallManager.shared.endFromApp(channelId: channelId)
                    return
                }
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
                    } else {
                        // We answered system-side but cannot resolve the DM (the
                        // loadDMs failed on a waking radio, or the channel is
                        // gone). Silently returning left the CallKit call
                        // "connected" with NOTHING behind it — the system call
                        // screen stays up forever, tapping through reaches no
                        // call, and the caller rings into a dead end. End it
                        // instead so both sides get a clean result.
                        CallManager.shared.endFromApp(channelId: channelId)
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
        CallManager.shared.onRingTimeout = { [weak self] channelId in
            guard let self else { return }
            // The ring expired unanswered. CallKit has already dismissed its own
            // call; clear OUR ringing UI (which otherwise kept the overlay and
            // ringtone going indefinitely) and decline server-side so the caller
            // stops ringing into a dead end.
            if let call = self.incomingCall, call.channelId == channelId {
                self.incomingCall = nil
            }
            Task { await self.api.declineCall(channelId: channelId) }
        }
        CallManager.shared.onSetMuted = { [weak self] muted in
            guard let self else { return }
            callLog.info("CallKit set muted=\(muted)")
            // SET the state CallKit asked for. This used to compare isMuted
            // and then TOGGLE, but isMuted only changed after the await, so
            // two actions in a row (CallKit's echo, an iOS 17+ burst) both saw
            // the old value and the mic ended up wherever the race left it.
            // The server only hears about a real change.
            Task {
                if await self.voice.setMuted(muted) {
                    guard let id = self.voiceChannelId else { return }
                    await self.api.updateVoiceState(channelId: id, selfMute: self.voice.isMuted, selfDeaf: nil)
                } else if self.voice.isMuted != muted, VoiceManager.callAudioActive,
                          let id = self.voiceChannelId {
                    // Refused (an unmute while deafened) or LiveKit failed it.
                    // CallManager has already recorded CallKit's new state, so
                    // without this the lock screen / AirPods and the app would
                    // disagree until the next real change: push the app's
                    // actual state back to CallKit (its echo is filtered;
                    // push-to-talk is left alone, as in reportMuteToCallKit).
                    // Only with a live session (connecting, connected or
                    // reconnecting): before the Room exists the refusal is not
                    // a "no", and performConnect starts the call muted from
                    // CallKit's state instead.
                    self.reportMuteToCallKit(channelId: id)
                }
            }
        }
        CallManager.shared.onAudioActivated = { [weak self] in
            guard let self else { return }
            // CallKit just activated the session — make sure the mic is
            // actually capturing on it (the room connected with the engine
            // gated, so the initial publish may not have started capture).
            Task { await self.voice.ensureMicEnabled() }
        }
        voice.onConnectionLost = { [weak self] takenOver, lostChannelId in
            // Only the channel whose Room died. During a switch joinVoice has
            // already pointed voiceChannelId at the new channel while the old
            // Room is still VoiceManager's, and hanging up "whatever is current"
            // ended the call being joined (e.g. one just answered from the lock
            // screen while guild voice was reconnecting). Stage Rooms carry no
            // tag and are ignored, as before.
            guard let self, let lostChannelId, self.voiceChannelId == lostChannelId else { return }
            callLog.info("LiveKit ended the call itself (takenOver=\(takenOver)); hanging up")
            // LiveKit gave up (reconnects exhausted, signalling ping timed
            // out), or the server removed us and no gateway update followed
            // (see VoiceManager.room(_:didDisconnectWithError:); a move or a
            // kick is otherwise left to VOICE_STATE_UPDATE). Hang up properly
            // instead of leaving a dead call on screen: this ends the CallKit
            // call and tells the server, so the peer's 1:1 auto-end fires too.
            // When another of our devices took the call over, only tear down
            // locally: the server's voice state is that device's now, and a
            // leave would drop it.
            Task {
                // A join replacing the dead Room may have claimed the slot since.
                guard self.voiceChannelId == lostChannelId else { return }
                await self.leaveCurrentVoice(notifyServer: !takenOver, hangupCue: false)
            }
        }
        voice.onMuteChangedInternally = { [weak self] muted in
            // A failed mic publish muted us, a retry recovered it, or the call
            // started muted for a CallKit mute pressed while it was joining.
            // Mirror it into the server's selfMute so the peer's mute icon
            // tells the truth (the join always records us unmuted).
            guard let self, let id = self.voiceChannelId else { return }
            Task { await self.api.updateVoiceState(channelId: id, selfMute: muted, selfDeaf: nil) }
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
            let messageId = dict["messageId"] as? String
            Task { @MainActor in
                self?.openFromPush(channelId: channelId, messageId: messageId, autojoin: autojoin)
            }
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

    /// Debounce so a notification tap and the scenePhase .active handler —
    /// which fire within the same wake — don't tear the socket down twice.
    private var lastForegroundReconnectAt: Date = .distantPast

    /// foregroundReconnect(), debounced (1.5s). Safe to call from every wake
    /// signal; only the first caller in the window does the work.
    func foregroundReconnectDebounced() {
        guard Date().timeIntervalSince(lastForegroundReconnectAt) > 1.5 else { return }
        lastForegroundReconnectAt = Date()
        foregroundReconnect()
    }

    /// Navigate to a channel from a notification tap; loads DMs first when
    /// the target isn't in memory yet (cold launch). Also opens the
    /// conversation a share was sent to (consumeStagedShare), which can be a
    /// DM, a group DM or a guild channel. `onUnresolved` runs (on the main
    /// actor) when the channel can't be found at all — deleted, no longer
    /// visible to us, or the fetch failed. A share passes `reviveSocket:
    /// false`: it is consumed from the .active transition or right after
    /// store.start, which already (re)connect.
    func openFromPush(
        channelId: String, messageId: String?, autojoin: Bool,
        reviveSocket: Bool = true,
        onUnresolved: (() -> Void)? = nil
    ) {
        // A notification tap IS a foreground wake — but it can race the
        // scenePhase .active transition (navigation runs first on some paths),
        // and the tapped conversation must not depend on that ordering. Revive
        // the socket + run the full REST resync NOW so the chat we're about to
        // open loads fresh and the next send has a live session behind it.
        if reviveSocket { foregroundReconnectDebounced() }
        func open(_ ch: Channel) {
            // MUST be read BEFORE showDMs(): that call nils `selectedChannel`, so
            // reading this after it made `alreadyOpen` unconditionally FALSE for
            // every DM. The whole alreadyOpen branch below was therefore dead code
            // on the exact path it was written for — which is why this bug
            // survived several rounds of fixes aimed squarely at it.
            var alreadyOpen = selectedChannel?.id == ch.id
            if ch.isDM { showDMs(preservingSelection: alreadyOpen) }
            if autojoin { openVoice(ch); return }
            // Selected is not the same as on screen: Mentions resets the stack
            // but keeps selectedChannel, and a rail page can cover the list.
            // Treating that as open set an anchor nothing consumed and never
            // navigated (the same bug as openMention's). Uncover a list that is
            // merely covered; otherwise close it and take the full open below.
            if alreadyOpen, !isShowingMessages(of: ch) {
                if case .messages(let c)? = stack.last, c.id == ch.id {
                    railPage = nil
                    railContent = .normal
                } else {
                    leaveOpenConversation()
                    alreadyOpen = false
                }
            }
            if !alreadyOpen {
                // A compact rail page (Discover, Admin…) is a full-screen cover:
                // a channel pushed under it is not on screen — the tap seems to
                // do nothing, and its composer never takes a waiting share
                // (isShowingMessages). showDMs (a DM) and selectGuild (another
                // guild's channel) clear this already; a channel of the guild
                // that is already loaded did not.
                railPage = nil
                railContent = .normal
            }
            if alreadyOpen {
                // We're already sitting in this conversation, so the view will NOT
                // remount and nothing reloads on its own — this Task is the only
                // thing that fetches. Do exactly ONE latest-window merge.
                //
                // Deliberately NOT also calling loadMessages(): it REPLACES the
                // array while this merges into it, so the two race, and a replace
                // whose fetch fails on a waking radio (the norm right after a push
                // tap) can drop the very rows the merge just brought in. The merge
                // is also non-disruptive — it keeps scroll position and in-flight
                // optimistic sends, which a replace does not.
                //
                // Drop any stale deep-link jump first: refreshOpenChannelLatest
                // bails outright while pendingJumpMessageId != nil (:1972), and a
                // notification tap means "show me the new message", not "hold my
                // place at an old one".
                pendingJumpMessageId = nil
                Task {
                    await refreshOpenChannelLatest()
                    if let messageId {
                        pendingScrollAnchorId = messageId
                        if !ch.isDM, let m = messages.first(where: { $0.id == messageId }) {
                            replyingTo = m
                        }
                    }
                }
            } else if let messageId {
                // Not open: loadMessages fetches a window AROUND this id, scrolls
                // to it, and (guild) sets replyingTo once it's loaded. The route
                // genuinely changes here, so the view remounts and .onAppear →
                // openChannel → loadMessages runs.
                pendingJumpMessageId = messageId
                if !ch.isDM { pendingReplyMessageId = messageId }
                selectChannel(ch)
            } else {
                selectChannel(ch)
            }
        }
        if let dm = dms.first(where: { $0.id == channelId }) { open(dm); return }
        if let ch = channels.first(where: { $0.id == channelId }) { open(ch); return }
        Task {
            await loadDMs()
            if let dm = dms.first(where: { $0.id == channelId }) { open(dm); return }
            if let ch = channels.first(where: { $0.id == channelId }) { open(ch); return }
            // Guild text channel not in memory yet (cold launch, before any guild
            // is selected — `channels` only holds the current guild's). Fetch the
            // channel to learn its owning guild, switch to that guild, then open
            // it. Without this, a tapped guild-channel notification fell through
            // to the default landing instead of opening the channel.
            guard let ch = try? await api.channel(id: channelId) else {
                onUnresolved?()
                return
            }
            if let gid = ch.guildId, !gid.isEmpty {
                if guilds.isEmpty { await loadGuilds() }
                if let guild = guilds.first(where: { $0.id == gid }) {
                    selectGuild(guild)
                }
            }
            open(ch)
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
    @Published var members: [String: GuildMember] = [:] {
        // Member names feed <@user> mention labels in message rows. (Presence
        // does NOT live here — it's in `presence` — so this didSet does not
        // fire on per-second status churn, only on real member changes.)
        didSet { mentionContextVersion &+= 1 }
    }
    /// Roles for the selected guild (drives name colors + hoisted sections).
    @Published var roles: [Role] = [] {
        // Role renames feed <@&role> mention labels, and role colors feed name
        // colors, in message rows.
        didSet {
            // id → Role for O(1) <@&role> mention-label resolution (was a linear
            // store.roles.first(where:) per mention token per render).
            var rb: [String: Role] = [:]
            rb.reserveCapacity(roles.count)
            for r in roles { rb[r.id] = r }
            roleById = rb
            mentionContextVersion &+= 1
        }
    }
    /// id → Role for O(1) mention-label lookup — see the `roles` didSet.
    @Published private(set) var roleById: [String: Role] = [:]
    /// When non-nil, a ProfileCard sheet is shown for this user.
    @Published var profileUser: PublicUser?
    /// Drives the guild member-list sheet.
    @Published var showMembers = false
    /// Drives the self-profile / Settings pop-up sheet. Settings presents as a
    /// sheet (like Friends / Saved) instead of a rail page so it reads as a
    /// pop-up over the app rather than a full-screen takeover. Opened from the
    /// rail avatar; closed via the "<" back button (interactive drag-dismiss is
    /// disabled — see the presenter in MainView for the hit-test rationale).
    @Published var showSettingsSheet = false
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
    @Published var presence: [String: String] = [:] {
        // A cheap monotonic stamp so views can memoize presence-derived work
        // (e.g. MemberListView.sections) and recompute only when presence
        // actually flushed, not on every unrelated AppStore publish. Plain var
        // (not @Published) — it rides the presence change that already
        // re-evaluates observing views.
        didSet { presenceVersion &+= 1 }
    }
    /// Bumped whenever `presence` flushes. See presence.didSet.
    private(set) var presenceVersion = 0
    /// Coalescing buffer for live PRESENCE_UPDATE events. On a cold-launch READY
    /// burst (and on busy instances) presence is by far the most frequent event;
    /// writing `presence` per-event re-ran the whole MainView body (incl. the
    /// swipe-gesture container) on nearly every frame, dropping the first taps
    /// ("tap 3x to navigate"). We buffer here and flush into `presence` in ONE
    /// mutation on a short debounce — collapsing dozens of rebuilds into a few.
    /// Safe vs the loadDMs presence-merge: the flush applies live state LAST, so
    /// a live event still wins over the REST baseline (see performLoadDMs).
    private var pendingPresence: [String: String] = [:]
    private var presenceFlushScheduled = false
    /// Per-user typing expiry for the *selected* channel (userId → when it lapses).
    @Published var typing: [String: Date] = [:]
    /// True when the DMs surface (rather than a guild) is selected.
    // Default TRUE: DMs is the home screen, so the very first render after
    // launch is already "root-dms". Otherwise the initial inDMs=false →
    // showDMs() flip changed routeKey once at launch, re-identifying the
    // content column (.id(routeKey)) and dropping a tap that landed during the
    // swap. start()/openFromPush/selectGuild still set it as needed.
    @Published var inDMs = true
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
    /// When set, the next channel load fetches messages AROUND this id (instead
    /// of the most recent page) and then scrolls to it — used by "jump to
    /// mention" and by a notification tap deep-linking to a specific message.
    /// Consumed by loadMessages.
    var pendingJumpMessageId: String?
    /// Set from a notification tap in a GUILD channel: once the target message
    /// loads, the composer prefills a reply to it (so a response goes back as a
    /// reply to that user). DMs skip this — there's only one other person.
    /// Consumed by loadMessages; cleared on leaving a channel.
    var pendingReplyMessageId: String?
    /// Per-channel read markers (channelId → ReadState), driving unread dots
    /// and mention badges on channels and DMs.
    @Published var readStates: [String: ReadState] = [:]
    /// Notification mute levels keyed by target id (guild or channel id) →
    /// "all" | "mentions" | "nothing". "nothing" == muted. Absence = default.
    /// The server already gates push fan-out on these; the client holds them so
    /// the rail menu can show Mute vs Unmute. Hydrated by loadNotificationOverrides().
    @Published var notificationOverrides: [String: String] = [:]
    /// One-shot guard so the token-refresh→watch-resync observer is added once.
    private var watchTokenObserverInstalled = false
    /// Frozen last-read message id for the open channel, captured before acking,
    /// so the "New messages" divider stays put where the user left off.
    @Published var unreadBoundaryId: String?
    @Published var loadingThreads = false
    /// Attachment / voice-note uploads in flight. A counter, not a flag: a
    /// voice note finishing while a large attachment upload is still running
    /// must not clear `uploading` (it re-enabled the attachment send and hid
    /// the spinner mid-upload).
    @Published private var activeUploads = 0
    var uploading: Bool { activeUploads > 0 }
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
    /// In-memory cache of DECRYPTED E2EE attachment bytes, keyed by attachment
    /// id, so a photo that scrolls out and back (or is reopened in the media
    /// gallery / lightbox) doesn't re-fetch + re-decrypt every time. In-memory
    /// ONLY — never written to disk; cleared on relock / sign-out so plaintext
    /// never outlives the key.
    ///
    /// This is a manual LRU rather than NSCache on purpose: NSCache auto-evicts
    /// under system memory pressure, which made decrypted media silently
    /// vanish and re-decrypt mid-session. Decrypted media should STAY viewable
    /// for the whole logged-in session (as long as the key is held), so we only
    /// evict the least-recently-used entries when we exceed an explicit budget.
    private var decryptedMedia: [String: Data] = [:]
    /// Recency queue for `decryptedMedia` (oldest first), kept in sync with it.
    private var decryptedMediaLRU: [String] = []
    private var decryptedMediaBytes = 0
    private let decryptedMediaMaxBytes = 256 * 1024 * 1024 // 256 MB
    private let decryptedMediaMaxCount = 256
    /// Legacy default-group keychain — kept as the read/migrate fallback for
    /// E2EE keys stored by builds before the app-group move (see below).
    private let keychain = KeychainStore()
    /// App-group keychain: where E2EE keys now live so the Notification Service
    /// Extension can read them to decrypt message previews on-device. Falls
    /// back to `keychain` transparently when the App Group isn't provisioned.
    private let e2eeKeychain = KeychainStore(accessGroup: AppGroupConfig.identifier)

    let api = APIClient.shared
    let gateway = Gateway()

    /// Current user's id — set at start; used to attribute reaction events.
    var currentUserId: String?
    /// The signed-in user, used to author optimistic message placeholders.
    @Published var currentUser: SelfUser?

    // MARK: Perk gates (admin-configurable)

    /// Admin-configured perk matrix, fetched fire-and-forget on start() and
    /// every foreground reconnect. nil (old server / fetch failed / not yet
    /// loaded) → the built-in defaults below, which match the server's.
    @Published var monetizationConfig: MonetizationConfig?

    /// Tier ladder: none=0 scout=1 guardian=2 legend=3 (unknown → 0).
    static func tierRank(_ tier: String?) -> Int {
        switch tier {
        case "scout": return 1
        case "guardian": return 2
        case "legend": return 3
        default: return 0
        }
    }

    /// Minimum perk tier required to publish the camera at `q`, per the
    /// admin-configured matrix — or the built-in defaults (1080p for
    /// everyone, 2K Guardian, 4K Legend) when no config is loaded. nil = free.
    /// 720p and below are ALWAYS free (never configurable).
    func requiredCameraTier(for q: CameraQuality) -> String? {
        let required: String
        switch q {
        case .high: required = monetizationConfig?.camera.p1080 ?? "none"
        case .k2: required = monetizationConfig?.camera.k2 ?? "guardian"
        case .k4: required = monetizationConfig?.camera.k4 ?? "legend"
        default: return nil
        }
        return required == "none" ? nil : required
    }

    /// True when the signed-in user's tier meets the configured minimum for
    /// camera quality `q`.
    func cameraQualityAllowed(_ q: CameraQuality) -> Bool {
        cameraQualityAllowed(q, rank: Self.tierRank(currentUser?.subscriptionTier))
    }

    func cameraQualityAllowed(_ q: CameraQuality, rank: Int) -> Bool {
        guard let required = requiredCameraTier(for: q) else { return true }
        return rank >= Self.tierRank(required)
    }

    /// What a session at `rank` gets, for the Settings perk list. Screen
    /// share runs on web and desktop only; its defaults match the server's
    /// (everyone 720p30, Scout 1080p + 60fps, Guardian 2K, Legend 4K).
    func perkLines(forRank rank: Int) -> [String] {
        let s = monetizationConfig?.stream
        let screenGates: [(String, String)] = [
            ("4K", s?.k4 ?? "legend"), ("2K", s?.k2 ?? "guardian"), ("1080p", s?.p1080 ?? "scout"),
        ]
        let screen = screenGates.first { rank >= Self.tierRank($0.1) }?.0 ?? "720p"
        let fps = rank >= Self.tierRank(s?.fps60 ?? "scout") ? 60 : 30
        let camera = [CameraQuality.k4, .k2, .high].first { cameraQualityAllowed($0, rank: rank) }?.shortLabel ?? "720p"
        return ["Screen share up to \(screen) at \(fps) fps on web & desktop", "Camera up to \(camera)"]
    }

    /// Refresh the perk matrix. Failures are swallowed and keep the
    /// last good config (or nil → defaults), so an old server or a flaky
    /// network never changes entitlement behavior mid-session.
    func loadMonetizationConfig() async {
        if let cfg = try? await api.monetization() { monetizationConfig = cfg }
    }

    // MARK: Automatic presence (online ↔ idle)
    //
    // This device is "in use" while the app is in the foreground and was
    // touched within 5 minutes (or we're talking in voice); backgrounded is
    // idle at once (DevicePresence.isActive). Every evaluation reports that to
    // the gateway (Gateway.setPresenceActive), which sends it only on a change.
    //
    // A server with multi-device presence (READY features.presence_activity,
    // or a self user carrying chosenStatus) derives the status everyone sees
    // from the chosen status plus EVERY device's activity: the phone in use
    // reads online even while the idle Mac would say away. The app then never
    // writes the status itself — only the status picker does.
    //
    // Older servers keep the legacy auto-away below: "Online" is an AUTOMATIC
    // mode there — while the chosen status is online the app flips to idle (5+
    // min without UI interaction and not talking) and back to online on
    // activity. A MANUALLY chosen idle, dnd, and invisible are all manual and
    // untouched (tracked via `autoSetIdle` so a user-set idle is never
    // auto-bounced to online). Offline is handled by the gateway disconnect
    // (background/close). Pushes go through `autoStatusPush` (wired to
    // Session.setStatus) so it reuses the normal status path; the chosen
    // status is read via `currentChosenStatus`. AFK voice-channel relocation
    // is a separate, already-built server sweep (guilds.afkChannelId).
    static let autoIdleThresholdSeconds: TimeInterval = DevicePresence.idleThresholdSeconds
    /// Pushes an automatic status to the server (set by the app to
    /// Session.setStatus with `manual: false`, so no `statusSource: "manual"`
    /// marker). Legacy servers only; never called when `serverDerivesPresence`.
    var autoStatusPush: ((String) async -> Void)?
    /// Reads the user's current chosen status (set by the app to
    /// Session.currentUser's chosenStatus, or its status on an older server).
    var currentChosenStatus: (() -> String)?
    /// Whether Session.currentUser carries `chosenStatus` (set by the app).
    /// Session keeps it fresh from getMe and PATCH responses, while this
    /// store's `currentUser` can still be the cached copy an older build of
    /// the app wrote, without the field, until the first READY.
    var sessionUserCarriesChosenStatus: (() -> Bool)?
    /// Writes the own status the server pushed (chosen, effective) into
    /// Session.currentUser (set by the app), so the Settings picker follows a
    /// pick made on another device.
    var applySelfStatus: ((_ chosen: String, _ effective: String?) -> Void)?
    private var lastInteractionAt = Date()
    private var appActive = true
    /// True while the app is in the background (scenePhase .background) —
    /// this device then reports idle at once. `.inactive` (Control Center,
    /// the app switcher, a notification pulled down) is still foreground, so
    /// a glance at a banner doesn't flap the user's dot.
    private var appInBackground = false
    /// The activity last reported to the gateway (nil before the first
    /// evaluation). Lets a touch after an idle report re-evaluate at once
    /// instead of on the next 60s tick.
    private var lastReportedActive: Bool?
    /// True only when the auto-presence machine itself moved the user to
    /// "idle" (online → idle on inactivity). Mirrors the web client's
    /// `autoSetRef`: it lets us restore idle → online when the user becomes
    /// active again WITHOUT ever stomping a manually-chosen "idle" (or dnd /
    /// invisible). Cleared on any manual status pick (noteManualStatusChange).
    private var autoSetIdle = false
    private var autoPresenceTimer: Timer?
    /// Safety-net poll for the OPEN conversation (see startOpenChannelPolling).
    private var openChannelPollTimer: Timer?
    /// Coalesce the many reconcileOpenChannel triggers that pile up on a single
    /// foreground (immediate + +1.3s/+4s timed + RESUMED + 12s poll). A short
    /// in-flight guard + min-interval collapses the near-simultaneous duplicates
    /// to one while preserving every safety-net trigger: a call landing after
    /// the window (the +4s reconcile, a later RESUMED, the next poll tick) runs.
    private var reconcileInFlight = false
    private var lastReconcileAt: Date = .distantPast
    /// Becomes true after the first gateway READY. A later READY means we
    /// reconnected after a drop, so we re-sync state (events were missed while
    /// disconnected) — mirroring the web client re-bootstrapping on reconnect.
    private var didInitialReady = false
    /// One-shot: land on the DMs page on the first launch of a session — not on
    /// reconnect, and not over a notification/deep-link that already navigated.
    private var didLandInitialScreen = false

    var gatewayStatus: Gateway.Status { gateway.status }

    // MARK: Lifecycle

    func start(token: String, user: SelfUser?) {
        currentUserId = user?.id
        currentUser = user
        // Opened-attachment copies left by a previous run (killed while Quick
        // Look was showing one); nothing can be showing one yet.
        OpenedFileCopies.sweep()
        // Move any pre-app-group E2EE keys into the shared keychain so the
        // Notification Service Extension can decrypt previews (idempotent).
        migrateE2EEKeysToAppGroupIfNeeded()
        // Apple Watch poke app: activate the WCSession and re-push the token to
        // the watch whenever it refreshes (so a watch poke never uses a stale,
        // expired token). The targets ride along on each DM (re)load.
        WatchSync.shared.start()
        // PULL path: let the watch fetch LIVE credentials on demand (right
        // before it sends / pokes / loads) instead of only receiving whatever
        // we last pushed. Answers with the current token + the same DM targets
        // syncWatch() builds, so a rotated/stale token never blocks a wrist send.
        WatchSync.shared.snapshotProvider = { [weak self] in
            guard let self else { return (nil, []) }
            return (self.api.token, self.watchTargets())
        }
        // Premium camera-quality gate: give the voice layer a LIVE read of
        // the admin-configured monetization matrix vs the signed-in tier, so
        // its publish-time clamp always reflects the current membership
        // (gift, lapse, renewal) AND the current server config without any
        // sync choreography. nil self (signed out) → built-in defaults with
        // no membership (1080p ceiling), same as today.
        voice.cameraQualityAllowed = { [weak self] q in
            guard let self else { return q != .k2 && q != .k4 }
            return self.cameraQualityAllowed(q)
        }
        // Fetch the matrix itself fire-and-forget; failure keeps defaults.
        Task { await loadMonetizationConfig() }
        if !watchTokenObserverInstalled {
            watchTokenObserverInstalled = true
            NotificationCenter.default.addObserver(
                forName: APIClient.tokenRefreshedNotification, object: nil, queue: .main
            ) { [weak self] _ in
                Task { @MainActor in self?.syncWatch() }
            }
        }
        gateway.onEvent = { [weak self] name, data in
            self?.handleEvent(name, data)
        }
        // Talking in voice counts as using the device (auto-presence).
        voice.onSpeakingChanged = { [weak self] ids in
            guard let self, let uid = self.currentUserId, ids.contains(uid) else { return }
            self.noteInteraction(evaluate: false)
        }
        // Decide this device's activity BEFORE the socket opens, so the first
        // IDENTIFY carries it (a background VoIP launch must not read active).
        startAutoPresence()
        gateway.connect(token: token)
        Task { await loadGuilds() }
        Task { await loadDMs() }
        Task { await loadReadStates() }
        // Notification mute levels — so the rail long-press menu shows Mute vs
        // Unmute correctly from the first interaction.
        Task { await loadNotificationOverrides() }
        // Load relationships up front so friend-aware UI (e.g. hiding "Report"
        // for friends) is correct anywhere, not just after visiting DMs.
        Task { await loadRelationships() }
        // Load supervision up front so a supervised child's parental controls
        // (e.g. filterProfanity → mask swear words) apply from the first render,
        // not only after they open Parental Controls. Mirrors web's startup
        // loadSupervision().
        Task { await loadFamily() }
        Task { await loadDmNicknames() }
        // F10: hydrate the per-user mute list from the shared voice-prefs blob
        // so a mute made on another device (or web) takes effect here.
        Task { await voice.loadVoicePrefs() }
        // Default landing: open to the Direct Messages page on a fresh launch
        // (once). Skipped when a notification/deep-link has already navigated
        // somewhere (a pushed route, an open channel, or a rail page), and never
        // re-fires on reconnect (start() runs on sign-in / cold VoIP launch, not
        // foreground reconnect). showDMs() lazily loads the DM list.
        if !didLandInitialScreen, stack.isEmpty, selectedChannel == nil, railPage == nil {
            didLandInitialScreen = true
            showDMs()
        }
        startOpenChannelPolling()
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
        // Full lightweight REST re-sync on EVERY foreground — do not depend on
        // the gateway resume/replay landing. A short background resolves to
        // RESUMED (not READY), which only reconciles the OPEN channel: the DM
        // list order/previews, unread dots, and — critically — mention badges
        // never arrive from live events (MESSAGE_CREATE always writes
        // mentionCount:0), so they'd stay stale until a full READY or a manual
        // re-entry. A push-only message delivered while the socket was dead is
        // invisible to the lists entirely. REST is independent of the socket,
        // so mirror the READY reconnect re-sync here (all idempotent): lists +
        // read state converge within ~1s regardless of what the socket does.
        Task { await loadDMs() }
        Task { await loadReadStates() } // also refreshes the app-icon badge
        Task { await loadGuilds() }
        // Admin may have retuned the monetization matrix while backgrounded.
        Task { await loadMonetizationConfig() }
        // Recover messages that arrived in the OPEN conversation while we were
        // backgrounded. The gateway RESUME replays missed frames just before
        // RESUMED (and we reconcile on RESUMED/READY too) — but this immediate
        // reconcile can RACE the socket resume, the replay flush, and the
        // network returning from a cold foreground; a lost race would otherwise
        // not retry until the 12s poll, which is the exact "I foreground after a
        // push and the new DM message isn't there" symptom. So reconcile NOW
        // and again AFTER the socket has had time to come back, so a just-missed
        // message appears within a couple seconds in every case. Each is a cheap
        // after-cursor fetch (usually zero rows) and dedup-safe via upsert.
        Task { await reconcileOpenChannel() }
        Task {
            try? await Task.sleep(nanoseconds: 1_300_000_000)
            await reconcileOpenChannel()
            try? await Task.sleep(nanoseconds: 2_700_000_000) // ~4s after foreground
            await reconcileOpenChannel()
        }
        // Guaranteed floor over the after-cursor reconciles above: also pull the
        // LATEST window and merge it (see refreshOpenChannelLatest) — the same
        // recovery re-opening the channel performs — so the open conversation
        // can NEVER sit stale after a resume, even if every reconcile above
        // missed. Once immediately, once after the socket has had time to settle.
        Task {
            await refreshOpenChannelLatest()
            try? await Task.sleep(nanoseconds: 2_500_000_000)
            await refreshOpenChannelLatest()
        }
        // Refresh the watch with the freshest token + targets on foreground.
        syncWatch()
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
    /// Exception: after this device reported idle, the first touch
    /// re-evaluates at once so the user's dot turns active without waiting
    /// for the tick (one evaluation — it reports active and the guard closes).
    func noteInteraction(evaluate: Bool = true) {
        lastInteractionAt = Date()
        if evaluate || lastReportedActive == false { evaluateAutoPresence() }
    }

    /// Foreground/background transitions feed the state machine. `active` is
    /// scenePhase .active (open-channel polling, legacy auto-away);
    /// `background` is scenePhase .background (device activity → idle).
    func setAppActive(_ active: Bool, background: Bool) {
        appActive = active
        appInBackground = background
        if active { lastInteractionAt = Date() }
        if active { startOpenChannelPolling() } else { stopOpenChannelPolling() }
        evaluateAutoPresence()
        // Re-sync the home-screen badge to true unread on every fg/bg flip (a
        // push may have set a stale number while we were away).
        //
        // But NOT before the unread state exists. On a cold launch this runs
        // with `dms` and `readStates` still empty, so the count is 0 and the
        // badge a push correctly set gets wiped the moment the app is opened —
        // even if the user reads nothing. loadReadStates() refreshes the badge
        // when the real numbers arrive, so skipping here loses nothing.
        if !dms.isEmpty || !readStates.isEmpty {
            updateAppBadge()
        }
    }

    private func startAutoPresence() {
        appActive = true
        // start() also runs from a background VoIP launch (ensureGatewayConnected):
        // a ring must not mark the user as using this phone.
        appInBackground = UIApplication.shared.applicationState == .background
        lastInteractionAt = Date()
        autoPresenceTimer?.invalidate()
        // Re-check periodically so the idle transition fires without a UI event
        // (and talking/idle changes are caught within the interval).
        let presence = Timer(timeInterval: 60, repeats: true) { [weak self] _ in
            Task { @MainActor in self?.evaluateAutoPresence() }
        }
        RunLoop.main.add(presence, forMode: .common)
        autoPresenceTimer = presence
        evaluateAutoPresence()
    }

    private func stopAutoPresence() {
        autoPresenceTimer?.invalidate()
        autoPresenceTimer = nil
    }

    /// Safety net for the "stale open DM" bug: while the app is foreground AND a
    /// conversation is open, reconcile it every 12s. The gateway delivers live
    /// messages instantly in the normal case; this catches the rare miss — a
    /// silently half-dead socket the heartbeat watchdog hasn't tripped yet, a
    /// resume gap, or a push-only delivery — so the OPEN conversation can never
    /// sit behind for more than the interval. Previously a missed live message
    /// only surfaced after leaving + re-entering the channel (which re-fetches).
    /// Cheap: an `after`-cursor fetch that returns zero rows in the common case.
    private func startOpenChannelPolling() {
        openChannelPollTimer?.invalidate()
        // Near-live convergence for the OPEN conversation. The live gateway push
        // is the fast path, but when it silently fails to deliver (dead socket,
        // proxy not upgrading the WebSocket, missed frame) this reconcile is the
        // ONLY thing that surfaces an incoming message. Poll every 3s (was 12s)
        // so a message from the other person — or another of your own devices —
        // appears within a few seconds instead of only after a reload. Cheap:
        // an append-only `after` fetch returning zero rows when already current.
        // `.common` mode, NOT the default `Timer.scheduledTimer` (.default): the
        // main run loop switches to .eventTracking while a scroll drag or
        // deceleration is in flight, which suspends a .default timer. That is
        // precisely when the user is reading the chat and most likely to notice a
        // missing message. Same for `autoPresenceTimer`.
        let poll = Timer(timeInterval: 3, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, self.appActive else { return }
                // Voice roster heal for the server on screen. Rides this timer
                // rather than its own (every fifth tick, ~15s) so there is one
                // clock to reason about, and only while the app is active.
                if let gid = self.selectedGuild?.id,
                   Date().timeIntervalSince(self.lastGuildVoiceHeal) >= 15 {
                    self.lastGuildVoiceHeal = Date()
                    await self.reconcileGuildVoice(gid)
                }
                guard self.selectedChannel != nil else { return }
                await self.reconcileOpenChannel()
            }
        }
        RunLoop.main.add(poll, forMode: .common)
        openChannelPollTimer = poll
    }

    /// Re-read who is in voice across a whole server and replace our copy.
    ///
    /// The voice lists under channel rows were built from VOICE_STATE_UPDATE
    /// frames alone (plus READY), so one dropped frame left people invisible to
    /// everyone outside the call until somebody joined — the join's snapshot
    /// then made them all appear at once. This is the heal, keyed to the server
    /// the sidebar is showing. Other servers and DM calls are left alone.
    func reconcileGuildVoice(_ guildId: String) async {
        guard let states = try? await api.guildVoiceStates(guildId: guildId) else { return }
        // A server switch may have landed while the request was in flight;
        // applying a roster for a guild nobody is looking at is harmless, but
        // don't let it fight the current one either.
        var next = voiceStatesByUser
        let present = Set(states.map(\.userId))
        for (userId, vs) in next where vs.guildId == guildId && !present.contains(userId) {
            next[userId] = nil
        }
        for vs in states where vs.channelId != nil { next[vs.userId] = vs }
        if next != voiceStatesByUser { voiceStatesByUser = next }
    }

    private var lastGuildVoiceHeal = Date.distantPast

    private func stopOpenChannelPolling() {
        openChannelPollTimer?.invalidate()
        openChannelPollTimer = nil
    }

    /// Show the transient poke banner (emoji + sender) for ~5s, then clear it.
    /// The id guard means a newer poke landing mid-display owns the dismissal.
    /// 5s gives time to tap it (open the sender) or tap the emoji (poke back).
    func showPokeBanner(channelId: String, emoji: String, name: String, pokeType: String) {
        let banner = PokeBanner(emoji: emoji, name: name, channelId: channelId, pokeType: pokeType)
        pokeBanner = banner
        Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if pokeBanner?.id == banner.id { pokeBanner = nil }
        }
    }

    /// Show the transient achievement-unlock celebration banner for ~5s. The id
    /// guard means a newer unlock landing mid-display owns the dismissal.
    func showAchievementBanner(id: String, name: String, detail: String) {
        let banner = AchievementBanner(achievementId: id, name: name, detail: detail)
        achievementBanner = banner
        Task {
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            if achievementBanner?.id == banner.id { achievementBanner = nil }
        }
    }

    /// Tapped the poke banner → open the DM with the sender (the poke arrived on
    /// their DM channel). Cold-launch safe: reload DMs if it isn't in memory yet.
    func openPokeSender(_ banner: PokeBanner) {
        pokeBanner = nil
        let cid = banner.channelId
        guard !cid.isEmpty else { return }
        if let dm = dms.first(where: { $0.id == cid }) { jumpToDM(dm); return }
        Task {
            await loadDMs()
            if let dm = dms.first(where: { $0.id == cid }) { jumpToDM(dm) }
        }
    }

    /// Handle a `zekktris://` deep link (currently from the Home/Lock-Screen
    /// widget). `zekktris://dm/<channelId>` opens that DM at the composer.
    func handleDeepLink(_ url: URL) {
        guard url.scheme == "zekktris" else { return }
        switch url.host {
        case "dm":
            let cid = url.pathComponents.first(where: { $0 != "/" }) ?? ""
            openDMById(cid)
        case "device-login":
            // A QR/link carrying a device-login user code. This ONLY opens the
            // approval screen — it approves nothing. A link is exactly how a
            // phisher would deliver a code, and that screen is what stops the
            // attack (see DeviceLoginApprovalScreen in AuthViews.swift).
            if let code = DeviceLoginCode.extract(from: url.absoluteString) {
                pendingDeviceLogin = PendingDeviceLogin(userCode: code)
            }
        default:
            break
        }
    }

    /// Payload handed over by the Share Extension, if any.
    struct StagedShare {
        /// Lets the composer notice a new share (onChange) even when the
        /// conversation it is for is already on screen.
        let id = UUID()
        /// The conversation picked in the share sheet (a DM, group DM or guild
        /// channel); nil means the user picks one from the DM list.
        var channelId: String?
        let text: String?
        /// Filenames inside the App Group's SharedInbox directory.
        let files: [String]
        let receivedAt = Date()

        /// A share nobody placed within this window is dropped rather than
        /// turning up in some unrelated conversation opened much later.
        var isExpired: Bool { Date().timeIntervalSince(receivedAt) > 600 }
    }

    /// Most recent staged share. MessageListView.takePendingShare puts it in
    /// the composer of the conversation it was shared to (or, when none was
    /// picked, the one the user picks from the DM list); the user presses send.
    @Published var pendingShare: StagedShare?

    /// Drop the waiting share and its files (the DM list banner's close button,
    /// or an expired share).
    func discardPendingShare() {
        if let share = pendingShare { removeSharedFiles(share.files) }
        pendingShare = nil
    }

    /// Read and CLEAR what the Share Extension staged in the App Group. Called
    /// whenever the app becomes active while signed in (RootView) — the
    /// extension cannot open the app itself. It deliberately does not send
    /// anything — it has no session, no network stack and no E2EE keys for the
    /// target channel, so sending there would mean a second, weaker copy of
    /// the send path. Never auto-sent, matching Android.
    ///
    /// Clearing is not optional: leaving it behind means the next unrelated
    /// launch re-opens someone's conversation with a stale photo attached.
    func consumeStagedShare() {
        let key = "zk.share.staged.v1"
        guard let d = UserDefaults(suiteName: AppGroupConfig.identifier),
              let raw = d.dictionary(forKey: key) else { return }
        d.removeObject(forKey: key)
        let files = (raw["files"] as? [String]) ?? []
        sweepSharedInbox(keeping: files)

        // Ignore anything stale — a payload staged days ago is not what the user
        // is doing now, and silently attaching it would be baffling.
        if let at = raw["at"] as? TimeInterval,
           Date().timeIntervalSince1970 - at > 300 {
            removeSharedFiles(files)
            return
        }

        // A newer share replaces one still waiting for its conversation.
        discardPendingShare()
        let staged = StagedShare(
            channelId: raw["channelId"] as? String,
            text: raw["text"] as? String,
            files: files
        )
        // If the user picked a suggested conversation in the share sheet, go
        // straight there. Suggestions are DMs (ShareSuggestions) but also guild
        // channels (NotificationService donates every conversation that
        // notifies), so this resolves any channel id, not just the DM list.
        // Otherwise — or when that conversation can't be opened — show the DM
        // list (with a "pick a conversation" banner) so the payload lands in
        // the one they choose now, not in whatever happens to be open — the
        // same as Android. Navigate first: the composer only takes a share
        // while its list is on screen.
        if let cid = staged.channelId, !cid.isEmpty {
            pendingShare = staged
            let shareId = staged.id
            openFromPush(channelId: cid, messageId: nil, autojoin: false, reviveSocket: false, onUnresolved: { [weak self] in
                self?.pickConversationForShare(shareId)
            })
        } else {
            showDMs()
            pendingShare = staged
        }
    }

    /// The conversation picked in the share sheet couldn't be opened: drop
    /// the target and fall back to the DM list's "pick a conversation" banner,
    /// rather than leave the share waiting for a conversation that never
    /// appears. Only for the share it was opened for — a newer one may have
    /// replaced it, or the user may already have placed it.
    private func pickConversationForShare(_ shareId: UUID) {
        guard var share = pendingShare, share.id == shareId else { return }
        share.channelId = nil
        // DM list first, as in consumeStagedShare: with no conversation on
        // screen, no open composer can take the now-untargeted share.
        showDMs()
        pendingShare = share
    }

    /// Delete SharedInbox files older than a day that no share refers to any
    /// more — left behind when the app was killed with a share still waiting,
    /// or the extension was dismissed half-way through copying.
    private func sweepSharedInbox(keeping staged: [String]) {
        guard let dir = sharedInboxURL,
              let names = try? FileManager.default.contentsOfDirectory(atPath: dir.path) else { return }
        let keep = Set(staged + (pendingShare?.files ?? []))
        let cutoff = Date().addingTimeInterval(-86_400)
        for name in names where !keep.contains(name) {
            let url = dir.appendingPathComponent(name)
            let modified = (try? url.resourceValues(forKeys: [.contentModificationDateKey]))?.contentModificationDate
            if let modified, modified < cutoff { try? FileManager.default.removeItem(at: url) }
        }
    }

    /// The App Group directory the Share Extension copies shared files into.
    private var sharedInboxURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: AppGroupConfig.identifier)?
            .appendingPathComponent("SharedInbox", isDirectory: true)
    }

    /// Read a staged share's files and delete them — once they are in the
    /// composer, the copies in the App Group are only leftovers. Returns
    /// (attachment filename, bytes) with the extension's UUID prefix removed.
    func takeSharedFiles(_ names: [String]) -> [(filename: String, data: Data)] {
        guard let dir = sharedInboxURL else { return [] }
        var out: [(filename: String, data: Data)] = []
        for name in names where !name.contains("/") {
            let url = dir.appendingPathComponent(name)
            if let data = try? Data(contentsOf: url) {
                // "<36-char UUID>-<original name>", see ShareViewController.
                let original = name.count > 37 ? String(name.dropFirst(37)) : name
                out.append((original, data))
            }
            try? FileManager.default.removeItem(at: url)
        }
        return out
    }

    private func removeSharedFiles(_ names: [String]) {
        guard let dir = sharedInboxURL else { return }
        for name in names where !name.contains("/") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    /// Open a DM by channel id — resolve locally, else reload the DM list then
    /// jump. Mirrors openPokeSender's resolve-or-load pattern.
    func openDMById(_ channelId: String) {
        guard !channelId.isEmpty else { return }
        if let dm = dms.first(where: { $0.id == channelId }) { jumpToDM(dm); return }
        Task {
            await loadDMs()
            if let dm = dms.first(where: { $0.id == channelId }) { jumpToDM(dm) }
        }
    }

    /// Tapped the emoji on the poke banner → poke them back with the SAME variant.
    func pokeBack(_ banner: PokeBanner) {
        pokeBanner = nil
        let cid = banner.channelId
        guard !cid.isEmpty else { return }
        let variant = PokeVariant(rawValue: banner.pokeType) ?? .poke
        Task {
            var channel = dms.first(where: { $0.id == cid })
            if channel == nil { await loadDMs(); channel = dms.first(where: { $0.id == cid }) }
            if let channel { await poke(channel, variant: variant) }
        }
    }

    /// Whether the server derives the user's status from device activity, so
    /// this app must never write it automatically. The READY flag is the
    /// signal; a self user carrying `chosenStatus` (only such servers send
    /// it) also counts — this store's or the one Session holds, refreshed by
    /// getMe — so an auto-away PATCH can't slip out before the first READY,
    /// or while the socket can't connect, and loop: the server shows such an
    /// automatic away to updated clients as 'online', which would read as
    /// "still online, go Away" every minute.
    var serverDerivesPresence: Bool {
        gateway.supportsPresenceActivity || currentUser?.chosenStatus != nil
            || sessionUserCarriesChosenStatus?() == true
    }

    /// Report this device's activity to the gateway and, on an older server
    /// only, compute the legacy auto status and push it if it differs from the
    /// current chosen status.
    func evaluateAutoPresence() {
        // Report even without a self id: a cold background VoIP launch starts
        // with `user: nil`, and its IDENTIFY must still carry `active:false`
        // (a connection that never reports counts as active server-side).
        let talking = currentUserId.map { voice.speakingUserIds.contains($0) } ?? false
        let secs = Date().timeIntervalSince(lastInteractionAt)
        let active = DevicePresence.isActive(
            foreground: !appInBackground, secondsSinceInteraction: secs, talking: talking
        )
        lastReportedActive = active
        // Always: it rides in IDENTIFY/RESUME (ignored by older servers) and
        // goes out as op 3 only on a change, only where it's supported.
        gateway.setPresenceActive(active)
        guard currentUserId != nil, !serverDerivesPresence else { return }
        let chosen = currentChosenStatus?() ?? "online"
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
        stopOpenChannelPolling()
        gateway.disconnect()
        // Sign-out must revoke every Share Suggestion. These live in the SYSTEM
        // index, not in app state, so clearing `dms` below does nothing to them:
        // without this the share sheet of a signed-out phone keeps listing the
        // previous account's contacts by name and face, in every other app.
        ShareSuggestions.deleteAll()
        // The widget and the watch each hold a COPY of the token. Drop both,
        // or a signed-out phone keeps poking from the Home Screen — and after
        // a server switch they'd send the old server's token to the new one.
        WidgetBridge.publish(dms: [], token: nil)
        WidgetCenter.shared.reloadAllTimelines()
        WatchSync.shared.sync(token: nil, targets: [])
        // Opened attachments, decrypted ones included, belong to this account.
        OpenedFileCopies.sweep()
        // A share still waiting for a conversation belongs to this account.
        discardPendingShare()
        currentUserId = nil
        currentUser = nil
        voice.onSpeakingChanged = nil
        lastReportedActive = nil
        didInitialReady = false
        didLandInitialScreen = false
        readStates = [:]
        unreadBoundaryId = nil
        guilds = []
        channels = []
        messages = []
        messageCache = [:]
        messageCacheLRU = []
        dms = []
        relationships = []
        dmNicknames = [:]
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
        // Clear the presence coalescing buffer too, or an in-flight flush
        // scheduled before logout could write prior-session statuses back into
        // the just-cleared map (~200ms window). Empty buffer → the flush
        // early-returns.
        pendingPresence.removeAll()
        presenceFlushScheduled = false
        inDMs = true   // DMs home (matches the default) so a re-login also lands clean
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
        // Keyed by raw key bytes: they must not outlive the session either.
        verifierMemo = [:]
        clearDecryptedMedia()
        // Emoji bitmaps are per-session public assets with no ceiling; drop them
        // (and in-flight markers, so cleared emojis re-fetch) on sign-out so the
        // cache doesn't survive account switches unbounded.
        emojiImages = [:]
        emojiInFlight = []
        e2eeError = nil
    }

    // MARK: Selection

    func selectGuild(_ guild: Guild) {
        // Heal the voice roster for this server straight away rather than on
        // the next poll tick — opening a server is exactly when the user looks
        // at who is in its voice channels.
        lastGuildVoiceHeal = Date()
        Task { await reconcileGuildVoice(guild.id) }
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

    /// Switch the rail to DM mode.
    ///
    /// `preservingSelection` keeps `stack` + `selectedChannel` intact. ONLY the
    /// notification-tap path passes true, and only when the tapped DM is ALREADY
    /// the open conversation — because the reset below is destructive and, on
    /// that one path, silently fatal:
    ///
    /// `resetStack()` + `selectedChannel = nil`, followed (in the SAME MainActor
    /// turn) by re-pushing the identical `.messages(ch)` route, is INVISIBLE to
    /// SwiftUI. The stack goes [.messages(X)] → [] → [.messages(X)], but the turn
    /// is coalesced into one render whose routeKey (MainView.swift:542,
    /// "m-<id>-<depth>") is UNCHANGED. Same identity → same view instance →
    /// MessageListView's `.onAppear` (MessageViews.swift:333) does not re-fire →
    /// `openChannel()` never runs. That matters because openChannel is the ONLY
    /// writer that restores `selectedChannel` (:1491) — so it stayed nil, which
    /// in turn disabled EVERY recovery path, all of which guard on it:
    /// refreshOpenChannelLatest (:1968), reconcileOpenChannel (:1920), the 3s
    /// open-channel poll (:1157), and even the live MESSAGE_CREATE append
    /// (:4936). The conversation then sat stale with no network activity at all
    /// until the user backed out and re-entered (pop() → a real render of the
    /// root → a genuine identity change on re-entry → remount → load).
    func showDMs(preservingSelection: Bool = false) {
        railPage = nil
        railContent = .normal
        inDMs = true
        if !preservingSelection {
            resetStack()
            // Leave the open conversation the way pop() does: cache it, then
            // drop its rows and plaintext. jumpToDM (push, widget and deep-link
            // opens) comes through here and opens the next DM straight away;
            // without this, that DM's first frame drew the PREVIOUS
            // conversation's rows — decrypted E2EE text included — under the
            // new header, and the conversation being left was never cached
            // because selectedChannel was already nil when openChannel tried.
            leaveOpenConversation()
        }
        if dms.isEmpty { Task { await loadDMs() } }
    }

    func showMentions() {
        // Wide (iPad/Mac): fill the whole sidebar+detail area via railPage, like
        // Join/Create-server. Compact (iPhone): keep the existing in-rail content
        // view, which already works as intended.
        if isWideLayout {
            railPage = .mentions
            railContent = .normal
        } else {
            railPage = nil
            railContent = .mentions
        }
        resetStack()
    }

    // MARK: Navigation stack

    /// True when MainView is presenting the persistent three-pane layout
    /// (iPad / Mac, regular width). Changes route semantics from push
    /// (drill-down) to replace (master-detail) and hides back buttons.
    @Published var isWideLayout = false

    func selectChannel(_ channel: Channel) {
        noteInteraction()
        // Opening a DM is the strongest "this is a person I talk to" signal we
        // get, so it re-ranks the conversation in the system share sheet.
        // No-op for guild channels and cheap/throttled for DMs.
        donateShareSuggestion(channel)
        // Tell MainView this open is a cache hit (so it paints instantly) — it
        // then skips the route cross-fade and the conversation pops into place.
        openingCachedChannel = messageCache[channel.id] != nil
        push(.messages(channel))
    }
    func openThreads(_ parent: Channel) { push(.threadList(parent)) }
    func clearChannel() { pop() }

    func push(_ route: Route) {
        // Any forward navigation closes the members view, so a drawer left open
        // at the channel-list root can't carry over and auto-open the sheet in
        // the channel you navigate into (e.g. via a notification tap).
        showMembers = false
        // Wide layout: sidebar selections REPLACE the detail pane instead of
        // stacking. Drill-downs within the detail (forum post -> its thread)
        // still stack so "back to posts" works: we only replace when the
        // current top is a leaf the sidebar owns (messages/voice) or empty.
        if isWideLayout {
            // Navigating to content always exits the mentions/saved inbox in
            // the wide layout (there's no back affordance to return through;
            // the rail highlight should track the visible pane). railPage is the
            // full-page host for Mentions on wide — clear it too, or the opened
            // channel never shows (the host keeps covering the detail pane).
            railContent = .normal
            railPage = nil
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
    func pop() {
        if !stack.isEmpty { stack.removeLast() }
        // Leaving a channel cancels any not-yet-consumed "jump to mention" /
        // notification deep-link target, so it can't apply to the next channel.
        pendingJumpMessageId = nil
        pendingReplyMessageId = nil
        // Leaving ANY conversation closes the members view. Must run on every
        // pop (not just to root): a thread's people-icon tap sets showMembers
        // but can't present there; without clearing it on the way out it would
        // carry back to the parent text channel and auto-open the sheet.
        showMembers = false
        // Returning to the ROOT channel/DM list: drop the (potentially large)
        // message subtree NOW so the outgoing MessageListView collapses on the
        // SAME frame the 72pt server rail is re-inserted. Otherwise a populated
        // ScrollView/LazyVStack tears down a frame late and its still-full-width
        // layer covers the rail, eating its taps — the "rail dead after leaving
        // a channel that has messages" bug (an empty channel never hit it:
        // trivial subtree). openChannel() repopulates on the next open. Gated on
        // stack.isEmpty so popping a thread back to its parent channel (deeper
        // stack) doesn't wipe the parent's still-visible messages.
        if stack.isEmpty { leaveOpenConversation() }
    }

    /// Close the open conversation: cache its rows (snapshotCurrentChannel
    /// reads selectedChannel, so this must run before it is cleared), then drop
    /// its rows, decrypted plaintext and per-conversation state.
    private func leaveOpenConversation() {
        snapshotCurrentChannel()
        messages = []
        selectedChannel = nil
        typing = [:]
        replyingTo = nil
        pins = []
        decrypted = [:]
        unreadBoundaryId = nil
    }
    private func resetStack() { stack = []; threadList = []; showMembers = false; pendingJumpMessageId = nil; pendingReplyMessageId = nil }

    /// True when `channel`'s message list is the page on screen — not merely
    /// the selected channel, which outlives its view (showMentions keeps it).
    func isShowingMessages(of channel: Channel) -> Bool {
        guard railPage == nil, case .messages(let c)? = stack.last else { return false }
        return c.id == channel.id
    }

    /// Called by MessageListView.onAppear to load the channel it shows.
    /// Guarded by id so a re-appear (keyboard etc.) doesn't reload.
    /// Opening a conversation answers its poke. Separate from the read path:
    /// a poke creates no message, so a DM with nothing unread is never marked
    /// read and the pill would stay on the row for good.
    private func clearPokePill(_ channelId: String) {
        if pokePills[channelId] != nil { pokePills[channelId] = nil }
    }

    func openChannel(_ channel: Channel) {
        clearPokePill(channel.id)
        guard selectedChannel?.id != channel.id else {
            // The view remounted for the channel that's ALREADY selected — e.g.
            // tapping a push notification INTO the open channel, re-tapping the
            // same DM in the list (going "back into" a conversation you were just
            // in), or (wide layout) Threads → re-tapping the same channel. We keep
            // scroll/decrypt state (no reset), but still top up from the server.
            //
            // Use refreshOpenChannelLatest() — a LATEST-window fetch (no cursor),
            // exactly what re-opening from scratch does — rather than the
            // after-cursor reconcileOpenChannel(). An after-cursor fetch only asks
            // for rows NEWER than what's loaded; if the store never saw the new
            // message (it arrived purely as a push while the gateway was asleep,
            // so `messages`/`dms.lastMessageId` don't know a newer id exists) the
            // reconcile's `knownLatest > after` guard is false and it fetches
            // nothing — the just-arrived message stays stranded until the 12s
            // poll. The latest-window merge always pulls the true tail and upserts
            // it in (dedup-safe), so "go back into the DM and the new message is
            // there" holds even when only a notification told us about it.
            Task { await refreshOpenChannelLatest() }
            return
        }
        // The route animation has already consumed the cache-hit hint; clear it
        // so later non-cached navigations cross-fade normally.
        openingCachedChannel = false
        // Snapshot the channel we're LEAVING first — while `selectedChannel`
        // still points at it. snapshotCurrentChannel() reads selectedChannel?.id
        // and caches the resident `messages`; if we reassign selectedChannel
        // first, it would cache the OLD channel's messages under the NEW id
        // (cross-channel contamination). Mirrors what pop() already does.
        snapshotCurrentChannel()
        selectedChannel = channel
        // Seed the new one from cache so a revisited conversation paints on THIS
        // frame (no empty→spinner→fade). loadMessages still runs below to
        // refresh + merge server truth.
        messages = messageCache[channel.id] ?? []
        if messageCache[channel.id] != nil { touchMessageCache(channel.id) }
        // Drop decrypted E2EE plaintext from the channel we're leaving —
        // it otherwise stayed resident for the whole session (only relock/
        // sign-out cleared it), defeating the "plaintext doesn't linger in
        // memory" intent and growing unbounded. decryptVisible() repopulates
        // for the new channel right after loadMessages.
        decrypted = [:]
        // If a locally cached key no longer matches this DM's verifier (it was
        // re-keyed, or belonged to a different password), drop it so we prompt
        // for the password rather than silently failing to decrypt. BEFORE the
        // seed decrypt below, so a stale key never decrypts the seeded rows.
        purgeStaleE2EEKey(channel)
        registerE2EEPurgeProofIfNeeded(channel)
        // Re-derive plaintext for any seeded rows immediately — synchronously,
        // see decryptVisible — so a cached E2EE convo is never shown as
        // undecryptable, not even for a frame (selectedChannel is set above).
        if !messages.isEmpty { decryptVisible() }
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
        Task { await loadMessages(channel); await loadSavedMembership(messages.map { $0.id }); markChannelRead(channel) }
        Task { await loadPins(channel) }
    }

    /// THE presence resolver: one map, one answer, every surface.
    ///
    /// There is deliberately NO `fallback:` parameter. It used to take one, and
    /// that parameter *was* the split-brain: each call site handed it a
    /// different per-object embedded status — a `listMembers` snapshot in the
    /// member list, a PER-MESSAGE `message.author.status` in the message row, a
    /// DM-list snapshot in the chat header — so two surfaces showing the same
    /// person side by side resolved to two different frozen values the moment
    /// `presence` had no entry. (The message-row one never refreshes at all: it
    /// is embedded at fetch time.)
    ///
    /// The answer is to keep the MAP complete rather than to paper over holes
    /// per-site — see `seedPresence`, which every REST loader now feeds
    /// (members, DM recipients, relationships, event attendees, message
    /// authors). Android reached the same shape in `AppStore.kt presenceOf` +
    /// `seedPresence`.
    func status(for userId: String?) -> String {
        if let userId {
            // The SELF user. On a server with multi-device presence our own
            // PRESENCE_UPDATEs reach us and `presence` holds the effective
            // status (online while any of our devices is in use, else away);
            // before the first one, the self user's `effectiveStatus` (an
            // older multi-device server sent it as `status`). Chosen Invisible
            // shows Invisible (those frames say offline). An older server
            // never echoes our own presence back, and there the chosen status
            // is the presence; a stale pre-connect "offline" (getMe ran before
            // the gateway identified) means nothing — while we're in the app
            // we are online, so report "online" unless a deliberate status
            // (idle/dnd/invisible) was chosen in Settings. See
            // DevicePresence.selfStatus.
            if userId == currentUserId {
                let chosen = DevicePresence.pickerStatus(
                    chosen: currentChosenStatus?() ?? currentUser?.chosenStatus,
                    status: currentUser?.status
                )
                return DevicePresence.selfStatus(
                    chosen: chosen, live: presence[userId],
                    effective: currentUser?.effectiveStatus ?? currentUser?.status,
                    serverDerives: serverDerivesPresence
                )
            }
            if let s = presence[userId] { return s }
        }
        return "offline"
    }

    /// Our own status as the server pushed it (READY, or the PRESENCE_UPDATE
    /// to our own connections): patch our copy of the self user and
    /// Session's, which the Settings picker reads. The pick goes to both
    /// `chosenStatus` and `status` (which carries the pick too); `effective`
    /// nil = leave `effectiveStatus` alone.
    private func noteSelfStatus(chosen: String, effective: String?) {
        if var u = currentUser {
            u.chosenStatus = chosen
            u.status = chosen
            if let effective { u.effectiveStatus = effective }
            if u != currentUser { currentUser = u }
        }
        applySelfStatus?(chosen, effective)
    }

    /// Snapshot of `presence` to hand to `seedPresence` — take it immediately
    /// BEFORE the fetch suspends.
    ///
    /// Folds buffered live events in first so the snapshot reflects known live
    /// state; events arriving DURING the fetch stay buffered and the debounced
    /// flush applies them afterwards, so a live event still wins.
    private func presenceSnapshot() -> [String: String] {
        flushPendingPresence()
        return presence
    }

    /// Fill the presence map from REST user snapshots — the ONE seeding rule,
    /// shared by every loader. (Android: `AppStore.kt seedPresence`.)
    ///
    /// The REST `status` is the point-in-time DB baseline, and applying it
    /// REPAIRS an entry that a missed PRESENCE_UPDATE left stale — which is the
    /// whole reason seeding exists (an "only write when missing" merge lets a
    /// single dropped event pin a user offline forever). But a live event that
    /// landed WHILE the fetch was in flight is fresher and must win, or locking
    /// the phone mid-load downgrades a just-online friend back to the snapshot.
    ///
    /// Nothing carries a timestamp, so freshness is inferred by diffing across
    /// the await. `before` is the map captured immediately before the network
    /// call; `presence` now also includes anything applied during it:
    ///   • entry changed during the fetch   → a live event won; keep it
    ///   • entry unchanged during the fetch → apply the REST baseline
    ///
    /// One assignment at the end: per-entry writes publish N times and
    /// re-render every observer once per user.
    private func seedPresence(_ users: [PublicUser], before: [String: String]) {
        guard !users.isEmpty else { return }
        var seeded = presence
        for u in users {
            guard let s = u.status else { continue }
            let changedDuringFetch = presence[u.id] != before[u.id]
            if !changedDuringFetch { seeded[u.id] = s }
        }
        if seeded != presence { presence = seeded }
    }

    // MARK: Loading

    private var guildsLoadTask: Task<Void, Never>?
    /// Single-flight: concurrent callers (start() + a deep-link's openFromPush)
    /// share ONE GET /guilds and ALL await its completion. An early-return guard
    /// would let the second caller return before `guilds` was populated, so a
    /// deep-link's guild resolution could silently no-op; awaiting the shared
    /// task fixes that and still avoids the double-fetch.
    func loadGuilds() async {
        if let existing = guildsLoadTask { await existing.value; return }
        let task = Task { await self.performLoadGuilds() }
        guildsLoadTask = task
        await task.value
        guildsLoadTask = nil
    }

    private func performLoadGuilds() async {
        loadingGuilds = true; errorText = nil
        defer { loadingGuilds = false }
        do {
            guilds = try await api.guilds()
            // Auto-select the first guild for a faster first paint — but NOT
            // when we've intentionally landed on DMs (the default launch view),
            // or this late guilds response would stomp the DMs landing. Also
            // require nothing to be open (selectedChannel == nil): on a resume,
            // foregroundReconnect re-runs loadGuilds, and reselecting a guild
            // here NILS selectedChannel (selectGuild), so a send fired into an
            // already-open DM would silently no-op (guard in send()). This is
            // the reported "message won't send / no bubble after resume" bug.
            if selectedGuild == nil, !inDMs, selectedChannel == nil, let first = guilds.first {
                selectGuild(first)
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    private var dmsLoadTask: Task<Void, Never>?
    /// Single-flight (see loadGuilds): start(), the DMs landing, and a DM
    /// deep-link can all request a load; they share ONE GET /dms and await its
    /// real completion — so openFromPush reliably sees the loaded `dms` (an
    /// early-return guard could leave `dms` empty when it's checked) and we
    /// don't double-fetch.
    func loadDMs() async {
        if let existing = dmsLoadTask { await existing.value; return }
        let task = Task { await self.performLoadDMs() }
        dmsLoadTask = task
        await task.value
        dmsLoadTask = nil
    }

    /// Apply any buffered PRESENCE_UPDATE events to `presence` in a single
    /// @Published mutation (only when something actually changed, to avoid a
    /// no-op render).
    private func flushPendingPresence() {
        guard !pendingPresence.isEmpty else { return }
        var next = presence
        var changed = false
        for (uid, status) in pendingPresence where next[uid] != status {
            next[uid] = status
            changed = true
        }
        pendingPresence.removeAll()
        if changed { presence = next }
    }

    // DELIBERATELY NOT STAMPING `lastSeenAt` LOCALLY on an observed
    // online→offline transition. It looks like a harmless freshness fix, and
    // it re-opens the exact hole the server's SQL guard exists to close.
    //
    // Going Invisible is broadcast as `offline`, indistinguishable from a real
    // disconnect. But the server only advances `last_seen_at` on a genuine
    // disconnect — never when its owner goes invisible. So a local stamp makes
    // the two cases diverge on refresh:
    //
    //   real disconnect → "just now",  refresh → still "just now"
    //   went Invisible  → "just now",  refresh → snaps back to "5h ago"
    //
    // A timestamp that jumps BACKWARDS is a reliable tell for "this person went
    // invisible, they're online right now" — precisely the bit Invisible
    // exists to hide. Showing a slightly stale value until the next
    // `loadRelationships()` is the correct trade.

    /// Debounce a flush of `pendingPresence` (~200ms). Coalesces a burst of
    /// presence events into one `presence` write. `presenceFlushScheduled`
    /// ensures only one timer is in flight.
    private func schedulePresenceFlush() {
        guard !presenceFlushScheduled else { return }
        presenceFlushScheduled = true
        Task { @MainActor in
            try? await Task.sleep(nanoseconds: 200_000_000)
            presenceFlushScheduled = false
            flushPendingPresence()
        }
    }

    private func performLoadDMs() async {
        loadingDMs = true
        defer { loadingDMs = false }
        // An E2EE change applied while this fetch is in flight (CHANNEL_UPDATE,
        // enable/disable) is newer than the response; see noteE2EEChange.
        let e2eeSeqAtStart = e2eeChangeSeq
        // Snapshot presence BEFORE the network call suspends. Any gateway
        // PRESENCE_UPDATE applied while we're awaiting mutates `presence`
        // (same MainActor, so it's serialized, not a data race) — diffing
        // against this snapshot tells `seedPresence` which users got a fresher
        // live status mid-fetch.
        let presenceBefore = presenceSnapshot()
        do {
            var fetched = try await api.listDMs()
            for i in fetched.indices {
                guard let at = e2eeChangedAt[fetched[i].id], at >= e2eeSeqAtStart,
                      let held = dms.first(where: { $0.id == fetched[i].id }) else { continue }
                fetched[i].e2eeEnabled = held.e2eeEnabled
                fetched[i].e2eeSalt = held.e2eeSalt
                fetched[i].e2eeVerifier = held.e2eeVerifier
                fetched[i].e2eePurgeProofSet = held.e2eePurgeProofSet
            }
            // Most-recently-active first. Numeric snowflake comparison — plain
            // string > is wrong across id-length boundaries ("99" > "100").
            // Channels with no messages fall back to their own id (creation).
            dms = fetched.sorted {
                snowflakeGreater($0.lastMessageId ?? $0.id, than: $1.lastMessageId ?? $1.id)
            }
            // Every legacy encrypted DM we already hold the key for, not just
            // the open one (a cold start can select a DM before this loads).
            for dm in dms { registerE2EEPurgeProofIfNeeded(dm) }
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
            // Seed presence from the DM recipients through the shared rule
            // (see seedPresence): REST repairs a stale entry, a live event that
            // landed mid-fetch still wins.
            seedPresence(dms.flatMap { $0.recipients ?? [] }, before: presenceBefore)
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
        // The watch poke app's target list comes from the DM list — refresh it
        // whenever the DMs (re)load.
        syncWatch()
    }

    /// The recent 1:1 DM peers the watch can poke / message, newest first.
    /// Shared by the proactive push (`syncWatch`) and the on-demand pull
    /// (`WatchSync.snapshotProvider`) so both hand the watch the same list.
    func watchTargets() -> [WatchTargetTuple] {
        dms
            .filter { $0.type == "dm" }
            .prefix(12)
            .map { dm -> WatchTargetTuple in
                // For E2EE DMs, relay the (verified) 32-byte key as base64 so the
                // watch can encrypt outgoing + decrypt incoming itself. The e2ee
                // flag rides along even when we have no key, so the watch knows to
                // refuse a plaintext send rather than leak. The streak lets the
                // wrist show what level you're at.
                let keyB64 = dm.isE2EE ? e2eeKey(for: dm)?.base64EncodedString() : nil
                // The names the watch's Siri extension matches against — the
                // same three the phone uses.
                let peer = dm.dmAvatarUser
                var linkedName: String?
                if let peerId = peer?.id { linkedName = ContactLinks.contactName(forUserId: peerId) }
                return (id: dm.id, name: dm.dmTitle, streak: dm.streak ?? 0, e2ee: dm.isE2EE,
                        e2eeKeyBase64: keyB64, username: peer?.username, contactName: linkedName)
            }
    }

    /// Push the current auth token + recent 1:1 DM peers to the Apple Watch
    /// poke app over WatchConnectivity. Cheap + coalesced (latest-wins).
    func syncWatch() {
        WatchSync.shared.sync(token: api.token, targets: watchTargets())
        // The Home/Lock-Screen widget shares the same trigger (DM list / token
        // changed) — publish to the App Group + reload its timeline.
        syncWidgets()
    }

    /// Publish the recent DMs + token to the App Group so the WidgetKit
    /// extension can render the "Quick DM" widget and fire a one-tap poke, then
    /// nudge WidgetKit to reload. Cheap + idempotent (latest-wins).
    func syncWidgets() {
        // 30 rather than 12: the widget only ever shows a handful, but this is
        // also the list Siri resolves "message <name>" against, and a voice
        // request for someone you spoke to last week should still find them.
        //
        // The `type == "dm"` filter is load-bearing beyond the widget: this list
        // is the ONLY thing the Siri extension can address, so one-to-one DMs
        // are the only conversations Siri can send to. Group DMs and server
        // channels are unaddressable by construction, not by a check that could
        // be forgotten.
        let items = dms
            .filter { $0.type == "dm" }
            .prefix(30)
            .map { channel -> WidgetDM in
                let peer = channel.dmAvatarUser
                // The name on a linked Contacts card, when there is one: what
                // the user actually says to Siri.
                var linkedName: String?
                if let peerId = peer?.id {
                    linkedName = ContactLinks.contactName(forUserId: peerId)
                }
                return WidgetDM(
                    id: channel.id,
                    name: channel.dmTitle,
                    streak: channel.streak ?? 0,
                    avatarURL: assetURL(peer?.avatarUrl)?.absoluteString,
                    isE2EE: channel.isE2EE,
                    peerUserId: peer?.id,
                    peerUsername: peer?.username,
                    contactName: linkedName,
                )
            }
        WidgetBridge.publish(dms: Array(items), token: api.token)
        WidgetCenter.shared.reloadAllTimelines()
        // A name spoken inside an App Shortcut phrase is matched against an
        // index Siri holds, not by asking the app, and that index is only
        // rebuilt when told. Without this a new DM — or a newly linked contact
        // name — is heard and dropped. (The SiriKit path uses donations
        // instead; this is the App Intents equivalent.)
        ZekktrisShortcuts.updateAppShortcutParameters()
    }

    // MARK: Share Suggestions (system share sheet)

    /// May we offer this account's conversations as share targets at all?
    ///
    /// A donation puts a contact's name + face into the share sheet of EVERY
    /// other app on the device, outside anything Zekktris can gate — so a
    /// supervised account that isn't allowed to DM must not donate, and anything
    /// already donated has to be revoked (see `loadFamily`). An unsupervised
    /// account has no `restrictions` blob and is always allowed.
    ///
    /// NOT A LIVE-SESSION TEST — this is NEW-1 on
    /// `ShareSuggestions.donationsEnabled`, and it is why donations are off.
    /// `stop()` nils `family`, and "no family blob" reads as allowed here, so a
    /// continuation resuming after sign-out passes this guard. It is still the
    /// right *supervision* check; it just cannot be the only gate. Anyone
    /// re-enabling donation must pair it with a positive check on a live
    /// `currentUserId`, captured at donate time and re-checked at write time.
    var shareSuggestionsAllowed: Bool {
        // NEW-1 FIX: a LIVE session is required, positively. This used to test
        // only the supervision blob, and `stop()` nils `family` on sign-out — so
        // a signed-out session read "no restrictions" as "allowed", and a send()
        // continuation resuming after logout could re-arm the latch and donate a
        // contact onto a signed-out phone. Android was protected by its
        // `phase != Ready` check; iOS had no equivalent. `stop()` also nils
        // currentUserId, so this is the same signal.
        guard currentUserId != nil else { return false }
        guard let family else { return true }
        if family.restrictedHeavily == true { return false }
        guard let r = family.restrictions else { return true }
        return r.allowMessaging && r.dmPolicy != "none"
    }

    /// Donate a DM to iOS Share Suggestions so it can be offered as a direct
    /// share target in other apps. Conversation identity only — the recipients,
    /// the name the VIEWER sees (personal nickname wins, same as everywhere
    /// else), and their avatar. Never message content, so E2EE DMs donate the
    /// same payload plaintext ones do.
    ///
    /// Cheap + throttled inside `ShareSuggestions`, so it's safe on every open
    /// and every send.
    ///
    /// LIVE: `donationsEnabled` is true, so this really does write to the
    /// system index. (Both this comment and QuickReply's header said it was a
    /// no-op long after the flag was turned back on — donated conversations are
    /// what carry `contactIdentifier` to Siri, so the difference matters.)
    /// Revocation — `deleteConversation` / `deleteAll` at the call sites in
    /// `stop()`, `blockUser`, `closeDM`, `CHANNEL_DELETE` and `loadFamily` — is
    /// unconditional and must stay live.
    /// `force` bypasses the once-a-minute throttle. Linking or unlinking a
    /// contact must take effect now — the donation is what carries (or drops)
    /// the contact identifier, and a throttled no-op reads as the feature not
    /// working.
    func donateShareSuggestion(_ channel: Channel, force: Bool = false) {
        guard channel.isDM, shareSuggestionsAllowed else { return }
        // Bots aren't share targets, and a DM with nobody left in it would
        // donate a faceless row.
        let peers = (channel.recipients ?? []).filter { $0.isBot != true }
        guard !peers.isEmpty else { return }
        // A blocked person must not be re-offered as a share target — otherwise
        // simply opening the (still-listed) DM would undo the revocation
        // `blockUser` just performed.
        //
        // NEW-3 FIX: scoped to 1:1, matching `blockUser`. Bailing on a blocked
        // participant of a GROUP DM was worse than no guard at all: `blockUser`
        // deliberately leaves group donations in place (the group is still live
        // for its other members), so refusing to re-donate meant the existing
        // entry could never be refreshed — freezing the blocked member's name and
        // face in the system index permanently.
        if channel.type == "dm",
           peers.contains(where: { relationshipType(with: $0.id) == "blocked" }) { return }
        // Re-arm after a sign-out / supervision `deleteAll()` latched donations
        // off: reaching here means a live session that the supervision gate
        // allows. Mirrors Android's `ShareShortcuts.enable()` in
        // `refreshShareShortcuts`.
        ShareSuggestions.enable()
        let recipients = peers.map {
            ShareSuggestions.Recipient(
                id: $0.id,
                name: dmNickname($0.id) ?? $0.name,
                avatarURL: assetURL($0.avatarUrl)
            )
        }
        ShareSuggestions.donate(
            ShareSuggestions.Conversation(
                channelId: channel.id,
                title: dmDisplayTitle(channel),
                isGroup: channel.type == "group_dm",
                recipients: recipients
            ),
            force: force
        )
    }

    /// Reorder sibling channels within a group (a category, or the
    /// uncategorized top level). Optimistically renumbers local positions so
    /// the list re-sorts immediately; reverts via reload on failure.
    /// Persist a whole channel order as `{id, position, parentId}` rows.
    ///
    /// `position` is the index WITHIN the sibling group — top-level categories,
    /// top-level channels, and each category's children are numbered
    /// independently. That is what the server stores and what the web client
    /// sends (apps/web/src/lib/useChannelDragReorder.ts), so all three clients
    /// agree on what a position means.
    ///
    /// Replaces an older single-parent version that took one `parentId` for the
    /// entire batch and so could only ever reorder inside one group — it could
    /// not express "this channel moved to that category", which is the whole
    /// point of dragging across headings.
    func applyChannelOrder(_ entries: [[String: Any]]) async {
        guard let g = selectedGuild else { return }
        // Optimistic: the sidebar renders straight off `channels`, so patch it
        // before the round-trip. The CHANNEL_UPDATE echoes that follow re-apply
        // the same values, and a rejection falls back to a refetch below.
        for entry in entries {
            guard let id = entry["id"] as? String,
                  let position = entry["position"] as? Int,
                  let idx = channels.firstIndex(where: { $0.id == id }) else { continue }
            channels[idx].position = position
            // NSNull (top level) fails the String cast and lands as nil, which
            // is exactly the value the sidebar treats as "no category".
            channels[idx].parentId = entry["parentId"] as? String
        }
        do { try await api.reorderChannels(guildId: g.id, channels: entries) }
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
        // "Jump to mention": load a window centered on the target id (instead of
        // the most recent page) and scroll to it once merged. Consumed up front
        // so it can't leak into a later, unrelated load.
        let jumpId = pendingJumpMessageId
        pendingJumpMessageId = nil
        let presenceBefore = presenceSnapshot()
        do {
            let fetched = try await api.messages(channelId: channel.id, limit: 50, around: jumpId)
            // The API returns newest-first; show oldest-first (bottom = newest).
            guard channel.id == selectedChannel?.id else { return }
            var merged = fetched.sorted { $0.createdAt < $1.createdAt }
            // Keep anything that arrived over the gateway while the fetch was
            // in flight (it's in `messages` but not in the page) — replacing
            // the array outright dropped those rows.
            let fetchedIds = Set(merged.map { $0.id })
            // Keep ONLY genuinely concurrent gateway arrivals — rows NEWER than
            // the newest fetched message. With the per-channel cache now seeding
            // `messages`, older seed rows must not be re-merged here, or a message
            // deleted while the channel was closed (the delete event only mutates
            // an OPEN channel) would resurrect. The seed paints instantly; this
            // refresh replaces it with server truth for the latest window.
            let cutoff = merged.last?.createdAt
            let live = messages.filter {
                $0.channelId == channel.id && !fetchedIds.contains($0.id)
                    // ALWAYS keep in-flight / failed optimistic sends (sendState
                    // != nil), regardless of the createdAt cutoff — otherwise a
                    // resume-triggered refresh landing while a placeholder is
                    // on screen could drop it (a whole-second placeholder
                    // timestamp string-compares as older than a same-second
                    // server row with millis), making the send silently vanish.
                    && ($0.sendState != nil || cutoff == nil || $0.createdAt > cutoff!)
            }
            if !live.isEmpty {
                merged.append(contentsOf: live)
                merged.sort { $0.createdAt < $1.createdAt }
            }
            messages = merged
            // Seed presence from the message AUTHORS. The message row's dot
            // reads the map like every other surface now, and its old
            // per-message `message.author.status` fallback was the worst of the
            // lot: a different frozen snapshot for every row, sitting one inch
            // from a member list showing a different frozen snapshot for the
            // same person. (The DTO resolves author.status at query time, so
            // these are current-at-fetch, not message-creation-time, values.)
            // For a user who has since left the guild this is the ONLY
            // presence source we get.
            seedPresence(merged.compactMap { $0.author }, before: presenceBefore)
            // A full page implies there may be older history to page back into.
            hasMoreMessages = fetched.count >= 50
            decryptVisible()
            // Jumped-to message is now loaded — scroll to it.
            if let jumpId { pendingScrollAnchorId = jumpId }
            // Notification tap into a guild channel — prefill a reply to the
            // message we deep-linked to, now that it's loaded.
            if let replyId = pendingReplyMessageId {
                pendingReplyMessageId = nil
                if let m = messages.first(where: { $0.id == replyId }) { replyingTo = m }
            }
            // Self-heal a stale open: a MESSAGE_CREATE that arrived in the gap
            // between tap and openChannel was dropped from `messages` (it only
            // bumped the channel's lastMessageId), and/or this page read a
            // replica lagging the just-arrived message — so the newest message
            // is missing until you back out and re-enter. If the store knows of a
            // newer id than the newest row we loaded, pull the gap in once via
            // the `after` cursor. Skipped during a jump-to-mention load (that
            // wants the centered window, not the latest page). upsert is
            // dedup-safe and the fetch is best-effort + guarded on still being
            // the open channel, so the common (page-already-current) case is a
            // no-op with zero extra network calls.
            if jumpId == nil,
               let after = merged.last(where: { $0.id.allSatisfy(\.isNumber) })?.id,
               let knownLatest = dms.first(where: { $0.id == channel.id })?.lastMessageId
                   ?? channels.first(where: { $0.id == channel.id })?.lastMessageId,
               knownLatest.allSatisfy(\.isNumber),
               snowflakeGreater(knownLatest, than: after),
               let newer = try? await api.messages(channelId: channel.id, limit: 50, after: after),
               channel.id == selectedChannel?.id {
                for m in newer.sorted(by: { $0.createdAt < $1.createdAt }) { upsert(m) }
                decryptVisible()
            }
        } catch {
            // Access to the open channel was revoked (made private / deleted)
            // out from under us — the server denies the read. Pop out so its
            // stale on-screen history isn't left readable. (Defense-in-depth on
            // top of the CHANNEL_DELETE pop and the reconnect re-validate.)
            if let status = (error as? APIError)?.status, status == 403 || status == 404,
               channel.id == selectedChannel?.id {
                // Drop any cached history so a revoked/private channel can't
                // repaint it from cache on a later reopen.
                messageCache.removeValue(forKey: channel.id)
                messageCacheLRU.removeAll { $0 == channel.id }
                clearChannel()
            } else {
                errorText = (error as? APIError)?.message ?? error.localizedDescription
                // Transient failure — e.g. opening a chat seconds after
                // foregrounding while the radio is still waking. The cache seed
                // stays on screen and nothing retried until the 12s poll: the
                // "I opened the chat and the new messages aren't there" gap.
                // Retry shortly (twice), guarded on this channel still being
                // open. reconcileOpenChannel falls back to a full load when
                // nothing is loaded yet, and upserts are dedup-safe.
                let cid = channel.id
                Task { [weak self] in
                    try? await Task.sleep(nanoseconds: 1_500_000_000)
                    guard let self, self.selectedChannel?.id == cid else { return }
                    await self.reconcileOpenChannel()
                    try? await Task.sleep(nanoseconds: 2_500_000_000)
                    guard self.selectedChannel?.id == cid else { return }
                    await self.reconcileOpenChannel()
                }
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

    /// Pull any messages that arrived in the OPEN conversation while we were
    /// backgrounded / the socket was suspended, and append them — so new
    /// messages show on return without having to leave and re-enter the
    /// channel. Surgical: fetches only messages NEWER than the newest we hold
    /// (server `after` cursor), so it preserves scroll position and doesn't
    /// flash, and it's dedup-safe via `upsert`, so it can't double up with the
    /// gateway's RESUME replay. Best-effort — a failure just leaves things as
    /// they were. Called on foreground because the RESUMED path intentionally
    /// skips the READY full-resync and a resume gap (or a message delivered to
    /// the now-discarded suspended socket) can otherwise be missed.
    func reconcileOpenChannel() async {
        guard let channel = selectedChannel else { return }
        // Foregrounding back into an already-open channel (no re-open, so
        // markChannelRead won't fire) should still clear any notifications
        // that landed for it while we were backgrounded. Kept BEFORE the
        // coalescing guard so it fires on every trigger, not just the winner.
        clearDeliveredNotifications(forChannel: channel.id)
        // Coalesce the storm of triggers one foreground produces: skip if a
        // reconcile is already running, or one completed within the last ~1.2s
        // (the immediate + RESUMED calls collide here). 1.2s is below the +1.3s
        // timer gap, so the intended second safety-net reconcile still fires;
        // the +4s call, a later RESUMED, and the 12s poll all fall outside and
        // still run — the safety net is intact.
        if reconcileInFlight { return }
        if Date().timeIntervalSince(lastReconcileAt) < 1.2 { return }
        reconcileInFlight = true
        defer { reconcileInFlight = false; lastReconcileAt = Date() }
        // Cursor on the newest SERVER-confirmed message (a numeric snowflake);
        // skip optimistic placeholders, whose ids are send nonces the server
        // can't page from. Nothing loaded yet → a normal load instead.
        guard let afterId = messages.last(where: { $0.id.allSatisfy(\.isNumber) })?.id else {
            await loadMessages(channel)
            return
        }
        do {
            let newer = try await api.messages(channelId: channel.id, limit: 50, after: afterId)
            guard channel.id == selectedChannel?.id, !newer.isEmpty else { return }
            for m in newer.sorted(by: { $0.createdAt < $1.createdAt }) { upsert(m) }
        } catch {
            // Best-effort background refresh — don't surface a toast.
        }
    }

    /// BULLETPROOF catch-up for the OPEN conversation. Fetches the LATEST
    /// window (no `after` cursor — the exact call re-opening the channel makes,
    /// which the user has confirmed always recovers a missed message) and
    /// MERGES it via `upsert` so it never resets scroll or drops loaded history.
    ///
    /// This exists because the after-cursor `reconcileOpenChannel` — however
    /// many times we retry it — can still leave the open chat stale on a
    /// resume-from-suspension: a slow/failed cursor fetch, the reconcile
    /// coalescing window swallowing the retry, or the socket resume racing the
    /// network all produce the "I foreground into the DM and the new message
    /// isn't there until I back out and re-enter" symptom. The plain latest
    /// fetch shares none of those failure modes, so it's the guaranteed floor:
    /// every foreground and every notification-tap-into-an-already-open chat
    /// runs it, and a message that slipped through every live path appears
    /// without the user having to leave and re-enter.
    func refreshOpenChannelLatest() async {
        guard let channel = selectedChannel else { return }
        // Don't fight an in-progress deep-link jump to an OLD message (that
        // loads a window AROUND the id); a latest-window merge would append a
        // disjoint block and yank the view. Every other case wants the latest.
        if pendingJumpMessageId != nil { return }
        guard let latest = try? await api.messages(channelId: channel.id, limit: 50) else { return }
        guard channel.id == selectedChannel?.id, pendingJumpMessageId == nil else { return }
        for m in latest.sorted(by: { $0.createdAt < $1.createdAt }) { upsert(m) }
    }

    // MARK: Read state / unread

    func loadReadStates() async {
        guard let states = try? await api.listReadStates() else { return }
        var map: [String: ReadState] = [:]
        for s in states { map[s.channelId] = s }
        readStates = map
        updateAppBadge()
    }

    /// Pending coalesced server acks, keyed by channel id. Each MESSAGE_CREATE
    /// in the open channel calls markChannelRead; without coalescing that was
    /// one POST /ack per incoming message in a busy channel. The local marker
    /// updates immediately (UI stays correct); the network ack trails on a
    /// short timer and always sends the NEWEST marker at fire time.
    private var pendingAckTasks: [String: Task<Void, Never>] = [:]

    /// Mark a channel read up to its newest known message and ack server-side.
    func markChannelRead(_ channel: Channel) {
        // Opening/seeing a channel clears any of its delivered push
        // notifications from Notification Center (and the lock screen) so the
        // user isn't left staring at a banner for a conversation they've
        // already read. Runs before the early-returns below so it fires on
        // every open — DMs, text channels, and forum posts alike — even when
        // the read marker is already current.
        clearDeliveredNotifications(forChannel: channel.id)
        // Use the newest CONFIRMED (numeric-id) message — an in-flight optimistic
        // send carries a UUID nonce as its id, which must never be written to
        // readStates or POSTed as the ack messageId. Mirrors reconcileOpenChannel.
        let newestConfirmed = channel.id == selectedChannel?.id
            ? messages.last(where: { $0.id.allSatisfy(\.isNumber) })?.id
            : nil
        let newest = newestConfirmed ?? channel.lastMessageId
        guard let last = newest, !last.isEmpty else { return }
        if let rs = readStates[channel.id], rs.lastMessageId == last, (rs.mentionCount ?? 0) == 0 { return }
        readStates[channel.id] = ReadState(channelId: channel.id, lastMessageId: last, mentionCount: 0)
        updateAppBadge()
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

    /// iOS app-icon badge count: unread DM conversations + total mention count.
    /// Matches the server's push-badge semantic (services/readStates.unreadBadge
    /// Count) so the home-screen badge stays roughly in sync whether it was last
    /// set by a push (app closed) or by the app itself (running).
    var unreadBadgeCount: Int {
        let dmUnread = dms.filter { isChannelUnread($0) }.count
        let mentions = readStates.values.reduce(0) { $0 + ($1.mentionCount ?? 0) }
        return dmUnread + mentions
    }

    /// Set the iOS app-icon badge to the current unread count (0 clears it).
    /// Called on foreground, after loads/reads, and on realtime events that
    /// change unread — so the badge tracks unread while the app runs, and the
    /// push's aps.badge takes over while it's closed.
    func updateAppBadge() {
        UNUserNotificationCenter.current().setBadgeCount(unreadBadgeCount) { _ in }
    }

    /// Remove any delivered notifications for a channel from Notification
    /// Center when the user opens/reads it. Message pushes set
    /// aps['thread-id'] = channelId AND carry channelId in their top-level
    /// data (see services/apns.ts + routes/messages.ts), so a delivered
    /// notification for this channel matches either on `threadIdentifier`
    /// or via the shared `channelId(from:)` extractor — the latter also
    /// catches pokes, whose thread-id is `poke-<channelId>` but whose data
    /// still carries the channelId.
    ///
    /// The getDeliveredNotifications completion is `@Sendable` and runs off
    /// the main actor, so it captures nothing non-Sendable: it re-acquires
    /// `UNUserNotificationCenter.current()` rather than closing over an outer
    /// reference, and skips the badge (the open channel never counts toward
    /// it — `isChannelUnread` is false for the selected channel — and
    /// markChannelRead already refreshes it on the read path).
    func clearDeliveredNotifications(forChannel channelId: String) {
        UNUserNotificationCenter.current().getDeliveredNotifications { delivered in
            let ids = delivered
                .filter { note in
                    let content = note.request.content
                    if content.threadIdentifier == channelId { return true }
                    return NotificationDelegate.channelId(from: content.userInfo) == channelId
                }
                .map { $0.request.identifier }
            guard !ids.isEmpty else { return }
            UNUserNotificationCenter.current().removeDeliveredNotifications(withIdentifiers: ids)
        }
    }

    /// Keep a channel/DM's lastMessageId current as messages arrive, so unread
    /// indicators react even for channels that aren't open.
    private func bumpChannelLastMessage(_ channelId: String, _ messageId: String) {
        if let i = channels.firstIndex(where: { $0.id == channelId }),
           (channels[i].lastMessageId.map { snowflakeGreater(messageId, than: $0) } ?? true) {
            // Update in place WITHOUT the didSet re-sort / mentionContextVersion
            // bump (lastMessageId isn't a sort key), then mirror into the derived
            // sortedChannels the list renders so the unread dot still updates.
            bumpingLastMessage = true
            channels[i].lastMessageId = messageId
            bumpingLastMessage = false
            if let j = sortedChannels.firstIndex(where: { $0.id == channelId }) {
                sortedChannels[j].lastMessageId = messageId
            }
        }
        if let i = dms.firstIndex(where: { $0.id == channelId }),
           (dms[i].lastMessageId.map { snowflakeGreater(messageId, than: $0) } ?? true) {
            dms[i].lastMessageId = messageId
            // The DM list is recency-sorted (see performLoadDMs) — unlike the
            // position-sorted channel list, a new message DOES change DM order.
            // Re-sort so the just-active conversation jumps to the top; republish
            // only when the order actually changed to avoid needless re-renders.
            let resorted = dms.sorted {
                snowflakeGreater($0.lastMessageId ?? $0.id, than: $1.lastMessageId ?? $1.id)
            }
            if resorted.map(\.id) != dms.map(\.id) {
                dms = resorted
            }
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
                await voice.connect(url: url, token: token, e2eeKey: key, tag: channel.id)
                // Leave raced the connect — tear the just-connected room back down.
                guard voiceChannelId == channel.id else { await voice.disconnect(); return }
                // connect() swallows its own failure (it sets .failed rather than
                // throwing), so this catch block is never entered for an SFU
                // failure and the slot stays claimed. openVoice's
                // `voiceChannelId != channel.id` gate then silently refuses every
                // retry — the user has to hang up a call they were never in
                // before they can try again. Production showed exactly that:
                // seven failed joins spread over ten hours, each needing a manual
                // hangup first. Surrender the slot when the join didn't take.
                if !voice.isConnected { voiceChannelId = nil }
            } else {
                voiceTokenMissing = true
            }
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            // Only surrender the slot if it's still OURS. A slow join that fails
            // AFTER the user has already started (and connected) a different
            // call would otherwise nil the newer call's voiceChannelId — leaving
            // a live LiveKit room with no call UI anywhere and the mic still
            // publishing ("people can still hear me but there's no call
            // screen"). Mirrors the success path's guard at :2236.
            if voiceChannelId == channel.id { voiceChannelId = nil }
        }
    }

    /// `notifyServer` is false only when another of our devices took the call
    /// over (see VoiceManager.onConnectionLost): the server's leave is
    /// per-user, so it would remove that device's voice state instead of ours.
    /// `hangupCue` is false only when LiveKit itself lost the call (see the
    /// cue below).
    func leaveCurrentVoice(notifyServer: Bool = true, hangupCue: Bool = true) async {
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
        // HANGUP cue. This is the single chokepoint for EVERY call end — the red
        // button, the CallKit End action, the 1:1 auto-end when the peer leaves,
        // a server evict/decline, and READY reconciliation all funnel through
        // here — so the sound fires exactly once whether we hung up or they did.
        // (`isLeavingVoice` above collapses the overlapping triggers, so it can't
        // double-fire.) Played BEFORE voice.disconnect(): the call still owns the
        // audio session, so the cue never has to touch session configuration.
        // Except when LiveKit itself lost the call (onConnectionLost): it has
        // already stopped its engine and released the session (the call is
        // .failed, so callAudioActive is false), and the cue would claim the
        // session for itself (VoiceSounds' no-call branch: .playback +
        // setActive) right while CallKit ends its call and this teardown flips
        // the engine gate: the concurrent reconfiguration this flow exists to
        // avoid, leaving a non-mixable session active that keeps other apps'
        // audio from resuming. A dropped call ends silently instead.
        if id != nil, hangupCue { VoiceSounds.play(.hangup) }
        await voice.disconnect()
        if let id, notifyServer { await api.leaveVoice(channelId: id) }
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
        // A leave (or a hop to another stage) can land while the roster fetch is
        // in flight — publishing a stale roster would repopulate a stage we've
        // already walked out of. Mirrors joinVoice's post-await guard.
        guard stageChannelId == id else { return }
        stageParticipants = res.participants
        // If a moderator flipped my speaker status, re-fetch a token gated on
        // the new role and reconnect (audience↔speaker needs a new publish grant).
        if let uid = currentUserId, let me = res.participants.first(where: { $0.userId == uid }), me.isSpeaker != myStageSpeaker {
            myStageSpeaker = me.isSpeaker
            if let again = try? await api.joinStage(channelId: id) {
                // Re-check BEFORE connecting: a leave that raced this in-flight
                // promotion would otherwise bring a LIVE, PUBLISHING MIC up in a
                // stage the user has already left. The re-join above also put us
                // back in the server's stage roster, so undo it on the way out.
                guard stageChannelId == id else { await api.leaveStage(channelId: id); return }
                if let token = again.token, let url = again.wsUrl, !token.isEmpty, !url.isEmpty {
                    await voice.connect(url: url, token: token, publishMic: me.isSpeaker)
                    // Leave raced the connect — tear the just-connected room back down.
                    guard stageChannelId == id else { await voice.disconnect(); return }
                }
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
        // Unmuting while deafened undeafens too (VoiceManager.toggleMute), and
        // the server's selfDeaf has to follow then.
        let wasDeafened = voice.isDeafened
        await voice.toggleMute()
        if let id = voiceChannelId {
            reportMuteToCallKit(channelId: id)
            let deafChanged = voice.isDeafened != wasDeafened
            await api.updateVoiceState(channelId: id, selfMute: voice.isMuted,
                                       selfDeaf: deafChanged ? voice.isDeafened : nil)
        }
    }

    func toggleVoiceDeafen() async {
        await voice.toggleDeafen()
        if let id = voiceChannelId {
            reportMuteToCallKit(channelId: id)
            await api.updateVoiceState(channelId: id, selfMute: voice.isMuted, selfDeaf: voice.isDeafened)
        }
    }

    func setPushToTalk(_ on: Bool) {
        voice.setPushToTalk(on)
        guard let id = voiceChannelId, voice.isConnected else { return }
        // Push-to-talk never mirrors into CallKit: drop a CallKit mute an earlier
        // in-app mute left behind (it would silence the talk button on iOS 17+),
        // and on leaving push-to-talk report where the mic lands.
        CallManager.shared.reportMuted(channelId: id, muted: on ? false : voice.isDeafened)
        // Either way an earlier in-app mute no longer holds the mic (the talk
        // button opens it in push-to-talk; leaving push-to-talk opens it), so
        // clear the server's selfMute too unless deafened. Otherwise peers see
        // a muted icon on a live mic and the AFK sweep moves a talking member.
        if !voice.isDeafened {
            Task { await api.updateVoiceState(channelId: id, selfMute: false, selfDeaf: nil) }
        }
    }

    /// Keep a CallKit-owned 1:1 call's mute in step with an in-app change
    /// (CallManager.reportMuted; a no-op for calls CallKit doesn't own). Not
    /// in push-to-talk: there `isMuted` is just the talk button at rest, and on
    /// iOS 17+ a CallKit mute also mutes the input system-wide, which would
    /// silence the talk button too.
    private func reportMuteToCallKit(channelId: String) {
        guard !voice.pushToTalkEnabled else { return }
        CallManager.shared.reportMuted(channelId: channelId, muted: voice.isMuted)
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
        //
        // JOIN/LEAVE cues ride the same three branches, because they already
        // encode exactly the transitions we want:
        //   - update-in-place  = a mute/deafen/video toggle, NOT an arrival — silent
        //   - remove           = they left this channel (or moved away)  → LEAVE
        //   - append           = they arrived in this channel            → JOIN
        // Never for ourselves (our own arrival/exit is CONNECT/HANGUP, and
        // doubling them is wrong) and never for another channel: `active` is the
        // channel we are connected to, and a state for anywhere else matches no
        // branch. Participants already present when WE joined came in via
        // joinVoice's snapshot, so entering a busy channel doesn't blip either.
        // VoiceSounds rate-limits these, so five people arriving at once is one
        // blip rather than a chord.
        let isOther = vs.userId != currentUserId
        if let i = voiceStates.firstIndex(where: { $0.userId == vs.userId }) {
            if vs.channelId == active { voiceStates[i] = vs }
            else {
                voiceStates.remove(at: i)
                if isOther { VoiceSounds.play(.leave) }
            }
        } else if vs.channelId == active {
            voiceStates.append(vs)
            if isOther { VoiceSounds.play(.join) }
        }



        // 1:1 DM auto-end (web parity): when no other participant remains in
        // our active 1:1 DM call, hang up our side too instead of stranding a
        // solo call. Keyed on "no non-self peer left" rather than `wasInCall`
        // so it still fires when the peer's JOIN lost the voiceChannelId race
        // (never added to voiceStates). If the DM isn't cached yet (cold-start
        // answer before loadDMs), resolve it once and re-check — mirrors
        // handleIncomingCall's loadDMs-and-retry. group_dm / guild voice are
        // intentionally excluded (they legitimately keep one person).
        // The event MUST be about this DM's own peer. Without that check the
        // guard was just "some other user moved to some other channel", which is
        // true for e.g. a friend joining an unrelated guild voice channel — and
        // because an OUTGOING call has no peer present for its entire ring-out,
        // `peerStillPresent` is false the whole time, so any such stray event
        // hung up the user's own ringing call ("it hangs up by itself / their
        // phone just stops ringing"). `recipients` already excludes self, so for
        // a 1:1 DM it is exactly the peer.
        if vs.userId != currentUserId, vs.channelId != active {
            let peerStillPresent = voiceStates.contains { $0.userId != currentUserId && $0.channelId == active }
            if !peerStillPresent {
                if let dm = dms.first(where: { $0.id == active }) {
                    if dm.type == "dm",
                       dm.recipients?.contains(where: { $0.id == vs.userId }) == true {
                        Task { await leaveCurrentVoice() }
                    }
                } else {
                    Task { [weak self] in
                        await self?.loadDMs()
                        guard let self, self.voiceChannelId == active,
                              let dm = self.dms.first(where: { $0.id == active }), dm.type == "dm",
                              dm.recipients?.contains(where: { $0.id == vs.userId }) == true,
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
        // A nil channelId doesn't say WHICH channel we left, and the server also
        // sends one to the OLD channel when we (or another of our devices) join a
        // different one, after joinVoice already pointed voiceChannelId at the
        // new channel. Hang up only if the server no longer has us in `active`.
        // It has then already removed or moved our state, so no DELETE: that is
        // per user and would remove a state another of our devices now holds.
        if vs.userId == currentUserId, vs.channelId == nil {
            Task { [weak self] in
                guard let self else { return }
                // Only a definitive answer may end the call. A timeout, 5xx or offline
                // moment says nothing about `active`. A real eviction also removes us from
                // the SFU, so participantRemoved's fallback and READY reconciliation end
                // the call if both attempts fail.
                var states: [VoiceState]?
                var gone = false
                for attempt in 0..<2 where states == nil && !gone {
                    if attempt > 0 { try? await Task.sleep(nanoseconds: 2_000_000_000) }
                    do {
                        states = try await self.api.channelVoiceStates(channelId: active)
                    } catch let e as APIError where e.status == 403 || e.status == 404 {
                        gone = true // we can no longer see the channel (kicked, deleted)
                    } catch {}
                }
                guard self.voiceChannelId == active else { return }
                if let states, states.contains(where: { $0.userId == self.currentUserId }) { return }
                if states != nil || gone { await self.leaveCurrentVoice(notifyServer: false) }
            }
        }
    }

    /// Participants currently in a given voice/stage channel (sidebar rows).
    func voiceParticipants(in channelId: String) -> [VoiceState] {
        voiceStatesByUser.values
            .filter { $0.channelId == channelId }
            .sorted { $0.userId < $1.userId }
    }

    /// If the gateway reports OUR voice state moved to a channel different from
    /// the one we're connected to, a moderator dragged us (the server already
    /// evicted us from the old SFU room). Disconnect and rejoin the new one,
    /// mirroring the web's self-move handling. Best-effort: if the target
    /// channel isn't in the loaded set (a cross-guild move) we skip rather than
    /// guess, leaving the user to rejoin manually.
    /// Only for states the server marks `moved` (a moderator move or the AFK
    /// sweep). Any other own state naming another channel is one of our other
    /// devices joining it (or a late echo of our own earlier join): rejoining
    /// would take that device's call. The old channel's "left" event, handled
    /// in applyVoiceState, ends this device's call instead.
    private func handleVoiceSelfMove(_ vs: VoiceState) {
        guard vs.userId == currentUserId,
              vs.moved == true,
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
        // Skip the reconcile-leave while a join is actively in flight: joinVoice
        // sets voiceChannelId BEFORE awaiting api.joinVoice, so a READY landing
        // in that window has no voice_state row for us yet and would tear down a
        // call we're mid-answering. voiceConnecting is false for a genuinely
        // stale call from a suspended session, so those are still torn down.
        if let active = voiceChannelId, !voiceConnecting,
           !states.contains(where: { $0.userId == currentUserId && $0.channelId == active }) {
            callLog.info("READY: reconcile stale voiceChannelId \(active, privacy: .public) (not in snapshot) — leaving")
            Task { await leaveCurrentVoice() }
        } else if let active = voiceChannelId, !voiceConnecting,
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
        // NOTE: a "cancel stale rings absent from the READY snapshot" pass used
        // to live here (to clear a ghost ring after a missed hangup). It was
        // removed: on a cold-start/locked call the VoIP push reports the ring,
        // THEN the gateway connects and READY arrives — and if the caller's
        // voice_state hadn't propagated into that snapshot yet, the pass would
        // CANCEL the legitimate, just-appeared incoming ring. A lingering ghost
        // ring is a far smaller problem than silently dropping a real call, so
        // the cancel is not worth the risk on this timing-sensitive path.
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
        // We are now present in this DM call on ANOTHER device (answered there).
        // The DM-channel fan-out delivers our OWN join to every device of ours,
        // so this device's ring is stale. Dismiss the local CallKit ring +
        // in-app overlay WITHOUT a server decline/hangup — the call is live on
        // the other device, and a decline here would evict the caller from the
        // SFU and kill it. Scope tightly: only when this device is ringing or
        // isn't itself joined to that channel, so an outgoing/self-join echo on
        // the ANSWERING device (voiceChannelId == channelId) never misfires.
        if vs.userId == currentUserId {
            if incomingCall?.channelId == channelId || voiceChannelId != channelId {
                if incomingCall?.channelId == channelId { incomingCall = nil }
                CallManager.shared.remoteCancelled(channelId: channelId)
                callLog.info("ring dismissed: answered elsewhere ch=\(channelId, privacy: .public)")
            }
            return
        }
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
            noteE2EEChange(updated.id)
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
            let previous = selectedChannel
            selectedChannel = updated
            // A re-key (new salt/verifier) invalidates any cached key. (When it
            // does, relockE2EE bumps e2eeUnlockVersion itself.)
            purgeStaleE2EEKey(updated)
            registerE2EEPurgeProofIfNeeded(updated)
            // If we still hold a valid key, decrypt anything already loaded.
            decryptVisible()
            // Re-evaluate the lock gate when E2EE was just turned on/off or
            // re-keyed — and ONLY then. Every message row carries
            // e2eeUnlockVersion, and every encrypted image/video keys its load
            // task on it, so bumping it for any CHANNEL_UPDATE (a rename, a
            // topic, a last-message move) re-rendered every row and restarted
            // every media task in the open conversation for nothing.
            if previous?.e2eeEnabled != updated.e2eeEnabled
                || previous?.e2eeSalt != updated.e2eeSalt
                || previous?.e2eeVerifier != updated.e2eeVerifier {
                e2eeUnlockVersion += 1
            }
        }
    }

    // MARK: Reactions

    /// Per-device optimistic reaction directions we've applied locally and are
    /// still awaiting the gateway echo for. Keyed by channel+message+emoji+add/rem
    /// so a rapid same-device toggle (add then remove) tracks each echo separately.
    /// Lets us swallow only THIS device's own echoes while letting an own-reaction
    /// made on ANOTHER device through to update the open DM live.
    private var pendingSelfReactionKeys: Set<String> = []

    private func reactionKey(_ channelId: String, _ messageId: String, _ emoji: String, add: Bool) -> String {
        "\(channelId)|\(messageId)|\(emoji)|\(add ? "add" : "rem")"
    }

    /// Toggle the current user's reaction for an emoji, optimistically.
    func toggleReaction(_ message: Message, emoji: String) async {
        guard let channelId = selectedChannel?.id,
              let mi = messages.firstIndex(where: { $0.id == message.id }) else { return }
        let hasMine = (messages[mi].reactions ?? []).first(where: { $0.emoji == emoji })?.me == true
        // Record the optimistic direction so we can distinguish this device's own
        // gateway echo (swallow it) from the same reaction made on another device
        // (apply it live). The failure revert below is local-only — no server call,
        // no echo — so we do NOT insert a key there.
        let add = !hasMine
        pendingSelfReactionKeys.insert(reactionKey(channelId, message.id, emoji, add: add))
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

    /// Apply a reaction event from the gateway. Our own reaction echoes from THIS
    /// device are swallowed (already applied optimistically); an own-reaction made
    /// on ANOTHER device is applied live with `me` so both the count and the
    /// "reacted by me" highlight update; everyone else's adjusts the count only.
    private func handleReactionEvent(add: Bool, channelId: String, messageId: String, userId: String?, emoji: String) {
        guard channelId == selectedChannel?.id else { return }
        if let userId, userId == currentUserId {
            let key = reactionKey(channelId, messageId, emoji, add: add)
            if pendingSelfReactionKeys.remove(key) != nil { return } // echo of this device's optimistic tap
            // Own reaction from another device: apply live, isMe:true so the
            // highlight (not just the count) updates.
            applyReaction(messageId: messageId, emoji: emoji, delta: add ? 1 : -1, isMe: true)
            return
        }
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
        mutateMessage(at: mi) { $0.reactions = reactions }
    }

    // MARK: Sending

    /// The freshest copy this store holds of `channel`, for deciding HOW to
    /// send to it: encrypted or not, and with which key.
    ///
    /// The send functions are handed the conversation the composer displays,
    /// and that `Channel` is the one its navigation route was pushed with — a
    /// snapshot nothing updates afterwards. An E2EE flip lands only in
    /// `selectedChannel` and `dms` (applyE2EEState, handleChannelUpdate). So
    /// deciding from the snapshot sent in PLAINTEXT right after the user turned
    /// encryption on from DM settings, or the peer turned it on while the chat
    /// was open — and after a re-key or a disable, encrypted under a stale
    /// verifier or refused. WHERE to send (the id) is still the caller's; only
    /// the state comes from here, falling back to the snapshot for a channel
    /// this store doesn't list.
    ///
    /// `dms` is checked BEFORE `selectedChannel`: both take the gateway events,
    /// but only `dms` is replaced by a REST reload (loadDMs on a reconnect's
    /// READY or a foreground), which is how an E2EE change missed while the
    /// socket was down arrives. `selectedChannel` never sees that, so trusting
    /// it first sent in PLAINTEXT to a DM the peer encrypted while this app was
    /// suspended. It stays the fallback for a DM not listed yet; `channels`
    /// covers guild channels. The chat screen's lock gate reads this too.
    func liveCopy(of channel: Channel) -> Channel {
        if let dm = dms.first(where: { $0.id == channel.id }) { return dm }
        if let selected = selectedChannel, selected.id == channel.id { return selected }
        return channels.first(where: { $0.id == channel.id }) ?? channel
    }

    func send(_ raw: String, in channel: Channel) async {
        let content = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        // Target the channel the composer is displaying — NOT selectedChannel,
        // which can be transiently niled by a foreground loadGuilds reselect
        // (see performLoadGuilds). Relying on selectedChannel here silently
        // dropped sends after a resume-from-suspension, with the composer draft
        // already cleared → message vanished with no bubble.
        guard !content.isEmpty else { return }
        noteInteraction()
        let nonce = UUID().uuidString

        // For E2EE DMs, encrypt before sending; remember the plaintext so the
        // optimistic echo renders decrypted immediately. Encrypted or not is
        // the conversation's CURRENT state, not the caller's snapshot (see
        // liveCopy).
        let live = liveCopy(of: channel)
        var wire = content
        if live.isE2EE {
            guard let key = e2eeKey(for: live) else {
                e2eeError = "Unlock this conversation to send."
                return
            }
            guard let enc = E2EE.encrypt(content, key: key) else {
                errorText = "Encryption failed."
                return
            }
            // Ciphertext is ~34% larger than plaintext; reject clearly if it
            // would exceed the server's content cap rather than failing the
            // request with a cryptic length error.
            if enc.count > 4000 {
                errorText = "This message is too long to send in an encrypted DM."
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
            // Land the confirmed message when we're still viewing this channel,
            // OR when selection is momentarily unknown (nil) — the placeholder
            // lives in `messages` for the displayed channel, so replacing it in
            // place is correct. A genuine navigate-away (selectedChannel is a
            // DIFFERENT channel) correctly skips; the gateway echo + loadMessages
            // will surface it on return.
            if selectedChannel == nil || channel.id == selectedChannel?.id {
                decrypted[message.id] = content
                upsert(message)
            }
            // Re-sort this DM to the top of the recency-sorted list IMMEDIATELY
            // off the REST response — don't wait on the gateway echo (~1s later,
            // or absent while the socket is reconnecting / just resumed). Uses
            // the confirmed server snowflake (not the UUID nonce) so the numeric
            // compare works; idempotent + forward-only so the later echo is a
            // no-op. Outside the selection guard: a DM you navigated away from
            // mid-send should still bump.
            bumpChannelLastMessage(channel.id, message.id)
            // Sending is the other half of the Share Suggestions signal (the
            // first is opening). Only the CONVERSATION is donated here — never
            // `content`/`wire`, so an E2EE DM donates exactly what a plaintext
            // one does. Outside the selection guard for the same reason as the
            // bump above.
            donateShareSuggestion(channel)
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
            // Consistency with send()/scheduleMessage(): ciphertext is ~34%
            // larger than plaintext, so reject over-long messages clearly.
            if enc.count > 4000 {
                errorText = "This message is too long to send in an encrypted DM."
                return
            }
            wire = enc
        }
        mutateMessage(at: idx) { $0.sendState = "sending" }
        do {
            let message = try await api.sendMessage(channelId: channel.id, content: wire, nonce: messageId, replyToId: placeholder.replyToId)
            if channel.id == selectedChannel?.id {
                decrypted[message.id] = plaintext
                upsert(message)
            }
            // A retried send that finally lands should also bump the DM to the
            // top immediately (see send()), not wait on the gateway echo.
            bumpChannelLastMessage(channel.id, message.id)
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
            mutateMessage(at: idx) { $0.sendState = "failed" }
        }
    }

    /// The signed-in user as a PublicUser, for authoring optimistic messages.
    private var selfPublicUser: PublicUser? {
        guard let u = currentUser else { return nil }
        return PublicUser(
            id: u.id, username: u.username, displayName: u.displayName,
            avatarUrl: u.avatarUrl, status: u.effectiveStatus ?? u.status, isBot: false,
            customStatus: u.customStatus, customStatusEmoji: u.customStatusEmoji,
            avatarDecoration: u.avatarDecoration
        )
    }

    /// Shared ISO-8601 formatter (default options). Allocating one per call
    /// is needless work on hot paths (isoNow on every send, etc.); AppStore is
    /// @MainActor so single-threaded reuse is safe.
    private static let iso8601 = ISO8601DateFormatter()

    /// Millisecond-precision ISO formatter used ONLY for optimistic-send
    /// timestamps, so a placeholder created in the same second as a server row
    /// still sorts AFTER it (the server emits fractional seconds; a
    /// whole-second placeholder would string-compare as earlier).
    private static let iso8601Millis: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    /// Current time as an ISO-8601 string for optimistic placeholders.
    private func isoNow() -> String {
        Self.iso8601Millis.string(from: Date())
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
                // Decode + resize OFF the main actor — AppStore is @MainActor, so
                // a plain Task would run the download + UIImage decode + render on
                // main and hitch the emoji picker / inline-emoji scroll. Hop back
                // only to store the result.
                let img: UIImage? = await Task.detached(priority: .userInitiated) {
                    let data = try? await URLSession.shared.data(from: url).0
                    return data.flatMap { AppStore.resizedEmoji($0, points: 20) }
                }.value
                self?.emojiInFlight.remove(emoji.id)
                if let img { self?.emojiImages[emoji.id] = img }
            }
        }
        return nil
    }

    /// Downscale raw image data to a square `points`-pt image at screen scale,
    /// so it renders at a sensible size when interpolated inline in `Text`.
    nonisolated static func resizedEmoji(_ data: Data, points: CGFloat) -> UIImage? {
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
        let iso = Self.iso8601.string(from: date)
        var wireContent = content
        if channel.isE2EE {
            // Pre-encrypt: the server stores + fires the ciphertext verbatim
            // (it never needs the plaintext) and the recipient decrypts on
            // receipt like any encrypted message. Requires the conversation key.
            guard let key = e2eeKey(for: channel), let enc = E2EE.encrypt(content, key: key) else {
                return "Unlock this conversation to schedule encrypted messages."
            }
            // Ciphertext is ~34% larger than plaintext; reject clearly here if
            // it would exceed the server's content cap rather than failing the
            // request with a cryptic length error.
            if enc.count > 4000 {
                return "This message is too long to schedule in an encrypted DM."
            }
            wireContent = enc
        }
        do {
            let sm = try await api.scheduleMessage(channelId: channel.id, content: wireContent, scheduledFor: iso)
            scheduledMessages.append(sm)
            scheduledMessages.sort { $0.scheduledFor < $1.scheduledFor }
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }
    func cancelScheduled(_ sm: ScheduledMessage) async {
        do { try await api.cancelScheduledMessage(id: sm.id); scheduledMessages.removeAll { $0.id == sm.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// Display text for a scheduled message in the sender's pending list.
    /// E2EE scheduled messages are stored as ciphertext; decrypt with the
    /// conversation key when available, else show a lock note.
    func scheduledDisplayContent(_ sm: ScheduledMessage) -> String {
        guard let content = sm.content, !content.isEmpty else { return "" }
        guard content.hasPrefix(E2EE.wirePrefixV3) else { return content }
        // A DM normally lives in `dms`, but search both lists and use whichever
        // candidate yields a working key (avoids picking a keyless duplicate).
        let candidates = channels.filter { $0.id == sm.channelId } + dms.filter { $0.id == sm.channelId }
        for channel in candidates {
            if let key = e2eeKey(for: channel), let plain = E2EE.decrypt(content, key: key) {
                return plain
            }
        }
        return "🔒 Encrypted — unlock this conversation to preview"
    }

    // MARK: Channel permission overrides

    func loadChannelOverrides(_ channelId: String) async {
        loadingOverrides = true
        defer { loadingOverrides = false }
        do { channelOverrides = try await api.listChannelOverrides(channelId: channelId) }
        catch { channelOverrides = [] }
    }
    func saveChannelOverride(channelId: String, targetId: String, type: String = "role", allow: UInt64, deny: UInt64) async -> String? {
        do {
            try await api.putChannelOverride(
                channelId: channelId, targetId: targetId, type: type,
                allow: Permissions.serialize(allow), deny: Permissions.serialize(deny)
            )
            await loadChannelOverrides(channelId)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// Remove a channel/category permission override (role or member).
    func deleteChannelOverride(channelId: String, targetId: String, type: String) async -> String? {
        do {
            try await api.deleteChannelOverride(channelId: channelId, targetId: targetId, type: type)
            await loadChannelOverrides(channelId)
            return nil
        } catch { return (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// Send one or more picked photos/videos/files as a SINGLE message (the server
    /// accepts up to 10 attachments). In an E2EE DM every attachment is
    /// encrypted with the channel key (.zke suffix) so the server only ever
    /// sees ciphertext — same scheme as the message text.
    /// Returns true on a successful send. The composer uses this to restore
    /// the picked attachments if the upload fails, so the user can retry
    /// without re-selecting everything.
    ///
    /// `channel` is the conversation the composer is DISPLAYING, exactly as in
    /// `send(_:in:)`. This used to read `selectedChannel`, which can be nil
    /// while a chat is still on screen (a foreground reselect — see the note
    /// in send(_:in:)). The send then returned false with no error, so the
    /// composer quietly put the picks back and nothing was uploaded — while
    /// text in the same chat still sent.
    @discardableResult
    func sendAttachments(
        _ attachments: [(data: Data, filename: String, contentType: String)],
        caption: String,
        in channel: Channel
    ) async -> Bool {
        guard !attachments.isEmpty else { return false }
        let nonce = UUID().uuidString
        // The reply showing when Send was tapped. Text can be sent while this
        // upload runs, and that send takes (and clears) `replyingTo` or the
        // user picks a new one for it, so don't read it again later.
        let sentReplyId = replyingTo?.id
        activeUploads += 1
        defer { activeUploads -= 1 }

        // STEP 1 — shrink the media BEFORE anything else touches it, and in
        // particular before encryption. Once a blob is encrypted it is opaque
        // `application/octet-stream` to the server, which skips both the WebP
        // backstop and the nightly compression sweep, and has no key anyway —
        // so this is the ONLY moment an E2EE photo/video can be made smaller.
        // See MediaPrep for the measured 37x gap this closes.
        //
        // Detached so a 1920px re-encode (and especially a 720p video export)
        // never runs on the main actor; `uploading` is already true, so the
        // composer shows its spinner for the duration.
        let inputs = attachments.map {
            MediaPrep.Input(data: $0.data, filename: $0.filename, contentType: $0.contentType)
        }
        let prepared = await Task.detached(priority: .userInitiated) {
            await MediaPrep.prepareAll(inputs)
        }.value
        for item in prepared {
            if item.videoExportFailed {
                // Non-fatal by design: the original goes up rather than
                // blocking the send. Logged so an oversized upload can be
                // explained after the fact.
                mediaLog.notice("video export failed, uploading original (\(item.originalBytes, privacy: .public) bytes)")
            } else if item.data.count != item.originalBytes {
                mediaLog.info("prepared \(item.originalBytes, privacy: .public) -> \(item.data.count, privacy: .public) bytes")
            }
        }

        do {
            var files: [UploadFile] = []
            var wireCaption = caption
            // Encrypt or not by the conversation's state NOW — after the prep
            // above, which can take a while for a video — and never by the
            // route's snapshot in `channel` (see liveCopy).
            let live = liveCopy(of: channel)
            if live.isE2EE {
                guard let key = e2eeKey(for: live) else {
                    e2eeError = "Unlock this conversation to send."
                    return false
                }
                for att in prepared {
                    // A THUMBNAIL IS MANDATORY for an E2EE image. The server
                    // cannot generate one (it only ever sees ciphertext), so if
                    // the client doesn't ship one this attachment is stored as a
                    // preview-less original forever — which is what left 90 of
                    // the 268 E2EE images on the live server unreapable and
                    // unpreviewable. This used to be best-effort and silent.
                    // Failing the send loudly is the lesser harm: the composer
                    // restores the picks on `false`, so the user just retries.
                    var thumbData: Data?
                    if att.isImage {
                        guard let plainThumb = att.thumbnail else {
                            errorText = "Couldn't build a preview for \(att.filename), so it wasn't sent. Try again, or pick a different photo."
                            return false
                        }
                        guard let encThumb = E2EE.encryptData(plainThumb, key: key) else {
                            errorText = "Encryption failed."
                            return false
                        }
                        thumbData = encThumb
                    }
                    guard let enc = E2EE.encryptData(att.data, key: key) else {
                        errorText = "Encryption failed."
                        return false
                    }
                    // Pixel dims (images only), sent as plaintext metadata so the
                    // recipient reserves the slot before decrypt — the server
                    // can't measure the ciphertext. Dims aren't sensitive (same
                    // as the plaintext voice duration/waveform). They describe
                    // the POST-downscale bytes, EXIF-corrected.
                    files.append(UploadFile(
                        data: enc,
                        filename: att.filename + ".zke",
                        contentType: "application/octet-stream",
                        width: att.width, height: att.height, thumbData: thumbData
                    ))
                }
                if !caption.isEmpty {
                    guard let encCaption = E2EE.encrypt(caption, key: key) else {
                        errorText = "Encryption failed."
                        return false
                    }
                    wireCaption = encCaption
                }
            } else {
                // The plain path already had a server-side backstop, but doing
                // it here too is what the server asks for ("clients are expected
                // to compress + convert before upload" — services/uploads.ts)
                // and it saves the same bytes on the way UP. The server still
                // generates the thumbnail for non-E2EE uploads.
                files = prepared.map {
                    UploadFile(data: $0.data, filename: $0.filename, contentType: $0.contentType)
                }
            }
            let message = try await api.sendMessageMultipart(
                channelId: channel.id, content: wireCaption, nonce: nonce, files: files, replyToId: sentReplyId
            )
            // Same landing rule as send(_:in:): still viewing this channel, or
            // selection momentarily unknown (nil) while its chat is on screen.
            if selectedChannel == nil || channel.id == selectedChannel?.id {
                upsert(message)
                if live.isE2EE, !caption.isEmpty { decrypted[message.id] = caption }
                // Only the reply this send carried: not one picked meanwhile.
                if replyingTo?.id == sentReplyId { replyingTo = nil }
            }
            return true
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
            return false
        }
    }

    /// Fetch + decrypt an encrypted attachment (.zke) with the channel key.
    /// Returns nil when the key isn't unlocked or the blob doesn't verify.
    func decryptedAttachmentData(_ attachment: Attachment, in channel: Channel) async -> Data? {
        // Return cached plaintext if we've already decrypted this attachment this
        // session — avoids re-fetching the .zke blob and re-running crypto every
        // time the row reappears. The cache is cleared on relock/sign-out, so a
        // hit always means the conversation is still unlocked.
        if let cached = cachedMedia(attachment.id) {
            return cached
        }
        guard channel.isE2EE, let key = e2eeKey(for: channel),
              let url = assetURL(attachment.url) else { return nil }
        guard let (blob, _) = try? await URLSession.shared.data(from: url) else { return nil }
        // AES-GCM open over the whole (multi-MB) blob runs OFF the main actor so
        // it doesn't jank scroll the moment an encrypted photo realizes — the
        // PBKDF2 path already hops off-main the same way (deriveKeyOffMain).
        let plain = await Task.detached(priority: .userInitiated) {
            E2EE.decryptData(blob, key: key)
        }.value
        guard let plain else { return nil }
        // Don't cache stale plaintext if the conversation was relocked while we
        // were off-main.
        guard e2eeKey(for: channel) != nil else { return nil }
        cacheMedia(attachment.id, plain)
        return plain
    }

    /// Fetch + decrypt the SMALL encrypted thumbnail (.zke) for an attachment.
    /// Inline views show this instead of the full blob — far fewer bytes to
    /// download + decrypt — while the lightbox / Save still use
    /// decryptedAttachmentData (full resolution). Cached under a distinct
    /// ":thumb" key so it never collides with the full image. Returns nil when
    /// there's no thumbnail (old messages) — callers fall back to the full blob.
    func decryptedThumbnailData(_ attachment: Attachment, in channel: Channel) async -> Data? {
        guard let thumbURL = attachment.thumbnailUrl else { return nil }
        let cacheKey = attachment.id + ":thumb"
        if let cached = cachedMedia(cacheKey) { return cached }
        guard channel.isE2EE, let key = e2eeKey(for: channel),
              let url = assetURL(thumbURL) else { return nil }
        guard let (blob, _) = try? await URLSession.shared.data(from: url) else { return nil }
        let plain = await Task.detached(priority: .userInitiated) {
            E2EE.decryptData(blob, key: key)
        }.value
        guard let plain, e2eeKey(for: channel) != nil else { return nil }
        cacheMedia(cacheKey, plain)
        return plain
    }

    /// LRU read: returns the cached plaintext for an attachment and marks it
    /// most-recently-used, or nil on a miss.
    private func cachedMedia(_ id: String) -> Data? {
        guard let data = decryptedMedia[id] else { return nil }
        if let i = decryptedMediaLRU.firstIndex(of: id) {
            decryptedMediaLRU.remove(at: i)
            decryptedMediaLRU.append(id)
        }
        return data
    }

    /// LRU write: stores plaintext, then evicts the least-recently-used entries
    /// until back within the count/byte budget (never evicting the just-stored
    /// one). No eviction happens on memory pressure — only on budget overflow.
    private func cacheMedia(_ id: String, _ data: Data) {
        if let existing = decryptedMedia[id] {
            decryptedMediaBytes -= existing.count
            if let i = decryptedMediaLRU.firstIndex(of: id) { decryptedMediaLRU.remove(at: i) }
        }
        decryptedMedia[id] = data
        decryptedMediaLRU.append(id)
        decryptedMediaBytes += data.count
        while (decryptedMediaBytes > decryptedMediaMaxBytes || decryptedMedia.count > decryptedMediaMaxCount),
              decryptedMediaLRU.count > 1 {
            let evict = decryptedMediaLRU.removeFirst()
            if let removed = decryptedMedia.removeValue(forKey: evict) {
                decryptedMediaBytes -= removed.count
            }
        }
    }

    /// Drop all decrypted plaintext (relock / sign-out): plaintext must not
    /// outlive the key.
    private func clearDecryptedMedia() {
        decryptedMedia = [:]
        decryptedMediaLRU = []
        decryptedMediaBytes = 0
        // Decoded E2EE thumbnail bitmaps are plaintext pixels too — drop them on
        // relock/sign-out so they never outlive the key.
        EncryptedThumbCache.clear()
        // Link-preview embeds resolved from decrypted E2EE plaintext are also
        // derived plaintext — drop them (and the in-flight set) too.
        e2eeEmbeds = [:]
        e2eeEmbedResolving = []
    }

    /// Send a recorded voice message: the audio file plus its duration and
    /// waveform. In E2EE DMs the audio is encrypted (.zke) like any other
    /// attachment; the duration + waveform stay plaintext metadata (no
    /// content leak) so the player can draw the bars before decrypting.
    /// `channel` is the conversation on screen — see sendAttachments for why
    /// not `selectedChannel` (a nil selection silently dropped the recording).
    func sendVoiceMessage(fileURL: URL, duration: Int, waveform: String, in channel: Channel) async {
        // The recording is a temp file from VoiceRecorder — remove it once we've
        // read + uploaded it (on every path) so recordings don't pile up in tmp.
        defer { try? FileManager.default.removeItem(at: fileURL) }
        guard let data = try? Data(contentsOf: fileURL) else { errorText = "Couldn't read recording."; return }
        let nonce = UUID().uuidString
        // Read once, as in sendAttachments: text can be sent during the upload.
        let sentReplyId = replyingTo?.id
        activeUploads += 1
        defer { activeUploads -= 1 }
        do {
            var sendData = data
            var sendName = "voice-message.m4a"
            var sendType = "audio/mp4"
            // The conversation's current E2EE state, not the snapshot (see
            // liveCopy).
            let live = liveCopy(of: channel)
            if live.isE2EE {
                guard let key = e2eeKey(for: live), let enc = E2EE.encryptData(data, key: key) else {
                    e2eeError = "Unlock this conversation to send."
                    return
                }
                sendData = enc
                sendName = "voice-message.m4a.zke"
                sendType = "application/octet-stream"
            }
            let file = UploadFile(data: sendData, filename: sendName, contentType: sendType)
            let message = try await api.sendMessageMultipart(
                channelId: channel.id, content: "", nonce: nonce, files: [file],
                replyToId: sentReplyId,
                voiceMessage: ["durationSeconds": duration, "waveform": waveform]
            )
            if selectedChannel == nil || channel.id == selectedChannel?.id {
                upsert(message)
                if replyingTo?.id == sentReplyId { replyingTo = nil }
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

    /// Persist the open channel's current rows so reopening it paints instantly.
    /// Caches only server-confirmed rows (drops optimistic placeholders, whose
    /// ids are send-nonces) so a sending/failed message can't resurrect on reopen.
    ///
    /// Only the newest page (50 rows) is kept. On reopen loadMessages replaces
    /// the seed with the server's latest 50 a moment later and drops every
    /// older seed row anyway, so caching paged-in history only meant painting
    /// a much taller list first and then deleting a block of it above the
    /// viewport while the open was still settling.
    private func snapshotCurrentChannel() {
        guard let id = selectedChannel?.id, !messages.isEmpty else { return }
        let confirmed = messages.filter { $0.sendState == nil }
        if !confirmed.isEmpty {
            messageCache[id] = Array(confirmed.suffix(Self.messageCachePageSize))
            touchMessageCache(id)
        }
    }

    /// Rows kept per cached conversation: one server page.
    private static let messageCachePageSize = 50

    /// Mark a channel most-recently-used and evict the least-recently-used
    /// channels once the cache exceeds its budget (never the selected one).
    private func touchMessageCache(_ id: String) {
        if let i = messageCacheLRU.firstIndex(of: id) { messageCacheLRU.remove(at: i) }
        messageCacheLRU.append(id)
        while messageCacheLRU.count > messageCacheMax {
            guard let victim = messageCacheLRU.first(where: { $0 != selectedChannel?.id }) else { break }
            messageCacheLRU.removeAll { $0 == victim }
            messageCache.removeValue(forKey: victim)
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
                mutateMessage(at: mi) { $0.poll = p }
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
        // The software keyboard lives in its own window, out of reach of the
        // app-window touch watcher — typing must keep this device active.
        // (Already throttled by the composer.)
        noteInteraction(evaluate: false)
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
        let presenceBefore = presenceSnapshot()
        do {
            let fetched = try await api.listRelationships()
            relationships = fetched
            // Friends render off the presence map like every other surface, and
            // a friend who shares no guild and no DM appears in NO other REST
            // snapshot — so without this seed the map holds nothing for them and
            // their row drew no dot AT ALL, while `rel.user.status` in the very
            // same struct said "online". (Android: AppStore.kt loadRelationships.)
            seedPresence(fetched.map { $0.user }, before: presenceBefore)
        } catch {
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    // MARK: Personal DM nicknames

    func loadDmNicknames() async {
        if let map = try? await api.getDmNicknames() { dmNicknames = map }
    }

    /// The viewer's personal nickname for a user (non-empty), or nil.
    func dmNickname(_ userId: String?) -> String? {
        guard let userId, let n = dmNicknames[userId], !n.isEmpty else { return nil }
        return n
    }

    /// Nickname-aware DM title: the peer's nickname for a 1:1 DM if set, else
    /// the channel's normal dmTitle. Use everywhere a DM peer's name shows.
    func dmDisplayTitle(_ channel: Channel) -> String {
        if channel.isDM, let peer = channel.recipients?.first, let n = dmNickname(peer.id) {
            return n
        }
        return channel.dmTitle
    }

    /// Set (non-empty) or clear (nil/empty) the personal DM nickname for a user.
    /// Optimistic; reverts on failure. Returns nil on success or an error string.
    func setDmNickname(userId: String, to nickname: String?) async -> String? {
        let trimmed = nickname?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let prev = dmNicknames[userId]
        if trimmed.isEmpty { dmNicknames[userId] = nil } else { dmNicknames[userId] = trimmed }
        do {
            if trimmed.isEmpty {
                try await api.clearDmNickname(userId: userId)
            } else {
                try await api.setDmNickname(userId: userId, nickname: trimmed)
            }
            return nil
        } catch {
            dmNicknames[userId] = prev  // revert
            return (error as? APIError)?.message ?? error.localizedDescription
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
            // Blocking doesn't close the DM, so its Share Suggestion would
            // otherwise keep offering the blocked person's name and face in
            // every other app's share sheet. Revoke it. 1:1 only — a group DM is
            // still a live conversation for everyone else in it.
            for dm in dms where dm.type == "dm"
                && (dm.recipients ?? []).contains(where: { $0.id == user.id }) {
                ShareSuggestions.deleteConversation(dm.id)
            }
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

    /// Dismiss one mention from the inbox. Optimistic with rollback.
    func deleteMention(_ id: String) async {
        let prev = mentions
        mentions.removeAll { $0.id == id }
        do { try await api.deleteMention(messageId: id) }
        catch {
            mentions = prev
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Clear every mention from the inbox. Optimistic with rollback.
    func clearMentions() async {
        let prev = mentions
        mentions = []
        do { try await api.clearMentions() }
        catch {
            mentions = prev
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Hydrate the user's notification mute levels (rail menu shows Mute vs
    /// Unmute). Best-effort — a failure just leaves the menu defaulting to Mute.
    func loadNotificationOverrides() async {
        guard let rows = try? await api.notificationOverrides() else { return }
        var map: [String: String] = [:]
        // Key by "type:id" so a channel override and its guild override can
        // coexist and resolve in channel>guild order (a bare-id key aliased
        // them and couldn't express precedence).
        for r in rows { if let lvl = r.level { map["\(r.targetType):\(r.targetId)"] = lvl } }
        notificationOverrides = map
    }

    func isGuildMuted(_ guildId: String) -> Bool {
        notificationOverrides["guild:\(guildId)"] == "nothing"
    }

    /// Mute/unmute a whole guild. Optimistic local update + PUT; the server's
    /// push fan-out honors the override immediately.
    func setGuildMuted(_ guildId: String, _ muted: Bool) async {
        let key = "guild:\(guildId)"
        let prev = notificationOverrides[key]
        if muted { notificationOverrides[key] = "nothing" }
        else { notificationOverrides.removeValue(forKey: key) }
        do {
            try await api.setNotificationOverride(
                targetType: "guild", targetId: guildId, level: muted ? "nothing" : nil)
        } catch {
            // Roll back on failure.
            if let prev { notificationOverrides[key] = prev }
            else { notificationOverrides.removeValue(forKey: key) }
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }

    }

    /// Effective notification level for a channel: explicit channel override,
    /// else the guild override, else "all" (mirrors the server + web).
    func channelLevel(_ channelId: String, guildId: String?) -> String {
        if let ch = notificationOverrides["channel:\(channelId)"] { return ch }
        if let gid = guildId, let g = notificationOverrides["guild:\(gid)"] { return g }
        return "all"
    }

    /// Set this channel's notification level (all/mentions/nothing) — a personal
    /// setting independent of the guild. "all" = server notifications (the
    /// explicit opt-in the push fan-out honors); "nothing" = mute. Optimistic
    /// local update + PUT, with rollback on failure.
    func setChannelLevel(_ channelId: String, _ level: String) async {
        let key = "channel:\(channelId)"
        let prev = notificationOverrides[key]
        notificationOverrides[key] = level
        do {
            try await api.setNotificationOverride(
                targetType: "channel", targetId: channelId, level: level)
        } catch {
            if let prev { notificationOverrides[key] = prev }
            else { notificationOverrides.removeValue(forKey: key) }
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }

    /// Mark every channel in a guild read (rail long-press). Applies the
    /// server's returned read markers locally so unread dots + mention badges
    /// clear without a refetch, then refreshes the app badge.
    func markGuildRead(_ guildId: String) async {
        guard let updated = try? await api.markGuildRead(guildId: guildId) else { return }
        for rs in updated { readStates[rs.channelId] = rs }
        updateAppBadge()
    }

    /// Poke/nudge the other party in a DM. The poke comes back over the
    /// gateway as a system message (rendered in-chat + buzzes them), so we
    /// just fire-and-forget the request and surface any error.
    func poke(_ channel: Channel, variant: PokeVariant) async {
        do { try await api.poke(channelId: channel.id, pokeType: variant.rawValue) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }

    /// Recent pokes received on this DM (max 6), for the poke history popover.
    func pokeHistory(_ channel: Channel) async -> [PokeHistoryEntry] {
        (try? await api.listPokes(channelId: channel.id)) ?? []
    }


    /// Best-effort navigation to a mention's channel (works when it's already
    /// loaded among the current guild's channels or the DM list).
    func openMention(_ mention: Mention) {
        guard let ch = channels.first(where: { $0.id == mention.channelId })
            ?? dms.first(where: { $0.id == mention.channelId }) else { return }
        // The mention's channel can still be SELECTED without its message list
        // being on screen: opening Mentions resets the stack but keeps
        // selectedChannel. Then nothing would navigate, and the anchor set
        // below would sit unconsumed (the list's onChange never sees it), so
        // close it and take the full open path below instead — the same one a
        // mention in another channel takes.
        if selectedChannel?.id == ch.id, !isShowingMessages(of: ch) {
            leaveOpenConversation()
        }
        if selectedChannel?.id == ch.id {
            if messages.contains(where: { $0.id == mention.id }) {
                // Already loaded — just scroll to it.
                pendingScrollAnchorId = mention.id
            } else {
                // Same channel but the mention is outside the loaded window —
                // fetch a window AROUND it, then scroll. Drive loadMessages
                // directly: selectChannel/openChannel is id-guarded and would
                // NOT reload the already-open channel (leaving a silent no-op).
                // loadMessages consumes pendingJumpMessageId as the `around:`
                // cursor and sets pendingScrollAnchorId once merged.
                pendingJumpMessageId = mention.id
                Task { await loadMessages(ch) }
            }
        } else {
            // Land ON the mentioned message: load a window around it, then scroll.
            pendingJumpMessageId = mention.id
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
        let trimmed = code.trimmingCharacters(in: .whitespacesAndNewlines)
        // Any server's invite link: keep whatever follows "/invite/".
        if let r = trimmed.range(of: "/invite/") {
            return String(trimmed[r.upperBound...]).trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        }
        return trimmed
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
    /// Patch one row of the admin user list in place. Internal (not private) so
    /// the Account Info page can keep the list in step with what it just did.
    func patchAdminUser(_ id: String, _ mutate: (inout AdminUser) -> Void) {
        if let i = adminUsers.firstIndex(where: { $0.id == id }) { mutate(&adminUsers[i]) }
    }
    /// Ban for a duration ("1m"|"3m"|"6m"|"perm"). Covers text + voice.
    func adminBan(_ u: AdminUser, duration: String = "perm") async {
        do {
            try await api.adminBanUser(userId: u.id, duration: duration)
            let months = duration == "1m" ? 1 : duration == "3m" ? 3 : duration == "6m" ? 6 : 0
            let until = months > 0
                ? Self.iso8601.string(from: Date().addingTimeInterval(Double(months) * 30 * 86_400))
                : nil
            patchAdminUser(u.id) {
                $0.bannedAt = Self.iso8601.string(from: Date())
                $0.bannedUntil = until
            }
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func adminUnban(_ u: AdminUser) async {
        do {
            try await api.adminUnbanUser(userId: u.id)
            patchAdminUser(u.id) { $0.bannedAt = nil; $0.bannedUntil = nil }
        }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    /// Set an instance role: "administrator" | "moderator" | "none". The two
    /// flags are mutually exclusive (mirrors the server).
    func adminSetRole(_ u: AdminUser, role: String) async {
        do {
            try await api.adminSetRole(userId: u.id, role: role)
            patchAdminUser(u.id) {
                $0.isAdmin = role == "administrator"
                $0.isModerator = role == "moderator"
            }
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func adminLogout(_ u: AdminUser) async {
        do { try await api.adminLogoutUser(userId: u.id) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    func adminDeleteUser(_ u: AdminUser) async {
        do { try await api.adminDeleteUser(userId: u.id); adminUsers.removeAll { $0.id == u.id } }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    /// Reopen the user's one-time DOB change.
    func adminResetDob(_ u: AdminUser) async {
        do { try await api.adminResetDobLock(userId: u.id) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    /// Give a perk tier ("scout"|"guardian"|"legend" × "1m"|"3m"|"6m"|"forever").
    func adminGift(_ u: AdminUser, tier: String, duration: String) async {
        do {
            try await api.adminGiftSubscription(userId: u.id, tier: tier, duration: duration)
            patchAdminUser(u.id) { $0.subscriptionTier = tier }
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
    }
    /// Remove a user's perk tier (cosmetics are free, so nothing else changes).
    func adminRemoveMembership(_ u: AdminUser) async {
        do {
            try await api.adminRemoveSubscription(userId: u.id)
            patchAdminUser(u.id) { $0.subscriptionTier = nil }
        } catch { errorText = (error as? APIError)?.message ?? error.localizedDescription }
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
        // Supervision can revoke DMs at any time (a parent flips a switch, the
        // grace period lapses into restricted-heavily), and anything donated
        // while messaging was allowed is still sitting in the SYSTEM share
        // sheet. This withdraws it whenever loadFamily() comes back denying
        // DMs: at sign-in / cold `start()`, when the Parental Controls screen
        // appears, after this device requests/accepts/removes a family link,
        // on FAMILY_REQUEST_CREATE / FAMILY_FLAG_CREATE, and — the case that
        // matters for latency — on FAMILY_SUPERVISION_UPDATE, which the server
        // pushes to the subject after ANY write that changes what they may do.
        // That last one is unconditional (it does not require `family` to
        // already be loaded), so a parent revoking DMs mid-session withdraws
        // the donations on this device within a round-trip, not at the child's
        // next launch. If the connection is down, the wipe still lands on the
        // next loadFamily() above.
        if !shareSuggestionsAllowed { ShareSuggestions.deleteAll() }
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
    /// Child invites a guardian by email. Returns a user-facing status string
    /// ("pending" | "awaiting_signup") on success, nil on error.
    func familyRequestParent(email: String) async -> String? {
        let e = email.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !e.isEmpty else { return nil }
        do { let status = try await api.familyRequestParent(email: e); await loadFamily(); return status }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription; return nil }
    }
    func familyAcceptChild(_ user: FamilyUser) async {
        do { try await api.familyAcceptChildRequest(childId: user.id); await loadFamily() }
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
        // Snapshot BEFORE the fetch suspends. This used to be missing: the old
        // inline seed claimed "same rule as loadDMs" in its comment but had no
        // `presenceBefore`, so it applied the pre-flip REST baseline
        // unconditionally and CLOBBERED any PRESENCE_UPDATE that landed during
        // the in-flight listMembers — a window the 200 ms presence coalescing
        // debounce actively widens.
        let presenceBefore = presenceSnapshot()
        do {
            let list = try await api.listMembers(guildId: guild.id)
            var map: [String: GuildMember] = [:]
            for m in list { map[m.userId] = m }
            members = map
            seedPresence(list.map { $0.user }, before: presenceBefore)
        } catch {
            // Non-fatal — names just fall back to a generic label.
        }
    }

    /// Display name for a user id from the loaded guild members, or nil if we
    /// don't have them. (Server nicknames were removed — DM nicknames are
    /// resolved separately via dmNickname.)
    func memberName(_ userId: String) -> String? {
        guard let m = members[userId] else { return nil }
        return m.user.name
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
    /// MANAGE_INVITES (bit 22) — list + revoke a guild's invites. Distinct from
    /// CREATE_INVITE (bit 11, which only lets you mint one). Owner short-circuits.
    var canManageInvites: Bool {
        guard let g = selectedGuild, !isViewingDM else { return false }
        if g.ownerId == currentUserId { return true }
        return iHavePermission(Permissions.MANAGE_INVITES)
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
            ? Self.iso8601.string(from: Date().addingTimeInterval(Double(minutes) * 60))
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
    /// Persist the per-user DM read-receipts preference (mirrors web's
    /// ReadReceiptsToggle). Optimistic: the caller flips
    /// currentUser?.dmReadReceiptsEnabled first; on failure we roll back to
    /// `fallback`, on success we adopt the canonical server response.
    func persistDmReadReceiptsEnabled(_ value: Bool, fallback: Bool?) async {
        do { currentUser = try await api.updateProfile(["dmReadReceiptsEnabled": value]) }
        catch {
            currentUser?.dmReadReceiptsEnabled = fallback
            errorText = (error as? APIError)?.message ?? error.localizedDescription
        }
    }
    func closeDM(_ channel: Channel) async {
        do {
            try await api.closeDM(channelId: channel.id)
            dms.removeAll { $0.id == channel.id }
            // Revoke the share-sheet suggestion with it — a closed conversation
            // that keeps offering itself as a share target in other apps is a
            // leak of a contact the user just removed.
            ShareSuggestions.deleteConversation(channel.id)
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
    /// Fetch the selected guild's invites for the management view. Returns nil
    /// on failure (the view shows a retry); empty array is a valid "none yet".
    func listGuildInvites() async -> [Invite]? {
        guard let g = selectedGuild else { return nil }
        do { return try await api.listGuildInvites(guildId: g.id) }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription; return nil }
    }
    func revokeInvite(_ code: String) async -> Bool {
        do { try await api.revokeInvite(code: code); return true }
        catch { errorText = (error as? APIError)?.message ?? error.localizedDescription; return false }
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

    /// Purge (soft-delete) every message in a text channel/thread. Loops the
    /// endpoint until the server reports done (each call caps at 1000 rows).
    /// Returns (totalDeleted, nil) on success or (nil, errorMessage). The
    /// server's MESSAGE_DELETE_BULK clears the open view and CHANNEL_UPDATE
    /// refreshes the sidebar/unread, so no manual cleanup is needed here.
    func purgeChannel(_ channel: Channel) async -> (Int?, String?) {
        do {
            var total = 0
            for _ in 0..<50 {
                let r = try await api.purgeChannel(channelId: channel.id)
                total += r.deleted
                if r.done { break }
            }
            return (total, nil)
        } catch {
            return (nil, (error as? APIError)?.message ?? error.localizedDescription)
        }
    }

    // MARK: Roles

    func loadRoles(_ guild: Guild) async {
        do { roles = try await api.listRoles(guildId: guild.id) }
        catch { roles = [] }
    }

    func color(fromRGB rgb: Int) -> Color {
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

    /// The raw RGB Int a member's name should paint in (the same role pick as
    /// `memberColor`), or nil for none. Value-type message rows snapshot this
    /// Int — not a `Color` — into their Equatable data, because SwiftUI's
    /// synthesized `Color` equality isn't a reliable change signal; the Int is
    /// resolved back via `color(fromRGB:)` at render. See MessageRowData.
    func memberColorRGB(_ userId: String) -> Int? {
        guard let rids = members[userId]?.roleIds, !rids.isEmpty else { return nil }
        let assigned = Set(rids)
        var best: Role?
        for r in roles {
            if r.id == selectedGuild?.id { continue }
            guard assigned.contains(r.id), r.color != 0 else { continue }
            if best == nil || r.position > best!.position { best = r }
        }
        return best?.color
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
        let iso = Self.iso8601
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
        let iso = Self.iso8601
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
        let presenceBefore = presenceSnapshot()
        do {
            let fetched = try await api.listEventAttendees(guildId: g.id, eventId: event.id, status: status)
            eventAttendees = fetched
            // Attendee rows draw a dot from the map like everything else; an
            // attendee we've never otherwise loaded had no entry at all.
            seedPresence(fetched.map { $0.user }, before: presenceBefore)
        }
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
    func jumpToDM(_ dm: Channel) {
        // Already reading this DM (a poke banner from the person you're talking
        // to, their widget, sharing to them): stay put and top it up. Going
        // through showDMs() + selectChannel() pops and re-pushes the SAME route
        // ("m-<id>-1"), so the page is not remounted and openChannel never runs
        // — and showDMs would have just closed the conversation, leaving an
        // empty, dead chat. Same shape as openFromPush's alreadyOpen path.
        if selectedChannel?.id == dm.id, case .messages(let open)? = stack.last, open.id == dm.id {
            showDMs(preservingSelection: true)
            clearPokePill(dm.id)
            pendingJumpMessageId = nil
            Task { await refreshOpenChannelLatest() }
            return
        }
        showDMs()
        selectChannel(dm)
    }

    // MARK: Profile cards

    func openProfile(_ user: PublicUser) {
        profileUser = user
        // Fill a HOLE in the presence map, nothing more. The card resolves its
        // dot through `status(for:)` like every other surface now, and
        // `openProfile(byId:)` can hand us someone who appears in no other
        // snapshot (a mention chip for a non-member). Deliberately never
        // OVERWRITES an existing entry: this `user` may be a struct the caller
        // has been holding since it was rendered, and letting a stale embedded
        // status win over live presence is exactly the split-brain the
        // `fallback:` parameter used to cause.
        if user.id != currentUserId, presence[user.id] == nil, let s = user.status {
            presence[user.id] = s
        }
    }
    /// Open a profile from a mention id. Guild members resolve instantly from
    /// the cached member list; anyone else (e.g. the other person in a DM) is
    /// fetched. Used by tappable @user mention chips.
    func openProfile(byId userId: String) {
        if let u = memberUser(userId) { openProfile(u); return }
        Task {
            if let u = try? await api.getUserProfile(userId: userId) { openProfile(u) }
        }
    }

    /// RE-ENTRANCY GUARD for every lightbox opener. `.fullScreenCover(item:)`
    /// re-presents whenever the item's identity changes, so a second open while
    /// one is already up (double-tap, or two async opens both completing) made
    /// the viewer flicker/stack — dismissing one revealed another. A lightbox is
    /// full-screen, so there's never a legitimate reason to open a second one
    /// on top; ignore the extra open. Dismissal sets `lightbox = nil`, which
    /// re-arms this.
    private var lightboxIsUp: Bool { lightbox != nil }

    func openLightbox(_ url: URL) {
        guard !lightboxIsUp else { return }
        lightbox = LightboxImage(url: url)
    }
    /// Open the viewer on a SET of images (a message's gallery), paged from
    /// startIndex — swipe left/right between them.
    func openLightbox(items: [LightboxItem], startIndex: Int) {
        guard !items.isEmpty, !lightboxIsUp else { return }
        lightbox = LightboxImage(items: items, startIndex: startIndex)
    }

    /// Open the paged lightbox across a message's photos — handling BOTH plain
    /// (by URL) and encrypted (decrypted to an in-memory image) — starting on
    /// the tapped one. Encrypted decryption is cached, so repeat opens are fast.
    func openImageLightbox(images: [Attachment], tapped: String, in channel: Channel) async {
        var items: [LightboxItem] = []
        var startIndex = 0
        for att in images {
            let item: LightboxItem?
            if channel.isE2EE, att.filename?.hasSuffix(".zke") == true {
                // Carry a LAZY encrypted reference — the visible LightboxPage
                // decrypts + downsamples on-appear, so only the current/adjacent
                // pages decrypt (not the whole message's photo set up front). The
                // decrypt cache dedups repeat access. Mirrors the gallery
                // lightbox (MessageViews.openGalleryLightbox).
                item = LightboxItem(encrypted: (att, channel))
            } else if let url = assetURL(att.url) {
                item = LightboxItem(url: url)
            } else {
                item = nil
            }
            if let item {
                if att.id == tapped { startIndex = items.count }
                items.append(item)
            }
        }
        // Route through the guarded setter so a double-tap (two Tasks) can't
        // present two stacked lightboxes.
        openLightbox(items: items, startIndex: startIndex)
    }

    /// Save every photo/video in a message to the Photos library; returns how
    /// many were saved. Handles encrypted photos (decrypt then save) too.
    func saveMediaToPhotos(_ media: [Attachment], in channel: Channel) async -> Int {
        var saved = 0
        for att in media {
            if channel.isE2EE, att.filename?.hasSuffix(".zke") == true {
                // Grid only groups encrypted IMAGES, so decrypt → save the bytes.
                if let data = await decryptedAttachmentData(att, in: channel),
                   await PhotoSaver.save(data: data) {
                    saved += 1
                }
                continue
            }
            guard let url = assetURL(att.url) else { continue }
            if att.isVideo {
                if await saveVideoToPhotos(from: url) { saved += 1 }
            } else if att.isImage,
                      let data = await RetryingImage.loadData(url),
                      await PhotoSaver.save(data: data) {
                saved += 1
            }
        }
        return saved
    }

    private func saveVideoToPhotos(from url: URL) async -> Bool {
        let tmp = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString + ".mp4")
        // performChanges copies the file into the library before it returns, so
        // deleting the temp afterward (defer) is safe and leaves nothing behind.
        defer { try? FileManager.default.removeItem(at: tmp) }
        do {
            let (data, _) = try await URLSession.shared.data(from: url)
            try data.write(to: tmp)
            if PHPhotoLibrary.authorizationStatus(for: .addOnly) == .notDetermined {
                _ = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
            }
            let auth = PHPhotoLibrary.authorizationStatus(for: .addOnly)
            guard auth == .authorized || auth == .limited else { return false }
            try await PHPhotoLibrary.shared().performChanges {
                PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: tmp)
            }
            return true
        } catch {
            return false
        }
    }

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
        return messagesById[rid]
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
                mutateMessage(at: idx) { $0.pinned = !(message.pinned == true) }
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
        case "RESUMED":
            // The socket resumed (replay caught us up) WITHOUT a fresh READY,
            // so the READY re-sync above never runs. A resume replay can be
            // incomplete at the edge — and a zombie-socket reconnect that
            // resumes while we're actively in the app (no foreground
            // transition, so foregroundReconnect's reconcile never fired) would
            // otherwise leave the open conversation missing a message until the
            // user backs out and re-enters. Defensively reconcile the open
            // channel (cheap after-cursor fetch, dedup-safe via upsert).
            Task { await reconcileOpenChannel() }
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
            // Our chosen status may have been changed on another device while
            // this one was away. (Only the choice: READY's `effectiveStatus`
            // can predate this connection's own recompute, whose
            // PRESENCE_UPDATE follows right behind.)
            if let d = jsonDict(data), let u = d["user"] as? [String: Any],
               let chosen = u["chosenStatus"] as? String {
                noteSelfStatus(chosen: chosen, effective: nil)
            }
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
            } else if var cached = messageCache[message.channelId] {
                // Keep an existing cache CURRENT for closed channels. Without
                // this, a live/RESUME-replayed message for a channel you're not
                // viewing was dropped entirely (only the unread dot bumped) —
                // so re-opening that chat seeded a stale cache and the newest
                // messages didn't paint until the refresh fetch landed (or, if
                // that fetch failed right after foregrounding, until the 12s
                // poll). Dedup by id; cap from the front to bound memory.
                if !cached.contains(where: { $0.id == message.id }) {
                    cached.append(message)
                    let cap = Self.messageCachePageSize
                    if cached.count > cap { cached.removeFirst(cached.count - cap) }
                    messageCache[message.channelId] = cached
                }
            }
            // Tactile feedback for a message from SOMEONE ELSE. The phone buzzes
            // (2–3 taps) when the message lands in the channel you're viewing and
            // that channel isn't muted; the watch buzzes for incoming DMs while
            // its app is reachable (mirrors the poke relay below).
            if let a = message.authorId ?? message.author?.id, a != currentUserId {
                if message.channelId == selectedChannel?.id,
                   channelLevel(message.channelId, guildId: selectedChannel?.guildId) != "nothing" {
                    Haptics.incomingMessage()
                }
                if dms.contains(where: { $0.id == message.channelId }) {
                    WatchSync.shared.sendIncomingMessage()
                }
            }
            // (Pokes are no longer messages — see the POKE event case below.)
            // Reflect the new unread on the home-screen badge. For a message in
            // the OPEN channel, markChannelRead already refreshed the badge (and
            // the open channel never counts toward it — isChannelUnread is false
            // for the selected channel), so this only matters for closed
            // channels. Gating it avoids a second full recompute + system
            // setBadgeCount per inbound message in a busy open channel.
            if message.channelId != selectedChannel?.id {
                updateAppBadge()
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
        case "POKE":
            // Ephemeral nudge — no message, no history. Payload snake_case:
            // { channel_id, poke_type, emoji, initiator_id, initiator_name }.
            // Skip our own poke (echoed to the DM channel audience). Relay to
            // the watch (big-emoji flash + haptic if the watch app is up) and
            // show a transient banner on the phone.
            if let d = jsonDict(data),
               let initiator = d["initiator_id"] as? String, initiator != currentUserId {
                let emoji = (d["emoji"] as? String) ?? "👉"
                let name = (d["initiator_name"] as? String) ?? "Someone"
                let channelId = (d["channel_id"] as? String) ?? ""
                let pokeType = (d["poke_type"] as? String) ?? "poke"
                WatchSync.shared.sendPoke(emoji: emoji, name: name)
                // Outlives the banner: this is what the poke leaves behind for
                // someone who wasn't looking at the screen.
                if !channelId.isEmpty { pokePills[channelId] = emoji }
                showPokeBanner(channelId: channelId, emoji: emoji, name: name, pokeType: pokeType)
                Haptics.poke()
            }
        case "ACHIEVEMENT_UNLOCK":
            // A new achievement just unlocked (only sent to our own connections).
            // Payload snake-free: { id, name, description, marker }. Celebrate.
            if let d = jsonDict(data), let name = d["name"] as? String {
                let id = (d["id"] as? String) ?? ""
                let detail = (d["description"] as? String) ?? ""
                showAchievementBanner(id: id, name: name, detail: detail)
                Haptics.poke()
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
            // Buffer + debounce (see pendingPresence) instead of writing the
            // @Published `presence` per event — one batched write per ~200ms
            // keeps the cold-launch burst from re-rendering the gesture/nav
            // container on every frame. The buffer holds the latest status per
            // user, so the flush applies the freshest value.
            if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let uid = obj["user_id"] as? String,
               let status = obj["status"] as? String {
                pendingPresence[uid] = status
                schedulePresenceFlush()
                // Our own: the frame to our own connections also carries our
                // chosen status, so a pick made on another device reaches the
                // Settings picker here (multi-device presence servers only).
                if let me = currentUserId,
                   let own = DevicePresence.selfFields(fromPresenceUpdate: obj, selfId: me) {
                    noteSelfStatus(chosen: own.chosen, effective: own.effective)
                }
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
                mutateMessage(at: idx) { $0.reactions = [] }
            }
        case "MESSAGE_POLL_UPDATE":
            // Poll closed/updated (payload: { channel_id, message_id, closed_at }).
            // Patch the one message's poll.closedAt in place rather than
            // refetching the whole channel. myVotes/options/totalVoters are kept
            // from the local row — this focused delta carries no poll body and
            // no per-recipient state (myVotes would arrive empty on a refetch's
            // broadcast anyway).
            if let d = jsonDict(data), (d["channel_id"] as? String) == selectedChannel?.id,
               let messageId = d["message_id"] as? String,
               let closedAt = d["closed_at"] as? String,
               let idx = messages.firstIndex(where: { $0.id == messageId }),
               var poll = messages[idx].poll, poll.closedAt != closedAt {
                poll.closedAt = closedAt
                mutateMessage(at: idx) { $0.poll = poll }
            }
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
                // A deleted / made-private channel must not keep cached history
                // that could flash on a later reopen.
                if name == "CHANNEL_DELETE" { messageCache.removeValue(forKey: ch.id) }
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
                                messageCache.removeValue(forKey: sel.id)
                                clearChannel()
                            }
                        }
                    }
                } else {
                    // A DM that went away must stop being offered as a system
                    // share target too. `closeDM` covers the local user's own
                    // close; this is every REMOTE removal (the other side closed
                    // it, a block, moderation) — clearing `dms` below does
                    // nothing to the donation, which lives in the system index.
                    if name == "CHANNEL_DELETE", ch.isDM {
                        ShareSuggestions.deleteConversation(ch.id)
                    }
                    Task { await loadDMs() }
                }
            }
        case "CHANNEL_ACK":
            // Cross-device read-state sync: server echoes our ack to all our clients.
            if let rs = try? JSONDecoder().decode(ReadState.self, from: data) {
                readStates[rs.channelId] = rs
                updateAppBadge()
            }
        case "GUILD_CREATE", "GUILD_DELETE":
            // Joined/left/created/deleted a guild — refresh the rail.
            Task { await loadGuilds() }
        case "GUILD_MEMBER_ADD":
            // Cache the new member immediately so mentions of them resolve to
            // their real name instead of flashing "@user" until the member list
            // is opened. (Previously this only reloaded when the member list
            // happened to be on screen, so a freshly-joined account showed as
            // "@user" everywhere until then.) Mirrors GUILD_MEMBER_UPDATE.
            if let m = try? JSONDecoder().decode(GuildMember.self, from: data),
               m.guildId == nil || m.guildId == selectedGuild?.id {
                members[m.userId] = m
            } else if showMembers, let g = selectedGuild, let d = jsonDict(data),
                      ((d["guildId"] as? String) ?? (d["guild_id"] as? String)) == g.id {
                Task { await loadMembers(g) }
            }
        case "GUILD_MEMBER_REMOVE":
            // Refresh the member list if it's open for the affected guild.
            if showMembers, let g = selectedGuild, let d = jsonDict(data),
               ((d["guildId"] as? String) ?? (d["guild_id"] as? String)) == g.id {
                Task { await loadMembers(g) }
            }
        case "USER_UPDATE":
            // A user's name/avatar/status/bio changed. Wire payload is the
            // full PublicUser nested under `user` (snake_case). Patch in place
            // instead of a member-list network refetch — mirrors the web's
            // USER_REPLACE: update every open-channel message author for this
            // user AND their cached member row, touching only the fields the
            // wire carries (so banner/emoji/role data the event omits survive).
            if let d = jsonDict(data), let u = d["user"] as? [String: Any],
               let uid = u["id"] as? String {
                // Batch the message-author patches into a single array
                // republish: mutating messages[i] in a loop would re-render on
                // every element. Skip the assignment entirely when nothing
                // changed (a user shared across N guilds fans out N identical
                // events until the gateway consolidates them).
                var newMessages = messages
                var changed = false
                for i in newMessages.indices where newMessages[i].authorId == uid {
                    if var author = newMessages[i].author,
                       patchPublicUser(&author, from: u) {
                        newMessages[i].author = author
                        changed = true
                    }
                }
                if changed { messages = newMessages }
                // Keep the cached member row's embedded user snapshot aligned
                // so the MemberList doesn't show a stale avatar until the next
                // loadMembers().
                if var member = members[uid], patchPublicUser(&member.user, from: u) {
                    members[uid] = member
                }
            }
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
                // Batch all receipt patches into a SINGLE array republish:
                // mutating messages[i] in a loop fires the didSet index rebuild
                // AND an objectWillChange per element — O(N·K) rebuilds + K list
                // re-renders for one receipt event. Mirror the USER_UPDATE batch
                // pattern: mutate a local copy, assign once (guarded so a
                // no-match event doesn't republish).
                var newMessages = messages
                var changed = false
                for i in newMessages.indices where idSet.contains(newMessages[i].id) {
                    if name == "MESSAGE_VIEWED" {
                        newMessages[i].viewedAt = d["viewed_at"] as? String
                        if newMessages[i].deliveredAt == nil {
                            newMessages[i].deliveredAt = newMessages[i].viewedAt
                        }
                    } else {
                        newMessages[i].deliveredAt = d["delivered_at"] as? String
                    }
                    changed = true
                }
                if changed { messages = newMessages }
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
        case "FAMILY_SUPERVISION_UPDATE":
            // OUR OWN supervision changed (a guardian edited restrictions, a
            // link was accepted or ended, a server was blocked/unblocked, the
            // 18+ sweep released us). This event is addressed to the subject
            // alone, so receiving it means every local supervision gate is
            // stale. Unlike the two above, this is NOT conditioned on `family`
            // already being loaded: the gates it feeds (DM/messaging policy,
            // the share-sheet donation wipe at the end of loadFamily) must
            // tighten even if the Family screen was never opened and the
            // startup load failed.
            //
            // The frame carries the new effective restrictions, but `family` is
            // a FamilySummary — it also holds the guardian list and grace
            // fields this payload deliberately omits — so re-read /family/me
            // instead of splicing a partial shape in. loadFamily() keeps the
            // last good snapshot if that fetch fails.
            Task { await loadFamily() }
        default:
            break
        }
    }

    /// Parse a gateway `d` payload into a JSON dictionary for snake_case-shaped
    /// events that aren't full model DTOs.
    private func jsonDict(_ data: Data) -> [String: Any]? {
        try? JSONSerialization.jsonObject(with: data) as? [String: Any]
    }

    /// Apply the fields carried by a USER_UPDATE wire `user` object (snake_case)
    /// onto an existing PublicUser, IN PLACE, returning whether anything
    /// changed. Only the fields the event actually carries are touched; fields
    /// the wire omits (banner, customStatusEmoji/expiresAt, isBot,
    /// avatarDecoration, canMessage) are left as-is so a partial profile event
    /// can't blank them. Nullable fields are set authoritatively (a JSON null
    /// clears them) by checking key presence rather than value-castability.
    @discardableResult
    private func patchPublicUser(_ user: inout PublicUser, from u: [String: Any]) -> Bool {
        var changed = false
        if let v = u["username"] as? String, v != user.username {
            user.username = v; changed = true
        }
        if let v = u["display_name"] as? String, v != user.displayName {
            user.displayName = v; changed = true
        }
        if u.keys.contains("avatar_url") {
            let v = u["avatar_url"] as? String  // nil for JSON null → clears it
            if v != user.avatarUrl { user.avatarUrl = v; changed = true }
        }
        if u.keys.contains("bio") {
            let v = u["bio"] as? String
            if v != user.bio { user.bio = v; changed = true }
        }
        if u.keys.contains("custom_status") {
            let v = u["custom_status"] as? String
            if v != user.customStatus { user.customStatus = v; changed = true }
        }
        if let v = u["status"] as? String, v != user.status {
            user.status = v; changed = true
        }
        return changed
    }

    /// Insert a message keeping the list sorted, replacing any existing row
    /// with the same id (prevents duplicate REST + gateway echoes).
    /// Carry this device's per-self message state (poll votes, reaction `me`
    /// flags) from a row we already hold onto an incoming DTO that lacks it.
    ///
    /// Server DTOs that fan out to every channel member carry no per-recipient
    /// state: `poll.myVotes` arrives empty and `reactions[].me` arrives false for
    /// everyone. REST loads, reaction events and `togglePollVote` are the
    /// per-self truth, so preserve what we know.
    private func preservingSelfState(_ incoming: Message, from prev: Message) -> Message {
        var out = incoming
        if var p = out.poll, let oldP = prev.poll, p.id == oldP.id, !oldP.myVotes.isEmpty {
            p.myVotes = oldP.myVotes
            out.poll = p
        }
        if var rs = out.reactions, let oldRs = prev.reactions {
            let mine = Set(oldRs.filter { $0.me }.map { $0.emoji })
            if !mine.isEmpty {
                for i in rs.indices where mine.contains(rs[i].emoji) { rs[i].me = true }
                out.reactions = rs
            }
        }
        return out
    }

    private func upsert(_ message: Message) {
        // If this confirmed message echoes the nonce of an optimistic
        // placeholder, replace the placeholder in place (its id == the nonce).
        if let nonce = message.nonce,
           let phIdx = messages.firstIndex(where: { $0.id == nonce && $0.sendState != nil }) {
            var confirmed = message
            // A racing REST reconcile may ALREADY have appended this same server
            // message: the GET-list DTO carries no `nonce` (only the POST reply
            // and the gateway fan-out do), so it missed the arm above and fell
            // through to `append`. Two rows would now share `message.id`, and the
            // list renders `ForEach(…, id: \.element.id)` — duplicate ids there
            // misrender and log "ID … occurs multiple times". The 3s open-channel
            // poll makes this race routine, so evict the twin — but carry over any
            // per-self state it accumulated first (a reaction can land inside the
            // window), since `message` is the creation-time DTO and has none.
            if let dupIdx = messages.indices.first(where: {
                $0 != phIdx && messages[$0].id == message.id
            }) {
                confirmed = preservingSelfState(confirmed, from: messages[dupIdx])
                messages.remove(at: dupIdx)
            }
            // `remove(at:)` may have shifted the placeholder, so re-find it rather
            // than trusting the stale `phIdx`.
            if let idx = messages.firstIndex(where: { $0.id == nonce && $0.sendState != nil }) {
                messages[idx] = confirmed
            } else {
                messages.append(confirmed)
                messages.sort { $0.createdAt < $1.createdAt }
            }
            decryptOne(confirmed)
            return
        }
        if let idx = messages.firstIndex(where: { $0.id == message.id }) {
            // An edit changes the stored ciphertext; the id-keyed plaintext (and any
            // link previews unfurled from the OLD plaintext) are now stale. Drop them
            // so decryptOne re-derives instead of early-returning on decrypted[id] != nil.
            // No-op for plain-text channels (decrypted[id] is nil) and for non-content
            // MESSAGE_UPDATEs like pins/reaction tallies (identical text ⇒ preserved).
            if messages[idx].text != message.text {
                decrypted[message.id] = nil
                e2eeEmbeds[message.id] = nil
                e2eeEmbedResolving.remove(message.id)
            }
            let incoming = preservingSelfState(message, from: messages[idx])
            messages[idx] = incoming
        } else {
            messages.append(message)
            messages.sort { $0.createdAt < $1.createdAt }
        }
        decryptOne(message)
    }

    // MARK: E2EE

    enum MessageDisplay: Equatable {
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
        guard let b64 = e2eeKeychainGet(e2eeKeychainKey(channelId)),
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
        if let expected = channel.e2eeVerifier, verifier(forKey: key) != expected {
            return nil
        }
        return key
    }

    /// E2EE.verifier is a SHA-256 + base64 of the key, and display(for:) runs
    /// it through e2eeKey(for:) for EVERY encrypted row on EVERY render of the
    /// message list. It is a pure function of the key bytes, so remember it.
    /// Cleared with the keys themselves (relockE2EE, sign-out).
    private func verifier(forKey key: Data) -> String {
        if let known = verifierMemo[key] { return known }
        let v = E2EE.verifier(forKey: key)
        if verifierMemo.count >= 32 { verifierMemo.removeAll() }
        verifierMemo[key] = v
        return v
    }
    private var verifierMemo: [Data: String] = [:]

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
        registerE2EEPurgeProofIfNeeded(channel)
        return true
    }

    /// A DM encrypted before purge proofs existed (or by an older client) has
    /// none on the server (`e2eePurgeProofSet == false`), and until one is
    /// registered the server still purges it on the public verifier alone.
    /// Register ours (first registration wins) as soon as we hold the CURRENT
    /// key: on DM select, unlock, every DM list load and a CHANNEL_UPDATE of
    /// the open DM. Once per channel+verifier per session: a refusal (409, a different
    /// proof already registered) is final, and a network error is retried
    /// next launch. The server's CHANNEL_UPDATE flips the flag on success.
    func registerE2EEPurgeProofIfNeeded(_ channel: Channel) {
        guard channel.isE2EE, channel.e2eePurgeProofSet == false,
              let verifier = channel.e2eeVerifier,
              let key = e2eeKey(for: channel) else { return }
        guard purgeProofAttempts.insert("\(channel.id):\(verifier)").inserted else { return }
        let proof = E2EE.purgeProof(forKey: key)
        let channelId = channel.id
        Task {
            try? await api.registerDmE2EEPurgeProof(channelId: channelId, verifier: verifier, purgeProof: proof)
        }
    }
    private var purgeProofAttempts: Set<String> = []

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
        let purgeProof = E2EE.purgeProof(forKey: key)
        do {
            try await api.enableDmE2EE(channelId: channel.id, salt: salt, verifier: verifier, purgeProof: purgeProof)
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
    /// The server requires proof we hold the key: we send the verifier and
    /// the purge proof derived from the cached key (the verifier alone is
    /// public, so the proof is what counts). If this device is locked (no
    /// key), we can't prove it — abort and surface an error so the user
    /// unlocks first rather than silently failing.
    func disableE2EE(_ channel: Channel) async {
        guard let key = e2eeKey(for: channel.id) else {
            e2eeError = "Unlock this conversation first to turn off encryption."
            return
        }
        e2eeError = nil
        do {
            try await api.disableDmE2EE(
                channelId: channel.id,
                verifier: E2EE.verifier(forKey: key),
                purgeProof: E2EE.purgeProof(forKey: key)
            )
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
        // Decrypted copies of opened files must not outlive the lock.
        OpenedFileCopies.sweep()
        // The verifier memo is keyed by raw key bytes; relocking must not leave
        // them behind in memory. (It's tiny and cheap to rebuild.)
        verifierMemo = [:]
        e2eeKeychainDelete(e2eeKeychainKey(channelId))
        for m in messages where m.channelId == channelId {
            decrypted.removeValue(forKey: m.id)
        }
        // Drop any decrypted attachment plaintext too — relocking must not leave
        // viewable media behind. (Clear all: the cache is keyed by attachment id,
        // not channel, and decrypted bytes are cheap to re-derive while unlocked.)
        clearDecryptedMedia()
        e2eeUnlockVersion += 1
    }

    private func storeKey(_ key: Data, for channelId: String) {
        e2eeKeyCache[channelId] = key
        e2eeKeychainSet(key.base64EncodedString(), for: e2eeKeychainKey(channelId))
        e2eeUnlockVersion += 1
    }

    /// Keychain key for a channel's E2EE key, scoped by account so a key
    /// derived under one login is never visible to a different account that
    /// later signs in on the same device.
    private func e2eeKeychainKey(_ channelId: String) -> String {
        "e2ee.\(currentUserId ?? "anon").\(channelId)"
    }

    // MARK: App-group keychain routing (for the Notification Service Extension)
    //
    // E2EE keys live in the shared app-group keychain so the NSE can read them
    // to decrypt message previews. These helpers prefer the app-group store and
    // fall back to the legacy default-group store so neither an app update nor
    // an unprovisioned App Group entitlement ever loses access to existing keys.

    /// Read a key's base64, falling back to the legacy group (and migrating the
    /// hit forward so the NSE can see it next time).
    private func e2eeKeychainGet(_ account: String) -> String? {
        if let v = e2eeKeychain.get(account) { return v }
        guard let legacy = keychain.get(account) else { return nil }
        _ = e2eeKeychain.set(legacy, for: account) // best-effort forward-migrate
        return legacy
    }

    /// Write a key into the app-group store (NSE-visible). If the App Group
    /// isn't provisioned, `set` returns an error and we keep it in the legacy
    /// group so the app still works — only previews are degraded.
    private func e2eeKeychainSet(_ value: String, for account: String) {
        if e2eeKeychain.set(value, for: account) == errSecSuccess {
            keychain.delete(account) // single source of truth once the group works
        } else {
            keychain.set(value, for: account)
        }
    }

    private func e2eeKeychainDelete(_ account: String) {
        e2eeKeychain.delete(account)
        keychain.delete(account)
    }

    /// One-time sweep copying legacy default-group E2EE keys into the app-group
    /// keychain, so the NSE can decrypt previews for conversations unlocked
    /// before this build. Idempotent; only marks itself done once the app-group
    /// write succeeds (entitlement provisioned), so it retries on a later launch
    /// if the user provisions the App Group afterwards.
    private func migrateE2EEKeysToAppGroupIfNeeded() {
        let flag = "e2eeKeysMigratedToAppGroup.v1"
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: flag) else { return }
        let legacy = keychain.allValues(prefix: "e2ee.")
        if legacy.isEmpty { defaults.set(true, forKey: flag); return }
        var allOK = true
        for (account, value) in legacy where e2eeKeychain.get(account) == nil {
            if e2eeKeychain.set(value, for: account) != errSecSuccess { allOK = false }
        }
        if allOK { defaults.set(true, forKey: flag) }
    }

    // E2EE key backup/restore (exportE2EEKeysJSON / importE2EEKeysJSON +
    // E2EE.encodeKeyBackup/decodeKeyBackup) was removed — the shared password
    // is the only unlock path now, so a key-file bundle is dead weight.

    private func decryptVisible() {
        // The live copy: a reconnect refreshes `dms` but never selectedChannel,
        // so after a re-key while suspended its verifier is stale (see liveCopy).
        guard let selected = selectedChannel else { return }
        let ch = liveCopy(of: selected)
        guard let key = e2eeKey(for: ch) else { return }
        let channelId = ch.id
        // Snapshot the not-yet-decrypted messages. (id, ciphertext) pairs are
        // value types, safe to hand to a detached task.
        let inputs: [(String, String)] = messages
            .filter { E2EE.isDecryptable($0.text) && decrypted[$0.id] == nil }
            .map { ($0.id, $0.text) }
        guard !inputs.isEmpty else { return }
        // A page-sized batch decrypts RIGHT HERE, in the same main-actor turn
        // that put the rows on screen, so the list's first layout already has
        // the plaintext. Done off-main, every seeded row was first laid out as
        // a one-line "Couldn't decrypt" (display(for:) can't tell "not yet"
        // from "failed") and then EVERY row changed height in one publish, a
        // few ms later — a visible error flash on each E2EE open, and a
        // whole-list resize landing right while the open was scrolling to the
        // bottom (the trigger that made E2EE chats the ones that opened black).
        // AES-GCM is hardware-accelerated: a 50-message page of text is well
        // under the cost of one frame.
        if inputs.count <= Self.syncDecryptLimit {
            publishDecrypted(inputs.compactMap { id, text in
                E2EE.decrypt(text, key: key).map { (id, $0) }
            })
            return
        }
        Task {
            // A large backlog (e.g. unlocking a long, already-paged chat): run
            // it off the main actor so the UI thread doesn't spike.
            let results: [(String, String)] = await Task.detached(priority: .userInitiated) {
                inputs.compactMap { id, text in E2EE.decrypt(text, key: key).map { (id, $0) } }
            }.value
            // Drop if we navigated away or the key was relocked/rotated while we
            // were off-main (never cache stale plaintext). Re-validate against
            // the CURRENT selected channel + its current key.
            guard let cur = selectedChannel, cur.id == channelId, e2eeKey(for: cur) != nil else { return }
            publishDecrypted(results)
        }
    }

    /// Most messages `decryptVisible` will decrypt synchronously. Two pages, so
    /// the open window, a reload and one prepended page never wait.
    private static let syncDecryptLimit = 120

    /// Publish decrypts in ONE @Published write — one objectWillChange per
    /// batch, not per message (per-message writes re-rendered the list up to N
    /// times per open, the old "choppiest for E2EE"). Skips the write entirely
    /// when the batch adds nothing new: a cached open and the server reload
    /// both decrypt the same page, and an empty second publish used to
    /// re-render every row for nothing.
    private func publishDecrypted(_ results: [(String, String)]) {
        var next = decrypted
        var added: [(String, String)] = []
        for (id, pt) in results where next[id] == nil {
            next[id] = pt
            added.append((id, pt))
        }
        guard !added.isEmpty else { return }
        decrypted = next
        for (id, pt) in added { resolveE2EEEmbeds(id, pt) }
    }

    private func decryptOne(_ message: Message) {
        guard E2EE.isDecryptable(message.text), decrypted[message.id] == nil else { return }
        // Same order as liveCopy: `dms` first, which a reconnect refreshes.
        let channel = dms.first(where: { $0.id == message.channelId })
            ?? (selectedChannel?.id == message.channelId ? selectedChannel : nil)
        guard let channel, let key = e2eeKey(for: channel) else { return }
        if let pt = E2EE.decrypt(message.text, key: key) {
            decrypted[message.id] = pt
            resolveE2EEEmbeds(message.id, pt)
        }
    }

    // MARK: E2EE link previews (client-side unfurl)
    //
    // The server can't unfurl E2EE content (it only holds ciphertext), so an
    // E2EE message always arrives with `embeds: []`. OFF BY DEFAULT: resolving
    // a preview means sending the URL from the decrypted message to the
    // server (GET /unfurl), which then knows which links are shared in this
    // "end-to-end encrypted" chat, by whom and when. Only with the device-local
    // "Link previews in encrypted chats" setting on do we extract URLs from the
    // plaintext and unfurl them, caching by message id for the view to render.
    // The rest of the message never leaves the device — only the link does.

    /// UserDefaults key of that setting (Settings → Security binds the same
    /// key with @AppStorage). Absent = off.
    static let e2eeLinkPreviewsKey = "zk.e2eeLinkPreviews"
    private var e2eeLinkPreviewsEnabled: Bool {
        UserDefaults.standard.bool(forKey: Self.e2eeLinkPreviewsKey)
    }

    /// The setting changed. Off: drop the previews already fetched so nothing
    /// unfurled under the old choice keeps showing. On: unfurl the open
    /// conversation's already-decrypted messages (later ones resolve as they
    /// decrypt).
    func e2eeLinkPreviewsChanged() {
        guard e2eeLinkPreviewsEnabled else {
            e2eeEmbeds = [:]
            return
        }
        for m in messages { if let pt = decrypted[m.id] { resolveE2EEEmbeds(m.id, pt) } }
    }

    /// messageId → client-resolved link previews (empty array = "resolved, none").
    @Published var e2eeEmbeds: [String: [MessageEmbed]] = [:]
    /// In-flight guard so a message is only unfurled once.
    private var e2eeEmbedResolving: Set<String> = []

    /// Previews to render for an E2EE message (nil when there are none).
    func localEmbeds(for messageId: String) -> [MessageEmbed]? {
        guard let e = e2eeEmbeds[messageId], !e.isEmpty else { return nil }
        return e
    }

    private func resolveE2EEEmbeds(_ messageId: String, _ plaintext: String) {
        // Never send a decrypted link to the server unless the user opted in.
        guard e2eeLinkPreviewsEnabled else { return }
        guard e2eeEmbeds[messageId] == nil, !e2eeEmbedResolving.contains(messageId) else { return }
        let urls = Self.extractURLs(from: plaintext)
        guard !urls.isEmpty else { return }
        e2eeEmbedResolving.insert(messageId)
        let targets = Array(urls.prefix(5))
        Task { @MainActor in
            // Fan the independent GET /unfurl calls out concurrently, then
            // reassemble in URL order so preview order is unchanged (a plain
            // task group would collect in completion order).
            let unfurl = self.api
            let slots: [MessageEmbed?] = await withTaskGroup(of: (Int, MessageEmbed?).self) { group in
                for (i, u) in targets.enumerated() {
                    group.addTask { (i, try? await unfurl.unfurl(url: u)) }
                }
                var acc = [MessageEmbed?](repeating: nil, count: targets.count)
                for await (i, e) in group { acc[i] = e }
                return acc
            }
            let found = slots.compactMap { $0 }
            e2eeEmbedResolving.remove(messageId)
            // Turned off while these were in flight: don't show them.
            guard e2eeLinkPreviewsEnabled else { return }
            // Record the result even when empty so we don't re-fetch on every
            // re-decrypt / re-render.
            e2eeEmbeds[messageId] = found
        }
    }

    /// Extract http(s) URLs from text via the system link detector (handles
    /// trailing punctuation, etc.), deduped and in order.
    private static func extractURLs(from text: String) -> [String] {
        guard let detector = try? NSDataDetector(
            types: NSTextCheckingResult.CheckingType.link.rawValue) else { return [] }
        let range = NSRange(text.startIndex..., in: text)
        var out: [String] = []
        var seen = Set<String>()
        for match in detector.matches(in: text, options: [], range: range) {
            guard let url = match.url, url.scheme == "http" || url.scheme == "https" else { continue }
            let s = url.absoluteString
            if seen.insert(s).inserted { out.append(s) }
        }
        return out
    }

    /// Bumped by every live E2EE change to a DM. performLoadDMs replaces `dms`
    /// wholesale with a REST response, and liveCopy reads `dms` first: a
    /// response read by the server BEFORE a CHANNEL_UPDATE that turned
    /// encryption on, but applied after it, would otherwise put "not encrypted"
    /// back for the rest of the session — no lock gate, plaintext sends.
    private var e2eeChangeSeq = 0
    private var e2eeChangedAt: [String: Int] = [:]

    private func noteE2EEChange(_ channelId: String) {
        e2eeChangedAt[channelId] = e2eeChangeSeq
        e2eeChangeSeq += 1
    }

    private func applyE2EEState(channelId: String, enabled: Bool, salt: String?, verifier: String?) {
        noteE2EEChange(channelId)
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
