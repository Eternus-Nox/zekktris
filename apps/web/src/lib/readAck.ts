/**
 * Read acks
 * ---------
 * What the open conversation's auto-ack (MessageView) sends, as a pure
 * function the vitest suite (test/readAck.test.ts) drives directly.
 *
 * The plain rule: ack the newest loaded row while the read marker is behind
 * it. Two DM cases need more, because a DM's marker can read current (or the
 * DM read unread) without any ack covering what's on screen:
 *
 *   - Re-ack. Only an ack starts a disappearing message's countdown, and the
 *     local marker also moves on our OWN messages' echoes. A scheduled
 *     message firing, or the streak warning posted in our name, is no read:
 *     the server keeps our marker below someone else's timed message that is
 *     still waiting, but the echo moves the local one past it, and the plain
 *     rule then never acks it. So while the conversation shows someone else's
 *     timed row whose deadline we don't know (lib/disappearing
 *     showsUnstartedTimer), ack once more: at most once per marker (an ack of
 *     it starts every row it covers, and its MESSAGE_EXPIRY fills the
 *     deadlines in). iOS markChannelRead's rule.
 *   - Stale tail. The DM's lastMessageId can point past every loaded row at a
 *     message that is gone: deleted, or vanished because another member read
 *     it first, while the channel wasn't loaded. The server rolled its
 *     watermark back and told no one, so the DM reads unread and opening it
 *     acks nothing. Acking that id (the server takes a tombstone) clears it,
 *     but only once the server confirms nothing newer than the loaded tail is
 *     left to load. An unloaded live message, or a jump to an older window,
 *     must never be acked from here: that would start a countdown before
 *     anyone saw the message.
 */

const SNOWFLAKE = /^\d+$/;

function isSnowflake(id: string | null | undefined): id is string {
  return typeof id === 'string' && SNOWFLAKE.test(id);
}

export interface ReadAckInput {
  /** A 'dm' / 'group_dm' (the only channels with timers). */
  isDm: boolean;
  /** The newest loaded row with a server id. */
  newest: string;
  /** The local read marker; absent when there's no read state yet. */
  marker: string | null | undefined;
  /** The id this view's last ack for the channel sent. */
  lastSent: string | undefined;
  /** lib/disappearing showsUnstartedTimer over the loaded rows. */
  unstartedTimer: boolean;
  /** The channel's lastMessageId. */
  channelLast: string | null | undefined;
  /** The key of the last stale-tail probe for the channel. */
  lastProbe: string | undefined;
}

export interface ReadAckPlan {
  /** Ack this id now; null = nothing to send. */
  ack: string | null;
  /** Ask the server for a message after `after`; when none comes back, ack
      `tail`. `key` goes back in as `lastProbe`, so each (tail, loaded tail)
      pair is probed once. */
  probe: { after: string; tail: string; key: string } | null;
}

export function planReadAck(input: ReadAckInput): ReadAckPlan {
  const { isDm, newest, marker, lastSent, unstartedTimer, channelLast, lastProbe } = input;
  if (!isSnowflake(newest)) return { ack: null, probe: null };
  const known = isSnowflake(marker);
  let ack: string | null = null;
  if (!known || BigInt(newest) > BigInt(marker)) {
    ack = newest;
  } else if (isDm && unstartedTimer && lastSent !== newest) {
    // The marker reads current (or ahead: another device, a tombstone ack)
    // but something on screen still waits for a read.
    ack = newest;
  }
  let probe: ReadAckPlan['probe'] = null;
  if (
    isDm &&
    isSnowflake(channelLast) &&
    BigInt(channelLast) > BigInt(newest) &&
    (!known || BigInt(channelLast) > BigInt(marker))
  ) {
    const key = `${channelLast}:${newest}`;
    if (lastProbe !== key) probe = { after: newest, tail: channelLast, key };
  }
  return { ack, probe };
}
