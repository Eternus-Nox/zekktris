/**
 * Family / parental-controls routes (Phase 1)
 * -------------------------------------------
 * Linking lifecycle + the supervision summary the client reads to know
 * whether it (or a peer) is supervised — which drives the supervision
 * banner and the E2EE policy on the child's client.
 *
 *   POST   /family/links                 parent → request supervision (by username)
 *   POST   /family/links/:parentId/accept  child → accept a pending request
 *   DELETE /family/links/:otherId        either party → end the link
 *   GET    /family/me                    current user's supervision summary
 *
 * Monitoring (parent viewing child messages/contacts), watch-word
 * flagging, and restriction enforcement build on these in later phases.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { eq, inArray } from 'drizzle-orm';
import { db, schema } from '../db';
import { validate } from '../lib/validate';
import { RateLimiter } from '../lib/rateLimit';
import { requireAuth, requireUserId } from '../auth/middleware';
import { snowflakeSchema } from '../lib/validation';
import { errors } from '../errors';
import * as supervision from '../services/supervision';
import * as dms from '../services/dms';
import * as relationships from '../services/relationships';
import * as guildsSvc from '../services/guilds';

export const familyRouter = new Hono();

// Linking is a privileged action; keep it well under abuse thresholds.
const linkRl = new RateLimiter(20, 60_000);

familyRouter.post(
  '/family/links',
  requireAuth,
  validate('json', z.object({ username: z.string().min(1).max(64) })),
  async (c) => {
    const userId = requireUserId(c);
    const rl = linkRl.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    const { username } = c.req.valid('json');
    const child = await supervision.requestLink(userId, username);
    return c.json({ child: { ...child, id: String(child.id) } }, 201);
  },
);

familyRouter.post(
  '/family/links/:parentId/accept',
  requireAuth,
  validate('param', z.object({ parentId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { parentId } = c.req.valid('param');
    await supervision.acceptLink(userId, BigInt(parentId));
    return c.json({ ok: true });
  },
);

familyRouter.delete(
  '/family/links/:otherId',
  requireAuth,
  validate('param', z.object({ otherId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { otherId } = c.req.valid('param');
    await supervision.removeLinkBetween(userId, BigInt(otherId));
    return c.json({ ok: true });
  },
);

familyRouter.get('/family/me', requireAuth, async (c) => {
  const userId = requireUserId(c);
  return c.json(await supervision.supervisionSummary(userId));
});

// ── Parent read view (Phase 2) ───────────────────────────────────────────
// All gated by assertParentOf: the caller must actively supervise the
// child. The child's supervision banner already tells them their parent
// can see this, so it isn't covert.

const childParam = z.object({ childId: snowflakeSchema });

/** The child's friends + pending requests. */
familyRouter.get(
  '/family/children/:childId/friends',
  requireAuth,
  validate('param', childParam),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    await supervision.assertParentOf(userId, childId);
    const rows = await relationships.listRelationships(childId);
    return c.json({
      relationships: rows.map((row) => ({
        type: row.type,
        createdAt: row.createdAt,
        user: { ...row.target, id: row.target.id.toString() },
      })),
    });
  },
);

/** The child's DM conversations (1:1), with the other participant. */
familyRouter.get(
  '/family/children/:childId/channels',
  requireAuth,
  validate('param', childParam),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    await supervision.assertParentOf(userId, childId);
    const list = await dms.listMyDMs(childId);
    const recipientsByChannel = await dms.loadRecipientsForChannels(
      list.map((ch) => ch.id),
      childId,
    );
    return c.json({
      channels: list
        .filter((ch) => ch.type === 'dm')
        .map((ch) => {
          const peer = (recipientsByChannel.get(ch.id.toString()) ?? [])[0] ?? null;
          return {
            id: ch.id.toString(),
            lastMessageId: ch.lastMessageId ? ch.lastMessageId.toString() : null,
            recipient: peer
              ? {
                  id: peer.id.toString(),
                  username: peer.username,
                  displayName: peer.displayName,
                  avatarUrl: peer.avatarUrl,
                }
              : null,
          };
        }),
    });
  },
);

