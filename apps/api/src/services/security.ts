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

import { and, desc, eq, like, lt } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { db, schema } from '../db';
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
// Two severity-tiered matchers: 'blocked' (hard block) + 'watch' (log only).
let blockedCache: RegExp | null = null;
let watchCache: RegExp | null = null;
let wordsCacheAt = 0;
const CACHE_MS = 15_000;

export async function getConfig(): Promise<SecurityConfig> {
  if (configCache && Date.now() - configCacheAt < CACHE_MS) return configCache;
  let row: SecurityConfig | undefined;
  try {
    [row] = await db.select().from(schema.securityConfig).limit(1);
  } catch {
    // Table missing (migration 0073 not applied yet): run with defaults
    // but DISABLE the detectors — a half-deployed security system must
    // never block messaging.
    configCache = {
      spamEnabled: false,
      spamMaxMessages: 8,
      spamWindowSeconds: 10,
      spamCooldownSeconds: 600,
      wordFilterEnabled: false,
    };
    configCacheAt = Date.now();
    return configCache;
  }
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

export type WordSeverity = 'blocked' | 'watch';

/** Compile a whole-word, case-insensitive matcher, or null for an empty list. */
function compileWords(words: string[]): RegExp | null {
  if (words.length === 0) return null;
  const escaped = words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return new RegExp(`\\b(${escaped.join('|')})\\b`, 'i');
}

/**
 * Refresh + return both severity-tiered matchers from the DB (cached ~15s).
 * Unknown/missing severity is treated as 'blocked' so a half-migrated row can
 * never silently stop being enforced.
 */
async function loadWordMatchers(): Promise<{ blocked: RegExp | null; watch: RegExp | null }> {
  if (Date.now() - wordsCacheAt < CACHE_MS) return { blocked: blockedCache, watch: watchCache };
  let rows: Array<{ word: string; severity: string }> = [];
  try {
    rows = await db
      .select({ word: schema.securityBannedWords.word, severity: schema.securityBannedWords.severity })
      .from(schema.securityBannedWords);
  } catch {
    // Table/column missing — treat as an empty list; never block sends.
    wordsCacheAt = Date.now();
    blockedCache = null;
    watchCache = null;
    return { blocked: null, watch: null };
  }
  wordsCacheAt = Date.now();
  blockedCache = compileWords(rows.filter((r) => r.severity !== 'watch').map((r) => r.word));
  watchCache = compileWords(rows.filter((r) => r.severity === 'watch').map((r) => r.word));
  return { blocked: blockedCache, watch: watchCache };
}

export async function listBannedWords(): Promise<Array<{ word: string; severity: WordSeverity }>> {
  const rows = await db
    .select({ word: schema.securityBannedWords.word, severity: schema.securityBannedWords.severity })
    .from(schema.securityBannedWords)
    .orderBy(schema.securityBannedWords.word);
  return rows.map((r) => ({ word: r.word, severity: r.severity === 'watch' ? 'watch' : 'blocked' }));
}

export async function addBannedWord(
  word: string,
  severity: WordSeverity,
  addedBy: bigint,
): Promise<void> {
  const normalized = word.trim().toLowerCase();
  if (!normalized) throw errors.badRequest('Word is empty');
  if (normalized.length > 64) throw errors.badRequest('Word too long');
  // Upsert so re-adding a word with a different severity MOVES it between the
  // blocked and watch lists rather than silently doing nothing.
  await db
    .insert(schema.securityBannedWords)
    .values({ word: normalized, severity, addedBy })
    .onConflictDoUpdate({ target: schema.securityBannedWords.word, set: { severity } });
  wordsCacheAt = 0;
}

export async function removeBannedWord(word: string): Promise<void> {
  await db
    .delete(schema.securityBannedWords)
    .where(eq(schema.securityBannedWords.word, word.trim().toLowerCase()));
  wordsCacheAt = 0;
}

/**
 * Bulk-load the common preset (insert-only; existing entries keep their
 * severity, duplicates skipped). Slurs file as 'blocked', general profanity as
 * 'watch'. Returns how many new words were added.
 */
export async function addPresetWords(addedBy: bigint | null): Promise<number> {
  const { BLOCKED_WORDS_PRESET, WATCH_WORDS_PRESET } = await import('../data/bannedWordsPreset');
  const mk = (list: string[], severity: WordSeverity) =>
    list
      .map((w) => w.trim().toLowerCase())
      .filter((w) => w.length > 0 && w.length <= 64)
      .map((word) => ({ word, severity, addedBy }));
  const values = [...mk(BLOCKED_WORDS_PRESET, 'blocked'), ...mk(WATCH_WORDS_PRESET, 'watch')];
  if (values.length === 0) return 0;
  const inserted = await db
    .insert(schema.securityBannedWords)
    .values(values)
    .onConflictDoNothing()
    .returning({ word: schema.securityBannedWords.word });
  wordsCacheAt = 0;
  return inserted.length;
}

/**
 * First-boot seed of the banned-words list.
 *
 * `wordFilterEnabled` defaults to TRUE, but the word list itself was only ever
 * populated by an admin pressing "add preset words" in the Security tab. Until
 * someone did, `loadWordMatchers()` compiled nothing and `containsListedWord()`
 * returned null for every input — so on a fresh instance the identity
 * profanity bar (usernames, display names, guild nicknames, clan tags) and the
 * AutoMod word tier were silently inert. A safety feature that is off until
 * someone finds a button is not a safety feature.
 *
 * Seeds only when the table is COMPLETELY empty, so an operator's own
 * additions and removals are never overwritten. Note the deliberate
 * trade-off: an admin who removes every word will get the presets back on the
 * next restart. Emptying the list entirely is indistinguishable from a fresh
 * install; to run with no word filter, turn `wordFilterEnabled` off instead.
 *
 * `addedBy` is null — this is a system action, not an admin's.
 */
export async function seedPresetWordsIfEmpty(): Promise<number> {
  const existing = await db
    .select({ word: schema.securityBannedWords.word })
    .from(schema.securityBannedWords)
    .limit(1);
  if (existing.length > 0) return 0;
  return addPresetWords(null);
}

/**
 * True (returning the matched word) if `text` contains ANY listed word —
 * blocked OR watch. Used to keep identity fields (usernames, display names,
 * guild nicknames, clan tags) free of vulgar words entirely, per the
 * instance-wide identity policy. Respects the master wordFilterEnabled switch.
 */
export async function containsListedWord(text: string | null | undefined): Promise<string | null> {
  const cfg = await getConfig();
  if (!cfg.wordFilterEnabled) return null;
  const v = text ?? '';
  if (!v) return null;
  const { blocked, watch } = await loadWordMatchers();
  for (const re of [blocked, watch]) {
    if (!re) continue;
    const m = re.exec(v);
    if (m) return (m[1] ?? m[0]).toLowerCase();
  }
  return null;
}

// ── Event log ───────────────────────────────────────────────────────────────

/** Automated detections + staff-action audit kinds ('staff_' prefix). */
export type SecurityEventKind =
  | 'spam_limited'
  | 'banned_word'
  | 'watch_word'
  /**
   * One session recovered the same refresh chain across enough separate
   * rotations that it stopped looking like a network fault. Raised by
   * auth/refresh-replay.ts (see noteRecoveredRotation for the threshold, the
   * window, and why they are what they are). userId is the session's OWNER —
   * the potential victim, not an offender — and there is no actor: this is an
   * automated detection, like the two above. The session id, the count, the
   * window and the User-Agent hash are in `detail`; no token material, no
   * sealed blob, no raw User-Agent is ever recorded.
   *
   * `kind` is a plain text column (see packages/db/src/schema/security.ts), not
   * a pg enum, so adding this value is a type-level change only — no migration.
   */
  | 'refresh_replay_repeated'
  | 'staff_ban'
  | 'staff_unban'
  | 'staff_logout'
  | 'staff_gift'
  | 'staff_membership_reset'
  | 'staff_dob_reset'
  | 'staff_role_change'
  | 'staff_monetization'
  | 'staff_observe'
  | 'staff_guild_delete'
  | 'staff_user_delete'
  /** A user closed their OWN account via DELETE /users/@me. */
  | 'user_self_delete';

export async function logEvent(input: {
  kind: SecurityEventKind;
  /** Event TARGET (message author / actioned user); null for guild-only. */
  userId: bigint | null;
  /** WHO performed a staff action; omit for automated detections. */
  actorId?: bigint | null;
  guildId: bigint | null;
  channelId: bigint | null;
  detail: string;
  contentSnapshot?: string | null;
}): Promise<void> {
  await db.insert(schema.securityEvents).values({
    id: nextSnowflake(),
    kind: input.kind,
    userId: input.userId,
    actorId: input.actorId ?? null,
    guildId: input.guildId,
    channelId: input.channelId,
    detail: input.detail,
    contentSnapshot: input.contentSnapshot ?? null,
  });
}

export async function listEvents(opts: {
  /** Exact kind, or the 'staff' meta-filter (all staff_* audit kinds). */
  kind?: string;
  before?: bigint;
  limit?: number;
}) {
  const actor = alias(schema.users, 'actor');
  const conds = [];
  if (opts.kind === 'staff') {
    conds.push(like(schema.securityEvents.kind, 'staff\\_%'));
  } else if (opts.kind) {
    conds.push(eq(schema.securityEvents.kind, opts.kind));
  }
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
      actorId: schema.securityEvents.actorId,
      actorUsername: actor.username,
      actorDisplayName: actor.displayName,
    })
    .from(schema.securityEvents)
    .leftJoin(schema.users, eq(schema.securityEvents.userId, schema.users.id))
    .leftJoin(actor, eq(schema.securityEvents.actorId, actor.id))
    .where(conds.length > 0 ? and(...conds) : undefined)
    .orderBy(desc(schema.securityEvents.id))
    .limit(Math.min(opts.limit ?? 50, 100));
  return rows.map((r) => ({
    id: r.id.toString(),
    kind: r.kind,
    userId: r.userId?.toString() ?? null,
    username: r.username,
    displayName: r.displayName,
    actorId: r.actorId?.toString() ?? null,
    actorUsername: r.actorUsername,
    actorDisplayName: r.actorDisplayName,
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

// Eviction sweep: the map gains one entry per user who ever sends a guild
// message and nothing removed them — unbounded growth over a long uptime.
// Entries idle for an hour (no recent sends, cooldown expired) are dropped;
// the limiter rebuilds them on the next send. unref() keeps the timer from
// holding the process open in tests.
const SPAM_IDLE_EVICT_MS = 60 * 60 * 1000;
const spamSweep = setInterval(() => {
  const cutoff = Date.now() - SPAM_IDLE_EVICT_MS;
  for (const [key, st] of spamByUser) {
    const lastActivity = Math.max(
      st.cooldownUntil,
      st.lastDuringCooldown,
      st.recent.length > 0 ? st.recent[st.recent.length - 1]! : 0,
    );
    if (lastActivity < cutoff) spamByUser.delete(key);
  }
}, 10 * 60 * 1000);
spamSweep.unref?.();

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
  const { blocked, watch } = await loadWordMatchers();

  // BLOCKED tier (slurs etc.) — reject the message.
  if (blocked) {
    const match = blocked.exec(content);
    if (match) {
      void logEvent({
        kind: 'banned_word',
        userId: args.userId,
        guildId: args.guildId,
        channelId: args.channelId,
        detail: `Blocked message containing banned word: "${(match[1] ?? match[0]).toLowerCase()}"`,
        contentSnapshot: content.slice(0, 500),
      }).catch(() => {});
      throw errors.badRequest('Your message contains a word that is not allowed on this server.');
    }
  }

  // WATCH tier (general profanity) — log only, DO NOT block. Lets moderators
  // see usage without gating the message.
  if (watch) {
    const match = watch.exec(content);
    if (match) {
      void logEvent({
        kind: 'watch_word',
        userId: args.userId,
        guildId: args.guildId,
        channelId: args.channelId,
        detail: `Watch-word used: "${(match[1] ?? match[0]).toLowerCase()}"`,
        contentSnapshot: content.slice(0, 500),
      }).catch(() => {});
    }
  }
}
