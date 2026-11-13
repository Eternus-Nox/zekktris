import Foundation

/// Error surfaced from a failed REST call. `message` is best-effort extracted
/// from the response body (`{error:{message}}`, `{message}`, or raw text).
struct APIError: LocalizedError {
    let status: Int
    let message: String
    /// True when the server answered a login with `{requires2FA:true}` — the
    /// password was correct but a TOTP/recovery code is needed. Lets the
    /// login UI reveal a code field instead of showing the raw JSON body.
    var requires2FA: Bool = false
    var errorDescription: String? { message }
}

/// The outcome of one `/auth/refresh` attempt.
///
/// Mirrors the web contract in `packages/client/src/rest.ts` (`RefreshOutcome`).
/// The distinction that matters is `fatal`: ONLY that means "the session is
/// over, clear the credentials". Collapsing every failure into a single `false`
/// — which is what this used to be — is why an offline moment, a 502 during a
/// deploy, or a lost rotation race deleted the keychain token AND the 30-day
/// refresh cookie and dropped the user on the login screen.
enum RefreshOutcome: Sendable {
    /// The refresh cookie was exchanged for a fresh access token.
    case success
    /// Network error, timeout, 5xx, the 409 the api returns when a concurrent
    /// rotation won the race, or an unparseable body. The refresh cookie is
    /// almost certainly still good — we simply couldn't ask. Keep the
    /// credentials; the next request tries again.
    case transient
    /// 401/403 from `/auth/refresh` only: the refresh token is revoked or
    /// expired and no amount of retrying brings the session back.
    case fatal

    var isSuccess: Bool {
        if case .success = self { return true }
        return false
    }
}

/// One file part for a multipart message send.
struct UploadFile {
    let data: Data
    let filename: String
    let contentType: String
    /// Plaintext pixel dims (images only) — sent as positional metadata so the
    /// recipient reserves the exact slot for an E2EE image the server can't
    /// measure (it only sees ciphertext). nil for non-images / unknown.
    var width: Int? = nil
    var height: Int? = nil
    /// Already-encrypted (.zke) thumbnail bytes for an E2EE image — uploaded as
    /// a sibling `thumbs[i]` part so the recipient loads a tiny preview inline.
    var thumbData: Data? = nil
}

/// Thin REST client mirroring `packages/client/src/rest.ts`. Sends
/// `Authorization: Bearer <token>` when a token is set and the call is
/// authorized. Stage 1 covers auth + the read/send-message slice; more
/// endpoints get added as screens are ported.
final class APIClient {
    static let shared = APIClient()

    /// Current access token. Set by `Session` after login / on launch.
    var token: String?

    /// Invoked after /auth/refresh rotates the access token, so the owner
    /// (Session) can persist it. The gateway listens for the notification
    /// below to re-IDENTIFY with the fresh token after a reconnect.
    var onTokenRefresh: ((String) -> Void)?
    /// Invoked exactly once per refresh attempt that ends `.fatal` — i.e. only
    /// when `/auth/refresh` answered 401 or 403. The owner (Session) treats
    /// this as a hard sign-out.
    ///
    /// Deliberately NOT invoked for network errors, timeouts, 5xx, or the 409
    /// the api returns when a concurrent rotation won the race. Those are
    /// transient, the refresh cookie is still good, and clearing the keychain
    /// for them is what turned every offline moment and every api restart into
    /// "it signed me out again". Mirrors `onRefreshFailed` in
    /// `packages/client/src/rest.ts`.
    var onRefreshFatal: (() -> Void)?
    static let tokenRefreshedNotification = Notification.Name("zk.accessTokenRefreshed")

    private let session: URLSession = {
        let cfg = URLSessionConfiguration.default
        // Fail fast on a dead/stale connection instead of hanging. After a long
        // background, URLSession's keep-alive pool can hand a new request a
        // half-open socket; with the default 7-day resource timeout and no
        // request timeout, that request parks ~indefinitely — which is exactly
        // what made a post-resume DM send clear the composer yet never deliver
        // (the send's `catch` never ran, so the optimistic bubble stayed stuck
        // at "Sending…"). A 20s request timeout turns that into a thrown
        // URLError so the send visibly fails + offers Retry, and the transparent
        // retry below usually makes it succeed on the first try anyway.
        cfg.timeoutIntervalForRequest = 20
        cfg.timeoutIntervalForResource = 60
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()
    /// Multipart uploads (attachments, voice messages, avatars, emoji) get
    /// their own session. The one above caps a WHOLE request at 60 s
    /// (`timeoutIntervalForResource`): right for a JSON call, fatal for an
    /// upload whose body can't go up and be answered inside a minute — about
    /// 40 MB at a 5 Mbps uplink, i.e. most videos and any big batch on
    /// cellular. Those always failed with "The request timed out." and the
    /// picks bounced back into the composer. A per-request `timeoutInterval`
    /// can't lift that cap (it only sets the idle timeout), hence a separate
    /// session.
    private let uploadSession: URLSession = {
        let cfg = URLSessionConfiguration.default
        // Idle timeout: no bytes moving in either direction for this long
        // means a dead socket. Longer than the 20 s above because the server
        // only answers once it has stored the files and made thumbnails.
        cfg.timeoutIntervalForRequest = 60
        // The whole upload, body plus response.
        cfg.timeoutIntervalForResource = 15 * 60
        cfg.waitsForConnectivity = false
        return URLSession(configuration: cfg)
    }()
    private let decoder = JSONDecoder()

    /// In-flight refresh, shared so concurrent 401s trigger ONE /auth/refresh
    /// (the server rotates the cookie per call — parallel refreshes with the
    /// same cookie would 401 each other). Guarded by `refreshLock`: APIClient
    /// is a plain class whose async methods run on the concurrent executor,
    /// so the check-then-store below MUST be atomic. Without the lock, the
    /// cold-start burst (getMe + loadGuilds/loadDMs/loadReadStates all 401 at
    /// once) could launch TWO refreshes; the loser's rotation wiped the fresh
    /// cookie → every later refresh failed → spurious force-logout.
    private var refreshTask: Task<RefreshOutcome, Never>?
    private let refreshLock = NSLock()

    /// Backoff ladder for a TRANSIENT refresh failure, in ms between attempts
    /// (so four attempts, ~5.6 s of waiting before jitter in the worst case).
    ///
    /// Kept deliberately short, for the same reason web keeps it short: when
    /// the api answers 409 the token we're presenting has been superseded, and
    /// the server only treats that as benign concurrency for a couple of
    /// minutes before it starts calling it token theft — a client that kept
    /// retrying for minutes would talk itself into a revoked session.
    private static let refreshRetryDelaysMs: [UInt64] = [400, 1_200, 4_000]

    /// Spread a ladder rung over ±50% at random, so devices whose access tokens
    /// were minted together don't retry in lockstep against an api that is
    /// already struggling (which is exactly when this ladder runs).
    private static func jitteredNanos(_ delayMs: UInt64) -> UInt64 {
        UInt64(Double(delayMs) * (0.5 + Double.random(in: 0...1)) * 1_000_000)
    }

    /// Exchange the refresh cookie (stored by URLSession from login's
    /// Set-Cookie) for a fresh access token.
    ///
    /// Returns a TRI-STATE, not a Bool. This used to collapse "401, the token
    /// really is revoked" and "timed out / offline / 502 while the api
    /// restarted / unparseable body" into one `false`, and the callers then
    /// treated that as a dead session — `Session.bootstrap` deleted the
    /// keychain token and the 30-day refresh cookie because a 20 s request
    /// timeout looked identical to a revoke. Only `.fatal` (401/403 from
    /// `/auth/refresh` itself) may ever clear credentials.
    func refreshAccessToken() async -> RefreshOutcome {
        // Atomically claim or join the single in-flight refresh. The lock is
        // confined to a synchronous closure (no `await` inside) so it never
        // spans a suspension point — required under Swift 6 strict
        // concurrency, where holding NSLock across an await is a hard error.
        let work: Task<RefreshOutcome, Never> = refreshLock.withLock {
            if let inFlight = refreshTask { return inFlight }
            let task = Task<RefreshOutcome, Never> { await self.refreshWithBackoff() }
            refreshTask = task
            return task
        }
        let outcome = await work.value
        // Clear only if this is still the in-flight task — a newer refresh may
        // have already replaced it, and a late joiner must not wipe it.
        refreshLock.withLock {
            if let current = refreshTask, current == work { refreshTask = nil }
        }
        return outcome
    }

    /// Refresh, retrying only the failures worth retrying. Stops the moment we
    /// have a token or a fatal answer; otherwise walks the backoff ladder and
    /// gives up TRANSIENTLY — the caller keeps its credentials and the next
    /// request will try again.
    ///
    /// Runs inside the single coalesced `refreshTask`, so `onRefreshFatal`
    /// fires at most once per refresh no matter how many callers joined.
    private func refreshWithBackoff() async -> RefreshOutcome {
        var outcome = await refreshOnce()
        var rung = 0
        while case .transient = outcome, rung < Self.refreshRetryDelaysMs.count {
            let delayMs = Self.refreshRetryDelaysMs[rung]
            rung += 1
            try? await Task.sleep(nanoseconds: Self.jitteredNanos(delayMs))
            outcome = await refreshOnce()
        }
        if case .fatal = outcome { onRefreshFatal?() }
        return outcome
    }

    /// One `/auth/refresh` round trip. Never throws — every failure mode is
    /// classified into the tri-state instead.
    private func refreshOnce() async -> RefreshOutcome {
        struct RefreshResponse: Decodable { let accessToken: String }
        guard let url = URL(string: Config.apiBaseURL + "/auth/refresh") else { return .transient }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        // Tighter than the session-wide 20 s: up to four attempts can run
        // behind one caller's 401, so the whole ladder has to stay inside the
        // window in which the server still treats a superseded token as benign
        // concurrency rather than theft.
        req.timeoutInterval = 10
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch {
            // Network-level failure: offline, DNS, connection reset, the app
            // resumed before the radio came back. The refresh cookie is almost
            // certainly still good — we simply couldn't ask.
            return .transient
        }
        guard let http = resp as? HTTPURLResponse else { return .transient }
        // The only two answers that actually mean "this session is over".
        if http.statusCode == 401 || http.statusCode == 403 { return .fatal }
        // 409 = a concurrent rotation won the race (or this is a retry of a
        // refresh whose response was lost and the server couldn't replay it);
        // 5xx = the api is restarting or a proxy answered for it. Both are
        // worth retrying; neither is a logout.
        guard (200..<300).contains(http.statusCode) else { return .transient }
        // A 200 with an unreadable body means something interposed (proxy,
        // captive portal), not that the session died.
        guard let decoded = try? decoder.decode(RefreshResponse.self, from: data) else { return .transient }
        token = decoded.accessToken
        onTokenRefresh?(decoded.accessToken)
        NotificationCenter.default.post(
            name: APIClient.tokenRefreshedNotification, object: decoded.accessToken)
        return .success
    }

    /// Whether an expired-token failure on this path is eligible for a
    /// refresh-and-retry (auth endpoints themselves are not).
    private func canRetryAfterRefresh(_ path: String, authorized: Bool, isRetry: Bool) -> Bool {
        authorized && !isRetry && token != nil && !path.hasPrefix("/auth/")
    }

    // ── Core request ────────────────────────────────────────────────────────
    private func send<T: Decodable>(
        _ method: String,
        _ path: String,
        bodyData: Data? = nil,
        authorized: Bool = true,
        isRetry: Bool = false,
        onSuccess: ((HTTPURLResponse) -> Void)? = nil
    ) async throws -> T {
        guard let url = URL(string: Config.apiBaseURL + path) else {
            throw APIError(status: 0, message: "Bad URL: \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bodyData {
            req.httpBody = bodyData
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authorized, let token {
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }

        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await session.data(for: req)
        } catch let err as URLError where !isRetry && Self.isStaleConnection(err.code) {
            // A stale pooled socket after a long background raises
            // .networkConnectionLost / .cannotConnectToHost — the request never
            // reached the server, so replaying it once on a fresh connection is
            // safe (and the send endpoint is nonce-deduplicated server-side
            // regardless). This makes the very first post-resume request succeed
            // instead of surfacing a spurious failure.
            return try await send(method, path, bodyData: bodyData, authorized: authorized, isRetry: true, onSuccess: onSuccess)
        }
        guard let http = resp as? HTTPURLResponse else {
            throw APIError(status: 0, message: "No HTTP response")
        }
        // Access tokens are short-lived (15 min): a 401 usually just means
        // "expired" — refresh via the cookie and replay the request once.
        if http.statusCode == 401, canRetryAfterRefresh(path, authorized: authorized, isRetry: isRetry),
           await refreshAccessToken().isSuccess {
            return try await send(method, path, bodyData: bodyData, authorized: authorized, isRetry: true, onSuccess: onSuccess)
        }
        guard (200..<300).contains(http.statusCode) else {
            let needs2FA = Self.requires2FA(data)
            throw APIError(
                status: http.statusCode,
                message: needs2FA
                    ? "Enter your two-factor code."
                    : (Self.extractError(data) ?? "Request failed (\(http.statusCode))"),
                requires2FA: needs2FA
            )
        }
        // A caller that reads the answer's headers (messages: its Date).
        onSuccess?(http)
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: http.statusCode, message: "Could not read response: \(error)")
        }
    }

