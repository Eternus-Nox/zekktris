/**
 * Zekk Pet art
 * ------------
 * The pet's drawing as data: one original creature, every stage × mood
 * resolved to a list of SVG primitives in a 100×100 space, back to front —
 * wings, arms, feet, body, belly, antennae, face, extras. The iOS and Android
 * apps draw the SAME numbers natively, so this module is the geometry, not a
 * picture: no React, no DOM. ZekkPetArt.tsx turns the list into elements, and
 * the vitest suite (test/zekkPet.test.ts) checks the numbers per stage.
 *
 * Colours belong to the PET, not to whoever looks at it: a pet has one
 * colour of its own (PetDTO.color, picked by the inviter; a notice carries
 * the colour its pet had when it was posted), so both people see the same
 * egg whatever Appearance theme each of them uses, on every app. The colours
 * are the app's six accent families (PET_PALETTES, shared with the server
 * and the native apps): the body is the accent, the belly and outline are
 * that accent mixed toward white / black, and the antenna tips take the
 * second colour (petPalette). The shapes reference them as CSS custom
 * properties (--zk-pet-*), which ZekkPetArt sets on its <svg> from the pet's
 * colour. The eye / mouth / tear / gold inks are fixed.
 */

import { PET_PALETTES, isPetColorId, type PetColorId, type PetMood, type PetStage } from '@zekktris/client';

/** The pet's four colours, as CSS values: custom properties that ZekkPetArt
    sets on its <svg> from the pet's own colour (petPalette). Art drawn
    without a colour falls back to the :root values (index.css). */
export const PET_COLORS = {
  body: 'var(--zk-pet-body)',
  belly: 'var(--zk-pet-belly)',
  outline: 'var(--zk-pet-outline)',
  accent: 'var(--zk-pet-accent)',
} as const;

/** Inks shared by every pet colour. The cheeks are drawn at 70% opacity. */
export const PET_INK = {
  eye: '#1D1D2B',
  highlight: '#FFFFFF',
  cheek: 'hsl(350, 85%, 75%)',
  mouth: '#8A2A3A',
  tear: '#6EC6FF',
  gold: '#FFD54A',
  goldDark: '#C99A00',
  sparkle: '#FFE58A',
  heart: '#FF5C8A',
} as const;

export const PET_CHEEK_OPACITY = 0.7;
/** Body / limb outline and every stroked face line. */
export const PET_OUTLINE_WIDTH = 2.5;

/** The point the egg wobbles around and the pet breathes / squashes from:
    the ground the hatched stages stand on (just under the feet). The egg,
    centred in the box, turns about it too, 6 units under its base (82): one
    point for every stage, as on iOS and Android, and on the 140 px pet card
    that moves the egg's base by under 1 px. */
export const PET_GROUND = { x: 50, y: 88 } as const;

/** Where the tap heart starts, and how far it rises while it fades. */
export const PET_HEART_ORIGIN = { x: 50, y: 26 } as const;
export const PET_HEART_RISE = 20;

/** Egg progress (towards level 1) from which the shell shows a crack. */
export const PET_CRACK_AT = 0.8;

/** A pet's four colours as "#RRGGBB" (the --zk-pet-* properties). */
export interface PetPalette {
  body: string;
  belly: string;
  outline: string;
  accent: string;
}

/**
 * The hex colours of a pet whose accents are `accent` / `accent2`
 * ("#RRGGBB"): a per-channel sRGB lerp, rounded half up — exactly what
 * `color-mix(in srgb, …)` computes (the :root fallback in index.css), and
 * what the iOS and Android apps compute natively.
 */
export function petColorsForAccents(accent: string, accent2: string): PetPalette {
  const rgb = (hex: string) => {
    const v = hex.replace('#', '');
    return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16));
  };
  const hex = (c: number[]) =>
    '#' + c.map((x) => Math.min(255, Math.max(0, x)).toString(16).padStart(2, '0')).join('').toUpperCase();
  // `t` of the way from the accent toward `to`.
  const mix = (from: number[], to: number, t: number) => from.map((x) => Math.floor(x + (to - x) * t + 0.5));
  const a = rgb(accent);
  return {
    body: hex(a),
    belly: hex(mix(a, 255, 0.55)),
    outline: hex(mix(a, 0, 0.6)),
    accent: hex(rgb(accent2)),
  };
}

// Worked out once (and shared, so frozen): notice glyphs ask for a palette
// on every render.
const PALETTES = new Map<PetColorId, Readonly<PetPalette>>();

