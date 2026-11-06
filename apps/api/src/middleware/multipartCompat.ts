/**
 * Multipart compatibility
 * -----------------------
 * Lets multipart uploads from already-installed Android builds through Node's
 * strict form parser, and turns a body that can't be parsed into a 400.
 *
 * Ktor (the Android HTTP client) writes a part's field name bare whenever the
 * name has no separator characters in it:
 *
 *   Content-Disposition: form-data; name=payload_json
 *
 * The parser behind Request.formData() (undici, which implements the WHATWG
 * multipart algorithm) accepts only `form-data; name="…"` and rejects the whole
 * body with a TypeError. That came out as a 500 on every Android message with
 * an attachment, and on every avatar, banner, guild icon and emoji upload.
 * Newer Android builds quote the names themselves; this keeps the installed
 * ones working.
 *
 * How: for a multipart/form-data request, the middleware gives Hono's
 * per-request body cache a `formData` entry that parses on first use, so
 * c.req.parseBody() / c.req.formData() in every route read from it. The body is
 * read once (after bodyLimit, so it is still counted) and parsed as it is. Only
 * if that fails are bare `name=` / `filename=` values in the part HEADER blocks
 * quoted, and the body parsed again. Part contents are never touched. A body
 * that still won't parse is a 400 'Malformed multipart body', not a 500.
 *
 * The parse is deferred to the route instead of done here up front because
 * routes authenticate and check permissions before they read the body. Parsing
 * here would buffer and parse an up-to-~1 GB upload for requests that are
 * about to be refused.
 */

import type { Context, HonoRequest, MiddlewareHandler } from 'hono';
import type { BodyData, ParseBodyOptions } from 'hono/utils/body';
import { errors } from '../errors';

export const multipartCompat: MiddlewareHandler = async (c, next) => {
  const contentType = c.req.header('content-type');
  // The same test parseBody uses to decide a body is multipart.
  if (contentType?.startsWith('multipart/form-data')) {
    let parsed: Promise<FormData> | undefined;
    Object.defineProperty(c.req.bodyCache, 'formData', {
      // Hono's cache holds promises, and its readers check `bodyCache.formData`
      // before touching the raw body. A getter makes the parse lazy.
      get: () => (parsed ??= parseMultipart(c.req, contentType)),
      // Writes still land (Hono's form validator fills this slot when it is
      // empty); with a getter alone they would throw.
      set: (value: FormData | Promise<FormData>) => {
        parsed = Promise.resolve(value);
      },
      // Non-enumerable: Hono builds text()/json()/arrayBuffer() from the first
      // ENUMERABLE cache key. Leaving this one out keeps those reading the raw
      // body exactly as before.
      enumerable: false,
      configurable: true,
    });
  }
  await next();
};

/**
 * c.req.parseBody() for the multipart upload routes. A body the form parser
 * can't make sense of is the client's fault and gets a 400. undici reports it
 * as a bare TypeError ("Failed to parse body as FormData."), which would
 * otherwise reach the error handler as a 500. multipartCompat already turns
 * its own parse failures into a 400; this covers parseBody running without it
 * in front. Everything else, AppErrors included (bodyLimit's 413), passes
 * through unchanged.
 */
export async function parseFormBody<O extends Partial<ParseBodyOptions> = {}>(
  c: Context,
  options?: O,
): Promise<BodyData<O>> {
  try {
    return await c.req.parseBody<O, BodyData<O>>(options);
  } catch (err) {
    if (err instanceof TypeError) throw errors.badRequest('Malformed multipart body');
    throw err;
  }
}

