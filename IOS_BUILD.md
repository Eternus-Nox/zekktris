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

`apps/web/package.json` still includes `@capacitor/*` packages and the web code
has an optional native-bridge layer (`apps/web/src/lib/native.ts`) that uses
them *when present*. This lets the web bundle run inside a Capacitor wrapper if
one is ever built, but no such wrapper is part of this repository, and it is not
required for the web app (which runs as a normal SPA/PWA) or for the native iOS
app (which shares no code with the web bundle). The desktop client is a separate
**Electron** shell — see [`desktop/`](./desktop).
