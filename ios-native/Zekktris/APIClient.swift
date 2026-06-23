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

/// One file part for a multipart message send.
struct UploadFile {
    let data: Data
    let filename: String
    let contentType: String
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
    static let tokenRefreshedNotification = Notification.Name("zk.accessTokenRefreshed")

    private let session = URLSession(configuration: .default)
    private let decoder = JSONDecoder()

    /// In-flight refresh, shared so concurrent 401s trigger ONE /auth/refresh
    /// (the server rotates the cookie per call — parallel refreshes with the
    /// same cookie would 401 each other). Guarded by `refreshLock`: APIClient
    /// is a plain class whose async methods run on the concurrent executor,
    /// so the check-then-store below MUST be atomic. Without the lock, the
    /// cold-start burst (getMe + loadGuilds/loadDMs/loadReadStates all 401 at
    /// once) could launch TWO refreshes; the loser's rotation wiped the fresh
    /// cookie → every later refresh failed → spurious force-logout.
    private var refreshTask: Task<Bool, Never>?
    private let refreshLock = NSLock()

    /// Exchange the refresh cookie (stored by URLSession from login's
    /// Set-Cookie) for a fresh access token. Returns false when the cookie
    /// is missing/expired/revoked — i.e. the user genuinely must sign in.
    func refreshAccessToken() async -> Bool {
        // Atomically claim or join the single in-flight refresh. The lock is
        // confined to a synchronous closure (no `await` inside) so it never
        // spans a suspension point — required under Swift 6 strict
        // concurrency, where holding NSLock across an await is a hard error.
        let work: Task<Bool, Never> = refreshLock.withLock {
            if let inFlight = refreshTask { return inFlight }
            let task = Task<Bool, Never> { [session, decoder] in
                struct RefreshResponse: Decodable { let accessToken: String }
                guard let url = URL(string: Config.apiBaseURL + "/auth/refresh") else { return false }
                var req = URLRequest(url: url)
                req.httpMethod = "POST"
                req.setValue("application/json", forHTTPHeaderField: "Accept")
                guard let (data, resp) = try? await session.data(for: req),
                      let http = resp as? HTTPURLResponse,
                      (200..<300).contains(http.statusCode),
                      let decoded = try? decoder.decode(RefreshResponse.self, from: data)
                else { return false }
                self.token = decoded.accessToken
                self.onTokenRefresh?(decoded.accessToken)
                NotificationCenter.default.post(
                    name: APIClient.tokenRefreshedNotification, object: decoded.accessToken)
                return true
            }
            refreshTask = task
            return task
        }
        let ok = await work.value
        // Clear only if this is still the in-flight task — a newer refresh may
        // have already replaced it, and a late joiner must not wipe it.
        refreshLock.withLock {
            if let current = refreshTask, current == work { refreshTask = nil }
        }
        return ok
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
        isRetry: Bool = false
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

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else {
            throw APIError(status: 0, message: "No HTTP response")
        }
        // Access tokens are short-lived (15 min): a 401 usually just means
        // "expired" — refresh via the cookie and replay the request once.
        if http.statusCode == 401, canRetryAfterRefresh(path, authorized: authorized, isRetry: isRetry),
           await refreshAccessToken() {
            return try await send(method, path, bodyData: bodyData, authorized: authorized, isRetry: true)
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
        do {
            return try decoder.decode(T.self, from: data)
        } catch {
            throw APIError(status: http.statusCode, message: "Could not read response: \(error)")
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
    /// logout just deleted).
    private func sendNoDecode(_ method: String, _ path: String, authorized: Bool = true, isRetry: Bool = false, bearerOverride: String? = nil) async -> Bool {
        guard let url = URL(string: Config.apiBaseURL + path) else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let bearer = bearerOverride ?? token
        if authorized, let bearer { req.setValue("Bearer \(bearer)", forHTTPHeaderField: "Authorization") }
        guard let (_, resp) = try? await session.data(for: req),
              let http = resp as? HTTPURLResponse else { return false }
        if bearerOverride == nil, http.statusCode == 401,
           canRetryAfterRefresh(path, authorized: authorized, isRetry: isRetry),
           await refreshAccessToken() {
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
           await refreshAccessToken() {
            return try await sendVoid(method, path, bodyData: bodyData, authorized: authorized, isRetry: true)
        }
        guard (200..<300).contains(http.statusCode) else {
            throw APIError(status: http.statusCode, message: Self.extractError(data) ?? "Request failed (\(http.statusCode))")
        }
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

    func forgotPassword(email: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["email": email])
        try await sendVoid("POST", "/auth/forgot-password", bodyData: body, authorized: false)
    }

    func resetPassword(token: String, newPassword: String) async throws {
        let body = try JSONSerialization.data(withJSONObject: ["token": token, "newPassword": newPassword])
        try await sendVoid("POST", "/auth/reset-password", bodyData: body, authorized: false)
    }

    func register(email: String, username: String, displayName: String, password: String) async throws -> AuthSession {
        let body = try JSONEncoder().encode(
            RegisterBody(email: email, username: username, displayName: displayName, password: password)
        )
        return try await send("POST", "/auth/register", bodyData: body, authorized: false)
    }

    func logout(bearer: String? = nil) async {
        await sendNoDecode("POST", "/auth/logout", bearerOverride: bearer)
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
        let wrap: MessagesWrap = try await send("GET", path)
        return wrap.messages
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
    func unfurl(url: String) async throws -> MessageEmbed? {
        // Percent-encode the URL as a query VALUE — keep its own &/=/?/+/#
        // from being read as query structure.
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=?+#")
        let q = url.addingPercentEncoding(withAllowedCharacters: allowed) ?? url
        let wrap: UnfurlWrap = try await send("GET", "/unfurl?url=\(q)")
        return wrap.embed
    }

    func sendMessage(channelId: String, content: String, nonce: String, replyToId: String? = nil, forwardFromMessageId: String? = nil, stickerId: String? = nil) async throws -> Message {
        var body: [String: Any] = ["content": content, "nonce": nonce]
        if let rid = replyToId { body["replyToId"] = rid }
        if let fid = forwardFromMessageId { body["forwardFromMessageId"] = fid }
        if let sid = stickerId { body["stickerId"] = sid }
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

    // ── Generic multipart upload (name/description + single file) ──────────────
    private func uploadMultipart<T: Decodable>(
        _ path: String, fields: [String: String], fileField: String,
        filename: String, contentType: String, fileData: Data, _ type: T.Type,
        isRetry: Bool = false
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
        append("Content-Disposition: form-data; name=\"\(fileField)\"; filename=\"\(filename)\"\r\n")
        append("Content-Type: \(contentType)\r\n\r\n")
        body.append(fileData)
        append("\r\n")
        append("--\(boundary)--\r\n")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = body

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError(status: 0, message: "No HTTP response") }
        if http.statusCode == 401, canRetryAfterRefresh(path, authorized: true, isRetry: isRetry),
           await refreshAccessToken() {
            return try await uploadMultipart(path, fields: fields, fileField: fileField,
                                             filename: filename, contentType: contentType,
                                             fileData: fileData, type, isRetry: true)
        }
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

    /// Enable shared-key E2EE on a DM. salt + verifier are derived client-side;
    /// the server never sees the password or key.
    func enableDmE2EE(channelId: String, salt: String, verifier: String) async throws {
        let body = try JSONEncoder().encode(E2EEEnableBody(salt: salt, verifier: verifier))
        let _: OkWrap = try await send("PUT", "/users/@me/channels/\(channelId)/e2ee-enable", bodyData: body)
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
    /// requires the `verifier` derived from the local key as proof we know
    /// the passphrase — without it (or with a wrong one) it returns 403 and
    /// does NOT purge. Throws on failure so the caller can surface it.
    func disableDmE2EE(channelId: String, verifier: String) async throws {
        let body = try JSONEncoder().encode(E2EEDisableBody(verifier: verifier))
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
        guard let url = URL(string: Config.apiBaseURL + "/channels/\(channelId)/messages") else {
            throw APIError(status: 0, message: "Bad URL")
        }
        let boundary = "ZkBoundary-\(UUID().uuidString)"
        var payload: [String: Any] = ["content": content, "nonce": nonce]
        if let rid = replyToId { payload["replyToId"] = rid } else { payload["replyToId"] = NSNull() }
        if let vm = voiceMessage { payload["voiceMessage"] = vm }
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
            append("Content-Disposition: form-data; name=\"files[\(i)]\"; filename=\"\(file.filename)\"\r\n")
            append("Content-Type: \(file.contentType)\r\n\r\n")
            body.append(file.data)
            append("\r\n")
        }
        append("--\(boundary)--\r\n")

        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("multipart/form-data; boundary=\(boundary)", forHTTPHeaderField: "Content-Type")
        if let token { req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization") }
        req.httpBody = body

        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse else { throw APIError(status: 0, message: "No HTTP response") }
        if http.statusCode == 401, await refreshAccessToken(), let fresh = token {
            // One replay with the rotated token (mirrors send()'s retry).
            req.setValue("Bearer \(fresh)", forHTTPHeaderField: "Authorization")
            let (data2, resp2) = try await session.data(for: req)
            guard let http2 = resp2 as? HTTPURLResponse, (200..<300).contains(http2.statusCode) else {
                let code = (resp2 as? HTTPURLResponse)?.statusCode ?? 0
                throw APIError(status: code, message: Self.extractError(data2) ?? "Upload failed (\(code))")
            }
            let wrap2: MessageWrap = try decoder.decode(MessageWrap.self, from: data2)
            return wrap2.message
        }
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
    func unregisterDeviceToken(token: String, bearer: String? = nil) async {
        let encoded = token.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? token
        await sendNoDecode("DELETE", "/users/@me/device-tokens/\(encoded)", bearerOverride: bearer)
    }

    // ── Profile ───────────────────────────────────────────────────────────
    /// Patch the current user (displayName / status / customStatus / …).
    func updateProfile(_ patch: [String: Any]) async throws -> SelfUser {
        let data = try JSONSerialization.data(withJSONObject: patch)
        let wrap: UserWrap = try await send("PATCH", "/users/@me", bodyData: data)
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
    /// (POST /users/@me/totp/confirm).
    func confirmTwoFactor(code: String) async throws -> TwoFactorRecovery {
        let body = try JSONEncoder().encode(["code": code])
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

    /// End-to-end LiveKit/voice diagnostic (keys, browser URL, token mint, SFU
    /// reachability + auth). Instance-admin gated; hits the network, so run on
    /// demand. No secrets are returned.
    func adminVoiceDiagnostic() async throws -> LivekitDiagnostic {
        let wrap: DiagnosticWrap = try await send("GET", "/admin/voice-diagnostic")
        return wrap.diagnostic
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

    func familyChildRestrictions(childId: String) async throws -> ChildRestrictions {
        let wrap: FamilyRestrictionsWrap = try await send("GET", "/family/children/\(childId)/restrictions")
        return wrap.restrictions
    }

    func familySetRestrictions(childId: String, _ r: ChildRestrictions) async throws -> ChildRestrictions {
        let patch: [String: Bool] = [
            "canAddFriends": r.canAddFriends,
            "canRemoveFriends": r.canRemoveFriends,
            "allowVoice": r.allowVoice,
            "allowVideo": r.allowVideo,
            "allowStream": r.allowStream,
            "allowCreateGuild": r.allowCreateGuild,
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

    // ── DM settings (auto-delete TTL + close) ──────────────────────────────────
    func getDmSettings(channelId: String) async throws -> DmSettings {
        try await send("GET", "/users/@me/channels/\(channelId)/settings")
    }
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
    func adminSecurityWords() async throws -> [String] {
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

    func adminAddSecurityWord(_ word: String) async throws -> [String] {
        let body = try JSONSerialization.data(withJSONObject: ["word": word])
        let wrap: SecurityWordsWrap = try await send("POST", "/admin/security/words", bodyData: body)
        return wrap.words
    }
    func adminRemoveSecurityWord(_ word: String) async throws -> [String] {
        let enc = word.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? word
        let wrap: SecurityWordsWrap = try await send("DELETE", "/admin/security/words/\(enc)")
        return wrap.words
    }
    /// The server's common moderation wordlist (read-only; nothing added).
    func adminSecurityWordPreset() async throws -> [String] {
        let wrap: SecurityWordsWrap = try await send("GET", "/admin/security/words/preset")
        return wrap.words
    }
    /// Bulk-load the server's common moderation wordlist (insert-only).
    func adminLoadSecurityWordPreset() async throws -> [String] {
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
    func adminBanUser(userId: String) async throws { try await sendVoid("POST", "/admin/users/\(userId)/ban") }
    func adminUnbanUser(userId: String) async throws { try await sendVoid("POST", "/admin/users/\(userId)/unban") }
    func adminSetAdmin(userId: String, isAdmin: Bool) async throws {
        let data = try JSONSerialization.data(withJSONObject: ["isAdmin": isAdmin])
        try await sendVoid("POST", "/admin/users/\(userId)/admin", bodyData: data)
    }
    func adminLogoutUser(userId: String) async throws { try await sendVoid("POST", "/admin/users/\(userId)/logout") }
    /// Permanently delete a user account (hard delete). Throws on non-2xx —
    /// e.g. the server refuses when the user still owns active guilds.
    func adminDeleteUser(userId: String) async throws { try await sendVoid("DELETE", "/admin/users/\(userId)") }

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
