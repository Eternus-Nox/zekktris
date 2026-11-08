import Foundation
import UIKit

// Models mirror the server's DTO shapes (see packages/client/src/types.ts).
// The API serializes camelCase JSON, so we rely on Codable's default key
// mapping (NO snake_case conversion). We intentionally model only the fields
// stage 1 needs — Codable ignores any extra JSON keys, and every
// possibly-absent field is optional so decoding stays resilient as the
// payloads evolve.

struct PublicUser: Codable, Identifiable, Hashable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var bannerUrl: String?
    var status: String?
    var isBot: Bool?
    var bio: String?
    var customStatus: String?
    var customStatusEmoji: String?
    /// ISO-8601 auto-clear time. A past timestamp means "no status" — the
    /// server doesn't clear it, so clients must (mirrors web formatCustomStatus).
    var customStatusExpiresAt: String?
    var avatarDecoration: String?
    /// Whether the current viewer may DM / ring this user under the target's
    /// privacy policy. Only populated by the single-profile fetch
    /// (GET /users/:id); nil on list-derived users. The profile card uses it
    /// to gate the Message + Call buttons (mirrors web).
    var canMessage: Bool?
    /// Custom name tag ("clan tag") rendered IN FRONT of the name — label-only
    /// (≤4 chars). Renders only when a label is set. tagColor is a #rrggbb hex
    /// (clients fall back to the accent when nil).
    var tagLabel: String?
    var tagColor: String?
    /// Perk tier title ("scout" | "guardian" | "legend"). Only populated
    /// by the single-profile fetch; nil when no membership or opted out.
    var subscriptionTier: String?
    /// Instance staff role. Present (true) only for administrators/moderators —
    /// regular members omit both. Drives the subtle staff badge next to the
    /// name. Admin takes precedence when both are set.
    var isAdmin: Bool?
    var isModerator: Bool?
    /// Staff-only display-name shimmer color (#rrggbb). Present only for
    /// admins/moderators who turned it on; when set it OVERRIDES any role
    /// color and marks the name with an animated shimmer instead of a badge.
    var staffColor: String?
    /// Optional soft glow layered on the shimmer (only when staffColor is set).
    var staffGlow: Bool?
    /// "Last online" instant (ISO-8601), or nil. Populated ONLY by
    /// GET /users/@me/relationships and only for rows of type "friend" —
    /// every other surface (member lists, message authors, GET /users/:id)
    /// omits it. Meaningless while the friend reads as online; render it
    /// only under an away/dnd/offline friend. Invisible users freeze this
    /// server-side at their last visible moment, so it never leaks presence.
    var lastSeenAt: String?

    /// Best display label with sensible fallbacks.
    var name: String { displayName ?? username ?? "Unknown" }
}

struct PublicUserWrap: Codable { let user: PublicUser }

/// A bot account owned by the current user. Like a PublicUser but with the
/// owner id. Bots authenticate via a static token that the server returns only
/// at create/regenerate — it is never present on this DTO.
struct Bot: Codable, Identifiable, Hashable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var isBot: Bool?
    /// Configured event callback URL, or nil if the bot has no subscription.
    /// The signing secret is never included here.
    var botEventUrl: String?

    var name: String { displayName ?? username ?? "Bot" }
}

/// A slash-command registered on a bot (owner view).
struct BotCommand: Codable, Identifiable, Hashable {
    let id: String
    var botId: String
    /// nil = global; otherwise scoped to this guild.
    var guildId: String?
    var name: String
    var description: String
    var createdAt: String?
}

struct BotListWrap: Codable { let bots: [Bot] }
struct BotWrap: Codable { let bot: Bot }
/// Create-bot response: the bot plus its one-time plaintext token.
struct BotCreateResponse: Codable { let bot: Bot; let token: String }
/// Regenerate-token response: just the new one-time plaintext token.
struct BotTokenResponse: Codable { let token: String }
/// Event-config response: the callback URL plus the (one-time-ish) signing secret.
struct BotEventConfigResponse: Codable { let eventUrl: String?; let secret: String? }

struct SelfUser: Codable, Identifiable, Hashable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var bannerUrl: String?
    var bio: String?
    var email: String?
    /// The status the user PICKED. A server with multi-device presence (READY
    /// `features.presence_activity`) sends the same value as `chosenStatus`
    /// here (except during an older app's automatic away: "idle" here,
    /// "online" there), the meaning older builds of this app read it with; an older
    /// server's status is the choice as well. Read the pick as
    /// `chosenStatus ?? status` (DevicePresence.pickerStatus) and the own dot
    /// from `effectiveStatus ?? status` (DevicePresence.selfStatus).
    var status: String?
    /// The status the user PICKED (online / idle = "Away" / dnd / invisible):
    /// what the status picker shows and sets (PATCH /users/@me {status}).
    /// nil from older servers, where `status` is the choice. Never "offline".
    var chosenStatus: String?
    /// EFFECTIVE presence, from a server with multi-device presence: derived
    /// from `chosenStatus` and the activity of every connected device, and
    /// unmasked ("invisible" stays "invisible" here). The own dot until our
    /// first own PRESENCE_UPDATE arrives (those frames then keep it current).
    /// nil from older servers.
    var effectiveStatus: String?
    var customStatus: String?
    var customStatusEmoji: String?
    /** ISO-8601 instant the custom status auto-clears, or nil for no expiry. */
    var customStatusExpiresAt: String?
    var isAdmin: Bool?
    /// Instance moderator — restricted staff subset of the admin panel.
    var isModerator: Bool?
    var avatarDecoration: String?
    var guildFolders: [GuildFolder]?
    /// Achievements-on-profile visibility. Carried on the self user so the
    /// Settings toggle reads/writes it through the same durable, launch-
    /// hydrated path as every other profile setting.
    var achievementsPublic: Bool?
    /// Account-level toggle for achievement-unlock notifications (push + in-app).
    /// nil is treated as the server default `true`.
    var notifyAchievements: Bool?
    /// Per-user DM read-receipts preference (mirrors web SelfUser.dmReadReceiptsEnabled).
    /// Optional for back-compat with sessions hydrated before the column existed;
    /// nil is treated as the server default `true`.
    var dmReadReceiptsEnabled: Bool?
    /// Custom name tag ("clan tag") — carried on the self user so the
    /// Appearance editor pre-fills and survives relaunch. See PublicUser.
    var tagLabel: String?
    var tagColor: String?
    /// Staff-only display-name shimmer color (#rrggbb) — carried on the self
    /// user so the Appearance editor pre-fills and it survives relaunch. Only
    /// meaningful for admins/moderators; overrides role colors. See PublicUser.
    var staffColor: String?
    /// Optional soft glow layered on the shimmer (carried on self for the toggle).
    var staffGlow: Bool?
    /// Date of birth (YYYY-MM-DD), or nil for a legacy account that never set
    /// one. `canChangeDob` is true while the user may still change it (drives
    /// the one-time "confirm your date of birth" banner). Both optional for
    /// back-compat with sessions hydrated before the columns existed.
    var dateOfBirth: String?
    var canChangeDob: Bool?
    /// Effective perk tier ("scout" | "guardian" | "legend"; own or inherited
    /// from a supervising parent). nil = none → base perks.
    /// showSubscriptionTier drives the profile-title opt-out toggle.
    var subscriptionTier: String?
    var subscriptionExpiresAt: String?
    var subscriptionInherited: Bool?
    /// "gift" (admin-given) | "founder" (grandfathered).
    var subscriptionSource: String?
    /// False for founder (grandfathered) memberships — perks without a title.
    var subscriptionTitled: Bool?
    var showSubscriptionTier: Bool?

    var name: String { displayName ?? username ?? "You" }
}

struct Guild: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var iconUrl: String?
    var bannerUrl: String?
    var ownerId: String?
    var description: String?
    var rulesContent: String?
    /// Server discovery opt-in state (Guild Settings → Discovery).
    var discoverable: Bool?
    var discoveryDescription: String?
    var discoveryCategory: String?
}

struct GuildFolder: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var color: String?
    var guildIds: [String]
}
struct GuildFoldersWrap: Codable { let folders: [GuildFolder] }

struct Channel: Codable, Identifiable, Hashable {
    let id: String
    var type: String?
    var guildId: String?
    var parentId: String?
    var name: String?
    var topic: String?
    var position: Int?
    var rateLimitPerUser: Int?
    var lastMessageId: String?
    /// Thread fields (type == public_thread).
    var threadArchivedAt: String?
    /// DM / group-DM only: the OTHER recipients (excludes the current user).
    var recipients: [PublicUser]?
    /// Shared-key E2EE state for 1:1 DMs.
    var e2eeEnabled: Bool?
    var e2eeSalt: String?
    var e2eeVerifier: String?
    /// Whether the server holds a purge-proof hash for this DM (the hash is
    /// never sent). `false` on an encrypted DM: register ours once we hold
    /// the key (AppStore.registerE2EEPurgeProofIfNeeded). nil on older servers.
    var e2eePurgeProofSet: Bool?
    /// True when the server reports this DM as unencrypted only because the
    /// pair is supervised: nothing was disabled or purged, so the key stays.
    /// nil otherwise, and on older servers.
    var e2eeSuppressed: Bool?
    /// Link channels (type == guild_link): the external URL they open.
    var linkUrl: String?
    /// True when permission overrides hide this channel from @everyone —
    /// drives the corner padlock badge on the sidebar row (web parity).
    var restricted: Bool?
    /// 1:1 DM messaging streak (consecutive days both sides messaged).
    /// Absent/0 while broken; capped at 10,000.
    var streak: Int?

