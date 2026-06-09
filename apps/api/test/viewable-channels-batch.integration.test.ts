import { describe, it, expect, afterEach, afterAll } from 'vitest';
import { Permissions as P } from '@zekktris/shared/permissions';
import {
  createUser,
  createGuild,
  addMember,
  createRole,
  assignRole,
  createChannel,
  addOverride,
  cleanupAll,
} from './seed';
import { probeDb, closeDb } from './db-available';
import {
  listViewableGuildChannelIds,
  listViewableGuildChannelIdsByGuild,
} from '../src/services/permissions';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping viewable-channels batch tests — no database reachable');
}

/** Sort + stringify for order-insensitive set comparison. */
function ids(arr: Iterable<bigint>): string[] {
  return Array.from(arr, (x) => x.toString()).sort();
}

describe.runIf(dbReady)('listViewableGuildChannelIdsByGuild (integration)', () => {
  afterEach(async () => {
    await cleanupAll();
  });
  afterAll(async () => {
    await closeDb();
  });

  it('matches the per-guild resolver byte-for-byte across many guilds', async () => {
    // Distinct owner so the SUBJECT is a non-owner everywhere except gB —
    // otherwise the owner short-circuit would mask the override math.
    const owner = await createUser();
    const user = await createUser();

    // ── Guild A: plain member, @everyone can VIEW; one channel denies the
    //    member explicitly; a category with a hidden child (reconcile). ──
    const gA = await createGuild(owner, P.VIEW_CHANNEL);
    await addMember(gA, user);
    const aCat = await createChannel(gA, { type: 'guild_category' });
    const aVisible = await createChannel(gA, { parentId: aCat });
    const aHidden = await createChannel(gA, { parentId: aCat });
    await addOverride(aHidden, 'member', user, 0n, P.VIEW_CHANNEL); // deny view
    const aLoose = await createChannel(gA); // no parent, visible

    // ── Guild B: user is the OWNER → sees everything incl. empty categories. ──
    const gB = await createGuild(user, 0n);
    await addMember(gB, user);
    const bCat = await createChannel(gB, { type: 'guild_category' });
    const bChan = await createChannel(gB, { parentId: bCat });
    const bEmptyCat = await createChannel(gB, { type: 'guild_category' });

    // ── Guild C: plain member, @everyone has NO view; a role grants view on
    //    one channel via an allow override (orphan-child rescue → cat). ──
    const gC = await createGuild(owner, 0n);
    await addMember(gC, user);
    const cRole = await createRole(gC, 0n, 1);
    await assignRole(gC, user, cRole);
    const cCat = await createChannel(gC, { type: 'guild_category' });
    const cGranted = await createChannel(gC, { parentId: cCat });
    await addOverride(cGranted, 'role', cRole, P.VIEW_CHANNEL, 0n);
    const cDenied = await createChannel(gC); // no view anywhere

    // ── Guild D: plain member with ADMINISTRATOR via @everyone → sees all. ──
    const gD = await createGuild(owner, P.ADMINISTRATOR);
    await addMember(gD, user);
    await createChannel(gD);
    await createChannel(gD, { type: 'guild_category' });

    const guildIds = [gA, gB, gC, gD];

    // Ground truth: the existing, trusted per-guild resolver.
    const perGuild = new Map<bigint, string[]>();
    for (const g of guildIds) {
      perGuild.set(g, ids(await listViewableGuildChannelIds(g, user)));
    }

    // Batched resolver under test.
    const batched = await listViewableGuildChannelIdsByGuild(guildIds, user);

    for (const g of guildIds) {
      expect(ids(batched.get(g) ?? [])).toEqual(perGuild.get(g));
    }

    // Spot-check the semantics so a bug in BOTH paths can't hide.
    expect(perGuild.get(gA)).toEqual(ids([aCat, aVisible, aLoose])); // hidden child pruned, cat kept (has visible child)
    expect(new Set(perGuild.get(gA))).not.toContain(aHidden.toString());
    expect(perGuild.get(gC)).toEqual(ids([cCat, cGranted])); // orphan-child rescue pulled the category; denied excluded
    expect(new Set(perGuild.get(gC))).not.toContain(cDenied.toString());
    // Owner sees all of B incl. the empty category; admin sees all of D.
    expect((batched.get(gB) ?? []).length).toBe(3);
    expect((batched.get(gD) ?? []).length).toBe(2);
    expect(bEmptyCat && bChan).toBeTruthy(); // referenced for clarity
  });

  it('omits guilds the user is not a member of', async () => {
    const member = await createUser();
    const stranger = await createUser();
    const g = await createGuild(member, P.VIEW_CHANNEL);
    await addMember(g, member);
    await createChannel(g);

    const batched = await listViewableGuildChannelIdsByGuild([g], stranger);
    // Non-member → omitted from the map entirely (mirrors per-guild []).
    expect(batched.has(g)).toBe(false);
    expect(await listViewableGuildChannelIds(g, stranger)).toEqual([]);
  });

  it('returns an empty map for an empty guild list', async () => {
    const user = await createUser();
    const batched = await listViewableGuildChannelIdsByGuild([], user);
    expect(batched.size).toBe(0);
  });
});
