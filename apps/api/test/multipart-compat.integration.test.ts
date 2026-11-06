/**
 * Multipart compatibility: the upload routes, behind the real createApp() stack
 * (body limit, multipartCompat, auth), with the request bodies the clients
 * actually send.
 *
 * Installed Android builds send part names bare (`form-data; name=payload_json`,
 * Ktor's formData{}), which Node's form parser rejects. Those used to be a 500
 * on every Android upload. They must now go through, the browser shape must
 * keep working, a body nothing can parse must be a 400 and an oversized one a
 * 413.
 */
import { describe, it, expect, afterAll, vi } from 'vitest';
import { randomInt } from 'node:crypto';
import { Hono } from 'hono';
import { DEFAULT_EVERYONE_PERMISSIONS } from '@zekktris/shared/permissions';
import { createApp } from '../src/server';
import { messagesRouter } from '../src/routes/messages';
import { errorHandler } from '../src/middleware';
import {
  multipartCompat,
  parseFormBody,
  quoteBareDispositionParams,
} from '../src/middleware/multipartCompat';
import { createSession } from '../src/auth/sessions';
import { signAccessToken } from '../src/auth/tokens';
import {
  createUser,
  createGuild,
  addMember,
  createChannel,
  createDmChannel,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';

// A small upload ceiling so the over-limit case needs a few MB, not ~1 GB:
// the multipart body limit is MAX_UPLOAD_SIZE_MB × MAX_FILES_PER_MESSAGE + 4 MB
// = 5 MB here. Set before src/env is imported, which reads them once.
vi.hoisted(() => {
  process.env.MAX_UPLOAD_SIZE_MB = '1';
  process.env.MAX_FILES_PER_MESSAGE = '1';
});
const UPLOAD_BODY_LIMIT = 5 * 1024 * 1024;

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping multipart-compat tests — no database reachable');
}

const app = createApp();

async function tokenFor(userId: bigint): Promise<string> {
  const { session } = await createSession({ userId, userAgent: 'test', ipAddress: null });
  return `Bearer ${await signAccessToken({ userId, sessionId: session.id })}`;
}

// ── Request bodies as the clients write them ──────────────────────────────

type Part = { name: string; value: string | Uint8Array; filename?: string; type?: string };

/** Ktor's boundary: 32 random ints in hex (negative ones keep their '-'), cut
 *  to 70 characters. */
function ktorBoundary(): string {
  let s = '';
  while (s.length < 70) s += randomInt(-(2 ** 31), 2 ** 31).toString(16);
  return s.slice(0, 70);
}

/**
 * Byte for byte what Ktor 3.0.3's formData{} + MultiPartFormDataContent write
 * for the Android ApiClient calls: the key goes out bare unless it contains a
 * separator (so `payload_json`, `file` and `name` are bare and `files[0]` is
 * quoted), the app's own `filename="…"` Content-Disposition value is joined
 * on with "; ", then Content-Type, then a Content-Length for every part.
 */
function ktorBody(parts: Part[]): { body: Buffer; contentType: string } {
  const boundary = ktorBoundary();
  const quoteIfNeeded = (key: string) => (/[\s"(),/:;<=>?@[\\\]{}]/.test(key) ? `"${key}"` : key);
  const chunks: Buffer[] = [];
  for (const p of parts) {
    const bytes = typeof p.value === 'string' ? Buffer.from(p.value, 'utf8') : Buffer.from(p.value);
    const disposition = [`form-data; name=${quoteIfNeeded(p.name)}`];
    if (p.filename !== undefined) disposition.push(`filename="${p.filename}"`);
    const head =
      `--${boundary}\r\n` +
      `Content-Disposition: ${disposition.join('; ')}\r\n` +
      (p.type ? `Content-Type: ${p.type}\r\n` : '') +
      `Content-Length: ${bytes.length}\r\n` +
      '\r\n';
    chunks.push(Buffer.from(head, 'utf8'), bytes, Buffer.from('\r\n'));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` };
}

/** File content that would trip a careless rewrite: a bare-name
 *  Content-Disposition line of its own, CR/LF and every byte value. */
function trickyBytes(): Uint8Array {
  const fake = Buffer.from(
    '\r\nContent-Disposition: form-data; name=sneaky\r\n\r\nname=x;',
    'latin1',
  );
  const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  return new Uint8Array(Buffer.concat([all, fake, all]));
}

// A valid 1×1 PNG, for the image-only routes.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

/** A valid first part opened with `boundary`, then `fill` with no delimiter
 *  after it, so the parser searches all of `fill` for the next one. */
function openPart(boundary: string, fill: Buffer): Buffer {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="a.png"\r\n` +
        'Content-Type: image/png\r\n\r\n',
      'utf8',
    ),
    PNG,
    fill,
  ]);
}

