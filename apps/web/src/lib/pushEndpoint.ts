/**
 * Match this browser's Web Push subscription to its server-side row.
 *
 * The device list (GET /users/@me/push-subscriptions) is cross-device and
 * carries `endpointHash` — hex SHA-256 of each row's endpoint URL — rather
 * than the endpoints themselves. Hashing this browser's
 * PushSubscription.endpoint the same way finds its own row, so turning push
 * off here removes exactly this device and never another one.
 */

/** Hex SHA-256 of a push endpoint URL (same as the server's endpointHash). */
export async function pushEndpointHash(endpoint: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(endpoint));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The row in `devices` belonging to the subscription at `endpoint`, if any. */
export async function findOwnPushDevice<T extends { endpointHash: string }>(
  devices: readonly T[],
  endpoint: string,
): Promise<T | undefined> {
  const hash = await pushEndpointHash(endpoint);
  return devices.find((d) => d.endpointHash === hash);
}
