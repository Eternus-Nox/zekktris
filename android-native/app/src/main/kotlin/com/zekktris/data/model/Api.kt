package com.zekktris.data.model

import kotlinx.serialization.Serializable

// Response envelopes — every list/single endpoint returns a single-key object.
@Serializable data class GuildsWrap(val guilds: List<Guild> = emptyList())
@Serializable data class GuildWrap(val guild: Guild)
@Serializable data class ChannelsWrap(val channels: List<Channel> = emptyList())
@Serializable data class ChannelWrap(val channel: Channel)
@Serializable data class ThreadsWrap(val threads: List<Channel> = emptyList())
@Serializable data class ForumPostResult(val post: Channel, val message: Message)

// A guild's custom emoji (uploaded image, referenced in text as :name:).
@Serializable data class GuildEmoji(
    val id: String,
    val guildId: String? = null,
    val name: String = "",
    val url: String = "",
    val animated: Boolean? = null,
)
@Serializable data class EmojisWrap(val emojis: List<GuildEmoji> = emptyList())
@Serializable data class EmojiWrap(val emoji: GuildEmoji)

// Shared-key E2EE enable/disable bodies (salt + verifier derived client-side).
@Serializable data class E2EEEnableBody(val salt: String, val verifier: String)
@Serializable data class E2EEDisableBody(val verifier: String)
@Serializable data class MessagesWrap(val messages: List<Message> = emptyList())
@Serializable data class MessageWrap(val message: Message)
@Serializable data class ChannelAttachmentsWrap(val attachments: List<Attachment> = emptyList())
@Serializable data class MembersWrap(val members: List<GuildMember> = emptyList())
@Serializable data class MemberWrap(val member: GuildMember)
@Serializable data class ReadStatesWrap(val readStates: List<ReadState> = emptyList())
@Serializable data class AckWrap(val readState: ReadState)
@Serializable data class UserWrap(val user: SelfUser)
@Serializable data class PublicUserWrap(val user: PublicUser)

// Auth request/response bodies.
@Serializable
data class LoginRequest(val email: String, val password: String, val code: String? = null)

@Serializable
data class RegisterRequest(
    val email: String,
    val username: String,
    val displayName: String,
    val password: String,
    val dateOfBirth: String,
    val code: String? = null,
)

@Serializable
data class AuthResponse(val user: SelfUser, val accessToken: String, val expiresIn: Int = 900)

@Serializable
data class RefreshResponse(val accessToken: String, val expiresIn: Int = 900)

// Special 401 body on /auth/login when a TOTP/recovery code is required.
@Serializable
data class TwoFactorChallenge(val requires2FA: Boolean = false)

// POST /users/@me/channels — open/create a 1:1 DM.
@Serializable
data class OpenDMBody(val recipientId: String)

// POST /channels/{id}/messages — JSON send body.
@Serializable
data class SendMessageBody(
    val content: String = "",
    val nonce: String? = null,
    val replyToId: String? = null,
    val forwardFromMessageId: String? = null,
)

// POST /users/@me/device-tokens — register this device's FCM push token.
@Serializable
data class DeviceTokenBody(
    val token: String,
    // NO DEFAULT, deliberately. kotlinx.serialization omits a property whose
    // value equals its default unless encodeDefaults is on (it is not, and
    // turning it on globally would change every PATCH body that relies on
    // absence meaning "leave alone"). With `= "android"` here, the field was
    // dropped from the request EVEN THOUGH the call site passes it explicitly,
    // so the server applied its own default of 'ios' and filed every Android
    // FCM token as an APNs one. It then never matched listAndroidTokens, so no
    // Android push could ever be sent — and APNs kept 400ing the FCM token and
    // pruning the row, which is why the ios count oscillated.
    val platform: String,
    val label: String? = null,
)

