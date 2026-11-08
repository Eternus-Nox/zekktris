package com.zekktris.data

import com.zekktris.data.model.Message
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.intOrNull

/**
 * Signal-style disappearing messages.
 *
 * A DM has one timer (seconds, or null = off), set from the Disappearing
 * Messages screen and stored server-side as `ttlSecondsAfterRead`. Every
 * message keeps the timer it was SENT with ([Message.expireAfterSeconds]), so
 * a change only affects later messages and turning it off saves nothing that
 * was already sent with one. A message's countdown starts when a recipient
 * reads it (the read ack, never a plain fetch); the server then knows
 * `expires_at` and tells the reader's devices (and, with read receipts on, the
 * author's) in MESSAGE_EXPIRY, and REST pages carry it as [Message.expiresAt].
 * At that moment the row disappears for everyone: the server's sweep sends
 * MESSAGE_DELETE, and the app hides it itself at the deadline.
 *
 * Pure logic, no Android types: the presets and their labels (worded exactly
 * like web, iOS and the server's fallback text), the Custom Time picker's
 * number + unit math, the in-chat notice text, the gateway payloads, the
 * local-deadline rules AppStore's expiry scheduler runs on, what to ack, the
 * order a conversation's rows are kept in, and where its newest message is
 * once rows have gone.
 */
object Disappearing {
    /** The Disappearing Messages screen's description (Signal's copy). */
    const val DESCRIPTION =
        "When enabled, new messages sent and received in this chat will disappear after they have been seen."

    /** Longest timer a current server accepts: 4 weeks. */
    const val MAX_SECONDS = 2_419_200

    /** The timer values (seconds) a server accepts, inclusive. */
    data class Bounds(val min: Int, val max: Int) {
        operator fun contains(seconds: Int): Boolean = seconds in min..max
    }

    /** A current server: 1 second to 4 weeks. */
    val BOUNDS = Bounds(1, MAX_SECONDS)

    /** A server from before Signal-style timers validates 10..86400 s and
     *  sends no `maxTtlSeconds`. A self-hosted server can lag the app, so the
     *  screen offers only what it will take instead of letting it 400. */
    val LEGACY_BOUNDS = Bounds(10, 86_400)

    /** Bounds from GET settings' `maxTtlSeconds` (absent on older servers). */
    fun boundsFor(maxTtlSeconds: Int?): Bounds =
        if (maxTtlSeconds != null && maxTtlSeconds >= 1) Bounds(1, maxTtlSeconds) else LEGACY_BOUNDS

    /** The fixed choices, in Signal's order (longest first). */
    val PRESETS: List<Int> = listOf(2_419_200, 604_800, 86_400, 28_800, 3_600, 300, 30)

    /** A value is a preset only if it equals one of the seven; anything else
     *  (60, 120, 90, 259200 …) is Custom. */
    fun isPreset(seconds: Int?): Boolean = seconds != null && seconds in PRESETS

    fun presetsWithin(bounds: Bounds): List<Int> = PRESETS.filter { it in bounds }

    // ── Formatting ────────────────────────────────────────────────────────

    private class Part(val seconds: Int, val singular: String, val short: String)

    private val PARTS = listOf(
        Part(604_800, "week", "w"),
        Part(86_400, "day", "d"),
        Part(3_600, "hour", "h"),
        Part(60, "minute", "m"),
        Part(1, "second", "s"),
    )

    /** Every non-zero week / day / hour / minute / second part, largest first. */
    private fun decompose(seconds: Int): List<Pair<Int, Part>> {
        var rest = seconds.coerceAtLeast(0)
        val out = ArrayList<Pair<Int, Part>>(PARTS.size)
        for (p in PARTS) {
            val n = rest / p.seconds
            if (n > 0) {
                out += n to p
                rest -= n * p.seconds
            }
        }
        return out
    }

    /** "4 weeks", "1 day", "1 minute 30 seconds". */
    fun formatLong(seconds: Int): String {
        val parts = decompose(seconds)
        if (parts.isEmpty()) return "0 seconds"
        return parts.joinToString(" ") { (n, p) -> "$n ${p.singular}${if (n == 1) "" else "s"}" }
    }

    /** "4w", "1d", "8h", "1m 30s" — the header indicator. */
    fun formatShort(seconds: Int): String {
        val parts = decompose(seconds)
        if (parts.isEmpty()) return "0s"
        return parts.joinToString(" ") { (n, p) -> "$n${p.short}" }
    }

