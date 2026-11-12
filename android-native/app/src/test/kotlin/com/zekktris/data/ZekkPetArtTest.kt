package com.zekktris.data

import com.zekktris.data.ZekkPet.Mood
import com.zekktris.data.ZekkPet.Stage
import com.zekktris.data.ZekkPetArt.Ellipse
import com.zekktris.data.ZekkPetArt.Ink
import com.zekktris.data.ZekkPetArt.Motion
import com.zekktris.data.ZekkPetArt.Part
import com.zekktris.data.ZekkPetArt.PetShape
import com.zekktris.data.ZekkPetArt.Point
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import kotlin.math.abs
import kotlin.math.hypot

/** The Zekk Pet's drawing as data (ZekkPetArt.kt): the theme colours, the
 *  geometry of every stage, the faces, the back-to-front order, and the
 *  motion curves. The same numbers web and iOS draw. */
class ZekkPetArtTest {
    private fun near(expected: Float, actual: Float, msg: String = "") =
        assertEquals(msg, expected.toDouble(), actual.toDouble(), 1e-4)

    private fun near(expected: Point, actual: Point, msg: String = "") {
        near(expected.x, actual.x, "$msg x"); near(expected.y, actual.y, "$msg y")
    }

    private fun hex(rgb: Int) = "#%06X".format(rgb and 0xFFFFFF)

    // ── Colours ─────────────────────────────────────────────────────────────

    /** Theme id → (accent, accent2) as ZkAccentSchemes has them (both
     *  ladders of a family share their accents), and the pet colours the
     *  spec expects: body, belly, outline, accent. */
    private val themes = listOf(
        listOf("default", "oled") to listOf(0x3DD7EC, 0x9D7BFF, "#3DD7EC", "#A8EDF6", "#18565E", "#9D7BFF"),
        listOf("sunset", "sunset-oled") to listOf(0xFF8A3D, 0xFFD13D, "#FF8A3D", "#FFCAA8", "#663718", "#FFD13D"),
        listOf("forest", "forest-oled") to listOf(0x3D9BFF, 0x4FDD8F, "#3D9BFF", "#A8D2FF", "#183E66", "#4FDD8F"),
        listOf("crimson", "crimson-oled") to listOf(0xFF4D4D, 0x9AA3B8, "#FF4D4D", "#FFAFAF", "#661F1F", "#9AA3B8"),
        listOf("blossom", "blossom-oled") to listOf(0xFF5FA2, 0xFFB088, "#FF5FA2", "#FFB7D5", "#662641", "#FFB088"),
        listOf("amethyst", "amethyst-oled") to listOf(0xA855F7, 0xF5B942, "#A855F7", "#D8B3FB", "#432263", "#F5B942"),
    )

    @Test fun colorsFollowTheTheme() {
        for ((ids, v) in themes) {
            val c = ZekkPetArt.colorsFor(v[0] as Int, v[1] as Int)
            assertEquals("$ids body", v[2], hex(c.body))
            assertEquals("$ids belly", v[3], hex(c.belly))
            assertEquals("$ids outline", v[4], hex(c.outline))
            assertEquals("$ids accent", v[5], hex(c.accent))
        }
        // Compose's toArgb() carries an opaque alpha byte; it's ignored.
        assertEquals(ZekkPetArt.colorsFor(0x3DD7EC, 0x9D7BFF), ZekkPetArt.colorsFor(0xFF3DD7EC.toInt(), 0xFF9D7BFF.toInt()))
    }

    @Test fun mixRoundsHalfUpPerChannel() {
        assertEquals(0xFFFFFF, ZekkPetArt.mix(0x000000, 0xFFFFFF, 100))
        assertEquals(0x123456, ZekkPetArt.mix(0x123456, 0xFFFFFF, 0))
        // 245 + 10·0.55 = 250.5 → 251; 1·0.4 = 0.4 → 0; 0x80·0.5 = 64.
        assertEquals(0xFB0000 or 0x00FF00 or 0x0000FF, ZekkPetArt.mix(0xF5FFFF, 0xFFFFFF, 55))
        assertEquals(0x000000, ZekkPetArt.mix(0x010101, 0x000000, 60))
        assertEquals(0x404040, ZekkPetArt.mix(0x808080, 0x000000, 50))
    }

