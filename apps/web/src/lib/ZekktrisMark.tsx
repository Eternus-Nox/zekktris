import { useId } from 'react';

/**
 * ZekktrisMark — the angled "Z" sigil brand mark, rendered inline so its
 * gradient tracks the active theme (Appearance). The static /icon.svg asset
 * (favicon / PWA tile) keeps its fixed colors since those render outside the
 * app and can't read CSS variables; in-app surfaces (auth header, loading
 * splash) use this themed version instead.
 *
 * Gradient stops map to the theme accent trio: accent → accent-2 → accent-3.
 * The tile background uses the themeable bg channels, so OLED themes render a
 * true-black tile.
 */
export function ZekktrisMark({
  size = 48,
  className,
}: {
  size?: number;
  className?: string;
}) {
  // useId keeps the gradient/filter ids unique if more than one mark renders
  // in the same document (duplicate SVG ids would otherwise cross-wire fills).
  const uid = useId().replace(/:/g, '');
  const abyss = `zk-mark-abyss-${uid}`;
  const halo = `zk-mark-halo-${uid}`;
  const sigil = `zk-mark-sigil-${uid}`;
  const glow = `zk-mark-glow-${uid}`;
  const zPath =
    'M192 224 L832 224 L832 352 L416 704 L832 704 L832 832 L192 832 L192 704 L608 352 L192 352 Z';
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={abyss} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="rgb(var(--c-bg-0))" />
          <stop offset="100%" stopColor="rgb(var(--c-bg-2))" />
        </linearGradient>
        <radialGradient id={halo} cx="50%" cy="50%" r="58%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.32" />
          <stop offset="45%" stopColor="var(--accent-2)" stopOpacity="0.16" />
          <stop offset="100%" stopColor="var(--accent-3)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={sigil} x1="0" y1="0" x2="1024" y2="1024" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="var(--accent)" />
          <stop offset="0.5" stopColor="var(--accent-2)" />
          <stop offset="1" stopColor="var(--accent-3)" />
        </linearGradient>
        <filter id={glow} x="-10%" y="-10%" width="120%" height="120%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>
      <rect x="0" y="0" width="1024" height="1024" rx="232" ry="232" fill={`url(#${abyss})`} />
      <rect x="0" y="0" width="1024" height="1024" rx="232" ry="232" fill={`url(#${halo})`} />
      <path d={zPath} fill={`url(#${sigil})`} filter={`url(#${glow})`} opacity="0.6" />
      <path d={zPath} fill={`url(#${sigil})`} />
      <path
        d={zPath}
        fill="none"
        stroke="#f3f6fa"
        strokeOpacity="0.25"
        strokeWidth="3"
        strokeLinejoin="round"
      />
    </svg>
  );
}
