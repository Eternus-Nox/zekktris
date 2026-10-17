/**
 * Automod
 * -------
 * Per-guild moderation rules that run on every message send and
 * reject content matching configured patterns.
 *
 * Rule types in this revision:
 *   - word_blocklist : reject if message contains any listed phrase
 *                      (case-insensitive, word-boundary matched)
 *
 * Reserved by the schema for follow-up revisions:
 *   - repeat_message : N identical sends within window_seconds
 *   - mention_spam   : N user/role mentions in one message
 *
 * Performance notes
 * -----------------
 * The hot path is `checkMessage`, which runs once per message send in
 * any guild with automod configured. The DB read is an index-only scan
 * on the partial index (`enabled = true`); zero-row guilds pay only
 * the index probe.
 *
 * We deliberately do NOT cache rules in memory yet. The invalidation
 * surface (create / update / delete plus role-exemption changes) is
 * easy to get wrong, and the single indexed query is already cheap
 * for the throughput we're targeting. If profiling later shows this
 * becoming a bottleneck, an LRU<guildId, Rules[]> here with cache
 * busting in the CRUD helpers is the natural retrofit.
 *
 * Pattern matching
 * ----------------
 * Word-boundary regex, case-insensitive. Pattern strings are
 * regex-escaped before splicing so special characters in admin input
 * (`?`, `$`, `[`, etc.) don't blow up or behave unexpectedly. The
 * `\b` anchors mean a pattern of "ass" matches "ass" but not "class"
 * — the intuitive default. Admins who want partial-string matching
 * can include the partials in their patterns explicitly.
 */

import { and, eq } from 'drizzle-orm';
import safe from 'safe-regex';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';
import { errors } from '../errors';
import { writeAudit } from './audit';

export type AutomodAction = 'block' | 'block_and_timeout' | 'log_only';
export type AutomodRuleType =
  | 'word_blocklist'
  | 'regex_pattern'
  | 'link_filter'
  | 'repeat_message'
  | 'mention_spam';

export interface CreateRuleInput {
  guildId: bigint;
  actorId: bigint;
  name: string;
  ruleType: AutomodRuleType;
  patterns?: string[];
  threshold?: number | null;
  windowSeconds?: number | null;
  action?: AutomodAction;
  timeoutSeconds?: number | null;
  exemptRoleIds?: string[];
  exemptChannelIds?: string[];
}

export interface UpdateRuleInput {
  actorId: bigint;
  name?: string;
  enabled?: boolean;
  patterns?: string[];
  threshold?: number | null;
  windowSeconds?: number | null;
  action?: AutomodAction;
  timeoutSeconds?: number | null;
  exemptRoleIds?: string[];
  exemptChannelIds?: string[];
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export async function listGuildRules(guildId: bigint): Promise<schema.AutomodRule[]> {
  return db
    .select()
    .from(schema.automodRules)
    .where(eq(schema.automodRules.guildId, guildId));
}

export async function createRule(input: CreateRuleInput): Promise<schema.AutomodRule> {
  assertPatternsSafe(input.ruleType, input.patterns);
  const id = nextSnowflake();
  const [row] = await db
    .insert(schema.automodRules)
    .values({
      id,
      guildId: input.guildId,
      name: input.name,
      ruleType: input.ruleType,
      patterns: input.patterns ?? [],
      threshold: input.threshold ?? null,
      windowSeconds: input.windowSeconds ?? null,
      action: input.action ?? 'block',
      timeoutSeconds: input.timeoutSeconds ?? null,
      exemptRoleIds: input.exemptRoleIds ?? [],
      exemptChannelIds: input.exemptChannelIds ?? [],
    })
    .returning();
  if (!row) throw errors.internal('Failed to create automod rule');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: 'automod.rule_create',
    targetType: 'automod_rule',
    targetId: id,
    changes: { name: input.name, ruleType: input.ruleType },
  });

  return row;
}