    /// Connection-level failures worth ONE transparent replay: these mean the
    /// request never reached the server (a dead pooled socket / unreachable
    /// host), so retrying can't double-execute anything. Deliberately excludes
    /// `.timedOut` (a real 20s timeout — already waited long enough) and
    /// `.notConnectedToInternet` (no radio — a retry won't help).
    private static func isStaleConnection(_ code: URLError.Code) -> Bool {
        switch code {
        case .networkConnectionLost, .cannotConnectToHost:
            return true
        default:
            return false
        }
    }

    /// Detects the login `{requires2FA:true}` 401 hint so callers can prompt
    /// for a code instead of surfacing the raw JSON body as an error.
    private static func requires2FA(_ data: Data) -> Bool {
        guard let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return false }
        return obj["requires2FA"] as? Bool == true
    }

    /// Fire-and-mostly-forget for endpoints whose body we don't decode.
    @discardableResult
    /// `bearerOverride` pins the Authorization token for THIS call instead of
    /// using `self.token`, and disables the 401→refresh retry. Used by logout's
    /// teardown so it revokes the OLD session with the OLD token even after a
    /// fast re-login has replaced `self.token` — and so it never refreshes a
    /// dead session back into a live one (which would re-persist a token the
    /// logout just deleted). `baseOverride` pins the SERVER the same way: the
    /// old token must only ever go back to the server that issued it, even if
    /// the user picks a different server while the teardown is in flight.
    private func sendNoDecode(_ method: String, _ path: String, authorized: Bool = true, isRetry: Bool = false, bearerOverride: String? = nil, baseOverride: String? = nil) async -> Bool {
        guard let url = URL(string: (baseOverride ?? Config.apiBaseURL) + path) else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let bearer = bearerOverride ?? token
        if authorized, let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        guard let (_, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse else { return false }
        if bearerOverride == nil, http.statusCode == 401,
           canRetryAfterRefresh(path, authorized: authorized, isRetry: isRetry),
           await refreshAccessToken().isSuccess {
            return await sendNoDecode(method, path, authorized: authorized, isRetry: true)
        }
        return (200..<300).contains(http.statusCode)
    }

    /// Like `send` but ignores the (often empty) response body. Throws on
    /// non-2xx so callers can surface the server's error message.
    private func sendVoid(_ method: String, _ path: String, bodyData: Data? = nil, authorized: Bool = true, isRetry: Bool = false) async throws {
        guard let url = URL(string: Config.apiBaseURL + path) else {
            throw APIError(status: 0, message: "Bad URL: \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bodyData {
            req.httpBody = bodyData
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authorized, let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError(status: 0, message: "No HTTP response") }
        if http.statusCode == 401, canRetryAfterRefresh(path, authorized: authorized, isRetry: isRetry),
           await refreshAccessToken().isSuccess {
            return try await sendVoid(method, path, bodyData: bodyData, authorized: authorized, isRetry: true)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: Self.extractError(data) ?? "Request failed (\(http.statusCode))")
        }
    }

    /// Like `send`, but returns the raw response body undecoded — for an
    /// endpoint whose payload is opaque JSON we must preserve verbatim (the
    /// voice-prefs blob). Mirrors `sendVoid`'s auth + 401-refresh handling.
    private func sendRawData(_ method: String, _ path: String, bodyData: Data? = nil, authorized: Bool = true, isRetry: Bool = false) async throws -> Data {
        guard let url = URL(string: Config.apiBaseURL + path) else {
            throw APIError(status: 0, message: "Bad URL: \(path)")
        }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let bodyData {
            req.httpBody = bodyData
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if authorized, let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError(status: 0, message: "No HTTP response") }
        if http.statusCode == 401, canRetryAfterRefresh(path, authorized: authorized, isRetry: isRetry),
           await refreshAccessToken().isSuccess {
            return try await sendRawData(method, path, bodyData: bodyData, authorized: authorized, isRetry: true)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: Self.extractError(data) ?? "Request failed (\(http.statusCode))")
        }
        return data
    }

    // ── Voice preferences (cross-device per-user mute sync) ─────────────────
    // The blob is opaque JSON owned by the web client (per-user volumes, master
    // volume, audio-processing toggles). iOS only reads/writes perUser[*].muted,
    // so it round-trips the WHOLE blob as [String: Any] — PATCH is a full
    // replace server-side, and we must not clobber web-only fields.

    /// Fetch the current voice-prefs blob (the inner object, web shape:
    /// `{ perUser: { <id>: { muted, volume } }, masterVolume, ... }`).
    func getVoicePrefs() async throws -> [String: Any] {
        let data = try await sendRawData("GET", "/users/@me/voice-prefs")
        let obj = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        return (obj?["voicePrefs"] as? [String: Any]) ?? [:]
    }

    /// Replace the voice-prefs blob. Caller must pass the COMPLETE merged blob.
    func setVoicePrefs(_ blob: [String: Any]) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["voicePrefs": blob])
        try await sendVoid("PATCH", "/users/@me/voice-prefs", bodyData: body)
    }

    private static func extractError(_ data: Data) -> String? {
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            if let e = obj["error"] as? [String: Any], let m = e["message"] as? String { return m }
            if let m = obj["message"] as? String { return m }
            if let e = obj["error"] as? String { return e }
        }
        let raw = String(data: data, encoding: .utf8)
        return (raw?.isEmpty == false) ? raw : nil
    }

    // ── Auth ──────────────────────────────────────────────────────────────
    func login(email: String, password: String, code: String? = nil) async throws -> AuthSession {
        let body = try JSONEncoder().encode(LoginBody(email: email, password: password, code: code))
        return try await send("POST", "/auth/login", bodyData: body, authorized: false)
    }

    // ── Device-approval login ("approve this sign-in on your phone") ────────
    // The logged-out device calls start + poll (both PUBLIC); the signed-in
    // phone calls lookup + approve/deny (all AUTHED). See Models.swift for the
    // two-secrets contract and apps/api/src/auth/device-login-store.ts for why
    // the approval screen is a security control.

    /// [public] Open a request from a logged-out device. `deviceName` is a
    /// self-declared label the approver sees CLEARLY MARKED AS A CLAIM — the
    /// server sanitizes it. The returned `deviceCode` is secret: never render,
    /// QR, log or persist it.
    func startDeviceLogin(deviceName: String?) async throws -> DeviceLoginStart {
        // The body is required server-side; `{}` is the empty form.
        var payload: [String: Any] = [:]
        if let deviceName, !deviceName.isEmpty { payload["deviceName"] = deviceName }
        let body = try JSONSerialization.data(withJSONObject: payload)
        return try await send("POST", "/auth/device-login/start", bodyData: body, authorized: false)
    }

    /// [public] Ask for the outcome, presenting the SECRET deviceCode. Only
    /// throws on transport/HTTP failures — pending/denied/expired are values.
    func pollDeviceLogin(deviceCode: String) async throws -> DeviceLoginPoll {
        let body = try JSONSerialization.data(withJSONObject: ["deviceCode": deviceCode])
        return try await send("POST", "/auth/device-login/poll", bodyData: body, authorized: false)
    }

    /// [authed] What is this code asking for? Feeds the approval screen — the
    /// only defence against an attacker phishing an approval out of the user.
    /// 404 when the code is unknown or expired, 429 when the per-user lookup
    /// limiter (the real brute-force guard) trips.
    func lookupDeviceLogin(userCode: String) async throws -> DeviceLoginRequestInfo {
        let body = try JSONSerialization.data(withJSONObject: ["userCode": userCode])
        return try await sendAuthRouteAuthorized("/auth/device-login/lookup", bodyData: body)
    }

    /// [authed] Approve — binds the request to this user and signs that device
    /// in. Terminal. 404 unknown/expired, 409 already answered.
    func approveDeviceLogin(userCode: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["userCode": userCode])
        let _: OkWrap = try await sendAuthRouteAuthorized("/auth/device-login/approve", bodyData: body)
    }

    /// [authed] Deny. Terminal, and decided atomically against a racing
    /// approve, so the waiting device sees exactly one outcome.
    func denyDeviceLogin(userCode: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["userCode": userCode])
        let _: OkWrap = try await sendAuthRouteAuthorized("/auth/device-login/deny", bodyData: body)
    }

    /// POST to an AUTHED endpoint that lives under `/auth/`, with a one-shot
    /// refresh-and-replay on 401.
    ///
    /// `canRetryAfterRefresh` deliberately excludes every `/auth/` path (a
    /// login/refresh call must never recurse into a refresh). The device-login
    /// approval routes are the exception that proves the rule: they are
    /// ordinary authed endpoints that merely happen to sit under `/auth/`, and
    /// without this the whole flow fails with a bare 401 whenever the 15-minute
    /// access token happens to have expired — which, for a screen you only open
    /// when a second device needs you, is most of the time. Handled here rather
    /// than by loosening the global predicate, so the real auth endpoints keep
    /// their exclusion.
    private func sendAuthRouteAuthorized<T: Decodable>(_ path: String, bodyData: Data) async throws -> T {
        do {
            return try await send("POST", path, bodyData: bodyData)
        } catch let err as APIError where err.status == 401 {
            guard await refreshAccessToken().isSuccess else { throw err }
            return try await send("POST", path, bodyData: bodyData, isRetry: true)
        }
    }

    // ── Intent token (Siri, widget, watch) ──────────────────────────────────
    /// [authed] Mint the long-lived token the extensions send as
    /// `Authorization: Intent <token>` — they cannot refresh, so the access
    /// token's copy died 15 minutes after the app was last used. Needs this
    /// normal Bearer session; an older server answers 404. Another authed
    /// route under `/auth/`, hence the explicit refresh-and-replay.
    func mintIntentToken() async throws -> IntentTokenGrant {
        try await sendAuthRouteAuthorized("/auth/intent-token", bodyData: Data("{}".utf8))
    }

    // ── Quick login (log in on another device) ──────────────────────────────
    // DEPRECATED direction (the code was the whole credential) — superseded by
    // the device-approval calls above. Delete alongside the
    // `/auth/quick-login/*` routes (checklist: apps/api/src/routes/auth.ts:415).
    /// [authed] Mint (or re-randomize) a quick-login code for this device's
    /// user. Uses the existing bearer token; never touches the session.
    func generateQuickLoginCode() async throws -> QuickLoginCode {
        return try await send("POST", "/auth/quick-login/create")
    }
    /// [authed] Invalidate the active code (on leaving the quick-login screen).
    func cancelQuickLoginCode() async {
        await sendNoDecode("POST", "/auth/quick-login/cancel")
    }
    /// [public] Redeem a code on a logged-out device → a new session (same
    /// envelope as login; the server also Set-Cookies the refresh token).
    func redeemQuickLogin(code: String) async throws -> AuthSession {
        let body = try JSONSerialization.data(withJSONObject: ["code": code])
        return try await send("POST", "/auth/quick-login/redeem", bodyData: body, authorized: false)
    }

    func forgotPassword(email: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["email": email])
        try await sendVoid("POST", "/auth/forgot-password", bodyData: body, authorized: false)
    }

    func resetPassword(token: String, newPassword: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["token": token, "newPassword": newPassword])
        try await sendVoid("POST", "/auth/reset-password", bodyData: body, authorized: false)
    }

    func register(email: String, username: String, displayName: String, password: String, dateOfBirth: String, code: String? = nil) async throws -> AuthSession {
        let body = try JSONEncoder().encode(
            RegisterBody(email: email, username: username, displayName: displayName, password: password, dateOfBirth: dateOfBirth, code: code)
        )
        return try await send("POST", "/auth/register", bodyData: body, authorized: false)
    }

    func logout(bearer: String? = nil, base: String? = nil) async {
        await sendNoDecode("POST", "/auth/logout", bearerOverride: bearer, baseOverride: base)
    }

    /// Single public profile. Includes `canMessage` (whether the viewer may
    /// DM/ring this user) — used to gate the profile card's Message/Call.
    func getUserProfile(userId: String) async throws -> PublicUser {
        let wrap: PublicUserWrap = try await send("GET", "/users/\(userId)")
        return wrap.user
    }

    func getMe() async throws -> SelfUser {
        let wrap: UserWrap = try await send("GET", "/users/@me")
        return wrap.user
    }

    // ── Guilds / channels / messages ────────────────────────────────────────
    func guilds() async throws -> [Guild] {
        let wrap: GuildsWrap = try await send("GET", "/guilds")
        return wrap.guilds
    }

    func channels(guildId: String) async throws -> [Channel] {
        let wrap: ChannelsWrap = try await send("GET", "/guilds/\(guildId)/channels")
        return wrap.channels
    }

    /// Everyone in voice across a whole server that this user can see — the
    /// sidebar's heal for a missed VOICE_STATE_UPDATE.
    func guildVoiceStates(guildId: String) async throws -> [VoiceState] {
        let wrap: VoiceStatesWrap = try await send("GET", "/guilds/\(guildId)/voice/states")
        return wrap.voiceStates
    }

    /// Fetch a single channel by id (carries its `guildId`). Used to resolve a
    /// notification/deep-link target that isn't in memory yet — e.g. a guild
    /// text channel tapped from a cold launch before its guild is selected.
    /// The server endpoint serves guild channels (VIEW_CHANNEL gated); DMs 404
    /// here and are resolved via the DM list instead.
    func channel(id: String) async throws -> Channel {
        let wrap: ChannelWrap = try await send("GET", "/channels/\(id)")
        return wrap.channel
    }

    func messages(channelId: String, limit: Int = 50, before: String? = nil, after: String? = nil, around: String? = nil) async throws -> [Message] {
        var path = "/channels/\(channelId)/messages?limit=\(limit)"
        if let before { path += "&before=\(before)" }
        if let after { path += "&after=\(after)" }
        if let around { path += "&around=\(around)" }
        let wrap: MessagesWrap = try await send("GET", path, onSuccess: { http in
            self.recordDateClockOffset(http.value(forHTTPHeaderField: "Date"))
        })
        return wrap.messages
    }

    // ── Server clock (disappearing messages) ────────────────────────────────
    /// server − device clock from the last message page's `Date` header (a
    /// lower bound, see `clockOffset(fromDateHeader:receivedAt:)`); nil until
    /// one arrived. Shifts the pages' disappearing deadlines
    /// (Message.expiresAt) onto the device clock until a MESSAGE_EXPIRY gives
    /// a precise offset. Written on the concurrent executor and read on the
    /// main actor, hence the lock.
    var dateClockOffset: TimeInterval? { dateClockLock.withLock { lastDateClockOffset } }
    private var lastDateClockOffset: TimeInterval?
    private let dateClockLock = NSLock()

    private func recordDateClockOffset(_ header: String?) {
        guard let offset = Self.clockOffset(fromDateHeader: header, receivedAt: Date()) else { return }
        dateClockLock.withLock { lastDateClockOffset = offset }
    }

    /// The HTTP `Date` header's format: RFC 1123, always GMT.
    private static let httpDateFormatter: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.timeZone = TimeZone(abbreviation: "GMT")
        f.dateFormat = "EEE, dd MMM yyyy HH:mm:ss zzz"
        return f
    }()

    /// server − device from an HTTP `Date` header (whole seconds, RFC 1123),
    /// read at `receivedAt`, once the response is in. The header truncates to
    /// the second and was written before the response arrived, so this is a
    /// LOWER bound of the true offset — a deadline derived from it never
    /// fires early. A fallback for REST deadlines until MESSAGE_EXPIRY's
    /// precise `server_now` is known. Mirrors Android's
    /// Disappearing.offsetFromDateHeader.
    static func clockOffset(fromDateHeader header: String?, receivedAt: Date) -> TimeInterval? {
        guard let raw = header?.trimmingCharacters(in: .whitespaces), !raw.isEmpty,
              let at = httpDateFormatter.date(from: raw) else { return nil }
        return at.timeIntervalSince(receivedAt)
    }

    /// All attachments in a channel, newest-first, for the shared-media gallery.
    /// `before` is the previous page's last attachment id (cursor). We fetch
    /// unfiltered (no `kind`) and let the gallery bucket Media vs Files, so
    /// encrypted (.zke) attachments are classified by their inner filename.
    func channelAttachments(channelId: String, limit: Int = 60, before: String? = nil) async throws -> [Attachment] {
        var path = "/channels/\(channelId)/attachments?limit=\(limit)"
        if let before { path += "&before=\(before)" }
        let wrap: ChannelAttachmentsWrap = try await send("GET", path)
        return wrap.attachments
    }

    /// Resolve a single link preview for a URL found in a DECRYPTED E2EE
    /// message (the server can't unfurl ciphertext, so the client does it after
    /// decryption). Returns nil when the server couldn't build a preview.
    /// Sends the link to the server, so only called when the user opted in
    /// (AppStore.e2eeLinkPreviewsKey).
    func unfurl(url: String) async throws -> MessageEmbed? {
        // Percent-encode the URL as a query VALUE — keep its own &/=/?/+/#
        // from being read as query structure.
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=?+#")
        let q = url.addingPercentEncoding(withAllowedCharacters: allowed) ?? url
        let wrap: UnfurlWrap = try await send("GET", "/unfurl?url=\(q)")
        return wrap.embed
    }

    /// `notARead`: the conversation wasn't on screen when this was composed
    /// (Siri, Shortcuts, a forward), so the server neither counts the send as
    /// reading it nor starts a disappearing message's countdown.
    func sendMessage(channelId: String, content: String, nonce: String, replyToId: String? = nil, forwardFromMessageId: String? = nil, stickerId: String? = nil, notARead: Bool = false) async throws -> Message {
        var body: [String: Any] = ["content": content, "nonce": nonce]
        if let rid = replyToId { body["replyToId"] = rid }
        if let fid = forwardFromMessageId { body["forwardFromMessageId"] = fid }
        if let sid = stickerId { body["stickerId"] = sid }
        if notARead { body["notARead"] = true }
        let data = try JSONSerialization.data(withJSONObject: body)
        let wrap: MessageWrap = try await send("POST", "/channels/\(channelId)/messages", bodyData: data)
        return wrap.message
    }

    func listGuildStickers(guildId: String) async throws -> [Sticker] {
        let wrap: StickersWrap = try await send("GET", "/guilds/\(guildId)/stickers")
        return wrap.stickers
    }
    func listGuildEmojis(guildId: String) async throws -> [GuildEmoji] {
        let wrap: EmojisWrap = try await send("GET", "/guilds/\(guildId)/emojis")
        return wrap.emojis
    }

    // ── Webhooks ──────────────────────────────────────────────────────────────
    func listChannelWebhooks(channelId: String) async throws -> [Webhook] {
        let wrap: WebhooksWrap = try await send("GET", "/channels/\(channelId)/webhooks")
        return wrap.webhooks
    }
    func createWebhook(channelId: String, name: String) async throws -> Webhook {
        let data = try JSONSerialization.data(withJSONObject: ["name": name])
        let wrap: WebhookWrap = try await send("POST", "/channels/\(channelId)/webhooks", bodyData: data)
        return wrap.webhook
    }
    func deleteWebhook(webhookId: String) async throws {
        try await sendVoid("DELETE", "/webhooks/\(webhookId)")
    }

    // ── Scheduled messages ──────────────────────────────────────────────────
    func scheduleMessage(channelId: String, content: String, scheduledFor: String) async throws -> ScheduledMessage {
        let data = try JSONSerialization.data(withJSONObject: ["content": content, "scheduledFor": scheduledFor])
        let wrap: ScheduledWrap = try await send("POST", "/channels/\(channelId)/scheduled-messages", bodyData: data)
        return wrap.scheduled
    }
    func listScheduledMessages() async throws -> [ScheduledMessage] {
        let wrap: ScheduledListWrap = try await send("GET", "/users/@me/scheduled-messages")
        return wrap.items
    }
    func cancelScheduledMessage(id: String) async throws {
        try await sendVoid("DELETE", "/users/@me/scheduled-messages/\(id)")
    }

    // ── Channel permission overrides ────────────────────────────────────────
    func listChannelOverrides(channelId: String) async throws -> [PermissionOverride] {
        let wrap: OverridesWrap = try await send("GET", "/channels/\(channelId)/permissions")
        return wrap.overrides
    }
    func putChannelOverride(channelId: String, targetId: String, type: String, allow: String, deny: String) async throws {
        let body: [String: Any] = ["type": type, "allow": allow, "deny": deny]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("PUT", "/channels/\(channelId)/permissions/\(targetId)", bodyData: data)
    }
    func deleteChannelOverride(channelId: String, targetId: String, type: String) async throws {
        try await sendVoid("DELETE", "/channels/\(channelId)/permissions/\(targetId)?type=\(type)")
    }

    // ── Self-assignable roles ─────────────────────────────────────────────────
    func listSelfAssignableRoles(guildId: String) async throws -> [Role] {
        let wrap: RolesWrap = try await send("GET", "/guilds/\(guildId)/self-assignable-roles")
        return wrap.roles
    }
    func assignSelfRole(guildId: String, roleId: String) async throws {
        try await sendVoid("PUT", "/guilds/\(guildId)/members/@me/roles/\(roleId)")
    }
    func revokeSelfRole(guildId: String, roleId: String) async throws {
        try await sendVoid("DELETE", "/guilds/\(guildId)/members/@me/roles/\(roleId)")
    }

    // ── Multipart plumbing (shared by every upload below) ────────────────────

    /// A filename as it may appear inside a multipart `filename="…"` header.
    /// A raw `"` ends the quoted string early and a CR or LF ends the header
    /// line; either breaks the framing, and the server's parser then rejects
    /// the whole body (500 "Failed to parse body as FormData.") — reproduced
    /// with `My "draft".pdf`. Percent-encoding exactly those three is what
    /// browsers send (WHATWG multipart/form-data) and what the server's undici
    /// parser decodes back, so the name is stored as the user saw it. Walked
    /// by Unicode scalar rather than with `replacingOccurrences`, because a
    /// CR LF pair is ONE Character in Swift and a per-character search can
    /// step over it.
    private static func multipartFilename(_ name: String) -> String {
        var out = ""
        for scalar in name.unicodeScalars {
            switch scalar {
            case "\"": out += "%22"
            case "\r": out += "%0D"
            case "\n": out += "%0A"
            default: out.unicodeScalars.append(scalar)
            }
        }
        return out
    }

    /// Counts the request-body bytes a task has handed to the network, so a
    /// failed upload can tell "never left the device" from "may have arrived".
    /// The callbacks come in on the session's delegate queue while the caller
    /// is suspended in `data(for:delegate:)`, hence the lock.
    private final class BodyBytesSentProbe: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
        private let lock = NSLock()
        private var sent: Int64 = 0
        var totalSent: Int64 { lock.withLock { sent } }

        func urlSession(_ session: URLSession, task: URLSessionTask, didSendBodyData bytesSent: Int64,
                        totalBytesSent: Int64, totalBytesExpectedToSend: Int64) {
            lock.withLock { sent = max(sent, totalBytesSent) }
        }
    }

    /// Run a finished multipart request on `uploadSession`, with the two
    /// transparent replays `send()` makes (the stale-socket one narrowed to an
    /// upload that never started — see below). `req` already carries the whole
    /// body, so a replay re-sends those bytes rather than rebuilding them, and
    /// the Authorization header is set here so a replay picks up a rotated
    /// token. Non-2xx answers are returned, not thrown: each caller words its
    /// own failure.
    private func performUpload(_ req: URLRequest, path: String, isRetry: Bool = false) async throws -> (Data, HTTPURLResponse) {
        var req = req
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        let probe = BodyBytesSentProbe()
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await uploadSession.data(for: req, delegate: probe)
        } catch let err as URLError where !isRetry && Self.isStaleConnection(err.code) && probe.totalSent == 0 {
            // A socket that went stale across app suspension fails before the
            // body goes out — one transparent replay on a fresh connection (the
            // same replay send() does) so a resume-then-upload (e.g. a voice
            // message, whose temp file is deleted after the send) isn't lost.
            //
            // Only while NOT ONE body byte has been sent. The same
            // `.networkConnectionLost` is what a link that drops mid-upload (a
            // cellular handoff during a long video) or after the server has
            // read the body raises, and the server does NOT deduplicate message
            // sends by nonce: replaying then could post the message, with every
            // attachment, twice. Once bytes are out the error goes to the
            // caller instead, and the composer puts the picks back for a retry.
            return try await performUpload(req, path: path, isRetry: true)
        } catch let err as URLError where err.code == .timedOut {
            // The system wording ("The request timed out.") says nothing about
            // what to do; the two things that help are a better connection and
            // a smaller body.
            throw APIError(status: 0, message: "The upload timed out. Check your connection, or try fewer or smaller files.")
        }
        guard let http = resp as? HTTPURLResponse else { throw APIError(status: 0, message: "No HTTP response") }
        // Access tokens are short-lived (15 min) and a big upload can outlive
        // one: refresh via the cookie and replay once, exactly like send().
        if http.statusCode == 401, canRetryAfterRefresh(path, authorized: true, isRetry: isRetry),
           await refreshAccessToken().isSuccess {
            return try await performUpload(req, path: path, isRetry: true)
        }
        return (data, http)
    }

    // ── Generic multipart upload (name/description + single file) ──────────────
    private func uploadMultipart<T: Decodable>(
        _ path: String, fields: [String: String], fileField: String,
        filename: String, contentType: String, fileData: Data, _ type: T.Type
    ) async throws -> T {
        guard let url = URL(string: Config.apiBaseURL + path) else { throw APIError(status: 0, message: "Bad URL") }
        let boundary = "ZkBoundary-\(UUID().uuidString)"
        var body = Data()
        func append(_ s: String) { body.append(Data(s.utf8)) }
        for (k, v) in fields {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"\(k)\"\r\n\r\n")
            append(v)
            append("\r\n")
        }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(Self.multipartFilename(filename))\"\r\n")
        append("Content-Type: \(contentType)\r\n\r\n")
        body.append(fileData)
        append("\r\n")
        append("--\(boundary)--\r\n")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body

        let (data, http) = try await performUpload(req, path: path)
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: Self.extractError(data) ?? "Upload failed (\(http.statusCode))")
        }
        return try decoder.decode(T.self, from: data)
    }

    // ── Emoji / sticker management ────────────────────────────────────────────
    func uploadGuildEmoji(guildId: String, name: String, filename: String, contentType: String, data: Data) async throws -> GuildEmoji {
        let wrap: EmojiWrap = try await uploadMultipart("/guilds/\(guildId)/emojis", fields: ["name": name], fileField: "file", filename: filename, contentType: contentType, fileData: data, EmojiWrap.self)
        return wrap.emoji
    }
    func deleteGuildEmoji(guildId: String, emojiId: String) async throws {
        try await sendVoid("DELETE", "/guilds/\(guildId)/emojis/\(emojiId)")
    }
    func uploadGuildSticker(guildId: String, name: String, description: String?, filename: String, contentType: String, data: Data) async throws -> Sticker {
        var fields = ["name": name]
        if let d = description, !d.isEmpty { fields["description"] = d }
        let wrap: StickerWrap = try await uploadMultipart("/guilds/\(guildId)/stickers", fields: fields, fileField: "file", filename: filename, contentType: contentType, fileData: data, StickerWrap.self)
        return wrap.sticker
    }
    func deleteGuildSticker(guildId: String, stickerId: String) async throws {
        try await sendVoid("DELETE", "/guilds/\(guildId)/stickers/\(stickerId)")
    }

    // ── Reaction roles ────────────────────────────────────────────────────────
    func listReactionRoles(guildId: String) async throws -> [ReactionRoleMapping] {
        let wrap: ReactionRolesWrap = try await send("GET", "/guilds/\(guildId)/reaction-roles")
        return wrap.items
    }
    func upsertReactionRole(guildId: String, messageId: String, channelId: String, emoji: String, roleId: String) async throws {
        let body: [String: Any] = ["messageId": messageId, "channelId": channelId, "emoji": emoji, "roleId": roleId]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("PUT", "/guilds/\(guildId)/reaction-roles", bodyData: data)
    }
    func deleteReactionRole(guildId: String, messageId: String, emoji: String) async throws {
        let enc = { (s: String) in s.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? s }
        try await sendVoid("DELETE", "/guilds/\(guildId)/reaction-roles?messageId=\(enc(messageId))&emoji=\(enc(emoji))")
    }

    // ── Scheduled events ──────────────────────────────────────────────────────
    func listEvents(guildId: String, status: String? = nil) async throws -> [ScheduledEvent] {
        var path = "/guilds/\(guildId)/events"
        if let s = status { path += "?status=\(s)" }
        let wrap: EventsWrap = try await send("GET", path)
        return wrap.events
    }
    func createEvent(guildId: String, body: [String: Any]) async throws -> ScheduledEvent {
        let data = try JSONSerialization.data(withJSONObject: body)
        let wrap: EventWrap = try await send("POST", "/guilds/\(guildId)/events", bodyData: data)
        return wrap.event
    }
    func updateEvent(guildId: String, eventId: String, patch: [String: Any]) async throws -> ScheduledEvent {
        let data = try JSONSerialization.data(withJSONObject: patch)
        let wrap: EventWrap = try await send("PATCH", "/guilds/\(guildId)/events/\(eventId)", bodyData: data)
        return wrap.event
    }
    func deleteEvent(guildId: String, eventId: String) async throws {
        try await sendVoid("DELETE", "/guilds/\(guildId)/events/\(eventId)")
    }
    func rsvpEvent(guildId: String, eventId: String, status: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["status": status])
        try await sendVoid("PUT", "/guilds/\(guildId)/events/\(eventId)/rsvp", bodyData: data)
    }
    func clearEventRsvp(guildId: String, eventId: String) async throws {
        try await sendVoid("DELETE", "/guilds/\(guildId)/events/\(eventId)/rsvp")
    }
    func listEventAttendees(guildId: String, eventId: String, status: String? = nil) async throws -> [EventRsvp] {
        var path = "/guilds/\(guildId)/events/\(eventId)/attendees"
        if let s = status { path += "?status=\(s)" }
        let wrap: AttendeesWrap = try await send("GET", path)
        return wrap.attendees
    }
    func listMyUpcomingEvents() async throws -> [MyEvent] {
        let wrap: MyEventsWrap = try await send("GET", "/users/@me/events")
        return wrap.events
    }

    // ── Stage channels ────────────────────────────────────────────────────────
    func listStageParticipants(channelId: String) async throws -> StageParticipantsResult {
        try await send("GET", "/channels/\(channelId)/stage")
    }
    func joinStage(channelId: String) async throws -> StageJoinResult {
        try await send("POST", "/channels/\(channelId)/stage/join")
    }
    func leaveStage(channelId: String) async {
        try? await sendVoid("POST", "/channels/\(channelId)/stage/leave")
    }
    func raiseHand(channelId: String) async throws {
        try await sendVoid("POST", "/channels/\(channelId)/stage/hand")
    }
    func lowerHand(channelId: String) async throws {
        try await sendVoid("DELETE", "/channels/\(channelId)/stage/hand")
    }
    func setStageSpeaker(channelId: String, userId: String, isSpeaker: Bool) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["userId": userId, "isSpeaker": isSpeaker])
        try await sendVoid("POST", "/channels/\(channelId)/stage/speakers", bodyData: data)
    }

    // ── Saved messages (bookmarks) ───────────────────────────────────────────
    func saveMessage(messageId: String) async throws {
        try await sendVoid("POST", "/users/@me/saved/\(messageId)")
    }
    func unsaveMessage(messageId: String) async throws {
        try await sendVoid("DELETE", "/users/@me/saved/\(messageId)")
    }
    func listSavedMessages() async throws -> [SavedMessageItem] {
        let wrap: SavedListWrap = try await send("GET", "/users/@me/saved")
        return wrap.items
    }
    func savedMembership(messageIds: [String]) async throws -> [String] {
        guard !messageIds.isEmpty else { return [] }
        let ids = messageIds.joined(separator: ",")
        let enc = ids.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? ids
        let wrap: SavedMembershipWrap = try await send("GET", "/users/@me/saved/members?ids=\(enc)")
        return wrap.savedIds
    }

    func listPinnedMessages(channelId: String) async throws -> [Message] {
        let wrap: MessagesWrap = try await send("GET", "/channels/\(channelId)/pins")
        return wrap.messages
    }
    func pinMessage(channelId: String, messageId: String) async throws {
        let _: MessageWrap = try await send("PUT", "/channels/\(channelId)/pins/\(messageId)")
    }
    func unpinMessage(channelId: String, messageId: String) async throws {
        try await sendVoid("DELETE", "/channels/\(channelId)/pins/\(messageId)")
    }

    // ── Direct messages ─────────────────────────────────────────────────────
    func listDMs() async throws -> [Channel] {
        let wrap: ChannelsWrap = try await send("GET", "/users/@me/channels")
        return wrap.channels
    }

    func openDM(recipientId: String) async throws -> Channel {
        let body = try JSONEncoder().encode(OpenDMBody(recipientId: recipientId))
        let wrap: ChannelWrap = try await send("POST", "/users/@me/channels", bodyData: body)
        return wrap.channel
    }

    // ── Relationships / friends ───────────────────────────────────────────
    func listRelationships() async throws -> [Relationship] {
        let wrap: RelationshipsWrap = try await send("GET", "/users/@me/relationships")
        return wrap.relationships
    }

    // ── Personal DM nicknames (viewer-private, shown in DMs only) ─────────────
    func getDmNicknames() async throws -> [String: String] {
        let wrap: DmNicknamesWrap = try await send("GET", "/users/@me/dm-nicknames")
        return wrap.nicknames
    }

    func setDmNickname(userId: String, nickname: String) async throws {
        let body = try JSONEncoder().encode(["nickname": nickname])
        try await sendVoid("PUT", "/users/@me/dm-nicknames/\(userId)", bodyData: body)
    }

    func clearDmNickname(userId: String) async throws {
        try await sendVoid("DELETE", "/users/@me/dm-nicknames/\(userId)")
    }

    func sendFriendRequestByUsername(_ username: String) async throws {
        let body = try JSONEncoder().encode(["username": username])
        let _: [String: String] = try await send("POST", "/users/@me/relationships/friends", bodyData: body)
    }

    func acceptFriendRequest(targetId: String) async throws {
        let _: OkWrap = try await send("PUT", "/users/@me/relationships/friends/\(targetId)/accept")
    }

    func removeFriend(targetId: String) async throws {
        let _: OkWrap = try await send("DELETE", "/users/@me/relationships/friends/\(targetId)")
    }

    func blockUser(targetId: String) async throws {
        let body = try JSONEncoder().encode(["targetId": targetId])
        let _: OkWrap = try await send("POST", "/users/@me/relationships/blocks", bodyData: body)
    }

    func unblockUser(targetId: String) async throws {
        let _: OkWrap = try await send("DELETE", "/users/@me/relationships/blocks/\(targetId)")
    }

    func listMentions() async throws -> [Mention] {
        let wrap: MentionsWrap = try await send("GET", "/users/@me/mentions")
        return wrap.mentions
    }

    /// Dismiss one mention from the inbox (deletes the row server-side).
    func deleteMention(messageId: String) async throws {
        try await sendVoid("DELETE", "/users/@me/mentions/\(messageId)")
    }

    /// Clear every mention from the inbox.
    func clearMentions() async throws {
        try await sendVoid("POST", "/users/@me/mentions/clear")
    }

    /// Mark every channel in a guild read; returns the updated read states.
    func markGuildRead(guildId: String) async throws -> [ReadState] {
        let wrap: ReadStatesWrap = try await send("POST", "/guilds/\(guildId)/read")
        return wrap.readStates
    }

    /// Poke/nudge the other party in a 1:1 DM with a variant
    /// (poke|heart|wave|like|fire). The server creates the system message;
    /// we don't need the response (the poke arrives back over the gateway).
    func poke(channelId: String, pokeType: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["pokeType": pokeType])
        try await sendVoid("POST", "/channels/\(channelId)/poke", bodyData: body)
    }

    /// Recent pokes RECEIVED by the current user on a 1:1 DM, newest first
    /// (capped at 6 server-side). Feeds the poke button's history popover.
    func listPokes(channelId: String) async throws -> [PokeHistoryEntry] {
        struct Wrap: Decodable { let pokes: [PokeHistoryEntry] }
        let wrap: Wrap = try await send("GET", "/channels/\(channelId)/pokes")
        return wrap.pokes
    }

    /// The user's notification overrides (per-guild / per-channel mute levels).
    func notificationOverrides() async throws -> [NotificationOverride] {
        let wrap: NotificationOverridesWrap = try await send("GET", "/users/@me/notification-settings")
        return wrap.overrides
    }

    /// Upsert a notification override. `level` nil deletes it (back to default).
    /// The server requires the key present (nullable, not optional), so we send
    /// an explicit JSON null when clearing.
    func setNotificationOverride(targetType: String, targetId: String, level: String?) async throws {
        let body: [String: Any] = [
            "targetType": targetType,
            "targetId": targetId,
            "level": level ?? NSNull(),
        ]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("PUT", "/users/@me/notification-settings", bodyData: data)
    }

    // ── Bots ──────────────────────────────────────────────────────────────
    // Bot accounts owned by the current user. The plaintext token is returned
    // ONLY by createBot + regenerateBotToken — store/show it immediately, it
    // can't be retrieved again.

    /// List the bots the current user owns.
    func listBots() async throws -> [Bot] {
        let wrap: BotListWrap = try await send("GET", "/users/@me/bots")
        return wrap.bots
    }

    /// Create a bot. Returns the bot DTO + its plaintext token (shown once).
    func createBot(username: String, displayName: String) async throws -> BotCreateResponse {
        let body: [String: Any] = ["username": username, "displayName": displayName]
        let data = try JSONSerialization.data(withJSONObject: body)
        return try await send("POST", "/users/@me/bots", bodyData: data)
    }

    /// Regenerate a bot's token. Invalidates the previous token.
    func regenerateBotToken(botId: String) async throws -> String {
        let resp: BotTokenResponse = try await send("POST", "/users/@me/bots/\(botId)/token")
        return resp.token
    }

    /// Delete a bot permanently.
    func deleteBot(botId: String) async throws {
        try await sendVoid("DELETE", "/users/@me/bots/\(botId)")
    }

    /// Add one of your bots to a guild. Requires MANAGE_GUILD on the target.
    func addBotToGuild(guildId: String, botId: String) async throws {
        let body: [String: Any] = ["botId": botId]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("POST", "/guilds/\(guildId)/bots", bodyData: data)
    }

    /// Set or clear (url=nil) a bot's event callback URL. Returns the signing
    /// secret once when a URL is set.
    func setBotEventConfig(botId: String, url: String?) async throws -> BotEventConfigResponse {
        let body: [String: Any] = ["url": url ?? NSNull()]
        let data = try JSONSerialization.data(withJSONObject: body)
        return try await send("PUT", "/users/@me/bots/\(botId)/event-config", bodyData: data)
    }

    /// Enable shared-key E2EE on a DM. salt + verifier are derived client-side;
    /// the server never sees the password or key.
    func enableDmE2EE(channelId: String, salt: String, verifier: String, purgeProof: String) async throws {
        let body = try JSONEncoder().encode(E2EEEnableBody(salt: salt, verifier: verifier, purgeProof: purgeProof))
        let _: OkWrap = try await send("PUT", "/users/@me/channels/\(channelId)/e2ee-enable", bodyData: body)
    }

    /// Register the purge proof on an encrypted DM the server has none for
    /// (encrypted before purge proofs existed, or by an older client). First
    /// registration wins; a different stored proof is refused (409).
    func registerDmE2EEPurgeProof(channelId: String, verifier: String, purgeProof: String) async throws {
        let body = try JSONEncoder().encode(E2EEPurgeProofBody(verifier: verifier, purgeProof: purgeProof))
        let _: OkWrap = try await send("PUT", "/users/@me/channels/\(channelId)/e2ee-purge-proof", bodyData: body)
    }

    /// Upload a new profile avatar (multipart 'file'); returns the updated user.
    func uploadMyAvatar(filename: String, contentType: String, data: Data) async throws -> SelfUser {
        let wrap: UserWrap = try await uploadMultipart(
            "/users/@me/avatar", fields: [:], fileField: "file",
            filename: filename, contentType: contentType, fileData: data, UserWrap.self)
        return wrap.user
    }
    /// Upload a new profile banner (multipart 'file'); returns the updated user.
    func uploadMyBanner(filename: String, contentType: String, data: Data) async throws -> SelfUser {
        let wrap: UserWrap = try await uploadMultipart(
            "/users/@me/banner", fields: [:], fileField: "file",
            filename: filename, contentType: contentType, fileData: data, UserWrap.self)
        return wrap.user
    }
    /// Upload a guild icon (MANAGE_GUILD); returns the updated guild.
    func uploadGuildIcon(guildId: String, filename: String, contentType: String, data: Data) async throws -> Guild {
        let wrap: GuildWrap = try await uploadMultipart(
            "/guilds/\(guildId)/icon", fields: [:], fileField: "file",
            filename: filename, contentType: contentType, fileData: data, GuildWrap.self)
        return wrap.guild
    }
    /// Upload a guild banner (MANAGE_GUILD); returns the updated guild.
    func uploadGuildBanner(guildId: String, filename: String, contentType: String, data: Data) async throws -> Guild {
        let wrap: GuildWrap = try await uploadMultipart(
            "/guilds/\(guildId)/banner", fields: [:], fileField: "file",
            filename: filename, contentType: contentType, fileData: data, GuildWrap.self)
        return wrap.guild
    }

    /// Change the account username (90-day cooldown server-side).
    func changeUsername(_ username: String, currentPassword: String) async throws -> SelfUser {
        let body = try JSONSerialization.data(withJSONObject: [
            "username": username, "currentPassword": currentPassword,
        ])
        let wrap: UserWrap = try await send("PATCH", "/users/@me/username", bodyData: body)
        return wrap.user
    }

    /// Request an email change; the server mails a verification link to the
    /// NEW address and the switch happens on confirm.
    func requestEmailChange(newEmail: String, currentPassword: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: [
            "newEmail": newEmail, "currentPassword": currentPassword,
        ])
        try await sendVoid("POST", "/users/@me/email/change-request", bodyData: body)
    }

    /// Disable E2EE on a DM (server purges encrypted history). The server
    /// requires the `verifier` and `purgeProof` derived from the local key as
    /// proof we hold it (the verifier alone is public) — without them (or
    /// with wrong ones) it returns 403 and does NOT purge. Throws on failure
    /// so the caller can surface it.
    func disableDmE2EE(channelId: String, verifier: String, purgeProof: String) async throws {
        let body = try JSONEncoder().encode(E2EEDisableBody(verifier: verifier, purgeProof: purgeProof))
        try await sendVoid("DELETE", "/users/@me/channels/\(channelId)/e2ee-disable", bodyData: body)
    }

    // ── Threads / forums ──────────────────────────────────────────────────
    /// Active + archived threads (or forum posts) under a parent channel.
    func threads(channelId: String) async throws -> [Channel] {
        let wrap: ThreadsWrap = try await send("GET", "/channels/\(channelId)/threads")
        return wrap.threads
    }

    /// Create a forum post (a thread with an initial message body).
    func createForumPost(forumChannelId: String, title: String, content: String) async throws -> ForumPostResult {
        let body = try JSONEncoder().encode(ForumPostBody(title: title, content: content))
        return try await send("POST", "/channels/\(forumChannelId)/posts", bodyData: body)
    }

    /// Start (or fetch the existing) thread anchored to a message.
    func createThread(channelId: String, messageId: String, name: String?) async throws -> Channel {
        let bodyData: Data
        if let name, !name.isEmpty {
            bodyData = try JSONEncoder().encode(["name": name])
        } else {
            bodyData = Data("{}".utf8)
        }
        let wrap: ChannelWrap = try await send("POST", "/channels/\(channelId)/messages/\(messageId)/threads", bodyData: bodyData)
        return wrap.channel
    }

    // ── Voice ───────────────────────────────────────────────────────────────
    /// Join a voice channel. Returns the SFU token + wsUrl (both null when the
    /// server has no LiveKit configured → presence-only, no audio).
    func joinVoice(channelId: String) async throws -> JoinVoiceResult {
        return try await send("POST", "/channels/\(channelId)/voice/join")
    }

    /// Who is in one voice channel right now (GET /channels/:id/voice/states).
    func channelVoiceStates(channelId: String) async throws -> [VoiceState] {
        let wrap: VoiceStatesWrap = try await send("GET", "/channels/\(channelId)/voice/states")
        return wrap.voiceStates
    }

    /// Patch self-mute / self-deaf on the current voice state. Best-effort.
    func updateVoiceState(channelId: String, selfMute: Bool?, selfDeaf: Bool?) async {
        var patch: [String: Bool] = [:]
        if let selfMute { patch["selfMute"] = selfMute }
        if let selfDeaf { patch["selfDeaf"] = selfDeaf }
        guard let body = try? JSONEncoder().encode(patch) else { return }
        do { let _: VoiceStateWrap = try await send("POST", "/channels/\(channelId)/voice/state", bodyData: body) } catch {}
    }

    /// Leave the given voice channel (idempotent).
    func leaveVoice(channelId: String) async {
        await sendNoDecode("DELETE", "/channels/\(channelId)/voice")
    }

    /// Decline an incoming 1:1 DM call — ends the caller's session. Best-effort.
    func declineCall(channelId: String) async {
        await sendNoDecode("POST", "/channels/\(channelId)/voice/decline")
    }

    // ── Reactions ─────────────────────────────────────────────────────────
    private func emojiPathComponent(_ emoji: String) -> String {
        // Match the web's encodeURIComponent: percent-encode everything that
        // isn't alphanumeric (emoji bytes always get encoded).
        emoji.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? emoji
    }

    func addReaction(channelId: String, messageId: String, emoji: String) async throws {
        let e = emojiPathComponent(emoji)
        let _: OkWrap = try await send("PUT", "/channels/\(channelId)/messages/\(messageId)/reactions/\(e)/@me")
    }

    func removeReaction(channelId: String, messageId: String, emoji: String) async throws {
        let e = emojiPathComponent(emoji)
        let _: OkWrap = try await send("DELETE", "/channels/\(channelId)/messages/\(messageId)/reactions/\(e)/@me")
    }

    // ── Attachments (multipart send) ────────────────────────────────────────
    /// Send a message with file attachments. Mirrors the web contract:
    /// a `payload_json` text field + `files[N]` file parts.
    func sendMessageMultipart(channelId: String, content: String, nonce: String, files: [UploadFile], replyToId: String? = nil, voiceMessage: [String: Any]? = nil) async throws -> Message {
        let path = "/channels/\(channelId)/messages"
        guard let url = URL(string: Config.apiBaseURL + path) else {
            throw APIError(status: 0, message: "Bad URL")
        }
        let boundary = "ZkBoundary-\(UUID().uuidString)"
        var payload: [String: Any] = ["content": content, "nonce": nonce]
        if let rid = replyToId { payload["replyToId"] = rid } else { payload["replyToId"] = NSNull() }
        if let vm = voiceMessage { payload["voiceMessage"] = vm }
        // Per-file dims, POSITIONAL to files[i], so an E2EE image reserves its
        // exact slot before decrypt. NSNull for files with no dims; the whole
        // key is omitted when nothing has dims (byte-identical to old sends).
        let attMeta: [Any] = files.map { f in
            if f.width == nil, f.height == nil, f.thumbData == nil { return NSNull() }
            var m: [String: Any] = [:]
            if let w = f.width { m["width"] = w }
            if let h = f.height { m["height"] = h }
            if f.thumbData != nil { m["hasThumbnail"] = true }
            return m
        }
        if attMeta.contains(where: { !($0 is NSNull) }) { payload["attachments"] = attMeta }
        let payloadJSON = try JSONSerialization.data(withJSONObject: payload)

        var body = Data()
        func append(_ s: String) { body.append(Data(s.utf8)) }
        append("--\(boundary)\r\n")
        append("Content-Disposition: form-data; name=\"payload_json\"\r\n")
        append("Content-Type: application/json\r\n\r\n")
        body.append(payloadJSON)
        append("\r\n")
        for (i, file) in files.enumerated() {
            append("--\(boundary)\r\n")
            append("Content-Disposition: form-data; name=\"files[\(i)]\"; filename=\"\(Self.multipartFilename(file.filename))\"\r\n")
            append("Content-Type: \(file.contentType)\r\n\r\n")
            body.append(file.data)
            append("\r\n")
            // Sibling encrypted-thumbnail part for this image (E2EE only).
            if let thumb = file.thumbData {
                append("--\(boundary)\r\n")
                append("Content-Disposition: form-data; name=\"thumbs[\(i)]\"; filename=\"thumb.zke\"\r\n")
                append("Content-Type: application/octet-stream\r\n\r\n")
                body.append(thumb)
                append("\r\n")
            }
        }
        append("--\(boundary)--\r\n")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        req.httpBody = body

        // On the upload session (no 60 s whole-request cap), with the
        // stale-socket replay and the 401 refresh-and-replay — see performUpload.
        let (data, http) = try await performUpload(req, path: path)
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: Self.extractError(data) ?? "Upload failed (\(http.statusCode))")
        }
        let wrap: MessageWrap = try decoder.decode(MessageWrap.self, from: data)
        return wrap.message
    }

    // ── Edit / delete ───────────────────────────────────────────────────────
    func editMessage(channelId: String, messageId: String, content: String) async throws -> Message {
        let body = try JSONEncoder().encode(["content": content])
        let wrap: MessageWrap = try await send("PATCH", "/channels/\(channelId)/messages/\(messageId)", bodyData: body)
        return wrap.message
    }

    func deleteMessage(channelId: String, messageId: String) async throws {
        let _: OkWrap = try await send("DELETE", "/channels/\(channelId)/messages/\(messageId)")
    }

    // ── Polls ─────────────────────────────────────────────────────────────
    func voteOnPoll(channelId: String, pollId: String, optionId: String) async throws {
        try await sendVoid("POST", "/channels/\(channelId)/polls/\(pollId)/options/\(optionId)/vote")
    }

    func removePollVote(channelId: String, pollId: String, optionId: String) async throws {
        try await sendVoid("DELETE", "/channels/\(channelId)/polls/\(pollId)/options/\(optionId)/vote")
    }

    /// Create a poll message. Content is empty — the poll is the message.
    func sendPoll(channelId: String, question: String, options: [String], multipleChoice: Bool, durationHours: Int, nonce: String) async throws -> Message {
        let body: [String: Any] = [
            "content": "",
            "nonce": nonce,
            "poll": [
                "question": question,
                "options": options,
                "multipleChoice": multipleChoice,
                "durationHours": durationHours,
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: body)
        let wrap: MessageWrap = try await send("POST", "/channels/\(channelId)/messages", bodyData: data)
        return wrap.message
    }

    // ── Typing ────────────────────────────────────────────────────────────
    /// Fire a typing notification (fire-and-forget). Server broadcasts
    /// TYPING_START to the channel; it self-expires client-side.
    func triggerTyping(channelId: String) async {
        await sendNoDecode("POST", "/channels/\(channelId)/typing")
    }

    func listReadStates() async throws -> [ReadState] {
        let wrap: ReadStatesWrap = try await send("GET", "/users/@me/read-states")
        return wrap.readStates
    }

    func ackChannel(channelId: String, messageId: String) async throws -> ReadState {
        let wrap: AckWrap = try await send("POST", "/channels/\(channelId)/messages/\(messageId)/ack")
        return wrap.readState
    }

    // ── Push (APNs device tokens) ─────────────────────────────────────────
    enum DeviceTokenResult {
        case ok
        /// Server answered 503: APNs keys aren't configured there. Don't
        /// retry — it can't start working until the operator adds them.
        case serverUnconfigured
        case failed
    }

    /// Register this device's APNs token.
    @discardableResult
    func registerDeviceToken(token: String, platform: String = "ios") async -> DeviceTokenResult {
        let body: [String: Any] = ["token": token, "platform": platform]
        guard let data = try? JSONSerialization.data(withJSONObject: body) else { return .failed }
        do { try await sendVoid("POST", "/users/@me/device-tokens", bodyData: data); return .ok }
        catch {
            if (error as? APIError)?.status == 503 { return .serverUnconfigured }
            return .failed
        }
    }

    /// Unregister an APNs device token (e.g. on logout). Best-effort.
    func unregisterDeviceToken(token: String, bearer: String? = nil, base: String? = nil) async {
        let encoded = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token
        await sendNoDecode("DELETE", "/users/@me/device-tokens/\(encoded)", bearerOverride: bearer, baseOverride: base)
    }

    // ── Profile ───────────────────────────────────────────────────────────
    /// Patch the current user (displayName / status / customStatus / …).
    func updateProfile(_ patch: [String: Any]) async throws -> SelfUser {
        let data = try JSONSerialization.data(withJSONObject: patch)
        let wrap: UserWrap = try await send("PATCH", "/users/@me", bodyData: data)
        return wrap.user
    }

    /// One-time self-service DOB set/correction (dedicated, gated endpoint).
    func updateDateOfBirth(_ dob: String) async throws -> SelfUser {
        let data = try JSONSerialization.data(withJSONObject: ["dateOfBirth": dob])
        let wrap: UserWrap = try await send("PATCH", "/users/@me/date-of-birth", bodyData: data)
        return wrap.user
    }

    // ── Search ────────────────────────────────────────────────────────────
    /// Full-text search within a channel. Returns matching messages.
    func searchMessages(channelId: String, query: String) async throws -> [Message] {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&+=?/")
        let q = query.addingPercentEncoding(withAllowedCharacters: allowed) ?? query
        let wrap: MessagesWrap = try await send("GET", "/channels/\(channelId)/messages/search?q=\(q)")
        return wrap.messages
    }

    /// Search across ALL of the caller's DM conversations at once
    /// (GET /users/@me/dms/search) — the same server full-text search as the
    /// per-channel search, but spanning every DM the user is a recipient of.
    func searchDirectMessages(query: String) async throws -> [Message] {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&+=?/")
        let q = query.addingPercentEncoding(withAllowedCharacters: allowed) ?? query
        let wrap: MessagesWrap = try await send("GET", "/users/@me/dms/search?q=\(q)")
        return wrap.messages
    }

    /// List the current user's active auth sessions (GET /users/@me/sessions).
    func listSessions() async throws -> [UserSession] {
        let wrap: SessionsWrap = try await send("GET", "/users/@me/sessions")
        return wrap.sessions
    }

    /// Revoke one specific session by id (DELETE /users/@me/sessions/:id).
    /// The server 404s if the id doesn't belong to the caller.
    func revokeSession(id: String) async throws {
        try await sendVoid("DELETE", "/users/@me/sessions/\(id)")
    }
}

