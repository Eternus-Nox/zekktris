package com.zekktris.data

import com.zekktris.data.ZekkPet.BannerKind
import com.zekktris.data.ZekkPet.Mood
import com.zekktris.data.ZekkPet.Stage
import com.zekktris.data.ZekkPet.Task
import com.zekktris.data.model.DmPetState
import com.zekktris.data.model.Message
import com.zekktris.data.model.MessageMetadata
import com.zekktris.data.model.PetDTO
import com.zekktris.data.model.PetTask
import com.zekktris.data.model.PetTaskCount
import com.zekktris.data.model.PetTaskProgress
import com.zekktris.data.model.PublicUser
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** Zekk Pet rules and view model (ZekkPet.kt): the numbers and words every
 *  platform shares (packages/shared/src/pets.ts), the pet card, the adopt
 *  bar, the in-chat notice and the gateway payload. Mirrors the web suite
 *  (apps/web/test/zekkPet.test.ts). */
class ZekkPetTest {
    private val json = Json { ignoreUnknownKeys = true; explicitNulls = false; coerceInputValues = true; isLenient = true }

    private fun pet(
        status: String = "active",
        invitedBy: String? = null,
        name: String = "Zekk",
        level: Int = 1,
        stage: String = "baby",
        points: Int = 40,
        levelFloor: Int = 25,
        nextLevelAt: Int = 55,
        mood: String = "happy",
        tasks: List<PetTask> = emptyList(),
        lastFedDay: String? = "2026-11-11",
        wakeBy: String? = null,
        today: String = "2026-11-11",
        dayEndsAt: String = "2026-11-12T00:00:00.000Z",
    ) = PetDTO(
        channelId = "100", status = status, invitedBy = invitedBy, name = name, level = level, stage = stage,
        points = points, levelFloor = levelFloor, nextLevelAt = nextLevelAt, mood = mood, tasks = tasks,
        fedToday = mood == "happy" || mood == "thriving", lastFedDay = lastFedDay, wakeBy = wakeBy,
        adoptedAt = "2026-11-01T12:00:00.000Z", today = today, dayEndsAt = dayEndsAt,
    )

    // ── The shared rules ────────────────────────────────────────────────────

    @Test fun constantsMatchTheSharedModule() {
        assertEquals(3, ZekkPet.MIN_STREAK)
        assertEquals(24, ZekkPet.NAME_MAX_LENGTH)
        assertEquals("Zekk", ZekkPet.DEFAULT_NAME)
        assertEquals(7, ZekkPet.INVITE_TTL_DAYS)
        assertEquals(10, ZekkPet.CHATTY_GOAL)
    }

    @Test fun tasksInDisplayOrder() {
        assertEquals(listOf("both_hi", "chatty", "voice", "photo", "poke"), Task.entries.map { it.wire })
        assertEquals(listOf(1, 2, 4, 8, 16), Task.entries.map { it.bit })
        assertEquals(listOf(10, 10, 5, 5, 5), Task.entries.map { it.points })
        assertEquals(
            listOf("Both say hi", "10 messages each", "Send a voice message", "Send a photo", "Poke each other"),
            Task.entries.map { it.label },
        )
        assertEquals(31, ZekkPet.ALL_TASKS_MASK)
        assertEquals(35, Task.entries.sumOf { it.points }) // max a day
    }

    @Test fun stagesAndTheirFirstLevels() {
        assertEquals(listOf("egg", "baby", "kid", "teen", "adult", "legendary"), Stage.entries.map { it.wire })
        assertEquals(listOf(0, 1, 5, 10, 15, 25), Stage.entries.map { it.minLevel })
        assertEquals(listOf("Egg", "Baby", "Kid", "Teen", "Adult", "Legendary"), Stage.entries.map { it.label })
        assertEquals(Stage.Kid, Stage.of("kid"))
        assertEquals(Stage.Egg, Stage.of("mythic"))
        assertEquals(Stage.Egg, Stage.of(null))
        assertEquals("Kid", ZekkPet.stageLabel("kid"))
        assertEquals("Egg", ZekkPet.stageLabel("mythic"))
    }

    @Test fun moodWordsAndLines() {
        val expected = mapOf(
            "thriving" to ("Thriving" to "Every task done today. It's glowing!"),
            "happy" to ("Happy" to "Fed for today. Keep chatting to earn more points."),
            "lonely" to ("Lonely" to "Only one of you has said hi today."),
            "hungry" to ("Hungry" to "Say hi to each other to feed it."),
            "grumpy" to ("Grumpy" to "Your streak ends at midnight UTC. Say hi to each other!"),
            "asleep" to ("Asleep" to "Your streak broke. Both say hi by {day} to wake it up, or it runs away."),
        )
        assertEquals(expected.keys.toList(), Mood.entries.map { it.wire })
        Mood.entries.forEach { assertEquals(it.wire, expected[it.wire], it.label to it.line) }
        assertEquals(Mood.Happy, Mood.of("ecstatic"))
        assertEquals(Mood.Happy, Mood.of(null))
    }

