package com.zekktris.data

/**
 * The public short code of a device-approval login: how it is rendered, what
 * goes in the QR, and how a scanned/typed string is turned back into a code.
 *
 * Kept in one object because THREE clients have to agree on the QR payload and
 * on normalization. The normalizer is a byte-for-byte mirror of
 * `normalizeUserCode` in apps/api/src/auth/device-login-store.ts:
 *
 *     raw.toUpperCase().replace(/[^0-9A-Z]/g,'').replace(/O/g,'0').replace(/[IL]/g,'1')
 *
 * The alphabet is Crockford base32 minus the confusables (no I, L, O, U), so
 * folding O→0 and I/L→1 turns a plausible mis-read into the right code instead
 * of a mystifying failure. We normalize only to shape the input and to decide
 * when the "Continue" button lights up — the SERVER is the authority on whether
 * a code exists, and a normalized-but-wrong code simply 404s.
 */
object DeviceLoginCode {

    /** Crockford base32 minus I, L, O, U — must match CODE_ALPHABET server-side. */
    private const val ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"

    /** Server-side USER_CODE_LENGTH. */
    const val LENGTH = 8

    /**
     * What the logged-out device puts in its QR. Kept byte-identical to iOS
     * (DeviceLoginCode.qrPayload in AuthViews.swift) and to web's own QR
     * (AuthScreens.tsx), so any client can scan any other client's screen.
     *
     * It MUST point at the APPROVAL page (`/approve-device`), not at
     * `/login/device`. `/login/device` is the *requester* page — the one that
     * shows this QR — and it ignores `?code=` and immediately starts a second,
     * unrelated login request. Scanning with the system camera is the flow this
     * screen instructs, so pointing it there showed no approval prompt at all
     * and burned the start rate-limit budget.
     *
     * An https URL rather than a bare code, deliberately: a user who scans it
     * with the SYSTEM camera (not our in-app scanner) lands on a real Zekktris
     * page instead of a screenful of gibberish. Our own scanner accepts this
     * URL, the `zekktris://` variant, and a bare code — see [parse].
     *
     * NOTE: this URL does not open the app, and no `zekktris://` payload would
     * either — this app registers NO deep link at all (MainActivity has only a
     * MAIN/LAUNCHER intent-filter). Opening the approval screen from a scan
     * needs either an App Links intent-filter plus a `.well-known/assetlinks.json`
     * carrying this app's signing-certificate fingerprint, or a custom-scheme
     * VIEW filter plus an ACTION_VIEW handler; neither exists today, so the
     * system-camera path deliberately lands on the web approval page.
     */
    fun qrPayload(userCode: String): String =
        "${Config.CDN_BASE_URL}/approve-device?code=${format(userCode)}"

    /** Strip separators, uppercase, fold the excluded confusables. */
    fun normalize(raw: String): String {
        val sb = StringBuilder(raw.length)
        for (ch in raw.uppercase()) {
            when {
                ch == 'O' -> sb.append('0')
                ch == 'I' || ch == 'L' -> sb.append('1')
                ch in '0'..'9' || ch in 'A'..'Z' -> sb.append(ch)
                // Everything else (dashes, spaces, punctuation) is separator noise.
            }
        }
        return sb.toString()
    }

    /** Display form `ABCD-EFGH`. Anything not exactly [LENGTH] long is passed
     *  through untouched so a malformed code is still visible to the user. */
    fun format(code: String): String {
        val n = normalize(code)
        return if (n.length == LENGTH) "${n.take(4)}-${n.drop(4)}" else code
    }

    /** A normalized code of the right length made only of alphabet symbols. */
    fun isComplete(raw: String): Boolean {
        val n = normalize(raw)
        return n.length == LENGTH && n.all { it in ALPHABET }
    }

    /**
     * Pull a code out of whatever a QR decoded to (or whatever was pasted).
     * Accepts, in order of preference:
     *   - `https://zekktris.com/approve-device?code=ABCD-EFGH` (our QR payload)
     *   - `https://zekktris.com/login/device?code=ABCD-EFGH`   (older builds')
     *   - `zekktris://device-login?code=ABCD-EFGH`             (future deep link)
     *   - any URL whose last path segment is a code
     *   - a bare `ABCD-EFGH` / `ABCDEFGH`
     *
     * Returns the NORMALIZED code, or null when nothing code-shaped is present.
     * Untrusted input: a QR can contain anything at all, so this never follows
     * or fetches the URL — it only reads a parameter out of it.
     */
    fun parse(raw: String?): String? {
        val text = raw?.trim().orEmpty()
        if (text.isEmpty()) return null
        // Bare code first — the common case for a hand-typed entry.
        if (isComplete(text)) return normalize(text)
        // `code=` query parameter, scheme-agnostic and without pulling in a URI
        // parser that would throw on the malformed strings a QR can carry.
        val marker = "code="
        val at = text.indexOf(marker, ignoreCase = true)
        if (at >= 0) {
            val tail = text.substring(at + marker.length).takeWhile { it != '&' && it != '#' }
            if (isComplete(tail)) return normalize(tail)
        }
        // Last path segment, e.g. .../login/device/ABCD-EFGH
        val segment = text.substringBefore('?').substringBefore('#').trimEnd('/').substringAfterLast('/')
        if (isComplete(segment)) return normalize(segment)
        return null
    }
}
