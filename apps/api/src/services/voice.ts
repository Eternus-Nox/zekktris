/**
 * Voice service
 * -------------
 * Per-channel voice presence — who's currently in which voice channel,
 * what their mute/deafen state looks like. Backs the `VOICE_STATE_UPDATE`
 * gateway event and the audio layer's join handshake.
 *
 * Single-row-per-user invariant: a user can only be in ONE voice channel
 * at a time. Joining a different channel atomically deletes any existing
 * row before inserting the new one. The PRIMARY KEY on user_id enforces
 * this at the database level — concurrent joins resolve via INSERT
 * ... ON CONFLICT DO UPDATE.
 *
 * Audio plumbing: this module does NOT speak WebRTC. It owns the database
 * row + dispatches gateway events; a future round adds a LiveKit room per
 * voice channel and mints participant tokens here. For now the `token`
 * field returned from `joinVoice` is null with a note — clients can see
 * the participant count update, but no audio flows.
 */
import { eq, and, inArray, isNull, isNotNull, lt, ne, sql } from 'drizzle-orm';
import { AccessToken, RoomServiceClient, TrackSource } from 'livekit-server-sdk';
import { db, schema } from '../db';
import { env } from '../env';
import { errors } from '../errors';
import { log } from '../log';
import { nextSnowflake } from '../snowflake';
import { ensureMember, hasPermission, computeMemberChannelPermissions, Permissions } from './permissions';
import * as channels from './channels';
import * as dms from './dms';
import * as supervision from './supervision';

/**
 * Move (or join) the given user into a voice channel. Verifies they're
 * a guild member and have CONNECT permission on the channel — or for
 * DM calls, that they're a recipient of the DM.
 *
 * Returns the new voice_state row, the prior row (if the user was in
 * a different channel), and a LiveKit auth token. The row is upserted
 * so repeated joins of the same channel are idempotent (priorVoiceState
 * is then null because the channel didn't actually change).
 */
export interface JoinResult {
  voiceState: schema.VoiceState;
  /**
   * The user's prior voice state if they were already in a different
   * channel. The route layer uses this to dispatch a "left" event to
   * the previous channel's audience so its viewers don't see the
   * switching user as still in their channel.
   */
  priorVoiceState: schema.VoiceState | null;
  /** If the user MOVED OUT of a 1:1 DM call into this channel, the
   *  system_call message finalizing that prior DM's call (so the route can
   *  dispatch it). Null otherwise. */
  priorCallSystemMessage: schema.Message | null;
  priorCallSystemChannelId: bigint | null;
  token: string | null;
  wsUrl: string | null;
}

