/**
 * PollMessage
 * -----------
 * Renders an inline poll inside a message bubble. Vote/unvote handlers
 * are optimistic — we mutate the local poll snapshot immediately and
 * fire the REST call; the server's MESSAGE_UPDATE broadcast will
 * arrive shortly with the canonical tallies. If the REST call fails,
 * we revert and toast.
 *
 * Visual:
 *   - Question header (bold)
 *   - Each option as a row: text on the left, vote count + percentage
 *     on the right; a horizontal bar fills proportionally to the
 *     fraction-of-total-voters.
 *   - Footer: "X people voted" + "Ends in 3h" / "Final results"
 *   - "End now" button if the user is the message author
 */

import { useEffect, useMemo, useState } from 'react';
import type { Poll, PollOption } from '@zekktris/client';
import { ApiError } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { useAppStateSelector } from '../state/AppState';

interface Props {
  channelId: string;
  messageId: string;
  poll: Poll;
  /** The id of the user who authored the host message — they can end the poll early. */
  authorId: string | null;
}

export function PollMessage({ channelId, messageId, poll: initial, authorId }: Props) {
  const { rest, user } = useAuth();
  const toasts = useToasts();
  const setPollLocal = useAppStateSelector((v) => v.setPollLocal);

  // Local snapshot of the poll for optimistic rendering. The canonical
  // copy lives in the message that's stored in AppState; whenever the
  // app re-renders this message (gateway MESSAGE_UPDATE → state diff
  // → React re-render), the `initial` prop changes and we resync.
  const [snapshot, setSnapshot] = useState<Poll>(initial);
  useEffect(() => {
    setSnapshot(initial);
  }, [initial]);

  const isClosed =
    !!snapshot.closedAt ||
    (snapshot.expiresAt !== null && new Date(snapshot.expiresAt).getTime() <= Date.now());

  // Time remaining until the expires_at — re-rendered every 15s for
  // smooth countdown. We don't tick every second to keep React work
  // bounded; the user gets close-enough granularity.
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (isClosed || !snapshot.expiresAt) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [isClosed, snapshot.expiresAt]);

  const myVotes = useMemo(() => new Set(snapshot.myVotes), [snapshot.myVotes]);
  const totalVoters = snapshot.totalVoters;
  const isAuthor = !!user && authorId === user.id;

  async function vote(option: PollOption) {
    if (isClosed) return;
    const alreadyVoted = myVotes.has(option.id);
    // Optimistic snapshot update. Two cases:
    //  - alreadyVoted → remove this vote
    //  - !alreadyVoted single-choice → switch all my votes to this option
    //  - !alreadyVoted multi-choice → add this option to my votes
    const next = applyVote(snapshot, option, alreadyVoted);
    setSnapshot(next);

    try {
      if (alreadyVoted) {
        await rest.removePollVote(channelId, snapshot.id, option.id);
      } else {
        await rest.voteOnPoll(channelId, snapshot.id, option.id);
      }
      // Persist the snapshot into the canonical message: the server's
      // MESSAGE_UPDATE broadcast is shared by every recipient and carries
      // no per-user vote state, so the user's own selection must live in
      // AppState (MESSAGE_PATCH preserves it on each broadcast resync).
      setPollLocal(channelId, messageId, next);
    } catch (e) {
      // Revert to the canonical copy and surface the error via a toast.
      toasts.push(e instanceof ApiError ? e.message : 'Vote failed', 'error');
      setSnapshot(initial);
    }
  }

  async function end() {
    if (isClosed) return;
    if (!confirm('End this poll now? Final results will be locked in.')) return;
    try {
      await rest.endPoll(channelId, snapshot.id);
      // Server will broadcast MESSAGE_UPDATE with closedAt set.
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not end poll', 'error');
    }
  }

  return (
    <div className="mt-2 max-w-md border border-line rounded-lg bg-bg-2 p-3 space-y-2">
      <div className="font-semibold text-sm text-ink-1 leading-snug">{snapshot.question}</div>

      <ul className="space-y-1.5">
        {snapshot.options
          .slice()
          .sort((a, b) => a.position - b.position)
          .map((opt) => {
            const pct =
              totalVoters > 0 ? Math.round((opt.voteCount / totalVoters) * 100) : 0;
            const voted = myVotes.has(opt.id);
            return (
              <li key={opt.id}>
                <button
                  type="button"
                  onClick={() => void vote(opt)}
                  disabled={isClosed}
                  className={`relative w-full text-left rounded border px-3 py-2 text-sm overflow-hidden transition-colors ${
                    voted
                      ? 'border-accent bg-accent/10 text-ink-1'
                      : 'border-line text-ink-1 hover:bg-bg-3'
                  } ${isClosed ? 'cursor-default' : 'cursor-pointer'}`}
                  aria-pressed={voted}
                >
                  {/* Bar fill — sits behind the text. We use width %
                      tied to the option's share of total voters. The
                      transition is subtle (200ms) so the bar animates
                      smoothly when votes arrive over the gateway. */}
                  <span
                    aria-hidden
                    className={`absolute inset-0 transition-[width] duration-200 ${
                      voted ? 'bg-accent/20' : 'bg-bg-3/50'
                    }`}
                    style={{ width: `${pct}%` }}
                  />
                  <span className="relative flex items-center justify-between gap-3">
                    <span className="flex items-center gap-2 min-w-0">
                      {voted && (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="3"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          className="text-accent shrink-0"
                          aria-hidden
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      )}
                      <span className="truncate">{opt.text}</span>
                    </span>
                    <span className="text-xs text-ink-3 shrink-0 tabular-nums">
                      {opt.voteCount} · {pct}%
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
      </ul>

      <div className="flex items-center justify-between gap-2 text-xs text-ink-3 pt-1">
        <span>
          {totalVoters} {totalVoters === 1 ? 'vote' : 'votes'}
          {snapshot.multipleChoice && totalVoters > 0 && ' · multiple choice'}
        </span>
        <span className="flex items-center gap-2">
          <span>
            {isClosed
              ? 'Final results'
              : snapshot.expiresAt
                ? `Ends ${formatRelativeFuture(snapshot.expiresAt, now)}`
                : 'No end'}
          </span>
          {!isClosed && isAuthor && (
            <button
              type="button"
              onClick={() => void end()}
              className="text-accent hover:underline"
            >
              End now
            </button>
          )}
        </span>
      </div>
    </div>
  );
}

/**
 * Pure optimistic vote transition: given the current poll snapshot and the
 * toggled option, return the next snapshot (updated myVotes + tallies).
 * Single-choice switches all prior votes to the new option; the server's
 * exact tallies replace ours on the next MESSAGE_UPDATE.
 */
function applyVote(prev: Poll, option: PollOption, alreadyVoted: boolean): Poll {
  const newMyVotes = new Set(prev.myVotes);
  const opts = prev.options.map((o) => ({ ...o }));

  function dec(optId: string) {
    const o = opts.find((x) => x.id === optId);
    if (o && o.voteCount > 0) o.voteCount--;
  }
  function inc(optId: string) {
    const o = opts.find((x) => x.id === optId);
    if (o) o.voteCount++;
  }

  if (alreadyVoted) {
    newMyVotes.delete(option.id);
    dec(option.id);
  } else {
    if (!prev.multipleChoice) {
      // Clear all my prior votes, then add the new one.
      for (const id of newMyVotes) dec(id);
      newMyVotes.clear();
    }
    newMyVotes.add(option.id);
    inc(option.id);
  }

  // Recompute totalVoters from the myVote count delta. For single-
  // choice this stays at -1/0/+1; for multi-choice we estimate.
  const beforeHadAny = prev.myVotes.length > 0;
  const afterHasAny = newMyVotes.size > 0;
  let newTotal = prev.totalVoters;
  if (beforeHadAny && !afterHasAny) newTotal--;
  else if (!beforeHadAny && afterHasAny) newTotal++;

  return { ...prev, options: opts, myVotes: [...newMyVotes], totalVoters: Math.max(0, newTotal) };
}

/**
 * Format a future timestamp as "in 3h", "in 12m", "in 2d". Returns
 * "ending soon" when within the last minute. The `now` parameter
 * makes the function pure for testing — callers in this file pass
 * the live tick from useState.
 */
function formatRelativeFuture(iso: string, nowMs: number): string {
  const target = new Date(iso).getTime();
  const diffMs = target - nowMs;
  if (diffMs <= 0) return 'now';
  if (diffMs < 60_000) return 'in <1m';
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `in ${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    const remMin = minutes % 60;
    return remMin === 0 ? `in ${hours}h` : `in ${hours}h ${remMin}m`;
  }
  const days = Math.floor(hours / 24);
  return `in ${days}d`;
}
