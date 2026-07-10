package com.zekktris.ui.components

import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.BoxScope
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.OutlinedTextFieldDefaults
import androidx.compose.material3.TextFieldColors
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import com.zekktris.ui.theme.ZkFx
import com.zekktris.ui.theme.ZkInk
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

@Composable
fun LoadingScreen() {
    val p = ZkTheme.palette
    AbyssBackground(contentAlignment = Alignment.Center) {
        CircularProgressIndicator(color = p.accent)
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
