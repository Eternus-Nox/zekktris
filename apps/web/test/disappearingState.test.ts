import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Message } from '@zekktris/client';
import { appStateReducer, initialAppState } from '../src/state/AppState';

// Disappearing messages in the AppState reducer: deadlines kept apart from the
// message objects, rows past their deadline never (re-)ingested, one removal
// pass across channels, and no re-render churn when nothing changed.

type State = typeof initialAppState;
type Action = Parameters<typeof appStateReducer>[1];

const T0 = Date.parse('2026-11-08T12:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function msg(id: string, channelId: string, extra: Partial<Message> = {}): Message {
  return {
    id,
    channelId,
    authorId: '1',
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
    createdAt: iso(T0 - 60_000),
    ...extra,
  };
}

function run(state: State, ...actions: Action[]): State {
  return actions.reduce((s, a) => appStateReducer(s, a), state);
}

const ids = (s: State, channelId: string) => (s.messagesByChannel[channelId] ?? []).map((m) => m.id);

describe('AppState — disappearing messages', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('MESSAGES_SET records REST expiresAt and drops rows already past it', () => {
    const s = run(initialAppState, {
      type: 'MESSAGES_SET',
      channelId: 'c',
      messages: [
        msg('1', 'c', { expireAfterSeconds: 30, expiresAt: iso(T0 - 1) }),
        msg('2', 'c', { expireAfterSeconds: 30, expiresAt: iso(T0 + 30_000) }),
        msg('3', 'c'),
      ],
    });
    expect(ids(s, 'c')).toEqual(['2', '3']);
    expect(s.expiryDeadlines).toEqual({ '1': T0 - 1, '2': T0 + 30_000 });
  });

  it('a page without disappearing messages leaves the deadline map alone', () => {
    const s = run(initialAppState, { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('1', 'c')] });
    expect(s.expiryDeadlines).toBe(initialAppState.expiryDeadlines);
  });

  it('a refetched duplicate still delivers its deadline (MESSAGE_APPEND dedups the row)', () => {
    const s0 = run(initialAppState, { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('1', 'c')] });
    const list = s0.messagesByChannel.c;
    const s1 = run(s0, {
      type: 'MESSAGE_APPEND',
      channelId: 'c',
      message: msg('1', 'c', { expiresAt: iso(T0 + 5_000) }),
    });
    expect(s1.messagesByChannel.c).toBe(list);
    expect(s1.expiryDeadlines).toEqual({ '1': T0 + 5_000 });
  });

  it('a row whose deadline passed is not resurrected by a reconcile racing the sweep', () => {
    const s0 = run(
      initialAppState,
      { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('1', 'c'), msg('2', 'c', { expireAfterSeconds: 30 })] },
      {
        type: 'EXPIRY_STAMP',
        expiries: [{ id: '2', expires_at: iso(T0 + 1_000) }],
        serverNow: iso(T0),
        receivedAt: T0,
      },
    );
    vi.setSystemTime(T0 + 2_000);
    const s1 = run(s0, { type: 'MESSAGES_EXPIRE' });
    expect(ids(s1, 'c')).toEqual(['1']);
    // The after-cursor reconcile (or a reload) brings the row back without
    // expiresAt — it must stay gone.
    const s2 = run(s1, { type: 'MESSAGE_APPEND', channelId: 'c', message: msg('2', 'c', { expireAfterSeconds: 30 }) });
    expect(ids(s2, 'c')).toEqual(['1']);
    const s3 = run(s2, { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('1', 'c'), msg('2', 'c')] });
    expect(ids(s3, 'c')).toEqual(['1']);
  });

  it('EXPIRY_STAMP keeps deadlines in server time, learns the clock offset, and records unknown ids', () => {
    // Device clock 60 s fast.
    const s = run(initialAppState, {
      type: 'EXPIRY_STAMP',
      expiries: [
        { id: '9', expires_at: iso(T0 + 30_000) },
        { id: 'not-loaded', expires_at: iso(T0 + 40_000) },
      ],
      serverNow: iso(T0),
      receivedAt: T0 + 60_000,
    });
    expect(s.serverClockOffsetMs).toBe(-60_000);
    expect(s.expiryDeadlines).toEqual({ '9': T0 + 30_000, 'not-loaded': T0 + 40_000 });
    // At device T0 + 60 s the server is at T0: nothing is due yet.
    vi.setSystemTime(T0 + 60_000);
    const loaded = run(s, { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('9', 'c')] });
    expect(ids(loaded, 'c')).toEqual(['9']);
    expect(run(loaded, { type: 'MESSAGES_EXPIRE' })).toBe(loaded);
    vi.setSystemTime(T0 + 90_001);
    expect(ids(run(loaded, { type: 'MESSAGES_EXPIRE' }), 'c')).toEqual([]);
  });

  describe('a fast device clock before any MESSAGE_EXPIRY (e.g. after a reload)', () => {
    // The device clock is 60 s FAST. The message page was stamped at server
    // T0 + 0.7 s; its Date header says T0 (whole seconds), and it arrived
    // 150 ms later, at device T0 + 60.85 s. Re-acking rows whose countdown
    // already started sends no MESSAGE_EXPIRY, so the Date header is all the
    // client has.
    const arrived = T0 + 60_850;
    const page = () => [
      msg('1', 'c', { expireAfterSeconds: 30, expiresAt: iso(T0 + 30_000) }),
      msg('2', 'c', { expireAfterSeconds: 300, expiresAt: iso(T0 + 300_000) }),
    ];
    const serverDate: Action = { type: 'SERVER_DATE', serverMs: T0, receivedAt: arrived };

    beforeEach(() => {
      vi.setSystemTime(arrived);
    });

    it('without the Date header the raw device clock would hide a 30 s message on arrival', () => {
      const s = run(initialAppState, { type: 'MESSAGES_SET', channelId: 'c', messages: page() });
      expect(ids(s, 'c')).toEqual(['2']);
    });

    it('the response’s Date header seeds the offset before its page is ingested', () => {
      const s = run(initialAppState, serverDate, { type: 'MESSAGES_SET', channelId: 'c', messages: page() });
      expect(s.dateClockOffsetMs).toBe(-60_850);
      expect(s.serverClockOffsetMs).toBeNull();
      expect(ids(s, 'c')).toEqual(['1', '2']);
      expect(run(s, { type: 'MESSAGES_EXPIRE' })).toBe(s);
      // The lower bound fires late (by the truncation plus latency), never
      // early: at server T0 + 30 s the device reads T0 + 90 s, and the row is
      // still there…
      vi.setSystemTime(T0 + 90_000);
      expect(run(s, { type: 'MESSAGES_EXPIRE' })).toBe(s);
      // …until 850 ms later.
      vi.setSystemTime(T0 + 90_850);
      expect(ids(run(s, { type: 'MESSAGES_EXPIRE' }), 'c')).toEqual(['2']);
    });

    it('older pages and reconcile appends are ingested with it too', () => {
      const s0 = run(initialAppState, serverDate, {
        type: 'MESSAGES_SET',
        channelId: 'c',
        messages: [msg('5', 'c')],
      });
      const s1 = run(s0, {
        type: 'MESSAGES_PREPEND',
        channelId: 'c',
        messages: [msg('3', 'c', { expireAfterSeconds: 30, expiresAt: iso(T0 + 30_000) })],
        reachedHead: false,
      });
      const s2 = run(s1, {
        type: 'MESSAGE_APPEND',
        channelId: 'c',
        message: msg('6', 'c', { expireAfterSeconds: 30, expiresAt: iso(T0 + 30_000) }),
      });
      expect(ids(s2, 'c')).toEqual(['3', '5', '6']);
    });

    it('MESSAGE_EXPIRY’s server_now offset wins once known', () => {
      const s0 = run(initialAppState, serverDate, { type: 'MESSAGES_SET', channelId: 'c', messages: page() });
      const s1 = run(s0, {
        type: 'EXPIRY_STAMP',
        expiries: [{ id: '9', expires_at: iso(T0 + 600_000) }],
        serverNow: iso(T0 + 1_000),
        receivedAt: T0 + 61_010,
      });
      expect(s1.serverClockOffsetMs).toBe(-60_010);
      // Later Date headers are ignored (no re-render)…
      expect(run(s1, { type: 'SERVER_DATE', serverMs: T0 + 5_000, receivedAt: T0 + 70_000 })).toBe(s1);
      // …and deadlines go by the precise offset: at device T0 + 90.5 s the
      // server is at T0 + 30.49 s, past message 1's deadline (the Date
      // header's offset would still say T0 + 29.65 s).
      vi.setSystemTime(T0 + 90_500);
      expect(ids(run(s1, { type: 'MESSAGES_EXPIRE' }), 'c')).toEqual(['2']);
    });

    it('jitter within the header’s resolution changes nothing; a drop is taken', () => {
      const s0 = run(initialAppState, serverDate);
      expect(run(s0, serverDate)).toBe(s0);
      expect(run(s0, { type: 'SERVER_DATE', serverMs: T0 + 1_000, receivedAt: arrived + 300 })).toBe(s0);
      expect(run(s0, { type: 'SERVER_DATE', serverMs: Number.NaN, receivedAt: arrived })).toBe(s0);
      // The device clock jumped 5 s further ahead: taken at once.
      const s1 = run(s0, { type: 'SERVER_DATE', serverMs: T0 + 1_000, receivedAt: arrived + 6_000 });
      expect(s1.dateClockOffsetMs).toBe(-65_850);
    });
  });

  it('MESSAGES_EXPIRE removes due rows from every channel in one update, and is a no-op otherwise', () => {
    const s0 = run(
      initialAppState,
      { type: 'MESSAGES_SET', channelId: 'a', messages: [msg('1', 'a'), msg('2', 'a')] },
      { type: 'MESSAGES_SET', channelId: 'b', messages: [msg('3', 'b'), msg('4', 'b')] },
      {
        type: 'EXPIRY_STAMP',
        expiries: [
          { id: '1', expires_at: iso(T0 + 1_000) },
          { id: '4', expires_at: iso(T0 + 1_000) },
          { id: '2', expires_at: iso(T0 + 60_000) },
        ],
        serverNow: iso(T0),
        receivedAt: T0,
      },
    );
    expect(run(s0, { type: 'MESSAGES_EXPIRE' })).toBe(s0);
    vi.setSystemTime(T0 + 1_000);
    const s1 = run(s0, { type: 'MESSAGES_EXPIRE' });
    expect(ids(s1, 'a')).toEqual(['2']);
    expect(ids(s1, 'b')).toEqual(['3']);
    // Passed deadlines are remembered for a while, then forgotten.
    expect(Object.keys(s1.expiryDeadlines).sort()).toEqual(['1', '2', '4']);
    vi.setSystemTime(T0 + 61_000 + 10 * 60_000 + 1);
    const s2 = run(s1, { type: 'MESSAGES_EXPIRE' });
    expect(ids(s2, 'a')).toEqual([]);
    expect(s2.expiryDeadlines).toEqual({});
  });

  it('the sweep’s MESSAGE_DELETE for a row already hidden locally changes nothing', () => {
    const s0 = run(initialAppState, { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('1', 'c')] });
    expect(run(s0, { type: 'MESSAGE_REMOVE', channelId: 'c', messageId: 'gone' })).toBe(s0);
    expect(ids(run(s0, { type: 'MESSAGE_REMOVE', channelId: 'c', messageId: '1' }), 'c')).toEqual([]);
  });

  it('MESSAGE_UPDATE (a DTO without the deadline) cannot wipe a known deadline', () => {
    const s0 = run(
      initialAppState,
      { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('1', 'c', { expiresAt: iso(T0 + 5_000) })] },
      { type: 'MESSAGE_PATCH', channelId: 'c', message: msg('1', 'c', { content: 'edited embeds' }) },
    );
    expect(s0.messagesByChannel.c![0]!.expiresAt).toBeUndefined();
    expect(s0.expiryDeadlines).toEqual({ '1': T0 + 5_000 });
  });

  it('DM_TIMER_SET tracks each DM’s timer without churn; closing the DM forgets it', () => {
    const s0 = run(initialAppState, { type: 'DM_TIMER_SET', channelId: 'd', seconds: 86_400 });
    expect(s0.dmTimers).toEqual({ d: 86_400 });
    expect(run(s0, { type: 'DM_TIMER_SET', channelId: 'd', seconds: 86_400 })).toBe(s0);
    const off = run(s0, { type: 'DM_TIMER_SET', channelId: 'd', seconds: null });
    expect(off.dmTimers).toEqual({ d: null });
    expect(run(off, { type: 'DM_TIMER_SET', channelId: 'd', seconds: null })).toBe(off);
    const withDm = run(s0, {
      type: 'DMS_SET',
      channels: [{ id: 'd', type: 'dm' } as unknown as State['dmChannels'][number]],
    });
    const closed = run(withDm, { type: 'CHANNEL_REMOVE', channelId: 'd', guildId: null });
    expect(closed.dmTimers).toEqual({});
  });
});