    /** A DM setting as a label: "Off" for null / non-positive, else [formatLong]. */
    fun label(seconds: Int?): String = if (seconds != null && seconds > 0) formatLong(seconds) else "Off"

    // ── Custom Time picker ────────────────────────────────────────────────

    /** The picker's unit column, smallest first, with each unit's largest number. */
    enum class TimerUnit(val seconds: Int, val max: Int, val singular: String, val plural: String) {
        Seconds(1, 59, "second", "seconds"),
        Minutes(60, 59, "minute", "minutes"),
        Hours(3_600, 23, "hour", "hours"),
        Days(86_400, 6, "day", "days"),
        Weeks(604_800, 4, "week", "weeks"),
    }

    data class Custom(val n: Int, val unit: TimerUnit) {
        val seconds: Int get() = n * unit.seconds
    }

    /** The numbers [unit] offers, narrowed to what the server accepts; null
     *  when no number of that unit fits (weeks on an older server). */
    fun unitRange(unit: TimerUnit, bounds: Bounds = BOUNDS): IntRange? {
        val min = maxOf(1, ceilDiv(bounds.min, unit.seconds))
        val max = minOf(unit.max, bounds.max / unit.seconds)
        return if (min <= max) min..max else null
    }

    /** Units with at least one valid number under these bounds. */
    fun availableUnits(bounds: Bounds = BOUNDS): List<TimerUnit> =
        TimerUnit.entries.filter { unitRange(it, bounds) != null }

    /** [n] clamped into [unit]'s range. */
    fun clampNumber(n: Int, unit: TimerUnit, bounds: Bounds = BOUNDS): Int {
        val r = unitRange(unit, bounds) ?: return 1
        return n.coerceIn(r.first, r.last)
    }

    /** Keep a picker value inside the bounds: an unavailable unit moves to the
     *  nearest available one, then the number is clamped. */
    private fun fit(c: Custom, bounds: Bounds): Custom {
        val units = availableUnits(bounds)
        if (units.isEmpty()) return c
        val unit = when {
            c.unit in units -> c.unit
            c.unit.seconds > bounds.max -> units.last()
            else -> units.first()
        }
        return Custom(clampNumber(c.n, unit, bounds), unit)
    }

    /** Switching the unit keeps the number, clamped to the new unit's range. */
    fun changeUnit(c: Custom, unit: TimerUnit, bounds: Bounds = BOUNDS): Custom = fit(Custom(c.n, unit), bounds)

    /**
     * The Custom Time picker's starting value for the current setting:
     *  - exactly n × one unit with n inside that unit's range → that;
     *  - otherwise the largest unit u with value ≥ u, n = clamp(⌊value / u⌋,
     *    1, max(u)) — 90 s → 1 minute, 25 h → 1 day, 10 days → 1 week;
     *  - no current value → 1 day.
     * The unit ranges don't overlap, so the exact match is unique.
     */
    fun customInitial(value: Int?, bounds: Bounds = BOUNDS): Custom {
        if (value == null || value < 1) return fit(Custom(1, TimerUnit.Days), bounds)
        val largestFirst = TimerUnit.entries.reversed()
        for (u in largestFirst) {
            if (value % u.seconds == 0) {
                val n = value / u.seconds
                if (n in 1..u.max) return fit(Custom(n, u), bounds)
            }
        }
        for (u in largestFirst) {
            if (value >= u.seconds) return fit(Custom((value / u.seconds).coerceIn(1, u.max), u), bounds)
        }
        return fit(Custom(1, TimerUnit.Seconds), bounds)
    }

    private fun ceilDiv(a: Int, b: Int): Int = (a + b - 1) / b

    // ── The in-chat notice ────────────────────────────────────────────────

    /** The timer-change notice: type 'system_disappearing', or (defensively)
     *  any row carrying the 'disappearing_timer' metadata. */
    fun isNotice(m: Message): Boolean =
        m.type == "system_disappearing" || m.metadata?.kind == "disappearing_timer"

    /** The notice's new timer (0 = turned off), or null when it carries none. */
    fun noticeTimer(m: Message): Int? = m.metadata?.timerSeconds?.takeIf { it >= 0 }

    /** "You set disappearing messages to 1 day." / "Alex turned off
     *  disappearing messages." [timerSeconds] 0 (or less) means off. */
    fun noticeText(timerSeconds: Int, isSelf: Boolean, name: String): String {
        val who = if (isSelf) "You" else name
        return if (timerSeconds > 0) "$who set disappearing messages to ${formatLong(timerSeconds)}."
        else "$who turned off disappearing messages."
    }

