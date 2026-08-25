/**
 * Startup checks
 * --------------
 * Runs a smoke test for every subsystem before the HTTP server starts
 * accepting connections. The output is designed to be the first thing a
 * self-host operator sees in the docker-compose console — pass/fail per
 * subsystem, with a one-line reason on failure.
 *
 * If anything fails the process exits 1, so the container is stuck in a
 * loop until the operator fixes it. That's strictly preferable to a server
 * that listens but is silently broken.
 *
 * Adding a new check: append to the `checks` array. Each check is a name +
 * an async run() that returns either { ok: true, detail? } or
 * { ok: false, reason }. Keep `detail` and `reason` short — single line.
 */

import { promises as fs } from 'node:fs';
import { sql } from 'drizzle-orm';
import path from 'node:path';
import { db } from './db';
import { env } from './env';
import { hashPassword, verifyPassword } from './auth/passwords';
import { nextSnowflake } from './snowflake';
import { HEARTBEAT_INTERVAL_MS, IDENTIFY_TIMEOUT_MS } from './gateway/types';

interface OkResult {
  ok: true;
  detail?: string;
}
interface FailResult {
  ok: false;
  reason: string;
}
type Result = OkResult | FailResult;

interface Check {
  name: string;
  run(): Promise<Result>;
}

// ── Individual checks ──────────────────────────────────────────────────────

const envCheck: Check = {
  name: 'Environment configuration',
  async run() {
    // env was validated by zod at module load. By the time we get here, if
    // the import succeeded, env is good. Surface a concise summary so the
    // operator can confirm the right values made it in.
    const features = [
      `node=${env.NODE_ENV}`,
      `log=${env.LOG_LEVEL}`,
      `port=${env.PORT}`,
      `worker=${env.WORKER_ID}`,
      `registration=${env.ALLOW_REGISTRATION}`,
      env.TRUST_PROXY ? 'trust_proxy=true' : null,
      env.REDIS_URL ? 'redis=set' : 'redis=unset',
    ]
      .filter(Boolean)
      .join(' ');
    return { ok: true, detail: features };
  },
};

const snowflakeCheck: Check = {
  name: 'Snowflake ID generator',
  async run() {
    // Generate a batch and assert strict monotonicity. A regression here
    // (clock skew, broken sequence overflow handling) is a silent
    // catastrophe — every primary key would collide.
    const N = 1000;
    const ids = Array.from({ length: N }, () => nextSnowflake());
    for (let i = 1; i < ids.length; i++) {
      if (ids[i]! <= ids[i - 1]!) {
        return { ok: false, reason: `non-monotonic at index ${i}: ${ids[i - 1]} → ${ids[i]}` };
      }
    }
    if (env.WORKER_ID < 0 || env.WORKER_ID > 1023) {
      return { ok: false, reason: `WORKER_ID out of range (0..1023)` };
    }
    return { ok: true, detail: `worker_id=${env.WORKER_ID}, ${N} ids monotonic` };
  },
};

const passwordCheck: Check = {
  name: 'Password hashing (scrypt)',
  async run() {
    // Round-trip a known plaintext to make sure scrypt is reachable and the
    // version-tagged format hasn't broken. Wrong password verify must fail.
    const plain = 'zekktris-startup-check-not-a-real-password';
    const hashed = await hashPassword(plain);
    const okMatch = await verifyPassword(plain, hashed);
    if (!okMatch) return { ok: false, reason: 'verify(correct) returned false' };
    const okWrong = await verifyPassword(plain + 'x', hashed);
    if (okWrong) return { ok: false, reason: 'verify(wrong) returned true' };
    return { ok: true, detail: 'scrypt-v1 round-trip verified' };
  },
};

const jwtCheck: Check = {
  name: 'JWT secrets',
  async run() {
    if (env.JWT_SECRET === env.JWT_REFRESH_SECRET) {
      return {
        ok: false,
        reason: 'JWT_SECRET and JWT_REFRESH_SECRET must differ',
      };
    }
    if (env.JWT_SECRET.length < 32 || env.JWT_REFRESH_SECRET.length < 32) {
      return { ok: false, reason: 'each secret must be at least 32 characters' };
    }
    return {
      ok: true,
      detail: `access ${env.JWT_SECRET.length}b + refresh ${env.JWT_REFRESH_SECRET.length}b, distinct`,
    };
  },
};

