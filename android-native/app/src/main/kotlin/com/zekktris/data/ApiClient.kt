package com.zekktris.data

import com.zekktris.data.model.AckWrap
import com.zekktris.data.model.AdminDmPeersWrap
import com.zekktris.data.model.AuthResponse
import com.zekktris.data.model.Channel
import com.zekktris.data.model.ChannelWrap
import com.zekktris.data.model.AcceptInviteResult
import com.zekktris.data.model.AdminGuild
import com.zekktris.data.model.AdminGuildsWrap
import com.zekktris.data.model.AdminStats
import com.zekktris.data.model.AdminStatsWrap
import com.zekktris.data.model.AdminStorage
import com.zekktris.data.model.AdminStorageWrap
import com.zekktris.data.model.AdminUser
import com.zekktris.data.model.AdminUsersWrap
import com.zekktris.data.model.BanBody
import com.zekktris.data.model.ChannelsWrap
import com.zekktris.data.model.InstanceMetrics
import com.zekktris.data.model.MetricsWrap
import com.zekktris.data.model.RoleBody
import com.zekktris.data.model.StorageGcResult
import com.zekktris.data.model.CreateGuildBody
import com.zekktris.data.model.CreateGuildResult
import com.zekktris.data.model.DeviceTokenBody
import com.zekktris.data.model.ChildRestrictions
import com.zekktris.data.model.DiscoverableGuild
import com.zekktris.data.model.DiscoveryWrap
import com.zekktris.data.model.EditMessageBody
import com.zekktris.data.model.FamilyLinkBody
import com.zekktris.data.model.FamilyRestrictionsWrap
import com.zekktris.data.model.FamilySummary
import com.zekktris.data.model.Guild
import com.zekktris.data.model.GuildWrap
import com.zekktris.data.model.MemberWrap
import com.zekktris.data.model.Invite
import com.zekktris.data.model.InvitePreview
import com.zekktris.data.model.InvitePreviewWrap
import com.zekktris.data.model.InviteWrap
import com.zekktris.data.model.InvitesWrap
import com.zekktris.data.model.JoinVoiceResult
import com.zekktris.data.model.StageJoinResult
import com.zekktris.data.model.StageParticipantsResult
import com.zekktris.data.model.VoiceState
import com.zekktris.data.model.VoiceStateWrap
import com.zekktris.data.model.RequestParentBody
import com.zekktris.data.model.GuildMember
import com.zekktris.data.model.GuildsWrap
import com.zekktris.data.model.LoginRequest
import com.zekktris.data.model.Message
import com.zekktris.data.model.MembersWrap
import com.zekktris.data.model.MessageWrap
import com.zekktris.data.model.MessagesWrap
import com.zekktris.data.model.OpenDMBody
import com.zekktris.data.model.ReadState
import com.zekktris.data.model.ReadStatesWrap
import com.zekktris.data.model.RefreshResponse
import com.zekktris.data.model.RegisterRequest
import com.zekktris.data.model.SelfUser
import com.zekktris.data.model.SendMessageBody
import com.zekktris.data.model.TwoFactorChallenge
import com.zekktris.data.model.UserWrap
import io.ktor.client.HttpClient
import io.ktor.client.call.body
import io.ktor.client.engine.okhttp.OkHttp
import io.ktor.client.plugins.HttpTimeout
import io.ktor.client.plugins.contentnegotiation.ContentNegotiation
import io.ktor.client.plugins.cookies.HttpCookies
import io.ktor.client.plugins.timeout
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.accept
import io.ktor.client.request.forms.MultiPartFormDataContent
import io.ktor.client.request.forms.formData
import io.ktor.client.request.get
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.Headers
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.delay
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

// Result of an attempted login: 2FA is not an error, it's a follow-up prompt.
sealed class LoginResult {
    data class Success(val user: SelfUser) : LoginResult()
    data object Requires2FA : LoginResult()
    data class Failure(val message: String) : LoginResult()
}

class ApiException(val status: Int, message: String) : Exception(message)

/**
 * One answer from `/auth/device-login/poll`, classified for the poll loop.
 *
 * The wire form is a flat `{status}` object where every documented state is an
 * HTTP 200 (see [com.zekktris.data.model.DeviceLoginPollResponse]); this is the
 * shape callers actually branch on. [Unavailable] is the one variant with no
 * server counterpart — it means "we couldn't ask", never "the request died", so
 * it is the ONLY value on which the loop keeps going without a fresh answer.
 */
sealed class DeviceLoginPoll {
    /** Keep waiting, then ask again in [interval] seconds. Also carries the
     *  server's `slow_down`, whose only correct handling is a longer wait. */
    data class Pending(val interval: Int) : DeviceLoginPoll()

    /** Terminal, and the session is LIVE: the access token has already been
     *  adopted by the client and the refresh cookie stored by the jar. */
    data class Approved(val user: SelfUser) : DeviceLoginPoll()

    /** The user refused on their other device. Terminal. */
    data object Denied : DeviceLoginPoll()

    /** Unknown, consumed, or timed-out request. Terminal — start over. */
    data object Expired : DeviceLoginPoll()

    /** Terminal with a reason worth showing (e.g. the account is disabled). */
    data class Failed(val message: String) : DeviceLoginPoll()

    /** Network error, 5xx, or an unparseable body. NOT an outcome. */
    data object Unavailable : DeviceLoginPoll()
}

/**
 * The outcome of ONE `/auth/refresh` attempt.
 *
 * Mirrors the web contract in `packages/client/src/rest.ts` (`RefreshOutcome`)
 * and `ios-native/Zekktris/APIClient.swift`. The distinction that matters is
 * [Fatal]: only that means "the session is over, clear the credentials".
 *
 * This used to be a plain `Boolean`, and Android was the worst of the three
 * clients for it: the access token is memory-only, so EVERY cold start has to
 * hit `/auth/refresh`, and a single `false` — returned identically for a real
 * 401, a 30 s timeout, an offline radio, and a 502 mid-deploy — nulled the
 * token and dropped the user on the login screen. Launching on a flaky
 * connection was a guaranteed trip to the sign-in form.
 */
enum class RefreshOutcome {
    /** The refresh cookie was exchanged for a fresh access token. */
    Success,

    /**
     * Network error, timeout, 5xx, the 409 the api returns when a concurrent
     * rotation won the race, or an unparseable body. The refresh cookie is
     * almost certainly still good — we simply couldn't ask. Keep the
     * credentials; the next attempt tries again.
     */
    Transient,

    /**
     * 401/403 from `/auth/refresh` itself: the refresh token is revoked or
     * expired and no amount of retrying brings the session back.
     */
    Fatal,
}

// REST client for the Zekktris API. Mirrors ios-native APIClient.swift: the
// short-lived access JWT is held in memory and attached as `Authorization:
// Bearer`; the refresh token rides in the persistent httpOnly cookie jar. On any
// 401 from an authorized call we refresh once (serialized) and replay.
class ApiClient(cookieStorage: PersistentCookieStorage) {

    @Volatile
    var accessToken: String? = null
        private set

    private val refreshMutex = Mutex()

    /** Bumped once per refresh that ended FATAL. Callers snapshot it on entry
     *  so a queue of 401s behind one dead session collapses to ONE ladder and
     *  ONE [onRefreshFatal]. Written only under [refreshMutex]; volatile
     *  because the entry snapshot is taken before the lock is acquired. */
    @Volatile
    private var fatalCount = 0

    /** When the last ladder gave up TRANSIENTLY, for the joiner cooldown.
     *  Written only under [refreshMutex]. */
    @Volatile
    private var lastTransientAtMs = 0L

    /**
     * Invoked after `/auth/refresh` rotates the access token, so an owner can
     * react to the fresh value. (The refresh token itself rides the persistent
     * cookie jar, which [PersistentCookieStorage] already writes on every
     * Set-Cookie — nothing to persist here.)
     */
    var onTokenRefresh: ((String) -> Unit)? = null

    /**
     * Invoked at most once per refresh that ended [RefreshOutcome.Fatal] — i.e.
     * only when `/auth/refresh` itself answered 401 or 403. The owner
     * ([com.zekktris.AppStore]) treats this as a hard sign-out.
     *
     * Deliberately NOT invoked for network errors, timeouts, 5xx, or the 409
     * the api returns when a concurrent rotation won the race. Those are
     * transient, the refresh cookie is still good, and signing out for them is
     * what turned every offline cold start into the login screen. Mirrors
     * `onRefreshFailed` in `packages/client/src/rest.ts` and `onRefreshFatal`
     * in `ios-native/Zekktris/APIClient.swift`.
     */
    var onRefreshFatal: (() -> Unit)? = null

    val json = Json {
        ignoreUnknownKeys = true
        explicitNulls = false
        coerceInputValues = true
        isLenient = true
    }

    val http = HttpClient(OkHttp) {
        expectSuccess = false
        install(ContentNegotiation) { json(json) }
        install(HttpCookies) { storage = cookieStorage }
        install(WebSockets)
        install(HttpTimeout) {
            requestTimeoutMillis = 30_000
            connectTimeoutMillis = 15_000
            socketTimeoutMillis = 30_000
        }
    }

    private fun url(path: String) = Config.API_BASE_URL + path

    // ---- session token management -------------------------------------------

    fun setAccessToken(token: String?) {
        accessToken = token
    }

    fun clearSession() {
        accessToken = null
    }

    /**
     * Return a usable access token, refreshing via the cookie if we don't hold
     * one. Collapses the tri-state to `null` for callers that genuinely can't
     * act on the difference (the gateway, push registration) — anything that
     * decides whether the user stays signed in must call [refreshAccessToken]
     * and read the outcome.
     */
    suspend fun ensureAccessToken(): String? {
        accessToken?.let { return it }
        return if (refreshAccessToken() == RefreshOutcome.Success) accessToken else null
    }

    /**
     * Exchange the refresh cookie for a fresh access token, retrying only the
     * failures worth retrying.
     *
     * Serialized on [refreshMutex] so concurrent 401s can't double-rotate the
     * cookie (the server treats an out-of-grace rotation of a superseded token
     * as theft and revokes the whole family). If the token already changed
     * while we queued for the lock, another caller refreshed — reuse it.
     *
     * Returns a TRI-STATE, not a Bool. Only [RefreshOutcome.Fatal] clears the
     * in-memory token and fires [onRefreshFatal]; a transient failure leaves
     * everything exactly where it was so the next call can recover.
     */
    suspend fun refreshAccessToken(): RefreshOutcome {
        val before = accessToken
        val fatalsBefore = fatalCount
        var announceFatal = false
        val outcome = refreshMutex.withLock {
            when {
                // Someone else refreshed successfully while we queued.
                accessToken != null && accessToken != before -> RefreshOutcome.Success
                // Someone else already established the session is dead while we
                // queued. Don't walk a second doomed ladder, and don't
                // re-announce a sign-out that has already been announced.
                fatalCount != fatalsBefore -> RefreshOutcome.Fatal
                // Someone else just found the api unreachable. A cold-start or
                // foreground burst can queue a dozen callers here; letting each
                // one re-walk the ladder serializes into minutes of hanging
                // requests for an answer we already have. Inherit it — the
                // credentials are kept either way, so the next call still tries.
                System.currentTimeMillis() - lastTransientAtMs < REFRESH_TRANSIENT_COOLDOWN_MS ->
                    RefreshOutcome.Transient
                else -> refreshWithBackoff().also { result ->
                    when (result) {
                        RefreshOutcome.Success -> lastTransientAtMs = 0L
                        RefreshOutcome.Transient -> lastTransientAtMs = System.currentTimeMillis()
                        RefreshOutcome.Fatal -> {
                            accessToken = null
                            fatalCount++
                            announceFatal = true
                        }
                    }
                }
            }
        }
        // Fired OUTSIDE the lock. The handler tears the whole session down and
        // can run inline (the app scope is Main.immediate); it must never be
        // able to re-enter a refresh while we still hold the mutex.
        if (announceFatal) onRefreshFatal?.invoke()
        return outcome
    }

