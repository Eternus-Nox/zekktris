/**
 * Scheduled events service
 * ------------------------
 * CRUD + RSVP + sweep for the scheduled_events table. Lifecycle:
 *
 *   scheduled → active    : sweep at start_at OR admin manual
 *   active    → completed : sweep at end_at OR admin manual
 *   any       → canceled  : admin manual (terminal)
 *
 * Status sweep runs from the same scheduler that handles session
 * purges and image compression. Once per minute is fine — events
 * don't have second-level start precision in the UI.
 *
 * RSVPs:
 *   At most one row per (eventId, userId) via the composite PK.
 *   Status changes are UPSERTs (existing row UPDATEd, missing row
 *   INSERTed); full un-RSVP is a DELETE. We don't write audit
 *   entries for RSVP changes — member self-activity isn't
 *   moderation-relevant and the audit log would get noisy.
 */

import { and, desc, eq, gte, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { nextSnowflake } from '../snowflake';
import { errors } from '../errors';
import { writeAudit } from './audit';

export type EventStatus = 'scheduled' | 'active' | 'completed' | 'canceled';
export type EventLocationKind = 'voice_channel' | 'external';
export type RsvpStatus = 'going' | 'maybe' | 'declined';

// ── Validation ──────────────────────────────────────────────────────────────

/**
 * Enforce the XOR between locationKind and the location-data
 * columns. Kind 'voice_channel' requires channelId set + text null;
 * 'external' requires text set + channelId null. Anything else is
 * a configuration error.
 *
 * The DB-level CHECK only validates the kind itself — the pairing
 * is API-layer responsibility. Rejecting here means a buggy client
 * can't push us into an inconsistent state.
 */
function validateLocationPair(args: {
  locationKind: EventLocationKind;
  locationChannelId?: bigint | null;
  locationText?: string | null;
}): void {
  if (args.locationKind === 'voice_channel') {
    if (!args.locationChannelId) {
      throw errors.badRequest('voice_channel events require a locationChannelId');
    }
    if (args.locationText) {
      throw errors.badRequest('voice_channel events cannot have locationText');
    }
  } else {
    // external
    if (args.locationChannelId) {
      throw errors.badRequest('external events cannot have a locationChannelId');
    }
    if (!args.locationText || args.locationText.trim().length === 0) {
      throw errors.badRequest('external events require a locationText');
    }
  }
}

// ── CRUD ────────────────────────────────────────────────────────────────────

export interface CreateEventInput {
  guildId: bigint;
  creatorId: bigint;
  name: string;
  description?: string | null;
  startAt: Date;
  endAt?: Date | null;
  locationKind: EventLocationKind;
  locationChannelId?: bigint | null;
  locationText?: string | null;
  imageUrl?: string | null;
}

export async function createEvent(input: CreateEventInput): Promise<schema.ScheduledEvent> {
  // Start time can't be in the past. We allow start_at == now (within
  // a small slack) so a "start immediately" event isn't rejected by
  // clock jitter between client and server.
  const SLACK_MS = 60_000;
  if (input.startAt.getTime() < Date.now() - SLACK_MS) {
    throw errors.badRequest('Event start time cannot be in the past');
  }
  // End must be after start, when set.
  if (input.endAt && input.endAt.getTime() <= input.startAt.getTime()) {
    throw errors.badRequest('Event end time must be after start time');
  }
  validateLocationPair({
    locationKind: input.locationKind,
    locationChannelId: input.locationChannelId,
    locationText: input.locationText,
  });

  // For voice_channel kind, verify the target channel exists, is in
  // this guild, and is a voice/stage type. Catching this here gives
  // a friendly 400 instead of a foreign-key violation 500 later.
  if (input.locationKind === 'voice_channel' && input.locationChannelId) {
    const [ch] = await db
      .select({
        id: schema.channels.id,
        guildId: schema.channels.guildId,
        type: schema.channels.type,
      })
      .from(schema.channels)
      .where(eq(schema.channels.id, input.locationChannelId))
      .limit(1);
    if (!ch || ch.guildId !== input.guildId) {
      throw errors.badRequest('locationChannelId must be a channel in this guild');
    }
    if (ch.type !== 'guild_voice' && ch.type !== 'guild_stage') {
      throw errors.badRequest('locationChannelId must reference a voice or stage channel');
    }
  }

  const id = nextSnowflake();
  const [row] = await db
    .insert(schema.scheduledEvents)
    .values({
      id,
      guildId: input.guildId,
      creatorId: input.creatorId,
      name: input.name,
      description: input.description ?? null,
      startAt: input.startAt,
      endAt: input.endAt ?? null,
      locationKind: input.locationKind,
      locationChannelId: input.locationChannelId ?? null,
      locationText: input.locationText ?? null,
      imageUrl: input.imageUrl ?? null,
      // status defaults to 'scheduled' at the column level.
    })
    .returning();
  if (!row) throw errors.internal('Failed to create event');

  await writeAudit({
    guildId: input.guildId,
    actorId: input.creatorId,
    action: 'event.create',
    targetType: 'scheduled_event',
    targetId: id,
    changes: {
      name: input.name,
      startAt: input.startAt.toISOString(),
      locationKind: input.locationKind,
    },
  });

  return row;
}

export interface ListEventsOptions {
  /** Filter by status. When omitted, returns all non-canceled events. */
  status?: EventStatus | EventStatus[];
  /** Limit + cursor (start_at) for pagination. */
  limit?: number;
  /** Whether to include completed/canceled. Default true.
   *  Set false from "show upcoming" UI. */
  includeArchived?: boolean;
}

/**
 * List events for a guild. Default behavior: include all events
 * except canceled, ordered by start_at ASC (earliest first).
 * Caller passes includeArchived=false to skip completed events too,
 * which is what the "upcoming events" UI wants.
 */
export async function listGuildEvents(
  guildId: bigint,
  opts: ListEventsOptions = {},
): Promise<schema.ScheduledEvent[]> {
  const limit = Math.max(1, Math.min(100, opts.limit ?? 50));
  const conds = [eq(schema.scheduledEvents.guildId, guildId)];

  if (opts.status) {
    const statuses = Array.isArray(opts.status) ? opts.status : [opts.status];
    conds.push(inArray(schema.scheduledEvents.status, statuses));
  } else if (opts.includeArchived === false) {
    // Default exclusion of terminal states for the "upcoming" view.
    conds.push(inArray(schema.scheduledEvents.status, ['scheduled', 'active'] as EventStatus[]));
  }

  return db
    .select()
    .from(schema.scheduledEvents)
    .where(and(...conds))
    .orderBy(schema.scheduledEvents.startAt)
    .limit(limit);
}

export async function getEvent(eventId: bigint): Promise<schema.ScheduledEvent | null> {
  const [row] = await db
    .select()
    .from(schema.scheduledEvents)
    .where(eq(schema.scheduledEvents.id, eventId))
    .limit(1);
  return row ?? null;
}

export interface UpdateEventInput {
  eventId: bigint;
  guildId: bigint;
  actorId: bigint;
  name?: string;
  description?: string | null;
  startAt?: Date;
  endAt?: Date | null;
  locationKind?: EventLocationKind;
  locationChannelId?: bigint | null;
  locationText?: string | null;
  status?: EventStatus;
  imageUrl?: string | null;
}

/**
 * Update an event. Status transitions are validated; terminal
 * states (canceled, completed) can't transition further. Location
 * changes (kind + data) revalidate as a unit since they're paired.
 */
export async function updateEvent(input: UpdateEventInput): Promise<schema.ScheduledEvent> {
  const existing = await getEvent(input.eventId);
  if (!existing) throw errors.notFound('Event');
  if (existing.guildId !== input.guildId) throw errors.notFound('Event');

  // Status transition validation.
  if (input.status !== undefined && input.status !== existing.status) {
    if (existing.status === 'canceled') {
      throw errors.badRequest('Cannot change status of a canceled event');
    }
    if (existing.status === 'completed' && input.status !== 'canceled') {
      throw errors.badRequest('Cannot reactivate a completed event');
    }
  }

  // Time validation: end > start when both are set in the EFFECTIVE
  // (post-patch) view of the event.
  const effectiveStart = input.startAt ?? existing.startAt;
  const effectiveEnd = input.endAt !== undefined ? input.endAt : existing.endAt;
  if (effectiveEnd && effectiveEnd.getTime() <= effectiveStart.getTime()) {
    throw errors.badRequest('Event end time must be after start time');
  }

  // Location validation: if EITHER kind or one of the data fields
  // is in the patch, validate the EFFECTIVE shape post-patch.
  const touchingLocation =
    input.locationKind !== undefined ||
    input.locationChannelId !== undefined ||
    input.locationText !== undefined;
  if (touchingLocation) {
    const effKind = input.locationKind ?? existing.locationKind;
    const effChannelId =
      input.locationChannelId !== undefined ? input.locationChannelId : existing.locationChannelId;
    const effText = input.locationText !== undefined ? input.locationText : existing.locationText;
    validateLocationPair({
      locationKind: effKind,
      locationChannelId: effChannelId,
      locationText: effText,
    });
    if (effKind === 'voice_channel' && effChannelId) {
      const [ch] = await db
        .select({
          guildId: schema.channels.guildId,
          type: schema.channels.type,
        })
        .from(schema.channels)
        .where(eq(schema.channels.id, effChannelId))
        .limit(1);
      if (!ch || ch.guildId !== input.guildId) {
        throw errors.badRequest('locationChannelId must be a channel in this guild');
      }
      if (ch.type !== 'guild_voice' && ch.type !== 'guild_stage') {
        throw errors.badRequest('locationChannelId must reference a voice or stage channel');
      }
    }
  }

  const patch: Partial<typeof schema.scheduledEvents.$inferInsert> = {
    updatedAt: new Date(),
  };
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.startAt !== undefined) patch.startAt = input.startAt;
  if (input.endAt !== undefined) patch.endAt = input.endAt;
  if (input.locationKind !== undefined) patch.locationKind = input.locationKind;
  if (input.locationChannelId !== undefined) patch.locationChannelId = input.locationChannelId;
  if (input.locationText !== undefined) patch.locationText = input.locationText;
  if (input.status !== undefined) patch.status = input.status;
  if (input.imageUrl !== undefined) patch.imageUrl = input.imageUrl;

  const [updated] = await db
    .update(schema.scheduledEvents)
    .set(patch)
    .where(eq(schema.scheduledEvents.id, input.eventId))
    .returning();
  if (!updated) throw errors.notFound('Event');

  // Granular audit action selection. Picks the most-specific category
  // that changed in this patch so audit-log filters surface relevant
  // entries (e.g. "show me all time changes"). Single entry per
  // updateEvent call — composite patches are common, and three audit
  // rows for one admin click would clutter the log. The `changes`
  // payload carries the full patch so the renderer can still mention
  // each affected field.
  //
  // Priority order is "most distinct first":
  //   status='canceled' → event.cancel (already terminal)
  //   other status transitions → event.status_changed
  //   imageUrl → event.image_set / event.image_cleared
  //   startAt/endAt → event.time_changed
  //   locationKind/Channel/Text → event.location_changed
  //   else (name/description only) → event.update
  const auditAction = resolveUpdateAuditAction(input);

  await writeAudit({
    guildId: input.guildId,
    actorId: input.actorId,
    action: auditAction,
    targetType: 'scheduled_event',
    targetId: input.eventId,
    changes: patch as Record<string, unknown>,
  });

  return updated;
}