    @Test fun levelCurve() {
        assertEquals(25, ZekkPet.pointsForNextLevel(0))
        assertEquals(30, ZekkPet.pointsForNextLevel(1))
        assertEquals(45, ZekkPet.pointsForNextLevel(4))
        // T(L) = 25·L + 5·L·(L−1)/2.
        mapOf(0 to 0, 1 to 25, 2 to 55, 5 to 175, 10 to 475, 15 to 900, 25 to 2125).forEach { (l, t) ->
            assertEquals("T($l)", t, ZekkPet.levelFloor(l))
        }
        assertEquals(0, ZekkPet.levelFloor(-3))
        for (l in 0..40) assertEquals(ZekkPet.pointsForNextLevel(l), ZekkPet.levelFloor(l + 1) - ZekkPet.levelFloor(l))
        mapOf(0 to 0, 24 to 0, 25 to 1, 54 to 1, 55 to 2, 174 to 4, 175 to 5, 474 to 9, 475 to 10, 899 to 14, 900 to 15, 2124 to 24, 2125 to 25, -5 to 0)
            .forEach { (pts, l) -> assertEquals("$pts points", l, ZekkPet.levelForPoints(pts)) }
    }

    @Test fun stageByLevel() {
        mapOf(
            -1 to Stage.Egg, 0 to Stage.Egg, 1 to Stage.Baby, 4 to Stage.Baby, 5 to Stage.Kid, 9 to Stage.Kid,
            10 to Stage.Teen, 14 to Stage.Teen, 15 to Stage.Adult, 24 to Stage.Adult, 25 to Stage.Legendary, 99 to Stage.Legendary,
        ).forEach { (l, s) -> assertEquals("level $l", s, ZekkPet.stageForLevel(l)) }
    }

    @Test fun namesNormaliseLikeTheServer() {
        assertEquals("Zekk", ZekkPet.normalizeName("  Zekk  "))
        assertEquals("Mr Fluffy Pants", ZekkPet.normalizeName("Mr   Fluffy\tPants"))
        assertEquals("a b", ZekkPet.normalizeName("a\nb"))
        // JavaScript's \s takes NBSP, the Unicode spaces and the BOM.
        assertEquals("a b", ZekkPet.normalizeName("a  b"))
        assertEquals("a b", ZekkPet.normalizeName("a b"))
        assertEquals("Zekk", ZekkPet.normalizeName("﻿Zekk　"))
        assertNull(ZekkPet.normalizeName(""))
        assertNull(ZekkPet.normalizeName("   \t "))
        // 1–24, counted in code points.
        assertEquals("x".repeat(24), ZekkPet.normalizeName("x".repeat(24)))
        assertNull(ZekkPet.normalizeName("x".repeat(25)))
        assertEquals("🐣".repeat(24), ZekkPet.normalizeName("🐣".repeat(24)))
        assertNull(ZekkPet.normalizeName("🐣".repeat(25)))
        // Control characters, including the C1 range and ones Java calls
        // whitespace (U+001F, U+0085) that the server's \s doesn't collapse.
        listOf("a\u0007b", "a\u0000", "\u001Fname", "a\u0085b", "a\u007Fb", "a\u009Fb").forEach {
            assertNull(it, ZekkPet.normalizeName(it))
        }
    }

    @Test fun namesDropInvisibleAndBidiCharactersLikeTheServer() {
        // apps/api/test/zekk-pet.integration.test.ts: nothing visible is no name …
        listOf("​", "⁠﻿", "‮", "‍ ‌", "⁦⁩", "‍", "‌‍").forEach {
            assertNull(it, ZekkPet.normalizeName(it))
        }
        // … and the marks go wherever they are.
        assertEquals("abc", ZekkPet.normalizeName("‮abc"))
        assertEquals("Mochi", ZekkPet.normalizeName("Mo​chi"))
        assertEquals("Pip", ZekkPet.normalizeName("⁦Pip⁩ ‎"))
        assertEquals("kkeZ", ZekkPet.normalizeName("‮kkeZ"))
        assertEquals("Zekk", ZekkPet.normalizeName("Zekk‎"))
        // The BOM is dropped, not turned into a space.
        assertEquals("ab", ZekkPet.normalizeName("a﻿b"))
        assertEquals("Zekk", ZekkPet.normalizeName("Ze﻿kk"))
        // A mark an RTL keyboard adds doesn't count towards the 24.
        assertEquals("x".repeat(24), ZekkPet.normalizeName("x".repeat(24) + "‏"))
        assertEquals("x".repeat(24), ZekkPet.normalizeName("‎" + "x".repeat(24)))
        assertEquals("x".repeat(23), ZekkPet.normalizeName("‪" + "x".repeat(23) + "‬"))
        // ZWJ and ZWNJ stay inside a name: they join emoji and shape scripts.
        assertEquals("a‍b", ZekkPet.normalizeName("a‍b"))
        assertEquals("🐣‍🔥", ZekkPet.normalizeName("🐣‍🔥"))
        assertEquals("👩‍💻", ZekkPet.normalizeName("👩‍💻"))
    }

    // ── The pet card ────────────────────────────────────────────────────────

    @Test fun weekdaysAreUtcDays() {
        assertEquals("Friday", ZekkPet.utcWeekday("2026-11-13"))
        assertEquals("Wednesday", ZekkPet.utcWeekday("2026-11-11"))
        assertNull(ZekkPet.utcWeekday(null))
        assertNull(ZekkPet.utcWeekday("13/11/2026"))
        assertNull(ZekkPet.utcWeekday("2026-13-01"))
    }

