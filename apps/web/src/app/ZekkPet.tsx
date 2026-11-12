/**
 * Zekk Pet — DM header pieces
 * ---------------------------
 * The pet two people raise in a 1:1 DM by keeping their streak going. This
 * file holds what MessageView mounts in the conversation header:
 *
 *   - DmPetButton: the small pet next to the streak pill (an egg while the
 *     invite is open, the asleep face when asleep). Opens the pet card.
 *   - PetAdoptBanner: the slim bar under the header — "Adopt" when the DM
 *     may adopt, "Cancel" on our open invite, "Accept" / "Not now" on theirs.
 *     Dismissible for the session (per DM and per kind of bar, so hiding the
 *     adopt prompt doesn't also hide a later invite; cleared on sign-out —
 *     lib/petBannerDismissals).
 *   - PetInviteActions + usePetActions: the bar's buttons, reused by the pet
 *     card (ZekkPetModal) while the invite is pending.
 *
 * Everything shown comes from the server (state.dmPets); the words come from
 * lib/zekkPet so the web reads like the native apps.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ApiError, type PetDTO } from '@zekktris/client';
import { ZekkPetArt } from '../lib/ZekkPetArt';
import { X } from '../lib/icons';
import { dismissPetBanner, usePetBannerDismissed } from '../lib/petBannerDismissals';
import {
  petArtProgress,
  petCanAct,
  petDisplayName,
  petMoodView,
  type PetBanner,
  type PetBannerKind,
} from '../lib/zekkPet';
import { useAppStateSelector, type DmPetChange } from '../state/AppState';
import { useToasts } from '../state/Toasts';

/** The pet's name as the viewer sees it: masked for a supervised child with
    the profanity filter on (petDisplayName). Wherever the name is shown;
    only the rename field keeps the real name, since it edits it. */
export function usePetDisplayName(name: string): string {
  const filterProfanity = useAppStateSelector(
    (v) => v.state.supervision?.restrictions?.filterProfanity ?? false,
  );
  return petDisplayName(name, filterProfanity);
}

/** The header pet. Same 28 px as the DM avatar, on the theme's chip surface. */
export function DmPetButton({ pet, onOpen }: { pet: PetDTO; onOpen: () => void }) {
  const mood = petMoodView(pet);
  const name = usePetDisplayName(pet.name);
  const label =
    pet.status === 'invited' ? `Zekk Pet: ${name} (invite pending)` : `Zekk Pet: ${name}, ${mood.label}`;
  return (
    <button
      type="button"
      onClick={onOpen}
      className="relative shrink-0 self-center w-[30px] h-[30px] flex items-center justify-center rounded-md border border-line bg-bg-2 hover:bg-bg-3 transition-colors"
      title={label}
      aria-label={label}
    >
      <ZekkPetArt
        stage={pet.status === 'invited' ? 'egg' : pet.stage}
        mood={pet.mood}
        progress={petArtProgress(pet)}
        size={28}
      />
    </button>
  );
}

// ── Focus ────────────────────────────────────────────────────────────────

/** The focused control left the card or the bar while it stays (the rename
    field closed, the invite view became the pet card, the buttons were
    disabled while an action ran): focus fell to <body>, so put it on
    `target`. Left alone when focus is still somewhere on the page. */
export function refocusIfDropped(
  target: HTMLElement | null,
  doc: Pick<Document, 'activeElement' | 'body'> = document,
): void {
  const active = doc.activeElement;
  if (active && active !== doc.body && active.isConnected) return;
  target?.focus();
}

/** The adopt bar is going away (Accept adopted the pet, Not now / Cancel
    ended the invite): does it take the viewer's focus with it? Yes when
    focus is on one of its controls — or, while one of its own actions runs,
    when focus is nowhere, since the disabled buttons may already have
    dropped it to <body>. Focus somewhere else on the page is left alone. */
