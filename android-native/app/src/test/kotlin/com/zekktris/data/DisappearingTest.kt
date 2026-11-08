package com.zekktris.data

import com.zekktris.data.Disappearing.Custom
import com.zekktris.data.Disappearing.TimerUnit
import com.zekktris.data.model.Message
import com.zekktris.data.model.MessageMetadata
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Disappearing-messages logic (Disappearing.kt): the wording every platform
 *  shares, the Custom Time picker, the notice, the gateway payloads and the
 *  local-deadline rules. Mirrors the web suite (apps/web/test/disappearing.test.ts). */
class DisappearingTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; isLenient = true }

    @Test fun presetsInSignalOrder() {
        assertEquals(listOf(2_419_200, 604_800, 86_400, 28_800, 3_600, 300, 30), Disappearing.PRESETS)
        assertEquals(
            listOf("4 weeks", "1 week", "1 day", "8 hours", "1 hour", "5 minutes", "30 seconds"),
            Disappearing.PRESETS.map(Disappearing::formatLong),
        )
        Disappearing.PRESETS.forEach { assertTrue(Disappearing.isPreset(it)) }
        // Anything else is Custom.
        listOf(60, 120, 90, 259_200, 1, 2_419_199).forEach { assertFalse(Disappearing.isPreset(it)) }
        assertFalse(Disappearing.isPreset(null))
    }

    @Test fun longLabels() {
        val cases = mapOf(
            2_419_200 to "4 weeks", 604_800 to "1 week", 259_200 to "3 days", 28_800 to "8 hours",
            300 to "5 minutes", 30 to "30 seconds", 60 to "1 minute", 120 to "2 minutes",
            90 to "1 minute 30 seconds", 1 to "1 second", 45 * 60 to "45 minutes",
            // Every non-zero part, largest first.
            604_800 + 86_400 + 3_600 + 60 + 1 to "1 week 1 day 1 hour 1 minute 1 second",
            90_000 to "1 day 1 hour",
        )
        cases.forEach { (secs, label) -> assertEquals("$secs", label, Disappearing.formatLong(secs)) }
        assertEquals("0 seconds", Disappearing.formatLong(0))
    }

    @Test fun shortLabels() {
        val cases = mapOf(
            2_419_200 to "4w", 86_400 to "1d", 28_800 to "8h", 300 to "5m", 30 to "30s", 90 to "1m 30s",
            604_800 to "1w", 3_600 to "1h", 90_000 to "1d 1h",
        )
        cases.forEach { (secs, label) -> assertEquals("$secs", label, Disappearing.formatShort(secs)) }
    }

    @Test fun settingLabelIsOffWhenUnset() {
        assertEquals("Off", Disappearing.label(null))
        assertEquals("Off", Disappearing.label(0))
        assertEquals("1 day", Disappearing.label(86_400))
        assertEquals("2 minutes", Disappearing.label(120))
    }

    @Test fun boundsFromTheServer() {
        assertEquals(Disappearing.BOUNDS, Disappearing.boundsFor(2_419_200))
        // No maxTtlSeconds: an older server, 10 s .. 1 day.
        assertEquals(Disappearing.Bounds(10, 86_400), Disappearing.boundsFor(null))
        assertTrue(1 in Disappearing.BOUNDS)
        assertTrue(2_419_200 in Disappearing.BOUNDS)
        assertFalse(0 in Disappearing.BOUNDS)
        assertFalse(2_419_201 in Disappearing.BOUNDS)
        assertEquals(listOf(86_400, 28_800, 3_600, 300, 30), Disappearing.presetsWithin(Disappearing.LEGACY_BOUNDS))
    }

    @Test fun unitRanges() {
        assertEquals(1..59, Disappearing.unitRange(TimerUnit.Seconds))
        assertEquals(1..59, Disappearing.unitRange(TimerUnit.Minutes))
        assertEquals(1..23, Disappearing.unitRange(TimerUnit.Hours))
        assertEquals(1..6, Disappearing.unitRange(TimerUnit.Days))
        assertEquals(1..4, Disappearing.unitRange(TimerUnit.Weeks))
        // An older server: at least 10 s, at most 1 day, no weeks.
        val legacy = Disappearing.LEGACY_BOUNDS
        assertEquals(10..59, Disappearing.unitRange(TimerUnit.Seconds, legacy))
        assertEquals(1..1, Disappearing.unitRange(TimerUnit.Days, legacy))
        assertNull(Disappearing.unitRange(TimerUnit.Weeks, legacy))
        assertEquals(
            listOf(TimerUnit.Seconds, TimerUnit.Minutes, TimerUnit.Hours, TimerUnit.Days),
            Disappearing.availableUnits(legacy),
        )
        // The range edges are all valid server values.
        listOf(Custom(59, TimerUnit.Seconds), Custom(59, TimerUnit.Minutes), Custom(23, TimerUnit.Hours),
            Custom(6, TimerUnit.Days), Custom(4, TimerUnit.Weeks), Custom(1, TimerUnit.Seconds))
            .forEach { assertTrue("$it", it.seconds in Disappearing.BOUNDS) }
    }

    @Test fun customInitialExactValues() {
        assertEquals(Custom(2, TimerUnit.Minutes), Disappearing.customInitial(120))
        assertEquals(Custom(1, TimerUnit.Minutes), Disappearing.customInitial(60))
        assertEquals(Custom(1, TimerUnit.Hours), Disappearing.customInitial(3_600))
        assertEquals(Custom(1, TimerUnit.Days), Disappearing.customInitial(86_400))
        assertEquals(Custom(3, TimerUnit.Days), Disappearing.customInitial(259_200))
        assertEquals(Custom(1, TimerUnit.Weeks), Disappearing.customInitial(604_800))
        assertEquals(Custom(4, TimerUnit.Weeks), Disappearing.customInitial(2_419_200))
        assertEquals(Custom(59, TimerUnit.Seconds), Disappearing.customInitial(59))
        assertEquals(Custom(59, TimerUnit.Minutes), Disappearing.customInitial(59 * 60))
        assertEquals(Custom(23, TimerUnit.Hours), Disappearing.customInitial(23 * 3_600))
        assertEquals(Custom(6, TimerUnit.Days), Disappearing.customInitial(6 * 86_400))
        assertEquals(Custom(1, TimerUnit.Seconds), Disappearing.customInitial(1))
    }

    @Test fun customInitialOtherValuesUseTheLargestUnit() {
        assertEquals(Custom(1, TimerUnit.Minutes), Disappearing.customInitial(90))
        assertEquals(Custom(1, TimerUnit.Days), Disappearing.customInitial(90_000)) // 25 h
        assertEquals(Custom(1, TimerUnit.Weeks), Disappearing.customInitial(864_000)) // 10 days
        // Nothing set → 1 day.
        assertEquals(Custom(1, TimerUnit.Days), Disappearing.customInitial(null))
        assertEquals(Custom(1, TimerUnit.Days), Disappearing.customInitial(0))
    }

    @Test fun customInitialStaysInsideAnOlderServersRange() {
        val legacy = Disappearing.LEGACY_BOUNDS
        assertEquals(Custom(1, TimerUnit.Days), Disappearing.customInitial(null, legacy))
        // 4 weeks can't be picked there: the nearest unit that fits, clamped.
        assertEquals(Custom(1, TimerUnit.Days), Disappearing.customInitial(2_419_200, legacy))
        assertEquals(Custom(10, TimerUnit.Seconds), Disappearing.customInitial(5, legacy))
        assertEquals(Custom(2, TimerUnit.Minutes), Disappearing.customInitial(120, legacy))
    }

    @Test fun changingTheUnitClampsTheNumber() {
        assertEquals(Custom(6, TimerUnit.Days), Disappearing.changeUnit(Custom(30, TimerUnit.Minutes), TimerUnit.Days))
        assertEquals(Custom(4, TimerUnit.Weeks), Disappearing.changeUnit(Custom(23, TimerUnit.Hours), TimerUnit.Weeks))
        assertEquals(Custom(5, TimerUnit.Hours), Disappearing.changeUnit(Custom(5, TimerUnit.Days), TimerUnit.Hours))
        assertEquals(Custom(10, TimerUnit.Seconds), Disappearing.changeUnit(Custom(5, TimerUnit.Minutes), TimerUnit.Seconds, Disappearing.LEGACY_BOUNDS))
        assertEquals(6, Disappearing.clampNumber(40, TimerUnit.Days))
        assertEquals(1, Disappearing.clampNumber(0, TimerUnit.Hours))
    }

    @Test fun noticeText() {
        assertEquals("You set disappearing messages to 1 day.", Disappearing.noticeText(86_400, isSelf = true, name = "Alex"))
        assertEquals("Alex set disappearing messages to 8 hours.", Disappearing.noticeText(28_800, isSelf = false, name = "Alex"))
        assertEquals("Alex set disappearing messages to 1 minute 30 seconds.", Disappearing.noticeText(90, false, "Alex"))
        assertEquals("You turned off disappearing messages.", Disappearing.noticeText(0, true, "Alex"))
        assertEquals("Alex turned off disappearing messages.", Disappearing.noticeText(0, false, "Alex"))
    }

    private fun msg(
        id: String,
        authorId: String? = "other",
        type: String = "default",
        expireAfterSeconds: Int? = null,
        metadata: MessageMetadata? = null,
    ) = Message(id = id, channelId = "c1", createdAt = "2026-11-08T00:00:00Z", authorId = authorId, type = type,
        expireAfterSeconds = expireAfterSeconds, metadata = metadata)

    @Test fun recognisesTheNotice() {
        val notice = msg("5", type = "system_disappearing",
            metadata = MessageMetadata(kind = "disappearing_timer", timerSeconds = 86_400, initiatorId = "u1"))
        assertTrue(Disappearing.isNotice(notice))
        assertEquals(86_400, Disappearing.noticeTimer(notice))
        // Defensive: the metadata alone marks it too.
        assertTrue(Disappearing.isNotice(msg("6", metadata = MessageMetadata(kind = "disappearing_timer", timerSeconds = 0))))
        assertEquals(0, Disappearing.noticeTimer(msg("6", metadata = MessageMetadata(kind = "disappearing_timer", timerSeconds = 0))))
        assertFalse(Disappearing.isNotice(msg("7")))
        assertFalse(Disappearing.isNotice(msg("8", type = "system_call")))
        assertNull(Disappearing.noticeTimer(msg("9", type = "system_disappearing")))
    }

    @Test fun settingsUpdatePayloadIsCamelCase() {
        val on = Disappearing.parseSettingsUpdate(json.parseToJsonElement("""{"channelId":"42","ttlSecondsAfterRead":604800}"""))
        assertEquals(Disappearing.SettingsUpdate("42", 604_800), on)
        val off = Disappearing.parseSettingsUpdate(json.parseToJsonElement("""{"channelId":"42","ttlSecondsAfterRead":null}"""))
        assertEquals(Disappearing.SettingsUpdate("42", null), off)
        assertEquals(Disappearing.SettingsUpdate("42", null),
            Disappearing.parseSettingsUpdate(json.parseToJsonElement("""{"channelId":"42"}""")))
        // A non-positive timer is off, never a 0-second countdown.
        assertEquals(Disappearing.SettingsUpdate("42", null),
            Disappearing.parseSettingsUpdate(json.parseToJsonElement("""{"channelId":"42","ttlSecondsAfterRead":0}""")))
        // Not the snake_case shape the other events use.
        assertNull(Disappearing.parseSettingsUpdate(json.parseToJsonElement("""{"channel_id":"42","ttl_seconds_after_read":30}""")))
        assertNull(Disappearing.parseSettingsUpdate(null))
    }

    @Test fun expiryPayload() {
        val ev = Disappearing.parseExpiry(json.parseToJsonElement(
            """{"channel_id":"42","expiries":[{"id":"7","expires_at":"2026-11-08T10:00:30.000Z"},{"id":"8"},{"id":"9","expires_at":"2026-11-08T10:01:00.000Z"}],"server_now":"2026-11-08T10:00:00.000Z"}""",
        ))!!
        assertEquals("42", ev.channelId)
        // A malformed entry is skipped, not fatal.
        assertEquals(listOf("7" to "2026-11-08T10:00:30.000Z", "9" to "2026-11-08T10:01:00.000Z"), ev.expiries)
        assertEquals("2026-11-08T10:00:00.000Z", ev.serverNow)
        assertNull(Disappearing.parseExpiry(json.parseToJsonElement("""{"channel_id":"42"}""")))
        assertNull(Disappearing.parseExpiry(json.parseToJsonElement("""{"expiries":[]}""")))
    }

    @Test fun deadlinesFollowTheServerClock() {
        val serverNow = Disappearing.parseServerTime("2026-11-08T10:00:00.000Z")!!
        // The device clock runs 2 minutes FAST.
        val deviceNow = serverNow + 120_000
        val offset = Disappearing.offsetFrom("2026-11-08T10:00:00.000Z", deviceNow)!!
        assertEquals(-120_000L, offset)
        // A deadline 30 s out in server time is 30 s out on the device too.
        assertEquals(deviceNow + 30_000, Disappearing.localDeadline("2026-11-08T10:00:30.000Z", offset))
        assertNull(Disappearing.localDeadline(null, offset))
        assertNull(Disappearing.localDeadline("not a time", offset))
        assertNull(Disappearing.offsetFrom(null, deviceNow))
    }

    @Test fun dateHeaderOffsetNeverRunsAhead() {
        // The server wrote "10:00:00" somewhere in 10:00:00.000-.999; the
        // device clock is 5 s slow and read the response `latency` ms later.
        // Whatever the sub-second and the latency, the estimate is a lower
        // bound (deadlines fire late, never early) within a second + latency.
        val trueOffset = 5_000L
        val second = Disappearing.parseServerTime("2026-11-08T10:00:00.000Z")!!
        for (sub in listOf(0L, 1L, 100L, 500L, 999L)) for (latency in listOf(0L, 10L, 300L)) {
            val deviceReceived = second + sub - trueOffset + latency
            val est = Disappearing.offsetFromDateHeader("Sun, 08 Nov 2026 10:00:00 GMT", deviceReceived)!!
            assertTrue("sub=$sub latency=$latency: $est must not exceed $trueOffset", est <= trueOffset)
            assertTrue("sub=$sub latency=$latency: $est too low", est >= trueOffset - 1_000 - latency)
        }
        assertNull(Disappearing.offsetFromDateHeader(null, second))
        assertNull(Disappearing.offsetFromDateHeader("yesterday", second))
    }

    @Test fun nextDeadlineAndExpiry() {
        assertEquals(150L, Disappearing.nextDeadline(listOf(90L, 300L, 150L, 100L), nowMs = 100L))
        assertNull(Disappearing.nextDeadline(listOf(50L, 100L), nowMs = 100L))
        assertNull(Disappearing.nextDeadline(emptyList(), nowMs = 100L))
        assertTrue(Disappearing.isExpired(100L, nowMs = 100L))
        assertFalse(Disappearing.isExpired(101L, nowMs = 100L))
        assertFalse(Disappearing.isExpired(null, nowMs = 100L))
    }

    @Test fun snowflakeOrder() {
        assertTrue(Disappearing.compareIds("99", "100") < 0)
        assertTrue(Disappearing.compareIds("124", "123") > 0)
        assertEquals(0, Disappearing.compareIds("123", "123"))
    }

    @Test fun ackStartsOnlyReceivedTimedUnstampedRowsUpToTheAckedId() {
        val me = "me"
        val upTo = "200"
        val received = msg("150", authorId = "other", expireAfterSeconds = 30)
        assertTrue(Disappearing.startsOnAck(received, me, upTo, known = false))
        assertTrue(Disappearing.startsOnAck(msg("200", expireAfterSeconds = 30), me, upTo, known = false))
        // A deadline is already known (MESSAGE_EXPIRY or REST got there first).
        assertFalse(Disappearing.startsOnAck(received, me, upTo, known = true))
        // Our own message: the reader's ack starts it, not ours.
        assertFalse(Disappearing.startsOnAck(msg("150", authorId = me, expireAfterSeconds = 30), me, upTo, known = false))
        // No timer.
        assertFalse(Disappearing.startsOnAck(msg("150"), me, upTo, known = false))
        // Newer than the acked id (snowflake order, not string order).
        assertFalse(Disappearing.startsOnAck(msg("201", expireAfterSeconds = 30), me, upTo, known = false))
        assertFalse(Disappearing.startsOnAck(msg("1000", expireAfterSeconds = 30), me, "999", known = false))
        assertTrue(Disappearing.startsOnAck(msg("999", expireAfterSeconds = 30), me, "1000", known = false))
        // An optimistic row has no server id.
        assertFalse(Disappearing.startsOnAck(msg("pending-abc", expireAfterSeconds = 30), me, upTo, known = false))
        // Without knowing who we are, nothing.
        assertFalse(Disappearing.startsOnAck(received, null, upTo, known = false))
    }

    @Test fun resumeAcksOnlyWhatTheReadPointerDoesNotCover() {
        val rows = listOf(msg("150"), msg("200", expireAfterSeconds = 30), msg("pending-abc", authorId = "me"))
        // A message came in while we were away: the pointer is behind it.
        assertEquals("200", Disappearing.ackTarget(rows, "150"))
        // Never read at all.
        assertEquals("200", Disappearing.ackTarget(rows, null))
        // Already read here or on another device, or we sent past it.
        assertNull(Disappearing.ackTarget(rows, "200"))
        assertNull(Disappearing.ackTarget(rows, "250"))
        // Snowflake order, not string order.
        assertEquals("1000", Disappearing.ackTarget(listOf(msg("1000")), "999"))
        assertNull(Disappearing.ackTarget(listOf(msg("999")), "1000"))
        // Nothing confirmed to ack.
        assertNull(Disappearing.ackTarget(listOf(msg("pending-abc", authorId = "me")), null))
        assertNull(Disappearing.ackTarget(emptyList(), null))
    }

    @Test fun settingsPatchCarriesAnExplicitNullForOff() {
        assertEquals("""{"ttlSecondsAfterRead":null}""", Disappearing.settingsPatchBody(null).toString())
        assertEquals("""{"ttlSecondsAfterRead":2419200}""", Disappearing.settingsPatchBody(2_419_200).toString())
    }
}
