package com.zekktris.data.model

import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Test

/** The own-status fields on the wire: the PATCH /users/@me bodies the app
 *  sends and the self user it reads (same Json settings as ApiClient). */
class SelfStatusWireTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; isLenient = true }

    private fun body(p: ProfilePatch): JsonObject = json.parseToJsonElement(json.encodeToString(p)).jsonObject

    /** A picked status is marked manual, so the server keeps a chosen Away
     *  past the user's last device disconnecting. */
    @Test fun statusPickIsMarkedManual() {
        val b = body(ProfilePatch.statusPick("idle"))
        assertEquals("idle", b["status"]?.jsonPrimitive?.content)
        assertEquals("manual", b["statusSource"]?.jsonPrimitive?.content)
        assertEquals(setOf("status", "statusSource"), b.keys)
    }

    /** Other profile edits carry neither field. */
    @Test fun profileEditCarriesNoStatus() {
        val b = body(ProfilePatch(displayName = "Ada", bio = "hi"))
        assertFalse("status" in b)
        assertFalse("statusSource" in b)
    }

    /** A multi-device server's self user: `status` and `chosenStatus` are the
     *  pick, `effectiveStatus` what everyone sees (here: the idle Mac). */
    @Test fun selfUserCarriesThePickAndTheEffectiveStatus() {
        val me = json.decodeFromString<SelfUser>(
            """{"id":"1","status":"online","chosenStatus":"online","effectiveStatus":"idle"}""",
        )
        assertEquals("online", me.status)
        assertEquals("online", me.chosenStatus)
        assertEquals("idle", me.effectiveStatus)
    }

    /** An older server sends neither newer field. */
    @Test fun olderSelfUserHasNoChosenOrEffectiveStatus() {
        val me = json.decodeFromString<SelfUser>("""{"id":"1","status":"dnd"}""")
        assertEquals("dnd", me.status)
        assertNull(me.chosenStatus)
        assertNull(me.effectiveStatus)
    }
}
