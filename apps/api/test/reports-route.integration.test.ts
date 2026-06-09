import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { Permissions as P } from '@zekktris/shared/permissions';
import { db, schema } from '../src/db';
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
  createChannel,
  createMessage,
  cleanupAll,
} from './seed';
import { createReport, listReports } from '../src/services/reports';
import { isBanned } from '../src/services/bans';
import { listAuditEntries } from '../src/services/audit';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping reports-route tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/guilds', guildsRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
function patch(path: string, token: string, body: unknown) {
  return app.request(path, {
    method: 'PATCH',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}
function get(path: string, token: string) {
  return app.request(path, { headers: { authorization: `Bearer ${token}` } });
}

describe.runIf(dbReady)('reports triage queue (route)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('lists reports for a moderator, gated against non-moderators, with status/type filters', async () => {
    const owner = await createUser();
    const mod = await createUser();
    const plain = await createUser();
    const offender = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, owner);
    await addMember(g, mod);
    await addMember(g, plain);
    await addMember(g, offender);
    // mod holds BAN_MEMBERS (a MOD_PERM) via a role; plain holds nothing.
    const modRole = await createRole(g, P.BAN_MEMBERS, 1);
    await assignRole(g, mod, modRole);

    await createReport({ guildId: g, reporterId: owner, targetType: 'user', targetUserId: offender, reason: 'spam' });

    // Non-mod → 403.
    expect((await get(`/guilds/${g}/reports`, await tokenFor(plain))).status).toBe(403);

    // Mod → 200 with the report + openCount.
    const res = await get(`/guilds/${g}/reports`, await tokenFor(mod));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { reports: Array<{ targetType: string }>; openCount: number };
    expect(body.openCount).toBeGreaterThanOrEqual(1);
    expect(body.reports.some((r) => r.targetType === 'user')).toBe(true);

    // Type filter: ?targetType=message → none here.
    const msgOnly = await get(`/guilds/${g}/reports?targetType=message`, await tokenFor(mod));
    const mb = (await msgOnly.json()) as { reports: unknown[] };
    expect(mb.reports).toHaveLength(0);
  });

  it('resolve writes a report.resolve audit entry', async () => {
    const owner = await createUser();
    const offender = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, owner);
    await addMember(g, offender);
    const report = await createReport({ guildId: g, reporterId: owner, targetType: 'user', targetUserId: offender, reason: 'other' });

    const res = await patch(`/guilds/${g}/reports/${report.id}`, await tokenFor(owner), { action: 'resolve', note: 'handled' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { report: { status: string } };
    expect(body.report.status).toBe('resolved');

    const audit = await listAuditEntries(g, { actionPrefix: 'report.' });
    expect(audit.some((a) => a.entry.action === 'report.resolve')).toBe(true);
  });

  it('resolve + moderation=ban bans the target and resolves; needs BAN_MEMBERS', async () => {
    const owner = await createUser();
    const offender = await createUser();
    const weakMod = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, owner);
    await addMember(g, offender);
    await addMember(g, weakMod);
    // weakMod can view the queue (MANAGE_MESSAGES) but cannot ban.
    const weakRole = await createRole(g, P.MANAGE_MESSAGES, 1);
    await assignRole(g, weakMod, weakRole);
    const report = await createReport({ guildId: g, reporterId: owner, targetType: 'user', targetUserId: offender, reason: 'harassment' });

    // weakMod attempting a ban via the report → 403 (lacks BAN_MEMBERS).
    const denied = await patch(`/guilds/${g}/reports/${report.id}`, await tokenFor(weakMod), {
      action: 'resolve',
      moderation: 'ban',
    });
    expect(denied.status).toBe(403);
    expect(await isBanned(g, offender)).toBe(false);

    // owner (all perms) bans via the report.
    const ok = await patch(`/guilds/${g}/reports/${report.id}`, await tokenFor(owner), {
      action: 'resolve',
      moderation: 'ban',
      note: 'repeated harassment',
    });
    expect(ok.status).toBe(200);
    expect(await isBanned(g, offender)).toBe(true);
    const [row] = await listReports(g, { status: 'resolved' });
    expect(row?.report.status).toBe('resolved');
    // Both the ban and the report decision are audited.
    const audit = await listAuditEntries(g);
    const actions = audit.map((a) => a.entry.action);
    expect(actions).toContain('ban.add');
    expect(actions).toContain('report.resolve');
  });

  it('resolve + moderation=delete_message soft-deletes the reported message', async () => {
    const owner = await createUser();
    const offender = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, owner);
    await addMember(g, offender);
    const ch = await createChannel(g);
    const msgId = await createMessage(ch, { authorId: offender, content: 'bad message' });
    const report = await createReport({
      guildId: g,
      reporterId: owner,
      targetType: 'message',
      targetUserId: offender,
      messageId: msgId,
      channelId: ch,
      messageContent: 'bad message',
      reason: 'nsfw',
    });

    const res = await patch(`/guilds/${g}/reports/${report.id}`, await tokenFor(owner), {
      action: 'resolve',
      moderation: 'delete_message',
    });
    expect(res.status).toBe(200);
    const [m] = await db
      .select({ deletedAt: schema.messages.deletedAt })
      .from(schema.messages)
      .where(eq(schema.messages.id, msgId))
      .limit(1);
    expect(m?.deletedAt).not.toBeNull();
  });

  it('delete_message on a user-report is rejected', async () => {
    const owner = await createUser();
    const offender = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, owner);
    await addMember(g, offender);
    const report = await createReport({ guildId: g, reporterId: owner, targetType: 'user', targetUserId: offender, reason: 'spam' });
    const res = await patch(`/guilds/${g}/reports/${report.id}`, await tokenFor(owner), {
      action: 'resolve',
      moderation: 'delete_message',
    });
    expect(res.status).toBe(400);
  });
});