export async function updateRule(
  ruleId: bigint,
  guildId: bigint,
  input: UpdateRuleInput,
): Promise<schema.AutomodRule> {
  // Validate updated regex patterns against the rule's stored type (which the
  // patch can't change). One cheap lookup, only when patterns are touched.
  if (input.patterns !== undefined) {
    const [existing] = await db
      .select({ ruleType: schema.automodRules.ruleType })
      .from(schema.automodRules)
      .where(
        and(
          eq(schema.automodRules.id, ruleId),
          eq(schema.automodRules.guildId, guildId),
        ),
      )
      .limit(1);
    if (existing) {
      assertPatternsSafe(existing.ruleType as AutomodRuleType, input.patterns);
    }
  }

  // Build the patch object — only include fields the caller actually
  // specified. Using `undefined`-passthrough with Drizzle's `set` is
  // tempting but cleaner to be explicit so we don't accidentally
  // clear nullable columns on an unspecified update.
  const patch: Partial<typeof schema.automodRules.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) patch.name = input.name;
  if (input.enabled !== undefined) patch.enabled = input.enabled;
  if (input.patterns !== undefined) patch.patterns = input.patterns;
  if (input.threshold !== undefined) patch.threshold = input.threshold;
  if (input.windowSeconds !== undefined) patch.windowSeconds = input.windowSeconds;
  if (input.action !== undefined) patch.action = input.action;
  if (input.timeoutSeconds !== undefined) patch.timeoutSeconds = input.timeoutSeconds;
  if (input.exemptRoleIds !== undefined) patch.exemptRoleIds = input.exemptRoleIds;
  if (input.exemptChannelIds !== undefined) patch.exemptChannelIds = input.exemptChannelIds;

  const [row] = await db
    .update(schema.automodRules)
    .set(patch)
    .where(
      and(
        eq(schema.automodRules.id, ruleId),
        eq(schema.automodRules.guildId, guildId),
      ),
    )
    .returning();
  if (!row) throw errors.notFound('Automod rule');

  await writeAudit({
    guildId,
    actorId: input.actorId,
    action: 'automod.rule_update',
    targetType: 'automod_rule',
    targetId: ruleId,
    changes: input as unknown as Record<string, unknown>,
  });

  return row;
}

export async function deleteRule(ruleId: bigint, guildId: bigint, actorId: bigint): Promise<void> {
  const result = await db
    .delete(schema.automodRules)
    .where(
      and(
        eq(schema.automodRules.id, ruleId),
        eq(schema.automodRules.guildId, guildId),
      ),
    )
    .returning({ id: schema.automodRules.id });
  if (result.length === 0) throw errors.notFound('Automod rule');

  await writeAudit({
    guildId,
    actorId,
    action: 'automod.rule_delete',
    targetType: 'automod_rule',
    targetId: ruleId,
  });
}

// ── Enforcement ─────────────────────────────────────────────────────────────

/**
 * Check a message against all enabled automod rules for a guild.
 * Returns the FIRST matching rule (we don't keep scanning after a hit
 * — one violation is enough to reject the message, and stopping early
 * keeps the common "no violation" case as fast as possible).
 *
 * Returns null when no rule matches (the common path).
 */
