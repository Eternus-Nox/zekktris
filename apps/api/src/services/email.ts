/**
 * Email service
 * -------------
 * Outbound email via SMTP (nodemailer). Used currently for password
 * reset; the same transport is the one all future email features
 * will route through.
 *
 * Configuration. SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS,
 * SMTP_FROM, SMTP_SECURE — all in apps/api/src/env.ts. Missing
 * SMTP_HOST or SMTP_FROM disables sending entirely; routes that
 * need email check `isEmailConfigured()` and return 503 with a
 * "this server hasn't enabled email" message in that case.
 *
 * Transport lifecycle. We lazy-init a single transporter on first
 * use and reuse it for every subsequent send. nodemailer's
 * transporter holds a connection pool internally, so this avoids
 * a per-send TCP+TLS handshake. We don't bother with an explicit
 * `verify()` call — the first real send will surface auth errors
 * the same way, and we don't want startup to crash if SMTP is
 * temporarily down.
 *
 * Error handling. sendEmail() rejects on failure. Callers should
 * catch and surface a generic "email failed to send" — never
 * include the underlying SMTP error message in the response,
 * since it can leak server config (relay hostname, auth method,
 * etc.) to whoever triggered the send.
 */

import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../env';
import { log } from '../log';

let cachedTransport: Transporter | null = null;

/**
 * True iff the operator has set the minimum required SMTP config
 * (host + from-address). Routes that depend on email should check
 * this and return 503 when false rather than failing in send().
 */
export function isEmailConfigured(): boolean {
  return Boolean(env.SMTP_HOST && env.SMTP_FROM);
}

function getTransport(): Transporter {
  if (cachedTransport) return cachedTransport;
  if (!env.SMTP_HOST || !env.SMTP_FROM) {
    // Belt-and-suspenders — callers should have guarded with
    // isEmailConfigured() already, but throw a clear error if
    // they didn't.
    throw new Error('Email is not configured (missing SMTP_HOST or SMTP_FROM)');
  }
  cachedTransport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: env.SMTP_PORT,
    secure: env.SMTP_SECURE,
    // Auth is optional — some relays accept localhost-only or
    // IP-allowlisted connections without credentials. Omit the
    // auth object entirely in that case so nodemailer doesn't try
    // to PLAIN/LOGIN with empty values (relay would reject).
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASS } : undefined,
    // Pool — reuse connections across sends for the lifetime of
    // the process. nodemailer caps idle connections automatically.
    pool: true,
  });
  return cachedTransport;
}

interface SendEmailArgs {
  to: string;
  subject: string;
  text: string;
  /** Optional HTML body. If omitted, the email is plain-text only
      (which most modern clients render fine; we use HTML only when
      it adds real value over the text version). */
  html?: string;
}

export async function sendEmail({ to, subject, text, html }: SendEmailArgs): Promise<void> {
  const transport = getTransport();
  await transport.sendMail({
    from: env.SMTP_FROM,
    to,
    subject,
    text,
    html,
  });
  log.info('email sent', { to, subject });
}

/**
 * Send a password-reset email. The link encodes the plaintext token;
 * the API stores only its SHA-256 hash. Body intentionally minimal
 * and plain — no marketing, no branding bloat. Includes both the
 * clickable link and the URL plaintext so mail clients that don't
 * render HTML still let the user copy-paste.
 */
