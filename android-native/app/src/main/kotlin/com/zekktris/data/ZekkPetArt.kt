package com.zekktris.data

import com.zekktris.data.ZekkPet.Mood
import com.zekktris.data.ZekkPet.Stage
import java.math.BigInteger
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin

/**
 * Zekk Pet art — the creature as data. One original creature, every stage ×
 * mood resolved to a list of primitives in a 100×100 space, back to front:
 * wings, arms, feet, body, belly, antennae, face, extras. Web (lib/petArt.ts)
 * and iOS draw the SAME numbers, so this is the geometry, not a picture: no
 * Android types. ui/components/ZekkPet.kt turns the list into Canvas calls,
 * and ZekkPetTest checks the numbers per stage and mood.
 *
 * Colours are the PET's, not the viewer's: a pet has one colour of its own
 * ([PET_COLORS], stored with it on the server), so both people in the DM see
 * the same egg whatever Appearance theme each of them uses. The body is the
 * colour's accent, the belly and outline are that accent mixed toward white /
 * black, and the antenna tips take its second colour ([colorsFor]). The eye /
 * mouth / tear / gold inks are fixed.
 */
object ZekkPetArt {
    /** Every colour the pet uses. The first four follow the pet's colour
     *  ([colorsFor]); the rest are fixed. */
    enum class Ink { Body, Belly, Outline, Accent, Eye, Highlight, Cheek, Mouth, Tear, Gold, GoldDark, Sparkle, Heart }

    // Fixed inks, 0xRRGGBB.
    const val EYE = 0x1D1D2B
    const val HIGHLIGHT = 0xFFFFFF
    /** hsl(350, 85%, 75%), drawn at [CHEEK_ALPHA] (the cheek circles carry
     *  that alpha; the ink itself is opaque). */
    const val CHEEK = 0xF5899B
    const val MOUTH = 0x8A2A3A
    /** Tear and drool. */
    const val TEAR = 0x6EC6FF
    const val GOLD = 0xFFD54A
    const val GOLD_DARK = 0xC99A00
    const val SPARKLE = 0xFFE58A
    const val HEART = 0xFF5C8A

    const val CHEEK_ALPHA = 0.7f

    /** Body / limb outline and every stroked face line. */
    const val OUTLINE_WIDTH = 2.5f

    /** The point the egg wobbles around and the pet breathes / squashes
     *  from: the ground the hatched stages stand on (just under the feet).
     *  The egg, centred in the box, turns about it too, 6 units under its
     *  base (82): one point for every stage, as on web and iOS, and on the
     *  140 dp pet card that moves the egg's base by under 1 dp. */
    const val GROUND_X = 50f
    const val GROUND_Y = 88f

    /** Where the tap heart starts, and how far it rises while it fades. */
    const val HEART_X = 50f
    const val HEART_Y = 26f
    const val HEART_RISE = 20f

    /** Egg progress (towards level 1) from which the shell shows a crack. */
    const val CRACK_AT = 0.8f

    // ── Colours ───────────────────────────────────────────────────────────

    /** The colours drawn from a pet colour's two accents, 0xRRGGBB. */
    data class Colors(val body: Int, val belly: Int, val outline: Int, val accent: Int)

    /** [rgb] mixed [percent]% of the way toward [toward], per channel in sRGB,
     *  rounded half up — what web's `color-mix(in srgb, …)` computes. */
    fun mix(rgb: Int, toward: Int, percent: Int): Int {
        fun ch(c: Int, shift: Int): Int {
            val from = (c shr shift) and 0xFF
            val to = (toward shr shift) and 0xFF
            // Integer half-up rounding: exact, where floats can land a hair under .5.
            return (from * (100 - percent) + to * percent + 50) / 100
        }
        return (ch(rgb, 16) shl 16) or (ch(rgb, 8) shl 8) or ch(rgb, 0)
    }

