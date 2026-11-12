package com.zekktris.ui.components

import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.AnimationVector1D
import androidx.compose.animation.core.CubicBezierEasing
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.Stable
import androidx.compose.runtime.State
import androidx.compose.runtime.mutableStateListOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.Path
import androidx.compose.ui.graphics.StrokeCap
import androidx.compose.ui.graphics.StrokeJoin
import androidx.compose.ui.graphics.drawscope.DrawScope
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.drawscope.scale
import androidx.compose.ui.graphics.drawscope.translate
import androidx.compose.ui.graphics.drawscope.withTransform
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import com.zekktris.data.ZekkPet
import com.zekktris.data.ZekkPetArt
import com.zekktris.data.ZekkPetArt.Ink
import com.zekktris.data.ZekkPetArt.PetShape
import com.zekktris.data.model.PetDTO
import com.zekktris.ui.theme.ZkPalette
import com.zekktris.ui.theme.ZkTheme
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch

/** CSS `ease-in-out` and `ease-out`, the curves web's keyframes use. */
private val EASE_IN_OUT = CubicBezierEasing(0.42f, 0f, 0.58f, 1f)
private val EASE_OUT = CubicBezierEasing(0f, 0f, 0.58f, 1f)
private val easeInOut: (Float) -> Float = EASE_IN_OUT::transform

/**
 * Whether the system lets apps animate: off when the user removed
 * animations (Settings → Accessibility) or set the animator duration scale
 * to 0 (Developer options). Android's reduced-motion switch — the pet then
 * stays still (no bob, breathe, wobble or squash), as web does under
 * `prefers-reduced-motion`.
 */
@Composable
private fun rememberMotionEnabled(): Boolean = remember { android.animation.ValueAnimator.areAnimatorsEnabled() }

/** The pet's inks as opaque Compose colours for [palette], indexed by
 *  [Ink.ordinal]. A shape's own alpha (the cheeks' [ZekkPetArt.CHEEK_ALPHA])
 *  is applied once, when it is drawn — never baked in here as well. */
private fun petInks(palette: ZkPalette): List<Color> {
    val colors = ZekkPetArt.colorsFor(palette.accent.toArgb(), palette.accent2.toArgb())
    return Ink.entries.map { ink -> Color(ZekkPetArt.rgbOf(ink, colors) or (0xFF shl 24)) }
}

/**
 * A primitive ready to draw: its path and stroke are built once (in
 * composition), not on every frame of the idle animation.
 */
private class Prepared(val shape: PetShape, val path: Path?, val stroke: Stroke?)

private fun linePath(points: List<ZekkPetArt.Point>, close: Boolean): Path = Path().apply {
    points.forEachIndexed { i, p -> if (i == 0) moveTo(p.x, p.y) else lineTo(p.x, p.y) }
    if (close) close()
}

