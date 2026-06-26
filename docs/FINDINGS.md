# Zekktris — Findings & Proposals

> Working document (like ROADMAP.md). Produced from a broad code audit across API
> services, gateway/realtime, auth/security, DB/queries, web, native iOS, voice/LiveKit,
> E2EE, and ops/infra. Every item was verified against the code; file:line references
> are exact at time of writing.
>
> **Status update (2026-06-10):** a re-verification + fresh-audit session resolved most
> of this document. See **Appendix C** for what was fixed and what remains; the per-item
> bodies below are kept for historical context but their file:line refs may have drifted.
>
> Three sections: **1) Bugs**, **2) Optimizations**, **3) Enhancement features** — each
> prioritized high → low. An appendix lists what was already fixed this session (not re-listed).

---

## Executive summary

The codebase is in strong shape — the auth core, SSRF guards, markdown escaping, E2EE, and
field-crypto rotation are all sound, and several of the worst items from earlier passes are
already fixed (see appendix). The audit surfaced a focused set of **new** issues:

**Most important bugs**
1. **`reset-password` doesn't blacklist sessions** — a stolen access token keeps full REST
   access for ~15 min after a password reset; the prompt-revocation mechanism added this
   session is bypassed on this one path. *(High, security)*
2. **Scheduled-message worker can double-send** — `fetchDue` has no row claim/lock, so an
   overlapping tick (or any second worker) re-selects and re-sends the same due rows. *(High, data integrity)*
3. **RESUME is advertised but unimplemented** — the gateway stamps sequence numbers and the
   protocol implies RESUME, but the op is hard-rejected with no replay buffer, so every
   reconnect silently loses all events in the gap. *(High, realtime)*
4. **Stage roster leak** — losing `VIEW_CHANNEL` on (or deletion of) a stage channel evicts
   the user but never broadcasts `STAGE_PARTICIPANTS_UPDATE`, so everyone else still sees
   them on stage until a client poll masks it. *(High, realtime)*
5. **Web tears down the WebSocket on every profile/user change** — changing your status or
   saving settings closes + reopens the gateway, dropping live events and firing a full
   resync storm. *(High, web)*

**Highest-value optimizations**
1. **`resolveBotByToken` full-table-scans `users` on every bot request** — no index on
   `bot_token_hash`. *(High, trivial fix)*
2. **Web over-rendering** — `MessageItem` re-renders on *any* message in *any* channel, and
   45 components use the non-selector `useAppState()` so they re-render on every dispatch.
3. **Native message rows re-parse markdown/regex every render**, and the whole `@Published
   messages` array republishes on each per-row edit (reaction/receipt) → full list re-render.
4. **Reconnect N+1** — READY issues one viewable-channels resolver call per guild; presence
   flips publish one event per guild.

**Most compelling enhancements** (most build directly on code that already exists):
admin **observability/metrics dashboard**, first-class **backup/restore**, **SSO/OIDC**,
finishing the **Redis-backed rate-limit + revocation** multi-node story, an **audit-log
viewer**, turning on the latent **bot/slash-command platform**, a **reports/moderation
triage queue**, and an in-app **voice/LiveKit diagnostic** ("the #1 self-host gotcha").

---

# 1. BUGS

## High

### B1. `reset-password` revokes sessions but skips the blacklist — stolen token survives ~15 min
**Area:** auth/security · **File:** `apps/api/src/routes/auth.ts:725-728`
The handler does a raw `UPDATE sessions SET revokedAt = now()` and force-closes gateway
sockets, but never calls `blacklistSession()`. So `requireAuth`'s blacklist check (the
prompt-revocation mechanism) never fires for these sessions, and any still-valid access
token keeps authenticating every REST endpoint until natural JWT expiry
(`ACCESS_TOKEN_TTL_SECONDS`, ~15 min). The user believes "logged out everywhere," but an
attacker's token persists. The correct pattern is right next door in
`apps/api/src/auth/sessions.ts:153-160` (`revokeAllUserSessions` → `blacklistSession` per row).
**Fix:** replace the inline UPDATE with `revokeAllUserSessions(userId)` (which already blacklists).

### B2. Scheduled-message worker has no claim/lock — duplicate sends on overlapping ticks
**Area:** API services · **File:** `apps/api/src/services/scheduledMessages.ts:135-148`, worker `apps/api/src/index.ts:319-423`
`fetchDue()` does a plain `SELECT ... WHERE scheduled_for <= now AND attempts < 3 LIMIT 50`
with no `FOR UPDATE SKIP LOCKED`, no status column, and no claim step; the loop runs on a
60s `setInterval`. If a tick's work exceeds 60s, the next tick re-selects the same
not-yet-deleted rows and sends them again. A second worker process (HA) makes it guaranteed.
**Fix:** atomic claim — `UPDATE ... SET attempts = attempts+1 WHERE id IN (SELECT id ... FOR UPDATE SKIP LOCKED LIMIT 50) RETURNING *`, or a re-entrancy guard so overlapping ticks can't run concurrently.

### B3. RESUME unimplemented while seq is advertised — every reconnect silently drops events
**Area:** gateway/realtime · **File:** `apps/api/src/gateway/server.ts:316-319`, `apps/api/src/gateway/connection.ts:77,221-256`
Every DISPATCH gets a monotonic `s` (seq) and the docs imply RESUME, but the RESUME op is
rejected with `INVALID_SESSION resumable=false` and there's no replay buffer. On any WS blip
(WiFi↔LTE, iOS WS suspension — the exact case the 45s voice grace exists for), the client
must re-IDENTIFY and loses every message/reaction/typing/presence event in the gap. READY
re-hydrates membership/voice/read-state but not the missed events.
**Fix:** either implement a bounded per-session ring buffer keyed by seq and honor RESUME, OR
drop the seq advertisement and have clients do a full reconcile (re-fetch recent messages per
open channel) after every reconnect. The current half-state is the worst of both.