    // ── Wire ──────────────────────────────────────────────────────────────

    /** PATCH /users/@me/channels/:id/settings body. The null must be EXPLICIT
     *  (it turns the timer off), and the app's Json drops nulls
     *  (explicitNulls = false), so it's built by hand. */
    fun settingsPatchBody(seconds: Int?): JsonObject = buildJsonObject {
        put("ttlSecondsAfterRead", seconds?.let { JsonPrimitive(it) } ?: JsonNull)
    }

    // ── Gateway payloads ──────────────────────────────────────────────────

    /** DM_SETTINGS_UPDATE: camelCase { channelId, ttlSecondsAfterRead }
     *  (older than the snake_case events). Null timer = off. */
    data class SettingsUpdate(val channelId: String, val seconds: Int?)

    fun parseSettingsUpdate(data: JsonElement?): SettingsUpdate? {
        val obj = data as? JsonObject ?: return null
        val cid = (obj["channelId"] as? JsonPrimitive)?.contentOrNull ?: return null
        val secs = (obj["ttlSecondsAfterRead"] as? JsonPrimitive)?.intOrNull
        return SettingsUpdate(cid, secs?.takeIf { it > 0 })
    }

    /** MESSAGE_EXPIRY: snake_case { channel_id, expiries: [{ id, expires_at }],
     *  server_now }, all times ISO server time. */
    data class Expiry(val channelId: String, val expiries: List<Pair<String, String>>, val serverNow: String?)