export async function joinVoice(userId: bigint, channelId: bigint): Promise<JoinResult> {
  const channel = await channels.getChannel(channelId);
  if (!channel) {
    throw errors.notFound('Voice channel');
  }
  // DM voice (1-on-1 calls) is allowed too — same voice_states table,
  // same LiveKit pipeline, just no guild context and a different
  // permission gate (membership in the DM rather than CONNECT on a
  // guild channel).
  const isDmVoice = channel.type === 'dm' || channel.type === 'group_dm';
  if (!isDmVoice && channel.type !== 'guild_voice') {
    throw errors.notFound('Voice channel');
  }
  if (isDmVoice) {
    // DM voice: verify the caller is a recipient. ensureRecipient throws
    // NOT_FOUND if not, which surfaces the same "channel doesn't exist
    // to you" semantics as a permission failure on guild voice.
    await dms.ensureRecipient(channelId, userId);
    // For 1:1 DMs, enforce the full privacy policy: blocks always
    // deny, friends always allow, server-share allowed only if the
    // recipient has opted in. Mirrors the dms.getOrCreateDM gate so
    // the policy is consistent between "open the DM" and "ring inside
    // the DM." Group DMs (group_dm) are skipped — multi-recipient
    // privacy semantics are ambiguous and we'd be punishing the
    // initiator for the toggle state of any one participant.
    if (channel.type === 'dm') {
      const other = await dms.getOtherRecipient(channelId, userId);
      if (other !== null) {
        const { isBlockedEitherWay, canReachByDmOrCall } = await import('./relationships');
        // ALWAYS-ENFORCED gates (both ring and answer):
        //  1. A block in EITHER direction always denies. This must not be
        //     skipped on the answer path — a block placed DURING the ring
        //     window (after the caller joined, before the callee answers)
        //     would otherwise slip through and connect a blocked pair.
        //  2. Supervision contact policy. dmBlockedBySupervision is symmetric;
        //     a ring does not satisfy a guardian's dmPolicy the way tapping
        //     Answer satisfies reachability consent, so it applies to the
        //     answerer too. Mirrors the text-send + getOrCreateDM gates.
        if (await isBlockedEitherWay(userId, other)) {
          throw errors.notFound('Voice channel');
        }
        if (await supervision.dmBlockedBySupervision(userId, other)) {
          throw errors.notFound('Voice channel');
        }
        // DIRECTIONAL reachability (server-member "allow DMs" toggle) is gated
        // to the INITIATOR only. Re-running canReachByDmOrCall when ANSWERING
        // checks whether the callee can reach the CALLER, which fails whenever
        // the caller hasn't opened up to server members (the default) — that
        // surfaced as "Voice channel not found" on answer. If the other party
        // is already in this DM's voice channel, this user is answering a ring
        // they consented to by tapping Answer, so skip the reachability gate.
        // (Blocks + supervision are already enforced unconditionally above.)
        const [otherPresent] = await db
          .select({ userId: schema.voiceStates.userId })
          .from(schema.voiceStates)
          .where(
            and(
              eq(schema.voiceStates.channelId, channelId),
              ne(schema.voiceStates.userId, userId),
            ),
          )
          .limit(1);
        if (!otherPresent) {
          if (!(await canReachByDmOrCall(userId, other))) {
            throw errors.notFound('Voice channel');
          }
        }
      }
    }
  } else {
    if (!channel.guildId) {
      throw errors.internal('Voice channel without guild');
    }
    await ensureMember(channel.guildId, userId);
    const perms = await computeMemberChannelPermissions(channelId, userId);
    if (!hasPermission(perms, Permissions.VIEW_CHANNEL)) throw errors.notFound('Voice channel');
    if (!hasPermission(perms, Permissions.CONNECT)) throw errors.forbidden('Cannot join this voice channel');
    // Onboarding gate — pending members can't join voice channels
    // either. Same dynamic-import pattern as the timeout check.
    const { getMemberState, getActiveTimeout } = await import('./members');
    const state = await getMemberState(channel.guildId, userId);
    if (state === 'pending') throw errors.pendingAcknowledgment();
    // Timeout enforcement — a timed-out member can't join guild voice.
    // Same enforcement semantic as the message-send and add-reaction
    // routes: timeouts block all forms of participation, not just
    // text. Bypassed for DMs above (DM voice has no guild scope, so
    // no guild-membership timeout applies to it).
    const until = await getActiveTimeout(channel.guildId, userId);
    if (until !== null) throw errors.timedOut(until);
  }

  // Parental controls: a supervised child can be barred from voice
  // entirely. This gate is user-scoped (not channel-scoped), so it applies
  // to both DM and guild paths, and it MUST run BEFORE any state is written
  // (voice_states upsert + dmActiveCall* stamping). Because joinVoice has no
  // enclosing transaction, every statement autocommits — throwing after the
  // upsert would strand a ghost voice_states row and poison the DM call
  // record. Mirrors joinStage's ordering (resolve + throw before the insert).
  // The publishSources derivation from these same restrictions happens later,
  // once canPublish is known.
  const childRestr = await supervision.getEffectiveRestrictions(userId);
  if (childRestr?.allowVoice === false) {
    throw errors.forbidden('Voice calls are restricted by your parent');
  }

  // Read the prior row (if any) so the route layer can dispatch a
  // leave event to the OLD channel's audience. We can't reuse the
  // upsert RETURNING for this because Postgres only returns the
  // post-update row; we'd lose the pre-update channel id we need
  // for the leave dispatch. One extra PK select.
  const [priorRow] = await db
    .select()
    .from(schema.voiceStates)
    .where(eq(schema.voiceStates.userId, userId))
    .limit(1);

  // Voice participation stats (achievements: first_contact/event_horizon).
  // A fresh join bumps the join counter; a channel SWITCH banks the elapsed
  // seconds of the previous segment instead (it's one continuing session).
  // Best-effort — stats must never fail the join.
  void recordVoiceJoinStats(userId, priorRow ?? null).catch(() => undefined);

  // The session ID is what an SFU webhook will reference when reporting
  // a participant left/joined. Generate it locally so we can correlate
  // events back to this row even before the SFU is wired up.
  const sessionId = `vc-${nextSnowflake().toString(36)}`;

  const [row] = await db
    .insert(schema.voiceStates)
    .values({
      userId,
      channelId,
      guildId: isDmVoice ? null : channel.guildId,
      sessionId,
      selfMute: false,
      selfDeaf: false,
    })
    .onConflictDoUpdate({
      target: schema.voiceStates.userId,
      set: {
        channelId,
        guildId: isDmVoice ? null : channel.guildId,
        sessionId,
        selfMute: false,
        selfDeaf: false,
        joinedAt: new Date(),
      },
    })
    .returning();

  // ── 1:1 DM call tracking ────────────────────────────────────────────────
  //
  // For 1:1 DM voice, we maintain three columns on the channel row
  // describing the active call. The columns advance through up to
  // three states across a call's lifetime:
  //
  //   1. (null, null, null)            — no call active
  //   2. (startedAt, null, callerId)   — caller has rung; awaiting answer
  //   3. (startedAt, answeredAt, ...)  — both parties in voice; talking
  //   4. (null, null, null)            — last participant left; call ended
  //
  // The leaveVoice path clears these and writes a `system_call`
  // message summarizing the call (duration if answered, "missed"
  // otherwise). See leaveVoice below for the corresponding read side.
  if (channel.type === 'dm') {
    // One atomic statement, with the channel row's OWN columns as the
    // caller-vs-answerer discriminator (every SET expression sees the
    // pre-update values, and the row lock serializes concurrent joins):
    //   - startedAt null            → I'm first: stamp startedAt + initiator
    //   - started by someone else,
    //     not yet answered          → I'm answering: stamp answeredAt
    //   - otherwise (rejoin/echo)   → no change
    // The previous SELECT-voice_states-then-branch version raced: two
    // near-simultaneous joins could both observe "no other participant",
    // classify a connected call as missed, or strand answeredAt with no
    // startedAt — which then poisoned the NEXT call's duration math.
    await db
      .update(schema.channels)
      .set({
        dmActiveCallStartedAt: sql`COALESCE(${schema.channels.dmActiveCallStartedAt}, NOW())`,
        dmActiveCallInitiatorId: sql`COALESCE(${schema.channels.dmActiveCallInitiatorId}, ${userId})`,
        dmActiveCallAnsweredAt: sql`CASE
          WHEN ${schema.channels.dmActiveCallStartedAt} IS NOT NULL
           AND ${schema.channels.dmActiveCallInitiatorId} IS DISTINCT FROM ${userId}
           AND ${schema.channels.dmActiveCallAnsweredAt} IS NULL
          THEN NOW()
          ELSE ${schema.channels.dmActiveCallAnsweredAt}
        END`,
      })
      .where(eq(schema.channels.id, channelId));
  }

  // Detect AFK-channel join. If the guild has an AFK channel configured
  // and the user is joining it, mint a non-publishing LiveKit token so
  // their mic is hardware-disabled at the SFU layer regardless of
  // their selfMute toggle. UI also surfaces the parked state via the
  // channel's icon. We don't write a server_mute flag here because
  // it'd collide with the user's selfMute control; the LiveKit grant
  // is the source of truth.
  //
  // The same no-publish grant applies when the channel itself has voice
  // disabled (channels.voiceDisabled) — the channel still works as a
  // presence/hangout space but nobody can talk.
  let canPublish = true;
  if (!isDmVoice && channel.guildId) {
    if (channel.voiceDisabled) {
      canPublish = false;
    }
    const [guildRow] = await db
      .select({ afkChannelId: schema.guilds.afkChannelId })
      .from(schema.guilds)
      .where(eq(schema.guilds.id, channel.guildId))
      .limit(1);
    if (guildRow?.afkChannelId === channelId) {
      canPublish = false;
    }
  }

  // Parental controls: a supervised child can be barred from voice
  // entirely, or limited to audio-only (no camera / no screen share).
  // We only constrain the SFU token's publishable sources when something
  // is ACTUALLY restricted — an all-allowed child must behave exactly
  // like a normal user. (Setting canPublishSources unconditionally, and
  // with the wrong value type, previously granted zero sources and broke
  // calls for every supervised account.)
  // childRestr was already resolved (and the allowVoice bar enforced) above,
  // before any voice_states/dmActiveCall* writes. Here we only derive the
  // SFU-token publishable sources from it.
  let publishSources: TrackSource[] | undefined;
  if (childRestr && (!childRestr.allowVideo || !childRestr.allowStream)) {
    publishSources = [TrackSource.MICROPHONE];
    if (childRestr.allowVideo) publishSources.push(TrackSource.CAMERA);
    if (childRestr.allowStream) {
      publishSources.push(TrackSource.SCREEN_SHARE, TrackSource.SCREEN_SHARE_AUDIO);
    }
  }

  // If the user MOVED OUT of a 1:1 DM call into this channel, finalize the
  // prior DM's call record. The upsert above already moved their
  // voice_states row off the prior channel, so endDmCallBookkeeping sees the
  // correct remaining-participant count. Without this, navigating away from a
  // ringing/active DM call stranded its dmActiveCall* columns.
  let priorCall: {
    systemCallMessage: schema.Message | null;
    systemCallChannelId: bigint | null;
  } = { systemCallMessage: null, systemCallChannelId: null };
  if (priorRow && priorRow.channelId !== channelId && priorRow.guildId === null) {
    priorCall = await endDmCallBookkeeping(priorRow.channelId, userId);
  }

  return {
    voiceState: row!,
    // Only report a prior state if it pointed at a DIFFERENT channel.
    // If the user is re-joining the same channel (idempotent ping) we
    // suppress the leave dispatch — nothing to tell anyone about.
    priorVoiceState:
      priorRow && priorRow.channelId !== channelId ? priorRow : null,
    priorCallSystemMessage: priorCall.systemCallMessage,
    priorCallSystemChannelId: priorCall.systemCallChannelId,
    ...(await mintLivekitToken(
      userId,
      channelId,
      isDmVoice ? null : channel.guildId,
      canPublish,
      publishSources,
    )),
  };
}