export async function checkMessage(args: {
  guildId: bigint;
  channelId: bigint;
  userId: bigint;
  content: string;
  memberRoleIds: bigint[];
  /** Set for a webhook execute (`userId` is then the webhook's creator). */
  webhookId?: bigint;
  /** Set when `content` is not stored as message content (a forum post's
   *  title, a thread name, a poll's text, a forward's snapshot, a bot
   *  command's arguments): repeat_message is skipped, because it compares
   *  against the author's stored messages and would match text that merely
   *  restates one of them. */
  skipRepeatMessage?: boolean;
}): Promise<schema.AutomodRule | null> {
  // Index-only scan on the partial index. Zero-rule guilds pay only
  // the index probe + nothing-to-iterate cost.
  const rules = await db
    .select()
    .from(schema.automodRules)
    .where(
      and(
        eq(schema.automodRules.guildId, args.guildId),
        eq(schema.automodRules.enabled, true),
      ),
    );
  if (rules.length === 0) return null;

  const memberRoleStrings = new Set(args.memberRoleIds.map((r) => r.toString()));
  const channelIdString = args.channelId.toString();

  for (const rule of rules) {
    // Channel exemption: skip the rule entirely when the current
    // channel id is in the exempt list. Common case: profanity
    // allowed in #shitposting but blocked everywhere else.
    if (rule.exemptChannelIds.includes(channelIdString)) {
      continue;
    }
    // Role exemption: any overlap between the member's roles and
    // the rule's exempt set is sufficient to bypass this rule. The
    // member can still trip OTHER rules — exemption is per-rule.
    if (rule.exemptRoleIds.some((id) => memberRoleStrings.has(id))) {
      continue;
    }

    if (rule.ruleType === 'word_blocklist') {
      if (messageMatchesPatterns(args.content, rule.patterns)) {
        return rule;
      }
    }

    if (rule.ruleType === 'regex_pattern') {
      // Raw regex match — no word-boundary wrapping. Patterns are
      // case-insensitive by default; admins can use (?i) / (?-i)
      // flags inline if they want different behavior. Invalid
      // regex (admin typo) is skipped silently — we don't want a
      // broken rule to crash the message-send path.
      if (messageMatchesRegexes(args.content, rule.patterns)) {
        return rule;
      }
    }

    if (rule.ruleType === 'link_filter') {
      if (messageMatchesLinkFilter(args.content, rule.patterns)) {
        return rule;
      }
    }

    if (rule.ruleType === 'mention_spam') {
      // Threshold: count user mentions + role mentions + mass
      // mentions (@everyone, @here). When the total is at or above
      // the rule's threshold, fire. Null/missing threshold disables
      // the rule (treated as no-op) rather than firing on every
      // message — defensive against a half-configured rule.
      if (rule.threshold && rule.threshold > 0) {
        const count = countMentions(args.content);
        if (count >= rule.threshold) {
          return rule;
        }
      }
    }

    // Webhooks skip repeat_message: it is a per-member flood rule, while an
    // integration's output repeats by nature ("Build passed") and webhooks
    // are rate-limited per webhook instead. The member history below also
    // excludes webhook posts, which are stored under the creator's id.
    // Text that is not stored as a message skips it too (skipRepeatMessage).
    if (
      rule.ruleType === 'repeat_message' &&
      args.webhookId === undefined &&
      !args.skipRepeatMessage
    ) {
      // Threshold = how many identical messages within windowSeconds
      // triggers the rule. The current send counts as one of them,
      // so we need (threshold - 1) prior matches in history.
      if (
        rule.threshold &&
        rule.threshold > 0 &&
        rule.windowSeconds &&
        rule.windowSeconds > 0
      ) {
        const normalized = args.content.trim().toLowerCase();
        if (normalized.length === 0) continue;
        const { listRecentContentByAuthor } = await import('./messages');
        const recent = await listRecentContentByAuthor(
          args.userId,
          args.guildId,
          rule.windowSeconds,
        );
        let priorMatches = 0;
        for (const r of recent) {
          if (r.trim().toLowerCase() === normalized) priorMatches++;
          if (priorMatches >= rule.threshold - 1) {
            return rule;
          }
        }
      }
    }
  }

  return null;
}

// Pre-compiled regexes for the mention-spam scanner. These are
// matched against every message-send in any guild that has a
// mention-spam rule, so compile-once-at-module-load is worth the
// few microseconds saved per call.
//
// User mention: <@123...> or <@!123...> (the legacy nickname form)
// Role mention: <@&123...>
// Mass mention: @everyone or @here as a literal substring
const USER_MENTION_RE = /<@!?\d+>/g;
const ROLE_MENTION_RE = /<@&\d+>/g;
const MASS_MENTION_RE = /@(?:everyone|here)/g;

