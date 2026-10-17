package com.zekktris

import com.zekktris.data.ApiClient
import com.zekktris.data.Gateway
import com.zekktris.data.LoginResult
import com.zekktris.data.RefreshOutcome
import com.zekktris.data.model.AdminGuild
import com.zekktris.data.model.AdminStats
import com.zekktris.data.model.AdminStorage
import com.zekktris.data.model.AdminUser
import com.zekktris.data.model.Channel
import com.zekktris.data.model.ChildRestrictions
import com.zekktris.data.model.DiscoverableGuild
import com.zekktris.data.model.FamilySummary
import com.zekktris.data.model.InstanceMetrics
import com.zekktris.data.model.InvitePreview
import com.zekktris.data.model.Mention
import com.zekktris.data.model.MyEventItem
import com.zekktris.data.model.Relationship
import com.zekktris.data.model.SavedMessageItem
import com.zekktris.data.model.ScheduledMessage
import com.zekktris.data.model.Guild
import com.zekktris.data.model.GuildMember
import com.zekktris.data.model.Message
import com.zekktris.data.model.PublicUser
import com.zekktris.data.model.ReadState
import com.zekktris.data.model.SelfUser
import com.zekktris.push.PushManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.getAndUpdate
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.util.UUID

enum class Phase { Loading, Auth, Ready }

/**
 * How a device-approval login ended on the LOGGED-OUT device.
 *
 * [Approved] carries the account the session landed in, and the app has NOT
 * entered [Phase.Ready] yet — the screen shows who was signed in and then calls
 * [AppStore.completeDeviceLogin]. That extra beat is the client half of a
 * residual risk the server cannot close: someone who guesses a userCode can
 * approve a stranger's device into THEIR account, so the new device has to say
 * out loud whose account it just joined.
 */
sealed class DeviceLoginOutcome {
    data class Approved(val user: SelfUser) : DeviceLoginOutcome()
    data object Denied : DeviceLoginOutcome()
    data object Expired : DeviceLoginOutcome()
    data class Failed(val message: String) : DeviceLoginOutcome()
}

/** Transient poke pill shown at the top of the app for ~5s. */
data class PokeBanner(
    val id: String,
    val emoji: String,
    val name: String,
    val channelId: String,
    val pokeType: String,
)

/** A just-unlocked achievement, shown as a transient celebratory banner. */
data class AchievementBanner(
    val id: String,
    val name: String,
    val detail: String,
    val marker: String,
)

/** Full-screen overlays reachable from the server rail (mirror iOS railPage). */
enum class RailPage { Discover, CreateServer, JoinInvite, Admin, Family }

/** A ringing incoming 1:1 DM call (someone joined a DM we're a recipient of). */
data class IncomingCall(val channelId: String, val callerId: String, val callerName: String)

/** Which content the home (non-guild) view shows in the rail's content pane. */
enum class HomeTab { Dms, Mentions }

/**
 * A payload handed to us by the system share sheet, waiting for a composer to
 * pick it up. [channelId] is the conversation the user chose as a direct-share
 * target; null means they picked plain "Zekktris" instead, so the payload lands
 * in whichever conversation they open next.
 */
data class PendingShare(
    val channelId: String?,
    val text: String? = null,
    /** content:// URIs as strings — the state snapshot stays Parcelable-free. */
    val uris: List<String> = emptyList(),
)

// A single immutable snapshot the whole UI observes (Compose-friendly).
data class AppState(
    val phase: Phase = Phase.Loading,
    val me: SelfUser? = null,
    val guilds: List<Guild> = emptyList(),
    val dms: List<Channel> = emptyList(),
    val channelsByGuild: Map<String, List<Channel>> = emptyMap(),
    val membersByGuild: Map<String, List<GuildMember>> = emptyMap(),
    val rolesByGuild: Map<String, List<com.zekktris.data.model.Role>> = emptyMap(),
    // Custom emoji of the selected guild (for the picker + :name: rendering).
    val guildEmojis: List<com.zekktris.data.model.GuildEmoji> = emptyList(),
    // DM channel ids whose E2EE key is unlocked (held in the keystore) — drives
    // the lock UI + decrypt path. A separate flag so Compose recomposes on unlock.
    val e2eeUnlocked: Set<String> = emptySet(),
    val messagesByChannel: Map<String, List<Message>> = emptyMap(),
    // Optimistic sends whose POST failed → the row shows Failed/Retry/Delete.
    val failedSendIds: Set<String> = emptySet(),
    // channelId → false once history pagination hit the oldest message.
    val hasMoreOlderByChannel: Map<String, Boolean> = emptyMap(),
    // channelId currently prepending an older page (top spinner row).
    val loadingOlderChannelIds: Set<String> = emptySet(),
    // One-shot: message id to scroll to + flash when its channel opens
    // (mention tap / notification deep-link). Consumed by ChatScreen.
    val pendingJumpMessageId: String? = null,
    // One-shot: message id to prefill the composer's reply target with
    // (guild-channel notification tap, iOS openFromPush parity).
    val pendingReplyPrefillId: String? = null,
    // One-shot: text/attachments handed over by the system share sheet.
    // Consumed by the composer (Composer's LaunchedEffect → consumePendingShare).
    val pendingShare: PendingShare? = null,
    // channelId → the frozen pre-ack read pointer captured when the channel was
    // opened; drives the red "New messages" divider (iOS unreadBoundaryId).
    val unreadBoundaryByChannel: Map<String, String> = emptyMap(),
    val readStates: Map<String, ReadState> = emptyMap(),
    val presence: Map<String, String> = emptyMap(),
    // "channel:<id>" / "guild:<id>" → level (all|mentions|nothing).
    val notificationOverrides: Map<String, String> = emptyMap(),
    // channelId → (userId → typing-expiry epoch-millis); pruned on write + read.
    val typingByChannel: Map<String, Map<String, Long>> = emptyMap(),
    val pokeBanner: PokeBanner? = null,
    /**
     * The last poke received in each DM, as its emoji, waiting to be seen.
     *
     * The banner lasts five seconds, so a poke sent while the phone was in a
     * pocket left no trace at all. This is the trace: the DM row shows the
     * emoji until that conversation is opened. Not persisted — a nudge, not a
     * ledger.
     */
    val pokePills: Map<String, String> = emptyMap(),
    val achievementBanner: AchievementBanner? = null,
    val relationships: List<Relationship> = emptyList(),
    val profileUser: com.zekktris.data.model.PublicUser? = null,
    val mentions: List<Mention> = emptyList(),
    val saved: List<SavedMessageItem> = emptyList(),
    val savedIds: Set<String> = emptySet(),
    val scheduled: List<ScheduledMessage> = emptyList(),
    val myEvents: List<MyEventItem> = emptyList(),
    // userId → the viewer's personal nickname for that user (DM-only, private).
    val dmNicknames: Map<String, String> = emptyMap(),
    // The bots the current user owns (Settings → Bots).
    val bots: List<com.zekktris.data.model.Bot> = emptyList(),
    val selectedGuildId: String? = null, // null = DM/home
    val selectedChannelId: String? = null,
    val homeTab: HomeTab = HomeTab.Dms, // content when no guild selected (DMs vs Mentions)
    val railPage: RailPage? = null,     // full-screen overlay from the rail
    val discoverable: List<DiscoverableGuild> = emptyList(),
    val loadingDiscoverable: Boolean = false,
    val family: FamilySummary? = null,
    val loadingFamily: Boolean = false,
    val childRestrictions: Map<String, ChildRestrictions> = emptyMap(),
    val adminStats: AdminStats? = null,
    val adminMetrics: InstanceMetrics? = null,
    val loadingAdmin: Boolean = false,
    val adminUsers: List<AdminUser> = emptyList(),
    val adminGuilds: List<AdminGuild> = emptyList(),
    val adminStorage: AdminStorage? = null,
    val showSettings: Boolean = false,
    /** Non-null ⇒ the full-screen Server Settings overlay for this guild id. */
    val guildSettingsFor: String? = null,
    /** Non-null ⇒ the full-screen channel permission-overrides editor for this channel id. */
    val channelPermsFor: String? = null,
    // voice — roster keyed by userId (channelId==null means left); the active
    // call is the channel we're connected to.
    val voiceStates: Map<String, com.zekktris.data.model.VoiceState> = emptyMap(),
    val activeVoiceChannelId: String? = null,
    val voiceConn: com.zekktris.voice.VoiceManager.ConnState = com.zekktris.voice.VoiceManager.ConnState.Idle,
    val speakingUserIds: Set<String> = emptySet(),
    val selfMuted: Boolean = false,
    val selfDeafened: Boolean = false,
    val mutedForMeIds: Set<String> = emptySet(),
    val pttEnabled: Boolean = false,
    val cameraOn: Boolean = false,
    val localVideo: io.livekit.android.room.track.VideoTrack? = null,
    val screenOn: Boolean = false,
    val localScreen: io.livekit.android.room.track.VideoTrack? = null,
    val remoteVideo: Map<String, io.livekit.android.room.track.VideoTrack> = emptyMap(),
    val remoteScreen: Map<String, io.livekit.android.room.track.VideoTrack> = emptyMap(),
    val voiceTokenMissing: Boolean = false,
    val incomingCall: IncomingCall? = null,
    val pendingVoiceChannelId: String? = null,
    // stage channels — speaker/audience rooms (iOS AppStore stage block).
    // activeStageChannelId is the stage we're connected to (mutually exclusive
    // with activeVoiceChannelId: one LiveKit room at a time).
    val activeStageChannelId: String? = null,
    val stageParticipants: List<com.zekktris.data.model.StageParticipant> = emptyList(),
    val stageConnecting: Boolean = false,
    val stageTokenMissing: Boolean = false,
    val myStageSpeaker: Boolean = false,
    val gatewayState: Gateway.ConnState = Gateway.ConnState.Disconnected,
    val authBusy: Boolean = false,
    val authError: String? = null,
    /**
     * True while [Phase.Loading] is retrying a cold-start `/auth/refresh` that
     * failed TRANSIENTLY (offline, timeout, 5xx). Distinguishes "restoring your
     * session" from "we can't reach the server" — and, crucially, from the old
     * behaviour where either one dumped the user on the login screen.
     */
    val reconnecting: Boolean = false,
    val pending2FAEmail: String? = null,
    val pending2FAPassword: String? = null,
) {
    val currentChannel: Channel?
        get() = selectedChannelId?.let { id ->
            channelsByGuild.values.flatten().firstOrNull { it.id == id }
                ?: dms.firstOrNull { it.id == id }
        }
}