/**
 * Resolve the browser-facing LiveKit WebSocket URL.
 *
 * Resolution order:
 *  1. `LIVEKIT_WS_URL` if explicitly set — used for LiveKit Cloud or any
 *     deployment that points voice at an external SFU.
 *  2. Otherwise, when the bundled self-hosted LiveKit is in play (keys are
 *     configured but no explicit URL), derive a SAME-ORIGIN URL from
 *     `PUBLIC_URL`: `wss://<host>/livekit` (or `ws://…` on plain HTTP).
 *     Caddy reverse-proxies `/livekit` to the LiveKit container (see
 *     ops/Caddyfile), so signaling rides the app's own host + TLS cert —
 *     no extra public port, no separate certificate, no mixed-content
 *     errors on an https deployment.
 *
 * Media (RTP/UDP) still flows directly between the browser and the SFU's
 * UDP port; only the WebSocket signaling is proxied here.
 *
 * Returns null when nothing usable can be derived (no explicit URL and no
 * PUBLIC_URL to build from), which keeps voice in presence-only mode.
 */
export function browserLivekitWsUrl(): string | null {
  if (env.LIVEKIT_WS_URL) return env.LIVEKIT_WS_URL;
  if (!env.PUBLIC_URL) return null;
  try {
    const u = new URL(env.PUBLIC_URL);
    const wsScheme = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${wsScheme}//${u.host}/livekit`;
  } catch {
    return null;
  }
}

/**
 * Mint a LiveKit access token for the user to join the room representing
 * this voice channel. Room name is derived from the channel id so the
 * mapping is unambiguous. Returns { token: null, wsUrl: null } if any
 * LiveKit env var is unset — the api keeps working as a presence-only
 * voice layer in that case so text chat doesn't depend on voice config.
 *
 * The `canPublish` flag is the publish-permission gate: voice channels
 * always pass true, stage channels pass true only for speakers and
 * false for audience. Audience tokens still get `canSubscribe`, so
 * they hear the speakers; just can't broadcast.
 */
export async function mintLivekitToken(
  userId: bigint,
  channelId: bigint,
  guildId: bigint | null,
  canPublish = true,
  /** When set, restrict which track sources the participant may publish
      (parental controls). Omitted = all sources allowed. */
  publishSources?: TrackSource[],
): Promise<{ token: string | null; wsUrl: string | null }> {
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const wsUrl = browserLivekitWsUrl();
  if (!apiKey || !apiSecret || !wsUrl) {
    return { token: null, wsUrl: null };
  }

  // Room name. Guild voice uses g{guildId}-c{channelId} so log greps
  // can scope by guild quickly. DM calls have no guild context and
  // use dm-c{channelId}. Channel ids are globally unique snowflakes
  // so collisions across the two namespaces are impossible; the
  // prefix is purely cosmetic for ops.
  const roomName =
    guildId === null
      ? `dm-c${channelId.toString()}`
      : `g${guildId.toString()}-c${channelId.toString()}`;

  const at = new AccessToken(apiKey, apiSecret, {
    identity: userId.toString(),
    // TTL bounds the join handshake, not the connected session — LiveKit
    // only validates at join time, and refreshes tokens for connected
    // participants over the signaling channel, so a short TTL never
    // interrupts a live call. Keeping it short matters for security:
    // every forced-removal path (kick/ban/eviction) only DISCONNECTS the
    // participant at the SFU — it can't revoke an already-minted token —
    // so the TTL is exactly the window in which a kicked user's client
    // could rejoin the room directly. 5 minutes still leaves generous
    // slack for slow mic-permission prompts before connect.
    ttl: '5m',
  });
  at.addGrant({
    roomJoin: true,
    room: roomName,
    canPublish,
    canSubscribe: true,
    // No data-channel use yet; round 3 may enable for speaking-state pings.
    canPublishData: false,
    ...(publishSources ? { canPublishSources: publishSources } : {}),
  });

  return {
    token: await at.toJwt(),
    wsUrl,
  };
}

/**
 * Derive the LiveKit room name from a voice_states row. Mirrors the
 * shape mintLivekitToken uses so eviction targets the right room
 * regardless of whether the row represents guild voice or DM voice.
 */
function roomNameForRow(row: { guildId: bigint | null; channelId: bigint }): string {
  return row.guildId === null
    ? `dm-c${row.channelId.toString()}`
    : `g${row.guildId.toString()}-c${row.channelId.toString()}`;
}

/**
 * Remove a user from voice. Idempotent — leaving when not in a channel is
 * a no-op.
 *
 * For 1:1 DM voice, also handles call-record bookkeeping: if this user
 * was the LAST participant in the channel's call, this function writes
 * a `system_call` message summarizing the call (duration if answered;
 * "missed call" otherwise) and clears the three DM-call columns on
 * the channel. The created message is returned so the caller can
 * dispatch MESSAGE_CREATE; the prior voice state is returned so the
 * caller can dispatch VOICE_STATE_UPDATE for the leave.
 */
