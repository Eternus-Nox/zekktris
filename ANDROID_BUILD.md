# Android build

The Android client is a **Capacitor wrapper around the web app** — the same
thin-shell pattern as the Electron desktop client. The native shell loads the
live web app from the production origin (`server.url` in
[`apps/web/capacitor.config.ts`](./apps/web/capacitor.config.ts)) and adds the
native bits a browser can't do: FCM push, the system notification tray, and
mic/camera access for LiveKit voice. Because it runs the exact same web bundle,
it is **1:1 with the web app by construction** (which in turn mirrors the native
iOS app).

> Why a wrapper here but native on iOS? The Capacitor approach was explored and
> *rejected* for iOS in favour of a from-scratch SwiftUI app (see
> [`IOS_BUILD.md`](./IOS_BUILD.md)). For Android the wrapper **is** the chosen
> approach: it reuses 100% of the web client and ships in a fraction of the time.
> A native Kotlin/Compose rewrite remains an option later.

The native project lives at [`apps/web/android/`](./apps/web/android) (generated
by `npx cap add android`; the source is committed, build artifacts and the
copied web assets are gitignored).

## Prerequisites

- **Android Studio** (bundles a JDK 17 — there is no system `java` on the build
  machine, so the CLI gradle step is expected to defer to Studio).
- **Android SDK** (Android Studio installs it; this machine has it at
  `~/Library/Android/sdk`). Set `ANDROID_HOME` / create
  `apps/web/android/local.properties` with `sdk.dir=…` if building from the CLI.

## Build & run

```bash
pnpm -C apps/web build                    # 1. build the web app → apps/web/dist
pnpm -C apps/web exec cap sync android     # 2. copy dist + plugins into android/
pnpm -C apps/web exec cap open android     # 3. open in Android Studio → Run ▶
```

Re-run 1–2 whenever the web app changes (`sync` re-copies `dist` and refreshes
the plugin list; the app loads the live site via `server.url` at runtime, but
sync keeps the native plugin registry correct). In Studio, let the first Gradle
sync finish, then Run the `app` config on an emulator (UI only — **mic/camera/
voice need a real device**) or a USB-debugging phone. Watch **Logcat** (filter
`com.zekktris.app`) — the WebView's `console.log` and JS errors show up there.

> A friendly, step-by-step walkthrough (install → run → test → troubleshoot)
> lives in the Obsidian vault: **"Android App — Build & Test"**. This file is the
> repo/config reference.

**Common errors:** *SDK location not found* → add `apps/web/android/local.properties`
with `sdk.dir=…`. *google-services.json is missing* → expected without Firebase
(build skips it; push off). *Blank screen / `ERR_CLEARTEXT_NOT_PERMITTED`* →
`server.url` is plain HTTP (set `android.cleartext: true`) or unreachable. *Stale
UI* → re-run `cap sync android`.

**Live reload:** point `server.url` at your Vite dev server
(`http://<lan-ip>:5173`, `cleartext: true`), run `pnpm -C apps/web dev`, then
`cap sync android` + Run. Revert before a release build.

## Pointing at your server

`capacitor.config.ts` `server.url` defaults to `https://zekktris.com`. **Change
it to your deployment before shipping.** The web app talks to a same-origin
`/api/v1` and `wss://<host>/gateway`, so the WebView must be served from that
origin. If you self-host over **plain HTTP**, also set `android.cleartext: true`
in `capacitor.config.ts` (HTTPS is strongly preferred — WebRTC/`getUserMedia`
and Web Push both require a secure origin).

## Push notifications (FCM)

Android push uses **Firebase Cloud Messaging**. Two halves:

