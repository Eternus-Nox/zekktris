/**
 * DisappearingMessagesModal
 * -------------------------
 * Signal's "Disappearing Messages" screen for a 1:1 DM. Full screen on
 * mobile, floating on desktop (the house modal shell + ModalHeader):
 *
 *   ✕  Disappearing Messages  ✓
 *   When enabled, new messages sent and received in this chat will
 *   disappear after they have been seen.
 *   ✓ Off · 4 weeks · 1 week · 1 day · 8 hours · 1 hour · 5 minutes ·
 *     30 seconds · Custom Time (its value) ›
 *
 * Custom Time opens a sub-view with a number column and a unit column
 * (native selects: the wheel picker on iOS, the system list on Android, a
 * dropdown on desktop — each always showing its current value). The choice is
 * staged: ✕ (or Escape, or a backdrop click) discards it, ✓ saves it and is
 * disabled while nothing changed — the server posts a notice in the chat for
 * every change, so an unchanged save must never be sent. On a server from
 * before Signal-style timers (getDmSettings without maxTtlSeconds) only
 * values inside its 10 s .. 1 day range are offered.
 *
 * Hosted by MessageView, not by DmSettingsPanel (whose outside-click handler
 * would close the panel and unmount a modal portaled from inside it).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, type Channel } from '@zekktris/client';
import { Portal } from '../lib/Portal';
import { ModalHeader } from '../lib/ModalHeader';
import { Check, ChevronLeft, ChevronRight } from '../lib/icons';
import { useAppStateSelector } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import {
  DISAPPEARING_DESCRIPTION,
  LEGACY_TIMER_BOUNDS,
  UNITS,
  availableUnits,
  changeCustomUnit,
  clampCustomNumber,
  customInitial,
  customSeconds,
  formatLong,
  isPreset,
  presetsWithin,
  timerBoundsFor,
  unitRange,
  withinBounds,
  type CustomTime,
  type TimerBounds,
  type TimerUnit,
} from '../lib/disappearing';

export function DisappearingMessagesModal({
  channel,
  onClose,
}: {
  channel: Channel;
  onClose: () => void;
}) {
  const channelId = channel.id;
  // The conversation's current timer (undefined until known). Live: a
  // change by the other person while this is open updates it.
  const current = useAppStateSelector((v) => v.state.dmTimers[channelId]);
  const loadDmSettings = useAppStateSelector((v) => v.loadDmSettings);
  const saveDmTimer = useAppStateSelector((v) => v.saveDmTimer);
  const toasts = useToasts();

  // What the server accepts; null until getDmSettings answers.
  const [bounds, setBounds] = useState<TimerBounds | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  // The user's pick, staged until ✓. undefined = untouched → follow `current`.
  const [picked, setPicked] = useState<number | null | undefined>(undefined);
  const [view, setView] = useState<'list' | 'custom'>('list');
  const [custom, setCustom] = useState<CustomTime>({ n: 1, unit: 'days' });
  const [saving, setSaving] = useState(false);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadDmSettings(channelId)
      .then((r) => {
        if (!cancelled) setBounds(timerBoundsFor(r.maxTtlSeconds));
      })
      .catch(() => {
        // Offer only what every server accepts; a save still reports its
        // own error.
        if (cancelled) return;
        setBounds(LEGACY_TIMER_BOUNDS);
        setLoadFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [channelId, loadDmSettings]);

  const currentValue = current ?? null;
  const staged = picked !== undefined ? picked : currentValue;
  const presets = useMemo(() => presetsWithin(bounds ?? LEGACY_TIMER_BOUNDS), [bounds]);
  const customSelected = staged !== null && !isPreset(staged);
  const dirty = picked !== undefined && picked !== currentValue;
  const valid = staged === null || (bounds !== null && withinBounds(staged, bounds));
  const canSave = bounds !== null && dirty && valid && !saving;

  function openCustom() {
    if (!bounds) return;
    const initial = customInitial(staged, bounds);
    setCustom(initial);
    setPicked(customSeconds(initial));
    setView('custom');
  }

  function updateCustom(next: CustomTime) {
    setCustom(next);
    setPicked(customSeconds(next));
  }

  async function save() {
    if (!canSave) return;
    setSaving(true);
    try {
      await saveDmTimer(channelId, staged);
      // The notice the server posts in the chat is the confirmation. A
      // server from before Signal-style timers posts none, so say it here.
      if (bounds === LEGACY_TIMER_BOUNDS) {
        toasts.push(
          staged === null
            ? 'Disappearing messages turned off'
            : `Disappearing messages set to ${formatLong(staged)}`,
          'success',
        );
      }
      onClose();
    } catch (e) {
      if (!mountedRef.current) return;
      // Back to what the conversation actually has (saveDmTimer already
      // reverted the shared value); the toast says why.
      setPicked(undefined);
      setView('list');
      setSaving(false);
      toasts.push(
        e instanceof ApiError ? e.message : "Couldn't change disappearing messages.",
        'error',
      );
    }
  }

  // Escape: out of Custom Time first, then cancel.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      if (view === 'custom') setView('list');
      else onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [view, onClose]);

  const saveButton = (
    <button
      type="button"
      onClick={() => void save()}
      disabled={!canSave}
      className="w-8 h-8 flex items-center justify-center rounded text-accent hover:bg-bg-3 transition-colors disabled:text-ink-3 disabled:opacity-50 disabled:hover:bg-transparent disabled:cursor-default"
      aria-label="Save"
      title="Save"
    >
      <Check size={18} />
    </button>
  );

  return (
    <Portal>
      <div
        className="fixed inset-0 bg-black/60 z-50 flex items-stretch sm:items-center justify-center sm:p-4"
        onClick={onClose}
      >
        <div
          role="dialog"
          aria-modal="true"
          aria-label={view === 'custom' ? 'Custom Time' : 'Disappearing Messages'}
          className="bg-bg-1 border border-line shadow-xl w-full overflow-hidden flex flex-col h-full sm:h-auto sm:rounded-lg sm:max-w-md sm:max-h-[85vh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0"
          onClick={(e) => e.stopPropagation()}
        >
          {view === 'list' ? (
            <>
              <ModalHeader
                title="Disappearing Messages"
                onClose={onClose}
                mobileDismiss="x"
                dismissLabel="Cancel"
                rightSlot={saveButton}
              />
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
                <p className="px-5 pt-4 pb-3 text-sm text-ink-2 leading-snug">
                  {DISAPPEARING_DESCRIPTION}
                </p>
                {loadFailed && current === undefined && (
                  <p className="px-5 pb-3 text-xs text-red-300">
                    Couldn't load this chat's current setting.
                  </p>
                )}
                <div
                  role="radiogroup"
                  aria-label="Disappearing messages timer"
                  className="mx-4 mb-4 rounded-lg border border-line bg-bg-2 overflow-hidden divide-y divide-line"
                >
                  <TimerRow
                    label="Off"
                    selected={staged === null}
                    disabled={bounds === null || saving}
                    onSelect={() => setPicked(null)}
                  />
                  {presets.map((s) => (
                    <TimerRow
                      key={s}
                      label={formatLong(s)}
                      selected={staged === s}
                      disabled={bounds === null || saving}
                      onSelect={() => setPicked(s)}
                    />
                  ))}
                  <TimerRow
                    label="Custom Time"
                    selected={customSelected}
                    detail={customSelected && staged !== null ? formatLong(staged) : undefined}
                    chevron
                    disabled={bounds === null || saving}
                    onSelect={openCustom}
                  />
                </div>
              </div>
            </>
          ) : (
            <>
              {/* Sub-view header: back to the list on every screen size (the
                  pick stays staged), ✓ saves straight away. */}
              <div className="px-3 sm:px-4 h-12 border-b border-line bg-bg-2 flex items-center gap-2 shrink-0">
                <button
                  type="button"
                  onClick={() => setView('list')}
                  className="-ml-1 w-10 h-10 sm:w-8 sm:h-8 flex items-center justify-center rounded-md text-ink-2 hover:text-ink-1 hover:bg-bg-3 transition-colors"
                  aria-label="Back"
                >
                  <ChevronLeft size={20} />
                </button>
                <h2 className="text-base sm:text-lg font-semibold text-ink-1 truncate flex-1">
                  Custom Time
                </h2>
                <div className="ml-auto flex items-center gap-1">{saveButton}</div>
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin px-5 py-5">
                <CustomTimePicker
                  value={custom}
                  bounds={bounds ?? LEGACY_TIMER_BOUNDS}
                  disabled={saving}
                  onChange={updateCustom}
                />
                <p className="mt-4 text-sm text-ink-2 text-center">
                  Messages will disappear {formatLong(customSeconds(custom))} after they have been
                  seen.
                </p>
              </div>
            </>
          )}
        </div>
      </div>
    </Portal>
  );
}

