package com.zekktris.ui.theme

import androidx.compose.runtime.Immutable
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.graphics.Color

/**
 * Zekktris design tokens — a faithful port of ios-native/Zekktris/Theme.swift
 * (which itself mirrors the web app's `--c-*` / `--zk-*` CSS variables). Hex
 * values are byte-exact to the iOS/web sources so the three clients look alike.
 *
 * Surfaces + accents come from the active [ZkPalette] (theme-selectable, 6
 * accent schemes × navy/OLED ladders). Ink, status, plasma, and aurora colors
 * are shared across every theme.
 */

/** Accent trio + soft variant for one scheme (matches ThemePalette.Accents). */
@Immutable
data class ZkAccents(val a1: Color, val a2: Color, val a3: Color, val soft: Color)

private fun hex(v: Long): Color = Color(0xFF000000 or v)

/** The 6 accent schemes, keyed by base name — byte-exact to Theme.swift. */
val ZkAccentSchemes: Map<String, ZkAccents> = mapOf(
    "default"  to ZkAccents(hex(0x3DD7EC), hex(0x9D7BFF), hex(0xEC5FB5), hex(0x2DB6C8)),
    "sunset"   to ZkAccents(hex(0xFF8A3D), hex(0xFFD13D), hex(0xFF7A7A), hex(0xE0702A)),
    "forest"   to ZkAccents(hex(0x3D9BFF), hex(0x4FDD8F), hex(0x3DD8C0), hex(0x2D7FE0)),
    "crimson"  to ZkAccents(hex(0xFF4D4D), hex(0x9AA3B8), hex(0xFF8080), hex(0xE03A3A)),
    "blossom"  to ZkAccents(hex(0xFF5FA2), hex(0xFFB088), hex(0xFF9ECF), hex(0xE0468A)),
    "amethyst" to ZkAccents(hex(0xA855F7), hex(0xF5B942), hex(0xD8A7FF), hex(0x8B3FD6)),
)

/** Palette-driven surfaces + accents + line. */
@Immutable
data class ZkPalette(
    val bg0: Color, val bg1: Color, val bg2: Color, val bg3: Color,
    val line: Color, val lineSoft: Color,
    val accent: Color, val accentSoft: Color, val accent2: Color, val accent3: Color,
) {
    companion object {
        private val lineSoftFixed = Color(0x2E556380) // #556380 @ 0.18

        /** Resolve a theme id ("sunset", "oled", "amethyst-oled", …) → palette. */
        fun forId(id: String): ZkPalette {
            val oled = id == "oled" || id.endsWith("-oled")
            val schemeKey = when {
                id == "oled" || id == "default" -> "default"
                else -> id.removeSuffix("-oled")
            }
            val acc = ZkAccentSchemes[schemeKey] ?: ZkAccentSchemes["default"]!!
            return if (oled) ZkPalette(
                bg0 = hex(0x000000), bg1 = hex(0x06080C),
                bg2 = hex(0x0D1017), bg3 = hex(0x161B26),
                line = hex(0x242B3C), lineSoft = lineSoftFixed,
                accent = acc.a1, accentSoft = acc.soft, accent2 = acc.a2, accent3 = acc.a3,
            ) else ZkPalette(
                bg0 = hex(0x0A0F1C), bg1 = hex(0x0E1422),
                bg2 = hex(0x131A2A), bg3 = hex(0x1C2438),
                line = hex(0x2A3450), lineSoft = lineSoftFixed,
                accent = acc.a1, accentSoft = acc.soft, accent2 = acc.a2, accent3 = acc.a3,
            )
        }
    }
}

/** Shared, theme-independent tokens (ink, status, plasma, aurora, radii). */
object ZkInk {
    val ink1 = hex(0xF3F6FA)
    val ink2 = hex(0xB5BECF)
    val ink3 = hex(0x7A849A)
    val ink4 = hex(0x454D5E)
}

object ZkStatus {
    val danger = hex(0xEF4444)
    val dangerSoft = hex(0xF87171)
    val warning = hex(0xF59E0B)
    val online = hex(0x10B981)
    val idle = hex(0xF59E0B)
    val dnd = hex(0xEF4444)
    val offline = ZkInk.ink3
    val success = hex(0x34D399)
}

/** Fixed plasma accents (glow/pulse) + abyss aurora tints. */
object ZkFx {
    val plasmaCyan = hex(0x00DDFF)
    val plasmaViolet = hex(0xA688FF)
    val plasmaMagenta = hex(0xF363DA)
    val plasmaLime = hex(0x89F670)
    val plasmaAmber = hex(0xFFB000)
    val plasmaRose = hex(0xFF5B59)

    val auroraViolet = Color(0x2E764BE5)  // #764BE5 @ 0.18
    val auroraCyan = Color(0x2900B7E3)     // #00B7E3 @ 0.16
    val auroraMagenta = Color(0x1FDA4BC3)  // #DA4BC3 @ 0.12
    val auroraTeal = Color(0x1A00BEC1)     // #00BEC1 @ 0.10
    val starlight = hex(0xEBEEF5)
}

/** Active palette, provided by [ZkTheme]; read via [ZkTheme.palette]. */
val LocalZkPalette = staticCompositionLocalOf { ZkPalette.forId("default") }
