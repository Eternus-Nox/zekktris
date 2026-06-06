import { describe, it, expect, afterAll } from 'vitest';
import {
  addMemberRole,
  removeMemberRole,
  kickMember,
  getMember,
  getMemberRoleIds,
} from '../src/services/members';
import { createUser, createGuild, addMember, createRole, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping member-mutation tests — no database reachable');
}

describe.runIf(dbReady)('guild member mutations (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('addMemberRole grants a role idempotently', async () => {
    const owner = await createUser();
    const member = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, member);
    const role = await createRole(g, 0n, 1);
    await addMemberRole({ guildId: g, userId: member, roleId: role, actorId: owner });
    expect(await getMemberRoleIds(g, member)).toContain(role);
    // Re-grant is a no-op (ON CONFLICT DO NOTHING).
    await addMemberRole({ guildId: g, userId: member, roleId: role, actorId: owner });
    expect((await getMemberRoleIds(g, member)).filter((r) => r === role)).toHaveLength(1);
  });

  it('addMemberRole treats @everyone (roleId === guildId) as an implicit no-op', async () => {
    const owner = await createUser();
    const member = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, member);
    await expect(
      addMemberRole({ guildId: g, userId: member, roleId: g, actorId: owner }),
    ).resolves.toBeUndefined();
    expect(await getMemberRoleIds(g, member)).toHaveLength(0);
  });

  it('addMemberRole rejects a foreign-guild role and a non-member', async () => {
    const owner = await createUser();
    const member = await createUser();
    const stranger = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, member);
    const role = await createRole(g, 0n, 1);
    const otherGuild = await createGuild(owner, 0n);
    const foreignRole = await createRole(otherGuild, 0n, 1);
    await expect(
      addMemberRole({ guildId: g, userId: member, roleId: foreignRole, actorId: owner }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
    await expect(
      addMemberRole({ guildId: g, userId: stranger, roleId: role, actorId: owner }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('removeMemberRole revokes a role and refuses to remove @everyone', async () => {
    const owner = await createUser();
    const member = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, member);
    const role = await createRole(g, 0n, 1);
    await addMemberRole({ guildId: g, userId: member, roleId: role, actorId: owner });
    await removeMemberRole({ guildId: g, userId: member, roleId: role, actorId: owner });
    expect(await getMemberRoleIds(g, member)).not.toContain(role);
    await expect(
      removeMemberRole({ guildId: g, userId: member, roleId: g, actorId: owner }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('kickMember removes the member and clears their role assignments', async () => {
    const owner = await createUser();
    const member = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, member);
    const role = await createRole(g, 0n, 1);
    await addMemberRole({ guildId: g, userId: member, roleId: role, actorId: owner });
    await kickMember({ guildId: g, userId: member, actorId: owner });
    expect(await getMember(g, member)).toBeNull();
    expect(await getMemberRoleIds(g, member)).toHaveLength(0); // cleared on kick
    // Kicking a non-member throws.
    await expect(kickMember({ guildId: g, userId: member, actorId: owner })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    });
  });
});