    @Test fun fixedInks() {
        assertEquals("#1D1D2B", hex(ZekkPetArt.EYE))
        assertEquals("#FFFFFF", hex(ZekkPetArt.HIGHLIGHT))
        assertEquals("#8A2A3A", hex(ZekkPetArt.MOUTH))
        assertEquals("#6EC6FF", hex(ZekkPetArt.TEAR))
        assertEquals("#FFD54A", hex(ZekkPetArt.GOLD))
        assertEquals("#C99A00", hex(ZekkPetArt.GOLD_DARK))
        assertEquals("#FFE58A", hex(ZekkPetArt.SPARKLE))
        assertEquals("#FF5C8A", hex(ZekkPetArt.HEART))
        assertEquals(0.7f, ZekkPetArt.CHEEK_ALPHA, 0f)
        // The cheek is hsl(350, 85%, 75%), within a step per channel.
        val (h, s, l) = Triple(350.0, 0.85, 0.75)
        val c = (1 - abs(2 * l - 1)) * s
        val x = c * (1 - abs((h / 60) % 2 - 1))
        val m = l - c / 2
        val want = listOf(c + m, m, x + m).map { (it * 255).toInt() } // hue 300–360: (C, 0, X)
        val got = listOf(16, 8, 0).map { (ZekkPetArt.CHEEK shr it) and 0xFF }
        want.zip(got).forEach { (w, g) -> assertTrue("cheek $w vs $g", abs(w - g) <= 1) }
        // Every ink resolves: the theme's four, the fixed rest.
        val colors = ZekkPetArt.colorsFor(0x3DD7EC, 0x9D7BFF)
        assertEquals(colors.body, ZekkPetArt.rgbOf(Ink.Body, colors))
        assertEquals(colors.accent, ZekkPetArt.rgbOf(Ink.Accent, colors))
        assertEquals(ZekkPetArt.HEART, ZekkPetArt.rgbOf(Ink.Heart, colors))
    }

    // ── Geometry ────────────────────────────────────────────────────────────

    private fun e(cx: Number, cy: Number, rx: Number, ry: Number, rot: Number = 0) =
        Ellipse(cx.toFloat(), cy.toFloat(), rx.toFloat(), ry.toFloat(), rot.toFloat())

    @Test fun bodiesBelliesAndEyesPerStage() {
        val body = mapOf(
            Stage.Egg to e(50, 56, 26, 32), Stage.Baby to e(50, 60, 24, 22), Stage.Kid to e(50, 58, 27, 25),
            Stage.Teen to e(50, 56, 28, 29), Stage.Adult to e(50, 55, 31, 31), Stage.Legendary to e(50, 55, 31, 31),
        )
        val belly = mapOf(
            Stage.Baby to e(50, 66, 14, 10), Stage.Kid to e(50, 65, 16, 11), Stage.Teen to e(50, 64, 17, 13),
            Stage.Adult to e(50, 64, 19, 14), Stage.Legendary to e(50, 64, 19, 14),
        )
        val eyes = mapOf(
            Stage.Baby to listOf(41f, 59f, 56f, 4.5f), Stage.Kid to listOf(40f, 60f, 54f, 5f),
            Stage.Teen to listOf(40f, 60f, 51f, 5.5f), Stage.Adult to listOf(39f, 61f, 50f, 6f), Stage.Legendary to listOf(39f, 61f, 50f, 6f),
        )
        for (s in Stage.entries) {
            val g = ZekkPetArt.geometry(s)
            assertEquals("$s body", body[s], g.body)
            assertEquals("$s belly", belly[s], g.belly)
            assertEquals("$s eyes", eyes[s], g.eyes?.let { listOf(it.ex1, it.ex2, it.ey, it.er) })
        }
    }