/**
 * Map an updateEvent input to its most-specific audit action code.
 * See the comment in updateEvent for the priority order rationale.
 */
function resolveUpdateAuditAction(input: UpdateEventInput): string {
  if (input.status === 'canceled') return 'event.cancel';
  if (input.status !== undefined) return 'event.status_changed';
  if (input.imageUrl !== undefined) {
    return input.imageUrl === null ? 'event.image_cleared' : 'event.image_set';
  }
  if (input.startAt !== undefined || input.endAt !== undefined) {
    return 'event.time_changed';
  }
  if (
    input.locationKind !== undefined ||
    input.locationChannelId !== undefined ||
    input.locationText !== undefined
  ) {
    return 'event.location_changed';
  }
  return 'event.update';
}

export async function deleteEvent(eventId: bigint, guildId: bigint, actorId: bigint): Promise<void> {
  const result = await db
    .delete(schema.scheduledEvents)
    .where(
      and(
        eq(schema.scheduledEvents.id, eventId),
        eq(schema.scheduledEvents.guildId, guildId),
      ),
    )
    .returning({ id: schema.scheduledEvents.id });
  if (result.length === 0) throw errors.notFound('Event');
  await writeAudit({
    guildId,
    actorId,
    action: 'event.delete',
    targetType: 'scheduled_event',
    targetId: eventId,
  });
}

