# Zekktris — Native iOS (SwiftUI)

A **native** SwiftUI client for Zekktris that talks directly to the existing
API + realtime gateway. No WebView, no web bundle — this is a from-scratch
Swift implementation of the client.

The app is feature-complete across the core surface (auth, messaging, DMs,
E2EE, threads/forums, voice & 1:1 calls with CallKit ringing, reactions,
attachments, polls, push, search, mentions, settings, iPad/Mac multi-column) —
see *What works* below. Alongside the app, `project.yml` builds an Apple Watch
app and six extensions (see *Targets*). It works with zekktris.com or any
self-hosted Zekktris server, chosen at sign-in (see *Pointing at a different
server*). The remaining gaps are listed under *Not built yet*.

> ⚠️ **Adding files:** if you regenerate the project, **re-run `xcodegen
> generate`** so any newly-added Swift files are picked up (`project.yml` is
> the source of truth for the target's file list). For a manually-created
> Xcode project, drag new files into the target instead.
>
> **Push Notifications.** `project.yml` generates a `Zekktris.entitlements`
> with `aps-environment: $(APS_ENVIRONMENT)` — `development` for Debug,
> `production` for Release/Archive (TestFlight + App Store). You must enable
> the **Push Notifications** capability for the target in Xcode (Signing &
> Capabilities) with a real Apple Developer team — and actually receiving
> pushes needs a physical device plus the server's APNs config. The simulator
> can't receive remote pushes; the registration code just no-ops there.
>
> **LiveKit Swift Package dependency**
> (`https://github.com/livekit/client-sdk-swift`, 2.14.1+). `xcodegen generate`
> wires the package reference; Xcode resolves it on first open (needs network).
> For a manual project, add it via File ▸ Add Package Dependencies. Voice needs
> the microphone permission (already in the generated Info.plist) and is best
> tested **on a real device** — the simulator's mic capture is unreliable.

---

## What works

- **Sign in & register** against `/auth/login` and `/auth/register`, with the
  access token stored in the Keychain and restored on next launch
  (`/users/@me`).
- **Server rail** listing your guilds, with a **Direct Messages** button.
- **Channel list** for the selected guild (text channels and voice channels
  tappable; categories shown as headers).
- **DMs**: your existing direct-message conversations list (`/users/@me/channels`),
  open one, read and send — same composer as guild channels.
- **Friends & new DMs**: a Friends sheet (person-add button in the DM list) —
  add a friend by username, accept/decline incoming requests, cancel outgoing
  ones, block/unblock users (long-press a friend to block or remove), see your
  blocked list, and tap a friend to open or create a DM and jump in.
- **Presence**: online / idle / dnd / offline dots on avatars (DM list, message
  authors, your own), seeded from the DTOs and updated live from
  `PRESENCE_UPDATE` gateway events.
- **Typing indicators**: typing in the composer pings the channel (throttled to
  once every few seconds), and a "<name> is typing…" line shows above the
  composer when others type, self-expiring after ~8s (`TYPING_START`).
- **Push registration**: on login the app requests notification permission and
  registers its APNs token with the server (`/users/@me/device-tokens`), and
  unregisters on logout. Actually *receiving* pushes needs a paid Apple
  Developer account, the Push Notifications capability in signing, a real
  device, and the server's APNs config — it can't be exercised in the simulator.
- **Settings**: a profile/settings sheet from the rail's user menu — see your
  profile, set your presence (online / idle / dnd / invisible), edit your
  display name and custom status (`PATCH /users/@me`), and log out.
- **Search**: in-channel full-text message search (magnifier in the channel
  header) — type a query and see matching messages with author + snippet.
  Offered in non-E2EE channels only, since encrypted DM content is stored as
  ciphertext and server-side FTS can't match the plaintext.
- **Mentions inbox**: a Mentions button at the top of the rail (under Direct
  Messages) lists your recent @-mentions (author, channel, snippet, time); tapping navigates to the
  channel when it's already loaded.
- **E2EE DMs**: unlock an encrypted DM with the shared password (verified
  against the server-stored verifier), decrypt history, send encrypted, and
  enable encryption on a DM — AES-256-GCM with the exact `zkE2EE/3:` wire
  format and PBKDF2-SHA-256 (250k) key derivation, interoperable with web.
  Keys are **device-local by design**: each device (and each participant)
  enters the password once, which re-derives the identical key from the
  server-stored salt — there is no automatic key sync across devices, which is
  the correct E2EE property. Cached keys are scoped per account and re-checked
  against the channel's current verifier on every use, so a re-keyed DM (or a
  key left over from a different login) is dropped and the conversation
  re-prompts rather than silently failing to decrypt. Live `CHANNEL_UPDATE`
  handling means a device that's already open picks up an enable / disable /
  re-key immediately.
