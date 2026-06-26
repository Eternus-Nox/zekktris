import Foundation
import SwiftUI
import LocalAuthentication

/// Owns authentication state: the access token (persisted in Keychain), the
/// signed-in user, and the login/register/logout flows. Drives which top-level
/// screen `RootView` shows.
@MainActor
final class Session: ObservableObject {
    enum Phase { case loading, signedOut, signedIn }

    @Published var phase: Phase = .loading
    @Published var currentUser: SelfUser? { didSet { cacheUser(currentUser) } }
    @Published var authError: String?
    @Published var busy = false
    /// True once a login returned `requires2FA` — the password was accepted
    /// but the account has 2FA on. The login view reveals a code field and
    /// resubmits with it. Cleared on a fresh email/password attempt and on
    /// success.
    @Published var needs2FA = false
    /// When true, a signed-in session is gated behind a biometric unlock.
    @Published var locked = false

    private let faceIDKey = "zk.faceID"
    private let userCacheKey = "zk.cachedUser"
    var faceIDEnabled: Bool {
        get { UserDefaults.standard.bool(forKey: faceIDKey) }
        set { UserDefaults.standard.set(newValue, forKey: faceIDKey) }
    }

    /// Persist / restore the signed-in user so a cold launch can show the
    /// session immediately (Face ID gates it) without waiting on the network.
    private func cacheUser(_ user: SelfUser?) {
        if let user, let data = try? JSONEncoder().encode(user) {
            UserDefaults.standard.set(data, forKey: userCacheKey)
        } else {
            UserDefaults.standard.removeObject(forKey: userCacheKey)
        }
    }
    private func cachedUser() -> SelfUser? {
        guard let data = UserDefaults.standard.data(forKey: userCacheKey) else { return nil }
        return try? JSONDecoder().decode(SelfUser.self, from: data)
    }

    private let keychain = KeychainStore()
    private let tokenKey = "accessToken"
    let api = APIClient.shared

    var token: String? { api.token }

    /// Called once at launch. Restores a persisted token and validates it by
    /// fetching the current user; falls back to the sign-in screen on failure.
    func bootstrap() async {
        // Restore the long-lived refresh cookie BEFORE any network call. The
        // cookie jar doesn't survive an app kill, so without this the (expired)
        // access token below can't be renewed and we'd fall back to the login
        // screen — the "doesn't stay logged in" bug.
        RefreshCookieStore.restore()
        // Persist rotated access tokens (the APIClient auto-refreshes expired
        // ones via the /auth/refresh cookie) so the NEXT cold launch starts
        // from the newest token instead of an already-expired one. The refresh
        // also rotates the cookie, so re-snapshot it for the next launch.
        api.onTokenRefresh = { [keychain, tokenKey] newToken in
            keychain.set(newToken, for: tokenKey)
            RefreshCookieStore.capture()
        }
        guard let saved = keychain.get(tokenKey), !saved.isEmpty else {
            phase = .signedOut
            return
        }
        api.token = saved
        // Restore the session immediately from the saved token + cached user so
        // a cold launch goes straight to the Face ID gate — never back to the
        // login form — even if we're offline or the refresh hiccups.
        currentUser = cachedUser()
        // Gate on the saved setting alone — probing biometric availability
        // can block (XPC to the biometric daemon), so it must never run
        // inline here. unlock() resolves availability async and waves the
        // user through if biometrics have since become unavailable.
        locked = faceIDEnabled
        phase = .signedIn
        // Refresh the user in the background. getMe auto-refreshes an expired
        // access token via the refresh cookie, so a 401 here means the
        // refresh token itself is dead (revoked / >30 days) — only then sign
        // out. Transient/offline failures keep the session.
        do {
            currentUser = try await api.getMe()
        } catch {
            if (error as? APIError)?.status == 401 { logout() }
        }
    }

    func login(email: String, password: String, code: String? = nil) async {
        busy = true; authError = nil
        // A fresh email/password attempt (no code) resets the 2FA prompt; a
        // resubmit WITH a code keeps it visible until we know the code took.
        if code == nil { needs2FA = false }
        defer { busy = false }
        do {
            let session = try await api.login(email: email, password: password, code: code)
            needs2FA = false
            persist(session)
        } catch {
            // Password was right but the account needs a 2FA code — reveal the
            // code field instead of surfacing the raw JSON body as an error.
            if let apiErr = error as? APIError, apiErr.requires2FA {
                needs2FA = true
                authError = nil
                return
            }
            // Already in the code stage and the entered code was rejected. The
            // server returns a plain 401 for a wrong code (indistinguishable
            // from a bad password, by design), so key off our own state.
            if needs2FA, code != nil, (error as? APIError)?.status == 401 {
                authError = "That code didn't work. Try again."
                return
            }
            authError = message(for: error)
        }
    }

