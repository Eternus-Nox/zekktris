import { describe, it, expect } from 'vitest';
import {
  Permissions as P,
  ALL_PERMISSIONS,
  DEFAULT_EVERYONE_PERMISSIONS,
  hasPermission,
  hasAnyPermission,
  permissionNames,
  bitfieldFromNames,
  computeBasePermissions,
  computeChannelPermissions,
  type ResolvableRole,
} from '@zekktris/shared/permissions';

const everyone = (permissions: bigint): ResolvableRole => ({ position: 0, permissions });
const role = (permissions: bigint, position = 1): ResolvableRole => ({ position, permissions });

describe('permission bitfield helpers', () => {
  it('hasPermission: exact bit, missing bit, and ADMINISTRATOR override', () => {
    expect(hasPermission(P.SEND_MESSAGES, P.SEND_MESSAGES)).toBe(true);
    expect(hasPermission(P.SEND_MESSAGES, P.BAN_MEMBERS)).toBe(false);
    // ADMINISTRATOR grants everything, even bits that aren't set.
    expect(hasPermission(P.ADMINISTRATOR, P.BAN_MEMBERS)).toBe(true);
  });

  it('hasAnyPermission: any-of semantics + ADMINISTRATOR', () => {
    expect(hasAnyPermission(P.KICK_MEMBERS, [P.BAN_MEMBERS, P.KICK_MEMBERS])).toBe(true);
    expect(hasAnyPermission(P.SEND_MESSAGES, [P.BAN_MEMBERS, P.KICK_MEMBERS])).toBe(false);
    expect(hasAnyPermission(P.ADMINISTRATOR, [P.BAN_MEMBERS])).toBe(true);
  });

  it('permissionNames / bitfieldFromNames round-trip', () => {
    const bf = P.VIEW_CHANNEL | P.SEND_MESSAGES | P.MANAGE_THREADS;
    const names = permissionNames(bf);
    expect(names).toContain('VIEW_CHANNEL');
    expect(names).toContain('SEND_MESSAGES');
    expect(names).toContain('MANAGE_THREADS');
    expect(bitfieldFromNames(names)).toBe(bf);
  });

  it('constants: ALL includes admin + a high bit; default @everyone is sane but not privileged', () => {
    expect(hasPermission(ALL_PERMISSIONS, P.ADMINISTRATOR)).toBe(true);
    expect((ALL_PERMISSIONS & P.MANAGE_THREADS) === P.MANAGE_THREADS).toBe(true);
    expect((DEFAULT_EVERYONE_PERMISSIONS & P.VIEW_CHANNEL) === P.VIEW_CHANNEL).toBe(true);
    expect((DEFAULT_EVERYONE_PERMISSIONS & P.SEND_MESSAGES) === P.SEND_MESSAGES).toBe(true);
    // ...but never dangerous bits by default.
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.ADMINISTRATOR).toBe(0n);
    expect(DEFAULT_EVERYONE_PERMISSIONS & P.MANAGE_GUILD).toBe(0n);
  });
});

describe('computeBasePermissions', () => {
  it('owner gets ALL regardless of roles', () => {
    expect(
      computeBasePermissions({ isOwner: true, everyoneRole: everyone(0n), memberRoles: [] }),
    ).toBe(ALL_PERMISSIONS);
  });

  it('ORs @everyone with the member roles', () => {
    const perms = computeBasePermissions({
      isOwner: false,
      everyoneRole: everyone(P.VIEW_CHANNEL),
      memberRoles: [role(P.SEND_MESSAGES), role(P.ADD_REACTIONS)],
    });
    expect((perms & P.VIEW_CHANNEL) === P.VIEW_CHANNEL).toBe(true);
    expect((perms & P.SEND_MESSAGES) === P.SEND_MESSAGES).toBe(true);
    expect((perms & P.ADD_REACTIONS) === P.ADD_REACTIONS).toBe(true);
    expect(perms & P.BAN_MEMBERS).toBe(0n);
  });

  it('ADMINISTRATOR on any role expands to ALL', () => {
    const perms = computeBasePermissions({
      isOwner: false,
      everyoneRole: everyone(P.VIEW_CHANNEL),
      memberRoles: [role(P.ADMINISTRATOR)],
    });
    expect(perms).toBe(ALL_PERMISSIONS);
  });
});

