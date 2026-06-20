/**
 * ChannelCreateModal
 * ------------------
 * Triggered by the + button at the top of the channel list. Creates a new
 * text channel (or category) within the active guild.
 *
 * Validation: client-side rules mirror the server (name 1-100 chars, no
 * leading/trailing whitespace) — surfacing the rule before the round-trip
 * is friendlier than waiting for the API to 400.
 *
 * Permission UX: the button that opens this modal is shown to anyone for
 * simplicity; the API rejects with 403 if the user lacks MANAGE_CHANNELS,
 * which we surface as a toast. A future round can fetch effective
 * permissions and hide the button preemptively.
 */
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type Guild } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Hash, Volume2, Radio, Forum, ExternalLink, Folder } from '../lib/icons';
import { Portal } from '../lib/Portal';
import { ModalHeader } from '../lib/ModalHeader';

export function ChannelCreateModal({
  guild,
  parentCategoryId,
  parentCategoryName,
  onClose,
}: {
  guild: Guild;
  /** Pre-scope the new channel to live under this category. When set,
      the type-picker hides "Category" since you can't nest categories. */
  parentCategoryId?: string;
  parentCategoryName?: string;
  onClose: () => void;
}) {
  const { rest } = useAuth();
  const { loadChannels } = useAppState();
  const toasts = useToasts();
  const navigate = useNavigate();
  const inputRef = useRef<HTMLInputElement>(null);

  const [type, setType] = useState<'guild_text' | 'guild_voice' | 'guild_stage' | 'guild_forum' | 'guild_link' | 'guild_category'>('guild_text');
  const [name, setName] = useState('');
  const [linkUrl, setLinkUrl] = useState('');
  const [submitting, setSubmitting] = useState(false);

  // Track latest onClose in a ref so the keydown handler can call it
  // without forcing the effect to re-register every time the parent
  // recreates the onClose callback. ChannelList re-renders constantly
  // (voice presence, drag state, mentions, gateway events) and its
  // inline `onClose={() => ...}` produces a new function identity on
  // every render. Without this ref, the focus effect re-ran on every
  // ChannelList re-render, snapping focus back to the name input
  // whenever the user clicked the URL field mid-render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // Focus the name input ONCE on open. Empty deps — runs on mount
  // only. Any later focus changes (user clicking URL field, tabbing
  // away) must persist.
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes the modal. Listener registered once; reads the
  // latest onClose through the ref so we don't have to re-bind it.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onCloseRef.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Discord-style: lowercase the name, replace spaces with hyphens, strip
  // characters outside [a-z0-9-_]. We do this on every change so the user
  // sees the canonical form as they type — no surprise normalization at submit.
  function normalize(raw: string): string {
    return raw
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-_]/g, '')
      .slice(0, 100);
  }

  // For link channels we ALSO need a valid http(s) URL — name alone
  // isn't enough since a bookmark with no destination is useless. We
  // check URL.canParse rather than trust the input string verbatim
  // (the server validates again, but failing fast in the modal saves
  // a round-trip + clearer error placement).
  const linkUrlOk = (() => {
    if (type !== 'guild_link') return true;
    if (!linkUrl.trim()) return false;
    try {
      const u = new URL(linkUrl.trim());
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  })();
  const valid =
    (type === 'guild_category' ? name.trim().length > 0 : name.length > 0) && linkUrlOk;

  async function submit() {
    if (!valid || submitting) return;
    setSubmitting(true);
    try {
      const r = await rest.createGuildChannel(guild.id, {
        type,
        // Categories keep their display name as the user typed it (capitalized
        // ok); text and voice channels are lowercase-normalized to match
        // Discord's long-standing convention.
        name: type === 'guild_category' ? name.trim() : name,
        // Categories themselves don't have a parent. Otherwise pass
        // the scoped parent (when the modal was opened from the
        // category's + affordance) so the channel lands inside it.
        ...(type !== 'guild_category' && parentCategoryId
          ? { parentId: parentCategoryId }
          : {}),
        // URL only carried for link channels — the server rejects
        // it on any other type.
        ...(type === 'guild_link' ? { linkUrl: linkUrl.trim() } : {}),
      });
      await loadChannels(guild.id);
      toasts.push('Channel created', 'success');
      onClose();
      // Voice channels don't have a message view to navigate to — joining
      // is a separate action via the new VoicePanel. Text channels jump
      // to the fresh page so the user lands somewhere they can type.
      if (r.channel.type === 'guild_text') {
        navigate(`/channels/${guild.id}/${r.channel.id}`);
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to create channel', 'error');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 bg-black/60 z-50 flex items-stretch sm:items-center justify-center sm:p-4"
        onClick={onClose}
      >
      <div
        className="bg-bg-1 border border-line elevation-pop w-full sm:max-w-md overflow-hidden flex flex-col h-full sm:h-auto sm:max-h-[85vh] sm:rounded-lg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        <ModalHeader
          title={parentCategoryName ? `New channel in ${parentCategoryName}` : 'Create channel'}
          onClose={onClose}
        />

        <div className="px-4 sm:px-5 py-4 space-y-4 overflow-y-auto scrollbar-thin flex-1 min-h-0">
          {/* Type picker. Always 3 columns — with 6 channel types the
              layout is a clean 2×3 grid; with 5 (when scoped to a
              category, Category itself is dropped) it's a 3+2
              arrangement which still reads tidier than the previous
              mixed-breakpoint behavior. Each card carries an icon for
              quick visual scanning of which type does what. */}
          <div>
            <label className="text-xs uppercase tracking-wider text-ink-3 font-semibold">Channel type</label>
            <div className="mt-1 grid grid-cols-3 gap-2">
              <TypeButton
                active={type === 'guild_text'}
                icon={<Hash size={16} />}
                label="Text"
                hint="Send messages, share files"
                onClick={() => setType('guild_text')}
              />
              <TypeButton
                active={type === 'guild_voice'}
                icon={<Volume2 size={16} />}
                label="Voice"
                hint="Talk over audio"
                onClick={() => setType('guild_voice')}
              />
              <TypeButton
                active={type === 'guild_stage'}
                icon={<Radio size={16} />}
                label="Stage"
                hint="Speakers + audience"
                onClick={() => setType('guild_stage')}
              />
              <TypeButton
                active={type === 'guild_forum'}
                icon={<Forum size={16} />}
                label="Forum"
                hint="Topic posts + threads"
                onClick={() => setType('guild_forum')}
              />
              <TypeButton
                active={type === 'guild_link'}
                icon={<ExternalLink size={16} />}
                label="Link"
                hint="External URL bookmark"
                onClick={() => setType('guild_link')}
              />
              {!parentCategoryId && (
                <TypeButton
                  active={type === 'guild_category'}
                  icon={<Folder size={16} />}
                  label="Category"
                  hint="Group channels"
                  onClick={() => setType('guild_category')}
                />
              )}
            </div>
          </div>

          {/* Name */}
          <label className="block">
            <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
              {type === 'guild_category' ? 'Category name' : 'Channel name'}
            </span>
            <div className="relative mt-1">
              {type === 'guild_text' && (
                <Hash size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              )}
              {type === 'guild_voice' && (
                <Volume2 size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              )}
              {type === 'guild_stage' && (
                <Radio size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              )}
              {type === 'guild_forum' && (
                <Forum size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              )}
              {type === 'guild_link' && (
                <ExternalLink size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
              )}
              <input
                ref={inputRef}
                type="text"
                value={name}
                placeholder={
                  type === 'guild_category'
                    ? 'New category'
                    : type === 'guild_voice'
                      ? 'General Voice'
                      : type === 'guild_stage'
                        ? 'Main Stage'
                        : type === 'guild_forum'
                          ? 'community-forum'
                          : type === 'guild_link'
                            ? 'docs'
                            : 'new-channel'
                }
                maxLength={100}
                onChange={(e) => {
                  // Categories, voice, and stage channels keep the raw
                  // name (with caps + spaces) because they're spoken
                  // names — "Movie Night", "After Hours", "Main Stage"
                  // read better than "movie-night". Text/forum/link
                  // channels are referenced as URL-like @mentions and
                  // stay in the lowercase-hyphenated form.
                  const freeform =
                    type === 'guild_category' || type === 'guild_voice' || type === 'guild_stage';
                  setName(freeform ? e.target.value : normalize(e.target.value));
                }}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                className={`w-full ${
                  type !== 'guild_category' ? 'pl-9' : 'pl-3'
                } pr-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1`}
              />
            </div>
            {type !== 'guild_category' && type !== 'guild_voice' && type !== 'guild_stage' && (
              <span className="block text-xs text-ink-3 mt-1">
                Lowercase letters, numbers, dashes, and underscores. No spaces.
              </span>
            )}
          </label>

          {/* URL input — only for link channels. The bookmark target
              the row's click handler opens (after a confirm dialog).
              Validated client-side as parseable http(s); server
              validates again on the POST. */}
          {type === 'guild_link' && (
            <label className="block">
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">URL</span>
              <input
                type="url"
                value={linkUrl}
                onChange={(e) => setLinkUrl(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && submit()}
                placeholder="https://example.com/docs"
                maxLength={2048}
                className="mt-1 w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
              />
              <span className="block text-xs text-ink-3 mt-1">
                Must be a full http or https URL. Members will be asked to confirm
                before being sent to the link.
              </span>
            </label>
          )}

          {/* The "Parent category" select used to live here. It got
              dropped because drag-and-drop now handles re-parenting
              cleanly: create a channel at the top of the list, drag
              it into whichever category you want. The select was
              almost always set to "None — top of list" anyway, since
              new channels organically belong wherever they're
              dragged afterward, and the select was the only place
              in the create flow where the form felt cluttered. */}
        </div>

        <div className="px-5 py-3 border-t border-line bg-bg-2 flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-ink-2 hover:bg-bg-3 text-sm"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            disabled={!valid || submitting}
            className="px-4 py-1.5 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {submitting ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
      </div>
    </Portal>
  );
}

// Internal — segmented-button-style type picker with icon
function TypeButton({
  active,
  icon,
  label,
  hint,
  onClick,
}: {
  active: boolean;
  icon: React.ReactNode;
  label: string;
  hint: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`text-left p-3 rounded-md border transition-colors min-h-[5.5rem] flex flex-col gap-1 ${
        active
          ? 'border-accent bg-accent/10 text-ink-1'
          : 'border-line bg-bg-2 text-ink-2 hover:bg-bg-3 hover:text-ink-1'
      }`}
    >
      <div className="flex items-center gap-2">
        <span className={active ? 'text-accent' : 'text-ink-3'}>{icon}</span>
        <span className="text-sm font-medium">{label}</span>
      </div>
      <div className="text-xs opacity-70 leading-snug">{hint}</div>
    </button>
  );
}
