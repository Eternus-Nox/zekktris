package com.zekktris.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.PlatformTextStyle
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.style.LineHeightStyle
import androidx.compose.ui.text.font.Font
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.sp
import com.zekktris.R

/**
 * Typography. The iOS/web clients use Space Grotesk (UI) + JetBrains Mono
 * (timestamps/code chrome); both families are bundled under res/font so the
 * three clients share the same type.
 */
val ZkSans: FontFamily = FontFamily(
    Font(R.font.space_grotesk_regular, FontWeight.Normal),
    Font(R.font.space_grotesk_medium, FontWeight.Medium),
    Font(R.font.space_grotesk_semibold, FontWeight.SemiBold),
    Font(R.font.space_grotesk_bold, FontWeight.Bold),
)

val ZkMono: FontFamily = FontFamily(
    Font(R.font.jetbrains_mono_regular, FontWeight.Normal),
    Font(R.font.jetbrains_mono_medium, FontWeight.Medium),
    Font(R.font.jetbrains_mono_semibold, FontWeight.SemiBold),
)

/**
 * Trims the half-leading Compose puts ABOVE the first line and BELOW the last,
 * and drops the legacy font padding. Spacing BETWEEN lines is untouched, so
 * multi-line message text still breathes.
 *
 * Why this exists: `Text(fontSize = 10.sp)` does NOT scale `lineHeight` — the
 * ambient line height is inherited unchanged. This app overrides `fontSize` in
 * ~700 places and sets `lineHeight` in 5, so nearly every label was drawing a
 * small glyph inside a line box sized for 15sp body text, padded top and bottom.
 * That is what made the clan-tag pill look like it had a spacer above and below
 * the label, and what made the whole UI read a size or two larger than iOS —
 * whose `Text` hugs the glyphs. The sp values already matched iOS exactly; the
 * box around them did not.
 *
 * Fixed here rather than by shrinking 700 font sizes, which would have broken
 * parity with iOS to compensate for a layout artifact.
 */
private val ZkText = PlatformTextStyle(includeFontPadding = false)
private val ZkLeading = LineHeightStyle(
    alignment = LineHeightStyle.Alignment.Center,
    trim = LineHeightStyle.Trim.Both,
)

private fun TextStyle.zkTrimmed(): TextStyle =
    copy(platformStyle = ZkText, lineHeightStyle = ZkLeading)

// The web rebases rem to 15px; these sizes mirror the rendered iOS/web scale.
private val ZkTypographyRaw = Typography(
    bodyLarge = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 21.sp),
    bodyMedium = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp),
    bodySmall = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.Normal, fontSize = 11.sp, lineHeight = 15.sp),
    titleLarge = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    labelSmall = TextStyle(fontFamily = ZkMono, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 1.4.sp),
)

/**
 * The typography the app actually uses: every style from [ZkTypographyRaw] with
 * the outer leading trimmed. Also provided as `LocalTextStyle` at the theme root
 * so the ~700 `Text(fontSize = …)` call sites inherit it too — they override the
 * size, not the leading, which is the whole problem this solves.
 */
val ZkTypography = Typography(
    bodyLarge = ZkTypographyRaw.bodyLarge.zkTrimmed(),
    bodyMedium = ZkTypographyRaw.bodyMedium.zkTrimmed(),
    bodySmall = ZkTypographyRaw.bodySmall.zkTrimmed(),
    titleLarge = ZkTypographyRaw.titleLarge.zkTrimmed(),
    titleMedium = ZkTypographyRaw.titleMedium.zkTrimmed(),
    labelLarge = ZkTypographyRaw.labelLarge.zkTrimmed(),
    labelSmall = ZkTypographyRaw.labelSmall.zkTrimmed(),
)

/** Base style for bare `Text` — trimmed leading, no inherited oversized box. */
val ZkBaseTextStyle: TextStyle = ZkTypographyRaw.bodyLarge.zkTrimmed()