/**
 * The colours a pet of colour `color` is drawn in: its PET_PALETTES accents
 * mixed as above, so a pet's colour looks exactly like the matching theme's
 * pet used to. null for no colour or an id this app doesn't know — callers
 * resolve the pet's colour first (resolvePetColor, which falls back to the
 * DM's colour), so that only happens to art drawn without one.
 */
export function petPalette(color: string | null | undefined): Readonly<PetPalette> | null {
  if (!isPetColorId(color)) return null;
  let palette = PALETTES.get(color);
  if (!palette) {
    const { accent, accent2 } = PET_PALETTES[color];
    palette = Object.freeze(petColorsForAccents(accent, accent2));
    PALETTES.set(color, palette);
  }
  return palette;
}

// ── Geometry per stage ────────────────────────────────────────────────────

export interface PetEllipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** An ellipse turned `rotate` degrees (clockwise on screen) about its centre. */
export interface PetLimb extends PetEllipse {
  rotate: number;
}

export interface PetAntenna {
  from: readonly [number, number];
  to: readonly [number, number];
  tip: readonly [number, number];
  /** 'ball' = circle r4; 'star' = 5-point star, outer r5 inner r2.2. */
  tipShape: 'ball' | 'star';
}

export interface PetEyes {
  ex1: number;
  ex2: number;
  ey: number;
  er: number;
}

export interface PetGeometry {
  body: PetEllipse;
  /** null on the egg. */
  belly: PetEllipse | null;
  /** null on the egg (no face). */
  eyes: PetEyes | null;
  feet: PetEllipse[];
  arms: PetLimb[];
  wings: PetLimb[];
  antennae: PetAntenna[];
  /** Legendary only. */
  crown: ReadonlyArray<readonly [number, number]> | null;
  /** Legendary only: 4-point sparkles around the pet. */
  sparkles: ReadonlyArray<{ x: number; y: number; r: number }>;
}

const ADULT: PetGeometry = {
  body: { cx: 50, cy: 55, rx: 31, ry: 31 },
  belly: { cx: 50, cy: 64, rx: 19, ry: 14 },
  eyes: { ex1: 39, ex2: 61, ey: 50, er: 6 },
  feet: [
    { cx: 37, cy: 86, rx: 9, ry: 4.5 },
    { cx: 63, cy: 86, rx: 9, ry: 4.5 },
  ],
  arms: [
    { cx: 19, cy: 58, rx: 6, ry: 10, rotate: -20 },
    { cx: 81, cy: 58, rx: 6, ry: 10, rotate: 20 },
  ],
  wings: [
    { cx: 24, cy: 42, rx: 12, ry: 7, rotate: -30 },
    { cx: 76, cy: 42, rx: 12, ry: 7, rotate: 30 },
  ],
  antennae: [
    { from: [42, 26], to: [35, 13], tip: [34, 11], tipShape: 'star' },
    { from: [58, 26], to: [65, 13], tip: [66, 11], tipShape: 'star' },
  ],
  crown: null,
  sparkles: [],
};

const GEOMETRY: Record<PetStage, PetGeometry> = {
  egg: {
    // Centred in the 100×100 box (18–82 tall), not resting on the ground
    // line the hatched stages stand on: the egg is usually seen alone in a
    // small square (the DM header chip, notice glyphs, the egg picker), where
    // sitting 6 units low read as off-centre. Its spots and crack below sit
    // on the same shell. The iOS and Android apps use the same numbers.
    body: { cx: 50, cy: 50, rx: 26, ry: 32 },
    belly: null,
    eyes: null,
    feet: [],
    arms: [],
    wings: [],
    antennae: [],
    crown: null,
    sparkles: [],
  },
  baby: {
    body: { cx: 50, cy: 60, rx: 24, ry: 22 },
    belly: { cx: 50, cy: 66, rx: 14, ry: 10 },
    eyes: { ex1: 41, ex2: 59, ey: 56, er: 4.5 },
    feet: [],
    arms: [],
    wings: [],
    antennae: [{ from: [50, 38], to: [50, 26], tip: [50, 24], tipShape: 'ball' }],
    crown: null,
    sparkles: [],
  },
  kid: {
    body: { cx: 50, cy: 58, rx: 27, ry: 25 },
    belly: { cx: 50, cy: 65, rx: 16, ry: 11 },
    eyes: { ex1: 40, ex2: 60, ey: 54, er: 5 },
    feet: [
      { cx: 38, cy: 83, rx: 7, ry: 4 },
      { cx: 62, cy: 83, rx: 7, ry: 4 },
    ],
    arms: [],
    wings: [],
    antennae: [{ from: [50, 33], to: [50, 21], tip: [50, 18], tipShape: 'star' }],
    crown: null,
    sparkles: [],
  },
  teen: {
    body: { cx: 50, cy: 56, rx: 28, ry: 29 },
    belly: { cx: 50, cy: 64, rx: 17, ry: 13 },
    eyes: { ex1: 40, ex2: 60, ey: 51, er: 5.5 },
    feet: [
      { cx: 38, cy: 85, rx: 8, ry: 4 },
      { cx: 62, cy: 85, rx: 8, ry: 4 },
    ],
    arms: [
      { cx: 22, cy: 60, rx: 5, ry: 9, rotate: -20 },
      { cx: 78, cy: 60, rx: 5, ry: 9, rotate: 20 },
    ],
    wings: [],
    antennae: [
      { from: [42, 29], to: [36, 16], tip: [35, 14], tipShape: 'ball' },
      { from: [58, 29], to: [64, 16], tip: [65, 14], tipShape: 'ball' },
    ],
    crown: null,
    sparkles: [],
  },
  adult: ADULT,
  legendary: {
    ...ADULT,
    antennae: [],
    crown: [
      [36, 24],
      [40, 12],
      [46, 20],
      [50, 8],
      [54, 20],
      [60, 12],
      [64, 24],
    ],
    sparkles: [
      { x: 14, y: 24, r: 5 },
      { x: 86, y: 30, r: 4 },
      { x: 82, y: 78, r: 3.5 },
      { x: 16, y: 72, r: 3 },
    ],
  },
};