async function parseMultipart(req: HonoRequest, contentType: string): Promise<FormData> {
  // req.raw is read here, not when the middleware ran, so it is whatever
  // Request the body limit left in place.
  const body = new Uint8Array(await req.raw.arrayBuffer());
  try {
    return await toFormData(body, contentType);
  } catch (err) {
    // A TypeError is the parser rejecting the body. Anything else is not ours
    // to reinterpret.
    if (!(err instanceof TypeError)) throw err;
  }
  const boundary = boundaryOf(contentType);
  const repaired = boundary ? quoteBareDispositionParams(body, boundary) : null;
  if (repaired) {
    try {
      return await toFormData(repaired, contentType);
    } catch (err) {
      if (!(err instanceof TypeError)) throw err;
    }
  }
  throw errors.badRequest('Malformed multipart body');
}

function toFormData(body: Uint8Array, contentType: string): Promise<FormData> {
  // Passed as a one-chunk stream: given the bytes directly, Response copies
  // them first, which is one more full copy of a possibly very large upload.
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(body);
      controller.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': contentType } }).formData();
}

function boundaryOf(contentType: string): string | null {
  const m = /;\s*boundary=(?:"([^"]+)"|([^;\s]+))/i.exec(contentType);
  return m?.[1] ?? m?.[2] ?? null;
}

const CLOSING_DASHES = Buffer.from('--');
const HEADERS_END = Buffer.from('\r\n\r\n');

/**
 * Quote bare `name=` / `filename=` values in each part's Content-Disposition
 * header. Returns null when nothing needed quoting.
 *
 * The body is walked delimiter to delimiter, and only the header block of each
 * part (from its delimiter line to the first blank line) is rewritten. The
 * preamble, part contents and epilogue are copied through byte for byte. The
 * boundary can't occur inside a part's content (that is what makes it a
 * boundary), so finding the next delimiter can't land inside a file. Header
 * blocks are decoded as latin1, which maps every byte to one char and back, so
 * any non-ASCII bytes in them survive the round trip unchanged.
 */
export function quoteBareDispositionParams(body: Uint8Array, boundary: string): Buffer | null {
  const buf = Buffer.from(body.buffer, body.byteOffset, body.byteLength);
  const delimiter = Buffer.from(`--${boundary}`, 'utf8');
  const pieces: Buffer[] = [];
  let copiedTo = 0;
  let at = buf.indexOf(delimiter);
  while (at !== -1) {
    const headersStart = at + delimiter.length;
    // `--boundary--` closes the body; nothing after it is a part.
    if (buf.subarray(headersStart, headersStart + 2).equals(CLOSING_DASHES)) break;
    const headersEnd = buf.indexOf(HEADERS_END, headersStart);
    if (headersEnd === -1) break;
    const headers = buf.toString('latin1', headersStart, headersEnd);
    const quoted = quoteHeaderBlock(headers);
    if (quoted !== headers) {
      pieces.push(buf.subarray(copiedTo, headersStart), Buffer.from(quoted, 'latin1'));
      copiedTo = headersEnd;
    }
    at = buf.indexOf(delimiter, headersEnd + HEADERS_END.length);
  }
  if (pieces.length === 0) return null;
  pieces.push(buf.subarray(copiedTo));
  return Buffer.concat(pieces);
}

// A quoted string (skipped, so a `; name=` inside a quoted filename is left
// alone) or `; name=value` / `; filename=value` with the value bare. Ktor only
// leaves a value bare when it has no separators in it, so "up to the next `;`
// or the end of the line" is the whole value.
const DISPOSITION_PARAM =
  /"[^"]*"|;[ \t]*(name|filename)[ \t]*=[ \t]*([^"\s;][^";]*?)[ \t]*(?=;|$)/gi;

function quoteHeaderBlock(headers: string): string {
  // `.` stops at CR, so each match is one header line without its line break.
  return headers.replace(
    /^(content-disposition[ \t]*:)(.*)$/gim,
    (_line, field: string, value: string) =>
      field +
      value.replace(
        DISPOSITION_PARAM,
        (match, key: string | undefined, bare: string | undefined) =>
          key === undefined ? match : `; ${key.toLowerCase()}="${bare}"`,
      ),
  );
}
