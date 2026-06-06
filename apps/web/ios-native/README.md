# iOS native sources (staging)

These are the hand-written native files that aren't part of the
Capacitor-generated iOS project. They live here in the repo so they're
version-controlled; you copy them into the generated `ios/` project
after scaffolding it.

The full walkthrough is in [`/IOS_BUILD.md`](../../../IOS_BUILD.md).

## Files

| File | Purpose | Goes to |
|---|---|---|
| `ZekktrisCalls.swift` | CallKit Capacitor plugin (locked-screen mic + system call UI) | `apps/web/ios/App/App/` |
| `ZekktrisCalls.m` | Obj-C registration shim (`CAP_PLUGIN` macro) | `apps/web/ios/App/App/` |
| `AppDelegate+VoIP.reference.swift` | Reference snippet — voIP/PushKit deltas to merge into the generated `AppDelegate.swift` | merge by hand |

## Quick placement

```bash
cd apps/web
npx cap add ios            # one time — generates ios/

cp ios-native/ZekktrisCalls.swift ios/App/App/
cp ios-native/ZekktrisCalls.m     ios/App/App/
# Then merge the deltas from AppDelegate+VoIP.reference.swift into
# ios/App/App/AppDelegate.swift by hand (don't overwrite the file).

cd ios/App && pod install
```

After that, `npx cap open ios` and build/run from Xcode. The CallKit
plugin (`ZekktrisCalls.swift` + `.m`) is enough for the locked-screen
mic; the `AppDelegate+VoIP` merge is only needed for ringing on a
locked phone via voIP push.
