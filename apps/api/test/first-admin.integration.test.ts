/**
 * First admin: the installer's create-admin path and the BOOTSTRAP_ADMIN_EMAIL
 * promotion (boot, signup, email verification).
 *
 * Bootstrap only acts while NO admin exists anywhere, and other integration
 * files create admins in the shared test database in parallel. So this file
 * runs against its own empty copy of every table: a throwaway schema cloned
 * from public (`LIKE … INCLUDING ALL`, so indexes and defaults but no foreign
 * keys) that sits first on the connection's search_path. The real `db` module
 * is swapped for a client on that search_path; everything else is real.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import { Hono } from 'hono';
import { eq, sql } from 'drizzle-orm';

const { ISO, mail } = vi.hoisted(() => ({
  ISO: `first_admin_${process.pid}_${Date.now().toString(36)}`,
  mail: { configured: false, sent: [] as Array<{ to: string; verifyUrl: string }> },
}));

vi.mock('../src/db', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/db')>();
  const { createDb } = await import('@zekktris/db');
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('search_path', `${ISO},public`);
  const iso = createDb(url.toString(), { max: 4, onnotice: () => {} });
  return {
    ...real,
    db: iso.db,
    client: iso.client,
    closeDb: async () => {
      await iso.client.end({ timeout: 5 });
      await real.closeDb();
    },
  };
});

// SMTP on/off per test; sent verification links are captured instead of mailed.
vi.mock('../src/services/email', async (importOriginal) => {
  const real = await importOriginal<typeof import('../src/services/email')>();
  return {
    ...real,
    isEmailConfigured: () => mail.configured,
    sendEmailVerification: async (args: { to: string; verifyUrl: string }) => {
      mail.sent.push({ to: args.to, verifyUrl: args.verifyUrl });
    },
  };
});

const { db, client, schema, closeDb } = await import('../src/db');
const { probeDb } = await import('./db-available');
const { env } = await import('../src/env');
const { runBootstrapAdmin, promoteIfBootstrapAdmin } = await import('../src/bootstrap-admin');
const { createAdmin, hasAdmin, usernameFromEmail, CreateAdminError } = await import(
  '../src/admin/createAdmin'
);
const { verifyPassword } = await import('../src/auth/passwords');
const { nextSnowflake } = await import('../src/snowflake');
const { createSession } = await import('../src/auth/sessions');
const { signAccessToken } = await import('../src/auth/tokens');
const { errorHandler } = await import('../src/middleware');
const { authRouter } = await import('../src/routes/auth');
const { ACHIEVEMENT_CATALOG } = await import('../src/services/achievements');

const dbReady = await probeDb();
if (!dbReady) {
  // eslint-disable-next-line no-console
  console.warn('[integration] skipping first-admin tests — no database reachable');
}

const app = new Hono();
app.onError(errorHandler);
app.route('/auth', authRouter);

const BOOT = 'owner@example.test';

async function addUser(
  email: string,
  opts: { verified?: boolean; admin?: boolean; deleted?: boolean } = {},
): Promise<bigint> {
  const id = nextSnowflake();
  await db.insert(schema.users).values({
    id,
    email,
    username: `u_${id}`,
    displayName: 'Seed User',
    passwordHash: 'scrypt-v1$00$00',
    emailVerified: opts.verified ?? false,
    isAdmin: opts.admin ?? false,
    deletedAt: opts.deleted ? new Date() : null,
  });
  return id;
}

async function row(id: bigint) {
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return u!;
}

async function adminCount(): Promise<number> {
  const r = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(schema.users)
    .where(eq(schema.users.isAdmin, true));
  return r[0]?.n ?? 0;
}

function register(email: string, username: string) {
  return app.request('/auth/register', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      email,
      username,
      displayName: 'Owner',
      password: 'correct horse battery',
      dateOfBirth: '1990-01-01',
    }),
  });
}

describe.runIf(dbReady)('first admin', () => {
  const savedBootstrap = env.BOOTSTRAP_ADMIN_EMAIL;

  beforeAll(async () => {
    await db.execute(sql.raw(`CREATE SCHEMA "${ISO}"`));
    await db.execute(
      sql.raw(`DO $$ DECLARE t record; BEGIN
        FOR t IN SELECT tablename FROM pg_tables WHERE schemaname = 'public' LOOP
          EXECUTE format('CREATE TABLE %I.%I (LIKE public.%I INCLUDING ALL)', '${ISO}', t.tablename, t.tablename);
        END LOOP;
      END $$`),
    );
  });

  beforeEach(async () => {
    await db.execute(sql.raw(`TRUNCATE "${ISO}".users, "${ISO}".sessions, "${ISO}".email_verifications`));
    env.BOOTSTRAP_ADMIN_EMAIL = BOOT;
    mail.configured = false;
    mail.sent = [];
  });

  afterAll(async () => {
    env.BOOTSTRAP_ADMIN_EMAIL = savedBootstrap;
    await db.execute(sql.raw(`DROP SCHEMA IF EXISTS "${ISO}" CASCADE`));
    await closeDb();
  });

  describe('runBootstrapAdmin (boot)', () => {
    it('promotes a VERIFIED account with the address (existing installs keep working)', async () => {
      env.BOOTSTRAP_ADMIN_EMAIL = 'Owner@Example.test'; // env case doesn't matter
      const id = await addUser(BOOT, { verified: true });
      await runBootstrapAdmin();
      expect((await row(id)).isAdmin).toBe(true);
    });

    it('does NOT promote an unverified account with the address', async () => {
      const id = await addUser(BOOT, { verified: false });
      await runBootstrapAdmin();
      expect((await row(id)).isAdmin).toBe(false);
      expect(await adminCount()).toBe(0);
    });

    it('does nothing once any admin exists, or when the variable is unset', async () => {
      const other = await addUser('someone@example.test', { verified: true, admin: true });
      const id = await addUser(BOOT, { verified: true });
      await runBootstrapAdmin();
      expect((await row(id)).isAdmin).toBe(false);

      await db.update(schema.users).set({ isAdmin: false }).where(eq(schema.users.id, other));
      env.BOOTSTRAP_ADMIN_EMAIL = undefined;
      await runBootstrapAdmin();
      expect((await row(id)).isAdmin).toBe(false);
    });

    it('ignores a deleted account with the address', async () => {
      const id = await addUser(BOOT, { verified: true, deleted: true });
      await runBootstrapAdmin();
      expect((await row(id)).isAdmin).toBe(false);
    });

    it('an unverified account that moves to the address via /change-unverified-email gets nothing', async () => {
      const id = await addUser('typo@example.test', { verified: false });
      const { session } = await createSession({ userId: id, userAgent: null, ipAddress: null });
      const token = await signAccessToken({ userId: id, sessionId: session.id });
      const res = await app.request('/auth/change-unverified-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ email: BOOT }),
      });
      expect(res.status).toBe(200);
      expect((await row(id)).email).toBe(BOOT);

      await runBootstrapAdmin(); // the next restart
      expect(await promoteIfBootstrapAdmin(id)).toBe(false);
      expect((await row(id)).isAdmin).toBe(false);
    });
  });

  describe('verification links are bound to the address they were sent to', () => {
    it('a change to the bootstrap address landing mid-/verify-email does not verify it', async () => {
      // The interleaving: /verify-email has the token in hand, the account
      // moves to BOOTSTRAP_ADMIN_EMAIL (and its tokens are deleted, as
      // /change-unverified-email does), then the verify lands. Played out
      // deterministically: this transaction holds the account row (as
      // /change-unverified-email's does) until verify is waiting on it.
      mail.configured = true;
      const id = await addUser('attacker@example.test', { verified: false });
      const { session } = await createSession({ userId: id, userAgent: null, ipAddress: null });
      const access = await signAccessToken({ userId: id, sessionId: session.id });
      const resend = await app.request('/auth/resend-verification', {
        method: 'POST',
        headers: { authorization: `Bearer ${access}` },
      });
      expect(resend.status).toBe(200);
      expect(mail.sent.map((m) => m.to)).toEqual(['attacker@example.test']);
      const token = new URL(mail.sent[0]!.verifyUrl).searchParams.get('token')!;

      let verify!: Promise<Response>;
      await client.begin(async (tx) => {
        const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT 1 FROM users WHERE id = ${id.toString()}::bigint FOR UPDATE`;
        verify = Promise.resolve(
          app.request('/auth/verify-email', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ token }),
          }),
        );
        await vi.waitFor(
          async () => {
            // From another connection: pg_stat_activity is snapshotted once
            // per transaction, so polling it inside `tx` would never change.
            const w = await db.execute<{ n: number }>(sql`
              SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE ${me!.pid}::int = ANY(pg_blocking_pids(pid))`);
            expect(w[0]!.n).toBe(1);
          },
          { timeout: 5000, interval: 20 },
        );
        await tx`UPDATE users SET email = ${BOOT} WHERE id = ${id.toString()}::bigint`;
        await tx`DELETE FROM email_verifications WHERE user_id = ${id.toString()}::bigint`;
      });

      expect((await verify).status).toBe(400);
      const u = await row(id);
      expect(u.email).toBe(BOOT);
      expect(u.emailVerified).toBe(false);
      expect(u.isAdmin).toBe(false);
    });
    it('a link being issued while the address changes is not stored or sent', async () => {
      // /resend-verification read the old address; the change (tokens deleted)
      // lands before the token is stored — the late link must not be mailed
      // to the old inbox while the account holds the new address.
      mail.configured = true;
      const id = await addUser('attacker@example.test', { verified: false });
      const { session } = await createSession({ userId: id, userAgent: null, ipAddress: null });
      const access = await signAccessToken({ userId: id, sessionId: session.id });

      let resend!: Promise<Response>;
      await client.begin(async (tx) => {
        const [me] = await tx<{ pid: number }[]>`SELECT pg_backend_pid() AS pid`;
        await tx`SELECT 1 FROM users WHERE id = ${id.toString()}::bigint FOR UPDATE`;
        resend = Promise.resolve(
          app.request('/auth/resend-verification', {
            method: 'POST',
            headers: { authorization: `Bearer ${access}` },
          }),
        );
        await vi.waitFor(
          async () => {
            const w = await db.execute<{ n: number }>(sql`
              SELECT count(*)::int AS n FROM pg_stat_activity
              WHERE ${me!.pid}::int = ANY(pg_blocking_pids(pid))`);
            expect(w[0]!.n).toBe(1);
          },
          { timeout: 5000, interval: 20 },
        );
        await tx`UPDATE users SET email = ${BOOT} WHERE id = ${id.toString()}::bigint`;
        await tx`DELETE FROM email_verifications WHERE user_id = ${id.toString()}::bigint`;
      });

      expect((await resend).status).toBe(200);
      expect(mail.sent).toEqual([]);
      const left = await db
        .select()
        .from(schema.emailVerifications)
        .where(eq(schema.emailVerifications.userId, id));
      expect(left).toEqual([]);
    });
  });

  describe('signup with SMTP configured', () => {
    it('is not admin until the address is verified; verifying promotes it', async () => {
      mail.configured = true;
      const res = await register(BOOT, 'owner');
      expect(res.status).toBe(201);
      const body = (await res.json()) as { user: { id: string; isAdmin?: boolean } };
      expect(body.user.isAdmin).not.toBe(true);
      const id = BigInt(body.user.id);
      expect((await row(id)).emailVerified).toBe(false);

      await runBootstrapAdmin(); // a restart before verifying changes nothing
      expect((await row(id)).isAdmin).toBe(false);

      await vi.waitFor(() => expect(mail.sent).toHaveLength(1));
      const token = new URL(mail.sent[0]!.verifyUrl).searchParams.get('token')!;
      const v = await app.request('/auth/verify-email', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token }),
      });
      expect(v.status).toBe(200);
      const after = await row(id);
      expect(after.emailVerified).toBe(true);
      expect(after.isAdmin).toBe(true);
    });
  });

  describe('signup without SMTP', () => {
    it('auto-verifies, so the first account registered with the address is admin at once', async () => {
      // The documented trade-off of BOOTSTRAP_ADMIN_EMAIL on an email-less
      // server — why install.sh creates the admin directly instead.
      const res = await register(BOOT, 'owner');
      expect(res.status).toBe(201);
      const body = (await res.json()) as { user: { id: string; isAdmin?: boolean } };
      expect(body.user.isAdmin).toBe(true);
      expect((await row(BigInt(body.user.id))).emailVerified).toBe(true);
    });

    it('nobody is promoted once the installer created the admin', async () => {
      await createAdmin({ email: 'installer@example.test', password: 'operator-chosen-pw' });
      const res = await register(BOOT, 'owner');
      expect(res.status).toBe(201);
      const body = (await res.json()) as { user: { id: string; isAdmin?: boolean } };
      expect(body.user.isAdmin).not.toBe(true);
      expect(await adminCount()).toBe(1);
    });

    it('an account with a different address is not promoted', async () => {
      const res = await register('someone@example.test', 'someone');
      const body = (await res.json()) as { user: { id: string; isAdmin?: boolean } };
      expect(body.user.isAdmin).not.toBe(true);
      expect(await adminCount()).toBe(0);
    });

    it('a new account starts seeded at the current achievement catalog (no silent backfill to swallow its first unlock)', async () => {
      const res = await register('newcomer@example.test', 'newcomer');
      expect(res.status).toBe(201);
      const body = (await res.json()) as { user: { id: string } };
      const u = await row(BigInt(body.user.id));
      expect([u.achievementsSeeded, u.achievementsCatalog]).toEqual([true, ACHIEVEMENT_CATALOG]);
    });
  });

  describe('createAdmin (install.sh / scripts/create-admin.ts)', () => {
    it('creates a verified admin that can sign in with the given password', async () => {
      env.BOOTSTRAP_ADMIN_EMAIL = undefined;
      const r = await createAdmin({ email: ' Jordan.Reyes+chat@Example.test ', password: 'operator-chosen-pw' });
      expect(r.outcome).toBe('created');
      expect(r.email).toBe('jordan.reyes+chat@example.test');
      expect(r.username).toBe('jordan.reyes_chat');

      const u = await row(r.userId);
      expect(u.isAdmin).toBe(true);
      expect(u.emailVerified).toBe(true);
      expect(u.displayName).toBe('Jordan.reyes_chat');
      expect(u.achievementsSeeded).toBe(true);
      expect(u.achievementsCatalog).toBe(ACHIEVEMENT_CATALOG);
      expect(u.dateOfBirth).toBeNull();
      expect(u.dobLocked).toBe(false); // the app asks for it once
      expect(u.passwordHash).not.toContain('operator-chosen-pw');
      expect(await verifyPassword('operator-chosen-pw', u.passwordHash)).toBe(true);

      const login = await app.request('/auth/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'jordan.reyes+chat@example.test', password: 'operator-chosen-pw' }),
      });
      expect(login.status).toBe(200);
      const lb = (await login.json()) as { user: { isAdmin?: boolean } };
      expect(lb.user.isAdmin).toBe(true);
    });

    it('promotes an existing verified account without touching its password', async () => {
      const other = await addUser('first@example.test', { verified: true, admin: true });
      const id = await addUser(BOOT, { verified: true });
      const r = await createAdmin({ email: BOOT, password: 'ignored-for-existing' });
      expect(r).toMatchObject({ outcome: 'promoted', wasAdmin: false, banned: false });
      const u = await row(id);
      expect(u.isAdmin).toBe(true); // even with another admin present
      expect(u.passwordHash).toBe('scrypt-v1$00$00');
      expect((await row(other)).isAdmin).toBe(true);

      const again = await createAdmin({ email: BOOT });
      expect(again).toMatchObject({ outcome: 'promoted', wasAdmin: true });
    });

    it('refuses an existing UNVERIFIED account unless promoteUnverified is passed', async () => {
      // Anyone can register any address on a server with SMTP.
      const id = await addUser(BOOT, { verified: false });
      await expect(createAdmin({ email: BOOT })).rejects.toThrow(/not verified its address/);
      expect((await row(id)).isAdmin).toBe(false);

      const r = await createAdmin({ email: BOOT, promoteUnverified: true });
      expect(r).toMatchObject({ outcome: 'promoted', wasAdmin: false });
      const u = await row(id);
      expect(u.isAdmin).toBe(true);
      expect(u.emailVerified).toBe(true);
    });

    it('createOnly (fresh install) refuses an address someone already registered', async () => {
      // Registration is open while install.sh runs: a stranger who got the
      // address first must make the install fail, not become admin.
      const id = await addUser(BOOT, { verified: true });
      await expect(
        createAdmin({ email: BOOT, password: 'operator-chosen-pw', createOnly: true }),
      ).rejects.toThrow(/already exists .* NOT made admin/);
      expect((await row(id)).isAdmin).toBe(false);
      expect(await hasAdmin()).toBe(false);

      const r = await createAdmin({
        email: 'fresh@example.test',
        password: 'operator-chosen-pw',
        createOnly: true,
      });
      expect(r.outcome).toBe('created');
      expect(await hasAdmin()).toBe(true);
    });

    it('picks a free username when the derived one is taken; honours an explicit one', async () => {
      await db.insert(schema.users).values({
        id: nextSnowflake(),
        email: 'x@example.test',
        username: 'admin',
        displayName: 'X',
        passwordHash: 'scrypt-v1$00$00',
      });
      const r = await createAdmin({ email: 'admin@example.test', password: 'operator-chosen-pw' });
      expect(r.username).toBe('admin2');

      const named = await createAdmin({
        email: 'b@example.test',
        password: 'operator-chosen-pw',
        username: 'Boss',
        displayName: 'The Boss',
      });
      expect(named.username).toBe('boss');
      expect((await row(named.userId)).displayName).toBe('The Boss');

      await expect(
        createAdmin({ email: 'c@example.test', password: 'operator-chosen-pw', username: 'boss' }),
      ).rejects.toThrow('That username is already taken.');
    });

    it('rejects bad input with a readable error and creates nothing', async () => {
      await expect(createAdmin({ email: 'nope', password: 'operator-chosen-pw' })).rejects.toBeInstanceOf(
        CreateAdminError,
      );
      await expect(createAdmin({ email: 'a@example.test', password: 'short' })).rejects.toThrow(
        /Password: Password must be at least 8 characters/,
      );
      await expect(createAdmin({ email: 'a@example.test' })).rejects.toThrow(/password is required/);
      await expect(
        createAdmin({ email: 'a@example.test', password: 'operator-chosen-pw', username: 'bad name' }),
      ).rejects.toThrow(/Username/);
      expect(await adminCount()).toBe(0);
    });

    it('refuses an address held by a deleted account', async () => {
      await addUser(BOOT, { deleted: true });
      await expect(createAdmin({ email: BOOT, password: 'operator-chosen-pw' })).rejects.toThrow(
        /deleted account/,
      );
    });
  });

  it('usernameFromEmail keeps to the username rules', () => {
    expect(usernameFromEmail('Jo.Smith@x.y')).toBe('jo.smith');
    expect(usernameFromEmail('a..b@x.y')).toBe('a.b');
    expect(usernameFromEmail('x@x.y')).toBe('admin');
    expect(usernameFromEmail(`${'q'.repeat(60)}@x.y`)).toHaveLength(32);
  });
});