- **Threads & forums**: forum channels list their posts; open a post to read or
  reply; create a new post. Text channels expose their threads (header button),
  and you can start a thread from any message (long-press). Threads reuse the
  message timeline.
- **Voice (guild channels)**: tap a voice channel to join — connects to LiveKit
  with the server-issued token, publishes your mic, and plays everyone else's
  audio. Participants show as square tiles (avatar + name pill, mute badge). The
  back arrow returns to the channel list while staying connected; a **VoicePanel**
  strip then pins to the bottom of the channel list with the connected channel,
  mute/unmute, and a red disconnect — only that button actually leaves.
- **1:1 DM calls**: the phone button in a DM header starts a call (joins voice
  on the DM channel and connects LiveKit). When the conversation is E2EE and
  unlocked, the call media is end-to-end encrypted — LiveKit's media E2EE is
  keyed from the DM's shared key, and the web client was aligned to the same
  key derivation, so encrypted calls interoperate in **all** directions
  (native↔native, native↔web, web↔web — see the E2EE-call note below). Incoming
  calls ring through **CallKit** — the system call screen, on the lock screen
  too — woken by a **PushKit VoIP push** when the app is in the background or
  closed (`CallManager.swift`, `Push.swift`); declining ends the caller's
  session. Mute and hang up from the call screen or the system UI. Camera
  video works; screen shares started elsewhere can be watched.
- **Reactions**: long-press a message ▸ Add reaction to react; tap a reaction
  pill to toggle yours off/on. Counts update live as others react/unreact
  (`MESSAGE_REACTION_ADD` / `_REMOVE`), and your own taps apply optimistically.
- **Attachments**: image attachments render inline; other files show a chip
  with name + size. You can also **send images** — tap the photo button in the
  composer, pick from your library, optionally add a caption, and send (uploaded
  via the `payload_json` + `files[N]` multipart contract). In E2EE DMs photos,
  videos and files are encrypted on-device with the DM key before upload
  (`.zke`), with an encrypted thumbnail, and decrypted for display — the
  server only ever stores ciphertext. Files shared from other apps through the
  **Share Extension** land in the composer of the chosen conversation (open
  Zekktris to send them; nothing is sent automatically).
- **Link previews in E2EE DMs** are **off by default**. With *Settings →
  Security → Link previews in encrypted chats* on, the app sends the link (not
  the message) to your server's `/unfurl` to build the preview.
- **Polls**: create a poll from the composer (poll button → question, options,
  single/multiple choice, duration). Poll messages render with options as
  tappable bars showing live vote counts; tap to vote or retract, with
  closed/expired polls locked. Tallies refresh live via `MESSAGE_UPDATE`.
- **Messages**: read the last 50 in a channel/DM and **send** new ones.
- **Edit & delete**: long-press your own message to edit it (re-encrypted in
  E2EE DMs) or delete it. Edits and deletes from anyone now update live
  (`MESSAGE_UPDATE` / `MESSAGE_DELETE` / `_BULK`), and edited messages show an
  "(edited)" marker.
- **Realtime**: the WebSocket gateway connects (HELLO → IDENTIFY → READY +
  heartbeats) and `MESSAGE_CREATE` events append live.
- Dark theme using the web app's color tokens (cyan accent, navy surfaces).

## Not built yet (future stages)

Publishing a screen share from iOS (the in-app ReplayKit capture was removed;
shares from web/desktop can be watched).

Known first-cut call limitation: if the callee declines or the other side hangs
up, your own call screen isn't always auto-dismissed — you hang up manually. The
E2EE call path now interoperates with the web client in all directions (see the
E2EE-call note below).

---

## Requirements

- macOS with a current **Xcode** (16.3 or newer: the sources use Swift 6.1
  syntax such as trailing commas in argument lists)
- iOS **17.0+** (interactive widgets need it), watchOS **10.0+** for the watch
  app — device or simulator
