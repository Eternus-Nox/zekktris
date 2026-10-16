/**
 * E2EE purge-proof registration for DMs that don't have one yet.
 *
 * Disabling E2EE hard-deletes the encrypted history, so the server gates it
 * on a purge proof (`computePurgeProof`) whose hash it stored at enable time
 * and never hands out. DMs encrypted before that existed, or by an older
 * client, have no stored hash (`channel.e2eePurgeProofSet === false`), and
 * until one is registered the server still purges them on the public
 * verifier alone. Registration is trust-on-first-use, so the first key
 * holder to see such a DM registers its proof right away, which closes that
 * window. `=== false` (not falsy) so an older server that omits the field is
 * never sent a request it doesn't understand.
 */

import type { Channel, RestClient } from '@zekktris/client';
import naclUtil from 'tweetnacl-util';
import { computePurgeProof, computeVerifier, getLocalKey } from './e2ee';

// channelId:verifier pairs already attempted this session. A failure is not
// retried until reload: a 409 (another proof already registered) is final,
// and a network error will be retried on the next session.
const attempted = new Set<string>();

/**
 * Register this device's purge proof for `channel` when the server has none
 * and this device holds the CURRENT key. Returns true when a registration
 * request succeeded. Never throws.
 */
export async function ensurePurgeProofRegistered(
  rest: Pick<RestClient, 'registerDmE2eePurgeProof'>,
  channel: Pick<Channel, 'id' | 'e2eeEnabled' | 'e2eeVerifier' | 'e2eePurgeProofSet'>,
): Promise<boolean> {
  if (channel.e2eeEnabled !== true || channel.e2eePurgeProofSet !== false) return false;
  if (!channel.e2eeVerifier) return false;
  const keyBytes = getLocalKey(channel.id);
  if (!keyBytes) return false;
  try {
    const keyBase64 = naclUtil.encodeBase64(keyBytes);
    const verifier = await computeVerifier(keyBase64);
    // A stale key (DM re-keyed since it was cached) can't register.
    if (verifier !== channel.e2eeVerifier) return false;
    const once = `${channel.id}:${verifier}`;
    if (attempted.has(once)) return false;
    attempted.add(once);
    await rest.registerDmE2eePurgeProof(channel.id, verifier, await computePurgeProof(keyBase64));
    return true;
  } catch {
    return false;
  }
}
