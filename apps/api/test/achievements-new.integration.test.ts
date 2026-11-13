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

  it('fresh account: every new family present, none earned', async () => {
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
      'regular_30',
      'regular_100',
      'regular_365',
      'crowd_pleaser_3',
      'crowd_pleaser_5',
      'pollster_3',
      'pollster_5',
      'kindred_2',
      'kindred_3',
      'kindred_5',
      'vanishing_act',
      'pet_keeper_1',
      'pet_keeper_5',
      'pet_keeper_10',
      'pet_keeper_15',
      'pet_keeper_25',
      'pet_perfect_day',
    ]) {
      expect(byId(shelf, id).earned, `${id} should be locked`).toBe(false);
    }
  });

  it('the seven newer families follow the tier convention and sit where they belong on the shelf', async () => {
    const u = await createUser();
    const shelf = await achievementsForUser(u);
    const families: Array<{ name: string; ids: string[]; goals: number[]; markers: string[]; descriptions: string[] }> = [
      {
        name: 'Regular',
        ids: ['regular_30', 'regular_100', 'regular_365'],
        goals: [30, 100, 365],
        markers: ['30', '100', '365'],
        descriptions: [30, 100, 365].map((n) => `Sent messages on ${n} different days.`),
      },
      {
        name: 'Crowd Pleaser',
        ids: ['crowd_pleaser_3', 'crowd_pleaser_5'],
        goals: [3, 5],
        markers: ['3', '5'],
        descriptions: [3, 5].map((n) => `${n} different people reacted to one of your messages.`),
      },
      {
        name: 'The People Have Spoken',
        ids: ['pollster_3', 'pollster_5'],
        goals: [3, 5],
        markers: ['3', '5'],
        descriptions: [3, 5].map((n) => `A poll you made got votes from ${n} different people.`),
      },
      {
        name: 'Kindred Spirits',
        ids: ['kindred_2', 'kindred_3', 'kindred_5'],
        goals: [2, 3, 5],
        markers: ['2', '3', '5'],
        descriptions: [2, 3, 5].map((n) => `Kept a 7-day DM streak with ${n} different people.`),
      },
      {
        name: 'Now You See Me',
        ids: ['vanishing_act'],
        goals: [1],
        markers: ['👻'],
        descriptions: ['Turned on disappearing messages.'],
      },
      {
        name: 'Zekk Keeper',
        ids: ['pet_keeper_1', 'pet_keeper_5', 'pet_keeper_10', 'pet_keeper_15', 'pet_keeper_25'],
        goals: [1, 5, 10, 15, 25],
        markers: ['🐣', '5', '10', '15', '25'],
        // The pet is shared: both people earn each rung, whoever tipped it.
        descriptions: [
          'Helped hatch a Zekk Pet.',
          'Helped a Zekk Pet grow into a Kid.',
          'Helped a Zekk Pet grow into a Teen.',
          'Helped a Zekk Pet grow into an Adult.',
          'Helped a Zekk Pet grow into a Legendary.',
        ],
      },
      {
        name: 'Perfect Day',
        ids: ['pet_perfect_day'],
        goals: [1],
        markers: ['☀️'],
        descriptions: ['Every Zekk Pet task done in one day.'],
      },
    ];
    for (const f of families) {
      // Clients number rungs by grouping on the name: it must be the family's
      // alone, and carry no numeral of its own.
      expect(shelf.filter((a) => a.name === f.name).map((a) => a.id)).toEqual(f.ids);
      expect(f.name).not.toMatch(/\d/);
      f.ids.forEach((id, i) => {
        const a = byId(shelf, id);
        expect(a).toMatchObject({
          name: f.name,
          goal: f.goals[i],
          marker: f.markers[i],
          description: f.descriptions[i],
          value: 0,
          earned: false,
        });
        expect([...a.marker].length).toBeLessThanOrEqual(3);
      });
    }
    // Nothing earned and no progress: the shelf is in push order, which is the
    // placement the families were given.
    const at = (id: string) => shelf.findIndex((a) => a.id === id);
    const order = [
      'night_owl',
      'regular_30',
      'regular_365',
      'first_responder',
      'crowd_pleaser_3',
      'pollster_5',
      'social_5',
      'marathon',
      'inseparable_100',
      'kindred_2',
      'kindred_5',
      'founder',
      'poke_received_5',
      'pet_keeper_1',
      'pet_keeper_25',
      'pet_perfect_day',
      'off_the_record',
      'vanishing_act',
      'discovered',
    ];
    for (let i = 1; i < order.length; i++) {
      expect(at(order[i - 1]!), `${order[i - 1]} before ${order[i]}`).toBeLessThan(at(order[i]!));
    }
    // Android draws a badge from its marker alone: no two badges may share a
    // glyph marker (thresholds like '5' are the tier convention, not glyphs).
    const glyphs = shelf.map((a) => a.marker).filter((m) => !/\d/.test(m));
    expect(glyphs.length).toBeGreaterThan(10);
    expect(new Set(glyphs).size, `duplicate marker in ${glyphs.join(' ')}`).toBe(glyphs.length);
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