// ── Discovery (GET /discovery) ───────────────────────────────────────────────
@Serializable
data class DiscoverableGuild(
    val id: String,
    val name: String,
    val description: String? = null,
    val discoveryDescription: String? = null,
    val discoveryCategory: String? = null,
    val iconUrl: String? = null,
    val bannerUrl: String? = null,
    val memberCount: Int? = null,
)

@Serializable
data class DiscoveryWrap(val guilds: List<DiscoverableGuild> = emptyList())

// ── Invites (GET/POST /invites/:code) ────────────────────────────────────────
@Serializable
data class InvitePreviewGuild(
    val id: String,
    val name: String,
    val iconUrl: String? = null,
    val bannerUrl: String? = null,
    val description: String? = null,
    val memberCount: Int = 0,
)

@Serializable
data class InvitePreview(val code: String, val guild: InvitePreviewGuild)

@Serializable
data class InvitePreviewWrap(val invite: InvitePreview)

@Serializable
data class AcceptInviteResult(val guildId: String, val channelId: String? = null)

// Created / manageable invite (POST /channels/:id/invites, GET /guilds/:id/invites).
@Serializable
data class Invite(
    val code: String,
    val channelId: String? = null,
    val guildId: String? = null,
    val uses: Int? = null,
    val maxUses: Int? = null,
    val expiresAt: String? = null,
)

@Serializable data class InviteWrap(val invite: Invite)
@Serializable data class InvitesWrap(val invites: List<Invite> = emptyList())

// ── Voice ─────────────────────────────────────────────────────────────────
// A user's presence in a voice room. channelId == null ⇒ the user LEFT voice.
@Serializable
data class VoiceState(
    val userId: String,
    val channelId: String? = null,
    val guildId: String? = null,
    val sessionId: String? = null,
    val selfMute: Boolean? = null,
    val selfDeaf: Boolean? = null,
)

// POST /channels/:id/voice/join — token + wsUrl null ⇒ SFU not configured
// (presence-only, no audio). The room name is baked into the JWT server-side.
@Serializable
data class JoinVoiceResult(
    val voiceState: VoiceState? = null,
    val channelVoiceStates: List<VoiceState> = emptyList(),
    val token: String? = null,
    val wsUrl: String? = null,
)

@Serializable data class VoiceStateWrap(val voiceState: VoiceState)

// ── Stage channels ──────────────────────────────────────────────────────────
// One row per user in a stage room (server StageParticipantDTO): speakers
// publish audio, audience listens; `handRaised` is audience-only.
@Serializable
data class StageParticipant(
    val channelId: String? = null,
    val userId: String,
    val isSpeaker: Boolean = false,
    val handRaised: Boolean = false,
    val joinedAt: String? = null,
)

// POST /channels/:id/stage/join — token/wsUrl null ⇒ SFU not configured.
// The token's publish grant is gated on `participant.isSpeaker` server-side.
@Serializable
data class StageJoinResult(
    val participant: StageParticipant,
    val token: String? = null,
    val wsUrl: String? = null,
)

// GET /channels/:id/stage — the channel + the full roster.
@Serializable
data class StageParticipantsResult(
    val channel: Channel? = null,
    val participants: List<StageParticipant> = emptyList(),
)

// ── Notification overrides (per-guild / per-channel level) ──────────────────
@Serializable data class NotificationOverride(val targetType: String, val targetId: String, val level: String? = null)
@Serializable data class NotificationOverridesWrap(val overrides: List<NotificationOverride> = emptyList())

// ── Create server (POST /guilds) ─────────────────────────────────────────────
@Serializable
data class CreateGuildBody(val name: String, val description: String? = null)

@Serializable
data class CreateGuildResult(val guild: Guild)

// ── Family / parental controls ───────────────────────────────────────────────
@Serializable
data class FamilyUser(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
) {
    val name: String get() = displayName ?: username ?: "Unknown"
}

