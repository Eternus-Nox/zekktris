/**
 * ProfileCard
 * -----------
 * Small floating profile card that appears when you click an avatar
 * anywhere in the app. Mirrors the iOS profile card: banner with a
 * custom-status speech bubble pointing at the avatar, display name +
 * username, an "ABOUT ME" bio, earned-only achievements, then the
 * social actions:
 *   - Send message (opens or creates a DM)
 *   - Add friend / Cancel request / Accept request / Remove friend
 *   - Block / Unblock
 *
 * The "right" actions are picked based on the current relationship
 * state, which we fetch lazily — most users haven't sent anything to
 * most other users, so a fresh fetch on open is fine. On your own
 * card the social actions are simply omitted (no "this is you" filler) —
 * clicking your own avatar shouldn't suggest you can friend yourself.
 *
 * Positioning: anchored to the click point. The trigger passes (x, y)
 * coords; this component decides flip-up/flip-down based on viewport
 * height to avoid clipping at the bottom of the screen.
 */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { UserTag, StaffName } from '../lib/UserTag';
import { TierBadge } from '../lib/TierBadge';
import { ApiError, type PublicUser, type Role } from '@zekktris/client';
import { AchievementsShelf } from './AchievementsShelf';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Portal } from '../lib/Portal';
import { avatarColor, avatarInitials } from '../lib/avatar';
import { AvatarImage } from '../lib/AvatarImage';
import { AvatarDecoration } from '../lib/avatarDecorations';
import {
  computeMemberGuildPerms,
  memberHighestRolePosition,
  memberDisplayColor,
  hasBit,
} from '../lib/permissions';
import { UserPlus, UserMinus, Shield, X, Edit, Trash, Ban as BanIcon, Clock } from '../lib/icons';
import { connectToVoice, VoiceError, prepareVoiceAudio, claimVoiceChannel, releaseVoiceChannel } from '../lib/voice';
import { formatCustomStatus } from './CustomStatusModal';

type RelType =
  | 'friend'
  | 'incoming_request'
  | 'outgoing_request'
  | 'blocked'
  | 'none';

interface AnchorPoint {
  x: number;
  y: number;
}

const CARD_WIDTH = 340;

/** Report/flag glyph. Inlined here (rather than added to lib/icons) so the
    Report User action matches the stroke style of the shared icon set. */
function FlagIcon({ size = 16, className = '' }: { size?: number; className?: string }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z" />
      <line x1="4" y1="22" x2="4" y2="15" />
    </svg>
  );
}

