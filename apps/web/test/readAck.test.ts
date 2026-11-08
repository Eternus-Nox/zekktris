import { describe, it, expect } from 'vitest';
import type { Message } from '@zekktris/client';
import { newestConfirmedId, planReadAck, type ReadAckInput } from '../src/lib/readAck';
import { showsUnstartedTimer } from '../src/lib/disappearing';

// The open conversation's auto-ack (MessageView) as a pure plan: the plain
// "newest row while the marker is behind it", the DM re-ack of a marker that
// reads current while someone else's timed row still waits for a read, and
// the DM stale-tail ack once the server confirms nothing newer is left.

const SELF = '100';
const PEER = '200';

function base(extra: Partial<ReadAckInput> = {}): ReadAckInput {
  return {
    isDm: true,
    newest: '30',
    marker: '30',
    lastSent: undefined,
    unstartedTimer: false,
    channelLast: '30',
    lastProbe: undefined,
    ...extra,
  };
}

function row(id: string, authorId: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    channelId: 'd',
    authorId,
    author: null,
    type: 'default',
    content: `m${id}`,
    replyToId: null,
    pinned: false,
    editedAt: null,
    mentionsEveryone: false,
    mentionedUserIds: [],
    mentionedRoleIds: [],
    attachments: [],
    reactions: [],
    embeds: [],
    poll: null,
    stickerId: null,
    sticker: null,
    forwardedFromMessageId: null,
    forwardedFrom: null,
    webhookId: null,
    authorOverrideName: null,
    authorOverrideAvatar: null,
    createdAt: '2026-11-08T08:00:00.000Z',
    ...extra,
  };
}

describe('newestConfirmedId — the row the ack covers', () => {
  it('the numerically highest server id, wherever it sits in the list', () => {
    expect(newestConfirmedId([row('90', PEER), row('100', PEER), row('101', PEER)])).toBe('101');
    expect(newestConfirmedId([row('90', PEER), row('102', PEER), row('101', PEER)])).toBe('102');
    // By value, not as strings.
    expect(newestConfirmedId([row('100', PEER), row('99', PEER)])).toBe('100');
  });

  it('skips pending and failed rows and anything that is not a snowflake', () => {
    expect(
      newestConfirmedId([
        row('30', PEER),
        row('local-1', SELF, { pending: true }),
        row('40', SELF, { pending: true }),
        row('local-2', SELF, { failed: true }),
      ]),
    ).toBe('30');
    expect(newestConfirmedId([row('local-1', SELF, { pending: true })])).toBeNull();
    expect(newestConfirmedId([])).toBeNull();
  });
});

describe('planReadAck — the plain rule', () => {
  it('acks the newest row while the marker is behind it, or when there is no read state', () => {
    expect(planReadAck(base({ marker: '20' }))).toEqual({ ack: '30', probe: null });
    expect(planReadAck(base({ marker: undefined }))).toEqual({ ack: '30', probe: null });
    expect(planReadAck(base({ marker: null }))).toEqual({ ack: '30', probe: null });
    // Guild channels too.
    expect(planReadAck(base({ isDm: false, marker: '9' }))).toEqual({ ack: '30', probe: null });
  });

  it('compares ids numerically, not as strings', () => {
    expect(planReadAck(base({ newest: '100', marker: '99', channelLast: '100' })).ack).toBe('100');
    expect(planReadAck(base({ newest: '99', marker: '100', channelLast: '99' })).ack).toBeNull();
  });

  it('sends nothing for a marker at or past the newest row', () => {
    expect(planReadAck(base())).toEqual({ ack: null, probe: null });
    // Ahead: another device read further, or a tombstone ack. Re-acking the
    // older newest row would move nothing (the server keeps the greater).
    expect(planReadAck(base({ marker: '40', channelLast: '40' }))).toEqual({ ack: null, probe: null });
  });

  it('never acks a non-snowflake id', () => {
    expect(planReadAck(base({ newest: 'local-1', marker: undefined }))).toEqual({ ack: null, probe: null });
  });
});

