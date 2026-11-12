package com.zekktris.data

import com.zekktris.data.model.DmPetState
import com.zekktris.data.model.Message
import com.zekktris.data.model.PetDTO
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.contentOrNull

/**
 * Zekk Pet — the shared virtual pet two people raise in a 1:1 DM by keeping
 * their messaging streak going.
 *
 * The server is authoritative for points, levels, status and mood (and runs
 * the daily check that puts a pet to sleep or lets it run away); the app only
 * shows what GET /pet and DM_PET_UPDATE send. This file holds the same rules
 * and words as packages/shared/src/pets.ts, number for number and string for
 * string, so Android reads exactly like the server, web and iOS: the
 * constants, the daily tasks, the stages, the mood words and their lines, the
 * level curve and the name rule. On top of them, the view model the pet card,
 * the header, the adopt banner and the in-chat notice are built from, and the
 * DM_PET_UPDATE payload.
 *
 * Pure logic, no Android types (the drawing is [ZekkPetArt]); the JVM suite
 * (ZekkPetTest) drives it directly, as the web suite drives lib/zekkPet.ts.
 */
object ZekkPet {
    /** Streak days a 1:1 DM needs (while the streak is alive) before either
     *  person can invite the other to adopt a pet. */
    const val MIN_STREAK = 3

    /** Longest pet name, after trimming and collapsing whitespace. */
    const val NAME_MAX_LENGTH = 24

    /** Name a new pet gets until someone renames it. */
    const val DEFAULT_NAME = "Zekk"

    /** Days an unanswered invite stays open. */
    const val INVITE_TTL_DAYS = 7

    /** Messages each person must send in a UTC day for the `chatty` task. */
    const val CHATTY_GOAL = 10

    /** Stages in growth order with the first level of each. [wire] is the
     *  DTO's `stage`. */
    enum class Stage(val wire: String, val minLevel: Int, val label: String) {
        Egg("egg", 0, "Egg"),
        Baby("baby", 1, "Baby"),
        Kid("kid", 5, "Kid"),
        Teen("teen", 10, "Teen"),
        Adult("adult", 15, "Adult"),
        Legendary("legendary", 25, "Legendary"),
        ;

        companion object {
            /** A wire stage; one this app doesn't know reads as the egg. */
            fun of(wire: String?): Stage = entries.firstOrNull { it.wire == wire } ?: Egg
        }
    }

    /** The mood words (the pet's adjectives) and the line under each.
     *  Asleep's line has a `{day}` slot for the weekday of `wakeBy`. */
    enum class Mood(val wire: String, val label: String, val line: String) {
        Thriving("thriving", "Thriving", "Every task done today. It's glowing!"),
        Happy("happy", "Happy", "Fed for today. Keep chatting to earn more points."),
        Lonely("lonely", "Lonely", "Only one of you has said hi today."),
        Hungry("hungry", "Hungry", "Say hi to each other to feed it."),
        Grumpy("grumpy", "Grumpy", "Your streak ends at midnight UTC. Say hi to each other!"),
        Asleep("asleep", "Asleep", "Your streak broke. Both say hi by {day} to wake it up, or it runs away."),
        ;

        companion object {
            /** A wire mood; one this app doesn't know reads as happy. */
            fun of(wire: String?): Mood = entries.firstOrNull { it.wire == wire } ?: Happy
        }
    }

    /** Daily tasks in display order. [bit] is the task's bit in the server's
     *  `tasks_done` mask; [points] are awarded once per UTC day when it
     *  completes. */
    enum class Task(val wire: String, val bit: Int, val points: Int, val label: String) {
        BothHi("both_hi", 1, 10, "Both say hi"),
        Chatty("chatty", 2, 10, "10 messages each"),
        Voice("voice", 4, 5, "Send a voice message"),
        Photo("photo", 8, 5, "Send a photo"),
        Poke("poke", 16, 5, "Poke each other"),
    }

