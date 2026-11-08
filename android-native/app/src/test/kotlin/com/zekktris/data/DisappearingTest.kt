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
        val started: (String) -> Boolean = { true }
        fun target(rows: List<Message>, readUpTo: String?) = Disappearing.ackTarget(rows, readUpTo, "me", null, started)
        // A message came in while we were away: the pointer is behind it.
        assertEquals("200", target(rows, "150"))
        // Never read at all.
        assertEquals("200", target(rows, null))
        // Already read here or on another device, or we sent past it.
        assertNull(target(rows, "200"))
        assertNull(target(rows, "250"))
        // Snowflake order, not string order.
        assertEquals("1000", target(listOf(msg("1000")), "999"))
        assertNull(target(listOf(msg("999")), "1000"))
        // Nothing confirmed to ack.
        assertNull(target(listOf(msg("pending-abc", authorId = "me")), null))
        assertNull(target(emptyList(), null))
        // The pointer is behind: acked whatever this device acked before.
        assertEquals("200", Disappearing.ackTarget(rows, "150", "me", "200", started))
    }

    @Test fun aCoveredTimedMessageWithNoCountdownIsAckedOncePerId() {
        // Bob's timed message 150 waits; our scheduled message 200 fired and
        // moved our pointer past it without being a read.
        val rows = listOf(msg("150", authorId = "bob", expireAfterSeconds = 30), msg("200", authorId = "me"))
        val none: (String) -> Boolean = { false }
        assertEquals("200", Disappearing.ackTarget(rows, "200", "me", null, none))
        assertEquals("200", Disappearing.ackTarget(rows, "200", "me", "150", none))
        // Once per id: this device already acked 200.
        assertNull(Disappearing.ackTarget(rows, "200", "me", "200", none))
        // A later row is a new id, so it goes again.
        val later = rows + msg("300", authorId = "me")
        assertEquals("300", Disappearing.ackTarget(later, "300", "me", "200", none))
        // Its countdown is known (MESSAGE_EXPIRY, a REST page or our own ack).
        assertNull(Disappearing.ackTarget(rows, "200", "me", null) { it == "150" })
        // Only someone else's timed rows count: our own wait for the reader,
        // untimed rows have nothing to start.
        val ours = listOf(msg("150", authorId = "me", expireAfterSeconds = 30), msg("200", authorId = "me"))
        assertNull(Disappearing.ackTarget(ours, "200", "me", null, none))
        assertNull(Disappearing.ackTarget(listOf(msg("150", authorId = "bob"), msg("200", authorId = "me")), "200", "me", null, none))
        // Without knowing who we are, nothing past the pointer.
        assertNull(Disappearing.ackTarget(rows, "200", null, null, none))
        // A pointer past every row (snowflake order) still checks them.
        assertEquals("200", Disappearing.ackTarget(rows, "1000", "me", null, none))
    }

    @Test fun anOpenAcksPastANewestMessageThatIsGone() {
        val window = listOf(msg("150"), msg("200"))
        // The DM's newest was 300 before the fetch, and the fetch has nothing
        // at or past it: deleted, or disappeared and swept.
        assertEquals("300", Disappearing.pastTailAck("300", window))
        assertEquals("300", Disappearing.pastTailAck("300", emptyList()))
        // Snowflake order, not string order.
        assertEquals("1000", Disappearing.pastTailAck("1000", listOf(msg("999"))))
        assertNull(Disappearing.pastTailAck("999", listOf(msg("1000"))))
        // It is still there, or something newer came in.
        assertNull(Disappearing.pastTailAck("200", window))
        assertNull(Disappearing.pastTailAck("150", window))
        // A failed fetch proves nothing; no known newest, nothing to go past.
        assertNull(Disappearing.pastTailAck("300", null))
        assertNull(Disappearing.pastTailAck(null, window))
        assertNull(Disappearing.pastTailAck("", window))
        assertNull(Disappearing.pastTailAck("pending-abc", window))
        // Optimistic rows in the window don't count as the server's newest.
        assertEquals("300", Disappearing.pastTailAck("300", window + msg("pending-abc")))
    }

    @Test fun theLaterOfTwoIds() {
        assertEquals("300", Disappearing.laterId("200", "300"))
        assertEquals("300", Disappearing.laterId("300", "200"))
        assertEquals("1000", Disappearing.laterId("999", "1000"))
        assertEquals("200", Disappearing.laterId("200", null))
        assertEquals("300", Disappearing.laterId(null, "300"))
        assertNull(Disappearing.laterId(null, null))
    }

    @Test fun removingTheNewestMessageMovesTheConversationsNewestBack() {
        val rest = listOf(msg("150"), msg("200"), msg("pending-abc", authorId = "me"))
        // The newest (300) was swept: back to the newest confirmed row left.
        assertEquals("200", Disappearing.lastAfterRemoval("300", setOf("300"), rest))
        // Out of order in the list, and across the snowflake digit rollover.
        assertEquals("999", Disappearing.lastAfterRemoval("1000", setOf("1000"), listOf(msg("999"), msg("150"))))
        // Something else went: unchanged.
        assertEquals("300", Disappearing.lastAfterRemoval("300", setOf("150"), listOf(msg("200"), msg("300"))))
        // Nothing older loaded: stays (the open acks past it).
        assertEquals("300", Disappearing.lastAfterRemoval("300", setOf("300"), emptyList()))
        assertEquals("300", Disappearing.lastAfterRemoval("300", setOf("300"), listOf(msg("pending-abc", authorId = "me"))))
        // Never past where it was.
        assertEquals("300", Disappearing.lastAfterRemoval("300", setOf("300"), listOf(msg("400"))))
        assertNull(Disappearing.lastAfterRemoval(null, setOf("300"), rest))
    }

    @Test fun aCacheThatMayStopShortOfTheTailKeepsTheConversationsNewest() {
        // Cached from before a reconnect that replayed nothing: messages missed
        // meanwhile may sit between 200 and 300, so moving back would hide them.
        val rest = listOf(msg("150"), msg("200"))
        assertEquals("300", Disappearing.lastAfterRemoval("300", setOf("300"), rest, reachTail = false))
        assertEquals("200", Disappearing.lastAfterRemoval("300", setOf("300"), rest, reachTail = true))
        assertEquals("300", Disappearing.lastAfterRemoval("300", setOf("150"), rest, reachTail = false))
        assertNull(Disappearing.lastAfterRemoval(null, setOf("300"), rest, reachTail = false))
    }

    @Test fun anAckTheServerRefusesFallsBackToTheNewestLoadedRow() {
        // Past the loaded rows first (its row may be hard-deleted), then the
        // newest loaded one.
        assertEquals(listOf("300", "200"), Disappearing.ackCandidates("200", "300"))
        assertEquals(listOf("1000", "999"), Disappearing.ackCandidates("999", "1000"))
        // Nothing past the rows: the newest alone.
        assertEquals(listOf("200"), Disappearing.ackCandidates("200", null))
        assertEquals(listOf("200"), Disappearing.ackCandidates("200", "200"))
        assertEquals(listOf("300"), Disappearing.ackCandidates("300", "200"))
        // Nothing loaded: the past-tail id alone; neither: no POST.
        assertEquals(listOf("300"), Disappearing.ackCandidates(null, "300"))
        assertEquals(emptyList<String>(), Disappearing.ackCandidates(null, null))
    }

    @Test fun theNewestConfirmedRowIsTheHighestIdNotTheLastRow() {
        assertEquals("400", Disappearing.newestConfirmedId(listOf(msg("100"), msg("400"), msg("200"), msg("300"))))
        // Snowflake order, not string order.
        assertEquals("1000", Disappearing.newestConfirmedId(listOf(msg("1000"), msg("999"))))
        // Optimistic rows have no server id.
        assertEquals("200", Disappearing.newestConfirmedId(listOf(msg("200"), msg("pending-abc", authorId = "me"))))
        assertNull(Disappearing.newestConfirmedId(listOf(msg("pending-abc", authorId = "me"))))
        assertNull(Disappearing.newestConfirmedId(emptyList()))
    }

    @Test fun anOutOfOrderListAcksItsHighestId() {
        // L (400) came in live while acks were skipped, then a catch-up added
        // F1 and F2 after it; this device had already acked F2.
        val rows = listOf(msg("100"), msg("400"), msg("200"), msg("300"))
        val started: (String) -> Boolean = { true }
        assertEquals("400", Disappearing.ackTarget(rows, "300", "me", "300", started))
        assertEquals("400", Disappearing.ackTarget(rows, null, "me", null, started))
        assertNull(Disappearing.ackTarget(rows, "400", "me", "400", started))
        // The same rule for a covered timed row with no countdown yet.
        val timed = listOf(msg("100", expireAfterSeconds = 30), msg("400", authorId = "me"), msg("200", authorId = "me"))
        assertEquals("400", Disappearing.ackTarget(timed, "400", "me", "200") { false })
    }

    private fun ids(rows: List<Message>) = rows.map { it.id }

    @Test fun rowsMergeInIdOrderWithSendsInFlightLast() {
        // The newest goes last, as before.
        assertEquals(listOf("100", "200", "300"), ids(Disappearing.upsertRow(listOf(msg("100"), msg("200")), msg("300"))))
        // A catch-up after a live arrival: below it, in id order.
        var rows = listOf(msg("100"), msg("400"))
        rows = Disappearing.upsertRow(rows, msg("200"))
        rows = Disappearing.upsertRow(rows, msg("300"))
        assertEquals(listOf("100", "200", "300", "400"), ids(rows))
        assertEquals("400", Disappearing.newestConfirmedId(rows))
        // Older than everything loaded: first.
        assertEquals(listOf("50", "100", "400"), ids(Disappearing.upsertRow(listOf(msg("100"), msg("400")), msg("50"))))
        assertEquals(listOf("7"), ids(Disappearing.upsertRow(emptyList(), msg("7"))))
        // Snowflake order across the digit rollover.
        assertEquals(listOf("999", "1000"), ids(Disappearing.upsertRow(listOf(msg("1000")), msg("999"))))
        assertEquals(listOf("999", "1000"), ids(Disappearing.upsertRow(listOf(msg("999")), msg("1000"))))
    }

    @Test fun aSendInFlightStaysLastUntilItsEchoTakesItsPlace() {
        val sending = Message(id = "pending-a", channelId = "c1", createdAt = "", authorId = "me", nonce = "a")
        var rows = Disappearing.upsertRow(listOf(msg("100")), sending)
        assertEquals(listOf("100", "pending-a"), ids(rows))
        // Someone else's message meanwhile lands above it.
        rows = Disappearing.upsertRow(rows, msg("300"))
        assertEquals(listOf("100", "300", "pending-a"), ids(rows))
        // A second send goes after the first.
        val second = sending.copy(id = "pending-b", nonce = "b")
        rows = Disappearing.upsertRow(rows, second)
        assertEquals(listOf("100", "300", "pending-a", "pending-b"), ids(rows))
        // The echo replaces its optimistic row by nonce, at its id's place.
        val earlier = Disappearing.upsertRow(rows, msg("200", authorId = "me").copy(nonce = "a"))
        assertEquals(listOf("100", "200", "300", "pending-b"), ids(earlier))
        val later = Disappearing.upsertRow(rows, msg("400", authorId = "me").copy(nonce = "a"))
        assertEquals(listOf("100", "300", "400", "pending-b"), ids(later))
        // The input list is left as it was.
        assertEquals(listOf("100", "300", "pending-a", "pending-b"), ids(rows))
    }

    @Test fun aRowAlreadyThereIsReplacedWhereItIs() {
        val rows = listOf(msg("100"), msg("200"), msg("300"))
        val edited = msg("200").copy(content = "edited")
        val next = Disappearing.upsertRow(rows, edited)
        assertEquals(listOf("100", "200", "300"), ids(next))
        assertEquals("edited", next[1].content)
        // Found by id, or by the nonce of the optimistic row it echoes.
        val sending = Message(id = "pending-a", channelId = "c1", createdAt = "", nonce = "a")
        assertEquals(1, Disappearing.rowIndex(rows, msg("200")))
        assertEquals(1, Disappearing.rowIndex(listOf(msg("100"), sending), msg("300").copy(nonce = "a")))
        assertEquals(-1, Disappearing.rowIndex(rows, msg("400")))
        // A row without a nonce never matches one by its absent nonce.
        assertEquals(-1, Disappearing.rowIndex(listOf(msg("100")), msg("400")))
        // Only an optimistic row is matched by nonce, never a confirmed one.
        assertFalse(Disappearing.isRowOf(msg("200").copy(nonce = "a"), msg("300").copy(nonce = "a")))
        assertTrue(Disappearing.isRowOf(sending, msg("300").copy(nonce = "a")))
        assertTrue(Disappearing.isRowOf(msg("300"), msg("300").copy(nonce = "a")))
    }

    @Test fun anEchoAfterACatchUpCopyRetiresTheSendInFlight() {
        val sending = Message(id = "pending-n", channelId = "c1", createdAt = "", authorId = "me", nonce = "n")
        val start = Disappearing.upsertRow(listOf(msg("100")), sending)
        val rest = msg("101", authorId = "me")              // a catch-up's copy: no nonce
        val echo = rest.copy(nonce = "n", content = "echo")
        // The catch-up's copy first: it lands above the send, and the echo
        // then replaces it and takes the optimistic row with it.
        var rows = Disappearing.upsertRow(start, rest)
        assertEquals(listOf("100", "101", "pending-n"), ids(rows))
        rows = Disappearing.upsertRow(rows, echo)
        assertEquals(listOf("100", "101"), ids(rows))
        assertEquals("echo", rows[1].content)
        // The echo first, then the copy: the copy replaces it where it is.
        rows = Disappearing.upsertRow(Disappearing.upsertRow(start, echo), rest)
        assertEquals(listOf("100", "101"), ids(rows))
        // The echo twice (the POST response and the gateway).
        rows = Disappearing.upsertRow(Disappearing.upsertRow(start, echo), echo)
        assertEquals(listOf("100", "101"), ids(rows))
        // Other sends in flight stay, in order.
        val other = sending.copy(id = "pending-m", nonce = "m")
        rows = Disappearing.upsertRow(Disappearing.upsertRow(Disappearing.upsertRow(start, other), rest), echo)
        assertEquals(listOf("100", "101", "pending-m"), ids(rows))
    }

    @Test fun aFullLatestWindowThatMissesTheCacheLeavesAGap() {
        fun page(vararg ids: String) = ids.map { msg(it) }
        val cached = page("10", "20")
        // Full, and everything in it is past the newest cached row.
        assertTrue(Disappearing.latestLeavesGap(cached, page("40", "30"), pageSize = 2))
        // It reaches the cache: no gap.
        assertFalse(Disappearing.latestLeavesGap(cached, page("30", "20"), pageSize = 2))
        assertFalse(Disappearing.latestLeavesGap(page("10", "35"), page("40", "30"), pageSize = 2))
        // A short window reaches back to the start.
        assertFalse(Disappearing.latestLeavesGap(cached, page("40"), pageSize = 2))
        // A send in flight is not a cached row of the window's.
        val sending = Message(id = "pending-a", channelId = "c1", createdAt = "", nonce = "a")
        assertTrue(Disappearing.latestLeavesGap(cached + sending, page("40", "30"), pageSize = 2))
        assertTrue(Disappearing.latestLeavesGap(listOf(sending), page("40", "30"), pageSize = 2))
        // Snowflake order across the digit rollover.
        assertFalse(Disappearing.latestLeavesGap(page("1000"), page("1001", "999"), pageSize = 2))
        assertTrue(Disappearing.latestLeavesGap(page("999"), page("1001", "1000"), pageSize = 2))
    }

    @Test fun settingsPatchCarriesAnExplicitNullForOff() {
        assertEquals("""{"ttlSecondsAfterRead":null}""", Disappearing.settingsPatchBody(null).toString())
        assertEquals("""{"ttlSecondsAfterRead":2419200}""", Disappearing.settingsPatchBody(2_419_200).toString())
    }
}
