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

    /// Best display label with sensible fallbacks.
    var name: String { displayName ?? username ?? "Unknown" }
}

struct PublicUserWrap: Codable { let user: PublicUser }

struct SelfUser: Codable, Identifiable, Hashable {
    let id: String
    var username: String?
    var displayName: String?
    var avatarUrl: String?
    var bannerUrl: String?
    var bio: String?
    var email: String?
    var status: String?
    var customStatus: String?
    var customStatusEmoji: String?
    /** ISO-8601 instant the custom status auto-clears, or nil for no expiry. */
    var customStatusExpiresAt: String?
    var isAdmin: Bool?
    var avatarDecoration: String?
    var guildFolders: [GuildFolder]?
    /// Achievements-on-profile visibility. Carried on the self user so the
    /// Settings toggle reads/writes it through the same durable, launch-
    /// hydrated path as every other profile setting.
    var achievementsPublic: Bool?

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
    var parentMessageId: String?
    var threadArchivedAt: String?
    var threadLastActivityAt: String?
    /// DM / group-DM only: the OTHER recipients (excludes the current user).
    var recipients: [PublicUser]?
    /// Shared-key E2EE state for 1:1 DMs.
    var e2eeEnabled: Bool?
    var e2eeSalt: String?
    var e2eeVerifier: String?
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
    /// Client-only send state for optimistic messages: "sending" | "failed" |
    /// nil (a normal/confirmed message). Absent from server JSON, so it decodes
    /// as nil and (being optional) is omitted when encoded.
    var sendState: String?

    var text: String { content ?? "" }
    var isSystem: Bool { type?.hasPrefix("system_") == true }
}

struct MessageMetadata: Codable, Hashable {
    var kind: String?
    var missed: Bool?
    var durationMs: Int?
    var initiatorId: String?
    /// kind == "streak_warning": the streak day count at warning time.
    var streak: Int?
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
            sendState: "sending"
        )
    }
}

struct MessageEmbed: Codable, Hashable {
    var url: String
    var kind: String?
    var title: String?
    var description: String?
    var imageUrl: String?
    var siteName: String?
    var faviconUrl: String?
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
    var creator: PublicUser?
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
    let ttlSecondsAfterRead: Int?
    /// This user's notification-preview choice for the DM. nil = not set
    /// (use the E2EE-aware default).
    var notificationShowContent: Bool?
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
    var joinedAt: String?
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

    var isImage: Bool { (contentType ?? "").hasPrefix("image/") }
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

    var id: String { userId }
    var isMuted: Bool { selfMute == true }
}

struct AuthSession: Codable {
    let user: SelfUser
    let accessToken: String
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

struct AdminUser: Codable, Identifiable {
    let id: String
    var username: String
    var displayName: String?
    var email: String?
    var avatarUrl: String?
    var isAdmin: Bool
    var bannedAt: String?
    var createdAt: String?
    var lastSeenAt: String?
    var name: String { displayName ?? username }
    var isBanned: Bool { bannedAt != nil }

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
        bannedAt = try? c.decode(String.self, forKey: .bannedAt)
        createdAt = try? c.decode(String.self, forKey: .createdAt)
        lastSeenAt = try? c.decode(String.self, forKey: .lastSeenAt)
    }
}
struct AdminUsersWrap: Codable { let users: [AdminUser] }

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
struct ChannelWrap: Codable { let channel: Channel }
struct MessagesWrap: Codable { let messages: [Message] }
struct MessageWrap: Codable { let message: Message }

/// Per-channel read marker: the last message the user has acked, plus the
/// count of direct mentions since that ack. Drives unread indicators.
struct ReadState: Codable {
    let channelId: String
    var lastMessageId: String?
    var mentionCount: Int?
}
struct ReadStatesWrap: Codable { let readStates: [ReadState] }
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

struct Mention: Codable, Identifiable {
    let id: String
    var channelId: String
    var createdAt: String
    var author: PublicUser?
    var content: String?
    var channelName: String?
    var guildId: String?

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
}
struct SendBody: Codable {
    let content: String
    let nonce: String
    var replyToId: String? = nil
}
struct OpenDMBody: Codable { let recipientId: String }
struct E2EEEnableBody: Codable { let salt: String; let verifier: String }
struct E2EEDisableBody: Codable { let verifier: String }
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
    let defaultChannelId: String?
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

/// One step of the LiveKit/voice diagnostic. `status` ∈ pass | fail | warn | skip.
struct LivekitCheck: Codable, Identifiable {
    let id: String
    let label: String
    let status: String
    let detail: String
}

/// Result of GET /admin/voice-diagnostic. No secrets — only config URLs and
/// classified guidance.
struct LivekitDiagnostic: Codable {
    let configured: Bool
    let ok: Bool
    let wsUrl: String?
    let httpUrl: String?
    let checks: [LivekitCheck]
    let generatedAt: String
}
struct DiagnosticWrap: Codable { let diagnostic: LivekitDiagnostic }

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
}

struct FamilyRestrictionsWrap: Codable {
    let restrictions: ChildRestrictions
    var blockedGuildIds: [String]?
}
struct FamilySummary: Codable {
    var restrictions: ChildRestrictions?
    var children: [FamilyUser]
    var outgoingRequests: [FamilyUser]
    var supervisedBy: [FamilyUser]
    var incomingRequests: [FamilyUser]
}

// MARK: Guild members (for resolving names in voice rosters, etc.)

struct GuildMember: Codable, Identifiable {
    var guildId: String?
    var userId: String
    var user: PublicUser
    var nickname: String?
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

/// A full-screen image presentation request.
struct LightboxImage: Identifiable {
    let id = UUID()
    /// Remote image (plain attachments) — loaded by URL.
    var url: URL? = nil
    /// In-memory image (E2EE attachments, already decrypted) — shown directly
    /// so encrypted media is previewed without ever exposing a plaintext URL.
    var image: UIImage? = nil
}

// MARK: - Permissions

struct PermissionDef: Identifiable {
    let bit: Int
    let key: String
    let label: String
    let group: String
    var id: String { key }
}

/// Permission bitfield catalog + helpers. Bits go up to 32 (MANAGE_EVENTS),
/// so the bitfield is a UInt64. Wire format is a decimal string. Mirrors
/// apps/web/src/lib/permissions.ts.
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
    static let MANAGE_EVENTS = 32

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
    var kind: String              // spam_limited | banned_word
    var userId: String?
    var username: String?
    var displayName: String?
    var guildId: String?
    var channelId: String?
    var detail: String
    var contentSnapshot: String?
    var createdAt: String
    var actorName: String { displayName ?? username ?? "Unknown" }
}
struct SecurityEventsWrap: Codable { let events: [SecurityEvent] }
struct SecurityWordsWrap: Codable { let words: [String] }

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
    var handledById: String?
    var handledAt: String?
    var resolutionNote: String?
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
    case auto, low, medium, high
    var id: String { rawValue }
    var shortLabel: String {
        switch self {
        case .auto: return "Auto"
        case .low: return "Low"
        case .medium: return "Medium"
        case .high: return "High"
        }
    }
    var detail: String {
        switch self {
        case .auto: return "Adapts to your connection (≈720p)."
        case .low: return "480p · saves bandwidth, good for slow networks."
        case .medium: return "720p · balanced."
        case .high: return "1080p · sharpest, needs a strong uplink."
        }
    }
}

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
        default: return "rosette"
        }
    }
}
struct AchievementsWrap: Codable {
    let achievements: [Achievement]
    var `public`: Bool?
}
