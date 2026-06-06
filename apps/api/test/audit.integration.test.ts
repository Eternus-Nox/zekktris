import { describe, it, expect, afterAll } from 'vitest';
import { writeAudit, listAuditEntries, listAuditEntriesForExport } from '../src/services/audit';
import { createUser, createGuild, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping audit-log tests — no database reachable');
}

describe.runIf(dbReady)('audit log (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('writeAudit persists a retrievable entry with the actor joined', async () => {
    const actor = await createUser();
    const g = await createGuild(actor, 0n);
    await writeAudit({ guildId: g, actorId: actor, action: 'guild.update', targetType: 'guild', targetId: g });
    const entries = await listAuditEntries(g);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry.action).toBe('guild.update');
    expect(entries[0]!.entry.guildId).toBe(g);
    expect(entries[0]!.actor?.id).toBe(actor);
  });

  it('serializes BigInt values in `changes` instead of throwing', async () => {
    const actor = await createUser();
    const g = await createGuild(actor, 0n);
    const afkChannelId = 123456789012345678n;
    // Without toJsonSafe this throws "Do not know how to serialize a BigInt".
    await expect(
      writeAudit({
        guildId: g,
        actorId: actor,
        action: 'guild.update',
        targetType: 'guild',
        changes: { afkChannelId, name: 'New' },
      }),
    ).resolves.toBeUndefined();
    const [latest] = await listAuditEntries(g, { limit: 1 });
    expect(latest!.entry.changes).toMatchObject({ afkChannelId: afkChannelId.toString(), name: 'New' });
  });

  it('listAuditEntries returns newest-first and honors the before cursor', async () => {
    const actor = await createUser();
    const g = await createGuild(actor, 0n);
    await writeAudit({ guildId: g, actorId: actor, action: 'a.one', targetType: 'guild' });
    await writeAudit({ guildId: g, actorId: actor, action: 'a.two', targetType: 'guild' });
    await writeAudit({ guildId: g, actorId: actor, action: 'a.three', targetType: 'guild' });
    const all = await listAuditEntries(g);
    expect(all.map((e) => e.entry.action)).toEqual(['a.three', 'a.two', 'a.one']);
    const older = await listAuditEntries(g, { before: all[0]!.entry.id });
    expect(older.map((e) => e.entry.action)).toEqual(['a.two', 'a.one']);
  });

  it('listAuditEntries filters by action prefix and clamps the limit to >= 1', async () => {
    const actor = await createUser();
    const g = await createGuild(actor, 0n);
    await writeAudit({ guildId: g, actorId: actor, action: 'member.kick', targetType: 'member', targetId: actor });
    await writeAudit({ guildId: g, actorId: actor, action: 'member.ban', targetType: 'member', targetId: actor });
    await writeAudit({ guildId: g, actorId: actor, action: 'channel.create', targetType: 'channel' });
    const members = await listAuditEntries(g, { actionPrefix: 'member.' });
    expect(members).toHaveLength(2);
    expect(members.every((e) => e.entry.action.startsWith('member.'))).toBe(true);
    expect(await listAuditEntries(g, { limit: 0 })).toHaveLength(1); // clamped
  });

  it('stores a system action (null actor) and surfaces actor=null', async () => {
    const actor = await createUser();
    const g = await createGuild(actor, 0n);
    await writeAudit({ guildId: g, actorId: null, action: 'invite.expire', targetType: 'invite' });
    const [entry] = await listAuditEntries(g, { actionPrefix: 'invite.' });
    expect(entry!.entry.actorId).toBeNull();
    expect(entry!.actor).toBeNull();
  });

  it('listAuditEntriesForExport returns oldest-first', async () => {
    const actor = await createUser();
    const g = await createGuild(actor, 0n);
    await writeAudit({ guildId: g, actorId: actor, action: 'x.one', targetType: 'guild' });
    await writeAudit({ guildId: g, actorId: actor, action: 'x.two', targetType: 'guild' });
    const ex = await listAuditEntriesForExport(g);
    expect(ex.map((e) => e.entry.action)).toEqual(['x.one', 'x.two']);
  });
});