    var isText: Bool { type == "guild_text" }
    var isCategory: Bool { type == "guild_category" }
    var isVoice: Bool { type == "guild_voice" || type == "guild_stage" }
    var isStage: Bool { type == "guild_stage" }
    var isForum: Bool { type == "guild_forum" }
    var isLink: Bool { type == "guild_link" }
    var isThread: Bool { type == "public_thread" }
    var isArchived: Bool { threadArchivedAt != nil }
    var isDM: Bool { type == "dm" || type == "group_dm" }
    var isE2EE: Bool { e2eeEnabled == true }

    /// Display title for a DM: explicit name, else the recipients joined,
    /// else a sensible fallback.
    var dmTitle: String {
        if let name, !name.isEmpty { return name }
        let names = (recipients ?? []).map { $0.name }
        if names.isEmpty { return "Direct Message" }
        return names.joined(separator: ", ")
    }

    /// The recipient whose avatar represents a 1:1 DM (first listed).
    var dmAvatarUser: PublicUser? { recipients?.first }
}

struct Message: Codable, Identifiable, Hashable {
    let id: String
    let channelId: String
    let createdAt: String
    var authorId: String?
    var author: PublicUser?
    var type: String?
    var content: String?
    var editedAt: String?
    var nonce: String?
    var reactions: [ReactionAggregate]?
    var attachments: [Attachment]?
    var poll: Poll?
    var replyToId: String?
    var pinned: Bool?
    var forwardedFromMessageId: String?
    var forwardedFrom: ForwardSource?
    var stickerId: String?
    var sticker: Sticker?
    var embeds: [MessageEmbed]?
    /// Webhook-posted messages: the webhook's id plus the persona the
    /// renderer should show IN PLACE of the author's user record.
    var webhookId: String?
    var authorOverrideName: String?
    var authorOverrideAvatar: String?
    /// Structured payload for system messages (system_call carries
    /// { kind: "call", missed, durationMs, initiatorId }).
    var metadata: MessageMetadata?
    /// 1:1 DM read receipts: set when a recipient's device received /
    /// viewed the message (drives the Sent → Delivered → Read label).
    var deliveredAt: String?
    var viewedAt: String?
    /// Disappearing messages: the timer (seconds) this message was SENT with,
    /// nil when it never disappears. Fixed at send time, so changing the DM's
    /// setting only affects later messages. A JSON integer (or null).
    var expireAfterSeconds: Int?
    /// Disappearing messages: when it disappears (ISO server time), once a
    /// recipient has read it. REST responses only, and hidden from the author
    /// when the reader has read receipts off; the live value arrives in
    /// MESSAGE_EXPIRY. AppStore keeps the deadlines in its own map, so a DTO
    /// without this field never wipes a known one.
    var expiresAt: String?
    /// Client-only send state for optimistic messages: "sending" | "failed" |
    /// nil (a normal/confirmed message). Absent from server JSON, so it decodes
    /// as nil and (being optional) is omitted when encoded.
    var sendState: String?

    var text: String { content ?? "" }
}

struct MessageMetadata: Codable, Hashable {
    var kind: String?
    var missed: Bool?
    var durationMs: Int?
    var initiatorId: String?
    /// kind == "streak_warning": the streak day count at warning time.
    var streak: Int?
    /// kind == "poke": which variant (poke|heart|wave|like|fire).
    var pokeType: String?
    /// kind == "disappearing_timer" (type "system_disappearing"): the DM's new
    /// disappearing-messages timer in seconds, 0 = turned off. initiatorId is
    /// who changed it. A NEW key on purpose: reusing an existing one with a
    /// different JSON type would fail the whole page decode on older builds.
    var timerSeconds: Int?
}

/// Poke/nudge variants — emoji + verb. Mirror of the server POKE_VARIANTS
/// (@zekktris/db) and the web table; keep all three in sync.
enum PokeVariant: String, CaseIterable, Identifiable {
    case poke, heart, wave, like, fire
    var id: String { rawValue }
    var emoji: String {
        switch self {
        case .poke: return "👉"
        case .heart: return "❤️"
        case .wave: return "👋"
        case .like: return "👍"
        case .fire: return "🔥"
        }
    }
    /// Verb shown to the RECIPIENT ("Alice 👉 poked you").
    var verb: String {
        switch self {
        case .poke: return "poked you"
        case .heart: return "sent you a heart"
        case .wave: return "waved at you"
        case .like: return "liked you"
        case .fire: return "sent you fire"
        }
    }
    /// Verb shown to the SENDER on their own poke ("You 👉 poked them").
    var sentVerb: String {
        switch self {
        case .poke: return "poked them"
        case .heart: return "sent a heart"
        case .wave: return "waved"
        case .like: return "liked them"
        case .fire: return "sent fire"
        }
    }
    /// Short menu label for the send palette.
    var label: String {
        switch self {
        case .poke: return "Poke"
        case .heart: return "Heart"
        case .wave: return "Wave"
        case .like: return "Like"
        case .fire: return "Fire"
        }
    }
}

/// One entry of a DM's poke history (newest-first, capped at 6), from
/// GET /channels/:id/pokes. Feeds the poke button's history popover.
struct PokeHistoryEntry: Decodable, Identifiable {
    let id: String
    let pokeType: String
    let initiatorId: String
    let recipientId: String
    let createdAt: String
    let initiatorName: String
    /// The matching variant (falls back to .poke for an unknown type).
    var variant: PokeVariant { PokeVariant(rawValue: pokeType) ?? .poke }
}

extension Message {
    /// Build a client-side optimistic placeholder shown immediately on send,
    /// before the server confirms. Its `id` is the send nonce so the confirmed
    /// message (which echoes the same nonce) can replace it in place.
    init(optimisticNonce nonce: String, channelId: String, content: String,
         author: PublicUser?, authorId: String?, replyToId: String?, createdAt: String) {
        self.init(
            id: nonce, channelId: channelId, createdAt: createdAt,
            authorId: authorId, author: author, type: "default",
            content: content, editedAt: nil, nonce: nonce,
            reactions: nil, attachments: nil, poll: nil,
            replyToId: replyToId, pinned: nil, forwardedFromMessageId: nil,
            forwardedFrom: nil, stickerId: nil, sticker: nil, embeds: nil,
            webhookId: nil, authorOverrideName: nil, authorOverrideAvatar: nil,
            metadata: nil,
            deliveredAt: nil, viewedAt: nil,
            expireAfterSeconds: nil, expiresAt: nil,
            sendState: "sending"
        )
    }
}

/// Signal-style disappearing messages: the timer presets and their labels,
/// the Custom Time picker's number + unit math and the in-chat notice text.
/// Pure Foundation, no store or view state. The wording matches the web
/// (apps/web/src/lib/disappearing.ts) and the server's fallback notice text
/// (apps/api/src/lib/disappearing.ts) word for word; keep them in sync.
enum DisappearingTimer {
    /// The description on the Disappearing Messages screen (Signal's copy).
    static let screenDescription =
        "When enabled, new messages sent and received in this chat will disappear after they have been seen."

    /// The fixed choices, longest first (Signal's order). Off is separate.
    static let presets: [Int] = [2_419_200, 604_800, 86_400, 28_800, 3_600, 300, 30]

    /// A value is a preset only if it equals one of the seven; anything else
    /// (60, 120, 90, 259200 …) is Custom.
    static func isPreset(_ seconds: Int?) -> Bool {
        guard let seconds else { return false }
        return presets.contains(seconds)
    }

    /// The timers the server accepts: 1 s up to its `maxTtlSeconds` (4 weeks
    /// today), or an older server's 10 s ... 1 day when it reports none.
    static func bounds(maxTtlSeconds: Int?) -> ClosedRange<Int> {
        if let maxTtlSeconds, maxTtlSeconds >= 1 { return 1...maxTtlSeconds }
        return 10...86_400
    }

    // MARK: Labels

    private struct Part {
        let seconds: Int
        let singular: String
        let plural: String
        let short: String
    }

    private static let parts: [Part] = [
        Part(seconds: 604_800, singular: "week", plural: "weeks", short: "w"),
        Part(seconds: 86_400, singular: "day", plural: "days", short: "d"),
        Part(seconds: 3_600, singular: "hour", plural: "hours", short: "h"),
        Part(seconds: 60, singular: "minute", plural: "minutes", short: "m"),
        Part(seconds: 1, singular: "second", plural: "seconds", short: "s")
    ]

    /// Every non-zero week / day / hour / minute / second count, largest first.
    private static func decompose(_ seconds: Int) -> [(count: Int, part: Part)] {
        var rest = max(0, seconds)
        var out: [(count: Int, part: Part)] = []
        for p in parts {
            let n = rest / p.seconds
            if n > 0 {
                out.append((count: n, part: p))
                rest -= n * p.seconds
            }
        }
        return out
    }

    /// "4 weeks", "1 day", "1 minute 30 seconds", "1 second".
    static func longLabel(_ seconds: Int) -> String {
        var words: [String] = []
        for piece in decompose(seconds) {
            let unit = piece.count == 1 ? piece.part.singular : piece.part.plural
            words.append("\(piece.count) \(unit)")
        }
        return words.isEmpty ? "0 seconds" : words.joined(separator: " ")
    }

    /// The header form: "4w", "1d", "8h", "1m 30s".
    static func shortLabel(_ seconds: Int) -> String {
        var words: [String] = []
        for piece in decompose(seconds) {
            words.append("\(piece.count)\(piece.part.short)")
        }
        return words.isEmpty ? "0s" : words.joined(separator: " ")
    }

    /// A DM setting as a label: "Off" for nil (or non-positive), else the
    /// long form.
    static func label(_ value: Int?) -> String {
        guard let value, value > 0 else { return "Off" }
        return longLabel(value)
    }

    // MARK: Custom Time picker

