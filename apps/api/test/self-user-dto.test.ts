import { describe, it, expect } from 'vitest';
import { toSelfUser } from '../src/lib/dto';
import type { User } from '@zekktris/db';

// Minimal User fixture — only the fields toSelfUser reads. Cast through unknown
// so we don't have to populate the full drizzle row shape.
function fakeUser(overrides: Partial<User> = {}): User {
  return {
    id: 123n,
    email: 'a@b.com',
    emailVerified: true,
    username: 'alice',
    displayName: 'Alice',
    avatarUrl: null,
    bannerUrl: null,
    bio: null,
    gender: null,
    genderVisible: false,
    avatarDecoration: null,
    status: 'online',
    customStatus: null,
    customStatusEmoji: null,
    customStatusExpiresAt: null,
    isAdmin: false,
    locale: 'en',
    guildOrder: null,
    guildFolders: null,
    dmReadReceiptsEnabled: true,
    achievementsPublic: false,
    allowDmsFromServerMembers: false,
    publicKey: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as unknown as User;
}

describe('toSelfUser — achievementsPublic is carried on the self user', () => {
  it('reflects the column when true (so the Settings toggle survives reload)', () => {
    expect(toSelfUser(fakeUser({ achievementsPublic: true })).achievementsPublic).toBe(true);
  });

  it('reflects the column when false', () => {
    expect(toSelfUser(fakeUser({ achievementsPublic: false })).achievementsPublic).toBe(false);
  });
});
