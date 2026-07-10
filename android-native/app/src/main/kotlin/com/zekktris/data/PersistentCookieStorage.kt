package com.zekktris.data

import androidx.datastore.core.DataStore
import androidx.datastore.preferences.core.Preferences
import androidx.datastore.preferences.core.edit
import androidx.datastore.preferences.core.emptyPreferences
import androidx.datastore.preferences.core.stringPreferencesKey
import io.ktor.client.plugins.cookies.AcceptAllCookiesStorage
import io.ktor.client.plugins.cookies.CookiesStorage
import io.ktor.http.Cookie
import io.ktor.http.CookieEncoding
import io.ktor.http.Url
import io.ktor.util.date.GMTDate
import kotlinx.coroutines.flow.catch
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json

// A Ktor CookiesStorage that persists to DataStore so the httpOnly
// `zekktris_refresh` cookie survives app restarts. Without this the refresh
// endpoint 401s on relaunch and the user is forced to re-login.
//
// In-memory matching/expiry is delegated to Ktor's AcceptAllCookiesStorage; we
// snapshot its cookies for our host to disk after every mutation, and re-seed it
// on first use.
class PersistentCookieStorage(
    private val ds: DataStore<Preferences>,
) : CookiesStorage {

    private val delegate = AcceptAllCookiesStorage()
    private val json = Json { ignoreUnknownKeys = true }
    private val mutex = Mutex()
    @Volatile private var loaded = false

    @Serializable
    private data class Stored(
        val name: String,
        val value: String,
        val domain: String,
        val path: String,
        val expiresMs: Long? = null,
    )

    private suspend fun ensureLoaded() {
        if (loaded) return
        mutex.withLock {
            if (loaded) return
            // A corrupt prefs file or disk-full makes DataStore's flow throw; if
            // that reached Ktor's cookie pipeline it would break EVERY request.
            // Degrade to a fresh (empty) jar instead.
            val raw = ds.data.catch { emit(emptyPreferences()) }.first()[KEY]
            if (raw != null) {
                val now = System.currentTimeMillis()
                runCatching { json.decodeFromString<List<Stored>>(raw) }.getOrNull()?.forEach { s ->
                    if (s.expiresMs == null || s.expiresMs > now) {
                        val cookie = Cookie(
                            name = s.name,
                            value = s.value,
                            encoding = CookieEncoding.RAW,
                            domain = s.domain,
                            path = s.path,
                            expires = s.expiresMs?.let { GMTDate(it) },
                        )
                        delegate.addCookie(Url("https://${s.domain}${s.path}"), cookie)
                    }
                }
            }
            loaded = true
        }
    }

    override suspend fun get(requestUrl: Url): List<Cookie> {
        ensureLoaded()
        return delegate.get(requestUrl)
    }

    override suspend fun addCookie(requestUrl: Url, cookie: Cookie) {
        ensureLoaded()
        delegate.addCookie(requestUrl, cookie)
        persist()
    }

    private suspend fun persist() {
        // get() filters out expired/deleted cookies, so a logout (Max-Age=0)
        // cookie is naturally dropped from what we write to disk.
        val cookies = delegate.get(Url(REFRESH_URL))
        val stored = cookies.map { c ->
            // zekktris_refresh is set via Max-Age (no Expires), so derive expiry
            // from maxAge when Expires is absent — else it persists as a
            // never-expiring session cookie. Guard >0 (0/null = unset).
            val ma = c.maxAge
            val expiresMs = c.expires?.timestamp
                ?: if (ma != null && ma > 0) System.currentTimeMillis() + ma * 1000L else null
            Stored(
                name = c.name,
                value = c.value,
                domain = (c.domain ?: HOST).trimStart('.').lowercase(),
                path = c.path ?: "/",
                expiresMs = expiresMs,
            )
        }
        // A failed persist (e.g. disk-full) must not abort the request that just
        // succeeded server-side (login would report failure though the session
        // was issued). Best-effort only.
        runCatching { ds.edit { it[KEY] = json.encodeToString(stored) } }
    }

    override fun close() = delegate.close()

    companion object {
        private const val HOST = "zekktris.com"
        private const val REFRESH_URL = "https://zekktris.com/api/v1/auth/refresh"
        private val KEY = stringPreferencesKey("cookie_jar")
    }
}