    /// The picker's unit column, smallest first.
    enum Unit: Int, CaseIterable {
        case seconds, minutes, hours, days, weeks

        var secondsPerUnit: Int {
            switch self {
            case .seconds: return 1
            case .minutes: return 60
            case .hours: return 3_600
            case .days: return 86_400
            case .weeks: return 604_800
            }
        }

        /// The largest count the picker offers in this unit.
        var maxCount: Int {
            switch self {
            case .seconds: return 59
            case .minutes: return 59
            case .hours: return 23
            case .days: return 6
            case .weeks: return 4
            }
        }

        var label: String {
            switch self {
            case .seconds: return "seconds"
            case .minutes: return "minutes"
            case .hours: return "hours"
            case .days: return "days"
            case .weeks: return "weeks"
            }
        }
    }

    /// A Custom Time value: `count` × `unit`.
    struct Custom: Equatable {
        var count: Int
        var unit: Unit
        var seconds: Int { count * unit.secondsPerUnit }
    }

    /// The counts the picker offers for `unit`, narrowed to what the server
    /// accepts; nil when no count of that unit fits.
    static func counts(for unit: Unit, bounds: ClosedRange<Int>) -> ClosedRange<Int>? {
        let size = unit.secondsPerUnit
        let lo = max(1, (bounds.lowerBound + size - 1) / size)
        let hi = min(unit.maxCount, bounds.upperBound / size)
        return lo <= hi ? lo...hi : nil
    }

    /// The units with at least one count the server accepts, smallest first.
    static func units(within bounds: ClosedRange<Int>) -> [Unit] {
        Unit.allCases.filter { counts(for: $0, bounds: bounds) != nil }
    }

    /// Keep a picker value inside the bounds: a unit with no valid count
    /// moves to the nearest one that has some, then the count is clamped.
    private static func fit(_ value: Custom, bounds: ClosedRange<Int>) -> Custom {
        let available = units(within: bounds)
        guard let smallest = available.first, let largest = available.last else { return value }
        var unit = value.unit
        if !available.contains(unit) {
            unit = unit.secondsPerUnit > bounds.upperBound ? largest : smallest
        }
        guard let range = counts(for: unit, bounds: bounds) else { return value }
        return Custom(count: min(max(value.count, range.lowerBound), range.upperBound), unit: unit)
    }

    /// Switching the unit keeps the count, clamped to the new unit's range
    /// (45 minutes → hours gives 23 hours).
    static func changeUnit(_ value: Custom, to unit: Unit, bounds: ClosedRange<Int>) -> Custom {
        fit(Custom(count: value.count, unit: unit), bounds: bounds)
    }

    /// The Custom Time picker's starting value for the current setting:
    /// exactly n × one unit with n inside that unit's range → that;
    /// otherwise the largest unit u with value ≥ u and n = clamp(value / u,
    /// 1, max(u)) — 90 s → 1 minute, 10 days → 1 week; no value → 1 day.
    /// The unit ranges don't overlap, so the exact match is unique.
    static func customInitial(_ value: Int?, bounds: ClosedRange<Int>) -> Custom {
        guard let value, value >= 1 else {
            return fit(Custom(count: 1, unit: .days), bounds: bounds)
        }
        let largestFirst = Array(Unit.allCases.reversed())
        for unit in largestFirst where value % unit.secondsPerUnit == 0 {
            let n = value / unit.secondsPerUnit
            if n >= 1 && n <= unit.maxCount {
                return fit(Custom(count: n, unit: unit), bounds: bounds)
            }
        }
        for unit in largestFirst where value >= unit.secondsPerUnit {
            let n = min(max(value / unit.secondsPerUnit, 1), unit.maxCount)
            return fit(Custom(count: n, unit: unit), bounds: bounds)
        }
        return fit(Custom(count: 1, unit: .seconds), bounds: bounds)
    }

    // MARK: The in-chat notice

    /// "You set disappearing messages to 1 day." / "Alex turned off
    /// disappearing messages." `timerSeconds` 0 (or less) means off.
    static func noticeText(timerSeconds: Int, isSelf: Bool, name: String) -> String {
        let who = isSelf ? "You" : name
        if timerSeconds > 0 {
            return "\(who) set disappearing messages to \(longLabel(timerSeconds))."
        }
        return "\(who) turned off disappearing messages."
    }

    /// The timer-change notice row: type "system_disappearing", or
    /// (defensively) any row carrying the "disappearing_timer" metadata.
    static func isNotice(_ m: Message) -> Bool {
        m.type == "system_disappearing" || m.metadata?.kind == "disappearing_timer"
    }
}

struct EmbedField: Codable, Hashable {
    var name: String
    var value: String
    var inline: Bool?
}

struct MessageEmbed: Codable, Hashable {
    var url: String
    var kind: String?
    var title: String?
    var description: String?
    var imageUrl: String?
    var siteName: String?
    var faviconUrl: String?
    // Rich (Discord-style webhook) embed fields. Null for link/image previews.
    var color: Int?
    var authorName: String?
    var authorIconUrl: String?
    var thumbnailUrl: String?
    var fields: [EmbedField]?
    var footerText: String?
    var footerIconUrl: String?
    var timestamp: String?
}

/// Response of GET /unfurl?url= — a single client-resolved link preview (or
/// null when it couldn't be resolved). Used to show previews for E2EE messages,
/// which the server can't unfurl (it only holds ciphertext).
struct UnfurlWrap: Codable { let embed: MessageEmbed? }

struct Sticker: Codable, Identifiable, Hashable {
    let id: String
    var guildId: String?
    var name: String
    var description: String?
    var url: String
    var animated: Bool?
}
struct StickersWrap: Codable { let stickers: [Sticker] }
struct StickerWrap: Codable { let sticker: Sticker }

struct GuildEmoji: Codable, Identifiable, Hashable {
    let id: String
    var guildId: String?
    var name: String
    var url: String
    var animated: Bool?
}
struct EmojisWrap: Codable { let emojis: [GuildEmoji] }
struct EmojiWrap: Codable { let emoji: GuildEmoji }

struct Webhook: Codable, Identifiable {
    let id: String
    var channelId: String?
    var guildId: String?
    var name: String
    var avatarUrl: String?
    var token: String
    var createdAt: String?
}
struct WebhooksWrap: Codable { let webhooks: [Webhook] }
struct WebhookWrap: Codable { let webhook: Webhook }

struct ScheduledMessage: Codable, Identifiable {
    let id: String
    var channelId: String?
    var content: String?
    var scheduledFor: String
    var attempts: Int?
    var lastError: String?
}
struct ScheduledListWrap: Codable { let items: [ScheduledMessage] }
struct ScheduledWrap: Codable { let scheduled: ScheduledMessage }

struct PermissionOverride: Codable, Identifiable {
    var channelId: String?
    var targetType: String
    var targetId: String
    var allow: String
    var deny: String
    var id: String { targetId }
}
struct OverridesWrap: Codable { let overrides: [PermissionOverride] }

struct ReactionRoleMapping: Codable, Identifiable {
    var messageId: String
    var emoji: String
    var channelId: String
    var roleId: String
    var id: String { "\(messageId):\(emoji)" }
}
struct ReactionRolesWrap: Codable { let items: [ReactionRoleMapping] }

struct EventRsvpCounts: Codable { var going: Int; var maybe: Int; var declined: Int }
struct ScheduledEvent: Codable, Identifiable {
    let id: String
    var guildId: String?
    var name: String
    var description: String?
    var startAt: String
    var endAt: String?
    var locationKind: String          // "voice_channel" | "external"
    var locationChannelId: String?
    var locationText: String?
    var status: String                // "scheduled" | "active" | "completed" | "canceled"
    var imageUrl: String?
    var rsvpCounts: EventRsvpCounts?
    var myRsvp: String?
}
struct EventsWrap: Codable { let events: [ScheduledEvent] }
struct EventWrap: Codable { let event: ScheduledEvent }

struct EventRsvp: Codable, Identifiable {
    var eventId: String?
    var user: PublicUser
    var status: String
    var id: String { user.id }
}
struct AttendeesWrap: Codable { let attendees: [EventRsvp] }
struct MyEvent: Codable, Identifiable {
    var event: ScheduledEvent
    var guildName: String?
    var guildIconUrl: String?
    var id: String { event.id }
}
struct MyEventsWrap: Codable { let events: [MyEvent] }

struct DmSettings: Codable {
    /// The DM's disappearing-messages timer for NEW messages (seconds), nil =
    /// off. The key predates the Signal-style timer and stays for old builds.
    let ttlSecondsAfterRead: Int?
    /// This user's notification-preview choice for the DM. nil = not set
    /// (use the E2EE-aware default).
    var notificationShowContent: Bool?
    /// The longest timer the server accepts (2419200 = 4 weeks; the shortest
    /// is 1 s). Absent (nil) on older servers, which accept only 10...86400.
    var maxTtlSeconds: Int?
}

struct StorageItem: Codable, Identifiable {
    let id: String
    var filename: String?
    var format: String?
    var compressed: Bool?
    var category: String
    var sizeBytes: Int
    var referenced: Bool
    var guildId: String?
}
struct StorageListing: Codable {
    let items: [StorageItem]
    var total: Int?
}

struct StageParticipant: Codable, Identifiable {
    var channelId: String?
    var userId: String
    var isSpeaker: Bool
    var handRaised: Bool
    var id: String { userId }
}
struct StageJoinResult: Codable { let participant: StageParticipant; let token: String?; let wsUrl: String? }
struct StageParticipantsResult: Codable { let channel: Channel; let participants: [StageParticipant] }

struct ForwardSource: Codable, Hashable {
    var messageId: String
    var channel: ForwardChannel?
    var author: PublicUser?
    var content: String
}
struct ForwardChannel: Codable, Hashable {
    var id: String
    var name: String?
    var type: String?
}