    /** The pet's colours for the accents [accent] / [accent2] (0xRRGGBB; any
     *  alpha byte is ignored) — a pet colour's two ([colorsOf]): body = the
     *  accent, belly = it mixed 55% toward white, outline = 60% toward
     *  black, accent = the second colour. */
    fun colorsFor(accent: Int, accent2: Int): Colors {
        val a = accent and 0xFFFFFF
        return Colors(
            body = a,
            belly = mix(a, 0xFFFFFF, 55),
            outline = mix(a, 0x000000, 60),
            accent = accent2 and 0xFFFFFF,
        )
    }

    // ── Pet colours ───────────────────────────────────────────────────────

    /** One pet colour (packages/shared/src/pets.ts PET_PALETTES): [id] is
     *  what PetDTO.color and a notice's petColor carry and the invite sends,
     *  [label] its name in the egg picker, [accent] / [accent2] (0xRRGGBB)
     *  the two colours the pet is drawn from ([colorsFor]). */
    data class PetColor(val id: String, val label: String, val accent: Int, val accent2: Int)

    /** The colour of anything this app can't place: an unparsable DM id, an
     *  unknown theme. */
    const val DEFAULT_COLOR = "default"

    /**
     * Every pet colour, in the egg picker's order (PET_COLOR_IDS). They are
     * the app's six accent families — each is its theme's accent and second
     * colour, byte for byte as ui/theme's ZkAccentSchemes has them — so a pet
     * looks at home in every theme, and one drawn in a family's colour is
     * exactly the pet that theme used to give it. The ids are stored with
     * the pet: never rename or remove one (colours may only be added, here
     * and in the shared table together).
     */
    val PET_COLORS: List<PetColor> = listOf(
        PetColor("default", "Abyssal", 0x3DD7EC, 0x9D7BFF),
        PetColor("sunset", "Sunset", 0xFF8A3D, 0xFFD13D),
        PetColor("forest", "Forest", 0x3D9BFF, 0x4FDD8F),
        PetColor("crimson", "Crimson", 0xFF4D4D, 0x9AA3B8),
        PetColor("blossom", "Blossom", 0xFF5FA2, 0xFFB088),
        PetColor("amethyst", "Amethyst", 0xA855F7, 0xF5B942),
    )

    private val PET_COLORS_BY_ID: Map<String, PetColor> = PET_COLORS.associateBy { it.id }

    /** The order [colorForChannel] picks from, kept apart from [PET_COLORS]
     *  and frozen: it decides the colour of every pet nobody picked one for
     *  (the server backfilled the pets from before colours with it), so
     *  adding a colour must not change it. */
    private val CHANNEL_COLOR_ORDER = listOf("default", "sunset", "forest", "crimson", "blossom", "amethyst")

    private val CHANNEL_COLOR_COUNT: BigInteger = BigInteger.valueOf(CHANNEL_COLOR_ORDER.size.toLong())

    /** The pet colour [id] names; null for none, or one this app doesn't know
     *  (a newer server's). */
    fun petColor(id: String?): PetColor? = id?.let { PET_COLORS_BY_ID[it] }

    fun isColorId(id: String?): Boolean = petColor(id) != null

    /**
     * A DM's own pet colour: its channel id (a decimal snowflake) mod 6 into
     * the frozen order, as the server, web and iOS work it out — the colour
     * of a pet nobody picked one for, and the fallback whenever a pet or a
     * notice carries no colour this app knows, so both people (on every app)
     * still see the same egg. Worked out on the whole number, past 64 bits
     * too, as the shared code's BigInt does; an id that won't parse gets
     * [DEFAULT_COLOR].
     */
    fun colorForChannel(channelId: String): String {
        val id = channelId.trim().toBigIntegerOrNull() ?: return DEFAULT_COLOR
        return CHANNEL_COLOR_ORDER[id.abs().mod(CHANNEL_COLOR_COUNT).toInt()]
    }

    /** The colour to draw a pet (or a pet notice) of [channelId] in: its own
     *  [color] when it's one this app knows, else its DM's
     *  ([colorForChannel]). Never the viewer's theme. */
    fun resolveColor(color: String?, channelId: String): String =
        petColor(color)?.id ?: colorForChannel(channelId)

