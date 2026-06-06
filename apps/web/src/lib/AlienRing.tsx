/**
 * AlienRing
 * ---------
 * Wavy circular outline used as the "is speaking" indicator wrapped
 * AROUND an avatar. The shape is a closed SVG path tracing a circle
 * with sinusoidal perturbation on its radius — an undulating ring
 * that orbits around the avatar.
 *
 * Stroke uses a multi-color linearGradient drawn from the same
 * palette as the black hole's accretion disk (indigo → violet →
 * blue → cyan → light purple → indigo). Drawn diagonally across the
 * viewBox so different sectors of the ring show different colors at
 * any moment. Combined with the CSS rotation animation, the ring's
 * circumference appears to flow through the disk's palette as it
 * spins around the avatar — visually reads as the same color system
 * orbiting the central singularity.
 *
 * Sizing: the SVG fills its container (100% w/h, viewBox 0 0 100
 * 100). Callers wrap the avatar in a relative div and size that
 * wrapper to control how far past the avatar edge the ring extends.
 *
 * Render conditionally from the parent: `{speaking && <AlienRing />}`
 * so the rotation only runs while speaking and stops cleanly.
 */

import { useId } from 'react';

// Build the wavy circular path once at module load — geometry is
// identical for every render and depends only on constants. 96
// sample points around the circle, 8 wave peaks (counted around the
// full perimeter), amplitude ±3 in viewBox units. baseRadius 47
// keeps the outermost peaks inside the viewBox edge (47 + 3 = 50,
// which is the viewBox half-width).
const WAVY_RING_PATH = (() => {
  const N = 96;
  const waves = 8;
  const baseR = 47;
  const amp = 3;
  const points: string[] = [];
  for (let i = 0; i <= N; i++) {
    const angle = (i / N) * Math.PI * 2;
    const r = baseR + Math.sin(angle * waves) * amp;
    const x = 50 + r * Math.cos(angle);
    const y = 50 + r * Math.sin(angle);
    points.push(`${x.toFixed(2)},${y.toFixed(2)}`);
  }
  // Use a polyline-style path (M then L for each subsequent point)
  // ending with Z to close. SVG renders this as a smooth-enough
  // wavy outline given 96 samples — the eye doesn't pick up
  // individual segments at typical avatar sizes.
  return `M${points.join(' L')} Z`;
})();

type Props = {
  className?: string;
};

export function AlienRing({ className = '' }: Props) {
  // useId gives each AlienRing instance a unique stable identifier
  // for the gradient def. Multiple speaking participants on screen
  // would otherwise collide on a shared hardcoded `<linearGradient
  // id="...">` — browsers resolve url(#id) against the first match
  // in document order, so only the first-rendered ring would get
  // the gradient. Strip the `:` React generates in useIds because
  // some browsers were historically strict about it in url() refs.
  const rawId = useId();
  const gradId = `zk-alien-ring-grad-${rawId.replace(/:/g, '')}`;

  return (
    <svg
      viewBox="0 0 100 100"
      className={`zk-alien-ring ${className}`}
      preserveAspectRatio="xMidYMid meet"
      width="100%"
      height="100%"
      style={{ display: 'block' }}
      aria-hidden
    >
      <defs>
        {/* Color sweep matching the accretion disk's conic-gradient.
            Anchored to userSpace diagonally across the 0-100 viewBox
            so different sectors of the ring pick up different colors
            at any moment. As the ring rotates (CSS animation on the
            path), each point traces a circle through the gradient,
            producing apparent color flow around the circumference. */}
        <linearGradient
          id={gradId}
          gradientUnits="userSpaceOnUse"
          x1="0"
          y1="0"
          x2="100"
          y2="100"
        >
          <stop offset="0%" stopColor="var(--accent-2)" />
          <stop offset="20%" stopColor="var(--accent-2)" />
          <stop offset="40%" stopColor="var(--accent)" />
          <stop offset="60%" stopColor="var(--accent)" />
          <stop offset="80%" stopColor="var(--accent-3)" />
          <stop offset="100%" stopColor="var(--accent-2)" />
        </linearGradient>
      </defs>
      <path
        d={WAVY_RING_PATH}
        stroke={`url(#${gradId})`}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
