import SwiftUI

// ═══════════════════════════════════════════════════════════════════════════
// Zekk Pet — the art, the header pet, the adopt banner and the pet card.
// ═══════════════════════════════════════════════════════════════════════════
//
// One original creature, drawn natively from the SAME 100×100 geometry as the
// web (apps/web/src/lib/petArt.ts) and Android, back to front: wings, arms,
// feet, body, belly, antennae, face, extras. Its colours follow the VIEWER's
// Appearance theme (ZekkPetPalette, from a theme id — never the static
// Theme.current, which goes stale inside Equatable rows such as MessageRow),
// so it recolours the moment they switch themes. The words and the state come
// from ZekkPet and AppStore (Models.swift / AppStore.swift); the server
// decides everything shown here.

// MARK: - Colours

/// The inks that are the same in every theme (the theme-derived body, belly,
/// outline and accent are ZekkPetPalette, in Theme.swift).
private enum PetInk {
    static let eye = Color(hex: 0x1D1D2B)
    static let highlight = Color(hex: 0xFFFFFF)
    /// hsl(350, 85%, 75%), drawn at 70%.
    static let cheek = Color(.sRGB, red: 0.9625, green: 0.5375, blue: 0.6083, opacity: 0.7)
    static let mouth = Color(hex: 0x8A2A3A)
    static let tear = Color(hex: 0x6EC6FF)
    static let gold = Color(hex: 0xFFD54A)
    static let goldDark = Color(hex: 0xC99A00)
    static let sparkle = Color(hex: 0xFFE58A)
    static let heart = Color(hex: 0xFF5C8A)
}

// MARK: - Geometry and drawing

/// The pet as drawing commands in its 100-unit box (y down, like SVG).
enum ZekkPetDrawing {
    /// An ellipse turned `rotate` degrees (clockwise on screen) about its centre.
    struct Ellipse {
        let cx: CGFloat
        let cy: CGFloat
        let rx: CGFloat
        let ry: CGFloat
        var rotate: CGFloat = 0
    }

    struct Antenna {
        let from: CGPoint
        let to: CGPoint
        let tip: CGPoint
        /// A 5-point star (outer r5, inner r2.2); otherwise a ball (r4).
        let star: Bool
    }

    struct Eyes {
        let ex1: CGFloat
        let ex2: CGFloat
        let ey: CGFloat
        let er: CGFloat
    }

    struct Sparkle {
        let x: CGFloat
        let y: CGFloat
        let r: CGFloat
    }

    struct Geometry {
        var body: Ellipse
        /// nil on the egg.
        var belly: Ellipse?
        /// nil on the egg (no face).
        var eyes: Eyes?
        var feet: [Ellipse]
        var arms: [Ellipse]
        var wings: [Ellipse]
        var antennae: [Antenna]
        /// Legendary only.
        var crown: [CGPoint]
        /// Legendary only: 4-point sparkles around the pet.
        var sparkles: [Sparkle]
    }

    /// The point the egg wobbles around and the pet breathes / squashes from
    /// (just under the feet).
    static let ground = CGPoint(x: 50, y: 88)
    /// Where the tap heart starts, and how far it rises while it fades.
    static let heartOrigin = CGPoint(x: 50, y: 26)
    static let heartRise: CGFloat = 20
    /// Egg progress (towards level 1) from which the shell shows a crack.
    static let crackAt = 0.8
    /// Body / limb outline and every stroked face line.
    static let outlineWidth: CGFloat = 2.5
    /// Room drawn past each side of the 100-unit box. The breathe and the
    /// tap squash scale the whole pet about the ground point, sleeping Zs
    /// included, which carries the largest Z's top bar up to about −1.6 and
    /// its right end out to about 102.5; a Canvas clips at its own bounds.
    static let overscan: CGFloat = 3