    /** The pet's colours for the pet colour [id] (one this app doesn't know
     *  draws in [DEFAULT_COLOR]). */
    fun colorsOf(id: String): Colors {
        val c = petColor(id) ?: PET_COLORS_BY_ID.getValue(DEFAULT_COLOR)
        return colorsFor(c.accent, c.accent2)
    }

    /** The colours of a pet of [channelId] whose colour is [color]
     *  ([resolveColor]). */
    fun colorsForPet(color: String?, channelId: String): Colors = colorsOf(resolveColor(color, channelId))

    /** Where the egg picker starts: the viewer's own theme family
     *  ("sunset-oled" → "sunset", "oled" → "default", anything this app
     *  doesn't know → [DEFAULT_COLOR]). Only the picker's first choice — the
     *  pet itself never follows anyone's theme. */
    fun colorForTheme(themeId: String?): String {
        val family = if (themeId == "oled") DEFAULT_COLOR else themeId?.removeSuffix("-oled")
        return petColor(family)?.id ?: DEFAULT_COLOR
    }

    /** [ink] as 0xRRGGBB under the pet's [colors]. */
    fun rgbOf(ink: Ink, colors: Colors): Int = when (ink) {
        Ink.Body -> colors.body
        Ink.Belly -> colors.belly
        Ink.Outline -> colors.outline
        Ink.Accent -> colors.accent
        Ink.Eye -> EYE
        Ink.Highlight -> HIGHLIGHT
        Ink.Cheek -> CHEEK
        Ink.Mouth -> MOUTH
        Ink.Tear -> TEAR
        Ink.Gold -> GOLD
        Ink.GoldDark -> GOLD_DARK
        Ink.Sparkle -> SPARKLE
        Ink.Heart -> HEART
    }

    // ── Geometry per stage ────────────────────────────────────────────────

    data class Point(val x: Float, val y: Float)

    /** An ellipse turned [rotate] degrees (clockwise on screen) about its centre. */
    data class Ellipse(val cx: Float, val cy: Float, val rx: Float, val ry: Float, val rotate: Float = 0f)

    /** A stalk from [from] to [to] with a tip at [tip]: a ball (circle r4) or
     *  a 5-point star (outer r5, inner r2.2). */
    data class Antenna(val from: Point, val to: Point, val tip: Point, val star: Boolean)

    data class Eyes(val ex1: Float, val ex2: Float, val ey: Float, val er: Float)

    data class Sparkle(val x: Float, val y: Float, val r: Float)

    data class Geometry(
        val body: Ellipse,
        /** Null on the egg. */
        val belly: Ellipse?,
        /** Null on the egg (no face). */
        val eyes: Eyes?,
        val feet: List<Ellipse> = emptyList(),
        val arms: List<Ellipse> = emptyList(),
        val wings: List<Ellipse> = emptyList(),
        val antennae: List<Antenna> = emptyList(),
        /** Legendary only. */
        val crown: List<Point>? = null,
        /** Legendary only: 4-point sparkles around the pet. */
        val sparkles: List<Sparkle> = emptyList(),
    )

    private fun pt(x: Number, y: Number) = Point(x.toFloat(), y.toFloat())
    private fun el(cx: Number, cy: Number, rx: Number, ry: Number, rotate: Number = 0) =
        Ellipse(cx.toFloat(), cy.toFloat(), rx.toFloat(), ry.toFloat(), rotate.toFloat())

    private val ADULT = Geometry(
        body = el(50, 55, 31, 31),
        belly = el(50, 64, 19, 14),
        eyes = Eyes(39f, 61f, 50f, 6f),
        feet = listOf(el(37, 86, 9, 4.5), el(63, 86, 9, 4.5)),
        arms = listOf(el(19, 58, 6, 10, -20), el(81, 58, 6, 10, 20)),
        wings = listOf(el(24, 42, 12, 7, -30), el(76, 42, 12, 7, 30)),
        antennae = listOf(
            Antenna(pt(42, 26), pt(35, 13), pt(34, 11), star = true),
            Antenna(pt(58, 26), pt(65, 13), pt(66, 11), star = true),
        ),
    )