describe('computeChannelPermissions', () => {
  const base = {
    isOwner: false,
    everyoneRole: everyone(P.VIEW_CHANNEL | P.SEND_MESSAGES),
    memberRoles: [] as ResolvableRole[],
  };

  it('owner and admin short-circuit to ALL, bypassing a deny override', () => {
    expect(
      computeChannelPermissions({
        ...base,
        isOwner: true,
        memberOverride: { allow: 0n, deny: P.VIEW_CHANNEL },
      }),
    ).toBe(ALL_PERMISSIONS);

    expect(
      computeChannelPermissions({
        isOwner: false,
        everyoneRole: everyone(P.ADMINISTRATOR),
        memberRoles: [],
        memberOverride: { allow: 0n, deny: P.VIEW_CHANNEL },
      }),
    ).toBe(ALL_PERMISSIONS);
  });

  it('@everyone override: deny removes a perm, allow adds one', () => {
    const denied = computeChannelPermissions({
      ...base,
      everyoneOverride: { allow: 0n, deny: P.SEND_MESSAGES },
    });
    expect(denied & P.SEND_MESSAGES).toBe(0n);

    const allowed = computeChannelPermissions({
      ...base,
      everyoneOverride: { allow: P.EMBED_LINKS, deny: 0n },
    });
    expect((allowed & P.EMBED_LINKS) === P.EMBED_LINKS).toBe(true);
  });

  it('role override beats @everyone; member override beats role', () => {
    // everyone denies SEND, a role allows it → role wins (has SEND).
    const roleWins = computeChannelPermissions({
      ...base,
      everyoneOverride: { allow: 0n, deny: P.SEND_MESSAGES },
      roleOverrides: [{ allow: P.SEND_MESSAGES, deny: 0n }],
    });
    expect((roleWins & P.SEND_MESSAGES) === P.SEND_MESSAGES).toBe(true);

    // ...then a member override denies it → member wins (lacks SEND).
    const memberWins = computeChannelPermissions({
      ...base,
      everyoneOverride: { allow: 0n, deny: P.SEND_MESSAGES },
      roleOverrides: [{ allow: P.SEND_MESSAGES, deny: 0n }],
      memberOverride: { allow: 0n, deny: P.SEND_MESSAGES },
    });
    expect(memberWins & P.SEND_MESSAGES).toBe(0n);
  });

  it('folds multiple role overrides — allow wins over deny within the role tier', () => {
    const perms = computeChannelPermissions({
      ...base,
      roleOverrides: [
        { allow: 0n, deny: P.SEND_MESSAGES }, // role A denies
        { allow: P.SEND_MESSAGES, deny: 0n }, // role B allows
      ],
    });
    expect((perms & P.SEND_MESSAGES) === P.SEND_MESSAGES).toBe(true);
  });

  it('channel override beats the parent category override (both directions)', () => {
    // category allows SEND, channel denies SEND → channel wins (lacks).
    const channelDenyWins = computeChannelPermissions({
      ...base,
      categoryEveryoneOverride: { allow: P.SEND_MESSAGES, deny: 0n },
      everyoneOverride: { allow: 0n, deny: P.SEND_MESSAGES },
    });
    expect(channelDenyWins & P.SEND_MESSAGES).toBe(0n);

    // category denies SEND, channel allows SEND → channel wins (has).
    const channelAllowWins = computeChannelPermissions({
      ...base,
      categoryEveryoneOverride: { allow: 0n, deny: P.SEND_MESSAGES },
      everyoneOverride: { allow: P.SEND_MESSAGES, deny: 0n },
    });
    expect((channelAllowWins & P.SEND_MESSAGES) === P.SEND_MESSAGES).toBe(true);
  });
});
