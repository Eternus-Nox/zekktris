# Android call UI — implementation plan (Telecom)

> **Status: not built.** This is a spec for the one Android-vs-iOS parity gap
> left after the Capacitor wrapper ([`ANDROID_BUILD.md`](./ANDROID_BUILD.md)):
> a system-level incoming-call experience (ring on the lock screen, answer/
> decline, audio that survives the screen locking) matching iOS CallKit. It's
> the largest remaining piece (~weeks of native Kotlin + device testing) and
> needs a real device/emulator to build and verify — hence a plan, not code.

## What "done" looks like

Parity with the iOS native app's CallKit/PushKit behaviour:
- A 1:1 call rings the phone even when the app is **backgrounded or killed**,
  with a full-screen incoming-call screen on the lock screen.
- **Answer** → the app comes to the foreground and joins the LiveKit voice room.
- **Decline** → the server is told (so the caller stops ringing).
- Call **audio keeps working when the screen locks** (the whole reason iOS uses
  a native shell).

## The key leverage: the web side already exists

The web client already drives calls through a Capacitor plugin called
**`ZekktrisCalls`** (see [`apps/web/src/lib/native.ts`](./apps/web/src/lib/native.ts),
the CallKit section). It calls, and listens to, exactly this interface:

```
presentIncomingCall({ callId, callerName, hasVideo })   // ring now
endCall({ callId })                                       // tear down
reportOutgoingCall({ callId, calleeName })                // elevate audio for an outgoing call
addListener('callAnswered' | 'callEnded' | 'callReset', cb({ callId }))
```

On iOS this is a Swift plugin backed by CallKit. **The Android work is to
implement a Kotlin Capacitor plugin with the same name and the same JS surface,
backed by Android's Telecom framework.** No web-client changes are needed — when
the plugin is present, the existing gateway/incoming-call handlers light up; when
it's absent (today), they no-op and the in-app modal handles calls.

## Architecture

```
 server (kind:'call', high-priority FCM, DATA-only)
        │
        ▼
 FirebaseMessagingService.onMessageReceived            ← fires even when killed
        │  (parse callId/callerName/hasVideo)
        ▼
 TelecomManager.addNewIncomingCall(phoneAccount, …)
        │
        ▼
 ZekktrisConnectionService.onCreateIncomingConnection  → Connection (self-managed)
        │  system shows the incoming-call UI (full-screen on lock)
        ├─ onAnswer()  → launch MainActivity, emit 'callAnswered' to JS → web joins LiveKit room
        ├─ onReject()  → emit 'callEnded' → web/REST posts decline
        └─ onDisconnect()/timeout → emit 'callEnded'
```

## Phases

### Phase 0 — Server: call pushes must be DATA-only high-priority
`services/fcm.ts` currently sends a `notification` block for every push. A
**notification** message, when the app is backgrounded, is shown by the system
tray and does **not** invoke `onMessageReceived` — so it can't launch the call
UI. For `payload.kind === 'call'`, send a **data-only** message (no
`notification` block), keep `android.priority: 'high'`, and carry
`callId`/`callerName`/`hasVideo`/`channelId` in `data`. This mirrors the
separate APNs VoIP path (`sendVoipToUser`). Find the `sendToUser(..., kind:'call')`
call site (the ring path) and confirm the payload carries those fields.

### Phase 1 — Receive the call push natively
`@capacitor/push-notifications` registers its own `FirebaseMessagingService`.
Add a custom service (declared first in the manifest) that:
- inspects the data; if it's a `kind:'call'` message → start the Telecom flow;
- otherwise delegates to Capacitor's service so normal message pushes still work.
(Extending `CapacitorFirebaseMessagingService` and calling through is the
cleanest; verify the class name against the installed plugin version.)

### Phase 2 — Telecom self-managed ConnectionService
- Register a **self-managed** `PhoneAccount` (`CAPABILITY_SELF_MANAGED`) at app
  start — no default-dialer role needed.
- On a call push: `TelecomManager.addNewIncomingCall(handle, extras)` → the OS
  calls `ZekktrisConnectionService.onCreateIncomingConnection`, which returns a
  `Connection` with `setRinging()`, caller name, and video state.
- `Connection.onAnswer()` → start `MainActivity` (with the `callId` in the
  intent), emit `callAnswered`.
