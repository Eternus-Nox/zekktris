import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createServer, type Server } from 'node:https';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Permissions as P } from '@zekktris/shared/permissions';
import { createUser, createGuild, addMember, createChannel, cleanupAll } from './seed';
import {
  createBot,
  addBotToGuild,
  registerBotCommand,
  setBotEventConfig,
  invokeBotCommand,
  deliverMessageEventToBots,
} from '../src/services/bots';
import { probeDb, closeDb } from './db-available';

// The SSRF guard refuses loopback callbacks. This test's bot endpoint is a
// local HTTPS server, so let only that guard through; the real connect path
// (DNS resolve → pinned-IP lookup hook → TLS → POST) is what's under test.
vi.mock('../src/services/embeds', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/services/embeds')>()),
  isPrivateIp: () => false,
}));

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping bot-event-delivery tests — no database reachable');
}

interface Received {
  event: string | undefined;
  signature: string | undefined;
  body: string;
}

describe.runIf(dbReady)('bot event delivery', () => {
  let server: Server;
  let port = 0;
  let certDir = '';
  const received: Received[] = [];
  const prevTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

  beforeAll(async () => {
    // Throwaway self-signed cert for the local "bot" (callbacks must be https).
    certDir = mkdtempSync(join(tmpdir(), 'zk-bot-tls-'));
    execFileSync('openssl', [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=localhost',
      '-keyout', join(certDir, 'key.pem'),
      '-out', join(certDir, 'cert.pem'),
    ], { stdio: 'ignore' });
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
    server = createServer(
      { key: readFileSync(join(certDir, 'key.pem')), cert: readFileSync(join(certDir, 'cert.pem')) },
      (req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          received.push({
            event: req.headers['x-zekktris-event'] as string | undefined,
            signature: req.headers['x-zekktris-signature'] as string | undefined,
            body,
          });
          res.writeHead(204).end();
        });
      },
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as { port: number }).port;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (prevTls === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = prevTls;
    rmSync(certDir, { recursive: true, force: true });
    await cleanupAll();
    await closeDb();
  });

  it('delivers interaction.create and message.create, each with its own event header', async () => {
    const owner = await createUser();
    const g = await createGuild(owner, P.VIEW_CHANNEL);
    await addMember(g, owner);
    const ch = await createChannel(g);
    const { bot } = await createBot({ ownerId: owner, username: `ev_${owner}`, displayName: 'EvBot' });
    await addBotToGuild({ botId: bot.id, guildId: g, actorId: owner });
    await registerBotCommand({ botId: bot.id, ownerId: owner, guildId: null, name: 'ping', description: 'p' });
    const { secret } = await setBotEventConfig(bot.id, owner, `https://localhost:${port}/events`);

    // invokeBotCommand awaits the POST, so the request has landed on return.
    await invokeBotCommand({ invokerId: owner, guildId: g, channelId: ch, name: 'ping', argText: 'x' });
    expect(received).toHaveLength(1);
    const interaction = received[0]!;
    expect(interaction.event).toBe('interaction.create');
    expect(JSON.parse(interaction.body)).toMatchObject({
      type: 'interaction.create',
      interaction: { command: 'ping', argText: 'x', channelId: ch.toString() },
    });
    expect(interaction.signature).toBe(
      createHmac('sha256', secret!).update(interaction.body).digest('hex'),
    );

    await deliverMessageEventToBots({
      guildId: g,
      channelId: ch,
      authorId: owner,
      authorIsBot: false,
      event: { type: 'message.create', message: { id: '1', content: 'hi' } },
    });
    expect(received).toHaveLength(2);
    expect(received[1]!.event).toBe('message.create');
    expect(JSON.parse(received[1]!.body)).toMatchObject({ type: 'message.create' });
  });
});
