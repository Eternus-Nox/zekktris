/**
 * AchievementsShelf — badge strip for profiles, mirroring the iOS
 * AchievementsSection. Two modes:
 *   • earnedOnly (profile card): shows EARNED badges only, with an explicit
 *     "No achievements unlocked yet." empty state — matches iOS
 *     AchievementsSection(earnedOnly: true).
 *   • full (Settings gallery): shows earned under "ACHIEVEMENTS" and in-progress
 *     under "IN PROGRESS" with a value/goal counter — matches the iOS
 *     Settings achievements gallery.
 * Fetches `/users/@me/achievements` for the viewer's own shelf (userId omitted)
 * or `/users/:id/achievements` for someone else's (the server returns an empty
 * list for a private shelf).
 */

import { useEffect, useState } from 'react';
import type { Achievement } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import {
  Activity,
  Calendar,
  Clock,
  CornerUpLeft,
  Lock,
  MessageSquare,
  Mic,
  Shield,
  Users,
} from '../lib/icons';

/** Roman numeral (covers our max 4 tiers; handles more if ever added). */
function roman(n: number): string {
  const vals: [number, string][] = [[10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
  let s = '';
  for (const [v, sym] of vals) while (n >= v) { s += sym; n -= v; }
  return s;
}

/** Roman numeral per achievement id for any FAMILY (same `name`) with more than
 *  one tier, so duplicates like Chatterbox / Social Circle are distinguishable
 *  (Chatterbox I…IV, ordered by goal). Single-tier families get nothing. */
function tierNumerals(all: Achievement[]): Record<string, string> {
  const byName: Record<string, Achievement[]> = {};
  for (const a of all) (byName[a.name] ??= []).push(a);
  const out: Record<string, string> = {};
  for (const group of Object.values(byName)) {
    if (group.length < 2) continue;
    [...group]
      .sort((x, y) => (x.goal ?? 0) - (y.goal ?? 0))
      .forEach((a, i) => {
        out[a.id] = roman(i + 1);
      });
  }
  return out;
}

function badgeIcon(id: string) {
  if (id.startsWith('veteran')) return Calendar;
  if (id.startsWith('chatterbox')) return MessageSquare;
  if (id.startsWith('social')) return Users;
  if (id.startsWith('night_owl')) return Clock;
  if (id.startsWith('first_responder')) return CornerUpLeft;
  if (id.startsWith('marathon')) return Activity;
  if (id.startsWith('founder')) return Shield;
  if (id.startsWith('voice_of_people')) return Mic;
  return Activity;
}

/**
 * Achievement TILE — mirrors the iOS AchievementBadge (MainView.swift). A
 * vertical card: a 40px circular icon badge (accent→accent-2 gradient when
 * earned, solid bg-3 when locked), the name beneath it, and a value/goal chip
 * for locked entries. Locked tiles swap the glyph for a lock and dim the card.
 * (iOS Theme.ink4 has no Tailwind token, so locked text uses its hex #454d5e.)
 */
function AchievementTile({
  a,
  earned,
  numeral,
  onClick,
}: {
  a: Achievement;
  earned: boolean;
  numeral?: string;
  onClick: () => void;
}) {
  const Icon = earned ? badgeIcon(a.id) : Lock;
  return (
    <button
      type="button"
      onClick={onClick}
      title={a.description}
      className={`flex flex-col items-center gap-1.5 rounded-[10px] px-1 py-2 text-center transition-colors hover:brightness-110 ${
        earned ? 'bg-bg-2' : 'bg-bg-2/55'
      }`}
    >
      <div className="relative">
        <div
          className={`flex h-10 w-10 items-center justify-center rounded-full ${
            earned ? 'bg-gradient-to-br from-accent/35 to-accent-2/25' : 'bg-bg-3'
          }`}
        >
          <Icon size={16} className={earned ? 'text-accent' : 'text-[#454d5e]'} />
        </div>
        {earned && a.marker && (
          <span className="absolute -bottom-0.5 -right-1 rounded-full bg-accent px-1 font-mono text-[8px] font-bold leading-tight text-bg-0">
            {a.marker}
          </span>
        )}
      </div>
      <span
        className={`max-w-full truncate text-[10px] font-medium ${
          earned ? 'text-ink-2' : 'text-[#454d5e]'
        }`}
      >
        {numeral ? `${a.name} ${numeral}` : a.name}
      </span>
      {!earned && typeof a.goal === 'number' && (
        <span className="rounded-full bg-bg-3 px-1.5 py-px font-mono text-[8px] font-semibold leading-none text-[#454d5e]">
          {Math.min(a.value, a.goal).toLocaleString()}/{a.goal.toLocaleString()}
        </span>
      )}
    </button>
  );
}

/** Tap-to-open detail: name (+ tier numeral), the how-to-earn description, and
 *  earned / progress state. Mirrors the iOS AchievementDetailView. */
function AchievementDetailModal({
  a,
  numeral,
  onClose,
}: {
  a: Achievement;
  numeral?: string;
  onClose: () => void;
}) {
  const earned = a.earned !== false;
  const Icon = earned ? badgeIcon(a.id) : Lock;
  return (
    <div
      className="fixed inset-0 z-[120] flex items-center justify-center bg-bg-1/70 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      onClick={onClose}
    >
      <div
        className="w-full max-w-xs rounded-xl border border-line bg-bg-2 p-5 text-center shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div
          className={`mx-auto flex h-16 w-16 items-center justify-center rounded-full ${
            earned ? 'bg-gradient-to-br from-accent/35 to-accent-2/25' : 'bg-bg-3'
          }`}
        >
          <Icon size={26} className={earned ? 'text-accent' : 'text-[#454d5e]'} />
        </div>
        <div className="mt-3 text-lg font-bold text-ink-1">
          {numeral ? `${a.name} ${numeral}` : a.name}
        </div>
        <p className="mt-1 text-sm text-ink-2">{a.description}</p>
        {earned ? (
          <div className="mt-3 text-sm font-semibold text-accent">✓ Earned</div>
        ) : (
          typeof a.goal === 'number' &&
          a.goal > 0 && (
            <div className="mx-auto mt-3 max-w-[220px]">
              <div className="h-1.5 w-full overflow-hidden rounded-full bg-bg-3">
                <div
                  className="h-full rounded-full bg-accent/70"
                  style={{ width: `${Math.min(100, (a.value / a.goal) * 100)}%` }}
                />
              </div>
              <div className="mt-1 font-mono text-xs font-semibold text-ink-3">
                {Math.min(a.value, a.goal).toLocaleString()}/{a.goal.toLocaleString()}
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}

export function AchievementsShelf({
  userId,
  earnedOnly = false,
}: {
  userId?: string;
  earnedOnly?: boolean;
}) {
  const { rest } = useAuth();
  const [achievements, setAchievements] = useState<Achievement[] | null>(null);
  const [selected, setSelected] = useState<Achievement | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = userId
          ? await rest.userAchievements(userId)
          : await rest.myAchievements();
        if (!cancelled) setAchievements(r.achievements);
      } catch {
        if (!cancelled) setAchievements([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rest, userId]);

  if (achievements === null) return null; // still loading

  // Server orders earned-first; locked entries carry a value/goal progress.
  const earned = achievements.filter((a) => a.earned !== false);
  const locked = achievements.filter((a) => a.earned === false);
  const numerals = tierNumerals(achievements);
  const detailModal = selected && (
    <AchievementDetailModal
      a={selected}
      numeral={numerals[selected.id]}
      onClose={() => setSelected(null)}
    />
  );

  // Profile card: earned badges only, with an explicit empty state.
  if (earnedOnly) {
    if (earned.length === 0) {
      return <div className="mt-3 text-xs text-ink-3">No achievements unlocked yet.</div>;
    }
    return (
      <div className="mt-3">
        <div className="text-[11px] font-semibold tracking-wide text-ink-3 mb-1.5">
          ACHIEVEMENTS
        </div>
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(92px,1fr))]">
          {earned.map((a) => (
            <AchievementTile key={a.id} a={a} earned numeral={numerals[a.id]} onClick={() => setSelected(a)} />
          ))}
        </div>
        {detailModal}
      </div>
    );
  }

  // Full gallery: earned + in-progress. Empty catalog → explicit empty state
  // (mirrors the iOS Settings gallery rather than rendering nothing).
  if (achievements.length === 0) {
    return <div className="mt-3 text-xs text-ink-3">No achievements yet.</div>;
  }
  return (
    <div className="mt-3">
      <div className="text-xs font-medium text-ink-3 mb-2">
        {earned.length} of {achievements.length} earned
      </div>
      {earned.length > 0 && (
        <>
          <div className="text-[11px] font-semibold tracking-wide text-ink-3 mb-1.5">
            EARNED
          </div>
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(92px,1fr))]">
            {earned.map((a) => (
              <AchievementTile key={a.id} a={a} earned numeral={numerals[a.id]} onClick={() => setSelected(a)} />
            ))}
          </div>
        </>
      )}
      {locked.length > 0 && (
        <>
          <div
            className={`text-[11px] font-semibold tracking-wide text-ink-3 mb-1.5 ${
              earned.length > 0 ? 'mt-3' : ''
            }`}
          >
            IN PROGRESS
          </div>
          <div className="grid gap-2 [grid-template-columns:repeat(auto-fill,minmax(92px,1fr))]">
            {locked.map((a) => (
              <AchievementTile key={a.id} a={a} earned={false} numeral={numerals[a.id]} onClick={() => setSelected(a)} />
            ))}
          </div>
        </>
      )}
      {detailModal}
    </div>
  );
}
