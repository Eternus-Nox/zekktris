/**
 * SpeakingRing — speaking indicator drawn around an avatar.
 * ---------------------------------------------------------
 * A clean ring in the Zekktris theme colors (blue → purple). The ring
 * is drawn as a conic gradient masked into a band whose thickness is a
 * PERCENTAGE of the element radius, so it scales proportionally with
 * the avatar at every size — the small channel-rail avatars and the
 * larger voice-scene avatars all get a correctly-proportioned ring.
 *
 * Renders absolutely-positioned inside a `relative` avatar wrapper;
 * the negative inset makes the ring sit just outside the avatar, and
 * because it's `inset: -Npx` on all sides it resizes with the wrapper
 * (which tracks the avatar's size). Pointer-events disabled so it never
 * intercepts avatar clicks.
 *
 * Shared by the channel rail (ChannelList) and the voice scene
 * (VoiceView) so the indicator is identical everywhere.
 *
 * (The elaborate black-hole accretion disk lives at the CENTRE of the
 * voice arena that participants orbit — see VoiceView — not here.)
 */

export function SpeakingRing({
  inset = 2,
  speaking = true,
}: {
  inset?: number;
  /** When provided, the ring stays mounted and fades on speaking change
   *  (so it eases in/out instead of popping). Omit (defaults true) for the
   *  legacy mount-when-speaking callers (the channel rail). */
  speaking?: boolean;
}) {
  // Ring band as a fraction of the radius. `closest-side` makes the
  // mask gradient's radius equal the circle radius, so these stops are
  // size-independent → the ring is always the same proportion thick.
  const ringMask =
    'radial-gradient(closest-side, transparent 76%, #000 82%, #000 100%)';
  return (
    <div
      className="absolute rounded-full pointer-events-none"
      style={{
        inset: `-${inset}px`,
        opacity: speaking ? 1 : 0,
        transition: 'opacity 160ms ease',
      }}
      aria-hidden
    >
      {/* Themed gradient ring, masked to a proportional band. Uses the
          active theme's accent trio so it tracks Appearance. */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          background:
            'conic-gradient(from 130deg, var(--accent), var(--accent-2), var(--accent-3), var(--accent-2), var(--accent))',
          WebkitMask: ringMask,
          mask: ringMask,
        }}
      />
      {/* Soft accent glow so the ring reads as lit. */}
      <div
        className="absolute inset-0 rounded-full"
        style={{
          boxShadow:
            '0 0 6px 1px rgb(var(--c-accent) / 0.40), 0 0 11px 2px rgb(var(--c-accent-2) / 0.32)',
        }}
      />
    </div>
  );
}
