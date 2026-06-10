/**
 * PollComposerModal
 * -----------------
 * Modal that collects the inputs for a new poll: question, 2-10 options,
 * multiple-choice toggle, duration. On submit, calls back with the
 * input shape the API accepts; the parent attaches it to a sendMessage
 * call.
 *
 * Constraints (mirrored from server validation so the user gets
 * immediate feedback rather than a 400 on send):
 *   - question 1..300 chars
 *   - options 2..10 entries, each 1..80 chars, no duplicates
 *   - duration: one of 1h / 4h / 24h / 72h / 168h (1d / 3d / 7d)
 *
 * The submit button stays disabled until everything's valid; we don't
 * surface inline error messages because the constraints are simple
 * enough to convey through the disabled state and the help text under
 * each field.
 */

import { useRef, useState } from 'react';
import { Portal } from '../lib/Portal';
import { Plus, Trash } from '../lib/icons';
import { ModalHeader } from '../lib/ModalHeader';

export interface PollDraft {
  question: string;
  options: string[];
  multipleChoice: boolean;
  durationHours: number;
}

interface Props {
  onCancel: () => void;
  onSubmit: (draft: PollDraft) => void;
}

const DURATION_OPTIONS: Array<{ hours: number; label: string }> = [
  { hours: 1, label: '1 hour' },
  { hours: 4, label: '4 hours' },
  { hours: 24, label: '1 day' },
  { hours: 72, label: '3 days' },
  { hours: 168, label: '1 week' },
];

export function PollComposerModal({ onCancel, onSubmit }: Props) {
  const [question, setQuestion] = useState('');
  // Two empty option slots by default — the minimum a poll needs.
  // Users can add up to 10 with the "+ Add option" button. Each slot
  // carries a stable key so React doesn't re-associate DOM inputs
  // (focus, IME composition) when a MIDDLE option is removed — keying
  // by array index made every input below the removed one adopt its
  // neighbor's value/focus.
  const nextOptionKey = useRef(2);
  const [options, setOptions] = useState<Array<{ key: number; text: string }>>([
    { key: 0, text: '' },
    { key: 1, text: '' },
  ]);
  const [multipleChoice, setMultipleChoice] = useState(false);
  const [durationHours, setDurationHours] = useState<number>(24);

  function setOption(idx: number, value: string) {
    setOptions((prev) => prev.map((o, i) => (i === idx ? { ...o, text: value } : o)));
  }
  function addOption() {
    if (options.length >= 10) return;
    setOptions((prev) => [...prev, { key: nextOptionKey.current++, text: '' }]);
  }
  function removeOption(idx: number) {
    if (options.length <= 2) return; // can't go below 2
    setOptions((prev) => prev.filter((_, i) => i !== idx));
  }

  // Validation: trim before checking because trailing whitespace on an
  // option is harmless but shouldn't count toward "is it filled in".
  const trimmedOptions = options.map((o) => o.text.trim());
  const trimmedQuestion = question.trim();
  const allFilled = trimmedOptions.every((o) => o.length > 0);
  const noDupes = new Set(trimmedOptions).size === trimmedOptions.length;
  const lengthsOk =
    trimmedQuestion.length > 0 &&
    trimmedQuestion.length <= 300 &&
    trimmedOptions.every((o) => o.length <= 80);
  const valid = allFilled && noDupes && lengthsOk;

  function submit() {
    if (!valid) return;
    onSubmit({
      question: trimmedQuestion,
      options: trimmedOptions,
      multipleChoice,
      durationHours,
    });
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 bg-black/60 z-50 flex items-stretch sm:items-center justify-center sm:p-4"
        onClick={onCancel}
      >
        <div
          className="bg-bg-1 border border-line shadow-xl w-full overflow-hidden flex flex-col h-full sm:h-auto sm:rounded-lg sm:max-w-md sm:max-h-[85vh] pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0"
          onClick={(e) => e.stopPropagation()}
        >
          <ModalHeader title="Create a poll" onClose={onCancel} />

          <div className="px-5 py-4 space-y-4 overflow-y-auto scrollbar-thin">
            {/* Question */}
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Question</span>
              <input
                type="text"
                autoFocus
                value={question}
                maxLength={300}
                placeholder="What's your favorite…"
                onChange={(e) => setQuestion(e.target.value)}
                className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
              />
              <span className="block text-[0.65rem] text-ink-3 mt-1">
                {trimmedQuestion.length}/300
              </span>
            </label>

            {/* Options */}
            <div>
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
                Options ({trimmedOptions.filter((o) => o.length > 0).length}/{options.length})
              </span>
              <ul className="mt-2 space-y-2">
                {options.map((opt, i) => (
                  <li key={opt.key} className="flex items-center gap-2">
                    <input
                      type="text"
                      value={opt.text}
                      maxLength={80}
                      placeholder={`Option ${i + 1}`}
                      onChange={(e) => setOption(i, e.target.value)}
                      className="flex-1 px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
                    />
                    {options.length > 2 && (
                      <button
                        type="button"
                        onClick={() => removeOption(i)}
                        className="w-8 h-8 flex items-center justify-center rounded text-ink-3 hover:text-red-400 hover:bg-bg-3 shrink-0"
                        title="Remove option"
                        aria-label={`Remove option ${i + 1}`}
                      >
                        <Trash size={14} />
                      </button>
                    )}
                  </li>
                ))}
              </ul>
              {options.length < 10 && (
                <button
                  type="button"
                  onClick={addOption}
                  className="mt-2 px-3 py-1.5 rounded text-xs text-ink-2 hover:text-ink-1 hover:bg-bg-3 flex items-center gap-1"
                >
                  <Plus size={12} />
                  Add option
                </button>
              )}
              {!noDupes && (
                <p className="text-xs text-red-400 mt-1">Options must be unique.</p>
              )}
            </div>

            {/* Multiple choice */}
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={multipleChoice}
                onChange={(e) => setMultipleChoice(e.target.checked)}
                className="w-4 h-4 accent-accent"
              />
              <span className="text-sm text-ink-1">Allow multiple answers</span>
            </label>

            {/* Duration */}
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Duration</span>
              <select
                value={durationHours}
                onChange={(e) => setDurationHours(Number(e.target.value))}
                className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
              >
                {DURATION_OPTIONS.map((opt) => (
                  <option key={opt.hours} value={opt.hours}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <div className="px-5 py-3 border-t border-line flex justify-end gap-2 shrink-0">
            <button
              type="button"
              onClick={onCancel}
              className="px-4 py-2 rounded-md bg-bg-3 hover:bg-bg-3/70 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={submit}
              disabled={!valid}
              className="px-4 py-2 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Create poll
            </button>
          </div>
        </div>
      </div>
    </Portal>
  );
}
