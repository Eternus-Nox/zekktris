# iOS Native Shell — Build Guide

This wraps the web app in a Capacitor native shell so iOS can:

1. Hold the mic open when the screen locks during voice calls (CallKit)
2. Receive real APNs push notifications (not just web push)
3. Present the system "swipe to answer" call UI on locked screens (CallKit + voIP push)

Most of this is one-time setup. After the initial scaffold, ongoing development is:
`pnpm build && npx cap sync ios && npx cap open ios` → press Run in Xcode.

---

## Prerequisites

- **Mac** on a macOS version current enough to run Xcode 26 (check Apple's Xcode system requirements)
- **Xcode 26+** from the Mac App Store. As of **April 28, 2026**, App Store Connect rejects any upload not built with **Xcode 26 and the iOS 26 SDK** — so this is the floor for shipping, not just a recommendation.
- **CocoaPods** installed: `sudo gem install cocoapods` or `brew install cocoapods`. Required because we scaffold the iOS project with CocoaPods (see the scaffold step) — Capacitor 8 otherwise defaults to Swift Package Manager, which the CallKit plugin steps below don't assume.
- **Apple Developer account** ($99/year) — required for TestFlight + push certificates. You can sideload to your *own* device for 7-day testing without it.
- **Node 22+** and **pnpm 9+** — Capacitor 8 requires Node 22. The rest of the project already uses these.

> **Capacitor version:** this repo is on **Capacitor 8** (`apps/web/package.json`). If you're returning to an older checkout still on Capacitor 6/7, run `pnpm i -D @capacitor/cli@latest && npx cap migrate` first, then the scaffold below.

## One-time scaffold

From a fresh checkout, after installing dependencies:

```bash
cd apps/web
pnpm install

# Build the web app — Capacitor needs the dist/ output before
# the iOS project can be scaffolded.
pnpm build

# Scaffold the native iOS project. This creates apps/web/ios/
# with an Xcode project and CocoaPods config. Run this only ONCE
# per checkout; subsequent syncs use the existing project.
#
# --packagemanager CocoaPods is required on Capacitor 8: it defaults
# to Swift Package Manager for new iOS projects, but the ZekktrisCalls
# plugin steps below (pod install + the .m registration shim) assume a
# CocoaPods project.
npx cap add ios --packagemanager CocoaPods

# Open the project in Xcode.
npx cap open ios
```

In Xcode:

1. **Signing & Capabilities** tab on the App target
   - Sign in with your Apple Developer account under Xcode → Settings → Accounts
   - Set Team to your developer team
   - Bundle Identifier defaults to `com.zekktris.app` — change to your reverse-DNS in `capacitor.config.ts` BEFORE running `cap sync` again
2. **Add capabilities** (the `+ Capability` button):
   - **Push Notifications** — for APNs delivery of messages, mentions, friend requests
   - **Background Modes** — check **Audio, AirPlay, and Picture in Picture** (keep voice alive in background), **Voice over IP** (for CallKit) and **Remote notifications**
3. **Info.plist — privacy usage strings (REQUIRED for voice/video).**

   ⚠️ The microphone key is not optional and not cosmetic. If
   `NSMicrophoneUsageDescription` is missing from the built app's
   Info.plist, iOS forbids the app from capturing audio, and WKWebView
   responds by **hiding `navigator.mediaDevices` entirely** — so voice
   fails with "mediaDevices undefined" and the app shows **no Microphone
   toggle** under Settings → Zekktris. (The site will still work in
   mobile Safari, because Safari has its own microphone entitlement —
   that is NOT proof the app is configured.)

   Add these four keys to the **App target's** Info. Two equivalent ways:

   **A. Xcode UI:** select the **App** target → **Info** tab → under
   "Custom iOS Target Properties" hover a row and click **+**, then add
   each key (Xcode shows the friendly name in parentheses):
   - `NSMicrophoneUsageDescription` ("Privacy - Microphone Usage Description")
     → "Zekktris uses the microphone for voice calls."
   - `NSCameraUsageDescription` ("Privacy - Camera Usage Description")
     → "Zekktris uses the camera for video calls and avatar uploads."
   - `NSPhotoLibraryUsageDescription` ("Privacy - Photo Library Usage Description")
     → "Zekktris needs photo access to attach images to messages."
   - `NSUserNotificationsUsageDescription` ("Privacy - User Notifications Usage Description")
     → "Zekktris notifies you about new messages and calls."

   **B. Edit the file directly:** open `ios/App/App/Info.plist` and paste
   inside the top-level `<dict>`:
   ```xml
   <key>NSMicrophoneUsageDescription</key>
   <string>Zekktris uses the microphone for voice calls.</string>
   <key>NSCameraUsageDescription</key>
   <string>Zekktris uses the camera for video calls and avatar uploads.</string>
   <key>NSPhotoLibraryUsageDescription</key>
   <string>Zekktris needs photo access to attach images to messages.</string>
   <key>NSUserNotificationsUsageDescription</key>
   <string>Zekktris notifies you about new messages and calls.</string>
   ```

   `Info.plist` is part of the native project and is **not** overwritten
   by `npx cap sync`, so once added the keys persist across rebuilds.

   **Then rebuild and verify (don't skip):**
   - Build & run on the device from Xcode (a plain `cap sync` is not
     enough — the app binary must be rebuilt).
   - Join a voice channel. iOS should now prompt
     "Zekktris would like to access the Microphone." Tap **Allow**.
   - Confirm Settings → **Zekktris** now shows a **Microphone** toggle
     that's ON. If that toggle exists, `navigator.mediaDevices` is
     exposed and voice works. If it's still missing, the key didn't land
     in the build — re-check you edited the **App** target (not a
     plugin/Pods target) and that `ios/App/App/Info.plist` actually
     contains the key.

4. **App icon (home-screen icon).** A fresh Capacitor project ships a
   blank placeholder, and the icon lives in the generated `ios/` project
   (not in this repo), so it can't ride along in source — you install it
   once. If the icon "still won't show," it's almost always one of three
   things below; do them in order.

   **4a. Install the icon — foolproof drop-in (recommended).** This repo
   ships a complete, ready-made icon set at
   `apps/web/ios-icons/AppIcon.appiconset/` (a `Contents.json` + every
   required PNG size — iPhone, iPad, and the 1024 App Store icon).
   Replace the project's icon set with it wholesale.

   ⚠️ **Path matters.** The generated iOS project lives at
   `apps/web/ios/` (because `capacitor.config.ts` is in `apps/web`), so
   the catalog is at `apps/web/ios/App/App/Assets.xcassets/`. Run these
   from the **repo root** so both paths resolve correctly — do NOT `cd`
   into `apps/web` first, or the relative paths won't line up:
   ```sh
   # from the repo root (the folder containing apps/, packages/, …):
   rm -rf apps/web/ios/App/App/Assets.xcassets/AppIcon.appiconset
   cp -R apps/web/ios-icons/AppIcon.appiconset \
         apps/web/ios/App/App/Assets.xcassets/AppIcon.appiconset
   ```
   (Equivalently, in Xcode drag the `AppIcon.appiconset` folder into
   `Assets.xcassets`, replacing the existing one.) Then **Product → Clean
   Build Folder** (⇧⌘K) and rebuild.

   If the build errors with *"None of the input catalogs contained a
   matching … app icon set … named AppIcon"*, the catalog has no
   `AppIcon.appiconset` — re-run the two commands above (correct paths,
   from the repo root) and confirm
   `apps/web/ios/App/App/Assets.xcassets/AppIcon.appiconset/Contents.json`
   exists afterward.

   Then in Xcode open **Assets.xcassets → AppIcon** and confirm you
   actually see the purple "Z" in the preview (not an empty square).

   **4b. Clear the icon cache — the most common reason it "still won't
   show."** iOS caches the home-screen icon hard; a rebuild over the top
   often keeps showing the old/blank one. After installing the icon:
   - **Delete the app from the device**, then
   - **restart the iPhone** (this clears SpringBoard's icon cache — the
     step people skip), then
   - build & run again from Xcode.

   **4c. Rule out an alternate-icon conflict in Info.plist.** If you ever
   followed `apps/web/ios-icons/README.md` to set up the per-theme
   *alternate* icons, an incomplete `CFBundleIcons` block will **blank the
   primary icon**: e.g. a `CFBundlePrimaryIcon` whose `CFBundleIconFiles`
   names a loose file that isn't in the bundle, or the app switching to a
   theme alternate on launch whose PNGs were never added. Two checks:
   - In `ios/App/App/Info.plist`, if there's a `CFBundleIcons` key and you
     are NOT actually using alternate icons, **remove that whole block**
     and let the asset-catalog `AppIcon` be the icon.
   - The app calls the alternate-icon switch on launch only if the
     `@capacitor-community/app-icon` plugin is installed. If you installed
     it but didn't finish the Info.plist + PNG wiring, either finish it
     per that README or `pnpm remove @capacitor-community/app-icon` and
     `npx cap sync ios` so the launch-time switch can't blank the icon.

5. **Splash screen — make it disappear (navy/no-op) or brand it.** iOS
   requires *a* launch screen, so you can't truly have none — but you can
   make it a plain navy screen that matches the app, so it reads as "no
   splash": a brief navy flash that blends straight into the app (whose
   WebView background is also `#050a18`). No logo, no wrong image.

   **5a. Default chosen here — seamless navy (no splash).** This repo
   ships a background-only launch screen at
   `apps/web/ios-launch/LaunchScreen.storyboard`. Install it over the
   generated one (run from the **repo root**):
   ```sh
   cp apps/web/ios-launch/LaunchScreen.storyboard \
      apps/web/ios/App/App/Base.lproj/LaunchScreen.storyboard
   ```
   Then **Product → Clean Build Folder** (⇧⌘K) and rebuild. Combined with
   the short `launchShowDuration` in `capacitor.config.ts` and the navy
   WebView background, launch → load → app is one continuous navy with no
   logo and no white flash.

   **5b. Alternative — show the branded "Z" splash instead.** If you DO
   want a splash with the app mark, skip 5a and generate it from
   `apps/web/assets/splash.png`:
   ```sh
   cd apps/web
   npx @capacitor/assets generate --ios
   npx cap sync ios
   ```
   That writes a proper branded splash (and the icon) into the iOS
   project. Don't also apply 5a if you go this route — 5a's blank
   storyboard would override the generated splash image.

   **Keyboard behavior — already wired, no Xcode steps.** The keyboard no
   longer drags the app down on dismiss, and the guild rail's bottom
   buttons hide while the keyboard is open so they don't float up over it.
   That's all in the bundled web code; just `npx cap sync ios`.

### Server URL (required)

This app is a **thin shell** that loads the live web app from your
production origin — the same model as the desktop app. `server.url` in
`capacitor.config.ts` must point at your deployment:

```ts
server: { url: 'https://zekktris.com' },   // ← your origin
```

This is not optional: the web app calls a relative `/api/v1` and a
same-origin gateway (`wss://<host>/gateway`), so the WebView has to be
served from that origin. Bundling the local `dist`
(`capacitor://localhost`) would point those calls at the wrong place and
nothing would connect. The upside: **shipping web changes is just a
normal web deploy** — you only rebuild the iOS app for native/config/icon
changes.

## Daily development

```bash
# After making web changes
cd apps/web
pnpm build
npx cap sync ios

# Then in Xcode, press Run (Cmd+R) to build + install to simulator
# or a connected device.
```

For HMR-style iteration without rebuilding the bundle each time:

1. In `capacitor.config.ts`, temporarily change `server.url` to your Mac's LAN IP and the Vite dev port, and add `cleartext: true`:
   ```ts
   server: { url: 'http://192.168.1.10:5173', cleartext: true },
   ```
2. Run `pnpm dev` in `apps/web` separately (host on `0.0.0.0` so the device/simulator can reach it)
3. `npx cap sync ios`, then build the iOS app — it'll load from the live Vite server

Remember to **restore `server.url` to your production origin before release builds**, or the released binary will try to reach your laptop.

> Tip: `apps/web` also has npm scripts for the common steps —
> `pnpm ios:add`, `pnpm ios:sync`, `pnpm ios:build` (build + sync),
> `pnpm ios:open`, and `pnpm ios` (build + sync + open).

---

## CallKit integration — the load-bearing custom Swift

Capacitor has no first-party CallKit plugin. The JS-side bridge (`apps/web/src/lib/native.ts`) calls into a plugin named `ZekktrisCalls` that you'll need to add to the Xcode project manually. This is what unlocks the locked-screen mic that PWA can't achieve.

> **These files already exist in the repo** at `apps/web/ios-native/`
> (`ZekktrisCalls.swift`, `ZekktrisCalls.m`, plus an `AppDelegate+VoIP`
> reference). After `npx cap add ios`, copy the two `ZekktrisCalls.*`
> files into `apps/web/ios/App/App/` and `pod install`. See
> `apps/web/ios-native/README.md`. The code below is the same content,
> inline for reference.

### Plugin skeleton

Create `apps/web/ios/App/App/ZekktrisCalls.swift`:

```swift
import Foundation
import Capacitor
import CallKit
import AVFoundation

@objc(ZekktrisCallsPlugin)
public class ZekktrisCallsPlugin: CAPPlugin {
    /// Set in `load()` so the AppDelegate's PushKit callbacks can
    /// reach the live plugin instance to report incoming calls.
    public static weak var shared: ZekktrisCallsPlugin?

    private let provider: CXProvider
    private let callController = CXCallController()

    public override init() {
        let config = CXProviderConfiguration(localizedName: "Zekktris")
        config.supportsVideo = true
        config.maximumCallGroups = 1
        config.maximumCallsPerCallGroup = 1
        config.supportedHandleTypes = [.generic]
        if let iconImage = UIImage(named: "AppIcon") {
            config.iconTemplateImageData = iconImage.pngData()
        }
        self.provider = CXProvider(configuration: config)
        super.init()
        self.provider.setDelegate(self, queue: nil)
    }

    /// Capacitor calls `load()` once the plugin is instantiated and
    /// attached to the bridge. Record the singleton here.
    public override func load() {
        ZekktrisCallsPlugin.shared = self
    }

    @objc func presentIncomingCall(_ call: CAPPluginCall) {
        guard let callIdString = call.getString("callId"),
              let callId = UUID(uuidString: pad(callIdString)),
              let callerName = call.getString("callerName") else {
            call.reject("Missing callId or callerName")
            return
        }
        let hasVideo = call.getBool("hasVideo") ?? false
        reportIncoming(callId: callId, callerName: callerName, hasVideo: hasVideo) { error in
            if let error = error {
                call.reject("CallKit failed: \(error.localizedDescription)")
            } else {
                call.resolve()
            }
        }
    }

    /// Entry point for voIP pushes (see AppDelegate). There is no
    /// CAPPluginCall here — the push arrives natively — so this builds
    /// the UUID itself and reports straight to CallKit. MUST run
    /// synchronously inside the PushKit callback (Apple kills the app
    /// otherwise).
    public func presentIncomingCallFromPush(callId callIdString: String, callerName: String, hasVideo: Bool) {
        guard let callId = UUID(uuidString: pad(callIdString)) else { return }
        reportIncoming(callId: callId, callerName: callerName, hasVideo: hasVideo, completion: nil)
    }

    /// Shared CallKit "new incoming call" reporting used by both the
    /// JS-driven path and the voIP-push path.
    private func reportIncoming(callId: UUID, callerName: String, hasVideo: Bool, completion: ((Error?) -> Void)?) {
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: callerName)
        update.localizedCallerName = callerName
        update.hasVideo = hasVideo
        update.supportsDTMF = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        provider.reportNewIncomingCall(with: callId, update: update) { error in
            completion?(error)
        }
    }

    @objc func endCall(_ call: CAPPluginCall) {
        guard let callIdString = call.getString("callId"),
              let callId = UUID(uuidString: pad(callIdString)) else {
            call.reject("Missing callId")
            return
        }
        let endAction = CXEndCallAction(call: callId)
        callController.request(CXTransaction(action: endAction)) { error in
            if let error = error {
                call.reject("End call failed: \(error.localizedDescription)")
            } else {
                call.resolve()
            }
        }
    }

    @objc func reportOutgoingCall(_ call: CAPPluginCall) {
        guard let callIdString = call.getString("callId"),
              let callId = UUID(uuidString: pad(callIdString)),
              let calleeName = call.getString("calleeName") else {
            call.reject("Missing callId or calleeName")
            return
        }
        let handle = CXHandle(type: .generic, value: calleeName)
        let startAction = CXStartCallAction(call: callId, handle: handle)
        startAction.contactIdentifier = calleeName
        callController.request(CXTransaction(action: startAction)) { error in
            if let error = error {
                call.reject("Start call failed: \(error.localizedDescription)")
            } else {
                call.resolve()
            }
        }
    }

    /// Snowflake IDs are 18-19 digit strings; UUIDs are 36 chars
    /// in 8-4-4-4-12 format. Pad the snowflake into a deterministic
    /// UUID shape so CallKit can use it as a unique identifier.
    private func pad(_ id: String) -> String {
        let padded = String(repeating: "0", count: max(0, 32 - id.count)) + id
        let chars = Array(padded.prefix(32))
        return "\(String(chars[0..<8]))-\(String(chars[8..<12]))-\(String(chars[12..<16]))-\(String(chars[16..<20]))-\(String(chars[20..<32]))"
    }
}

extension ZekktrisCallsPlugin: CXProviderDelegate {
    public func providerDidReset(_ provider: CXProvider) {
        // CallKit reset (system rebooted, user toggled airplane mode,
        // etc). Notify JS to clean up via the existing voice
        // disconnect path.
        self.notifyListeners("callReset", data: [:])
    }

    public func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        // User tapped Answer on the locked-screen UI. Notify JS to
        // join the LiveKit room.
        self.notifyListeners("callAnswered", data: ["callId": action.callUUID.uuidString])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        // User tapped End. JS will run disconnectVoice via the
        // listener, which itself eventually calls back into endCall
        // — that's fine, the second call resolves with no-op.
        self.notifyListeners("callEnded", data: ["callId": action.callUUID.uuidString])
        action.fulfill()
    }

    public func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        // CallKit has activated the audio session. Configure for
        // VoIP playback + record.
        try? audioSession.setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetooth, .defaultToSpeaker])
        try? audioSession.setActive(true)
    }
}
```

### Register the plugin

Capacitor discovers the plugin automatically through the `CAP_PLUGIN`
macro — you do **not** call any `register()` method yourself. Create
the Objective-C registration shim at `apps/web/ios/App/App/ZekktrisCalls.m`:

```objc
#import <Foundation/Foundation.h>
#import <Capacitor/Capacitor.h>

CAP_PLUGIN(ZekktrisCallsPlugin, "ZekktrisCalls",
    CAP_PLUGIN_METHOD(presentIncomingCall, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(endCall, CAPPluginReturnPromise);
    CAP_PLUGIN_METHOD(reportOutgoingCall, CAPPluginReturnPromise);
)
```

After both files exist, run `cd apps/web/ios/App && pod install` to regenerate the workspace.

---

## voIP push (for locked-screen incoming-call ring)

Regular APNs pushes don't wake the app enough to call `presentIncomingCall` before the user taps. To ring on a locked phone you need voIP push:

1. **Get a voIP push certificate** from Apple Developer portal → Certificates → +
   → Apple Push Notification service SSL (Sandbox & Production) → VoIP Services Certificate
2. **Upload to the server** so it can send pushes with `apns-push-type: voip`. The server-side push code already handles normal APNs; the voIP variant uses a different certificate but the same API
3. **Add PushKit handling** to AppDelegate:

```swift
import PushKit

class AppDelegate: UIResponder, UIApplicationDelegate, PKPushRegistryDelegate {
    var voipRegistry: PKPushRegistry?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions ...) -> Bool {
        // ... existing capacitor setup ...

        voipRegistry = PKPushRegistry(queue: DispatchQueue.main)
        voipRegistry?.delegate = self
        voipRegistry?.desiredPushTypes = [.voIP]
        return true
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let token = credentials.token.map { String(format: "%02x", $0) }.joined()
        // Forward to server via the existing notification-subscription endpoint
        // — add a "voipToken" field next to the regular APNs token.
        NotificationCenter.default.post(name: .voipTokenUpdated, object: token)
    }

    func pushRegistry(_ registry: PKPushRegistry, didReceiveIncomingPushWith payload: PKPushPayload, for type: PKPushType, completion: @escaping () -> Void) {
        // Server sends { callId, callerName, hasVideo } in the payload.
        let dict = payload.dictionaryPayload
        let callId = dict["callId"] as? String ?? UUID().uuidString
        let callerName = dict["callerName"] as? String ?? "Incoming call"
        let hasVideo = (dict["hasVideo"] as? Bool) ?? false

        // Forward to our CallKit plugin so the system call UI shows.
        // CRITICAL: must call reportNewIncomingCall WITHIN the
        // pushRegistry callback, otherwise iOS will kill the app
        // for missing-call-after-voip-push.
        ZekktrisCallsPlugin.shared?.presentIncomingCallFromPush(
            callId: callId,
            callerName: callerName,
            hasVideo: hasVideo
        )
        completion()
    }
}
```

The "CRITICAL" note above is real — Apple will silently disable voIP pushes for the app if it receives one without reporting an incoming call within ~5 seconds.

The `.voipTokenUpdated` notification name referenced above needs declaring once (e.g. at the bottom of `AppDelegate.swift`):

```swift
extension Notification.Name {
    static let voipTokenUpdated = Notification.Name("voipTokenUpdated")
}
```

> **Note on the AppDelegate:** Capacitor generates an `AppDelegate`
> that already implements `application(_:didFinishLaunchingWithOptions:)`
> and the standard APNs callbacks. Don't replace it wholesale — *add*
> the `PKPushRegistryDelegate` conformance, the `voipRegistry` setup,
> and the two `pushRegistry(...)` methods to the existing class. Keep
> every line Capacitor put there (it returns `super`/`true` and wires
> the web view).
>
> The JS side currently calls `presentIncomingCall` / `endCall` /
> `reportOutgoingCall` (see `apps/web/src/lib/native.ts`). The plugin
> also emits `callAnswered` / `callEnded` / `callReset` via
> `notifyListeners` — to react to the user answering from the locked
> screen, add `Capacitor.Plugins.ZekktrisCalls.addListener('callAnswered', …)`
> wiring on the JS side next to the voice-join logic. Until that's
> added, the system call UI still appears; it just won't auto-join the
> LiveKit room on answer.

---

## Push notifications (APNs)

The iOS app uses **native APNs** for @mentions, DMs, and call alerts. (The web
build's Web Push does **not** work inside the iOS WKWebView, so this is the
only path that delivers on iOS.) Three things must line up — two here in Xcode
/ the Apple portal, one on the server.

> This is *alert* push (banners/lock-screen). The separate "VoIP push" section
> above is only needed if you later want a full CallKit ring on the locked
> screen; basic call notifications ride this same alert pipeline.

### 1. Enable the capability in Xcode

1. Select the **App** target → **Signing & Capabilities**.
2. Click **+ Capability** → add **Push Notifications**. This creates the
   `aps-environment` entitlement (Xcode manages the file for you).
3. *(Optional, for background delivery)* **+ Capability** → **Background
   Modes** → tick **Remote notifications**.

With automatic signing, adding the capability also flips Push Notifications on
for the App ID. If you sign manually, enable it on the App ID at
developer.apple.com → Identifiers and regenerate the provisioning profile.

**Then forward the device token to Capacitor.** The plain APNs plugin needs
two methods in `apps/web/ios/App/App/AppDelegate.swift` — without them the
`registration` event never fires, so no token reaches the server and push
silently does nothing. Add these inside the `AppDelegate` class:

```swift
func application(
  _ application: UIApplication,
  didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data
) {
  NotificationCenter.default.post(
    name: .capacitorDidRegisterForRemoteNotifications, object: deviceToken)
}

func application(
  _ application: UIApplication,
  didFailToRegisterForRemoteNotificationsWithError error: Error
) {
  NotificationCenter.default.post(
    name: .capacitorDidFailToRegisterForRemoteNotifications, object: error)
}
```

> **Test on a real device or via TestFlight — NOT the iOS Simulator.** The
> Simulator silently doesn't register for remote push (no token, no error),
> which looks identical to a broken setup and wastes hours.

### 2. Create an APNs auth key (.p8)

1. developer.apple.com → **Keys** → **+** → name it, tick **Apple Push
   Notifications service (APNs)** → Continue → Register.
2. **Download the `.p8` now** — you only get one chance; Apple won't let you
   re-download it.
3. Note the **Key ID** (on that page) and your **Team ID** (top-right of the
   developer site).

### 3. Configure the server

Set these in the API's environment (see `.env.example` for the full notes):

```
APNS_KEY_P8=<base64 of the .p8, e.g. `base64 -i AuthKey_XXXX.p8`>
APNS_KEY_ID=<10-char Key ID>
APNS_TEAM_ID=<10-char Team ID>
APNS_BUNDLE_ID=com.zekktris.app
APNS_PRODUCTION=true
```

> **TestFlight + App Store builds use the *production* APNs host**, so keep
> `APNS_PRODUCTION=true`. Only set it to `false` for a debug build you run
> directly from Xcode onto a device (that uses the sandbox host). A
> token-based `.p8` works for both — only the host differs.

On boot, the API's startup checks print
`Push notifications (APNs / iOS) … configured (production host)` when this is
wired correctly (or `skipped` if the vars aren't set).

### 4. Apply + verify

```bash
pnpm install            # pulls the @capacitor/push-notifications pod deps
pnpm --filter @zekktris/db migrate   # adds the apns_device_tokens table
cd apps/web && pnpm build && npx cap sync ios
```

Rebuild in Xcode. On the next sign-in the app requests notification
permission; once granted, **Settings → Zekktris → Notifications** appears on
the device and a row shows under Settings → Notifications → *Your devices* in
the app. Send yourself a DM from another account (with the app backgrounded)
to confirm delivery.

---

## Publishing to TestFlight

1. In Xcode: Product → Archive
2. Window → Organizer → Distribute App → App Store Connect → Upload
3. Wait for the build to finish processing (~10 min)
4. Add testers in App Store Connect → TestFlight tab
5. Testers install via the TestFlight app and report bugs

For production release, submit for App Store review from App Store Connect. Expect a 1-3 day review.

---

## What works on web vs native

| Feature                              | Web | Native iOS |
|---|---|---|
| Send/receive messages                | ✅  | ✅         |
| Voice calls (foreground)             | ✅  | ✅         |
| Voice calls (background/locked)      | ⚠️ best-effort | ✅ via CallKit |
| Push notifications                   | ✅ web-push | ✅ APNs |
| Incoming-call ring on locked phone   | ❌  | ✅ via voIP |
| File attachments                     | ✅  | ✅         |
| Webcam                               | ✅  | ✅         |
| Screen share                         | ✅  | ✅         |

The native shell's primary value is the bottom three rows — everything else already works via the PWA.
