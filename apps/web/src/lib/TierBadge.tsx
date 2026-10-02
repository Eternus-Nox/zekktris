/**
 * Perk-tier metadata + badge pill.
 *
 * One source of truth for tier labels/colors so the profile card, the
 * Settings perk list, and the admin panel all render the same trio:
 * Scout / Guardian / Legend. Tiers are free — an admin gives them out.
 */
export const TIER_META: Record<string, { label: string; color: string }> = {
  scout: { label: 'Scout', color: '#3d9bff' },
  guardian: { label: 'Guardian', color: '#9d7bff' },
  legend: { label: 'Legend', color: '#f4c95b' },
};

/** Small uppercase pill (mirrors the BOT/WEBHOOK badge shape). */
export function TierBadge({
  tier,
  className = '',
}: {
  tier?: string | null;
  className?: string;
}) {
  if (!tier) return null;
  const meta = TIER_META[tier];
  if (!meta) return null;
  return (
    <span
      className={`inline-flex items-center px-1.5 rounded text-[0.55rem] font-bold uppercase tracking-wider leading-[1.1rem] shrink-0 ${className}`}
      style={{
        color: meta.color,
        backgroundColor: `color-mix(in srgb, ${meta.color} 18%, transparent)`,
      }}
      title={`${meta.label} tier`}
    >
      {meta.label}
    </span>
  );
}
