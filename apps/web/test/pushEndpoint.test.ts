import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { pushEndpointHash, findOwnPushDevice } from '../src/lib/pushEndpoint';

// Turning push off must delete THIS browser's row, not just the first row of
// the cross-device list. The client hashes its endpoint exactly like the
// server's endpointHash (hex SHA-256 of the URL).
describe('pushEndpoint', () => {
  const a = 'https://fcm.googleapis.com/fcm/send/device-a';
  const b = 'https://updates.push.services.mozilla.com/wpush/v2/device-b';
  const sha = (s: string) => createHash('sha256').update(s).digest('hex');

  it('hashes like the server', async () => {
    expect(await pushEndpointHash(a)).toBe(sha(a));
  });

  it('picks this device even when it is not the first row', async () => {
    const devices = [
      { id: '1', endpointHash: sha(a) },
      { id: '2', endpointHash: sha(b) },
    ];
    expect((await findOwnPushDevice(devices, b))?.id).toBe('2');
    expect((await findOwnPushDevice(devices, a))?.id).toBe('1');
  });

  it('finds nothing (deletes nothing) when this device has no row', async () => {
    const devices = [{ id: '1', endpointHash: sha(a) }];
    expect(await findOwnPushDevice(devices, b)).toBeUndefined();
  });
});