@Serializable
data class ChildRestrictions(
    val canAddFriends: Boolean = true,
    val canRemoveFriends: Boolean = true,
    val allowVoice: Boolean = true,
    val allowVideo: Boolean = true,
    val allowStream: Boolean = true,
    val allowCreateGuild: Boolean = true,
    val allowJoinGuilds: Boolean = true,
    val allowMessaging: Boolean = true,
    val dmPolicy: String = "all", // "none" | "friends" | "all"
    val filterProfanity: Boolean = true,
)

@Serializable
data class FamilySummary(
    val restrictions: ChildRestrictions? = null,
    val isMinor: Boolean? = null,
    val graceActive: Boolean? = null,
    val graceDaysRemaining: Int? = null,
    val restrictedHeavily: Boolean? = null,
    val children: List<FamilyUser> = emptyList(),
    val outgoingRequests: List<FamilyUser> = emptyList(),
    val incomingChildRequests: List<FamilyUser>? = null,
    val supervisedBy: List<FamilyUser> = emptyList(),
    val incomingRequests: List<FamilyUser> = emptyList(),
    val outgoingParentRequests: List<FamilyUser>? = null,
)

@Serializable data class FamilyRestrictionsWrap(val restrictions: ChildRestrictions)

// ── Family child oversight ───────────────────────────────────────────────────
@Serializable data class WatchWordsWrap(val words: List<String> = emptyList())
@Serializable data class WatchWordBody(val word: String)

@Serializable
data class FamilyFlag(
    val id: String,
    val messageId: String = "",
    val channelId: String = "",
    val matchedWord: String = "",
    val direction: String = "",   // sent | received
    val createdAt: String = "",
    val reviewed: Boolean = false,
    val byChild: Boolean = false,
    val snippet: String? = null,
)
@Serializable data class FamilyFlagsWrap(val flags: List<FamilyFlag> = emptyList())

@Serializable data class ChildGuild(val id: String, val name: String = "", val iconUrl: String? = null, val blocked: Boolean = false)
@Serializable data class ChildGuildsWrap(val guilds: List<ChildGuild> = emptyList())
@Serializable data class ChildRelationship(val type: String, val createdAt: String? = null, val user: PublicUser)
@Serializable data class ChildRelationshipsWrap(val relationships: List<ChildRelationship> = emptyList())

// Read-only oversight of a supervised child's 1:1 DM conversations.
// GET /family/children/:id/channels → { channels: [ChildDM] }
@Serializable data class ChildDMRecipient(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
) {
    val bestName: String get() = displayName ?: username ?: "Unknown"
}
@Serializable data class ChildDM(
    val id: String,
    val lastMessageId: String? = null,
    val recipient: ChildDMRecipient? = null,
)
@Serializable data class ChildDMsWrap(val channels: List<ChildDM> = emptyList())

// Slim moderation-view message DTO, shared by /admin/.../peek and
// /family/children/:id/channels/:cid/messages → { messages: [PeekMessage] }.
@Serializable data class PeekAttachment(
    val id: String,
    val filename: String? = null,
    val url: String? = null,
    val contentType: String? = null,
    /** Kept forever by attachment retention; [url] may be a dead path. */
    val thumbnailUrl: String? = null,
    /**
     * Non-null ⇒ the FULL-SIZE object has been reclaimed. [url] is still
     * populated and still points at the dead path, so gate on THIS, never on a
     * missing url. A parent reviewing months-old DMs is the reader most likely
     * to hit expired media.
     */
    val blobExpiredAt: String? = null,
    // Long, not Int: a file over ~2 GB would otherwise fail to decode and
    // abort the whole peek/child-DM message list (matches Attachment.size).
    val size: Long? = null,
)
@Serializable data class PeekReaction(val emoji: String, val count: Int = 0)
@Serializable data class PeekMessage(
    val id: String,
    val channelId: String? = null,
    val authorId: String? = null,
    val authorUsername: String? = null,
    val authorDisplayName: String? = null,
    val authorAvatarUrl: String? = null,
    val content: String? = null,
    val createdAt: String = "",
    val editedAt: String? = null,
    // Supervision only: the child deleted this message, but parents still see it.
    val deleted: Boolean? = null,
    val attachments: List<PeekAttachment>? = null,
    val reactions: List<PeekReaction>? = null,
) {
    val authorName: String get() = authorDisplayName ?: authorUsername ?: "Unknown"
}
@Serializable data class PeekMessagesWrap(val messages: List<PeekMessage> = emptyList())