export async function sendPasswordResetEmail(args: {
  to: string;
  resetUrl: string;
  /** Lifetime in minutes, surfaced in the email body. */
  expiresInMinutes: number;
}): Promise<void> {
  const { to, resetUrl, expiresInMinutes } = args;
  const subject = 'Reset your Zekktris password';
  const text = [
    'Someone (hopefully you) requested a password reset for your Zekktris account.',
    '',
    'To choose a new password, click the link below:',
    resetUrl,
    '',
    `This link expires in ${expiresInMinutes} minutes. If you didn't request the reset, you can ignore this email — your password won't change.`,
  ].join('\n');
  // Minimal HTML body. Just the link styled as a button, plus the
  // same plain-text URL underneath for clients that strip styling.
  // No images, no tracking pixels, no marketing footer — this is a
  // transactional security email.
  const html = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.5;">
      <p>Someone (hopefully you) requested a password reset for your Zekktris account.</p>
      <p>To choose a new password, click the button below:</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(resetUrl)}" style="display: inline-block; padding: 10px 18px; background: #5865f2; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Reset password
        </a>
      </p>
      <p style="font-size: 14px; color: #666;">Or copy this link:<br><span style="font-family: monospace; word-break: break-all;">${escapeHtml(resetUrl)}</span></p>
      <p style="font-size: 13px; color: #888; margin-top: 24px;">This link expires in ${expiresInMinutes} minutes. If you didn&rsquo;t request the reset, you can ignore this email &mdash; your password won&rsquo;t change.</p>
    </div>
  `;
  await sendEmail({ to, subject, text, html });
}

/**
 * Signup email verification. Sent at registration (and on resend) to
 * confirm the address before the account can be used.
 */
export async function sendEmailVerification(args: {
  to: string;
  verifyUrl: string;
  expiresInMinutes: number;
}): Promise<void> {
  const { to, verifyUrl, expiresInMinutes } = args;
  const subject = 'Verify your Zekktris email';
  const text = [
    'Welcome to Zekktris! Please confirm your email address to start using your account.',
    '',
    'Verify your email by clicking the link below:',
    verifyUrl,
    '',
    `This link expires in ${expiresInMinutes} minutes.`,
  ].join('\n');
  const html = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.5;">
      <p>Welcome to Zekktris! Please confirm your email address to start using your account.</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(verifyUrl)}" style="display: inline-block; padding: 10px 18px; background: #5865f2; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Verify email
        </a>
      </p>
      <p style="font-size: 14px; color: #666;">Or copy this link:<br><span style="font-family: monospace; word-break: break-all;">${escapeHtml(verifyUrl)}</span></p>
      <p style="font-size: 13px; color: #888; margin-top: 24px;">This link expires in ${expiresInMinutes} minutes.</p>
    </div>
  `;
  await sendEmail({ to, subject, text, html });
}

/**
 * Verification email for an email-change request. Sent to the NEW
 * address (not the old one) because the user may be migrating
 * because they lost access to the old account.
 */
export async function sendEmailChangeVerification(args: {
  to: string;
  confirmUrl: string;
  /** Lifetime in minutes, surfaced in the email body. */
  expiresInMinutes: number;
}): Promise<void> {
  const { to, confirmUrl, expiresInMinutes } = args;
  const subject = 'Confirm your new Zekktris email';
  const text = [
    "Someone (hopefully you) asked to change their Zekktris account's email to this address.",
    '',
    'To confirm the change, click the link below:',
    confirmUrl,
    '',
    `This link expires in ${expiresInMinutes} minutes. If you didn't request this change, you can safely ignore the email — nothing will be changed.`,
  ].join('\n');
  const html = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; padding: 24px; color: #1a1a1a; line-height: 1.5;">
      <p>Someone (hopefully you) asked to change their Zekktris account&rsquo;s email to this address.</p>
      <p>To confirm the change, click the button below:</p>
      <p style="margin: 24px 0;">
        <a href="${escapeHtml(confirmUrl)}" style="display: inline-block; padding: 10px 18px; background: #5865f2; color: white; text-decoration: none; border-radius: 6px; font-weight: 500;">
          Confirm new email
        </a>
      </p>
      <p style="font-size: 14px; color: #666;">Or copy this link:<br><span style="font-family: monospace; word-break: break-all;">${escapeHtml(confirmUrl)}</span></p>
      <p style="font-size: 13px; color: #888; margin-top: 24px;">This link expires in ${expiresInMinutes} minutes. If you didn&rsquo;t request this change, you can safely ignore the email &mdash; nothing will be changed.</p>
    </div>
  `;
  await sendEmail({ to, subject, text, html });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
