import { describe, it, expect, afterAll } from 'vitest';
import { Hono } from 'hono';
import { Permissions as P } from '@zekktris/shared/permissions';
import { usersRouter } from '../src/routes/users';
import { guildsRouter } from '../src/routes/guilds';
import { errorHandler } from '../src/middleware';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import { createUser, createGuild, addMember, createChannel, cleanupAll } from './seed';
import {
  createBot,
  addBotToGuild,
  registerBotCommand,
  setBotEventConfig,
  listBotCommands,
} from '../src/services/bots';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping bot-commands tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/users', usersRouter);
app.route('/guilds', guildsRouter);

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return signAccessToken({ userId, sessionId: session.id });
}
function req(method: string, path: string, token: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe.runIf(dbReady)('bot slash-commands', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('owner registers/lists/deletes commands; a non-owner cannot', async () => {
    const owner = await createUser();
    const stranger = await createUser();
    const { bot } = await createBot({ ownerId: owner, username: `b_${owner}`, displayName: 'Bot' });
    const ownerTok = await tokenFor(owner);

    // Register
    const reg = await req('POST', `/users/@me/bots/${bot.id}/commands`, ownerTok, {
      name: 'Ping',
      description: 'replies pong',
    });
    expect(reg.status).toBe(201);
    const regBody = (await reg.json()) as { command: { name: string; id: string } };
    expect(regBody.command.name).toBe('ping'); // lowercased by the service

    // List
    const list = await req('GET', `/users/@me/bots/${bot.id}/commands`, ownerTok);
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { commands: Array<{ name: string }> };
    expect(listBody.commands.map((cmd) => cmd.name)).toContain('ping');

    // A stranger can't register on someone else's bot.
    const denied = await req('POST', `/users/@me/bots/${bot.id}/commands`, await tokenFor(stranger), {
      name: 'evil',
      description: 'nope',
    });
    expect([403, 404]).toContain(denied.status);

    // Delete
    const del = await req('DELETE', `/users/@me/bots/${bot.id}/commands/${regBody.command.id}`, ownerTok);
    expect(del.status).toBe(200);
    expect(await listBotCommands(bot.id, owner)).toHaveLength(0);
  });

  it('guild command list shows a member-bot’s commands; non-members are blocked', async () => {
    const owner = await createUser();
    const outsider = await createUser();
    const g = await createGuild(owner, P.VIEW_CHANNEL);
    await addMember(g, owner);
    const { bot } = await createBot({ ownerId: owner, username: `gb_${owner}`, displayName: 'GBot' });
    await addBotToGuild({ botId: bot.id, guildId: g, actorId: owner });
    await registerBotCommand({ botId: bot.id, ownerId: owner, guildId: null, name: 'hello', description: 'hi' });

    const list = await req('GET', `/guilds/${g}/commands`, await tokenFor(owner));
    expect(list.status).toBe(200);
    const body = (await list.json()) as { commands: Array<{ name: string; botName: string }> };
    expect(body.commands.some((cmd) => cmd.name === 'hello')).toBe(true);

    // A non-member can't list the guild's commands (ensureMember → 404).
    expect([403, 404]).toContain(
      (await req('GET', `/guilds/${g}/commands`, await tokenFor(outsider))).status,
    );
  });

  // 20s timeout: this test pays the one-time dynamic-import transform cost
  // of the message/dispatch graph — slow on the SMB-mounted repo.
  it('invoke resolves a command (delivers to the bot callback) and 404s unknown / 400s no-callback', { timeout: 20_000 }, async () => {
    const owner = await createUser();
    const g = await createGuild(owner, P.VIEW_CHANNEL);
    await addMember(g, owner);
    const ch = await createChannel(g); // @everyone has VIEW_CHANNEL → bot can see it
    const { bot } = await createBot({ ownerId: owner, username: `ib_${owner}`, displayName: 'IBot' });
    await addBotToGuild({ botId: bot.id, guildId: g, actorId: owner });
    await registerBotCommand({ botId: bot.id, ownerId: owner, guildId: null, name: 'do', description: 'does' });
    const ownerTok = await tokenFor(owner);

    // No callback yet → 400 (the bot can't receive interactions).
    const noCb = await req('POST', `/guilds/${g}/commands/invoke`, ownerTok, {
      channelId: ch.toString(),
      name: 'do',
    });
    expect(noCb.status).toBe(400);

    // Unknown command → 404.
    const unknown = await req('POST', `/guilds/${g}/commands/invoke`, ownerTok, {
      channelId: ch.toString(),
      name: 'nope',
    });
    expect(unknown.status).toBe(404);

    // Configure a callback → invoke resolves 200 (delivery is fire-and-forget;
    // the unreachable URL is swallowed inside the service).
    await setBotEventConfig(bot.id, owner, 'https://bot.invalid/events');
    const ok = await req('POST', `/guilds/${g}/commands/invoke`, ownerTok, {
      channelId: ch.toString(),
      name: 'do',
      argText: 'arg here',
    });
    expect(ok.status).toBe(200);
    const okBody = (await ok.json()) as { commandName: string; botName: string };
    expect(okBody.commandName).toBe('do');
    expect(okBody.botName).toBe('IBot');
  });
});
