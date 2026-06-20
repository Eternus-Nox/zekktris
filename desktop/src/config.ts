/**
 * Persistent config for the desktop shell.
 *
 * Stored as plain JSON in Electron's per-user data directory
 * (app.getPath('userData')). Currently just window geometry — the
 * server URL is fixed (zekktris.com), so there's nothing to configure.
 */

import { app } from 'electron';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface WindowBounds {
  x?: number;
  y?: number;
  width: number;
  height: number;
}

interface DesktopConfig {
  windowBounds?: WindowBounds;
  /** When true (default), closing the window hides it to the tray
      instead of quitting. */
  closeToTray?: boolean;
  /** When true, the app launches automatically on system login. */
  openAtLogin?: boolean;
  /** Persisted UI zoom level (Electron zoom level, not a percentage;
      0 = 100%, each step ≈ 20%). */
  zoomLevel?: number;
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1280, height: 800 };

function configPath(): string {
  return join(app.getPath('userData'), 'zekktris-desktop.json');
}

let cache: DesktopConfig | null = null;

function loadConfig(): DesktopConfig {
  if (cache) return cache;
  try {
    const raw = readFileSync(configPath(), 'utf8');
    cache = JSON.parse(raw) as DesktopConfig;
  } catch {
    cache = {};
  }
  return cache;
}

function persist(): void {
  if (!cache) return;
  const p = configPath();
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(cache, null, 2), 'utf8');
}

export function getWindowBounds(): WindowBounds {
  return loadConfig().windowBounds ?? DEFAULT_BOUNDS;
}

export function saveWindowBounds(bounds: WindowBounds): void {
  loadConfig().windowBounds = bounds;
  persist();
}

/** Whether closing the window hides to tray (true) or quits (false).
    Defaults to true. */
export function getCloseToTray(): boolean {
  return loadConfig().closeToTray ?? true;
}

export function setCloseToTray(v: boolean): void {
  loadConfig().closeToTray = v;
  persist();
}

/** Whether the app launches on system login. Defaults to false. */
export function getOpenAtLogin(): boolean {
  return loadConfig().openAtLogin ?? false;
}

export function setOpenAtLogin(v: boolean): void {
  loadConfig().openAtLogin = v;
  persist();
}

/** Persisted UI zoom level (0 = 100%). */
export function getZoomLevel(): number {
  return loadConfig().zoomLevel ?? 0;
}

export function setZoomLevel(v: number): void {
  loadConfig().zoomLevel = v;
  persist();
}