    private static func pt(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: x, y: y) }

    private static let adult = Geometry(
        body: Ellipse(cx: 50, cy: 55, rx: 31, ry: 31),
        belly: Ellipse(cx: 50, cy: 64, rx: 19, ry: 14),
        eyes: Eyes(ex1: 39, ex2: 61, ey: 50, er: 6),
        feet: [Ellipse(cx: 37, cy: 86, rx: 9, ry: 4.5), Ellipse(cx: 63, cy: 86, rx: 9, ry: 4.5)],
        arms: [Ellipse(cx: 19, cy: 58, rx: 6, ry: 10, rotate: -20),
               Ellipse(cx: 81, cy: 58, rx: 6, ry: 10, rotate: 20)],
        wings: [Ellipse(cx: 24, cy: 42, rx: 12, ry: 7, rotate: -30),
                Ellipse(cx: 76, cy: 42, rx: 12, ry: 7, rotate: 30)],
        antennae: [Antenna(from: pt(42, 26), to: pt(35, 13), tip: pt(34, 11), star: true),
                   Antenna(from: pt(58, 26), to: pt(65, 13), tip: pt(66, 11), star: true)],
        crown: [],
        sparkles: [])

    static func geometry(_ stage: PetStage) -> Geometry {
        switch stage {
        case .egg:
            return Geometry(body: Ellipse(cx: 50, cy: 56, rx: 26, ry: 32), belly: nil, eyes: nil,
                            feet: [], arms: [], wings: [], antennae: [], crown: [], sparkles: [])
        case .baby:
            return Geometry(
                body: Ellipse(cx: 50, cy: 60, rx: 24, ry: 22),
                belly: Ellipse(cx: 50, cy: 66, rx: 14, ry: 10),
                eyes: Eyes(ex1: 41, ex2: 59, ey: 56, er: 4.5),
                feet: [], arms: [], wings: [],
                antennae: [Antenna(from: pt(50, 38), to: pt(50, 26), tip: pt(50, 24), star: false)],
                crown: [], sparkles: [])
        case .kid:
            return Geometry(
                body: Ellipse(cx: 50, cy: 58, rx: 27, ry: 25),
                belly: Ellipse(cx: 50, cy: 65, rx: 16, ry: 11),
                eyes: Eyes(ex1: 40, ex2: 60, ey: 54, er: 5),
                feet: [Ellipse(cx: 38, cy: 83, rx: 7, ry: 4), Ellipse(cx: 62, cy: 83, rx: 7, ry: 4)],
                arms: [], wings: [],
                antennae: [Antenna(from: pt(50, 33), to: pt(50, 21), tip: pt(50, 18), star: true)],
                crown: [], sparkles: [])
        case .teen:
            return Geometry(
                body: Ellipse(cx: 50, cy: 56, rx: 28, ry: 29),
                belly: Ellipse(cx: 50, cy: 64, rx: 17, ry: 13),
                eyes: Eyes(ex1: 40, ex2: 60, ey: 51, er: 5.5),
                feet: [Ellipse(cx: 38, cy: 85, rx: 8, ry: 4), Ellipse(cx: 62, cy: 85, rx: 8, ry: 4)],
                arms: [Ellipse(cx: 22, cy: 60, rx: 5, ry: 9, rotate: -20),
                       Ellipse(cx: 78, cy: 60, rx: 5, ry: 9, rotate: 20)],
                wings: [],
                antennae: [Antenna(from: pt(42, 29), to: pt(36, 16), tip: pt(35, 14), star: false),
                           Antenna(from: pt(58, 29), to: pt(64, 16), tip: pt(65, 14), star: false)],
                crown: [], sparkles: [])
        case .adult:
            return adult
        case .legendary:
            var g = adult
            g.antennae = []
            g.crown = [pt(36, 24), pt(40, 12), pt(46, 20), pt(50, 8), pt(54, 20), pt(60, 12), pt(64, 24)]
            g.sparkles = [Sparkle(x: 14, y: 24, r: 5), Sparkle(x: 86, y: 30, r: 4),
                          Sparkle(x: 82, y: 78, r: 3.5), Sparkle(x: 16, y: 72, r: 3)]
            return g
        }
    }

    // MARK: Shapes

    private static func ellipse(_ e: Ellipse) -> Path {
        let base = Path(ellipseIn: CGRect(x: -e.rx, y: -e.ry, width: 2 * e.rx, height: 2 * e.ry))
        let turn = CGAffineTransform(rotationAngle: e.rotate * .pi / 180)
            .concatenating(CGAffineTransform(translationX: e.cx, y: e.cy))
        return base.applying(turn)
    }

    private static func ellipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> Path {
        Path(ellipseIn: CGRect(x: cx - rx, y: cy - ry, width: 2 * rx, height: 2 * ry))
    }

    private static func circle(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> Path {
        ellipse(cx, cy, r, r)
    }

    private static func polygon(_ points: [CGPoint]) -> Path {
        var p = Path()
        p.addLines(points)
        p.closeSubpath()
        return p
    }

    private static func polyline(_ points: [CGPoint]) -> Path {
        var p = Path()
        p.addLines(points)
        return p
    }

    private static func line(_ x1: CGFloat, _ y1: CGFloat, _ x2: CGFloat, _ y2: CGFloat) -> Path {
        polyline([pt(x1, y1), pt(x2, y2)])
    }

    private static func quad(_ x1: CGFloat, _ y1: CGFloat, _ cx: CGFloat, _ cy: CGFloat,
                             _ x2: CGFloat, _ y2: CGFloat) -> Path {
        var p = Path()
        p.move(to: pt(x1, y1))
        p.addQuadCurve(to: pt(x2, y2), control: pt(cx, cy))
        return p
    }

    /// The lower half of an ellipse, closed along its top (the open smile).
    private static func lowerHalfEllipse(_ cx: CGFloat, _ cy: CGFloat, _ rx: CGFloat, _ ry: CGFloat) -> Path {
        let k: CGFloat = 0.5522847498 // quarter-ellipse Bézier handle
        var p = Path()
        p.move(to: pt(cx - rx, cy))
        p.addCurve(to: pt(cx, cy + ry), control1: pt(cx - rx, cy + k * ry), control2: pt(cx - k * rx, cy + ry))
        p.addCurve(to: pt(cx + rx, cy), control1: pt(cx + k * rx, cy + ry), control2: pt(cx + rx, cy + k * ry))
        p.closeSubpath()
        return p
    }

    /// A 5-point star, one point straight up.
    static func starPoints(_ c: CGPoint, outer: CGFloat, inner: CGFloat) -> [CGPoint] {
        (0..<10).map { i in
            let r = i % 2 == 0 ? outer : inner
            let a = (-90 + CGFloat(i) * 36) * .pi / 180
            return pt(c.x + r * cos(a), c.y + r * sin(a))
        }
    }

    /// A 4-point sparkle: points on the axes at `r`, waists at 45° at 0.4·r.
    static func sparklePoints(_ cx: CGFloat, _ cy: CGFloat, _ r: CGFloat) -> [CGPoint] {
        (0..<8).map { i in
            let d = i % 2 == 0 ? r : r * 0.4
            let a = (-90 + CGFloat(i) * 45) * .pi / 180
            return pt(cx + d * cos(a), cy + d * sin(a))
        }
    }

    /// A "Z" `s` wide and `s` tall from its top-left corner.
    static func zPoints(_ x: CGFloat, _ y: CGFloat, _ s: CGFloat) -> [CGPoint] {
        [pt(x, y), pt(x + s, y), pt(x, y + s), pt(x + s, y + s)]
    }

    // MARK: Drawing

    /// Draw the pet into `ctx`, whose transform already maps the 100-unit box.
    /// `progress` (0–1 towards the next level) only matters on the egg: from
    /// `crackAt` the shell cracks.
    static func draw(stage: PetStage, mood: PetMood, progress: Double,
                     palette p: ZekkPetPalette, in ctx: GraphicsContext) {
        let body = Color(hex: p.body)
        let belly = Color(hex: p.belly)
        let outline = Color(hex: p.outline)
        let accent = Color(hex: p.accent)
        let round = StrokeStyle(lineWidth: outlineWidth, lineCap: .round, lineJoin: .round)
        let thin = StrokeStyle(lineWidth: 2, lineCap: .round, lineJoin: .round)
        let g = geometry(stage)

        if stage == .egg {
            let shell = ellipse(g.body)
            ctx.fill(shell, with: .color(belly))
            ctx.stroke(shell, with: .color(outline), lineWidth: outlineWidth)
            ctx.fill(circle(40, 46, 5), with: .color(body))
            ctx.fill(circle(60, 60, 6), with: .color(body))
            ctx.fill(circle(46, 72, 4), with: .color(body))
            if progress >= crackAt {
                let crack = [pt(30, 52), pt(38, 46), pt(45, 54), pt(53, 46), pt(60, 54), pt(70, 48)]
                ctx.stroke(polyline(crack), with: .color(outline), style: thin)
            }
            return
        }

        for w in g.wings {
            let path = ellipse(w)
            ctx.fill(path, with: .color(belly))
            ctx.stroke(path, with: .color(outline), lineWidth: outlineWidth)
        }
        for a in g.arms {
            let path = ellipse(a)
            ctx.fill(path, with: .color(body))
            ctx.stroke(path, with: .color(outline), lineWidth: outlineWidth)
        }
        for f in g.feet { ctx.fill(ellipse(f), with: .color(outline)) }
        let torso = ellipse(g.body)
        ctx.fill(torso, with: .color(body))
        ctx.stroke(torso, with: .color(outline), lineWidth: outlineWidth)
        if let b = g.belly { ctx.fill(ellipse(b), with: .color(belly)) }
        for a in g.antennae {
            ctx.stroke(polyline([a.from, a.to]), with: .color(outline), style: round)
            let tip = a.star ? polygon(starPoints(a.tip, outer: 5, inner: 2.2)) : circle(a.tip.x, a.tip.y, 4)
            ctx.fill(tip, with: .color(accent))
        }
        if let e = g.eyes { drawFace(e, mood: mood, in: ctx) }
        // Extras.
        if !g.crown.isEmpty {
            let crown = polygon(g.crown)
            ctx.fill(crown, with: .color(PetInk.gold))
            ctx.stroke(crown, with: .color(PetInk.goldDark), style: StrokeStyle(lineWidth: 1.5, lineJoin: .round))
        }
        for s in g.sparkles { ctx.fill(polygon(sparklePoints(s.x, s.y, s.r)), with: .color(PetInk.sparkle)) }
        if mood == .asleep {
            // In the belly colour: readable on the dark card, and clear of
            // every antenna, star, crown and sparkle at every stage.
            let zs: [(x: CGFloat, y: CGFloat, size: CGFloat)] = [(74, 26, 6), (80, 14, 8), (88, 2, 10)]
            for z in zs {
                ctx.stroke(polyline(zPoints(z.x, z.y, z.size)), with: .color(belly), style: thin)
            }
        }
    }

    /// The face for `mood` (sc = er/5; the mouth centre sits at ey + 12·sc).
    /// Cheeks go first so the eyes sit on top of them.
    private static func drawFace(_ e: Eyes, mood: PetMood, in ctx: GraphicsContext) {
        let sc = e.er / 5
        let my = e.ey + 12 * sc
        let stroke = StrokeStyle(lineWidth: outlineWidth, lineCap: .round, lineJoin: .round)
        let eye = GraphicsContext.Shading.color(PetInk.eye)

        func cheeks() {
            ctx.fill(circle(e.ex1 - 4 * sc, e.ey + 7 * sc, 4 * sc), with: .color(PetInk.cheek))
            ctx.fill(circle(e.ex2 + 4 * sc, e.ey + 7 * sc, 4 * sc), with: .color(PetInk.cheek))
        }
        func roundEyes(_ dy: CGFloat) {
            for ex in [e.ex1, e.ex2] {
                ctx.fill(circle(ex, e.ey + dy, e.er), with: eye)
                ctx.fill(circle(ex - 0.35 * e.er, e.ey + dy - 0.35 * e.er, 0.35 * e.er),
                         with: .color(PetInk.highlight))
            }
        }

        switch mood {
        case .thriving:
            cheeks()
            for ex in [e.ex1, e.ex2] {
                ctx.stroke(quad(ex - e.er, e.ey + 1, ex, e.ey - e.er, ex + e.er, e.ey + 1), with: eye, style: stroke)
            }
            ctx.fill(lowerHalfEllipse(50, my, 9 * sc, 7 * sc), with: .color(PetInk.mouth))
            ctx.fill(polygon(sparklePoints(20, 40, 3)), with: .color(PetInk.sparkle))
            ctx.fill(polygon(sparklePoints(80, 44, 2.5)), with: .color(PetInk.sparkle))
        case .lonely:
            roundEyes(1)
            ctx.stroke(quad(50 - 6 * sc, my + 3 * sc, 50, my - 3 * sc, 50 + 6 * sc, my + 3 * sc),
                       with: eye, style: stroke)
            ctx.fill(ellipse(e.ex2 + 0.6 * e.er, e.ey + e.er + 3, 2, 3), with: .color(PetInk.tear))
        case .hungry:
            roundEyes(0)
            ctx.fill(ellipse(50, my + 1, 5 * sc, 6 * sc), with: .color(PetInk.mouth))
            ctx.fill(ellipse(50 + 4 * sc, my + 7 * sc, 1.5, 2.5), with: .color(PetInk.tear))
        case .grumpy:
            roundEyes(0)
            ctx.stroke(line(e.ex1 - e.er - 1, e.ey - e.er - 4, e.ex1 + e.er, e.ey - e.er - 1), with: eye, style: stroke)
            ctx.stroke(line(e.ex2 + e.er + 1, e.ey - e.er - 4, e.ex2 - e.er, e.ey - e.er - 1), with: eye, style: stroke)
            ctx.stroke(quad(50 - 7 * sc, my + 2, 50, my - 2, 50 + 7 * sc, my + 2), with: eye, style: stroke)
        case .asleep:
            for ex in [e.ex1, e.ex2] {
                ctx.stroke(quad(ex - e.er, e.ey, ex, e.ey + e.er, ex + e.er, e.ey), with: eye, style: stroke)
            }
            ctx.fill(circle(50, my + 1, 2 * sc), with: .color(PetInk.mouth))
        case .happy:
            cheeks()
            roundEyes(0)
            ctx.stroke(quad(50 - 8 * sc, my, 50, my + 7 * sc, 50 + 8 * sc, my), with: eye, style: stroke)
        }
    }

    /// The tap heart (two circles and a triangle) `elapsed` seconds into its
    /// 0.8 s: it rises 20 units (unless `rise` is off for Reduce Motion) as
    /// it fades, eased out.
    static func drawHeart(elapsed: Double, rise: Bool, in base: GraphicsContext) {
        let u = min(max(elapsed / 0.8, 0), 1)
        let eased = 1 - (1 - u) * (1 - u)
        var ctx = base
        ctx.opacity = 1 - eased
        if rise { ctx.translateBy(x: 0, y: -heartRise * CGFloat(eased)) }
        let x = heartOrigin.x
        let y = heartOrigin.y
        let ink = GraphicsContext.Shading.color(PetInk.heart)
        ctx.fill(circle(x - 3, y, 3.5), with: ink)
        ctx.fill(circle(x + 3, y, 3.5), with: ink)
        ctx.fill(polygon([pt(x - 6.3, y + 1.5), pt(x + 6.3, y + 1.5), pt(x, y + 9)]), with: ink)
    }

    // MARK: Motion

    enum Motion { case bob, breathe, wobble }

    /// Asleep pets breathe (no bob), eggs wobble, the rest bob.
    static func motion(stage: PetStage, mood: PetMood) -> Motion {
        if mood == .asleep { return .breathe }
        if stage == .egg { return .wobble }
        return .bob
    }

    /// The egg's wobble at `t` seconds: once every 3 s, −4° → +4° → −4° → 0
    /// over the first 0.72 s (eased between each), still the rest of the time.
    static func wobbleDegrees(_ t: Double) -> Double {
        let phase = t.truncatingRemainder(dividingBy: 3) / 3
        guard phase >= 0, phase < 0.24 else { return 0 }
        let keys: [Double] = [0, -4, 4, -4, 0]
        let seg = phase / 0.06
        let i = min(Int(seg), 3)
        let eased = (1 - cos(.pi * (seg - Double(i)))) / 2
        return keys[i] + (keys[i + 1] - keys[i]) * eased
    }

    /// Move `ctx` by the idle motion at `t` seconds: a ±2-unit bob every
    /// 2.4 s, a 1 → 1.03 breathe every 3.2 s, or the egg's wobble — the last
    /// two about the ground point.
    static func applyIdle(_ motion: Motion, t: Double, to ctx: inout GraphicsContext) {
        switch motion {
        case .bob:
            ctx.translateBy(x: 0, y: CGFloat(-2 * cos(2 * .pi * t / 2.4)))
        case .breathe:
            let s = CGFloat(1 + 0.015 * (1 - cos(2 * .pi * t / 3.2)))
            ctx.translateBy(x: ground.x, y: ground.y)
            ctx.scaleBy(x: s, y: s)
            ctx.translateBy(x: -ground.x, y: -ground.y)
        case .wobble:
            ctx.translateBy(x: ground.x, y: ground.y)
            ctx.rotate(by: .degrees(wobbleDegrees(t)))
            ctx.translateBy(x: -ground.x, y: -ground.y)
        }
    }

    /// The tap squash `elapsed` seconds into its 0.15 s: out to scaleX 1.04 /
    /// scaleY 0.94 and back, about the ground point.
    static func applySquash(elapsed: Double, to ctx: inout GraphicsContext) {
        guard elapsed >= 0, elapsed < 0.15 else { return }
        let k = CGFloat(sin(.pi * elapsed / 0.15))
        ctx.translateBy(x: ground.x, y: ground.y)
        ctx.scaleBy(x: 1 + 0.04 * k, y: 1 - 0.06 * k)
        ctx.translateBy(x: -ground.x, y: -ground.y)
    }
}