    /** Mask with every task's bit set (a `thriving` day). */
    val ALL_TASKS_MASK: Int = Task.entries.fold(0) { m, t -> m or t.bit }

    // ── Levels ────────────────────────────────────────────────────────────

    /** Points needed to go from [level] to [level] + 1. */
    fun pointsForNextLevel(level: Int): Int = 25 + 5 * level

    /** Total points needed to reach [level] from an egg:
     *  T(L) = 25·L + 5·L·(L−1)/2 (T(1)=25, T(5)=175, T(10)=475, T(15)=900, T(25)=2125). */
    fun levelFloor(level: Int): Int = if (level <= 0) 0 else 25 * level + 5 * level * (level - 1) / 2

    /** The level a pet with [points] total points has reached. */
    fun levelForPoints(points: Int): Int {
        var level = 0
        while (levelFloor(level + 1) <= points) level++
        return level
    }

    fun stageForLevel(level: Int): Stage = Stage.entries.lastOrNull { level >= it.minLevel } ?: Stage.Egg

    fun stageLabel(stage: String?): String = Stage.of(stage).label

    // ── Name ──────────────────────────────────────────────────────────────

    /** What JavaScript's `\s` matches (the server normalises with it): ASCII
     *  whitespace, NBSP, the Unicode space separators, the line and paragraph
     *  separators and the BOM. Spelled out, because Java's `\s` is ASCII only
     *  and its Unicode mode differs (it takes U+0085, a control character the
     *  server rejects, and leaves out the BOM). */
    private val JS_WHITESPACE_RUN = Regex("[\\t\\n\\u000B\\f\\r \\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]+")

    /** Invisible and bidi-formatting characters the server drops from a name
     *  before anything else: zero-width space, word joiner and the invisible
     *  operators, the BOM, the LRM / RLM / ALM marks and the bidi embeddings,
     *  overrides and isolates. */
    private val NAME_INVISIBLE = Regex("[\\u200B\\u2060-\\u2064\\uFEFF\\u200E\\u200F\\u061C\\u202A-\\u202E\\u2066-\\u2069]")

    /** ZWNJ and ZWJ: kept inside a name (they shape scripts and join emoji),
     *  but a name of nothing else is empty. */
    private val NAME_JOINERS = Regex("[\\u200C\\u200D]")

    /**
     * Normalise a proposed pet name exactly like the server: drop invisible
     * and bidi-formatting characters ([NAME_INVISIBLE]), collapse runs of
     * whitespace to one space and trim. Null when the result is empty or
     * nothing but ZWNJ / ZWJ, longer than [NAME_MAX_LENGTH] (counted in code
     * points), or contains a control character (U+0000–U+001F,
     * U+007F–U+009F).
     */
    fun normalizeName(raw: String): String? {
        // The strip comes first, so a BOM goes rather than becoming a space.
        // After the collapse a plain space is the only whitespace left that
        // JavaScript's trim() would strip.
        val name = raw.replace(NAME_INVISIBLE, "").replace(JS_WHITESPACE_RUN, " ").trim(' ')
        if (name.replace(NAME_JOINERS, "").trim(' ').isEmpty()) return null
        if (name.codePointCount(0, name.length) > NAME_MAX_LENGTH) return null
        if (name.any { it.code <= 0x1F || it.code in 0x7F..0x9F }) return null
        return name
    }

    // ── UTC days ──────────────────────────────────────────────────────────

    private val DAY = Regex("^\\d{4}-\\d{2}-\\d{2}$")

    private fun parseDay(day: String?): java.time.LocalDate? =
        if (day == null || !DAY.matches(day)) null else runCatching { java.time.LocalDate.parse(day) }.getOrNull()

