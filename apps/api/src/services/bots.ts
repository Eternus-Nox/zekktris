/**
 * Bots service
 * ------------
 * Bot accounts are real user rows (is_bot=true) owned by a human
 * (bot_owner_id). They authenticate with a static token instead of
 * password+JWT.
 *
 * Token model (mirrors the email-verification + password-reset
 * pattern already in the codebase):
 *   - Token = "zkbot_" + URL-safe base64 of 32 random bytes
 *   - Only the SHA-256 hash is stored (users.bot_token_hash)
 *   - Plaintext is returned exactly once — at create + regenerate.
 *     There's no way to retrieve it later; lose it → regenerate.
 *
 * Bots can't log in via the human path: their password_hash is an
 * unusable sentinel string that no scrypt verify will ever match.
 */

import { and, eq } from 'drizzle-orm';
import { createHash, createHmac, randomBytes } from 'crypto';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import { encryptField, decryptField } from '../lib/fieldCrypto';

const TOKEN_PREFIX = 'zkbot_';
const TOKEN_BYTES = 32;
// Sentinel password hash for bots. Not a valid scrypt-v1 string, so
// verifyPassword can never produce a match — bots are unreachable via
// the email/password login flow by construction.
const BOT_PASSWORD_SENTINEL = 'bot-account-no-password-login';
// Cap bots-per-owner to stop a single account spinning up thousands
// of bot rows (resource + abuse guard). Generous for legit use.
const MAX_BOTS_PER_OWNER = 25;

function generateToken(): { plain: string; hash: string } {
  const raw = randomBytes(TOKEN_BYTES)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const plain = `${TOKEN_PREFIX}${raw}`;
  const hash = createHash('sha256').update(plain).digest('hex');
  return { plain, hash };
}

function hashToken(plain: string): string {
  return createHash('sha256').update(plain).digest('hex');
}

export interface CreateBotInput {
  ownerId: bigint;
  username: string; // desired handle (lowercased + validated by route)
  displayName: string;
}

export async function createBot(
  input: CreateBotInput,
): Promise<{ bot: typeof schema.users.$inferSelect; token: string }> {
  // Enforce the per-owner cap.
  const existing = await db
    .select({ id: schema.users.id })
    .from(schema.users)
    .where(
      and(
        eq(schema.users.botOwnerId, input.ownerId),
        eq(schema.users.isBot, true),
      ),
    );
  if (existing.length >= MAX_BOTS_PER_OWNER) {
    throw errors.badRequest(
      `You can own at most ${MAX_BOTS_PER_OWNER} bots.`,
    );
  }

  const { plain, hash } = generateToken();
  const id = nextSnowflake();
  // Bot email is synthetic — bots never receive mail, but the column
  // is NOT NULL + we want uniqueness. Namespacing on the bot id keeps
  // it unique without colliding with any real user's email.
  const syntheticEmail = `bot-${id.toString()}@bots.zekktris.local`;

  let bot: typeof schema.users.$inferSelect | undefined;
  try {
    const [row] = await db
      .insert(schema.users)
      .values({
        id,
        email: syntheticEmail,
        emailVerified: true,
        username: input.username,
        displayName: input.displayName,
        passwordHash: BOT_PASSWORD_SENTINEL,
        isBot: true,
        botOwnerId: input.ownerId,
        botTokenHash: hash,
        status: 'online',
      })
      .returning();
    bot = row;
  } catch (e) {
    // Unique violation on username → friendly error.
    if ((e as { code?: string }).code === '23505') {
      throw errors.badRequest('That bot username is taken.');
    }
    throw e;
  }
  if (!bot) throw errors.internal('Failed to create bot');
  return { bot, token: plain };
}

export async function listBotsForOwner(
  ownerId: bigint,
): Promise<Array<typeof schema.users.$inferSelect>> {
  return db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.botOwnerId, ownerId),
        eq(schema.users.isBot, true),
      ),
    );
}

/**
 * Load a bot the caller owns, or throw. Used to authorize
 * regenerate/delete/update operations.
 */
async function loadOwnedBot(
  botId: bigint,
  ownerId: bigint,
): Promise<typeof schema.users.$inferSelect> {
  const [bot] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, botId))
    .limit(1);
  if (!bot || !bot.isBot) throw errors.notFound('Bot');
  if (bot.botOwnerId !== ownerId) {
    throw errors.forbidden('You do not own this bot.');
  }
  return bot;
}

