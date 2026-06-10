# Zekktris — Engineering Roadmap

> **Status:** working doc, analysis only (not committed as part of a feature).
> **Companion:** [`PARITY.md`](./PARITY.md) holds the web-side gaps (web vs iOS).
> This doc adds the **native-side gaps** (iOS vs web), a **consolidated two-way
> parity backlog**, **outstanding bugs** (re-validated + freshly hunted), and
> **optimizations**, ending with a **recommended execution order**.
>
> **Method:** every parity row was checked against real SwiftUI/React UI code,
> not API/DTO presence; items that couldn't be confirmed are marked
> **Unverified**. Bug items cite `file:line` and mark confirmed vs suspected.
> Source of truth front end = native iOS (`ios-native/`); web mirrors it.

> ### ⭐ Design principle: iOS is the visual/layout source of truth
> The user's standing preference: the **native iOS app is the canonical
> visual / layout / design reference, and all web UI should mirror the iOS
> look and layout.** When building or changing any web component, look at the
> corresponding SwiftUI view in `ios-native/Zekktris/*.swift` first and match
> its layout, structure, spacing, and visual style.
>
> **This is a DISTINCT workstream from feature parity.** The backlog in §1–§3
> is *feature-level* (does a capability exist on each side). **"Web visual
> alignment to iOS"** is a separate, ongoing concern that applies even where
> both sides already have the feature — it is not yet broken out as line items
> below. Treat it as a cross-cutting requirement on every web UI change, and a
> future dedicated pass to audit existing web screens against their iOS
> counterparts.

---

## 1. Native parity gaps — the inverse of PARITY.md (iOS vs web)

What the **web** has that the **native iOS** app is missing or only partially
implements. Verified against `ios-native/Zekktris/*.swift`.

| Feature | Native status | Evidence | Note |
|---|---|---|---|
| Per-user **volume slider** in voice | **Missing** | `Voice.swift` (mute-for-me only) | LiveKit Swift SDK exposes no remote-volume API; needs a workaround (per-track gain) or accept partial. |
| **Mic level meter** / input test | **Missing** | none found | Web has `MicLevelMeter.tsx` in settings; native has no input meter. |
| **Cross-DM search** (search box over all DMs) | **Missing** | `MainView.swift:996` (DM list, no search) | Native search is per-channel only. |
| **Guild import** from template/backup file | **Missing** | none found | Web `CreateServerView` imports a JSON backup; native only blank-create or invite-join. |
| **Start thread from a message** (context menu) | **Missing** | `MessageViews.swift:899` (menu has Reply/Pin/Forward/Save/Edit/Delete, no "Start thread") | Thread *list/forum* UI exists; the entry point to spin a thread off a message does not. |
| **2FA / TOTP setup** (QR + recovery codes) | **Missing** | none found | Backend 2FA is complete; native has no enrollment UI. |
| **Custom-status expiry** (duration dropdown) | **Missing** | `MainView.swift:3910` (text/emoji only) | Web offers 30m/1h/4h/today/this-week. |
| **Sessions list / revoke** (active devices) | **Missing** | none found | `Session.swift` is auth-token only; no device-management screen. |
| Parental **watch-words** + **flagged-messages feed** | **Missing** | `MainView.swift:2776-6100` (linking, restrictions, child DM/guild/friends present) | The proactive keyword-monitoring + alert feed is absent (rest of family is built). |
| **E2EE key backup/export + import** | **Unverified→likely Missing** | `MessageViews.swift:199` (lock badge only) | Web `DmSettingsPanel` has download/import; no native equivalent found. |
| Admin **delete-account** | **Missing** (rest Partial) | `MainView.swift:2604-2633` (force-logout + promote/demote present) | Only account deletion is missing from the admin user actions. |
| Invite **preview-then-join** page | **Partial / Unverified** | `MainView.swift:1150` | Native takes a code and joins; web shows a guild preview card first. |
| **Webhooks management UI** | **Unverified** | API + `AppStore` loaders present; rendered UI not confirmed | Verify whether a create/list/delete screen is wired. |
| **Achievements shelf** rendering | **Unverified** | `achievementsPublic` toggle exists; shelf not confirmed | Verify the profile shelf renders. |

**Well-covered on native (Full parity — no action):** admin (stats, user
ban/unban, guild list+delete, storage breakdown+GC, security tab, ghost-mode
observe), family base (supervision/restrictions/blocked-guilds/child DM+friends
viewing), events (create/RSVP/attendees), scheduled messages, saved messages,
self-assignable roles, discovery owner opt-in, reaction-roles, quick switcher,
pins panel, per-channel search, slowmode, "(edited)" marker, group DMs.

