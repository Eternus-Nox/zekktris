package com.zekktris.ui.components

import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.Locale

private val TIME_FMT = DateTimeFormatter.ofPattern("h:mm a", Locale.getDefault())
private val DAY_FMT = DateTimeFormatter.ofPattern("MMM d, yyyy", Locale.getDefault())

fun parseInstant(iso: String?): Instant? =
    if (iso == null) null else runCatching { Instant.parse(iso) }.getOrNull()

fun shortTime(iso: String?): String {
    val inst = parseInstant(iso) ?: return ""
    return inst.atZone(ZoneId.systemDefault()).format(TIME_FMT)
}

fun dayLabel(iso: String?): String {
    val inst = parseInstant(iso) ?: return ""
    // Relative labels for the two most recent days (iOS Components.swift:727-733,
    // web MessageView.tsx:1582-1597), else the full date.
    val date = inst.atZone(ZoneId.systemDefault()).toLocalDate()
    val today = java.time.LocalDate.now(ZoneId.systemDefault())
    return when (date) {
        today -> "Today"
        today.minusDays(1) -> "Yesterday"
        else -> inst.atZone(ZoneId.systemDefault()).format(DAY_FMT)
    }
}

/**
 * Compact "how long ago" for an ISO instant — "just now", "5m ago", "3h ago",
 * "2d ago", "3w ago", then the plain date once it's older than ~a year.
 * Returns null for a missing/unparseable timestamp so callers can fall back to
 * a plain label instead of printing a bogus duration. Future timestamps (clock
 * skew) clamp to "just now".
 */
fun relativeAgo(iso: String?): String? {
    val inst = parseInstant(iso) ?: return null
    val secs = Instant.now().epochSecond - inst.epochSecond
    return when {
        secs < 60 -> "just now"
        secs < 3600 -> "${secs / 60}m ago"
        secs < 86_400 -> "${secs / 3600}h ago"
        secs < 604_800 -> "${secs / 86_400}d ago"
        secs < 31_536_000 -> "${secs / 604_800}w ago"
        else -> inst.atZone(ZoneId.systemDefault()).format(DAY_FMT)
    }
}

/**
 * The one-line presence caption under a friend's name. Online needs no
 * timestamp; Away/DND show the status AND when they were last seen active;
 * offline (which is also how Invisible reads — the server masks it and freezes
 * the timestamp) shows only the last-online time. [lastSeen] null → the status
 * word alone, never a fabricated time.
 */
fun presenceCaption(status: String?, lastSeen: String?): String {
    val ago = relativeAgo(lastSeen)
    return when (status) {
        "online" -> "Online"
        // 'idle' is the wire value; "Away" is the only word users ever see.
        "idle" -> if (ago != null) "Away · Active $ago" else "Away"
        "dnd" -> if (ago != null) "Do Not Disturb · Active $ago" else "Do Not Disturb"
        else -> if (ago != null) "Last online $ago" else "Offline"
    }
}

/** True when both ISO instants fall on the same LOCAL calendar day. Use this
 *  (not dayLabel string equality) for day-boundary checks — the relative
 *  "Today"/"Yesterday" labels are display-only. */
fun sameLocalDay(a: String?, b: String?): Boolean {
    val ia = parseInstant(a) ?: return false
    val ib = parseInstant(b) ?: return false
    val z = ZoneId.systemDefault()
    return ia.atZone(z).toLocalDate() == ib.atZone(z).toLocalDate()
}

/** True if two ISO timestamps are the same author's burst (within [minutes]).
 *  1 minute: a message sent a minute or more after the previous one starts a
 *  NEW block with the avatar + timestamp, so exchanges don't clump together. */
fun withinMinutes(a: String?, b: String?, minutes: Long = 1): Boolean {
    val ia = parseInstant(a) ?: return false
    val ib = parseInstant(b) ?: return false
    return kotlin.math.abs(ia.epochSecond - ib.epochSecond) <= minutes * 60
}
