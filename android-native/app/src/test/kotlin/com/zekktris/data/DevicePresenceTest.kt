package com.zekktris.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test

/** Multi-device presence logic (DevicePresence.kt). Mirrors iOS DevicePresenceTests. */
class DevicePresenceTest {
    private val threshold = DevicePresence.IDLE_THRESHOLD_MS

    @Test fun activeOnlyInForegroundWithRecentInputOrTalking() {
        assertEquals(true, DevicePresence.isActive(foreground = true, msSinceInteraction = 0, talking = false))
        assertEquals(true, DevicePresence.isActive(true, threshold - 1, false))
        assertEquals(false, DevicePresence.isActive(true, threshold, false))
        assertEquals(false, DevicePresence.isActive(true, null, false))
        // Talking in voice counts as using the device.
        assertEquals(true, DevicePresence.isActive(true, threshold * 3, true))
        // Backgrounded is idle at once, whatever else is going on.
        assertEquals(false, DevicePresence.isActive(false, 0, false))
        assertEquals(false, DevicePresence.isActive(false, 0, true))
    }

    @Test fun startingAndStoppingTalkingAreInteractions() {
        val me = "me"
        assertEquals(true, DevicePresence.talkingChanged(me, prev = emptySet(), next = setOf(me)))
        assertEquals(true, DevicePresence.talkingChanged(me, setOf("bob"), setOf("bob", me)))
        // Stopping counts too: after a 6-minute monologue the idle window
        // runs from the last word, not the first.
        assertEquals(true, DevicePresence.talkingChanged(me, setOf(me), emptySet()))
        assertEquals(true, DevicePresence.talkingChanged(me, setOf(me, "bob"), setOf("bob")))
        // Only other people talking is not us using the device.
        assertEquals(false, DevicePresence.talkingChanged(me, setOf("bob"), setOf("bob", "eve")))
        assertEquals(false, DevicePresence.talkingChanged(me, emptySet(), emptySet()))
        assertEquals(false, DevicePresence.talkingChanged(null, setOf(me), setOf(me)))
    }

    @Test fun pickerShowsTheChosenStatus() {
        assertEquals("dnd", DevicePresence.pickerStatus(chosen = "dnd", status = "online"))
        // Mac idle → effective Away, but the user picked Online.
        assertEquals("online", DevicePresence.pickerStatus("online", "idle"))
        // Older server: no chosenStatus, `status` is the choice.
        assertEquals("idle", DevicePresence.pickerStatus(null, "idle"))
        // A stale pre-connect "offline" or nothing is never a choice.
        assertEquals("online", DevicePresence.pickerStatus(null, "offline"))
        assertEquals("online", DevicePresence.pickerStatus(null, null))
    }

    @Test fun ownDotFollowsTheEffectiveStatus() {
        // Phone put away, Mac open but idle → Away although Online was picked.
        assertEquals("idle", DevicePresence.selfStatus(chosen = "online", effective = "idle", serverDerives = true))
        assertEquals("online", DevicePresence.selfStatus("online", "online", true))
        assertEquals("dnd", DevicePresence.selfStatus("dnd", "dnd", true))
        assertEquals("invisible", DevicePresence.selfStatus("invisible", "offline", true))
        // Picked Invisible: an effective value from before the pick doesn't leak.
        assertEquals("invisible", DevicePresence.selfStatus("invisible", "online", true))
        // A stale "offline" (or nothing yet) while we're in the app → the choice.
        assertEquals("dnd", DevicePresence.selfStatus("dnd", "offline", true))
        assertEquals("online", DevicePresence.selfStatus("online", null, true))
        // Older server: the choice is the presence, as before.
        assertEquals("online", DevicePresence.selfStatus("online", "idle", false))
        assertEquals("idle", DevicePresence.selfStatus("idle", "offline", false))
    }

    @Test fun ownPresenceUpdateFields() {
        // The guild_id=null frame to our own connections carries chosen_status.
        assertEquals(
            DevicePresence.SelfFields(chosen = "online", effective = "idle"),
            DevicePresence.selfFields(status = "idle", frameChosen = "online", knownChosen = "dnd"),
        )
        // Guild frames don't: keep the known choice.
        assertEquals(DevicePresence.SelfFields("dnd", "dnd"), DevicePresence.selfFields("dnd", null, "dnd"))
        // Invisible arrives masked as offline; ours is unmasked.
        assertEquals(DevicePresence.SelfFields("invisible", "invisible"), DevicePresence.selfFields("offline", "invisible", "online"))
        // Older server (no chosen status anywhere): leave the self user alone.
        assertNull(DevicePresence.selfFields("online", null, null))
    }

    @Test fun reportSendsEachChangeOnceAndOnlyWhereSupported() {
        val r = PresenceReport()
        // Nothing reported yet: IDENTIFY omits `presence` (server reads active).
        assertNull(r.identifyValue())
        r.report(false)
        assertNull(r.takeUpdate(live = false, supported = true)) // before READY
        assertNull(r.takeUpdate(live = true, supported = false)) // older server
        assertEquals(false, r.takeUpdate(live = true, supported = true))
        assertNull(r.takeUpdate(live = true, supported = true)) // never repeated
        r.report(false)
        assertNull(r.takeUpdate(live = true, supported = true))
        r.report(true)
        // A handshake carries it, so no op 3 follows for the same value.
        assertEquals(true, r.identifyValue())
        assertNull(r.takeUpdate(live = true, supported = true))
        r.report(false)
        assertEquals(false, r.resumeValue())
        assertNull(r.takeUpdate(live = true, supported = true))
        // A change after the handshake goes out once.
        r.report(true)
        assertEquals(true, r.takeUpdate(live = true, supported = true))
    }

    @Test fun resumeWithoutAReportKeepsWhatTheServerHolds() {
        val r = PresenceReport()
        assertNull(r.resumeValue())
        assertNull(r.sent)
    }
}
