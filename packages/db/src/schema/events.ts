import { pgTable, bigint, text, timestamp, primaryKey, index } from 'drizzle-orm/pg-core';

/**
 * Scheduled events — time-bounded happenings members RSVP to.
 *
 * Lifecycle:
 *   scheduled → active    : sweep at start_at OR admin manual
 *   active    → completed : sweep at end_at OR admin manual
 *   any       → canceled  : admin manual; terminal
 *
 * Location semantics:
 *   voice_channel → location_channel_id points to a guild voice or
 *                    stage channel; members "join the event" by
 *                    joining that channel.
 *   external      → location_text is a free-form string (e.g.
 *                    "Twitter Spaces", a Zoom URL, an IRL address).
 *
 * The schema doesn't enforce the kind ↔ field pairing strictly
 * (only the kind itself is CHECKed); the API layer rejects requests
 * that put location data in the wrong slot. Mismatched rows from a
 * buggy migration would be quirky but not corrupt.
 */
export const scheduledEvents = pgTable(
  'scheduled_events',
  {
    id: bigint('id', { mode: 'bigint' }).primaryKey(),
    guildId: bigint('guild_id', { mode: 'bigint' }).notNull(),
    /** Creator can be deleted later; row survives with creatorId NULL. */
    creatorId: bigint('creator_id', { mode: 'bigint' }),
    name: text('name').notNull(),
    description: text('description'),
    startAt: timestamp('start_at', { withTimezone: true }).notNull(),
    /** Null = open-ended event. Service won't auto-flip to completed
     *  on a null end; admin must mark complete manually. */
    endAt: timestamp('end_at', { withTimezone: true }),
    locationKind: text('location_kind').notNull().$type<'voice_channel' | 'external'>(),
    /** Voice/stage channel pointer for kind='voice_channel'.
     *  SET NULL on channel delete — the event survives but loses
     *  its target; admin should update or cancel. */
    locationChannelId: bigint('location_channel_id', { mode: 'bigint' }),
    locationText: text('location_text'),
    status: text('status')
      .notNull()
      .$type<'scheduled' | 'active' | 'completed' | 'canceled'>()
      .default('scheduled'),
    imageUrl: text('image_url'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    guildStartIdx: index('scheduled_events_guild_start_idx').on(t.guildId, t.startAt),
    activeIdx: index('scheduled_events_active_idx').on(t.status, t.startAt),
  }),
);

export type ScheduledEvent = typeof scheduledEvents.$inferSelect;

/**
 * Event RSVPs — at most one row per (event, user) via the composite
 * PK. Status changes are UPDATEs to the same row; full un-RSVP is
 * a DELETE.
 */
export const eventRsvps = pgTable(
  'event_rsvps',
  {
    eventId: bigint('event_id', { mode: 'bigint' }).notNull(),
    userId: bigint('user_id', { mode: 'bigint' }).notNull(),
    status: text('status').notNull().$type<'going' | 'maybe' | 'declined'>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.eventId, t.userId] }),
    userIdx: index('event_rsvps_user_idx').on(t.userId),
  }),
);

export type EventRsvp = typeof eventRsvps.$inferSelect;
