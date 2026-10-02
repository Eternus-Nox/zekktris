package com.zekktris.data.model

import kotlinx.serialization.Serializable

// Core wire models for the Zekktris API. Wire JSON is camelCase, so Kotlin
// property names match 1:1 and no @SerialName is needed. Ported field-for-field
// from ios-native/Zekktris/Models.swift + packages/client/src/types.ts.
// The Json decoder is configured with ignoreUnknownKeys=true, so DTO fields we
// don't model yet (poll, metadata, e2ee*, thread exotica…) are simply skipped.

@Serializable
data class PublicUser(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val avatarDecoration: String? = null,
    val bannerUrl: String? = null,
    val bio: String? = null,
    val status: String? = null,
    val customStatus: String? = null,
    val customStatusEmoji: String? = null,
    val customStatusExpiresAt: String? = null,
    val isBot: Boolean? = null,
    val canMessage: Boolean? = null,
    val tagLabel: String? = null,
    val tagColor: String? = null,
    val subscriptionTier: String? = null,
    val isAdmin: Boolean? = null,
    val isModerator: Boolean? = null,
    val staffColor: String? = null,
    val staffGlow: Boolean? = null,
    /** Last time this user was observed online, ISO 8601. Only ever populated by
     *  GET /users/@me/relationships and only for `type == "friend"` rows — every
     *  other surface (toPublicUser, member lists, message authors) omits it, so
     *  treat null as "unknown", never as "never online". Frozen while its owner
     *  is Invisible, so it can't leak their presence. */
    val lastSeenAt: String? = null,
) {
    val bestName: String get() = displayName ?: username ?: "Unknown"
}

@Serializable
data class GuildFolder(
    val id: String,
    val name: String? = null,
    val color: String? = null,
    val guildIds: List<String> = emptyList(),
)

// The authenticated /users/@me user — a superset of PublicUser plus self-only prefs.
@Serializable
data class SelfUser(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val avatarDecoration: String? = null,
    val bannerUrl: String? = null,
    val bio: String? = null,
    val status: String? = null,
    val customStatus: String? = null,
    val customStatusEmoji: String? = null,
    val customStatusExpiresAt: String? = null,
    val tagLabel: String? = null,
    val tagColor: String? = null,
    val subscriptionTier: String? = null,
    val isAdmin: Boolean? = null,
    val isModerator: Boolean? = null,
    val staffColor: String? = null,
    val staffGlow: Boolean? = null,
    // self-only
    val email: String? = null,
    val emailVerified: Boolean? = null,
    val locale: String? = null,
    val guildOrder: List<String>? = null,
    val guildFolders: List<GuildFolder>? = null,
    val dmReadReceiptsEnabled: Boolean? = null,
    val allowDmsFromServerMembers: Boolean? = null,
    val achievementsPublic: Boolean? = null,
    val notifyAchievements: Boolean? = null,
    val notifyReactions: Boolean? = null,
    val showSubscriptionTier: Boolean? = null,
    val subscriptionExpiresAt: String? = null,
    val subscriptionInherited: Boolean? = null,
    /** "gift" | "founder" | "stripe". "stripe" = a subscription bought before
     *  Zekktris went free; Settings links to web Settings to stop it. */
    val subscriptionSource: String? = null,
    /** True when the tier shows a title on the profile; founder/untitled rows
     *  have nothing to hide (gates the "Show my perk tier" toggle). */
    val subscriptionTitled: Boolean? = null,
    val dateOfBirth: String? = null,
    val canChangeDob: Boolean? = null,
    val createdAt: String? = null,
    val updatedAt: String? = null,
) {
    val bestName: String get() = displayName ?: username ?: "Unknown"
}

@Serializable
data class Guild(
    val id: String,
    val name: String,
    val description: String? = null,
    val iconUrl: String? = null,
    val bannerUrl: String? = null,
    val ownerId: String? = null,
    val systemChannelId: String? = null,
    val rulesContent: String? = null,
    val discoverable: Boolean? = null,
    val discoveryDescription: String? = null,
    val discoveryCategory: String? = null,
)

