import { describe, it, expect } from 'vitest';
import { RestClient } from '@zekktris/client';

// packages/client patchMe marks a status as the user's own pick
// (statusSource: 'manual'), so the server never treats an Away picked in the
// status picker as a pre-update client's automatic idle — which it ends when
// the user's last device disconnects.

function capture(): { client: RestClient; bodies: unknown[] } {
  const bodies: unknown[] = [];
  const client = new RestClient({
    baseUrl: 'https://example.test/api',
    getToken: () => 't',
    fetch: (async (_url: string, init?: RequestInit) => {
      bodies.push(init?.body ? JSON.parse(init.body as string) : undefined);
      return new Response(JSON.stringify({ user: {} }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }) as typeof fetch,
  } as ConstructorParameters<typeof RestClient>[0]);
  return { client, bodies };
}

describe('RestClient.patchMe status source', () => {
  it('marks a status PATCH as a manual pick', async () => {
    const { client, bodies } = capture();
    await client.patchMe({ status: 'idle' });
    expect(bodies).toEqual([{ status: 'idle', statusSource: 'manual' }]);
  });

  it('keeps an explicit source (an automatic change against an older server)', async () => {
    const { client, bodies } = capture();
    await client.patchMe({ status: 'idle', statusSource: 'auto' });
    expect(bodies).toEqual([{ status: 'idle', statusSource: 'auto' }]);
  });

  it('leaves a PATCH without a status alone', async () => {
    const { client, bodies } = capture();
    await client.patchMe({ bio: 'hi' });
    expect(bodies).toEqual([{ bio: 'hi' }]);
  });
});