export async function regenerateBotToken(
  botId: bigint,
  ownerId: bigint,
): Promise<{ token: string }> {
  await loadOwnedBot(botId, ownerId);
  const { plain, hash } = generateToken();
  await db
    .update(schema.users)
    .set({ botTokenHash: hash, updatedAt: new Date() })
    .where(eq(schema.users.id, botId));
  return { token: plain };
}

export async function deleteBot(
  botId: bigint,
  ownerId: bigint,
): Promise<void> {
  await loadOwnedBot(botId, ownerId);
  // Hard delete the bot row. Cascades drop its memberships, messages
  // stay (authored content is preserved with the now-dangling author
  // id — same as any deleted user; the DTO layer renders a fallback).
  await db.delete(schema.users).where(eq(schema.users.id, botId));
}

export async function updateBotProfile(
  botId: bigint,
  ownerId: bigint,
  patch: { displayName?: string; avatarUrl?: string | null; bio?: string | null },
): Promise<typeof schema.users.$inferSelect> {
  await loadOwnedBot(botId, ownerId);
  const [updated] = await db
    .update(schema.users)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(schema.users.id, botId))
    .returning();
  if (!updated) throw errors.internal('Bot update failed');
  return updated;
}

/**
 * Resolve a bot token (plaintext, from the Authorization header) to
 * its user row. Returns null if the token is unknown. Used by the
 * auth middleware. Constant-ish work: hash the token, single indexed
 * lookup by hash.
 */
export async function resolveBotByToken(
  plainToken: string,
): Promise<typeof schema.users.$inferSelect | null> {
  if (!plainToken.startsWith(TOKEN_PREFIX)) return null;
  const hash = hashToken(plainToken);
  const [bot] = await db
    .select()
    .from(schema.users)
    .where(
      and(
        eq(schema.users.botTokenHash, hash),
        eq(schema.users.isBot, true),
      ),
    )
    .limit(1);
  return bot ?? null;
}


/**
 * Add a bot to a guild as a member. The actor must have MANAGE_GUILD
 * on the target guild (so arbitrary members can't add bots). The bot
 * joins in 'active' state — bots don't go through rules/onboarding.
 *
 * Bots gain permissions in the guild through roles assigned to them,
 * exactly like human members; this just creates the membership row.
 */
export async function addBotToGuild(args: {
  botId: bigint;
  guildId: bigint;
  actorId: bigint;
}): Promise<void> {
  const { botId, guildId, actorId } = args;

  const { computeMemberGuildPermissions, hasPermission } = await import(
    './permissions'
  );
  const { Permissions } = await import('@zekktris/shared/permissions');
  const actorPerms = await computeMemberGuildPermissions(guildId, actorId);
  if (!hasPermission(actorPerms, Permissions.MANAGE_GUILD)) {
    throw errors.missingPermissions(['MANAGE_GUILD']);
  }

  const [bot] = await db
    .select()
    .from(schema.users)
    .where(eq(schema.users.id, botId))
    .limit(1);
  if (!bot || !bot.isBot) throw errors.notFound('Bot');

  // The installer must OWN the bot. Without this, any guild manager who
  // learns a bot's id (it's on every message the bot authors) could
  // conscript a stranger's bot into their guild — and since membership
  // makes deliverMessageEventToBots stream every viewable message to the
  // bot's external callback URL, that silently exfiltrates the guild's
  // content to a third party who never consented. If shared/public bots
  // become a feature, gate this on an explicit owner-set "public" flag
  // instead (Discord's public-bot / OAuth-invite model).
  if (bot.botOwnerId !== actorId) {
    throw errors.forbidden('Only the bot’s owner can add it to a server.');
  }

  // Already a member? Idempotent success.
  const existing = await db
    .select({ userId: schema.guildMembers.userId })
    .from(schema.guildMembers)
    .where(
      and(
        eq(schema.guildMembers.guildId, guildId),
        eq(schema.guildMembers.userId, botId),
      ),
    )
    .limit(1);
  if (existing.length > 0) return;

  await db.insert(schema.guildMembers).values({
    guildId,
    userId: botId,
    membershipState: 'active',
  });
}

// ── Event delivery ────────────────────────────────────────────────────────
//
// Outgoing webhooks: when a message lands in a channel a bot can see,
// the server POSTs the event to the bot's callback URL, signed with
// HMAC-SHA256 so the bot can verify authenticity.

const EVENT_FETCH_TIMEOUT_MS = 4_000;

/**
 * Set (or clear, with url=null) a bot's event callback URL. Generates
 * a fresh signing secret the first time a URL is set; returns the
 * secret ONCE so the owner can configure their bot to verify
 * signatures. Clearing the URL also clears the secret.
 */
