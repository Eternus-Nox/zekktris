/**
 * AchievementsShelf — earned-badge strip for profiles.
 * --------------------------------------------------
 * Fetches `/users/@me/achievements` for the viewer's own profile (userId
 * omitted) or `/users/:id/achievements` for someone else's — the server
 * returns an empty list when that user keeps their shelf private, so the
 * section simply doesn't render. Mirrors the iOS AchievementsSection:
 * icon badge + name + marker capsule.
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

export function AchievementsShelf({ userId }: { userId?: string }) {
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

  if (!achievements || achievements.length === 0) return null;

  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold tracking-wide text-ink-3 mb-1.5">
        ACHIEVEMENTS
      </div>
      <div className="flex flex-wrap gap-1.5">
        {achievements.map((a) => {
          const Icon = badgeIcon(a.id);
          return (
            <span
              key={a.id}
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
        })}
      </div>
    </div>
  );
}
