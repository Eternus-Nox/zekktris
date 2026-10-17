import { describe, it, expect } from 'vitest';
import {
  PERMISSIONS,
  PERMISSION_GROUPS,
  computeMemberGuildPerms,
  hasBit,
} from '../src/lib/permissions';
import { Permissions, ALL_PERMISSIONS } from '../../../packages/shared/src/permissions';
import type { Role } from '@zekktris/client';

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
});
