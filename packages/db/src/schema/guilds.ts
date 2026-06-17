import {
  pgTable,
  bigint,
  text,
  boolean,
  integer,
  timestamp,
  primaryKey,
  index,
  uniqueIndex,
  jsonb,
} from 'drizzle-orm/pg-core';
import { relations, sql } from 'drizzle-orm';
import { users } from './users';
import { auditTargetEnum } from './enums';

// ───────────────────────────────────────────────────────────────────────────
// guilds  (servers)
// ───────────────────────────────────────────────────────────────────────────

export const guilds = pgTable(
  'guilds',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    name: text('name').notNull(),
    description: text('description'),
    iconUrl: text('icon_url'),
    bannerUrl: text('banner_url'),
    ownerId: bigint('owner_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** Optional channel where join/system messages go. */
    systemChannelId: bigint('system_channel_id', { mode: 'bigint' }),
    /**
     * AFK voice channel. When set, this must reference a voice channel
     * in this guild. Joining it auto-disables the user's mic at the
     * LiveKit level (canPublish=false) so the channel acts as a
     * "parked" zone — users hanging out without intent to speak. The
     * UI shows the channel with a moon icon. `afkTimeoutSeconds` is
     * the threshold beyond which a server-mute-AFK user should get
     * moved here automatically; the auto-move sweep is v1.x but the
     * column is reserved now so we don't need a follow-up migration.
     */
    afkChannelId: bigint('afk_channel_id', { mode: 'bigint' }),
    afkTimeoutSeconds: integer('afk_timeout_seconds').notNull().default(300),
    /**
     * Welcome-message configuration. When `welcomeMessageEnabled` is
     * true, joining the guild triggers a synthetic system_join message
     * in `welcomeChannelId` (falling back to systemChannelId, then
     * the first viewable text channel). `welcomeMessageTemplate`
     * supports `{user}` placeholder which renders as an @mention of
     * the new member. Defaults to a simple greeting when null.
     *
     * The template is plain text — no markdown injection beyond what
     * any other message supports, and the rendering sanitizer (same
     * one applied to content posts) keeps it from carrying control
     * chars. We don't surface this to webhook-execute or anywhere
     * else; it's only used at member-join time.
     */
    welcomeChannelId: bigint('welcome_channel_id', { mode: 'bigint' }),
    welcomeMessageEnabled: boolean('welcome_message_enabled').notNull().default(false),
    welcomeMessageTemplate: text('welcome_message_template'),
    /** Optional unique vanity invite slug (e.g. /invite/awesome). */
    vanityUrlCode: text('vanity_url_code'),
    /**
     * Opt-in flag for server discovery. When true, the guild appears
     * in the public /discover directory. Owners (and members with
     * MANAGE_GUILD) can flip this; the discoveryDescription below is
     * the long-form pitch shown next to the guild card.
     *
     * The shorter `description` column above is shown in-app (server
     * info popups, invites). The two are separate so a guild can
     * present a casual blurb internally and a polished pitch externally.
     */
    discoverable: boolean('discoverable').notNull().default(false),
    /** Long-form pitch shown on the discovery page. ≤500 chars. Null
        falls back to `description` if discoverable is true. */
    discoveryDescription: text('discovery_description'),
    /** One of the canonical category tags (see DISCOVERY_CATEGORIES
        in packages/client/src/types.ts, kept in sync with backend
        validation). The UI uses it for the left-rail filter and as
        a labeled badge on each discovery card. Null is allowed —
        older discoverable guilds and ones that haven't picked yet
        show up under "Other". */
    discoveryCategory: text('discovery_category'),
    /** Markdown text of the server rules shown during onboarding.
     *  NULL means no rules screening — new members join directly as
     *  'active'. Non-null means new members join as 'pending' and
     *  must POST acknowledgment before they can participate.
     *  Bounded at 10 KB at the API layer. */
    rulesContent: text('rules_content'),
    /** Timestamp of the last rules edit. Future feature can use this
     *  to optionally re-prompt established members on substantive
     *  edits; v1 just tracks it. NULL when rules_content is NULL. */
    rulesUpdatedAt: timestamp('rules_updated_at', { withTimezone: true }),
    /**
     * Raid protection. Join gates rejected at invite-accept / discovery-join
     * time, plus a hard lockdown ("raid mode").
     *   minAccountAgeMinutes — reject accounts younger than this (0 = off).
     *   requireVerifiedEmail — reject accounts without a verified email.
     *   raidModeEnabled      — refuse ALL new joins (manual, or auto-flipped
     *                          when the join-rate limit trips).
     *   joinRateLimit{Count,Seconds} — when both set, more than <count> joins
     *                          within <seconds> auto-enables raid mode. NULL
     *                          on either disables the auto-trigger.
     */
    minAccountAgeMinutes: integer('min_account_age_minutes').notNull().default(0),
    requireVerifiedEmail: boolean('require_verified_email').notNull().default(false),
    raidModeEnabled: boolean('raid_mode_enabled').notNull().default(false),
    joinRateLimitCount: integer('join_rate_limit_count'),
    joinRateLimitSeconds: integer('join_rate_limit_seconds'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => ({
    ownerIdx: index('guilds_owner_idx').on(t.ownerId),
    vanityIdx: uniqueIndex('guilds_vanity_idx').on(t.vanityUrlCode),
    /** Index for the discovery listing — almost all guilds will be
        non-discoverable, so a partial index would be ideal here. We
        use a simple b-tree for v1 since dataset is small; a partial
        index over WHERE discoverable IS TRUE is a future optimization. */
    discoverableIdx: index('guilds_discoverable_idx').on(t.discoverable),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// roles
// ───────────────────────────────────────────────────────────────────────────

export const roles = pgTable(
  'roles',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    /** RGB color packed as integer (0..0xFFFFFF). 0 = no color. */
    color: integer('color').notNull().default(0),
    /** Higher position == higher in hierarchy. @everyone is always 0. */
    position: integer('position').notNull().default(0),
    /** Bigint bitfield of base permissions (server-wide, before overrides). */
    permissions: bigint('permissions', { mode: 'bigint' }).notNull().default(sql`0`),
    /** Display members with this role separately in the member list. */
    hoist: boolean('hoist').notNull().default(false),
    /** Members can @ this role from chat. */
    mentionable: boolean('mentionable').notNull().default(false),
    /** System-managed (e.g. @everyone, future bot-integration roles). */
    managed: boolean('managed').notNull().default(false),
    /** When true, any guild member can grant or revoke this role for
     *  themselves via POST/DELETE /guilds/:id/members/@me/roles/:roleId.
     *  Default false — admins opt-in per role via the Roles tab. */
    selfAssignable: boolean('self_assignable').notNull().default(false),
    /** Optional admin-set blurb shown next to the role name in the
     *  Browse Roles UI. Helps members understand what each opt-in
     *  role is for ("Gets pinged when we host movie night"). Capped
     *  at 200 chars at the API layer. */
    description: text('description'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index('roles_guild_idx').on(t.guildId),
    // Partial index for "list self-assignable roles in this guild"
    // — used by the Browse Roles modal. Most roles are admin-only
    // so the partial index stays small.
    selfAssignableIdx: index('roles_self_assignable_idx').on(t.guildId, t.position),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// guild_members
// ───────────────────────────────────────────────────────────────────────────

export const guildMembers = pgTable(
  'guild_members',
  {
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    nickname: text('nickname'),
    /** Per-server avatar override. */
    avatarUrl: text('avatar_url'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    /** Timeout / mute-until timestamp. */
    communicationDisabledUntil: timestamp('communication_disabled_until', {
      withTimezone: true,
    }),
    /** Onboarding gate. 'pending' = the member has joined but hasn't
     *  acknowledged the guild's rules yet, so they can't send / react
     *  / join voice. 'active' = full member.
     *
     *  Defaults to 'active' for new INSERTs that don't specify; the
     *  members join-service sets 'pending' only when the guild has
     *  rules_content configured. Existing members from before this
     *  feature shipped are 'active' by virtue of the column default
     *  on the migration. */
    membershipState: text('membership_state')
      .notNull()
      .$type<'pending' | 'active'>()
      .default('active'),
    /** Timestamp of the member's most recent rules acknowledgment.
     *  NULL = never acknowledged (matches initial-join state for
     *  guilds with rules configured). When set, compared against
     *  guilds.rulesUpdatedAt to determine "stale acknowledgment"
     *  — the OnboardingModal re-shows if ackd < rulesUpdated. */
    rulesAcknowledgedAt: timestamp('rules_acknowledged_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.guildId, t.userId] }),
    userIdx: index('guild_members_user_idx').on(t.userId),
    // Partial index — most members are active, so the index stays
    // small while making "is this member pending?" lookups cheap.
    pendingIdx: index('guild_members_pending_idx').on(t.guildId, t.userId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// member_roles  (M:N join)
// ───────────────────────────────────────────────────────────────────────────

export const memberRoles = pgTable(
  'member_roles',
  {
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    roleId: bigint('role_id', { mode: 'bigint' })
      .notNull()
      .references(() => roles.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.guildId, t.userId, t.roleId] }),
    roleIdx: index('member_roles_role_idx').on(t.roleId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// bans
// ───────────────────────────────────────────────────────────────────────────

export const bans = pgTable(
  'bans',
  {
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    userId: bigint('user_id', { mode: 'bigint' })
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    moderatorId: bigint('moderator_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.guildId, t.userId] }),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// invites
// ───────────────────────────────────────────────────────────────────────────

export const invites = pgTable(
  'invites',
  {
    code: text('code').primaryKey(),
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** Channel the invitee initially lands in. */
    channelId: bigint('channel_id', { mode: 'bigint' }).notNull(),
    inviterId: bigint('inviter_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** null = unlimited uses. */
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    /** null = never expires. */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    /** True for permanent server invite (created_at + null expires). */
    temporary: boolean('temporary').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index('invites_guild_idx').on(t.guildId),
    // Backs the periodic dead-invite prune sweep (pruneDeadInvites), which
    // scans expires_at < cutoff. Most invites carry a TTL, so this covers the
    // dominant prune branch; the spent-but-unexpired branch is a minor seq-scan.
    expiresAtIdx: index('invites_expires_at_idx').on(t.expiresAt),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// guild_emojis
// ───────────────────────────────────────────────────────────────────────────
// Custom server-specific emoji. Members of the guild can use them inline as
// :name: in messages and as reactions; non-members never see them. The
// uploaded file lives in the same /uploads tree as message attachments and
// avatars (keyed by snowflake id), but with a tighter format whitelist
// (PNG/GIF/WebP only) and a small per-emoji size cap enforced at upload time.
//
// Why a separate table instead of leaning on the attachments table: emojis
// are reusable across many messages and reactions, have a stable name, and
// have access-control semantics ("members of guild X can use these"). They're
// closer to a guild's roles than to a message's attachments.

export const guildEmojis = pgTable(
  'guild_emojis',
  {
    /** Snowflake id. Doubles as the on-disk directory name under UPLOAD_DIR
        and the public /cdn/<id>/<name>.<ext> URL component. */
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** :name: token used in messages and reactions. Lowercase letters, digits,
        and underscores only — same charset Discord allows. Unique per guild. */
    name: text('name').notNull(),
    /** Public URL with the same /cdn/<id>/<filename> shape used elsewhere.
        Stored alongside the row so cdn route handlers can resolve from URL
        without recomputing. */
    url: text('url').notNull(),
    /** True for animated GIFs. We expose this so clients can choose whether
        to autoplay or pause them based on user preferences (a future setting). */
    animated: boolean('animated').notNull().default(false),
    /** Whoever uploaded it. Null only if that user got hard-deleted. Not
        used for permission checks (those go through MANAGE_EMOJIS) but
        useful for audit + attribution. */
    uploadedBy: bigint('uploaded_by', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Unique name per guild — :pepe: in two different servers is fine, two
    // :pepe:s in the same server is not.
    guildNameUq: uniqueIndex('guild_emojis_guild_name_uq').on(t.guildId, t.name),
    // Index for the common "list all emojis in this guild" query.
    guildIdx: index('guild_emojis_guild_idx').on(t.guildId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// stickers (Discord-style standalone message stickers)
// ───────────────────────────────────────────────────────────────────────────
//
// Stickers are like emoji but rendered as standalone message bodies at
// ~160px instead of inline glyphs. Uploaded per-guild; gated behind the
// same MANAGE_EMOJIS bit (Discord uses MANAGE_EMOJIS_AND_STICKERS as
// one combined permission and we do the same — saves a permission bit
// for something more interesting later).
//
// Storage shares the existing /uploads/<id>/<filename> tree with
// attachments + emojis + avatars; the CDN handler's progressive
// fall-through resolves sticker URLs by id.

export const stickers = pgTable(
  'stickers',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** Display name — 2-30 chars, free-form (unlike emoji, which require
        a strict :name: charset). Stickers don't use a `:` token; the
        picker is the only way to insert them. */
    name: text('name').notNull(),
    /** Optional short description (≤100 chars). Doubles as the
        screen-reader alt-text on the rendered sticker. Helpful for
        searchability when a guild has lots of stickers. */
    description: text('description'),
    url: text('url').notNull(),
    /** True for animated GIFs / APNGs. The renderer plays them
        unconditionally for v1 — a future setting can let users opt out. */
    animated: boolean('animated').notNull().default(false),
    uploadedBy: bigint('uploaded_by', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Stickers don't need to be uniquely named within a guild (no
    // :name: shorthand to disambiguate), but a same-name pair is
    // confusing so we still enforce uniqueness — admins can rename
    // a duplicate after the fact if they truly want both.
    guildNameUq: uniqueIndex('stickers_guild_name_uq').on(t.guildId, t.name),
    guildIdx: index('stickers_guild_idx').on(t.guildId),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// audit_log_entries
// ───────────────────────────────────────────────────────────────────────────

export const auditLogEntries = pgTable(
  'audit_log_entries',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    guildId: bigint('guild_id', { mode: 'bigint' })
      .notNull()
      .references(() => guilds.id, { onDelete: 'cascade' }),
    /** Whoever performed the action. Null if the actor was deleted. */
    actorId: bigint('actor_id', { mode: 'bigint' }).references(() => users.id, {
      onDelete: 'set null',
    }),
    /** Type of entity acted on. */
    targetType: auditTargetEnum('target_type').notNull(),
    /** Snowflake of the affected entity, if applicable. */
    targetId: bigint('target_id', { mode: 'bigint' }),
    /** e.g. 'channel.create', 'member.kick', 'role.update'. */
    action: text('action').notNull(),
    /** Optional before/after diff or extra context. */
    changes: jsonb('changes'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildIdx: index('audit_log_guild_idx').on(t.guildId, t.createdAt),
  }),
);

// ───────────────────────────────────────────────────────────────────────────
// Drizzle relations
// ───────────────────────────────────────────────────────────────────────────

export const guildsRelations = relations(guilds, ({ one, many }) => ({
  owner: one(users, { fields: [guilds.ownerId], references: [users.id] }),
  members: many(guildMembers),
  roles: many(roles),
  bans: many(bans),
  invites: many(invites),
  auditLog: many(auditLogEntries),
}));

export const rolesRelations = relations(roles, ({ one, many }) => ({
  guild: one(guilds, { fields: [roles.guildId], references: [guilds.id] }),
  members: many(memberRoles),
}));

export const guildMembersRelations = relations(guildMembers, ({ one, many }) => ({
  guild: one(guilds, { fields: [guildMembers.guildId], references: [guilds.id] }),
  user: one(users, { fields: [guildMembers.userId], references: [users.id] }),
  roles: many(memberRoles),
}));

export const memberRolesRelations = relations(memberRoles, ({ one }) => ({
  role: one(roles, { fields: [memberRoles.roleId], references: [roles.id] }),
}));

export const invitesRelations = relations(invites, ({ one }) => ({
  guild: one(guilds, { fields: [invites.guildId], references: [guilds.id] }),
  inviter: one(users, { fields: [invites.inviterId], references: [users.id] }),
}));

// ───────────────────────────────────────────────────────────────────────────
// Inferred types
// ───────────────────────────────────────────────────────────────────────────

export type Guild = typeof guilds.$inferSelect;
export type NewGuild = typeof guilds.$inferInsert;
export type Role = typeof roles.$inferSelect;
export type NewRole = typeof roles.$inferInsert;
export type GuildMember = typeof guildMembers.$inferSelect;
export type NewGuildMember = typeof guildMembers.$inferInsert;
export type MemberRole = typeof memberRoles.$inferSelect;
export type Ban = typeof bans.$inferSelect;
export type GuildEmoji = typeof guildEmojis.$inferSelect;
export type NewGuildEmoji = typeof guildEmojis.$inferInsert;
export type Sticker = typeof stickers.$inferSelect;
export type NewSticker = typeof stickers.$inferInsert;
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
export type AuditLogEntry = typeof auditLogEntries.$inferSelect;
export type NewAuditLogEntry = typeof auditLogEntries.$inferInsert;
