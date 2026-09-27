/**
 * Issue a password-reset link: mint a single-use token (only its SHA-256 is
 * stored), and mail the plaintext link to the account's address.
 *
 * Shared by the public POST /auth/forgot-password and the staff
 * "Send password reset" action (Admin → Account Info) so both produce the
 * identical token, expiry and email. Staff never see the link or choose a
 * password — the only thing a staff member can do is make the email go out.
 * Completing the reset (POST /auth/reset-password) rotates the hash and
 * revokes every session.
 */

import { createHash, randomBytes } from 'node:crypto';
import { db, schema } from '../db';
import { env } from '../env';
import { nextSnowflake } from '../snowflake';

export const PASSWORD_RESET_EXPIRY_MS = 60 * 60_000;

export async function issuePasswordReset(user: { id: bigint; email: string }): Promise<void> {
  // URL-safe base64 so the token survives a query string without encoding.
  const plaintext = randomBytes(32)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  const tokenHash = createHash('sha256').update(plaintext).digest('hex');

  await db.insert(schema.passwordResets).values({
    id: nextSnowflake(),
    userId: user.id,
    tokenHash,
    expiresAt: new Date(Date.now() + PASSWORD_RESET_EXPIRY_MS),
  });

  // The web app's /reset-password page reads the token and submits it to
  // /auth/reset-password.
  const resetUrl = `${env.PUBLIC_URL}/reset-password?token=${encodeURIComponent(plaintext)}`;
  const { sendPasswordResetEmail } = await import('./email');
  await sendPasswordResetEmail({
    to: user.email,
    resetUrl,
    expiresInMinutes: Math.floor(PASSWORD_RESET_EXPIRY_MS / 60_000),
  });
}
