/**
 * Admin routes
 * ------------
 * Instance-staff endpoints. Gated by `requireStaff` (users.is_admin OR
 * users.is_moderator); moderators are further path-restricted to an
 * explicit allowlist below. Designed for the self-hosted operator
 * use case: see who's on the instance, what's growing in size, and
 * have a way to act on bad actors.
 *
 * Endpoints:
 *   GET    /api/v1/admin/stats           system stats (counts + recent activity)
 *   GET    /api/v1/admin/users           list users (paginated, searchable)
 *   POST   /api/v1/admin/users/:id/ban   soft-ban a user (sets banned_at, revokes all sessions)
 *   POST   /api/v1/admin/users/:id/unban undo a soft-ban
 *   POST   /api/v1/admin/users/:id/role  set instance role (administrator/moderator/none)
 *   GET    /api/v1/admin/guilds          list all guilds with member counts
 *   GET    /api/v1/admin/storage         disk usage breakdown
 *
 * Permission model: NOT per-guild — these are server-operator
 * actions. The is_admin flag should be set by the operator directly
 * via SQL (`UPDATE users SET is_admin=true WHERE id=...`) for the
 * bootstrap admin; the role endpoint handles subsequent promotions.
 *
 * Every staff action lands in the security_events audit log (see
 * auditStaff below) so admins/moderators leave a reviewable trail.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { validate } from '../lib/validate';
import { requireAuth, requireStaff, requireUserId, staffIsAdmin } from '../auth/middleware';
import { revokeAllUserSessions } from '../auth/sessions';
import * as voice from '../services/voice';
import * as dispatch from '../gateway/dispatch';
import { leftVoiceStateDTO, toAttachment } from '../lib/dto';
import { registry } from '../gateway/registry';
import {
  listStorageItems,
  deleteStorageItem,
  compressStorageItem,
  runAttachmentGcSweep,
} from '../services/uploads';
import { logEvent, type SecurityEventKind } from '../services/security';

export const adminRouter = new Hono();

// ── Staff gate + moderator allowlist ────────────────────────────────────────
//
// All routes require auth + staff (admin OR moderator). Moderators are then
// path-restricted to an explicit allowlist — anything not listed is
// admin-only, so a new endpoint added tomorrow is FAIL-SAFE (admin-only)
// until someone deliberately opens it to moderators.
//
// Moderator scope (per operator spec): security log (read), ban/unban,
// force sign-out, membership VIEW (in the user list), DOB reset, and observing
// servers (peek) — but NOT deleting them. Anything monetization-related
// (gifting/removing memberships, the monetization config) is admin-only.
const MODERATOR_ALLOWED: { method: string; pattern: RegExp }[] = [
  { method: 'GET', pattern: /^\/users$/ },
  { method: 'POST', pattern: /^\/users\/[0-9]+\/(ban|unban|logout|reset-dob-lock)$/ },
  { method: 'GET', pattern: /^\/guilds$/ },
  { method: 'GET', pattern: /^\/guilds\/[0-9]+\/peek$/ },
  { method: 'GET', pattern: /^\/channels\/[0-9]+\/peek\/messages$/ },
  { method: 'GET', pattern: /^\/security\/events$/ },
];
// Deliberately absent from the list above: /voice-live. It discloses that a
// specific DM channel has a live call AND both participants' identities, which
// is strictly more than a moderator's chartered scope (security log, ban, peek
// PUBLIC guild channels). Admin-only is the decision, not an oversight — don't
// "fix" it by adding it here.

adminRouter.use('*', requireAuth, requireStaff, async (c, next) => {
  if (!staffIsAdmin(c)) {
    // Hono strips the router mount prefix, so c.req.path is the full URL
    // path — normalize to router-relative before matching the allowlist.
    const path = c.req.path.replace(/^\/api\/v1\/admin/, '') || '/';
    const ok = MODERATOR_ALLOWED.some(
      (r) => r.method === c.req.method && r.pattern.test(path),
    );
    if (!ok) throw errors.forbidden('Instance admin required');
  }
  await next();
});

// ── Staff audit log ─────────────────────────────────────────────────────────
// Every admin/moderator action lands in the security_events log the Security
// tab displays. Best-effort: a logging failure must never abort the action
// itself (the ban/gift/etc. already landed), so errors are printed, not
// thrown.
async function auditStaff(
  c: import('hono').Context,
  kind: SecurityEventKind,
  detail: string,
  target?: { userId?: bigint | null; guildId?: bigint | null },
) {
  try {
    await logEvent({
      kind,
      userId: target?.userId ?? null,
      actorId: requireUserId(c),
      guildId: target?.guildId ?? null,
      channelId: null,
      detail,
    });
  } catch (err) {
    console.error('[admin] staff audit log failed:', err);
  }
}

// ── Audit throttle for polled read-only views ───────────────────────────────
//
// The live voice monitor is polled (optionally every 10s) rather than clicked,
// so a naive auditStaff call would write ~360 rows an hour per open tab and
// bury every real staff action in the Security log. One row per admin per
// window preserves the "an admin looked at live call state, here's when"
// signal without the flood. Module-local and per-process: at worst a
// multi-worker deploy writes one row per worker, which is still bounded.
const VOICE_LIVE_AUDIT_WINDOW_MS = 10 * 60 * 1000;
const voiceLiveAuditAt = new Map<bigint, number>();

function shouldAuditVoiceLive(userId: bigint): boolean {
  const now = Date.now();
  // Prune on write so an admin who never comes back doesn't linger forever.
  for (const [id, at] of voiceLiveAuditAt) {
    if (now - at > VOICE_LIVE_AUDIT_WINDOW_MS) voiceLiveAuditAt.delete(id);
  }
  const last = voiceLiveAuditAt.get(userId);
  if (last !== undefined && now - last < VOICE_LIVE_AUDIT_WINDOW_MS) return false;
  voiceLiveAuditAt.set(userId, now);
  return true;
}

/**
 * Moderators may not ban/unban/sign-out other staff — that would let a
 * moderator lock out the admins who supervise them. Admin callers pass
 * unconditionally (admins CAN act on each other, by design).
 */
async function assertModCanTouch(c: import('hono').Context, targetId: bigint) {
  if (staffIsAdmin(c)) return;
  const rows = await db
    .select({ isAdmin: schema.users.isAdmin, isModerator: schema.users.isModerator })
    .from(schema.users)
    .where(eq(schema.users.id, targetId))
    .limit(1);
  const t = rows[0];
  if (t && (t.isAdmin || t.isModerator)) {
    throw errors.forbidden('Moderators cannot act on staff accounts');
  }
}

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/stats — high-level instance health
// ───────────────────────────────────────────────────────────────────────────