export interface LeaveVoiceResult {
  /** Prior voice_state row (if any). Caller uses for VOICE_STATE_UPDATE. */
  priorState: schema.VoiceState | null;
  /**
   * When the last participant left a 1:1 DM call, the system_call
   * message that was written to summarize the call. Null in every
   * other case (guild voice, group DM voice, intermediate departures
   * from a 1:1 DM call where the other party stays connected).
   */
  systemCallMessage: schema.Message | null;
  /**
   * Channel id for the system_call message (i.e. the DM channel).
   * Pulled out so the dispatcher doesn't have to re-fetch the
   * channel to know the audience. Null when systemCallMessage is null.
   */
  systemCallChannelId: bigint | null;
}

/**
 * Best-effort SFU eviction for a single voice_states row — stops the
 * participant's audio/video flowing immediately instead of waiting out the
 * LiveKit token TTL (~1h). No-op when LiveKit is unconfigured. Used by every
 * FORCED removal (decline, kick, ban); a user's own self-leave doesn't need
 * it (their client disconnects from the room itself).
 */
async function sfuRemoveParticipant(row: schema.VoiceState): Promise<void> {
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const httpUrl =
    env.LIVEKIT_HTTP_URL ??
    env.LIVEKIT_WS_URL?.replace(/^wss?:/i, (m) =>
      m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
    );
  if (!apiKey || !apiSecret || !httpUrl) return;
  try {
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    await svc.removeParticipant(roomNameForRow(row), row.userId.toString());
  } catch (err) {
    log.warn?.('livekit removeParticipant failed (best-effort)', {
      userId: row.userId.toString(),
      err: (err as Error).message,
    });
  }
}

/**
 * Bank the elapsed seconds of a finished voice segment into the per-user
 * stats row (achievements: event_horizon). Upsert so the first segment
 * creates the row. Callers fire-and-forget — stats never block voice flow.
 */
async function bankVoiceSeconds(userId: bigint, joinedAt: Date | null): Promise<void> {
  if (!joinedAt) return;
  const secs = Math.floor((Date.now() - joinedAt.getTime()) / 1000);
  if (secs <= 0) return;
  await db
    .insert(schema.userVoiceStats)
    .values({ userId, joins: 0, totalSeconds: secs })
    .onConflictDoUpdate({
      target: schema.userVoiceStats.userId,
      set: {
        totalSeconds: sql`${schema.userVoiceStats.totalSeconds} + ${secs}`,
        updatedAt: new Date(),
      },
    });
}

/** Join-time stats: fresh join → +1 join; channel switch → bank the previous
 *  segment (one continuing session, not a new join). */
async function recordVoiceJoinStats(
  userId: bigint,
  prior: { joinedAt: Date } | null,
): Promise<void> {
  if (prior) {
    await bankVoiceSeconds(userId, prior.joinedAt);
    return;
  }
  await db
    .insert(schema.userVoiceStats)
    .values({ userId, joins: 1, totalSeconds: 0 })
    .onConflictDoUpdate({
      target: schema.userVoiceStats.userId,
      set: { joins: sql`${schema.userVoiceStats.joins} + 1`, updatedAt: new Date() },
    });
}

export async function leaveVoice(
  userId: bigint,
  opts?: { evictFromSfu?: boolean; expectedChannelId?: bigint },
): Promise<LeaveVoiceResult> {
  // When `expectedChannelId` is given, only remove the user if they're still in
  // THAT channel — so a forced leave (decline/kick) can't evict them from a
  // different channel they raced into between the caller's check and this call.
  const [priorState] = await db
    .delete(schema.voiceStates)
    .where(
      opts?.expectedChannelId !== undefined
        ? and(
            eq(schema.voiceStates.userId, userId),
            eq(schema.voiceStates.channelId, opts.expectedChannelId),
          )
        : eq(schema.voiceStates.userId, userId),
    )
    .returning();
  if (!priorState) {
    return { priorState: null, systemCallMessage: null, systemCallChannelId: null };
  }
  // Bank the session's seconds for the voice achievements. Best-effort.
  void bankVoiceSeconds(userId, priorState.joinedAt).catch(() => undefined);
  // Forced removal (decline/kick): the target isn't the one initiating, so
  // their client won't disconnect itself — kick them off the SFU or they
  // keep streaming/ringing until the token expires.
  if (opts?.evictFromSfu) await sfuRemoveParticipant(priorState);

  // Non-DM voice short-circuits — call-record bookkeeping is 1:1 only.
  if (priorState.guildId !== null) {
    return { priorState, systemCallMessage: null, systemCallChannelId: null };
  }

  const bookkeeping = await endDmCallBookkeeping(priorState.channelId, userId);
  return { priorState, ...bookkeeping };
}

/**
 * Resolve the 1:1 DM call record after a user left `channelId` (the leaver's
 * voice_states row must ALREADY be removed/moved before calling).
 *   - not a 1:1 DM, or no call was tracked → no record (and clear stray
 *     half-stamped columns so the NEXT call isn't misclassified).
 *   - someone still present → the call continues; no record yet.
 *   - last participant gone → clear the call columns and write the
 *     system_call (missed / duration) message.
 *
 * Shared by leaveVoice (normal/forced hang-up) and joinVoice (when a user
 * MOVES OUT of a ringing/active DM into another channel — without running
 * this for the prior channel, its dmActiveCall* columns stranded: the missed
 * call was never logged and the next call there was auto-classified
 * 'answered' off the stale timestamps).
 */
