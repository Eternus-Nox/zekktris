/**
 * Create the server's admin account (or make an existing account admin).
 * ----------------------------------------------------------------------
 * install.sh runs this inside the api container once the stack is healthy;
 * operators can run it by hand the same way:
 *
 *   docker compose exec -w /app/apps/api api \
 *     node --import tsx/esm scripts/create-admin.ts --email you@example.com
 *
 * Options:
 *   --email <address>        required (except with --check)
 *   --username <name>        default: derived from the email
 *   --display-name <name>    default: the username
 *   --create-only            fail if an account already has the email, rather
 *                            than promoting it (install.sh on a new server)
 *   --promote-unverified     also promote an existing account whose address
 *                            isn't verified (it is marked verified)
 *   --check                  only report whether the server has an admin:
 *                            exit 0 if it does, 3 if not
 *
 * The password is never taken as an argument (it would land in shell history
 * and `ps`). It's read from stdin: piped (`-T`, first line), or typed at a
 * hidden prompt when stdin is a terminal. It is only needed when the account
 * doesn't exist yet — an existing account is promoted with its password left
 * alone. See src/admin/createAdmin.ts for what gets created.
 *
 * Output: one line. install.sh keys off its start ("Created admin account"
 * = the password just given is the account's), so keep that wording.
 *
 * Exit codes: 0 done, 1 bad input / failure, 3 no admin (--check only).
 */

import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { closeDb } from '../src/db';
import { createAdmin, CreateAdminError, hasAdmin } from '../src/admin/createAdmin';

/** Read a line from a TTY without echoing it. */
function promptHidden(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    process.stderr.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    let value = '';
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === '\r' || ch === '\n' || ch === '\u0004') return done();
        if (ch === '\u0003') return done(new CreateAdminError('Cancelled.'));
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** The first line of piped stdin ('' when nothing was piped). */
async function readPipedLine(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0] ?? '';
}

async function readPassword(): Promise<string> {
  if (!process.stdin.isTTY) return readPipedLine();
  const first = await promptHidden('Password for the new account (leave empty if it exists): ');
  if (first === '') return '';
  const again = await promptHidden('Repeat the password: ');
  if (first !== again) throw new CreateAdminError('The passwords did not match.');
  return first;
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      email: { type: 'string' },
      username: { type: 'string' },
      'display-name': { type: 'string' },
      'create-only': { type: 'boolean' },
      'promote-unverified': { type: 'boolean' },
      check: { type: 'boolean' },
    },
    strict: true,
  });
  // eslint-disable-next-line no-console
  const out = console.log;
  if (values.check) {
    const yes = await hasAdmin();
    out(yes ? 'This server has an admin.' : 'This server has no admin yet.');
    if (!yes) process.exitCode = 3;
    return;
  }
  if (!values.email) throw new CreateAdminError('--email is required.');

  const password = await readPassword();
  const result = await createAdmin({
    email: values.email,
    password,
    username: values.username,
    displayName: values['display-name'],
    createOnly: values['create-only'],
    promoteUnverified: values['promote-unverified'],
  });

  if (result.outcome === 'created') {
    out(`Created admin account ${result.email} (username ${result.username}).`);
  } else if (result.wasAdmin) {
    out(`${result.email} (username ${result.username}) is already an admin.`);
  } else {
    out(`Made the existing account ${result.email} (username ${result.username}) an admin; its password is unchanged.`);
  }
  if (result.outcome === 'promoted' && result.banned) {
    // eslint-disable-next-line no-console
    console.warn('Note: this account is banned and cannot sign in until it is unbanned.');
  }
}

// Only auto-run when invoked directly, not when imported by a test.
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main()
    .catch((err) => {
      // eslint-disable-next-line no-console
      const usage =
        err instanceof CreateAdminError ||
        String((err as { code?: unknown }).code ?? '').startsWith('ERR_PARSE_ARGS');
      console.error(usage ? (err as Error).message : err);
      process.exitCode = 1;
    })
    .finally(() => closeDb());
}