extension APIClient {
    // MARK: Server discovery / creation / invites

    func createGuild(name: String, description: String?) async throws -> CreateGuildResult {
        var payload: [String: String] = ["name": name]
        if let description, !description.isEmpty { payload["description"] = description }
        let body = try JSONEncoder().encode(payload)
        return try await send("POST", "/guilds", bodyData: body)
    }

    func acceptInvite(code: String) async throws -> AcceptInviteResult {
        try await send("POST", "/invites/\(code)")
    }

    /// Public invite preview (GET /invites/:code) — shown before joining.
    /// Public endpoint; the bearer is sent but not required.
    func previewInvite(code: String) async throws -> InvitePreview {
        let enc = code.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? code
        let wrap: InvitePreviewWrap = try await send("GET", "/invites/\(enc)")
        return wrap.invite
    }

    // ── Two-factor (TOTP) — same endpoints web's rest client uses ───────────

    /// Current 2FA status (GET /users/@me/totp).
    func twoFactorStatus() async throws -> TwoFactorStatus {
        try await send("GET", "/users/@me/totp")
    }

    /// Begin enrollment — returns a fresh secret + otpauth:// URI for the QR
    /// (POST /users/@me/totp/begin). Idempotent until confirmed.
    func beginTwoFactor() async throws -> TwoFactorSecret {
        try await send("POST", "/users/@me/totp/begin")
    }

