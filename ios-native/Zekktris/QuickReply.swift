import Foundation
import UserNotifications
import Intents
import UIKit

/// Sends a reply typed from a notification — the "Reply" action, whether typed
/// on the iPhone keyboard or dictated/scribbled from a paired Apple Watch.
///
/// Deliberately self-contained: iOS may launch the app into the background just
/// to handle the reply, before the normal UI / `Session.bootstrap()` has run.
/// So this restores the access token straight from the Keychain and posts
/// through `APIClient` rather than relying on `AppStore` being set up. The sent
/// message arrives back via the gateway when the app is (or next becomes)
/// running, so there's no optimistic UI to manage here.
enum QuickReply {
    /// Post `text` to `channelId`. For an encrypted conversation the text is
    /// encrypted on-device first with the per-DM key from the Keychain. If that
    /// key isn't present (the conversation is locked on this device) we do NOT
    /// send plaintext into an encrypted channel — we surface a local
    /// notification asking the user to open the app instead.
    static func send(channelId: String, text: String, isE2EE: Bool) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let api = APIClient.shared
        if api.token == nil {
            // Background launch: APIClient wasn't bootstrapped. Session persists
            // the access token under "accessToken"; APIClient refreshes it via
            // the /auth/refresh cookie on a 401, so a slightly stale token here
            // is fine.
            api.token = KeychainStore().get("accessToken")
        }
        guard api.token?.isEmpty == false else {
            await notify(channelId: channelId, "Open Zekktris to reply.")
            return
        }

        var wire = trimmed
        if isE2EE {
            guard let key = e2eeKey(forChannel: channelId) else {
                await notify(channelId: channelId, "Unlock this conversation in Zekktris to reply.")
                return
            }
            guard let enc = E2EE.encrypt(trimmed, key: key) else {
                await notify(channelId: channelId, "Couldn't encrypt your reply.")
                return
            }
            wire = enc
        }

