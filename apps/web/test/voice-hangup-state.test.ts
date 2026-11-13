/* The app side of a hang-up (src/state/AppState.tsx): hangUpCall's body
 * (runHangUpCall) and the optimistic VOICE_SELF_LEFT it dispatches. Every call
 * surface derives from voiceStatesByUser, so dropping our row at the click is
 * what makes a Leave look instant; the server leave runs alongside, retried
 * once, and a final failure re-reads the roster rather than leaving the
 * screen lying. The voice.ts half (cancelling a join in flight) is covered in
 * voice-hangup.test.ts. */
import { describe, it, expect } from 'vitest';
import { ApiError, type Channel, type VoiceState } from '@zekktris/client';
import { appStateReducer, initialAppState, runHangUpCall } from '../src/state/AppState';

type State = typeof initialAppState;
type Action = Parameters<typeof appStateReducer>[1];

const ME = '100';
const PARTNER = '200';
const OTHER = '300';

const row = (userId: string, channelId: string, guildId: string | null = null): VoiceState => ({
  userId,
  channelId,
  guildId,
  sessionId: `sess-${userId}`,
  selfMute: false,
  selfDeaf: false,
});
const channel = (id: string, type: Channel['type'], guildId: string | null = null) =>
  ({ id, type, guildId }) as unknown as Channel;

function stateWith(rows: VoiceState[], extra: Partial<State> = {}): State {
  return {
    ...initialAppState,
    voiceStatesByUser: Object.fromEntries(rows.map((r) => [r.userId, r])),
    ...extra,
  };
}

/** A hang-up's VOICE_SELF_LEFT: the user's own (`evenIfGone`) unless said
    otherwise, which is what every hang-up control sends; eviction sends
    `evenIfGone: false`. */
const selfLeft = (channelId: string, purgeChannel: boolean, evenIfGone = true): Action => ({
  type: 'VOICE_SELF_LEFT',
  userId: ME,
  channelId,
  purgeChannel,
  evenIfGone,
});

describe('VOICE_SELF_LEFT', () => {
  it('drops only our own row from a guild channel', () => {
    const s = stateWith([row(ME, 'vc', 'g'), row(OTHER, 'vc', 'g'), row(PARTNER, 'elsewhere', 'g')]);
    const next = appStateReducer(s, selfLeft('vc', false));
    expect(Object.keys(next.voiceStatesByUser).sort()).toEqual([PARTNER, OTHER].sort());
  });

  it('clears a whole 1:1 DM, so the partner’s lingering row can’t ring as an incoming call', () => {
    const s = stateWith([row(ME, 'dm'), row(PARTNER, 'dm'), row(OTHER, 'vc', 'g')]);
    const next = appStateReducer(s, selfLeft('dm', true));
    expect(Object.keys(next.voiceStatesByUser)).toEqual([OTHER]);
  });

  it('changes nothing when our row has moved to ANOTHER channel (a moderator move, or another device joined elsewhere)', () => {
    const s = stateWith([row(ME, 'vc2', 'g'), row(PARTNER, 'dm')]);
    expect(appStateReducer(s, selfLeft('dm', true))).toBe(s);
    expect(appStateReducer(s, selfLeft('dm', true, false))).toBe(s);
  });

  it('our row already gone (a cancelled join’s rollback echoed first): our own 1:1 hang-up still clears the partner', () => {
    // Left here, the partner's row is a full-screen ringing "Incoming call…"
    // until their own client leaves.
    const none = stateWith([row(PARTNER, 'dm'), row(OTHER, 'vc', 'g')]);
    const next = appStateReducer(none, selfLeft('dm', true));
    expect(Object.keys(next.voiceStatesByUser)).toEqual([OTHER]);
    // Eviction (the server removed us) leaves the partner's row to them.
    expect(appStateReducer(none, selfLeft('dm', true, false))).toBe(none);
    // Nothing of ours to drop in a guild channel: the state is untouched.
    const guild = stateWith([row(OTHER, 'vc', 'g')]);
    expect(appStateReducer(guild, selfLeft('vc', false))).toBe(guild);
  });
});

