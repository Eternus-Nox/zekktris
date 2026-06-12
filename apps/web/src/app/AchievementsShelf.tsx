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
  MessageSquare,
  Mic,
  Shield,
  Users,
} from '../lib/icons';

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

function EarnedBadge({ a }: { a: Achievement }) {
  const Icon = badgeIcon(a.id);
  return (
    <span
      title={a.description}
      className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-bg-2 border border-line text-ink-2"
    >
      <Icon size={13} className="text-accent shrink-0" />
      <span className="text-xs">{a.name}</span>
      {a.marker && (
        <span className="px-1 py-px rounded bg-accent/15 text-accent font-mono text-[10px] leading-none">
          {a.marker}
        </span>
      )}
    </span>
  );
}

function LockedBadge({ a }: { a: Achievement }) {
  const Icon = badgeIcon(a.id);
  return (
    <span
      title={a.description}
      className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-bg-2/50 border border-line/60 text-ink-3 opacity-80"
    >
      <Icon size={13} className="shrink-0" />
      <span className="text-xs">{a.name}</span>
      {typeof a.goal === 'number' && (
        <span className="px-1 py-px rounded bg-bg-3 font-mono text-[10px] leading-none">
          {Math.min(a.value, a.goal).toLocaleString()}/{a.goal.toLocaleString()}
        </span>
      )}
    </span>
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
        <div className="flex flex-wrap gap-1.5">
          {earned.map((a) => (
            <EarnedBadge key={a.id} a={a} />
          ))}
        </div>
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
      <div className="text-[11px] text-ink-3 mb-2">
        {earned.length} of {achievements.length} earned
      </div>
      {earned.length > 0 && (
        <>
          <div className="text-[11px] font-semibold tracking-wide text-ink-3 mb-1.5">
            EARNED
          </div>
          <div className="flex flex-wrap gap-1.5">
            {earned.map((a) => (
              <EarnedBadge key={a.id} a={a} />
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
          <div className="flex flex-wrap gap-1.5">
            {locked.map((a) => (
              <LockedBadge key={a.id} a={a} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}
