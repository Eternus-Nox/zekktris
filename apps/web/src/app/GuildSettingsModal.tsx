/**
 * GuildSettingsModal
 * ------------------
 * Server-level settings, opened from the gear icon in the channel-list
 * header. The modal is tabbed; each tab is a self-contained component so
 * adding more (Roles, Permissions, Audit Log) later is just a matter of
 * pushing another entry into the TABS array.
 *
 * Permission model: members with ADMINISTRATOR (via any role) OR the
 * guild owner see every tab. Non-admin members see only Overview (read-
 * only) and a "Leave server" button. The Danger Zone (delete server)
 * remains owner-only regardless — admins can manage everything below
 * the nuclear option. The API still enforces real permission checks on
 * every mutation, so the worst case from a wrong UI gating is a 403
 * surfaced via a toast.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { ApiError, type AuditLogEntry, type AutomodRule, type Guild, type GuildBan, type GuildEmoji, type GuildMember, type Invite, type PublicUser, type Role } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { copyText } from '../lib/clipboard';
import { Info, UserPlus, Users, AlertTriangle, X, Copy, Trash, Shield, Search, Ban as BanIcon, Smile, Upload, StickerSquare, Compass, Hand, Clock, Plus, Activity, FilePen, Archive, Download } from '../lib/icons';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { Portal } from '../lib/Portal';
import { ModalHeader } from '../lib/ModalHeader';
import { memberIsAdmin } from '../lib/permissions';
import { RolesTab } from './RolesTab';
import { ReactionRolesTab } from './ReactionRolesTab';
import { StickersTab } from './StickersTab';
import { DiscoveryTab } from './DiscoveryTab';

type TabId =
  | 'overview'
  | 'welcomeAndAfk'
  | 'rules'
  | 'roles'
  | 'reactionRoles'
  | 'invites'
  | 'members'
  | 'bans'
  | 'automod'
  | 'auditLog'
  | 'emojis'
  | 'stickers'
  | 'discovery'
  | 'backup'
  | 'danger';

interface Tab {
  id: TabId;
  label: string;
  icon: typeof Info;
  /** Visible to admins (incl. owner) only. */
  adminOnly?: boolean;
  /** Visible only to the guild owner — hidden for non-owner admins. */
  ownerOnly?: boolean;
}

const TABS: Tab[] = [
  { id: 'overview', label: 'Overview', icon: Info },
  { id: 'welcomeAndAfk', label: 'Welcome & AFK', icon: Hand, adminOnly: true },
  { id: 'rules', label: 'Rules', icon: FilePen, adminOnly: true },
  { id: 'roles', label: 'Roles', icon: Shield, adminOnly: true },
  { id: 'reactionRoles', label: 'Reaction Roles', icon: Smile, adminOnly: true },
  { id: 'invites', label: 'Invites', icon: UserPlus, adminOnly: true },
  { id: 'members', label: 'Members', icon: Users },
  { id: 'bans', label: 'Bans', icon: BanIcon, adminOnly: true },
  { id: 'automod', label: 'AutoMod', icon: Clock, adminOnly: true },
  { id: 'auditLog', label: 'Audit Log', icon: Activity, adminOnly: true },
  { id: 'emojis', label: 'Emoji', icon: Smile, adminOnly: true },
  { id: 'stickers', label: 'Stickers', icon: StickerSquare, adminOnly: true },
  // Discovery — opt-in to the public guild directory. Visible to
  // anyone with MANAGE_GUILD (the server-side route gates the same).
  { id: 'discovery', label: 'Discovery', icon: Compass, adminOnly: true },
  // Backup & Restore — export the server's config + images, or rebuild a
  // saved backup as a fresh server. MANAGE_GUILD-gated like the rest.
  { id: 'backup', label: 'Backup & Restore', icon: Archive, adminOnly: true },
  // Danger zone (delete the server) stays owner-only — admins
  // shouldn't be able to nuke a server they don't own.
  { id: 'danger', label: 'Danger Zone', icon: AlertTriangle, ownerOnly: true },
];

export function GuildSettingsModal({
  guild,
  onClose,
  initialTab = 'overview',
}: {
  guild: Guild;
  onClose: () => void;
  /** Tab to show first. Defaults to Overview; use 'invites' from
      GuildInfoCard's "Invite people" action. Owner-gated tabs fall
      back to Overview if a non-owner asks for one. */
  initialTab?: TabId;
}) {
  const { user } = useAuth();
  const { state, loadRoles, loadMembers } = useAppState();
  const isOwner = !!user && user.id === guild.ownerId;

  // Lazy-load roles + members for this guild on first render so the
  // ADMINISTRATOR check below has data. Both calls are idempotent at
  // the AppState level, so calling on every modal open is cheap.
  // Without these, a fresh page load that opens settings before the
  // member list has been populated would compute the user as non-admin
  // and hide tabs incorrectly.
  useEffect(() => {
    if (!state.rolesByGuild[guild.id]) {
      void loadRoles(guild.id).catch(() => undefined);
    }
    if (!state.loadedMembers.has(guild.id)) {
      void loadMembers(guild.id).catch(() => undefined);
    }
  }, [guild.id, state.rolesByGuild, state.loadedMembers, loadRoles, loadMembers]);

  // Resolve the caller's role ids. Members come in via the guild's
  // member list; if the user opened settings before that loaded,
  // `myMember` is undefined and we fall back to "non-admin" — which
  // re-evaluates to true once the member list arrives via gateway/REST.
  const myMember = state.membersByGuild[guild.id]?.find((m) => m.userId === user?.id);
  const myRoleIds = myMember?.roleIds ?? null;
  const allRoles = state.rolesByGuild[guild.id] ?? null;

  const isAdmin = memberIsAdmin(allRoles, guild.id, myRoleIds, isOwner);

  const visibleTabs = TABS.filter((t) => {
    if (t.ownerOnly) return isOwner;
    if (t.adminOnly) return isAdmin;
    return true;
  });
  const allowed = visibleTabs.find((t) => t.id === initialTab);
  const [active, setActive] = useState<TabId>(allowed ? initialTab : 'overview');

  // Close on Escape — modals consistently honor this throughout the app.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <Portal>
      <div
        className="fixed inset-0 bg-black/60 z-50 flex items-stretch sm:items-center justify-center sm:p-4"
        onClick={onClose}
      >
      <div
        className="bg-bg-1 border border-line elevation-pop w-full max-w-3xl flex flex-col sm:flex-row overflow-hidden h-full sm:h-[80vh] sm:rounded-lg pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)] sm:pt-0 sm:pb-0"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Sidebar — vertical on tablet+ (≥sm 640px), 2-row grid on
            mobile. We dropped horizontal scrolling because it hid
            tabs offscreen and forced users to discover the scroll
            interaction. The 2-row grid auto-fits up to ~5 tabs at
            a comfortable touch size; six+ tabs would need a third
            row but that's a deferred concern (we have 5 max). */}
        <aside className="bg-bg-2 sm:border-r border-b sm:border-b-0 border-line shrink-0 sm:w-48 grid grid-cols-3 sm:flex sm:flex-col gap-1 p-2 sm:p-3 sm:overflow-x-visible">
          <div className="hidden sm:block px-2 py-1 mb-2 text-xs uppercase tracking-wider text-ink-3 truncate">
            {guild.name}
          </div>
          {visibleTabs.map((t) => {
            const Icon = t.icon;
            return (
              <button
                key={t.id}
                onClick={() => setActive(t.id)}
                className={`flex items-center justify-center sm:justify-start gap-1.5 sm:gap-2 px-2 py-2 sm:py-1.5 rounded text-xs sm:text-sm transition-colors min-w-0 ${
                  active === t.id
                    ? 'bg-bg-3 text-ink-1'
                    : 'text-ink-2 hover:text-ink-1 hover:bg-bg-3/50'
                }`}
              >
                <Icon size={14} className="shrink-0" />
                <span className="truncate">{t.label}</span>
              </button>
            );
          })}
        </aside>

        {/* Content */}
        <div className="flex-1 min-h-0 min-w-0 overflow-y-auto scrollbar-thin">
          <ModalHeader
            title={visibleTabs.find((t) => t.id === active)?.label ?? 'Server Settings'}
            onClose={onClose}
          />
          <div className="px-4 sm:px-6 py-4 sm:py-5">
            {active === 'overview' && <OverviewTab guild={guild} isOwner={isOwner} isAdmin={isAdmin} />}
            {active === 'welcomeAndAfk' && isAdmin && <WelcomeAndAfkTab guild={guild} />}
            {active === 'rules' && isAdmin && <RulesTab guild={guild} />}
            {active === 'roles' && isAdmin && <RolesTab guild={guild} />}
            {active === 'reactionRoles' && isAdmin && <ReactionRolesTab guild={guild} />}
            {active === 'invites' && isAdmin && <InvitesTab guild={guild} />}
            {active === 'members' && <MembersTab guild={guild} />}
            {active === 'bans' && isAdmin && <BansTab guild={guild} />}
            {active === 'automod' && isAdmin && <AutomodTab guild={guild} />}
            {active === 'auditLog' && isAdmin && <AuditLogTab guild={guild} />}
            {active === 'emojis' && isAdmin && <EmojisTab guild={guild} />}
            {active === 'stickers' && isAdmin && <StickersTab guild={guild} />}
            {active === 'discovery' && isAdmin && <DiscoveryTab guild={guild} />}
            {active === 'backup' && isAdmin && <BackupTab guild={guild} onClose={onClose} />}
            {active === 'danger' && isOwner && <DangerTab guild={guild} onClose={onClose} />}
          </div>
        </div>
      </div>
      </div>
    </Portal>
  );
}

// ── Overview tab ─────────────────────────────────────────────────────────────