export function petGeometry(stage: PetStage): PetGeometry {
  return GEOMETRY[stage] ?? GEOMETRY.egg;
}

// ── Primitives ────────────────────────────────────────────────────────────

/** Which part of the pet a primitive draws (tests and the renderer use it;
    it is not an SVG attribute). */
export type PetPart =
  | 'wing'
  | 'arm'
  | 'foot'
  | 'body'
  | 'spot'
  | 'belly'
  | 'antenna'
  | 'face'
  | 'crack'
  | 'crown'
  | 'sparkle'
  | 'zzz'
  | 'heart';

/** One SVG element: its tag and its attributes, named as React props
    (strokeWidth, strokeLinecap …) so the renderer can spread them. */
export interface PetShape {
  tag: 'ellipse' | 'circle' | 'path' | 'polygon' | 'polyline' | 'line';
  part: PetPart;
  attrs: Record<string, string | number>;
}

/** Three decimals is plenty in a 100-unit box and keeps the markup stable
    (0.35 × 5.5 is 1.9249999…). */
function n(v: number): number {
  return Math.round(v * 1000) / 1000;
}

function pointList(points: ReadonlyArray<readonly [number, number]>): string {
  return points.map(([x, y]) => `${n(x)},${n(y)}`).join(' ');
}

function quad(x1: number, y1: number, cx: number, cy: number, x2: number, y2: number): string {
  return `M${n(x1)} ${n(y1)} Q${n(cx)} ${n(cy)} ${n(x2)} ${n(y2)}`;
}

/** A 5-point star, one point straight up. */
export function starPoints(cx: number, cy: number, outer: number, inner: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < 10; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const a = ((-90 + i * 36) * Math.PI) / 180;
    out.push([n(cx + r * Math.cos(a)), n(cy + r * Math.sin(a))]);
  }
  return out;
}

/** A 4-point sparkle: points on the axes at `r`, waists at 45° at 0.4·r. */
export function sparklePoints(cx: number, cy: number, r: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (let i = 0; i < 8; i++) {
    const d = i % 2 === 0 ? r : r * 0.4;
    const a = ((-90 + i * 45) * Math.PI) / 180;
    out.push([n(cx + d * Math.cos(a)), n(cy + d * Math.sin(a))]);
  }
  return out;
}

/** A "Z" `s` wide and `s` tall from its top-left corner. */
export function zPoints(x: number, y: number, s: number): Array<[number, number]> {
  return [
    [x, y],
    [x + s, y],
    [x, y + s],
    [x + s, y + s],
  ];
}

function ellipse(part: PetPart, e: PetEllipse, fill: string, stroke?: string, rotate?: number): PetShape {
  const attrs: Record<string, string | number> = { cx: n(e.cx), cy: n(e.cy), rx: n(e.rx), ry: n(e.ry), fill };
  if (rotate) attrs.transform = `rotate(${rotate} ${n(e.cx)} ${n(e.cy)})`;
  if (stroke) {
    attrs.stroke = stroke;
    attrs.strokeWidth = PET_OUTLINE_WIDTH;
  }
  return { tag: 'ellipse', part, attrs };
}

