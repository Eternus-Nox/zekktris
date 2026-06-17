import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { createInvite, previewInvite, pruneDeadInvites } from '../src/services/invites';
import { nextSnowflake } from '../src/snowflake';
import { INVITE_CODE_LENGTH } from '@zekktris/shared/constants';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping invites tests — no database reachable');
}

describe.runIf(dbReady)('invites (integration)', () => {
  let userId: bigint;
  let guildId: bigint;
  let channelId: bigint;

  beforeAll(async () => {
    userId = nextSnowflake();
    guildId = nextSnowflake();
    channelId = nextSnowflake();
    await db.insert(schema.users).values({
      id: userId,
      email: `inv-${userId}@test.local`,
      username: `inv_${userId}`,
      displayName: 'Invite Test',
      passwordHash: 'scrypt-v1$00$00',
    });
    await db.insert(schema.guilds).values({ id: guildId, name: 'Invite Guild', ownerId: userId });
    await db.insert(schema.channels).values({ id: channelId, type: 'guild_text', guildId });
  });

  afterAll(async () => {
    // All guild-scoped rows (invites, audit log, channel) cascade on guild delete.
    await db.delete(schema.guilds).where(eq(schema.guilds.id, guildId));
    await db.delete(schema.users).where(eq(schema.users.id, userId));
    await closeDb();
  });

  // Insert a raw invite row directly (bypassing createInvite) so preview tests
  // can pin expiry / uses precisely.
  async function seedInvite(opts: { expiresAt?: Date | null; maxUses?: number | null; uses?: number; createdAt?: Date } = {}) {
    const code = `test-${nextSnowflake()}`;
    await db.insert(schema.invites).values({
      code,
      guildId,
      channelId,
      inviterId: userId,
      expiresAt: opts.expiresAt ?? null,
      maxUses: opts.maxUses ?? null,
      uses: opts.uses ?? 0,
      ...(opts.createdAt ? { createdAt: opts.createdAt } : {}),
    });
    return code;
  }

  it('createInvite mints a readable code of the configured length from the safe alphabet', async () => {
    const inv = await createInvite({ guildId, channelId, inviterId: userId, maxUses: 5, ttlSeconds: 3600 });
    expect(inv.code).toHaveLength(INVITE_CODE_LENGTH);
    expect(inv.code).toMatch(/^[abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789]+$/);
    expect(inv.code).not.toMatch(/[01OIl]/); // no visually ambiguous characters
    expect(inv.maxUses).toBe(5);
    expect(inv.uses).toBe(0);
    expect(inv.expiresAt).toBeInstanceOf(Date);
    expect(inv.expiresAt!.getTime()).toBeGreaterThan(Date.now());
  });

  it('createInvite with no ttl/maxUses is unlimited and non-expiring', async () => {
    const inv = await createInvite({ guildId, channelId, inviterId: userId });
    expect(inv.expiresAt).toBeNull();
    expect(inv.maxUses).toBeNull();
  });

  it('createInvite rejects a channel that does not belong to the guild', async () => {
    const orphanChannelId = nextSnowflake(); // no such channel
    await expect(
      createInvite({ guildId, channelId: orphanChannelId, inviterId: userId }),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('previewInvite returns the invite + guild for a live code', async () => {
    const code = await seedInvite();
    const res = await previewInvite(code);
    expect(res.invite.code).toBe(code);
    expect(res.guild.id).toBe(guildId);
  });

  it('previewInvite treats an expired invite as not-found', async () => {
    const code = await seedInvite({ expiresAt: new Date(Date.now() - 1000) });
    await expect(previewInvite(code)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('previewInvite treats a spent (maxUses reached) invite as not-found', async () => {
    const code = await seedInvite({ maxUses: 1, uses: 1 });
    await expect(previewInvite(code)).rejects.toMatchObject({ code: 'NOT_FOUND' });
  });

  it('pruneDeadInvites deletes only invites dead longer than the grace window', async () => {
    const graceMs = 24 * 60 * 60 * 1000; // 1-day grace
    const now = Date.now();
    const old = new Date(now - 3 * 24 * 60 * 60 * 1000); // 3 days ago (beyond grace)
    const recent = new Date(now - 60 * 1000); // 1 min ago (within grace)

    const expiredOld = await seedInvite({ expiresAt: old }); // dead, beyond grace → prune
    const expiredRecent = await seedInvite({ expiresAt: recent }); // dead, within grace → keep
    const alive = await seedInvite({ expiresAt: new Date(now + 3_600_000) }); // not dead → keep
    const neverExpires = await seedInvite({}); // can't die → keep
    const spentOld = await seedInvite({ maxUses: 1, uses: 1, createdAt: old }); // spent + old → prune
    const spentRecent = await seedInvite({ maxUses: 1, uses: 1, createdAt: recent }); // spent + recent → keep

    await pruneDeadInvites(graceMs);

    // Assert on THIS guild's rows only — pruneDeadInvites is a global DELETE, so
    // checking our own seeded codes keeps the test parallel-safe.
    const remaining = new Set(
      (
        await db
          .select({ code: schema.invites.code })
          .from(schema.invites)
          .where(eq(schema.invites.guildId, guildId))
      ).map((r) => r.code),
    );
    expect(remaining.has(expiredOld)).toBe(false);
    expect(remaining.has(spentOld)).toBe(false);
    expect(remaining.has(expiredRecent)).toBe(true);
    expect(remaining.has(alive)).toBe(true);
    expect(remaining.has(neverExpires)).toBe(true);
    expect(remaining.has(spentRecent)).toBe(true);
  });
});
