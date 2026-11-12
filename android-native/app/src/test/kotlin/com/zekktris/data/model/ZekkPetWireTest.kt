package com.zekktris.data.model

import com.zekktris.data.ZekkPet
import kotlinx.serialization.decodeFromString
import kotlinx.serialization.encodeToString
import kotlinx.serialization.json.Json
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Zekk Pet on the wire: PetDTO, GET /pet, the change answers, the notice
 *  metadata and READY's flag, as this app decodes them (same Json settings
 *  as ApiClient). A pet that fails to decode would hide the pet UI, so new,
 *  old and unknown shapes must all decode. */
class ZekkPetWireTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; isLenient = true }

    private val active = """{
        "channelId":"100","status":"active","invitedBy":"1","name":"Biscuit","level":5,"stage":"kid",
        "points":180,"levelFloor":175,"nextLevelAt":225,"mood":"happy",
        "tasks":[
          {"key":"both_hi","done":true,"points":10},
          {"key":"chatty","done":false,"points":10,"progress":{"a":{"userId":"1","count":4},"b":{"userId":"2","count":10},"goal":10}},
          {"key":"voice","done":false,"points":5},
          {"key":"photo","done":true,"points":5},
          {"key":"poke","done":false,"points":5}
        ],
        "fedToday":true,"lastFedDay":"2026-11-11","wakeBy":null,"adoptedAt":"2026-11-01T12:00:00.000Z",
        "today":"2026-11-11","dayEndsAt":"2026-11-12T00:00:00.000Z"
    }"""

    @Test fun decodesAnActivePet() {
        val p = json.decodeFromString<PetDTO>(active)
        assertEquals("100", p.channelId)
        assertEquals("active", p.status)
        assertEquals("1", p.invitedBy)
        assertEquals("Biscuit", p.name)
        assertEquals(5, p.level)
        assertEquals("kid", p.stage)
        assertEquals(180, p.points)
        assertEquals(175, p.levelFloor)
        assertEquals(225, p.nextLevelAt)
        assertEquals("happy", p.mood)
        assertEquals(listOf("both_hi", "chatty", "voice", "photo", "poke"), p.tasks.map { it.key })
        assertEquals(listOf(true, false, false, true, false), p.tasks.map { it.done })
        val chatty = p.tasks[1].progress
        assertEquals("1", chatty?.a?.userId)
        assertEquals(4, chatty?.a?.count)
        assertEquals(10, chatty?.b?.count)
        assertEquals(10, chatty?.goal)
        assertNull(p.tasks[0].progress)
        assertTrue(p.fedToday)
        assertEquals("2026-11-11", p.lastFedDay)
        assertNull(p.wakeBy)
        assertEquals("2026-11-01T12:00:00.000Z", p.adoptedAt)
        assertEquals("2026-11-11", p.today)
        assertEquals("2026-11-12T00:00:00.000Z", p.dayEndsAt)
        // And the view model reads it.
        assertEquals("5/50 to level 6", ZekkPet.levelProgress(p).label)
        assertEquals("4/10 · 10/10", ZekkPet.taskRows(p, "1")[1].progress)
    }

    @Test fun decodesAnInvite() {
        val p = json.decodeFromString<PetDTO>(
            """{"channelId":"100","status":"invited","invitedBy":"2","name":"Zekk","level":0,"stage":"egg","points":0,
               "levelFloor":0,"nextLevelAt":25,"mood":"hungry","tasks":[],"fedToday":false,"lastFedDay":null,"wakeBy":null,
               "adoptedAt":null,"today":"2026-11-11","dayEndsAt":"2026-11-12T00:00:00.000Z"}""",
        )
        assertEquals("invited", p.status)
        assertEquals("2", p.invitedBy)
        assertEquals("egg", p.stage)
        assertTrue(p.tasks.isEmpty())
        assertNull(p.adoptedAt)
        assertNull(p.lastFedDay)
    }

    @Test fun asleepCarriesItsWakeByDay() {
        val p = json.decodeFromString<PetDTO>(active.replace("\"mood\":\"happy\"", "\"mood\":\"asleep\"")
            .replace("\"status\":\"active\"", "\"status\":\"asleep\"")
            .replace("\"wakeBy\":null", "\"wakeBy\":\"2026-11-13\""))
        assertEquals("asleep", p.status)
        assertEquals("2026-11-13", p.wakeBy)
        assertEquals("Your streak broke. Both say hi by Friday to wake it up, or it runs away.", ZekkPet.moodView(p).line)
    }

    @Test fun unknownValuesAndFieldsDoNotBreakIt() {
        // A newer server's status / stage / mood / task, an extra field (the
        // per-DM hue an earlier draft had), and a progress shape with more in it.
        val p = json.decodeFromString<PetDTO>(
            """{"channelId":"100","status":"hibernating","name":"Biscuit","hue":200,"level":30,"stage":"mythic",
               "mood":"ecstatic","sparkle":true,
               "tasks":[{"key":"dance","done":true,"points":7,"extra":1},{"key":"chatty","done":true,"points":10,
               "progress":{"a":{"userId":"1","count":10,"x":1},"goal":10,"c":{}}}],
               "today":"2026-11-11","dayEndsAt":"2026-11-12T00:00:00.000Z"}""",
        )
        assertEquals("hibernating", p.status)
        assertEquals("mythic", p.stage)
        assertEquals("ecstatic", p.mood)
        assertEquals(ZekkPet.Stage.Egg, ZekkPet.Stage.of(p.stage))
        assertEquals(ZekkPet.Mood.Happy, ZekkPet.Mood.of(p.mood))
        val rows = ZekkPet.taskRows(p, "1")
        assertEquals(5, rows.size) // "dance" isn't a row
        assertTrue(rows[1].done)
        assertEquals("10/10 · 0/10", rows[1].progress)
        // Missing fields take their defaults.
        assertNull(p.invitedBy)
        assertEquals(0, p.points)
        assertFalse(p.fedToday)
    }

    @Test fun nullsWhereValuesBelongTakeDefaults() {
        val p = json.decodeFromString<PetDTO>(
            """{"channelId":"100","status":null,"name":null,"level":null,"stage":null,"mood":null,"tasks":null,
               "fedToday":null,"today":null,"dayEndsAt":null}""",
        )
        assertEquals("active", p.status)
        assertEquals("Zekk", p.name)
        assertEquals(0, p.level)
        assertEquals("egg", p.stage)
        assertEquals("happy", p.mood)
        assertTrue(p.tasks.isEmpty())
        assertEquals("", p.today)
    }

    @Test fun getPetState() {
        val none = json.decodeFromString<DmPetState>("""{"pet":null,"eligible":true,"streak":5,"minStreak":3}""")
        assertNull(none.pet)
        assertTrue(none.eligible)
        assertEquals(5, none.streak)
        assertEquals(3, none.minStreak)
        val some = json.decodeFromString<DmPetState>("""{"pet":$active,"eligible":false,"streak":9,"minStreak":3}""")
        assertEquals("Biscuit", some.pet?.name)
        assertFalse(some.eligible)
        val bare = json.decodeFromString<DmPetState>("{}")
        assertNull(bare.pet)
        assertFalse(bare.eligible)
        assertEquals(3, bare.minStreak)
        // canAct: absent (older servers) reads as allowed; false is kept.
        assertTrue(none.canAct)
        assertTrue(bare.canAct)
        val blocked = json.decodeFromString<DmPetState>("""{"pet":$active,"eligible":false,"streak":9,"minStreak":3,"canAct":false}""")
        assertFalse(blocked.canAct)
    }

    @Test fun changeAnswersAndRenameBody() {
        assertEquals("Biscuit", json.decodeFromString<DmPetWrap>("""{"pet":$active}""").pet?.name)
        assertNull(json.decodeFromString<DmPetWrap>("""{"pet":null}""").pet)
        assertEquals("""{"name":"Biscuit"}""", json.encodeToString(PetRenameBody("Biscuit")))
    }

    @Test fun noticeMetadata() {
        val m = json.decodeFromString<Message>(
            """{"id":"900","channelId":"100","createdAt":"2026-11-11T10:00:00Z","authorId":"1","type":"system_pet",
               "content":"Alex renamed the pet to Biscuit.",
               "metadata":{"kind":"pet","event":"renamed","petName":"Biscuit","stage":"kid","actorId":"1"}}""",
        )
        assertEquals("system_pet", m.type)
        assertEquals("pet", m.metadata?.kind)
        assertEquals("renamed", m.metadata?.event)
        assertEquals("Biscuit", m.metadata?.petName)
        assertEquals("kid", m.metadata?.stage)
        assertEquals("1", m.metadata?.actorId)
        assertTrue(ZekkPet.isNotice(m))
        assertEquals("You renamed the pet to Biscuit.", ZekkPet.noticeLine(m, "1", "2", "Sam", "Alex"))
        assertEquals("Alex renamed the pet to Biscuit.", ZekkPet.noticeLine(m, "2", "1", "Alex", "Alex"))
        // A sweep notice: no actor.
        val asleep = json.decodeFromString<Message>(
            """{"id":"901","channelId":"100","createdAt":"2026-11-11T10:00:00Z","authorId":"1","type":"system_pet",
               "content":"Biscuit fell asleep.","metadata":{"kind":"pet","event":"asleep","petName":"Biscuit","stage":"kid","actorId":null}}""",
        )
        assertNull(asleep.metadata?.actorId)
        assertEquals("Biscuit fell asleep. 😴 Say hi to each other within 2 days to wake it up.", ZekkPet.noticeLine(asleep, "2", "1", "Alex", "Alex"))
    }

    @Test fun readyFeatureFlag() {
        assertTrue(json.decodeFromString<ReadyFeatures>("""{"presence_activity":true,"zekk_pet":true}""").zekkPet)
        assertFalse(json.decodeFromString<ReadyFeatures>("""{"presence_activity":true}""").zekkPet)
        assertFalse(json.decodeFromString<ReadyFeatures>("{}").zekkPet)
    }
}
