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
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { db, schema, isUniqueViolation } from '../db';
import { isCurrentlyBanned } from '../services/instanceBans';
import { errors } from '../errors';
import { log } from '../log';
import { nextSnowflake } from '../snowflake';
import { hashPassword, verifyPassword } from '../auth/passwords';
import { assertStepUpPassword } from '../auth/stepUp';
import { signAccessToken } from '../auth/tokens';
import * as twoFactor from '../services/twoFactor';
import {
  createSession,
  findActiveSessionByRefreshToken,
  rotateSession,
  revokeSession,
  revokeAllUserSessions,
  detectRefreshTokenReuse,
  recoverRotatedRefreshToken,
} from '../auth/sessions';
import { noteRecoveredRotation } from '../auth/refresh-replay';
import { logEvent } from '../services/security';
import {
  setRefreshCookie,
  clearRefreshCookie,
  readRefreshCookie,
} from '../auth/cookies';
import { gateSignup, refundSignupCode } from '../auth/signup';
import { toSelfUser } from '../lib/dto';
import { getClientIp, getUserAgent } from '../lib/request';
import { requireAuth, requireUserId, requireHumanSession } from '../auth/middleware';
import { snowflakeSchema } from '../lib/validation';
import {
  rpID,
  rpName,
  expectedOrigin,
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '../lib/webauthn';
import { challengeStore, newChallengeId } from '../auth/webauthn-challenges';
import { quickLoginStore } from '../auth/quick-login-store';
import {
  deviceLoginStore,
  normalizeUserCode,
  formatUserCode,
  guessPlatform,
  sanitizeDeviceName,
  parseLocale,
  sameNetwork,
} from '../auth/device-login-store';
import { RateLimiter } from '../lib/rateLimit';
import {
  emailSchema,
  passwordSchema,
  usernameSchema,
  displayNameSchema,
} from '../lib/validation';
import { ageOnDate, MIN_SIGNUP_AGE } from '../lib/age';
import { env } from '../env';

export const authRouter = new Hono();

// ── Rate limiters (in-memory, per-process) ─────────────────────────────────
//   - login per email: 10 attempts / 15 min
//   - login per IP:    50 attempts / 15 min
//   - register per IP:  5 attempts / 1 hour
const loginByEmail = new RateLimiter(10, 15 * 60_000, 'login-email');
const loginByIp = new RateLimiter(50, 15 * 60_000, 'login-ip');
const registerByIp = new RateLimiter(5, 60 * 60_000, 'register-ip');
// Second-factor guesses get their own per-USER budget. The per-email limiter
// alone can't be the 2FA throttle: the legitimate no-code → code two-step
// would double-charge it, and any path that refunds it for UX reopens
// distributed brute-force of the 6-digit space.
const twoFactorByUser = new RateLimiter(5, 15 * 60_000, 'login-2fa-user');
// Confirm-email-change consumes a token — throttle per IP like verify-email so
// the token space can't be brute-forced (every other token-consume endpoint has
// a limiter; this one was missing).
const confirmEmailChangeByIp = new RateLimiter(50, 60 * 60_000, 'confirm-email-change-ip');
// Quick-login (log in on another device): generating is per-USER (guards
// re-randomize spam); redeeming is per-IP (brute-force guard on the 16-digit
// code, on top of single-use + 90s TTL).
// DEPRECATED — see the /quick-login/* block below. Delete with those routes.
const quickLoginCreateByUser = new RateLimiter(15, 60_000, 'quicklogin-create');
const quickLoginRedeemByIp = new RateLimiter(15, 15 * 60_000, 'quicklogin-redeem-ip');
// Device-approval login (the inverted flow — the LOGGED-OUT device asks, the
// logged-in phone approves). Four different things need throttling here:
//   start   per IP   — cheap to call and allocates store entries; a flood guard.
//   poll    per IP    — also a flood guard, NOT a brute-force guard: the
//                       deviceCode is 256 bits, so guessing is not the threat;
//                       resource abuse is. Generous enough for a large NAT
//                       (a single attempt polls ~60 times over its 5-min life).
//   lookup  per USER — THIS is the userCode brute-force guard. The userCode is
//                      only ~40 bits, and lookup is the only oracle that says
//                      whether one exists. 20/min per authenticated user means
//                      an attacker needs ~1e11 accounts-minutes per hit.
//   decide  per USER — approve+deny share a budget; same reasoning as lookup.
const deviceLoginStartByIp = new RateLimiter(10, 15 * 60_000, 'devicelogin-start-ip');
const deviceLoginPollByIp = new RateLimiter(600, 15 * 60_000, 'devicelogin-poll-ip');
const deviceLoginLookupByUser = new RateLimiter(20, 60_000, 'devicelogin-lookup-user');
const deviceLoginDecideByUser = new RateLimiter(20, 60_000, 'devicelogin-decide-user');

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

// Age helpers (MIN_SIGNUP_AGE under-13 reject; ageOnDate) live in lib/age.ts
// so the minor-supervision lifecycle reuses the exact same age math.

// YYYY-MM-DD, a real calendar date, not in the future, sane lower bound, and
// at least MIN_SIGNUP_AGE years old. The age check lives in the schema so it
// surfaces as a normal 400 with a clear message the client can show.
const dateOfBirthSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter your date of birth.')
  .refine((s) => {
    const d = new Date(`${s}T00:00:00Z`);
    // Round-trip guards against non-calendar dates (e.g. 2011-02-30 → Mar 2).
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
  }, 'Enter a valid date of birth.')
  .refine((s) => {
    const year = Number(s.slice(0, 4));
    return year >= 1900;
  }, 'Enter a valid date of birth.')
  .refine((s) => ageOnDate(s, new Date()) >= MIN_SIGNUP_AGE, {
    message: `You must be at least ${MIN_SIGNUP_AGE} years old to use Zekktris.`,
  });

const registerSchema = z.object({
  email: emailSchema,
  username: usernameSchema,
  displayName: displayNameSchema,
  password: passwordSchema,
  dateOfBirth: dateOfBirthSchema,
  /** Required when ALLOW_REGISTRATION === 'invite-only'. */
  code: z.string().trim().min(1).max(64).optional(),
});

authRouter.post('/register', validate('json', registerSchema), async (c) => {
  const body = c.req.valid('json');
  const ip = getClientIp(c);
  const ua = getUserAgent(c);

  if (ip) {
    const r = await registerByIp.consume(ip);
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
  }

  // Apply registration policy *before* DB writes (avoids leaking timing info
  // about whether an email is already taken to anonymous attackers when
  // registration is closed/invite-only).
  await gateSignup({ email: body.email, code: body.code });

  // Identity fields must not contain vulgar words (blocked OR watch) — a
  // username / display name is visible next to everything the user does.
  {
    const { containsListedWord } = await import('../services/security');
    if (await containsListedWord(body.username)) {
      throw errors.badRequest('That username contains a word that isn’t allowed.');
    }
    if (await containsListedWord(body.displayName)) {
      throw errors.badRequest('That display name contains a word that isn’t allowed.');
    }
  }

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
        dateOfBirth: body.dateOfBirth,
        // Locked at signup — declared their age here; only an admin can reset
        // it. (Prevents a minor signing up honestly then flipping to 18.)
        dobLocked: true,
        // Seed the achievement ledger as initialized: a brand-new account has
        // nothing earned yet, so every achievement it earns from here on is a
        // real, notifiable unlock (no silent backfill needed).
        achievementsSeeded: true,
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
      // Fire-and-forget so signup isn't blocked on SMTP, but log at ERROR (not
      // warn): a failure here leaves a freshly-created account unverified with
      // no email — ops needs to see it. The user can recover via
      // /resend-verification.
      void issueEmailVerification(user.id, user.email).catch((err) =>
        log.error('signup verification email failed — account created but unverified', {
          userId: user.id.toString(),
          err: String(err),
        }),
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
    // Registration failed after gateSignup consumed an invite-code use —
    // refund it so a failed attempt (duplicate email/username) doesn't
    // permanently burn a redemption. Best-effort; see refundSignupCode.
    if (env.ALLOW_REGISTRATION === 'invite-only' && body.code) {
      await refundSignupCode(body.code).catch(() => undefined);
    }
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
    const r = await loginByIp.consume(ip);
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
  }
  {
    const r = await loginByEmail.consume(body.email);
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
  if (isCurrentlyBanned(user)) {
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
      // Do NOT refund the per-email counter here, even though the password
      // was correct: a refund on this branch lets an attacker who knows the
      // password interleave no-code requests between wrong-code guesses and
      // keep the counter pinned at zero — unlimited distributed TOTP
      // brute-force. A legitimate 2FA login costs 2 of the 10 slots
      // (password step + code step), which leaves several full retries
      // before any lockout, and a successful login resets the counter.
      //
      // Client needs to prompt the user. Use a 401 with a hint flag
      // so the existing error-handling path takes over.
      return c.json({ requires2FA: true }, 401);
    }
    // Per-user budget for second-factor guesses, independent of email/IP.
    {
      const r = await twoFactorByUser.consume(user.id.toString());
      if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
    }
    const codeOk = await twoFactor.verifyForLogin({ userId: user.id, code: body.code });
    if (!codeOk) {
      throw errors.invalidCredentials();
    }
    await twoFactorByUser.reset(user.id.toString());
  }

  // Successful login — reset the per-email counter so a legitimate user
  // doesn't lock themselves out by mistyping a few times.
  await loginByEmail.reset(body.email);

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

// ───────────────────────────────────────────────────────────────────────────
// Quick login — log in on another device via QR / 16-digit code
//
//   *** DEPRECATED — superseded by /auth/device-login/* below. ***
//
// This is the WEAKER direction: the code that gets DISPLAYED is also the code
// that REDEEMS a session, so "the code is the whole credential" (see the
// header of auth/quick-login-store.ts). Anyone who reads it off the screen, or
// photographs the QR, can take the account — no approval step stands in the
// way. The device-login flow below splits that into a public userCode and a
// secret deviceCode and requires an explicit approval, which is why it
// replaces this.
//
// KEPT WORKING ON PURPOSE: shipped iOS and Android builds call these three
// routes and would hard-break on removal. Do not delete them in the same pass
// that adds device-login.
//
// DELETE THIS ENTIRE BLOCK when every client in the wild has shipped
// device-login. Specifically remove, all together:
//   1. the three routes below (/quick-login/create, /cancel, /redeem)
//   2. `quickLoginCreateByUser` + `quickLoginRedeemByIp` (limiters, above)
//   3. the `quickLoginStore` import here, and the whole file
//      apps/api/src/auth/quick-login-store.ts
//   4. in packages/client/src/rest.ts: generateQuickLoginCode,
//      cancelQuickLoginCode, redeemQuickLoginCode, and the
//      '/auth/quick-login/redeem' entry in the 401-auto-refresh exemption list
//   5. the `QuickLoginCode` interface in packages/client/src/types.ts
//   6. the client call sites: iOS Session.swift / APIClient.swift /
//      AuthViews.swift / Models.swift, Android AppStore.kt /
//      SecurityScreens.kt / data/ApiClient.kt / data/model/Models.kt
// Nothing else references them.
// ───────────────────────────────────────────────────────────────────────────
// A LOGGED-IN device mints a short-lived, single-use 16-digit code (shown as
// digits + a QR that encodes a /login/device URL carrying the code). A
// LOGGED-OUT device redeems it to receive a brand-new session. Minting a code
// NEVER touches the generator's own session/cookie — it only writes to the
// ephemeral store. Codes die after 90s, on redemption (single-use), or when the
// generator leaves the section (cancel). This is an equivalent-to-password
// entry point (like passkey login) and deliberately bypasses TOTP: the
// generating device already proved possession + authentication.

// POST /auth/quick-login/create — [authed] mint (or re-randomize) a code.
// @deprecated use POST /auth/device-login/start + /approve.
authRouter.post('/quick-login/create', requireAuth, requireHumanSession, async (c) => {
  const userId = requireUserId(c);
  const rl = await quickLoginCreateByUser.consume(userId.toString());
  if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
  const { code, expiresIn } = await quickLoginStore.create(userId.toString());
  // Never log the code — it's a bearer login credential.
  return c.json({ code, expiresIn });
});

// POST /auth/quick-login/cancel — [authed] invalidate the caller's active code
// (what "leaving the quick-login section" maps to server-side).
// @deprecated use POST /auth/device-login/deny.
authRouter.post('/quick-login/cancel', requireAuth, requireHumanSession, async (c) => {
  const userId = requireUserId(c);
  await quickLoginStore.cancel(userId.toString());
  return c.json({ ok: true });
});

// POST /auth/quick-login/redeem — [PUBLIC] a logged-out device exchanges a code
// for a new session. Single-use (atomic delete), rate-limited per IP.
// @deprecated use POST /auth/device-login/poll.
authRouter.post(
  '/quick-login/redeem',
  validate('json', z.object({ code: z.string().trim().min(1).max(64) })),
  async (c) => {
    const ip = getClientIp(c);
    if (ip) {
      const rl = await quickLoginRedeemByIp.consume(ip);
      if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    }
    // Manual entry may include spaces; the QR delivers bare digits. Strip
    // whitespace only (don't strip other chars — that could corrupt the code).
    const code = c.req.valid('json').code.replace(/\s+/g, '');
    const userIdStr = code ? await quickLoginStore.consume(code) : null;
    if (!userIdStr) throw errors.badRequest('That code is invalid or has expired.');

    const [user] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, BigInt(userIdStr)), isNull(schema.users.deletedAt)))
      .limit(1);
    if (!user) throw errors.badRequest('That code is invalid or has expired.');
    // Re-check ban AFTER loading the user so a just-banned account can't be
    // handed a fresh session (mirrors /login).
    if (isCurrentlyBanned(user)) {
      throw errors.forbidden('This account has been disabled');
    }

    const { session, refreshToken } = await createSession({
      userId: user.id,
      userAgent: getUserAgent(c),
      ipAddress: getClientIp(c),
    });
    const accessToken = await signAccessToken({ userId: user.id, sessionId: session.id });
    setRefreshCookie(c, refreshToken);
    log.info('quick-login redeemed', { userId: user.id.toString() });
    return c.json({
      user: toSelfUser(user),
      accessToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Device-approval login — the LOGGED-OUT device asks, the logged-in phone says yes
// ───────────────────────────────────────────────────────────────────────────
// The inverse of quick-login above, and the flow that replaces it. Shape:
//
//   1. new device  → POST /device-login/start   [PUBLIC]
//                    gets { userCode, deviceCode, expiresIn, interval }.
//                    It DISPLAYS userCode (and a QR encoding it) and KEEPS
//                    deviceCode in memory, never on screen.
//   2. new device  → POST /device-login/poll    [PUBLIC]  every `interval`s,
//                    presenting deviceCode.
//   3. phone       → POST /device-login/lookup  [AUTHED]  with the scanned or
//                    typed userCode → the requesting device's metadata, which
//                    it renders on the approval screen.
//   4. phone       → POST /device-login/approve [AUTHED] or /deny [AUTHED]
//   5. new device's next poll returns the session.
//
// WHY TWO CODES, and WHY THE APPROVAL SCREEN IS A SECURITY CONTROL (the
// phishing attack): see the header of auth/device-login-store.ts. Read it
// before changing anything here.
//
// Like quick-login and passkey login, an approval is an equivalent-to-password
// entry point and deliberately bypasses TOTP: the approving device already
// proved possession + authentication, and the approval is an explicit human
// act on that device.

// POST /auth/device-login/start — [PUBLIC] a logged-out device opens a request.
// Body is REQUIRED (send `{}` if you have no device name) — the JSON validator
// rejects an absent body. Returns the two codes; the deviceCode appears here
// and nowhere else, ever.
authRouter.post(
  '/device-login/start',
  validate(
    'json',
    z.object({
      /** Optional self-declared label, e.g. "Pixel 9". UNTRUSTED — it is
          sanitized and returned to the approver clearly marked as claimed by
          the device, never as a verified fact. */
      deviceName: z.string().max(64).optional(),
    }),
  ),
  async (c) => {
    const ip = getClientIp(c);
    if (ip) {
      const rl = await deviceLoginStartByIp.consume(ip);
      if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    }
    const userAgent = getUserAgent(c);
    const started = await deviceLoginStore.start({
      declaredName: sanitizeDeviceName(c.req.valid('json').deviceName),
      userAgent,
      platform: guessPlatform(userAgent),
      ipAddress: ip,
      locale: parseLocale(c.req.header('accept-language')),
    });
    // Never log either code.
    return c.json({
      userCode: formatUserCode(started.userCode),
      deviceCode: started.deviceCode,
      expiresIn: started.expiresIn,
      interval: started.interval,
    });
  },
);

// POST /auth/device-login/poll — [PUBLIC] the new device asks for its outcome.
// Always 200 on a well-formed call: pending / slow_down / approved / denied /
// expired are normal states of a polling loop, not errors. An unknown,
// malformed or already-consumed deviceCode all answer `expired` — one uniform
// response, so this is never an oracle.
authRouter.post(
  '/device-login/poll',
  validate('json', z.object({ deviceCode: z.string().trim().min(16).max(256) })),
  async (c) => {
    const ip = getClientIp(c);
    if (ip) {
      const rl = await deviceLoginPollByIp.consume(ip);
      if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    }
    const result = await deviceLoginStore.poll(c.req.valid('json').deviceCode);
    if (result.status !== 'approved') {
      return c.json(result);
    }

    const [user] = await db
      .select()
      .from(schema.users)
      .where(and(eq(schema.users.id, BigInt(result.userId)), isNull(schema.users.deletedAt)))
      .limit(1);
    // The grant was already consumed (single-use) — if the user vanished
    // between approval and collection there is nothing to re-try, so this is
    // terminal, not `pending`.
    if (!user) throw errors.badRequest('That request is no longer valid.');
    // Re-check the ban HERE, not at approve time: this is the moment a session
    // is actually minted, so it must see the freshest state (mirrors /login and
    // quick-login/redeem).
    if (isCurrentlyBanned(user)) {
      throw errors.forbidden('This account has been disabled');
    }

    const { session, refreshToken } = await createSession({
      userId: user.id,
      userAgent: getUserAgent(c),
      ipAddress: getClientIp(c),
    });
    const accessToken = await signAccessToken({ userId: user.id, sessionId: session.id });
    setRefreshCookie(c, refreshToken);
    log.info('device-login approved session issued', { userId: user.id.toString() });
    return c.json({
      status: 'approved' as const,
      user: toSelfUser(user),
      accessToken,
      expiresIn: env.ACCESS_TOKEN_TTL_SECONDS,
    });
  },
);

/** Shared body for the three authed routes. Normalization (uppercase, strip
    the display dash, fold O→0 and I/L→1) happens in the store helper. */
const deviceLoginUserCodeSchema = z.object({
  userCode: z.string().trim().min(1).max(32),
});

// POST /auth/device-login/lookup — [AUTHED] what am I about to approve?
//
// requireAuth runs first, so an UNAUTHENTICATED caller gets 401 before this
// handler executes and therefore learns nothing about whether a code exists.
// requireHumanSession additionally rejects bot tokens (a bot must never be
// able to enumerate or approve device logins for its user — that is exactly
// the bot-token-laundering hole documented in auth/middleware.ts).
//
// THE RESPONSE IS THE ANTI-PHISHING UI CONTRACT. `ipAddress` and `sameNetwork`
// are server-observed and unforgeable by a remote attacker; `declaredName`,
// `userAgent`, `platform` and `locale` are all claims made by the requesting
// device. The approval screen MUST show them and MUST distinguish the two
// groups. See the store header before trimming this down.
authRouter.post(
  '/device-login/lookup',
  requireAuth,
  requireHumanSession,
  validate('json', deviceLoginUserCodeSchema),
  async (c) => {
    const userId = requireUserId(c);
    const rl = await deviceLoginLookupByUser.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    const userCode = normalizeUserCode(c.req.valid('json').userCode);
    const request = userCode ? await deviceLoginStore.findByUserCode(userCode) : null;
    if (!request) throw errors.notFound('Login request');
    return c.json({
      userCode: formatUserCode(request.userCode),
      expiresIn: Math.max(0, Math.ceil((request.expiresAt - Date.now()) / 1000)),
      device: {
        // ── claimed by the requesting device (UNTRUSTED) ──
        declaredName: request.declaredName,
        userAgent: request.userAgent,
        platform: request.platform,
        locale: request.locale,
        // ── observed by this server (TRUSTWORTHY) ──
        ipAddress: request.ipAddress,
        sameNetwork: sameNetwork(request.ipAddress, getClientIp(c)),
        requestedAt: new Date(request.createdAt).toISOString(),
        // Always null: a city/region needs a GeoIP dataset or a third-party
        // lookup, and this pass adds neither. The field exists so clients
        // don't need a shape change if one is shipped later. Do NOT fill it
        // with a guess.
        approxLocation: null,
      },
    });
  },
);

// POST /auth/device-login/approve — [AUTHED] bind the request to the caller and
// mark it approved. Terminal, atomic, first-caller-wins.
authRouter.post(
  '/device-login/approve',
  requireAuth,
  requireHumanSession,
  validate('json', deviceLoginUserCodeSchema),
  async (c) => {
    const userId = requireUserId(c);
    const rl = await deviceLoginDecideByUser.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    const userCode = normalizeUserCode(c.req.valid('json').userCode);
    const decision = userCode
      ? await deviceLoginStore.decide(userCode, userId.toString())
      : ({ result: 'gone' } as const);
    if (decision.result === 'gone') {
      throw errors.notFound('Login request');
    }
    if (decision.result === 'already') {
      throw errors.conflict('That request has already been answered.');
    }
    log.info('device-login approved', {
      userId: userId.toString(),
      platform: decision.request.platform,
    });
    return c.json({ ok: true });
  },
);

// POST /auth/device-login/deny — [AUTHED] terminal rejection. Uses the same
// atomic claim as approve, so a deny that races an approve is decided once and
// the polling device sees exactly one outcome.
authRouter.post(
  '/device-login/deny',
  requireAuth,
  requireHumanSession,
  validate('json', deviceLoginUserCodeSchema),
  async (c) => {
    const userId = requireUserId(c);
    const rl = await deviceLoginDecideByUser.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    const userCode = normalizeUserCode(c.req.valid('json').userCode);
    const decision = userCode
      ? await deviceLoginStore.decide(userCode, null)
      : ({ result: 'gone' } as const);
    if (decision.result === 'gone') {
      throw errors.notFound('Login request');
    }
    if (decision.result === 'already') {
      throw errors.conflict('That request has already been answered.');
    }
    return c.json({ ok: true });
  },
);

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

/**
 * True when this session's owner may no longer be handed tokens: banned, a
 * timed ban still running, deleted, or the row is simply gone.
 *
 * Shared by all three points in /refresh that must ask this — before the
 * rotate, after the rotate, and on the replay-recovery path — so they can't
 * drift apart. The admin ban handler does two sequential UPDATEs (users.bannedAt,
 * then sessions.revokedAt); a refresh landing between them would otherwise find
 * the session still active and mint a fresh ~15-min access token for a
 * now-banned user. Same shape as the gateway IDENTIFY check; refresh is
 * low-frequency (~once per 14 min per active session) so the lookup is
 * negligible.
 */
async function refreshSubjectBlocked(userId: bigint): Promise<boolean> {
  const rows = await db
    .select({
      bannedAt: schema.users.bannedAt,
      bannedUntil: schema.users.bannedUntil,
      deletedAt: schema.users.deletedAt,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const u = rows[0];
  return !u || isCurrentlyBanned(u) || u.deletedAt !== null;
}

/**
 * Shape of a token this server issues: base64url of 32 random bytes, so
 * unpadded, 43 characters. Used only to skip the reuse scan for values that
 * cannot possibly be ours (see the note on the scan below) — never to reject a
 * token, so a differently-shaped token from some past format still gets its
 * normal indexed lookup and behaves exactly as before.
 */
const REFRESH_TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;

/**
 * On rate-limiting this endpoint (deliberately NOT done):
 *
 * /refresh is unauthenticated in the middleware sense — anyone can POST a
 * cookie at it — and a miss runs the reuse scan, which is a sequential scan
 * (`previous_refresh_token_hash` is not indexed). That is worth protecting, but
 * a per-IP limiter is the wrong tool and would be actively dangerous here:
 * legitimate refresh volume behind one IP scales with the number of users
 * behind it (offices, schools, campus wi-fi, CGNAT mobile carriers), and every
 * client also retries on a short ladder, so any budget low enough to blunt an
 * attacker is low enough to strand a whole NAT behind a permanent 429 — i.e.
 * exactly the mass-logout this pass exists to stop. Limiting per refresh-cookie
 * value protects nothing, since an attacker just varies the cookie.
 *
 * The cheap, no-lockout mitigations instead: the shape guard above keeps
 * garbage cookies from ever reaching the scan (they cost one indexed lookup),
 * and the client ladder is jittered so tabs don't align. The real fix is an
 * index on `sessions.previous_refresh_token_hash` — a migration, so it is
 * flagged for the next schema pass rather than done here — plus an edge/WAF
 * limit sized well above the ladder if abuse is ever observed.
 */

authRouter.post('/refresh', async (c) => {
  const token = readRefreshCookie(c);
  if (!token) throw errors.unauthenticated('No refresh token');

  const session = await findActiveSessionByRefreshToken(token);
  if (!session) {
    // The token didn't match any active session's CURRENT hash. Before we
    // treat it as a benign expired/unknown token, check whether it's a
    // SUPERSEDED token being replayed (reuse detection). Skipped for values
    // that can't be one of ours: they'd match nothing, and the scan is the
    // expensive part of this endpoint.
    const reuse = REFRESH_TOKEN_SHAPE.test(token) ? await detectRefreshTokenReuse(token) : null;
    if (reuse?.kind === 'concurrent') {
      // Benign: a second tab lost the rotation race, or this is a retry of a
      // refresh whose response never arrived. The session is healthy, so bail
      // out BEFORE the clearRefreshCookie below — that was the bug. The cookie
      // sitting in this browser is very likely the WINNER's freshly-issued
      // token, and expiring it here deleted a perfectly valid credential; two
      // tabs refreshing at the same instant logged the user out of both.
      //
      // LOST-RESPONSE RECOVERY. Bailing out is not enough for the client that
      // never received the rotated token at all — its cookie jar still holds
      // the superseded one, so "retry with whatever token you now hold" is the
      // same dead token forever, and once the grace window closes the very same
      // replay is reclassified as theft and the session is revoked. So before
      // rejecting, try to hand back the token the lost response was carrying:
      // `rotateSession` retained it, sealed under a key derivable only from the
      // token being presented right now and bound to this client's User-Agent
      // (see auth/refresh-replay.ts), and `recoverRotatedRefreshToken` re-checks
      // that it is still the session's live token. If that succeeds the client
      // ends up exactly where the lost response would have put it — same token,
      // fresh access token, no re-login and no revocation. We do NOT rotate
      // again: re-keying here would kill the token a multi-tab winner already
      // holds.
      const recovered = await recoverRotatedRefreshToken(token, getUserAgent(c), reuse.sessionId);
      if (recovered) {
        // Same ban/deletion gate as the normal path — a recovery must not be a
        // side door around it.
        if (await refreshSubjectBlocked(recovered.session.userId)) {
          clearRefreshCookie(c);
          throw errors.unauthenticated('Refresh token is no longer valid');
        }
        const accessToken = await signAccessToken({
          userId: recovered.session.userId,
          sessionId: recovered.session.id,
        });
        setRefreshCookie(c, recovered.refreshToken);
        // Worth ops signal: a recovery means a rotation response was lost, and
        // a sudden rise in these is either an api/proxy problem or someone
        // replaying tokens. No token material is logged.
        log.warn('refresh replay recovered', {
          sessionId: recovered.session.id.toString(),
          userId: recovered.session.userId.toString(),
        });
        // …and the pattern the single log line cannot show. One recovery is a
        // lost response; the SAME session recovering rotation after rotation is
        // the fingerprint of the one attacker the per-rotation redemption cap
        // provably cannot stop — a cloned cookie with a matching User-Agent
        // riding the chain, one redemption per window, forever (see
        // MAX_REPLAY_RECOVERIES in auth/refresh-replay.ts). noteRecoveredRotation
        // counts distinct recovered ROTATIONS per session over hours and returns
        // non-null exactly once per window, at the threshold, so this can be at
        // most one row per session per window no matter how a client flaps.
        //
        // FAIL SOFT, deliberately, at THIS call site: not awaited and with a
        // terminal catch, so neither a counter-store outage nor a failing
        // `logEvent` insert (nor their latency) can touch the refresh — the
        // response below is already fully decided. noteRecoveredRotation itself
        // also never throws; the catch here covers logEvent and the .then.
        void noteRecoveredRotation({
          sessionId: recovered.session.id,
          supersededToken: token,
          userAgent: getUserAgent(c),
        })
          .then((esc) => {
            if (!esc) return;
            const hours = Math.round(esc.windowSeconds / 3600);
            return logEvent({
              kind: 'refresh_replay_repeated',
              // The session's OWNER — the party at risk, not an offender.
              userId: recovered.session.userId,
              guildId: null,
              channelId: null,
              // Everything an operator needs to act, and nothing that would
              // make this log a credential store: no token, no sealed blob, no
              // derived key, and a truncated UA digest rather than the header.
              detail:
                `Refresh-token replay recovery repeated for one session: ` +
                `${esc.count} separate rotations recovered within ${hours}h ` +
                `(session ${recovered.session.id.toString()}, UA hash ${esc.userAgentHash}). ` +
                `A lost rotation response is a one-off; repeating it across rotations is ` +
                `how a cloned refresh cookie with a matching User-Agent stays on the chain, ` +
                `and the per-rotation cap cannot see it. Either this client's network is ` +
                `badly broken or the session is being ridden — review it, and sign the ` +
                `session out to settle it.`,
            });
          })
          .catch(() => {});
        return c.json({ accessToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS });
      }
      // No recovery available — nothing retained, the grace expired, a
      // different client, the entry's redemption budget is spent
      // (MAX_REPLAY_RECOVERIES), or the store is down. Every one of those falls
      // back to the old answer and NEVER to a revocation: an exhausted budget
      // must not be able to end a session by itself, it just stops being a
      // shortcut past the normal reuse handling.
      // 409, not 401, so the client can
      // tell "you raced, ask again" from "your session is over" and retry with
      // whatever token it now holds instead of wiping its credentials and
      // dropping to the login screen.
      throw errors.conflict('A refresh for this session is already in flight; retry');
    }
    if (reuse) {
      // Reuse outside the concurrency grace: the token leaked and someone is
      // racing the legitimate holder — revoke that session family so the stolen
      // token (and whatever the thief already rotated it into) stops working.
      await revokeSession(reuse.sessionId).catch(() => undefined);
    }
    // Possible scenarios: token unknown, session revoked, session expired, or
    // detected reuse (now revoked). All map to the same response — clear the
    // bad cookie and 401.
    clearRefreshCookie(c);
    throw errors.unauthenticated('Refresh token is no longer valid');
  }

  // Banned/deleted check before we rotate — see refreshSubjectBlocked.
  if (await refreshSubjectBlocked(session.userId)) {
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
  //
  // The third argument is what makes a LOST RESPONSE recoverable: it lets the
  // rotation retain the token it is about to issue, sealed to the presenter of
  // this cookie and to this User-Agent, so if the reply below never reaches the
  // client its retry can be answered with the same token instead of a dead end
  // (see the `concurrent` branch above and auth/refresh-replay.ts).
  const rotated = await rotateSession(session.id, session.refreshTokenHash, {
    supersededToken: token,
    userAgent: getUserAgent(c),
  });
  if (!rotated) {
    clearRefreshCookie(c);
    throw errors.unauthenticated('Refresh token is no longer valid');
  }

  // Re-check ban/deletion AFTER the rotate (a committed write): a ban landing in
  // the check→rotate window would otherwise mint a fresh ~15-min access token
  // for a just-banned user. Re-reading after the rotate sees the committed ban;
  // if banned/deleted, revoke this session and fail.
  if (await refreshSubjectBlocked(session.userId)) {
    await revokeSession(session.id).catch(() => undefined);
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

const forgotByIp = new RateLimiter(3, 60 * 60_000, 'forgot-ip');
const forgotByEmail = new RateLimiter(3, 60 * 60_000, 'forgot-email');
// (Token lifetime: services/passwordReset PASSWORD_RESET_EXPIRY_MS.)

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
    if (!(await forgotByIp.consume(ip)).ok) return genericOk();
    if (!(await forgotByEmail.consume(email)).ok) return genericOk();

    const { isEmailConfigured } = await import('../services/email');
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

        // Token + email — the same helper the staff "Send password
        // reset" action uses, so both paths stay identical.
        const { issuePasswordReset } = await import('../services/passwordReset');
        await issuePasswordReset(user);
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
const resetByIp = new RateLimiter(50, 60 * 60_000, 'reset-ip');

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
      const r = await resetByIp.consume(ip);
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
    // dispatch into its top-level import graph.
    //
    // Use dispatch.forceDisconnectUser (not the node-local
    // registry.byUserId loop) so the close fans out across every
    // replica via the internal force-disconnect bus — a socket held
    // on a DIFFERENT node is otherwise never closed and keeps
    // reading until its access token expires.
    try {
      const dispatch = await import('../gateway/dispatch');
      dispatch.forceDisconnectUser(row.userId);
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
    const ip = getClientIp(c) ?? 'unknown';
    const rl = await confirmEmailChangeByIp.consume(ip);
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
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
const verifyEmailByIp = new RateLimiter(50, 60 * 60_000, 'verify-email-ip');
authRouter.post(
  '/verify-email',
  validate('json', z.object({ token: z.string().min(1).max(512) })),
  async (c) => {
    const ip = getClientIp(c) ?? 'unknown';
    {
      const r = await verifyEmailByIp.consume(ip);
      if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
    }

    const { token } = c.req.valid('json');
    const { createHash } = await import('node:crypto');
    const tokenHash = createHash('sha256').update(token).digest('hex');

    // Atomically claim the token: a single UPDATE that requires it be unused
    // AND unexpired. This makes the single-use guarantee deterministic under
    // concurrency (two requests can't both pass a separate SELECT check) and,
    // by putting the expiry in the WHERE, an expired token isn't burned.
    const now = new Date();
    const claimed = await db
      .update(schema.emailVerifications)
      .set({ usedAt: now })
      .where(
        and(
          eq(schema.emailVerifications.tokenHash, tokenHash),
          isNull(schema.emailVerifications.usedAt),
          gt(schema.emailVerifications.expiresAt, now),
        ),
      )
      .returning({ userId: schema.emailVerifications.userId });
    if (claimed.length === 0) {
      throw errors.badRequest('This verification link is invalid or has expired');
    }

    await db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, claimed[0]!.userId));

    return c.json({ ok: true });
  },
);

// Resend the verification email to the logged-in user's address.
const resendByUser = new RateLimiter(3, 10 * 60_000, 'resend-verification');
authRouter.post('/resend-verification', requireAuth, async (c) => {
  const userId = requireUserId(c);
  const r = await resendByUser.consume(userId.toString());
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

// ───────────────────────────────────────────────────────────────────────────
// POST /change-unverified-email
// ───────────────────────────────────────────────────────────────────────────
// Escape hatch for the verify-email gate: a user who registered with a typo'd
// email is otherwise stuck forever (resend goes to the wrong inbox, recheck
// never passes, Settings is behind the gate). This lets a NOT-YET-VERIFIED
// account correct its email and re-send the link, without the full verified-
// account email-change flow.
//
// Safety: gated to unverified accounts only — a stolen access token for a
// VERIFIED account cannot repoint its email here (that's what the verified
// email-change flow, which re-checks the password, is for). The email column
// is UNIQUE, so you can never collide with / take over an existing account's
// email (409 instead). The account stays unverified until the NEW address is
// confirmed.
const changeUnverifiedEmailByUser = new RateLimiter(5, 60 * 60_000, 'change-unverified-email');
authRouter.post(
  '/change-unverified-email',
  requireAuth,
  validate('json', z.object({ email: emailSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { email } = c.req.valid('json');
    const r = await changeUnverifiedEmailByUser.consume(userId.toString());
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));

    const [user] = await db
      .select({ email: schema.users.email, emailVerified: schema.users.emailVerified })
      .from(schema.users)
      .where(eq(schema.users.id, userId))
      .limit(1);
    if (!user) throw errors.unauthenticated();
    // Verified accounts must use the password-gated email-change flow.
    if (user.emailVerified) {
      throw errors.badRequest('This account is already verified; change your email in settings.');
    }
    // No-op when unchanged — still re-send so a user who just mistyped can
    // retry the same address without an error.
    if (user.email !== email) {
      try {
        await db
          .update(schema.users)
          .set({ email })
          .where(
            and(eq(schema.users.id, userId), eq(schema.users.emailVerified, false)),
          );
      } catch (err) {
        if (isUniqueViolation(err)) {
          throw errors.conflict('That email is already registered to another account.');
        }
        throw err;
      }
      // Invalidate any verification links sent to the OLD address.
      await db
        .delete(schema.emailVerifications)
        .where(eq(schema.emailVerifications.userId, userId));
    }

    const { isEmailConfigured } = await import('../services/email');
    if (isEmailConfigured()) {
      try {
        await issueEmailVerification(userId, email);
      } catch (err) {
        log.warn('change-unverified-email send failed', { err: String(err) });
        throw errors.internal('Could not send the verification email');
      }
    }
    return c.json({ ok: true, email });
  },
);

// ═══════════════════════════════════════════════════════════════════════════
// WebAuthn passkeys
// ═══════════════════════════════════════════════════════════════════════════
//
// Two ceremonies, each two requests:
//   register (authed): add a passkey to your account.
//   login    (anon):   sign in with a passkey, then mint the SAME session a
//                      password login would (createSession + access token +
//                      refresh cookie). A passkey session is indistinguishable
//                      from a password one downstream.
// Plus list/delete for the Settings → Security management block. The per-
// ceremony challenge is held single-use in the challenge store between the
// options and verify calls. Binary fields are stored base64url (Buffer).

const passkeyLoginByIp = new RateLimiter(50, 15 * 60_000, 'passkey-login-ip');
// Separate per-IP budget for the anonymous options endpoint so an
// options-flood can't drain the verify budget (or vice versa). Each
// options call runs generateAuthenticationOptions + a challenge-store
// write; without this it's the only anonymous auth entrypoint with no
// throttle.
const passkeyOptionsByIp = new RateLimiter(50, 15 * 60_000, 'passkey-options-ip');

const passkeyRegVerifySchema = z.object({
  challengeId: z.string().min(1).max(64),
  response: z.record(z.string(), z.unknown()), // RegistrationResponseJSON
  deviceName: z.string().trim().max(60).optional(),
  // Step-up: enrolling a passkey plants a permanent login factor that survives
  // password reset + "log out everywhere", so require the account password on
  // this already-authed request. Gated here at verify (the credential-insert
  // point) rather than only at /options, because the anonymous /passkey/login/
  // options endpoint writes to the same challenge store — a challenge minted
  // there could otherwise be redeemed at an ungated verify to bypass /options.
  currentPassword: z.string().min(1).max(1024),
});
const passkeyLoginVerifySchema = z.object({
  challengeId: z.string().min(1).max(64),
  response: z.record(z.string(), z.unknown()), // AuthenticationResponseJSON
});

// 1) Register options (authed) — exclude already-registered credentials.
authRouter.post('/passkey/register/options', requireAuth, requireHumanSession, async (c) => {
  const userId = requireUserId(c);
  const [user] = await db
    .select({ id: schema.users.id, username: schema.users.username, displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!user) throw errors.notFound('User');
  const existing = await db
    .select({ credentialId: schema.webauthnCredentials.credentialId, transports: schema.webauthnCredentials.transports })
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId));
  const options = await generateRegistrationOptions({
    rpName,
    rpID,
    userName: user.username,
    userDisplayName: user.displayName,
    userID: new TextEncoder().encode(user.id.toString()),
    attestationType: 'none',
    excludeCredentials: existing.map((cr) => ({
      id: cr.credentialId,
      transports: cr.transports ? (JSON.parse(cr.transports) as never) : undefined,
    })),
    authenticatorSelection: { residentKey: 'preferred', userVerification: 'preferred' },
  });
  const challengeId = newChallengeId();
  await challengeStore.put(challengeId, options.challenge);
  return c.json({ challengeId, options });
});

// 2) Register verify (authed) — store the new credential.
authRouter.post('/passkey/register/verify', requireAuth, requireHumanSession, validate('json', passkeyRegVerifySchema), async (c) => {
  const userId = requireUserId(c);
  const body = c.req.valid('json');
  // Re-verify the password before consuming the single-use challenge, so a
  // wrong password doesn't burn the ceremony.
  await assertStepUpPassword(userId, body.currentPassword);
  const challenge = await challengeStore.take(body.challengeId);
  if (!challenge) throw errors.badRequest('Passkey challenge expired — please try again.');
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response as never,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      requireUserVerification: false,
    });
  } catch {
    throw errors.badRequest('Could not verify the passkey.');
  }
  if (!verification.verified || !verification.registrationInfo) {
    throw errors.badRequest('Passkey verification failed.');
  }
  const cred = verification.registrationInfo.credential;
  try {
    await db.insert(schema.webauthnCredentials).values({
      id: nextSnowflake(),
      userId,
      credentialId: cred.id,
      publicKey: Buffer.from(cred.publicKey).toString('base64url'),
      counter: cred.counter,
      transports: cred.transports ? JSON.stringify(cred.transports) : null,
      deviceName: body.deviceName || null,
      backedUp: verification.registrationInfo.credentialBackedUp ?? false,
    });
  } catch (e) {
    if (isUniqueViolation(e)) throw errors.conflict('That passkey is already registered.');
    throw e;
  }
  // May unlock locked_in (first passkey) and double_locked (with 2FA on).
  void import('../services/achievements')
    .then((m) => m.syncAndNotifyAchievements(userId))
    .catch(() => {});
  return c.json({ ok: true });
});

// 3) Login options (anonymous) — discoverable credentials (no allowCredentials).
authRouter.post('/passkey/login/options', async (c) => {
  // Throttle per-IP (mirrors the verify guard) so this anonymous endpoint
  // can't be flooded. Guard on `ip` so a missing client IP doesn't hard-
  // fail legitimate ceremonies.
  const ip = getClientIp(c);
  if (ip) {
    const r = await passkeyOptionsByIp.consume(ip);
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
  }
  // userVerification: 'required' so the client prompts for the biometric/
  // PIN gesture; the verify step enforces UV, this makes the platform ask.
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  const challengeId = newChallengeId();
  await challengeStore.put(challengeId, options.challenge);
  return c.json({ challengeId, options });
});

// 4) Login verify (anonymous) — verify the assertion, then mint a session.
authRouter.post('/passkey/login/verify', validate('json', passkeyLoginVerifySchema), async (c) => {
  const ip = getClientIp(c);
  const ua = getUserAgent(c);
  if (ip) {
    const r = await passkeyLoginByIp.consume(ip);
    if (!r.ok) throw errors.rateLimited(Math.ceil(r.retryAfterMs / 1000));
  }
  const body = c.req.valid('json');
  const credentialId = body.response.id;
  if (typeof credentialId !== 'string') throw errors.badRequest('Malformed passkey response.');

  const [cred] = await db
    .select()
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.credentialId, credentialId))
    .limit(1);
  if (!cred) throw errors.invalidCredentials();

  const challenge = await challengeStore.take(body.challengeId);
  if (!challenge) throw errors.badRequest('Passkey challenge expired — please try again.');

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response: body.response as never,
      expectedChallenge: challenge,
      expectedOrigin,
      expectedRPID: rpID,
      credential: {
        id: cred.credentialId,
        publicKey: new Uint8Array(Buffer.from(cred.publicKey, 'base64url')),
        counter: cred.counter,
        transports: cred.transports ? (JSON.parse(cred.transports) as never) : undefined,
      },
      // Require UV at assert time: a passkey login mints a full primary
      // session (createSession + access token + refresh cookie) just like
      // a password login, so we demand the biometric/PIN gesture to keep
      // possession+verification == the two-factor strength the password
      // path gets. UV=0 assertions are rejected.
      requireUserVerification: true,
    });
  } catch {
    throw errors.badRequest('Could not verify the passkey.');
  }
  if (!verification.verified) throw errors.invalidCredentials();

  // Bump the replay counter + last-used stamp.
  await db
    .update(schema.webauthnCredentials)
    .set({ counter: verification.authenticationInfo.newCounter, lastUsedAt: new Date() })
    .where(eq(schema.webauthnCredentials.id, cred.id));

  const [user] = await db.select().from(schema.users).where(eq(schema.users.id, cred.userId)).limit(1);
  // Use isCurrentlyBanned (not raw bannedAt) so an EXPIRED timed ban doesn't
  // wrongly block passkey login — matches /login + /quick-login/redeem.
  if (!user || user.deletedAt || isCurrentlyBanned(user)) throw errors.invalidCredentials();

  const { session, refreshToken } = await createSession({ userId: user.id, userAgent: ua, ipAddress: ip });
  const accessToken = await signAccessToken({ userId: user.id, sessionId: session.id });
  setRefreshCookie(c, refreshToken);
  return c.json({ user: toSelfUser(user), accessToken, expiresIn: env.ACCESS_TOKEN_TTL_SECONDS });
});

// List the current user's passkeys (Settings → Security).
authRouter.get('/passkey', requireAuth, requireHumanSession, async (c) => {
  const userId = requireUserId(c);
  const rows = await db
    .select({
      id: schema.webauthnCredentials.id,
      deviceName: schema.webauthnCredentials.deviceName,
      backedUp: schema.webauthnCredentials.backedUp,
      createdAt: schema.webauthnCredentials.createdAt,
      lastUsedAt: schema.webauthnCredentials.lastUsedAt,
    })
    .from(schema.webauthnCredentials)
    .where(eq(schema.webauthnCredentials.userId, userId))
    .orderBy(desc(schema.webauthnCredentials.createdAt));
  return c.json({
    passkeys: rows.map((r) => ({
      id: r.id.toString(),
      deviceName: r.deviceName,
      backedUp: r.backedUp,
      createdAt: r.createdAt,
      lastUsedAt: r.lastUsedAt,
    })),
  });
});

// Remove one of the current user's passkeys. Step-up gated: stripping a login
// factor is as sensitive as adding one (an attacker with a transient token
// could otherwise remove the owner's passkeys), so require the account password.
authRouter.delete(
  '/passkey/:id',
  requireAuth,
  validate('param', z.object({ id: snowflakeSchema })),
  validate('json', z.object({ currentPassword: z.string().min(1).max(1024) })),
  async (c) => {
    const userId = requireUserId(c);
    const { id } = c.req.valid('param');
    const { currentPassword } = c.req.valid('json');
    await assertStepUpPassword(userId, currentPassword);
    await db
      .delete(schema.webauthnCredentials)
      .where(and(eq(schema.webauthnCredentials.id, BigInt(id)), eq(schema.webauthnCredentials.userId, userId)));
    return c.json({ ok: true });
  },
);