struct ReactionAggregate: Codable, Hashable {
    var emoji: String
    var count: Int
    var me: Bool
}

struct Attachment: Codable, Identifiable, Hashable {
    let id: String
    var url: String
    var filename: String?
    var contentType: String?
    var size: Int?
    var width: Int?
    var height: Int?
    var isVoiceMessage: Bool?
    var durationSeconds: Int?
    var waveform: String?
    /// Inline preview thumbnail URL (its own attachment). nil = load full inline.
    var thumbnailUrl: String?
    /// ISO-8601 timestamp of when media retention aged out the FULL-SIZE object,
    /// or nil while the original is still stored (the normal case). Defaulted so
    /// payloads from before blob expiry shipped still decode.
    ///
    /// Non-nil means `url` no longer resolves — never fetch, open, play, save or
    /// share it. Everything the expired state needs survives: `thumbnailUrl`
    /// (kept forever, and only ever expired when a thumbnail exists) plus
    /// filename/size/width/height. The server deliberately keeps `url`
    /// populated (it is non-optional in every shipped client), so gate on THIS
    /// field — never on a missing or empty url.
    var blobExpiredAt: String?

    var isImage: Bool { (contentType ?? "").hasPrefix("image/") }
    var isVideo: Bool { (contentType ?? "").hasPrefix("video/") }
    /// The server no longer stores the full-size original: render from the
    /// thumbnail and keep every full-size path (lightbox, player, save, share)
    /// shut.
    var blobExpired: Bool { blobExpiredAt != nil }
}

struct PollOption: Codable, Identifiable, Hashable {
    var id: String
    var text: String
    var position: Int
    var voteCount: Int
}

struct Poll: Codable, Hashable {
    var id: String
    var question: String
    var multipleChoice: Bool
    var options: [PollOption]
    var totalVoters: Int
    var myVotes: [String]
    var expiresAt: String?
    var closedAt: String?

    // Hoisted: isExpired runs on every poll-row render, and an
    // ISO8601DateFormatter allocation is one of the more expensive Foundation
    // constructions — two per call here added measurable scroll cost.
    // ISO8601DateFormatter is documented thread-safe.
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let iso = ISO8601DateFormatter()

    var isExpired: Bool {
        guard let expiresAt else { return false }
        if let d = Self.isoFractional.date(from: expiresAt) { return d <= Date() }
        if let d = Self.iso.date(from: expiresAt) { return d <= Date() }
        return false
    }
    var isOpen: Bool { closedAt == nil && !isExpired }
}

struct VoiceState: Codable, Identifiable, Hashable {
    var userId: String
    var channelId: String?
    var guildId: String?
    var sessionId: String?
    var selfMute: Bool?
    var selfDeaf: Bool?
    /// Set only on a server-initiated move (moderator move, AFK sweep), so the
    /// client can tell it from one of our other devices joining elsewhere.
    var moved: Bool?

    var id: String { userId }
    var isMuted: Bool { selfMute == true }
}

struct AuthSession: Codable {
    let user: SelfUser
    let accessToken: String
}

/// A short-lived, single-use quick-login code for signing in on another
/// device (shown as digits + encoded in a QR). `expiresIn` is seconds.
///
/// DEPRECATED direction — the signed-in device minted the code and the code
/// WAS the whole credential, so anyone who read it off the screen owned the
/// account. Replaced by the device-approval flow below. Delete alongside the
/// `/auth/quick-login/*` routes (checklist: apps/api/src/routes/auth.ts:415).
struct QuickLoginCode: Codable {
    let code: String
    let expiresIn: Int
}

// ── Device-approval login ("approve this sign-in on your phone") ────────────
// The INVERTED quick-login, and the OAuth 2.0 Device Authorization Grant
// (RFC 8628) shape: the LOGGED-OUT device starts a request and displays a
// short code; the already signed-in phone scans/types it, is shown what it is
// about to approve, and approves. Nothing on the new device's screen is enough
// to take over the account.
//
// TWO SECRETS, NOT INTERCHANGEABLE (server rationale:
// apps/api/src/auth/device-login-store.ts — read it before changing this):
//   userCode    SHORT. Printed on the new device and encoded in its QR, so
//               assume every shoulder-surfer in the room has it. It can only
//               ever be used by an AUTHENTICATED caller to look up and decide
//               a request. Knowing it NEVER yields a session.
//   deviceCode  256-bit. Returned once, to the device that started the
//               request. NEVER render it, never put it in a QR, never log it,
//               never write it to disk. It alone collects the tokens.

/// Result of POST /auth/device-login/start (the logged-out device).
struct DeviceLoginStart: Codable {
    /// Display + QR this. Server sends it pre-formatted `ABCD-EFGH`.
    let userCode: String
    /// SECRET — hold in memory only, for the lifetime of the sheet.
    let deviceCode: String
    /// Seconds until the request expires (server default 300).
    let expiresIn: Int
    /// Minimum seconds between polls. Adopt any larger value the server sends.
    let interval: Int
}

/// Claimed platform of the requesting device. UNTRUSTED — derived from the
/// User-Agent the requesting device wrote about itself.
enum DeviceLoginPlatform: String, Codable, Hashable {
    case ios, android, web, desktop, unknown

    /// Unknown/newer values decode to `.unknown` rather than throwing, so a
    /// server that learns a new platform label never breaks the approval
    /// screen — the one screen that must always render.
    init(from decoder: Decoder) throws {
        let raw = try decoder.singleValueContainer().decode(String.self)
        self = DeviceLoginPlatform(rawValue: raw) ?? .unknown
    }

    var label: String {
        switch self {
        case .ios: return "iPhone or iPad"
        case .android: return "Android"
        case .web: return "Web browser"
        case .desktop: return "Desktop app"
        case .unknown: return "Unknown"
        }
    }

    var symbolName: String {
        switch self {
        case .ios: return "iphone"
        case .android: return "candybarphone"
        case .web: return "globe"
        case .desktop: return "desktopcomputer"
        case .unknown: return "questionmark.square.dashed"
        }
    }
}

/// The device asking to be signed in, as shown on the approval screen.
///
/// THE SPLIT BELOW IS THE WHOLE POINT — render both halves, labelled.
/// `ipAddress` / `sameNetwork` / `requestedAt` are observed by the server and
/// a remote phisher cannot forge them. `declaredName` / `userAgent` /
/// `platform` / `locale` are whatever the requesting device claimed about
/// itself; an attacker will happily call themselves "Your iPhone".
struct DeviceLoginDeviceInfo: Codable, Hashable {
    /// UNTRUSTED, device-supplied label.
    let declaredName: String?
    /// UNTRUSTED, device-supplied User-Agent.
    let userAgent: String?
    /// UNTRUSTED — derived from the User-Agent.
    let platform: DeviceLoginPlatform
    /// UNTRUSTED — from Accept-Language. A locale, NOT a location.
    let locale: String?
    /// Server-observed source IP of the requesting device.
    let ipAddress: String?
    /// Server-observed: the requester shares the approver's /24 (or IPv6 /48).
    /// A hint, not proof — but a remote attacker can never make it true, so a
    /// `false` gets a loud warning on the approval screen.
    let sameNetwork: Bool
    /// ISO-8601.
    let requestedAt: String
    /// Always nil today — the server does no GeoIP and will not guess. The
    /// approval screen shows "Unavailable" rather than pretending.
    let approxLocation: String?
}

/// Result of POST /auth/device-login/lookup (the signed-in phone).
struct DeviceLoginRequestInfo: Codable, Hashable {
    let userCode: String
    /// Seconds left before the request expires.
    let expiresIn: Int
    let device: DeviceLoginDeviceInfo
}

/// Result of POST /auth/device-login/poll. Every case arrives as HTTP 200 —
/// these are states of a polling loop, not errors.
enum DeviceLoginPoll: Decodable {
    /// Keep polling, no faster than `interval`.
    case pending(interval: Int)
    /// Polled too fast — adopt the (larger) `interval`.
    case slowDown(interval: Int)
    /// The user refused on their phone. Terminal.
    case denied
    /// Unknown / consumed / timed-out code. Terminal; start over.
    case expired
    /// Done — delivered EXACTLY ONCE. Persist it here or it is gone.
    case approved(AuthSession)

    private enum CodingKeys: String, CodingKey { case status, interval }

    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        switch try c.decode(String.self, forKey: .status) {
        case "pending":
            self = .pending(interval: (try? c.decode(Int.self, forKey: .interval)) ?? 5)
        case "slow_down":
            self = .slowDown(interval: (try? c.decode(Int.self, forKey: .interval)) ?? 10)
        case "denied":
            self = .denied
        case "approved":
            self = .approved(try AuthSession(from: decoder))
        default:
            // "expired" and anything this build doesn't know: stop polling.
            // Failing SAFE here means a future status can never strand the
            // device in a hot loop.
            self = .expired
        }
    }
}

// ── Response envelopes ──────────────────────────────────────────────────────
struct UserWrap: Codable { let user: SelfUser }
struct GuildsWrap: Codable { let guilds: [Guild] }
struct GuildWrap: Codable { let guild: Guild }

struct Invite: Codable, Identifiable {
    let code: String
    var channelId: String?
    var guildId: String?
    var uses: Int?
    var maxUses: Int?
    var expiresAt: String?
    var id: String { code }
}
struct InviteWrap: Codable { let invite: Invite }
struct InvitesWrap: Codable { let invites: [Invite] }