const dbConnectCheck: Check = {
  name: 'Database connection',
  async run() {
    try {
      const versionRows = await db.execute<{ version: string }>(sql`SELECT version()`);
      const versionStr = versionRows[0]?.version ?? '';
      const version = /PostgreSQL\s+(\S+)/.exec(versionStr)?.[1] ?? 'unknown';
      // Strip credentials from URL for log output.
      const url = new URL(env.DATABASE_URL);
      url.password = '';
      url.username = url.username ? '***' : '';
      return {
        ok: true,
        detail: `${url.host}${url.pathname} (Postgres ${version})`,
      };
    } catch (err) {
      return { ok: false, reason: `cannot connect: ${(err as Error).message}` };
    }
  },
};

/**
 * Apply any pending migrations on boot. We run this BEFORE the schema check
 * so a fresh database (zero tables) gets the schema applied here, and the
 * subsequent schema check just verifies the result. Idempotent — drizzle
 * skips already-applied migrations and the call returns quickly when
 * there's nothing new.
 *
 * Behavior on failure: we surface the error but the runner aborts the boot
 * because subsequent checks (schema, etc) would fail anyway.
 */
const dbMigrationsCheck: Check = {
  name: 'Database migrations',
  async run() {
    try {
      // Lazy-import so the dependency on the migrator only loads when this
      // check actually runs. Keeps cold-start time down and lets `tsx` do
      // its caching one module at a time.
      const { runMigrations } = await import('@zekktris/db');
      const result = await runMigrations(env.DATABASE_URL);
      return {
        ok: true,
        detail: `applied/verified in ${result.durationMs}ms`,
      };
    } catch (err) {
      return { ok: false, reason: (err as Error).message };
    }
  },
};

const dbSchemaCheck: Check = {
  name: 'Database schema',
  async run() {
    const expected = [
      'attachments',
      'audit_log_entries',
      'bans',
      'channels',
      'dm_recipients',
      'guild_members',
      'guilds',
      'invites',
      'member_roles',
      'message_role_mentions',
      'message_user_mentions',
      'messages',
      'notification_overrides',
      'permission_overrides',
      'push_subscriptions',
      'reactions',
      'read_states',
      'relationships',
      'roles',
      'sessions',
      'signup_codes',
      'users',
      'voice_states',
    ];
    try {
      const rows = await db.execute<{ tablename: string }>(sql`
        SELECT tablename FROM pg_tables WHERE schemaname = 'public'
      `);
      const found = new Set(rows.map((r) => r.tablename));
      const missing = expected.filter((t) => !found.has(t));
      if (missing.length > 0) {
        return {
          ok: false,
          reason: `missing tables: ${missing.join(', ')} — run "pnpm db:migrate"`,
        };
      }
      // Drizzle records applied migrations in __drizzle_migrations.
      const migRows = await db
        .execute<{ count: bigint }>(sql`SELECT count(*) AS count FROM drizzle.__drizzle_migrations`)
        .catch(() => null);
      const migCount = migRows?.[0]?.count ?? null;
      return {
        ok: true,
        detail: `${expected.length} tables present${
          migCount != null ? `, ${migCount} migration(s) applied` : ''
        }`,
      };
    } catch (err) {
      return { ok: false, reason: `schema query failed: ${(err as Error).message}` };
    }
  },
};

const uploadDirCheck: Check = {
  name: 'Upload directory',
  async run() {
    const dir = env.UPLOAD_DIR;
    try {
      await fs.mkdir(dir, { recursive: true });
      // Probe writability with a real round-trip.
      const probe = path.join(dir, '.zekktris-startup-probe');
      await fs.writeFile(probe, 'ok');
      await fs.unlink(probe);
      return {
        ok: true,
        detail: `${dir} (writable, max ${env.MAX_UPLOAD_SIZE_MB} MB/file × ${env.MAX_FILES_PER_MESSAGE} files)`,
      };
    } catch (err) {
      return { ok: false, reason: `${dir}: ${(err as Error).message}` };
    }
  },
};

