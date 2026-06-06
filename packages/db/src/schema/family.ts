/**
 * Parental controls
 * -----------------
 * A guardian ("parent") account can supervise one or more "child"
 * accounts. Supervision is CONSENT-GATED: the parent sends a request,
 * the child account accepts it (status pending → active). Only an active
 * link grants the parent a scoped read view of the child's messages and
 * contacts, and only an active link changes the child's behavior
 * (restrictions, watch-word flagging, and the E2EE policy). This consent
 * gate is deliberate — it prevents the feature from being used to
 * surveil a non-consenting adult.
 *
 * Supervision is also TRANSPARENT: a supervised child always sees a
 * persistent notice that the account is supervised and by whom. We never
 * present this as covert monitoring.
 *
 * E2EE policy for an active link: the child's DMs are NOT end-to-end
 * encrypted (so the parent can review them) EXCEPT a DM between the
 * child and their own parent, which stays E2EE and private. Enforced
 * client-side in the encryption path; the server exposes the policy via
 * the supervision endpoints.
 *
 * Tables:
 *   parent_child_links   — the supervision relationship + lifecycle
 *   child_restrictions   — per-child capability toggles (1 row/child)
 *   child_blocked_guilds — servers the child may not join
 *   child_watch_words    — flagged terms checked on send + receive
 *   flagged_messages     — a watch-word hit, for the parent to review
 */
import {
  bigint,
  boolean,
  index,
  pgTable,
  primaryKey,
  text,
  timestamp,
} from 'drizzle-orm/pg-core';
import { parentLinkStatusEnum, flagDirectionEnum, childRequestTypeEnum, childRequestStatusEnum } from './enums';
import { users } from './users';
import { guilds } from './guilds';
import { messages } from './messages';
import { channels } from './channels';

export const parentChildLinks = pgTable(
  'parent_child_links',
  {
    parentId: bigint('parent_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    childId: bigint('child_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    status: parentLinkStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.parentId, t.childId] }),
    // "who supervises this child" + "is anyone supervising this child"
    childIdx: index('parent_child_links_child_idx').on(t.childId),
  }),
);

export const childRestrictions = pgTable('child_restrictions', {
  childId: bigint('child_id', { mode: 'bigint' })
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  canAddFriends: boolean('can_add_friends').notNull().default(true),
  canRemoveFriends: boolean('can_remove_friends').notNull().default(true),
  allowVoice: boolean('allow_voice').notNull().default(true),
  allowVideo: boolean('allow_video').notNull().default(true),
  allowStream: boolean('allow_stream').notNull().default(true),
  allowCreateGuild: boolean('allow_create_guild').notNull().default(true),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const childBlockedGuilds = pgTable(
  'child_blocked_guilds',
  {
    childId: bigint('child_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.childId, t.guildId] }),
  }),
);

export const childWatchWords = pgTable(
  'child_watch_words',
  {
    childId: bigint('child_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    // Stored lowercased; matching is case-insensitive substring on a
    // normalized copy of the message text.
    word: text('word').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.childId, t.word] }),
  }),
);

export const flaggedMessages = pgTable(
  'flagged_messages',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    childId: bigint('child_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    messageId: bigint('message_id', { mode: 'bigint' })
      .notNull()
      .references(() => messages.id, { onDelete: 'cascade' }),
    channelId: bigint('channel_id', { mode: 'bigint' })
      .notNull()
      .references(() => channels.id, { onDelete: 'cascade' }),
    matchedWord: text('matched_word').notNull(),
    direction: flagDirectionEnum('direction').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
  },
  (t) => ({
    // Parent dashboard: "this child's flags, newest first".
    byChild: index('flagged_messages_child_idx').on(t.childId, t.createdAt),
  }),
);

export type ParentChildLink = typeof parentChildLinks.$inferSelect;
export type ChildRestrictions = typeof childRestrictions.$inferSelect;
export type ChildBlockedGuild = typeof childBlockedGuilds.$inferSelect;
export type ChildWatchWord = typeof childWatchWords.$inferSelect;
export type FlaggedMessage = typeof flaggedMessages.$inferSelect;

/**
 * A supervised child can ask their parent to approve an action they're
 * restricted from. `friend` requests carry target_user_id; `guild`
 * requests carry an invite_code (+ resolved guild_id for display).
 */
export const childRequests = pgTable(
  'child_requests',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    childId: bigint('child_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    type: childRequestTypeEnum('type').notNull(),
    targetUserId: bigint('target_user_id', { mode: 'bigint' }).references(
      () => users.id,
      { onDelete: 'cascade' },
    ),
    guildId: bigint('guild_id', { mode: 'bigint' }).references(() => guilds.id, {
      onDelete: 'cascade',
    }),
    inviteCode: text('invite_code'),
    note: text('note'),
    status: childRequestStatusEnum('status').notNull().default('pending'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  },
  (t) => ({
    byChild: index('child_requests_child_idx').on(t.childId, t.status),
  }),
);

export type ChildRequest = typeof childRequests.$inferSelect;
