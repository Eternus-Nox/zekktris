/**
 * Account changes service
 * -----------------------
 * Two flows:
 *
 *   1. Username change — once, then a 90-day cooldown. Service
 *      verifies the password, checks the cooldown, validates the
 *      new username, ensures it isn't taken, and atomically updates
 *      the row + stamps usernameChangedAt.
 *
 *   2. Email change — verification-link flow modeled on the existing
 *      password-reset code path. Two phases:
 *        a. requestEmailChange — verify password, validate new
 *           address, generate a plaintext token + store SHA-256 hash,
 *           mail the verification link to the NEW address.
 *        b. confirmEmailChange — hash the token from the URL, look
 *           up the row, gate on used_at IS NULL + expires_at > now,
 *           re-check email uniqueness (race protection), atomically
 *           update + mark used.
 *
 *      The verification goes to the NEW address (not the old one)
 *      because users often change email BECAUSE they lost access to
 *      the old one. Sending to old would lock them out of the exact
 *      migration we're trying to support.
 */

import { and, eq, isNull, gt, sql } from 'drizzle-orm';
import { createHash, randomBytes } from 'crypto';
import { db, isUniqueViolation, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import { verifyPassword } from '../auth/passwords';

const USERNAME_COOLDOWN_DAYS = 90;
const EMAIL_CHANGE_TOKEN_BYTES = 32; // 256 bits → URL-safe base64
const EMAIL_CHANGE_EXPIRES_MINUTES = 60;

// ── Username change ────────────────────────────────────────────────────

/**
 * Eligibility check, separated from the change call so the UI can
 * surface the next-eligible-at date without firing a write.
 */
export function usernameCooldownRemainingMs(usernameChangedAt: Date | null): number {
  if (!usernameChangedAt) return 0;
  const now = Date.now();
  const eligibleAt =
    usernameChangedAt.getTime() + USERNAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000;
  return Math.max(0, eligibleAt - now);
}

export async function changeUsername(args: {
  userId: bigint;
  currentPassword: string;
  /** Already validated + lowercased by the route's zod schema. */
  newUsername: string;
}): Promise<{ user: typeof schema.users.$inferSelect }> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, args.userId))
    .limit(1);
  if (!user) throw errors.notFound('User not found');

  // Re-verify the password every time. We don't trust an auth cookie
  // alone to authorize identity changes — the chair-jacking attack
  // surface (someone walks up to an unlocked laptop) is bad enough
  // that re-prompting for the password is worth the friction.
  const ok = await verifyPassword(args.currentPassword, user.passwordHash);
  if (!ok) throw errors.forbidden('Wrong password');

  // Cooldown check. Null usernameChangedAt = never changed → always
  // eligible. Otherwise enforce 90 days from the last change.
  const remaining = usernameCooldownRemainingMs(user.usernameChangedAt);
  if (remaining > 0) {
    const days = Math.ceil(remaining / (24 * 60 * 60 * 1000));
    throw errors.badRequest(
      `You can change your username again in ${days} day${days === 1 ? '' : 's'}.`,
    );
  }

  // No-op short-circuit: if the user "changed" to their existing
  // name, don't burn their cooldown for nothing.
  if (args.newUsername === user.username) {
    throw errors.badRequest("That's already your username.");
  }

  // Atomically check-and-update so two concurrent change requests
  // can't both win. The WHERE clause re-asserts the cooldown state
  // we just read; if another tab raced us, the UPDATE returns zero
  // rows and we report the cooldown error.
  const cooldownThreshold = new Date(
    Date.now() - USERNAME_COOLDOWN_DAYS * 24 * 60 * 60 * 1000,
  );
  const [updated] = await db
    .update(schema.users)
    .set({
      username: args.newUsername,
      usernameChangedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(schema.users.id, args.userId),
        // Either never changed OR changed before the cooldown window.
        sql`(${schema.users.usernameChangedAt} IS NULL OR ${schema.users.usernameChangedAt} <= ${cooldownThreshold.toISOString()}::timestamptz)`,
      ),
    )
    .returning();
  if (!updated) {
    // Either the username was taken (unique violation would surface
    // separately — see catch below at the route layer) or the
    // cooldown re-check failed. Both are user-actionable as the
    // same generic error.
    throw errors.badRequest('Username change rejected — try again.');
  }

  return { user: updated };
}

// ── Email change ───────────────────────────────────────────────────────

function generateToken(): { plain: string; hash: string } {
  const buf = randomBytes(EMAIL_CHANGE_TOKEN_BYTES);
  // URL-safe base64 (no padding) so the token can be passed in a
  // GET query string without escaping.
  const plain = buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const hash = createHash('sha256').update(plain).digest('hex');
  return { plain, hash };
}

/**
 * Phase 1: user submits desired new email + current password. We
 * validate everything, create the change-request row with a hashed
 * token, and the caller (route) sends the verification email to
 * the NEW address.
 *
 * Returns the plaintext token so the route can build the URL +
 * mail it. The token is NEVER returned to the client over HTTP —
 * the only place it surfaces is in the email body.
 */
