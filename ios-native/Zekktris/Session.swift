import Foundation
import SwiftUI
import UIKit
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
    /// What to tell the user on the lock screen after a failed/cancelled
    /// unlock. nil while nothing has gone wrong. Cleared on the next attempt.
    @Published var unlockError: String?
    /// True while an authentication sheet is on screen — the lock screen shows
    /// a spinner and refuses to queue a second prompt behind the first.
    @Published private(set) var unlocking = false

    /// True while a LocalAuthentication sheet is up. The system sheet can push
    /// the app out of the foreground, so the scene-phase hooks below must not
    /// read that as "the user left the app" — otherwise arming the lock would
    /// fight the prompt that is trying to clear it. Mirrors Android's
    /// `authInProgress` (android-native MainActivity.kt).
    private var authInProgress = false
    /// Set when the app really did leave the foreground with the lock enabled;
    /// consumed on the next activation to re-arm the lock.
    private var sawBackground = false

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
    private let tokenKey = StoredCredentials.accessTokenKey
    let api = APIClient.shared

    var token: String? { api.token }

    /// Called once at launch. Restores a persisted token and validates it by
    /// fetching the current user; falls back to the sign-in screen on failure.
    func bootstrap() async {
        // Restore the long-lived refresh cookie BEFORE any network call. The
        // cookie jar doesn't survive an app kill, so without this the (expired)
        // access token below can't be renewed and we'd fall back to the login
        // screen — the "doesn't stay logged in" bug.
        // Also persists rotated access tokens + cookie (StoredCredentials).
        StoredCredentials.prepare(api)
        // The ONLY path that may end the session. APIClient calls this when
        // /auth/refresh itself answered 401/403 — the refresh token is revoked
        // or expired and no retry will bring it back. Everything else (offline,
        // 20s timeout, 5xx mid-deploy, the 409 a concurrent rotation returns)
        // comes back `.transient` and must leave the keychain and the refresh
        // cookie exactly where they are.
        api.onRefreshFatal = { [weak self] in
            Task { @MainActor in
                // A fast re-login can land while a doomed refresh is still in
                // flight; never tear down a session we've since replaced.
                guard let self, self.phase == .signedIn else { return }
                self.logout()
            }
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
        // Gate on the saved setting alone — probing biometric availability can
        // block (XPC to the biometric daemon), so it must never run inline
        // here. unlock() resolves availability async and, if the device really
        // can't authenticate at all, keeps the gate up and offers Sign out
        // rather than waving the user through (see `unlock`). This arms the
        // COLD-launch lock; `noteBecameActive()` re-arms it on a warm resume.
        locked = faceIDEnabled
        phase = .signedIn
        // Refresh the user in the background, best-effort. Deliberately NO
        // sign-out here: this used to read a 401 from getMe as "the refresh
        // token is dead", but getMe 401s identically when the refresh behind it
        // merely timed out, hit a 502 during a deploy, or lost a rotation race
        // — and `logout()` then deleted the keychain token AND the 30-day
        // refresh cookie, destroying the one credential that would have worked
        // five seconds later. A genuinely dead refresh token now arrives via
        // `onRefreshFatal` above; anything else keeps the session (we're
        // already signed in off the cached user).
        currentUser = (try? await api.getMe()) ?? currentUser
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

    func register(email: String, username: String, displayName: String, password: String, dateOfBirth: String, code: String? = nil) async {
        busy = true; authError = nil
        defer { busy = false }
        do {
            let session = try await api.register(
                email: email, username: username, displayName: displayName, password: password, dateOfBirth: dateOfBirth,
                code: code
            )
            persist(session)
        } catch {
            authError = message(for: error)
        }
    }

    // ── Passkeys (WebAuthn via PasskeyManager) ──────────────────────────────
    /// Sign in with a passkey. Returns true on success. `.cancelled` (user
    /// dismissed the system sheet) is a silent no-op.
    func loginWithPasskey() async -> Bool {
        busy = true; authError = nil
        defer { busy = false }
        do {
            let opt = try await api.passkeyLoginOptions()
            guard let challenge = Data(base64URLEncoded: opt.options.challenge) else {
                throw PasskeyError.unexpected
            }
            let response = try await PasskeyManager().performAssertion(challenge: challenge)
            let session = try await api.passkeyLoginVerify(challengeId: opt.challengeId, response: response)
            persist(session)
            return true
        } catch PasskeyError.cancelled {
            return false
        } catch {
            authError = message(for: error)
            return false
        }
    }

    // ── Device-approval login (THIS device is the one being signed in) ──────
    // The signed-in half (lookup/approve/deny) talks to APIClient.shared
    // directly from the approval screen — it needs no Session state, and must
    // never disturb the live session it is authenticating with.

    /// Open a request and get the code to display. `deviceCode` inside the
    /// result is SECRET: keep it in memory, never render or persist it.
    func startDeviceLogin() async -> DeviceLoginStart? {
        authError = nil
        do { return try await api.startDeviceLogin(deviceName: UIDevice.current.model) }
        catch { authError = message(for: error); return nil }
    }

    /// One poll. Returns nil on a TRANSPORT failure so the caller simply keeps
    /// waiting — a dropped packet or a 20s timeout must not look like a denial,
    /// and must not paint an error under a code that is still perfectly valid.
    func pollDeviceLogin(deviceCode: String) async -> DeviceLoginPoll? {
        try? await api.pollDeviceLogin(deviceCode: deviceCode)
    }

    /// The request was approved on the other device — adopt the session it
    /// returned. Same landing as login()/passkey: persist() flips the app to
    /// signed-in, which unmounts the whole auth flow (and this sheet with it).
    ///
    /// The server delivers `approved` EXACTLY ONCE, so this must not fail
    /// silently: everything it does is local and synchronous.
    func adoptDeviceLogin(_ session: AuthSession) {
        authError = nil
        needs2FA = false
        persist(session)
    }

    // ── Quick login (log in on another device) ──────────────────────────────
    // DEPRECATED direction — replaced by the device-approval calls above.
    // Delete with the `/auth/quick-login/*` routes (checklist:
    // apps/api/src/routes/auth.ts:415).
    /// Mint (or re-randomize) a quick-login code for this device's user. Does
    /// NOT touch the current session.
    func generateQuickLoginCode() async -> QuickLoginCode? {
        do { return try await api.generateQuickLoginCode() }
        catch { authError = message(for: error); return nil }
    }
    /// Invalidate the active code (on leaving the quick-login screen).
    func cancelQuickLoginCode() async { await api.cancelQuickLoginCode() }
    /// Redeem a code shown on another device → a new session. Mirrors
    /// loginWithPasskey: on success persist() flips the app to signed-in.
    func redeemQuickLogin(code: String) async -> Bool {
        busy = true; authError = nil
        defer { busy = false }
        do {
            let session = try await api.redeemQuickLogin(code: code)
            persist(session)
            return true
        } catch {
            authError = message(for: error)
            return false
        }
    }

    /// Add a passkey to the signed-in account. Returns true on success.
    /// Step-up: `currentPassword` is re-verified server-side before the new
    /// credential is stored (a passkey is a login factor that survives a
    /// password reset, so adding one must itself require the password).
    func registerPasskey(currentPassword: String) async -> Bool {
        do {
            let opt = try await api.passkeyRegisterOptions()
            guard
                let challenge = Data(base64URLEncoded: opt.options.challenge),
                let userID = Data(base64URLEncoded: opt.options.user.id)
            else { throw PasskeyError.unexpected }
            let response = try await PasskeyManager().performRegistration(
                challenge: challenge, userID: userID, userName: opt.options.user.name,
            )
            try await api.passkeyRegisterVerify(
                challengeId: opt.challengeId, response: response,
                deviceName: PasskeyManager.currentDeviceName, currentPassword: currentPassword,
            )
            return true
        } catch PasskeyError.cancelled {
            return false
        } catch {
            authError = message(for: error)
            return false
        }
    }

    func loadPasskeys() async -> [PasskeyInfo] {
        (try? await api.listPasskeys()) ?? []
    }
    /// Step-up: removing a login factor requires the account password.
    func deletePasskey(_ id: String, currentPassword: String) async -> Bool {
        do { try await api.deletePasskey(id: id, currentPassword: currentPassword); return true } catch { return false }
    }

    func logout() {
        keychain.delete(tokenKey)
        RefreshCookieStore.clear()
        currentUser = nil
        phase = .signedOut
        // The lock gates a SIGNED-IN session; a leftover armed lock would flash
        // the lock screen over the next sign-in.
        locked = false
        unlockError = nil
        sawBackground = false
        // Snapshot the token to revoke with, then drop it from the client
        // IMMEDIATELY. The teardown below makes up to three network calls
        // that can stall for many seconds; if the user signs back in
        // (password autofill makes this a few seconds) while they're in
        // flight, the OLD code read `api.token` at execution time and
        // revoked the NEW session, then nil'd the new token and deleted its
        // refresh cookie — leaving the just-signed-in user broken. We now
        // revoke with the captured OLD token and never touch the new one.
        let oldToken = api.token
        // …and the server it belongs to, so a server switch made while these
        // calls are in flight can't send the old token somewhere else.
        let oldBase = Config.apiBaseURL
        api.token = nil
        Task { [api] in
            guard let oldToken else { return }
            // Unregister push tokens FIRST, then revoke — all pinned to the
            // OLD token (bearerOverride also disables refresh-retry so a 401
            // can't resurrect + re-persist a dead session). Best-effort.
            if let t = PushManager.shared.apnsTokenHex {
                await api.unregisterDeviceToken(token: t, bearer: oldToken, base: oldBase)
            }
            if let t = VoipPushHandler.shared.voipTokenHex {
                await api.unregisterDeviceToken(token: t, bearer: oldToken, base: oldBase)
            }
            await api.logout(bearer: oldToken, base: oldBase)
            // The server clears the refresh cookie on logout; mirror it
            // locally in case the request didn't land — but ONLY if we're
            // still signed out. A re-login during these in-flight calls set
            // api.token non-nil via persist(); deleting cookies then would
            // wipe the fresh refresh cookie and break the new session.
            if api.token == nil, let url = URL(string: oldBase) {
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

    /// One-time self-service DOB set/correction (dob is YYYY-MM-DD). The server
    /// re-locks after success, so currentUser.canChangeDob flips to false and
    /// the confirm-age banner unmounts. Returns nil on success, else an error.
    func updateDateOfBirth(_ dob: String) async -> String? {
        do { currentUser = try await api.updateDateOfBirth(dob); return nil }
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

    /// Profile privacy: show/hide the perk tier title on the profile popup
    /// (the tier's perks keep working either way).
    func setShowSubscriptionTier(_ value: Bool) async {
        do { currentUser = try await api.updateProfile(["showSubscriptionTier": value]) }
        catch { authError = message(for: error) }
    }

    /// Account-level toggle for achievement-unlock notifications (push + in-app).
    func setNotifyAchievements(_ value: Bool) async {
        do { currentUser = try await api.updateProfile(["notifyAchievements": value]) }
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

    /// Staff-only display-name shimmer. Pass a #rrggbb hex to turn it on, or nil
    /// to turn it off (the server also gates the write to staff). Returns nil on
    /// success or a user-facing error string.
    func setStaffColor(_ color: String?) async -> String? {
        do {
            currentUser = try await api.updateProfile(["staffColor": color ?? NSNull()])
            return nil
        } catch { return message(for: error) }
    }

    /// Optional soft glow on the staff shimmer (staff-only, gated server-side).
    func setStaffGlow(_ on: Bool) async -> String? {
        do {
            currentUser = try await api.updateProfile(["staffGlow": on])
            return nil
        } catch { return message(for: error) }
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

    /// The app left the foreground. Arms the lock for the next activation.
    ///
    /// Mirrors Android's `ON_STOP` arm (android-native MainActivity.kt): keyed
    /// on backgrounding, NOT on merely going inactive, so pulling down
    /// Notification Center or getting a banner doesn't demand Face ID.
    func noteEnteredBackground() {
        guard faceIDEnabled, !authInProgress else { return }
        sawBackground = true
    }

    /// The app came back to the foreground — re-lock if it really was away.
    ///
    /// The lock used to be armed exactly once, in `bootstrap()`, so it only
    /// ever fired on a COLD launch. iOS keeps an app alive for days, so a
    /// warm resume came back straight into the signed-in session: the
    /// "sometimes it doesn't ask for Face ID" report, and a direct
    /// contradiction of the Settings copy ("Require Face ID when opening
    /// Zekktris"). Mirrors Android's `ON_START`.
    func noteBecameActive() {
        defer { sawBackground = false }
        guard sawBackground, faceIDEnabled, phase == .signedIn else { return }
        unlockError = nil
        locked = true
    }

    /// Attempt to unlock a locked session via Face ID / Touch ID / passcode.
    ///
    /// Never unlocks on anything but a successful authentication: see the
    /// fail-closed guard below.
    func unlock() async {
        // One prompt at a time. The lock screen prompts on appear, on every
        // return to the foreground, and on the button — all three can land
        // together after a resume.
        guard locked, !authInProgress else { return }
        authInProgress = true
        unlocking = true
        unlockError = nil
        defer {
            authInProgress = false
            unlocking = false
        }
        let probe = await Biometrics.resolve()
        // FAIL CLOSED. This used to do `locked = false` whenever the probe came
        // back unavailable — a single transient answer from the biometric
        // daemon waved the user straight into a signed-in session with no
        // authentication at all, which is a security hole and not just a bug.
        // The policy we evaluate accepts the device passcode too, so the only
        // way to reach this branch is a device with neither biometrics nor a
        // passcode; Sign out on the lock screen is the escape hatch.
        guard probe.deviceAuthAvailable else {
            unlockError = "\(probe.label) and the device passcode are both unavailable. "
                + "Sign out and sign in again to continue."
            return
        }
        let result = await Biometrics.authenticate(reason: "Unlock Zekktris")
        if result.success {
            locked = false
            unlockError = nil
            return
        }
        unlockError = Biometrics.message(for: result.errorCode, label: probe.label)
    }

    /// Toggle the biometric lock. Enabling first verifies the user can pass a
    /// biometric check (so they don't lock themselves out). Returns an error
    /// string on failure, nil on success.
    func setFaceID(_ on: Bool) async -> String? {
        if on {
            let probe = await Biometrics.resolve()
            guard probe.available else { return "\(probe.label) isn't set up on this device." }
            // The confirm prompt can background us; don't let its own scene
            // transition arm the lock we're in the middle of enabling.
            authInProgress = true
            let result = await Biometrics.authenticate(reason: "Enable \(probe.label) unlock")
            authInProgress = false
            guard result.success else { return nil }   // user canceled; leave toggle off
            faceIDEnabled = true
        } else {
            faceIDEnabled = false
            locked = false
            unlockError = nil
            sawBackground = false
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
    struct Probe: Sendable {
        /// Biometrics are enrolled and usable. Gates ENABLING the lock (a
        /// passcode-only device shouldn't be offered "Unlock with Face ID").
        let available: Bool
        /// Biometrics OR the device passcode can authorise — i.e. what
        /// `.deviceOwnerAuthentication` (the policy `authenticate` evaluates)
        /// will actually accept. This is what the unlock gate reads, so a
        /// biometry lockout after five bad scans leaves the passcode as a
        /// legitimate way in instead of a dead lock screen.
        let deviceAuthAvailable: Bool
        let label: String
        /// The daemon didn't answer in time. Not cached, and treated as "let
        /// evaluatePolicy be the judge" rather than as an answer either way.
        var indeterminate = false
    }

    /// What the probe reports when `canEvaluatePolicy` doesn't come back. The
    /// prompt is still attempted: `evaluatePolicy` is the real gate, and it
    /// fails closed, so an optimistic `deviceAuthAvailable` can't let anyone in.
    private static let stalledProbe = Probe(
        available: false, deviceAuthAvailable: true, label: "Face ID", indeterminate: true)

    /// A finished authentication attempt: whether it passed, and the raw
    /// `LAError` code when it didn't (previously discarded, which is why a
    /// biometry lockout was indistinguishable from a user cancel).
    struct AuthResult: Sendable {
        let success: Bool
        let errorCode: Int?
    }

    @MainActor private static var cached: Probe?

    /// One-shot, off-main availability probe. Instant after the first call.
    ///
    /// Bounded by `timeout`: this XPC has been observed to stall right after
    /// boot, and with a fail-closed unlock a stalled probe would mean a lock
    /// screen that never prompts and never recovers.
    @MainActor
    static func resolve(timeout: Double = 3) async -> Probe {
        if let cached { return cached }
        let work = Task.detached(priority: .userInitiated) { () -> Probe in
            let ctx = LAContext()
            let bio = ctx.canEvaluatePolicy(.deviceOwnerAuthenticationWithBiometrics, error: nil)
            let anyOwner = ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
            let label: String
            switch ctx.biometryType {
            case .faceID: label = "Face ID"
            case .touchID: label = "Touch ID"
            default: label = "Biometrics"
            }
            return Probe(available: bio, deviceAuthAvailable: anyOwner, label: label)
        }
        let probe = await withTaskGroup(of: Probe.self, returning: Probe.self) { group in
            group.addTask { await work.value }
            group.addTask {
                try? await Task.sleep(nanoseconds: UInt64(timeout * 1_000_000_000))
                return Biometrics.stalledProbe
            }
            let first = await group.next() ?? Biometrics.stalledProbe
            group.cancelAll()
            return first
        }
        // Never memoize a non-answer — the next call gets a real probe.
        if !probe.indeterminate { cached = probe }
        return probe
    }

    /// Present the system authentication sheet.
    ///
    /// Uses `.deviceOwnerAuthentication` (biometrics WITH passcode fallback),
    /// not `.deviceOwnerAuthenticationWithBiometrics`. Under the old policy a
    /// biometry lockout (five failed scans) made `canEvaluatePolicy` false, so
    /// this returned false forever while the memoized probe still claimed
    /// biometrics were available — the lock screen's only button silently did
    /// nothing, with no way forward. Passcode fallback is the correct policy
    /// for an app lock and is what makes the retry affordance meaningful.
    static func authenticate(reason: String) async -> AuthResult {
        await Task.detached(priority: .userInitiated) { () -> AuthResult in
            let ctx = LAContext()
            var error: NSError?
            guard ctx.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
                return AuthResult(success: false, errorCode: error?.code)
            }
            let result = await withCheckedContinuation { cont in
                ctx.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, err in
                    let code = err.map { $0 as NSError }?.code
                    cont.resume(returning: AuthResult(success: success, errorCode: code))
                }
            }
            // Hold the context alive until the reply has landed: `ctx` is a
            // local whose last use would otherwise be the evaluatePolicy call,
            // and ARC releasing it mid-evaluation cancels the prompt.
            //
            // This deliberately sits AFTER the await rather than inside the
            // completion handler. That handler is `@Sendable`, and LAContext is
            // not Sendable, so capturing `ctx` in it is a hard ERROR under
            // strict concurrency — one that a simulator build only warns about
            // but a device/Xcode build rejects. Using `ctx` after the
            // suspension keeps it alive across the whole call without the
            // closure capturing it at all.
            withExtendedLifetime(ctx) {}
            return result
        }.value
    }

    /// User-facing text for a failed attempt. Every branch has to leave the
    /// user a next step — the whole point of surfacing this is that a silent
    /// failure left them on a lock screen with nothing to do.
    static func message(for errorCode: Int?, label: String) -> String {
        guard let errorCode, let code = LAError.Code(rawValue: errorCode) else {
            return "Couldn't unlock. Tap Try again."
        }
        switch code {
        case .userCancel, .appCancel, .systemCancel:
            return "Unlock cancelled. Tap Try again."
        case .authenticationFailed:
            return "\(label) didn't match. Try again, or use your device passcode."
        case .biometryLockout:
            return "\(label) is locked out after too many attempts. "
                + "Tap Try again and enter your device passcode."
        case .userFallback:
            return "Tap Try again and enter your device passcode."
        case .passcodeNotSet:
            return "Set a device passcode to unlock Zekktris, or sign out below."
        case .biometryNotAvailable, .biometryNotEnrolled:
            return "\(label) isn't available. Tap Try again and use your device passcode."
        default:
            return "Couldn't unlock. Tap Try again."
        }
    }
}

/// What a fresh process needs before its first authenticated call. Shared by
/// `Session.bootstrap()` and the background notification reply (QuickReply),
/// which iOS can run before bootstrap ever has.
enum StoredCredentials {
    /// Keychain account of the persisted access token.
    static let accessTokenKey = "accessToken"

    /// Restore the refresh cookie into the jar (it doesn't survive an app
    /// kill), and persist rotated access tokens (the APIClient auto-refreshes
    /// expired ones via the /auth/refresh cookie) so the NEXT cold launch
    /// starts from the newest token instead of an already-expired one. The
    /// refresh also rotates the cookie, so re-snapshot it too — otherwise the
    /// next launch restores a superseded refresh token, which the server
    /// treats as a replay and revokes the session.
    static func prepare(_ api: APIClient) {
        RefreshCookieStore.restore()
        api.onTokenRefresh = { newToken in
            KeychainStore().set(newToken, for: accessTokenKey)
            RefreshCookieStore.capture()
        }
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
