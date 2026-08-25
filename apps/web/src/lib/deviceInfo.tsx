/**
 * Device presentation helpers
 * ---------------------------
 * Turning a User-Agent into something a human can recognise. Shared by the
 * active-sessions list (Settings → Security) and by both halves of the
 * device-approval login flow.
 *
 * EVERYTHING HERE IS COSMETIC. A User-Agent is whatever the client chose to
 * send; none of these labels are evidence of anything. The approval screen in
 * particular must present them as claims, never as verified facts — see
 * apps/api/src/auth/device-login-store.ts for the phishing case that rule
 * exists for.
 */

import { Smartphone, Monitor, Globe } from './icons';
import type { DeviceLoginPlatform } from '@zekktris/client';

/**
 * Best-effort device label from a User-Agent. Mirrors iOS's deviceLabel
 * (MainView.swift). Ordered most-specific-first: Chrome UAs also contain
 * "Safari" and Edge contains "Chrome", so a lookup in arbitrary order would
 * mislabel — the distinctive token has to be checked first.
 */
export function deviceLabel(ua: string | null): string {
  if (!ua) return 'Unknown device';
  if (ua.includes('Zekktris')) return 'Zekktris (app)';
  const browser = (
    [
      ['Edg', 'Edge'],
      ['OPR', 'Opera'],
      ['Firefox', 'Firefox'],
      ['Chrome', 'Chrome'],
      ['Safari', 'Safari'],
    ] as const
  ).find(([token]) => ua.includes(token))?.[1];
  const os = (
    [
      ['iPhone', 'iPhone'],
      ['iPad', 'iPad'],
      ['Mac OS X', 'macOS'],
      ['Macintosh', 'macOS'],
      ['Windows', 'Windows'],
      ['Android', 'Android'],
      ['Linux', 'Linux'],
    ] as const
  ).find(([token]) => ua.includes(token))?.[1];
  if (browser && os) return `${browser} on ${os}`;
  return browser ?? os ?? ua.slice(0, 40);
}

/** Device glyph for a User-Agent. Mirrors iOS's deviceIcon. */
export function DeviceIcon({ ua, className }: { ua: string | null; className?: string }) {
  if (ua && (ua.includes('Zekktris') || ua.includes('iPhone') || ua.includes('Android'))) {
    return <Smartphone size={16} className={className} />;
  }
  if (
    ua &&
    (ua.includes('iPad') ||
      ua.includes('Macintosh') ||
      ua.includes('Mac OS X') ||
      ua.includes('Windows') ||
      ua.includes('Linux'))
  ) {
    return <Monitor size={16} className={className} />;
  }
  return <Globe size={16} className={className} />;
}

/** Display name for the server's UA-derived platform guess. Also client-
    controlled — the server derives it from the same untrusted header. */
export function platformLabel(platform: DeviceLoginPlatform): string {
  switch (platform) {
    case 'ios':
      return 'iPhone / iPad';
    case 'android':
      return 'Android';
    case 'web':
      return 'Web browser';
    case 'desktop':
      return 'Desktop app';
    default:
      return 'Unknown';
  }
}

/**
 * A label for THIS browser, sent as `deviceName` when opening a device-login
 * request so the approving phone sees something friendlier than a raw UA.
 *
 * It is a courtesy for the honest case only: the server marks it UNTRUSTED and
 * hard-sanitizes it, because an attacker's device would simply claim to be
 * whatever the victim expects to see.
 */
export function localDeviceLabel(): string | undefined {
  if (typeof navigator === 'undefined') return undefined;
  const label = deviceLabel(navigator.userAgent || null);
  return label === 'Unknown device' ? undefined : label;
}