// ── RSVPs ───────────────────────────────────────────────────────────────────

export async function setRsvp(args: {
  eventId: bigint;
  userId: bigint;
  status: RsvpStatus;
}): Promise<void> {
  // Validate event exists and isn't terminal — RSVPing to a
  // canceled/completed event would be a confusing UX. (We allow
  // RSVPing to events that are currently 'active' — late-comers
  // marking themselves as 'going' is a reasonable signal.)
  const ev = await getEvent(args.eventId);
  if (!ev) throw errors.notFound('Event');
  if (ev.status === 'canceled') throw errors.badRequest('Cannot RSVP to a canceled event');
  if (ev.status === 'completed') throw errors.badRequest('Cannot RSVP to a completed event');

  // UPSERT — single round-trip, ON CONFLICT updates the status +
  // bumps updated_at. The PK (eventId, userId) is the conflict
  // target.
  await db
    .insert(schema.eventRsvps)
    .values({
      eventId: args.eventId,
      userId: args.userId,
      status: args.status,
    })
    .onConflictDoUpdate({
      target: [schema.eventRsvps.eventId, schema.eventRsvps.userId],
      set: { status: args.status, updatedAt: new Date() },
    });
}

export async function removeRsvp(args: {
  eventId: bigint;
  userId: bigint;
}): Promise<void> {
  await db
    .delete(schema.eventRsvps)
    .where(
      and(
        eq(schema.eventRsvps.eventId, args.eventId),
        eq(schema.eventRsvps.userId, args.userId),
      ),
    );
}

