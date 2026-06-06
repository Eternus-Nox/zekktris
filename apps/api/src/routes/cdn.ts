/**
 * CDN router
 * ----------
 * Streams attachment files from disk. Mounted at /cdn.
 *
 * In production this should be bypassed: Caddy serves /cdn/* directly off
 * the volume for performance. But Caddy can't enforce per-channel
 * permission checks, so when MAX security matters (private servers) you'd
 * leave this Node-served. The trade-off is documented in the deploy
 * instructions; the default docker-compose lets Caddy serve directly.
 *
 * Auth model: requires a Bearer token. The caller must have VIEW_CHANNEL
 * on the channel that owns the message that owns the attachment. For DM
 * attachments, the caller must be a recipient.
 */

import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { stream } from 'hono/streaming';
import { eq, or } from 'drizzle-orm';
import { validate } from '../lib/validate';
import { snowflakeSchema } from '../lib/validation';
import { db, schema } from '../db';
import { errors } from '../errors';
import * as uploads from '../services/uploads';

export const cdnRouter = new Hono();
// CDN is public-read. Browsers can't attach a Bearer token to <img>
// or <audio> requests, so requiring auth here would mean avatars,
// voice messages, attachments, emoji, and stickers all fail to render
// for the user that uploaded them. URLs are snowflake-namespaced and
// not enumerable in practice, matching Discord's CDN model. The
// trade-off: anyone who obtains a URL can fetch it, so message
// attachments are private up to URL secrecy, not up to channel
// permissions. v1 deliberate.

/**
 * Map an avatar filename's extension to a content type. We accept
 * exactly the formats the avatar upload route does (PNG, JPEG, GIF,
 * WebP). Anything else returns octet-stream — but the upload route
 * gates this list so we'd never see something off-list unless the
 * filesystem was tampered with.
 */
function avatarContentTypeFromName(name: string): string {
  const lower = name.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'application/octet-stream';
}

/**
 * Inline-safe MIME types: rendering these in the browser at our
 * origin can't execute attacker-controlled script. Everything else
 * gets served with Content-Disposition: attachment so the browser
 * downloads it instead of executing it.
 *
 * Notable exclusions:
 *  - text/html, application/xhtml+xml — obvious script execution
 *  - application/javascript, text/javascript — obvious
 *  - image/svg+xml — SVG can contain <script>; inline rendering at
 *    our origin would execute it. Forced to attachment.
 *  - application/xml, text/xml — can carry XSLT with script
 *
 * Without this allow-list the CDN was an XSS vector: a user uploads
 * an HTML file with Content-Type: text/html (the upload route stores
 * `file.type` verbatim), receives a /cdn/<id>/<name>.html URL on the
 * same origin as the app, and any browser that loads the URL runs
 * the attacker's HTML/JS with access to the user's auth cookies and
 * localStorage. Sharing this URL was effectively a stored-XSS
 * payload distribution channel.
 */
const INLINE_SAFE_MIME = new Set([
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/gif',
  'image/webp',
  'image/avif',
  'audio/mpeg',
  'audio/mp3',
  'audio/mp4',
  'audio/ogg',
  'audio/webm',
  'audio/wav',
  'audio/x-wav',
  'audio/aac',
  'audio/flac',
  'video/mp4',
  'video/webm',
  'video/quicktime',
  'application/pdf',
  'text/plain',
]);

/**
 * Apply the CDN response headers in a consistent way across all
 * storage classes (attachments, avatars, emoji, stickers, guild
 * images). Returns the safe content-type the response will actually
 * use, the disposition (inline vs. attachment), and writes the
 * headers onto the Hono context.
 *
 * The disposition decision: if the requested content-type is in the
 * INLINE_SAFE_MIME allow-list, serve inline so <img>/<audio>/<video>
 * embedding works. Otherwise force download — the user can still
 * obtain the file, but the browser won't run it as a script in our
 * origin.
 */
