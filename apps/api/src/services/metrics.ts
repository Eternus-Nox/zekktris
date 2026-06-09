/**
 * Instance metrics
 * ----------------
 * Operational/runtime observability for the self-hosted operator. Until now
 * the only window into a running instance was `docker logs`; this gathers the
 * numbers an operator actually wants on a dashboard or scrape: live gateway
 * connections, process uptime, entity counts, voice occupancy, scheduled-send
 * backlog, and DB/Redis health.
 *
 * One `gatherMetrics()` feeds two surfaces (so they never drift):
 *   - GET /api/v1/admin/metrics  → JSON, instance-admin gated (dashboard)
 *   - GET /metrics               → Prometheus text exposition (scrape, opt-in)
 *
 * Everything here is cheap: a handful of COUNT(*)s (parallelized) plus
 * in-memory reads. The Redis probe is bounded so it can never hang a request.
 */

import { and, eq, gt, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { env } from '../env';
import { registry } from '../gateway/registry';
import { eventBus } from '../gateway/bus';
import { RedisEventBus } from '../gateway/redis-bus';

export interface InstanceMetrics {
  process: {
    uptimeSeconds: number;
    workerId: number;
    nodeEnv: string;
  };
  gateway: {
    /** Open WebSocket connections (all devices/tabs). */
    connections: number;
    /** Distinct authenticated users with at least one live connection. */
    onlineUsers: number;
  };
  counts: {
    users: number;
    bannedUsers: number;
    guilds: number;
    channels: number;
    messages: number;
    messagesLast24h: number;
    activeSessions: number;
  };
  voice: {
    /** Distinct channels with at least one participant. */
    rooms: number;
    /** Total voice participants across all rooms. */
    participants: number;
  };
  scheduledMessages: {
    /** Pending (not failed-out) scheduled messages, future + due. */
    pending: number;
    /** Subset already past their scheduled time and awaiting send. */
    due: number;
  };
  db: {
    ok: boolean;
    latencyMs: number;
  };
  redis: {
    /** Whether REDIS_URL is configured (multi-node bus + shared blacklist). */
    configured: boolean;
    /** Live ping result; null when not configured (in-memory bus). */
    healthy: boolean | null;
  };
  generatedAt: string;
}

export async function gatherMetrics(): Promise<InstanceMetrics> {
  // DB health + latency around a trivial query.
  const dbStart = Date.now();
  let dbOk = true;
  try {
    await db.execute(sql`select 1`);
  } catch {
    dbOk = false;
  }
  const dbLatencyMs = Date.now() - dbStart;

  // All counts in parallel. If the DB is down the select 1 above already
  // flagged it; these would reject and we surface zeros with db.ok=false.
  let counts = {
    users: 0,
    bannedUsers: 0,
    guilds: 0,
    channels: 0,
    messages: 0,
    messagesLast24h: 0,
    activeSessions: 0,
  };
  let voice = { rooms: 0, participants: 0 };
  let scheduledMessages = { pending: 0, due: 0 };

  if (dbOk) {
    const n = (rows: { n: number }[]) => rows[0]?.n ?? 0;
    const [
      users,
      banned,
      guilds,
      channels,
      messages,
      messages24h,
      sessions,
      voiceRow,
      schedRow,
    ] = await Promise.all([
      db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.users).where(isNull(schema.users.deletedAt)),
      db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.users).where(isNotNull(schema.users.bannedAt)),
      db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.guilds).where(isNull(schema.guilds.deletedAt)),
      db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.channels).where(isNull(schema.channels.deletedAt)),
      db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.messages).where(isNull(schema.messages.deletedAt)),
      db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(schema.messages)
        .where(and(isNull(schema.messages.deletedAt), gt(schema.messages.createdAt, sql`NOW() - INTERVAL '24 hours'`))),
      db
        .select({ n: sql<number>`COUNT(*)::int` })
        .from(schema.sessions)
        .where(and(isNull(schema.sessions.revokedAt), gt(schema.sessions.expiresAt, sql`NOW()`))),
      db
        .select({
          rooms: sql<number>`COUNT(DISTINCT ${schema.voiceStates.channelId})::int`,
          participants: sql<number>`COUNT(*)::int`,
        })
        .from(schema.voiceStates),
      db
        .select({
          pending: sql<number>`COUNT(*) FILTER (WHERE ${schema.scheduledMessages.attempts} < 3)::int`,
          due: sql<number>`COUNT(*) FILTER (WHERE ${schema.scheduledMessages.attempts} < 3 AND ${schema.scheduledMessages.scheduledFor} <= NOW())::int`,
        })
        .from(schema.scheduledMessages),
    ]);
    counts = {
      users: n(users),
      bannedUsers: n(banned),
      guilds: n(guilds),
      channels: n(channels),
      messages: n(messages),
      messagesLast24h: n(messages24h),
      activeSessions: n(sessions),
    };
    voice = {
      rooms: voiceRow[0]?.rooms ?? 0,
      participants: voiceRow[0]?.participants ?? 0,
    };
    scheduledMessages = {
      pending: schedRow[0]?.pending ?? 0,
      due: schedRow[0]?.due ?? 0,
    };
  }

  // Redis: configured = env present; healthy = a bounded live ping IF the
  // active bus is the Redis bus. In-memory bus → healthy stays null.
  const redisConfigured = !!env.REDIS_URL;
  let redisHealthy: boolean | null = null;
  if (redisConfigured) {
    const bus = eventBus();
    redisHealthy = bus instanceof RedisEventBus ? await bus.health() : null;
  }

  return {
    process: {
      uptimeSeconds: Math.round(process.uptime()),
      workerId: env.WORKER_ID,
      nodeEnv: env.NODE_ENV,
    },
    gateway: {
      connections: registry.connectionCount,
      onlineUsers: registry.userCount,
    },
    counts,
    voice,
    scheduledMessages,
    db: { ok: dbOk, latencyMs: dbLatencyMs },
    redis: { configured: redisConfigured, healthy: redisHealthy },
    generatedAt: new Date().toISOString(),
  };
}