    func register(email: String, username: String, displayName: String, password: String) async {
        busy = true; authError = nil
        defer { busy = false }
        do {
            let session = try await api.register(
                email: email, username: username, displayName: displayName, password: password
            )
            persist(session)
        } catch {
            authError = message(for: error)
        }
    }

    func logout() {
        keychain.delete(tokenKey)
        RefreshCookieStore.clear()
        currentUser = nil
        phase = .signedOut
        // Snapshot the token to revoke with, then drop it from the client
        // IMMEDIATELY. The teardown below makes up to three network calls
        // that can stall for many seconds; if the user signs back in
        // (password autofill makes this a few seconds) while they're in
        // flight, the OLD code read `api.token` at execution time and
        // revoked the NEW session, then nil'd the new token and deleted its
        // refresh cookie — leaving the just-signed-in user broken. We now
        // revoke with the captured OLD token and never touch the new one.
        let oldToken = api.token
        api.token = nil
        Task { [api] in
            guard let oldToken else { return }
            // Unregister push tokens FIRST, then revoke — all pinned to the
            // OLD token (bearerOverride also disables refresh-retry so a 401
            // can't resurrect + re-persist a dead session). Best-effort.
            if let t = PushManager.shared.apnsTokenHex {
                await api.unregisterDeviceToken(token: t, bearer: oldToken)
            }
            if let t = VoipPushHandler.shared.voipTokenHex {
                await api.unregisterDeviceToken(token: t, bearer: oldToken)
            }
            await api.logout(bearer: oldToken)
            // The server clears the refresh cookie on logout; mirror it
            // locally in case the request didn't land — but ONLY if we're
            // still signed out. A re-login during these in-flight calls set
            // api.token non-nil via persist(); deleting cookies then would
            // wipe the fresh refresh cookie and break the new session.
            if api.token == nil, let url = URL(string: Config.apiBaseURL) {
                for cookie in HTTPCookieStorage.shared.cookies(for: url) ?? [] {
                    HTTPCookieStorage.shared.deleteCookie(cookie)
                }
            }
        }
    }

