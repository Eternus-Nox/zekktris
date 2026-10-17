package com.zekktris.data

import com.zekktris.data.model.ReadyFeatures
import io.ktor.client.plugins.websocket.DefaultClientWebSocketSession
import io.ktor.client.plugins.websocket.webSocket
import io.ktor.websocket.CloseReason
import io.ktor.websocket.Frame
import io.ktor.websocket.close
import io.ktor.websocket.readText
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.channels.BufferOverflow
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.decodeFromJsonElement
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.math.min
import kotlin.random.Random

/**
 * WebSocket gateway client. Ports the invariants the iOS Gateway.swift learned:
 *  - HELLO → IDENTIFY (or RESUME on auto-reconnect) → READY, then a stream of
 *    DISPATCH frames; HEARTBEAT every interval with an ACK watchdog.
 *  - Never permanently latch closed on a transient failure — always back off and
 *    retry until stop() is called.
 *  - Distinguish resume-rejected vs identify-rejected off our own `resuming` flag,
 *    not the (always-false) server `resumable` boolean.
 *
 * Presence: AppStore reports this device's activity with [setPresenceActive].
 * It rides in every IDENTIFY/RESUME (harmless to an older server) and goes out
 * as PRESENCE_UPDATE (op 3) on a change only when the last READY carried
 * `features.presence_activity` (see DevicePresence.kt).
 */
