package com.zekktris.data

import com.zekktris.data.model.AckWrap
import com.zekktris.data.model.AuthResponse
import com.zekktris.data.model.Channel
import com.zekktris.data.model.ChannelWrap
import com.zekktris.data.model.ChannelsWrap
import com.zekktris.data.model.DeviceTokenBody
import com.zekktris.data.model.Guild
import com.zekktris.data.model.GuildMember
import com.zekktris.data.model.GuildsWrap
import com.zekktris.data.model.LoginRequest
import com.zekktris.data.model.Message
import com.zekktris.data.model.MembersWrap
import com.zekktris.data.model.MessageWrap
import com.zekktris.data.model.MessagesWrap
import com.zekktris.data.model.OpenDMBody
import com.zekktris.data.model.ReadState
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
import io.ktor.client.plugins.websocket.WebSockets
import io.ktor.client.request.HttpRequestBuilder
import io.ktor.client.request.accept
import io.ktor.client.request.header
import io.ktor.client.request.request
import io.ktor.client.request.setBody
import io.ktor.client.statement.HttpResponse
import io.ktor.client.statement.bodyAsText
import io.ktor.http.ContentType
import io.ktor.http.HttpHeaders
import io.ktor.http.HttpMethod
import io.ktor.http.HttpStatusCode
import io.ktor.http.contentType
import io.ktor.serialization.kotlinx.json.json
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.Json

// Result of an attempted login: 2FA is not an error, it's a follow-up prompt.
sealed class LoginResult {
    data class Success(val user: SelfUser) : LoginResult()
    data object Requires2FA : LoginResult()
    data class Failure(val message: String) : LoginResult()
}

class ApiException(val status: Int, message: String) : Exception(message)

// REST client for the Zekktris API. Mirrors ios-native APIClient.swift: the
// short-lived access JWT is held in memory and attached as `Authorization:
// Bearer`; the refresh token rides in the persistent httpOnly cookie jar. On any
// 401 from an authorized call we refresh once (serialized) and replay.
class ApiClient(cookieStorage: PersistentCookieStorage) {

    @Volatile
    var accessToken: String? = null
        private set

    private val refreshMutex = Mutex()

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

    /** Return a usable access token, refreshing via the cookie if we don't hold one. */
    suspend fun ensureAccessToken(): String? {
        accessToken?.let { return it }
        return if (refreshAccessToken()) accessToken else null
    }

    /**
     * Exchange the refresh cookie for a fresh access token. Serialized so
     * concurrent 401s don't double-rotate the cookie (which the server treats as
     * reuse and revokes). If the token already changed while we waited, another
     * caller refreshed — reuse it.
     */
    suspend fun refreshAccessToken(): Boolean {
        val before = accessToken
        return refreshMutex.withLock {
            if (accessToken != null && accessToken != before) return@withLock true
            val resp = http.request(url("/auth/refresh")) {
                method = HttpMethod.Post
                accept(ContentType.Application.Json)
            }
            if (resp.status == HttpStatusCode.OK) {
                accessToken = resp.body<RefreshResponse>().accessToken
                true
            } else {
                accessToken = null
                false
            }
        }
    }

    // ---- request core -------------------------------------------------------

    private suspend fun authorized(
        method: HttpMethod,
        path: String,
        block: HttpRequestBuilder.() -> Unit = {},
    ): HttpResponse {
        var resp = send(method, path, accessToken, block)
        if (resp.status == HttpStatusCode.Unauthorized) {
            if (refreshAccessToken()) {
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

    suspend fun listGuilds(): List<Guild> =
        authorized(HttpMethod.Get, "/guilds").decodeOrThrow<GuildsWrap>().guilds

    suspend fun listChannels(guildId: String): List<Channel> =
        authorized(HttpMethod.Get, "/guilds/$guildId/channels").decodeOrThrow<ChannelsWrap>().channels

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

    suspend fun sendMessage(
        channelId: String,
        content: String,
        nonce: String? = null,
        replyToId: String? = null,
    ): Message {
        val resp = authorized(HttpMethod.Post, "/channels/$channelId/messages") {
            contentType(ContentType.Application.Json)
            setBody(SendMessageBody(content, nonce, replyToId))
        }
        return resp.decodeOrThrow<MessageWrap>().message
    }

    suspend fun ackMessage(channelId: String, messageId: String): ReadState =
        authorized(HttpMethod.Post, "/channels/$channelId/messages/$messageId/ack")
            .decodeOrThrow<AckWrap>().readState

    // ---- push tokens --------------------------------------------------------

    /**
     * Register this device's FCM token for push. Best-effort: the server 503s
     * for platform=android until its FCM_* env vars are set, and 401s if we've
     * lost the session — both are swallowed by the caller.
     */
    suspend fun registerDeviceToken(token: String, label: String? = null) {
        authorized(HttpMethod.Post, "/users/@me/device-tokens") {
            contentType(ContentType.Application.Json)
            setBody(DeviceTokenBody(token = token, platform = "android", label = label))
        }
    }

    /** Remove this device's token (on sign-out). FCM tokens are path-safe
        (no `/`), so the raw value is a valid path segment. */
    suspend fun deleteDeviceToken(token: String) {
        authorized(HttpMethod.Delete, "/users/@me/device-tokens/$token") {}
    }
}