    @Test fun limbsAntennaeAndExtras() {
        val kid = ZekkPetArt.geometry(Stage.Kid)
        assertEquals(listOf(e(38, 83, 7, 4), e(62, 83, 7, 4)), kid.feet)
        assertTrue(kid.arms.isEmpty() && kid.wings.isEmpty())
        assertEquals(1, kid.antennae.size)
        assertTrue(kid.antennae[0].star)
        assertEquals(Point(50f, 18f), kid.antennae[0].tip)

        val teen = ZekkPetArt.geometry(Stage.Teen)
        assertEquals(listOf(e(38, 85, 8, 4), e(62, 85, 8, 4)), teen.feet)
        assertEquals(listOf(e(22, 60, 5, 9, -20), e(78, 60, 5, 9, 20)), teen.arms)
        assertEquals(listOf(Point(35f, 14f), Point(65f, 14f)), teen.antennae.map { it.tip })
        assertTrue(teen.antennae.none { it.star })

        val adult = ZekkPetArt.geometry(Stage.Adult)
        assertEquals(listOf(e(24, 42, 12, 7, -30), e(76, 42, 12, 7, 30)), adult.wings)
        assertEquals(listOf(e(19, 58, 6, 10, -20), e(81, 58, 6, 10, 20)), adult.arms)
        assertEquals(listOf(e(37, 86, 9, 4.5), e(63, 86, 9, 4.5)), adult.feet)
        assertEquals(listOf(Point(42f, 26f) to Point(35f, 13f), Point(58f, 26f) to Point(65f, 13f)), adult.antennae.map { it.from to it.to })
        assertTrue(adult.antennae.all { it.star })
        assertNull(adult.crown)

        // Legendary: the adult without antennae, plus a crown and sparkles.
        val legend = ZekkPetArt.geometry(Stage.Legendary)
        assertTrue(legend.antennae.isEmpty())
        assertEquals(adult.wings, legend.wings)
        assertEquals(
            listOf(36 to 24, 40 to 12, 46 to 20, 50 to 8, 54 to 20, 60 to 12, 64 to 24).map { (x, y) -> Point(x.toFloat(), y.toFloat()) },
            legend.crown,
        )
        assertEquals(
            listOf(ZekkPetArt.Sparkle(14f, 24f, 5f), ZekkPetArt.Sparkle(86f, 30f, 4f), ZekkPetArt.Sparkle(82f, 78f, 3.5f), ZekkPetArt.Sparkle(16f, 72f, 3f)),
            legend.sparkles,
        )
    }

    // ── Shapes ──────────────────────────────────────────────────────────────

    @Test fun theEggHasSpotsNoFaceAndCracksNearTheEnd() {
        for (mood in Mood.entries) {
            val shapes = ZekkPetArt.shapes(Stage.Egg, mood, 0.5f)
            assertEquals(listOf(Part.Body, Part.Spot, Part.Spot, Part.Spot), shapes.map { it.part })
            val shell = shapes[0] as PetShape.Oval
            assertEquals(Ink.Belly, shell.fill)
            assertEquals(Ink.Outline, shell.stroke)
            near(2.5f, shell.strokeWidth)
            assertEquals(
                listOf(Triple(40f, 46f, 5f), Triple(60f, 60f, 6f), Triple(46f, 72f, 4f)),
                shapes.drop(1).map { (it as PetShape.Circle).let { c -> Triple(c.cx, c.cy, c.r) } },
            )
            assertTrue(shapes.drop(1).all { (it as PetShape.Circle).fill == Ink.Body })
        }
        assertTrue(ZekkPetArt.shapes(Stage.Egg, Mood.Happy, 0.79f).none { it.part == Part.Crack })
        val crack = ZekkPetArt.shapes(Stage.Egg, Mood.Happy, 0.8f).last() as PetShape.Lines
        assertEquals(Part.Crack, crack.part)
        assertEquals(Ink.Outline, crack.stroke)
        near(2f, crack.width)
        assertEquals(listOf(30f to 52f, 38f to 46f, 45f to 54f, 53f to 46f, 60f to 54f, 70f to 48f), crack.points.map { it.x to it.y })
    }