@Serializable
data class GuildMember(
    val guildId: String? = null,
    val userId: String,
    val user: PublicUser,
    val roleIds: List<String> = emptyList(),
    val joinedAt: String? = null,
    val communicationDisabledUntil: String? = null,
    val membershipState: String? = null,
    val rulesAcknowledgedAt: String? = null,
)

/** A guild role. `color` is an RGB integer (0 = no color); `hoist` shows the
 *  role as its own section in the member list. Drives name colors + sections. */
@Serializable
data class Role(
    val id: String,
    val guildId: String? = null,
    val name: String = "",
    val color: Int = 0,
    val position: Int = 0,
    val hoist: Boolean = false,
    val mentionable: Boolean? = null,
    val selfAssignable: Boolean? = null,
    /** Decimal-string permission bitfield (see [Permissions]). */
    val permissions: String? = null,
    /** True for the auto-managed integration/@everyone role — not editable. */
    val managed: Boolean? = null,
    val description: String? = null,
) {
    /** The implicit @everyone role has id == guildId (server convention). */
    val isEveryone: Boolean get() = id == guildId
}

@Serializable data class RolesWrap(val roles: List<Role> = emptyList())
@Serializable data class RoleWrap(val role: Role)

/** A guild audit-log entry (moderation action trail). `changes` is a free-form
 *  JSON object shown pretty-printed. Mirrors iOS AuditEntry. */
@Serializable
data class AuditEntry(
    val id: String,
    val guildId: String = "",
    val actor: PublicUser? = null,
    val action: String = "",
    val targetType: String = "",
    val targetId: String? = null,
    val changes: kotlinx.serialization.json.JsonElement? = null,
    val reason: String? = null,
    val createdAt: String = "",
) {
    val actorName: String get() = actor?.bestName ?: "Unknown moderator"
}
@Serializable data class AuditLogWrap(val entries: List<AuditEntry> = emptyList())

/** A member report (moderation queue item). `messageContent` is a snapshot
 *  captured at file time so it survives deletion. Mirrors iOS Report. */
@Serializable
data class Report(
    val id: String,
    val guildId: String = "",
    val reporter: PublicUser? = null,
    val targetType: String = "",   // "message" | "user"
    val targetUser: PublicUser? = null,
    val messageId: String? = null,
    val channelId: String? = null,
    val messageContent: String? = null,
    val reason: String = "",       // spam | harassment | nsfw | violence | other
    val details: String? = null,
    val status: String = "open",   // open | resolved | dismissed
    val createdAt: String = "",
) {
    val reporterName: String get() = reporter?.bestName ?: "Unknown"
    val targetName: String get() = targetUser?.bestName ?: (if (targetType == "user") "Unknown user" else "a message")
    val reasonLabel: String get() = when (reason) {
        "spam" -> "Spam"; "harassment" -> "Harassment"; "nsfw" -> "NSFW"; "violence" -> "Violence"; "other" -> "Other"; else -> reason
    }
}
@Serializable data class ReportsWrap(val reports: List<Report> = emptyList(), val openCount: Int = 0)
@Serializable data class ReportWrap(val report: Report)

/** A per-channel permission override (role or member) — tri-state allow/deny
 *  bitfields layered over the base role permissions. Mirrors iOS. */
@Serializable
data class PermissionOverride(
    val channelId: String? = null,
    val targetType: String = "role", // "role" | "member"
    val targetId: String,
    val allow: String = "0",
    val deny: String = "0",
)
@Serializable data class PermissionOverridesWrap(val overrides: List<PermissionOverride> = emptyList())

