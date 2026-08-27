package com.zekktris.data.model

import kotlinx.serialization.Serializable

// ── Admin instance DTOs (mirror iOS AdminStats / InstanceMetrics / etc.) ──────

@Serializable data class AdminUserCounts(val total: Int = 0, val banned: Int = 0)
@Serializable data class AdminMessageCounts(val total: Int = 0, val last24h: Int = 0)

@Serializable
data class AdminStats(
    val users: AdminUserCounts = AdminUserCounts(),
    val guilds: Int = 0,
    val channels: Int = 0,
    val messages: AdminMessageCounts = AdminMessageCounts(),
    val activeSessions: Int = 0,
)
@Serializable data class AdminStatsWrap(val stats: AdminStats)

@Serializable data class MetricsProcess(val uptimeSeconds: Int = 0, val workerId: Int = 0, val nodeEnv: String = "")
@Serializable data class MetricsGateway(val connections: Int = 0, val onlineUsers: Int = 0)
@Serializable data class MetricsVoice(val rooms: Int = 0, val participants: Int = 0)
@Serializable data class MetricsScheduled(val pending: Int = 0, val due: Int = 0)
@Serializable data class MetricsDB(val ok: Boolean = false, val latencyMs: Int = 0)
@Serializable data class MetricsRedis(val configured: Boolean = false, val healthy: Boolean? = null)

@Serializable
data class InstanceMetrics(
    val process: MetricsProcess = MetricsProcess(),
    val gateway: MetricsGateway = MetricsGateway(),
    val voice: MetricsVoice = MetricsVoice(),
    val scheduledMessages: MetricsScheduled = MetricsScheduled(),
    val db: MetricsDB = MetricsDB(),
    val redis: MetricsRedis = MetricsRedis(),
)
@Serializable data class MetricsWrap(val metrics: InstanceMetrics)

@Serializable
data class AdminUser(
    val id: String,
    val username: String = "",
    val displayName: String? = null,
    val email: String? = null,
    val avatarUrl: String? = null,
    val isAdmin: Boolean = false,
    val isModerator: Boolean = false,
    val bannedAt: String? = null,
    val bannedUntil: String? = null,
    val subscriptionTier: String? = null,
) {
    val name: String get() = displayName ?: username
    val isBanned: Boolean get() = bannedAt != null
    val isStaff: Boolean get() = isAdmin || isModerator
}
@Serializable data class AdminUsersWrap(val users: List<AdminUser> = emptyList())

@Serializable
data class AdminGuild(
    val id: String,
    val name: String = "",
    val iconUrl: String? = null,
    val ownerId: String? = null,
    val memberCount: Int? = null,
    val discoverable: Boolean? = null,
)
@Serializable data class AdminGuildsWrap(val guilds: List<AdminGuild> = emptyList())

@Serializable data class AdminStorageCategory(val count: Int = 0, val totalBytes: Long? = null)
@Serializable data class AdminStorageOnDisk(
    val totalBytes: Long = 0, val totalCount: Int = 0,
    val unusedBytes: Long = 0, val unusedCount: Int = 0,
)
@Serializable
data class AdminStorage(
    val attachments: AdminStorageCategory = AdminStorageCategory(),
    val avatars: AdminStorageCategory = AdminStorageCategory(),
    val banners: AdminStorageCategory = AdminStorageCategory(),
    val emojis: AdminStorageCategory = AdminStorageCategory(),
    val stickers: AdminStorageCategory = AdminStorageCategory(),
    val onDisk: AdminStorageOnDisk = AdminStorageOnDisk(),
)
@Serializable data class AdminStorageWrap(val storage: AdminStorage)
@Serializable data class StorageGcResult(val scanned: Int = 0, val deleted: Int = 0)

// One on-disk file, as listed by GET /admin/storage/items?page=&sort=
@Serializable data class StorageItem(
    val id: String,
    val filename: String? = null,
    val format: String? = null,
    val compressed: Boolean? = null,
    val category: String = "",
    val sizeBytes: Long = 0,
    val referenced: Boolean = true,
    val guildId: String? = null,
)
@Serializable data class StorageListing(val items: List<StorageItem> = emptyList(), val total: Int? = null)

// Ghost-mode observe: read a guild's channel tree without joining.
// GET /admin/guilds/:id/peek → { guild, channels }
@Serializable data class PeekGuild(
    val id: String,
    val name: String = "",
    val iconUrl: String? = null,
    val ownerId: String? = null,
    val createdAt: String? = null,
    val memberCount: Int? = null,
)
@Serializable data class PeekGuildResult(val guild: PeekGuild, val channels: List<Channel> = emptyList())

@Serializable data class BanBody(val duration: String)
@Serializable data class RoleBody(val role: String)

