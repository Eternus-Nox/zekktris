/**
 * StickersTab
 * -----------
 * Guild settings tab for managing custom stickers. Shape parallels
 * EmojisTab inside GuildSettingsModal, but separated into its own
 * file because the sticker form has more inputs (description) and
 * the rendered tile is bigger.
 *
 * Permissions: visible only to MANAGE_EMOJIS holders (the parent
 * tab list already gates this with adminOnly).
 *
 * Server constraints (mirrored client-side for fast feedback):
 *   - Name: 2-30 chars
 *   - Description: optional, ≤100 chars
 *   - File: PNG, APNG, GIF, or WebP, ≤512 KB
 *   - Slot cap: 50 per guild
 */

import { useEffect, useRef, useState } from 'react';
import type { Guild, Sticker } from '@zekktris/client';
import { ApiError } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useToasts } from '../state/Toasts';
import { useAppState } from '../state/AppState';
import { Upload, Trash, Edit, X } from '../lib/icons';
import { AvatarImage } from '../lib/AvatarImage';

const STICKER_ACCEPT = 'image/png,image/apng,image/gif,image/webp';
const STICKER_MAX_BYTES = 512 * 1024;
const STICKER_PER_GUILD_LIMIT = 50;
const NAME_MIN = 2;
const NAME_MAX = 30;
const DESC_MAX = 100;

interface Props {
  guild: Guild;
}