- **XcodeGen** — the project has an app, a watch app and six extension
  targets, so generating it from `project.yml` is the supported path

## Open & run — Option A: XcodeGen (recommended)

[XcodeGen](https://github.com/yonaskolb/XcodeGen) generates the `.xcodeproj`
from `project.yml`, so there's no fragile project file to hand-maintain.

```bash
brew install xcodegen        # once
cd ios-native
xcodegen generate            # creates Zekktris.xcodeproj
open Zekktris.xcodeproj
```

Then in Xcode: select the **Zekktris** target → **Signing & Capabilities** →
pick your Team (and adjust the bundle id if `com.zekktris.native` is taken) →
choose a simulator or device → **Run**. `project.yml` sets a
`DEVELOPMENT_TEAM`; change it to yours. With your own bundle ids, register the
App Group (`group.com.zekktris.native`, see `AppGroupConfig.swift`) and enable
it on the app and **every** extension and watch target, including the Share
Extension — the widgets, Siri, the notification extension and the share sheet
all hand data to the app through it.

### Targets

| Target | What it is |
| --- | --- |
| `Zekktris` | The iOS / iPadOS app (also runs on Apple Silicon Macs) |
| `NotificationService` | Decrypts E2EE message previews and attaches images on-device |
| `ShareExtension` | "Zekktris" in the share sheet; stages the share for the app |
| `ZekktrisWidgets` | Home/Lock-Screen Quick DM widget with one-tap poke |
| `ZekktrisIntents` | Siri "send a message to … on Zekktris" without opening the app |
| `ZekktrisWatch` | The Apple Watch app (messages and pokes to recent DMs) |
| `ZekktrisWatchWidgets` | Watch complications / Smart Stack widgets |
| `ZekktrisWatchIntents`, `ZekktrisWatchAppIntents` | Siri on the watch |
| `ZekktrisTests` | Host-less logic tests (E2EE call keys, Siri matching) |

## Open & run — Option B: the committed project

`Zekktris.xcodeproj` is committed, generated from `project.yml`. It opens
as-is, but it is only as current as the last `xcodegen generate`: after adding
files or editing `project.yml`, regenerate rather than editing the project by
hand. (Recreating the project manually is not practical any more — it would
mean re-creating all the targets, entitlements and Info.plist keys
`project.yml` declares.)

---

## Pointing at a different server

No rebuild needed. The sign-in screen has a server chip: tap it and enter your
server's address (`chat.example.com`, `203.0.113.5`,
`https://chat.example.com:8443`, or a home-network `192.168.1.20:5550`). The
app checks `/api/v1/instance/info` and remembers the choice; it defaults to
zekktris.com. Without a scheme it tries HTTPS first and, for a home-network
address only (private / link-local / CGNAT IP literals, `*.local`, single-label
names), falls back to plain `http://` on the typed port or on 80 and 5550 (the
installer's `--lan` port). See `ServerPickerSheet` / `ServerProbe` in
`AuthViews.swift`.

`Config.swift` derives everything from that one origin (`serverOrigin` →
`apiBaseURL`, `gatewayURL`, `assetOrigin`) and stores it in the App Group, so
the widgets, Siri and the notification extension use the same server; the
watch gets it from the phone. Plain http is allowed only to local addresses:
every target that talks to the server sets `NSAllowsLocalNetworking`, and
anything on the internet still needs HTTPS. Change servers only while signed
out — a session belongs to one server.

---

## Project layout

```
ios-native/
├── project.yml            XcodeGen spec (generates Zekktris.xcodeproj)
├── README.md
└── Zekktris/
    ├── Config.swift        Server origin (picked at sign-in) → base URLs + asset URL helper
    ├── Theme.swift         Color tokens from the web index.css
    ├── Keychain.swift      Access-token persistence
    ├── Models.swift        Codable DTOs (User/Guild/Channel/Message/…)
    ├── APIClient.swift     REST client (auth + guilds/channels/messages)
    ├── Gateway.swift       WebSocket gateway (HELLO/IDENTIFY/heartbeat/DISPATCH)
    ├── Session.swift       Auth state + token lifecycle
    ├── AppStore.swift      Guilds/channels/messages state + gateway wiring
    ├── ZekktrisApp.swift   @main App + RootView router
    ├── AuthViews.swift     Login + Register (with password strength)
    ├── MainView.swift      Server rail, channel/DM lists, Friends, Settings, Mentions
    ├── MessageViews.swift  Message timeline, rows, composer, polls, search
    ├── ThreadViews.swift   Thread list + forum posts
    ├── Voice.swift         LiveKit voice + 1:1 call screens (incl. call E2EE)
    ├── VoiceMessage.swift  Voice-message record/playback
    ├── CallManager.swift   CallKit / PushKit call coordination
    ├── E2EE.swift          AES-256-GCM DM encryption (ports the web's e2ee.ts)
    ├── Push.swift          APNs registration + AppDelegate
    └── Components.swift    Avatar, guild icon, time + strength helpers
```

## How the pieces talk

```
ZekktrisApp → RootView ──(phase)──► AuthFlowView (LoginView / RegisterView)
                       └──(signedIn)─► MainView (ServerRail + ChannelList + MessageList)

Session  ── owns token, current user, login/register/logout (→ APIClient + Keychain)
AppStore ── owns guilds/channels/messages, drives Gateway, de-dupes echoes
APIClient ─ REST over URLSession (Bearer auth)
Gateway  ── URLSessionWebSocketTask; onEvent(name, data) → AppStore
```

## Roadmap (suggested next stages)

1. ~~Presence + DMs list~~ ✅ done (Stage 2).
2. ~~Start new DMs + friend management~~ ✅ done (Stages 9, 16) — add by
   username, accept/decline/cancel requests, block/unblock, open a DM.
3. ~~E2EE DMs~~ ✅ done (Stage 3).
4. ~~Threads & forums~~ ✅ done (Stage 4).
5. ~~Voice (guild channels)~~ ✅ done (Stage 5). ~~1:1 DM calls~~ ✅ done
   (Stage 17): CallKit + PushKit ringing, call E2EE, mute/hang-up, camera
   video. Remaining: publishing a screen share from iOS.
6. ~~Reactions + attachments (display + image upload)~~ ✅ done (Stage 6–7).
   Remaining: polls, typing indicators.
7. ~~Edit & delete messages~~ ✅ done (Stage 8), incl. live `MESSAGE_UPDATE` /
   `MESSAGE_DELETE` handling.
8. ~~Push registration~~ ✅ done (Stage 13) — APNs token register/unregister.
   Receiving needs a real device + dev account + server APNs config.
9. ~~Settings~~ ✅ done (Stage 14) — profile, presence, display name, custom
   status, logout. ~~iPad multi-column~~ ✅ done.
10. ~~Polls~~ ✅ done (Stages 10–11: display, voting, creation).
    ~~Typing indicators~~ ✅ done (Stage 12). ~~Search~~ ✅ done (Stage 15).
    ~~Mentions inbox~~ ✅ done (Stage 16).

## Status & caveats

The app builds and runs. Remaining gaps are product features, not scaffolding —
see *Not built yet* (publishing a screen share from iOS).

The **E2EE call path** in `Voice.swift` now interoperates with the web client
(previously native↔web encrypted calls were garbled). It configures LiveKit's
media E2EE via `BaseKeyProvider(isSharedKey: true, sharedKey:)` +
`EncryptionOptions(keyProvider:, encryptionType: .gcm)` +
`RoomOptions(encryptionOptions:)`. The Swift SDK's shared-key API takes a
**`String`**, which it UTF-8-encodes and runs through libwebrtc's PBKDF2 (salt
`"LKFrameEncryptionKey"`) to derive the AES-GCM media key — LiveKit's documented
*"recommended for maximum compatibility across SDKs"* path. We pass the **base64
of the 32-byte DM key** as that string.

The web client was aligned to feed the **identical base64 string** to
`ExternalE2EEKeyProvider.setKey(<string>)` (which also runs PBKDF2) instead of
the raw 32 bytes it used before (which selected web-only HKDF). Because both
platforms derive the same DM key from the same password + salt and then key
LiveKit from the same string, **all four directions decrypt**: native↔native,
web↔web, native↔web, web↔native. The unlock verifier guarantees the two sides
hold matching keys before a call starts. See `apps/web/src/lib/e2ee.ts`
(`getCallKeyString`) for the web side.

Plain (non-E2EE) calls and guild voice are unaffected. The mic is unreliable on
the iOS simulator — test calls on a real device.
