/**
 * Logger
 * ------
 * Intentionally small. We don't pull in pino or winston for v1 — a few dozen
 * lines of console.log + level filtering is enough. JSON in production (so
 * Loki/Vector/CloudWatch can ingest), pretty in dev.
 *
 * Usage:
 *   import { log } from './log';
 *   log.info('user created', { userId });
 *   log.error('upstream failed', { err });
 */

import { env, isProd, type LogLevel } from './env';

const LEVELS: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
};

const COLORS: Record<LogLevel, string> = {
  trace: '\x1b[90m', // gray
  debug: '\x1b[36m', // cyan
  info: '\x1b[32m', // green
  warn: '\x1b[33m', // yellow
  error: '\x1b[31m', // red
};
const RESET = '\x1b[0m';

const threshold = LEVELS[env.LOG_LEVEL];

interface Fields {
  [k: string]: unknown;
}

/** Replacer that handles BigInt (default JSON.stringify throws on these). */
function jsonReplacer(_key: string, value: unknown): unknown {
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  return value;
}

function format(level: LogLevel, msg: string, fields?: Fields): string {
  const ts = new Date().toISOString();
  if (isProd) {
    return JSON.stringify({ ts, level, msg, ...fields }, jsonReplacer);
  }
  const color = COLORS[level];
  const tail = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields, jsonReplacer) : '';
  return `${ts} ${color}${level.toUpperCase().padEnd(5)}${RESET} ${msg}${tail}`;
}

function emit(level: LogLevel, msg: string, fields?: Fields) {
  if (LEVELS[level] < threshold) return;
  const line = format(level, msg, fields);
  if (level === 'error' || level === 'warn') {
    console.error(line);
  } else {
    console.log(line);
  }
}

export const log = {
  trace: (msg: string, fields?: Fields) => emit('trace', msg, fields),
  debug: (msg: string, fields?: Fields) => emit('debug', msg, fields),
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
  /** Returns a child logger that prepends the given fields to every record. */
  child(extra: Fields) {
    return {
      trace: (msg: string, fields?: Fields) => emit('trace', msg, { ...extra, ...fields }),
      debug: (msg: string, fields?: Fields) => emit('debug', msg, { ...extra, ...fields }),
      info: (msg: string, fields?: Fields) => emit('info', msg, { ...extra, ...fields }),
      warn: (msg: string, fields?: Fields) => emit('warn', msg, { ...extra, ...fields }),
      error: (msg: string, fields?: Fields) => emit('error', msg, { ...extra, ...fields }),
    };
  },
};
