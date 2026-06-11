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
        // Persist rotated access tokens (the APIClient auto-refreshes expired
        // ones via the /auth/refresh cookie) so the NEXT cold launch starts
        // from the newest token instead of an already-expired one.
        api.onTokenRefresh = { [keychain, tokenKey] newToken in
            keychain.set(newToken, for: tokenKey)
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

    func login(email: String, password: String) async {
        busy = true; authError = nil
        defer { busy = false }
        do {
            let session = try await api.login(email: email, password: password)
            persist(session)
        } catch {
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
        currentUser = nil
        phase = .signedOut
        // Revoke server-side BEFORE dropping the token — clearing the token
        // first made the logout request go out unauthenticated, so the
        // server-side session was never actually revoked.
        Task { [api] in
            // Unregister push tokens FIRST, while the access token is still
            // valid — api.logout() revokes the session and blacklists the
            // token, after which a device-token DELETE would 401 and the
            // server would keep pushing (incl. VoIP call rings) to this
            // signed-out device. Both best-effort.
            if let t = PushManager.shared.apnsTokenHex {
                await api.unregisterDeviceToken(token: t)
            }
            if let t = VoipPushHandler.shared.voipTokenHex {
                await api.unregisterDeviceToken(token: t)
            }
            await api.logout()
            api.token = nil
            // The server clears the refresh cookie on logout; mirror it
            // locally in case the request didn't land.
            if let url = URL(string: Config.apiBaseURL) {
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
    /// Re-lock when leaving the app, if biometric lock is on.
    func lockIfEnabled() {
        if faceIDEnabled && phase == .signedIn { locked = true }
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
