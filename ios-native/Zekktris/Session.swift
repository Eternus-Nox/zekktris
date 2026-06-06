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
        guard let saved = keychain.get(tokenKey), !saved.isEmpty else {
            phase = .signedOut
            return
        }
        api.token = saved
        // Restore the session immediately from the saved token + cached user so
        // a cold launch goes straight to the Face ID gate — never back to the
        // login form — even if we're offline or the refresh hiccups.
        currentUser = cachedUser()
        locked = faceIDEnabled && Biometrics.available
        phase = .signedIn
        // Refresh the user in the background. Only sign out if the token is
        // genuinely invalid (401); transient/offline failures keep the session.
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
        api.token = nil
        currentUser = nil
        phase = .signedOut
        Task { await api.logout() }
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

    func setCustomStatus(_ text: String?, emoji: String? = nil) async {
        let trimmed = text?.trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedEmoji = emoji?.trimmingCharacters(in: .whitespacesAndNewlines)
        var patch: [String: Any] = [:]
        patch["customStatus"] = (trimmed?.isEmpty == false) ? trimmed! : NSNull()
        patch["customStatusEmoji"] = (trimmedEmoji?.isEmpty == false) ? trimmedEmoji! : NSNull()
        do { currentUser = try await api.updateProfile(patch) }
        catch { authError = message(for: error) }
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
            guard Biometrics.available else { return "\(Biometrics.typeLabel) isn't set up on this device." }
            let ok = await Biometrics.authenticate(reason: "Enable \(Biometrics.typeLabel) unlock")
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
enum Biometrics {
    static var available: Bool {
        var error: NSError?
        return LAContext().canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error)
    }
    static var typeLabel: String {
        let ctx = LAContext()
        _ = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
        switch ctx.biometryType {
        case .faceID: return "Face ID"
        case .touchID: return "Touch ID"
        default: return "Biometrics"
        }
    }
    static func authenticate(reason: String) async -> Bool {
        let ctx = LAContext()
        var error: NSError?
        guard ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: &error) else { return false }
        return await withCheckedContinuation { cont in
            ctx.evaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, localizedReason: reason) { success, _ in
                cont.resume(returning: success)
            }
        }
    }
}