---

## 2. Web parity gaps — from PARITY.md (web vs iOS)

What the **native** has that the **web** is missing (the short list — web is
otherwise at/ahead of parity).

| Feature | Web status | Note |
|---|---|---|
| **Granular notification toggles** (messages vs calls) | Missing | Native has per-type toggles; web only has push on/off. |
| **Invite QR code** | Missing | Native renders a scannable QR for invite links; web only copies the URL. `apps/web/src/lib/qr.ts` already exists (2FA) and can be reused. |
| **Slowmode countdown indicator** | Missing (both) | Server enforces it; neither client shows a "wait Ns" hint. |

---

## 3. Consolidated two-way parity backlog

Completing this table makes web and iOS feature-identical (genuinely
native-only items are split out in §4). Effort: S(≤0.5d) / M(1–3d) / L(>3d).

| # | Item | Build on | Description | Key files | Effort | Impact |
|---|---|---|---|---|---|---|
| P1 | Granular notification toggles | **Web** | Per-type (messages vs calls) toggles to match native | `apps/web/src/app/SettingsView.tsx` | S | Med |
| P2 | Invite QR code | **Web** | Render QR in invite UI, reuse `qr.ts` | `apps/web/src/app/GuildSettingsModal.tsx`, `lib/qr.ts` | S | Low |
| P3 | Custom-status expiry | **Native** | Duration dropdown on custom status | `MainView.swift` (settings/status) | S | Low |
| P4 | Admin delete-account | **Native** | Add delete-account to admin user row (API exists) | `MainView.swift` (admin users), `APIClient.swift` | S | Low |
| P5 | Start-thread-from-message | **Native** | Add "Start thread" to message context menu | `MessageViews.swift:899` | S | Med |
| P6 | Sessions list / revoke | **Native** | Active-devices screen + revoke (API exists) | `MainView.swift` (settings), `APIClient.swift` | M | Med |
| P7 | E2EE key backup/export + import | **Native** | Mirror web download/import of DM keys | `MessageViews.swift`/new view, `E2EE.swift`, `Keychain.swift` | M | Med |
| P8 | Cross-DM search | **Native** | Search box across all DMs | `MainView.swift` DM list, `APIClient.swift` | M | Med |
| P9 | Mic level meter / input test | **Native** | Input meter in voice/settings | new view + `Voice.swift` | M | Low |
| P10 | 2FA / TOTP setup UI | **Native** | QR enrollment + recovery codes | new settings view, `APIClient.swift` | M | Med |
| P11 | Parental watch-words + flagged feed | **Native** | Keyword list + flagged-messages feed (backend `flagged_messages` exists) | `MainView.swift` family, `APIClient.swift` | L | Med |
| P12 | Guild import from backup | **Native** | File picker → import endpoint | `MainView.swift` create-server, `APIClient.swift` | M | Low |
| P13 | Per-user volume control | **Native** | Per-remote-participant gain (SDK has no native volume API — needs custom audio tap) | `Voice.swift` | L | Low |
| P14 | Slowmode countdown indicator | **Both** | "wait Ns" hint in composer | `MessageView.tsx` / `MessageViews.swift` | S | Low |
| P15 | Invite preview-then-join | **Native** | Show guild preview card before accept | `MainView.swift` | S | Low |
| P16 | Verify + finish: webhooks UI, achievements shelf, invite-preview | **Native** | Confirm Unverified items; build if absent | `MainView.swift` | S–M | Low |

---

## 4. Native-only-by-nature (NOT chased for parity)

Platform capabilities web fundamentally can't match — keep out of the parity
backlog. (Closest web equivalents noted in PARITY.md §"Bucket 2".)

- **iOS-only:** CallKit lock-screen call UI, PushKit VoIP background wake, APNs
  push, Face ID app lock, Keychain secure storage, alternate app icons per
  theme, background audio session, haptics, status-bar theming.
- **Web/desktop-only (the inverse — not chased on iOS):** PWA install prompts,
  Electron desktop notifications, browser Web Push.

---

## 5. Outstanding bugs

### 5a. Re-validated prior items (status against CURRENT code)

