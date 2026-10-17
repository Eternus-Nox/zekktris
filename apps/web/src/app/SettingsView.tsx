/**
 * SettingsView
 * ------------
 * Minimal v1 settings: edit display name, bio, online status, password,
 * 2FA, audio device picks, voice prefs. The server's PATCH /users/@me
 * handles profile fields; password + 2FA are separate endpoints.
 *
 * Renders as a Shell content pane (rail + content layout). Leaving
 * happens by clicking another rail tile, matching the
 * Discover/Admin pattern.
 *
 * The form starts pre-filled with the current values from
 * `useAuth().user` and only sends fields that changed. Pending state
 * disables the save button; toasts surface success/failure.
 */

import { useEffect, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { ApiError, type PasskeyInfo, type SessionInfo } from '@zekktris/client';
import { passkeysAvailable } from '../lib/passkeyAvailable';
import { UserTag, StaffName } from '../lib/UserTag';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { AchievementsShelf } from './AchievementsShelf';
import { useParentalControlsEnabled, setParentalControlsEnabled } from '../lib/familyPrefs';
import { useHideClanTags, setHideClanTags } from '../lib/displayPrefs';
import { E2eeLinkPreviewsToggle } from './E2eeLinkPreviewsToggle';
import { findOwnPushDevice } from '../lib/pushEndpoint';
import { TierBadge, TIER_META } from '../lib/TierBadge';
import { isNative, requestNotificationPermission } from '../lib/native';
import {
  getNotifyPrefs,
  setNotifyMessages,
  setNotifyCalls,
  subscribeNotifyPrefs,
} from '../lib/notifyPrefs';
import { useToasts } from '../state/Toasts';
import { compressImage } from '../lib/compressImage';
import {
  AlertTriangle,
  Camera,
  Check,
  Copy,
  Settings as SettingsIcon,
  Shield,
  ChevronLeft,
  Key,
  LogOut,
} from '../lib/icons';
import { DeviceIcon, deviceLabel } from '../lib/deviceInfo';
import { DeviceApprovalSection } from './DeviceApproval';
import { useNavigate } from 'react-router-dom';
import { copyText } from '../lib/clipboard';
import { qrEncode, qrToSvg } from '../lib/qr';
import { THEMES, applyTheme, getStoredTheme, type ThemeId } from '../lib/theme';
import { usePwaInstall } from '../lib/pwa';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { CustomStatusModal, formatCustomStatus } from './CustomStatusModal';
import { AvatarImage } from '../lib/AvatarImage';
import { AVATAR_DECORATIONS, AvatarDecoration } from '../lib/avatarDecorations';
import {
  type AudioDeviceList,
  type AudioMode,
  formatKeyCode,
  getAudioMode,
  getPttKey,
  getDeafenKey,
  setDeafenKey,
  getSavedInputDeviceId,
  getSavedOutputDeviceId,
  getSavedCameraQuality,
  getSavedScreenQuality,
  getSavedScreenFps60,
  listAudioDevices,
  requestMicPermission,
  setAudioMode,
  setPttKey,
  setSavedInputDeviceId,
  setSavedOutputDeviceId,
  setSavedCameraQuality,
  setSavedScreenQuality,
  setSavedScreenFps60,
  CAMERA_QUALITY_PRESETS,
  SCREEN_QUALITY_PRESETS,
  highestAllowedCameraQuality,
  highestAllowedScreenQuality,
  getMonetizationVersion,
  isCameraQualityAllowed,
  isScreenFps60Allowed,
  isScreenQualityAllowed,
  MONETIZE_TIER_RANK,
  monetizeTierRank,
  requiredTierForCameraQuality,
  requiredTierForScreenFps60,
  requiredTierForScreenQuality,
  subscribeMonetization,
  VoiceError,
  type CameraQuality,
  type ScreenQuality,
} from '../lib/voice';
import {
  type VoiceQuality,
  QUALITY_PRESETS,
  getVoiceQuality,
  setVoiceQuality,
} from '../lib/voiceQuality';
import {
  getVoicePrefs,
  setEchoCancellation,
  setGainMode,
  setMicGain,
  setNoiseSuppression,
  subscribeVoicePrefs,
} from '../lib/voicePrefs';
import { MicLevelMeter } from '../lib/MicLevelMeter';
import { useStepUpPassword } from '../lib/StepUpPassword';
import { chosenStatusOf } from '../lib/presenceActivity';

type Status = 'online' | 'idle' | 'dnd' | 'invisible';

// The CHOSEN status (SelfUser.chosenStatus). On a server with multi-device
// presence, Online is shown to others as Away while none of the user's
// devices is in use — the pick itself stays Online.
const STATUS_OPTIONS: Array<{ value: Status; label: string; dot: string; help: string }> = [
  { value: 'online', label: 'Online', dot: 'bg-emerald-500', help: 'Visible and reachable' },
  // Display label only — the wire/DB value stays the string 'idle' so every
  // already-shipped client keeps agreeing with the server about presence.
  { value: 'idle', label: 'Away', dot: 'bg-amber-500', help: 'Away from keyboard' },
  { value: 'dnd', label: 'Do not disturb', dot: 'bg-red-500', help: 'No notification sounds' },
  { value: 'invisible', label: 'Invisible', dot: 'bg-ink-3', help: "Appear offline to everyone" },
];

/**
 * Danger zone — permanently close the account.
 *
 * The Privacy Policy states the user can "delete your account at any time from
 * Settings", so this is where that promise is kept. Its own component (rather
 * than more state on SettingsView) because it owns four pieces of transient
 * form state that nothing else needs.
 *
 * Deliberately high-friction: the password is required by the server, and we
 * additionally make the user type their username. Deletion is irreversible and
 * one stray click away from everyday profile controls.
 */
function DeleteAccountSection() {
  const { user, rest, logout } = useAuth();
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [confirmName, setConfirmName] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [busy, setBusy] = useState(false);

  const username = user?.username ?? '';
  const canSubmit = password.length > 0 && confirmName === username && !busy;

  async function openPanel() {
    setOpen(true);
    // Only ask for a second factor if one is actually armed. Best-effort: if
    // the status call fails we simply show the field, and the server is the
    // real gate either way.
    try {
      const st = await rest.getTwoFactorStatus();
      setNeedsCode(st.enabled);
    } catch {
      setNeedsCode(true);
    }
  }

  function reset() {
    setOpen(false);
    setPassword('');
    setCode('');
    setConfirmName('');
    setBusy(false);
  }

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    try {
      await rest.deleteAccount({
        password,
        ...(code.trim() ? { totpCode: code.trim() } : {}),
      });
      // The account is gone and every session with it — drop local state and
      // return to the login screen.
      toasts.push('Your account has been deleted.', 'success');
      await logout();
    } catch (err) {
      const message =
        err instanceof Error && err.message ? err.message : 'Could not delete your account.';
      toasts.push(message, 'error');
      setBusy(false);
    }
  }

  return (
    <div className="pt-3 border-t border-line">
      <div className="text-sm text-ink-2 font-medium mb-2">Delete account</div>
      {!open ? (
        <>
          <button
            onClick={() => void openPanel()}
            className="w-full sm:w-auto px-3 py-2 rounded-lg text-sm font-medium border border-red-400/40 text-red-400 hover:bg-red-500/10 transition-colors inline-flex items-center justify-center gap-2"
          >
            <AlertTriangle size={16} />
            Delete my account
          </button>
          <p className="text-xs text-ink-3 mt-2">
            Permanently deletes your account and signs you out everywhere. This
            can&rsquo;t be undone.
          </p>
        </>
      ) : (
        <div className="rounded-lg border border-red-400/40 bg-red-500/5 p-3 space-y-3">
          <p className="text-sm text-ink-2">
            This permanently deletes your account and your profile, and
            removes your name from messages you&rsquo;ve sent.
            It cannot be undone.
          </p>
          <p className="text-xs text-ink-3">
            If you own any servers, transfer or delete them first.
          </p>
          <label className="block">
            <span className="text-xs text-ink-3">Your password</span>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-bg-1 border border-line text-sm text-ink-1"
            />
          </label>
          {needsCode && (
            <label className="block">
              <span className="text-xs text-ink-3">
                Authenticator code (or a recovery code)
              </span>
              <input
                inputMode="numeric"
                autoComplete="one-time-code"
                value={code}
                onChange={(e) => setCode(e.target.value)}
                className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-bg-1 border border-line text-sm text-ink-1 font-mono tracking-widest"
              />
            </label>
          )}
          <label className="block">
            <span className="text-xs text-ink-3">
              Type <span className="font-mono text-ink-2">{username}</span> to confirm
            </span>
            <input
              value={confirmName}
              onChange={(e) => setConfirmName(e.target.value)}
              className="mt-1 w-full px-2.5 py-1.5 rounded-md bg-bg-1 border border-line text-sm text-ink-1"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              onClick={() => void submit()}
              disabled={!canSubmit}
              className="px-3 py-2 rounded-lg text-sm font-medium bg-red-500/90 text-white hover:bg-red-500 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {busy ? 'Deleting\u2026' : 'Permanently delete'}
            </button>
            <button
              onClick={reset}
              disabled={busy}
              className="px-3 py-2 rounded-lg text-sm text-ink-2 hover:bg-bg-1 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function SettingsView() {
  const navigate = useNavigate();
  const { user, rest, updateUser, logout } = useAuth();
  const { replaceUser, state } = useAppState();
  const toasts = useToasts();

  const [displayName, setDisplayName] = useState(user?.displayName ?? '');
  const [bio, setBio] = useState(user?.bio ?? '');
  // The picker shows the status the user CHOSE, including 'invisible' so
  // they can see their privacy choice persists across sessions — not the
  // effective one, which follows device activity (chosen Online reads Away
  // while none of their devices is in use).
  const chosenStatus = user ? chosenStatusOf(user) : 'online';
  const [status, setStatus] = useState<Status>(chosenStatus);

  // Re-sync local status state if the auth-context user changes
  // underneath us — happens when another device or tab picks a status
  // (the server's PRESENCE_UPDATE to our own connections carries it).
  // Without this the radio would lag behind reality.
  useEffect(() => {
    if (user && chosenStatus !== status) setStatus(chosenStatus);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chosenStatus]);
  const [pending, setPending] = useState(false);
  // Debounced auto-save plumbing for the profile text fields. `saveRef`
  // always points at the latest `save` closure so the debounce effect
  // can call it without depending on (and re-running for) a function
  // identity that changes every render. `didSeedRef` skips the initial
  // value-seeding render so we don't fire a redundant save on open.
  const saveRef = useRef<(opts?: { silent?: boolean }) => Promise<void>>(async () => {});
  const didSeedRef = useRef(false);
  /** Active settings tab. Four top-level categories, mirroring the iOS
   *  Settings tab bar:
   *    - profile     → avatar/banner, name, about me, status, notifications,
   *                    install, privacy, blocked, legal
   *    - security    → identity (user id / username / email), password, 2FA,
   *                    passkeys, quick login, bots (iOS folds Bots in here
   *                    rather than giving it a standalone tab)
   *    - voice       → voice + video device settings, audio processing,
   *                    video quality
   *    - membership  → "Appearance": themes, avatar decoration, name tag
   *                    (free for everyone) plus the perk-tier list
   *  Defaults to 'profile' so users land on the surface they're
   *  already used to. Transient state — not persisted; each visit
   *  starts on Profile. */
  const [activeTab, setActiveTab] = useState<'profile' | 'membership' | 'security' | 'voice'>(
    'profile',
  );
  const [theme, setTheme] = useState<ThemeId>(() => getStoredTheme());

  function chooseTheme(id: ThemeId) {
    setTheme(id);
    applyTheme(id);
  }

  // Avatar decoration — a cosmetic ring/glow others see. Saves immediately
  // (one-shot, like avatar/banner), updating the auth user so it re-renders
  // everywhere at once.
  const [decoSaving, setDecoSaving] = useState(false);
  async function chooseDecoration(id: string) {
    const next = id === 'none' ? null : id;
    if ((user?.avatarDecoration ?? null) === next) return;
    setDecoSaving(true);
    try {
      const r = await rest.patchMe({ avatarDecoration: next });
      updateUser(r.user);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not save decoration', 'error');
    } finally {
      setDecoSaving(false);
    }
  }
  // Avatar upload state — separate from the Save Changes flow because
  // it's a one-shot multipart upload that mutates the user row by
  // itself. We hold a local preview URL via URL.createObjectURL so the
  // user sees the picked image immediately, even before the server
  // response lands. Cleared after the upload finishes.
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [bannerUploading, setBannerUploading] = useState(false);
  const [bannerPreview, setBannerPreview] = useState<string | null>(null);
  // Hidden file inputs driven by the persistent profile hero (below the header).
  const heroBannerInput = useRef<HTMLInputElement>(null);
  const heroAvatarInput = useRef<HTMLInputElement>(null);
  // Status auto-save runs independently from the Save Changes button; we
  // track its in-flight state separately so the buttons disable correctly
  // without flickering the main Save spinner.
  const [savingStatus, setSavingStatus] = useState(false);

  /**
   * Persist a status change immediately. Optimistic local update so the
   * radio dot moves instantly; if the server rejects, we revert and
   * surface the error. This is the canonical Discord pattern — status
   * is a one-tap setting, not "fill out a form and click submit".
   */
  async function changeStatus(next: Status) {
    if (next === status || savingStatus) return;
    const prev = status;
    setStatus(next); // optimistic
    setSavingStatus(true);
    try {
      const r = await rest.patchMe({ status: next });
      updateUser(r.user);
      replaceUser({
        id: r.user.id,
        username: r.user.username,
        displayName: r.user.displayName,
        avatarUrl: r.user.avatarUrl,
        status: r.user.status,
        customStatus: r.user.customStatus,
      });
    } catch (e) {
      setStatus(prev); // revert on failure
      toasts.push(e instanceof ApiError ? e.message : 'Status update failed', 'error');
    } finally {
      setSavingStatus(false);
    }
  }

  if (!user) return null;

  /**
   * Upload a picked image as the user's avatar. Validates type +
   * size client-side before sending so the user gets immediate
   * feedback (the server enforces both anyway). The local preview is
   * generated via URL.createObjectURL so the new avatar appears in
   * the modal immediately, even before the multipart upload finishes
   * — the server response then replaces the preview with the canonical
   * /cdn/... URL via updateUser().
   */
  async function uploadAvatar(file: File) {
    if (!user || avatarUploading) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) {
      toasts.push('Avatar must be a PNG, JPEG, GIF, or WebP image', 'error');
      return;
    }
    // Cap at 8 MB client-side. Server has its own limit via env, but
    // bouncing here saves the upload bandwidth on egregiously large
    // files.
    if (file.size > 8 * 1024 * 1024) {
      toasts.push('Avatar file is too large (max 8 MB)', 'error');
      return;
    }
    setAvatarUploading(true);
    const previewUrl = URL.createObjectURL(file);
    setAvatarPreview(previewUrl);
    try {
      const r = await rest.uploadAvatar(await compressImage(file, { maxDimension: 512 }));
      updateUser(r.user);
      replaceUser({
        id: r.user.id,
        username: r.user.username,
        displayName: r.user.displayName,
        avatarUrl: r.user.avatarUrl,
        status: r.user.status,
        customStatus: r.user.customStatus,
      });
      toasts.push('Avatar updated', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Avatar upload failed', 'error');
      // Drop the preview on failure so the UI reverts to the
      // currently-saved avatar rather than leaving a stale local URL
      // visible.
      setAvatarPreview(null);
    } finally {
      setAvatarUploading(false);
      // Free the blob URL once we no longer need it. We delay slightly
      // so the new <img> has time to swap to the server URL without
      // flashing to broken state.
      setTimeout(() => URL.revokeObjectURL(previewUrl), 1500);
    }
  }

  /** Clear the avatar (back to initials fallback). */
  async function clearAvatar() {
    if (!user || avatarUploading) return;
    setAvatarUploading(true);
    try {
      const r = await rest.patchMe({ avatarUrl: null });
      updateUser(r.user);
      replaceUser({
        id: r.user.id,
        username: r.user.username,
        displayName: r.user.displayName,
        avatarUrl: r.user.avatarUrl,
        status: r.user.status,
        customStatus: r.user.customStatus,
      });
      setAvatarPreview(null);
      toasts.push('Avatar removed', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not remove avatar', 'error');
    } finally {
      setAvatarUploading(false);
    }
  }

  /**
   * Banner upload mirrors the avatar path. Banner is purely cosmetic —
   * shown on the profile card hero strip. Same content-type allow-list
   * (server enforces too) and the same 8 MB client cap. We don't
   * replaceUser() here because banners aren't part of the in-app
   * `usersById` cache: the cache only mirrors fields that show up in
   * member lists / message authors, and banners only render on the
   * profile card which fetches the canonical user separately.
   */
  async function uploadBanner(file: File) {
    if (!user || bannerUploading) return;
    if (!/^image\/(png|jpe?g|gif|webp)$/i.test(file.type)) {
      toasts.push('Banner must be a PNG, JPEG, GIF, or WebP image', 'error');
      return;
    }
    if (file.size > 8 * 1024 * 1024) {
      toasts.push('Banner file is too large (max 8 MB)', 'error');
      return;
    }
    setBannerUploading(true);
    const previewUrl = URL.createObjectURL(file);
    setBannerPreview(previewUrl);
    try {
      const r = await rest.uploadBanner(await compressImage(file, { maxDimension: 1500 }));
      updateUser(r.user);
      toasts.push('Banner updated', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Banner upload failed', 'error');
      setBannerPreview(null);
    } finally {
      setBannerUploading(false);
      setTimeout(() => URL.revokeObjectURL(previewUrl), 1500);
    }
  }

  async function clearBanner() {
    if (!user || bannerUploading) return;
    setBannerUploading(true);
    try {
      const r = await rest.patchMe({ bannerUrl: null });
      updateUser(r.user);
      setBannerPreview(null);
      toasts.push('Banner removed', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not remove banner', 'error');
    } finally {
      setBannerUploading(false);
    }
  }

  async function save(opts?: { silent?: boolean }) {
    if (!user || pending) return;
    setPending(true);
    try {
      // Send all three editable fields every time. The previous
      // change-detection heuristic compared local state to
      // `user!.<field>`, but that comparison was fragile in two ways:
      //   1) After the status auto-save, `updateUser(r.user)` rewrites
      //      the auth-context user with the server's view — but the
      //      local `displayName` / `bio` / `customStatus` useState
      //      values stayed at whatever the user had typed locally.
      //      Subtle skews (e.g. server-trimmed whitespace, char-set
      //      normalisation) made the diff falsely return "no changes".
      //   2) Once the auth context updates from any other path
      //      (gateway USER_UPDATE, presence patch, second tab), the
      //      diff would silently misfire.
      // Sending unconditionally means the user's intent — what's in
      // the inputs right now — is what gets persisted. The server
      // accepts no-op writes harmlessly; idempotency is its job, not
      // ours.
      const patch: {
        displayName: string;
        bio: string;
      } = {
        displayName: displayName.trim(),
        bio: bio.trim(),
      };

      // Validate locally before round-tripping. The server enforces
      // the same bound but failing fast saves a 400 → toast cycle.
      if (patch.displayName.length === 0) {
        if (!opts?.silent) toasts.push('Display name cannot be empty', 'error');
        return;
      }

      const r = await rest.patchMe(patch);

      // Sync local state to the server's authoritative response. This
      // pulls in any server-side normalisation (trim, casing, etc.)
      // and prevents the local inputs from drifting past the next
      // open of this modal.
      updateUser(r.user);
      replaceUser({
        id: r.user.id,
        username: r.user.username,
        displayName: r.user.displayName,
        avatarUrl: r.user.avatarUrl,
        status: r.user.status,
        customStatus: r.user.customStatus,
      });
      setDisplayName(r.user.displayName);
      setBio(r.user.bio ?? '');

      if (!opts?.silent) toasts.push('Settings saved', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Save failed', 'error');
    } finally {
      setPending(false);
    }
  }

  // Keep the ref pointed at the latest closure (runs every render).
  saveRef.current = save;

  // Debounced auto-save: persist profile text edits ~1s after the user
  // stops typing, so changes are never lost if they leave the field or
  // close Settings without blurring (common on touch). onBlur still
  // fires an immediate save; both are idempotent on the server.
  useEffect(() => {
    if (!didSeedRef.current) {
      didSeedRef.current = true;
      return;
    }
    if (!user) return;
    const changed =
      displayName.trim() !== (user.displayName ?? '') ||
      bio.trim() !== (user.bio ?? '');
    // Don't auto-save an empty display name (invalid) — wait for valid input.
    if (!changed || displayName.trim().length === 0) return;
    const t = setTimeout(() => void saveRef.current({ silent: true }), 1000);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [displayName, bio, user]);

  return (
    <div className="h-full bg-bg-1 text-ink-1 flex flex-col">
      <header
        className="border-b bg-bg-2/85 backdrop-blur-sm px-3 sm:px-4 shrink-0"
        style={{ borderBottomColor: 'var(--zk-line-soft)' }}
      >
        <div className="h-12 flex items-center gap-2 sm:gap-3">
          <button
            onClick={() => navigate('/channels/@me')}
            className="xl:hidden -ml-1 w-10 h-10 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 shrink-0"
            aria-label="Back to direct messages"
          >
            <ChevronLeft size={18} />
          </button>
          <SettingsIcon size={16} className="text-accent shrink-0" />
          <h1 className="text-base sm:text-lg font-semibold truncate">Settings</h1>
        </div>
        {/* Tab bar — iOS capsule pills. The active tab is a solid accent
            capsule; inactive tabs are bg-2 chips whose label brightens on
            hover. Horizontally scrollable so the four pills never wrap or
            get clipped on narrow phones. */}
        <nav
          className="flex gap-2 overflow-x-auto scrollbar-thin py-1"
          role="tablist"
          aria-label="Settings sections"
        >
          {(
            [
              { id: 'profile', label: 'Profile' },
              { id: 'security', label: 'Security' },
              { id: 'voice', label: 'Voice & Video' },
              { id: 'membership', label: 'Appearance' },
            ] as const
          ).map((t) => {
            const active = activeTab === t.id;
            return (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={active}
                onClick={() => setActiveTab(t.id)}
                className={`px-3.5 py-1.5 text-sm rounded-full font-medium whitespace-nowrap transition-colors ${
                  active ? 'bg-accent text-white' : 'bg-bg-2 text-ink-2 hover:text-ink-1'
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>

      <div className="p-4 sm:p-6 space-y-5 overflow-y-auto scrollbar-thin flex-1 min-h-0">
        {/* Persistent profile hero — full-bleed banner + overhanging avatar +
            name, matching the iOS Settings header. Shown above the tab content
            on every tab. Exactly ONE control per image: the banner's corner
            camera changes the banner, the avatar itself (with its camera badge)
            changes the avatar. Remove lives on the Profile tab, so nothing is
            duplicated. */}
        <div className="-mx-4 sm:-mx-6 -mt-4 sm:-mt-6">
          {/* FIXED height, not an aspect ratio. aspect-[16/6] scaled with the
              panel width, so on a wide settings pane the banner ballooned to
              ~340px and pushed the name/username below the fold — which read as
              "the banner is too big and its text isn't showing". A fixed height
              keeps the whole hero (banner + avatar + name) visible at any width.
              Mirrors iOS, which also pins a fixed banner height rather than an
              aspect ratio (MainView.swift:2285). */}
          <div className="relative w-full h-[124px] sm:h-[148px] overflow-hidden bg-gradient-to-r from-accent/55 to-accent-2/45">
            {(bannerPreview || user.bannerUrl) && (
              <img
                src={bannerPreview || user.bannerUrl || undefined}
                alt=""
                className="w-full h-full object-cover"
              />
            )}
            {/* Legibility scrim — iOS parity (MainView.swift:2290-2293). Fades
                the banner into the page so the avatar and name always read,
                whatever the banner image happens to be. */}
            <div
              aria-hidden
              className="absolute inset-0 bg-gradient-to-b from-transparent to-bg-1/90"
            />
            <button
              type="button"
              onClick={() => heroBannerInput.current?.click()}
              disabled={bannerUploading}
              className="absolute bottom-2 right-2 w-9 h-9 grid place-items-center rounded-full bg-black/50 text-white hover:bg-black/70 disabled:opacity-60 transition-colors"
              aria-label="Change banner"
            >
              <Camera size={17} />
            </button>
          </div>
          <div className="px-4 sm:px-6 -mt-9 flex items-end gap-3">
            <button
              type="button"
              onClick={() => heroAvatarInput.current?.click()}
              disabled={avatarUploading}
              className="relative shrink-0 disabled:opacity-70"
              aria-label="Change avatar"
            >
              <span
                className={`block w-[76px] h-[76px] rounded-full border-4 border-bg-1 text-2xl font-semibold flex items-center justify-center ${avatarColor(user.id)}`}
                aria-hidden="true"
              >
                {avatarInitials(user.displayName)}
              </span>
              <AvatarImage
                src={avatarPreview || user.avatarUrl}
                className="absolute inset-0 w-[76px] h-[76px] rounded-full border-4 border-bg-1 object-cover"
              />
              <span className="absolute bottom-0 right-0 w-6 h-6 grid place-items-center rounded-full bg-accent text-white border-2 border-bg-1">
                <Camera size={11} />
              </span>
            </button>
            <div className="min-w-0 pb-1">
              {/* Your own name renders through the SAME <StaffName> every other
                  surface uses, so instance staff see their shimmer (and the
                  optional glow) here too. StaffName is the single gate —
                  staffShimmerColor() returns null unless you're staff AND have
                  picked a color, so a non-entitled or opted-out user still gets
                  the plain text-ink-1 treatment. */}
              <StaffName
                user={user}
                text={user.displayName || user.username}
                className="block text-xl font-bold truncate leading-tight text-ink-1"
              />
              <div className="text-sm text-ink-3 truncate">@{user.username}</div>
            </div>
          </div>
          {/* No "Upload Picture" pill here — the avatar itself is the button
              (it carries the accent camera badge and opens the same input), so
              the pill was a second control for an identical action. Upload
              progress now shows on the avatar via its disabled/opacity state. */}
          <input
            ref={heroBannerInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void uploadBanner(f);
            }}
          />
          <input
            ref={heroAvatarInput}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void uploadAvatar(f);
            }}
          />
        </div>

        {activeTab === 'profile' && (
          <>
        {/* Supervision notice — shown to a supervised account so it
            always knows, transparently, who can see its activity. Lives
            here (above Account) rather than as a global banner. */}
        {state.supervision && state.supervision.supervisedBy.length > 0 && (
          <section className="rounded-xl border border-amber-500/30 bg-gradient-to-br from-amber-500/10 to-amber-500/[0.03] p-4">
            <div className="flex items-start gap-3">
              <div className="shrink-0 mt-0.5 w-8 h-8 rounded-full bg-amber-500/15 grid place-items-center text-amber-300">
                <Shield size={16} />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-amber-100">
                  This account is supervised
                </p>
                <p className="text-xs text-amber-200/80 leading-relaxed mt-0.5">
                  Your messages, friends, and activity are visible to{' '}
                  <span className="font-medium">
                    {state.supervision.supervisedBy
                      .map((p) => p.displayName || p.username)
                      .join(' and ')}
                  </span>
                  , and your direct messages aren't end-to-end encrypted (except
                  messages with them).
                </p>
              </div>
            </div>
          </section>
        )}

          {/* Account + Security (identity, password, 2FA, passkeys, quick
              login) moved to their own "Security" tab — see the
              activeTab === 'security' block below. */}

          {/* ── Status ───────────────────────────────────────────────────
              First on the tab (matches iOS). Status changes apply immediately
              (no Save Changes click required) — this matches Discord's
              behaviour and resolves the surprise of "I picked Away but it
              didn't take". The optimistic local update happens before the
              REST round-trip so the UI is snappy. */}
          <section className="space-y-2">
            <div className="text-xs uppercase tracking-wider text-ink-3">Status</div>
            {/* iOS: a single-column stack of full-width rows; the active status
                gets a trailing accent checkmark (no per-row help subtext). */}
            <div className="space-y-2">
              {STATUS_OPTIONS.map((opt) => {
                const active = status === opt.value;
                return (
                  <button
                    key={opt.value}
                    type="button"
                    disabled={savingStatus}
                    onClick={() => void changeStatus(opt.value)}
                    /* iOS/Android express the selection with the trailing tick
                       ALONE — the row card itself stays neutral either way
                       (MainView.swift statusRow). */
                    className="w-full flex items-center gap-2.5 text-left px-3 py-2.5 rounded-md border bg-bg-1 border-line hover:bg-bg-3 transition-colors disabled:opacity-60"
                  >
                    <span className={`w-2.5 h-2.5 rounded-full ${opt.dot}`} aria-hidden />
                    <span className="font-medium">{opt.label}</span>
                    {active && <Check size={16} className="ml-auto text-accent" />}
                  </button>
                );
              })}
            </div>
          </section>

          {/* ── Profile ────────────────────────────────────────────────── */}
          <section className="space-y-3">
            <div className="text-xs uppercase tracking-wider text-ink-3">Profile</div>

            {/* Avatar/banner CHANGE is handled by the persistent hero above;
                here we only offer Remove (when one is set), so the controls
                aren't duplicated. */}
            {(user.avatarUrl || user.bannerUrl) && (
              <div className="flex flex-wrap gap-2">
                {user.avatarUrl && (
                  <button
                    type="button"
                    onClick={clearAvatar}
                    disabled={avatarUploading}
                    className="px-3 py-1.5 rounded-md bg-bg-1 border border-line hover:bg-bg-3 text-ink-2 hover:text-ink-1 text-sm transition-colors disabled:opacity-60"
                  >
                    Remove picture
                  </button>
                )}
                {user.bannerUrl && (
                  <button
                    type="button"
                    onClick={clearBanner}
                    disabled={bannerUploading}
                    className="px-3 py-1.5 rounded-md bg-bg-1 border border-line hover:bg-bg-3 text-ink-2 hover:text-ink-1 text-sm transition-colors disabled:opacity-60"
                  >
                    Remove banner
                  </button>
                )}
              </div>
            )}

            <label className="block">
              <span className="text-sm text-ink-2">Display name</span>
              <input
                type="text"
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                onBlur={() => void save({ silent: true })}
                maxLength={32}
                className="mt-1 w-full bg-bg-1 border border-line rounded-md px-3 py-2 outline-none focus:border-accent transition-colors"
              />
            </label>

            <label className="block">
              <span className="text-sm text-ink-2">About Me</span>
              <textarea
                value={bio}
                onChange={(e) => setBio(e.target.value)}
                onBlur={() => void save({ silent: true })}
                maxLength={200}
                rows={3}
                className="mt-1 w-full bg-bg-1 border border-line rounded-md px-3 py-2 outline-none focus:border-accent transition-colors resize-none"
                placeholder="A short blurb about yourself"
              />
              <span className="text-xs text-ink-3 block mt-1">{(bio ?? '').length}/200</span>
            </label>

            {/* Custom status — emoji + text shown next to the presence dot on
                profile cards and DM lists. Sits after the bio (matches iOS);
                saves via its own modal (expiry options need the room). */}
            <CustomStatusRow />
          </section>

          {/* ── Notifications (Web Push) ───────────────────────────────── */}
          {/* Surfaced on the Capacitor native wrapper AND on installed PWAs
              (Add-to-Home-Screen on iOS / Android). Desktop browsers stay
              hidden because the section is most useful where it actually
              changes user behavior — phones. The display-mode media query is
              the standard signal for "installed PWA"; iOS uses the legacy
              navigator.standalone boolean. The inner component then handles
              all the per-platform support gates (iOS-needs-PWA, etc.). */}
          {(isNative() ||
            (typeof window !== 'undefined' &&
              (window.matchMedia?.('(display-mode: standalone)').matches ||
                (window.navigator as { standalone?: boolean }).standalone === true))) && (
            <section className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-ink-3">Notifications</div>
              <NotificationSettings />
              <NotificationTypeToggles />
            </section>
          )}

          {/* ── App / Install ──────────────────────────────────────────── */}
          {/* Only shown when there's something useful to do — if the app is
              already installed, this whole section vanishes. The install
              affordance is here (and not pushed in users' faces elsewhere)
              because it's a power-user action; users who want it know to
              look in settings. */}
          <InstallSection />


          {/* ── Privacy ──────────────────────────────────────────────────
              At the bottom: who can reach you, parental controls, and
              blocked users, all in one place. */}
          <section className="space-y-3">
            <div className="text-xs uppercase tracking-wider text-ink-3">Privacy</div>
            <PrivacySettings />
            <div className="pt-3 border-t border-line">
              <div className="text-sm text-ink-2 font-medium mb-1">Parental controls</div>
              <ParentalControlsToggle />
            </div>
            <ShowTierToggle />
            <div className="pt-3 border-t border-line">
              <div className="text-sm text-ink-2 font-medium mb-1">Reactions</div>
              <ReactionNotificationsToggle />
            </div>
            <div className="pt-3 border-t border-line">
              <div className="text-sm text-ink-2 font-medium mb-1">Achievements</div>
              <AchievementsVisibilityToggle />
              <AchievementNotificationsToggle />
              {/* Full shelf (earned + in-progress) — mirrors the iOS Settings
                  achievements gallery so in-progress badges stay visible even
                  though the profile card itself shows earned-only. */}
              <AchievementsShelf />
            </div>
            <div className="pt-3 border-t border-line">
              <div className="text-sm text-ink-2 font-medium mb-2">Blocked users</div>
              <BlockedSettings />
            </div>
            {/* Media storage — the honest statement of what server-side media
                retention does. Sits next to Legal because it's a data-
                retention promise, not a preference. */}
            <div className="pt-3 border-t border-line">
              <div className="text-sm text-ink-2 font-medium mb-2">Media storage</div>
              <MediaRetentionNotice />
            </div>
            {/* Legal — reachable from inside the app, not just at signup. Open
                in a new tab so Settings isn't unmounted underneath the reader. */}
            <div className="pt-3 border-t border-line">
              <div className="text-sm text-ink-2 font-medium mb-2">Legal</div>
              <div className="flex items-center gap-2 text-sm">
                <a
                  href="/terms"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Terms of Service
                </a>
                <span className="text-ink-3">·</span>
                <a
                  href="/privacy"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-accent hover:underline"
                >
                  Privacy Policy
                </a>
              </div>
            </div>
            {/* Sign out — last thing on the profile page, matching where the
                native apps put it. Moved here from the server rail, where it
                sat directly below the settings avatar and a misclick logged
                you out instead of opening settings. Confirmed because it's
                destructive-ish and now sits one click from everyday controls. */}
            <div className="pt-3 border-t border-line">
              <button
                onClick={() => {
                  if (!window.confirm('Sign out of Zekktris on this device?')) return;
                  void logout();
                }}
                className="w-full sm:w-auto px-3 py-2 rounded-lg text-sm font-medium border border-red-400/40 text-red-400 hover:bg-red-500/10 transition-colors inline-flex items-center justify-center gap-2"
              >
                <LogOut size={16} />
                Log out
              </button>
              <p className="text-xs text-ink-3 mt-2">
                Signs out this device only. Other devices stay signed in — manage
                them under Security → Active sessions.
              </p>
            </div>
            <DeleteAccountSection />
          </section>
          </>
        )}

        {activeTab === 'membership' && (
          <>
        {/* Staff name shimmer — an instance-STAFF perk (not tier-gated),
            shown first (matches iOS). Renders nothing for non-staff. */}
        <StaffShimmerSection />
        {/* Appearance — free for everyone (themes, avatar frames, name tags). */}
        <section className="rounded-xl border border-line bg-bg-2 p-3">
          <div className="flex items-baseline justify-between gap-2">
            <h2 className="text-xs uppercase tracking-wider text-ink-3">Appearance</h2>
            {/* Founder (grandfathered) rows carry perks but no title. */}
            {user?.subscriptionTier && user.subscriptionTitled ? (
              <TierBadge tier={user.subscriptionTier} />
            ) : (
              <span className="text-[0.65rem] text-ink-3 shrink-0">Theme · OLED = true black</span>
            )}
          </div>

          <h3 className="text-sm font-medium text-ink-1 mt-4 mb-1.5">Themes</h3>
          <div className="mt-2 grid grid-cols-3 sm:grid-cols-4 lg:grid-cols-6 gap-x-2 gap-y-2">
            {[...new Set(THEMES.map((t) => t.group))].map((group) => (
              <div key={group} className="flex flex-col gap-1">
                <div className="text-[0.6rem] uppercase tracking-wider text-ink-3 font-semibold px-0.5 truncate">
                  {group}
                </div>
                {THEMES.filter((t) => t.group === group).map((t) => {
                  const active = theme === t.id;
                  return (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => chooseTheme(t.id)}
                      aria-pressed={active}
                      title={t.label}
                      className={`text-left rounded-md border p-1 transition-colors ${
                        active
                          ? 'border-accent bg-accent/10'
                          : 'border-line bg-bg-1 hover:border-accent/40'
                      }`}
                    >
                      {/* iOS swatch: two overlapping accent circles centered over
                          the theme's base colour, with an accent check badge when
                          selected (no inline OLED text — OLED variants read as the
                          pure-black base). */}
                      <div
                        className="relative h-9 rounded border border-line/60 flex items-center justify-center"
                        style={{ background: t.bg }}
                      >
                        <span
                          className="w-4 h-4 rounded-full border border-black/30"
                          style={{ background: t.swatch[0] }}
                        />
                        <span
                          className="w-4 h-4 rounded-full border border-black/30 -ml-1.5"
                          style={{ background: t.swatch[1] }}
                        />
                        {active && (
                          <span className="absolute top-1 right-1 w-3.5 h-3.5 rounded-full bg-accent grid place-items-center">
                            <Check size={9} className="text-white" />
                          </span>
                        )}
                      </div>
                      <div
                        className={`mt-0.5 text-[0.65rem] font-medium truncate leading-tight ${
                          active ? 'text-accent' : 'text-ink-1'
                        }`}
                      >
                        {t.label}
                      </div>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>

          {/* Avatar Decoration — a cosmetic ring/glow others see on your
              avatar. Saves immediately; previews render the live overlay. */}
          <div className="mt-4 pt-3 border-t border-line">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-ink-1">Avatar Decoration</h3>
              <span className="text-[0.65rem] text-ink-3 shrink-0">
                {decoSaving ? 'Saving…' : 'Shown on your avatar everywhere'}
              </span>
            </div>
            <div className="mt-2 grid grid-cols-4 sm:grid-cols-5 lg:grid-cols-6 gap-2">
              {AVATAR_DECORATIONS.map((d) => {
                const active = (user?.avatarDecoration ?? 'none') === d.id;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => void chooseDecoration(d.id)}
                    disabled={decoSaving}
                    aria-pressed={active}
                    title={d.label}
                    className={`flex flex-col items-center gap-1 rounded-md border p-2 transition-colors disabled:opacity-60 ${
                      active
                        ? 'border-accent bg-accent/10'
                        : 'border-line bg-bg-1 hover:border-accent/40'
                    }`}
                  >
                    <span className="relative w-9 h-9 shrink-0">
                      <span
                        className={`absolute inset-0 rounded-full text-xs flex items-center justify-center font-semibold ${avatarColor(
                          user?.id ?? '0',
                        )}`}
                      >
                        <span className="zk-avatar-initials">{avatarInitials(user?.displayName ?? '?')}</span>
                      </span>
                      <AvatarImage src={user?.avatarUrl} />
                      <AvatarDecoration decoration={d.id} />
                    </span>
                    <span
                      className={`text-[0.6rem] font-medium truncate leading-tight max-w-full ${
                        active ? 'text-accent' : 'text-ink-2'
                      }`}
                    >
                      {d.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Name Tag — a small "clan tag" pill (emoji + color + up to 6
              chars) shown IN FRONT of your name everywhere it appears. */}
          <div className="mt-4 pt-3 border-t border-line">
            <div className="flex items-baseline justify-between gap-2">
              <h3 className="text-sm font-medium text-ink-1">Name Tag</h3>
              <span className="text-[0.65rem] text-ink-3 shrink-0">Shown in front of your name</span>
            </div>
            <TagSettings />
          </div>
        </section>
        {/* What each perk tier adds, with a "Your tier" badge on the active one
            (mirrors the iOS perk list). */}
        <PerkTiers />
        {/* Hide clan tags is a per-device VIEWER preference — anyone can
            declutter names. */}
        <section className="rounded-xl border border-line bg-bg-2 p-3">
          <h2 className="text-xs uppercase tracking-wider text-ink-3">Display</h2>
          <div className="mt-2">
            <HideClanTagsToggle />
          </div>
        </section>
          </>
        )}

        {activeTab === 'security' && (
          <>
            {/* Security group first (matches iOS): passkeys, two-factor, then
                approving a sign-in on a new device. Note the direction — this
                device APPROVES others; it never hands out a code that is
                itself a credential. */}
            {passkeysAvailable() && <PasskeysSection />}
            <TwoFactorSection />
            <DeviceApprovalSection />

            {/* Privacy — per-device; off by default (see lib/e2eeLinkPreviews). */}
            <section className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-ink-3">Privacy</div>
              <E2eeLinkPreviewsToggle />
            </section>

            {/* Account identity — username + email (credential changes, each
                re-confirmed with the current password), then the copyable
                User ID (iOS row order). */}
            <section className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-ink-3">Account</div>
              <UsernameSection />
              <EmailSection />
              <UserIdSection />
            </section>

            {/* Password, active sessions, then bots close out the account
                group (matches the iOS ACCOUNT row order). iOS folds bot
                management into Security→Account rather than giving it a
                standalone tab, since bot tokens are credentials like any
                other. */}
            <PasswordSection />
            <SessionsSection />
            <BotsSection />
          </>
        )}

        {activeTab === 'voice' && (
          <>
            {/* ── Voice & Video ──────────────────────────────────────────
                Device selectors (input mic / output speaker / camera),
                audio processing toggles (echo cancel, noise suppression,
                auto gain), and video quality preference. All settings
                here persist immediately to localStorage; no Save
                Changes click required. */}
            <section className="space-y-2">
              <div className="text-xs uppercase tracking-wider text-ink-3">Voice & Video</div>
              <VoiceDeviceSettings />
              <VideoQualitySettings />
            </section>
          </>
        )}
        </div>
      </div>
  );
}

// ── Voice & Video device settings ──────────────────────────────────────────
//
// Shows mic + speaker dropdowns plus a "Test microphone" button that
// runs a quick getUserMedia round-trip. The test serves two purposes:
//   1. Diagnostic — surfaces the precise error if mic is denied/missing.
//   2. Permission gate — calling getUserMedia is what makes the browser
//      reveal device LABELS in enumerateDevices(). Without it,
//      Chrome/Firefox return device IDs with empty `label` fields, so
//      the dropdown would just show "Microphone 1, Microphone 2" with
//      no way to tell which is which.

function VoiceDeviceSettings() {
  const toasts = useToasts();
  const [devices, setDevices] = useState<AudioDeviceList | null>(null);
  const [input, setInput] = useState<string>(getSavedInputDeviceId());
  const [output, setOutput] = useState<string>(getSavedOutputDeviceId());
  const [quality, setQuality] = useState<VoiceQuality>(getVoiceQuality());
  const [testing, setTesting] = useState(false);
  const [testingSpeaker, setTestingSpeaker] = useState(false);
  // PTT mode + key. We mirror localStorage in component state so React
  // re-renders when the user switches mode or rebinds the key. The
  // voice manager reads from localStorage directly on every keypress,
  // so this state isn't authoritative — it's just the display copy.
  const [mode, setMode] = useState<AudioMode>(getAudioMode());
  const [pttKey, setPttKeyState] = useState<string>(getPttKey());
  const [bindingKey, setBindingKey] = useState(false);
  // Deafen hotkey (F7). Opt-in — empty string means unbound/disabled.
  const [deafenKey, setDeafenKeyState] = useState<string>(getDeafenKey());
  const [bindingDeafen, setBindingDeafen] = useState(false);

  // Capture the next key while the rebind UI is active. We use the
  // physical `code` (not `key`) so layouts don't matter — pressing
  // physical-V on QWERTY and AZERTY both yield 'KeyV'.
  useEffect(() => {
    if (!bindingKey) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      // Escape cancels without rebinding. Anything else is the new key.
      if (e.code !== 'Escape') {
        setPttKey(e.code);
        setPttKeyState(e.code);
      }
      setBindingKey(false);
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [bindingKey]);

  // Same capture flow for the deafen hotkey, except Escape CLEARS the
  // binding (the hotkey is opt-in, so Escape doubles as "disable it").
  useEffect(() => {
    if (!bindingDeafen) return;
    const handler = (e: KeyboardEvent) => {
      e.preventDefault();
      const next = e.code === 'Escape' ? '' : e.code;
      setDeafenKey(next);
      setDeafenKeyState(next);
      setBindingDeafen(false);
    };
    window.addEventListener('keydown', handler, { capture: true });
    return () => window.removeEventListener('keydown', handler, { capture: true });
  }, [bindingDeafen]);

  const refresh = async () => {
    try {
      setDevices(await listAudioDevices());
    } catch (e) {
      toasts.push(e instanceof Error ? e.message : 'Could not list audio devices', 'error');
    }
  };

  useEffect(() => {
    void refresh();
    // Browsers fire `devicechange` when a USB mic is plugged/unplugged or
    // a Bluetooth headset connects. Re-enumerate so the dropdown stays
    // current without requiring a settings re-open.
    const handler = () => void refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', handler);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', handler);
  }, []);

  async function changeInput(id: string) {
    setInput(id);
    await setSavedInputDeviceId(id);
  }

  async function changeOutput(id: string) {
    setOutput(id);
    await setSavedOutputDeviceId(id);
  }

  async function test() {
    setTesting(true);
    try {
      await requestMicPermission();
      // Re-enumerate with labels now populated.
      await refresh();
      toasts.push('Microphone working — labels updated', 'success');
    } catch (e) {
      // VoiceError carries a user-facing message; everything else gets
      // a generic prefix.
      toasts.push(e instanceof VoiceError ? e.message : 'Microphone test failed', 'error');
    } finally {
      setTesting(false);
    }
  }

  if (!devices) {
    return <p className="text-sm text-ink-3">Loading audio devices…</p>;
  }

  // Native iOS shell: the WebView doesn't expose per-device enumeration —
  // iOS routes audio through the system. Surface the secure-context state
  // here because voice (getUserMedia) only works over https.
  if (isNative()) {
    if (typeof window !== 'undefined' && !window.isSecureContext) {
      return (
        <p className="text-sm text-ink-3">
          The app isn't running over a secure (https) connection, so the
          microphone is unavailable. Make sure <code>server.url</code> in
          capacitor.config.ts points to your <code>https://</code> site, then
          run <code>npx cap sync ios</code> and rebuild.
        </p>
      );
    }
    return (
      <p className="text-sm text-ink-3">
        Zekktris uses your iPhone's default microphone and speaker (including
        Bluetooth or AirPlay when connected). Audio routing is managed by iOS.
      </p>
    );
  }

  // Browsers without mediaDevices (very old, or insecure-context HTTP).
  if (!navigator.mediaDevices?.enumerateDevices) {
    return (
      <p className="text-sm text-ink-3">
        Your browser doesn't support audio device selection. This usually means the page is loaded
        over plain HTTP — voice requires HTTPS or localhost.
      </p>
    );
  }

  const labelFor = (d: MediaDeviceInfo) =>
    d.label || (d.deviceId === 'default' ? 'System default' : `Device ${d.deviceId.slice(0, 6)}`);

  return (
    <div className="space-y-3">
      {!devices.labelsAvailable && (
        <div className="text-xs text-ink-3 bg-bg-1 border border-line rounded-md px-3 py-2">
          Device names are hidden until you grant microphone permission. Click "Test microphone"
          below to allow access — names will populate once you do.
        </div>
      )}

      <label className="block">
        <span className="text-xs text-ink-2">Microphone</span>
        <select
          value={input}
          onChange={(e) => void changeInput(e.target.value)}
          className="mt-1 w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1"
        >
          <option value="">System default</option>
          {devices.inputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {labelFor(d)}
            </option>
          ))}
        </select>
      </label>

      <label className="block">
        <span className="text-xs text-ink-2">Speaker</span>
        <select
          value={output}
          onChange={(e) => void changeOutput(e.target.value)}
          className="mt-1 w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1"
        >
          <option value="">System default</option>
          {devices.outputs.map((d) => (
            <option key={d.deviceId} value={d.deviceId}>
              {labelFor(d)}
            </option>
          ))}
        </select>
        {devices.outputs.length === 0 && (
          <span className="block text-xs text-ink-3 mt-1">
            Output device selection isn't supported in this browser. Audio uses your system default.
          </span>
        )}
      </label>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={() => void testSpeaker()}
          disabled={testingSpeaker}
          className="px-3 py-1.5 rounded-md text-sm bg-bg-3 hover:bg-bg-3/70 disabled:opacity-60"
        >
          {testingSpeaker ? 'Playing…' : 'Test speaker'}
        </button>
        <button
          type="button"
          onClick={() => void test()}
          disabled={testing}
          className="px-3 py-1.5 rounded-md text-sm bg-bg-3 hover:bg-bg-3/70 disabled:opacity-60"
        >
          {testing ? 'Testing…' : 'Test microphone'}
        </button>
      </div>

      {/* ── Voice quality ──────────────────────────────────────────── */}
      <div className="pt-3 border-t border-line space-y-2">
        <span className="text-xs text-ink-2 font-medium">Voice quality</span>
        <div className="grid grid-cols-3 gap-2">
          {(['high', 'normal', 'low'] as const).map((key) => {
            const preset = QUALITY_PRESETS[key];
            const active = quality === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => {
                  setVoiceQuality(key);
                  setQuality(key);
                }}
                className={`text-left px-3 py-2 rounded-md border transition-colors ${
                  active
                    ? 'bg-accent/15 border-accent/60'
                    : 'bg-bg-1 border-line hover:bg-bg-3'
                }`}
              >
                <div className="font-medium text-sm">{preset.label}</div>
                <div className="text-xs text-ink-3 mt-0.5 leading-snug">{preset.help}</div>
              </button>
            );
          })}
        </div>
        <p className="text-xs text-ink-3 leading-snug">
          Changes apply on your next voice connection. Leave and rejoin a voice channel for new settings to take effect.
        </p>
      </div>

      {/* ── Audio processing ───────────────────────────────────────
          Three browser-native filters that shape your outgoing mic
          stream before it leaves your machine. They're on by default
          (standard for voice chat apps), but exposing them lets users
          troubleshoot — e.g. if AGC is over-pumping a soft mic, or
          noise suppression is mangling the start of words. */}
      <AudioProcessingToggles />

      {/* ── Input Mode (Voice Activity vs. Push-to-Talk) ───────────── */}
      <div className="pt-3 border-t border-line space-y-2">
        <span className="text-xs text-ink-2 font-medium">Input mode</span>
        <div className="grid grid-cols-2 gap-2">
          <button
            type="button"
            onClick={() => changeMode('vad')}
            className={`text-left px-3 py-2 rounded-md border transition-colors ${
              mode === 'vad'
                ? 'bg-accent/15 border-accent/60'
                : 'bg-bg-1 border-line hover:bg-bg-3'
            }`}
          >
            <div className="font-medium text-sm">Voice activity</div>
            <div className="text-xs text-ink-3 mt-0.5">
              Mic transmits when you speak. Default behavior.
            </div>
          </button>
          <button
            type="button"
            onClick={() => changeMode('ptt')}
            className={`text-left px-3 py-2 rounded-md border transition-colors ${
              mode === 'ptt'
                ? 'bg-accent/15 border-accent/60'
                : 'bg-bg-1 border-line hover:bg-bg-3'
            }`}
          >
            <div className="font-medium text-sm">Push to talk</div>
            <div className="text-xs text-ink-3 mt-0.5">
              Mic stays muted until you hold a key.
            </div>
          </button>
        </div>

        {mode === 'ptt' && (
          <label className="block">
            <span className="text-xs text-ink-2">Push-to-talk key</span>
            <button
              type="button"
              onClick={() => setBindingKey(true)}
              className={`mt-1 w-full px-3 py-2 bg-bg-1 border rounded-md text-sm text-left transition-colors ${
                bindingKey ? 'border-accent ring-1 ring-accent/40' : 'border-line'
              }`}
            >
              {bindingKey
                ? 'Press any key…'
                : <span className="font-mono">{formatKeyCode(pttKey)}</span>}
            </button>
            <span className="block text-xs text-ink-3 mt-1">
              Avoid keys you use while typing — Space is fine for chat-light voice channels but
              consider a function key (F1–F12) or a side-mouse-button-like binding for chat-heavy ones.
            </span>
          </label>
        )}
      </div>

      {/* ── Deafen hotkey (F7) ──────────────────────────────────────── */}
      <div className="pt-3 border-t border-line space-y-2">
        <span className="text-xs text-ink-2 font-medium">Deafen hotkey</span>
        <p className="text-xs text-ink-3">
          A single key to toggle deafen while in a call — works from any screen.
          Optional; leave unset to disable.
        </p>
        <label className="block">
          <button
            type="button"
            onClick={() => setBindingDeafen(true)}
            className={`mt-1 w-full px-3 py-2 bg-bg-1 border rounded-md text-sm text-left transition-colors ${
              bindingDeafen ? 'border-accent ring-1 ring-accent/40' : 'border-line'
            }`}
          >
            {bindingDeafen ? (
              'Press any key… (Esc to clear)'
            ) : deafenKey ? (
              <span className="font-mono">{formatKeyCode(deafenKey)}</span>
            ) : (
              <span className="text-ink-3">Not set</span>
            )}
          </button>
        </label>
      </div>
    </div>
  );

  // Speaker test: synthesize a 0.4s 440Hz beep using WebAudio, route
  // it through the saved output device. This is a sanity check that
  // (a) audio output works at all and (b) the selected output device
  // is the one the user expects.
  async function testSpeaker() {
    setTestingSpeaker(true);
    try {
      const ctx = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
      // Try to route to the saved sink. setSinkId is on HTMLAudioElement,
      // not on AudioContext — for a programmatic beep the cleanest path
      // is to render to an <audio> element via MediaStreamDestination.
      const dest = ctx.createMediaStreamDestination();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = 440;
      gain.gain.value = 0.1;
      osc.connect(gain);
      gain.connect(dest);
      osc.start();
      const audio = new Audio();
      audio.srcObject = dest.stream;
      const sinkId = getSavedOutputDeviceId();
      if (sinkId && (audio as unknown as { setSinkId?: (id: string) => Promise<void> }).setSinkId) {
        try {
          await (audio as unknown as { setSinkId: (id: string) => Promise<void> }).setSinkId(sinkId);
        } catch {
          // Sink switch failed; fall back to default. Browser still plays.
        }
      }
      await audio.play();
      await new Promise((r) => setTimeout(r, 400));
      osc.stop();
      audio.pause();
      await ctx.close().catch(() => {});
      toasts.push('If you heard a beep, your speaker is working', 'success');
    } catch (e) {
      toasts.push(
        e instanceof Error ? `Speaker test failed: ${e.message}` : 'Speaker test failed',
        'error',
      );
    } finally {
      setTestingSpeaker(false);
    }
  }

  function changeMode(next: AudioMode) {
    setMode(next);
    setAudioMode(next);
  }
}

// ── Audio processing toggles ──────────────────────────────────────────────
//
// Three independent browser-native filters that shape the outgoing
// mic before it hits the network. Defaults: all on. Each toggle
// writes to voicePrefs, which voice.ts reads when constructing the
// Room. Changes take effect on the next voice connect — LiveKit
// doesn't expose a runtime path to renegotiate audio constraints
// on an active publication, and trying to fake it via track stop +
// re-publish causes a perceptible audio drop on the listener's end.
//
// On keyboard noise specifically: the browser's `noiseSuppression`
// uses an RNN trained on diffuse environmental noise (HVAC, traffic,
// fan hum). It's intentionally conservative about transients like
// key clicks because aggressive suppression also clips speech
// consonants. If keyboard noise is unacceptable with NS on, the
// reliable answer is push-to-talk (mic only transmits while a key
// is held) — that mode is configurable in the section below.

function AudioProcessingToggles() {
  const [, force] = useState(0);
  // Re-render when prefs change elsewhere (e.g. another tab) so
  // the toggle reflects current state.
  useEffect(() => {
    return subscribeVoicePrefs(() => force((n) => n + 1));
  }, []);
  const p = getVoicePrefs();

  return (
    <div className="pt-3 border-t border-line space-y-2">
      <span className="text-xs text-ink-2 font-medium">Audio processing</span>
      <p className="text-xs text-ink-3 leading-snug">
        Browser-side filters that clean up your outgoing mic. Toggle off to
        compare quality. Most changes take effect on your next voice
        connection; gain mode and manual gain apply live in-call.
      </p>
      <ToggleRow
        title="Noise suppression"
        help="Trims background hum and steady noise via the browser's built-in suppressor plus a software compression chain. For aggressive filtering of intermittent noise (typing, breathing, fan kicks), drag the violet line on the meter below to set a noise gate."
        checked={p.noiseSuppression}
        onChange={setNoiseSuppression}
      />
      <ToggleRow
        title="Echo cancellation"
        help="Stops your own voice from looping back when you use speakers instead of headphones. Leave on unless you have an external echo canceller."
        checked={p.echoCancellation}
        onChange={setEchoCancellation}
      />

      {/* Input-level meter — sits above the mode selector so the
          user can see what their current setting is doing before
          they touch it. Opens its own getUserMedia stream so it
          works even when not in a call. */}
      <MicLevelMeter />

      {/* Gain mode: 3-way segmented control. Replaces the older
          binary "AGC on/off" toggle so the user can pick between
          browser AGC, manual gain (with a slider), or raw input
          (no processing at all — for hardware audio chains). */}
      <fieldset className="px-3 py-2 rounded-md bg-bg-1 border border-line">
        <legend className="text-xs text-ink-1 font-medium px-1">Gain mode</legend>
        <div role="radiogroup" className="mt-1 flex gap-1">
          <GainModeOption
            value="agc"
            current={p.gainMode}
            label="Auto"
            sub="Browser AGC"
          />
          <GainModeOption
            value="manual"
            current={p.gainMode}
            label="Manual"
            sub="Slider below"
          />
          <GainModeOption
            value="off"
            current={p.gainMode}
            label="Off"
            sub="Raw input"
          />
        </div>
        <p className="text-xs text-ink-3 mt-2 leading-snug">
          {p.gainMode === 'agc' &&
            'Browser AGC levels soft and loud voices automatically. Best for most setups; turn off if your mic sounds unnaturally compressed.'}
          {p.gainMode === 'manual' &&
            "AGC off, your gain slider applies a fixed multiplier before publishing. Set it once and the meter above shows what listeners will hear."}
          {p.gainMode === 'off' &&
            'No software gain processing at all. Use this if a hardware preamp or dynamics processor is shaping your mic before it reaches the browser.'}
        </p>

        {/* Manual gain slider. Always rendered so the slider thumb
            doesn't jump when switching modes; disabled outside
            manual mode to make the inert state visible. The on-the-
            fly preview comes from the meter above — drag the
            slider, the meter follows. */}
        <div className={`mt-3 ${p.gainMode === 'manual' ? '' : 'opacity-50 pointer-events-none'}`}>
          <div className="flex items-center justify-between text-xs text-ink-2 mb-1">
            <span>Manual gain</span>
            <span className="tabular-nums text-ink-3">{Math.round(p.micGain * 100)}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={200}
            step={5}
            value={Math.round(p.micGain * 100)}
            onChange={(e) => setMicGain(Number(e.target.value) / 100)}
            className="w-full accent-accent"
            aria-label="Manual mic gain"
            disabled={p.gainMode !== 'manual'}
          />
          <div className="flex justify-between text-[0.65rem] text-ink-3 mt-0.5">
            <span>0%</span>
            <span>100%</span>
            <span>200%</span>
          </div>
        </div>
      </fieldset>
    </div>
  );
}

/** One option in the gain-mode segmented control. Visually
    distinguishes the selected state with a filled background and
    accent text; unselected options stay neutral. */
function GainModeOption({
  value,
  current,
  label,
  sub,
}: {
  value: 'agc' | 'manual' | 'off';
  current: 'agc' | 'manual' | 'off';
  label: string;
  sub: string;
}) {
  const active = value === current;
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={() => setGainMode(value)}
      className={`flex-1 px-2 py-1.5 rounded text-xs transition-colors ${
        active
          ? 'bg-accent/20 text-accent border border-accent/40'
          : 'bg-bg-3 text-ink-2 border border-line hover:text-ink-1'
      }`}
    >
      <div className="font-medium">{label}</div>
      <div className="text-[0.65rem] mt-0.5 opacity-80">{sub}</div>
    </button>
  );
}

function ToggleRow({
  title,
  help,
  checked,
  onChange,
}: {
  title: string;
  help: string;
  checked: boolean;
  onChange: (next: boolean) => void;
}) {
  // The control is the same pill switch every other boolean on this page
  // uses (iOS/Android use one Toggle style throughout — a raw checkbox
  // among eight pills read as a different app). The real <input> stays
  // for keyboard + screen-reader semantics; it's visually hidden and the
  // pill is painted next to it, with the focus ring driven off `peer`.
  return (
    <label className="flex items-center justify-between gap-3 px-3 py-2 rounded-md bg-bg-1 border border-line cursor-pointer hover:bg-bg-3/40 transition-colors">
      <div className="min-w-0 flex-1">
        <div className="text-sm text-ink-1 font-medium">{title}</div>
        <div className="text-xs text-ink-3 mt-0.5 leading-snug">{help}</div>
      </div>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="sr-only peer"
      />
      <span
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors peer-focus-visible:ring-2 peer-focus-visible:ring-accent ${
          checked ? 'bg-accent/70' : 'bg-bg-3'
        }`}
        aria-hidden
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            checked ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </span>
    </label>
  );
}

/**
 * Per-device "what to notify me about" toggles — messages vs calls.
 * Mirrors the native app's Settings → Notifications switches (labels and
 * subtitles copied from the iOS UI, which is the visual source of truth):
 * "Messages & mentions" / "Direct messages and @mentions." and
 * "Incoming calls" / "Ring for 1-on-1 calls." Device-local (localStorage),
 * default ON — see lib/notifyPrefs. Rendered alongside the web-push
 * subscription UI so it shows regardless of push-subscription state.
 */
function NotificationTypeToggles() {
  const prefs = useSyncExternalStore(subscribeNotifyPrefs, getNotifyPrefs, getNotifyPrefs);
  return (
    <>
      <ToggleRow
        title="Messages & mentions"
        help="Direct messages and @mentions."
        checked={prefs.notifyMessages}
        onChange={setNotifyMessages}
      />
      <ToggleRow
        title="Incoming calls"
        help="Ring for 1-on-1 calls."
        checked={prefs.notifyCalls}
        onChange={setNotifyCalls}
      />
    </>
  );
}

// ── Notification (Web Push) settings ──────────────────────────────────────
//
// Subscribe/unsubscribe to push notifications + show registered devices.
// The browser issues an opaque endpoint per device; the server stores
// it and pushes to it on @mentions and DMs. Permission flow:
//
// 1. User clicks "Enable" → check VAPID is configured server-side.
// 2. Register the SW (idempotent — if already registered, the existing
//    one is reused).
// 3. Call `pushManager.subscribe()` — this prompts the browser
//    permission UI on the FIRST call and silently returns the existing
//    subscription on subsequent calls.
// 4. POST the subscription to the server.
//
// Unsubscribe is symmetric: `pushManager.unsubscribe()` to remove the
// browser-side registration, then DELETE on the server.

/**
 * TagSettings — editor for the custom name tag ("clan tag"). Lives in the
 * Appearance section. The tag (emoji + #color + up to 6 chars) renders IN
 * FRONT of the user's name everywhere it appears. Saves via PATCH /@me;
 * the live preview shows the pill ahead of the name to match render order.
 */
function TagSettings() {
  const { rest, user, updateUser } = useAuth();
  const toasts = useToasts();
  const [color, setColor] = useState(user?.tagColor ?? '#3dd7ec');
  const [label, setLabel] = useState(user?.tagLabel ?? '');
  const [pending, setPending] = useState(false);

  const dirty =
    color !== (user?.tagColor ?? '#3dd7ec') ||
    label !== (user?.tagLabel ?? '');

  async function save() {
    if (pending) return;
    setPending(true);
    try {
      const res = await rest.patchMe({
        tagLabel: label.trim() === '' ? null : label.trim(),
        tagColor: color,
      });
      updateUser(res.user);
      toasts.push('Tag saved', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Tag update failed', 'error');
    } finally {
      setPending(false);
    }
  }

  async function clearTag() {
    if (pending) return;
    setLabel('');
    setPending(true);
    try {
      const res = await rest.patchMe({ tagLabel: null });
      updateUser(res.user);
      toasts.push('Tag cleared', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Tag update failed', 'error');
    } finally {
      setPending(false);
    }
  }

  const preview = {
    tagLabel: label.trim() || null,
    tagColor: color,
  };
  const hasTag = !!user?.tagLabel;

  return (
    <div className="space-y-3 mt-2">
      <p className="text-xs text-ink-3">
        A small tag shown in front of your name everywhere — a color and up to
        4 characters. Leave it blank for no tag.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1">
          <span className="text-[0.7rem] text-ink-3">Color</span>
          <input
            type="color"
            value={color}
            onChange={(e) => setColor(e.target.value)}
            className="w-12 h-9 bg-bg-2 border border-line rounded-md p-0.5 cursor-pointer"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[0.7rem] text-ink-3">Label</span>
          <input
            value={label}
            onChange={(e) => setLabel(e.target.value.slice(0, 4))}
            maxLength={4}
            placeholder="CLAN"
            className="w-28 bg-bg-2 border border-line rounded-md px-2 py-1.5 text-sm outline-none focus:border-accent transition-colors"
          />
        </label>
        <div className="flex flex-col gap-1">
          <span className="text-[0.7rem] text-ink-3">Preview</span>
          <div className="h-9 flex items-center gap-1.5 px-2.5 rounded-md bg-bg-2 border border-line">
            {/* ignoreHidePref: the editor preview stays visible even when the
                viewer has "Hide clan tags" on — you're editing this tag. */}
            <UserTag user={preview} ignoreHidePref />
            {/* Nudge the name down 1px to sit level with the tag pill's optical
                center — DESKTOP ONLY (`sm:top-px`). Mobile browsers already
                render it aligned, so the nudge would over-correct there.
                Routed through <StaffName> so the preview shows the same name
                treatment (staff shimmer + optional glow, when entitled and not
                opted out) that the tag will actually sit next to elsewhere. */}
            {user ? (
              <StaffName
                user={user}
                text={user.displayName}
                className="relative sm:top-px inline-block text-sm text-ink-1 font-medium truncate max-w-[10rem]"
              />
            ) : (
              <span className="relative sm:top-px text-sm text-ink-1 font-medium truncate max-w-[10rem]">
                You
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => void save()}
          disabled={pending || !dirty}
          className="px-3 py-1.5 rounded-md text-sm font-medium bg-accent text-bg-0 hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
        >
          {pending ? 'Saving…' : 'Save tag'}
        </button>
        {hasTag && (
          <button
            type="button"
            onClick={() => void clearTag()}
            disabled={pending}
            className="px-3 py-1.5 rounded-md text-sm text-ink-2 hover:text-ink-1 border border-line hover:bg-bg-3 disabled:opacity-50 transition-colors"
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}

/** One row of the perk list: what a session at `rank` gets on this instance,
 *  read from the admin-configured streaming gates in lib/voice. */
function perksAtRank(rank: number): string[] {
  const screen = SCREEN_QUALITY_PRESETS[highestAllowedScreenQuality(rank)].label;
  const fps = isScreenFps60Allowed(rank) ? 60 : 30;
  const camera =
    CAMERA_QUALITY_PRESETS[highestAllowedCameraQuality(rank)]?.label ??
    CAMERA_QUALITY_PRESETS.p720!.label;
  return [`Screen share up to ${screen} at ${fps} fps`, `Camera up to ${camera}`];
}

/**
 * PerkTiers — what each tier adds, shown to everyone in the Appearance tab.
 * There are no payments: the whole app (cosmetics included) is free, and an
 * admin gives out Scout / Guardian / Legend for extra streaming quality. The
 * lines are computed from this instance's perk settings, so they stay true
 * when an admin retunes them.
 */
function PerkTiers() {
  const { user } = useAuth();
  useSyncExternalStore(subscribeMonetization, getMonetizationVersion, getMonetizationVersion);
  const tier = user?.subscriptionTier ?? null;
  const rows: Array<{ id: string; label: string; color: string; perks: string[] }> = [
    {
      id: 'everyone',
      label: 'Everyone',
      color: '#b5becf', // ink-2
      perks: ['Every feature, plus all themes, avatar frames & name tags', ...perksAtRank(0)],
    },
    ...(['scout', 'guardian', 'legend'] as const).map((id) => ({
      id,
      label: TIER_META[id]!.label,
      color: TIER_META[id]!.color,
      perks: [...perksAtRank(MONETIZE_TIER_RANK[id]), 'Tier title on your profile'],
    })),
  ];

  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3">Perk tiers</div>
      <p className="text-xs text-ink-3 leading-relaxed">
        Zekktris is free — nothing is for sale. Perk tiers add streaming quality on top, and this
        server&rsquo;s admins hand them out. A supervising parent&rsquo;s tier also covers their
        children.
      </p>
      <div className="space-y-2">
        {rows.map((r) => {
          const current = r.id === 'everyone' ? !tier : tier === r.id;
          return (
            <div
              key={r.id}
              className="rounded-xl border border-line p-3"
              style={
                current
                  ? {
                      borderColor: `color-mix(in srgb, ${r.color} 50%, transparent)`,
                      backgroundColor: `color-mix(in srgb, ${r.color} 8%, transparent)`,
                    }
                  : undefined
              }
            >
              <div className="flex items-center gap-2">
                <span className="text-sm font-bold" style={{ color: r.color }}>
                  {r.label}
                </span>
                {current && (
                  <span
                    className="ml-auto text-[0.6rem] font-bold tracking-wide px-1.5 py-0.5 rounded-full"
                    style={{
                      color: r.color,
                      backgroundColor: `color-mix(in srgb, ${r.color} 20%, transparent)`,
                    }}
                  >
                    YOUR TIER
                  </span>
                )}
              </div>
              <ul className="mt-1.5 space-y-1">
                {r.perks.map((p) => (
                  <li key={p} className="flex items-start gap-1.5 text-xs text-ink-2">
                    <span className="mt-px font-bold shrink-0" style={{ color: r.color }}>
                      ✓
                    </span>
                    <span>{p}</span>
                  </li>
                ))}
              </ul>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Profile privacy: whether the perk tier title shows on the profile
 * popup. Only rendered for TITLED members — founder (grandfathered)
 * memberships have no title, so there's nothing to show or hide. Renders its
 * own bordered wrapper so non-titled users don't get an empty headed block.
 */
function ShowTierToggle() {
  const { user, rest, updateUser } = useAuth();
  const [busy, setBusy] = useState(false);
  if (!user?.subscriptionTier || !user.subscriptionTitled) return null;
  const shown = user.showSubscriptionTier !== false;
  return (
    <div className="pt-3 border-t border-line">
      <div className="text-sm text-ink-2 font-medium mb-1">Perk tier</div>
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-bg-2 border border-line rounded-lg">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">Show my perk tier</p>
        <p className="text-xs text-ink-3 leading-relaxed mt-0.5">
          Displays your {TIER_META[user.subscriptionTier]?.label ?? 'perk'} title on
          your profile popup. Turning this off hides the title — your perks keep working.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={shown}
        aria-label="Show my perk tier"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          rest
            .patchMe({ showSubscriptionTier: !shown })
            .then((r) => updateUser(r.user))
            .catch(() => undefined)
            .finally(() => setBusy(false));
        }}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-50 ${
          shown ? 'bg-accent/70' : 'bg-bg-3'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            shown ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
    </div>
  );
}

/**
 * Per-device declutter toggle: when on, every clan/name-tag pill is hidden in
 * this user's own UI (their own included). Handled inside UserTag, so this
 * just flips the reactive preference.
 */
function HideClanTagsToggle() {
  const hidden = useHideClanTags();
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-bg-2 border border-line rounded-lg">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">Hide clan tags</p>
        <p className="text-xs text-ink-3 leading-relaxed mt-0.5">
          Hides everyone's name-tag pills (yours too) throughout the app on this
          device. Your tag is still visible to others.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={hidden}
        aria-label="Hide clan tags"
        onClick={() => setHideClanTags(!hidden)}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          hidden ? 'bg-accent/70' : 'bg-bg-3'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            hidden ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function ParentalControlsToggle() {
  const enabled = useParentalControlsEnabled();
  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-bg-2 border border-line rounded-lg">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">Show Family in the sidebar</p>
        <p className="text-xs text-ink-3 leading-relaxed mt-0.5">
          Adds a Family button to the rail so you can supervise a child
          account, or manage who supervises yours. Off by default.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Show Family in the sidebar"
        onClick={() => setParentalControlsEnabled(!enabled)}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          enabled ? 'bg-accent/70' : 'bg-bg-3'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            enabled ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

/**
 * Public-achievements toggle. Mirrors the iOS Settings switch: when off,
 * the achievements shelf is visible only on your own profile — the server
 * answers other users' /users/:id/achievements with an empty list.
 */
function AchievementsVisibilityToggle() {
  const { rest } = useAuth();
  const [publicShelf, setPublicShelf] = useState<boolean | null>(null);

  useEffect(() => {
    let cancelled = false;
    rest
      .myAchievements()
      .then((r) => {
        // Achievements are shown by default — treat a missing flag as on.
        if (!cancelled) setPublicShelf(r.public ?? true);
      })
      .catch(() => {
        if (!cancelled) setPublicShelf(true);
      });
    return () => {
      cancelled = true;
    };
  }, [rest]);

  const flip = async () => {
    if (publicShelf === null) return;
    const next = !publicShelf;
    setPublicShelf(next);
    try {
      await rest.patchMe({ achievementsPublic: next });
    } catch {
      setPublicShelf(!next); // revert on failure
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-bg-2 border border-line rounded-lg">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">Public achievements</p>
        <p className="text-xs text-ink-3 leading-relaxed mt-0.5">
          Let others see your achievements on your profile. Off keeps them
          private to you.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={publicShelf === true}
        aria-label="Public achievements"
        disabled={publicShelf === null}
        onClick={() => void flip()}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          publicShelf ? 'bg-accent/70' : 'bg-bg-3'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            publicShelf ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

/**
 * Achievement-notification toggle. Account-level (synced across devices): when
 * off, the server sends no push or in-app toast when you unlock an achievement.
 */
function AchievementNotificationsToggle() {
  const { rest, user, updateUser } = useAuth();
  const enabled = user?.notifyAchievements ?? true;
  const [busy, setBusy] = useState(false);

  const flip = async () => {
    if (busy) return;
    const next = !enabled;
    setBusy(true);
    try {
      const r = await rest.patchMe({ notifyAchievements: next });
      updateUser(r.user);
    } catch {
      /* leave the switch as-is on failure */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-bg-2 border border-line rounded-lg mt-2">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">Achievement notifications</p>
        <p className="text-xs text-ink-3 leading-relaxed mt-0.5">
          Get a notification when you unlock a new achievement.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Achievement notifications"
        disabled={busy}
        onClick={() => void flip()}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          enabled ? 'bg-accent/70' : 'bg-bg-3'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            enabled ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function ReactionNotificationsToggle() {
  const { rest, user, updateUser } = useAuth();
  const enabled = user?.notifyReactions ?? true;
  const [busy, setBusy] = useState(false);

  const flip = async () => {
    if (busy) return;
    const next = !enabled;
    setBusy(true);
    try {
      const r = await rest.patchMe({ notifyReactions: next });
      updateUser(r.user);
    } catch {
      /* leave the switch as-is on failure */
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5 bg-bg-2 border border-line rounded-lg mt-2">
      <div className="min-w-0">
        <p className="text-sm text-ink-1">Reaction notifications</p>
        <p className="text-xs text-ink-3 leading-relaxed mt-0.5">
          Get a notification when someone reacts to your message.
        </p>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={enabled}
        aria-label="Reaction notifications"
        disabled={busy}
        onClick={() => void flip()}
        className={`relative shrink-0 w-10 h-6 rounded-full transition-colors ${
          enabled ? 'bg-accent/70' : 'bg-bg-3'
        }`}
      >
        <span
          className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
            enabled ? 'left-[1.125rem]' : 'left-0.5'
          }`}
        />
      </button>
    </div>
  );
}

function NotificationSettings() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [enabled, setEnabled] = useState<boolean | null>(null); // null = loading
  const [subscribed, setSubscribed] = useState<boolean | null>(null);
  const [devices, setDevices] = useState<
    Array<{
      id: string;
      label: string | null;
      createdAt: string;
      lastUsedAt: string;
      endpointHash: string;
    }>
  >([]);
  const [pending, setPending] = useState(false);

  const supported =
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window;

  // On mount: check server config + browser subscription state.
  useEffect(() => {
    if (!supported) {
      setEnabled(false);
      setSubscribed(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const { enabled: serverEnabled } = await rest.getPushPublicKey();
        if (cancelled) return;
        setEnabled(serverEnabled);

        // Is the browser already subscribed? Reading existing
        // subscription doesn't trigger the permission prompt — only
        // pushManager.subscribe() does.
        const reg = await navigator.serviceWorker.getRegistration();
        const existing = reg ? await reg.pushManager.getSubscription() : null;
        if (!cancelled) setSubscribed(existing !== null);

        // Server-side device list — for the "your devices" UI.
        const { subscriptions } = await rest.listPushSubscriptions();
        if (!cancelled) setDevices(subscriptions);
      } catch {
        if (!cancelled) {
          setEnabled(false);
          setSubscribed(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rest, supported]);

  async function handleEnable() {
    setPending(true);
    try {
      // Permission. Browser flow: first call shows UI, subsequent
      // calls return the cached answer.
      const perm = await Notification.requestPermission();
      if (perm !== 'granted') {
        toasts.push(
          perm === 'denied'
            ? 'Notification permission was denied. You can re-enable it in your browser settings.'
            : 'Notification permission was dismissed.',
          'error',
        );
        return;
      }

      // VAPID public key fetched fresh — subscribe() needs it as the
      // applicationServerKey, which has to be the server's actual key.
      const { key } = await rest.getPushPublicKey();
      if (!key) {
        toasts.push('Push notifications are not configured on this server', 'error');
        return;
      }

      // Register the SW (idempotent), then subscribe via pushManager.
      const reg = await navigator.serviceWorker.register('/sw.js');
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        // PushSubscriptionOptionsInit wants ArrayBuffer-backed BufferSource;
        // our helper returns a generic Uint8Array. Cast through unknown
        // to side-step the strict TS lib type narrowing on shared buffers.
        applicationServerKey: urlBase64ToUint8Array(key) as unknown as BufferSource,
      });

      // Extract keys + endpoint and POST. The browser auto-base64-URL-
      // encodes the keys via getKey(); we re-encode to standard base64
      // (the format web-push expects).
      const json = sub.toJSON();
      await rest.subscribePush({
        endpoint: json.endpoint!,
        keys: {
          p256dh: json.keys!.p256dh,
          auth: json.keys!.auth,
        },
        label: detectDeviceLabel(),
      });

      setSubscribed(true);
      const { subscriptions } = await rest.listPushSubscriptions();
      setDevices(subscriptions);
      toasts.push('Notifications enabled', 'success');
    } catch (e) {
      toasts.push(
        e instanceof Error ? e.message : 'Failed to enable notifications',
        'error',
      );
    } finally {
      setPending(false);
    }
  }

  async function handleDisable() {
    setPending(true);
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = reg ? await reg.pushManager.getSubscription() : null;
      if (sub) {
        // Find THIS browser's server-side row (by endpoint hash — the list
        // spans all the user's devices) and delete it before the browser
        // unsubscribes. Order matters: if we unsubscribe in the browser
        // first and the DELETE fails, we have a phantom subscription on
        // the server that gets pruned on the next 410.
        const { subscriptions: current } = await rest
          .listPushSubscriptions()
          .catch(() => ({ subscriptions: devices }));
        const matching = await findOwnPushDevice(current, sub.endpoint);
        if (matching) {
          await rest.deletePushSubscription(matching.id).catch(() => undefined);
        }
        await sub.unsubscribe();
      }
      setSubscribed(false);
      const { subscriptions } = await rest.listPushSubscriptions();
      setDevices(subscriptions);
      toasts.push('Notifications disabled on this device', 'info');
    } catch (e) {
      toasts.push(
        e instanceof Error ? e.message : 'Failed to disable notifications',
        'error',
      );
    } finally {
      setPending(false);
    }
  }

  async function removeDevice(id: string) {
    try {
      await rest.deletePushSubscription(id);
      const { subscriptions } = await rest.listPushSubscriptions();
      setDevices(subscriptions);
    } catch (e) {
      toasts.push(
        e instanceof Error ? e.message : 'Failed to remove device',
        'error',
      );
    }
  }

  if (isNative()) {
    return (
      <div className="flex items-center justify-between gap-3 p-3 bg-bg-2 border border-line rounded-md">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">Push notifications</div>
          <div className="text-xs text-ink-3 mt-0.5">
            Delivered through Apple for @mentions, DMs, and calls. Zekktris asks
            for permission when you sign in — you can manage it anytime in the
            iOS Settings app under Zekktris → Notifications.
          </div>
        </div>
        <button
          type="button"
          disabled={pending}
          onClick={async () => {
            setPending(true);
            try {
              const perm = await requestNotificationPermission();
              if (perm === 'granted') {
                setSubscribed(true);
                toasts.push('Notifications enabled', 'success');
              } else {
                toasts.push(
                  perm === 'denied'
                    ? 'Notifications are turned off. Enable them in iOS Settings → Zekktris → Notifications.'
                    : 'Notification permission was dismissed.',
                  'error',
                );
              }
            } finally {
              setPending(false);
            }
          }}
          className="px-3 py-1.5 text-sm rounded-md bg-accent hover:bg-accent/90 text-white disabled:opacity-50 shrink-0"
        >
          {pending ? 'Enabling…' : 'Enable'}
        </button>
      </div>
    );
  }

  if (!supported) {
    return (
      <p className="text-sm text-ink-3">
        Your browser doesn&apos;t support push notifications.
      </p>
    );
  }

  // iOS-Safari special-case. Safari on iOS shipped PushManager in
  // the regular browser tab in 16.4, but subscribe() still only
  // works when the page is running as an installed PWA (Add to
  // Home Screen). The `supported` gate above passes for iOS Safari
  // in a regular tab — so without this hint the user would tap
  // Enable, get the permission prompt, then see a generic "Failed
  // to enable notifications" toast and have no idea why.
  //
  // Detection: window.navigator.standalone is iOS-only and is true
  // only when the page launched from Home Screen. The user agent
  // sniff handles the iOS-browser case (iPadOS reports as Mac so
  // we check maxTouchPoints too).
  const isIOS =
    typeof window !== 'undefined' &&
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const iosStandalone = (window.navigator as { standalone?: boolean }).standalone === true;
  if (isIOS && !iosStandalone && subscribed === false) {
    return (
      <div className="text-sm text-ink-3 space-y-2">
        <p>
          On iPhone and iPad, push notifications only work when Zekktris is
          installed as a Home Screen app.
        </p>
        <p className="text-xs text-ink-3">
          In Safari: tap the Share button → <span className="text-ink-2">Add to Home Screen</span>,
          then open Zekktris from your Home Screen and try again here.
        </p>
      </div>
    );
  }

  if (enabled === null || subscribed === null) {
    return <p className="text-sm text-ink-3">Loading…</p>;
  }
  if (!enabled) {
    return (
      <p className="text-sm text-ink-3">
        Push notifications are not configured on this server. Ask your
        server operator to set <code className="text-ink-2">VAPID_PUBLIC_KEY</code> and{' '}
        <code className="text-ink-2">VAPID_PRIVATE_KEY</code>.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-3 p-3 bg-bg-2 border border-line rounded-md">
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium">
            {subscribed ? 'Notifications enabled on this device' : 'Notifications disabled'}
          </div>
          <div className="text-xs text-ink-3 mt-0.5">
            {subscribed
              ? 'You’ll receive notifications for @mentions and DMs.'
              : 'Enable to get notified when someone mentions you or sends a DM.'}
          </div>
        </div>
        {subscribed ? (
          <button
            type="button"
            onClick={() => void handleDisable()}
            disabled={pending}
            className="px-3 py-1.5 text-sm rounded-md text-ink-2 hover:bg-bg-3 disabled:opacity-50"
          >
            Disable
          </button>
        ) : (
          <button
            type="button"
            onClick={() => void handleEnable()}
            disabled={pending}
            className="px-3 py-1.5 text-sm rounded-md bg-accent hover:bg-accent/90 text-white disabled:opacity-50"
          >
            {pending ? 'Enabling…' : 'Enable'}
          </button>
        )}
      </div>

      {devices.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs uppercase tracking-wider text-ink-3 px-1">
            Your devices ({devices.length})
          </div>
          <ul className="space-y-1">
            {devices.map((d) => (
              <li
                key={d.id}
                className="flex items-center gap-2 px-3 py-2 bg-bg-2 border border-line rounded-md text-sm"
              >
                <div className="flex-1 min-w-0">
                  <div className="truncate" title={d.label ?? '(unknown device)'}>
                    {d.label ?? '(unknown device)'}
                  </div>
                  <div className="text-xs text-ink-3">
                    Added {new Date(d.createdAt).toLocaleDateString()}
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void removeDevice(d.id)}
                  className="px-2 py-1 text-xs rounded text-red-400 hover:bg-red-950/40"
                  title="Remove this device"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * VAPID public keys come from the server as base64url strings; the Push
 * API wants a Uint8Array. Standard utility — Mozilla's docs include this
 * exact function.
 */
function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

/**
 * Build a human-friendly device label from the user agent and platform
 * hints. The raw UA string is dense and unreadable in a "your devices"
 * list; this produces things like "MacBook · Chrome" or "iPhone · Safari".
 *
 * UA parsing is famously messy — we keep it simple and best-effort.
 * Worst case we fall back to the truncated UA which still works.
 */
function detectDeviceLabel(): string {
  const ua = navigator.userAgent;
  // Browser
  let browser = 'Browser';
  if (/Edg\//.test(ua)) browser = 'Edge';
  else if (/OPR\/|Opera/.test(ua)) browser = 'Opera';
  else if (/Firefox\//.test(ua)) browser = 'Firefox';
  else if (/Chrome\//.test(ua)) browser = 'Chrome';
  else if (/Safari\//.test(ua)) browser = 'Safari';

  // Device / OS
  let device = 'Device';
  if (/iPhone/.test(ua)) device = 'iPhone';
  else if (/iPad/.test(ua)) device = 'iPad';
  else if (/Android/.test(ua)) device = 'Android';
  else if (/Mac OS X/.test(ua)) device = 'Mac';
  else if (/Windows/.test(ua)) device = 'Windows';
  else if (/Linux/.test(ua)) device = 'Linux';

  return `${device} \u00b7 ${browser}`;
}

// ── Blocked users settings ──────────────────────────────────────────────────
//
// Lists every user the current account has blocked, with an unblock action
// per row. Shares the relationships REST endpoint with the ProfileCard
// flow (one fetch returns friends + requests + blocks; we filter locally).
//
// Empty state is friendly rather than apologetic — "no one blocked" is
// the desired state, not a failure.

function PrivacySettings() {
  const { rest, user, updateUser } = useAuth();
  const toasts = useToasts();

  // Field is optional in the type for back-compat with sessions
  // issued before the column existed; treat undefined as the default
  // (false = friends-only).
  const allow = user?.allowDmsFromServerMembers === true;
  const [pending, setPending] = useState(false);

  async function toggle(next: boolean) {
    if (pending) return;
    setPending(true);
    // Optimistic update so the toggle feels instant. Revert in catch.
    updateUser({ allowDmsFromServerMembers: next });
    try {
      const res = await rest.patchMe({ allowDmsFromServerMembers: next });
      // Reconcile with server response in case of normalization.
      if (res.user.allowDmsFromServerMembers !== undefined) {
        updateUser({ allowDmsFromServerMembers: res.user.allowDmsFromServerMembers });
      }
    } catch (e) {
      // Revert on failure.
      updateUser({ allowDmsFromServerMembers: allow });
      toasts.push(
        e instanceof ApiError ? e.message : 'Privacy update failed',
        'error',
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <ToggleRow
      title="Allow DMs and calls from server members"
      help={
        'Off (default): only mutual friends can DM or call you. On: people who share a server with you can also reach you. Blocked users are always denied. Already-open DMs keep working regardless.'
      }
      checked={allow}
      onChange={(next) => void toggle(next)}
    />
  );
}

/**
 * MediaRetentionNotice — the user-facing statement of server-side media
 * retention (`ATTACHMENT_RETENTION_DAYS` on the API).
 *
 * Two things this copy must not get wrong, because it's a data-retention
 * promise and not marketing:
 *
 *   1. It is SERVER-SIDE ONLY. Nothing is removed from the sender's or the
 *      recipient's device, and we must never imply otherwise.
 *   2. The number of days is NOT exposed to clients — there's no field on
 *      /instance/monetization or anywhere else carrying it, and the sweep
 *      can also be switched off entirely (it ships off). So the copy says
 *      an administrator sets it rather than hardcoding an N that would
 *      silently drift out of sync with the real configuration. If the API
 *      ever publishes the value, render it here instead of this sentence.
 */
function MediaRetentionNotice() {
  return (
    <div className="rounded-md border border-line bg-bg-1 px-3 py-2 text-xs leading-snug text-ink-3 space-y-2">
      <p>
        To keep storage sustainable, this instance can remove the full-size original of a photo,
        video, or file once it is older than a set number of days. Whether that is switched on —
        and how many days — is decided by this instance&apos;s administrators, and the app is not
        told the setting, so no number is shown here.
      </p>
      <ul className="list-disc space-y-1 pl-4">
        <li>Message text is never touched, and nothing is removed from the conversation.</li>
        <li>
          The small preview thumbnail is kept, so the photo still shows in the chat — it just
          can&apos;t be opened or downloaded at full size any more.
        </li>
        <li>
          This only affects the copy stored on our servers. Anything already saved on your device,
          or on the device of whoever sent it, is untouched.
        </li>
      </ul>
      <p>
        Where an image is marked <span className="text-ink-2">Original expired</span>, this is what
        happened to it.
      </p>
    </div>
  );
}

function BlockedSettings() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [blocked, setBlocked] = useState<
    Array<{ id: string; displayName: string; username: string; avatarUrl: string | null }>
  > ([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rest
      .listRelationships()
      .then((r) => {
        if (cancelled) return;
        const filtered = r.relationships
          .filter((x) => x.type === 'blocked')
          .map((x) => ({
            id: x.user.id,
            displayName: x.user.displayName,
            username: x.user.username,
            avatarUrl: x.user.avatarUrl,
          }));
        setBlocked(filtered);
      })
      .catch((e) => {
        if (cancelled) return;
        toasts.push(
          e instanceof ApiError ? e.message : 'Failed to load blocked users',
          'error',
        );
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function unblock(id: string) {
    setBusy(id);
    try {
      await rest.unblockUser(id);
      setBlocked((prev) => prev.filter((u) => u.id !== id));
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Unblock failed', 'error');
    } finally {
      setBusy(null);
    }
  }

  if (loading) {
    return (
      <p className="text-xs text-ink-3 italic">Loading…</p>
    );
  }

  if (blocked.length === 0) {
    return (
      <p className="text-xs text-ink-3 italic">
        You haven’t blocked anyone. Open someone’s profile to block them.
      </p>
    );
  }

  return (
    <ul className="border border-line rounded-md divide-y divide-line bg-bg-1">
      {blocked.map((u) => (
        <li key={u.id} className="flex items-center gap-3 px-3 py-2">
          <div className="relative w-8 h-8 rounded-full text-xs flex items-center justify-center font-semibold shrink-0 bg-bg-3 overflow-hidden">
            <span aria-hidden="true">{u.displayName.slice(0, 2).toUpperCase()}</span>
            <AvatarImage src={u.avatarUrl} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-sm text-ink-1 truncate">{u.displayName}</div>
            <div className="text-xs text-ink-3 truncate">@{u.username}</div>
          </div>
          <button
            type="button"
            disabled={busy === u.id}
            onClick={() => void unblock(u.id)}
            className="text-xs px-2 py-1 rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3 disabled:opacity-60"
          >
            {busy === u.id ? 'Unblocking…' : 'Unblock'}
          </button>
        </li>
      ))}
    </ul>
  );
}

/**
 * Password change section. Collapsed by default — clicking "Change
 * password" expands the form. Validates client-side (min length 8,
 * match between new+confirm) before firing the REST call; surfaces
 * server errors via toast. On success, resets the form and collapses
 * back, plus shows a toast about how many sessions were revoked if
 * the user kept the "sign out other sessions" toggle on.
 */
function PasskeysSection() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const stepUp = useStepUpPassword();
  const [passkeys, setPasskeys] = useState<PasskeyInfo[] | null>(null);
  const [adding, setAdding] = useState(false);
  const supported =
    typeof window !== 'undefined' && typeof window.PublicKeyCredential !== 'undefined';

  async function refresh() {
    try {
      const r = await rest.listPasskeys();
      setPasskeys(r.passkeys);
    } catch {
      setPasskeys([]);
    }
  }
  useEffect(() => {
    if (supported) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function addPasskey() {
    // Step-up: a passkey is a login factor that survives password reset, so the
    // server requires the account password. Collect it before the OS ceremony.
    const currentPassword = await stepUp.request({
      message: 'Enter your account password to add a passkey to your account.',
    });
    if (!currentPassword) return;
    setAdding(true);
    try {
      const { startRegistration } = await import('@simplewebauthn/browser');
      const { challengeId, options } = await rest.passkeyRegisterOptions();
      const response = await startRegistration({ optionsJSON: options as never });
      await rest.passkeyRegisterVerify({ challengeId, response, currentPassword });
      toasts.push('Passkey added', 'success');
      await refresh();
    } catch (e) {
      // Dismissing the OS prompt throws — not worth a toast.
      const name = e instanceof Error ? e.name : '';
      if (name !== 'NotAllowedError' && name !== 'AbortError') {
        toasts.push(e instanceof ApiError ? e.message : 'Could not add passkey', 'error');
      }
    } finally {
      setAdding(false);
    }
  }

  async function removePasskey(id: string) {
    const currentPassword = await stepUp.request({
      message: 'Enter your account password to remove this passkey.',
    });
    if (!currentPassword) return;
    try {
      await rest.deletePasskey(id, currentPassword);
      setPasskeys((p) => (p ?? []).filter((k) => k.id !== id));
      toasts.push('Passkey removed', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not remove passkey', 'error');
    }
  }

  if (!supported) return null;

  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3">Passkeys</div>
      <p className="text-sm text-ink-3 leading-relaxed">
        Sign in without a password using your device&apos;s biometrics or a security key.
      </p>
      {passkeys && passkeys.length > 0 && (
        <ul className="space-y-1.5">
          {passkeys.map((k) => (
            <li
              key={k.id}
              className="flex items-center gap-2 rounded-md border border-line bg-bg-1/60 px-3 py-2"
            >
              <Key size={16} className="text-accent shrink-0" />
              <span className="flex-1 min-w-0 text-sm truncate">
                {k.deviceName || 'Passkey'}
                {k.backedUp && <span className="text-ink-3"> · synced</span>}
              </span>
              <button
                type="button"
                onClick={() => void removePasskey(k.id)}
                className="text-xs text-red-400 hover:underline shrink-0"
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        onClick={addPasskey}
        disabled={adding}
        className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-md border border-accent/40 bg-accent/15 text-ink-1 hover:bg-accent/25 disabled:opacity-50"
      >
        <Key size={15} />
        {adding ? 'Waiting for passkey…' : 'Add a passkey'}
      </button>
      {stepUp.element}
    </section>
  );
}

// ── Active sessions ─────────────────────────────────────────────────────────

/** Compact relative-time formatter for session "last active" stamps. */
function sessionRelativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 60_000) return 'just now';
  const min = Math.floor(diffMs / 60_000);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Active sessions: every device currently logged in, with a per-row revoke
 * and a bulk "sign out everywhere else". Mirrors iOS's SessionsSheet
 * (MainView.swift).
 *
 * Two security invariants, both inherited from iOS:
 *   - `current` comes from the server (SessionDTO stamps exactly one row);
 *     we never try to infer which session is ours from the local token.
 *   - The current session gets NO revoke control at all — signing yourself
 *     out from a device-management list is a footgun. Logout is the path.
 *
 * The IP + User-Agent shown here are personal data. They're rendered for the
 * user's own review and go nowhere else — no logging, no query strings.
 */
function SessionsSection() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [sessions, setSessions] = useState<SessionInfo[] | null>(null);
  const [revoking, setRevoking] = useState<Set<string>>(new Set());
  const [bulkBusy, setBulkBusy] = useState(false);

  async function refresh() {
    try {
      const r = await rest.listSessions();
      setSessions(r.sessions);
    } catch {
      setSessions([]);
    }
  }
  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function revoke(id: string) {
    setRevoking((s) => new Set(s).add(id));
    try {
      await rest.revokeSession(id);
      setSessions((list) => (list ?? []).filter((s) => s.id !== id));
      toasts.push('Session signed out', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not sign out that session', 'error');
    } finally {
      setRevoking((s) => {
        const next = new Set(s);
        next.delete(id);
        return next;
      });
    }
  }

  async function revokeOthers() {
    if (
      !window.confirm(
        'Sign out every other device? This device stays signed in; everywhere else will need to log in again.',
      )
    )
      return;
    setBulkBusy(true);
    try {
      await rest.revokeOtherSessions();
      // Keep only the server-flagged current session rather than re-fetching.
      setSessions((list) => (list ?? []).filter((s) => s.current));
      toasts.push('Signed out everywhere else', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not sign out other sessions', 'error');
    } finally {
      setBulkBusy(false);
    }
  }

  // Current session first, then most-recently-active. ISO-8601 stamps sort
  // chronologically as plain strings, so a > b ⇒ a is more recent.
  const sorted = [...(sessions ?? [])].sort((a, b) => {
    if (a.current !== b.current) return a.current ? -1 : 1;
    return a.lastUsedAt < b.lastUsedAt ? 1 : a.lastUsedAt > b.lastUsedAt ? -1 : 0;
  });
  const hasOthers = sorted.some((s) => !s.current);

  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3">Active Sessions</div>
      <p className="text-sm text-ink-3 leading-relaxed">
        Devices currently signed in to your account. If you don&apos;t recognize one, sign it out —
        and change your password.
      </p>
      {sessions === null ? (
        <div className="text-sm text-ink-3">Loading…</div>
      ) : sorted.length === 0 ? (
        <div className="text-sm text-ink-3">No active sessions.</div>
      ) : (
        <ul className="space-y-1.5">
          {sorted.map((s) => (
            <li
              key={s.id}
              className="flex items-start gap-2 rounded-md border border-line bg-bg-1/60 px-3 py-2"
            >
              <DeviceIcon ua={s.userAgent} className="text-accent shrink-0 mt-0.5" />
              <div className="flex-1 min-w-0 space-y-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm text-ink-1 truncate">{deviceLabel(s.userAgent)}</span>
                  {s.current && (
                    <span className="shrink-0 rounded-full bg-accent/15 px-1.5 py-0.5 text-[9px] font-bold tracking-wider text-accent">
                      THIS DEVICE
                    </span>
                  )}
                </div>
                {s.ipAddress && <div className="font-mono text-[11px] text-ink-3">{s.ipAddress}</div>}
                <div className="text-[11px] text-ink-3">
                  Last active {sessionRelativeTime(s.lastUsedAt)}
                </div>
              </div>
              {/* No revoke control for the current session — deliberate. */}
              {!s.current && (
                <button
                  type="button"
                  onClick={() => void revoke(s.id)}
                  disabled={revoking.has(s.id)}
                  className="shrink-0 text-xs text-red-400 hover:underline disabled:opacity-50 disabled:no-underline"
                >
                  {revoking.has(s.id) ? 'Signing out…' : 'Sign out'}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {hasOthers && (
        <button
          type="button"
          onClick={() => void revokeOthers()}
          disabled={bulkBusy}
          className="inline-flex items-center gap-2 text-sm px-3 py-2 rounded-md border border-red-400/40 bg-red-400/10 text-ink-1 hover:bg-red-400/20 disabled:opacity-50"
        >
          <LogOut size={15} />
          {bulkBusy ? 'Signing out…' : 'Sign out everywhere else'}
        </button>
      )}
    </section>
  );
}

/**
 * Staff-only display-name shimmer. Instance moderators/admins can give their
 * display name an animated shimmer in a chosen color that overrides any server
 * role color everywhere their name renders. Setting a color turns it on; the
 * toggle clears it (staffColor = null) to turn it off. Hidden entirely for
 * non-staff so it never appears for regular members.
 */
function StaffShimmerSection() {
  const { rest, user, updateUser } = useAuth();
  const toasts = useToasts();
  const isStaff = user?.isAdmin === true || user?.isModerator === true;
  const enabled = !!user?.staffColor;
  const glow = !!user?.staffGlow;
  const [color, setColor] = useState(user?.staffColor || '#f5c542');
  const [saving, setSaving] = useState(false);

  if (!isStaff) return null;

  async function patch(body: { staffColor?: string | null; staffGlow?: boolean }) {
    setSaving(true);
    try {
      const r = await rest.patchMe(body);
      updateUser(r.user);
      if (body.staffColor) setColor(body.staffColor);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not save shimmer', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="rounded-xl border border-line bg-bg-2 p-3 space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3">Staff name shimmer</div>
      <p className="text-sm text-ink-3 leading-relaxed">
        Give your display name an animated shimmer in a color you choose — it
        overrides your server role colors wherever your name appears. Add a slight
        glow if you like. Instance staff only; turn it off any time.
      </p>
      {/* iOS: a "Shimmer my name" Toggle, then (while on) color + preview and
          an "Add a slight glow" Toggle — switches, not pill buttons. */}
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm text-ink-1">Shimmer my name</p>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label="Shimmer my name"
          disabled={saving}
          onClick={() => void patch({ staffColor: enabled ? null : color })}
          className={`relative shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-50 ${
            enabled ? 'bg-accent/70' : 'bg-bg-3'
          }`}
        >
          <span
            className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
              enabled ? 'left-[1.125rem]' : 'left-0.5'
            }`}
          />
        </button>
      </div>
      {enabled && (
        <>
          <div className="flex items-center gap-3 flex-wrap">
            <input
              type="color"
              value={color}
              onChange={(e) => setColor(e.target.value)}
              onBlur={() => {
                if (color !== user?.staffColor) void patch({ staffColor: color });
              }}
              className="w-9 h-9 rounded-md bg-transparent cursor-pointer border border-line"
              aria-label="Shimmer color"
            />
            <span
              className={`zk-staff-shimmer${glow ? ' zk-staff-glow' : ''} text-base font-semibold`}
              style={{ ['--sc']: color } as CSSProperties}
            >
              {user?.displayName || 'Preview'}
            </span>
          </div>
          {/* Optional slight glow — only meaningful while the shimmer is on. */}
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-1">Add a slight glow</p>
            <button
              type="button"
              role="switch"
              aria-checked={glow}
              aria-label="Add a slight glow"
              disabled={saving}
              onClick={() => void patch({ staffGlow: !glow })}
              className={`relative shrink-0 w-10 h-6 rounded-full transition-colors disabled:opacity-50 ${
                glow ? 'bg-accent/70' : 'bg-bg-3'
              }`}
            >
              <span
                className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                  glow ? 'left-[1.125rem]' : 'left-0.5'
                }`}
              />
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function TwoFactorSection() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [status, setStatus] = useState<{ enabled: boolean; recoveryRemaining: number } | null>(null);
  const [setup, setSetup] = useState<{
    secret: string;
    otpauthUri: string;
    code: string;
    // Step-up: arming 2FA is a login-factor change, so the server re-verifies
    // the account password alongside the authenticator code.
    password: string;
    submitting: boolean;
  } | null>(null);
  const [recoveryCodes, setRecoveryCodes] = useState<string[] | null>(null);
  const [disabling, setDisabling] = useState<{ code: string; submitting: boolean } | null>(null);

  async function refresh() {
    try {
      const r = await rest.getTwoFactorStatus();
      setStatus({ enabled: r.enabled, recoveryRemaining: r.recoveryRemaining });
    } catch {
      setStatus({ enabled: false, recoveryRemaining: 0 });
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function beginSetup() {
    try {
      const r = await rest.beginTwoFactor();
      setSetup({ ...r, code: '', password: '', submitting: false });
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to start enrollment', 'error');
    }
  }

  async function confirmSetup() {
    if (!setup || setup.submitting) return;
    setSetup({ ...setup, submitting: true });
    try {
      const r = await rest.confirmTwoFactor(setup.code.trim(), setup.password);
      setRecoveryCodes(r.recoveryCodes);
      setSetup(null);
      toasts.push('Two-factor authentication enabled', 'success');
      refresh();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Invalid code', 'error');
      setSetup({ ...setup, submitting: false });
    }
  }

  async function confirmDisable() {
    if (!disabling || disabling.submitting) return;
    setDisabling({ ...disabling, submitting: true });
    try {
      await rest.disableTwoFactor(disabling.code.trim());
      toasts.push('Two-factor authentication disabled', 'success');
      setDisabling(null);
      refresh();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Invalid code', 'error');
      setDisabling({ ...disabling, submitting: false });
    }
  }

  if (!status) return null;

  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3">Two-factor authentication</div>

      {/* Status + primary action row */}
      <div className="flex items-start justify-between gap-3 p-3 rounded-md bg-bg-2 border border-line">
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-ink-1">
            {status.enabled ? 'Enabled' : 'Not enabled'}
          </div>
          <p className="text-xs text-ink-3 mt-0.5 leading-snug">
            {status.enabled
              ? `Account protected by an authenticator app. ${status.recoveryRemaining} recovery ${status.recoveryRemaining === 1 ? 'code' : 'codes'} remaining.`
              : 'Add a second factor using an authenticator app like 1Password, Authy, or Google Authenticator.'}
          </p>
        </div>
        {!status.enabled && !setup && (
          <button
            onClick={beginSetup}
            className="shrink-0 px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium"
          >
            Set up
          </button>
        )}
        {status.enabled && !disabling && (
          <button
            onClick={() => setDisabling({ code: '', submitting: false })}
            className="shrink-0 px-3 py-1.5 rounded-md border border-red-500/30 text-red-400 hover:bg-red-500/10 text-sm"
          >
            Disable
          </button>
        )}
      </div>

      {/* Enrollment flow */}
      {setup && (
        <div className="p-3 rounded-md bg-bg-2 border border-line space-y-3">
          <div>
            <div className="text-sm font-medium text-ink-1 mb-2">Scan with your authenticator</div>
            {/* QR-rendered otpauth URI. The SVG is generated client-
                side from our hand-rolled qr.ts encoder — no runtime
                dep, no remote API. Centered on a white background
                so it works in dark mode without inverting. */}
            <div className="flex justify-center my-2">
              <div
                className="bg-white p-2 rounded"
                dangerouslySetInnerHTML={{ __html: qrToSvg(qrEncode(setup.otpauthUri), 200) }}
              />
            </div>
            <p className="text-xs text-ink-3 leading-snug mt-3">
              Can't scan? Paste this secret manually into your authenticator:
            </p>
            <code className="block mt-1.5 px-2 py-1.5 rounded bg-bg-1 border border-line font-mono text-xs text-ink-2 break-all">
              {setup.secret}
            </code>
          </div>
          <label className="block">
            <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Enter the 6-digit code from your app
            </span>
            <input
              value={setup.code}
              onChange={(e) => setSetup({ ...setup, code: e.target.value })}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              className="w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1 font-mono tracking-widest text-center"
            />
          </label>
          <label className="block">
            <span className="block text-xs uppercase tracking-wider text-ink-3 font-semibold mb-1">
              Confirm your account password
            </span>
            <input
              type="password"
              value={setup.password}
              onChange={(e) => setSetup({ ...setup, password: e.target.value })}
              placeholder="Account password"
              autoComplete="current-password"
              className="w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1"
            />
          </label>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setSetup(null)}
              className="px-3 py-1.5 rounded-md text-sm text-ink-2 hover:bg-bg-3"
            >
              Cancel
            </button>
            <button
              onClick={confirmSetup}
              disabled={setup.submitting || setup.code.length !== 6 || !setup.password}
              className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium disabled:opacity-50"
            >
              {setup.submitting ? 'Verifying…' : 'Verify & enable'}
            </button>
          </div>
        </div>
      )}

      {/* Recovery codes — shown ONCE after confirm */}
      {recoveryCodes && (
        <div className="p-3 rounded-md bg-amber-500/5 border border-amber-500/30 space-y-2">
          <div className="flex items-start gap-2">
            <AlertTriangle size={14} className="text-amber-400 shrink-0 mt-0.5" />
            <div className="flex-1 text-xs text-ink-2 leading-snug">
              <strong className="text-amber-300">Save these recovery codes now.</strong> Each works
              once if you lose access to your authenticator. They won't be shown again.
            </div>
          </div>
          <ul className="grid grid-cols-2 gap-1.5 font-mono text-xs">
            {recoveryCodes.map((c) => (
              <li key={c} className="px-2 py-1 bg-bg-1 border border-line rounded text-ink-1 text-center">
                {c}
              </li>
            ))}
          </ul>
          <div className="flex justify-end gap-2">
            <button
              onClick={() => {
                copyText(recoveryCodes.join('\n')).catch(() => {});
                toasts.push('Codes copied to clipboard', 'success');
              }}
              className="px-3 py-1 rounded-md text-xs text-ink-2 hover:bg-bg-3"
            >
              Copy all
            </button>
            <button
              onClick={() => setRecoveryCodes(null)}
              className="px-3 py-1 rounded-md text-xs bg-accent hover:bg-accent/90 text-white"
            >
              I've saved them
            </button>
          </div>
        </div>
      )}

      {/* Disable flow */}
      {disabling && (
        <div className="p-3 rounded-md bg-bg-2 border border-red-500/30 space-y-2">
          <p className="text-xs text-ink-2">
            Enter a current 6-digit code or one of your recovery codes to disable two-factor authentication.
          </p>
          <input
            value={disabling.code}
            onChange={(e) => setDisabling({ ...disabling, code: e.target.value })}
            placeholder="123456 or recovery code"
            autoComplete="one-time-code"
            className="w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1 font-mono"
          />
          <div className="flex justify-end gap-2">
            <button
              onClick={() => setDisabling(null)}
              className="px-3 py-1.5 rounded-md text-sm text-ink-2 hover:bg-bg-3"
            >
              Cancel
            </button>
            <button
              onClick={confirmDisable}
              disabled={disabling.submitting || !disabling.code.trim()}
              className="px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-50"
            >
              {disabling.submitting ? 'Disabling…' : 'Disable 2FA'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function PasswordSection() {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [revokeOthers, setRevokeOthers] = useState(true);
  const [pending, setPending] = useState(false);

  function reset() {
    setCurrent('');
    setNext('');
    setConfirm('');
    setRevokeOthers(true);
    setOpen(false);
  }

  async function submit() {
    if (pending) return;
    if (current.length === 0) {
      toasts.push('Enter your current password', 'error');
      return;
    }
    if (next.length < 8) {
      toasts.push('New password must be at least 8 characters', 'error');
      return;
    }
    if (next !== confirm) {
      toasts.push('New password and confirmation don’t match', 'error');
      return;
    }
    if (next === current) {
      toasts.push('New password must be different from current', 'error');
      return;
    }
    setPending(true);
    try {
      const r = await rest.changePassword({
        currentPassword: current,
        newPassword: next,
        revokeOtherSessions: revokeOthers,
      });
      reset();
      const revoked = r.revokedSessions ?? 0;
      toasts.push(
        revoked > 0
          ? `Password updated. Signed out ${revoked} other session${revoked === 1 ? '' : 's'}.`
          : 'Password updated.',
        'success',
      );
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not change password', 'error');
    } finally {
      setPending(false);
    }
  }

  if (!open) {
    return (
      <section>
        <div className="text-xs uppercase tracking-wider text-ink-3 mb-2">Password</div>
        <button
          type="button"
          onClick={() => setOpen(true)}
          className="px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
        >
          Change password
        </button>
      </section>
    );
  }

  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3">Change password</div>
      <div className="space-y-2 bg-bg-1 rounded-md border border-line p-3">
        <label className="block">
          <span className="text-xs text-ink-2">Current password</span>
          <input
            type="password"
            value={current}
            onChange={(e) => setCurrent(e.target.value)}
            autoComplete="current-password"
            className="mt-1 w-full bg-bg-2 border border-line rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent transition-colors"
          />
        </label>
        <label className="block">
          <span className="text-xs text-ink-2">New password</span>
          <input
            type="password"
            value={next}
            onChange={(e) => setNext(e.target.value)}
            autoComplete="new-password"
            minLength={8}
            maxLength={200}
            className="mt-1 w-full bg-bg-2 border border-line rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent transition-colors"
          />
          {/* Real-time length feedback. Shown when the field has
              content but is still too short — silent on empty
              (initial state). Switches to a green confirmation
              when the threshold is met so users see positive
              progress, not just a list of red errors. */}
          <span
            className={`text-xs mt-0.5 block ${
              next.length === 0
                ? 'text-ink-3'
                : next.length < 8
                  ? 'text-amber-300/80'
                  : 'text-emerald-300/80'
            }`}
          >
            {next.length === 0
              ? 'At least 8 characters; up to 200.'
              : next.length < 8
                ? `${next.length}/8 characters minimum`
                : `Looks good (${next.length} characters)`}
          </span>
        </label>
        <label className="block">
          <span className="text-xs text-ink-2">Confirm new password</span>
          <input
            type="password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            autoComplete="new-password"
            className="mt-1 w-full bg-bg-2 border border-line rounded-md px-3 py-1.5 text-sm outline-none focus:border-accent transition-colors"
          />
          {/* Live match indicator. Silent until the user has
              actually typed something into both fields, then
              shows red on mismatch / green on match. Avoids
              flashing "doesn't match" the moment they start
              typing the confirmation. */}
          {next.length > 0 && confirm.length > 0 && (
            <span
              className={`text-xs mt-0.5 block ${
                next === confirm ? 'text-emerald-300/80' : 'text-amber-300/80'
              }`}
            >
              {next === confirm ? 'Passwords match' : "Passwords don't match yet"}
            </span>
          )}
        </label>
        <label className="flex items-start gap-2 mt-2 text-xs text-ink-2 cursor-pointer">
          <input
            type="checkbox"
            checked={revokeOthers}
            onChange={(e) => setRevokeOthers(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            Sign out my other sessions.
            <span className="text-ink-3 block">
              Recommended — closes any sessions on devices you don't have right now.
            </span>
          </span>
        </label>
        <div className="flex gap-2 pt-1">
          <button
            type="button"
            disabled={pending}
            onClick={() => void submit()}
            className="flex-1 px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium transition-colors disabled:opacity-60"
          >
            {pending ? 'Updating…' : 'Update password'}
          </button>
          <button
            type="button"
            disabled={pending}
            onClick={reset}
            className="px-3 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-ink-2 text-sm transition-colors disabled:opacity-60"
          >
            Cancel
          </button>
        </div>
      </div>
    </section>
  );
}

/**
 * Video quality settings — separate from VoiceDeviceSettings because
 * device pickers and quality presets answer different questions:
 * "WHICH camera/mic do I use" vs "HOW do I publish video tracks".
 *
 * Presets persist via localStorage; the next call to setCameraEnabled
 * or setScreenShareEnabled reads them and applies the resolution +
 * frame-rate constraints to the published track. Changing quality
 * during an active call doesn't re-publish on the fly — the user must
 * toggle the camera/screen off and back on for the new preset to
 * apply. We surface this trade-off below the controls so it's not
 * a surprise.
 */
function VideoQualitySettings() {
  const { user } = useAuth();
  const toasts = useToasts();
  // getSavedScreenQuality runs its legacy-value migration on this first
  // read — keep it BEFORE the fps60 read below, since migrating the old
  // 'high_motion' tier flips the smooth-motion toggle on.
  const [cameraQ, setCameraQ] = useState<CameraQuality>(getSavedCameraQuality());
  const [screenQ, setScreenQ] = useState<ScreenQuality>(getSavedScreenQuality());
  const [screenFps60, setScreenFps60] = useState<boolean>(getSavedScreenFps60());

  function pickCamera(q: CameraQuality) {
    setCameraQ(q);
    setSavedCameraQuality(q);
  }
  function pickScreen(q: ScreenQuality) {
    setScreenQ(q);
    setSavedScreenQuality(q);
  }
  function toggleFps60(on: boolean) {
    setScreenFps60(on);
    setSavedScreenFps60(on);
  }

  // Perk-tier streaming gate: which qualities need which tier is
  // ADMIN-CONFIGURABLE per instance (defaults: everyone 720p30; Scout 1080p
  // and 60fps; Guardian 2K; Legend 4K). Computed from the LIVE user tier so
  // an admin giving a tier unlocks the pills without a reload; the
  // publish-time clamps in voice.ts are the enforcement, this is the honest
  // UI for it.
  // Subscribe to the config store so the pills re-render when the instance
  // config fetch lands after mount (module state is invisible to React).
  useSyncExternalStore(subscribeMonetization, getMonetizationVersion, getMonetizationVersion);
  const userRank = monetizeTierRank(user?.subscriptionTier);
  const cameraLock = (q: CameraQuality) => {
    const req = requiredTierForCameraQuality(q);
    return req && !isCameraQualityAllowed(q, userRank) ? { lockedBehind: req } : {};
  };
  const screenLock = (q: ScreenQuality) => {
    const req = requiredTierForScreenQuality(q);
    return req && !isScreenQualityAllowed(q, userRank) ? { lockedBehind: req } : {};
  };

  const cameraOptions: Array<{
    value: CameraQuality;
    label: string;
    description: string;
    /** Perk tier this option needs, when the user doesn't have it. */
    lockedBehind?: 'scout' | 'guardian' | 'legend';
  }> = [
    {
      value: 'auto',
      label: 'Auto',
      description: 'Starts at 720p and adapts to your connection. Recommended for most users.',
    },
    {
      value: 'low',
      label: CAMERA_QUALITY_PRESETS.low!.label,
      description: CAMERA_QUALITY_PRESETS.low!.description,
    },
    {
      value: 'p720',
      label: CAMERA_QUALITY_PRESETS.p720!.label,
      description: CAMERA_QUALITY_PRESETS.p720!.description,
    },
    {
      value: 'p1080',
      label: CAMERA_QUALITY_PRESETS.p1080!.label,
      description: CAMERA_QUALITY_PRESETS.p1080!.description,
      ...cameraLock('p1080'),
    },
    {
      value: 'k2',
      label: CAMERA_QUALITY_PRESETS.k2!.label,
      description: CAMERA_QUALITY_PRESETS.k2!.description,
      ...cameraLock('k2'),
    },
    {
      value: 'k4',
      label: CAMERA_QUALITY_PRESETS.k4!.label,
      description: CAMERA_QUALITY_PRESETS.k4!.description,
      ...cameraLock('k4'),
    },
  ];

  // Camera counterpart of the locked-saved-setting note below.
  const savedCameraLocked = cameraOptions.find((o) => o.value === cameraQ)?.lockedBehind;

  // What a locked saved setting ACTUALLY falls back to: the highest quality
  // the tier covers on that surface (a Guardian with saved 4K publishes at
  // 2K, not 1080p) — must match the clamps in voice.ts, which substitute the
  // best allowed tier, not the free floor. Per-surface because the admin can
  // gate the camera and screen matrices differently.
  const cameraClampLabel =
    CAMERA_QUALITY_PRESETS[highestAllowedCameraQuality(userRank)]?.label ??
    CAMERA_QUALITY_PRESETS.p720!.label;
  const screenClampLabel = SCREEN_QUALITY_PRESETS[highestAllowedScreenQuality(userRank)].label;

  const screenOptions: Array<{
    value: ScreenQuality;
    label: string;
    description: string;
    /** Perk tier this option needs, when the user doesn't have it. */
    lockedBehind?: 'scout' | 'guardian' | 'legend';
  }> = [
    {
      value: 'p720',
      label: SCREEN_QUALITY_PRESETS.p720.label,
      description: SCREEN_QUALITY_PRESETS.p720.description,
    },
    {
      value: 'p1080',
      label: SCREEN_QUALITY_PRESETS.p1080.label,
      description: SCREEN_QUALITY_PRESETS.p1080.description,
      ...screenLock('p1080'),
    },
    {
      value: 'k2',
      label: SCREEN_QUALITY_PRESETS.k2.label,
      description: SCREEN_QUALITY_PRESETS.k2.description,
      ...screenLock('k2'),
    },
    {
      value: 'k4',
      label: SCREEN_QUALITY_PRESETS.k4.label,
      description: SCREEN_QUALITY_PRESETS.k4.description,
      ...screenLock('k4'),
    },
  ];

  // A saved quality the tier no longer covers (tier ended / different
  // account): streams clamp until the tier is back. Tell the user instead of
  // silently downgrading.
  const savedScreenLocked = screenOptions.find((o) => o.value === screenQ)?.lockedBehind;

  const fps60Required = requiredTierForScreenFps60();
  const fps60LockMeta =
    fps60Required && !isScreenFps60Allowed(userRank) ? TIER_META[fps60Required] : null;

  return (
    <div className="space-y-3 pt-1">
      <div>
        <div className="text-xs text-ink-2 mb-1.5">Camera quality</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {cameraOptions.map((opt) => {
            const lockMeta = opt.lockedBehind ? TIER_META[opt.lockedBehind] : null;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  if (opt.lockedBehind && lockMeta) {
                    toasts.push(
                      `${opt.label} camera is a ${lockMeta.label} perk — this server's admins give out tiers.`,
                      'error',
                    );
                    return;
                  }
                  pickCamera(opt.value);
                }}
                className={`text-left px-3 py-2 rounded-md border transition-colors ${
                  cameraQ === opt.value && !opt.lockedBehind
                    ? 'border-accent bg-accent/10 text-ink-1'
                    : 'border-line bg-bg-1 hover:border-ink-3/40 text-ink-2'
                } ${opt.lockedBehind ? 'opacity-75' : ''}`}
              >
                <div className="text-sm font-medium flex items-center gap-1.5">
                  {opt.label}
                  {lockMeta && (
                    <span
                      className="inline-flex items-center gap-0.5 px-1.5 rounded text-[0.55rem] font-bold uppercase tracking-wider leading-[1.05rem]"
                      style={{
                        color: lockMeta.color,
                        backgroundColor: `color-mix(in srgb, ${lockMeta.color} 18%, transparent)`,
                      }}
                    >
                      🔒 {lockMeta.label}
                    </span>
                  )}
                </div>
                <div className="text-xs text-ink-3 mt-0.5">{opt.description}</div>
              </button>
            );
          })}
        </div>
        {savedCameraLocked && (
          <p className="text-[0.7rem] text-amber-400/90 leading-relaxed mt-1.5">
            Your saved {CAMERA_QUALITY_PRESETS[cameraQ]?.label ?? cameraQ} camera setting needs a{' '}
            {TIER_META[savedCameraLocked]?.label} tier — the camera currently publishes at up
            to {cameraClampLabel}. It comes back on its own if you get that tier again.
          </p>
        )}
      </div>

      <div>
        <div className="text-xs text-ink-2 mb-1.5">Screen share quality</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          {screenOptions.map((opt) => {
            const lockMeta = opt.lockedBehind ? TIER_META[opt.lockedBehind] : null;
            return (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  if (opt.lockedBehind && lockMeta) {
                    toasts.push(
                      `${opt.label} streaming is a ${lockMeta.label} perk — this server's admins give out tiers.`,
                      'error',
                    );
                    return;
                  }
                  pickScreen(opt.value);
                }}
                className={`text-left px-3 py-2 rounded-md border transition-colors ${
                  screenQ === opt.value && !opt.lockedBehind
                    ? 'border-accent bg-accent/10 text-ink-1'
                    : 'border-line bg-bg-1 hover:border-ink-3/40 text-ink-2'
                } ${opt.lockedBehind ? 'opacity-75' : ''}`}
              >
                <div className="text-sm font-medium flex items-center gap-1.5">
                  {opt.label}
                  {lockMeta && (
                    <span
                      className="inline-flex items-center gap-0.5 px-1.5 rounded text-[0.55rem] font-bold uppercase tracking-wider leading-[1.05rem]"
                      style={{
                        color: lockMeta.color,
                        backgroundColor: `color-mix(in srgb, ${lockMeta.color} 18%, transparent)`,
                      }}
                    >
                      🔒 {lockMeta.label}
                    </span>
                  )}
                </div>
                <div className="text-xs text-ink-3 mt-0.5">{opt.description}</div>
              </button>
            );
          })}
        </div>
        {savedScreenLocked && (
          <p className="text-[0.7rem] text-amber-400/90 leading-relaxed mt-1.5">
            Your saved {SCREEN_QUALITY_PRESETS[screenQ].label} setting needs a{' '}
            {TIER_META[savedScreenLocked]?.label} tier — shares currently run at up to{' '}
            {screenClampLabel}. It comes back on its own if you get that tier again.
          </p>
        )}
        <label
          className={`flex items-start gap-2 mt-2 text-xs text-ink-2 ${fps60LockMeta ? 'opacity-75' : 'cursor-pointer'}`}
        >
          <input
            type="checkbox"
            checked={screenFps60 && !fps60LockMeta}
            disabled={!!fps60LockMeta}
            onChange={(e) => toggleFps60(e.target.checked)}
            className="mt-0.5 accent-accent"
          />
          <span>
            <span className="flex items-center gap-1.5">
              Smooth motion (60 fps)
              {fps60LockMeta && (
                <span
                  className="inline-flex items-center gap-0.5 px-1.5 rounded text-[0.55rem] font-bold uppercase tracking-wider leading-[1.05rem]"
                  style={{
                    color: fps60LockMeta.color,
                    backgroundColor: `color-mix(in srgb, ${fps60LockMeta.color} 18%, transparent)`,
                  }}
                >
                  🔒 {fps60LockMeta.label}
                </span>
              )}
            </span>
            <span className="text-ink-3 block">
              {fps60LockMeta
                ? `60 fps is a ${fps60LockMeta.label} perk — shares run at 30 fps.`
                : '2× the bandwidth. 4K at 60 fps needs a fast computer and uplink.'}
            </span>
          </span>
        </label>
      </div>

      <p className="text-[0.7rem] text-ink-3 leading-relaxed">
        Quality changes apply the next time you start the camera or screen share.
        If a track is already running, toggle it off and back on for the new
        setting to take effect.
      </p>
    </div>
  );
}

// ── InstallSection — PWA install affordance ────────────────────────────────
// Three render modes:
//   - already installed: render nothing (we don't pester users)
//   - browser fired beforeinstallprompt (Chrome/Edge): show "Install" button
//   - iOS not yet installed: show manual instructions ("Tap Share, then
//     Add to Home Screen") since iOS doesn't expose a programmatic prompt
function InstallSection() {
  const { mode, promptInstall } = usePwaInstall();

  if (mode === 'installed' || mode === 'unavailable') return null;

  return (
    <section className="space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3">App</div>
      {mode === 'available' && (
        <div className="bg-bg-2 border border-line rounded-md p-3 flex items-start gap-3">
          <div className="flex-1 min-w-0">
            <p className="text-sm text-ink-1 font-medium">Install Zekktris</p>
            <p className="text-xs text-ink-3 mt-1 leading-relaxed">
              Add Zekktris to your home screen for an app-like experience —
              full-screen, faster launch, and notifications work even when the
              browser is closed.
            </p>
          </div>
          <button
            type="button"
            onClick={() => void promptInstall()}
            className="shrink-0 px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium"
          >
            Install
          </button>
        </div>
      )}
      {mode === 'ios-pending' && (
        <div className="bg-bg-2 border border-line rounded-md p-3">
          <p className="text-sm text-ink-1 font-medium">Add to Home Screen</p>
          <p className="text-xs text-ink-3 mt-1 leading-relaxed">
            On iPhone or iPad, tap the <strong>Share</strong> button in your
            browser, then choose <strong>Add to Home Screen</strong>. The app
            will launch full-screen with its own icon and remember your login.
          </p>
        </div>
      )}
    </section>
  );
}


/**
 * Inline row showing the user's current custom status with a
 * tap-to-edit affordance. Pulled out as its own component so the
 * Profile section in SettingsView reads cleanly.
 */
function CustomStatusRow() {
  const { user } = useAuth();
  const [open, setOpen] = useState(false);
  if (!user) return null;
  const { emoji, text } = formatCustomStatus(user);
  const isSet = !!(emoji || text);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="w-full text-left bg-bg-1 border border-line rounded-md px-3 py-2 hover:border-accent transition-colors group"
      >
        <span className="block text-sm text-ink-2 mb-0.5">Custom status</span>
        {isSet ? (
          <span className="flex items-center gap-1.5 text-ink-1 text-sm">
            {emoji && <span className="text-base">{emoji}</span>}
            {text && <span className="truncate">{text}</span>}
            {user.customStatusExpiresAt && (
              <span className="ml-auto text-xs text-ink-3 shrink-0">
                until{" "}
                {new Date(user.customStatusExpiresAt).toLocaleString(undefined, {
                  hour: "numeric",
                  minute: "2-digit",
                  month: "short",
                  day: "numeric",
                })}
              </span>
            )}
          </span>
        ) : (
          <span className="text-ink-3 text-sm italic">Set a status…</span>
        )}
      </button>
      {open && <CustomStatusModal onClose={() => setOpen(false)} />}
    </>
  );
}

// ── UsernameSection ────────────────────────────────────────────────────
//
// Inline editor for the username. Shows current value with a Change
// button; on click, expands an inline form with new-username + current-
// password + Save/Cancel. Server enforces a 90-day cooldown — when
// active, the Change button is disabled with explanatory text.

function UserIdSection() {
  const { user } = useAuth();
  const toasts = useToasts();
  if (!user) return null;
  const copy = (value: string, label: string) => {
    void copyText(value).then(
      () => toasts.push(`${label} copied`, 'success'),
      () => toasts.push('Couldn’t copy — clipboard access was blocked', 'error'),
    );
  };
  // Just the User ID here — the username (with its Change button) lives in
  // UsernameSection below, so we don't duplicate it in this tile.
  return (
    <div className="bg-bg-1 rounded-md border border-line px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ink-2 text-xs">User ID</div>
          <div className="font-mono truncate">{user.id}</div>
        </div>
        <button
          type="button"
          onClick={() => copy(user.id, 'User ID')}
          title="Copy User ID"
          aria-label="Copy User ID"
          className="shrink-0 p-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-ink-2"
        >
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

function UsernameSection() {
  const { user, rest, updateUser } = useAuth();
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  // Cooldown state — fetched on mount + after a successful change.
  const [eligibility, setEligibility] = useState<{
    eligible: boolean;
    nextEligibleAt: string | null;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void rest
      .getUsernameChangeEligibility()
      .then((r) => {
        if (!cancelled) setEligibility({ eligible: r.eligible, nextEligibleAt: r.nextEligibleAt });
      })
      .catch(() => {
        // Best-effort. If we can't determine eligibility, optimistically
        // let the user try — the server will reject if they're on
        // cooldown.
        if (!cancelled) setEligibility({ eligible: true, nextEligibleAt: null });
      });
    return () => {
      cancelled = true;
    };
  }, [rest]);

  async function submit() {
    if (pending) return;
    const trimmed = newUsername.trim().toLowerCase();
    if (!/^[a-z0-9_.]{3,32}$/.test(trimmed)) {
      toasts.push('Username must be 3-32 chars, a-z 0-9 _ . only.', 'error');
      return;
    }
    if (!password) {
      toasts.push('Enter your current password.', 'error');
      return;
    }
    setPending(true);
    try {
      const r = await rest.changeUsername({
        username: trimmed,
        currentPassword: password,
      });
      updateUser(r.user);
      toasts.push('Username changed.', 'success');
      setOpen(false);
      setNewUsername('');
      setPassword('');
      // Re-fetch eligibility so the UI now reflects the cooldown.
      void rest
        .getUsernameChangeEligibility()
        .then((er) => setEligibility({ eligible: er.eligible, nextEligibleAt: er.nextEligibleAt }))
        .catch(() => undefined);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not change username', 'error');
    } finally {
      setPending(false);
    }
  }

  const cooldownLabel = eligibility?.nextEligibleAt
    ? new Date(eligibility.nextEligibleAt).toLocaleDateString(undefined, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
      })
    : null;

  return (
    <div className="bg-bg-1 rounded-md border border-line px-3 py-2 space-y-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ink-2 text-xs">Username</div>
          <div className="font-mono truncate">@{user?.username}</div>
        </div>
        {!open && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            disabled={eligibility ? !eligibility.eligible : false}
            className="shrink-0 px-3 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-xs text-ink-2 disabled:opacity-50 disabled:cursor-not-allowed"
            title={
              eligibility && !eligibility.eligible && cooldownLabel
                ? `You can change your username again on ${cooldownLabel}`
                : undefined
            }
          >
            Change
          </button>
        )}
      </div>
      {!open && eligibility && !eligibility.eligible && cooldownLabel && (
        <p className="text-xs text-ink-3">
          Username changes are limited to once every 90 days. Next available on {cooldownLabel}.
        </p>
      )}
      {open && (
        <div className="space-y-2 pt-1">
          <input
            type="text"
            value={newUsername}
            onChange={(e) => setNewUsername(e.target.value.toLowerCase())}
            placeholder="new_username"
            maxLength={32}
            className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent font-mono"
            aria-label="New username"
            autoComplete="off"
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Current password"
            className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
            aria-label="Current password"
            autoComplete="current-password"
          />
          <p className="text-xs text-ink-3">
            You can only change your username once every 90 days. Choose carefully.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setNewUsername('');
                setPassword('');
              }}
              disabled={pending}
              className="px-3 py-1.5 rounded-md hover:bg-bg-3 text-xs text-ink-2 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending}
              className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-60 text-white text-xs font-medium"
            >
              {pending ? 'Saving…' : 'Change username'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ── EmailSection ────────────────────────────────────────────────────────
//
// Inline editor for the email address. Two-phase:
//   - User submits new email + password → POST /@me/email/change-request
//     → server sends verification link to new address.
//   - User clicks the link → /confirm-email?token=... → web client
//     calls confirmEmailChange → server updates the email.
//
// After submit, show a "verification sent" state with the target
// address and a note about checking spam.

function EmailSection() {
  const { user, rest } = useAuth();
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [password, setPassword] = useState('');
  const [pending, setPending] = useState(false);
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [expiresInMinutes, setExpiresInMinutes] = useState<number | null>(null);

  async function submit() {
    if (pending) return;
    const trimmed = newEmail.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      toasts.push('Enter a valid email address.', 'error');
      return;
    }
    if (!password) {
      toasts.push('Enter your current password.', 'error');
      return;
    }
    setPending(true);
    try {
      const r = await rest.requestEmailChange({
        newEmail: trimmed,
        currentPassword: password,
      });
      setSentTo(trimmed);
      setExpiresInMinutes(r.expiresInMinutes);
      setNewEmail('');
      setPassword('');
      toasts.push(`Verification email sent to ${trimmed}.`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not request email change', 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="bg-bg-1 rounded-md border border-line px-3 py-2 space-y-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <div className="text-ink-2 text-xs">Email</div>
          <div className="font-mono truncate">{user?.email}</div>
        </div>
        {!open && !sentTo && (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="shrink-0 px-3 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-xs text-ink-2"
          >
            Change
          </button>
        )}
      </div>
      {sentTo && (
        <div className="px-2 py-2 rounded bg-emerald-950/30 border border-emerald-900/40 text-xs text-emerald-200 leading-snug">
          A verification link was sent to <strong className="font-mono">{sentTo}</strong>.
          {expiresInMinutes
            ? ` Open it within ${expiresInMinutes} minutes to complete the change.`
            : ' Open it to complete the change.'}{' '}
          Check your spam folder if you don't see it. Your email won't change until you click the link.
          <div className="mt-1">
            <button
              type="button"
              onClick={() => {
                setSentTo(null);
                setExpiresInMinutes(null);
                setOpen(true);
              }}
              className="text-emerald-200 underline hover:text-emerald-100"
            >
              Send to a different address
            </button>
          </div>
        </div>
      )}
      {open && (
        <div className="space-y-2 pt-1">
          <input
            type="email"
            value={newEmail}
            onChange={(e) => setNewEmail(e.target.value)}
            placeholder="new@example.com"
            className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
            aria-label="New email"
            autoComplete="email"
            autoFocus
          />
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Current password"
            className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
            aria-label="Current password"
            autoComplete="current-password"
          />
          <p className="text-xs text-ink-3">
            We'll email a verification link to your new address. Your email won't change until you confirm via that link.
          </p>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setNewEmail('');
                setPassword('');
              }}
              disabled={pending}
              className="px-3 py-1.5 rounded-md hover:bg-bg-3 text-xs text-ink-2 disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={pending}
              className="px-3 py-1.5 rounded-md bg-accent hover:bg-accent/90 disabled:opacity-60 text-white text-xs font-medium"
            >
              {pending ? 'Sending…' : 'Send verification email'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * BotsSection
 * -----------
 * Bot account management. Lets a user:
 *   - Create a bot (username + display name)
 *   - See the bot token ONCE on create/regenerate (copy-to-clipboard)
 *   - List bots they own
 *   - Regenerate a bot's token (invalidates the old one)
 *   - Add a bot to one of their servers (requires MANAGE_GUILD there)
 *   - Delete a bot
 *
 * The token is shown exactly once; we surface it in a dismissible
 * callout with a copy button and a clear "you won't see this again"
 * warning, mirroring how GitHub / Discord present freshly-minted
 * tokens.
 */
function BotsSection() {
  const { rest, user } = useAuth();
  const { state } = useAppState();
  const toasts = useToasts();

  const [bots, setBots] = useState<import('@zekktris/client').Bot[] | null>(null);
  const [loading, setLoading] = useState(true);
  // The just-issued token to show once. { botId, token } or null.
  const [freshToken, setFreshToken] = useState<{ botId: string; token: string } | null>(null);

  // Create-form state.
  const [creating, setCreating] = useState(false);
  const [newUsername, setNewUsername] = useState('');
  const [newDisplayName, setNewDisplayName] = useState('');
  const [createBusy, setCreateBusy] = useState(false);

  // Which bot's "add to server" picker is open (bot id) or null.
  const [addToServerFor, setAddToServerFor] = useState<string | null>(null);

  // Event-config editor: which bot is being edited, the URL draft, and
  // a freshly-issued signing secret to show once.
  const [eventEditFor, setEventEditFor] = useState<string | null>(null);
  const [eventUrlDraft, setEventUrlDraft] = useState('');
  const [freshSecret, setFreshSecret] = useState<{ botId: string; secret: string } | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const r = await rest.listBots();
        if (alive) setBots(r.bots);
      } catch {
        if (alive) setBots([]);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [rest]);

  async function handleCreate() {
    const username = newUsername.trim().toLowerCase();
    const displayName = newDisplayName.trim();
    if (!username || !displayName) {
      toasts.push('Username and display name are required', 'error');
      return;
    }
    setCreateBusy(true);
    try {
      const { bot, token } = await rest.createBot({ username, displayName });
      setBots((prev) => [...(prev ?? []), bot]);
      setFreshToken({ botId: bot.id, token });
      setNewUsername('');
      setNewDisplayName('');
      setCreating(false);
      toasts.push('Bot created', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not create bot', 'error');
    } finally {
      setCreateBusy(false);
    }
  }

  async function handleRegen(botId: string) {
    if (!confirm('Regenerate this bot token? The current token will stop working immediately.')) {
      return;
    }
    try {
      const { token } = await rest.regenerateBotToken(botId);
      setFreshToken({ botId, token });
      toasts.push('Token regenerated', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not regenerate token', 'error');
    }
  }

  async function handleDelete(botId: string, name: string) {
    if (!confirm(`Delete bot "${name}"? This cannot be undone.`)) return;
    try {
      await rest.deleteBot(botId);
      setBots((prev) => (prev ?? []).filter((b) => b.id !== botId));
      if (freshToken?.botId === botId) setFreshToken(null);
      toasts.push('Bot deleted', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not delete bot', 'error');
    }
  }

  async function handleAddToGuild(botId: string, guildId: string) {
    try {
      await rest.addBotToGuild(guildId, botId);
      setAddToServerFor(null);
      toasts.push('Bot added to server', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not add bot', 'error');
    }
  }

  async function handleSaveEventUrl(botId: string) {
    const url = eventUrlDraft.trim();
    try {
      const r = await rest.setBotEventConfig(botId, url === '' ? null : url);
      setBots((prev) =>
        (prev ?? []).map((b) =>
          b.id === botId ? { ...b, botEventUrl: r.eventUrl } : b,
        ),
      );
      if (r.secret) setFreshSecret({ botId, secret: r.secret });
      setEventEditFor(null);
      toasts.push(r.eventUrl ? 'Event URL saved' : 'Event delivery disabled', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not save event URL', 'error');
    }
  }

  function copyToken(token: string) {
    void copyText(token).then(
      () => toasts.push('Token copied', 'success'),
      () => toasts.push('Copy failed — select and copy manually', 'error'),
    );
  }

  // Servers the user owns — the only ones we can reliably assume they
  // have MANAGE_GUILD in. (Server still enforces the precise check; this
  // just keeps the picker from listing servers the add will bounce on.)
  const myGuilds = Object.values(state.guildsById).filter(
    (g) => g.ownerId === user?.id,
  );

  return (
    <section className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider text-ink-3">Bots</div>
          <p className="text-sm text-ink-3 mt-1 max-w-md">
            Bot accounts authenticate with a token and act through the API.
            Create one, copy its token, and add it to your servers.
          </p>
        </div>
        {!creating && (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="shrink-0 px-3 py-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90"
          >
            New bot
          </button>
        )}
      </div>

      {/* Fresh-token callout — shown once after create/regenerate. */}
      {freshToken && (
        <div className="rounded-lg border border-violet-500/40 bg-violet-500/10 p-3 space-y-2">
          <div className="text-sm font-medium text-violet-200">
            Copy your bot token now
          </div>
          <p className="text-xs text-ink-3">
            This is the only time the token is shown. Store it somewhere safe —
            if you lose it you'll need to regenerate.
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-xs bg-bg-1 border border-line rounded px-2 py-1.5 font-mono text-ink-1">
              {freshToken.token}
            </code>
            <button
              type="button"
              onClick={() => copyToken(freshToken.token)}
              className="shrink-0 px-2.5 py-1.5 rounded-md bg-bg-2 border border-line text-xs text-ink-1 hover:bg-bg-3"
            >
              Copy
            </button>
          </div>
          <button
            type="button"
            onClick={() => setFreshToken(null)}
            className="text-xs text-ink-3 hover:text-ink-1"
          >
            I've saved it — dismiss
          </button>
        </div>
      )}

      {/* Create form. */}
      {creating && (
        <div className="rounded-lg border border-line bg-bg-2 p-3 space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-ink-3">Username (handle)</label>
            <input
              value={newUsername}
              onChange={(e) => setNewUsername(e.target.value)}
              placeholder="my-cool-bot"
              className="w-full bg-bg-1 border border-line rounded-md px-2.5 py-1.5 text-sm text-ink-1 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-ink-3">Display name</label>
            <input
              value={newDisplayName}
              onChange={(e) => setNewDisplayName(e.target.value)}
              placeholder="My Cool Bot"
              className="w-full bg-bg-1 border border-line rounded-md px-2.5 py-1.5 text-sm text-ink-1 focus:outline-none focus:ring-1 focus:ring-accent"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => {
                setCreating(false);
                setNewUsername('');
                setNewDisplayName('');
              }}
              className="px-3 py-1.5 rounded-md text-sm text-ink-2 hover:text-ink-1"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void handleCreate()}
              disabled={createBusy}
              className="px-3 py-1.5 rounded-md bg-accent text-white text-sm font-medium hover:bg-accent/90 disabled:opacity-50"
            >
              {createBusy ? 'Creating…' : 'Create bot'}
            </button>
          </div>
        </div>
      )}

      {/* Bot list. */}
      {loading ? (
        <div className="text-sm text-ink-3">Loading bots…</div>
      ) : (bots ?? []).length === 0 ? (
        <div className="text-sm text-ink-3">You haven't created any bots yet.</div>
      ) : (
        <ul className="space-y-2">
          {(bots ?? []).map((bot) => (
            <li
              key={bot.id}
              className="rounded-lg border border-line bg-bg-2 p-3 space-y-2"
            >
              <div className="flex items-center gap-2">
                <span
                  className={`w-8 h-8 rounded-full flex items-center justify-center text-xs font-semibold overflow-hidden ${avatarColor(bot.id)}`}
                >
                  <span className="zk-avatar-initials">{avatarInitials(bot.displayName)}</span>
                  <AvatarImage src={bot.avatarUrl} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm text-ink-1 truncate">{bot.displayName}</span>
                    <span className="shrink-0 inline-flex items-center px-1.5 rounded bg-violet-500/20 text-violet-300 text-[0.5rem] font-bold uppercase tracking-wider leading-4">
                      Bot
                    </span>
                  </div>
                  <div className="text-xs text-ink-3 truncate">@{bot.username}</div>
                </div>
              </div>

              {/* Add-to-server picker (inline). */}
              {addToServerFor === bot.id ? (
                <div className="rounded-md border border-line bg-bg-1 p-2 space-y-1">
                  <div className="text-xs text-ink-3 px-1 pb-1">
                    Add to which server?
                  </div>
                  {myGuilds.length === 0 ? (
                    <div className="text-xs text-ink-3 px-1 py-1">
                      You don't own any servers.
                    </div>
                  ) : (
                    myGuilds.map((g) => (
                      <button
                        key={g.id}
                        type="button"
                        onClick={() => void handleAddToGuild(bot.id, g.id)}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-sm text-ink-2 hover:bg-bg-3 hover:text-ink-1 text-left"
                      >
                        <span className="truncate">{g.name}</span>
                      </button>
                    ))
                  )}
                  <button
                    type="button"
                    onClick={() => setAddToServerFor(null)}
                    className="w-full text-xs text-ink-3 hover:text-ink-1 px-1 py-1 text-left"
                  >
                    Cancel
                  </button>
                </div>
              ) : eventEditFor === bot.id ? (
                <div className="rounded-md border border-line bg-bg-1 p-2 space-y-2">
                  <div className="text-xs text-ink-3">
                    Event callback URL (HTTPS). The server POSTs a signed{' '}
                    <code className="text-ink-2">message.create</code> event here
                    for channels this bot can see. Leave blank to disable.
                  </div>
                  <input
                    value={eventUrlDraft}
                    onChange={(e) => setEventUrlDraft(e.target.value)}
                    placeholder="https://my-bot.example.com/events"
                    className="w-full bg-bg-2 border border-line rounded-md px-2.5 py-1.5 text-sm text-ink-1 focus:outline-none focus:ring-1 focus:ring-accent"
                  />
                  <div className="flex justify-end gap-2">
                    <button
                      type="button"
                      onClick={() => setEventEditFor(null)}
                      className="px-2.5 py-1 rounded-md text-xs text-ink-2 hover:text-ink-1"
                    >
                      Cancel
                    </button>
                    <button
                      type="button"
                      onClick={() => void handleSaveEventUrl(bot.id)}
                      className="px-2.5 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90"
                    >
                      Save
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => setAddToServerFor(bot.id)}
                    className="px-2.5 py-1 rounded-md bg-bg-1 border border-line text-xs text-ink-1 hover:bg-bg-3"
                  >
                    Add to server
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setEventUrlDraft(bot.botEventUrl ?? '');
                      setEventEditFor(bot.id);
                    }}
                    className="px-2.5 py-1 rounded-md bg-bg-1 border border-line text-xs text-ink-1 hover:bg-bg-3"
                  >
                    {bot.botEventUrl ? 'Events: on' : 'Events'}
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleRegen(bot.id)}
                    className="px-2.5 py-1 rounded-md bg-bg-1 border border-line text-xs text-ink-1 hover:bg-bg-3"
                  >
                    Regenerate token
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleDelete(bot.id, bot.displayName)}
                    className="px-2.5 py-1 rounded-md text-xs text-danger hover:bg-bg-1"
                  >
                    Delete
                  </button>
                </div>
              )}

              {/* Fresh signing secret — shown once after setting an
                  event URL. */}
              {freshSecret?.botId === bot.id && (
                <div className="rounded-md border border-violet-500/40 bg-violet-500/10 p-2 space-y-1.5">
                  <div className="text-xs font-medium text-violet-200">
                    Signing secret (shown once)
                  </div>
                  <p className="text-[0.7rem] text-ink-3">
                    Verify the <code>X-Zekktris-Signature</code> header:
                    it's <code>sha256(secret + "." + rawBody)</code> as hex.
                  </p>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 min-w-0 truncate text-xs bg-bg-1 border border-line rounded px-2 py-1 font-mono text-ink-1">
                      {freshSecret.secret}
                    </code>
                    <button
                      type="button"
                      onClick={() => copyToken(freshSecret.secret)}
                      className="shrink-0 px-2 py-1 rounded-md bg-bg-2 border border-line text-xs text-ink-1 hover:bg-bg-3"
                    >
                      Copy
                    </button>
                  </div>
                  <button
                    type="button"
                    onClick={() => setFreshSecret(null)}
                    className="text-[0.7rem] text-ink-3 hover:text-ink-1"
                  >
                    Dismiss
                  </button>
                </div>
              )}

              {/* Slash-commands for this bot. */}
              <BotCommandsManager botId={bot.id} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * BotCommandsManager
 * ------------------
 * Per-bot slash-command management, shown inline under each bot. Lazy-loads
 * the bot's commands on first expand; lets the owner register a command
 * (name + description, optionally guild-scoped) and delete commands. To
 * actually receive invocations the bot needs an event callback configured
 * (the parent's "Events" control) — we note that when no callback is set.
 */
function BotCommandsManager({ botId }: { botId: string }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [open, setOpen] = useState(false);
  const [commands, setCommands] = useState<import('@zekktris/client').BotCommand[] | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || commands !== null) return;
    let alive = true;
    void (async () => {
      try {
        const r = await rest.listBotCommands(botId);
        if (alive) setCommands(r.commands);
      } catch {
        if (alive) setCommands([]);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, commands, rest, botId]);

  async function add() {
    const n = name.trim().toLowerCase();
    const d = description.trim();
    if (!n || !d) {
      toasts.push('Command name and description are required', 'error');
      return;
    }
    setBusy(true);
    try {
      const { command } = await rest.registerBotCommand(botId, { name: n, description: d });
      setCommands((prev) => [...(prev ?? []), command]);
      setName('');
      setDescription('');
      toasts.push(`/${command.name} registered`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not register command', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function remove(commandId: string, cmdName: string) {
    if (!confirm(`Delete /${cmdName}?`)) return;
    try {
      await rest.deleteBotCommand(botId, commandId);
      setCommands((prev) => (prev ?? []).filter((cmd) => cmd.id !== commandId));
      toasts.push('Command deleted', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not delete command', 'error');
    }
  }

  return (
    <div className="rounded-md border border-line bg-bg-1 p-2 mt-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between text-xs text-ink-2 hover:text-ink-1"
      >
        <span>Slash commands{commands ? ` (${commands.length})` : ''}</span>
        <span className={`transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <div className="mt-2 space-y-2">
          {commands === null ? (
            <p className="text-xs text-ink-3">Loading…</p>
          ) : commands.length === 0 ? (
            <p className="text-xs text-ink-3">No commands yet.</p>
          ) : (
            <ul className="space-y-1">
              {commands.map((cmd) => (
                <li key={cmd.id} className="flex items-start justify-between gap-2 text-xs">
                  <span className="min-w-0">
                    <code className="text-accent">/{cmd.name}</code>
                    {cmd.guildId && <span className="text-ink-3"> (this server)</span>}
                    <span className="text-ink-3"> — {cmd.description}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => void remove(cmd.id, cmd.name)}
                    className="shrink-0 text-danger hover:underline"
                  >
                    Delete
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-1.5">
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="name"
              maxLength={32}
              className="w-24 bg-bg-2 border border-line rounded px-2 py-1 text-xs text-ink-1 focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <input
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="description"
              maxLength={200}
              className="flex-1 min-w-[8rem] bg-bg-2 border border-line rounded px-2 py-1 text-xs text-ink-1 focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <button
              type="button"
              onClick={() => void add()}
              disabled={busy}
              className="px-2.5 py-1 rounded-md bg-accent text-white text-xs font-medium hover:bg-accent/90 disabled:opacity-50"
            >
              Add
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