    /** "Friday" for "2026-11-13": the weekday of a UTC day (pets live on UTC
     *  days, so the viewer's own time zone must not shift it). Null when the
     *  value isn't a YYYY-MM-DD day. */
    fun utcWeekday(day: String?): String? =
        parseDay(day)?.dayOfWeek?.getDisplayName(java.time.format.TextStyle.FULL, java.util.Locale.ENGLISH)

    /** The YYYY-MM-DD day [n] days after [day]. */
    private fun addDays(day: String, n: Long): String? = parseDay(day)?.plusDays(n)?.toString()

    // ── Mood ──────────────────────────────────────────────────────────────

    /** The mood chip: the adjective and the line under it. */
    data class MoodView(val mood: Mood, val label: String, val line: String)

    /** Asleep's line names the weekday of `wakeBy` (falling back to the last
     *  fed day + 3, the same rule, if a server left it out). */
    fun moodView(pet: PetDTO): MoodView {
        val mood = Mood.of(pet.mood)
        if (mood != Mood.Asleep) return MoodView(mood, mood.label, mood.line)
        val wakeBy = pet.wakeBy ?: pet.lastFedDay?.let { addDays(it, 3) }
        val day = utcWeekday(wakeBy) ?: "tomorrow"
        return MoodView(mood, mood.label, mood.line.replace("{day}", day))
    }

    // ── Today's care ──────────────────────────────────────────────────────

    data class TaskRow(
        val task: Task,
        val label: String,
        val points: Int,
        val done: Boolean,
        /** `chatty` only: "{me}/10 · {them}/10". */
        val progress: String?,
    )

    /** The checklist rows, in the shared display order. A task the DTO
     *  doesn't list (an invited pet has none) reads as not done; one it lists
     *  that this app doesn't know is left out. */
    fun taskRows(pet: PetDTO, selfId: String?): List<TaskRow> = Task.entries.map { t ->
        val task = pet.tasks.firstOrNull { it.key == t.wire }
        var progress: String? = null
        val pr = task?.progress
        if (t == Task.Chatty && pr != null) {
            val mine = when {
                pr.a != null && pr.a.userId == selfId -> pr.a
                pr.b != null && pr.b.userId == selfId -> pr.b
                else -> null
            }
            val theirs = if (mine === pr.a) pr.b else pr.a
            val goal = pr.goal
            progress = "${minOf(mine?.count ?: 0, goal)}/$goal · ${minOf(theirs?.count ?: 0, goal)}/$goal"
        }
        TaskRow(t, t.label, task?.points ?: t.points, task?.done == true, progress)
    }

    // ── Level ─────────────────────────────────────────────────────────────

    data class LevelProgress(
        /** Points earned since this level started. */
        val have: Int,
        /** Points this level takes. */
        val need: Int,
        /** have / need, 0–1. */
        val fraction: Float,
        /** "{have}/{need} to level {L+1}". */
        val label: String,
    )

    fun levelProgress(pet: PetDTO): LevelProgress {
        val need = maxOf(0, pet.nextLevelAt - pet.levelFloor)
        val have = minOf(maxOf(0, pet.points - pet.levelFloor), need)
        val fraction = if (need > 0) have.toFloat() / need else 0f
        return LevelProgress(have, need, fraction, "$have/$need to level ${pet.level + 1}")
    }

    /** "Level 3 · Baby". */
    fun levelLine(pet: PetDTO): String = "Level ${pet.level} · ${stageLabel(pet.stage)}"

    data class StageStep(
        val stage: Stage,
        val label: String,
        /** The pet's stage now. */
        val current: Boolean,
        /** Already grown through (or current). */
        val reached: Boolean,
    )

    /** Egg → Baby → Kid → Teen → Adult → Legendary, the current one marked. */
    fun stagePath(stage: String?): List<StageStep> {
        val at = Stage.of(stage).ordinal
        return Stage.entries.map { StageStep(it, it.label, it.ordinal == at, it.ordinal <= at) }
    }

    /** The stage to draw: an open invite is an egg whatever it says. */
    fun displayStage(pet: PetDTO): Stage = if (pet.status == "invited") Stage.Egg else Stage.of(pet.stage)