// ── Admin security (spam throttle / banned words / event log) ────────────────

@Serializable
data class SecurityConfig(
    val spamEnabled: Boolean = false,
    val spamMaxMessages: Int = 5,
    val spamWindowSeconds: Int = 5,
    val spamCooldownSeconds: Int = 60,
    val wordFilterEnabled: Boolean = false,
)
@Serializable data class SecurityConfigWrap(val config: SecurityConfig)

@Serializable
data class SecurityWord(val word: String, val severity: String = "blocked") // blocked | watch
@Serializable data class SecurityWordsWrap(val words: List<SecurityWord> = emptyList())
@Serializable data class AddWordBody(val word: String, val severity: String)

/** GET /admin/security/words/preset returns BARE STRINGS, not {word,severity}
 *  objects — SecurityWordsWrap cannot decode it. (The POST on the same path
 *  DOES answer with SecurityWordsWrap; only the GET is bare.) */
@Serializable data class PresetWordsWrap(val words: List<String> = emptyList())

@Serializable
data class SecurityEvent(
    val id: String,
    val kind: String = "", // spam_limited | banned_word | staff_*
    val userId: String? = null,
    val username: String? = null,
    val displayName: String? = null,
    val actorId: String? = null,
    val actorUsername: String? = null,
    val actorDisplayName: String? = null,
    val guildId: String? = null,
    val channelId: String? = null,
    val detail: String = "",
    val contentSnapshot: String? = null,
    val createdAt: String = "",
) {
    val isStaffAction: Boolean get() = kind.startsWith("staff_")
    val actorName: String
        get() = if (isStaffAction) actorDisplayName ?: actorUsername ?: "Unknown staff"
        else displayName ?: username ?: "Unknown"
    val targetName: String? get() = if (isStaffAction) displayName ?: username else null
}
@Serializable data class SecurityEventsWrap(val events: List<SecurityEvent> = emptyList())

// ── Monetization config ──────────────────────────────────────────────────────

@Serializable
data class QualityTiers(val p1080: String = "none", val k2: String = "guardian", val k4: String = "legend")

@Serializable
data class UploadCapsMb(
    val free: Int? = null,
    val scout: Int? = null,
    val guardian: Int? = null,
    val legend: Int? = null,
)

// ── Admin Overview extras: voice diagnostic + recent-activity feed ───────────

/** One pass/fail/warn row of GET /admin/voice-diagnostic. */
@Serializable
data class LivekitCheck(
    val id: String,
    val label: String = "",
    val status: String = "",
    val detail: String = "",
)

/** Result of GET /admin/voice-diagnostic (no secrets — config URLs + guidance). */
@Serializable
data class LivekitDiagnostic(
    val configured: Boolean = false,
    val ok: Boolean = false,
    val wsUrl: String? = null,
    val checks: List<LivekitCheck> = emptyList(),
    val generatedAt: String = "",
)
@Serializable data class DiagnosticWrap(val diagnostic: LivekitDiagnostic)

/** GET /admin/activity — recent signups + newly-created servers. */
@Serializable
data class AdminActivityUser(
    val id: String,
    val username: String = "",
    val displayName: String = "",
    val avatarUrl: String? = null,
    val createdAt: String = "",
)

@Serializable
data class AdminActivityGuild(
    val id: String,
    val name: String = "",
    val iconUrl: String? = null,
    val ownerId: String = "",
    val createdAt: String = "",
)

@Serializable
data class AdminActivity(
    val recentUsers: List<AdminActivityUser> = emptyList(),
    val recentGuilds: List<AdminActivityGuild> = emptyList(),
)
@Serializable data class AdminActivityWrap(val activity: AdminActivity)

@Serializable
data class MonetizationConfig(
    val stream: QualityTiers = QualityTiers(),
    val camera: QualityTiers = QualityTiers(),
    val appearance: String = "none",
    val uploadCapsMb: UploadCapsMb = UploadCapsMb(),
)
@Serializable data class MonetizationConfigWrap(val config: MonetizationConfig)

/**
 * One person the subject exchanges 1:1 DMs with. ADMIN-ONLY: counts, identity and
 * friend status, never message content — most of these DMs are E2EE and the
 * server cannot read them either. The read is audit-logged (staff_dm_peers).
 */
@Serializable
data class AdminDmPeer(
    val channelId: String,
    val user: PublicUser,
    val isFriend: Boolean = false,
    val messageCount: Int = 0,
)

@Serializable
data class AdminDmPeersWrap(
    val peers: List<AdminDmPeer> = emptyList(),
    /** True when the subject has more DM channels than the server enumerates. */
    val capped: Boolean = false,
)
