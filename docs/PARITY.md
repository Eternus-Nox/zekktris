# Zekktris — iOS ↔ Web Feature Parity Matrix

> **Source of truth:** the native SwiftUI app at `ios-native/Zekktris/`.
> **Mirror target:** the React/Vite web app at `apps/web/src/`.
> **Method:** every row below was checked against *real UI code* on both sides
> (SwiftUI views and React components), not against client/API method lists.
> Where a UI could not be confirmed from the code, the row is marked
> **Unverified** rather than guessed. Line numbers are approximate
> (large files; spot-check before relying on an exact line).

## Legend

- **Full** — web has an equivalent, working UI.
- **Partial** — web has some of it; specifics noted.
- **Missing** — native has it; web has no UI.
- **Unverified** — could not confirm the UI from code; needs a manual look.
- **Web-ahead** — web has it and native does **not** (parity gap in the other direction).
- Bucket **(A) Achievable** — a real web gap web could build.
- Bucket **(B) Native-only-by-nature** — web fundamentally can't match it; closest web equivalent noted.

---

## Executive summary

The web app **already mirrors the native app across the great majority of
features** — auth, guilds/channels, the full messaging surface (incl. voice
messages, polls, reactions, forwards, pins, search, scheduled send, stickers),
DMs, friends, E2EE DMs (byte-for-byte identical crypto), voice/stage, threads/
forums, scheduled events, admin, and parental controls all have working web UIs.

The genuine parity story is therefore **not** "web is far behind." It's:

1. **A small number of minor achievable web gaps** (invite QR, granular
   notification toggles, a couple of voice niceties).
2. **One real cross-client defect:** E2EE 1:1 **calls** don't decrypt between a
   native client and a web client (key-encoding mismatch). Both platforms have
   the feature; it just doesn't interoperate.
3. **A set of native-only platform capabilities** (CallKit lock-screen ring,
   VoIP push, Face ID app lock, Keychain, alternate app icons, background audio,
   haptics, status-bar theming) that web can't replicate by nature.
4. **Several places where web is actually AHEAD of native** — documented here so
   the *native* roadmap can catch up if true two-way mirroring is the goal.

---

## 1. Authentication, Account & Settings

