// Run with `npm test` (Node 22.18+ runs TypeScript directly).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { answeredFrom, findServer } from '../src/server.ts';

function listen(handler: Parameters<typeof createServer>[1]): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer(handler);
    s.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const originOf = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

const zekktris = await listen((req, res) => {
  if (req.url === '/api/v1/instance/info') {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ software: 'zekktris' }));
  } else {
    res.statusCode = 404;
    res.end();
  }
});
const redirector = await listen((req, res) => {
  res.statusCode = 301;
  res.setHeader('location', `${originOf(zekktris)}${req.url}`);
  res.end();
});

test.after(() => {
  zekktris.close();
  redirector.close();
});

test('findServer keeps the typed origin when it serves the app itself', async () => {
  assert.deepEqual(await findServer(originOf(zekktris)), {
    ok: true,
    origin: originOf(zekktris),
  });
});

test('findServer stores the origin a redirect lands on, not the typed one', async () => {
  // The app window may only stay on the stored origin, so storing the
  // redirecting one would bounce every load out to the browser.
  assert.deepEqual(await findServer(originOf(redirector)), {
    ok: true,
    origin: originOf(zekktris),
  });
});

test('a redirect is held to the same rules as a typed address', () => {
  assert.deepEqual(answeredFrom('https://www.chat.example.com/api/v1/instance/info'), {
    ok: true,
    origin: 'https://www.chat.example.com',
  });
  assert.deepEqual(answeredFrom('http://192.168.1.20:5550/health'), {
    ok: true,
    origin: 'http://192.168.1.20:5550',
  });
  // Plain http on the public internet is refused, as when typed.
  assert.equal(answeredFrom('http://chat.example.com/api/v1/instance/info').ok, false);
});
