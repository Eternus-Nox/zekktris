/**
 * AdminSecurityTab — instance security (web parity with the iOS tab).
 * -------------------------------------------------------------------
 * Three sections:
 *   1. Spam protection — rate-limit config (trigger threshold, window,
 *      cooldown) behind an enable toggle. After the threshold, an
 *      offender is limited to 1 message/minute for the cooldown.
 *   2. Banned words — instance-wide whole-word filter. Add words one at
 *      a time, browse the server's common preset list (add individually
 *      or all at once), remove via the pills.
 *   3. Security log — spam_limited / banned_word detections plus the
 *      staff_* audit trail (every admin/moderator action), with the
 *      actor, target, detail line, and content snapshot when present.
 *
 * Moderators see ONLY the security log — the config + word sections are
 * admin-only (the API rejects those endpoints for moderators anyway).
 *
 * E2EE conversations are exempt by design — the server never inspects
 * encrypted content, so nothing from them can appear here.
 */

import { useCallback, useEffect, useState } from 'react';
import type { SecurityConfig, SecurityEvent } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { Plus, Shield, X as CloseIcon } from '../lib/icons';

type KindFilter = 'spam_limited' | 'banned_word' | 'staff' | undefined;

/** Badge labels for the staff-action audit kinds. */
const STAFF_KIND_LABELS: Record<string, string> = {
  staff_ban: 'Ban',
  staff_unban: 'Unban',
  staff_logout: 'Sign-out',
  staff_gift: 'Membership gift',
  staff_membership_reset: 'Membership reset',
  staff_dob_reset: 'DOB reset',
  staff_role_change: 'Role change',
  staff_observe: 'Observe',
  staff_guild_delete: 'Server delete',
  staff_user_delete: 'Account delete',
};