| Feature | Native (file:line) | Web status | Web (file:line) | Bucket | Note |
|---|---|---|---|---|---|
| Login (email+password) | AuthViews.swift:119 | Full | AuthScreens.tsx:155 | — | Web also has 2FA code entry. |
| Register + password-strength meter | AuthViews.swift:281, :393 | Full | AuthScreens.tsx:283, :328 | — | Identical 4-segment meter. |
| Forgot / reset password | AuthViews.swift:199 | Full | AuthScreens.tsx:475, :565 | — | Web supports `?token` deep link. |
| Email verification gate / landing | Unverified | Full | VerifyEmail.tsx, ConfirmEmailPage.tsx | — | Native gate not located; verify whether native enforces it. |
| Status (online/idle/dnd/invisible) | MainView.swift:1579 | Full | SettingsView.tsx:614 | — | The picker shows/edits the CHOSEN status (`chosenStatus ?? status`; on a current server the self user's `status` carries the pick too, kept for older native builds) and sends every pick with `statusSource: 'manual'` (web: packages/client `patchMe`; iOS: `DevicePresence.statusPatch`), so a picked Away survives the last device disconnecting. The own avatar dot shows the effective one: our own `PRESENCE_UPDATE` frames, and before the first one the self user's `effectiveStatus ?? status`. |
| Presence follows the device in use (active / idle reported per connection) | DevicePresence.swift (AppStore auto-presence) | Full | lib/presenceActivity.ts, lib/usePresenceActivity.ts, lib/selfStatus.ts | — | iOS reports activity over the gateway (foreground + interaction within 5 min, or talking). Web: tab visible + input within 5 min (hidden = idle at once), reported by every signed-in tab whatever its route (`<PresenceActivity/>` in App.tsx, not the Shell — a forgotten /terms tab must not hold the user online); desktop app: the shell's system idle signal (10 min without input, or locked / asleep — held until unlock / resume since desktop/src/idle.ts; installed shells get that with their next shell update, older shells read a locked machine active again ~30 s after the lock until 10 min pass); talking in a call counts. Only with READY `features.presence_activity`; older servers keep the old auto-away PATCH, sent without the manual marker (web marks it `statusSource: 'auto'`), and a current server ends such an automatic idle while an updated device is in use or when the user's last device disconnects. |
| Display name / bio / gender edit | MainView.swift:1604 | Full | SettingsView.tsx:555–606 | — | Native bio/gender field not located — Unverified on native. |
| Custom status (emoji + text) | MainView.swift:1633 | Full | CustomStatusModal.tsx | — | **Web-ahead:** web adds an expiry dropdown; native has none. |
| Avatar / banner / avatar-decoration upload | MainView.swift:1500–1763 | Full | SettingsView.tsx:536–777 | — | |
| Theme selection | MainView.swift:1691 | Full | SettingsView.tsx:667 | — | |
| Change username (90-day cooldown) | MainView.swift:2025 | Full | SettingsView.tsx (UsernameSection) | — | |
| Change email / password | MainView.swift:2087 | Full | SettingsView.tsx (Email/Password sections) | — | |
| 2FA (TOTP) setup + recovery codes | Unverified | Full | SettingsView.tsx (TwoFactorSection) | (A) | Native 2FA UI not located; if absent it's an achievable gap. |
| Notification permission + enable | Push.swift:50 | Full | SettingsView.tsx:1514 | — | |
| **Granular notify toggles (messages vs calls)** | MainView.swift:1821 | **Missing** | — (none found) | **(A)** | Native has per-type toggles in UserDefaults; web only has push on/off. |
| Push token registration | Push.swift:18 (APNs) | Full (Web Push) | useNativePush.ts, native.ts:75 | (B) | Native APNs vs web Web Push; equivalents per platform. |
| Logout | Session.swift:105 | Full | AuthContext.tsx:244 | — | |
| Sessions list / revoke | Unverified | Unverified | — | — | Not confirmed on either side; check both. |
| Blocked users / privacy (DM source) toggles | Unverified | Full | SettingsView.tsx:1968–2104 | (A) | Native equivalents not located. |
| **Face ID app lock** | Session.swift:258 | **Missing** | — | **(B)** | No web biometric app-lock; closest is WebAuthn at login only. |
| Token at rest | Keychain.swift | localStorage | AuthContext.tsx | (B) | Hardware-backed Keychain vs localStorage; accepted trade-off. |

---

## 2. Navigation, Guilds, Channels, Members, Roles

| Feature | Native (file:line) | Web status | Web (file:line) | Bucket | Note |
|---|---|---|---|---|---|
| App shell (rail + sidebar + detail) | MainView.swift:9 | Full | Shell.tsx:71 | — | |
| Guild rail, ordering, folders | MainView.swift:315, :466, :527 | Full | GuildList.tsx:39–150 | — | Both sync `user.guildOrder`. |
| Guild create (blank) | MainView.swift:2258 | Full | CreateServerView.tsx:30 | — | |
| Guild create from template/backup | Unverified | Full | CreateServerView.tsx:82 | (A) | **Web-ahead:** file import; native has no picker. |
| Join via invite (modal) | MainView.swift:2314 | Full | JoinServerView.tsx:26 | — | |
| Invite preview page `/invite/:code` | Unverified | Full | InvitePage.tsx:34 | (A) | **Web-ahead:** public preview + accept; native jumps straight to a code field. |
| Quick switcher | MainView.swift (QuickSwitcherView) | Full | QuickSwitcher.tsx | — | |
| Channel list + categories + collapse | MainView.swift:572–774 | Full | ChannelList.tsx:52–150 | — | |
| Channel create / edit / delete | MainView.swift:3003, :683 | Full | ChannelCreate/EditModal.tsx | — | |
| Channel reorder (drag) | MainView.swift (ReorderChannelsView) | Full | ChannelList.tsx:94 | — | Native uses a sheet; web drags inline. |
| Channel permission overrides | MainView.swift (ChannelPermissionsView) | Full | ChannelPermissionsTab.tsx | — | |
| Member list (hoisted sections, presence, click-to-DM) | MessageViews.swift:2350 (MemberListView) | Full | MemberList.tsx:33 | — | Native comment: "matches the web MemberList." |
| Role CRUD + color + hoist + permissions | MainView.swift:3297–3500 | Full | RolesTab.tsx:40 | — | |
| Self-assignable roles | MainView.swift:3430 | Unverified | RolesTab.tsx | (A) | Web "get roles" claim UI not confirmed. |
| Reaction roles | MainView.swift:4342 | Full | ReactionRolesTab.tsx | — | |
| Guild settings (overview/roles/members/bans/danger) | MainView.swift:3523 | Full | GuildSettingsModal.tsx | — | Web consolidates into one modal; native uses separate sheets. |
| Invite create (TTL / max uses) | MainView.swift:3845 | Full | GuildSettingsModal.tsx:835 | — | |
| **Invite QR code** | MainView.swift:3882 | **Missing** | — (web `qr.ts` is 2FA-only) | **(A)** | Native renders a scannable QR for the invite link. |
| Invite list / revoke | Unverified | Full | GuildSettingsModal.tsx:936 | — | |
| Discovery (browse + categories + join) | MainView.swift:2359 | Full | DiscoveryView.tsx:38 | — | |
| Discovery opt-in settings (owner) | Unverified | Full | DiscoveryTab.tsx:25 | (A) | Native owner-side toggle not confirmed. |

---

## 3. Messaging Core

| Feature | Native (file:line) | Web status | Web (file:line) | Bucket | Note |
|---|---|---|---|---|---|
| Send text | MessageViews.swift:524 | Full | MessageView.tsx (onSend) | — | Neither uses optimistic send (intentional). |
| Markdown (bold/italic/code/strike) | MessageViews.swift:2066 | Full | MessageItem.tsx:26, markdown.tsx | — | |
| Mentions @user/@role/#channel + autocomplete | MessageViews.swift:1256, :569 | Full | useMentionAutocomplete.tsx, markdown.tsx | — | |
| Custom emoji in text + autocomplete | MessageViews.swift:1215, :580 | Full | useEmojiAutocomplete.tsx | — | |
| Reactions (picker, toggle, custom, count/me) | MessageViews.swift:947, :1502 | Full | Reactions.tsx | — | |
| Image attach + inline + lightbox | MessageViews.swift:379, :1459 | Full | Attachments.tsx, ImageLightbox.tsx | — | |
| File attachment chips | MessageViews.swift:1482 | Full | Attachments.tsx | — | |
| **Voice message — RECORD** | VoiceMessage.swift / MessageViews.swift:370 | **Full** | MessageView.tsx:1781, useVoiceRecorder.ts | — | **Verified:** web has a live-waveform recording overlay (earlier audit's "player-only" note is outdated). |
| Voice message — PLAY | VoiceMessage.swift:201 | Full | VoiceMessagePlayer.tsx | — | |
| Polls (create / vote / render) | MessageViews.swift (PollCard, CreatePollSheet) | Full | PollMessage.tsx, PollComposerModal.tsx | — | |
| Edit / delete (own) + "(edited)" | MessageViews.swift:820–1059 | Full | MessageItem.tsx | — | |
| Reply + reply preview | MessageViews.swift:911, :953 | Full | MessageItem.tsx | — | |
| Forward + forwarded block | MessageViews.swift:839, :1062 | Full | ForwardModal.tsx, ForwardedMessageBlock.tsx | — | |
| Pin / unpin + pins panel | MessageViews.swift:914, :240 | Full | PinPanel.tsx | — | |
| In-channel search | MessageViews.swift:232 (SearchSheet) | Full | SearchPanel.tsx | — | Web adds `from:`/`before:`/`after:` filter syntax. |
| Scheduled send | MessageViews.swift:404 (ScheduleSheet) | Full | SchedulePickerModal.tsx | — | |
| Stickers | MessageViews.swift:401 | Full | StickerPicker.tsx | — | |
| Send status (Sending/Failed/Retry) | MessageViews.swift:1091 | Full | MessageItem.tsx | — | |
| DM read receipts (Sent/Delivered/Read) | MessageViews.swift:138 | Full | MessageView.tsx:1228 | — | |
| Typing indicator | MessageViews.swift:503 | Full | MessageView.tsx (useTypingUsers) | — | |
| Slowmode countdown indicator | not found | **Missing** | not found | (A) | **Missing on BOTH** — server enforces; no UI hint either side. |

---

## 4. DMs, Friends, E2EE, Inboxes

| Feature | Native (file:line) | Web status | Web (file:line) | Bucket | Note |
|---|---|---|---|---|---|
| DM list + sort + presence dots | MainView.swift:996 | Full | DMList.tsx:27 | — | |
| Open/create DM | FriendsView (MainView), ProfileCard | Full | ProfileCard.tsx:472 | — | |
| Group DM UI | Unverified | Full | DMList.tsx:317 | (A) | Native group-DM rendering not confirmed. |
| Friends: list / add by username / accept / decline / cancel | MainView.swift:1213–1380 | Full | FriendsView.tsx | — | |
| Block / unblock + blocked list | MainView.swift:1360 | Full | FriendsView.tsx, ProfileCard.tsx | — | |
| Profile card (bio, status, actions) | MessageViews.swift:1017 | Full | ProfileCard.tsx | — | |
| DM settings panel (mute / TTL / read-receipt toggle) | MessageViews.swift:267 | Full | DmSettingsPanel.tsx:41 | — | |
| E2EE enable on DM | MessageViews.swift:130 | Full | DmSettingsPanel.tsx:320 | — | |
| E2EE unlock with password | E2EE.swift / MessageViews (UnlockPanel) | Full | DmSettingsPanel.tsx:517 | — | |
| E2EE crypto (PBKDF2-250k → AES-256-GCM, `zkE2EE/3:`) | E2EE.swift:1 | Full | e2ee.ts | — | Byte-for-byte identical wire format. |
| E2EE key backup / import UI | Unverified | Full | DmSettingsPanel.tsx:406–469 | (A) | Native backup/import UI not located. |
| Messaging streak counter | MessageViews.swift:214 | Full | DMList.tsx:384 | — | |
| Mentions inbox | MainView.swift:2163 | Full | MentionsView.tsx | — | |
| Saved / bookmarked messages | MessageViews.swift:2760 (SavedView) | Full | SavedView.tsx | — | |
| Scheduled messages list | MainView.swift:1089 | Full | ScheduledMessagesView.tsx | — | |
| **Cross-DM keyword search** | not present | **Web-ahead** | DMList.tsx:143 | (A) | Web searches across all DMs; native has no equivalent. |

---

## 5. Voice, Calls, Stage, Threads/Forums, Events

| Feature | Native (file:line) | Web status | Web (file:line) | Bucket | Note |
|---|---|---|---|---|---|
| Join guild voice + participant tiles | Voice.swift:51, :742 | Full | VoiceView.tsx:298 | — | Both use the orbital layout. |
| Speaking indicator | Voice.swift:38 | Full | SpeakingRing.tsx | — | |
| Mute / deafen | Voice.swift:86, :100 | Full | VoiceView.tsx, VoicePanel.tsx | — | |
| Camera on/off | Voice.swift:142 | Full | VoiceView.tsx | — | |
| **Camera flip (front/back)** | Voice.swift:133 | **Missing** | — | (A)/(B) | Web could use `facingMode`, but moot on desktop; low value. |
| Screen share | Voice.swift:121 | Full | VoiceView.tsx | — | Native app-screen (ReplayKit); web tab/window. |
| Video / screen-share tiles | Voice.swift:445 | Full | VoiceView.tsx | — | |
| **Per-user volume control** | not present (SDK limit) | **Web-ahead** | UserVolumePopover.tsx | — | Native can only mute-for-me, not adjust volume. |
| Mute-for-me (per user) | Voice.swift:162 | Full | UserVolumePopover.tsx | — | |
| **Mic level meter** | not present | **Web-ahead** | MicLevelMeter.tsx | — | |
| Voice panel (minimized strip) | Voice.swift:979 | Full | VoicePanel.tsx | — | |
| Global minimized call bar | Voice.swift:1281 | Unverified | GlobalCallOverlay.tsx | (A) | Confirm web renders a persistent bar vs only modals. |
| 1:1 incoming / outgoing call modal | Voice.swift:898, :1243 | Full | IncomingCallModal.tsx, OutgoingCallModal.tsx | — | In-app ring both sides. |
| **CallKit lock-screen system ring** | CallManager.swift:65 | **Missing** | — | **(B)** | Web closest: in-app modal + browser notification (only while a tab is alive). |
| Call mute / hangup | Voice.swift | Full | IncomingCallModal/VoiceView | — | |
| **E2EE 1:1 call (cross-client interop)** | Voice.swift:56 | **Partial / broken** | VoiceView.tsx:313 | (A) | Both encrypt, but native keys from a base64 *string* and web from raw bytes → native↔web calls don't decrypt. See "Cross-cutting." |
| Stage: join / speakers / audience / raise hand / promote | Voice.swift:1062–1221 | Full | StageChannelView.tsx | — | |
| Threads: list | ThreadViews.swift:6 | Full | ForumView.tsx | — | |
| Start thread from a message | Unverified | Full | MessageView.tsx (context) | (A) | Native message→thread entry point not confirmed. |
| Forum: post list + create post | ThreadViews.swift:6, :131 | Full | ForumView.tsx | — | |
| Events: create / list / RSVP / attendees / status / edit / cancel | MainView.swift:4727–4950 | Full | EventsModal.tsx, CreateEventModal.tsx, MyEventsModal.tsx, EventAttendeesModal.tsx | — | |
| Starfield voice background (cosmetic) | Voice.swift:1355 | Unverified | VoiceView.tsx | (A) | Web may use a plain/gradient background. |

**Android native (`android-native/`) — E2EE 1:1 calls, multi-device presence.** This matrix is iOS ↔ web;
the Android client is tracked here only where it has to interoperate with both.

| Feature | Android (file) | Status | Note |
|---|---|---|---|
| E2EE 1:1 call media encryption | voice/CallEncryption.kt, voice/VoiceManager.kt, AppStore.kt `joinVoice` | Full (not yet device-tested) | Keys LiveKit exactly like web (`getCallKeyString` → `ExternalE2EEKeyProvider.setKey`) and iOS (`BaseKeyProvider(isSharedKey:sharedKey:)`): the base64 of the 32-byte DM key as a shared-key STRING → PBKDF2, salt `LKFrameEncryptionKey`, ratchet window 0, GCM — so Android ↔ web ↔ iOS calls share one media key. A DM whose key isn't unlocked (or is stale) refuses the call instead of joining in the clear. Before this, Android joined E2EE DM calls unencrypted. |
| Multi-device presence (status follows the device in use) | data/DevicePresence.kt, data/Gateway.kt `setPresenceActive`, AppStore.kt `noteInteraction`, MainActivity.kt `onUserInteraction` | Full (not yet device-tested) | Same protocol as web/iOS: the phone is active while MainActivity is started and was touched (or typed in, or talked in voice) within 5 minutes, idle at once in the background; reported in IDENTIFY/RESUME and as op 3 `PRESENCE_UPDATE {active}` on each change, only when READY carries `features.presence_activity`. The Settings picker shows and sets `chosenStatus` (`status` carries the pick too), sending each pick with `statusSource: "manual"` (`ProfilePatch.statusPick`); the own dot shows the effective status from our own `PRESENCE_UPDATE`s, before the first one the self user's `effectiveStatus ?: status`. Android never auto-PATCHed status, so an older server sees no change. A rotation / other configuration change is not a background (no idle flash). Known gap: touches inside Compose dialogs and bottom sheets (separate windows) don't reach `onUserInteraction`, so 5+ minutes spent only inside one reads idle. |

---

## 6. Admin, Moderation, Family (Parental Controls), Platform

| Feature | In native? | Web status | Web (file:line) | Bucket | Note |
|---|---|---|---|---|---|
| Admin stats / recent activity | Yes (MainView.swift:2488) | Full | AdminPanel.tsx:166 | — | |
| Admin user search + ban/unban | Yes (MainView.swift:2568) | Full | AdminPanel.tsx:490, :414 | — | |
| Promote/demote admins | **No** | Full | AdminPanel.tsx:435 | (A) | **Web-ahead.** |
| Force-logout user | **No** | Full | AdminPanel.tsx:458 | (A) | **Web-ahead.** |
| Delete user account | **No** | Full | AdminPanel.tsx:470 | (A) | **Web-ahead.** |
| Guild list + delete | Yes (MainView.swift:2523) | Full | AdminPanel.tsx:678 | — | |
| Ghost-mode observe (read-only) | Yes (MainView.swift:5658) | Full | AdminPanel.tsx:1273 | — | |
| Storage breakdown + GC file manager | **No** | Full | AdminPanel.tsx:800–1250 | (A) | **Web-ahead.** |
| Security tab (spam config, banned words, event log) | Yes (MainView.swift:6375) | Full | AdminSecurityTab.tsx | — | |
| Family: request/accept supervision, manage children | Yes (MainView.swift:2802–2862) | Full | FamilySettings.tsx:224 | — | |
| Child restrictions (friends/voice/video/stream/create) | Yes (MainView.swift:2907) | Full | FamilySettings.tsx:690 | — | |
| Blocked guilds / view child DMs & friends | Yes (MainView.swift:2944) | Full | FamilySettings.tsx:686 | — | |
| Watch words + flagged-message feed | **No** | Full | FamilySettings.tsx | (A) | **Web-ahead.** |
| APNs push | Yes (Push.swift) | n/a | — | (B) | Native-only delivery channel. |
| Web Push (service worker) | n/a | Full | native.ts:75 | (B) | Web-only delivery channel. |
| PushKit VoIP background wake | Yes (Push.swift:110) | Missing | — | (B) | No web equivalent. |
| CallKit system UI | Yes (CallManager.swift) | Missing | — | (B) | In-app modal is the closest. |
| Background audio session | Yes (project.yml:49) | Missing | — | (B) | Browsers suspend audio on lock. |
| Face ID app lock | Yes (Session.swift:258) | Missing | — | (B) | — |
| Keychain secure storage | Yes (Keychain.swift) | Missing | — | (B) | localStorage on web. |
| Alternate app icons per theme | Yes (project.yml:64) | Missing | — | (B) | No web equivalent. |
| Status-bar theming | Yes (native.ts bridge) | Missing | — | (B) | — |
| Haptics | Unverified | Missing | — | (B) | No native haptic code confirmed yet. |
| Custom fonts (Space Grotesk / JetBrains Mono) | Yes (Theme.swift) | Full | index.html:107, index.css | — | **Verified:** web loads both via Google Fonts. |
| Desktop notifications / PWA install | n/a | Web-ahead | desktopNotify.ts, pwa.ts | (B) | Web/Electron-only. |

---

## Bucket (1): Achievable web gaps (web could build these)

Ordered roughly by impact ÷ effort. Most are small; web is at/ahead of parity overall.

1. **E2EE 1:1 call interop (native ↔ web)** — *cross-cutting defect, highest impact.*
   Both clients encrypt call media, but they derive the frame-crypto key
   differently (native: base64 **string** fed to LiveKit's shared-key API; web:
   raw 32 bytes). Native↔native and web↔web work; native↔web is garbled. Fixing
   it requires aligning the key material on one side (web keys from the same
   base64 string, or native injects raw bytes via a custom key provider).
   *Needs a product decision on which side moves; see Open questions.*
2. **Granular notification toggles (messages vs calls)** — native has per-type
   toggles; web only exposes push on/off. Add toggles to `SettingsView.tsx`
   notification section.
3. **Invite QR code** — native renders a scannable QR for invite links; web only
   copies the URL. `qr.ts` already exists (used for 2FA) and can be reused in the
   invite UI.
4. **2FA setup UI on native is unverified** — if native lacks it, that's a
   *native* gap, not web; flagged for the inverse roadmap.
5. **Camera flip** — web could use `getUserMedia` `facingMode`, but it's near-
   meaningless on desktop; low priority.
6. **Slowmode countdown indicator** — missing on *both*; small shared add.

> Beyond these, the achievable list is thin because the web app already mirrors
> native. The larger backlog is the **inverse** (native catching up to web): see
> the Web-ahead rows — per-user volume, mic meter, cross-DM search, storage admin,
> force-logout, delete-account, watch-words/flagged-messages, guild import,
> invite preview page, custom-status expiry, admin promote/demote.

## Bucket (2): Native-only-by-nature (web can't match) + closest web equivalent

| Native capability | Why web can't | Closest web equivalent |
|---|---|---|
| CallKit lock-screen ring / system call UI | No OS call API in browser | In-app modal + (while tab alive) Notification |
| PushKit VoIP background wake | No browser VoIP entitlement | Web Push (can't wake a closed app to a call) |
| Face ID app lock | No browser app-lock biometric | WebAuthn at login only |
| Keychain secure storage | No hardware-backed store in browser | localStorage (HTTPS-scoped) |
| Alternate app icons per theme | No home-screen icon API | Favicon/theme-color only |
| Background audio session | Browsers suspend audio on lock | none |
| Status-bar theming | No status bar on web | `theme-color` meta (PWA) |
| Haptics | No reliable web haptic API | none |

---

## Unverified items to resolve (honesty list)

These could not be confirmed from code and should be checked manually before
acting (don't assume a gap exists):

- **Native:** email-verification gate, bio/gender fields, sessions list/revoke,
  2FA UI, blocked-users/privacy settings UI, self-assignable-role claim UI,
  discovery owner opt-in, group-DM rendering, E2EE key backup/import UI,
  start-thread-from-message entry point, global minimized call bar, haptics.
- **Web:** sessions list/revoke, whether `GlobalCallOverlay` renders a persistent
  call bar vs only modals, starfield voice background.
- Several **line numbers** are agent-approximated in large files
  (`MainView.swift`, `MessageViews.swift`); treat as pointers, not exact.

---

## Recommended prioritized web work items (toward parity)

1. **Fix E2EE 1:1 call interop (native ↔ web).** The only feature both platforms
   have that silently fails across them — directly breaks "iOS and web mirror
   each other." Decide which side re-keys, then implement (web side is plausibly
   the smaller change: key the web call provider from the same base64 string the
   native side uses).
2. **Add granular notification toggles (messages vs calls) to web Settings** to
   match native's per-type controls. Small, self-contained.
3. **Add invite QR-code generation to the web invite UI**, reusing the existing
   `qr.ts`. Small; improves cross-device sharing parity with native.

Then sweep the **Unverified** list (esp. sessions list/revoke and native 2FA) so
the matrix is fully grounded, and — if true two-way mirroring is the goal —
open a separate **native** backlog from the Web-ahead rows.