/**
 * List RSVPs for an event with the user row joined. Used by the
 * "who's coming" attendee panel. Optional status filter narrows
 * to e.g. just 'going' members.
 */
export async function listRsvps(
  eventId: bigint,
  opts: { status?: RsvpStatus; limit?: number } = {},
): Promise<Array<{ rsvp: schema.EventRsvp; user: schema.User }>> {
  const limit = Math.max(1, Math.min(200, opts.limit ?? 100));
  const conds = [eq(schema.eventRsvps.eventId, eventId)];
  if (opts.status) conds.push(eq(schema.eventRsvps.status, opts.status));
  const rows = await db
    .select({
      rsvp: schema.eventRsvps,
      user: schema.users,
    })
    .from(schema.eventRsvps)
    .innerJoin(schema.users, eq(schema.users.id, schema.eventRsvps.userId))
    .where(and(...conds))
    .orderBy(schema.eventRsvps.createdAt)
    .limit(limit);
  return rows;
}

/**
 * Aggregate RSVP counts by status for an event card.
 * Returns { going, maybe, declined }; statuses not present in the
 * result rows are 0.
 */
export async function countRsvpsByStatus(eventId: bigint): Promise<{
  going: number;
  maybe: number;
  declined: number;
}> {
  const rows = await db
    .select({
      status: schema.eventRsvps.status,
      count: sql<number>`count(*)::int`,
    })
    .from(schema.eventRsvps)
    .where(eq(schema.eventRsvps.eventId, eventId))
    .groupBy(schema.eventRsvps.status);
  const out = { going: 0, maybe: 0, declined: 0 };
  for (const row of rows) {
    if (row.status === 'going') out.going = row.count;
    else if (row.status === 'maybe') out.maybe = row.count;
    else if (row.status === 'declined') out.declined = row.count;
  }
  return out;
}

