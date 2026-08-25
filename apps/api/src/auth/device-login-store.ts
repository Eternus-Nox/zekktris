/**
 * Device-login store — "approve this login on your phone"
 * -------------------------------------------------------
 * This is the INVERTED quick-login. Compare the two:
 *
 *   quick-login (auth/quick-login-store.ts, DEPRECATED direction)
 *     logged-in device MINTS a code  →  logged-out device REDEEMS it.
 *     The code is the whole credential: anyone who reads it off the screen
 *     owns the account.
 *
 *   device-login (this file)
 *     logged-out device STARTS a request and shows a code  →  the already
 *     logged-in phone scans/types it and EXPLICITLY APPROVES  →  the new
 *     device is logged in. Nothing displayed on screen is sufficient to take
 *     over the account.
 *
 * This is the OAuth 2.0 Device Authorization Grant (RFC 8628) shape, adapted.
 *
 * ── WHY TWO SEPARATE SECRETS ───────────────────────────────────────────────
 * `start` returns TWO values and they are NOT interchangeable:
 *
 *   userCode    SHORT (8 chars, Crockford-style base32, ~40 bits). It is
 *               PRINTED ON THE NEW DEVICE'S SCREEN and encoded in its QR, so
 *               assume every person in the room, every shoulder-surfer and
 *               every camera in the café has it. It can therefore only ever
 *               be used to ASK "what is this pending request?" (lookup) and to
 *               DECIDE it (approve/deny) — both of which require the caller to
 *               already be authenticated as a real user. Knowing a userCode
 *               NEVER yields a session.
 *
 *   deviceCode  LONG (256 bits, base64url). Returned ONLY in the body of the
 *               `start` response, to the device that started the request. It
 *               is never rendered, never in a QR, never logged, and never
 *               returned by any other endpoint. It is the ONLY thing that can
 *               collect the tokens once the request is approved.
 *
 * Collapsing these into one code — i.e. letting the displayed code also
 * redeem — reintroduces the exact bug this design exists to kill: a bystander
 * photographs the QR, polls in the background, and the instant the victim taps
 * "Approve" on their phone the bystander's client (not the victim's) receives
 * the session. The split means the bystander's poll is answered with
 * `expired` forever, because they never had the deviceCode.
 *
 * ── THE ATTACK THIS DESIGN CANNOT FULLY SOLVE: PHISHING ─────────────────────
 * An attacker starts a device-login request on THEIR OWN machine, gets a
 * userCode, and social-engineers the victim into approving it ("support here,
 * read me the code on your screen" / a fake site that shows the attacker's
 * code / a QR sticker slapped over a real one). The victim's phone is
 * genuinely authenticated and genuinely taps Approve — the server sees a
 * perfectly valid approval and hands the ATTACKER a full session on the
 * victim's account.
 *
 * No server-side check can distinguish that from a legitimate approval. The
 * only defence is the approval SCREEN, which is why `lookup` returns device
 * metadata and why it MUST be rendered prominently:
 *   - `ipAddress` and `sameNetwork` are the only SERVER-OBSERVED facts. If
 *     `sameNetwork` is false the UI must say so loudly ("this device is NOT on
 *     your network") because a remote phisher can never fake it.
 *   - `declaredName`, `userAgent` and `platform` are DERIVED FROM THE
 *     REQUESTING DEVICE'S OWN CLAIMS and are attacker-controlled. They are
 *     decoration. An attacker will happily call themselves "Your iPhone".
 * DO NOT "simplify" the approval screen into a bare yes/no dialog. The
 * metadata is the security control.
 *
 * ── STORAGE ────────────────────────────────────────────────────────────────
 * Mirrors quick-login-store.ts: Redis when REDIS_URL is set (so start / poll /
 * approve can land on different api replicas), else an in-memory TTL map.
 * FAIL-CLOSED — Redis errors are deliberately NOT caught anywhere in this
 * file. A store outage must surface as a 500 and issue no session, never as a
 * silent "sure, you're approved". (Consequence, accepted: a command that times
 * out after Redis already applied it burns the request; the user restarts.)
 *
 * The single-use, atomic step is the TERMINAL CLAIM: `SET ... NX` on one key
 * decides approve-vs-deny exactly once, and the polling device consumes it
 * with GETDEL (Redis 6.2+), the same primitive quick-login-store.ts uses.
 *
 * Without REDIS_URL the in-memory path is per-process, so a multi-replica
 * deployment must set REDIS_URL or the approving phone and the polling device
 * will not see the same request. Same caveat as quick-login-store.ts.
 *
 * Nothing in here is ever logged: not the userCode, not the deviceCode.
 */
