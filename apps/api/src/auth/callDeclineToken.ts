/**
 * Call-decline capability tokens
 * ------------------------------
 * A web push "Decline" button is handled by the service worker, which has
 * no bearer token (that lives in the page) and no cookie the API accepts
 * for normal routes. So the ring push carries a narrow, short-lived
 * capability instead: an HMAC-signed token that can do exactly one thing —
 * decline ONE specific 1:1 call, as ONE user, for a few minutes.
 *
 * Bound to:
 *   - the callee (the user allowed to decline),
 *   - the DM channel,
 *   - the caller, and
 *   - the call's `dmActiveCallStartedAt` (ms) — a later call in the same DM
 *     has a different start time, so an old notification can't end it,
 *   - an expiry.
 *
 * Format: `v1.<callee>.<channel>.<caller>.<startedMs>.<expSec>.<sig>` where
 * sig = base64url(HMAC-SHA256(key, everything before it)). The key is
 * derived from JWT_SECRET with a purpose label, so a token can never be
 * confused with (or used to forge) any other signed value.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../env';

/** How long a ring notification's Decline button keeps working. */
export const CALL_DECLINE_TOKEN_TTL_SECONDS = 5 * 60;

export interface CallDeclineClaims {
  userId: bigint;
  channelId: bigint;
  callerId: bigint;
  callStartedAtMs: number;
}

function key(): Buffer {
  return createHmac('sha256', env.JWT_SECRET).update('zekktris/call-decline/v1').digest();
}

function sign(body: string): string {
  return createHmac('sha256', key()).update(body).digest('base64url');
}

export function signCallDeclineToken(
  claims: CallDeclineClaims,
  nowMs: number = Date.now(),
): string {
  const exp = Math.floor(nowMs / 1000) + CALL_DECLINE_TOKEN_TTL_SECONDS;
  const body = [
    'v1',
    claims.userId.toString(),
    claims.channelId.toString(),
    claims.callerId.toString(),
    String(claims.callStartedAtMs),
    String(exp),
  ].join('.');
  return `${body}.${sign(body)}`;
}

/** Returns the claims, or null when the token is malformed, forged or expired. */
export function verifyCallDeclineToken(
  token: string,
  nowMs: number = Date.now(),
): CallDeclineClaims | null {
  const parts = token.split('.');
  if (parts.length !== 7 || parts[0] !== 'v1') return null;
  const [, user, channel, caller, started, exp, sig] = parts as [
    string, string, string, string, string, string, string,
  ];
  if (![user, channel, caller, started, exp].every((p) => /^\d{1,20}$/.test(p))) return null;
  const expected = Buffer.from(sign(parts.slice(0, 6).join('.')));
  const given = Buffer.from(sig);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  if (Number(exp) * 1000 <= nowMs) return null;
  return {
    userId: BigInt(user),
    channelId: BigInt(channel),
    callerId: BigInt(caller),
    callStartedAtMs: Number(started),
  };
}