// MARK: - The art view

/// One tap heart floating up from the pet card's pet.
struct ZekkPetHeart: Identifiable, Equatable {
    let id: Int
    let start: Date
}

/// The pet, drawn natively in the viewer's theme colours and scaled to the
/// frame it's given. Idle motion (the bob, a slow breathe while asleep, the
/// egg's wobble) runs unless Reduce Motion is on or `animated` is false
/// (tiny glyphs). `squashAt` / `hearts` are the pet card's tap reactions.
struct ZekkPetArt: View {
    let stage: PetStage
    let mood: PetMood
    /// 0–1 towards the next level (the egg cracks from 0.8).
    var progress: Double = 0
    /// The viewer's theme (store.themeId).
    let themeId: String
    var animated: Bool = true
    /// Fewest seconds between frames — a small header glyph needn't run at
    /// the display's full rate. nil = every frame.
    var frameInterval: Double? = nil
    /// When the pet was last tapped (replays the squash).
    var squashAt: Date? = nil
    var hearts: [ZekkPetHeart] = []
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let palette = ZekkPetPalette.forTheme(themeId)
        let still = reduceMotion
        let idle = animated && !still
        if idle || squashAt != nil || !hearts.isEmpty {
            TimelineView(.animation(minimumInterval: frameInterval, paused: false)) { timeline in
                canvas(palette, at: timeline.date, idle: idle, still: still)
            }
        } else {
            canvas(palette, at: Date(), idle: false, still: still)
        }
    }

    private func canvas(_ palette: ZekkPetPalette, at date: Date, idle: Bool, still: Bool) -> some View {
        let stage = self.stage
        let mood = self.mood
        let progress = self.progress
        let squashAt = self.squashAt
        let hearts = self.hearts
        let margin = ZekkPetDrawing.overscan
        return GeometryReader { geo in
            // The 100-unit box still fills the frame given; the Canvas
            // reaches `margin` units past it on every side, so nothing the
            // motion carries out of the box is cut off. Layout is unchanged.
            let pad = min(geo.size.width, geo.size.height) * margin / 100
            Canvas { ctx, size in
                let s = min(size.width, size.height) / (100 + 2 * margin)
                ctx.translateBy(x: (size.width - 100 * s) / 2, y: (size.height - 100 * s) / 2)
                ctx.scaleBy(x: s, y: s)
                var pet = ctx
                if idle {
                    ZekkPetDrawing.applyIdle(ZekkPetDrawing.motion(stage: stage, mood: mood),
                                             t: date.timeIntervalSinceReferenceDate, to: &pet)
                }
                if !still, let squashAt {
                    ZekkPetDrawing.applySquash(elapsed: date.timeIntervalSince(squashAt), to: &pet)
                }
                ZekkPetDrawing.draw(stage: stage, mood: mood, progress: progress, palette: palette, in: pet)
                for heart in hearts {
                    let elapsed = date.timeIntervalSince(heart.start)
                    guard elapsed >= 0, elapsed < 0.8 else { continue }
                    ZekkPetDrawing.drawHeart(elapsed: elapsed, rise: !still, in: ctx)
                }
            }
            .padding(-pad)
        }
    }
}

