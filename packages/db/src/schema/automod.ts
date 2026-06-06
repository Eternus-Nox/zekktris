import { pgTable, bigint, text, integer, boolean, jsonb, timestamp, index } from 'drizzle-orm/pg-core';

/**
 * Automod rules — per-guild policies that block / penalize message
 * sends matching configured patterns. The enforcement query runs on
 * every message send in a guild that has any rules, so the partial
 * index on enabled=true (in migration 0033) keeps that read cheap.
 *
 * Rule types reserved by the union below:
 *   - word_blocklist : pattern array → reject if message contains
 *                      any pattern (case-insensitive, word-boundary)
 *   - regex_pattern  : pattern array → reject if any pattern (raw
 *                      regex) matches the message
 *   - link_filter    : block links matching the configured domain
 *                      blocklist; the special pattern 'zk:invite'
 *                      blocks Zekktris/Discord invite links
 *   - repeat_message : threshold + window → reject when a user spams
 *   - mention_spam   : threshold → reject when too many mentions
 *
 * Actions:
 *   - block             : reject the message (default)
 *   - block_and_timeout : reject + apply a timeout for timeoutSeconds
 *   - log_only          : write audit entry but allow the message
 *                         through (observation mode)
 *
 * Patterns are stored as JSONB arrays of bare strings. Exemption
 * arrays (role + channel) skip the rule when ANY id in the relevant
 * exempt list matches the sender's context.
 */
export const automodRules = pgTable(
  'automod_rules',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    guildId: bigint('guild_id', { mode: 'bigint' }).notNull(),
    name: text('name').notNull(),
    ruleType: text('rule_type')
      .notNull()
      .$type<
        | 'word_blocklist'
        | 'regex_pattern'
        | 'link_filter'
        | 'repeat_message'
        | 'mention_spam'
      >(),
    enabled: boolean('enabled').notNull().default(true),
    patterns: jsonb('patterns').notNull().$type<string[]>().default([]),
    threshold: integer('threshold'),
    windowSeconds: integer('window_seconds'),
    action: text('action')
      .notNull()
      .$type<'block' | 'block_and_timeout' | 'log_only'>()
      .default('block'),
    timeoutSeconds: integer('timeout_seconds'),
    exemptRoleIds: jsonb('exempt_role_ids').notNull().$type<string[]>().default([]),
    /** Per-rule channel exemptions. When non-empty, the rule is
        skipped in any channel whose id appears here. Use case:
        profanity allowed in #shitposting but blocked elsewhere. */
    exemptChannelIds: jsonb('exempt_channel_ids')
      .notNull()
      .$type<string[]>()
      .default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildEnabledIdx: index('automod_rules_guild_enabled_idx').on(t.guildId),
  }),
);

export type AutomodRule = typeof automodRules.$inferSelect;
