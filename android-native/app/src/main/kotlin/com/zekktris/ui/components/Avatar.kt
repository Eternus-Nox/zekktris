package com.zekktris.ui.components

import androidx.compose.foundation.background
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
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Shape
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.sp
import coil.compose.AsyncImage
import com.zekktris.data.Config
import com.zekktris.ui.theme.ZkAccentSchemes

// Deterministic fallback tint drawn from the 6 accent schemes' primaries.
private val fallbackTints: List<Color> = ZkAccentSchemes.values.map { it.a1 }

private fun tintFor(seed: String): Color {
    if (seed.isEmpty()) return fallbackTints.first()
    // `and Int.MAX_VALUE` avoids the Int.MIN_VALUE negation overflow that would
    // yield a negative modulo → IndexOutOfBounds.
    val idx = (seed.hashCode() and Int.MAX_VALUE) % fallbackTints.size
    return fallbackTints[idx]
}

private fun initial(name: String): String =
    name.trim().firstOrNull()?.uppercaseChar()?.toString() ?: "?"

/** Circular (or squircle) avatar: remote image via Coil, else a tinted initial. */
@Composable
fun Avatar(
    url: String?,
    name: String,
    size: Dp,
    modifier: Modifier = Modifier,
    shape: Shape = CircleShape,
) {
    val abs = Config.absoluteUrl(url)
    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            .background(tintFor(name).copy(alpha = 0.85f)),
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
                text = initial(name),
                color = Color.White,
                fontWeight = FontWeight.SemiBold,
                fontSize = (size.value * 0.42f).sp,
            )
        }
    }
}

/** Server-rail guild icon: rounded squircle. */
@Composable
fun GuildIcon(url: String?, name: String, size: Dp, modifier: Modifier = Modifier) {
    Avatar(url = url, name = name, size = size, modifier = modifier, shape = RoundedCornerShape(size / 3))
}