export async function setBotEventConfig(
  botId: bigint,
  ownerId: bigint,
  url: string | null,
): Promise<{ eventUrl: string | null; secret: string | null }> {
  const bot = await loadOwnedBot(botId, ownerId);

  if (url === null) {
    await db
      .update(schema.users)
      .set({ botEventUrl: null, botEventSecret: null, updatedAt: new Date() })
      .where(eq(schema.users.id, botId));
    return { eventUrl: null, secret: null };
  }

  // Require HTTPS for event callbacks — events can carry message
  // content, which shouldn't traverse plaintext HTTP.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw errors.badRequest('Invalid callback URL');
  }
  if (parsed.protocol !== 'https:') {
    throw errors.badRequest('Callback URL must be https://');
  }

  // Reuse the existing secret if one is set, otherwise mint one. This
  // keeps a bot's signature verification stable across URL edits. The
  // stored value may be encrypted at rest, so decrypt before reusing and
  // re-encrypt on write; the secret returned to the caller is plaintext
  // (shown once so the bot author can configure signature verification).
  const existingSecret = bot.botEventSecret ? decryptField(bot.botEventSecret) : null;
  const secret = existingSecret ?? `zkbsec_${randomBytes(24).toString('hex')}`;
  await db
    .update(schema.users)
    .set({ botEventUrl: url, botEventSecret: encryptField(secret), updatedAt: new Date() })
    .where(eq(schema.users.id, botId));
  return { eventUrl: url, secret };
}

/**
 * SSRF-guarded signed POST of an event payload to a single bot URL.
 * Mirrors the embeds fetcher's defense: resolve the hostname, reject
 * private IPs, pin the validated IP at connect time. Fire-and-forget;
 * never throws.
 */
async function postEventToBot(
  url: string,
  secret: string,
  body: unknown,
): Promise<void> {
  const { isPrivateIp } = await import('./embeds');
  const { Agent, fetch: undiciFetch } = await import('undici');
  const { promises: dns } = await import('node:dns');

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return;
  }
  if (parsed.protocol !== 'https:') return;

  // Resolve + SSRF-check.
  let pinned: { ip: string; family: 4 | 6 } | null = null;
  try {
    const records = await dns.lookup(parsed.hostname, { all: true, verbatim: false });
    const ordered = [
      ...records.filter((r) => r.family === 4),
      ...records.filter((r) => r.family === 6),
    ];
    for (const r of ordered) {
      if (!isPrivateIp(r.address)) {
        pinned = { ip: r.address, family: r.family as 4 | 6 };
        break;
      }
    }
  } catch {
    return;
  }
  if (!pinned) return;

  const payload = JSON.stringify(body);
  // True HMAC-SHA256, not a bare hash of secret‖payload: SHA-256 is a
  // Merkle–Damgård construction, so hash(secret.payload) is forgeable via
  // length-extension by anyone who has seen one valid (payload, signature)
  // pair. HMAC is immune by design.
  const signature = createHmac('sha256', secret).update(payload).digest('hex');

  const agent = new Agent({
    connect: {
      lookup: (_h, _o, cb) => cb(null, pinned!.ip, pinned!.family),
    },
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EVENT_FETCH_TIMEOUT_MS);
  try {
    await undiciFetch(parsed.href, {
      method: 'POST',
      signal: controller.signal,
      dispatcher: agent,
      headers: {
        'content-type': 'application/json',
        'user-agent': 'Zekktris-BotEvents/1.0',
        'x-zekktris-event': 'message.create',
        // HMAC-SHA256 of the raw body, keyed by the bot's event secret.
        // The bot recomputes this and compares to authenticate the POST.
        'x-zekktris-signature': signature,
      },
      body: payload,
    });
  } catch {
    // Best-effort — a bot with a dead callback URL just misses events.
  } finally {
    clearTimeout(timer);
    void agent.destroy().catch(() => undefined);
  }
}

/**
 * Deliver a message-create event to every bot that (a) is a member of
 * the guild, (b) can VIEW the channel, (c) has an event URL, and (d)
 * didn't author the message. Bot-authored messages are NOT fanned out
 * at all — that's the loop guard (a bot replying to a bot replying…).
 *
 * Fire-and-forget from the route. Never throws.
 */
