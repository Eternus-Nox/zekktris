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
    return inst.atZone(ZoneId.systemDefault()).format(DAY_FMT)
}

/** True if two ISO timestamps are the same author's burst (within [minutes]). */
fun withinMinutes(a: String?, b: String?, minutes: Long = 5): Boolean {
    val ia = parseInstant(a) ?: return false
    val ib = parseInstant(b) ?: return false
    return kotlin.math.abs(ia.epochSecond - ib.epochSecond) <= minutes * 60
}
