package com.zekktris.ui.screens

import android.content.Context

/**
 * Per-channel composer drafts, mirroring the iOS behaviour: what you were
 * half-way through typing survives leaving the conversation and killing the
 * app, and comes back when you reopen it.
 *
 * Stored in the same `zk_prefs` file every other device-local preference uses,
 * under one key per channel. Written on every change rather than on teardown
 * because Android can kill the process from the recents switcher with no
 * lifecycle callback — the exact case a draft needs to survive.
 *
 * PRIVACY, same as iOS: a draft for an E2EE conversation sits here in
 * plaintext. It is app-private storage, and comparable to what the keyboard's
 * own autocorrect store already holds, but it is plaintext on disk — which is
 * why an emptied draft REMOVES its key instead of storing "".
 */
object Drafts {
    private const val PREFIX = "zk.draft."

    private fun prefs(ctx: Context) =
        ctx.getSharedPreferences("zk_prefs", Context.MODE_PRIVATE)

    fun load(ctx: Context, channelId: String): String =
        if (channelId.isEmpty()) "" else prefs(ctx).getString(PREFIX + channelId, "").orEmpty()

    fun save(ctx: Context, channelId: String, text: String) {
        if (channelId.isEmpty()) return
        val e = prefs(ctx).edit()
        // Blank means "no draft". Removing rather than storing "" keeps the
        // prefs file from accumulating an entry per conversation ever opened,
        // and leaves nothing behind once you have sent or cleared what you had.
        if (text.isBlank()) e.remove(PREFIX + channelId) else e.putString(PREFIX + channelId, text)
        e.apply()
    }

    /** Drop every stored draft — sign-out, so one account's half-typed messages
     *  are not sitting there for the next person to sign in on this device. */
    fun clearAll(ctx: Context) {
        val p = prefs(ctx)
        val e = p.edit()
        for (k in p.all.keys) if (k.startsWith(PREFIX)) e.remove(k)
        e.apply()
    }
}
