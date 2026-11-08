package com.zekktris.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Disappearing messages on the wire: the message, notice and settings DTOs
 *  as this app decodes them (same Json settings as ApiClient). One bad row
 *  fails a whole message page, so every shape — new, old and unknown — must
 *  decode. */
class DisappearingWireTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; isLenient = true }

    @Test fun messageCarriesItsTimerAndDeadline() {
        val m = json.decodeFromString<Message>(
            """{"id":"10","channelId":"1","createdAt":"2026-11-08T00:00:00Z","authorId":"2","content":"hi",
               "expireAfterSeconds":2419200,"expiresAt":"2026-12-06T00:00:00.000Z"}""",
        )
        assertEquals(2_419_200, m.expireAfterSeconds)
        assertEquals("2026-12-06T00:00:00.000Z", m.expiresAt)
    }

    @Test fun unreadTimedMessageHasNoDeadline() {
        val m = json.decodeFromString<Message>(
            """{"id":"10","channelId":"1","createdAt":"2026-11-08T00:00:00Z","expireAfterSeconds":30,"expiresAt":null}""",
        )
        assertEquals(30, m.expireAfterSeconds)
        assertNull(m.expiresAt)
    }

    @Test fun olderServerShapeDecodesWithNulls() {
        val m = json.decodeFromString<Message>("""{"id":"10","channelId":"1","createdAt":"2026-11-08T00:00:00Z"}""")
        assertNull(m.expireAfterSeconds)
        assertNull(m.expiresAt)
        assertEquals("default", m.type)
    }

    @Test fun noticeDecodesWithItsMetadata() {
        val m = json.decodeFromString<Message>(
            """{"id":"11","channelId":"1","createdAt":"2026-11-08T00:00:00Z","authorId":"2",
               "type":"system_disappearing","content":"Alex set disappearing messages to 1 day.",
               "expireAfterSeconds":null,
               "metadata":{"kind":"disappearing_timer","timerSeconds":86400,"initiatorId":"2"}}""",
        )
        assertEquals("system_disappearing", m.type)
        assertEquals("disappearing_timer", m.metadata?.kind)
        assertEquals(86_400, m.metadata?.timerSeconds)
        assertEquals("2", m.metadata?.initiatorId)
        assertEquals("Alex set disappearing messages to 1 day.", m.content)
        assertNull(m.expireAfterSeconds)
    }

    @Test fun turnedOffNoticeIsZero() {
        val m = json.decodeFromString<Message>(
            """{"id":"12","channelId":"1","createdAt":"2026-11-08T00:00:00Z","type":"system_disappearing",
               "metadata":{"kind":"disappearing_timer","timerSeconds":0,"initiatorId":"2"}}""",
        )
        assertEquals(0, m.metadata?.timerSeconds)
    }

    @Test fun callRecordMetadataStillDecodes() {
        // The new key must not disturb the other notice kinds' typed keys.
        val m = json.decodeFromString<Message>(
            """{"id":"13","channelId":"1","createdAt":"2026-11-08T00:00:00Z","type":"system_call",
               "metadata":{"missed":true,"durationMs":5000,"initiatorId":"3"}}""",
        )
        assertEquals(true, m.metadata?.missed)
        assertEquals(5_000L, m.metadata?.durationMs)
        assertNull(m.metadata?.timerSeconds)
    }

    @Test fun unknownTypeIsKeptVerbatim() {
        val m = json.decodeFromString<Message>(
            """{"id":"14","channelId":"1","createdAt":"2026-11-08T00:00:00Z","type":"system_something_new","content":"x"}""",
        )
        assertEquals("system_something_new", m.type)
    }

    @Test fun settingsCarryTheTimerAndTheServersLimit() {
        val s = json.decodeFromString<DmChannelSettings>(
            """{"ttlSecondsAfterRead":2419200,"notificationShowContent":null,"maxTtlSeconds":2419200}""",
        )
        assertEquals(2_419_200, s.ttlSecondsAfterRead)
        assertEquals(2_419_200, s.maxTtlSeconds)
        val off = json.decodeFromString<DmChannelSettings>("""{"ttlSecondsAfterRead":null,"maxTtlSeconds":2419200}""")
        assertNull(off.ttlSecondsAfterRead)
    }

    @Test fun olderServerSettingsHaveNoLimit() {
        val s = json.decodeFromString<DmChannelSettings>("""{"ttlSecondsAfterRead":30,"notificationShowContent":true}""")
        assertEquals(30, s.ttlSecondsAfterRead)
        assertNull(s.maxTtlSeconds)
    }
}
