package com.zekktris.ui.theme

import android.content.Context
import android.content.SharedPreferences
import androidx.compose.ui.graphics.toArgb

/**
 * The device-local theme choice, for code that runs outside composition (the
 * FCM service that posts notifications, the call foreground service) and so
 * can't read [ZkTheme.palette]. MainActivity's [ThemeController] writes the id
 * here with `apply()` and IncomingCallActivity reads it the same way. The app
 * is one process, so a reader after a switch sees the new id at once.
 */
object ZkThemePrefs {
    /** The SharedPreferences file every device-local preference lives in. */
    const val FILE = "zk_prefs"

    /** The theme id: "default", "oled", "sunset", "sunset-oled"… ([ZK_THEMES]). */
    const val KEY = "zk.theme"

    const val DEFAULT_ID = "default"

    fun prefs(context: Context): SharedPreferences =
        context.getSharedPreferences(FILE, Context.MODE_PRIVATE)

    fun themeId(context: Context): String =
        prefs(context).getString(KEY, DEFAULT_ID) ?: DEFAULT_ID

    /**
     * The theme's accent as ARGB, for NotificationCompat.Builder.setColor. A
     * notification takes one colour, so this is the solid accent: the
     * accent→accent2 gradient of the in-app surfaces can't reach the shade.
     * Android may adjust it for contrast against the shade, keeping the hue.
     */
    fun accentArgb(themeId: String): Int = ZkPalette.forId(themeId).accent.toArgb()

    fun accentArgb(context: Context): Int = accentArgb(themeId(context))
}