    /// Confirm enrollment with a 6-digit code; returns one-time recovery codes
    /// (POST /users/@me/totp/confirm). Step-up: arming 2FA is a login-factor
    /// change, so the account password is re-verified server-side.
    func confirmTwoFactor(code: String, currentPassword: String) async throws -> TwoFactorRecovery {
        let body = try JSONEncoder().encode(["code": code, "currentPassword": currentPassword])
        return try await send("POST", "/users/@me/totp/confirm", bodyData: body)
    }

    /// Disable 2FA with a current TOTP code OR a recovery code
    /// (POST /users/@me/totp/disable).
    func disableTwoFactor(code: String) async throws {
        let body = try JSONEncoder().encode(["code": code])
        try await sendVoid("POST", "/users/@me/totp/disable", bodyData: body)
    }

    /// Restore an exported backup/template as a BRAND-NEW guild (clone — never
    /// mutates an existing server). `backup` is the raw JSON document bytes
    /// from the picked file; the server re-validates the full shape. When
    /// `nameOverride` is given (the name the user typed) it wins over the
    /// file's stored name — same `?name=` query web's importGuild uses.
    func importGuild(backup: Data, nameOverride: String?) async throws -> CreateGuildResult {
        var path = "/guilds/import"
        if let n = nameOverride?.trimmingCharacters(in: .whitespacesAndNewlines), !n.isEmpty {
            let enc = n.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? n
            path += "?name=\(enc)"
        }
        return try await send("POST", path, bodyData: backup)
    }