async function endDmCallBookkeeping(
  channelId: bigint,
  leaverId: bigint,
): Promise<{ systemCallMessage: schema.Message | null; systemCallChannelId: bigint | null }> {
  const none = { systemCallMessage: null, systemCallChannelId: null };
  const [channelRow] = await db
    .select({
      id: schema.channels.id,
      type: schema.channels.type,
      startedAt: schema.channels.dmActiveCallStartedAt,
      answeredAt: schema.channels.dmActiveCallAnsweredAt,
      initiatorId: schema.channels.dmActiveCallInitiatorId,
    })
    .from(schema.channels)
    .where(eq(schema.channels.id, channelId))
    .limit(1);
  // Only 1:1 DMs carry call columns; group DMs / guild channels never do.
  if (!channelRow || channelRow.type !== 'dm') return none;
  if (channelRow.startedAt === null) {
    // No call tracked. Clear any stray answeredAt/initiator (a half-stamped
    // row would make the next call classify 'answered' off a stale timestamp).
    if (channelRow.answeredAt !== null || channelRow.initiatorId !== null) {
      await db
        .update(schema.channels)
        .set({ dmActiveCallAnsweredAt: null, dmActiveCallInitiatorId: null })
        .where(
          and(
            eq(schema.channels.id, channelId),
            isNull(schema.channels.dmActiveCallStartedAt),
          ),
        );
    }
    return none;
  }

  // Anyone still present → the call continues for them; no record yet.
  const remaining = await db
    .select({ userId: schema.voiceStates.userId })
    .from(schema.voiceStates)
    .where(eq(schema.voiceStates.channelId, channelId))
    .limit(1);
  if (remaining.length > 0) return none;

  // Last leaver → call ended. Compute duration / missed.
  const missed = channelRow.answeredAt === null;
  const durationMs = channelRow.answeredAt
    ? Math.max(0, Date.now() - channelRow.answeredAt.getTime())
    : 0;
  const initiatorId = channelRow.initiatorId ?? leaverId;

  // Clear columns BEFORE writing so a retry can't double-write (a lost
  // message is better than duplicate records). The guard is keyed on the
  // SPECIFIC call we're ending (`dmActiveCallStartedAt === channelRow.startedAt`),
  // not just IS NOT NULL, which makes it the gate on TWO fronts:
  //   - Two leavers of the SAME call both observe remaining=0; exactly one wins
  //     this conditional UPDATE (matches the timestamp), the loser matches 0
  //     rows and skips the system_call write — no duplicate record.
  //   - A NEW call that started in this DM between our remaining-check and now
  //     carries a DIFFERENT startedAt, so this UPDATE matches 0 rows and can't
  //     clobber the new call's freshly-stamped columns.
  //
  // NOTE the millisecond truncation: the column is stamped with NOW()
  // (microsecond precision) but round-trips through the JS driver as a
  // ms-precision Date, so a plain eq() matched 0 rows almost always —
  // silently skipping BOTH the clear and the system_call write (no
  // missed-call/duration records; stranded columns misclassified the next
  // call as answered). Same-ms aliasing of two DIFFERENT calls can't
  // happen: a new call only starts after this one's columns are cleared.
  const cleared = await db
    .update(schema.channels)
    .set({
      dmActiveCallStartedAt: null,
      dmActiveCallAnsweredAt: null,
      dmActiveCallInitiatorId: null,
    })
    .where(
      and(
        eq(schema.channels.id, channelId),
        sql`date_trunc('milliseconds', ${schema.channels.dmActiveCallStartedAt}) = date_trunc('milliseconds', ${channelRow.startedAt.toISOString()}::timestamptz)`,
      ),
    )
    .returning({ id: schema.channels.id });
  if (cleared.length === 0) return none;

  const { createSystemMessage } = await import('./messages');
  const systemCallMessage = await createSystemMessage({
    channelId,
    guildId: null,
    authorId: initiatorId,
    content: '', // client renders from metadata
    type: 'system_call',
    mentionedUserIds: [],
    metadata: { kind: 'call', missed, durationMs, initiatorId: initiatorId.toString() },
  });

  return { systemCallMessage, systemCallChannelId: channelId };
}

/**
 * Forcibly evict a user from voice IF AND ONLY IF they're currently
 * in a voice channel within the given guild. Returns the prior voice
 * state for the caller to broadcast VOICE_STATE_UPDATE, or null if
 * the user wasn't in voice in this guild.
 *
 * This is the right helper to call from kick/ban paths: a plain
 * leaveVoice() would also kick the user from voice in other guilds
 * they're still members of, which would be incorrect. Scoping to
 * (userId, guildId) keeps the eviction surgical.
 *
 * In addition to the DB delete, we call LiveKit's
 * RoomServiceClient.removeParticipant to drop the user at the SFU
 * level. Without this step the user's audio stream would keep
 * flowing until their token TTL elapsed (~1 hour) even though they
 * no longer have permission to be there. We treat the LiveKit
 * call as best-effort — if the SFU is unreachable the DB-side
 * eviction still lands and the user's client sees the kick via
 * the voice-state broadcast.
 */
/**
 * The voice channel a user is currently in within `guildId`, or null.
 * voice_states is keyed by userId PK (one row per user globally), so this is
 * at most one row. Used by the single-user permission-change refresh path.
 */
export async function voiceChannelInGuild(
  userId: bigint,
  guildId: bigint,
): Promise<bigint | null> {
  const [row] = await db
    .select({ channelId: schema.voiceStates.channelId })
    .from(schema.voiceStates)
    .where(and(eq(schema.voiceStates.userId, userId), eq(schema.voiceStates.guildId, guildId)))
    .limit(1);
  return row?.channelId ?? null;
}

/**
 * Map of userId → voice channelId for everyone currently in voice in a guild,
 * in ONE query. The bulk permission-change path uses this so it issues a
 * single voice_states read instead of one per affected member. Because
 * voice_states is keyed by userId, `listGuildVoiceChannels(g).get(u) ?? null`
 * is exactly equivalent to `voiceChannelInGuild(u, g)`.
 */
export async function listGuildVoiceChannels(guildId: bigint): Promise<Map<bigint, bigint>> {
  const rows = await db
    .select({ userId: schema.voiceStates.userId, channelId: schema.voiceStates.channelId })
    .from(schema.voiceStates)
    .where(eq(schema.voiceStates.guildId, guildId));
  const map = new Map<bigint, bigint>();
  for (const r of rows) map.set(r.userId, r.channelId);
  return map;
}

export async function evictFromVoiceInGuild(
  userId: bigint,
  guildId: bigint,
): Promise<schema.VoiceState | null> {
  const [row] = await db
    .delete(schema.voiceStates)
    .where(
      and(
        eq(schema.voiceStates.userId, userId),
        eq(schema.voiceStates.guildId, guildId),
      ),
    )
    .returning();
  if (!row) return null;

  // Best-effort SFU eviction. If LiveKit is unconfigured (self-hosted
  // presence-only deployment) all three env vars are empty and we just
  // return — the row delete + gateway broadcast above already inform
  // the client.
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const httpUrl = env.LIVEKIT_HTTP_URL ?? env.LIVEKIT_WS_URL?.replace(/^wss?:/i, (m) =>
    m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
  );
  if (apiKey && apiSecret && httpUrl) {
    const roomName = roomNameForRow(row);
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    try {
      await svc.removeParticipant(roomName, userId.toString());
    } catch (err) {
      // Participant may not be currently connected (token issued but
      // not yet redeemed, or already departed). LiveKit returns a
      // 404-ish error; treat as success since the desired end-state
      // is "user not in room" which is already true.
      log.warn?.('livekit removeParticipant failed (treating as best-effort)', {
        userId: userId.toString(),
        guildId: guildId.toString(),
        err: (err as Error).message,
      });
    }
  }

  return row;
}