// MARK: - Header pet

/// The header pet next to the streak chip: 28 pt on the theme's chip surface
/// (bg2 + line border) — an egg while the invite is open, the asleep face
/// when asleep. Opens the pet card.
struct ZekkPetHeaderButton: View {
    let pet: PetDTO
    let themeId: String
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZekkPetArt(stage: pet.status == .invited ? .egg : pet.stage,
                       mood: pet.mood,
                       progress: ZekkPet.levelProgress(pet).fraction,
                       themeId: themeId,
                       frameInterval: 1.0 / 30)
                .frame(width: 28, height: 28)
                .frame(width: 30, height: 30)
                .background(Theme.bg2)
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .strokeBorder(Theme.line, lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(pet.status == .invited
            ? "Zekk Pet: \(pet.name) (invite pending)"
            : "Zekk Pet: \(pet.name), \(pet.mood.label)")
        .accessibilityHint("Opens the pet card")
    }
}

// MARK: - Adopt banner

/// The slim bar under a 1:1 DM's header: "Adopt" when the DM may adopt,
/// "Cancel" on our open invite, "Accept" / "Not now" on theirs. ✕ hides it
/// for the session (per DM and per kind of bar).
struct ZekkPetBanner: View {
    @EnvironmentObject private var store: AppStore
    let channelId: String
    let banner: ZekkPet.Banner