/**
 * Content-Types of 256 chars that hand the form parser a boundary of over 400
 * bytes, one boundaryOf() doesn't see: hidden behind a quoted parameter, or
 * after a space (where boundaryOf() stops). Padded with U+00FF, which is how
 * Node reads a 0xFF header byte: one char of the header, but two bytes of the
 * UTF-8 the parser encodes its boundary in.
 */
const WIDE_BOUNDARIES = [
  wideBoundary('multipart/form-data; x="; boundary=short"; boundary=', '\u00ffb'),
  wideBoundary('multipart/form-data; boundary=', '\u00ff \u00ffb'),
];

function wideBoundary(params: string, start: string) {
  const contentType = (params + start).padEnd(256, '\u00ff');
  return { contentType, boundary: contentType.slice(params.length) };
}

/** `ÿ` in UTF-8 (C3 BF) over and over: every position looks like the start
 *  of a wide boundary, so the search can't skip ahead. */
function wideFill(size: number): Buffer {
  return Buffer.alloc(size, '\u00ff', 'utf8');
}

async function postRaw(
  path: string,
  userId: bigint,
  body: RequestInit['body'],
  contentType?: string,
  target: { request: Hono['request'] } = app,
) {
  const headers: Record<string, string> = { authorization: await tokenFor(userId) };
  if (contentType) headers['content-type'] = contentType;
  const res = await target.request(path, { method: 'POST', headers, body });
  return { status: res.status, json: (await res.json()) as any };
}

function sendKtorMessage(userId: bigint, channelId: bigint, file: Uint8Array, filename: string) {
  const { body, contentType } = ktorBody([
    {
      name: 'payload_json',
      value: JSON.stringify({ content: 'from android' }),
      type: 'application/json',
    },
    { name: 'files[0]', value: file, filename, type: 'application/octet-stream' },
  ]);
  return postRaw(`/api/v1/channels/${channelId}/messages`, userId, body, contentType);
}

/** The stored attachment, read back through the CDN like a client would. */
async function cdnBytes(url: string): Promise<Uint8Array> {
  const res = await app.request(url);
  expect(res.status).toBe(200);
  return new Uint8Array(await res.arrayBuffer());
}

async function guildWithMember() {
  const owner = await createUser();
  const member = await createUser();
  const guildId = await createGuild(owner, DEFAULT_EVERYONE_PERMISSIONS);
  await addMember(guildId, owner);
  await addMember(guildId, member);
  const channelId = await createChannel(guildId);
  return { owner, member, guildId, channelId };
}