| Item | Status now | Evidence | Action |
|---|---|---|---|
| Channel **reparent** not refreshing gateway permission cache | **FIXED** | `routes/channels.ts:670-687` calls `applyGuildPermissionChange` when any `parentId` changed | none |
| Voice 45s grace / eviction races (double-evict, banned-still-in-voice) | **OK** | `gateway/server.ts:103-138` cancels on reconnect; banned users fail IDENTIFY (`:410`) | none |
| Gateway **RESUME** unimplemented | **Open (Low)** | `gateway/server.ts:316-320` rejects with `resumable=false` | Defer (v1.x replay buffer) |
| `applyGuildPermissionChange` fan-out cost | **Open (Med, scale-only)** | `gateway/dispatch.ts:1027-1066` — permission compute is batched (~constant queries), but per-user refresh + **voice eviction runs N parallel** on bulk flips | Batch/serialize voice evictions; cap concurrency |
| Session-revocation **eventual consistency** | **Open (Med-High)** | `auth/middleware.ts:9-13`, `auth/tokens.ts:60-84` — REST hot path checks JWT only; `/refresh` re-checks ban/delete but other endpoints don't. Window ≈ `ACCESS_TOKEN_TTL` (~15m) after logout/ban | Redis token/session blacklist (deferred) |
| `FIELD_ENCRYPTION_KEY` rotation footgun | **Open (Med)** | `lib/fieldCrypto.ts` envelope `enc:v1:…` has no **key id**; single key; no re-encrypt path. Rotation → TOTP/bot secrets undecryptable | Add key-id to envelope + a re-encrypt migration; document rotation |
| automod **ReDoS** | **Open (Low-Med)** | `services/automod.ts:385-401` compiles admin `regex_pattern` rules and `.test()`s message content; no message-length bound for regex eval | Bound content length before regex; consider timeout/RE2 |
| Deleted **category** leaves stale viewable-channel cache | **Open (Low, cosmetic)** | delete path dispatches CHANNEL_DELETE but not `applyGuildPermissionChange`; stale ids emit no events so no leak | Call `applyGuildPermissionChange` on category delete |

### 5b. New findings (fresh hunt)

| # | Severity | Area | `file:line` | Symptom | Fix sketch | Confidence |
|---|---|---|---|---|---|---|
| B1 | **High** | E2EE / DM | `routes/dms.ts:298-328`, `services/dms.ts:428-456` | `e2ee-disable` only checks `ensureRecipient` — a recipient who doesn't know the passphrase can disable E2EE **and purge all encrypted history** (no verifier check) | Require `verifier` in the disable body; reject unless it matches `channel.e2eeVerifier` before purging | **Confirmed** |
| B2 | **Med-High** | E2EE / DM | `services/dms.ts:396-409` (enable), `:428-456` (disable) | enable/disable UPDATE has no guard on current `e2eeEnabled`; concurrent enables from both sides clobber salt/verifier → mismatched keys → handshake fails | Conditional UPDATE (`WHERE e2eeEnabled = false/true`) returning the row; treat 0-rows as "already in that state" | **Confirmed** |
| B3 | **High (if APNs/VoIP on)** | Push / VoIP | `services/apns.ts:252-255,267-270,294` | Uses `schema.deviceTokens` (an **undefined** export — real name `apnsDeviceTokens`) on the **`ios_voip`** token path → Drizzle throws at runtime when VoIP push send/cleanup runs; also breaks `pnpm typecheck` | Rename to `schema.apnsDeviceTokens` on those lines | **Confirmed** |
| B4 | Low | Typecheck | `services/security.ts:327` | `match[1]` flagged possibly-undefined → `pnpm typecheck` red | `match[1]!` / `match[1] ?? ''` (regex has 1 capture group) | **Confirmed** |
| B5 | Low | DM relationship | `services/dms.ts:80-189` | TOCTOU: block lands between `canReachByDmOrCall` and INSERT → DM created despite a just-placed block | Re-check block inside the tx, or accept (low impact) | Confirmed (low) |

> Re-validation cleared several previously-feared items (per-channel fanout
> filter, presence/typing for invisible users, DM voice recipient gating,
> registry index desync, refresh-token rotation, password-reset single-use, CDN
> XSS, supervision↔E2EE suppression) — all currently sound. Good signal.

---

## 6. Optimizations