    var body: some View {
        HStack(spacing: 8) {
            Text(banner.text)
                .font(.zkSans(13))
                .foregroundColor(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            // The buttons keep their full width ("Accepting…" included); the
            // text wraps into what's left.
            ZekkPetInviteActions(channelId: channelId, kind: banner.kind,
                                 canAct: store.dmPets[channelId]?.canAct ?? true)
                .fixedSize()
            Button { store.dismissPetBanner(channelId, banner.kind) } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundColor(Theme.ink3)
                    .frame(width: 28, height: 28)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel("Dismiss")
        }
        .padding(.leading, 14)
        .padding(.trailing, 8)
        .padding(.vertical, 6)
        .background(Theme.bg2.opacity(0.6))
        .overlay(Rectangle().fill(Theme.lineSoft).frame(height: 1), alignment: .bottom)
    }
}

/// [Adopt] · [Cancel] · [Accept] [Not now] — the banner's buttons, reused by
/// the pet card while the invite is open. "Not now" declines (no notice for
/// either person); the inviter can invite again later.
struct ZekkPetInviteActions: View {
    @EnvironmentObject private var store: AppStore
    let channelId: String
    let kind: ZekkPet.BannerKind
    /// False (a block, a mute, supervision, or the other person left): Adopt
    /// and Accept hide, since they would only fail. Not now / Cancel stay.
    var canAct: Bool = true
    /// For a caller whose sheet hides MainView's error toast (the pet card):
    /// nil as a change starts, then the message if it fails (taken out of the
    /// toast). Unset, a failure shows in the toast (the banner).
    var onError: ((String?) -> Void)? = nil
    @State private var busy: Busy?