- `Connection.onReject()` / `onAbort()` / timeout → `setDisconnected(...)`, emit
  `callEnded`.

### Phase 3 — The `ZekktrisCalls` Kotlin plugin
Implement the JS surface above and bridge it to Telecom:
- `presentIncomingCall` → `addNewIncomingCall` (used when the app is alive and
  the **gateway** delivers the ring, mirroring iOS — the FCM path of Phase 1 is
  the killed/background path).
- `reportOutgoingCall` → place a self-managed outgoing `Connection` so audio gets
  the call audio mode.
- `endCall` → `Connection.setDisconnected`.
- events → `notifyListeners('callAnswered'|'callEnded'|'callReset', { callId })`
  from the ConnectionService callbacks.

### Phase 4 — Audio
Self-managed Connections coordinate audio focus; make sure the WebView's WebRTC
audio uses `MODE_IN_COMMUNICATION` and follows the Connection's audio route
(earpiece/speaker/BT). Declare `FOREGROUND_SERVICE` +
`FOREGROUND_SERVICE_PHONE_CALL` (Android 14+). **This is the hardest interop**
(CallKit's `AudioManager` gating on iOS has no exact WebView analogue) — budget
device time here.

### Phase 5 — Cold-start answer (killed app)
Answering from the lock screen with the app killed must: launch `MainActivity` →
boot the web app → reconnect the gateway → read the pending `callId` (from the
launch intent, surfaced via a `getPendingCall()` plugin method) → join the room.
This is the same cold-start path that was the trickiest part of the iOS CallKit
work — expect to iterate it on-device.

## Manifest / permissions
`MANAGE_OWN_CALLS`, `FOREGROUND_SERVICE`, `FOREGROUND_SERVICE_PHONE_CALL`,
`USE_FULL_SCREEN_INTENT`; a `<service>` for `ZekktrisConnectionService` with
`android.permission.BIND_TELECOM_CONNECTION_SERVICE` and the
`android.telecom.ConnectionService` intent-filter.

## Risks (why this needs on-device iteration)
- **Delivery reliability:** FCM high-priority data messages to *killed* apps are
  not as guaranteed as iOS PushKit — OEM battery optimisation (Samsung, Xiaomi,
  etc.) can delay/drop them. There is no full PushKit equivalent on Android.
- **OEM variance:** self-managed Telecom UI and full-screen-intent behaviour
  differ across manufacturers and Android versions.
- **Android 12+/14:** background activity & foreground-service launch limits, and
  `USE_FULL_SCREEN_INTENT` is now restricted to calling/alarm apps (a
  self-managed call app qualifies, but it's gated).
- **WebRTC-in-WebView audio routing** under Telecom focus is unproven here.

## Recommended sequencing — ship an MVP first
Before committing to full Telecom, do a **full-screen-intent notification** MVP
(~3–5 days vs ~3–5 weeks):
- Phase 0 + 1 (data-only call push + a messaging service), then post a
  high-priority notification with `setFullScreenIntent(...)` that launches a
  custom incoming-call `Activity` (Answer/Decline) instead of a Telecom
  `Connection`. Answer → launch app + join; Decline → REST decline.
- Pros: far simpler, more OEM-reliable, delivers "rings on lock screen,
  answer/decline" without ConnectionService or audio-focus plumbing.
- Cons: not in the system call log, no Telecom audio routing (rely on the
  WebView/LiveKit default audio + a foreground service for keep-alive).

Graduate to the full ConnectionService (Phases 2–5) only if the system-call
integration is worth the extra weeks.

## Effort
- FSI-notification MVP: ~3–5 days + device testing.
- Full Telecom ConnectionService: ~3–5 weeks + significant device testing,
  especially Phases 4–5.

## Files
- New: `apps/web/android/app/src/main/java/com/zekktris/app/` — the Kotlin plugin
  (`ZekktrisCallsPlugin`), `ZekktrisConnectionService`, the messaging service,
  the incoming-call `Activity` (MVP).
- Edit: `apps/web/android/app/src/main/AndroidManifest.xml` (permissions +
  service/account), `apps/api/src/services/fcm.ts` (data-only call push).
- Unchanged: `apps/web/src/lib/native.ts` — the JS bridge already matches.
