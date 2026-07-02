/**
 * Avatar decorations
 * ------------------
 * Cosmetic ring/glow overlays drawn around a user's avatar. Pure CSS — no
 * uploaded assets — so they're free to render anywhere and re-tint with the
 * active theme (solid "accent" variants read --c-accent live).
 *
 * Rendering model: <AvatarImage> is just the <img>; the PARENT renders the
 * circular frame. A decoration is a sibling overlay placed inside that same
 * relative container, so we don't have to thread anything through the 30+
 * AvatarImage call sites — only the few high-visibility spots opt in:
 *
 *   <div className="relative w-10 h-10 rounded-full ...">
 *     <span>{initials}</span>
 *     <AvatarImage src={user.avatarUrl} />
 *     <AvatarDecoration decoration={user.avatarDecoration} />
 *   </div>
 */

/** A fixed-thickness ring cut out of a full-bleed background. EVERY
 *  decoration — solid or gradient — renders through this same mask, so they
 *  all have an IDENTICAL ring diameter + thickness; only the fill color (and
 *  optional glow) differs. (Previously solids used box-shadow, which grows
 *  OUTSIDE the element, while gradients used this mask, which draws INSIDE
 *  it, and thicknesses ranged 1.5–2.5px — so the frames had visibly different
 *  diameters. Unifying on the mask makes every frame the same size.)
 *
 *  2px band at the element's farthest-side edge. With the default
 *  `-inset-[2px]` container the band spans avatar-edge → avatar-edge+2px, so
 *  the frame sits FLUSH against the avatar (no background gap between the
 *  picture and its frame — the earlier -inset-[3px] left a 1px dark spacer). */
const RING_MASK =
  'radial-gradient(farthest-side, transparent calc(100% - 2px), #000 calc(100% - 2px))';

interface DecoKind {
  id: string;
  label: string;
  /** Ring fill — a solid CSS color or a conic-gradient. Omitted for 'none'.
   *  Solid accent variants use the --c-accent var so they re-tint with the
   *  active theme. */
  fill?: string;
  /** Optional glow color. Rendered as a drop-shadow on the masked ring (so it
   *  follows the ring's alpha and glows the ring WITHOUT enlarging its
   *  diameter — keeping every frame the same size). */
  glow?: string;
}

/** The picker registry. 'none' first so it reads as the default/off state. */
export const AVATAR_DECORATIONS: DecoKind[] = [
  { id: 'none', label: 'None' },
  { id: 'ring', label: 'Accent', fill: 'rgb(var(--c-accent))' },
  { id: 'glow', label: 'Accent glow', fill: 'rgb(var(--c-accent))', glow: 'rgb(var(--c-accent) / 0.7)' },
  { id: 'gold', label: 'Gold', fill: '#f4c95b', glow: 'rgba(244,201,91,0.6)' },
  { id: 'rose', label: 'Rose', fill: '#ec5fb5', glow: 'rgba(236,95,181,0.6)' },
  { id: 'violet', label: 'Violet', fill: '#9d7bff', glow: 'rgba(157,123,255,0.6)' },
  { id: 'lime', label: 'Lime', fill: '#7ee787', glow: 'rgba(126,231,135,0.6)' },
  {
    id: 'aurora',
    label: 'Aurora',
    fill: 'conic-gradient(from 140deg, #3dd7ec, #9d7bff, #ec5fb5, #3dd7ec)',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    fill: 'conic-gradient(from 200deg, #ffd13d, #ec5fb5, #9d7bff, #ffd13d)',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    fill: 'conic-gradient(from 120deg, #7ee787, #3dd7ec, #7ee787)',
  },
  // Crimson + Ocean round the registry out to one frame per theme palette
  // (Crimson theme's red; Forest theme's blue→green trio).
  { id: 'crimson', label: 'Crimson', fill: '#ff4d4d', glow: 'rgba(255,77,77,0.6)' },
  {
    id: 'ocean',
    label: 'Ocean',
    fill: 'conic-gradient(from 160deg, #3d9bff, #3dd8c0, #4fdd8f, #3d9bff)',
  },
];

const BY_ID = new Map(AVATAR_DECORATIONS.map((d) => [d.id, d]));

/**
 * Overlay ring for an avatar. Returns null when there's no decoration. Place
 * it as the last child of the avatar's relative, rounded-full container.
 * `className` controls size/position — default sits just outside the avatar
 * edge. Every variant renders through one mask so all frames share a diameter.
 */
export function AvatarDecoration({
  decoration,
  className = 'absolute -inset-[2px] rounded-full pointer-events-none',
}: {
  decoration?: string | null;
  className?: string;
}) {
  if (!decoration || decoration === 'none') return null;
  const d = BY_ID.get(decoration);
  if (!d || !d.fill) return null;
  return (
    <span
      aria-hidden
      className={className}
      style={{
        background: d.fill,
        WebkitMask: RING_MASK,
        mask: RING_MASK,
        filter: d.glow ? `drop-shadow(0 0 4px ${d.glow})` : undefined,
      }}
    />
  );
}
