import { describe, it, expect } from 'vitest';
import type { SelfUser } from '@zekktris/client';
import { recordSelfUser, selfStatusStore } from '../src/lib/selfStatus';

// recordSelfUser runs after every status-picker PATCH. Its reply can land
// after this device's own PRESENCE_UPDATE frame; it must record the
// EFFECTIVE status for the own dot, not SelfUser.status (the pick on a
// current server).

function self(fields: Partial<SelfUser>): SelfUser {
  return { id: 'u1', username: 'u', displayName: 'U', ...fields } as SelfUser;
}

describe('recordSelfUser', () => {
  it('records effectiveStatus for the dot and chosenStatus for the picker', () => {
    // Picked Online while every device is idle.
    recordSelfUser(self({ status: 'online', chosenStatus: 'online', effectiveStatus: 'idle' }));
    expect(selfStatusStore.get()).toEqual({ userId: 'u1', status: 'idle', chosenStatus: 'online' });
  });

  it("falls back to status from a server that predates effectiveStatus", () => {
    recordSelfUser(self({ status: 'dnd', chosenStatus: 'dnd' }));
    expect(selfStatusStore.get()).toEqual({ userId: 'u1', status: 'dnd', chosenStatus: 'dnd' });
  });
});
