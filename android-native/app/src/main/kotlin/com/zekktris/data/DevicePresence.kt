package com.zekktris.data

/**
 * Multi-device presence: the user's status follows the device in use.
 *
 * A server whose READY carries `features.presence_activity` derives the
 * EFFECTIVE status everyone sees from the status the user picked
 * (`SelfUser.chosenStatus`) and the activity each connected device reports:
 * chosen "online" reads "online" while ANY device is in use and "idle" once
 * none is (Zekktris open somewhere, nobody using it). This device reports its
 * activity in IDENTIFY/RESUME and with PRESENCE_UPDATE (op 3) on each change
 * ([Gateway.setPresenceActive]), and never PATCHes /users/@me {status} on its
 * own. Older servers ignore the reports; Android never had an automatic
 * away, so nothing else changes there.
 *
 * Pure logic, no Android types. Mirrors ios-native DevicePresence.swift.
 */
object DevicePresence {
    /** Time without input before this device counts as not in use. Same
     *  5 minutes as the web client and iOS. */
    const val IDLE_THRESHOLD_MS = 5 * 60_000L

    /** How often a foreground app re-checks the threshold. */
    const val TICK_MS = 60_000L

    /**
     * Whether the person is using this device: the app is in the foreground
     * AND they touched it within the threshold or are talking in voice. A
     * backgrounded app is idle at once, even with the socket still up (a
     * background voice call, or the minutes before Android kills it).
     * [msSinceInteraction] is null when there was no interaction at all.
     */
    fun isActive(foreground: Boolean, msSinceInteraction: Long?, talking: Boolean): Boolean =
        foreground && (talking || (msSinceInteraction != null && msSinceInteraction < IDLE_THRESHOLD_MS))

    /**
     * The status the picker shows as selected: what the user CHOSE. An older
     * server sends no `chosenStatus`, and there `status` is the choice.
     * "offline" or nothing (a stale pre-connect snapshot, a fresh account) is
     * never a choice, so Online is selected then.
     */
    fun pickerStatus(chosen: String?, status: String?): String {
        val s = chosen ?: status
        return if (s.isNullOrEmpty() || s == "offline") "online" else s
    }

    /**
     * The user's own avatar dot.
     *
     *  - [chosen]: what the picker shows ([pickerStatus]).
     *  - [effective]: `SelfUser.status` — on a new server the effective status,
     *    unmasked, kept current by our own PRESENCE_UPDATEs ([selfFields]).
     *  - [serverDerives]: the server derives presence from device activity
     *    (the self user carries `chosenStatus`).
     *
     * Older server: the chosen status IS the presence. New server: chosen
     * Invisible shows Invisible; otherwise the effective status, so a phone in
     * use shows Online even while the idle Mac would say Away, and the phone
     * shows Away once nobody is using any device. "offline" for ourselves is
     * only ever a stale value while we're in the app, so it falls back to the
     * choice.
     */
    fun selfStatus(chosen: String, effective: String?, serverDerives: Boolean): String {
        if (!serverDerives) return chosen
        if (chosen == "invisible") return "invisible"
        if (effective != null && effective != "offline" && effective != "invisible") return effective
        return chosen
    }

    /** What a PRESENCE_UPDATE about ourselves says about our own status. */
    data class SelfFields(val chosen: String, val effective: String)

    /**
     * Our own status from a PRESENCE_UPDATE about us. [status] is the frame's
     * (masked: Invisible arrives as "offline"); [frameChosen] is its
     * `chosen_status`, carried only by the guild_id=null frame to our own
     * connections; [knownChosen] is the self user's current `chosenStatus`.
     * Returns null when neither is known — an older server, whose frames must
     * not overwrite the self user (there `status` is the choice). The
     * effective value is unmasked: chosen Invisible reads "invisible".
     */
    fun selfFields(status: String, frameChosen: String?, knownChosen: String?): SelfFields? {
        val chosen = frameChosen ?: knownChosen ?: return null
        return SelfFields(chosen, if (chosen == "invisible") "invisible" else status)
    }
}

/**
 * What this device has told the gateway about its activity, so a change is
 * sent once and never repeated. Owned by [Gateway] (which serializes access);
 * mirrors the web client's presenceActive / presenceSent pair
 * (packages/client/src/gateway.ts) and iOS's PresenceReport.
 */
class PresenceReport {
    /** The activity the app last reported. null until it reports: IDENTIFY
     *  then omits `presence`, which the server reads as active. */
    var reported: Boolean? = null
        private set

    /** The value the server's session holds for this connection (sent in
     *  IDENTIFY/RESUME or as op 3). null = nothing sent on this session. */
    var sent: Boolean? = null
        private set

    fun report(active: Boolean) { reported = active }

    /** `presence` for an IDENTIFY. Records it as what the server holds. */
    fun identifyValue(): Boolean? {
        sent = reported
        return reported
    }

    /** `presence` for a RESUME. Omitted (null) keeps the resumed session's
     *  value, which is the one we last sent. */
    fun resumeValue(): Boolean? {
        reported?.let { sent = it }
        return reported
    }

    /**
     * The value to send as PRESENCE_UPDATE (op 3), or null when nothing is
     * due: not live yet, an older server, nothing reported, or no change
     * since the server last heard from us. Records a returned value as sent.
     */
    fun takeUpdate(live: Boolean, supported: Boolean): Boolean? {
        val r = reported
        if (!live || !supported || r == null || r == sent) return null
        sent = r
        return r
    }
}
