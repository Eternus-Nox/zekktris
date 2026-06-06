/**
 * Instance security (Admin → Security)
 * ------------------------------------
 * Two detectors run in the message pipeline, GUILD CHANNELS ONLY — E2EE
 * conversations are exempt by design (content is ciphertext; we do not
 * inspect or meter encrypted DMs at all):
 *
 *  1. Spam throttle. More than `spamMaxMessages` in `spamWindowSeconds`
 *     puts the author in a cooldown: one message per minute for
 *     `spamCooldownSeconds`. Tracked in-memory (resets on API restart,
 *     which is fine — it's a rate limiter, not a sanction), logged to
 *     `security_events` once per cooldown.
 *
 *  2. Banned words. Instance-wide, case-insensitive whole-word match.
 *     Matching messages are rejected before insert and logged with a
 *     content snapshot for review.
 */

import { and, desc, eq, lt } from 'drizzle-orm';
import { db, schema } from '@zekktris/db';
import { nextSnowflake } from '../snowflake';
import { errors } from '../errors';

// ── Config + word list caches (refreshed at most every 15s) ────────────────

interface SecurityConfig {
  spamEnabled: boolean;
  spamMaxMessages: number;
  spamWindowSeconds: number;
  spamCooldownSeconds: number;
  wordFilterEnabled: boolean;
}

let configCache: SecurityConfig | null = null;
let configCacheAt = 0;
let wordsCache: RegExp | null = null;
let wordsCacheAt = 0;
const CACHE_MS = 15_000;

export async function getConfig(): Promise<SecurityConfig> {
  if (configCache && Date.now() - configCacheAt < CACHE_MS) return configCache;
  const [row] = await db.select().from(schema.securityConfig).limit(1);
  configCache = row ?? {
    spamEnabled: true,
    spamMaxMessages: 8,
    spamWindowSeconds: 10,
    spamCooldownSeconds: 600,
    wordFilterEnabled: true,
  };
  configCacheAt = Date.now();
  return configCache;
}

export async function updateConfig(patch: Partial<SecurityConfig>): Promise<SecurityConfig> {
  await db
    .insert(schema.securityConfig)
    .values({ id: 1, ...patch })
    .onConflictDoUpdate({ target: schema.securityConfig.id, set: patch });
  configCache = null;
  return getConfig();
}

