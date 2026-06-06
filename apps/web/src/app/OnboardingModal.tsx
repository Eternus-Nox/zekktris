/**
 * OnboardingModal
 * ---------------
 * Full-screen overlay shown when a member of the active guild has
 * `membershipState === 'pending'`. Renders the guild's rules and
 * gates participation behind a single "I agree" click.
 *
 * Mounted at the Shell root so it overlays every guild view. It
 * intentionally has NO close button and NO Escape handler — the
 * whole point of an onboarding gate is that you can't get past it
 * without acknowledging. Users who want out of the server can still
 * click "Leave server" from the guild header, which we surface as
 * a secondary affordance in the modal footer.
 *
 * Rules rendering: v1 displays the rules text as preserved-newline
 * plain text via `whitespace-pre-wrap`. Admins typing rules in the
 * settings tab can use line breaks freely. Full markdown rendering
 * (headings, lists, bold, links) is deferred to a follow-up — adding
 * a markdown stack to the client bundle is non-trivial and plain
 * text covers most server-rules patterns adequately.
 */
import React, { useState, useEffect } from 'react';
import { ApiError, type Guild } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Portal } from '../lib/Portal';
import { Shield } from '../lib/icons';

/**
 * Auto-link URLs in the rules text. Splits on URL boundaries and
 * renders each URL as an external link. Other characters render
 * verbatim — the parent container uses whitespace-pre-wrap so
 * newlines and indentation are preserved.
 *
 * Boundary handling: the regex stops before trailing sentence
 * punctuation (`.,;:!?`) so a URL at the end of "see https://x.com."
 * gets linked as "https://x.com" with the period in the trailing
 * text — matches how every other surface in the app handles this.
 */
const URL_RE = /(https?:\/\/[^\s<>")(,]+[^\s<>")(,.;:!?])/g;

function renderRulesContent(text: string): React.ReactNode {
  if (text.length === 0) return null;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  let key = 0;
  URL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = URL_RE.exec(text)) !== null) {
    if (m.index > cursor) {
      parts.push(text.slice(cursor, m.index));
    }
    const url = m[0];
    parts.push(
      <a
        key={`url-${key++}`}
        href={url}
        target="_blank"
        rel="noopener noreferrer"
        className="text-accent hover:underline break-all"
      >
        {url}
      </a>,
    );
    cursor = m.index + url.length;
  }
  if (cursor < text.length) {
    parts.push(text.slice(cursor));
  }
  return parts;
}

export function OnboardingModal({ guild }: { guild: Guild }) {
  const { rest, user } = useAuth();
  const { state } = useAppState();
  const toasts = useToasts();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Find this user's member row in the active guild. The member list
  // is loaded eagerly when a guild becomes active; until that load
  // completes, this returns undefined and we render nothing — better
  // than flashing the rules modal during a transient unloaded state.
  const myMember = state.membersByGuild[guild.id]?.find((m) => m.userId === user?.id);

  // Render guards. Skip when:
  //   - user isn't loaded yet (boot race)
  //   - member row hasn't loaded (initial fetch in flight)
  //   - the guild has no rules content (no onboarding gate at all)
  //
  // Show when EITHER:
  //   - literal membershipState is 'pending' (first-time join), OR
  //   - member is 'active' but acknowledgment is stale relative to
  //     the guild's rulesUpdatedAt (admin updated rules after their
  //     prior acknowledgment).
  //
  // Stale-ack check: compares ISO timestamps as strings — both are
  // produced by isoDate() server-side so they're lexicographically
  // comparable. Missing rulesAcknowledgedAt (older DTOs without
  // the field) is treated as stale; clients pre-this-feature will
  // re-acknowledge once and then carry the field going forward.
  const isPending = myMember?.membershipState === 'pending';
  const hasRules = !!guild.rulesContent && guild.rulesContent.trim().length > 0;
  const isStaleAck =
    !!myMember &&
    myMember.membershipState === 'active' &&
    hasRules &&
    !!guild.rulesUpdatedAt &&
    (!myMember.rulesAcknowledgedAt ||
      myMember.rulesAcknowledgedAt < guild.rulesUpdatedAt);
  const shouldShow = !!user && !!myMember && hasRules && (isPending || isStaleAck);

  // Body scroll lock while the modal is open. Removed in the cleanup
  // so navigating away or being acknowledged unlocks normally.
  useEffect(() => {
    if (!shouldShow) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [shouldShow]);

  if (!shouldShow) return null;

  async function accept() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const r = await rest.acknowledgeOnboarding(guild.id);
      // alreadyActive is a benign race (e.g. another tab already
      // acknowledged). Either way the modal will dismiss when the
      // gateway broadcast updates our membershipState through the
      // reducer. Toast only on the actual flip path.
      if (!r.alreadyActive) {
        toasts.push(`Welcome to ${guild.name}`, 'success');
      }
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : 'Could not save your acknowledgment';
      setError(msg);
      setBusy(false);
    }
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 bg-bg-1/85 backdrop-blur-sm flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="onboarding-title"
      >
        <div className="zk-modal bg-bg-2 border border-line w-full max-w-2xl max-h-[88vh] flex flex-col shadow-2xl">
          {/* Header */}
          <div className="px-6 py-4 border-b border-line shrink-0">
            <div className="flex items-center gap-3">
              <span className="w-9 h-9 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
                <Shield size={18} className="text-accent" />
              </span>
              <div className="min-w-0">
                <h2 id="onboarding-title" className="text-lg font-semibold text-ink-1 truncate">
                  Welcome to {guild.name}
                </h2>
                <p className="text-xs text-ink-3 mt-0.5">
                  Please read the server rules before participating.
                </p>
              </div>
            </div>
          </div>

          {/* Rules body — scrolls if longer than viewport */}
          <div className="px-6 py-5 flex-1 overflow-y-auto">
            <div className="text-sm text-ink-1 whitespace-pre-wrap leading-relaxed">
              {renderRulesContent(guild.rulesContent ?? '')}
            </div>
          </div>

          {/* Footer */}
          <div className="px-6 py-4 border-t border-line shrink-0 space-y-3">
            {error && (
              <p className="text-xs text-red-300" role="alert">
                {error}
              </p>
            )}
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-ink-3 flex-1">
                By continuing, you agree to follow these rules. Moderators may issue warnings,
                timeouts, or bans for violations.
              </p>
              <button
                onClick={() => void accept()}
                disabled={busy}
                className="shrink-0 px-5 py-2 rounded-md bg-accent hover:bg-accent/85 text-bg-1 text-sm font-semibold disabled:opacity-60 transition-colors"
              >
                {busy ? 'Saving…' : 'I agree to these rules'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
