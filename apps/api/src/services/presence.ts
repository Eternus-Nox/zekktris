/**
 * Presence service
 * ----------------
 * The "last online" stamp behind the friends list.
 *
 * `users.lastSeenAt` records the last moment we OBSERVED a user holding a live
 * gateway connection while visible. Only two events move it, both owned by the
 * gateway:
 *
 *   - connect    (IDENTIFY / RESUME) — bounds the value for a session that
 *                never gets a clean close (process crash, host reboot): without
 *                it, a user online for three days would read as "last seen
 *                three days ago" the moment the server died.
 *   - disconnect (the effective status turning 'offline' — the final
 *                connection closed, after the voice-eviction grace; written
 *                by the presence recompute, gateway/presence.ts) — the
 *                value that actually matters: the moment they went away.
 *
 * NOT stamped on token refresh. `sessions.lastUsedAt` advances while a phone
 * sits idle in a pocket, so it answers "when did a token last refresh", not
 * "when was this person last here".
 *
 * PRIVACY — the guard below is the whole point of this module living in one
 * place. An invisible user reads as plain 'offline' to everyone else. If this
 * stamp kept advancing while they were invisible, an observer could poll the
 * friends list, watch the timestamp tick, and infer "they're online right
 * now" — which defeats Invisible. So every write is gated on
 * `status <> 'invisible'` IN THE UPDATE ITSELF (not just in a caller's
 * if-statement), which also closes the read-then-write race where a user
 * flips to invisible between the caller's status read and this write. The
 * value freezes at their last visible moment and only thaws when they come
 * back non-invisible.
 */

import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from '../db';
import { log } from '../log';

/**
 * Stamp `users.lastSeenAt = now` for a user who just connected or just
 * disconnected — unless they're invisible, in which case the stamp is frozen
 * (see the privacy note above).
 *
 * Best-effort by design: presence is soft state, and a failed stamp must never
 * take down a gateway connect/disconnect path. Errors are logged, not thrown.
 * The caller may await it (cheap single-row PK update) or fire-and-forget.
 */
export async function touchLastSeen(userId: bigint): Promise<void> {
  try {
    await db
      .update(schema.users)
      .set({ lastSeenAt: new Date() })
      .where(and(eq(schema.users.id, userId), ne(schema.users.status, 'invisible')));
  } catch (err) {
    log.warn('presence: last-seen stamp failed', {
      userId: userId.toString(),
      err: (err as Error).message,
    });
  }
}