function circle(part: PetPart, cx: number, cy: number, r: number, fill: string, opacity?: number): PetShape {
  const attrs: Record<string, string | number> = { cx: n(cx), cy: n(cy), r: n(r), fill };
  if (opacity !== undefined) attrs.opacity = opacity;
  return { tag: 'circle', part, attrs };
}

/** A stroked, unfilled line or curve with round caps. */
function strokePath(part: PetPart, d: string, stroke: string, width = PET_OUTLINE_WIDTH): PetShape {
  return {
    tag: 'path',
    part,
    attrs: { d, fill: 'none', stroke, strokeWidth: width, strokeLinecap: 'round', strokeLinejoin: 'round' },
  };
}

function polyline(part: PetPart, points: ReadonlyArray<readonly [number, number]>, stroke: string, width: number): PetShape {
  return {
    tag: 'polyline',
    part,
    attrs: {
      points: pointList(points),
      fill: 'none',
      stroke,
      strokeWidth: width,
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
    },
  };
}

function polygon(part: PetPart, points: ReadonlyArray<readonly [number, number]>, fill: string, stroke?: string, width?: number): PetShape {
  const attrs: Record<string, string | number> = { points: pointList(points), fill };
  if (stroke) {
    attrs.stroke = stroke;
    attrs.strokeWidth = width ?? PET_OUTLINE_WIDTH;
    attrs.strokeLinejoin = 'round';
  }
  return { tag: 'polygon', part, attrs };
}

// ── Faces ─────────────────────────────────────────────────────────────────

/** The face for `mood` (sc = er/5; the mouth centre sits at ey + 12·sc).
    Cheeks go first so the eyes sit on top of them. */
export function petFaceShapes(eyes: PetEyes, mood: PetMood): PetShape[] {
  const { ex1, ex2, ey, er } = eyes;
  const sc = er / 5;
  const my = ey + 12 * sc;
  const out: PetShape[] = [];

  const cheeks = () => {
    out.push(circle('face', ex1 - 4 * sc, ey + 7 * sc, 4 * sc, PET_INK.cheek, PET_CHEEK_OPACITY));
    out.push(circle('face', ex2 + 4 * sc, ey + 7 * sc, 4 * sc, PET_INK.cheek, PET_CHEEK_OPACITY));
  };
  const roundEyes = (dy = 0) => {
    for (const ex of [ex1, ex2]) {
      out.push(circle('face', ex, ey + dy, er, PET_INK.eye));
      out.push(circle('face', ex - 0.35 * er, ey + dy - 0.35 * er, 0.35 * er, PET_INK.highlight));
    }
  };

  switch (mood) {
    case 'thriving':
      cheeks();
      for (const ex of [ex1, ex2]) {
        out.push(strokePath('face', quad(ex - er, ey + 1, ex, ey - er, ex + er, ey + 1), PET_INK.eye));
      }
      // Open smile: the lower half of an ellipse, closed along its top.
      out.push({
        tag: 'path',
        part: 'face',
        attrs: {
          d: `M${n(50 - 9 * sc)} ${n(my)} A${n(9 * sc)} ${n(7 * sc)} 0 0 0 ${n(50 + 9 * sc)} ${n(my)} Z`,
          fill: PET_INK.mouth,
        },
      });
      out.push(polygon('sparkle', sparklePoints(20, 40, 3), PET_INK.sparkle));
      out.push(polygon('sparkle', sparklePoints(80, 44, 2.5), PET_INK.sparkle));
      break;
    case 'lonely':
      roundEyes(1);
      out.push(strokePath('face', quad(50 - 6 * sc, my + 3 * sc, 50, my - 3 * sc, 50 + 6 * sc, my + 3 * sc), PET_INK.eye));
      out.push({
        tag: 'ellipse',
        part: 'face',
        attrs: { cx: n(ex2 + 0.6 * er), cy: n(ey + er + 3), rx: 2, ry: 3, fill: PET_INK.tear },
      });
      break;
    case 'hungry':
      roundEyes();
      out.push({
        tag: 'ellipse',
        part: 'face',
        attrs: { cx: 50, cy: n(my + 1), rx: n(5 * sc), ry: n(6 * sc), fill: PET_INK.mouth },
      });
      out.push({
        tag: 'ellipse',
        part: 'face',
        attrs: { cx: n(50 + 4 * sc), cy: n(my + 7 * sc), rx: 1.5, ry: 2.5, fill: PET_INK.tear },
      });
      break;
    case 'grumpy':
      roundEyes();
      out.push(strokePath('face', `M${n(ex1 - er - 1)} ${n(ey - er - 4)} L${n(ex1 + er)} ${n(ey - er - 1)}`, PET_INK.eye));
      out.push(strokePath('face', `M${n(ex2 + er + 1)} ${n(ey - er - 4)} L${n(ex2 - er)} ${n(ey - er - 1)}`, PET_INK.eye));
      out.push(strokePath('face', quad(50 - 7 * sc, my + 2, 50, my - 2, 50 + 7 * sc, my + 2), PET_INK.eye));
      break;
    case 'asleep':
      for (const ex of [ex1, ex2]) {
        out.push(strokePath('face', quad(ex - er, ey, ex, ey + er, ex + er, ey), PET_INK.eye));
      }
      out.push(circle('face', 50, my + 1, 2 * sc, PET_INK.mouth));
      break;
    case 'happy':
    default:
      cheeks();
      roundEyes();
      out.push(strokePath('face', quad(50 - 8 * sc, my, 50, my + 7 * sc, 50 + 8 * sc, my), PET_INK.eye));
      break;
  }
  return out;
}

