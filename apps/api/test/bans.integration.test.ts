import { describe, it, expect, afterAll } from 'vitest';
import { banMember, unbanMember, isBanned, getBan, listBans } from '../src/services/bans';
import { getMemberRoleIds } from '../src/services/members';
import { createUser, createGuild, addMember, createRole, assignRole, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping ban tests — no database reachable');
}

describe.runIf(dbReady)('bans (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('banMember removes the member, clears their roles, and records the ban', async () => {
    const owner = await createUser();
    const target = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, target);
    const role = await createRole(g, 0n, 1);
    await assignRole(g, target, role);
    await banMember({ guildId: g, userId: target, actorId: owner, reason: 'spam' });
    expect(await isBanned(g, target)).toBe(true);
    expect(await getMemberRoleIds(g, target)).toHaveLength(0); // roles cleared on ban
    const ban = await getBan(g, target);
    expect(ban?.reason).toBe('spam');
    expect(ban?.moderatorId).toBe(owner);
  });

  it('banMember tolerates banning a user who was never a member', async () => {
    const owner = await createUser();
    const target = await createUser();
    const g = await createGuild(owner, 0n);
    await expect(
      banMember({ guildId: g, userId: target, actorId: owner }),
    ).resolves.toBeUndefined();
    expect(await isBanned(g, target)).toBe(true);
  });

  it('re-banning upserts the reason/moderator rather than failing', async () => {
    const owner = await createUser();
    const mod = await createUser();
    const target = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, mod);
    await banMember({ guildId: g, userId: target, actorId: owner, reason: 'first' });
    await banMember({ guildId: g, userId: target, actorId: mod, reason: 'second' });
    const ban = await getBan(g, target);
    expect(ban?.reason).toBe('second');
    expect(ban?.moderatorId).toBe(mod);
  });

  it('unbanMember removes the ban and flips isBanned; a missing ban is NOT_FOUND', async () => {
    const owner = await createUser();
    const target = await createUser();
    const g = await createGuild(owner, 0n);
    await banMember({ guildId: g, userId: target, actorId: owner });
    await unbanMember({ guildId: g, userId: target, actorId: owner });
    expect(await isBanned(g, target)).toBe(false);
    expect(await getBan(g, target)).toBeNull();
    await expect(
      unbanMember({ guildId: g, userId: target, actorId: owner }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('listBans returns the guild bans, each with the banned user profile', async () => {
    const owner = await createUser();
    const t1 = await createUser();
    const t2 = await createUser();
    const g = await createGuild(owner, 0n);
    await banMember({ guildId: g, userId: t1, actorId: owner, reason: 'a' });
    await banMember({ guildId: g, userId: t2, actorId: owner, reason: 'b' });
    const bans = await listBans(g);
    expect(bans).toHaveLength(2);
    const bannedIds = bans.map((b) => b.ban.userId);
    expect(bannedIds).toContain(t1);
    expect(bannedIds).toContain(t2);
    expect(bans.every((b) => b.user.id === b.ban.userId)).toBe(true); // inner join
  });
});