import Redis from 'ioredis';
import { createHash, randomBytes } from 'node:crypto';
import { env } from '../env';

// req:  sha256(deviceCode) → JSON record (pending metadata)
// uc:   userCode           → sha256(deviceCode)   [lookup/approve index]
// term: sha256(deviceCode) → 'a:<userId>' | 'd'   [one-shot terminal claim]
// poll: sha256(deviceCode) → '<nextAllowedAtMs>:<intervalSeconds>'
const REQ_PREFIX = 'zekktris:devicelogin:req:';
const UC_PREFIX = 'zekktris:devicelogin:uc:';
const TERM_PREFIX = 'zekktris:devicelogin:term:';
const POLL_PREFIX = 'zekktris:devicelogin:poll:';

/**
 * How long a pending request lives: 5 minutes.
 *
 * quick-login's 90s is defensible when one device both mints and displays the
 * code, but here the user has to physically pick up their other device, unlock
 * it, open Zekktris, find the scanner and read a confirmation screen. 90s
 * makes that a race and users will just retry — which is strictly worse,
 * because each retry re-opens a fresh guessable window. 300s is the shortest
 * value that comfortably covers "walk over to your phone", and it is half the
 * 600s RFC 8628 suggests, keeping the ~40-bit userCode's exposure window small
 * (at the 20 lookups/min/user cap, 5 minutes buys an attacker 100 guesses out
 * of ~1.1e12 — about 1 in 1e10).
 */
export const TTL_SECONDS = 300;

/**
 * How long an APPROVED grant waits to be collected: 60s. The new device is
 * polling every 5s, so it collects within one interval; anything longer just
 * widens the window in which a stolen deviceCode is still worth something.
 */
const TERMINAL_TTL_SECONDS = 60;

/** Baseline poll cadence handed to the client and enforced server-side. */
export const BASE_INTERVAL_SECONDS = 5;
/** Each too-fast poll adds this much, up to MAX. Mirrors RFC 8628 slow_down. */
const INTERVAL_STEP_SECONDS = 5;
const MAX_INTERVAL_SECONDS = 30;

/**
 * Crockford base32 minus the confusable letters (no I, L, O, U). 32 symbols,
 * so `byte % 32` is exactly uniform over a random byte — no modulo bias, no
 * rejection sampling needed.
 */
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const USER_CODE_LENGTH = 8;

export type DeviceLoginPlatform = 'ios' | 'android' | 'web' | 'desktop' | 'unknown';

/** The pending request as stored. Contains no secret except the userCode. */
export interface DeviceLoginRequest {
  userCode: string;
  /** Client-supplied device label. UNTRUSTED — see the phishing note above. */
  declaredName: string | null;
  /** UNTRUSTED — the requesting device writes its own User-Agent. */
  userAgent: string | null;
  /** UNTRUSTED — derived from the (client-controlled) User-Agent. */
  platform: DeviceLoginPlatform;
  /** SERVER-OBSERVED. The one field an attacker cannot choose. */
  ipAddress: string | null;
  /** UNTRUSTED — from Accept-Language. A locale hint, not a location. */
  locale: string | null;
  /** epoch ms */
  createdAt: number;
  /** epoch ms */
  expiresAt: number;
}