    @Test fun drawnBackToFront() {
        fun parts(s: Stage, m: Mood) = ZekkPetArt.shapes(s, m).map { it.part }.distinct()
        assertEquals(listOf(Part.Body, Part.Belly, Part.Antenna, Part.Face), parts(Stage.Baby, Mood.Happy))
        assertEquals(listOf(Part.Foot, Part.Body, Part.Belly, Part.Antenna, Part.Face), parts(Stage.Kid, Mood.Hungry))
        assertEquals(listOf(Part.Arm, Part.Foot, Part.Body, Part.Belly, Part.Antenna, Part.Face), parts(Stage.Teen, Mood.Lonely))
        assertEquals(listOf(Part.Wing, Part.Arm, Part.Foot, Part.Body, Part.Belly, Part.Antenna, Part.Face), parts(Stage.Adult, Mood.Grumpy))
        assertEquals(listOf(Part.Wing, Part.Arm, Part.Foot, Part.Body, Part.Belly, Part.Face, Part.Crown, Part.Sparkle), parts(Stage.Legendary, Mood.Happy))
        assertEquals(
            listOf(Part.Wing, Part.Arm, Part.Foot, Part.Body, Part.Belly, Part.Face, Part.Crown, Part.Sparkle, Part.Zzz),
            parts(Stage.Legendary, Mood.Asleep),
        )
        // Fills and outlines: wings belly-coloured, arms body-coloured, both
        // outlined; feet solid outline colour; the belly unstroked.
        val adult = ZekkPetArt.shapes(Stage.Adult, Mood.Happy)
        adult.filter { it.part == Part.Wing }.map { it as PetShape.Oval }.forEach { assertEquals(Ink.Belly, it.fill); assertEquals(Ink.Outline, it.stroke) }
        adult.filter { it.part == Part.Arm }.map { it as PetShape.Oval }.forEach { assertEquals(Ink.Body, it.fill); assertEquals(Ink.Outline, it.stroke) }
        adult.filter { it.part == Part.Foot }.map { it as PetShape.Oval }.forEach { assertEquals(Ink.Outline, it.fill); assertNull(it.stroke) }
        val bodyShape = adult.single { it.part == Part.Body } as PetShape.Oval
        assertEquals(Ink.Body to Ink.Outline, bodyShape.fill to bodyShape.stroke)
        assertNull((adult.single { it.part == Part.Belly } as PetShape.Oval).stroke)
        // Antennae: an outline stalk and an accent tip.
        val stalks = adult.filter { it.part == Part.Antenna }
        assertEquals(Ink.Outline, (stalks[0] as PetShape.Lines).stroke)
        assertEquals(Ink.Accent, (stalks[1] as PetShape.Polygon).fill)
        assertEquals(Ink.Accent, (ZekkPetArt.shapes(Stage.Baby, Mood.Happy).single { it is PetShape.Circle && it.part == Part.Antenna } as PetShape.Circle).fill)
        // The crown: gold with a dark-gold 1.5 outline.
        val crown = ZekkPetArt.shapes(Stage.Legendary, Mood.Happy).single { it.part == Part.Crown } as PetShape.Polygon
        assertEquals(Ink.Gold, crown.fill)
        assertEquals(Ink.GoldDark, crown.stroke)
        near(1.5f, crown.strokeWidth)
    }

    @Test fun everyStageAndMoodDraws() {
        for (s in Stage.entries) for (m in Mood.entries) {
            val shapes = ZekkPetArt.shapes(s, m, 1f)
            assertTrue("$s $m", shapes.isNotEmpty())
            val zs = shapes.filter { it.part == Part.Zzz }.map { it as PetShape.Lines }
            if (m == Mood.Asleep && s != Stage.Egg) {
                // Three Z's, each as wide as it is tall: 6, 8, 10.
                assertEquals(listOf(6f, 8f, 10f), zs.map { it.points[1].x - it.points[0].x })
                assertEquals(listOf(6f, 8f, 10f), zs.map { it.points[3].y - it.points[0].y })
                assertEquals(listOf(Point(74f, 26f), Point(80f, 14f), Point(88f, 2f)), zs.map { it.points[0] })
                zs.forEach { assertEquals(Ink.Belly, it.stroke); near(2f, it.width) }
            } else {
                assertTrue("$s $m", zs.isEmpty())
            }
        }
    }

    // ── Faces ───────────────────────────────────────────────────────────────

    private val babyEyes = ZekkPetArt.geometry(Stage.Baby).eyes!! // er 4.5 → sc 0.9, my = 66.8

    @Test fun happyFace() {
        val f = ZekkPetArt.faceShapes(babyEyes, Mood.Happy)
        val cheeks = f.take(2).map { it as PetShape.Circle }
        near(41 - 3.6f, cheeks[0].cx); near(56 + 6.3f, cheeks[0].cy); near(3.6f, cheeks[0].r)
        near(59 + 3.6f, cheeks[1].cx)
        assertTrue(cheeks.all { it.fill == Ink.Cheek && it.alpha == 0.7f })
        val eye = f[2] as PetShape.Circle
        assertEquals(Ink.Eye, eye.fill); near(41f, eye.cx); near(56f, eye.cy); near(4.5f, eye.r)
        val glint = f[3] as PetShape.Circle
        assertEquals(Ink.Highlight, glint.fill); near(41 - 1.575f, glint.cx); near(56 - 1.575f, glint.cy); near(1.575f, glint.r)
        val smile = f.last() as PetShape.Curve
        near(Point(50 - 7.2f, 66.8f), smile.from); near(Point(50f, 66.8f + 6.3f), smile.control); near(Point(57.2f, 66.8f), smile.to)
        assertEquals(Ink.Eye, smile.stroke); near(2.5f, smile.width)
    }

