package com.zekktris.ui.components

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shadow
import androidx.compose.ui.graphics.TileMode
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.TextUnit
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.data.model.PublicUser
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/** "#rrggbb" (or "rrggbb") → opaque Color, or null on blank/garbage. */
fun parseNameColor(hex: String?): Color? {
    if (hex.isNullOrBlank()) return null
    return runCatching { Color(android.graphics.Color.parseColor(if (hex.startsWith("#")) hex else "#$hex")) }.getOrNull()
}

private fun isStaff(u: PublicUser?): Boolean = u?.isAdmin == true || u?.isModerator == true

/**
 * Instance-staff display name. Staff (admin/moderator) who set a `staffColor`
 * are marked by an animated shimmer sweeping across their name in that color
 * (which OVERRIDES any role color); everyone else renders as a plain [Text] in
 * [baseColor]. Mirrors ios `StaffName`/`ShimmerText` + web `.zk-staff-shimmer`.
 */
@Composable
fun StaffName(
    user: PublicUser?,
    text: String,
    modifier: Modifier = Modifier,
    baseColor: Color = ZkInk.ink1,
    fontSize: TextUnit = 15.sp,
    fontWeight: FontWeight = FontWeight.Medium,
    maxLines: Int = 1,
) {
    val shimmerHex = if (isStaff(user)) user?.staffColor else null
    ShimmerName(text, shimmerHex, user?.staffGlow == true, modifier, baseColor, fontSize, fontWeight, maxLines)
}

/**
 * Shimmer a name with an EXPLICIT color hex (or plain when null) — used by the
 * staff-shimmer settings editor's live preview, where the chosen color hasn't
 * been saved to the user yet.
 */
@Composable
fun ShimmerName(
    text: String,
    colorHex: String?,
    glow: Boolean,
    modifier: Modifier = Modifier,
    baseColor: Color = ZkInk.ink1,
    fontSize: TextUnit = 15.sp,
    fontWeight: FontWeight = FontWeight.Medium,
    maxLines: Int = 1,
) {
    val shimmer = parseNameColor(colorHex)
    if (shimmer == null) {
        Text(
            text, modifier, color = baseColor, fontFamily = ZkSans, fontSize = fontSize,
            fontWeight = fontWeight, maxLines = maxLines, overflow = TextOverflow.Ellipsis,
        )
        return
    }
    val transition = rememberInfiniteTransition(label = "staffShimmer")
    val phase by transition.animateFloat(
        initialValue = 0f, targetValue = 1f,
        animationSpec = infiniteRepeatable(tween(2400, easing = LinearEasing), RepeatMode.Restart),
        label = "phase",
    )
    val density = LocalDensity.current
    // A white highlight band of `band` px sweeping across `travel` px. Names
    // wider than ~travel ellipsize anyway; the base color fills either side.
    val band = with(density) { 130.dp.toPx() }
    val travel = with(density) { 340.dp.toPx() }
    val x = phase * (travel + band) - band
    val brush = Brush.linearGradient(
        colors = listOf(shimmer, Color.White, shimmer),
        start = Offset(x, 0f),
        end = Offset(x + band, 0f),
        tileMode = TileMode.Clamp,
    )
    Text(
        text, modifier,
        style = TextStyle(
            brush = brush,
            fontFamily = ZkSans,
            fontSize = fontSize,
            fontWeight = fontWeight,
            shadow = if (glow) Shadow(color = shimmer.copy(alpha = 0.9f), blurRadius = 14f) else null,
        ),
        maxLines = maxLines,
        overflow = TextOverflow.Ellipsis,
    )
}

/**
 * Free-form self-typed name tag ("clan tag") pill — a ≤4-char label the user
 * types, tinted [color]. Renders nothing when blank. Mirrors ios `NameTag` +
 * web `UserTag`: label in the tint over a 14%-tint fill with a 1px tint border.
 */
@Composable
fun NameTag(label: String?, color: String?, modifier: Modifier = Modifier) {
    val l = label?.trim()
    if (l.isNullOrEmpty()) return
    // Viewer "Hide clan tags" declutter toggle (Appearance).
    if (com.zekktris.ui.theme.LocalHideTags.current.enabled) return
    val tint = parseNameColor(color) ?: ZkTheme.palette.accent
    Text(
        // Render as typed — iOS NameTag and web UserTag never force caps.
        l,
        modifier
            .clip(RoundedCornerShape(5.dp))
            .background(tint.copy(alpha = 0.14f))
            .border(1.dp, tint, RoundedCornerShape(5.dp))
            // iOS pads the pill symmetrically 5/2 (Components.swift:244-245).
            .padding(horizontal = 5.dp, vertical = 2.dp),
        color = tint, fontFamily = ZkSans, fontWeight = FontWeight.SemiBold, fontSize = 10.sp,
    )
}