/** A reaction-role mapping: reacting to `messageId` with `emoji` grants `roleId`. */
@Serializable
data class ReactionRoleMapping(
    val messageId: String,
    val emoji: String,
    val channelId: String? = null,
    val roleId: String,
)
@Serializable data class ReactionRolesWrap(val reactionRoles: List<ReactionRoleMapping> = emptyList())

/** Permission bitfield catalog + helpers. Bits go up to 32 (MANAGE_EVENTS) so
 *  the bitfield is a 64-bit Long. Wire format is a decimal string. Mirrors
 *  ios-native Models.swift `Permissions` + apps/web/src/lib/permissions.ts. */
object Permissions {
    const val ADMINISTRATOR = 0
    const val VIEW_CHANNEL = 1
    const val MANAGE_MESSAGES = 4
    const val MANAGE_CHANNELS = 10
    const val MANAGE_ROLES = 12
    const val KICK_MEMBERS = 13
    const val BAN_MEMBERS = 14
    const val MODERATE_MEMBERS = 17
    const val MANAGE_GUILD = 18
    const val VIEW_AUDIT_LOG = 19
    const val MANAGE_WEBHOOKS = 20
    const val MANAGE_EMOJIS = 21
    const val MANAGE_INVITES = 22
    const val MANAGE_EVENTS = 32

    data class Def(val bit: Int, val key: String, val label: String, val group: String)

    val all: List<Def> = listOf(
        Def(0,  "ADMINISTRATOR", "Administrator", "General"),
        Def(18, "MANAGE_GUILD", "Manage Server", "General"),
        Def(12, "MANAGE_ROLES", "Manage Roles", "General"),
        Def(10, "MANAGE_CHANNELS", "Manage Channels", "General"),
        Def(1,  "VIEW_CHANNEL", "View Channels", "General"),
        Def(19, "VIEW_AUDIT_LOG", "View Audit Log", "General"),
        Def(11, "CREATE_INVITE", "Create Invite", "Membership"),
        Def(22, "MANAGE_INVITES", "Manage Invites", "Membership"),
        Def(13, "KICK_MEMBERS", "Kick Members", "Membership"),
        Def(14, "BAN_MEMBERS", "Ban Members", "Membership"),
        Def(17, "MODERATE_MEMBERS", "Time Out Members", "Membership"),
        Def(15, "CHANGE_NICKNAME", "Change Own Nickname", "Membership"),
        Def(16, "MANAGE_NICKNAMES", "Manage Nicknames", "Membership"),
        Def(3,  "SEND_MESSAGES", "Send Messages", "Text"),
        Def(2,  "READ_MESSAGE_HISTORY", "Read Message History", "Text"),
        Def(5,  "ATTACH_FILES", "Attach Files", "Text"),
        Def(6,  "EMBED_LINKS", "Embed Links", "Text"),
        Def(7,  "ADD_REACTIONS", "Add Reactions", "Text"),
        Def(4,  "MANAGE_MESSAGES", "Manage Messages", "Text"),
        Def(9,  "MENTION_EVERYONE", "Mention @everyone & Roles", "Text"),
        Def(8,  "USE_EXTERNAL_EMOJIS", "Use External Emoji", "Text"),
        Def(23, "CONNECT", "Connect", "Voice"),
        Def(24, "SPEAK", "Speak", "Voice"),
        Def(30, "STREAM", "Video / Screen Share", "Voice"),
        Def(28, "USE_VAD", "Voice Activity", "Voice"),
        Def(25, "MUTE_MEMBERS", "Mute Members", "Voice"),
        Def(26, "DEAFEN_MEMBERS", "Deafen Members", "Voice"),
        Def(27, "MOVE_MEMBERS", "Move Members", "Voice"),
        Def(29, "PRIORITY_SPEAKER", "Priority Speaker", "Voice"),
        Def(20, "MANAGE_WEBHOOKS", "Manage Webhooks", "Advanced"),
        Def(21, "MANAGE_EMOJIS", "Manage Emoji", "Advanced"),
        Def(32, "MANAGE_EVENTS", "Manage Events", "Advanced"),
    )
    val groupOrder = listOf("General", "Membership", "Text", "Voice", "Advanced")