    /** Progress towards the next level, for the art (the egg cracks near the end). */
    fun artProgress(pet: PetDTO): Float = levelProgress(pet).fraction

    /** Which chips the DM header's title line shows beside the name. */
    data class HeaderChips(val streak: Boolean, val timer: Boolean, val pet: Boolean)

    /**
     * Fit the DM header's title line: the name, then the streak pill, the
     * pet and the disappearing-timer pill. Each chip's width includes its
     * leading gap (0 = not there); [room] is the line's width after the name
     * tag, in the same unit. A chip shows whole or not at all, never
     * squeezed (the pet would be drawn off-centre in a sliver), and the
     * name, which truncates, takes what they leave. The room goes to the pet
     * first, as it is the only way into the pet card, then to the streak
     * (also in the DM list), then to the timer (also on Conversation
     * settings); they are still placed in line order, and a chip is left out
     * only when it can't fit at all. Next to a pet the timer isn't on this
     * line: it's the avatar's badge there ([headerTimerCue]).
     */
    fun fitHeaderChips(room: Int, streak: Int, timer: Int, pet: Int): HeaderChips {
        var left = room
        fun take(width: Int): Boolean = (width in 1..left).also { if (it) left -= width }
        val p = take(pet)
        val s = take(streak)
        val t = take(timer)
        return HeaderChips(streak = s, timer = t, pet = p)
    }

    /** How the DM header shows a disappearing timer that's on. */
    enum class TimerCue {
        /** The pill on the title line: the stopwatch and "1d". */
        Pill,
        /** A small disc with the stopwatch on the avatar's bottom-start
         *  corner, as on iOS. */
        Badge,
    }

    /**
     * How the DM header shows the disappearing timer: null when it's off.
     * Next to a pet ([petShown]) it's the avatar's badge, which takes no
     * room on the title line, so it never hides there: beside the pet and
     * the streak most phones have no room left for the pill, and it's the
     * open DM's only cue that messages disappear (web shrinks it to its
     * stopwatch there). Otherwise it's the pill, as before the pet.
     */
    fun headerTimerCue(timerSeconds: Int?, petShown: Boolean): TimerCue? = when {
        timerSeconds == null || timerSeconds <= 0 -> null
        petShown -> TimerCue.Badge
        else -> TimerCue.Pill
    }

    /** The header pet's spoken label. [name]: the pet's name as this viewer
     *  sees it (masked for a supervised child with "Blur swear words" on). */
    fun headerLabel(pet: PetDTO, name: String = pet.name): String =
        if (pet.status == "invited") "Zekk Pet: $name (invite pending)"
        else "Zekk Pet: $name, ${Mood.of(pet.mood).label}"

    // ── Adopt banner ──────────────────────────────────────────────────────

    enum class BannerKind { Adopt, Waiting, Invited }

    /** [locked]: [BannerKind.Invited] only — the streak broke or is under
     *  the minimum, so accepting would only fail. Accept hides until the
     *  streak is back (Not now stays). */
    data class Banner(val kind: BannerKind, val text: String, val locked: Boolean = false)

