/**
 * AdminUI
 * -------
 * Presentation primitives shared by the admin surfaces — AdminPanel's
 * inline tabs and the tabs that live in their own files.
 *
 * They sit here rather than in AdminPanel.tsx because AdminPanel imports
 * the split-out tabs; a tab reaching back into AdminPanel for a StatCard
 * would close an import cycle. Nothing here holds state or talks to the
 * API — it is markup + one formatter, so both directions stay cheap.
 */
import type { ComponentType, ReactNode } from 'react';

export function StatCard({
  label,
  value,
  subtle,
}: {
  label: string;
  value: string;
  subtle?: string;
}) {
  return (
    <div className="rounded-xl border border-line bg-bg-2 p-4 transition-colors hover:border-accent/30">
      <div className="text-[11px] text-ink-3 uppercase tracking-wider font-semibold">{label}</div>
      <div className="mt-1.5 text-2xl font-semibold text-ink-1 tabular-nums">{value}</div>
      {subtle && <div className="mt-1 text-xs text-ink-3">{subtle}</div>}
    </div>
  );
}

// Shared tab header — a gradient squircle icon + title + optional subtitle and
// trailing action, matching the Family page's section header so the admin
// surface reads as part of the same app rather than a bolt-on console.
export function AdminTabHeader({
  icon: Icon,
  title,
  subtitle,
  action,
}: {
  icon: ComponentType<{ size?: number; className?: string }>;
  title: string;
  subtitle?: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3 mb-5">
      <div className="flex items-start gap-3 min-w-0">
        <div className="shrink-0 w-10 h-10 rounded-2xl bg-gradient-to-br from-accent to-accent-2 grid place-items-center text-bg-0 shadow-[0_8px_28px_var(--accent-glow)]">
          <Icon size={18} />
        </div>
        <div className="min-w-0">
          <h2 className="text-lg font-semibold text-ink-1 leading-tight truncate">{title}</h2>
          {subtitle && <p className="text-xs text-ink-3 mt-0.5 leading-relaxed">{subtitle}</p>}
        </div>
      </div>
      {action && <div className="shrink-0">{action}</div>}
    </div>
  );
}

/**
 * Human-readable elapsed time from a second count (e.g. "3d 4h", "12m").
 * Used for process uptime on the Overview tab and for room/participant age
 * on the live voice monitor, so the two read the same way.
 */
export function fmtUptime(s: number): string {
  if (s < 60) return `${s}s`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  return `${m}m`;
}