    /**
     * Walk the backoff ladder, stopping the moment we have a token or a fatal
     * answer. Runs inside the mutex, so joiners share this one result and
     * [onRefreshFatal] fires once per refresh no matter how many callers piled
     * up behind it.
     */
    private suspend fun refreshWithBackoff(): RefreshOutcome {
        var outcome = refreshOnce()
        for (rung in REFRESH_RETRY_DELAYS_MS) {
            if (outcome != RefreshOutcome.Transient) return outcome
            delay(jittered(rung))
            outcome = refreshOnce()
        }
        return outcome
    }

    /** One `/auth/refresh` round trip. Never throws (except on cancellation) —
     *  every failure mode is classified into the tri-state instead. */
    private suspend fun refreshOnce(): RefreshOutcome {
        val resp = try {
            http.request(url("/auth/refresh")) {
                method = HttpMethod.Post
                accept(ContentType.Application.Json)
                // Tighter than the client-wide 30 s: up to four attempts run
                // behind one caller, and the whole ladder has to stay inside
                // the window in which the server still reads a superseded token
                // as benign concurrency rather than theft.
                timeout { requestTimeoutMillis = REFRESH_TIMEOUT_MS }
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            // Network-level failure: offline, DNS, connection reset, the app
            // opened before the radio came back, or our own request timeout.
            // The refresh cookie is almost certainly still good — we simply
            // couldn't ask.
            return RefreshOutcome.Transient
        }
        // The only two answers that actually mean "this session is over".
        if (resp.status.value == 401 || resp.status.value == 403) return RefreshOutcome.Fatal
        // 409 = a concurrent rotation won the race (or this replays a refresh
        // whose response was lost and the server couldn't re-serve it); 5xx =
        // the api is restarting or a proxy answered for it. Both are worth
        // retrying; neither is a logout.
        if (!resp.status.isSuccess()) return RefreshOutcome.Transient
        // A 2xx with an unreadable body means something interposed (proxy,
        // captive portal), not that the session died.
        val token = runCatching { resp.body<RefreshResponse>().accessToken }
            .getOrNull()?.takeIf { it.isNotEmpty() } ?: return RefreshOutcome.Transient
        accessToken = token
        onTokenRefresh?.invoke(token)
        return RefreshOutcome.Success
    }

    /**
     * Spread a ladder rung over ±50% at random, so devices whose access tokens
     * were minted together don't retry in lockstep against an api that is
     * already struggling — which is exactly when this ladder runs.
     */
    private fun jittered(delayMs: Long): Long =
        (delayMs * (0.5 + kotlin.random.Random.nextDouble())).toLong()

    // ---- request core -------------------------------------------------------

    private suspend fun authorized(
        method: HttpMethod,
        path: String,
        block: HttpRequestBuilder.() -> Unit = {},
    ): HttpResponse {
        var resp = send(method, path, accessToken, block)
        if (resp.status == HttpStatusCode.Unauthorized) {
            // Only a genuinely rotated token is worth replaying with. A
            // transient refresh leaves this one request failing with its 401
            // and keeps the credentials — the next call tries again.
            if (refreshAccessToken() == RefreshOutcome.Success) {
                resp = send(method, path, accessToken, block)
            }
        }
        return resp
    }

    private suspend fun send(
        method: HttpMethod,
        path: String,
        bearer: String?,
        block: HttpRequestBuilder.() -> Unit,
    ): HttpResponse = http.request(url(path)) {
        this.method = method
        accept(ContentType.Application.Json)
        bearer?.let { header(HttpHeaders.Authorization, "Bearer $it") }
        block()
    }

    private suspend inline fun <reified T> HttpResponse.decodeOrThrow(): T {
        if (!status.isSuccess()) {
            throw ApiException(status.value, "HTTP ${status.value}: ${bodyAsText().take(300)}")
        }
        return body()
    }

    private fun HttpStatusCode.isSuccess() = value in 200..299

    // ---- auth ---------------------------------------------------------------

    /** Ask for a reset email. The server answers the same way whether or not
     *  the address exists, so there is nothing to report but success. */
    suspend fun forgotPassword(email: String) {
        val body = buildJsonObject { put("email", JsonPrimitive(email.trim().lowercase())) }
        send(HttpMethod.Post, "/auth/forgot-password", null) {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    /** Finish a reset with the emailed token. Throws on a bad/expired token. */
    suspend fun resetPassword(token: String, newPassword: String) {
        val body = buildJsonObject {
            put("token", JsonPrimitive(token.trim()))
            put("newPassword", JsonPrimitive(newPassword))
        }
        val resp = send(HttpMethod.Post, "/auth/reset-password", null) {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
        if (!resp.status.isSuccess()) {
            // The server's message is the useful part here — expired token,
            // already used, password too short — so surface it rather than a
            // status code.
            val detail = runCatching {
                Json.parseToJsonElement(resp.bodyAsText())
                    .jsonObject["error"]?.jsonObject?.get("message")?.jsonPrimitive?.content
            }.getOrNull()
            throw ApiException(resp.status.value, detail ?: "That reset code didn't work.")
        }
    }

    suspend fun login(email: String, password: String, code: String? = null): LoginResult {
        val resp = send(HttpMethod.Post, "/auth/login", null) {
            contentType(ContentType.Application.Json)
            setBody(LoginRequest(email.trim().lowercase(), password, code))
        }
        return when {
            resp.status.isSuccess() -> {
                val auth = resp.body<AuthResponse>()
                accessToken = auth.accessToken
                LoginResult.Success(auth.user)
            }
            resp.status == HttpStatusCode.Unauthorized -> {
                val body = runCatching { resp.body<TwoFactorChallenge>() }.getOrNull()
                if (body?.requires2FA == true) LoginResult.Requires2FA
                else LoginResult.Failure("Invalid email or password.")
            }
            resp.status == HttpStatusCode.TooManyRequests ->
                LoginResult.Failure("Too many attempts. Try again shortly.")
            resp.status.value == 403 -> LoginResult.Failure("This account is disabled.")
            else -> LoginResult.Failure("Login failed (${resp.status.value}).")
        }
    }

    suspend fun register(
        email: String,
        username: String,
        displayName: String,
        password: String,
        dateOfBirth: String,
        code: String? = null,
    ): LoginResult {
        val resp = send(HttpMethod.Post, "/auth/register", null) {
            contentType(ContentType.Application.Json)
            setBody(RegisterRequest(email.trim().lowercase(), username, displayName, password, dateOfBirth, code))
        }
        return when {
            resp.status.isSuccess() -> {
                val auth = resp.body<AuthResponse>()
                accessToken = auth.accessToken
                LoginResult.Success(auth.user)
            }
            resp.status.value == 409 -> LoginResult.Failure("That email or username is already taken.")
            resp.status.value == 400 -> LoginResult.Failure("Please check your details and try again.")
            else -> LoginResult.Failure("Sign up failed (${resp.status.value}).")
        }
    }

    suspend fun logout() {
        val bearer = accessToken
        runCatching {
            send(HttpMethod.Post, "/auth/logout", bearer) {}
        }
        clearSession()
    }

    // ---- data ---------------------------------------------------------------

    suspend fun getMe(): SelfUser = authorized(HttpMethod.Get, "/users/@me").decodeOrThrow<UserWrap>().user

    /** Partial profile update (displayName / bio / status). */
    suspend fun updateProfile(patch: com.zekktris.data.model.ProfilePatch): SelfUser =
        authorized(HttpMethod.Patch, "/users/@me") {
            contentType(ContentType.Application.Json); setBody(patch)
        }.decodeOrThrow<UserWrap>().user

    private suspend fun uploadImage(path: String, filename: String, mime: String, bytes: ByteArray): SelfUser =
        authorized(HttpMethod.Post, path) {
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append(
                            "file", bytes,
                            Headers.build {
                                append(HttpHeaders.ContentType, mime)
                                append(HttpHeaders.ContentDisposition, "filename=\"$filename\"")
                            },
                        )
                    },
                ),
            )
        }.decodeOrThrow<UserWrap>().user

    suspend fun uploadMyAvatar(filename: String, mime: String, bytes: ByteArray): SelfUser =
        uploadImage("/users/@me/avatar", filename, mime, bytes)

    suspend fun uploadMyBanner(filename: String, mime: String, bytes: ByteArray): SelfUser =
        uploadImage("/users/@me/banner", filename, mime, bytes)

    /**
     * Custom status update. Built with an explicit JSON object (not ProfilePatch)
     * because clearing the status / auto-clear timer must send explicit nulls —
     * the client Json omits nulls (explicitNulls=false), so a null on the data
     * class would silently not clear anything. Blank text/emoji → null (clear);
     * expiresAt is an ISO-8601 instant or null (don't auto-clear).
     */
    suspend fun updateCustomStatus(text: String, emoji: String, expiresAt: String?): SelfUser =
        authorized(HttpMethod.Patch, "/users/@me") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("customStatus", if (text.isBlank()) JsonNull else JsonPrimitive(text.trim()))
                put("customStatusEmoji", if (emoji.isBlank()) JsonNull else JsonPrimitive(emoji.trim()))
                put("customStatusExpiresAt", expiresAt?.let { JsonPrimitive(it) } ?: JsonNull)
            }.toString())
        }.decodeOrThrow<UserWrap>().user

    /** Staff-only display-name shimmer. A #rrggbb turns it on; null clears it
        (explicit JSON null — the server also gates the write to staff). */
    suspend fun setStaffColor(hex: String?): SelfUser =
        authorized(HttpMethod.Patch, "/users/@me") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("staffColor", hex?.let { JsonPrimitive(it) } ?: JsonNull) }.toString())
        }.decodeOrThrow<UserWrap>().user

    suspend fun setStaffGlow(on: Boolean): SelfUser =
        authorized(HttpMethod.Patch, "/users/@me") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("staffGlow", JsonPrimitive(on)) }.toString())
        }.decodeOrThrow<UserWrap>().user

    suspend fun listGuilds(): List<Guild> =
        authorized(HttpMethod.Get, "/guilds").decodeOrThrow<GuildsWrap>().guilds

    suspend fun listChannels(guildId: String): List<Channel> =
        authorized(HttpMethod.Get, "/guilds/$guildId/channels").decodeOrThrow<ChannelsWrap>().channels

    /** Everyone in voice across a whole server that this user can see — the
     *  sidebar's heal for a missed VOICE_STATE_UPDATE. */
    suspend fun listGuildVoiceStates(guildId: String): List<com.zekktris.data.model.VoiceState> =
        authorized(HttpMethod.Get, "/guilds/$guildId/voice/states")
            .decodeOrThrow<com.zekktris.data.model.VoiceStatesWrap>().voiceStates

    /** Roles for a guild (drives member-name colors + hoisted member sections). */
    suspend fun listRoles(guildId: String): List<com.zekktris.data.model.Role> =
        authorized(HttpMethod.Get, "/guilds/$guildId/roles").decodeOrThrow<com.zekktris.data.model.RolesWrap>().roles

    /** My full achievement catalog (earned + locked, with progress). */
    suspend fun myAchievements(): List<com.zekktris.data.model.Achievement> =
        authorized(HttpMethod.Get, "/users/@me/achievements").decodeOrThrow<com.zekktris.data.model.AchievementsWrap>().achievements

    /** Another user's PUBLIC earned achievements (empty if they've hidden them). */
    suspend fun userAchievements(userId: String): List<com.zekktris.data.model.Achievement> =
        runCatching { authorized(HttpMethod.Get, "/users/$userId/achievements").decodeOrThrow<com.zekktris.data.model.AchievementsWrap>().achievements }
            .getOrDefault(emptyList())

    suspend fun listGuildEmojis(guildId: String): List<com.zekktris.data.model.GuildEmoji> =
        authorized(HttpMethod.Get, "/guilds/$guildId/emojis").decodeOrThrow<com.zekktris.data.model.EmojisWrap>().emojis

    /** Upload a custom guild emoji (MANAGE_EMOJIS). Multipart: name field + file. */
    suspend fun uploadGuildEmoji(guildId: String, name: String, filename: String, mime: String, bytes: ByteArray): com.zekktris.data.model.GuildEmoji =
        authorized(HttpMethod.Post, "/guilds/$guildId/emojis") {
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append("name", name)
                        append(
                            "file", bytes,
                            Headers.build {
                                append(HttpHeaders.ContentType, mime)
                                append(HttpHeaders.ContentDisposition, "filename=\"$filename\"")
                            },
                        )
                    },
                ),
            )
        }.decodeOrThrow<com.zekktris.data.model.EmojiWrap>().emoji

    suspend fun deleteGuildEmoji(guildId: String, emojiId: String) {
        authorized(HttpMethod.Delete, "/guilds/$guildId/emojis/$emojiId") {}
    }

    suspend fun listMembers(guildId: String): List<GuildMember> =
        authorized(HttpMethod.Get, "/guilds/$guildId/members").decodeOrThrow<MembersWrap>().members

    suspend fun listDMs(): List<Channel> =
        authorized(HttpMethod.Get, "/users/@me/channels").decodeOrThrow<ChannelsWrap>().channels

    suspend fun openDM(recipientId: String): Channel {
        val resp = authorized(HttpMethod.Post, "/users/@me/channels") {
            contentType(ContentType.Application.Json)
            setBody(OpenDMBody(recipientId))
        }
        return resp.decodeOrThrow<ChannelWrap>().channel
    }

    suspend fun listMessages(
        channelId: String,
        limit: Int = 50,
        before: String? = null,
        after: String? = null,
        around: String? = null,
    ): List<Message> {
        // Snowflake ids are numeric strings — no URL encoding needed.
        val q = buildList {
            add("limit=$limit")
            before?.let { add("before=$it") }
            after?.let { add("after=$it") }
            around?.let { add("around=$it") }
        }.joinToString("&")
        return authorized(HttpMethod.Get, "/channels/$channelId/messages?$q")
            .decodeOrThrow<MessagesWrap>().messages
    }

    /** Shared-media gallery: a channel's attachments newest-first, paginated by
     *  attachment id (`before` cursor). `kind` = "media" (image/video) or
     *  "files" filters server-side by content type; E2EE channels must pass
     *  null — the real type hides inside the encrypted `.zke` blob, so the
     *  client buckets by the INNER filename instead (deliberate, matches iOS). */
    suspend fun listChannelAttachments(
        channelId: String,
        before: String? = null,
        limit: Int = 60,
        kind: String? = null,
    ): List<com.zekktris.data.model.Attachment> {
        val q = buildList {
            add("limit=$limit")
            before?.let { add("before=$it") }
            kind?.let { add("kind=$it") }
        }.joinToString("&")
        return authorized(HttpMethod.Get, "/channels/$channelId/attachments?$q")
            .decodeOrThrow<com.zekktris.data.model.ChannelAttachmentsWrap>().attachments
    }

    // ── Device-approval login ("approve this login on your phone") ───────────
    //
    // Replaces /auth/quick-login/*, which pushed a code the OTHER way and where
    // "the code is the whole credential". Here the logged-out device opens a
    // request and polls with a 256-bit secret; the short code it displays is
    // useless to anyone who isn't already signed in.
    //
    // The three authed calls go through [authorized] so a cold-start 401
    // refreshes and replays like everything else. The two public calls go
    // through [send] with a null bearer — the whole point is that the calling
    // device has no session yet.

    /**
     * The User-Agent sent with `/auth/device-login/start`, and only there.
     *
     * The server derives `platform` from it and shows it verbatim on the
     * approval screen, where it is labelled as a CLAIM — it is not, and must
     * not be treated as, evidence of anything. We send an honest value so the
     * approving user reads "Android 15 · Pixel 9" instead of "okhttp/5.0".
     * Ktor has no UserAgent plugin installed, and OkHttp only fills in its own
     * default when the request carries none, so this simply wins.
     */
    private fun deviceUserAgent(): String =
        "Zekktris-Android (Android ${android.os.Build.VERSION.RELEASE}; ${android.os.Build.MODEL})"

    /** [public] Open a device-login request from this (logged-out) device. */
    suspend fun deviceLoginStart(deviceName: String?): com.zekktris.data.model.DeviceLoginStart =
        send(HttpMethod.Post, "/auth/device-login/start", null) {
            contentType(ContentType.Application.Json)
            header(HttpHeaders.UserAgent, deviceUserAgent())
            header(HttpHeaders.AcceptLanguage, java.util.Locale.getDefault().toLanguageTag())
            // The body is REQUIRED even when empty — the server's validator
            // rejects an absent one.
            setBody(com.zekktris.data.model.DeviceLoginStartBody(deviceName))
        }.decodeOrThrow<com.zekktris.data.model.DeviceLoginStart>()

    /**
     * [public] Ask for this request's outcome, presenting the SECRET device
     * code. Every documented state is an HTTP 200 — pending/denied/expired are
     * states of a polling loop, not errors — so this classifies rather than
     * throws, and the caller keeps polling only on [DeviceLoginPoll.Unavailable].
     *
     * On `approved` the access token is adopted here, exactly as [login] does;
     * the refresh token rides the Set-Cookie the persistent jar already stores.
     * The grant is delivered EXACTLY ONCE, so there is no second chance to
     * collect it — nothing between the response and the token assignment may
     * fail.
     */
    suspend fun deviceLoginPoll(deviceCode: String): DeviceLoginPoll {
        val resp = try {
            send(HttpMethod.Post, "/auth/device-login/poll", null) {
                contentType(ContentType.Application.Json)
                setBody(com.zekktris.data.model.DeviceLoginPollBody(deviceCode))
            }
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            return DeviceLoginPoll.Unavailable
        }
        when (resp.status.value) {
            // Flood guard on the public route. We poll far under the cap, so
            // this means something else on this IP is hammering it: back off
            // hard rather than give up — the user is mid-flow.
            429 -> return DeviceLoginPoll.Pending(30)
            // The approved branch found the account gone. The grant is already
            // consumed, so there is nothing left to poll for.
            400 -> return DeviceLoginPoll.Expired
            403 -> return DeviceLoginPoll.Failed("This account has been disabled.")
        }
        if (!resp.status.isSuccess()) return DeviceLoginPoll.Unavailable
        val body = try {
            resp.body<com.zekktris.data.model.DeviceLoginPollResponse>()
        } catch (e: kotlinx.coroutines.CancellationException) {
            throw e
        } catch (_: Exception) {
            // A 2xx we can't parse means something interposed (proxy, captive
            // portal), not that the request died.
            return DeviceLoginPoll.Unavailable
        }
        return when (body.status) {
            "pending" -> DeviceLoginPoll.Pending(body.interval ?: 5)
            // slow_down is a pending with a bigger interval; the caller's only
            // correct reaction to either is "wait this long, then ask again".
            "slow_down" -> DeviceLoginPoll.Pending(body.interval ?: 10)
            "denied" -> DeviceLoginPoll.Denied
            "approved" -> {
                val token = body.accessToken
                val user = body.user
                if (token.isNullOrEmpty() || user == null) DeviceLoginPoll.Unavailable
                else {
                    accessToken = token
                    DeviceLoginPoll.Approved(user)
                }
            }
            // "expired" plus any status a future server adds: terminal, and the
            // user restarts. Guessing "keep polling" on an unknown status would
            // spin forever.
            else -> DeviceLoginPoll.Expired
        }
    }

    /**
     * [authed] What is this code asking for? The returned metadata is the ONLY
     * defence against an attacker phishing an approval out of the user, so the
     * approval screen must render all of it. 404 when unknown or expired.
     */
    suspend fun deviceLoginLookup(userCode: String): com.zekktris.data.model.DeviceLoginRequestInfo =
        authorized(HttpMethod.Post, "/auth/device-login/lookup") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.DeviceLoginCodeBody(userCode))
        }.decodeOrThrow<com.zekktris.data.model.DeviceLoginRequestInfo>()

    /** [authed] Approve: bind the request to this user and log that device in.
     *  Terminal. Throws [ApiException] 404 (unknown) / 409 (already answered). */
    suspend fun deviceLoginApprove(userCode: String) = deviceLoginDecide("approve", userCode)

    /** [authed] Deny. Terminal, and races an approve to a single outcome. */
    suspend fun deviceLoginDeny(userCode: String) = deviceLoginDecide("deny", userCode)

    private suspend fun deviceLoginDecide(action: String, userCode: String) {
        val resp = authorized(HttpMethod.Post, "/auth/device-login/$action") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.DeviceLoginCodeBody(userCode))
        }
        if (!resp.status.isSuccess()) {
            throw ApiException(resp.status.value, "HTTP ${resp.status.value}: ${resp.bodyAsText().take(200)}")
        }
    }

    /** Per-channel full-text search (same endpoint iOS SearchSheet uses). */
    suspend fun searchMessages(channelId: String, query: String): List<Message> {
        val q = java.net.URLEncoder.encode(query, "UTF-8")
        return authorized(HttpMethod.Get, "/channels/$channelId/messages/search?q=$q")
            .decodeOrThrow<MessagesWrap>().messages
    }

    suspend fun sendMessage(
        channelId: String,
        content: String,
        nonce: String? = null,
        replyToId: String? = null,
        forwardFromMessageId: String? = null,
    ): Message {
        val resp = authorized(HttpMethod.Post, "/channels/$channelId/messages") {
            contentType(ContentType.Application.Json)
            setBody(SendMessageBody(content, nonce, replyToId, forwardFromMessageId))
        }
        return resp.decodeOrThrow<MessageWrap>().message
    }

    suspend fun ackMessage(channelId: String, messageId: String): ReadState =
        authorized(HttpMethod.Post, "/channels/$channelId/messages/$messageId/ack")
            .decodeOrThrow<AckWrap>().readState

    // ---- message actions (reactions / edit / delete / typing / upload) ------

    /** Percent-encode every non-alphanumeric byte (emoji in a path segment).
        Matches web encodeURIComponent / iOS emojiPathComponent. */
    private fun percentEncode(s: String): String = buildString {
        for (b in s.toByteArray(Charsets.UTF_8)) {
            val i = b.toInt() and 0xFF
            val c = i.toChar()
            if (c in 'A'..'Z' || c in 'a'..'z' || c in '0'..'9') append(c)
            else append('%').append(String.format("%02X", i))
        }
    }

    suspend fun addReaction(channelId: String, messageId: String, emoji: String) {
        authorized(HttpMethod.Put, "/channels/$channelId/messages/$messageId/reactions/${percentEncode(emoji)}/@me") {}
    }

    suspend fun removeReaction(channelId: String, messageId: String, emoji: String) {
        authorized(HttpMethod.Delete, "/channels/$channelId/messages/$messageId/reactions/${percentEncode(emoji)}/@me") {}
    }

    suspend fun editMessage(channelId: String, messageId: String, content: String): Message {
        val resp = authorized(HttpMethod.Patch, "/channels/$channelId/messages/$messageId") {
            contentType(ContentType.Application.Json)
            setBody(EditMessageBody(content))
        }
        return resp.decodeOrThrow<MessageWrap>().message
    }

    suspend fun deleteMessage(channelId: String, messageId: String) {
        authorized(HttpMethod.Delete, "/channels/$channelId/messages/$messageId") {}
    }

    /** Fire-and-forget typing signal; the server broadcasts TYPING_START. */
    suspend fun sendTyping(channelId: String) {
        runCatching { authorized(HttpMethod.Post, "/channels/$channelId/typing") {} }
    }

    /** One file part for a multipart message send.
     *  [width]/[height] ride as plaintext `attachments` metadata in
     *  payload_json (positional) — the server can't measure E2EE (.zke)
     *  ciphertext, so the client supplies dims and the recipient reserves the
     *  slot before decrypt. [thumbBytes] is an already-ENCRYPTED (.zke) small
     *  thumbnail uploaded as `thumbs[i]` (E2EE images only). */
    class UploadFilePart(
        val filename: String,
        val mime: String,
        val bytes: ByteArray,
        val width: Int? = null,
        val height: Int? = null,
        val thumbBytes: ByteArray? = null,
    )

    /** Send a message with attachments — the web/iOS contract: a `payload_json`
        text field + positional `files[N]` file parts. */
    suspend fun sendMessageMultipart(
        channelId: String,
        content: String,
        nonce: String,
        replyToId: String?,
        files: List<UploadFilePart>,
        voiceMessage: kotlinx.serialization.json.JsonObject? = null,
    ): Message {
        val payload = buildJsonObject {
            put("content", JsonPrimitive(content))
            put("nonce", JsonPrimitive(nonce))
            put("replyToId", replyToId?.let { JsonPrimitive(it) } ?: JsonNull)
            // The clip's duration + waveform ride as plaintext metadata (iOS/web
            // contract) so the recipient renders the player without downloading.
            voiceMessage?.let { put("voiceMessage", it) }
            // Positional per-attachment metadata (E2EE images): the server only
            // sees .zke ciphertext it can't measure, so the client supplies the
            // pixel dims (entry k describes files[k]; null for meta-less files).
            if (files.any { it.width != null || it.height != null || it.thumbBytes != null }) {
                put(
                    "attachments",
                    buildJsonArray {
                        files.forEach { f ->
                            if (f.width == null && f.height == null && f.thumbBytes == null) add(JsonNull)
                            else add(
                                buildJsonObject {
                                    f.width?.let { put("width", JsonPrimitive(it)) }
                                    f.height?.let { put("height", JsonPrimitive(it)) }
                                    if (f.thumbBytes != null) put("hasThumbnail", JsonPrimitive(true))
                                },
                            )
                        }
                    },
                )
            }
        }
        val resp = authorized(HttpMethod.Post, "/channels/$channelId/messages") {
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append(
                            "payload_json", payload.toString(),
                            Headers.build { append(HttpHeaders.ContentType, "application/json") },
                        )
                        files.forEachIndexed { i, f ->
                            append(
                                "files[$i]", f.bytes,
                                Headers.build {
                                    append(HttpHeaders.ContentType, f.mime)
                                    append(HttpHeaders.ContentDisposition, "filename=\"${f.filename}\"")
                                },
                            )
                            // Encrypted small thumbnail for files[i] (E2EE images
                            // only) — its own attachment row server-side, served
                            // via thumbnailUrl. Same iOS wire name: thumb.zke.
                            f.thumbBytes?.let { tb ->
                                append(
                                    "thumbs[$i]", tb,
                                    Headers.build {
                                        append(HttpHeaders.ContentType, "application/octet-stream")
                                        append(HttpHeaders.ContentDisposition, "filename=\"thumb.zke\"")
                                    },
                                )
                            }
                        }
                    },
                ),
            )
        }
        return resp.decodeOrThrow<MessageWrap>().message
    }

    /**
     * Fetch raw bytes from an absolute asset URL (CDN attachment blobs). Used
     * by the E2EE layer to download .zke ciphertext for in-memory decryption —
     * deliberately NOT a disk-caching image loader: decrypted output must
     * never touch disk, and the ciphertext fetch stays a plain streamed GET.
     */
    suspend fun fetchBytes(absoluteUrl: String): ByteArray? = runCatching {
        val resp = http.get(absoluteUrl)
        if (resp.status.value in 200..299) resp.body<ByteArray>() else null
    }.getOrNull()

    // ---- push tokens --------------------------------------------------------

    /**
     * Register this device's FCM token for push. Best-effort: the server 503s
     * for platform=android until its FCM_* env vars are set, and 401s if we've
     * lost the session — both are swallowed by the caller.
     */
    suspend fun registerDeviceToken(token: String, label: String? = null): Boolean =
        authorized(HttpMethod.Post, "/users/@me/device-tokens") {
            contentType(ContentType.Application.Json)
            setBody(DeviceTokenBody(token = token, platform = "android", label = label))
        }.status.isSuccess()

    /** Remove this device's token (on sign-out). FCM tokens are path-safe
        (no `/`), so the raw value is a valid path segment. */
    suspend fun deleteDeviceToken(token: String) {
        authorized(HttpMethod.Delete, "/users/@me/device-tokens/$token") {}
    }

    // ---- pokes / per-DM settings ---------------------------------------------

    /** Fire-and-forget nudge; the poke echoes back over the gateway (no message). */
    suspend fun poke(channelId: String, pokeType: String) {
        val resp = authorized(HttpMethod.Post, "/channels/$channelId/poke") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.PokeBody(pokeType))
        }
        if (resp.status.value == 429) throw ApiException(429, "Easy there — wait a few seconds between pokes.")
    }

    /** The last pokes RECEIVED on this DM (max 6, newest-first). */
    suspend fun listPokes(channelId: String): List<com.zekktris.data.model.PokeHistoryEntry> =
        authorized(HttpMethod.Get, "/channels/$channelId/pokes")
            .decodeOrThrow<com.zekktris.data.model.PokesWrap>().pokes

    suspend fun getDmSettings(channelId: String): com.zekktris.data.model.DmChannelSettings =
        authorized(HttpMethod.Get, "/users/@me/channels/$channelId/settings").decodeOrThrow()

    /** Auto-delete after read: 30 / 60 / 120 seconds, or null = off. The null
        must be EXPLICIT in the JSON (clearing the TTL), so build it by hand. */
    suspend fun setDmTtl(channelId: String, ttlSeconds: Int?) {
        val body = buildJsonObject {
            put("ttlSecondsAfterRead", ttlSeconds?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        authorized(HttpMethod.Patch, "/users/@me/channels/$channelId/settings") {
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }
    }

    /** Whether pushes for this DM show message content; explicit null = account default. */
    suspend fun setNotificationPreview(channelId: String, showContent: Boolean?) {
        val body = buildJsonObject {
            put("showContent", showContent?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        authorized(HttpMethod.Patch, "/users/@me/channels/$channelId/notification-preview") {
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }
    }

    suspend fun closeDm(channelId: String) {
        authorized(HttpMethod.Delete, "/users/@me/channels/$channelId") {}
    }

    // Shared-key E2EE: salt + verifier are derived client-side; the server never
    // sees the key. Disable requires the verifier as proof we hold the key.
    suspend fun enableDmE2EE(channelId: String, salt: String, verifier: String) {
        authorized(HttpMethod.Put, "/users/@me/channels/$channelId/e2ee-enable") {
            contentType(ContentType.Application.Json); setBody(com.zekktris.data.model.E2EEEnableBody(salt, verifier))
        }
    }

    suspend fun disableDmE2EE(channelId: String, verifier: String) {
        authorized(HttpMethod.Delete, "/users/@me/channels/$channelId/e2ee-disable") {
            contentType(ContentType.Application.Json); setBody(com.zekktris.data.model.E2EEDisableBody(verifier))
        }
    }

    // ---- account security ----------------------------------------------------

    private suspend fun expectOk(resp: HttpResponse) {
        if (resp.status.value !in 200..299) {
            throw ApiException(resp.status.value, "HTTP ${resp.status.value}: ${resp.bodyAsText().take(200)}")
        }
    }

    suspend fun changePassword(currentPassword: String, newPassword: String) {
        expectOk(
            authorized(HttpMethod.Post, "/users/@me/password") {
                contentType(ContentType.Application.Json)
                setBody(com.zekktris.data.model.ChangePasswordBody(currentPassword, newPassword))
            },
        )
    }

    suspend fun changeUsername(username: String, currentPassword: String): SelfUser =
        authorized(HttpMethod.Patch, "/users/@me/username") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.ChangeUsernameBody(username, currentPassword))
        }.decodeOrThrow<UserWrap>().user

    /** Server emails a verification link to the NEW address; nothing changes until confirmed. */
    suspend fun requestEmailChange(newEmail: String, currentPassword: String) {
        expectOk(
            authorized(HttpMethod.Post, "/users/@me/email/change-request") {
                contentType(ContentType.Application.Json)
                setBody(com.zekktris.data.model.ChangeEmailBody(newEmail, currentPassword))
            },
        )
    }

    suspend fun totpStatus(): com.zekktris.data.model.TwoFactorStatus =
        authorized(HttpMethod.Get, "/users/@me/totp").decodeOrThrow()

    suspend fun totpBegin(): com.zekktris.data.model.TwoFactorSecret =
        authorized(HttpMethod.Post, "/users/@me/totp/begin") {}.decodeOrThrow()

    /** currentPassword is REQUIRED (step-up: arming 2FA is a login-factor change). */
    suspend fun totpConfirm(code: String, currentPassword: String): com.zekktris.data.model.TwoFactorRecovery =
        authorized(HttpMethod.Post, "/users/@me/totp/confirm") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.TotpConfirmBody(code, currentPassword))
        }.decodeOrThrow()

    /** Accepts a current 6-digit TOTP code OR a recovery code. */
    suspend fun totpDisable(code: String) {
        expectOk(
            authorized(HttpMethod.Post, "/users/@me/totp/disable") {
                contentType(ContentType.Application.Json)
                setBody(com.zekktris.data.model.TotpCodeBody(code))
            },
        )
    }

    suspend fun listSessions(): List<com.zekktris.data.model.SessionInfo> =
        authorized(HttpMethod.Get, "/users/@me/sessions")
            .decodeOrThrow<com.zekktris.data.model.SessionsWrap>().sessions

    suspend fun revokeSession(id: String) {
        authorized(HttpMethod.Delete, "/users/@me/sessions/$id") {}
    }

    // ---- passkeys (WebAuthn via CredentialManager) ---------------------------
    // The server-issued `options` JSON is handed verbatim to CredentialManager;
    // its response JSON is embedded (parsed, not stringified) back into `response`.

    suspend fun passkeyLoginOptions(): com.zekktris.data.model.PasskeyOptionsResponse =
        send(HttpMethod.Post, "/auth/passkey/login/options", null) {}.decodeOrThrow()

    /** Verify an assertion; on success sets the session token and returns the user. */
    suspend fun passkeyLoginVerify(challengeId: String, responseJson: String): SelfUser {
        val resp = send(HttpMethod.Post, "/auth/passkey/login/verify", null) {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("challengeId", JsonPrimitive(challengeId))
                put("response", Json.parseToJsonElement(responseJson))
            }.toString())
        }
        if (!resp.status.isSuccess()) throw ApiException(resp.status.value, "Passkey sign-in failed.")
        val auth = resp.body<AuthResponse>()
        accessToken = auth.accessToken
        return auth.user
    }

    suspend fun passkeyRegisterOptions(): com.zekktris.data.model.PasskeyOptionsResponse =
        authorized(HttpMethod.Post, "/auth/passkey/register/options") {}.decodeOrThrow()

    suspend fun passkeyRegisterVerify(challengeId: String, responseJson: String, deviceName: String?, currentPassword: String) {
        // expectOk: the client is built with expectSuccess=false, so a rejected
        // registration (wrong step-up password, attestation failure) must be
        // surfaced explicitly rather than swallowed as success.
        expectOk(authorized(HttpMethod.Post, "/auth/passkey/register/verify") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("challengeId", JsonPrimitive(challengeId))
                put("response", Json.parseToJsonElement(responseJson))
                put("deviceName", deviceName?.let { JsonPrimitive(it) } ?: JsonNull)
                put("currentPassword", JsonPrimitive(currentPassword))
            }.toString())
        })
    }

    suspend fun listPasskeys(): List<com.zekktris.data.model.PasskeyInfo> =
        authorized(HttpMethod.Get, "/auth/passkey").decodeOrThrow<com.zekktris.data.model.PasskeysWrap>().passkeys

    suspend fun deletePasskey(id: String, currentPassword: String) {
        expectOk(authorized(HttpMethod.Delete, "/auth/passkey/$id") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("currentPassword", JsonPrimitive(currentPassword)) }.toString())
        })
    }

    // ---- friends / relationships --------------------------------------------

    suspend fun listRelationships(): List<com.zekktris.data.model.Relationship> =
        authorized(HttpMethod.Get, "/users/@me/relationships")
            .decodeOrThrow<com.zekktris.data.model.RelationshipsWrap>().relationships

    suspend fun addFriend(username: String) {
        val resp = authorized(HttpMethod.Post, "/users/@me/relationships/friends") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.AddFriendBody(username))
        }
        if (resp.status.value !in 200..299) {
            throw ApiException(resp.status.value, "HTTP ${resp.status.value}: ${resp.bodyAsText().take(200)}")
        }
    }

    suspend fun acceptFriend(targetId: String) {
        authorized(HttpMethod.Put, "/users/@me/relationships/friends/$targetId/accept") {}
    }

    /** One endpoint serves remove-friend, decline-incoming, AND cancel-outgoing. */
    suspend fun removeFriend(targetId: String) {
        authorized(HttpMethod.Delete, "/users/@me/relationships/friends/$targetId") {}
    }

    suspend fun blockUser(targetId: String) {
        authorized(HttpMethod.Post, "/users/@me/relationships/blocks") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.BlockBody(targetId))
        }
    }

    suspend fun unblockUser(targetId: String) {
        authorized(HttpMethod.Delete, "/users/@me/relationships/blocks/$targetId") {}
    }

    // ---- mentions / saved / scheduled / search / events ----------------------

    suspend fun listMentions(): List<com.zekktris.data.model.Mention> =
        authorized(HttpMethod.Get, "/users/@me/mentions")
            .decodeOrThrow<com.zekktris.data.model.MentionsWrap>().mentions

    suspend fun dismissMention(messageId: String) {
        authorized(HttpMethod.Delete, "/users/@me/mentions/$messageId") {}
    }

    suspend fun clearMentions() {
        authorized(HttpMethod.Post, "/users/@me/mentions/clear") {}
    }

    suspend fun listSaved(): List<com.zekktris.data.model.SavedMessageItem> =
        authorized(HttpMethod.Get, "/users/@me/saved")
            .decodeOrThrow<com.zekktris.data.model.SavedListWrap>().items

    suspend fun saveMessage(messageId: String) {
        authorized(HttpMethod.Post, "/users/@me/saved/$messageId") {}
    }

    suspend fun unsaveMessage(messageId: String) {
        authorized(HttpMethod.Delete, "/users/@me/saved/$messageId") {}
    }

    suspend fun listScheduled(): List<com.zekktris.data.model.ScheduledMessage> =
        authorized(HttpMethod.Get, "/users/@me/scheduled-messages")
            .decodeOrThrow<com.zekktris.data.model.ScheduledListWrap>().items

    /**
     * Queue a message for future delivery. [content] is the wire content — for
     * an E2EE DM the caller pre-encrypts it (the server stores + fires the
     * ciphertext verbatim). [scheduledFor] is an ISO-8601 instant.
     */
    suspend fun scheduleMessage(channelId: String, content: String, scheduledFor: String): com.zekktris.data.model.ScheduledMessage =
        authorized(HttpMethod.Post, "/channels/$channelId/scheduled-messages") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("content", JsonPrimitive(content))
                put("scheduledFor", JsonPrimitive(scheduledFor))
            }.toString())
        }.decodeOrThrow<com.zekktris.data.model.ScheduledWrap>().scheduled

    suspend fun cancelScheduled(id: String) {
        authorized(HttpMethod.Delete, "/users/@me/scheduled-messages/$id") {}
    }

    // ── Bots (owner-facing management) ────────────────────────────────────────
    suspend fun listBots(): List<com.zekktris.data.model.Bot> =
        authorized(HttpMethod.Get, "/users/@me/bots").decodeOrThrow<com.zekktris.data.model.BotListWrap>().bots

    /** Create a bot; the response carries the one-time plaintext token. */
    suspend fun createBot(username: String, displayName: String): com.zekktris.data.model.BotCreateResponse =
        authorized(HttpMethod.Post, "/users/@me/bots") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.BotCreateBody(username, displayName))
        }.decodeOrThrow()

    /** Regenerate a bot's token; invalidates the old one. Returns the new token. */
    suspend fun regenerateBotToken(botId: String): String =
        authorized(HttpMethod.Post, "/users/@me/bots/$botId/token")
            .decodeOrThrow<com.zekktris.data.model.BotTokenResponse>().token

    suspend fun deleteBot(botId: String) {
        authorized(HttpMethod.Delete, "/users/@me/bots/$botId") {}
    }

    /** Add one of your bots to a guild. Requires MANAGE_GUILD on the target. */
    suspend fun addBotToGuild(guildId: String, botId: String) {
        authorized(HttpMethod.Post, "/guilds/$guildId/bots") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.AddBotBody(botId))
        }
    }

    /**
     * Set (url != null) or clear (url == null) a bot's event callback URL.
     * The signing secret is returned once when a URL is set. `url` is sent as an
     * explicit JSON null on clear so the server distinguishes it from "omitted".
     */
    suspend fun setBotEventConfig(botId: String, url: String?): com.zekktris.data.model.BotEventConfigResponse =
        authorized(HttpMethod.Put, "/users/@me/bots/$botId/event-config") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject {
                put("url", url?.let { JsonPrimitive(it) } ?: JsonNull)
            }.toString())
        }.decodeOrThrow()

    // ── Personal DM nicknames (viewer-private) ────────────────────────────────
    suspend fun getDmNicknames(): Map<String, String> =
        authorized(HttpMethod.Get, "/users/@me/dm-nicknames")
            .decodeOrThrow<com.zekktris.data.model.DmNicknamesWrap>().nicknames

    suspend fun setDmNickname(userId: String, nickname: String) {
        authorized(HttpMethod.Put, "/users/@me/dm-nicknames/$userId") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.DmNicknameBody(nickname))
        }
    }

    suspend fun clearDmNickname(userId: String) {
        authorized(HttpMethod.Delete, "/users/@me/dm-nicknames/$userId") {}
    }

    /** Cross-DM full-text search (fires on submit, never as-you-type). */
    suspend fun searchDms(query: String): List<Message> {
        val q = java.net.URLEncoder.encode(query, "UTF-8")
        return authorized(HttpMethod.Get, "/users/@me/dms/search?q=$q")
            .decodeOrThrow<MessagesWrap>().messages
    }

    suspend fun listMyEvents(): List<com.zekktris.data.model.MyEventItem> =
        authorized(HttpMethod.Get, "/users/@me/events")
            .decodeOrThrow<com.zekktris.data.model.MyEventsWrap>().events

    // ---- discovery / invites / create guild ---------------------------------

    suspend fun listDiscoverable(query: String?, category: String?): List<DiscoverableGuild> {
        val q = buildList {
            if (!query.isNullOrBlank()) add("q=" + java.net.URLEncoder.encode(query, "UTF-8"))
            if (!category.isNullOrBlank()) add("category=" + java.net.URLEncoder.encode(category, "UTF-8"))
        }.joinToString("&")
        val path = if (q.isEmpty()) "/discovery" else "/discovery?$q"
        return authorized(HttpMethod.Get, path).decodeOrThrow<DiscoveryWrap>().guilds
    }

    suspend fun joinDiscoverable(guildId: String) {
        authorized(HttpMethod.Post, "/guilds/$guildId/discovery/join") {}
    }

    /** Public invite preview (bearer sent but not required). */
    suspend fun previewInvite(code: String): InvitePreview {
        val enc = java.net.URLEncoder.encode(code, "UTF-8")
        return authorized(HttpMethod.Get, "/invites/$enc").decodeOrThrow<InvitePreviewWrap>().invite
    }

    suspend fun acceptInvite(code: String): AcceptInviteResult {
        val enc = java.net.URLEncoder.encode(code, "UTF-8")
        return authorized(HttpMethod.Post, "/invites/$enc").decodeOrThrow<AcceptInviteResult>()
    }

    // ---- channel management + notification levels ----------------------------

    suspend fun createChannel(guildId: String, type: String, name: String, parentId: String? = null, topic: String? = null, linkUrl: String? = null): Channel {
        val body = buildJsonObject {
            put("type", JsonPrimitive(type)); put("name", JsonPrimitive(name))
            parentId?.let { put("parentId", JsonPrimitive(it)) }
            topic?.let { put("topic", JsonPrimitive(it)) }
            linkUrl?.let { put("linkUrl", JsonPrimitive(it)) }
        }
        return authorized(HttpMethod.Post, "/guilds/$guildId/channels") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<ChannelWrap>().channel
    }

    suspend fun deleteChannel(channelId: String) {
        authorized(HttpMethod.Delete, "/channels/$channelId") {}
    }

    // ---- threads + forums ----------------------------------------------------

    /** Active + archived threads (or forum posts) under a parent channel. */
    suspend fun listThreads(channelId: String): List<Channel> =
        authorized(HttpMethod.Get, "/channels/$channelId/threads").decodeOrThrow<com.zekktris.data.model.ThreadsWrap>().threads

    /** Start a thread off a message. Returns the new thread channel. */
    suspend fun createThread(channelId: String, messageId: String, name: String?): Channel {
        val body = buildJsonObject { name?.trim()?.ifBlank { null }?.let { put("name", JsonPrimitive(it)) } }
        return authorized(HttpMethod.Post, "/channels/$channelId/messages/$messageId/threads") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<ChannelWrap>().channel
    }

    /** Create a forum post (a thread + its opening message). */
    suspend fun createForumPost(forumChannelId: String, title: String, content: String): com.zekktris.data.model.ForumPostResult {
        val body = buildJsonObject { put("title", JsonPrimitive(title.trim())); put("content", JsonPrimitive(content.trim())) }
        return authorized(HttpMethod.Post, "/channels/$forumChannelId/posts") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<com.zekktris.data.model.ForumPostResult>()
    }

    suspend fun leaveGuild(guildId: String) {
        authorized(HttpMethod.Post, "/guilds/$guildId/leave") {}
    }

    suspend fun markGuildRead(guildId: String): List<ReadState> =
        authorized(HttpMethod.Post, "/guilds/$guildId/read").decodeOrThrow<ReadStatesWrap>().readStates

    /** All of my read-states. Used to reconcile unread dots + mention badges on
     *  foreground/resume: a cross-device read advances the server read-state with
     *  NO live event, and mention counts never arrive from live MESSAGE_CREATE. */
    suspend fun listReadStates(): List<ReadState> =
        authorized(HttpMethod.Get, "/users/@me/read-states").decodeOrThrow<ReadStatesWrap>().readStates

    suspend fun getNotificationOverrides(): List<com.zekktris.data.model.NotificationOverride> =
        authorized(HttpMethod.Get, "/users/@me/notification-settings").decodeOrThrow<com.zekktris.data.model.NotificationOverridesWrap>().overrides

    /** Upsert a notification override; level null clears it (explicit JSON null). */
    suspend fun setNotificationOverride(targetType: String, targetId: String, level: String?) {
        val body = buildJsonObject {
            put("targetType", JsonPrimitive(targetType)); put("targetId", JsonPrimitive(targetId))
            put("level", level?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        authorized(HttpMethod.Put, "/users/@me/notification-settings") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    suspend fun createGuild(name: String, description: String?): Guild {
        val resp = authorized(HttpMethod.Post, "/guilds") {
            contentType(ContentType.Application.Json)
            setBody(CreateGuildBody(name, description?.ifBlank { null }))
        }
        return resp.decodeOrThrow<CreateGuildResult>().guild
    }

    // ---- guild settings (owner / MANAGE_GUILD) -------------------------------

    /** Partial guild update. Only pass the fields being changed; a value of null
        for a nullable text field clears it (explicit JSON null). */
    suspend fun patchGuild(
        guildId: String,
        name: String? = null,
        description: JsonElement? = null,
        rulesContent: JsonElement? = null,
    ): Guild {
        val body = buildJsonObject {
            name?.let { put("name", JsonPrimitive(it)) }
            description?.let { put("description", it) }
            rulesContent?.let { put("rulesContent", it) }
        }
        return authorized(HttpMethod.Patch, "/guilds/$guildId") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<GuildWrap>().guild
    }

    /** Toggle server discovery + optional description/category. */
    suspend fun setGuildDiscovery(guildId: String, discoverable: Boolean, description: String?, category: String?): Guild {
        val body = buildJsonObject {
            put("discoverable", JsonPrimitive(discoverable))
            put("discoveryDescription", description?.let { JsonPrimitive(it) } ?: JsonNull)
            put("discoveryCategory", category?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        return authorized(HttpMethod.Patch, "/guilds/$guildId/discovery") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<GuildWrap>().guild
    }

    /** Owner-only hard delete of a guild. */
    suspend fun deleteGuild(guildId: String) {
        authorized(HttpMethod.Delete, "/guilds/$guildId") {}
    }

    /** Transfer ownership to another member. */
    suspend fun transferGuild(guildId: String, newOwnerId: String) {
        val body = buildJsonObject { put("newOwnerId", JsonPrimitive(newOwnerId)) }
        authorized(HttpMethod.Post, "/guilds/$guildId/transfer") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    private suspend fun uploadGuildImage(guildId: String, kind: String, filename: String, mime: String, bytes: ByteArray): Guild =
        authorized(HttpMethod.Post, "/guilds/$guildId/$kind") {
            setBody(
                MultiPartFormDataContent(
                    formData {
                        append(
                            "file", bytes,
                            Headers.build {
                                append(HttpHeaders.ContentType, mime)
                                append(HttpHeaders.ContentDisposition, "filename=\"$filename\"")
                            },
                        )
                    },
                ),
            )
        }.decodeOrThrow<GuildWrap>().guild

    suspend fun uploadGuildIcon(guildId: String, filename: String, mime: String, bytes: ByteArray): Guild =
        uploadGuildImage(guildId, "icon", filename, mime, bytes)

    suspend fun uploadGuildBanner(guildId: String, filename: String, mime: String, bytes: ByteArray): Guild =
        uploadGuildImage(guildId, "banner", filename, mime, bytes)

    // ---- channel + category management (MANAGE_CHANNELS) ---------------------

    /** Partial channel/category update. Only the passed fields are sent;
        nullable fields (topic/parentId) accept an explicit JSON null to clear. */
    suspend fun patchChannel(
        channelId: String,
        name: String? = null,
        topic: JsonElement? = null,
        parentId: JsonElement? = null,
        nsfw: Boolean? = null,
        rateLimitPerUser: Int? = null,
    ): Channel {
        val body = buildJsonObject {
            name?.let { put("name", JsonPrimitive(it)) }
            topic?.let { put("topic", it) }
            parentId?.let { put("parentId", it) }
            nsfw?.let { put("nsfw", JsonPrimitive(it)) }
            rateLimitPerUser?.let { put("rateLimitPerUser", JsonPrimitive(it)) }
        }
        return authorized(HttpMethod.Patch, "/channels/$channelId") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<ChannelWrap>().channel
    }

    /** Reorder channels/categories. Each entry is {id, position, parentId?};
        pass an explicit null parentId to drag a channel out of a category. */
    suspend fun reorderChannels(guildId: String, entries: List<Triple<String, Int, JsonElement?>>) {
        val body = buildJsonObject {
            put("channels", buildJsonArray {
                entries.forEach { (id, pos, parent) ->
                    add(buildJsonObject {
                        put("id", JsonPrimitive(id)); put("position", JsonPrimitive(pos))
                        parent?.let { put("parentId", it) }
                    })
                }
            })
        }
        authorized(HttpMethod.Patch, "/guilds/$guildId/channels/positions") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    // ---- profile + preferences ---------------------------------------------

    /** Change the account's date of birth (age-gated; server validates 13+). */
    suspend fun updateDateOfBirth(dateOfBirth: String): SelfUser =
        authorized(HttpMethod.Patch, "/users/@me/date-of-birth") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("dateOfBirth", JsonPrimitive(dateOfBirth)) }.toString())
        }.decodeOrThrow<UserWrap>().user

    /** Accept a server's rules. Until this lands the member stays 'pending'
     *  and the server refuses their messages with PENDING_ACKNOWLEDGMENT. */
    suspend fun acknowledgeOnboarding(guildId: String) {
        authorized(HttpMethod.Post, "/guilds/$guildId/onboarding/acknowledge") {}
    }

    /** Purge ALL messages in a text channel (MANAGE_MESSAGES). */
    suspend fun purgeChannel(channelId: String) {
        authorized(HttpMethod.Post, "/channels/$channelId/messages/purge") {}
    }

    // ---- roles (MANAGE_ROLES) ------------------------------------------------

    suspend fun createRole(guildId: String, name: String, color: Int, hoist: Boolean, mentionable: Boolean, permissions: String): com.zekktris.data.model.Role {
        val body = buildJsonObject {
            put("name", JsonPrimitive(name)); put("color", JsonPrimitive(color))
            put("hoist", JsonPrimitive(hoist)); put("mentionable", JsonPrimitive(mentionable))
            put("permissions", JsonPrimitive(permissions))
        }
        return authorized(HttpMethod.Post, "/guilds/$guildId/roles") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<com.zekktris.data.model.RoleWrap>().role
    }

    suspend fun patchRole(guildId: String, roleId: String, name: String, color: Int, hoist: Boolean, mentionable: Boolean, selfAssignable: Boolean, permissions: String): com.zekktris.data.model.Role {
        val body = buildJsonObject {
            put("name", JsonPrimitive(name)); put("color", JsonPrimitive(color))
            put("hoist", JsonPrimitive(hoist)); put("mentionable", JsonPrimitive(mentionable))
            put("selfAssignable", JsonPrimitive(selfAssignable)); put("permissions", JsonPrimitive(permissions))
        }
        return authorized(HttpMethod.Patch, "/guilds/$guildId/roles/$roleId") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<com.zekktris.data.model.RoleWrap>().role
    }

    suspend fun deleteRole(guildId: String, roleId: String) {
        authorized(HttpMethod.Delete, "/guilds/$guildId/roles/$roleId") {}
    }

    suspend fun reorderRoles(guildId: String, positions: List<Pair<String, Int>>) {
        val body = buildJsonObject {
            put("positions", buildJsonArray {
                positions.forEach { (id, pos) -> add(buildJsonObject { put("id", JsonPrimitive(id)); put("position", JsonPrimitive(pos)) }) }
            })
        }
        authorized(HttpMethod.Patch, "/guilds/$guildId/roles") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    // ---- member moderation (KICK/BAN/MODERATE_MEMBERS) -----------------------

    /** Kick a member (removes them; they can rejoin with an invite). */
    suspend fun kickMember(guildId: String, userId: String) {
        authorized(HttpMethod.Delete, "/guilds/$guildId/members/$userId") {}
    }

    /** Ban a member (reason optional). */
    suspend fun banMember(guildId: String, userId: String, reason: String?) {
        val body = buildJsonObject { put("reason", reason?.let { JsonPrimitive(it) } ?: JsonNull) }
        authorized(HttpMethod.Put, "/guilds/$guildId/bans/$userId") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    /** Time a member out until an ISO instant; null clears the timeout. */
    suspend fun timeoutMember(guildId: String, userId: String, until: String?): GuildMember {
        val body = buildJsonObject { put("communicationDisabledUntil", until?.let { JsonPrimitive(it) } ?: JsonNull) }
        return authorized(HttpMethod.Patch, "/guilds/$guildId/members/$userId") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<MemberWrap>().member
    }

    // ---- audit log + reports (moderator) -------------------------------------

    suspend fun auditLog(guildId: String, actionPrefix: String? = null): List<com.zekktris.data.model.AuditEntry> {
        var path = "/guilds/$guildId/audit-log?limit=50"
        if (!actionPrefix.isNullOrEmpty()) path += "&actionPrefix=${java.net.URLEncoder.encode(actionPrefix, "UTF-8")}"
        return authorized(HttpMethod.Get, path).decodeOrThrow<com.zekktris.data.model.AuditLogWrap>().entries
    }

    suspend fun listReports(guildId: String, status: String = "open"): com.zekktris.data.model.ReportsWrap =
        authorized(HttpMethod.Get, "/guilds/$guildId/reports?status=$status&limit=50").decodeOrThrow()

    /** Resolve/dismiss a report, optionally taking a moderation action
        ("none" | "ban" | "delete_message"). */
    suspend fun handleReport(guildId: String, reportId: String, action: String, moderation: String = "none"): com.zekktris.data.model.Report {
        val body = buildJsonObject {
            put("action", JsonPrimitive(action)); put("moderation", JsonPrimitive(moderation))
        }
        return authorized(HttpMethod.Patch, "/guilds/$guildId/reports/$reportId") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<com.zekktris.data.model.ReportWrap>().report
    }

    /** Replace a member's whole role set (server diffs add/remove). */
    suspend fun patchMemberRoles(guildId: String, userId: String, roleIds: List<String>): GuildMember {
        val body = buildJsonObject {
            put("roleIds", buildJsonArray { roleIds.forEach { add(JsonPrimitive(it)) } })
        }
        return authorized(HttpMethod.Patch, "/guilds/$guildId/members/$userId") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<MemberWrap>().member
    }

    // ---- self-assignable ("Get Roles") ---------------------------------------

    suspend fun listSelfAssignableRoles(guildId: String): List<com.zekktris.data.model.Role> =
        authorized(HttpMethod.Get, "/guilds/$guildId/self-assignable-roles").decodeOrThrow<com.zekktris.data.model.RolesWrap>().roles

    suspend fun addSelfRole(guildId: String, roleId: String) {
        authorized(HttpMethod.Put, "/guilds/$guildId/members/@me/roles/$roleId") {}
    }

    suspend fun removeSelfRole(guildId: String, roleId: String) {
        authorized(HttpMethod.Delete, "/guilds/$guildId/members/@me/roles/$roleId") {}
    }

    // ---- reaction roles (admin) ----------------------------------------------

    suspend fun listReactionRoles(guildId: String): List<com.zekktris.data.model.ReactionRoleMapping> =
        authorized(HttpMethod.Get, "/guilds/$guildId/reaction-roles").decodeOrThrow<com.zekktris.data.model.ReactionRolesWrap>().reactionRoles

    suspend fun addReactionRole(guildId: String, messageId: String, channelId: String, emoji: String, roleId: String) {
        val body = buildJsonObject {
            put("messageId", JsonPrimitive(messageId)); put("channelId", JsonPrimitive(channelId))
            put("emoji", JsonPrimitive(emoji)); put("roleId", JsonPrimitive(roleId))
        }
        authorized(HttpMethod.Put, "/guilds/$guildId/reaction-roles") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    suspend fun removeReactionRole(guildId: String, messageId: String, emoji: String) {
        val mid = java.net.URLEncoder.encode(messageId, "UTF-8")
        val em = java.net.URLEncoder.encode(emoji, "UTF-8")
        authorized(HttpMethod.Delete, "/guilds/$guildId/reaction-roles?messageId=$mid&emoji=$em") {}
    }

    // ---- channel permission overrides (MANAGE_ROLES/MANAGE_CHANNELS) ----------

    suspend fun listChannelPermissions(channelId: String): List<com.zekktris.data.model.PermissionOverride> =
        authorized(HttpMethod.Get, "/channels/$channelId/permissions").decodeOrThrow<com.zekktris.data.model.PermissionOverridesWrap>().overrides

    suspend fun setChannelPermission(channelId: String, targetId: String, type: String, allow: String, deny: String) {
        val body = buildJsonObject {
            put("type", JsonPrimitive(type)); put("allow", JsonPrimitive(allow)); put("deny", JsonPrimitive(deny))
        }
        authorized(HttpMethod.Put, "/channels/$channelId/permissions/$targetId") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    suspend fun deleteChannelPermission(channelId: String, targetId: String, type: String) {
        authorized(HttpMethod.Delete, "/channels/$channelId/permissions/$targetId?type=$type") {}
    }

    // ---- pinned messages -----------------------------------------------------

    suspend fun listPinnedMessages(channelId: String): List<Message> =
        authorized(HttpMethod.Get, "/channels/$channelId/pins").decodeOrThrow<MessagesWrap>().messages

    suspend fun pinMessage(channelId: String, messageId: String) {
        authorized(HttpMethod.Put, "/channels/$channelId/pins/$messageId") {}
    }

    suspend fun unpinMessage(channelId: String, messageId: String) {
        authorized(HttpMethod.Delete, "/channels/$channelId/pins/$messageId") {}
    }

    // ---- invites (create / manage) -------------------------------------------

    /** Mint a per-channel invite. maxUses/ttlSeconds null = unlimited / never
        (sent as explicit JSON null so the server doesn't apply a default). */
    suspend fun createInvite(channelId: String, maxUses: Int?, ttlSeconds: Int?): Invite {
        val body = buildJsonObject {
            put("maxUses", maxUses?.let { JsonPrimitive(it) } ?: JsonNull)
            put("ttlSeconds", ttlSeconds?.let { JsonPrimitive(it) } ?: JsonNull)
        }
        return authorized(HttpMethod.Post, "/channels/$channelId/invites") {
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }.decodeOrThrow<InviteWrap>().invite
    }

    suspend fun listGuildInvites(guildId: String): List<Invite> =
        authorized(HttpMethod.Get, "/guilds/$guildId/invites").decodeOrThrow<InvitesWrap>().invites

    suspend fun revokeInvite(code: String) {
        val enc = java.net.URLEncoder.encode(code, "UTF-8")
        authorized(HttpMethod.Delete, "/invites/$enc") {}
    }

    // ---- voice ----------------------------------------------------------------

    /** Join (or start) a call on a channel — returns the LiveKit token + wsUrl
        plus the current room roster. Same endpoint for guild voice + DM calls. */
    suspend fun joinVoice(channelId: String): JoinVoiceResult =
        authorized(HttpMethod.Post, "/channels/$channelId/voice/join") {}.decodeOrThrow()

    /** Sync self mute/deaf so peers see the badge. Only the set keys are sent. */
    suspend fun setVoiceState(channelId: String, selfMute: Boolean?, selfDeaf: Boolean?): VoiceState {
        val body = buildJsonObject {
            selfMute?.let { put("selfMute", JsonPrimitive(it)) }
            selfDeaf?.let { put("selfDeaf", JsonPrimitive(it)) }
        }
        return authorized(HttpMethod.Post, "/channels/$channelId/voice/state") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<VoiceStateWrap>().voiceState
    }

    suspend fun leaveVoice(channelId: String) {
        authorized(HttpMethod.Delete, "/channels/$channelId/voice") {}
    }

    suspend fun declineVoice(channelId: String) {
        authorized(HttpMethod.Post, "/channels/$channelId/voice/decline") {}
    }

    // ---- stage channels -------------------------------------------------------
    // Server routes: apps/api/src/routes/stage.ts (mounted at /channels).

    /** Current roster (speakers + audience) of a stage channel. */
    suspend fun listStageParticipants(channelId: String): StageParticipantsResult =
        authorized(HttpMethod.Get, "/channels/$channelId/stage").decodeOrThrow()

    /** Join the stage. The returned LiveKit token has publish=true only when
        `participant.isSpeaker` — re-call after a promotion/demotion to refresh. */
    suspend fun joinStage(channelId: String): StageJoinResult =
        authorized(HttpMethod.Post, "/channels/$channelId/stage/join") {}.decodeOrThrow()

    suspend fun leaveStage(channelId: String) {
        authorized(HttpMethod.Post, "/channels/$channelId/stage/leave") {}
    }

    /** Raise hand (request to speak). Audience-only; a no-op for speakers. */
    suspend fun raiseStageHand(channelId: String) {
        authorized(HttpMethod.Post, "/channels/$channelId/stage/hand") {}
    }

    suspend fun lowerStageHand(channelId: String) {
        authorized(HttpMethod.Delete, "/channels/$channelId/stage/hand") {}
    }

    /** Moderator promote/demote (server enforces MANAGE_CHANNELS). */
    suspend fun setStageSpeaker(channelId: String, userId: String, isSpeaker: Boolean) {
        val body = buildJsonObject {
            put("userId", JsonPrimitive(userId))
            put("isSpeaker", JsonPrimitive(isSpeaker))
        }
        authorized(HttpMethod.Post, "/channels/$channelId/stage/speakers") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    // ---- polls ----------------------------------------------------------------

    suspend fun voteOnPoll(channelId: String, pollId: String, optionId: String) {
        authorized(HttpMethod.Post, "/channels/$channelId/polls/$pollId/options/$optionId/vote") {}
    }

    suspend fun removePollVote(channelId: String, pollId: String, optionId: String) {
        authorized(HttpMethod.Delete, "/channels/$channelId/polls/$pollId/options/$optionId/vote") {}
    }

    /** Post a poll as a message (content empty; the poll rides in the body). */
    suspend fun sendPoll(channelId: String, question: String, options: List<String>, multipleChoice: Boolean, durationHours: Int, nonce: String): Message {
        val body = buildJsonObject {
            put("content", JsonPrimitive(""))
            put("nonce", JsonPrimitive(nonce))
            put("poll", buildJsonObject {
                put("question", JsonPrimitive(question))
                put("options", kotlinx.serialization.json.buildJsonArray { options.forEach { add(JsonPrimitive(it)) } })
                put("multipleChoice", kotlinx.serialization.json.JsonPrimitive(multipleChoice))
                put("durationHours", JsonPrimitive(durationHours))
            })
        }
        return authorized(HttpMethod.Post, "/channels/$channelId/messages") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }.decodeOrThrow<MessageWrap>().message
    }

    // ---- user profile / report ------------------------------------------------

    suspend fun getUserProfile(userId: String): com.zekktris.data.model.PublicUser =
        authorized(HttpMethod.Get, "/users/$userId").decodeOrThrow<com.zekktris.data.model.PublicUserWrap>().user

    /** Report a user to a guild's moderators. */
    suspend fun reportUser(guildId: String, targetId: String, reason: String, details: String) {
        val body = buildJsonObject {
            put("targetType", JsonPrimitive("user"))
            put("targetId", JsonPrimitive(targetId))
            put("reason", JsonPrimitive(reason))
            if (details.isNotBlank()) put("details", JsonPrimitive(details))
        }
        authorized(HttpMethod.Post, "/guilds/$guildId/reports") {
            contentType(ContentType.Application.Json); setBody(body.toString())
        }
    }

    // ---- family / parental controls -----------------------------------------

    suspend fun familyMe(): FamilySummary =
        authorized(HttpMethod.Get, "/family/me").decodeOrThrow()

    suspend fun familyRequestLink(username: String) {
        authorized(HttpMethod.Post, "/family/links") {
            contentType(ContentType.Application.Json); setBody(FamilyLinkBody(username))
        }
    }

    suspend fun familyRemoveLink(otherId: String) {
        authorized(HttpMethod.Delete, "/family/links/$otherId") {}
    }

    suspend fun familyAcceptLink(parentId: String) {
        authorized(HttpMethod.Post, "/family/links/$parentId/accept") {}
    }

    suspend fun familyRequestParent(email: String) {
        authorized(HttpMethod.Post, "/family/request-parent") {
            contentType(ContentType.Application.Json); setBody(RequestParentBody(email))
        }
    }

    suspend fun familyAcceptChild(childId: String) {
        authorized(HttpMethod.Post, "/family/child-requests/$childId/accept") {}
    }

    suspend fun childRestrictions(childId: String): ChildRestrictions =
        authorized(HttpMethod.Get, "/family/children/$childId/restrictions")
            .decodeOrThrow<FamilyRestrictionsWrap>().restrictions

    /** Full replace of a child's restriction toggles. Unlike iOS (which omits
        filterProfanity), we send it so "Blur swear words" actually persists. */
    suspend fun setChildRestrictions(childId: String, r: ChildRestrictions): ChildRestrictions {
        val resp = authorized(HttpMethod.Patch, "/family/children/$childId/restrictions") {
            contentType(ContentType.Application.Json); setBody(r)
        }
        return resp.decodeOrThrow<FamilyRestrictionsWrap>().restrictions
    }

    // ---- family child oversight ---------------------------------------------

    suspend fun familyWatchWords(childId: String): List<String> =
        authorized(HttpMethod.Get, "/family/children/$childId/watch-words").decodeOrThrow<com.zekktris.data.model.WatchWordsWrap>().words

    suspend fun addWatchWord(childId: String, word: String): List<String> =
        authorized(HttpMethod.Post, "/family/children/$childId/watch-words") {
            contentType(ContentType.Application.Json); setBody(com.zekktris.data.model.WatchWordBody(word))
        }.decodeOrThrow<com.zekktris.data.model.WatchWordsWrap>().words

    suspend fun removeWatchWord(childId: String, word: String): List<String> {
        val q = java.net.URLEncoder.encode(word, "UTF-8")
        return authorized(HttpMethod.Delete, "/family/children/$childId/watch-words?word=$q").decodeOrThrow<com.zekktris.data.model.WatchWordsWrap>().words
    }

    suspend fun familyChildFlags(childId: String): List<com.zekktris.data.model.FamilyFlag> =
        authorized(HttpMethod.Get, "/family/children/$childId/flags").decodeOrThrow<com.zekktris.data.model.FamilyFlagsWrap>().flags

    suspend fun markFlagReviewed(flagId: String) {
        authorized(HttpMethod.Post, "/family/flags/$flagId/reviewed") {}
    }

    suspend fun familyChildGuilds(childId: String): List<com.zekktris.data.model.ChildGuild> =
        authorized(HttpMethod.Get, "/family/children/$childId/guilds").decodeOrThrow<com.zekktris.data.model.ChildGuildsWrap>().guilds

    suspend fun familySetGuildBlocked(childId: String, guildId: String, blocked: Boolean) {
        if (blocked) authorized(HttpMethod.Post, "/family/children/$childId/blocked-guilds") {
            contentType(ContentType.Application.Json); setBody(buildJsonObject { put("guildId", JsonPrimitive(guildId)) }.toString())
        } else authorized(HttpMethod.Delete, "/family/children/$childId/blocked-guilds/$guildId") {}
    }

    suspend fun familyChildFriends(childId: String): List<com.zekktris.data.model.ChildRelationship> =
        authorized(HttpMethod.Get, "/family/children/$childId/friends").decodeOrThrow<com.zekktris.data.model.ChildRelationshipsWrap>().relationships

    suspend fun familySetUserBlocked(childId: String, userId: String, blocked: Boolean) {
        if (blocked) authorized(HttpMethod.Post, "/family/children/$childId/blocked-users") {
            contentType(ContentType.Application.Json); setBody(buildJsonObject { put("userId", JsonPrimitive(userId)) }.toString())
        } else authorized(HttpMethod.Delete, "/family/children/$childId/blocked-users/$userId") {}
    }

    // Read-only supervision of the child's 1:1 DM conversations.
    suspend fun familyChildDMs(childId: String): List<com.zekktris.data.model.ChildDM> =
        authorized(HttpMethod.Get, "/family/children/$childId/channels").decodeOrThrow<com.zekktris.data.model.ChildDMsWrap>().channels

    suspend fun familyChildDMMessages(childId: String, channelId: String, before: String? = null): List<com.zekktris.data.model.PeekMessage> {
        val path = "/family/children/$childId/channels/$channelId/messages?limit=50" + (before?.let { "&before=$it" } ?: "")
        return authorized(HttpMethod.Get, path).decodeOrThrow<com.zekktris.data.model.PeekMessagesWrap>().messages
    }

    // ---- admin instance -----------------------------------------------------

    suspend fun adminStats(): AdminStats =
        authorized(HttpMethod.Get, "/admin/stats").decodeOrThrow<AdminStatsWrap>().stats

    suspend fun adminMetrics(): InstanceMetrics =
        authorized(HttpMethod.Get, "/admin/metrics").decodeOrThrow<MetricsWrap>().metrics

    suspend fun adminUsers(query: String?, bannedOnly: Boolean): List<AdminUser> {
        val params = buildList {
            add("limit=50")
            if (!query.isNullOrBlank()) add("q=" + java.net.URLEncoder.encode(query, "UTF-8"))
            if (bannedOnly) add("bannedOnly=true")
        }.joinToString("&")
        return authorized(HttpMethod.Get, "/admin/users?$params").decodeOrThrow<AdminUsersWrap>().users
    }

    /**
     * [ADMIN ONLY] Who this user exchanges 1:1 DMs with, with friend status and
     * message counts. Never message content. Moderators cannot reach this: the
     * admin router's moderator allowlist is fail-safe and this route is
     * deliberately absent from it, so a mod gets 403.
     */
    suspend fun adminUserDmPeers(userId: String): AdminDmPeersWrap =
        authorized(HttpMethod.Get, "/admin/users/$userId/dm-peers").decodeOrThrow()

    suspend fun adminGuilds(query: String?): List<AdminGuild> {
        val q = if (query.isNullOrBlank()) "" else "&q=" + java.net.URLEncoder.encode(query, "UTF-8")
        return authorized(HttpMethod.Get, "/admin/guilds?limit=100$q").decodeOrThrow<AdminGuildsWrap>().guilds
    }

    suspend fun adminBanUser(userId: String, duration: String) {
        authorized(HttpMethod.Post, "/admin/users/$userId/ban") {
            contentType(ContentType.Application.Json); setBody(BanBody(duration))
        }
    }

    suspend fun adminUnbanUser(userId: String) {
        authorized(HttpMethod.Post, "/admin/users/$userId/unban") {}
    }

    suspend fun adminSetRole(userId: String, role: String) {
        authorized(HttpMethod.Post, "/admin/users/$userId/role") {
            contentType(ContentType.Application.Json); setBody(RoleBody(role))
        }
    }

    suspend fun adminDeleteUser(userId: String) {
        authorized(HttpMethod.Delete, "/admin/users/$userId") {}
    }

    suspend fun adminLogoutUser(userId: String) {
        authorized(HttpMethod.Post, "/admin/users/$userId/logout") {}
    }

    suspend fun adminResetDobLock(userId: String) {
        authorized(HttpMethod.Post, "/admin/users/$userId/reset-dob-lock") {}
    }

    suspend fun adminGiftSubscription(userId: String, tier: String, duration: String) {
        authorized(HttpMethod.Post, "/admin/users/$userId/subscription") {
            contentType(ContentType.Application.Json)
            setBody(buildJsonObject { put("tier", JsonPrimitive(tier)); put("duration", JsonPrimitive(duration)) }.toString())
        }
    }

    suspend fun adminRemoveSubscription(userId: String) {
        authorized(HttpMethod.Delete, "/admin/users/$userId/subscription") {}
    }

    suspend fun adminDeleteGuild(guildId: String) {
        authorized(HttpMethod.Delete, "/admin/guilds/$guildId") {}
    }

    suspend fun adminStorage(): AdminStorage =
        authorized(HttpMethod.Get, "/admin/storage").decodeOrThrow<AdminStorageWrap>().storage

    suspend fun adminStorageGc(): StorageGcResult =
        authorized(HttpMethod.Post, "/admin/storage/gc") {}.decodeOrThrow()

    suspend fun adminStorageItems(page: Int, sort: String): com.zekktris.data.model.StorageListing =
        authorized(HttpMethod.Get, "/admin/storage/items?page=$page&sort=$sort").decodeOrThrow()

    suspend fun adminDeleteStorageItem(id: String) {
        authorized(HttpMethod.Delete, "/admin/storage/items/$id") {}
    }

    suspend fun adminCompressStorageItem(id: String) {
        authorized(HttpMethod.Post, "/admin/storage/items/$id/compress") {}
    }

    // Ghost-mode observe: read a guild without joining.
    suspend fun adminPeekGuild(guildId: String): com.zekktris.data.model.PeekGuildResult =
        authorized(HttpMethod.Get, "/admin/guilds/$guildId/peek").decodeOrThrow()

    suspend fun adminPeekMessages(channelId: String, before: String? = null): List<com.zekktris.data.model.PeekMessage> {
        val path = "/admin/channels/$channelId/peek/messages?limit=50" + (before?.let { "&before=$it" } ?: "")
        return authorized(HttpMethod.Get, path).decodeOrThrow<com.zekktris.data.model.PeekMessagesWrap>().messages
    }

    // ---- admin security ------------------------------------------------------

    suspend fun adminSecurityEvents(kind: String?): List<com.zekktris.data.model.SecurityEvent> {
        val path = "/admin/security/events?limit=50" + (kind?.let { "&kind=$it" } ?: "")
        return authorized(HttpMethod.Get, path)
            .decodeOrThrow<com.zekktris.data.model.SecurityEventsWrap>().events
    }

    suspend fun adminSecurityConfig(): com.zekktris.data.model.SecurityConfig =
        authorized(HttpMethod.Get, "/admin/security/config")
            .decodeOrThrow<com.zekktris.data.model.SecurityConfigWrap>().config

    suspend fun adminPatchSecurityConfig(c: com.zekktris.data.model.SecurityConfig): com.zekktris.data.model.SecurityConfig =
        authorized(HttpMethod.Patch, "/admin/security/config") {
            contentType(ContentType.Application.Json); setBody(c)
        }.decodeOrThrow<com.zekktris.data.model.SecurityConfigWrap>().config

    suspend fun adminSecurityWords(): List<com.zekktris.data.model.SecurityWord> =
        authorized(HttpMethod.Get, "/admin/security/words")
            .decodeOrThrow<com.zekktris.data.model.SecurityWordsWrap>().words

    suspend fun adminAddSecurityWord(word: String, severity: String): List<com.zekktris.data.model.SecurityWord> =
        authorized(HttpMethod.Post, "/admin/security/words") {
            contentType(ContentType.Application.Json)
            setBody(com.zekktris.data.model.AddWordBody(word, severity))
        }.decodeOrThrow<com.zekktris.data.model.SecurityWordsWrap>().words

    suspend fun adminRemoveSecurityWord(word: String): List<com.zekktris.data.model.SecurityWord> =
        authorized(HttpMethod.Delete, "/admin/security/words/${percentEncode(word)}") {}
            .decodeOrThrow<com.zekktris.data.model.SecurityWordsWrap>().words

    /** Browse the server's common moderation wordlist (bare strings). */
    suspend fun adminSecurityWordPreset(): List<String> =
        authorized(HttpMethod.Get, "/admin/security/words/preset")
            .decodeOrThrow<com.zekktris.data.model.PresetWordsWrap>().words

    /** Bulk-add the whole preset. Insert-only; returns the refreshed full list. */
    suspend fun adminApplyWordPreset(): List<com.zekktris.data.model.SecurityWord> =
        authorized(HttpMethod.Post, "/admin/security/words/preset") {}
            .decodeOrThrow<com.zekktris.data.model.SecurityWordsWrap>().words

    // ---- monetization ---------------------------------------------------------

    /** On-demand LiveKit diagnostic (GET /admin/voice-diagnostic). */
    suspend fun adminVoiceDiagnostic(): com.zekktris.data.model.LivekitDiagnostic =
        authorized(HttpMethod.Get, "/admin/voice-diagnostic")
            .decodeOrThrow<com.zekktris.data.model.DiagnosticWrap>().diagnostic

    /** Admin Overview recent-activity feed (GET /admin/activity). */
    suspend fun adminActivity(): com.zekktris.data.model.AdminActivity =
        authorized(HttpMethod.Get, "/admin/activity")
            .decodeOrThrow<com.zekktris.data.model.AdminActivityWrap>().activity

    suspend fun getMonetization(): com.zekktris.data.model.MonetizationConfig =
        authorized(HttpMethod.Get, "/instance/monetization")
            .decodeOrThrow<com.zekktris.data.model.MonetizationConfigWrap>().config

    /** PUT the whole config. Cleared upload caps are sent as EXPLICIT nulls
        ("use the env default") — matching iOS/web; the server partial-writes. */
    suspend fun putMonetization(c: com.zekktris.data.model.MonetizationConfig): com.zekktris.data.model.MonetizationConfig {
        fun cap(v: Int?) = v?.let { JsonPrimitive(it) } ?: JsonNull
        val body = buildJsonObject {
            put("config", buildJsonObject {
                put("stream", buildJsonObject {
                    put("p1080", JsonPrimitive(c.stream.p1080)); put("k2", JsonPrimitive(c.stream.k2)); put("k4", JsonPrimitive(c.stream.k4))
                })
                put("camera", buildJsonObject {
                    put("p1080", JsonPrimitive(c.camera.p1080)); put("k2", JsonPrimitive(c.camera.k2)); put("k4", JsonPrimitive(c.camera.k4))
                })
                put("appearance", JsonPrimitive(c.appearance))
                put("uploadCapsMb", buildJsonObject {
                    put("free", cap(c.uploadCapsMb.free)); put("scout", cap(c.uploadCapsMb.scout))
                    put("guardian", cap(c.uploadCapsMb.guardian)); put("legend", cap(c.uploadCapsMb.legend))
                })
            })
        }
        val resp = authorized(HttpMethod.Put, "/admin/monetization") {
            contentType(ContentType.Application.Json)
            setBody(body.toString())
        }
        return resp.decodeOrThrow<com.zekktris.data.model.MonetizationConfigWrap>().config
    }

    private companion object {
        /**
         * Backoff ladder for a TRANSIENT refresh failure, in ms between
         * attempts (so four attempts, ~5.6 s of waiting before jitter).
         *
         * Kept deliberately short, for the same reason web and iOS keep it
         * short: when the api answers 409 the token we're presenting has been
         * superseded, and the server only reads that as benign concurrency for
         * a couple of minutes before it starts calling it token theft — a
         * client that kept retrying for minutes would talk itself into a
         * revoked session. Riding out an api restart or a momentary radio drop
         * fits comfortably inside that. Longer waits belong in the caller's
         * own outer loop (see AppStore.bootstrap), which re-presents a *fresh*
         * cookie each round.
         */
        val REFRESH_RETRY_DELAYS_MS = longArrayOf(400, 1_200, 4_000)

        /** Per-attempt timeout for `/auth/refresh` (client-wide default: 30 s). */
        const val REFRESH_TIMEOUT_MS = 10_000L

        /** How long a queued caller inherits a just-finished TRANSIENT answer
         *  instead of walking its own ladder. */
        const val REFRESH_TRANSIENT_COOLDOWN_MS = 5_000L
    }
}
