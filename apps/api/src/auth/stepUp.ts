import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { verifyPassword } from './passwords';
import { RateLimiter } from '../lib/rateLimit';

// One per-user budget shared by every "step-up" endpoint that re-verifies the
// current password or a TOTP code on an already-authenticated request
// (password/username/email change, 2FA confirm/disable, passkey enroll/delete).
// Without this, a stolen access token can brute-force the password or the
// 6-digit TOTP — the exact secrets these checks exist to demand.
const stepUpRl = new RateLimiter(10, 15 * 60_000, 'step-up-verify');

export async function consumeStepUp(userId: bigint): Promise<void> {
  const r = await stepUpRl.consume(userId.toString());
  if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
}

/**
 * Consume the step-up budget AND re-verify the account password on an
 * already-authenticated request. Throws `invalidCredentials` on mismatch.
 *
 * Gate sensitive *credential* mutations (passkey enroll/delete, 2FA enroll)
 * with this: without it a transient stolen access token (chair-jack, XSS,
 * borrowed unlocked device) can silently plant an attacker's OWN login factor
 * — and a passkey/TOTP planted that way SURVIVES the victim's password reset
 * and "log out everywhere," because neither remediation deletes login factors.
 * Requiring the password to add or remove a factor is what makes the standard
 * "reset + revoke sessions" recovery actually lock the attacker out.
 */
export async function assertStepUpPassword(
  userId: bigint,
  currentPassword: string,
): Promise<void> {
  await consumeStepUp(userId);
  const [user] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
    .limit(1);
  if (!user) throw errors.unauthenticated('Account no longer exists');
  const ok = await verifyPassword(currentPassword, user.passwordHash);
  if (!ok) throw errors.invalidCredentials();
}