    func listDiscoverable(q: String? = nil, category: String? = nil) async throws -> [DiscoverableGuild] {
        var path = "/discovery"
        var params: [String] = []
        if let q, !q.isEmpty {
            let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
            params.append("q=\(enc)")
        }
        if let category, !category.isEmpty {
            let enc = category.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? category
            params.append("category=\(enc)")
        }
        if !params.isEmpty { path += "?" + params.joined(separator: "&") }
        let wrap: DiscoverWrap = try await send("GET", path)
        return wrap.guilds
    }

    func joinDiscoverable(guildId: String) async throws {
        try await sendVoid("POST", "/guilds/\(guildId)/discovery/join")
    }

    /// Guild Settings → Discovery: opt the server in/out of the public
    /// directory (MANAGE_GUILD).
    func setGuildDiscovery(guildId: String, discoverable: Bool,
                           description: String?, category: String?) async throws {
        var body: [String: Any] = ["discoverable": discoverable]
        body["discoveryDescription"] = description ?? NSNull()
        body["discoveryCategory"] = category ?? NSNull()
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("PATCH", "/guilds/\(guildId)/discovery", bodyData: data)
    }

    // MARK: Admin (instance)

    func adminStats() async throws -> AdminStats {
        let wrap: AdminStatsWrap = try await send("GET", "/admin/stats")
        return wrap.stats
    }