export interface DeviceLoginStartInput {
  declaredName: string | null;
  userAgent: string | null;
  platform: DeviceLoginPlatform;
  ipAddress: string | null;
  locale: string | null;
}

export interface DeviceLoginStartResult {
  userCode: string;
  deviceCode: string;
  expiresIn: number;
  interval: number;
}

/** Outcome of approve/deny. `already` means someone got there first. */
export type DeviceLoginDecision =
  | { result: 'claimed'; request: DeviceLoginRequest }
  | { result: 'gone' }
  | { result: 'already' };

export type DeviceLoginPollResult =
  | { status: 'pending'; interval: number }
  | { status: 'slow_down'; interval: number }
  | { status: 'approved'; userId: string }
  | { status: 'denied' }
  | { status: 'expired' };

// ── Code generation ─────────────────────────────────────────────────────────

/**
 * The SHORT, human-typable, PUBLICLY-VISIBLE code. Displayed on the new device
 * and encoded in its QR. Deliberately weak-ish (~40 bits) because it is
 * shoulder-surfable by design; it is protected by being useless without an
 * authenticated approver, by the 5-minute TTL, and by the per-user lookup
 * limiter. It must NEVER be accepted as proof of anything on a public route.
 */
export function newUserCode(): string {
  const bytes = randomBytes(USER_CODE_LENGTH);
  let out = '';
  for (let i = 0; i < USER_CODE_LENGTH; i++) {
    out += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length]!;
  }
  return out;
}

/**
 * The LONG, secret code. 256 bits, returned exactly once, to exactly one
 * device, in the `start` response body. This alone redeems the session.
 */
export function newDeviceCode(): string {
  return randomBytes(32).toString('base64url');
}

/**
 * Normalize a user-entered code: uppercase, drop separators/whitespace, and
 * fold the Crockford confusables the alphabet excludes (O→0, I/L→1) so a user
 * who types "OI" gets "01" instead of a mystifying failure.
 */
export function normalizeUserCode(raw: string): string {
  return raw
    .toUpperCase()
    .replace(/[^0-9A-Z]/g, '')
    .replace(/O/g, '0')
    .replace(/[IL]/g, '1');
}