    @Test fun thrivingFace() {
        val f = ZekkPetArt.faceShapes(babyEyes, Mood.Thriving)
        val arches = f.filterIsInstance<PetShape.Curve>()
        near(Point(41 - 4.5f, 57f), arches[0].from); near(Point(41f, 56 - 4.5f), arches[0].control); near(Point(41 + 4.5f, 57f), arches[0].to)
        val mouth = f.single { it is PetShape.HalfOval } as PetShape.HalfOval
        near(50f, mouth.cx); near(66.8f, mouth.cy); near(8.1f, mouth.rx); near(6.3f, mouth.ry)
        assertEquals(Ink.Mouth, mouth.fill)
        val sparkles = f.filter { it.part == Part.Sparkle }.map { it as PetShape.Polygon }
        assertEquals(2, sparkles.size)
        near(Point(20f, 37f), sparkles[0].points[0]) // (20, 40) r3, point up
        near(Point(80f, 41.5f), sparkles[1].points[0]) // (80, 44) r2.5
        assertTrue(sparkles.all { it.fill == Ink.Sparkle })
        assertEquals(2, f.count { it is PetShape.Circle && it.fill == Ink.Cheek })
    }

    @Test fun lonelyHungryGrumpyAsleepFaces() {
        val lonely = ZekkPetArt.faceShapes(babyEyes, Mood.Lonely)
        near(57f, (lonely[0] as PetShape.Circle).cy) // eyes down 1
        val frown = lonely.single { it is PetShape.Curve } as PetShape.Curve
        near(Point(50 - 5.4f, 66.8f + 2.7f), frown.from); near(Point(50f, 66.8f - 2.7f), frown.control)
        val tear = lonely.last() as PetShape.Oval
        assertEquals(Ink.Tear, tear.fill)
        near(61.7f, tear.e.cx); near(63.5f, tear.e.cy); near(2f, tear.e.rx); near(3f, tear.e.ry)
        assertTrue(lonely.none { it is PetShape.Circle && it.fill == Ink.Cheek })

        val hungry = ZekkPetArt.faceShapes(babyEyes, Mood.Hungry)
        val (mouth, drool) = hungry.takeLast(2).map { it as PetShape.Oval }
        assertEquals(Ink.Mouth, mouth.fill)
        near(50f, mouth.e.cx); near(67.8f, mouth.e.cy); near(4.5f, mouth.e.rx); near(5.4f, mouth.e.ry)
        assertEquals(Ink.Tear, drool.fill)
        near(53.6f, drool.e.cx); near(66.8f + 6.3f, drool.e.cy); near(1.5f, drool.e.rx); near(2.5f, drool.e.ry)

        val grumpy = ZekkPetArt.faceShapes(babyEyes, Mood.Grumpy)
        val brows = grumpy.filterIsInstance<PetShape.Lines>()
        assertEquals(2, brows.size)
        near(Point(41 - 4.5f - 1, 56 - 4.5f - 4), brows[0].points[0]); near(Point(41 + 4.5f, 56 - 4.5f - 1), brows[0].points[1])
        near(Point(59 + 4.5f + 1, 56 - 4.5f - 4), brows[1].points[0]); near(Point(59 - 4.5f, 56 - 4.5f - 1), brows[1].points[1])
        val flat = grumpy.last() as PetShape.Curve
        near(Point(50 - 6.3f, 68.8f), flat.from); near(Point(50f, 64.8f), flat.control); near(Point(56.3f, 68.8f), flat.to)

        val asleep = ZekkPetArt.faceShapes(babyEyes, Mood.Asleep)
        val lids = asleep.filterIsInstance<PetShape.Curve>()
        near(Point(41 - 4.5f, 56f), lids[0].from); near(Point(41f, 60.5f), lids[0].control); near(Point(45.5f, 56f), lids[0].to)
        val o = asleep.last() as PetShape.Circle
        assertEquals(Ink.Mouth, o.fill); near(50f, o.cx); near(67.8f, o.cy); near(1.8f, o.r)
        assertTrue(asleep.none { it is PetShape.Circle && it.fill == Ink.Eye })
    }

    // ── Primitives ──────────────────────────────────────────────────────────