    @Test fun moodChip() {
        val happy = ZekkPet.moodView(pet())
        assertEquals(Mood.Happy, happy.mood)
        assertEquals("Happy", happy.label)
        assertEquals("Fed for today. Keep chatting to earn more points.", happy.line)
        // Asleep names the weekday of wakeBy …
        val asleep = ZekkPet.moodView(pet(status = "asleep", mood = "asleep", lastFedDay = "2026-11-10", wakeBy = "2026-11-13"))
        assertEquals("Asleep", asleep.label)
        assertEquals("Your streak broke. Both say hi by Friday to wake it up, or it runs away.", asleep.line)
        // … or of the last fed day + 3 when the server left it out …
        assertEquals(
            "Your streak broke. Both say hi by Friday to wake it up, or it runs away.",
            ZekkPet.moodView(pet(status = "asleep", mood = "asleep", lastFedDay = "2026-11-10", wakeBy = null)).line,
        )
        // … and never shows the raw slot.
        assertEquals(
            "Your streak broke. Both say hi by tomorrow to wake it up, or it runs away.",
            ZekkPet.moodView(pet(status = "asleep", mood = "asleep", lastFedDay = null, wakeBy = null)).line,
        )
        assertEquals(Mood.Happy, ZekkPet.moodView(pet(mood = "ecstatic")).mood)
        assertEquals("Grumpy", ZekkPet.moodView(pet(mood = "grumpy")).label)
    }

    @Test fun careChecklist() {
        val tasks = listOf(
            PetTask("both_hi", done = true, points = 10),
            PetTask("chatty", done = false, points = 10, progress = PetTaskProgress(PetTaskCount("1", 4), PetTaskCount("2", 12), 10)),
            PetTask("poke", done = true, points = 5),
            PetTask("dance", done = true, points = 99), // a task this app doesn't know
        )
        val mine = ZekkPet.taskRows(pet(tasks = tasks), selfId = "1")
        assertEquals(Task.entries, mine.map { it.task })
        assertEquals(listOf(true, false, false, false, true), mine.map { it.done })
        assertEquals(listOf(10, 10, 5, 5, 5), mine.map { it.points })
        assertEquals("4/10 · 10/10", mine[1].progress) // {me} · {them}, capped at the goal
        assertEquals(listOf(null, null, null, null), mine.filterIndexed { i, _ -> i != 1 }.map { it.progress })
        assertEquals("10/10 · 4/10", ZekkPet.taskRows(pet(tasks = tasks), selfId = "2")[1].progress)
        // A viewer who is neither (shouldn't happen) still reads both counts.
        assertEquals("0/10 · 4/10", ZekkPet.taskRows(pet(tasks = tasks), selfId = "9")[1].progress)
        // An invited pet lists no tasks: all five, none done.
        val none = ZekkPet.taskRows(pet(status = "invited", tasks = emptyList()), selfId = "1")
        assertEquals(5, none.size)
        assertTrue(none.none { it.done })
        assertEquals(listOf("Both say hi", "10 messages each", "Send a voice message", "Send a photo", "Poke each other"), none.map { it.label })
    }

    @Test fun levelBar() {
        val p = ZekkPet.levelProgress(pet(level = 1, points = 40, levelFloor = 25, nextLevelAt = 55))
        assertEquals(15, p.have)
        assertEquals(30, p.need)
        assertEquals(0.5f, p.fraction, 1e-6f)
        assertEquals("15/30 to level 2", p.label)
        val egg = ZekkPet.levelProgress(pet(level = 0, stage = "egg", points = 21, levelFloor = 0, nextLevelAt = 25))
        assertEquals("21/25 to level 1", egg.label)
        assertEquals(0.84f, egg.fraction, 1e-6f)
        // Clamped both ways; a DTO without the numbers reads empty.
        assertEquals(30, ZekkPet.levelProgress(pet(points = 99, levelFloor = 25, nextLevelAt = 55)).have)
        assertEquals(0, ZekkPet.levelProgress(pet(points = 3, levelFloor = 25, nextLevelAt = 55)).have)
        assertEquals(0f, ZekkPet.levelProgress(pet(points = 0, levelFloor = 0, nextLevelAt = 0)).fraction, 0f)
        assertEquals("Level 3 · Baby", ZekkPet.levelLine(pet(level = 3, stage = "baby")))
        assertEquals("Level 25 · Legendary", ZekkPet.levelLine(pet(level = 25, stage = "legendary")))
    }

    @Test fun stagePathMarksTheCurrentStage() {
        val path = ZekkPet.stagePath("kid")
        assertEquals(listOf("Egg", "Baby", "Kid", "Teen", "Adult", "Legendary"), path.map { it.label })
        assertEquals(listOf(false, false, true, false, false, false), path.map { it.current })
        assertEquals(listOf(true, true, true, false, false, false), path.map { it.reached })
        assertEquals(Stage.Egg, ZekkPet.stagePath("mythic").single { it.current }.stage)
    }

