import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import {
  PET_MOODS,
  PET_STAGES,
  PET_TASKS,
  normalizePetName,
  type Channel,
  type DmPetState,
  type Message,
  type PetDTO,
  type PetMood,
  type PetStage,
} from '@zekktris/client';
import {
  appendScrollKind,
  blockSubjectId,
  isPetNotice,
  nextUtcMidnightRefreshAt,
  petArtProgress,
  petBanner,
  petCanAct,
  petDisplayName,
  petLevelLine,
  petLevelProgress,
  petMoodView,
  petNextRefreshAt,
  petNoticeArt,
  petNoticeText,
  petStagePath,
  petTaskRows,
  utcWeekday,
} from '../src/lib/zekkPet';
import { PetInviteActions, barButton, barHoldsFocus, refocusIfDropped } from '../src/app/ZekkPet';
import { restoreFocus } from '../src/app/ZekkPetModal';
import {
  clearPetBannerDismissals,
  dismissPetBanner,
  isPetBannerDismissed,
  subscribePetBannerDismissals,
} from '../src/lib/petBannerDismissals';
import {
  PET_COLORS,
  PET_INK,
  petColorsForAccents,
  petFaceShapes,
  petGeometry,
  petHeartShapes,
  petMotion,
  petShapes,
  sparklePoints,
  starPoints,
  zPoints,
  type PetShape,
} from '../src/lib/petArt';
import { ZekkPetArt } from '../src/lib/ZekkPetArt';
import {
  appStateReducer,
  channelMentionCount,
  initialAppState,
  isChannelUnread,
  ownEchoReadState,
  petDmIdsWithUser,
} from '../src/state/AppState';
import { newestConfirmedId, planReadAck } from '../src/lib/readAck';
import { serverNow, timeoutUntil } from '../src/lib/disappearing';

// Zekk Pet on the web: the words (mood chip, care list, level bar, stage
// path, adopt bar, in-chat notices), the art's geometry per stage and mood —
// the same numbers the iOS and Android apps draw — and the pet map in the
// AppState reducer.

const SELF = '100';
const PEER = '200';

function pet(extra: Partial<PetDTO> = {}): PetDTO {
  return {
    channelId: '900',
    status: 'active',
    invitedBy: SELF,
    name: 'Zekk',
    level: 2,
    stage: 'baby',
    points: 70,
    levelFloor: 55,
    nextLevelAt: 90,
    mood: 'happy',
    tasks: [
      { key: 'both_hi', done: true, points: 10 },
      {
        key: 'chatty',
        done: false,
        points: 10,
        progress: { a: { userId: PEER, count: 7 }, b: { userId: SELF, count: 4 }, goal: 10 },
      },
      { key: 'voice', done: false, points: 5 },
      { key: 'photo', done: true, points: 5 },
      { key: 'poke', done: false, points: 5 },
    ],
    fedToday: true,
    lastFedDay: '2026-11-11',
    wakeBy: null,
    adoptedAt: '2026-11-01T10:00:00.000Z',
    today: '2026-11-11',
    dayEndsAt: '2026-11-12T00:00:00.000Z',
    ...extra,
  } as PetDTO;
}

describe('shared strings reach the web unchanged', () => {
  it('has the six mood words and lines', () => {
    expect(Object.fromEntries(Object.entries(PET_MOODS).map(([k, v]) => [k, [v.label, v.line]]))).toEqual({
      thriving: ['Thriving', "Every task done today. It's glowing!"],
      happy: ['Happy', 'Fed for today. Keep chatting to earn more points.'],
      lonely: ['Lonely', 'Only one of you has said hi today.'],
      hungry: ['Hungry', 'Say hi to each other to feed it.'],
      grumpy: ['Grumpy', 'Your streak ends at midnight UTC. Say hi to each other!'],
      asleep: ['Asleep', 'Your streak broke. Both say hi by {day} to wake it up, or it runs away.'],
    });
    expect(PET_STAGES.map((s) => s.label)).toEqual(['Egg', 'Baby', 'Kid', 'Teen', 'Adult', 'Legendary']);
    expect(PET_TASKS.map((t) => [t.label, t.points])).toEqual([
      ['Both say hi', 10],
      ['10 messages each', 10],
      ['Send a voice message', 5],
      ['Send a photo', 5],
      ['Poke each other', 5],
    ]);
  });

  it('validates names like the server', () => {
    expect(normalizePetName('  Mochi   the  Brave ')).toBe('Mochi the Brave');
    expect(normalizePetName('   ')).toBeNull();
    expect(normalizePetName('x'.repeat(24))).toBe('x'.repeat(24));
    expect(normalizePetName('x'.repeat(25))).toBeNull();
    expect(normalizePetName('a\u0007b')).toBeNull();
  });

  it("masks a swear-word name for a supervised child, like a message body", () => {
    // The other person picks the name, so the parental mask has to reach it
    // (header pet, card, notices) as it reaches their messages.
    expect(petDisplayName('Shit Lord', true)).toBe('S••• Lord');
    expect(petDisplayName('Shit Lord', false)).toBe('Shit Lord');
    expect(petDisplayName('Mochi', true)).toBe('Mochi');
  });
});

describe('mood chip', () => {
  it('uses the label and line of every mood', () => {
    for (const mood of ['thriving', 'happy', 'lonely', 'hungry', 'grumpy'] as PetMood[]) {
      expect(petMoodView(pet({ mood }))).toEqual({ mood, label: PET_MOODS[mood].label, line: PET_MOODS[mood].line });
    }
  });

  it('names the weekday of wakeBy as a UTC day', () => {
    // 2026-11-14 is a Saturday everywhere — the viewer's zone mustn't shift it.
    const v = petMoodView(pet({ mood: 'asleep', status: 'asleep', wakeBy: '2026-11-14', lastFedDay: '2026-11-11' }));
    expect(v.label).toBe('Asleep');
    expect(v.line).toBe('Your streak broke. Both say hi by Saturday to wake it up, or it runs away.');
  });

  it('falls back to last fed day + 3 without wakeBy', () => {
    const v = petMoodView(pet({ mood: 'asleep', wakeBy: null, lastFedDay: '2026-11-11' }));
    expect(v.line).toContain('by Saturday to wake');
  });

  it('formats UTC weekdays', () => {
    expect(utcWeekday('2026-11-11')).toBe('Wednesday');
    expect(utcWeekday('2026-11-15')).toBe('Sunday');
    expect(utcWeekday('2027-01-01')).toBe('Friday');
    expect(utcWeekday('soon')).toBeNull();
    expect(utcWeekday(null)).toBeNull();
  });
});

describe("today's care", () => {
  it('lists the five tasks in order, with my count first on chatty', () => {
    expect(petTaskRows(pet(), SELF)).toEqual([
      { key: 'both_hi', label: 'Both say hi', points: 10, done: true, progress: null },
      { key: 'chatty', label: '10 messages each', points: 10, done: false, progress: '4/10 · 7/10' },
      { key: 'voice', label: 'Send a voice message', points: 5, done: false, progress: null },
      { key: 'photo', label: 'Send a photo', points: 5, done: true, progress: null },
      { key: 'poke', label: 'Poke each other', points: 5, done: false, progress: null },
    ]);
    // The other person sees the counts the other way round.
    expect(petTaskRows(pet(), PEER)[1]!.progress).toBe('7/10 · 4/10');
  });

  it('reads missing tasks and counts as not done / 0', () => {
    const rows = petTaskRows(
      pet({ tasks: [{ key: 'chatty', done: false, points: 10, progress: { a: { userId: PEER, count: 12 }, goal: 10 } }] }),
      SELF,
    );
    expect(rows.map((r) => r.done)).toEqual([false, false, false, false, false]);
    expect(rows[1]!.progress).toBe('0/10 · 10/10');
    expect(petTaskRows(pet({ tasks: [] }), SELF).map((r) => r.points)).toEqual([10, 10, 5, 5, 5]);
  });
});

describe('level and stages', () => {
  it('shows points within the level', () => {
    expect(petLevelProgress(pet())).toEqual({ have: 15, need: 35, fraction: 15 / 35, label: '15/35 to level 3' });
    expect(petLevelLine(pet())).toBe('Level 2 · Baby');
    expect(petLevelLine(pet({ level: 25, stage: 'legendary' }))).toBe('Level 25 · Legendary');
  });

  it('clamps odd values', () => {
    expect(petLevelProgress(pet({ points: 10, levelFloor: 55 })).have).toBe(0);
    expect(petLevelProgress(pet({ points: 999, levelFloor: 55, nextLevelAt: 90 })).fraction).toBe(1);
    expect(petArtProgress(pet({ level: 0, stage: 'egg', points: 20, levelFloor: 0, nextLevelAt: 25 }))).toBe(0.8);
  });

  it('marks the current stage on the path', () => {
    const path = petStagePath('teen');
    expect(path.map((s) => s.label)).toEqual(['Egg', 'Baby', 'Kid', 'Teen', 'Adult', 'Legendary']);
    expect(path.filter((s) => s.current).map((s) => s.stage)).toEqual(['teen']);
    expect(path.map((s) => s.reached)).toEqual([true, true, true, true, false, false]);
  });
});