/**
 * Read the calling user's own RSVP status for an event, or null if
 * they haven't RSVP'd. Cheap PK lookup used by the event card to
 * highlight the active button.
 */
export async function getUserRsvp(eventId: bigint, userId: bigint): Promise<RsvpStatus | null> {
  const [row] = await db
    .select({ status: schema.eventRsvps.status })
    .from(schema.eventRsvps)
    .where(
      and(
        eq(schema.eventRsvps.eventId, eventId),
        eq(schema.eventRsvps.userId, userId),
      ),
    )
    .limit(1);
  return row?.status ?? null;
}

// ── Sweep ───────────────────────────────────────────────────────────────────

/**
 * Periodic sweep that flips scheduled → active (when start_at has
 * passed) and active → completed (when end_at has passed). Two bulk
 * UPDATEs, both bounded by the partial active-events index. Safe to
 * run frequently; idempotent because the WHERE clauses match only
 * stale rows.
 *
 * Events with NULL end_at are NEVER auto-completed — admin must
 * mark them complete manually. The matching WHERE clause excludes
 * them via `end_at IS NOT NULL`.
 *
 * After the bulk UPDATEs, we fan out scheduledEventUpdate broadcasts
 * to each affected guild so connected clients see the status flip
 * in real time. We batch-load creators with a single IN-clause
 * query rather than one per event, keeping the sweep cheap even
 * when many events transition at once. RSVP counts/myRsvp are NOT
 * included in broadcast deltas — clients preserve their own.
 *
 * Newly-activated events ALSO trigger push notifications to all
 * members who RSVP'd 'going' or 'maybe'. 'declined' RSVPers opt
 * out explicitly. Sending push to all guild members regardless of
 * RSVP would be the "everyone gets pinged for every event"
 * anti-pattern. Push sends are fire-and-forget so the sweep tick
 * stays fast — sendToUser handles per-subscription error isolation
 * and 410-gone pruning.
 */
export async function runEventStatusSweep(): Promise<{
  activated: number;
  completed: number;
}> {
  const now = new Date();

  const activated = await db
    .update(schema.scheduledEvents)
    .set({ status: 'active', updatedAt: now })
    .where(
      and(
        eq(schema.scheduledEvents.status, 'scheduled'),
        lte(schema.scheduledEvents.startAt, now),
      ),
    )
    .returning();

  const completed = await db
    .update(schema.scheduledEvents)
    .set({ status: 'completed', updatedAt: now })
    .where(
      and(
        eq(schema.scheduledEvents.status, 'active'),
        // Explicit non-null check so we don't auto-complete
        // open-ended events.
        sql`${schema.scheduledEvents.endAt} IS NOT NULL`,
        lte(schema.scheduledEvents.endAt, now),
      ),
    )
    .returning();

  // Fan out gateway broadcasts for every transitioned event.
  const all = [...activated, ...completed];
  if (all.length > 0) {
    const creatorIds = Array.from(
      new Set(all.map((e) => e.creatorId).filter((id): id is bigint => id !== null)),
    );
    let creatorMap = new Map<bigint, schema.User>();
    if (creatorIds.length > 0) {
      const rows = await db
        .select()
        .from(schema.users)
        .where(inArray(schema.users.id, creatorIds));
      creatorMap = new Map(rows.map((u) => [u.id, u]));
    }
    const { toScheduledEvent } = await import('../lib/dto');
    const dispatch = await import('../gateway/dispatch');
    for (const ev of all) {
      const creator = ev.creatorId ? creatorMap.get(ev.creatorId) ?? null : null;
      const dto = toScheduledEvent(ev, creator);
      dispatch.scheduledEventUpdate(dto, ev.guildId);
    }
  }

  // Fire-and-forget event-start pushes for newly-activated events.
  // Only `activated` (scheduled→active); `completed` doesn't warrant
  // a push since "event ended" is rarely useful as a notification.
  if (activated.length > 0) {
    void sendEventStartPushes(activated).catch(() => {
      // Per-event errors are already logged by sendToUser; this
      // catch is here so an unexpected failure (e.g. push module
      // throwing during init) doesn't bubble out of the sweep.
    });
  }

  return { activated: activated.length, completed: completed.length };
}