@Serializable data class FamilyLinkBody(val username: String)
@Serializable data class RequestParentBody(val email: String)

// PATCH /channels/{id}/messages/{mid} — edit a message's content.
@Serializable
data class EditMessageBody(val content: String)

// ── Friends / relationships ──────────────────────────────────────────────────
@Serializable
data class Relationship(
    val type: String, // friend | incoming_request | outgoing_request | blocked
    val createdAt: String? = null,
    val user: PublicUser,
)

@Serializable data class RelationshipsWrap(val relationships: List<Relationship> = emptyList())
@Serializable data class AddFriendBody(val username: String)
@Serializable data class BlockBody(val targetId: String)

// ── Mentions inbox ───────────────────────────────────────────────────────────
@Serializable
data class Mention(
    val id: String,
    val channelId: String,
    val createdAt: String,
    val author: PublicUser? = null,
    val content: String? = null,
    val channelName: String? = null,
    val guildId: String? = null,
    val type: String? = null,
)

@Serializable data class MentionsWrap(val mentions: List<Mention> = emptyList())

// ── Saved messages ───────────────────────────────────────────────────────────
@Serializable
data class SavedChannel(
    val id: String,
    val type: String? = null,
    val name: String? = null,
    val guildId: String? = null,
)

@Serializable
data class SavedMessageItem(
    val savedAt: String,
    val message: Message,
    val channel: SavedChannel? = null,
)

@Serializable data class SavedListWrap(val items: List<SavedMessageItem> = emptyList(), val nextCursor: String? = null)

// ── Scheduled messages ───────────────────────────────────────────────────────
@Serializable
data class ScheduledMessage(
    val id: String,
    val channelId: String? = null,
    val content: String? = null,
    val scheduledFor: String,
    val attempts: Int? = null,
    val lastError: String? = null,
)

@Serializable data class ScheduledListWrap(val items: List<ScheduledMessage> = emptyList())
@Serializable data class ScheduledWrap(val scheduled: ScheduledMessage)

// ── Personal DM nicknames (viewer-private, shown in DMs only) ─────────────────
@Serializable data class DmNicknamesWrap(val nicknames: Map<String, String> = emptyMap())
@Serializable data class DmNicknameBody(val nickname: String)

// ── Bots (owner-facing management) ────────────────────────────────────────────
@Serializable
data class Bot(
    val id: String,
    val username: String? = null,
    val displayName: String? = null,
    val avatarUrl: String? = null,
    val isBot: Boolean? = null,
    /** Configured event callback URL, or null if the bot has no subscription. */
    val botEventUrl: String? = null,
) {
    val name: String get() = displayName ?: username ?: "Bot"
}

@Serializable data class BotListWrap(val bots: List<Bot> = emptyList())
@Serializable data class BotWrap(val bot: Bot)
/** Create-bot response: the bot plus its one-time plaintext token. */
@Serializable data class BotCreateResponse(val bot: Bot, val token: String)
/** Regenerate-token response: just the new one-time plaintext token. */
@Serializable data class BotTokenResponse(val token: String)
/** Event-config response: the saved URL + the signing secret (shown once). */
@Serializable data class BotEventConfigResponse(val eventUrl: String? = null, val secret: String? = null)
@Serializable data class BotCreateBody(val username: String, val displayName: String)
@Serializable data class AddBotBody(val botId: String)

// ── Pokes ────────────────────────────────────────────────────────────────────
@Serializable data class PokeBody(val pokeType: String)