    private enum Busy { case invite, accept, decline }

    var body: some View {
        HStack(spacing: 6) {
            switch kind {
            case .adopt:
                if canAct {
                    primary(busy == .invite ? "Inviting…" : "Adopt") { run(.invite, .invite) }
                }
            case .waiting:
                secondary(busy == .decline ? "Cancelling…" : "Cancel") { run(.decline, .decline) }
            case .invited:
                if canAct {
                    primary(busy == .accept ? "Accepting…" : "Accept") { run(.accept, .accept) }
                }
                secondary("Not now") { run(.decline, .decline) }
            }
        }
        .disabled(busy != nil)
    }

    private func run(_ change: AppStore.PetChange, _ marker: Busy) {
        guard busy == nil else { return }
        busy = marker
        onError?(nil)
        Task { @MainActor in
            let ok = await store.changeDmPet(channelId, change)
            busy = nil
            if !ok, let onError {
                onError(store.errorText ?? "Couldn't update the invite.")
                store.errorText = nil
            }
        }
    }

    private func primary(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.zkSans(13, weight: .semibold))
                .foregroundColor(.white)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Theme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .opacity(busy != nil ? 0.6 : 1)
    }

    private func secondary(_ title: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.zkSans(13, weight: .medium))
                .foregroundColor(Theme.ink2)
                .lineLimit(1)
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(Theme.line, lineWidth: 1)
                )
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .opacity(busy != nil ? 0.6 : 1)
    }
}

// MARK: - Pet card