/**
 * Fan out push notifications for each newly-activated event to
 * members who RSVP'd 'going' or 'maybe'. Separate function from the
 * sweep so failures don't abort the broadcast leg, and so the sweep
 * can fire-and-forget this.
 *
 * Per-event flow:
 *   1. Look up RSVPs filtered to going/maybe.
 *   2. Look up the guild name for the title.
 *   3. Call sendToUser for each recipient — parallelized at the
 *      per-event level rather than across-events to avoid spawning
 *      hundreds of parallel pushes when many events activate at
 *      once.
 */
async function sendEventStartPushes(activated: schema.ScheduledEvent[]): Promise<void> {
  if (activated.length === 0) return;
  const { sendToUsers } = await import('./push');

  // Batch-load guild names for the affected events.
  const guildIds = Array.from(new Set(activated.map((e) => e.guildId)));
  const guildRows = await db
    .select({ id: schema.guilds.id, name: schema.guilds.name })
    .from(schema.guilds)
    .where(inArray(schema.guilds.id, guildIds));
  const guildNameMap = new Map(guildRows.map((g) => [g.id, g.name]));

  // Per-event push fan-out. Awaited per-event (so we don't blow up
  // the parallel-request pool) but parallel per-RSVPer within an
  // event.
  for (const ev of activated) {
    try {
      const rsvps = await db
        .select({ userId: schema.eventRsvps.userId })
        .from(schema.eventRsvps)
        .where(
          and(
            eq(schema.eventRsvps.eventId, ev.id),
            inArray(schema.eventRsvps.status, ['going', 'maybe']),
          ),
        );
      if (rsvps.length === 0) continue;

      const guildName = guildNameMap.get(ev.guildId) ?? 'a server';
      const title = `${guildName}: Event starting now`;
      const body =
        ev.locationKind === 'voice_channel'
          ? `${ev.name} — tap to join`
          : `${ev.name}${ev.locationText ? ` — ${ev.locationText}` : ''}`;
      const payload = {
        title,
        body,
        // Tag with the event id so a subsequent update notification
        // (e.g. admin patches start time) replaces rather than
        // stacks.
        tag: `event-${ev.id.toString()}`,
        url: `/channels/${ev.guildId.toString()}`,
        kind: 'message' as const,
      };

      // Bulk fan-out across recipients of THIS event: one token query per
      // transport + a bounded send burst, instead of 3×N token queries and an
      // unbounded burst. The payload is identical for every RSVPer.
      await sendToUsers(
        rsvps.map((r) => r.userId),
        () => payload,
      ).catch(() => {
        // Best-effort; sendToUsers isolates per-subscription failures.
      });
    } catch {
      // Per-event failures (e.g. RSVP query timeout) don't block
      // pushes for other events. Already logged at the lower
      // layers.
    }
  }
}

// Re-export for tree-shake safety; some callers import via `* as`.
void gte;
void desc;
void isNull;
