package com.zekktris.ui.theme

import androidx.compose.ui.graphics.Color
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.pow

/** The theme → notification colour mapping that the FCM and call services use
 *  outside composition (ThemePrefs.kt), and the contrast the themed mention
 *  badge relies on. Host-JVM: ZkPalette and Compose's Color are plain Kotlin. */
class ZkThemePrefsTest {
    /** Each family's accent, byte-exact to Theme.swift and the web's
     *  `--c-accent`; a family's navy and OLED ladders share it. */
    private val accents = listOf(
        listOf("default", "oled") to 0x3DD7EC,
        listOf("sunset", "sunset-oled") to 0xFF8A3D,
        listOf("forest", "forest-oled") to 0x3D9BFF,
        listOf("crimson", "crimson-oled") to 0xFF4D4D,
        listOf("blossom", "blossom-oled") to 0xFF5FA2,
        listOf("amethyst", "amethyst-oled") to 0xA855F7,
    )

    @Test fun everyThemeTintsNotificationsWithItsAccent() {
        for ((ids, rgb) in accents) for (id in ids) {
            assertEquals(id, 0xFF000000.toInt() or rgb, ZkThemePrefs.accentArgb(id))
        }
        // The table above covers every theme Settings offers.
        assertEquals(ZK_THEMES.map { it.first }.toSet(), accents.flatMap { it.first }.toSet())
    }

    @Test fun anUnknownThemeIdFallsBackToAbyssal() {
        assertEquals(0xFF3DD7EC.toInt(), ZkThemePrefs.accentArgb("nebula"))
        assertEquals(0xFF3DD7EC.toInt(), ZkThemePrefs.accentArgb(""))
    }

    /** The mention badge draws its count in bg0 on an accent→accent2 gradient,
     *  so both ends must clear WCAG AA for small text (4.5:1) in all 12 themes.
     *  White, the old count colour, doesn't (about 1.7:1 on Abyssal cyan). */
    @Test fun bg0CountTextIsReadableOnBothEndsOfTheBadgeGradient() {
        for ((id, _) in ZK_THEMES) {
            val p = ZkPalette.forId(id)
            for ((end, c) in listOf("accent" to p.accent, "accent2" to p.accent2)) {
                val ratio = contrast(p.bg0, c)
                assertTrue("$id: bg0 on $end is ${"%.2f".format(ratio)}:1", ratio >= 4.5)
            }
        }
        assertTrue(contrast(Color.White, ZkPalette.forId("default").accent) < 4.5)
    }

    /** WCAG 2 relative luminance of an sRGB colour. */
    private fun luminance(c: Color): Double {
        fun lin(v: Float): Double = if (v <= 0.03928f) v / 12.92 else ((v + 0.055) / 1.055).pow(2.4)
        return 0.2126 * lin(c.red) + 0.7152 * lin(c.green) + 0.0722 * lin(c.blue)
    }

    private fun contrast(a: Color, b: Color): Double {
        val la = luminance(a)
        val lb = luminance(b)
        return (maxOf(la, lb) + 0.05) / (minOf(la, lb) + 0.05)
    }
}