adminRouter.get('/stats', async (c) => {
  // Counts in parallel — each is a single COUNT(*) so the round trip
  // dominates and parallelizing matters less than not adding more
  // queries. Returning a flat object keeps the client render simple.
  const [
    userCountRow,
    bannedUserCountRow,
    guildCountRow,
    channelCountRow,
    messageCountRow,
    messagesLast24hRow,
    sessionsCountRow,
  ] = await Promise.all([
    db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.users).where(isNull(schema.users.deletedAt)),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.users)
      .where(isNotNull(schema.users.bannedAt)),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.guilds).where(isNull(schema.guilds.deletedAt)),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.channels).where(isNull(schema.channels.deletedAt)),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.messages).where(isNull(schema.messages.deletedAt)),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.messages)
      .where(
        and(
          isNull(schema.messages.deletedAt),
          gt(schema.messages.createdAt, sql`NOW() - INTERVAL '24 hours'`),
        ),
      ),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.sessions)
      .where(
        and(
          isNull(schema.sessions.revokedAt),
          gt(schema.sessions.expiresAt, sql`NOW()`),
        ),
      ),
  ]);

  return c.json({
    stats: {
      users: {
        total: userCountRow[0]?.n ?? 0,
        banned: bannedUserCountRow[0]?.n ?? 0,
      },
      guilds: guildCountRow[0]?.n ?? 0,
      channels: channelCountRow[0]?.n ?? 0,
      messages: {
        total: messageCountRow[0]?.n ?? 0,
        last24h: messagesLast24hRow[0]?.n ?? 0,
      },
      // Proxy for "currently active users" — count of unexpired,
      // unrevoked sessions. Not exact (one user can have many
      // sessions across devices) but tracks well enough for a
      // dashboard-style health glance.
      activeSessions: sessionsCountRow[0]?.n ?? 0,
      generatedAt: new Date().toISOString(),
    },
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/metrics — operational/runtime observability (instance-admin only)
// ───────────────────────────────────────────────────────────────────────────
//
// Distinct from /stats (DB count aggregates): this surfaces live runtime
// signals an operator watches — gateway connections, uptime, voice occupancy,
// scheduled-send backlog, and DB/Redis health — cheap enough to poll. JSON for
// the admin dashboard; the same numbers are also exposed as Prometheus text at
// GET /metrics (opt-in via METRICS_TOKEN). No secrets are included.
adminRouter.get('/metrics', async (c) => {
  const { gatherMetrics } = await import('../services/metrics');
  return c.json({ metrics: await gatherMetrics() });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/voice-diagnostic — end-to-end LiveKit config check (admin only)
// ───────────────────────────────────────────────────────────────────────────
//
// Tests the instance's LiveKit setup (keys present, browser URL resolvable,
// token minting, and — the #1 self-host gotcha — whether the API can actually
// reach the SFU's signaling/control API with the configured credentials).
// Returns a clear pass/fail per step. Hits the network (listRooms with a
// timeout), so it's a run-on-demand check, not part of the metrics poll. No
// secrets are returned — only config URLs and classified error guidance.
adminRouter.get('/voice-diagnostic', async (c) => {
  const { diagnoseLivekit } = await import('../services/livekitDiagnostic');
  return c.json({ diagnostic: await diagnoseLivekit() });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/voice-live — live LiveKit occupancy + app/SFU reconciliation
// ───────────────────────────────────────────────────────────────────────────
//
// "Who is in voice right now, on what, and is anything obviously broken."
// Sibling of /voice-diagnostic (which answers "is voice CONFIGURED right"):
// this fans out to the SFU (listRooms + listParticipants per room) under a
// hard wall-clock budget, resolves identities and channel names in two batched
// DB queries, and diffs LiveKit's ground truth against our own voice_states
// rows. That ghost/orphan diff is the signal — it makes the dropped-call and
// zombie-participant class visible without a psql session.
//
// Always 200: an unreachable or unconfigured SFU is reported IN the payload
// (status/error) so the panel renders classified guidance instead of a generic
// request failure. No secrets — the SFU URL is redacted of userinfo, TURN
// passwords never leave the service, and participant `region` (coarse user
// geolocation) is deliberately not collected.
//
// Safe to poll at ~10s: the service shares one in-flight build with every
// concurrent caller for as long as it runs, then reuses the finished snapshot
// for a short cool-down. Several admins watching at once — including while the
// SFU is slow, which is when they all will be — still produce one fan-out.
adminRouter.get('/voice-live', async (c) => {
  const { getLiveVoice } = await import('../services/livekitLive');
  const live = await getLiveVoice();
  // One audit row per admin per 10-minute window, not per poll — same reasoning
  // as the per-observe-session row at the guild peek endpoint below. This
  // endpoint discloses that specific DM channels have live calls, and who is on
  // them, so the access itself has to be auditable; logging every 10s tick
  // would drown the security log and make the trail useless.
  if (shouldAuditVoiceLive(requireUserId(c))) {
    await auditStaff(c, 'staff_observe', 'Viewed the live voice monitor');
  }
  return c.json({ live });
});

// ───────────────────────────────────────────────────────────────────────────
// Instance backup / restore (instance-admin only)
// ───────────────────────────────────────────────────────────────────────────
//
// GET  /admin/backup?includeImages=true|false  → bundle every guild's config
//   backup into one downloadable JSON document. Reuses the per-guild backup
//   format verbatim. CONFIGURATION only (settings/roles/channels/overrides/
//   branding) — not a data dump (users/messages live in pg_dump).
// POST /admin/backup/restore  → rebuild each guild in the bundle as a NEW guild
//   owned by the restoring admin. Per-guild best-effort; returns the results.
adminRouter.get(
  '/backup',
  validate('query', z.object({ includeImages: z.coerce.boolean().optional() })),
  async (c) => {
    const { exportInstance } = await import('../services/instanceBackup');
    const includeImages = c.req.valid('query').includeImages ?? true;
    return c.json({ backup: await exportInstance({ includeImages }) });
  },
);

// GET /admin/backups → what the host's cron has actually produced.
//
// Reporting only. Taking a backup needs the host (pg_dump against the db
// container, plus the uploads tree), and handing this process the Docker
// socket to reach them would put a root-equivalent handle on the host behind
// an HTTP endpoint. The directory is mounted read-only, so this cannot delete
// a bundle either.
//
// Deliberately NOT a download: a full bundle is over a gigabyte here, and
// streaming that through an admin's browser is a bad experience and a memory
// hazard in the container. What an admin needs to see is whether backups are
// happening at all — the gap that went unnoticed for months.
adminRouter.get('/backups', async (c) => {
  const { readBackupStatus } = await import('../services/backupSnapshots');
  return c.json(await readBackupStatus());
});

adminRouter.post('/backup/restore', async (c) => {
  const userId = requireUserId(c);
  // The bundle can be large (many guilds, embedded images); read it raw and
  // let the service validate the envelope + each guild backup.
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    throw errors.badRequest('Request body must be a JSON instance backup');
  }
  const { importInstance } = await import('../services/instanceBackup');
  const result = await importInstance(userId, body);
  return c.json(result);
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/users — paginated user list with optional search
// ───────────────────────────────────────────────────────────────────────────
//
// Search: case-insensitive partial match on username OR display name
// OR email. Returns admins-and-banned-included by default; filter via
// query params if needed. Hard-capped at 50 per page; client cursors
// via `before` (a user id — lower ids are older accounts).

const listUsersQuery = z.object({
  q: z.string().max(100).optional(),
  before: z.string().regex(/^[0-9]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  /** Filter to banned users only. Useful for moderation review. */
  bannedOnly: z.coerce.boolean().optional(),
});

adminRouter.get('/users', validate('query', listUsersQuery), async (c) => {
  const q = c.req.valid('query');
  const conds = [isNull(schema.users.deletedAt)];
  if (q.before) conds.push(sql`${schema.users.id} < ${BigInt(q.before)}`);
  if (q.bannedOnly) conds.push(isNotNull(schema.users.bannedAt));
  if (q.q && q.q.trim().length > 0) {
    const pattern = `%${q.q.trim()}%`;
    conds.push(
      or(
        ilike(schema.users.username, pattern),
        ilike(schema.users.displayName, pattern),
        ilike(schema.users.email, pattern),
      )!,
    );
  }

  const rows = await db
    .select({
      id: schema.users.id,
      username: schema.users.username,
      displayName: schema.users.displayName,
      email: schema.users.email,
      avatarUrl: schema.users.avatarUrl,
      isAdmin: schema.users.isAdmin,
      isModerator: schema.users.isModerator,
      dateOfBirth: schema.users.dateOfBirth,
      bannedAt: schema.users.bannedAt,
      bannedUntil: schema.users.bannedUntil,
      createdAt: schema.users.createdAt,
    })
    .from(schema.users)
    .where(and(...conds))
    .orderBy(desc(schema.users.id))
    .limit(q.limit ?? 25);

  // "Last online" — most recent session activity per user.
  // sessions.lastUsedAt is notNull/defaultNow and bumped on token
  // use/refresh, so MAX(lastUsedAt) is a reliable last-active proxy.
  // Done as a separate aggregate query (with an explicit alias) rather
  // than a correlated subquery, which didn't map back reliably.
  const seenMap = new Map<string, string>();
  const ids = rows.map((r) => r.id);
  if (ids.length > 0) {
    const seen = await db
      .select({
        userId: schema.sessions.userId,
        last: sql<string>`MAX(${schema.sessions.lastUsedAt})`.as('last'),
      })
      .from(schema.sessions)
      .where(inArray(schema.sessions.userId, ids))
      .groupBy(schema.sessions.userId);
    for (const s of seen) {
      if (s.last) seenMap.set(s.userId.toString(), new Date(s.last).toISOString());
    }
  }

  // Supporter memberships for the page (own rows only — inherited/family
  // pass-down is a read-time entitlement, not an admin-managed row).
  const subMap = new Map<string, { tier: string; expiresAt: string | null }>();
  if (ids.length > 0) {
    const subRows = await db
      .select()
      .from(schema.subscriptions)
      .where(inArray(schema.subscriptions.userId, ids));
    const now = Date.now();
    for (const s of subRows) {
      if (s.expiresAt && s.expiresAt.getTime() <= now) continue; // expired → not a member
      subMap.set(s.userId.toString(), {
        tier: s.tier,
        expiresAt: s.expiresAt?.toISOString() ?? null,
      });
    }
  }

  return c.json({
    users: rows.map((r) => ({
      id: r.id.toString(),
      username: r.username,
      displayName: r.displayName,
      email: r.email,
      avatarUrl: r.avatarUrl,
      isAdmin: r.isAdmin,
      isModerator: r.isModerator,
      dateOfBirth: r.dateOfBirth ?? null,
      bannedAt: r.bannedAt?.toISOString() ?? null,
      bannedUntil: r.bannedUntil?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: seenMap.get(r.id.toString()) ?? null,
      subscriptionTier: subMap.get(r.id.toString())?.tier ?? null,
      subscriptionExpiresAt: subMap.get(r.id.toString())?.expiresAt ?? null,
    })),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/users/:id/ban  + /unban  — soft-ban toggle
// ───────────────────────────────────────────────────────────────────────────
//
// Ban sets banned_at and revokes all sessions for an immediate boot.
// Unban clears banned_at; the user can sign in again on their next
// auth attempt.
//
// Self-protection: an admin can't ban themselves (would lock the
// instance if it's the only admin). Other admins CAN ban each other
// — by design; if you've trusted two admins, they can co-moderate.

const userIdParam = z.object({ id: z.string().regex(/^[0-9]+$/) });

const banBody = z.object({ duration: z.enum(['1m', '3m', '6m', 'perm']).optional() });

adminRouter.post(
  '/users/:id/ban',
  validate('param', userIdParam),
  validate('json', banBody),
  async (c) => {
  const selfId = requireUserId(c);
  const targetId = BigInt(c.req.valid('param').id);
  if (targetId === selfId) {
    throw errors.badRequest('You cannot ban yourself');
  }
  await assertModCanTouch(c, targetId);
  // Duration: 1/3/6 months or permanent (default). banExpiryFor returns null
  // for 'perm'. Covers text AND voice — sessions revoked + voice evicted below.
  const { banExpiryFor } = await import('../services/instanceBans');
  const duration = c.req.valid('json').duration ?? 'perm';
  const bannedUntil = banExpiryFor(duration);
  await db
    .update(schema.users)
    .set({ bannedAt: new Date(), bannedUntil, updatedAt: new Date() })
    .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)));
  await auditStaff(
    c,
    'staff_ban',
    duration === 'perm'
      ? 'Banned account (permanent)'
      : `Banned account (${duration}, until ${bannedUntil?.toISOString()})`,
    { userId: targetId },
  );
  // Force immediate logout across all devices. Token-level revocation
  // is up to 15 min lagged for currently-issued access tokens; this
  // additionally prevents refresh, so the lag is the worst case for
  // REST requests.
  await revokeAllUserSessions(targetId);

  // Voice eviction. Instance ban is more sweeping than the guild-level
  // ban handled in routes/guilds.ts (fix #20), so the unscoped variant
  // (evictFromAllVoice) is what we want — kick from whatever voice
  // channel they happen to be in across every guild. If they weren't
  // in voice, this is a no-op. The LiveKit RemoveParticipant call is
  // best-effort inside the helper so a SFU outage doesn't prevent
  // the ban from landing.
  const priorVoice = await voice.evictFromAllVoice(targetId);
  if (priorVoice) {
    dispatch.voiceStateUpdate({
      guildId: priorVoice.guildId,
      channelId: priorVoice.channelId,
      voiceState: leftVoiceStateDTO({
        userId: targetId,
        guildId: priorVoice.guildId,
        channelId: priorVoice.channelId,
      }),
    });
  }

  // Delete every push subscription this user has. The FK from
  // push_subscriptions to users cascades only on hard delete; since
  // we soft-delete (bannedAt only), the cascade doesn't fire and the
  // banned user would keep receiving DM notifications on their
  // device (push fanout in DMs doesn't filter by bannedAt — it goes
  // to every recipient). The notification can't be acted on (session
  // is revoked above) but still pops, which is unsettling. Best-
  // effort: a transient DB error here doesn't abort the ban — the
  // session revoke + voice eviction already landed.
  try {
    await db
      .delete(schema.pushSubscriptions)
      .where(eq(schema.pushSubscriptions.userId, targetId));
  } catch {
    // Best-effort.
  }

  // Force-close every open gateway connection for this user so they
  // can't keep reading messages on the still-open WebSocket with a
  // not-yet-expired access token. This fans out ACROSS NODES: the
  // gateway only re-checks ban state at IDENTIFY/RESUME, so a socket
  // held by another replica would otherwise keep receiving live
  // dispatches until it drops. Each connection's own close handler
  // fires onUserFullyDisconnected which sets users.status='offline'
  // and broadcasts presence — same path as the disconnect-beacon
  // endpoint uses. We DON'T need to manually broadcast presence
  // here; the close cascade handles it.
  dispatch.forceDisconnectUser(targetId);

  return c.json({ ok: true });
  },
);

adminRouter.post('/users/:id/unban', validate('param', userIdParam), async (c) => {
  const targetId = BigInt(c.req.valid('param').id);
  await assertModCanTouch(c, targetId);
  await db
    .update(schema.users)
    .set({ bannedAt: null, bannedUntil: null, updatedAt: new Date() })
    .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)));
  await auditStaff(c, 'staff_unban', 'Unbanned account', { userId: targetId });
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /admin/users/:id — permanently delete an account
// ───────────────────────────────────────────────────────────────────────────
//
// Hard-deletes the user row; FK cascades remove their dependent data,
// same path as the inactivity sweep. Distinct from ban (which only
// disables). Guards:
//   - can't delete yourself (would risk locking out the instance)
//   - can't delete the owner of an ACTIVE guild — guilds.owner_id is ON
//     DELETE RESTRICT, so the delete would fail anyway; we detect it first
//     and return a clear message telling the operator to transfer or
//     delete those guilds. Servers the user already soft-deleted don't
//     count (they're purged first, below).
// Sessions are revoked and live gateway sockets closed before the row
// goes, so the account can't keep operating mid-delete.

adminRouter.delete('/users/:id', validate('param', userIdParam), async (c) => {
  const selfId = requireUserId(c);
  const targetId = BigInt(c.req.valid('param').id);
  if (targetId === selfId) {
    throw errors.badRequest('You cannot delete your own account from here');
  }

  // Guild-owner check — clearer than surfacing a raw FK violation.
  // Only ACTIVE (non-soft-deleted) guilds block deletion: a server the user
  // already deleted is gone from their perspective and shouldn't trap their
  // account. Soft-deleted guilds still hold an owner_id row, though, and
  // guilds.owner_id is ON DELETE RESTRICT — so we hard-delete those orphaned
  // rows below before removing the user, or the delete would FK-fail.
  const ownedActive = await db
    .select({ id: schema.guilds.id })
    .from(schema.guilds)
    .where(and(eq(schema.guilds.ownerId, targetId), isNull(schema.guilds.deletedAt)))
    .limit(1);
  if (ownedActive.length > 0) {
    throw errors.badRequest(
      'This user owns one or more servers. Transfer or delete those servers first.',
    );
  }

  // Purge any servers the user already soft-deleted. Child rows (channels,
  // members, roles, …) cascade off guilds.id, so this clears the owner_id
  // RESTRICT reference that would otherwise block the account delete.
  await db
    .delete(schema.guilds)
    .where(and(eq(schema.guilds.ownerId, targetId), isNotNull(schema.guilds.deletedAt)));

  // Boot them before the row disappears.
  await revokeAllUserSessions(targetId);
  for (const conn of registry.byUserId(targetId)) {
    try {
      conn.close(4004, 'account deleted');
    } catch {
      // already closing
    }
  }

  const deleted = await db
    .delete(schema.users)
    .where(eq(schema.users.id, targetId))
    .returning({ id: schema.users.id, username: schema.users.username });

  if (deleted.length === 0) throw errors.notFound('User');
  // The user row is gone, so user_id can't reference it — the who/what
  // lives in the detail text instead.
  await auditStaff(
    c,
    'staff_user_delete',
    `Deleted account @${deleted[0]!.username} (${targetId})`,
  );
  return c.json({ deleted: true });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/users/:id/role — set instance role (admin-only)
// ───────────────────────────────────────────────────────────────────────────
// Three-state: administrator | moderator | none. The two flags are mutually
// exclusive — promoting to one clears the other. Moderators can't reach this
// endpoint at all (not on the allowlist), so only admins hand out roles.

const setRoleBody = z.object({ role: z.enum(['administrator', 'moderator', 'none']) });

adminRouter.post(
  '/users/:id/role',
  validate('param', userIdParam),
  validate('json', setRoleBody),
  async (c) => {
    const selfId = requireUserId(c);
    const targetId = BigInt(c.req.valid('param').id);
    const { role } = c.req.valid('json');
    if (targetId === selfId && role !== 'administrator') {
      throw errors.badRequest('You cannot demote yourself');
    }
    await db
      .update(schema.users)
      .set({
        isAdmin: role === 'administrator',
        isModerator: role === 'moderator',
        updatedAt: new Date(),
      })
      .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)));
    await auditStaff(c, 'staff_role_change', `Set instance role to ${role}`, {
      userId: targetId,
    });
    return c.json({ ok: true });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/users/:id/reset-dob-lock — allow the user one more DOB change
// ───────────────────────────────────────────────────────────────────────────
// Unlocks a user's date of birth so they can self-correct it once more (it
// re-locks after they do). Used when someone entered a wrong age at signup, or
// to re-open a legacy account's one-time correction.
adminRouter.post('/users/:id/reset-dob-lock', validate('param', userIdParam), async (c) => {
  const targetId = BigInt(c.req.valid('param').id);
  // A moderator can't clear a fellow-staff account's DOB lock (mirrors the
  // ban/unban/logout guard — moderators may not act on admins/moderators).
  await assertModCanTouch(c, targetId);
  await db
    .update(schema.users)
    .set({ dobLocked: false, updatedAt: new Date() })
    .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)));
  await auditStaff(c, 'staff_dob_reset', 'Unlocked date of birth for one change', {
    userId: targetId,
  });
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────────────────
// Supporter memberships — admin gift / reset
// ───────────────────────────────────────────────────────────────────────────
// Gift: grant (or re-grant — overwrite) a tier for 1/3/6 months or forever.
// Reset: remove the membership and clear the paid cosmetics (avatar frame +
// clan tag) — the hard lock. A supervising parent's membership still passes
// down to their children regardless of the child's own row.
const giftSubscriptionBody = z.object({
  tier: z.enum(['scout', 'guardian', 'legend']),
  duration: z.enum(['1m', '3m', '6m', 'forever']),
});

adminRouter.post(
  '/users/:id/subscription',
  validate('param', userIdParam),
  validate('json', giftSubscriptionBody),
  async (c) => {
    const selfId = requireUserId(c);
    const targetId = BigInt(c.req.valid('param').id);
    const { tier, duration } = c.req.valid('json');
    // Gifting is admin-only (not in MODERATOR_ALLOWED), so only admins reach
    // here — no duration cap. assertModCanTouch stays as defense-in-depth in
    // case the allowlist is ever widened to admit moderators again.
    await assertModCanTouch(c, targetId);
    const subs = await import('../services/subscriptions');
    const row = await subs.giftSubscription(selfId, targetId, tier, duration);
    await auditStaff(c, 'staff_gift', `Gifted ${tier} membership (${duration})`, {
      userId: targetId,
    });
    return c.json({
      ok: true,
      subscription: { tier: row.tier, expiresAt: row.expiresAt?.toISOString() ?? null },
    });
  },
);

adminRouter.delete('/users/:id/subscription', validate('param', userIdParam), async (c) => {
  const targetId = BigInt(c.req.valid('param').id);
  const subs = await import('../services/subscriptions');
  await subs.removeSubscription(targetId);
  await auditStaff(c, 'staff_membership_reset', 'Reset membership (removed tier)', {
    userId: targetId,
  });
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────────────────
// PUT /admin/monetization — which tier unlocks each paid surface
// ───────────────────────────────────────────────────────────────────────────
// ADMIN ONLY: deliberately NOT on the moderator allowlist (fail-safe default)
// — repricing the instance's paywalls is an operator decision, and a
// moderator must not be able to zero out the caps/gates. Accepts a full or
// partial config; only the provided leaves are written. The read side for
// clients is GET /api/v1/instance/monetization (any authed user).
const monetizeTier = z.enum(['none', 'scout', 'guardian', 'legend']);
const qualityMatrixBody = z
  .object({
    p1080: monetizeTier.optional(),
    k2: monetizeTier.optional(),
    k4: monetizeTier.optional(),
  })
  .strict();
const putMonetizationBody = z.object({
  config: z
    .object({
      stream: qualityMatrixBody.optional(),
      camera: qualityMatrixBody.optional(),
      appearance: monetizeTier.optional(),
      // Integer MB caps; null clears the override back to the env default.
      // The env MAX_UPLOAD_SIZE_MB remains the hard ceiling regardless.
      uploadCapsMb: z
        .object({
          free: z.number().int().min(1).max(10_000).nullable().optional(),
          scout: z.number().int().min(1).max(10_000).nullable().optional(),
          guardian: z.number().int().min(1).max(10_000).nullable().optional(),
          legend: z.number().int().min(1).max(10_000).nullable().optional(),
        })
        .strict()
        .optional(),
    })
    .strict(),
});

adminRouter.put('/monetization', validate('json', putMonetizationBody), async (c) => {
  const { config: patch } = c.req.valid('json');
  const monetization = await import('../services/monetization');
  const changedKeys = await monetization.saveConfig(patch);
  await auditStaff(
    c,
    'staff_monetization',
    `Updated monetization settings (${changedKeys.length ? changedKeys.join(', ') : 'no changes'})`,
  );
  const config = await monetization.getConfig();
  return c.json({ config });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/guilds — all guilds with member counts
// ───────────────────────────────────────────────────────────────────────────

const listGuildsQuery = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

/**
 * ADMIN ONLY — a user's 1:1 DM correspondents, with friend status and how many
 * messages that conversation holds.
 *
 * Deliberately NOT on MODERATOR_ALLOWED. The allowlist is fail-safe (anything
 * unlisted is admin-only), so this is admin-gated by construction — but say it
 * out loud, because the capability is "see who this person privately messages",
 * which is well outside a moderator's chartered scope and is exactly the kind of
 * endpoint someone might later "fix" by adding to the list. Don't.
 *
 * NEVER returns message content — counts, identity and friend status only. Most
 * DMs here are E2EE and the server could not read them anyway; there is no code
 * path in this handler that touches message bodies.
 *
 * Cost: four bounded queries regardless of how many conversations the user has —
 * their DM channel ids, the other participant of each, one grouped COUNT over
 * `messages_channel_time_idx`, and one friend lookup. No per-conversation query.
 * Capped at MAX_DM_PEERS channels, ordered by most recent activity, so a user
 * with thousands of DMs cannot turn this into a table scan.
 */
const MAX_DM_PEERS = 200;

adminRouter.get(
  '/users/:id/dm-peers',
  validate('param', userIdParam),
  async (c) => {
    const targetId = BigInt(c.req.valid('param').id);

    // 1. The user's 1:1 DM channels (group DMs excluded — "who do they talk to"
    //    is a pairwise question, and a group's members are not correspondents).
    const myChannels = await db
      .select({ channelId: schema.dmRecipients.channelId })
      .from(schema.dmRecipients)
      .innerJoin(schema.channels, eq(schema.channels.id, schema.dmRecipients.channelId))
      .where(and(eq(schema.dmRecipients.userId, targetId), eq(schema.channels.type, 'dm')))
      .orderBy(desc(schema.dmRecipients.channelId))
      .limit(MAX_DM_PEERS);
    const channelIds = myChannels.map((r) => r.channelId);
    if (channelIds.length === 0) {
      await auditStaff(c, 'staff_dm_peers' as SecurityEventKind, 'viewed DM correspondents (none)', {
        userId: targetId,
      });
      return c.json({ peers: [], capped: false });
    }

    // 2. The other participant of each of those channels.
    const others = await db
      .select({
        channelId: schema.dmRecipients.channelId,
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
      })
      .from(schema.dmRecipients)
      .innerJoin(schema.users, eq(schema.users.id, schema.dmRecipients.userId))
      .where(
        and(
          inArray(schema.dmRecipients.channelId, channelIds),
          sql`${schema.dmRecipients.userId} <> ${targetId}`,
        ),
      );

    // 3. One grouped count for every channel at once.
    const counts = await db
      .select({
        channelId: schema.messages.channelId,
        n: sql<number>`count(*)::int`.as('n'),
      })
      .from(schema.messages)
      .where(and(inArray(schema.messages.channelId, channelIds), isNull(schema.messages.deletedAt)))
      .groupBy(schema.messages.channelId);
    const countByChannel = new Map(counts.map((r) => [r.channelId.toString(), r.n]));

    // 4. One friend lookup. `relationships` is directional, so a friendship is
    //    the row FROM this user; the reciprocal row exists but reading one
    //    direction is enough and keeps this a single indexed read.
    const friendRows = await db
      .select({ targetId: schema.relationships.targetId })
      .from(schema.relationships)
      .where(and(eq(schema.relationships.userId, targetId), eq(schema.relationships.type, 'friend')));
    const friendIds = new Set(friendRows.map((r) => r.targetId.toString()));

    const peers = others
      .map((o) => ({
        channelId: o.channelId.toString(),
        user: {
          id: o.id.toString(),
          username: o.username,
          displayName: o.displayName,
          avatarUrl: o.avatarUrl,
        },
        isFriend: friendIds.has(o.id.toString()),
        messageCount: countByChannel.get(o.channelId.toString()) ?? 0,
      }))
      .sort((a, b) => b.messageCount - a.messageCount);

    await auditStaff(
      c,
      'staff_dm_peers' as SecurityEventKind,
      `viewed DM correspondents (${peers.length})`,
      { userId: targetId },
    );
    return c.json({ peers, capped: channelIds.length >= MAX_DM_PEERS });
  },
);

adminRouter.get('/guilds', validate('query', listGuildsQuery), async (c) => {
  const q = c.req.valid('query');
  const conds = [isNull(schema.guilds.deletedAt)];
  if (q.q && q.q.trim().length > 0) {
    conds.push(ilike(schema.guilds.name, `%${q.q.trim()}%`));
  }

  const rows = await db
    .select({
      id: schema.guilds.id,
      name: schema.guilds.name,
      iconUrl: schema.guilds.iconUrl,
      ownerId: schema.guilds.ownerId,
      memberCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${schema.guildMembers}
        WHERE ${schema.guildMembers.guildId} = ${schema.guilds.id}
      )`,
      createdAt: schema.guilds.createdAt,
      discoverable: schema.guilds.discoverable,
    })
    .from(schema.guilds)
    .where(and(...conds))
    .orderBy(desc(schema.guilds.createdAt))
    .limit(q.limit ?? 50);

  return c.json({
    guilds: rows.map((r) => ({
      id: r.id.toString(),
      name: r.name,
      iconUrl: r.iconUrl,
      ownerId: r.ownerId.toString(),
      memberCount: r.memberCount,
      createdAt: r.createdAt.toISOString(),
      discoverable: r.discoverable,
    })),
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/storage — disk usage breakdown by upload class
// ───────────────────────────────────────────────────────────────────────────
//
// Aggregates `attachments` table sizes plus head queries on users'
// avatar/banner and guilds' icon/banner (file size is stored on the
// attachment record only — for avatars/icons we approximate at 0
// since they're version-pinned to the request flow that wrote them,
// not the attachment system).
//
// Returns a totals + per-class breakdown the UI renders as a table.

adminRouter.get('/storage', async (c) => {
  const [
    attachSizeRow,
    attachCountRow,
    avatarCountRow,
    bannerCountRow,
    emojiCountRow,
    stickerCountRow,
  ] = await Promise.all([
    db
      .select({ bytes: sql<string>`COALESCE(SUM(${schema.attachments.size})::bigint, 0)::text` })
      .from(schema.attachments),
    db.select({ n: sql<number>`COUNT(*)::int` }).from(schema.attachments),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.users)
      .where(and(isNull(schema.users.deletedAt), isNotNull(schema.users.avatarUrl))),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.users)
      .where(and(isNull(schema.users.deletedAt), isNotNull(schema.users.bannerUrl))),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.guildEmojis),
    db
      .select({ n: sql<number>`COUNT(*)::int` })
      .from(schema.stickers),
  ]);

  // bigint result comes back as a text column to avoid JS precision
  // loss; parse to number knowing the cap is ~9PB for safe integer.
  const attachBytes = Number(attachSizeRow[0]?.bytes ?? '0');

  // Live on-disk totals (actual bytes/files present, with the unused/reclaimable
  // split) from the same scan that powers the file list — so the headline
  // numbers reflect reality and update after deletions, not just DB metadata.
  const disk = await listStorageItems({ page: 1 });

  return c.json({
    storage: {
      attachments: {
        count: attachCountRow[0]?.n ?? 0,
        totalBytes: attachBytes,
      },
      avatars: { count: avatarCountRow[0]?.n ?? 0 },
      banners: { count: bannerCountRow[0]?.n ?? 0 },
      emojis: { count: emojiCountRow[0]?.n ?? 0 },
      stickers: { count: stickerCountRow[0]?.n ?? 0 },
      onDisk: {
        totalBytes: disk.totalBytes,
        totalCount: disk.totalCount,
        unusedBytes: disk.unusedBytes,
        unusedCount: disk.unusedCount,
      },
    },
  });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/storage/items — every stored file with size + usage
// ───────────────────────────────────────────────────────────────────────────
//
// Walks the on-disk upload directory and reports each attachment dir
// with its size, an approximate upload time, and whether it's still
// referenced anywhere in the DB. Unused (orphaned) items are flagged so
// the operator can see — and reclaim — what's not being used.

adminRouter.get('/storage/items', async (c) => {
  const pageRaw = c.req.query('page');
  const page = pageRaw && /^\d+$/.test(pageRaw) ? parseInt(pageRaw, 10) : 1;
  const category = c.req.query('category') as
    | 'attachment' | 'avatar' | 'banner' | 'emoji' | 'sticker' | 'other' | 'unused' | 'all'
    | undefined;
  const sort = c.req.query('sort') === 'recent' ? 'recent' : 'size';
  const q = c.req.query('q') ?? undefined;
  const guildIdRaw = c.req.query('guildId');
  const guildId = guildIdRaw && /^\d+$/.test(guildIdRaw) ? guildIdRaw : undefined;
  const listing = await listStorageItems({ page, category: category ?? 'all', sort, q, guildId });
  return c.json(listing);
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /admin/storage/items/:id — remove a stored file from disk
// ───────────────────────────────────────────────────────────────────────────
//
// Deletes the on-disk bytes for one attachment id. Allowed even when
// the item is still referenced (the operator's call) — the URL will
// 404 afterward. Primarily used to clear orphaned/unused files.

adminRouter.delete('/storage/items/:id', async (c) => {
  const raw = c.req.param('id');
  if (!/^\d+$/.test(raw)) throw errors.badRequest('Invalid storage item id');
  const deleted = await deleteStorageItem(BigInt(raw));
  return c.json({ deleted });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/storage/items/:id/compress — re-compress one image in place
// ───────────────────────────────────────────────────────────────────────────
//
// Downscales + re-encodes the stored image in the same format (URL
// stays valid) to reclaim space. Requires `sharp` on the server; if it
// isn't installed the action returns a clear error and nothing else is
// affected.

adminRouter.post('/storage/items/:id/compress', async (c) => {
  const raw = c.req.param('id');
  if (!/^\d+$/.test(raw)) throw errors.badRequest('Invalid storage item id');
  try {
    const result = await compressStorageItem(BigInt(raw));
    return c.json(result);
  } catch (e) {
    throw errors.badRequest(e instanceof Error ? e.message : 'Compression failed');
  }
});

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/storage/gc — delete all unused files in one sweep
// ───────────────────────────────────────────────────────────────────────────
//
// Runs the same garbage-collection sweep as the periodic background
// job, on demand. Only removes unreferenced files older than the grace
// window. Returns how many dirs were scanned and deleted.

adminRouter.post('/storage/gc', async (c) => {
  const result = await runAttachmentGcSweep();
  return c.json(result);
});
// ───────────────────────────────────────────────────────────────────────────
//
// Different from ban: this signs the user out of every device but
// doesn't mark the account as disabled. They can sign back in on the
// next visit. Useful for "I think this account was phished, force
// re-auth" or "this user changed devices, their old phone is logged
// in and lost." Also closes any open WebSockets so the live session
// stops receiving events immediately (same closing logic as the ban
// path uses — except we use a different close code since this isn't
// a moderation action).

adminRouter.post('/users/:id/logout', validate('param', userIdParam), async (c) => {
  const targetId = BigInt(c.req.valid('param').id);
  await assertModCanTouch(c, targetId);
  await revokeAllUserSessions(targetId);
  // Close live WebSockets so the in-flight session can't keep reading
  // events with a not-yet-expired access token. Without this the
  // forced logout takes up to 15 min (access token TTL) to actually
  // sever the live connection. Use dispatch.forceDisconnectUser (same
  // helper the ban path uses) so the close fans out across every
  // replica via the internal force-disconnect bus — the node-local
  // registry.byUserId loop only reaches sockets held by THIS API
  // replica and silently misses connections on other nodes. It closes
  // with code 4004 (AUTHENTICATION_FAILED); the client surfaces this
  // as "you've been signed out" and falls back to the login screen.
  dispatch.forceDisconnectUser(targetId);
  await auditStaff(c, 'staff_logout', 'Signed out all sessions', { userId: targetId });
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────────────────
// DELETE /admin/guilds/:id — instance-level force-delete
// ───────────────────────────────────────────────────────────────────────────
//
// Distinct from the owner-initiated delete in routes/guilds.ts. The
// admin path skips the ownership check (the operator can delete any
// guild on the instance) and uses the admin's own userId as the
// audit actor.
//
// Soft delete — same mechanism as the owner path. The guild row stays
// in the DB with deleted_at set so audit log queries that join
// through it still work; every list/lookup honors deleted_at. If the
// operator wants to free the disk, the existing data cleanup tooling
// (run-data-cleanup script) handles that.

const guildIdParam = z.object({ id: z.string().regex(/^[0-9]+$/) });

adminRouter.delete('/guilds/:id', validate('param', guildIdParam), async (c) => {
  const adminId = requireUserId(c);
  const guildId = BigInt(c.req.valid('param').id);

  // Capture the member list BEFORE the delete so we can broadcast the
  // GUILD_DELETE event to everyone who was a member. The
  // guildDeletedBroadcast helper needs the member IDs to also strip
  // guild membership from each member's gateway connection snapshot.
  const memberRows = await db
    .select({ userId: schema.guildMembers.userId })
    .from(schema.guildMembers)
    .where(eq(schema.guildMembers.guildId, guildId));

  // Name for the audit trail (soft delete keeps the row, but the log line
  // should read well without a join).
  const nameRows = await db
    .select({ name: schema.guilds.name })
    .from(schema.guilds)
    .where(eq(schema.guilds.id, guildId))
    .limit(1);

  // Evict every user currently in voice within this guild before
  // the delete lands. Without this, LiveKit tokens stay valid up
  // to ~1 hour and participants keep streaming audio in rooms that
  // belong to a guild that no longer exists. Per-user dispatches
  // let each client tear down its local voice UI. Same fix as the
  // owner-delete path in routes/guilds.ts.
  const { evictAllVoiceInGuild } = await import('../services/voice');
  const { leftVoiceStateDTO } = await import('../lib/dto');
  const evicted = await evictAllVoiceInGuild(guildId);

  const { deleteGuild } = await import('../services/guilds');
  await deleteGuild(guildId, adminId);

  const { voiceStateUpdate, guildDeletedBroadcast } = await import('../gateway/dispatch');
  for (const vs of evicted) {
    voiceStateUpdate({
      guildId,
      channelId: vs.channelId,
      voiceState: leftVoiceStateDTO({
        userId: vs.userId,
        guildId,
        channelId: vs.channelId,
      }),
    });
  }
  guildDeletedBroadcast({
    guildId,
    memberIds: memberRows.map((r) => r.userId),
  });

  await auditStaff(
    c,
    'staff_guild_delete',
    `Deleted server "${nameRows[0]?.name ?? guildId}"`,
    { guildId },
  );
  return c.json({ ok: true });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/activity — recent registrations + guild creations
// ───────────────────────────────────────────────────────────────────────────
//
// Powers the "what's been happening" feed on the Overview tab. Two
// parallel small queries — last 10 user signups + last 10 guild
// creations, both ordered by creation time. The Overview tab pulls
// stats and activity in parallel so the page loads with one HTTP
// round-trip per concern.

adminRouter.get('/activity', async (c) => {
  const [recentUsers, recentGuilds] = await Promise.all([
    db
      .select({
        id: schema.users.id,
        username: schema.users.username,
        displayName: schema.users.displayName,
        avatarUrl: schema.users.avatarUrl,
        createdAt: schema.users.createdAt,
      })
      .from(schema.users)
      .where(isNull(schema.users.deletedAt))
      .orderBy(desc(schema.users.createdAt))
      .limit(10),
    db
      .select({
        id: schema.guilds.id,
        name: schema.guilds.name,
        iconUrl: schema.guilds.iconUrl,
        ownerId: schema.guilds.ownerId,
        createdAt: schema.guilds.createdAt,
      })
      .from(schema.guilds)
      .where(isNull(schema.guilds.deletedAt))
      .orderBy(desc(schema.guilds.createdAt))
      .limit(10),
  ]);

  return c.json({
    activity: {
      recentUsers: recentUsers.map((u) => ({
        id: u.id.toString(),
        username: u.username,
        displayName: u.displayName,
        avatarUrl: u.avatarUrl,
        createdAt: u.createdAt.toISOString(),
      })),
      recentGuilds: recentGuilds.map((g) => ({
        id: g.id.toString(),
        name: g.name,
        iconUrl: g.iconUrl,
        ownerId: g.ownerId.toString(),
        createdAt: g.createdAt.toISOString(),
      })),
    },
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Ghost-mode observation: read any guild's channels and messages without
// joining or being detected.
// ───────────────────────────────────────────────────────────────────────────
//
// Design notes (read these before adding anything to this section):
//
//   * READ ONLY. These endpoints don't accept or perform any write
//     operation. No message-send, no reaction, no read-state update,
//     no typing broadcast, no presence update. If a future addition
//     would write, it needs to go through a different route and not
//     leak observation as a side effect.
//
//   * NO MEMBERSHIP. We never insert a guild_members row for the
//     observing admin. The admin's guildIds list is unchanged. They
//     don't appear in the member list, in typing indicators, in
//     voice-state lists, or in any presence broadcast.
//
//   * NO LIVEKIT. Voice and stage channel "observation" is excluded.
//     LiveKit lists participants to other room participants — there's
//     no way to be undetected in a voice room without forking the
//     SFU. Voice channels are visible by metadata only (name, member
//     list pulled from voice_states); the admin can see who's
//     talking but cannot listen in.
//
//   * NO HYDRATION OF EXPENSIVE ENRICHMENTS. The regular message
//     listing route hydrates poll state, forwarded-source messages,
//     sticker bodies, mentions, etc — necessary for the live chat UI
//     but unnecessary for the admin's "what was said here" question.
//     We return a slimmer DTO that hits the obvious fields plus
//     attachments + a reaction summary. This both reduces server
//     work and makes the observe view visually distinct from a real
//     guild view (clearly a moderation tool, not a member view).
//
//   * AUDIT. Every observe call writes to the API log via Hono's
//     middleware (request log line). For instances that need
//     compliance-grade audit trails, the operator should pipe API
//     logs to a retention store — fix scope for an instance_audit_log
//     table is documented in AUDIT_NOTES.md as a feature gap.

adminRouter.get('/guilds/:id/peek', validate('param', guildIdParam), async (c) => {
  const guildId = BigInt(c.req.valid('param').id);

  // Pull the guild row + every channel in one round-trip pair so the
  // observe view can render its channel list without a second fetch.
  // No permission filtering — admins see all channels including
  // ones with @everyone DENY_VIEW_CHANNEL, which is precisely the
  // case where ghost mode is useful (reviewing a hidden mod channel
  // for an abuse report, e.g.).
  const [guildRows, channelRows] = await Promise.all([
    db
      .select({
        id: schema.guilds.id,
        name: schema.guilds.name,
        iconUrl: schema.guilds.iconUrl,
        ownerId: schema.guilds.ownerId,
        createdAt: schema.guilds.createdAt,
        memberCount: sql<number>`(
          SELECT COUNT(*)::int FROM ${schema.guildMembers}
          WHERE ${schema.guildMembers.guildId} = ${schema.guilds.id}
        )`,
      })
      .from(schema.guilds)
      .where(and(eq(schema.guilds.id, guildId), isNull(schema.guilds.deletedAt)))
      .limit(1),
    db
      .select({
        id: schema.channels.id,
        guildId: schema.channels.guildId,
        parentId: schema.channels.parentId,
        type: schema.channels.type,
        name: schema.channels.name,
        topic: schema.channels.topic,
        position: schema.channels.position,
        nsfw: schema.channels.nsfw,
      })
      .from(schema.channels)
      .where(and(eq(schema.channels.guildId, guildId), isNull(schema.channels.deletedAt)))
      .orderBy(schema.channels.position),
  ]);
  const g = guildRows[0];
  if (!g) throw errors.notFound('Guild');

  // One audit row per observe session (opening the peek view). The
  // per-channel message fetches below aren't logged individually — that
  // would flood the log with a row per channel click.
  await auditStaff(c, 'staff_observe', `Observed server "${g.name}"`, { guildId });

  return c.json({
    guild: {
      id: g.id.toString(),
      name: g.name,
      iconUrl: g.iconUrl,
      ownerId: g.ownerId.toString(),
      createdAt: g.createdAt.toISOString(),
      memberCount: g.memberCount,
    },
    channels: channelRows.map((ch) => ({
      id: ch.id.toString(),
      guildId: ch.guildId?.toString() ?? null,
      parentId: ch.parentId?.toString() ?? null,
      type: ch.type,
      name: ch.name,
      topic: ch.topic,
      position: ch.position,
      nsfw: ch.nsfw,
    })),
  });
});

const peekMessagesQuery = z.object({
  before: z.string().regex(/^[0-9]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

adminRouter.get(
  '/channels/:id/peek/messages',
  validate('param', guildIdParam),
  validate('query', peekMessagesQuery),
  async (c) => {
    const channelId = BigInt(c.req.valid('param').id);
    const q = c.req.valid('query');

    // Verify the channel exists and is not deleted — admins can
    // observe any channel that exists on the instance, but a
    // missing/deleted id still 404s for honesty.
    const channelRows = await db
      .select({
        id: schema.channels.id,
        guildId: schema.channels.guildId,
        type: schema.channels.type,
        name: schema.channels.name,
      })
      .from(schema.channels)
      .where(and(eq(schema.channels.id, channelId), isNull(schema.channels.deletedAt)))
      .limit(1);
    const ch = channelRows[0];
    if (!ch) throw errors.notFound('Channel');

    // Admin observe is a GUILD moderation tool only. DMs and group DMs are
    // private conversations (and may be E2EE) — their backlog must never be
    // exposed through peek, regardless of who holds the admin/mod bit. A
    // null guildId also fences off any non-guild channel type. 404 (not 403)
    // to avoid confirming a DM channel exists by id.
    if (ch.guildId === null || ch.type === 'dm' || ch.type === 'group_dm') {
      throw errors.notFound('Channel');
    }

    // Voice and stage channels have no message backlog to observe.
    // Return an empty list with a hint rather than 400 so the UI can
    // render a sensible "no messages — voice channel" state.
    if (ch.type === 'guild_voice' || ch.type === 'guild_stage') {
      return c.json({ messages: [], voiceChannel: true });
    }

    const { listMessages, loadAttachments } = await import('../services/messages');
    const rows = await listMessages(channelId, {
      before: q.before ? BigInt(q.before) : undefined,
      limit: q.limit ?? 50,
    });

    if (rows.length === 0) {
      return c.json({ messages: [], voiceChannel: false });
    }

    // Slim hydration: authors, attachments, reaction summary. No
    // mentions, no polls, no forwards, no stickers — the observe view
    // is a moderation tool, not a chat client. If the operator needs
    // to see the full message they can still fetch the regular
    // /channels/:id/messages/:messageId endpoint while in observe
    // mode (it does its own permission check, so they'd need to be
    // a member there — but for v1, slim view is enough for the
    // 90%-case of "what did this user say in this channel").
    const authorIds = Array.from(
      new Set(rows.map((m) => m.authorId).filter((x): x is bigint => x !== null)),
    );
    const messageIds = rows.map((m) => m.id);

    const [authors, attachmentMap, reactionRows] = await Promise.all([
      authorIds.length === 0
        ? Promise.resolve([] as Array<{ id: bigint; username: string; displayName: string | null; avatarUrl: string | null }>)
        : db
            .select({
              id: schema.users.id,
              username: schema.users.username,
              displayName: schema.users.displayName,
              avatarUrl: schema.users.avatarUrl,
            })
            .from(schema.users)
            .where(inArray(schema.users.id, authorIds)),
      loadAttachments(messageIds),
      db
        .select({ messageId: schema.reactions.messageId, emoji: schema.reactions.emoji })
        .from(schema.reactions)
        .where(inArray(schema.reactions.messageId, messageIds)),
    ]);

    const authorMap = new Map(authors.map((u) => [u.id, u]));

    // Reaction summary: per-message, per-emoji count. No userIds —
    // observers don't need the full reaction electorate, just the
    // tally to interpret the room.
    const reactionByMsg = new Map<bigint, Map<string, number>>();
    for (const r of reactionRows) {
      let inner = reactionByMsg.get(r.messageId);
      if (!inner) {
        inner = new Map();
        reactionByMsg.set(r.messageId, inner);
      }
      inner.set(r.emoji, (inner.get(r.emoji) ?? 0) + 1);
    }

    return c.json({
      voiceChannel: false,
      messages: rows.map((m) => {
        const a = m.authorId ? authorMap.get(m.authorId) ?? null : null;
        const atts = attachmentMap.get(m.id) ?? [];
        const reacts = reactionByMsg.get(m.id);
        return {
          id: m.id.toString(),
          channelId: m.channelId.toString(),
          authorId: m.authorId?.toString() ?? null,
          authorUsername: a?.username ?? null,
          authorDisplayName: a?.displayName ?? null,
          authorAvatarUrl: a?.avatarUrl ?? null,
          content: m.content,
          createdAt: m.createdAt.toISOString(),
          editedAt: m.editedAt?.toISOString() ?? null,
          // Full AttachmentDTO (see the same note in routes/family.ts):
          // observers need `thumbnailUrl` so a peek renders previews
          // rather than full-size originals, and `blobExpiredAt` so an
          // aged-out original reads as "no longer stored" instead of a
          // broken image.
          attachments: atts.map(toAttachment),
          reactions: reacts
            ? Array.from(reacts.entries()).map(([emoji, count]) => ({ emoji, count }))
            : [],
          hasReply: m.replyToId !== null,
          hasForward: m.forwardedFromMessageId !== null,
          hasSticker: m.stickerId !== null,
        };
      }),
    });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// Security (Admin → Security): event log, banned words, throttle config.
// ───────────────────────────────────────────────────────────────────────────

const securityEventsQuery = z.object({
  // 'staff' is a meta-filter matching every staff_* audit kind.
  kind: z.enum(['spam_limited', 'banned_word', 'watch_word', 'staff']).optional(),
  before: z.string().regex(/^[0-9]+$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

adminRouter.get('/security/events', validate('query', securityEventsQuery), async (c) => {
  const q = c.req.valid('query');
  const security = await import('../services/security');
  const events = await security.listEvents({
    kind: q.kind,
    before: q.before ? BigInt(q.before) : undefined,
    limit: q.limit,
  });
  return c.json({ events });
});

adminRouter.get('/security/words', async (c) => {
  const security = await import('../services/security');
  return c.json({ words: await security.listBannedWords() });
});

adminRouter.post(
  '/security/words',
  validate(
    'json',
    z.object({
      word: z.string().min(1).max(64),
      // 'blocked' = hard block (default, back-compat), 'watch' = alert only.
      severity: z.enum(['blocked', 'watch']).optional(),
    }),
  ),
  async (c) => {
    const userId = requireUserId(c);
    const { word, severity } = c.req.valid('json');
    const security = await import('../services/security');
    await security.addBannedWord(word, severity ?? 'blocked', userId);
    return c.json({ words: await security.listBannedWords() }, 201);
  },
);

// The common moderation wordlist itself (read-only — nothing is added).
// The client renders this so the admin can pick words individually.
adminRouter.get('/security/words/preset', async (c) => {
  const { BANNED_WORDS_PRESET } = await import('../data/bannedWordsPreset');
  return c.json({ words: BANNED_WORDS_PRESET });
});

// Bulk-load the common moderation wordlist. Insert-only: existing words
// are kept, duplicates skipped. Returns the refreshed full list plus how
// many entries were new.
adminRouter.post('/security/words/preset', async (c) => {
  const userId = requireUserId(c);
  const security = await import('../services/security');
  const added = await security.addPresetWords(userId);
  return c.json({ added, words: await security.listBannedWords() }, 201);
});

adminRouter.delete('/security/words/:word', async (c) => {
  const word = decodeURIComponent(c.req.param('word'));
  const security = await import('../services/security');
  await security.removeBannedWord(word);
  return c.json({ words: await security.listBannedWords() });
});

adminRouter.get('/security/config', async (c) => {
  const security = await import('../services/security');
  return c.json({ config: await security.getConfig() });
});

const securityConfigPatch = z.object({
  spamEnabled: z.boolean().optional(),
  spamMaxMessages: z.coerce.number().int().min(2).max(100).optional(),
  spamWindowSeconds: z.coerce.number().int().min(2).max(300).optional(),
  spamCooldownSeconds: z.coerce.number().int().min(60).max(86400).optional(),
  wordFilterEnabled: z.boolean().optional(),
});

adminRouter.patch('/security/config', validate('json', securityConfigPatch), async (c) => {
  const security = await import('../services/security');
  return c.json({ config: await security.updateConfig(c.req.valid('json')) });
});

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/embed-test?url=... — link preview diagnostic
//
// Synchronously runs the embed pipeline for a single URL and returns every
// step's outcome. Lets the operator pinpoint where things break (DNS,
// fetch, parse, etc) without having to send messages and grep logs.
//
// Usage:
//   curl -H 'Authorization: Bearer ...' \
//     'https://zekktris.com/api/v1/admin/embed-test?url=https://example.com'
//
// Response on success:
//   {
//     ok: true,
//     embed: { ... },                  // null if metadata couldn't be parsed
//     diagnostics: {
//       resolvedIp: '93.184.216.34',
//       fetchStatus: 200,
//       contentType: 'text/html; charset=utf-8',
//       htmlBytes: 1256,
//     }
//   }
//
// Response on failure: { ok: false, stage: 'dns'|'fetch'|'parse', details: ... }
// ───────────────────────────────────────────────────────────────────────────

const embedTestQuery = z.object({
  url: z.string().url(),
});

adminRouter.get(
  '/embed-test',
  validate('query', embedTestQuery),
  async (c) => {
    const { url } = c.req.valid('query');
    const embeds = await import('../services/embeds');

    // Step 1: extract URLs from the query (sanity check that our
    // regex would have matched it from message content too).
    const extracted = embeds.extractUrls(url);
    if (extracted.length === 0) {
      return c.json({
        ok: false,
        stage: 'extract',
        details:
          "URL doesn't match the extractor regex. Make sure it starts with http(s)://.",
        input: url,
      });
    }

    // Step 2: try to resolve the full embed. resolveEmbed returns
    // null on any failure (DNS / SSRF / fetch / non-HTML / no
    // metadata). The internals log to the api logger at info level,
    // so the actual failure cause is visible in `docker compose logs
    // api | grep embed`.
    const startedAt = Date.now();
    const embed = await embeds.resolveEmbed(extracted[0]!);
    const elapsedMs = Date.now() - startedAt;

    if (!embed) {
      return c.json({
        ok: false,
        stage: 'resolve',
        details:
          'resolveEmbed returned null. Check `docker compose logs api --tail 200 | grep embed` for the specific failure (DNS, SSRF, fetch error, non-HTML content, or no extractable metadata).',
        input: url,
        elapsedMs,
      });
    }

    return c.json({
      ok: true,
      embed,
      elapsedMs,
      input: url,
    });
  },
);
