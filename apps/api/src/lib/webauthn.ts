/**
 * WebAuthn (passkey) configuration + re-exports.
 *
 * The Relying Party is the WEB app's registrable domain. `PUBLIC_URL` is the
 * web origin the app is served from (also used for email links), so the rpID
 * is its hostname and the expected origin is its full origin. On localhost
 * this resolves to rpID 'localhost' / origin 'http://localhost:3000', which is
 * what the browser sends in dev.
 */
import {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
} from '@simplewebauthn/server';
import { env } from '../env';

const url = new URL(env.PUBLIC_URL);
export const rpID = url.hostname;
export const rpName = 'Zekktris';
export const expectedOrigin = url.origin;

export {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};
