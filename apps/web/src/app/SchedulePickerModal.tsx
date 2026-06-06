/**
 * SchedulePickerModal
 * -------------------
 * Popped from the composer's send-button dropdown. Lets the user
 * pick when a scheduled message should send. Four quick presets
 * + a custom datetime-local input for arbitrary times.
 *
 * Preset semantics (all computed against the user's LOCAL time):
 *   - "In 1 hour"    — now + 60min
 *   - "Tonight 8pm"  — today at 20:00 (if it's already past 8pm,
 *                      hidden / skipped to avoid an in-the-past
 *                      preset)
 *   - "Tomorrow 9am" — next day at 09:00
 *   - "Tomorrow noon"— next day at 12:00
 *   - "Next Monday 9am" — coming Monday at 09:00 (or in 7 days if
 *                         it's currently Monday)
 *
 * The server enforces MIN_DELAY_SECONDS=60, so the picker rejects
 * anything within the next minute (you can't schedule "1 second
 * from now" — that's just sending normally).
 */

import { useMemo, useState } from 'react';
import { Calendar, X } from '../lib/icons';

interface Preset {
  label: string;
  iso: string;
}

function presetIso(daysAhead: number, hour: number, minute = 0): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
}

function nextWeekdayIso(targetDay: number, hour: number): string {
  // targetDay: 0=Sun, 1=Mon ... 6=Sat
  const now = new Date();
  const today = now.getDay();
  let delta = (targetDay - today + 7) % 7;
  if (delta === 0) delta = 7; // strictly "next" — never today
  const d = new Date();
  d.setDate(d.getDate() + delta);
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

function buildPresets(): Preset[] {
  const out: Preset[] = [];
  out.push({
    label: 'In 1 hour',
    iso: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
  });
  // "Tonight 8pm" — only show if we're still before 8pm local
  const eightPm = new Date();
  eightPm.setHours(20, 0, 0, 0);
  if (eightPm.getTime() > Date.now() + 60_000) {
    out.push({ label: 'Tonight 8pm', iso: eightPm.toISOString() });
  }
  out.push({ label: 'Tomorrow 9am', iso: presetIso(1, 9) });
  out.push({ label: 'Tomorrow noon', iso: presetIso(1, 12) });
  out.push({ label: 'Next Monday 9am', iso: nextWeekdayIso(1, 9) });
  return out;
}

/** Format an ISO into datetime-local input value (YYYY-MM-DDTHH:MM). */
function isoToLocalInput(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return '';
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const mi = String(d.getMinutes()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:${mi}`;
}

/** Convert datetime-local input value back to ISO. */
function localInputToIso(local: string): string | null {
  if (!local) return null;
  const d = new Date(local);
  if (!Number.isFinite(d.getTime())) return null;
  return d.toISOString();
}

export function SchedulePickerModal({
  onClose,
  onPick,
}: {
  onClose: () => void;
  /** Called with the chosen ISO timestamp when the user clicks Schedule. */
  onPick: (iso: string) => void;
}) {
  const presets = useMemo(buildPresets, []);
  // Default custom value to "in 1 hour" so the input is pre-filled with
  // a valid future time rather than empty.
  const [custom, setCustom] = useState<string>(
    isoToLocalInput(new Date(Date.now() + 60 * 60 * 1000).toISOString()),
  );
  const [selectedPreset, setSelectedPreset] = useState<string | null>(
    presets[0]?.iso ?? null,
  );

  // The actual "chosen" iso: a preset if selected, otherwise the
  // custom input (when present + parseable + > 60s future).
  const chosenIso: string | null = useMemo(() => {
    if (selectedPreset) return selectedPreset;
    const iso = localInputToIso(custom);
    if (!iso) return null;
    if (new Date(iso).getTime() < Date.now() + 60_000) return null;
    return iso;
  }, [selectedPreset, custom]);

  function chosenSummary(): string {
    if (!chosenIso) return 'Pick a time in the future';
    const d = new Date(chosenIso);
    const today = new Date();
    const sameDay =
      d.getFullYear() === today.getFullYear() &&
      d.getMonth() === today.getMonth() &&
      d.getDate() === today.getDate();
    const time = d.toLocaleTimeString(undefined, {
      hour: 'numeric',
      minute: '2-digit',
    });
    if (sameDay) return `Today at ${time}`;
    const tomorrow = new Date();
    tomorrow.setDate(today.getDate() + 1);
    if (
      d.getFullYear() === tomorrow.getFullYear() &&
      d.getMonth() === tomorrow.getMonth() &&
      d.getDate() === tomorrow.getDate()
    ) {
      return `Tomorrow at ${time}`;
    }
    return `${d.toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })} at ${time}`;
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-3 sm:p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div
        className="bg-bg-2 border border-line rounded-lg max-w-md w-full p-4 sm:p-5 space-y-3 max-h-[calc(100vh-1.5rem)] overflow-y-auto my-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2">
          <Calendar size={16} className="text-accent" />
          <h2 className="text-base font-semibold text-ink-1 flex-1">
            Schedule message
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="w-7 h-7 flex items-center justify-center text-ink-3 hover:text-ink-1 rounded-md"
            aria-label="Close"
          >
            <X size={14} />
          </button>
        </header>

        <p className="text-xs text-ink-3 leading-snug">
          The message stays queued and sends automatically at the chosen
          time. Cancel anytime from your scheduled messages list.
        </p>

        {/* Quick presets */}
        <div className="space-y-1">
          <label className="text-[0.65rem] uppercase tracking-wider text-ink-3">
            Quick presets
          </label>
          <div className="flex flex-wrap gap-1.5">
            {presets.map((p) => {
              const selected = selectedPreset === p.iso;
              return (
                <button
                  key={p.iso}
                  type="button"
                  onClick={() => {
                    setSelectedPreset(p.iso);
                    setCustom(isoToLocalInput(p.iso));
                  }}
                  className={`px-2.5 py-1 rounded text-xs border transition-colors ${
                    selected
                      ? 'bg-bg-3 border-accent text-ink-1'
                      : 'bg-bg-2 border-line text-ink-2 hover:bg-bg-3/50'
                  }`}
                >
                  {p.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Custom datetime */}
        <label className="block space-y-1">
          <span className="text-[0.65rem] uppercase tracking-wider text-ink-3">
            Or pick a custom time
          </span>
          <input
            type="datetime-local"
            value={custom}
            onChange={(e) => {
              setCustom(e.target.value);
              // Clear preset selection — user is overriding to custom.
              setSelectedPreset(null);
            }}
            className="w-full bg-bg-1 border border-line rounded-md px-3 py-2 text-sm text-ink-1 outline-none focus:border-accent transition-colors"
          />
        </label>

        <div className="px-3 py-2 rounded-md bg-bg-1 border border-line">
          <div className="text-[0.65rem] uppercase tracking-wider text-ink-3 mb-0.5">
            Will send
          </div>
          <div className="text-sm text-ink-1">{chosenSummary()}</div>
        </div>

        <div className="pt-1 flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-3 py-1.5 rounded-md hover:bg-bg-3 text-sm text-ink-2"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => {
              if (!chosenIso) return;
              onPick(chosenIso);
            }}
            disabled={!chosenIso}
            className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium"
          >
            Schedule
          </button>
        </div>
      </div>
    </div>
  );
}