| # | Side | `file:line` | What | Impact | Effort | Fix sketch |
|---|---|---|---|---|---|---|
| O1 | Web | `state/AppState.tsx`; **45** files on `useAppState()` vs **3** on `useAppStateSelector()` | Broad context hook re-renders every consumer on every dispatch (presence/typing/receipts fire constantly) | **High** | M (incremental) | Migrate hottest consumers to `useAppStateSelector`: `MemberList.tsx:43`, `ChannelList.tsx:54`, `DMList.tsx:28` first |
| O2 | Web | `ChannelList.tsx:487/832/940/1041/1187`, `DMList.tsx:293/256` | List **row** components not `React.memo`'d → re-reconcile on parent re-render | Med | S | Wrap rows in `memo`; `useCallback` their handlers (do after O1 for it to bite) |
| O3 | **Native** | `AppStore.swift:572-580` | `loadDMs` **overwrites** the live presence map wholesale → a concurrent `PRESENCE_UPDATE` is clobbered back to a stale REST snapshot (stale "offline" dots on every launch/resume) | **High** | S | Merge into existing map (fill gaps only), or one-shot guard like web does for members |
| O4 | Backend | `routes/users.ts:831-846`, `routes/guilds.ts:2117-2131` | N+1: `countRsvpsByStatus` per event in a `.map` → N sequential queries on "My Events" | Med | M | Add a batch `countRsvpsByStatusBatch(eventIds)` |
| O5 | Backend | `routes/messages.ts:509` | Sequential `await deleteAttachmentFile` per file on message delete | Low | S | `Promise.all(...)` |
| O6 | Native | `MessageViews.swift:2066-2076` | `markdownAttributed()` re-parses on every row render | Low-Med | M | Cache parsed `AttributedString` per message id/content |
| O7 | Web | modals in `app/` (~13 not split) | Heavy modals eager-loaded (EventsModal, PollComposerModal, StickerPicker, EmojiPicker, …) | Low-Med | M | `React.lazy` the infrequently-opened ones |

> Note: `MessageItem` is **already** memoized (`useMemo` at `MessageItem.tsx:357`,
> `memo()` at `:1050`) — not an optimization target. It's the model to copy for O1.

---

## 7. Recommended execution order

Grouped to do **one item at a time**, ordered by risk/value/dependency. Earlier
phases are small, low-risk, and unblock the rest.

**Phase 0 — Green the tree (correctness + CI hygiene; low risk).**
1. **B3** — `apns.ts` `deviceTokens → apnsDeviceTokens` (latent VoIP-push runtime crash + typecheck red). *(You just shipped PushKit VoIP — this is in that path.)*
2. **B4** — `security.ts:327` non-null/`??`. After 0–1, `pnpm typecheck` is green repo-wide.

**Phase 1 — E2EE correctness/security (contained, testable, same file).**
3. **B1** — require verifier on `e2ee-disable` (block passphrase-less purge).
4. **B2** — atomic enable/disable state guard. Add API tests alongside.

**Phase 2 — High-impact, tiny fixes.**
5. **O3** — native presence-map merge (stale-offline-dots; one function).

**Phase 3 — Parity quick wins (small each; ship in a batch).**
6. **P1** web notification toggles · **P2** web invite QR · **P3** native custom-status expiry · **P4** native delete-account · **P5** native start-thread-from-message · **P14** slowmode indicator.

**Phase 4 — Perf foundation (incremental, high payoff).**
7. **O1** selector migration for `MemberList`/`ChannelList`/`DMList`, then **O2** memo their rows. Land component-by-component.

**Phase 5 — Larger parity features (one per cycle).**
8. **P6** sessions list · **P8** cross-DM search · **P10** 2FA setup · **P7** E2EE key backup/import · **P11** watch-words/flagged feed · **P9** mic meter · **P12** guild import · **P15/P16** preview + verify webhooks/achievements · **P13** per-user volume (SDK-limited; scope first).

**Phase 6 — Scale/ops & deferred hardening (no user-visible regression today).**
9. **O4/O5** backend N+1 · **5a:** voice-eviction fan-out batching, deleted-category cache cleanup, automod regex bound · **session-revocation Redis blacklist** · **FIELD_ENCRYPTION_KEY** versioning+migration · **gateway RESUME**.

**Sequencing rationale:** Phase 0 removes a real latent crash and unblocks
typecheck/CI for everything after. Phase 1 fixes the only *security* findings
while the E2EE code is fresh in mind (one file, easy to test). Phase 2 is a
one-function, high-impact UX fix. Phase 3 clears the small parity deltas cheaply.
Phase 4 is the biggest perf lever but wants its own focused, incremental effort.
Phases 5–6 are larger builds and deferrable ops work with no regression risk to
today's behavior.
