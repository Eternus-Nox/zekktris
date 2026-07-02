import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { achievementsForUser } from '../src/services/achievements';
import { nextSnowflake } from '../src/snowflake';
import { createUser, createGuild, createChannel, createMessage, createDmChannel, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping new-achievements tests — no database reachable');
}

function byId(list: Awaited<ReturnType<typeof achievementsForUser>>, id: string) {
  const a = list.find((x) => x.id === id);
  expect(a, `achievement ${id} missing from the shelf`).toBeDefined();
  return a!;
}

describe.runIf(dbReady)('new achievements (integration)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('fresh account: every new family present, none earned', { timeout: 20_000 }, async () => {
    const u = await createUser();
    const shelf = await achievementsForUser(u);
    for (const id of [
      'locked_in',
      'double_locked',
      'tagged',
      'framed',
      'signature_look',
      'welcome_committee',
      'off_the_record',
      'discovered',
      'guardian_angel',
      'first_contact',
      'event_horizon',
    ]) {
      expect(byId(shelf, id).earned, `${id} should be locked`).toBe(false);
    }
  });

  it('security: passkey earns locked_in; +2FA earns double_locked', async () => {
    const u = await createUser();
    await db.insert(schema.webauthnCredentials).values({
      id: nextSnowflake(),
      userId: u,
      credentialId: `cred-${u}`,
      publicKey: 'pk',
    });
    let shelf = await achievementsForUser(u);
    expect(byId(shelf, 'locked_in').earned).toBe(true);
    expect(byId(shelf, 'double_locked').earned).toBe(false);

    await db.update(schema.users).set({ totpEnabled: true }).where(eq(schema.users.id, u));
    shelf = await achievementsForUser(u);
    expect(byId(shelf, 'double_locked').earned).toBe(true);
  });

  it('cosmetics: tagged / framed / signature_look track profile state', async () => {
    const u = await createUser();
    await db
      .update(schema.users)
      .set({
        tagLabel: 'ZKT',
        avatarDecoration: 'gold',
        avatarUrl: '/cdn/a.png',
        bannerUrl: '/cdn/b.png',
        bio: 'hi',
      })
      .where(eq(schema.users.id, u));
    const shelf = await achievementsForUser(u);
    expect(byId(shelf, 'tagged').earned).toBe(true);
    expect(byId(shelf, 'framed').earned).toBe(true);
    const look = byId(shelf, 'signature_look');
    expect(look.earned).toBe(true);
    expect(look.value).toBe(4);
  });

  it('welcome_committee: first regular message after someone else’s welcome', async () => {
    const owner = await createUser();
    const newcomer = await createUser();
    const greeter = await createUser();
    const g = await createGuild(owner);
    const ch = await createChannel(g);
    // The newcomer's welcome (data-authored by the newcomer), then the greeter
    // replies first, then more chatter.
    await createMessage(ch, { authorId: newcomer, type: 'system_join', content: 'welcome!' });
    await createMessage(ch, { authorId: greeter, content: 'hey, welcome in!' });
    await createMessage(ch, { authorId: owner, content: 'late hello' });

    expect(byId(await achievementsForUser(greeter), 'welcome_committee').earned).toBe(true);
    // The late replier didn't get there first; the newcomer can't earn it on
    // their own welcome.
    expect(byId(await achievementsForUser(owner), 'welcome_committee').earned).toBe(false);
    expect(byId(await achievementsForUser(newcomer), 'welcome_committee').earned).toBe(false);
  });

  it('off_the_record (E2EE DM), discovered (audit), guardian_angel (link)', async () => {
    const u = await createUser();
    const peer = await createUser();
    const dm = await createDmChannel([u, peer]);
    await db.update(schema.channels).set({ e2eeEnabled: true }).where(eq(schema.channels.id, dm));

    const owner = await createUser();
    const g = await createGuild(owner);
    await db.insert(schema.auditLogEntries).values({
      id: nextSnowflake(),
      guildId: g,
      actorId: u,
      targetType: 'member',
      targetId: u,
      action: 'member.join',
      changes: { via: 'discovery' },
    });

    const child = await createUser({ dateOfBirth: '2011-06-15' });
    await db.insert(schema.parentChildLinks).values({
      parentId: u,
      childId: child,
      status: 'active',
      initiatedBy: 'parent',
    });

    const shelf = await achievementsForUser(u);
    expect(byId(shelf, 'off_the_record').earned).toBe(true);
    expect(byId(shelf, 'discovered').earned).toBe(true);
    expect(byId(shelf, 'guardian_angel').earned).toBe(true);
  });

  it('voice: first_contact on any join; event_horizon at 60 minutes', async () => {
    const u = await createUser();
    await db.insert(schema.userVoiceStats).values({ userId: u, joins: 1, totalSeconds: 59 * 60 });
    let shelf = await achievementsForUser(u);
    expect(byId(shelf, 'first_contact').earned).toBe(true);
    const eh = byId(shelf, 'event_horizon');
    expect(eh.earned).toBe(false);
    expect(eh.value).toBe(59);

    await db
      .update(schema.userVoiceStats)
      .set({ totalSeconds: 61 * 60 })
      .where(eq(schema.userVoiceStats.userId, u));
    shelf = await achievementsForUser(u);
    expect(byId(shelf, 'event_horizon').earned).toBe(true);
  });
});
