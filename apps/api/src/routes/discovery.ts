/**
 * Discovery router
 * ----------------
 * Mounted at /api/v1.
 *
 *   GET  /discovery                       — list/search discoverable guilds
 *   POST /guilds/:guildId/discovery/join  — public join (no invite code)
 *   PATCH /guilds/:guildId/discovery      — owner / MANAGE_GUILD opt-in toggle
 *
 * Listing is open to any authenticated user — there's no concept of
 * "guilds I can see"; if a guild is discoverable, anyone can find it.
 * The shape of the join path mirrors invite-accept (returns the guild
 * + the channel to navigate to so the client lands on something
 * sensible after joining).
 */

import { Hono } from 'hono';
import { z } from 'zod';
import { errors } from '../errors';
import { requireAuth, requireUserId, requireHumanSession } from '../auth/middleware';
import { validate } from '../lib/validate';
import { RateLimiter } from '../lib/rateLimit';
import { snowflakeSchema } from '../lib/validation';
import { toGuild, toGuildMember } from '../lib/dto';
import * as discovery from '../services/discovery';
import * as welcome from '../services/welcome';
import * as guilds from '../services/guilds';
import * as members from '../services/members';
import * as permissions from '../services/permissions';
import { db, schema } from '../db';
import { and, eq, asc, isNull } from 'drizzle-orm';
import * as dispatch from '../gateway/dispatch';

export const discoveryRouter = new Hono();
// requireAuth is applied PER-ROUTE below, NOT via a catch-all `.use('*')`. A
// catch-all on a router mounted at the v1 root ('/') leaks onto sibling
// routers registered after it in Hono — it would 401 federation's public
// enrollment + JWKS routes. Per-route gating keeps auth local to this router.

// ── List / search ────────────────────────────────────────────────────────

const listQuerySchema = z.object({
  q: z.string().optional(),
  category: z.string().optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

// Browse/search/paginate the directory. Generous per-user cap (search-as-you-
// type fires several) — light defense against hammering an unauthenticated-
// from-any-account read. Inherits the Redis fail-open contract.
const discoveryListRl = new RateLimiter(120, 60_000, 'discovery-list');

discoveryRouter.get(
  '/discovery',
  requireAuth,
  validate('query', listQuerySchema),
  async (c) => {
    const userId = requireUserId(c); // must be authed; no per-result gating
    const rl = await discoveryListRl.consume(userId.toString());
    if (!rl.ok) throw errors.rateLimited(Math.ceil(rl.retryAfterMs / 1000));
    const { q, category, offset } = c.req.valid('query');
    const result = await discovery.listDiscoverable({ query: q, category, offset });
    return c.json({
      guilds: result.guilds.map((g) => ({
        id: g.id.toString(),
        name: g.name,
        description: g.description,
        discoveryDescription: g.discoveryDescription,
        discoveryCategory: g.discoveryCategory,
        iconUrl: g.iconUrl,
        bannerUrl: g.bannerUrl,
        memberCount: g.memberCount,
        vanityUrlCode: g.vanityUrlCode,
      })),
      total: result.total,
    });
  },
);

// ── Public join ──────────────────────────────────────────────────────────

discoveryRouter.post(
  '/guilds/:guildId/discovery/join',
  requireAuth,
  // Humans only — bots join through addBotToGuild (MANAGE_GUILD), as on
  // invite accept.
  requireHumanSession,
  validate('param', z.object({ guildId: snowflakeSchema })),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);

    const result = await discovery.joinPublic({ guildId, userId });

    // Find a channel to land the user on. Pick the first text channel
    // by position (the same heuristic as invite-accept). If there are
    // no text channels we still return success without a channel id —
    // the client will land on the empty-state.
    const channelRows = await db
      .select({ id: schema.channels.id })
      .from(schema.channels)
      .where(
        and(
          eq(schema.channels.guildId, guildId),
          eq(schema.channels.type, 'guild_text'),
          isNull(schema.channels.deletedAt),
        ),
      )
      .orderBy(asc(schema.channels.position), asc(schema.channels.id))
      .limit(1);
    const landingChannelId = channelRows[0]?.id ?? null;

    // Fan out a guild-create event to the joining user so their guild
    // list updates without a full reload. Every other member sees a
    // GUILD_MEMBER_ADD event for the new joiner.
    if (!result.alreadyMember) {
      // Announce the join through the SAME path as invite-accept and
      // guild-create (dispatch.userJoinedGuild). It broadcasts a properly
      // shaped GUILD_MEMBER_ADD — toGuildMember(), which carries the top-level
      // guildId + userId + full member fields (GuildMemberDTO) — to the other
      // members, AND seeds the joiner's gateway connection with this guild and
      // its viewable channels so they get live events immediately instead of
      // only after a reconnect.
      //
      // The earlier hand-built payload omitted the top-level userId and guildId,
      // so strict clients couldn't use it: the iOS native client's Codable
      // GuildMember decode failed (and its guildId fallback was also absent),
      // and the web cached an undefined guildId — a member who joined via the
      // discovery browser flashed "@user" in mentions and didn't appear in an
      // open member list until a full guild refresh.
      const guild = await guilds.getGuild(guildId);
      const memberDetailed = await members.getMemberDetailed(guildId, userId);
      if (guild && memberDetailed) {
        const viewableChannelIds = await permissions.listViewableGuildChannelIds(
          guildId,
          userId,
        );
        dispatch.userJoinedGuild({
          userId,
          guildId,
          guildDTO: toGuild(guild),
          memberDTO: toGuildMember(
            memberDetailed.member,
            memberDetailed.user,
            memberDetailed.roleIds,
          ),
          viewableChannelIds,
        });
      }
      // Post the welcome greeting if this guild has them enabled. Best-effort;
      // failures are logged + swallowed inside the service so the response still
      // succeeds. Posted AFTER userJoinedGuild so the joiner is subscribed to
      // the guild's channels before their greeting's MESSAGE_CREATE dispatches.
      void welcome.postWelcomeMessage(guildId, userId);
    }

    return c.json({
      guildId: guildId.toString(),
      channelId: landingChannelId?.toString() ?? null,
      alreadyMember: result.alreadyMember,
    });
  },
);

// ── Owner / MANAGE_GUILD: toggle discoverable + edit description ─────────

const patchDiscoverySchema = z.object({
  discoverable: z.boolean(),
  discoveryDescription: z.string().max(500).nullable().optional(),
  discoveryCategory: z.string().max(64).nullable().optional(),
});

discoveryRouter.patch(
  '/guilds/:guildId/discovery',
  requireAuth,
  validate('param', z.object({ guildId: snowflakeSchema })),
  validate('json', patchDiscoverySchema),
  async (c) => {
    const userId = requireUserId(c);
    const guildId = BigInt(c.req.valid('param').guildId);
    const body = c.req.valid('json');

    const updated = await discovery.setDiscoverable({
      guildId,
      actorId: userId,
      discoverable: body.discoverable,
      discoveryDescription: body.discoveryDescription,
      discoveryCategory: body.discoveryCategory,
    });

    // Broadcast guild-update so members see the change reflected in
    // their own guild settings tab (the toggle state propagates).
    dispatch.guildUpdate(toGuild(updated), guildId);

    return c.json({ guild: toGuild(updated) });
  },
);

// errors helper used to satisfy the unused-import lint when the file
// is trimmed; in practice errors() is invoked indirectly via the
// service-layer helpers above.
void errors;