/**
 * Count the user mentions + role mentions + mass mentions in a
 * message body. Used by mention_spam. Exported for testing.
 *
 * Mass mentions count as 1 each rather than getting a weighted
 * boost — admins set thresholds with that scale in mind, and the
 * UI surfaces "threshold N mentions" as a simple integer.
 */
export function countMentions(content: string): number {
  const userMatches = content.match(USER_MENTION_RE);
  const roleMatches = content.match(ROLE_MENTION_RE);
  const massMatches = content.match(MASS_MENTION_RE);
  return (
    (userMatches?.length ?? 0) +
    (roleMatches?.length ?? 0) +
    (massMatches?.length ?? 0)
  );
}

/**
 * Case-insensitive, word-boundary substring match. True if any
 * pattern matches anywhere in the content. Used by word_blocklist.
 *
 * Exported for unit testing — and so the future repeat_message rule
 * type can reuse the same primitive when it grows pattern support.
 */
// Compiled word-boundary regexes for word_blocklist patterns, keyed by the
// trimmed raw pattern. Mirrors compiledPatternCache (same size cap + clear on
// overflow) so the far-more-common blocklist path stops recompiling every
// pattern on every message. Escaped literals can't backtrack (no ReDoS/safe-
// regex concern); the 'i'-only flag (no 'g'/'y') means a reused RegExp's
// .test() is stateless, so caching is behavior-preserving.
const blocklistPatternCache = new Map<string, RegExp>();
const BLOCKLIST_PATTERN_CACHE_MAX = 2000;

function compileWordBoundary(pat: string): RegExp {
  const cached = blocklistPatternCache.get(pat);
  if (cached !== undefined) return cached;
  const rx = new RegExp(`\\b${escapeRegex(pat)}\\b`, 'i');
  if (blocklistPatternCache.size >= BLOCKLIST_PATTERN_CACHE_MAX) {
    blocklistPatternCache.clear();
  }
  blocklistPatternCache.set(pat, rx);
  return rx;
}

