import { describe, it, expect, afterAll } from 'vitest';
import { getEffectiveRestrictions, dmBlockedBySupervision } from '../src/services/supervision';
import { getOrCreateDM } from '../src/services/dms';
import { db, schema } from '../src/db';
import { createUser, addRelationship, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping supervision-enforcement tests — no database reachable');
}

/** A YYYY-MM-DD DOB `years` before now (birthday already passed), so the
 *  computed age is stable regardless of when the suite runs. */
function dobForAge(years: number): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

describe.runIf(dbReady)('supervision enforcement (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('adult and legacy (no-DOB) accounts get no restrictions', async () => {
    const adult = await createUser({ dateOfBirth: dobForAge(30) });
    const legacy = await createUser(); // pre-DOB account
    expect(await getEffectiveRestrictions(adult)).toBeNull();
    expect(await getEffectiveRestrictions(legacy)).toBeNull();
  });

  it('an UNLINKED minor is locked down immediately (no grace window)', async () => {
    const minor = await createUser({ dateOfBirth: dobForAge(15) });
    const r = await getEffectiveRestrictions(minor);
    expect(r).not.toBeNull();
    // Everything off, no DMs — the whole point of the fix.
    expect(r!.allowJoinGuilds).toBe(false);
    expect(r!.allowMessaging).toBe(false);
    expect(r!.allowVoice).toBe(false);
    expect(r!.allowVideo).toBe(false);
    expect(r!.allowCreateGuild).toBe(false);
    expect(r!.canAddFriends).toBe(false);
    expect(r!.dmPolicy).toBe('none');
  });

  it('two adults can DM (no supervision constraint)', async () => {
    const a = await createUser({ dateOfBirth: dobForAge(30) });
    const b = await createUser({ dateOfBirth: dobForAge(30) });
    expect(await dmBlockedBySupervision(a, b)).toBe(false);
  });

  it('an unlinked minor cannot DM — even a friend (dmPolicy none)', async () => {
    const minor = await createUser({ dateOfBirth: dobForAge(15) });
    const adult = await createUser({ dateOfBirth: dobForAge(30) });
    // Friendship would satisfy the ordinary DM-privacy gate…
    await addRelationship(minor, adult, 'friend');
    // …but the unlinked-minor lockdown ('none') blocks it anyway, both ways.
    expect(await dmBlockedBySupervision(minor, adult)).toBe(true);
    expect(await dmBlockedBySupervision(adult, minor)).toBe(true);
    await expect(getOrCreateDM(minor, adult)).rejects.toThrow();
    await expect(getOrCreateDM(adult, minor)).rejects.toThrow();
  });

  it('a guardian-linked minor defaults to friends-only DMs', async () => {
    const parent = await createUser({ dateOfBirth: dobForAge(40) });
    const minor = await createUser({ dateOfBirth: dobForAge(15) });
    await db.insert(schema.parentChildLinks).values({
      parentId: parent,
      childId: minor,
      status: 'active',
      initiatedBy: 'parent',
    });
    // Linked → DEFAULT restrictions (dmPolicy 'friends'): a stranger is blocked…
    const stranger = await createUser({ dateOfBirth: dobForAge(30) });
    expect(await dmBlockedBySupervision(minor, stranger)).toBe(true);
    // …but a mutual friend is allowed.
    const pal = await createUser({ dateOfBirth: dobForAge(30) });
    await addRelationship(minor, pal, 'friend');
    expect(await dmBlockedBySupervision(minor, pal)).toBe(false);
    // And a linked minor may join/message (guardian defaults are permissive).
    const r = await getEffectiveRestrictions(minor);
    expect(r!.allowJoinGuilds).toBe(true);
    expect(r!.allowMessaging).toBe(true);
  });
});