struct AdminUser: Codable, Identifiable {
    let id: String
    var username: String
    var displayName: String?
    var email: String?
    var avatarUrl: String?
    var isAdmin: Bool
    /// Instance moderator (restricted staff role).
    var isModerator: Bool
    /// Date of birth (YYYY-MM-DD); nil for legacy accounts without one.
    var dateOfBirth: String?
    var bannedAt: String?
    /// For a timed ban: when it auto-lifts (ISO). Nil = permanent (when banned)
    /// or not banned.
    var bannedUntil: String?
    /// Active perk tier (own row); nil = none.
    var subscriptionTier: String?
    var subscriptionExpiresAt: String?
    var createdAt: String?
    var lastSeenAt: String?
    /// Instance mute (staff action). Set = muted; mutedUntil nil = permanent.
    var mutedAt: String?
    var mutedUntil: String?
    var name: String { displayName ?? username }
    var isBanned: Bool { bannedAt != nil }
    var isStaff: Bool { isAdmin || isModerator }
    /// A timed mute that has run out is not a mute (the server agrees).
    var isMuted: Bool {
        guard mutedAt != nil else { return false }
        guard let until = mutedUntil, let d = AdminDates.parse(until) else { return true }
        return d > Date()
    }

    // Defensive decode: a single null username/isAdmin shouldn't blank the
    // whole admin user list.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        id = try c.decode(String.self, forKey: .id)
        username = (try? c.decode(String.self, forKey: .username)) ?? "unknown"
        displayName = try? c.decode(String.self, forKey: .displayName)
        email = try? c.decode(String.self, forKey: .email)
        avatarUrl = try? c.decode(String.self, forKey: .avatarUrl)
        isAdmin = (try? c.decode(Bool.self, forKey: .isAdmin)) ?? false
        isModerator = (try? c.decode(Bool.self, forKey: .isModerator)) ?? false
        dateOfBirth = try? c.decode(String.self, forKey: .dateOfBirth)
        bannedAt = try? c.decode(String.self, forKey: .bannedAt)
        bannedUntil = try? c.decode(String.self, forKey: .bannedUntil)
        subscriptionTier = try? c.decode(String.self, forKey: .subscriptionTier)
        subscriptionExpiresAt = try? c.decode(String.self, forKey: .subscriptionExpiresAt)
        createdAt = try? c.decode(String.self, forKey: .createdAt)
        lastSeenAt = try? c.decode(String.self, forKey: .lastSeenAt)
        mutedAt = try? c.decode(String.self, forKey: .mutedAt)
        mutedUntil = try? c.decode(String.self, forKey: .mutedUntil)
    }
}
struct AdminUsersWrap: Codable { let users: [AdminUser] }

/// ISO-8601 with or without fractional seconds (the server's toISOString()
/// always has them; be lenient anyway).
enum AdminDates {
    private static let frac: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()
    private static let plain = ISO8601DateFormatter()
    static func parse(_ s: String) -> Date? { frac.date(from: s) ?? plain.date(from: s) }
}

// MARK: Admin → Account Info

/// GET /admin/users/:id — the admin-only account record.
struct AdminAccount: Codable {
    let id: String
    var username: String
    var displayName: String?
    var email: String
    var emailVerified: Bool
    var avatarUrl: String?
    var dateOfBirth: String?
    var dobLocked: Bool
    var isMinor: Bool
    var isAdmin: Bool
    var isModerator: Bool
    var twoFactorEnabled: Bool
    var createdAt: String
    var lastSeenAt: String?
    var banned: Bool
    var bannedUntil: String?
    var muted: Bool
    var mutedUntil: String?
    var subscriptionTier: String?
    var subscriptionExpiresAt: String?
    var activeSessions: Int
    var guildCount: Int
    var friendCount: Int
}
struct AdminAccountWrap: Codable { let account: AdminAccount }

struct AdminContactPerson: Codable, Identifiable {
    let id: String
    let username: String
    let displayName: String?
    let avatarUrl: String?
    let since: String
    var name: String { (displayName?.isEmpty == false ? displayName : nil) ?? username }
}
struct AdminAccountContacts: Codable {
    let friends: [AdminContactPerson]
    let incomingRequests: [AdminContactPerson]
    let outgoingRequests: [AdminContactPerson]
    let blocked: [AdminContactPerson]
    let dmPartners: [AdminContactPerson]
}

struct StaffNote: Codable, Identifiable {
    struct Author: Codable { let id: String; let username: String; let displayName: String? }
    let id: String
    let body: String
    let createdAt: String
    /// Nil when the author's account is gone.
    let author: Author?
}
struct StaffNotesWrap: Codable { let notes: [StaffNote] }

/// One active auth session for the current user.
/// Mirrors the `toSession` DTO from apps/api (GET /users/@me/sessions).
/// `userAgent`/`ipAddress` are nullable server-side; `current` flags the
/// session this request is authenticated with.
struct UserSession: Codable, Identifiable, Hashable {
    let id: String
    var userAgent: String?
    var ipAddress: String?
    var createdAt: String
    var lastUsedAt: String
    var expiresAt: String?
    var current: Bool
}
struct SessionsWrap: Codable { let sessions: [UserSession] }

struct AdminGuild: Codable, Identifiable {
    let id: String
    var name: String
    var iconUrl: String?
    var ownerId: String?
    var memberCount: Int?
    var createdAt: String?
    var discoverable: Bool?
}
struct AdminGuildsWrap: Codable { let guilds: [AdminGuild] }

struct AdminStorageCategory: Codable { let count: Int; var totalBytes: Int? }
struct AdminStorageOnDisk: Codable {
    let totalBytes: Int; let totalCount: Int
    let unusedBytes: Int; let unusedCount: Int
}
struct AdminStorage: Codable {
    let attachments: AdminStorageCategory
    let avatars: AdminStorageCategory
    let banners: AdminStorageCategory
    let emojis: AdminStorageCategory
    let stickers: AdminStorageCategory
    let onDisk: AdminStorageOnDisk
}
struct AdminStorageWrap: Codable { let storage: AdminStorage }
struct StorageGcResult: Codable { let scanned: Int; let deleted: Int }
struct ChannelsWrap: Codable { let channels: [Channel] }
struct VoiceStatesWrap: Codable { let voiceStates: [VoiceState] }
struct ChannelWrap: Codable { let channel: Channel }
struct MessagesWrap: Codable { let messages: [Message] }
/// Shared-media gallery page. The server adds messageId/authorId/createdAt to
/// each item; Attachment's Codable ignores those extra keys (we only need the
/// attachment fields + id cursor for the gallery).
struct ChannelAttachmentsWrap: Codable { let attachments: [Attachment] }
struct MessageWrap: Codable { let message: Message }

/// Per-channel read marker: the last message the user has acked, plus the
/// count of direct mentions since that ack. Drives unread indicators.
struct ReadState: Codable {
    let channelId: String
    var lastMessageId: String?
    var mentionCount: Int?
}
struct ReadStatesWrap: Codable { let readStates: [ReadState] }

/// A per-target notification preference ('all' | 'mentions' | 'nothing').
/// 'nothing' == muted. Absence of an override means the default ('all').
struct NotificationOverride: Codable {
    let targetType: String   // "guild" | "channel"
    let targetId: String
    let level: String?
}
struct NotificationOverridesWrap: Codable { let overrides: [NotificationOverride] }
struct AckWrap: Codable { let readState: ReadState }
struct OkWrap: Codable { let ok: Bool }
struct ThreadsWrap: Codable { let threads: [Channel] }

struct Relationship: Codable, Identifiable {
    var type: String          // friend | incoming_request | outgoing_request | blocked
    var createdAt: String
    var user: PublicUser
    var id: String { user.id }
}
struct RelationshipsWrap: Codable { let relationships: [Relationship] }
/// The current user's personal DM-nickname map: { targetUserId: nickname }.
struct DmNicknamesWrap: Codable { let nicknames: [String: String] }

struct Mention: Codable, Identifiable {
    let id: String
    var channelId: String
    var createdAt: String
    var author: PublicUser?
    var content: String?
    var channelName: String?
    var guildId: String?
    /// Message type ("default", "system_join", …). The mentions route returns
    /// full message DTOs; decoding this lets the inbox attribute a system_join
    /// welcome to the SERVER instead of its data-author (the newcomer).
    var type: String?

    var text: String { content ?? "" }
}
struct MentionsWrap: Codable { let mentions: [Mention] }
struct ForumPostResult: Codable { let post: Channel; let message: Message }
struct VoiceStateWrap: Codable { let voiceState: VoiceState }
struct JoinVoiceResult: Codable {
    let voiceState: VoiceState
    let channelVoiceStates: [VoiceState]
    let token: String?
    let wsUrl: String?
}

// ── Request bodies ──────────────────────────────────────────────────────────
struct LoginBody: Codable {
    let email: String
    let password: String
    /// TOTP or recovery code for 2FA accounts. Omitted on the first attempt;
    /// the server replies `{requires2FA:true}` and the UI resubmits with it.
    var code: String? = nil
}
struct RegisterBody: Codable {
    let email: String
    let username: String
    let displayName: String
    let password: String
    /// YYYY-MM-DD. Required by the server (age-gates under-13).
    let dateOfBirth: String
    /// Invite code — only invite-only servers need it. nil is omitted.
    var code: String? = nil
}

// ── WebAuthn passkeys ────────────────────────────────────────────────────
// We decode only the fields the ceremony needs from the server's options blob
// (it carries many more; Codable ignores the rest). All binary values are
// base64url strings on the wire.
struct PasskeyAssertionOptions: Codable { let challenge: String }
struct PasskeyLoginOptions: Codable { let challengeId: String; let options: PasskeyAssertionOptions }
struct PasskeyRegUser: Codable { let id: String; let name: String; let displayName: String }
struct PasskeyAttestationOptions: Codable { let challenge: String; let user: PasskeyRegUser }
struct PasskeyRegisterOptions: Codable { let challengeId: String; let options: PasskeyAttestationOptions }