describe('planReadAck — re-ack while a timed row waits for a read', () => {
  it('acks a current marker once more in a DM showing an unstarted timer', () => {
    expect(planReadAck(base({ unstartedTimer: true }))).toEqual({ ack: '30', probe: null });
    // Also with the marker ahead of the newest row.
    expect(planReadAck(base({ marker: '40', channelLast: '40', unstartedTimer: true })).ack).toBe('30');
  });

  it('at most once per marker: not when this view already acked it', () => {
    expect(planReadAck(base({ unstartedTimer: true, lastSent: '30' })).ack).toBeNull();
    // A new marker value gets its one extra ack.
    expect(planReadAck(base({ newest: '31', marker: '31', channelLast: '31', unstartedTimer: true, lastSent: '30' })).ack).toBe('31');
  });

  it('only in DMs, and only for an unstarted timer', () => {
    expect(planReadAck(base({ isDm: false, unstartedTimer: true })).ack).toBeNull();
    expect(planReadAck(base({ unstartedTimer: false })).ack).toBeNull();
  });

  it('a scheduled message that fired over an unread timed message: the open acks it, once', () => {
    // B's M (1 h timer) waits; A's scheduled S fired, and S's own echo moved
    // A's local marker to S. The server held A's marker below M.
    const messages = [row('10', PEER), row('20', PEER, { expireAfterSeconds: 3600 }), row('30', SELF)];
    let deadlines: Record<string, number> = {};
    let lastSent: string | undefined;
    const run = () => {
      const plan = planReadAck(
        base({ lastSent, unstartedTimer: showsUnstartedTimer(messages, deadlines, SELF, '30') }),
      );
      if (plan.ack) lastSent = plan.ack;
      return plan.ack;
    };
    // A opens the DM: the marker reads current, but M's countdown is unknown.
    expect(run()).toBe('30');
    // Re-renders before MESSAGE_EXPIRY lands (focus, a reaction): no repeat.
    expect(run()).toBeNull();
    expect(run()).toBeNull();
    // MESSAGE_EXPIRY fills the deadline in: nothing waits any more.
    deadlines = { '20': Date.parse('2026-11-08T09:10:00.000Z') };
    lastSent = undefined;
    expect(run()).toBeNull();
  });

  it('the streak warning posted in our name does the same', () => {
    const messages = [
      row('20', PEER, { expireAfterSeconds: 300 }),
      // A plain row authored by us, with streak_warning metadata.
      row('30', SELF, { metadata: { kind: 'streak_warning', streak: 12 } as Message['metadata'] }),
    ];
    expect(
      planReadAck(base({ unstartedTimer: showsUnstartedTimer(messages, {}, SELF, '30') })).ack,
    ).toBe('30');
  });

  it('our own timed rows never trigger it (only a reader starts a countdown)', () => {
    const messages = [row('20', SELF, { expireAfterSeconds: 300 }), row('30', SELF)];
    expect(planReadAck(base({ unstartedTimer: showsUnstartedTimer(messages, {}, SELF, '30') })).ack).toBeNull();
  });
});

describe('planReadAck — stale DM tail', () => {
  it('probes when the DM’s lastMessageId is past every loaded row and reads unread', () => {
    expect(planReadAck(base({ channelLast: '50' }))).toEqual({
      ack: null,
      probe: { after: '30', tail: '50', key: '50:30' },
    });
    // No read state yet: still unread.
    expect(planReadAck(base({ marker: undefined, channelLast: '50' })).probe?.tail).toBe('50');
  });

  it('probes each (tail, loaded tail) pair once', () => {
    expect(planReadAck(base({ channelLast: '50', lastProbe: '50:30' })).probe).toBeNull();
    // The loaded tail moved (a reconcile appended rows): probe again.
    expect(planReadAck(base({ newest: '40', marker: '40', channelLast: '50', lastProbe: '50:30' })).probe).toEqual({
      after: '40',
      tail: '50',
      key: '50:40',
    });
  });

  it('runs beside the plain ack when unread rows are loaded too', () => {
    expect(planReadAck(base({ marker: '10', channelLast: '50' }))).toEqual({
      ack: '30',
      probe: { after: '30', tail: '50', key: '50:30' },
    });
  });

  it('not when the DM already reads read, the tail is loaded, or outside DMs', () => {
    expect(planReadAck(base({ marker: '50', channelLast: '50' })).probe).toBeNull();
    expect(planReadAck(base({ channelLast: '30' })).probe).toBeNull();
    expect(planReadAck(base({ channelLast: '20' })).probe).toBeNull();
    expect(planReadAck(base({ channelLast: null })).probe).toBeNull();
    expect(planReadAck(base({ isDm: false, channelLast: '50' })).probe).toBeNull();
  });
});
