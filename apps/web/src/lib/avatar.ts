/**
 * Avatar utilities
 * ----------------
 * Deterministic background colors for avatar fallbacks (when the user/
 * guild has no uploaded image). The same id always maps to the same
 * color, so users develop a visual identity even before customizing
 * their profile.
 *
 * Palette is hand-picked for two properties:
 *   1. Sufficient contrast against ink-1 (white-ish text) at our
 *      dark-mode bg-1 baseline.
 *   2. Distinct hues — no two adjacent colors that read as the same
 *      under the brief glance an avatar gets.
 *
 * Hash is FNV-1a on the id string. We don't need cryptographic strength;
 * uniformity matters more than unpredictability, and FNV-1a on short
 * snowflake-ish ids gives a clean spread across 8 buckets.
 */

const PALETTE = [
  // [bg-class, text-class] pairs. text-class is always a high-contrast
  // pairing for the bg, picked manually rather than computed at runtime
  // (cheaper, and the palette is small enough that a runtime contrast
  // check would just be busywork).
  ['bg-rose-700', 'text-rose-50'],
  ['bg-amber-600', 'text-amber-50'],
  ['bg-emerald-700', 'text-emerald-50'],
  ['bg-teal-700', 'text-teal-50'],
  ['bg-sky-700', 'text-sky-50'],
  ['bg-indigo-700', 'text-indigo-50'],
  ['bg-purple-700', 'text-purple-50'],
  ['bg-pink-700', 'text-pink-50'],
] as const;

// Pre-joined class strings — hoist the .join(' ') allocation out of
// the hot path. avatarColor is called once per avatar on every render
// (chat scrollback, member lists, voice panels) and the .join was
// allocating a fresh string every time. With 8 entries pre-computed,
// every call returns an existing reference.
const PALETTE_JOINED: readonly string[] = PALETTE.map((p) => p.join(' '));

/** Return Tailwind classes for a deterministic avatar background +
    text color based on the supplied id. Empty/undefined id falls
    back to the first palette entry, which is fine because the empty
    state is rare and we just need something. */
export function avatarColor(id: string | null | undefined): string {
  if (!id) return PALETTE_JOINED[0]!;
  // FNV-1a 32-bit. Constants are the canonical ones from the spec.
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    // Multiplication kept in 32-bit by Math.imul, otherwise JS would
    // promote to a float and lose the lower bits we care about.
    hash = Math.imul(hash, 0x01000193);
  }
  return PALETTE_JOINED[Math.abs(hash) % PALETTE_JOINED.length]!;
}

/** Build initials from a display name. Splits on whitespace, takes the
    first letter of up to two words, uppercases. Empty/missing → '?'. */
export function avatarInitials(name: string | null | undefined): string {
  if (!name) return '?';
  const letters = name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');
  return letters || '?';
}