    /// Operational/runtime metrics (gateway connections, uptime, voice,
    /// scheduled backlog, DB/Redis health, counts). Instance-admin gated.
    func adminMetrics() async throws -> InstanceMetrics {
        let wrap: MetricsWrap = try await send("GET", "/admin/metrics")
        return wrap.metrics
    }

    // MARK: Family / parental controls

    func familyMe() async throws -> FamilySummary {
        try await send("GET", "/family/me")
    }
    func familyRequestLink(username: String) async throws {
        let body = try JSONEncoder().encode(["username": username])
        try await sendVoid("POST", "/family/links", bodyData: body)
    }
    func familyAcceptLink(parentId: String) async throws {
        try await sendVoid("POST", "/family/links/\(parentId)/accept")
    }
    func familyRemoveLink(otherId: String) async throws {
        try await sendVoid("DELETE", "/family/links/\(otherId)")
    }
    /// Child invites a guardian by email. Returns "pending" (the email has an
    /// account, awaiting their accept) or "awaiting_signup" (we emailed them).
    func familyRequestParent(email: String) async throws -> String {
        struct Result: Codable { let status: String }
        let body = try JSONEncoder().encode(["email": email])
        let r: Result = try await send("POST", "/family/request-parent", bodyData: body, authorized: true)
        return r.status
    }
    func familyAcceptChildRequest(childId: String) async throws {
        try await sendVoid("POST", "/family/child-requests/\(childId)/accept")
    }

    // MARK: WebAuthn passkeys
    func passkeyLoginOptions() async throws -> PasskeyLoginOptions {
        try await send("POST", "/auth/passkey/login/options", authorized: false)
    }
    func passkeyLoginVerify(challengeId: String, response: [String: Any]) async throws -> AuthSession {
        let body = try JSONSerialization.data(withJSONObject: ["challengeId": challengeId, "response": response])
        return try await send("POST", "/auth/passkey/login/verify", bodyData: body, authorized: false)
    }
    func passkeyRegisterOptions() async throws -> PasskeyRegisterOptions {
        try await send("POST", "/auth/passkey/register/options")
    }
    func passkeyRegisterVerify(challengeId: String, response: [String: Any], deviceName: String?, currentPassword: String) async throws {
        var obj: [String: Any] = ["challengeId": challengeId, "response": response, "currentPassword": currentPassword]
        if let deviceName { obj["deviceName"] = deviceName }
        let body = try JSONSerialization.data(withJSONObject: obj)
        try await sendVoid("POST", "/auth/passkey/register/verify", bodyData: body)
    }
    func listPasskeys() async throws -> [PasskeyInfo] {
        struct Wrap: Codable { let passkeys: [PasskeyInfo] }
        let w: Wrap = try await send("GET", "/auth/passkey")
        return w.passkeys
    }
    /// Step-up: removing a login factor requires the account password.
    func deletePasskey(id: String, currentPassword: String) async throws {
        let body = try JSONEncoder().encode(["currentPassword": currentPassword])
        try await sendVoid("DELETE", "/auth/passkey/\(id)", bodyData: body)
    }

    func familyChildRestrictions(childId: String) async throws -> ChildRestrictions {
        let wrap: FamilyRestrictionsWrap = try await send("GET", "/family/children/\(childId)/restrictions")
        return wrap.restrictions
    }

    func familySetRestrictions(childId: String, _ r: ChildRestrictions) async throws -> ChildRestrictions {
        let patch: [String: Any] = [
            "canAddFriends": r.canAddFriends,
            "canRemoveFriends": r.canRemoveFriends,
            "allowVoice": r.allowVoice,
            "allowVideo": r.allowVideo,
            "allowStream": r.allowStream,
            "allowCreateGuild": r.allowCreateGuild,
            "allowJoinGuilds": r.allowJoinGuilds,
            "allowMessaging": r.allowMessaging,
            "dmPolicy": r.dmPolicy,
        ]
        let data = try JSONSerialization.data(withJSONObject: patch)
        let wrap: FamilyRestrictionsWrap = try await send("PATCH", "/family/children/\(childId)/restrictions", bodyData: data)
        return wrap.restrictions
    }

    func listMembers(guildId: String, limit: Int = 100) async throws -> [GuildMember] {
        let wrap: MembersWrap = try await send("GET", "/guilds/\(guildId)/members?limit=\(limit)")
        return wrap.members
    }

    func createGuildChannel(guildId: String, type: String, name: String,
                            parentId: String?, topic: String?, linkUrl: String?) async throws -> Channel {
        var body: [String: Any] = ["type": type, "name": name]
        if let p = parentId { body["parentId"] = p }
        if let t = topic { body["topic"] = t }
        if let l = linkUrl { body["linkUrl"] = l }
        let data = try JSONSerialization.data(withJSONObject: body)
        let wrap: ChannelWrap = try await send("POST", "/guilds/\(guildId)/channels", bodyData: data)
        return wrap.channel
    }
    func patchChannel(channelId: String, patch: [String: Any]) async throws -> Channel {
        let data = try JSONSerialization.data(withJSONObject: patch)
        let wrap: ChannelWrap = try await send("PATCH", "/channels/\(channelId)", bodyData: data)
        return wrap.channel
    }
    func deleteChannel(channelId: String) async throws {
        try await sendVoid("DELETE", "/channels/\(channelId)")
    }

    struct PurgeResult: Decodable { let deleted: Int; let done: Bool }
    /// Soft-delete a batch of the channel's messages (server caps each call to
    /// 1000 rows; loop until `done`). MANAGE_MESSAGES-gated server-side.
    func purgeChannel(channelId: String) async throws -> PurgeResult {
        return try await send("POST", "/channels/\(channelId)/messages/purge")
    }