export function barHoldsFocus(
  bar: Pick<HTMLElement, 'contains'> | null,
  acting: boolean,
  doc: Pick<Document, 'activeElement' | 'body'> = document,
): boolean {
  if (!bar) return false;
  const active = doc.activeElement;
  if (active && bar.contains(active)) return true;
  return acting && (!active || active === doc.body || !active.isConnected);
}

/** Where focus goes back to in the bar: the button for `action` (its
    data-action — the one the viewer pressed, so retrying a failed "Not now"
    with Enter doesn't land on Accept), else the first button left (Not now
    once Accept hid, or the ✕ when nothing else is). */
export function barButton(
  bar: Pick<HTMLElement, 'querySelector'> | null,
  action: DmPetChange['kind'] | null,
): HTMLElement | null {
  if (!bar) return null;
  return (
    (action ? bar.querySelector<HTMLElement>(`[data-action="${action}"]`) : null) ??
    bar.querySelector<HTMLElement>('button')
  );
}

// ── Actions ──────────────────────────────────────────────────────────────

const FAILED: Record<DmPetChange['kind'], string> = {
  invite: "Couldn't send the invite.",
  accept: "Couldn't adopt the pet.",
  decline: "Couldn't answer the invite.",
  rename: "Couldn't rename the pet.",
};

/** Run a pet change with one-at-a-time busy state and an error toast.
    Resolves true when the server took it. */
