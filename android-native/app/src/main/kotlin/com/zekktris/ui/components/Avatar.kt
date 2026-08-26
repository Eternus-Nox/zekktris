package com.zekktris.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.data.Config
import com.zekktris.ui.theme.ZkTheme

// ── Deterministic avatar tones (port of web lib/avatar.ts / iOS avatarTone) ──
// Same FNV-1a 32-bit hash over the id, same 8-color palette (Tailwind
// rose-700…pink-700 with their -50 text pairs), so a given user renders the
// identical fallback color on web, iOS, and Android.
data class AvatarTone(val bg: Color, val fg: Color)

private val avatarPalette: List<AvatarTone> = listOf(
    AvatarTone(hexC(0xBE123C), hexC(0xFFF1F2)), // rose-700 / rose-50
    AvatarTone(hexC(0xD97706), hexC(0xFFFBEB)), // amber-600 / amber-50
    AvatarTone(hexC(0x047857), hexC(0xECFDF5)), // emerald-700 / emerald-50
    AvatarTone(hexC(0x0F766E), hexC(0xF0FDFA)), // teal-700 / teal-50
    AvatarTone(hexC(0x0369A1), hexC(0xF0F9FF)), // sky-700 / sky-50
    AvatarTone(hexC(0x4338CA), hexC(0xEEF2FF)), // indigo-700 / indigo-50
    AvatarTone(hexC(0x7E22CE), hexC(0xFAF5FF)), // purple-700 / purple-50
    AvatarTone(hexC(0xBE185D), hexC(0xFDF2F8)), // pink-700 / pink-50
)

/** FNV-1a 32-bit over UTF-16 code units — byte-for-byte the web's hash
 *  (charCodeAt ^ then Math.imul by the FNV prime), incl. abs(Int32). */
fun avatarTone(id: String?): AvatarTone {
    if (id.isNullOrEmpty()) return avatarPalette[0]
    var hash = 0x811c9dc5.toInt()
    for (ch in id) {
        hash = hash xor ch.code
        hash *= 0x01000193
    }
    val idx = (if (hash == Int.MIN_VALUE) 0 else kotlin.math.abs(hash)) % avatarPalette.size
    return avatarPalette[idx]
}

/** Two-word initials, matching web/iOS avatarInitials ("My Cool Server" → "MC"). */
fun avatarInitials(name: String?): String {
    if (name == null) return "?"
    val letters = name.split(Regex("\\s+")).filter { it.isNotEmpty() }.take(2)
        .mapNotNull { it.firstOrNull()?.uppercaseChar()?.toString() }
        .joinToString("")
    return letters.ifEmpty { "?" }
}

// ── Cosmetic avatar decorations (ring/glow/gradient frames), ported from iOS
//    Avatar.decorations. A decoration id draws a colored/gradient stroke frame.
private fun decoBrush(id: String): Brush? = when (id) {
    "aurora" -> Brush.sweepGradient(listOf(hexC(0x3DD7EC), hexC(0x9D7BFF), hexC(0xEC5FB5), hexC(0x3DD7EC)))
    "sunset" -> Brush.sweepGradient(listOf(hexC(0xFFD13D), hexC(0xEC5FB5), hexC(0x9D7BFF), hexC(0xFFD13D)))
    "emerald" -> Brush.sweepGradient(listOf(hexC(0x7EE787), hexC(0x3DD7EC), hexC(0x7EE787)))
    "ocean" -> Brush.sweepGradient(listOf(hexC(0x3D9BFF), hexC(0x3DD8C0), hexC(0x4FDD8F), hexC(0x3D9BFF)))
    else -> decoColor(id)?.let { Brush.linearGradient(listOf(it, it)) }
}

private fun decoColor(id: String): Color? = when (id) {
    "gold" -> hexC(0xF4C95B)
    "rose" -> hexC(0xEC5FB5)
    "violet" -> hexC(0x9D7BFF)
    "lime" -> hexC(0x7EE787)
    "crimson" -> hexC(0xFF4D4D)
    else -> null
}

private fun hexC(v: Long): Color = Color(0xFF000000 or v)

/** Circular (or squircle) avatar: remote image via Coil, else a deterministic
 *  FNV-1a-toned two-letter placeholder. [toneId] is the stable id the web/iOS
 *  hash (user/guild id); falls back to the name when absent. */
@Composable
fun Avatar(
    url: String?,
    name: String,
    size: Dp,
    modifier: Modifier = Modifier,
    shape: Shape = CircleShape,
    decoration: String? = null,
    toneId: String? = null,
) {
    val abs = Config.absoluteUrl(url)
    // Resolve the decoration frame brush (accent-aware for ring/glow).
    val deco = decoration?.takeIf { it != "none" && it.isNotEmpty() }
    val accentColor = ZkTheme.palette.accent
    val frame: Brush? = deco?.let { id ->
        when (id) {
            "ring", "glow" -> Brush.linearGradient(listOf(accentColor, accentColor))
            else -> decoBrush(id)
        }
    }
    val tone = avatarTone(toneId ?: name)
    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            .background(tone.bg)
            // iOS decoStroke: max(2, size * 0.05) (Components.swift:446-448).
            .then(if (frame != null) Modifier.border(maxOf(2.dp, size * 0.05f), frame, shape) else Modifier),
        contentAlignment = Alignment.Center,
    ) {
        if (abs != null) {
            AsyncImage(
                model = abs,
                contentDescription = name,
                modifier = Modifier.fillMaxSize(),
                contentScale = ContentScale.Crop,
            )
        } else {
            Text(
                text = avatarInitials(name),
                color = tone.fg,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * 0.36f).sp,
            )
        }
    }
}

/** Server-rail guild icon: rounded squircle. Icon-less guilds render the
 *  deterministic tone tile; when [isSelected], iOS swaps it to an
 *  accent→accent-2 gradient with the initials in bg-0 (Components.swift:639). */
@Composable
fun GuildIcon(url: String?, name: String, size: Dp, modifier: Modifier = Modifier, toneId: String? = null, isSelected: Boolean = false) {
    val p = ZkTheme.palette
    val shape = RoundedCornerShape(size / 3)
    if (Config.absoluteUrl(url) == null && isSelected) {
        Box(
            modifier = modifier
                .size(size)
                .clip(shape)
                .background(Brush.linearGradient(listOf(p.accent, p.accent2))),
            contentAlignment = Alignment.Center,
        ) {
            Text(
                text = avatarInitials(name),
                color = p.bg0,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * 0.34f).sp,
            )
        }
    } else {
        Avatar(url = url, name = name, size = size, modifier = modifier, shape = shape, toneId = toneId)
    }
}