/** Compiled whole-word matcher over the banned list, or null when empty. */
async function bannedWordsRegex(): Promise<RegExp | null> {
  if (Date.now() - wordsCacheAt < CACHE_MS) return wordsCache;
  const rows = await db.select().from(schema.securityBannedWords);
  wordsCacheAt = Date.now();
  if (rows.length === 0) {
    wordsCache = null;
    return null;
  }
  const escaped = rows.map((r) => r.word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  wordsCache = new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
  return wordsCache;
}

export async function listBannedWords(): Promise<string[]> {
  const rows = await db
    .select()
    .from(schema.securityBannedWords)
    .orderBy(schema.securityBannedWords.word);
  return rows.map((r) => r.word);
}

export async function addBannedWord(word: string, addedBy: bigint): Promise<void> {
  const normalized = word.trim().toLowerCase();
  if (!normalized) throw errors.badRequest('Word is empty');
  if (normalized.length > 64) throw errors.badRequest('Word too long');
  await db
    .insert(schema.securityBannedWords)
    .values({ word: normalized, addedBy })
    .onConflictDoNothing();
  wordsCacheAt = 0;
}

export async function removeBannedWord(word: string): Promise<void> {
  await db
    .delete(schema.securityBannedWords)
    .where(eq(schema.securityBannedWords.word, word.trim().toLowerCase()));
  wordsCacheAt = 0;
}

// ── Event log ───────────────────────────────────────────────────────────────

export async function logEvent(input: {
  kind: 'spam_limited' | 'banned_word';
  userId: bigint;
  guildId: bigint | null;
  channelId: bigint | null;
  detail: string;
  contentSnapshot?: string | null;
}): Promise<void> {
  await db.insert(schema.securityEvents).values({
    id: nextSnowflake(),
    kind: input.kind,
    userId: input.userId,
    guildId: input.guildId,
    channelId: input.channelId,
    detail: input.detail,
    contentSnapshot: input.contentSnapshot ?? null,
  });
}

export async function listEvents(opts: {
  kind?: 'spam_limited' | 'banned_word';
  before?: bigint;
  limit?: number;
}) {
  const conds = [];
  if (opts.kind) conds.push(eq(schema.securityEvents.kind, opts.kind));
  if (opts.before) conds.push(lt(schema.securityEvents.id, opts.before));
  const rows = await db
    .select({
      id: schema.securityEvents.id,
      kind: schema.securityEvents.kind,
      userId: schema.securityEvents.userId,
      guildId: schema.securityEvents.guildId,
      channelId: schema.securityEvents.channelId,
      detail: schema.securityEvents.detail,
      contentSnapshot: schema.securityEvents.contentSnapshot,
      createdAt: schema.securityEvents.createdAt,
      username: schema.users.username,
      displayName: schema.users.displayName,
    })
    .from(schema.securityEvents)
    .leftJoin(schema.users, eq(schema.securityEvents.userId, schema.users.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(schema.securityEvents.id))
    .limit(Math.min(opts.limit ?? 50, 100));
  return rows.map((r) => ({
    id: r.id.toString(),
    kind: r.kind,
    userId: r.userId?.toString() ?? null,
    username: r.username,
    displayName: r.displayName,
    guildId: r.guildId?.toString() ?? null,
    channelId: r.channelId?.toString() ?? null,
    detail: r.detail,
    contentSnapshot: r.contentSnapshot,
    createdAt: r.createdAt.toISOString(),
  }));
}

// ── Spam throttle (in-memory) ───────────────────────────────────────────────

interface SpamState {
  /** Send timestamps within the rolling window (ms). */
  recent: number[];
  /** While set (epoch ms), the user is in cooldown until this time. */
  cooldownUntil: number;
  /** Last send during cooldown — enforces the 1/minute trickle. */
  lastDuringCooldown: number;
  /** Whether this cooldown was already logged (one event per cooldown). */
  logged: boolean;
}

const spamByUser = new Map<string, SpamState>();

/**
 * Gatekeeper for guild messages. Throws 429 when the author is throttled;
 * silently records the send otherwise. Call AFTER permission checks and
 * ONLY for non-E2EE guild channels.
 */
export async function checkSpam(args: {
  userId: bigint;
  guildId: bigint | null;
  channelId: bigint;
}): Promise<void> {
  const cfg = await getConfig();
  if (!cfg.spamEnabled) return;

  const key = args.userId.toString();
  const now = Date.now();
  const st = spamByUser.get(key) ?? {
    recent: [],
    cooldownUntil: 0,
    lastDuringCooldown: 0,
    logged: false,
  };

  if (st.cooldownUntil > now) {
    // One message per minute while cooling down.
    if (now - st.lastDuringCooldown < 60_000) {
      const wait = Math.ceil((60_000 - (now - st.lastDuringCooldown)) / 1000);
      throw errors.badRequest(
        `You're sending messages too fast — you can send again in ${wait}s.`,
      );
    }
    st.lastDuringCooldown = now;
    spamByUser.set(key, st);
    return;
  }

  const windowMs = cfg.spamWindowSeconds * 1000;
  st.recent = st.recent.filter((t) => now - t < windowMs);
  st.recent.push(now);

  if (st.recent.length > cfg.spamMaxMessages) {
    st.cooldownUntil = now + cfg.spamCooldownSeconds * 1000;
    st.lastDuringCooldown = now;
    st.recent = [];
    if (!st.logged) {
      st.logged = true;
      void logEvent({
        kind: 'spam_limited',
        userId: args.userId,
        guildId: args.guildId,
        channelId: args.channelId,
        detail: `Sent >${cfg.spamMaxMessages} messages in ${cfg.spamWindowSeconds}s — limited to 1/min for ${Math.round(cfg.spamCooldownSeconds / 60)}m`,
      }).catch(() => {});
    }
    spamByUser.set(key, st);
    // The triggering message still sends (it's the N+1th); the NEXT one
    // hits the cooldown gate above.
    return;
  }
  st.logged = false;
  spamByUser.set(key, st);
}

/**
 * Banned-word gate for guild messages (plaintext only — never E2EE).
 * Throws 400 and logs a report when the content matches.
 */
export async function checkBannedWords(args: {
  userId: bigint;
  guildId: bigint | null;
  channelId: bigint;
  content: string | null | undefined;
}): Promise<void> {
  const cfg = await getConfig();
  if (!cfg.wordFilterEnabled) return;
  const content = args.content ?? '';
  if (!content) return;
  const re = await bannedWordsRegex();
  if (!re) return;
  const match = re.exec(content);
  if (!match) return;
  void logEvent({
    kind: 'banned_word',
    userId: args.userId,
    guildId: args.guildId,
    channelId: args.channelId,
    detail: `Blocked message containing banned word: "${match[1].toLowerCase()}"`,
    contentSnapshot: content.slice(0, 500),
  }).catch(() => {});
  throw errors.badRequest('Your message contains a word that is not allowed on this server.');
}
