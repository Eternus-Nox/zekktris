/**
 * ZekkPetModal
 * ------------
 * The pet card for a 1:1 DM's Zekk Pet. Full screen on mobile, floating on
 * desktop (the house modal shell + ModalHeader, like the Disappearing
 * Messages screen):
 *
 *   ✕  Zekk Pet
 *   (the big animated pet — tap it for a heart)
 *   Zekk ✎
 *   Level 3 · Baby
 *   [Happy — Fed for today. Keep chatting to earn more points.]
 *   ▓▓▓▓░░ 20/35 to level 4
 *   Today's care: ✓ Both say hi +10 · ○ 10 messages each 4/10 · 7/10 +10 …
 *   Egg → Baby → Kid → Teen → Adult → Legendary
 *
 * While the invite is open it shows the egg and the banner's actions
 * instead. Everything comes from the server (state.dmPets, live through
 * DM_PET_UPDATE); renaming validates with the shared normalizePetName before
 * it's sent. Closes by itself when the pet goes away (declined, cancelled,
 * ran away).
 *
 * Opened from the bar's Adopt on a server with pet colours (`adopt`), it is
 * the egg picker instead — there is no pet yet. Laid out like iOS's compact
 * sheet (ZekkPetEggPicker): up from the bottom on a phone, a small card on
 * desktop, with no header bar:
 *
 *   Pick an egg
 *   You'll both see this egg.
 *   (six eggs, one per colour, the viewer's theme picked first)
 *   [     Cancel     ] [  Send invite   ]
 *
 * Send invite runs the invite with the pick. The picker is for an Adopt on
 * offer, so, as on iOS and Android, it closes once the invite has gone out
 * (the bar under the header then says "Waiting for Sam to accept…") and
 * whenever Adopt goes away under it (they invited first, the streak broke
 * at midnight UTC, a block). While the invite is on its way it can't be
 * closed: the answer lands in it.
 *
 * Hosted by MessageView, which closes it on a channel switch.
 */

import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type Ref } from 'react';
import {
  PET_COLOR_IDS,
  PET_NAME_MAX_LENGTH,
  PET_PALETTES,
  normalizePetName,
  resolvePetColor,
  type PetColorId,
  type PetDTO,
} from '@zekktris/client';
import { Portal } from '../lib/Portal';
import { ModalHeader } from '../lib/ModalHeader';
import { Check, ChevronRight, Edit, X } from '../lib/icons';
import { ZekkPetArt } from '../lib/ZekkPetArt';
import { getStoredTheme } from '../lib/theme';
import {
  petAdoptOffered,
  petArtProgress,
  petBanner,
  petCanAct,
  petColorForTheme,
  petLevelLine,
  petLevelProgress,
  petMoodView,
  petOwnInviteOut,
  petPickErrorForToast,
  petStagePath,
  petTaskRows,
} from '../lib/zekkPet';
import { useAppStateSelector } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { PetInviteActions, refocusIfDropped, usePetActions, usePetDisplayName } from './ZekkPet';

/** How long one tap heart floats (matches zk-pet-heart in index.css). */
const HEART_MS = 800;

/** The egg picker's shell, iOS's compact sheet: as tall as its content, on
    the sheet's bg2, up from the bottom on a phone (above the home
    indicator) and a small floating card from sm up. */
const PICKER_SHEET =
  'bg-bg-2 border-t sm:border border-line shadow-xl w-full max-h-[90vh] overflow-y-auto scrollbar-thin rounded-t-2xl sm:rounded-lg sm:max-w-sm px-4 pt-5 pb-[calc(env(safe-area-inset-bottom)+1rem)] sm:pb-4 outline-none';

/** Focus back to the card's opener, or — when it has left the page (the
    header chip goes with a withdrawn invite or a pet that ran away) — to the
    host's fallback, so focus doesn't drop to <body>. */
export function restoreFocus(opener: HTMLElement | null, fallback: (() => void) | undefined): void {
  if (opener?.isConnected) opener.focus();
  else fallback?.();
}