const redisCheck: Check = {
  name: 'Redis (optional)',
  async run() {
    if (!env.REDIS_URL) {
      return { ok: true, detail: 'not configured (gateway pubsub will be in-memory)' };
    }
    let host: string;
    try {
      host = new URL(env.REDIS_URL).host;
    } catch {
      return { ok: false, reason: 'REDIS_URL is set but unparseable' };
    }
    // Real round-trip, not just a URL parse: a wrong host/port/password
    // would otherwise pass startup silently and only surface later as
    // gateway-bus and session-blacklist errors at runtime. Redis is
    // fail-soft by design (everything that uses it degrades rather than
    // breaks), and the api container may win the boot race against the
    // cache container — so an unreachable Redis is reported LOUDLY in the
    // detail but does not block boot.
    const { default: Redis } = await import('ioredis');
    const client = new Redis(env.REDIS_URL, {
      lazyConnect: true,
      connectTimeout: 3000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      retryStrategy: () => null, // one shot; don't keep the check alive retrying
    });
    client.on('error', () => {}); // surfaced via the try/catch below
    try {
      await client.connect();
      const pong = await client.ping();
      if (pong !== 'PONG') {
        return { ok: true, detail: `${host} — UNEXPECTED PING REPLY (continuing, fail-soft)` };
      }
      return { ok: true, detail: `${host} (PING ok)` };
    } catch (err) {
      return {
        ok: true,
        detail: `${host} UNREACHABLE — continuing fail-soft; multi-node fanout, shared rate limits and session revocation are degraded until it returns (${(err as Error).message})`,
      };
    } finally {
      client.disconnect();
    }
  },
};

const gatewayCheck: Check = {
  name: 'Gateway (WebSocket)',
  async run() {
    // Smoke-test the gateway primitives without actually opening a socket.
    // We can't bind a port here (the HTTP server hasn't started yet), but
    // we can verify the bus + dispatch + registry singletons import cleanly
    // and a publish/subscribe round-trip works.
    try {
      const { eventBus } = await import('./gateway/bus');
      const { GatewayEvent } = await import('@zekktris/shared/events');
      let received = false;
      const unsub = eventBus().subscribe((e) => {
        if (e.t === GatewayEvent.READY) received = true;
      });
      eventBus().publish({
        t: GatewayEvent.READY,
        d: { _probe: true },
        audience: { kind: 'user', userId: 0n },
      });
      unsub();
      if (!received) return { ok: false, reason: 'bus did not deliver probe event' };
      return {
        ok: true,
        detail: `bus delivered probe; heartbeat=${HEARTBEAT_INTERVAL_MS / 1000}s, identify_timeout=${IDENTIFY_TIMEOUT_MS / 1000}s`,
      };
    } catch (err) {
      return { ok: false, reason: `init failed: ${(err as Error).message}` };
    }
  },
};

// Order matters: the cheap, infallible checks come first so the operator
// sees them tick green before the slow/io-bound ones run.
const pushCheck: Check = {
  name: 'Push notifications (VAPID)',
  async run() {
    const { initPush } = await import('./services/push');
    const ready = initPush();
    if (ready) {
      return { ok: true, detail: 'configured' };
    }
    // Push is OPTIONAL — missing keys aren't a hard failure. We surface
    // it as a "skipped" pass so the operator sees they need to set
    // VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY if they want notifications.
    return { ok: true, detail: 'skipped (VAPID keys not set — push disabled)' };
  },
};

const apnsCheck: Check = {
  name: 'Push notifications (APNs / iOS)',
  async run() {
    const { initApns } = await import('./services/apns');
    const ready = await initApns();
    if (ready) {
      return {
        ok: true,
        detail: `configured (${env.APNS_PRODUCTION ? 'production' : 'sandbox'} host)`,
      };
    }
    // APNs is OPTIONAL — missing keys aren't a hard failure.
    return { ok: true, detail: 'skipped (APNS_* not set — iOS push disabled)' };
  },
};

/**
 * Voice/video (LiveKit).
 *
 * The LiveKit API secret is the HMAC key the SFU uses to verify join tokens.
 * Anyone who knows it can mint a valid token for ANY room and join any voice
 * channel, stage, or DM call as any identity — without ever authenticating to
 * Zekktris, and without any of the API's permission checks running. So a
 * secret that has ever been published is not "weak", it is *public*: we refuse
 * to start rather than serve voice that is wide open.
 *
 * Two values have been published in this repo's history and are hard-blocked:
 * the old docker-compose fallback, and the LiveKit Cloud pair an earlier
 * setup.sh committed (the same pair scripts/setup.sh already migrates away
 * from). Voice being unconfigured is NOT a failure — it degrades to
 * presence-only, which is the safe default.
 */