    fun mask(b: Int): Long = 1L shl b
    val allBits: Long get() = all.fold(0L) { acc, d -> acc or mask(d.bit) }
    /** Parse the decimal-string wire format; 0 on null/garbage (matches iOS). */
    fun parse(s: String?): Long = s?.toLongOrNull() ?: 0L
    fun serialize(bits: Long): String = bits.toString()
    fun has(bits: Long, b: Int): Boolean = (bits and mask(b)) != 0L
}

/** A profile achievement. `marker` is the badge glyph/emoji; locked entries
 *  (earned == false) carry `goal`/`value` progress. */
@Serializable
data class Achievement(
    val id: String,
    val name: String = "",
    val description: String = "",
    val marker: String = "🏅",
    val value: Int = 0,
    val earned: Boolean? = null,
    val goal: Int? = null,
) {
    val isEarned: Boolean get() = earned ?: true
}

@Serializable data class AchievementsWrap(val achievements: List<Achievement> = emptyList())

// Also serves as the DM / group-DM wrapper: type=dm|group_dm with `recipients` populated.
@Serializable
data class Channel(
    val id: String,
    val type: String,
    val guildId: String? = null,
    val parentId: String? = null,
    val name: String? = null,
    val topic: String? = null,
    val position: Int? = null,
    val nsfw: Boolean? = null,
    val rateLimitPerUser: Int? = null,
    val lastMessageId: String? = null,
    val recipients: List<PublicUser>? = null,
    val streak: Int? = null,
    val restricted: Boolean? = null,
    val linkUrl: String? = null,
    val threadArchivedAt: String? = null,
    val createdAt: String? = null,
    // Shared-key E2EE state for 1:1 DMs (same value seen by both participants).
    val e2eeEnabled: Boolean? = null,
    val e2eeSalt: String? = null,
    val e2eeVerifier: String? = null,
) {
    val isE2EE: Boolean get() = e2eeEnabled == true
    val isDM: Boolean get() = type == "dm" || type == "group_dm"
    val isVoice: Boolean get() = type.contains("voice") || type.contains("stage")
    val isStage: Boolean get() = type == "guild_stage"
    val isCategory: Boolean get() = type.contains("category")
    val isText: Boolean get() = type == "text" || type == "guild_text"
    val isForum: Boolean get() = type == "guild_forum"
    val isThread: Boolean get() = type == "thread" || parentId != null && (type == "public_thread" || type == "private_thread")
    val isTextLike: Boolean get() = !isVoice && !isCategory
}

@Serializable
data class Attachment(
    val id: String,
    val url: String,
    val filename: String? = null,
    val contentType: String? = null,
    val size: Long? = null,
    val width: Int? = null,
    val height: Int? = null,
    val isVoiceMessage: Boolean? = null,
    val durationSeconds: Int? = null,
    val waveform: String? = null,
    val thumbnailUrl: String? = null,
    /**
     * ISO-8601 timestamp of when media retention aged out the FULL-SIZE object,
     * or null while the original is still stored (the normal case). Defaulted so
     * payloads from before blob expiry shipped still decode.
     *
     * Non-null means [url] no longer resolves — never fetch, open, play, save or
     * share it. Everything the expired state needs survives: [thumbnailUrl]
     * (kept forever, and only ever expired when a thumbnail exists) plus
     * filename/size/width/height. The server deliberately keeps [url] populated
     * (it is non-optional in every shipped client), so gate on THIS field —
     * never on a missing or empty url.
     */
    val blobExpiredAt: String? = null,
) {
    val isImage: Boolean get() = contentType?.startsWith("image/") == true
    val isVideo: Boolean get() = contentType?.startsWith("video/") == true

    /**
     * The server no longer stores the full-size original: render from the
     * thumbnail and keep every full-size path (lightbox, player, save) shut.
     */
    val blobExpired: Boolean get() = blobExpiredAt != null
}

