import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { and, eq, isNull } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { adminRouter } from '../src/routes/admin';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createUser, createGuild, createRole, createChannel, cleanupAll } from './seed';
import { exportInstance, importInstance } from '../src/services/instanceBackup';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping instance-backup tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/admin', adminRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
async function makeAdmin(userId: bigint): Promise<void> {
  await db.update(schema.users).set({ isAdmin: true }).where(eq(schema.users.id, userId));
}

async function channelCount(guildId: bigint): Promise<number> {
  const rows = await db
    .select({ id: schema.channels.id })
    .from(schema.channels)
    .where(and(eq(schema.channels.guildId, guildId), isNull(schema.channels.deletedAt)));
  return rows.length;
}

describe.runIf(dbReady)('instance backup / restore', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('exportInstance bundles guilds; round-trips back to new guilds with matching structure', async () => {
    const owner = await createUser();
    const g = await createGuild(owner, 0n);
    await createRole(g, 0n, 1);
    await createChannel(g, { type: 'guild_category' });
    await createChannel(g);
    const srcChannels = await channelCount(g);

    // Export config-only (fast, no image IO).
    const backup = await exportInstance({ includeImages: false });
    expect(backup.format).toBe('zekktris.instance-backup');
    expect(backup.truncated).toBe(false);
    expect(backup.guildCount).toBe(backup.guilds.length);
    const mine = backup.guilds.find((x) => x.sourceGuildId === g.toString());
    expect(mine).toBeDefined();
    expect(mine!.images).toEqual({ icon: null, banner: null }); // includeImages:false
    expect(mine!.channels.length).toBe(srcChannels);

    // Restore the WHOLE bundle as a new admin → each guild rebuilt as new.
    const restorer = await createUser();
    const { created } = await importInstance(restorer, backup);
    expect(created.length).toBe(backup.guilds.length);
    const restoredMine = created.find((r) => r.sourceGuildId === g.toString());
    expect(restoredMine?.ok).toBe(true);
    expect(restoredMine?.guildId).toBeTruthy();

    // The new guild exists, owned by the restorer, with the same channel count.
    const newGuildId = BigInt(restoredMine!.guildId!);
    const [newGuild] = await db
      .select({ ownerId: schema.guilds.ownerId })
      .from(schema.guilds)
      .where(eq(schema.guilds.id, newGuildId))
      .limit(1);
    expect(newGuild?.ownerId).toBe(restorer);
    expect(await channelCount(newGuildId)).toBe(srcChannels);

    // Clean up the freshly-created guild (not tracked by seed).
    await db.delete(schema.guilds).where(eq(schema.guilds.id, newGuildId));
  });

  it('importInstance is per-guild best-effort: a bad entry fails without aborting the rest', async () => {
    const owner = await createUser();
    const g = await createGuild(owner, 0n);
    await createChannel(g);
    const backup = await exportInstance({ includeImages: false });
    // Inject a malformed guild entry alongside the real one.
    const tampered = {
      ...backup,
      guilds: [{ format: 'wrong', version: 1, sourceGuildId: 'x', guild: { name: 'Bad' } }, ...backup.guilds],
    };
    const restorer = await createUser();
    const { created } = await importInstance(restorer, tampered as never);
    expect(created[0]!.ok).toBe(false); // the malformed one
    expect(created.some((r) => r.ok)).toBe(true); // a real one still restored
    // Clean up restored guilds.
    for (const r of created) {
      if (r.ok && r.guildId) await db.delete(schema.guilds).where(eq(schema.guilds.id, BigInt(r.guildId)));
    }
  });

  it('importInstance rejects a non-instance-backup document', async () => {
    const u = await createUser();
    await expect(importInstance(u, { format: 'nope', version: 1, guilds: [] })).rejects.toThrow();
  });

  it('routes are instance-admin gated', async () => {
    const plain = await createUser();
    const admin = await createUser();
    await makeAdmin(admin);

    // GET /admin/backup
    expect((await app.request('/admin/backup')).status).toBe(401);
    expect(
      (await app.request('/admin/backup', { headers: { authorization: `Bearer ${await tokenFor(plain)}` } })).status,
    ).toBe(403);
    const ok = await app.request('/admin/backup?includeImages=false', {
      headers: { authorization: `Bearer ${await tokenFor(admin)}` },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { backup: { format: string; guilds: unknown[] } };
    expect(body.backup.format).toBe('zekktris.instance-backup');

    // POST /admin/backup/restore
    const deniedRestore = await app.request('/admin/backup/restore', {
      method: 'POST',
      headers: { authorization: `Bearer ${await tokenFor(plain)}`, 'content-type': 'application/json' },
      body: JSON.stringify({ format: 'zekktris.instance-backup', version: 1, guilds: [] }),
    });
    expect(deniedRestore.status).toBe(403);
  });
});