export function ProfileCard({
  user,
  guildId,
  onClose,
}: {
  user: PublicUser;
  /** Vestigial — the card used to be a popover anchored to the click point;
      it's now its own full-screen page, so the anchor is ignored. Kept in the
      props (optional) so existing call sites don't need to change. */
  anchor?: AnchorPoint;
  /** When set, the card is rendered in the context of a specific
      guild and exposes guild-management actions (notably role
      assignment) to viewers with the right permissions. */
  guildId?: string;
  onClose: () => void;
}) {
  const { rest, user: self } = useAuth();
  const { state, applyRelationship, loadMembers, mergeChannelVoiceStates, setDmNickname } =
    useAppState();
  const toasts = useToasts();
  const nav = useNavigate();
  const [rel, setRel] = useState<RelType>('none');
  // Whether the server will allow the viewer to DM/ring this user (friend, or
  // their server-member opt-in + a shared guild). undefined = not yet known;
  // we hide Message + Call until it resolves true so we never offer contact
  // the server would reject. Fetched from the single-profile endpoint below.
  const [canMessage, setCanMessage] = useState<boolean | undefined>(undefined);
  const [pending, setPending] = useState(false);
  // Personal DM-nickname editor (viewer-private label shown in DMs only).
  const dmNickname = state.dmNicknames[user.id] ?? '';
  const [editingDmNick, setEditingDmNick] = useState(false);
  const [dmNickDraft, setDmNickDraft] = useState('');
  const isSelf = self?.id === user.id;

  // The user object passed in often comes from a list (relationships,
  // members) that omits the heavier banner/bio fields — those are
  // fetched on demand. Pull the full public profile when the card opens
  // so the banner renders. Falls back silently if the fetch fails.
  const [fullProfile, setFullProfile] = useState<typeof user | null>(null);
  useEffect(() => {
    let cancelled = false;
    setFullProfile(null);
    setCanMessage(undefined);
    rest
      .getUser(user.id)
      .then((r) => {
        if (cancelled) return;
        setFullProfile(r.user);
        // canMessage is server-computed (privacy policy + shared guilds) and
        // rides on this same response — fold it in instead of firing a second
        // identical GET /users/:id. Only consumed for non-self cards.
        if (!isSelf) setCanMessage(r.user.canMessage ?? false);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [user.id, rest, isSelf]);
  const bannerUrl = user.bannerUrl ?? fullProfile?.bannerUrl ?? null;

  // ── Guild-context state ─────────────────────────────────────────
  // When a guildId is supplied, surface guild-management UI to viewers
  // with the right permissions. The server enforces these checks
  // independently — these client gates are just for hiding affordances
  // the user can't act on, so the card stays uncluttered.
  //
  // We always fetch the role list when guildId is set (not just for
  // owners) because we need it to compute the viewer's effective
  // permissions client-side. The list is small (typically <20 rows)
  // and the fetch happens once per card open.
  const guild = guildId ? state.guildsById[guildId] : undefined;
  const isOwner = !!guild && !!self && self.id === guild.ownerId;
  // Cached members for both viewer and target. Both are needed for
  // permission compute and role-hierarchy checks. Already-loaded for
  // any guild the user has navigated to (Shell triggers loadMembers).
  const guildMembers = guildId ? state.membersByGuild[guildId] ?? [] : [];
  const targetMember = guildMembers.find((m) => m.userId === user.id);
  const viewerMember = self ? guildMembers.find((m) => m.userId === self.id) : undefined;

  const [memberRoleIds, setMemberRoleIds] = useState<string[]>(
    () => targetMember?.roleIds ?? [],
  );
  // Full role list including @everyone — used for perm compute. The
  // assignable subset (without @everyone) is derived in render.
  // Seed from the store: both guild-context openers (MemberList, ChannelList)
  // eagerly loadRoles(guildId), so the slice is almost always already present.
  const [allRoles, setAllRoles] = useState<Role[] | null>(
    () => (guildId ? state.rolesByGuild[guildId] ?? null : null),
  );
  const [rolePending, setRolePending] = useState<Set<string>>(new Set());

  // Re-sync the local roleIds whenever the cached member's role set
  // changes underneath us (e.g. another tab made a change). Cheap
  // stable-equality check via a joined key — the array reference can
  // change without the contents changing.
  const cachedRoleIdsKey = (targetMember?.roleIds ?? []).join(',');
  useEffect(() => {
    if (!guildId) return;
    setMemberRoleIds(targetMember?.roleIds ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cachedRoleIdsKey, guildId]);

  // Lazy fetch roles when in a guild context. Even non-owners need
  // them — we use the list to compute the viewer's permission
  // bitfield. Cancellable so unmounting the card mid-fetch doesn't
  // dispatch into a stale state.
  useEffect(() => {
    if (!guildId) return;
    // Already have the guild's roles in the store (the opener — MemberList /
    // ChannelList — loadRoles eagerly). ROLES_SET stores the identical
    // listRoles shape, so skip the redundant round-trip on card open.
    if (state.rolesByGuild[guildId]) {
      setAllRoles(state.rolesByGuild[guildId]);
      return;
    }
    let cancelled = false;
    rest
      .listRoles(guildId)
      .then((r) => {
        if (cancelled) return;
        setAllRoles(r.roles);
      })
      .catch(() => {
        // Quietly fail — without roles the perm panels stay hidden,
        // which is the safe default.
      });
    return () => {
      cancelled = true;
    };
  }, [guildId, rest]);

  // ── Computed perms (viewer + target) ──────────────────────────────
  // Computed lazily off the cached state. Falls back to all-zero perms
  // when prerequisites are missing (no guild context, no members
  // loaded, role list still pending) — that means every "can the
  // viewer do X?" check returns false until everything's hydrated,
  // which is the desired safe-default behavior.
  const viewerPerms: bigint = (() => {
    if (!guildId || !viewerMember || !allRoles) return 0n;
    return computeMemberGuildPerms(allRoles, guildId, viewerMember.roleIds, isOwner);
  })();
  const viewerHighestPos: number = (() => {
    if (!guildId || !viewerMember || !allRoles) return 0;
    return memberHighestRolePosition(allRoles, guildId, viewerMember.roleIds);
  })();
  const targetHighestPos: number = (() => {
    if (!guildId || !targetMember || !allRoles) return 0;
    return memberHighestRolePosition(allRoles, guildId, targetMember.roleIds);
  })();
  const targetIsOwner = !!guild && self?.id !== user.id && guild.ownerId === user.id;

  // The viewer can manage the target if: (a) viewer is owner, or
  // (b) target is not owner AND viewer's highest role > target's.
  // Owners are untouchable except by themselves (and the self path
  // doesn't render management UI anyway). This mirrors
  // `assertCanManageMember` in the server.
  const canManageTarget = !isSelf && !targetIsOwner && (isOwner || viewerHighestPos > targetHighestPos);

  // Self-management exception: a user with MANAGE_ROLES (or owner) can
  // assign/remove their OWN roles, gated per-role by hierarchy below.
  // This matches Discord's behavior — useful for admin-tier users who
  // need to give themselves a temporary "test" role, etc. The
  // per-role hierarchy check (role.position < viewerHighestPos) still
  // applies, so the user can't elevate themselves to a role above
  // their current ceiling. Owners bypass everything.
  const canManageOwnRoles = isSelf && (isOwner || hasBit(viewerPerms, 12));

  // Permissions surfaced as booleans for readability. Each is
  // additionally gated by canManageTarget where applicable.
  const can = {
    manageRoles:
      canManageOwnRoles ||
      (!isSelf && (isOwner || hasBit(viewerPerms, 12)) && canManageTarget),
    kick: !isSelf && (isOwner || hasBit(viewerPerms, 13)) && canManageTarget,
    // Bans are permanent (until lifted) — same hierarchy gate as kick
    // since both remove a member; the difference is just whether the
    // user can come back through an invite.
    ban: !isSelf && (isOwner || hasBit(viewerPerms, 14)) && canManageTarget,
    manageNicknames: !isSelf && (isOwner || hasBit(viewerPerms, 16)) && canManageTarget,
    changeOwnNickname: isSelf && !!viewerMember && (isOwner || hasBit(viewerPerms, 15)),
    // MODERATE_MEMBERS (bit 17) — timeouts. Same hierarchy gate as
    // kick/ban: you must outrank the target. Server also rejects
    // self-timeouts so the !isSelf check is the visible-UX layer
    // (no point showing a button that will 400).
    timeout: !isSelf && (isOwner || hasBit(viewerPerms, 17)) && canManageTarget,
  };

  // Show the role panel whenever the viewer can manage roles for
  // this target. The panel itself further filters per-role for
  // hierarchy (you can only assign roles below your highest).
  const showRolePanel = !!guildId && can.manageRoles;
  // Show the moderation row (Kick / Ban / Timeout) whenever any of those
  // actions are available. Nickname editing is NOT here anymore: managing
  // ANOTHER member's server nickname now sits beside the private DM-nickname
  // button up in the actions block, and editing your OWN nickname is added
  // back below via `can.changeOwnNickname` — so an "only manage-nicknames"
  // viewer doesn't get an empty bordered mod row.
  const showModRow = can.kick || can.ban || can.timeout;

  // Current timeout state for the target. Returns the until-date if
  // still in the future, null otherwise. Re-derives on each render
  // (cheap — string parse + comparison); we deliberately do NOT
  // memo because the value naturally goes stale as wall-clock time
  // advances, and an unmemoized read picks up the staleness on
  // every render the popover is open.
  const timeoutActiveUntil = (() => {
    const iso = targetMember?.communicationDisabledUntil;
    if (!iso) return null;
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return null;
    return d.getTime() > Date.now() ? d : null;
  })();

  /** Toggle a single role on/off for the target. The server PATCH
      replaces the whole set, so we compute the next set locally first,
      send that, and only commit the optimistic change once the request
      succeeds. On failure we revert the toggle and surface a toast. */
  async function toggleRole(roleId: string) {
    if (!guildId) return;
    if (rolePending.has(roleId)) return;
    const has = memberRoleIds.includes(roleId);
    const next = has
      ? memberRoleIds.filter((r) => r !== roleId)
      : [...memberRoleIds, roleId];
    setRolePending((prev) => {
      const s = new Set(prev);
      s.add(roleId);
      return s;
    });
    // Optimistic update — checkbox flips immediately so toggling feels
    // snappy. Reverted in catch on failure.
    setMemberRoleIds(next);
    try {
      await rest.patchMember(guildId, user.id, { roleIds: next });
      // Refresh the cached member list so MemberList row groupings,
      // role colours, and ordering reflect the change without
      // requiring a navigation. Fire-and-forget — failure here would
      // be cosmetic only (the underlying patch already succeeded).
      void loadMembers(guildId).catch(() => undefined);
      toasts.push(has ? 'Role removed' : 'Role assigned', 'success');
    } catch (e) {
      // Revert local state on failure.
      setMemberRoleIds(memberRoleIds);
      toasts.push(e instanceof ApiError ? e.message : 'Could not update roles', 'error');
    } finally {
      setRolePending((prev) => {
        const s = new Set(prev);
        s.delete(roleId);
        return s;
      });
    }
  }

  // ── Moderation (kick / ban / timeout) ────────────────────────────
  const [kickPending, setKickPending] = useState(false);
  const [banPending, setBanPending] = useState(false);
  const [banPromptOpen, setBanPromptOpen] = useState(false);
  const [banReason, setBanReason] = useState('');
  // Timeout state. Same shape as ban: pending for the in-flight
  // request, promptOpen for the inline expansion that lets the
  // moderator pick a duration. Cleanly distinct from the "user is
  // currently timed out" derived value below.
  const [timeoutPending, setTimeoutPending] = useState(false);
  const [timeoutPromptOpen, setTimeoutPromptOpen] = useState(false);
  // Report state. Inline prompt (like the ban prompt) letting the viewer pick
  // a reason + optional details before filing a report against this user.
  const [reportPromptOpen, setReportPromptOpen] = useState(false);
  const [reportPending, setReportPending] = useState(false);
  // No reason pre-selected — like iOS (ReportUserSheet), the reporter must
  // actively pick one AND describe what happened before Submit enables.
  const [reportReason, setReportReason] = useState<
    '' | 'spam' | 'harassment' | 'nsfw' | 'violence' | 'other'
  >('');
  const [reportDetails, setReportDetails] = useState('');

  /** Save (or clear) the personal DM nickname — viewer-private, shown in DMs. */
  async function saveDmNickname() {
    const next = dmNickDraft.trim();
    setEditingDmNick(false);
    try {
      await setDmNickname(user.id, next.length === 0 ? null : next);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not save nickname', 'error');
    }
  }

  async function applyTimeout(durationSeconds: number) {
    if (!guildId || timeoutPending) return;
    setTimeoutPending(true);
    try {
      // Compute the until-timestamp now (not at button-press time) so
      // the duration counts from when the request fires, not from
      // when the prompt opened. Trivial difference in practice but
      // makes the audit-log timestamp match the moderator's intent.
      const until = new Date(Date.now() + durationSeconds * 1000).toISOString();
      await rest.patchMember(guildId, user.id, { communicationDisabledUntil: until });
      void loadMembers(guildId).catch(() => undefined);
      toasts.push(`${user.displayName} was timed out`, 'success');
      setTimeoutPromptOpen(false);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Timeout failed', 'error');
    } finally {
      setTimeoutPending(false);
    }
  }

  async function clearTimeoutNow() {
    if (!guildId || timeoutPending) return;
    setTimeoutPending(true);
    try {
      await rest.patchMember(guildId, user.id, { communicationDisabledUntil: null });
      void loadMembers(guildId).catch(() => undefined);
      toasts.push(`Timeout cleared for ${user.displayName}`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Failed to clear timeout', 'error');
    } finally {
      setTimeoutPending(false);
    }
  }

  async function kickMember() {
    if (!guildId || kickPending) return;
    // Light confirmation — kicks aren't catastrophic (the user can be
    // re-invited) but they ARE disruptive, so a one-tap confirm guards
    // against accidental clicks. Browser prompt is intentionally
    // basic — adding a custom dialog for one action would be
    // disproportionate. Falls through with no kick if the user cancels.
    if (!confirm(`Kick ${user.displayName} from ${guild?.name ?? 'this server'}?`)) return;
    setKickPending(true);
    try {
      await rest.kickMember(guildId, user.id);
      void loadMembers(guildId).catch(() => undefined);
      toasts.push(`${user.displayName} was kicked`, 'success');
      onClose();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Kick failed', 'error');
    } finally {
      setKickPending(false);
    }
  }

  async function banMember() {
    if (!guildId || banPending) return;
    setBanPending(true);
    try {
      // Reason is optional; empty string normalizes to null so the
      // server doesn't store an empty string distinct from "no reason
      // given". Trim first so whitespace-only inputs collapse the
      // same way.
      const trimmed = banReason.trim();
      await rest.banMember(guildId, user.id, {
        reason: trimmed.length > 0 ? trimmed : null,
      });
      void loadMembers(guildId).catch(() => undefined);
      toasts.push(`${user.displayName} was banned`, 'success');
      onClose();
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Ban failed', 'error');
      setBanPending(false);
    }
    // We don't reset banPending on success — the card is closing.
  }

  // File a report against this user. Only meaningful in a guild context (the
  // report route is scoped to a guild); the button that opens this is gated on
  // targetMember being present. Reason AND details are both required —
  // mirrors iOS ReportUserSheet's canSubmit gate.
  async function submitReport() {
    const trimmed = reportDetails.trim();
    if (!guildId || reportPending || !reportReason || trimmed.length === 0) return;
    setReportPending(true);
    try {
      await rest.createReport(guildId, {
        targetType: 'user',
        targetUserId: user.id,
        reason: reportReason,
        details: trimmed,
      });
      toasts.push(`Report submitted for ${user.displayName}`, 'success');
      setReportPromptOpen(false);
      setReportDetails('');
      setReportReason('');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not submit report', 'error');
    } finally {
      setReportPending(false);
    }
  }

  // Relationship status from the AppState store — hydrated on connect
  // (loadRelationships) and kept live via RELATIONSHIP_UPSERT/REMOVE +
  // optimistic applyRelationship. Avoids a per-open listRelationships()
  // round-trip whose O(N) payload is already in memory. Falls back to a one-
  // shot fetch only on the rare pre-bootstrap open. Skipped for self.
  useEffect(() => {
    if (isSelf) return;
    if (state.loadedRelationships) {
      const found = state.relationships.find((x) => x.user.id === user.id);
      setRel((found?.type as RelType) ?? 'none');
      return;
    }
    let cancelled = false;
    rest
      .listRelationships()
      .then((r) => {
        if (cancelled) return;
        const found = r.relationships.find((x) => x.user.id === user.id);
        setRel((found?.type as RelType) ?? 'none');
      })
      .catch(() => {
        // Silent failure — the card still renders, action buttons just
        // default to "Add friend" / "Block" which the server reconciles.
      });
    return () => {
      cancelled = true;
    };
  }, [rest, user.id, isSelf, state.loadedRelationships, state.relationships]);

  // Esc closes the page.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  async function openDM() {
    try {
      const r = await rest.openDM(user.id);
      onClose();
      nav(`/channels/@me/${r.channel.id}`);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not open DM', 'error');
    }
  }

  /**
   * Resolve-or-create the 1:1 DM with this user, navigate into it,
   * then start a voice call. Three-step flow with one possible
   * failure per step:
   *   1. openDM — backend creates or returns the existing DM channel
   *   2. joinVoice — server adds us to the voice state row + mints
   *      a LiveKit token
   *   3. connectToVoice — WebRTC handshake
   *
   * If step 2 or 3 fails, we still navigate into the DM (step 1
   * succeeded) so the user lands in a familiar context and can
   * retry from the DmCallBar's idle button. Without that fallback
   * a transient LiveKit error would leave them stranded on the
   * profile card with no obvious next step.
   */
  async function startVoiceCall() {
    if (pending) return;
    setPending(true);
    // Prime shared audio context inside the click — see voice.prepareVoiceAudio.
    prepareVoiceAudio();
    // Held outside the try so the finally can release exactly the claim we
    // made — the DM channel isn't known until openDM resolves.
    let claimed: string | null = null;
    try {
      const dm = await rest.openDM(user.id);
      onClose();
      nav(`/channels/@me/${dm.channel.id}`);
      // Claim the target BEFORE the REST call — the server dispatches our
      // VOICE_STATE_UPDATE over the gateway before it writes the join
      // response, so the echo can land ahead of connectToVoice and look
      // like a moderator move to the self-move detector.
      claimed = dm.channel.id;
      claimVoiceChannel(claimed);
      try {
        const r = await rest.joinVoice(dm.channel.id);
        mergeChannelVoiceStates(dm.channel.id, r.channelVoiceStates);
        if (r.token && r.wsUrl) {
          await connectToVoice({
            token: r.token,
            wsUrl: r.wsUrl,
            sessionId: r.voiceState.sessionId,
            channelId: dm.channel.id,
            isDmCall: true,
            backgroundTitle: `Call with ${user.displayName || user.username}`,
            // 1:1 DM with E2EE on → encrypt the call media with the same
            // shared key the DM uses for messages.
            ...(dm.channel.e2eeEnabled
              ? { e2ee: { channelId: dm.channel.id, verifier: dm.channel.e2eeVerifier } }
              : {}),
          });
        } else {
          toasts.push('Voice isn’t set up on this server yet, so there’s no audio. Ask the server admin to enable voice.', 'info');
        }
      } catch (e) {
        // Roll back the server-side join so a failed media connect doesn't
        // leave a ghost participant. Harmless no-op if joinVoice itself
        // failed. The gateway echoes the leave. Best-effort.
        void rest.leaveVoice(dm.channel.id).catch(() => {});
        toasts.push(
          e instanceof VoiceError
            ? e.message
            : e instanceof ApiError
              ? e.message
              : 'Could not start the call',
          'error',
        );
      }
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Could not open DM', 'error');
    } finally {
      // connectToVoice releases the claim when it settles, but the
      // openDM-failed / REST-failed / no-token paths never reach it — a
      // stranded claim would make getConnectedChannelId() lie forever.
      if (claimed) releaseVoiceChannel(claimed);
      setPending(false);
    }
  }

  async function addFriend() {
    if (pending) return;
    setPending(true);
    try {
      const r = await rest.sendFriendRequest(user.id);
      setRel(r.type);
      applyRelationship(user, r.type);
      toasts.push(
        r.type === 'friend' ? 'Friend request accepted' : 'Friend request sent',
        'success',
      );
    } catch (e) {
      const restricted =
        e instanceof ApiError &&
        (e.details as { supervisionRestricted?: string } | undefined)?.supervisionRestricted ===
          'friend';
      if (restricted) {
        try {
          await rest.familyRequestFriend(user.id);
          toasts.push('Asked your parent to approve this friend', 'success');
        } catch (e2) {
          toasts.push(
            e2 instanceof ApiError ? e2.message : "Couldn't send the request",
            'error',
          );
        }
      } else {
        toasts.push(e instanceof ApiError ? e.message : 'Friend request failed', 'error');
      }
    } finally {
      setPending(false);
    }
  }

  async function acceptRequest() {
    if (pending) return;
    setPending(true);
    try {
      await rest.acceptFriendRequest(user.id);
      setRel('friend');
      applyRelationship(user, 'friend');
      toasts.push('Friend request accepted', 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Accept failed', 'error');
    } finally {
      setPending(false);
    }
  }

  async function removeRel() {
    if (pending) return;
    setPending(true);
    try {
      await rest.removeFriend(user.id);
      setRel('none');
      applyRelationship(user, null);
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Action failed', 'error');
    } finally {
      setPending(false);
    }
  }

  async function block() {
    if (pending) return;
    setPending(true);
    try {
      await rest.blockUser(user.id);
      setRel('blocked');
      applyRelationship(user, 'blocked');
      toasts.push(`${user.displayName} blocked`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Block failed', 'error');
    } finally {
      setPending(false);
    }
  }

  async function unblock() {
    if (pending) return;
    setPending(true);
    try {
      await rest.unblockUser(user.id);
      setRel('none');
      applyRelationship(user, null);
      toasts.push(`${user.displayName} unblocked`, 'success');
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Unblock failed', 'error');
    } finally {
      setPending(false);
    }
  }

  // Highest role's color for the display name (mirrors iOS store.memberColor
  // and the MemberList treatment). Only resolves in a guild context once the
  // role list + target member are loaded; falls back to text-ink-1.
  const nameColor =
    guildId && allRoles && targetMember
      ? memberDisplayColor(allRoles, guildId, targetMember.roleIds)
      : null;

  // Live presence — the `user` prop is a snapshot from click time, but
  // PRESENCE_PATCH keeps state.userStatusById fresh; read through it so the
  // dot tracks status changes while the card is open (mirrors iOS
  // store.status(for:fallback:), MessageViews.swift liveStatus).
  const liveStatus = state.userStatusById[user.id] ?? user.status;
  const dotColor =
    liveStatus === 'online'
      ? 'bg-emerald-500'
      : liveStatus === 'idle'
        ? 'bg-amber-500'
        : liveStatus === 'dnd'
          ? 'bg-red-500'
          : 'bg-ink-3';

  return (
    <Portal>
      {/* Profile is its own page OVERLAID on the main content — a server-
          settings-style modal: a dimmed backdrop (click-outside or Esc closes)
          and a centered panel with a floating X close button. */}
      <div
        className="fixed inset-0 bg-black/60 z-[80] flex items-stretch sm:items-center justify-center sm:p-4"
        onClick={onClose}
      >
        <div
          className="relative bg-bg-1 border border-line elevation-pop w-full h-full sm:h-auto sm:max-h-[85vh] overflow-y-auto overflow-x-hidden sm:rounded-lg"
          style={{ maxWidth: CARD_WIDTH }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            onClick={onClose}
            className="absolute top-2 right-2 z-10 w-8 h-8 flex items-center justify-center rounded-full bg-black/40 text-white hover:bg-black/60 transition-colors"
            aria-label="Close"
          >
            <X size={16} />
          </button>
        {/* Banner — container locked at 16:10 to match the iOS profile
            header's banner shape. The image fills edge-to-edge
            (object-cover) like iOS (.fill + clipped) rather than
            letterboxing. */}
        <div className="aspect-[16/10] relative">
          {/* No-banner fallback: branded accent→accent2 gradient (matches the
              iOS profileHeader banner). Sits behind the <img> so an uploaded
              banner still wins; the image uses object-cover to fill edge-to-edge
              like iOS (.fill + clipped) rather than letterboxing. */}
          <div
            className="absolute inset-0"
            style={{
              background:
                'linear-gradient(to right, rgb(var(--c-accent) / 0.55), rgb(var(--c-accent-2) / 0.45))',
            }}
          />
          {bannerUrl && (
            <img
              src={bannerUrl}
              alt=""
              className="absolute inset-0 w-full h-full object-cover"
              draggable={false}
            />
          )}

          {/* Custom status floats INSIDE the banner (bottom-left, cleared of the
              avatar), its tail pointing left at the avatar — mirrors the iOS
              profile card. Keeping it here (not in the name column) is what
              keeps the display name OUT of the banner. */}
          {(() => {
            const cs = formatCustomStatus(user);
            if (!cs.emoji && !cs.text) return null;
            return (
              <div className="absolute bottom-2 left-[96px] right-3 flex justify-start">
                <div className="relative inline-flex items-center gap-1.5 max-w-full rounded-[11px] bg-bg-3 border border-line pl-3 pr-2.5 py-1 shadow-sm">
                  {cs.emoji && <span className="text-sm leading-none shrink-0">{cs.emoji}</span>}
                  {cs.text && (
                    <span className="text-xs font-medium text-ink-1 line-clamp-2">{cs.text}</span>
                  )}
                  <svg
                    width="9"
                    height="14"
                    viewBox="0 0 9 14"
                    className="absolute right-full top-1/2 -translate-y-1/2 -mr-px"
                    aria-hidden
                  >
                    <path d="M8 1 L0 7 L8 13 Z" style={{ fill: 'rgb(var(--c-bg-3))' }} />
                    <path
                      d="M8 1 L0 7 L8 13"
                      fill="none"
                      style={{ stroke: 'rgb(var(--c-line))' }}
                      strokeWidth="1"
                      strokeLinejoin="round"
                    />
                  </svg>
                </div>
              </div>
            );
          })()}
        </div>

        <div className="px-4 pb-4">
          {/* Avatar + identity row, BELOW the banner (mirrors iOS): ONLY the
              avatar overhangs up into the banner (-mt-10); the name + @username
              sit below the banner and flow downward, so a long name / multi-line
              status can never spill onto the banner image. */}
          <div className="flex items-start gap-3">
            <div className="relative w-20 h-20 shrink-0 -mt-10">
              <div
                className={`relative w-20 h-20 rounded-full border-4 border-bg-1 flex items-center justify-center text-xl font-semibold overflow-hidden ${avatarColor(user.id)}`}
              >
                <span aria-hidden="true" className="zk-avatar-initials">{avatarInitials(user.displayName)}</span>
                <AvatarImage src={user.avatarUrl} />
              </div>
              <AvatarDecoration
                decoration={user.avatarDecoration}
                className="absolute inset-[3px] rounded-full pointer-events-none"
              />
              <span
                className={`absolute bottom-0 right-0 z-10 w-5 h-5 rounded-full border-4 border-bg-1 ${dotColor}`}
                aria-hidden
              />
            </div>

            {/* Name + handle, to the right of the avatar's lower half. min-w-0
                so long names truncate instead of pushing the layout. Nudged a
                touch tighter to the avatar (3px left, 2px up). */}
            <div className="min-w-0 flex-1 pt-2 -ml-[3px] -mt-[2px]">
              <div className="flex items-center gap-1.5">
                <UserTag user={user} className="-mr-1" />
                {/* Role color rides on StaffName's roleColor prop (same as
                    MemberList) so the staff shimmer still wins when present —
                    .zk-staff-shimmer forces `color: transparent !important`. */}
                <StaffName
                  user={user}
                  text={user.displayName}
                  roleColor={nameColor}
                  className="text-xl font-bold text-ink-1 truncate"
                />
                {user.isBot && (
                  <span
                    className="shrink-0 inline-flex items-center px-1.5 rounded bg-accent/20 text-accent text-[0.55rem] font-bold uppercase tracking-wider leading-[1.1rem]"
                    title="Bot account"
                  >
                    Bot
                  </span>
                )}
                {/* Supporter tier title — ships on the full-profile fetch only
                    (and only when the user hasn't opted out of showing it). */}
                <TierBadge tier={fullProfile?.subscriptionTier ?? user.subscriptionTier} />
              </div>
              <div className="text-sm text-ink-3 truncate">@{user.username}</div>
            </div>
          </div>

          {(() => {
            // Bio ("ABOUT ME") — falls back to the lazily-fetched full profile
            // when the lightweight member object omits it.
            const bioText = (user.bio ?? fullProfile?.bio ?? '').trim();
            if (!bioText) return null;
            return (
              <div className="mt-3">
                <div className="text-[11px] font-semibold tracking-wide text-ink-3 mb-1">
                  ABOUT ME
                </div>
                <div className="text-sm text-ink-2 whitespace-pre-wrap break-words">{bioText}</div>
              </div>
            );
          })()}

          {/* Your OWN card has no action stack to sit inside, so the (collapsed)
              achievements row lives here. For other users it is rendered down in
              the actions, between Message/Call and the friend action. */}
          {isSelf && (
            <div className="mt-3">
              <AchievementsShelf earnedOnly collapsible />
            </div>
          )}

          {/* Message / Call / friend actions — only for OTHER users. Your own
              card just shows your profile (no "this is you" filler). */}
          {!isSelf && (
            <>
              <div className="mt-3 border-t border-line" />
              <div className="mt-3 flex flex-col gap-1.5">
              {/* Message + Call as a side-by-side primary pair, accent-filled
                  to read as the prominent "reach out" actions — matching the
                  iOS profile card (Message FIRST, both accent). Each is flex-1
                  so they split the width evenly. The friend-action button
                  stacks below as its own full-width row. */}
              {rel !== 'blocked' && (canMessage === true || rel === 'friend') && (
                <div className="flex gap-1.5">
                  <button
                    onClick={() => void openDM()}
                    className="flex-1 px-3 py-2 rounded-md bg-accent hover:brightness-110 text-sm font-semibold text-white transition-all text-center"
                  >
                    Message
                  </button>
                  <button
                    disabled={pending}
                    onClick={() => void startVoiceCall()}
                    className="flex-1 px-3 py-2 rounded-md bg-accent hover:brightness-110 text-sm font-semibold text-white transition-all disabled:opacity-60 text-center"
                    title={`Call ${user.displayName || user.username}`}
                  >
                    Call
                  </button>
                </div>
              )}

              {/* Achievements — a collapsed disclosure row sandwiched between
                  the Message/Call pair and the friend action, per the requested
                  placement. Closed by default: it used to render every earned
                  badge inline, which made the card far taller than it needed to
                  be and pushed these actions down. */}
              <AchievementsShelf userId={user.id} earnedOnly collapsible />

              {/* Friend action — depends on current relationship.
                  Stacks below the Message/Call pair so it's clearly
                  separate from the primary reach-out actions. */}
              {rel === 'none' && (
                <button
                  disabled={pending}
                  onClick={() => void addFriend()}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors disabled:opacity-60"
                >
                  <UserPlus size={14} />
                  <span>Add friend</span>
                </button>
              )}
              {rel === 'incoming_request' && (
                <button
                  disabled={pending}
                  onClick={() => void acceptRequest()}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors disabled:opacity-60"
                >
                  <UserPlus size={14} />
                  <span>Accept friend request</span>
                </button>
              )}
              {rel === 'outgoing_request' && (
                <button
                  disabled={pending}
                  onClick={() => void removeRel()}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm text-ink-2 transition-colors disabled:opacity-60"
                >
                  <X size={14} />
                  <span>Cancel friend request</span>
                </button>
              )}
              {rel === 'friend' && (
                <button
                  disabled={pending}
                  onClick={() => void removeRel()}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm text-ink-2 transition-colors disabled:opacity-60"
                >
                  <UserMinus size={14} />
                  <span>Remove friend</span>
                </button>
              )}

              {/* Block / unblock — destructive treatment. Always visible. */}
              {rel === 'blocked' ? (
                <button
                  disabled={pending}
                  onClick={() => void unblock()}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-2 transition-colors disabled:opacity-60"
                >
                  <Shield size={14} />
                  <span>Unblock</span>
                </button>
              ) : (
                <button
                  disabled={pending}
                  onClick={() => void block()}
                  className="flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-red-950/40 text-sm font-medium text-red-400 transition-colors disabled:opacity-60"
                >
                  <Shield size={14} />
                  <span>Block</span>
                </button>
              )}

              {/* Report User — for guild members you aren't friends with, mirrors
                  the iOS danger-tinted 'Report User' action. Opens an inline
                  reason picker (scoped to the current guild's report queue). */}
              {targetMember && rel !== 'friend' && !reportPromptOpen && (
                <button
                  disabled={pending}
                  onClick={() => setReportPromptOpen(true)}
                  className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-red-950/40 text-sm font-medium text-red-400 transition-colors disabled:opacity-60"
                >
                  <FlagIcon size={14} />
                  <span>Report User</span>
                </button>
              )}

              {reportPromptOpen && (
                <div className="mt-1 pt-3 border-t border-line space-y-2">
                  <div className="text-xs text-ink-2">
                    Report {user.displayName} to the server moderators
                  </div>
                  <select
                    value={reportReason}
                    onChange={(e) => setReportReason(e.target.value as typeof reportReason)}
                    className="w-full px-3 py-1.5 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-red-400"
                  >
                    <option value="" disabled>
                      Choose a reason
                    </option>
                    <option value="spam">Spam</option>
                    <option value="harassment">Harassment</option>
                    <option value="nsfw">NSFW</option>
                    <option value="violence">Violence or threats</option>
                    <option value="other">Other</option>
                  </select>
                  <input
                    type="text"
                    value={reportDetails}
                    onChange={(e) => setReportDetails(e.target.value)}
                    maxLength={1000}
                    placeholder="Describe why you're reporting this user…"
                    className="w-full px-3 py-1.5 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-red-400"
                  />
                  <div className="text-[11px] text-ink-3 text-right">
                    {reportDetails.length}/1000
                  </div>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      disabled={
                        reportPending || !reportReason || reportDetails.trim().length === 0
                      }
                      onClick={() => void submitReport()}
                      className="flex-1 px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-60"
                    >
                      {reportPending ? 'Submitting…' : 'Submit report'}
                    </button>
                    <button
                      type="button"
                      disabled={reportPending}
                      onClick={() => setReportPromptOpen(false)}
                      className="px-3 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-ink-2 text-sm disabled:opacity-60"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              {/* Private DM nickname ("only you") — a viewer-private label
                  shown for this person in DMs. The entry point is available on
                  any other non-bot user's card, including cards opened from a
                  server (mirrors iOS); the nickname itself still only renders
                  in DMs. (Server/member nicknames were removed — don't re-add.) */}
              {!user.isBot &&
                (editingDmNick ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={dmNickDraft}
                      maxLength={32}
                      onChange={(e) => setDmNickDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') void saveDmNickname();
                        if (e.key === 'Escape') setEditingDmNick(false);
                      }}
                      placeholder="Nickname (only you, in DMs)"
                      className="min-w-0 flex-1 text-sm bg-bg-3 border border-line rounded-md px-2 py-2 text-ink-1"
                    />
                    <button
                      type="button"
                      onClick={() => void saveDmNickname()}
                      className="shrink-0 text-sm px-3 py-2 rounded-md bg-accent/20 text-ink-1 hover:bg-accent/30"
                    >
                      Save
                    </button>
                    <button
                      type="button"
                      onClick={() => setEditingDmNick(false)}
                      className="shrink-0 text-sm px-3 py-2 rounded-md text-ink-3 hover:bg-bg-3"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setDmNickDraft(dmNickname);
                      setEditingDmNick(true);
                    }}
                    className="w-full flex items-center gap-2 px-3 py-2 rounded-md bg-bg-3 hover:bg-bg-3/80 text-sm font-medium text-ink-1 transition-colors"
                    title="A nickname only you see, shown in direct messages"
                  >
                    <Edit size={14} className="shrink-0" />
                    <span className="truncate">
                      {dmNickname ? 'Edit Nickname' : 'Set Nickname'}
                    </span>
                  </button>
                ))}
            </div>
            </>
          )}

          {/* ── Roles (guild owner only) ───────────────────────────────
              We surface this below the social actions because in
              practice owners use the card to adjust roles much less
              often than they use it for messaging or moderation. The
              checkbox grid uses each role's color as the visual key so
              it's instantly readable. The panel auto-hides when the
              guild has no assignable roles yet (other than @everyone). */}
          {/* ── Moderation row ────────────────────────────────────────
              Kick / Ban / Timeout. Each gated independently. The kick
              action uses a browser confirm() — disruptive but not
              catastrophic (the user can be re-invited), so a one-tap
              confirm is the right level of friction. */}
          {showModRow && (
            <div className="mt-3 pt-3 border-t border-line flex flex-col gap-1.5">
              {can.timeout && !timeoutPromptOpen && (
                timeoutActiveUntil ? (
                  // Already timed out — show a clear button instead.
                  <button
                    disabled={timeoutPending}
                    onClick={() => void clearTimeoutNow()}
                    className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-amber-950/40 text-sm font-medium text-amber-300 transition-colors disabled:opacity-60"
                  >
                    <Clock size={14} />
                    <span>
                      {timeoutPending ? 'Clearing…' : `Clear timeout (ends ${timeoutActiveUntil.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })})`}
                    </span>
                  </button>
                ) : (
                  <button
                    disabled={timeoutPending}
                    onClick={() => setTimeoutPromptOpen(true)}
                    className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-amber-950/40 text-sm font-medium text-amber-300 transition-colors disabled:opacity-60"
                  >
                    <Clock size={14} />
                    <span>Time out</span>
                  </button>
                )
              )}
              {can.kick && (
                <button
                  disabled={kickPending}
                  onClick={() => void kickMember()}
                  className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-red-950/40 text-sm font-medium text-red-400 transition-colors disabled:opacity-60"
                >
                  <Trash size={14} />
                  <span>{kickPending ? 'Kicking…' : 'Kick from server'}</span>
                </button>
              )}
              {can.ban && !banPromptOpen && (
                <button
                  disabled={banPending}
                  onClick={() => {
                    setBanReason('');
                    setBanPromptOpen(true);
                  }}
                  className="flex items-center gap-2 px-3 py-2 rounded-md hover:bg-red-950/40 text-sm font-medium text-red-400 transition-colors disabled:opacity-60"
                >
                  <BanIcon size={14} />
                  <span>Ban from server</span>
                </button>
              )}
            </div>
          )}

          {/* Timeout duration picker. Six preset durations covering
              the practical range — anything longer should be a ban.
              Each chip is single-tap commit (no separate confirm)
              because the mod has already opted in by opening the
              prompt, and timeouts are reversible via Clear. */}
          {can.timeout && timeoutPromptOpen && (
            <div className="mt-3 pt-3 border-t border-line space-y-2">
              <div className="text-xs text-ink-2">
                Time out {user.displayName} for…
              </div>
              <div className="flex flex-wrap gap-1.5">
                {[
                  { label: '60s', seconds: 60 },
                  { label: '5m', seconds: 5 * 60 },
                  { label: '10m', seconds: 10 * 60 },
                  { label: '1h', seconds: 60 * 60 },
                  { label: '1d', seconds: 24 * 60 * 60 },
                  { label: '1w', seconds: 7 * 24 * 60 * 60 },
                ].map((opt) => (
                  <button
                    key={opt.seconds}
                    disabled={timeoutPending}
                    onClick={() => void applyTimeout(opt.seconds)}
                    className="px-3 py-1 rounded-md bg-amber-900/30 hover:bg-amber-900/50 text-xs font-medium text-amber-200 transition-colors disabled:opacity-60"
                  >
                    {opt.label}
                  </button>
                ))}
                <button
                  disabled={timeoutPending}
                  onClick={() => setTimeoutPromptOpen(false)}
                  className="px-3 py-1 rounded-md bg-bg-2 hover:bg-bg-3 text-xs text-ink-2 transition-colors disabled:opacity-60 ml-auto"
                >
                  Cancel
                </button>
              </div>
              <p className="text-xs text-ink-3 leading-relaxed">
                The member won't be able to send messages, react, or join voice while timed out. You can clear the timeout at any time.
              </p>
            </div>
          )}

          {/* Ban prompt — inline rather than a separate modal because
              the ProfileCard itself is already a popover and stacking
              modal-on-popover is awkward on mobile. Reason is optional;
              "Ban" submits, "Cancel" backs out without firing the
              REST call. Distinct from Kick's browser-confirm because
              bans are stickier and benefit from the reason field. */}
          {can.ban && banPromptOpen && (
            <div className="mt-3 pt-3 border-t border-line space-y-2">
              <label className="block">
                <span className="text-xs text-ink-2">
                  Reason (optional, visible to other moderators)
                </span>
                <input
                  type="text"
                  autoFocus
                  value={banReason}
                  onChange={(e) => setBanReason(e.target.value)}
                  maxLength={512}
                  placeholder="e.g. spam, harassment"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault();
                      void banMember();
                    } else if (e.key === 'Escape') {
                      e.preventDefault();
                      setBanPromptOpen(false);
                    }
                  }}
                  className="mt-1 w-full px-3 py-1.5 bg-bg-2 border border-line rounded-md text-sm outline-none focus:border-red-400"
                />
              </label>
              <p className="text-xs text-ink-3 leading-relaxed">
                Banning {user.displayName} removes them from{' '}
                {guild?.name ?? 'this server'} and prevents them from
                re-joining until you lift the ban.
              </p>
              <div className="flex gap-2">
                <button
                  type="button"
                  disabled={banPending}
                  onClick={() => void banMember()}
                  className="flex-1 px-3 py-1.5 rounded-md bg-red-600 hover:bg-red-700 text-white text-sm font-medium disabled:opacity-60"
                >
                  {banPending ? 'Banning…' : `Ban ${user.displayName}`}
                </button>
                <button
                  type="button"
                  disabled={banPending}
                  onClick={() => setBanPromptOpen(false)}
                  className="px-3 py-1.5 rounded-md bg-bg-3 hover:bg-bg-3/80 text-ink-2 text-sm disabled:opacity-60"
                >
                  Cancel
                </button>
              </div>
            </div>
          )}

          {/* Inline nickname editor: replaces the mod row when active.
              Enter saves; Esc cancels. We commit empty input as a
              clear (PATCH nickname=null) so users can drop a custom
              nickname back to their display name without a separate
              affordance. */}
          {/* ── Roles (gated by MANAGE_ROLES + hierarchy) ─────────────
              Per-role hierarchy: each row is enabled only when the
              viewer can manage that specific role (role.position must
              be strictly less than the viewer's highest role's
              position; owner bypasses). Roles above the viewer's
              ceiling are still rendered (so the viewer sees the
              target's full role set) but with their checkbox
              disabled. */}
          {showRolePanel && (
            <div className="mt-4 pt-3 border-t border-line">
              <div className="text-[0.65rem] uppercase tracking-wider text-ink-3 mb-2">
                Roles in {guild?.name ?? 'this server'}
              </div>
              {(() => {
                if (allRoles === null) {
                  return <div className="text-xs text-ink-3 italic">Loading roles…</div>;
                }
                // Drop @everyone (not assignable), sort highest position first.
                const assignable = allRoles
                  .filter((role) => role.id !== guildId)
                  .sort((a, b) => b.position - a.position);
                if (assignable.length === 0) {
                  return (
                    <div className="text-xs text-ink-3 italic">
                      This server has no assignable roles yet.
                    </div>
                  );
                }
                return (
                  <ul className="space-y-1 max-h-44 overflow-y-auto scrollbar-thin pr-1">
                    {assignable.map((role) => {
                      const checked = memberRoleIds.includes(role.id);
                      const busy = rolePending.has(role.id);
                      // Hierarchy: viewer can only manage roles below
                      // their highest role (owners bypass). For
                      // self-actions we additionally allow UNCHECKING
                      // a role the viewer already has — stepping down
                      // is always permitted, even from your own top
                      // role. Mirrors the server's softened self-rule
                      // for toRemove (see routes/guilds.ts patch
                      // member). The strict ADD check still applies
                      // for roles the viewer doesn't currently have.
                      const canTouchRole =
                        isOwner ||
                        role.position < viewerHighestPos ||
                        (isSelf && checked);
                      const disabled = busy || !canTouchRole;
                      const color = role.color
                        ? '#' + role.color.toString(16).padStart(6, '0')
                        : '#99aab5';
                      return (
                        <li key={role.id}>
                          <label
                            className={`flex items-center gap-2 px-2 py-1.5 rounded transition-colors ${
                              disabled ? 'cursor-not-allowed' : 'cursor-pointer'
                            } ${
                              checked ? 'bg-bg-3' : !disabled ? 'hover:bg-bg-3/60' : ''
                            } ${busy ? 'opacity-60 cursor-wait' : !canTouchRole ? 'opacity-50' : ''}`}
                            title={!canTouchRole ? 'You need a higher role to manage this' : undefined}
                          >
                            <input
                              type="checkbox"
                              checked={checked}
                              disabled={disabled}
                              onChange={() => void toggleRole(role.id)}
                              className="shrink-0 w-3.5 h-3.5 rounded accent-accent"
                            />
                            <span
                              aria-hidden
                              className="shrink-0 w-2.5 h-2.5 rounded-full"
                              style={{ backgroundColor: color }}
                            />
                            <span className="text-sm text-ink-1 truncate flex-1">
                              {role.name}
                            </span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                );
              })()}
            </div>
          )}
        </div>
        </div>
      </div>
    </Portal>
  );
}
