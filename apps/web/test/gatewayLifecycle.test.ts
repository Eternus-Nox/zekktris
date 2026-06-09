import { describe, it, expect } from 'vitest';
import { gatewayLifecycleKey } from '../src/auth/AuthContext';
import type { SelfUser } from '@zekktris/client';

// A minimal SelfUser stand-in; only `id` is read by the lifecycle key.
function user(id: string, over: Partial<SelfUser> = {}): SelfUser {
  return {
    id,
    username: 'u',
    displayName: 'U',
    avatarUrl: null,
    status: 'online',
    ...over,
  } as SelfUser;
}

describe('gatewayLifecycleKey', () => {
  it('is null when logged out', () => {
    expect(gatewayLifecycleKey(null)).toBeNull();
  });

  it('is the user id when logged in', () => {
    expect(gatewayLifecycleKey(user('123'))).toBe('123');
  });

  it('is STABLE across profile / status / presence field updates (the bug fix)', () => {
    // Same identity, but the user object has been replaced (as updateUser
    // does on every settings save / presence change). The key must not move,
    // or the gateway socket would needlessly tear down and reopen.
    const before = gatewayLifecycleKey(user('123', { status: 'online', displayName: 'Old' }));
    const afterStatus = gatewayLifecycleKey(user('123', { status: 'idle', displayName: 'Old' }));
    const afterProfile = gatewayLifecycleKey(user('123', { status: 'idle', displayName: 'New' }));
    expect(afterStatus).toBe(before);
    expect(afterProfile).toBe(before);
  });

  it('CHANGES on login (null → id), logout (id → null), and account switch (id → id\')', () => {
    const loggedOut = gatewayLifecycleKey(null);
    const loggedIn = gatewayLifecycleKey(user('123'));
    const switched = gatewayLifecycleKey(user('456'));
    expect(loggedIn).not.toBe(loggedOut); // login → connect
    expect(gatewayLifecycleKey(null)).not.toBe(loggedIn); // logout → disconnect
    expect(switched).not.toBe(loggedIn); // account switch → reconnect
  });
});