    // ── Roles ───────────────────────────────────────────────────────────────
    func listRoles(guildId: String) async throws -> [Role] {
        let wrap: RolesWrap = try await send("GET", "/guilds/\(guildId)/roles")
        return wrap.roles
    }
    func createRole(guildId: String, name: String, color: Int, hoist: Bool, mentionable: Bool, permissions: String) async throws -> Role {
        let body: [String: Any] = ["name": name, "color": color, "hoist": hoist, "mentionable": mentionable, "permissions": permissions]
        let data = try JSONSerialization.data(withJSONObject: body)
        let wrap: RoleWrap = try await send("POST", "/guilds/\(guildId)/roles", bodyData: data)
        return wrap.role
    }
    func patchRole(guildId: String, roleId: String, patch: [String: Any]) async throws -> Role {
        let data = try JSONSerialization.data(withJSONObject: patch)
        let wrap: RoleWrap = try await send("PATCH", "/guilds/\(guildId)/roles/\(roleId)", bodyData: data)
        return wrap.role
    }
    func deleteRole(guildId: String, roleId: String) async throws {
        try await sendVoid("DELETE", "/guilds/\(guildId)/roles/\(roleId)")
    }
    func patchMemberRoles(guildId: String, userId: String, roleIds: [String]) async throws -> GuildMember {
        let body: [String: Any] = ["roleIds": roleIds]
        let data = try JSONSerialization.data(withJSONObject: body)
        let wrap: MemberWrap = try await send("PATCH", "/guilds/\(guildId)/members/\(userId)", bodyData: data)
        return wrap.member
    }

    func kickMember(guildId: String, userId: String) async throws {
        try await sendVoid("DELETE", "/guilds/\(guildId)/members/\(userId)")
    }

    func banMember(guildId: String, userId: String, reason: String? = nil) async throws {
        let body: [String: Any] = ["reason": reason ?? NSNull()]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("PUT", "/guilds/\(guildId)/bans/\(userId)", bodyData: data)
    }

    /// Time a member out until the given ISO timestamp, or pass nil to clear.
    func timeoutMember(guildId: String, userId: String, until: String?) async throws -> GuildMember {
        let body: [String: Any] = ["communicationDisabledUntil": until ?? NSNull()]
        let data = try JSONSerialization.data(withJSONObject: body)
        let wrap: MemberWrap = try await send("PATCH", "/guilds/\(guildId)/members/\(userId)", bodyData: data)
        return wrap.member
    }

    // ── Guild settings ────────────────────────────────────────────────────────
    func reorderChannels(guildId: String, channels: [[String: Any]]) async throws {
        let body: [String: Any] = ["channels": channels]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("PATCH", "/guilds/\(guildId)/channels/positions", bodyData: data)
    }

    // ── Guild folders ─────────────────────────────────────────────────────────
    func updateGuildFolders(_ folders: [GuildFolder]) async throws -> [GuildFolder] {
        let body = ["folders": folders]
        let data = try JSONEncoder().encode(body)
        let wrap: GuildFoldersWrap = try await send("PATCH", "/users/@me/guild-folders", bodyData: data)
        return wrap.folders
    }

    // ── Onboarding ────────────────────────────────────────────────────────────
    func acknowledgeOnboarding(guildId: String) async throws {
        try await sendVoid("POST", "/guilds/\(guildId)/onboarding/acknowledge")
    }

    // ── DM settings (disappearing-messages timer + close) ──────────────────────
    func getDmSettings(channelId: String) async throws -> DmSettings {
        try await send("GET", "/users/@me/channels/\(channelId)/settings")
    }
    /// Set the DM's disappearing-messages timer for NEW messages: seconds
    /// (1...2419200 when the settings carry maxTtlSeconds, else 10...86400) or
    /// nil for off. The key predates the Signal-style timer and stays for
    /// installed apps; the server ignores a repeat of the current value.
    func updateDmSettings(channelId: String, ttlSecondsAfterRead: Int?) async throws {
        let body: [String: Any] = ["ttlSecondsAfterRead": ttlSecondsAfterRead ?? NSNull()]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("PATCH", "/users/@me/channels/\(channelId)/settings", bodyData: data)
    }
    /// Set this user's notification-preview choice for a DM (private). nil
    /// reverts to the default.
    func setDmNotificationPreview(channelId: String, showContent: Bool?) async throws {
        let body: [String: Any] = ["showContent": showContent ?? NSNull()]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("PATCH", "/users/@me/channels/\(channelId)/notification-preview", bodyData: data)
    }
    func closeDM(channelId: String) async throws {
        try await sendVoid("DELETE", "/users/@me/channels/\(channelId)")
    }

    // ── Zekk Pet (1:1 DMs; servers with READY features.zekk_pet) ──────────────
    /// The DM's pet (nil when none) and whether either person may invite.
    func getDmPet(channelId: String) async throws -> DmPetState {
        try await send("GET", "/users/@me/channels/\(channelId)/pet")
    }
    /// Invite the other person to adopt a pet. 409 when the DM isn't eligible
    /// (streak under 3 days or broken) or a pet / invite already exists.
    /// `color` is the egg the inviter picked (a ZekkPetPalette colour id;
    /// servers with READY features.zekk_pet_color, others ignore it). Only
    /// then is there a JSON body: without one the POST has no body and no
    /// Content-Type, exactly as before, and the server gives the pet its
    /// DM's colour.
    func inviteDmPet(channelId: String, color: String?) async throws -> PetDTO? {
        let path = "/users/@me/channels/\(channelId)/pet/invite"
        let wrap: PetWrap
        if let color {
            let data = try JSONSerialization.data(withJSONObject: ["color": color])
            wrap = try await send("POST", path, bodyData: data)
        } else {
            wrap = try await send("POST", path)
        }
        return wrap.pet
    }
    /// Accept the other person's invite; the egg appears. Invitee only.
    func acceptDmPet(channelId: String) async throws -> PetDTO? {
        let wrap: PetWrap = try await send("POST", "/users/@me/channels/\(channelId)/pet/accept")
        return wrap.pet
    }
    /// Decline the invite (invitee) or cancel it (inviter).
    func declineDmPet(channelId: String) async throws {
        try await sendVoid("POST", "/users/@me/channels/\(channelId)/pet/decline")
    }
    /// Rename the pet (1–24 characters after trimming). Posts a notice.
    func renameDmPet(channelId: String, name: String) async throws -> PetDTO? {
        let data = try JSONSerialization.data(withJSONObject: ["name": name])
        let wrap: PetWrap = try await send("PATCH", "/users/@me/channels/\(channelId)/pet", bodyData: data)
        return wrap.pet
    }

    func patchGuild(guildId: String, patch: [String: Any]) async throws -> Guild {
        let data = try JSONSerialization.data(withJSONObject: patch)
        let wrap: GuildWrap = try await send("PATCH", "/guilds/\(guildId)", bodyData: data)
        return wrap.guild
    }
    func deleteGuild(guildId: String) async throws {
        try await sendVoid("DELETE", "/guilds/\(guildId)")
    }
    func leaveGuild(guildId: String) async throws {
        try await sendVoid("POST", "/guilds/\(guildId)/leave")
    }
    func createInvite(channelId: String, maxUses: Int?, ttlSeconds: Int?) async throws -> Invite {
        var body: [String: Any] = [:]
        body["maxUses"] = maxUses ?? NSNull()
        body["ttlSeconds"] = ttlSeconds ?? NSNull()
        let data = try JSONSerialization.data(withJSONObject: body)
        let wrap: InviteWrap = try await send("POST", "/channels/\(channelId)/invites", bodyData: data)
        return wrap.invite
    }
    /// All invites for a guild (requires MANAGE_INVITES); includes expired/spent
    /// rows so the manager can see + clean them up.
    func listGuildInvites(guildId: String) async throws -> [Invite] {
        let wrap: InvitesWrap = try await send("GET", "/guilds/\(guildId)/invites")
        return wrap.invites
    }
    /// Revoke (hard-delete) an invite by code; the code stops working at once.
    func revokeInvite(code: String) async throws {
        try await sendVoid("DELETE", "/invites/\(code)")
    }

    func changePassword(currentPassword: String, newPassword: String) async throws {
        let body: [String: Any] = ["currentPassword": currentPassword, "newPassword": newPassword]
        let data = try JSONSerialization.data(withJSONObject: body)
        try await sendVoid("POST", "/users/@me/password", bodyData: data)
    }

    // ── Admin observe + parental oversight ───────────────────────────────────
    /// Ghost-mode guild snapshot: the guild row + EVERY channel (no
    /// permission filtering) so an operator can review without joining.
    /// [ADMIN ONLY] Who this user exchanges 1:1 DMs with, whether they're friends,
    /// and how many messages each conversation holds. Never message content.
    /// Moderators cannot reach this — the admin router's moderator allowlist is
    /// fail-safe and this route is deliberately absent from it.
    func adminUserDmPeers(userId: String) async throws -> AdminDmPeersWrap {
        return try await send("GET", "/admin/users/\(userId)/dm-peers")
    }
    func adminPeekGuild(guildId: String) async throws -> PeekGuildResult {
        return try await send("GET", "/admin/guilds/\(guildId)/peek")
    }
    /// Read-only message page for an observed channel.
    func adminPeekMessages(channelId: String, before: String? = nil) async throws -> [PeekMessage] {
        var path = "/admin/channels/\(channelId)/peek/messages?limit=50"
        if let before { path += "&before=\(before)" }
        let wrap: PeekMessagesWrap = try await send("GET", path)
        return wrap.messages
    }

    /// The supervised child's servers, with per-guild block state.
    func familyChildGuilds(childId: String) async throws -> [ChildGuild] {
        let wrap: ChildGuildsWrap = try await send("GET", "/family/children/\(childId)/guilds")
        return wrap.guilds
    }
    func familySetGuildBlocked(childId: String, guildId: String, blocked: Bool) async throws {
        if blocked {
            let body = try JSONSerialization.data(withJSONObject: ["guildId": guildId])
            try await sendVoid("POST", "/family/children/\(childId)/blocked-guilds", bodyData: body)
        } else {
            try await sendVoid("DELETE", "/family/children/\(childId)/blocked-guilds/\(guildId)")
        }
    }
    /// The child's relationships (friends, requests, blocks).
    func familyChildFriends(childId: String) async throws -> [ChildRelationship] {
        let wrap: ChildRelationshipsWrap = try await send("GET", "/family/children/\(childId)/friends")
        return wrap.relationships
    }
    /// Block / unblock a user on the child's behalf (severs friendship,
    /// prevents DMs and calls both ways).
    func familySetUserBlocked(childId: String, userId: String, blocked: Bool) async throws {
        if blocked {
            let body = try JSONSerialization.data(withJSONObject: ["userId": userId])
            try await sendVoid("POST", "/family/children/\(childId)/blocked-users", bodyData: body)
        } else {
            try await sendVoid("DELETE", "/family/children/\(childId)/blocked-users/\(userId)")
        }
    }

    /// The child's 1:1 DM conversations.
    func familyChildDMs(childId: String) async throws -> [ChildDM] {
        let wrap: ChildDMsWrap = try await send("GET", "/family/children/\(childId)/channels")
        return wrap.channels
    }
    /// A supervised DM's messages (includes child-deleted ones, labelled).
    func familyChildDMMessages(childId: String, channelId: String, before: String? = nil) async throws -> [PeekMessage] {
        var path = "/family/children/\(childId)/channels/\(channelId)/messages?limit=50"
        if let before { path += "&before=\(before)" }
        let wrap: PeekMessagesWrap = try await send("GET", path)
        return wrap.messages
    }

    // ── Watch words + flagged messages (parent) — same endpoints as web ──────

    /// The child's watch words (GET /family/children/:id/watch-words).
    func familyWatchWords(childId: String) async throws -> [String] {
        let wrap: WatchWordsWrap = try await send("GET", "/family/children/\(childId)/watch-words")
        return wrap.words
    }
    /// Add a word (or a comma-separated list — the server splits/normalizes).
    /// Returns the updated full list.
    func familyAddWatchWord(childId: String, word: String) async throws -> [String] {
        let body = try JSONEncoder().encode(["word": word])
        let wrap: WatchWordsWrap = try await send("POST", "/family/children/\(childId)/watch-words", bodyData: body)
        return wrap.words
    }
    /// Remove one word (DELETE …/watch-words?word=). Returns the updated list.
    func familyRemoveWatchWord(childId: String, word: String) async throws -> [String] {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&+=?/")
        let q = word.addingPercentEncoding(withAllowedCharacters: allowed) ?? word
        let wrap: WatchWordsWrap = try await send("DELETE", "/family/children/\(childId)/watch-words?word=\(q)")
        return wrap.words
    }
    /// Flagged messages for a child (GET /family/children/:id/flags).
    func familyChildFlags(childId: String) async throws -> [FamilyFlag] {
        let wrap: FamilyFlagsWrap = try await send("GET", "/family/children/\(childId)/flags")
        return wrap.flags
    }
    /// Mark one flag reviewed (POST /family/flags/:id/reviewed).
    func familyMarkFlagReviewed(id: String) async throws {
        try await sendVoid("POST", "/family/flags/\(id)/reviewed")
    }

    // ── Security (Admin → Security) ──────────────────────────────────────────
    func adminSecurityEvents(kind: String? = nil, before: String? = nil) async throws -> [SecurityEvent] {
        var path = "/admin/security/events?limit=50"
        if let kind { path += "&kind=\(kind)" }
        if let before { path += "&before=\(before)" }
        let wrap: SecurityEventsWrap = try await send("GET", path)
        return wrap.events
    }
    func adminSecurityWords() async throws -> [SecurityWord] {
        let wrap: SecurityWordsWrap = try await send("GET", "/admin/security/words")
        return wrap.words
    }

