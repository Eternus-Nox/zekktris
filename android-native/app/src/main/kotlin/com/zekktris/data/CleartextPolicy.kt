package com.zekktris.data

import okhttp3.Interceptor
import okhttp3.OkHttpClient
import java.io.IOException
import java.net.URI

/**
 * The code half of network_security_config.xml. That file has to permit
 * cleartext app-wide — it can't be scoped to IP ranges — so a home server at
 * http://192.168.1.20:5550 works. [Config.normalizeOrigin] only gates the server
 * address the user types; every URL the server hands back (attachments,
 * avatars, link-preview images, the LiveKit wsUrl, redirects) is checked here
 * instead: plain http:// / ws:// is only ever used for a local-network host
 * ([Config.isLocalHost]). Everything on the internet has to be https / wss.
 *
 * Enforced on every client the app drives: the Ktor/OkHttp API + gateway client
 * ([ApiClient]), Coil's image loader (ZekApp), LiveKit's signalling socket
 * (VoiceManager) via [install] / [okHttpClient], and the media players
 * (VideoPlayerDialog, VoiceMessageView) via [allows].
 */
object CleartextPolicy {

    /** False for an http:// or ws:// [url] whose host is not on the local
     *  network (or can't be parsed). Any other scheme passes — https/wss, and
     *  non-network URIs that never reach an HTTP stack. */
    fun allows(url: String): Boolean {
        val scheme = url.substringBefore(':', "").lowercase()
        if (scheme != "http" && scheme != "ws") return true
        val host = runCatching { URI(url).host }.getOrNull()?.lowercase() ?: return false
        return Config.isLocalHost(host)
    }

    /** Thrown (as an IOException, so OkHttp fails just that call) for a refused
     *  cleartext request. */
    class Refused(host: String) :
        IOException("Refusing cleartext HTTP to $host — only a local-network server may use http://")

    /** A ws:// URL reaches OkHttp as http://, so websockets are covered too. */
    private val interceptor = Interceptor { chain ->
        val url = chain.request().url
        if (!url.isHttps && !Config.isLocalHost(url.host.lowercase())) throw Refused(url.host)
        chain.proceed(chain.request())
    }

    /** Guard an OkHttp client. As an application interceptor it refuses the
     *  request before any connection is opened; as a network interceptor it
     *  also sees every redirect hop, before any request bytes (cookies,
     *  Authorization) are written to it. */
    fun install(builder: OkHttpClient.Builder): OkHttpClient.Builder =
        builder.addInterceptor(interceptor).addNetworkInterceptor(interceptor)

    /** A plain guarded OkHttp client, shared by Coil and LiveKit (one
     *  connection pool rather than one per call). */
    val okHttpClient: OkHttpClient by lazy { install(OkHttpClient.Builder()).build() }
}