    /**
     * The slim bar under the DM header:
     *   - no pet, and the DM may adopt → "🥚 5-day streak! Adopt a Zekk Pet with Sam." [Adopt]
     *   - our invite is waiting → "Waiting for Sam to accept your Zekk Pet." [Cancel]
     *   - their invite to us → "Sam wants to raise a Zekk Pet with you." [Accept] [Not now]
     *     (the streak is under minStreak → "… Keep a 3-day streak going to accept." [Not now], [Banner.locked])
     * Null otherwise (not loaded, not eligible, or a pet that's hatched already).
     */
    fun banner(state: DmPetState?, selfId: String?, peerName: String): Banner? {
        if (state == null || selfId == null) return null
        val pet = state.pet
        if (pet == null) {
            if (!state.eligible) return null
            return Banner(BannerKind.Adopt, "🥚 ${state.streak}-day streak! Adopt a Zekk Pet with $peerName.")
        }
        if (pet.status != "invited") return null
        if (pet.invitedBy == selfId) return Banner(BannerKind.Waiting, "Waiting for $peerName to accept your Zekk Pet.")
        val text = "$peerName wants to raise a Zekk Pet with you."
        // The invite outlives a broken streak (it lapses after 7 days), but
        // the server only lets it be accepted on a live streak of minStreak
        // or more.
        if (state.streak < state.minStreak) {
            return Banner(BannerKind.Invited, "$text Keep a ${state.minStreak}-day streak going to accept.", locked = true)
        }
        return Banner(BannerKind.Invited, text)
    }

    /** Whether the bar's action hangs on a live streak, which breaks at
     *  midnight UTC with no event: Adopt, and Accept on their invite (unless
     *  it's [Banner.locked] already). The open DM refetches then
     *  ([nextUtcMidnightRefreshAt]). */
    fun bannerNeedsStreak(banner: Banner?): Boolean =
        banner != null && (banner.kind == BannerKind.Adopt || (banner.kind == BannerKind.Invited && !banner.locked))

    /** A dismissed bar stays hidden for the session, per DM and per kind (so
     *  hiding the adopt prompt doesn't also hide a later invite). */
    fun bannerKey(channelId: String, kind: BannerKind): String = "$channelId:${kind.name}"

    // ── Changes ───────────────────────────────────────────────────────────

    /** What the adopt bar, the pet card and the rename dialog ask the server for. */
    sealed interface Change {
        data object Invite : Change
        data object Accept : Change
        /** The invitee declines, or the inviter cancels. */
        data object Decline : Change
        data class Rename(val name: String) : Change
    }

    /** Shown when a change fails without a reason from the server. */
    fun failedMessage(change: Change): String = when (change) {
        Change.Invite -> "Couldn't send the invite."
        Change.Accept -> "Couldn't adopt the pet."
        Change.Decline -> "Couldn't answer the invite."
        is Change.Rename -> "Couldn't rename the pet."
    }

    // ── The in-chat notice ────────────────────────────────────────────────

    /** A Zekk Pet notice: type 'system_pet', or (defensively) any row
     *  carrying the 'pet' metadata. */
    fun isNotice(m: Message): Boolean = m.type == "system_pet" || m.metadata?.kind == "pet"

    /** A pet notice [selfId] didn't cause. The sweep's 'asleep' and
     *  'ran_away' (actorId null) are authored by the DM's user A only
     *  nominally, so for A too it is not their own message: it doesn't move
     *  their read marker past what the other person sent, or end their
     *  typing. */
    fun isNoticeNotBy(m: Message, selfId: String?): Boolean = isNotice(m) && m.metadata?.actorId != selfId

    /** Whose row [m] counts as for following it down: a pet notice is its
     *  actor's (no one's for the sweep's 'asleep' / 'ran_away', though user
     *  A is their author), anything else its author's. */
    fun ownerId(m: Message): String? = if (isNotice(m)) m.metadata?.actorId else m.authorId ?: m.author?.id

    /** "a Kid", "an Adult". */
    private fun withArticle(word: String): String =
        if (word.firstOrNull()?.lowercaseChar() in setOf('a', 'e', 'i', 'o', 'u')) "an $word" else "a $word"

