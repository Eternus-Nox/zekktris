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

describe('toSelfUser — chosen vs effective status', () => {
  it('carries the chosen status (as `status`, for older native builds, and as chosenStatus) alongside the effective one', () => {
    // Chosen Online while every device is idle: an old iOS / Android build
    // reads `status` as its pick, so it must say Online, not Away.
    const dto = toSelfUser(fakeUser({ status: 'idle', chosenStatus: 'online' }));
    expect(dto.status).toBe('online');
    expect(dto.chosenStatus).toBe('online');
    expect(dto.effectiveStatus).toBe('idle');
  });

  it('never reports the pick as offline, even with no device connected', () => {
    const dto = toSelfUser(fakeUser({ status: 'offline', chosenStatus: 'dnd' }));
    expect(dto.status).toBe('dnd');
    expect(dto.chosenStatus).toBe('dnd');
    expect(dto.effectiveStatus).toBe('offline');
  });

  it('shows the self user their own invisible status unmasked', () => {
    const dto = toSelfUser(fakeUser({ status: 'invisible', chosenStatus: 'invisible' }));
    expect(dto.status).toBe('invisible');
    expect(dto.chosenStatus).toBe('invisible');
    expect(dto.effectiveStatus).toBe('invisible');
  });
});
