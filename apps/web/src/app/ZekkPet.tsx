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
 *     adopt prompt doesn't also hide a later invite).
 *   - PetInviteActions + usePetActions: the bar's buttons, reused by the pet
 *     card (ZekkPetModal) while the invite is pending.
 *
 * Everything shown comes from the server (state.dmPets); the words come from
 * lib/zekkPet so the web reads like the native apps.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ApiError, type PetDTO } from '@zekktris/client';
import { ZekkPetArt } from '../lib/ZekkPetArt';
import { X } from '../lib/icons';
import { petArtProgress, petMoodView, type PetBanner, type PetBannerKind } from '../lib/zekkPet';
import { useAppStateSelector, type DmPetChange } from '../state/AppState';
import { useToasts } from '../state/Toasts';

/** The header pet. Same 28 px as the DM avatar, on the theme's chip surface. */
export function DmPetButton({ pet, onOpen }: { pet: PetDTO; onOpen: () => void }) {
  const mood = petMoodView(pet);
  const label =
    pet.status === 'invited' ? `Zekk Pet: ${pet.name} (invite pending)` : `Zekk Pet: ${pet.name}, ${mood.label}`;
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

// ── Session dismissal ────────────────────────────────────────────────────
// A dismissed bar stays hidden until the app reloads — per DM and per kind.

const dismissed = new Set<string>();
const dismissListeners = new Set<() => void>();

function subscribeDismissed(cb: () => void) {
  dismissListeners.add(cb);
  return () => {
    dismissListeners.delete(cb);
  };
}

function dismissBanner(key: string) {
  dismissed.add(key);
  for (const cb of dismissListeners) cb();
}

function useBannerDismissed(key: string): boolean {
  return useSyncExternalStore(
    subscribeDismissed,
    () => dismissed.has(key),
    () => dismissed.has(key),
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
    (no notice for either person); the inviter can invite again later. */
export function PetInviteActions({
  kind,
  busy,
  onRun,
}: {
  kind: PetBannerKind;
  busy: DmPetChange['kind'] | null;
  onRun: (change: DmPetChange) => void;
}) {
  if (kind === 'adopt') {
    return (
      <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => onRun({ kind: 'invite' })}>
        {busy === 'invite' ? 'Inviting…' : 'Adopt'}
      </button>
    );
  }
  if (kind === 'waiting') {
    return (
      <button type="button" className={SECONDARY} disabled={busy !== null} onClick={() => onRun({ kind: 'decline' })}>
        {busy === 'decline' ? 'Cancelling…' : 'Cancel'}
      </button>
    );
  }
  return (
    <>
      <button type="button" className={PRIMARY} disabled={busy !== null} onClick={() => onRun({ kind: 'accept' })}>
        {busy === 'accept' ? 'Accepting…' : 'Accept'}
      </button>
      <button type="button" className={SECONDARY} disabled={busy !== null} onClick={() => onRun({ kind: 'decline' })}>
        Not now
      </button>
    </>
  );
}

/** The slim bar under the DM header. MessageView keys it by channel so a
    switch never carries a pending action over to another DM. */
export function PetAdoptBanner({ channelId, banner }: { channelId: string; banner: PetBanner }) {
  const key = `${channelId}:${banner.kind}`;
  const hidden = useBannerDismissed(key);
  const { busy, run } = usePetActions(channelId);
  if (hidden) return null;
  return (
    <div
      role="status"
      className="px-4 py-1.5 border-b bg-bg-2/60 flex items-center gap-2 text-sm"
      style={{ borderBottomColor: 'var(--zk-line-soft)' }}
    >
      <span className="flex-1 min-w-0 text-ink-2 leading-snug">{banner.text}</span>
      <PetInviteActions kind={banner.kind} busy={busy} onRun={(c) => void run(c)} />
      <button
        type="button"
        onClick={() => dismissBanner(key)}
        className="shrink-0 -mr-1 w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 transition-colors"
        aria-label="Dismiss"
        title="Dismiss"
      >
        <X size={14} />
      </button>
    </div>
  );
}
