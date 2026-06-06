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

/** A 2.5px-thick ring cut out of a full-bleed background (used by the
 *  gradient decorations — the mask removes the center so only a ring shows). */
const RING_MASK =
  'radial-gradient(farthest-side, transparent calc(100% - 2.5px), #000 calc(100% - 2.5px))';

interface DecoKind {
  id: string;
  label: string;
  /** Solid/glow ring via box-shadow (re-tints with the theme when it uses
   *  the --c-accent var). Mutually exclusive with `gradient`. */
  box?: string;
  /** A conic-gradient ring (masked to a ring). Mutually exclusive with `box`. */
  gradient?: string;
}

/** The picker registry. 'none' first so it reads as the default/off state. */
export const AVATAR_DECORATIONS: DecoKind[] = [
  { id: 'none', label: 'None' },
  { id: 'ring', label: 'Accent', box: '0 0 0 2px rgb(var(--c-accent))' },
  {
    id: 'glow',
    label: 'Accent glow',
    box: '0 0 0 1.5px rgb(var(--c-accent)), 0 0 9px 1px rgb(var(--c-accent) / 0.65)',
  },
  { id: 'gold', label: 'Gold', box: '0 0 0 2px #f4c95b, 0 0 7px 0 rgba(244,201,91,0.55)' },
  { id: 'rose', label: 'Rose', box: '0 0 0 2px #ec5fb5, 0 0 7px 0 rgba(236,95,181,0.55)' },
  { id: 'violet', label: 'Violet', box: '0 0 0 2px #9d7bff, 0 0 7px 0 rgba(157,123,255,0.55)' },
  { id: 'lime', label: 'Lime', box: '0 0 0 2px #7ee787, 0 0 7px 0 rgba(126,231,135,0.55)' },
  {
    id: 'aurora',
    label: 'Aurora',
    gradient: 'conic-gradient(from 140deg, #3dd7ec, #9d7bff, #ec5fb5, #3dd7ec)',
  },
  {
    id: 'sunset',
    label: 'Sunset',
    gradient: 'conic-gradient(from 200deg, #ffd13d, #ec5fb5, #9d7bff, #ffd13d)',
  },
  {
    id: 'emerald',
    label: 'Emerald',
    gradient: 'conic-gradient(from 120deg, #7ee787, #3dd7ec, #7ee787)',
  },
];

const BY_ID = new Map(AVATAR_DECORATIONS.map((d) => [d.id, d]));

/** True for a real, renderable decoration id (not 'none'/null/unknown). */
export function isDecoration(id: string | null | undefined): boolean {
  return !!id && id !== 'none' && BY_ID.has(id);
}

/**
 * Overlay ring for an avatar. Returns null when there's no decoration. Place
 * it as the last child of the avatar's relative, rounded-full container.
 * `className` controls size/position — default hugs the avatar edge.
 */
export function AvatarDecoration({
  decoration,
  className = 'absolute -inset-px rounded-full pointer-events-none',
}: {
  decoration?: string | null;
  className?: string;
}) {
  if (!decoration || decoration === 'none') return null;
  const d = BY_ID.get(decoration);
  if (!d) return null;
  if (d.gradient) {
    return (
      <span
        aria-hidden
        className={className}
        style={{ background: d.gradient, WebkitMask: RING_MASK, mask: RING_MASK }}
      />
    );
  }
  return <span aria-hidden className={className} style={{ boxShadow: d.box }} />;
}