    /**
     * The notice line: "You" for the viewer, the other person's (nicknamed)
     * name otherwise. [peerName] is the other person in the DM — the adoption
     * names both. Null for an event this app doesn't know (or an actor event
     * without its actor): the row's fallback content shows instead.
     */
    fun noticeText(
        event: String,
        petName: String,
        stage: Stage,
        actorIsSelf: Boolean,
        actorName: String?,
        peerName: String,
    ): String? {
        val who = if (actorIsSelf) "You" else actorName
        return when (event) {
            "invited" -> who?.let { "$it ${if (actorIsSelf) "want" else "wants"} to raise a Zekk Pet together. 🥚" }
            // The viewer is always one of the two, so they read first.
            "adopted" -> "You and ${if (actorIsSelf || actorName == null) peerName else actorName} adopted a Zekk Pet! 🥚"
            "hatched" -> "$petName hatched! 🐣"
            "evolved" -> "$petName grew into ${withArticle(stage.label)}!"
            "asleep" -> "$petName fell asleep. 😴 Say hi to each other within 2 days to wake it up."
            "awake" -> "$petName woke up! 🎉"
            "ran_away" -> "$petName ran away. Keep a $MIN_STREAK-day streak to adopt a new one."
            "renamed" -> who?.let { "$it renamed the pet to $petName." }
            else -> null
        }
    }

    /**
     * The text a notice row shows, built from its metadata. The actor is the
     * viewer ([selfId]), the other person ([peerId], read as [peerName]), the
     * row's author ([authorName]) or else "Someone". Falls back to the row's
     * third-person `content` without the metadata or for an unknown event.
     * [mask] is the viewer's profanity mask (a supervised child's "Blur swear
     * words"): either person picks the pet's name, so it goes over the name
     * and the fallback content, as over message bodies.
     */
    fun noticeLine(
        m: Message,
        selfId: String?,
        peerId: String?,
        peerName: String,
        authorName: String?,
        mask: (String) -> String = { it },
    ): String {
        val md = m.metadata?.takeIf { it.kind == "pet" } ?: return mask(m.content)
        val petName = md.petName ?: return mask(m.content)
        val actorId = md.actorId
        val actorName = when {
            actorId == null -> null
            actorId == peerId -> peerName
            actorId == (m.authorId ?: m.author?.id) -> authorName ?: "Someone"
            else -> "Someone"
        }
        return noticeText(
            event = md.event.orEmpty(),
            petName = mask(petName),
            stage = Stage.of(md.stage),
            actorIsSelf = selfId != null && actorId == selfId,
            actorName = actorName,
            peerName = peerName,
        ) ?: mask(m.content)
    }

    /** The small pet drawn beside a notice: the stage it reached, asleep for
     *  the asleep notice, lonely when it ran away, happy otherwise. */
    fun noticeArt(m: Message): Pair<Stage, Mood> {
        val md = m.metadata?.takeIf { it.kind == "pet" } ?: return Stage.Egg to Mood.Happy
        val mood = when (md.event) {
            "asleep" -> Mood.Asleep
            "ran_away" -> Mood.Lonely
            else -> Mood.Happy
        }
        return Stage.of(md.stage) to mood
    }

    // ── Refresh ───────────────────────────────────────────────────────────

    /** Slack after a boundary, so the refetch lands on the far side of it. */
    const val REFRESH_SLACK_MS = 5_000L

    /**
     * When the open DM should refetch its pet even if no event comes: the
     * mood is worked out when the server answers, and two of its rules turn
     * on the clock alone — 18:00 UTC (a pet fed yesterday turns grumpy) and
     * the end of the UTC day (today's tasks reset). The next of those (epoch
     * ms, plus [REFRESH_SLACK_MS]) that is still ahead of [nowMs], or null
     * when the DTO has neither. A boundary counts until its slack is over
     * too, so a call inside those seconds returns the same time and the
     * pending refetch stands.
     */
    fun nextRefreshAt(pet: PetDTO, nowMs: Long): Long? {
        val evening = parseDay(pet.today)?.atTime(18, 0)?.toInstant(java.time.ZoneOffset.UTC)?.toEpochMilli()
        val dayEnd = runCatching { java.time.Instant.parse(pet.dayEndsAt).toEpochMilli() }.getOrNull()
        val next = listOfNotNull(evening, dayEnd).filter { it + REFRESH_SLACK_MS > nowMs }.minOrNull() ?: return null
        return next + REFRESH_SLACK_MS
    }