/**
 * Forcibly evict a user from voice in any channel they're currently
 * in. The unscoped variant of evictFromVoiceInGuild — used by
 * admin-instance-ban (where the user loses access to every guild
 * simultaneously) and by anything else that wants to terminate the
 * user's voice presence wholesale.
 *
 * Like the scoped variant, this also calls LiveKit's
 * RoomServiceClient.removeParticipant on a best-effort basis so the
 * banned user's audio stream stops flowing immediately instead of
 * waiting out the LiveKit token TTL (~1 hour).
 */
export async function evictFromAllVoice(
  userId: bigint,
): Promise<schema.VoiceState | null> {
  const [row] = await db
    .delete(schema.voiceStates)
    .where(eq(schema.voiceStates.userId, userId))
    .returning();
  if (!row) return null;

  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const httpUrl = env.LIVEKIT_HTTP_URL ?? env.LIVEKIT_WS_URL?.replace(/^wss?:/i, (m) =>
    m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
  );
  if (apiKey && apiSecret && httpUrl) {
    const roomName = roomNameForRow(row);
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    try {
      await svc.removeParticipant(roomName, userId.toString());
    } catch (err) {
      log.warn?.('livekit removeParticipant failed during instance ban (best-effort)', {
        userId: userId.toString(),
        err: (err as Error).message,
      });
    }
  }

  return row;
}

/**
 * Evict every user currently in any voice channel within a guild.
 * Used by the guild-delete paths so participants don't keep
 * streaming in a guild that no longer exists. Caller is responsible
 * for dispatching VOICE_STATE_UPDATE per evicted user; we return
 * the prior rows so the caller has the channel ids to broadcast.
 *
 * Like the per-user variant, also calls LiveKit's
 * RoomServiceClient.removeParticipant per evicted user so audio
 * streams stop flowing immediately rather than waiting out the
 * token TTL.
 */
export async function evictAllVoiceInGuild(
  guildId: bigint,
): Promise<schema.VoiceState[]> {
  const rows = await db
    .delete(schema.voiceStates)
    .where(eq(schema.voiceStates.guildId, guildId))
    .returning();
  if (rows.length === 0) return [];

  // Best-effort SFU eviction. If LiveKit isn't configured we
  // skip — the row delete is the source of truth for our app's
  // notion of voice presence.
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const httpUrl = env.LIVEKIT_HTTP_URL ?? env.LIVEKIT_WS_URL?.replace(/^wss?:/i, (m) =>
    m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
  );
  if (apiKey && apiSecret && httpUrl) {
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    // Sequential rather than parallel — a bulk delete-guild with
    // many voice participants would otherwise hit LiveKit with N
    // concurrent admin calls; we'd rather pace that.
    for (const row of rows) {
      const roomName = roomNameForRow(row);
      try {
        await svc.removeParticipant(roomName, row.userId.toString());
      } catch (err) {
        log.warn?.('livekit removeParticipant failed during guild delete (best-effort)', {
          userId: row.userId.toString(),
          guildId: row.guildId?.toString() ?? 'n/a',
          err: (err as Error).message,
        });
      }
    }
  }

  return rows;
}

/**
 * Evict every user currently in a SINGLE voice/stage channel. The
 * per-channel sibling of evictAllVoiceInGuild — used by the channel-
 * delete path so participants don't keep streaming in a channel
 * that no longer exists. Caller is responsible for dispatching
 * VOICE_STATE_UPDATE per evicted user; we return the prior rows
 * so the caller has the user ids to broadcast.
 *
 * Also clears stage_participants for the same channel — runs the
 * delete unconditionally since for non-stage channels it matches
 * zero rows.
 *
 * LiveKit RemoveParticipant is best-effort per row, paced
 * sequentially to avoid hammering the SFU.
 */
export async function evictAllVoiceInChannel(
  channelId: bigint,
): Promise<schema.VoiceState[]> {
  const rows = await db
    .delete(schema.voiceStates)
    .where(eq(schema.voiceStates.channelId, channelId))
    .returning();

  // Stage roster cleanup — unconditional, harmless on non-stage
  // channels where the table matches zero rows. We do this even if
  // voice_states was empty: a channel could in principle have
  // stage_participants rows for users who joined the roster but
  // hadn't yet connected to the LiveKit room.
  await db
    .delete(schema.stageParticipants)
    .where(eq(schema.stageParticipants.channelId, channelId));

  if (rows.length === 0) return [];

  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const httpUrl = env.LIVEKIT_HTTP_URL ?? env.LIVEKIT_WS_URL?.replace(/^wss?:/i, (m) =>
    m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
  );
  if (apiKey && apiSecret && httpUrl) {
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    for (const row of rows) {
      const roomName = roomNameForRow(row);
      try {
        await svc.removeParticipant(roomName, row.userId.toString());
      } catch (err) {
        log.warn?.('livekit removeParticipant failed during channel delete (best-effort)', {
          userId: row.userId.toString(),
          channelId: row.channelId.toString(),
          err: (err as Error).message,
        });
      }
    }
  }

  return rows;
}

/**
 * Update self-mute / self-deafen flags on an existing voice state. Used
 * by the audio layer to broadcast UI hints (the "muted" badge on the
 * member list); does NOT actually mute the audio stream — the client
 * does that locally with mediaTrack.enabled. Returns null if the user
 * isn't currently in voice.
 */
export async function setMuteFlags(
  userId: bigint,
  patch: { selfMute?: boolean; selfDeaf?: boolean },
): Promise<schema.VoiceState | null> {
  const update: Partial<schema.NewVoiceState> = {};
  // Track the resulting self-mute intent so we can maintain self_mute_at
  // (which drives the AFK auto-move sweep) alongside the flags.
  let nextSelfMute: boolean | undefined;
  if (patch.selfMute !== undefined) {
    update.selfMute = patch.selfMute;
    nextSelfMute = patch.selfMute;
  }
  if (patch.selfDeaf !== undefined) {
    update.selfDeaf = patch.selfDeaf;
    // Deafened implies muted — you can't be heard if you can't hear, by
    // convention. Discord enforces the same coupling.
    if (patch.selfDeaf) {
      update.selfMute = true;
      nextSelfMute = true;
    }
  }
  if (Object.keys(update).length === 0) return null;

  // Maintain self_mute_at: stamp it when the user transitions INTO a
  // self-muted state, clear it when they unmute. We preserve an existing
  // timestamp if they were already muted, so a secondary toggle (e.g.
  // deafen while already muted) doesn't reset the AFK countdown.
  if (nextSelfMute === true) {
    const [cur] = await db
      .select({
        selfMute: schema.voiceStates.selfMute,
        selfMuteAt: schema.voiceStates.selfMuteAt,
      })
      .from(schema.voiceStates)
      .where(eq(schema.voiceStates.userId, userId))
      .limit(1);
    if (cur && !(cur.selfMute && cur.selfMuteAt)) {
      update.selfMuteAt = new Date();
    }
  } else if (nextSelfMute === false) {
    update.selfMuteAt = null;
  }

  const [row] = await db
    .update(schema.voiceStates)
    .set(update)
    .where(eq(schema.voiceStates.userId, userId))
    .returning();
  return row ?? null;
}

