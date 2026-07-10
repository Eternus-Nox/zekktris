package com.zekktris.data.model

import kotlinx.serialization.Serializable

// Response envelopes — every list/single endpoint returns a single-key object.
@Serializable data class GuildsWrap(val guilds: List<Guild> = emptyList())
@Serializable data class GuildWrap(val guild: Guild)
@Serializable data class ChannelsWrap(val channels: List<Channel> = emptyList())
@Serializable data class ChannelWrap(val channel: Channel)
@Serializable data class ThreadsWrap(val threads: List<Channel> = emptyList())
@Serializable data class MessagesWrap(val messages: List<Message> = emptyList())
@Serializable data class MessageWrap(val message: Message)
@Serializable data class ChannelAttachmentsWrap(val attachments: List<Attachment> = emptyList())
@Serializable data class MembersWrap(val members: List<GuildMember> = emptyList())
@Serializable data class MemberWrap(val member: GuildMember)
@Serializable data class ReadStatesWrap(val readStates: List<ReadState> = emptyList())
@Serializable data class AckWrap(val readState: ReadState)
@Serializable data class UserWrap(val user: SelfUser)

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
)

// POST /users/@me/device-tokens — register this device's FCM push token.
@Serializable
data class DeviceTokenBody(
    val token: String,
    val platform: String = "android",
    val label: String? = null,
)
