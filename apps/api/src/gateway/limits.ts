/**
 * Gateway abuse limits
 * --------------------
 * Every /gateway upgrade costs a socket plus an IDENTIFY timer, and every
 * IDENTIFY loads the user's full membership snapshot (~8 queries) and fans a
 * presence update out. Without a limit, one client looping connect/IDENTIFY
 * is a cheap way to load the database. Two fixed-window limits, both on the
 * shared limiter in lib/rateLimit.ts (cluster-wide under REDIS_URL, fail-open
 * on Redis errors):
 *
 *   - upgrades per client IP (GATEWAY_CONNECTS_PER_MINUTE_PER_IP), checked
 *     before the WebSocket handshake;
 *   - IDENTIFY + RESUME attempts per user (GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER),
 *     checked after the token verifies and before any DB work.
 *
 * Defaults are deliberately generous (see env.ts): a legitimate reconnect
 * storm — a phone waking, a browser restoring many tabs, every client of a
 * replica reconnecting on deploy — must never trip them. A tripped limit is
 * not fatal for a client: it backs off and reconnects as for any drop.
 */

import { RateLimiter } from '../lib/rateLimit';
import { env } from '../env';

const MINUTE_MS = 60_000;

const connectLimiter =
  env.GATEWAY_CONNECTS_PER_MINUTE_PER_IP > 0
    ? new RateLimiter(env.GATEWAY_CONNECTS_PER_MINUTE_PER_IP, MINUTE_MS, 'gateway-connect-ip')
    : null;

const identifyLimiter =
  env.GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER > 0
    ? new RateLimiter(env.GATEWAY_IDENTIFIES_PER_MINUTE_PER_USER, MINUTE_MS, 'gateway-identify-user')
    : null;

/** Consume one upgrade for this client IP. Returns the retry-after in ms when
 *  over the limit, or null to proceed. An unknown IP is not limited (there is
 *  nothing to key on). */
export async function consumeGatewayConnect(ip: string | null): Promise<number | null> {
  if (!connectLimiter || !ip) return null;
  const r = await connectLimiter.consume(ip);
  return r.ok ? null : r.retryAfterMs;
}

/** Consume one IDENTIFY/RESUME attempt for this user. True to proceed. */
export async function consumeGatewayIdentify(userId: bigint): Promise<boolean> {
  if (!identifyLimiter) return true;
  return (await identifyLimiter.consume(userId.toString())).ok;
}