const childMessagesQuery = z.object({
  before: snowflakeSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

/**
 * Read a child's DM conversation. Authorized only when the child is a
 * participant of the channel — the parent can read the CHILD's
 * conversations, not arbitrary channels. Slim DTO mirroring admin peek.
 */
familyRouter.get(
  '/family/children/:childId/channels/:channelId/messages',
  requireAuth,
  validate('param', z.object({ childId: snowflakeSchema, channelId: snowflakeSchema })),
  validate('query', childMessagesQuery),
  async (c) => {
    const userId = requireUserId(c);
    const { childId, channelId } = c.req.valid('param');
    const cId = BigInt(childId);
    const chId = BigInt(channelId);
    await supervision.assertParentOf(userId, cId);
    // The child must be a participant — scopes the parent to the
    // child's own conversations.
    await dms.ensureRecipient(chId, cId);

    const q = c.req.valid('query');
    const { listMessages, loadAttachments } = await import('../services/messages');
    const rows = await listMessages(chId, {
      before: q.before ? BigInt(q.before) : undefined,
      limit: q.limit ?? 50,
      // Supervision sees deleted content — a child can delete a message
      // from the conversation, but it stays visible (and labelled) here.
      includeDeleted: true,
    });
    if (rows.length === 0) return c.json({ messages: [] });

    const authorIds = Array.from(
      new Set(rows.map((m) => m.authorId).filter((x): x is bigint => x !== null)),
    );
    const [authors, attachmentMap] = await Promise.all([
      authorIds.length === 0
        ? Promise.resolve(
            [] as Array<{
              id: bigint;
              username: string;
              displayName: string | null;
              avatarUrl: string | null;
            }>,
          )
        : db
            .select({
              id: schema.users.id,
              username: schema.users.username,
              displayName: schema.users.displayName,
              avatarUrl: schema.users.avatarUrl,
            })
            .from(schema.users)
            .where(inArray(schema.users.id, authorIds)),
      loadAttachments(rows.map((m) => m.id)),
    ]);
    const authorMap = new Map(authors.map((u) => [u.id, u]));

    return c.json({
      messages: rows.map((m) => {
        const a = m.authorId ? authorMap.get(m.authorId) ?? null : null;
        const atts = attachmentMap.get(m.id) ?? [];
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
          deleted: m.deletedAt !== null,
          attachments: atts.map((at) => ({
            id: at.id.toString(),
            filename: at.filename,
            url: at.url,
            contentType: at.contentType,
            size: at.size,
          })),
        };
      }),
    });
  },
);

// ── Restrictions (parent) ────────────────────────────────────────────────

familyRouter.get(
  '/family/children/:childId/restrictions',
  requireAuth,
  validate('param', childParam),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    await supervision.assertParentOf(userId, childId);
    return c.json({
      restrictions: await supervision.getRestrictions(childId),
      blockedGuildIds: await supervision.listBlockedGuildIds(childId),
    });
  },
);

/** The child's servers, each flagged with whether it's currently blocked. */
familyRouter.get(
  '/family/children/:childId/guilds',
  requireAuth,
  validate('param', childParam),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    await supervision.assertParentOf(userId, childId);
    const [guilds, blockedIds] = await Promise.all([
      guildsSvc.listGuildsForUser(childId),
      supervision.listBlockedGuildIds(childId),
    ]);
    const blocked = new Set(blockedIds);
    return c.json({
      guilds: guilds.map((g) => ({
        id: g.id.toString(),
        name: g.name,
        iconUrl: g.iconUrl ?? null,
        blocked: blocked.has(g.id.toString()),
      })),
    });
  },
);

const restrictionsPatch = z.object({
  canAddFriends: z.boolean().optional(),
  canRemoveFriends: z.boolean().optional(),
  allowVoice: z.boolean().optional(),
  allowVideo: z.boolean().optional(),
  allowStream: z.boolean().optional(),
});

familyRouter.patch(
  '/family/children/:childId/restrictions',
  requireAuth,
  validate('param', childParam),
  validate('json', restrictionsPatch),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    const patch = c.req.valid('json');
    const restrictions = await supervision.setRestrictions(userId, childId, patch);
    return c.json({ restrictions });
  },
);

