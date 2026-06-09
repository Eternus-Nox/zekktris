/**
 * Auth routes
 * -----------
 * POST /api/v1/auth/register   create account, auto-login
 * POST /api/v1/auth/login      sign in with email + password
 * POST /api/v1/auth/refresh    exchange refresh cookie for new access token
 * POST /api/v1/auth/logout     revoke current session, clear cookie
 */

import { Hono } from 'hono';
import { validate } from '../lib/validate';
import { z } from 'zod';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { log } from '../log';
import { nextSnowflake } from '../snowflake';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { signAccessToken } from '../auth/tokens';
import * as twoFactor from '../services/twoFactor';
import {
  createSession,
  findActiveSessionByRefreshToken,
  rotateSession,
  revokeSession,
  revokeAllUserSessions,
} from '../auth/sessions';
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
} from '../auth/cookies';
import { gateSignup } from '../auth/signup';
import { toSelfUser } from '../lib/dto';
import { getClientIp, getUserAgent } from '../lib/request';
import { requireAuth, requireUserId } from '../auth/middleware';
import { RateLimiter } from '../lib/rateLimit';
import {
  emailSchema,
  passwordSchema,
  usernameSchema,
  displayNameSchema,
} from '../lib/validation';
import { env } from '../env';

export const authRouter = new Hono();

// ── Rate limiters (in-memory, per-process) ─────────────────────────────────
//   - login per email: 10 attempts / 15 min
//   - login per IP:    50 attempts / 15 min
//   - register per IP:  5 attempts / 1 hour
const loginByEmail = new RateLimiter(10, 15 * 60_000);
const loginByIp = new RateLimiter(50, 15 * 60_000);
const registerByIp = new RateLimiter(5, 60 * 60_000);

// Email verification token lifetime.
const EMAIL_VERIFICATION_EXPIRY_MS = 24 * 60 * 60_000; // 24h

/**
 * Generate a single-use verification token, store its hash, and email
 * the verification link to the user. Mirrors the password-reset flow.
 * Caller is responsible for gating on isEmailConfigured().
 */