    private val GEOMETRY: Map<Stage, Geometry> = mapOf(
        // Centred in the 100×100 box (18–82 tall) rather than resting on the
        // hatched stages' ground line: the egg is mostly seen alone in a small
        // square (the header chip, notice glyphs, the egg picker), where
        // sitting 6 units low read as off-centre. Web and iOS use these numbers.
        Stage.Egg to Geometry(body = el(50, 50, 26, 32), belly = null, eyes = null),
        Stage.Baby to Geometry(
            body = el(50, 60, 24, 22),
            belly = el(50, 66, 14, 10),
            eyes = Eyes(41f, 59f, 56f, 4.5f),
            antennae = listOf(Antenna(pt(50, 38), pt(50, 26), pt(50, 24), star = false)),
        ),
        Stage.Kid to Geometry(
            body = el(50, 58, 27, 25),
            belly = el(50, 65, 16, 11),
            eyes = Eyes(40f, 60f, 54f, 5f),
            feet = listOf(el(38, 83, 7, 4), el(62, 83, 7, 4)),
            antennae = listOf(Antenna(pt(50, 33), pt(50, 21), pt(50, 18), star = true)),
        ),
        Stage.Teen to Geometry(
            body = el(50, 56, 28, 29),
            belly = el(50, 64, 17, 13),
            eyes = Eyes(40f, 60f, 51f, 5.5f),
            feet = listOf(el(38, 85, 8, 4), el(62, 85, 8, 4)),
            arms = listOf(el(22, 60, 5, 9, -20), el(78, 60, 5, 9, 20)),
            antennae = listOf(
                Antenna(pt(42, 29), pt(36, 16), pt(35, 14), star = false),
                Antenna(pt(58, 29), pt(64, 16), pt(65, 14), star = false),
            ),
        ),
        Stage.Adult to ADULT,
        Stage.Legendary to ADULT.copy(
            antennae = emptyList(),
            crown = listOf(pt(36, 24), pt(40, 12), pt(46, 20), pt(50, 8), pt(54, 20), pt(60, 12), pt(64, 24)),
            sparkles = listOf(Sparkle(14f, 24f, 5f), Sparkle(86f, 30f, 4f), Sparkle(82f, 78f, 3.5f), Sparkle(16f, 72f, 3f)),
        ),
    )

    fun geometry(stage: Stage): Geometry = GEOMETRY.getValue(stage)

    // ── Primitives ────────────────────────────────────────────────────────

    /** Which part of the pet a primitive draws (the tests use it). */
    enum class Part { Wing, Arm, Foot, Body, Spot, Belly, Antenna, Face, Crack, Crown, Sparkle, Zzz, Heart }

    sealed interface PetShape {
        val part: Part

        /** A filled ellipse, turned [Ellipse.rotate]°, optionally outlined. */
        data class Oval(
            override val part: Part,
            val e: Ellipse,
            val fill: Ink,
            val stroke: Ink? = null,
            val strokeWidth: Float = OUTLINE_WIDTH,
        ) : PetShape

        data class Circle(
            override val part: Part,
            val cx: Float,
            val cy: Float,
            val r: Float,
            val fill: Ink,
            val alpha: Float = 1f,
        ) : PetShape

        /** A stroked quadratic curve with round caps. */
        data class Curve(
            override val part: Part,
            val from: Point,
            val control: Point,
            val to: Point,
            val stroke: Ink,
            val width: Float = OUTLINE_WIDTH,
        ) : PetShape

        /** A stroked open line through [points] (two points = a straight
         *  line), round caps and joins. */
        data class Lines(
            override val part: Part,
            val points: List<Point>,
            val stroke: Ink,
            val width: Float = OUTLINE_WIDTH,
        ) : PetShape