@Serializable
data class ReactionAggregate(
    val emoji: String,
    val count: Int = 0,
    val me: Boolean = false,
)

@Serializable
data class EmbedField(
    val name: String,
    val value: String,
    val inline: Boolean = false,
)

@Serializable
data class MessageEmbed(
    val url: String,
    val kind: String? = null,
    val title: String? = null,
    val description: String? = null,
    val imageUrl: String? = null,
    val siteName: String? = null,
    val faviconUrl: String? = null,
    val color: Int? = null,
    val authorName: String? = null,
    val authorIconUrl: String? = null,
    val thumbnailUrl: String? = null,
    val fields: List<EmbedField>? = null,
    val footerText: String? = null,
    val footerIconUrl: String? = null,
    val timestamp: String? = null,
)

@Serializable
data class Sticker(
    val id: String,
    val guildId: String? = null,
    val name: String,
    val description: String? = null,
    val url: String,
    val animated: Boolean = false,
)

@Serializable
data class ForwardChannel(
    val id: String,
    val name: String? = null,
    val type: String? = null,
)

@Serializable
data class ForwardSource(
    val messageId: String,
    val channel: ForwardChannel? = null,
    val author: PublicUser? = null,
    val content: String = "",
)

@Serializable
data class Message(
    val id: String,
    val channelId: String,
    val createdAt: String,
    val authorId: String? = null,
    val author: PublicUser? = null,
    val type: String = "default",
    val content: String = "",
    val editedAt: String? = null,
    val replyToId: String? = null,
    val pinned: Boolean = false,
    val mentionsEveryone: Boolean = false,
    val mentionedUserIds: List<String> = emptyList(),
    val mentionedRoleIds: List<String> = emptyList(),
    val attachments: List<Attachment> = emptyList(),
    val reactions: List<ReactionAggregate> = emptyList(),
    val embeds: List<MessageEmbed>? = null,
    val stickerId: String? = null,
    val sticker: Sticker? = null,
    val forwardedFromMessageId: String? = null,
    val forwardedFrom: ForwardSource? = null,
    val webhookId: String? = null,
    val authorOverrideName: String? = null,
    val authorOverrideAvatar: String? = null,
    val deliveredAt: String? = null,
    val viewedAt: String? = null,
    val nonce: String? = null,
    val metadata: MessageMetadata? = null,
    val poll: Poll? = null,
)

/** Free-form message metadata; `kind` marks notice rows (poke / streak_warning).
 *  system_call messages carry `missed` / `durationMs` / `initiatorId`. */
@Serializable
data class MessageMetadata(
    val kind: String? = null,
    val pokeType: String? = null,
    val initiatorId: String? = null,
    val missed: Boolean? = null,
    val durationMs: Long? = null,
)

@Serializable
data class PollOption(
    val id: String,
    val text: String,
    val position: Int = 0,
    val voteCount: Int = 0,
)

@Serializable
data class Poll(
    val id: String,
    val question: String,
    val multipleChoice: Boolean = false,
    val options: List<PollOption> = emptyList(),
    val totalVoters: Int = 0,
    val myVotes: List<String> = emptyList(),
    val expiresAt: String? = null,
    val closedAt: String? = null,
) {
    val isExpired: Boolean
        get() = expiresAt?.let { runCatching { java.time.Instant.parse(it) <= java.time.Instant.now() }.getOrDefault(false) } ?: false
    val isOpen: Boolean get() = closedAt == null && !isExpired
}

