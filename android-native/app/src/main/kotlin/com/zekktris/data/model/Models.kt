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
) {
    val isDM: Boolean get() = type == "dm" || type == "group_dm"
    val isVoice: Boolean get() = type.contains("voice") || type.contains("stage")
    val isCategory: Boolean get() = type.contains("category")
    val isText: Boolean get() = type == "text" || type == "guild_text"
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
) {
    val isImage: Boolean get() = contentType?.startsWith("image/") == true
    val isVideo: Boolean get() = contentType?.startsWith("video/") == true
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
)

@Serializable
data class ReadState(
    val channelId: String,
    val lastMessageId: String? = null,
    val mentionCount: Int = 0,
)
