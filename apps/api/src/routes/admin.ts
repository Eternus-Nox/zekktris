/**
 * Admin routes
 * ------------
 * Instance-admin endpoints. Gated by users.is_admin via the
 * `requireAdmin` middleware. Designed for the self-hosted operator
 * use case: see who's on the instance, what's growing in size, and
 * have a way to act on bad actors.
 *
 * Endpoints:
 *   GET    /api/v1/admin/stats           system stats (counts + recent activity)
 *   GET    /api/v1/admin/users           list users (paginated, searchable)
 *   POST   /api/v1/admin/users/:id/ban   soft-ban a user (sets banned_at, revokes all sessions)
 *   POST   /api/v1/admin/users/:id/unban undo a soft-ban
 *   POST   /api/v1/admin/users/:id/admin grant or revoke instance admin
 *   GET    /api/v1/admin/guilds          list all guilds with member counts
 *   GET    /api/v1/admin/storage         disk usage breakdown
 *
 * Permission model: NOT per-guild — these are server-operator
 * actions. The is_admin flag should be set by the operator directly
 * via SQL (`UPDATE users SET is_admin=true WHERE id=...`) for the
 * bootstrap admin; the admin-grant endpoint handles subsequent
 * promotions.
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { and, desc, eq, gt, ilike, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { validate } from '../lib/validate';
import { requireAuth, requireAdmin, requireUserId } from '../auth/middleware';
import { revokeAllUserSessions } from '../auth/sessions';
import * as voice from '../services/voice';
import * as dispatch from '../gateway/dispatch';
import { leftVoiceStateDTO } from '../lib/dto';
import { registry } from '../gateway/registry';
import {
  listStorageItems,
  deleteStorageItem,
  compressStorageItem,
  runAttachmentGcSweep,
} from '../services/uploads';

export const adminRouter = new Hono();

// All routes here require auth + admin. Compose once at the router
// level so we can't accidentally forget the gate on a new endpoint.
adminRouter.use('*', requireAuth, requireAdmin);

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
      bannedAt: schema.users.bannedAt,
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

  return c.json({
    users: rows.map((r) => ({
      id: r.id.toString(),
      username: r.username,
      displayName: r.displayName,
      email: r.email,
      avatarUrl: r.avatarUrl,
      isAdmin: r.isAdmin,
      bannedAt: r.bannedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
      lastSeenAt: seenMap.get(r.id.toString()) ?? null,
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

adminRouter.post('/users/:id/ban', validate('param', userIdParam), async (c) => {
  const selfId = requireUserId(c);
  const targetId = BigInt(c.req.valid('param').id);
  if (targetId === selfId) {
    throw errors.badRequest('You cannot ban yourself');
  }
  await db
    .update(schema.users)
    .set({ bannedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)));
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
  // not-yet-expired access token. The connection's own close handler
  // fires onUserFullyDisconnected which sets users.status='offline'
  // and broadcasts presence — same path as the disconnect-beacon
  // endpoint uses. We DON'T need to manually broadcast presence
  // here; the close cascade handles it.
  const conns = registry.byUserId(targetId);
  for (const conn of conns) {
    try {
      // CloseCode 4004 = AUTHENTICATION_FAILED in the gateway types;
      // generic enough to surface "you've been signed out" to the
      // client without leaking the moderation context.
      conn.close(4004, 'account disabled');
    } catch {
      // Already closed mid-iteration; cleanup will still fire.
    }
  }

  return c.json({ ok: true });
});

adminRouter.post('/users/:id/unban', validate('param', userIdParam), async (c) => {
  const targetId = BigInt(c.req.valid('param').id);
  await db
    .update(schema.users)
    .set({ bannedAt: null, updatedAt: new Date() })
    .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)));
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
    .returning({ id: schema.users.id });

  if (deleted.length === 0) throw errors.notFound('User');
  return c.json({ deleted: true });
});

// ───────────────────────────────────────────────────────────────────────────
// POST /admin/users/:id/admin — promote/demote
// ───────────────────────────────────────────────────────────────────────────

const setAdminBody = z.object({ isAdmin: z.boolean() });

adminRouter.post(
  '/users/:id/admin',
  validate('param', userIdParam),
  validate('json', setAdminBody),
  async (c) => {
    const selfId = requireUserId(c);
    const targetId = BigInt(c.req.valid('param').id);
    const { isAdmin } = c.req.valid('json');
    if (targetId === selfId && !isAdmin) {
      throw errors.badRequest('You cannot demote yourself');
    }
    await db
      .update(schema.users)
      .set({ isAdmin, updatedAt: new Date() })
      .where(and(eq(schema.users.id, targetId), isNull(schema.users.deletedAt)));
    return c.json({ ok: true });
  },
);

// ───────────────────────────────────────────────────────────────────────────
// GET /admin/guilds — all guilds with member counts
// ───────────────────────────────────────────────────────────────────────────

const listGuildsQuery = z.object({
  q: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
});

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
  await revokeAllUserSessions(targetId);
  // Close live WebSockets so the in-flight session can't keep reading
  // events with a not-yet-expired access token. Without this the
  // forced logout takes up to 15 min (access token TTL) to actually
  // sever the live connection. Close code 4000 = generic disconnect
  // (vs 4004 = AUTHENTICATION_FAILED which the ban path uses); the
  // client surfaces this as "you've been signed out" and falls back
  // to the login screen.
  const conns = registry.byUserId(targetId);
  for (const conn of conns) {
    try {
      conn.close(4000, 'signed out by admin');
    } catch {
      // Already closed.
    }
  }
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
          attachments: atts.map((at) => ({
            id: at.id.toString(),
            filename: at.filename,
            url: at.url,
            contentType: at.contentType,
            size: at.size,
          })),
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
  kind: z.enum(['spam_limited', 'banned_word']).optional(),
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
  validate('json', z.object({ word: z.string().min(1).max(64) })),
  async (c) => {
    const userId = requireUserId(c);
    const security = await import('../services/security');
    await security.addBannedWord(c.req.valid('json').word, userId);
    return c.json({ words: await security.listBannedWords() }, 201);
  },
);

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