/**
 * Non-destructive read of a user's current voice state. Used by paths
 * (like DM close) that want to check IF the user is in voice in a
 * specific channel before deciding whether to invoke leaveVoice. The
 * primary key on voice_states.userId guarantees at most one row.
 */
export async function getMyVoiceState(
  userId: bigint,
): Promise<schema.VoiceState | null> {
  const [row] = await db
    .select()
    .from(schema.voiceStates)
    .where(eq(schema.voiceStates.userId, userId))
    .limit(1);
  return row ?? null;
}

/** All voice states relevant to a user on IDENTIFY. Combines:
    - Guild voice states for any of the user's guilds (so members in
      shared guilds' voice channels are visible in the presence UI).
    - DM voice states for any of the user's DM channels (1-on-1 and
      group calls). DM voice rows have `guildId: null` so the guild
      query misses them — without this second leg the READY payload
      omits in-flight DM calls, including the caller's own state
      after a reconnect.

    Both legs are bounded by the user's actual membership; no extra
    leakage. The result is de-duplicated by user id (one voice state
    per user is enforced by the table's primary key, so duplicates
    can't occur in practice, but defensive dedup costs nothing). */
export async function listVoiceStatesForReady(args: {
  /** The user's VIEWABLE guild channel ids — NOT all guild channels. The
   *  guild leg filters on these so the READY snapshot doesn't leak voice
   *  presence in private channels the user can't VIEW_CHANNEL (the live
   *  VOICE_STATE_UPDATE fan-out is channel-scoped for the same reason). */
  viewableChannelIds: bigint[];
  dmChannelIds: bigint[];
}): Promise<schema.VoiceState[]> {
  const { viewableChannelIds, dmChannelIds } = args;
  if (viewableChannelIds.length === 0 && dmChannelIds.length === 0) return [];

  const queries: Promise<schema.VoiceState[]>[] = [];
  if (viewableChannelIds.length > 0) {
    queries.push(
      db
        .select()
        .from(schema.voiceStates)
        .where(inArray(schema.voiceStates.channelId, viewableChannelIds)),
    );
  }
  if (dmChannelIds.length > 0) {
    queries.push(
      db
        .select()
        .from(schema.voiceStates)
        .where(inArray(schema.voiceStates.channelId, dmChannelIds)),
    );
  }
  const results = await Promise.all(queries);
  const byUser = new Map<bigint, schema.VoiceState>();
  for (const batch of results) {
    for (const r of batch) byUser.set(r.userId, r);
  }
  return Array.from(byUser.values());
}

/** All users currently in this specific voice channel. */
export async function listChannelVoiceStates(channelId: bigint): Promise<schema.VoiceState[]> {
  return db.select().from(schema.voiceStates).where(eq(schema.voiceStates.channelId, channelId));
}

/**
 * Move a user from their current voice channel to another voice channel
 * in the same guild. Requires MOVE_MEMBERS on the source channel.
 *
 * Returns the updated voice_states row. Caller is responsible for
 * dispatching VOICE_STATE_UPDATE — the route layer does this after
 * the DB update so the target's client can detect "I was moved" and
 * reconnect to the new LiveKit room.
 *
 * LiveKit eviction: we forcibly remove the target from their old
 * room so the audio stream stops. The new room's token is minted
 * fresh by the target client when it calls joinVoice on the new
 * channel — we don't push tokens server-side because the client's
 * REST flow already handles the join handshake idempotently.
 */
export async function moveVoiceMember(args: {
  callerId: bigint;
  targetUserId: bigint;
  targetChannelId: bigint;
}): Promise<schema.VoiceState> {
  const { callerId, targetUserId, targetChannelId } = args;

  // 1. Target's current voice state. Must exist (you can't move
  //    someone who isn't in voice).
  const [current] = await db
    .select()
    .from(schema.voiceStates)
    .where(eq(schema.voiceStates.userId, targetUserId))
    .limit(1);
  if (!current) {
    throw errors.badRequest('User is not in voice');
  }
  if (!current.guildId) {
    // DM voice — moving doesn't apply (DM calls are 1:1 or group
    // peers, not free-roaming channels).
    throw errors.badRequest('Cannot move users in DM calls');
  }
  if (current.channelId === targetChannelId) {
    // No-op — already there. Idempotent success.
    return current;
  }

  // 2. Target channel must exist, be voice, and be in the same guild.
  const targetChannel = await channels.getChannel(targetChannelId);
  if (!targetChannel || targetChannel.type !== 'guild_voice') {
    throw errors.notFound('Voice channel');
  }
  if (targetChannel.guildId !== current.guildId) {
    throw errors.badRequest('Cross-guild moves are not allowed');
  }

  // 3. Permission: MOVE_MEMBERS on the SOURCE channel. We check the
  //    source rather than the target because the moderation action
  //    is "remove from this channel"; "drop into the new channel"
  //    is the consequence, not the gated action. Mirrors Discord's
  //    permission model.
  const sourcePerms = await computeMemberChannelPermissions(
    current.channelId,
    callerId,
  );
  if (!hasPermission(sourcePerms, Permissions.MOVE_MEMBERS)) {
    throw errors.missingPermissions(['MOVE_MEMBERS']);
  }

  // 3b. Destination gate. The mover needs CONNECT on the target (you
  //     can only drop people into rooms you could enter — Discord's
  //     rule, and it stops MOVE_MEMBERS on a public channel being used
  //     to push people into private rooms). The moved member must also
  //     hold VIEW_CHANNEL+CONNECT there: their own client re-joins via
  //     joinVoice, which re-checks CONNECT and throws — without this
  //     gate the row gets repointed at a channel they can never connect
  //     to, stranding a silent ghost in the roster.
  const [actorTargetPerms, targetUserPerms] = await Promise.all([
    computeMemberChannelPermissions(targetChannelId, callerId),
    computeMemberChannelPermissions(targetChannelId, targetUserId),
  ]);
  if (!hasPermission(actorTargetPerms, Permissions.CONNECT)) {
    throw errors.missingPermissions(['CONNECT']);
  }
  if (
    !hasPermission(targetUserPerms, Permissions.VIEW_CHANNEL) ||
    !hasPermission(targetUserPerms, Permissions.CONNECT)
  ) {
    throw errors.badRequest('That member cannot access the destination channel');
  }

  // 4. Update the row. We bump the sessionId so any stale LiveKit
  //    tokens for the old channel are recognized as stale by the
  //    cross-device session watcher.
  const newSessionId = nextSnowflake().toString();
  const [updated] = await db
    .update(schema.voiceStates)
    .set({
      channelId: targetChannelId,
      sessionId: newSessionId,
    })
    .where(eq(schema.voiceStates.userId, targetUserId))
    .returning();
  if (!updated) {
    throw errors.internal('Voice state update failed');
  }

  // 5. Best-effort LiveKit eviction from the OLD room. Same pattern
  //    as evictFromVoiceInGuild — if LiveKit isn't configured this
  //    is a silent no-op (presence-only deployments).
  const apiKey = env.LIVEKIT_API_KEY;
  const apiSecret = env.LIVEKIT_API_SECRET;
  const httpUrl =
    env.LIVEKIT_HTTP_URL ??
    env.LIVEKIT_WS_URL?.replace(/^wss?:/i, (m) =>
      m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
    );
  if (apiKey && apiSecret && httpUrl) {
    const oldRoomName = roomNameForRow(current);
    const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
    try {
      await svc.removeParticipant(oldRoomName, targetUserId.toString());
    } catch (err) {
      log.warn?.('livekit removeParticipant on move failed (best-effort)', {
        userId: targetUserId.toString(),
        oldChannelId: current.channelId.toString(),
        newChannelId: targetChannelId.toString(),
        err: (err as Error).message,
      });
    }
  }

  return updated;
}