/// The pet card, a sheet over the DM (built like the Disappearing Messages
/// screen): the big animated pet (tap it for a heart), its name with a rename
/// pencil, "Level 3 · Baby", the mood chip (asleep: when to wake it), the
/// level bar, "Today's care" and the stage path. While the invite is open:
/// the egg and the banner's actions. Live through DM_PET_UPDATE; closes by
/// itself when the pet goes away (declined, cancelled, expired, ran away).
struct ZekkPetCardSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    @State private var renaming = false
    @State private var nameDraft = ""
    @State private var saving = false
    /// Why a rename / accept / decline from here failed. MainView's error
    /// toast sits behind this sheet, so the card says it itself.
    @State private var actionError: String?
    /// When it failed. Only a failure that just happened explains the pet
    /// hatching or going away under it (the resync after a 409: they
    /// accepted first, the invite expired); an older one is stale by then.
    @State private var actionErrorAt: Date?
    @FocusState private var nameFocused: Bool

    /// How long a failure can explain the pet changing (time for the
    /// resync after it to land).
    private static let errorExplainsChangeFor: TimeInterval = 10

    private var state: DmPetState? { store.dmPets[channel.id] }
    private var pet: PetDTO? { state?.pet }
    /// Accept and Rename hide while the server says they'd only fail.
    private var canAct: Bool { state?.canAct ?? true }
    /// The other person (their DM nickname when set).
    private var peerName: String { store.dmDisplayTitle(channel) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if let pet {
                        if pet.status == .invited {
                            invitedCard(pet)
                        } else {
                            card(pet)
                        }
                    } else {
                        ProgressView().tint(Theme.accent).padding(.top, 40)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Zekk Pet").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 18, weight: .semibold))
                            .foregroundColor(Theme.ink2)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
        .onChange(of: pet?.status) { _, status in
            // An error from before the pet hatched / fell asleep / went away
            // (a lost connection, say, while someone else then acted) says
            // nothing about this change: don't show it on the new card or
            // hand it to the toast.
            let fresh = actionErrorAt.map {
                Date().timeIntervalSince($0) <= Self.errorExplainsChangeFor
            } ?? false
            let reason = fresh ? actionError : nil
            if !fresh { actionError = nil }
            // Nothing left to show: the invite was declined / cancelled /
            // expired or the pet ran away (from here or anywhere else).
            if status == nil, state != nil {
                // A change that just failed because the pet was already gone
                // (an expired invite, a pet that ran away): hand the reason
                // back to the toast, which the closing sheet uncovers.
                if let reason { store.errorText = reason }
                dismiss()
            }
        }
        .onChange(of: canAct) { _, can in
            // A block or the other person leaving mid-rename hides the field.
            if !can { renaming = false }
        }
        .task { if state == nil { await store.loadDmPet(channel.id) } }
    }

    // MARK: Invite pending

    @ViewBuilder
    private func invitedCard(_ pet: PetDTO) -> some View {
        ZekkPetStage(pet: pet)
        if let banner = ZekkPet.banner(state, selfId: store.currentUserId, peerName: peerName) {
            Text(banner.text)
                .font(.zkSans(14))
                .foregroundColor(Theme.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            ZekkPetInviteActions(channelId: channel.id, kind: banner.kind, canAct: canAct) { setActionError($0) }
            if let actionError { errorLine(actionError) }
        }
    }

    private func setActionError(_ message: String?) {
        actionError = message
        actionErrorAt = message == nil ? nil : Date()
    }

    private func errorLine(_ message: String) -> some View {
        Text(message)
            .font(.zkSans(12))
            .foregroundColor(Theme.dangerSoft)
            .multilineTextAlignment(.center)
            .fixedSize(horizontal: false, vertical: true)
    }

    // MARK: The pet

    @ViewBuilder
    private func card(_ pet: PetDTO) -> some View {
        ZekkPetStage(pet: pet)
        VStack(spacing: 2) {
            if renaming && canAct {
                renameField(pet)
            } else {
                HStack(spacing: 4) {
                    Text(pet.name)
                        .font(.zkSans(19, weight: .semibold))
                        .foregroundColor(Theme.ink1)
                        .lineLimit(1)
                    if canAct {
                        Button {
                            nameDraft = pet.name
                            actionError = nil
                            renaming = true
                        } label: {
                            Image(systemName: "pencil")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(Theme.ink3)
                                .frame(width: 30, height: 30)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel("Rename pet")
                    }
                }
            }
            Text(ZekkPet.levelLine(pet))
                .font(.zkSans(14))
                .foregroundColor(Theme.ink2)
            // An invite change that failed as the pet hatched (e.g. Cancel
            // just after they accepted; an older error was dropped as it
            // hatched). A rename's shows in the field.
            if !renaming, let actionError { errorLine(actionError) }
        }
        moodChip(pet)
        levelBar(pet)
        careList(pet)
        stagePath(pet.stage)
    }

    /// The mood word and its line; amber while asleep or grumpy.
    private func moodChip(_ pet: PetDTO) -> some View {
        let warn = pet.mood == .asleep || pet.mood == .grumpy
        return VStack(alignment: .leading, spacing: 2) {
            Text(pet.mood.label)
                .font(.zkSans(14, weight: .semibold))
                .foregroundColor(Theme.ink1)
            Text(ZekkPet.moodLine(pet))
                .font(.zkSans(13))
                .foregroundColor(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(warn ? Theme.warning.opacity(0.10) : Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(
            RoundedRectangle(cornerRadius: 12)
                .strokeBorder(warn ? Theme.warning.opacity(0.3) : Theme.line, lineWidth: 1)
        )
        .accessibilityElement(children: .combine)
    }

    /// "{points − levelFloor}/{nextLevelAt − levelFloor} to level {L+1}".
    private func levelBar(_ pet: PetDTO) -> some View {
        let progress = ZekkPet.levelProgress(pet)
        return VStack(alignment: .leading, spacing: 4) {
            GeometryReader { geo in
                ZStack(alignment: .leading) {
                    Capsule().fill(Theme.bg3)
                    Capsule().fill(Theme.accent)
                        .frame(width: geo.size.width * CGFloat(progress.fraction))
                }
            }
            .frame(height: 8)
            Text(progress.label)
                .font(.zkMono(11))
                .foregroundColor(Theme.ink3)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Level \(pet.level) progress")
        .accessibilityValue(progress.label)
    }

    private func careList(_ pet: PetDTO) -> some View {
        let rows = ZekkPet.careRows(pet, selfId: store.currentUserId)
        return VStack(alignment: .leading, spacing: 6) {
            Text("TODAY'S CARE")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            VStack(spacing: 0) {
                ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                    if index > 0 { Divider().overlay(Theme.line) }
                    careRow(row)
                }
            }
            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func careRow(_ row: ZekkPet.CareRow) -> some View {
        HStack(spacing: 10) {
            Image(systemName: "checkmark")
                .font(.system(size: 10, weight: .bold))
                .foregroundColor(row.done ? Theme.accent : Color.clear)
                .frame(width: 20, height: 20)
                .background(Circle().fill(row.done ? Theme.accent.opacity(0.15) : Color.clear))
                .overlay(Circle().strokeBorder(row.done ? Theme.accent.opacity(0.5) : Theme.line, lineWidth: 1))
                // Drawn clear when not done; the row's value says which.
                .accessibilityHidden(true)
            Text(row.label)
                .font(.zkSans(14))
                .foregroundColor(row.done ? Theme.ink1 : Theme.ink2)
            if let progress = row.progress {
                Text(progress)
                    .font(.zkMono(11))
                    .foregroundColor(Theme.ink3)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text("+\(row.points)")
                .font(.zkMono(12, weight: .semibold))
                .foregroundColor(row.done ? Theme.accent : Theme.ink3)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .accessibilityElement(children: .combine)
        .accessibilityValue(row.done ? "Done" : "Not done yet")
    }

    /// Egg → Baby → Kid → Teen → Adult → Legendary, the current one marked;
    /// on two lines when one doesn't fit.
    private func stagePath(_ current: PetStage) -> some View {
        let stages = PetStage.allCases
        let at = stages.firstIndex(of: current) ?? 0
        return ViewThatFits(in: .horizontal) {
            stageSteps(Array(stages.enumerated()), at: at, leadingChevron: false)
            VStack(spacing: 4) {
                stageSteps(Array(stages.enumerated().prefix(3)), at: at, leadingChevron: false)
                stageSteps(Array(stages.enumerated().dropFirst(3)), at: at, leadingChevron: true)
            }
        }
        .frame(maxWidth: .infinity)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Stages")
        .accessibilityValue(current.label)
    }

    private func stageSteps(_ steps: [(offset: Int, element: PetStage)], at: Int, leadingChevron: Bool) -> some View {
        HStack(spacing: 2) {
            ForEach(steps, id: \.element) { step in
                if leadingChevron || step.offset != steps.first?.offset {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 8, weight: .semibold))
                        .foregroundColor(Theme.ink4)
                }
                let isCurrent = step.offset == at
                Text(step.element.label)
                    .font(.zkSans(12, weight: isCurrent ? .semibold : .regular))
                    .foregroundColor(isCurrent ? Theme.ink1 : (step.offset < at ? Theme.ink2 : Theme.ink3))
                    .lineLimit(1)
                    .fixedSize()
                    .padding(.horizontal, 6)
                    .padding(.vertical, 3)
                    .background(isCurrent ? Theme.accent.opacity(0.15) : Color.clear)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .overlay(
                        RoundedRectangle(cornerRadius: 6)
                            .strokeBorder(isCurrent ? Theme.accent.opacity(0.5) : Color.clear, lineWidth: 1)
                    )
            }
        }
    }

    // MARK: Rename

    /// Inline rename: ✓ (or Return) saves, ✕ cancels. The name is checked
    /// like the server does (invisible and bidi-formatting characters
    /// dropped, trimmed, spaces collapsed, 1–24 characters).
    private func renameField(_ pet: PetDTO) -> some View {
        let name = ZekkPet.normalizeName(nameDraft)
        let canSave = name != nil && name != pet.name && !saving
        let invalid = !nameDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && name == nil
        return VStack(spacing: 4) {
            HStack(spacing: 4) {
                TextField("Pet name", text: $nameDraft)
                    .font(.zkSans(16))
                    .foregroundColor(Theme.ink1)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                    .submitLabel(.done)
                    .focused($nameFocused)
                    .onSubmit { save(pet) }
                    .onChange(of: nameDraft) { _, _ in actionError = nil }
                    .disabled(saving)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .overlay(
                        RoundedRectangle(cornerRadius: 10)
                            .strokeBorder(nameFocused ? Theme.accent.opacity(0.6) : Theme.line, lineWidth: 1)
                    )
                    .accessibilityLabel("Pet name")
                Button { save(pet) } label: {
                    if saving {
                        ProgressView().tint(Theme.accent).frame(width: 36, height: 36)
                    } else {
                        Image(systemName: "checkmark")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(canSave ? Theme.accent : Theme.ink4)
                            .frame(width: 36, height: 36)
                            .contentShape(Rectangle())
                    }
                }
                .buttonStyle(.plain)
                .disabled(!canSave)
                .accessibilityLabel("Save name")
                Button {
                    renaming = false
                    actionError = nil
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundColor(Theme.ink2)
                        .frame(width: 36, height: 36)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .disabled(saving)
                .accessibilityLabel("Cancel rename")
            }
            if let actionError {
                errorLine(actionError)
            } else {
                Text(invalid
                     ? "Names are 1–\(ZekkPet.nameMaxLength) characters, with no control characters."
                     : "Up to \(ZekkPet.nameMaxLength) characters. You'll both see the new name.")
                    .font(.zkSans(12))
                    .foregroundColor(invalid ? Theme.dangerSoft : Theme.ink3)
                    .multilineTextAlignment(.center)
            }
        }
        .frame(maxWidth: 340)
        .onAppear { DispatchQueue.main.async { nameFocused = true } }
    }

    private func save(_ pet: PetDTO) {
        guard !saving, let name = ZekkPet.normalizeName(nameDraft), name != pet.name else { return }
        saving = true
        actionError = nil
        Task { @MainActor in
            let ok = await store.changeDmPet(channel.id, .rename(name))
            saving = false
            if ok {
                renaming = false
            } else {
                // Keep the draft for a retry; say why here, not in the toast
                // behind the sheet (nor in one left for after it closes).
                setActionError(store.errorText ?? "Couldn't rename the pet.")
                store.errorText = nil
            }
        }
    }
}

/// The big pet on its round stage in the pet card. Tapping it squashes it and
/// floats a heart up — purely local, nothing is sent.
private struct ZekkPetStage: View {
    @EnvironmentObject private var store: AppStore
    let pet: PetDTO
    @State private var squashAt: Date?
    @State private var hearts: [ZekkPetHeart] = []
    @State private var nextHeartId = 0

    var body: some View {
        Button(action: tap) {
            ZekkPetArt(stage: pet.status == .invited ? .egg : pet.stage,
                       mood: pet.mood,
                       progress: ZekkPet.levelProgress(pet).fraction,
                       themeId: store.themeId,
                       squashAt: squashAt,
                       hearts: hearts)
                .frame(width: 140, height: 140)
                .frame(width: 176, height: 176)
                .background(Circle().fill(Theme.bg2))
                .overlay(Circle().strokeBorder(Theme.line, lineWidth: 1))
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel("Pet \(pet.name)")
    }

    private func tap() {
        nextHeartId += 1
        let heart = ZekkPetHeart(id: nextHeartId, start: Date())
        squashAt = heart.start
        hearts.append(heart)
        Task { @MainActor in
            // A little past the heart's 0.8 s, so its last frame is drawn.
            try? await Task.sleep(nanoseconds: 850_000_000)
            hearts.removeAll { $0.id == heart.id }
            if squashAt == heart.start { squashAt = nil }
        }
    }
}
