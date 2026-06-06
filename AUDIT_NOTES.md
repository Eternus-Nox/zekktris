# Bug audit — v1.67

This pass reviewed the API surface, auth, gateway, permissions, message
flow, DMs, invites, voice presence, and webhooks. Web client and some
ancillary services (admin, embeds, stickers, stage) were not deeply
reviewed; see "Not audited" at the bottom.

Each entry below is laid out as **Bug → Symptom → Fix**.

---

## 1. 2FA users lock themselves out of login

**Files:** `apps/api/src/routes/auth.ts`

**Bug.** `/login` consumes a slot in the per-email rate limiter
(`loginByEmail`) before the password check. When a user with 2FA
enabled submits the correct password but no `code`, the route returns
`{ requires2FA: true }` and *never resets the counter*. So a 2FA user
who types their password correctly 10 times in the same 15-minute
window (the limit) ends up locked out of their own account.

**Symptom.** "Why am I getting `rate_limited` after entering my correct
password?" — only visible to users with 2FA on.

**Fix.** Reset the per-email counter before returning `requires2FA`.
Bad 2FA codes on the follow-up call still consume slots (the email
counter is consumed at the top of the handler for every attempt), so
this doesn't open the 2FA verifier to free brute-force.

---

## 2. Channel reorder doesn't refresh permission caches

**Files:** `apps/api/src/routes/channels.ts`

**Bug.** `PATCH /:guildId/channels/positions` dispatches
`CHANNEL_UPDATE` for each moved channel but doesn't call
`applyGuildPermissionChange`. Moving a channel into (or out of) a
category changes its effective permissions because the category's
overrides apply first in the resolver. Connected members'
`viewableGuildChannelIds` cache goes stale until next IDENTIFY.

**Symptom.** After an admin moves `#private-staff` from the public
category to the staff category, members who shouldn't see it still
receive its `MESSAGE_CREATE` events until they reconnect — they don't
actually *see* the channel because the client hides it on
visibility-state, but the events arrive.

**Fix.** After `reorderChannels`, if any row changed `parentId`, call
`dispatch.applyGuildPermissionChange({ guildId })` which diffs each
connected user's viewable-channel cache and emits CHANNEL_CREATE /
CHANNEL_DELETE for transitions. Pure position changes within the same
parent skip this — they don't affect permissions.

---

## 3. Edit broadcast erases poll / forward UI on existing messages

**Files:** `apps/api/src/routes/messages.ts`

**Bug.** PATCH `/:channelId/messages/:messageId` builds the broadcast
DTO via `toMessage({...})` without supplying `poll` or `forwardedFrom`.
The `MESSAGE_UPDATE` wire shape replaces the whole bubble client-side,
so when a message that had a poll or forward gets a text edit, the
update arrives with those fields null and the client clobbers the
local UI for them.

**Symptom.** Edit the text of a message with a poll → poll disappears
on every other connected client until refresh.

**Fix.** Re-hydrate `poll` and `forwardedFrom` for the broadcast DTO
using the existing `polls.loadPollsForMessages` and
`messages.loadForwardSources` helpers.

---

## 4. Search endpoint is unreachable

**Files:** `apps/api/src/routes/messages.ts`

**Bug.** `GET /:channelId/messages/search` was registered AFTER
`GET /:channelId/messages/:messageId`. Hono's router matches in
registration order when paths overlap with a parameter segment.
Verified locally:

```
search request: 200 {"matched":"messageId","messageId":"search"}
```

The validator then rejects the literal `"search"` as a non-snowflake
and returns 400. The search endpoint never reaches its handler.

**Symptom.** All search queries return 400 with a Zod error like
"Invalid snowflake id".

**Fix.** Move the `/search` route registration to BEFORE the
`/:messageId` route, with a comment explaining why ordering matters.
Re-verified the fix works.

---

## 5. `rotateSession` can rotate a revoked session (TOCTOU)

**Files:** `apps/api/src/auth/sessions.ts`, `apps/api/src/routes/auth.ts`

**Bug.** Between `findActiveSessionByRefreshToken` and the subsequent
`rotateSession`, another tab could log out (setting `revokedAt`) or
the row could lapse its `expiresAt`. The old `rotateSession`
unconditionally overwrote the session row, which would effectively
un-revoke it (no `revokedAt` reset, but the rotated row is no longer
findable by the old token, so the next refresh from the legitimate
client succeeds while the just-revoked-cause-of-logout state is
silently undone).

**Symptom.** Rare edge case but real: clicking "log out" in one tab
while another tab is mid-refresh can leave the session alive.

**Fix.** `rotateSession` now filters on `revokedAt IS NULL AND
expiresAt > now()` in its UPDATE WHERE, returning `null` if the row
fell out of those conditions. The `/refresh` route treats `null` the
same way it treats "no session found": clear the cookie + 401.

---

## 6. DM creation race produces duplicate channels

**Files:** `apps/api/src/services/dms.ts`

**Bug.** Two concurrent calls to `getOrCreateDM(A, B)` (multiple
tabs, retried mobile requests) can both see "no existing DM" and both
create fresh channels. There's no unique constraint on the unordered
pair, so both transactions commit and the user ends up with two
parallel DM threads.

**Symptom.** Open the same person in DMs from two tabs at once →
sometimes one tab sees a different conversation history than the other.

**Fix.** After creating the channel, re-run the find. If a different
channel id surfaces, another writer beat us; drop the orphan we just
created and return the winner. Also catch Postgres `23505` on the
insert path as a belt-and-suspenders. One retry is enough because by
the time we get here, a winning transaction must have already committed.

---

## 7. Simultaneous mutual friend requests error out

**Files:** `apps/api/src/services/relationships.ts`

**Bug.** If A and B call `sendFriendRequest` at the same instant, both
see `existing=null, inverse=null` and both attempt the two-INSERT
transaction. The second one collides on the relationships PK
`(userId, targetId)`, raising `23505`, and one user gets an error
instead of the desired "you're now friends" outcome.

**Symptom.** Twin users hit "Add Friend" within the same tick →
one gets an `internal` 500 instead of a friendship.

**Fix.** Catch `23505` on the fresh-request insert path, re-read the
row, and if it's now `incoming_request` (the other user's outgoing
side that won the race), flip both rows to `friend` — same logic as
the "they-already-requested-us-so-this-counts-as-accept" branch.

---

## 8. Invite use-count burned by repeat clicks from the same user

**Files:** `apps/api/src/services/invites.ts`

**Bug.** `acceptInvite` documented "Idempotent: if the user is already
a member... returns success without consuming a use." The
implementation contradicted that: it consumed first (`UPDATE invites
SET uses = uses + 1`), THEN checked membership. A user clicking a
`maxUses=1` link twice would exhaust the invite on their second click,
locking out the actual second invitee.

**Symptom.** Someone joins via an invite link, clicks it again
(refresh, second tab), and the invite is now "fully used" — the next
new user can't join.

**Fix.** Reorder the transaction: read the invite row first (no
update), check membership, check ban, *then* consume atomically and
insert the member. Existing members short-circuit before the counter
moves.

---

## 9. Voice presence: N round-trips at IDENTIFY for users in many guilds

**Files:** `apps/api/src/services/voice.ts`

**Bug.** `listVoiceStatesForGuilds` claimed in a comment to be the
simpler call but was actually doing one SELECT per guild in a
sequential loop. IDENTIFY calls this once per session with the user's
full guild set. A user in 50 guilds was paying 50 sequential DB
round-trips just to fill in the voice column of READY.

**Symptom.** Slow first-paint of voice-state UI for power users.

**Fix.** Replace the loop with a single batched `inArray` query.

---

## 10. Reconnect doesn't refetch state — the "app feels cached" bug

**Files:** `apps/web/src/state/AppState.tsx`

**Bug.** When the gateway WebSocket reconnects (heartbeat-ack watchdog
fires after a zombie connection — mobile suspend, network blip, the
OS pausing the tab), every event that arrived at the dead socket
during that window is lost. The kernel TCP buffer eats them; the server
thinks the dispatch succeeded; the close event doesn't fire until much
later. The client's `READY` handler on reconnect was only refreshing
`voice_states`. Everything else — member lists, channel lists,
presence, DMs, read states, notification overrides, relationships —
stayed at the snapshot from before the connection died. The only way
to recover was a full app restart.

This is the symptom the user described as "settings should be linked
to the account, not cache-based": the app *felt* cache-driven because
events that should have updated the UI in real time were vanishing
into a dead socket.

**Symptoms (all the same root cause).**

- *"Cousin joined the server but I didn't see him until I restarted."*
  `GUILD_MEMBER_ADD` was dispatched to a zombie socket, never reached
  the client, and the member list stayed stuck.
- *"He's in voice chat, I can hear him but can't see he's in the
  channel."* `VOICE_STATE_UPDATE` was lost the same way. After the
  watchdog reconnected, `READY` brought back fresh voice states (so
  the user heard him connect to audio) but the *member list* hadn't
  been refreshed, so his row wasn't there to render the voice badge on.
- *"Shows offline but he's active."* `PRESENCE_UPDATE` was lost and
  `READY` doesn't include a presence dump.

**Fix.** Track whether the current auth session has seen a `READY`
event yet. On the first `READY` (initial connect): skip the refetch
because the initial-bootstrap `useEffect` is already running it in
parallel. On every `READY` after that (reconnect): treat it as "I
missed events while I was gone" and re-run the bootstrap:

- `refreshGuilds`, `loadDMs`, `loadReadStates`,
  `loadNotificationOverrides`, `loadRelationships`
- `loadChannels(gid)` for every guild already in `state.channelsByGuild`
- `loadMembers(gid)` for every guild already in `state.membersByGuild`
  — this is what makes the cousin-joined-but-invisible symptom go
  away, because `listMembers` returns the full DTO including each
  member's current presence

The `readyOnceRef` is reset to `false` in the effect's cleanup so a
logout → login cycle gets a fresh first-READY semantic. All loaders
are fire-and-forget with `.catch(() => undefined)` so one slow
endpoint doesn't block the others.