async function issueEmailVerification(userId: bigint, email: string): Promise<void> {
  const { randomBytes, createHash } = await import('node:crypto');
  const plaintext = randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const tokenHash = createHash('sha256').update(plaintext).digest('hex');
  await db.insert(schema.emailVerifications).values({
    id: nextSnowflake(),
    userId,
    tokenHash,
    expiresAt: new Date(Date.now() + EMAIL_VERIFICATION_EXPIRY_MS),
  });
  const verifyUrl = `${env.PUBLIC_URL}/verify-email?token=${encodeURIComponent(plaintext)}`;
  const { sendEmailVerification } = await import('../services/email');
  await sendEmailVerification({
    to: email,
    verifyUrl,
    expiresInMinutes: Math.floor(EMAIL_VERIFICATION_EXPIRY_MS / 60_000),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// POST /register
// ───────────────────────────────────────────────────────────────────────────

const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  /** Required when ALLOW_REGISTRATION === 'invite-only'. */
  code: z.string().trim().min(1).max(64).optional(),
});

authRouter.post('/register', validate('json', registerSchema), async (c) => {
  const body = c.req.valid('json');
  const ip = getClientIp(c);
  const ua = getUserAgent(c);

  if (ip) {
    const r = registerByIp.consume(ip);
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
  }

  // Apply registration policy *before* DB writes (avoids leaking timing info
  // about whether an email is already taken to anonymous attackers when
  // registration is closed/invite-only).
  await gateSignup({ email: body.email, code: body.code });

  // Insert; rely on DB unique constraints to detect duplicates atomically.
  const passwordHash = await hashPassword(body.password);
  const id = nextSnowflake();

  try {
    const [user] = await db
      .insert(schema.users)
      .values({
        id,
        email: body.email,
        username: body.username,
        displayName: body.displayName,
        passwordHash,
      })
      .returning();
    if (!user) throw errors.internal('User creation returned no row');

    // Email verification gate. When email is configured, the account
    // starts unverified and we send a verification link. When email
    // ISN'T configured there's no way to verify, so we mark verified
    // immediately — otherwise the account could never be used.
    const { isEmailConfigured } = await import('../services/email');
    let verifiedUser = user;
    if (isEmailConfigured()) {
      void issueEmailVerification(user.id, user.email).catch((err) =>
        log.warn('verification email failed', { err: String(err) }),
      );
    } else {
      const [u] = await db
        .update(schema.users)
        .set({ emailVerified: true })
        .where(eq(schema.users.id, user.id))
        .returning();
      if (u) verifiedUser = u;
    }

    const { session, refreshToken } = await createSession({
      userId: user.id,
      userAgent: ua,
      ipAddress: ip,
    });
    const accessToken = await signAccessToken({
      userId: user.id,
      sessionId: session.id,
    });

    setRefreshCookie(c, refreshToken);
    log.info('user registered', { userId: user.id.toString(), username: user.username });

    return c.json(
      {
        user: toSelfUser(verifiedUser),
        accessToken,
        expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
      },
      201,
    );
  } catch (err: unknown) {
    // Postgres unique violation = 23505. Different message for email vs username
    // makes the form UX nicer.
    if (isUniqueViolation(err)) {
      const detail = (err as { detail?: string }).detail ?? '';
      if (detail.includes('email')) throw errors.conflict('Email is already registered');
      if (detail.includes('username')) throw errors.conflict('Username is already taken');
      throw errors.conflict('Account already exists');
    }
    throw err;
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /login
// ───────────────────────────────────────────────────────────────────────────

const loginSchema = z.object({
  email: emailSchema,
  password: z.string().min(1).max(1024), // Don't apply min-length here — leak-free errors
  /** TOTP or recovery code for accounts with 2FA enabled. Optional
      on the first call — when omitted but 2FA is on, the response
      is a 401 with `requires2FA: true` and the client re-submits
      with the user-entered code. We deliberately keep this as one
      endpoint (rather than a separate /login/verify) to avoid
      stashing a half-authenticated "challenge token" anywhere;
      the password is re-sent over TLS each time. */
  code: z.string().min(1).max(32).optional(),
});

authRouter.post('/login', validate('json', loginSchema), async (c) => {
  const body = c.req.valid('json');
  const ip = getClientIp(c);
  const ua = getUserAgent(c);

  // Rate-limit before doing the work. Per-email blocks credential stuffing
  // even if attackers rotate IPs.
  if (ip) {
    const r = loginByIp.consume(ip);
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
  }
  {
    const r = loginByEmail.consume(body.email);
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
  }

  // Look up user. We always compute scrypt to keep timing similar between
  // "no such user" and "wrong password" — but for a real user we use the
  // stored hash; for an unknown email we use a precomputed dummy hash.
  const rows = await db
    .select()
    .from(schema.users)
    .where(and(eq(schema.users.email, body.email), isNull(schema.users.deletedAt)))
    .limit(1);
  const user = rows[0];

  const storedHash = user?.passwordHash ?? (await getDummyHash());
  const ok = await verifyPassword(body.password, storedHash);

  if (!user || !ok) {
    throw errors.invalidCredentials();
  }

  // Reject banned accounts at the credential layer. We deliberately
  // surface a distinct error code so the client can render a
  // specific message ("This account has been disabled by an admin")
  // rather than the generic "invalid credentials" — bans aren't a
  // password-guess concealment scenario, the admin who issued the
  // ban wants the user to know they're banned.
  if (user.bannedAt) {
    throw errors.forbidden('This account has been disabled');
  }

  // Two-factor check. If the account has 2FA enabled, the second
  // factor must succeed before we issue a session. We treat both
  // TOTP and recovery codes as valid codes (the service handles
  // the dispatch). Failure returns 401 just like a bad password —
  // we don't distinguish "wrong password" from "bad 2FA code" to
  // avoid leaking whether the password was right.
  if (user.totpEnabled) {
    if (!body.code) {
      // Password was correct — release the per-email counter so a
      // 2FA user mistyping or re-entering their password while the
      // authenticator app is open can't burn their 10/15min budget
      // and lock themselves out of their own account. Bad 2FA codes
      // on the follow-up call still consume slots (they reach this
      // branch's `else` below where loginByEmail has already been
      // consumed at the top of the handler), so this doesn't open
      // the 2FA verifier to free brute-force attempts.
      loginByEmail.reset(body.email);
      // Client needs to prompt the user. Use a 401 with a hint flag
      // so the existing error-handling path takes over.
      return c.json({ requires2FA: true }, 401);
    }
    const codeOk = await twoFactor.verifyForLogin({ userId: user.id, code: body.code });
    if (!codeOk) {
      throw errors.invalidCredentials();
    }
  }

  // Successful login — reset the per-email counter so a legitimate user
  // doesn't lock themselves out by mistyping a few times.
  loginByEmail.reset(body.email);

  const { session, refreshToken } = await createSession({
    userId: user.id,
    userAgent: ua,
    ipAddress: ip,
  });
  const accessToken = await signAccessToken({
    userId: user.id,
    sessionId: session.id,
  });

  setRefreshCookie(c, refreshToken);
  log.info('user login', { userId: user.id.toString() });

  return c.json({
    user: toSelfUser(user),
    accessToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
});

// Lazily-computed dummy hash so unknown-email logins still pay the scrypt
// cost — this is what makes login timing roughly equal whether the email
// exists or not. Computed once at module load so the first miss doesn't
// pay double.
let _dummyHashCache: string | null = null;
async function getDummyHash(): Promise<string> {
  if (_dummyHashCache) return _dummyHashCache;
  _dummyHashCache = await hashPassword(
    'this is not a real password and will never match',
  );
  return _dummyHashCache;
}
void getDummyHash();

// ───────────────────────────────────────────────────────────────────────────
// POST /refresh
// ───────────────────────────────────────────────────────────────────────────

authRouter.post('/refresh', async (c) => {
  const token = readRefreshCookie(c);
  if (!token) throw errors.unauthenticated('No refresh token');

  const session = await findActiveSessionByRefreshToken(token);
  if (!session) {
    // Possible scenarios: token unknown, session revoked, session expired.
    // All map to the same response — clear the bad cookie and 401.
    clearRefreshCookie(c);
    throw errors.unauthenticated('Refresh token is no longer valid');
  }

  // Banned/deleted check. The admin ban handler does two sequential
  // UPDATEs (users.bannedAt, then sessions.revokedAt); a refresh
  // landing in the microsecond window between them would find the
  // session still active and rotate it, issuing a fresh access
  // token to a now-banned user. Close the window with an explicit
  // check here. Same shape as the gateway IDENTIFY check —
  // refresh is low-frequency (~once per 14 min per active session)
  // so the extra lookup is negligible.
  const userRows = await db
    .select({
      bannedAt: schema.users.bannedAt,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, session.userId))
    .limit(1);
  if (!userRows[0] || userRows[0].bannedAt || userRows[0].deletedAt) {
    clearRefreshCookie(c);
    throw errors.unauthenticated('Refresh token is no longer valid');
  }

  // Rotate: issue a new opaque token, overwrite the stored hash.
  // Atomic on TWO axes: (a) `rotateSession` filters on revokedAt
  // IS NULL + expiresAt > now in its UPDATE WHERE, so a
  // concurrent logout or expiry between the find and the rotate
  // makes the update touch zero rows; (b) it also filters on the
  // expected current refresh-token hash, so two parallel /refresh
  // calls with the same source cookie value can't both succeed —
  // the second one's UPDATE matches 0 rows because the first
  // already swapped the hash. Both axes converge: 0 rows → null
  // here → 401 with cookie cleared.
  const rotated = await rotateSession(session.id, session.refreshTokenHash);
  if (!rotated) {
    clearRefreshCookie(c);
    throw errors.unauthenticated('Refresh token is no longer valid');
  }
  const accessToken = await signAccessToken({
    userId: session.userId,
    sessionId: session.id,
  });

  setRefreshCookie(c, rotated.refreshToken);

  return c.json({
    accessToken,
    expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /logout
// ───────────────────────────────────────────────────────────────────────────

authRouter.post('/logout', async (c) => {
  const token = readRefreshCookie(c);
  if (token) {
    const session = await findActiveSessionByRefreshToken(token);
    if (session) await revokeSession(session.id);
  }
  // Always clear the cookie — even if it was already invalid. The client's
  // expectation post-logout is "I have no session", not "the server says
  // my session was already gone".
  clearRefreshCookie(c);
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /disconnect-beacon
// ───────────────────────────────────────────────────────────────────────────
// Called via navigator.sendBeacon() when the user closes the tab/app.
// Marks the user offline immediately rather than waiting out the
// 40-second WebSocket heartbeat watchdog. Best-effort: missing
// cookie or wrong session simply returns 204 with no side-effect.
//
// We can't use the regular Bearer auth here because sendBeacon doesn't
// support custom headers in iOS Safari. Instead we authenticate via the
// httpOnly refresh-token cookie that's already present, look up the
// session → user, and mark them offline + broadcast presence to
// guild + DM audiences. This is the only auth-via-cookie endpoint
// other than /refresh.
//
// The beacon is "best-effort" — if it fails (network drop, timing)
// the heartbeat watchdog catches the disconnect within 40s anyway.
// We never reject or throw; sendBeacon silently discards 4xx/5xx
// so error responses would be invisible to the client regardless.

authRouter.post('/disconnect-beacon', async (c) => {
  try {
    const token = readRefreshCookie(c);
    if (!token) return c.body(null, 204);
    const session = await findActiveSessionByRefreshToken(token);
    if (!session) return c.body(null, 204);

    // Force-close every open gateway connection for this user. The
    // socket close handlers will naturally fire onUserFullyDisconnected
    // → users.status = 'offline' → presence broadcast.
    const { registry } = await import('../gateway/registry');
    const conns = registry.byUserId(session.userId);
    for (const c of conns) {
      try {
        c.close(1000, 'page hide beacon');
      } catch {
        // Already closed; the close-side cleanup will still run.
      }
    }

    // Defensive: if there were no open connections (e.g. the WS was
    // already torn down by iOS before the beacon fired), still mark
    // the user offline directly. The presence broadcast covers both
    // guilds AND DMs so partners and co-members see the dot recolor
    // immediately.
    if (conns.length === 0) {
      const { db, schema } = await import('../db');
      const { eq } = await import('drizzle-orm');
      await db
        .update(schema.users)
        .set({ status: 'offline' })
        .where(eq(schema.users.id, session.userId));
      const memberRows = await db
        .select({ guildId: schema.guildMembers.guildId })
        .from(schema.guildMembers)
        .where(eq(schema.guildMembers.userId, session.userId));
      const dmRows = await db
        .select({ channelId: schema.dmRecipients.channelId })
        .from(schema.dmRecipients)
        .where(eq(schema.dmRecipients.userId, session.userId));
      if (memberRows.length > 0 || dmRows.length > 0) {
        const { presenceUpdate } = await import('../gateway/dispatch');
        presenceUpdate({
          userId: session.userId,
          status: 'offline',
          guildIds: memberRows.map((r) => r.guildId),
          dmChannelIds: dmRows.map((r) => r.channelId),
        });
      }
    }
  } catch {
    // sendBeacon ignores response codes; we have to swallow errors
    // here so a transient DB hiccup doesn't surface as an unhandled
    // promise rejection in the API logs.
  }
  return c.body(null, 204);
});

// ───────────────────────────────────────────────────────────────────────────
// POST /forgot-password
// ───────────────────────────────────────────────────────────────────────────
//
// Initiates a password-reset flow. The response intentionally never
// indicates whether the email matched an account — both "we sent you
// a link" and "no account exists" return the same 200 with a generic
// "if an account exists with this email, you'll get a reset link"
// body. Leaking existence is a real account-enumeration vector for
// any product with a public signup form.
//
// Rate-limited two ways:
//   - per-IP: 3 requests / hour. Defangs spam-the-inbox attacks where
//     an attacker generates traffic to a victim's inbox via this
//     endpoint.
//   - per-email: 3 requests / hour. Same protection but scoped to a
//     single target — also prevents a buggy client retry loop from
//     hammering the SMTP relay.
//
// Token mechanics:
//   - Generate 32 cryptographically random bytes
//   - URL-safe base64 → that's the plaintext token mailed to the user
//   - SHA-256 hash → that's what we store in password_resets.token_hash
//   - Expires in 60 minutes
//   - Single-use (used_at marked on successful reset)

const forgotByIp = new RateLimiter(3, 60 * 60_000);
const forgotByEmail = new RateLimiter(3, 60 * 60_000);
const PASSWORD_RESET_EXPIRY_MS = 60 * 60_000;

const forgotPasswordSchema = z.object({ email: emailSchema });

authRouter.post(
  '/forgot-password',
  validate('json', forgotPasswordSchema),
  async (c) => {
    const { email } = c.req.valid('json');
    const ip = getClientIp(c) ?? 'unknown';

    // Generic "ok" response we return for every code path. Avoids
    // timing-side-channel hints by reaching this same expression
    // whether we sent the email or not.
    const genericOk = () =>
      c.json({
        ok: true,
        message:
          'If an account exists with this email, a password reset link has been sent.',
      });

    // Both rate limits: silently no-op on hit. The response stays
    // generic so an attacker can't probe for "is this email
    // already over the limit?" which would re-leak existence.
    if (!forgotByIp.consume(ip).ok) return genericOk();
    if (!forgotByEmail.consume(email).ok) return genericOk();

    const { isEmailConfigured, sendPasswordResetEmail } = await import('../services/email');
    if (!isEmailConfigured()) {
      // Operator hasn't configured SMTP. Surface this AS A 503
      // rather than the generic "ok" — leaking config absence is
      // far less sensitive than leaking which email addresses
      // are registered, and the user otherwise has no way to
      // figure out why they're not receiving emails.
      throw errors.serviceUnavailable(
        'Password reset is not available — this server has no email configured. Contact your server operator.',
      );
    }

    // Run the user-lookup and email-send asynchronously so the
    // response timing doesn't reveal whether the email matched.
    //
    // Without this, "user exists" returns in ~100ms-1s+ (DB insert
    // + SMTP roundtrip) while "doesn't exist" returns in ~1ms, and
    // an attacker timing responses can enumerate accounts. The
    // login flow solves the analogous problem by always computing
    // scrypt regardless of user existence; here we can't easily do
    // constant-time work, so we defer the side-effects entirely
    // and return generic ok immediately.
    //
    // The unawaited promise is the point — do NOT await this.
    // Errors are caught + logged inside the IIFE so a rejection
    // doesn't surface as an unhandled promise warning.
    void (async () => {
      try {
        const [user] = await db
          .select({
            id: schema.users.id,
            email: schema.users.email,
            bannedAt: schema.users.bannedAt,
          })
          .from(schema.users)
          .where(and(eq(schema.users.email, email), isNull(schema.users.deletedAt)))
          .limit(1);

        if (!user || user.bannedAt) {
          // No account, or banned. Nothing to do — but we still
          // reached this point asynchronously, so the response
          // already went out at constant time.
          return;
        }

        // Generate token. randomBytes is the cryptographically-
        // secure source; URL-safe base64 keeps the token usable
        // as a query string parameter without further encoding.
        const { randomBytes, createHash } = await import('node:crypto');
        const plaintext = randomBytes(32)
          .toString('base64')
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '');
        const tokenHash = createHash('sha256').update(plaintext).digest('hex');

        const expiresAt = new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS);
        await db.insert(schema.passwordResets).values({
          id: nextSnowflake(),
          userId: user.id,
          tokenHash,
          expiresAt,
        });

        // Reset URL points at the web app's /reset-password route.
        // The token goes in the query string; the page reads it
        // client-side and submits it to /auth/reset-password.
        const resetUrl = `${env.PUBLIC_URL}/reset-password?token=${encodeURIComponent(plaintext)}`;
        await sendPasswordResetEmail({
          to: user.email,
          resetUrl,
          expiresInMinutes: Math.floor(PASSWORD_RESET_EXPIRY_MS / 60_000),
        });
      } catch (err) {
        // SMTP / DB failures: log internally. The user already got
        // the generic ok, so we can't surface anything. If email
        // delivery is broken the operator sees it in the logs;
        // affected users just don't receive the link and can
        // retry after the rate-limit window expires.
        log.error('password reset background task failed', { err });
      }
    })();

    return genericOk();
  },
);

// ───────────────────────────────────────────────────────────────────────────
// POST /reset-password
// ───────────────────────────────────────────────────────────────────────────
//
// Completes a password-reset flow. Body: { token, newPassword }.
//
// On success: the password hash is rotated, the token is marked used
// (single-use enforcement), and ALL existing sessions for the user
// are revoked. The session revocation is a safety measure — if an
// attacker initiated the reset flow (e.g. through stolen email
// access), they lose any concurrent sessions the legit user is
// trying to reset away from.
//
// Failure modes (all 400):
//   - Token not found
//   - Token already used
//   - Token expired

// Reset-password rate limit. Brute-force isn't a realistic concern
// (256 bits of entropy in the token), but flooding the endpoint
// would still pay one scrypt per request (~100ms each) and could
// be used as a DoS. 50/hr per IP — generous for legit users who
// will only ever hit this once successfully, restrictive enough
// to defang flood attacks.
const resetByIp = new RateLimiter(50, 60 * 60_000);

const resetPasswordSchema = z.object({
  token: z.string().min(1).max(200),
  newPassword: passwordSchema,
});

authRouter.post(
  '/reset-password',
  validate('json', resetPasswordSchema),
  async (c) => {
    const ip = getClientIp(c) ?? 'unknown';
    {
      const r = resetByIp.consume(ip);
      if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
    }

    const { token, newPassword } = c.req.valid('json');

    // Hash the submitted token. Comparing hashes (rather than
    // plaintext) means a DB read can't recover any working reset
    // codes; an attacker with read access to password_resets has
    // rows of useless hashes.
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // Single generic error for all token-failure cases. We don't
    // distinguish between "not found", "already used", and
    // "expired" to keep the failure surface uniform — telling the
    // user "this token was already used" implies the existence
    // of a real token that someone successfully used, which is
    // information we don't want leaked.
    const tokenError = () =>
      errors.badRequest('Reset link is invalid or has expired. Please request a new one.');

    // Atomically claim the token. The previous implementation did
    // a SELECT (check used_at IS NULL + expiry) then a later
    // UPDATE — two concurrent callers holding the same token (an
    // attacker plus a user from a phished email link) could BOTH
    // pass the check, BOTH compute scrypt, BOTH write the
    // password; whichever UPDATE landed last would silently win,
    // potentially overriding the user's choice with the
    // attacker's. The atomic UPDATE ... WHERE used_at IS NULL
    // RETURNING ensures exactly one caller wins; the other gets
    // 0 rows back and fails with tokenError.
    //
    // We claim BEFORE running scrypt on the new password so a
    // concurrent loser doesn't waste 100ms of CPU before
    // discovering they lost.
    const claimed = await db
      .update(schema.passwordResets)
      .set({ usedAt: new Date() })
      .where(
        and(
          eq(schema.passwordResets.tokenHash, tokenHash),
          isNull(schema.passwordResets.usedAt),
        ),
      )
      .returning({
        id: schema.passwordResets.id,
        userId: schema.passwordResets.userId,
        expiresAt: schema.passwordResets.expiresAt,
      });

    if (claimed.length === 0) {
      // Token not found, or already claimed by a concurrent
      // request, or by a previous use. All three are equivalent
      // from the caller's perspective.
      throw tokenError();
    }
    const row = claimed[0]!;
    if (row.expiresAt.getTime() < Date.now()) {
      // Expired. We claimed the row (marked used_at) on the way
      // through; that's fine — an expired token can't be replayed
      // even before this fix, and burning it now keeps the state
      // tidy.
      throw tokenError();
    }

    // Apply the new password. We rehash via the same path the
    // /register and /users/@me/password endpoints use so the
    // resulting hash is indistinguishable from a normal account.
    const newHash = await hashPassword(newPassword);
    await db
      .update(schema.users)
      .set({ passwordHash: newHash, updatedAt: new Date() })
      .where(eq(schema.users.id, row.userId));

    // Revoke ALL existing sessions (no exception — a reset proves email
    // control, not session control, and is often done precisely because an
    // attacker has access, so we log out everywhere). revokeAllUserSessions
    // also adds each revoked session to the blacklist, so their still-valid
    // access tokens are rejected on REST immediately — not just up to the
    // ~15min token TTL. (The previous raw UPDATE here revoked the DB rows but
    // skipped the blacklist, leaving a stolen token usable on REST.)
    await revokeAllUserSessions(row.userId);

    // Close any live gateway WebSockets for this user. Session
    // revocation alone leaves them readable up to the access-token
    // TTL (~15min) — long enough for an attacker who initiated the
    // reset (e.g. via a phished email link) to keep using the
    // account from their open tab even after the legit user
    // believes they've "logged out everywhere". Forcibly closing
    // the sockets ensures the revocation takes effect immediately.
    //
    // Dynamic-imported so the auth router doesn't pull gateway/
    // registry into its top-level import graph.
    try {
      const { registry } = await import('../gateway/registry');
      const conns = registry.byUserId(row.userId);
      for (const conn of conns) {
        try {
          conn.close(4000, 'password reset');
        } catch {
          // Already closed — gateway cleanup will still fire.
        }
      }
    } catch (err) {
      // Connection close is best-effort; the access-token TTL is
      // still a finite-time cap on attacker reach even if this
      // path fails. Log and continue rather than failing the
      // reset itself.
      log.error('password reset: failed to close gateway connections', { err });
    }

    log.info('password reset completed', { userId: row.userId.toString() });

    return c.json({ ok: true });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// helpers
// ───────────────────────────────────────────────────────────────────────────

function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code: unknown }).code === '23505'
  );
}

// ── Confirm email change ────────────────────────────────────────────────
//
// Public endpoint (no auth header). The user clicks the link in the
// verification email, the web client POSTs the token here. Service
// handles hash + expiry + race re-check + atomic apply. We then
// dispatch USER_UPDATE so live sessions pick up the new email
// without a refresh.
//
// Why public: the user might confirm from a device they aren't
// currently logged into on (different phone, work computer, etc).
// The token itself is the credential — knowledge of an unexpired,
// unused token is sufficient proof that the user controls the new
// email address.

const confirmEmailChangeSchema = z.object({
  token: z.string().min(8).max(200),
});

authRouter.post(
  '/confirm-email-change',
  validate('json', confirmEmailChangeSchema),
  async (c) => {
    const { token } = c.req.valid('json');
    const accountSvc = await import('../services/accountChanges');
    const result = await accountSvc.confirmEmailChange(token);

    // Fan out USER_UPDATE for sessions that have this user open.
    // The email isn't typically displayed inline (privacy), but
    // settings views read it and we don't want them to lag.
    const [updated] = await db
      .select()
      .from(schema.users)
      .where(eq(schema.users.id, result.userId))
      .limit(1);
    if (updated) {
      const { userUpdate } = await import('../gateway/dispatch');
      const memberRows = await db
        .select({ guildId: schema.guildMembers.guildId })
        .from(schema.guildMembers)
        .where(eq(schema.guildMembers.userId, result.userId));
      userUpdate({
        userId: result.userId,
        user: {
          id: updated.id.toString(),
          username: updated.username,
          displayName: updated.displayName,
          avatarUrl: updated.avatarUrl,
          bio: updated.bio,
          customStatus: updated.customStatus,
          status:
            updated.status === 'invisible'
              ? 'offline'
              : (updated.status as 'online' | 'idle' | 'dnd' | 'offline'),
        },
        guildIds: memberRows.map((r) => r.guildId),
        userIds: [],
      });
    }

    return c.json({ ok: true, newEmail: result.newEmail });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Email verification gate
// ───────────────────────────────────────────────────────────────────────────

// Whether the deployment enforces email verification. The web client
// reads this at bootstrap: when false (no SMTP configured) it never
// shows the verify-email gate, so a misconfigured server can't lock
// everyone out.
authRouter.get('/email-verification-required', async (c) => {
  const { isEmailConfigured } = await import('../services/email');
  return c.json({ required: isEmailConfigured() });
});

// Consume a verification token and mark the account verified. Public
// (the link is clicked from an email, possibly logged-out).
authRouter.post(
  '/verify-email',
  validate('json', z.object({ token: z.string().min(1).max(512) })),
  async (c) => {
    const { token } = c.req.valid('json');
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    const [row] = await db
      .select({
        id: schema.emailVerifications.id,
        userId: schema.emailVerifications.userId,
        expiresAt: schema.emailVerifications.expiresAt,
      })
      .from(schema.emailVerifications)
      .where(
        and(
          eq(schema.emailVerifications.tokenHash, tokenHash),
          isNull(schema.emailVerifications.usedAt),
        ),
      )
      .limit(1);
    if (!row || row.expiresAt.getTime() < Date.now()) {
      throw errors.badRequest('This verification link is invalid or has expired');
    }

    await db
      .update(schema.emailVerifications)
      .set({ usedAt: new Date() })
      .where(eq(schema.emailVerifications.id, row.id));
    await db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, row.userId));

    return c.json({ ok: true });
  },
);

// Resend the verification email to the logged-in user's address.
const resendByUser = new RateLimiter(3, 10 * 60_000);
authRouter.post('/resend-verification', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const r = resendByUser.consume(userId.toString());
  if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));

  const { isEmailConfigured } = await import('../services/email');
  if (!isEmailConfigured()) return c.json({ ok: true }); // nothing to do

  const [user] = await db
    .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (user && !user.emailVerified) {
    try {
      await issueEmailVerification(userId, user.email);
    } catch (err) {
      log.warn('resend verification failed', { err: String(err) });
      throw errors.internal('Could not send the verification email');
    }
  }
  return c.json({ ok: true });
});
