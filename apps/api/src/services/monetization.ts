/**
 * Admin-configurable monetization
 * -------------------------------
 * Which supporter tier (if any) unlocks each paid surface. Backed by the
 * instance_settings key/value table so an operator can retune the paywalls at
 * runtime — no redeploy. Absence of a key means "the shipped default", which
 * is exactly today's hardcoded behavior, so an empty table changes nothing.
 *
 * Keys (all text):
 *   monetize.stream.p1080|k2|k4   minimum tier for screen-share 1080p/2K/4K
 *   monetize.camera.p1080|k2|k4   minimum tier for camera 1080p/2K/4K
 *   monetize.appearance           minimum tier for Appearance cosmetics
 *     — each 'none'|'scout'|'guardian'|'legend'; 'none' = free for everyone.
 *   upload.cap_mb.free|scout|guardian|legend
 *     — integer MB per-file upload cap for that tier. Absent/null = the env
 *       MAX_UPLOAD_SIZE_MB default. The env cap is ALWAYS the hard ceiling:
 *       effective cap = min(env, configured).
 *
 * 720p is always free — deliberately not a key.
 *
 * Reads are cached in-memory for 30s (the config is consulted on every
 * message-with-attachment and every cosmetic PATCH); saveConfig invalidates,
 * so the admin panel sees its own writes immediately. Other API nodes
 * converge within the TTL — acceptable for a paywall knob.
 */

import { env } from '../env';
import { getSettings, setSetting } from './instanceSettings';

/** Minimum tier required for a gated surface. 'none' = free. */
export type RequiredTier = 'none' | 'scout' | 'guardian' | 'legend';
/** Tier buckets for the per-file upload cap ('free' = no membership). */
export type CapTier = 'free' | 'scout' | 'guardian' | 'legend';
export type StreamQuality = 'p1080' | 'k2' | 'k4';
export type MonetizedSurface = 'stream' | 'camera';

export interface QualityMatrix {
  p1080: RequiredTier;
  k2: RequiredTier;
  k4: RequiredTier;
}

export interface MonetizationConfig {
  stream: QualityMatrix;
  camera: QualityMatrix;
  appearance: RequiredTier;
  /** null = "no override configured" → env MAX_UPLOAD_SIZE_MB. */
  uploadCapsMb: Record<CapTier, number | null>;
}

/** Shipped defaults — exactly the pre-config hardcoded behavior. */
export const DEFAULTS: MonetizationConfig = {
  stream: { p1080: 'none', k2: 'guardian', k4: 'legend' },
  camera: { p1080: 'none', k2: 'guardian', k4: 'legend' },
  appearance: 'scout', // any membership (founder rows are tier 'scout')
  uploadCapsMb: { free: null, scout: null, guardian: null, legend: null },
};

const TIER_KEYS: RequiredTier[] = ['none', 'scout', 'guardian', 'legend'];
const CAP_TIERS: CapTier[] = ['free', 'scout', 'guardian', 'legend'];
const QUALITIES: StreamQuality[] = ['p1080', 'k2', 'k4'];

const RANK: Record<RequiredTier, number> = { none: 0, scout: 1, guardian: 2, legend: 3 };

/** none=0 scout=1 guardian=2 legend=3; unknown/null (no membership) = 0. */
export function tierRank(tier: string | null | undefined): number {
  return RANK[tier as RequiredTier] ?? 0;
}

/** Does a user at `userRank` clear a surface requiring `required`? */
export function isAllowed(userRank: number, required: RequiredTier): boolean {
  return userRank >= RANK[required];
}

function settingKey(surface: MonetizedSurface, q: StreamQuality): string {
  return `monetize.${surface}.${q}`;
}
function capKey(tier: CapTier): string {
  return `upload.cap_mb.${tier}`;
}

const ALL_KEYS = [
  ...(['stream', 'camera'] as const).flatMap((s) => QUALITIES.map((q) => settingKey(s, q))),
  'monetize.appearance',
  ...CAP_TIERS.map(capKey),
];

