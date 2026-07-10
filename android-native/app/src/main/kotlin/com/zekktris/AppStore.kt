package com.zekktris

import com.zekktris.data.ApiClient
import com.zekktris.data.Gateway
import com.zekktris.data.LoginResult
import com.zekktris.data.model.Channel
import com.zekktris.data.model.Guild
import com.zekktris.data.model.GuildMember
import com.zekktris.data.model.Message
import com.zekktris.data.model.PublicUser
import com.zekktris.data.model.ReadState
import com.zekktris.data.model.SelfUser
import com.zekktris.push.PushManager
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.contentOrNull
import java.time.Instant
import java.util.UUID

enum class Phase { Loading, Auth, Ready }

// A single immutable snapshot the whole UI observes (Compose-friendly).
data class AppState(
    val phase: Phase = Phase.Loading,
    val me: SelfUser? = null,
    val guilds: List<Guild> = emptyList(),
    val dms: List<Channel> = emptyList(),
    val channelsByGuild: Map<String, List<Channel>> = emptyMap(),
    val membersByGuild: Map<String, List<GuildMember>> = emptyMap(),
    val messagesByChannel: Map<String, List<Message>> = emptyMap(),
    val readStates: Map<String, ReadState> = emptyMap(),
    val presence: Map<String, String> = emptyMap(),
    val selectedGuildId: String? = null, // null = DM/home
    val selectedChannelId: String? = null,
    val showSettings: Boolean = false,
    val gatewayState: Gateway.ConnState = Gateway.ConnState.Disconnected,
    val authBusy: Boolean = false,
    val authError: String? = null,
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
    private val api: ApiClient,
    private val gateway: Gateway,
    private val push: PushManager,
    private val scope: CoroutineScope,
) {
    private val _state = MutableStateFlow(AppState())
    val state: StateFlow<AppState> = _state.asStateFlow()

    init {
        // Fan gateway connection-state + dispatches into the store.
        scope.launch { gateway.state.collect { s -> _state.update { it.copy(gatewayState = s) } } }
        // Decode gateway frames off the main thread.
        scope.launch(Dispatchers.Default) { gateway.events.collect { onDispatch(it) } }
        // Safety net for the recurring DM-staleness bug: while a channel is open,
        // periodically pull anything the socket may have missed (iOS/web do the same).
        scope.launch {
            while (true) {
                delay(OPEN_CHANNEL_POLL_MS)
                _state.value.selectedChannelId?.let { syncNewMessages(it) }
            }
        }
    }

    // ---- lifecycle ----------------------------------------------------------

    fun bootstrap() {
        scope.launch {
            _state.update { it.copy(phase = Phase.Loading) }
            val token = runCatching { api.ensureAccessToken() }.getOrNull()
            if (token == null) {
                _state.update { it.copy(phase = Phase.Auth) }
                return@launch
            }
            val me = runCatching { api.getMe() }.getOrNull()
            if (me == null) {
                _state.update { it.copy(phase = Phase.Auth) }
                return@launch
            }
            enterReady(me)
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
        val guilds = runCatching { api.listGuilds() }.getOrDefault(emptyList())
        val dms = runCatching { api.listDMs() }.getOrDefault(emptyList())
        _state.update { it.copy(guilds = guilds, dms = sortDms(dms)) }
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

    fun register(email: String, username: String, displayName: String, password: String, dateOfBirth: String) {
        scope.launch {
            _state.update { it.copy(authBusy = true, authError = null) }
            val r = runCatching { api.register(email, username, displayName, password, dateOfBirth) }
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
            _state.value = AppState(phase = Phase.Auth)
        }
    }

    /**
     * Route in from a tapped notification. On a cold start we may not be
     * authenticated yet, so wait until the app reaches [Phase.Ready] before
     * opening the conversation. One-shot; harmless if never reached.
     */
    fun openFromNotification(channelId: String) {
        scope.launch {
            state.first { it.phase == Phase.Ready }
            selectChannel(channelId)
        }
    }

    // ---- navigation ---------------------------------------------------------

    fun selectGuild(guildId: String?) {
        // Switching context always drops back to the list (never jumps into chat).
        _state.update { it.copy(selectedGuildId = guildId, selectedChannelId = null) }
        if (guildId == null) return
        scope.launch {
            if (_state.value.channelsByGuild[guildId] == null) {
                val channels = runCatching { api.listChannels(guildId) }.getOrDefault(emptyList())
                _state.update { it.copy(channelsByGuild = it.channelsByGuild + (guildId to channels)) }
                loadMembers(guildId)
            }
        }
    }

    fun closeChannel() {
        _state.update { it.copy(selectedChannelId = null) }
    }

    fun openSettings() = _state.update { it.copy(showSettings = true) }
    fun closeSettings() = _state.update { it.copy(showSettings = false) }

    private suspend fun loadMembers(guildId: String) {
        val members = runCatching { api.listMembers(guildId) }.getOrDefault(emptyList())
        _state.update { it.copy(membersByGuild = it.membersByGuild + (guildId to members)) }
    }

    fun selectChannel(channelId: String) {
        _state.update { it.copy(selectedChannelId = channelId) }
        scope.launch {
            if (_state.value.messagesByChannel[channelId] == null) {
                loadMessages(channelId)
            }
            ack(channelId)
        }
    }

    /** Open (or create) a 1:1 DM and select it. */
    fun openDM(recipientId: String) {
        scope.launch {
            val ch = runCatching { api.openDM(recipientId) }.getOrNull() ?: return@launch
            _state.update {
                val dms = (listOf(ch) + it.dms.filterNot { d -> d.id == ch.id })
                it.copy(dms = dms, selectedGuildId = null, selectedChannelId = ch.id)
            }
            if (_state.value.messagesByChannel[ch.id] == null) loadMessages(ch.id)
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

    /** Pull messages newer than what we hold and merge them (no clobber, no scroll thrash). */
    private suspend fun syncNewMessages(channelId: String) {
        val lastReal = _state.value.messagesByChannel[channelId]
            ?.lastOrNull { !it.id.startsWith("pending-") }?.id
        val fresh = runCatching { api.listMessages(channelId, limit = 50, after = lastReal) }
            .getOrDefault(emptyList())
        if (fresh.isEmpty()) return
        fresh.reversed().forEach { upsertMessage(channelId, it) } // API is newest-first
    }

    private suspend fun ack(channelId: String) {
        val last = _state.value.messagesByChannel[channelId]?.lastOrNull()?.id ?: return
        val rs = runCatching { api.ackMessage(channelId, last) }.getOrNull() ?: return
        _state.update { it.copy(readStates = it.readStates + (channelId to rs)) }
    }

    // ---- sending ------------------------------------------------------------

    fun sendMessage(channelId: String, content: String) {
        val text = content.trim()
        if (text.isEmpty()) return
        val nonce = UUID.randomUUID().toString()
        val me = _state.value.me
        val optimistic = Message(
            id = "pending-$nonce",
            channelId = channelId,
            createdAt = Instant.now().toString(),
            authorId = me?.id,
            author = me?.toPublicUser(),
            content = text,
            nonce = nonce,
        )
        upsertMessage(channelId, optimistic)
        bumpRecency(channelId)
        scope.launch {
            val sent = runCatching { api.sendMessage(channelId, text, nonce) }.getOrNull()
            if (sent != null) upsertMessage(channelId, sent)
            // else: leave the optimistic message; a retry path can be added later
        }
    }

    // ---- gateway dispatch ---------------------------------------------------

    private fun onDispatch(d: Gateway.Dispatch) {
        when (d.type) {
            "READY" -> onReady(d.data)
            "RESUMED" -> _state.value.selectedChannelId?.let { id -> scope.launch { syncNewMessages(id) } }
            "MESSAGE_CREATE", "MESSAGE_UPDATE" -> decodeMessage(d.data)?.let {
                upsertMessage(it.channelId, it)
                if (d.type == "MESSAGE_CREATE") bumpRecency(it.channelId)
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
        }
    }

    private fun onReady(d: JsonElement?) {
        // guilds/private_channels in READY are ID-only stubs; refetch the real
        // trees, and reconcile the open channel (a fresh READY replays nothing).
        scope.launch {
            loadInitial()
            _state.value.selectedChannelId?.let { syncNewMessages(it) }
        }
        val obj = d?.jsonObject ?: return
        obj["read_state"]?.let { arr ->
            val states = runCatching { api.json.decodeFromJsonElement<List<ReadState>>(arr) }.getOrDefault(emptyList())
            if (states.isNotEmpty()) {
                _state.update { it.copy(readStates = it.readStates + states.associateBy { s -> s.channelId }) }
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
        _state.update { st ->
            val dm = st.dms.firstOrNull { it.id == channelId } ?: return@update st
            st.copy(dms = listOf(dm) + st.dms.filterNot { it.id == channelId })
        }
    }

    private fun onUserUpdate(d: JsonElement?) {
        // USER_UPDATE is nested under `user` with snake_case fields (unlike other
        // events): { user: { id, username, display_name, avatar_url, bio,
        // custom_status, status } }.
        val u = d?.jsonObject?.get("user")?.jsonObject ?: return
        fun str(k: String) = (u[k] as? JsonPrimitive)?.contentOrNull
        val id = str("id") ?: return
        _state.update { st ->
            val dms = st.dms.map { ch ->
                val recips = ch.recipients?.map { r ->
                    if (r.id == id) r.copy(
                        username = str("username") ?: r.username,
                        displayName = str("display_name") ?: r.displayName,
                        avatarUrl = str("avatar_url") ?: r.avatarUrl,
                        bio = str("bio") ?: r.bio,
                        customStatus = str("custom_status") ?: r.customStatus,
                        status = str("status") ?: r.status,
                    ) else r
                }
                if (recips != null) ch.copy(recipients = recips) else ch
            }
            st.copy(dms = dms)
        }
    }

    private fun sortDms(dms: List<Channel>): List<Channel> =
        dms.sortedByDescending { it.lastMessageId ?: "" }

    private companion object {
        const val OPEN_CHANNEL_POLL_MS = 12_000L
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