/**
 * AFK auto-move sweep
 * -------------------
 * Relocates any guild member who has been continuously self-muted longer
 * than their guild's `afkTimeoutSeconds` (default 300s = 5 minutes) into
 * the guild's configured AFK voice channel. Joining the AFK channel
 * disables their mic at the SFU (canPublish=false on the next join
 * handshake), so a quiet, idle member gets parked out of an active room
 * automatically.
 *
 * Mechanics mirror the moderator `moveVoiceMember` path: the row's
 * channelId is repointed at the AFK channel, the sessionId is bumped so
 * stale SFU tokens for the old room are invalidated, and the user is
 * best-effort evicted from the old LiveKit room. `selfMuteAt` is cleared
 * on the move so re-muting after they wander back out restarts the timer.
 *
 * The caller (the boot-time scheduler in index.ts) dispatches a
 * VOICE_STATE_UPDATE per returned move so every client — including the
 * moved member's own, which then re-joins the AFK room — sees the change.
 * Guilds with no AFK channel set are skipped entirely.
 */
export interface AfkAutoMove {
  userId: bigint;
  guildId: bigint;
  fromChannelId: bigint;
  /** The updated voice_states row, now pointing at the AFK channel. */
  voiceState: schema.VoiceState;
}

export async function sweepAfkMutedMembers(): Promise<AfkAutoMove[]> {
  // Only guilds with an AFK channel configured participate. (Soft-deleted
  // guilds are excluded — their voice rows get torn down on delete.)
  const guildsWithAfk = await db
    .select({
      id: schema.guilds.id,
      afkChannelId: schema.guilds.afkChannelId,
      afkTimeoutSeconds: schema.guilds.afkTimeoutSeconds,
    })
    .from(schema.guilds)
    .where(and(isNotNull(schema.guilds.afkChannelId), isNull(schema.guilds.deletedAt)));
  if (guildsWithAfk.length === 0) return [];

  const now = Date.now();
  const moves: AfkAutoMove[] = [];

  for (const g of guildsWithAfk) {
    const afkChannelId = g.afkChannelId;
    if (afkChannelId === null) continue;
    const thresholdMs = (g.afkTimeoutSeconds ?? 300) * 1000;
    const cutoff = new Date(now - thresholdMs);

    // Candidates: self-muted past the cutoff, in this guild, and not
    // already sitting in the AFK channel.
    const candidates = await db
      .select()
      .from(schema.voiceStates)
      .where(
        and(
          eq(schema.voiceStates.guildId, g.id),
          eq(schema.voiceStates.selfMute, true),
          isNotNull(schema.voiceStates.selfMuteAt),
          lt(schema.voiceStates.selfMuteAt, cutoff),
          ne(schema.voiceStates.channelId, afkChannelId),
        ),
      );

    for (const cand of candidates) {
      const newSessionId = nextSnowflake().toString();
      // Guard the update on the user STILL being in the channel we read,
      // so a concurrent leave/move doesn't get clobbered.
      const [moved] = await db
        .update(schema.voiceStates)
        .set({ channelId: afkChannelId, sessionId: newSessionId, selfMuteAt: null })
        .where(
          and(
            eq(schema.voiceStates.userId, cand.userId),
            eq(schema.voiceStates.channelId, cand.channelId),
          ),
        )
        .returning();
      if (!moved) continue;

      // Best-effort SFU eviction from the OLD room. The client re-joins
      // the AFK room via the normal join handshake when it receives the
      // VOICE_STATE_UPDATE — and that join mints a non-publishing token
      // because the target is the AFK channel.
      const apiKey = env.LIVEKIT_API_KEY;
      const apiSecret = env.LIVEKIT_API_SECRET;
      const httpUrl =
        env.LIVEKIT_HTTP_URL ??
        env.LIVEKIT_WS_URL?.replace(/^wss?:/i, (m) =>
          m.toLowerCase() === 'wss:' ? 'https:' : 'http:',
        );
      if (apiKey && apiSecret && httpUrl) {
        const oldRoomName = roomNameForRow(cand);
        const svc = new RoomServiceClient(httpUrl, apiKey, apiSecret);
        try {
          await svc.removeParticipant(oldRoomName, cand.userId.toString());
        } catch (err) {
          log.warn?.('livekit removeParticipant on AFK auto-move failed (best-effort)', {
            userId: cand.userId.toString(),
            fromChannelId: cand.channelId.toString(),
            err: (err as Error).message,
          });
        }
      }

      moves.push({
        userId: cand.userId,
        guildId: g.id,
        fromChannelId: cand.channelId,
        voiceState: moved,
      });
    }
  }

  return moves;
}

