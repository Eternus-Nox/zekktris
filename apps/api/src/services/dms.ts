/**
 * DMs service
 * -----------
 * 1:1 direct-message channels. Group DMs are deferred to v1.x; the schema
 * supports them (channel.type='group_dm', dm_recipients table) but the
 * routes here only handle the 1:1 case.
 *
 * `getOrCreateDM(a, b)` is idempotent: the same pair always resolves to the
 * same channel id no matter who initiates. To make this fast and race-free
 * we identify a 1:1 DM by the unordered pair of recipient ids and look it
 * up via a JOIN that requires both rows to be present.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { and, asc, desc, eq, exists, inArray, isNull, like, ne, sql } from 'drizzle-orm';
import { db, schema } from '../db';
import { errors } from '../errors';
import { nextSnowflake } from '../snowflake';
import * as dispatch from '../gateway/dispatch';
import { log } from '../log';
import {
  DISAPPEARING_MAX_SECONDS,
  DISAPPEARING_MIN_SECONDS,
  disappearingNoticeText,
} from '../lib/disappearing';
import { toReadState } from '../lib/dto';
import { createSystemMessage, rollbackChannelWatermarks, type DbHandle } from './messages';
import * as readStates from './readStates';

/**
 * Find an existing 1:1 DM channel between two users, or create one.
 * Returns the channel id and a `created` flag so callers can avoid
 * firing "new DM" gateway events on idempotent re-calls.
 *
 * Concurrency: two simultaneous calls between the same pair (e.g.
 * the user clicks Send in two tabs at once) could each pass the
 * initial "no existing channel" check and both create a channel.
 * Postgres allows it because there's no unique constraint on the
 * unordered pair (and there can't easily be one — the recipients
 * live in a join table). To compensate we do a single retry: if
 * the first attempt's INSERTs into dm_recipients race with another
 * transaction that beat us in, the unique (channelId, userId) PK
 * fires and we roll back, then re-run the initial find — which
 * now sees the channel the other side created. One retry is enough
 * because each retry runs the find from scratch and a winning
 * transaction must already exist by the time we get here.
 */
async function findExistingDM(userA: bigint, userB: bigint): Promise<bigint | null> {
  const [existing] = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(
      and(
        eq(schema.channels.type, 'dm'),
        exists(
          db
            .select()
            .from(schema.dmRecipients)
            .where(
              and(
                eq(schema.dmRecipients.channelId, schema.channels.id),
                eq(schema.dmRecipients.userId, userA),
              ),
            ),
        ),
        exists(
          db
            .select()
            .from(schema.dmRecipients)
            .where(
              and(
                eq(schema.dmRecipients.channelId, schema.channels.id),
                eq(schema.dmRecipients.userId, userB),
              ),
            ),
        ),
      ),
    )
    // Deterministic winner: oldest channel (smallest snowflake) first.
    // Without an ORDER BY, two concurrent getOrCreateDM calls that each
    // created a duplicate could re-run this find, each see the OTHER's
    // channel as the winner, and mutually delete both. A stable sort
    // makes every caller agree on the same surviving channel (this is
    // also what the duplicate-cleanup comment below already assumes).
    .orderBy(asc(schema.channels.id))
    .limit(1);
  return existing?.id ?? null;
}

