/**
 * Supervision auto-release sweep
 * ------------------------------
 * Revokes active parent/child supervision links once the child turns 18.
 *
 * This is HYGIENE ONLY: the 18+ release is already computed on the fly inside
 * `getActiveParentIds` + `buildE2eePolicy` (a link whose child's DOB is on or
 * before today-18y is ignored), so restrictions, E2EE, and parent review
 * access all release the moment the child turns 18, regardless of whether this
 * sweep has run. The sweep just tidies the persisted `status` so an adult's
 * stale link stops appearing in parent dashboards and the table doesn't carry
 * dead "active" rows.
 */
import { and, eq, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { adultCutoffDob } from '../lib/age';
import { notifySupervisionChanged } from './supervision';

export async function sweepParentLinksByAge(): Promise<{ revoked: number }> {
  const cutoff = adultCutoffDob(); // DOB <= cutoff ⇒ 18+
  const revoked = await db
    .update(schema.parentChildLinks)
    .set({ status: 'revoked', revokedAt: new Date() })
    .where(
      and(
        eq(schema.parentChildLinks.status, 'active'),
        sql`${schema.parentChildLinks.childId} IN (
          SELECT ${schema.users.id} FROM ${schema.users}
          WHERE ${schema.users.dateOfBirth} IS NOT NULL
            AND ${schema.users.dateOfBirth} <= ${cutoff}
        )`,
      ),
    )
    .returning({ childId: schema.parentChildLinks.childId });

  // Tell each released account's connected devices to drop their supervision
  // gates. Enforcement already released on the fly at 18, but a client that
  // cached its restrictions at startup would keep applying them until a cold
  // start — so the newly-adult user stays needlessly restricted in the UI.
  // Deduped: two guardians on one child produce two revoked rows, one user.
  // Only the replica whose UPDATE actually matched the rows gets here, so
  // there's no duplicate fan-out across nodes.
  for (const childId of new Set(revoked.map((r) => r.childId))) {
    await notifySupervisionChanged(childId);
  }
  return { revoked: revoked.length };
}