function parseTier(raw: string | null, fallback: RequiredTier): RequiredTier {
  return TIER_KEYS.includes(raw as RequiredTier) ? (raw as RequiredTier) : fallback;
}

/** Positive-integer MB or null (absent/garbage → null → env default). */
function parseCapMb(raw: string | null): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

// ── 30s read cache ──────────────────────────────────────────────────────────
let cached: { config: MonetizationConfig; at: number } | null = null;
const CACHE_TTL_MS = 30_000;

/** Test/ops hook: drop the cache so the next read hits the DB. */
export function invalidateCache(): void {
  cached = null;
}

export async function getConfig(): Promise<MonetizationConfig> {
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.config;
  const raw = await getSettings(ALL_KEYS);
  const matrix = (surface: MonetizedSurface): QualityMatrix => ({
    p1080: parseTier(raw[settingKey(surface, 'p1080')] ?? null, DEFAULTS[surface].p1080),
    k2: parseTier(raw[settingKey(surface, 'k2')] ?? null, DEFAULTS[surface].k2),
    k4: parseTier(raw[settingKey(surface, 'k4')] ?? null, DEFAULTS[surface].k4),
  });
  const config: MonetizationConfig = {
    stream: matrix('stream'),
    camera: matrix('camera'),
    appearance: parseTier(raw['monetize.appearance'] ?? null, DEFAULTS.appearance),
    uploadCapsMb: {
      free: parseCapMb(raw[capKey('free')] ?? null),
      scout: parseCapMb(raw[capKey('scout')] ?? null),
      guardian: parseCapMb(raw[capKey('guardian')] ?? null),
      legend: parseCapMb(raw[capKey('legend')] ?? null),
    },
  };
  cached = { config, at: Date.now() };
  return config;
}

/** Partial update shape accepted by saveConfig / PUT /admin/monetization. */
export interface MonetizationConfigPatch {
  stream?: Partial<QualityMatrix>;
  camera?: Partial<QualityMatrix>;
  appearance?: RequiredTier;
  /** null clears a cap back to the env default. */
  uploadCapsMb?: Partial<Record<CapTier, number | null>>;
}

/**
 * Persist a (possibly partial) config. Only the provided leaves are written.
 * Returns the list of settings keys that were written (for the audit trail).
 */
export async function saveConfig(patch: MonetizationConfigPatch): Promise<string[]> {
  const writes: Array<[string, string | null]> = [];
  for (const surface of ['stream', 'camera'] as const) {
    const m = patch[surface];
    if (!m) continue;
    for (const q of QUALITIES) {
      const v = m[q];
      if (v !== undefined) writes.push([settingKey(surface, q), v]);
    }
  }
  if (patch.appearance !== undefined) writes.push(['monetize.appearance', patch.appearance]);
  if (patch.uploadCapsMb) {
    for (const t of CAP_TIERS) {
      const v = patch.uploadCapsMb[t];
      if (v !== undefined) writes.push([capKey(t), v === null ? null : String(v)]);
    }
  }
  for (const [key, value] of writes) await setSetting(key, value);
  invalidateCache();
  return writes.map(([key]) => key);
}

/** Minimum tier required to publish `quality` on `surface` (720p is free and
 *  never reaches this — it has no key). */
export async function requiredTierFor(
  surface: MonetizedSurface,
  quality: StreamQuality,
): Promise<RequiredTier> {
  return (await getConfig())[surface][quality];
}

/**
 * Effective per-file upload cap (MB) for a tier: min(env hard ceiling,
 * configured cap). No configured cap → the env value, unchanged.
 */
export async function uploadCapMbForTier(tier: CapTier): Promise<number> {
  const configured = (await getConfig()).uploadCapsMb[tier];
  return configured === null ? env.MAX_UPLOAD_SIZE_MB : Math.min(env.MAX_UPLOAD_SIZE_MB, configured);
}
