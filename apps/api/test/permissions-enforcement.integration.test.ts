import { describe, it, expect, afterAll } from 'vitest';
import { ALL_PERMISSIONS, Permissions as P } from '@zekktris/shared/permissions';
import {
  computeMemberGuildPermissions,
  computeMemberChannelPermissions,
  ensureMember,
  assertGuildPermission,
  assertChannelPermission,
  assertCanManageRole,
  assertCanManageMember,
} from '../src/services/permissions';
import {
  createUser,
  createGuild,
  addMember,
  createRole,
  assignRole,
  createChannel,
  addOverride,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping permission-enforcement tests — no database reachable');
}

/** True iff `perms` has every bit of `bit`. */
const has = (perms: bigint, bit: bigint) => (perms & bit) === bit;

describe.runIf(dbReady)('permission enforcement (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  describe('computeMemberGuildPermissions', () => {
    it('owner gets ALL regardless of role permissions', async () => {
      const owner = await createUser();
      const g = await createGuild(owner, 0n);
      await addMember(g, owner);
      expect(await computeMemberGuildPermissions(g, owner)).toBe(ALL_PERMISSIONS);
    });

    it('ORs @everyone with the member roles', async () => {
      const owner = await createUser();
      const member = await createUser();
      const g = await createGuild(owner, P.VIEW_CHANNEL | P.SEND_MESSAGES);
      await addMember(g, member);
      await assignRole(g, member, await createRole(g, P.MANAGE_CHANNELS, 1));
      const perms = await computeMemberGuildPermissions(g, member);
      expect(has(perms, P.VIEW_CHANNEL)).toBe(true);
      expect(has(perms, P.SEND_MESSAGES)).toBe(true);
      expect(has(perms, P.MANAGE_CHANNELS)).toBe(true);
      expect(has(perms, P.BAN_MEMBERS)).toBe(false);
    });

    it('returns 0 for a non-member', async () => {
      const owner = await createUser();
      const stranger = await createUser();
      const g = await createGuild(owner, P.VIEW_CHANNEL);
      expect(await computeMemberGuildPermissions(g, stranger)).toBe(0n);
    });

    it('an ADMINISTRATOR role expands to ALL', async () => {
      const owner = await createUser();
      const member = await createUser();
      const g = await createGuild(owner, 0n);
      await addMember(g, member);
      await assignRole(g, member, await createRole(g, P.ADMINISTRATOR, 1));
      expect(await computeMemberGuildPermissions(g, member)).toBe(ALL_PERMISSIONS);
    });
  });

  describe('ensureMember + assertGuildPermission', () => {
    it('ensureMember resolves for a member and rejects a non-member', async () => {
      const owner = await createUser();
      const member = await createUser();
      const stranger = await createUser();
      const g = await createGuild(owner, 0n);
      await addMember(g, member);
      await expect(ensureMember(g, member)).resolves.toBeUndefined();
      await expect(ensureMember(g, stranger)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('assertGuildPermission enforces the bit, with owner bypass', async () => {
      const owner = await createUser();
      const member = await createUser();
      const g = await createGuild(owner, P.KICK_MEMBERS);
      await addMember(g, member);
      await addMember(g, owner);
      await expect(assertGuildPermission(g, member, P.KICK_MEMBERS)).resolves.toBeUndefined();
      await expect(assertGuildPermission(g, member, P.BAN_MEMBERS)).rejects.toMatchObject({
        code: 'MISSING_PERMISSIONS',
      });
      await expect(assertGuildPermission(g, owner, P.BAN_MEMBERS)).resolves.toBeUndefined();
    });
  });

  describe('computeMemberChannelPermissions', () => {
    it('base guild permissions flow through when there are no overrides', async () => {
      const owner = await createUser();
      const member = await createUser();
      const g = await createGuild(owner, P.VIEW_CHANNEL | P.SEND_MESSAGES);
      await addMember(g, member);
      const ch = await createChannel(g);
      const perms = await computeMemberChannelPermissions(ch, member);
      expect(has(perms, P.VIEW_CHANNEL)).toBe(true);
      expect(has(perms, P.SEND_MESSAGES)).toBe(true);
    });

    it('an @everyone deny override removes the permission', async () => {
      const owner = await createUser();
      const member = await createUser();
      const g = await createGuild(owner, P.VIEW_CHANNEL | P.SEND_MESSAGES);
      await addMember(g, member);
      const ch = await createChannel(g);
      await addOverride(ch, 'role', g, 0n, P.SEND_MESSAGES); // @everyone deny SEND
      const perms = await computeMemberChannelPermissions(ch, member);
      expect(has(perms, P.SEND_MESSAGES)).toBe(false);
      expect(has(perms, P.VIEW_CHANNEL)).toBe(true);
    });

    it('a member override beats an @everyone deny', async () => {
      const owner = await createUser();
      const member = await createUser();
      const g = await createGuild(owner, P.VIEW_CHANNEL | P.SEND_MESSAGES);
      await addMember(g, member);
      const ch = await createChannel(g);
      await addOverride(ch, 'role', g, 0n, P.SEND_MESSAGES); // @everyone deny
      await addOverride(ch, 'member', member, P.SEND_MESSAGES, 0n); // member allow
      const perms = await computeMemberChannelPermissions(ch, member);
      expect(has(perms, P.SEND_MESSAGES)).toBe(true);
    });

    it('owner short-circuits to ALL even with a deny override', async () => {
      const owner = await createUser();
      const g = await createGuild(owner, 0n);
      await addMember(g, owner);
      const ch = await createChannel(g);
      await addOverride(ch, 'member', owner, 0n, P.VIEW_CHANNEL);
      expect(await computeMemberChannelPermissions(ch, owner)).toBe(ALL_PERMISSIONS);
    });

    it('a channel override beats the parent category override', async () => {
      const owner = await createUser();
      const member = await createUser();
      const g = await createGuild(owner, P.VIEW_CHANNEL); // base: VIEW only
      await addMember(g, member);
      const category = await createChannel(g, { type: 'guild_category' });
      const ch = await createChannel(g, { parentId: category });
      await addOverride(category, 'role', g, P.SEND_MESSAGES, 0n); // category allows SEND
      await addOverride(ch, 'role', g, 0n, P.SEND_MESSAGES); // channel denies SEND
      const perms = await computeMemberChannelPermissions(ch, member);
      expect(has(perms, P.SEND_MESSAGES)).toBe(false); // channel deny wins
      expect(has(perms, P.VIEW_CHANNEL)).toBe(true);
    });
  });

  describe('assertChannelPermission', () => {
    it('enforces the effective channel permission', async () => {
      const owner = await createUser();
      const member = await createUser();
      const g = await createGuild(owner, P.VIEW_CHANNEL | P.SEND_MESSAGES);
      await addMember(g, member);
      const ch = await createChannel(g);
      await expect(assertChannelPermission(ch, member, P.SEND_MESSAGES)).resolves.toBeUndefined();
      await expect(assertChannelPermission(ch, member, P.MANAGE_MESSAGES)).rejects.toMatchObject({
        code: 'MISSING_PERMISSIONS',
      });
    });
  });

  describe('hierarchy guards', () => {
    it('assertCanManageRole needs MANAGE_ROLES + a strictly higher role; owner bypasses', async () => {
      const owner = await createUser();
      const mod = await createUser();
      const g = await createGuild(owner, 0n);
      await addMember(g, mod);
      await addMember(g, owner);
      const low = await createRole(g, 0n, 2);
      const high = await createRole(g, 0n, 6);
      // No MANAGE_ROLES yet.
      await expect(assertCanManageRole(g, mod, low)).rejects.toMatchObject({
        code: 'MISSING_PERMISSIONS',
      });
      // Grant MANAGE_ROLES at position 5.
      await assignRole(g, mod, await createRole(g, P.MANAGE_ROLES, 5));
      await expect(assertCanManageRole(g, mod, low)).resolves.toBeUndefined(); // 2 < 5 → ok
      await expect(assertCanManageRole(g, mod, high)).rejects.toMatchObject({ code: 'FORBIDDEN' }); // 6 ≥ 5
      await expect(assertCanManageRole(g, owner, high)).resolves.toBeUndefined(); // owner bypass
    });

    it('assertCanManageMember protects the owner and enforces role hierarchy', async () => {
      const owner = await createUser();
      const actor = await createUser();
      const lowTarget = await createUser();
      const peerTarget = await createUser();
      const g = await createGuild(owner, 0n);
      await addMember(g, actor);
      await addMember(g, lowTarget);
      await addMember(g, peerTarget);
      await assignRole(g, actor, await createRole(g, 0n, 5));
      await assignRole(g, lowTarget, await createRole(g, 0n, 2));
      await assignRole(g, peerTarget, await createRole(g, 0n, 6));
      await expect(assertCanManageMember(g, actor, lowTarget)).resolves.toBeUndefined(); // 2 < 5
      await expect(assertCanManageMember(g, actor, peerTarget)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      }); // 6 ≥ 5
      await expect(assertCanManageMember(g, actor, owner)).rejects.toMatchObject({
        code: 'FORBIDDEN',
      }); // cannot act on owner
      await expect(assertCanManageMember(g, owner, actor)).resolves.toBeUndefined(); // owner bypass
    });
  });
});