struct PasskeyInfo: Codable, Identifiable {
    let id: String
    let deviceName: String?
    let backedUp: Bool
    let createdAt: String?
    let lastUsedAt: String?
}
struct OpenDMBody: Codable { let recipientId: String }
struct E2EEEnableBody: Codable { let salt: String; let verifier: String; let purgeProof: String }
struct E2EEDisableBody: Codable { let verifier: String; let purgeProof: String }
struct E2EEPurgeProofBody: Codable { let verifier: String; let purgeProof: String }
struct ForumPostBody: Codable { let title: String; let content: String }

// MARK: Server discovery / creation / invites

struct DiscoverableGuild: Codable, Identifiable {
    let id: String
    var name: String
    var description: String?
    var discoveryDescription: String?
    var discoveryCategory: String?
    var iconUrl: String?
    var bannerUrl: String?
    var memberCount: Int?
}

/// Canonical discovery categories — mirrors DISCOVERY_CATEGORIES server-side.
let ZKDiscoveryCategories = [
    "Gaming", "Music", "Entertainment", "Education",
    "Science & Technology", "Content Creator", "Anime & Manga",
    "Movies & TV", "Other",
]
struct DiscoverWrap: Codable { let guilds: [DiscoverableGuild] }

struct CreateGuildResult: Codable {
    let guild: Guild
}
struct AcceptInviteResult: Codable {
    let guildId: String
    let channelId: String?
}

// MARK: Invite preview (public GET /invites/:code) — mirrors web InvitePreview.
struct InvitePreviewGuild: Codable {
    let id: String
    let name: String
    var iconUrl: String?
    var bannerUrl: String?
    var description: String?
    let memberCount: Int
}
struct InvitePreviewChannel: Codable { let id: String }
struct InvitePreview: Codable {
    let code: String
    let guild: InvitePreviewGuild
    let channel: InvitePreviewChannel
    let uses: Int
    var maxUses: Int?
    var expiresAt: String?
}
struct InvitePreviewWrap: Codable { let invite: InvitePreview }

// MARK: Two-factor (TOTP) — mirrors web's rest 2FA methods.
struct TwoFactorStatus: Codable {
    let enabled: Bool
    let verifiedAt: String?
    let recoveryRemaining: Int
}
struct TwoFactorSecret: Codable {
    let secret: String
    let otpauthUri: String
}
struct TwoFactorRecovery: Codable {
    let recoveryCodes: [String]
}

// MARK: Admin (instance)

struct AdminUserCounts: Codable { let total: Int; let banned: Int }
struct AdminMessageCounts: Codable { let total: Int; let last24h: Int }
struct AdminStats: Codable {
    let users: AdminUserCounts
    let guilds: Int
    let channels: Int
    let messages: AdminMessageCounts
    let activeSessions: Int
    let generatedAt: String?
}
struct AdminStatsWrap: Codable { let stats: AdminStats }

// ── Admin operational metrics + voice diagnostic ────────────────────────────

/// Runtime/operational metrics from GET /admin/metrics. Mirrors the server's
/// InstanceMetrics.
struct InstanceMetrics: Codable {
    struct Process: Codable { let uptimeSeconds: Int; let workerId: Int; let nodeEnv: String }
    struct Gateway: Codable { let connections: Int; let onlineUsers: Int }
    struct Counts: Codable {
        let users: Int; let bannedUsers: Int; let guilds: Int; let channels: Int
        let messages: Int; let messagesLast24h: Int; let activeSessions: Int
    }
    struct Voice: Codable { let rooms: Int; let participants: Int }
    struct Scheduled: Codable { let pending: Int; let due: Int }
    struct DB: Codable { let ok: Bool; let latencyMs: Int }
    struct Redis: Codable { let configured: Bool; let healthy: Bool? }

    let process: Process
    let gateway: Gateway
    let counts: Counts
    let voice: Voice
    let scheduledMessages: Scheduled
    let db: DB
    let redis: Redis
    let generatedAt: String
}
struct MetricsWrap: Codable { let metrics: InstanceMetrics }

// MARK: Family / parental controls

struct FamilyUser: Codable, Identifiable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var name: String { displayName ?? username ?? "Unknown" }
}
struct ChildRestrictions: Codable {
    var canAddFriends: Bool
    var canRemoveFriends: Bool
    var allowVoice: Bool
    var allowVideo: Bool
    var allowStream: Bool
    var allowCreateGuild: Bool
    var allowJoinGuilds: Bool
    var allowMessaging: Bool
    /// "none" | "friends" | "all"
    var dmPolicy: String
    /// Mask swear/vulgar words (f•••) in the child's message views.
    var filterProfanity: Bool

    // Custom decode so a server that hasn't shipped `filter_profanity` yet (the
    // pre-deploy window) doesn't hard-fail the ENTIRE supervision decode with a
    // keyNotFound — the new field degrades to ON (protective) when absent. The
    // other fields keep the existing required contract (the server always sends
    // them). encode(to:) stays synthesized, so familySetRestrictions still sends
    // the full struct.
    init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        canAddFriends = try c.decode(Bool.self, forKey: .canAddFriends)
        canRemoveFriends = try c.decode(Bool.self, forKey: .canRemoveFriends)
        allowVoice = try c.decode(Bool.self, forKey: .allowVoice)
        allowVideo = try c.decode(Bool.self, forKey: .allowVideo)
        allowStream = try c.decode(Bool.self, forKey: .allowStream)
        allowCreateGuild = try c.decode(Bool.self, forKey: .allowCreateGuild)
        allowJoinGuilds = try c.decode(Bool.self, forKey: .allowJoinGuilds)
        allowMessaging = try c.decode(Bool.self, forKey: .allowMessaging)
        dmPolicy = try c.decode(String.self, forKey: .dmPolicy)
        filterProfanity = try c.decodeIfPresent(Bool.self, forKey: .filterProfanity) ?? true
    }
}

struct FamilyRestrictionsWrap: Codable {
    let restrictions: ChildRestrictions
}
struct FamilySummary: Codable {
    var restrictions: ChildRestrictions?
    // Age-driven minor state (optional for forward-compat with older servers).
    var isMinor: Bool?
    var graceActive: Bool?
    var graceDaysRemaining: Int?
    var restrictedHeavily: Bool?
    var children: [FamilyUser]
    var outgoingRequests: [FamilyUser]
    /// Child-initiated requests awaiting MY (the parent's) acceptance.
    var incomingChildRequests: [FamilyUser]?
    var supervisedBy: [FamilyUser]
    var incomingRequests: [FamilyUser]
    /// Parent invites I (the child) sent, awaiting the parent's acceptance.
    var outgoingParentRequests: [FamilyUser]?
}

// MARK: Guild members (for resolving names in voice rosters, etc.)

struct GuildMember: Codable, Identifiable {
    var guildId: String?
    var userId: String
    var user: PublicUser
    var roleIds: [String]?
    var membershipState: String?
    var id: String { userId }
}
struct MembersWrap: Codable { let members: [GuildMember] }
struct MemberWrap: Codable { let member: GuildMember }

struct Role: Codable, Identifiable {
    let id: String
    var guildId: String?
    var name: String
    var color: Int          // RGB integer; 0 = no color
    var position: Int
    var permissions: String?
    var hoist: Bool
    var mentionable: Bool?
    var managed: Bool?
    var selfAssignable: Bool?
}
struct RolesWrap: Codable { let roles: [Role] }
struct RoleWrap: Codable { let role: Role }

struct SavedChannel: Codable {
    var id: String
    var type: String?
    var name: String?
    var guildId: String?
}
struct SavedMessageItem: Codable, Identifiable {
    var savedAt: String
    var message: Message
    var channel: SavedChannel?
    var id: String { message.id }
}
struct SavedListWrap: Codable { let items: [SavedMessageItem]; let nextCursor: String? }
struct SavedMembershipWrap: Codable { let savedIds: [String] }

/// One image in a lightbox: a remote URL (plain attachments), an
/// in-memory UIImage (E2EE attachments, already decrypted — so plaintext
/// never round-trips through a URL), or a lazily-resolved encrypted
/// reference (attachment + channel) the visible page decrypts on-appear so
/// we don't decrypt the whole paged set up front.
struct LightboxItem: Identifiable {
    let id = UUID()
    var url: URL? = nil
    var image: UIImage? = nil
    var encrypted: (attachment: Attachment, channel: Channel)? = nil
}

/// A full-screen image presentation request — one or more images, paged
/// (swipe left/right between them).
struct LightboxImage: Identifiable {
    let id = UUID()
    var items: [LightboxItem]
    var startIndex: Int

    /// Back-compat: a single remote image.
    init(url: URL) { items = [LightboxItem(url: url)]; startIndex = 0 }
    /// A set of images to page through, opening at startIndex.
    init(items: [LightboxItem], startIndex: Int = 0) {
        self.items = items
        self.startIndex = items.isEmpty ? 0 : max(0, min(startIndex, items.count - 1))
    }
}

// MARK: - Permissions

struct PermissionDef: Identifiable {
    let bit: Int
    let key: String
    let label: String
    let group: String
    var id: String { key }
}

