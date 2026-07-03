import { describe, it, expect, afterAll } from 'vitest';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import { kickMember } from '../src/services/members';
import { deleteChannel } from '../src/services/channels';
import { createUser, createGuild, addMember, createChannel, addOverride, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping departure-purge tests — no database reachable');
}

describe.runIf(dbReady)('departure + channel-delete cascade cleanup', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('kick deletes the member-target channel overrides (no re-grant on rejoin)', async () => {
    const owner = await createUser();
    const member = await createUser();
    const guild = await createGuild(owner);
    await addMember(guild, owner);
    await addMember(guild, member);
    const channel = await createChannel(guild);
    // Explicit member override granting the member VIEW on this channel.
    await addOverride(channel, 'member', member, 8n /* VIEW_CHANNEL */, 0n);

    await kickMember({ guildId: guild, userId: member, actorId: owner });

    const left = await db
      .select({ targetId: schema.permissionOverrides.targetId })
      .from(schema.permissionOverrides)
      .where(
        and(
          eq(schema.permissionOverrides.channelId, channel),
          eq(schema.permissionOverrides.targetType, 'member'),
          eq(schema.permissionOverrides.targetId, member),
        ),
      );
    expect(left).toHaveLength(0);
  });

  it('deleting a category transitively soft-deletes grandchild threads', async () => {
    const owner = await createUser();
    const guild = await createGuild(owner);
    await addMember(guild, owner);
    const category = await createChannel(guild, { type: 'guild_category' });
    const text = await createChannel(guild, { type: 'guild_text', parentId: category });
    // A thread parented by the text channel (grandchild of the category).
    const thread = nextSnowflake();
    await db.insert(schema.channels).values({
      id: thread,
      type: 'public_thread',
      guildId: guild,
      parentId: text,
    });

    const { cascadedChildIds } = await deleteChannel(category, owner);

    // The returned set includes BOTH the direct child text channel and the
    // grandchild thread so the client drops them all.
    expect(cascadedChildIds).toContain(text);
    expect(cascadedChildIds).toContain(thread);

    const [threadRow] = await db
      .select({ deletedAt: schema.channels.deletedAt })
      .from(schema.channels)
      .where(eq(schema.channels.id, thread));
    expect(threadRow!.deletedAt).not.toBeNull();
  });
});
