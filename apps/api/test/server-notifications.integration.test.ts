import { describe, it, expect, afterAll } from 'vitest';
import { listChannelAllSubscribers, setOverride } from '../src/services/notifications';
import { createUser, createGuild, createChannel, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping server-notifications tests — no database reachable');
}

// "Get notifications from servers too" is strictly OPT-IN: a non-mention guild
// message only pushes to users who EXPLICITLY set 'all' on the channel or its
// guild. The implicit 'all' default must NOT subscribe anyone (else every
// member is fire-hosed on every message). listChannelAllSubscribers is the gate.
describe.runIf(dbReady)('server notifications opt-in (listChannelAllSubscribers)', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('includes only explicit all-subscribers, honoring channel > guild precedence', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner);
    const channelId = await createChannel(guildId);

    const noRow = await createUser(); // no override → NOT subscribed (default ≠ subscribe)
    const guildAll = await createUser(); // guild 'all' → subscribed
    const channelAll = await createUser(); // channel 'all' → subscribed
    const guildAllChannelOff = await createUser(); // guild 'all' but channel 'nothing' → NOT
    const mentionsOnly = await createUser(); // channel 'mentions' → NOT
    const channelOff = await createUser(); // channel 'nothing' → NOT
    const guildMentions = await createUser(); // guild 'mentions' → NOT

    await setOverride(guildAll, 'guild', guildId, 'all');
    await setOverride(channelAll, 'channel', channelId, 'all');
    await setOverride(guildAllChannelOff, 'guild', guildId, 'all');
    await setOverride(guildAllChannelOff, 'channel', channelId, 'nothing');
    await setOverride(mentionsOnly, 'channel', channelId, 'mentions');
    await setOverride(channelOff, 'channel', channelId, 'nothing');
    await setOverride(guildMentions, 'guild', guildId, 'mentions');

    const subs = (await listChannelAllSubscribers(channelId, guildId)).map((id) => id.toString());

    expect(subs).toContain(guildAll.toString());
    expect(subs).toContain(channelAll.toString());

    expect(subs).not.toContain(noRow.toString());
    expect(subs).not.toContain(guildAllChannelOff.toString()); // channel 'nothing' wins over guild 'all'
    expect(subs).not.toContain(mentionsOnly.toString());
    expect(subs).not.toContain(channelOff.toString());
    expect(subs).not.toContain(guildMentions.toString());
  });

  it('is empty when nobody opted in (the common case — no fire-hose)', async () => {
    const owner = await createUser();
    const guildId = await createGuild(owner);
    const channelId = await createChannel(guildId);
    await createUser(); // a member with no override
    const subs = await listChannelAllSubscribers(channelId, guildId);
    expect(subs).toHaveLength(0);
  });
});
