import { describe, it, expect, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/db';
import { updateRole, selfAssignRole } from '../src/services/roles';
import { Permissions } from '@zekktris/shared/permissions';
import { createUser, createGuild, createRole, addMember, cleanupAll } from './seed';
import { probeDb, closeDb } from './db-available';

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping self-assignable-role tests — no database reachable');
}

describe.runIf(dbReady)('self-assignable role permission ceiling', () => {
  afterAll(async () => {
    await cleanupAll();
    await closeDb();
  });

  it('refuses to flag a privileged role self-assignable', async () => {
    const owner = await createUser();
    const g = await createGuild(owner, 0n);
    const banRole = await createRole(g, Permissions.BAN_MEMBERS, 2);
    await expect(
      updateRole({ guildId: g, actorId: owner, roleId: banRole, selfAssignable: true }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('refuses to raise permissions to privileged AND flag self-assignable in one call', async () => {
    const owner = await createUser();
    const g = await createGuild(owner, 0n);
    const role = await createRole(g, 0n, 2);
    await expect(
      updateRole({
        guildId: g,
        actorId: owner,
        roleId: role,
        permissions: Permissions.MANAGE_ROLES,
        selfAssignable: true,
      }),
    ).rejects.toMatchObject({ code: 'BAD_REQUEST' });
  });

  it('allows flagging an unprivileged role, and selfAssignRole still refuses if it later gains privileged bits', async () => {
    const owner = await createUser();
    const member = await createUser();
    const g = await createGuild(owner, 0n);
    await addMember(g, member);
    const role = await createRole(g, 0n, 2);
    // Unprivileged → flagging is allowed.
    await expect(
      updateRole({ guildId: g, actorId: owner, roleId: role, selfAssignable: true }),
    ).resolves.toBeDefined();
    // Member can self-assign it while unprivileged.
    await expect(selfAssignRole({ guildId: g, userId: member, roleId: role })).resolves.toBeUndefined();
    // Now the role gains a privileged bit out-of-band; self-assign must refuse.
    await db
      .update(schema.roles)
      .set({ permissions: Permissions.ADMINISTRATOR })
      .where(eq(schema.roles.id, role));
    const other = await createUser();
    await addMember(g, other);
    await expect(selfAssignRole({ guildId: g, userId: other, roleId: role })).rejects.toMatchObject({
      code: 'FORBIDDEN',
    });
  });
});
