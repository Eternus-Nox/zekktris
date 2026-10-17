import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { envSchema } from '../src/env';

// docker-compose.yml has no env_file: the api container gets ONLY the
// variables its `environment:` block names. A variable env.ts reads but compose
// does not list is silently stuck at its code default on every compose install
// — that is how FCM_* sat in .env for months doing nothing, and how
// INACTIVITY_TTL_DAYS=0 failed to switch off the account-deletion sweep and
// FIELD_ENCRYPTION_KEYS_OLD never reached the api during a key rotation.

const COMPOSE = readFileSync(join(__dirname, '../../../docker-compose.yml'), 'utf8');

/** `services.api.environment` as raw strings. Line-based on purpose (no YAML
 *  dependency): the block is a flat `KEY: value` map at six spaces. */
function apiEnvironment(): Map<string, string> {
  const lines = COMPOSE.split('\n');
  const start = lines.indexOf('  api:');
  expect(start).toBeGreaterThan(-1);
  const out = new Map<string, string>();
  let inEnv = false;
  for (const line of lines.slice(start + 1)) {
    if (/^ {2}\S/.test(line)) break; // next service
    if (/^ {4}\S/.test(line)) inEnv = line.trim() === 'environment:';
    const m = inEnv ? /^ {6}([A-Z][A-Z0-9_]*):\s*(.*?)\s*(#.*)?$/.exec(line) : null;
    if (m) out.set(m[1]!, m[2]!.replace(/^"(.*)"$/, '$1'));
  }
  return out;
}

/** Container-internal settings that must NOT come from .env: they are paths
 *  and ports inside the image that have to agree with ops/Dockerfile.api and
 *  the compose mounts, not operator choices. */
const CONTAINER_INTERNAL = new Set(['NODE_ENV', 'HOST', 'PORT', 'UPLOAD_DIR', 'BACKUP_DIR', 'CONTROL_DIR']);

/** Fixed by the stack itself rather than read from .env. */
const FIXED = new Set([
  'TRUST_PROXY', // Caddy is always in front of the api
  'REDIS_URL', // the bundled `cache` service
]);

/** Compose defaults that differ from env.ts on purpose. */
const INTENTIONAL_DEFAULTS = new Set([
  'PUBLIC_URL', // compose serves through Caddy on :5550, not the api's :3000
  'DB_POOL_MAX', // compose has always shipped a pool of 10 per api process
  'APNS_KEY_P8_FILE', // the ./secrets mount at /keys
  'LIVEKIT_HTTP_URL', // the bundled SFU on the host network
]);

describe('docker-compose.yml api environment', () => {
  const composeEnv = apiEnvironment();
  const schemaKeys = Object.keys(envSchema.shape);

  it('passes through every variable env.ts reads', () => {
    const missing = schemaKeys.filter((k) => !composeEnv.has(k) && !CONTAINER_INTERNAL.has(k));
    expect(missing).toEqual([]);
  });

  it('forwards nothing env.ts does not read', () => {
    // A leftover after a variable is dropped from env.ts (say, STRIPE_*) is
    // dead configuration that still looks like it does something.
    expect([...composeEnv.keys()].filter((k) => !schemaKeys.includes(k))).toEqual([]);
  });

  it('takes each one from .env under its own name', () => {
    const notFromEnv = [...composeEnv.entries()]
      .filter(([k, v]) => !FIXED.has(k) && !v.startsWith('${' + k + ':'))
      .map(([k]) => k);
    expect(notFromEnv).toEqual([]);
  });

  it('does not forward container-internal settings from .env', () => {
    expect([...CONTAINER_INTERNAL].filter((k) => composeEnv.has(k))).toEqual([]);
  });

  it('uses the same defaults as env.ts', () => {
    const drift: string[] = [];
    for (const [key, value] of composeEnv) {
      if (INTENTIONAL_DEFAULTS.has(key)) continue;
      const m = /^\$\{[A-Z0-9_]+:-([^${}]*)\}$/.exec(value);
      if (!m) continue; // required (`:?`) or composite values have no default to compare
      const field = envSchema.shape[key as keyof typeof envSchema.shape];
      if (!field) continue; // not read by env.ts at all — reported by the test above
      const fromCompose = field.safeParse(m[1]);
      const fromCode = field.safeParse(undefined);
      if (!fromCompose.success || !fromCode.success) {
        drift.push(`${key}: compose default ${JSON.stringify(m[1])} does not parse like the env.ts default`);
      } else if (JSON.stringify(fromCompose.data) !== JSON.stringify(fromCode.data)) {
        drift.push(
          `${key}: compose → ${JSON.stringify(fromCompose.data)}, env.ts → ${JSON.stringify(fromCode.data)}`,
        );
      }
    }
    expect(drift).toEqual([]);
  });
});