function OverviewTab({ guild, isOwner, isAdmin }: { guild: Guild; isOwner: boolean; isAdmin: boolean }) {
  const { rest } = useAuth();
  const { refreshGuilds } = useAppState();
  const toasts = useToasts();
  const [name, setName] = useState(guild.name);
  const [description, setDescription] = useState(guild.description ?? '');
  const [saving, setSaving] = useState(false);

  // Reset local form state when the guild prop changes (e.g. live update
  // from another tab). The `key={guild.id}` on the modal would also force
  // remount, but local-form-resync is cheaper and handles in-flight edits.
  useEffect(() => {
    setName(guild.name);
    setDescription(guild.description ?? '');
  }, [guild]);

  // Editing requires MANAGE_GUILD on the server, which is included
  // in ADMINISTRATOR. We use isAdmin as a sufficient client-side gate;
  // the API enforces the actual bit on PATCH /guilds/:id. isOwner is
  // kept as a separate prop only for the future case where some
  // overview-tab affordances need owner-strict gating (e.g. transfer
  // ownership) — none currently exist.
  const canEdit = isAdmin;
  void isOwner;

  const dirty = name !== guild.name || description !== (guild.description ?? '');

  async function save() {
    if (!dirty || saving) return;
    setSaving(true);
    try {
      await rest.patchGuild(guild.id, {
        name: name !== guild.name ? name : undefined,
        description: description !== (guild.description ?? '') ? description || null : undefined,
      });
      await refreshGuilds();
      toasts.push('Server updated', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Update failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      <Field label="Server name">
        <input
          type="text"
          value={name}
          maxLength={64}
          onChange={(e) => setName(e.target.value)}
          disabled={!canEdit}
          className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1 disabled:opacity-60"
        />
      </Field>
      <Field label="Description" hint="Shown in the server picker. Optional, up to 200 characters.">
        <textarea
          value={description}
          maxLength={200}
          rows={3}
          onChange={(e) => setDescription(e.target.value)}
          disabled={!canEdit}
          className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1 resize-none disabled:opacity-60"
        />
      </Field>
      <Field
        label="Server icon"
        hint="Recommended: square, 512×512. PNG, JPEG, GIF, or WebP. Shown as a circle in the server rail and chat headers."
      >
        <ImageUploadField
          currentUrl={guild.iconUrl}
          shape="circle"
          previewSize={64}
          disabled={!canEdit}
          onUpload={async (file) => {
            const { guild: updated } = await rest.uploadGuildIcon(guild.id, file);
            await refreshGuilds();
            toasts.push('Icon updated', 'success');
            return updated.iconUrl;
          }}
          onClear={async () => {
            await rest.patchGuild(guild.id, { iconUrl: null });
            await refreshGuilds();
            toasts.push('Icon removed', 'success');
          }}
        />
      </Field>
      <Field
        label="Server banner"
        hint="Recommended: 1920×1080 (16:9 wide). Shown above the channel list and on invite/discovery cards."
      >
        <ImageUploadField
          currentUrl={guild.bannerUrl}
          shape="banner"
          previewSize={120}
          disabled={!canEdit}
          onUpload={async (file) => {
            const { guild: updated } = await rest.uploadGuildBanner(guild.id, file);
            await refreshGuilds();
            toasts.push('Banner updated', 'success');
            return updated.bannerUrl;
          }}
          onClear={async () => {
            await rest.patchGuild(guild.id, { bannerUrl: null });
            await refreshGuilds();
            toasts.push('Banner removed', 'success');
          }}
        />
      </Field>

      {canEdit ? (
        <div className="flex justify-end pt-2 border-t border-line">
          <button
            onClick={save}
            disabled={!dirty || saving}
            className="px-4 py-2 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            {saving ? 'Saving…' : 'Save changes'}
          </button>
        </div>
      ) : (
        <p className="text-xs text-ink-3 pt-2 border-t border-line">
          Only admins or the server owner can edit these settings.
        </p>
      )}
    </div>
  );
}

// ── Welcome & AFK tab ────────────────────────────────────────────────────────

/**
 * Two-section settings panel for new-member greeting and AFK voice
 * parking. Both feature sets ride on top of fields persisted to the
 * guilds row (afk_channel_id, afk_timeout_seconds, welcome_channel_id,
 * welcome_message_enabled, welcome_message_template).
 *
 * UX:
 *   AFK
 *     - Channel dropdown: every guild_voice channel + "(none)".
 *     - Timeout select: a few preset durations matching Discord's
 *       1m / 5m / 15m / 30m / 1h.
 *
 *   Welcome
 *     - Channel dropdown: every guild_text channel + "(none)".
 *     - Enabled toggle. When off, the channel + template inputs
 *       are still editable (so you can configure ahead of flipping
 *       the switch) but disabled visually so the dependency reads.
 *     - Template textarea with a {user} placeholder hint and a
 *       small live preview that swaps {user} → "@Alice" using the
 *       current user as the demo.
 *
 * Save button submits everything in one PATCH. Channels that don't
 * pass the server-side type/guild check come back as 400; we toast
 * the error and leave the form populated so the user can correct.
 */
function WelcomeAndAfkTab({ guild }: { guild: Guild }) {
  const { rest, user } = useAuth();
  const { state, refreshGuilds } = useAppState();
  const toasts = useToasts();

  // Local form state mirrors the guild's persisted values. Initialized
  // once from props; subsequent prop changes (e.g. another tab saved a
  // patch) sync via the key on the modal which remounts this tab.
  const [afkChannelId, setAfkChannelId] = useState<string | null>(
    guild.afkChannelId ?? null,
  );
  const [afkTimeoutSeconds, setAfkTimeoutSeconds] = useState<number>(
    guild.afkTimeoutSeconds ?? 300,
  );
  const [welcomeChannelId, setWelcomeChannelId] = useState<string | null>(
    guild.welcomeChannelId ?? null,
  );
  const [welcomeEnabled, setWelcomeEnabled] = useState<boolean>(
    guild.welcomeMessageEnabled ?? false,
  );
  const [welcomeTemplate, setWelcomeTemplate] = useState<string>(
    guild.welcomeMessageTemplate ?? '',
  );
  const [saving, setSaving] = useState(false);

  // Channel buckets. The app-state holds channels per guild; we
  // filter to the two types we need. Both undeleted (no soft-deleted
  // channels in the list to begin with).
  const channels = state.channelsByGuild[guild.id] ?? [];
  const voiceChannels = channels.filter((c) => c.type === 'guild_voice');
  const textChannels = channels.filter((c) => c.type === 'guild_text');

  // Preview: substitute {user} with the current user's mention-ish
  // rendering ("@Alice" style). Server does the actual @mention
  // resolution at post time — this is purely a visual hint so the
  // template editor isn't blind.
  const previewName = user?.displayName || user?.username || 'NewMember';
  const previewText = (welcomeTemplate || 'Welcome to the server, {user}! 👋').replace(
    /\{user\}/g,
    `@${previewName}`,
  );

  async function save() {
    if (saving) return;
    setSaving(true);
    try {
      await rest.patchGuild(guild.id, {
        afkChannelId,
        afkTimeoutSeconds,
        welcomeChannelId,
        welcomeMessageEnabled: welcomeEnabled,
        // Empty string saves as null (clears the override, lets the
        // server fall back to the default greeting).
        welcomeMessageTemplate: welcomeTemplate.trim() === '' ? null : welcomeTemplate,
      });
      await refreshGuilds();
      toasts.push('Settings saved', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not save', 'error');
    } finally {
      setSaving(false);
    }
  }

  // Dirty check — only enable Save when something actually changed.
  // Avoids accidentally re-issuing the PATCH (which would re-write
  // an audit-log entry for no change).
  const dirty =
    afkChannelId !== (guild.afkChannelId ?? null) ||
    afkTimeoutSeconds !== (guild.afkTimeoutSeconds ?? 300) ||
    welcomeChannelId !== (guild.welcomeChannelId ?? null) ||
    welcomeEnabled !== (guild.welcomeMessageEnabled ?? false) ||
    welcomeTemplate !== (guild.welcomeMessageTemplate ?? '');

  return (
    <div className="space-y-8 max-w-2xl">
      {/* ── AFK ──────────────────────────────────────────────────── */}
      <section>
        <h3 className="text-base font-semibold text-ink-1 mb-1">AFK channel</h3>
        <p className="text-xs text-ink-3 mb-4 leading-relaxed">
          Users who join the AFK channel have their microphone disabled at the
          server. Use it as a "parking spot" for idle members so active rooms
          stay focused. {' '}
          <span className="text-ink-3/70">
            Members self-muted longer than the timeout below are moved here
            automatically.
          </span>
        </p>

        <label className="block">
          <span className="text-xs font-medium text-ink-2">Voice channel</span>
          <select
            value={afkChannelId ?? ''}
            onChange={(e) => setAfkChannelId(e.target.value || null)}
            className="mt-1 w-full bg-bg-3 border border-line rounded px-3 py-2 text-sm"
          >
            <option value="">(none — no AFK channel)</option>
            {voiceChannels.map((c) => (
              <option key={c.id} value={c.id}>
                🔊 {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className="block mt-3">
          <span className="text-xs font-medium text-ink-2">Auto-move timeout</span>
          <select
            value={afkTimeoutSeconds}
            onChange={(e) => setAfkTimeoutSeconds(Number(e.target.value))}
            className="mt-1 w-full bg-bg-3 border border-line rounded px-3 py-2 text-sm"
            disabled={!afkChannelId}
          >
            <option value={60}>1 minute</option>
            <option value={300}>5 minutes</option>
            <option value={900}>15 minutes</option>
            <option value={1800}>30 minutes</option>
            <option value={3600}>1 hour</option>
          </select>
        </label>
      </section>

      {/* ── Welcome ─────────────────────────────────────────────── */}
      <section>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-base font-semibold text-ink-1">Welcome message</h3>
          <button
            type="button"
            role="switch"
            aria-checked={welcomeEnabled}
            onClick={() => setWelcomeEnabled((v) => !v)}
            className={`relative w-10 h-6 rounded-full transition-colors shrink-0 ${
              welcomeEnabled ? 'bg-accent' : 'bg-bg-3'
            }`}
            title={welcomeEnabled ? 'Turn off welcome messages' : 'Turn on welcome messages'}
          >
            <span
              className={`absolute top-0.5 w-5 h-5 rounded-full bg-white transition-all ${
                welcomeEnabled ? 'left-[18px]' : 'left-0.5'
              }`}
              aria-hidden
            />
          </button>
        </div>
        <p className="text-xs text-ink-3 mb-4 leading-relaxed">
          Greet new members automatically when they join the server. The message
          is posted as the joining user — they're "live" in the chat the moment
          they land.
        </p>

        <label className={`block ${welcomeEnabled ? '' : 'opacity-60'}`}>
          <span className="text-xs font-medium text-ink-2">Send greeting in</span>
          <select
            value={welcomeChannelId ?? ''}
            onChange={(e) => setWelcomeChannelId(e.target.value || null)}
            className="mt-1 w-full bg-bg-3 border border-line rounded px-3 py-2 text-sm"
            disabled={!welcomeEnabled}
          >
            <option value="">
              (default — system channel, or first text channel)
            </option>
            {textChannels.map((c) => (
              <option key={c.id} value={c.id}>
                # {c.name}
              </option>
            ))}
          </select>
        </label>

        <label className={`block mt-3 ${welcomeEnabled ? '' : 'opacity-60'}`}>
          <span className="text-xs font-medium text-ink-2">Greeting text</span>
          <textarea
            value={welcomeTemplate}
            onChange={(e) => setWelcomeTemplate(e.target.value)}
            disabled={!welcomeEnabled}
            placeholder="Welcome to the server, {user}! 👋"
            maxLength={1000}
            rows={3}
            className="mt-1 w-full bg-bg-3 border border-line rounded px-3 py-2 text-sm font-mono resize-y"
          />
          <span className="text-[0.65rem] text-ink-3 mt-1 block">
            Use <code className="text-ink-2">{'{user}'}</code> to @mention the new
            member. Leave empty for the default greeting.
          </span>
        </label>

        {welcomeEnabled && (
          <div className="mt-3 px-3 py-2 rounded border border-line bg-bg-3/50">
            <div className="text-[0.65rem] text-ink-3 mb-1">Preview</div>
            <div className="text-sm text-ink-2 whitespace-pre-wrap break-words">
              {previewText}
            </div>
          </div>
        )}
      </section>

      <div className="flex items-center gap-2 pt-2 border-t border-line">
        <button
          type="button"
          onClick={() => void save()}
          disabled={!dirty || saving}
          className="px-4 py-2 rounded text-sm font-medium bg-accent text-white disabled:opacity-50 transition-opacity"
        >
          {saving ? 'Saving…' : 'Save changes'}
        </button>
        {dirty && !saving && (
          <span className="text-xs text-ink-3">You have unsaved changes.</span>
        )}
      </div>
    </div>
  );
}

// ── Rules tab ──────────────────────────────────────────────────────────────
//
// Edits the guild's rules_content. When non-empty, new joiners enter
// the guild in 'pending' state and must acknowledge before they can
// participate. Editing rules stamps rulesUpdatedAt server-side — a
// future feature can use that to optionally re-prompt established
// members on substantive edits.
//
// Implementation notes:
//   - Local state seeds from the guild prop at modal-open time.
//     After save, the local baseline is updated so the dirty flag
//     clears. If the modal is closed + reopened, it gets fresh
//     guild prop data. Same pattern as the Welcome tab.
//   - Empty / whitespace-only content sent to the server is stored
//     as NULL (removes the onboarding gate). The explicit Clear
//     button surfaces this as a deliberate action rather than relying
//     on admins to know that an empty textarea has special semantics.
//   - The preview pane mirrors the rendering used in OnboardingModal
//     (whitespace-pre-wrap, no markdown), so admins see exactly what
//     new joiners will see.

const RULES_MAX_LEN = 10_000;

function RulesTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const { state } = useAppState();
  const [text, setText] = useState(guild.rulesContent ?? '');
  const [saved, setSaved] = useState(guild.rulesContent ?? '');
  const [saving, setSaving] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  const trimmed = text.trim();
  const savedTrimmed = saved.trim();
  const dirty = text !== saved;
  const hasRules = savedTrimmed.length > 0;
  const overLimit = text.length > RULES_MAX_LEN;

  // Pending-member count for the informational readout + the Clear
  // confirmation copy. Server-side stats endpoint gives an accurate
  // count even when local member cache is paginated/partial; we
  // fall back to the local-set approximation while the fetch is in
  // flight or if it errors.
  const [statsPending, setStatsPending] = useState<number | null>(null);
  const localPendingCount = useMemo(() => {
    const members = state.membersByGuild[guild.id];
    if (!members) return null;
    return members.filter((m) => m.membershipState === 'pending').length;
  }, [state.membersByGuild, guild.id]);
  const pendingCount = statsPending ?? localPendingCount;

  // Initial fetch + on-window-focus refresh. The stats are admin-
  // gated, so we only call when the viewer can view this tab at
  // all (which the parent guard already enforces).
  const refreshStats = useCallback(async () => {
    try {
      const r = await rest.getOnboardingStats(guild.id);
      setStatsPending(r.pending);
    } catch {
      // Silent fail — local approximation continues to show.
    }
  }, [rest, guild.id]);

  useEffect(() => {
    void refreshStats();
  }, [refreshStats]);

  async function handleSave() {
    if (saving || clearing) return;
    if (overLimit) {
      toasts.push(`Rules can't be longer than ${RULES_MAX_LEN.toLocaleString()} characters`, 'error');
      return;
    }
    setSaving(true);
    try {
      // Empty/whitespace gets sent as null to the server, which
      // clears the field. We surface this explicitly via the Clear
      // button, but if a user manually empties the textarea + Saves
      // we honor that intent.
      const payload = trimmed.length === 0 ? null : text;
      await rest.patchGuild(guild.id, { rulesContent: payload });
      setSaved(text);
      toasts.push(
        payload === null ? 'Rules cleared — onboarding gate removed' : 'Rules saved',
        'success',
      );
      void refreshStats();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Save failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    if (saving || clearing) return;
    if (!hasRules) return; // nothing to clear
    const pendingCopy = pendingCount && pendingCount > 0
      ? ` This will also activate ${pendingCount} member${pendingCount === 1 ? '' : 's'} currently waiting to acknowledge.`
      : '';
    if (!confirm(`Clear the server rules? New members will be able to participate immediately without acknowledging anything.${pendingCopy}`)) {
      return;
    }
    setClearing(true);
    try {
      await rest.patchGuild(guild.id, { rulesContent: null });
      setText('');
      setSaved('');
      toasts.push('Rules cleared — onboarding gate removed', 'success');
      void refreshStats();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Clear failed', 'error');
    } finally {
      setClearing(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-3 leading-relaxed">
        Server rules are shown to new members when they join. Until a new member acknowledges
        the rules, they can't send messages, react, or join voice channels. Existing members
        aren't affected by changes here — only members who join after the rules are set will
        see the acknowledgment screen.
      </p>

      {/* Status banner. Three states: no rules (neutral), unsaved
          edits (amber), saved + clean (emerald). Drives the user's
          confidence about what's actually deployed vs what's draft. */}
      {!hasRules && !dirty && (
        <div className="rounded-md border border-line bg-bg-2/50 px-3 py-2 text-xs text-ink-3">
          No rules configured. New members can participate immediately on join.
        </div>
      )}
      {hasRules && !dirty && (
        <div className="rounded-md border border-emerald-900/40 bg-emerald-950/30 px-3 py-2 text-xs text-emerald-300">
          <div>✓ Rules active — new members must acknowledge before participating.</div>
          {pendingCount !== null && pendingCount > 0 && (
            <div className="mt-1 text-emerald-400/80">
              {pendingCount} member{pendingCount === 1 ? '' : 's'} currently pending acknowledgment.
            </div>
          )}
        </div>
      )}
      {dirty && (
        <div className="rounded-md border border-amber-900/40 bg-amber-950/30 px-3 py-2 text-xs text-amber-300">
          Unsaved changes. Click Save to apply.
        </div>
      )}

      {/* Editor */}
      <div>
        <div className="flex items-center justify-between mb-1.5">
          <label className="text-xs uppercase tracking-wider text-ink-3 font-semibold">
            Rules content
          </label>
          <span className={`text-xs ${overLimit ? 'text-red-400' : 'text-ink-3'}`}>
            {text.length.toLocaleString()} / {RULES_MAX_LEN.toLocaleString()}
          </span>
        </div>
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={`1. Be respectful to other members.\n2. No spam, advertising, or self-promotion.\n3. Stay on topic in each channel.\n…`}
          rows={14}
          className="w-full px-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent resize-y font-sans leading-relaxed"
        />
        <p className="text-xs text-ink-3 mt-1">
          Use line breaks freely — they're preserved when shown to new members.
        </p>
      </div>

      {/* Preview toggle + pane */}
      <div>
        <button
          onClick={() => setShowPreview((v) => !v)}
          className="text-xs text-ink-2 hover:text-ink-1 transition-colors flex items-center gap-1.5"
        >
          <span className={`inline-block transition-transform ${showPreview ? 'rotate-90' : ''}`}>▸</span>
          {showPreview ? 'Hide preview' : 'Show preview of what new members will see'}
        </button>
        {showPreview && (
          <div className="mt-2 rounded-md border border-line bg-bg-2/40 p-4">
            {trimmed.length === 0 ? (
              <p className="text-xs text-ink-3 italic">
                Preview empty — type rules above to see how they'll render.
              </p>
            ) : (
              <div className="text-sm text-ink-1 whitespace-pre-wrap leading-relaxed">
                {text}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => void handleSave()}
          disabled={saving || clearing || !dirty || overLimit}
          className="px-4 py-1.5 rounded-md bg-accent hover:bg-accent/85 text-bg-1 text-sm font-medium disabled:opacity-60 disabled:cursor-not-allowed transition-colors"
        >
          {saving ? 'Saving…' : 'Save rules'}
        </button>
        {hasRules && (
          <button
            onClick={() => void handleClear()}
            disabled={saving || clearing}
            className="px-4 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm text-ink-2 disabled:opacity-60 transition-colors"
          >
            {clearing ? 'Clearing…' : 'Clear rules'}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Invites tab ──────────────────────────────────────────────────────────────

function InvitesTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const { state } = useAppState();
  const toasts = useToasts();
  const [invites, setInvites] = useState<Invite[] | null>(null);
  const [creating, setCreating] = useState(false);
  // Configurable invite parameters. Defaults match the previous
  // hardcoded values (1 day / unlimited) so admins who don't touch
  // these controls get the same behavior as before.
  // ttlSeconds: 0 means "never expires" (sent as null to the API).
  const [ttlSeconds, setTtlSeconds] = useState<number>(86400);
  // maxUses: 0 means "unlimited" (sent as null to the API).
  const [maxUses, setMaxUses] = useState<number>(0);

  // Pick a default channel for new invites — first text channel in the
  // guild. The channel ID is required by createInvite (invites are scoped
  // to a channel that the joiner lands in).
  const defaultChannelId = (state.channelsByGuild[guild.id] ?? []).find((c) => c.type === 'guild_text')?.id;

  useEffect(() => {
    let cancelled = false;
    rest
      .listGuildInvites(guild.id)
      .then((r) => !cancelled && setInvites(r.invites))
      .catch((e) => !cancelled && toasts.push(e instanceof ApiError ? e.message : 'Failed to load invites', 'error'));
    return () => {
      cancelled = true;
    };
  }, [guild.id, rest, toasts]);

  async function create() {
    if (!defaultChannelId) {
      toasts.push('No text channel to invite into', 'error');
      return;
    }
    setCreating(true);
    try {
      const r = await rest.createInvite(defaultChannelId, {
        ttlSeconds: ttlSeconds === 0 ? null : ttlSeconds,
        maxUses: maxUses === 0 ? null : maxUses,
      });
      // Re-list to get the full canonical row (uses, expiresAt, etc).
      const refreshed = await rest.listGuildInvites(guild.id);
      setInvites(refreshed.invites);
      // Copy the new code to the clipboard immediately for the common case.
      const link = `${window.location.origin}/invite/${r.invite.code}`;
      try {
        await copyText(link);
        toasts.push('Invite created and copied', 'success');
      } catch {
        toasts.push('Invite created', 'success');
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to create invite', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function revoke(code: string) {
    try {
      await rest.deleteInvite(code);
      setInvites((prev) => (prev ?? []).filter((i) => i.code !== code));
      toasts.push('Invite revoked', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to revoke', 'error');
    }
  }

  async function copyLink(code: string) {
    const link = `${window.location.origin}/invite/${code}`;
    try {
      await copyText(link);
      toasts.push('Link copied', 'success');
    } catch {
      toasts.push(link, 'info');
    }
  }

  return (
    <div className="space-y-4">
      <div className="space-y-3">
        <p className="text-sm text-ink-2">
          Anyone with an invite link can join the server. Pick how long it
          stays valid and how many people can use it, then click "New invite"
          to generate a code. Revoke a link to disable it immediately.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-ink-3 flex flex-col gap-1">
            <span>Expires after</span>
            <select
              value={ttlSeconds}
              onChange={(e) => setTtlSeconds(Number(e.target.value))}
              className="bg-bg-2 border border-line rounded px-2 py-1.5 text-sm text-ink-1 min-w-[140px]"
            >
              <option value={1800}>30 minutes</option>
              <option value={3600}>1 hour</option>
              <option value={21600}>6 hours</option>
              <option value={43200}>12 hours</option>
              <option value={86400}>1 day</option>
              <option value={604800}>7 days</option>
              <option value={0}>Never</option>
            </select>
          </label>
          <label className="text-xs text-ink-3 flex flex-col gap-1">
            <span>Max uses</span>
            <select
              value={maxUses}
              onChange={(e) => setMaxUses(Number(e.target.value))}
              className="bg-bg-2 border border-line rounded px-2 py-1.5 text-sm text-ink-1 min-w-[140px]"
            >
              <option value={1}>1 use</option>
              <option value={5}>5 uses</option>
              <option value={10}>10 uses</option>
              <option value={25}>25 uses</option>
              <option value={50}>50 uses</option>
              <option value={100}>100 uses</option>
              <option value={0}>Unlimited</option>
            </select>
          </label>
          <button
            onClick={create}
            disabled={creating || !defaultChannelId}
            className="ml-auto inline-flex items-center gap-2 px-3 py-1.5 rounded-md bg-accent text-white text-sm font-medium disabled:opacity-50"
          >
            <UserPlus size={14} />
            <span>{creating ? 'Creating…' : 'New invite'}</span>
          </button>
        </div>
      </div>

      {invites === null ? (
        <p className="text-sm text-ink-3">Loading invites…</p>
      ) : invites.length === 0 ? (
        <p className="text-sm text-ink-3 py-4 text-center bg-bg-2 rounded-md border border-line">
          No active invites. Click "New invite" to create one.
        </p>
      ) : (
        <ul className="divide-y divide-line border border-line rounded-md bg-bg-2 overflow-hidden">
          {invites.map((inv) => (
            <li key={inv.code} className="flex items-center gap-3 px-3 py-2.5">
              <code className="text-sm text-ink-1 font-mono flex-1 truncate">{inv.code}</code>
              <span className="text-xs text-ink-3 shrink-0">
                {inv.uses} use{inv.uses === 1 ? '' : 's'}
                {inv.maxUses != null ? ` / ${inv.maxUses}` : ''}
                {inv.expiresAt ? ` · ${formatExpiry(inv.expiresAt)}` : ''}
              </span>
              <button
                onClick={() => copyLink(inv.code)}
                className="w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
                aria-label="Copy invite link"
                title="Copy link"
              >
                <Copy size={14} />
              </button>
              <button
                onClick={() => revoke(inv.code)}
                className="w-8 h-8 flex items-center justify-center rounded text-ink-2 hover:text-red-400 hover:bg-bg-3"
                aria-label="Revoke invite"
                title="Revoke"
              >
                <Trash size={14} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function formatExpiry(iso: string): string {
  const d = new Date(iso);
  const ms = d.getTime() - Date.now();
  if (ms <= 0) return 'expired';
  const hrs = Math.round(ms / 3_600_000);
  if (hrs < 24) return `expires in ${hrs}h`;
  const days = Math.round(hrs / 24);
  return `expires in ${days}d`;
}

// ── Members tab (with role assignment) ──────────────────────────────────────

function MembersTab({ guild }: { guild: Guild }) {
  const { rest, user } = useAuth();
  const toasts = useToasts();
  const [rows, setRows] = useState<Array<GuildMember & { user?: PublicUser }> | null>(null);
  const [allRoles, setAllRoles] = useState<Role[] | null>(null);
  const [editingMemberId, setEditingMemberId] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const isOwner = !!user && user.id === guild.ownerId;

  async function refresh() {
    try {
      const [membersR, rolesR] = await Promise.all([
        rest.listMembers(guild.id, { limit: 100 }),
        rest.listRoles(guild.id),
      ]);
      setRows(membersR.members);
      setAllRoles(rolesR.roles);
    } catch (e) {
      toasts.push(
        e instanceof ApiError ? e.message : 'Failed to load members',
        'error',
      );
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  if (rows === null || allRoles === null) {
    return <p className="text-sm text-ink-3">Loading members…</p>;
  }

  // Quick role lookup — `member.roleIds` is just snowflake strings; we
  // need the role row to render name + color in the pill UI.
  const rolesById = new Map<string, Role>(allRoles.map((r) => [r.id, r]));

  // Filter on display name OR username (case-insensitive). We don't
  // filter by role membership — could be a future enhancement, but
  // most "find this person" queries are name-based.
  const q = query.trim().toLowerCase();
  const filtered = q
    ? rows.filter((m) => {
        const text = `${m.user?.displayName ?? ''} ${m.user?.username ?? ''}`.toLowerCase();
        return text.includes(q);
      })
    : rows;

  return (
    <div className="space-y-3">
      {/* Search bar — sticky-feel with the magnifier icon, instant filter */}
      <div className="relative">
        <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3" />
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={`Search ${rows.length} member${rows.length === 1 ? '' : 's'}…`}
          className="w-full pl-9 pr-3 py-2 bg-bg-2 border border-line rounded-md text-sm text-ink-1"
        />
        {query && (
          <button
            onClick={() => setQuery('')}
            className="absolute right-2 top-1/2 -translate-y-1/2 w-6 h-6 flex items-center justify-center rounded text-ink-3 hover:text-ink-1 hover:bg-bg-3"
            aria-label="Clear search"
          >
            <X size={12} />
          </button>
        )}
      </div>

      {filtered.length === 0 ? (
        <p className="text-sm text-ink-3 text-center py-4">
          No members match "{query}".
        </p>
      ) : (
        <ul className="divide-y divide-line border border-line rounded-md bg-bg-2 overflow-visible">
          {filtered.map((m) => {
        // Filter out @everyone (its id === guild.id) from displayed roles
        // since every member implicitly has it; including it would clutter
        // the pill list with a redundant row.
        const memberRoles = (m.roleIds ?? [])
          .filter((rid) => rid !== guild.id)
          .map((rid) => rolesById.get(rid))
          .filter((r): r is Role => r !== undefined);
        const isMemberOwner = m.userId === guild.ownerId;
        return (
          <li key={m.userId} className="flex items-center gap-3 px-3 py-2.5">
            <div className={`relative w-8 h-8 rounded-full text-xs flex items-center justify-center font-semibold shrink-0 overflow-hidden ${avatarColor(m.userId)}`}>
              <span aria-hidden="true">{avatarInitials(m.user?.displayName ?? m.user?.username)}</span>
              <AvatarImage src={m.user?.avatarUrl} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-sm text-ink-1 truncate">
                {m.user?.displayName ?? m.user?.username ?? m.userId}
              </div>
              <div className="text-xs text-ink-3 truncate">
                @{m.user?.username ?? '—'}
              </div>
              {/* Role pills — only the role chips, no editing here. The
                  edit pencil opens the inline picker below. */}
              {memberRoles.length > 0 && (
                <div className="mt-1 flex flex-wrap gap-1">
                  {memberRoles.map((r) => (
                    <RolePill key={r.id} role={r} />
                  ))}
                </div>
              )}
            </div>
            {isMemberOwner && (
              <span className="text-xs text-amber-400 shrink-0" title="Server owner">
                owner
              </span>
            )}
            {/* The owner can edit anyone's roles. Non-owner admins also
                can per the API's permission gate, but in practice we
                only show the edit affordance to the owner here for
                simplicity — the server still enforces it correctly. */}
            {isOwner && !isMemberOwner && (
              <div className="relative shrink-0">
                <button
                  onClick={() =>
                    setEditingMemberId(editingMemberId === m.userId ? null : m.userId)
                  }
                  className="text-xs px-2 py-1 rounded text-ink-2 hover:text-ink-1 hover:bg-bg-3"
                >
                  {editingMemberId === m.userId ? 'Done' : 'Edit roles'}
                </button>

                {/* Role picker — a popup anchored just below the button. */}
                {editingMemberId === m.userId && (
                  <RolePickerInline
                    guildId={guild.id}
                    userId={m.userId}
                    memberName={m.user?.displayName ?? m.user?.username ?? m.userId}
                    allRoles={allRoles.filter((r) => r.id !== guild.id)}
                    currentRoleIds={(m.roleIds ?? []).filter((rid) => rid !== guild.id)}
                    onSaved={async () => {
                      // Refresh to pick up the canonical role set the server
                      // computed (same diff logic, but we want to be sure).
                      await refresh();
                      setEditingMemberId(null);
                    }}
                  />
                )}
              </div>
            )}
          </li>
        );
      })}
        </ul>
      )}
    </div>
  );
}

function RolePill({ role }: { role: Role }) {
  const color = role.color ? '#' + role.color.toString(16).padStart(6, '0') : '#99aab5';
  return (
    <span
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.65rem] font-medium"
      style={{
        color,
        backgroundColor: color + '22', // ~13% opacity
        borderColor: color + '55',
        borderWidth: 1,
        borderStyle: 'solid',
      }}
    >
      <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      <span>{role.name}</span>
    </span>
  );
}

function RolePickerInline({
  guildId,
  userId,
  memberName,
  allRoles,
  currentRoleIds,
  onSaved,
}: {
  guildId: string;
  userId: string;
  memberName: string;
  allRoles: Role[];
  currentRoleIds: string[];
  onSaved: () => void | Promise<void>;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [selected, setSelected] = useState<Set<string>>(new Set(currentRoleIds));
  const [saving, setSaving] = useState(false);

  function toggle(roleId: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  async function save() {
    setSaving(true);
    try {
      await rest.patchMember(guildId, userId, { roleIds: [...selected] });
      toasts.push('Roles updated', 'success');
      await onSaved();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Update failed', 'error');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="absolute right-0 top-full mt-1 z-20 w-72 max-w-[calc(100vw-2rem)] border border-line rounded-md bg-bg-1 elevation-pop p-3 space-y-2">
      <div className="text-xs uppercase tracking-wider text-ink-3 font-semibold truncate">
        Roles for {memberName}
      </div>
      {allRoles.length === 0 ? (
        <p className="text-xs text-ink-3 py-2">
          No roles to assign. Create some in the Roles tab first.
        </p>
      ) : (
        <ul className="max-h-40 overflow-y-auto scrollbar-thin space-y-0.5">
          {allRoles.map((r) => {
            const checked = selected.has(r.id);
            return (
              <li key={r.id}>
                <label className="flex items-center gap-2 px-2 py-1 rounded hover:bg-bg-2 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => toggle(r.id)}
                    className="shrink-0"
                  />
                  <RolePill role={r} />
                </label>
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button
          onClick={() => void save()}
          disabled={saving}
          className="px-3 py-1 rounded-md bg-accent text-white text-xs font-medium disabled:opacity-50"
        >
          {saving ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}

// ── Danger zone ──────────────────────────────────────────────────────────────

function DangerTab({ guild, onClose }: { guild: Guild; onClose: () => void }) {
  const { rest } = useAuth();
  const { refreshGuilds } = useAppState();
  const toasts = useToasts();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState('');
  const [working, setWorking] = useState(false);
  const ready = confirm === guild.name;

  async function destroy() {
    if (!ready || working) return;
    setWorking(true);
    try {
      await rest.deleteGuild(guild.id);
      await refreshGuilds();
      toasts.push('Server deleted', 'success');
      onClose();
      navigate('/channels/@me');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    } finally {
      setWorking(false);
    }
  }

  return (
    <div className="space-y-5">
      <div className="border border-red-500/30 bg-red-500/5 rounded-md p-4">
        <h3 className="text-sm font-semibold text-red-400 mb-1">Delete server</h3>
        <p className="text-xs text-ink-2 mb-3">
          Permanently removes the server, every channel, every message, and every membership.
          This cannot be undone.
        </p>
        <Field label={`Type "${guild.name}" to confirm`}>
          <input
            type="text"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            className="w-full px-3 py-2 bg-bg-1 border border-line rounded-md text-sm text-ink-1"
          />
        </Field>
        <div className="mt-3 flex justify-end">
          <button
            onClick={destroy}
            disabled={!ready || working}
            className="px-4 py-2 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-40 disabled:hover:bg-red-600"
          >
            {working ? 'Deleting…' : 'Delete this server'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Backup & Restore tab
// ─────────────────────────────────────────────────────────────────────────
//
// Export downloads the server's configuration (settings, roles, the channel
// tree, role-level permission overrides) plus its icon and banner as a
// single self-contained JSON file. Restore rebuilds a saved backup as a
// BRAND-NEW server owned by you — it never touches the current one, so it's
// safe to run anytime. Messages, members, and invites are not part of a
// backup (it's a config + branding snapshot, not a full data dump).

function BackupTab({ guild, onClose }: { guild: Guild; onClose: () => void }) {
  const { rest } = useAuth();
  const { refreshGuilds } = useAppState();
  const toasts = useToasts();
  const navigate = useNavigate();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [exporting, setExporting] = useState<null | 'backup' | 'template'>(null);
  const [restoring, setRestoring] = useState(false);

  async function exportBackup(asTemplate: boolean) {
    if (exporting) return;
    setExporting(asTemplate ? 'template' : 'backup');
    try {
      const data = await rest.exportGuild(guild.id);
      // A template is a backup with the branding stripped — a shareable
      // starter rather than a recovery snapshot. Drop the images so the
      // file is small and generic.
      if (asTemplate && data && typeof data === 'object') {
        (data as { images?: unknown }).images = { icon: null, banner: null };
      }
      const slug =
        guild.name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'server';
      const date = new Date().toISOString().slice(0, 10);
      const kind = asTemplate ? 'template' : 'backup';
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `zekktris-${kind}-${slug}-${date}.json`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toasts.push(asTemplate ? 'Template downloaded' : 'Backup downloaded', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Export failed', 'error');
    } finally {
      setExporting(null);
    }
  }

  async function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    // Reset the input so picking the same file again re-fires onChange.
    e.target.value = '';
    if (!file || restoring) return;
    setRestoring(true);
    try {
      const text = await file.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new Error('That file isn’t valid JSON');
      }
      const res = await rest.importGuild(parsed);
      await refreshGuilds();
      toasts.push(`Restored as “${res.guild.name}”`, 'success');
      onClose();
      navigate(
        res.defaultChannelId
          ? `/channels/${res.guild.id}/${res.defaultChannelId}`
          : `/channels/${res.guild.id}`,
      );
    } catch (err) {
      toasts.push(
        err instanceof ApiError
          ? err.message
          : err instanceof Error
            ? err.message
            : 'Restore failed',
        'error',
      );
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Export */}
      <div className="border border-line rounded-md p-4">
        <div className="flex items-center gap-2 mb-1">
          <Download className="w-4 h-4 text-ink-2" />
          <h3 className="text-sm font-semibold text-ink-1">Export</h3>
        </div>
        <p className="text-xs text-ink-2 mb-3">
          A <span className="text-ink-1 font-medium">backup</span> captures this server’s settings,
          roles, channels, and permission overrides — plus the icon and banner — as a single JSON
          file you can keep to rebuild the server if anything happens. A{' '}
          <span className="text-ink-1 font-medium">template</span> is the same thing without the
          images: a lightweight, shareable starter others can spin a new server up from. Messages and
          members are never included.
        </p>
        <div className="flex flex-wrap justify-end gap-2">
          <button
            onClick={() => void exportBackup(true)}
            disabled={exporting !== null}
            className="px-4 py-2 rounded-md bg-bg-1 border border-line hover:border-accent text-ink-1 text-sm font-medium disabled:opacity-40"
          >
            {exporting === 'template' ? 'Preparing…' : 'Download as template'}
          </button>
          <button
            onClick={() => void exportBackup(false)}
            disabled={exporting !== null}
            className="px-4 py-2 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium disabled:opacity-40"
          >
            {exporting === 'backup' ? 'Preparing…' : 'Download backup'}
          </button>
        </div>
      </div>

      {/* Restore */}
      <div className="border border-line rounded-md p-4">
        <div className="flex items-center gap-2 mb-1">
          <Upload className="w-4 h-4 text-ink-2" />
          <h3 className="text-sm font-semibold text-ink-1">Restore from a backup or template</h3>
        </div>
        <p className="text-xs text-ink-2 mb-3">
          Rebuilds a backup or template file as a{' '}
          <span className="text-ink-1 font-medium">brand-new server</span> that you’ll own. Your
          current server is left completely untouched, so this is safe to run anytime — it’s the way
          to recover after a server is lost, or to start fresh from a template.
        </p>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          onChange={onFile}
          className="hidden"
        />
        <div className="flex justify-end">
          <button
            onClick={() => fileRef.current?.click()}
            disabled={restoring}
            className="px-4 py-2 rounded-md bg-bg-1 border border-line hover:border-accent text-ink-1 text-sm font-medium disabled:opacity-40"
          >
            {restoring ? 'Restoring…' : 'Choose a file…'}
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Tiny field wrapper ───────────────────────────────────────────────────────

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="text-xs uppercase tracking-wider text-ink-3 font-semibold">{label}</span>
      {children}
      {hint && <span className="block text-xs text-ink-3 mt-1">{hint}</span>}
    </label>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Bans tab
// ─────────────────────────────────────────────────────────────────────────
//
// Lists everyone currently banned from the guild plus a small unban
// action per row. Banning is performed elsewhere — from the kebab/
// action menu on a member row in MembersTab and from the moderation
// section of ProfileCard. Putting the BAN action in the Bans tab
// itself would mean either (a) duplicating the member picker or
// (b) requiring a username typed by hand; both are worse UX than
// surfacing Ban next to the existing Kick action where moderators
// already are.

function BansTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [bans, setBans] = useState<GuildBan[] | null>(null);
  const [filter, setFilter] = useState('');
  const [unbanning, setUnbanning] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const r = await rest.listBans(guild.id);
      setBans(r.bans);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load bans');
      setBans([]);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  async function unban(b: GuildBan) {
    if (unbanning) return;
    setUnbanning(b.user.id);
    try {
      await rest.unbanMember(guild.id, b.user.id);
      // Optimistic local removal so the UI updates immediately. If the
      // round-trip fails we put the row back; toast tells the user.
      setBans((prev) => prev?.filter((x) => x.user.id !== b.user.id) ?? prev);
      toasts.push(`Unbanned ${b.user.displayName}`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Unban failed', 'error');
    } finally {
      setUnbanning(null);
    }
  }

  const filtered = useMemo(() => {
    if (!bans) return null;
    const q = filter.trim().toLowerCase();
    if (!q) return bans;
    return bans.filter(
      (b) =>
        b.user.username.toLowerCase().includes(q) ||
        b.user.displayName.toLowerCase().includes(q) ||
        (b.reason ?? '').toLowerCase().includes(q),
    );
  }, [bans, filter]);

  if (bans === null) {
    return <p className="text-sm text-ink-3">Loading bans…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-300">{error}</p>;
  }

  return (
    <div className="space-y-3">
      {/* Header copy — short explainer of what bans do, distinguishing
          them from kicks. Users routinely conflate the two. */}
      <p className="text-xs text-ink-3 leading-relaxed">
        Banned users are removed from the server and prevented from re-joining
        via any invite. Lift a ban with Unban; the user can then accept an
        invite again normally.
      </p>

      {bans.length > 0 && (
        <div className="relative">
          <Search size={14} className="absolute left-3 top-1/2 -translate-y-1/2 text-ink-3 pointer-events-none" />
          <input
            type="text"
            placeholder={`Search ${bans.length} banned user${bans.length === 1 ? '' : 's'}…`}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="w-full pl-9 pr-3 py-2 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
          />
        </div>
      )}

      {filtered && filtered.length === 0 ? (
        bans.length === 0 ? (
          <div className="bg-bg-2 border border-line rounded-md py-12 px-6 text-center">
            <BanIcon size={28} className="text-ink-3 mx-auto mb-2" />
            <p className="text-sm text-ink-2">No one is banned from this server.</p>
            <p className="text-xs text-ink-3 mt-1">
              Bans show up here once you ban a member from the Members tab or
              their profile.
            </p>
          </div>
        ) : (
          <p className="text-sm text-ink-3 text-center py-8">
            No bans match your search.
          </p>
        )
      ) : (
        <ul className="border border-line rounded-md divide-y divide-line bg-bg-2 overflow-hidden">
          {filtered!.map((b) => (
            <BanRow
              key={b.user.id}
              ban={b}
              busy={unbanning === b.user.id}
              onUnban={() => void unban(b)}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function BanRow({
  ban,
  busy,
  onUnban,
}: {
  ban: GuildBan;
  busy: boolean;
  onUnban: () => void;
}) {
  const initials = avatarInitials(ban.user.displayName);
  const tone = avatarColor(ban.user.id);
  const created = new Date(ban.createdAt);
  const dateLabel = created.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  return (
    <li className="flex items-center gap-3 px-3 py-3">
      <div className={`relative w-9 h-9 rounded-full text-xs flex items-center justify-center font-semibold shrink-0 overflow-hidden ${tone}`}>
        <span aria-hidden="true">{initials}</span>
        <AvatarImage src={ban.user.avatarUrl} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 min-w-0">
          <span className="text-sm text-ink-1 truncate">{ban.user.displayName}</span>
          <span className="text-xs text-ink-3 truncate">@{ban.user.username}</span>
        </div>
        {ban.reason ? (
          <p className="text-xs text-ink-2 mt-0.5 line-clamp-2">{ban.reason}</p>
        ) : (
          <p className="text-xs text-ink-3 italic mt-0.5">No reason recorded</p>
        )}
        <p className="text-[0.65rem] text-ink-3 mt-0.5">Banned {dateLabel}</p>
      </div>
      <button
        type="button"
        onClick={onUnban}
        disabled={busy}
        className="shrink-0 px-3 py-1.5 rounded-md text-xs font-medium bg-bg-3 hover:bg-bg-3/80 text-ink-1 disabled:opacity-60 disabled:cursor-wait transition-colors"
      >
        {busy ? 'Unbanning…' : 'Unban'}
      </button>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Automod tab
// ─────────────────────────────────────────────────────────────────────────
//
// Per-guild moderation rules. All CRUD requires MANAGE_GUILD which the
// server enforces; the adminOnly tab gate keeps non-admins from even
// seeing the panel.
//
// v1 enforces word_blocklist only. repeat_message and mention_spam can
// be CREATED through the UI (server stores them fine) but the
// enforcement is a no-op; we label them "Coming soon" so admins know
// not to rely on them yet.

const TIMEOUT_PRESETS: { label: string; seconds: number }[] = [
  { label: '60s', seconds: 60 },
  { label: '5m', seconds: 5 * 60 },
  { label: '10m', seconds: 10 * 60 },
  { label: '1h', seconds: 60 * 60 },
  { label: '1d', seconds: 24 * 60 * 60 },
  { label: '1w', seconds: 7 * 24 * 60 * 60 },
];

const RULE_TYPE_META: Record<
  AutomodRule['ruleType'],
  { label: string; description: string; enforced: boolean }
> = {
  word_blocklist: {
    label: 'Word blocklist',
    description: 'Reject messages containing any listed phrase. Case-insensitive, word-boundary matched.',
    enforced: true,
  },
  regex_pattern: {
    label: 'Regex pattern',
    description:
      'Reject messages matching any of the supplied regular expressions. Patterns are case-insensitive by default; use inline flags like (?-i) to override. Invalid regex is silently skipped.',
    enforced: true,
  },
  link_filter: {
    label: 'Link filter',
    description:
      'Block links to listed domains, or use the special pattern "zk:invite" to block all Zekktris invite links. Subdomains of listed domains also match.',
    enforced: true,
  },
  repeat_message: {
    label: 'Repeat-message detection',
    description: 'Reject when a user sends the same content N times within a time window.',
    enforced: true,
  },
  mention_spam: {
    label: 'Mention spam',
    description: 'Reject messages with too many @user / @role / @everyone mentions.',
    enforced: true,
  },
};

function formatDurationSeconds(seconds: number | null): string {
  if (seconds == null) return '';
  const match = TIMEOUT_PRESETS.find((p) => p.seconds === seconds);
  if (match) return match.label;
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function AutomodTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [rules, setRules] = useState<AutomodRule[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Editing state: null = closed; { mode: 'create' } = new-rule form;
  // { mode: 'edit', id } = editing existing rule. One open at a time.
  const [editing, setEditing] = useState<
    | { mode: 'create' }
    | { mode: 'edit'; id: string }
    | null
  >(null);

  async function refresh() {
    setError(null);
    try {
      const r = await rest.listAutomodRules(guild.id);
      setRules(r.rules);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load rules');
      setRules([]);
    }
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id]);

  async function handleToggle(rule: AutomodRule) {
    // Optimistic flip — the server respects partial PATCH, so we
    // can send just the one field. Reverts on failure with a toast.
    const next = !rule.enabled;
    setRules((prev) =>
      prev ? prev.map((r) => (r.id === rule.id ? { ...r, enabled: next } : r)) : prev,
    );
    try {
      await rest.updateAutomodRule(guild.id, rule.id, { enabled: next });
    } catch (e) {
      setRules((prev) =>
        prev ? prev.map((r) => (r.id === rule.id ? { ...r, enabled: rule.enabled } : r)) : prev,
      );
      toasts.push(e instanceof ApiError ? e.message : 'Toggle failed', 'error');
    }
  }

  async function handleDelete(rule: AutomodRule) {
    if (!confirm(`Delete the rule "${rule.name}"? This can't be undone.`)) return;
    // Optimistic remove. Failure restores the row.
    setRules((prev) => prev?.filter((r) => r.id !== rule.id) ?? prev);
    try {
      await rest.deleteAutomodRule(guild.id, rule.id);
      toasts.push(`Deleted "${rule.name}"`, 'success');
    } catch (e) {
      // Restore by reloading rather than tracking the index — the
      // refresh is cheap and avoids ordering bugs if the user has
      // sorted/filtered in the meantime.
      void refresh();
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
    }
  }

  if (rules === null) {
    return <p className="text-sm text-ink-3">Loading automod rules…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-300">{error}</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-3 leading-relaxed">
        AutoMod rules run on every message sent in this server. Matching messages are blocked,
        and the sender can optionally be timed out automatically. Members with an exempt role
        bypass the rule. Only word-blocklist rules are currently enforced — repeat-message and
        mention-spam are coming soon.
      </p>

      {rules.length === 0 && !editing && (
        <div className="rounded-md border border-line bg-bg-2/50 px-4 py-6 text-center">
          <p className="text-sm text-ink-2 mb-2">No rules yet.</p>
          <p className="text-xs text-ink-3">
            Add a rule to block content that doesn't belong in this server.
          </p>
        </div>
      )}

      <ul className="space-y-2">
        {rules.map((rule) => (
          <AutomodRuleRow
            key={rule.id}
            rule={rule}
            isEditing={editing?.mode === 'edit' && editing.id === rule.id}
            onEditStart={() => setEditing({ mode: 'edit', id: rule.id })}
            onEditCancel={() => setEditing(null)}
            onToggle={() => void handleToggle(rule)}
            onDelete={() => void handleDelete(rule)}
            onSaved={(updated) => {
              setRules((prev) =>
                prev ? prev.map((r) => (r.id === updated.id ? updated : r)) : prev,
              );
              setEditing(null);
              toasts.push(`Updated "${updated.name}"`, 'success');
            }}
            guildId={guild.id}
          />
        ))}
      </ul>

      {editing?.mode === 'create' ? (
        <AutomodRuleForm
          guildId={guild.id}
          onCancel={() => setEditing(null)}
          onSaved={(created) => {
            setRules((prev) => (prev ? [...prev, created] : [created]));
            setEditing(null);
            toasts.push(`Created "${created.name}"`, 'success');
          }}
        />
      ) : (
        <button
          onClick={() => setEditing({ mode: 'create' })}
          className="w-full px-3 py-2 rounded-md border border-line border-dashed hover:bg-bg-2 text-sm text-ink-2 flex items-center justify-center gap-2 transition-colors"
        >
          <Plus size={14} />
          <span>Add rule</span>
        </button>
      )}

      <RecentAutomodActivity guild={guild} rules={rules ?? []} />
    </div>
  );
}

/**
 * Inline panel inside AutomodTab showing the last ~20 automod hits.
 * Reads from the existing audit-log endpoint with actionPrefix='automod.'
 * Requires VIEW_AUDIT_LOG — degrades gracefully (hidden with an
 * explanatory note) when the admin has MANAGE_GUILD but not
 * VIEW_AUDIT_LOG, so we don't 403-spam the console.
 */
function RecentAutomodActivity({
  guild,
  rules,
}: {
  guild: Guild;
  rules: AutomodRule[];
}) {
  const { rest } = useAuth();
  const [entries, setEntries] = useState<AuditLogEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Map of rule id → rule for fast lookup when rendering each hit
  // (each row stamps the rule name from the audit changes blob, but
  // we also want to know whether the rule still exists / is enabled).
  const rulesById = useMemo(() => {
    const m = new Map<string, AutomodRule>();
    for (const r of rules) m.set(r.id, r);
    return m;
  }, [rules]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const r = await rest.listAuditLog(guild.id, {
          actionPrefix: 'automod.',
          limit: 20,
        });
        if (cancelled) return;
        // Filter to ONLY rule_triggered events. The audit log also
        // contains rule_create / rule_update / rule_delete entries
        // under the same prefix; those are noise for an "activity"
        // view (the user just edited the rule, they don't need to
        // see their own action listed).
        setEntries(
          r.entries.filter((e) => e.action === 'automod.rule_triggered'),
        );
      } catch (e) {
        if (cancelled) return;
        // 403 = no VIEW_AUDIT_LOG. Treat as "panel unavailable"
        // rather than a hard error.
        const msg = e instanceof ApiError ? e.message : 'Could not load activity';
        setError(msg);
        setEntries([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rest, guild.id]);

  if (entries === null) {
    return (
      <div className="mt-6 pt-4 border-t border-line">
        <h4 className="text-sm font-semibold text-ink-1 mb-2">
          Recent activity
        </h4>
        <p className="text-xs text-ink-3 italic">Loading…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-6 pt-4 border-t border-line">
        <h4 className="text-sm font-semibold text-ink-1 mb-2">
          Recent activity
        </h4>
        <p className="text-xs text-ink-3 italic">
          {error.toLowerCase().includes('permission') ||
          error.toLowerCase().includes('forbidden')
            ? 'You need the View Audit Log permission to see automod activity.'
            : error}
        </p>
      </div>
    );
  }

  return (
    <div className="mt-6 pt-4 border-t border-line">
      <h4 className="text-sm font-semibold text-ink-1 mb-1">
        Recent activity
      </h4>
      <p className="text-xs text-ink-3 mb-3">
        The last 20 times any rule fired in this server.
      </p>
      {entries.length === 0 ? (
        <p className="text-xs text-ink-3 italic">
          No automod hits yet. Once a rule fires, the trigger will appear here.
        </p>
      ) : (
        <ul className="space-y-1.5">
          {entries.map((entry) => {
            const changes = (entry.changes ?? {}) as Record<string, unknown>;
            const ruleName =
              typeof changes.ruleName === 'string'
                ? changes.ruleName
                : '(deleted rule)';
            const ruleType =
              typeof changes.ruleType === 'string' ? changes.ruleType : null;
            const snippet =
              typeof changes.snippet === 'string' ? changes.snippet : '';
            const action =
              typeof changes.action === 'string' ? changes.action : null;
            const timeoutApplied = changes.timeoutApplied === true;
            const actorName =
              entry.actor?.displayName ||
              entry.actor?.username ||
              '(deleted user)';
            const rule = entry.targetId
              ? rulesById.get(entry.targetId)
              : undefined;
            const enabled = rule?.enabled ?? false;
            const ts = new Date(entry.createdAt);
            return (
              <li
                key={entry.id}
                className="rounded border border-line bg-bg-2/40 px-2.5 py-2 text-xs"
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="font-semibold text-ink-1">{actorName}</span>
                  <span className="text-ink-3">tripped</span>
                  <span className="text-ink-1">"{ruleName}"</span>
                  {ruleType && (
                    <span className="text-ink-3">({ruleType})</span>
                  )}
                  {action === 'log_only' && (
                    <span className="px-1.5 py-0.5 rounded bg-bg-3 text-ink-2 text-[0.65rem] uppercase tracking-wide">
                      logged
                    </span>
                  )}
                  {timeoutApplied && (
                    <span className="px-1.5 py-0.5 rounded bg-amber-900/40 text-amber-200 text-[0.65rem] uppercase tracking-wide">
                      timeout
                    </span>
                  )}
                  {rule && !enabled && (
                    <span className="px-1.5 py-0.5 rounded bg-bg-3 text-ink-3 text-[0.65rem] uppercase tracking-wide">
                      rule disabled
                    </span>
                  )}
                  <span className="ml-auto text-ink-3" title={ts.toISOString()}>
                    {ts.toLocaleString(undefined, {
                      month: 'short',
                      day: 'numeric',
                      hour: 'numeric',
                      minute: '2-digit',
                    })}
                  </span>
                </div>
                {snippet && (
                  <div className="mt-1 text-ink-2 line-clamp-2 break-words">
                    "{snippet}"
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function AutomodRuleRow({
  rule,
  isEditing,
  onEditStart,
  onEditCancel,
  onToggle,
  onDelete,
  onSaved,
  guildId,
}: {
  rule: AutomodRule;
  isEditing: boolean;
  onEditStart: () => void;
  onEditCancel: () => void;
  onToggle: () => void;
  onDelete: () => void;
  onSaved: (updated: AutomodRule) => void;
  guildId: string;
}) {
  const meta = RULE_TYPE_META[rule.ruleType];
  return (
    <li className="rounded-md border border-line bg-bg-2/40">
      <div className="px-3 py-2 flex items-center gap-3">
        <button
          onClick={onToggle}
          className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${
            rule.enabled ? 'bg-emerald-700/60' : 'bg-bg-3'
          }`}
          aria-label={rule.enabled ? 'Disable rule' : 'Enable rule'}
          title={rule.enabled ? 'Disable rule' : 'Enable rule'}
        >
          <span
            className={`absolute top-0.5 w-4 h-4 rounded-full bg-ink-1 transition-transform ${
              rule.enabled ? 'translate-x-[18px]' : 'translate-x-0.5'
            }`}
          />
        </button>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className={`text-sm font-medium ${rule.enabled ? 'text-ink-1' : 'text-ink-3'} truncate`}>
              {rule.name}
            </span>
            {!meta.enforced && (
              <span className="px-1.5 py-0.5 rounded-sm bg-amber-900/40 text-amber-300 text-[0.6rem] uppercase tracking-wider shrink-0">
                Coming soon
              </span>
            )}
          </div>
          <div className="text-xs text-ink-3 truncate">
            {meta.label}
            {rule.ruleType === 'word_blocklist' && (
              <> · {rule.patterns.length} pattern{rule.patterns.length === 1 ? '' : 's'}</>
            )}
            {rule.ruleType === 'mention_spam' && rule.threshold && (
              <> · ≥ {rule.threshold} mentions</>
            )}
            {rule.ruleType === 'repeat_message' && rule.threshold && rule.windowSeconds && (
              <> · ≥ {rule.threshold} identical / {rule.windowSeconds}s</>
            )}
            {rule.action === 'block_and_timeout' && rule.timeoutSeconds
              ? ` · block + ${formatDurationSeconds(rule.timeoutSeconds)} timeout`
              : ' · block'}
          </div>
        </div>
        {!isEditing && (
          <div className="flex items-center gap-1 shrink-0">
            <button
              onClick={onEditStart}
              className="px-2 py-1 rounded text-xs text-ink-2 hover:bg-bg-3 transition-colors"
            >
              Edit
            </button>
            <button
              onClick={onDelete}
              className="px-2 py-1 rounded text-xs text-red-400 hover:bg-red-950/40 transition-colors"
              title="Delete rule"
              aria-label="Delete rule"
            >
              <Trash size={14} />
            </button>
          </div>
        )}
      </div>
      {isEditing && (
        <div className="border-t border-line px-3 py-3 bg-bg-2/30">
          <AutomodRuleForm
            guildId={guildId}
            rule={rule}
            onCancel={onEditCancel}
            onSaved={onSaved}
          />
        </div>
      )}
    </li>
  );
}

function AutomodRuleForm({
  guildId,
  rule,
  onCancel,
  onSaved,
}: {
  guildId: string;
  /** When present, the form is in edit mode against this rule. */
  rule?: AutomodRule;
  onCancel: () => void;
  onSaved: (rule: AutomodRule) => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const { state } = useAppState();

  const [name, setName] = useState(rule?.name ?? '');
  const [ruleType, setRuleType] = useState<AutomodRule['ruleType']>(
    rule?.ruleType ?? 'word_blocklist',
  );
  const [patterns, setPatterns] = useState<string[]>(rule?.patterns ?? []);
  const [patternDraft, setPatternDraft] = useState('');
  const [action, setAction] = useState<AutomodRule['action']>(rule?.action ?? 'block');
  const [timeoutSeconds, setTimeoutSeconds] = useState<number>(
    rule?.timeoutSeconds ?? 600,
  );
  // Threshold — used by mention_spam (and reserved for repeat_message
  // when that rule type ships). Default to 5: reasonable for a busy
  // guild where occasional @user mentions are normal but @-everyone
  // plus 4 user pings reads as spam.
  const [threshold, setThreshold] = useState<number>(rule?.threshold ?? 5);
  // Window for repeat_message. 30 seconds is a reasonable default:
  // catches copy-paste spam without being so long it flags casual
  // repetition over the course of a conversation.
  const [windowSeconds, setWindowSeconds] = useState<number>(rule?.windowSeconds ?? 30);
  // Exempt roles as a Set — toggle semantics (.add / .delete / .has)
  // map directly to how the picker UI thinks about role membership.
  const [exemptRoleIds, setExemptRoleIds] = useState<Set<string>>(
    () => new Set(rule?.exemptRoleIds ?? []),
  );
  // Exempt channels — same Set semantics. When non-empty, the rule
  // is skipped in those channels (e.g. allow profanity in
  // #shitposting while blocking it everywhere else).
  const [exemptChannelIds, setExemptChannelIds] = useState<Set<string>>(
    () => new Set(rule?.exemptChannelIds ?? []),
  );
  const [busy, setBusy] = useState(false);

  // Roles available for exemption. @everyone (id === guildId) is
  // filtered out — exempting @everyone would mean nobody trips the
  // rule, which is incoherent with "I want this rule to apply by
  // default."
  const guildRoles = state.rolesByGuild[guildId] ?? null;
  const exemptableRoles = useMemo(() => {
    if (!guildRoles) return null;
    return guildRoles
      .filter((r) => r.id !== guildId)
      .slice()
      .sort((a, b) => b.position - a.position);
  }, [guildRoles, guildId]);

  function addPattern() {
    const trimmed = patternDraft.trim();
    if (!trimmed) return;
    if (patterns.length >= 100) {
      toasts.push('Pattern limit reached (100 per rule)', 'error');
      return;
    }
    if (patterns.includes(trimmed)) {
      setPatternDraft('');
      return;
    }
    setPatterns([...patterns, trimmed]);
    setPatternDraft('');
  }

  function removePattern(idx: number) {
    setPatterns(patterns.filter((_, i) => i !== idx));
  }

  function toggleExemptRole(roleId: string) {
    setExemptRoleIds((prev) => {
      const next = new Set(prev);
      if (next.has(roleId)) next.delete(roleId);
      else next.add(roleId);
      return next;
    });
  }

  function toggleExemptChannel(channelId: string) {
    setExemptChannelIds((prev) => {
      const next = new Set(prev);
      if (next.has(channelId)) next.delete(channelId);
      else next.add(channelId);
      return next;
    });
  }

  async function handleSubmit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      toasts.push('Name is required', 'error');
      return;
    }
    if (action === 'block_and_timeout' && (!timeoutSeconds || timeoutSeconds <= 0)) {
      toasts.push('Pick a timeout duration', 'error');
      return;
    }
    const exemptArray = Array.from(exemptRoleIds);
    const exemptChannelsArray = Array.from(exemptChannelIds);

    setBusy(true);
    try {
      // Threshold/window submission map:
      //   word_blocklist : neither (null on PATCH, undefined on POST)
      //   regex_pattern  : neither
      //   link_filter    : neither
      //   mention_spam   : threshold only
      //   repeat_message : both threshold and windowSeconds
      const sendThreshold =
        ruleType === 'mention_spam' || ruleType === 'repeat_message';
      const sendWindow = ruleType === 'repeat_message';

      if (rule) {
        const r = await rest.updateAutomodRule(guildId, rule.id, {
          name: trimmedName,
          patterns,
          threshold: sendThreshold ? threshold : null,
          windowSeconds: sendWindow ? windowSeconds : null,
          action,
          timeoutSeconds: action === 'block_and_timeout' ? timeoutSeconds : null,
          exemptRoleIds: exemptArray,
          exemptChannelIds: exemptChannelsArray,
        });
        onSaved(r.rule);
      } else {
        const r = await rest.createAutomodRule(guildId, {
          name: trimmedName,
          ruleType,
          patterns,
          threshold: sendThreshold ? threshold : undefined,
          windowSeconds: sendWindow ? windowSeconds : undefined,
          action,
          timeoutSeconds: action === 'block_and_timeout' ? timeoutSeconds : undefined,
          exemptRoleIds: exemptArray,
          exemptChannelIds: exemptChannelsArray,
        });
        onSaved(r.rule);
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Save failed', 'error');
      setBusy(false);
    }
  }

  const isEdit = !!rule;
  const ruleTypeLocked = isEdit;
  const showPatterns = ruleType === 'word_blocklist';
  const showThreshold = ruleType === 'mention_spam' || ruleType === 'repeat_message';
  const showWindow = ruleType === 'repeat_message';

  return (
    <div className="space-y-3">
      <Field label="Name">
        <input
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          placeholder="e.g. No slurs"
          className="w-full px-3 py-1.5 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
        />
      </Field>

      <Field label="Rule type">
        <div className="space-y-1.5">
          {(Object.keys(RULE_TYPE_META) as AutomodRule['ruleType'][]).map((t) => {
            const m = RULE_TYPE_META[t];
            return (
              <label
                key={t}
                className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer ${
                  ruleType === t ? 'bg-bg-3' : 'hover:bg-bg-3/50'
                } ${ruleTypeLocked && ruleType !== t ? 'opacity-50 cursor-not-allowed' : ''}`}
              >
                <input
                  type="radio"
                  name="ruleType"
                  value={t}
                  checked={ruleType === t}
                  disabled={ruleTypeLocked}
                  onChange={() => setRuleType(t)}
                  className="mt-1"
                />
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-ink-1 flex items-center gap-2">
                    {m.label}
                    {!m.enforced && (
                      <span className="px-1.5 py-0.5 rounded-sm bg-amber-900/40 text-amber-300 text-[0.6rem] uppercase tracking-wider">
                        Coming soon
                      </span>
                    )}
                  </div>
                  <div className="text-xs text-ink-3 mt-0.5">{m.description}</div>
                </div>
              </label>
            );
          })}
        </div>
        {ruleTypeLocked && (
          <p className="text-xs text-ink-3 mt-1">
            Rule type can't be changed after creation. Delete and recreate to change.
          </p>
        )}
      </Field>

      {showPatterns && (
        <Field label="Patterns" hint="Press Enter to add. Word-boundary, case-insensitive.">
          <div className="space-y-2">
            <div className="flex flex-wrap gap-1.5">
              {patterns.map((p, i) => (
                <span
                  key={`${p}-${i}`}
                  className="inline-flex items-center gap-1 px-2 py-1 rounded bg-bg-3 text-xs"
                >
                  <span className="text-ink-1">{p}</span>
                  <button
                    onClick={() => removePattern(i)}
                    className="text-ink-3 hover:text-red-400 transition-colors"
                    aria-label={`Remove ${p}`}
                  >
                    <X size={12} />
                  </button>
                </span>
              ))}
              {patterns.length === 0 && (
                <span className="text-xs text-ink-3 italic">No patterns yet — add one below.</span>
              )}
            </div>
            <input
              type="text"
              value={patternDraft}
              onChange={(e) => setPatternDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  addPattern();
                }
              }}
              maxLength={200}
              placeholder="Add a phrase…"
              className="w-full px-3 py-1.5 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
            />
          </div>
        </Field>
      )}

      {showThreshold && (
        <Field
          label={ruleType === 'mention_spam' ? 'Mention threshold' : 'Repeat threshold'}
          hint={
            ruleType === 'mention_spam'
              ? 'Trigger when a message has at least this many @user, @role, or @everyone/@here mentions.'
              : 'Trigger when this many identical messages are sent within the window below.'
          }
        >
          <input
            type="number"
            min={1}
            max={50}
            value={threshold}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 1 && n <= 50) {
                setThreshold(n);
              }
            }}
            className="w-24 px-3 py-1.5 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
          />
        </Field>
      )}

      {showWindow && (
        <Field
          label="Time window (seconds)"
          hint="How recent the prior messages must be to count toward the threshold."
        >
          <input
            type="number"
            min={5}
            max={300}
            value={windowSeconds}
            onChange={(e) => {
              const n = parseInt(e.target.value, 10);
              if (Number.isFinite(n) && n >= 5 && n <= 300) {
                setWindowSeconds(n);
              }
            }}
            className="w-24 px-3 py-1.5 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-accent"
          />
        </Field>
      )}

      <Field label="Action">
        <div className="space-y-1.5">
          <label className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer ${action === 'block' ? 'bg-bg-3' : 'hover:bg-bg-3/50'}`}>
            <input
              type="radio"
              name="action"
              value="block"
              checked={action === 'block'}
              onChange={() => setAction('block')}
              className="mt-1"
            />
            <div>
              <div className="text-sm text-ink-1">Block message</div>
              <div className="text-xs text-ink-3 mt-0.5">Reject the send with a friendly error.</div>
            </div>
          </label>
          <label className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer ${action === 'block_and_timeout' ? 'bg-bg-3' : 'hover:bg-bg-3/50'}`}>
            <input
              type="radio"
              name="action"
              value="block_and_timeout"
              checked={action === 'block_and_timeout'}
              onChange={() => setAction('block_and_timeout')}
              className="mt-1"
            />
            <div>
              <div className="text-sm text-ink-1">Block + time out the sender</div>
              <div className="text-xs text-ink-3 mt-0.5">Also apply a timeout (max 28 days).</div>
            </div>
          </label>
          <label className={`flex items-start gap-2 px-2 py-1.5 rounded cursor-pointer ${action === 'log_only' ? 'bg-bg-3' : 'hover:bg-bg-3/50'}`}>
            <input
              type="radio"
              name="action"
              value="log_only"
              checked={action === 'log_only'}
              onChange={() => setAction('log_only')}
              className="mt-1"
            />
            <div>
              <div className="text-sm text-ink-1">Log only (observation mode)</div>
              <div className="text-xs text-ink-3 mt-0.5">
                Records the violation in the audit log but lets the message through.
                Useful for tuning a rule before flipping it to enforcement.
              </div>
            </div>
          </label>
        </div>
      </Field>

      {action === 'block_and_timeout' && (
        <Field label="Timeout duration">
          <div className="flex flex-wrap gap-1.5">
            {TIMEOUT_PRESETS.map((p) => (
              <button
                key={p.seconds}
                onClick={() => setTimeoutSeconds(p.seconds)}
                className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                  timeoutSeconds === p.seconds
                    ? 'bg-amber-900/50 text-amber-200'
                    : 'bg-bg-3 text-ink-2 hover:bg-bg-3/80'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </Field>
      )}

      <Field
        label="Exempt roles"
        hint={
          exemptRoleIds.size === 0
            ? 'All members are subject to this rule. Pick roles to exempt their holders.'
            : `${exemptRoleIds.size} role${exemptRoleIds.size === 1 ? '' : 's'} exempt — members with any of these bypass the rule.`
        }
      >
        {exemptableRoles === null ? (
          <p className="text-xs text-ink-3 italic">Loading roles…</p>
        ) : exemptableRoles.length === 0 ? (
          <p className="text-xs text-ink-3 italic">
            No roles to exempt — create some in the Roles tab first.
          </p>
        ) : (
          <div className="flex flex-wrap gap-1.5">
            {exemptableRoles.map((role) => {
              const selected = exemptRoleIds.has(role.id);
              // Colored left-border on the pill rather than fill —
              // keeps the role's color readable as a hint without
              // blowing out the modal's palette. When unset (color
              // 0), fall back to neutral border.
              const borderColor =
                role.color > 0
                  ? `#${role.color.toString(16).padStart(6, '0')}`
                  : undefined;
              return (
                <button
                  key={role.id}
                  type="button"
                  onClick={() => toggleExemptRole(role.id)}
                  className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                    selected
                      ? 'bg-bg-3 border-accent text-ink-1'
                      : 'bg-bg-2 border-line text-ink-2 hover:bg-bg-3/50'
                  }`}
                  style={borderColor ? { borderLeftColor: borderColor, borderLeftWidth: 3 } : undefined}
                  aria-pressed={selected}
                >
                  {selected && (
                    <span className="text-accent" aria-hidden>
                      ✓
                    </span>
                  )}
                  <span>{role.name}</span>
                </button>
              );
            })}
          </div>
        )}
      </Field>

      <Field
        label="Exempt channels"
        hint={
          exemptChannelIds.size === 0
            ? 'This rule applies in every text channel. Pick channels to skip enforcement in.'
            : `${exemptChannelIds.size} channel${exemptChannelIds.size === 1 ? '' : 's'} exempt — the rule won't fire in those.`
        }
      >
        {(() => {
          const channels = state.channelsByGuild[guildId] ?? [];
          const textChannels = channels.filter((c) => c.type === 'guild_text');
          if (textChannels.length === 0) {
            return (
              <p className="text-xs text-ink-3 italic">
                No channels to exempt.
              </p>
            );
          }
          return (
            <div className="flex flex-wrap gap-1.5">
              {textChannels.map((ch) => {
                const selected = exemptChannelIds.has(ch.id);
                return (
                  <button
                    key={ch.id}
                    type="button"
                    onClick={() => toggleExemptChannel(ch.id)}
                    className={`inline-flex items-center gap-1.5 px-2 py-1 rounded border text-xs transition-colors ${
                      selected
                        ? 'bg-bg-3 border-accent text-ink-1'
                        : 'bg-bg-2 border-line text-ink-2 hover:bg-bg-3/50'
                    }`}
                    aria-pressed={selected}
                  >
                    {selected && (
                      <span className="text-accent" aria-hidden>
                        ✓
                      </span>
                    )}
                    <span>#{ch.name ?? ch.id}</span>
                  </button>
                );
              })}
            </div>
          );
        })()}
      </Field>

      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={() => void handleSubmit()}
          disabled={busy}
          className="px-4 py-1.5 rounded-md bg-accent hover:bg-accent/80 text-bg-1 text-sm font-medium disabled:opacity-60 transition-colors"
        >
          {busy ? 'Saving…' : isEdit ? 'Save changes' : 'Create rule'}
        </button>
        <button
          onClick={onCancel}
          disabled={busy}
          className="px-4 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm text-ink-2 disabled:opacity-60 transition-colors"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Audit Log tab
// ─────────────────────────────────────────────────────────────────────────
//
// Read-only view of audit_log_entries. Server requires VIEW_AUDIT_LOG;
// admins typically have it as part of their role bundle. Pagination
// uses a snowflake cursor (id-DESC = time-DESC since snowflakes are
// monotonic with time).
//
// Filter chips translate to an action-prefix string the server's LIKE
// query understands. "All" sends no prefix; specific chips send e.g.
// "automod." or "member." to narrow the result set.

const AUDIT_PAGE_SIZE = 50;

interface AuditFilterOption {
  label: string;
  /** Server filter; '' means no filter. */
  prefix: string;
}

const ACTION_FILTER_OPTIONS: AuditFilterOption[] = [
  { label: 'All', prefix: '' },
  { label: 'Members', prefix: 'member.' },
  { label: 'Channels', prefix: 'channel.' },
  { label: 'Roles', prefix: 'role.' },
  { label: 'Bans', prefix: 'ban.' },
  { label: 'AutoMod', prefix: 'automod.' },
  { label: 'Events', prefix: 'event.' },
];

function AuditLogTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [entries, setEntries] = useState<AuditLogEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [filterPrefix, setFilterPrefix] = useState<string>('');
  const [exporting, setExporting] = useState(false);

  function fileSlug(): string {
    const slug =
      guild.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 40) || 'server';
    return `${slug}-audit-${new Date().toISOString().slice(0, 10)}`;
  }

  async function exportLog(format: 'csv' | 'json') {
    if (exporting) return;
    setExporting(true);
    try {
      const r = await rest.exportAuditLog(guild.id);
      let content: string;
      let mime: string;
      let ext: string;
      if (format === 'json') {
        content = JSON.stringify(r, null, 2);
        mime = 'application/json';
        ext = 'json';
      } else {
        const esc = (v: unknown): string => {
          const s = v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
          return `"${s.replace(/"/g, '""')}"`;
        };
        const header = [
          'timestamp',
          'action',
          'target_type',
          'target_id',
          'actor',
          'actor_id',
          'reason',
          'changes',
        ];
        const lines = [header.join(',')];
        for (const e of r.entries) {
          lines.push(
            [
              esc(e.createdAt),
              esc(e.action),
              esc(e.targetType),
              esc(e.targetId),
              esc(e.actor ? e.actor.displayName || e.actor.username : ''),
              esc(e.actor ? e.actor.id : ''),
              esc(e.reason),
              esc(e.changes),
            ].join(','),
          );
        }
        // Leading BOM so spreadsheets detect UTF-8; CRLF line endings for
        // maximum spreadsheet compatibility.
        content = '\ufeff' + lines.join('\r\n');
        mime = 'text/csv';
        ext = 'csv';
      }
      const blob = new Blob([content], { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${fileSlug()}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      toasts.push(
        r.truncated
          ? `Exported the most recent ${r.entries.length} entries (older history was truncated)`
          : 'Audit log exported',
        r.truncated ? 'info' : 'success',
      );
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Export failed', 'error');
    } finally {
      setExporting(false);
    }
  }

  async function load(opts: { before?: string; replace?: boolean } = {}) {
    const isInitial = opts.replace ?? false;
    if (isInitial) setLoading(true);
    else setLoadingMore(true);
    setError(null);
    try {
      const r = await rest.listAuditLog(guild.id, {
        limit: AUDIT_PAGE_SIZE,
        before: opts.before,
        actionPrefix: filterPrefix || undefined,
      });
      if (isInitial) {
        setEntries(r.entries);
      } else {
        setEntries((prev) => [...prev, ...r.entries]);
      }
      setDone(r.entries.length < AUDIT_PAGE_SIZE);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load audit log');
    } finally {
      setLoading(false);
      setLoadingMore(false);
    }
  }

  // Initial load + reload on filter change. Resets the list (cursor
  // doesn't carry across filters — different filter, different
  // pagination universe).
  useEffect(() => {
    void load({ replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guild.id, filterPrefix]);

  function loadMore() {
    if (loadingMore || done) return;
    const last = entries[entries.length - 1];
    if (!last) return;
    void load({ before: last.id });
  }

  if (loading) {
    return <p className="text-sm text-ink-3">Loading audit log…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-300">{error}</p>;
  }

  return (
    <div className="space-y-3">
      <p className="text-xs text-ink-3 leading-relaxed">
        Audit log records moderator-relevant actions: member kicks/bans, role changes, channel
        edits, automod triggers, and more. The log is read-only and tracks who did what when —
        useful for resolving disputes and reviewing moderator activity.
      </p>

      {/* Export the full log (ignores the filter below — always the complete record). */}
      <div className="flex items-center gap-2">
        <button
          onClick={() => void exportLog('csv')}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-bg-2 text-ink-1 border border-line hover:border-accent transition-colors disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" /> {exporting ? 'Exporting…' : 'Export CSV'}
        </button>
        <button
          onClick={() => void exportLog('json')}
          disabled={exporting}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium bg-bg-2 text-ink-1 border border-line hover:border-accent transition-colors disabled:opacity-40"
        >
          <Download className="w-3.5 h-3.5" /> Export JSON
        </button>
      </div>

      {/* Filter chips */}
      <div className="flex flex-wrap gap-1.5">
        {ACTION_FILTER_OPTIONS.map((opt) => (
          <button
            key={opt.prefix}
            onClick={() => setFilterPrefix(opt.prefix)}
            className={`px-3 py-1 rounded-md text-xs font-medium transition-colors ${
              filterPrefix === opt.prefix
                ? 'bg-accent text-bg-1'
                : 'bg-bg-2 text-ink-2 hover:bg-bg-3'
            }`}
          >
            {opt.label}
          </button>
        ))}
      </div>

      {entries.length === 0 ? (
        <div className="rounded-md border border-line bg-bg-2/50 px-4 py-6 text-center">
          <p className="text-sm text-ink-2">No audit-log entries{filterPrefix ? ' match this filter' : ' yet'}.</p>
        </div>
      ) : (
        <ul className="space-y-1">
          {entries.map((entry) => (
            <AuditLogEntryRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}

      {entries.length > 0 && !done && (
        <button
          onClick={loadMore}
          disabled={loadingMore}
          className="w-full px-3 py-2 rounded-md border border-line border-dashed hover:bg-bg-2 text-sm text-ink-2 transition-colors disabled:opacity-60"
        >
          {loadingMore ? 'Loading…' : 'Load older entries'}
        </button>
      )}

      {entries.length > 0 && done && (
        <p className="text-center text-xs text-ink-3 py-2">— End of audit log —</p>
      )}
    </div>
  );
}

function AuditLogEntryRow({ entry }: { entry: AuditLogEntry }) {
  const [expanded, setExpanded] = useState(false);
  const hasDetails = entry.changes !== null || entry.reason !== null;

  const actorName = entry.actor?.displayName ?? entry.actor?.username ?? 'Unknown moderator';
  const initials = avatarInitials(actorName);
  const tone = entry.actor ? avatarColor(entry.actor.id) : 'bg-bg-3 text-ink-3';

  const summary = renderAuditEntrySummary(entry);
  const timestamp = formatAuditTimestamp(entry.createdAt);

  return (
    <li className="rounded-md hover:bg-bg-2/40 transition-colors">
      <button
        type="button"
        onClick={() => hasDetails && setExpanded((v) => !v)}
        disabled={!hasDetails}
        className="w-full text-left px-2 py-2 flex items-start gap-3 disabled:cursor-default"
      >
        <span className="relative w-7 h-7 shrink-0 mt-0.5">
          <span className={`absolute inset-0 rounded-full text-xs flex items-center justify-center font-semibold ${tone}`}>
            {initials}
          </span>
          {entry.actor?.avatarUrl && <AvatarImage src={entry.actor.avatarUrl} />}
        </span>
        <div className="flex-1 min-w-0">
          <div className="text-sm text-ink-1 truncate">{summary}</div>
          <div className="text-xs text-ink-3 flex items-center gap-2 mt-0.5">
            <span>{actorName}</span>
            <span>·</span>
            <span title={new Date(entry.createdAt).toLocaleString()}>{timestamp}</span>
            <span className="px-1.5 py-0.5 rounded-sm bg-bg-3 text-[0.6rem] font-mono">
              {entry.action}
            </span>
          </div>
        </div>
        {hasDetails && (
          <span className={`text-ink-3 text-xs shrink-0 mt-1.5 transition-transform ${expanded ? 'rotate-180' : ''}`}>
            ▾
          </span>
        )}
      </button>
      {expanded && hasDetails && (
        <div className="px-3 pb-3 pt-1 ml-10 space-y-2">
          {entry.reason && (
            <div>
              <div className="text-[0.7rem] uppercase tracking-wider text-ink-3 mb-1">Reason</div>
              <p className="text-xs text-ink-1">{entry.reason}</p>
            </div>
          )}
          {entry.changes && (
            <div>
              <div className="text-[0.7rem] uppercase tracking-wider text-ink-3 mb-1">Details</div>
              <pre className="text-xs text-ink-2 bg-bg-1 border border-line rounded p-2 overflow-x-auto whitespace-pre-wrap font-mono">
                {JSON.stringify(entry.changes, null, 2)}
              </pre>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Friendly one-liner for an audit entry. Maps action codes to natural
 * language. Falls back to the raw action string for unknown codes so
 * unexpected entries don't break the UI.
 */
function renderAuditEntrySummary(entry: AuditLogEntry): string {
  const c = entry.changes as Record<string, unknown> | null;
  switch (entry.action) {
    case 'member.kick':
      return 'Kicked a member';
    case 'member.timeout_set': {
      const to = c?.to as string | undefined;
      if (!to) return 'Timed out a member';
      const until = new Date(to);
      return `Timed out a member until ${until.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}`;
    }
    case 'member.timeout_clear':
      return 'Cleared a member timeout';
    case 'member.role_add':
      return 'Added a role to a member';
    case 'member.role_remove':
      return 'Removed a role from a member';
    case 'member.nickname_set':
      return c?.nickname ? `Set nickname to "${c.nickname}"` : 'Cleared a nickname';
    case 'member.nickname_self':
      return 'Changed their own nickname';
    case 'ban.add': {
      const reason = c?.reason as string | undefined;
      return reason ? `Banned a member — "${reason}"` : 'Banned a member';
    }
    case 'ban.remove':
      return 'Lifted a ban';
    case 'channel.create':
      return c?.name ? `Created channel #${c.name}` : 'Created a channel';
    case 'channel.update':
      return 'Updated a channel';
    case 'channel.delete':
      return 'Deleted a channel';
    case 'role.create':
      return c?.name ? `Created role "${c.name}"` : 'Created a role';
    case 'role.update':
      return 'Updated a role';
    case 'role.delete':
      return 'Deleted a role';
    case 'guild.update':
      return 'Updated server settings';
    case 'guild.rules_cleared_auto_activated': {
      const count = c?.count as number | undefined;
      return count
        ? `Cleared rules — auto-activated ${count} pending member${count === 1 ? '' : 's'}`
        : 'Cleared rules — auto-activated pending members';
    }
    case 'invite.create':
      return 'Created an invite';
    case 'invite.delete':
      return 'Deleted an invite';
    case 'automod.rule_create':
      return c?.name ? `Created automod rule "${c.name}"` : 'Created an automod rule';
    case 'automod.rule_update':
      return c?.name ? `Updated automod rule "${c.name}"` : 'Updated an automod rule';
    case 'automod.rule_delete':
      return 'Deleted an automod rule';
    case 'automod.rule_triggered': {
      const ruleName = c?.ruleName as string | undefined;
      const timeoutApplied = c?.timeoutApplied as boolean | undefined;
      const base = ruleName ? `Tripped automod rule "${ruleName}"` : 'Tripped an automod rule';
      return timeoutApplied ? `${base} — auto-timed-out` : base;
    }
    case 'event.create': {
      const name = c?.name as string | undefined;
      return name ? `Created event "${name}"` : 'Created a scheduled event';
    }
    case 'event.update': {
      // Granular summary based on which fields were patched. Multiple
      // unrelated categories → fall through to generic; single category
      // gets a specific label.
      if (!c) return 'Updated a scheduled event';
      const keys = Object.keys(c);
      const has = (k: string) => keys.includes(k);
      const touchedDetails = has('name') || has('description');
      const touchedTime = has('startAt') || has('endAt');
      const touchedLocation =
        has('locationKind') || has('locationChannelId') || has('locationText');
      // Count distinct categories touched. updatedAt is a stamp not
      // a user-meaningful field — exclude from the dimension count.
      const categories = [touchedDetails, touchedTime, touchedLocation].filter(Boolean).length;
      if (categories > 1) {
        return 'Updated event';
      }
      if (touchedDetails) {
        const newName = c.name as string | undefined;
        if (newName) return `Renamed event to "${newName}"`;
        return 'Edited event description';
      }
      if (touchedTime) {
        return 'Rescheduled event';
      }
      if (touchedLocation) {
        return 'Changed event location';
      }
      // Patches that touched only `updatedAt` or other non-categorized
      // fields fall through to the generic label.
      return 'Updated event';
    }
    case 'event.image_set':
      return 'Set event banner image';
    case 'event.image_cleared':
      return 'Removed event banner image';
    case 'event.time_changed':
      return 'Rescheduled event';
    case 'event.location_changed':
      return 'Changed event location';
    case 'event.status_changed': {
      const newStatus = c?.status as string | undefined;
      if (newStatus === 'active') return 'Marked event as active';
      if (newStatus === 'completed') return 'Marked event as completed';
      if (newStatus) return `Changed event status to ${newStatus}`;
      return 'Changed event status';
    }
    case 'event.cancel':
      return 'Canceled a scheduled event';
    case 'event.delete':
      return 'Deleted a scheduled event';
    default:
      // Fallback: prettify the dot-case action name. "member.kick" → "Member kick"
      return entry.action
        .replace(/[._]/g, ' ')
        .replace(/^\w/, (c) => c.toUpperCase());
  }
}

/**
 * Relative timestamp for audit rows. Recent entries get "5 minutes ago"
 * style; older entries fall through to a localized date/time. The
 * exact wall-clock is always available via the row's `title` tooltip.
 */
function formatAuditTimestamp(iso: string): string {
  const date = new Date(iso);
  const now = Date.now();
  const diffMs = now - date.getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 5) return 'just now';
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

// ─────────────────────────────────────────────────────────────────────────
// Emojis tab
// ─────────────────────────────────────────────────────────────────────────
//
// Lists the guild's custom emoji and lets owners (v1) add, rename, and
// delete them. Same gating story as Bans — the server enforces
// MANAGE_EMOJIS but we keep the tab owner-only client-side until role
// state is materialized in AppState.
//
// Server constraints: PNG/GIF/WebP only, 512 KB max, 50 emojis per guild,
// names 2-32 chars [a-z0-9_]. We mirror the validation in the upload
// form so the user gets immediate feedback rather than a roundtrip.

const EMOJI_NAME_RE = /^[a-z0-9_]{2,32}$/;
const EMOJI_MAX_BYTES = 512 * 1024;
const EMOJI_PER_GUILD_LIMIT = 50;
const EMOJI_ACCEPT = 'image/png,image/gif,image/webp';

function EmojisTab({ guild }: { guild: Guild }) {
  const { rest } = useAuth();
  const { state } = useAppState();
  // Try state cache first so the tab opens with content; refresh on
  // mount in case the cache is stale (e.g. another moderator added
  // one in another tab while this one was open). The bootstrap path
  // and gateway GUILD_EMOJIS_UPDATE handler keep AppState fresh, so
  // we don't need to dispatch from here — just read.
  const cached = state.emojisByGuild[guild.id];
  const [emojis, setEmojis] = useState<GuildEmoji[] | null>(cached ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    rest
      .listGuildEmojis(guild.id)
      .then((r) => {
        if (cancelled) return;
        setEmojis(r.emojis);
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof ApiError ? e.message : 'Could not load emojis');
        setEmojis([]);
      });
    return () => {
      cancelled = true;
    };
  }, [rest, guild.id]);

  if (emojis === null) {
    return <p className="text-sm text-ink-3">Loading emoji…</p>;
  }
  if (error) {
    return <p className="text-sm text-red-300">{error}</p>;
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-ink-3 leading-relaxed">
        Custom emoji are usable as <code className="text-ink-2">:name:</code>{' '}
        in messages and reactions for members of this server. PNG, GIF, and
        WebP up to {Math.round(EMOJI_MAX_BYTES / 1024)} KB. Up to{' '}
        {EMOJI_PER_GUILD_LIMIT} emoji per server.
      </p>

      <UploadEmojiForm
        guildId={guild.id}
        currentCount={emojis.length}
        onUploaded={(e) => {
          // Optimistic local update; the gateway broadcast will also
          // arrive shortly and replace the slice with the canonical
          // server-side list (which will include this same row).
          setEmojis((prev) => (prev ? [...prev, e] : [e]));
        }}
      />

      {emojis.length === 0 ? (
        <div className="bg-bg-2 border border-line rounded-md py-12 px-6 text-center">
          <Smile size={28} className="text-ink-3 mx-auto mb-2" />
          <p className="text-sm text-ink-2">No custom emoji yet.</p>
          <p className="text-xs text-ink-3 mt-1">
            Upload one above to get started.
          </p>
        </div>
      ) : (
        <div>
          <p className="text-xs text-ink-3 mb-2">
            {emojis.length} of {EMOJI_PER_GUILD_LIMIT} used
          </p>
          <ul className="border border-line rounded-md divide-y divide-line bg-bg-2 overflow-hidden">
            {emojis.map((e) => (
              <EmojiRow
                key={e.id}
                emoji={e}
                guildId={guild.id}
                onRenamed={(updated) => {
                  setEmojis((prev) =>
                    prev?.map((x) => (x.id === updated.id ? updated : x)) ?? prev,
                  );
                }}
                onDeleted={(id) => {
                  setEmojis((prev) => prev?.filter((x) => x.id !== id) ?? prev);
                }}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/**
 * Upload form. The user picks a file first, then names it. We default
 * the name to a sanitized version of the filename (sans extension) so
 * the common case is one tap of "Upload" — but they can edit before
 * submitting.
 */
function UploadEmojiForm({
  guildId,
  currentCount,
  onUploaded,
}: {
  guildId: string;
  currentCount: number;
  onUploaded: (e: GuildEmoji) => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [name, setName] = useState('');
  const [pending, setPending] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  // Generate a blob URL for the chosen file so the user gets a live
  // preview at the same size the picker will show. Cleaned up on
  // change/unmount to avoid leaking memory across multiple selections.
  useEffect(() => {
    if (!file) {
      setPreviewUrl(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function chooseFile(picked: File) {
    setFile(picked);
    // Auto-suggest a name from the filename: strip extension, lowercase,
    // replace any non-allowed chars with underscore, collapse runs.
    const base = picked.name.replace(/\.[^.]+$/, '');
    const cleaned = base
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
    setName(cleaned || '');
  }

  const fileError = file
    ? !['image/png', 'image/gif', 'image/webp'].includes(file.type)
      ? 'File must be PNG, GIF, or WebP'
      : file.size > EMOJI_MAX_BYTES
        ? `File exceeds ${Math.round(EMOJI_MAX_BYTES / 1024)} KB`
        : null
    : null;
  const nameError =
    name && !EMOJI_NAME_RE.test(name)
      ? 'Name must be 2-32 chars, letters/digits/underscores only'
      : null;
  const slotError =
    currentCount >= EMOJI_PER_GUILD_LIMIT
      ? `Server is full (${EMOJI_PER_GUILD_LIMIT}/${EMOJI_PER_GUILD_LIMIT}). Delete an emoji to add a new one.`
      : null;
  const canSubmit = !!file && !!name && !fileError && !nameError && !slotError && !pending;

  async function submit() {
    if (!file || !canSubmit) return;
    setPending(true);
    try {
      const r = await rest.uploadGuildEmoji(guildId, { file, name });
      onUploaded(r.emoji);
      toasts.push(`Added :${r.emoji.name}:`, 'success');
      // Reset the form for the next upload.
      setFile(null);
      setName('');
      if (fileInputRef.current) fileInputRef.current.value = '';
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Upload failed', 'error');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="bg-bg-2 border border-line rounded-md p-4">
      <h3 className="text-sm font-semibold text-ink-1 mb-3">Add new emoji</h3>
      <div className="flex items-start gap-3">
        {/* File picker — clicking the preview tile opens the OS picker.
            We hide the native input and lay a styled button over it
            because the default browser file-input is ugly and resists
            theming. */}
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={pending || !!slotError}
          className="w-16 h-16 shrink-0 rounded-md bg-bg-3 border border-line border-dashed hover:border-accent flex items-center justify-center text-ink-2 hover:text-accent transition-colors disabled:opacity-60"
          aria-label="Choose emoji file"
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
          accept={EMOJI_ACCEPT}
          className="hidden"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) chooseFile(f);
          }}
        />
        <div className="flex-1 min-w-0 space-y-2">
          <label className="block">
            <span className="text-xs text-ink-2">Name</span>
            <div className="mt-1 flex items-center gap-1">
              <span className="text-ink-3 select-none">:</span>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="emoji_name"
                maxLength={32}
                disabled={pending}
                className="flex-1 px-2 py-1.5 bg-bg-1 border border-line rounded-md text-sm outline-none focus:border-accent"
              />
              <span className="text-ink-3 select-none">:</span>
            </div>
          </label>
          {(fileError || nameError || slotError) && (
            <p className="text-xs text-red-300">{fileError || nameError || slotError}</p>
          )}
          <button
            type="button"
            onClick={() => void submit()}
            disabled={!canSubmit}
            className="w-full sm:w-auto px-4 py-1.5 rounded-md bg-accent hover:bg-accent/90 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {pending ? 'Uploading…' : 'Upload emoji'}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Single emoji row in the management list. Shows the emoji at its
 * actual size, the :name: token, who uploaded it (when known), and
 * inline rename + delete actions.
 */
function EmojiRow({
  emoji,
  guildId,
  onRenamed,
  onDeleted,
}: {
  emoji: GuildEmoji;
  guildId: string;
  onRenamed: (e: GuildEmoji) => void;
  onDeleted: (id: string) => void;
}) {
  const { rest } = useAuth();
  const toasts = useToasts();
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(emoji.name);
  const [busy, setBusy] = useState(false);

  async function commitRename() {
    const next = draft.trim();
    if (!EMOJI_NAME_RE.test(next)) {
      toasts.push('Invalid emoji name', 'error');
      return;
    }
    if (next === emoji.name) {
      setRenaming(false);
      return;
    }
    setBusy(true);
    try {
      const r = await rest.renameGuildEmoji(guildId, emoji.id, next);
      onRenamed(r.emoji);
      setRenaming(false);
      toasts.push(`Renamed to :${r.emoji.name}:`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Rename failed', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function deleteEmoji() {
    if (!confirm(`Delete :${emoji.name}:? Messages that used it will keep showing the literal :${emoji.name}: text.`)) return;
    setBusy(true);
    try {
      await rest.deleteGuildEmoji(guildId, emoji.id);
      onDeleted(emoji.id);
      toasts.push(`Deleted :${emoji.name}:`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Delete failed', 'error');
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-3 px-3 py-3">
      <img
        src={emoji.url}
        alt={emoji.name}
        className="w-10 h-10 rounded shrink-0 object-contain bg-bg-3"
      />
      <div className="flex-1 min-w-0">
        {renaming ? (
          <div className="flex items-center gap-1">
            <span className="text-ink-3 select-none">:</span>
            <input
              type="text"
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              maxLength={32}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void commitRename();
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  setDraft(emoji.name);
                  setRenaming(false);
                }
              }}
              className="flex-1 min-w-0 px-2 py-1 bg-bg-1 border border-line rounded text-sm outline-none focus:border-accent"
            />
            <span className="text-ink-3 select-none">:</span>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => {
              setDraft(emoji.name);
              setRenaming(true);
            }}
            className="text-sm text-ink-1 hover:text-accent text-left truncate"
            title="Rename"
          >
            :{emoji.name}:
          </button>
        )}
      </div>
      {renaming ? (
        <>
          <button
            type="button"
            onClick={() => void commitRename()}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-accent hover:bg-accent/90 text-white disabled:opacity-60"
          >
            {busy ? '…' : 'Save'}
          </button>
          <button
            type="button"
            onClick={() => {
              setDraft(emoji.name);
              setRenaming(false);
            }}
            disabled={busy}
            className="px-3 py-1.5 rounded-md text-xs font-medium bg-bg-3 hover:bg-bg-3/80 text-ink-2 disabled:opacity-60"
          >
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void deleteEmoji()}
          disabled={busy}
          className="shrink-0 p-1.5 rounded-md hover:bg-red-950/40 text-red-400 hover:text-red-300 disabled:opacity-60 transition-colors"
          aria-label={`Delete :${emoji.name}:`}
          title="Delete"
        >
          <Trash size={14} />
        </button>
      )}
    </li>
  );
}

/**
 * ImageUploadField — file input with live preview and Remove button.
 *
 * Used in the Overview tab for guild icons and banners; the same shape
 * also fits user profile avatars/banners. Caller provides:
 *  - currentUrl   : the current image (or null) — drives the preview
 *  - shape        : 'circle' for icons, 'banner' for hero strips
 *  - previewSize  : pixel size for the preview (square edge OR banner height)
 *  - onUpload     : async hook the field calls with the picked File; should
 *                   POST it and return the new URL (or null) so we can
 *                   render the updated preview without an extra GET.
 *  - onClear      : called when the user hits Remove — should null out the
 *                   field server-side. UI shows it only when a current URL
 *                   exists.
 *
 * We track an internal `loading` state so the buttons disable while the
 * upload is in flight, and a `localUrl` so the preview reflects the
 * just-uploaded image even before the parent re-renders with new props.
 */
function ImageUploadField({
  currentUrl,
  shape,
  previewSize,
  disabled,
  onUpload,
  onClear,
}: {
  currentUrl: string | null;
  shape: 'circle' | 'banner';
  previewSize: number;
  disabled?: boolean;
  onUpload: (file: File) => Promise<string | null>;
  onClear: () => Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [loading, setLoading] = useState(false);
  const [localUrl, setLocalUrl] = useState<string | null>(null);
  const url = localUrl ?? currentUrl;

  async function handlePick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow picking the same file twice
    if (!file) return;
    setLoading(true);
    try {
      const next = await onUpload(file);
      setLocalUrl(next);
    } catch {
      // Toasts surface the error already; nothing else to do here.
    } finally {
      setLoading(false);
    }
  }

  async function handleClear() {
    setLoading(true);
    try {
      await onClear();
      setLocalUrl(null);
    } finally {
      setLoading(false);
    }
  }

  const previewBox =
    shape === 'circle'
      ? { width: previewSize, height: previewSize, borderRadius: '9999px' }
      // Banner: full-width, aspect-locked to 16:9 to match how the
      // banner renders in the channel-list header. previewSize is
      // no longer used here — the box height is derived from the
      // column width, so an upload preview shows the same crop the
      // viewer will see. Kept the param in the signature for source-
      // compat with existing call sites.
      : { width: '100%', aspectRatio: '16 / 9', borderRadius: '0.5rem' };

  return (
    <div className={shape === 'banner' ? 'flex flex-col gap-2' : 'flex items-center gap-3'}>
      <div
        className="bg-bg-3 border border-line overflow-hidden flex items-center justify-center shrink-0"
        style={previewBox}
      >
        {url ? (
          <img
            src={url}
            alt=""
            className="w-full h-full object-cover"
            draggable={false}
          />
        ) : (
          <span className="text-[0.65rem] text-ink-3 px-2 text-center">No image</span>
        )}
      </div>
      <div className={shape === 'banner' ? 'flex gap-1.5' : 'flex flex-col gap-1.5'}>
        <input
          ref={inputRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          className="hidden"
          onChange={handlePick}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={disabled || loading}
          className="px-3 py-1.5 rounded-md bg-bg-2 hover:bg-bg-3 border border-line text-xs text-ink-1 disabled:opacity-50"
        >
          {loading ? 'Uploading…' : url ? 'Change' : 'Upload'}
        </button>
        {url && (
          <button
            type="button"
            onClick={handleClear}
            disabled={disabled || loading}
            className="px-3 py-1.5 rounded-md text-xs text-danger hover:bg-bg-2 disabled:opacity-50"
          >
            Remove
          </button>
        )}
      </div>
    </div>
  );
}