    @Test fun starsSparklesAndZs() {
        val star = ZekkPetArt.starPoints(50f, 18f, 5f, 2.2f)
        assertEquals(10, star.size)
        near(Point(50f, 13f), star[0]) // one point straight up
        star.forEachIndexed { i, p -> near(if (i % 2 == 0) 5f else 2.2f, hypot((p.x - 50f).toDouble(), (p.y - 18f).toDouble()).toFloat(), "star $i") }
        val sparkle = ZekkPetArt.sparklePoints(14f, 24f, 5f)
        assertEquals(8, sparkle.size)
        near(Point(14f, 19f), sparkle[0]); near(Point(19f, 24f), sparkle[2]); near(Point(14f, 29f), sparkle[4])
        near(2f, hypot((sparkle[1].x - 14f).toDouble(), (sparkle[1].y - 24f).toDouble()).toFloat())
        assertEquals(listOf(Point(66f, 30f), Point(72f, 30f), Point(66f, 36f), Point(72f, 36f)), ZekkPetArt.zPoints(66f, 30f, 6f))
    }

    @Test fun tapHeart() {
        val heart = ZekkPetArt.heartShapes()
        assertTrue(heart.all { it.part == Part.Heart })
        val (l, r) = heart.take(2).map { it as PetShape.Circle }
        assertEquals(listOf(47f, 26f, 3.5f), listOf(l.cx, l.cy, l.r))
        assertEquals(listOf(53f, 26f, 3.5f), listOf(r.cx, r.cy, r.r))
        val tip = heart[2] as PetShape.Polygon
        near(Point(43.7f, 27.5f), tip.points[0]); near(Point(56.3f, 27.5f), tip.points[1]); near(Point(50f, 35f), tip.points[2])
        assertTrue(heart.all { ((it as? PetShape.Circle)?.fill ?: (it as PetShape.Polygon).fill) == Ink.Heart })
        assertEquals(20f, ZekkPetArt.HEART_RISE, 0f)
        assertEquals(800, ZekkPetArt.HEART_MS)
    }

    // ── Motion ──────────────────────────────────────────────────────────────

    @Test fun motionPerStageAndMood() {
        for (s in Stage.entries) assertEquals(Motion.Breathe, ZekkPetArt.motion(s, Mood.Asleep))
        assertEquals(Motion.Wobble, ZekkPetArt.motion(Stage.Egg, Mood.Happy))
        for (s in Stage.entries.drop(1)) for (m in Mood.entries.filter { it != Mood.Asleep }) assertEquals(Motion.Bob, ZekkPetArt.motion(s, m))
        // Bob ±2 over 2.4 s; breathe to 1.03 over 3.2 s; wobble every 3 s.
        assertEquals(2f, ZekkPetArt.BOB_UNITS, 0f)
        assertEquals(2_400, 2 * ZekkPetArt.BOB_HALF_MS)
        assertEquals(1.03f, ZekkPetArt.BREATHE_SCALE, 0f)
        assertEquals(3_200, 2 * ZekkPetArt.BREATHE_HALF_MS)
        assertEquals(3_000, ZekkPetArt.WOBBLE_PERIOD_MS)
        assertEquals(150, ZekkPetArt.SQUASH_MS)
    }

    @Test fun wobbleTiltsThenRests() {
        mapOf(0f to 0f, 90f to -2f, 180f to -4f, 270f to 0f, 360f to 4f, 540f to -4f, 630f to -2f, 720f to 0f, 1_500f to 0f, 2_999f to 0f, 3_180f to -4f)
            .forEach { (ms, deg) -> near(deg, ZekkPetArt.wobbleAngle(ms), "$ms ms") }
        // The easing shapes each leg, keeping its ends.
        near(-4f, ZekkPetArt.wobbleAngle(180f) { it * it })
        near(-1f, ZekkPetArt.wobbleAngle(90f) { it * it })
    }

    @Test fun squashOutAndBack() {
        assertEquals(1f to 1f, ZekkPetArt.squashScale(0f))
        val (sx, sy) = ZekkPetArt.squashScale(0.5f)
        near(1.04f, sx); near(0.94f, sy)
        assertEquals(1f to 1f, ZekkPetArt.squashScale(1f))
        assertFalse(ZekkPetArt.squashScale(0.25f).first == 1f)
        // The ground point everything turns about.
        assertEquals(50f to 88f, ZekkPetArt.GROUND_X to ZekkPetArt.GROUND_Y)
    }
}