/** One radio row: accent check at the leading edge when selected (Signal's
    list), the label, and for Custom Time its value + a chevron. */
function TimerRow({
  label,
  selected,
  detail,
  chevron,
  disabled,
  onSelect,
}: {
  label: string;
  selected: boolean;
  detail?: string;
  chevron?: boolean;
  disabled?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={onSelect}
      disabled={disabled}
      className="w-full px-3 py-3 flex items-center gap-3 text-left text-sm hover:bg-bg-3 transition-colors disabled:opacity-60 disabled:hover:bg-transparent"
    >
      <span className="w-5 shrink-0 flex items-center justify-center text-accent" aria-hidden>
        {selected && <Check size={16} />}
      </span>
      <span className={`flex-1 min-w-0 ${selected ? 'text-ink-1 font-medium' : 'text-ink-2'}`}>
        {label}
      </span>
      {detail && <span className="text-ink-3 shrink-0">{detail}</span>}
      {chevron && <ChevronRight size={16} className="text-ink-3 shrink-0" />}
    </button>
  );
}

/** Number + unit columns. Changing the unit clamps the number to the new
    unit's range (e.g. 45 minutes → hours gives 23 hours); both columns only
    offer what the server accepts. */
function CustomTimePicker({
  value,
  bounds,
  disabled,
  onChange,
}: {
  value: CustomTime;
  bounds: TimerBounds;
  disabled?: boolean;
  onChange: (next: CustomTime) => void;
}) {
  const range = unitRange(value.unit, bounds) ?? { min: 1, max: 1 };
  const numbers: number[] = [];
  for (let n = range.min; n <= range.max; n++) numbers.push(n);
  const units = availableUnits(bounds);
  // text-lg (≥16px) also keeps iOS from zooming the page on focus.
  const selectClass =
    'w-full bg-bg-2 border border-line rounded-md px-3 py-2 text-lg text-ink-1 outline-none focus:border-accent/60 disabled:opacity-60';
  return (
    <div className="flex items-start justify-center gap-3">
      <label className="flex-1 max-w-[9rem]">
        <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
          Number
        </span>
        <select
          value={value.n}
          disabled={disabled}
          onChange={(e) =>
            onChange({ unit: value.unit, n: clampCustomNumber(Number(e.target.value), value.unit, bounds) })
          }
          className={selectClass}
        >
          {numbers.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <label className="flex-1 max-w-[9rem]">
        <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
          Unit
        </span>
        <select
          value={value.unit}
          disabled={disabled}
          onChange={(e) => onChange(changeCustomUnit(value, e.target.value as TimerUnit, bounds))}
          className={selectClass}
        >
          {UNITS.filter((u) => units.includes(u.unit)).map((u) => (
            <option key={u.unit} value={u.unit}>
              {value.n === 1 ? u.singular : u.plural}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