/** Display form: `ABCD-EFGH`. Clients should render this, not the raw string. */
export function formatUserCode(code: string): string {
  if (code.length !== USER_CODE_LENGTH) return code;
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

/** Storage key for a device code. We key on the HASH so a Redis dump, a
    keyspace scan or a slow-log entry never exposes a live device code. */
function hashDeviceCode(deviceCode: string): string {
  return createHash('sha256').update(deviceCode).digest('hex');
}

// ── Device metadata helpers (no third-party calls, no new dependencies) ─────

/**
 * Best-effort platform label from the User-Agent.
 *
 * UNTRUSTED: the requesting device writes its own User-Agent, so this is a
 * convenience label for the approval screen, never a security decision.
 * Order matters — Electron's UA also contains "Chrome", and Android's also
 * contains "Linux".
 */
export function guessPlatform(userAgent: string | null): DeviceLoginPlatform {
  if (!userAgent) return 'unknown';
  const ua = userAgent.toLowerCase();
  if (ua.includes('electron')) return 'desktop';
  if (ua.includes('android')) return 'android';
  if (
    ua.includes('iphone') ||
    ua.includes('ipad') ||
    ua.includes('ipod') ||
    ua.includes('cfnetwork')
  ) {
    return 'ios';
  }
  if (
    ua.includes('mozilla') ||
    ua.includes('chrome') ||
    ua.includes('safari') ||
    ua.includes('firefox')
  ) {
    return 'web';
  }
  return 'unknown';
}

/**
 * A client-supplied device label ("Pixel 9", "Chrome on Windows"), hard-
 * sanitized because it is rendered inside a security dialog: strip anything
 * outside printable ASCII (kills control chars, RTL overrides and homoglyph
 * tricks that could forge a trustworthy-looking label), collapse whitespace,
 * cap at 48 chars. Returns null when nothing usable survives.
 */
export function sanitizeDeviceName(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const cleaned = raw
    .replace(/[^\x20-\x7E]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);
  return cleaned || null;
}

/**
 * First tag off Accept-Language, e.g. "en-GB". A LOCALE hint only.
 *
 * NOTE ON LOCATION: we do not return a city/region/country. Deriving one from
 * an IP requires a GeoIP dataset (MaxMind/DB-IP) or a third-party lookup
 * service, and this pass adds neither a dependency nor an outbound call — so
 * `approxLocation` is always null rather than fabricated. If a real coarse
 * location is wanted later, ship a local GeoIP database and fill that field;
 * the contract already has the slot.
 */
export function parseLocale(acceptLanguage: string | null | undefined): string | null {
  if (!acceptLanguage) return null;
  const first = acceptLanguage.split(',')[0]?.split(';')[0]?.trim() ?? '';
  if (!first || first.length > 35) return null;
  return /^[A-Za-z]{1,8}(-[A-Za-z0-9]{1,8})*$/.test(first) ? first : null;
}

/** Expand an IPv6 address to 8 lowercase hextets, or null if unparseable. */
function expandIpv6(raw: string): string[] | null {
  let s = raw.trim().toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  if (!s.includes(':')) return null;
  // Trailing dotted-quad form (::ffff:1.2.3.4) → two hextets.
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4) {
    const octets = v4[1]!.split('.').map(Number);
    if (octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    s = `${s.slice(0, v4.index)}${hi}:${lo}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const tail = halves.length === 2 ? (halves[1] ? halves[1].split(':') : []) : [];
  if (halves.length === 1 && head.length !== 8) return null;
  const fill = 8 - head.length - tail.length;
  if (fill < 0) return null;
  const parts = [...head, ...Array<string>(fill).fill('0'), ...tail];
  if (parts.length !== 8) return null;
  for (const p of parts) if (!/^[0-9a-f]{1,4}$/.test(p)) return null;
  return parts.map((p) => p.padStart(4, '0'));
}

/**
 * True when the two IPs look like the same local network — same IPv4 /24 or
 * same IPv6 /48.
 *
 * This is the ONE metadata signal on the approval screen an attacker cannot
 * forge: a remote phisher's request will never share the victim's NAT. It is a
 * hint, not proof (carrier-grade NAT can group strangers; a phone on cellular
 * while the laptop is on Wi-Fi is a legitimate false negative), so the UI must
 * phrase it as a hint. Never gate approval on it server-side.
 */
export function sameNetwork(a: string | null, b: string | null): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const v4 = /^\d{1,3}(\.\d{1,3}){3}$/;
  if (v4.test(a) && v4.test(b)) {
    return a.split('.').slice(0, 3).join('.') === b.split('.').slice(0, 3).join('.');
  }
  const ea = expandIpv6(a);
  const eb = expandIpv6(b);
  if (ea && eb) return ea.slice(0, 3).join(':') === eb.slice(0, 3).join(':');
  return false;
}

// ── Store ───────────────────────────────────────────────────────────────────

interface DeviceLoginStore {
  /** Create a pending request. Returns both secrets; only the caller sees the
      deviceCode. */
  start(input: DeviceLoginStartInput): Promise<DeviceLoginStartResult>;
  /** Read a pending request by its PUBLIC code. Never returns the deviceCode
      (the store doesn't hold it — only its hash). */
  findByUserCode(userCode: string): Promise<DeviceLoginRequest | null>;
  /** Atomically make the request terminal. First caller wins. */
  decide(userCode: string, userId: string | null): Promise<DeviceLoginDecision>;
  /** The new device asks for its outcome, presenting the deviceCode. The
      approved branch is single-use. */
  poll(deviceCode: string): Promise<DeviceLoginPollResult>;
}

function nextIntervalFor(current: number): number {
  return Math.min(current + INTERVAL_STEP_SECONDS, MAX_INTERVAL_SECONDS);
}

class MemoryDeviceLoginStore implements DeviceLoginStore {
  private readonly byHash = new Map<string, DeviceLoginRequest>();
  private readonly byUserCode = new Map<string, string>(); // userCode → hash
  private readonly terminal = new Map<string, { value: string; exp: number }>();
  private readonly throttle = new Map<string, { nextAt: number; interval: number; exp: number }>();

  private sweep(now: number): void {
    for (const [h, r] of this.byHash) {
      if (r.expiresAt <= now) this.byHash.delete(h);
    }
    for (const [k, v] of this.terminal) if (v.exp <= now) this.terminal.delete(k);
    for (const [k, v] of this.throttle) if (v.exp <= now) this.throttle.delete(k);
    // The userCode → hash mapping deliberately OUTLIVES the pending request:
    // decide() keeps it so a second decision can be told `already` instead of
    // `gone` (see there). It is therefore dropped only once both the pending
    // record and the terminal record are gone — the memory equivalent of
    // Redis's UC key TTL.
    for (const [code, h] of this.byUserCode) {
      if (!this.byHash.has(h) && !this.terminal.has(h)) this.byUserCode.delete(code);
    }
  }

  async start(input: DeviceLoginStartInput): Promise<DeviceLoginStartResult> {
    const now = Date.now();
    if (this.byHash.size + this.terminal.size + this.byUserCode.size > 500) this.sweep(now);
    // Two live requests must never share a userCode — the approving user would
    // otherwise be shown one device's metadata and log in a different one.
    // Single-threaded JS with no await between check and set makes this atomic.
    let userCode = '';
    for (let i = 0; i < 6; i++) {
      const candidate = newUserCode();
      const existing = this.byUserCode.get(candidate);
      const rec = existing ? this.byHash.get(existing) : undefined;
      // A code is free only when it has neither a live request NOR a live
      // terminal record. Re-issuing one that is merely decided would let a
      // stale second decision land on the new request. (Redis gets this from
      // its SET NX against a UC key that outlives the decision.)
      const term = existing ? this.terminal.get(existing) : undefined;
      if ((!rec || rec.expiresAt <= now) && !(term && term.exp > now)) {
        userCode = candidate;
        break;
      }
    }
    if (!userCode) throw new Error('device-login: could not allocate a unique user code');
    const deviceCode = newDeviceCode();
    const hash = hashDeviceCode(deviceCode);
    const request: DeviceLoginRequest = {
      userCode,
      declaredName: input.declaredName,
      userAgent: input.userAgent,
      platform: input.platform,
      ipAddress: input.ipAddress,
      locale: input.locale,
      createdAt: now,
      expiresAt: now + TTL_SECONDS * 1000,
    };
    this.byHash.set(hash, request);
    this.byUserCode.set(userCode, hash);
    return {
      userCode,
      deviceCode,
      expiresIn: TTL_SECONDS,
      interval: BASE_INTERVAL_SECONDS,
    };
  }

  async findByUserCode(userCode: string): Promise<DeviceLoginRequest | null> {
    const hash = this.byUserCode.get(userCode);
    if (!hash) return null;
    const rec = this.byHash.get(hash);
    if (!rec || rec.expiresAt <= Date.now()) return null;
    return rec;
  }

  async decide(userCode: string, userId: string | null): Promise<DeviceLoginDecision> {
    const hash = this.byUserCode.get(userCode);
    if (!hash) return { result: 'gone' };
    const now = Date.now();
    // TERMINAL FIRST, and before the pending record is consulted. Once a
    // decision exists the honest answer to a second one is "already answered"
    // (409), not "no such request" (404) — the approver did answer, and both
    // backends must tell them the same thing. This check used to be
    // unreachable because the branch below deleted the userCode mapping.
    const prior = this.terminal.get(hash);
    if (prior && prior.exp > now) return { result: 'already' };
    const rec = this.byHash.get(hash);
    if (!rec || rec.expiresAt <= now) return { result: 'gone' };
    this.terminal.set(hash, {
      value: userId === null ? 'd' : `a:${userId}`,
      exp: now + TERMINAL_TTL_SECONDS * 1000,
    });
    // Drop the pending state so the code can't be looked up or decided twice.
    // The userCode → hash mapping STAYS until the terminal record expires, so
    // the check above can fire; findByUserCode still misses (it reads byHash),
    // and start() treats a mapping with no live request as free, so a retained
    // mapping can neither leak a decided request nor block code allocation.
    this.byHash.delete(hash);
    return { result: 'claimed', request: rec };
  }

  async poll(deviceCode: string): Promise<DeviceLoginPollResult> {
    const hash = hashDeviceCode(deviceCode);
    const now = Date.now();
    // Terminal first: an approved device must get its session even if it has
    // been polling too eagerly.
    const term = this.terminal.get(hash);
    if (term) {
      this.terminal.delete(hash); // single-use
      this.throttle.delete(hash);
      if (term.exp <= now) return { status: 'expired' };
      return term.value === 'd'
        ? { status: 'denied' }
        : { status: 'approved', userId: term.value.slice(2) };
    }
    const rec = this.byHash.get(hash);
    if (!rec || rec.expiresAt <= now) return { status: 'expired' };
    const t = this.throttle.get(hash);
    if (t && t.exp > now && now < t.nextAt) {
      const interval = nextIntervalFor(t.interval);
      this.throttle.set(hash, { nextAt: now + interval * 1000, interval, exp: rec.expiresAt });
      return { status: 'slow_down', interval };
    }
    const interval = t && t.exp > now ? t.interval : BASE_INTERVAL_SECONDS;
    this.throttle.set(hash, { nextAt: now + interval * 1000, interval, exp: rec.expiresAt });
    return { status: 'pending', interval };
  }
}

class RedisDeviceLoginStore implements DeviceLoginStore {
  constructor(private readonly redis: Redis) {}

  async start(input: DeviceLoginStartInput): Promise<DeviceLoginStartResult> {
    const deviceCode = newDeviceCode();
    const hash = hashDeviceCode(deviceCode);
    const now = Date.now();
    // SET ... NX claims the userCode atomically, so two concurrent starts can
    // never share one (which would let an approver see device A's metadata and
    // log in device B). Retry on the astronomically rare clash.
    let userCode = '';
    for (let i = 0; i < 6; i++) {
      const candidate = newUserCode();
      const ok = await this.redis.set(UC_PREFIX + candidate, hash, 'EX', TTL_SECONDS, 'NX');
      if (ok) {
        userCode = candidate;
        break;
      }
    }
    if (!userCode) throw new Error('device-login: could not allocate a unique user code');
    const request: DeviceLoginRequest = {
      userCode,
      declaredName: input.declaredName,
      userAgent: input.userAgent,
      platform: input.platform,
      ipAddress: input.ipAddress,
      locale: input.locale,
      createdAt: now,
      expiresAt: now + TTL_SECONDS * 1000,
    };
    await this.redis.set(REQ_PREFIX + hash, JSON.stringify(request), 'EX', TTL_SECONDS);
    return {
      userCode,
      deviceCode,
      expiresIn: TTL_SECONDS,
      interval: BASE_INTERVAL_SECONDS,
    };
  }

  private async readRequest(hash: string): Promise<DeviceLoginRequest | null> {
    const raw = await this.redis.get(REQ_PREFIX + hash);
    if (!raw) return null;
    // A malformed record is treated as absent — never as a valid request.
    try {
      const parsed = JSON.parse(raw) as DeviceLoginRequest;
      if (!parsed || typeof parsed.userCode !== 'string') return null;
      if (parsed.expiresAt <= Date.now()) return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async findByUserCode(userCode: string): Promise<DeviceLoginRequest | null> {
    const hash = await this.redis.get(UC_PREFIX + userCode);
    if (!hash) return null;
    return this.readRequest(hash);
  }

  async decide(userCode: string, userId: string | null): Promise<DeviceLoginDecision> {
    const hash = await this.redis.get(UC_PREFIX + userCode);
    if (!hash) return { result: 'gone' };
    const request = await this.readRequest(hash);
    if (!request) {
      // No pending record. Distinguish "already answered" from "never existed
      // / expired" the same way the memory backend does, so the approver gets
      // the same 409-vs-404 either side of a Redis outage. Only a decision
      // writes TERM, so its presence is proof one was made.
      const term = await this.redis.get(TERM_PREFIX + hash);
      return term ? { result: 'already' } : { result: 'gone' };
    }
    // THE atomic step: exactly one caller may make this request terminal. If
    // two approvals (or an approve and a deny) race, NX picks one winner and
    // the loser is told `already` — there is never a second grant to steal.
    const value = userId === null ? 'd' : `a:${userId}`;
    const ok = await this.redis.set(
      TERM_PREFIX + hash,
      value,
      'EX',
      TERMINAL_TTL_SECONDS,
      'NX',
    );
    if (!ok) return { result: 'already' };
    // The REQUEST goes (so it can never be looked up or granted again); the
    // userCode → hash mapping stays on its own TTL so the branch above can
    // answer `already`. Keeping it leaks nothing — findByUserCode reads the
    // request, which is gone — and start()'s SET NX simply skips a code that
    // is still mapped.
    await this.redis.del(REQ_PREFIX + hash);
    return { result: 'claimed', request };
  }

  async poll(deviceCode: string): Promise<DeviceLoginPollResult> {
    const hash = hashDeviceCode(deviceCode);
    // GETDEL is the atomic single-use read (Redis 6.2+), same primitive as
    // quick-login-store.consume. Checked FIRST so an approved device still
    // collects its session even if it polled too fast.
    const term = (await this.redis.getdel(TERM_PREFIX + hash)) ?? null;
    if (term) {
      await this.redis.del(POLL_PREFIX + hash);
      return term === 'd'
        ? { status: 'denied' }
        : { status: 'approved', userId: term.slice(2) };
    }
    const rec = await this.readRequest(hash);
    if (!rec) return { status: 'expired' };
    const now = Date.now();
    const ttl = Math.max(1, Math.ceil((rec.expiresAt - now) / 1000));
    const rawThrottle = await this.redis.get(POLL_PREFIX + hash);
    let interval = BASE_INTERVAL_SECONDS;
    let tooFast = false;
    if (rawThrottle) {
      const [nextAtStr, intervalStr] = rawThrottle.split(':');
      const nextAt = Number(nextAtStr);
      const stored = Number(intervalStr);
      if (Number.isFinite(stored) && stored > 0) interval = stored;
      if (Number.isFinite(nextAt) && now < nextAt) {
        tooFast = true;
        interval = nextIntervalFor(interval);
      }
    }
    await this.redis.set(
      POLL_PREFIX + hash,
      `${now + interval * 1000}:${interval}`,
      'EX',
      ttl,
    );
    return tooFast ? { status: 'slow_down', interval } : { status: 'pending', interval };
  }
}

let store: DeviceLoginStore;
if (env.REDIS_URL) {
  const redis = new Redis(env.REDIS_URL, {
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    commandTimeout: 1000,
  });
  redis.on('error', () => {});
  store = new RedisDeviceLoginStore(redis);
} else {
  store = new MemoryDeviceLoginStore();
}

export const deviceLoginStore = store;