        /** A filled closed polygon, optionally outlined (round joins). */
        data class Polygon(
            override val part: Part,
            val points: List<Point>,
            val fill: Ink,
            val stroke: Ink? = null,
            val strokeWidth: Float = OUTLINE_WIDTH,
        ) : PetShape

        /** The lower half of an ellipse, closed along its top (the open smile). */
        data class HalfOval(
            override val part: Part,
            val cx: Float,
            val cy: Float,
            val rx: Float,
            val ry: Float,
            val fill: Ink,
        ) : PetShape
    }

    private fun deg(d: Double) = d * PI / 180.0

    /** A 5-point star, one point straight up. */
    fun starPoints(cx: Float, cy: Float, outer: Float, inner: Float): List<Point> = (0 until 10).map { i ->
        val r = if (i % 2 == 0) outer else inner
        val a = deg(-90.0 + i * 36)
        Point((cx + r * cos(a)).toFloat(), (cy + r * sin(a)).toFloat())
    }

    /** A 4-point sparkle: points on the axes at [r], waists at 45° at 0.4·r. */
    fun sparklePoints(cx: Float, cy: Float, r: Float): List<Point> = (0 until 8).map { i ->
        val d = if (i % 2 == 0) r else r * 0.4f
        val a = deg(-90.0 + i * 45)
        Point((cx + d * cos(a)).toFloat(), (cy + d * sin(a)).toFloat())
    }

    /** A "Z" [s] wide and [s] tall from its top-left corner. */
    fun zPoints(x: Float, y: Float, s: Float): List<Point> =
        listOf(Point(x, y), Point(x + s, y), Point(x, y + s), Point(x + s, y + s))

    // ── Faces ─────────────────────────────────────────────────────────────

    /** The face for [mood] (sc = er/5; the mouth centre sits at ey + 12·sc).
     *  Cheeks go first so the eyes sit on top of them. */
    fun faceShapes(eyes: Eyes, mood: Mood): List<PetShape> {
        val (ex1, ex2, ey, er) = eyes
        val sc = er / 5f
        val my = ey + 12 * sc
        val out = ArrayList<PetShape>()
        val face = Part.Face

        fun cheeks() {
            out += PetShape.Circle(face, ex1 - 4 * sc, ey + 7 * sc, 4 * sc, Ink.Cheek, CHEEK_ALPHA)
            out += PetShape.Circle(face, ex2 + 4 * sc, ey + 7 * sc, 4 * sc, Ink.Cheek, CHEEK_ALPHA)
        }

        fun roundEyes(dy: Float = 0f) {
            for (ex in listOf(ex1, ex2)) {
                out += PetShape.Circle(face, ex, ey + dy, er, Ink.Eye)
                out += PetShape.Circle(face, ex - 0.35f * er, ey + dy - 0.35f * er, 0.35f * er, Ink.Highlight)
            }
        }

        when (mood) {
            Mood.Thriving -> {
                cheeks()
                // "^ ^" eyes.
                for (ex in listOf(ex1, ex2)) {
                    out += PetShape.Curve(face, Point(ex - er, ey + 1), Point(ex, ey - er), Point(ex + er, ey + 1), Ink.Eye)
                }
                out += PetShape.HalfOval(face, 50f, my, 9 * sc, 7 * sc, Ink.Mouth)
                out += PetShape.Polygon(Part.Sparkle, sparklePoints(20f, 40f, 3f), Ink.Sparkle)
                out += PetShape.Polygon(Part.Sparkle, sparklePoints(80f, 44f, 2.5f), Ink.Sparkle)
            }
            Mood.Lonely -> {
                roundEyes(1f)
                out += PetShape.Curve(face, Point(50 - 6 * sc, my + 3 * sc), Point(50f, my - 3 * sc), Point(50 + 6 * sc, my + 3 * sc), Ink.Eye)
                out += PetShape.Oval(face, Ellipse(ex2 + 0.6f * er, ey + er + 3, 2f, 3f), Ink.Tear)
            }
            Mood.Hungry -> {
                roundEyes()
                out += PetShape.Oval(face, Ellipse(50f, my + 1, 5 * sc, 6 * sc), Ink.Mouth)
                out += PetShape.Oval(face, Ellipse(50 + 4 * sc, my + 7 * sc, 1.5f, 2.5f), Ink.Tear)
            }
            Mood.Grumpy -> {
                roundEyes()
                out += PetShape.Lines(face, listOf(Point(ex1 - er - 1, ey - er - 4), Point(ex1 + er, ey - er - 1)), Ink.Eye)
                out += PetShape.Lines(face, listOf(Point(ex2 + er + 1, ey - er - 4), Point(ex2 - er, ey - er - 1)), Ink.Eye)
                out += PetShape.Curve(face, Point(50 - 7 * sc, my + 2), Point(50f, my - 2), Point(50 + 7 * sc, my + 2), Ink.Eye)
            }
            Mood.Asleep -> {
                // Closed eyes.
                for (ex in listOf(ex1, ex2)) {
                    out += PetShape.Curve(face, Point(ex - er, ey), Point(ex, ey + er), Point(ex + er, ey), Ink.Eye)
                }
                out += PetShape.Circle(face, 50f, my + 1, 2 * sc, Ink.Mouth)
            }
            Mood.Happy -> {
                cheeks()
                roundEyes()
                out += PetShape.Curve(face, Point(50 - 8 * sc, my), Point(50f, my + 7 * sc), Point(50 + 8 * sc, my), Ink.Eye)
            }
        }
        return out
    }