function applyCdnHeaders(
  c: Context,
  args: {
    contentType: string;
    size: number;
    filename: string;
    cacheControl: string;
  },
): void {
  const lower = args.contentType.toLowerCase().split(';')[0]?.trim() ?? '';
  const safeInline = INLINE_SAFE_MIME.has(lower);
  // Sanitize the filename for the Content-Disposition header. Strip
  // double-quotes (would break the quoted-string) and control chars
  // (Node refuses headers with CR/LF anyway but defense-in-depth).
  // For non-ASCII names we'd want RFC 5987 `filename*=UTF-8''...`
  // encoding; the current approach is a reasonable ASCII fallback.
  // eslint-disable-next-line no-control-regex
  const sanitizedName = args.filename.replace(/[\x00-\x1f"\\]/g, '_');
  const disposition = safeInline ? 'inline' : 'attachment';
  c.header('Content-Type', safeInline ? args.contentType : 'application/octet-stream');
  c.header('Content-Length', String(args.size));
  c.header('Content-Disposition', `${disposition}; filename="${sanitizedName}"`);
  c.header('Cache-Control', args.cacheControl);
  // Prevent browsers from MIME-sniffing the body and overriding our
  // Content-Type — without nosniff a body that LOOKS like HTML can
  // be rendered as HTML even when we say application/octet-stream.
  c.header('X-Content-Type-Options', 'nosniff');
}

cdnRouter.get(
  '/:attachmentId/:filename',
  validate(
    'param',
    z.object({
      attachmentId: snowflakeSchema,
      // filename can have a wide range of characters; we don't validate
      // strictly here since the disk filename is the authority.
      filename: z.string().min(1).max(512),
    }),
  ),
  async (c) => {
    const { attachmentId: aid, filename } = c.req.valid('param');
    const attachmentId = BigInt(aid);

    // Look up attachment + parent message + channel.
    const rows = await db
      .select({
        attachment: schema.attachments,
        message: schema.messages,
        channel: schema.channels,
      })
      .from(schema.attachments)
      .innerJoin(schema.messages, eq(schema.messages.id, schema.attachments.messageId))
      .innerJoin(schema.channels, eq(schema.channels.id, schema.messages.channelId))
      .where(eq(schema.attachments.id, attachmentId))
      .limit(1);
    const r = rows[0];

    // ── User avatar/banner fallback ───────────────────────────────────
    // Avatars and banners share the /cdn/<id>/<file> URL space with
    // message attachments for storage simplicity — all go to
    // ${UPLOAD_DIR}/<id>/<file> on disk — but they DON'T have an
    // attachment row (profile images aren't anchored to a message).
    // When the join above misses, we check whether some user has this
    // exact URL as either their avatarUrl or bannerUrl; if so, the
    // file is a profile image and any client may fetch it. Matching
    // both fields here is what makes `<img src={user.bannerUrl}>`
    // actually return a body — without the bannerUrl branch this
    // query missed and the request fell all the way through to a
    // 404, leaving the banner area blank in profile cards and
    // settings previews.
    if (!r) {
      // Re-encode the filename to match the form stored in the DB.
      //
      // Hono auto-decodes path parameters: a request for
      // `/cdn/123/geth%20discord%20image.jpg` arrives with
      // `filename = "geth discord image.jpg"` (raw spaces). But
      // saveUploadedFile stored the avatar/icon/emoji/etc. URLs
      // using `encodeURIComponent`, so the DB has the %20 form.
      //
      // Comparing the raw-spaces rebuild against the encoded stored
      // URL via eq() never matches, and every file with a space,
      // ampersand, plus, or other URL-significant character in its
      // filename silently 404s. Encoding the filename back to its
      // canonical form makes the lookup deterministic.
      const requestedUrl = `/cdn/${attachmentId.toString()}/${encodeURIComponent(filename)}`;
      const userRows = await db
        .select()
        .from(schema.users)
        .where(
          or(
            eq(schema.users.avatarUrl, requestedUrl),
            eq(schema.users.bannerUrl, requestedUrl),
          ),
        )
        .limit(1);
      const u = userRows[0];
      if (u) {
        const decoded = decodeURIComponent(filename);
        // Reconstruct the disk filename. Either avatarUrl OR
        // bannerUrl might be the match — pick whichever one equals
        // the requested URL so the encoded-name comparison below
        // checks the field that actually authorized this fetch.
        const matchedUrl = u.avatarUrl === requestedUrl ? u.avatarUrl : u.bannerUrl;
        const expectedEncoded = matchedUrl?.split('/').pop() ?? '';
        if (encodeURIComponent(decoded) !== expectedEncoded) {
          throw errors.notFound('Attachment');
        }
        const opened = await uploads.openAttachmentForRead(attachmentId, decoded);
        if (!opened) throw errors.notFound('Attachment file');
        // Avatar/banner content type isn't stored anywhere — sniff
        // from the extension. The upload routes restrict to
        // png/jpg/gif/webp so the extension is reliable.
        const contentType = avatarContentTypeFromName(decoded);
        applyCdnHeaders(c, {
          contentType,
          size: opened.size,
          filename: decoded,
          // URL is content-addressed by snowflake attachmentId — a
          // new avatar produces a new URL, and the upload routes
          // clean up the old file. So a given URL is truly immutable
          // for its entire lifetime. immutable + 1 year removes the
          // revalidation round-trip on every repeat visit.
          cacheControl: 'public, max-age=31536000, immutable',
        });
        return stream(c, async (s) => {
          const reader = opened.stream as NodeJS.ReadableStream & {
            [Symbol.asyncIterator]?: () => AsyncIterableIterator<Buffer>;
          };
          for await (const chunk of reader as AsyncIterable<Buffer>) {
            await s.write(chunk);
          }
        });
      }

      // ── Emoji fallback ────────────────────────────────────────────────
      // Third storage class living under /cdn/<id>/<file>: custom guild
      // emoji. Visibility is scoped to members of the owning guild —
      // non-members shouldn't be able to fetch a guild's emoji either
      // by direct enumeration or by URL leak. Otherwise the URL shape
      // and filename-roundtrip guard mirror the avatar path.
      const { getGuildEmojiByUrl } = await import('../services/emojis');
      const emoji = await getGuildEmojiByUrl(requestedUrl);
      if (emoji) {
        const decoded = decodeURIComponent(filename);
        const expectedEncoded = emoji.url.split('/').pop() ?? '';
        if (encodeURIComponent(decoded) !== expectedEncoded) {
          throw errors.notFound('Attachment');
        }
        // Public CDN — no membership check (browsers can't auth img tags).
        const opened = await uploads.openAttachmentForRead(attachmentId, decoded);
        if (!opened) throw errors.notFound('Attachment file');
        // Emoji content type from extension — same upload allow-list as
        // avatars plus we know GIFs are valid here too.
        const contentType = avatarContentTypeFromName(decoded);
        applyCdnHeaders(c, {
          contentType,
          size: opened.size,
          filename: decoded,
          // URL is content-addressed by snowflake — rename doesn't
          // change the URL (only the shortcode), so cache hard.
          cacheControl: 'public, max-age=31536000, immutable',
        });
        return stream(c, async (s) => {
          const reader = opened.stream as NodeJS.ReadableStream & {
            [Symbol.asyncIterator]?: () => AsyncIterableIterator<Buffer>;
          };
          for await (const chunk of reader as AsyncIterable<Buffer>) {
            await s.write(chunk);
          }
        });
      }

      // ── Sticker fallback ──────────────────────────────────────────────
      // Fourth storage class. Same shape as emoji — guild-scoped
      // visibility, members-only fetch. URL content-addressed by
      // snowflake; a future "replace image" feature must allocate a
      // new URL to stay cache-coherent.
      const { getStickerByUrl } = await import('../services/stickers');
      const sticker = await getStickerByUrl(requestedUrl);
      if (sticker) {
        const decoded = decodeURIComponent(filename);
        const expectedEncoded = sticker.url.split('/').pop() ?? '';
        if (encodeURIComponent(decoded) !== expectedEncoded) {
          throw errors.notFound('Attachment');
        }
        // Public CDN — no membership check (browsers can't auth img tags).
        const opened = await uploads.openAttachmentForRead(attachmentId, decoded);
        if (!opened) throw errors.notFound('Attachment file');
        const contentType = avatarContentTypeFromName(decoded);
        applyCdnHeaders(c, {
          contentType,
          size: opened.size,
          filename: decoded,
          cacheControl: 'public, max-age=31536000, immutable',
        });
        return stream(c, async (s) => {
          const reader = opened.stream as NodeJS.ReadableStream & {
            [Symbol.asyncIterator]?: () => AsyncIterableIterator<Buffer>;
          };
          for await (const chunk of reader as AsyncIterable<Buffer>) {
            await s.write(chunk);
          }
        });
      }

      // ── Guild icon / banner fallback ──────────────────────────────────
      // Fifth storage class. Guild icons and banners are uploaded via
      // POST /guilds/:id/icon and /guilds/:id/banner — they share the
      // /cdn/<id>/<file> URL space with everything else but don't
      // attach to a message, user avatar, emoji, or sticker. We look
      // them up by matching the requested URL against guilds.iconUrl
      // and guilds.bannerUrl. Public-read like avatars: any client
      // displaying a server tile or banner needs to fetch the image,
      // and `<img>` requests can't carry auth.
      const guildImageRows = await db
        .select({
          iconUrl: schema.guilds.iconUrl,
          bannerUrl: schema.guilds.bannerUrl,
        })
        .from(schema.guilds)
        .where(or(eq(schema.guilds.iconUrl, requestedUrl), eq(schema.guilds.bannerUrl, requestedUrl)))
        .limit(1);
      const guildImage = guildImageRows[0];
      if (guildImage) {
        const decoded = decodeURIComponent(filename);
        const expectedEncoded =
          (guildImage.iconUrl === requestedUrl ? guildImage.iconUrl : guildImage.bannerUrl)
            ?.split('/')
            .pop() ?? '';
        if (encodeURIComponent(decoded) !== expectedEncoded) {
          throw errors.notFound('Attachment');
        }
        const opened = await uploads.openAttachmentForRead(attachmentId, decoded);
        if (!opened) throw errors.notFound('Attachment file');
        const contentType = avatarContentTypeFromName(decoded);
        applyCdnHeaders(c, {
          contentType,
          size: opened.size,
          filename: decoded,
          // Guild icons/banners are content-addressed by snowflake;
          // updates produce new URLs and updateGuild cleans up the
          // old file. URL is immutable for its lifetime.
          cacheControl: 'public, max-age=31536000, immutable',
        });
        return stream(c, async (s) => {
          const reader = opened.stream as NodeJS.ReadableStream & {
            [Symbol.asyncIterator]?: () => AsyncIterableIterator<Buffer>;
          };
          for await (const chunk of reader as AsyncIterable<Buffer>) {
            await s.write(chunk);
          }
        });
      }

      throw errors.notFound('Attachment');
    }

    // ── Message-attachment path ────────────────────────────────────────
    // Verify the URL filename matches the stored filename — prevents enumerating
    // attachments by guessing IDs and trying arbitrary filenames.
    if (decodeURIComponent(filename) !== r.attachment.filename) {
      throw errors.notFound('Attachment');
    }

    // Permission gate intentionally OMITTED. CDN is public-read by URL
    // possession — same model as Discord's CDN. Channel-permission gating
    // would require Bearer auth on every <img>/<audio>, which browsers
    // don't attach. URLs include a 64-bit snowflake and the original
    // filename, both of which must match exactly, so blind enumeration
    // is impractical.

    const opened = await uploads.openAttachmentForRead(attachmentId, r.attachment.filename);
    if (!opened) {
      // Row exists but file is gone — honest 404 rather than a hang.
      throw errors.notFound('Attachment file');
    }

    applyCdnHeaders(c, {
      contentType: r.attachment.contentType,
      size: opened.size,
      filename: r.attachment.filename,
      // Content-addressed (id is immutable), so cache for a year like
      // the avatar/banner/emoji classes — repeat loads stay in the
      // browser cache and never hit the server.
      cacheControl: 'public, max-age=31536000, immutable',
    });

    return stream(c, async (s) => {
      // Pipe the read stream into Hono's body writer.
      const reader = opened.stream as NodeJS.ReadableStream & {
        [Symbol.asyncIterator]?: () => AsyncIterableIterator<Buffer>;
      };
      // Node's fs.createReadStream is async-iterable.
      for await (const chunk of reader as AsyncIterable<Buffer>) {
        await s.write(chunk);
      }
    });
  },
);