export async function getOrCreateDM(
  userA: bigint,
  userB: bigint,
): Promise<{ channelId: bigint; created: boolean }> {
  if (userA === userB) {
    throw errors.badRequest('Cannot DM yourself');
  }

  // Privacy + block check. Friends-only by default; the recipient can
  // opt in to allowing DMs from anyone sharing a guild with them. A
  // block in either direction always denies regardless of the toggle.
  // We respond with the same generic notFound surface as a missing
  // user so the result doesn't leak whether the target exists (or
  // what their privacy preference is).
  //
  // Dynamic-imported so the dms service doesn't pull relationships
  // into its top-level import graph — both are leaf services and a
  // cycle would surface if either grew.
  const { canReachByDmOrCall } = await import('./relationships');
  if (!(await canReachByDmOrCall(userA, userB))) {
    throw errors.notFound('User');
  }

  // Supervision DM policy — blocks stranger DMs to/from a friends-only or
  // no-DM minor (symmetric, protects the minor on either end). Same generic
  // notFound surface as the privacy gate so we don't leak the other user's
  // supervision state.
  const { dmBlockedBySupervision } = await import('./supervision');
  if (await dmBlockedBySupervision(userA, userB)) {
    throw errors.notFound('User');
  }

  const existingId = await findExistingDM(userA, userB);
  if (existingId !== null) return { channelId: existingId, created: false };

  // Create new DM channel.
  const channelId = nextSnowflake();
  // Canonical, order-independent key for the unordered pair so both
  // getOrCreateDM(A,B) and getOrCreateDM(B,A) contend on the same lock.
  const [lo, hi] = userA < userB ? [userA, userB] : [userB, userA];
  const pairKey = `dm:${lo}:${hi}`;
  // Set to the winner's channel id if a concurrent caller created the DM first.
  let createdExisting: bigint | null = null;
  try {
    await db.transaction(async (tx) => {
      // Serialize creation for this pair (repo idiom — cf. streaks.ts,
      // polls.ts). A concurrent caller blocks here until we commit, then its
      // re-check below sees our committed channel and skips its own insert —
      // so exactly one DM channel per pair is created even though there is no
      // unique constraint on the unordered pair. Without this, two truly
      // concurrent opens can each conclude they are the winner and both keep a
      // channel (the post-create find can run before the other side commits).
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${pairKey}))`);

      // Re-check under the lock: the loser of the create race sees the
      // winner's committed channel here and returns it instead of inserting.
      const [already] = await tx
        .select({ id: schema.channels.id })
        .from(schema.channels)
        .where(
          and(
            eq(schema.channels.type, 'dm'),
            exists(
              tx
                .select()
                .from(schema.dmRecipients)
                .where(
                  and(
                    eq(schema.dmRecipients.channelId, schema.channels.id),
                    eq(schema.dmRecipients.userId, userA),
                  ),
                ),
            ),
            exists(
              tx
                .select()
                .from(schema.dmRecipients)
                .where(
                  and(
                    eq(schema.dmRecipients.channelId, schema.channels.id),
                    eq(schema.dmRecipients.userId, userB),
                  ),
                ),
            ),
          ),
        )
        .orderBy(asc(schema.channels.id))
        .limit(1);
      if (already) {
        createdExisting = already.id;
        return;
      }

      // Verify both users actually exist (and are not banned /
      // soft-deleted) before creating the channel. Without these
      // filters, a DM can be opened with a banned user: the channel
      // gets created, the initiator sends messages, the banned user
      // has no gateway connection and can't read REST, so nothing
      // delivers. The channel then sits in the initiator's DM list
      // pointing at someone they can't actually reach.
      const userCount = await tx
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(
          and(
            sql`${schema.users.id} IN (${userA}, ${userB})`,
            isNull(schema.users.bannedAt),
            isNull(schema.users.deletedAt),
          ),
        );
      if (userCount.length !== 2) {
        throw errors.notFound('User');
      }

      await tx.insert(schema.channels).values({
        id: channelId,
        type: 'dm',
        guildId: null,
        name: null,
        position: 0,
      });
      await tx.insert(schema.dmRecipients).values([
        { channelId, userId: userA },
        { channelId, userId: userB },
      ]);
    });
  } catch (err: unknown) {
    // Postgres unique violation code = 23505. If we tripped on the
    // dm_recipients PK that means another transaction created the
    // DM channel and inserted the same (channelId, userId) — but
    // wait, our channelId is a fresh snowflake so it can't collide
    // on that. The realistic collision is racing two *different*
    // calls each picking a different channelId and both passing
    // the find — that wouldn't trip any constraint with the current
    // schema. So the more useful race-resolution here is: re-run
    // the find, and if a parallel call inserted, return its id
    // instead. We only return a non-null retry result on the rare
    // unique-violation path.
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: unknown }).code === '23505'
    ) {
      const retryId = await findExistingDM(userA, userB);
      if (retryId !== null) return { channelId: retryId, created: false };
    }
    throw err;
  }

  // Lost the create race — the winner's committed channel was found under the
  // lock; return it instead of the (never-inserted) fresh id.
  if (createdExisting !== null) return { channelId: createdExisting, created: false };

  // Belt-and-suspenders: after a successful create, re-run the find.
  // If another concurrent caller's create won the lookup-race AND
  // committed before ours did, both transactions would have succeeded
  // (different channelIds, no shared rows). In that case the SECOND
  // committer's channel becomes a duplicate. The cleanest UX is to
  // return whichever channel the find query returns now — both have
  // the same membership, but the older snowflake will sort first in
  // newest-activity ordering. We drop the duplicate we just created
  // to keep the data tidy.
  const winnerId = await findExistingDM(userA, userB);
  if (winnerId !== null && winnerId !== channelId) {
    // Another caller beat us. Clean up our orphan.
    await db.transaction(async (tx) => {
      await tx
        .delete(schema.dmRecipients)
        .where(eq(schema.dmRecipients.channelId, channelId));
      await tx.delete(schema.channels).where(eq(schema.channels.id, channelId));
    });
    return { channelId: winnerId, created: false };
  }

  return { channelId, created: true };
}

/** List all 1:1 DM channels the user is a recipient of, newest activity first. */
export async function listMyDMs(userId: bigint) {
  return db
    .select({ channel: schema.channels })
    .from(schema.dmRecipients)
    .innerJoin(schema.channels, eq(schema.channels.id, schema.dmRecipients.channelId))
    .where(eq(schema.dmRecipients.userId, userId))
    .orderBy(desc(schema.channels.lastMessageId))
    .then((rows) => rows.map((r) => r.channel));
}

/** Throws NOT_FOUND if the user isn't a recipient of the given DM channel. */
export async function ensureRecipient(channelId: bigint, userId: bigint): Promise<void> {
  const r = await db
    .select({ userId: schema.dmRecipients.userId })
    .from(schema.dmRecipients)
    .where(
      and(eq(schema.dmRecipients.channelId, channelId), eq(schema.dmRecipients.userId, userId)),
    )
    .limit(1);
  if (!r[0]) throw errors.notFound('Channel');
}

/** Pull the OTHER user's id from a 1:1 DM (used to render display names client-side). */
export async function getOtherRecipient(
  channelId: bigint,
  selfId: bigint,
): Promise<bigint | null> {
  const r = await db
    .select({ userId: schema.dmRecipients.userId })
    .from(schema.dmRecipients)
    .where(
      and(
        eq(schema.dmRecipients.channelId, channelId),
        ne(schema.dmRecipients.userId, selfId),
      ),
    )
    .limit(1);
  return r[0]?.userId ?? null;
}

/**
 * List every recipient (self + others) of a DM/group-DM channel.
 * Used by the push-notification hook to fan out an inbound DM to all
 * recipients except the author. Returns user ids.
 */
/**
 * Every user the given user shares a DM or group DM with, deduped,
 * excluding the user themselves. Used for fanning out user-profile
 * updates (avatar, display name, status) to friends who don't share
 * a guild — without this, a DM-only friend wouldn't get the
 * USER_UPDATE gateway event and would see stale profile data until
 * they manually refreshed or the user sent them a new message.
 *
 * The query uses a self-join on dm_recipients: outer membership says
 * "channels the user is in", inner membership says "everyone in those
 * channels". The DISTINCT + `ne(userId, self)` filter handles the
 * group-DM case where the same peer might appear in multiple shared
 * channels.
 */
export async function listDmPeers(userId: bigint): Promise<bigint[]> {
  const r = await db
    .selectDistinct({ peer: schema.dmRecipients.userId })
    .from(schema.dmRecipients)
    .where(
      and(
        // The "channels the user is in" subselect. Inline rather than
        // a second roundtrip — the planner can fold this into a hash
        // join or anti-join depending on row counts.
        inArray(
          schema.dmRecipients.channelId,
          db
            .select({ channelId: schema.dmRecipients.channelId })
            .from(schema.dmRecipients)
            .where(eq(schema.dmRecipients.userId, userId)),
        ),
        ne(schema.dmRecipients.userId, userId),
      ),
    );
  return r.map((row) => row.peer);
}

export async function listAllRecipients(channelId: bigint): Promise<bigint[]> {
  const r = await db
    .select({ userId: schema.dmRecipients.userId })
    .from(schema.dmRecipients)
    .where(eq(schema.dmRecipients.channelId, channelId));
  return r.map((row) => row.userId);
}

/**
 * Load the OTHER recipient(s) for a single DM channel — i.e. everyone
 * except `selfId`. Returns full User rows so the route layer can pass
 * them to `toChannel(... , recipients)` for client hydration.
 */
// Only the columns toPublicUser reads. The full users row carries ~20 unused
// wide/jsonb/secret columns (voicePrefs/guildOrder/guildFolders blobs +
// passwordHash/botTokenHash/botEventSecret/totpSecret/email) that were being
// fetched and discarded for every DM peer on every DM-sidebar open.
const PUBLIC_USER_COLS = {
  id: schema.users.id,
  username: schema.users.username,
  displayName: schema.users.displayName,
  avatarUrl: schema.users.avatarUrl,
  bannerUrl: schema.users.bannerUrl,
  bio: schema.users.bio,
  avatarDecoration: schema.users.avatarDecoration,
  status: schema.users.status,
  customStatus: schema.users.customStatus,
  customStatusEmoji: schema.users.customStatusEmoji,
  customStatusExpiresAt: schema.users.customStatusExpiresAt,
  publicKey: schema.users.publicKey,
  createdAt: schema.users.createdAt,
  isBot: schema.users.isBot,
  tagLabel: schema.users.tagLabel,
  tagColor: schema.users.tagColor,
  isAdmin: schema.users.isAdmin,
  isModerator: schema.users.isModerator,
  staffColor: schema.users.staffColor,
  staffGlow: schema.users.staffGlow,
} as const;

export async function loadOtherRecipients(
  channelId: bigint,
  selfId: bigint,
): Promise<typeof schema.users.$inferSelect[]> {
  const r = await db
    .select({ user: PUBLIC_USER_COLS })
    .from(schema.dmRecipients)
    .innerJoin(schema.users, eq(schema.users.id, schema.dmRecipients.userId))
    .where(
      and(
        eq(schema.dmRecipients.channelId, channelId),
        ne(schema.dmRecipients.userId, selfId),
      ),
    );
  // Narrowed projection carries exactly the fields toPublicUser reads; cast to
  // the full row type the DTO mappers are annotated with.
  return r.map((row) => row.user) as unknown as typeof schema.users.$inferSelect[];
}

/**
 * Load EVERY recipient of a DM channel (self included) as public User rows.
 * Used to build one channel DTO per recipient — each from that recipient's
 * own point of view — for gateway fan-out (see routes/dms.ts).
 */
export async function loadAllRecipientUsers(
  channelId: bigint,
): Promise<typeof schema.users.$inferSelect[]> {
  const r = await db
    .select({ user: PUBLIC_USER_COLS })
    .from(schema.dmRecipients)
    .innerJoin(schema.users, eq(schema.users.id, schema.dmRecipients.userId))
    .where(eq(schema.dmRecipients.channelId, channelId));
  return r.map((row) => row.user) as unknown as typeof schema.users.$inferSelect[];
}

/**
 * Bulk variant of `loadOtherRecipients` — for a list of channel ids,
 * returns a map of channelId → recipients (excluding `selfId`). Used
 * by the DM-list route to avoid N+1 queries when the user has many
 * conversations.
 */
export async function loadRecipientsForChannels(
  channelIds: bigint[],
  selfId: bigint,
): Promise<Map<string, typeof schema.users.$inferSelect[]>> {
  const out = new Map<string, typeof schema.users.$inferSelect[]>();
  if (channelIds.length === 0) return out;
  const rows = await db
    .select({
      channelId: schema.dmRecipients.channelId,
      user: PUBLIC_USER_COLS,
    })
    .from(schema.dmRecipients)
    .innerJoin(schema.users, eq(schema.users.id, schema.dmRecipients.userId))
    .where(
      and(
        inArray(schema.dmRecipients.channelId, channelIds),
        ne(schema.dmRecipients.userId, selfId),
      ),
    );
  for (const r of rows) {
    const key = r.channelId.toString();
    let bucket = out.get(key);
    if (!bucket) {
      bucket = [];
      out.set(key, bucket);
    }
    // Narrowed projection → full row type the DTO mappers expect.
    bucket.push(r.user as unknown as typeof schema.users.$inferSelect);
  }
  return out;
}

export type EnableE2eeResult =
  /** This caller flipped the DM OFF -> ON; their salt/verifier are stored. */
  | { status: 'enabled' }
  /** Already ON with the IDENTICAL salt+verifier — idempotent retry, no-op. */
  | { status: 'unchanged' }
  /** Already ON with DIFFERENT values — refused (would clobber the first
      party's key and break their handshake). Caller should unlock with the
      existing password instead of enabling. */
  | { status: 'already_enabled' };

/**
 * Enable shared-key E2EE on a DM with first-writer-wins semantics.
 *
 * Why not a plain UPDATE: two participants who both toggle encryption on
 * while it's OFF would otherwise each write their OWN salt/verifier, and the
 * last write would win — leaving the two clients with keys derived from
 * different passphrases, so neither can decrypt the other (broken handshake).
 *
 * The OFF -> ON transition is claimed by a conditional UPDATE
 * (`WHERE e2ee_enabled = false`). Under concurrency Postgres serializes the
 * row updates and re-checks the predicate after the first commits, so exactly
 * one racing caller matches a row and wins; the rest match zero.
 *
 * Outcomes for a caller that did NOT win the claim:
 *   - identical salt+verifier already stored  -> `unchanged` (idempotent retry)
 *   - different values stored                 -> `already_enabled` (refused;
 *     we never overwrite a live key — the loser unlocks instead)
 *   - row flipped back to OFF (a concurrent DISABLE landed in between) -> we
 *     retry the claim once, so a legitimate fresh enable still succeeds.
 *
 * Intentional password ROTATION is deliberately NOT done by re-calling enable
 * (that's indistinguishable from a racing duplicate and would silently clobber
 * the peer). Rotation goes through the gated disable (which requires the
 * current purge proof — see disableE2eeAndPurge) + a fresh enable.
 *
 * `purgeProof` (base64 SHA-256(key || "zkE2EE/purge-v1")) is stored only as
 * its hash and gates the purge. Optional so an old client can still enable;
 * such a DM starts without a proof and is handled like a pre-0128 one (see
 * registerE2eePurgeProof).
 */
export async function enableE2ee(
  channelId: bigint,
  salt: string,
  verifier: string,
  purgeProof?: string,
): Promise<EnableE2eeResult> {
  const purgeProofHash = purgeProof ? hashPurgeProof(purgeProof) : null;
  const claim = () =>
    db
      .update(schema.channels)
      .set({
        e2eeEnabled: true,
        e2eeSalt: salt,
        e2eeVerifier: verifier,
        e2eePurgeProofHash: purgeProofHash,
      })
      .where(and(eq(schema.channels.id, channelId), eq(schema.channels.e2eeEnabled, false)))
      .returning({ id: schema.channels.id });

  if ((await claim()).length > 0) return { status: 'enabled' };

  // Didn't win the OFF -> ON claim. Inspect current state to classify.
  const [ch] = await db
    .select({
      enabled: schema.channels.e2eeEnabled,
      salt: schema.channels.e2eeSalt,
      verifier: schema.channels.e2eeVerifier,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);

  // Flipped back to OFF in the gap (a concurrent disable) — retry the claim.
  if (!ch || !ch.enabled) {
    return (await claim()).length > 0 ? { status: 'enabled' } : { status: 'already_enabled' };
  }
  if (ch.salt === salt && ch.verifier === verifier) return { status: 'unchanged' };
  return { status: 'already_enabled' };
}

/** Timing-safe equality for two base64 verifier strings. False on any
    length mismatch (timingSafeEqual throws on unequal-length buffers).
    Constant-time is belt-and-suspenders — the verifier is a 256-bit hash —
    but it's the right hygiene for a security comparison. */
function verifiersMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/** What channels.e2ee_purge_proof_hash stores for a client purgeProof: hex
    SHA-256 of the base64 string. The proof is itself a 256-bit hash of the
    key, so one unsalted round is enough to keep the stored value from being
    replayable if the row ever leaks. */
export function hashPurgeProof(purgeProof: string): string {
  return createHash('sha256').update(purgeProof, 'utf8').digest('hex');
}

/** Constant-time check of a submitted purgeProof against a stored hash. */
function purgeProofMatches(submitted: string | undefined, storedHash: string): boolean {
  if (!submitted) return false;
  return verifiersMatch(hashPurgeProof(submitted), storedHash);
}

export type RegisterPurgeProofResult =
  /** The DM had no proof; the caller's is now stored. */
  | { status: 'registered' }
  /** The identical proof is already stored — idempotent, no-op. */
  | { status: 'unchanged' }
  /** A DIFFERENT proof is already stored — refused, never overwritten. */
  | { status: 'already_registered' }
  /** E2EE is off on this DM. */
  | { status: 'not_enabled' }
  /** The submitted verifier isn't the DM's current one (stale key). */
  | { status: 'verifier_mismatch' };

/**
 * Register the purge proof for a DM that has none: one encrypted before
 * migration 0128, or enabled by a client that predates the proof.
 *
 * The server cannot check that a proof was derived from the DM key (it only
 * knows the public verifier), so this is trust-on-first-use: the first
 * registration wins and is never overwritten. Updated clients register as
 * soon as they hold the key (on unlock, on opening an unlocked DM, or, on
 * the native apps, on loading the DM list, whenever the DTO says
 * `e2eePurgeProofSet: false`), which closes the window in which a
 * participant without the password could echo the public verifier and purge.
 * A peer who races in first with a bogus proof gains nothing they could not
 * already do in that window (purge with the verifier); at worst the key
 * holders can no longer turn encryption off (or re-key, which is disable +
 * enable), which loses no data. There is deliberately no in-app recovery:
 * the server can't tell a key holder from that peer, so any way out open to
 * one is open to the other (a verifier-only disable that skips the purge,
 * say, would let the peer re-enable under its own key and then purge the old
 * ciphertext with its own proof). A server operator can reset the DM to the
 * unregistered state with
 *   UPDATE channels SET e2ee_purge_proof_hash = NULL WHERE id = <channel id>;
 * and the next key holder to open it registers again.
 *
 * The verifier must match so a stale key from an earlier enable can't
 * register against the current one.
 */
export async function registerE2eePurgeProof(
  channelId: bigint,
  verifier: string,
  purgeProof: string,
): Promise<RegisterPurgeProofResult> {
  const hash = hashPurgeProof(purgeProof);
  const claimed = await db
    .update(schema.channels)
    .set({ e2eePurgeProofHash: hash })
    .where(
      and(
        eq(schema.channels.id, channelId),
        eq(schema.channels.e2eeEnabled, true),
        eq(schema.channels.e2eeVerifier, verifier),
        isNull(schema.channels.e2eePurgeProofHash),
      ),
    )
    .returning({ id: schema.channels.id });
  if (claimed.length > 0) return { status: 'registered' };

  const [ch] = await db
    .select({
      enabled: schema.channels.e2eeEnabled,
      verifier: schema.channels.e2eeVerifier,
      purgeProofHash: schema.channels.e2eePurgeProofHash,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  if (!ch || !ch.enabled || !ch.verifier) return { status: 'not_enabled' };
  if (!verifiersMatch(verifier, ch.verifier)) return { status: 'verifier_mismatch' };
  if (ch.purgeProofHash && verifiersMatch(hash, ch.purgeProofHash)) {
    return { status: 'unchanged' };
  }
  return { status: 'already_registered' };
}

export type DisableE2eeResult =
  /** E2EE was already off (or never on) — nothing to verify or purge. */
  | { status: 'not_enabled'; purgedMessageIds: bigint[] }
  /** The submitted verifier didn't match the stored one — refused, no purge. */
  | { status: 'verifier_mismatch'; purgedMessageIds: bigint[] }
  /** The DM has a stored purge proof and the caller's was missing or wrong —
      refused, no purge. */
  | { status: 'purge_proof_mismatch'; purgedMessageIds: bigint[] }
  /** Disabled + purged. */
  | { status: 'disabled'; purgedMessageIds: bigint[] };

/**
 * Disable E2EE on a DM and purge all encrypted messages in the
 * conversation — BUT only after verifying the caller knows the passphrase.
 *
 * Because disabling hard-deletes the encrypted history, we require proof
 * that only a key holder can produce:
 *   - `submittedVerifier` must match the stored verifier (`verifier_mismatch`
 *     otherwise). The verifier is PUBLIC (every participant gets it in the
 *     channel DTO), so on its own this only catches a stale key.
 *   - When the DM has a stored purge-proof hash, `submittedPurgeProof` must
 *     hash to it (`purge_proof_mismatch` otherwise). The hash is never sent to
 *     clients, so a participant who never knew the password can't produce it,
 *     and an old client that sends no proof can't purge such a DM.
 * Either refusal purges nothing.
 *
 * A DM with NO stored hash (encrypted before migration 0128, or by an old
 * client, and no key holder has registered a proof yet — see
 * registerE2eePurgeProof) still purges on the verifier alone, as before, so
 * old clients keep working there. Any proof would be accepted for such a DM
 * anyway (the server can't check it against the key), so requiring one would
 * only lock out old clients without stopping anyone.
 *
 * "Purge" means hard delete of messages whose content begins with the
 * `zkE2EE/` wire-format prefix. Plaintext messages from before E2EE was
 * enabled (or any window when it was off) are preserved — turning E2EE off
 * wipes the now-undecryptable ciphertext while sparing plaintext history.
 *
 * The verifier read, the message delete, and the state clear all run in one
 * transaction: the check can't race the purge, and a crash mid-way can't
 * leave the channel "disabled but still holding ciphertext."
 */
export async function disableE2eeAndPurge(
  channelId: bigint,
  submittedVerifier: string,
  submittedPurgeProof?: string,
): Promise<DisableE2eeResult> {
  return db.transaction(async (tx) => {
    const [ch] = await tx
      .select({
        e2eeEnabled: schema.channels.e2eeEnabled,
        e2eeVerifier: schema.channels.e2eeVerifier,
        e2eePurgeProofHash: schema.channels.e2eePurgeProofHash,
      })
      .from(schema.channels)
      .where(eq(schema.channels.id, channelId))
      .limit(1)
      // Row lock: a concurrent registerE2eePurgeProof can't slip a hash in
      // between this check and the purge.
      .for('update');
    if (!ch || !ch.e2eeEnabled || !ch.e2eeVerifier) {
      return { status: 'not_enabled', purgedMessageIds: [] };
    }
    if (!verifiersMatch(submittedVerifier, ch.e2eeVerifier)) {
      return { status: 'verifier_mismatch', purgedMessageIds: [] };
    }
    if (
      ch.e2eePurgeProofHash &&
      !purgeProofMatches(submittedPurgeProof, ch.e2eePurgeProofHash)
    ) {
      return { status: 'purge_proof_mismatch', purgedMessageIds: [] };
    }
    // Find every encrypted message in the channel. We match on the
    // content prefix `zkE2EE/` so future wire-format bumps (zkE2EE/2:,
    // zkE2EE/3:) automatically participate without code change.
    const encryptedRows = await tx
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(
        and(
          eq(schema.messages.channelId, channelId),
          like(schema.messages.content, 'zkE2EE/%'),
        ),
      );
    const purgedMessageIds = encryptedRows.map((r) => r.id);
    if (purgedMessageIds.length > 0) {
      await tx
        .delete(schema.messages)
        .where(inArray(schema.messages.id, purgedMessageIds));
      // The newest message was most likely ciphertext: move the unread
      // watermark back to what is left, as a delete does, so it never names
      // a row nobody can load (or ack). The route's CHANNEL_UPDATE carries it.
      await rollbackChannelWatermarks([channelId], purgedMessageIds, tx as DbHandle);
    }
    // Clear the E2EE state. enabled→false, salt+verifier+proof hash→null.
    await tx
      .update(schema.channels)
      .set({
        e2eeEnabled: false,
        e2eeSalt: null,
        e2eeVerifier: null,
        e2eePurgeProofHash: null,
      })
      .where(eq(schema.channels.id, channelId));
    return { status: 'disabled', purgedMessageIds };
  });
}

/**
 * Close (delete) a DM channel for one user without affecting the other
 * party's view of it. Implementation: hard-remove the dm_recipients
 * row for THIS user only. The channel and its messages persist; the
 * other recipient continues to see the conversation. If this user
 * later opens a fresh DM with the same person, getOrCreateDM looks
 * for a channel where BOTH are recipients — finds none — and creates
 * a new channel with empty history. That's the behavior the user
 * asked for: "delete completely" from their side.
 *
 * Throws notFound if the user wasn't a recipient of the channel.
 */
export async function closeDMForUser(input: {
  channelId: bigint;
  userId: bigint;
}): Promise<void> {
  const removed = await db
    .delete(schema.dmRecipients)
    .where(
      and(
        eq(schema.dmRecipients.channelId, input.channelId),
        eq(schema.dmRecipients.userId, input.userId),
      ),
    )
    .returning({ userId: schema.dmRecipients.userId });
  if (removed.length === 0) throw errors.notFound('DM channel');
}

// ── Disappearing messages (Signal-style, per message) ──────────────────────
//
// Either recipient sets a timer on the conversation (dm_settings
// .ttl_seconds_after_read, 1 s .. 4 weeks, or off). The timer belongs to
// each MESSAGE, not to the conversation:
//
//   - createMessage snapshots the timer in force into
//     messages.expire_after_seconds. Changing the setting only affects
//     later messages; turning it off doesn't save messages already sent
//     with one. System rows never get one.
//
//   - The clock starts when a recipient READS the message — their read ack
//     (startDisappearingTimers, from POST .../messages/:id/ack) stamps
//     expires_at = now() + expire_after_seconds. So does anything else they
//     do that moves their read marker past it: a send (a notification quick
//     reply is just a send) and a timer change (startDisappearingTimersAndNotify
//     covers all three). A plain message-list fetch does not (it only stamps
//     viewed_at, for read receipts), and a send that isn't a read (a
//     scheduled message firing, a send flagged notARead — Siri / Watch, a
//     forward from web) starts nothing and doesn't move the marker past one
//     that is still waiting (notifyHeldReadMarker tells the sender's devices).
//     Group DMs use "first reader among the non-authors": one shared clock.
//
//   - At expires_at the message is gone for everyone: every read path
//     filters it out at once (messages.notExpired), and the sweep below
//     soft-deletes it and sends MESSAGE_DELETE. Soft delete, like every
//     delete: read-state acks tolerate tombstones, and parental supervision
//     reads deleted content on purpose.
//
//   - A change posts a 'system_disappearing' notice in the DM (in the same
//     transaction as the setting), which never has a timer itself.

/**
 * Read the disappearing-messages timer for a DM channel: the seconds new
 * messages get, or null when it is off.
 */
export async function getDmSettings(channelId: bigint): Promise<{
  ttlSecondsAfterRead: number | null;
}> {
  const r = await db
    .select({ ttlSecondsAfterRead: schema.dmSettings.ttlSecondsAfterRead })
    .from(schema.dmSettings)
    .where(eq(schema.dmSettings.channelId, channelId))
    .limit(1);
  return { ttlSecondsAfterRead: r[0]?.ttlSecondsAfterRead ?? null };
}

/**
 * Set a DM's disappearing-messages timer: whole seconds in
 * [1, 2419200], or null to turn it off. It applies to messages sent
 * from now on only.
 *
 * Only an actual change writes anything: repeating the current value (every
 * installed client re-PATCHes when a row is tapped) returns
 * `{ changed: false }` with no write and no notice. The compare is part of
 * the write itself, so two identical concurrent changes post ONE notice. On
 * a change, the 'system_disappearing' notice is inserted in the same
 * transaction — the channel's newest message, and read for the changer —
 * and returned for the caller to dispatch. The caller runs the send gates
 * (mute, block, rate limit) before calling this.
 */
export async function updateDmSettings(input: {
  channelId: bigint;
  ttlSecondsAfterRead: number | null;
  /** The recipient making the change; the notice is authored by them. */
  changedBy: bigint;
}): Promise<{ changed: false } | { changed: true; notice: schema.Message }> {
  const ttl = input.ttlSecondsAfterRead;
  if (
    ttl !== null &&
    (!Number.isInteger(ttl) || ttl < DISAPPEARING_MIN_SECONDS || ttl > DISAPPEARING_MAX_SECONDS)
  ) {
    throw errors.badRequest(
      `The timer must be a whole number of seconds from ${DISAPPEARING_MIN_SECONDS} to ${DISAPPEARING_MAX_SECONDS}, or null`,
    );
  }
  // The changer's display name for the fallback text old apps show as-is.
  const [actor] = await db
    .select({ displayName: schema.users.displayName, username: schema.users.username })
    .from(schema.users)
    .where(eq(schema.users.id, input.changedBy))
    .limit(1);
  const actorName = actor?.displayName || actor?.username || 'Someone';

  return db.transaction(async (tx) => {
    let changed: boolean;
    if (ttl === null) {
      // Off: only an existing row with a timer changes. No row = already off,
      // and creating an all-defaults row would be a write for nothing.
      const r = await tx
        .update(schema.dmSettings)
        .set({ ttlSecondsAfterRead: null, updatedAt: new Date() })
        .where(
          and(
            eq(schema.dmSettings.channelId, input.channelId),
            sql`${schema.dmSettings.ttlSecondsAfterRead} IS NOT NULL`,
          ),
        )
        .returning({ channelId: schema.dmSettings.channelId });
      changed = r.length > 0;
    } else {
      // The setWhere makes an unchanged value a no-op (no row returned). A
      // concurrent identical change waits on the row lock, then re-checks
      // against the committed value and also comes back empty.
      const r = await tx
        .insert(schema.dmSettings)
        .values({ channelId: input.channelId, ttlSecondsAfterRead: ttl, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.dmSettings.channelId,
          set: { ttlSecondsAfterRead: ttl, updatedAt: new Date() },
          setWhere: sql`${schema.dmSettings.ttlSecondsAfterRead} IS DISTINCT FROM ${ttl}`,
        })
        .returning({ channelId: schema.dmSettings.channelId });
      changed = r.length > 0;
    }
    if (!changed) return { changed: false as const };
    const notice = await createSystemMessage(
      {
        channelId: input.channelId,
        guildId: null,
        authorId: input.changedBy,
        content: disappearingNoticeText(actorName, ttl),
        type: 'system_disappearing',
        mentionedUserIds: [],
        metadata: {
          kind: 'disappearing_timer',
          timerSeconds: ttl ?? 0,
          initiatorId: input.changedBy.toString(),
        },
        advanceReadMarkers: true,
      },
      tx as DbHandle,
    );
    return { changed: true as const, notice };
  });
}

// ── Per-recipient DM notification preview preference ────────────────────────

/** This user's notification-preview choice for a DM: true = show content,
 *  false = generic, null = not set (use the default). */
export async function getDmNotificationPref(
  userId: bigint,
  channelId: bigint,
): Promise<boolean | null> {
  const [r] = await db
    .select({ showContent: schema.dmNotificationPrefs.showContent })
    .from(schema.dmNotificationPrefs)
    .where(
      and(
        eq(schema.dmNotificationPrefs.userId, userId),
        eq(schema.dmNotificationPrefs.channelId, channelId),
      ),
    )
    .limit(1);
  return r ? r.showContent : null;
}

/** Set (true/false) or clear (null → revert to default) this user's
 *  notification-preview choice for a DM. */
export async function setDmNotificationPref(
  userId: bigint,
  channelId: bigint,
  showContent: boolean | null,
): Promise<void> {
  if (showContent === null) {
    await db
      .delete(schema.dmNotificationPrefs)
      .where(
        and(
          eq(schema.dmNotificationPrefs.userId, userId),
          eq(schema.dmNotificationPrefs.channelId, channelId),
        ),
      );
    return;
  }
  await db
    .insert(schema.dmNotificationPrefs)
    .values({ userId, channelId, showContent, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.dmNotificationPrefs.userId, schema.dmNotificationPrefs.channelId],
      set: { showContent, updatedAt: new Date() },
    });
}

// ── Personal DM nicknames ───────────────────────────────────────────────────

/** The current user's full personal-nickname map: { targetUserId: nickname }.
 *  Fetched once at login and applied client-side wherever a DM peer renders. */
export async function getNicknameMap(ownerId: bigint): Promise<Record<string, string>> {
  const rows = await db
    .select({ targetId: schema.dmNicknames.targetId, nickname: schema.dmNicknames.nickname })
    .from(schema.dmNicknames)
    .where(eq(schema.dmNicknames.ownerId, ownerId));
  const out: Record<string, string> = {};
  for (const r of rows) out[r.targetId.toString()] = r.nickname;
  return out;
}

/** Set (upsert) the current user's personal nickname for a target user. */
export async function setNickname(
  ownerId: bigint,
  targetId: bigint,
  nickname: string,
): Promise<void> {
  await db
    .insert(schema.dmNicknames)
    .values({ ownerId, targetId, nickname, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: [schema.dmNicknames.ownerId, schema.dmNicknames.targetId],
      set: { nickname, updatedAt: new Date() },
    });
}

/** Clear the current user's personal nickname for a target user (idempotent). */
export async function clearNickname(ownerId: bigint, targetId: bigint): Promise<void> {
  await db
    .delete(schema.dmNicknames)
    .where(
      and(eq(schema.dmNicknames.ownerId, ownerId), eq(schema.dmNicknames.targetId, targetId)),
    );
}

/** Bulk-load several users' preview choices for one DM (push fan-out). Returns
 *  a map of userId → explicit choice; absence means "no row → use default". */
export async function getDmNotificationPrefsForChannel(
  channelId: bigint,
  userIds: bigint[],
): Promise<Map<bigint, boolean>> {
  const out = new Map<bigint, boolean>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({
      userId: schema.dmNotificationPrefs.userId,
      showContent: schema.dmNotificationPrefs.showContent,
    })
    .from(schema.dmNotificationPrefs)
    .where(
      and(
        eq(schema.dmNotificationPrefs.channelId, channelId),
        inArray(schema.dmNotificationPrefs.userId, userIds),
      ),
    );
  for (const r of rows) out.set(r.userId, r.showContent);
  return out;
}

/**
 * Stamp `viewed_at = now()` on every message in `messageIds` that:
 *   - lives in `channelId`,
 *   - was not authored by `viewerId` (you can't "view" your own
 *     message — viewed_at tracks the OTHER party's read),
 *   - has viewed_at still NULL.
 *
 * Stamping is UNCONDITIONAL — even when the viewer has read receipts
 * disabled, the column gets written (it keeps the column reliable for
 * anything that depends on it; the disappearing-messages clock is the
 * separate expires_at, started only by a read ack — see
 * startDisappearingTimers).
 *
 * Receipt visibility — the actual "the sender's UI sees Read" effect
 * — is gated separately at the dispatch + DTO layers. This function
 * returns BOTH the stamped pairs AND a `viewerReceiptsEnabled` flag
 * so the caller can decide whether to fire MESSAGE_VIEWED events
 * and whether to surface the timestamp in the response DTO. The
 * gate is the viewer's own dmReadReceiptsEnabled, since this column
 * represents the viewer's read.
 */
export async function markMessagesViewed(
  channelId: bigint,
  viewerId: bigint,
  messageIds: bigint[],
): Promise<{
  stamped: Array<{ messageId: bigint; authorId: bigint }>;
  /** The stored viewed_at (one value for the whole batch). */
  viewedAt: Date;
  viewerReceiptsEnabled: boolean;
}> {
  const viewedAt = new Date();
  if (messageIds.length === 0) {
    return { stamped: [], viewedAt, viewerReceiptsEnabled: true };
  }
  // Read the viewer's toggle so the caller can gate dispatch. We do
  // NOT use it to gate the stamp — see the comment above.
  const [viewer] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, viewerId))
    .limit(1);
  const viewerReceiptsEnabled = viewer?.enabled ?? true;
  // Single UPDATE with IN-list. Bounded by however many messages the
  // route loads at a time (the default page is ~50), so this is
  // never a multi-thousand-row hammer. .returning() pulls the
  // author ids back so we can dispatch MESSAGE_VIEWED scoped to
  // each author without a second SELECT.
  const updated = await db
    .update(schema.messages)
    .set({ viewedAt })
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        inArray(schema.messages.id, messageIds),
        sql`${schema.messages.viewedAt} IS NULL`,
        sql`(${schema.messages.authorId} <> ${viewerId} OR ${schema.messages.authorId} IS NULL)`,
      ),
    )
    .returning({
      id: schema.messages.id,
      authorId: schema.messages.authorId,
    });
  const stamped = updated
    .filter((r): r is { id: bigint; authorId: bigint } => r.authorId !== null)
    .map((r) => ({ messageId: r.id, authorId: r.authorId }));
  return { stamped, viewedAt, viewerReceiptsEnabled };
}

/**
 * Bulk variant of markMessagesViewed — stamps viewed_at on EVERY
 * unviewed non-self message in `channelId` up to and including
 * `upToMessageId`. Driven by the channel-ack path: when the user
 * acks through a message, every prior unviewed message in the
 * conversation is implicitly read too. This is the path that
 * advances "Delivered" to "Read" when a new message arrives via
 * gateway while the recipient already has the DM open — without
 * it, the receipt would stick at Delivered until the next
 * listMessages call (page refresh).
 *
 * Same privacy semantics as markMessagesViewed: stamping is
 * unconditional, the caller gates dispatch + DTO surface on the
 * viewer's toggle. (The disappearing-messages clock is separate:
 * startDisappearingTimers below.)
 */
export async function markMessagesViewedUpTo(
  channelId: bigint,
  viewerId: bigint,
  upToMessageId: bigint,
): Promise<{
  stamped: Array<{ messageId: bigint; authorId: bigint }>;
  /** The stored viewed_at (one value for the whole batch). */
  viewedAt: Date;
  viewerReceiptsEnabled: boolean;
}> {
  const [viewer] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, viewerId))
    .limit(1);
  const viewerReceiptsEnabled = viewer?.enabled ?? true;

  // UPDATE … WHERE channel = X AND id <= upTo AND viewed_at IS NULL
  // AND author <> viewer. .returning() pulls the author ids so we
  // can dispatch MESSAGE_VIEWED per author. Bounded by however many
  // unviewed messages live in the channel — typically very small
  // when this fires (one new gateway message), but on a channel
  // that was scrolled-away-from for a while it could be larger.
  // No artificial cap: the user explicitly opened the channel, so
  // marking all prior unviewed messages is the desired semantic.
  const viewedAt = new Date();
  const updated = await db
    .update(schema.messages)
    .set({ viewedAt })
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        sql`${schema.messages.id} <= ${upToMessageId}`,
        sql`${schema.messages.viewedAt} IS NULL`,
        sql`(${schema.messages.authorId} <> ${viewerId} OR ${schema.messages.authorId} IS NULL)`,
      ),
    )
    .returning({
      id: schema.messages.id,
      authorId: schema.messages.authorId,
    });
  const stamped = updated
    .filter((r): r is { id: bigint; authorId: bigint } => r.authorId !== null)
    .map((r) => ({ messageId: r.id, authorId: r.authorId }));
  return { stamped, viewedAt, viewerReceiptsEnabled };
}

/**
 * Disappearing messages: start the clock on everything the reader just read.
 * Driven by the read ack (POST /channels/:id/messages/:mid/ack) in 1:1 and
 * group DMs — NOT by a message-list fetch — for every message up to and
 * including `upToMessageId` that was sent with a timer, isn't counting down
 * yet, and wasn't written by the reader:
 *
 *   expires_at = now() + expire_after_seconds   (DB clock)
 *
 * Unconditional on the reader's read-receipts toggle — the timer is the
 * conversation's, and a receipts-off reader must not keep messages forever.
 * The toggle only decides who may LEARN expires_at (it minus the timer is
 * the read time); the caller gates the dispatch on `viewerReceiptsEnabled`.
 *
 * `serverNow` is the DB's now() for this stamp, so `expiresAt - serverNow`
 * is exactly each message's timer.
 */
export async function startDisappearingTimers(
  channelId: bigint,
  viewerId: bigint,
  upToMessageId: bigint,
): Promise<{
  started: Array<{ messageId: bigint; authorId: bigint | null; expiresAt: Date }>;
  serverNow: Date;
  viewerReceiptsEnabled: boolean;
}> {
  // The uncorrelated EXISTS is a one-time check: a DM that never had a
  // dm_settings row can't hold a message with a timer (createMessage reads
  // the timer from that row, and it is never deleted on its own), so the
  // common case touches no message rows at all. Otherwise the partial
  // messages_timer_pending_idx holds just the rows still waiting for a
  // reader, so a long history (deleted rows included) isn't walked per ack.
  const updated = await db
    .update(schema.messages)
    .set({
      expiresAt: sql`now() + make_interval(secs => ${schema.messages.expireAfterSeconds})`,
    })
    .where(
      and(
        eq(schema.messages.channelId, channelId),
        sql`${schema.messages.id} <= ${upToMessageId}`,
        sql`${schema.messages.expireAfterSeconds} IS NOT NULL`,
        isNull(schema.messages.expiresAt),
        isNull(schema.messages.deletedAt),
        sql`${schema.messages.authorId} IS DISTINCT FROM ${viewerId}`,
        sql`EXISTS (SELECT 1 FROM dm_settings s WHERE s.channel_id = ${channelId})`,
      ),
    )
    .returning({
      id: schema.messages.id,
      authorId: schema.messages.authorId,
      expiresAt: schema.messages.expiresAt,
      expireAfterSeconds: schema.messages.expireAfterSeconds,
    });
  const started = updated
    .filter((r): r is typeof r & { expiresAt: Date } => r.expiresAt !== null)
    .map((r) => ({ messageId: r.id, authorId: r.authorId, expiresAt: r.expiresAt }));
  const first = updated[0];
  // now() is the same for every row of one statement: recover it from any.
  const serverNow =
    first && first.expiresAt && first.expireAfterSeconds !== null
      ? new Date(first.expiresAt.getTime() - first.expireAfterSeconds * 1000)
      : new Date();
  if (started.length === 0) {
    return { started, serverNow, viewerReceiptsEnabled: true };
  }
  const [viewer] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, viewerId))
    .limit(1);
  return { started, serverNow, viewerReceiptsEnabled: viewer?.enabled ?? true };
}

/**
 * Disappearing messages: `readerId`'s read marker in a DM just moved up to
 * `upToMessageId` by something they did — a read ack, a send (sending is a
 * full ack: notification quick replies on installed apps only POST the
 * message, and every client then skips the ack because the marker is
 * already current), or a timer change (the notice is read for the changer).
 * Wherever the server moves that marker it starts the clocks the marker now
 * covers, or those messages would never disappear.
 *
 * Starts them (startDisappearingTimers) and tells who may know: the reader's
 * own devices always; for a 1:1 'dm' also each author in the batch when the
 * reader has read receipts on — expires_at minus the timer IS the read time,
 * the same gate as MESSAGE_VIEWED. Group-DM authors (and a receipts-off
 * reader's peer) get the sweep's MESSAGE_DELETE instead.
 *
 * No-op outside 'dm' / 'group_dm'. Never throws: a failure is logged and
 * must not fail the ack / send / setting change that called it. Await it
 * after that action's transaction has committed.
 */
export async function startDisappearingTimersAndNotify(input: {
  channelId: bigint;
  channelType: schema.Channel['type'];
  readerId: bigint;
  upToMessageId: bigint;
}): Promise<void> {
  const { channelId, channelType, readerId, upToMessageId } = input;
  if (channelType !== 'dm' && channelType !== 'group_dm') return;
  try {
    const { started, serverNow, viewerReceiptsEnabled } = await startDisappearingTimers(
      channelId,
      readerId,
      upToMessageId,
    );
    if (started.length === 0) return;
    // The reader's own devices: everything that started.
    dispatch.messageExpiry({
      userId: readerId,
      channelId,
      expiries: started.map((e) => ({ messageId: e.messageId, expiresAt: e.expiresAt })),
      serverNow,
    });
    if (channelType !== 'dm' || !viewerReceiptsEnabled) return;
    const byAuthor = new Map<bigint, Array<{ messageId: bigint; expiresAt: Date }>>();
    for (const e of started) {
      if (e.authorId === null) continue;
      const list = byAuthor.get(e.authorId);
      const item = { messageId: e.messageId, expiresAt: e.expiresAt };
      if (list) list.push(item);
      else byAuthor.set(e.authorId, [item]);
    }
    for (const [authorId, expiries] of byAuthor) {
      dispatch.messageExpiry({ userId: authorId, channelId, expiries, serverNow });
    }
  } catch (err) {
    log.warn?.('disappearing timer start failed', {
      channelId: channelId.toString(),
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * A send that isn't a read held `userId`'s read marker in a DM below someone
 * else's message still waiting for its clock (createMessage's
 * `authorMarkerHeld`), or a row they author left it there (the streak
 * warning; both probe with messages.timedMessageWaitingFor). Every client
 * moves its local marker to its own message when the MESSAGE_CREATE echo
 * arrives, so the DM reads as read there and its next open acks nothing —
 * installed iOS builds then never start the clock of what they show. Send
 * the stored state to the user's devices as a CHANNEL_ACK (iOS and Android
 * apply it as is) to put the marker back. Call it after the MESSAGE_CREATE:
 * one bus, so it arrives after the echo. Never throws.
 */
export async function notifyHeldReadMarker(input: {
  userId: bigint;
  channelId: bigint;
}): Promise<void> {
  try {
    const rs = await readStates.getOne(input.userId, input.channelId);
    dispatch.channelAck({ userId: input.userId, readState: toReadState(rs) });
  } catch (err) {
    log.warn?.('held read marker notify failed', {
      channelId: input.channelId.toString(),
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Stamp `delivered_at = now()` on a freshly-created DM message if
 * the column is still NULL.
 *
 * Stamping is UNCONDITIONAL with respect to the recipient's
 * receipts toggle (same rationale as markMessagesViewed — keeps
 * the column reliable for any future infrastructure that depends
 * on it). The toggle gates only the MESSAGE_DELIVERED dispatch
 * and DTO surface; the caller uses the returned flag to decide.
 *
 * Returns:
 *   - `stamped`: true if a stamp actually landed (false if already
 *     stamped or the message is gone)
 *   - `recipientReceiptsEnabled`: the recipient's current toggle,
 *     so the caller can decide whether to fire MESSAGE_DELIVERED
 *     and surface deliveredAt in subsequent DTOs.
 */
export async function markMessageDelivered(
  messageId: bigint,
  recipientId: bigint,
): Promise<{ stamped: boolean; recipientReceiptsEnabled: boolean }> {
  const [recipient] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, recipientId))
    .limit(1);
  const recipientReceiptsEnabled = recipient?.enabled ?? true;

  const updated = await db
    .update(schema.messages)
    .set({ deliveredAt: new Date() })
    .where(
      and(
        eq(schema.messages.id, messageId),
        sql`${schema.messages.deliveredAt} IS NULL`,
        sql`(${schema.messages.authorId} <> ${recipientId} OR ${schema.messages.authorId} IS NULL)`,
      ),
    )
    .returning({ id: schema.messages.id });
  return { stamped: updated.length > 0, recipientReceiptsEnabled };
}

/** Rows per sweep UPDATE, and the most batches one tick drains. */
const SWEEP_BATCH = 500;
const SWEEP_MAX_BATCHES = 10;

/**
 * Periodic sweep: soft-delete every message whose disappearing deadline
 * (`expires_at`) has passed. Runs on the leader every 10 s; safe to call
 * repeatedly. Rows with a NULL expires_at are never touched — the old rule
 * (viewed_at + the conversation's CURRENT timer) wiped history viewed before
 * a timer was even turned on.
 *
 * Batches of 500 in deadline order (the partial messages_expires_at_idx),
 * looping while a batch comes back full, at most 10 per call so one tick
 * stays bounded; the next tick picks up the rest. For each batch: one
 * MESSAGE_DELETE per row (installed apps predate MESSAGE_DELETE_BULK), and
 * each affected channel's last_message_id rolled back like deleteMessage
 * does, so an unread dot never points at a message nobody can load. A
 * recipient that rollback leaves at the tail with a mention count (a group-DM
 * @mention another member read first) gets it zeroed and a CHANNEL_ACK:
 * nothing is left to open and ack, so the badge would otherwise stay.
 *
 * Returns the number of messages soft-deleted.
 */
export async function sweepExpiredDmMessages(): Promise<number> {
  let total = 0;
  for (let batch = 0; batch < SWEEP_MAX_BATCHES; batch++) {
    // SKIP LOCKED: a row some other writer holds right now (an edit, a manual
    // delete) is simply taken next tick instead of stalling the sweep.
    const rows = await db.execute<{ id: string; channel_id: string }>(sql`
      UPDATE messages
         SET deleted_at = now()
       WHERE id IN (
               SELECT id FROM messages
                WHERE expires_at IS NOT NULL
                  AND expires_at <= now()
                  AND deleted_at IS NULL
                ORDER BY expires_at
                LIMIT ${SWEEP_BATCH}
                FOR UPDATE SKIP LOCKED
             )
         AND deleted_at IS NULL
      RETURNING id, channel_id
    `);
    // The drizzle execute() shape varies by adapter — node-postgres
    // returns an object with a `rows` array, postgres-js the array
    // directly. Normalize both.
    const affected = Array.isArray(rows)
      ? rows
      : (rows as { rows?: { id: string; channel_id: string }[] }).rows ?? [];
    if (affected.length === 0) break;
    total += affected.length;

    const deletedIds = affected.map((r) => BigInt(r.id));
    const channelIds = [...new Set(affected.map((r) => r.channel_id))].map((c) => BigInt(c));
    try {
      await rollbackChannelWatermarks(channelIds, deletedIds);
    } catch {
      // Best-effort: the rows are already gone; a stale watermark only
      // leaves an unread dot until the next message.
    }
    let cleared: Awaited<ReturnType<typeof readStates.clearMentionsAtTail>> = [];
    try {
      cleared = await readStates.clearMentionsAtTail(channelIds);
    } catch {
      // Best-effort, like the rollback: a stale badge until the next message.
    }
    for (const r of affected) {
      // DMs have no guild, so the audience is the channel's dm_recipients.
      // Per-row try/catch: one failed publish must not skip the rest — those
      // clients would keep showing deleted messages until they refetch.
      try {
        dispatch.messageDelete({
          messageId: BigInt(r.id),
          channelId: BigInt(r.channel_id),
          guildId: null,
        });
      } catch {
        // Best-effort. The DB delete already committed; clients will
        // catch up on next listMessages.
      }
    }
    // After the deletes, so a client has already rolled its copy back.
    for (const rs of cleared) {
      try {
        dispatch.channelAck({ userId: rs.userId, readState: toReadState(rs) });
      } catch {
        // Best-effort: the count is already zero; READY carries it.
      }
    }
    if (affected.length < SWEEP_BATCH) break;
  }
  return total;
}

/**
 * IDENTIFY-time backfill: stamp delivered_at on every pending DM
 * message addressed to this user. Returns the stamped (messageId,
 * channelId, authorId) tuples so the caller can fan out
 * MESSAGE_DELIVERED events to each original sender.
 *
 * Scoped to 1:1 DMs (`channels.type = 'dm'`) where the user is a
 * recipient. Honors the user's dmReadReceiptsEnabled toggle — if
 * receipts are off, no stamping happens and the function returns [].
 *
 * Capped at 500 messages per backfill. A recipient who's been
 * offline for weeks with thousands of unread DMs would otherwise
 * pay the full UPDATE on every IDENTIFY; the cap keeps the
 * connect path responsive. The remaining unstamped rows will get
 * picked up incrementally on subsequent listMessages calls (which
 * also drive viewed_at — and viewed implies delivered, so the
 * surface eventually catches up).
 */
export async function backfillPendingDeliveries(
  userId: bigint,
): Promise<{
  stamped: Array<{ messageId: bigint; channelId: bigint; authorId: bigint }>;
  userReceiptsEnabled: boolean;
}> {
  const [user] = await db
    .select({ enabled: schema.users.dmReadReceiptsEnabled })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  const userReceiptsEnabled = user?.enabled ?? true;

  // Single UPDATE driven by a CTE that walks the user's 1:1 DM
  // channels and finds rows the user didn't author with
  // delivered_at still NULL. Bounded by LIMIT 500. Stamping is
  // unconditional — see markMessagesViewed comment. The caller
  // gates the dispatch on userReceiptsEnabled.
  const rows = await db.execute<{
    id: string;
    channel_id: string;
    author_id: string;
  }>(sql`
    WITH pending AS (
      SELECT m.id
      FROM messages m
      JOIN dm_recipients dr
        ON dr.channel_id = m.channel_id AND dr.user_id = ${userId}
      JOIN channels c
        ON c.id = m.channel_id AND c.type = 'dm'
      WHERE m.delivered_at IS NULL
        AND m.deleted_at IS NULL
        AND (m.author_id IS NULL OR m.author_id <> ${userId})
      ORDER BY m.id DESC
      LIMIT 500
    )
    UPDATE messages SET delivered_at = now()
    WHERE id IN (SELECT id FROM pending)
    RETURNING id, channel_id, author_id
  `);
  // Adapter normalization (postgres-js vs node-postgres) — same
  // pattern used in the disappearing-messages sweep above.
  const affected = Array.isArray(rows)
    ? (rows as Array<{ id: string; channel_id: string; author_id: string | null }>)
    : ((rows as unknown as { rows?: Array<{ id: string; channel_id: string; author_id: string | null }> }).rows ?? []);
  const stamped = affected
    .filter((r): r is { id: string; channel_id: string; author_id: string } => r.author_id !== null)
    .map((r) => ({
      messageId: BigInt(r.id),
      channelId: BigInt(r.channel_id),
      authorId: BigInt(r.author_id),
    }));
  return { stamped, userReceiptsEnabled };
}
