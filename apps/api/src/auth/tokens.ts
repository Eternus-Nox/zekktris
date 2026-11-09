/**
 * Tokens
 * ------
 * Three distinct token shapes:
 *
 *   Access token: short-lived JWT (HS256), 15 min default. Carries
 *   { sub: userId, sid: sessionId }. Sent as `Authorization: Bearer ...`.
 *   No db lookup on each request — the JWT signature + expiry is enough.
 *
 *   Intent token: long-lived (30 day), narrowly scoped JWT for the native
 *   app's Siri / widget / watch senders. Sent as `Authorization: Intent ...`.
 *   Checked against its session row on every use. See "Intent tokens" below.
 *
 *   Refresh token: opaque, 256-bit random. Stored hashed (sha256) in the
 *   sessions table. Sent as an httpOnly cookie scoped to /api/v1/auth.
 *   Used to mint new access tokens; rotated on every refresh.
 *
 * Two distinct secrets (env.JWT_SECRET, env.JWT_REFRESH_SECRET) — though
 * the refresh token is opaque and doesn't actually use the refresh secret
 * for signing, we keep the two-secret pattern in env so a future move to
 * signed refresh tokens (or hash pepper) is a one-line change.
 */

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { randomBytes, createHash } from 'node:crypto';
import { env } from '../env';
import { errors } from '../errors';

const accessSecret = new TextEncoder().encode(env.JWT_SECRET);
/** Used as a pepper when hashing refresh tokens. Compromising the db alone is not enough. */
const refreshPepper = new TextEncoder().encode(env.JWT_REFRESH_SECRET);

// JWT issuer + audience claims. Renamed from the legacy 'commune'/
// 'commune-web' values during the brand cleanup. Consequence: any
// access or refresh tokens issued under the OLD values are rejected
// by verifyJwt as having the wrong issuer/audience claims, which
// transparently logs users out on first request after this deploy.
// They re-authenticate via the login screen and get fresh
// zekktris-issued tokens. This was a one-time cost the user
// accepted to clean up the codebase fully.
const ISSUER = 'zekktris';
const AUDIENCE = 'zekktris-web';

// ───────────────────────────────────────────────────────────────────────────
// Access tokens
// ───────────────────────────────────────────────────────────────────────────

export interface AccessTokenClaims {
  userId: bigint;
  sessionId: bigint;
}

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ sid: claims.sessionId.toString() })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId.toString())
    .setIssuedAt()
    .setExpirationTime(`${env.ACCESS_TOKEN_TTL_SECONDS}s`)
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .sign(accessSecret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, accessSecret, {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ['HS256'],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw errors.tokenExpired();
    throw errors.tokenInvalid();
  }

  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw errors.tokenInvalid('Access token is malformed');
  }
  try {
    return {
      userId: BigInt(payload.sub),
      sessionId: BigInt(payload.sid),
    };
  } catch {
    throw errors.tokenInvalid('Access token is malformed');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Intent tokens
// ───────────────────────────────────────────────────────────────────────────
//
// The credential the native app hands its out-of-process senders: the Siri
// extensions, the widgets' poke and the watch. They can't hold the refresh
// cookie, so they used to send with a copy of the 15-minute access token, which
// went stale once the app had been idle that long.
//
// Same secret and issuer as the access token, but its own audience: an intent
// token never passes verifyAccessToken (REST Bearer, gateway IDENTIFY) and an
// access token never passes verifyIntentToken. It carries the session id, and
// requireAuth checks that session's row on every use, so logout, revoke and
// theft revocation end it at once even though it lives 30 days. Sent as
// `Authorization: Intent <jwt>` and accepted only on the few routes requireAuth
// allows it (auth/middleware.ts).

const INTENT_AUDIENCE = 'zekktris-intents';
export const INTENT_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function signIntentToken(
  claims: AccessTokenClaims,
): Promise<{ token: string; expiresAt: Date }> {
  const exp = Math.floor(Date.now() / 1000) + INTENT_TOKEN_TTL_SECONDS;
  const token = await new SignJWT({ sid: claims.sessionId.toString() })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(claims.userId.toString())
    .setIssuedAt()
    .setExpirationTime(exp)
    .setIssuer(ISSUER)
    .setAudience(INTENT_AUDIENCE)
    .sign(accessSecret);
  return { token, expiresAt: new Date(exp * 1000) };
}

export async function verifyIntentToken(token: string): Promise<AccessTokenClaims> {
  let payload;
  try {
    ({ payload } = await jwtVerify(token, accessSecret, {
      issuer: ISSUER,
      audience: INTENT_AUDIENCE,
      algorithms: ['HS256'],
    }));
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) throw errors.tokenExpired('Intent token has expired');
    throw errors.tokenInvalid('Intent token is invalid');
  }

  if (typeof payload.sub !== 'string' || typeof payload.sid !== 'string') {
    throw errors.tokenInvalid('Intent token is malformed');
  }
  try {
    return {
      userId: BigInt(payload.sub),
      sessionId: BigInt(payload.sid),
    };
  } catch {
    throw errors.tokenInvalid('Intent token is malformed');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Refresh tokens
// ───────────────────────────────────────────────────────────────────────────

/**
 * Generate a fresh opaque refresh token. Returns both the plaintext (sent to
 * the client in a cookie) and the hash (stored in the sessions table).
 */
export function generateRefreshToken(): { token: string; hash: string } {
  const bytes = randomBytes(32); // 256 bits of entropy
  const token = bytes.toString('base64url');
  return { token, hash: hashRefreshToken(token) };
}

/** Hash a refresh token for storage / lookup. Peppered with JWT_REFRESH_SECRET. */
export function hashRefreshToken(token: string): string {
  return createHash('sha256')
    .update(token, 'utf8')
    .update(refreshPepper)
    .digest('hex');
}