private fun preparePetShape(shape: PetShape): Prepared = when (shape) {
    is PetShape.Oval -> Prepared(shape, null, shape.stroke?.let { Stroke(shape.strokeWidth) })
    is PetShape.Circle, is PetShape.HalfOval -> Prepared(shape, null, null)
    is PetShape.Curve -> Prepared(
        shape,
        Path().apply {
            moveTo(shape.from.x, shape.from.y)
            quadraticBezierTo(shape.control.x, shape.control.y, shape.to.x, shape.to.y)
        },
        Stroke(shape.width, cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
    is PetShape.Lines -> Prepared(
        shape, linePath(shape.points, close = false),
        Stroke(shape.width, cap = StrokeCap.Round, join = StrokeJoin.Round),
    )
    is PetShape.Polygon -> Prepared(
        shape, linePath(shape.points, close = true),
        shape.stroke?.let { Stroke(shape.strokeWidth, join = StrokeJoin.Round) },
    )
}

/** Draw one primitive in the 100-unit space; [alpha] fades the whole shape. */
private fun DrawScope.drawPrepared(p: Prepared, inks: List<Color>, alpha: Float = 1f) {
    when (val s = p.shape) {
        is PetShape.Oval -> {
            val e = s.e
            val topLeft = Offset(e.cx - e.rx, e.cy - e.ry)
            val size = Size(2 * e.rx, 2 * e.ry)
            rotate(e.rotate, pivot = Offset(e.cx, e.cy)) {
                drawOval(inks[s.fill.ordinal], topLeft, size, alpha = alpha)
                if (s.stroke != null && p.stroke != null) drawOval(inks[s.stroke.ordinal], topLeft, size, alpha = alpha, style = p.stroke)
            }
        }
        is PetShape.Circle -> drawCircle(inks[s.fill.ordinal], s.r, Offset(s.cx, s.cy), alpha = s.alpha * alpha)
        is PetShape.Curve -> drawPath(p.path!!, inks[s.stroke.ordinal], alpha = alpha, style = p.stroke!!)
        is PetShape.Lines -> drawPath(p.path!!, inks[s.stroke.ordinal], alpha = alpha, style = p.stroke!!)
        is PetShape.Polygon -> {
            drawPath(p.path!!, inks[s.fill.ordinal], alpha = alpha)
            if (s.stroke != null && p.stroke != null) drawPath(p.path, inks[s.stroke.ordinal], alpha = alpha, style = p.stroke)
        }
        // 0° is 3 o'clock and angles run clockwise, so 0 → 180 sweeps the
        // bottom half; closing through the centre closes it along its top.
        is PetShape.HalfOval -> drawArc(
            inks[s.fill.ordinal], startAngle = 0f, sweepAngle = 180f, useCenter = true,
            topLeft = Offset(s.cx - s.rx, s.cy - s.ry), size = Size(2 * s.rx, 2 * s.ry), alpha = alpha,
        )
    }
}

/**
 * What a tap on the pet card's pet does: a quick squash and a heart that
 * floats up and fades. Purely local, nothing is sent. Hand the same state
 * to the [ZekkPetArt] it should show on.
 */
@Stable
class PetTapState internal constructor(private val scope: CoroutineScope, private val motion: Boolean) {
    /** 0 → 1 through the squash (1 = at rest again). */
    internal val squash = Animatable(1f)

    /** One entry per heart in flight, 0 → 1 through its rise. */
    internal val hearts = mutableStateListOf<Animatable<Float, AnimationVector1D>>()

    fun tap() {
        // Reduced motion keeps the pet still; the heart is a fade, and with
        // animations off it ends at once.
        if (motion) {
            scope.launch {
                squash.snapTo(0f)
                squash.animateTo(1f, tween(ZekkPetArt.SQUASH_MS, easing = LinearEasing))
            }
        }
        val heart = Animatable(0f)
        hearts += heart
        scope.launch {
            try {
                heart.animateTo(1f, tween(ZekkPetArt.HEART_MS, easing = EASE_OUT))
            } finally {
                hearts.remove(heart)
            }
        }
    }
}

@Composable
fun rememberPetTapState(): PetTapState {
    val scope = rememberCoroutineScope()
    val motion = rememberMotionEnabled()
    return remember(scope, motion) { PetTapState(scope, motion) }
}

/**
 * The Zekk Pet, drawn natively from the shared geometry ([ZekkPetArt]) at
 * [size] (the art's 100-unit box scaled to it), in the viewer's theme: the
 * colours come from [ZkTheme.palette], so a theme switch recolours it at once.
 *
 * [animated]: the idle motion — a bob of ±2 units every 2.4 s, a slow
 * breathe while asleep, a wobble on the egg every 3 s; off for tiny glyphs
 * and under reduced motion. The animated values are read only while drawing,
 * so the motion redraws the canvas without recomposing anything. [progress]
 * (0–1 towards the next level) cracks the egg near the end. [tap]: the pet
 * card's tap squash and hearts.
 */
@Composable
fun ZekkPetArt(
    stage: ZekkPet.Stage,
    mood: ZekkPet.Mood,
    size: Dp,
    modifier: Modifier = Modifier,
    progress: Float = 0f,
    animated: Boolean = true,
    tap: PetTapState? = null,
) {
    val palette = ZkTheme.palette
    val inks = remember(palette) { petInks(palette) }
    val cracked = stage == ZekkPet.Stage.Egg && progress >= ZekkPetArt.CRACK_AT
    val shapes = remember(stage, mood, cracked) {
        ZekkPetArt.shapes(stage, mood, if (cracked) 1f else 0f).map(::preparePetShape)
    }
    val heart = remember { ZekkPetArt.heartShapes().map(::preparePetShape) }
    val motion = ZekkPetArt.motion(stage, mood)
    val idle: State<Float>? = if (animated && rememberMotionEnabled()) {
        val transition = rememberInfiniteTransition(label = "zekkPet")
        when (motion) {
            ZekkPetArt.Motion.Bob -> transition.animateFloat(
                -ZekkPetArt.BOB_UNITS, ZekkPetArt.BOB_UNITS,
                infiniteRepeatable(tween(ZekkPetArt.BOB_HALF_MS, easing = EASE_IN_OUT), RepeatMode.Reverse),
                label = "bob",
            )
            ZekkPetArt.Motion.Breathe -> transition.animateFloat(
                1f, ZekkPetArt.BREATHE_SCALE,
                infiniteRepeatable(tween(ZekkPetArt.BREATHE_HALF_MS, easing = EASE_IN_OUT), RepeatMode.Reverse),
                label = "breathe",
            )
            // Linear through the 3 s cycle; wobbleAngle shapes each leg.
            ZekkPetArt.Motion.Wobble -> transition.animateFloat(
                0f, ZekkPetArt.WOBBLE_PERIOD_MS.toFloat(),
                infiniteRepeatable(tween(ZekkPetArt.WOBBLE_PERIOD_MS, easing = LinearEasing), RepeatMode.Restart),
                label = "wobble",
            )
        }
    } else null

    Canvas(modifier.size(size)) {
        val k = this.size.minDimension / 100f
        val ground = Offset(ZekkPetArt.GROUND_X, ZekkPetArt.GROUND_Y)
        scale(k, k, pivot = Offset.Zero) {
            val v = idle?.value
            val (sx, sy) = ZekkPetArt.squashScale(tap?.squash?.value ?: 1f)
            withTransform({
                if (v != null) {
                    when (motion) {
                        ZekkPetArt.Motion.Bob -> translate(top = v)
                        ZekkPetArt.Motion.Breathe -> scale(v, v, pivot = ground)
                        ZekkPetArt.Motion.Wobble -> rotate(ZekkPetArt.wobbleAngle(v, easeInOut), pivot = ground)
                    }
                }
                if (sx != 1f || sy != 1f) scale(sx, sy, pivot = ground)
            }) {
                shapes.forEach { drawPrepared(it, inks) }
            }
            tap?.hearts?.forEach { h ->
                val f = h.value
                translate(top = -ZekkPetArt.HEART_RISE * f) {
                    heart.forEach { drawPrepared(it, inks, alpha = 1f - f) }
                }
            }
        }
    }
}

/**
 * The header pet next to the streak pill: the same 28dp as the DM avatar,
 * on the theme's chip surface (an egg while the invite is open, the asleep
 * face when asleep). Opens the pet card.
 */
@Composable
fun DmPetButton(pet: PetDTO, onClick: () -> Unit) {
    val p = ZkTheme.palette
    val label = ZekkPet.headerLabel(pet)
    Box(
        Modifier
            .size(30.dp)
            .clip(RoundedCornerShape(6.dp))
            .background(p.bg2)
            .border(1.dp, p.line, RoundedCornerShape(6.dp))
            .clickable(onClick = onClick)
            .semantics { contentDescription = label },
        contentAlignment = Alignment.Center,
    ) {
        ZekkPetArt(
            stage = ZekkPet.displayStage(pet),
            mood = ZekkPet.Mood.of(pet.mood),
            size = 28.dp,
            progress = ZekkPet.artProgress(pet),
        )
    }
}