// ── The whole pet ─────────────────────────────────────────────────────────

/** Every primitive of the pet, back to front. `progress` (0–1, towards the
    next level) only matters on the egg: from PET_CRACK_AT the shell cracks. */
export function petShapes({
  stage,
  mood,
  progress = 0,
}: {
  stage: PetStage;
  mood: PetMood;
  progress?: number;
}): PetShape[] {
  const g = petGeometry(stage);
  const c = PET_COLORS;
  const out: PetShape[] = [];

  if (stage === 'egg') {
    out.push(ellipse('body', g.body, c.belly, c.outline));
    out.push(circle('spot', 40, 40, 5, c.body));
    out.push(circle('spot', 60, 54, 6, c.body));
    out.push(circle('spot', 46, 66, 4, c.body));
    if (progress >= PET_CRACK_AT) {
      out.push(
        polyline(
          'crack',
          [
            [30, 46],
            [38, 40],
            [45, 48],
            [53, 40],
            [60, 48],
            [70, 42],
          ],
          c.outline,
          2,
        ),
      );
    }
    return out;
  }

  for (const w of g.wings) out.push(ellipse('wing', w, c.belly, c.outline, w.rotate));
  for (const a of g.arms) out.push(ellipse('arm', a, c.body, c.outline, a.rotate));
  for (const f of g.feet) out.push(ellipse('foot', f, c.outline));
  out.push(ellipse('body', g.body, c.body, c.outline));
  if (g.belly) out.push(ellipse('belly', g.belly, c.belly));
  for (const a of g.antennae) {
    out.push(strokePath('antenna', `M${n(a.from[0])} ${n(a.from[1])} L${n(a.to[0])} ${n(a.to[1])}`, c.outline));
    out.push(
      a.tipShape === 'star'
        ? polygon('antenna', starPoints(a.tip[0], a.tip[1], 5, 2.2), c.accent)
        : circle('antenna', a.tip[0], a.tip[1], 4, c.accent),
    );
  }
  if (g.eyes) out.push(...petFaceShapes(g.eyes, mood));
  // Extras.
  if (g.crown) out.push(polygon('crown', g.crown, PET_INK.gold, PET_INK.goldDark, 1.5));
  for (const s of g.sparkles) out.push(polygon('sparkle', sparklePoints(s.x, s.y, s.r), PET_INK.sparkle));
  if (mood === 'asleep') {
    out.push(polyline('zzz', zPoints(74, 26, 6), c.belly, 2));
    out.push(polyline('zzz', zPoints(80, 14, 8), c.belly, 2));
    out.push(polyline('zzz', zPoints(88, 2, 10), c.belly, 2));
  }
  return out;
}

/** The tap heart (two circles and a triangle) centred on (x, y). */
export function petHeartShapes(x = PET_HEART_ORIGIN.x, y = PET_HEART_ORIGIN.y): PetShape[] {
  return [
    circle('heart', x - 3, y, 3.5, PET_INK.heart),
    circle('heart', x + 3, y, 3.5, PET_INK.heart),
    polygon(
      'heart',
      [
        [x - 6.3, y + 1.5],
        [x + 6.3, y + 1.5],
        [x, y + 9],
      ],
      PET_INK.heart,
    ),
  ];
}

/** The idle animation: asleep pets breathe (no bob), eggs wobble, the rest
    bob. Reduced-motion settings turn all of them off (index.css). */
export function petMotion(stage: PetStage, mood: PetMood): 'breathe' | 'wobble' | 'bob' {
  if (mood === 'asleep') return 'breathe';
  if (stage === 'egg') return 'wobble';
  return 'bob';
}