describe('adopt bar', () => {
  const state = (p: PetDTO | null, eligible = true): DmPetState => ({ pet: p, eligible, streak: 5, minStreak: 3 });

  it('offers adoption when the DM may adopt', () => {
    expect(petBanner(state(null), SELF, 'Sam')).toEqual({
      kind: 'adopt',
      text: '🥚 5-day streak! Adopt a Zekk Pet with Sam.',
    });
    expect(petBanner(state(null, false), SELF, 'Sam')).toBeNull();
  });

  it('shows our waiting invite and their invite to us', () => {
    const invited = pet({ status: 'invited', level: 0, stage: 'egg', tasks: [] });
    expect(petBanner(state({ ...invited, invitedBy: SELF }), SELF, 'Sam')).toEqual({
      kind: 'waiting',
      text: 'Waiting for Sam to accept your Zekk Pet.',
    });
    expect(petBanner(state({ ...invited, invitedBy: PEER }), SELF, 'Sam')).toEqual({
      kind: 'invited',
      text: 'Sam wants to raise a Zekk Pet with you.',
    });
  });

  it('locks Accept on their invite once the streak is under the minimum', () => {
    // A invited on a 4-day streak, then a day was missed: the invite stays
    // up to 7 days, but the server refuses to accept it on a broken streak.
    const invited = pet({ status: 'invited', level: 0, stage: 'egg', tasks: [], invitedBy: PEER });
    const broken: DmPetState = { pet: invited, eligible: false, streak: 0, minStreak: 3 };
    expect(petBanner(broken, SELF, 'Sam')).toEqual({
      kind: 'invited',
      text: 'Sam wants to raise a Zekk Pet with you. Keep a 3-day streak going to accept.',
      locked: true,
    });
    expect(petBanner({ ...broken, streak: 2 }, SELF, 'Sam')?.locked).toBe(true);
    expect(petBanner({ ...broken, streak: 3 }, SELF, 'Sam')).toEqual({
      kind: 'invited',
      text: 'Sam wants to raise a Zekk Pet with you.',
    });
    // Our own waiting invite keeps its Cancel whatever the streak.
    expect(petBanner({ ...broken, pet: { ...invited, invitedBy: SELF } }, SELF, 'Sam')).toEqual({
      kind: 'waiting',
      text: 'Waiting for Sam to accept your Zekk Pet.',
    });
    const html = renderToStaticMarkup(
      createElement(PetInviteActions, { kind: 'invited', busy: null, onRun: () => {}, locked: true }),
    );
    expect(html).not.toContain('Accept');
    expect(html).toContain('Not now');
  });

  it('is gone once the egg is adopted, and before anything loaded', () => {
    expect(petBanner(state(pet()), SELF, 'Sam')).toBeNull();
    expect(petBanner(undefined, SELF, 'Sam')).toBeNull();
    expect(petBanner(state(null), undefined, 'Sam')).toBeNull();
  });

  it('can act unless the server says no (absent from older servers means yes)', () => {
    expect(petCanAct(undefined)).toBe(true);
    expect(petCanAct(state(null))).toBe(true);
    expect(petCanAct({ ...state(null), canAct: true })).toBe(true);
    expect(petCanAct({ ...state(null), canAct: false })).toBe(false);
  });

  it('hides Adopt and Accept without canAct, keeping Not now and Cancel', () => {
    const html = (kind: 'adopt' | 'waiting' | 'invited', canAct?: boolean) =>
      renderToStaticMarkup(createElement(PetInviteActions, { kind, busy: null, onRun: () => {}, canAct }));
    expect(html('invited')).toContain('Accept');
    expect(html('invited', false)).not.toContain('Accept');
    expect(html('invited', false)).toContain('Not now');
    expect(html('adopt')).toContain('Adopt');
    expect(html('adopt', false)).toBe('');
    expect(html('waiting', false)).toContain('Cancel');
  });

  it('hands focus on to the gear when it goes with focus on it', () => {
    // Accept / Not now / Cancel take the bar away (the pet is adopted, the
    // invite is gone), and the X hides it: focus must not drop to <body>.
    const body = { isConnected: true } as unknown as HTMLElement;
    const button = { isConnected: true } as unknown as HTMLElement;
    const composer = { isConnected: true } as unknown as HTMLElement;
    const bar = { contains: (n: Node | null) => n === (button as unknown as Node) };
    const doc = (activeElement: Element | null) => ({ activeElement, body: body as HTMLBodyElement });
    // Focus on one of its buttons, acting or not.
    expect(barHoldsFocus(bar, false, doc(button))).toBe(true);
    expect(barHoldsFocus(bar, true, doc(button))).toBe(true);
    // Its own action disabled the button, which already dropped focus.
    expect(barHoldsFocus(bar, true, doc(body))).toBe(true);
    expect(barHoldsFocus(bar, true, doc(null))).toBe(true);
    // The other person cancelled while the viewer typed: leave focus alone,
    // and don't pull it out of nowhere either.
    expect(barHoldsFocus(bar, false, doc(composer))).toBe(false);
    expect(barHoldsFocus(bar, true, doc(composer))).toBe(false);
    expect(barHoldsFocus(bar, false, doc(body))).toBe(false);
    // Already hidden (no bar on the page).
    expect(barHoldsFocus(null, true, doc(body))).toBe(false);

    // Wired up: a layout cleanup (it runs before React removes the bar),
    // the X, a failed action, and MessageView's gear as the target.
    const src = readFileSync(new URL('../src/app/ZekkPet.tsx', import.meta.url), 'utf8');
    expect(src).toMatch(
      /useLayoutEffect\(\s*\(\) => \(\) => \{\s*if \(!barHoldsFocus\(barRef\.current, busyRef\.current !== null\)\) return;/,
    );
    expect(src).toContain('ref={barRef}');
    expect(src).toMatch(/const hadFocus = barHoldsFocus\(barRef\.current, false\);\s*dismissPetBanner\(key\);\s*if \(hadFocus\) returnFocus\?\.\(\);/);
    expect(src).toContain('if (ran && !busy) refocusIfDropped(barButton(barRef.current, ran));');
    const view = readFileSync(new URL('../src/app/MessageView.tsx', import.meta.url), 'utf8');
    expect(view).toMatch(/<PetAdoptBanner[^>]*returnFocus=\{focusDmSettingsToggle\}/);
  });

  it('keeps focus on the button that was pressed, or on what is left of the bar', () => {
    // A stand-in for the bar: PetInviteActions' real buttons in order (with
    // their data-action), then the ✕, focusable against a fake document.
    type Btn = { text: string; action: string | null; isConnected: boolean; focus: () => void };
    const body = { isConnected: true } as unknown as HTMLElement;
    let active: unknown = body;
    const doc = () => ({ activeElement: active as Element, body: body as HTMLBodyElement });
    const bar = (props: { kind: 'adopt' | 'waiting' | 'invited'; canAct?: boolean; locked?: boolean }) => {
      const html =
        renderToStaticMarkup(createElement(PetInviteActions, { busy: null, onRun: () => {}, ...props })) +
        '<button type="button" aria-label="Dismiss"></button>';
      const buttons = [...html.matchAll(/<button([^>]*)>([^<]*)<\/button>/g)].map(([, attrs, text]) => {
        const b: Btn = {
          text: text || '✕',
          action: /data-action="(\w+)"/.exec(attrs)?.[1] ?? null,
          isConnected: true,
          focus: () => {
            active = b;
          },
        };
        return b;
      });
      const el = {
        buttons,
        contains: (n: Node | null) => buttons.includes(n as unknown as Btn),
        querySelector: (sel: string) => {
          const m = /^\[data-action="(\w+)"\]$/.exec(sel);
          return (m ? buttons.find((b) => b.action === m[1]) : sel === 'button' ? buttons[0] : undefined) ?? null;
        },
      };
      return el as typeof el & HTMLElement;
    };
    const text = () => (active === body ? '<body>' : (active as Btn).text);
    const press = (b: Btn) => {
      active = b;
    };

    // Their invite: Accept comes first, so "the first button" was Accept.
    const invited = bar({ kind: 'invited' });
    expect(invited.buttons.map((b) => [b.text, b.action])).toEqual([
      ['Accept', 'accept'],
      ['Not now', 'decline'],
      ['✕', null],
    ]);
    // Not now pressed with Enter; its disabled button dropped focus while the
    // request ran, and the decline failed (offline, a 5xx). Enter again to
    // retry must hit Not now again — not Accept, which can't be undone.
    press(invited.buttons[1]);
    active = body;
    refocusIfDropped(barButton(invited, 'decline'), doc());
    expect(text()).toBe('Not now');
    // The same for a failed Accept, Adopt or Cancel.
    active = body;
    refocusIfDropped(barButton(invited, 'accept'), doc());
    expect(text()).toBe('Accept');
    active = body;
    refocusIfDropped(barButton(bar({ kind: 'adopt' }), 'invite'), doc());
    expect(text()).toBe('Adopt');
    active = body;
    refocusIfDropped(barButton(bar({ kind: 'waiting' }), 'decline'), doc());
    expect(text()).toBe('Cancel');

    // The failed Accept (409: the streak broke just before the 00:00:05
    // refetch) put focus back on Accept, then the resync locks the invite
    // and Accept goes. React lets go of its ref before removing it, with
    // focus still on it: the bar notes that, and after the commit focus goes
    // to what is left (Not now), not <body>.
    const accept = invited.buttons[0];
    press(accept);
    let dropped = barHoldsFocus(invited, false, doc());
    expect(dropped).toBe(true);
    accept.isConnected = false;
    active = body;
    const locked = bar({ kind: 'invited', locked: true });
    if (dropped) refocusIfDropped(barButton(locked, null), doc());
    expect(text()).toBe('Not now');
    // Adopt hiding (canAct went off) leaves only the ✕.
    const adopt = bar({ kind: 'adopt' });
    press(adopt.buttons[0]);
    dropped = barHoldsFocus(adopt, false, doc());
    active = body;
    if (dropped) refocusIfDropped(barButton(bar({ kind: 'adopt', canAct: false }), null), doc());
    expect(text()).toBe('✕');
    // Focus that was already elsewhere (the viewer clicked into the message
    // list) isn't pulled into the bar when Accept hides.
    active = body;
    expect(barHoldsFocus(bar({ kind: 'invited' }), false, doc())).toBe(false);
    expect(text()).toBe('<body>');
    // Nothing to go back to once the bar is gone.
    expect(barButton(null, 'decline')).toBeNull();

    // Wired up: every action button carries its data-action and the bar's
    // ref; a detached button that had focus is noted, and a layout effect
    // moves focus to the first button left.
    const src = readFileSync(new URL('../src/app/ZekkPet.tsx', import.meta.url), 'utf8');
    expect(src.match(/ref=\{buttonRef\}\s*type="button"\s*data-action="(invite|accept|decline)"/g)).toHaveLength(4);
    expect(src).toContain('buttonRef={watchButton}');
    expect(src).toContain('if (!el && barHoldsFocus(barRef.current, false)) droppedFocus.current = true;');
    expect(src).toMatch(
      /useLayoutEffect\(\(\) => \{\s*if \(!droppedFocus\.current\) return;\s*droppedFocus\.current = false;\s*refocusIfDropped\(barButton\(barRef\.current, null\)\);\s*\}\);/,
    );
  });

  it('forgets dismissed bars when the signed-in account changes', () => {
    // Two people sharing a tab: A hides the adopt bar and signs out; B signs
    // in without a reload and must still see it.
    let notified = 0;
    const off = subscribePetBannerDismissals(() => notified++);
    try {
      dismissPetBanner('9:adopt');
      expect(isPetBannerDismissed('9:adopt')).toBe(true);
      expect(isPetBannerDismissed('9:invited')).toBe(false);
      expect(notified).toBe(1);
      clearPetBannerDismissals();
      expect(isPetBannerDismissed('9:adopt')).toBe(false);
      expect(notified).toBe(2);
    } finally {
      off();
      clearPetBannerDismissals();
    }
    // AppState clears them next to its sign-out / account-switch RESET.
    const appState = readFileSync(new URL('../src/state/AppState.tsx', import.meta.url), 'utf8');
    expect(appState).toMatch(/dispatch\(\{ type: 'RESET' \}\);\s*(\/\/[^\n]*\n\s*)*clearPetBannerDismissals\(\);/);
  });
});

describe('in-chat notices', () => {
  const base = { petName: 'Mochi', stage: 'baby' as PetStage, peerName: 'Sam' };
  const mine = { ...base, actorIsSelf: true, actorName: null };
  const theirs = { ...base, actorIsSelf: false, actorName: 'Sam' };

  it('says "You" for the viewer and the name otherwise', () => {
    expect(petNoticeText({ ...mine, event: 'invited' })).toBe('You want to raise a Zekk Pet together. 🥚');
    expect(petNoticeText({ ...theirs, event: 'invited' })).toBe('Sam wants to raise a Zekk Pet together. 🥚');
    expect(petNoticeText({ ...mine, event: 'renamed' })).toBe('You renamed the pet to Mochi.');
    expect(petNoticeText({ ...theirs, event: 'renamed' })).toBe('Sam renamed the pet to Mochi.');
  });

  it('names both people on adoption, the viewer first', () => {
    expect(petNoticeText({ ...mine, event: 'adopted' })).toBe('You and Sam adopted a Zekk Pet! 🥚');
    expect(petNoticeText({ ...theirs, event: 'adopted' })).toBe('You and Sam adopted a Zekk Pet! 🥚');
  });

  it('builds the pet events', () => {
    const sweep = { ...base, actorIsSelf: false, actorName: null };
    expect(petNoticeText({ ...sweep, event: 'hatched' })).toBe('Mochi hatched! 🐣');
    expect(petNoticeText({ ...sweep, event: 'evolved', stage: 'kid' })).toBe('Mochi grew into a Kid!');
    expect(petNoticeText({ ...sweep, event: 'evolved', stage: 'adult' })).toBe('Mochi grew into an Adult!');
    expect(petNoticeText({ ...sweep, event: 'evolved', stage: 'legendary' })).toBe('Mochi grew into a Legendary!');
    expect(petNoticeText({ ...sweep, event: 'asleep' })).toBe(
      'Mochi fell asleep. 😴 Say hi to each other within 2 days to wake it up.',
    );
    expect(petNoticeText({ ...sweep, event: 'awake' })).toBe('Mochi woke up! 🎉');
    expect(petNoticeText({ ...sweep, event: 'ran_away' })).toBe(
      'Mochi ran away. Keep a 3-day streak to adopt a new one.',
    );
  });

  it('leaves unknown events and actorless actor events to the fallback content', () => {
    expect(petNoticeText({ ...theirs, event: 'danced' })).toBeNull();
    expect(petNoticeText({ ...base, actorIsSelf: false, actorName: null, event: 'renamed' })).toBeNull();
  });

  it('recognises the row and picks its glyph', () => {
    expect(isPetNotice({ type: 'system_pet' })).toBe(true);
    expect(isPetNotice({ type: 'default', metadata: { kind: 'pet' } })).toBe(true);
    expect(isPetNotice({ type: 'system_disappearing', metadata: { kind: 'disappearing_timer' } })).toBe(false);
    expect(petNoticeArt({ event: 'asleep', stage: 'kid' })).toEqual({ stage: 'kid', mood: 'asleep' });
    expect(petNoticeArt({ event: 'ran_away', stage: 'teen' })).toEqual({ stage: 'teen', mood: 'lonely' });
    expect(petNoticeArt({ event: 'adopted', stage: 'egg' })).toEqual({ stage: 'egg', mood: 'happy' });
  });
});

describe('clock-driven refetch', () => {
  it('refetches an Adopt / Accept bar at midnight UTC, when a streak can break', () => {
    expect(nextUtcMidnightRefreshAt(Date.parse('2026-11-11T09:00:00Z'))).toBe(Date.parse('2026-11-12T00:00:05Z'));
    expect(nextUtcMidnightRefreshAt(Date.parse('2026-11-11T23:59:59Z'))).toBe(Date.parse('2026-11-12T00:00:05Z'));
    // A re-render inside the slack keeps the pending timer…
    expect(nextUtcMidnightRefreshAt(Date.parse('2026-11-12T00:00:02Z'))).toBe(Date.parse('2026-11-12T00:00:05Z'));
    // …and once it has fired the next midnight takes over (no refetch loop).
    expect(nextUtcMidnightRefreshAt(Date.parse('2026-11-12T00:00:05Z'))).toBe(Date.parse('2026-11-13T00:00:05Z'));
    // Month and year ends roll over.
    expect(nextUtcMidnightRefreshAt(Date.parse('2026-12-31T12:00:00Z'))).toBe(Date.parse('2027-01-01T00:00:05Z'));
    // In server time: a device 30 s fast (offset −30 s) at its 00:00:10 is
    // server 23:59:40, so it still waits for the server's midnight.
    const offset = -30_000;
    const device = Date.parse('2026-11-12T00:00:10Z');
    const at = nextUtcMidnightRefreshAt(serverNow(offset, device));
    expect(at).toBe(Date.parse('2026-11-12T00:00:05Z'));
    expect(timeoutUntil(at, offset, device)).toBeGreaterThanOrEqual(25_000);
  });

  const p = pet({ today: '2026-11-11', dayEndsAt: '2026-11-12T00:00:00.000Z' });
  it('wakes at 18:00 UTC, then at midnight UTC', () => {
    expect(petNextRefreshAt(p, Date.parse('2026-11-11T09:00:00Z'))).toBe(Date.parse('2026-11-11T18:00:05Z'));
    expect(petNextRefreshAt(p, Date.parse('2026-11-11T19:00:00Z'))).toBe(Date.parse('2026-11-12T00:00:05Z'));
    expect(petNextRefreshAt(p, Date.parse('2026-11-12T01:00:00Z'))).toBeNull();
  });

  it('keeps a boundary through its slack, so a re-render then keeps the timer', () => {
    // A re-render at 18:00:02 must not drop the 18:00:05 refetch for midnight.
    expect(petNextRefreshAt(p, Date.parse('2026-11-11T18:00:02Z'))).toBe(Date.parse('2026-11-11T18:00:05Z'));
    // At 00:00:02 the DTO still says yesterday: the midnight refetch stands.
    expect(petNextRefreshAt(p, Date.parse('2026-11-12T00:00:02Z'))).toBe(Date.parse('2026-11-12T00:00:05Z'));
    // Once the timer has fired the next boundary takes over (no refetch loop).
    expect(petNextRefreshAt(p, Date.parse('2026-11-11T18:00:05Z'))).toBe(Date.parse('2026-11-12T00:00:05Z'));
    expect(petNextRefreshAt(p, Date.parse('2026-11-12T00:00:05Z'))).toBeNull();
  });

  it('counts in server time, so a fast device clock still waits for the server', () => {
    // The device runs 30 s ahead of the server (offset −30 s), as MessageView
    // schedules it: serverNow for the boundary, timeoutUntil for the delay.
    const offset = -30_000;
    const device = (iso: string) => Date.parse(iso);
    // Device 00:00:05 is server 23:59:35: midnight is still ahead, 30 s out.
    const atMidnight = petNextRefreshAt(p, serverNow(offset, device('2026-11-12T00:00:05Z')));
    expect(atMidnight).toBe(Date.parse('2026-11-12T00:00:05Z'));
    const wait = timeoutUntil(atMidnight!, offset, device('2026-11-12T00:00:05Z'));
    expect(wait).toBeGreaterThanOrEqual(30_000);
    expect(wait).toBeLessThan(31_000);
    // The same at 18:00: device 18:00:05 is server 17:59:35.
    expect(petNextRefreshAt(p, serverNow(offset, device('2026-11-11T18:00:05Z')))).toBe(
      Date.parse('2026-11-11T18:00:05Z'),
    );
  });
});

// ── Art ─────────────────────────────────────────────────────────────────

const STAGES: PetStage[] = ['egg', 'baby', 'kid', 'teen', 'adult', 'legendary'];
const MOODS: PetMood[] = ['thriving', 'happy', 'lonely', 'hungry', 'grumpy', 'asleep'];
const ORDER = ['wing', 'arm', 'foot', 'body', 'belly', 'antenna', 'face', 'crown', 'sparkle', 'zzz'];

const parts = (shapes: PetShape[]) => shapes.map((s) => s.part);

describe('art: stages', () => {
  it('has the body, belly and eyes of each stage', () => {
    const g = (s: PetStage) => petGeometry(s);
    expect(g('egg').body).toEqual({ cx: 50, cy: 56, rx: 26, ry: 32 });
    expect(g('egg').eyes).toBeNull();
    expect([g('baby').body, g('baby').belly, g('baby').eyes]).toEqual([
      { cx: 50, cy: 60, rx: 24, ry: 22 },
      { cx: 50, cy: 66, rx: 14, ry: 10 },
      { ex1: 41, ex2: 59, ey: 56, er: 4.5 },
    ]);
    expect([g('kid').body, g('kid').belly, g('kid').eyes]).toEqual([
      { cx: 50, cy: 58, rx: 27, ry: 25 },
      { cx: 50, cy: 65, rx: 16, ry: 11 },
      { ex1: 40, ex2: 60, ey: 54, er: 5 },
    ]);
    expect([g('teen').body, g('teen').belly, g('teen').eyes]).toEqual([
      { cx: 50, cy: 56, rx: 28, ry: 29 },
      { cx: 50, cy: 64, rx: 17, ry: 13 },
      { ex1: 40, ex2: 60, ey: 51, er: 5.5 },
    ]);
    for (const s of ['adult', 'legendary'] as PetStage[]) {
      expect([g(s).body, g(s).belly, g(s).eyes]).toEqual([
        { cx: 50, cy: 55, rx: 31, ry: 31 },
        { cx: 50, cy: 64, rx: 19, ry: 14 },
        { ex1: 39, ex2: 61, ey: 50, er: 6 },
      ]);
    }
  });

  it('grows feet, arms, wings and antennae on schedule', () => {
    const count = (s: PetStage) => {
      const g = petGeometry(s);
      return [g.feet.length, g.arms.length, g.wings.length, g.antennae.length, g.crown ? 1 : 0, g.sparkles.length];
    };
    expect(count('egg')).toEqual([0, 0, 0, 0, 0, 0]);
    expect(count('baby')).toEqual([0, 0, 0, 1, 0, 0]);
    expect(count('kid')).toEqual([2, 0, 0, 1, 0, 0]);
    expect(count('teen')).toEqual([2, 2, 0, 2, 0, 0]);
    expect(count('adult')).toEqual([2, 2, 2, 2, 0, 0]);
    expect(count('legendary')).toEqual([2, 2, 2, 0, 1, 4]);
    expect(petGeometry('teen').arms.map((a) => a.rotate)).toEqual([-20, 20]);
    expect(petGeometry('adult').wings).toEqual([
      { cx: 24, cy: 42, rx: 12, ry: 7, rotate: -30 },
      { cx: 76, cy: 42, rx: 12, ry: 7, rotate: 30 },
    ]);
    expect(petGeometry('kid').antennae[0]).toEqual({ from: [50, 33], to: [50, 21], tip: [50, 18], tipShape: 'star' });
    expect(petGeometry('legendary').sparkles).toEqual([
      { x: 14, y: 24, r: 5 },
      { x: 86, y: 30, r: 4 },
      { x: 82, y: 78, r: 3.5 },
      { x: 16, y: 72, r: 3 },
    ]);
  });

  it('draws back to front: wings, arms, feet, body, belly, antennae, face, extras', () => {
    for (const stage of STAGES.slice(1)) {
      for (const mood of MOODS) {
        const ps = parts(petShapes({ stage, mood }));
        // The thriving sparkles belong to its face; everything else is in order.
        const ranks = ps.filter((p) => !(mood === 'thriving' && p === 'sparkle')).map((p) => ORDER.indexOf(p));
        expect(ranks.every((r) => r >= 0)).toBe(true);
        expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
      }
    }
  });

  it('draws the egg with spots and a crack from 80% of the level', () => {
    expect(parts(petShapes({ stage: 'egg', mood: 'happy', progress: 0.5 }))).toEqual(['body', 'spot', 'spot', 'spot']);
    const cracked = petShapes({ stage: 'egg', mood: 'happy', progress: 0.8 });
    expect(cracked.at(-1)).toMatchObject({
      tag: 'polyline',
      part: 'crack',
      attrs: { points: '30,52 38,46 45,54 53,46 60,54 70,48', strokeWidth: 2, stroke: PET_COLORS.outline },
    });
    // No face on the egg, whatever the mood.
    expect(parts(petShapes({ stage: 'egg', mood: 'asleep' }))).toEqual(['body', 'spot', 'spot', 'spot']);
    expect(petShapes({ stage: 'egg', mood: 'happy' })[0]!.attrs).toMatchObject({
      fill: PET_COLORS.belly,
      stroke: PET_COLORS.outline,
      strokeWidth: 2.5,
    });
  });

  it('puts the crown and sparkles on the legendary and no antennae', () => {
    const shapes = petShapes({ stage: 'legendary', mood: 'happy' });
    expect(shapes.some((s) => s.part === 'antenna')).toBe(false);
    expect(shapes.find((s) => s.part === 'crown')?.attrs).toEqual({
      points: '36,24 40,12 46,20 50,8 54,20 60,12 64,24',
      fill: PET_INK.gold,
      stroke: PET_INK.goldDark,
      strokeWidth: 1.5,
      strokeLinejoin: 'round',
    });
    expect(shapes.filter((s) => s.part === 'sparkle')).toHaveLength(4);
  });

  it('rotates limbs about their own centre', () => {
    const arm = petShapes({ stage: 'adult', mood: 'happy' }).find((s) => s.part === 'arm')!;
    expect(arm.attrs).toMatchObject({ cx: 19, cy: 58, rx: 6, ry: 10, transform: 'rotate(-20 19 58)' });
  });

  it('builds stars, sparkles and Zs from their centre / corner', () => {
    const star = starPoints(50, 18, 5, 2.2);
    expect(star).toHaveLength(10);
    expect(star[0]).toEqual([50, 13]);
    expect(Math.hypot(star[1]![0] - 50, star[1]![1] - 18)).toBeCloseTo(2.2, 2);
    const sp = sparklePoints(14, 24, 5);
    expect([sp[0], sp[2], sp[4], sp[6]]).toEqual([
      [14, 19],
      [19, 24],
      [14, 29],
      [9, 24],
    ]);
    expect(zPoints(84, 8, 10)).toEqual([
      [84, 8],
      [94, 8],
      [84, 18],
      [94, 18],
    ]);
  });
});

describe('art: faces', () => {
  const eyes = { ex1: 40, ex2: 60, ey: 54, er: 5 }; // kid: sc = 1, my = 66

  it('happy: round eyes with highlights, a smile and cheeks', () => {
    const f = petFaceShapes(eyes, 'happy');
    expect(f.filter((s) => s.tag === 'circle' && s.attrs.fill === PET_INK.eye).map((s) => [s.attrs.cx, s.attrs.cy, s.attrs.r])).toEqual([
      [40, 54, 5],
      [60, 54, 5],
    ]);
    expect(f.filter((s) => s.attrs.fill === PET_INK.highlight).map((s) => [s.attrs.cx, s.attrs.cy, s.attrs.r])).toEqual([
      [38.25, 52.25, 1.75],
      [58.25, 52.25, 1.75],
    ]);
    expect(f.find((s) => s.tag === 'path')?.attrs.d).toBe('M42 66 Q50 73 58 66');
    expect(f.filter((s) => s.attrs.fill === PET_INK.cheek).map((s) => [s.attrs.cx, s.attrs.cy, s.attrs.r, s.attrs.opacity])).toEqual([
      [36, 61, 4, 0.7],
      [64, 61, 4, 0.7],
    ]);
  });

  it('thriving: ^ ^ eyes, an open smile and two sparkles', () => {
    const f = petFaceShapes(eyes, 'thriving');
    const paths = f.filter((s) => s.tag === 'path').map((s) => s.attrs.d);
    expect(paths).toEqual(['M35 55 Q40 49 45 55', 'M55 55 Q60 49 65 55', 'M41 66 A9 7 0 0 0 59 66 Z']);
    expect(f.filter((s) => s.part === 'sparkle')).toHaveLength(2);
  });

  it('lonely: eyes a unit lower, a frown and a tear', () => {
    const f = petFaceShapes(eyes, 'lonely');
    expect(f.filter((s) => s.attrs.fill === PET_INK.eye).map((s) => s.attrs.cy)).toEqual([55, 55]);
    expect(f.find((s) => s.tag === 'path')?.attrs.d).toBe('M44 69 Q50 63 56 69');
    expect(f.find((s) => s.attrs.fill === PET_INK.tear)?.attrs).toMatchObject({ cx: 63, cy: 62, rx: 2, ry: 3 });
  });

  it('hungry: an open mouth and a drool drop', () => {
    const f = petFaceShapes(eyes, 'hungry');
    expect(f.find((s) => s.attrs.fill === PET_INK.mouth)?.attrs).toMatchObject({ cx: 50, cy: 67, rx: 5, ry: 6 });
    expect(f.find((s) => s.attrs.fill === PET_INK.tear)?.attrs).toMatchObject({ cx: 54, cy: 73, rx: 1.5, ry: 2.5 });
  });

  it('grumpy: slanted brows and a flat frown', () => {
    const paths = petFaceShapes(eyes, 'grumpy').filter((s) => s.tag === 'path').map((s) => s.attrs.d);
    expect(paths).toEqual(['M34 45 L45 48', 'M66 45 L55 48', 'M43 68 Q50 64 57 68']);
  });

  it('asleep: closed eyes, an "o" mouth and three Zs', () => {
    const f = petFaceShapes(eyes, 'asleep');
    expect(f.filter((s) => s.tag === 'path').map((s) => s.attrs.d)).toEqual(['M35 54 Q40 59 45 54', 'M55 54 Q60 59 65 54']);
    expect(f.find((s) => s.tag === 'circle')?.attrs).toMatchObject({ cx: 50, cy: 67, r: 2, fill: PET_INK.mouth });
    const zs = petShapes({ stage: 'kid', mood: 'asleep' }).filter((s) => s.part === 'zzz');
    expect(zs.map((s) => s.attrs.points)).toEqual([
      '74,26 80,26 74,32 80,32',
      '80,14 88,14 80,22 88,22',
      '88,2 98,2 88,12 98,12',
    ]);
    expect(zs.every((s) => s.attrs.strokeWidth === 2 && s.attrs.stroke === PET_COLORS.belly)).toBe(true);
  });

  it('scales the face with the eye size', () => {
    // baby: er 4.5 → sc 0.9, my = 56 + 10.8.
    const f = petFaceShapes(petGeometry('baby').eyes!, 'happy');
    expect(f.find((s) => s.tag === 'path')?.attrs.d).toBe('M42.8 66.8 Q50 73.1 57.2 66.8');
  });

  it('strokes every face line 2.5 wide with round caps', () => {
    for (const mood of MOODS) {
      for (const s of petFaceShapes(eyes, mood)) {
        if (s.attrs.fill !== 'none') continue;
        expect(s.attrs).toMatchObject({ strokeWidth: 2.5, strokeLinecap: 'round', stroke: PET_INK.eye });
      }
    }
  });
});

describe('art: colours follow the theme', () => {
  // The cross-platform table: theme accent / second colour → body, belly,
  // outline, antenna tips.
  const TABLE: Record<string, [string, string, string, string]> = {
    default: ['#3DD7EC', '#A8EDF6', '#18565E', '#9D7BFF'],
    sunset: ['#FF8A3D', '#FFCAA8', '#663718', '#FFD13D'],
    forest: ['#3D9BFF', '#A8D2FF', '#183E66', '#4FDD8F'],
    crimson: ['#FF4D4D', '#FFAFAF', '#661F1F', '#9AA3B8'],
    blossom: ['#FF5FA2', '#FFB7D5', '#662641', '#FFB088'],
    amethyst: ['#A855F7', '#D8B3FB', '#432263', '#F5B942'],
  };
  const css = readFileSync(new URL('../src/index.css', import.meta.url), 'utf8');
  const hex = (channels: string) =>
    '#' +
    channels
      .trim()
      .split(/\s+/)
      .map((c) => Number(c).toString(16).padStart(2, '0'))
      .join('')
      .toUpperCase();
  /** --c-accent / --c-accent-2 of a theme (the default lives on :root). */
  function accents(theme: string): [string, string] {
    const block =
      theme === 'default'
        ? css.slice(css.indexOf(':root {'))
        : css.slice(css.indexOf(`[data-theme='${theme}'],\n[data-theme='${theme}-oled'] {`));
    const a1 = /--c-accent:\s*([\d ]+);/.exec(block)![1]!;
    const a2 = /--c-accent-2:\s*([\d ]+);/.exec(block)![1]!;
    return [hex(a1), hex(a2)];
  }

  it('mixes like color-mix in sRGB', () => {
    for (const [theme, [body, belly, outline, accent]] of Object.entries(TABLE)) {
      const [a1, a2] = accents(theme);
      expect(petColorsForAccents(a1, a2)).toEqual({ body, belly, outline, accent });
    }
  });

  it('defines the CSS properties the art uses', () => {
    expect(css).toContain('--zk-pet-body: rgb(var(--c-accent));');
    expect(css).toContain('--zk-pet-belly: color-mix(in srgb, rgb(var(--c-accent)) 45%, white);');
    expect(css).toContain('--zk-pet-outline: color-mix(in srgb, rgb(var(--c-accent)) 40%, black);');
    expect(css).toContain('--zk-pet-accent: rgb(var(--c-accent-2));');
    const body = petShapes({ stage: 'teen', mood: 'happy' }).find((s) => s.part === 'body')!;
    expect(body.attrs).toMatchObject({ fill: PET_COLORS.body, stroke: PET_COLORS.outline });
    const tip = petShapes({ stage: 'teen', mood: 'happy' }).filter((s) => s.part === 'antenna')[1]!;
    expect(tip.attrs).toMatchObject({ cx: 35, cy: 14, r: 4, fill: PET_COLORS.accent });
  });

  it('turns motion off for reduced-motion users', () => {
    expect(css).toMatch(/prefers-reduced-motion: reduce\)\s*\{\s*\.zk-pet-bob,\s*\.zk-pet-breathe,\s*\.zk-pet-wobble/);
  });

  it('still shows the tap heart under reduced motion, fading in place', () => {
    // The global reduced-motion rule cuts every animation to 0.01 ms, which
    // left the heart (fill-mode forwards) invisible at once: a tap showed
    // nothing. The pet's own rule must win (!important on a class beats `*`)
    // and keep HEART_MS.
    const block = css.slice(css.indexOf('@keyframes zk-pet-heart-fade'));
    expect(block).toMatch(/@keyframes zk-pet-heart-fade \{\s*from \{ opacity: 1; \}\s*to \{ opacity: 0; \}/);
    expect(block).toMatch(
      /prefers-reduced-motion: reduce\)\s*\{[^@]*\.zk-pet-heart \{\s*animation: zk-pet-heart-fade 0\.8s ease-out forwards !important;/,
    );
    const modal = readFileSync(new URL('../src/app/ZekkPetModal.tsx', import.meta.url), 'utf8');
    expect(modal).toContain('const HEART_MS = 800;');
  });
});

describe('art: motion and the rendered SVG', () => {
  it('bobs, breathes asleep and wobbles as an egg', () => {
    expect(petMotion('kid', 'happy')).toBe('bob');
    expect(petMotion('kid', 'asleep')).toBe('breathe');
    expect(petMotion('egg', 'hungry')).toBe('wobble');
    expect(petMotion('egg', 'asleep')).toBe('breathe');
  });

  it('builds the tap heart from two circles and a triangle', () => {
    expect(petHeartShapes().map((s) => s.tag)).toEqual(['circle', 'circle', 'polygon']);
    expect(petHeartShapes().every((s) => s.attrs.fill === PET_INK.heart)).toBe(true);
  });

  it('renders every stage × mood to clean, in-box SVG', () => {
    for (const stage of STAGES) {
      for (const mood of MOODS) {
        const html = renderToStaticMarkup(createElement(ZekkPetArt, { stage, mood, size: 28, progress: 0.9 }));
        expect(html.startsWith('<svg')).toBe(true);
        expect(html).toContain('viewBox="0 0 100 100"');
        expect(html).not.toMatch(/NaN|undefined|Infinity/);
        // Colours go through style (var() doesn't work in presentation attributes).
        expect(html).not.toMatch(/ fill="var\(/);
        const shapes = petShapes({ stage, mood, progress: 0.9 });
        expect((html.match(/<(ellipse|circle|path|polygon|polyline|line)\b/g) ?? []).length).toBe(shapes.length);
        // Every coordinate stays inside the 100-unit box (the namespace URL
        // and the colours aside).
        const geometry = html.replace(/xmlns="[^"]*"/, '').replace(/style="[^"]*"/g, '');
        for (const n of geometry.match(/-?\d+(\.\d+)?/g)!.map(Number)) expect(Math.abs(n)).toBeLessThanOrEqual(100);
        expect(html).toContain(`zk-pet-${petMotion(stage, mood)}`);
      }
    }
  });

  it('sits still when asked, and draws the tap hearts', () => {
    const still = renderToStaticMarkup(createElement(ZekkPetArt, { stage: 'adult', mood: 'happy', size: 16, animated: false }));
    expect(still).not.toContain('zk-pet-bob');
    expect(still).toContain('aria-hidden="true"');
    const tapped = renderToStaticMarkup(
      createElement(ZekkPetArt, { stage: 'adult', mood: 'happy', size: 140, squash: 2, hearts: [1, 2], title: 'Pet Zekk' }),
    );
    expect(tapped).toContain('zk-pet-squash');
    expect(tapped.match(/zk-pet-heart/g)).toHaveLength(2);
    expect(tapped).toContain('role="img"');
    expect(tapped).toContain('aria-label="Pet Zekk"');
  });
});

describe('pet card', () => {
  it('keeps the asleep Zs on its stage at the breathe and squash peaks', () => {
    // ZekkPetModal's stage: w-44 (11rem at the 15px root = 165px), rounded-2xl
    // (1rem = 15px), a 1px border, the art 140px and centred. A disc that
    // size cut the top Z, whose corner of the art lies outside it.
    const modal = readFileSync(new URL('../src/app/ZekkPetModal.tsx', import.meta.url), 'utf8');
    expect(modal).toContain('w-44 h-44 shrink-0 rounded-2xl border');
    expect(modal).toContain('size={140}');
    const box = 165;
    const art = 140;
    const origin = (box - art) / 2;
    const k = art / 100;
    // Breathe (1.03) and the tap squash (1.04 × 0.94) inside it, both about
    // (50, 88); the Zs' stroke is 2 units with round caps.
    const scales: Array<[number, number]> = [[1, 1], [1.03, 1.03], [1.03 * 1.04, 1.03 * 0.94]];
    const margin = 1 + 1 * 1.03 * 1.04 * k;
    const inRoundedSquare = (x: number, y: number, r: number) => {
      const qx = Math.min(Math.max(x, r), box - r);
      const qy = Math.min(Math.max(y, r), box - r);
      return Math.hypot(x - qx, y - qy) <= r - margin;
    };
    const zs = petShapes({ stage: 'legendary', mood: 'asleep' }).filter((s) => s.part === 'zzz');
    expect(zs).toHaveLength(3);
    let fitsDisc = true;
    for (const z of zs) {
      const pts = String(z.attrs.points).split(' ').map((xy) => xy.split(',').map(Number) as [number, number]);
      for (const [x, y] of pts) {
        for (const [sx, sy] of scales) {
          const px = origin + k * (50 + sx * (x - 50));
          const py = origin + k * (88 + sy * (y - 88));
          expect(inRoundedSquare(px, py, 15)).toBe(true);
          if (!inRoundedSquare(px, py, box / 2)) fitsDisc = false;
        }
      }
    }
    expect(fitsDisc).toBe(false);
  });

  it('gives focus back to the opener, or to the fallback once the opener is gone', () => {
    // Cancel / Not now in the card removes the header pet that opened it.
    const calls: string[] = [];
    const el = (isConnected: boolean) => ({ isConnected, focus: () => calls.push(`opener:${isConnected}`) });
    const fallback = () => calls.push('fallback');
    restoreFocus(el(true) as unknown as HTMLElement, fallback);
    restoreFocus(el(false) as unknown as HTMLElement, fallback);
    restoreFocus(null, fallback);
    restoreFocus(el(false) as unknown as HTMLElement, undefined);
    expect(calls).toEqual(['opener:true', 'fallback', 'fallback']);
  });

  it('keeps focus in the open card when the focused control goes away', () => {
    // Saving or cancelling a rename unmounts the field, and Accept swaps the
    // invite view for the card: focus falls to <body> while the card stays
    // open. It goes to the pencil / the dialog then — and only then.
    const calls: string[] = [];
    const body = { isConnected: true } as unknown as HTMLElement;
    const target = { focus: () => calls.push('target') } as unknown as HTMLElement;
    const other = { isConnected: true } as unknown as HTMLElement;
    const gone = { isConnected: false } as unknown as HTMLElement;
    refocusIfDropped(target, { activeElement: body, body: body as HTMLBodyElement });
    refocusIfDropped(target, { activeElement: null, body: body as HTMLBodyElement });
    refocusIfDropped(target, { activeElement: gone, body: body as HTMLBodyElement });
    expect(calls).toEqual(['target', 'target', 'target']);
    // Focus still on something real (the ✕, the pet): leave it there.
    refocusIfDropped(target, { activeElement: other, body: body as HTMLBodyElement });
    refocusIfDropped(null, { activeElement: body, body: body as HTMLBodyElement });
    expect(calls).toHaveLength(3);
    // The card wires it to the rename pencil (or the name), the name input
    // after a failed save, and the dialog after the invite view goes.
    const modal = readFileSync(new URL('../src/app/ZekkPetModal.tsx', import.meta.url), 'utf8');
    expect(modal).toContain('refocusIfDropped(pencilRef.current ?? nameRef.current)');
    expect(modal).toContain('refocusIfDropped(inputRef.current)');
    expect(modal).toMatch(/lastStatus\.current === 'invited' && status && status !== 'invited'\) refocusIfDropped\(dialogRef\.current\)/);
    expect(modal).toContain('aria-describedby={hintId}');
  });
});

// ── State ───────────────────────────────────────────────────────────────

describe('AppState pet map', () => {
  type Action = Parameters<typeof appStateReducer>[1];
  const run = (...actions: Action[]) => actions.reduce((s, a) => appStateReducer(s, a), initialAppState);

  it('starts with no pets and the feature off', () => {
    expect(initialAppState.dmPets).toEqual({});
    expect(initialAppState.zekkPetEnabled).toBe(false);
    const on = run({ type: 'ZEKK_PET_FEATURE_SET', enabled: true });
    expect(on.zekkPetEnabled).toBe(true);
    // Same value → same state object (no re-render).
    expect(appStateReducer(on, { type: 'ZEKK_PET_FEATURE_SET', enabled: true })).toBe(on);
  });

  it('stores the fetch, then the live pet keeps the eligibility', () => {
    const s = run(
      { type: 'DM_PET_STATE_SET', channelId: '9', petState: { pet: null, eligible: true, streak: 4, minStreak: 3 } },
      { type: 'DM_PET_SET', channelId: '9', pet: pet({ status: 'invited' }) },
    );
    expect(s.dmPets['9']).toMatchObject({ eligible: true, streak: 4, pet: { status: 'invited' } });
  });

  it('keeps a newer pet over a stale fetch, but takes its streak', () => {
    const s = run(
      { type: 'DM_PET_SET', channelId: '9', pet: pet({ level: 3 }) },
      {
        type: 'DM_PET_STATE_SET',
        channelId: '9',
        petState: { pet: pet({ level: 2 }), eligible: false, streak: 8, minStreak: 3 },
        keepPet: true,
      },
    );
    expect(s.dmPets['9']!.pet!.level).toBe(3);
    expect(s.dmPets['9']!.streak).toBe(8);
  });

  it('assumes "not eligible" for a live update before any fetch', () => {
    const s = run({ type: 'DM_PET_SET', channelId: '9', pet: null });
    expect(s.dmPets['9']).toEqual({ pet: null, eligible: false, streak: 0, minStreak: 3 });
  });

  it('takes an invite that arrives before any fetch as acceptable until the fetch says', () => {
    // An invite needs a 3-day streak to be sent, so opening the DM doesn't
    // flash "keep a streak going" in place of Accept while getDmPet runs.
    const invite = pet({ status: 'invited', level: 0, stage: 'egg', tasks: [], invitedBy: PEER });
    const s = run({ type: 'DM_PET_SET', channelId: '9', pet: invite });
    expect(s.dmPets['9']).toMatchObject({ eligible: false, streak: 3, minStreak: 3 });
    expect(petBanner(s.dmPets['9'], SELF, 'Sam')).toEqual({
      kind: 'invited',
      text: 'Sam wants to raise a Zekk Pet with you.',
    });
    // The fetch is the truth: the streak broke.
    const after = appStateReducer(s, {
      type: 'DM_PET_STATE_SET',
      channelId: '9',
      petState: { pet: invite, eligible: false, streak: 0, minStreak: 3 },
    });
    expect(petBanner(after.dmPets['9'], SELF, 'Sam')?.locked).toBe(true);
  });

  it('works out the eligibility again when the pet went away during the first fetch', () => {
    // Opening the DM fetches; Sam cancels his invite before the answer,
    // which still saw it (so "not eligible", as with any pet). The event
    // lands first, then the stale answer: the Adopt bar must show.
    const invite = pet({ status: 'invited', level: 0, stage: 'egg', tasks: [], invitedBy: PEER });
    const stale = (extra: Partial<DmPetState> = {}): Action => ({
      type: 'DM_PET_STATE_SET',
      channelId: '9',
      petState: { pet: invite, eligible: false, streak: 5, minStreak: 3, canAct: true, ...extra },
      keepPet: true,
    });
    const gone: Action = { type: 'DM_PET_SET', channelId: '9', pet: null };
    const s = run(gone, stale());
    expect(s.dmPets['9']).toMatchObject({ pet: null, eligible: true, streak: 5 });
    expect(petBanner(s.dmPets['9'], SELF, 'Sam')).toEqual({
      kind: 'adopt',
      text: '🥚 5-day streak! Adopt a Zekk Pet with Sam.',
    });
    // Same gates as the server: a live streak of the minimum, and canAct
    // (absent from older servers means yes).
    expect(run(gone, stale({ streak: 2 })).dmPets['9']!.eligible).toBe(false);
    expect(run(gone, stale({ streak: 0 })).dmPets['9']!.eligible).toBe(false);
    expect(run(gone, stale({ canAct: false })).dmPets['9']!.eligible).toBe(false);
    expect(run(gone, stale({ canAct: undefined })).dmPets['9']!.eligible).toBe(true);
    // A fresh answer (not raced) is taken as it is.
    const fresh = run(gone, { ...stale(), keepPet: false } as Action);
    expect(fresh.dmPets['9']).toMatchObject({ pet: { status: 'invited' }, eligible: false });
    // And a raced answer that also saw no pet keeps the server's word.
    const none = run(gone, {
      type: 'DM_PET_STATE_SET',
      channelId: '9',
      petState: { pet: null, eligible: false, streak: 5, minStreak: 3, canAct: true },
      keepPet: true,
    });
    expect(none.dmPets['9']!.eligible).toBe(false);
  });

  it("re-reads the pet of a DM with someone the viewer blocks or unblocks", () => {
    // Blocking Sam turns canAct off (Adopt, Accept and Rename would 404),
    // unblocking turns it back on, and no pet event says so.
    const dm = (id: string, type: 'dm' | 'group_dm', ...peers: string[]) =>
      ({ id, type, recipients: peers.map((p) => ({ id: p })) }) as unknown as Channel;
    const loaded: DmPetState = { pet: null, eligible: true, streak: 5, minStreak: 3, canAct: true };
    const state = {
      zekkPetEnabled: true,
      dmChannels: [dm('9', 'dm', PEER), dm('8', 'dm', '300'), dm('7', 'group_dm', PEER, '300'), dm('6', 'dm', PEER)],
      dmPets: { '9': loaded, '8': loaded, '7': loaded },
    };
    // Only 1:1 DMs with them whose pet has loaded ('6' fetches when it opens).
    expect(petDmIdsWithUser(state, PEER)).toEqual(['9']);
    expect(petDmIdsWithUser(state, '300')).toEqual(['8']);
    expect(petDmIdsWithUser(state, '400')).toEqual([]);
    expect(petDmIdsWithUser({ ...state, zekkPetEnabled: false }, PEER)).toEqual([]);
    expect(petDmIdsWithUser({ ...state, dmChannels: [dm('9', 'dm')] }, PEER)).toEqual([]);

    // Wired into applyRelationship (block, unblock, friend changes) and the
    // supervision event; the card re-reads when it opens.
    const appState = readFileSync(new URL('../src/state/AppState.tsx', import.meta.url), 'utf8');
    expect(appState).toMatch(
      /const applyRelationship = useCallback\([\s\S]*?for \(const channelId of petDmIdsWithUser\(stateRef\.current, user\.id\)\) \{\s*void loadDmPet\(channelId\)\.catch\(\(\) => undefined\);\s*\}\s*\},\s*\[loadDmPet\],/,
    );
    expect(appState).toMatch(
      /FAMILY_SUPERVISION_UPDATE, \(\) => \{[\s\S]*?openChannelId in fresh\.dmPets\) \{\s*void loadDmPet\(openChannelId\)/,
    );
    // Declared after loadDmPet, which its deps read.
    expect(appState.indexOf('const applyRelationship = useCallback')).toBeGreaterThan(
      appState.indexOf('const loadDmPet = useCallback'),
    );
    const modal = readFileSync(new URL('../src/app/ZekkPetModal.tsx', import.meta.url), 'utf8');
    expect(modal).toMatch(/useEffect\(\(\) => \{\s*void loadDmPet\(channelId\)\.catch\(\(\) => undefined\);\s*\}, \[channelId, loadDmPet\]\);/);
  });
});

// ── Notices vs. unread ──────────────────────────────────────────────────
// The server never bumps channels.last_message_id or anyone's read marker for
// a 'system_pet' row: a notice never makes the DM unread, never reorders the
// DM list, and never marks the other person's messages read.

describe('pet notices and unread', () => {
  type State = typeof initialAppState;
  type Action = Parameters<typeof appStateReducer>[1];
  const run = (state: State, ...actions: Action[]) => actions.reduce((s, a) => appStateReducer(s, a), state);
  const CH = '900';
  const dm = (id: string, lastMessageId: string) =>
    ({ id, type: 'dm', lastMessageId }) as unknown as State['dmChannels'][number];

  function row(id: string, authorId: string, extra: Partial<Message> = {}): Message {
    return {
      id,
      channelId: CH,
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
      createdAt: '2026-11-12T00:05:00.000Z',
      ...extra,
    } as Message;
  }
  // The sweep posts 'asleep' in user A's name, caused by no one.
  const notice = (id: string, authorId: string, actorId: string | null = null) =>
    row(id, authorId, {
      type: 'system_pet',
      content: 'Zekk fell asleep.',
      metadata: { kind: 'pet', event: 'asleep', petName: 'Zekk', stage: 'baby', actorId },
    });
  const channelOf = (s: State) => s.dmChannels.find((c) => c.id === CH)!;

  // We (SELF, user A) last read 90; the peer's 'hey' (100) is unread, 3 mentions.
  function setup(): State {
    return run(
      initialAppState,
      { type: 'DMS_SET', channels: [dm('800', '500'), dm(CH, '100')] },
      { type: 'READ_STATES_SET', readStates: [{ channelId: CH, lastMessageId: '90', mentionCount: 3 }] },
      { type: 'MESSAGES_SET', channelId: CH, messages: [row('90', SELF), row('100', PEER)] },
    );
  }

  it('a sweep notice in our name keeps the DM unread and its mentions, and opening it still acks', () => {
    const s0 = setup();
    const n = notice('200', SELF);
    // The gateway handler's own-message branch moves no marker for it…
    expect(ownEchoReadState(n, SELF)).toBeNull();
    const s1 = run(s0, { type: 'MESSAGE_APPEND', channelId: CH, message: n });
    // …the row is added, the DM's recency stays where the server keeps it…
    expect(s1.messagesByChannel[CH]!.map((m) => m.id)).toEqual(['90', '100', '200']);
    expect(s1.dmChannels).toBe(s0.dmChannels);
    expect(channelOf(s1).lastMessageId).toBe('100');
    // …so 'hey' still reads unread, with its mentions.
    expect(isChannelUnread(channelOf(s1), s1.readStateByChannel)).toBe(true);
    expect(channelMentionCount(CH, s1.readStateByChannel)).toBe(3);
    // Opening the DM acks the newest loaded row, the notice included.
    const plan = planReadAck({
      isDm: true,
      newest: newestConfirmedId(s1.messagesByChannel[CH]!)!,
      marker: s1.readStateByChannel[CH]!.lastMessageId,
      lastSent: undefined,
      unstartedTimer: false,
      channelLast: channelOf(s1).lastMessageId,
      lastProbe: undefined,
    });
    expect(plan).toEqual({ ack: '200', probe: null });
    const s2 = run(s1, { type: 'READ_STATE_UPSERT', readState: { channelId: CH, lastMessageId: '200', mentionCount: 0 } });
    expect(isChannelUnread(channelOf(s2), s2.readStateByChannel)).toBe(false);
  });

  it('deleting the newest real message rolls the DM back past a newer notice, as the server does', () => {
    const s0 = run(setup(), { type: 'MESSAGE_APPEND', channelId: CH, message: notice('200', SELF) });
    expect(channelOf(s0).lastMessageId).toBe('100');
    // 'hey' (100) is deleted: the watermark goes to 90, not to the notice.
    const s1 = run(s0, { type: 'MESSAGE_REMOVE', channelId: CH, messageId: '100' });
    expect(s1.messagesByChannel[CH]!.map((m) => m.id)).toEqual(['90', '200']);
    expect(channelOf(s1).lastMessageId).toBe('90');
    expect(isChannelUnread(channelOf(s1), s1.readStateByChannel)).toBe(false);
  });

  it('a notice we caused moves no marker either; our own messages still do', () => {
    expect(ownEchoReadState(notice('200', SELF, SELF), SELF)).toBeNull();
    expect(ownEchoReadState(row('300', SELF), SELF)).toEqual({ channelId: CH, lastMessageId: '300', mentionCount: 0 });
    expect(ownEchoReadState(row('300', PEER), SELF)).toBeNull();
    expect(ownEchoReadState(row('local-1', SELF), SELF)).toBeNull();
  });

  it("the other person's notice doesn't make a read DM unread or move it up the list", () => {
    const s0 = run(setup(), {
      type: 'READ_STATE_UPSERT',
      readState: { channelId: CH, lastMessageId: '100', mentionCount: 0 },
    });
    const s1 = run(s0, { type: 'MESSAGE_APPEND', channelId: CH, message: notice('200', PEER, PEER) });
    expect(s1.messagesByChannel[CH]!.map((m) => m.id)).toContain('200');
    expect(s1.dmChannels).toBe(s0.dmChannels);
    expect(isChannelUnread(channelOf(s1), s1.readStateByChannel)).toBe(false);
    // A real message after it still bumps as before.
    const s2 = run(s1, { type: 'MESSAGE_APPEND', channelId: CH, message: row('210', PEER) });
    expect(channelOf(s2).lastMessageId).toBe('210');
    expect(isChannelUnread(channelOf(s2), s2.readStateByChannel)).toBe(true);
  });

  it('a gap-fill page bumps recency to its newest row that is not a notice', () => {
    // A jump window ending at 100 leaves the tail gapped from there.
    const s0 = run(
      initialAppState,
      { type: 'DMS_SET', channels: [dm(CH, '100')] },
      { type: 'READ_STATES_SET', readStates: [{ channelId: CH, lastMessageId: '100', mentionCount: 0 }] },
      { type: 'MESSAGES_SET', channelId: CH, messages: [row('90', SELF), row('100', PEER)], preserveNewerSurvivors: false },
    );
    expect(s0.tailGapped.has(CH)).toBe(true);
    // Only a notice in the page: rows merged, recency untouched.
    const s1 = run(s0, { type: 'MESSAGES_MERGE', channelId: CH, messages: [notice('200', SELF)], from: '100' });
    expect(s1.messagesByChannel[CH]!.map((m) => m.id)).toEqual(['90', '100', '200']);
    expect(s1.dmChannels).toBe(s0.dmChannels);
    expect(isChannelUnread(channelOf(s1), s1.readStateByChannel)).toBe(false);
    // A message, then a notice: recency moves to the message only.
    const s2 = run(s0, {
      type: 'MESSAGES_MERGE',
      channelId: CH,
      messages: [row('150', PEER), notice('200', SELF)],
      from: '100',
    });
    expect(channelOf(s2).lastMessageId).toBe('150');
  });

  // The chat's scroll: an own append follows the viewer down, someone
  // else's raises the 'New messages' pill when scrolled up.
  describe('scroll on append', () => {
    const peerMsg = (id: string) => row(id, PEER, { author: { id: PEER } as Message['author'] });
    const ownMsg = (id: string) => row(id, SELF, { author: { id: SELF } as Message['author'] });
    const sweep = (id: string) => ({ ...notice(id, SELF), author: { id: SELF } as Message['author'] });
    const caused = (id: string, actor: string) => ({
      ...notice(id, actor, actor),
      author: { id: actor } as Message['author'],
    });

    it("a sweep notice in our name neither pulls us down nor raises the pill", () => {
      expect(appendScrollKind([ownMsg('90'), peerMsg('100'), sweep('200')], '100', SELF)).toBe('quiet');
      // The peer, scrolled up, gets no pill for it either.
      expect(appendScrollKind([ownMsg('90'), peerMsg('100'), sweep('200')], '100', PEER)).toBe('quiet');
    });

    it('a notice we caused follows us down; the other person\'s is quiet', () => {
      expect(appendScrollKind([peerMsg('100'), caused('200', SELF)], '100', SELF)).toBe('own');
      expect(appendScrollKind([peerMsg('100'), caused('200', PEER)], '100', SELF)).toBe('quiet');
    });

    it('messages behave as before', () => {
      expect(appendScrollKind([peerMsg('100'), ownMsg('110')], '100', SELF)).toBe('own');
      expect(appendScrollKind([ownMsg('100'), peerMsg('110')], '100', SELF)).toBe('other');
    });

    it('a message that lands with a notice in the same render still raises the pill', () => {
      // The peer's send hatched the pet: both rows arrive before one render.
      expect(appendScrollKind([ownMsg('90'), peerMsg('100'), caused('110', PEER)], '90', SELF)).toBe('other');
      // A gone previous tail (a confirmed local send) falls back to "any message".
      expect(appendScrollKind([peerMsg('100'), sweep('200')], 'local-1', SELF)).toBe('other');
    });
  });

  // "Blocked message — click to show" goes by whose row it is. PEER is the
  // person the viewer blocked, and the sweep's author (user A).
  describe('blocked-author mask', () => {
    const by = (m: Message, id: string) => ({ ...m, author: { id } as Message['author'] });

    it("the daily check's notices are no one's, so they always show", () => {
      // Authored by user A with no actor: masking them would show B, who
      // blocked A, the pet's news as a hidden message from A.
      expect(blockSubjectId(by(notice('200', PEER), PEER))).toBeNull();
      const ranAway = row('201', PEER, {
        type: 'system_pet',
        metadata: { kind: 'pet', event: 'ran_away', petName: 'Zekk', stage: 'baby', actorId: null },
      });
      expect(blockSubjectId(by(ranAway, PEER))).toBeNull();
    });

    it("a notice the peer caused is theirs, like their messages", () => {
      expect(blockSubjectId(by(notice('200', PEER, PEER), PEER))).toBe(PEER);
      expect(blockSubjectId(by(row('100', PEER), PEER))).toBe(PEER);
    });

    it('a notice without its metadata falls back to its author', () => {
      expect(blockSubjectId(by({ ...notice('200', PEER), metadata: null }, PEER))).toBe(PEER);
      expect(blockSubjectId(row('100', PEER))).toBeNull();
    });
  });
});