// ── Device-approval login ("approve this login on your phone") ──────────────
// Replaces the old quick-login direction. The LOGGED-OUT device opens a request
// and displays `userCode`; the already logged-in phone scans/types it, reviews
// the requesting device, and approves — then the logged-out device collects a
// session. Mirrors packages/client/src/types.ts (DeviceLoginStart & co).
//
// TWO SECRETS, NOT INTERCHANGEABLE:
//   userCode   — 8 chars, shown on screen and in the QR. Public by design.
//                Only an AUTHENTICATED caller can do anything with it, and it
//                never yields a session.
//   deviceCode — 256 bits, handed to the starting device exactly once. It alone
//                collects the tokens, so it is held in a local variable for the
//                life of the poll loop and NEVER rendered, QR'd, logged, or
//                persisted. See apps/api/src/auth/device-login-store.ts.

/** Result of POST /auth/device-login/start. Seconds for both durations. */
@Serializable
data class DeviceLoginStart(
    /** Display + QR this. Already formatted `ABCD-EFGH` by the server. */
    val userCode: String,
    /** SECRET — memory only, never shown. */
    val deviceCode: String,
    val expiresIn: Int = 300,
    val interval: Int = 5,
)

/**
 * The device asking to be logged in, as rendered on the approval screen.
 *
 * THE SPLIT IS THE WHOLE POINT and the approval UI must preserve it.
 * [ipAddress] / [sameNetwork] / [requestedAt] are observed by the server and a
 * remote phisher cannot forge them. [declaredName] / [userAgent] / [platform] /
 * [locale] are whatever the requesting device claimed — an attacker will
 * happily call themselves "Your Pixel". Present those as claims, never facts.
 */
@Serializable
data class DeviceLoginDeviceInfo(
    /** UNTRUSTED, device-supplied label. */
    val declaredName: String? = null,
    /** UNTRUSTED, device-supplied User-Agent. */
    val userAgent: String? = null,
    /** UNTRUSTED — derived from the User-Agent. ios|android|web|desktop|unknown. */
    val platform: String = "unknown",
    /** UNTRUSTED — from Accept-Language. A locale, NOT a location. */
    val locale: String? = null,
    /** SERVER-OBSERVED source IP of the requesting device. */
    val ipAddress: String? = null,
    /** SERVER-OBSERVED: the requester shares this device's /24 (or IPv6 /48).
     *  A hint, not proof — but a remote attacker can never make it true. */
    val sameNetwork: Boolean = false,
    /** ISO-8601, server-observed. */
    val requestedAt: String? = null,
    /** Always null today — the server does no GeoIP and will not guess. */
    val approxLocation: String? = null,
)

/** Result of POST /auth/device-login/lookup. */
@Serializable
data class DeviceLoginRequestInfo(
    val userCode: String,
    /** Seconds left before the request expires. */
    val expiresIn: Int = 0,
    val device: DeviceLoginDeviceInfo = DeviceLoginDeviceInfo(),
)

/** Wire shape of POST /auth/device-login/start's body. */
@Serializable
data class DeviceLoginStartBody(val deviceName: String? = null)

/** Wire shape for poll (the SECRET code) — never log an instance of this. */
@Serializable
data class DeviceLoginPollBody(val deviceCode: String)

/** Wire shape for lookup/approve/deny (the public short code). */
@Serializable
data class DeviceLoginCodeBody(val userCode: String)

/**
 * Wire shape of POST /auth/device-login/poll. Flattened rather than a sealed
 * hierarchy because the server discriminates on a plain `status` string with
 * no polymorphic wrapper; [com.zekktris.data.ApiClient.deviceLoginPoll] maps it
 * to the sealed [com.zekktris.data.DeviceLoginPoll] callers actually consume.
 */
@Serializable
data class DeviceLoginPollResponse(
    val status: String = "expired",
    val interval: Int? = null,
    val user: SelfUser? = null,
    val accessToken: String? = null,
    val expiresIn: Int? = null,
)

@Serializable
data class ReadState(
    val channelId: String,
    val lastMessageId: String? = null,
    val mentionCount: Int = 0,
)
