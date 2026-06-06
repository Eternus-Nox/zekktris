/**
 * ForumView
 * ---------
 * Content pane for guild_forum channels. Shows a list of posts in the
 * forum, where each post is a public_thread under the forum. Clicking
 * a post navigates to /channels/<guild>/<post-thread-id>, which renders
 * in MessageView (threads are channels with a message stream).
 *
 * Compositional model:
 *   - Forum channel (this view)                         ← list of posts
 *     └── public_thread (post)  → MessageView          ← post body + replies
 *         (anchor-less; first message inside it is the post body)
 *
 * "New post" composer is a two-field form (title + content) that hits
 * POST /channels/<forumId>/posts. On success we have both the new post
 * (thread channel) AND its first message — we navigate into the post
 * and the message stream renders the body immediately because AppState
 * received MESSAGE_CREATE over the gateway during the same request.
 *
 * Layout matches the other content panes: 12-row header strip at top
 * (Forum icon + channel name), scrollable list of posts below.
 */

import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError, type Channel } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState, isChannelUnread, channelMentionCount } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Forum, Plus, X, Archive } from '../lib/icons';

type AutoArchiveMinutes = 60 | 1440 | 4320 | 10080;
const AUTO_ARCHIVE_PRESETS: { value: AutoArchiveMinutes; label: string }[] = [
  { value: 60, label: '1 hour' },
  { value: 1440, label: '1 day' },
  { value: 4320, label: '3 days' },
  { value: 10080, label: '1 week' },
];
const AUTO_ARCHIVE_STORAGE_KEY = 'zekktris.forumAutoArchive';
const SHOW_ARCHIVED_STORAGE_KEY = 'zekktris.forumShowArchived';

function loadAutoArchive(): AutoArchiveMinutes {
  // Reads the user's last-picked duration. Defaults to 3 days, the
  // most balanced preset. Invalid stored values fall through to the
  // default rather than throwing.
  if (typeof localStorage === 'undefined') return 4320;
  const raw = localStorage.getItem(AUTO_ARCHIVE_STORAGE_KEY);
  if (!raw) return 4320;
  const n = Number(raw);
  if (n === 60 || n === 1440 || n === 4320 || n === 10080) return n;
  return 4320;
}
function saveAutoArchive(v: AutoArchiveMinutes): void {
  try {
    localStorage.setItem(AUTO_ARCHIVE_STORAGE_KEY, String(v));
  } catch {
    // localStorage can fail in private windows / disabled storage —
    // silently no-op since this is a UX preference, not core data.
  }
}
function loadShowArchived(): boolean {
  // Default true (matches the long-standing behavior of mixing archived
  // posts at the bottom). Users can hide them to declutter active forums.
  if (typeof localStorage === 'undefined') return true;
  const raw = localStorage.getItem(SHOW_ARCHIVED_STORAGE_KEY);
  if (raw === null) return true;
  return raw === 'true';
}
function saveShowArchived(v: boolean): void {
  try {
    localStorage.setItem(SHOW_ARCHIVED_STORAGE_KEY, String(v));
  } catch {
    // see comment in saveAutoArchive
  }
}