export async function deliverMessageEventToBots(args: {
  guildId: bigint | null;
  channelId: bigint;
  authorId: bigint;
  authorIsBot: boolean;
  event: Record<string, unknown>;
}): Promise<void> {
  // Loop guard: don't fan out bot-authored messages to other bots.
  if (args.authorIsBot) return;
  // DM channels have no guild membership model for bots; bots live in
  // guilds only. Skip DM message events.
  if (!args.guildId) return;

  const { and: andOp, eq: eqOp, isNotNull: isNotNullOp } = await import('drizzle-orm');

  // Bots that are members of this guild AND have an event URL.
  const botMembers = await db
    .select({
      id: schema.users.id,
      eventUrl: schema.users.botEventUrl,
      eventSecret: schema.users.botEventSecret,
    })
    .from(schema.guildMembers)
    .innerJoin(schema.users, eqOp(schema.guildMembers.userId, schema.users.id))
    .where(
      andOp(
        eqOp(schema.guildMembers.guildId, args.guildId),
        eqOp(schema.users.isBot, true),
        isNotNullOp(schema.users.botEventUrl),
      ),
    );
  if (botMembers.length === 0) return;

  const { computeMemberChannelPermissions, hasPermission } = await import(
    './permissions'
  );
  const { Permissions } = await import('@zekktris/shared/permissions');

  await Promise.all(
    botMembers.map(async (bot) => {
      // Don't deliver a bot its own message (defensive — author is a
      // human here due to the loop guard, but channel-targeted events
      // could include a bot's own posts in future event types).
      if (bot.id === args.authorId) return;
      if (!bot.eventUrl || !bot.eventSecret) return;
      // Permission gate: only deliver if the bot can view the channel.
      try {
        const perms = await computeMemberChannelPermissions(args.channelId, bot.id);
        if (!hasPermission(perms, Permissions.VIEW_CHANNEL)) return;
      } catch {
        return;
      }
      await postEventToBot(bot.eventUrl, decryptField(bot.eventSecret), args.event);
    }),
  );
}

// ── Slash commands ──────────────────────────────────────────────────────────

const MAX_COMMANDS_PER_BOT = 50;
// Command name: lowercase letters, digits, hyphen, underscore; 1-32 chars.
const COMMAND_NAME_RE = /^[a-z0-9_-]{1,32}$/;

export async function registerBotCommand(args: {
  botId: bigint;
  ownerId: bigint;
  guildId: bigint | null;
  name: string;
  description: string;
}): Promise<schema.BotCommand> {
  await loadOwnedBot(args.botId, args.ownerId);
  const name = args.name.trim().toLowerCase();
  if (!COMMAND_NAME_RE.test(name)) {
    throw errors.badRequest(
      'Command name must be 1-32 chars: lowercase letters, digits, - or _.',
    );
  }
  const description = args.description.trim();
  if (description.length === 0 || description.length > 200) {
    throw errors.badRequest('Description must be 1-200 characters.');
  }

  const count = await db
    .select({ id: schema.botCommands.id })
    .from(schema.botCommands)
    .where(eq(schema.botCommands.botId, args.botId));
  if (count.length >= MAX_COMMANDS_PER_BOT) {
    throw errors.badRequest(`A bot can have at most ${MAX_COMMANDS_PER_BOT} commands.`);
  }

  try {
    const [row] = await db
      .insert(schema.botCommands)
      .values({
        id: nextSnowflake(),
        botId: args.botId,
        guildId: args.guildId,
        name,
        description,
      })
      .returning();
    if (!row) throw errors.internal('Command registration failed');
    return row;
  } catch (e) {
    if ((e as { code?: string }).code === '23505') {
      throw errors.badRequest('A command with that name already exists in this scope.');
    }
    throw e;
  }
}

export async function listBotCommands(
  botId: bigint,
  ownerId: bigint,
): Promise<schema.BotCommand[]> {
  await loadOwnedBot(botId, ownerId);
  return db
    .select()
    .from(schema.botCommands)
    .where(eq(schema.botCommands.botId, botId));
}

export async function deleteBotCommand(
  commandId: bigint,
  ownerId: bigint,
): Promise<void> {
  const [cmd] = await db
    .select()
    .from(schema.botCommands)
    .where(eq(schema.botCommands.id, commandId))
    .limit(1);
  if (!cmd) throw errors.notFound('Command');
  await loadOwnedBot(cmd.botId, ownerId);
  await db.delete(schema.botCommands).where(eq(schema.botCommands.id, commandId));
}

/**
 * Commands available in a guild: every command whose bot is a member
 * of the guild, scoped to (guild_id = this guild) OR (guild_id IS NULL,
 * i.e. global). Returned with the owning bot's display info so the
 * composer can show "/<name> — by <bot>". Used to populate the
 * composer's slash-command picker.
 */
export async function listCommandsForGuild(guildId: bigint): Promise<
  Array<{
    id: string;
    botId: string;
    botName: string;
    name: string;
    description: string;
  }>
