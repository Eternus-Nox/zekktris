/**
 * CreateServerView
 * ----------------
 * Form for creating a new guild. Renders as a Shell content pane (rail
 * + content layout) instead of a modal — leaving without creating is
 * done by clicking another rail tile, matching the Discover/Admin
 * pattern.
 *
 * Flow (mirrors iOS): the user names + optionally describes the server and
 * the primary button creates it immediately. An inline "OR — Import from a
 * file" option below builds a server from an exported template/backup file
 * (the JSON produced by the Backup & Restore export) via `rest.importGuild`,
 * with the typed name overriding the file's stored name.
 */

import { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ChevronLeft } from '../lib/icons';
import { ApiError } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { Plus, Upload, Camera } from '../lib/icons';

export function CreateServerView() {
  const { rest } = useAuth();
  const { refreshGuilds, state } = useAppState();
  const createRestricted = state.supervision?.restrictions
    ? !state.supervision.restrictions.allowCreateGuild
    : false;
  const nav = useNavigate();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [importing, setImporting] = useState(false);

  // Optional server picture + banner (uploaded to the new guild after create).
  const [iconFile, setIconFile] = useState<File | null>(null);
  const [bannerFile, setBannerFile] = useState<File | null>(null);
  const [iconPreview, setIconPreview] = useState<string | null>(null);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  const iconInputRef = useRef<HTMLInputElement | null>(null);
  const bannerInputRef = useRef<HTMLInputElement | null>(null);

  function onPickImage(e: React.ChangeEvent<HTMLInputElement>, which: 'icon' | 'banner') {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    const url = URL.createObjectURL(f);
    if (which === 'icon') {
      setIconFile(f);
      setIconPreview(url);
    } else {
      setBannerFile(f);
      setBannerPreview(url);
    }
  }

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();

  // Create the server immediately (matching iOS — no intermediate popup).
  async function onSubmitName(e: React.FormEvent) {
    e.preventDefault();
    if (createRestricted) {
      setErr('Creating servers is restricted by your parent');
      return;
    }
    if (!trimmedName) return;
    setErr(null);
    await createBlank();
  }

  async function createBlank() {
    if (pending || importing) return;
    setPending(true);
    setErr(null);
    try {
      const r = await rest.createGuild({
        name: trimmedName,
        ...(trimmedDescription ? { description: trimmedDescription } : {}),
      });
      // Upload the optional picture + banner to the new guild (non-fatal).
      if (iconFile) {
        try {
          await rest.uploadGuildIcon(r.guild.id, iconFile);
        } catch {
          /* ignore — server still created fine */
        }
      }
      if (bannerFile) {
        try {
          await rest.uploadGuildBanner(r.guild.id, bannerFile);
        } catch {
          /* ignore */
        }
      }
      await refreshGuilds();
      nav(`/channels/${r.guild.id}/${r.defaultChannelId}`);
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : 'Failed to create server');
      setPending(false);
    }
  }

  // Build a brand-new server from an exported template / backup file. The
  // typed name overrides whatever the file was called, so the user's choice
  // up front is what sticks. Reuses the same import the Backup & Restore tab
  // uses.
  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || importing || pending) return;
    if (createRestricted) {
      setErr('Creating servers is restricted by your parent');
      return;
    }
    setImporting(true);
    setErr(null);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('That file isn’t valid JSON');
      }
      const res = await rest.importGuild(parsed, trimmedName);
      await refreshGuilds();
      nav(
        res.defaultChannelId
          ? `/channels/${res.guild.id}/${res.defaultChannelId}`
          : `/channels/${res.guild.id}`,
      );
    } catch (e) {
      setErr(
        e instanceof ApiError
          ? e.message
          : e instanceof Error
            ? e.message
            : 'Failed to create from that file',
      );
      setImporting(false);
    }
  }

  const busy = pending || importing;

  return (
    <div className="h-full bg-bg-1 text-ink-1 flex flex-col">
      <header className="h-12 border-b bg-bg-2/85 backdrop-blur-sm px-3 sm:px-4 flex items-center gap-2 sm:gap-3 shrink-0 zk-header-strip">
        <button
          onClick={() => nav('/channels/@me')}
          className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label="Back to direct messages"
        >
          <ChevronLeft size={20} />
        </button>
        <Plus size={16} className="text-accent shrink-0" />
        <h1 className="text-base sm:text-lg font-semibold truncate">Create a Server</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="max-w-lg mx-auto px-4 sm:px-6 py-8 sm:py-12">
          <div className="mb-12">
            {/* Description first, then the banner/picture area below it. */}
            <div className="text-center mb-8">
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                Create a Server
              </h2>
              <p className="mt-2 text-sm text-ink-2 max-w-sm mx-auto leading-relaxed">
                Give your server a name. You can change it later.
              </p>
            </div>
            {/* Optional server banner + picture. The picture overhangs the
                banner's bottom-left (mirrors the profile/guild header). Both
                optional; the picture falls back to a camera placeholder. */}
            <div className="relative">
              <button
                type="button"
                onClick={() => bannerInputRef.current?.click()}
                disabled={busy}
                aria-label="Add server banner (optional)"
                className="block w-full h-[151px] rounded-xl overflow-hidden ring-1 ring-line/50 hover:ring-accent transition-all disabled:opacity-60"
              >
                {bannerPreview ? (
                  <img src={bannerPreview} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div className="w-full h-full bg-gradient-to-br from-accent/35 to-accent-2/25 flex items-center justify-center gap-1.5 text-xs font-semibold text-ink-2">
                    <Upload size={14} /> Add banner (optional)
                  </div>
                )}
              </button>
              <button
                type="button"
                onClick={() => iconInputRef.current?.click()}
                disabled={busy}
                aria-label="Add server picture (optional)"
                className="absolute -bottom-6 left-4 w-20 h-20 rounded-full overflow-hidden ring-4 ring-bg-1 shadow-lg hover:brightness-110 transition-all disabled:opacity-60"
              >
                {iconPreview ? (
                  <img src={iconPreview} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div
                    className="w-full h-full flex items-center justify-center bg-bg-3 text-ink-2"
                    aria-hidden
                  >
                    <Camera size={24} />
                  </div>
                )}
              </button>
            </div>
          </div>

          <form onSubmit={onSubmitName} className="glass glass-edge rounded-xl p-5 sm:p-6 shadow-sm space-y-4">
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-ink-3">
                Server name
              </span>
              <input
                type="text"
                className="mt-2 w-full bg-bg-1/60 backdrop-blur-sm border rounded-md px-3 py-2.5 outline-none transition-all focus:shadow-[0_0_0_1px_var(--accent-glow),0_0_14px_var(--accent-glow)]"
                style={{ borderColor: 'var(--zk-line)' }}
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="My cool server"
                maxLength={100}
                required
              />
              <span className="block mt-1.5 text-xs text-ink-3">
                Between 1 and 100 characters.
              </span>
            </label>
            <label className="block">
              <span className="text-xs uppercase tracking-wider font-semibold text-ink-3">
                Description (optional)
              </span>
              <textarea
                rows={3}
                className="mt-2 w-full bg-bg-1/60 backdrop-blur-sm border rounded-md px-3 py-2.5 outline-none resize-none transition-all focus:shadow-[0_0_0_1px_var(--accent-glow),0_0_14px_var(--accent-glow)]"
                style={{ borderColor: 'var(--zk-line)' }}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What's your server about?"
                maxLength={1000}
              />
            </label>
            {err && (
              <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2">
                {err}
              </div>
            )}
            <button
              type="submit"
              disabled={!trimmedName || createRestricted || busy}
              className="w-full px-4 py-2.5 rounded-md bg-gradient-to-br from-accent to-accent-2 hover:brightness-110 disabled:opacity-60 disabled:cursor-not-allowed text-bg-0 font-semibold transition-all shadow-[0_0_0_1px_var(--accent-glow),0_4px_18px_var(--accent-glow)]"
            >
              {createRestricted
                ? 'Restricted by your parent'
                : pending
                  ? 'Creating…'
                  : 'Create Server'}
            </button>

            {/* Inline OR divider + import — mirrors iOS's on-page import
                option instead of a post-name popup. */}
            <div className="flex items-center gap-3 pt-1" aria-hidden>
              <span className="flex-1 h-px bg-line" />
              <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
                or
              </span>
              <span className="flex-1 h-px bg-line" />
            </div>
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={busy || createRestricted}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 rounded-md border border-line bg-bg-2 hover:bg-bg-3 text-ink-1 text-sm font-medium transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
            >
              <Upload size={16} />
              {importing ? 'Importing…' : 'Import from a file'}
            </button>
          </form>

          <p className="mt-6 text-center text-xs text-ink-3">
            Already have an invite code?{' '}
            <Link to="/join-server" className="text-accent hover:underline">
              Join an existing server
            </Link>{' '}
            instead.
          </p>
        </div>
      </div>

      {/* Hidden file input for the "Import from a file" option. */}
      <input
        ref={fileRef}
        type="file"
        accept="application/json,.json"
        onChange={onImportFile}
        className="hidden"
      />
      {/* Hidden inputs for the optional server picture + banner. */}
      <input
        ref={iconInputRef}
        type="file"
        accept="image/*"
        onChange={(e) => onPickImage(e, 'icon')}
        className="hidden"
      />
      <input
        ref={bannerInputRef}
        type="file"
        accept="image/*"
        onChange={(e) => onPickImage(e, 'banner')}
        className="hidden"
      />
    </div>
  );
}