export function usePetActions(channelId: string) {
  const changeDmPet = useAppStateSelector((v) => v.changeDmPet);
  const toasts = useToasts();
  const [busy, setBusy] = useState<DmPetChange['kind'] | null>(null);
  const busyRef = useRef(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const run = useCallback(
    async (change: DmPetChange): Promise<boolean> => {
      if (busyRef.current) return false;
      busyRef.current = true;
      setBusy(change.kind);
      try {
        await changeDmPet(channelId, change);
        return true;
      } catch (e) {
        toasts.push(e instanceof ApiError ? e.message : FAILED[change.kind], 'error');
        return false;
      } finally {
        busyRef.current = false;
        if (mountedRef.current) setBusy(null);
      }
    },
    [channelId, changeDmPet, toasts],
  );
  return { busy, run };
}

const PRIMARY =
  'shrink-0 px-3 py-1 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-wait text-white text-xs font-medium transition-colors';
const SECONDARY =
  'shrink-0 px-3 py-1 rounded-md border border-line text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-50 disabled:cursor-wait text-xs font-medium transition-colors';

/** [Adopt] · [Cancel] · [Accept] [Not now] — "Not now" declines the invite
    (no notice for either person); the inviter can invite again later.
    Without `canAct` (a block, a mute, supervision, or the other person left)
    Adopt and Accept hide: they would only fail. So does Accept on a
    `locked` invite (the streak is under the minimum: PetBanner.locked).
    Each button names its change in data-action (barButton). */
export function PetInviteActions({
  kind,
  busy,
  onRun,
  canAct = true,
  locked = false,
  buttonRef,
}: {
  kind: PetBannerKind;
  busy: DmPetChange['kind'] | null;
  onRun: (change: DmPetChange) => void;
  canAct?: boolean;
  locked?: boolean;
  /** Set on every button: React calls it with null just before it removes one. */
  buttonRef?: (el: HTMLButtonElement | null) => void;
}) {
  if (kind === 'adopt') {
    if (!canAct) return null;
    return (
      <button
        ref={buttonRef}
        type="button"
        data-action="invite"
        className={PRIMARY}
        disabled={busy !== null}
        onClick={() => onRun({ kind: 'invite' })}
      >
        {busy === 'invite' ? 'Inviting…' : 'Adopt'}
      </button>
    );
  }
  if (kind === 'waiting') {
    return (
      <button
        ref={buttonRef}
        type="button"
        data-action="decline"
        className={SECONDARY}
        disabled={busy !== null}
        onClick={() => onRun({ kind: 'decline' })}
      >
        {busy === 'decline' ? 'Cancelling…' : 'Cancel'}
      </button>
    );
  }
  return (
    <>
      {canAct && !locked && (
        <button
          ref={buttonRef}
          type="button"
          data-action="accept"
          className={PRIMARY}
          disabled={busy !== null}
          onClick={() => onRun({ kind: 'accept' })}
        >
          {busy === 'accept' ? 'Accepting…' : 'Accept'}
        </button>
      )}
      <button
        ref={buttonRef}
        type="button"
        data-action="decline"
        className={SECONDARY}
        disabled={busy !== null}
        onClick={() => onRun({ kind: 'decline' })}
      >
        Not now
      </button>
    </>
  );
}

/** The slim bar under the DM header. MessageView keys it by channel so a
    switch never carries a pending action over to another DM. */
export function PetAdoptBanner({
  channelId,
  banner,
  returnFocus,
}: {
  channelId: string;
  banner: PetBanner;
  /** Focuses something that stays on the page, for when the bar goes away
      with focus on one of its buttons. */
  returnFocus?: () => void;
}) {
  const key = `${channelId}:${banner.kind}`;
  const hidden = usePetBannerDismissed(key);
  const { busy, run } = usePetActions(channelId);
  const canAct = useAppStateSelector((v) => petCanAct(v.state.dmPets[channelId]));

  // Accept, Not now and Cancel take the whole bar away (MessageView stops
  // rendering it), and the focused button with it. A layout cleanup runs
  // before React removes the bar, so it still sees where focus is. Read
  // through refs: the cleanup must see the latest callback and busy state.
  const barRef = useRef<HTMLDivElement | null>(null);
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  useLayoutEffect(
    () => () => {
      if (!barHoldsFocus(barRef.current, busyRef.current !== null)) return;
      const f = returnFocusRef.current;
      queueMicrotask(() => f?.());
    },
    [],
  );
  // A failed action keeps the bar, but its buttons were disabled while it
  // ran, which can drop focus: it goes back to the button that was pressed.
  const wasBusy = useRef(busy);
  useEffect(() => {
    const ran = wasBusy.current;
    wasBusy.current = busy;
    if (ran && !busy) refocusIfDropped(barButton(barRef.current, ran));
  }, [busy]);
  // Accept / Adopt hide while the bar stays (the invite locked, canAct went
  // off), and a bar of another kind swaps its buttons: a button going with
  // focus on it drops focus to <body>. React lets go of a button's ref just
  // before removing it, while focus is still there, so note it then and move
  // focus to the first button left once the commit is done. Focus that was
  // already elsewhere (or nowhere) is left alone.
  const droppedFocus = useRef(false);
  const watchButton = useCallback((el: HTMLButtonElement | null) => {
    if (!el && barHoldsFocus(barRef.current, false)) droppedFocus.current = true;
  }, []);
  useLayoutEffect(() => {
    if (!droppedFocus.current) return;
    droppedFocus.current = false;
    refocusIfDropped(barButton(barRef.current, null));
  });

  if (hidden) return null;
  return (
    <div
      ref={barRef}
      role="status"
      className="px-4 py-1.5 border-b bg-bg-2/60 flex items-center gap-2 text-sm"
      style={{ borderBottomColor: 'var(--zk-line-soft)' }}
    >
      <span className="flex-1 min-w-0 text-ink-2 leading-snug">{banner.text}</span>
      <PetInviteActions
        kind={banner.kind}
        busy={busy}
        canAct={canAct}
        locked={banner.locked}
        onRun={(c) => void run(c)}
        buttonRef={watchButton}
      />
      <button
        type="button"
        onClick={() => {
          // Hiding keeps the bar mounted, so the cleanup above doesn't run.
          const hadFocus = barHoldsFocus(barRef.current, false);
          dismissPetBanner(key);
          if (hadFocus) returnFocus?.();
        }}
        className="shrink-0 -mr-1 w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 transition-colors"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
