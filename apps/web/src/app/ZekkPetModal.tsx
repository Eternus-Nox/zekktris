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
 * Hosted by MessageView, which closes it on a channel switch.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { PET_NAME_MAX_LENGTH, normalizePetName, type PetDTO } from '@zekktris/client';
import { Portal } from '../lib/Portal';
import { ModalHeader } from '../lib/ModalHeader';
import { Check, ChevronRight, Edit, X } from '../lib/icons';
import { ZekkPetArt } from '../lib/ZekkPetArt';
import {
  petArtProgress,
  petBanner,
  petCanAct,
  petLevelLine,
  petLevelProgress,
  petMoodView,
  petStagePath,
  petTaskRows,
} from '../lib/zekkPet';
import { useAppStateSelector } from '../state/AppState';
import { PetInviteActions, usePetActions } from './ZekkPet';

/** How long one tap heart floats (matches zk-pet-heart in index.css). */
const HEART_MS = 800;

export function ZekkPetModal({
  channelId,
  peerName,
  selfId,
  onClose,
}: {
  channelId: string;
  /** The other person (their DM nickname when set). */
  peerName: string;
  selfId: string;
  onClose: () => void;
}) {
  const petState = useAppStateSelector((v) => v.state.dmPets[channelId]);
  const pet = petState?.pet ?? null;
  const { busy, run } = usePetActions(channelId);
  const [editing, setEditing] = useState(false);
  const canAct = petCanAct(petState);
  // A block or the other person leaving mid-rename hides the field; drop the
  // edit too, so Escape closes the card instead of cancelling a hidden field.
  useEffect(() => {
    if (!canAct) setEditing(false);
  }, [canAct]);

  // Nothing left to show: the invite was declined / cancelled / expired or
  // the pet ran away (from here or anywhere else).
  useEffect(() => {
    if (petState && !pet) onClose();
  }, [petState, pet, onClose]);

  // Focus moves into the card and back to whatever opened it. A callback
  // ref, because Portal mounts the card a render after this component.
  const openerRef = useRef<HTMLElement | null>(
    document.activeElement instanceof HTMLElement ? document.activeElement : null,
  );
  useEffect(() => () => openerRef.current?.focus(), []);
  const focusDialog = useCallback((el: HTMLDivElement | null) => el?.focus(), []);

  // Escape: out of the rename field first, then close. The field cancels its
  // own Escape and marks it handled (preventDefault). React may already have
  // re-rendered this listener with editing=false by the time that event gets
  // to window, so a handled Escape must not close the card as well.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      e.preventDefault();
      if (editing) setEditing(false);
      else onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [editing, onClose]);

  const banner = petBanner(petState, selfId, peerName);

  return (
    <Portal>
      <div
        className="fixed inset-0 bg-black/60 z-50 flex items-stretch sm:items-center justify-center sm:p-4"
        onClick={onClose}
      >
        <div
          ref={focusDialog}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-label="Zekk Pet"
          className="bg-bg-1 border border-line shadow-xl w-full overflow-hidden flex flex-col h-full sm:h-auto sm:rounded-lg sm:max-w-md sm:max-h-[85vh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0 outline-none"
          onClick={(e) => e.stopPropagation()}
        >
          <ModalHeader title="Zekk Pet" onClose={onClose} />
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
        </div>
      </div>
    </Portal>
  );
}

/** The big pet on its round stage. Tapping it squashes it and floats a
    heart up — purely local, nothing is sent. */
function PetStageArt({ pet }: { pet: PetDTO }) {
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
      className="w-44 h-44 shrink-0 rounded-full border border-line bg-bg-2 flex items-center justify-center hover:bg-bg-3 transition-colors"
      aria-label={`Pet ${pet.name}`}
      title={`Pet ${pet.name}`}
    >
      <ZekkPetArt
        stage={pet.status === 'invited' ? 'egg' : pet.stage}
        mood={pet.mood}
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
  const mood = petMoodView(pet);
  const level = petLevelProgress(pet);
  const tasks = petTaskRows(pet, selfId);
  const path = petStagePath(pet.stage);

  return (
    <div className="flex flex-col items-center gap-4">
      <PetStageArt pet={pet} />

      <div className="w-full flex flex-col items-center gap-1 text-center">
        {editing && canRename ? (
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
            <h3 className="text-lg font-semibold text-ink-1 truncate">{pet.name}</h3>
            {canRename && (
              <button
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
      <p className={`mt-1 text-xs ${invalid ? 'text-red-300' : 'text-ink-3'}`}>
        {invalid
          ? `Names are 1–${PET_NAME_MAX_LENGTH} characters, with no control characters.`
          : `Up to ${PET_NAME_MAX_LENGTH} characters. You'll both see the new name.`}
      </p>
    </form>
  );
}