export async function requestEmailChange(args: {
  userId: bigint;
  currentPassword: string;
  /** Already lowercased + validated by the route's zod schema. */
  newEmail: string;
}): Promise<{ token: string; expiresInMinutes: number; newEmail: string }> {
  const [user] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, args.userId))
    .limit(1);
  if (!user) throw errors.notFound('User not found');

  const ok = await verifyPassword(args.currentPassword, user.passwordHash);
  if (!ok) throw errors.forbidden('Wrong password');

  if (user.email === args.newEmail) {
    throw errors.badRequest("That's already your email.");
  }

  // Is the new address already in use by someone else?
  const [conflict] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(eq(schema.users.email, args.newEmail))
    .limit(1);
  if (conflict) {
    // Note: we don't say "address is taken" because that's an info
    // leak (lets you probe whether an email is registered). The
    // route layer can map this to a generic "verification email
    // sent" response and we just silently don't actually send
    // anything, OR we can return the same generic error here and
    // let the route map it. Caller decides.
    throw errors.badRequest('Cannot use that email.');
  }

  // Invalidate any prior outstanding requests for this user. We don't
  // delete — we just mark them used so they can't double-confirm.
  // This prevents a user from accumulating multiple valid tokens
  // that all point at different target addresses.
  await db
    .update(schema.emailChangeRequests)
    .set({ usedAt: new Date() })
    .where(
      and(
        eq(schema.emailChangeRequests.userId, args.userId),
        isNull(schema.emailChangeRequests.usedAt),
      ),
    );

  const { plain, hash } = generateToken();
  const id = nextSnowflake();
  const expiresAt = new Date(
    Date.now() + EMAIL_CHANGE_EXPIRES_MINUTES * 60 * 1000,
  );

  await db.insert(schema.emailChangeRequests).values({
    id,
    userId: args.userId,
    tokenHash: hash,
    newEmail: args.newEmail,
    expiresAt,
  });

  return {
    token: plain,
    expiresInMinutes: EMAIL_CHANGE_EXPIRES_MINUTES,
    newEmail: args.newEmail,
  };
}

/**
 * Phase 2: user clicks the verification link. Token from the URL
 * gets SHA-256 hashed, we look up the unused row, gate on expiry,
 * re-check that the target email is still free, then apply the
 * update.
 *
 * Returns the userId so the route can dispatch a USER_UPDATE
 * gateway event (other sessions see the new email immediately).
 */
export async function confirmEmailChange(plainToken: string): Promise<{
  userId: bigint;
  newEmail: string;
}> {
  if (!plainToken || plainToken.length < 8 || plainToken.length > 200) {
    throw errors.badRequest('Invalid verification token.');
  }
  const hash = createHash('sha256').update(plainToken).digest('hex');

  const [row] = await db
    .select()
    .from(schema.emailChangeRequests)
    .where(
      and(
        eq(schema.emailChangeRequests.tokenHash, hash),
        isNull(schema.emailChangeRequests.usedAt),
        gt(schema.emailChangeRequests.expiresAt, new Date()),
      ),
    )
    .limit(1);
  if (!row) {
    throw errors.badRequest('Verification link is invalid or expired.');
  }

  // Race re-check: someone else may have grabbed the target email
  // in the gap between request and confirm. We don't want to
  // collide on the users.email unique index — explicit check
  // produces a clearer error than letting the DB constraint fire.
  const [conflict] = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.email, row.newEmail),
        // Allow the SAME user (idempotent re-confirm in same
        // browser tab race) — only fail on a DIFFERENT user.
        sql`${schema.users.id} <> ${row.userId}`,
      ),
    )
    .limit(1);
  if (conflict) {
    throw errors.badRequest('That email was claimed by another account.');
  }

  // Consume the token and apply the change in ONE transaction. The consume is
  // a compare-and-swap (usedAt IS NULL) so two concurrent confirms of the same
  // token can't both apply it — the loser matches 0 rows and returns the
  // idempotent success without re-applying. A concurrent cross-user collision
  // on the target email (two users each pending a change to the same address,
  // confirming at once) surfaces as the clean 400 below instead of a raw
  // Postgres 23505 → 500.
  await db.transaction(async (tx) => {
    const consumed = await tx
      .update(schema.emailChangeRequests)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.emailChangeRequests.id, row.id),
          isNull(schema.emailChangeRequests.usedAt),
        ),
      )
      .returning({ id: schema.emailChangeRequests.id });
    // Loser of a double-click / retry: the winner already applied the
    // identical change. Nothing more to do.
    if (consumed.length === 0) return;

    try {
      await tx
        .update(schema.users)
        .set({ email: row.newEmail, updatedAt: new Date() })
        .where(eq(schema.users.id, row.userId));
    } catch (err) {
      if (isUniqueViolation(err)) {
        throw errors.badRequest('That email was claimed by another account.');
      }
      throw err;
    }
  });

  return { userId: row.userId, newEmail: row.newEmail };
}
