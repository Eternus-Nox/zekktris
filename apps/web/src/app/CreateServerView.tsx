/**
 * CreateServerView
 * ----------------
 * Form for creating a new guild. Renders as a Shell content pane (rail
 * + content layout) instead of a modal — leaving without creating is
 * done by clicking another rail tile, matching the Discover/Admin
 * pattern.
 *
 * Flow: the user types a name first, then a popup asks HOW to build the
 * server — start from scratch, from a template file, or by recovering a
 * backup. The name they typed is carried into every path (for template /
 * backup it overrides the file's stored name) so naming always happens
 * up front and only once.
 *
 * Template and backup files share the same on-disk format (the JSON
 * produced by the Backup & Restore export); the two popup options differ
 * only in intent + wording. Both feed `rest.importGuild`.
 */

import { useRef, useState } from 'react';
import { useNavigate, Link } from 'react-router-dom';
import { ChevronLeft } from '../lib/icons';
import { ApiError } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { Plus, Archive, FilePen, Upload, X } from '../lib/icons';
import { Portal } from '../lib/Portal';
import { avatarColor, avatarInitials } from '../lib/avatar';

export function CreateServerView() {
  const { rest } = useAuth();
  const { refreshGuilds, state } = useAppState();
  const createRestricted = state.supervision?.restrictions
    ? !state.supervision.restrictions.allowCreateGuild
    : false;
  const nav = useNavigate();

  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // Popup ("how would you like to set it up?") visibility. Opened once a
  // valid name is submitted.
  const [choosing, setChoosing] = useState(false);
  // Which import flavor the hidden file input is currently acting for —
  // purely cosmetic (drives the error wording). null = blank create.
  const importModeRef = useRef<'template' | 'backup'>('template');
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

  // Step 1 — name submitted. Don't create yet; open the setup popup.
  function onSubmitName(e: React.FormEvent) {
    e.preventDefault();
    if (createRestricted) {
      setErr('Creating servers is restricted by your parent');
      return;
    }
    if (!trimmedName) return;
    setErr(null);
    setChoosing(true);
  }

  // Step 2a — start from scratch (blank server with the typed name).
  async function createBlank() {
    if (pending || importing) return;
    setPending(true);
    setErr(null);
    try {
      const r = await rest.createGuild({ name: trimmedName });
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
      setChoosing(false);
    }
  }

  // Step 2b — kick off the file picker for template OR backup. The actual
  // import runs in onImportFile once a file is chosen.
  function pickFile(mode: 'template' | 'backup') {
    importModeRef.current = mode;
    fileRef.current?.click();
  }

  // Build a brand-new server from a template / backup file. The typed name
  // overrides whatever the file was called, so the user's choice up front
  // is what sticks. Reuses the same import the Backup & Restore tab uses.
  async function onImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || importing || pending) return;
    if (createRestricted) {
      setErr('Creating servers is restricted by your parent');
      return;
    }
    const mode = importModeRef.current;
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
            : `Failed to create from ${mode}`,
      );
      setImporting(false);
    }
  }

  // Live-preview tile mimics the rail's guild tile. Initials seed from
  // the typed name so users see what their server icon will look like
  // before they commit. Empty name falls back to a placeholder so the
  // tile doesn't look broken at idle.
  const tone = avatarColor(trimmedName || 'zekktris-new-server');
  const initials = avatarInitials(trimmedName || 'New server');

  const busy = pending || importing;

  return (
    <div className="h-full bg-bg-1 text-ink-1 flex flex-col">
      <header className="h-12 border-b bg-bg-2/85 backdrop-blur-sm px-3 sm:px-4 flex items-center gap-2 sm:gap-3 shrink-0 zk-header-strip">
        <button
          onClick={() => nav('/channels/@me')}
          className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
          aria-label="Back to direct messages"
        >
          <ChevronLeft size={18} />
        </button>
        <Plus size={16} className="text-accent shrink-0" />
        <h1 className="text-base sm:text-lg font-semibold truncate">Create a server</h1>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto scrollbar-thin">
        <div className="max-w-lg mx-auto px-4 sm:px-6 py-8 sm:py-12">
          <div className="mb-12">
            {/* Description first, then the banner/picture area below it. */}
            <div className="text-center mb-8">
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">
                Create your server
              </h2>
              <p className="mt-2 text-sm text-ink-2 max-w-sm mx-auto leading-relaxed">
                A server is where you and your community hang out — text, voice,
                and everything in between. Pick a name to get started; you can
                change it any time.
              </p>
            </div>
            {/* Optional server banner + picture. The picture overhangs the
                banner's bottom-left (mirrors the profile/guild header). Both
                optional; the picture falls back to the live initials preview. */}
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
                className="absolute -bottom-6 left-4 w-20 h-20 rounded-2xl overflow-hidden ring-4 ring-bg-1 shadow-lg hover:brightness-110 transition-all disabled:opacity-60"
              >
                {iconPreview ? (
                  <img src={iconPreview} alt="" className="w-full h-full object-cover" />
                ) : (
                  <div
                    className={`w-full h-full flex items-center justify-center text-2xl font-bold ${tone}`}
                    aria-hidden
                  >
                    {initials}
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
                placeholder="e.g. The Zekktris Lounge"
                maxLength={100}
                required
              />
              <span className="block mt-1.5 text-xs text-ink-3">
                Between 1 and 100 characters.
              </span>
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
              {createRestricted ? 'Restricted by your parent' : 'Continue'}
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

      {/* Hidden file input shared by the template + backup options. */}
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

      {/* Step 2 — setup popup: how to build the server. */}
      {choosing && (
        <Portal>
          <div
            className="fixed inset-0 bg-black/60 z-50 flex items-center justify-center p-4"
            onClick={() => !busy && setChoosing(false)}
          >
            <div
              className="bg-bg-1 border border-line elevation-pop w-full max-w-md rounded-lg overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center justify-between px-5 py-3.5 border-b border-line">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-ink-1 truncate">
                    Set up “{trimmedName}”
                  </div>
                  <div className="text-xs text-ink-3">Choose how to build your server</div>
                </div>
                <button
                  type="button"
                  onClick={() => !busy && setChoosing(false)}
                  aria-label="Close"
                  className="shrink-0 p-1.5 rounded-md text-ink-2 hover:bg-bg-3 disabled:opacity-50"
                  disabled={busy}
                >
                  <X size={16} />
                </button>
              </div>

              <div className="p-4 space-y-2.5">
                {/* Start from scratch */}
                <button
                  type="button"
                  onClick={createBlank}
                  disabled={busy}
                  className="w-full flex items-center gap-3 text-left px-4 py-3 rounded-lg border border-line bg-bg-2 hover:border-accent hover:bg-bg-3/50 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <span className="shrink-0 w-9 h-9 rounded-lg bg-accent/15 text-accent flex items-center justify-center">
                    <Plus size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink-1">
                      {pending ? 'Creating…' : 'Start from scratch'}
                    </span>
                    <span className="block text-xs text-ink-3 leading-snug">
                      A clean server with a couple of starter channels.
                    </span>
                  </span>
                </button>

                {/* Use a template */}
                <button
                  type="button"
                  onClick={() => pickFile('template')}
                  disabled={busy}
                  className="w-full flex items-center gap-3 text-left px-4 py-3 rounded-lg border border-line bg-bg-2 hover:border-accent hover:bg-bg-3/50 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <span className="shrink-0 w-9 h-9 rounded-lg bg-accent/15 text-accent flex items-center justify-center">
                    <FilePen size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink-1">
                      {importing && importModeRef.current === 'template'
                        ? 'Building…'
                        : 'Use a template'}
                    </span>
                    <span className="block text-xs text-ink-3 leading-snug">
                      Start from a template file — channels, roles, and
                      permissions come ready-made.
                    </span>
                  </span>
                </button>

                {/* Recover from a backup */}
                <button
                  type="button"
                  onClick={() => pickFile('backup')}
                  disabled={busy}
                  className="w-full flex items-center gap-3 text-left px-4 py-3 rounded-lg border border-line bg-bg-2 hover:border-accent hover:bg-bg-3/50 transition-all disabled:opacity-60 disabled:cursor-not-allowed"
                >
                  <span className="shrink-0 w-9 h-9 rounded-lg bg-accent/15 text-accent flex items-center justify-center">
                    <Upload size={18} />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-ink-1">
                      {importing && importModeRef.current === 'backup'
                        ? 'Restoring…'
                        : 'Recover from a backup'}
                    </span>
                    <span className="block text-xs text-ink-3 leading-snug">
                      Rebuild a server from a backup file you exported earlier.
                    </span>
                  </span>
                </button>

                {err && (
                  <div className="text-sm text-red-300 bg-red-500/10 border border-red-500/30 rounded-md px-3 py-2 flex items-start gap-2">
                    <Archive size={14} className="mt-0.5 shrink-0" />
                    <span>{err}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}