        do {
            _ = try await api.sendMessage(
                channelId: channelId, content: wire, nonce: UUID().uuidString)
        } catch {
            await notify(channelId: channelId, "Couldn't send your reply — tap to open Zekktris.")
        }
    }

    /// Per-DM E2EE key by channel id, without needing the signed-in user id (a
    /// background launch may not have it). Tries the shared app-group keychain
    /// first, then the app's default group, matching the channel suffix of the
    /// `e2ee.<userId>.<channelId>` account. Mirrors the extension's lookup.
    private static func e2eeKey(forChannel channelId: String) -> Data? {
        let suffix = ".\(channelId)"
        for store in [KeychainStore(accessGroup: AppGroupConfig.identifier), KeychainStore()] {
            for (account, b64) in store.allValues(prefix: "e2ee.") where account.hasSuffix(suffix) {
                if let bytes = Data(base64Encoded: b64), bytes.count == E2EE.keyBytes {
                    return bytes
                }
            }
        }
        return nil
    }

    /// The notification reply field gives no success/failure feedback on its
    /// own, so on failure we post a local notification (tapping it opens the
    /// conversation via the normal channelId routing).
    private static func notify(channelId: String, _ body: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Zekktris"
        content.body = body
        content.userInfo = ["channelId": channelId]
        let request = UNNotificationRequest(
            identifier: "reply-failed-\(channelId)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}

// MARK: - Share Suggestions (iOS Direct Share)

/// iOS **Share Suggestions** (a.k.a. Direct Share) — the row of *people* across
/// the top of the system share sheet in every other app. Tapping one is meant to
/// send the shared item straight to that person in this app.
///
/// iOS builds that row out of `INSendMessageIntent` interactions an app donates
/// (SiriKit). This type owns the donation side: one interaction per recent
/// Zekktris conversation, carrying
///
///   • `conversationIdentifier` — the Zekktris **channel id**. This is the hook
///     that lets a suggestion be resolved back to the exact DM: a Share
///     Extension reads `extensionContext.intent` and posts to that channel.
///   • one `INPerson` per recipient whose `personHandle` is `zekktris:<userId>`
///     (`customIdentifier` carries the bare id), so a target survives a display
///     name change and can never be confused with a phone number or an email.
///   • an `INImage` avatar so the person's face renders in the sheet.
///
/// STATUS: **DONATION IS ON** (`donationsEnabled = true`). Read that flag's
/// comment before changing anything here — it is the single switch, and the
/// guards below are written on the assumption that it can be flipped off again.
/// REVOCATION is unconditional either way, deliberately.
///
/// PRIVACY. We donate the *conversation*, never its contents: `content` is
/// always nil, so an E2EE DM would donate byte-for-byte what a plaintext one
/// does and no message text ever reaches the system index. Donations otherwise
/// live in that index until explicitly removed, so a signed-out phone would keep
/// offering the previous account's contacts inside every other app's share
/// sheet. Every removal path is therefore unconditional and stays live with
/// donation disabled — a shipped build that DID donate has already written
/// contacts into users' indexes, and turning donation off removes none of them:
/// `deleteConversation(_:)` runs when a DM is closed locally, when one is
/// deleted REMOTELY (gateway `CHANNEL_DELETE`) and when a user is blocked;
/// `deleteAll()` runs on sign-out, on the next `loadFamily()` that comes back
/// saying supervision has turned DMs off, and once per install via
/// `purgeLegacyDonationsIfNeeded()`.
///
/// Because a donation awaits a network avatar fetch before it writes, it also
/// carries an epoch (see `generation`) so a donation caught in flight by a
/// sign-out drops — or undoes — its result instead of landing afterwards.
///
/// SCOPE / WHY THE FLAG IS OFF. Donating alone powers only Siri and Spotlight
/// suggestions. For a *tapped share-sheet suggestion* to actually hand the
/// payload to Zekktris, the app additionally needs a Share Extension target
/// (`NSExtensionPointIdentifier` = `com.apple.share-services`, with
/// `INSendMessageIntent` listed under `NSExtension > IntentsSupported`). No such
/// target exists in Zekktris.xcodeproj — adding one is a project-file change
/// that needs sign-off. Until it does, donating routes no share anywhere while
/// still publishing contact names and faces to a system-wide index: all of the
/// privacy cost, none of the feature. Everything here is written so that
/// extension can be dropped in without touching this code: it resolves the
/// tapped suggestion with `INSendMessageIntent.conversationIdentifier` (channel
/// id) or, failing that, `userId(fromHandle:)` on a recipient handle.
@MainActor
enum ShareSuggestions {
    /// MASTER SWITCH — donations are OFF, and this is the only thing standing
    /// between the races listed below and a live contact leak.
    ///
    /// WHY OFF: a donation publishes a contact's display name and face into the
    /// system-wide share/Siri/Spotlight index, outside anything Zekktris can
    /// gate, and with no Share Extension target a tapped suggestion cannot route
    /// a share back into Zekktris at all. So the feature currently delivers
    /// nothing a user can see while carrying a contact-leak surface that has
    /// produced a *fresh* privacy defect on each of two consecutive fix rounds.
    ///
    /// THE ONE CONDITION THAT FLIPS IT BACK ON: a Share Extension target exists
    /// in Zekktris.xcodeproj (`com.apple.share-services`, with
    /// `INSendMessageIntent` under `IntentsSupported`). Nothing else qualifies —
    /// not a tidier gate, not a new caller, not "it looks fixed now".
    ///
    /// AND WHEN YOU DO, SOLVE THESE FIRST. All three are still present in the
    /// code below; none is fixed, because the flag is what holds them shut:
    ///
    ///  • NEW-1 (HIGH) — the sign-out latch is re-armable BY A SIGNED-OUT
    ///    SESSION. `AppStore.stop()` calls `deleteAll()` and also sets
    ///    `family = nil`, and `AppStore.shareSuggestionsAllowed` returns TRUE
    ///    when `family` is nil. So a `QuickReply.send()` / donate continuation
    ///    that resumes after logout passes the gate, calls `enable()`, and
    ///    donates a contact's name and face onto a signed-out phone. The gate
    ///    must key off a positively-live session (a non-nil `currentUserId`
    ///    captured at donate time and re-checked at write time), never off the
    ///    absence of a restrictions blob.
    ///
    ///  • NEW-2 — `deleteConversation(_:)` does NOT bump `generation`, so it can
    ///    only delete what has already landed. A donation still parked on its
    ///    avatar fetch when a `CHANNEL_DELETE` / `blockUser` / `closeDM`
    ///    revocation runs writes itself *afterwards*, silently undoing the
    ///    revocation. The single global counter cannot express "this one channel
    ///    died", so this needs per-conversation epochs, or a revoked-channel set
    ///    consulted immediately before `interaction.donate()`.
    ///
    ///  • NEW-3 (REGRESSION) — the caller-side block guard in
    ///    `AppStore.donateShareSuggestion` bails on ANY blocked participant,
    ///    including in a GROUP DM, which `blockUser` deliberately does NOT revoke
    ///    (the group is still a live conversation for everyone else). Net effect
    ///    is worse than no guard: the group's donation can never be refreshed or
    ///    corrected again, so a blocked member's name and face stay frozen in the
    ///    system index permanently. That guard must match `blockUser`'s scope —
    ///    1:1 DMs only.
    static let donationsEnabled = true

    /// Namespace for `INPersonHandle.value`, so a consumer can tell a Zekktris
    /// id apart from a phone number or an email address.
    static let handleScheme = "zekktris"

    /// One donatable recipient of a conversation.
    struct Recipient {
        let id: String
        let name: String
        let avatarURL: URL?
    }

    /// One donatable conversation (a 1:1 or group DM).
    struct Conversation {
        /// Zekktris channel id — donated as the intent's `conversationIdentifier`.
        let channelId: String
        let title: String
        let isGroup: Bool
        let recipients: [Recipient]
    }

    /// `INPersonHandle.value` for a Zekktris user.
    static func handleValue(for userId: String) -> String { "\(handleScheme):\(userId)" }

    /// Inverse of `handleValue(for:)` — the Zekktris user id inside a donated
    /// handle, or nil when the handle isn't one of ours. The Share Extension's
    /// fallback when an intent arrives without a `conversationIdentifier`.
    static func userId(fromHandle value: String) -> String? {
        let prefix = "\(handleScheme):"
        guard value.hasPrefix(prefix) else { return nil }
        let id = String(value.dropFirst(prefix.count))
        return id.isEmpty ? nil : id
    }

    /// Re-donating on every open + every send would hammer the system index for
    /// no gain — iOS only needs a fresh donation to re-rank a conversation. One
    /// per conversation per minute is plenty.
    private static let minInterval: TimeInterval = 60
    private static var lastDonatedAt: [String: Date] = [:]

    /// Downsampled avatar JPEGs keyed by asset URL. CDN assets are
    /// content-addressed, so a changed avatar is a new key (never stale pixels).
    /// Bounded: these are a few KB each and only exist to keep repeat donations
    /// off the network.
    private static var avatarCache: [URL: Data] = [:]
    private static let avatarCacheLimit = 32

    /// PRIVACY LATCH. `deleteAll()` (sign-out, supervision lockout) turns this
    /// off and it stays off until `enable()`. Mirrors Android's
    /// `ShareShortcuts.enabled`.
    ///
    /// NOT SUFFICIENT ON ITS OWN — see NEW-1 above: the caller's "is this a live
    /// session" test currently passes on a signed-out one, so a late
    /// continuation can re-arm this latch after sign-out. `donationsEnabled` is
    /// what actually keeps donations off today.
    private static var enabled = true

    /// Bumped by every `deleteAll()`. A donation captures the value it started
    /// under and throws its result away if the counter has moved by the time it
    /// is ready to write — that is exactly "a sign-out (or a supervision
    /// lockout) happened while I was fetching an avatar". It closes the window
    /// `enabled` alone cannot: if a *different* account signs in mid-flight and
    /// re-arms `enabled`, the epoch still doesn't match.
    private static var generation = 0

    /// Re-arm donations after a `deleteAll()`. The donate path calls this once
    /// the session and the supervision gate both say yes. Inert while
    /// `donationsEnabled` is false — a disabled feature must not be un-latchable
    /// by anything, least of all by the caller NEW-1 says can be signed out.
    static func enable() {
        guard donationsEnabled else { return }
        enabled = true
    }

    /// One-shot cleanup of donations made by EARLIER BUILDS, run from
    /// `AppStore.init()` on every launch.
    ///
    /// Setting `donationsEnabled = false` only stops NEW writes; every contact a
    /// TestFlight build already donated is still sitting in this device's
    /// system share/Siri/Spotlight index and nothing expires it. So the first
    /// launch after this change wipes the lot.
    ///
    /// Idempotent and cheap: a `UserDefaults` bool means the Intents daemon is
    /// touched exactly once per install, and every later launch is a single
    /// synchronous read. Deliberately NOT gated on `donationsEnabled` — if the
    /// flag is ever flipped back on before an install has purged, that install
    /// must still shed its stale entries (a live session simply re-donates on
    /// the next DM open). Bump the key suffix to force a fresh purge.
    static func purgeLegacyDonationsIfNeeded() {
        let key = "zk.shareSuggestions.purged.v1"
        let defaults = UserDefaults.standard
        guard !defaults.bool(forKey: key) else { return }
        defaults.set(true, forKey: key)
        deleteAll()
    }

    /// Donate a DM so iOS can offer it as a share target. Cheap + throttled;
    /// safe to call on every DM open and every send. `force` skips the throttle.
    static func donate(_ conversation: Conversation, force: Bool = false) {
        // HARD OFF, and deliberately the FIRST statement in the only function
        // that can write to the system index — so no gating bug upstream (see
        // NEW-1/2/3 on `donationsEnabled`) can reach a donation by any path.
        guard donationsEnabled else { return }
        guard enabled, !conversation.channelId.isEmpty, !conversation.recipients.isEmpty else { return }
        // A new, deliberate donation supersedes an earlier revocation for this
        // channel (unblocked, or the DM re-opened).
        revoked.remove(conversation.channelId)
        if !force, let last = lastDonatedAt[conversation.channelId],
           Date().timeIntervalSince(last) < minInterval { return }
        lastDonatedAt[conversation.channelId] = Date()
        // Capture the epoch this donation belongs to: `performDonation` awaits a
        // network avatar fetch (with retry), and sign-out can land mid-fetch.
        let epoch = generation
        Task { await performDonation(conversation, epoch: epoch) }
    }

    /// Drop every donation for ONE conversation — the DM was closed/hidden, so
    /// it must stop appearing as a share target. Every interaction we donate
    /// carries the channel id as its `groupIdentifier`, which is what this
    /// deletes by.
    ///
    /// UNCONDITIONAL, and stays that way while `donationsEnabled` is false: this
    /// is a *revocation*, and the entries it revokes were written by builds that
    /// shipped with donation on. See NEW-2 for the race this does not yet close.
    /// Channels whose donation was revoked while one may still be in flight.
    ///
    /// NEW-2 FIX. `generation` is global — it says "the whole session died",
    /// which is right for sign-out but cannot say "this ONE conversation died".
    /// Without this, a `performDonation` parked on the first (uncached) avatar
    /// fetch resumes after `deleteConversation`, passes both generation checks,
    /// and re-donates the contact the user just blocked or whose DM was just
    /// deleted — the exact window you hit by opening a DM and blocking from it.
    private static var revoked: Set<String> = []

    static func deleteConversation(_ channelId: String) {
        guard !channelId.isEmpty else { return }
        lastDonatedAt[channelId] = nil
        revoked.insert(channelId)
        INInteraction.delete(with: channelId, completion: nil)
    }

    /// Wipe every donation this app has made. Sign-out and supervision lockout
    /// both need this: a leftover donation leaks contact names into the share
    /// sheet of a device that is no longer signed in.
    ///
    /// UNCONDITIONAL — it must run with `donationsEnabled` false, because the
    /// donations it removes came from builds where the flag was true. Disabling
    /// donation removes nothing that is already in a user's index; this does.
    static func deleteAll() {
        // Latch OFF and invalidate every in-flight donation FIRST: one of them
        // may be parked on an avatar fetch, moments from writing a contact's
        // name and face into the system index of a device that is signing out.
        enabled = false
        generation &+= 1
        lastDonatedAt.removeAll()
        revoked.removeAll()
        avatarCache.removeAll()
        INInteraction.deleteAll(completion: nil)
    }

    private static func performDonation(_ conversation: Conversation, epoch: Int) async {
        var images: [String: INImage] = [:]
        for recipient in conversation.recipients {
            // Every avatar is a network fetch WITH RETRY, i.e. a long suspension
            // during which `deleteAll()` can run. Bail the moment the session
            // this donation belongs to is gone.
            guard generation == epoch, !revoked.contains(conversation.channelId) else { return }
            if let data = await avatarData(recipient.avatarURL) {
                images[recipient.id] = INImage(imageData: data)
            }
        }

        let persons = conversation.recipients.map { recipient -> INPerson in
            // When a Contacts card has been linked, donate under the name on
            // that CARD. Siri matches a spoken name against the names on our
            // donated conversations, so this — not the instant-message entry —
            // is what makes "message Sam Rivera on Zekktris" resolve when
            // Zekktris knows him as SRivera1337.
            let linkedName = ContactLinks.contactName(forUserId: recipient.id)
            return INPerson(
                personHandle: INPersonHandle(value: handleValue(for: recipient.id), type: .unknown),
                nameComponents: nil,
                displayName: linkedName ?? recipient.name,
                image: images[recipient.id],
                // What ties this conversation to the person's Contacts card, so
                // "message Sam Rivera on Zekktris" resolves. nil until the
                // user links one (Profile → Add to Contacts).
                contactIdentifier: ContactLinks.contactId(forUserId: recipient.id),
                customIdentifier: recipient.id,
            )
        }

        let intent = INSendMessageIntent(
            recipients: persons,
            outgoingMessageType: .outgoingMessageText,
            // CONTENT IS DELIBERATELY NIL. We donate who the conversation is
            // with, never a word of what was said — this is what keeps E2EE and
            // supervised DMs out of the system index.
            content: nil,
            // A group DM is presented by its group name; a 1:1 is presented by
            // its single recipient, so it gets no group name at all.
            speakableGroupName: conversation.isGroup
                ? INSpeakableString(spokenPhrase: conversation.title)
                : nil,
            conversationIdentifier: conversation.channelId,
            serviceName: "Zekktris",
            sender: nil,
            attachments: nil
        )
        // The group name needs its own thumbnail to render a face; a 1:1 already
        // carries the avatar on its INPerson.
        if conversation.isGroup,
           let first = conversation.recipients.first,
           let image = images[first.id] {
            intent.setImage(image, forParameterNamed: \INSendMessageIntent.speakableGroupName)
        }

        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .outgoing
        // ONE live interaction per conversation: a donation with an existing
        // identifier REPLACES the previous one, so reopening a DM re-ranks the
        // suggestion instead of piling duplicate rows into the index.
        interaction.identifier = "zk.dm.\(conversation.channelId)"
        // Deleted wholesale by `deleteConversation(_:)`.
        interaction.groupIdentifier = conversation.channelId
        // Last look before the write.
        guard generation == epoch, !revoked.contains(conversation.channelId) else { return }
        // Best-effort: a rejected donation only costs us a share suggestion, and
        // there is nothing useful to tell the user about it.
        try? await interaction.donate()
        // Backstop for the final sliver of the race: `donate()` itself suspends,
        // so a sign-out can land between the check above and the write landing.
        // Undo it — the asymmetry is deliberate. Losing a donation on a live
        // session is cosmetic; keeping one on a signed-out session leaks a
        // contact's name and face into every other app's share sheet, where
        // nothing removes it until some later sign-out.
        if generation != epoch || revoked.contains(conversation.channelId) {
            INInteraction.delete(with: conversation.channelId, completion: nil)
        }
    }

    /// Avatar bytes for a donation: fetched once, downsampled hard. The share
    /// sheet draws these at thumbnail size, and the payload is copied into the
    /// system index — shipping a multi-hundred-KB original would be wasteful and
    /// can get the donation dropped.
    private static func avatarData(_ url: URL?) async -> Data? {
        guard let url else { return nil }
        if let cached = avatarCache[url] { return cached }
        guard let raw = await RetryingImage.loadData(url, attempts: 2) else { return nil }
        // Decode + re-encode off the main actor (same reasoning as the message
        // image path: a bare UIImage(data:) defers the decode to draw time).
        let small: Data? = await Task.detached(priority: .utility) {
            ImageDownsampler.decode(raw, maxPixels: 128)?.jpegData(compressionQuality: 0.8)
        }.value
        guard let small else { return nil }
        if avatarCache.count >= avatarCacheLimit { avatarCache.removeAll() }
        avatarCache[url] = small
        return small
    }
}
