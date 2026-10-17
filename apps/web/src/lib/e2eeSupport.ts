/**
 * Can this page do end-to-end encryption at all?
 *
 * Browsers only expose WebCrypto (`crypto.subtle`) in a secure context —
 * https://, or http://localhost. A `--lan` install serves the app over plain
 * http://<lan-ip>, where every derive / encrypt / decrypt would throw. Callers
 * check this first and show E2EE_INSECURE_MESSAGE instead of a generic
 * "Could not derive the key" or an undecryptable-message tombstone.
 */
export function e2eeSupported(): boolean {
  try {
    return (
      typeof window !== 'undefined' &&
      window.isSecureContext === true &&
      typeof crypto !== 'undefined' &&
      typeof crypto.subtle !== 'undefined'
    );
  } catch {
    return false;
  }
}

/** Full explanation, for the encryption settings and send failures. */
export const E2EE_INSECURE_MESSAGE =
  'Encrypted chats need a secure (https) connection. Your browser turns off ' +
  'its encryption features on plain http://, so encrypted messages can’t be ' +
  'read or sent here. Open this server over https (or on localhost) instead.';

/** One-liner for an individual encrypted message. */
export const E2EE_INSECURE_SHORT =
  'Encrypted — can’t be read over a plain http:// connection. Open this server over https.';
