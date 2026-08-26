package com.zekktris.ui.theme

import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable
import androidx.compose.runtime.staticCompositionLocalOf

/**
 * ZkTheme — the app's theme wrapper (the Compose analog of using Theme.swift).
 * Provides the active [ZkPalette] plus a Material3 dark color scheme derived
 * from it, so both hand-styled surfaces (via [ZkTheme.palette]) and stock
 * Material components read the same colors.
 *
 * Zekktris is a deliberately dark, single-world "cosmic" app (like the iOS
 * client), so there is no light scheme — only the navy/OLED ladders.
 */
object ZkTheme {
    val palette: ZkPalette
        @Composable @ReadOnlyComposable get() = LocalZkPalette.current
}

/**
 * The active theme id + a setter, provided from the Activity. Theme selection
 * is device-local (SharedPreferences "zk.theme"), mirroring the iOS client's
 * local `UserDefaults "zk.theme"` — it is a cosmetic, per-device choice, not a
 * synced account field. Settings reads/writes it through this controller.
 */
class ThemeController(val themeId: String, val setTheme: (String) -> Unit)

val LocalThemeController = staticCompositionLocalOf { ThemeController("default") {} }

/** Viewer-side "Hide clan tags" declutter toggle (device-local, mirrors the iOS
 *  `@AppStorage("zk.hideClanTags")`). Provided from the Activity; NameTag reads
 *  it to hide every self-typed tag pill when on. */
class HideTagsController(val enabled: Boolean, val setEnabled: (Boolean) -> Unit)

val LocalHideTags = staticCompositionLocalOf { HideTagsController(false) {} }

/** Biometric app-lock state, driven by the Activity (needs it for the prompt +
 *  lifecycle). `setEnabled(true)` verifies a biometric first so the user can't
 *  lock themselves out; `unlock()` fails open if biometrics are unavailable. */
class AppLockController(
    val enabled: Boolean,
    val supported: Boolean,
    val setEnabled: (Boolean) -> Unit,
    val unlock: () -> Unit,
)

val LocalAppLock = staticCompositionLocalOf { AppLockController(false, false, {}, {}) }

/** The 12 selectable themes (id → display label), matching iOS `ZKThemes`. */
val ZK_THEMES: List<Pair<String, String>> = listOf(
    "default" to "Abyssal Navy", "oled" to "Abyssal OLED",
    "sunset" to "Sunset", "sunset-oled" to "Sunset OLED",
    "forest" to "Forest", "forest-oled" to "Forest OLED",
    "crimson" to "Crimson", "crimson-oled" to "Crimson OLED",
    "blossom" to "Blossom", "blossom-oled" to "Blossom OLED",
    "amethyst" to "Amethyst", "amethyst-oled" to "Amethyst OLED",
)

@Composable
fun ZkTheme(
    themeId: String = "default",
    content: @Composable () -> Unit,
) {
    val palette = ZkPalette.forId(themeId)
    val colors = darkColorScheme(
        primary = palette.accent,
        onPrimary = palette.bg0,
        secondary = palette.accent2,
        tertiary = palette.accent3,
        background = palette.bg0,
        onBackground = ZkInk.ink1,
        surface = palette.bg1,
        onSurface = ZkInk.ink1,
        surfaceVariant = palette.bg2,
        onSurfaceVariant = ZkInk.ink2,
        outline = palette.line,
        error = ZkStatus.danger,
    )
    CompositionLocalProvider(LocalZkPalette provides palette) {
        MaterialTheme(colorScheme = colors, typography = ZkTypography) {
            // Make bare Text() default to Space Grotesk (Material only applies
            // the typography to its own components, not to LocalTextStyle).
            CompositionLocalProvider(
                LocalTextStyle provides LocalTextStyle.current.copy(fontFamily = ZkSans),
                content = content,
            )
        }
    }
}
