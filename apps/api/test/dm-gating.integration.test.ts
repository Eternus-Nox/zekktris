import { describe, it, expect, afterAll } from 'vitest';
import { Permissions as P } from '@zekktris/shared/permissions';
import { canReachByDmOrCall } from '../src/services/relationships';
import { computeMemberChannelPermissions } from '../src/services/permissions';
import { getOrCreateDM, ensureRecipient } from '../src/services/dms';
import {
  createUser,
  createGuild,
  addMember,
  createDmChannel,
  addRelationship,
  trackChannel,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping DM-gating tests — no database reachable');
}

const has = (perms: bigint, bit: bigint) => (perms & bit) === bit;

describe.runIf(dbReady)('DM permission gating (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  describe('canReachByDmOrCall', () => {
    it('always allows reaching yourself', async () => {
      const a = await createUser();
      expect(await canReachByDmOrCall(a, a)).toBe(true);
    });

    it('allows a friend', async () => {
      const a = await createUser();
      const b = await createUser();
      await addRelationship(a, b, 'friend');
      expect(await canReachByDmOrCall(a, b)).toBe(true);
    });

    it('denies when blocked in either direction', async () => {
      const a = await createUser();
      const b = await createUser();
      await addRelationship(b, a, 'blocked'); // recipient blocked the sender
      expect(await canReachByDmOrCall(a, b)).toBe(false);
    });

    it('denies strangers with no shared context', async () => {
      const a = await createUser();
      const b = await createUser();
      expect(await canReachByDmOrCall(a, b)).toBe(false);
    });

    it('allows a server member when the recipient opted in and they share a guild', async () => {
      const owner = await createUser();
      const sender = await createUser();
      const recipient = await createUser({ allowDmsFromServerMembers: true });
      const g = await createGuild(owner, 0n);
      await addMember(g, sender);
      await addMember(g, recipient);
      expect(await canReachByDmOrCall(sender, recipient)).toBe(true);
    });

    it('still denies an opted-in recipient with no shared guild', async () => {
      const sender = await createUser();
      const recipient = await createUser({ allowDmsFromServerMembers: true });
      expect(await canReachByDmOrCall(sender, recipient)).toBe(false);
    });
  });

  describe('computeMemberChannelPermissions on a DM channel', () => {
    it('grants recipients the DM permission set and non-recipients nothing', async () => {
      const a = await createUser();
      const b = await createUser();
      const stranger = await createUser();
      const dm = await createDmChannel([a, b]);
      const perms = await computeMemberChannelPermissions(dm, a);
      expect(has(perms, P.VIEW_CHANNEL)).toBe(true);
      expect(has(perms, P.SEND_MESSAGES)).toBe(true);
      expect(has(perms, P.MANAGE_CHANNELS)).toBe(false); // DMs don't grant management
      expect(await computeMemberChannelPermissions(dm, stranger)).toBe(0n);
    });
  });

  describe('ensureRecipient', () => {
    it('resolves for a recipient and rejects a non-recipient', async () => {
      const a = await createUser();
      const b = await createUser();
      const stranger = await createUser();
      const dm = await createDmChannel([a, b]);
      await expect(ensureRecipient(dm, a)).resolves.toBeUndefined();
      await expect(ensureRecipient(dm, stranger)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });
  });

  describe('getOrCreateDM', () => {
    it('rejects DMing yourself', async () => {
      const a = await createUser();
      await expect(getOrCreateDM(a, a)).rejects.toMatchObject({ code: 'BAD_REQUEST' });
    });

    it('rejects when the gate denies (blocked) without leaking existence', async () => {
      const a = await createUser();
      const b = await createUser();
      await addRelationship(a, b, 'blocked');
      await expect(getOrCreateDM(a, b)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    });

    it('creates a DM for a reachable pair and is idempotent', async () => {
      const a = await createUser();
      const b = await createUser();
      await addRelationship(a, b, 'friend');
      const first = await getOrCreateDM(a, b);
      trackChannel(first.channelId);
      expect(first.created).toBe(true);
      const second = await getOrCreateDM(a, b);
      expect(second.created).toBe(false);
      expect(second.channelId).toBe(first.channelId);
      await expect(ensureRecipient(first.channelId, a)).resolves.toBeUndefined();
      await expect(ensureRecipient(first.channelId, b)).resolves.toBeUndefined();
    });
  });
});
