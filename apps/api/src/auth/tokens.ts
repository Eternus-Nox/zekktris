/**
 * Tokens
 * ------
 * Two distinct token shapes:
 *
 *   Access token: short-lived JWT (HS256), 15 min default. Carries
 *   { sub: userId, sid: sessionId }. Sent as `Authorization: Bearer ...`.
 *   No db lookup on each request — the JWT signature + expiry is enough.
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