describe('quoteBareDispositionParams', () => {
  it('quotes bare names in part headers and leaves part contents byte for byte', () => {
    const file = trickyBytes();
    const { body, contentType } = ktorBody([
      { name: 'payload_json', value: '{}', type: 'application/json' },
      { name: 'file', value: file, filename: 'Résumé ✓.bin', type: 'application/octet-stream' },
    ]);
    const boundary = contentType.split('boundary=')[1]!;
    const out = Buffer.concat(quoteBareDispositionParams(body, boundary)!);
    const text = out.toString('latin1');
    expect(text).toContain('Content-Disposition: form-data; name="payload_json"\r\n');
    expect(text).toContain(
      `Content-Disposition: form-data; name="file"; filename="${Buffer.from('Résumé ✓.bin').toString('latin1')}"\r\n`,
    );
    // Only the two header lines changed, by two quotes each.
    expect(out.length).toBe(body.length + 4);
    expect(out.indexOf(Buffer.from(file))).toBeGreaterThan(-1);
  });

  it('leaves a body that needs nothing alone, and a quoted value with "; name=" in it', () => {
    const boundary = 'b'.repeat(30);
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="a"; filename="x; name=y; z.txt"\r\n\r\nhi\r\n--${boundary}--\r\n`,
    );
    expect(quoteBareDispositionParams(body, boundary)).toBeNull();
  });

  it('trims only the spaces and tabs after a bare value', () => {
    const boundary = 'b'.repeat(30);
    // 'voilà' ends in the byte 0xA0, which latin1 reads as a no-break space.
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name=file \t; filename=voilà  \r\n\r\nhi\r\n--${boundary}--\r\n`,
    );
    const out = Buffer.concat(quoteBareDispositionParams(body, boundary)!);
    expect(out.toString()).toContain(
      'Content-Disposition: form-data; name="file"; filename="voilà"\r\n',
    );
  });

  it('stays fast on a long run of blanks inside a header', () => {
    // A bare value, then a long run of blanks the value can't end on (a `"`
    // follows it). The old pattern took ~90 ms per block like this, and the
    // repair runs on the event loop.
    const boundary = 'b'.repeat(30);
    const part = `--${boundary}\r\nContent-Disposition: form-data; name=a${' '.repeat(8000)}"\r\n\r\nx\r\n`;
    const body = Buffer.from(part.repeat(50) + `--${boundary}--\r\n`);

    const started = performance.now();
    expect(quoteBareDispositionParams(body, boundary)).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('leaves a part header block over the size cap alone', () => {
    const boundary = 'b'.repeat(30);
    const body = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name=file\r\nX-Pad: ${'p'.repeat(9000)}\r\n\r\nhi\r\n--${boundary}--\r\n`,
    );
    expect(quoteBareDispositionParams(body, boundary)).toBeNull();
  });
});

describe('multipartCompat', () => {
  it('refuses a 256-char Content-Type whose boundary is over 250 UTF-8 bytes, before reading the body', async () => {
    const bare = new Hono();
    bare.onError(errorHandler);
    bare.use(multipartCompat);
    bare.post('/', async (c) => c.json(await parseFormBody(c)));
    // Counted in chars, these headers passed, and Buffer.indexOf for a
    // boundary this long held the event loop for ~1.9 s per 20 MB.
    const fill = wideFill(20 * 1024 * 1024);

    for (const { contentType, boundary } of WIDE_BOUNDARIES) {
      expect(contentType).toHaveLength(256);
      expect(Buffer.byteLength(`--${boundary}`)).toBeGreaterThan(400);
      const body = openPart(boundary, fill);

      const started = performance.now();
      const res = await bare.request('/', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body,
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.message).toBe('Malformed multipart body');
      expect(performance.now() - started).toBeLessThan(500);
    }
  });
});

describe.runIf(dbReady)('multipart uploads through createApp()', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('Android (bare part names): message with an attachment in a DM → 201, file stored intact', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const file = trickyBytes();

    const r = await sendKtorMessage(a, dm, file, 'notes.bin');

    expect(r.status).toBe(201);
    expect(r.json.message.content).toBe('from android');
    const [att] = r.json.message.attachments;
    expect(att.filename).toBe('notes.bin');
    expect(att.size).toBe(file.length);
    expect(Buffer.from(await cdnBytes(att.url)).equals(Buffer.from(file))).toBe(true);
  });

  it('Android (bare part names): message with an attachment in a guild channel → 201', async () => {
    const { member, channelId } = await guildWithMember();
    const file = trickyBytes();

    const r = await sendKtorMessage(member, channelId, file, 'Résumé ✓.bin');

    expect(r.status).toBe(201);
    const [att] = r.json.message.attachments;
    expect(att.filename).toBe('Résumé ✓.bin');
    expect(att.size).toBe(file.length);
  });

  it('browser FormData still works', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const file = trickyBytes();
    const fd = new FormData();
    fd.append('payload_json', JSON.stringify({ content: 'from the web' }));
    fd.append('files[0]', new File([file], 'web.bin', { type: 'application/octet-stream' }));

    // No content-type: Request derives it (with the boundary) from the FormData.
    const r = await postRaw(`/api/v1/channels/${dm}/messages`, a, fd);

    expect(r.status).toBe(201);
    expect(r.json.message.content).toBe('from the web');
    const [att] = r.json.message.attachments;
    expect(Buffer.from(await cdnBytes(att.url)).equals(Buffer.from(file))).toBe(true);
  });

  it('a body that is not multipart at all → 400, not 500', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);

    const garbage = await postRaw(
      `/api/v1/channels/${dm}/messages`,
      a,
      'this is not a multipart body',
      `multipart/form-data; boundary=${ktorBoundary()}`,
    );
    expect(garbage.status).toBe(400);
    expect(garbage.json.error).toEqual({
      code: 'BAD_REQUEST',
      message: 'Malformed multipart body',
    });

    // A `"` inside a filename breaks the framing for good; still the client's 400.
    const quoted = ktorBody([
      { name: 'payload_json', value: '{}', type: 'application/json' },
      { name: 'files[0]', value: new Uint8Array([1, 2, 3]), filename: 'My "draft".pdf' },
    ]);
    const r = await postRaw(`/api/v1/channels/${dm}/messages`, a, quoted.body, quoted.contentType);
    expect(r.status).toBe(400);
  });

  it('a malformed body is a 400 even where multipartCompat is not mounted', async () => {
    const bare = new Hono();
    bare.onError(errorHandler);
    bare.route('/channels', messagesRouter);
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);

    const r = await postRaw(
      `/channels/${dm}/messages`,
      a,
      'this is not a multipart body',
      `multipart/form-data; boundary=${ktorBoundary()}`,
      bare,
    );

    expect(r.status).toBe(400);
    expect(r.json.error.message).toBe('Malformed multipart body');
  });

  it('an over-limit body is still a 413, streamed or declared', async () => {
    const a = await createUser();
    const b = await createUser();
    const dm = await createDmChannel([a, b]);
    const { body, contentType } = ktorBody([
      { name: 'payload_json', value: '{}', type: 'application/json' },
      { name: 'files[0]', value: new Uint8Array(UPLOAD_BODY_LIMIT + 1), filename: 'big.bin' },
    ]);
    const path = `/api/v1/channels/${dm}/messages`;
    const token = await tokenFor(a);

    // No Content-Length: bodyLimit counts the bytes as they stream in.
    const streamed = await app.request(path, {
      method: 'POST',
      headers: { authorization: token, 'content-type': contentType },
      body,
    });
    expect(streamed.status).toBe(413);
    expect(((await streamed.json()) as any).error.message).toBe('Request body too large');

    // Content-Length given: refused from the header, before anything is read.
    const declared = await app.request(path, {
      method: 'POST',
      headers: {
        authorization: token,
        'content-type': contentType,
        'content-length': String(body.length),
      },
      body,
    });
    expect(declared.status).toBe(413);
  });

  it('Android avatar upload (bare `file` part name) → 200 with the new avatar', async () => {
    const a = await createUser();
    const { body, contentType } = ktorBody([
      { name: 'file', value: PNG, filename: 'avatar.png', type: 'image/png' },
    ]);

    const r = await postRaw('/api/v1/users/@me/avatar', a, body, contentType);

    expect(r.status).toBe(200);
    expect(r.json.user.avatarUrl).toMatch(/^\/cdn\//);
  });

  it('Android guild icon upload (bare `file` part name) → 200 with the new icon', async () => {
    const { owner, guildId } = await guildWithMember();
    const { body, contentType } = ktorBody([
      { name: 'file', value: PNG, filename: 'icon.png', type: 'image/png' },
    ]);

    const r = await postRaw(`/api/v1/guilds/${guildId}/icon`, owner, body, contentType);

    expect(r.status).toBe(200);
    expect(r.json.guild.iconUrl).toMatch(/^\/cdn\//);
  });

  it('a bare name followed by a long run of blanks → a quick 400', async () => {
    const a = await createUser();
    const token = await tokenFor(a);
    const boundary = ktorBoundary();
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name=file${' '.repeat(100_000)}"\r\n` +
          'Content-Type: image/png\r\n\r\n',
      ),
      PNG,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    const started = performance.now();
    const res = await app.request('/api/v1/users/@me/avatar', {
      method: 'POST',
      headers: {
        authorization: token,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      body,
    });

    expect(res.status).toBe(400);
    expect(performance.now() - started).toBeLessThan(2000);
  });

  it('a boundary over 70 chars → a quick 400, the body never searched', async () => {
    const a = await createUser();
    const token = await tokenFor(a);
    // Buffer.indexOf for a needle this long in a body of dashes took ~13 s per
    // 5 MB, in the repair and in Node's own form parser alike.
    const long = '-b' + '-'.repeat(7998);
    // Under the 5 MB body limit, so it is the boundary that gets refused.
    const dashes = Buffer.alloc(4 * 1024 * 1024, '-');
    const cases = [
      { contentType: `multipart/form-data; boundary=${long}`, body: dashes },
      {
        // boundaryOf() reads `short"` out of the quoted x="…", but the form
        // parser takes the second, long boundary. The header length cap
        // refuses this one.
        contentType: `multipart/form-data; x="; boundary=short"; boundary=${long}`,
        body: openPart(long, dashes),
      },
      // 256 chars, but over 256 bytes once the parser encodes them as UTF-8.
      ...WIDE_BOUNDARIES.map(({ contentType, boundary }) => ({
        contentType,
        body: openPart(boundary, wideFill(dashes.length)),
      })),
    ];

    for (const { contentType, body } of cases) {
      const started = performance.now();
      const res = await app.request('/api/v1/users/@me/avatar', {
        method: 'POST',
        headers: { authorization: token, 'content-type': contentType },
        body,
      });

      expect(res.status).toBe(400);
      expect(((await res.json()) as any).error.message).toBe('Malformed multipart body');
      expect(performance.now() - started).toBeLessThan(1000);
    }
  });

  it('Android guild emoji upload (bare `name` and `file` part names) → 201', async () => {
    const { owner, guildId } = await guildWithMember();
    const { body, contentType } = ktorBody([
      { name: 'name', value: 'party_parrot' },
      { name: 'file', value: PNG, filename: 'party.png', type: 'image/png' },
    ]);

    const r = await postRaw(`/api/v1/guilds/${guildId}/emojis`, owner, body, contentType);

    expect(r.status).toBe(201);
    expect(r.json.emoji.name).toBe('party_parrot');
  });
});
