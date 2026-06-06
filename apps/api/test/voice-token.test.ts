import { describe, it, expect } from 'vitest';
import { decodeJwt } from 'jose';
import { TrackSource } from 'livekit-server-sdk';
import { mintLivekitToken } from '../src/services/voice';

// LiveKit access tokens are HS256 JWTs whose VideoGrant lives under the `video`
// claim and whose `sub` is the participant identity. We decode (claims only —
// signature re-validation isn't the point here) and assert the grant we built.
function grantOf(token: string): Record<string, unknown> {
  return decodeJwt(token).video as Record<string, unknown>;
}

describe('voice token (LiveKit) minting', () => {
  it('mints a guild voice token: identity, room name, and full grant', async () => {
    const { token, wsUrl } = await mintLivekitToken(7n, 99n, 42n);
    expect(typeof token).toBe('string');
    expect(token!.split('.')).toHaveLength(3); // header.payload.signature
    expect(wsUrl).toBeTruthy();

    const claims = decodeJwt(token!);
    expect(claims.sub).toBe('7');
    const grant = claims.video as Record<string, unknown>;
    expect(grant.room).toBe('g42-c99');
    expect(grant.roomJoin).toBe(true);
    expect(grant.canPublish).toBe(true);
    expect(grant.canSubscribe).toBe(true);
  });

  it('uses dm-c{channel} room naming when there is no guild', async () => {
    const { token } = await mintLivekitToken(7n, 99n, null);
    expect(grantOf(token!).room).toBe('dm-c99');
  });

  it('mints a non-publishing (audience / AFK) token when canPublish is false', async () => {
    const { token } = await mintLivekitToken(7n, 99n, 42n, false);
    const grant = grantOf(token!);
    expect(grant.canPublish).toBe(false);
    // Audience still subscribes — they can hear, just not broadcast.
    expect(grant.canSubscribe).toBe(true);
  });

  it('restricts publish sources when supplied (parental controls)', async () => {
    const { token } = await mintLivekitToken(7n, 99n, 42n, true, [
      TrackSource.MICROPHONE,
    ]);
    const grant = grantOf(token!);
    expect(Array.isArray(grant.canPublishSources)).toBe(true);
    expect((grant.canPublishSources as string[]).length).toBeGreaterThan(0);
  });
});
