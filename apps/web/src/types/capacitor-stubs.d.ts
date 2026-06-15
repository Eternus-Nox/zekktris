/**
 * Ambient module declarations for the Capacitor packages.
 *
 * These let `await import('@capacitor/...')` typecheck WITHOUT the
 * Capacitor packages actually being installed in node_modules.
 * That's important for two reasons:
 *
 *   1. The web typecheck CI shouldn't fail because an iOS-only
 *      dep wasn't installed. Capacitor is in package.json but a
 *      web-only contributor might not run `pnpm install --shamefully-hoist`
 *      to pull native deps they'll never use.
 *
 *   2. The native iOS build will `pnpm install` the real packages,
 *      and TypeScript's resolution prefers actual node_modules
 *      types over ambient declarations. So once the deps are
 *      present, these stubs are silently bypassed — no duplicate-
 *      type conflicts.
 *
 * Each declaration provides just enough surface for `native.ts`
 * to compile (the methods + event types it actually calls). The
 * real Capacitor types are richer; we don't need that here.
 */

declare module '@capacitor/push-notifications' {
  interface PluginListenerHandle {
    remove(): Promise<void>;
  }
  export const PushNotifications: {
    requestPermissions(): Promise<{ receive: 'granted' | 'denied' | 'prompt' }>;
    register(): Promise<void>;
    addListener(
      event: 'registration',
      cb: (token: { value: string }) => void,
    ): Promise<PluginListenerHandle>;
    addListener(
      event: 'pushNotificationReceived',
      cb: (notification: { data?: Record<string, unknown> }) => void,
    ): Promise<PluginListenerHandle>;
    addListener(
      event: 'pushNotificationActionPerformed',
      cb: (action: {
        notification: { data?: Record<string, unknown> };
      }) => void,
    ): Promise<PluginListenerHandle>;
  };
}

declare module '@capacitor/app' {
  interface PluginListenerHandle {
    remove(): Promise<void>;
  }
  export const App: {
    addListener(
      event: 'appStateChange',
      cb: (state: { isActive: boolean }) => void,
    ): Promise<PluginListenerHandle>;
    addListener(
      event: 'appUrlOpen',
      cb: (event: { url: string }) => void,
    ): Promise<PluginListenerHandle>;
    getLaunchUrl(): Promise<{ url: string } | null>;
  };
}

declare module '@capacitor/splash-screen' {
  export const SplashScreen: {
    hide(): Promise<void>;
  };
}

declare module '@capacitor/status-bar' {
  export const Style: { Dark: 'DARK'; Light: 'LIGHT'; Default: 'DEFAULT' };
  export const StatusBar: {
    setStyle(opts: { style: string }): Promise<void>;
    setBackgroundColor(opts: { color: string }): Promise<void>;
  };
}

declare module '@capacitor/cli' {
  export interface CapacitorConfig {
    appId: string;
    appName: string;
    webDir?: string;
    server?: { url?: string; cleartext?: boolean };
    ios?: Record<string, unknown>;
    android?: Record<string, unknown>;
    plugins?: Record<string, unknown>;
  }
}