    /**
     * When the open DM should refetch because its streak may break: the next
     * midnight UTC after [nowMs] (epoch ms), plus [REFRESH_SLACK_MS]. Adopt
     * and Accept are only offered on a live streak ([bannerNeedsStreak]), and
     * no event says when one ends. Like [nextRefreshAt], a midnight counts
     * until its slack is over, so a call in those seconds returns the same
     * time and the pending refetch stands.
     */
    fun nextUtcMidnightRefreshAt(nowMs: Long): Long {
        val day = java.time.Instant.ofEpochMilli(nowMs - REFRESH_SLACK_MS).atZone(java.time.ZoneOffset.UTC).toLocalDate()
        return day.plusDays(1).atStartOfDay(java.time.ZoneOffset.UTC).toInstant().toEpochMilli() + REFRESH_SLACK_MS
    }

    // ── Store ─────────────────────────────────────────────────────────────

    /**
     * A DM's state once DM_PET_UPDATE (or our own change) says its pet is
     * [pet] (null = no pet any more), over [prev]. Not fetched yet: whether
     * the DM may adopt is unknown until GET /pet answers, so it reads as not
     * eligible (no bar) rather than a guess. An invite is only ever sent on a
     * streak of at least the minimum, so one takes that until the fetch says
     * otherwise (Accept doesn't flash "keep a streak going" while the DM
     * opens). Always an entry, no pet included, as on web and iOS: the DM
     * then counts as loaded, so a later "gone" refetches.
     */
    fun withPet(prev: DmPetState?, pet: PetDTO?): DmPetState =
        (prev ?: DmPetState(
            pet = null,
            eligible = false,
            streak = if (pet?.status == "invited") MIN_STREAK else 0,
            minStreak = MIN_STREAK,
        )).copy(pet = pet)

    /**
     * What GET /pet's answer [fetched] leaves over [prev]. [keepPet]: a
     * DM_PET_UPDATE (or our own change) came in while the request was out,
     * so the pet it left ([prev]'s, none without an entry) is newer and only
     * the answer's eligibility, streak and gate go in. When that pet went
     * away (cancelled, expired, ran away) but the answer still saw it, the
     * server's "not eligible" was about that pet: work it out as the server
     * does for no pet, from the answer's live streak and gate, as web and
     * iOS do — otherwise the Adopt bar stays hidden and nothing refetches.
     */
    fun afterFetch(prev: DmPetState?, fetched: DmPetState, keepPet: Boolean): DmPetState {
        if (!keepPet) return fetched
        val kept = prev?.pet
        val eligible = if (kept == null && fetched.pet != null) {
            fetched.canAct && fetched.streak >= fetched.minStreak
        } else {
            fetched.eligible
        }
        return fetched.copy(pet = kept, eligible = eligible)
    }

    // ── Gateway payload ───────────────────────────────────────────────────

    /** DM_PET_UPDATE: camelCase { channelId, pet } like DM_SETTINGS_UPDATE.
     *  [pet] null = no pet any more (invite declined / cancelled / expired,
     *  or it ran away). */
    data class Update(val channelId: String, val pet: PetDTO?)

    /** Null when the payload has no channel, or carries a pet this app can't
     *  decode (then the event is skipped: it must not read as "gone"). */
    fun parseUpdate(data: JsonElement?, json: Json): Update? {
        val obj = data as? JsonObject ?: return null
        val cid = (obj["channelId"] as? JsonPrimitive)?.contentOrNull ?: return null
        val pet = when (val raw = obj["pet"]) {
            null, JsonNull -> null
            is JsonObject -> runCatching { json.decodeFromJsonElement(PetDTO.serializer(), raw) }.getOrNull() ?: return null
            else -> return null
        }
        return Update(cid, pet)
    }
}