/**
 * Render metrics as Prometheus text exposition (v0.0.4). Flat gauges with a
 * common `zekktris_` prefix; booleans become 0/1, null redis-health is omitted
 * (a missing series reads as "not applicable" to Prometheus). No labels — this
 * is a single-instance exporter; aggregate across replicas with the `instance`
 * label Prometheus adds at scrape time.
 */
export function toPrometheus(m: InstanceMetrics): string {
  const lines: string[] = [];
  const g = (name: string, help: string, value: number) => {
    lines.push(`# HELP zekktris_${name} ${help}`);
    lines.push(`# TYPE zekktris_${name} gauge`);
    lines.push(`zekktris_${name} ${value}`);
  };
  g('uptime_seconds', 'Process uptime in seconds.', m.process.uptimeSeconds);
  g('gateway_connections', 'Open gateway WebSocket connections.', m.gateway.connections);
  g('gateway_online_users', 'Distinct users with a live connection.', m.gateway.onlineUsers);
  g('users_total', 'Non-deleted user accounts.', m.counts.users);
  g('users_banned', 'Banned user accounts.', m.counts.bannedUsers);
  g('guilds_total', 'Non-deleted guilds.', m.counts.guilds);
  g('channels_total', 'Non-deleted channels.', m.counts.channels);
  g('messages_total', 'Non-deleted messages.', m.counts.messages);
  g('messages_last_24h', 'Messages created in the last 24h.', m.counts.messagesLast24h);
  g('active_sessions', 'Unexpired, unrevoked sessions.', m.counts.activeSessions);
  g('voice_rooms', 'Channels with at least one voice participant.', m.voice.rooms);
  g('voice_participants', 'Total voice participants.', m.voice.participants);
  g('scheduled_messages_pending', 'Pending scheduled messages.', m.scheduledMessages.pending);
  g('scheduled_messages_due', 'Scheduled messages past their send time.', m.scheduledMessages.due);
  g('db_up', 'Database reachable (1/0).', m.db.ok ? 1 : 0);
  g('db_latency_ms', 'Latency of a trivial DB query, ms.', m.db.latencyMs);
  g('redis_configured', 'REDIS_URL is set (1/0).', m.redis.configured ? 1 : 0);
  if (m.redis.healthy !== null) {
    g('redis_up', 'Redis ping succeeded (1/0).', m.redis.healthy ? 1 : 0);
  }
  return lines.join('\n') + '\n';
}
