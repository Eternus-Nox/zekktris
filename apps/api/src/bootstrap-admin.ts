/**
 * Bootstrap-admin task
 * --------------------
 * Solves the chicken-and-egg problem on fresh self-host installs:
 * users.is_admin must be true to access /admin, but the only way
 * to flip it currently is either via SQL (`UPDATE users SET
 * is_admin=true WHERE id=...`) or via another admin via
 * POST /admin/users/:id/set-admin. So the first admin needs DB
 * access. That's a steep ergonomic cliff for non-technical
 * operators of a self-host product.
 *
 * The fix: an optional env var `BOOTSTRAP_ADMIN_EMAIL`. On every
 * startup we check two conditions:
 *
 *   1. The env var is set to a valid email.
 *   2. No user currently has is_admin=true (the "first admin"
 *      condition).
 *
 * Both true → look up the user by email; if they exist AND their
 * address is verified, set is_admin=true. Log the result so the
 * operator sees it in their boot logs.
 *
 * Verification matters: on a server with SMTP the account stays
 * unverified until the emailed link is clicked, but it still gets a
 * session — so without the check, anyone who registered (or, via
 * /change-unverified-email, moved an account to) the configured
 * address would become admin at the next restart. On a server WITHOUT
 * SMTP every signup is auto-verified, so this variable then means
 * "whoever registers this address first". That is why install.sh no
 * longer sets it and instead creates the admin account directly
 * (scripts/create-admin.ts → src/admin/createAdmin.ts).
 *
 * Idempotency. Once ANY admin exists (set by this task on a
 * previous boot, or set manually via SQL, or set by another
 * admin via the admin UI), this task is a no-op forever. The
 * env var can stay set in docker-compose.yml across restarts
 * without re-promoting on every boot or causing any surprise
 * privilege changes.
 *
 * Edge cases:
 *   - The user with the configured email doesn't exist yet (the
 *     operator hasn't registered). We log a hint and exit. The
 *     task will succeed on a subsequent boot after the user
 *     signs up.
 *   - The user exists but hasn't verified the address. Same: log a
 *     hint and exit. /verify-email promotes them once they do.
 *   - The configured email matches a banned user. We promote
 *     anyway — bannedAt is a soft-ban marker; an admin can
 *     unban themselves via SQL or another admin. We log this
 *     case explicitly so the operator notices.
 *   - The configured email is malformed. Caught at env-parse
 *     time via z.string().email(), so we never see it here.
 */

import { and, eq, isNull, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { env } from './env';
import { log } from './log';

export async function runBootstrapAdmin(): Promise<void> {
  if (!env.BOOTSTRAP_ADMIN_EMAIL) return;

  // Check if any admin exists. Count is enough — we don't need
  // the user details. A LIMIT 1 + select would also work; count
  // is conceptually clearer and the cost is identical for the
  // tiny rowcounts this query sees.
  const rows = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(and(eq(schema.users.isAdmin, true), isNull(schema.users.deletedAt)));
  const count = rows[0]?.count ?? 0;

  if (count > 0) {
    // Admin already exists — leave the env var as a no-op.
    return;
  }

  // No admin yet. Look up the target user. We DON'T match against
  // deleted users (they shouldn't be promotable) but DO match
  // banned users (the operator might have flagged themselves
  // accidentally and need admin access to unflag).
  //
  // Email is stored lowercased on signup but env values can come
  // in any case; lowercase the lookup for safety. Matches the
  // same normalization used in the auth/login path.
  const targetEmail = env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase();
  const [user] = await db
    .select({
      id: schema.users.id,
      email: schema.users.email,
      username: schema.users.username,
      emailVerified: schema.users.emailVerified,
      bannedAt: schema.users.bannedAt,
    })
    .from(schema.users)
    .where(and(eq(schema.users.email, targetEmail), isNull(schema.users.deletedAt)))
    .limit(1);

  if (!user) {
    log.warn('bootstrap admin: no admin exists yet, but BOOTSTRAP_ADMIN_EMAIL user not found', {
      email: targetEmail,
      hint: 'Register the account with this email, then restart the server.',
    });
    return;
  }

  if (!user.emailVerified) {
    log.warn('bootstrap admin: BOOTSTRAP_ADMIN_EMAIL user has not verified the address yet', {
      email: targetEmail,
      hint: 'Open the verification link sent to this address (that promotes the account), or run scripts/create-admin.ts in the api container.',
    });
    return;
  }

  await db
    .update(schema.users)
    .set({ isAdmin: true, updatedAt: new Date() })
    .where(and(eq(schema.users.id, user.id), eq(schema.users.emailVerified, true)));

  log.info('bootstrap admin: promoted user to instance admin', {
    userId: user.id.toString(),
    username: user.username,
    email: user.email,
    banned: user.bannedAt !== null,
  });

  if (user.bannedAt !== null) {
    log.warn('bootstrap admin: the promoted user is currently banned', {
      userId: user.id.toString(),
      hint: 'The user must unban themselves (SQL or another admin) before they can log in.',
    });
  }
}

/**
 * Signup-time counterpart of the boot task: whoever registers with
 * BOOTSTRAP_ADMIN_EMAIL becomes admin straight away, instead of after the next
 * restart — so a fresh self-hosted server is "install, register, you're the
 * admin". Same first-admin-only rule: once any admin exists this does nothing.
 *
 * Called only once the address is VERIFIED — right at signup when the server
 * has no email set up (accounts are auto-verified then), otherwise from
 * /verify-email — so nobody gets admin by registering an address they don't
 * own on a server that can check. (Without email nothing CAN check, so on
 * such a server the first person to register the address wins — see the
 * header.) Never throws; returns whether it promoted.
 */
export async function promoteIfBootstrapAdmin(userId: bigint): Promise<boolean> {
  if (!env.BOOTSTRAP_ADMIN_EMAIL) return false;
  try {
    const [user] = await db
      .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
      .from(schema.users)
      .where(and(eq(schema.users.id, userId), isNull(schema.users.deletedAt)))
      .limit(1);
    if (!user?.emailVerified) return false;
    if (user.email.toLowerCase() !== env.BOOTSTRAP_ADMIN_EMAIL.toLowerCase()) return false;

    // Atomic first-admin check: the UPDATE only lands while no admin exists.
    const promoted = await db
      .update(schema.users)
      .set({ isAdmin: true, updatedAt: new Date() })
      .where(
        and(
          eq(schema.users.id, userId),
          sql`NOT EXISTS (SELECT 1 FROM users WHERE is_admin = true AND deleted_at IS NULL)`,
        ),
      )
      .returning({ id: schema.users.id });
    if (promoted.length > 0) {
      log.info('bootstrap admin: promoted the new account to instance admin at signup', {
        userId: userId.toString(),
      });
      return true;
    }
    return false;
  } catch (err) {
    log.error('bootstrap admin: signup promotion failed', { err });
    return false;
  }
}