    // ── The whole pet ─────────────────────────────────────────────────────

    /** The crack across the egg, from [CRACK_AT] progress. */
    val CRACK: List<Point> = listOf(pt(30, 46), pt(38, 40), pt(45, 48), pt(53, 40), pt(60, 48), pt(70, 42))

    /** Every primitive of the pet, back to front. [progress] (0–1, towards
     *  the next level) only matters on the egg: from [CRACK_AT] the shell
     *  cracks. The egg has no face, so no mood shows on it. */
    fun shapes(stage: Stage, mood: Mood, progress: Float = 0f): List<PetShape> {
        val g = geometry(stage)
        val out = ArrayList<PetShape>()

        if (stage == Stage.Egg) {
            out += PetShape.Oval(Part.Body, g.body, Ink.Belly, Ink.Outline)
            out += PetShape.Circle(Part.Spot, 40f, 40f, 5f, Ink.Body)
            out += PetShape.Circle(Part.Spot, 60f, 54f, 6f, Ink.Body)
            out += PetShape.Circle(Part.Spot, 46f, 66f, 4f, Ink.Body)
            if (progress >= CRACK_AT) out += PetShape.Lines(Part.Crack, CRACK, Ink.Outline, 2f)
            return out
        }

        for (w in g.wings) out += PetShape.Oval(Part.Wing, w, Ink.Belly, Ink.Outline)
        for (a in g.arms) out += PetShape.Oval(Part.Arm, a, Ink.Body, Ink.Outline)
        for (f in g.feet) out += PetShape.Oval(Part.Foot, f, Ink.Outline)
        out += PetShape.Oval(Part.Body, g.body, Ink.Body, Ink.Outline)
        g.belly?.let { out += PetShape.Oval(Part.Belly, it, Ink.Belly) }
        for (a in g.antennae) {
            out += PetShape.Lines(Part.Antenna, listOf(a.from, a.to), Ink.Outline)
            out += if (a.star) PetShape.Polygon(Part.Antenna, starPoints(a.tip.x, a.tip.y, 5f, 2.2f), Ink.Accent)
            else PetShape.Circle(Part.Antenna, a.tip.x, a.tip.y, 4f, Ink.Accent)
        }
        g.eyes?.let { out += faceShapes(it, mood) }
        // Extras.
        g.crown?.let { out += PetShape.Polygon(Part.Crown, it, Ink.Gold, Ink.GoldDark, 1.5f) }
        for (s in g.sparkles) out += PetShape.Polygon(Part.Sparkle, sparklePoints(s.x, s.y, s.r), Ink.Sparkle)
        if (mood == Mood.Asleep) {
            // Up and to the right, clear of every antenna, star, crown and
            // sparkle; in the belly colour so they read on the dark card.
            out += PetShape.Lines(Part.Zzz, zPoints(74f, 26f, 6f), Ink.Belly, 2f)
            out += PetShape.Lines(Part.Zzz, zPoints(80f, 14f, 8f), Ink.Belly, 2f)
            out += PetShape.Lines(Part.Zzz, zPoints(88f, 2f, 10f), Ink.Belly, 2f)
        }
        return out
    }