/// Permission bitfield catalog + helpers. Bits go up to 33 (MANAGE_THREADS),
/// so the bitfield is a UInt64. Wire format is a decimal string. Mirrors
/// packages/shared/src/permissions.ts (and apps/web/src/lib/permissions.ts).
enum Permissions {
    static let ADMINISTRATOR = 0
    static let VIEW_CHANNEL = 1
    static let MANAGE_MESSAGES = 4
    static let MANAGE_CHANNELS = 10
    static let MANAGE_ROLES = 12
    static let KICK_MEMBERS = 13
    static let BAN_MEMBERS = 14
    static let MODERATE_MEMBERS = 17
    static let MANAGE_GUILD = 18
    static let VIEW_AUDIT_LOG = 19
    static let MANAGE_WEBHOOKS = 20
    static let MANAGE_EMOJIS = 21
    static let MANAGE_INVITES = 22
    static let MANAGE_EVENTS = 32
    static let MANAGE_THREADS = 33

    static let all: [PermissionDef] = [
        .init(bit: 0,  key: "ADMINISTRATOR", label: "Administrator", group: "General"),
        .init(bit: 18, key: "MANAGE_GUILD", label: "Manage Server", group: "General"),
        .init(bit: 12, key: "MANAGE_ROLES", label: "Manage Roles", group: "General"),
        .init(bit: 10, key: "MANAGE_CHANNELS", label: "Manage Channels", group: "General"),
        .init(bit: 1,  key: "VIEW_CHANNEL", label: "View Channels", group: "General"),
        .init(bit: 19, key: "VIEW_AUDIT_LOG", label: "View Audit Log", group: "General"),
        .init(bit: 11, key: "CREATE_INVITE", label: "Create Invite", group: "Membership"),
        .init(bit: 22, key: "MANAGE_INVITES", label: "Manage Invites", group: "Membership"),
        .init(bit: 13, key: "KICK_MEMBERS", label: "Kick Members", group: "Membership"),
        .init(bit: 14, key: "BAN_MEMBERS", label: "Ban Members", group: "Membership"),
        .init(bit: 17, key: "MODERATE_MEMBERS", label: "Time Out Members", group: "Membership"),
        .init(bit: 15, key: "CHANGE_NICKNAME", label: "Change Own Nickname", group: "Membership"),
        .init(bit: 16, key: "MANAGE_NICKNAMES", label: "Manage Nicknames", group: "Membership"),
        .init(bit: 3,  key: "SEND_MESSAGES", label: "Send Messages", group: "Text"),
        .init(bit: 2,  key: "READ_MESSAGE_HISTORY", label: "Read Message History", group: "Text"),
        .init(bit: 5,  key: "ATTACH_FILES", label: "Attach Files", group: "Text"),
        .init(bit: 6,  key: "EMBED_LINKS", label: "Embed Links", group: "Text"),
        .init(bit: 7,  key: "ADD_REACTIONS", label: "Add Reactions", group: "Text"),
        .init(bit: 4,  key: "MANAGE_MESSAGES", label: "Manage Messages", group: "Text"),
        .init(bit: 9,  key: "MENTION_EVERYONE", label: "Mention @everyone & Roles", group: "Text"),
        .init(bit: 8,  key: "USE_EXTERNAL_EMOJIS", label: "Use External Emoji", group: "Text"),
        .init(bit: 23, key: "CONNECT", label: "Connect", group: "Voice"),
        .init(bit: 24, key: "SPEAK", label: "Speak", group: "Voice"),
        .init(bit: 30, key: "STREAM", label: "Video / Screen Share", group: "Voice"),
        .init(bit: 28, key: "USE_VAD", label: "Voice Activity", group: "Voice"),
        .init(bit: 25, key: "MUTE_MEMBERS", label: "Mute Members", group: "Voice"),
        .init(bit: 26, key: "DEAFEN_MEMBERS", label: "Deafen Members", group: "Voice"),
        .init(bit: 27, key: "MOVE_MEMBERS", label: "Move Members", group: "Voice"),
        .init(bit: 29, key: "PRIORITY_SPEAKER", label: "Priority Speaker", group: "Voice"),
        .init(bit: 20, key: "MANAGE_WEBHOOKS", label: "Manage Webhooks", group: "Advanced"),
        .init(bit: 21, key: "MANAGE_EMOJIS", label: "Manage Emoji", group: "Advanced"),
        .init(bit: 32, key: "MANAGE_EVENTS", label: "Manage Events", group: "Advanced"),
        .init(bit: 33, key: "MANAGE_THREADS", label: "Manage Threads", group: "Advanced"),
    ]
    static let groupOrder = ["General", "Membership", "Text", "Voice", "Advanced"]

    static func mask(_ b: Int) -> UInt64 { UInt64(1) << UInt64(b) }
    static var allBits: UInt64 { all.reduce(UInt64(0)) { $0 | mask($1.bit) } }
    static func parse(_ s: String?) -> UInt64 {
        guard let s = s, let v = UInt64(s) else { return 0 }
        return v
    }
    static func serialize(_ bits: UInt64) -> String { String(bits) }
    static func has(_ bits: UInt64, _ b: Int) -> Bool { (bits & mask(b)) != 0 }
}

// ── Admin observe ("ghost mode") + parental oversight DTOs ──────────────────
// Slim shapes returned by /admin/.../peek and /family/children/... — these
// are moderation views, not full chat hydration.

struct PeekGuild: Codable {
    let id: String
    var name: String
    var iconUrl: String?
    var ownerId: String?
    var createdAt: String?
    var memberCount: Int?
}
/// One person the subject exchanges 1:1 DMs with. ADMIN-ONLY view; carries counts
/// and friend status, never message content (most of these DMs are E2EE and the
/// server cannot read them either).
struct AdminDmPeer: Codable, Identifiable {
    let channelId: String
    let user: PublicUser
    let isFriend: Bool
    let messageCount: Int
    var id: String { channelId }
}

struct AdminDmPeersWrap: Codable {
    let peers: [AdminDmPeer]
    /// True when the subject has more DM channels than the server enumerates.
    let capped: Bool
}

struct PeekGuildResult: Codable {
    let guild: PeekGuild
    let channels: [Channel]
}

struct PeekReaction: Codable, Hashable { let emoji: String; let count: Int }
struct PeekAttachment: Codable, Identifiable, Hashable {
    let id: String
    var filename: String?
    var url: String?
    var contentType: String?
    var size: Int?
    /// Kept forever by attachment retention; `url` may be a dead path.
    var thumbnailUrl: String?
    /// Non-nil ⇒ the FULL-SIZE object has been reclaimed. `url` is still
    /// populated and still points at the dead path, so gate on THIS, never on a
    /// missing url. A parent reviewing months-old DMs is the reader most likely
    /// to hit expired media, and before this field existed the peek view showed
    /// them a permanently spinning placeholder.
    var blobExpiredAt: String?
    var blobExpired: Bool { blobExpiredAt != nil }
}

/// One message in an observed channel / supervised DM.
struct PeekMessage: Codable, Identifiable, Hashable {
    let id: String
    var channelId: String?
    var authorId: String?
    var authorUsername: String?
    var authorDisplayName: String?
    var authorAvatarUrl: String?
    var content: String?
    var createdAt: String
    var editedAt: String?
    /// Supervision only: the child deleted this message, but parents
    /// still see it (labelled).
    var deleted: Bool?
    var attachments: [PeekAttachment]?
    var reactions: [PeekReaction]?

    var authorName: String { authorDisplayName ?? authorUsername ?? "Unknown" }
}
struct PeekMessagesWrap: Codable { let messages: [PeekMessage] }

/// A guild the supervised child belongs to, with its block state.
struct ChildGuild: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var iconUrl: String?
    var blocked: Bool
}
struct ChildGuildsWrap: Codable { let guilds: [ChildGuild] }

/// One of the child's 1:1 DM conversations.
struct ChildDMRecipient: Codable, Hashable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var name: String { displayName ?? username ?? "Unknown" }
}
struct ChildDM: Codable, Identifiable, Hashable {
    let id: String
    var lastMessageId: String?
    var recipient: ChildDMRecipient?
}
struct ChildDMsWrap: Codable { let channels: [ChildDM] }

/// One of the supervised child's relationships (friend / blocked / pending),
/// as returned by /family/children/:id/friends.
struct ChildRelationship: Codable, Identifiable, Hashable {
    let type: String          // friend | incoming_request | outgoing_request | blocked
    var createdAt: String?
    var user: PublicUser
    var id: String { user.id }
}
struct ChildRelationshipsWrap: Codable { let relationships: [ChildRelationship] }

// MARK: Watch words + flagged messages (parental controls)
struct WatchWordsWrap: Codable { let words: [String] }

/// A message that matched one of the child's watch words. Mirrors web's
/// FamilyFlag. `matchedWord` is comma-joined; `direction` is sent|received;
/// `byChild` is true when the child authored it; `snippet` is up to ~280
/// chars of content (supervised DMs are plaintext).
struct FamilyFlag: Codable, Identifiable, Hashable {
    let id: String
    var messageId: String
    var channelId: String
    var matchedWord: String
    var direction: String
    var createdAt: String
    var reviewed: Bool
    var byChild: Bool
    var snippet: String?
}
struct FamilyFlagsWrap: Codable { let flags: [FamilyFlag] }


// ── Security (Admin → Security) ─────────────────────────────────────────────
struct SecurityEvent: Codable, Identifiable, Hashable {
    let id: String
    var kind: String              // spam_limited | banned_word | staff_*
    var userId: String?
    var username: String?
    var displayName: String?
    /// WHO performed a staff action (nil for automated detections).
    var actorId: String?
    var actorUsername: String?
    var actorDisplayName: String?
    var guildId: String?
    var channelId: String?
    var detail: String
    var contentSnapshot: String?
    var createdAt: String
    var isStaffAction: Bool { kind.hasPrefix("staff_") }
    /// The name shown bold at the front of the row: the staff actor for
    /// staff_* audit rows, else the detection's offender.
    var actorName: String {
        if isStaffAction { return actorDisplayName ?? actorUsername ?? "Unknown staff" }
        return displayName ?? username ?? "Unknown"
    }
    /// Target of a staff action, for the "actor → target" line.
    var targetName: String? { isStaffAction ? (displayName ?? username) : nil }
}
struct SecurityEventsWrap: Codable { let events: [SecurityEvent] }
/// A banned/watched word. 'blocked' hard-blocks messages + identity fields;
/// 'watch' logs usage without blocking.
struct SecurityWord: Codable, Identifiable, Hashable {
    let word: String
    let severity: String   // "blocked" | "watch"
    var id: String { word }
}
struct SecurityWordsWrap: Codable { let words: [SecurityWord] }
/// The raw common-wordlist preset endpoint still returns plain strings.
struct SecurityPresetWrap: Codable { let words: [String] }