    /// Guild audit log (read-only). Gated server-side on VIEW_AUDIT_LOG. Keyset
    /// pagination via `before` (an entry id; newest-first). `actionPrefix`
    /// filters by action-name prefix ("member", "role.update"); `actorId`
    /// filters to a single moderator. The prefix + ids are lower/dot/digit
    /// only, so they're query-safe without extra escaping.
    func auditLog(guildId: String, before: String? = nil,
                  actionPrefix: String? = nil, actorId: String? = nil) async throws -> [AuditEntry] {
        var path = "/guilds/\(guildId)/audit-log?limit=50"
        if let before { path += "&before=\(before)" }
        if let actionPrefix, !actionPrefix.isEmpty { path += "&actionPrefix=\(actionPrefix)" }
        if let actorId { path += "&actorId=\(actorId)" }
        let wrap: AuditLogWrap = try await send("GET", path)
        return wrap.entries
    }

    /// File a report against a user (or message) in a guild. Any guild member
    /// may report; the server dedups an existing open report by the same
    /// reporter against the same target. Returns the (new or existing) id.
    @discardableResult
    func createReport(guildId: String, targetType: String, targetUserId: String? = nil,
                      messageId: String? = nil, reason: String, details: String? = nil) async throws -> String {
        var obj: [String: Any] = ["targetType": targetType, "reason": reason]
        if let targetUserId { obj["targetUserId"] = targetUserId }
        if let messageId { obj["messageId"] = messageId }
        if let details, !details.isEmpty { obj["details"] = details }
        let body = try JSONSerialization.data(withJSONObject: obj)
        let ack: CreateReportAck = try await send("POST", "/guilds/\(guildId)/reports", bodyData: body)
        return ack.reportId
    }

    /// Moderation queue for a guild (gated server-side on the mod permissions).
    /// Returns the reports plus the current open count. Filter by status
    /// (default "open") and/or target type; keyset-paginate with `before`.
    /// Status/type/ids are enum/digit values, so they're query-safe as-is.
    func listReports(guildId: String, status: String = "open",
                     targetType: String? = nil, before: String? = nil) async throws -> ReportsWrap {
        var path = "/guilds/\(guildId)/reports?status=\(status)&limit=50"
        if let targetType { path += "&targetType=\(targetType)" }
        if let before { path += "&before=\(before)" }
        return try await send("GET", path)
    }

    /// Resolve or dismiss a report, optionally taking a moderation action on the
    /// reported entity in the same step: "ban" (needs BAN_MEMBERS) or
    /// "delete_message" (needs MANAGE_MESSAGES). Returns the updated report.
    func handleReport(guildId: String, reportId: String, action: String,
                      note: String? = nil, moderation: String = "none") async throws -> Report {
        var obj: [String: Any] = ["action": action, "moderation": moderation]
        if let note { obj["note"] = note }
        let body = try JSONSerialization.data(withJSONObject: obj)
        let wrap: ReportWrap = try await send("PATCH", "/guilds/\(guildId)/reports/\(reportId)", bodyData: body)
        return wrap.report
    }

    /// Add (or move) a word. severity 'blocked' = hard block; 'watch' = alert
    /// only. Defaults to 'blocked' (back-compat).
    func adminAddSecurityWord(_ word: String, severity: String = "blocked") async throws -> [SecurityWord] {
        let body = try JSONSerialization.data(withJSONObject: ["word": word, "severity": severity])
        let wrap: SecurityWordsWrap = try await send("POST", "/admin/security/words", bodyData: body)
        return wrap.words
    }
    func adminRemoveSecurityWord(_ word: String) async throws -> [SecurityWord] {
        let enc = word.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? word
        let wrap: SecurityWordsWrap = try await send("DELETE", "/admin/security/words/\(enc)")
        return wrap.words
    }
    /// The server's common moderation wordlist (read-only; nothing added).
    func adminSecurityWordPreset() async throws -> [String] {
        let wrap: SecurityPresetWrap = try await send("GET", "/admin/security/words/preset")
        return wrap.words
    }
    /// Bulk-load the server's common moderation wordlist (insert-only; slurs
    /// file as blocked, general profanity as watch).
    func adminLoadSecurityWordPreset() async throws -> [SecurityWord] {
        let wrap: SecurityWordsWrap = try await send("POST", "/admin/security/words/preset")
        return wrap.words
    }
    func adminSecurityConfig() async throws -> SecurityConfig {
        let wrap: SecurityConfigWrap = try await send("GET", "/admin/security/config")
        return wrap.config
    }
    func adminPatchSecurityConfig(_ patch: [String: Any]) async throws -> SecurityConfig {
        let body = try JSONSerialization.data(withJSONObject: patch)
        let wrap: SecurityConfigWrap = try await send("PATCH", "/admin/security/config", bodyData: body)
        return wrap.config
    }

    // ── Perks (instance-wide, any authed user) ───────────────────────────────
    /// Admin-configured perk gates: camera/stream quality tier minimums and
    /// upload caps. 404s on older servers — callers treat any failure as
    /// "use built-in defaults".
    func monetization() async throws -> MonetizationConfig {
        let wrap: MonetizationConfigWrap = try await send("GET", "/instance/monetization")
        return wrap.config
    }

    /// Admin write side of perk gates (PUT /admin/monetization). Sends the
    /// whole config (explicit null for a cleared upload cap = "use the env
    /// default"), matching the web admin panel; server does a partial write.
    func adminUpdateMonetization(_ c: MonetizationConfig) async throws -> MonetizationConfig {
        func cap(_ v: Int?) -> Any { v ?? NSNull() }
        var stream: [String: Any] = ["p1080": c.stream.p1080, "k2": c.stream.k2, "k4": c.stream.k4]
        if let fps60 = c.stream.fps60 { stream["fps60"] = fps60 }
        let body = try JSONSerialization.data(withJSONObject: [
            "config": [
                "stream": stream,
                "camera": ["p1080": c.camera.p1080, "k2": c.camera.k2, "k4": c.camera.k4],
                "uploadCapsMb": [
                    "free": cap(c.uploadCapsMb.free),
                    "scout": cap(c.uploadCapsMb.scout),
                    "guardian": cap(c.uploadCapsMb.guardian),
                    "legend": cap(c.uploadCapsMb.legend),
                ],
            ],
        ])
        let wrap: MonetizationConfigWrap = try await send("PUT", "/admin/monetization", bodyData: body)
        return wrap.config
    }

    /// Admin Overview recent-activity feed (GET /admin/activity).
    func adminActivity() async throws -> AdminActivity {
        let wrap: AdminActivityWrap = try await send("GET", "/admin/activity")
        return wrap.activity
    }

    // ── Achievements ─────────────────────────────────────────────────────────
    func myAchievements() async throws -> AchievementsWrap {
        return try await send("GET", "/users/@me/achievements")
    }
    func userAchievements(userId: String) async throws -> [Achievement] {
        let wrap: AchievementsWrap = try await send("GET", "/users/\(userId)/achievements")
        return wrap.achievements
    }

    // ── Admin (instance) ──────────────────────────────────────────────────────
    func adminListUsers(q: String?, bannedOnly: Bool) async throws -> [AdminUser] {
        // The server's query validator caps limit at 50 (zod max(50)) and
        // REJECTS requests above it — limit=100 made the whole admin user
        // list 400 and fail to load.
        var path = "/admin/users?limit=50"
        if let q = q, !q.isEmpty {
            let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
            path += "&q=\(enc)"
        }
        if bannedOnly { path += "&bannedOnly=true" }
        let wrap: AdminUsersWrap = try await send("GET", path)
        return wrap.users
    }
    /// Ban an account for a duration ("1m"|"3m"|"6m"|"perm"). Covers text + voice.
    func adminBanUser(userId: String, duration: String = "perm") async throws {
        let data = try JSONSerialization.data(withJSONObject: ["duration": duration])
        try await sendVoid("POST", "/admin/users/\(userId)/ban", bodyData: data)
    }
    func adminUnbanUser(userId: String) async throws { try await sendVoid("POST", "/admin/users/\(userId)/unban") }
    /// Set a user's instance role ("administrator" | "moderator" | "none").
    /// The two flags are mutually exclusive server-side. Admin-only.
    func adminSetRole(userId: String, role: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["role": role])
        try await sendVoid("POST", "/admin/users/\(userId)/role", bodyData: data)
    }
    func adminLogoutUser(userId: String) async throws { try await sendVoid("POST", "/admin/users/\(userId)/logout") }
    /// Reopen a user's one-time date-of-birth change.
    func adminResetDobLock(userId: String) async throws {
        try await sendVoid("POST", "/admin/users/\(userId)/reset-dob-lock")
    }
    /// Give (or re-give, overwriting) a perk tier.
    func adminGiftSubscription(userId: String, tier: String, duration: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["tier": tier, "duration": duration])
        try await sendVoid("POST", "/admin/users/\(userId)/subscription", bodyData: data)
    }
    /// Remove a user's perk tier. Cosmetics are free, so nothing else changes.
    func adminRemoveSubscription(userId: String) async throws {
        try await sendVoid("DELETE", "/admin/users/\(userId)/subscription")
    }
    /// Permanently delete a user account (hard delete). Throws on non-2xx —
    /// e.g. the server refuses when the user still owns active guilds.
    func adminDeleteUser(userId: String) async throws { try await sendVoid("DELETE", "/admin/users/\(userId)") }

    // ── Admin → Account Info ──────────────────────────────────────────────────
    // Admin-only unless noted; moderators get mute/unmute + notes (server-enforced).
    /// [ADMIN] The full account record.
    func adminGetAccount(userId: String) async throws -> AdminAccount {
        let w: AdminAccountWrap = try await send("GET", "/admin/users/\(userId)")
        return w.account
    }
    /// [ADMIN] Friends, requests, blocks and 1:1 DM partners. Audited server-side.
    func adminGetAccountContacts(userId: String) async throws -> AdminAccountContacts {
        try await send("GET", "/admin/users/\(userId)/contacts")
    }
    /// [ADMIN] Rename (doesn't use up the owner's own 90-day allowance).
    func adminSetUsername(userId: String, username: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["username": username])
        try await sendVoid("PATCH", "/admin/users/\(userId)/username", bodyData: data)
    }
    /// [ADMIN] Change email — marked verified; the old address is notified.
    func adminSetEmail(userId: String, email: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["email": email])
        try await sendVoid("PATCH", "/admin/users/\(userId)/email", bodyData: data)
    }
    /// [ADMIN] Set date of birth (YYYY-MM-DD, 13+). Re-locks it.
    func adminSetDateOfBirth(userId: String, dateOfBirth: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["dateOfBirth": dateOfBirth])
        try await sendVoid("PATCH", "/admin/users/\(userId)/date-of-birth", bodyData: data)
    }
    /// [ADMIN] Email the owner a reset link and sign them out everywhere.
    func adminSendPasswordReset(userId: String) async throws {
        try await sendVoid("POST", "/admin/users/\(userId)/password-reset")
    }
    /// [ADMIN + MOD] Mute ("1h"|"1d"|"1w"|"perm"): can read, can't post or talk.
    func adminMuteUser(userId: String, duration: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["duration": duration])
        try await sendVoid("POST", "/admin/users/\(userId)/mute", bodyData: data)
    }
    /// [ADMIN + MOD] Lift a mute.
    func adminUnmuteUser(userId: String) async throws {
        try await sendVoid("POST", "/admin/users/\(userId)/unmute")
    }
    /// [ADMIN + MOD] Staff notes, newest first.
    func adminListNotes(userId: String) async throws -> [StaffNote] {
        let w: StaffNotesWrap = try await send("GET", "/admin/users/\(userId)/notes")
        return w.notes
    }
    /// [ADMIN + MOD] Add a note (1–2000 chars).
    func adminAddNote(userId: String, body: String) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["body": body])
        try await sendVoid("POST", "/admin/users/\(userId)/notes", bodyData: data)
    }
    /// [ADMIN + MOD] Delete a note — moderators only their own.
    func adminDeleteNote(userId: String, noteId: String) async throws {
        try await sendVoid("DELETE", "/admin/users/\(userId)/notes/\(noteId)")
    }

    func adminListGuilds(q: String?) async throws -> [AdminGuild] {
        var path = "/admin/guilds?limit=100"
        if let q = q, !q.isEmpty {
            let enc = q.addingPercentEncoding(withAllowedCharacters: .urlQueryAllowed) ?? q
            path += "&q=\(enc)"
        }
        let wrap: AdminGuildsWrap = try await send("GET", path)
        return wrap.guilds
    }
    func adminDeleteGuild(guildId: String) async throws { try await sendVoid("DELETE", "/admin/guilds/\(guildId)") }
    func adminStorage() async throws -> AdminStorage {
        let wrap: AdminStorageWrap = try await send("GET", "/admin/storage")
        return wrap.storage
    }
    func adminStorageGc() async throws -> StorageGcResult {
        return try await send("POST", "/admin/storage/gc")
    }
    func adminStorageItems(page: Int, sort: String) async throws -> StorageListing {
        return try await send("GET", "/admin/storage/items?page=\(page)&sort=\(sort)")
    }
    func adminDeleteStorageItem(id: String) async throws {
        try await sendVoid("DELETE", "/admin/storage/items/\(id)")
    }
    func adminCompressStorageItem(id: String) async throws {
        try await sendVoid("POST", "/admin/storage/items/\(id)/compress")
    }
}
