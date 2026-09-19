import Foundation

/// Who Siri means when you say a name — shared by the iPhone and Apple Watch
/// Siri extensions, and by the tests.
///
/// One implementation on purpose. This decides who a message GOES TO, and it
/// is tuned carefully: loose enough that "Alex" finds "alexjmorgan94" and
/// "alex morgan" survives Siri's spacing, strict enough that "Mom" does not
/// reach "Tom". Two copies would drift, and the drift would show up as a
/// message to the wrong person on one device and not the other.
///
/// Pure: no Intents, no App Group, no network — each extension maps its own
/// conversation list into `SiriCandidate`s and back.

/// A conversation Siri might mean, reduced to what can be matched on.
struct SiriCandidate: Equatable {
    /// The conversation (DM channel) id.
    let id: String
    /// Every name this person goes by, most-said first: the linked Contacts
    /// card's name, the display name Zekktris shows, then the @username.
    let names: [String]
}

enum SiriMatching {
    static func rank(heard: String, in all: [SiriCandidate]) -> [SiriCandidate] {
        let spoken = normalize(heard)
        guard !spoken.isEmpty else { return [] }

        let ranked = all
            .map { (candidate: $0, score: bestScore(spoken: spoken, candidate: $0)) }
            .filter { $0.score >= minScore }
            .sorted { $0.score > $1.score }
        guard let best = ranked.first else { return [] }
        // One candidate, or one clearly ahead of the rest: send to it.
        if ranked.count == 1 || best.score - ranked[1].score >= clearWinnerMargin {
            return [best.candidate]
        }
        // Too close to call — let Siri ask which one.
        return ranked.prefix(3).map { $0.candidate }
    }

    /// Below this, a name is a different name rather than a mangled one.
    static let minScore = 0.55
    /// How far ahead the leader must be to skip the "which one?" question.
    static let clearWinnerMargin = 0.12

    /// Best fit across everything this person goes by.
    static func bestScore(spoken: String, candidate: SiriCandidate) -> Double {
        var best = 0.0
        for name in candidate.names {
            best = max(best, score(spoken: spoken, candidate: normalize(name)))
        }
        return best
    }

    /// 0...1, ordered so that the confident kinds of match always outrank a
    /// merely similar-looking one.
    static func score(spoken: String, candidate: String) -> Double {
        guard !spoken.isEmpty, !candidate.isEmpty else { return 0 }
        if spoken == candidate { return 1 }
        if candidate.hasPrefix(spoken) { return 0.95 }
        let tokens = candidate
            .split(whereSeparator: { !$0.isLetter && !$0.isNumber })
            .map(String.init)
        if tokens.contains(spoken) { return 0.93 }
        if tokens.contains(where: { $0.hasPrefix(spoken) }) { return 0.9 }
        if candidate.contains(spoken) { return 0.8 }
        // Fall back to how much editing it would take. Spaces are dropped
        // first: Siri writes "alex morgan" where the username is
        // "alexjmorgan94", and the space is not a real difference.
        let squashed = spoken.filter { $0.isLetter || $0.isNumber }
        var best = ratio(squashed, candidate)
        for token in tokens { best = max(best, ratio(squashed, token)) }
        // A short word is nearly every other short word: "Mom" is one edit from
        // "Tom", which scores 0.67 and would have sent a message to the wrong
        // person — Siri reads the name back, but nobody listens hard to a
        // confirmation they expect. So the shorter the thing spoken, the closer
        // an inexact match has to be before it counts at all.
        return best >= fuzzyFloor(forLength: squashed.count) ? best : 0
    }

    /// How good an INEXACT match must be, by length of what was said. Exact,
    /// prefix and whole-word hits are scored above this and never reach it.
    private static func fuzzyFloor(forLength length: Int) -> Double {
        switch length {
        case ..<5: return 0.85   // effectively: no fuzz on very short names
        case 5...7: return 0.7
        default: return 0.6
        }
    }

    /// Similarity as 1 - (edits / longest), so it is comparable across lengths.
    private static func ratio(_ a: String, _ b: String) -> Double {
        guard !a.isEmpty, !b.isEmpty else { return 0 }
        let distance = Double(levenshtein(Array(a), Array(b)))
        return max(0, 1 - distance / Double(max(a.count, b.count)))
    }

    /// Plain edit distance, one row at a time — the strings here are names, so
    /// the quadratic cost is nothing and it avoids a dependency.
    private static func levenshtein(_ a: [Character], _ b: [Character]) -> Int {
        if a.isEmpty { return b.count }
        if b.isEmpty { return a.count }
        var previous = Array(0...b.count)
        var current = [Int](repeating: 0, count: b.count + 1)
        for i in 1...a.count {
            current[0] = i
            for j in 1...b.count {
                let substitution = previous[j - 1] + (a[i - 1] == b[j - 1] ? 0 : 1)
                current[j] = min(previous[j] + 1, current[j - 1] + 1, substitution)
            }
            swap(&previous, &current)
        }
        return previous[b.count]
    }

    /// Case- and accent-insensitive, so "José" matches "jose".
    static func normalize(_ s: String) -> String {
        s.folding(options: [.caseInsensitive, .diacriticInsensitive], locale: .current)
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