### B4. Stage roster leak on permission-loss / channel-delete eviction
**Area:** gateway/voice · **File:** `apps/api/src/gateway/dispatch.ts:964-977`; `apps/api/src/services/voice.ts:750-752` + `apps/api/src/routes/channels.ts:254-268`
When a user loses `VIEW_CHANNEL` on a *stage* channel (or it's deleted), their
`stage_participants` row is deleted and `VOICE_STATE_UPDATE` is broadcast, but
`STAGE_PARTICIPANTS_UPDATE` is **not**. The stage roster UI is driven solely by the latter, so
every other participant keeps seeing the evicted user on stage until the 4s client poll masks
it (clients without the poll never converge).
**Fix:** after the `stage_participants` delete in both paths, re-list and emit
`stageParticipantsUpdate({ guildId, channelId, participants })`.

### B5. Web tears down + reopens the WebSocket on every profile/user change
**Area:** web · **File:** `apps/web/src/app/auth/AuthContext.tsx:176-224` (effect deps `[gateway, state.token, state.user]`)
The gateway lifecycle effect depends on the `state.user` object reference. Any
`updateUser()` / `getMe()` (custom status, profile edit, avatar upload, settings save)
replaces `state.user`, firing the cleanup `gateway.stop()` (close 1000) then `gateway.start()`.
During the reconnect window all gateway events drop, plus a spurious READY resync storm fires
(`refreshGuilds` + `loadDMs` + `loadReadStates` + per-guild loads). Changing your status
mid-conversation can silently drop incoming messages.
**Fix:** gate on booleans — `const isAuthed = !!state.token && !!state.user` and depend on
`[gateway, isAuthed]`; the client already reads the live token via `tokenRef`.

### B6. Native acks a read on *every* incoming message — ack spam + marker-regress race
**Area:** native iOS · **File:** `ios-native/Zekktris/AppStore.swift:720-740`, MESSAGE_CREATE path ~2567/2614
On each `MESSAGE_CREATE` for the open channel, `markChannelRead` fires `POST /messages/:id/ack`.
In a busy channel that's one POST per message; the ack `Task` re-reads `readStates[channel.id]`
after `await`, so interleaved tasks can regress the marker (the GREATEST guard only compares
against the current local value a concurrent task may have already advanced). Also re-renders
the rail on every `@Published readStates` write.
**Fix:** debounce — coalesce to the newest id on a short trailing timer (1–2s).

## Medium

### B7. Image decompression-bomb — `sharp` decodes with no `limitInputPixels`
**Area:** security/DoS · **File:** `apps/api/src/services/uploads.ts:679` (reached from `:128`), admin recompress `:767`
The server-side WebP backstop runs `sharp(input, { failOn: 'none' })` then `.metadata()/.toBuffer()`
with no pixel cap. A few-KB PNG/JPEG that decodes to e.g. 50000×50000 forces full-raster
allocation → OOM/stall of the API worker. Any authenticated user can trigger it via normal
attachment upload.
**Fix:** pass `{ limitInputPixels: 24_000_000 }` (or `true` for sharp's default) and reject when
`width*height` exceeds the cap before `toBuffer()`.

### B8. Parental `allowCreateGuild` restriction is enforced but unsettable
**Area:** security/safety · **File:** `apps/api/src/routes/family.ts:273-279`
Enforcement exists (`routes/guilds.ts:87-88,233-234`) and the column defaults to `true`, but the
parent-facing PATCH schema (`restrictionsPatch`) omits `allowCreateGuild`, so a guardian can
never set it to `false`. A supervised child can always create guilds. Silent parental-controls gap.
**Fix:** add `allowCreateGuild: z.boolean().optional()` to `restrictionsPatch` (service already passes the patch through).

### B9. Guild-join supervision approval keys on a mutable invite code, not the displayed guild
**Area:** security/safety · **File:** `apps/api/src/services/supervision.ts:502-538,615-636`; `routes/family.ts:401-422`
The child's request stores `inviteCode` plus a `guildId` resolved *for display only*. The parent
sees the guild name from the stored `guildId`, but `approveRequest` joins via
`acceptInvite(req.inviteCode, …, { skipSupervisionCheck: true })` — and that skip bypasses
`isGuildBlockedForChild`. Because the decision binds to the *code* while the display binds to the
*resolved-at-request-time guildId*, a child can craft a request whose shown guild differs from
where the code leads (repointed/secondary invite), getting approval into a server the parent would
have blocked.
**Fix:** re-resolve the code → guild at *approval* time and confirm/match it; or re-run
`isGuildBlockedForChild` in `approveRequest` instead of skipping.

### B10. Live viewability cache only updates when routes remember to call the helper
**Area:** gateway/realtime · **File:** `apps/api/src/gateway/registry.ts:363-383`; `dispatch.ts:1009-1077`
`applyGuildPermissionChange`/`applyMemberRoleChange` keep `viewableGuildChannelIds` fresh, but
they're invoked per-route. Any visibility-affecting mutation that forgets to call them (a role's
bits changing, member-role changes on other paths) leaves the cache stale, so the `channel`
audience filter can **leak** events for a now-hidden channel or **drop** events for a now-visible
one until reconnect.
**Fix:** audit every route that changes role bits / overrides / member roles to call the helper;
longer term centralize invalidation in the permission-write service layer.

### B11. `listMessages` `around` mode: asymmetric/short context, vanishing anchor
**Area:** API services · **File:** `apps/api/src/services/messages.ts:455-476`
Each half is capped at `floor(limit/2)`; the target consumes one "older" slot so context is
asymmetric, and odd limits under-return by one. If `around` points at a soft-deleted message it's
filtered out, so jump-to-message lands nowhere with no signal.
**Fix:** allocate `half` older + `limit-half` newer, and fetch the anchor explicitly (as a tombstone if deleted).

### B12. DM call-tracking columns are a non-atomic read-modify-write → calls misclassified as missed
**Area:** API/voice · **File:** `apps/api/src/services/voice.ts:188-230`
After the voice_state upsert, a separate SELECT decides "is the other party present?" then
conditionally stamps `dmActiveCallStartedAt/answeredAt`. Two near-simultaneous joins can both
see "no other present"; the `WHERE … IS NULL` guard prevents clobbering but not the
misclassification — a connected call gets logged **missed** with `durationMs=0`.
**Fix:** derive call state from actual `voice_states` membership in one atomic statement, or
`SELECT … FOR UPDATE` the channel row before deciding first-vs-second.

### B13. `createChannel` position is a non-atomic read-modify-write → duplicate positions
**Area:** API services · **File:** `apps/api/src/services/channels.ts:95-124`
`MAX(position)` is read outside the insert tx; concurrent creates under the same parent both
insert at `max+1`. Cosmetically tolerable (ties break by id) but violates the append invariant.
**Fix:** `INSERT ... SELECT COALESCE(MAX(position),-1)+1 ...` in one statement, or wrap select+insert in a tx.

### B14. Saved-messages keyset can skip rows; also leaks soft-deleted messages
**Area:** API services · **File:** `apps/api/src/services/savedMessages.ts:107-152` (pagination), `:118-135` (no `deletedAt` filter)
The cursor is `savedAt` (non-unique); a `lt(savedAt, cursor)` boundary inside a same-timestamp
cluster drops every row at that timestamp. Separately, the list inner-joins `messages` without
`isNull(deletedAt)`, so a saved-then-deleted message still shows full content (every other read
path filters tombstones).
**Fix:** composite keyset `(savedAt, messageId)`; add `isNull(messages.deletedAt)`.

### B15. Native `RetryingImage` shows stale avatar after row recycling
**Area:** native iOS · **File:** `ios-native/Zekktris/Components.swift:14-27`
`.task(id: url)` re-runs on URL change, but the body is `if image == nil { … }`; a recycled
`LazyVStack` row rebound to a different user keeps the old `@State` image, so the wrong avatar
persists. Affects every `Avatar` in long lists.
**Fix:** reset `image = nil` at the top of the `.task(id:)` before fetching (or always reload).

### B16. Native `decrypted` E2EE plaintext lingers after leaving a channel
**Area:** native iOS / privacy · **File:** `ios-native/Zekktris/AppStore.swift:516-540` (openChannel), cleared only at `:2956`
`openChannel` resets `messages` but not `decrypted`, so decrypted DM plaintext stays in memory
indefinitely after leaving a conversation (only relock/delete/logout clear it) — weakens the
"nothing lingers in memory" intent and grows unbounded.
**Fix:** drop `decrypted` entries for the outgoing channel on switch.

### B17. Native prepend scroll-anchor restore is unreliable (list lurches on history load)
**Area:** native iOS · **File:** `ios-native/Zekktris/AppStore.swift:688-708`, `MessageViews.swift:107-113`
`loadOlderMessages` sets `pendingScrollAnchorId` and inserts rows in the same run-loop turn;
SwiftUI publishes both at once and `scrollTo` runs against freshly-prepended, unmeasured
`LazyVStack` rows → the classic prepend jump it's trying to avoid.
**Fix:** scroll after layout settles (anchor in a follow-up `DispatchQueue.main.async`, or `.scrollPosition`).

### B18. Web desktop-notification click does a full-page reload (loses SPA state)
**Area:** web · **File:** `apps/web/src/app/state/AppState.tsx:2602-2612`
`window.location.assign(path)` is a hard navigation — full bundle reload, loses in-memory
AppState + gateway connection, re-bootstraps.
**Fix:** route via the history API / a navigate callback.

## Low

- **B19. Native unused CallKit outgoing methods + outgoing-call coordination gap** — `startOutgoing`/`outgoingConnected` have zero call sites (`CallManager.swift:129-140`); either remove or wire for DM calls.
- **B20. Native PBKDF2 (250k iters) runs sync on the main actor** in `unlockE2EE` (`AppStore.swift:2888`) — can jank the UI on older devices; run off-main.
- **B21. `readStates.ack` existence check ignores `deletedAt`** (`apps/api/src/services/readStates.ts:51-60`) — a marker can point at a tombstone.
- **B22. `purgeChannel` soft-delete + attachment cleanup not transactional** (`messages.ts:688-727`) — crash between steps orphans attachment files (GC treats them as referenced).
- **B23. Change-password current-password check is unthrottled** (`users.ts:659-677`) — a stolen access token can brute the current password (bounded by scrypt); add a per-user limiter like login.
- **B24. Native poll/date helpers re-parse + index per render**; web poll-option inputs keyed by array index (focus/IME jumps); web toast `setTimeout` untracked; web `formatTimestamp` doesn't refresh at the day boundary. (Minor correctness/UX.)

---

# 2. OPTIMIZATIONS

## High

### O1. `resolveBotByToken` full-table-scans `users` on every bot request
**Area:** DB · **File:** `apps/api/src/services/bots.ts:191-207`; no index in `packages/db/src/schema/users.ts`
Runs in auth middleware for every REST call a bot makes; `bot_token_hash` is unindexed.
**Fix:** add a (partial `WHERE is_bot = true`) index on `bot_token_hash`.

### O2. Web: every `MessageItem` re-renders on any message in any channel
**Area:** web · **File:** `apps/web/src/app/MessageItem.tsx:92,437-442`
The row selects the whole `messagesByChannel` map, whose reference changes on every
append/patch/receipt anywhere, re-rendering all visible rows app-wide + re-running the
`renderCtx` channel scan + markdown memo.
**Fix:** select only `messagesByChannel[message.channelId]` (and pass `repliedTo` down from the
Scroller so rows don't subscribe to message state at all).

### O3. Web: `useAppState()` (non-selector) re-renders 45 components on every dispatch
**Area:** web · **File:** provider value `apps/web/src/app/state/AppState.tsx:3030`; 45 consumers
The context value is memoized only on `state`, so any action re-renders all 45 `useAppState()`
consumers (Shell, ChannelList, MemberList, MessageView…). The selector hook exists but only 7
files use it.
**Fix:** migrate hot/broad consumers to `useAppStateSelector`, or split stable callbacks from
`state` into two contexts.

### O4. Native: message content re-parsed (regex + AttributedString) on every render
**Area:** native iOS · **File:** `ios-native/Zekktris/MessageViews.swift:1120-1183,1259-1283,2210-2219`
Each visible row compiles `NSRegularExpression` (code-block split) and builds an `AttributedString`
(markdown + mention regex) in `body`, recomputed on any state change (a presence tick invalidates
the list). Biggest scroll cost.
**Fix:** cache the parsed/attributed result keyed by message id+content; hoist compiled regexes to `static let`.

### O5. Native: whole `@Published messages` array republished on per-row edits
**Area:** native iOS · **File:** `ios-native/Zekktris/AppStore.swift:1186-1202,2770-2787,2812-2828`
Reaction toggles, delivery/viewed receipts, and edits do `messages[idx].field = …`, republishing
the entire array → SwiftUI re-evaluates every row (compounds O4). On a 1:1 DM every
`MESSAGE_VIEWED` rewrites the array.
**Fix:** make rows cheaper (O4) and/or move frequently-changing per-message state (reactions,
receipts) into a separate keyed dictionary so only affected rows observe it.

## Medium

### O6. READY does an N+1 viewable-channels resolver call per guild on every reconnect
**Area:** gateway · **File:** `apps/api/src/gateway/server.ts:416-428`
`Promise.all(guildIds.map(gid => listViewableGuildChannelIds(gid, userId)))` → ~2 round-trips per
guild; a 50-guild user pays ~100 round-trips per reconnect (frequent on iOS).
**Fix:** add `listViewableGuildChannelIdsForGuilds(userId, guildIds[])` batching across the user's
guilds (mirror the existing multi-user batch).

### O7. `presenceUpdate` publishes one event per guild → O(guilds) serializations
**Area:** gateway · **File:** `apps/api/src/gateway/dispatch.ts:385-429`
A user in 50 guilds → 50 bus publishes + 50 `onPublished` runs + 50 `JSON.stringify` per status
flip, ×replicas via Redis.
**Fix:** a multi-guild audience kind fanning to the deduped union once, or drop `guild_id` from the
presence payload (the client already handles null) and emit once.

### O8. Missing / mismatched indexes
**Area:** DB · multiple
- `channels.last_message_id` unindexed but `listMyDMs` orders by it (`dms.ts:193-201`) → per-load sort over the user's channels. Add an index (DM-scoped partial).
- `messages_pinned_idx` is `(channel_id, pinned)` (poor selectivity) and its comment is wrong (`schema/messages.ts:149`). Make it partial `(channel_id) WHERE pinned AND deleted_at IS NULL`.
- `scheduled_messages` due-index drift: schema declares non-partial, migration 0046 declares `WHERE attempts < 3` (`schema/scheduledMessages.ts:59`). Add `.where(sql\`attempts < 3\`)` so `drizzle-kit` doesn't drop the predicate.

### O9. Gateway hot-path allocations + redundant rechecks
**Area:** gateway · **File:** `apps/api/src/gateway/registry.ts:328-361,368-369`; `dispatch.ts:912-924`
`candidateConnections` does `Array.from(set)` per event (iterate the Set directly); `users`-audience
re-runs `userIds.includes(conn.userId)` per candidate though candidates are members by construction;
`applyGuildPermissionChange` rebuilds `currentForGuild` by scanning each conn's entire
`channelToGuild` (index it as `Map<guildId, Set<channelId>>`).

### O10. Per-process rate limiter → move to Redis when configured
**Area:** ops/security · **File:** `apps/api/src/lib/rateLimit.ts:9-13`
All auth/abuse limiters are in-process; with N replicas the effective limit is N× and a restart
resets counters — weakening login/forgot-password/webhook throttles exactly when scaling. Redis is
already running and the bus shows the wrap-if-configured pattern.
**Fix:** Redis-backed limiter (at least for login-by-email, forgot-password, webhook-exec).

### O11. Native: serial/coarse refetches
**Area:** native iOS
- `loadSwitcherChannels` awaits per guild serially (`AppStore.swift:2452-2464`) → use a `TaskGroup`.
- `MESSAGE_REACTION_REMOVE_ALL` / `MESSAGE_POLL_UPDATE` / `USER_UPDATE` refetch the whole channel/member list (`:2680-2691,2710-2719`) → patch the single message/user.
- `orderedGuilds`/`emojiByName` rebuild a dict on every access (`:41-50,126-130`) → cache, invalidate on `didSet`.
- `ISO8601DateFormatter()` allocated ad-hoc in ~24 sites incl. `Poll.isExpired` (two per call) → hoist to `static let` (Components.swift already does this right).

## Low

- **O12. Native unbounded caches** (`decrypted`, `presence`, `emojiImages`, `voiceStatesByUser`) never prune mid-session (`AppStore.swift`) — use `NSCache`/bounds; clear `decrypted`/`presence` for unreferenced ids.
- **O13. Native voice arena** runs a 30fps `TimelineView` recomputing all seats + `syncRemoteTracks` reassigns 3 `@Published` maps unconditionally on frequent speaker updates (`Voice.swift:618-643,246-256`) — throttle + diff before assign.
- **O14. `hydrateMessages` doesn't batch polls/stickers/forward-sources** though batch loaders exist (`messages.ts:935-1014`) — fold them in so pins/search share one batched load.
- **O15. Web `MemberList` not virtualized** (bounded at 200 today) (`MemberList.tsx:204`); confirm `lib/icons.tsx` (29 KB) tree-shakes per-chunk.
- **O16. Supervision link setup** issues two serial count queries that could be `Promise.all` (`supervision.ts:86-93,110-119`).

---

# 3. ENHANCEMENT FEATURES

Prioritized by impact; each ties to code that already exists, so most are "finish/expose," not greenfield.

## High impact

### E1. Admin observability dashboard + `/metrics`
There is **no** metrics endpoint, Sentry, or OTel anywhere — observability is `docker logs`.
`routes/admin.ts` already exposes stats/storage/GC/security tabs, and `index.ts` runs 9 background
sweeps whose health is invisible. Add an optional Prometheus `/metrics` (gateway connections, sweep
last-run/duration, DB pool, message rate) + a `SENTRY_DSN`-gated reporter in `errorHandler`, surfaced
in an admin tab. **Effort: M · Impact: High**

### E2. First-class backup/restore + scheduled exports
README documents *what* to back up but ships no tooling, and file-copying a live Postgres dir isn't
crash-consistent. Natural extension of `services/guildBackup.ts` (versioned `zekktris.guild-backup`):
add instance-wide `pg_dump` + uploads tar (scheduled via the existing sweep-timer pattern),
downloadable from `/admin`, plus a restore script + documented drill. **Effort: M · Impact: High**

### E3. SSO / OIDC login
Self-hosters run alongside Authentik/Keycloak/Authelia and expect it. Auth is modular
(`auth/tokens.ts`, `auth/sessions.ts`, `routes/auth.ts`) and the `instance_settings` k/v table
(migration 0060) can hold provider config at runtime without redeploy. **Effort: L · Impact: High**

### E4. Ship the multi-node story: Redis-backed rate limiting + revocation
`cache` (Redis) is already running, `redis-bus.ts` + `session-blacklist.ts` already exist, and
`WORKER_ID` is per-replica-aware. Wiring the rate limiter (O10) and ban/session revocation to Redis
unlocks the documented horizontal-scale goal and tightens moderation/security in one stroke.
**Effort: M · Impact: High**

### E5. Audit-log viewer (filter + export UI)
`services/audit.ts` already writes structured `noun.verb` entries with prefix filtering and a capped
export. The data exists — it needs a polished admin/guild timeline UI (actor avatars, filter chips).
Accountability is table-stakes for communities + self-hosters. **Effort: S · Impact: High**

### E6. Turn on the bot / slash-command platform
The backend is remarkably complete: `services/bots.ts` has create/token-mgmt/per-guild-add/
`registerBotCommand`/`invokeBotCommand`/`deliverMessageEventToBots` (migrations 0049–0051). Missing
is a developer-portal UI (create bot, copy token, register commands) and documented outbound event
webhooks. High leverage to activate a latent platform. **Effort: M · Impact: High**

### E7. Reports / moderation triage queue
`services/reports.ts` has `createReport`/`listReports`/`countOpenReports`/`handleReport` (migration
0061). Add a moderator inbox UI (open-count badge, assign, resolve-with-action) so reports become
actionable. **Effort: S–M · Impact: High**

### E8. AutoMod rule builder + ReDoS-safe engine
`services/automod.ts` (migrations 0033/0045) already evaluates admin regex/keyword rules. Pair a
no-code rule builder (keyword lists, regex, spam thresholds) with the ReDoS fix (length-bound the
content before eval + consider RE2). #1 self-host moderation need. **Effort: M · Impact: High**

### E9. First-boot setup wizard + in-app voice/LiveKit diagnostic
The README spends paragraphs on self-host gotchas (the "#1" being UDP 7882 reachability). A guided
first-boot wizard (instance name, registration mode, SMTP test, VAPID status) plus a "test my voice"
tool that mints a test token, attempts ICE, and reports which candidate types succeeded turns endless
reconnect loops into "open UDP 7882." Leverages `routes/voice.ts` token minting + `startup-checks.ts`.
**Effort: M · Impact: High**

## Medium impact

- **E10. Finish 2FA enrollment UI on web** — `services/twoFactor.ts` is complete (TOTP/recovery/encrypted secret) and `lib/qr.ts` exists; native enrollment shipped this session. **Effort: M · Impact: Med-High**
- **E11. Better search: per-instance dictionary + `ts_rank` ordering** — `services/messageSearch.ts` uses an `english` GIN index + `websearch_to_tsquery` but orders by id-desc. Rank by relevance and make the dictionary configurable. **Effort: M · Impact: Med-High**
- **E12. Raid-protection dashboard + tunable thresholds + one-click lockdown** — `services/raidProtection.ts` + migration 0062 already gate joins; expose status/velocity/threshold controls. **Effort: S–M · Impact: Med-High**
- **E13. Email digests + granular notification policy** — SMTP (`services/email.ts`) + `notification_overrides` (migration 0005) + push are wired; add scheduled missed-mention/DM digests via the sweep-timer pattern and per-type toggles. **Effort: M · Impact: Med**
- **E14. Scheduled-events calendar view + pre-event push reminders** — `services/events.ts` + `runEventStatusSweep` + RSVPs already exist. **Effort: M · Impact: Med**
- **E15. Sticker/emoji pack import-export** — `services/emojis.ts`/`stickers.ts` + the backup serializer make a scoped "share pack" feature low-effort. **Effort: S · Impact: Med**
- **E16. Stage channels: raise-hand/speaker-requests + optional LiveKit egress recording** — `services/stage.ts` + self-hosted SFU support it. **Effort: M–L · Impact: Med**
- **E17. Finish achievements/streaks public shelf** — migration 0073 + `services/achievements.ts`/`streaks.ts` + the `achievementsPublic` toggle exist; the profile shelf is unrendered. Retention lever on built data. **Effort: S–M · Impact: Med**
- **E18. Accessibility pass** — full keyboard nav, ARIA on the 4-column shell, new-message screen-reader announcements, reduced-motion. No backend work; broadens the user base. **Effort: M · Impact: Med**
- **E19. Signed short-TTL CDN URLs (privacy hardening)** — `routes/cdn.ts` serves attachments public-read, so DM/supervised media privacy reduces to URL secrecy. HMAC(attachmentId+exp) URLs make possession of the message URL ≠ permanent file access — fits a privacy/parental-controls product. **Effort: M · Impact: Med**

---

# Appendix A — Ops/infra issues (consolidated)

These are operational rather than code-correctness; several overlap the bug/optimization sections.

- **CI: none exists** (no `.github/`) — add typecheck/lint/test on push with a Postgres service container. *(High)*
- **Integration tests need `--fileParallelism=false`** (WORKER_ID=0 snowflake collisions) but it's not configured in `apps/api/vitest.config.ts` or documented — set it, or derive a unique `WORKER_ID` per vitest worker. *(High)*
- **No container resource limits** in `docker-compose.yml` — one runaway service can OOM the host. *(Med)*
- **Healthchecks** only on `db`; add redis/livekit/proxy probes; point the orchestrator at `/health/ready` (it exists, `routes/health.ts:21`, but only liveness `/health` is wired). *(Med)*
- **Migrations auto-apply on boot** (`startup-checks.ts:150`) with destructive forward-only history and no down-migrations — document "back up before update" prominently; ship E2. *(Med)*
- **Secrets hygiene** — confirm `secrets/` + `*.p8` are gitignored (setup.sh shows LiveKit creds were committed once historically); add a pre-commit secret scan; refuse to start if `LIVEKIT_API_SECRET` is the dev default. *(Med)*
- **`redisCheck` is a fake** (parses URL, no `PING`) though the Redis bus has shipped (`startup-checks.ts:246`). *(Low-Med)*
- **`unhandledRejection` → `process.exit(1)`** (`index.ts:545`) — a single un-awaited rejection in gateway fan-out takes down all clients; log-and-continue instead. *(Low-Med)*
- **No drain timeout on graceful shutdown** (`index.ts:496`) — a stuck request can hang until Docker SIGKILL; add a deadline. *(Low)*
- **Caddy:** no edge rate-limiting, no CSP (acknowledged), misleading `Host`-forwarding comments (`ops/Caddyfile`). *(Low-Med)*

# Appendix B — Already fixed this session (not re-listed above)
- Message search 500s (cross-DM + per-channel) → drizzle query builder.
- Prompt session revocation on REST via Redis session blacklist (note: **B1** is a *new* gap where `reset-password` bypasses it).
- `FIELD_ENCRYPTION_KEY` rotation safety (multi-key decrypt + re-encrypt script).
- `applyGuildPermissionChange` per-user `voice_states` N+1 → single batched read.
- E2EE-disable now requires a verifier; E2EE-enable guard.
- Native parity features (cross-DM search, sessions list/revoke, guild import, E2EE key backup, 2FA setup, watch-words/flagged feed, invite preview-then-join, mic-level test).

# Appendix C — 2026-06-10 session: statuses after re-verification + fresh audit

Every B/O item above was re-verified against current code; a parallel fresh audit
(adversarially verified) covered the recently-landed code (RESUME, SSO/OIDC, Redis
rate limiter, metrics, backups, bots). Statuses:

## Fixed earlier (verified already resolved before this session)
B1, B2, B3, B4, B5, B7, B8, B9 · O1 (DB index — schema-declaration drift remained, now synced),
O2/O3 (hot paths), O4, O6, O7 · E1–E7, E9 (shipped as features) · ENV empty-string crash.

## Fixed THIS session
- **Known items:** B6 (native ack debounce), B10 (channel-reparent PATCH + self-assign
  role routes now refresh the gateway viewability cache), B11 (around-mode windowing +
  explicit anchor), B12 (DM call classification — atomic single-statement transition +
  stray-answeredAt cleanup in leaveVoice), B13 (position via inline MAX+1 subquery),
  B14 (saved-messages composite keyset + deletedAt filter), B15 (RetryingImage URL-keyed
  reload), B16 (decrypted plaintext cleared on channel switch), B17 (two-phase prepend
  scroll restore), B18 (notification soft-nav), B20 (PBKDF2 off main actor), B23 +
  TOTP confirm/disable (shared per-user step-up limiter), B24-web (poll-option stable
  keys, tracked toast timers), B21 (resolved as intended-behavior — documented why
  tombstone watermarks are accepted).
- **Optimizations:** O8b (partial pinned index, migration 0077), O8c + O1 declaration
  sync, O9 (copy-free candidate iteration, lazy serialize, guildToChannels forward
  index), O13 (arena 10fps + diffed track publishes), O14 (hydrateMessages now batches
  polls/stickers/forwards), O16, O3-residual hot paths (autocomplete hooks,
  GlobalCallOverlay, VoicePanel → selectors), O11 partial (switcher TaskGroup,
  REACTION_REMOVE_ALL in-place patch, Poll.isExpired static formatters).
- **Ops:** OPS-VITEST (per-worker WORKER_ID — parallel suite now stable; also fixed the
  instance-backup test leaking other suites' imported guilds), OPS-REDISCHECK (real
  PING, warn-grade), OPS-UNHANDLED (log-and-continue), OPS-DRAIN (10s deadline +
  closeIdleConnections), OPS-HEALTH (readiness probe + cache healthcheck + api
  depends_on cache).
- **Fresh findings fixed (all adversarially verified or re-verified in-code):**
  - SSO JIT-provisioning bypassed ALLOW_REGISTRATION (high) → gated on `open`.
  - OIDC issuer pinned to admin config + discovery-issuer assertion; https required on
    token/jwks endpoints; soft-deleted-email JIT collision surfaced cleanly.
  - Login 2FA throttle bypass (no-code reset refunded the per-email counter) → reset
    removed + dedicated per-user 2FA limiter.
  - Poll vote/edit broadcasts leaked the actor's `myVotes` + `reactions[].me` to every
    member → fan-out DTOs carry no per-recipient state; web reducer + native upsert
    preserve local self-state; voter's ballot persisted locally on both clients.
  - Mentions resolved for guild members WITHOUT VIEW_CHANNEL → leaked private-channel
    content via push previews + mentions inbox → filtered at resolveMentions (choke
    point) + read-time re-check in listUserMentions.
  - Bot event signature was SHA-256(secret.payload) (length-extension forgeable) →
    real HMAC-SHA256. **Note: breaks bots verifying the old scheme.**
  - addBotToGuild let any guild manager conscript a stranger's bot (message exfil via
    its callback) → installer must own the bot.
  - Slash-command collisions resolved nondeterministically → stable scope-then-botId
    ordering.
  - Redis rate limiter + session blacklist HUNG during a Redis outage instead of
    failing open (offline queue + unlimited retries) → no offline queue, command
    timeout; an outage now degrades instead of freezing login (limiter) or the entire
    authenticated API (blacklist).
  - gatherMetrics 500'd on a transient count failure → degrades to zeros, db.ok=false.
  - RESUME failed in its PRIMARY scenario (silent socket death — client's watchdog
    beats the server's, session still "live") → live-session takeover, Discord-style;
    + regression test.
  - Detached resume-window ghosts counted as connected → false DM Delivered stamps and
    inflated metrics → hasLiveConnection() + live-only metric counts.
  - Web gateway client leaked a heartbeat interval per fast reconnect and let a stale
    ack-watchdog defeat backoff → all timers tracked + cleared.
  - ResumeBuffer byte budget (256KB/session) alongside the count/age caps.
  - Signup-code uses burned by failed registrations → best-effort refund on failure.

## Still OPEN (known, deliberate deferrals)
- **SSO bypasses local TOTP 2FA (medium).** Real, verified. The right fix is an
  interstitial 2FA challenge between the OIDC callback and session mint (cookie-bound
  challenge + small endpoint + web UI). Rejecting TOTP-enabled users outright would
  lock out pure-SSO accounts (sentinel password hash). Needs a deliberate UX pass.
- **TOTP codes replayable within the ±1 window (low).** Standard weakness; fix is a
  `totp_last_step` column checked on verify. Docstring now states the limitation.
- **B19** (dead CallKit outgoing methods — wire or delete), **B22** (purgeChannel
  attachment cleanup not transactional), **O5** (native @Published messages array
  granularity — medium refactor), **O11/O12 remnants** (orderedGuilds/emojiByName
  caching, USER_UPDATE/POLL_UPDATE coarse refetches, unbounded presence/emojiImages
  caches), **O15** (MemberList virtualization — `virtua` already a dependency),
  **OPS-CI** (no .github/workflows — typecheck + vitest + Postgres service container;
  the suite is now parallel-safe so CI is cheap), Caddy edge rate-limit/CSP.
- **find:permissions-escalation, find:web-fresh, find:native-fresh** audit lanes never
  completed (session limit) — worth a future pass. *(find:web-fresh now run — see the
  2026-06-11 follow-up below.)*

---

# 2026-06-11 follow-up — web/XSS audit lane (fresh, adversarially verified)

Ran the web-client security lane that never completed on 2026-06-10 (`find:web-fresh`):
4 focused finders — markdown XSS, reducer correctness, `e2ee.ts`, injection/auth — each
finding adversarially verified. **8 confirmed, 6 refuted.** Headline result: the markdown
renderer audited **clean** — no `dangerouslySetInnerHTML`, scheme-restricted autolinks,
React-escaped attributes; no working XSS constructible.

## Fixed (commit 123ca60)
- **E2EE stale key survives a peer re-key (medium).** `encryptForDm` never re-checked the
  channel verifier, so after a peer disabled + re-enabled E2EE with a fresh salt this
  device kept encrypting under the dead key — the UI showed "sent securely" while the
  re-keyed peer received an undecryptable tombstone. `encryptForDm(plaintext, channelId,
  expectedVerifier)` now drops the stale key on mismatch (mirrors the existing
  `getCallKeyString` guard); the send and edit paths pass `channel.e2eeVerifier`.
  (`lib/e2ee.ts`, `app/MessageView.tsx`, `app/MessageItem.tsx`)
- **Edit of an encrypted message could send PLAINTEXT (low / privacy).** `saveEdit` fell
  through to the raw typed text when `encryptForDm` returned null (key dropped between
  opening the composer and saving) → cleartext written into the server-stored history of a
  conversation the user believes is end-to-end encrypted. Now aborts with an
  "enter password" / "encryption failed" message instead of degrading to plaintext.
  (`app/MessageItem.tsx`)
- **Guild-import `linkUrl` skipped scheme validation (low).** The normal channel
  create/patch routes enforce `.url()` + `^https?://`; `POST /guilds/import` typed
  `linkUrl` as a bare string, so a crafted backup could persist a `javascript:` / `data:`
  URL into the web `window.open` sink. The import schema now mirrors `channels.ts`.
  (`routes/guilds.ts`)
- **Embed image/favicon accepted any scheme (low, defense-in-depth).** `og:image` and
  `<link rel=icon>` resolved via `new URL(raw, base)`, which ignores the base for an
  absolute href → an attacker-controlled `javascript:` / `data:` survived into the
  `<img src>` sinks (inert there, but unbounded). Now rejects non-http(s) at the source.
  (`services/embeds.ts`)
- **Service-worker notification-click not origin-constrained (low, latent).** The
  origin-strip ran only on the call branch; ordinary message clicks passed `data.url`
  verbatim to `openWindow` — a latent open-redirect / window-injection if any future
  payload carried a cross-origin URL. Same-origin normalization now runs for **every**
  click. (`public/sw.js`)
- **Native push deep-link allowed protocol-relative `//host` (low, latent).**
  `routeFromPush` lacked the `!startsWith('//')` guard the web `?next=` handler has → a
  protocol-relative `data.url` would bounce the WKWebView off-app. Guard added.
  (`app/useNativePush.ts`)
- **`aesKeyCache` never evicted on `clearLocalKey` (low, hygiene).** Disabled/rotated
  imported `CryptoKey`s lingered for the page lifetime; now released alongside the raw key
  bytes. (`lib/e2ee.ts`)

## Deferred (no exploit; tracked)
- **`usersById` cache grows unbounded** — populated on every message/member load, never
  pruned (not even scrubbed on `GUILD_REMOVE`). Single-digit-MB, local to the victim's own
  client, no crafted-input amplification. Sits alongside the existing "unbounded
  presence/emojiImages caches" deferral above. If revisited: prune guild-only users on
  `GUILD_REMOVE` + cap `messagesByChannel` key count (LRU).

## Refuted (verified NOT real)
Markdown XSS (negative result confirmed end-to-end) · poll-ballot self-merge race (impact
overstated — the REST vote response re-stamps the ballot) · `READ_STATE_UPSERT`
backward-move "bypass" (server contract holds) · `MESSAGE_PATCH` reaction resurrection
(requires an impossible local state) · `MESSAGE_CREATE` `mentionedUserIds` deref crash
(unreachable input) · non-constant-time verifier compare (not security-relevant — the
verifier is server-public).

---

# 2026-06-12 session — deep voice/permissions/native/UX audit (104-agent fan-out, adversarially verified)

Ran the never-completed audit lanes (permissions-escalation, native-fresh) plus full
voice/LiveKit (server/web/native/ops), a fresh-commit review since 123ca60, and a
first-run UX walk. 41 findings confirmed (2 independent verifiers each), 1 refuted.

## Fixed THIS session (typecheck + 274 API tests + 25 web tests green)
- **stage participation gates (HIGH security):** `joinStage` now enforces the same
  parental-controls (`allowVoice`/source restriction), guild-timeout, and onboarding-pending
  gates as `joinVoice`; stage token mint now passes `publishSources` so an audio-only child
  can't get camera/screen grants on a stage. (`services/stage.ts`, `routes/stage.ts`)
- **SFU token TTL 1h→5m (HIGH security):** kicked/banned users could rejoin the deterministic
  room with their cached token for up to an hour (removeParticipant only disconnects, can't
  revoke). 5m still leaves slack for the join handshake; live calls refresh tokens over
  signaling so they're unaffected. (`services/voice.ts`)
- **bot-token ban bypass (HIGH security):** `resolveBotByToken` now returns null if the bot or
  its owner is banned/deleted — mirrors the webhook-execute owner guard. (`services/bots.ts`)
- **self-assignable role denylist → allowlist (MED security):** replaced the incomplete
  PRIVILEGED_ROLE_PERMS denylist (missed MANAGE_THREADS, MOVE/MUTE/DEAFEN_MEMBERS,
  VIEW_AUDIT_LOG, MANAGE_NICKNAMES/EMOJIS/INVITES/EVENTS, MENTION_EVERYONE) with a
  participation-only allowlist; also closed the raise-perms-on-already-self-assignable path.
  (`services/roles.ts`)
- **report flood (MED):** added per-user `reportRl` (10/10min). (`routes/guilds.ts`)
- **duplicate system_call (LOW):** concurrent last-leaver race now gated by a conditional
  `UPDATE ... WHERE startedAt IS NOT NULL RETURNING` — exactly one leaver writes the record.
  (`services/voice.ts`)
- **moveVoiceMember destination gate (LOW):** requires actor CONNECT + target VIEW+CONNECT on
  the destination so a move can't strand a ghost in an inaccessible channel. (`services/voice.ts`)
- **ghost stage rows on disconnect (MED):** `runDisconnectCleanup` now deletes the user's
  stage_participants rows and broadcasts STAGE_PARTICIPANTS_UPDATE (stage joins create no
  voice_states row, so the existing voice cleanup never touched them). (`gateway/server.ts`)
- **LiveKit NAT env typo (HIGH ops):** `LIVEKIT_RTC__USE_EXTERNAL_IP`/`__NODE_IP` (double
  underscore) are ignored by livekit-server (single-underscore only) → external-IP STUN
  discovery silently never enabled → NAT'd hosts advertise only private candidates → all
  remote media fails. Renamed to single underscore. (`docker-compose.yml`, `ops/livekit.yaml`)
- **diagnostic false-confidence (MED ops):** `ok` no longer implies media works; added an
  always-present `media_path` warn step (UDP 7882 / TCP 7881 untestable server-side); web
  badge "Voice OK"→"Server checks OK". (`services/livekitDiagnostic.ts`, `web/AdminPanel.tsx`)
- **LiveKit image pin (LOW ops):** floating `v1.9`→exact `v1.9.12`. (`docker-compose.yml`)
- **web voice client (HIGH/MED bugs):** channel-switch now full-teardown (was leaking the old
  room's pollers → blanked new call's video tiles); added RoomEvent.Disconnected→teardown +
  Reconnecting/Reconnected pub-sub + a "Reconnecting…" banner; manual-gain mic now stopped on
  leave; listen-only joins (stage audience/AFK) skip the mic + claim `room` before publish so
  they don't 403-leak; unplugged saved mic falls back to default; PTT can't transmit while
  deafened; setAudioMode vad branch won't unmute while deafened; camera-denial now toasts;
  High preset now actually stereo (channelCount:2 + dtx off); moderator-move reconnect fixed
  (every join now threads channelId; CallKit decoupled to DM-only via `isDmCall`).
  (`web/lib/voice.ts`, `manualGain.ts`, `voiceQuality.ts`, `VoiceView.tsx`, + 6 call sites)
- **UX:** message view opens already at the bottom (visibility-gated until first snap) instead
  of rendering at top and jumping down. (`web/MessageView.tsx`)
- **Newcomer UX (web — verified typecheck + web tests):** invite-only registration dead end
  fixed — RegisterPage has a `?code=`-prefillable Invite code field threaded through
  AuthContext.register + RestClient.register ('open' mode ignores it server-side);
  error toasts render as a readable red card (was a 3s grey pill that shadowed the styled
  tone) with ttl `max(6000, len*55)` + `whitespace-pre-line`; every voice-join site
  best-effort `rest.leaveVoice` on a failed connect so a denied-mic/no-UDP/SFU-down join
  doesn't strand a silent ghost (gateway echoes the leave); "presence only — voice not
  configured" jargon replaced with plain language across all join/call sites.
- **Native iOS (HIGH/MED — verified by Xcode build + iOS unit tests):** native login now has a
  2FA step (LoginBody.code + APIClient.login(code:) + APIError.requires2FA flag + Session.needs2FA
  + a revealed code field in LoginView) — TOTP accounts could not sign in at all before
  (`AuthViews.swift`/`Session.swift`/`APIClient.swift`/`Models.swift`); gateway now attempts ONE
  token refresh + reconnect on an IDENTIFY-rejected frame before latching closed, re-armed on
  READY (`Gateway.swift`, `identifyRefreshAttempted`) — fixes permanent realtime death after a
  >15min background; logout snapshots the old token, nils api.token immediately, revokes with a
  per-call `bearerOverride` (which also disables refresh-retry), and guards the cookie wipe behind
  `api.token == nil` — fixes a fast re-login getting its new session revoked
  (`Session.swift`/`APIClient.swift`); bio editor cap 500→200 to match BIO_MAX_LENGTH (`MainView.swift`).

- **Native CallKit/audio batch (HIGH/MED — Xcode build + iOS tests green; adversarially reviewed
  non-regressing; each needs a 2-device call to CONFIRM the fix lands):** answered-elsewhere ring
  now dismissed without a server decline so it can't evict the caller/kill the live call
  (handleIncomingCall self-branch); applyReadyVoiceStates cancels a stale ring whose caller is
  absent from the snapshot (+ CallManager.ringingChannelIds); VoiceManager.callAudioActive gates
  the voice-message recorder/player off the shared AVAudioSession during a call; VoIP push
  reports-then-ends a placeholder instead of double-ringing when already-in-call/in-app-ring-showing
  (notifyCalls gating deferred); CallKit answer of a keyless E2EE DM ends cleanly + prompts unlock
  (endCallKitIfLockedE2EE); ensureMicEnabled re-checks !isMuted + re-reads room between awaits.
- **Web UX: locked-E2EE DM unlock affordance (MED) — FIXED:** persistent "Enter password" banner
  above the composer (opens the existing DmSettingsPanel unlock form), gate matches the send-gate,
  clears live via the e2ee key-version store; tombstone copy points at the banner. (`MessageView.tsx`,
  `MessageItem.tsx`)

## Still OPEN (prioritized; not yet fixed)
- **Native iOS:** camera-quality change doesn't apply on next camera-on — the ONLY remaining voice
  finding the review flagged risk-as-planned (the LiveKit Swift republish API in the plan was
  invalid); needs a safe rewrite + device test (`Voice.swift`, LOW). Plus: mention badges only
  repair on reconnect; notification tap dead-ends for un-loaded guilds; back-nav false read receipts
  (all LOW).
- **Web UX (MED, remaining):** email-verify gate has no escape for a typo'd address (needs a small
  change-email endpoint for never-verified accounts — server route + client method, planned but not
  built); raw transport errors leak to auth screens; blank "no servers" on a silent boot failure.
  (locked-E2EE unlock affordance — now FIXED, see above.)
- **`Config.swift` hardcodes `zekktris.com`** — the canonical native client cannot reach a
  self-hosted instance without recompiling. Recommend the scan-to-connect QR flow (`lib/qr.ts`
  exists). Major self-hosting gap. (HIGH, product)
- **Web/UX (newcomer-facing):** invite-only registration has no signup-code field on web
  (`AuthScreens.tsx`, HIGH); error toasts are 3s/tiny so multi-sentence help can't be read
  (`Toasts.tsx`, HIGH); failed voice connect leaves a silent ghost participant — REST join not
  rolled back (`ChannelList.tsx`, HIGH); locked-E2EE DM offers no unlock affordance; email-verify
  has no escape for a typo'd address; raw transport errors leak to auth screens (MED/LOW).
- **Contested:** inline SFU admin calls have no timeout (hang when LiveKit slow) — low-med, add
  a timeout wrapper; `livekit` service has no healthcheck — low (fix risky under host-networking).

## Refuted
Web call forcing camera to H.264 with "no backup codec" — VP8 publishDefault + per-track H.264
override is correct; subscribers negotiate.

## Feature recommendations (full ranked list in the Obsidian vault: Documents/zekktris/Audit 2026-06-12.md)
Top voice: (1) studio-grade noise suppression everywhere [M], (2) connection-quality HUD [S],
(3) in-call reactions + hand-raise [M]. Top freshness: server template gallery [S], render the
achievements shelf [S], Kid Mode preset [M]. Top self-host: mobile-config QR [M] (fixes the
hardcoded-server gap), one-command update + auto-backup/rollback [M], unraid CA template [S].

---

# 2026-06-26 session — API scale/perf audit (7-dimension fan-out, adversarially verified)

Scale-focused pass for large multi-user deployments. 18 candidates → 8 confirmed
real + hot-at-scale + not-already-fixed after per-finding adversarial verification.

## Fixed THIS session (commit 5f40819 — typecheck + 297 API tests green vs live PG)
- **notification_overrides target_id seq scan (S):** `listChannelAllSubscribers`
  runs on every non-DM guild message and filtered `WHERE target_id IN (...)`;
  no index led with `target_id` (existing ones lead with `target_type`/`user_id`)
  → full seq scan. Added a PLAIN `(target_id)` index (migration 0087). NOT the
  partial `WHERE level='all'` the audit first proposed — the query post-filters
  `level` in JS because channel-override-suppresses-guild precedence needs the
  non-'all' rows, so a level predicate would make the index planner-unusable.
- **Subscriber viewability over full roster (S):** `routes/messages.ts` validated
  opt-in 'all' subscribers by materializing the FULL channel viewer set
  (O(members) perm math + full-roster memberRoles scan); now scoped to `subs`
  via `listViewableGuildChannelIdsForUsers(guildId, subs)`.
- **Bot event-delivery N+1 (S):** `services/bots.ts` ran
  `computeMemberChannelPermissions` per event-bot; now one batched
  `listViewableGuildChannelIdsForUsers` pass, fail-closed on error.
- **Achievements DoS amplifier (part 1, S):** both achievements routes now
  rate-limited 60/min per requester (the shelf is ~7 uncached aggregates and any
  authed user could request any user's).
- **Automod ReDoS (MED, full-process blast radius) — FIXED (commit cc279a0):**
  an admin catastrophic-backtracking regex in `services/automod.ts`
  (`messageMatchesRegexes`, inline on message-send) could pin the event loop and
  stall the whole replica. Chose the no-native-dep route (deploy is node:20-alpine
  → RE2 has no musl prebuilds): `safe-regex` (pure JS, star-height bound) gates
  patterns at create/update time (reject w/ admin error) AND at runtime via a
  compiled-pattern cache that checks safety before constructing/running — so
  already-stored bad patterns are neutralized too. 301 API tests green.

## Still OPEN (verified real; ranked for follow-up — need a decision or are bigger)
- **`messages(reply_to_id)` partial index (part 2 of achievements, S but risky):**
  serves the first-responder self-join. Additive, but `messages` is large and the
  migrator is transactional (no `CONCURRENTLY`) → a build-time write lock. Needs a
  concurrent-build strategy / maintenance-window decision.
- **@everyone push fan-out (L) — FIXED (commit 69ec35a):** `routes/messages.ts`
  + `services/push.ts`/`apns.ts`/`fcm.ts` did 3×N token-table queries +
  unbounded outbound concurrency on a big announcement. New
  `sendToUsers(userIds, payloadFor)` does one query per transport (grouped by
  user) + a bounded send burst (`runBounded`, `lib/concurrency.ts`,
  cap 32); per-token send/prune extracted to shared helpers so single + bulk
  can't drift. Both DM + guild-mention paths use it. 301 tests + new
  runBounded unit tests green.
- **Discovery directory (M, migration + drift risk):** `services/discovery.ts`
  live join + COUNT(DISTINCT) + aggregate ORDER BY + leading-wildcard ILIKE +
  OFFSET per page on every directory open/keystroke. Denormalize `guilds.member_count`
  + keyset paginate + pg_trgm; counter must be maintained on every membership path.
- **Optional:** Redis TTL cache for the achievements shelf; DB pool default
  10→~20 + an ops note on the cluster-wide `replicas × pool ≤ max_connections`
  invariant (keep `prepare:false` under pgbouncer).
