import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Message } from '@zekktris/client';
import {
  appStateReducer,
  channelMentionCount,
  initialAppState,
  isChannelUnread,
  oldestFirst,
  tailJoinedAt,
} from '../src/state/AppState';
import { newestConfirmedId, planReadAck } from '../src/lib/readAck';
import { showsUnstartedTimer } from '../src/lib/disappearing';

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

  describe('a removed or expired last row rolls the DM’s lastMessageId back', () => {
    // The server rolls channels.last_message_id back (rollbackChannelWatermark)
    // and tells no one; without the same move here the DM reads unread against
    // a message nobody can load, and opening it acks nothing.
    const dm = (id: string, lastMessageId: string | null, type = 'group_dm') =>
      ({ id, type, lastMessageId }) as unknown as State['dmChannels'][number];
    const lastOf = (s: State, id: string) => s.dmChannels.find((c) => c.id === id)?.lastMessageId;
    const unread = (s: State, id: string) => isChannelUnread(s.dmChannels.find((c) => c.id === id)!, s.readStateByChannel);

    // C reads up to 20; A's 30 lands (unfocused window: no ack).
    function setup(): State {
      return run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('g', '20'), dm('other', '5')] },
        { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('10', 'g'), msg('20', 'g')] },
        { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '20', mentionCount: 0 } },
        { type: 'MESSAGE_APPEND', channelId: 'g', message: msg('30', 'g', { authorId: '2', expireAfterSeconds: 30 }) },
      );
    }

    it('MESSAGE_DELETE of the newest loaded row (the sweep, after another member read it)', () => {
      const s0 = setup();
      expect(lastOf(s0, 'g')).toBe('30');
      expect(unread(s0, 'g')).toBe(true);
      const s1 = run(s0, { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '30' });
      expect(lastOf(s1, 'g')).toBe('20');
      expect(unread(s1, 'g')).toBe(false);
      expect(lastOf(s1, 'other')).toBe('5');
    });

    it('a local expiry of it does the same', () => {
      const s0 = run(setup(), {
        type: 'EXPIRY_STAMP',
        expiries: [{ id: '30', expires_at: iso(T0 + 1_000) }],
        serverNow: iso(T0),
        receivedAt: T0,
      });
      vi.setSystemTime(T0 + 1_000);
      const s1 = run(s0, { type: 'MESSAGES_EXPIRE' });
      expect(ids(s1, 'g')).toEqual(['10', '20']);
      expect(lastOf(s1, 'g')).toBe('20');
      expect(unread(s1, 'g')).toBe(false);
    });

    it('an @mention that disappeared leaves no badge once the server’s CHANNEL_ACK says so', () => {
      // B's 30 @mentions A; C reads it first, and the sweep removes it. The
      // rollback clears the dot, but the mention count is the server's: the
      // sweep zeroes it and sends CHANNEL_ACK at the marker A already has.
      const s0 = run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('g', '20')] },
        { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('10', 'g'), msg('20', 'g')] },
        { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '20', mentionCount: 0 } },
        {
          type: 'MESSAGE_APPEND',
          channelId: 'g',
          message: msg('30', 'g', { authorId: '2', expireAfterSeconds: 3_600, mentionedUserIds: ['9'] }),
        },
        { type: 'MENTION_INCREMENT', channelId: 'g' },
        { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '30' },
      );
      expect(unread(s0, 'g')).toBe(false);
      expect(channelMentionCount('g', s0.readStateByChannel)).toBe(1);
      const s1 = run(s0, {
        type: 'READ_STATE_UPSERT',
        readState: { channelId: 'g', lastMessageId: '20', mentionCount: 0 },
      });
      expect(channelMentionCount('g', s1.readStateByChannel)).toBe(0);
      expect(s1.readStateByChannel.g!.lastMessageId).toBe('20');
      expect(unread(s1, 'g')).toBe(false);
    });

    it('a bulk delete falls back to the newest row left', () => {
      const s1 = run(setup(), { type: 'MESSAGES_REMOVE_BULK', channelId: 'g', messageIds: ['20', '30'] });
      expect(lastOf(s1, 'g')).toBe('10');
    });

    it('leaves it alone when an older row goes, or the row wasn’t loaded, or no server row is left', () => {
      const s0 = setup();
      const older = run(s0, { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '10' });
      expect(older.dmChannels).toBe(s0.dmChannels);
      // lastMessageId names a newer message not loaded yet (a reconnect's
      // DM refetch): removing the newest LOADED row says nothing about it.
      const ahead = run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('g', '40')] },
        { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('10', 'g'), msg('20', 'g'), msg('30', 'g')] },
        { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '30' },
      );
      expect(lastOf(ahead, 'g')).toBe('40');
      // Not loaded: nothing to fall back to (MessageView's stale-tail ack
      // clears that one on open).
      const unloaded = run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('g', '30')] },
        { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '30' },
      );
      expect(lastOf(unloaded, 'g')).toBe('30');
      // Only the removed row was held (a live append into an unopened DM).
      const alone = run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('g', '20')] },
        { type: 'MESSAGE_APPEND', channelId: 'g', message: msg('30', 'g') },
        { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '30' },
      );
      expect(lastOf(alone, 'g')).toBe('30');
    });

    it('a reconnect drops closed chats’ caches, so a live row removed after it keeps the dot', () => {
      // C read 'g' up to 200 and moved on; A's 300 and 400 landed while the
      // laptop slept past the resume window. The READY's DM refetch says 400,
      // but 'g's cache still ends at 200. A's 500 arrives live and is unsent.
      const s0 = run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('g', '200'), dm('open', '7')] },
        { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('100', 'g'), msg('200', 'g')] },
        { type: 'MESSAGES_SET', channelId: 'open', messages: [msg('7', 'open')] },
        { type: 'READ_STATES_SET', readStates: [{ channelId: 'g', lastMessageId: '200', mentionCount: 0 }] },
        { type: 'DMS_SET', channels: [dm('g', '400'), dm('open', '7')] },
        { type: 'CLOSED_CACHES_DROP', keep: 'open' },
      );
      // Opening 'g' now runs a full latest-window load, not an after-200
      // reconcile.
      expect(s0.loadedChannels.has('g')).toBe(false);
      expect(s0.messagesByChannel.g).toBeUndefined();
      const s1 = run(
        s0,
        { type: 'MESSAGE_APPEND', channelId: 'g', message: msg('500', 'g', { authorId: '2' }) },
        { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '500' },
      );
      // 300 and 400 are still unread on the server: nothing rolls back to 200.
      expect(lastOf(s1, 'g')).toBe('500');
      expect(unread(s1, 'g')).toBe(true);
    });

    it('CLOSED_CACHES_DROP keeps the open chat whole and is a no-op when nothing else is cached', () => {
      const s0 = run(
        initialAppState,
        { type: 'MESSAGES_SET', channelId: 'open', messages: [msg('7', 'open')] },
        { type: 'MESSAGES_PREPEND', channelId: 'open', messages: [msg('6', 'open')], reachedHead: true },
        { type: 'MESSAGES_SET', channelId: 'a', messages: [msg('1', 'a')] },
        { type: 'MESSAGES_PREPEND', channelId: 'a', messages: [], reachedHead: true },
        { type: 'LOADING_OLDER_BEGIN', channelId: 'b' },
      );
      const s1 = run(s0, { type: 'CLOSED_CACHES_DROP', keep: 'open' });
      expect(Object.keys(s1.messagesByChannel)).toEqual(['open']);
      expect(s1.messagesByChannel.open).toBe(s0.messagesByChannel.open);
      expect([...s1.loadedChannels]).toEqual(['open']);
      expect([...s1.olderExhausted]).toEqual(['open']);
      expect([...s1.loadingOlder]).toEqual([]);
      expect(run(s1, { type: 'CLOSED_CACHES_DROP', keep: 'open' })).toBe(s1);
      // No chat open (e.g. the Mentions pane): every cache goes.
      const s2 = run(s0, { type: 'CLOSED_CACHES_DROP', keep: null });
      expect(s2.messagesByChannel).toEqual({});
      expect(s2.loadedChannels.size + s2.olderExhausted.size + s2.loadingOlder.size).toBe(0);
      expect(run(initialAppState, { type: 'CLOSED_CACHES_DROP', keep: null })).toBe(initialAppState);
    });

    it('CLOSED_CACHES_DROP keeps only a closed chat’s unsent rows; its next full load carries them on', () => {
      // C's send in 'd' failed during the outage and she moved to 'open'. A's
      // 300 and 400 landed in the gap; the READY's DM refetch says 400.
      const s0 = run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('d', '200', 'dm'), dm('open', '7')] },
        { type: 'MESSAGES_SET', channelId: 'd', messages: [msg('100', 'd'), msg('200', 'd')], reachesTail: true },
        { type: 'MESSAGE_APPEND', channelId: 'd', message: msg('local-x', 'd', { failed: true }) },
        { type: 'MESSAGES_PREPEND', channelId: 'd', messages: [], reachedHead: true },
        { type: 'LOADING_OLDER_BEGIN', channelId: 'd' },
        { type: 'MESSAGES_SET', channelId: 'open', messages: [msg('7', 'open')] },
        { type: 'READ_STATES_SET', readStates: [{ channelId: 'd', lastMessageId: '200', mentionCount: 0 }] },
        { type: 'CLOSED_CACHES_DROP', keep: 'open' },
        { type: 'DMS_SET', channels: [dm('d', '400', 'dm'), dm('open', '7')] },
      );
      expect(ids(s0, 'd')).toEqual(['local-x']);
      expect(s0.loadedChannels.has('d') || s0.olderExhausted.has('d') || s0.loadingOlder.has('d')).toBe(false);
      // Opening 'd' runs a full load: no server row is left to reconcile after
      // (the stale 200 would ack 500 over the unseen 300 and 400).
      expect(newestConfirmedId(s0.messagesByChannel.d!)).toBeNull();
      // A's 500 arrives live and is unsent: nothing older to roll back to.
      const s1 = run(
        s0,
        { type: 'MESSAGE_APPEND', channelId: 'd', message: msg('500', 'd', { authorId: '2' }) },
        { type: 'MESSAGE_REMOVE', channelId: 'd', messageId: '500' },
      );
      expect(lastOf(s1, 'd')).toBe('500');
      expect(unread(s1, 'd')).toBe(true);
      // The full load keeps the failed bubble (and its Retry), after the page.
      const s2 = run(s0, {
        type: 'MESSAGES_SET',
        channelId: 'd',
        messages: [msg('200', 'd'), msg('300', 'd'), msg('400', 'd')],
        reachesTail: true,
      });
      expect(ids(s2, 'd')).toEqual(['200', '300', '400', 'local-x']);
      expect(s2.messagesByChannel.d![3]!.failed).toBe(true);
      // A closed chat holding nothing but unsent rows is left as it is.
      const s3 = run(s0, { type: 'CLOSED_CACHES_DROP', keep: null });
      expect(s3.messagesByChannel.d).toBe(s0.messagesByChannel.d);
      expect(Object.keys(s3.messagesByChannel)).toEqual(['d']);
    });

    it('MESSAGES_SET carries unsent rows the page doesn’t echo after it, but not onto a jump window', () => {
      const s0 = run(
        initialAppState,
        { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('1', 'c')] },
        { type: 'MESSAGE_APPEND', channelId: 'c', message: msg('local-a', 'c', { failed: true }) },
        { type: 'MESSAGE_APPEND', channelId: 'c', message: msg('local-b', 'c', { pending: true }) },
        { type: 'MESSAGE_APPEND', channelId: 'c', message: msg('5', 'c') },
      );
      // The newest window: live survivors, then unsent rows; one the page
      // echoes (by id or nonce) isn't doubled.
      const s1 = run(s0, {
        type: 'MESSAGES_SET',
        channelId: 'c',
        messages: [msg('1', 'c'), msg('3', 'c'), msg('4', 'c', { nonce: 'local-b' })],
        reachesTail: true,
      });
      expect(ids(s1, 'c')).toEqual(['1', '3', '4', '5', 'local-a']);
      // A jump to an older window takes neither.
      const s2 = run(s0, {
        type: 'MESSAGES_SET',
        channelId: 'c',
        messages: [msg('1', 'c')],
        preserveNewerSurvivors: false,
      });
      expect(ids(s2, 'c')).toEqual(['1']);
    });

    it('a jump window may stop short of the tail: removing its newest row keeps the dot until a latest load', () => {
      const s0 = run(
        initialAppState,
        { type: 'READ_STATES_SET', readStates: [{ channelId: 'g', lastMessageId: '200', mentionCount: 0 }] },
        { type: 'DMS_SET', channels: [dm('g', '400')] },
        // A mention jump loads an older window that stops at 200 (300 and 400
        // are unread on the server).
        { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('100', 'g'), msg('200', 'g')], preserveNewerSurvivors: false },
      );
      expect(s0.tailGapped.has('g')).toBe(true);
      const s1 = run(
        s0,
        { type: 'MESSAGE_APPEND', channelId: 'g', message: msg('500', 'g', { authorId: '2' }) },
        { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '500' },
      );
      expect(lastOf(s1, 'g')).toBe('500');
      expect(unread(s1, 'g')).toBe(true);
      // The newest window reaches the tail: the mark clears and a removal of
      // the newest row rolls back again.
      const s2 = run(
        s1,
        { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('300', 'g'), msg('400', 'g'), msg('600', 'g')], reachesTail: true },
        { type: 'DMS_SET', channels: [dm('g', '600')] },
      );
      expect(s2.tailGapped.has('g')).toBe(false);
      const s3 = run(s2, { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '600' });
      expect(lastOf(s3, 'g')).toBe('400');
      // A resync window (default survivors, no reachesTail) leaves a mark alone.
      const s4 = run(s0, { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('100', 'g'), msg('200', 'g')] });
      expect(s4.tailGapped.has('g')).toBe(true);
      // Dropping the closed cache drops its mark with it.
      expect(run(s0, { type: 'CLOSED_CACHES_DROP', keep: null }).tailGapped.size).toBe(0);
    });

    it('a jump window paged up to the tail loses its mark, so a removed newest row rolls back again', () => {
      // A mention jump into group DM 'g' (read up to 150) loads a window that
      // ends at 200; the server's tail is 400.
      const s0 = run(
        initialAppState,
        { type: 'READ_STATES_SET', readStates: [{ channelId: 'g', lastMessageId: '150', mentionCount: 0 }] },
        { type: 'DMS_SET', channels: [dm('g', '400')] },
        {
          type: 'MESSAGES_SET',
          channelId: 'g',
          messages: [msg('100', 'g'), msg('150', 'g'), msg('200', 'g')],
          preserveNewerSurvivors: false,
        },
      );
      expect(s0.tailGapped.has('g')).toBe(true);
      // The open view's poll pages on from 200; the page comes back short.
      const page = [msg('300', 'g', { authorId: '2' }), msg('400', 'g', { authorId: '2' })];
      const through = tailJoinedAt('200', page, 50);
      expect(through).toBe('200');
      const s1 = run(
        s0,
        ...page.map((message): Action => ({ type: 'MESSAGE_APPEND', channelId: 'g', message })),
        { type: 'TAIL_REACHED', channelId: 'g', throughId: through! },
        { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '400', mentionCount: 0 } },
      );
      expect(s1.tailGapped.has('g')).toBe(false);
      // C moves on. A's timed 500 lands, B reads it first, the sweep deletes it.
      const s2 = run(
        s1,
        { type: 'MESSAGE_APPEND', channelId: 'g', message: msg('500', 'g', { authorId: '2', expireAfterSeconds: 300 }) },
        { type: 'MESSAGE_REMOVE', channelId: 'g', messageId: '500' },
      );
      expect(lastOf(s2, 'g')).toBe('400');
      expect(unread(s2, 'g')).toBe(false);
    });

    it('TAIL_REACHED keeps the mark of a jump that replaced the window during the fetch', () => {
      const s0 = run(
        initialAppState,
        { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('100', 'g'), msg('200', 'g')], preserveNewerSurvivors: false },
        // A poll from 200 is in flight when another jump lands on 10–20.
        { type: 'MESSAGES_SET', channelId: 'g', messages: [msg('10', 'g'), msg('20', 'g')], preserveNewerSurvivors: false },
      );
      const s1 = run(s0, { type: 'TAIL_REACHED', channelId: 'g', throughId: '200' });
      expect(s1).toBe(s0);
      expect(s1.tailGapped.has('g')).toBe(true);
      // Nothing marked: nothing to do.
      const s2 = run(initialAppState, { type: 'MESSAGES_SET', channelId: 'c', messages: [msg('1', 'c')] });
      expect(run(s2, { type: 'TAIL_REACHED', channelId: 'c', throughId: '1' })).toBe(s2);
    });

    it('tailJoinedAt: a short page, or a latest page reaching back to the newest held row', () => {
      const page = (ns: number[]) => ns.map((n) => ({ id: String(n) }));
      const run50 = (from: number) => Array.from({ length: 50 }, (_, i) => from + i);
      // An after-cursor page from 200 (oldest first).
      expect(tailJoinedAt('200', page([300, 400]), 50)).toBe('200');
      expect(tailJoinedAt('200', [], 50)).toBe('200');
      expect(tailJoinedAt('200', page(run50(201)), 50)).toBeNull();
      // A full latest page (newest first): reaching back to 200, or not.
      expect(tailJoinedAt('200', page(run50(180).reverse()), 50)).toBe('200');
      expect(tailJoinedAt('200', page(run50(200).reverse()), 50)).toBe('200');
      expect(tailJoinedAt('200', page(run50(201).reverse()), 50)).toBeNull();
      // No server row held.
      expect(tailJoinedAt(null, page([1]), 50)).toBeNull();
    });

    it('never touches guild channels’ lists', () => {
      const s0 = run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('g', '20')] },
        { type: 'MESSAGES_SET', channelId: 'guildchan', messages: [msg('1', 'guildchan'), msg('2', 'guildchan')] },
      );
      const s1 = run(s0, { type: 'MESSAGE_REMOVE', channelId: 'guildchan', messageId: '2' });
      expect(s1.dmChannels).toBe(s0.dmChannels);
    });
  });

  describe('READ_STATE_UPSERT (CHANNEL_ACK): an equal marker carries the count', () => {
    const rs = (s: State, id: string) => s.readStateByChannel[id];

    it('a marker equal to ours takes the server’s count, lower or higher', () => {
      const s0 = run(
        initialAppState,
        { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '20', mentionCount: 0 } },
        { type: 'MENTION_INCREMENT', channelId: 'g' },
        { type: 'MENTION_INCREMENT', channelId: 'g' },
      );
      expect(rs(s0, 'g')).toEqual({ channelId: 'g', lastMessageId: '20', mentionCount: 2 });
      const lower = run(s0, { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '20', mentionCount: 1 } });
      expect(rs(lower, 'g')!.mentionCount).toBe(1);
      const zero = run(lower, { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '20', mentionCount: 0 } });
      expect(rs(zero, 'g')!.mentionCount).toBe(0);
    });

    it('no marker on either side (a mention in a channel never acked) is equal too', () => {
      const s0 = run(initialAppState, { type: 'MENTION_INCREMENT', channelId: 'g' });
      expect(rs(s0, 'g')).toEqual({ channelId: 'g', lastMessageId: null, mentionCount: 1 });
      const s1 = run(s0, { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: null, mentionCount: 0 } });
      expect(rs(s1, 'g')).toEqual({ channelId: 'g', lastMessageId: null, mentionCount: 0 });
      // Nothing local yet: taken as is.
      const fresh = run(initialAppState, {
        type: 'READ_STATE_UPSERT',
        readState: { channelId: 'h', lastMessageId: null, mentionCount: 3 },
      });
      expect(rs(fresh, 'h')!.mentionCount).toBe(3);
    });

    it('a marker behind ours — or none — changes nothing; a newer one replaces both', () => {
      const s0 = run(
        initialAppState,
        { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '20', mentionCount: 0 } },
        { type: 'MENTION_INCREMENT', channelId: 'g' },
      );
      expect(run(s0, { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '19', mentionCount: 0 } })).toBe(s0);
      expect(run(s0, { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: null, mentionCount: 0 } })).toBe(s0);
      expect(run(s0, { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: 'local-1', mentionCount: 0 } })).toBe(s0);
      const ahead = run(s0, { type: 'READ_STATE_UPSERT', readState: { channelId: 'g', lastMessageId: '21', mentionCount: 0 } });
      expect(rs(ahead, 'g')).toEqual({ channelId: 'g', lastMessageId: '21', mentionCount: 0 });
    });
  });

  describe('a catch-up page lands in order, and the open DM acks the newest row', () => {
    const SELF = '9';
    const dm = (id: string, lastMessageId: string) =>
      ({ id, type: 'dm', lastMessageId }) as unknown as State['dmChannels'][number];
    const timed = (id: string) => msg(id, 'd', { authorId: '2', expireAfterSeconds: 300 });

    // What MessageView's ack effect plans for the list as it stands.
    function plan(s: State, lastSent?: string) {
      const list = s.messagesByChannel.d!;
      const newest = newestConfirmedId(list)!;
      return planReadAck({
        isDm: true,
        newest,
        marker: s.readStateByChannel.d?.lastMessageId,
        lastSent,
        unstartedTimer: showsUnstartedTimer(list, s.expiryDeadlines, SELF, newest),
        channelLast: s.dmChannels.find((c) => c.id === 'd')?.lastMessageId,
        lastProbe: undefined,
      });
    }

    function setup(): State {
      return run(
        initialAppState,
        { type: 'DMS_SET', channels: [dm('d', '100')] },
        { type: 'MESSAGES_SET', channelId: 'd', messages: [msg('90', 'd'), msg('100', 'd')] },
        { type: 'READ_STATE_UPSERT', readState: { channelId: 'd', lastMessageId: '100', mentionCount: 0 } },
      );
    }
    const append = (s: State, page: Message[]) =>
      run(s, ...page.map((m): Action => ({ type: 'MESSAGE_APPEND', channelId: 'd', message: m })));

    it('reconcileChannel’s after-page (ascending from the server) appends in order', () => {
      // GET ?after=100 returns [101, 102]: B's burst while the socket was dead.
      const s = append(setup(), oldestFirst([timed('101'), timed('102')]));
      expect(ids(s, 'd')).toEqual(['90', '100', '101', '102']);
      // The ack covers both, so both countdowns start.
      expect(plan(s)).toEqual({ ack: '102', probe: null });
    });

    it('oldestFirst orders by snowflake value whichever way a page came back', () => {
      expect(oldestFirst([msg('102', 'd'), msg('99', 'd'), msg('101', 'd')]).map((m) => m.id)).toEqual(['99', '101', '102']);
      const page = [msg('1', 'd'), msg('2', 'd')];
      expect(oldestFirst(page)).not.toBe(page);
      expect(oldestFirst([msg('local-x', 'd'), msg('5', 'd'), msg('3', 'd')]).map((m) => m.id)).toEqual(['3', '5', 'local-x']);
    });

    it('a list that did land out of order still acks the highest row, not the last', () => {
      // The old reconcile appended the page reversed: [..., 100, 102, 101].
      const s = append(setup(), [timed('102'), timed('101')]);
      expect(ids(s, 'd')).toEqual(['90', '100', '102', '101']);
      expect(newestConfirmedId(s.messagesByChannel.d!)).toBe('102');
      expect(plan(s)).toEqual({ ack: '102', probe: null });
    });
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