    /// Update display name. Returns nil on success or an error message.
    func updateDisplayName(_ name: String) async -> String? {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "Enter a display name." }
        do { currentUser = try await api.updateProfile(["displayName": trimmed]); return nil }
        catch { return message(for: error) }
    }

    /// Update the profile bio. Empty/whitespace clears it (sent as ""). Returns
    /// nil on success, or a user-facing error string.
    func updateBio(_ bio: String) async -> String? {
        let trimmed = bio.trimmingCharacters(in: .whitespacesAndNewlines)
        do { currentUser = try await api.updateProfile(["bio": trimmed]); return nil }
        catch { return message(for: error) }
    }

    func setStatus(_ status: String) async {
        do { currentUser = try await api.updateProfile(["status": status]) }
        catch { authError = message(for: error) }
    }

    func setAvatarDecoration(_ id: String) async {
        do { currentUser = try await api.updateProfile(["avatarDecoration": id]) }
        catch { authError = message(for: error) }
    }

    func setAchievementsPublic(_ value: Bool) async {
        do { currentUser = try await api.updateProfile(["achievementsPublic": value]) }
        catch { authError = message(for: error) }
    }

    /// Save the custom name tag ("clan tag"), label-only. Empty/whitespace
    /// label clears it (sent as null) so a blank tag disappears cleanly.
    /// tagColor is always sent (a #rrggbb hex). Returns nil on success or a
    /// user-facing error string.
    func setNameTag(label: String, color: String) async -> String? {
        let trimmedLabel = label.trimmingCharacters(in: .whitespacesAndNewlines)
        let patch: [String: Any] = [
            "tagLabel": trimmedLabel.isEmpty ? NSNull() : trimmedLabel,
            "tagColor": color,
        ]
        do { currentUser = try await api.updateProfile(patch); return nil }
        catch { return message(for: error) }
    }

    // MARK: Guild folders

    var guildFolders: [GuildFolder] { currentUser?.guildFolders ?? [] }

    private func commitFolders(_ folders: [GuildFolder]) async {
        do {
            let updated = try await api.updateGuildFolders(folders)
            currentUser?.guildFolders = updated
        } catch { authError = message(for: error) }
    }
    private func newFolderId() -> String { "fldr_\(UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(16))" }

    /// Create a new folder containing the given guild (removed from any other).
    func createFolder(with guildId: String, name: String = "New Folder") async {
        var folders = stripGuild(guildId, from: guildFolders)
        folders.append(GuildFolder(id: newFolderId(), name: name, color: nil, guildIds: [guildId]))
        await commitFolders(folders)
    }
    /// Add a guild to an existing folder (removed from any other first).
    func addGuild(_ guildId: String, toFolder folderId: String) async {
        var folders = stripGuild(guildId, from: guildFolders)
        if let i = folders.firstIndex(where: { $0.id == folderId }) {
            folders[i].guildIds.append(guildId)
        }
        await commitFolders(folders.filter { !$0.guildIds.isEmpty })
    }
    func removeGuildFromFolders(_ guildId: String) async {
        await commitFolders(stripGuild(guildId, from: guildFolders).filter { !$0.guildIds.isEmpty })
    }
    func renameFolder(_ folderId: String, name: String) async {
        var folders = guildFolders
        if let i = folders.firstIndex(where: { $0.id == folderId }) { folders[i].name = name }
        await commitFolders(folders)
    }
    func deleteFolder(_ folderId: String) async {
        await commitFolders(guildFolders.filter { $0.id != folderId })
    }
    private func stripGuild(_ guildId: String, from folders: [GuildFolder]) -> [GuildFolder] {
        folders.map { f in
            var copy = f
            copy.guildIds = f.guildIds.filter { $0 != guildId }
            return copy
        }
    }

    /// How to treat the custom-status auto-clear time on save:
    ///   - keep:     leave the server's existing expiry untouched (omit the field)
    ///   - clear:    no auto-clear (send null)
    ///   - at(date): auto-clear at the given instant (send ISO-8601)
    enum CustomStatusExpiry { case keep, clear, at(Date) }

    func setCustomStatus(_ text: String?, emoji: String? = nil, expiry: CustomStatusExpiry = .keep) async {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmoji = emoji?.trimmingCharacters(in: .whitespacesAndNewlines)
        var patch: [String: Any] = [:]
        patch["customStatus"] = (trimmed?.isEmpty == false) ? trimmed! : NSNull()
        patch["customStatusEmoji"] = (trimmedEmoji?.isEmpty == false) ? trimmedEmoji! : NSNull()
        switch expiry {
        case .keep: break // omit the field → server keeps its current value
        case .clear: patch["customStatusExpiresAt"] = NSNull()
        case .at(let date):
            patch["customStatusExpiresAt"] = ISO8601DateFormatter().string(from: date)
        }
        do { currentUser = try await api.updateProfile(patch) }
        catch { authError = message(for: error) }
    }

    /// Change the username (requires current password; 90-day cooldown).
    /// Returns an error string on failure, nil on success.
    func changeUsername(_ username: String, currentPassword: String) async -> String? {
        do {
            currentUser = try await api.changeUsername(username, currentPassword: currentPassword)
            return nil
        } catch { return message(for: error) }
    }

    /// Request an email change (verification link goes to the new address).
    /// Returns an error string on failure, nil on success.
    func requestEmailChange(_ newEmail: String, currentPassword: String) async -> String? {
        do {
            try await api.requestEmailChange(newEmail: newEmail, currentPassword: currentPassword)
            return nil
        } catch { return message(for: error) }
    }

    /// Upload a new avatar image. Returns an error string on failure.
    func uploadAvatar(filename: String, contentType: String, data: Data) async -> String? {
        do {
            currentUser = try await api.uploadMyAvatar(filename: filename, contentType: contentType, data: data)
            return nil
        } catch { return message(for: error) }
    }

    /// Upload a new profile banner. Returns an error string on failure.
    func uploadBanner(filename: String, contentType: String, data: Data) async -> String? {
        do {
            currentUser = try await api.uploadMyBanner(filename: filename, contentType: contentType, data: data)
            return nil
        } catch { return message(for: error) }
    }

    /// Change the account password. Returns an error string on failure, nil on success.
    func changePassword(current: String, new: String) async -> String? {
        do { try await api.changePassword(currentPassword: current, newPassword: new); return nil }
        catch { return message(for: error) }
    }

    /// Request a password-reset email. Returns an error string on failure.
    func requestPasswordReset(email: String) async -> String? {
        do { try await api.forgotPassword(email: email); return nil }
        catch { return message(for: error) }
    }

    /// Complete a password reset with the emailed token. Returns an error string on failure.
    func resetPassword(token: String, newPassword: String) async -> String? {
        do { try await api.resetPassword(token: token, newPassword: newPassword); return nil }
        catch { return message(for: error) }
    }

    private func persist(_ session: AuthSession) {
        keychain.set(session.accessToken, for: tokenKey)
        api.token = session.accessToken
        currentUser = session.user
        locked = false
        phase = .signedIn
        // Snapshot the fresh refresh cookie login just set, so the session
        // survives an app kill.
        RefreshCookieStore.capture()
    }

    // MARK: Biometric lock

    /// Attempt to unlock a locked session via Face ID / Touch ID.
    func unlock() async {
        // Escape hatch: if biometrics are gone (disabled in system settings,
        // new device), don't trap the user at the gate.
        let probe = await Biometrics.resolve()
        guard probe.available else {
            locked = false
            return
        }
        let ok = await Biometrics.authenticate(reason: "Unlock Zekktris")
        if ok { locked = false }
    }
    /// Toggle the biometric lock. Enabling first verifies the user can pass a
    /// biometric check (so they don't lock themselves out). Returns an error
    /// string on failure, nil on success.
    func setFaceID(_ on: Bool) async -> String? {
        if on {
            let probe = await Biometrics.resolve()
            guard probe.available else { return "\(probe.label) isn't set up on this device." }
            let ok = await Biometrics.authenticate(reason: "Enable \(probe.label) unlock")
            guard ok else { return nil }   // user canceled; leave toggle off
            faceIDEnabled = true
        } else {
            faceIDEnabled = false
            locked = false
        }
        objectWillChange.send()
        return nil
    }

    private func message(for error: Error) -> String {
        (error as? APIError)?.message ?? error.localizedDescription
    }
}

