import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  channelOverridePermissions,
  computeMemberGuildPerms,
  hasBit,
  threadToggleErrorMessage,
} from '../src/lib/permissions';
import { Permissions, ALL_PERMISSIONS } from '../../../packages/shared/src/permissions';
import { ApiError, type Role } from '@zekktris/client';

// The web keeps a hand-written copy of the permission catalog (with display
// metadata). It must never drift from the canonical bit list the API
// enforces, or owners/admins lose UI the server would allow and roles can't
// grant the missing bits.
describe('web permission catalog', () => {
  it('has exactly the bits and keys packages/shared defines', () => {
    const shared = Object.entries(Permissions)
      .map(([key, value]) => ({ key, bit: value.toString(2).length - 1 }))
      .sort((a, b) => a.bit - b.bit);
    const web = PERMISSIONS.map((p) => ({ key: p.key, bit: p.bit })).sort(
      (a, b) => a.bit - b.bit,
    );
    expect(web).toEqual(shared);
  });

  it('puts every bit in a rendered group', () => {
    const groups = new Set(PERMISSION_GROUPS.map((g) => g.id));
    for (const p of PERMISSIONS) expect(groups.has(p.group)).toBe(true);
  });

  const guildId = 'g1';
  const roles: Role[] = [
    { id: guildId, permissions: '0', position: 0 } as unknown as Role,
    { id: 'admin', permissions: '1', position: 1 } as unknown as Role,
  ];

  it('gives the owner every server-side permission, including events and threads', () => {
    const perms = computeMemberGuildPerms(roles, guildId, [], true);
    expect(perms).toBe(ALL_PERMISSIONS);
    expect(hasBit(perms, 32)).toBe(true); // MANAGE_EVENTS
    expect(hasBit(perms, 33)).toBe(true); // MANAGE_THREADS
  });

  it('gives an ADMINISTRATOR (non-owner) every server-side permission', () => {
    const perms = computeMemberGuildPerms(roles, guildId, ['admin'], false);
    expect(perms).toBe(ALL_PERMISSIONS);
    expect(hasBit(perms, 31)).toBe(true); // USE_EMBEDDED_ACTIVITIES
    expect(hasBit(perms, 32)).toBe(true);
    expect(hasBit(perms, 33)).toBe(true);
  });

  // The API checks MANAGE_THREADS per channel (parent/category overrides
  // apply) and the native override editors expose it, so the web must
  // offer it both on roles and in channel overrides. MANAGE_EVENTS has
  // no per-channel check and stays role-only.
  it('offers MANAGE_THREADS in both the role and channel-override editors', () => {
    const threads = PERMISSIONS.find((p) => p.bit === 33)!;
    expect(threads.key).toBe('MANAGE_THREADS');
    expect(threads.scope).toBe('channel');
    expect(PERMISSIONS.find((p) => p.bit === 32)!.scope).toBe('guild');

    for (const type of ['guild_text', 'guild_forum', 'guild_category'] as const) {
      const bits = channelOverridePermissions(type).map((p) => p.bit);
      expect(bits).toContain(33);
      expect(bits).not.toContain(32);
      expect(bits).not.toContain(23); // CONNECT is voice-only
    }
    const voice = channelOverridePermissions('guild_voice').map((p) => p.bit);
    expect(voice).toContain(23);
    expect(voice).not.toContain(32);
  });

  it('explains a MANAGE_THREADS 403 from a channel override', () => {
    const denied = new ApiError(403, 'MISSING_PERMISSIONS', 'Missing required permissions', {
      required: ['MANAGE_THREADS'],
    });
    expect(threadToggleErrorMessage(denied, 'fallback')).toMatch(/Manage Threads in this channel/);
    expect(threadToggleErrorMessage(new ApiError(404, 'NOT_FOUND', 'Unknown Channel'), 'fallback')).toBe(
      'Unknown Channel',
    );
    expect(threadToggleErrorMessage(new Error('boom'), 'fallback')).toBe('fallback');
  });
});