    fun parseExpiry(data: JsonElement?): Expiry? {
        val obj = data as? JsonObject ?: return null
        val cid = (obj["channel_id"] as? JsonPrimitive)?.contentOrNull ?: return null
        val list = (obj["expiries"] as? JsonArray)?.mapNotNull { el ->
            val e = el as? JsonObject ?: return@mapNotNull null
            val id = (e["id"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            val at = (e["expires_at"] as? JsonPrimitive)?.contentOrNull ?: return@mapNotNull null
            id to at
        } ?: return null
        return Expiry(cid, list, (obj["server_now"] as? JsonPrimitive)?.contentOrNull)
    }

    // ── Local deadlines ───────────────────────────────────────────────────
    //
    // Deadlines are kept in DEVICE-clock epoch ms: a server time is shifted by
    // the server-clock offset when it arrives, so a device whose clock is off
    // doesn't hide messages early or keep them late. The offset is
    // server − device, learned from MESSAGE_EXPIRY's server_now; every
    // estimate of it errs low (delivery latency), which only ever makes a
    // deadline fire a little late, never early.

    /** A known deadline: the row to remove and when, in device-clock ms. */
    data class Deadline(val channelId: String, val atMs: Long)

    /** How long a passed deadline is remembered after it fired — long enough
     *  that a fetch in flight while it fired can't bring the row back (the
     *  server's reads drop it from then on). */
    const val RETAIN_MS = 10 * 60_000L

    /** Epoch ms of a server ISO time; null when absent or unparseable. */
    fun parseServerTime(iso: String?): Long? =
        if (iso.isNullOrEmpty()) null else runCatching { java.time.Instant.parse(iso).toEpochMilli() }.getOrNull()

    /** server − device from an event's `server_now` and the device time it arrived. */
    fun offsetFrom(serverNowIso: String?, receivedAtMs: Long): Long? =
        parseServerTime(serverNowIso)?.let { it - receivedAtMs }

    /**
     * server − device from an HTTP `Date` header (whole seconds, RFC 1123),
     * read at [receivedAtMs], once the response is in. The header truncates
     * to the second and was written before the response arrived, so this is
     * a LOWER bound of the true offset — a deadline derived from it never
     * fires early. A fallback for REST deadlines until an event's precise
     * `server_now` is known.
     */
    fun offsetFromDateHeader(header: String?, receivedAtMs: Long): Long? {
        if (header.isNullOrBlank()) return null
        val at = runCatching {
            java.time.ZonedDateTime.parse(header.trim(), java.time.format.DateTimeFormatter.RFC_1123_DATE_TIME)
                .toInstant().toEpochMilli()
        }.getOrNull() ?: return null
        return at - receivedAtMs
    }

    /** A server-time `expires_at` as a device-clock deadline. */
    fun localDeadline(expiresAtIso: String?, offsetMs: Long): Long? =
        parseServerTime(expiresAtIso)?.let { it - offsetMs }

    /** The earliest deadline still in the future, or null. */
    fun nextDeadline(deadlines: Iterable<Long>, nowMs: Long): Long? {
        var best: Long? = null
        for (d in deadlines) if (d > nowMs && (best == null || d < best)) best = d
        return best
    }

    fun isExpired(deadlineMs: Long?, nowMs: Long): Boolean = deadlineMs != null && deadlineMs <= nowMs

    /** Snowflake order: by length, then by digits (the ids grew a digit once,
     *  so a bare string compare comes apart across the rollover). */
    fun compareIds(a: String, b: String): Int =
        if (a.length != b.length) a.length.compareTo(b.length) else a.compareTo(b)

    private val ID_ORDER = Comparator<String> { a, b -> compareIds(a, b) }

    /** A confirmed row's id (an optimistic one is "pending-…"). */
    private fun isServerId(id: String): Boolean = id.isNotEmpty() && id.all(Char::isDigit)

    /**
     * The newest confirmed row's id: the highest server id in [rows], not the
     * last row's, so a list that ever lands out of order can't ack below what
     * is on screen (an ack starts the countdown of only the rows it covers).
     * Null when every row is optimistic, or there are none.
     */
    fun newestConfirmedId(rows: List<Message>): String? =
        rows.asSequence().map { it.id }.filter(::isServerId).maxWithOrNull(ID_ORDER)

    /**
     * Whether acking up to [upToId] started this row's countdown on the
     * server, so the reader can hide it on its own clock when the socket
     * misses MESSAGE_EXPIRY: a confirmed (non-pending) row with a timer,
     * someone else's, with no deadline known yet, at or before the acked id —
     * exactly the rows the server's ack stamps. Its local deadline is then
     * device-now + the timer, taken after the ack answered, so it is never
     * earlier than the server's.
     */
    fun startsOnAck(m: Message, meId: String?, upToId: String, known: Boolean): Boolean {
        if (known || meId == null) return false
        val secs = m.expireAfterSeconds ?: return false
        if (secs <= 0 || !m.id.all(Char::isDigit) || m.id.isEmpty()) return false
        if ((m.authorId ?: m.author?.id) == meId) return false
        return compareIds(m.id, upToId) <= 0
    }

    /** The later of two ids, either of which may be absent. */
    fun laterId(a: String?, b: String?): String? = when {
        a == null -> b
        b == null -> a
        compareIds(a, b) >= 0 -> a
        else -> b
    }

    /**
     * The id to ack for a conversation the user has on screen, or null when
     * no POST is needed. That is the newest confirmed row, the same one the
     * ack sends, whenever the read pointer [readUpTo] doesn't cover it.
     *
     * A pointer at or past it usually means the server recorded that read,
     * by an ack or a send from any device, and either one started the
     * clocks. Not always: our own row that the server doesn't count as a
     * read (a scheduled message firing, a streak warning in our name) moves
     * the pointer here too, while someone's timed message under it waits
     * unstarted. So a row from someone else with a timer and no known
     * deadline ([known], by id) is acked anyway, once per id: not when
     * [lastAcked], this device's last ack in the conversation, is that id.
     */
    fun ackTarget(
        rows: List<Message>,
        readUpTo: String?,
        meId: String?,
        lastAcked: String?,
        known: (String) -> Boolean,
    ): String? {
        val newest = newestConfirmedId(rows) ?: return null
        if (readUpTo == null || compareIds(newest, readUpTo) > 0) return newest
        if (newest == lastAcked) return null
        return if (rows.any { startsOnAck(it, meId, newest, known = false) && !known(it.id) }) newest else null
    }

    /**
     * An id past the loaded rows to ack on open, or null. [knownLast] is the
     * conversation's newest message id as this device knew it before a
     * latest-window fetch, and [fetched] what that fetch kept (null when it
     * failed). The fetch began after that message existed, so a window with
     * nothing at or past it means the message is gone (deleted, or expired
     * and swept) and its id only marks where the conversation ended. The
     * server takes a deleted row's id as a read marker, and acking it clears
     * the unread dot it left, which acking the newest loaded row can't. It
     * starts no countdown on anything unseen: every live row up to it is in
     * the window.
     */
    fun pastTailAck(knownLast: String?, fetched: List<Message>?): String? {
        if (fetched == null || knownLast == null || !isServerId(knownLast)) return null
        val newest = fetched.asSequence().map { it.id }.filter(::isServerId).maxWithOrNull(ID_ORDER)
        return if (newest == null || compareIds(knownLast, newest) > 0) knownLast else null
    }

    /**
     * The ids an ack tries, in order, until the server takes one: the later
     * of [newest], the newest confirmed row loaded, and [pastTail]
     * ([pastTailAck]), then [newest] when the first was the past-tail id. The
     * server refuses a marker whose row was hard-deleted (an account purge,
     * a DM's E2EE purge), and the open must still ack what it shows.
     */
    fun ackCandidates(newest: String?, pastTail: String?): List<String> {
        val first = laterId(newest, pastTail) ?: return emptyList()
        return if (newest != null && first != newest) listOf(first, newest) else listOf(first)
    }

    /**
     * A conversation's newest message id once the [removed] rows (deleted,
     * or expired) have left its loaded list, leaving [remaining]. When
     * [lastId] was one of them it moves back to the newest confirmed row
     * still loaded, as the server moves its own: left on a row nobody can
     * load, it would keep an unread dot up that reading can't clear. With
     * nothing older loaded it stays ([pastTailAck] acks past it on open).
     * It stays too when the loaded rows may not [reachTail] (a cache from
     * before a reconnect that replayed nothing): messages missed in between
     * would sit above the newest still loaded, and moving back to it would
     * hide them as read.
     */
    fun lastAfterRemoval(
        lastId: String?,
        removed: Set<String>,
        remaining: List<Message>,
        reachTail: Boolean = true,
    ): String? {
        if (lastId == null || lastId !in removed || !reachTail) return lastId
        return remaining.asSequence().map { it.id }
            .filter { isServerId(it) && compareIds(it, lastId) < 0 }
            .maxWithOrNull(ID_ORDER) ?: lastId
    }

    /**
     * Whether the latest window [latest] (newest [pageSize] messages, any
     * order) leaves a hole above the cached [rows]: it is full, and no
     * confirmed row in [rows] is at or past its oldest. Messages missed in
     * between (more than a page) may then exist that nothing loads: older
     * paging starts below the cache and the after-cursor past the window, and
     * acking the window's newest would start their countdowns unseen. A short
     * window reaches back to the conversation's start.
     */
    fun latestLeavesGap(rows: List<Message>, latest: List<Message>, pageSize: Int): Boolean {
        if (latest.size < pageSize) return false
        val oldest = latest.asSequence().map { it.id }.filter(::isServerId).minWithOrNull(ID_ORDER) ?: return false
        return rows.none { isServerId(it.id) && compareIds(it.id, oldest) >= 0 }
    }

    // ── Row order ─────────────────────────────────────────────────────────

    /** Whether [row] is one [msg] stands for: the row with its id, or the
     *  optimistic row whose nonce it carries (its echo). */
    fun isRowOf(row: Message, msg: Message): Boolean =
        row.id == msg.id || (msg.nonce != null && row.nonce == msg.nonce && !isServerId(row.id))

    /** The first row [msg] stands for in [rows] ([isRowOf]); -1 when none. */
    fun rowIndex(rows: List<Message>, msg: Message): Int = rows.indexOfFirst { isRowOf(it, msg) }

    /**
     * [rows] with [msg] merged in, in the order the server lists them:
     * confirmed rows by id ([compareIds]), optimistic ones after them in the
     * order they were sent. A row already there under the same id is
     * replaced where it is; an optimistic row's echo, or a new row, goes to
     * its place. Appending instead put a row fetched after a live one below
     * it (a catch-up after a reconnect), and the ack, which covers only up
     * to the id it sends, then left the live one unread and its countdown
     * unstarted.
     */
    fun upsertRow(rows: List<Message>, msg: Message): List<Message> {
        // The optimistic row an echo retires goes wherever it is, even when
        // the id's row is there too: a catch-up (its rows carry no nonce) can
        // bring the row before its echo, and the copy then stayed "Sending…"
        // below every later message.
        val next = rows.filterNotTo(mutableListOf()) { it.id != msg.id && isRowOf(it, msg) }
        val same = next.indexOfFirst { it.id == msg.id }
        if (same >= 0) return next.apply { this[same] = msg }
        var at = next.size
        if (isServerId(msg.id)) {
            // From the end: past the optimistic rows and every later id. A
            // new message lands just above the sends still in flight.
            while (at > 0 && !(isServerId(next[at - 1].id) && compareIds(next[at - 1].id, msg.id) < 0)) at--
        }
        next.add(at, msg)
        return next
    }
}
