/**
 * BrowseRolesModal
 * ----------------
 * Member-facing UI for opting into / out of self-assignable roles.
 * Loads the guild's self-assignable role list on mount and renders
 * one toggle per role. Optimistic — toggles flip instantly and revert
 * on network failure.
 *
 * Triggered from GuildInfoCard's menu. Dismissible (unlike the
 * OnboardingModal, which gates participation behind acknowledgment).
 *
 * Pending-onboarding members are blocked at the server. Defensive
 * client-side: we don't disable the toggles when pending, because
 * the OnboardingModal renders on top of everything and the user
 * shouldn't be reaching this UI in the first place; if they
 * somehow do (deep link, race), the server's 403 surfaces as a
 * toast and the optimistic flip reverts.
 */
import { useState, useEffect, useMemo } from 'react';
import { ApiError, type Guild, type Role } from '@zekktris/client';
import { useAuth } from '../auth/AuthContext';
import { useAppState } from '../state/AppState';
import { useToasts } from '../state/Toasts';
import { Portal } from '../lib/Portal';
import { X, Shield } from '../lib/icons';

export function BrowseRolesModal({
  guild,
  onClose,
}: {
  guild: Guild;
  onClose: () => void;
}) {
  const { rest, user } = useAuth();
  const { state } = useAppState();
  const toasts = useToasts();
  const [roles, setRoles] = useState<Role[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Track in-flight toggles so the user can't double-tap a row mid-
  // request. The toggle visual stays on the optimistic state; this
  // gate just prevents the second click from launching a duplicate
  // round-trip.
  const [busy, setBusy] = useState<Set<string>>(() => new Set());

  // Load the list on mount.
  useEffect(() => {
    let cancelled = false;
    rest
      .listSelfAssignableRoles(guild.id)
      .then((r) => {
        if (!cancelled) setRoles(r.roles);
      })
      .catch((e) => {
        if (!cancelled) {
          setError(e instanceof ApiError ? e.message : 'Could not load roles');
          setRoles([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [rest, guild.id]);

  // Close on Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  // Body scroll lock while open.
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, []);

  // Set of role ids the current user already has — used to decide
  // whether each toggle is on or off. Read off the eagerly-loaded
  // member list. The gateway broadcast on assign/revoke updates
  // this via the reducer, so the toggles reflect the live state.
  const heldRoleIds = useMemo(() => {
    const myMember = state.membersByGuild[guild.id]?.find((m) => m.userId === user?.id);
    return new Set(myMember?.roleIds ?? []);
  }, [state.membersByGuild, guild.id, user?.id]);

  async function toggle(role: Role) {
    if (busy.has(role.id)) return;
    setBusy((prev) => new Set(prev).add(role.id));
    const isHeld = heldRoleIds.has(role.id);
    try {
      if (isHeld) {
        await rest.revokeSelfRole(guild.id, role.id);
      } else {
        await rest.assignSelfRole(guild.id, role.id);
      }
      // The server broadcasts guildMemberUpdate; the reducer flips
      // our membersByGuild entry, which flips heldRoleIds, which
      // flips the visible toggle. No optimistic local mutation
      // needed — the broadcast round-trip is fast enough that the
      // visual lag is acceptable, and avoiding optimistic state
      // sidesteps the consistency issue of "optimistic on, server
      // returns 403, what state do we revert to?"
    } catch (e) {
      toasts.push(e instanceof ApiError ? e.message : 'Update failed', 'error');
    } finally {
      setBusy((prev) => {
        const next = new Set(prev);
        next.delete(role.id);
        return next;
      });
    }
  }

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 bg-bg-1/85 backdrop-blur-sm flex items-center justify-center p-4"
        role="dialog"
        aria-modal="true"
        aria-labelledby="browse-roles-title"
        onClick={(e) => {
          // Click on backdrop closes; clicks on the dialog card don't.
          if (e.target === e.currentTarget) onClose();
        }}
      >
        <div className="zk-modal bg-bg-2 border border-line w-full max-w-lg max-h-[80vh] flex flex-col shadow-2xl">
          {/* Header */}
          <div className="px-5 py-3 border-b border-line flex items-center gap-3 shrink-0">
            <span className="w-8 h-8 rounded-full bg-accent/15 flex items-center justify-center shrink-0">
              <Shield size={16} className="text-accent" />
            </span>
            <div className="min-w-0 flex-1">
              <h2 id="browse-roles-title" className="text-base font-semibold text-ink-1 truncate">
                Browse Roles
              </h2>
              <p className="text-xs text-ink-3 mt-0.5 truncate">
                Pick which opt-in groups you want to join in {guild.name}
              </p>
            </div>
            <button
              onClick={onClose}
              className="shrink-0 w-7 h-7 rounded-md hover:bg-bg-3 text-ink-2 flex items-center justify-center transition-colors"
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            {roles === null ? (
              <p className="text-sm text-ink-3">Loading roles…</p>
            ) : error ? (
              <p className="text-sm text-red-300">{error}</p>
            ) : roles.length === 0 ? (
              <div className="rounded-md border border-line bg-bg-2/50 px-4 py-6 text-center">
                <p className="text-sm text-ink-2 mb-1">No opt-in roles yet</p>
                <p className="text-xs text-ink-3">
                  Server admins can add opt-in roles in server settings.
                </p>
              </div>
            ) : (
              <ul className="space-y-1.5">
                {roles.map((role) => {
                  const isHeld = heldRoleIds.has(role.id);
                  const isBusy = busy.has(role.id);
                  const dotColor =
                    role.color > 0
                      ? `#${role.color.toString(16).padStart(6, '0')}`
                      : 'var(--color-ink-3)';
                  return (
                    <li
                      key={role.id}
                      className={`flex items-start gap-3 px-3 py-2.5 rounded-md border transition-colors ${
                        isHeld
                          ? 'border-accent/50 bg-accent/5'
                          : 'border-line bg-bg-2/40 hover:bg-bg-2/70'
                      }`}
                    >
                      <span
                        className="shrink-0 w-3 h-3 rounded-full mt-1.5"
                        style={{ backgroundColor: dotColor }}
                        aria-hidden
                      />
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-ink-1 truncate">{role.name}</div>
                        {role.description && (
                          <div className="text-xs text-ink-3 mt-0.5 leading-relaxed">
                            {role.description}
                          </div>
                        )}
                      </div>
                      <button
                        onClick={() => void toggle(role)}
                        disabled={isBusy}
                        className={`shrink-0 w-9 h-5 rounded-full transition-colors relative ${
                          isHeld ? 'bg-accent/70' : 'bg-bg-3'
                        } ${isBusy ? 'opacity-60 cursor-wait' : 'cursor-pointer'}`}
                        aria-label={isHeld ? `Remove ${role.name}` : `Add ${role.name}`}
                        aria-pressed={isHeld}
                        title={isHeld ? 'Click to remove this role' : 'Click to add this role'}
                      >
                        <span
                          className={`absolute top-0.5 w-4 h-4 rounded-full bg-ink-1 transition-transform ${
                            isHeld ? 'translate-x-[18px]' : 'translate-x-0.5'
                          }`}
                        />
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}