export function ForumView({ channel }: { channel: Channel }) {
  const { rest } = useAuth();
  const { state } = useAppState();
  const toasts = useToasts();
  const navigate = useNavigate();

  // Posts are threads under this forum. The /channels/:id/threads
  // endpoint returns them sorted active-first, newest-first. We refresh
  // on mount + after a new post is created.
  const [posts, setPosts] = useState<Channel[] | null>(null);
  const [composing, setComposing] = useState(false);

  // ── Composer state ──────────────────────────────────────────────────
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [composerError, setComposerError] = useState<string | null>(null);
  // Auto-archive duration for the next post. Initialised from
  // localStorage so the user's preference sticks across sessions.
  const [autoArchive, setAutoArchive] = useState<AutoArchiveMinutes>(() =>
    loadAutoArchive(),
  );
  function changeAutoArchive(v: AutoArchiveMinutes) {
    setAutoArchive(v);
    saveAutoArchive(v);
  }

  // ── List preferences ────────────────────────────────────────────────
  // showArchived: include archived posts in the rendered list. When off,
  // they're filtered client-side — the server still returns them since
  // power users can flip the toggle to see history without a refetch.
  const [showArchived, setShowArchived] = useState<boolean>(() =>
    loadShowArchived(),
  );
  function toggleShowArchived() {
    setShowArchived((prev) => {
      const next = !prev;
      saveShowArchived(next);
      return next;
    });
  }

  async function refresh() {
    try {
      const r = await rest.listForumPosts(channel.id);
      setPosts(r.threads);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to load posts', 'error');
    }
  }

  useEffect(() => {
    setPosts(null);
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel.id]);

  // AppState's gateway reducer routes CHANNEL_CREATE for the new post
  // into channelsByGuild, so we can also derive the post list from
  // local state for live-update parity. We still seed from the API on
  // mount so we get archived posts that AppState might not have hot
  // in memory.
  const localPosts = (state.channelsByGuild[channel.guildId ?? ''] ?? [])
    .filter((c) => c.type === 'public_thread' && c.parentId === channel.id);
  // Merge: local takes precedence (newest from gateway), fall back to
  // the API-loaded list. Deduplicate by id.
  const mergedPostsAll = mergeById(localPosts, posts ?? []);
  // Apply showArchived preference. When off, archived posts are removed
  // entirely from the render — the underlying server response is left
  // intact so flipping the toggle back on doesn't require a refetch.
  const mergedPosts = showArchived
    ? mergedPostsAll
    : mergedPostsAll.filter((p) => p.threadArchivedAt == null);
  const hiddenArchivedCount = showArchived
    ? 0
    : mergedPostsAll.length - mergedPosts.length;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    if (!title.trim() || !body.trim()) {
      setComposerError('Title and content are both required.');
      return;
    }
    setSubmitting(true);
    setComposerError(null);
    try {
      const r = await rest.createForumPost(channel.id, {
        title: title.trim(),
        content: body.trim(),
        autoArchiveMinutes: autoArchive,
      });
      // Reset composer + navigate into the new post. The gateway
      // events for CHANNEL_CREATE + MESSAGE_CREATE will populate
      // AppState in parallel; the destination page reads them either
      // way (it doesn't depend on a specific fan-out timing).
      setTitle('');
      setBody('');
      setComposing(false);
      navigate(`/channels/${channel.guildId}/${r.post.id}`);
    } catch (err) {
      setComposerError(err instanceof ApiError ? err.message : 'Failed to create post');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="h-full bg-bg-1 text-ink-1 flex flex-col">
      <header
        className="h-12 border-b px-3 sm:px-4 pl-12 xl:pl-4 flex items-center gap-2 sm:gap-3 shrink-0"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <Forum size={16} className="text-accent shrink-0" />
        <h1 className="text-base sm:text-lg font-semibold truncate">{channel.name ?? '(unnamed forum)'}</h1>
        <div className="ml-auto flex items-center gap-1 sm:gap-2 shrink-0">
          {/* Show-archived toggle. On mobile this is an icon-only
              button (saves precious header space); on sm+ it's a
              labeled button. Persisted via localStorage so the
              user's preference sticks across navigation. */}
          <button
            type="button"
            onClick={toggleShowArchived}
            className={`inline-flex items-center justify-center sm:gap-1.5 w-8 h-8 sm:w-auto sm:h-auto sm:px-2.5 sm:py-1 rounded-md text-xs font-medium transition-colors ${
              showArchived
                ? 'bg-bg-3 text-ink-2 hover:text-ink-1'
                : 'bg-bg-3/50 text-ink-3 hover:bg-bg-3 hover:text-ink-2'
            }`}
            aria-pressed={showArchived}
            title={showArchived ? 'Hide archived posts' : 'Show archived posts'}
            aria-label={showArchived ? 'Hide archived posts' : 'Show archived posts'}
          >
            <Archive size={14} className="sm:hidden" />
            <span className="hidden sm:inline">
              {showArchived ? 'Hide archived' : 'Show archived'}
            </span>
          </button>
          {/* "New post" toggle — opens the composer panel below.
              On mobile: icon only. On sm+: icon + label. */}
          <button
            type="button"
            onClick={() => setComposing((v) => !v)}
            className={`inline-flex items-center justify-center sm:gap-1.5 w-8 h-8 sm:w-auto sm:h-auto sm:px-3 sm:py-1 rounded-md text-xs font-medium transition-colors ${
              composing
                ? 'bg-bg-3 text-ink-1'
                : 'bg-accent text-white hover:bg-accent/90'
            }`}
            aria-expanded={composing}
            aria-label={composing ? 'Cancel new post' : 'New post'}
            title={composing ? 'Cancel' : 'New post'}
          >
            {composing ? (
              <>
                <X size={14} />
                <span className="hidden sm:inline">Cancel</span>
              </>
            ) : (
              <>
                <Plus size={14} />
                <span className="hidden sm:inline">New post</span>
              </>
            )}
          </button>
        </div>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        {/* Composer — inline panel that takes ~30vh when open. Two
            fields: title (short, 1 line) + content (textarea, grows).
            Submits via Cmd/Ctrl+Enter or the explicit button. */}
        {composing && (
          <form
            onSubmit={submit}
            className="border-b border-line bg-bg-2/40 px-4 sm:px-6 py-4"
          >
            <div className="max-w-2xl mx-auto space-y-3">
              <label className="block">
                <span className="text-xs uppercase tracking-wider font-semibold text-ink-3">
                  Post title
                </span>
                <input
                  type="text"
                  autoFocus
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  maxLength={100}
                  placeholder="What's this post about?"
                  className="mt-1.5 w-full bg-bg-1 border border-line rounded-md px-3 py-2 outline-none focus:border-accent transition-colors"
                  required
                />
              </label>
              <label className="block">
                <span className="text-xs uppercase tracking-wider font-semibold text-ink-3">
                  Body
                </span>
                <textarea
                  value={body}
                  onChange={(e) => setBody(e.target.value)}
                  rows={4}
                  maxLength={4000}
                  placeholder="Write your post…"
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                      submit(e as unknown as React.FormEvent);
                    }
                  }}
                  className="mt-1.5 w-full bg-bg-1 border border-line rounded-md px-3 py-2 outline-none focus:border-accent transition-colors resize-y"
                  required
                />
              </label>
              {composerError && (
                <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                  {composerError}
                </div>
              )}
              <div className="flex items-center justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-3 flex-wrap">
                  {/* Auto-archive duration picker. Inline select keeps
                      the footer compact. The label is concise; the
                      tooltip on the select explains what archives means
                      for users who haven't encountered the lifecycle
                      yet. Choice persists to localStorage. */}
                  <label className="flex items-center gap-1.5 text-xs text-ink-3">
                    <span className="shrink-0">Archive after</span>
                    <select
                      value={autoArchive}
                      onChange={(e) =>
                        changeAutoArchive(Number(e.target.value) as AutoArchiveMinutes)
                      }
                      title="How long the post stays open with no activity before auto-archiving"
                      className="bg-bg-3 border border-line rounded px-2 py-0.5 text-ink-1 text-xs outline-none focus:border-accent"
                    >
                      {AUTO_ARCHIVE_PRESETS.map((p) => (
                        <option key={p.value} value={p.value}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                    <span className="shrink-0">of inactivity</span>
                  </label>
                </div>
                <button
                  type="submit"
                  disabled={submitting || !title.trim() || !body.trim()}
                  className="px-4 py-1.5 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-60 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
                >
                  {submitting ? 'Posting…' : 'Post'}
                </button>
              </div>
            </div>
          </form>
        )}

        <div className="max-w-3xl mx-auto px-4 sm:px-6 py-4 sm:py-6">
          {posts === null && (
            <p className="text-sm text-ink-3 italic py-6 text-center">Loading posts…</p>
          )}
          {posts !== null && mergedPosts.length === 0 && (
            <div className="text-center py-12">
              <Forum size={32} className="mx-auto text-ink-3 mb-3" />
              <p className="text-sm text-ink-2 font-medium">No posts yet</p>
              <p className="text-xs text-ink-3 mt-1">
                Be the first to post — click <span className="font-medium text-ink-2">New post</span> to start.
              </p>
            </div>
          )}
          {posts !== null && mergedPosts.length > 0 && (
            <ul className="divide-y divide-line border border-line rounded-md bg-bg-2 overflow-hidden">
              {mergedPosts.map((p) => (
                <PostRow key={p.id} post={p} guildId={channel.guildId ?? ''} />
              ))}
            </ul>
          )}
          {/* Filter-hint footer — appears under the list when the
              showArchived toggle is hiding posts. Click the inline link
              to flip the toggle and reveal them without refetching. */}
          {hiddenArchivedCount > 0 && (
            <p className="text-xs text-ink-3 text-center mt-4">
              {hiddenArchivedCount} archived {hiddenArchivedCount === 1 ? 'post' : 'posts'} hidden ·{' '}
              <button
                type="button"
                onClick={toggleShowArchived}
                className="underline hover:text-ink-1 transition-colors"
              >
                Show all
              </button>
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

/** Single row in the posts list. Renders title + archived state +
    unread/mention badges. Click navigates to the post (thread) which
    opens its message stream. */
function PostRow({ post, guildId }: { post: Channel; guildId: string }) {
  const { state } = useAppState();
  const archived = post.threadArchivedAt != null;

  // Unread + mention state. Uses the same helpers the channel list does
  // (read_states are populated by gateway events on every message
  // create), so a forum post the user hasn't opened — or has opened
  // but not caught up on — shows the same accent dot they'd see for
  // any channel.
  const unread = isChannelUnread(post, state.readStateByChannel);
  const mentions = channelMentionCount(post.id, state.readStateByChannel);

  // Reply count from the locally-cached message list. The first
  // message in a forum post is the post body, so subtract 1 for the
  // "reply" count. When the user hasn't opened the post yet there's
  // no cached list — show "—" rather than a misleading 0.
  const cachedMessages = state.messagesByChannel[post.id];
  const replyCount =
    cachedMessages !== undefined
      ? Math.max(0, cachedMessages.length - 1)
      : null;

  // Relative last-activity time. For posts created in the last few
  // minutes show "just now"; otherwise pick the most natural unit.
  // Falls back to absolute date for posts older than ~2 weeks.
  const lastActivityLabel = useMemo(() => {
    const iso = post.threadLastActivityAt;
    if (!iso) return null;
    const dt = new Date(iso);
    const ms = Date.now() - dt.getTime();
    if (ms < 60_000) return 'just now';
    if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
    if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
    if (ms < 14 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
    return dt.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }, [post.threadLastActivityAt]);

  return (
    <li>
      <Link
        to={`/channels/${guildId}/${post.id}`}
        className="block px-4 py-3 hover:bg-bg-3/50 transition-colors"
      >
        <div className="flex items-center gap-2 mb-0.5">
          {/* Unread indicator — small accent dot that reads at the row
              start. Skipped for archived posts since they're terminal
              and the dot would look stuck. */}
          {unread && !archived && (
            <span
              className="w-1.5 h-1.5 rounded-full bg-accent shrink-0"
              aria-hidden
            />
          )}
          <span
            className={`text-sm truncate ${
              archived
                ? 'text-ink-3 line-through font-medium'
                : unread
                  ? 'text-ink-1 font-semibold'
                  : 'text-ink-1 font-medium'
            }`}
          >
            {post.name ?? '(untitled post)'}
          </span>
          {archived && (
            <span className="text-[0.6rem] uppercase tracking-wider text-ink-3 bg-bg-3 px-1.5 py-0.5 rounded shrink-0">
              archived
            </span>
          )}
          {/* Mention count — red pill on the right of the title.
              Mirrors the channel-list mention badge styling. */}
          {mentions > 0 && (
            <span
              className="ml-auto shrink-0 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-red-500 text-white text-[0.65rem] font-semibold"
              aria-label={`${mentions} mention${mentions === 1 ? '' : 's'}`}
            >
              {mentions > 99 ? '99+' : mentions}
            </span>
          )}
        </div>
        {/* Subtitle: reply count + last activity. Both render only
            when the data is available; if neither is, the line collapses
            entirely so the row stays tight. */}
        {(replyCount !== null || lastActivityLabel) && (
          <div className="flex items-center gap-2 text-[0.7rem] text-ink-3">
            {replyCount !== null && (
              <span>
                {replyCount === 0
                  ? 'No replies yet'
                  : `${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
              </span>
            )}
            {replyCount !== null && lastActivityLabel && (
              <span className="text-ink-3/60">·</span>
            )}
            {lastActivityLabel && <span>{lastActivityLabel}</span>}
          </div>
        )}
      </Link>
    </li>
  );
}

/** Merge two arrays of Channel objects, deduplicating by id. Earlier
    entries take precedence (used to make local-state posts override
    API-loaded ones when the gateway lands a fresh row). */
function mergeById(a: Channel[], b: Channel[]): Channel[] {
  const seen = new Set<string>();
  const out: Channel[] = [];
  for (const c of [...a, ...b]) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    out.push(c);
  }
  // Sort: active first (archived last), newest first within each group.
  // Matches the server's listThreadsForChannel ordering, applied after
  // the merge so a freshly-created post lands at the top.
  out.sort((x, y) => {
    const xArchived = x.threadArchivedAt != null ? 1 : 0;
    const yArchived = y.threadArchivedAt != null ? 1 : 0;
    if (xArchived !== yArchived) return xArchived - yArchived;
    return x.id < y.id ? 1 : -1;
  });
  return out;
}
