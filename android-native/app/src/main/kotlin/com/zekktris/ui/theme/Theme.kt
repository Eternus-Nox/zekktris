package com.zekktris.ui.theme

import androidx.compose.material3.LocalTextStyle
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.darkColorScheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.ReadOnlyComposable

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