**What the server already did right (and doesn't need changes).**

- `dispatch.userJoinedGuild` correctly publishes `GUILD_MEMBER_ADD`
  to the `kind: 'guild'` audience after updating the joiner's
  snapshot.
- `voiceStateUpdate` correctly publishes to the guild audience on
  join, leave, and mute-state changes.
- IDENTIFY broadcasts the current user's presence to every shared
  guild + DM, so *other* users see *you* come back online correctly.

It was only the inverse — *your* view of others' state changes during
a zombie window — that needed the client-side fix.

**Related thing that already works (so I didn't touch it).** Guild
ordering / folders persist server-side via `users.guild_order` and
`users.guild_folders` columns; the `GuildList` component already syncs
to the server on reorder and reads the server's value from
`auth.user.guildOrder` on mount, falling back to localStorage only as
an offline cache for first paint. The localStorage handling there is
defensive, not a missing-server-sync bug.

---

# Performance audit pass — fixes for general user experience

These don't fix user-visible *bugs* (the app works); they fix
slowness that would scale poorly or that already adds latency to
every interaction. Most users would feel the difference on first
login, channel switch, and any moderately busy guild.

## 11. Reducer re-allocates state on no-op presence / user updates

**Files:** `apps/web/src/state/AppState.tsx` (`PRESENCE_PATCH` and
`USER_REPLACE` reducer cases)

**Bug.** Two of the highest-frequency reducer actions allocated a
new top-level state object even when the incoming event changed
nothing visible:

- `PRESENCE_PATCH` always cloned `usersById` even when the user
  wasn't cached anywhere, and always created a new state object.
- `USER_REPLACE` always allocated a new `usersById` even when every
  field on the incoming user matched the cached one.

Why it matters: `useAppState()` returns a context value memoized on
`state`. Any new state reference triggers a re-render in every
consumer of `useAppState` — which is most of the app's components.
The gateway re-broadcasts presence on every IDENTIFY (for stale-state
healing) and fans `USER_UPDATE` out per-guild, so a user shared across
N guilds sends N identical payloads. Both events fire constantly in
even a small server.

**Fix.** Early-return `state` when:
- `PRESENCE_PATCH`: user not in `usersById` AND not in the affected
  guild's member list. Also bail when the status already matches what
  the patch says.
- `USER_REPLACE`: every field on the incoming user matches the cached
  row. Member-list snapshots are kept aligned by the other reducers,
  so when prev matches incoming there's nothing to propagate.

## 12. Role-set was sequential N round-trips

**Files:** `apps/api/src/routes/guilds.ts`
(`PATCH /:guildId/members/:userId`)

**Bug.** Changing a member's role set sent every `assertCanManageRole`
through a serial `for await`. The role-picker UI sends the entire
desired role set on Save, so a 10-role overhaul paid 10 sequential
hierarchy-check round-trips.

**Fix.** `Promise.all` over the hierarchy checks. They're independent
— each just reads its target role's position and compares against
the actor's top. Add/remove loops stay sequential intentionally
because each one writes its own audit row (ordering matters for
auditability) and they touch the same `(guildId, userId)` row in
`member_roles`, so concurrent INSERTs/DELETEs would serialize on the
index anyway.

## 13. Embed dispatch DTO rebuild was 7+ sequential queries

**Files:** `apps/api/src/services/embeds.ts` (`resolveAndPersistEmbeds`
dispatch broadcast)

**Bug.** After persisting resolved embeds, the broadcast path
rebuilds the full message DTO so connected clients see the embed
inline. That rebuild was 7+ sequential `await`s: author, attachments,
reactions, user mentions, role mentions, polls, forward sources.
Every URL-bearing message paid this latency between embed save and
the gateway broadcast.

**Fix.** Wrap all seven independent lookups in a single
`Promise.all`. Sticker lookup stays out of the parallel block because
its dynamic `import('./stickers')` dominates latency on the typical
no-sticker path; doing it eagerly for every embed would waste cost
on most messages.

## 14. Avatar and embed images loaded eagerly

**Files:** `apps/web/src/lib/AvatarImage.tsx`,
`apps/web/src/app/MessageEmbeds.tsx`

**Bug.** `<img>` elements in the message bubble (avatar) and in
embed cards (preview image) had no `loading="lazy"` or
`decoding="async"`. Scrolling a 500-message channel forced the
browser to eagerly load and synchronously decode hundreds of images,
blocking the main thread and stalling first paint.

**Fix.** Add both attributes. They're native HTML; defers off-screen
images and runs the decoder on a background thread when possible.

## 15. Poll hydration was 4 sequential queries

**Files:** `apps/api/src/services/polls.ts` (`loadPollsForMessages`)

**Bug.** After loading the polls themselves, the helper ran four
independent queries one at a time: options, vote tallies, distinct
voter counts, and the caller's own votes. Called on every message
hydration (channel list, search, pin panel, every poll-vote
MESSAGE_UPDATE broadcast). Each poll-vote broadcast paid 4 sequential
round-trips just to compute the new tally to send.

**Fix.** `Promise.all` over the four. The dependency on `pollIds`
is satisfied before the parallel block; the queries themselves are
mutually independent.

## 16. Gateway dispatch scanned every connection per event

**Files:** `apps/api/src/gateway/registry.ts`

**Bug — biggest server-side win in this pass.** For guild and
channel audience events (which is most events — every chat message
is one), `candidateConnections` returned every authenticated
connection on the entire server, then `shouldReceive` filtered them
with a per-connection Set lookup. On a server with 10,000 connected
users (~15,000 connections at 1.5 tabs each), each chat message paid
15,000 Set lookups to find the maybe-50 recipients in the actual
guild.

**Fix.** Maintain two new indexes:

- `byGuild: Map<bigint, Set<Connection>>` — connections that have
  this guild in their snapshot
- `byDMChannel: Map<bigint, Set<Connection>>` — connections that
  have this DM in their snapshot

Wired into every lifecycle path that mutates `conn.guildIds` or
`conn.dmChannelIds`:
- `index(conn)` seeds both indexes from the conn's initial snapshot
  (set by IDENTIFY)
- `remove(conn)` tears them down on disconnect
- `addGuildToUser` / `removeGuildFromUser` keep `byGuild` in sync
  with the per-conn `addGuild` / `removeGuild` calls
- `addDMToUser` / `removeDMFromUser` keep `byDMChannel` in sync

`candidateConnections` now reads from these indexes for guild and
channel audiences. Channel audience uses `byGuild[guildId]` plus
the per-conn `viewableGuildChannelIds` filter (members with
VIEW_CHANNEL denied on a specific channel still get correctly
narrowed out).

`connectedUsersInGuild` (used by permission-change helpers) was also
updated to use the new index — was O(total-users), now
O(connections-in-this-guild).

End result: a chat message in a 50-person guild does ~50 lookups
on a 10k-user server instead of ~15,000. Idle, untouched guilds
contribute zero work to other guilds' dispatch.

## 17. IDENTIFY ran 3 redundant DB queries on every connection

**Files:** `apps/api/src/gateway/server.ts` (`handleIdentify`)

**Bug.** After the initial parallel snapshot load (user, guild
memberships, DM recipients), the post-`READY` presence-broadcast
block re-fetched all three:
- `SELECT users.status` to derive the post-update status
- `SELECT guildMembers` for the broadcast audience
- `SELECT dmRecipients` for the broadcast audience

All three were already in memory from the top-of-handler load. The
status re-read was particularly silly: the conditional `UPDATE users
SET status='online' WHERE status='offline'` has only two possible
outcomes for any given prior value, both derivable from the prior
status without a re-query.

**Fix.** Drop the three queries. Derive post-update status from
`user[0].status` (offline → online; everything else unchanged) and
re-use the already-loaded `guildIds` and `dmChannelIdRows`. Saves
3 round-trips per IDENTIFY — paid on every login and every gateway
reconnect.

## 18. loadForwardSources had 3 sequential queries

**Files:** `apps/api/src/services/messages.ts` (`loadForwardSources`)

**Bug.** After the initial messages-by-id query, the helper ran
three more queries one at a time: authors, channels, and
attachments. All three are independent — author/channel ids come
from the in-memory messages array, and the attachment loader takes
the original `sourceMessageIds`.

**Fix.** Parallelize via `Promise.all`. Hot on any channel that
contains forwarded messages — message-list hydration, search, pin
panel.

## 19. MessageItem rendered content on every parent re-render

**Files:** `apps/web/src/app/MessageItem.tsx`

**Bug.** `renderMessageContent` runs an inline-markdown pass with
several regex matchAll operations per message body (mentions,
channel links, custom emoji, URLs) plus ReactNode construction.
The result wasn't memoized — every parent re-render of MessageItem
re-ran the entire pipeline. Combined with `useAppState()` causing
every consumer to re-render on every state change, this meant the
markdown pipeline ran 50× per second in a busy chat.

**Fix.** Wrap the render in `useMemo` keyed on `message.content`
and `renderCtx` (which is itself already memoized). The memo bails
on every render where the content hasn't changed, which is almost
every render.

## What I noticed but didn't fix here

These would be larger refactors and didn't make the cut for this
focused pass; they're worth a follow-up if perf still doesn't feel
right after these land.

- **`useAppState` re-renders every consumer on every dispatch.** The
  context value is memoized only on `state`, so any reducer action
  fans out a new value to every component subscribing through
  `useAppState`. The proper fix is selector-based context
  (`use-context-selector`) or migrating to a state library like
  Zustand. Once that lands, `React.memo` on MessageItem / MemberList
  rows starts being meaningful — without it, memoizing those
  components doesn't help because they re-subscribe to the context
  on every re-render.
- **MemberList renders member rows inline.** Same issue as
  MessageItem before the markdown memo — every row re-renders on
  every state change. Lifting rows into a memoized child component
  would help, but only after the context-selector refactor above.
- **`applyGuildPermissionChange` recomputes per-user in parallel.**
  For a 1000-user guild with a bulk permission flip, this fires
  1000 parallel resolver calls. Could overwhelm the DB pool at
  scale; for typical self-hosted use it's fine.
- **SSRF in embeds: `safeResolve` does DNS but `fetch(url)` re-resolves.**
  The comment claims IP is pinned via a Host header but the code
  doesn't actually do that — DNS rebinding could swap a public IP
  for a private one between the SSRF check and the fetch. The fix
  needs an `undici.Agent` with a custom `lookup` callback. Risk is
  narrow on self-hosted (attacker would need to control a domain's
  DNS to flip resolution mid-request), but worth fixing before
  exposing the embed resolver to untrusted networks.
- **Embed dispatch rebuilds the full DTO** when only `embeds` changed.
  A cheaper "patch" event with just the new embeds would avoid the
  parallel rebuild entirely. Tradeoff: requires a wire-protocol
  addition and client-side handler. Deferred.

---

# Third audit pass — security/correctness round

## 20. Banned and kicked users kept streaming voice

**Files:** `apps/api/src/services/voice.ts`,
`apps/api/src/routes/guilds.ts`, `apps/api/src/env.ts`

**Bug.** When a moderator banned or kicked a member, the guild
membership was deleted (cascading through `member_roles`) and gateway
events were dispatched correctly — but no cleanup touched the voice
state. The user's `voice_states` row sat there orphaned, and more
importantly their LiveKit access token (TTL: 1 hour) stayed valid.
The result: a banned user could keep talking and listening in a
voice channel of a guild they were no longer a member of, for up
to an hour after the ban. Same for kicks.

**Symptom.** Real moderation failure: "I banned them and they're
still in voice." Hard to notice until it happens.

**Fix.** Added `voice.evictFromVoiceInGuild(userId, guildId)` that:
- Deletes the voice-state row scoped to that specific guild (a
  plain `leaveVoice` would also yank them from voice in unrelated
  guilds they still legitimately belong to)
- Calls LiveKit's `RoomServiceClient.removeParticipant` to drop
  them at the SFU level
- Returns the prior voice state so the caller can broadcast
  `VOICE_STATE_UPDATE` to the remaining members

The LiveKit removal is best-effort — if the SFU is unreachable or
the user wasn't currently connected, we log and continue. The DB
delete + gateway broadcast still land, which means the client UI
updates correctly even when the audio cleanup couldn't reach the
SFU. New env var `LIVEKIT_HTTP_URL` is optional and auto-derived
from `LIVEKIT_WS_URL` for typical deployments — existing setups
need no config change.

Both `DELETE /:guildId/members/:userId` (kick) and
`PUT /:guildId/bans/:userId` (ban) now call the eviction before
dispatching `userLeftGuild`. If the user wasn't in voice in that
guild, the helper is a cheap no-op.

## 21. Paginating reactions past page 1 returned empty

**Files:** `apps/api/src/services/reactions.ts` (`listReactingUsers`)

**Bug.** Pagination was applied in JS *after* the SQL `LIMIT`:

```ts
const rows = await db.select()...orderBy(...).limit(opts.limit);
return opts.after ? rows.filter((r) => r.userId > opts.after!)... : rows...;
```

Any "show more" request past the first page would slice into a
window that contained zero rows past `after` and return an empty
list — even when more matching reactions existed further along.
The reaction-user popover would show a few users, then "no more"
forever.

**Fix.** Push the `gt(userId, after)` predicate into the SQL WHERE
so the LIMIT applies to the post-filter window, not before it.

## 22. Read-state ack did a redundant SELECT after every UPSERT

**Files:** `apps/api/src/services/readStates.ts` (`ack`)

**Bug.** The ack flow was: do a sanity SELECT to verify the message
belongs to the channel → UPSERT the read state → re-SELECT to read
back the committed `lastMessageId` so the route could echo it. The
re-SELECT was unnecessary; `UPSERT ... RETURNING last_message_id`
gives the same value in the same round-trip.

Why it matters: `ack` fires on every channel open and every "mark
as read" interaction — one of the hottest write endpoints in the
app. Every user click in the channel rail paid an extra round-trip.

**Fix.** Use `.returning({ lastMessageId })` on the UPSERT. One
fewer round-trip per ack.

## 23. Role reorder ran N sequential UPDATEs inside a transaction

**Files:** `apps/api/src/services/roles.ts` (`reorderRoles`)

**Bug.** The role-rail drag-reorder endpoint dispatched one
`UPDATE roles SET position = ?` per moved role inside a
transaction. Because all queries inside a single Drizzle/postgres-js
transaction share the same connection, they serialize even if you
`Promise.all` them — so the previous code paid N sequential
round-trips per drag-end. A guild with 20 roles paid 20 round-trips
every time an admin shuffled the role list.

**Fix.** Replace the per-row UPDATE loop with a single statement
using a `CASE WHEN id = X THEN Y ... END` expression. One UPDATE,
one round-trip, no matter how many roles moved. Filters out
@everyone (position-locked) up front so it doesn't end up in the
CASE.

## 24. Permission checks ran 5–7 sequential queries on every message route

**Files:** `apps/api/src/services/permissions.ts` (`loadMember`,
`computeMemberChannelPermissions`)

**Bug.** Every message route call goes through `loadChannelContext`
→ `computeMemberChannelPermissions` → `loadMember`. The full chain
ran sequentially:

- `loadMember`: 4 sequential queries — guild row, membership row,
  member-role-ids, role definitions. The first three are mutually
  independent (all keyed on `(guildId, userId)`); only the role
  definitions depend on the role-ids result.
- `computeMemberChannelPermissions`: `loadMember` (~4 queries) then
  the permission_overrides query — also independent.

Net: 5–7 sequential round-trips per message route call, all on the
hot path.

**Fix.**
- `loadMember`: `Promise.all` the three independent queries, then
  the dependent roles query. Saves 2 round-trips per call.
- `computeMemberChannelPermissions`: `Promise.all` the
  `loadMember` call with the permission-overrides query. Saves
  another round-trip on the typical "user is a member" path.

The asymmetric case (user *isn't* a member, `loadMember` returns
null) pays for one wasted overrides query — it's a small `inArray`
on at most 2 channel ids, dwarfed by the gain on the hot path.

End result: 3 fewer round-trips on every authenticated message
operation. Compounds across `send`, `list`, `edit`, `delete`,
`react`, `pin`, `ack`, and every other channel-scoped endpoint.

---

## Reorder of channels — noticed but not fixed

`channels.ts reorderChannels` has the same N+1 pattern as the role
reorder I just fixed — one UPDATE per moved channel inside a
transaction. The author's comment explicitly acknowledges the
tradeoff in favor of maintainability with Drizzle's typed update.
A 500-channel reorder pays 500 round-trips. Less common than role
reorders (channel rails don't get shuffled as often) and the bigger
fix would mean a custom SQL CASE like in roles. Worth a follow-up
pass if admins of large servers report slow rail drags.

*Update: fixed in fix #25 below.*

## Thread-creation race — noticed but not fixed

`createThread` does SELECT-then-INSERT without a unique constraint
on `(parentMessageId, type='public_thread')`. Two clients clicking
"Create Thread" on the same message at the same instant could both
pass the SELECT and both INSERT, producing two parallel threads
that work independently. Not catastrophic but ugly. The clean fix
is a partial unique index, which means a new migration — deferred
until the rest of the v1.x migration set is being touched.

*Update: fixed in fix #26 below.*

---

# Fourth audit pass — tractable cleanups from the deferred list

## 25. Channel reorder did N sequential UPDATEs (same shape as the role-reorder bug)

**Files:** `apps/api/src/services/channels.ts` (`reorderChannels`)

**Bug.** Same pattern as fix #23 for roles, in a different table.
The channel-reorder service issued one `UPDATE channels SET position
= ?` (and optionally `parent_id`) per moved row inside a single
transaction. All queries in a Drizzle/postgres-js transaction share
one connection, so the loop serialized regardless of any wrapper.
A 500-channel reorder paid 500 sequential round-trips.

Channel reorders are admittedly less common than role reorders —
admins typically don't shuffle the channel rail constantly — but the
fix is the same shape so worth doing.

**Fix.** Replace the per-row UPDATE loop with one statement using two
CASE expressions:

- `position = CASE WHEN id = X THEN newPos ... ELSE position END`
- `parent_id = CASE WHEN id = X THEN newParent ... ELSE parent_id END`

The `parent_id` CASE is only built when at least one row in the
batch actually supplies a parentId (undefined means "leave it
alone"); when no row reparents, parent_id stays out of the SET
clause entirely. willChange filtering runs upfront so the CASE
only covers rows that actually need an update.

End result: O(1) round-trips for any reorder size. A 500-channel
reorder is now a single statement.

## 26. Thread-creation race fixed via partial unique index

**Files:** `packages/db/migrations/0022_thread_unique_anchor.sql` (new),
`packages/db/migrations/meta/_journal.json`,
`apps/api/src/services/threads.ts` (`createThread`)

**Bug.** Two concurrent `createThread` calls for the same anchor
message could both pass the initial SELECT (returning "no existing
thread"), both INSERT, and both commit — leaving two thread channels
anchored to the same message. The schema had no unique constraint
that would have caught this.

**Fix.** Two-part:

1. **Migration 0022** adds a partial unique index:
   ```
   CREATE UNIQUE INDEX channels_thread_anchor_unique_idx
     ON channels (parent_message_id)
     WHERE type = 'public_thread' AND deleted_at IS NULL;
   ```
   Partial because non-thread channels (DMs, voice, categories, etc)
   either have NULL `parent_message_id` or use it for unrelated
   purposes; we only want uniqueness on the live-thread-anchor case.

2. **Service** wraps the INSERT in try/catch and treats Postgres
   `23505` as "another caller won the race." On 23505 we re-run
   the lookup and return the winning thread — exactly the same
   pattern as `dms.getOrCreateDM` (fix #6) and
   `relationships.sendFriendRequest` (fix #7).

End user effect: a rage-click on "Create Thread" or two browser
tabs racing now both end up looking at the same thread instead of
two parallel ones.

## 27. SSRF: DNS rebinding between safeResolve and fetch

**Files:** `apps/api/src/services/embeds.ts` (`fetchHtml`),
`apps/api/package.json` (added `undici` dep)

**Bug.** The embed resolver had a classic time-of-check / time-of-use
DNS-rebinding hole. `safeResolve` did a `dns.lookup` and verified the
resolved IP wasn't in a private range. Then `fetchHtml` called the
global `fetch(url)`, which under the hood does its OWN DNS lookup
when establishing the TCP connection. If a malicious domain served a
DNS record with TTL=0 alternating between a public IP and an internal
IP, the resolver's first lookup could pass the private-IP check while
the connect-time lookup landed on the internal IP — making a request
to an internal service while the SSRF gate thought it was talking
to the public one.

The file's own comment claimed "we pass the resolved IP to the
fetcher with a Host header pinning the original hostname" but the
code didn't actually do that. The comment was aspirational.

**Severity.** Narrow in practice but real:
- Attacker must control a domain's DNS (easy: register a domain).
- The two DNS lookups must return different IPs (TTL=0 fast-flux).
- The server must have private services worth reaching from the
  embed fetcher's network position.

Self-hosted Zekktris instances on a network with internal services
are the realistic threat surface. A standalone deployment with no
internal HTTP services has nothing to hit, but you can't count on
that without knowing the deployment.

**Fix.** Add `undici` as a direct dependency (it's the same library
Node uses internally for global `fetch`, so the wire behavior is
identical) and use `undici.Agent` with a custom `connect.lookup`
that pins the TCP target to the IP we already validated:

```ts
const agent = new Agent({
  connect: {
    lookup: (_hostname, _opts, callback) => {
      callback(null, pinnedIp, pinnedFamily);
    },
  },
});
const res = await undiciFetch(url, { dispatcher: agent, ... });
```

The lookup override forces every connect for this fetch to use the
pre-validated IP. TLS SNI and the HTTP Host header still use the
original hostname (because we don't change the URL), so HTTPS cert
verification works correctly. Redirects build a fresh Agent per hop
since the pinned IP would no longer match the new hostname after
a cross-host redirect.

Agent lifecycle is managed explicitly with `.destroy()` on every
exit path (success, redirect, error, body-cancel) so connection
pools don't leak.

---

---

# Fifth audit pass — context-selectors + sharding documentation

## 28. Selector-based subscriptions for the two highest-volume row components

**Files:** `apps/web/src/state/AppState.tsx`,
`apps/web/src/app/MessageItem.tsx`, `apps/web/src/app/MessageView.tsx`,
`apps/web/src/app/MemberList.tsx`, `apps/web/package.json` (added
`use-context-selector`)

**Bug.** Every reducer dispatch produced a fresh context value, and
because `useAppState()` consumed the whole value with React's default
`useContext`, *every* component using app state re-rendered on *every*
state change — even on events that touched slices the component
didn't read. In a busy guild, the gateway fires presence updates,
typing events, member upserts, etc. constantly, and each one
triggered a full chat-view re-render. With 50 visible `MessageItem`s
plus a 500-row `MemberList`, that's hundreds of unnecessary row
re-renders per second.

The reducer no-op-bail-early fixes (#11a, #11b) helped — they at
least skipped state allocation when nothing changed — but they
couldn't help when something *did* change in a slice the component
didn't care about.

**Fix.** Three parts:

1. **Plumbing.** Added `use-context-selector` and swapped `AppState.tsx`'s
   `createContext` + `useContext` for the library's variants. Kept the
   existing `useAppState()` hook unchanged so the 82 other call sites
   (FriendsView, ChannelList, GuildList, the settings modals, every
   tab and panel) keep working with identical semantics. Added a new
   `useAppStateSelector<T>(selector)` hook for granular subscriptions
   — consumers can read just the slice they need, and only re-render
   when that slice's reference changes.

2. **MessageItem migrated.** Replaced the single
   `const { state, retrySendMessage, discardFailedMessage } = useAppState()`
   with 10 individual `useAppStateSelector` calls — one per state
   slice the component reads (`membersByGuild`, `rolesByGuild`,
   `relationships`, `channelsByGuild`, `emojisByGuild`, `usersById`,
   `messagesByChannel`, `guildsById`) plus each callback. Then wrapped
   the export in `React.memo`. The component now only re-renders when
   one of its specific slices changes — a presence event in a guild
   the user isn't currently viewing doesn't bump the slice references
   the chat-view reads, so no message bubble re-renders at all.

3. **`onReply` stabilized in MessageView.** The inline arrow at the
   `<Scroller onReply={(m) => setReplyTo(m)}>` call site was a fresh
   function reference every render, which would have defeated
   `React.memo` on `MessageItem` (shallow prop comparison sees a new
   onReply ref and bails out of the memo bail). Wrapped in
   `useCallback([])` so the identity is stable for the component's
   lifetime.

4. **MemberRow extracted from MemberList.** The inline member-row
   JSX inside `section.members.map(...)` was lifted into a separate
   `MemberRow` component wrapped in `React.memo`. Now a presence
   patch for one member re-renders one row instead of all 500.

A small TypeScript-inference subtlety: the `useAppStateSelector`
implementation passes the selector through to `useContextSelector`
with a one-shot non-null cast on the context value. Wrapping the
selector in a closure that did the null check inline caused TS to
lose the `T` parameter inference through the nested function,
silently widening every selected slice to `unknown` (and producing
a cascade of `implicit any` errors at consumer call sites). The
type-correctness cost of "null check inside a wrapper" was higher
than the runtime safety it bought, since every render path that
mounts a selector-using component is already gated on the provider
being present by `AuthContext`.

**What's still pending.** The other 80+ `useAppState()` call sites
still re-render on every dispatch. Migrating them is mechanical but
voluminous — each site needs a selector per slice it reads. The
two components migrated this round are by far the highest-volume
re-renderers (one row per message + one per member); the rest are
panels, modals, and other non-list components where the cost of
the unnecessary re-renders is bounded. Incremental migration is the
right shape going forward.

## 29. Gateway sharding — documented, not implemented

**Files:** `docs/SHARDING.md` (new)

This one I want to be candid about: I didn't write sharding code,
and I think that's the right call.

The `EventBus` interface in `bus.ts` is already a clean swap point
— the original author wrote it that way explicitly so a Redis (or
NATS, or anything else) backend could be plugged in via
`setEventBus()` at startup. The audit rounds preserved that
invariant: nothing outside `bus.ts` references the
`InMemoryEventBus` implementation directly. So the extension point
is there and validated.

What's missing for actual multi-node deployment isn't a code
abstraction; it's:
- Picking a pub/sub backend (Redis vs NATS vs Kafka vs custom)
- Choosing a client library
- Writing the serialization layer (audiences contain `bigint` IDs
  that don't survive `JSON.stringify` without explicit handling)
- Operational concerns (health checks, drain on SIGTERM, backpressure)

Those are deployment decisions, not bug fixes. Adding a fake
"scaffolding" RedisEventBus with TODO comments would be worse than
honest documentation — it would imply the work is done when it
isn't.

Instead, I wrote `docs/SHARDING.md`: a ~100-line operator's guide
covering when single-node is sufficient (most cases), what
cross-node delivery actually requires, a working sketch of a
`RedisEventBus` implementation that an operator can drop in, the
serialization gotcha, and an honest call-out that no code in v1.67
enables sharding. The doc also explains why several tempting
"fixes" aren't actually required (session affinity for correctness,
cross-node session storage, event ordering across replicas — all
already work).

The per-guild and per-DM-channel registry indexes from fix #16
still pay off in the multi-node case: each replica only does
audience filtering against its local connections, so a 50-person
event in a 10k-user cluster still does 50 lookups per replica
(not 10k).

---

---

# Sixth audit pass — security sweep of less-trodden routes

This round picked the surface I hadn't deeply audited yet — admin
routes, CDN/file-serving, auth flows, webhooks — on the principle
that auth and file-serving paths are where serious bugs tend to
hide and the previous five rounds had focused mostly on guild and
message flows.

## 30. CDN content-type XSS — user-uploaded HTML executed in app origin

**Files:** `apps/api/src/routes/cdn.ts`,
`apps/api/src/services/uploads.ts`

**Bug.** The upload service stored `file.type` verbatim:
```ts
contentType: file.type || 'application/octet-stream',
```
The CDN serve path then echoed it straight back to the browser:
```ts
c.header('Content-Type', r.attachment.contentType);
c.header('Content-Disposition', `inline; ...`);
```
Combined, this was a stored-XSS distribution channel: an attacker
uploads `evil.html` declaring `Content-Type: text/html`, receives a
`/cdn/<id>/evil.html` URL on the SAME ORIGIN as the API (Caddy
mounts both at `app.example.com`), and any browser that loads the
URL runs the attacker's HTML/JS with access to the user's auth
cookies, localStorage, and the in-flight access token. Sharing the
URL with another user was effectively giving them a payload to
detonate against themselves.

Avatars/emoji/stickers/guild-icons were safe by accident — their
serve path computes content-type from filename extension via
`avatarContentTypeFromName`, which only returns image types. But
the message-attachment path trusted the stored DB column.

**Fix.** Three layers:

1. **At serve time** (`cdn.ts`): introduced an `INLINE_SAFE_MIME` Set
   listing types that browsers can safely render inline at our
   origin — `image/png|jpeg|gif|webp|avif`, all the standard audio
   types, `video/mp4|webm|quicktime`, `application/pdf`,
   `text/plain`. Notably **excluded**: `text/html`,
   `application/xhtml+xml`, `application/javascript`,
   `image/svg+xml` (SVG can carry `<script>`), `application/xml` /
   `text/xml` (XSLT injection). For anything outside the allow-list
   the response gets `Content-Type: application/octet-stream` and
   `Content-Disposition: attachment` — the browser downloads
   instead of executing. Refactored the 5 storage classes
   (attachments + 4 image-only paths) to share a single
   `applyCdnHeaders` helper so the policy is enforced in exactly
   one place and a future code path can't accidentally diverge.

2. **`X-Content-Type-Options: nosniff` on every CDN response.** Belt
   and suspenders: even if some bug allowed an unsafe content-type
   to slip through, the browser is told not to MIME-sniff the
   body and override our declaration.

3. **At the upload boundary** (`uploads.ts`): added
   `normalizeContentType(filename, claimed)` that trusts the file
   extension over the client-declared MIME and stores the canonical
   type. A file with `.png` extension stores `image/png` regardless
   of what the upload claimed; an unknown extension stores
   `application/octet-stream` regardless. This is defense-in-depth
   — future code paths that read
   `attachments.contentType` directly (webhook embeds, search-result
   thumbnails, anything I haven't audited) can't be tricked by an
   attacker-declared `text/html` on a `.png`.

One filename-handling subtlety also landed: the previous
`Content-Disposition: inline; filename="${name.replace(/"/g, '')}"`
escape was minimal. The new `applyCdnHeaders` strips control bytes
in addition to quotes (`/[\x00-\x1f"\\]/g → '_'`). Header
injection wasn't reachable through Node's stdlib (the writer
rejects CR/LF anyway), but the broader sanitisation gives more
predictable downloaded filenames.

## 31. Admin instance-ban left voice and WebSockets active

**Files:** `apps/api/src/routes/admin.ts`,
`apps/api/src/services/voice.ts`

**Bug.** The instance-wide ban path (`/admin/users/:id/ban`) did
two things:
```ts
await db.update(users).set({ bannedAt: ... });
await revokeAllUserSessions(targetId);
```
Neither of these touched the user's *current* state:
- Active WebSocket connections kept reading every event the user
  was subscribed to until the next heartbeat-ack failure or natural
  client reconnect (~40s minimum, but a healthy connection just
  keeps going). The session was revoked at the DB level, but the
  WS doesn't re-check session validity per frame.
- The user's LiveKit token stayed valid for its full TTL (~1
  hour), so they could keep transmitting audio in whatever voice
  channel they happened to be in.

So a banned user could keep reading messages and talking in voice
for up to an hour after the ban. This is the same shape of bug as
fix #20 (guild-level ban not evicting from voice), but for the
instance-wide ban.

**Fix.** Added `voice.evictFromAllVoice(userId)` — the unscoped
sibling of `evictFromVoiceInGuild` from #20. It deletes the user's
voice-state row (single-row-per-user invariant means at most one
delete) and calls LiveKit's `removeParticipant` on a best-effort
basis. Wired into the admin-ban route after session revocation:

```ts
const priorVoice = await voice.evictFromAllVoice(targetId);
if (priorVoice) {
  dispatch.voiceStateUpdate({
    guildId: priorVoice.guildId,
    voiceState: leftVoiceStateDTO({ userId: targetId, guildId: priorVoice.guildId }),
  });
}
const conns = registry.byUserId(targetId);
for (const conn of conns) {
  try { conn.close(4004, 'account disabled'); } catch {}
}
```

The WebSocket close cascades through the existing
`onUserFullyDisconnected` handler — presence flips to offline,
voice state cleanup runs (redundant with the explicit
`evictFromAllVoice` above, but idempotent and the explicit call
covers the case where the user had no live WS but still had voice
presence). CloseCode 4004 maps to `AUTHENTICATION_FAILED` in the
gateway types — generic enough that the client surfaces a "signed
out" message without leaking the moderation context.

The unban path was left as-is — the user has to sign in again
anyway, so the next auth attempt picks up the cleared
`banned_at`.

## 32. Avatar / banner / guild-image replacement leaked old files on disk

**Files:** `apps/api/src/services/uploads.ts`,
`apps/api/src/routes/users.ts` (avatar + banner),
`apps/api/src/routes/guilds.ts` (icon + banner)

**Bug.** Each of the four image-replacement routes followed the
same pattern:
```ts
const saved = await saveUploadedFile(file);
await db.update(...).set({ avatarUrl: saved.url });
```
No reference to the previous URL — the row's `avatarUrl` column
flipped to the new file and the previous file was orphaned on
disk forever. For a normal user cycling through avatars this is
bounded waste; for a malicious user (or a server hosting many
active users), uploading in a loop is a clean disk-fill vector.
On the order of one upload per second is enough to chew through
GBs in a day, and there's no garbage collection.

**Fix.** Added `parseCdnAttachmentId(url)` to `uploads.ts`:

```ts
const m = /^\/cdn\/(\d+)\//.exec(url);
if (!m) return null;
return BigInt(m[1]);
```

For each replace route, pre-SELECT the prior URL, parse out the
attachment id, run the save + DB update, then fire-and-forget
delete the old file:

```ts
const priorRows = await db.select({ avatarUrl: schema.users.avatarUrl })...;
const priorAvatarId = parseCdnAttachmentId(priorRows[0]?.avatarUrl);
const saved = await saveUploadedFile(file);
await db.update(users).set({ avatarUrl: saved.url })...;
if (priorAvatarId !== null && priorAvatarId !== saved.attachmentId) {
  void deleteAttachmentFile(priorAvatarId);
}
```

The defensive `priorId !== saved.attachmentId` check guards against
a degenerate case where the new save somehow reused the prior id —
shouldn't happen with monotonic snowflakes, but the check is
trivial.

Same pattern applied to all four routes: `/@me/avatar`,
`/@me/banner`, `/:guildId/icon`, `/:guildId/banner`. The route
files now do dynamic imports for `{ saveUploadedFile,
deleteAttachmentFile, parseCdnAttachmentId }` together since they
all need the same trio.

Externally-hosted URLs (admin SQL fix-ups that point an avatar at
gravatar, etc.) are handled correctly — `parseCdnAttachmentId`
returns null for anything not matching `/cdn/<digits>/`, and the
delete is skipped.

What this DOESN'T cover: emoji replace, sticker replace, message-
attachment delete-and-reupload. Emoji/sticker have no "replace"
operation in v1 (delete + create new). Message-attachment cleanup
on message delete already runs through the existing
`deleteAttachmentFile` path in the message delete handler.

## 33. Webhook execute endpoint had no rate limit

**Files:** `apps/api/src/routes/webhooks.ts`

**Bug.** The webhook execute endpoint at
`POST /api/webhooks/:webhookId/:token` is bearer-auth-by-URL —
the token is literally in the path, and anyone with the URL can
post messages to the bound channel. No rate limit was applied:
```ts
webhooksExecuteRouter.post('/:webhookId/:token', ..., async (c) => {
  // ...
  await webhooks.executeWebhook({ ... });
  return c.body(null, 204);
});
```

Threat: tokens leak. CI configs get committed, urls get pasted in
chat by accident, server logs include the path, screenshots of
settings panels go up on the support forum. Once leaked, an
attacker can flood the channel with messages — burying real
content, exhausting message-history limits, or just making the
channel unusable.

The other consequence is search-related: with no per-token limit,
a brute force of `webhookId/token` combos against a known
`webhookId` (an attacker who knows your channel has a webhook but
doesn't know the token) can grind through 190 bits of entropy at
whatever rate the server can handle DB queries. Realistically the
search space is too big to brute-force, but adding a limit is
free defence-in-depth.

**Fix.** Two-tier rate limit, both keyed on `webhookId`:

- **Burst:** 10 messages per 5-second window
- **Sustained:** 60 messages per 60-second window

Consumed in that order at the top of the handler, before any DB
work. Both share the in-process `RateLimiter` from `auth.ts` /
existing infra. Discord's public docs cite ~5/5s; we're slightly
more generous because the failure mode of being too lax is
"channel briefly noisy" whereas being too strict breaks legitimate
CI-fan-out integrations (GitHub Actions matrix builds, Uptime
Kuma alerting cascades).

Key choice: `webhookId` alone (not `webhookId + token`). Reasoning:
the limiter should gate even when an attacker rotates through
guesses against the same webhookId — using id-only means the
(rejected) bad-token attempts share quota with the legitimate
sender, which is the conservative choice. Per-IP keying was
considered and rejected because a single CI system shouldn't be
penalised for sharing its egress IP with other webhook senders.

Multi-process caveat: limiter state is per-process in-memory, so
on multi-replica deployments each replica enforces its own quota.
A determined attacker could amplify by `n` replicas. For the
expected self-hosted single-node deployments this is a non-issue;
for multi-node, see `docs/SHARDING.md` — a shared limiter would
need the same kind of pub/sub or shared-state backend that the
gateway bus does.

---

# Seventh audit pass — runtime regression from a prior fix

## 34. undici version-cap missing in fix #27 — boot crash on Node 20

**Files:** `apps/api/package.json`, `pnpm-lock.yaml`

**Bug.** Round-four fix #27 (SSRF/DNS-rebinding defence in
`services/embeds.ts`) added `undici` as a direct dependency via
`pnpm add undici`. Without an explicit version, pnpm took the
latest major — `8.2.0` at install time. undici 8 requires Node 22
for `webidl.util.markAsUncloneable`. The production Docker image
runs Node 20.20.2, and the import path was eager (top-level
`import { Agent, fetch as undiciFetch } from 'undici'` in
`services/embeds.ts`, transitively loaded by the message router at
server start), so the container crashed during route registration
with a stack trace landing inside undici's `cachestorage.js`:

```
TypeError: webidl.util.markAsUncloneable is not a function
    at new CacheStorage (.../undici/lib/web/cache/cachestorage.js:20:17)
    at Object.<anonymous> (.../undici/index.js:179:25)
```

**Fix.** Pinned to `^6.21.0`. Lockfile resolves to undici 6.25.0.

Why 6.x specifically: Node 20 ships undici 6 bundled in its
globals (the `fetch` and `Agent` available via `node:undici`
imports come from the same major). Pinning the external dep to
the same major eliminates any API drift between code that uses
the bundled undici (none here today, but future code might) and
code that uses the explicit dependency. The `Agent` constructor
+ `connect.lookup` callback that fix #27 relies on are stable
across 5/6/7/8 — the SSRF defence works identically.

**Lesson noted.** Past me should have run `pnpm add undici@^6` —
`pnpm add` without a version cap latches onto whatever's current,
which is fine for libraries that follow semver carefully but is a
trap for runtime-platform-coupled deps like undici. Going forward
any native or platform-coupled dependency should get an explicit
major cap at install time.

---

# Eighth audit pass — admin UI fixes + feature work (user requested)

This round was driven by user feedback rather than bug-hunting: two
real UI bugs in the admin surface and three feature requests
("more options," then specifically "ghost mode — go onto servers
undetected"). I think it's worth recording these alongside the
audit fixes because the design choices have ethics implications
worth documenting for future maintainers.

## 35. Duplicate admin button in GuildList

**Files:** `apps/web/src/app/GuildList.tsx`

**Bug.** Two `<Link to="/admin">` Shield icons rendered side-by-side
in the guild rail — once with an always-accent style (likely the
older variant) and once with the muted-→-accent-on-hover pattern
that matches the Settings button. Looks like a refactor that left
the predecessor in place.

**Fix.** Removed the always-accent variant; kept the muted-→-accent
one because its hover treatment matches the Settings button next
to it. Single Shield icon, single entry point.

## 36. Admin route bypassed the Shell layout

**Files:** `apps/web/src/App.tsx`, `apps/web/src/app/Shell.tsx`,
`apps/web/src/app/AdminPanel.tsx`

**Bug.** App.tsx routed `/admin` directly to `<AdminPanel />`,
which provided its own `min-h-screen` full-page chrome. The
GuildList rail and the rest of the Shell layout weren't rendered
when the admin panel was open. From a user's perspective, the
"server rail disappeared when I went into admin" — they had to use
the "Back to app" button to return to any guild, losing context.

**Fix.** Three coordinated changes:

1. **`App.tsx`:** `/admin` now routes to `<Shell />` (same pattern
   as `/discover`).
2. **`Shell.tsx`:** added `isAdminMode = location.pathname.startsWith('/admin')`,
   gave it the same `xl:grid-cols-[72px_1fr]` grid template as
   discover mode (just rail + main; no channel-list pane), hid the
   secondary aside on admin mode, and wired `<AdminPanel />` into
   the main-content switch with an `ErrorBoundary` keyed `"admin"`.
3. **`AdminPanel.tsx`:** dropped the `min-h-screen` wrapper (Shell
   owns layout now); used `h-full flex flex-col` instead. The
   inner scroll region fills available vertical space and the
   header stays pinned. Kept the auth checks (defense-in-depth —
   if anything mounts AdminPanel without going through Shell, the
   gate still works).

## 37. New admin options: force-logout, force-delete-guild, recent activity

**Files:** `apps/api/src/routes/admin.ts`,
`packages/client/src/rest.ts`,
`apps/web/src/app/AdminPanel.tsx`

Three small, useful features rather than one large one. The
ground rule was "every action has a real moderation use case I can
name in one sentence":

### Force-logout (`POST /admin/users/:id/logout`)

Revokes all sessions for a user without banning them. Distinct
from ban: the account stays active, the user just has to sign
back in. Also closes live WebSockets with close code 4000
(generic disconnect; ban uses 4004 = AUTHENTICATION_FAILED for
the moderation context). Sentence-summary use case: "I think this
user got phished, sign them out of every device so they have to
re-auth from scratch."

UI: "Sign out" button next to "Promote"/"Demote" on user rows.
Hidden when the user is already banned (banning revokes sessions
implicitly; a separate sign-out button there is noise).

### Force-delete a guild (`DELETE /admin/guilds/:id`)

Distinct from the owner-initiated delete in `routes/guilds.ts`.
The admin path skips the ownership check (the operator can delete
any guild on the instance) and uses the admin's own userId as the
audit actor. Captures the member list before the soft-delete and
broadcasts `GUILD_DELETE` to every former member through the
existing `guildDeletedBroadcast` helper, so connected clients
clear local state immediately rather than discovering it on next
load.

Soft-delete only: the row stays in DB with `deleted_at` set, the
files stay on disk. Operators who need actual disk reclamation
should pair this with the existing data-cleanup tooling. Reason:
hard-deleting through the admin UI would be too easy to fat-finger
into a permanent data loss.

UI: red "Delete" button on guild rows in the Guilds tab.
`window.confirm` for the destructive-action confirmation — admin
tooling, not a user-facing flow, so the native dialog is exactly
right. Confirmation includes the guild name + member count so a
misclick on the wrong row is hard to miss.

### Recent activity feed (`GET /admin/activity`)

Last 10 user signups + last 10 new guild creations, parallel
queries. Rendered as a two-column section under the Overview
stat cards. Relative-time formatter ("12m ago", "3d ago") for
quick triage at a glance; hover shows the absolute timestamp.

Why this instead of a "view audit log" tab: there's no
`instance_audit_log` table yet (still deferred — see end of
file). Recent registrations + recent guild creations are the
two metrics that approximate "what's happening on my instance"
without needing the new schema. When the audit log gets built
out, this Overview section becomes the launching-point for it.

## 38. Ghost mode — read any guild's channels without being detected

**Files:** `apps/api/src/routes/admin.ts`,
`packages/client/src/rest.ts`,
`apps/web/src/app/AdminPanel.tsx`

User asked for this directly: *"Like ghost mode. Ability to go
onto servers undetected."* This is a real feature request with
real ethical weight, so I want to record both the design and the
reasoning here.

### What it does

A read-only "observe" view that lets an admin open any guild on
the instance, see its channel list, and read message history in
any channel — without ever being added as a member, without their
presence being broadcast, and without any read-state or typing
indicator side effects. From the guild's perspective, the observe
fetch is invisible: no member row, no presence event, no read
mark, no typing.

### What it doesn't do (and why)

* **Voice and stage are excluded.** LiveKit lists participants to
  every other participant in the room. There's no way to be a
  silent observer in a voice room without forking the SFU. The
  observe view shows voice channels in the channel list with a
  speaker icon and explanatory copy ("voice channels can't be
  listened to in observe mode"), but clicking one just renders
  an empty state, not an audio join.
* **No interaction whatsoever.** No message-send, no reactions, no
  typing broadcast, no read-state writes, no message edits, no
  member modifications. The view literally has no input controls.
  If a future addition would create a write side-effect, it has
  to be routed through a different endpoint and explicitly opt
  out of observe-context.
* **No membership row.** We never insert a `guild_members` row
  for the observing admin. Their guildIds list is unchanged.
  They don't show up in the guild's member list, in any
  presence broadcast, in typing indicators, or in voice-state
  lists.
* **Slim DTO.** The regular message-list endpoint hydrates polls,
  forwards, stickers, mentions, etc — necessary for a real chat
  UI, unnecessary for "what was said in this channel." The
  observe message DTO returns just content + author + attachments
  + reaction tallies + flags for the rest (hasReply, hasForward,
  hasSticker). This both reduces server work AND makes the
  observe view deliberately visually distinct from real chat, so
  the operator can never mistake observe mode for normal browsing.

### Why this isn't a new capability

The operator already has full database access. `SELECT * FROM
messages WHERE channel_id = ?` reads everything in any channel,
no matter how private. Ghost mode doesn't grant new capabilities;
it surfaces what the operator already has through a more usable
interface. The ethical question isn't *"can the admin read
private channels"* (they always could) — it's *"is the admin's
read action observable to members,"* and the design answer is
"no, by construction, but the privacy implication of that should
be made obvious to the operator."

To that end: the observe view has a conspicuous amber banner at
the top reading "Observing · members don't see you · read-only ·
voice excluded." The operator should never forget they're in
observe mode and accidentally believe they're in a normal
membership context.

### Audit-trail caveat

Every observe call writes to the API log via the existing
request-log middleware (one log line per request). That's
adequate for instances where the operator pipes API logs to a
retention store. For compliance-grade audit trails — "who
observed which channel, when, for how long" — the right answer
is the `instance_audit_log` table I've documented as a feature
gap. Building that out would let observe calls write structured
audit records the same way guild-level mod actions write to
the existing `audit_log_entries`. Not implemented in v1.67;
worth doing if the instance is operated for users who have
specifically privacy-sensitive expectations.

### Implementation surface

* **Backend:** Two endpoints — `GET /admin/guilds/:id/peek`
  (guild metadata + channel list) and `GET /admin/channels/:id/peek/messages`
  (slim message DTO, before+limit pagination, voiceChannel:true
  flag for voice/stage). Both pure-read; neither writes
  anywhere. Both go through the `requireAuth + requireAdmin`
  middleware stack.
* **Client SDK:** `adminPeekGuild`, `adminPeekChannelMessages`
  in `rest.ts`, with `AdminPeekGuild`, `AdminPeekChannel`,
  `AdminPeekMessage` DTO types.
* **UI:** An "Observe" button on each guild row in the Guilds
  tab triggers an `observing` state at the `AdminPanel` level.
  When set, the tab nav hides and `ObserveView` renders in its
  place — two-pane layout with channel list left and message
  list right. Mirrors the guild-view aesthetic enough to be
  intuitive, but deliberately not pixel-identical (different
  avatar shapes, different message density, the prominent
  banner) so the operator can never confuse it for a real chat
  view.

---

# Ninth audit pass — voice UI polish (user requested)

User asked for three changes: ditch the bottom bar in voice and let
the controls float, show real user avatars in voice contexts (not
just initials), and give the AGC toggle a manual mode plus a
visual input-level bar.

## 39. Floating voice controls

**Files:** `apps/web/src/app/VoiceView.tsx`

The bottom-bar wrapper (`border-t bg-bg-2 px-4 pt-3 ...`) is gone.
The Mic / Deafen / Camera / Screen / Volume / Leave buttons now sit
in a rounded pill, absolutely positioned bottom-center over the
participant grid with `backdrop-blur-md` + `bg-bg-2/90` + a soft
shadow. iOS safe-area inset is preserved via the inline
`bottom: max(calc(env(safe-area-inset-bottom) + 0.75rem), 1rem)`
style (CSS `max()` lets us satisfy both "clear the home indicator"
and "always at least 16px from the visible edge").

The participant scroll region picks up `pb-24 sm:pb-28` so tiles
don't disappear behind the pill at any zoom level. The previous
docked-bar approach reserved layout space for the controls; the
floating approach overlays them, which means the empty-state copy
("No one's in this voice channel yet") now sits in the visual
center of the call area rather than appearing slightly above center
due to the bar's vertical real estate.

Matches the aesthetic Discord, FaceTime, and Zoom have all
converged on for video calls in the last couple of years.

## 40. User avatars in voice-channel participant rows

**Files:** `apps/web/src/app/ChannelList.tsx`

The `VoiceParticipant` row in the channel-list sidebar rendered
ONLY the first letter of the user's display name inside a colored
disc. No `AvatarImage` overlay, no fallback to the actual profile
picture. Users in voice channels showed up as `A`, `B`, etc. — fine
when you knew exactly who was in there, useless when you didn't.

The fix lifts the same overlay pattern used in `MessageItem` and
`MemberList`: initials in a tinted disc as the fallback layer,
`<AvatarImage src={u?.avatarUrl} />` layered on top.
`AvatarImage` hides itself on load failure or null src, so users
without a custom avatar still get the colored initial fallback
visible underneath.

The speaking-indicator ring (the green glow when LiveKit's
`ActiveSpeakersChanged` says you're talking) wraps around the
whole disc, so the visual lights up the avatar regardless of
whether it's an image or initials.

Note this only addresses the channel-list sidebar rows. The voice
tiles in the main `VoiceView` already rendered `AvatarImage`
correctly — that part was working. If users without custom avatars
still see initials in the tile, that's the expected fallback (no
upload to render).

## 41. Gain mode picker + manual gain slider + live level meter

**Files:** `apps/web/src/lib/voicePrefs.ts`,
`apps/web/src/lib/voice.ts`, `apps/web/src/lib/manualGain.ts`
(new), `apps/web/src/lib/MicLevelMeter.tsx` (new),
`apps/web/src/app/SettingsModal.tsx`

### Pref refactor

The binary `autoGainControl: boolean` is replaced with a
three-state `gainMode: 'agc' | 'manual' | 'off'`:

- **`agc`** — browser AGC is on. The mic level is normalized
  automatically. Default; what most users want for voice chat.
- **`manual`** — browser AGC is off, the captured mic stream is
  piped through a Web Audio `GainNode` whose value comes from
  the user's `micGain` slider. The user has full control. Useful
  for hardware preamps, for fixing "I sound too quiet after AGC
  normalizes me," and for cases where AGC's compression artifacts
  are unwanted.
- **`off`** — browser AGC off, no manual gain processing. The
  captured signal is published as-is. Useful when a hardware
  audio chain (preamp, dynamics processor) is doing the work
  and the software path should be transparent.

Backward-compat migration in the loader: existing saved prefs with
`autoGainControl: true` migrate to `gainMode: 'agc'` (historical
default); `autoGainControl: false` migrates to `gainMode: 'off'`
(explicit-disable case — what users intentionally turning AGC off
were actually opting into). The `'manual'` mode is opt-in via the
new settings UI only; nobody is auto-migrated to it.

Removed `setAutoGainControl` and added `setGainMode(mode)`.

### Manual-gain audio chain (`manualGain.ts`, new)

When `gainMode === 'manual'`, after LiveKit's
`setMicrophoneEnabled(true)` publishes its default mic track,
`activateManualGain` runs:

1. Opens a fresh `getUserMedia` stream with `autoGainControl: false`
   (so the browser doesn't fight the manual gain) but preserves
   the user's noise-suppression and echo-cancellation choices.
2. Builds a Web Audio chain:
   `MediaStreamSource → GainNode → MediaStreamDestination`.
   The destination yields a `MediaStreamTrack` carrying the gained
   signal.
3. Calls `liveKitTrack.replaceTrack(processedTrack)` to swap
   LiveKit's published track for the gained one. From the
   listener's perspective the swap is seamless — same publication,
   different underlying track.
4. Stops the OLD `MediaStreamTrack` (the one LiveKit captured at
   `setMicrophoneEnabled` time) so the OS releases that mic
   handle. Without this step the OS shows TWO recording
   indicators (one for LiveKit's capture, one for ours) and on
   macOS the menubar privacy indicator gets stuck orange after
   disconnect.
5. Subscribes to `voicePrefs` changes — when the slider moves,
   `gainNode.gain.linearRampToValueAtTime(next, t + 0.02)` updates
   the value with a 20ms ramp. The ramp is short enough to feel
   instant on the slider drag but long enough to avoid zipper
   noise from rapid AudioParam step changes.

Failure mode: best-effort. The activation is wrapped in a try/catch
in voice.ts; on failure (browser compat edge case, LiveKit version
change in the future) the un-gained track stays published and we
`console.warn` rather than tearing down the call. The slider is
still settable but won't affect the live signal until next
reconnect.

Tear-down on disconnect closes the AudioContext, stops the raw
stream tracks, and clears the prefs subscription.

### Level meter (`MicLevelMeter.tsx`, new)

A self-contained Web Audio mic probe. Independent of any active
voice call — opens its own `getUserMedia` stream the moment it
mounts in the settings panel, runs samples through an `AnalyserNode`
at the document's `requestAnimationFrame` cadence, and renders a
horizontal bar with a peak-hold marker.

Display tuning:

- `fftSize = 1024` → 512 samples/frame. Enough for an RMS average
  without per-frame allocation overhead. We don't need frequency
  resolution, just time-domain amplitude.
- RMS is computed over the byte time-domain buffer, then raised
  to the `0.6` power before mapping to bar width. Pure RMS makes
  typical speech sit between 2% and 15% of the bar, which feels
  unresponsive; the curve makes normal speech reach into the
  middle without saturating on every loud syllable.
- Peak-hold marker: 800ms hold, then linear decay at ~1.5/s. Gives
  a sense of headroom that pure-RMS visualization doesn't carry.
- Color gradient on the active bar: green for the first 60%,
  amber 60–80%, red 80–100%. Visual warning when peaking near
  digital max, where the manual gain user is most likely to
  want to back off.
- Animation loop pauses when the document is hidden (Safari and
  Chrome both keep `requestAnimationFrame` running on hidden
  tabs at a throttled rate; we explicitly skip the work).

The meter respects the user's noise-suppression + echo-cancellation
choices in its `getUserMedia` constraints, so what they see is
representative of what listeners will hear. The meter also applies
the manual-gain value (when `gainMode === 'manual'`) so the
visualization tracks the slider live. In `agc` and `off` modes
the meter shows the unaltered signal.

Cleanup on unmount stops the stream tracks and closes the
`AudioContext`. Without this the OS would show a recording
indicator any time the settings panel was open even after close;
with it, the indicator releases as soon as the user navigates
away from voice settings.

Permission denial is handled inline: a `DOMException` of
`NotAllowedError` renders "Mic permission denied — allow access
to see your input level" instead of throwing, so the rest of the
voice settings stays usable. `NotFoundError` (no mic on the
machine) gets its own message.

### Settings UI

The single `Automatic gain control` toggle is gone. In its place:

1. A `MicLevelMeter` card showing live input level + peak-hold +
   percentage readout.
2. A 3-button segmented control for gain mode (`Auto` / `Manual` /
   `Off`), each labeled with a short subline (`Browser AGC`,
   `Slider below`, `Raw input`).
3. Context-sensitive help text that explains what the selected
   mode does.
4. A manual-gain slider (0–200% with 5% steps), always rendered
   but disabled+dimmed when not in manual mode. Renders the
   percentage to the right of the label.

All three components react to changes in the same `voicePrefs`
subscription, so swapping modes and dragging the slider update
the meter visualization in real time.

---

# Tenth audit pass — mobile layout overhaul (user requested)

User showed me screenshots of the web app rendered on mobile and
asked for a layout that:
  - keeps the guild rail PERMANENTLY visible (no more drawer)
  - shows the channel list / DM list as the main mobile surface
    when no channel is selected
  - swaps to the channel content WITH a back button when a channel
    is selected

The behavior they want is the "drill in / back out" pattern from
Discord's mobile app and iOS Mail. The previous implementation
slid the entire left rail+channel-list combo off-screen on mobile
and required tapping a hamburger menu to bring it back, which
made the rail feel hidden by default and made guild navigation
fiddly.

## 42. Shell.tsx — persistent rail + mutual channel-list/main swap

**Files:** `apps/web/src/app/Shell.tsx`

The grid template lost its drawer logic. Before: `flex xl:grid`
with the rail+channel-list bundled into a single transform-toggled
wrapper, sliding in/out via `translate-x-full` and a hamburger
button. After: a real grid at every viewport with the rail in
column 1 always.

New layout templates:

- **Desktop (xl+)**:
  - Discover/Admin: `grid-cols-[72px_1fr]` (rail + main, no
    channel-list or member-list since those modes have no
    guild context).
  - DM: `xl:grid-cols-[72px_240px_1fr]` (rail + DM list + main).
  - Guild: `xl:grid-cols-[72px_240px_1fr_240px]` (rail + channel
    list + main + member list).
- **Mobile (< xl)**:
  - Discover/Admin: `grid-cols-[72px_1fr]` (rail + main full-width).
  - DM/Guild: `grid-cols-[72px_1fr]` where the right column is
    either the channel/DM list OR the main content — picked by
    whether a channel is active. The mutual swap is CSS-driven
    via `hidden`/`flex` toggles on each pane; no JS media query
    needed.

The channel-list aside picks up
`${activeChannelId ? 'hidden' : 'flex w-full'} xl:flex xl:w-60`,
so on mobile it takes the full right column when no channel is
selected and disappears when one is. The xl: prefixes restore the
desktop behavior of always-visible at 240px.

The `<main>` element gets the inverse:
`${(activeChannelId || isDiscoverMode || isAdminMode) ? 'flex' : 'hidden'} xl:flex`.
Visible on mobile only when there's something to show; on desktop
always rendered alongside the channel list.

The aside also gets an explicit `hidden xl:hidden` in
discover/admin mode (overriding `xl:flex`) so it doesn't try to
create an implicit third grid track when the grid template only
has two columns reserved.

DM mode has its own `xl:!grid-cols-[72px_240px_1fr]` override
since the 4th column (member list) isn't relevant for DMs.

## 43. Mobile back button

Hamburger menu is gone. In its place: a back-arrow that only
renders when `activeChannelId` is truthy AND the viewport is
sub-xl (`xl:hidden`). Tapping it navigates to:

- `/channels/@me` in DM mode → back to DM list
- `/channels/:guildId` in guild mode → back to channel list

Same absolute position (top-2 left-2) as the old hamburger so
existing channel headers (`pl-12 xl:pl-4` on MessageView,
VoiceView, and now StageChannelView too) clear it correctly
without further changes.

The members toggle on mobile only renders when
`activeChannelId` is set — no point showing a "view members"
button when the user is on the channel list itself.

The old `navOpen` / `setNavOpen` state was removed entirely
since there's no drawer to open/close anymore. The `Menu` icon
import is gone too.

## 44. Auto-redirect to first-channel is now desktop-only

**Files:** `apps/web/src/app/Shell.tsx`

When the user lands on `/channels/:guildId` (a guild URL with no
channel), the existing code bounces them to the first text
channel via `nav.replace`. On desktop this is a courtesy — the
channel list is always visible alongside, so the auto-pick just
saves a click. On mobile it was actively harmful — users never
saw the channel list as a navigable surface; they were dropped
straight into a channel they hadn't picked.

The fix adds a `window.matchMedia('(min-width: 1280px)').matches`
gate inside the effect. On mobile the redirect is skipped and
the URL stays at `/channels/:guildId`, which the new CSS layout
renders as the channel-list pane occupying the full mobile
content area. The user picks their channel explicitly, then
drills in. Back button returns them to the same surface.

The check is intentionally NOT reactive to viewport resize — if
a user drags from mobile width to desktop while looking at a
channel-list-only view, we don't want to suddenly bounce them
into a channel they didn't pick. They'll get the auto-redirect
on next guild change.

## 45. MentionsPanel safe-area-inset-top

**Files:** `apps/web/src/app/MentionsPanel.tsx`

The mobile full-screen variant of the mentions inbox had
`top-0 left-0 h-full w-full` with no safe-area padding, so on
iPhones the "Mentions" header text sat directly under the
status bar / Dynamic Island. Visible in IMG_2431 where the
status-bar `12:42` overlapped the panel title.

Fix: add `pt-[env(safe-area-inset-top)]` to the mobile container
and `sm:pt-0` so the desktop overlay variant (which doesn't reach
the physical top edge) isn't padded.

## 46. Joined-button contrast in Discovery

**Files:** `apps/web/src/app/DiscoveryView.tsx`

The "Joined" pill on community cards used `bg-bg-3 text-ink-3`
— two muted grays from the theme palette that together produced
a contrast ratio of about 2.7:1 against the card background.
Below WCAG AA's 4.5:1 threshold for normal text; almost
unreadable on the mobile screenshots.

New style: `bg-emerald-600/15 text-emerald-300 border border-emerald-600/40`
plus a leading checkmark glyph (`✓ Joined`). The green tint
encodes "you're a member" semantically (vs. the previous
neutral gray which felt like a disabled state). High-contrast
green text against the dark card reads cleanly at any size.
The disabled cursor + click handler are unchanged — the button
still doesn't fire when you're already in.

## 47. Stage channel header left-padding

**Files:** `apps/web/src/app/StageChannelView.tsx`

The stage-channel header used `px-4 sm:px-6` with no special
left clearance for the mobile back button. The back button at
`top-2 left-2` would have overlapped the "Stage" label.

Added `pl-14 xl:pl-6` so the mobile back button has clear space
to the left of the header content. VoiceView and MessageView
already had similar `pl-12 xl:pl-4` reservations from the
hamburger-menu era; this brings StageChannelView in line.

---

# Eleventh audit pass — modal navigation pattern + header positions

User asked for three things off mobile screenshots:
  - Modals (Mentions, Admin, Settings, Channel-create, Guild
    settings, Create-guild, Join-guild) should feel like
    navigation pages on mobile, not overlays — back arrow on the
    left instead of an X close button on the right.
  - The admin panel's "Back to app" home icon should be replaced
    by a back arrow at the left of the header.
  - In the admin Guilds tab, the guild name should be VISIBLE.
    On their mobile screenshot (IMG_2440) only "3 me..." showed
    where the guild name "Eternus Nox Community" should have
    been — the Observe/Delete buttons + 20-digit guild id
    were eating all the horizontal space.
  - Header positions across DMs / Discover / Mentions were
    too far below the status bar. The admin panel sat much
    closer to the Dynamic Island, which is the target.

## 48. ModalHeader component

**Files:** `apps/web/src/lib/ModalHeader.tsx` (new)

A standardized dismissal-affordance for full-screen-on-mobile /
floating-on-desktop modals. Renders:

  - `< sm` (mobile): `ChevronLeft` back arrow on the LEFT,
    matching how channels and DMs back out. Same icon, same
    position, same visual weight.
  - `≥ sm` (desktop): `X` close button on the RIGHT, matching
    the floating-overlay aesthetic where the user dismisses
    rather than navigates.

Same `onClose` callback wires both — semantically identical,
visually distinct by context. Header height pinned at `h-12`
and `bg-bg-2` background so every modal lines up at the same
y-position regardless of contents — addresses "headers are at
inconsistent heights" without forcing each callsite to hand-tune.

Applied to: `MentionsPanel`, `SettingsModal`, `ChannelCreateModal`,
`GuildSettingsModal`, and the shared `ModalShell` wrapper in
`GuildList` (used by CreateGuildModal AND the join-by-link
flow — both inherit the change at once).

## 49. Admin panel: replaced Home link with back arrow

**Files:** `apps/web/src/app/AdminPanel.tsx`

The header had a Home-icon link on the right corner labeled
"Back to app". User explicitly: "There shouldn't be a home
button on the admin menu just a back button."

Done. The Home link is gone; in its place a `ChevronLeft`
button on the LEFT of the header that navigates to `/`. The
shield icon + "Instance admin" title now sit immediately right
of it. The "signed in as @username" hint still shows on `sm+`
but the right-side action zone is empty — no home, no X, no
duplicate back affordance.

Other changes in the same header:
  - `px-4 sm:px-8` → `px-3 sm:px-6` (matches the modal-header
    padding scale and gives the back button a more natural
    `-ml-1` negative-offset hit zone).
  - `text-lg` → `text-base sm:text-lg` (so the title fits
    alongside the back button on narrow mobile widths
    without truncation).

## 50. Admin Guilds tab row layout for mobile

**Files:** `apps/web/src/app/AdminPanel.tsx`

The row was a single horizontal flex (`flex items-center
gap-3`) with the guild icon, a `min-w-0 flex-1` middle column
for name+meta, and a `shrink-0` trailing column with
Observe/Delete buttons + the 20-digit guild ID. On mobile the
trailing column stayed at its intrinsic width while the
middle column collapsed — the guild name truncated to
nothing, leaving the "3 members · created…" sub-line showing
"3 me..." with the buttons overlapping where the name had
been.

New layout: `flex-col sm:flex-row`. Mobile stacks vertically:

  Row 1: icon + name + discoverable-pill + member/date meta
         + (new) guild-id sub-line in muted small-monospace.
  Row 2: Observe + Delete buttons full-width.

Desktop reverts to the original single-row layout — the
guild id stays at the far right where it was, and the buttons
sit just left of it. The `sm:hidden` and `hidden sm:inline`
classes split the guild-id render between the two layouts so
it appears exactly once at each viewport.

## 51. Doubled safe-area-inset-top padding

**Files:** `apps/web/src/app/Shell.tsx`

This was the root cause of "headers are too low on mobile."

The Shell's outer `<div>` has `safe-area-padded` which sets
`padding-top: var(--safe-top)` — the iPhone Dynamic Island
clearance (~44px). Children of that div sit BELOW that padding.

Then both the guild-rail aside and the channel-list aside had
`pt-[env(safe-area-inset-top)]` — which added the same ~44px
ON TOP of what the outer container had already applied. Net:
~88px of dead space above the rail icons and the channel-list
header.

The admin panel doesn't have this problem because it sits
inside `<main>` which has no extra `pt-[env...]`, so its
header sits at the natural ~12px below the outer safe-area
padding. That's why the admin "Instance admin" title was
visually closer to the Dynamic Island than the DMs / Mentions
titles in the user's screenshots.

Fix: dropped `pt-[env(safe-area-inset-top)]` from both asides.
The outer container already pads everything below the safe
area; the asides start their content right at the boundary
and look correctly positioned.

Kept the bottom-inset padding (`pb-[env(safe-area-inset-bottom)]`)
since the outer container doesn't apply that one (the bottom
inset only matters for the iOS home-indicator on PWA, and
the rail/aside content is what reaches the physical bottom
edge, not the outer chrome).

## 52. Removed leftover hamburger-clearance padding

**Files:** `apps/web/src/app/DiscoveryView.tsx`,
`apps/web/src/app/FriendsView.tsx`

The hamburger menu was removed in round 10. Several view
headers still had the `pt-16 sm:pt-10` (DiscoveryView,
64px / 40px) or `pl-12 xl:pl-4` (FriendsView) padding that
was originally there to keep the title clear of the floating
hamburger button. With the hamburger gone those just produce
dead space.

DiscoveryView: `pt-16 sm:pt-10` → `pt-4 sm:pt-6` on the main
header; `pt-16 xl:pt-6` → `pt-6` on the "Explore" sidebar
heading. Aligns with the admin panel's snug top spacing.

FriendsView: `pl-12 xl:pl-4` dropped. FriendsView only
renders in `<main>` when DM mode is active with no DM
selected — and the mobile CSS gate from round 10 hides
main in exactly that state. So the back button never appears
over the FriendsView header (because the back button only
renders when `activeChannelId` is truthy, which by definition
means a DM is selected and FriendsView isn't shown). The
`pl-12` was reserving space for nothing.

---

# Twelfth audit pass — ModalHeader sweep continues

Round 11 introduced the `ModalHeader` and applied it to the
five modals/panels the user explicitly listed. This round
covers the rest of the modal/panel surfaces so the back-vs-X
navigation feels consistent everywhere the user goes — no
mode where they have to relearn how to back out.

## 53. SearchPanel — ModalHeader

**Files:** `apps/web/src/app/SearchPanel.tsx`

The channel search drawer (right-anchored aside, sm:w-96 on
desktop, full-width on mobile) had an inline `<header>` with
a right-side X close. Swapped for ModalHeader so mobile gets
the left back-arrow.

Note: `X` is still imported and used for the in-input "clear
search" affordance and for the × inside removable filter
chips. Those are unrelated micro-uses of the icon and stay.

## 54. PinPanel — ModalHeader

**Files:** `apps/web/src/app/PinPanel.tsx`

Same right-anchored aside pattern as SearchPanel. Same swap.
The amber `Pin` icon stays as the leading glyph on desktop.

## 55. ChannelEditModal — ModalHeader

**Files:** `apps/web/src/app/ChannelEditModal.tsx`

Channel name shows as the modal title (e.g. "general") with
the `Hash` icon as the leading glyph on desktop. Same swap.

## 56. PollComposerModal — ModalHeader

**Files:** `apps/web/src/app/PollComposerModal.tsx`

The poll composer uses `onCancel` (not `onClose`) for its
dismiss handler — passed straight through to ModalHeader's
`onClose` prop. Semantically identical from the user's view,
the name difference is just internal taste.

## 57. ReorderChannelsModal — ModalHeader

**Files:** `apps/web/src/app/ReorderChannelsModal.tsx`

Drag-to-reorder modal for guild owners. Same swap. The
"Reorder channels" title carries over.

## 58. ForwardModal — ModalHeader

**Files:** `apps/web/src/app/ForwardModal.tsx`

The message-forwarding picker (used from the right-click /
long-press menu on any message). Same swap.

---

# Thirteenth audit pass — owner-delete bug, push-toggle iOS hint, voice-prefs sync

User picked the first three items off the deferred list to start
this round. One genuine latent bug, one rough edge in an
already-working feature, and one real new feature (cross-device
voice-prefs sync).

## 59. Owner-delete now broadcasts GUILD_DELETE

**Files:** `apps/api/src/routes/guilds.ts`

When a guild owner deleted their own guild via
`DELETE /api/v1/guilds/:guildId`, the route called
`services/guilds.deleteGuild()` and returned `{ ok: true }` —
but never broadcast a `GUILD_DELETE` gateway event. Connected
members kept the guild in their sidebar until they refreshed or
reconnected. I flagged this in round 7's notes as "latent bug
noted" while implementing admin force-delete (which DOES
broadcast correctly) and didn't fix it then.

Fix mirrors the admin force-delete pattern from
`apps/api/src/routes/admin.ts`:
  1. Read `guild_members.userId` for this guild BEFORE the
     delete (the rows go away with the cascade).
  2. Call `services/guilds.deleteGuild()`.
  3. Dynamic-import `guildDeletedBroadcast` from
     `gateway/dispatch` and dispatch it with the captured
     member ids.

The dispatch function handles the per-connection state cleanup
on each member's gateway socket plus sends them the
`GUILD_DELETE` event so their client clears the guild from
local state in real time.

The service layer stays purely about DB state changes — the
gateway-broadcast concern lives in the route layer (matches the
rest of this codebase; services don't dispatch).

## 60. Push notifications: iOS-Safari hint up front

**Files:** `apps/web/src/app/SettingsModal.tsx`

Correction first: the push-notification toggle that I said in
round 9's deferred list "isn't surfaced in settings" actually
IS surfaced — `NotificationSettings` in SettingsModal handles
the full flow (permission request, SW register, subscribe,
device list with per-device remove, disable + unsubscribe). I
was wrong; the toggle has been working since v1.

What I DID find while looking: the iOS-Safari edge case is
handled poorly. iOS Safari 16.4+ exposes `PushManager` in the
regular browser tab — so the `supported` check (which tests
for `PushManager in window`) passes — but `subscribe()` only
succeeds when the page is running as an installed PWA (Add to
Home Screen). Without a heads-up, iOS users in regular Safari
tap Enable, get the permission prompt, then see a generic
"Failed to enable notifications" toast with no actionable
information.

Fix: add an iOS-Safari-non-PWA branch before the supported
gate falls through. Detects iOS / iPadOS via the standard UA
sniff (iPadOS reports as Mac so we also check
`navigator.maxTouchPoints`) and reads `window.navigator.standalone`
which is true only when launched from the Home Screen.

When `iOS && !standalone && !subscribed`, the section renders:
> On iPhone and iPad, push notifications only work when
> Zekktris is installed as a Home Screen app.
>
> In Safari: tap the Share button → Add to Home Screen,
> then open Zekktris from your Home Screen and try again here.

Users who've already installed and are running as a PWA bypass
this branch (`standalone === true`) and see the normal
Enable/Disable UI.

## 61. Voice prefs sync — server persistence + cross-device sync

**Files:** `packages/db/src/schema/users.ts` (column),
`packages/db/migrations/0023_voice_prefs.sql` (new),
`packages/db/migrations/meta/_journal.json` (entry),
`apps/api/src/routes/users.ts` (endpoints),
`packages/client/src/rest.ts` (REST methods),
`apps/web/src/lib/voicePrefs.ts` (sync plumbing),
`apps/web/src/state/AppState.tsx` (boot wiring)

Real new feature. `voicePrefs.ts` had stored everything in
localStorage only, so switching devices reset gain mode, mic
gain slider, master volume, per-user mute/volume overrides,
and audio processing toggles. The data is small (a few KB
even with hundreds of per-user entries) and intrinsically
user-account-scoped, so server-side persistence is the right
shape.

### Schema (migration 0023)

New `voice_prefs` jsonb column on `users`, default `'{}'::jsonb`,
not-null. The API treats the blob as opaque — the
VoicePrefsState type is owned by `apps/web/src/lib/voicePrefs.ts`;
the server persists whatever JSON the client sends. Keeps the
API stable as the client adds/removes prefs without
coordinated schema migrations.

A separate `(user_id, key, value)` table would let us index
and query individual prefs, but we never read or query prefs
server-side — they're written by client A and read by client B
as a whole blob. JSONB column is the right shape.

### Endpoints

  - `GET  /api/v1/users/@me/voice-prefs`
    → `{ voicePrefs: {...} }` (empty object for first-time users)
  - `PATCH /api/v1/users/@me/voice-prefs`
    → body `{ voicePrefs: {...} }`, full replacement (not patch)

Body validation accepts any object shape; we cap stringified
size at 32 KB to bound malicious or buggy clients writing
unbounded blobs. 32 KB is enough headroom for ~1000 per-user
override entries which is well beyond any realistic ceiling.

### Sync model

Last-write-wins per-key on the client side. The client sends
the entire current state on every change (debounced 500ms);
two devices changing different prefs concurrently can produce
inconsistent results until the next change re-syncs.

Acceptable for the data class: preferences, not critical
state. If we needed CRDT semantics we'd pay for them, but
voice prefs aren't worth the complexity.

### Client plumbing — voicePrefs.ts

Three new exports:

  - **`setVoicePrefsSyncer(fn | null)`** — injected by React
    boot code with a function that takes the current state and
    PATCHes the server. Pass null on logout to detach. The
    voicePrefs module doesn't directly import the REST client
    — that would couple a leaf utility to the API layer and
    drag the dependency into every audio-routing / settings /
    level-meter consumer. Dependency injection keeps the module
    pure.

  - **`hydrateVoicePrefs(serverPayload)`** — applies a
    server-fetched blob over local state. Runs each incoming
    field through the loader's existing sanitization so a
    malformed or corrupted server blob can't poison local
    state. Sets a `suppressNextSync` flag so the post-hydration
    persist() doesn't immediately PATCH the same data back
    (would burn an extra request per app boot).

  - **`persist()`** (updated) — now also schedules a debounced
    server sync via `scheduleServerSync()`. 500ms after the
    last change, fires `syncer(state)`. Failures are swallowed
    — local state is authoritative at runtime; the server
    copy lags behind by one edit cycle but the next change
    will try again with the latest snapshot.

### Boot wiring — AppState.tsx

New `useEffect` keyed on `[token, user, rest]`:
  1. Sets the voice-prefs syncer to a closure over `rest`.
  2. GETs the saved blob.
  3. If the server has prefs (object is non-empty): hydrates.
  4. If the server is empty (first-time user or new install):
     PATCHes the current local state up so the server starts
     holding it. Without this step a first-time user with
     pre-existing localStorage prefs (e.g. they used the app
     in v1.67 before this change) wouldn't push their prefs
     until they next adjusted something.
  5. Cleanup detaches the syncer on logout so a re-login as
     a different user doesn't briefly fire PATCHes attributed
     to the wrong account.

### Backward compatibility

`hydrateVoicePrefs` accepts the legacy `autoGainControl` boolean
field from pre-round-9 clients via the same migration logic in
the localStorage loader: `true → 'agc'`, `false → 'off'`. So
a user who had the app installed before round 9 and now syncs
to a fresh device gets their gain choice preserved.

---

# Fourteenth audit pass — bootstrap admin, DM search, password reset

Wrapping up the last three items from the deferred list.

## 62. Bootstrap-admin env var

**Files:** `apps/api/src/env.ts`,
`apps/api/src/bootstrap-admin.ts` (new), `apps/api/src/index.ts`

Solves the chicken-and-egg problem on fresh self-host installs:
users.is_admin must be true to use the /admin UI, but the only
way to flip it was via SQL (`UPDATE users SET is_admin=true
WHERE id=...`) or via another admin who already had access.
First-time operators needed direct DB access to make their
first admin, which is a steep ergonomic cliff for non-technical
users of a self-host product.

New env var `BOOTSTRAP_ADMIN_EMAIL`. On every startup, after
the DB check passes but before HTTP serving begins, a task
runs that:

  1. Checks the env var is set (otherwise no-op).
  2. Counts users with `is_admin=true`. If >0, no-op (the
     promotion has happened already or someone else has been
     made admin via SQL or another admin).
  3. Looks up a user with the matching email (lowercased).
     If not found, logs a hint and exits — the operator hasn't
     registered the account yet, but the task will succeed on
     the next boot.
  4. Sets `is_admin=true` on the row. Logs the result so the
     operator sees it in their docker-compose console.

Idempotent. Once any admin exists by any means, this becomes
a no-op forever, so leaving the env var set permanently in
`docker-compose.yml` is safe.

Edge case: if the user is banned, we promote anyway and log a
warning. The operator might have flagged themselves accidentally
and need admin to unflag — refusing would leave them locked
out with no recourse.

Failures bubble up but the wrapper in `index.ts` catches and
logs them, so a bootstrap problem doesn't prevent the server
from starting. The operator can fix the situation via SQL or
another path and the next restart retries.

## 63. Cross-DM search

**Files:** `apps/api/src/services/messages.ts` (new function),
`apps/api/src/routes/users.ts` (new endpoint),
`packages/client/src/rest.ts` (new method),
`apps/web/src/app/DMList.tsx` (new UI)

Correction first: single-channel DM search has worked since
v1.67 base. The existing
`GET /api/v1/channels/:channelId/messages/search` endpoint
treats DM channels the same as guild channels (the route's
`loadChannelContext` returns `isDM: true` for DM channels and
the permission gate is skipped). So tapping the search icon
inside a DM has always searched that DM's messages. My round-9
deferred-list note "DM search (currently guild-channel only)"
was inaccurate.

What WAS missing: cross-DM search — "find that thing in some
DM I had" without first remembering which DM. Build that.

### Backend

New service function `messages.searchDirectMessages(userId, q,
limit, filters)`. JOIN-equivalent (via `EXISTS (SELECT 1 FROM
dm_recipients WHERE channel_id = m.channel_id AND user_id =
$userId)`) to scope to channels the caller participates in.
FTS predicate is the same `to_tsvector('english', content) @@
websearch_to_tsquery('english', $q)` used by per-channel
search — same GIN index covers both call sites. Same filter
shape (`authorId`, `before`, `after`) for query consistency.

We deliberately do NOT include guild messages here. Cross-guild
search would require resolving effective per-channel
permissions for an unknown set of channels (since guild
visibility is permission-gated), which defeats the FTS index
and adds nontrivial complexity. A future "search everything
you can see" endpoint would batch-resolve permissions; out of
scope for this pass.

New endpoint `GET /api/v1/users/@me/dms/search` with the same
query-param shape as per-channel search. Returns hydrated
`MessageDTO` rows so the client renders results uniformly.

### Frontend

New `DMSearch` component inside `DMList.tsx`. Search-toggle
button in the DM-list header switches the right column from
the conversation list to a search view (input + results). The
search view fully replaces the conversation list while open
rather than overlaying — mobile users have very little
horizontal real estate, and overlaying would leave the
underlying list useless and confusing.

Result rows show author avatar (with fallback initials), name,
date, and a one-line preview of the matched message. Tapping
a result navigates to `/channels/@me/:channelId#m-:messageId`
which uses the existing jump-to-message URL convention. The
fragment isn't read by the router but the MessageView
scroll-to-message logic picks it up after the channel loads.

Debounced 300ms on the input. Cancellation guard on the
fetch in case the user types/clears fast enough that an
earlier in-flight request resolves after a later one.

## 64. Password reset

**Files:** `packages/db/src/schema/users.ts` (password_resets
table), `packages/db/migrations/0024_password_resets.sql`
(new), `packages/db/migrations/meta/_journal.json` (entry),
`apps/api/src/env.ts` (SMTP_*), `apps/api/src/services/email.ts`
(new), `apps/api/src/routes/auth.ts` (forgot + reset
endpoints), `apps/api/package.json` (nodemailer dep),
`packages/client/src/rest.ts` (REST methods),
`apps/web/src/auth/AuthScreens.tsx` (Forgot + Reset pages,
"Forgot password?" link, post-reset success banner),
`apps/web/src/App.tsx` (routes)

Real feature. A user who forgets their password and doesn't
have admin SQL access was previously locked out forever —
genuinely a blocker for any instance with non-technical users.

### Email infrastructure

Added `nodemailer` (mature, MIT-licensed, SMTP-only — no SaaS
lock-in). Self-host operators can point SMTP_* env vars at any
relay: Mailgun, SendGrid, AWS SES, Postmark, their own
Postfix, etc.

New `services/email.ts`:
  - Lazy-init a single nodemailer transporter with connection
    pooling so we don't re-handshake per send.
  - `isEmailConfigured()` for callers to check before they
    depend on email — returns false when SMTP_HOST or
    SMTP_FROM is missing.
  - `sendEmail({ to, subject, text, html? })` — low-level
    primitive. Plain-text body required; HTML optional.
  - `sendPasswordResetEmail({ to, resetUrl, expiresInMinutes })`
    — typed convenience for the reset flow. Minimal HTML (no
    images, no tracking pixels, no marketing footer) since
    this is a transactional security email; clients that strip
    HTML still see the plaintext URL underneath.

Env vars (all optional):
  - SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS
  - SMTP_FROM (email address used in the From: header)
  - SMTP_SECURE (default false: STARTTLS on 587; set true for
    implicit TLS on 465)

If SMTP_HOST or SMTP_FROM is unset, the forgot-password
endpoint returns 503 with a clear message ("contact your
server operator"). We deliberately surface this case rather
than the generic "ok" — the alternative would leave users
with no way to know why they're not receiving emails.

### Schema (migration 0024)

New `password_resets` table:
  - `id` snowflake PK
  - `user_id` FK → users (cascade delete so deleting a user
    cleans up their pending resets)
  - `token_hash` text — SHA-256 hex of the plaintext token
    sent in the email; plaintext is never stored. A DB read
    cannot recover working reset codes.
  - `expires_at` timestamp — currently 60-minute lifetime
  - `used_at` timestamp — null until consumed. Single-use is
    enforced by gating reset attempts on `used_at IS NULL`.
  - `created_at`

Indexed by `token_hash` (unique, for lookup-on-reset) and
`user_id` (for operational queries like "show me this user's
recent reset attempts").

Used rows aren't deleted — keeping them with `used_at` set
provides a tamper-evident record. A periodic GC could prune
>30-day-old rows but the table stays small enough that v1
doesn't need one.

### Endpoints

`POST /api/v1/auth/forgot-password` (body: `{ email }`):
  - Rate-limited 3/hour per IP AND 3/hour per email (against
    spam-the-inbox / SMTP-relay-flooding attacks). Limit-hit
    silently no-ops — telling the caller "you're over the
    limit" would re-leak email existence.
  - Always returns 200 with a generic "if an account exists
    you'll get a link" message regardless of whether the
    email matched a real account. Email-existence is a real
    account-enumeration vector for any product with a public
    signup form; the generic response defangs it.
  - When SMTP isn't configured: returns 503 (see above).
  - When everything works: generates 32 random bytes →
    URL-safe base64 → that's the plaintext token mailed to
    the user, with the SHA-256 stored in `password_resets`.
    Reset URL is `${PUBLIC_URL}/reset-password?token=${plaintext}`.
  - SMTP send failures: logged internally, the user still
    gets the generic ok — attackers can't probe send success
    by watching for error responses.

`POST /api/v1/auth/reset-password` (body: `{ token,
newPassword }`):
  - Hashes the submitted token, looks up by hash, gates on
    `used_at IS NULL` AND `expires_at > now()`.
  - All failure modes return the same generic "invalid or
    expired" 400 — distinguishing "not found" / "used" /
    "expired" would let an attacker probe for legitimate-but-
    consumed tokens.
  - On success:
    1. Re-hash the new password via the same `hashPassword`
       function the /register and /users/@me/password
       endpoints use — output is indistinguishable from a
       normal account password.
    2. Update `users.password_hash`.
    3. Mark the reset row used.
    4. Revoke ALL existing sessions for the user. Real user
       loses other-device logins (expected after a security
       action) AND any attacker session is cut immediately.

### Frontend

New routes `/forgot-password` and `/reset-password`. Both
use the same `AuthCard` chrome as Login/Register for visual
consistency.

  - **`ForgotPasswordPage`**: email input → submit. On
    success transitions to a confirmation screen ("Check
    your email…"). The confirmation appears regardless of
    whether the email matched, by design.
  - **`ResetPasswordPage`**: reads `?token=...` from the
    URL, two-field form (new password + confirm). On
    success redirects to `/login?reset=ok`. The token-
    missing case shows a "link is invalid" screen before
    rendering the form.
  - **LoginPage**: new "Forgot your password?" link below
    the sign-in button (hidden during the 2FA prompt). A
    success banner ("Your password was reset. Sign in with
    your new password below.") appears on `?reset=ok`.

### Security review summary

  - Plaintext tokens never stored on disk (SHA-256 hashed).
  - Existence leaks defanged (generic ok responses, generic
    failure responses).
  - Sessions revoked on reset (cuts attacker access).
  - Tight rate limits both per-IP and per-email.
  - Token lifetime 60min (long enough for users to fish the
    email out of spam, short enough that a leaked email
    can't be replayed days later).
  - SMTP failures swallowed in the response path (no leak
    via error messages); errors logged server-side for
    operator visibility.

---

# Fifteenth audit pass — bug hunt

User asked to look for bugs. Systematic sweep of the codebase
turned up six real bugs across security-significant and
correctness categories.

## 65. forgot-password email-existence timing leak

**Files:** `apps/api/src/routes/auth.ts`

The forgot-password endpoint (added in round 14) leaks email
existence via response timing. The "user exists" path performs
`randomBytes` + SHA-256 + DB insert + SMTP send (typically
100ms-1s+ in total), while the "user doesn't exist or banned"
path returns immediately (~1ms). An attacker probing the
endpoint with various emails can distinguish registered
addresses from unregistered ones via the response-time
difference, defeating the generic-200 "if an account exists"
defense the endpoint was built around.

The login flow solved the analogous problem by always
computing scrypt regardless of user existence (constant-time
work). For forgot-password we can't easily make the work
constant-time across paths, so the fix is to defer ALL of the
work — user lookup, token generation, DB insert, SMTP send —
into a fire-and-forget background promise that runs AFTER the
response has already been returned.

```ts
void (async () => {
  try {
    const [user] = await db.select(...).where(...).limit(1);
    if (!user || user.bannedAt) return;
    // ... token generation, insert, sendPasswordResetEmail ...
  } catch (err) {
    log.error('password reset background task failed', { err });
  }
})();
return genericOk();
```

The unawaited promise is the point — the response goes out at
constant time regardless of which code path the background
work takes. Errors during background work are caught and
logged but never surface to the requester (we've already
returned 200). The user-facing experience is unchanged: the
email arrives a moment later as before, or doesn't if the
email didn't match an account.

## 66. voicePrefs `suppressNextSync` ate the first user edit

**Files:** `apps/web/src/lib/voicePrefs.ts`

The voicePrefs server-sync from round 13 had a subtle bug in
its echo-prevention logic. The flow:

  1. App boots → `hydrateVoicePrefs(serverPayload)`
  2. Inside hydrate: writes state, writes localStorage,
     fires listeners directly (does NOT call `persist()`),
     sets `suppressNextSync = true` on the way out
  3. User adjusts master volume → setter mutates state →
     calls `persist()` → calls `scheduleServerSync()`
  4. `scheduleServerSync` sees `suppressNextSync === true`,
     consumes it (`= false`), returns without scheduling
  5. **The user's edit is never PATCHed to the server**

The flag was intended to prevent hydrate-then-PATCH echo, but
hydrate already bypassed `persist()` entirely, so there was
no echo to suppress. The flag was instead consumed by the
user's NEXT legitimate setter call, silently dropping their
first change.

Fix: remove `suppressNextSync` entirely. Hydrate doesn't fire
the syncer; setters do. No flag needed.

## 67. voicePrefs boot race condition

**Files:** `apps/web/src/state/AppState.tsx`

The voice-prefs boot effect in AppState has a race: the
in-flight `rest.getVoicePrefs()` promise can resolve AFTER an
unmount/re-auth and apply the OLD user's prefs to the NEW
user's local store, or fire a `rest.updateVoicePrefs` PATCH
attributed to whichever syncer is currently bound (i.e. the
new user). Either way the wrong user's data lands somewhere.

Trace: user A logs in → effect runs → GET in-flight →
user A logs out (cleanup fires, syncer detached) → user B
logs in immediately → effect re-runs, syncer attached for B,
new GET starts → original GET for A resolves and calls
`hydrateVoicePrefs(r.voicePrefs)` with A's prefs → applies
to local store (which is now serving B's session) → next
setter from B triggers a PATCH that writes A's hydrated
data to B's row.

Fix: standard React `cancelled` flag captured in the .then
closures. After cleanup, the resolving .then sees
`cancelled === true` and bails out.

## 68. reset-password race + missing rate limit

**Files:** `apps/api/src/routes/auth.ts`

Two bugs in one endpoint, both from round 14.

### Race condition (security-significant)

The reset-password flow used a check-then-act pattern:

  1. `SELECT` row by token_hash
  2. Check `used_at IS NULL`
  3. Check `expires_at > now()`
  4. Compute scrypt on new password
  5. `UPDATE users.password_hash`
  6. `UPDATE password_resets.used_at`

Two concurrent callers holding the same token (e.g. legit user
clicking from their email + attacker who phished the email
thread) could BOTH pass the check at step 2, BOTH compute
scrypt, BOTH write — the last UPDATE on `users.password_hash`
wins, silently overriding the legit user's chosen password
with the attacker's. The user thinks they successfully reset;
their password is now what the attacker chose.

Fix: atomically claim the token via `UPDATE ... WHERE
used_at IS NULL RETURNING` BEFORE running scrypt. Whichever
caller's UPDATE lands first gets the row back; the loser gets
0 rows and fails with the generic token-error. Claiming
before scrypt also avoids 100ms of wasted CPU for the loser.

```ts
const claimed = await db
  .update(schema.passwordResets)
  .set({ usedAt: new Date() })
  .where(and(
    eq(schema.passwordResets.tokenHash, tokenHash),
    isNull(schema.passwordResets.usedAt),
  ))
  .returning({ id, userId, expiresAt });
if (claimed.length === 0) throw tokenError();
```

The `expires_at > now()` check happens after the claim — an
expired token gets burned (used_at set) but the request still
fails, which is fine since an expired token can't be replayed
anyway and burning it leaves the state clean.

### Missing rate limit

The endpoint had no rate limit. Token brute-force isn't
realistically possible (256 bits of entropy), but each
attempt costs one scrypt (~100ms of CPU). Without throttling,
an attacker can flood the endpoint and:
  - Slow down the API server
  - Hide other reset attempts in the noise

Fix: per-IP rate limit, 50/hour. Legit users only hit this
once successfully; restrictive enough to defang flood
attacks. Matches the rate-limit posture of the other auth
endpoints.

## 69. Reaction-role grant/revoke missed gateway cache refresh

**Files:** `apps/api/src/routes/messages.ts`

When a user reacts to a reaction-role message:
  1. The reaction emoji is recognized as role-mapped
  2. `members.addMemberRole(...)` writes to `member_roles`
  3. `MESSAGE_REACTION_ADD` is dispatched (already worked)
  4. **Nothing else happens.**

What was missing: `dispatch.applyMemberRoleChange({ userId,
guildId })`. This helper refreshes the user's gateway-cached
viewable-channel set and dispatches `CHANNEL_CREATE` for
channels the new role just unlocked (and `CHANNEL_DELETE`
for any that the role being revoked closed).

Effect of the bug:
  - User reacts to grab a role meant to unlock a channel
  - Role lands in the DB
  - But their gateway connection's
    `viewableGuildChannelIds` set isn't updated
  - Channel doesn't appear in their sidebar until they
    reconnect
  - User assumes the reaction-role didn't work and tries
    again or reports it broken

The explicit `PATCH /guilds/:guildId/members/:userId` route
calls `applyMemberRoleChange` correctly. The reaction-role
add and remove paths both missed it. Fix: dispatch the
refresh in both places after the role mutation succeeds.

## 70. Password change/reset leaked attacker access through open gateway

**Files:** `apps/api/src/routes/auth.ts`,
`apps/api/src/routes/users.ts`

Both `/auth/reset-password` and `POST /users/@me/password`
(with `revokeOtherSessions: true`) revoke sessions in the
database — but neither closes the corresponding open
WebSocket gateway connections.

Effect: an attacker who initiated a password reset (via
phished email link, or who already has an active session
when the user changes their password) keeps reading from
their open WebSocket up to the access-token TTL (~15
minutes) AFTER the user has "logged out everywhere." During
that window the attacker can:
  - Receive every message in every channel the account has
    access to
  - See typing indicators, voice activity, presence
  - Still POST new messages (the access token is still
    valid for REST too)

The session revocation alone is a one-way signal — until
the access token expires, the gateway has no reason to
re-validate the auth status.

Fix: after revoking sessions in both flows, iterate
`registry.byUserId(userId)` and `conn.close(4000, ...)`
every open connection. Mirrors the existing pattern in
the admin force-signout path
(`POST /admin/users/:id/signout`).

For change-password we close the user's CURRENT connection
too because the gateway doesn't currently track which auth
session a WebSocket belongs to. The user's frontend
auto-reconnects with its still-valid access token; one brief
WebSocket hiccup is a strictly better trade than 15 minutes
of attacker reach. A future improvement would be to track
`authSessionId` per Connection so we could close only the
sessions that were revoked — out of scope for this round.

Both paths use dynamic imports of `gateway/registry` so the
auth router doesn't drag the gateway into its top-level
import graph. Connection-close failures are caught and
logged — the access-token TTL is still a finite-time cap
on attacker reach even if the close fails, so it's not
catastrophic.

---

# Sixteenth audit pass — second bug-hunt sweep

User asked to keep going on bug-finding. Covered the areas the
first sweep didn't reach: voice/LiveKit flow, SSRF protections,
gateway IDENTIFY, WebSocket DoS, relationships, read-states,
session-revocation completeness.

Nine bugs found and fixed. Three of them — guild-leave voice
leak, guild-delete voice leak, and the gateway session-revocation
gap — are direct continuations of last round's "revoke
sessions but leak through other surface" theme, completing
the security story.

## 71. Voluntary guild-leave skipped voice eviction

**Files:** `apps/api/src/routes/guilds.ts`

The kick and ban routes both correctly evict the target from
voice within the guild before broadcasting the membership
change. The voluntary `POST /:guildId/leave` path didn't —
deleting only the membership row.

Effect: a user mid-voice-call who leaves the guild keeps their
LiveKit token (valid up to 1 hour) and continues to talk +
listen in a guild they're no longer a member of. They appear
in the channel's voice-presence list to other participants and
their stream keeps flowing through the SFU.

Fix: mirror the kick/ban pattern — call
`voice.evictFromVoiceInGuild(userId, guildId)` after the
`leaveGuild` service call. If they were in voice, dispatch a
`VOICE_STATE_UPDATE` with the left-DTO so participants see
them leave; the helper also calls LiveKit's
`removeParticipant` on a best-effort basis to drop the stream
at the SFU.

## 72. Guild delete left voice rooms streaming

**Files:** `apps/api/src/services/voice.ts` (new helper),
`apps/api/src/routes/guilds.ts` (owner-delete),
`apps/api/src/routes/admin.ts` (admin force-delete)

Same shape as #71 but for guild deletion. When a guild is
deleted (by owner or admin force-delete), users currently in
voice channels in that guild keep their LiveKit tokens (~1
hour) and continue streaming audio in rooms that belong to a
guild that no longer exists. The voice_states FK to guilds
would cascade-delete on hard-purge, but until then the SFU
side keeps streaming and the cascade would also strip channel
ids needed to call LiveKit's removeParticipant.

Fix: new service function `voice.evictAllVoiceInGuild(guildId)`
that bulk-deletes voice_states for the guild and calls
LiveKit's `removeParticipant` per evicted user (sequential, not
parallel, to pace the SFU under bulk delete-guild scenarios).
Returns the evicted rows so callers can dispatch per-user
`VOICE_STATE_UPDATE` events.

Wired into both delete paths BEFORE the actual `deleteGuild`
call so the channel ids are still in hand when we call
LiveKit. Per-user `VOICE_STATE_UPDATE` dispatches let each
affected client tear down its local voice UI cleanly.

## 73. IPv6 link-local SSRF gap

**Files:** `apps/api/src/services/embeds.ts`

`isPrivateIp` checked IPv6 link-local with
`v6.startsWith('fe80')`, but the link-local prefix
`fe80::/10` actually spans `fe80::` through
`febf:ffff:ffff:...` — the second-byte high nibble can be
`8`, `9`, `a`, or `b` (the prefix bits are 1111111010, leaving
the 11th-16th bits free). Addresses in `fe90::`, `fea0::`,
`feb0::` etc. are still link-local but passed the filter.

Fix: check all four high-nibble values explicitly. Also
added a multicast check (`ff00::/8`) — rarely an SSRF vector
but it's the completeness win for the same cost.

These ranges are uncommon in practice (most SSRF attacks
target v4 cloud metadata endpoints, which are correctly
gated), but the fix tightens the boundary.

## 74. Gateway IDENTIFY accepted banned and soft-deleted users

**Files:** `apps/api/src/gateway/server.ts`

The REST login flow rejects banned users with
`errors.forbidden('This account has been disabled')` and the
admin ban endpoint force-closes existing gateway connections.
But the gateway IDENTIFY handler didn't check `bannedAt` or
`deletedAt` on the user row — it only checked that the row
existed.

Effect: a banned user holding a valid access token (issued
BEFORE the ban) can reconnect a fresh WebSocket and IDENTIFY
succeeds. They keep receiving real-time events in every guild
they were in. Same gap for soft-deleted users — they can keep
reading until their access token expires (~15 min).

The admin ban path closes EXISTING connections; this fix
prevents NEW ones from being established. Generic close code
to avoid leaking the specific moderation state to whoever
happens to hold the token (could be the user themselves trying
to figure out why they're locked out, or could be an attacker
on a phished token).

## 75. Stale ack wiped legitimate mention badges

**Files:** `apps/api/src/services/readStates.ts`

The read-state ack flow used `GREATEST(existing, EXCLUDED)`
to prevent an older ack from rolling back the marker — but
unconditionally reset `mention_count` to 0 on every ack,
regardless of whether the marker actually moved forward.

Effect: a user with `lastMessageId=200, mentionCount=5`
(five mentions in messages 201+) who clicks a "jump to
message" link landing on message 150 → client sends
`ack(150)` → server keeps marker at 200 (correct) but resets
mention_count to 0 (wrong). The mentions in 201+ are still
genuinely unread and visible in the channel, but the badge
silently clears.

Fix: only reset `mention_count` when the marker actually
advances past the mentioning message(s). Use a CASE WHEN
inside the UPSERT's SET clause so the conditional is atomic
with the marker write:

```sql
mention_count = CASE
  WHEN EXCLUDED.last_message_id > read_states.last_message_id
  THEN 0
  ELSE read_states.mention_count
END
```

Return type adjusted from `mentionCount: 0` literal to
`mentionCount: number` since the preserved value might be
non-zero.

## 76. blockUser destroyed the OTHER party's protective block

**Files:** `apps/api/src/services/relationships.ts`

Privacy bug. When user A had blocked user B (a row
`(A, B, 'blocked')` existed) and then B blocked A, the
existing implementation's transaction did:

```ts
DELETE FROM relationships
WHERE (userId = B AND targetId = A)
   OR (userId = A AND targetId = B);   -- ← wipes A's block
INSERT (B, A, 'blocked');
```

The OR wiped A's existing block of B as a side effect. After
the operation, B has blocked A — but A's protective block of
B is gone.

The relationships PK is `(userId, targetId)`, so both
`(A, B, 'blocked')` and `(B, A, 'blocked')` can coexist —
each row representing its owner's independent choice. The
service was correctly maintaining the user's own side but
incorrectly destroying the other party's side.

Fix: split the wipe into two predicates. Same-direction
`(userId, targetId)` is wiped unconditionally (any prior
state is replaced with the new 'blocked' row). Reverse
direction `(targetId, userId)` is wiped only for
NON-blocked types — friendships and pending requests get
cleaned up bidirectionally, but the other party's block
(which is their privacy choice, independent of ours) is
preserved.

This is the kind of bug that surfaces only in a victim's
actual harassment scenario, which makes it especially
important: A blocks abusive B → B retaliates by blocking A
back → A's protective block silently disappears. The
behavior should be that A's block persists regardless of
what B does.

## 77. Session revocation didn't apply to gateway re-IDENTIFY

**Files:** `apps/api/src/gateway/server.ts`

Continuation of last round's #70. The fix there closed open
gateway connections on password reset/change, but the close
triggered the client's auto-reconnect logic — which sent a
new IDENTIFY with the same still-valid access token. The
gateway IDENTIFY handler verified the token's signature and
expiry (both still valid since JWTs don't reflect session
revocation) but didn't check that the underlying session row
was still active. Result: the close was silently undone by
the immediate re-connect, leaving the user-facing "log out
everywhere" operation ineffective on the gateway for up to
the access-token TTL (~15min).

Fix: after verifying the token, query the sessions table for
the session id encoded in the token claims. If the row is
missing or `revokedAt IS NOT NULL`, reject the IDENTIFY.

Cost: one extra DB read per IDENTIFY. IDENTIFY runs once per
WebSocket-open (not per frame), so the read amortizes very
well. In exchange we tighten gateway-side session revocation
from "eventually-consistent up to ~15min" to "next gateway
interaction at latest" — well-spent.

The REST middleware still has the documented eventually-
consistent semantic noted in the file's header. Closing that
gap requires a Redis blacklist or per-request DB lookup, both
larger refactors. Documented as still-deferred.

## 78. WebSocket frames had no size cap

**Files:** `apps/api/src/gateway/server.ts`

The `WebSocketServer` was created with `{ noServer: true }`
and no `maxPayload` option. The `ws` library defaults
`maxPayload` to 100MB per frame.

Effect: an attacker connects and sends a single 100MB JSON
payload — the server allocates that buffer, parses the JSON
(another large allocation), then rejects via our
"malformed frame" handler. With N concurrent attackers this
exhausts memory. Real gateway frames are at most a few KB
(IDENTIFY token, HEARTBEAT integers, small structured
PRESENCE_UPDATE / DISPATCH payloads).

Fix: `maxPayload: 64 * 1024`. The ws library enforces the
cap at the protocol layer, rejecting oversized frames
BEFORE they reach our JSON.parse. 64KB is generous headroom
for any legitimate frame.

## 79. (Skipped) REST body size limit

Concern: Hono's JSON parsing has no built-in cap. An
attacker can POST a multi-MB JSON body to any unauthenticated
endpoint, the server allocates memory before validation runs.

Not fixed in this round because the multipart upload routes
legitimately need to accept up to `MAX_UPLOAD_SIZE_MB` ×
`MAX_FILES_PER_MESSAGE` (default 100MB × 10 = 1GB) and
adding scoped body limits across all the auth/JSON routes
needs more careful surgery than fits this pass. The reverse
proxy operators are expected to deploy (Caddy, nginx, etc.)
typically enforces request-body limits at the edge, which is
the right architectural layer for this. Documented as
deferred.

---

# Seventeenth audit pass — targeted hunt across leftover surface

User asked to continue, naming five specific areas to dig
into: web client's optimistic-message reducer, typing-
indicator timeout, LiveKit stage promote/demote, embed cache
invalidation, and the relationships listing query.

Six bugs found across those surfaces plus the round-15 #75
follow-up that surfaced once the server side was correct.

## 80. Optimistic message reorder

**Files:** `apps/web/src/state/AppState.tsx`

`MESSAGE_REPLACE_LOCAL` used `.filter().concat([action.message])`
to swap the optimistic placeholder for the real server message.
The filter removed the placeholder but the concat always
appended the real message to the END of the channel list,
regardless of where the placeholder had been or what messages
had arrived in the meantime.

Trace:

  1. Channel tail: `[..., old2(id=150)]`
  2. User clicks send → optimistic placeholder appended:
     `[..., old2, A_local]`
  3. Another user's msg B (id=200) arrives via gateway
     MESSAGE_APPEND: `[..., old2, A_local, B(200)]`
  4. REST returns A's real id=199 → MESSAGE_REPLACE_LOCAL
  5. Reducer: filter A_local → `[..., old2, B]`; concat real A
     → `[..., old2, B, A(199)]`

UI shows A AFTER B, but A's snowflake says it was created
BEFORE B. The channel renderer (`groupMessages`) doesn't sort
— it just iterates in insertion order — so this is what the
user sees. A refetch from REST would reshuffle the list back
into snowflake order, surfacing the bug retroactively.

Fix: replace IN PLACE at the placeholder's index. The
placeholder's position approximates "where the user expected
their message to appear plus zero or more later arrivals" —
preserving that index keeps the user's message visually
anchored where they pressed send, and the later arrivals
already appended after the placeholder stay in correct
relative order. Three branches:

  - placeholder not found → fall back to tail-append
  - real already present (gateway echo beat REST) → drop
    placeholder, leave the real one where MESSAGE_APPEND put it
  - normal path → splice in place

## 81. Typing state leaked across auth sessions

**Files:** `apps/web/src/state/Typing.tsx`

`TypingProvider` left its mutable `stateRef.byChannel` Map
untouched when `token`/`user` became null. Logout → relogin
cycle could surface up to `TYPING_TTL_MS` (5s) of stale
indicators from the previous session before the periodic
sweep expired them. The bug is purely visual but trivial to
fix — same shape as the round-15 voice-prefs cancel-flag
cleanup.

Fix: in the TYPING_START subscription effect's cleanup,
call `stateRef.current.byChannel.clear()` and bump the
revision counter to force a re-render. New session starts
with a clean map.

## 82. Stage demote leaked publish rights at the SFU

**Files:** `apps/api/src/services/stage.ts`

The stage service's `setSpeaker` updated the DB row's
`isSpeaker` flag and the route broadcast STAGE_PARTICIPANTS_UPDATE,
but neither side told LiveKit. The file's header comment
acknowledged this as a "client cooperates" trust model — the
demoted user's client is supposed to fetch a fresh token and
reconnect to the SFU with the new (canPublish=false) grants.

This was broken against adversarial users:

  - LiveKit tokens are validated at JOIN time, not refreshed
    mid-session. A participant already in the room keeps the
    grants they were issued.
  - A demoted speaker who refuses to disconnect/reconnect
    keeps publishing audio. Their existing token's
    canPublish=true persists for the token TTL (~1h).
  - The DB row says "audience"; the SFU still passes their
    audio through. Other participants hear them despite the
    moderator action.

Fix: after the DB update, call LiveKit's `updateParticipant`
RPC to force the live participant's permissions at the SFU
level. Mirrors the existing `removeParticipant` pattern from
voice eviction — best-effort try/catch around it, treat SFU
failures as soft (logged but don't fail the demote, since
the DB row is the source of truth and the gateway event
still informs the UI).

Service header comment updated to reflect the new model:
permissions are now SFU-authoritative on promote/demote
calls, not just client-cooperative.

Required adding `livekit-server-sdk` import + `env` + `log`
imports to stage.ts (voice.ts had them; stage.ts didn't,
since previously stage never touched LiveKit directly — all
its LiveKit work went through `voice.mintLivekitToken`).

## 83. Edit didn't refresh embeds

**Files:** `apps/api/src/routes/messages.ts`

`resolveAndPersistEmbeds` was called on message CREATE but
not on EDIT. When a user edited a message that contained a
URL, the message's `embeds` field stayed at the embeds
resolved against the ORIGINAL content. Two failure shapes:

  - Edit "look at https://old.com" → "look at https://new.com":
    new URL goes unembedded, old preview persists pointing at
    a URL that's no longer in the message.
  - Edit "look at https://site.com" → "look at": the user
    removed the URL but the preview card remains.

Fix: fire-and-forget call to `embeds.resolveAndPersistEmbeds`
after the edit's `dispatch.messageUpdate`. The function
already handles the no-URLs case (writes `[]`), so removal
clears the previews. Same pattern as the create-time call.
A second MESSAGE_UPDATE arrives 100-2000ms later with the
new embeds — clients reconcile.

## 84. Soft-deleted users surfaced in friends/blocks lists

**Files:** `apps/api/src/services/relationships.ts`

`listRelationships` joined `users` by relationship.targetId
but filtered only on `relationships.userId`. Rows for
soft-deleted target users (`users.deletedAt IS NOT NULL`)
still matched the inner join.

Effect: a friend who deletes their account stays in your
friends list with their pre-deletion display name + avatar
forever, and their user-id clicks through to a profile
that the server treats as gone.

Fix: add `isNull(schema.users.deletedAt)` to the WHERE. The
fix is deliberately ASYMMETRIC across user states:

  - Soft-deleted: filtered out. The user explicitly removed
    their account; surfacing them in others' lists violates
    that.
  - Banned: kept. A banned account is still "a user," and a
    block against a banned account should keep showing so
    the blocker has continuity if the ban is later lifted.
    Likewise, a friend who gets banned shouldn't silently
    disappear from your friends list — the relationship
    survives.

## 89. Mention-count flicker on stale ack (follow-up to #75)

**Files:** `apps/web/src/state/AppState.tsx`

Surfaced once round-15's #75 corrected the server side. The
server now preserves `mention_count` when the ack's
`lastMessageId` doesn't advance past the existing marker.
The client-side reducer's READ_STATE_UPSERT case had a
matching "backwards marker" branch (kept existing marker,
accepted incoming `mentionCount`) but that "accept" was
predicated on the OLD server behavior (always reset to 0).

Combined with the optimistic dispatch at the call site
(`ackChannel` always sets `mentionCount: 0` immediately on
click before the REST call), this produced a transient
5 → 0 → 5 flicker when the user clicked "jump to message"
on an older message:

  1. State: `(lastMessageId: 200, mentionCount: 5)`
  2. User jumps to msg 150 → ackChannel dispatches
     optimistic `(150, 0)`
  3. Reducer sees backwards marker → keeps `lastMessageId:
     200`, accepts incoming `mentionCount: 0` → state is
     `(200, 0)`. Badge clears.
  4. ~100ms later, server's gateway echo arrives with the
     authoritative `(200, 5)` → state restored.

Visible flicker, but worse than that: any UI subscriber
watching mentionCount briefly saw zero and might have
acted on it (e.g. animating the badge disappearance).

Fix: in the backwards-marker branch, keep both the existing
marker AND the existing count. With #75 in place, ANY
incoming readState in this branch is either an optimistic
miscount or a stale gateway echo from another device — never
authoritative. Forward-marker acks still hit the else branch
and accept the full new readState (with `mentionCount: 0`
correctly reflecting the server's reset on a marker-advancing
ack).

---

# Eighteenth audit pass — second sweep across the same surface

The seventeenth pass found six bugs, which suggested the leftover
surface was still load-bearing. Continued hunting in the same
neighborhood (invites, DMs, blocks, webhooks, threads,
moderation paths, member listings, validation primitives, audit
trail). Twelve more bugs.

The throughline is "state that didn't propagate correctly to all
the places that depended on it" — soft-deletion of guilds didn't
gate invite redemption; admin instance-ban left guild_members
intact; webhook lookups didn't verify their channel; mention
resolution didn't filter banned users; URL fields didn't
distinguish server-controlled CDN paths from arbitrary external
URLs.

## 91. Archived threads accepted new messages

**Files:** `apps/api/src/routes/messages.ts`

`services/threads.ts:setArchived` doc-comment promised "route
handlers reject SEND_MESSAGES" but the gate was never wired.
Users could send to an archived thread, contradicting the
documented invariant. The threadArchivedAt field was referenced
only for listing/sorting purposes, not enforcement.

Fix at the SEND_MESSAGES permission gate (before the perm check,
since the more-specific error is "this channel is locked"):
reject when `ctx.channel.type === 'public_thread'` and
`threadArchivedAt !== null`. To send, a mod unarchives via
PATCH /channels/:id and then sends normally. No
MANAGE_MESSAGES override — keeping the rule simple. DMs aren't
archivable so the check stays inside the `!isDM` branch.

## 92. Accept-invite ignored guild deletion

**Files:** `apps/api/src/services/invites.ts`

`previewInvite` correctly inner-joined `guilds` with
`isNull(deletedAt)` (line 104), but `acceptInvite` read invites
alone and never validated the target guild. A user could
redeem an invite to a soft-deleted guild and end up with a
stranded `guild_members` row pointing at a dead guild — they'd
see "joined!" but nothing in their sidebar (every list path
filters deletedAt). The orphan row would also create awkward
UX: a future un-delete would silently restore membership.

Fix: same inner-join + deletedAt filter as preview, in the
step-0 invite lookup. Generic notFound surface so the response
doesn't leak whether the guild was deleted (vs. invite being
expired or never existing) — important when admins
force-delete guilds for policy violations.

## 93. Block didn't prevent DM creation

**Files:** `apps/api/src/services/dms.ts`

`getOrCreateDM` had no block check. A user A who had been
blocked by user B could call POST /dm with B's user-id and
silently open a fresh DM channel with them. The block feature
was decorative at the DM creation layer — it only suppressed
B in A's relationships list (#84) and prevented A from sending
friend requests (existing logic). DMs flowed both ways.

Fix: dynamic-import `isBlockedEitherWay` from relationships
(static import would create a leaf-services cycle that doesn't
exist yet but would surface if either side grew). If a block
exists in either direction, throw `notFound('User')` — generic
surface so the response doesn't leak block direction.

The symmetric model ("any block stops new DMs in either
direction") differs from Discord's asymmetric model (block
stops B→A but not A→B). For a self-hosted alt the simpler
model is fine — anyone who wants asymmetric behavior can
unblock briefly.

## 94. Block didn't prevent DM sends

**Files:** `apps/api/src/routes/messages.ts`

Companion to #93. Even with #93 fixed, blocking the other
party in a pre-existing DM was purely cosmetic — they could
keep sending messages that arrived in the blocker's UI. The
message-send route had no block check.

Fix: after the guild-permission branch finishes, for 1:1 DMs
(`ctx.channel.type === 'dm'`), load the other recipient via
`dms.getOtherRecipient`, run `isBlockedEitherWay`, throw
`notFound('Channel')` on hit. Notfound rather than forbidden
so the failure looks like "channel doesn't exist for you"
rather than confirming the block direction.

Group DMs (`group_dm`) deliberately NOT covered: multi-recipient
block semantics are ambiguous — suppress for blocker only?
evict the blocked user? evict-on-block? — and we'd rather defer
than pick arbitrarily. 1:1 is the primary surface and has a
clear semantic.

Combined with #93, blocking is now actually enforced end-to-end
on 1:1 DMs.

## 95. Accept-friend race could overwrite a block

**Files:** `apps/api/src/services/relationships.ts`

`acceptFriendRequest` checked the request state with a SELECT
outside the transaction, then UPDATEd both directions
unconditionally to 'friend'. The race window between the
SELECT and the transaction's UPDATEs admits a concurrent block
that this code path silently undoes.

Trace (A has incoming_request from B, A clicks accept, B
simultaneously blocks A):

  1. A reads (A, B, 'incoming_request') — OK to accept
  2. B calls blockUser(B, A):
     - deletes (B, A) row (B's outgoing_request)
     - deletes (A, B) row per #76's split-wipe (request types
       are non-blocked so cleared in reverse direction)
     - inserts (B, A, 'blocked')
  3. A's transaction:
     - UPDATE (A, B) → 0 rows (already deleted)
     - UPDATE (B, A) → without the type filter, would rewrite
       the freshly-inserted 'blocked' row to 'friend'

Final state: B silently becomes A's "friend" even though they
just blocked A. Worse: A has no row at all from their side
(the deletion held), but B has (B, A, 'friend'). Asymmetric
ghost-friendship — worst-case violation of consent for B.

Fix: add `eq(type, 'incoming_request')` / `eq(type,
'outgoing_request')` predicates to the two UPDATEs. With the
type filter, the (B, A, 'blocked') row no longer matches, the
UPDATE no-ops. If both UPDATEs return zero rows the function
surfaces notFound — the request is effectively gone.

Same race existed in `sendFriendRequest`'s auto-accept branch
("you have an incoming request, sending one back accepts").
Applied the same fix to both call sites.

## 96. Webhook execution didn't validate channel / owner state

**Files:** `apps/api/src/services/webhooks.ts`

`executeWebhook` only validated id+token. Two missing checks:

**Channel state.** `channels.deleteChannel` soft-deletes the
channel row but doesn't cascade to webhooks. A leaked or
pre-existing webhook token kept producing messages against a
channel that no longer renders for anyone — clients filter
deletedAt channels but the messages still got persisted, adding
DB bloat and showing up in any moderation/audit path that
didn't filter at query time.

**Owner state.** The webhook posts as `wh.createdBy`. The
existing check rejected NULL createdBy (orphan webhook) but
not banned or soft-deleted owners. A banned admin's
pre-created webhook keeps producing messages attributed to
them — they're locked out of REST and gateway, but their
webhook token continues working as long as the channel
exists. This is a deliberate evasion path for any admin who
created webhooks before being banned.

Fix: after the webhook lookup, SELECT the channel's deletedAt
and the owner's bannedAt + deletedAt. Reject with the generic
"Invalid webhook id or token" surface for any failure so an
attacker can't distinguish "token wrong" from "channel deleted"
from "owner banned."

## 97. Banned users inflated counts and ghosted in member lists

**Files:** `apps/api/src/services/discovery.ts`, `apps/api/src/services/members.ts`

The instance-ban path (admin-side) sets `users.bannedAt` and
revokes sessions, voice connections, and gateway connections.
It deliberately leaves `guild_members` rows intact — mirroring
the `deleteGuild` retention pattern, so audit-log joins work
across bans. Without filtering at read time, two surfaces
expose those banned rows:

**Discovery member count.** The correlated subquery
`COUNT(*) FROM guild_members WHERE guild_id = ...` returned
banned ghosts. Result: the public directory reported inflated
counts for guilds that had banned anyone. A determined attacker
could create many accounts, join a target guild, then get
admin-banned (or accept a ban) to artificially inflate the
visible count.

**Member list.** `listMembers` joined `users` but didn't
filter on bannedAt or deletedAt. Banned users showed in every
shared guild's sidebar with their pre-ban state (display name,
avatar, last-known status). Cosmetic, but jarring — they look
present despite being locked out.

Fix: inner-join + `isNull(bannedAt) AND isNull(deletedAt)` on
both. `getMemberDetailed` deliberately NOT changed — admin
moderation paths need to look up banned users (e.g. for the
unban flow's "show me who's banned").

The `users.deletedAt` filter is belt-and-suspenders: no path
currently writes that column, but the schema supports it and
future account-deletion would arrive needing the same
treatment.

## 98. Avatar / banner / icon URLs accepted arbitrary external URLs

**Files:** `apps/api/src/lib/validation.ts`, `apps/api/src/routes/users.ts`, `apps/api/src/routes/guilds.ts`

Five places accepted `z.string().url().nullable()` for
URL-shaped DTO fields that the upload pipeline produces as
`/cdn/<path>` strings:

  - `users.ts:patchMeSchema.avatarUrl`
  - `users.ts:patchMeSchema.bannerUrl`
  - `guilds.ts:createGuildSchema.iconUrl`
  - `guilds.ts:patchGuildSchema.iconUrl`
  - `guilds.ts:patchGuildSchema.bannerUrl`

The schema comment claimed "usually set via POST /@me/avatar
after upload, but accepted here too so admins or scripts can
clear it (set to null) without going through the upload
pipeline." The intent was "clearing OR re-pointing at an
already-uploaded /cdn/ path," but the schema permitted any
URL.

Three real impacts:

  - **Tracking beacon.** A user sets `avatarUrl` to
    `https://evil.com/track-pixel.png`. Every place their
    avatar renders (member list, message author photos, DM
    list, profile cards, mention pills) becomes a beacon that
    fetches evil.com on render — leaking viewing-client IP,
    User-Agent, and Referer to the attacker. Across an active
    server with N members, this is N×M fetches per page load.
  - **Content moderation bypass.** Servers may have policies
    against offensive imagery in avatars. Server-uploaded
    images go through (eventual) moderation hooks; external
    URLs don't. An external URL can also change content after
    submission — the attacker uploads a benign image, then
    swaps it for something prohibited at the URL.
  - **Indirect DoS / bandwidth-abuse.** Avatar URL pointing
    at a heavy resource amortizes the bandwidth bill of the
    target across every viewing client.

Fix: a shared `cdnPathOrNullSchema` in
`lib/validation.ts` restricts to either null or
`/cdn/<path>`. The five sites import + use it instead of
the open `.url()` shape. Schema-level rejection — no
attacker payload reaches the service or DB layer.

Push subscription endpoint (`subscribeSchema` in
`routes/users.ts`) is the one URL field we left as open
`.url()`: it's a browser-provided push-gateway endpoint,
not user-displayed content, no beacon vector. (The SSRF
surface there — registering `http://127.0.0.1` — is real
but small, gated by VAPID signatures, and the operator can
mitigate at the egress firewall layer. Deferred.)

## 99. Mentions resolved banned and soft-deleted users

**Files:** `apps/api/src/services/mentions.ts`

`resolveMentions` did a plain `inArray` lookup with no state
filter. Mentioning a banned user persisted a valid mention
row AND triggered a push notification — banned users kept
receiving channel-activity pings about content they could no
longer see. Push titles include channel names and message
previews, so this was a low-grade information leak too.

Fix: filter `isNull(bannedAt) AND isNull(deletedAt)` on the
user-id lookup. Mentions to banned users silently resolve to
"no such user" — the `@id` token stays in the message content
on the client side (typically as plain text since no matching
user is found in the local user map).

## 100. Banned admins kept admin powers for ~15 minutes

**Files:** `apps/api/src/auth/middleware.ts`

`requireAdmin` checked `isAdmin` but not `bannedAt` /
`deletedAt`. The deliberate design choice that `requireAuth`
doesn't do a per-request DB lookup (rely on JWT signature +
expiry only) means session revocation is eventually-
consistent up to `ACCESS_TOKEN_TTL_SECONDS` (~15 minutes).
For regular users this is the documented "we'll add a Redis
blacklist in v1.x" deferred item.

For ADMINS the window is much worse: a freshly-banned admin's
still-valid access token kept authenticating them on every
admin endpoint until the access token expired. They could
ban/unban, force-signout, mod-delete, and PATCH instance
state during that 15-minute window — including potentially
un-banning themselves.

Fix: `requireAdmin` already does a DB lookup for `isAdmin`,
so adding `bannedAt` and `deletedAt` columns to the same
SELECT closes the window at zero cost. The general
banned-user check for non-admin routes remains deferred —
that one genuinely needs the blacklist to avoid adding a
per-request DB hit.

## 101. DM creation succeeded against banned users

**Files:** `apps/api/src/services/dms.ts`

`getOrCreateDM`'s existence check used `IN (userA, userB)`
without filtering `bannedAt` / `deletedAt`. So a user A could
open a fresh DM channel with banned user B: the channel got
created, the dm_recipients rows persisted, A sent messages
that went nowhere (B's gateway is closed, REST is gated for
new tokens), and the dead DM sat in A's sidebar pointing at
someone they couldn't reach.

Different intent from #84 (listRelationships kept banned users
to preserve block-relationship continuity): here we're talking
about NEW conversation creation, which should fail cleanly for
banned/deleted users.

Fix: `and(IN(...), isNull(bannedAt), isNull(deletedAt))`.
Throws `notFound('User')` on miss — same generic surface as
"user doesn't exist."

## 102. Reaction-role create bypassed role hierarchy

**Files:** `apps/api/src/routes/guilds.ts`

The reaction-role PUT route checked `MANAGE_ROLES` permission
but not role-hierarchy. A user with `MANAGE_ROLES` could
attach a reaction → any-role mapping, INCLUDING roles higher
than any role they hold themselves. Anyone clicking that
emoji then got the higher role assigned via the reaction-add
hook.

The reaction-add hook (`routes/messages.ts:1048-1080`)
deliberately doesn't enforce hierarchy at click time — that
would defeat the feature's purpose (point of reaction-roles
is anyone can self-assign by clicking, regardless of their
own permissions). So the create-time check is the only
defense.

Without it, MANAGE_ROLES becomes "grant ANY role" via the
reaction-role indirection — including roles higher than the
granter's, bypassing the hierarchy that's enforced on direct
role-assign and role-edit (which both call
`assertCanManageRole`).

Fix: call `assertCanManageRole(guildId, userId, roleId)` at
create time, after the role-belongs-to-guild check. The
mapping then represents a checkpoint — the creator's
permission at create-time gates which roles can become
reaction-attached.

The mapping outlasts the creator's permission, which matches
Discord's behavior: an admin who later loses MANAGE_ROLES
doesn't auto-invalidate reaction-roles they previously
created. Acceptable for v1 — admins clean up reaction-roles
during permission restructuring.

## 103. Channel-permission-override PUT had three authz gaps

**Files:** `apps/api/src/routes/channels.ts`

`PUT /:channelId/permissions/:targetId` checked `MANAGE_ROLES`
guild-wide but enforced nothing else. Three real attacks
behind that gap, all rooted in the same misconception: that
"can manage roles" implies "can do anything roles-related to
any target."

**Hide higher roles from a channel.** A user with
`MANAGE_ROLES` could create a role-type override targeting a
role HIGHER than any role they hold, with `deny:VIEW_CHANNEL`.
Members of that higher role (typically admins) suddenly lose
visibility on the channel without being able to see who did
it (until the audit log surfaces it). Useful for a malicious
moderator who wants to hide some activity from oversight.

**Self-grant escalation.** The same actor could create a
member-type override on themselves granting any channel-
scoped permission they don't currently hold. Concrete:
@everyone has no `SEND_MESSAGES` in a read-only announcements
channel; admin-role does. A moderator with `MANAGE_ROLES` but
no `SEND_MESSAGES` in that channel can self-grant by writing
a member-override allow:SEND_MESSAGES on themselves.

**Grant-what-you-don't-have.** The role-edit path at
`routes/guilds.ts:602-604` correctly enforces "you cannot
grant permissions you do not have yourself." The channel-
override path didn't — so a moderator with `MANAGE_ROLES` but
not `MENTION_EVERYONE` could allow `MENTION_EVERYONE` for
themselves or another member in a single channel by overriding
it. From there, @everyone pings.

Fix: branch on `body.type`. For role-type targets, call
`assertCanManageRole(guildId, userId, targetId)` — the same
hierarchy guard the role-edit and direct member-role-assign
paths use. For member-type targets, call
`assertCanManageMember`. Then, on either branch, if
`body.allow` is non-zero, verify the caller's own guild
permissions include every bit being granted — same shape as
the role-edit guard. DENY bits stay unrestricted: removing a
permission is monotonic-downward and can't escalate the
target.

## 104. Channel-override routes used guild-level `MANAGE_ROLES`

**Files:** `apps/api/src/routes/channels.ts`

All three override routes (`GET`/`PUT`/`DELETE`
`/:channelId/permissions[/:targetId]`) gated with
`assertGuildPermission(MANAGE_ROLES)`. So a user with
guild-wide `MANAGE_ROLES` who was denied `VIEW_CHANNEL` on a
specific channel via override could still:

  - LIST that channel's overrides (leaking the channel's
    existence and ACL structure even when they can't see the
    channel itself)
  - PUT/DELETE overrides on that channel

The concrete attack: a moderator with guild-wide
`MANAGE_ROLES` whose role isn't in `#admin-strategy`'s
category-level allow-list calls
`DELETE /admin-strategy-id/permissions/everyone-role-id?type=role`.
The override that was the ONLY thing hiding the channel from
`@everyone` is gone; everyone in the guild can now see
`#admin-strategy`. The moderator never needed admin-role,
never needed `VIEW_CHANNEL` on the channel — just
`MANAGE_ROLES` somewhere in their role chain.

The hierarchy check from #103 doesn't catch this because
`@everyone` is at position 0, and any role above 0 passes
`assertCanManageRole(@everyone)`. The check was designed for
"can I edit this role's properties?" — which @everyone
generally should not block other roles from doing — not for
"can I delete this override?"

Fix: switch all three routes from
`assertGuildPermission(MANAGE_ROLES)` to
`assertChannelPermission(channelId, userId, MANAGE_ROLES)`.
The channel-level resolver computes the effective permission
on this specific channel after applying overrides — so a
moderator denied access to `#admin-strategy` simply doesn't
have `MANAGE_ROLES` there, and the assertion fails. Matches
Discord's documented behavior: channel-override management
requires effective permissions on the channel, not just
guild-wide.

Also added the hierarchy / member-management checks from #103
to the DELETE branch — symmetric with PUT, defending against
the deletion path of the same family of attacks.

ADMINISTRATOR-bit holders and guild owners correctly bypass
via `computeChannelPermissions`'s short-circuit (returns
`ALL_PERMISSIONS` if `isOwner` or if base perms include
ADMINISTRATOR), so admins can still fix locked-out channels.

## 105. Channel PATCH and DELETE used guild-level `MANAGE_CHANNELS`

**Files:** `apps/api/src/routes/channels.ts`

Same family as #104, this time for `MANAGE_CHANNELS` instead
of `MANAGE_ROLES`. `PATCH /:channelId` and `DELETE
/:channelId` both used `assertGuildPermission(MANAGE_CHANNELS)`.
A moderator with guild-wide `MANAGE_CHANNELS` who was denied
`VIEW_CHANNEL` on a specific channel could still:

  - **DELETE** the channel they couldn't see. Catastrophic
    data loss: they erase a channel they have no business
    knowing exists, and they never even saw what was in it.
  - **PATCH** the channel, including its `parentId`. Moving a
    hidden channel into a category whose permissions DO grant
    them visibility is a direct access escalation: I can't
    see `#admin-strategy` because the Admins category denies
    `@everyone:VIEW_CHANNEL`; I move it into `#General-Stuff`
    which has no such deny; now I can see it.

Fix: both routes switched to
`assertChannelPermission(MANAGE_CHANNELS)`. Same rationale as
#104. The PATCH path is the more interesting attack (silent
visibility gain); the DELETE is the louder one (immediately
breaks an admin's expectations).

## 106. Role-deletion leaked reaction-role mappings

**Files:** `apps/api/src/services/roles.ts`

`reaction_roles.role_id` has no FK reference (the column is
bare `bigint`, not `bigint references roles.id`). So deleting
a role doesn't cascade-delete the reaction-role mappings that
point at it. The orphan rows persist.

`deleteRole` already had explicit cleanup for
`permission_overrides` (whose `target_id` is polymorphic and
also can't have an FK), but missed the reaction-roles table.

The visible failure isn't security: when a user clicks the
emoji of an orphan mapping, the reaction-add hook calls
`addMemberRole` with the stale role-id, `addMemberRole`
throws "Role not found," the hook's try/catch swallows the
error, and the reaction succeeds as a silent no-op. The user
just doesn't get the (now-deleted) role.

Where it does break is the admin "manage reaction-roles" UI,
which surfaces these dead mappings forever as "react to get
[deleted role]" entries.

Fix: symmetric cleanup right after the override cleanup in
the same transaction —
`DELETE FROM reaction_roles WHERE role_id = $1`.

The fuller solution is to add the FK with `ON DELETE CASCADE`
in a migration. Deferred — the explicit cleanup matches the
existing `permission_overrides` pattern and is correct as
long as no other path deletes a role without going through
this service function.

## 107. Avatar/banner/icon upload race orphaned files on disk

**Files:** `apps/api/src/routes/users.ts`, `apps/api/src/routes/guilds.ts`

All four image-upload routes had the same shape:

  1. SELECT current `xxxUrl` from the row (capture `prior`).
  2. `saveUploadedFile(file)` writes the NEW file to disk.
  3. UPDATE row to point at the new URL.
  4. `deleteAttachmentFile(prior)` removes the old file.

Two concurrent uploads on the same target race the SELECT
against the UPDATE:

  - Req X: SELECT returns A0 → save A1 to disk → UPDATE to A1
    → delete A0.
  - Req Y (parallel): SELECT returns A0 (because X's UPDATE
    hasn't committed yet) → save A2 to disk → UPDATE to A2
    (last-write-wins) → delete A0 (no-op, already gone).

Final state: row points at A2, A2 file exists, A0 file
gone — BUT A1's file is on disk with NO row referencing it.
Permanent orphan; nothing will ever clean it up. A user
double-clicking the upload button is enough to trigger; in
the limit, a user spamming uploads accumulates orphan files
proportional to the number of races.

Fix: do the prior-read and the UPDATE inside one transaction
with `SELECT ... FOR UPDATE` on the target row. The lock
serializes concurrent uploads on the same row, so the second
transaction's `prior` reflects the FIRST transaction's
committed URL. Then the second transaction's
`deleteAttachmentFile(prior)` correctly removes the first
transaction's file, since that file is now what the row was
just rewriting away from.

Disk save stays OUTSIDE the transaction — IO is slow and
holding the row lock during disk write would serialize
unrelated requests for the duration. Trace either ordering:

  - X first: lock, SELECT(A0), UPDATE(A1), commit → prior=A0
    → delete A0. Y: lock, SELECT(A1), UPDATE(A2), commit →
    prior=A1 → delete A1. Final: row=A2, disk={A2}.
  - Y first: lock, SELECT(A0), UPDATE(A2), commit → prior=A0
    → delete A0. X: lock, SELECT(A2), UPDATE(A1), commit →
    prior=A2 → delete A2. Final: row=A1, disk={A1}.

Either way, no orphans.

Applied to all four routes:

  - `POST /@me/avatar` (user avatar)
  - `POST /@me/banner` (user banner)
  - `POST /guilds/:guildId/icon` (guild icon)
  - `POST /guilds/:guildId/banner` (guild banner)

For the guild routes, the UPDATE was previously delegated to
`guilds.updateGuild` which has its own pattern (no FOR
UPDATE, writes audit outside any transaction the route owns).
Inlined the UPDATE + audit-write inside the transaction with
`writeAudit({ tx, ... })` so the audit commits atomically
with the URL swap. If the audit insert fails, the URL swap
rolls back too, keeping the file pointer consistent with the
audit trail.

## 108. Refresh-token rotation non-atomic against current hash

**Files:** `apps/api/src/auth/sessions.ts`, `apps/api/src/routes/auth.ts`

`rotateSession`'s UPDATE filtered on `id + revokedAt IS NULL
+ expiresAt > now` but NOT on the current
`refresh_token_hash`. Two parallel `POST /refresh` calls with
the same cookie value:

  1. Both read cookie T0.
  2. Both call `findActiveSessionByRefreshToken(T0)` →
     returns the same session row (hash matches).
  3. Both call `rotateSession(session.id)`. The UPDATE WHERE
     matches for both — neither checked that the current
     hash was still T0's hash.
  4. Both UPDATE rows: X's commit sets hash to hash(T1) and
     returns T1; Y's then overwrites with hash(T2) and
     returns T2.
  5. Two refresh tokens issued. The client's cookie races to
     whichever response landed last (typically T2 since Y
     went second). T1 was issued but the moment Y's commit
     landed, T1's hash was no longer in the DB — T1 is a
     phantom valid-but-unused token.

Functionally users don't see a problem because they only hold
the last cookie set, but two real security issues:

  - **Broken refresh-token-reuse detection.** An attacker who
    steals T0 can race the legitimate user's refresh. One of
    them succeeds, the other fails 401 with no signal that
    the failure meant "your token was reused." A proper
    reuse-detection system would revoke the whole session on
    such an event; without atomic rotation we can't tell
    reuse from a stale local cache.
  - **Phantom-token observability.** The DB transiently
    "issued" both T1 and T2; only T2 is reachable, but T1
    was returned in HTTP response and may have been logged
    by intermediate caches, the client's storage, or
    monitoring. Confusing audit trail.

Fix: add `eq(refreshTokenHash, expectedCurrentHash)` to the
UPDATE WHERE. The route caller passes
`session.refreshTokenHash` (from the preceding find) as
`expectedCurrentHash`. Concurrent rotations:

  - X UPDATEs: WHERE includes `hash = hash(T0)` → matches →
    UPDATE succeeds, hash becomes hash(T1).
  - Y UPDATEs: WHERE includes `hash = hash(T0)` → matches
    ZERO rows because the DB hash is now hash(T1) → returns
    null. The route treats null as 401 and clears the cookie.

One wins, the other gets a clean 401. Phantom tokens
disappear. Reuse-detection has a foothold (we can now infer
"if your refresh failed AND the cookie you sent matched a
known-rotated-away hash, that's reuse" — out of scope for
this round but unblocked by the atomic primitive).

## 109. Role reorder allowed elevating roles above the actor

**Files:** `apps/api/src/routes/guilds.ts`

`PATCH /:guildId/roles` accepts `positions: [{id, position}]`
and calls `assertCanManageRole` on each id. That guard checks
the role's CURRENT position must be below the actor's top —
preventing direct edits on roles above the actor. But the
TARGET position was unchecked.

Trace: moderator at top position 5 submits `{id: X_id,
position: 7}` where X is at position 3.

  - `assertCanManageRole(X)`: X.position=3 < actorTop=5. Passes.
  - Reorder commits. X is now at position 7.
  - After the move, X.position=7 > actorTop=5. Members
    holding X now outrank the moderator AND every role
    between positions 5 and 7.

Effective escalation: the moderator just promoted X's
members above their own peers. Anyone else at positions 5
or 6 — who weren't actionable by X-holders before — now is.
The moderator can't undo the reorder either (assertCanManageRole
on X now fails). Anyone with at-position-5 mod role loses
their authority over the X-empowered users.

Fix: load the actor's top role once, validate each submitted
`(id, position)` pair has `position < actorTop`. Owners and
ADMINISTRATOR-bit holders bypass this check via the same
short-circuit pattern used in `assertCanManageRole` — they
have no hierarchy ceiling and need full reorder capability
for legitimate config work.

Pulls in `inArray` from drizzle-orm for the role-position
lookup; also calls `members.getMemberDetailed` +
`computeMemberGuildPermissions` which were already imported.

## 110. Inactivity sweep had two operational hazards

**Files:** `apps/api/src/services/inactivitySweep.ts`

Default `INACTIVITY_TTL_DAYS=365`. The sweep hard-deletes
users whose `MAX(sessions.last_used_at)` is older than the
cutoff (or whose `created_at` is, when they have no
sessions). Two real problems with the candidate selection:

**Admins not excluded.** A long-lived backup admin account
that the operator maintains for recovery (login every few
months to verify access still works) might fall below the
365-day threshold and get silently destroyed. Operators
typically don't expect their admin accounts to be subject to
auto-deletion at all.

**Guild owners cause batch failure.** `guilds.owner_id` has
`ON DELETE RESTRICT` (line 5 of the schema). The sweep
deletes in chunks of 500 ids. If ONE inactive guild owner is
in the chunk, the FK violation rolls back the ENTIRE chunk's
DELETE statement — 499 other eligible users stay alive.
Repeat sweeps see the same owner each time and fail again.
The sweep effectively stalls on that owner forever, with the
ttl-eligible backlog growing.

Fix: candidate query adds two filters at SELECT time:

  - `eq(users.isAdmin, false)` — protect admin accounts
    from auto-delete unconditionally. If an operator wants
    to delete an inactive admin, they can demote and then
    let the sweep act, or do it manually.
  - `id NOT IN (SELECT owner_id FROM guilds)` — exclude
    anyone referenced by `guilds.owner_id`. The FK remains
    the real protection; this filter just keeps the sweep
    from constantly tripping on it.

Both filters are belt-and-suspenders. The system stays
correct even without them (FK prevents owner deletion); this
makes it OPERATIONALLY robust. Single-user-per-chunk fallback
or savepoint-per-user would also work but is more invasive.

## 111. Refresh route didn't ban/delete-check the user

**Files:** `apps/api/src/routes/auth.ts`

The admin ban handler does two sequential statements: `UPDATE
users SET bannedAt = now()` then `revokeAllUserSessions(uid)`.
Between those two UPDATEs there's a microsecond-wide window
where the user is banned but their sessions are still
active.

A refresh request landing in that window:

  1. `readRefreshCookie` → T0.
  2. `findActiveSessionByRefreshToken(T0)` → session (still
     not revoked).
  3. `rotateSession` succeeds, issues T1.
  4. New access token signed and returned.

The user now has ~15 more minutes of REST access (until
access token expiry). Eventually their next refresh after
that 15 minutes will fail (sessions are revoked by then),
but they got an unexpected grace period.

Fix: explicit `bannedAt` / `deletedAt` check in the refresh
handler after the session lookup. Refresh is low-frequency
(~once per 14 min per active session) so the extra DB hit
is negligible. Same shape as the gateway IDENTIFY check.

This is technically a workaround for the non-atomic ban
handler. A cleaner fix would be to wrap the ban's two
UPDATEs in a single transaction so the visible "user is
banned" state is consistent with "all sessions revoked." But
the refresh check is also correct for `deletedAt` (set by
future account-deletion flows, not the ban path) and acts
as a per-axis defense regardless of how the upstream
mutation is structured.

---

# Nineteenth audit pass — voice/permission interactions

The earlier rounds built up the channel-permission machinery
(role-bits → role-overrides → category inheritance → member-
overrides). Round 18 fixed several gaps in WHO could change
those bits. This pass asked: when those bits DO change, does
all the downstream state actually update?

One real bug; one concern that surfaced but wasn't bug-fixable
within scope.

## 112. Permission changes didn't evict voice/stage participants

**Files:** `apps/api/src/gateway/dispatch.ts`

`refreshUserViewableChannels` is the helper that runs after
any change that could shift a user's per-channel visibility:
role-add/remove (`applyMemberRoleChange`), role-bit edit, or
channel override upsert/delete (`applyGuildPermissionChange`).
It correctly:

  - Computes the new authoritative viewable-channel set
  - Diffs against the connection's cached set
  - Sends `CHANNEL_DELETE` for any newly-hidden channels
  - Sends `CHANNEL_CREATE` for any newly-visible ones
  - Updates the connection cache so subsequent events route
    consistently

But it didn't touch `voice_states`. So a user U who was
streaming audio in voice channel V — connected to LiveKit,
publishing audio, hearing others — and who had `VIEW_CHANNEL`
on V denied via a role-override change kept their:

  - `voice_states` row (DB says they're still in V)
  - LiveKit session token (valid up to ~1 hour from issue)
  - Active SFU presence (still publishing + subscribing)

What changed: their UI lost the channel from the sidebar.
That's it. Effectively kicked from the visible roster but
still in the audio room — listening to and talking in a
channel they can no longer see they're in.

For stage channels the situation was worse: the
`stage_participants` row also persisted, marking them as a
participant. Re-joining the same stage would short-circuit
on `existing` in `joinStage`, so they could never
re-attempt the permission check that would now block them.
Their roster row would be stuck "on stage" forever.

Fix: in `refreshUserViewableChannels`, after applying the
visibility diff, run a small voice-presence check. If the
user has a `voice_states` row in this guild AND its channel
is in the just-removed set, run the full eviction:

  1. `voice.evictFromVoiceInGuild(userId, guildId)` —
     deletes the `voice_states` row AND calls LiveKit's
     `RemoveParticipant` to drop the SFU session.
  2. `DELETE FROM stage_participants WHERE channel_id, user_id`
     unconditionally — if the channel was stage, this cleans
     up the roster row; if not, zero rows match harmlessly.
  3. Publish `VOICE_STATE_UPDATE` to the guild so remaining
     members see the disconnect.

The check costs one indexed lookup per affected user
(`voice_states.user_id` is the PK), and the actual eviction
runs only when both conditions hold. For
`applyGuildPermissionChange` which iterates over every
connected user in the guild, that's N quick PK lookups —
acceptable for a low-frequency permission change.

Deferred refinement: pre-load all `voice_states` for the
guild once in the bulk path so the per-user loop is just a
set check. Trivial optimization; current shape is correct.

## Concern: webhook tokens leaked through list / patch responses

**Files:** `apps/api/src/lib/dto.ts` (toWebhook), `apps/api/src/routes/webhooks.ts`

`toWebhook` includes the bearer `token` field. The CREATE
response legitimately returns it (operator needs to copy
into integration config). But the LIST endpoint
(`GET /channels/:channelId/webhooks`) and PATCH endpoint
(`PATCH /webhooks/:webhookId`) also use `toWebhook` and
return the token to every `MANAGE_WEBHOOKS` holder.

The permission is therefore effectively a permanent
impersonation grant on every webhook in scope: anyone who
ever held `MANAGE_WEBHOOKS` can have collected every
token, and tokens have no expiry. After they lose the
permission or leave the guild, the tokens remain valid,
so they can keep posting messages as any webhook they
collected.

I started a fix (split `toWebhook` into safe + with-token
variants, expose only safe in LIST/PATCH) and realized
it broke the existing client UI: `ChannelWebhooksTab.tsx`
constructs the webhook URL inline in the list using
`webhook.token` from the listing response, so removing
the field from list responses would surface as
`/api/webhooks/123/undefined` URLs in the UI.

Properly addressing this needs:

  - A regenerate-token endpoint (POST
    `/webhooks/:webhookId/regenerate`) that issues a fresh
    token, invalidating the old.
  - Client UI changes: show the webhook URL only on
    creation and after explicit regenerate; for existing
    rows, display name/avatar but require regenerate to
    obtain a usable URL.
  - Optional: token expiry / rotation policy.

That's a feature delta, not a bug-fix patch. The change
is deferred. Documented inline on the DTO (`apps/api/src/lib/dto.ts`)
so the next developer reading the code understands the
risk before adding more callers that exfiltrate the
field.

## 113. Typing dispatch leaked invisible-user presence

**Files:** `apps/api/src/routes/channels.ts`

Status `invisible` masks presence broadcasts ("appears
offline" to others — see the DTO at `dto.ts:88-92` and the
broadcastStatus shim at `routes/users.ts:135`). But typing
was untouched: an invisible user typing in any channel
fired `TYPING_START` with their userId, and connected
members saw "User X is typing…" — directly contradicting
the presence broadcast that says X is offline.

Same shape as the existing presence mask but at a different
event. Discord suppresses typing for invisible users for
exactly this reason.

Fix: in `POST /:channelId/typing`, after the permission
gate, read `users.status` for the caller. If
`'invisible'`, return 204 without dispatching. The user
can keep typing locally; only the outbound notification
is suppressed.

Cost: one PK lookup per typing event for invisible users
(rare path) and per typing event for everyone else (typing
fires at ~once-per-5-seconds while typing, so it's
low-rate). Acceptable; could be cached on the connection
if it becomes hot.

Not all action-derived presence is mask-able — reactions
and voice presence create persistent state (reaction rows,
voice_states rows) that ARE visible to others. Discord
makes the same trade-off: invisible mode masks ephemeral
presence (status, typing) but not persistent actions. The
fix matches that model.

## 114. polls.vote / removeVote / endPoll accepted on deleted messages

**Files:** `apps/api/src/services/polls.ts`

The poll service's three mutating functions
(`vote`, `removeVote`, `endPoll`) all join `polls` to
`messages` on `messages.id = polls.message_id` and use
the join result for the channel-permission check. The
joins didn't filter `messages.deletedAt`.

`polls` has `onDelete: 'cascade'` on `messageId` referring
to `messages` — but that cascade only fires on HARD
delete. Message delete is SOFT (`deletedAt` set, row
preserved for reply walkability), so `polls` rows
persist alongside their soft-deleted parent.

A client with a cached `pollId` could then keep
mutating the orphaned poll:

  - `POST /channels/:cid/polls/:pid/options/:oid/vote`
    inserts a `poll_votes` row, increments tallies.
  - `DELETE /…/vote` removes their vote.
  - `POST /…/end` closes the poll.

The hydration path (`loadPollsForMessages`) is fed
`messageIds` from `listMessages` which DOES filter
`deletedAt`, so the poll wouldn't appear in normal client
state. Clients normally don't render polls for deleted
messages. But a stale cache, a determined attacker, or
script tooling can bypass that and reach the service.

Fix: each of the three joins gains
`isNull(messages.deletedAt)` in its WHERE. The downstream
permission gate and tally writes stay unchanged — the
filter just ensures we never reach those branches with a
detached poll. Imports `isNull` from drizzle-orm.

Defense-in-depth fix — the practical reach is small
(cached client only) but the server's invariant is that
state-changing operations on deleted messages should
fail uniformly, and these three routes were exceptions.

## 115. addReaction comment claimed deletedAt filter that wasn't there

**Files:** `apps/api/src/services/reactions.ts`

The existence check at the top of `addReaction` was:

    const m = await db
      .select({ id: schema.messages.id })
      .from(schema.messages)
      .where(eq(schema.messages.id, messageId))
      .limit(1);
    if (!m[0]) throw errors.notFound('Message');

With the comment immediately above:

    // Verify the message still exists (and isn't deleted) — a
    // soft-deleted message shouldn't accumulate new reactions.

The comment promised a `deletedAt` filter; the WHERE didn't
deliver one. Same class of issue as #114: state changes on
deleted messages should fail uniformly.

Fix: add `isNull(schema.messages.deletedAt)` to the WHERE.
Imports `isNull`. Same defense-in-depth reasoning as #114.

A scan of the rest of `reactions.ts` shows the moderation
paths (clearAll, clearEmoji, removeUserReaction) call into
the bare reactions table without going through the
messages join — they delete reactions by `messageId` alone.
That's fine: deleting a soft-deleted message's reactions
is harmless and may even be useful for cleanup. The
asymmetry (read with delete-filter, write without) is
intentional for the moderation side.

## 116. Channel delete didn't evict voice/stage participants

**Files:** `apps/api/src/routes/channels.ts`, `apps/api/src/services/voice.ts`

Symmetric with #112 but triggered by channel deletion
instead of permission change. `DELETE /:channelId`:

  1. Soft-deletes the channel (`deletedAt` set on the row).
  2. Dispatches `CHANNEL_DELETE` so clients remove it from
     their sidebar.
  3. ... and that's it.

Anyone currently in the channel's LiveKit session keeps
their token (valid up to ~1 hour), keeps publishing audio,
keeps subscribing. The `voice_states` rows persist
(pointing at a soft-deleted channel — FK cascade only
fires on hard-delete). For stage channels, the
`stage_participants` roster rows persist too.

A moderator deleting a noisy voice channel during a
moderation incident would expect "the channel is gone, the
voices stop" — but the voices kept going on the LiveKit
side, and the moderator wouldn't have any UI to act on
them (the channel is gone from their sidebar).

Fix: new service helper `voice.evictAllVoiceInChannel`,
the per-channel sibling of `evictAllVoiceInGuild`. Does:

  - DELETE FROM voice_states WHERE channel_id = ?
    returning prior rows
  - DELETE FROM stage_participants WHERE channel_id = ?
    (unconditional — no-op for non-stage channels)
  - LiveKit `RemoveParticipant` per evicted row,
    sequential to avoid hammering the SFU
  - returns evicted rows so the route can dispatch
    `VOICE_STATE_UPDATE` per user

The route now calls this helper after `channels.deleteChannel`
commits, then dispatches `CHANNEL_DELETE` followed by one
`VOICE_STATE_UPDATE` per evicted user. The order matters:
`CHANNEL_DELETE` is the user-visible "this channel is
gone" event; voice-state broadcasts are housekeeping that
updates the "in voice" badges on remaining members'
sidebars.

The guild-delete path (`DELETE /guilds/:guildId`) was
already correct via `evictAllVoiceInGuild`; the channel
case was the gap. Stage_participants cleanup is included
in the new helper because nothing else hard-deletes them
on channel teardown (FK cascade is on hard-delete only).

---

## Genuinely still deferred after nineteen rounds

- **Full context-selector migration.** Fix #28 plumbed the
  primitive and migrated the two highest-volume row components
  (`MessageItem`, `MemberList` rows); 80+ other `useAppState()`
  call sites remain. Mechanical work, no design decisions.
- **Actual sharded bus implementation.** See fix #29 and
  `docs/SHARDING.md` — needs a backend choice from the operator.
- **Password reset flow.** `routes/auth.ts` has no `forgot-password`
  endpoint and no SMTP integration anywhere in the codebase. This
  is a feature gap, not a bug — a user who forgets their password
  and doesn't have admin SQL access can't recover their account.
  Adding this needs an SMTP config story plus a reset-token table
  with single-use semantics; out of scope for a bug-fix audit.
- **Audit log for instance-wide admin actions.** Guild-level
  moderation goes through `writeAudit`, but admin bans/promotions
  in `routes/admin.ts` don't write anywhere. Same shape of feature
  gap — needs an `instance_audit_log` table, a list endpoint, and
  UI. Not strictly a bug since there's no expectation in the
  current product that it exists.
- **Webhook token rotation / hide-after-create.** See round-19
  "Concern" above. `MANAGE_WEBHOOKS` is currently a permanent
  impersonation grant because the LIST + PATCH endpoints return
  the bearer token to every caller. Fixing requires UI changes
  + a regenerate-token endpoint; out of scope for a bug-fix
  patch. The DTO doc comment in `apps/api/src/lib/dto.ts`
  documents the risk for the operator.

---

## Not audited

I had budget pressure and was direct with the user: not every file got
the same level of attention. Areas covered well enough to back the
patches above:

- `apps/api/src/auth/*` (tokens, sessions, signup, passwords)
- `apps/api/src/gateway/*` (server, registry, connection, dispatch, bus)
- `apps/api/src/routes/auth.ts`, `messages.ts`, `channels.ts`, `dms.ts`
- `apps/api/src/services/permissions.ts`, `messages.ts`, `dms.ts`,
  `mentions.ts`, `relationships.ts`, `twoFactor.ts`, `invites.ts`,
  `webhooks.ts`, `voice.ts`, `push.ts`
- `packages/shared/src/permissions.ts`
- Migration `0021_user_banned_at.sql` + matching schema changes

Areas not deeply audited (potential bug surface, worth a follow-up
pass):

- The entire web client (59 tsx files, 27 lib files, gateway-event
  reducers in `state/AppState.tsx`)
- `apps/api/src/routes/`: admin, cdn, discovery, emojis, guilds (a
  glance only), invites (only the service), stage, stickers, users,
  voice (only the service), webhooks (route only).
- `apps/api/src/services/`: audit, bans, discovery, embeds, emojis,
  guilds, inactivitySweep, members, notifications, polls, push (skim),
  reactionRoles, reactions, readStates, roles, stage, stickers,
  threads, uploads.
- All migrations 0000–0020 except the one explicitly tied to a code
  change.
- `livekit.yaml`, `Caddyfile`, `docker-compose.yml`.

Things noticed in passing but not fixed (lower priority or out of
scope for this pass):

- Mentions inside fenced code blocks are still parsed. Discord
  excludes them. Cosmetic.
- Refresh-token reuse detection is missing — if a token leaks, both
  the attacker and the legitimate user can rotate it without
  triggering a "this token was already used" alarm. Real but a
  feature, not a bug.
- `executeWebhook` does byte-comparison on the token in the SQL WHERE
  clause. Timing-attack-theoretically vulnerable; practically not on
  a self-hosted server behind a proxy.
- `editMessage` doesn't bump `read_states.mention_count` for users
  newly @mentioned by an edit. Discord deliberately doesn't either —
  documented as expected behavior.

Re-run `pnpm typecheck` across all packages after applying — all
clean.