class Gateway(
    private val api: ApiClient,
    private val scope: CoroutineScope,
) {
    enum class ConnState { Disconnected, Connecting, Connected }

    data class Dispatch(val type: String, val data: JsonElement?)

    private val _events = MutableSharedFlow<Dispatch>(
        extraBufferCapacity = 256,
        onBufferOverflow = BufferOverflow.SUSPEND,
    )
    val events = _events.asSharedFlow()

    private val _state = MutableStateFlow(ConnState.Disconnected)
    val state = _state.asStateFlow()

    private val json = api.json

    // resume state
    @Volatile private var sessionId: String? = null
    @Volatile private var lastSeq: Long? = null
    @Volatile private var resuming = false

    // heartbeat liveness
    @Volatile private var lastAckAt = 0L

    // reconnect backoff
    private var backoffMs = BASE_BACKOFF
    // slow auth-retry ladder (used when the refresh token itself is dead)
    private var authBackoffMs = AUTH_BASE_BACKOFF
    @Volatile private var inAuthBackoff = false

    @Volatile private var intentionallyClosed = false
    private var runJob: Job? = null

    /** Whether the server derives presence from device activity (the last
     *  READY's `features.presence_activity`). A RESUMED carries no features and
     *  keeps the last READY's — also across [stop], which keeps the resume
     *  state, so a sign-in that RESUMEs still sends op 3. Set before READY
     *  reaches [events]. */
    @Volatile var supportsPresenceActivity = false
        private set

    // This device's activity as AppStore last reported it, and what the
    // server's session holds, so each change is sent once. Guarded by
    // [presenceLock]; [presenceSignal] wakes the live session's sender, and
    // [presenceMutex] keeps a handshake and an op 3 send in order.
    private val presence = PresenceReport()
    private val presenceLock = Any()
    private val presenceSignal = MutableStateFlow<Boolean?>(null)
    private val presenceMutex = Mutex()

    /** The socket that has completed READY/RESUMED, null in between. Op 3 is
     *  only ever sent on it. */
    @Volatile private var liveSession: DefaultClientWebSocketSession? = null

    fun start() {
        if (runJob?.isActive == true) return
        intentionallyClosed = false
        // Frame reads + JSON parsing must not run on the UI thread — pin the run
        // loop to Default. StateFlow/SharedFlow updates are thread-safe and
        // Compose collectors hop back to Main.
        runJob = scope.launch(Dispatchers.Default) { runLoop() }
    }

    fun stop() {
        intentionallyClosed = true
        runJob?.cancel()
        runJob = null
        _state.value = ConnState.Disconnected
    }

    /**
     * Report this device's activity: true while the person is using it, false
     * once they stop (5 min without input, or the app went to the background).
     * Call it on every evaluation; repeats are dropped here. Sent as
     * PRESENCE_UPDATE only to a server that supports it, and always included in
     * the next IDENTIFY/RESUME.
     */
    fun setPresenceActive(active: Boolean) {
        synchronized(presenceLock) { presence.report(active) }
        presenceSignal.value = active
    }

    /** Drop the current socket so the run loop reconnects (e.g. on app foreground). */
    fun forceReconnect() {
        runJob?.cancel()
        runJob = null
        if (!intentionallyClosed) start()
    }

    private suspend fun runLoop() {
        while (!intentionallyClosed && currentCoroutineContext().isActive) {
            try {
                _state.value = ConnState.Connecting
                api.http.webSocket(Config.GATEWAY_URL) { session() }
            } catch (e: CancellationException) {
                throw e
            } catch (_: Exception) {
                // connection dropped or failed to open — fall through to backoff
            }
            if (intentionallyClosed) break
            _state.value = ConnState.Connecting
            if (inAuthBackoff) {
                // Refresh token is dead/unreachable — slow to a 30s→5min ladder
                // instead of hammering ~every 30s; never latch permanently closed.
                delay(authBackoffMs + Random.nextLong(0, 1000))
                authBackoffMs = min(authBackoffMs * 2, MAX_AUTH_BACKOFF)
            } else {
                delay(backoffMs + Random.nextLong(0, 500))
                backoffMs = min(backoffMs * 2, MAX_BACKOFF)
            }
        }
        _state.value = ConnState.Disconnected
    }

    private suspend fun DefaultClientWebSocketSession.session() {
        var heartbeatJob: Job? = null
        var presenceJob: Job? = null
        try {
            for (frame in incoming) {
                if (frame !is Frame.Text) continue
                val root = runCatching { json.parseToJsonElement(frame.readText()).jsonObject }
                    .getOrNull() ?: continue
                when (root["op"]?.jsonPrimitive?.intOrNull ?: continue) {
                    OP_HELLO -> {
                        val interval = root["d"]?.jsonObject
                            ?.get("heartbeat_interval")?.jsonPrimitive?.longOrNull ?: 30_000L
                        val token = api.ensureAccessToken()
                        if (token == null) {
                            inAuthBackoff = true
                            close(CloseReason(CloseReason.Codes.NORMAL, "no-token"))
                            return
                        }
                        if (canResume()) sendResume(token) else sendIdentify(token)
                        lastAckAt = System.currentTimeMillis()
                        heartbeatJob = launch { heartbeatLoop(interval) }
                        // Sends each activity change once this socket is live
                        // (no-op until READY/RESUMED, which flush on their own).
                        presenceJob = launch { presenceSignal.collect { flushPresence() } }
                    }

                    OP_DISPATCH -> {
                        root["s"]?.jsonPrimitive?.longOrNull?.let { lastSeq = it }
                        val t = root["t"]?.jsonPrimitive?.contentOrNull ?: continue
                        handleDispatch(t, root["d"])
                    }

                    OP_HEARTBEAT_ACK -> lastAckAt = System.currentTimeMillis()

                    OP_INVALID_SESSION -> {
                        if (resuming) {
                            // resume rejected — clear resume state, fresh IDENTIFY on the same socket
                            sessionId = null
                            lastSeq = null
                            resuming = false
                            val token = api.ensureAccessToken()
                            if (token != null) sendIdentify(token)
                            else { close(CloseReason(CloseReason.Codes.NORMAL, "no-token")); return }
                        } else {
                            // Likely an expired access token — refresh once. If refresh
                            // didn't produce one (dead refresh token, OR a transient
                            // outage), fall onto the slow auth ladder instead of
                            // hammering reconnects. Deliberately reads only "did we get
                            // a token": the SESSION-ending decision belongs to
                            // AppStore via ApiClient.onRefreshFatal, and the socket
                            // just backs off either way.
                            inAuthBackoff = api.refreshAccessToken() != RefreshOutcome.Success
                            close(CloseReason(CloseReason.Codes.NORMAL, "invalid-session"))
                            return
                        }
                    }

                    OP_RECONNECT -> {
                        close(CloseReason(CloseReason.Codes.NORMAL, "reconnect"))
                        return
                    }
                }
            }
        } finally {
            heartbeatJob?.cancel()
            presenceJob?.cancel()
            if (liveSession === this) liveSession = null
        }
    }

    private suspend fun DefaultClientWebSocketSession.heartbeatLoop(interval: Long) {
        // jitter the first beat so reconnect storms don't synchronize
        delay(Random.nextLong(0, interval.coerceAtLeast(1)))
        while (isActive) {
            val sentAt = System.currentTimeMillis()
            send(Frame.Text(heartbeatFrame()))
            delay(ACK_TIMEOUT.coerceAtMost(interval))
            if (lastAckAt < sentAt) {
                // no ACK within the window — silent TCP death (common on mobile). Reconnect.
                close(CloseReason(CloseReason.Codes.NORMAL, "hb-timeout"))
                return
            }
            val remainder = interval - ACK_TIMEOUT
            if (remainder > 0) delay(remainder)
        }
    }

    private suspend fun DefaultClientWebSocketSession.handleDispatch(t: String, d: JsonElement?) {
        when (t) {
            "READY" -> {
                sessionId = d?.jsonObject?.get("session_id")?.jsonPrimitive?.contentOrNull
                resuming = false
                resetBackoff()
                // Capabilities come with READY only; a RESUMED keeps the last.
                // Set before the emit so AppStore's READY handling sees them.
                val features = d?.jsonObject?.get("features")?.let {
                    runCatching { json.decodeFromJsonElement<ReadyFeatures>(it) }.getOrNull()
                }
                supportsPresenceActivity = features?.presenceActivity == true
                liveSession = this
                // An activity change reported while we were (re)connecting.
                flushPresence()
                _state.value = ConnState.Connected
            }
            "RESUMED" -> {
                d?.jsonObject?.get("session_id")?.jsonPrimitive?.contentOrNull?.let { sessionId = it }
                resuming = false
                resetBackoff()
                liveSession = this
                flushPresence()
                _state.value = ConnState.Connected
            }
        }
        _events.emit(Dispatch(t, d))
    }

    /** Send this device's activity as PRESENCE_UPDATE (op 3) if a change is
     *  due on this live socket (see [PresenceReport.takeUpdate]). */
    private suspend fun DefaultClientWebSocketSession.flushPresence() {
        presenceMutex.withLock {
            val active = synchronized(presenceLock) {
                presence.takeUpdate(live = liveSession === this, supported = supportsPresenceActivity)
            } ?: return
            send(Frame.Text(buildJsonObject {
                put("op", OP_PRESENCE_UPDATE)
                putJsonObject("d") { put("active", active) }
            }.toString()))
        }
    }

    private fun resetBackoff() {
        backoffMs = BASE_BACKOFF
        authBackoffMs = AUTH_BASE_BACKOFF
        inAuthBackoff = false
    }

    private fun canResume() = sessionId != null && lastSeq != null

    private suspend fun DefaultClientWebSocketSession.sendIdentify(token: String) {
        resuming = false
        // This device's activity at connect. Omitted until AppStore reports
        // one, which the server reads as active (a legacy client).
        val active = presenceMutex.withLock { synchronized(presenceLock) { presence.identifyValue() } }
        val frame = buildJsonObject {
            put("op", OP_IDENTIFY)
            putJsonObject("d") {
                put("token", token)
                putJsonObject("properties") {
                    put("os", "Android")
                    put("browser", "Zekktris-Android")
                    put("device", "android")
                }
                if (active != null) putJsonObject("presence") { put("active", active) }
            }
        }
        send(Frame.Text(frame.toString()))
    }

    private suspend fun DefaultClientWebSocketSession.sendResume(token: String) {
        resuming = true
        // Omitted keeps the resumed session's value (the one we last sent).
        val active = presenceMutex.withLock { synchronized(presenceLock) { presence.resumeValue() } }
        val frame = buildJsonObject {
            put("op", OP_RESUME)
            putJsonObject("d") {
                put("token", token)
                put("session_id", sessionId)
                put("seq", lastSeq)
                if (active != null) putJsonObject("presence") { put("active", active) }
            }
        }
        send(Frame.Text(frame.toString()))
    }

    private fun heartbeatFrame(): String = buildJsonObject {
        put("op", OP_HEARTBEAT)
        putJsonObject("d") { put("seq", lastSeq) }
    }.toString()

    companion object {
        private const val OP_DISPATCH = 0
        private const val OP_HEARTBEAT = 1
        private const val OP_IDENTIFY = 2
        private const val OP_PRESENCE_UPDATE = 3
        private const val OP_RESUME = 4
        private const val OP_RECONNECT = 5
        private const val OP_INVALID_SESSION = 6
        private const val OP_HELLO = 7
        private const val OP_HEARTBEAT_ACK = 8

        private const val BASE_BACKOFF = 1_000L
        private const val MAX_BACKOFF = 30_000L
        private const val AUTH_BASE_BACKOFF = 30_000L
        private const val MAX_AUTH_BACKOFF = 300_000L
        private const val ACK_TIMEOUT = 10_000L
    }
}
