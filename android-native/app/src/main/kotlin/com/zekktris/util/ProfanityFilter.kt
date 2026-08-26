package com.zekktris.util

/**
 * Profanity mask for the parental "blur swear words" filter. When a supervised
 * child's effective restrictions have `filterProfanity` on, message bodies are
 * run through [mask], which masks each whole-word profanity match to its first
 * letter + bullets (e.g. `fucking` → `f••••••`). The word set is ported from
 * the server's WATCH + BLOCKED presets; whole-word, case-insensitive, matching
 * the server's automod semantics. Client-side render only.
 * (iOS ProfanityFilter, MessageViews.swift.)
 */
object ProfanityFilter {
    // BLOCKED (slurs) + WATCH (general profanity + sexual/explicit).
    private val words: List<String> = listOf(
        "nigger", "niggers", "nigga", "niggas", "chink", "chinks", "gook",
        "spic", "spics", "wetback", "wetbacks", "kike", "kikes", "beaner",
        "beaners", "raghead", "towelhead", "faggot", "faggots", "fag", "fags",
        "dyke", "dykes", "tranny", "trannies", "retard", "retards", "retarded",
        "fuck", "fucks", "fucked", "fucker", "fuckers", "fucking", "motherfucker",
        "motherfuckers", "motherfucking", "shit", "shits", "shitty", "bullshit",
        "shithead", "dumbass", "jackass", "asshole", "assholes", "arsehole",
        "bastard", "bastards", "bitch", "bitches", "bitchy", "son of a bitch",
        "goddamn", "goddammit", "piss off", "pissed off",
        "cock", "cocks", "cocksucker", "dick", "dicks", "dickhead", "pussy",
        "pussies", "cunt", "cunts", "twat", "wank", "wanker", "jerkoff",
        "jerk off", "blowjob", "blow job", "handjob", "hand job", "cum",
        "jizz", "tits", "titties", "boobs", "dildo", "porn", "porno",
        "pornography", "slut", "sluts", "slutty", "whore", "whores", "hoe",
        "hoes", "skank",
    )

    // Longer phrases first so they win over their substrings.
    private val regex: Regex = Regex(
        "\\b(" + words.sortedByDescending { it.length }.joinToString("|") { Regex.escape(it) } + ")\\b",
        RegexOption.IGNORE_CASE,
    )

    // Custom-emoji shortcodes (:name:) and mention/channel tokens (<…>) must NOT
    // be masked — rewriting their inner text (e.g. :cum: → :c••:) corrupts the
    // token so it no longer resolves. Skip any profanity match overlapping one.
    private val protectedRegex = Regex(":[A-Za-z0-9_]+:|<[^>]+>")

    fun mask(text: String): String {
        if (text.isEmpty()) return text
        val hits = regex.findAll(text).toList()
        if (hits.isEmpty()) return text
        val protectedRanges = protectedRegex.findAll(text).map { it.range }.toList()
        val matches = hits.filter { m ->
            protectedRanges.none { it.first <= m.range.last && m.range.first <= it.last }
        }
        if (matches.isEmpty()) return text
        val out = StringBuilder(text)
        // Masking is length-preserving (letter→letter/•, others unchanged), so
        // replacing back-to-front keeps every range valid.
        for (m in matches.asReversed()) {
            out.replace(m.range.first, m.range.last + 1, maskWord(m.value))
        }
        return out.toString()
    }

    private fun maskWord(word: String): String {
        var seenFirst = false
        val out = StringBuilder(word.length)
        for (ch in word) {
            if (ch.isLetterOrDigit()) {
                if (seenFirst) out.append('•') else { seenFirst = true; out.append(ch) }
            } else {
                out.append(ch)
            }
        }
        return out.toString()
    }
}