/** StateFlow store mirroring the iOS AppStore — the single source of UI truth. */
class AppStore(
    /** Application context — needed by MediaPrep's video export (Transformer
     *  takes a Context) and for its cacheDir scratch files. Application-scoped,
     *  so there is no Activity to leak. */
    private val appContext: android.content.Context,
    private val api: ApiClient,
    private val gateway: Gateway,
    private val push: PushManager,
    private val voice: com.zekktris.voice.VoiceManager,
    private val e2eeStore: com.zekktris.crypto.E2EEKeyStore,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state.asStateFlow()

    /** Decrypted E2EE attachment plaintext, IN MEMORY ONLY (LRU, 128 items /
     *  128 MB). Cleared on E2EE disable and sign-out — plaintext must never
     *  outlive the key, and must never be written to disk. */
    private val mediaCache = com.zekktris.crypto.DecryptedMediaCache()

    init {
        // Fan gateway connection-state + dispatches into the store.
        scope.launch { gateway.state.collect { s -> _state.update { it.copy(gatewayState = s) } } }
        // Decode gateway frames off the main thread.
        scope.launch(Dispatchers.Default) { gateway.events.collect { onDispatch(it) } }
        // Mirror LiveKit connection / speaking / mute state into the snapshot.
        scope.launch { voice.connState.collect { s -> _state.update { it.copy(voiceConn = s) } } }
        scope.launch { voice.speaking.collect { s -> _state.update { it.copy(speakingUserIds = s) } } }
        scope.launch { voice.muted.collect { m -> _state.update { it.copy(selfMuted = m) } } }
        scope.launch { voice.deafened.collect { d -> _state.update { it.copy(selfDeafened = d) } } }
        scope.launch { voice.mutedForMe.collect { s -> _state.update { it.copy(mutedForMeIds = s) } } }
        scope.launch { voice.pttEnabled.collect { p -> _state.update { it.copy(pttEnabled = p) } } }
        scope.launch { voice.cameraOn.collect { c -> _state.update { it.copy(cameraOn = c) } } }
        scope.launch { voice.localVideo.collect { t -> _state.update { it.copy(localVideo = t) } } }
        scope.launch { voice.screenOn.collect { s -> _state.update { it.copy(screenOn = s) } } }
        scope.launch { voice.localScreen.collect { t -> _state.update { it.copy(localScreen = t) } } }
        scope.launch { voice.remoteVideo.collect { m -> _state.update { it.copy(remoteVideo = m) } } }
        scope.launch { voice.remoteScreen.collect { m -> _state.update { it.copy(remoteScreen = m) } } }
        // Premium camera-quality gate (iOS AppStore.start): give the voice layer
        // a LIVE read of the admin-configured matrix vs the signed-in tier. The
        // closure re-reads state on every call, so a gift, a lapse or a renewal
        // takes effect on the next publish with no re-assignment anywhere —
        // which is exactly what stops a lapsed subscription from still pushing
        // 4K, and what an assign-once-per-membership-change wiring would miss.
        voice.cameraQualityAllowed = { q -> cameraQualityAllowed(q) }
        // Safety net for the recurring DM-staleness bug: while the app is
        // FOREGROUND and a channel is open, reconcile it every 3s (matches
        // iOS). The gateway push is the fast path; when it silently fails
        // (dead socket after Doze, missed frame) this is the ONLY thing that
        // surfaces an incoming message into the open conversation. Cheap: an
        // after-cursor fetch that returns zero rows when already current.
        scope.launch {
            while (true) {
                delay(OPEN_CHANNEL_POLL_MS)
                if (!appForeground) continue
                _state.value.selectedChannelId?.let { syncNewMessages(it) }
            }
        }
    }

    /** Foreground/background flag fed by MainActivity (no AppState churn).
     *  Starts FALSE: an FCM-woken process runs no Activity, so a `true` default
     *  made [isForeground] lie to the push receiver and every incoming-call ring
     *  was dropped as "already ringing in-app". MainActivity.onStart calls
     *  [onAppForeground] on launch AND on every resume, so a real foreground
     *  still reports correctly. */
    @Volatile
    private var appForeground = false

    /** True while MainActivity is in the foreground. Read by the FCM receiver so
     *  a call push doesn't raise the full-screen ring on top of the in-app
     *  ringer (the gateway already rings a foregrounded, connected client). */
    val isForeground: Boolean get() = appForeground

    /**
     * App returned to the foreground. Android commonly kills the socket in the
     * background with no close frame, and the heartbeat watchdog can take a
     * while to notice — so force a reconnect NOW and re-sync via REST, which is
     * independent of the socket (mirrors iOS foregroundReconnect): the open
     * conversation and the DM list converge within ~1s regardless of what the
     * socket does. A second delayed reconcile covers the race with the
     * reconnect's own resume/replay.
     */
    fun onAppForeground() {
        appForeground = true
        if (_state.value.phase != Phase.Ready) return
        gateway.forceReconnect()
        // A resume replays events but can't recover one that was never
        // buffered, so heal the on-screen server's voice roster directly.
        _state.value.selectedGuildId?.let { reconcileGuildVoice(it) }
        scope.launch {
            val presenceBefore = _state.value.presence
            val dms = runCatching { api.listDMs() }.getOrNull()
            if (dms != null) {
                _state.update { it.copy(dms = sortDms(dms)) }
                seedPresence(dms.flatMap { it.recipients ?: emptyList() }, presenceBefore)
                // Recency (and names/avatars) may have moved on another device.
                refreshShareShortcuts()
            }
        }
        // The forced reconnect usually RESUMEs (RESUMED, not READY), so onReady's
        // reconcile never runs. Independently converge the state that live events
        // + resume-replay can't heal on wake:
        //  • read-states: REPLACE from server so a cross-device read CLEARS the
        //    local unread dot (the read advanced the server read-state with no
        //    live event) and @-mention badges — which never arrive from live
        //    MESSAGE_CREATE — appear/clear. Idempotent + socket-independent.
        //  • guilds: pick up joins/leaves/renames missed while suspended.
        //  • the selected guild's channels (closed-channel unread via
        //    channel.lastMessageId) + members (status dots): a fresh identify
        //    replays nothing and selectGuild won't refetch an already-cached guild.
        scope.launch {
            runCatching { api.listReadStates() }.getOrNull()?.let { rs ->
                _state.update { it.copy(readStates = rs.associateBy { s -> s.channelId }) }
            }
        }
        scope.launch {
            runCatching { api.listGuilds() }.getOrNull()?.let { g ->
                _state.update { it.copy(guilds = g) }
            }
        }
        scope.launch {
            val gid = _state.value.selectedGuildId
            _state.value.channelsByGuild.keys.toList().forEach { reloadGuildChannelsSafe(it) }
            if (gid != null) loadMembers(gid)
        }
        // Guaranteed floor: pull the LATEST window for the open chat and merge
        // it, so a message that arrived while suspended can NEVER leave the open
        // conversation stale after a resume — even if the after-cursor sync
        // races or misses. Once now, once after the socket has settled.
        scope.launch { _state.value.selectedChannelId?.let { refreshOpenChannelLatest(it) } }
        scope.launch {
            delay(2_500)
            _state.value.selectedChannelId?.let { refreshOpenChannelLatest(it) }
        }
    }

    fun onAppBackground() {
        appForeground = false
    }

    /**
     * FCM delivered a push for [channelId] while the process is alive. If that
     * conversation is open and on screen, sync it immediately and return true —
     * the caller suppresses the banner (the message paints in place instead of
     * notifying about the chat you're already reading).
     */
    fun onPushForChannel(channelId: String): Boolean {
        if (_state.value.phase != Phase.Ready) return false
        val openOnScreen = appForeground && _state.value.selectedChannelId == channelId
        scope.launch { syncNewMessages(channelId) }
        return openOnScreen
    }

    // ---- lifecycle ----------------------------------------------------------

    /**
     * Restore the session at launch.
     *
     * This client has NO persisted access token — only the refresh cookie
     * survives a process death — so every cold start stakes the whole session
     * on `/auth/refresh`. It used to collapse every way that call can fail into
     * `phase = Auth`: `runCatching{}.getOrNull()` swallowed a 30 s timeout, a
     * 502 mid-deploy and an offline radio exactly like a real 401, so opening
     * the app on a flaky connection was a guaranteed trip to the login screen.
     *
     * Now the three cases are distinct:
     *  • [RefreshOutcome.Success] → fetch the user and enter the app.
     *  • [RefreshOutcome.Fatal]   → 401/403 from `/auth/refresh` itself; the
     *    refresh token really is dead, so sign out (this is also the normal
     *    first-run path, where there is no cookie at all).
     *  • [RefreshOutcome.Transient] → keep the credentials, show "Reconnecting"
     *    and try again on an outer ladder. We never give up on our own; the
     *    user can still choose the login screen from [signInInstead].
     *
     * `getMe` failing is handled the same way: a genuinely dead refresh token
     * surfaces as Fatal (either from the call above or from the refresh that
     * `ApiClient.authorized` runs behind its 401), so anything else that gets
     * here is transient and worth another round.
     */
    fun bootstrap() {
        // The ONLY path that may end a session: /auth/refresh answered 401/403.
        api.onRefreshFatal = { forceSignOut() }
        scope.launch {
            _state.update { it.copy(phase = Phase.Loading, reconnecting = false) }
            var attempt = 0
            while (true) {
                // Re-checked at the TOP of every iteration, not just on the
                // failure path below: `signInInstead` can land during the
                // delay, and without this the next round could succeed and
                // yank the user off the sign-in form they just asked for —
                // straight into the old account, possibly while they were
                // typing credentials for a different one.
                if (_state.value.phase != Phase.Loading) return@launch
                val outcome = runCatching { api.refreshAccessToken() }
                    .getOrDefault(RefreshOutcome.Transient)
                if (outcome == RefreshOutcome.Fatal) {
                    // forceSignOut (via onRefreshFatal) also lands here; setting
                    // it directly makes the no-cookie first run deterministic.
                    _state.update { it.copy(phase = Phase.Auth, reconnecting = false) }
                    return@launch
                }
                if (outcome == RefreshOutcome.Success) {
                    val me = runCatching { api.getMe() }.getOrNull()
                    if (me != null) {
                        _state.update { it.copy(reconnecting = false) }
                        enterReady(me)
                        return@launch
                    }
                }
                // A sign-out (fatal refresh) or a manual "sign in instead" moved
                // us off Loading while we were awaiting — don't fight the user.
                if (_state.value.phase != Phase.Loading) return@launch
                _state.update { it.copy(reconnecting = true) }
                val rung = BOOTSTRAP_RETRY_DELAYS_MS[
                    minOf(attempt, BOOTSTRAP_RETRY_DELAYS_MS.size - 1),
                ]
                attempt++
                delay(rung + kotlin.random.Random.nextLong(0, 500))
            }
        }
    }

    /**
     * Abandon a stalled cold-start retry loop and show the sign-in screen.
     *
     * Deliberately does NOT clear anything: the refresh cookie may well be
     * perfectly good and the server merely unreachable, so a later relaunch
     * (or a successful login) still works. This exists purely so an extended
     * outage can't trap the user on a spinner with no way forward.
     */
    fun signInInstead() {
        if (_state.value.phase != Phase.Loading) return
        _state.update { it.copy(phase = Phase.Auth, reconnecting = false) }
    }

    /**
     * Involuntary sign-out: the server told us the refresh token is revoked or
     * expired (401/403 from `/auth/refresh`). Unlike [logout] this makes no
     * network calls — there is no session left to revoke, and the push-token
     * DELETE would just 401 too.
     *
     * The E2EE keystore is deliberately KEPT (iOS `Session.logout` keeps its
     * keychain E2EE keys too): a session revoked from another device, or one
     * that simply aged past 30 days, shouldn't cost the user every DM password.
     * Those keys are sealed by the Android Keystore and useless without a
     * session. The decrypted-plaintext cache is another matter and is dropped.
     */
    private fun forceSignOut() {
        scope.launch {
            if (_state.value.phase == Phase.Auth) return@launch
            gateway.stop()
            api.clearSession()
            mediaCache.clear()
            // Contact names + faces must not outlive the session in the SYSTEM
            // share sheet, which is outside the app and outside the app lock.
            clearShareShortcuts()
            // Same reasoning one step further in: a half-typed message is
            // plaintext on disk and must not be waiting for whoever signs in next.
            com.zekktris.ui.screens.Drafts.clearAll(appContext)
            _state.value = AppState(phase = Phase.Auth)
        }
    }

    private suspend fun enterReady(me: SelfUser) {
        _state.update { it.copy(me = me, phase = Phase.Ready, authBusy = false, authError = null) }
        loadInitial()
        gateway.start()
        // Now that we hold a valid session, (re)register this device for push.
        push.registerCurrentToken()
    }

    private suspend fun loadInitial() {
        // New session, nothing fetched yet: the share sheet must not treat the
        // previous account's (or the empty initial) relationship list as an
        // answer. Cleared here rather than at sign-out so it also covers a
        // restored session that never went through one.
        relationshipsLoaded = false
        locallyBlockedIds = emptySet()
        val presenceBefore = _state.value.presence
        val guilds = runCatching { api.listGuilds() }.getOrDefault(emptyList())
        val dms = runCatching { api.listDMs() }.getOrDefault(emptyList())
        _state.update { it.copy(guilds = guilds, dms = sortDms(dms)) }
        seedPresence(dms.flatMap { it.recipients ?: emptyList() }, presenceBefore)
        loadNotificationOverrides()
        loadDmNicknames()
        // Family/supervision snapshot at startup (iOS loadFamily parity) — the
        // rail's Family tile gating + minor red-dot need isMinor/restrictedHeavily,
        // and [shareShortcutsAllowed] reads its restrictions. Note that a missing
        // snapshot reads as ALLOWED (an unsupervised account has no restrictions
        // blob), so this is kicked off before the share refresh to give it a head
        // start, and the wipe in [refreshFamily] is what covers a snapshot that
        // lands after the publish and says no.
        loadFamily()
        // Relationships up front, as iOS does in start() (AppStore.swift:1009).
        // Blocked users are filtered out of the share sheet, so that list has to
        // exist before the first publish — not only after a visit to Friends.
        // Unlike the family snapshot, a missing one here is NOT treated as
        // permissive: the publish below blocks on [relationshipsLoaded] and this
        // fetch releases it.
        loadRelationships()
        // Offer these conversations as direct-share targets in the system sheet.
        refreshShareShortcuts()
        // Seed the entitlement matrix the publish-time camera clamp reads.
        // Fire-and-forget (iOS start()): the clamp falls back to the built-in
        // defaults until it lands, so nothing waits on it.
        scope.launch { getMonetization() }
    }

    // ---- personal DM nicknames ----------------------------------------------

    fun loadDmNicknames() {
        scope.launch {
            val map = runCatching { api.getDmNicknames() }.getOrNull() ?: return@launch
            _state.update { it.copy(dmNicknames = map) }
        }
    }

    /** The viewer's personal nickname for [userId] (non-blank), or null. */
    fun dmNickname(userId: String?): String? {
        val n = userId?.let { _state.value.dmNicknames[it] }
        return n?.takeIf { it.isNotBlank() }
    }

    /**
     * Set (non-blank) or clear (blank) the personal DM nickname for [userId].
     * Optimistic; reverts on failure. Returns null on success or an error string.
     */
    suspend fun setDmNickname(userId: String, nickname: String?): String? {
        val trimmed = nickname?.trim().orEmpty()
        val prev = _state.value.dmNicknames[userId]
        _state.update {
            val m = it.dmNicknames.toMutableMap()
            if (trimmed.isEmpty()) m.remove(userId) else m[userId] = trimmed
            it.copy(dmNicknames = m)
        }
        return try {
            if (trimmed.isEmpty()) api.clearDmNickname(userId) else api.setDmNickname(userId, trimmed)
            null
        } catch (e: kotlinx.coroutines.CancellationException) {
            // The caller's scope was cancelled (e.g. the profile sheet closed)
            // mid-write. The server may already have persisted it — DON'T revert
            // the optimistic state; just propagate the cancellation.
            throw e
        } catch (e: Exception) {
            _state.update {
                val m = it.dmNicknames.toMutableMap()
                if (prev == null) m.remove(userId) else m[userId] = prev
                it.copy(dmNicknames = m)
            }
            e.message ?: "Couldn't save nickname."
        }
    }

    // ---- bots (owner-facing management) -------------------------------------

    fun loadBots() {
        scope.launch {
            val list = runCatching { api.listBots() }.getOrNull() ?: return@launch
            _state.update { it.copy(bots = list) }
        }
    }

    /** Create a bot; returns the one-time plaintext token on success. */
    suspend fun createBot(username: String, displayName: String): Result<String> = try {
        val resp = api.createBot(username.trim(), displayName.trim())
        _state.update { it.copy(bots = it.bots + resp.bot) }
        Result.success(resp.token)
    } catch (e: Exception) {
        Result.failure(e)
    }

    /** Regenerate a bot's token; returns the new one-time token. */
    suspend fun regenerateBotToken(botId: String): Result<String> =
        runCatching { api.regenerateBotToken(botId) }

    suspend fun deleteBot(botId: String): Result<Unit> = try {
        api.deleteBot(botId)
        _state.update { it.copy(bots = it.bots.filterNot { b -> b.id == botId }) }
        Result.success(Unit)
    } catch (e: Exception) {
        Result.failure(e)
    }

    suspend fun addBotToGuild(guildId: String, botId: String): Result<Unit> =
        runCatching { api.addBotToGuild(guildId, botId) }

    /** Set (url != null) or clear (url == null) a bot's event callback. Returns
     *  the signing secret (present only when a URL was set). */
    suspend fun setBotEventConfig(botId: String, url: String?): Result<String?> = try {
        val resp = api.setBotEventConfig(botId, url?.trim()?.takeIf { it.isNotEmpty() })
        _state.update {
            it.copy(bots = it.bots.map { b -> if (b.id == botId) b.copy(botEventUrl = resp.eventUrl) else b })
        }
        Result.success(resp.secret)
    } catch (e: Exception) {
        Result.failure(e)
    }

    // ---- auth ---------------------------------------------------------------

    fun login(email: String, password: String, code: String? = null) {
        scope.launch {
            _state.update { it.copy(authBusy = true, authError = null) }
            val r = runCatching { api.login(email, password, code) }
                .getOrElse { LoginResult.Failure("Can't reach Zekktris. Check your connection.") }
            when (r) {
                is LoginResult.Success -> enterReady(r.user)
                LoginResult.Requires2FA -> _state.update {
                    it.copy(authBusy = false, pending2FAEmail = email, pending2FAPassword = password)
                }
                is LoginResult.Failure -> _state.update { it.copy(authBusy = false, authError = r.message) }
            }
        }
    }

    fun submit2FA(code: String) {
        val email = _state.value.pending2FAEmail ?: return
        val pw = _state.value.pending2FAPassword ?: return
        login(email, pw, code)
    }

    fun cancel2FA() {
        _state.update { it.copy(pending2FAEmail = null, pending2FAPassword = null, authError = null) }
    }

    // ── Device-approval login: the REQUESTER half (this device is logged out) ─

    /**
     * Open a device-login request and poll it to a terminal outcome, handing
     * the displayable code back through [onCodeReady] as soon as it exists.
     *
     * Deliberately a plain suspend function rather than state on [AppState]:
     *
     *  - The SECRET `deviceCode` lives in a local for the life of this call and
     *    nowhere else. It is never written to [AppState] (which the whole UI
     *    tree reads), never persisted, never logged. Only `userCode` escapes.
     *  - The caller owns cancellation. Backing out of the screen cancels the
     *    coroutine, which ends the poll loop — no orphaned timer, no dangling
     *    request being collected behind the user's back.
     *
     * Returning [DeviceLoginOutcome.Approved] does NOT enter the app: the
     * screen shows which account was joined first, then calls
     * [completeDeviceLogin]. Entering here would flip the phase to Ready and
     * unmount the very screen awaiting this call, cancelling us mid-`loadInitial`.
     */
    suspend fun runDeviceLogin(
        deviceName: String? = android.os.Build.MODEL,
        onCodeReady: (com.zekktris.data.model.DeviceLoginStart) -> Unit,
    ): DeviceLoginOutcome {
        val start = try {
            api.deviceLoginStart(deviceName)
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            return DeviceLoginOutcome.Failed(
                if ((e as? com.zekktris.data.ApiException)?.status == 429) {
                    "Too many login requests from this network. Try again in a few minutes."
                } else {
                    "Can't reach Zekktris. Check your connection."
                },
            )
        }
        onCodeReady(start)

        // Clamp everything the server hands us: this drives a loop, and a bad
        // or hostile value here would either hammer the api or hang the screen.
        var interval = start.interval.coerceIn(1, 60)
        val deadline = System.currentTimeMillis() +
            (start.expiresIn.coerceIn(30, 900) + GRACE_SECONDS) * 1000L
        // Consecutive "couldn't ask" answers. A handful is a flaky radio; a
        // sustained run means we're offline and the code is expiring unseen.
        var unreachable = 0

        while (System.currentTimeMillis() < deadline) {
            // Wait FIRST. Polling the instant the code appears earns a
            // `slow_down` from the server's own interval enforcement, and the
            // user cannot possibly have approved yet.
            delay(interval * 1000L)
            when (val answer = api.deviceLoginPoll(start.deviceCode)) {
                is com.zekktris.data.DeviceLoginPoll.Pending -> {
                    unreachable = 0
                    interval = answer.interval.coerceIn(1, 60)
                }
                is com.zekktris.data.DeviceLoginPoll.Approved ->
                    return DeviceLoginOutcome.Approved(answer.user)
                com.zekktris.data.DeviceLoginPoll.Denied -> return DeviceLoginOutcome.Denied
                com.zekktris.data.DeviceLoginPoll.Expired -> return DeviceLoginOutcome.Expired
                is com.zekktris.data.DeviceLoginPoll.Failed ->
                    return DeviceLoginOutcome.Failed(answer.message)
                com.zekktris.data.DeviceLoginPoll.Unavailable -> {
                    unreachable++
                    if (unreachable >= MAX_UNREACHABLE_POLLS) {
                        return DeviceLoginOutcome.Failed("Can't reach Zekktris. Check your connection.")
                    }
                }
            }
        }
        // The grant may have been approved in the last moments and be sitting
        // uncollected, but its 60s terminal TTL is nearly up and the user has
        // been staring at a dead code — treat it as expired and offer a retry.
        return DeviceLoginOutcome.Expired
    }

    /**
     * Finish a device-approval login once the user has seen whose account they
     * landed in. Runs on the store's scope so the phase flip — which unmounts
     * the calling screen — cannot cancel `loadInitial()` half-way and leave a
     * signed-in app with no guilds or DMs. Same shape as [login]'s tail.
     */
    fun completeDeviceLogin(user: SelfUser) {
        scope.launch { enterReady(user) }
    }

    // ---- passkeys (WebAuthn via CredentialManager) ---------------------------
    // [activity] must be an Activity context so the system passkey sheet presents.

    /** Sign in with a passkey. Silent no-op on user cancellation. */
    fun loginWithPasskey(activity: android.content.Context) {
        scope.launch {
            _state.update { it.copy(authBusy = true, authError = null) }
            try {
                val opt = api.passkeyLoginOptions()
                val responseJson = com.zekktris.auth.PasskeyManager.authenticate(activity, opt.options.toString())
                val user = api.passkeyLoginVerify(opt.challengeId, responseJson)
                enterReady(user)
            } catch (e: com.zekktris.auth.PasskeyCancelled) {
                _state.update { it.copy(authBusy = false) }
            } catch (e: com.zekktris.auth.PasskeyNoneAvailable) {
                _state.update { it.copy(authBusy = false, authError = "No passkey found on this device.") }
            } catch (e: Exception) {
                _state.update { it.copy(authBusy = false, authError = "Passkey sign-in failed.") }
            }
        }
    }

    suspend fun fetchPasskeys(): List<com.zekktris.data.model.PasskeyInfo> =
        runCatching { api.listPasskeys() }.getOrDefault(emptyList())

    /** Register a new passkey (password step-up required). Returns null on success,
     *  a sentinel-free error string, or null on user cancellation. */
    suspend fun addPasskey(activity: android.content.Context, currentPassword: String): String? = try {
        val opt = api.passkeyRegisterOptions()
        val responseJson = com.zekktris.auth.PasskeyManager.register(activity, opt.options.toString())
        api.passkeyRegisterVerify(opt.challengeId, responseJson, deviceName = android.os.Build.MODEL, currentPassword = currentPassword)
        null
    } catch (e: com.zekktris.auth.PasskeyCancelled) {
        null
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        e.message ?: "Couldn't add passkey."
    }

    suspend fun removePasskey(id: String, currentPassword: String): String? = try {
        api.deletePasskey(id, currentPassword)
        null
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: Exception) {
        e.message ?: "Couldn't remove passkey."
    }

    fun register(email: String, username: String, displayName: String, password: String, dateOfBirth: String, code: String? = null) {
        scope.launch {
            _state.update { it.copy(authBusy = true, authError = null) }
            val r = runCatching { api.register(email, username, displayName, password, dateOfBirth, code) }
                .getOrElse { LoginResult.Failure("Can't reach Zekktris. Check your connection.") }
            when (r) {
                is LoginResult.Success -> enterReady(r.user)
                LoginResult.Requires2FA -> _state.update { it.copy(authBusy = false) }
                is LoginResult.Failure -> _state.update { it.copy(authBusy = false, authError = r.message) }
            }
        }
    }

    fun clearAuthError() = _state.update { it.copy(authError = null) }

    fun logout() {
        scope.launch {
            gateway.stop()
            // Unregister this device's push token WHILE the session is still
            // valid, so a signed-out phone stops receiving this account's pushes.
            runCatching { push.deleteCurrentToken() }
            runCatching { api.logout() }
            // Drop all cached E2EE keys on sign-out (mirrors iOS keychain wipe),
            // and every decrypted plaintext derived from them.
            runCatching { e2eeStore.clearAll() }
            mediaCache.clear()
            // Same reason as forceSignOut: a signed-out phone must stop offering
            // this account's contacts in the system share sheet.
            clearShareShortcuts()
            com.zekktris.ui.screens.Drafts.clearAll(appContext)
            _state.value = AppState(phase = Phase.Auth)
        }
    }

    /**
     * Route in from a tapped notification. On a cold start we may not be
     * authenticated yet, so wait until the app reaches [Phase.Ready] before
     * opening the conversation. One-shot; harmless if never reached.
     */
    fun openFromNotification(channelId: String, messageId: String? = null) {
        scope.launch {
            state.first { it.phase == Phase.Ready }
            selectChannel(channelId, jumpToMessageId = messageId)
            // Guild-channel taps also prefill the composer as a reply to the
            // pushed message (iOS openFromPush, AppStore.swift:582-593). DMs
            // just land in the conversation.
            if (messageId != null) {
                val isDm = _state.value.dms.any { it.id == channelId }
                if (!isDm) _state.update { it.copy(pendingReplyPrefillId = messageId) }
            }
        }
    }

    // ---- system share sheet (Sharing Shortcuts) ------------------------------

    /** Debounces [refreshShareShortcuts]: a busy DM re-ranks on every message. */
    private var shareShortcutJob: kotlinx.coroutines.Job? = null

    /**
     * Has `GET /relationships` come back at least once THIS session?
     *
     * The blocked-peer filter in [refreshShareShortcuts] reads
     * `state.relationships`, which starts empty — so before the first successful
     * fetch, "no blocked users" and "we don't know yet" are the same value, and
     * publishing on the second one puts BLOCKED contacts in the system share
     * sheet. On a cold start those two things race: [loadInitial] kicks off the
     * fetch and arms the publish debounce back to back, and the debounce is only
     * [SHARE_SHORTCUT_DEBOUNCE_MS].
     *
     * So publishing waits for the answer instead of guessing at it, and
     * [refreshRelationships] republishes once it has one. A relationship fetch
     * that never succeeds therefore means no share targets at all this session —
     * deliberately: this is a convenience feature, and the failure direction that
     * costs a menu entry is strictly better than the one that leaks a contact the
     * user has blocked.
     */
    @Volatile
    private var relationshipsLoaded = false

    /**
     * Peers blocked from THIS device whose block the server has not yet echoed
     * back into `state.relationships`.
     *
     * Without this, "don't republish when the refresh fails" only holds until the
     * next unrelated trigger: the very next incoming DM calls
     * [refreshShareShortcuts], which filters on a relationship list that still
     * says this peer is fine — and the shortcut [blockUser] revoked comes back.
     * Unioning it into the filter makes a block stick for the session no matter
     * how long the server takes to agree.
     *
     * Erring toward over-filtering is the correct direction here: the worst case
     * is a conversation missing from a menu, versus a blocked person's name and
     * face still offered as a share target.
     */
    @Volatile
    private var locallyBlockedIds: Set<String> = emptySet()

    /** Peer ids that must never be published as share targets. */
    private fun blockedPeerIds(): Set<String> =
        _state.value.relationships.asSequence()
            .filter { it.type == "blocked" }
            .map { it.user.id }
            .toSet() + locallyBlockedIds

    /**
     * May we offer this account's conversations as share targets at all?
     * Mirrors iOS `shareSuggestionsAllowed` (AppStore.swift:1877-1882).
     *
     * Every published entry is a contact's name + face sitting in the share
     * sheet of EVERY other app on the device — outside Zekktris, and outside the
     * biometric app lock — so a supervised account that isn't allowed to DM must
     * not publish at all. An unsupervised account has no restrictions blob and
     * is always allowed.
     */
    private val shareShortcutsAllowed: Boolean
        get() {
            val f = _state.value.family ?: return true
            if (f.restrictedHeavily == true) return false
            val r = f.restrictions ?: return true
            return r.allowMessaging && r.dmPolicy != "none"
        }

    /** Latches the supervision wipe to the TRANSITION into "not allowed", so a
     *  restricted account doesn't re-run it on every DM event it receives. */
    private var shareShortcutsSuppressed = false

    /**
     * Apply [shareShortcutsAllowed]. Returns true when publishing may proceed;
     * on the way into "not allowed" it also wipes whatever is already published,
     * because supervision can be revoked long after the donations landed (a
     * parent flips a switch, the grace period lapses into restricted-heavily).
     * iOS does the same at the end of loadFamily (AppStore.swift:4347).
     */
    private fun enforceShareShortcutSupervision(): Boolean {
        if (shareShortcutsAllowed) {
            shareShortcutsSuppressed = false
            return true
        }
        if (!shareShortcutsSuppressed) {
            shareShortcutsSuppressed = true
            clearShareShortcuts()
        }
        return false
    }

    /**
     * (Re)publish the most recent 1:1 DMs as direct-share targets in the system
     * share sheet. Debounced, and a no-op when the ordering/names/avatars are
     * unchanged (see [ShareShortcuts.publish]).
     *
     * Group DMs are deliberately excluded: a Sharing Shortcut carries a single
     * [androidx.core.app.Person], and putting a whole group's members behind one
     * system-level entry is both wrong semantically and a wider name leak than
     * this feature is worth.
     */
    fun refreshShareShortcuts() {
        if (_state.value.phase != Phase.Ready) return
        // Supervision gate — and, on the transition, the retroactive wipe.
        if (!enforceShareShortcutSupervision()) return
        com.zekktris.share.ShareShortcuts.enable()
        shareShortcutJob?.cancel()
        shareShortcutJob = scope.launch {
            delay(SHARE_SHORTCUT_DEBOUNCE_MS)
            // Re-read the supervision verdict after the wait: on a cold start the
            // family snapshot is still in flight when this is first scheduled.
            // (If it landed and said no, refreshFamily has already cancelled this
            // job — this is the belt to that pair of braces.)
            if (!shareShortcutsAllowed) return@launch
            // Same shape of race, for the blocked-peer filter: an empty
            // `relationships` means "not fetched yet" just as often as it means
            // "nobody blocked", and this delay is easily shorter than the fetch.
            // Bail rather than publish an unfiltered set — the fetch republishes
            // when it lands (see [relationshipsLoaded]).
            if (!relationshipsLoaded) return@launch
            // Read the list AFTER the delay so a burst publishes once, in its
            // final order.
            val meId = _state.value.me?.id
            // A blocked peer must not stay published as a share target.
            val blocked = blockedPeerIds()
            val contacts = _state.value.dms.asSequence()
                .filter { it.type == "dm" }
                .mapNotNull { ch ->
                    val peer = ch.recipients?.firstOrNull { it.id != meId }
                        ?: ch.recipients?.firstOrNull()
                        ?: return@mapNotNull null
                    if (peer.id in blocked) return@mapNotNull null
                    com.zekktris.share.ShareShortcuts.Contact(
                        channelId = ch.id,
                        userId = peer.id,
                        // The viewer's private DM nickname wins, exactly as it
                        // does in the DM list and chat header.
                        name = dmNickname(peer.id) ?: peer.bestName,
                        avatarUrl = peer.avatarUrl,
                    )
                }
                .take(com.zekktris.share.ShareShortcuts.maxCount(appContext))
                .toList()
            com.zekktris.share.ShareShortcuts.publish(appContext, contacts)
        }
    }

    /** Revoke every published share target. Both sign-out paths call this. */
    private fun clearShareShortcuts() {
        shareShortcutJob?.cancel()
        shareShortcutJob = null
        runCatching { com.zekktris.share.ShareShortcuts.removeAll(appContext) }
    }

    /**
     * Withdraw the share targets of every currently-blocked peer.
     *
     * A republish alone is not enough: it drops them from the DYNAMIC set but
     * does not evict the system's CACHED copy of a long-lived shortcut, so the
     * blocked person's name and face can survive in the share sheet. Explicit
     * removal is the only thing that evicts it.
     *
     * Uses `removePublished`, which intersects with the persisted id set, so this
     * is a no-op (no system write, no forced republish) once the revocation has
     * happened — cheap enough to run on every relationship refresh.
     */
    private fun revokeBlockedShareShortcuts() {
        val blocked = blockedPeerIds()
        if (blocked.isEmpty()) return
        val ids = _state.value.dms
            .filter { ch -> ch.type == "dm" && ch.recipients.orEmpty().any { it.id in blocked } }
            .map { it.id }
        runCatching { com.zekktris.share.ShareShortcuts.removePublished(appContext, ids) }
    }

    /**
     * The system share sheet handed us a payload. [channelId] is the shortcut id
     * of the contact the user picked (our DM channel id), or null when they
     * chose the app itself rather than a direct-share target.
     *
     * Like [openFromNotification] this can arrive on a cold start before the
     * session is restored, so it waits for [Phase.Ready] rather than dropping
     * the payload.
     */
    fun handleShare(channelId: String?, text: String?, uris: List<String>) {
        if (text.isNullOrBlank() && uris.isEmpty()) return
        scope.launch {
            state.first { it.phase == Phase.Ready }
            if (channelId != null) {
                // The target may have aged out of the cached list (opened on
                // another device, or the shortcut outlived a closed DM).
                if (_state.value.dms.none { it.id == channelId }) {
                    runCatching { api.listDMs() }.getOrNull()?.let { fresh ->
                        _state.update { it.copy(dms = sortDms(fresh)) }
                    }
                }
                if (_state.value.dms.any { it.id == channelId }) {
                    clearOverlaysForShare()
                    selectChannel(channelId)
                    _state.update { it.copy(pendingShare = PendingShare(channelId, text, uris)) }
                    return@launch
                }
                // Target really is gone: drop the stale shortcut and fall
                // through, so the user picks a conversation instead of losing
                // whatever they were sharing.
                runCatching { com.zekktris.share.ShareShortcuts.remove(appContext, channelId) }
            }
            clearOverlaysForShare()
            _state.update {
                it.copy(
                    selectedChannelId = null,
                    homeTab = HomeTab.Dms,
                    pendingShare = PendingShare(null, text, uris),
                )
            }
        }
    }

    /** Drop every full-screen overlay so the share actually lands somewhere visible. */
    private fun clearOverlaysForShare() = _state.update {
        it.copy(
            showSettings = false,
            railPage = null,
            guildSettingsFor = null,
            channelPermsFor = null,
            selectedGuildId = null,
        )
    }

    /** Composer took the payload (or decided it isn't for this channel). */
    fun consumePendingShare() = _state.update { it.copy(pendingShare = null) }

    // ---- navigation ---------------------------------------------------------

    /**
     * Re-read who is in voice across a whole server and replace our copy.
     *
     * The voice lists under channel rows were built from VOICE_STATE_UPDATE
     * frames alone, so one dropped frame left people invisible to everyone
     * outside the call until somebody joined — whose snapshot then made them
     * all appear at once. Other servers and DM calls are left alone.
     */
    fun reconcileGuildVoice(guildId: String) {
        scope.launch {
            val states = runCatching { api.listGuildVoiceStates(guildId) }.getOrNull() ?: return@launch
            val present = states.map { it.userId }.toSet()
            _state.update { st ->
                val next = st.voiceStates
                    .filterNot { (userId, vs) -> vs.guildId == guildId && userId !in present }
                    .toMutableMap()
                for (vs in states) if (vs.channelId != null) next[vs.userId] = vs
                if (next == st.voiceStates) st else st.copy(voiceStates = next)
            }
        }
    }

    fun selectGuild(guildId: String?) {
        // Heal the voice roster for the server being opened: that is exactly
        // when the user looks at who is in its voice channels.
        guildId?.let { reconcileGuildVoice(it) }
        val switching = guildId != _state.value.selectedGuildId
        // Switching context always drops back to the list (never jumps into chat).
        // Only wipe the custom emoji when moving to a DIFFERENT guild — re-selecting
        // the same guild must keep them so a re-entered chat doesn't flash literal
        // :name: before the re-fetch resolves.
        _state.update {
            it.copy(
                selectedGuildId = guildId, selectedChannelId = null, railPage = null,
                guildEmojis = if (switching) emptyList() else it.guildEmojis,
            )
        }
        if (guildId == null) return
        scope.launch {
            if (_state.value.channelsByGuild[guildId] == null) {
                val channels = runCatching { api.listChannels(guildId) }.getOrDefault(emptyList())
                _state.update { it.copy(channelsByGuild = it.channelsByGuild + (guildId to channels)) }
                loadMembers(guildId)
            }
            if (_state.value.rolesByGuild[guildId] == null) loadRoles(guildId)
            // Fetch the guild's custom emoji only when we don't already hold them
            // (best-effort; empty if none/denied).
            if (switching || _state.value.guildEmojis.isEmpty()) {
                val emojis = runCatching { api.listGuildEmojis(guildId) }.getOrDefault(emptyList())
                if (_state.value.selectedGuildId == guildId) {
                    _state.update { it.copy(guildEmojis = emojis) }
                }
            }
        }
    }

    /** Rail: DMs bubble — home content shows the DM list. */
    fun showDMs() = _state.update {
        it.copy(selectedGuildId = null, homeTab = HomeTab.Dms, railPage = null, guildEmojis = emptyList())
    }

    /** Rail: @ bubble — home content shows Mentions. */
    fun showMentions() = _state.update {
        it.copy(selectedGuildId = null, homeTab = HomeTab.Mentions, railPage = null, guildEmojis = emptyList())
    }

    /** Open a full-screen rail overlay (Discover / Create / Join / Admin / Family). */
    fun openRailPage(page: RailPage) = _state.update { it.copy(railPage = page) }
    fun closeRailPage() = _state.update { it.copy(railPage = null) }

    // ---- discovery / invites / create server --------------------------------

    /** Normalize a pasted invite ("https://<server>/invite/abc" → "abc"). */
    private fun cleanInviteCode(raw: String): String {
        val t = raw.trim()
        return t.substringAfterLast("/").ifBlank { t }
    }

    fun loadDiscoverable(query: String? = null, category: String? = null) {
        scope.launch {
            _state.update { it.copy(loadingDiscoverable = true) }
            val list = runCatching { api.listDiscoverable(query, category) }.getOrDefault(emptyList())
            _state.update { it.copy(discoverable = list, loadingDiscoverable = false) }
        }
    }

    fun joinDiscoverable(guildId: String) {
        scope.launch {
            runCatching { api.joinDiscoverable(guildId) }
            val guilds = runCatching { api.listGuilds() }.getOrDefault(_state.value.guilds)
            _state.update { s -> s.copy(guilds = guilds, discoverable = s.discoverable.filterNot { it.id == guildId }) }
            selectGuild(guildId)
        }
    }

    /** Look up an invite for preview (suspend so the screen can await it). */
    suspend fun previewInvite(code: String): InvitePreview? =
        runCatching { api.previewInvite(cleanInviteCode(code)) }.getOrNull()

    /** Accept an invite; on success reloads guilds + navigates in. */
    fun joinByInvite(code: String, onDone: (Boolean) -> Unit) {
        scope.launch {
            val res = runCatching { api.acceptInvite(cleanInviteCode(code)) }.getOrNull()
            if (res != null) {
                val guilds = runCatching { api.listGuilds() }.getOrDefault(_state.value.guilds)
                _state.update { it.copy(guilds = guilds) }
                selectGuild(res.guildId)
            }
            onDone(res != null)
        }
    }

    /** Create a server; on success reloads guilds + navigates in.
     *  Optional icon/banner are (bytes, mime, filename) triples uploaded to the
     *  fresh guild BEFORE the reload — mirrors iOS AppStore.createServer, so the
     *  loaded guild already carries the images. Uploads are best-effort: a
     *  failed image never fails the create. */
    fun createGuild(
        name: String,
        description: String?,
        icon: Triple<ByteArray, String, String>? = null,
        banner: Triple<ByteArray, String, String>? = null,
        onDone: (Boolean) -> Unit,
    ) {
        scope.launch {
            val g = runCatching { api.createGuild(name, description) }.getOrNull()
            if (g != null) {
                icon?.let { (bytes, mime, fn) ->
                    runCatching { api.uploadGuildIcon(g.id, fn, mime, bytes) }
                }
                banner?.let { (bytes, mime, fn) ->
                    runCatching { api.uploadGuildBanner(g.id, fn, mime, bytes) }
                }
                val guilds = runCatching { api.listGuilds() }.getOrDefault(_state.value.guilds)
                _state.update { it.copy(guilds = guilds) }
                selectGuild(g.id)
            }
            onDone(g != null)
        }
    }

    // ---- family / parental controls -----------------------------------------

    private suspend fun refreshFamily() {
        val f = runCatching { api.familyMe() }.getOrNull()
        // Keep the last good snapshot when the fetch fails, as iOS does (its
        // loadFamily `catch` leaves `family` untouched). Nulling it out would
        // read as "unsupervised" and silently re-open every supervision gate —
        // including [shareShortcutsAllowed] below.
        _state.update { it.copy(family = f ?: it.family, loadingFamily = false) }
        // Supervision can revoke DMs at any time, and anything published while
        // messaging was still allowed is sitting in the SYSTEM share sheet right
        // now. Withdraw it here (mirrors the tail of iOS `loadFamily`).
        //
        // `family` only ever changes when [refreshFamily] runs, so this is where
        // the wipe lands: at startup ([loadInitial]), on opening Parental
        // Controls, after a family mutation made from this device, and on a
        // FAMILY_* gateway event. That last trigger now includes
        // FAMILY_SUPERVISION_UPDATE — pushed to the subject after ANY write that
        // changes what they may do — so "the parent flips the switch on theirs"
        // and "the wipe runs here" are a round-trip apart rather than a cold
        // start apart. The other [enforceShareShortcutSupervision] caller
        // ([refreshShareShortcuts]) wipes on the same transition off the same
        // snapshot, so it is a second place the wipe can fire, not a second
        // clock. With the socket down it degrades to the old polled behavior:
        // an already-published set stays in the sheet until the next trigger.
        // (A failed fetch keeps the last good snapshot above, so an outage can
        // neither trigger this wipe nor silently re-open the gate.)
        enforceShareShortcutSupervision()
    }

    fun loadFamily() {
        scope.launch { _state.update { it.copy(loadingFamily = true) }; refreshFamily() }
    }

    fun familyRequestLink(username: String) {
        scope.launch { runCatching { api.familyRequestLink(username.trim()) }; refreshFamily() }
    }

    fun familyRemove(otherId: String) {
        scope.launch { runCatching { api.familyRemoveLink(otherId) }; refreshFamily() }
    }

    fun familyAcceptLink(parentId: String) {
        scope.launch { runCatching { api.familyAcceptLink(parentId) }; refreshFamily() }
    }

    fun familyAcceptChild(childId: String) {
        scope.launch { runCatching { api.familyAcceptChild(childId) }; refreshFamily() }
    }

    fun familyRequestParent(email: String) {
        scope.launch { runCatching { api.familyRequestParent(email.trim()) }; refreshFamily() }
    }

    fun loadChildRestrictions(childId: String) {
        scope.launch {
            val r = runCatching { api.childRestrictions(childId) }.getOrNull() ?: return@launch
            _state.update { it.copy(childRestrictions = it.childRestrictions + (childId to r)) }
        }
    }

    /** Optimistically apply a child's toggles, then PATCH and reconcile with the echo. */
    fun setChildRestrictions(childId: String, r: ChildRestrictions) {
        _state.update { it.copy(childRestrictions = it.childRestrictions + (childId to r)) }
        scope.launch {
            val echoed = runCatching { api.setChildRestrictions(childId, r) }.getOrNull()
            if (echoed != null) {
                _state.update { it.copy(childRestrictions = it.childRestrictions + (childId to echoed)) }
            }
        }
    }

    // ---- family child oversight (screen-local, suspend-fetch pattern) -------

    suspend fun familyWatchWords(childId: String): List<String> =
        runCatching { api.familyWatchWords(childId) }.getOrDefault(emptyList())
    suspend fun familyAddWatchWord(childId: String, word: String): List<String>? =
        runCatching { api.addWatchWord(childId, word.trim()) }.getOrNull()
    suspend fun familyRemoveWatchWord(childId: String, word: String): List<String>? =
        runCatching { api.removeWatchWord(childId, word) }.getOrNull()
    suspend fun familyChildFlags(childId: String): List<com.zekktris.data.model.FamilyFlag> =
        runCatching { api.familyChildFlags(childId) }.getOrDefault(emptyList())
    fun familyMarkFlagReviewed(flagId: String, onDone: () -> Unit = {}) {
        scope.launch { runCatching { api.markFlagReviewed(flagId) }; onDone() }
    }
    suspend fun familyChildGuilds(childId: String): List<com.zekktris.data.model.ChildGuild> =
        runCatching { api.familyChildGuilds(childId) }.getOrDefault(emptyList())
    suspend fun familySetGuildBlocked(childId: String, guildId: String, blocked: Boolean): Boolean =
        runCatching { api.familySetGuildBlocked(childId, guildId, blocked) }.isSuccess
    suspend fun familyChildFriends(childId: String): List<com.zekktris.data.model.ChildRelationship> =
        runCatching { api.familyChildFriends(childId) }.getOrDefault(emptyList())
    suspend fun familySetUserBlocked(childId: String, userId: String, blocked: Boolean): Boolean =
        runCatching { api.familySetUserBlocked(childId, userId, blocked) }.isSuccess
    suspend fun familyChildDMs(childId: String): List<com.zekktris.data.model.ChildDM> =
        runCatching { api.familyChildDMs(childId) }.getOrDefault(emptyList())
    suspend fun familyChildDMMessages(childId: String, channelId: String): List<com.zekktris.data.model.PeekMessage> =
        runCatching { api.familyChildDMMessages(childId, channelId) }.getOrDefault(emptyList())

    // ---- admin instance -----------------------------------------------------

    fun loadAdminOverview() {
        scope.launch {
            _state.update { it.copy(loadingAdmin = true) }
            val s = runCatching { api.adminStats() }.getOrNull()
            val m = runCatching { api.adminMetrics() }.getOrNull()
            _state.update { it.copy(adminStats = s, adminMetrics = m, loadingAdmin = false) }
        }
    }

    fun loadAdminUsers(query: String? = null, bannedOnly: Boolean = false) {
        scope.launch {
            val u = runCatching { api.adminUsers(query, bannedOnly) }.getOrDefault(emptyList())
            _state.update { it.copy(adminUsers = u) }
        }
    }

    fun loadAdminGuilds(query: String? = null) {
        scope.launch {
            val g = runCatching { api.adminGuilds(query) }.getOrDefault(emptyList())
            _state.update { it.copy(adminGuilds = g) }
        }
    }

    fun loadAdminStorage() {
        scope.launch {
            val s = runCatching { api.adminStorage() }.getOrNull()
            _state.update { it.copy(adminStorage = s) }
        }
    }

    fun adminBan(userId: String, duration: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminBanUser(userId, duration) }; reload() }
    }

    /**
     * [ADMIN ONLY] Who this user exchanges 1:1 DMs with. Suspend rather than
     * fire-and-forget because the screen renders the result directly. `api` is
     * private, so screens reach it through here.
     */
    suspend fun adminUserDmPeers(userId: String) = api.adminUserDmPeers(userId)

    /**
     * Admin → Account Info. One passthrough rather than a wrapper per endpoint:
     * the page runs each call itself so it can report the SERVER's message
     * inline ("That username is taken.") instead of the fire-and-forget
     * pattern above, which swallows failures. `api` stays private.
     */
    suspend fun <T> adminCall(block: suspend com.zekktris.data.ApiClient.() -> T): T = api.block()

    /** Keep the Users list in step with what the Account Info page just did. */
    fun patchAdminUser(userId: String, transform: (com.zekktris.data.model.AdminUser) -> com.zekktris.data.model.AdminUser) {
        _state.update { st -> st.copy(adminUsers = st.adminUsers.map { if (it.id == userId) transform(it) else it }) }
    }

    fun removeAdminUser(userId: String) {
        _state.update { st -> st.copy(adminUsers = st.adminUsers.filterNot { it.id == userId }) }
    }

    fun adminUnban(userId: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminUnbanUser(userId) }; reload() }
    }

    fun adminSetRole(userId: String, role: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminSetRole(userId, role) }; reload() }
    }

    fun adminDeleteUser(userId: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminDeleteUser(userId) }; reload() }
    }

    fun adminLogoutUser(userId: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminLogoutUser(userId) }; reload() }
    }

    fun adminResetDobLock(userId: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminResetDobLock(userId) }; reload() }
    }

    fun adminGiftSubscription(userId: String, tier: String, duration: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminGiftSubscription(userId, tier, duration) }; reload() }
    }

    fun adminRemoveSubscription(userId: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminRemoveSubscription(userId) }; reload() }
    }

    fun adminDeleteGuild(guildId: String, reload: () -> Unit) {
        scope.launch { runCatching { api.adminDeleteGuild(guildId) }; reload() }
    }

    fun runStorageGc() {
        scope.launch {
            runCatching { api.adminStorageGc() }
            val s = runCatching { api.adminStorage() }.getOrNull()
            _state.update { it.copy(adminStorage = s) }
        }
    }

    suspend fun adminActivity(): com.zekktris.data.model.AdminActivity? =
        runCatching { api.adminActivity() }.getOrNull()

    suspend fun adminStorageItems(page: Int, sort: String): com.zekktris.data.model.StorageListing =
        runCatching { api.adminStorageItems(page, sort) }.getOrDefault(com.zekktris.data.model.StorageListing())
    suspend fun adminDeleteStorageItem(id: String): Boolean =
        runCatching { api.adminDeleteStorageItem(id) }.isSuccess
    suspend fun adminCompressStorageItem(id: String): Boolean =
        runCatching { api.adminCompressStorageItem(id) }.isSuccess
    suspend fun adminPeekGuild(guildId: String): com.zekktris.data.model.PeekGuildResult? =
        runCatching { api.adminPeekGuild(guildId) }.getOrNull()
    suspend fun adminPeekMessages(channelId: String): List<com.zekktris.data.model.PeekMessage> =
        runCatching { api.adminPeekMessages(channelId) }.getOrDefault(emptyList())

    // ---- pokes / per-DM settings ---------------------------------------------

    /** Send a poke; the server's 429 rate-limit message surfaces via onError. */
    fun poke(channelId: String, pokeType: String, onError: (String) -> Unit = {}) {
        scope.launch {
            runCatching { api.poke(channelId, pokeType) }
                .onFailure { onError((it as? com.zekktris.data.ApiException)?.message ?: "Couldn't poke.") }
        }
    }

    suspend fun pokeHistory(channelId: String) =
        runCatching { api.listPokes(channelId) }.getOrDefault(emptyList())

    fun dismissPokeBanner() = _state.update { it.copy(pokeBanner = null) }
    fun dismissAchievementBanner() = _state.update { it.copy(achievementBanner = null) }

    /** Tap the banner body: open the sender's DM. */
    fun openPokeSender() {
        val banner = _state.value.pokeBanner ?: return
        dismissPokeBanner()
        if (banner.channelId.isNotEmpty()) selectChannel(banner.channelId)
    }

    /** Tap the banner's emoji chip: send the SAME variant back. */
    fun pokeBack() {
        val banner = _state.value.pokeBanner ?: return
        dismissPokeBanner()
        if (banner.channelId.isNotEmpty()) poke(banner.channelId, banner.pokeType)
    }

    suspend fun getDmSettings(channelId: String) =
        runCatching { api.getDmSettings(channelId) }.getOrNull()

    /** One page of the shared-media gallery (newest-first; null = request
     *  failed). `kind` = "media"/"files" server-filters by content type; E2EE
     *  channels pass null (ciphertext hides the real type) and the gallery
     *  buckets by the inner `.zke` filename instead. */
    suspend fun channelAttachments(
        channelId: String,
        before: String? = null,
        kind: String? = null,
    ): List<com.zekktris.data.model.Attachment>? =
        runCatching { api.listChannelAttachments(channelId, before = before, kind = kind) }.getOrNull()

    suspend fun setDmTtl(channelId: String, ttlSeconds: Int?): Boolean =
        runCatching { api.setDmTtl(channelId, ttlSeconds) }.isSuccess

    suspend fun setNotificationPreview(channelId: String, showContent: Boolean?): Boolean =
        runCatching { api.setNotificationPreview(channelId, showContent) }.isSuccess

    /** Close (hide) a DM, then drop it from the list + deselect. */
    fun closeDm(channelId: String) {
        scope.launch {
            runCatching { api.closeDm(channelId) }
            _state.update {
                it.copy(
                    dms = it.dms.filterNot { d -> d.id == channelId },
                    selectedChannelId = if (it.selectedChannelId == channelId) null else it.selectedChannelId,
                )
            }
            // A closed conversation must stop being offered by the system share
            // sheet immediately — the long-lived shortcut would otherwise keep
            // showing that person's name and face there indefinitely.
            runCatching { com.zekktris.share.ShareShortcuts.remove(appContext, channelId) }
            refreshShareShortcuts()
        }
    }

    // ---- E2EE (shared-key DM encryption) -------------------------------------

    private fun dmById(channelId: String): Channel? =
        _state.value.dms.firstOrNull { it.id == channelId }
            ?: _state.value.channelsByGuild.values.asSequence().flatten().firstOrNull { it.id == channelId }

    /**
     * The stored key for [channelId], but ONLY while it still matches the
     * channel's CURRENT verifier (iOS `e2eeKey(for: channel)`). When the peer
     * turns encryption off and back on with a new passphrase the DM is re-keyed,
     * and the stale local key would otherwise fail every decrypt forever without
     * the UI ever re-prompting for the password. Drop it — and the plaintext
     * derived from it — so the conversation re-locks and asks. Verifier absent
     * (channel not loaded yet, e.g. an FCM-woken process) ⇒ trust the key.
     */
    private fun e2eeKeyFor(channelId: String): ByteArray? {
        val key = e2eeStore.key(channelId) ?: return null
        val expected = dmById(channelId)?.e2eeVerifier ?: return key
        if (com.zekktris.crypto.E2EE.verifier(key) != expected) {
            e2eeStore.remove(channelId)
            mediaCache.clear()
            markUnlocked(channelId, false)
            return null
        }
        return key
    }

    /** True when we hold this DM's key locally (can read + send encrypted). */
    fun hasE2EEKey(channelId: String): Boolean = e2eeKeyFor(channelId) != null

    /** Render a stored message for display: decrypt E2EE content when unlocked,
     *  else a lock tombstone; non-encrypted content passes through unchanged. */
    fun renderContent(channelId: String, content: String): String {
        if (!com.zekktris.crypto.E2EE.isEncrypted(content)) return content
        val key = e2eeKeyFor(channelId)
        if (key != null && com.zekktris.crypto.E2EE.isDecryptable(content)) {
            return com.zekktris.crypto.E2EE.decrypt(content, key) ?: "🔒 Couldn't decrypt"
        }
        return "🔒 Encrypted message"
    }

    private fun markUnlocked(channelId: String, unlocked: Boolean) {
        _state.update {
            it.copy(e2eeUnlocked = if (unlocked) it.e2eeUnlocked + channelId else it.e2eeUnlocked - channelId)
        }
    }

    /** Reflect stored-key state into e2eeUnlocked when a DM opens (for the UI). */
    fun refreshE2EEUnlocked(channelId: String) {
        if (hasE2EEKey(channelId)) markUnlocked(channelId, true)
    }

    /**
     * Fetch + decrypt an encrypted (.zke) attachment with the channel key.
     * Plaintext lives in [mediaCache] ONLY (in-memory LRU) — never on disk.
     * Null when the key isn't held, the download fails, or the blob doesn't
     * verify. Crypto runs off-main; safe to call from a LaunchedEffect.
     */
    suspend fun decryptedAttachment(channelId: String, att: com.zekktris.data.model.Attachment): ByteArray? {
        mediaCache.get(att.id)?.let { return it }
        val key = e2eeKeyFor(channelId) ?: return null
        val url = com.zekktris.data.Config.absoluteUrl(att.url) ?: return null
        val blob = api.fetchBytes(url) ?: return null
        val plain = withContext(Dispatchers.Default) { com.zekktris.crypto.E2EE.decryptBytes(blob, key) }
            ?: return null
        // Don't cache stale plaintext if the key vanished while we were off-main
        // (E2EE disabled / signed out / re-keyed mid-download).
        if (e2eeKeyFor(channelId) == null) return null
        mediaCache.put(att.id, plain)
        return plain
    }

    /**
     * Fetch + decrypt the SMALL encrypted thumbnail (thumb.zke) for an
     * attachment — far fewer bytes than the full blob, used by inline rows.
     * Cached under "<id>:thumb" so it never collides with the full image.
     * Null when there's no thumbnail (older messages) — callers fall back to
     * [decryptedAttachment].
     */
    suspend fun decryptedThumbnail(channelId: String, att: com.zekktris.data.model.Attachment): ByteArray? {
        val thumbUrl = att.thumbnailUrl ?: return null
        val cacheKey = att.id + ":thumb"
        mediaCache.get(cacheKey)?.let { return it }
        val key = e2eeKeyFor(channelId) ?: return null
        val url = com.zekktris.data.Config.absoluteUrl(thumbUrl) ?: return null
        val blob = api.fetchBytes(url) ?: return null
        val plain = withContext(Dispatchers.Default) { com.zekktris.crypto.E2EE.decryptBytes(blob, key) }
            ?: return null
        if (e2eeKeyFor(channelId) == null) return null
        mediaCache.put(cacheKey, plain)
        return plain
    }

    /** Enable E2EE on a DM: derive a key from [password], register salt+verifier,
     *  and store the key. onResult(true) on success. */
    fun enableE2EE(channelId: String, password: String, onResult: (Boolean) -> Unit) {
        scope.launch {
            val salt = com.zekktris.crypto.E2EE.generateSalt()
            val key = withContext(kotlinx.coroutines.Dispatchers.Default) { com.zekktris.crypto.E2EE.deriveKey(password, salt) }
            if (key == null) { onResult(false); return@launch }
            val verifier = com.zekktris.crypto.E2EE.verifier(key)
            val ok = runCatching { api.enableDmE2EE(channelId, salt, verifier) }.isSuccess
            if (ok) {
                e2eeStore.put(channelId, key)
                _state.update { st ->
                    st.copy(
                        dms = st.dms.map { if (it.id == channelId) it.copy(e2eeEnabled = true, e2eeSalt = salt, e2eeVerifier = verifier) else it },
                        e2eeUnlocked = st.e2eeUnlocked + channelId,
                    )
                }
            }
            onResult(ok)
        }
    }

    /** Unlock an already-E2EE DM: derive from [password] + the channel salt and
     *  verify against the stored verifier before caching the key. */
    fun unlockE2EE(channelId: String, password: String, onResult: (Boolean) -> Unit) {
        scope.launch {
            val ch = dmById(channelId)
            val salt = ch?.e2eeSalt
            val verifier = ch?.e2eeVerifier
            if (salt == null || verifier == null) { onResult(false); return@launch }
            val key = withContext(kotlinx.coroutines.Dispatchers.Default) { com.zekktris.crypto.E2EE.deriveKey(password, salt) }
            if (key == null || com.zekktris.crypto.E2EE.verifier(key) != verifier) { onResult(false); return@launch }
            e2eeStore.put(channelId, key)
            markUnlocked(channelId, true)
            onResult(true)
        }
    }

    /** Turn E2EE off (server purges encrypted history). Requires the key. */
    fun disableE2EE(channelId: String, onResult: (Boolean) -> Unit) {
        scope.launch {
            val key = e2eeKeyFor(channelId)
            if (key == null) { onResult(false); return@launch }
            val verifier = com.zekktris.crypto.E2EE.verifier(key)
            val ok = runCatching { api.disableDmE2EE(channelId, verifier) }.isSuccess
            if (ok) {
                e2eeStore.remove(channelId)
                // Decrypted media is plaintext derived from the (now-dropped)
                // key — it must not outlive it.
                mediaCache.clear()
                _state.update { st ->
                    st.copy(
                        dms = st.dms.map { if (it.id == channelId) it.copy(e2eeEnabled = false, e2eeSalt = null, e2eeVerifier = null) else it },
                        e2eeUnlocked = st.e2eeUnlocked - channelId,
                    )
                }
            }
            onResult(ok)
        }
    }

    fun setDmReadReceipts(enabled: Boolean) = patchProfile(
        com.zekktris.data.model.ProfilePatch(dmReadReceiptsEnabled = enabled),
    )

    // Account-level Notification / Privacy toggles — each is a partial
    // PATCH /users/@me; unset fields drop out of the JSON body. (Only the
    // toggles iOS actually exposes: no notifyReactions / allowDms controls.)
    fun setNotifyAchievements(enabled: Boolean) = patchProfile(
        com.zekktris.data.model.ProfilePatch(notifyAchievements = enabled),
    )
    fun setAchievementsPublic(enabled: Boolean) = patchProfile(
        com.zekktris.data.model.ProfilePatch(achievementsPublic = enabled),
    )
    fun setShowSubscriptionTier(enabled: Boolean) = patchProfile(
        com.zekktris.data.model.ProfilePatch(showSubscriptionTier = enabled),
    )

    /** Optimistically flip `me` then PATCH; reconcile with the server echo. */
    private fun patchProfile(patch: com.zekktris.data.model.ProfilePatch) {
        scope.launch {
            val updated = runCatching { api.updateProfile(patch) }.getOrNull()
            if (updated != null) _state.update { it.copy(me = updated) }
        }
    }

    /** Set the cosmetic avatar decoration ("none" clears it). */
    fun setAvatarDecoration(id: String) = patchProfile(com.zekktris.data.model.ProfilePatch(avatarDecoration = id))

    /** Set (or clear via blank label) the name tag pill + its color. */
    fun setNameTag(label: String, color: String?) = patchProfile(
        com.zekktris.data.model.ProfilePatch(tagLabel = label, tagColor = if (label.isBlank()) null else color),
    )

    /** Staff-only display-name shimmer color (#rrggbb to enable, null to turn
        off). Uses the explicit-null API path so "off" actually clears it. */
    fun setStaffShimmer(hex: String?) {
        scope.launch {
            val updated = runCatching { api.setStaffColor(hex) }.getOrNull()
            if (updated != null) _state.update { it.copy(me = updated) }
        }
    }

    fun setStaffGlow(on: Boolean) {
        scope.launch {
            val updated = runCatching { api.setStaffGlow(on) }.getOrNull()
            if (updated != null) _state.update { it.copy(me = updated) }
        }
    }

    /** Upload a new avatar/banner image (bytes already read off-main by the caller). */
    fun uploadAvatar(filename: String, mime: String, bytes: ByteArray) {
        scope.launch {
            val updated = runCatching { api.uploadMyAvatar(filename, mime, bytes) }.getOrNull()
            if (updated != null) _state.update { it.copy(me = updated) }
        }
    }

    fun uploadBanner(filename: String, mime: String, bytes: ByteArray) {
        scope.launch {
            val updated = runCatching { api.uploadMyBanner(filename, mime, bytes) }.getOrNull()
            if (updated != null) _state.update { it.copy(me = updated) }
        }
    }

    /** Save (or clear) the custom status. Blank text clears it. */
    fun setCustomStatus(text: String, emoji: String, expiresAt: String?, onDone: () -> Unit = {}) {
        scope.launch {
            val updated = runCatching { api.updateCustomStatus(text, emoji, expiresAt) }.getOrNull()
            if (updated != null) _state.update { it.copy(me = updated) }
            onDone()
        }
    }

    // ---- admin security / monetization (screen-local, iOS pattern) ----------

    // The three READS hand back the Result: a 403/500 must not be swallowed into
    // an empty list, which the Security tab would render as "nothing logged" —
    // indistinguishable from a genuinely clean instance. Sole caller is
    // ui/screens/AdminSecurityTabs.kt, which surfaces the failure.
    suspend fun adminSecurityEvents(kind: String?) = runCatching { api.adminSecurityEvents(kind) }
    suspend fun adminSecurityConfig() = runCatching { api.adminSecurityConfig() }
    suspend fun adminSecurityWords() = runCatching { api.adminSecurityWords() }
    suspend fun adminSecurityWordPreset() = runCatching { api.adminSecurityWordPreset() }

    // Mutations keep the null-on-failure shape: the caller re-renders the last
    // good list rather than clobbering it.
    suspend fun adminPatchSecurityConfig(c: com.zekktris.data.model.SecurityConfig) =
        runCatching { api.adminPatchSecurityConfig(c) }.getOrNull()
    suspend fun adminAddSecurityWord(word: String, severity: String) =
        runCatching { api.adminAddSecurityWord(word, severity) }.getOrNull()
    suspend fun adminRemoveSecurityWord(word: String) =
        runCatching { api.adminRemoveSecurityWord(word) }.getOrNull()
    suspend fun adminApplyWordPreset() = runCatching { api.adminApplyWordPreset() }.getOrNull()
    // Both also refresh the entitlement cache below, so an admin editing the
    // matrix (or any screen simply reading it) can't leave the publish-time
    // camera clamp running on a stale one. A failure leaves the last good
    // config in place: a flaky network must not change entitlement mid-session.
    suspend fun getMonetization() =
        runCatching { api.getMonetization() }.getOrNull()?.also { monetizationConfig = it }
    suspend fun putMonetization(c: com.zekktris.data.model.MonetizationConfig) =
        runCatching { api.putMonetization(c) }.getOrNull()?.also { monetizationConfig = it }

    // ---- camera-quality entitlement (iOS requiredCameraTier/cameraQualityAllowed)

    /** Last-known monetization matrix. Null = not loaded (or the fetch failed)
     *  ⇒ the built-in defaults, exactly like iOS's optional config. */
    @Volatile
    private var monetizationConfig: com.zekktris.data.model.MonetizationConfig? = null

    private fun tierRank(id: String?): Int = when (id) {
        "scout" -> 1
        "guardian" -> 2
        "legend" -> 3
        else -> 0
    }

    /** Minimum perk tier required to publish the camera at [q] per the
     *  admin-configured matrix — or the built-in defaults (1080p for everyone,
     *  2K Guardian, 4K Legend) when no config is loaded. Null = free. 720p and
     *  below are ALWAYS free (never configurable). Mirrors the Settings
     *  picker's own gate (SettingsScreen VoiceVideoTab) so the two can't drift. */
    private fun requiredCameraTier(q: String): String? {
        val cam = monetizationConfig?.camera
        val required = when (q) {
            "high" -> cam?.p1080 ?: "none"
            "k2" -> cam?.k2 ?: "guardian"
            "k4" -> cam?.k4 ?: "legend"
            else -> return null
        }
        return required.takeIf { it != "none" }
    }

    /** True when the signed-in user's tier meets the configured minimum for
     *  camera quality [q]. Wired into VoiceManager's publish-time clamp. */
    private fun cameraQualityAllowed(q: String): Boolean {
        val required = requiredCameraTier(q) ?: return true
        // A profile we haven't loaded yet is UNKNOWN, not "free": failing closed
        // on it would downgrade a tier holder whose /users/@me is merely slow
        // (or who joined a call from a push-woken process). Only a KNOWN
        // tier can fail the check.
        val me = _state.value.me ?: return true
        return tierRank(me.subscriptionTier) >= tierRank(required)
    }

    /** What a session at [rank] gets, for the Settings perk list. Screen share
     *  runs on web and desktop only; defaults match the server's. */
    fun perkLines(rank: Int): List<String> {
        val s = monetizationConfig?.stream ?: com.zekktris.data.model.MonetizationConfig().stream
        val screen = listOf("4K" to s.k4, "2K" to s.k2, "1080p" to s.p1080)
            .firstOrNull { rank >= tierRank(it.second) }?.first ?: "720p"
        val fps = if (rank >= tierRank(s.fps60 ?: "scout")) 60 else 30
        val cam = monetizationConfig?.camera
        val camera = listOf("4K" to (cam?.k4 ?: "legend"), "2K" to (cam?.k2 ?: "guardian"), "1080p" to (cam?.p1080 ?: "none"))
            .firstOrNull { rank >= tierRank(it.second) }?.first ?: "720p"
        return listOf("Screen share up to $screen at $fps fps on web & desktop", "Camera up to $camera")
    }

    // ---- profile edit -------------------------------------------------------

    fun updateProfile(displayName: String? = null, bio: String? = null, status: String? = null) {
        scope.launch {
            val updated = runCatching {
                api.updateProfile(com.zekktris.data.model.ProfilePatch(displayName, bio, status))
            }.getOrNull()
            if (updated != null) _state.update { it.copy(me = updated) }
        }
    }

    fun closeChannel() {
        _state.update { it.copy(selectedChannelId = null) }
    }

    fun openSettings() = _state.update { it.copy(showSettings = true) }
    fun closeSettings() = _state.update { it.copy(showSettings = false) }
    fun openGuildSettings(guildId: String) = _state.update { it.copy(guildSettingsFor = guildId) }
    fun closeGuildSettings() = _state.update { it.copy(guildSettingsFor = null) }
    fun openChannelPerms(channelId: String) = _state.update { it.copy(channelPermsFor = channelId) }
    fun closeChannelPerms() = _state.update { it.copy(channelPermsFor = null) }

    private suspend fun loadMembers(guildId: String) {
        val presenceBefore = _state.value.presence
        val members = runCatching { api.listMembers(guildId) }.getOrDefault(emptyList())
        _state.update { it.copy(membersByGuild = it.membersByGuild + (guildId to members)) }
        seedPresence(members.map { it.user }, presenceBefore)
    }

    /** Fill the presence map from REST user snapshots. The REST value is
     *  authoritative EXCEPT for a user whose live entry changed DURING the
     *  in-flight fetch — a PRESENCE_UPDATE that landed mid-request must win.
     *  [presenceBefore] is the presence map captured immediately BEFORE the
     *  network call: a user whose current entry still equals its pre-fetch value
     *  received no live delta during the fetch, so the REST value is applied —
     *  which REPAIRS a stale/missed entry (the old "live map always wins" merge
     *  pinned a single missed PRESENCE_UPDATE forever). A user whose entry
     *  changed mid-fetch keeps the live value. Mirrors iOS's diff-across-await
     *  rule. Keeps the map complete from first load so no surface has to fall
     *  back to a per-object embedded status (the online/offline split-brain). */
    private fun seedPresence(
        users: List<com.zekktris.data.model.PublicUser>,
        presenceBefore: Map<String, String> = emptyMap(),
    ) {
        if (users.isEmpty()) return
        _state.update { st ->
            val next = HashMap(st.presence)
            var changed = false
            users.forEach { u ->
                val s = u.status ?: return@forEach
                val changedDuringFetch = st.presence[u.id] != presenceBefore[u.id]
                if (!changedDuringFetch && next[u.id] != s) {
                    next[u.id] = s
                    changed = true
                }
            }
            if (changed) st.copy(presence = next) else st
        }
    }

    private suspend fun loadRoles(guildId: String) {
        val roles = runCatching { api.listRoles(guildId) }.getOrNull() ?: return
        _state.update { it.copy(rolesByGuild = it.rolesByGuild + (guildId to roles)) }
    }

    /** Public roles refresh — the member sheet re-fetches on open so a role
     *  fetch that failed on guild-select recovers without re-selecting. */
    suspend fun refreshRoles(guildId: String) = loadRoles(guildId)

    /** My full achievement catalog (earned + locked with progress). */
    suspend fun fetchMyAchievements(): List<com.zekktris.data.model.Achievement> =
        runCatching { api.myAchievements() }.getOrDefault(emptyList())

    /** Another user's public earned achievements. */
    suspend fun fetchUserAchievements(userId: String): List<com.zekktris.data.model.Achievement> =
        api.userAchievements(userId)

    fun selectChannel(channelId: String, jumpToMessageId: String? = null) {
        // Opening a conversation answers its poke. Separate from the read path:
        // a poke creates no message, so a DM with nothing unread is never acked
        // and the pill would stay on the row for good.
        if (_state.value.pokePills.containsKey(channelId)) {
            _state.update { it.copy(pokePills = it.pokePills - channelId) }
        }
        // Freeze the pre-ack read pointer as the unread boundary for the red
        // "New messages" divider (iOS unreadBoundaryId) — ack() below moves it.
        val preAckPointer = _state.value.readStates[channelId]?.lastMessageId
        val chanLastMessageId = (_state.value.dms.firstOrNull { it.id == channelId }
            ?: _state.value.channelsByGuild.values.asSequence().flatten().firstOrNull { it.id == channelId })
            ?.lastMessageId
        _state.update { st ->
            val boundaries = if (preAckPointer != null && chanLastMessageId != null && preAckPointer < chanLastMessageId) {
                st.unreadBoundaryByChannel + (channelId to preAckPointer)
            } else {
                st.unreadBoundaryByChannel - channelId
            }
            st.copy(
                selectedChannelId = channelId,
                pendingJumpMessageId = jumpToMessageId,
                unreadBoundaryByChannel = boundaries,
            )
        }
        refreshE2EEUnlocked(channelId)
        // Opening a conversation reads it — dismiss any lingering notifications.
        push.clearChannelNotifications(channelId)
        // Opening a DM is a strong recency signal for the system share sheet.
        if (_state.value.dms.any { it.id == channelId }) refreshShareShortcuts()
        scope.launch {
            if (_state.value.messagesByChannel[channelId] == null) {
                loadMessages(channelId)
            } else {
                // Cached conversation: paint instantly from cache, then top up.
                // Use the LATEST-window merge (not the after-cursor sync) so a
                // re-open — or a notification tap into the chat you're already
                // in — can NEVER show the stale cache; this is the one recovery
                // that always works. Without it, re-opening a DM showed the
                // STALE cache until the safety-net poll fired (or never).
                refreshOpenChannelLatest(channelId)
            }
            ack(channelId)
        }
    }

    /** Open (or create) a 1:1 DM and select it. With [thenCall], immediately
     *  requests a voice call on it — the same path the DM header's call button
     *  takes (MainScreen consumes pendingVoiceChannelId, asks for the mic, then
     *  joins). Used by the friends list, which knows a user id but no channel. */
    fun openDM(recipientId: String, thenCall: Boolean = false) {
        scope.launch {
            val ch = runCatching { api.openDM(recipientId) }.getOrNull() ?: return@launch
            _state.update {
                val dms = (listOf(ch) + it.dms.filterNot { d -> d.id == ch.id })
                it.copy(dms = dms, selectedGuildId = null, selectedChannelId = ch.id, guildEmojis = emptyList())
            }
            if (thenCall) requestVoice(ch.id)
            refreshShareShortcuts()
            if (_state.value.messagesByChannel[ch.id] == null) loadMessages(ch.id)
            else refreshOpenChannelLatest(ch.id)
            ack(ch.id) // opening a DM reads it (selectChannel does this; openDM must too)
        }
    }

    private suspend fun loadMessages(channelId: String) {
        // API returns newest-first; store ascending (oldest→newest) for the chat view.
        val msgs = runCatching { api.listMessages(channelId, limit = 50) }.getOrDefault(emptyList()).reversed()
        _state.update { it.copy(messagesByChannel = it.messagesByChannel + (channelId to msgs)) }
    }

    fun refreshMessages(channelId: String) {
        scope.launch { loadMessages(channelId) }
    }

    // ---- history pagination (iOS loadOlderMessages parity) -------------------

    /** Prepend the next older page (before the oldest confirmed id). Re-entrant
     *  calls and exhausted channels are no-ops; dedup by id so an overlap can't
     *  double-insert. LazyColumn keyed items keep the scroll anchored. */
    fun loadOlderMessages(channelId: String) {
        val st = _state.value
        if (st.loadingOlderChannelIds.contains(channelId)) return
        if (st.hasMoreOlderByChannel[channelId] == false) return
        val oldest = st.messagesByChannel[channelId]?.firstOrNull { !it.id.startsWith("pending-") }?.id ?: return
        _state.update { it.copy(loadingOlderChannelIds = it.loadingOlderChannelIds + channelId) }
        scope.launch {
            val older = runCatching { api.listMessages(channelId, limit = 50, before = oldest) }.getOrNull()
            _state.update { s ->
                var next = s.copy(loadingOlderChannelIds = s.loadingOlderChannelIds - channelId)
                if (older != null) {
                    val ascending = older.reversed() // API is newest-first
                    val cur = next.messagesByChannel[channelId] ?: emptyList()
                    val have = cur.mapTo(HashSet()) { it.id }
                    val merged = ascending.filter { it.id !in have } + cur
                    next = next.copy(
                        messagesByChannel = next.messagesByChannel + (channelId to merged),
                        hasMoreOlderByChannel = next.hasMoreOlderByChannel + (channelId to (older.size >= 50)),
                    )
                }
                next
            }
        }
    }

    /** Consume the one-shot jump target for [channelId]'s open (mention tap /
     *  push deep-link). Returns null when there's nothing pending. */
    fun consumePendingJump(): String? {
        val id = _state.value.pendingJumpMessageId ?: return null
        _state.update { it.copy(pendingJumpMessageId = null) }
        return id
    }

    /** Consume the one-shot reply-prefill target (guild push tap). */
    fun consumePendingReplyPrefill(): String? {
        val id = _state.value.pendingReplyPrefillId ?: return null
        _state.update { it.copy(pendingReplyPrefillId = null) }
        return id
    }

    /** Load a window AROUND [messageId] and show it, for jump targets outside
     *  the loaded window (iOS `loadMessages` around: fetch). Returns true when
     *  the target is now present. */
    suspend fun loadAround(channelId: String, messageId: String): Boolean {
        val batch = runCatching { api.listMessages(channelId, limit = 50, around = messageId) }.getOrNull() ?: return false
        // SORT, never reverse. Only the no-cursor and `before=` forms come back
        // newest-first; the `around=` branch already returns oldest-first, so a
        // blind reverse inverts the whole transcript. iOS sorts for the same
        // reason (AppStore.swift:1836). Snowflakes grew a digit in Oct 2024, so
        // order by length first — a bare string compare comes apart across that
        // rollover.
        val window = batch.sortedWith(compareBy({ it.id.length }, { it.id }))
        // The fetch suspends, so the user may have switched channels meanwhile.
        // Committing anyway would swap a live conversation for a mid-history
        // slice of a different one (iOS guards the same way at AppStore.swift:1835).
        if (_state.value.selectedChannelId != channelId) return false
        // REPLACE the channel's list, never merge (iOS replaces `messages` with
        // the around window). The window is a slice from the MIDDLE of history,
        // so keeping the loaded newest page alongside it leaves an unbridgeable
        // hole between the two: `before=` paging would then walk back from the
        // window's oldest row, skipping the missing span forever (there is no
        // load-newer path), and the transcript reads as continuous while
        // silently jumping in time. Only optimistic sends survive — dropping a
        // message the user is still sending would look like a lost send.
        _state.update { st ->
            val nonces = window.mapNotNullTo(HashSet()) { it.nonce }
            val pending = (st.messagesByChannel[channelId] ?: emptyList()).filter {
                it.id.startsWith("pending-") && (it.nonce == null || it.nonce !in nonces)
            }
            st.copy(
                messagesByChannel = st.messagesByChannel + (channelId to (window + pending)),
                // A full window implies older history behind it; without this a
                // channel already paged to its start stays flagged exhausted and
                // could never page back from the new window.
                hasMoreOlderByChannel = st.hasMoreOlderByChannel + (channelId to (batch.size >= 50)),
            )
        }
        return window.any { it.id == messageId }
    }

    /** Highest-position colored role → RGB int for the member's display name
     *  (mirrors iOS AppStore.memberColor / web memberDisplayColor). Null when
     *  the member has no colored role (render ink1). */
    fun memberColorRGB(guildId: String?, userId: String?): Int? {
        if (guildId == null || userId == null) return null
        val member = _state.value.membersByGuild[guildId]?.firstOrNull { it.userId == userId } ?: return null
        val roles = _state.value.rolesByGuild[guildId] ?: return null
        val ids = member.roleIds.toSet()
        return roles
            .filter { it.id in ids && it.color != 0 }
            .maxByOrNull { it.position }
            ?.color
            ?.coerceIn(0, 0xFFFFFF)
    }

    /** Pull messages newer than what we hold and merge them (no clobber, no scroll thrash). */
    private suspend fun syncNewMessages(channelId: String) {
        val lastReal = _state.value.messagesByChannel[channelId]
            ?.lastOrNull { !it.id.startsWith("pending-") }?.id
        val fresh = runCatching { api.listMessages(channelId, limit = 50, after = lastReal) }
            .getOrDefault(emptyList())
        if (fresh.isEmpty()) return
        // SORT, don't reverse. The shape depends on the cursor: `after=` comes
        // back OLDEST-first, but the no-cursor form (lastReal == null, an empty
        // channel) comes back NEWEST-first — so neither a blind reverse nor a
        // blind pass-through is right for both. A blind reverse was appending
        // this batch backwards on every `after=` poll, which only stayed hidden
        // while the cursor sat at the true tail and the fetch returned nothing.
        val ordered = fresh.sortedWith(compareBy({ it.id.length }, { it.id }))
        ordered.forEach { upsertMessage(channelId, it) }
        // reconcilePointer reads the newest as batch.first(), so hand it the
        // reversed view rather than the ascending one.
        reconcilePointer(channelId, ordered.asReversed())
        // Mirror the live foreground-open ack (MESSAGE_CREATE, 2320) so the open
        // chat can't flip to unread under the user and no phantom dot forms. MUST
        // stay gated: syncNewMessages is also called for non-open channels via
        // onPushForChannel, where an unconditional ack would clear a real unread.
        if (appForeground && _state.value.selectedChannelId == channelId) ack(channelId)
    }

    /** Move a DM/channel's unread pointer + recency forward from a REST catch-up
     *  batch (poll / push-sync / foreground refresh), mirroring the live
     *  MESSAGE_CREATE reconciliation (2294-2295). `batch` is API order
     *  (newest-first). No-op when nothing genuinely newer arrived. */
    private fun reconcilePointer(channelId: String, batch: List<Message>) {
        val newest = batch.firstOrNull { it.id.all(Char::isDigit) }?.id ?: return
        val cur = _state.value.dms.firstOrNull { it.id == channelId }?.lastMessageId
        if (cur == null || newest > cur) {
            advanceLastMessage(channelId, newest) // self-guards monotonicity
            bumpRecency(channelId)                 // only on a genuinely newer message
        }
    }

    /** BULLETPROOF catch-up: fetch the LATEST window (exactly what re-opening
        does — the recovery that always works) and MERGE it via upsert, so a
        missed message surfaces even when the after-cursor [syncNewMessages]
        misses (slow/failed cursor fetch, socket-resume race). Merge, not
        replace → never clobbers loaded history or thrashes scroll. Used at the
        high-stakes moments the user actually hits staleness: re-opening a
        cached conversation (incl. a notification tap) and every foreground. */
    private suspend fun refreshOpenChannelLatest(channelId: String) {
        val latest = runCatching { api.listMessages(channelId, limit = 50) }.getOrDefault(emptyList())
        if (latest.isEmpty()) return
        val fetched = latest.reversed()                  // API is newest-first → ascending
        val fetchedIds = fetched.mapTo(HashSet()) { it.id }
        val minId = fetched.first().id                    // oldest in window
        val maxId = fetched.last().id                     // newest in window
        _state.update { st ->
            val cur = st.messagesByChannel[channelId] ?: emptyList()
            // Drop non-pending cached messages that fall inside the fetched window
            // [minId..maxId] but the server no longer returns → deleted while we
            // were disconnected. The latest-50 is a contiguous newest range, so any
            // still-existing server message with id >= minId is in `fetched`; an
            // in-range cached id absent from it is genuinely deleted. Pending
            // optimistic sends and history older than minId are left untouched.
            // String comparison of snowflake ids matches advanceLastMessage.
            val pruned = cur.filterNot { m ->
                !m.id.startsWith("pending-") &&
                    m.id !in fetchedIds &&
                    m.id >= minId && m.id <= maxId
            }
            st.copy(messagesByChannel = st.messagesByChannel + (channelId to pruned))
        }
        fetched.forEach { upsertMessage(channelId, it) }  // add/overwrite as before
        reconcilePointer(channelId, latest)               // advance unread pointer + recency
    }

    private suspend fun ack(channelId: String) {
        val last = _state.value.messagesByChannel[channelId]?.lastOrNull()?.id ?: return
        val rs = runCatching { api.ackMessage(channelId, last) }.getOrNull() ?: return
        _state.update { it.copy(readStates = it.readStates + (channelId to rs)) }
    }

    // ---- sending ------------------------------------------------------------

    fun sendMessage(channelId: String, content: String, replyToId: String? = null) {
        val text = content.trim()
        if (text.isEmpty()) return
        // E2EE: the wire carries ciphertext; the optimistic bubble keeps the
        // plaintext for local display (the server echo, also ciphertext, decrypts
        // back to the same text). Locked (no key) → refuse to send.
        val wire: String = if (dmById(channelId)?.isE2EE == true) {
            val key = e2eeKeyFor(channelId) ?: return
            com.zekktris.crypto.E2EE.encrypt(text, key) ?: return
        } else {
            text
        }
        val nonce = UUID.randomUUID().toString()
        val me = _state.value.me
        val optimistic = Message(
            id = "pending-$nonce",
            channelId = channelId,
            createdAt = Instant.now().toString(),
            authorId = me?.id,
            author = me?.toPublicUser(),
            content = text,
            replyToId = replyToId,
            nonce = nonce,
        )
        upsertMessage(channelId, optimistic)
        bumpRecency(channelId)
        scope.launch {
            val sent = runCatching { api.sendMessage(channelId, wire, nonce, replyToId) }.getOrNull()
            if (sent != null) {
                upsertMessage(channelId, sent)
                _state.update { it.copy(failedSendIds = it.failedSendIds - optimistic.id) }
            } else {
                // Flip the optimistic row to FAILED (red 'Failed to send' +
                // Retry/Delete in the row footer — iOS markSendFailed parity).
                _state.update { it.copy(failedSendIds = it.failedSendIds + optimistic.id) }
            }
        }
    }

    /** Re-POST a failed optimistic message with its ORIGINAL nonce (server
     *  dedupes), mirroring iOS retrySend. */
    fun retrySend(channelId: String, pendingId: String) {
        val msg = _state.value.messagesByChannel[channelId]?.firstOrNull { it.id == pendingId } ?: return
        val nonce = msg.nonce ?: return
        val wire: String = if (dmById(channelId)?.isE2EE == true) {
            val key = e2eeKeyFor(channelId) ?: return
            com.zekktris.crypto.E2EE.encrypt(msg.content, key) ?: return
        } else {
            msg.content
        }
        _state.update { it.copy(failedSendIds = it.failedSendIds - pendingId) }
        scope.launch {
            val sent = runCatching { api.sendMessage(channelId, wire, nonce, msg.replyToId) }.getOrNull()
            if (sent != null) upsertMessage(channelId, sent)
            else _state.update { it.copy(failedSendIds = it.failedSendIds + pendingId) }
        }
    }

    /** Drop a failed optimistic message locally (iOS discardFailed). */
    fun discardFailedSend(channelId: String, pendingId: String) {
        _state.update { st ->
            val list = st.messagesByChannel[channelId]?.filterNot { it.id == pendingId }
            st.copy(
                messagesByChannel = if (list != null) st.messagesByChannel + (channelId to list) else st.messagesByChannel,
                failedSendIds = st.failedSendIds - pendingId,
            )
        }
    }

    /** Send with attachments (multipart). Optimistic text bubble immediately;
     *  the attachments render when the server echo replaces it (by nonce).
     *
     *  [onDone] reports `(ok, error)`; `error` is a user-facing sentence when
     *  the failure is one the user can act on (a photo we couldn't build a
     *  preview for), and null otherwise. */
    fun sendMessageWithFiles(
        channelId: String,
        content: String,
        replyToId: String?,
        files: List<ApiClient.UploadFilePart>,
        onDone: (Boolean, String?) -> Unit = { _, _ -> },
    ) {
        // E2EE DM: every attachment is encrypted with the channel key before
        // anything leaves the device (.zke suffix, same iv‖ct‖tag wire as iOS/
        // web), and the caption ships as ciphertext too. Key missing (locked)
        // => refuse outright — NEVER fall back to a plaintext upload.
        val e2eeKey: ByteArray? = if (dmById(channelId)?.isE2EE == true) {
            e2eeKeyFor(channelId) ?: run { onDone(false, "Unlock this conversation to send."); return }
        } else null
        val nonce = UUID.randomUUID().toString()
        val me = _state.value.me
        val optimistic = Message(
            id = "pending-$nonce",
            channelId = channelId,
            createdAt = Instant.now().toString(),
            authorId = me?.id,
            author = me?.toPublicUser(),
            content = content.trim(),
            replyToId = replyToId,
            nonce = nonce,
        )
        upsertMessage(channelId, optimistic)
        bumpRecency(channelId)
        scope.launch {
            // STEP 1 — shrink the media BEFORE anything else touches it, and in
            // particular BEFORE encryption. Once a blob is encrypted it is
            // opaque `application/octet-stream` to the server, which skips both
            // the WebP backstop and the nightly compression sweep, and holds no
            // key anyway — so this is the ONLY moment an E2EE photo or video
            // can be made smaller. See MediaPrep for the measured 37x gap this
            // closes. The plain path gets it too: it saves the same bytes on
            // the way UP, and the server asks clients to do it regardless.
            //
            // MediaPrep does its own dispatching (image work on Default, the
            // video export on Main for Transformer's Looper), so nothing heavy
            // runs on this Main.immediate coroutine.
            // OOM is caught rather than left to kill the process: a batch of
            // large photos or a long video can exceed the heap while preparing
            // or encrypting, and a crash loses the user's whole draft with no
            // explanation. The composer restores the picks on a failed send.
            val media = try {
                com.zekktris.media.MediaPrep.prepareAll(
                    appContext,
                    files.map { com.zekktris.media.MediaPrep.Input(it.bytes, it.filename, it.mime) },
                )
            } catch (oom: OutOfMemoryError) {
                _state.update { it.copy(failedSendIds = it.failedSendIds + optimistic.id) }
                onDone(false, "Ran out of memory preparing these attachments. Try sending fewer at once.")
                return@launch
            }
            com.zekktris.media.MediaPrep.logOutcome(media)

            // Encrypt off the main thread — AES-GCM over multi-MB images plus
            // the thumbnail re-encode would jank the composer on Main.immediate.
            val prep: PreparedParts = if (e2eeKey != null) {
                try {
                    withContext(Dispatchers.Default) { encryptAll(media, e2eeKey) }
                } catch (oom: OutOfMemoryError) {
                    _state.update { it.copy(failedSendIds = it.failedSendIds + optimistic.id) }
                    onDone(false, "Ran out of memory encrypting these attachments. Try sending fewer at once.")
                    return@launch
                }
            } else {
                // Plain uploads carry no client metadata: the server measures
                // the pixels and generates the thumbnail itself.
                PreparedParts(
                    media.map {
                        EncryptedPart(ApiClient.UploadFilePart(it.filename, it.mime, it.bytes), it.bytes, null)
                    },
                    null,
                )
            }
            val prepared = prep.parts
            val wireCaption: String? = when {
                e2eeKey != null && content.isNotBlank() ->
                    com.zekktris.crypto.E2EE.encrypt(content.trim(), e2eeKey)
                else -> content.trim()
            }
            if (prepared == null || wireCaption == null) {
                // Encryption (or the mandatory preview) failed — surface as a
                // failed send, nothing uploaded.
                _state.update { it.copy(failedSendIds = it.failedSendIds + optimistic.id) }
                onDone(false, prep.error ?: "Encryption failed.")
                return@launch
            }
            val sent = runCatching {
                api.sendMessageMultipart(channelId, wireCaption, nonce, replyToId, prepared.map { it.part })
            }.getOrNull()
            if (sent != null) {
                // Seed the in-memory cache with the plaintext we still hold, so
                // the sender's own encrypted images render instantly with no
                // re-download + re-decrypt (iOS optimistic-preview behavior).
                // Positional: the server returns attachment rows in files order
                // (thumbnails are separate isThumbnail rows excluded from the
                // message DTO).
                if (e2eeKey != null) {
                    sent.attachments.forEachIndexed { i, att ->
                        prepared.getOrNull(i)?.let { p ->
                            mediaCache.put(att.id, p.plainBytes)
                            p.plainThumb?.let { mediaCache.put(att.id + ":thumb", it) }
                        }
                    }
                }
                upsertMessage(channelId, sent)
                _state.update { it.copy(failedSendIds = it.failedSendIds - optimistic.id) }
            } else {
                // Text can be retried; the file parts are gone with this scope,
                // so a failed multipart shows Failed + Delete (retry re-sends
                // the caption only — matching the optimistic text-only bubble).
                _state.update { it.copy(failedSendIds = it.failedSendIds + optimistic.id) }
            }
            onDone(sent != null, null)
        }
    }

    /** One prepared (possibly encrypted) upload part, keeping the plaintext
     *  around so the sender can seed [mediaCache] after a successful send. */
    private class EncryptedPart(
        val part: ApiClient.UploadFilePart,
        val plainBytes: ByteArray,
        val plainThumb: ByteArray?,
    )

    /** All-or-nothing outcome of preparing a batch for upload: either every
     *  part, or a user-facing reason why none of them are going. */
    private class PreparedParts(val parts: List<EncryptedPart>?, val error: String?)

    /**
     * Encrypt a whole prepared batch for an E2EE DM, or refuse the batch.
     *
     * A THUMBNAIL IS MANDATORY for an E2EE image. The server cannot generate
     * one — it only ever sees ciphertext — so an image shipped without one is a
     * preview-less original forever, which is exactly how 90 of the 268 E2EE
     * images on the live server ended up with no thumbnail at all. That used to
     * be best-effort and silent. Failing the send loudly is the lesser harm:
     * the composer restores the picks, so the user just retries.
     */
    private fun encryptAll(media: List<com.zekktris.media.MediaPrep.Prepared>, key: ByteArray): PreparedParts {
        val out = ArrayList<EncryptedPart>(media.size)
        for (m in media) {
            if (m.isImage && m.thumbnail == null) {
                return PreparedParts(
                    null,
                    "Couldn't build a preview for ${m.filename}, so it wasn't sent. " +
                        "Try again, or pick a different photo.",
                )
            }
            val p = encryptUploadPart(m, key) ?: return PreparedParts(null, "Encryption failed.")
            out.add(p)
        }
        return PreparedParts(out, null)
    }

    /**
     * Encrypt one already-[com.zekktris.media.MediaPrep]-prepared part for an
     * E2EE DM: bytes → iv‖ct‖tag, filename → "<name>.zke", mime →
     * octet-stream.
     *
     * The pixel dims and the 480 px preview both come from MediaPrep now,
     * rather than being measured/derived here off the raw camera-roll bytes.
     * That matters twice over: the dims describe the DOWNSCALED bytes we are
     * actually uploading (and are EXIF-corrected, so a portrait photo reserves
     * a portrait slot), and the preview is produced once for both the E2EE and
     * plain paths instead of being re-derived per call site.
     *
     * The caller has already refused to proceed if an image arrived without a
     * preview, so `thumbBytes` is null here only for non-images. Returns null
     * on any crypto failure — the caller aborts the send (never plaintext).
     */
    private fun encryptUploadPart(m: com.zekktris.media.MediaPrep.Prepared, key: ByteArray): EncryptedPart? {
        val enc = com.zekktris.crypto.E2EE.encryptBytes(m.bytes, key) ?: return null
        var thumbEnc: ByteArray? = null
        if (m.thumbnail != null) {
            thumbEnc = com.zekktris.crypto.E2EE.encryptBytes(m.thumbnail, key) ?: return null
        }
        return EncryptedPart(
            ApiClient.UploadFilePart(
                filename = m.filename + ".zke",
                mime = "application/octet-stream",
                bytes = enc,
                width = m.width,
                height = m.height,
                thumbBytes = thumbEnc,
            ),
            plainBytes = m.bytes,
            plainThumb = if (thumbEnc != null) m.thumbnail else null,
        )
    }

    /** Send a recorded voice message (audio + duration/waveform metadata).
     *  Blocked in E2EE DMs (attachment encryption is deferred). */
    fun sendVoiceMessage(channelId: String, rec: com.zekktris.voice.VoiceRecorder.Recording, onDone: (Boolean) -> Unit = {}) {
        if (dmById(channelId)?.isE2EE == true) { onDone(false); return }
        val nonce = UUID.randomUUID().toString()
        val vm = buildJsonObject {
            put("durationSeconds", JsonPrimitive(rec.durationSec))
            put("waveform", JsonPrimitive(rec.waveform))
        }
        val part = ApiClient.UploadFilePart(rec.filename, "audio/mp4", rec.bytes)
        scope.launch {
            val sent = runCatching {
                api.sendMessageMultipart(channelId, "", nonce, null, listOf(part), vm)
            }.getOrNull()
            if (sent != null) { upsertMessage(channelId, sent); bumpRecency(channelId) }
            onDone(sent != null)
        }
    }

    // ---- message actions ----------------------------------------------------

    /** Toggle my reaction. Optimistic patch (idempotent, so the gateway echo of
     *  our own event can't double-count), then the API call. */
    fun toggleReaction(channelId: String, messageId: String, emoji: String) {
        val msg = _state.value.messagesByChannel[channelId]?.firstOrNull { it.id == messageId } ?: return
        val mine = msg.reactions.firstOrNull { it.emoji == emoji }?.me == true
        patchReaction(channelId, messageId, emoji, add = !mine, mine = true)
        scope.launch {
            runCatching {
                if (mine) api.removeReaction(channelId, messageId, emoji)
                else api.addReaction(channelId, messageId, emoji)
            }
        }
    }

    /** Apply one reaction delta to the aggregates. Idempotent for our own
     *  reactions: adding when `me` is already set (or removing when clear) is a
     *  no-op, so optimistic-then-echo applies exactly once. */
    private fun patchReaction(channelId: String, messageId: String, emoji: String, add: Boolean, mine: Boolean) {
        _state.update { st ->
            val list = st.messagesByChannel[channelId] ?: return@update st
            val idx = list.indexOfFirst { it.id == messageId }
            if (idx < 0) return@update st
            val msg = list[idx]
            val existing = msg.reactions.firstOrNull { it.emoji == emoji }
            if (mine && add && existing?.me == true) return@update st
            if (mine && !add && existing?.me != true) return@update st
            val next = if (add) {
                if (existing == null) msg.reactions + com.zekktris.data.model.ReactionAggregate(emoji, 1, mine)
                else msg.reactions.map {
                    if (it.emoji == emoji) it.copy(count = it.count + 1, me = it.me || mine) else it
                }
            } else {
                msg.reactions.mapNotNull {
                    if (it.emoji != emoji) it
                    else {
                        val c = it.count - 1
                        if (c <= 0) null else it.copy(count = c, me = if (mine) false else it.me)
                    }
                }
            }
            val newList = list.toMutableList().also { it[idx] = msg.copy(reactions = next) }
            st.copy(messagesByChannel = st.messagesByChannel + (channelId to newList))
        }
    }

    fun editMessage(channelId: String, messageId: String, content: String) {
        // Re-encrypt an edited E2EE message so the edit doesn't land as plaintext.
        val wire: String = if (dmById(channelId)?.isE2EE == true) {
            val key = e2eeKeyFor(channelId) ?: return
            com.zekktris.crypto.E2EE.encrypt(content, key) ?: return
        } else content
        scope.launch {
            val updated = runCatching { api.editMessage(channelId, messageId, wire) }.getOrNull() ?: return@launch
            upsertMessage(channelId, updated)
        }
    }

    fun deleteMessage(channelId: String, messageId: String) {
        // Optimistic remove; the MESSAGE_DELETE broadcast confirms.
        _state.update { st ->
            val list = st.messagesByChannel[channelId] ?: return@update st
            st.copy(messagesByChannel = st.messagesByChannel + (channelId to list.filterNot { it.id == messageId }))
        }
        scope.launch { runCatching { api.deleteMessage(channelId, messageId) } }
    }

    // ---- channel management + notification levels ----------------------------

    fun loadNotificationOverrides() {
        scope.launch {
            val ov = runCatching { api.getNotificationOverrides() }.getOrDefault(emptyList())
            val map = ov.mapNotNull { o -> o.level?.let { "${o.targetType}:${o.targetId}" to it } }.toMap()
            _state.update { it.copy(notificationOverrides = map) }
        }
    }

    /** Effective level: channel override › guild override › "all". */
    fun channelLevel(channelId: String, guildId: String?): String {
        val o = _state.value.notificationOverrides
        return o["channel:$channelId"] ?: guildId?.let { o["guild:$it"] } ?: "all"
    }

    fun setChannelLevel(channelId: String, level: String) {
        _state.update { it.copy(notificationOverrides = it.notificationOverrides + ("channel:$channelId" to level)) }
        scope.launch { runCatching { api.setNotificationOverride("channel", channelId, level) } }
    }

    fun isGuildMuted(guildId: String) = _state.value.notificationOverrides["guild:$guildId"] == "nothing"

    fun setGuildMuted(guildId: String, muted: Boolean) {
        _state.update {
            val m = it.notificationOverrides.toMutableMap()
            if (muted) m["guild:$guildId"] = "nothing" else m.remove("guild:$guildId")
            it.copy(notificationOverrides = m)
        }
        scope.launch { runCatching { api.setNotificationOverride("guild", guildId, if (muted) "nothing" else null) } }
    }

    fun markGuildRead(guildId: String) {
        scope.launch {
            val rs = runCatching { api.markGuildRead(guildId) }.getOrDefault(emptyList())
            if (rs.isNotEmpty()) _state.update { it.copy(readStates = it.readStates + rs.associateBy { s -> s.channelId }) }
        }
    }

    fun leaveGuild(guildId: String) {
        scope.launch {
            runCatching { api.leaveGuild(guildId) }
            _state.update {
                val leftSelected = it.selectedGuildId == guildId
                it.copy(
                    guilds = it.guilds.filterNot { g -> g.id == guildId },
                    selectedGuildId = if (leftSelected) null else it.selectedGuildId,
                    selectedChannelId = if (leftSelected) null else it.selectedChannelId,
                )
            }
        }
    }

    /**
     * Persist a whole channel order as `{id, position, parentId}` rows.
     *
     * `position` is the index WITHIN the sibling group — top-level categories,
     * top-level channels and each category's children are numbered
     * independently. That is what the server stores and what iOS and the web
     * send, so all three clients agree on what a position means.
     *
     * Optimistic: the sidebar renders straight off `channelsByGuild`, so the
     * new order is applied locally first and a failure refetches the server's
     * version rather than trying to invert the change.
     */
    /**
     * Ask for a password-reset email. The server deliberately answers the same
     * way whether or not the address exists, so this only ever reports that the
     * request went out.
     */
    /**
     * Accept the selected server's rules.
     *
     * Without this the app is unusable in any server that has rules: the member
     * sits in 'pending' and the server rejects every message with
     * PENDING_ACKNOWLEDGMENT — a state Android had no way out of, because it
     * never showed the prompt.
     */
    fun acknowledgeOnboarding(guildId: String, onDone: (String?) -> Unit = {}) {
        val me = _state.value.me?.id
        scope.launch {
            val error = runCatching { api.acknowledgeOnboarding(guildId) }.exceptionOrNull()
            if (error == null && me != null) {
                // Flip our own member row locally so the gate closes without a
                // refetch; the server has already made it authoritative.
                _state.update { st ->
                    val members = st.membersByGuild[guildId] ?: return@update st
                    st.copy(
                        membersByGuild = st.membersByGuild + (
                            guildId to members.map {
                                if (it.userId == me) it.copy(membershipState = "active") else it
                            }
                        ),
                    )
                }
            }
            onDone(error?.message)
        }
    }

    /**
     * Set the account's date of birth. Only possible while `canChangeDob` is
     * true: the server locks it the moment it is set, and answers a later
     * attempt with FORBIDDEN — so the UI only offers this to an account that
     * can still act on it.
     */
    fun updateDateOfBirth(dateOfBirth: String, onDone: (String?) -> Unit) {
        scope.launch {
            val result = runCatching { api.updateDateOfBirth(dateOfBirth) }
            result.getOrNull()?.let { user -> _state.update { it.copy(me = user) } }
            onDone(result.exceptionOrNull()?.let {
                (it as? com.zekktris.data.ApiException)?.message
                    ?: "Couldn't update your date of birth."
            })
        }
    }

    /** True while our membership in [guildId] is still pending rules acceptance. */
    fun isPendingOnboarding(guildId: String): Boolean {
        val me = _state.value.me?.id ?: return false
        val mine = _state.value.membersByGuild[guildId]?.firstOrNull { it.userId == me }
        return mine?.membershipState == "pending"
    }

    fun requestPasswordReset(email: String, onDone: (String?) -> Unit) {
        scope.launch {
            val error = runCatching { api.forgotPassword(email) }.exceptionOrNull()
            onDone(error?.let { "Couldn't send the reset email. Check the address and try again." })
        }
    }

    /** Finish a reset with the emailed code. Returns the server's reason on failure. */
    fun resetPassword(token: String, newPassword: String, onDone: (String?) -> Unit) {
        scope.launch {
            val error = runCatching { api.resetPassword(token, newPassword) }.exceptionOrNull()
            onDone(error?.message ?: if (error != null) "That reset code didn't work." else null)
        }
    }

    fun applyChannelOrder(
        guildId: String,
        entries: List<Triple<String, Int, String?>>,
        onError: (String) -> Unit = {},
    ) {
        val byId = entries.associateBy { it.first }
        _state.update { st ->
            val current = st.channelsByGuild[guildId] ?: return@update st
            val next = current.map { ch ->
                val e = byId[ch.id] ?: return@map ch
                ch.copy(position = e.second, parentId = e.third)
            }
            st.copy(channelsByGuild = st.channelsByGuild + (guildId to next))
        }
        scope.launch {
            // An explicit JSON null is "move to the top level"; omitting the key
            // would mean "leave the parent alone", which is never what a drag
            // means here.
            val wire = entries.map { (id, position, parent) ->
                Triple<String, Int, kotlinx.serialization.json.JsonElement?>(
                    id,
                    position,
                    if (parent == null) kotlinx.serialization.json.JsonNull else JsonPrimitive(parent),
                )
            }
            val ok = runCatching { api.reorderChannels(guildId, wire) }.isSuccess
            if (!ok) {
                refreshGuildChannels(guildId)
                onError("Couldn't save the new order.")
            }
        }
    }

    private suspend fun refreshGuildChannels(guildId: String) {
        val c = runCatching { api.listChannels(guildId) }.getOrDefault(emptyList())
        _state.update { it.copy(channelsByGuild = it.channelsByGuild + (guildId to c)) }
    }

    /** Reconnect-safe channel refetch: overwrite [guildId]'s cached channels with
     *  server truth (fresh per-channel lastMessageId → closed-channel unread
     *  reconciles, and channels made private while offline drop out) but ONLY on a
     *  successful fetch. Returns the fetched list, or null on failure so callers
     *  never clobber the cache or pop the user out of a still-valid channel on a
     *  transient error/403 (unlike [refreshGuildChannels], which defaults empty). */
    private suspend fun reloadGuildChannelsSafe(guildId: String): List<Channel>? {
        val channels = runCatching { api.listChannels(guildId) }.getOrNull() ?: return null
        _state.update { it.copy(channelsByGuild = it.channelsByGuild + (guildId to channels)) }
        return channels
    }

    fun createChannel(guildId: String, type: String, name: String, parentId: String? = null, linkUrl: String? = null, onDone: (String?) -> Unit = {}) {
        scope.launch {
            val ch = runCatching { api.createChannel(guildId, type, name.trim(), parentId = parentId, linkUrl = linkUrl?.trim()?.ifBlank { null }) }.getOrNull()
            if (ch != null) refreshGuildChannels(guildId)
            onDone(ch?.id)
        }
    }

    fun deleteChannel(channelId: String, guildId: String) {
        scope.launch {
            runCatching { api.deleteChannel(channelId) }
            refreshGuildChannels(guildId)
            _state.update { if (it.selectedChannelId == channelId) it.copy(selectedChannelId = null) else it }
        }
    }

    // ---- guild settings (owner / MANAGE_GUILD) -------------------------------

    private fun replaceGuild(g: Guild) {
        _state.update { it.copy(guilds = it.guilds.map { gg -> if (gg.id == g.id) g else gg }) }
    }

    /** A nullable text field → wire value: blank clears it (JSON null), else the
        trimmed text. Always sent, so a cleared field round-trips. */
    private fun clearableText(s: String): JsonElement =
        if (s.isBlank()) JsonNull else JsonPrimitive(s.trim())

    /** Rename / edit description + rules. Name blank is ignored (can't clear). */
    fun editGuild(guildId: String, name: String, description: String, rulesContent: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val g = runCatching {
                api.patchGuild(
                    guildId,
                    name = name.trim().ifBlank { null },
                    description = clearableText(description),
                    rulesContent = clearableText(rulesContent),
                )
            }.getOrNull()
            if (g != null) replaceGuild(g)
            onDone(g != null)
        }
    }

    fun setGuildDiscovery(guildId: String, discoverable: Boolean, description: String?, category: String?, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val g = runCatching { api.setGuildDiscovery(guildId, discoverable, description?.trim()?.ifBlank { null }, category) }.getOrNull()
            if (g != null) replaceGuild(g)
            onDone(g != null)
        }
    }

    fun uploadGuildIcon(guildId: String, filename: String, mime: String, bytes: ByteArray, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val g = runCatching { api.uploadGuildIcon(guildId, filename, mime, bytes) }.getOrNull()
            if (g != null) replaceGuild(g)
            onDone(g != null)
        }
    }

    fun uploadGuildBanner(guildId: String, filename: String, mime: String, bytes: ByteArray, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val g = runCatching { api.uploadGuildBanner(guildId, filename, mime, bytes) }.getOrNull()
            if (g != null) replaceGuild(g)
            onDone(g != null)
        }
    }

    /** Owner-only delete of the current guild (evicts it from the rail). */
    fun deleteGuild(guildId: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val ok = runCatching { api.deleteGuild(guildId) }.isSuccess
            if (ok) _state.update {
                val wasSelected = it.selectedGuildId == guildId
                it.copy(
                    guilds = it.guilds.filterNot { g -> g.id == guildId },
                    selectedGuildId = if (wasSelected) null else it.selectedGuildId,
                    selectedChannelId = if (wasSelected) null else it.selectedChannelId,
                )
            }
            onDone(ok)
        }
    }

    // ---- channel + category management ---------------------------------------

    /** Edit a channel/category. Name blank ignored; topic blank clears it.
        `parentId`: null = don't touch, JsonNull = move out of a category,
        JsonPrimitive = move into that category (so "None" actually un-parents). */
    fun editChannel(channelId: String, guildId: String, name: String, topic: String, parentId: JsonElement?, nsfw: Boolean?, slowmode: Int?, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val ch = runCatching {
                api.patchChannel(
                    channelId,
                    name = name.trim().ifBlank { null },
                    topic = clearableText(topic),
                    parentId = parentId,
                    nsfw = nsfw,
                    rateLimitPerUser = slowmode,
                )
            }.getOrNull()
            if (ch != null) refreshGuildChannels(guildId)
            onDone(ch != null)
        }
    }

    fun purgeChannel(channelId: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val ok = runCatching { api.purgeChannel(channelId) }.isSuccess
            if (ok) _state.update { it.copy(messagesByChannel = it.messagesByChannel + (channelId to emptyList())) }
            onDone(ok)
        }
    }

    // ---- threads + forums ----------------------------------------------------

    suspend fun threadsFor(channelId: String): List<Channel> =
        runCatching { api.listThreads(channelId) }.getOrDefault(emptyList())

    /** Start a thread off a message and open it. */
    fun createThreadFromMessage(channelId: String, messageId: String, name: String?, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val t = runCatching { api.createThread(channelId, messageId, name) }.getOrNull()
            if (t != null) selectChannel(t.id)
            onDone(t != null)
        }
    }

    /** Create a forum post (thread + opening message) and open it. */
    fun createForumPost(forumChannelId: String, title: String, content: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val r = runCatching { api.createForumPost(forumChannelId, title, content) }.getOrNull()
            if (r != null) selectChannel(r.post.id)
            onDone(r != null)
        }
    }

    // ---- roles (MANAGE_ROLES) ------------------------------------------------

    fun createRole(guildId: String, name: String, color: Int, hoist: Boolean, mentionable: Boolean, permissions: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val r = runCatching { api.createRole(guildId, name.trim(), color, hoist, mentionable, permissions) }.getOrNull()
            if (r != null) refreshRoles(guildId)
            onDone(r != null)
        }
    }

    fun editRole(guildId: String, roleId: String, name: String, color: Int, hoist: Boolean, mentionable: Boolean, selfAssignable: Boolean, permissions: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val r = runCatching { api.patchRole(guildId, roleId, name.trim(), color, hoist, mentionable, selfAssignable, permissions) }.getOrNull()
            if (r != null) refreshRoles(guildId)
            onDone(r != null)
        }
    }

    fun deleteRole(guildId: String, roleId: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val ok = runCatching { api.deleteRole(guildId, roleId) }.isSuccess
            if (ok) refreshRoles(guildId)
            onDone(ok)
        }
    }

    /** Toggle a role on a member — reads their current set, flips one, sends the
        whole set (server diffs). Optimistically patches the roster. */
    fun toggleMemberRole(guildId: String, userId: String, roleId: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val members = _state.value.membersByGuild[guildId] ?: emptyList()
            val cur = members.firstOrNull { it.userId == userId }?.roleIds ?: emptyList()
            val next = if (cur.contains(roleId)) cur - roleId else cur + roleId
            val m = runCatching { api.patchMemberRoles(guildId, userId, next) }.getOrNull()
            if (m != null) {
                _state.update { st ->
                    val list = (st.membersByGuild[guildId] ?: emptyList()).map { if (it.userId == userId) m else it }
                    st.copy(membersByGuild = st.membersByGuild + (guildId to list))
                }
            }
            onDone(m != null)
        }
    }

    // ---- member moderation (KICK/BAN/MODERATE) -------------------------------

    private fun removeMemberFromRoster(guildId: String, userId: String) {
        _state.update { st ->
            val list = (st.membersByGuild[guildId] ?: return@update st).filterNot { it.userId == userId }
            st.copy(membersByGuild = st.membersByGuild + (guildId to list))
        }
    }

    fun kickMember(guildId: String, userId: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val ok = runCatching { api.kickMember(guildId, userId) }.isSuccess
            if (ok) removeMemberFromRoster(guildId, userId)
            onDone(ok)
        }
    }

    fun banMember(guildId: String, userId: String, reason: String?, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val ok = runCatching { api.banMember(guildId, userId, reason?.trim()?.ifBlank { null }) }.isSuccess
            if (ok) removeMemberFromRoster(guildId, userId)
            onDone(ok)
        }
    }

    /** Time a member out for `minutes` (0 clears the timeout). */
    fun timeoutMember(guildId: String, userId: String, minutes: Int, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val until = if (minutes > 0) java.time.Instant.now().plusSeconds(minutes * 60L).toString() else null
            val m = runCatching { api.timeoutMember(guildId, userId, until) }.getOrNull()
            if (m != null) _state.update { st ->
                val list = (st.membersByGuild[guildId] ?: emptyList()).map { if (it.userId == userId) m else it }
                st.copy(membersByGuild = st.membersByGuild + (guildId to list))
            }
            onDone(m != null)
        }
    }

    // ---- audit log + reports (moderator) -------------------------------------

    suspend fun auditLog(guildId: String, actionPrefix: String? = null): List<com.zekktris.data.model.AuditEntry> =
        runCatching { api.auditLog(guildId, actionPrefix) }.getOrDefault(emptyList())

    suspend fun listReports(guildId: String, status: String = "open"): com.zekktris.data.model.ReportsWrap =
        runCatching { api.listReports(guildId, status) }.getOrDefault(com.zekktris.data.model.ReportsWrap())

    fun handleReport(guildId: String, reportId: String, action: String, moderation: String = "none", onDone: (Boolean) -> Unit = {}) {
        scope.launch { onDone(runCatching { api.handleReport(guildId, reportId, action, moderation) }.isSuccess) }
    }

    // ---- self-assignable ("Get Roles") ---------------------------------------

    suspend fun selfAssignableRoles(guildId: String): List<com.zekktris.data.model.Role> =
        runCatching { api.listSelfAssignableRoles(guildId) }.getOrDefault(emptyList())

    /** Toggle a self-assignable role on myself (reads my membership set). */
    fun toggleSelfRole(guildId: String, roleId: String, has: Boolean, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val ok = runCatching {
                if (has) api.removeSelfRole(guildId, roleId) else api.addSelfRole(guildId, roleId)
            }.isSuccess
            if (ok) refreshMembers(guildId)
            onDone(ok)
        }
    }

    // ---- reaction roles (admin) ----------------------------------------------

    suspend fun reactionRoles(guildId: String): List<com.zekktris.data.model.ReactionRoleMapping> =
        runCatching { api.listReactionRoles(guildId) }.getOrDefault(emptyList())

    fun addReactionRole(guildId: String, messageId: String, channelId: String, emoji: String, roleId: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch { onDone(runCatching { api.addReactionRole(guildId, messageId, channelId, emoji, roleId) }.isSuccess) }
    }

    fun removeReactionRole(guildId: String, messageId: String, emoji: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch { onDone(runCatching { api.removeReactionRole(guildId, messageId, emoji) }.isSuccess) }
    }

    // ---- custom emoji (MANAGE_EMOJIS) ----------------------------------------

    private suspend fun reloadGuildEmojis(guildId: String) {
        val list = runCatching { api.listGuildEmojis(guildId) }.getOrNull() ?: return
        _state.update { if (it.selectedGuildId == guildId) it.copy(guildEmojis = list) else it }
    }

    fun uploadGuildEmoji(guildId: String, name: String, filename: String, mime: String, bytes: ByteArray, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val e = runCatching { api.uploadGuildEmoji(guildId, name.trim(), filename, mime, bytes) }.getOrNull()
            if (e != null) reloadGuildEmojis(guildId)
            onDone(e != null)
        }
    }

    fun deleteGuildEmoji(guildId: String, emojiId: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch {
            val ok = runCatching { api.deleteGuildEmoji(guildId, emojiId) }.isSuccess
            if (ok) reloadGuildEmojis(guildId)
            onDone(ok)
        }
    }

    // ---- channel permission overrides ----------------------------------------

    suspend fun channelPermissions(channelId: String): List<com.zekktris.data.model.PermissionOverride> =
        runCatching { api.listChannelPermissions(channelId) }.getOrDefault(emptyList())

    fun setChannelPermission(channelId: String, targetId: String, type: String, allow: String, deny: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch { onDone(runCatching { api.setChannelPermission(channelId, targetId, type, allow, deny) }.isSuccess) }
    }

    fun clearChannelPermission(channelId: String, targetId: String, type: String, onDone: (Boolean) -> Unit = {}) {
        scope.launch { onDone(runCatching { api.deleteChannelPermission(channelId, targetId, type) }.isSuccess) }
    }

    // ---- pinned messages -----------------------------------------------------

    /** Toggle a poll vote; optimistically record OUR ballot (myVotes) since the
        MESSAGE_UPDATE broadcast carries no per-user vote state. */
    fun togglePollVote(message: Message, optionId: String) {
        val cid = message.channelId
        val poll = message.poll ?: return
        val voted = poll.myVotes.contains(optionId)
        _state.update { st ->
            val list = st.messagesByChannel[cid] ?: return@update st
            st.copy(
                messagesByChannel = st.messagesByChannel + (cid to list.map { m ->
                    if (m.id == message.id && m.poll?.id == poll.id) {
                        val p = m.poll!!
                        val next = if (voted) p.myVotes - optionId
                        else (if (p.multipleChoice) p.myVotes else emptyList()) + optionId
                        m.copy(poll = p.copy(myVotes = next))
                    } else m
                }),
            )
        }
        scope.launch {
            runCatching {
                if (voted) api.removePollVote(cid, poll.id, optionId) else api.voteOnPoll(cid, poll.id, optionId)
            }
        }
    }

    /** Post a poll to [channelId]. Returns null on success or an error string.
     *  The returned message is inserted immediately (deduped by the gateway echo). */
    suspend fun sendPoll(channelId: String, question: String, options: List<String>, multipleChoice: Boolean, durationHours: Int): String? {
        val nonce = UUID.randomUUID().toString()
        return try {
            val msg = api.sendPoll(channelId, question.trim(), options, multipleChoice, durationHours, nonce)
            upsertMessage(channelId, msg)
            bumpRecency(channelId)
            null
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (e: Exception) {
            e.message ?: "Couldn't create poll."
        }
    }

    suspend fun loadPins(channelId: String): List<Message> =
        runCatching { api.listPinnedMessages(channelId) }.getOrDefault(emptyList())

    /** Toggle pin; optimistic flag flip in the open list, revert on failure.
        The server enforces MANAGE_MESSAGES and 403s in DMs. */
    fun togglePin(channelId: String, message: Message) {
        val pin = !message.pinned
        setPinnedFlag(channelId, message.id, pin)
        scope.launch {
            val ok = runCatching {
                if (pin) api.pinMessage(channelId, message.id) else api.unpinMessage(channelId, message.id)
            }.isSuccess
            if (!ok) setPinnedFlag(channelId, message.id, !pin)
        }
    }

    private fun setPinnedFlag(channelId: String, messageId: String, pinned: Boolean) {
        _state.update { st ->
            val list = st.messagesByChannel[channelId] ?: return@update st
            st.copy(
                messagesByChannel = st.messagesByChannel +
                    (channelId to list.map { if (it.id == messageId) it.copy(pinned = pinned) else it }),
            )
        }
    }

    // ---- invites (create / manage) -------------------------------------------

    suspend fun createInvite(channelId: String, maxUses: Int?, ttlSeconds: Int?): com.zekktris.data.model.Invite? =
        runCatching { api.createInvite(channelId, maxUses, ttlSeconds) }.getOrNull()

    suspend fun guildInvites(guildId: String): List<com.zekktris.data.model.Invite> =
        runCatching { api.listGuildInvites(guildId) }.getOrDefault(emptyList())

    fun revokeInvite(code: String, onDone: () -> Unit = {}) {
        scope.launch { runCatching { api.revokeInvite(code) }; onDone() }
    }

    /** Public members refresh for the roster sheet (loadMembers is private). */
    suspend fun refreshMembers(guildId: String) = loadMembers(guildId)

    // ---- voice calls ---------------------------------------------------------

    /** User tapped a voice channel / call button — stash it so the UI can
        request the mic permission, then call [confirmPendingVoice]. */
    fun requestVoice(channelId: String) = _state.update { it.copy(pendingVoiceChannelId = channelId) }
    fun cancelPendingVoice() = _state.update { it.copy(pendingVoiceChannelId = null) }

    fun confirmPendingVoice() {
        val cid = _state.value.pendingVoiceChannelId ?: return
        _state.update { it.copy(pendingVoiceChannelId = null) }
        // Stage channels join through the speaker/audience flow, not plain voice
        // (iOS openVoice routes on channel.isStage the same way).
        val ch = _state.value.channelsByGuild.values.flatten().firstOrNull { it.id == cid }
        if (ch?.isStage == true) joinStage(cid) else joinVoice(cid)
    }

    /** REST-join the room, then connect LiveKit with the returned token.
     *  Single-flight: a second tap while a join/switch is mid-flight is dropped,
     *  so two overlapping connect sequences can never race the WebRTC teardown. */
    @Volatile private var joiningVoice = false
    fun joinVoice(channelId: String) {
        if (joiningVoice) return
        joiningVoice = true
        scope.launch {
            try {
                // E2EE DM: resolve the media key BEFORE touching the server, so a
                // locked conversation fails cleanly here instead of joining a call
                // whose encrypted peer can't decode us — or, worse, sending our
                // media through the SFU in the clear (iOS openVoice, web
                // 'e2ee_locked').
                val media = callMedia(channelId)
                if (media is CallMedia.Locked) {
                    android.widget.Toast.makeText(appContext, "Unlock this conversation to start an encrypted call.", android.widget.Toast.LENGTH_LONG).show()
                    return@launch
                }
                // Switching channels: leave the current one first. Otherwise the
                // server keeps our old voice_state (we linger as a ghost others
                // can still hear) and, worse, we'd spin up a second LiveKit Room
                // before the old one finishes tearing down its native WebRTC peer
                // — the crash seen when hopping between calls. A clean leave gives
                // the SFU and the WebRTC stack a settled state to reconnect from.
                // One room at a time: a REAL stage leave first (server + SFU) —
                // otherwise the server keeps us in the stage roster and the old
                // LiveKit room stays connected under the new call (iOS joinVoice).
                val prevStage = _state.value.activeStageChannelId
                if (prevStage != null) {
                    voice.disconnect()
                    runCatching { api.leaveStage(prevStage) }
                    _state.update { it.copy(activeStageChannelId = null, stageParticipants = emptyList(), myStageSpeaker = false, stageTokenMissing = false, stageConnecting = false) }
                }
                val prev = _state.value.activeVoiceChannelId
                if (prev != null && prev != channelId) {
                    voice.disconnect()
                    runCatching { api.leaveVoice(prev) }
                    _state.update {
                        it.copy(
                            activeVoiceChannelId = null,
                            speakingUserIds = emptySet(),
                            selfMuted = false,
                            voiceStates = it.voiceStates - (it.me?.id ?: ""),
                        )
                    }
                } else if (prev == channelId &&
                    voice.connState.value != com.zekktris.voice.VoiceManager.ConnState.Idle &&
                    voice.connState.value != com.zekktris.voice.VoiceManager.ConnState.Failed) {
                    // Already live (or actively (re)connecting) in this exact
                    // channel — re-tapping shouldn't renegotiate. But an Idle/Failed
                    // room is a dropped call, so fall through and let a re-tap /
                    // Rejoin reconnect.
                    return@launch
                }
                val res = runCatching { api.joinVoice(channelId) }.getOrNull() ?: return@launch
                // Seed the roster from the join snapshot.
                _state.update { st ->
                    val seeded = st.voiceStates.toMutableMap()
                    res.channelVoiceStates.forEach { seeded[it.userId] = it }
                    res.voiceState?.let { seeded[it.userId] = it }
                    st.copy(
                        voiceStates = seeded,
                        activeVoiceChannelId = channelId,
                        incomingCall = null,
                        voiceTokenMissing = res.token == null || res.wsUrl == null,
                    )
                }
                val token = res.token
                val url = res.wsUrl
                if (token != null && url != null) {
                    voice.connect(url, token, e2eeKey = (media as? CallMedia.Encrypted)?.keyBase64)
                    // The server's roster starts everyone unmuted and only learns
                    // otherwise from a POST — but we can join with the mic already
                    // CLOSED (push-to-talk, or a deafen carried over from the last
                    // call), which showed a PTT user to everyone else as
                    // unmuted-but-silent for the whole call. Read the state AFTER
                    // connect settles so a toggle made during the handshake is what
                    // lands, and post only when it differs from the join snapshot.
                    // Gate on the CONNECTION, not on activeVoiceChannelId — that
                    // is set before connect() and so is still true after a failed
                    // handshake, which would post a mute for a call never entered.
                    if (voice.connState.value == com.zekktris.voice.VoiceManager.ConnState.Connected &&
                        _state.value.activeVoiceChannelId == channelId
                    ) {
                        val mute = voice.muted.value
                        val deaf = voice.deafened.value
                        if (mute != (res.voiceState?.selfMute == true) || deaf != (res.voiceState?.selfDeaf == true)) {
                            runCatching { api.setVoiceState(channelId, selfMute = mute, selfDeaf = deaf) }
                        }
                    }
                }
            } finally {
                joiningVoice = false
            }
        }
    }

    private sealed interface CallMedia {
        data object Plain : CallMedia
        data object Locked : CallMedia
        data class Encrypted(val keyBase64: String) : CallMedia
    }

    /** How a call in [channelId] is keyed. An E2EE DM is [CallMedia.Encrypted]
     *  with the base64 (padded, RFC 4648) of its 32-byte DM key — byte for byte
     *  the string web (getCallKeyString) and iOS (Voice.swift) hand LiveKit, so
     *  all three derive the same media key (voice/CallEncryption) — or
     *  [CallMedia.Locked] when this device has no current key for it. */
    private suspend fun callMedia(channelId: String): CallMedia {
        // A call answered from the ring on a cold start can get here before
        // loadInitial has the DM list, and an unknown channel must not be taken
        // for a plain one. Guild voice channels are always loaded by then.
        val ch = dmById(channelId)
            ?: runCatching { api.listDMs() }.getOrNull()?.firstOrNull { it.id == channelId }
        // Still unknown (offline): only a DM we hold a key for can be E2EE.
        val isE2EE = ch?.isE2EE ?: (e2eeStore.key(channelId) != null)
        if (!isE2EE) return CallMedia.Plain
        val key = e2eeKeyFor(channelId)
            // e2eeKeyFor checks the verifier of the channel in state; one only
            // just fetched above is checked here.
            ?.takeIf { k -> ch?.e2eeVerifier.let { it == null || com.zekktris.crypto.E2EE.verifier(k) == it } }
            ?: return CallMedia.Locked
        return CallMedia.Encrypted(android.util.Base64.encodeToString(key, android.util.Base64.NO_WRAP))
    }

    /** Leave the active call (single-flight): disconnect LiveKit + REST leave. */
    @Volatile private var leavingVoice = false
    fun leaveCurrentVoice() {
        val cid = _state.value.activeVoiceChannelId ?: return
        if (leavingVoice) return
        leavingVoice = true
        scope.launch {
            voice.disconnect()
            runCatching { api.leaveVoice(cid) }
            _state.update {
                it.copy(
                    activeVoiceChannelId = null,
                    speakingUserIds = emptySet(),
                    selfMuted = false,
                    voiceTokenMissing = false,
                    voiceStates = it.voiceStates - (it.me?.id ?: ""),
                )
            }
            leavingVoice = false
        }
    }

    fun toggleVoiceMute() {
        val cid = _state.value.activeVoiceChannelId ?: return
        val next = !_state.value.selfMuted
        scope.launch {
            voice.setMuted(next)
            runCatching { api.setVoiceState(cid, selfMute = next, selfDeaf = null) }
        }
    }

    /** Deafen also mutes the mic, so push BOTH selfMute and selfDeaf. */
    fun toggleVoiceDeafen() {
        val cid = _state.value.activeVoiceChannelId ?: return
        scope.launch {
            voice.toggleDeafen()
            runCatching { api.setVoiceState(cid, selfMute = voice.muted.value, selfDeaf = voice.deafened.value) }
        }
    }

    /** Silence a single participant for you only (local, not synced to the server). */
    fun toggleMutedForMe(userId: String) {
        voice.setMutedForMe(userId, !_state.value.mutedForMeIds.contains(userId))
    }

    /** Set push-to-talk from Settings (works in or out of a call). Routed through
     *  VoiceManager rather than writing the pref directly: it is the single writer
     *  of `_pttEnabled`, so a direct pref write left a mid-call user with the
     *  switch off but the mic still PTT-gated — talking with nothing held and
     *  nobody hearing them until they rejoined. */
    fun setPushToTalk(on: Boolean) {
        scope.launch {
            voice.setPttEnabled(on) // persists the pref + reconciles the mic
            val cid = _state.value.activeVoiceChannelId ?: return@launch
            runCatching { api.setVoiceState(cid, selfMute = voice.muted.value, selfDeaf = null) }
        }
    }

    /** Toggle push-to-talk; enabling closes the mic, so sync selfMute too. */
    fun toggleVoicePtt() {
        val cid = _state.value.activeVoiceChannelId ?: return
        val next = !_state.value.pttEnabled
        scope.launch {
            voice.setPttEnabled(next)
            runCatching { api.setVoiceState(cid, selfMute = voice.muted.value, selfDeaf = null) }
        }
    }

    /** Press/release the Talk button (PTT). Local-only — a held/released mic is
     *  transient, so we DON'T post selfMute on every press (avoids a network race
     *  between the press and release posts; the mic itself is reconciled locally). */
    fun setVoicePttHeld(held: Boolean) {
        if (_state.value.activeVoiceChannelId == null) return
        scope.launch { voice.setPttHeld(held) }
    }

    fun setVoiceSpeaker(on: Boolean) = voice.setSpeaker(on)

    /** Publish/unpublish the local camera (CAMERA permission requested by the UI). */
    fun toggleVoiceCamera() {
        if (_state.value.activeVoiceChannelId == null) return
        scope.launch { voice.toggleCamera() }
    }

    fun flipVoiceCamera() {
        scope.launch { voice.flipCamera() }
    }

    /** Start screen share with the MediaProjection permission result (from the
        UI's system consent dialog). The LiveKit SDK runs its own FG service. */
    fun startVoiceScreenShare(resultData: android.content.Intent) {
        if (_state.value.activeVoiceChannelId == null) return
        scope.launch { voice.startScreenShare(resultData) }
    }

    fun stopVoiceScreenShare() {
        scope.launch { voice.stopScreenShare() }
    }

    /** Attach the LiveKit EGL context to a video renderer view. */
    fun voiceInitRenderer(view: io.livekit.android.renderer.TextureViewRenderer) = voice.initRenderer(view)

    // ---- stage channels ------------------------------------------------------
    // Speaker/audience rooms (iOS AppStore.swift "Stage channels" block). The
    // LiveKit publish grant is gated server-side on the speaker bit; a
    // promotion/demotion re-fetches a token and reconnects.

    /** Single-flight stage join (mirrors joinVoice's guard). Shared with the
     *  promotion reconnect in [applyStageParticipants] — that path is a re-join
     *  too, so both must sit behind ONE gate or they overlap on the LiveKit room.
     *
     *  Atomic (not a plain @Volatile flag) because the two claimants run on
     *  different threads: taps arrive on Main.immediate, while the gateway's
     *  STAGE_PARTICIPANTS_UPDATE — the promotion trigger — is dispatched on
     *  Dispatchers.Default (see the collector in init). A check-then-set would
     *  let both through; compareAndSet cannot. */
    private val joiningStage = java.util.concurrent.atomic.AtomicBoolean(false)
    fun joinStage(channelId: String) {
        if (!joiningStage.compareAndSet(false, true)) return
        scope.launch {
            try {
                // One LiveKit room at a time: REALLY leave plain voice first
                // (server + SFU), or the server keeps our old voice_state and the
                // old room's audio keeps playing under the stage UI.
                val prevVoice = _state.value.activeVoiceChannelId
                if (prevVoice != null) {
                    voice.disconnect()
                    runCatching { api.leaveVoice(prevVoice) }
                    _state.update {
                        it.copy(
                            activeVoiceChannelId = null,
                            speakingUserIds = emptySet(),
                            selfMuted = false,
                            voiceTokenMissing = false,
                            voiceStates = it.voiceStates - (it.me?.id ?: ""),
                        )
                    }
                }
                val prevStage = _state.value.activeStageChannelId
                if (prevStage == channelId &&
                    voice.connState.value != com.zekktris.voice.VoiceManager.ConnState.Idle &&
                    voice.connState.value != com.zekktris.voice.VoiceManager.ConnState.Failed) {
                    // Already live (or connecting) on this stage — re-tap is a no-op.
                    return@launch
                }
                if (prevStage != null && prevStage != channelId) {
                    voice.disconnect()
                    runCatching { api.leaveStage(prevStage) }
                    _state.update { it.copy(activeStageChannelId = null, stageParticipants = emptyList(), myStageSpeaker = false, stageTokenMissing = false) }
                }
                _state.update { it.copy(stageConnecting = true) }
                val res = runCatching { api.joinStage(channelId) }.getOrNull() ?: return@launch
                _state.update {
                    it.copy(
                        activeStageChannelId = channelId,
                        myStageSpeaker = res.participant.isSpeaker,
                        stageTokenMissing = res.token == null || res.wsUrl == null,
                        incomingCall = null,
                    )
                }
                val token = res.token
                val url = res.wsUrl
                if (token != null && url != null) voice.connect(url, token, publishMic = res.participant.isSpeaker)
                refreshStage()
            } finally {
                _state.update { it.copy(stageConnecting = false) }
                joiningStage.set(false)
            }
        }
    }

    /** Re-pull the stage roster (gateway push is the fast path; the screen also
     *  polls this every 4s as a safety net, matching iOS). */
    suspend fun refreshStage() {
        val cid = _state.value.activeStageChannelId ?: return
        val res = runCatching { api.listStageParticipants(cid) }.getOrNull() ?: return
        applyStageParticipants(cid, res.participants)
    }

    /** Replace the roster + reconcile our own speaker bit: if a moderator flipped
     *  it, re-join for a token gated on the new role and reconnect (audience ↔
     *  speaker needs a new publish grant at the SFU). */
    private fun applyStageParticipants(channelId: String, list: List<com.zekktris.data.model.StageParticipant>) {
        if (_state.value.activeStageChannelId != channelId) return
        _state.update { it.copy(stageParticipants = list) }
        val meId = _state.value.me?.id ?: return
        val me = list.firstOrNull { it.userId == meId } ?: return
        if (me.isSpeaker != _state.value.myStageSpeaker) {
            // Behind the SAME single-flight as joinStage: a promotion reconnect is
            // a re-join. Two rapid moderator flips (or a flip racing a tap/leave)
            // used to start two overlapping LiveKit connects on one room — the
            // WebRTC "teardown while still in use" crash class.
            //
            // Claim the gate BEFORE writing myStageSpeaker: if we bail here having
            // already stored the new bit, the difference is gone and no later poll
            // would ever reconnect, leaving a "speaker" with an audience token that
            // cannot publish. Leaving the bit alone means the 4s poll retries.
            if (!joiningStage.compareAndSet(false, true)) return
            _state.update { it.copy(myStageSpeaker = me.isSpeaker) }
            scope.launch {
                try {
                    val again = runCatching { api.joinStage(channelId) }.getOrNull() ?: return@launch
                    val token = again.token
                    val url = again.wsUrl
                    if (token == null || url == null) return@launch
                    // Re-check AFTER the await: leaving (or hopping to another
                    // stage/call) mid-flight must not reconnect us into a stage we
                    // already left.
                    if (_state.value.activeStageChannelId != channelId) return@launch
                    voice.connect(url, token, publishMic = again.participant.isSpeaker)
                    // ...and again after the connect await — a leave that landed
                    // during the SFU handshake already ran its disconnect(), so the
                    // room we just built would linger with no stage behind it.
                    if (_state.value.activeStageChannelId != channelId) voice.disconnect()
                } finally {
                    joiningStage.set(false)
                }
            }
        }
    }

    /** Leave the stage (single-flight): disconnect LiveKit + REST leave. */
    @Volatile private var leavingStage = false
    fun leaveStage() {
        val cid = _state.value.activeStageChannelId ?: return
        if (leavingStage) return
        leavingStage = true
        scope.launch {
            _state.update {
                it.copy(
                    activeStageChannelId = null,
                    stageParticipants = emptyList(),
                    myStageSpeaker = false,
                    stageTokenMissing = false,
                    stageConnecting = false,
                    speakingUserIds = emptySet(),
                    selfMuted = false,
                )
            }
            voice.disconnect()
            runCatching { api.leaveStage(cid) }
            leavingStage = false
        }
    }

    /** Audience "request to speak" toggle. */
    fun raiseStageHand() {
        val cid = _state.value.activeStageChannelId ?: return
        scope.launch { runCatching { api.raiseStageHand(cid) }; refreshStage() }
    }

    fun lowerStageHand() {
        val cid = _state.value.activeStageChannelId ?: return
        scope.launch { runCatching { api.lowerStageHand(cid) }; refreshStage() }
    }

    /** Moderator promote/demote (server enforces MANAGE_CHANNELS). */
    fun setStageSpeaker(userId: String, isSpeaker: Boolean) {
        val cid = _state.value.activeStageChannelId ?: return
        scope.launch { runCatching { api.setStageSpeaker(cid, userId, isSpeaker) }; refreshStage() }
    }

    /** Speaker mute toggle. Local-only — stage join doesn't create a voice_state
     *  row, so there is no /voice/state to sync (iOS toggleVoiceMute's REST post
     *  is likewise skipped when voiceChannelId is nil). */
    fun toggleStageMute() {
        if (_state.value.activeStageChannelId == null || !_state.value.myStageSpeaker) return
        scope.launch { voice.setMuted(!voice.muted.value) }
    }

    /** Accept a ringing call → join it. Decline → REST decline + clear. */
    fun acceptCall() {
        val call = _state.value.incomingCall ?: return
        _state.update { it.copy(incomingCall = null) }
        requestVoice(call.channelId)
    }

    fun declineCall() {
        val call = _state.value.incomingCall ?: return
        _state.update { it.copy(incomingCall = null) }
        scope.launch { runCatching { api.declineVoice(call.channelId) } }
    }

    // ---- notification-driven actions (background / cold start) ---------------
    // These are called from FCM receivers where the app may have JUST been woken
    // from a killed state, so they key off the push's own channel id / E2EE flag
    // instead of assuming `state` (DMs, incomingCall) is loaded yet.

    /** Answer a call from a full-screen ring / push action by channel id. Routes
     *  through the normal pending-voice flow so the UI still requests the mic. */
    fun answerCallChannel(channelId: String) {
        _state.update { if (it.incomingCall?.channelId == channelId) it.copy(incomingCall = null) else it }
        requestVoice(channelId)
    }

    /** Decline a call by channel id — REST-declines even if we never held the
     *  incomingCall in state (killed process woken only by the ring push).
     *  [onDone] fires once the request has settled so a BroadcastReceiver can
     *  keep its process alive until then (see [sendQuickReply]). */
    fun declineCallChannel(channelId: String, onDone: () -> Unit = {}) {
        _state.update { if (it.incomingCall?.channelId == channelId) it.copy(incomingCall = null) else it }
        scope.launch {
            runCatching { api.declineVoice(channelId) }
            onDone()
        }
    }

    /** Decrypt an E2EE push-preview ciphertext for [channelId] with the stored
     *  channel key, or null if we don't hold it (locked / not set up on this
     *  device). Lets a notification show the real preview instead of "Encrypted
     *  message" without the server ever seeing plaintext. */
    fun decryptPushPreview(channelId: String, wire: String): String? {
        val key = e2eeKeyFor(channelId) ?: return null
        return runCatching { com.zekktris.crypto.E2EE.decrypt(wire, key) }.getOrNull()
    }

    /** Send an inline notification quick-reply. Uses the push's explicit [isE2EE]
     *  flag + the stored key (state may not be loaded), so an E2EE DM reply is
     *  never sent in plaintext. [onDone] fires with success once the POST lands
     *  so a BroadcastReceiver can keep its process alive until then. */
    fun sendQuickReply(channelId: String, text: String, isE2EE: Boolean, onDone: (Boolean) -> Unit) {
        val body = text.trim()
        if (body.isEmpty()) { onDone(false); return }
        val wire: String = if (isE2EE) {
            val key = e2eeKeyFor(channelId) ?: run { onDone(false); return }
            com.zekktris.crypto.E2EE.encrypt(body, key) ?: run { onDone(false); return }
        } else body
        val nonce = UUID.randomUUID().toString()
        scope.launch {
            val sent = runCatching { api.sendMessage(channelId, wire, nonce, null) }.getOrNull()
            if (sent != null) { upsertMessage(channelId, sent); bumpRecency(channelId) }
            onDone(sent != null)
        }
    }

    /** Take down a posted incoming-call ring for [channelId]. The ring is an
     *  ONGOING notification (unswipeable), so nothing but this dismisses it —
     *  and it must work in a push-woken process where `incomingCall` was never
     *  set. Idempotent: a no-op when no ring is showing. */
    fun clearRingFor(channelId: String) {
        push.cancelIncomingCall(channelId)
    }

    /** The server dropped us from our own call → tear down LiveKit locally. */
    private fun handleSelfVoiceEnd() {
        scope.launch { voice.disconnect() }
        // A ring posted by the push (cold process) outlives the call itself —
        // clear it here too or it hangs around after the call has ended.
        _state.value.activeVoiceChannelId?.let { clearRingFor(it) }
        _state.update {
            it.copy(activeVoiceChannelId = null, speakingUserIds = emptySet(), selfMuted = false, voiceTokenMissing = false)
        }
    }

    /** Ring when someone joins a 1:1 DM we're a recipient of and we're free. */
    private fun maybeRing(vs: com.zekktris.data.model.VoiceState) {
        val st = _state.value
        if (st.activeVoiceChannelId != null || st.incomingCall != null) return
        val dm = st.dms.firstOrNull { it.id == vs.channelId } ?: return
        if (dm.type != "dm") return
        val caller = dm.recipients?.firstOrNull { it.id == vs.userId } ?: return
        _state.update { it.copy(incomingCall = IncomingCall(dm.id, vs.userId, caller.bestName)) }
    }

    /** Stop ringing if the caller who was ringing us has left voice. */
    private fun maybeCancelRing(userId: String) {
        // Resolve the channel WITHOUT requiring `incomingCall`: when the ring came
        // from a push into a cold process the in-memory call state was never set,
        // and keying off it left the ongoing (unswipeable) ring on screen forever
        // after the caller hung up. Fall back to the 1:1 DM shared with them —
        // iOS handleIncomingCall does exactly this on a channelId==null state.
        val call = _state.value.incomingCall
        val channelId = call?.takeIf { it.callerId == userId }?.channelId
            ?: _state.value.dms.firstOrNull { dm ->
                dm.type == "dm" && dm.recipients?.any { r -> r.id == userId } == true
            }?.id
            ?: return
        if (call?.channelId == channelId) _state.update { it.copy(incomingCall = null) }
        clearRingFor(channelId)
    }

    /** 1:1 auto-hangup: when the peer leaves our active DM call, hang up too. */
    private fun maybeAutoHangup() {
        val st = _state.value
        val cid = st.activeVoiceChannelId ?: return
        val dm = st.dms.firstOrNull { it.id == cid } ?: return // guild voice never auto-hangs
        if (dm.type != "dm") return
        val meId = st.me?.id
        val others = st.voiceStates.values.count { it.channelId == cid && it.userId != meId }
        if (others == 0) leaveCurrentVoice()
    }

    /** Throttled typing signal — at most one POST per 4s of continuous typing. */
    private var lastTypingSentAt = 0L
    fun noteTyping(channelId: String) {
        val now = System.currentTimeMillis()
        if (now - lastTypingSentAt < 3_000) return
        lastTypingSentAt = now
        scope.launch { api.sendTyping(channelId) }
    }

    // ---- friends / mentions / saved / scheduled / events ---------------------

    // ---- user profile card --------------------------------------------------

    /** Open the profile card for a user; refresh relationships + fetch the full
        profile (bio/banner/canMessage/tier that list-derived users lack). */
    fun openProfile(user: com.zekktris.data.model.PublicUser) {
        _state.update { it.copy(profileUser = user) }
        loadRelationships()
        scope.launch {
            val full = runCatching { api.getUserProfile(user.id) }.getOrNull()
            if (full != null) _state.update { if (it.profileUser?.id == user.id) it.copy(profileUser = full) else it }
        }
    }

    fun openProfileById(userId: String) {
        loadRelationships()
        scope.launch {
            val u = runCatching { api.getUserProfile(userId) }.getOrNull() ?: return@launch
            _state.update { it.copy(profileUser = u) }
        }
    }

    fun closeProfile() = _state.update { it.copy(profileUser = null) }

    /** Message from the profile card: close it, then open/create the DM. */
    fun messageFromProfile(userId: String) { closeProfile(); openDM(userId) }

    /** Call from the profile card: open the DM, then start a voice call in it. */
    fun callFromProfile(userId: String) {
        closeProfile()
        scope.launch {
            val ch = runCatching { api.openDM(userId) }.getOrNull() ?: return@launch
            _state.update {
                val dms = listOf(ch) + it.dms.filterNot { d -> d.id == ch.id }
                it.copy(dms = dms, selectedGuildId = null, selectedChannelId = ch.id, guildEmojis = emptyList())
            }
            if (_state.value.messagesByChannel[ch.id] == null) loadMessages(ch.id)
            requestVoice(ch.id)
        }
    }

    fun reportUser(guildId: String, targetId: String, reason: String, details: String, onDone: () -> Unit = {}) {
        scope.launch { runCatching { api.reportUser(guildId, targetId, reason, details) }; onDone() }
    }

    /**
     * Refetch the friend/blocked list. Returns true only when the fetch actually
     * succeeded — callers that are about to act on the blocked set (see
     * [blockUser]) must be able to tell a real answer from a kept-stale one.
     */
    private suspend fun refreshRelationships(): Boolean {
        val presenceBefore = _state.value.presence
        val r = runCatching { api.listRelationships() }.getOrNull() ?: return false
        _state.update { it.copy(relationships = r) }
        seedPresence(r.map { rel -> rel.user }, presenceBefore)
        relationshipsLoaded = true
        // The share sheet filters on this list, so a completed refresh is the
        // trigger that both (a) releases the cold-start publish that was waiting
        // on [relationshipsLoaded], and (b) reacts to a block made on ANOTHER
        // device, which reaches this client only through this list. Revoke first
        // — the republish cannot evict a cached long-lived shortcut on its own.
        revokeBlockedShareShortcuts()
        refreshShareShortcuts()
        return true
    }

    fun loadRelationships() {
        scope.launch { refreshRelationships() }
    }

    /** Send a friend request. Calls back null on success, or an error string. */
    fun addFriend(username: String, onResult: (String?) -> Unit) {
        scope.launch {
            val err = runCatching { api.addFriend(username.trim()) }
                .fold(onSuccess = { null }, onFailure = {
                    if ((it as? com.zekktris.data.ApiException)?.status == 404) "No user with that username."
                    else "Couldn't send the request."
                })
            if (err == null) loadRelationships()
            onResult(err)
        }
    }

    fun acceptFriend(targetId: String) {
        scope.launch { runCatching { api.acceptFriend(targetId) }; loadRelationships() }
    }

    /** Remove friend / decline incoming / cancel outgoing — one endpoint. */
    fun removeFriend(targetId: String) {
        scope.launch { runCatching { api.removeFriend(targetId) }; loadRelationships() }
    }

    fun blockUser(targetId: String) {
        scope.launch {
            // Record the intent BEFORE the request: from here on the share-sheet
            // filter excludes this peer whether or not the server ever confirms.
            locallyBlockedIds = locallyBlockedIds + targetId
            runCatching { api.blockUser(targetId) }
            // Blocking someone must also pull them out of the SYSTEM share sheet,
            // where their name + face would otherwise stay published as a direct
            // share target. Explicitly, not via the republish: a republish drops
            // them from the dynamic set but does NOT evict the system's CACHED
            // copy of a long-lived shortcut.
            //
            // Order matters. Kill any debounced publish still armed BEFORE
            // revoking (cancelAndJoin, so it cannot be mid-write and land after
            // us) — it was scheduled against a relationship list that still says
            // this peer is fine to publish.
            // (Bare, not wrapped in runCatching — `join` never rethrows the
            // joined job's failure, so the only thing that can throw here is
            // OUR OWN cancellation, which must propagate rather than be eaten.)
            shareShortcutJob?.let { job ->
                shareShortcutJob = null
                job.cancelAndJoin()
            }
            // `remove`, not `removePublished`: this is the one moment the user
            // explicitly asked for this person to go away, so the removal is
            // unconditional rather than gated on our own published-id
            // bookkeeping (whose write is itself best-effort — if it was ever
            // lost, the intersecting variant would skip a shortcut the system
            // still has cached).
            _state.value.dms
                .filter { ch -> ch.type == "dm" && ch.recipients.orEmpty().any { it.id == targetId } }
                .forEach { ch -> runCatching { com.zekktris.share.ShareShortcuts.remove(appContext, ch.id) } }
            // On success this republishes from the fresh list (which now filters
            // this peer out). On FAILURE it deliberately publishes nothing: the
            // cached list still has this peer as unblocked, so republishing from
            // it would restore the very shortcut just revoked. Leaving the
            // removal standing until some later refresh succeeds is the safe
            // direction — the entry is gone either way, and re-earning it costs
            // nothing but a menu slot.
            refreshRelationships()
        }
    }

    fun unblockUser(targetId: String) {
        scope.launch {
            runCatching { api.unblockUser(targetId) }
            locallyBlockedIds = locallyBlockedIds - targetId
            // Eligible to be a share target again — but only republish off a
            // list we actually re-fetched, which refreshRelationships does for
            // us on success. On failure the peer stays absent from the sheet.
            refreshRelationships()
        }
    }

    fun loadMentions() {
        scope.launch {
            val m = runCatching { api.listMentions() }.getOrNull() ?: return@launch
            _state.update { it.copy(mentions = m) }
        }
    }

    fun dismissMention(messageId: String) {
        _state.update { it.copy(mentions = it.mentions.filterNot { m -> m.id == messageId }) }
        scope.launch { runCatching { api.dismissMention(messageId) } }
    }

    fun clearMentions() {
        _state.update { it.copy(mentions = emptyList()) }
        scope.launch { runCatching { api.clearMentions() } }
    }

    fun loadSaved() {
        scope.launch {
            val s = runCatching { api.listSaved() }.getOrNull() ?: return@launch
            _state.update { it.copy(saved = s, savedIds = s.map { m -> m.message.id }.toSet()) }
        }
    }

    fun unsave(messageId: String) {
        _state.update { it.copy(saved = it.saved.filterNot { s -> s.message.id == messageId }, savedIds = it.savedIds - messageId) }
        scope.launch { runCatching { api.unsaveMessage(messageId) } }
    }

    /** Toggle bookmark from the message action sheet (optimistic saved-id set). */
    fun toggleSave(message: Message) {
        val id = message.id
        val saved = _state.value.savedIds.contains(id)
        _state.update { it.copy(savedIds = if (saved) it.savedIds - id else it.savedIds + id) }
        scope.launch { runCatching { if (saved) api.unsaveMessage(id) else api.saveMessage(id) } }
    }

    /** Forward a message into another channel (sends an empty message carrying
        forwardFromMessageId), then jump there. */
    fun forwardMessage(message: Message, channelId: String) {
        scope.launch {
            runCatching { api.sendMessage(channelId, "", java.util.UUID.randomUUID().toString(), null, message.id) }
            selectChannel(channelId)
        }
    }

    fun loadScheduled() {
        scope.launch {
            val s = runCatching { api.listScheduled() }.getOrNull() ?: return@launch
            _state.update { it.copy(scheduled = s.sortedBy { m -> m.scheduledFor }) }
        }
    }

    /**
     * Queue [content] for delivery to [channelId] at [isoWhen] (ISO-8601).
     * Returns null on success, or a user-facing error string. In an E2EE DM the
     * plaintext is pre-encrypted here (the server stores + fires the ciphertext
     * verbatim; the recipient decrypts on receipt like any encrypted message).
     */
    suspend fun scheduleMessage(channelId: String, content: String, isoWhen: String): String? {
        val wire: String = if (dmById(channelId)?.isE2EE == true) {
            val key = e2eeKeyFor(channelId)
                ?: return "Unlock this conversation to schedule encrypted messages."
            val enc = com.zekktris.crypto.E2EE.encrypt(content, key)
                ?: return "Couldn't encrypt this message."
            // Ciphertext is ~34% larger than plaintext; reject clearly here rather
            // than failing the request with a cryptic server length error.
            if (enc.length > 4000) return "This message is too long to schedule in an encrypted DM."
            enc
        } else content
        return try {
            val sm = api.scheduleMessage(channelId, wire, isoWhen)
            _state.update { it.copy(scheduled = (it.scheduled + sm).sortedBy { m -> m.scheduledFor }) }
            null
        } catch (e: Exception) {
            e.message ?: "Couldn't schedule this message."
        }
    }

    fun cancelScheduled(id: String) {
        _state.update { it.copy(scheduled = it.scheduled.filterNot { s -> s.id == id }) }
        scope.launch { runCatching { api.cancelScheduled(id) } }
    }

    fun loadMyEvents() {
        scope.launch {
            val e = runCatching { api.listMyEvents() }.getOrNull() ?: return@launch
            _state.update { it.copy(myEvents = e) }
        }
    }

    /** Cross-DM search; suspend so the screen can await results on submit. */
    /** Channel-scoped message search (iOS store.searchMessages). */
    suspend fun searchChannelMessages(channelId: String, query: String): List<Message> =
        runCatching { api.searchMessages(channelId, query) }.getOrDefault(emptyList())

    suspend fun searchDms(query: String): List<Message> =
        runCatching { api.searchDms(query) }.getOrDefault(emptyList())

    // ---- account security (suspend wrappers; null = success, else message) ---

    private fun securityError(e: Throwable, wrongPw: String = "Incorrect password."): String {
        val status = (e as? com.zekktris.data.ApiException)?.status
        return when (status) {
            401 -> wrongPw
            429 -> "Too many attempts — try again in a few minutes."
            else -> "Something went wrong. Check your details and try again."
        }
    }

    suspend fun changePassword(current: String, new: String): String? =
        runCatching { api.changePassword(current, new) }
            .fold({ null }, { securityError(it) })

    suspend fun changeUsername(username: String, currentPassword: String): String? =
        runCatching { api.changeUsername(username, currentPassword) }
            .fold({ updated -> _state.update { it.copy(me = updated) }; null }, { securityError(it) })

    suspend fun requestEmailChange(newEmail: String, currentPassword: String): String? =
        runCatching { api.requestEmailChange(newEmail, currentPassword) }
            .fold({ null }, { securityError(it) })

    suspend fun totpStatus() = runCatching { api.totpStatus() }.getOrNull()
    suspend fun totpBegin() = runCatching { api.totpBegin() }.getOrNull()
    suspend fun totpConfirm(code: String, currentPassword: String) =
        runCatching { api.totpConfirm(code, currentPassword) }.getOrNull()
    suspend fun totpDisable(code: String): Boolean =
        runCatching { api.totpDisable(code) }.isSuccess

    // ── Device-approval login: the APPROVER half (this device is signed in) ──
    // Endpoints shared with iOS/web. See runDeviceLogin below for the other
    // half, and apps/api/src/auth/device-login-store.ts for why the approval
    // screen is a security control rather than a formality.

    /** Look up what a scanned/typed code is asking for. Null when the code is
     *  unknown or expired (404) — deliberately indistinguishable, so this is
     *  never an oracle for "does this code exist". */
    suspend fun lookupDeviceLogin(userCode: String): com.zekktris.data.model.DeviceLoginRequestInfo? =
        runCatching { api.deviceLoginLookup(userCode) }.getOrNull()

    /** Approve. Returns null on success, else a message to show. */
    suspend fun approveDeviceLogin(userCode: String): String? =
        decideDeviceLogin(userCode, approve = true)

    /** Deny. Returns null on success, else a message to show. */
    suspend fun denyDeviceLogin(userCode: String): String? =
        decideDeviceLogin(userCode, approve = false)

    private suspend fun decideDeviceLogin(userCode: String, approve: Boolean): String? = try {
        if (approve) api.deviceLoginApprove(userCode) else api.deviceLoginDeny(userCode)
        null
    } catch (e: kotlinx.coroutines.CancellationException) {
        throw e
    } catch (e: com.zekktris.data.ApiException) {
        when (e.status) {
            404 -> "That request expired. Ask the other device for a new code."
            // Approve and deny race to a single atomic outcome; whoever lost
            // needs to know the decision was already made, not retry.
            409 -> "That request was already answered."
            429 -> "Too many attempts. Wait a moment and try again."
            else -> "Couldn't reach Zekktris. Try again."
        }
    } catch (e: Exception) {
        "Couldn't reach Zekktris. Try again."
    }

    suspend fun listSessions() = runCatching { api.listSessions() }.getOrDefault(emptyList())
    suspend fun revokeSession(id: String): Boolean =
        runCatching { api.revokeSession(id) }.isSuccess

    // ---- gateway dispatch ---------------------------------------------------

    private fun onDispatch(d: Gateway.Dispatch) {
        when (d.type) {
            "READY" -> onReady(d.data)
            "RESUMED" -> {
                _state.value.selectedChannelId?.let { id -> scope.launch { syncNewMessages(id) } }
                // A resume replays buffered dispatches, but read-states advanced
                // by a cross-device read (no live event) and @-mention badges
                // (never carried by live MESSAGE_CREATE) don't converge from the
                // replay — REPLACE them from server truth. Idempotent.
                scope.launch {
                    runCatching { api.listReadStates() }.getOrNull()?.let { rs ->
                        _state.update { it.copy(readStates = rs.associateBy { s -> s.channelId }) }
                    }
                }
            }
            "MESSAGE_CREATE", "MESSAGE_UPDATE" -> decodeMessage(d.data)?.let { m ->
                upsertMessage(m.channelId, m)
                if (d.type == "MESSAGE_CREATE") {
                    // Advance the channel/DM's lastMessageId so unread state is
                    // computed against the true latest — not a pointer that only
                    // listDMs/READY refreshes. Without this, reading a chat and
                    // then a later refresh (or the next message) flips it back to
                    // unread because the read-state was ahead of the stale channel.
                    advanceLastMessage(m.channelId, m.id)
                    bumpRecency(m.channelId)
                    val authorId = m.authorId ?: m.author?.id
                    // A user's message supersedes their typing indicator.
                    authorId?.let { uid -> clearTyping(m.channelId, uid) }
                    // Our OWN message (sent from THIS or another device) must never
                    // light an unread dot for us. The server advances our read-state
                    // on create but emits NO CHANNEL_ACK, and a CLOSED channel never
                    // reaches the foreground ack below — so advance the local marker
                    // here (mirrors iOS/web). Monotonic string guard so an
                    // out-of-order echo can't regress it; require a numeric id to
                    // skip Android's optimistic "pending-$nonce" ids.
                    if (authorId != null && authorId == _state.value.me?.id &&
                        m.id.isNotEmpty() && m.id.all(Char::isDigit)) {
                        _state.update { st ->
                            val prev = st.readStates[m.channelId]?.lastMessageId
                            if (prev == null || m.id > prev) {
                                st.copy(readStates = st.readStates + (m.channelId to ReadState(
                                    channelId = m.channelId, lastMessageId = m.id, mentionCount = 0,
                                )))
                            } else st
                        }
                    }
                    // A message arriving in the conversation we're actively viewing
                    // is already read — advance the ack so an open chat can never
                    // flip to unread under us.
                    if (appForeground && _state.value.selectedChannelId == m.channelId) {
                        scope.launch { ack(m.channelId) }
                    }
                }
            }
            "TYPING_START" -> {
                // Server payload is snake_case: { channel_id, user_id }.
                val obj = d.data?.jsonObject ?: return
                val cid = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                val uid = obj["user_id"]?.jsonPrimitive?.contentOrNull ?: return
                if (uid == _state.value.me?.id) return
                val until = System.currentTimeMillis() + 8_000
                _state.update {
                    val ch = (it.typingByChannel[cid] ?: emptyMap()) + (uid to until)
                    it.copy(typingByChannel = it.typingByChannel + (cid to ch))
                }
                // Expire ~8s after the LATEST signal (later events bump the stamp).
                scope.launch {
                    delay(8_100)
                    _state.update { st ->
                        val ch = st.typingByChannel[cid] ?: return@update st
                        if ((ch[uid] ?: 0L) > System.currentTimeMillis()) return@update st
                        st.copy(typingByChannel = st.typingByChannel + (cid to (ch - uid)))
                    }
                }
            }
            "VOICE_STATE_UPDATE" -> {
                // camelCase VoiceState; channelId == null ⇒ that user left voice.
                val vs = decode<com.zekktris.data.model.VoiceState>(d.data) ?: return
                val meId = _state.value.me?.id
                // The channel this user was in BEFORE we mutate the roster — needed
                // to decide whether a leave actually emptied OUR call.
                val priorChannelId = _state.value.voiceStates[vs.userId]?.channelId
                _state.update { st ->
                    val map = st.voiceStates.toMutableMap()
                    if (vs.channelId == null) map.remove(vs.userId) else map[vs.userId] = vs
                    st.copy(voiceStates = map)
                }
                if (vs.userId == meId && vs.channelId == null && _state.value.activeVoiceChannelId != null) {
                    handleSelfVoiceEnd(); return
                }
                // Our own join fans out to every device we have, so a join into a
                // channel we weren't already in means the call was answered (here
                // or elsewhere) — take this device's ring down. Nothing else can:
                // the ring notification is ongoing.
                val selfJoined = if (vs.userId == meId) vs.channelId else null
                if (selfJoined != null && priorChannelId != selfJoined) {
                    _state.update { if (it.incomingCall?.channelId == selfJoined) it.copy(incomingCall = null) else it }
                    clearRingFor(selfJoined)
                }
                // Ambient join/leave blips for the call we're IN. Deliberately
                // narrow, because this event also fires for mute/deafen changes:
                //  - never for ourselves (our own arrival/exit is CONNECT/HANGUP;
                //    doubling them is wrong),
                //  - only when the user's channel actually CHANGED (priorChannelId
                //    differs), so a peer toggling their mic stays silent,
                //  - only for OUR active channel — other channels are silent.
                // Deafen suppression + the 300 ms rate limit live in VoiceManager.
                val activeVoice = _state.value.activeVoiceChannelId
                if (vs.userId != meId && activeVoice != null && priorChannelId != vs.channelId) {
                    if (vs.channelId == activeVoice) voice.playPeerJoined()
                    else if (priorChannelId == activeVoice) voice.playPeerLeft()
                }
                if (vs.userId != meId && vs.channelId != null) maybeRing(vs)
                // The ringing caller gave up (left voice) before we answered →
                // stop ringing instead of looping the ringtone forever.
                if (vs.userId != meId && vs.channelId == null) maybeCancelRing(vs.userId)
                // Auto-hang-up ONLY when a PEER actually LEFT the DM call we're in.
                // Firing on every update (incl. joins/updates, or a reconnect that
                // momentarily blanks the roster) would drop a live 1:1 call the
                // instant the peer flickered out of voiceStates — the reported
                // "switching chats drops the call / won't reconnect" bug.
                if (vs.userId != meId && vs.channelId == null &&
                    priorChannelId != null && priorChannelId == _state.value.activeVoiceChannelId) {
                    maybeAutoHangup()
                }
            }
            "STAGE_PARTICIPANTS_UPDATE" -> {
                // Snake_case envelope { guild_id, channel_id, participants } with a
                // camelCase StageParticipantDTO list — the full post-mutation roster
                // (bulk replace). Only relevant for the stage we're connected to.
                val obj = d.data?.jsonObject ?: return
                val cid = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                if (cid != _state.value.activeStageChannelId) return
                val list = decode<List<com.zekktris.data.model.StageParticipant>>(obj["participants"]) ?: return
                applyStageParticipants(cid, list)
            }
            "MESSAGE_REACTION_ADD", "MESSAGE_REACTION_REMOVE" -> {
                // Snake_case: { channel_id, message_id, user_id, emoji }.
                val obj = d.data?.jsonObject ?: return
                val cid = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                val mid = obj["message_id"]?.jsonPrimitive?.contentOrNull ?: return
                val emoji = obj["emoji"]?.jsonPrimitive?.contentOrNull ?: return
                val uid = obj["user_id"]?.jsonPrimitive?.contentOrNull
                patchReaction(cid, mid, emoji, add = d.type == "MESSAGE_REACTION_ADD", mine = uid == _state.value.me?.id)
            }
            "POKE" -> {
                // Snake_case: { channel_id, poke_type, emoji, initiator_id,
                // initiator_name }. Broadcast to the whole DM audience INCLUDING
                // the sender — skip our own echo.
                val obj = d.data?.jsonObject ?: return
                val initiator = obj["initiator_id"]?.jsonPrimitive?.contentOrNull
                if (initiator == _state.value.me?.id) return
                val banner = PokeBanner(
                    id = UUID.randomUUID().toString(),
                    emoji = obj["emoji"]?.jsonPrimitive?.contentOrNull ?: "👉",
                    name = obj["initiator_name"]?.jsonPrimitive?.contentOrNull ?: "Someone",
                    channelId = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: "",
                    pokeType = obj["poke_type"]?.jsonPrimitive?.contentOrNull ?: "poke",
                )
                // The pill outlives the banner: it is what the poke leaves
                // behind for someone who wasn't looking at the screen.
                _state.update {
                    it.copy(
                        pokeBanner = banner,
                        pokePills = if (banner.channelId.isEmpty()) it.pokePills
                                    else it.pokePills + (banner.channelId to banner.emoji),
                    )
                }
                // Auto-dismiss after 5s; a newer poke mid-display owns dismissal.
                scope.launch {
                    delay(5_000)
                    _state.update { if (it.pokeBanner?.id == banner.id) it.copy(pokeBanner = null) else it }
                }
            }
            "ACHIEVEMENT_UNLOCK" -> {
                // Only sent to our own connections. Payload (snake-free): { id,
                // name, description, marker }. Celebrate with a transient banner.
                val obj = d.data?.jsonObject ?: return
                val name = obj["name"]?.jsonPrimitive?.contentOrNull ?: return
                val banner = AchievementBanner(
                    id = obj["id"]?.jsonPrimitive?.contentOrNull ?: UUID.randomUUID().toString(),
                    name = name,
                    detail = obj["description"]?.jsonPrimitive?.contentOrNull ?: "",
                    marker = obj["marker"]?.jsonPrimitive?.contentOrNull ?: "🏅",
                )
                _state.update { it.copy(achievementBanner = banner) }
                scope.launch {
                    delay(6_000)
                    _state.update { if (it.achievementBanner?.id == banner.id) it.copy(achievementBanner = null) else it }
                }
            }
            "MESSAGE_DELIVERED", "MESSAGE_VIEWED" -> {
                // Snake_case: { channel_id, message_ids[], delivered_at|viewed_at }.
                val obj = d.data?.jsonObject ?: return
                val cid = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                val ids = obj["message_ids"]?.let { el ->
                    runCatching { el.jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull } }.getOrNull()
                } ?: return
                val stampKey = if (d.type == "MESSAGE_DELIVERED") "delivered_at" else "viewed_at"
                val stamp = obj[stampKey]?.jsonPrimitive?.contentOrNull ?: Instant.now().toString()
                _state.update { st ->
                    val list = st.messagesByChannel[cid] ?: return@update st
                    val idSet = ids.toSet()
                    val next = list.map { m ->
                        if (m.id !in idSet) m
                        else if (d.type == "MESSAGE_DELIVERED") m.copy(deliveredAt = m.deliveredAt ?: stamp)
                        else m.copy(viewedAt = m.viewedAt ?: stamp, deliveredAt = m.deliveredAt ?: stamp)
                    }
                    st.copy(messagesByChannel = st.messagesByChannel + (cid to next))
                }
            }
            "MESSAGE_REACTION_REMOVE_ALL" -> {
                val obj = d.data?.jsonObject ?: return
                val cid = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                val mid = obj["message_id"]?.jsonPrimitive?.contentOrNull ?: return
                _state.update { st ->
                    val list = st.messagesByChannel[cid] ?: return@update st
                    val idx = list.indexOfFirst { it.id == mid }
                    if (idx < 0) return@update st
                    val newList = list.toMutableList().also { it[idx] = it[idx].copy(reactions = emptyList()) }
                    st.copy(messagesByChannel = st.messagesByChannel + (cid to newList))
                }
            }
            "MESSAGE_DELETE" -> {
                val obj = d.data?.jsonObject ?: return
                val id = obj["id"]?.jsonPrimitive?.contentOrNull ?: return
                val chId = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                _state.update {
                    val list = it.messagesByChannel[chId] ?: return@update it
                    it.copy(messagesByChannel = it.messagesByChannel + (chId to list.filterNot { m -> m.id == id }))
                }
            }
            "CHANNEL_ACK" -> decode<ReadState>(d.data)?.let { rs ->
                _state.update { it.copy(readStates = it.readStates + (rs.channelId to rs)) }
            }
            "PRESENCE_UPDATE" -> {
                val obj = d.data?.jsonObject ?: return
                val uid = obj["user_id"]?.jsonPrimitive?.contentOrNull ?: return
                val status = obj["status"]?.jsonPrimitive?.contentOrNull ?: return
                _state.update { it.copy(presence = it.presence + (uid to status)) }
            }
            "USER_UPDATE" -> onUserUpdate(d.data)
            "MESSAGE_DELETE_BULK" -> {
                // Snake_case: { ids[], channel_id, guild_id }. Server sends this on
                // a channel purge / bulk mod-delete instead of N MESSAGE_DELETE
                // events. Drop them from the cache whether or not it's the open
                // channel (more correct than iOS's open-only guard).
                val obj = d.data?.jsonObject ?: return
                val chId = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                val ids = obj["ids"]?.let { el ->
                    runCatching { el.jsonArray.mapNotNull { it.jsonPrimitive.contentOrNull } }.getOrNull()
                } ?: return
                val idSet = ids.toSet()
                _state.update {
                    val list = it.messagesByChannel[chId] ?: return@update it
                    it.copy(messagesByChannel = it.messagesByChannel + (chId to list.filterNot { m -> m.id in idSet }))
                }
            }
            "CHANNEL_CREATE", "CHANNEL_UPDATE" -> decode<Channel>(d.data)?.let { ch ->
                if (ch.guildId == null) {
                    // A brand-new DM must appear in the DM list the instant it's
                    // created (otherwise the first MESSAGE_CREATE upserts into a
                    // channel the DM list never heard of, and advanceLastMessage/
                    // bumpRecency both no-op → invisible until a refetch). A
                    // CHANNEL_UPDATE also propagates E2EE enable/disable/re-key.
                    // Guard on isDM so a non-DM private channel can't land here.
                    if (ch.isDM) {
                        _state.update {
                            val dms = sortDms(listOf(ch) + it.dms.filterNot { d2 -> d2.id == ch.id })
                            it.copy(dms = dms)
                        }
                        if (d.type == "CHANNEL_CREATE") seedPresence(ch.recipients ?: emptyList())
                        // A new/renamed DM belongs in the share sheet too.
                        refreshShareShortcuts()
                    }
                } else {
                    // Guild channel add/rename/topic/perms change — refetch the
                    // guild's channels so the sidebar reflects it. Only if that
                    // guild is already loaded (an unopened guild loads lazily).
                    val gid = ch.guildId
                    if (_state.value.channelsByGuild.containsKey(gid)) {
                        scope.launch { reloadGuildChannelsSafe(gid) }
                    }
                }
            }
            "CHANNEL_DELETE" -> decode<Channel>(d.data)?.let { ch ->
                if (ch.guildId == null) {
                    if (ch.isDM) {
                        _state.update { it.copy(dms = it.dms.filterNot { d2 -> d2.id == ch.id }) }
                        // Revoke its system share-sheet entry with it, else a
                        // deleted conversation keeps leaking a name + face there.
                        runCatching { com.zekktris.share.ShareShortcuts.remove(appContext, ch.id) }
                        refreshShareShortcuts()
                    }
                } else {
                    val gid = ch.guildId
                    // Drop cached history (so it can't flash on a later reopen) and
                    // pop out on a direct match.
                    _state.update { st ->
                        val cleared = st.copy(messagesByChannel = st.messagesByChannel - ch.id)
                        if (cleared.selectedChannelId == ch.id) cleared.copy(selectedChannelId = null)
                        else cleared
                    }
                    // A CHANNEL_DELETE also arrives when a channel is made PRIVATE
                    // for us (override / category cascade), which may drop a
                    // DIFFERENT open channel without a direct id match. Refetch the
                    // filtered list and pop the open channel if it lost visibility.
                    if (_state.value.channelsByGuild.containsKey(gid)) {
                        val openChannel = _state.value.currentChannel
                        scope.launch {
                            val channels = reloadGuildChannelsSafe(gid)
                            if (channels != null && openChannel != null &&
                                openChannel.guildId == gid && channels.none { it.id == openChannel.id }) {
                                _state.update { it.copy(messagesByChannel = it.messagesByChannel - openChannel.id) }
                                closeChannel()
                            }
                        }
                    }
                }
            }
            "GUILD_CREATE", "GUILD_DELETE" -> {
                // Joined/created/left/deleted a guild — refetch the rail. On a
                // delete of the selected guild, drop the selection (mirrors the
                // leave-guild reducer). Act only on a successful list.
                val evtGuildId = d.data?.jsonObject?.get("id")?.jsonPrimitive?.contentOrNull
                scope.launch {
                    val guilds = runCatching { api.listGuilds() }.getOrNull() ?: return@launch
                    _state.update { st ->
                        val gone = d.type == "GUILD_DELETE" && evtGuildId != null && st.selectedGuildId == evtGuildId
                        st.copy(
                            guilds = guilds,
                            selectedGuildId = if (gone) null else st.selectedGuildId,
                            selectedChannelId = if (gone) null else st.selectedChannelId,
                        )
                    }
                }
            }
            "GUILD_UPDATE" -> decode<Guild>(d.data)?.let { g ->
                // Full guild DTO: name/icon/banner/description edits, live.
                _state.update { it.copy(guilds = it.guilds.map { cur -> if (cur.id == g.id) g else cur }) }
            }
            "GUILD_MEMBER_ADD", "GUILD_MEMBER_UPDATE" -> decode<GuildMember>(d.data)?.let { m ->
                // Upsert the member into its guild's cached roster so a role /
                // hoist / timeout change and freshly-joined members appear live.
                // Only if that guild's members are already loaded (else it loads
                // on open). membersByGuild is keyed by guildId (a List), not uid.
                val gid = m.guildId ?: _state.value.selectedGuildId ?: return
                if (_state.value.membersByGuild.containsKey(gid)) {
                    _state.update { st ->
                        val list = st.membersByGuild[gid] ?: return@update st
                        val idx = list.indexOfFirst { it.userId == m.userId }
                        val next = if (idx >= 0) list.toMutableList().also { it[idx] = m } else list + m
                        st.copy(membersByGuild = st.membersByGuild + (gid to next))
                    }
                }
            }
            "GUILD_MEMBER_REMOVE" -> {
                // Snake_case: { guild_id, user_id }. Remove from the cached roster.
                val obj = d.data?.jsonObject ?: return
                val gid = obj["guild_id"]?.jsonPrimitive?.contentOrNull ?: return
                val uid = obj["user_id"]?.jsonPrimitive?.contentOrNull ?: return
                if (_state.value.membersByGuild.containsKey(gid)) {
                    _state.update { st ->
                        val list = st.membersByGuild[gid] ?: return@update st
                        st.copy(membersByGuild = st.membersByGuild + (gid to list.filterNot { it.userId == uid }))
                    }
                }
            }
            "GUILD_ROLE_CREATE", "GUILD_ROLE_UPDATE" -> decode<com.zekktris.data.model.Role>(d.data)?.let { r ->
                // Full role DTO: color / name / permission edits, live. Drives
                // member name colors + hoisted sections. Only if the guild's roles
                // are already loaded.
                val gid = r.guildId ?: _state.value.selectedGuildId ?: return
                if (_state.value.rolesByGuild.containsKey(gid)) {
                    _state.update { st ->
                        val list = st.rolesByGuild[gid] ?: return@update st
                        val idx = list.indexOfFirst { it.id == r.id }
                        val next = if (idx >= 0) list.toMutableList().also { it[idx] = r } else list + r
                        st.copy(rolesByGuild = st.rolesByGuild + (gid to next))
                    }
                }
            }
            "GUILD_ROLE_DELETE" -> {
                // Snake_case: { guild_id, role_id }.
                val obj = d.data?.jsonObject ?: return
                val gid = obj["guild_id"]?.jsonPrimitive?.contentOrNull ?: return
                val rid = obj["role_id"]?.jsonPrimitive?.contentOrNull ?: return
                if (_state.value.rolesByGuild.containsKey(gid)) {
                    _state.update { st ->
                        val list = st.rolesByGuild[gid] ?: return@update st
                        st.copy(rolesByGuild = st.rolesByGuild + (gid to list.filterNot { it.id == rid }))
                    }
                }
            }
            "GUILD_EMOJIS_UPDATE" -> {
                // Snake_case: { guild_id }. Reload the picker set if it's the open guild.
                val gid = d.data?.jsonObject?.get("guild_id")?.jsonPrimitive?.contentOrNull ?: return
                if (gid == _state.value.selectedGuildId) scope.launch { reloadGuildEmojis(gid) }
            }
            "MESSAGE_POLL_UPDATE" -> {
                // Snake_case: { channel_id, message_id, closed_at }. Patch the one
                // message's poll.closedAt in place (keep myVotes/options/tallies).
                val obj = d.data?.jsonObject ?: return
                val cid = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                val mid = obj["message_id"]?.jsonPrimitive?.contentOrNull ?: return
                val closedAt = obj["closed_at"]?.jsonPrimitive?.contentOrNull ?: return
                _state.update { st ->
                    val list = st.messagesByChannel[cid] ?: return@update st
                    val idx = list.indexOfFirst { it.id == mid }
                    if (idx < 0) return@update st
                    val msg = list[idx]
                    val poll = msg.poll ?: return@update st
                    if (poll.closedAt == closedAt) return@update st
                    val next = list.toMutableList().also { it[idx] = msg.copy(poll = poll.copy(closedAt = closedAt)) }
                    st.copy(messagesByChannel = st.messagesByChannel + (cid to next))
                }
            }
            "DM_STREAK_UPDATE" -> {
                // Snake_case: { channel_id, streak }. Update the streak chip live.
                val obj = d.data?.jsonObject ?: return
                val cid = obj["channel_id"]?.jsonPrimitive?.contentOrNull ?: return
                val streak = (obj["streak"] as? JsonPrimitive)?.contentOrNull?.toIntOrNull() ?: return
                _state.update { st ->
                    val idx = st.dms.indexOfFirst { it.id == cid }
                    if (idx < 0) return@update st
                    val next = st.dms.toMutableList().also { it[idx] = it[idx].copy(streak = streak) }
                    st.copy(dms = next)
                }
            }
            "FAMILY_REQUEST_CREATE", "FAMILY_FLAG_CREATE" -> {
                // Parental-controls activity dispatched to the parent's user
                // audience: refresh the summary if it's already loaded so the
                // Family badge/list updates without reopening the screen. Mirrors
                // iOS. loadFamily() launches its own coroutine (non-suspend here).
                if (_state.value.family != null) loadFamily()
            }
            "FAMILY_SUPERVISION_UPDATE" -> {
                // OUR OWN supervision changed — a guardian edited restrictions, a
                // link was accepted or ended, a server was blocked/unblocked, or
                // the 18+ sweep released us. The server addresses this one to the
                // subject alone, so receiving it means every local supervision
                // gate is stale.
                //
                // Deliberately NOT conditioned on `family != null` like the two
                // above: the gates this feeds (DM/messaging policy, the rail's
                // minor state, and [enforceShareShortcutSupervision] at the end
                // of [refreshFamily], which withdraws already-published share
                // targets) must tighten even if the startup snapshot never
                // landed and the Family screen was never opened.
                //
                // The frame carries the new effective restrictions, but `family`
                // is a FamilySummary — it also holds the guardian list and grace
                // fields this payload deliberately omits — so re-read /family/me
                // rather than splice a partial shape in. [refreshFamily] keeps
                // the last good snapshot when that fetch fails, so a revoked
                // permission can never be re-opened by a failed refresh.
                loadFamily()
            }
        }
    }

    private fun onReady(d: JsonElement?) {
        // guilds/private_channels in READY are ID-only stubs; refetch the real
        // trees, and reconcile the open channel (a fresh READY replays nothing).
        scope.launch {
            loadInitial()
            // A fresh IDENTIFY replays nothing, so guild surfaces cached from
            // before the drop are frozen: closed-channel unread (never advances
            // without a live MESSAGE_CREATE), member status dots, and role/member
            // changes never self-heal (selectGuild only fetches when the cache is
            // null). Reconcile every guild we hold cached — acting ONLY on a
            // successful fetch so a transient error can't clobber the cache or pop
            // the user out of a still-valid channel. On the first (cold) READY
            // channelsByGuild is empty and selectedGuildId is null, so this is a
            // no-op; it only does work on a reconnect. Mirrors iOS's repeat-READY
            // reconcile (loadChannels/loadMembers + open-channel re-validate).
            val gid = _state.value.selectedGuildId
            _state.value.channelsByGuild.keys.toList().forEach { g ->
                val channels = reloadGuildChannelsSafe(g)
                // Re-validate the OPEN channel's visibility: a channel made
                // private while we were offline is never delivered as a per-user
                // CHANNEL_DELETE — a reconnect refresh is the only thing that
                // catches it (like iOS/web). Pop out only on a successful list
                // that no longer contains it.
                if (channels != null && g == gid) {
                    val cid = _state.value.selectedChannelId
                    if (cid != null && channels.none { it.id == cid }) closeChannel()
                }
            }
            // Missed PRESENCE_UPDATE / member / role deltas are unrecoverable on a
            // fresh READY — refetch the selected guild's members + roles so status
            // dots and role/member changes converge from the REST snapshot.
            // loadMembers seeds presence with the diff-across-await rule, so a
            // dot that went stale while suspended (its missed delta is NOT
            // "changed during fetch") gets repaired from the REST status.
            if (gid != null) {
                loadMembers(gid)
                loadRoles(gid)
            }
            // A fresh IDENTIFY (>60s drop) replays no MESSAGE_DELETE/UPDATE, so the
            // after-cursor sync would miss deletions/edits/reactions on already-
            // loaded rows. Route the open-channel catch-up through the latest-window
            // reconcile (matches onAppForeground) so those heal on reconnect too.
            _state.value.selectedChannelId?.let { refreshOpenChannelLatest(it) }
        }
        val obj = d?.jsonObject ?: return
        obj["read_state"]?.let { arr ->
            val states = runCatching { api.json.decodeFromJsonElement<List<ReadState>>(arr) }.getOrDefault(emptyList())
            if (states.isNotEmpty()) {
                _state.update { it.copy(readStates = it.readStates + states.associateBy { s -> s.channelId }) }
            }
        }
        // Snake_case `voice_states` (elements are camelCase VoiceState DTOs) —
        // rebuild the voice roster on (re)connect.
        obj["voice_states"]?.let { arr ->
            val vs = runCatching {
                api.json.decodeFromJsonElement<List<com.zekktris.data.model.VoiceState>>(arr)
            }.getOrDefault(emptyList())
            _state.update { st ->
                val snapshot = vs.associateBy { v -> v.userId }
                val active = st.activeVoiceChannelId
                    ?: return@update st.copy(voiceStates = snapshot) // not in a call → snapshot is truth
                // In a call: a possibly-lagging reconnect snapshot must NOT blank
                // the live roster of OUR channel (that would trip auto-hangup and
                // kill the call). Keep any of our participants the snapshot omitted.
                val merged = snapshot.toMutableMap()
                st.voiceStates.forEach { (uid, cur) ->
                    if (cur.channelId == active && !merged.containsKey(uid)) merged[uid] = cur
                }
                st.copy(voiceStates = merged)
            }
        }
    }

    private fun decodeMessage(d: JsonElement?): Message? = decode(d)
    private inline fun <reified T> decode(d: JsonElement?): T? =
        d?.let { runCatching { api.json.decodeFromJsonElement<T>(it) }.getOrNull() }

    // ---- helpers ------------------------------------------------------------

    private fun upsertMessage(channelId: String, msg: Message) {
        _state.update { st ->
            val list = st.messagesByChannel[channelId] ?: emptyList()
            val idx = list.indexOfFirst { existing ->
                (msg.nonce != null && existing.nonce == msg.nonce) || existing.id == msg.id
            }
            val next = if (idx >= 0) list.toMutableList().apply { this[idx] = msg }
            else list + msg
            st.copy(messagesByChannel = st.messagesByChannel + (channelId to next))
        }
    }

    private fun bumpRecency(channelId: String) {
        // getAndUpdate returns the state the WINNING CAS replaced, so "did it
        // move?" can be decided from that. A flag set INSIDE the lambda could
        // not: update re-invokes the lambda on contention, and a losing attempt
        // would leave the flag set for a winner that changed nothing.
        val before = _state.getAndUpdate { st ->
            val dm = st.dms.firstOrNull { it.id == channelId } ?: return@getAndUpdate st
            if (st.dms.firstOrNull()?.id == channelId) return@getAndUpdate st
            st.copy(dms = listOf(dm) + st.dms.filterNot { it.id == channelId })
        }
        // Same two conditions the lambda decides on, applied to the pre-state it
        // actually won against.
        val moved = before.dms.firstOrNull()?.id != channelId &&
            before.dms.any { it.id == channelId }
        // The share sheet is ordered by DM recency, so re-rank it when the order
        // actually changed. Debounced in refreshShareShortcuts — a busy
        // conversation would otherwise hit the shortcut service per message.
        if (moved) refreshShareShortcuts()
    }

    /** Move a channel/DM's lastMessageId forward as new messages arrive so the
     *  unread computation (channel.lastMessageId vs readState.lastMessageId) tracks
     *  the true latest. Never regresses — snowflake ids are monotonic strings, and
     *  the DM list already relies on that ordering. */
    private fun advanceLastMessage(channelId: String, messageId: String) {
        _state.update { st ->
            var changed = false
            fun bump(c: Channel): Channel =
                if (c.id == channelId && (c.lastMessageId == null || messageId > c.lastMessageId!!)) {
                    changed = true; c.copy(lastMessageId = messageId)
                } else c
            val dms = st.dms.map(::bump)
            val chans = st.channelsByGuild.mapValues { (_, list) -> list.map(::bump) }
            if (changed) st.copy(dms = dms, channelsByGuild = chans) else st
        }
    }

    private fun clearTyping(channelId: String, userId: String) {
        _state.update { st ->
            val ch = st.typingByChannel[channelId] ?: return@update st
            if (userId !in ch) return@update st
            st.copy(typingByChannel = st.typingByChannel + (channelId to (ch - userId)))
        }
    }

    private fun onUserUpdate(d: JsonElement?) {
        // USER_UPDATE is nested under `user` with snake_case fields (unlike other
        // events): { user: { id, username, display_name, avatar_url, bio,
        // custom_status, status } }.
        val u = d?.jsonObject?.get("user")?.jsonObject ?: return
        fun str(k: String) = (u[k] as? JsonPrimitive)?.contentOrNull
        val id = str("id") ?: return
        // Field-preserving partial patch: overwrite only the fields the wire
        // carries (USER_UPDATE omits banner/decoration/tag/role data), so those
        // survive. Applied to DM recipients, open-channel message authors, AND
        // cached guild-member rows so a name/avatar/custom-status change shows
        // everywhere — not just the DM header (mirrors iOS's patchPublicUser
        // fan-out). There is no global user cache on Android, so each surface
        // holds its own PublicUser snapshot and must be patched in place.
        fun patch(p: PublicUser): PublicUser = if (p.id != id) p else p.copy(
            username = str("username") ?: p.username,
            displayName = str("display_name") ?: p.displayName,
            avatarUrl = str("avatar_url") ?: p.avatarUrl,
            bio = str("bio") ?: p.bio,
            customStatus = str("custom_status") ?: p.customStatus,
            status = str("status") ?: p.status,
        )
        _state.update { st ->
            val dms = st.dms.map { ch ->
                val recips = ch.recipients?.map(::patch)
                if (recips != null) ch.copy(recipients = recips) else ch
            }
            // Skip rebuilding (and re-emitting) any channel/guild list that holds
            // no message/row for this uid — a user shared across many surfaces
            // would otherwise trigger needless recompositions.
            val msgs = st.messagesByChannel.mapValues { (_, list) ->
                if (list.any { it.author?.id == id })
                    list.map { m -> m.author?.let { a -> if (a.id == id) m.copy(author = patch(a)) else m } ?: m }
                else list
            }
            val members = st.membersByGuild.mapValues { (_, list) ->
                if (list.any { it.user.id == id })
                    list.map { gm -> if (gm.user.id == id) gm.copy(user = patch(gm.user)) else gm }
                else list
            }
            st.copy(dms = dms, messagesByChannel = msgs, membersByGuild = members)
        }
    }

    private fun sortDms(dms: List<Channel>): List<Channel> =
        dms.sortedByDescending { it.lastMessageId ?: "" }

    private companion object {
        const val OPEN_CHANNEL_POLL_MS = 3_000L

        /**
         * How long [refreshShareShortcuts] waits before republishing. Every
         * trigger (open, send, receive, foreground re-sync) collapses into one
         * ShortcutManager write, and the contact list is read after the wait so
         * the published order is the settled one.
         */
        const val SHARE_SHORTCUT_DEBOUNCE_MS = 1_200L

        /**
         * Outer ladder for a cold start whose `/auth/refresh` keeps coming back
         * TRANSIENT, in ms between rounds (the last rung repeats forever).
         *
         * Much longer than [ApiClient]'s inner ladder on purpose. The inner one
         * must finish inside the window where the server still reads a
         * superseded refresh token as benign concurrency; this one re-presents
         * a *fresh* cookie each round, so it is free to wait out a real outage
         * — an app left open on a train through a tunnel comes back by itself
         * instead of having thrown the session away.
         */
        val BOOTSTRAP_RETRY_DELAYS_MS = longArrayOf(2_000, 5_000, 10_000, 20_000, 30_000)

        /**
         * Extra seconds [runDeviceLogin] keeps polling past the server's stated
         * expiry. Covers clock skew and one in-flight request, so a code the
         * user approved at the last second is still collected rather than
         * reported expired by our own timer while the server would have served
         * it. Comfortably inside the server's 60s terminal TTL.
         */
        const val GRACE_SECONDS = 10

        /**
         * Consecutive unanswerable polls before [runDeviceLogin] gives up.
         * At the 5s baseline that is ~30s of silence — long enough to ride out
         * a handover, short enough that a user staring at a code on an offline
         * phone is told so instead of watching it silently expire.
         */
        const val MAX_UNREACHABLE_POLLS = 6
    }
}

fun SelfUser.toPublicUser(): PublicUser = PublicUser(
    id = id,
    username = username,
    displayName = displayName,
    avatarUrl = avatarUrl,
    avatarDecoration = avatarDecoration,
    bannerUrl = bannerUrl,
    bio = bio,
    status = status,
    tagLabel = tagLabel,
    tagColor = tagColor,
    subscriptionTier = subscriptionTier,
    isAdmin = isAdmin,
    isModerator = isModerator,
    staffColor = staffColor,
    staffGlow = staffGlow,
)
