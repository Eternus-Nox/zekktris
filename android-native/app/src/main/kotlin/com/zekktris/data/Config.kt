package com.zekktris.data

import android.content.Context
import android.content.SharedPreferences
import java.net.InetAddress
import java.net.URI

// Endpoint configuration. Mirrors ios-native/Zekktris/Config.swift: a native app
// has no same-origin, so it keeps the server's address here. It defaults to
// zekktris.com, and anyone running their own Zekktris server can point the app
// at it from the welcome screen (ServerPickerDialog). The web client instead
// talks to a same-origin /api/v1.
object Config {
    /** The hosted server every install starts on. */
    const val DEFAULT_ORIGIN = "https://zekktris.com"

    private const val PREFS = "zk_server"
    private const val KEY_ORIGIN = "origin"

    @Volatile private var prefs: SharedPreferences? = null

    /** "scheme://host[:port]" with no trailing slash. */
    @Volatile var serverOrigin: String = DEFAULT_ORIGIN
        private set

    /** Load the saved server. Call once, first thing in Application.onCreate. */
    fun init(context: Context) {
        val p = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
        prefs = p
        serverOrigin = p.getString(KEY_ORIGIN, null)?.takeIf { it.isNotBlank() } ?: DEFAULT_ORIGIN
    }

    /** Point the app at another server (null = back to zekktris.com). Only
     *  while signed out — a session belongs to the server that issued it. */
    fun setServerOrigin(origin: String?) {
        val next = origin?.takeIf { it.isNotBlank() } ?: DEFAULT_ORIGIN
        serverOrigin = next
        prefs?.edit()?.apply {
            if (next == DEFAULT_ORIGIN) remove(KEY_ORIGIN) else putString(KEY_ORIGIN, next)
        }?.apply()
    }

    val isDefaultServer: Boolean get() = serverOrigin == DEFAULT_ORIGIN

    /** Host only — the cookie jar's domain. */
    val host: String get() = runCatching { URI(serverOrigin).host }.getOrNull() ?: "zekktris.com"

    /** Host (and port when it isn't the default) for display. */
    val serverDisplayName: String
        get() {
            val u = runCatching { URI(serverOrigin) }.getOrNull() ?: return serverOrigin
            return if (u.port != -1) "${u.host}:${u.port}" else (u.host ?: serverOrigin)
        }

    val API_BASE_URL: String get() = "$serverOrigin/api/v1"
    val GATEWAY_URL: String
        get() = if (serverOrigin.startsWith("http://")) "ws://" + serverOrigin.removePrefix("http://") + "/gateway"
        else "wss://" + serverOrigin.removePrefix("https://") + "/gateway"
    val CDN_BASE_URL: String get() = serverOrigin

    // Prefix a relative /cdn/... or /uploads/... path with the asset origin.
    fun absoluteUrl(path: String?): String? {
        if (path.isNullOrBlank()) return null
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        if (path.startsWith("/")) return CDN_BASE_URL + path
        return path
    }

    /**
     * Turn what someone typed ("chat.example.com", "203.0.113.5",
     * "https://chat.example.com:8443/", "http://192.168.1.20:5550") into an
     * origin. No scheme → https. Plain http is only accepted for a server on
     * the local network (private / link-local IPs, localhost, *.local) — the
     * app allows cleartext traffic for exactly that case. This keeps the
     * server address itself on HTTPS; [CleartextPolicy] applies the same rule
     * to every URL the server hands back.
     */
    fun normalizeOrigin(input: String): String? {
        var text = input.trim()
        if (text.isEmpty()) return null
        if (!text.contains("://")) text = "https://$text"
        val u = runCatching { URI(text) }.getOrNull() ?: return null
        val scheme = u.scheme?.lowercase() ?: return null
        if (scheme != "https" && scheme != "http") return null
        val host = u.host?.lowercase()?.takeIf { it.isNotEmpty() } ?: return null
        if (scheme == "http" && !isLocalHost(host)) return null
        val port = if (u.port != -1) ":${u.port}" else ""
        return "$scheme://$host$port"
    }

    /** True for hosts only reachable on the local network. Never resolves
     *  DNS — names other than localhost / *.local count as public. */
    fun isLocalHost(host: String): Boolean {
        if (host == "localhost" || host.endsWith(".local")) return true
        // Only literal IPs (dotted IPv4, or IPv6 which always has a colon):
        // getByName on a literal never touches the network.
        val literal = host.removePrefix("[").removeSuffix("]")
        val isV4 = Regex("""^\d{1,3}(\.\d{1,3}){3}$""").matches(literal)
        val isV6 = literal.contains(':') && literal.all { it.isDigit() || it == ':' || it == '.' || it.lowercaseChar() in 'a'..'f' }
        if (!isV4 && !isV6) return false
        val addr = runCatching { InetAddress.getByName(literal) }.getOrNull() ?: return false
        return addr.isSiteLocalAddress || addr.isLinkLocalAddress || addr.isLoopbackAddress ||
            // IPv6 unique-local fc00::/7 (isSiteLocalAddress only covers the old fec0::/10).
            (addr.address.size == 16 && (addr.address[0].toInt() and 0xfe) == 0xfc)
    }
}