export function ZekkPetModal({
  channelId,
  peerName,
  selfId,
  onClose,
  returnFocus,
  adopt = false,
}: {
  channelId: string;
  /** The other person (their DM nickname when set). */
  peerName: string;
  selfId: string;
  onClose: () => void;
  /** Focuses something that stays on the page, for when the opener is gone. */
  returnFocus?: () => void;
  /** Opened by the bar's Adopt: the egg picker. */
  adopt?: boolean;
}) {
  const petState = useAppStateSelector((v) => v.state.dmPets[channelId]);
  const pet = petState?.pet ?? null;
  // Re-read on open: whether Accept and Rename may run (canAct) also changes
  // with things this client never hears about — the other person blocking,
  // a mute, their supervision.
  const loadDmPet = useAppStateSelector((v) => v.loadDmPet);
  useEffect(() => {
    void loadDmPet(channelId).catch(() => undefined);
  }, [channelId, loadDmPet]);
  const { busy, run } = usePetActions(channelId);
  const toasts = useToasts();
  const [editing, setEditing] = useState(false);
  const canAct = petCanAct(petState);
  // A block or the other person leaving mid-rename hides the field; drop the
  // edit too, so Escape closes the card instead of cancelling a hidden field.
  useEffect(() => {
    if (!canAct) setEditing(false);
  }, [canAct]);

  // The egg picker (opened by Adopt). While its invite is on its way it
  // can't be closed — Cancel, Escape and the backdrop wait, as on iOS and
  // Android — since the answer lands in it.
  const showPicker = adopt;
  const sending = showPicker && busy !== null;
  // First pick: the viewer's own theme family. Only a starting point — the
  // pet keeps whichever egg is sent, the same for both people.
  const [picked, setPicked] = useState<PetColorId>(() => petColorForTheme(getStoredTheme()));
  // Why the last send failed, and when. A toast would sit under the
  // picker's backdrop, so it says why inside itself.
  const [pickError, setPickError] = useState<{ message: string; at: number } | null>(null);
  const pickErrorRef = useRef(pickError);
  pickErrorRef.current = pickError;
  const pickerCaptionId = useId();
  // Whether the card is still up. An invite can be answered after the
  // picker has closed (Adopt went away mid-request): its failure then goes
  // to the toast, and its success mustn't close what's open by then.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);
  // Our own invite is out (petOwnInviteOut): then no failure explains Adopt
  // going away. Read through a ref by a failure that lands after closing.
  const ownInviteOut = petOwnInviteOut(petState, selfId);
  const ownInviteOutRef = useRef(ownInviteOut);
  ownInviteOutRef.current = ownInviteOut;

  // Nothing left to show: the invite was declined / cancelled / expired or
  // the pet ran away (from here or anywhere else). Not the picker: there is
  // no pet until its invite goes out, and it goes by the rule below.
  useEffect(() => {
    if (!showPicker && petState && !pet) onClose();
  }, [showPicker, petState, pet, onClose]);

  // The picker is for an Adopt on offer, so it closes once that goes away
  // under it (petAdoptOffered), as on iOS and Android — the invite went
  // out, they invited first, the streak broke, a block. A send that failed
  // just before is why (the resync after its 409), so its reason goes to
  // the toast the closing picker uncovers; not when our own invite is what
  // took Adopt away (its request failed, the invite didn't).
  const adoptOffered = petAdoptOffered(petState, selfId);
  useEffect(() => {
    if (!showPicker || adoptOffered) return;
    const why = petPickErrorForToast(pickErrorRef.current, Date.now(), ownInviteOut);
    if (why) toasts.push(why, 'error');
    onClose();
  }, [showPicker, adoptOffered, ownInviteOut, onClose, toasts]);

  // Focus moves into the card and back to whatever opened it. A callback
  // ref, because Portal mounts the card a render after this component.
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  // Read through a ref: the cleanup below must see the latest callback.
  const returnFocusRef = useRef(returnFocus);
  returnFocusRef.current = returnFocus;
  useEffect(() => () => restoreFocus(openerRef.current, returnFocusRef.current), []);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const focusDialog = useCallback((el: HTMLDivElement | null) => {
    dialogRef.current = el;
    el?.focus();
  }, []);
  // The invite view turning into the pet card (Accept here, or the other
  // person accepting ours) takes the focused button with it.
  const status = pet?.status;
  const lastStatus = useRef(status);
  useEffect(() => {
    if (lastStatus.current === 'invited' && status && status !== 'invited') refocusIfDropped(dialogRef.current);
    lastStatus.current = status;
  }, [status]);
  // The same when an Accept / Not now / Cancel / Send invite failed: the
  // view stays, but its buttons were disabled while it ran, which drops
  // focus — back to Send invite in the picker (Enter retries), else the card.
  const sendRef = useRef<HTMLButtonElement | null>(null);
  const wasBusy = useRef(busy);
  useEffect(() => {
    if (wasBusy.current && !busy) refocusIfDropped(sendRef.current ?? dialogRef.current);
    wasBusy.current = busy;
  }, [busy]);

  // Escape: out of the rename field first, then close (not while the
  // picker's invite is on its way). The field cancels its own Escape and
  // marks it handled (preventDefault). React may already have re-rendered
  // this listener with editing=false by the time that event gets to window,
  // so a handled Escape must not close the card as well.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (editing) setEditing(false);
      else if (!sending) onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, sending, onClose]);

  const banner = petBanner(petState, selfId, peerName);
  const title = showPicker ? 'Pick an egg' : 'Zekk Pet';

  return (
    <Portal>
      <div
        className={`fixed inset-0 bg-black/60 z-50 flex justify-center sm:items-center sm:p-4 ${
          showPicker ? 'items-end' : 'items-stretch'
        }`}
        onClick={sending ? undefined : onClose}
      >
        <div
          ref={focusDialog}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label={title}
          aria-describedby={showPicker ? pickerCaptionId : undefined}
          className={
            showPicker
              ? PICKER_SHEET
              : 'bg-bg-1 border border-line shadow-xl w-full overflow-hidden flex flex-col h-full sm:h-auto sm:rounded-lg sm:max-w-md sm:max-h-[85vh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0 outline-none'
          }
          onClick={(e) => e.stopPropagation()}
        >
          {showPicker ? (
            <PetEggPicker
              picked={picked}
              onPick={(color) => {
                setPicked(color);
                setPickError(null);
              }}
              busy={sending}
              error={pickError?.message ?? null}
              captionId={pickerCaptionId}
              sendRef={sendRef}
              onSend={() => {
                setPickError(null);
                void run({ kind: 'invite', color: picked }, (message) => {
                  if (mountedRef.current) {
                    setPickError({ message, at: Date.now() });
                    return true;
                  }
                  // Closed under the request (Adopt went away): the toast it
                  // uncovered says why — nothing, though, when our own
                  // invite is what took Adopt away (the request failed, the
                  // invite didn't).
                  return ownInviteOutRef.current;
                }).then((ok) => {
                  // Sent: the bar under the header says so now ("Waiting for
                  // Sam to accept…"), as on iOS and Android.
                  if (ok && mountedRef.current) onClose();
                });
              }}
              onCancel={onClose}
            />
          ) : (
            <>
              <ModalHeader title={title} onClose={onClose} />
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-5">
                {!pet ? (
                  <p className="py-10 text-center text-sm text-ink-3">Loading…</p>
                ) : pet.status === 'invited' ? (
                  <div className="flex flex-col items-center gap-4 text-center">
                    <PetStageArt pet={pet} />
                    {banner && <p className="text-sm text-ink-2 leading-snug">{banner.text}</p>}
                    {banner && (
                      <div className="flex items-center gap-2">
                        <PetInviteActions
                          kind={banner.kind}
                          busy={busy}
                          canAct={canAct}
                          locked={banner.locked}
                          onRun={(c) => void run(c)}
                        />
                      </div>
                    )}
                  </div>
                ) : (
                  <PetCard
                    pet={pet}
                    selfId={selfId}
                    editing={editing}
                    setEditing={setEditing}
                    renaming={busy === 'rename'}
                    canRename={canAct}
                    onRename={(name) => run({ kind: 'rename', name })}
                  />
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}

/** The egg picker, laid out like iOS's ZekkPetEggPicker: its title and
    caption, the six pet colours as eggs (still, happy) in the shared order,
    the pick marked — a radio group, so arrow keys move the pick and Tab
    stops once, on it — and a full-width Cancel / Send invite pair at the
    foot. Send invite sends the invite with the pick; until it's answered
    everything is disabled, Cancel too. */
export function PetEggPicker({
  picked,
  onPick,
  busy,
  error,
  captionId,
  sendRef,
  onSend,
  onCancel,
}: {
  picked: PetColorId;
  onPick: (color: PetColorId) => void;
  /** The invite is on its way. */
  busy: boolean;
  /** Why the last send failed. */
  error: string | null;
  /** For the dialog's aria-describedby. */
  captionId?: string;
  sendRef?: Ref<HTMLButtonElement>;
  onSend: () => void;
  onCancel: () => void;
}) {
  function onKeyDown(e: ReactKeyboardEvent<HTMLDivElement>) {
    const step =
      e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!step || busy) return;
    e.preventDefault();
    const n = PET_COLOR_IDS.length;
    const next = PET_COLOR_IDS[(PET_COLOR_IDS.indexOf(picked) + step + n) % n]!;
    onPick(next);
    e.currentTarget.querySelector<HTMLElement>(`[data-color="${next}"]`)?.focus();
  }

  return (
    <div className="flex flex-col gap-3.5 text-center">
      <div className="flex flex-col gap-1">
        <h2 className="text-[17px] font-semibold text-ink-1 leading-snug">Pick an egg</h2>
        <p id={captionId} className="text-[13px] text-ink-2 leading-snug">
          You'll both see this egg.
        </p>
      </div>
      {/* The sheet is bg2, so an egg that isn't picked sits a step darker
          (bg1) rather than vanishing into it; the pick is bg3 with an accent
          edge, like the Appearance theme cards. */}
      <div role="radiogroup" aria-label="Egg color" onKeyDown={onKeyDown} className="grid grid-cols-3 gap-2">
        {PET_COLOR_IDS.map((color) => {
          const selected = color === picked;
          const { label } = PET_PALETTES[color];
          return (
            <button
              key={color}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`${label} egg`}
              data-color={color}
              tabIndex={selected ? 0 : -1}
              disabled={busy}
              onClick={() => onPick(color)}
              className={`relative flex flex-col items-center gap-1.5 rounded-[10px] border px-1 py-2.5 transition-colors disabled:cursor-wait ${
                selected ? 'border-accent/50 bg-bg-3' : 'border-transparent bg-bg-1 hover:bg-bg-3/60'
              }`}
            >
              <ZekkPetArt stage="egg" mood="happy" color={color} size={48} animated={false} />
              <span className={`max-w-full truncate text-[11px] font-medium ${selected ? 'text-ink-1' : 'text-ink-3'}`}>
                {label}
              </span>
              {selected && (
                <span className="absolute top-1.5 right-1.5 w-4 h-4 rounded-full bg-accent grid place-items-center">
                  <Check size={10} className="text-white" />
                </span>
              )}
            </button>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-xs text-red-300 leading-snug">
          {error}
        </p>
      )}
      <div className="flex gap-2.5">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="flex-1 min-w-0 min-h-[44px] px-3 rounded-[10px] bg-bg-3 text-ink-2 hover:text-ink-1 disabled:opacity-60 disabled:cursor-wait text-[15px] font-medium truncate transition-colors"
        >
          Cancel
        </button>
        <button
          ref={sendRef}
          type="button"
          onClick={onSend}
          disabled={busy}
          className="flex-1 min-w-0 min-h-[44px] px-3 rounded-[10px] bg-accent hover:bg-accent/90 disabled:opacity-60 disabled:cursor-wait text-white text-[15px] font-semibold truncate transition-colors"
        >
          {busy ? 'Sending…' : 'Send invite'}
        </button>
      </div>
    </div>
  );
}

/** The big pet on its stage, in its own colour. Tapping it squashes it and
    floats a heart up — purely local, nothing is sent. The stage is a
    rounded square, not a circle: the asleep Zs sit in the art's top-right
    corner, which a disc this size would cut (the top Z reaches past its rim
    and border). */
function PetStageArt({ pet }: { pet: PetDTO }) {
  const name = usePetDisplayName(pet.name);
  const [squash, setSquash] = useState(0);
  const [hearts, setHearts] = useState<number[]>([]);
  const nextId = useRef(1);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);

  function tap() {
    const id = nextId.current++;
    setSquash((n) => n + 1);
    setHearts((h) => [...h, id]);
    timers.current.push(
      window.setTimeout(() => setHearts((h) => h.filter((x) => x !== id)), HEART_MS + 50),
    );
  }

  return (
    <button
      type="button"
      onClick={tap}
      className="w-44 h-44 shrink-0 rounded-2xl border border-line bg-bg-2 flex items-center justify-center hover:bg-bg-3 transition-colors"
      aria-label={`Pet ${name}`}
      title={`Pet ${name}`}
    >
      <ZekkPetArt
        stage={pet.status === 'invited' ? 'egg' : pet.stage}
        mood={pet.mood}
        color={resolvePetColor(pet.color, pet.channelId)}
        progress={petArtProgress(pet)}
        size={140}
        squash={squash}
        hearts={hearts}
      />
    </button>
  );
}

function PetCard({
  pet,
  selfId,
  editing,
  setEditing,
  renaming,
  canRename,
  onRename,
}: {
  pet: PetDTO;
  selfId: string;
  editing: boolean;
  setEditing: (v: boolean) => void;
  renaming: boolean;
  canRename: boolean;
  onRename: (name: string) => Promise<boolean>;
}) {
  const name = usePetDisplayName(pet.name);
  const mood = petMoodView(pet);
  const level = petLevelProgress(pet);
  const tasks = petTaskRows(pet, selfId);
  const path = petStagePath(pet.stage);

  // Saving, cancelling (Escape, ✕) or a block hiding the field unmounts it
  // with focus inside: put focus on the pencil it came from (or the name,
  // when renaming isn't allowed any more) rather than <body>.
  const fieldOpen = editing && canRename;
  const wasOpen = useRef(fieldOpen);
  const pencilRef = useRef<HTMLButtonElement>(null);
  const nameRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (wasOpen.current && !fieldOpen) refocusIfDropped(pencilRef.current ?? nameRef.current);
    wasOpen.current = fieldOpen;
  }, [fieldOpen]);

  return (
    <div className="flex flex-col items-center gap-4">
      <PetStageArt pet={pet} />

      <div className="w-full flex flex-col items-center gap-1 text-center">
        {fieldOpen ? (
          <RenameField
            current={pet.name}
            saving={renaming}
            onCancel={() => setEditing(false)}
            onSave={async (name) => {
              if (await onRename(name)) setEditing(false);
            }}
          />
        ) : (
          <div className="flex items-center gap-1.5 min-w-0 max-w-full">
            <h3 ref={nameRef} tabIndex={-1} className="text-lg font-semibold text-ink-1 truncate outline-none">
              {name}
            </h3>
            {canRename && (
              <button
                ref={pencilRef}
                type="button"
                onClick={() => setEditing(true)}
                className="shrink-0 w-7 h-7 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3 transition-colors"
                aria-label="Rename pet"
                title="Rename"
              >
                <Edit size={14} />
              </button>
            )}
          </div>
        )}
        <p className="text-sm text-ink-2">{petLevelLine(pet)}</p>
      </div>

      {/* Mood chip: the adjective and its line (asleep: when to wake it). */}
      <div
        className={`w-full rounded-lg border px-3 py-2 ${
          mood.mood === 'asleep' || mood.mood === 'grumpy'
            ? 'border-amber-500/30 bg-amber-500/10'
            : 'border-line bg-bg-2'
        }`}
      >
        <div className="text-sm font-semibold text-ink-1">{mood.label}</div>
        <div className="text-sm text-ink-2 leading-snug">{mood.line}</div>
      </div>

      {/* Level bar. */}
      <div className="w-full">
        <div
          className="h-2 rounded-full bg-bg-3 overflow-hidden"
          role="progressbar"
          aria-label={`Level ${pet.level} progress`}
          aria-valuemin={0}
          aria-valuemax={level.need}
          aria-valuenow={level.have}
        >
          <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${level.fraction * 100}%` }} />
        </div>
        <div className="mt-1 text-xs text-ink-3 tabular-nums">{level.label}</div>
      </div>

      {/* Today's care. */}
      <div className="w-full">
        <h4 className="text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">Today's care</h4>
        <ul className="rounded-lg border border-line bg-bg-2 overflow-hidden divide-y divide-line">
          {tasks.map((t) => (
            <li key={t.key} className="px-3 py-2 flex items-center gap-3 text-sm">
              <span
                className={`w-5 h-5 shrink-0 rounded-full flex items-center justify-center border ${
                  t.done ? 'bg-accent/15 border-accent/50 text-accent' : 'border-line text-transparent'
                }`}
                aria-hidden
              >
                <Check size={12} />
              </span>
              <span className={`flex-1 min-w-0 ${t.done ? 'text-ink-1' : 'text-ink-2'}`}>
                {t.label}
                {t.progress && <span className="ml-2 text-xs text-ink-3 tabular-nums">{t.progress}</span>}
                <span className="sr-only">{t.done ? ' (done)' : ' (not done yet)'}</span>
              </span>
              <span className={`shrink-0 text-xs tabular-nums ${t.done ? 'text-accent' : 'text-ink-3'}`}>
                +{t.points}
              </span>
            </li>
          ))}
        </ul>
      </div>

      {/* Stage path. */}
      <ol className="w-full flex flex-wrap items-center justify-center gap-y-1 text-xs" aria-label="Stages">
        {path.map((s, i) => (
          <li key={s.stage} className="flex items-center">
            {i > 0 && <ChevronRight size={12} className="mx-0.5 text-ink-3" aria-hidden />}
            <span
              className={`px-1.5 py-0.5 rounded-md border ${
                s.current
                  ? 'border-accent/50 bg-accent/15 text-ink-1 font-semibold'
                  : s.reached
                    ? 'border-transparent text-ink-2'
                    : 'border-transparent text-ink-3'
              }`}
              aria-current={s.current ? 'step' : undefined}
            >
              {s.label}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** Inline rename: Enter saves, Escape cancels. The name is normalised like
    the server does (trimmed, spaces collapsed, 1–24 characters). */
function RenameField({
  current,
  saving,
  onSave,
  onCancel,
}: {
  current: string;
  saving: boolean;
  onSave: (name: string) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState(current);
  const name = normalizePetName(draft);
  const canSave = name !== null && name !== current && !saving;
  const invalid = draft.trim().length > 0 && name === null;
  const hintId = useId();
  // The input is disabled while saving, which drops its focus; a save that
  // failed leaves the field open, so give it back.
  const inputRef = useRef<HTMLInputElement>(null);
  const wasSaving = useRef(saving);
  useEffect(() => {
    if (wasSaving.current && !saving) refocusIfDropped(inputRef.current);
    wasSaving.current = saving;
  }, [saving]);

  return (
    <form
      className="w-full max-w-xs"
      onSubmit={(e) => {
        e.preventDefault();
        if (canSave && name) onSave(name);
      }}
    >
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') {
              e.preventDefault();
              onCancel();
            }
          }}
          disabled={saving}
          aria-label="Pet name"
          aria-invalid={invalid}
          aria-describedby={hintId}
          // text-base (16px) keeps iOS from zooming the page on focus.
          className="flex-1 min-w-0 bg-bg-2 border border-line rounded-md px-3 py-1.5 text-base text-ink-1 outline-none focus:border-accent/60 disabled:opacity-60"
        />
        <button
          type="submit"
          disabled={!canSave}
          className="w-8 h-8 shrink-0 flex items-center justify-center rounded text-accent hover:bg-bg-3 transition-colors disabled:text-ink-3 disabled:opacity-50 disabled:hover:bg-transparent disabled:cursor-default"
          aria-label="Save name"
          title="Save"
        >
          <Check size={18} />
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="w-8 h-8 shrink-0 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 transition-colors"
          aria-label="Cancel rename"
          title="Cancel"
        >
          <X size={18} />
        </button>
      </div>
      <p id={hintId} className={`mt-1 text-xs ${invalid ? 'text-red-300' : 'text-ink-3'}`}>
        {invalid
          ? `Names are 1–${PET_NAME_MAX_LENGTH} characters, with no control characters.`
          : `Up to ${PET_NAME_MAX_LENGTH} characters. You'll both see the new name.`}
      </p>
    </form>
  );
}