const PUBLISHED_LIVEKIT_SECRETS = new Set([
  'devsecret-do-not-use-in-production-32chars',
  'REDACTED-LEAKED-LIVEKIT-SECRET',
]);
const PUBLISHED_LIVEKIT_KEYS = new Set(['devkey', 'APIAMD7Sj5psuK4']);

const livekitCheck: Check = {
  name: 'Voice / video (LiveKit)',
  async run() {
    const key = env.LIVEKIT_API_KEY;
    const secret = env.LIVEKIT_API_SECRET;
    if (!key && !secret) {
      return { ok: true, detail: 'skipped (LIVEKIT_* not set — voice disabled)' };
    }
    if (!key || !secret) {
      return {
        ok: false,
        reason:
          'LIVEKIT_API_KEY and LIVEKIT_API_SECRET must be set together ' +
          '(one is missing) — set both, or clear both to disable voice',
      };
    }
    if (PUBLISHED_LIVEKIT_SECRETS.has(secret) || PUBLISHED_LIVEKIT_KEYS.has(key)) {
      return {
        ok: false,
        reason:
          'LIVEKIT credentials are a PUBLISHED value from this repository. ' +
          'Anyone can forge a join token for any call on this instance. ' +
          'Generate a fresh pair and restart:\n' +
          "       LIVEKIT_API_KEY=lk_$(openssl rand -hex 8)\n" +
          '       LIVEKIT_API_SECRET=$(openssl rand -hex 32)',
      };
    }
    if (secret.length < 32) {
      return {
        ok: true,
        detail: `configured — WARNING: secret is only ${secret.length} chars, use \`openssl rand -hex 32\``,
      };
    }
    return {
      ok: true,
      detail: `configured (${env.LIVEKIT_WS_URL ? 'external SFU' : 'bundled SFU, same-origin /livekit'})`,
    };
  },
};

const checks: readonly Check[] = [
  envCheck,
  snowflakeCheck,
  passwordCheck,
  jwtCheck,
  dbConnectCheck,
  dbMigrationsCheck,
  dbSchemaCheck,
  uploadDirCheck,
  redisCheck,
  gatewayCheck,
  livekitCheck,
  pushCheck,
  apnsCheck,
];

// ── Runner / formatter ─────────────────────────────────────────────────────

const BANNER = '═'.repeat(64);
const NAME_COL = 36; // pad the check name to this many chars before the dots

function pad(s: string, n: number): string {
  if (s.length >= n) return s;
  return s + ' '.repeat(n - s.length);
}

/**
 * Run every registered check. Prints a banner-formatted report; exits 1 on
 * any failure, returns normally on success.
 */
export async function runStartupChecks(): Promise<void> {
  process.stdout.write(`\n${BANNER}\n  Zekktris API — startup checks\n${BANNER}\n\n`);
  const startTotal = performance.now();

  let failed = 0;
  for (let i = 0; i < checks.length; i++) {
    const c = checks[i]!;
    const tag = `[${String(i + 1).padStart(2, ' ')}/${checks.length}]`;
    const start = performance.now();

    process.stdout.write(`${tag} ${pad(c.name, NAME_COL)} ... `);

    let result: Result;
    try {
      result = await c.run();
    } catch (err) {
      result = { ok: false, reason: `threw: ${(err as Error).message}` };
    }
    const ms = Math.max(0, Math.round(performance.now() - start));

    if (result.ok) {
      process.stdout.write(`✓ (${ms}ms)\n`);
      if (result.detail) process.stdout.write(`     ${result.detail}\n`);
    } else {
      process.stdout.write(`✗ (${ms}ms)\n`);
      process.stdout.write(`     ${result.reason}\n`);
      failed++;
    }
  }

  const totalMs = Math.round(performance.now() - startTotal);
  process.stdout.write(`\n${BANNER}\n`);
  if (failed > 0) {
    process.stdout.write(
      `  ${failed} check(s) failed in ${totalMs}ms — refusing to start\n${BANNER}\n\n`,
    );
    // eslint-disable-next-line no-process-exit
    process.exit(1);
  }
  process.stdout.write(
    `  All ${checks.length} checks passed in ${totalMs}ms — starting HTTP server\n${BANNER}\n\n`,
  );
}
