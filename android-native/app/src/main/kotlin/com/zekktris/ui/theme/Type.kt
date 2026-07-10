package com.zekktris.ui.theme

import androidx.compose.material3.Typography
import androidx.compose.ui.text.TextStyle
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

// The web rebases rem to 15px; these sizes mirror the rendered iOS/web scale.
val ZkTypography = Typography(
    bodyLarge = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.Normal, fontSize = 15.sp, lineHeight = 21.sp),
    bodyMedium = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.Normal, fontSize = 13.sp, lineHeight = 18.sp),
    bodySmall = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.Normal, fontSize = 11.sp, lineHeight = 15.sp),
    titleLarge = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.Bold, fontSize = 22.sp, lineHeight = 26.sp),
    titleMedium = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 16.sp, lineHeight = 20.sp),
    labelLarge = TextStyle(fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 14.sp),
    labelSmall = TextStyle(fontFamily = ZkMono, fontWeight = FontWeight.Bold, fontSize = 10.sp, letterSpacing = 1.4.sp),
)
