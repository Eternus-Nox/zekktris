import { describe, it, expect, afterAll } from 'vitest';
import {
  lookupReactionRole,
  createMapping,
  deleteMapping,
  listForGuild,
} from '../src/services/reactionRoles';
import {
  createUser,
  createGuild,
  createRole,
  createChannel,
  createMessage,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping reaction-roles tests — no database reachable');
}

describe.runIf(dbReady)('reaction roles (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  async function fixture() {
    const owner = await createUser();
    const guildId = await createGuild(owner, 0n);
    const channelId = await createChannel(guildId);
    const messageId = await createMessage(channelId);
    return { owner, guildId, channelId, messageId };
  }

  it('createMapping then lookupReactionRole resolves the mapped role', async () => {
    const { owner, guildId, channelId, messageId } = await fixture();
    const role = await createRole(guildId, 0n, 1);
    await createMapping({ messageId, emoji: '👍', guildId, channelId, roleId: role, createdBy: owner });
    expect(await lookupReactionRole(messageId, '👍')).toBe(role);
    expect(await lookupReactionRole(messageId, '🎉')).toBeNull(); // unmapped emoji
  });

  it('createMapping upserts — re-mapping the same (message,emoji) redirects the role', async () => {
    const { owner, guildId, channelId, messageId } = await fixture();
    const roleA = await createRole(guildId, 0n, 1);
    const roleB = await createRole(guildId, 0n, 2);
    await createMapping({ messageId, emoji: '⭐', guildId, channelId, roleId: roleA, createdBy: owner });
    expect(await lookupReactionRole(messageId, '⭐')).toBe(roleA);
    await createMapping({ messageId, emoji: '⭐', guildId, channelId, roleId: roleB, createdBy: owner });
    expect(await lookupReactionRole(messageId, '⭐')).toBe(roleB); // redirected, not duplicated
  });

  it('deleteMapping removes the mapping and reports whether anything was deleted', async () => {
    const { owner, guildId, channelId, messageId } = await fixture();
    const role = await createRole(guildId, 0n, 1);
    await createMapping({ messageId, emoji: '🔥', guildId, channelId, roleId: role, createdBy: owner });
    expect(await deleteMapping(messageId, '🔥')).toBe(true);
    expect(await lookupReactionRole(messageId, '🔥')).toBeNull();
    expect(await deleteMapping(messageId, '🔥')).toBe(false); // already gone
  });

  it('listForGuild returns the guild mappings', async () => {
    const { owner, guildId, channelId, messageId } = await fixture();
    const role = await createRole(guildId, 0n, 1);
    await createMapping({ messageId, emoji: '✅', guildId, channelId, roleId: role, createdBy: owner });
    const list = await listForGuild(guildId);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({
      messageId: messageId.toString(),
      emoji: '✅',
      channelId: channelId.toString(),
      roleId: role.toString(),
    });
  });
});