export function StickersTab({ guild }: Props) {
  const { state } = useAppState();

  // Pull the current list from AppState (it's hydrated on guild
  // bootstrap and refreshed on GUILD_STICKERS_UPDATE). Falls back to
  // an empty array if the bootstrap fetch hasn't completed yet.
  const stickers = state.stickersByGuild[guild.id] ?? [];

  // Local optimistic add: when the upload returns, splice the new
  // sticker into the visible list immediately. The gateway will
  // shortly replace the whole list — both states are consistent so
  // there's no double-render gotcha.
  const [optimistic, setOptimistic] = useState<Sticker[]>([]);
  // Drop optimistic entries that are now in the canonical list.
  useEffect(() => {
    if (optimistic.length === 0) return;
    setOptimistic((prev) => prev.filter((o) => !stickers.some((s) => s.id === o.id)));
    // We intentionally depend on stickers but not optimistic — the
    // setter inside the effect would otherwise cause a render loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stickers]);

  const allStickers = [...stickers, ...optimistic];

  return (
    <div className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-ink-1 mb-1">Stickers</h2>
        <p className="text-sm text-ink-3">
          Custom stickers for this server. Sent as standalone messages — like
          large emoji. {allStickers.length} of {STICKER_PER_GUILD_LIMIT} used.
        </p>
      </div>

      <StickerUploader
        guildId={guild.id}
        currentCount={allStickers.length}
        onUploaded={(s) => setOptimistic((prev) => [...prev, s])}
      />

      <div>
        <h3 className="text-sm font-semibold text-ink-1 mb-2">Existing stickers</h3>
        {allStickers.length === 0 ? (
          <p className="text-sm text-ink-3">No stickers yet. Upload one above.</p>
        ) : (
          <ul className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {allStickers.map((s) => (
              <StickerRow
                key={s.id}
                sticker={s}
                guildId={guild.id}
                onPatched={(patched) => {
                  // For canonical-list rows, gateway will refresh; we
                  // only need to update the optimistic list locally.
                  setOptimistic((prev) =>
                    prev.map((o) => (o.id === patched.id ? patched : o)),
                  );
                }}
                onDeleted={() => {
                  setOptimistic((prev) => prev.filter((o) => o.id !== s.id));
                }}
              />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Uploader ───────────────────────────────────────────────────────────────

function StickerUploader({
  guildId,
  currentCount,
  onUploaded,
}: {
  guildId: string;
  currentCount: number;
  onUploaded: (s: Sticker) => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);

  // Manage the preview URL lifecycle. Object URLs leak memory if not
  // revoked; we revoke on file change and on unmount.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function chooseFile(f: File) {
    setFile(f);
    // Auto-fill the name from the file's stem on first pick. The user
    // can override; we don't trample existing input.
    if (!name) {
      const stem = f.name
        .replace(/\.[^/.]+$/, '')
        .replace(/[^a-zA-Z0-9 _-]+/g, '')
        .trim()
        .slice(0, NAME_MAX);
      setName(stem);
    }
  }

  const fileError = file
    ? !['image/png', 'image/apng', 'image/gif', 'image/webp'].includes(file.type)
      ? 'File must be PNG, APNG, GIF, or WebP'
      : file.size > STICKER_MAX_BYTES
        ? `File exceeds ${Math.round(STICKER_MAX_BYTES / 1024)} KB`
        : null
    : null;
  const trimmedName = name.trim();
  const nameError =
    trimmedName.length > 0 && (trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX)
      ? `Name must be ${NAME_MIN}-${NAME_MAX} characters`
      : null;
  const trimmedDesc = description.trim();
  const descError =
    trimmedDesc.length > DESC_MAX ? `Description must be ${DESC_MAX} chars or fewer` : null;
  const slotError =
    currentCount >= STICKER_PER_GUILD_LIMIT
      ? `Server is full (${STICKER_PER_GUILD_LIMIT}/${STICKER_PER_GUILD_LIMIT}). Delete a sticker to add another.`
      : null;
  const canSubmit =
    !!file && trimmedName.length >= NAME_MIN && !fileError && !nameError && !descError && !slotError && !pending;

  async function submit() {
    if (!file || !canSubmit) return;
    setPending(true);
    try {
      const r = await rest.uploadGuildSticker(guildId, {
        file,
        name: trimmedName,
        description: trimmedDesc.length > 0 ? trimmedDesc : null,
      });
      onUploaded(r.sticker);
      toasts.push(`Added "${r.sticker.name}"`, 'success');
      setFile(null);
      setName('');
      setDescription('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Upload failed', 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="bg-bg-2 border border-line rounded-md p-4">
      <h3 className="text-sm font-semibold text-ink-1 mb-3">Add new sticker</h3>
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={pending || !!slotError}
          className="w-20 h-20 shrink-0 rounded-md bg-bg-3 border border-line border-dashed hover:border-accent flex items-center justify-center text-ink-2 hover:text-accent transition-colors disabled:opacity-60"
          aria-label="Choose sticker file"
        >
          {previewUrl ? (
            <img src={previewUrl} alt="" className="w-full h-full object-contain rounded-md" />
          ) : (
            <Upload size={20} />
          )}
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept={STICKER_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) chooseFile(f);
          }}
        />
        <div className="flex-1 min-w-0 space-y-2">
          <label className="block">
            <span className="text-xs text-ink-2">Name</span>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="cool_sticker"
              maxLength={NAME_MAX}
              disabled={pending}
              className="mt-1 w-full px-2 py-1.5 bg-bg-1 border border-line rounded-md text-sm outline-none focus:border-accent"
            />
          </label>
          <label className="block">
            <span className="text-xs text-ink-2">Description (optional)</span>
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Used as alt text for screen readers"
              maxLength={DESC_MAX}
              disabled={pending}
              className="mt-1 w-full px-2 py-1.5 bg-bg-1 border border-line rounded-md text-sm outline-none focus:border-accent"
            />
          </label>
          {(fileError || nameError || descError || slotError) && (
            <p className="text-xs text-red-300">{fileError || nameError || descError || slotError}</p>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="w-full sm:w-auto px-4 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? 'Uploading…' : 'Upload sticker'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Existing-sticker row with rename/delete ────────────────────────────────

function StickerRow({
  sticker,
  guildId,
  onPatched,
  onDeleted,
}: {
  sticker: Sticker;
  guildId: string;
  onPatched: (s: Sticker) => void;
  onDeleted: () => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(sticker.name);
  const [description, setDescription] = useState(sticker.description ?? '');
  const [pending, setPending] = useState(false);

  // Reset local edit form whenever the canonical row updates (e.g.
  // gateway broadcast after another tab edits the same sticker).
  useEffect(() => {
    setName(sticker.name);
    setDescription(sticker.description ?? '');
  }, [sticker]);

  async function save() {
    const trimmedName = name.trim();
    const trimmedDesc = description.trim();
    if (trimmedName.length < NAME_MIN || trimmedName.length > NAME_MAX) {
      toasts.push(`Name must be ${NAME_MIN}-${NAME_MAX} chars`, 'error');
      return;
    }
    if (trimmedDesc.length > DESC_MAX) {
      toasts.push(`Description must be ≤${DESC_MAX} chars`, 'error');
      return;
    }
    setPending(true);
    try {
      const r = await rest.patchGuildSticker(guildId, sticker.id, {
        name: trimmedName !== sticker.name ? trimmedName : undefined,
        description:
          trimmedDesc !== (sticker.description ?? '')
            ? trimmedDesc.length > 0
              ? trimmedDesc
              : null
            : undefined,
      });
      onPatched(r.sticker);
      setEditing(false);
      toasts.push('Sticker updated', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Update failed', 'error');
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete sticker "${sticker.name}"?`)) return;
    setPending(true);
    try {
      await rest.deleteGuildSticker(guildId, sticker.id);
      onDeleted();
      toasts.push('Sticker deleted', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <li className="flex items-center gap-3 bg-bg-2 border border-line rounded-md p-2">
      <span className="relative w-16 h-16 shrink-0 rounded-md bg-bg-3 overflow-hidden">
        <AvatarImage src={sticker.url} />
      </span>
      <div className="flex-1 min-w-0">
        {editing ? (
          <div className="space-y-1.5">
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              maxLength={NAME_MAX}
              disabled={pending}
              className="w-full px-2 py-1 bg-bg-1 border border-line rounded-md text-sm outline-none focus:border-accent"
            />
            <input
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Description (optional)"
              maxLength={DESC_MAX}
              disabled={pending}
              className="w-full px-2 py-1 bg-bg-1 border border-line rounded-md text-xs outline-none focus:border-accent"
            />
          </div>
        ) : (
          <>
            <p className="text-sm font-medium text-ink-1 truncate">{sticker.name}</p>
            {sticker.description && (
              <p className="text-xs text-ink-3 truncate">{sticker.description}</p>
            )}
          </>
        )}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {editing ? (
          <>
            <button
              type="button"
              onClick={() => void save()}
              disabled={pending}
              className="px-2 py-1 rounded text-xs bg-accent text-white hover:bg-accent/90 disabled:opacity-50"
            >
              Save
            </button>
            <button
              type="button"
              onClick={() => {
                setEditing(false);
                setName(sticker.name);
                setDescription(sticker.description ?? '');
              }}
              className="w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
              aria-label="Cancel"
            >
              <X size={14} />
            </button>
          </>
        ) : (
          <>
            <button
              type="button"
              onClick={() => setEditing(true)}
              className="w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
              aria-label="Edit"
              title="Edit"
            >
              <Edit size={14} />
            </button>
            <button
              type="button"
              onClick={() => void remove()}
              disabled={pending}
              className="w-7 h-7 flex items-center justify-center rounded text-ink-2 hover:text-red-400 hover:bg-bg-3 disabled:opacity-50"
              aria-label="Delete"
              title="Delete"
            >
              <Trash size={14} />
            </button>
          </>
        )}
      </div>
    </li>
  );
}
