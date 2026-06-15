# iOS build

> **This document is superseded.** It previously described wrapping the web app
> in a **Capacitor** native shell. That approach was explored but **not
> adopted** — no Capacitor iOS project is scaffolded in this repo (there is no
> `apps/web/ios/`), and the steps below would no longer reflect how the app is
> built.

The supported iOS client is a **from-scratch native SwiftUI app**, not a web
wrapper. It lives in [`ios-native/`](./ios-native) and talks directly to the
same REST API and WebSocket gateway, with native LiveKit voice/video,
end-to-end-encrypted DMs and calls, APNs push, and CallKit/PushKit call UI.

**To build the iOS app, see [`ios-native/README.md`](./ios-native/README.md).**
In short:

```bash
brew install xcodegen        # once
cd ios-native
xcodegen generate            # creates Zekktris.xcodeproj from project.yml
open Zekktris.xcodeproj
```

Then set your signing Team in **Signing & Capabilities**, pick a simulator or
device, and Run. Point it at your server by editing `ios-native/Zekktris/Config.swift`.

---

### Note on the web app's Capacitor dependencies

`apps/web/package.json` includes `@capacitor/*` packages and the web code has a
native-bridge layer (`apps/web/src/lib/native.ts`) that uses them *when present*.
This was **rejected for iOS** (which is native SwiftUI), but the same Capacitor
wrapper **is** used for **Android** — see [`ANDROID_BUILD.md`](./ANDROID_BUILD.md)
and the committed native project at `apps/web/android/`. On the web the bridge
no-ops, so the web app still runs as a normal SPA/PWA. The desktop client is a
separate **Electron** shell — see [`desktop/`](./desktop).
