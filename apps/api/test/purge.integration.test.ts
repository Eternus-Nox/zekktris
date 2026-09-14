/**
 * Deleting a server or an account removes the content.
 *
 * Both used to leave it behind: `deleteGuild` only set `deleted_at`, and
 * account deletion kept every message the person wrote (author_id is ON DELETE
 * SET NULL). These tests pin the three rules the purge is built on — servers go
 * completely, DM history survives an account deletion under the old username,
 * and moderation records outlive both.
 */
import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { nextSnowflake } from '../src/snowflake';
import {
  createUser,
  createGuild,
  createChannel,
  createMessage,
  createDmChannel,
  addMember,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';
import { purgeAccount, purgeGuild } from '../src/services/purge';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping purge tests — no database reachable');
}

async function guildExists(id: bigint): Promise<boolean> {
  const rows = await db
    .select({ id: schema.guilds.id })
    .from(schema.guilds)
    .where(eq(schema.guilds.id, id));
  return rows.length > 0;
}
async function channelExists(id: bigint): Promise<boolean> {
  const rows = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(eq(schema.channels.id, id));
  return rows.length > 0;
}
async function messageExists(id: bigint): Promise<boolean> {
  const rows = await db
    .select({ id: schema.messages.id })
    .from(schema.messages)
    .where(eq(schema.messages.id, id));
  return rows.length > 0;
}

describe.runIf(dbReady)('purge', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('a purged server takes its channels and messages with it', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner);
    const channelId = await createChannel(guildId);
    const messageId = await createMessage(channelId, { authorId: owner, content: 'hello' });

    await purgeGuild(guildId);

    expect(await guildExists(guildId)).toBe(false);
    expect(await channelExists(channelId)).toBe(false);
    expect(await messageExists(messageId)).toBe(false);
  });

  it('keeps the report when the server it was filed in is purged', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner);
    const reportId = nextSnowflake();
    await db.insert(schema.reports).values({
      id: reportId,
      guildId,
      reporterId: owner,
      targetType: 'message',
      targetUserId: owner,
      messageContent: 'the reported text',
      reason: 'harassment',
    });

    await purgeGuild(guildId);

    const [report] = await db
      .select()
      .from(schema.reports)
      .where(eq(schema.reports.id, reportId));
    expect(report).toBeTruthy();
    // The server is gone, so the id must be — but the record of what happened,
    // and where, survives. Deleting a server can't erase the evidence.
    expect(report!.guildId).toBeNull();
    expect(report!.guildName).toBe('Seed Guild');
    expect(report!.messageContent).toBe('the reported text');
    await db.delete(schema.reports).where(eq(schema.reports.id, reportId));
  });

  it('deletes server messages but keeps DM history, still under the old name', async () => {
    const leaver = await createUser();
    const friend = await createUser();
    const guildId = await createGuild(friend);
    await addMember(guildId, leaver);
    const channelId = await createChannel(guildId);
    const serverMsg = await createMessage(channelId, { authorId: leaver, content: 'in a server' });
    const dmChannel = await createDmChannel([leaver, friend]);
    const dmMsg = await createMessage(dmChannel, { authorId: leaver, content: 'in a dm' });

    const [before] = await db
      .select({ username: schema.users.username })
      .from(schema.users)
      .where(eq(schema.users.id, leaver));

    await purgeAccount(leaver);

    expect(await messageExists(serverMsg)).toBe(false);

    const [dm] = await db.select().from(schema.messages).where(eq(schema.messages.id, dmMsg));
    expect(dm!.content).toBe('in a dm');
    // Still attributed: the tombstone keeps the author resolvable, which is the
    // whole reason the row survives.
    expect(dm!.authorId).toBe(leaver);

    const [tomb] = await db.select().from(schema.users).where(eq(schema.users.id, leaver));
    expect(tomb!.username).toBe(before!.username);
    expect(tomb!.deletedAt).not.toBeNull();
  });

  it('scrubs the account down to the name', async () => {
    const uid = await createUser();
    await db
      .update(schema.users)
      .set({ avatarUrl: '/cdn/123/a.png', bio: 'about me', isAdmin: true, totpEnabled: true })
      .where(eq(schema.users.id, uid));

    await purgeAccount(uid);

    const [row] = await db.select().from(schema.users).where(eq(schema.users.id, uid));
    expect(row!.email).not.toMatch(/test\.local/);
    expect(row!.passwordHash).toBe('');
    expect(row!.avatarUrl).toBeNull();
    expect(row!.bio).toBeNull();
    expect(row!.isAdmin).toBe(false);
    expect(row!.totpEnabled).toBe(false);
    // The name is deliberately kept — see the DM test above.
    expect(row!.username).toBeTruthy();
  });

  it('removes the account from every server it was in', async () => {
    const owner = await createUser();
    const member = await createUser();
    const guildId = await createGuild(owner);
    await addMember(guildId, member);

    await purgeAccount(member);

    const rows = await db
      .select({ userId: schema.guildMembers.userId })
      .from(schema.guildMembers)
      .where(eq(schema.guildMembers.userId, member));
    expect(rows).toHaveLength(0);
  });
});
