import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { Permissions as P } from '@zekktris/shared/permissions';
import { guildsRouter } from '../src/routes/guilds';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import {
  createUser,
  createGuild,
  addMember,
  createRole,
  assignRole,
  cleanupAll,
} from './seed';
import { writeAudit, listAuditEntries } from '../src/services/audit';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping audit-log route tests — no database reachable');
}

// Mount the real guildsRouter (which carries its own requireAuth) under
// /guilds, behind the shared error handler so thrown AppErrors become the
// proper JSON envelope + status, exactly like production.
const app = new Hono();
app.onError(errorHandler);
app.route('/guilds', guildsRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}

function authedGet(path: string, token: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

describe.runIf(dbReady)('GET /guilds/:id/audit-log (route)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('returns entries (newest-first, actor joined) for a VIEW_AUDIT_LOG holder', async () => {
    const owner = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, owner); // owner needs a member row for permission resolution
    await writeAudit({ guildId: g, actorId: owner, action: 'channel.create', targetType: 'channel' });
    await writeAudit({ guildId: g, actorId: owner, action: 'role.update', targetType: 'role' });

    const res = await authedGet(`/guilds/${g}/audit-log`, await tokenFor(owner));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: Array<{ action: string; actor: { id: string } | null }> };
    expect(body.entries.map((e) => e.action)).toEqual(['role.update', 'channel.create']);
    expect(body.entries[0]!.actor?.id).toBe(owner.toString());
  });

  it('is gated: a member WITHOUT VIEW_AUDIT_LOG gets 403', async () => {
    const owner = await createUser();
    const plain = await createUser();
    const g = await createGuild(owner, 0n); // @everyone has no perms
    await addMember(g, owner);
    await addMember(g, plain);
    await writeAudit({ guildId: g, actorId: owner, action: 'guild.update', targetType: 'guild' });

    const res = await authedGet(`/guilds/${g}/audit-log`, await tokenFor(plain));
    expect(res.status).toBe(403);
  });

  it('grants access to a non-admin who holds VIEW_AUDIT_LOG via a role', async () => {
    const owner = await createUser();
    const observer = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, owner);
    await addMember(g, observer);
    const role = await createRole(g, P.VIEW_AUDIT_LOG, 1);
    await assignRole(g, observer, role);
    await writeAudit({ guildId: g, actorId: owner, action: 'guild.update', targetType: 'guild' });

    const res = await authedGet(`/guilds/${g}/audit-log`, await tokenFor(observer));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: unknown[] };
    expect(body.entries).toHaveLength(1);
  });

  it('paginates with ?before= and filters with ?actionPrefix= and ?actorId=', async () => {
    const owner = await createUser();
    const mod = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, owner);
    await addMember(g, mod);
    await writeAudit({ guildId: g, actorId: owner, action: 'member.kick', targetType: 'member', targetId: mod });
    await writeAudit({ guildId: g, actorId: mod, action: 'member.ban', targetType: 'member', targetId: owner });
    await writeAudit({ guildId: g, actorId: owner, action: 'channel.create', targetType: 'channel' });
    const token = await tokenFor(owner);

    // limit=1 → newest only; then before that id → the next page.
    const page1 = await authedGet(`/guilds/${g}/audit-log?limit=1`, token);
    const b1 = (await page1.json()) as { entries: Array<{ id: string; action: string }> };
    expect(b1.entries).toHaveLength(1);
    expect(b1.entries[0]!.action).toBe('channel.create');
    const page2 = await authedGet(`/guilds/${g}/audit-log?limit=1&before=${b1.entries[0]!.id}`, token);
    const b2 = (await page2.json()) as { entries: Array<{ action: string }> };
    expect(b2.entries[0]!.action).toBe('member.ban');

    // actionPrefix
    const memberOnly = await authedGet(`/guilds/${g}/audit-log?actionPrefix=member.`, token);
    const bm = (await memberOnly.json()) as { entries: Array<{ action: string }> };
    expect(bm.entries.map((e) => e.action).sort()).toEqual(['member.ban', 'member.kick']);

    // actorId — only the mod's actions
    const byMod = await authedGet(`/guilds/${g}/audit-log?actorId=${mod}`, token);
    const bmod = (await byMod.json()) as { entries: Array<{ action: string; actor: { id: string } | null }> };
    expect(bmod.entries).toHaveLength(1);
    expect(bmod.entries[0]!.action).toBe('member.ban');
    expect(bmod.entries[0]!.actor?.id).toBe(mod.toString());
  });

  it('service-level actorId filter narrows to a single actor', async () => {
    const a = await createUser();
    const b = await createUser();
    const g = await createGuild(a, 0n);
    await writeAudit({ guildId: g, actorId: a, action: 'guild.update', targetType: 'guild' });
    await writeAudit({ guildId: g, actorId: b, action: 'guild.update', targetType: 'guild' });
    const onlyA = await listAuditEntries(g, { actorId: a });
    expect(onlyA).toHaveLength(1);
    expect(onlyA[0]!.actor?.id).toBe(a);
  });
});