export function messageMatchesPatterns(content: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  for (const raw of patterns) {
    const pat = raw.trim();
    if (pat.length === 0) continue;
    // Word-boundary regex, case-insensitive. Patterns containing
    // whitespace (multi-word phrases) drop the leading/trailing \b
    // anchors at the spaces — \b doesn't fire mid-phrase the way
    // we'd want — so phrases match wherever they appear as a
    // contiguous substring with word boundaries at both ends.
    // Compiled once and cached (see compileWordBoundary).
    if (compileWordBoundary(pat).test(content)) return true;
  }
  return false;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Whether an admin-supplied regex is SAFE to run on the message-send hot
 * path — i.e. free of catastrophic-backtracking ("ReDoS") shapes. Automod
 * regex rules run inline on every guild message, single-threaded; a pattern
 * like `(a+)+$` against a crafted input can pin the event loop and stall
 * EVERY request + gateway frame on the replica (cross-tenant DoS). `safe`
 * (safe-regex) bounds repetition star-height — the classic ReDoS guard.
 *
 * Exported so rule create/update validation rejects exactly the patterns the
 * runtime would skip (consistent admin feedback). Empty patterns are no-ops
 * (safe); an unparseable pattern is treated as unsafe (it can't run anyway).
 */
export function isSafeRegexPattern(pattern: string): boolean {
  const pat = pattern.trim();
  if (pat.length === 0) return true;
  try {
    return safe(pat);
  } catch {
    return false;
  }
}

/**
 * Reject ReDoS-prone patterns for `regex_pattern` rules with a clear,
 * admin-facing error at create/update time (the runtime would otherwise
 * silently skip them, which reads as "my rule doesn't work"). No-op for the
 * other rule types, whose "patterns" are literal keywords / domains compiled
 * with escaping, never as raw user regex.
 */
export function assertPatternsSafe(
  ruleType: AutomodRuleType,
  patterns: string[] | undefined,
): void {
  if (ruleType !== 'regex_pattern' || !patterns) return;
  for (const p of patterns) {
    if (!isSafeRegexPattern(p)) {
      throw errors.badRequest(
        `Unsafe regex pattern rejected — it could cause catastrophic backtracking (ReDoS): ${p
          .trim()
          .slice(0, 80)}`,
      );
    }
  }
}

// Compiled-pattern cache for the regex automod rules. Keyed by the raw
// (trimmed) pattern → its compiled RegExp, or null when the pattern is unsafe
// (ReDoS-prone) or invalid, so it's permanently skipped. This (a) neutralizes
// any catastrophic pattern already stored before the create-time guard
// existed — it's checked with `safe()` BEFORE we ever construct/run it — and
// (b) avoids re-running the safety check + recompiling on every message.
const compiledPatternCache = new Map<string, RegExp | null>();
const COMPILED_PATTERN_CACHE_MAX = 2000;

function compilePattern(raw: string): RegExp | null {
  const pat = raw.trim();
  if (pat.length === 0) return null;
  const cached = compiledPatternCache.get(pat);
  if (cached !== undefined) return cached;
  let rx: RegExp | null = null;
  // ReDoS guard FIRST — never run (or even construct) a pattern that could
  // pin the event loop, even if it slipped into storage before validation.
  if (isSafeRegexPattern(pat)) {
    try {
      rx = new RegExp(pat, 'i');
    } catch {
      rx = null; // invalid (admin typo / unsupported feature) → skip
    }
  }
  if (compiledPatternCache.size >= COMPILED_PATTERN_CACHE_MAX) {
    compiledPatternCache.clear();
  }
  compiledPatternCache.set(pat, rx);
  return rx;
}

/**
 * Raw regex match — true if any pattern matches anywhere in the content.
 * Patterns are compiled (case-insensitive) once and cached. ReDoS-prone or
 * invalid patterns are SKIPPED rather than crashing or stalling the send
 * path — see compilePattern / isSafeRegexPattern.
 *
 * Exported for testing.
 */
export function messageMatchesRegexes(content: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  for (const raw of patterns) {
    const rx = compilePattern(raw);
    if (rx && rx.test(content)) return true;
  }
  return false;
}

/**
 * URL match expression. Catches http(s) and bare-host URLs. We
 * intentionally don't try to be RFC-compliant here — the goal is
 * to find SOMETHING that looks like a domain so we can compare it
 * against the blocklist. Edge cases (IDN, ports, userinfo) are
 * fine to miss as long as the common-case match works.
 */
const URL_RE = /(?:https?:\/\/)?([a-z0-9][-a-z0-9.]+\.[a-z]{2,})(?:\/[^\s]*)?/gi;

/**
 * Match against a domain blocklist and/or the special tokens
 * 'zk:invite' (matches any /invite/ URL — Zekktris invite links).
 *
 * Patterns are case-insensitive. A pattern "example.com" matches
 * URLs whose hostname IS "example.com" OR ends with ".example.com"
 * (subdomain match), so "evil.example.com" trips the same rule.
 *
 * Returns true if ANY URL in the content matches ANY pattern.
 * Exported for testing.
 */
export function messageMatchesLinkFilter(content: string, patterns: string[]): boolean {
  if (patterns.length === 0) return false;
  const inviteCheck = patterns.includes('zk:invite');
  const domainPatterns = patterns
    .map((p) => p.trim().toLowerCase())
    .filter((p) => p.length > 0 && p !== 'zk:invite');

  // Reset regex state — global flag persists lastIndex across
  // invocations, which would skip the second call's matches.
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(content)) !== null) {
    const fullMatch = m[0]!;
    const host = (m[1] ?? '').toLowerCase();
    if (inviteCheck && /\/invite\//i.test(fullMatch)) return true;
    for (const p of domainPatterns) {
      // Exact hostname match OR subdomain match.
      if (host === p || host.endsWith('.' + p)) return true;
    }
  }
  return false;
}