1. **Client (this app):**
   - In the [Firebase console](https://console.firebase.google.com/), create a
     project and add an **Android app** with package name `com.zekktris.app`.
   - Download **`google-services.json`** and drop it into
     [`apps/web/android/app/`](./apps/web/android/app). The gradle is already
     wired: `app/build.gradle` applies the `com.google.gms.google-services`
     plugin **only when that file is present**, so the app builds fine without
     it (push just won't register).
   - No client code change is needed — `@capacitor/push-notifications` yields an
     FCM token on Android, and [`useNativePush.ts`](./apps/web/src/app/useNativePush.ts)
     already registers it with the server tagged `platform: 'android'`.

2. **Server (the API):** set the Firebase **service-account** credentials so the
   API can send (Firebase console → Project settings → Service accounts →
   *Generate new private key* → a JSON with these fields):
   - `FCM_PROJECT_ID`
   - `FCM_CLIENT_EMAIL`
   - `FCM_PRIVATE_KEY` (raw PEM, or base64 of it to avoid env-newline issues)

   See [`apps/api/src/services/fcm.ts`](./apps/api/src/services/fcm.ts). Without
   these, an `android` device-token register returns 503 and no pushes are sent.
   Android tokens are stored in the same `device_tokens` table as iOS with
   `platform = 'android'`; the push dispatcher routes them to FCM (and never to
   APNs).

## Permissions

Already declared in
[`AndroidManifest.xml`](./apps/web/android/app/src/main/AndroidManifest.xml):
`INTERNET`, `POST_NOTIFICATIONS` (Android 13+ push prompt), and
`RECORD_AUDIO` / `MODIFY_AUDIO_SETTINGS` / `CAMERA` for LiveKit voice/video in
the WebView. Capacitor's `WebChromeClient` grants the WebView's `getUserMedia`
request from these.

## Release (Play Store)

Release signing is **already wired** in `app/build.gradle`: it reads
`apps/web/android/keystore.properties` and signs the release build with it. That
file (and `*.jks`/`*.keystore`) is gitignored, so keys and passwords never enter
git. When the file is absent the release build falls back to debug signing, so a
fresh clone still builds.

1. Generate an upload keystore:
   ```bash
   keytool -genkey -v -keystore zekktris-upload.jks -keyalg RSA -keysize 2048 -validity 10000 -alias upload
   ```
2. Create `apps/web/android/keystore.properties` (do **not** commit it):
   ```properties
   storeFile=/absolute/path/to/zekktris-upload.jks
   storePassword=your-store-password
   keyAlias=upload
   keyPassword=your-key-password
   ```
3. Build a signed **AAB**: Android Studio → **Build → Generate Signed Bundle /
   APK → Android App Bundle**, or from `apps/web/android`:
   `./gradlew :app:bundleRelease` (output under `app/build/outputs/bundle/release/`).
   Upload to the Play Console (internal → closed → production).
4. Bump `versionCode` / `versionName` in `app/build.gradle` each release.

> With **Play App Signing** (recommended) your upload key signs the AAB and
> Google re-signs with the app key — the SHA-256 fingerprint you'd need for
> HTTPS App Links or FCM comes from the Play Console, not your local keystore.

## Known gaps vs. native iOS (follow-ups)

- **E2EE notification previews:** iOS decrypts E2EE DM previews in a Notification
  Service Extension. Android has no equivalent wired up, so E2EE DM pushes show
  the generic body (same as Web Push) — text is never sent to the server either
  way.
- **System call UI:** iOS uses CallKit/PushKit (lock-screen answer, audio
  persists when locked). Android calls currently ring via FCM + the in-app UI; a
  Telecom `ConnectionService` integration would be the native equivalent. The
  implementation plan lives in the Obsidian vault ("Android Call UI — Plan"): it
  reuses the existing `ZekktrisCalls` web bridge (`apps/web/src/lib/native.ts`)
  and recommends a full-screen-notification MVP before full Telecom.

## Deep links

The `zekktris://` custom scheme is wired (intent-filter in `AndroidManifest.xml`,
matching the iOS scheme). Capacitor's App plugin fires `appUrlOpen`, and the web
app routes the path into the SPA — see `onAppUrlOpen` in
[`lib/native.ts`](./apps/web/src/lib/native.ts) and `navigateToTarget` in
[`useNativePush.ts`](./apps/web/src/app/useNativePush.ts) (path-only navigation,
so a crafted link can't bounce the WebView off-app). Cold-start launch URLs are
replayed once.

**HTTPS App Links** (tapping `https://<your-host>/…` opens the app, not the
browser) are also wired: an `autoVerify` intent-filter for `zekktris.com` is in
the manifest, and the same `navigateToTarget()` routes the path. Two things to
finish on your side:

1. **Change the host** in the manifest's `https` intent-filter (and ideally
   `capacitor.config.ts` `server.url`) to your deployment host.
2. **Host the Digital Asset Links file** at
   `https://<your-host>/.well-known/assetlinks.json` so Android verifies the
   link and opens the app *without* a chooser:
   ```json
   [{
     "relation": ["delegate_permission/common.handle_all_urls"],
     "target": {
       "namespace": "android_app",
       "package_name": "com.zekktris.app",
       "sha256_cert_fingerprints": ["<YOUR_APP_SHA256_FINGERPRINT>"]
     }
   }]
   ```
   Get the SHA-256 from `keytool -list -v -keystore <your.jks> -alias <alias>`,
   or — if you use **Play App Signing** — from Play Console → Setup → App
   integrity (use the *app signing* fingerprint, not just the upload one).

Until the file is served + verified, the link just shows the app in the
"open with" chooser rather than opening automatically.