    /** The tap heart (two circles and a triangle) centred on ([x], [y]). */
    fun heartShapes(x: Float = HEART_X, y: Float = HEART_Y): List<PetShape> = listOf(
        PetShape.Circle(Part.Heart, x - 3, y, 3.5f, Ink.Heart),
        PetShape.Circle(Part.Heart, x + 3, y, 3.5f, Ink.Heart),
        PetShape.Polygon(Part.Heart, listOf(Point(x - 6.3f, y + 1.5f), Point(x + 6.3f, y + 1.5f), Point(x, y + 9)), Ink.Heart),
    )

    // ── Motion ────────────────────────────────────────────────────────────

    /** The idle animation: asleep pets breathe (no bob), eggs wobble, the
     *  rest bob. Reduced-motion settings turn all of them off. */
    enum class Motion { Breathe, Wobble, Bob }

    fun motion(stage: Stage, mood: Mood): Motion = when {
        mood == Mood.Asleep -> Motion.Breathe
        stage == Stage.Egg -> Motion.Wobble
        else -> Motion.Bob
    }

    /** Idle bob: ±[BOB_UNITS] units, one way per half of a 2.4 s period, ease in-out. */
    const val BOB_UNITS = 2f
    const val BOB_HALF_MS = 1_200

    /** Asleep: scale 1 → [BREATHE_SCALE] and back over 3.2 s, ease in-out. */
    const val BREATHE_SCALE = 1.03f
    const val BREATHE_HALF_MS = 1_600

    /** The egg's wobble: one every 3 s. */
    const val WOBBLE_PERIOD_MS = 3_000

    /** Tap: the squash lasts 0.15 s and the heart 0.8 s. */
    const val SQUASH_MS = 150
    const val HEART_MS = 800

    private val WOBBLE_STOPS = floatArrayOf(0f, -4f, 4f, -4f, 0f)
    private const val WOBBLE_LEG_MS = 180f

    /** The egg's tilt (degrees, about the ground point) [ms] into its 3 s
     *  cycle: −4°, +4°, −4° and back to 0 over the first 0.72 s, each leg
     *  shaped by [ease] (ease in-out on screen), then still. */
    fun wobbleAngle(ms: Float, ease: (Float) -> Float = { it }): Float {
        val t = ms.mod(WOBBLE_PERIOD_MS.toFloat())
        val legs = WOBBLE_STOPS.size - 1
        if (t >= legs * WOBBLE_LEG_MS) return 0f
        val i = (t / WOBBLE_LEG_MS).toInt().coerceIn(0, legs - 1)
        val f = (t - i * WOBBLE_LEG_MS) / WOBBLE_LEG_MS
        return WOBBLE_STOPS[i] + (WOBBLE_STOPS[i + 1] - WOBBLE_STOPS[i]) * ease(f)
    }

    /** The tap squash [phase] (0–1) through it: (scaleX, scaleY), out to
     *  (1.04, 0.94) at the middle and back. */
    fun squashScale(phase: Float): Pair<Float, Float> {
        val p = phase.coerceIn(0f, 1f)
        val k = 1f - kotlin.math.abs(2f * p - 1f)
        return (1f + 0.04f * k) to (1f - 0.06f * k)
    }
}