> {
  const { and: andOp, eq: eqOp, or: orOp, isNull: isNullOp } = await import(
    'drizzle-orm'
  );
  const rows = await db
    .select({
      id: schema.botCommands.id,
      botId: schema.botCommands.botId,
      name: schema.botCommands.name,
      description: schema.botCommands.description,
      botName: schema.users.displayName,
    })
    .from(schema.botCommands)
    .innerJoin(schema.users, eqOp(schema.botCommands.botId, schema.users.id))
    .innerJoin(
      schema.guildMembers,
      andOp(
        eqOp(schema.guildMembers.userId, schema.botCommands.botId),
        eqOp(schema.guildMembers.guildId, guildId),
      ),
    )
    .where(
      orOp(
        eqOp(schema.botCommands.guildId, guildId),
        isNullOp(schema.botCommands.guildId),
      ),
    );
  return rows.map((r) => ({
    id: r.id.toString(),
    botId: r.botId.toString(),
    botName: r.botName,
    name: r.name,
    description: r.description,
  }));
}

/**
 * Invoke a command: a user ran `/name args` in a channel. We resolve
 * the command, verify the invoking user can view the channel + the
 * bot is a member + can view the channel, then deliver an
 * interaction.create event to the bot. The bot replies via REST.
 *
 * Returns the resolved command name so the route can confirm to the
 * caller. Throws notFound if no such command resolves in this guild.
 */
export async function invokeBotCommand(args: {
  invokerId: bigint;
  guildId: bigint;
  channelId: bigint;
  name: string;
  argText: string;
}): Promise<{ botName: string; commandName: string }> {
  const { and: andOp, eq: eqOp, or: orOp, isNull: isNullOp } = await import(
    'drizzle-orm'
  );
  // Resolve the command: prefer a guild-scoped command over a global
  // one of the same name. Only commands whose bot is a member of this
  // guild are eligible.
  const candidates = await db
    .select({
      id: schema.botCommands.id,
      botId: schema.botCommands.botId,
      guildId: schema.botCommands.guildId,
      name: schema.botCommands.name,
      botName: schema.users.displayName,
      eventUrl: schema.users.botEventUrl,
      eventSecret: schema.users.botEventSecret,
    })
    .from(schema.botCommands)
    .innerJoin(schema.users, eqOp(schema.botCommands.botId, schema.users.id))
    .innerJoin(
      schema.guildMembers,
      andOp(
        eqOp(schema.guildMembers.userId, schema.botCommands.botId),
        eqOp(schema.guildMembers.guildId, args.guildId),
      ),
    )
    .where(
      andOp(
        eqOp(schema.botCommands.name, args.name.toLowerCase()),
        orOp(
          eqOp(schema.botCommands.guildId, args.guildId),
          isNullOp(schema.botCommands.guildId),
        ),
      ),
    );
  if (candidates.length === 0) throw errors.notFound('Command');
  // Guild-scoped wins over global; ties (two bots registering the same
  // command name at the same scope) break by lowest bot id so resolution
  // is STABLE — without an explicit order the row Postgres returns first
  // is plan-dependent, and a shared name like /help could route to a
  // different bot between invocations.
  const cmd = [...candidates].sort((a, b) => {
    const scopeA = a.guildId !== null ? 0 : 1;
    const scopeB = b.guildId !== null ? 0 : 1;
    if (scopeA !== scopeB) return scopeA - scopeB;
    return a.botId < b.botId ? -1 : a.botId > b.botId ? 1 : 0;
  })[0]!;

  // The bot must be able to view the channel to receive the interaction.
  const { computeMemberChannelPermissions, hasPermission } = await import(
    './permissions'
  );
  const { Permissions } = await import('@zekktris/shared/permissions');
  const botPerms = await computeMemberChannelPermissions(
    args.channelId,
    cmd.botId,
  );
  if (!hasPermission(botPerms, Permissions.VIEW_CHANNEL)) {
    throw errors.forbidden('The bot cannot see this channel.');
  }

  // Deliver the interaction event (if the bot has a callback). A bot
  // with commands but no event URL can't actually act — surface that.
  if (!cmd.eventUrl || !cmd.eventSecret) {
    throw errors.badRequest(
      'This bot has no event callback configured, so it cannot receive commands.',
    );
  }
  await postEventToBot(cmd.eventUrl, decryptField(cmd.eventSecret), {
    type: 'interaction.create',
    interaction: {
      command: cmd.name,
      argText: args.argText,
      channelId: args.channelId.toString(),
      guildId: args.guildId.toString(),
      invokerId: args.invokerId.toString(),
    },
  });
  return { botName: cmd.botName, commandName: cmd.name };
}