@Serializable
data class PokeHistoryEntry(
    val id: String,
    val pokeType: String = "poke",
    val initiatorId: String = "",
    val recipientId: String = "",
    val createdAt: String = "",
    val initiatorName: String = "Someone",
)

@Serializable data class PokesWrap(val pokes: List<PokeHistoryEntry> = emptyList())

// ── Per-DM settings ──────────────────────────────────────────────────────────
@Serializable
data class DmChannelSettings(
    val ttlSecondsAfterRead: Int? = null,
    val notificationShowContent: Boolean? = null,
)

@Serializable data class DmTtlPatch(val ttlSecondsAfterRead: Int?)
@Serializable data class NotificationPreviewPatch(val showContent: Boolean?)

// ── Account security ─────────────────────────────────────────────────────────
@Serializable data class ChangePasswordBody(val currentPassword: String, val newPassword: String)
@Serializable data class ChangeUsernameBody(val username: String, val currentPassword: String)
@Serializable data class ChangeEmailBody(val newEmail: String, val currentPassword: String)
@Serializable data class TotpConfirmBody(val code: String, val currentPassword: String)
@Serializable data class TotpCodeBody(val code: String)

@Serializable
data class TwoFactorStatus(val enabled: Boolean = false, val verifiedAt: String? = null, val recoveryRemaining: Int = 0)

@Serializable data class TwoFactorSecret(val secret: String, val otpauthUri: String)
@Serializable data class TwoFactorRecovery(val recoveryCodes: List<String> = emptyList())

@Serializable
data class SessionInfo(
    val id: String,
    val userAgent: String? = null,
    val ipAddress: String? = null,
    val createdAt: String? = null,
    val lastUsedAt: String? = null,
    val expiresAt: String? = null,
    val current: Boolean = false,
)

@Serializable data class SessionsWrap(val sessions: List<SessionInfo> = emptyList())

// ── Passkeys (WebAuthn via CredentialManager) ────────────────────────────────
/** Server-issued ceremony: a challengeId + the raw WebAuthn options JSON, which
 *  is handed straight to the Android CredentialManager as its requestJson. */
@Serializable data class PasskeyOptionsResponse(val challengeId: String, val options: kotlinx.serialization.json.JsonObject)
@Serializable data class PasskeyInfo(
    val id: String,
    val deviceName: String? = null,
    val backedUp: Boolean = false,
    val createdAt: String? = null,
    val lastUsedAt: String? = null,
)
@Serializable data class PasskeysWrap(val passkeys: List<PasskeyInfo> = emptyList())

// ── My events (GET /users/@me/events) ────────────────────────────────────────
@Serializable
data class ScheduledEventLite(
    val id: String,
    val guildId: String? = null,
    val name: String = "",
    val description: String? = null,
    val startAt: String = "",
    val endAt: String? = null,
    val status: String? = null,
    val imageUrl: String? = null,
)

@Serializable
data class MyEventItem(
    val event: ScheduledEventLite,
    val guildName: String? = null,
    val guildIconUrl: String? = null,
)

@Serializable data class MyEventsWrap(val events: List<MyEventItem> = emptyList())

// ── Profile edit (PATCH /users/@me) — nulls omitted (explicitNulls=false) ─────
// Only changed fields are sent; unset fields stay null and are dropped from
// the JSON body, so this doubles as the account-settings patch for the
// Notifications / Privacy / Appearance toggles.
@Serializable
data class ProfilePatch(
    val displayName: String? = null,
    val bio: String? = null,
    val status: String? = null,
    val dmReadReceiptsEnabled: Boolean? = null,
    // cosmetics
    val avatarDecoration: String? = null,
    val tagLabel: String? = null,
    val tagColor: String? = null,
    // notifications (only the ones iOS actually exposes)
    val notifyAchievements: Boolean? = null,
    // privacy
    val achievementsPublic: Boolean? = null,
    val showSubscriptionTier: Boolean? = null,
)
