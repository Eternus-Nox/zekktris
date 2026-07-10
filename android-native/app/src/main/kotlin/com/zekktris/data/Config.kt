package com.zekktris.data

// Endpoint configuration. Mirrors ios-native/Zekktris/Config.swift: a native app
// has no same-origin, so the absolute host is hard-coded. The web client instead
// talks to a same-origin /api/v1.
object Config {
    const val API_BASE_URL = "https://zekktris.com/api/v1"
    const val GATEWAY_URL = "wss://zekktris.com/gateway"
    const val CDN_BASE_URL = "https://zekktris.com"

    // Prefix a relative /cdn/... or /uploads/... path with the asset origin.
    fun absoluteUrl(path: String?): String? {
        if (path.isNullOrBlank()) return null
        if (path.startsWith("http://") || path.startsWith("https://")) return path
        if (path.startsWith("/")) return CDN_BASE_URL + path
        return path
    }
}