    @Test fun anOpenInviteIsDrawnAsAnEgg() {
        assertEquals(Stage.Egg, ZekkPet.displayStage(pet(status = "invited", stage = "baby")))
        assertEquals(Stage.Kid, ZekkPet.displayStage(pet(stage = "kid")))
        assertEquals("Zekk Pet: Zekk (invite pending)", ZekkPet.headerLabel(pet(status = "invited")))
        assertEquals("Zekk Pet: Biscuit, Asleep", ZekkPet.headerLabel(pet(name = "Biscuit", status = "asleep", mood = "asleep")))
        // The name as the viewer sees it (masked for a supervised child).
        assertEquals("Zekk Pet: S••• Lord, Happy", ZekkPet.headerLabel(pet(name = "Shit Lord"), name = "S••• Lord"))
        assertEquals("Zekk Pet: S••• Lord (invite pending)", ZekkPet.headerLabel(pet(name = "Shit Lord", status = "invited"), name = "S••• Lord"))
    }

    @Test fun headerChipsShowWholeOrNotAtAll() {
        // dp on a 360dp phone, non-E2EE DM: 104 for the name and its chips;
        // each chip with its 6dp gap: 2-digit streak 41, "1d" timer 42, pet 36.
        fun fit(room: Int, name: Int = 90, streak: Int = 41, timer: Int = 42, pet: Int = 36) =
            ZekkPet.fitHeaderChips(room, name, streak, timer, pet, nameRoom = 56)
        // Next to the pet the timer gives way, and the pet keeps its full size
        // (a Row squeezed it to 15dp and the name to nothing).
        assertEquals(ZekkPet.HeaderChips(streak = true, timer = false, pet = true), fit(104))
        // A wide phone has room for all three.
        assertEquals(ZekkPet.HeaderChips(streak = true, timer = true, pet = true), fit(180))
        // A short name that still fits whole keeps the timer.
        assertEquals(ZekkPet.HeaderChips(streak = true, timer = true, pet = true), fit(156, name = 30))
        assertEquals(ZekkPet.HeaderChips(streak = true, timer = false, pet = true), fit(156))
        // Without a pet the timer stays, as before.
        assertEquals(ZekkPet.HeaderChips(streak = true, timer = true, pet = false), fit(104, pet = 0))
        // Chips that aren't there never show.
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = false, pet = true), fit(104, streak = 0, timer = 0))
        // A chip that can't fit whole is left out, never squeezed; the pet,
        // the only way into its card, keeps its place before the streak.
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = false, pet = true), fit(60))
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = false, pet = false), fit(30))
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = false, pet = true), fit(40, streak = 0))
        // 360dp with a 2-character clan tag (76dp left), 320dp with no tag
        // (64dp), a 1-character tag and a 100+ day streak (82dp, a 47dp pill):
        // the streak gives way, the pet stays.
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = false, pet = true), fit(76))
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = false, pet = true), fit(64))
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = false, pet = true), fit(82, streak = 47))
        // Both show whenever both fit.
        assertEquals(ZekkPet.HeaderChips(streak = true, timer = false, pet = true), fit(77))
        // With the streak gone the timer still needs the name's room.
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = false, pet = true), fit(76, timer = 30))
        assertEquals(ZekkPet.HeaderChips(streak = false, timer = true, pet = true), fit(76, name = 10, timer = 30))
    }

    // ── The adopt bar ───────────────────────────────────────────────────────

    @Test fun adoptBar() {
        assertNull(ZekkPet.banner(null, "1", "Sam"))
        assertNull(ZekkPet.banner(DmPetState(eligible = true, streak = 5), null, "Sam"))
        assertNull(ZekkPet.banner(DmPetState(pet = null, eligible = false, streak = 2), "1", "Sam"))
        val adopt = ZekkPet.banner(DmPetState(pet = null, eligible = true, streak = 5), "1", "Sam")
        assertEquals(BannerKind.Adopt, adopt?.kind)
        assertEquals("🥚 5-day streak! Adopt a Zekk Pet with Sam.", adopt?.text)
        val waiting = ZekkPet.banner(DmPetState(pet = pet(status = "invited", invitedBy = "1")), "1", "Sam")
        assertEquals(BannerKind.Waiting, waiting?.kind)
        assertEquals("Waiting for Sam to accept your Zekk Pet.", waiting?.text)
        val invited = ZekkPet.banner(DmPetState(pet = pet(status = "invited", invitedBy = "2"), streak = 3), "1", "Sam")
        assertEquals(BannerKind.Invited, invited?.kind)
        assertEquals("Sam wants to raise a Zekk Pet with you.", invited?.text)
        assertFalse(invited!!.locked)
        // A pet that's hatched (or asleep) has no bar.
        assertNull(ZekkPet.banner(DmPetState(pet = pet()), "1", "Sam"))
        assertNull(ZekkPet.banner(DmPetState(pet = pet(status = "asleep", mood = "asleep")), "1", "Sam"))
    }

    @Test fun acceptLocksOnceTheStreakIsUnderTheMinimum() {
        // Sam invited on a 4-day streak, then a day was missed: the invite
        // stays up to 7 days, but the server refuses to accept it on a broken
        // streak (409), so Accept goes and the bar says why.
        val invite = pet(status = "invited", invitedBy = "2", level = 0, stage = "egg")
        val broken = DmPetState(pet = invite, eligible = false, streak = 0, minStreak = 3)
        assertEquals(
            ZekkPet.Banner(BannerKind.Invited, "Sam wants to raise a Zekk Pet with you. Keep a 3-day streak going to accept.", locked = true),
            ZekkPet.banner(broken, "1", "Sam"),
        )
        assertEquals(
            ZekkPet.Banner(BannerKind.Invited, "Sam wants to raise a Zekk Pet with you. Keep a 3-day streak going to accept.", locked = true),
            ZekkPet.banner(broken.copy(streak = 2), "1", "Sam"),
        )
        // Back to the minimum (or past it): Accept again, the original words.
        assertEquals(ZekkPet.Banner(BannerKind.Invited, "Sam wants to raise a Zekk Pet with you."), ZekkPet.banner(broken.copy(streak = 3), "1", "Sam"))
        assertEquals(ZekkPet.Banner(BannerKind.Invited, "Sam wants to raise a Zekk Pet with you."), ZekkPet.banner(broken.copy(streak = 9), "1", "Sam"))
        // Our own waiting invite keeps its Cancel whatever the streak.
        assertEquals(
            ZekkPet.Banner(BannerKind.Waiting, "Waiting for Sam to accept your Zekk Pet."),
            ZekkPet.banner(broken.copy(pet = invite.copy(invitedBy = "1")), "1", "Sam"),
        )
    }

    @Test fun theBarsThatHangOnALiveStreakRefetchAtMidnight() {
        val invite = pet(status = "invited", invitedBy = "2", level = 0, stage = "egg")
        fun needs(s: DmPetState) = ZekkPet.bannerNeedsStreak(ZekkPet.banner(s, "1", "Sam"))
        assertTrue(needs(DmPetState(pet = null, eligible = true, streak = 5)))
        assertTrue(needs(DmPetState(pet = invite, streak = 3)))
        // Locked already, our own invite, a hatched pet or no bar: nothing to lapse.
        assertFalse(needs(DmPetState(pet = invite, streak = 0)))
        assertFalse(needs(DmPetState(pet = invite.copy(invitedBy = "1"), streak = 3)))
        assertFalse(needs(DmPetState(pet = pet(), streak = 3)))
        assertFalse(needs(DmPetState(pet = null, eligible = false, streak = 2)))
        assertFalse(ZekkPet.bannerNeedsStreak(null))
    }

    // ── The store's merge (AppStore.setDmPet / loadDmPet) ───────────────────

    @Test fun anEventLeavesAnEntryEvenForNoPet() {
        // Not fetched yet: no bar, and an invite takes the minimum streak.
        assertEquals(DmPetState(pet = null, eligible = false, streak = 0, minStreak = 3), ZekkPet.withPet(null, null))
        val invite = pet(status = "invited", invitedBy = "2", level = 0, stage = "egg")
        assertEquals(DmPetState(pet = invite, eligible = false, streak = 3, minStreak = 3), ZekkPet.withPet(null, invite))
        // Fetched already: only the pet changes.
        val fetched = DmPetState(pet = null, eligible = true, streak = 6, minStreak = 3)
        assertEquals(fetched.copy(pet = invite), ZekkPet.withPet(fetched, invite))
        assertEquals(fetched, ZekkPet.withPet(fetched.copy(pet = invite), null))
    }

    @Test fun anInviteCancelledBeforeTheFirstFetchAnswersStaysGone() {
        // Alice opens the DM (no entry yet) and GET /pet leaves; Sam cancels
        // his invite and DM_PET_UPDATE null lands before the answer, which
        // still saw the invite (so the server said "not eligible").
        val invite = pet(status = "invited", invitedBy = "2", level = 0, stage = "egg")
        val answer = DmPetState(pet = invite, eligible = false, streak = 5, minStreak = 3, canAct = true)
        val afterEvent = ZekkPet.withPet(null, null)
        val next = ZekkPet.afterFetch(afterEvent, answer, keepPet = true)
        assertNull(next.pet)
        assertEquals(answer.canAct && answer.streak >= answer.minStreak, next.eligible)
        assertEquals(5, next.streak)
        assertEquals(BannerKind.Adopt, ZekkPet.banner(next, "1", "Sam")?.kind)
        // Without an entry at all, the newer "no pet" still wins.
        assertEquals(next, ZekkPet.afterFetch(null, answer, keepPet = true))
        // Under the minimum, or a DM we can't act in: no Adopt.
        assertFalse(ZekkPet.afterFetch(afterEvent, answer.copy(streak = 2), keepPet = true).eligible)
        assertFalse(ZekkPet.afterFetch(afterEvent, answer.copy(canAct = false), keepPet = true).eligible)
    }

    @Test fun aFetchKeepsANewerPetAndTakesTheRest() {
        val invite = pet(status = "invited", invitedBy = "2", level = 0, stage = "egg")
        val hatched = pet()
        val answer = DmPetState(pet = invite, eligible = false, streak = 4, minStreak = 3)
        // Nothing came in meanwhile: the answer as it is.
        assertEquals(answer, ZekkPet.afterFetch(DmPetState(pet = hatched), answer, keepPet = false))
        assertEquals(answer, ZekkPet.afterFetch(null, answer, keepPet = false))
        // Accepted meanwhile: the newer pet stays, the answer's streak goes in.
        assertEquals(answer.copy(pet = hatched), ZekkPet.afterFetch(DmPetState(pet = hatched), answer, keepPet = true))
        // The answer saw no pet either: the server's eligibility stands.
        val none = DmPetState(pet = null, eligible = true, streak = 4, minStreak = 3)
        assertEquals(none, ZekkPet.afterFetch(ZekkPet.withPet(null, null), none, keepPet = true))
        // An invite came in meanwhile over an answer with no pet: the invite
        // stays and its bar shows (eligibility only matters with no pet).
        val kept = ZekkPet.afterFetch(ZekkPet.withPet(null, invite), none, keepPet = true)
        assertEquals(invite, kept.pet)
        assertEquals(BannerKind.Invited, ZekkPet.banner(kept, "1", "Sam")?.kind)
    }

    @Test fun dismissalIsPerDmAndPerKind() {
        assertEquals("100:Adopt", ZekkPet.bannerKey("100", BannerKind.Adopt))
        assertNotEquals(ZekkPet.bannerKey("100", BannerKind.Adopt), ZekkPet.bannerKey("100", BannerKind.Invited))
        assertNotEquals(ZekkPet.bannerKey("100", BannerKind.Adopt), ZekkPet.bannerKey("101", BannerKind.Adopt))
    }

    @Test fun failureWords() {
        assertEquals("Couldn't send the invite.", ZekkPet.failedMessage(ZekkPet.Change.Invite))
        assertEquals("Couldn't adopt the pet.", ZekkPet.failedMessage(ZekkPet.Change.Accept))
        assertEquals("Couldn't answer the invite.", ZekkPet.failedMessage(ZekkPet.Change.Decline))
        assertEquals("Couldn't rename the pet.", ZekkPet.failedMessage(ZekkPet.Change.Rename("Biscuit")))
    }

    // ── The in-chat notice ──────────────────────────────────────────────────

    private fun text(event: String, self: Boolean, actor: String? = "Sam", stage: Stage = Stage.Baby) =
        ZekkPet.noticeText(event, "Zekk", stage, actorIsSelf = self, actorName = if (self) null else actor, peerName = "Sam")

    @Test fun noticeWordsWithYouForTheViewer() {
        assertEquals("You want to raise a Zekk Pet together. 🥚", text("invited", self = true))
        assertEquals("Sam wants to raise a Zekk Pet together. 🥚", text("invited", self = false))
        assertNull(text("invited", self = false, actor = null))
        assertEquals("You and Sam adopted a Zekk Pet! 🥚", text("adopted", self = true))
        assertEquals("You and Sam adopted a Zekk Pet! 🥚", text("adopted", self = false))
        assertEquals("Zekk hatched! 🐣", text("hatched", self = false))
        assertEquals("Zekk grew into a Kid!", text("evolved", self = false, stage = Stage.Kid))
        assertEquals("Zekk grew into a Teen!", text("evolved", self = false, stage = Stage.Teen))
        assertEquals("Zekk grew into an Adult!", text("evolved", self = false, stage = Stage.Adult))
        assertEquals("Zekk grew into a Legendary!", text("evolved", self = false, stage = Stage.Legendary))
        assertEquals("Zekk fell asleep. 😴 Say hi to each other within 2 days to wake it up.", text("asleep", self = false, actor = null))
        assertEquals("Zekk woke up! 🎉", text("awake", self = true))
        assertEquals("Zekk ran away. Keep a 3-day streak to adopt a new one.", text("ran_away", self = false, actor = null))
        assertEquals("You renamed the pet to Zekk.", text("renamed", self = true))
        assertEquals("Sam renamed the pet to Zekk.", text("renamed", self = false))
        assertNull(text("renamed", self = false, actor = null))
        assertNull(text("danced", self = true))
    }

    private fun notice(
        event: String?,
        actorId: String?,
        authorId: String? = "2",
        petName: String? = "Biscuit",
        stage: String? = "kid",
        content: String = "Fallback text.",
        kind: String? = "pet",
    ) = Message(
        id = "900", channelId = "100", createdAt = "2026-11-11T10:00:00Z", authorId = authorId,
        author = authorId?.let { PublicUser(id = it, username = "author$it") },
        type = "system_pet", content = content,
        metadata = MessageMetadata(kind = kind, event = event, petName = petName, stage = stage, actorId = actorId),
    )

    @Test fun noticeLineFromMetadata() {
        // Peer "2" (nicknamed "Sammy"), viewer "1".
        fun line(m: Message) = ZekkPet.noticeLine(m, selfId = "1", peerId = "2", peerName = "Sammy", authorName = "Sam")
        assertEquals("You renamed the pet to Biscuit.", line(notice("renamed", actorId = "1", authorId = "1")))
        assertEquals("Sammy renamed the pet to Biscuit.", line(notice("renamed", actorId = "2")))
        assertEquals("You and Sammy adopted a Zekk Pet! 🥚", line(notice("adopted", actorId = "2")))
        assertEquals("You and Sammy adopted a Zekk Pet! 🥚", line(notice("adopted", actorId = "1", authorId = "1")))
        assertEquals("Biscuit grew into a Kid!", line(notice("evolved", actorId = "2")))
        // Sweep events: no actor, authored by user A.
        assertEquals(
            "Biscuit fell asleep. 😴 Say hi to each other within 2 days to wake it up.",
            line(notice("asleep", actorId = null)),
        )
        // An actor who is the row's author but not the peer reads by the
        // author's name; anyone else is "Someone".
        assertEquals(
            "Sam wants to raise a Zekk Pet together. 🥚",
            ZekkPet.noticeLine(notice("invited", actorId = "3", authorId = "3"), "1", "2", "Sammy", "Sam"),
        )
        assertEquals("Someone renamed the pet to Biscuit.", line(notice("renamed", actorId = "4")))
        // Unknown event, missing metadata or pet name: the server's fallback.
        assertEquals("Fallback text.", line(notice("danced", actorId = "2")))
        assertEquals("Fallback text.", line(notice("renamed", actorId = "2", petName = null)))
        assertEquals("Fallback text.", line(notice(null, actorId = null, kind = null)))
    }

    @Test fun noticeLineMasksThePetsNameForASupervisedChild() {
        // The other person picks the name, so the viewer's profanity mask
        // (ProfanityFilter.mask in the app) goes over it and over the
        // fallback content, as over message bodies; people's names are left.
        val mask: (String) -> String = { it.replace("Shit", "S•••") }
        fun line(m: Message, mask: (String) -> String = { it }) =
            ZekkPet.noticeLine(m, selfId = "1", peerId = "2", peerName = "Sammy", authorName = "Sam", mask = mask)
        val renamed = notice("renamed", actorId = "2", petName = "Shit Lord")
        assertEquals("Sammy renamed the pet to S••• Lord.", line(renamed, mask))
        assertEquals("Sammy renamed the pet to Shit Lord.", line(renamed))
        assertEquals("S••• Lord woke up! 🎉", line(notice("awake", actorId = "2", petName = "Shit Lord"), mask))
        val fallback = "Sam renamed the pet to Shit Lord."
        assertEquals("Sam renamed the pet to S••• Lord.", line(notice("danced", actorId = "2", content = fallback), mask))
        assertEquals("Sam renamed the pet to S••• Lord.", line(notice("renamed", actorId = "2", petName = null, content = fallback), mask))
        assertEquals("Sam renamed the pet to S••• Lord.", line(notice(null, actorId = null, kind = null, content = fallback), mask))
        assertEquals(fallback, line(notice("danced", actorId = "2", content = fallback)))
    }

    @Test fun noticeRows() {
        assertTrue(ZekkPet.isNotice(notice("hatched", actorId = "1")))
        assertTrue(ZekkPet.isNotice(notice("hatched", actorId = "1").copy(type = "default")))
        assertTrue(ZekkPet.isNotice(notice("hatched", actorId = "1", kind = null)))
        assertFalse(ZekkPet.isNotice(notice("hatched", actorId = "1", kind = "poke").copy(type = "default")))
        assertFalse(ZekkPet.isNotice(Message(id = "1", channelId = "100", createdAt = "2026-11-11T10:00:00Z", type = "system_disappearing")))
    }

    @Test fun aNoticeTheViewerDidNotCauseIsNotTheirs() {
        // The sweep's notices are posted in user A's ("1") name but caused by
        // no one: for A they are not their own message (no read-marker move).
        assertTrue(ZekkPet.isNoticeNotBy(notice("asleep", actorId = null, authorId = "1"), "1"))
        assertTrue(ZekkPet.isNoticeNotBy(notice("ran_away", actorId = null, authorId = "1"), "1"))
        assertTrue(ZekkPet.isNoticeNotBy(notice("hatched", actorId = "2"), "1"))
        assertTrue(ZekkPet.isNoticeNotBy(notice("asleep", actorId = null, kind = null, authorId = "1"), "1"))
        // One the viewer caused is theirs, as is anything that isn't a notice.
        assertFalse(ZekkPet.isNoticeNotBy(notice("renamed", actorId = "1", authorId = "1"), "1"))
        assertFalse(ZekkPet.isNoticeNotBy(Message(id = "1", channelId = "100", createdAt = "2026-11-11T10:00:00Z", authorId = "1"), "1"))
    }

    @Test fun aNoticeBelongsToItsActorForTheFollow() {
        // The sweep's notices are user A's ("1") as author but no one's: they
        // don't pull A down from history like their own send would.
        assertNull(ZekkPet.ownerId(notice("asleep", actorId = null, authorId = "1")))
        assertNull(ZekkPet.ownerId(notice("ran_away", actorId = null, authorId = "1")))
        assertNull(ZekkPet.ownerId(notice("asleep", actorId = null, kind = null, authorId = "1")))
        // One somebody caused is theirs, whoever posted it.
        assertEquals("1", ZekkPet.ownerId(notice("renamed", actorId = "1", authorId = "1")))
        assertEquals("2", ZekkPet.ownerId(notice("hatched", actorId = "2", authorId = "1")))
        // Anything else is its author's.
        val msg = Message(id = "1", channelId = "100", createdAt = "2026-11-11T10:00:00Z", authorId = "1")
        assertEquals("1", ZekkPet.ownerId(msg))
        assertEquals("2", ZekkPet.ownerId(msg.copy(authorId = null, author = PublicUser(id = "2", username = "b"))))
        assertNull(ZekkPet.ownerId(msg.copy(authorId = null)))
    }

    @Test fun noticeGlyph() {
        assertEquals(Stage.Kid to Mood.Asleep, ZekkPet.noticeArt(notice("asleep", actorId = null)))
        assertEquals(Stage.Kid to Mood.Lonely, ZekkPet.noticeArt(notice("ran_away", actorId = null)))
        assertEquals(Stage.Baby to Mood.Happy, ZekkPet.noticeArt(notice("hatched", actorId = "1", stage = "baby")))
        assertEquals(Stage.Egg to Mood.Happy, ZekkPet.noticeArt(notice("adopted", actorId = "1", stage = "mythic")))
        assertEquals(Stage.Egg to Mood.Happy, ZekkPet.noticeArt(notice(null, actorId = null, kind = null)))
    }

    // ── Refresh and the gateway ─────────────────────────────────────────────

    private fun at(iso: String) = java.time.Instant.parse(iso).toEpochMilli()

    @Test fun refetchAtTheClockBoundaries() {
        val p = pet(today = "2026-11-11", dayEndsAt = "2026-11-12T00:00:00.000Z")
        assertEquals(at("2026-11-11T18:00:00Z") + 5_000, ZekkPet.nextRefreshAt(p, at("2026-11-11T10:00:00Z")))
        // A boundary stands until its slack is over, so a recomposition just
        // past 18:00 or midnight keeps the pending refetch instead of
        // skipping to the next boundary (or to none).
        assertEquals(at("2026-11-11T18:00:00Z") + 5_000, ZekkPet.nextRefreshAt(p, at("2026-11-11T18:00:00Z")))
        assertEquals(at("2026-11-11T18:00:00Z") + 5_000, ZekkPet.nextRefreshAt(p, at("2026-11-11T18:00:04Z")))
        assertEquals(at("2026-11-12T00:00:00Z") + 5_000, ZekkPet.nextRefreshAt(p, at("2026-11-11T18:00:05Z")))
        assertEquals(at("2026-11-12T00:00:00Z") + 5_000, ZekkPet.nextRefreshAt(p, at("2026-11-11T19:30:00Z")))
        assertEquals(at("2026-11-12T00:00:00Z") + 5_000, ZekkPet.nextRefreshAt(p, at("2026-11-12T00:00:01Z")))
        assertNull(ZekkPet.nextRefreshAt(p, at("2026-11-12T00:00:05Z")))
        assertNull(ZekkPet.nextRefreshAt(pet(today = "", dayEndsAt = ""), at("2026-11-11T10:00:00Z")))
    }

    @Test fun refetchAtMidnightWhileTheBarNeedsAStreak() {
        assertEquals(at("2026-11-12T00:00:05Z"), ZekkPet.nextUtcMidnightRefreshAt(at("2026-11-11T09:00:00Z")))
        assertEquals(at("2026-11-12T00:00:05Z"), ZekkPet.nextUtcMidnightRefreshAt(at("2026-11-11T23:59:59Z")))
        // A recomposition inside the slack keeps the pending refetch…
        assertEquals(at("2026-11-12T00:00:05Z"), ZekkPet.nextUtcMidnightRefreshAt(at("2026-11-12T00:00:02Z")))
        // …and once it has fired the next midnight takes over (no refetch loop).
        assertEquals(at("2026-11-13T00:00:05Z"), ZekkPet.nextUtcMidnightRefreshAt(at("2026-11-12T00:00:05Z")))
        // Month and year ends roll over.
        assertEquals(at("2027-01-01T00:00:05Z"), ZekkPet.nextUtcMidnightRefreshAt(at("2026-12-31T12:00:00Z")))
    }

    private val petJson = """{"channelId":"100","status":"active","invitedBy":"1","name":"Biscuit","level":5,
        "stage":"kid","points":180,"levelFloor":175,"nextLevelAt":225,"mood":"thriving","tasks":[],"fedToday":true,
        "lastFedDay":"2026-11-11","wakeBy":null,"adoptedAt":"2026-11-01T12:00:00.000Z","today":"2026-11-11",
        "dayEndsAt":"2026-11-12T00:00:00.000Z"}"""

    @Test fun petUpdatePayload() {
        val u = ZekkPet.parseUpdate(json.parseToJsonElement("""{"channelId":"100","pet":$petJson}"""), json)
        assertEquals("100", u?.channelId)
        assertEquals("Biscuit", u?.pet?.name)
        assertEquals(5, u?.pet?.level)
        // null / absent = gone.
        val gone = ZekkPet.parseUpdate(json.parseToJsonElement("""{"channelId":"100","pet":null}"""), json)
        assertEquals("100", gone?.channelId)
        assertNull(gone?.pet)
        assertNull(ZekkPet.parseUpdate(json.parseToJsonElement("""{"channelId":"100"}"""), json)?.pet)
        assertEquals("100", ZekkPet.parseUpdate(json.parseToJsonElement("""{"channelId":"100"}"""), json)?.channelId)
        // No channel, or a pet that can't be read: skipped, never "gone".
        assertNull(ZekkPet.parseUpdate(json.parseToJsonElement("""{"pet":null}"""), json))
        assertNull(ZekkPet.parseUpdate(json.parseToJsonElement("""{"channelId":"100","pet":{"status":"active"}}"""), json))
        assertNull(ZekkPet.parseUpdate(json.parseToJsonElement("""{"channelId":"100","pet":"Biscuit"}"""), json))
        assertNull(ZekkPet.parseUpdate(JsonPrimitive(3), json))
        assertNull(ZekkPet.parseUpdate(null, json))
    }
}