/// Thin wrapper over LocalAuthentication for Face ID / Touch ID.
///
/// `canEvaluatePolicy` XPCs to the biometric daemon and can stall for seconds
/// — or hang outright — so it must NEVER run synchronously on the main
/// thread (it froze Settings when securitySection probed it during view
/// construction). The probe runs once, off-main, via `resolve()`, and the
/// result is cached for the life of the process.
enum Biometrics {
    struct Probe {
        let available: Bool
        let label: String
    }

    @MainActor private static var cached: Probe?

    /// One-shot, off-main availability probe. Instant after the first call.
    @MainActor
    static func resolve() async -> Probe {
        if let cached { return cached }
        let probe = await Task.detached(priority: .userInitiated) { () -> Probe in
            let ctx = LAContext()
            let ok = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
            let label: String
            switch ctx.biometryType {
            case .faceID: label = "Face ID"
            case .touchID: label = "Touch ID"
            default: label = "Biometrics"
            }
            return Probe(available: ok, label: label)
        }.value
        cached = probe
        return probe
    }

    static func authenticate(reason: String) async -> Bool {
        await Task.detached(priority: .userInitiated) { () -> Bool in
            let ctx = LAContext()
            var error: NSError?
            guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { return false }
            return await withCheckedContinuation { cont in
                ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, _ in
                    cont.resume(returning: success)
                }
            }
        }.value
    }
}

/// Persists the server's long-lived refresh cookie across app launches.
///
/// The session is a short-lived (15-min) access token kept in the Keychain
/// plus the 30-day httpOnly `zekktris_refresh` cookie that renews it. URLSession's
/// shared cookie jar doesn't reliably keep that cookie after the app is killed,
/// so on a cold launch the expired access token couldn't be renewed and the app
/// fell back to the login screen. We snapshot the cookie to the Keychain after
/// auth, after each refresh (the server rotates it), and when the app
/// backgrounds, then restore it into the jar on launch BEFORE `bootstrap()`
/// refreshes. The cookie never touches a response body (stays httpOnly), so its
/// protection is preserved. Mirrors the Android "flush cookies on pause" fix.
enum RefreshCookieStore {
    private static let storageKey = "zk.refreshCookie"
    private static let cookieName = "zekktris_refresh"
    private static let keychain = KeychainStore()

    /// Snapshot the current refresh cookie (if any) to the Keychain.
    static func capture() {
        guard let cookie = (HTTPCookieStorage.shared.cookies ?? [])
                .first(where: { $0.name == cookieName }),
              let props = cookie.properties
        else { return }
        let stringKeyed = Dictionary(uniqueKeysWithValues: props.map { ($0.key.rawValue, $0.value) })
        guard let data = try? PropertyListSerialization.data(
            fromPropertyList: stringKeyed, format: .binary, options: 0)
        else { return }
        keychain.set(data.base64EncodedString(), for: storageKey)
    }

    /// Restore the persisted refresh cookie into the jar on launch. An expired
    /// snapshot (app closed > 30 days) restores an already-expired cookie that
    /// URLSession simply won't send — correctly forcing a re-login.
    static func restore() {
        guard let b64 = keychain.get(storageKey),
              let data = Data(base64Encoded: b64),
              let plist = try? PropertyListSerialization.propertyList(from: data, options: [], format: nil),
              let stringKeyed = plist as? [String: Any]
        else { return }
        let props = Dictionary(uniqueKeysWithValues: stringKeyed.map {
            (HTTPCookiePropertyKey(rawValue: $0.key), $0.value)
        })
        if let cookie = HTTPCookie(properties: props) {
            HTTPCookieStorage.shared.setCookie(cookie)
        }
    }

    static func clear() {
        keychain.delete(storageKey)
    }
}