describe('runHangUpCall', () => {
  type Rest = Parameters<typeof runHangUpCall>[0]['rest'];
  function harness(state: State, rest: Partial<Rest>) {
    const calls: string[] = [];
    let current = state;
    const toasts: string[] = [];
    /** What voice.ts would say: this device has joined the channel again. */
    const joined = new Set<string>();
    const deps = {
      state,
      getState: () => current,
      selfId: ME,
      dispatch: (a: Action) => {
        calls.push(`dispatch ${a.type}`);
        current = appStateReducer(current, a);
      },
      joinedAgain: (id: string) => joined.has(id),
      rest: {
        leaveVoice: async (id: string) => {
          calls.push(`leaveVoice ${id}`);
          return { ok: true };
        },
        leaveStage: async (id: string) => {
          calls.push(`leaveStage ${id}`);
        },
        listVoiceStates: async (id: string) => {
          calls.push(`listVoiceStates ${id}`);
          return { voiceStates: [] as VoiceState[] };
        },
        ...rest,
      } as Rest,
      teardown: () => void calls.push('teardown'),
      toast: (m: string) => void toasts.push(m),
      retryDelayMs: 0,
      backgroundRetryDelaysMs: [0, 0, 0] as readonly number[],
    };
    return {
      deps,
      calls,
      toasts,
      joined,
      state: () => current,
      /** Stand in for an event landing meanwhile (an echo, a merge). */
      set: (next: State) => {
        current = next;
      },
    };
  }
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

  it('drops our row and starts the teardown before the server leave, then reports success', async () => {
    const s = stateWith([row(ME, 'vc', 'g'), row(OTHER, 'vc', 'g')]);
    const t = harness(s, {});
    const done = runHangUpCall(t.deps, 'vc');
    // Synchronously, before any network: the UI change and the teardown.
    expect(t.calls).toEqual(['dispatch VOICE_SELF_LEFT', 'teardown', 'leaveVoice vc']);
    expect(t.state().voiceStatesByUser[ME]).toBeUndefined();
    expect(t.state().voiceStatesByUser[OTHER]).toBeDefined();
    await expect(done).resolves.toBe(true);
    expect(t.toasts).toEqual([]);
  });

  it('a 1:1 DM hang-up clears the partner’s row too', async () => {
    const s = stateWith([row(ME, 'dm'), row(PARTNER, 'dm')], { dmChannels: [channel('dm', 'dm')] });
    const t = harness(s, {});
    await runHangUpCall(t.deps, 'dm');
    expect(t.state().voiceStatesByUser).toEqual({});
  });

  it('a group DM hang-up leaves the others in the call', async () => {
    const s = stateWith([row(ME, 'gdm'), row(PARTNER, 'gdm')], { dmChannels: [channel('gdm', 'group_dm')] });
    const t = harness(s, {});
    await runHangUpCall(t.deps, 'gdm');
    expect(Object.keys(t.state().voiceStatesByUser)).toEqual([PARTNER]);
  });

  it('retries a failed leave once; a 404 counts as left', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'vc', 'g')]), {
      leaveVoice: async () => {
        attempts++;
        if (attempts === 1) throw new Error('network');
        throw new ApiError(404, 'NOT_FOUND', 'gone');
      },
    });
    await expect(runHangUpCall(t.deps, 'vc')).resolves.toBe(true);
    expect(attempts).toBe(2);
    expect(t.toasts).toEqual([]);
  });

  it('after a second failure, re-reads the roster (the server still has us) and says so', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'vc', 'g'), row(OTHER, 'vc', 'g')]), {
      leaveVoice: async () => {
        attempts++;
        throw new ApiError(500, 'INTERNAL', 'Something broke');
      },
      listVoiceStates: async () => ({ voiceStates: [row(ME, 'vc', 'g'), row(OTHER, 'vc', 'g')] }),
    });
    await expect(runHangUpCall(t.deps, 'vc')).resolves.toBe(false);
    expect(attempts).toBe(2);
    // The optimistic leave is undone by the server's truth...
    expect(t.state().voiceStatesByUser[ME]?.channelId).toBe('vc');
    // ...and the user is told.
    expect(t.toasts).toEqual(['Something broke']);
    // The call is back on screen to leave: nothing keeps leaving behind it.
    await sleep(20);
    expect(attempts).toBe(2);
  });

  it('skips the retry once the user has joined the channel again on this device (the leave would end that call)', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'dm'), row(PARTNER, 'dm')], { dmChannels: [channel('dm', 'dm')] }), {
      leaveVoice: async () => {
        attempts++;
        // The route can fail after its leave has taken; the user calls back
        // before the retry is due.
        t.joined.add('dm');
        throw new ApiError(500, 'INTERNAL', 'Something broke');
      },
    });
    await expect(runHangUpCall(t.deps, 'dm')).resolves.toBe(true);
    expect(attempts).toBe(1);
    expect(t.toasts).toEqual([]);
  });

  it('…or on another device: our row back in the channel under another session', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'vc', 'g')]), {
      leaveVoice: async () => {
        attempts++;
        t.set(stateWith([{ ...row(ME, 'vc', 'g'), sessionId: 'sess-other-device' }]));
        throw new Error('network');
      },
    });
    await expect(runHangUpCall(t.deps, 'vc')).resolves.toBe(true);
    expect(attempts).toBe(1);
  });

  it('…but the session it is ending coming back (a stale roster refresh) is no rejoin: the retry goes', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'vc', 'g')]), {
      leaveVoice: async () => {
        attempts++;
        if (attempts > 1) return { ok: true };
        t.set(stateWith([row(ME, 'vc', 'g')]));
        throw new Error('network');
      },
    });
    await expect(runHangUpCall(t.deps, 'vc')).resolves.toBe(true);
    expect(attempts).toBe(2);
  });

  it('both leaves failed but the roster no longer has us (the leave took after all): true, no toast', async () => {
    const t = harness(stateWith([row(ME, 'dm'), row(PARTNER, 'dm')], { dmChannels: [channel('dm', 'dm')] }), {
      leaveVoice: async () => {
        throw new Error('network');
      },
      listVoiceStates: async () => ({ voiceStates: [row(PARTNER, 'dm')] }),
    });
    await expect(runHangUpCall(t.deps, 'dm')).resolves.toBe(true);
    expect(t.toasts).toEqual([]);
    // The 1:1 partner stays cleared: back, their row would ring as an
    // incoming call.
    expect(t.state().voiceStatesByUser).toEqual({});
  });

  it('the roster unreachable too: the leave keeps going in the background instead of standing with nothing to retry it', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'vc', 'g'), row(OTHER, 'vc', 'g')]), {
      leaveVoice: async () => {
        attempts++;
        if (attempts < 4) throw new Error('network');
        return { ok: true };
      },
      listVoiceStates: async () => {
        throw new Error('network');
      },
    });
    await expect(runHangUpCall(t.deps, 'vc')).resolves.toBe(false);
    expect(t.toasts).toEqual(['Failed to leave the call']);
    expect(attempts).toBe(2);
    await sleep(20);
    // Two more in the background; it stops once the server takes one.
    expect(attempts).toBe(4);
  });

  it('a 1:1 the partner already left (the auto-end) is not put back as a fresh ring-out; its leave keeps going instead', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'dm')], { dmChannels: [channel('dm', 'dm')] }), {
      leaveVoice: async () => {
        attempts++;
        if (attempts < 3) throw new ApiError(500, 'INTERNAL', 'Something broke');
        return { ok: true };
      },
      listVoiceStates: async () => ({ voiceStates: [row(ME, 'dm')] }),
    });
    await expect(runHangUpCall(t.deps, 'dm')).resolves.toBe(false);
    // Our row alone in a 1:1 is what every call surface reads as "Calling…".
    expect(t.state().voiceStatesByUser).toEqual({});
    expect(t.toasts).toEqual(['Something broke']);
    await sleep(20);
    expect(attempts).toBe(3);
  });

  it('a 1:1 the server still has the partner in comes back as the live call, so Leave can be pressed again', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'dm'), row(PARTNER, 'dm')], { dmChannels: [channel('dm', 'dm')] }), {
      leaveVoice: async () => {
        attempts++;
        throw new ApiError(500, 'INTERNAL', 'Something broke');
      },
      listVoiceStates: async () => ({ voiceStates: [row(ME, 'dm'), row(PARTNER, 'dm')] }),
    });
    await expect(runHangUpCall(t.deps, 'dm')).resolves.toBe(false);
    expect(Object.keys(t.state().voiceStatesByUser).sort()).toEqual([ME, PARTNER].sort());
    await sleep(20);
    expect(attempts).toBe(2);
  });

  it('the background leave stops once the user has joined the channel again', async () => {
    let attempts = 0;
    const t = harness(stateWith([row(ME, 'vc', 'g')]), {
      leaveVoice: async () => {
        attempts++;
        throw new Error('network');
      },
      listVoiceStates: async () => {
        throw new Error('network');
      },
    });
    await expect(runHangUpCall(t.deps, 'vc')).resolves.toBe(false);
    t.joined.add('vc');
    await sleep(20);
    expect(attempts).toBe(2);
  });

  it('a deferred 1:1 hang-up landing after our row is already gone (a cancelled join’s rollback echoed first) still clears the partner', async () => {
    const t = harness(stateWith([row(PARTNER, 'dm')], { dmChannels: [channel('dm', 'dm')] }), {});
    await expect(runHangUpCall(t.deps, 'dm', { teardown: false })).resolves.toBe(true);
    expect(t.state().voiceStatesByUser).toEqual({});
  });

  it('a stage: no voice row to drop, leaves through leaveStage', async () => {
    const s = stateWith([], {
      channelsByGuild: { g: [channel('stage', 'guild_stage', 'g')] },
    });
    const t = harness(s, {});
    await expect(runHangUpCall(t.deps, 'stage')).resolves.toBe(true);
    expect(t.calls).toEqual(['teardown', 'leaveStage stage']);
  });

  it('eviction (notifyServer: false) tears down without a server leave', async () => {
    // Evicted: the server already removed our row, and another of our
    // devices may hold one elsewhere now. Nothing local changes, nothing is
    // sent; only the teardown runs.
    const s = stateWith([row(ME, 'vc2', 'g')]);
    const t = harness(s, {});
    await expect(runHangUpCall(t.deps, 'vc', { notifyServer: false })).resolves.toBe(true);
    expect(t.calls.filter((c) => !c.startsWith('dispatch'))).toEqual(['teardown']);
    expect(t.state()).toBe(s);
  });

  it('eviction from a 1:1 DM leaves the partner’s row to the partner', async () => {
    const s = stateWith([row(PARTNER, 'dm')], { dmChannels: [channel('dm', 'dm')] });
    const t = harness(s, {});
    await expect(runHangUpCall(t.deps, 'dm', { notifyServer: false })).resolves.toBe(true);
    expect(t.state()).toBe(s);
  });

  it('teardown: false (VoiceView already started it under its animation) skips it', async () => {
    const t = harness(stateWith([row(ME, 'dm'), row(PARTNER, 'dm')], { dmChannels: [channel('dm', 'dm')] }), {});
    await runHangUpCall(t.deps, 'dm', { teardown: false });
    expect(t.calls).toEqual(['dispatch VOICE_SELF_LEFT', 'leaveVoice dm']);
  });
});
