package com.zekktris.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.Text
import androidx.compose.material3.TextFieldColors
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.zekktris.ui.theme.ZkFx
import com.zekktris.ui.theme.ZkInk
import com.zekktris.ui.theme.ZkSans
import com.zekktris.ui.theme.ZkTheme

/** Deep-navy ground with soft corner aurora tints (the app's shared backdrop). */
@Composable
fun AbyssBackground(
    modifier: Modifier = Modifier,
    contentAlignment: Alignment = Alignment.TopStart,
    content: @Composable BoxScope.() -> Unit,
) {
    val p = ZkTheme.palette
    Box(
        modifier = modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(p.bg0)
                fun glow(color: Color, cx: Float, cy: Float, r: Float) {
                    val center = Offset(size.width * cx, size.height * cy)
                    val radius = size.minDimension * r
                    drawCircle(
                        brush = Brush.radialGradient(
                            colors = listOf(color, Color.Transparent),
                            center = center,
                            radius = radius,
                        ),
                        radius = radius,
                        center = center,
                    )
                }
                glow(ZkFx.auroraViolet, 0.12f, 0.10f, 0.85f)
                glow(ZkFx.auroraCyan, 0.92f, 0.14f, 0.80f)
                glow(ZkFx.auroraMagenta, 0.80f, 0.94f, 0.70f)
            },
        contentAlignment = contentAlignment,
        content = content,
    )
}

/**
 * Full-bleed starfield backdrop for the voice/call screens — a black ground
 * with 70 deterministically-placed faint stars, mirroring the iOS
 * StarfieldView (same LCG seed → same layout). Header/controls sit on top.
 */
@Composable
fun StarfieldBackground(
    modifier: Modifier = Modifier,
    contentAlignment: Alignment = Alignment.TopStart,
    content: @Composable BoxScope.() -> Unit,
) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .drawBehind {
                drawRect(Color.Black)
                // Tiny deterministic LCG (matches iOS SeededRNG) so the field is
                // stable across recompositions.
                var state = 0x5DEECE66DL
                fun next(): Double {
                    state = state * 6364136223846793005L + 1442695040888963407L
                    return (state ushr 11).toDouble() / (1L shl 53).toDouble()
                }
                repeat(70) {
                    val x = next().toFloat() * size.width
                    val y = next().toFloat() * size.height
                    val r = (next() * 1.3 + 0.4).toFloat()
                    val op = (next() * 0.5 + 0.15).toFloat()
                    drawCircle(Color.White.copy(alpha = op), radius = r, center = Offset(x, y))
                }
            },
        contentAlignment = contentAlignment,
        content = content,
    )
}

/**
 * The cold-start spinner.
 *
 * [reconnecting] turns it into an honest "we can't reach the server yet"
 * state: the session is intact and being retried on a backoff ladder, which
 * is the whole point of the refresh tri-state — this screen is what the user
 * sees INSTEAD of being bounced to the login form by an offline moment.
 * [onSignIn] is the escape hatch for an outage that outlasts their patience;
 * it clears nothing, so a later relaunch still restores the session.
 */
@Composable
fun LoadingScreen(reconnecting: Boolean = false, onSignIn: (() -> Unit)? = null) {
    val p = ZkTheme.palette
    AbyssBackground(contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            CircularProgressIndicator(color = p.accent)
            if (reconnecting) {
                Text(
                    "Reconnecting…",
                    color = ZkInk.ink2,
                    fontFamily = ZkSans,
                    fontSize = 14.sp,
                    modifier = Modifier.padding(top = 18.dp),
                )
                Text(
                    "You're still signed in. We'll keep trying.",
                    color = ZkInk.ink3,
                    fontFamily = ZkSans,
                    fontSize = 12.sp,
                    modifier = Modifier.padding(top = 4.dp),
                )
                if (onSignIn != null) {
                    Text(
                        "Sign in instead",
                        color = p.accent,
                        fontFamily = ZkSans,
                        fontSize = 13.sp,
                        modifier = Modifier
                            .padding(top = 20.dp)
                            .clickable(onClick = onSignIn)
                            .padding(horizontal = 16.dp, vertical = 8.dp),
                    )
                }
            }
        }
    }
}

@Composable
fun zkFieldColors(): TextFieldColors {
    val p = ZkTheme.palette
    return OutlinedTextFieldDefaults.colors(
        focusedTextColor = ZkInk.ink1,
        unfocusedTextColor = ZkInk.ink1,
        cursorColor = p.accent,
        focusedBorderColor = p.accent,
        unfocusedBorderColor = p.line,
        focusedLabelColor = p.accent,
        unfocusedLabelColor = ZkInk.ink3,
        focusedContainerColor = p.bg1,
        unfocusedContainerColor = p.bg1,
        focusedPlaceholderColor = ZkInk.ink4,
        unfocusedPlaceholderColor = ZkInk.ink4,
    )
}