familyRouter.post(
  '/family/children/:childId/blocked-guilds',
  requireAuth,
  validate('param', childParam),
  validate('json', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    const { guildId } = c.req.valid('json');
    await supervision.setGuildBlocked(userId, childId, BigInt(guildId), true);
    return c.json({ ok: true });
  },
);

familyRouter.delete(
  '/family/children/:childId/blocked-guilds/:guildId',
  requireAuth,
  validate('param', z.object({ childId: snowflakeSchema, guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const { childId, guildId } = c.req.valid('param');
    await supervision.setGuildBlocked(userId, BigInt(childId), BigInt(guildId), false);
    return c.json({ ok: true });
  },
);

// ── Approval requests ────────────────────────────────────────────────────

/** Parent: pending requests across all supervised children. */
familyRouter.get('/family/requests', requireAuth, async (c) => {
  const userId = requireUserId(c);
  return c.json({ requests: await supervision.listParentRequests(userId) });
});

familyRouter.post(
  '/family/requests/:id/approve',
  requireAuth,
  validate('param', z.object({ id: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    await supervision.approveRequest(userId, BigInt(c.req.valid('param').id));
    return c.json({ ok: true });
  },
);

familyRouter.post(
  '/family/requests/:id/deny',
  requireAuth,
  validate('param', z.object({ id: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    await supervision.denyRequest(userId, BigInt(c.req.valid('param').id));
    return c.json({ ok: true });
  },
);

/** Child: ask a parent to approve adding a friend. */
familyRouter.post(
  '/family/requests/friend',
  requireAuth,
  validate('json', z.object({ targetId: snowflakeSchema, note: z.string().max(280).optional() })),
  async (c) => {
    const userId = requireUserId(c);
    const { targetId, note } = c.req.valid('json');
    const id = await supervision.createFriendApproval(userId, BigInt(targetId), note);
    return c.json({ id }, 201);
  },
);

/** Child: ask a parent to approve joining a server (by invite code). */
familyRouter.post(
  '/family/requests/guild',
  requireAuth,
  validate('json', z.object({ inviteCode: z.string().min(1).max(64), note: z.string().max(280).optional() })),
  async (c) => {
    const userId = requireUserId(c);
    const { inviteCode, note } = c.req.valid('json');
    // Resolve the guild for display (best-effort; null if the code is bad).
    const [inv] = await db
      .select({ guildId: schema.invites.guildId })
      .from(schema.invites)
      .where(eq(schema.invites.code, inviteCode))
      .limit(1);
    const id = await supervision.createGuildApproval(
      userId,
      inviteCode,
      inv ? inv.guildId : null,
      note,
    );
    return c.json({ id }, 201);
  },
);

// ── Watch words + flags (parent) ─────────────────────────────────────────

familyRouter.get(
  '/family/children/:childId/watch-words',
  requireAuth,
  validate('param', childParam),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    return c.json({ words: await supervision.listWatchWords(userId, childId) });
  },
);

familyRouter.post(
  '/family/children/:childId/watch-words',
  requireAuth,
  validate('param', childParam),
  validate('json', z.object({ word: z.string().min(1).max(512) })),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    const words = await supervision.addWatchWord(userId, childId, c.req.valid('json').word);
    return c.json({ words });
  },
);

familyRouter.delete(
  '/family/children/:childId/watch-words',
  requireAuth,
  validate('param', childParam),
  validate('query', z.object({ word: z.string().min(1).max(64) })),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    const words = await supervision.removeWatchWord(userId, childId, c.req.valid('query').word);
    return c.json({ words });
  },
);

familyRouter.get(
  '/family/children/:childId/flags',
  requireAuth,
  validate('param', childParam),
  async (c) => {
    const userId = requireUserId(c);
    const childId = BigInt(c.req.valid('param').childId);
    return c.json({ flags: await supervision.listFlags(userId, childId) });
  },
);

familyRouter.post(
  '/family/flags/:id/reviewed',
  requireAuth,
  validate('param', z.object({ id: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    await supervision.markFlagReviewed(userId, BigInt(c.req.valid('param').id));
    return c.json({ ok: true });
  },
);