export function AdminSecurityTab() {
  const { rest, user: self } = useAuth();
  const toasts = useToasts();
  // Moderators only get the log; config + banned words are admin-only.
  const selfIsAdmin = self?.isAdmin === true;
  const [config, setConfig] = useState<SecurityConfig | null>(null);
  const [words, setWords] = useState<string[]>([]);
  const [events, setEvents] = useState<SecurityEvent[]>([]);
  const [kindFilter, setKindFilter] = useState<KindFilter>();
  const [newWord, setNewWord] = useState('');
  const [showPreset, setShowPreset] = useState(false);
  const [loading, setLoading] = useState(true);

  const loadEvents = useCallback(
    async (kind?: KindFilter) => {
      try {
        const r = await rest.adminSecurityEvents({ kind });
        setEvents(r.events);
      } catch {
        // surfaced via the empty state
      }
    },
    [rest],
  );

  useEffect(() => {
    let cancelled = false;
    (async () => {
      if (!selfIsAdmin) {
        // Moderator view: the log is the whole tab.
        setLoading(false);
        return;
      }
      try {
        const [cfg, w] = await Promise.all([
          rest.adminSecurityConfig(),
          rest.adminSecurityWords(),
        ]);
        if (cancelled) return;
        setConfig(cfg.config);
        setWords(w.words);
      } catch (e) {
        toasts.push(e instanceof Error ? e.message : 'Failed to load security settings', 'error');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    void loadEvents();
    return () => {
      cancelled = true;
    };
  }, [rest, loadEvents, toasts, selfIsAdmin]);

  const patch = async (p: Partial<SecurityConfig>) => {
    if (!config) return;
    const prev = config;
    setConfig({ ...config, ...p }); // optimistic
    try {
      const r = await rest.adminPatchSecurityConfig(p);
      setConfig(r.config);
    } catch (e) {
      setConfig(prev);
      toasts.push(e instanceof Error ? e.message : 'Update failed', 'error');
    }
  };

  const addWord = async () => {
    const word = newWord.trim();
    if (!word) return;
    setNewWord('');
    try {
      const r = await rest.adminAddSecurityWord(word);
      setWords(r.words);
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : 'Could not add word', 'error');
    }
  };

  const removeWord = async (word: string) => {
    try {
      const r = await rest.adminRemoveSecurityWord(word);
      setWords(r.words);
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : 'Could not remove word', 'error');
    }
  };

  if (loading) {
    return <div className="text-sm text-ink-3 py-10 text-center">Loading security settings…</div>;
  }

  return (
    <div className="max-w-3xl space-y-8">
      {/* ── Spam protection (admin-only) ────────────────────────────── */}
      {selfIsAdmin && (
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
          Spam protection
        </h2>
        {config && (
          <div className="bg-bg-2 border border-line rounded-lg divide-y divide-line">
            <ToggleRow
              label="Rate-limit spammers"
              description="After the trigger, the sender is limited to 1 message per minute for the cooldown."
              checked={config.spamEnabled}
              onChange={(v) => void patch({ spamEnabled: v })}
            />
            <StepperRow
              label="Trigger"
              detail={`messages within ${config.spamWindowSeconds}s`}
              value={config.spamMaxMessages}
              min={2}
              max={100}
              onChange={(v) => void patch({ spamMaxMessages: v })}
            />
            <StepperRow
              label="Window"
              detail="seconds measured"
              value={config.spamWindowSeconds}
              min={2}
              max={300}
              onChange={(v) => void patch({ spamWindowSeconds: v })}
            />
            <StepperRow
              label="Cooldown"
              detail="seconds at 1 msg/min"
              value={config.spamCooldownSeconds}
              min={60}
              max={86400}
              step={60}
              onChange={(v) => void patch({ spamCooldownSeconds: v })}
            />
          </div>
        )}
      </section>
      )}

      {/* ── Banned words (admin-only) ───────────────────────────────── */}
      {selfIsAdmin && (
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Banned words</h2>
        {config && (
          <div className="bg-bg-2 border border-line rounded-lg">
            <ToggleRow
              label="Block banned words"
              description="Messages containing a banned word are rejected and logged below. E2EE chats are exempt — their content is never inspected."
              checked={config.wordFilterEnabled}
              onChange={(v) => void patch({ wordFilterEnabled: v })}
            />
          </div>
        )}
        <div className="flex gap-2">
          <input
            value={newWord}
            onChange={(e) => setNewWord(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void addWord();
            }}
            placeholder="add a word…"
            autoCapitalize="none"
            autoCorrect="off"
            className="flex-1 px-3 py-2 text-sm bg-bg-2 border border-line rounded-lg text-ink-1 placeholder:text-ink-3 focus:outline-none focus:border-accent/60"
          />
          <button
            type="button"
            onClick={() => void addWord()}
            disabled={!newWord.trim()}
            className="px-3 py-2 rounded-lg bg-accent text-white disabled:opacity-40"
            aria-label="Add word"
          >
            <Plus size={16} />
          </button>
        </div>
        <button
          type="button"
          onClick={() => setShowPreset(true)}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-accent/10 text-accent text-sm font-medium hover:bg-accent/20 transition-colors"
        >
          <Shield size={14} />
          Common wordlist…
        </button>
        <p className="text-xs text-ink-3">
          Browse a standard profanity + slur list and add words individually, or add all at once.
        </p>
        {words.length === 0 ? (
          <p className="text-xs text-ink-3">
            No banned words yet. Messages containing a banned word are rejected and reported here.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {words.map((w) => (
              <span
                key={w}
                className="flex items-center gap-1 pl-2.5 pr-1.5 py-1 rounded-lg bg-bg-2 border border-line font-mono text-xs text-ink-1"
              >
                {w}
                <button
                  type="button"
                  onClick={() => void removeWord(w)}
                  className="text-ink-3 hover:text-red-400 transition-colors"
                  aria-label={`Remove ${w}`}
                >
                  <CloseIcon size={12} />
                </button>
              </span>
            ))}
          </div>
        )}
      </section>
      )}

      {/* ── Security log ────────────────────────────────────────────── */}
      <section className="space-y-3">
        <h2 className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Security log</h2>
        <div className="flex gap-1.5 flex-wrap">
          {(
            [
              [undefined, 'All'],
              ['spam_limited', 'Spam'],
              ['banned_word', 'Banned words'],
              ['staff', 'Staff actions'],
            ] as Array<[KindFilter, string]>
          ).map(([k, label]) => (
            <button
              key={label}
              type="button"
              onClick={() => {
                setKindFilter(k);
                void loadEvents(k);
              }}
              className={`px-2.5 py-1 rounded-full text-xs transition-colors ${
                kindFilter === k
                  ? 'bg-accent/20 text-accent border border-accent/40'
                  : 'bg-bg-2 text-ink-3 border border-line hover:text-ink-2'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {events.length === 0 ? (
          <p className="text-sm text-ink-3 py-6 text-center">Nothing logged. That's a good sign.</p>
        ) : (
          <ul className="space-y-2">
            {events.map((ev) => {
              const isStaff = ev.kind.startsWith('staff_');
              const badge = isStaff
                ? (STAFF_KIND_LABELS[ev.kind] ?? 'Staff action')
                : ev.kind === 'spam_limited'
                  ? 'Spam limited'
                  : 'Banned word';
              const actor = ev.actorDisplayName ?? ev.actorUsername;
              const target = ev.displayName ?? ev.username;
              return (
                <li key={ev.id} className="bg-bg-2 border border-line rounded-lg px-3 py-2.5">
                  <div className="flex items-center gap-2 text-xs">
                    <span
                      className={`px-1.5 py-0.5 rounded font-medium ${
                        isStaff
                          ? 'bg-sky-500/15 text-sky-400'
                          : ev.kind === 'spam_limited'
                            ? 'bg-amber-500/15 text-amber-400'
                            : 'bg-red-500/15 text-red-400'
                      }`}
                    >
                      {badge}
                    </span>
                    {/* Staff rows read "actor → target"; detection rows just
                        name the offender. */}
                    {isStaff ? (
                      <span className="text-ink-2 font-medium truncate">
                        {actor ?? 'Unknown staff'}
                        {target && <span className="text-ink-3 font-normal"> → {target}</span>}
                      </span>
                    ) : (
                      <span className="text-ink-2 font-medium truncate">
                        {target ?? 'Unknown user'}
                      </span>
                    )}
                    <span className="text-ink-3 ml-auto shrink-0">
                      {new Date(ev.createdAt).toLocaleString()}
                    </span>
                  </div>
                  <p className="text-sm text-ink-2 mt-1">{ev.detail}</p>
                  {ev.contentSnapshot && (
                    <p className="text-xs text-ink-3 font-mono mt-1 bg-bg-1 rounded px-2 py-1 break-words">
                      {ev.contentSnapshot}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {showPreset && (
        <PresetWordsModal
          words={words}
          onWords={setWords}
          onClose={() => setShowPreset(false)}
        />
      )}
    </div>
  );
}

/** Modal browser for the server's common wordlist (tap to add; Add all). */
function PresetWordsModal({
  words,
  onWords,
  onClose,
}: {
  words: string[];
  onWords: (w: string[]) => void;
  onClose: () => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [preset, setPreset] = useState<string[] | null>(null);
  const [addingAll, setAddingAll] = useState(false);

  useEffect(() => {
    let cancelled = false;
    rest
      .adminSecurityWordPreset()
      .then((r) => {
        if (!cancelled) setPreset(r.words);
      })
      .catch((e) => {
        toasts.push(e instanceof Error ? e.message : 'Could not load preset', 'error');
        if (!cancelled) setPreset([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rest, toasts]);

  const add = async (w: string) => {
    try {
      const r = await rest.adminAddSecurityWord(w);
      onWords(r.words);
    } catch {
      /* pill stays unadded */
    }
  };

  const addAll = async () => {
    setAddingAll(true);
    try {
      const r = await rest.adminLoadSecurityWordPreset();
      onWords(r.words);
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : 'Bulk add failed', 'error');
    } finally {
      setAddingAll(false);
    }
  };

  const allAdded = preset !== null && preset.every((w) => words.includes(w));

  return (
    <div
      className="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4"
      onClick={onClose}
      role="dialog"
      aria-label="Common wordlist"
    >
      <div
        className="bg-bg-1 border border-line rounded-xl w-full max-w-2xl max-h-[80vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 px-4 py-3 border-b border-line">
          <h3 className="text-sm font-semibold text-ink-1 flex-1">Common wordlist</h3>
          <button
            type="button"
            onClick={() => void addAll()}
            disabled={addingAll || allAdded}
            className="px-3 py-1.5 rounded-full bg-accent/10 text-accent text-xs font-semibold hover:bg-accent/20 disabled:opacity-40 transition-colors"
          >
            {addingAll ? 'Adding…' : 'Add all'}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="text-ink-3 hover:text-ink-1"
            aria-label="Close"
          >
            <CloseIcon size={18} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto scrollbar-thin">
          <p className="text-xs text-ink-3 mb-3">
            Tap a word to ban it on this instance. Checked words are already banned.
          </p>
          {preset === null ? (
            <p className="text-sm text-ink-3 py-8 text-center">Loading…</p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-1.5">
              {preset.map((w) => {
                const added = words.includes(w);
                return (
                  <button
                    key={w}
                    type="button"
                    disabled={added}
                    onClick={() => void add(w)}
                    className={`flex items-center gap-1.5 px-2 py-1.5 rounded-lg border font-mono text-xs text-left transition-colors ${
                      added
                        ? 'bg-bg-2/60 border-line text-ink-3'
                        : 'bg-bg-2 border-accent/30 text-ink-1 hover:border-accent/60'
                    }`}
                  >
                    <span className={added ? 'text-emerald-400' : 'text-accent'}>
                      {added ? '✓' : '+'}
                    </span>
                    <span className="truncate">{w}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/** Switch row matching the settings-panel toggle styling. */
function ToggleRow({
  label,
  description,
  checked,
  onChange,
}: {
  label: string;
  description?: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">{label}</p>
        {description && <p className="text-xs text-ink-3 leading-relaxed mt-0.5">{description}</p>}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        aria-label={label}
        onClick={() => onChange(!checked)}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          checked ? 'bg-accent/70' : 'bg-bg-3'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            checked ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

/** Numeric stepper row (− value +) for the spam thresholds. */
function StepperRow({
  label,
  detail,
  value,
  min,
  max,
  step = 1,
  onChange,
}: {
  label: string;
  detail: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (v: number) => void;
}) {
  const clamp = (v: number) => Math.min(max, Math.max(min, v));
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">{label}</p>
        <p className="text-xs text-ink-3 mt-0.5">{detail}</p>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onClick={() => onChange(clamp(value - step))}
          disabled={value <= min}
          className="w-7 h-7 rounded-md bg-bg-3 text-ink-2 hover:text-ink-1 disabled:opacity-40"
          aria-label={`Decrease ${label}`}
        >
          −
        </button>
        <span className="font-mono text-sm text-ink-1 w-14 text-center">{value}</span>
        <button
          type="button"
          onClick={() => onChange(clamp(value + step))}
          disabled={value >= max}
          className="w-7 h-7 rounded-md bg-bg-3 text-ink-2 hover:text-ink-1 disabled:opacity-40"
          aria-label={`Increase ${label}`}
        >
          +
        </button>
      </div>
    </div>
  );
}