// ── Audit log ───────────────────────────────────────────────────────────────

/// Opaque JSON value — captures an audit entry's free-form `changes` object
/// without modeling every action's shape. Decodes any JSON; re-encodes for a
/// pretty display string.
indirect enum JSONValue: Codable {
    case string(String)
    case number(Double)
    case bool(Bool)
    case null
    case array([JSONValue])
    case object([String: JSONValue])

    init(from decoder: Decoder) throws {
        let c = try decoder.singleValueContainer()
        // Order matters: Bool before Double (a JSON bool must not be read as a
        // number), then the structured/string cases. Anything unexpected → null.
        if c.decodeNil() {
            self = .null
        } else if let b = try? c.decode(Bool.self) {
            self = .bool(b)
        } else if let n = try? c.decode(Double.self) {
            self = .number(n)
        } else if let s = try? c.decode(String.self) {
            self = .string(s)
        } else if let a = try? c.decode([JSONValue].self) {
            self = .array(a)
        } else if let o = try? c.decode([String: JSONValue].self) {
            self = .object(o)
        } else {
            self = .null
        }
    }

    func encode(to encoder: Encoder) throws {
        var c = encoder.singleValueContainer()
        switch self {
        case .string(let s): try c.encode(s)
        case .number(let n): try c.encode(n)
        case .bool(let b): try c.encode(b)
        case .null: try c.encodeNil()
        case .array(let a): try c.encode(a)
        case .object(let o): try c.encode(o)
        }
    }
}

/// One audit-log entry. Mirrors the server's AuditLogEntryDTO. `changes` is
/// opaque (see JSONValue); `actor` is null when the moderator was deleted.
struct AuditEntry: Codable, Identifiable {
    let id: String
    var guildId: String
    var actor: PublicUser?
    var action: String
    var targetType: String
    var targetId: String?
    var changes: [String: JSONValue]?
    var reason: String?
    var createdAt: String

    var actorName: String { actor?.name ?? "Unknown moderator" }

    /// Pretty-printed `changes` for display, or nil when absent/empty.
    var changesText: String? {
        guard let changes, !changes.isEmpty else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(changes),
              let s = String(data: data, encoding: .utf8) else { return nil }
        return s
    }
}

struct AuditLogWrap: Codable { let entries: [AuditEntry] }

// ── Reports / moderation queue ──────────────────────────────────────────────

/// A member report (moderation queue item). Mirrors the server's ReportDTO.
/// `messageContent` is a snapshot captured at file time, so it survives the
/// reported message being deleted.
struct Report: Codable, Identifiable {
    let id: String
    var guildId: String
    var reporter: PublicUser?
    var targetType: String          // "message" | "user"
    var targetUser: PublicUser?
    var messageId: String?
    var channelId: String?
    var messageContent: String?
    var reason: String              // spam | harassment | nsfw | violence | other
    var details: String?
    var status: String              // open | resolved | dismissed
    var createdAt: String

    var reporterName: String { reporter?.name ?? "Unknown" }
    var targetName: String {
        targetUser?.name ?? (targetType == "user" ? "Unknown user" : "a message")
    }
    var reasonLabel: String {
        switch reason {
        case "spam": return "Spam"
        case "harassment": return "Harassment"
        case "nsfw": return "NSFW"
        case "violence": return "Violence"
        case "other": return "Other"
        default: return reason
        }
    }
}

struct ReportsWrap: Codable { let reports: [Report]; let openCount: Int }
struct ReportWrap: Codable { let report: Report }
struct CreateReportAck: Codable { let ok: Bool; let reportId: String }

/// User-report reasons accepted by the server (POST /guilds/:id/reports).
enum ReportReason: String, CaseIterable, Identifiable {
    case spam, harassment, nsfw, violence, other
    var id: String { rawValue }
    var label: String {
        switch self {
        case .spam: return "Spam"
        case .harassment: return "Harassment"
        case .nsfw: return "NSFW"
        case .violence: return "Violence"
        case .other: return "Other"
        }
    }
}

/// User-selectable camera publish quality (Settings → Preferences). Mirrors
/// web's camera-quality picker. The LiveKit dimensions/bitrate mapping lives in
/// Voice.swift so this stays UI-only (no LiveKit dependency here).
enum CameraQuality: String, CaseIterable, Identifiable {
    // rawValues are persisted in UserDefaults ("zk.cameraQuality") — never
    // rename `medium`/`high` even though they now read as 720p/1080p.
    case auto, low, medium, high
    case k2, k4
    var id: String { rawValue }
    var shortLabel: String {
        switch self {
        case .auto: return "Auto"
        case .low: return "Low"
        case .medium: return "720p"
        case .high: return "1080p"
        case .k2: return "2K"
        case .k4: return "4K"
        }
    }
    var detail: String {
        switch self {
        case .auto: return "Adapts to your connection (≈720p)."
        case .low: return "480p · saves bandwidth, good for slow networks."
        case .medium: return "720p · balanced."
        case .high: return "1080p · sharp, needs a strong uplink."
        case .k2: return "2560×1440 · sharp, heavy on battery."
        case .k4: return "3840×2160 · maximum sharpness — heavy CPU/heat; needs excellent wifi."
        }
    }
}

/// Admin-configurable perk gates (GET /instance/monetization — the route
/// keeps its old name; there are no payments). Each matrix value is the
/// MINIMUM perk tier required ("none"/"scout"/"guardian"/"legend"; "none" =
/// everyone). 720p and below are always open and never appear here.
/// `uploadCapsMb` values are nil when the server falls back to its env
/// default for that tier.
struct MonetizationConfig: Codable, Hashable {
    struct QualityTiers: Codable, Hashable {
        var p1080: String
        var k2: String
        var k4: String
        /// Screen share only: 60fps. nil on the camera matrix and on older
        /// servers.
        var fps60: String?
    }
    struct UploadCapsMb: Codable, Hashable {
        var free: Int?
        var scout: Int?
        var guardian: Int?
        var legend: Int?
    }
    var stream: QualityTiers
    var camera: QualityTiers
    /// Always "none" now — cosmetics are free. Optional so a server that
    /// drops the key still decodes.
    var appearance: String?
    var uploadCapsMb: UploadCapsMb
}
struct MonetizationConfigWrap: Codable { let config: MonetizationConfig }

/// Admin Overview "recent activity" feed (GET /admin/activity).
struct AdminActivity: Codable {
    struct RecentUser: Codable, Identifiable {
        let id: String
        let username: String
        let displayName: String
        let avatarUrl: String?
        let createdAt: String
    }
    struct RecentGuild: Codable, Identifiable {
        let id: String
        let name: String
        let iconUrl: String?
        let ownerId: String
        let createdAt: String
    }
    let recentUsers: [RecentUser]
    let recentGuilds: [RecentGuild]
}
struct AdminActivityWrap: Codable { let activity: AdminActivity }

struct SecurityConfig: Codable, Hashable {
    var spamEnabled: Bool
    var spamMaxMessages: Int
    var spamWindowSeconds: Int
    var spamCooldownSeconds: Int
    var wordFilterEnabled: Bool
}
struct SecurityConfigWrap: Codable { let config: SecurityConfig }

// ── Achievements ────────────────────────────────────────────────────────────
struct Achievement: Codable, Identifiable, Hashable {
    let id: String
    var name: String
    var description: String
    var marker: String
    var value: Int
    /// Locked entries (earned == false) carry progress toward `goal`.
    /// Optional for back-compat with older servers (absent = earned).
    var earned: Bool?
    var goal: Int?

    var isEarned: Bool { earned ?? true }

    /// SF Symbol for this achievement, keyed by id prefix. Mirrors web's
    /// `badgeIcon` mapping (AchievementsShelf.tsx) with native equivalents,
    /// so the same achievement reads the same on both clients.
    var sfSymbol: String {
        switch true {
        case id.hasPrefix("veteran"): return "calendar.badge.checkmark"
        case id.hasPrefix("chatterbox"): return "bubble.left.and.bubble.right.fill"
        case id.hasPrefix("social"): return "person.2.fill"
        case id == "night_owl": return "moon.stars.fill"
        case id == "first_responder": return "bolt.fill"
        case id == "marathon": return "flame.fill"
        case id == "founder": return "building.columns.fill"
        case id == "voice_of_people": return "mic.fill"
        case id == "locked_in": return "key.fill"
        case id == "double_locked": return "lock.shield.fill"
        case id == "tagged": return "tag.fill"
        case id == "framed": return "photo.circle.fill"
        case id == "signature_look": return "sparkles"
        case id == "welcome_committee": return "hand.wave.fill"
        case id == "off_the_record": return "lock.fill"
        case id == "discovered": return "safari.fill"
        case id == "guardian_angel": return "figure.and.child.holdinghands"
        case id == "first_contact": return "antenna.radiowaves.left.and.right"
        case id == "event_horizon": return "circle.circle.fill"
        default: return "rosette"
        }
    }
}
struct AchievementsWrap: Codable {
    let achievements: [Achievement]
    var `public`: Bool?
}
