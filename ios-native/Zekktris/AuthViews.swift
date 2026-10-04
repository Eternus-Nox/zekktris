import SwiftUI
import UIKit
import SafariServices
import AVFoundation

/// The legal-doc URLs on the signed-in server. Single source of truth is the
/// web app (/terms, /privacy) so the text never drifts between platforms — and
/// a self-hosted server serves its own.
enum LegalURL {
    static var terms: URL { URL(string: Config.assetOrigin + "/terms")! }
    static var privacy: URL { URL(string: Config.assetOrigin + "/privacy")! }
}

/// In-app browser sheet (SFSafariViewController) — opens the hosted legal
/// pages without kicking the user out to Safari (so a half-filled register
/// form isn't lost). Defined here so both the auth screens and Settings
/// (same module) can present it.
struct SafariView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> SFSafariViewController {
        SFSafariViewController(url: url)
    }
    func updateUIViewController(_ vc: SFSafariViewController, context: Context) {}
}

/// Styled text/secure field used across the auth screens.
struct AuthField: View {
    let title: String
    @Binding var text: String
    var isSecure = false
    var keyboard: UIKeyboardType = .default
    var textContentType: UITextContentType?
    var autocapitalize = false
    var submitLabel: SubmitLabel = .next
    var onSubmit: () -> Void = {}

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased())
                .font(.zkSans(11, weight: .semibold))
                .foregroundColor(Theme.ink3)
            Group {
                if isSecure {
                    SecureField("", text: $text)
                } else {
                    TextField("", text: $text)
                }
            }
            .textInputAutocapitalization(autocapitalize ? .sentences : .never)
            .autocorrectionDisabled(true)
            .keyboardType(keyboard)
            .textContentType(textContentType)
            .submitLabel(submitLabel)
            .onSubmit(onSubmit)
            .foregroundColor(Theme.ink1)
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(Theme.bg2)
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .strokeBorder(Theme.line, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }
}

/// Branded header shown above the auth forms.
private struct AuthHeader: View {
    let subtitle: String
    var body: some View {
        VStack(spacing: 8) {
            ZStack {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(LinearGradient(
                        colors: [Color(hex: 0x0A0F1C), Color(hex: 0x131A2A)],
                        startPoint: .top, endPoint: .bottom
                    ))
                    .frame(width: 76, height: 76)
                ZSigil()
                    .fill(LinearGradient(
                        colors: [Theme.accent, Theme.accent2, Theme.accent3],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ))
                    .frame(width: 50, height: 50)
            }
            Text("Zekktris")
                .font(.zkSans(31, weight: .bold))
                .foregroundColor(Theme.ink1)
            Text(subtitle)
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
        }
    }
}

/// The Zekktris "Z" sigil, matching the web brand icon path exactly.
struct ZSigil: Shape {
    func path(in rect: CGRect) -> Path {
        let pts: [(CGFloat, CGFloat)] = [
            (192,224),(832,224),(832,352),(416,704),(832,704),
            (832,832),(192,832),(192,704),(608,352),(192,352)
        ]
        let sx = rect.width / 1024, sy = rect.height / 1024
        var p = Path()
        for (i, pt) in pts.enumerated() {
            let point = CGPoint(x: rect.minX + pt.0 * sx, y: rect.minY + pt.1 * sy)
            if i == 0 { p.move(to: point) } else { p.addLine(to: point) }
        }
        p.closeSubpath()
        return p
    }
}

/// Primary call-to-action button with a busy state.
private struct PrimaryButton: View {
    let title: String
    let busy: Bool
    let enabled: Bool
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack {
                if busy {
                    ProgressView().tint(.white)
                } else {
                    Text(title).font(.zkSans(15, weight: .semibold))
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.vertical, 13)
            .foregroundColor(.white)
            .background(enabled ? Theme.accent : Theme.accent.opacity(0.4))
            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .disabled(!enabled || busy)
    }
}

struct LoginView: View {
    @EnvironmentObject private var session: Session
    let switchToRegister: () -> Void
    /// Bumped when the server changes so the screen re-reads Config.
    @State private var serverRevision = 0

    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var showForgot = false
    @State private var passkeyBusy = false
    @State private var showDeviceLogin = false
    @FocusState private var focus: Field?
    private enum Field { case email, password, code }

    private var canSubmit: Bool {
        guard !email.isEmpty, !password.isEmpty else { return false }
        // In the 2FA stage, also require a code.
        return !session.needs2FA || !code.isEmpty
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                AuthHeader(subtitle: "Welcome back")
                    .padding(.top, 40)

                VStack(spacing: 14) {
                    AuthField(
                        title: "Email", text: $email,
                        keyboard: .emailAddress, textContentType: .username,
                        submitLabel: .next, onSubmit: { focus = .password }
                    )
                    .focused($focus, equals: .email)

                    AuthField(
                        title: "Password", text: $password, isSecure: true,
                        textContentType: .password,
                        submitLabel: session.needs2FA ? .next : .go,
                        onSubmit: { session.needs2FA ? (focus = .code) : submit() }
                    )
                    .focused($focus, equals: .password)

                    // Revealed once the server says the account has 2FA on.
                    // Accepts a TOTP code or a one-time recovery code.
                    if session.needs2FA {
                        AuthField(
                            title: "Two-factor code", text: $code,
                            keyboard: .numberPad,
                            textContentType: .oneTimeCode,
                            submitLabel: .go, onSubmit: submit
                        )
                        .focused($focus, equals: .code)
                        Text("Enter the 6-digit code from your authenticator app, or a recovery code.")
                            .font(.zkSans(12))
                            .foregroundColor(Theme.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }

                if !session.needs2FA {
                    HStack {
                        Spacer()
                        Button("Forgot password?") { showForgot = true }
                            .font(.zkSans(13))
                            .foregroundColor(Theme.accent)
                    }
                }

                if let error = session.authError {
                    Text(error)
                        .font(.zkSans(13))
                        .foregroundColor(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                PrimaryButton(
                    title: session.needs2FA ? "Verify" : "Sign in",
                    busy: session.busy, enabled: canSubmit, action: submit
                )

                if !session.needs2FA {
                    HStack(spacing: 10) {
                        Rectangle().fill(Theme.line).frame(height: 1)
                        Text("OR").font(.zkSans(12)).foregroundColor(Theme.ink3)
                        Rectangle().fill(Theme.line).frame(height: 1)
                    }
                    // Passkeys are bound to zekktris.com by the app's
                    // associated-domains entitlement, so they can't work
                    // against a self-hosted server.
                    if Config.isDefaultServer {
                        Button {
                            passkeyBusy = true
                            Task { _ = await session.loginWithPasskey(); passkeyBusy = false }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "person.badge.key.fill").font(.system(size: 15))
                                Text(passkeyBusy ? "Waiting for passkey…" : "Sign in with a passkey")
                                    .font(.zkSans(15, weight: .semibold))
                            }
                            .foregroundColor(Theme.ink1)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(Theme.bg3)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                        .disabled(passkeyBusy || session.busy)
                    }

                    // Device-approval login: this device shows a code, the
                    // user's already-signed-in phone approves it.
                    Button { showDeviceLogin = true } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode").font(.system(size: 15))
                            Text("Log in with another device").font(.zkSans(15, weight: .semibold))
                        }
                        .foregroundColor(Theme.ink1)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(Theme.bg3)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .disabled(session.busy)
                }

                if session.needs2FA {
                    Button("Use a different account") {
                        session.needs2FA = false
                        session.authError = nil
                        code = ""
                    }
                    .font(.zkSans(13))
                    .foregroundColor(Theme.ink3)
                } else {
                    Button(action: switchToRegister) {
                        Text("Need an account? ")
                            .foregroundColor(Theme.ink3)
                        + Text("Register").foregroundColor(Theme.accent)
                    }
                    .font(.zkSans(14))
                    .padding(.top, 4)
                }

                if !session.needs2FA {
                    ServerRow { serverRevision += 1; session.authError = nil }
                        .padding(.top, 6)
                }

                Spacer(minLength: 0)
            }
            .id(serverRevision)
            .padding(.horizontal, 24)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
        .background {
            ZStack { Theme.bg1; AbyssBackground() }.ignoresSafeArea()
        }
        .sheet(isPresented: $showForgot) { ForgotPasswordView() }
        .sheet(isPresented: $showDeviceLogin) { DeviceLoginRequestSheet() }
    }

    private func submit() {
        guard canSubmit else { return }
        focus = nil
        let twoFactor = session.needs2FA ? code.trimmingCharacters(in: .whitespaces) : nil
        Task { await session.login(email: email, password: password, code: twoFactor) }
    }
}

/// "Server: zekktris.com · Change" — shown under the sign-in form. Zekktris
/// runs on zekktris.com, and anyone can host their own server; this is where
/// someone points the app at one. Only reachable while signed out, because a
/// session token belongs to the server that issued it.
struct ServerRow: View {
    let onChanged: () -> Void
    @State private var showPicker = false

    var body: some View {
        Button { showPicker = true } label: {
            HStack(spacing: 6) {
                Image(systemName: "server.rack").font(.system(size: 12))
                Text("Server: ").foregroundColor(Theme.ink3)
                    + Text(Config.serverDisplayName).foregroundColor(Theme.ink2)
                Text("· Change").foregroundColor(Theme.accent)
            }
            .font(.zkSans(13))
            .foregroundColor(Theme.ink3)
            .frame(maxWidth: .infinity)
        }
        .buttonStyle(.plain)
        .sheet(isPresented: $showPicker) {
            ServerPickerSheet(onChanged: onChanged)
        }
    }
}

/// Pick the server to sign in to: zekktris.com, or the address of a
/// self-hosted one (a web address or a bare IP). The address is checked
/// against GET /api/v1/instance/info before it's saved, so a typo can't leave
/// the app pointed at nothing.
struct ServerPickerSheet: View {
    let onChanged: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var address = ""
    @State private var checking = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Zekktris runs on zekktris.com, and anyone can run their own server. Enter the address you were given — a web address like chat.example.com, or an IP address.")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink2)
                        .fixedSize(horizontal: false, vertical: true)

                    AuthField(
                        title: "Server address", text: $address,
                        keyboard: .URL, textContentType: .URL,
                        submitLabel: .go, onSubmit: connect
                    )

                    if let error {
                        Text(error)
                            .font(.zkSans(13))
                            .foregroundColor(Theme.danger)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    PrimaryButton(
                        title: "Connect", busy: checking,
                        enabled: !address.trimmingCharacters(in: .whitespaces).isEmpty,
                        action: connect
                    )

                    if !Config.isDefaultServer {
                        Button {
                            Config.setServerOrigin(nil)
                            onChanged()
                            dismiss()
                        } label: {
                            Text("Go back to zekktris.com")
                                .font(.zkSans(14, weight: .semibold))
                                .foregroundColor(Theme.ink1)
                                .frame(maxWidth: .infinity).padding(.vertical, 12)
                                .background(Theme.bg3)
                                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                        }
                        .buttonStyle(.plain)
                    }

                    Text("Now using \(Config.serverDisplayName). Notifications on your lock screen only work on servers set up for this app; everything else works on any server.")
                        .font(.zkSans(12))
                        .foregroundColor(Theme.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(24)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Server")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }.foregroundColor(Theme.ink2)
                }
            }
        }
        .presentationDetents([.medium, .large])
    }

    private func connect() {
        guard !checking else { return }
        error = nil
        guard let origin = Config.normalizeOrigin(address) else {
            error = "That doesn't look like a server address."
            return
        }
        checking = true
        Task {
            defer { checking = false }
            do {
                let found = try await ServerProbe.find(typed: address, origin: origin)
                Config.setServerOrigin(found)
                onChanged()
                dismiss()
            } catch let e as ServerProbe.Failure {
                error = e.message
            } catch {
                self.error = "Couldn't reach that server."
            }
        }
    }
}

/// One GET to {origin}/api/v1/instance/info: proves the address answers and
/// that it's a Zekktris server.
enum ServerProbe {
    struct Failure: Error { let message: String }
    private struct Info: Decodable { let software: String }

    /// Someone typing "192.168.1.20" or "203.0.113.5" shouldn't need to know
    /// the scheme or port. When they typed neither, try HTTPS first, then —
    /// for a home-network address only — plain http on 80 and on 5550 (the
    /// installer's --lan port). An explicit scheme or port is used as typed.
    /// Returns the first origin that answers as a Zekktris server.
    static func find(typed: String, origin: String) async throws -> String {
        let text = typed.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let comps = URLComponents(string: origin), let host = comps.host else {
            throw Failure(message: "That doesn't look like a server address.")
        }
        let explicit = text.contains("://") || comps.port != nil
        var candidates = [origin]
        if !explicit && isLocal(host) {
            let h = host.contains(":") ? "[\(host)]" : host
            candidates += ["http://\(h)", "http://\(h):5550"]
        }
        var firstError: Error?
        for candidate in candidates {
            do { try await check(candidate); return candidate } catch { firstError = firstError ?? error }
        }
        if isLocal(host) {
            throw Failure(message: "Couldn't reach a Zekktris server at that address. If iPhone asked to find devices on your local network, allow it and tap Connect again.")
        }
        throw firstError ?? Failure(message: "Couldn't reach that server.")
    }

    /// Private/link-local IPv4, loopback, *.local — never resolves DNS.
    static func isLocal(_ host: String) -> Bool {
        let h = host.lowercased()
        if h == "localhost" || h.hasSuffix(".local") || h == "::1" || h.hasPrefix("fd") || h.hasPrefix("fe80") { return true }
        let p = h.split(separator: ".").compactMap { Int($0) }
        guard p.count == 4 else { return false }
        return p[0] == 10 || p[0] == 127 || (p[0] == 172 && (16...31).contains(p[1]))
            || (p[0] == 192 && p[1] == 168) || (p[0] == 169 && p[1] == 254)
    }

    static func check(_ origin: String) async throws {
        guard let url = URL(string: origin + "/api/v1/instance/info") else {
            throw Failure(message: "That doesn't look like a server address.")
        }
        var req = URLRequest(url: url, timeoutInterval: 10)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        let data: Data
        let resp: URLResponse
        do {
            (data, resp) = try await URLSession.shared.data(for: req)
        } catch let e as URLError where e.code == .appTransportSecurityRequiresSecureConnection {
            throw Failure(message: "That server isn't using HTTPS. Only servers on your home network can use plain http://.")
        } catch let e as URLError where [.serverCertificateUntrusted, .serverCertificateHasBadDate, .serverCertificateNotYetValid, .serverCertificateHasUnknownRoot, .secureConnectionFailed].contains(e.code) {
            throw Failure(message: "That server's HTTPS certificate isn't valid. Its owner needs to finish setting up HTTPS.")
        } catch {
            throw Failure(message: "Couldn't reach that server. Check the address, and that the server is running.")
        }
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200,
              let info = try? JSONDecoder().decode(Info.self, from: data),
              info.software == "zekktris" else {
            throw Failure(message: "Something answered at that address, but it isn't a Zekktris server (or it's too old — its owner should update it).")
        }
    }
}

/// Two-stage password recovery: request a reset email, then complete the
/// reset with the emailed code. Mirrors the web /auth/forgot-password and
/// /auth/reset-password flows.
struct ForgotPasswordView: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    private enum Stage { case request, reset }
    @State private var stage: Stage = .request
    @State private var email = ""
    @State private var code = ""
    @State private var newPassword = ""
    @State private var busy = false
    @State private var error: String?
    @State private var info: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 16) {
                    if stage == .request {
                        Text("Enter your account email and we'll send a password reset link.")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        AuthField(title: "Email", text: $email, keyboard: .emailAddress, textContentType: .username, submitLabel: .go, onSubmit: sendRequest)
                        PrimaryButton(title: "Send reset link", busy: busy, enabled: !email.isEmpty, action: sendRequest)
                        Button("I already have a code") { stage = .reset; error = nil }
                            .font(.zkSans(13)).foregroundColor(Theme.accent)
                    } else {
                        Text("Enter the reset code from your email and choose a new password.")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                            .frame(maxWidth: .infinity, alignment: .leading)
                        AuthField(title: "Reset code", text: $code, submitLabel: .next)
                        AuthField(title: "New password", text: $newPassword, isSecure: true, textContentType: .newPassword, submitLabel: .go, onSubmit: doReset)
                        PrimaryButton(title: "Reset password", busy: busy, enabled: !code.isEmpty && newPassword.count >= 8, action: doReset)
                        Button("Back") { stage = .request; error = nil }
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    }

                    if let error {
                        Text(error).font(.zkSans(13)).foregroundColor(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    if let info {
                        Text(info).font(.zkSans(13)).foregroundColor(Theme.online)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    Spacer(minLength: 0)
                }
                .padding(24)
                .frame(maxWidth: 440)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Reset password").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Close") { dismiss() } } }
        }
    }

    private func sendRequest() {
        guard !email.isEmpty, !busy else { return }
        busy = true; error = nil; info = nil
        Task {
            let err = await session.requestPasswordReset(email: email)
            busy = false
            if let err { error = err }
            else { info = "If an account exists for that email, a reset link is on its way."; stage = .reset }
        }
    }

    private func doReset() {
        guard !code.isEmpty, newPassword.count >= 8, !busy else { return }
        busy = true; error = nil; info = nil
        Task {
            let err = await session.resetPassword(token: code, newPassword: newPassword)
            busy = false
            if let err { error = err }
            else {
                info = "Password reset. You can now sign in with your new password."
                DispatchQueue.main.asyncAfter(deadline: .now() + 1.6) { dismiss() }
            }
        }
    }
}

struct RegisterView: View {
    @EnvironmentObject private var session: Session
    let switchToLogin: () -> Void
    /// Bumped when the server changes so the screen re-reads Config.
    @State private var serverRevision = 0

    @State private var email = ""
    @State private var username = ""
    @State private var displayName = ""
    @State private var inviteCode = ""
    @State private var password = ""
    @State private var repeatPassword = ""
    // Date of birth. `dobChosen` gates submit so the user must actively pick
    // (the picker can't be nil); the server age-gates under-13 regardless.
    @State private var dob = Date()
    @State private var dobChosen = false
    // Must agree to the Terms/Privacy before the account can be created — the
    // links open in-app (SafariView) so tapping them doesn't discard the form.
    @State private var agreeToTerms = false
    @State private var showTerms = false
    @State private var showPrivacy = false
    @FocusState private var focus: Field?
    private enum Field { case email, username, displayName, password, repeatPassword }

    private var strength: Int { passwordStrength(password) }
    private var mismatch: Bool { !repeatPassword.isEmpty && repeatPassword != password }
    private var canSubmit: Bool {
        !email.isEmpty && !username.isEmpty && !displayName.isEmpty
            && password.count >= 8 && password == repeatPassword && dobChosen && agreeToTerms
    }

    /// Compose the picked date into the server's YYYY-MM-DD shape (local
    /// calendar day, stable POSIX format).
    private var dobString: String {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_US_POSIX")
        f.dateFormat = "yyyy-MM-dd"
        return f.string(from: dob)
    }

    var body: some View {
        ScrollView {
            VStack(spacing: 18) {
                AuthHeader(subtitle: "Create your account")
                    .padding(.top, 36)

                VStack(spacing: 14) {
                    AuthField(
                        title: "Email", text: $email,
                        keyboard: .emailAddress, textContentType: .emailAddress,
                        onSubmit: { focus = .username }
                    )
                    .focused($focus, equals: .email)

                    AuthField(
                        title: "Username", text: $username,
                        textContentType: .username,
                        onSubmit: { focus = .displayName }
                    )
                    .focused($focus, equals: .username)

                    AuthField(
                        title: "Display name", text: $displayName,
                        autocapitalize: true,
                        onSubmit: { focus = .password }
                    )
                    .focused($focus, equals: .displayName)

                    // Self-hosted servers can be invite-only; zekktris.com and
                    // open servers ignore the code.
                    AuthField(title: "Invite code (if you were given one)", text: $inviteCode)

                    VStack(alignment: .leading, spacing: 8) {
                        AuthField(
                            title: "Password", text: $password, isSecure: true,
                            textContentType: .newPassword,
                            onSubmit: { focus = .repeatPassword }
                        )
                        .focused($focus, equals: .password)
                        StrengthMeter(score: strength)
                    }

                    AuthField(
                        title: "Repeat password", text: $repeatPassword, isSecure: true,
                        textContentType: .newPassword,
                        submitLabel: .go, onSubmit: submit
                    )
                    .focused($focus, equals: .repeatPassword)

                    if mismatch {
                        Text("Passwords don't match")
                            .font(.zkSans(12))
                            .foregroundColor(Theme.danger)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }

                    HStack {
                        Text("Date of birth")
                            .font(.zkSans(14))
                            .foregroundColor(Theme.ink2)
                        Spacer()
                        DatePicker(
                            "",
                            selection: $dob,
                            in: ...Date(),
                            displayedComponents: .date
                        )
                        .labelsHidden()
                        .tint(Theme.accent)
                        .onChange(of: dob) { dobChosen = true }
                    }

                    // Terms/Privacy agreement. The link taps are intercepted
                    // (OpenURLAction) so they present the in-app SafariView
                    // sheet instead of leaving the app for Safari.
                    HStack(alignment: .center, spacing: 10) {
                        Button { agreeToTerms.toggle() } label: {
                            Image(systemName: agreeToTerms ? "checkmark.square.fill" : "square")
                                .font(.system(size: 18))
                                .foregroundColor(agreeToTerms ? Theme.accent : Theme.ink3)
                        }
                        .buttonStyle(.plain)
                        Text("I agree to the [Terms of Service](\(LegalURL.terms.absoluteString)) and [Privacy Policy](\(LegalURL.privacy.absoluteString))")
                            .font(.zkSans(13))
                            .foregroundColor(Theme.ink2)
                            .tint(Theme.accent)
                            .environment(\.openURL, OpenURLAction { url in
                                if url == LegalURL.terms { showTerms = true; return .handled }
                                if url == LegalURL.privacy { showPrivacy = true; return .handled }
                                return .systemAction
                            })
                        Spacer(minLength: 0)
                    }
                    .padding(.top, 2)
                }

                if let error = session.authError {
                    Text(error)
                        .font(.zkSans(13))
                        .foregroundColor(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                PrimaryButton(title: "Create account", busy: session.busy, enabled: canSubmit, action: submit)

                Button(action: switchToLogin) {
                    Text("Already have an account? ")
                        .foregroundColor(Theme.ink3)
                    + Text("Sign in").foregroundColor(Theme.accent)
                }
                .font(.zkSans(14))
                .padding(.top, 4)

                ServerRow { serverRevision += 1; session.authError = nil }
                    .padding(.top, 6)

                Spacer(minLength: 0)
            }
            .id(serverRevision)
            .padding(.horizontal, 24)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
        .background {
            ZStack { Theme.bg1; AbyssBackground() }.ignoresSafeArea()
        }
        .sheet(isPresented: $showTerms) { SafariView(url: LegalURL.terms) }
        .sheet(isPresented: $showPrivacy) { SafariView(url: LegalURL.privacy) }
    }

    private func submit() {
        guard canSubmit else { return }
        focus = nil
        Task {
            await session.register(
                email: email, username: username, displayName: displayName, password: password,
                dateOfBirth: dobString,
                code: inviteCode.trimmingCharacters(in: .whitespaces).isEmpty ? nil : inviteCode.trimmingCharacters(in: .whitespaces)
            )
        }
    }
}

/// Four-segment password strength meter matching the web form.
private struct StrengthMeter: View {
    let score: Int
    var body: some View {
        HStack(spacing: 4) {
            ForEach(0..<4, id: \.self) { i in
                RoundedRectangle(cornerRadius: 2)
                    .fill(i < score ? passwordStrengthColor(score) : Theme.bg3)
                    .frame(height: 4)
            }
            Text(passwordStrengthLabel(score))
                .font(.zkSans(11, weight: .medium))
                .foregroundColor(passwordStrengthColor(score))
                .frame(width: 48, alignment: .trailing)
        }
    }
}

// MARK: - Device-approval login ("approve this sign-in on your phone")
//
// Both halves of the flow live here:
//   DeviceLoginRequestSheet    the LOGGED-OUT device — starts a request, shows
//                              the QR + code, polls for the outcome.
//   DeviceLoginApproveSheet    the SIGNED-IN phone — scan or type the code…
//   DeviceLoginApprovalScreen  …then decide it. This is the security control.
//   DeviceLoginApprovalSheet   the same decision reached from a deep link.
//
// The short version of the threat model (full version:
// apps/api/src/auth/device-login-store.ts): what the new device displays is
// NOT a credential. It only names a pending request. Only an authenticated
// approval turns it into a session — which is why a shoulder-surfer who
// photographs the QR gets nothing, and why the approval screen has to tell the
// human enough to spot a phisher.

/// Parsing/formatting for the short user code, mirroring the server's
/// normalization so a typo costs nothing and any Zekktris client can read any
/// other client's screen.
enum DeviceLoginCode {
    /// Server-side USER_CODE_LENGTH.
    static let length = 8
    /// MUST match CODE_ALPHABET in apps/api/src/auth/device-login-store.ts:
    /// Crockford base32 minus I, L, O and U — exactly 32 symbols, which is what
    /// makes the server's `byte % 32` draw unbiased. U is excluded as well as
    /// the O/I/L trio, so a code containing one can never have been minted.
    private static let allowed = Set("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    /// Mirrors `normalizeUserCode` in the store: uppercase, drop anything that
    /// isn't A–Z/0–9, fold the confusables. Done client-side so junk never
    /// costs one of the 20-per-minute lookups.
    static func normalize(_ raw: String) -> String {
        var out = ""
        out.reserveCapacity(length)
        for ch in raw.uppercased() where ch.isASCII && (ch.isLetter || ch.isNumber) {
            switch ch {
            case "O": out.append("0")
            case "I", "L": out.append("1")
            default: out.append(ch)
            }
        }
        return out
    }

    static func isComplete(_ code: String) -> Bool {
        code.count == length && code.allSatisfy { allowed.contains($0) }
    }

    /// `ABCD-EFGH`. Also used mid-typing, so it groups anything past 4 chars.
    static func grouped(_ raw: String) -> String {
        let normalized = String(normalize(raw).prefix(length))
        guard normalized.count > 4 else { return normalized }
        let split = normalized.index(normalized.startIndex, offsetBy: 4)
        return "\(normalized[normalized.startIndex..<split])-\(normalized[split...])"
    }

    /// THE CROSS-PLATFORM QR PAYLOAD — kept identical to Android's
    /// DeviceLoginCode.qrPayload and to what web's own QR encodes
    /// (AuthScreens.tsx), so any of the three can scan any other's screen.
    ///
    /// It MUST point at the APPROVAL page (`/approve-device`), not at
    /// `/login/device`. `/login/device` is the *requester* page — the one this
    /// screen already is — and it ignores `?code=` and immediately starts a
    /// second, unrelated login request. Scanning the QR with the system camera
    /// is the flow this screen tells the user to use, so pointing it there
    /// showed no approval prompt at all and burned the start budget.
    ///
    /// An https URL rather than a bare code, deliberately: someone who scans it
    /// with the SYSTEM camera lands on a real Zekktris page instead of a
    /// screenful of gibberish. It cannot open this app: opening `/approve-device`
    /// natively would need `applinks:zekktris.com` in the entitlement plus a
    /// matching apple-app-site-association, and only `webcredentials` is
    /// configured today. A `zekktris://device-login?code=…` payload WOULD open
    /// the app (that route is wired: Info.plist CFBundleURLTypes → onOpenURL →
    /// AppStore.handleDeepLink → DeviceLoginApprovalSheet), but it is useless to
    /// every scanner that isn't an iPhone with this app installed, so the QR
    /// stays https and the in-app scanner keeps accepting both.
    ///
    /// `Config.assetOrigin` is the web origin (it is only *named* for assets),
    /// so pointing the app at a dev host moves this URL with it — matching
    /// Android, which builds the same string from its CDN_BASE_URL.
    static func qrPayload(_ userCode: String) -> String {
        "\(Config.assetOrigin)/approve-device?code=\(grouped(userCode))"
    }

    /// Liberal reader for whatever the camera or a paste produced: a bare
    /// code, our QR URL, a `zekktris://device-login?code=…` deep link, or any
    /// URL carrying `code=`/`c=`. Returns nil unless the result is a COMPLETE
    /// code — never send a whole URL to a server whose normalizer would happily
    /// mangle it into a plausible-looking wrong code.
    static func extract(from raw: String) -> String? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if let items = URLComponents(string: trimmed)?.queryItems,
           let value = items.first(where: { $0.name == "code" || $0.name == "c" })?.value {
            let code = normalize(value)
            return isComplete(code) ? code : nil
        }
        let code = normalize(trimmed)
        return isComplete(code) ? code : nil
    }
}

/// THE LOGGED-OUT DEVICE. Opens a request, displays the QR + code for the
/// user's already-signed-in phone, and polls until it's approved, denied or
/// expired. On approval the session lands here and the whole auth flow
/// unmounts into the app.
struct DeviceLoginRequestSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss

    private enum Stage: Equatable { case starting, waiting, denied, expired, failed(String) }

    @State private var stage: Stage = .starting
    /// Holds the SECRET deviceCode. Memory only, for this sheet's lifetime —
    /// never rendered, never written anywhere.
    @State private var request: DeviceLoginStart?
    @State private var secondsLeft = 0
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    steps

                    switch stage {
                    case .starting:
                        ProgressView().tint(Theme.accent).padding(.vertical, 60)
                    case .waiting:
                        if let request { codeCard(request) }
                    case .denied:
                        outcomeCard(
                            symbol: "hand.raised.fill", tint: Theme.danger,
                            title: "Sign-in denied",
                            body: "Your other device turned this down. Nothing was signed in.",
                            actionTitle: "Try again",
                        )
                    case .expired:
                        outcomeCard(
                            symbol: "clock.badge.exclamationmark", tint: Theme.warning,
                            title: "Code expired",
                            body: "Codes last 5 minutes. Get a fresh one and show it to your other device.",
                            actionTitle: "New code",
                        )
                    case .failed(let message):
                        outcomeCard(
                            symbol: "exclamationmark.triangle.fill", tint: Theme.danger,
                            title: "Couldn't start", body: message, actionTitle: "Try again",
                        )
                    }

                    Text("This code can't sign anyone in on its own. Your other device has to approve it — and it'll show you exactly what it's approving first.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(20)
                .frame(maxWidth: 440)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Log in with another device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold))
                            .foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close")
                }
            }
            .task { if request == nil { await start() } }
            // One poll loop per request. `.task(id:)` cancels it when the code
            // is replaced or the sheet goes away, so a dismissed sheet never
            // keeps polling in the background.
            .task(id: request?.deviceCode) { await pollUntilDecided() }
            // Local countdown, so the code visibly ages even while the poll
            // loop is asleep between intervals.
            .task(id: request?.userCode) { await tickDown() }
        }
        // A drag-dismissed sheet containing a NavigationStack corrupts the
        // presenter's hit-testing (see MainView's rail notes) — close via the
        // ‹ button only.
        .interactiveDismissDisabled()
    }

    private var steps: some View {
        VStack(alignment: .leading, spacing: 9) {
            stepRow(1, "Open Zekktris on a device you're already signed in on.")
            stepRow(2, "Go to Settings → Log in on another device.")
            stepRow(3, "Scan this code with it — or type the code in.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func stepRow(_ number: Int, _ text: String) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Text("\(number)")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.accent)
                .frame(width: 20, height: 20)
                .background(Theme.accent.opacity(0.15), in: Circle())
            Text(text).font(.zkSans(13)).foregroundColor(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
        }
    }

    private func codeCard(_ request: DeviceLoginStart) -> some View {
        VStack(spacing: 14) {
            if let image = qrCodeImage(DeviceLoginCode.qrPayload(request.userCode)) {
                Image(uiImage: image)
                    .interpolation(.none).resizable()
                    .frame(width: 220, height: 220)
                    .padding(12)
                    .background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                    .accessibilityLabel("QR code for sign-in code \(DeviceLoginCode.grouped(request.userCode))")
            }

            Button {
                UIPasteboard.general.string = DeviceLoginCode.grouped(request.userCode)
                copied = true
            } label: {
                VStack(spacing: 4) {
                    Text(DeviceLoginCode.grouped(request.userCode))
                        .font(.system(size: 30, weight: .semibold, design: .monospaced))
                        .kerning(2)
                        .foregroundColor(Theme.ink1)
                    Text(copied ? "Copied" : "Tap to copy")
                        .font(.zkSans(11)).foregroundColor(Theme.ink3)
                }
            }
            .buttonStyle(.plain)

            HStack(spacing: 8) {
                ProgressView().tint(Theme.accent).scaleEffect(0.8)
                Text("Waiting for approval · \(countdown)")
                    .font(.zkSans(12)).monospacedDigit().foregroundColor(Theme.ink3)
            }
        }
    }

    private func outcomeCard(
        symbol: String, tint: Color, title: String, body: String, actionTitle: String
    ) -> some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 34)).foregroundColor(tint)
            Text(title).font(.zkSans(17, weight: .semibold)).foregroundColor(Theme.ink1)
            Text(body).font(.zkSans(13)).foregroundColor(Theme.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Button { Task { await start() } } label: {
                Text(actionTitle)
                    .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity, minHeight: 46)
                    .background(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var countdown: String {
        let seconds = max(0, secondsLeft)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private func start() async {
        stage = .starting
        copied = false
        request = nil
        guard let started = await session.startDeviceLogin() else {
            stage = .failed(session.authError ?? "Couldn't reach Zekktris. Check your connection and try again.")
            return
        }
        request = started
        secondsLeft = max(0, started.expiresIn)
        stage = .waiting
    }

    private func pollUntilDecided() async {
        guard let request else { return }
        var interval = max(1, request.interval)
        while !Task.isCancelled {
            // Sleep FIRST: the server arms the poll interval at `start`, so an
            // immediate poll only earns a slow_down.
            try? await Task.sleep(nanoseconds: UInt64(interval) * 1_000_000_000)
            if Task.isCancelled { return }
            // nil = transport hiccup (offline moment, 20s timeout, a 429 from
            // the flood guard). Keep waiting — the code is still perfectly
            // good, and painting an error under it would be a lie.
            guard let result = await session.pollDeviceLogin(deviceCode: request.deviceCode) else { continue }
            switch result {
            case .pending(let next): interval = max(1, next)
            case .slowDown(let next): interval = max(1, next)
            case .denied: stage = .denied; return
            case .expired: stage = .expired; return
            case .approved(let authSession):
                // Delivered exactly once. Persisting flips the app to
                // signed-in, which unmounts the auth flow and this sheet.
                session.adoptDeviceLogin(authSession)
                return
            }
        }
    }

    private func tickDown() async {
        guard request != nil else { return }
        while secondsLeft > 0 {
            try? await Task.sleep(nanoseconds: 1_000_000_000)
            if Task.isCancelled { return }
            secondsLeft -= 1
        }
        if stage == .waiting { stage = .expired }
    }
}

/// THE SIGNED-IN PHONE, entry point (Settings → Log in on another device).
/// Scan the new device's QR or type its code, then decide it.
struct DeviceLoginApproveSheet: View {
    @Environment(\.dismiss) private var dismiss

    @State private var typed = ""
    @State private var scanning = false
    @State private var busy = false
    @State private var errorText: String?
    @State private var pending: DeviceLoginRequestInfo?
    @FocusState private var codeFocused: Bool

    private var code: String { DeviceLoginCode.normalize(typed) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Signing in on a new device? Start the sign-in over there, then approve it from here.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    Button { scanning = true } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 16))
                            Text("Scan the code").font(.zkSans(15, weight: .semibold))
                        }
                        .foregroundColor(Theme.ink1)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(Theme.bg3)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    HStack(spacing: 10) {
                        Rectangle().fill(Theme.line).frame(height: 1)
                        Text("OR ENTER THE CODE").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        Rectangle().fill(Theme.line).frame(height: 1)
                    }

                    TextField("ABCD-EFGH", text: $typed)
                        .font(.system(size: 22, weight: .semibold, design: .monospaced))
                        .kerning(2)
                        .multilineTextAlignment(.center)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .foregroundColor(Theme.ink1)
                        .focused($codeFocused)
                        .submitLabel(.go)
                        .onSubmit { submit() }
                        .onChange(of: typed) { _, value in
                            // Live-format to the display shape. Normalizing on
                            // every keystroke also silently fixes the O/0 and
                            // I/1 mix-ups the alphabet exists to avoid.
                            let formatted = DeviceLoginCode.grouped(value)
                            if formatted != value { typed = formatted }
                        }
                        .padding(.vertical, 14)
                        .frame(maxWidth: .infinity)
                        .background(Theme.bg2)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))

                    if let errorText {
                        Text(errorText).font(.zkSans(13)).foregroundColor(Theme.dangerSoft)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Button(action: submit) {
                        ZStack {
                            if busy { ProgressView().tint(.white) } else {
                                Text("Continue").font(.zkSans(16, weight: .semibold))
                            }
                        }
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity, minHeight: 50)
                        .background(DeviceLoginCode.isComplete(code) ? Theme.accent : Theme.accent.opacity(0.4))
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .disabled(busy || !DeviceLoginCode.isComplete(code))

                    Text("You'll see what the device is and where it's connecting from before anything is approved.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(20)
                .frame(maxWidth: 440)
                .frame(maxWidth: .infinity)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Log in on another device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold))
                            .foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close")
                }
            }
            .navigationDestination(item: $pending) { info in
                DeviceLoginApprovalScreen(info: info) { dismiss() }
            }
            .sheet(isPresented: $scanning) {
                DeviceLoginScannerSheet { raw in
                    scanning = false
                    scanned(raw)
                }
            }
        }
        .interactiveDismissDisabled()
    }

    private func submit() {
        guard DeviceLoginCode.isComplete(code) else { return }
        codeFocused = false
        Task { await lookup(code) }
    }

    private func scanned(_ raw: String) {
        guard let scannedCode = DeviceLoginCode.extract(from: raw) else {
            errorText = "That isn't a Zekktris sign-in code. Scan the code on the new device's sign-in screen."
            return
        }
        typed = DeviceLoginCode.grouped(scannedCode)
        Task { await lookup(scannedCode) }
    }

    private func lookup(_ userCode: String) async {
        busy = true
        errorText = nil
        defer { busy = false }
        do {
            pending = try await APIClient.shared.lookupDeviceLogin(userCode: userCode)
        } catch {
            errorText = Self.lookupMessage(error)
        }
    }

    /// The 404 deliberately does not distinguish "never existed" from "expired"
    /// from "already answered" — the server answers all three identically so
    /// the code can't be probed, and the copy must not invent a distinction.
    private static func lookupMessage(_ error: Error) -> String {
        guard let apiError = error as? APIError else {
            return "Couldn't check that code. Check your connection and try again."
        }
        switch apiError.status {
        case 404:
            return "No sign-in request with that code. Codes last 5 minutes — ask the other device for a fresh one."
        case 429:
            return "Too many tries. Wait a minute, then try again."
        case 401, 403:
            return "Sign in again on this device before approving another one."
        default:
            return apiError.message
        }
    }
}

/// A deep link (`zekktris://device-login?code=…`, or the web approval page
/// handing off) landed on a code — look it up, then show the same decision
/// screen. Presented over the app by RootView.
///
/// A link is exactly how a phisher would deliver a code, which is fine: this
/// path reaches the identical approval screen, and that screen is what stops
/// the attack.
struct DeviceLoginApprovalSheet: View {
    let userCode: String
    @Environment(\.dismiss) private var dismiss
    @State private var info: DeviceLoginRequestInfo?
    @State private var errorText: String?

    var body: some View {
        NavigationStack {
            Group {
                if let info {
                    // The screen carries its own ‹ (dismiss here = close the
                    // sheet), so don't add a second one around it.
                    DeviceLoginApprovalScreen(info: info) { dismiss() }
                } else if let errorText {
                    VStack(spacing: 14) {
                        Image(systemName: "questionmark.circle").font(.system(size: 34)).foregroundColor(Theme.ink3)
                        Text(errorText).font(.zkSans(14)).foregroundColor(Theme.ink2)
                            .multilineTextAlignment(.center)
                        Button { dismiss() } label: {
                            Text("Close").font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                                .frame(maxWidth: .infinity, minHeight: 48)
                                .background(Theme.accent)
                                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        }
                    }
                    .padding(28)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(Theme.bg1.ignoresSafeArea())
                    .navigationTitle("Approve sign-in")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { closeButton }
                } else {
                    ProgressView().tint(Theme.accent)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(Theme.bg1.ignoresSafeArea())
                        .navigationTitle("Approve sign-in")
                        .navigationBarTitleDisplayMode(.inline)
                        .toolbar { closeButton }
                }
            }
            .task {
                do {
                    info = try await APIClient.shared.lookupDeviceLogin(userCode: userCode)
                } catch {
                    errorText = "That sign-in request is no longer waiting. Codes last 5 minutes — start again on the other device."
                }
            }
        }
        .interactiveDismissDisabled()
    }

    @ToolbarContentBuilder
    private var closeButton: some ToolbarContent {
        ToolbarItem(placement: .cancellationAction) {
            Button { dismiss() } label: {
                Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold))
                    .foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle())
            }
            .accessibilityLabel("Close")
        }
    }
}

/// THE APPROVAL SCREEN. This is a security control, not a confirmation dialog.
///
/// It exists for the one attack the server cannot see: an attacker starts a
/// request on their own machine and talks the user into approving it ("support
/// here, read me the code" / a fake page showing the attacker's QR / a sticker
/// over a real one). The server sees a genuine session make a genuine
/// approval, so the only defence is what this screen shows a human:
///
///   • the code, big, to compare against the new device's screen;
///   • WHAT ZEKKTRIS OBSERVED — IP, same-network, when. A remote attacker
///     cannot forge these, and `sameNetwork == false` gets a loud warning;
///   • WHAT THE DEVICE CLAIMS — name, platform, user-agent, locale, labelled
///     as claims, because an attacker will call themselves "Your iPhone";
///   • a Deny that is exactly as reachable as Approve (equal size, equal
///     weight, side by side — Deny first).
///
/// DO NOT collapse this into a yes/no alert, and do not drop the claimed/
/// observed split. See apps/api/src/auth/device-login-store.ts.
struct DeviceLoginApprovalScreen: View {
    let info: DeviceLoginRequestInfo
    /// Called after the user has decided and tapped Done — dismisses the whole
    /// presentation, not just this screen.
    var onFinished: () -> Void

    @EnvironmentObject private var session: Session
    /// Pops when pushed (from the code-entry sheet); closes the sheet when this
    /// screen IS the sheet (the deep-link route). Either way, leaving without
    /// deciding is safe — the request simply expires.
    @Environment(\.dismiss) private var dismiss

    private enum Outcome: Equatable { case undecided, working, approved, denied, failed(String) }
    @State private var outcome: Outcome = .undecided
    @State private var secondsLeft: Int
    @State private var confirmRemote = false
    @State private var showFullAgent = false

    init(info: DeviceLoginRequestInfo, onFinished: @escaping () -> Void = {}) {
        self.info = info
        self.onFinished = onFinished
        _secondsLeft = State(initialValue: max(0, info.expiresIn))
    }

    private var device: DeviceLoginDeviceInfo { info.device }
    private var isExpired: Bool { secondsLeft <= 0 }

    var body: some View {
        ScrollView {
            VStack(spacing: 16) {
                headline
                codeCard
                if !device.sameNetwork { networkWarning }
                observedCard
                claimedCard
                cautionLine
                decisionArea
            }
            .padding(20)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
        .background(Theme.bg1.ignoresSafeArea())
        .navigationTitle("Approve sign-in")
        .navigationBarTitleDisplayMode(.inline)
        // The app-wide chevron: ink2, 20pt, 44pt tap target — never the
        // accent-tinted system back button.
        .navigationBarBackButtonHidden(true)
        .toolbar {
            ToolbarItem(placement: .cancellationAction) {
                Button { dismiss() } label: {
                    Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold))
                        .foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle())
                }
                .accessibilityLabel("Back")
            }
        }
        .task {
            while secondsLeft > 0 {
                try? await Task.sleep(nanoseconds: 1_000_000_000)
                if Task.isCancelled { return }
                // Stop once it's decided: the request is terminal at that
                // point, and letting the clock run on would contradict the
                // "Approved" card with an "expired" line above it.
                if outcome != .undecided { return }
                secondsLeft -= 1
            }
        }
        .alert("This device isn't on your network", isPresented: $confirmRemote) {
            Button("Cancel", role: .cancel) {}
            Button("Approve anyway", role: .destructive) { decide(approve: true) }
        } message: {
            Text("It's asking for full access to your account from somewhere else. Only approve it if you started this sign-in yourself.")
        }
    }

    // ── Sections ────────────────────────────────────────────────────────────

    private var headline: some View {
        VStack(spacing: 10) {
            ZStack {
                Circle().fill(Theme.bg3).frame(width: 66, height: 66)
                Image(systemName: device.platform.symbolName)
                    .font(.system(size: 28)).foregroundColor(Theme.ink1)
            }
            Text("Approve this sign-in?")
                .font(.zkSans(20, weight: .bold)).foregroundColor(Theme.ink1)
            Text(subtitle)
                .font(.zkSans(13)).foregroundColor(Theme.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var subtitle: String {
        if let username = session.currentUser?.username, !username.isEmpty {
            return "A device wants to sign in as @\(username) — with full access to your account."
        }
        return "A device wants to sign in to your account, with full access to it."
    }

    /// Top of the screen on purpose: comparing this against the other device's
    /// screen is the check that catches a code read to you over the phone.
    private var codeCard: some View {
        VStack(spacing: 8) {
            Text("MAKE SURE THIS MATCHES")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            Text(DeviceLoginCode.grouped(info.userCode))
                .font(.system(size: 28, weight: .semibold, design: .monospaced))
                .kerning(3).foregroundColor(Theme.ink1)
            Text("Only approve if this is exactly the code on the other device's screen.")
                .font(.zkSans(12)).foregroundColor(Theme.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            Text(isExpired ? "This request has expired" : "Expires in \(countdown)")
                .font(.zkSans(12)).monospacedDigit()
                .foregroundColor(isExpired ? Theme.dangerSoft : (secondsLeft <= 30 ? Theme.warning : Theme.ink3))
        }
        .frame(maxWidth: .infinity)
        .padding(16)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var networkWarning: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 16)).foregroundColor(Theme.danger)
            VStack(alignment: .leading, spacing: 4) {
                Text("This device is not on your network")
                    .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.ink1)
                Text("If you aren't standing in front of the device showing this code, deny it — someone else is asking to get into your account.")
                    .font(.zkSans(12)).foregroundColor(Theme.ink2)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.danger.opacity(0.12))
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .strokeBorder(Theme.danger.opacity(0.45), lineWidth: 1)
        )
    }

    /// Server-observed facts. Unforgeable by a remote attacker — this is the
    /// half that actually carries evidence.
    private var observedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            cardHeader(symbol: "checkmark.shield.fill", tint: Theme.success, title: "WHAT ZEKKTRIS CAN SEE")
            factRow(
                "Network",
                device.sameNetwork ? "Same network as this phone" : "Not on your network",
                tint: device.sameNetwork ? Theme.success : Theme.dangerSoft,
                emphasized: !device.sameNetwork,
            )
            factRow("IP address", device.ipAddress ?? "Unknown", mono: device.ipAddress != nil)
            factRow(
                "Location", device.approxLocation ?? "Unavailable",
                tint: device.approxLocation == nil ? Theme.ink3 : Theme.ink1,
            )
            factRow("Started", requestedAgo)
            Text("Zekktris observed these itself. Someone in another country can't fake them.")
                .font(.zkSans(11)).foregroundColor(Theme.ink3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    /// Everything the requesting device said about itself. Decoration with a
    /// health warning — never presented as fact.
    private var claimedCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            cardHeader(symbol: "questionmark.circle.fill", tint: Theme.warning, title: "WHAT THE DEVICE SAYS IT IS")
            factRow("Device", device.declaredName ?? "Not given")
            factRow("Platform", device.platform.label)
            factRow("Language", device.locale ?? "Unknown")
            if let agent = device.userAgent, !agent.isEmpty {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Browser or app").font(.zkSans(13)).foregroundColor(Theme.ink3)
                    Text(agent)
                        .font(.system(size: 11, design: .monospaced)).foregroundColor(Theme.ink2)
                        .lineLimit(showFullAgent ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .contentShape(Rectangle())
                        .onTapGesture { showFullAgent.toggle() }
                }
            }
            Text("The device typed these about itself, so they can be faked — an attacker will happily call themselves “Your iPhone”.")
                .font(.zkSans(11)).foregroundColor(Theme.warning)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(14)
        .frame(maxWidth: .infinity)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private var cautionLine: some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: "hand.raised.fill").font(.system(size: 12)).foregroundColor(Theme.ink3)
            Text("Nobody from Zekktris will ever ask you to approve a sign-in or read out a code. If somebody asked you to do this, deny it.")
                .font(.zkSans(12)).foregroundColor(Theme.ink2)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    @ViewBuilder
    private var decisionArea: some View {
        switch outcome {
        case .undecided:
            if isExpired {
                VStack(spacing: 10) {
                    Text("This request expired before you answered. Nothing was signed in — start again on the other device.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink2)
                        .multilineTextAlignment(.center)
                        .fixedSize(horizontal: false, vertical: true)
                    doneButton
                }
            } else {
                buttons
            }
        case .working:
            ProgressView().tint(Theme.accent).frame(maxWidth: .infinity, minHeight: 52)
        case .approved:
            resultCard(
                symbol: "checkmark.circle.fill", tint: Theme.success, title: "Approved",
                body: "That device is signing in now. If it doesn't, start the sign-in on it again.",
            )
        case .denied:
            resultCard(
                symbol: "hand.raised.fill", tint: Theme.ink2, title: "Denied",
                body: "That device was not signed in, and your account is untouched.",
            )
        case .failed(let message):
            VStack(spacing: 12) {
                Text(message).font(.zkSans(13)).foregroundColor(Theme.dangerSoft)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                doneButton
            }
        }
    }

    /// Equal size, equal weight, side by side — Deny first and nearest the
    /// thumb. Approve is never the styled-in "obvious" answer.
    private var buttons: some View {
        HStack(spacing: 12) {
            Button { decide(approve: false) } label: {
                Text("Deny")
                    .font(.zkSans(16, weight: .semibold)).foregroundColor(Theme.dangerSoft)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(Theme.bg3)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Theme.danger.opacity(0.5), lineWidth: 1)
                    )
            }
            Button {
                // Extra friction exactly where the risk is: an off-network
                // request is the shape every remote phish takes.
                if device.sameNetwork { decide(approve: true) } else { confirmRemote = true }
            } label: {
                Text("Approve")
                    .font(.zkSans(16, weight: .semibold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity, minHeight: 52)
                    .background(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
        }
    }

    private var doneButton: some View {
        Button { onFinished() } label: {
            Text("Done")
                .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                .frame(maxWidth: .infinity, minHeight: 48)
                .background(Theme.accent)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func resultCard(symbol: String, tint: Color, title: String, body: String) -> some View {
        VStack(spacing: 12) {
            Image(systemName: symbol).font(.system(size: 34)).foregroundColor(tint)
            Text(title).font(.zkSans(17, weight: .semibold)).foregroundColor(Theme.ink1)
            Text(body).font(.zkSans(13)).foregroundColor(Theme.ink2)
                .multilineTextAlignment(.center)
                .fixedSize(horizontal: false, vertical: true)
            doneButton
        }
        .padding(18)
        .frame(maxWidth: .infinity)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func cardHeader(symbol: String, tint: Color, title: String) -> some View {
        HStack(spacing: 6) {
            Image(systemName: symbol).font(.system(size: 12)).foregroundColor(tint)
            Text(title).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
        }
    }

    private func factRow(
        _ label: String, _ value: String,
        tint: Color = Theme.ink1, mono: Bool = false, emphasized: Bool = false
    ) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Text(label).font(.zkSans(13)).foregroundColor(Theme.ink3)
            Spacer(minLength: 12)
            Text(value)
                .font(mono
                      ? .system(size: 13, weight: .regular, design: .monospaced)
                      : .zkSans(13, weight: emphasized ? .semibold : .regular))
                .foregroundColor(tint)
                .multilineTextAlignment(.trailing)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    // ── Behaviour ───────────────────────────────────────────────────────────

    private var countdown: String {
        let seconds = max(0, secondsLeft)
        return String(format: "%d:%02d", seconds / 60, seconds % 60)
    }

    private static let isoFractional: ISO8601DateFormatter = {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return formatter
    }()
    private static let isoPlain = ISO8601DateFormatter()

    private var requestedAgo: String {
        let raw = device.requestedAt
        guard let date = Self.isoFractional.date(from: raw) ?? Self.isoPlain.date(from: raw) else {
            return "Just now"
        }
        let seconds = Int(Date().timeIntervalSince(date))
        if seconds < 5 { return "Just now" }
        if seconds < 60 { return "\(seconds) seconds ago" }
        let minutes = seconds / 60
        return minutes == 1 ? "1 minute ago" : "\(minutes) minutes ago"
    }

    private func decide(approve: Bool) {
        guard outcome == .undecided else { return }
        outcome = .working
        let userCode = DeviceLoginCode.normalize(info.userCode)
        Task {
            do {
                if approve {
                    try await APIClient.shared.approveDeviceLogin(userCode: userCode)
                } else {
                    try await APIClient.shared.denyDeviceLogin(userCode: userCode)
                }
                outcome = approve ? .approved : .denied
            } catch {
                outcome = .failed(Self.decisionMessage(error, approving: approve))
            }
        }
    }

    private static func decisionMessage(_ error: Error, approving: Bool) -> String {
        guard let apiError = error as? APIError else {
            return "Couldn't reach Zekktris, so nothing was \(approving ? "approved" : "denied"). Check your connection and try again."
        }
        switch apiError.status {
        case 404:
            return "That request is gone — it expired, or it was already answered. Nothing was signed in."
        case 409:
            return "That request was already answered somewhere else."
        case 429:
            return "Too many tries. Wait a minute, then try again."
        default:
            return apiError.message
        }
    }
}

/// Camera sheet for reading the new device's QR. Owns the permission dance so
/// a denied camera shows a way out instead of a black rectangle.
/// NSCameraUsageDescription is set in Info.plist.
struct DeviceLoginScannerSheet: View {
    let onCode: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var authorized: Bool?

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()
            switch authorized {
            case true:
                QRScannerView { raw in onCode(raw) }
                    .ignoresSafeArea()
                cameraOverlay
            case false:
                deniedBody
            default:
                ProgressView().tint(.white)
            }
        }
        .task {
            switch AVCaptureDevice.authorizationStatus(for: .video) {
            case .authorized: authorized = true
            case .notDetermined: authorized = await AVCaptureDevice.requestAccess(for: .video)
            default: authorized = false
            }
        }
    }

    private var cameraOverlay: some View {
        VStack(spacing: 0) {
            HStack {
                Button { dismiss() } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 16, weight: .semibold)).foregroundColor(.white)
                        .frame(width: 44, height: 44)
                        .background(Color.black.opacity(0.45), in: Circle())
                }
                .accessibilityLabel("Close")
                Spacer()
            }
            .padding(.horizontal, 12)
            .padding(.top, 8)
            Spacer()
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .strokeBorder(Color.white.opacity(0.9), lineWidth: 3)
                .frame(width: 240, height: 240)
            Spacer()
            Text("Point at the code on the device you're signing in")
                .font(.zkSans(14, weight: .medium)).foregroundColor(.white)
                .multilineTextAlignment(.center)
                .shadow(radius: 4)
                .padding(.horizontal, 32)
                .padding(.bottom, 44)
        }
    }

    private var deniedBody: some View {
        VStack(spacing: 14) {
            Image(systemName: "camera.fill").font(.system(size: 32)).foregroundColor(.white.opacity(0.7))
            Text("Camera access is off")
                .font(.zkSans(17, weight: .semibold)).foregroundColor(.white)
            Text("Turn the camera on for Zekktris to scan a code — or close this and type the code in instead.")
                .font(.zkSans(13)).foregroundColor(.white.opacity(0.75))
                .multilineTextAlignment(.center)
            Button {
                if let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                }
            } label: {
                Text("Open Settings").font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity, minHeight: 48)
                    .background(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            Button("Type the code instead") { dismiss() }
                .font(.zkSans(14)).foregroundColor(.white.opacity(0.8))
        }
        .padding(28)
        .frame(maxWidth: 400)
    }
}

// MARK: - Quick login (log in on another device) — DEPRECATED
//
// The old direction: the SIGNED-IN device minted a code and the logged-out one
// redeemed it, which made the displayed code the entire credential — anyone
// who read it off the screen owned the account. Replaced by the
// device-approval flow above; both entry points now open the new sheets, so
// nothing below is reachable. Kept compiling only until the
// `/auth/quick-login/*` routes are removed (checklist:
// apps/api/src/routes/auth.ts:415), which is when these views,
// Session.generateQuickLoginCode/cancelQuickLoginCode/redeemQuickLogin,
// APIClient's three quick-login methods and the QuickLoginCode model all go.
// QRScannerView (bottom of this file) is NOT part of that — the new flow uses
// it.

/// Redeem a quick-login code shown on another (signed-in) device: scan the QR
/// or type the 16-digit code. On success Session.redeemQuickLogin persists the
/// new session and the whole auth flow unmounts into the app.
struct QuickLoginRedeemSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var scanning = false
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("On a device you're already signed in on, open Settings → Log in on another device, then scan the QR or enter the 16-digit code shown there.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        .fixedSize(horizontal: false, vertical: true)

                    Button { scanning = true } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 15))
                            Text("Scan QR code").font(.zkSans(15, weight: .semibold))
                        }
                        .foregroundColor(Theme.ink1)
                        .frame(maxWidth: .infinity).padding(.vertical, 12)
                        .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text("OR ENTER CODE").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        TextField("16-digit code", text: $code)
                            .keyboardType(.numberPad)
                            .autocorrectionDisabled()
                            .font(.system(size: 17, design: .monospaced)).foregroundColor(Theme.ink1)
                            .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    if let error {
                        Text(error).font(.zkSans(13)).foregroundColor(Theme.danger)
                    }

                    Button { submit(code) } label: {
                        Text(busy ? "Signing in…" : "Sign in")
                            .font(.zkSans(16, weight: .semibold)).foregroundColor(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 12)
                            .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .disabled(busy || extractCode(code).count < 6)
                }
                .padding(20)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Log in with another device")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold))
                            .foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close")
                }
            }
            .sheet(isPresented: $scanning) {
                QRScannerView { raw in
                    scanning = false
                    submit(raw)
                }
            }
        }
    }

    /// Pull the 16-digit code out of a scanned URL (…?c=<digits>) or bare digits.
    private func extractCode(_ s: String) -> String {
        if let r = s.range(of: "c=") {
            let digits = s[r.upperBound...].prefix { $0.isNumber }
            if digits.count >= 6 { return String(digits) }
        }
        return s.filter(\.isNumber)
    }

    private func submit(_ raw: String) {
        let c = extractCode(raw)
        guard c.count >= 6 else {
            error = "Enter the code shown on your other device."
            return
        }
        busy = true; error = nil
        Task {
            let ok = await session.redeemQuickLogin(code: c)
            busy = false
            if ok {
                dismiss() // app flips to signed-in via persist()
            } else {
                error = session.authError ?? "Could not sign in with that code."
            }
        }
    }
}

/// Minimal AVFoundation QR scanner. Fires `onCode` once with the decoded string
/// on the main queue. Camera permission uses the existing NSCameraUsageDescription.
struct QRScannerView: UIViewControllerRepresentable {
    let onCode: (String) -> Void

    func makeCoordinator() -> Coordinator { Coordinator(onCode: onCode) }
    func makeUIViewController(context: Context) -> ScannerVC {
        let vc = ScannerVC()
        vc.coordinator = context.coordinator
        return vc
    }
    func updateUIViewController(_ vc: ScannerVC, context: Context) {}

    final class Coordinator: NSObject, AVCaptureMetadataOutputObjectsDelegate {
        let onCode: (String) -> Void
        var handled = false
        init(onCode: @escaping (String) -> Void) { self.onCode = onCode }
        func metadataOutput(_ output: AVCaptureMetadataOutput,
                            didOutput metadataObjects: [AVMetadataObject],
                            from connection: AVCaptureConnection) {
            guard !handled,
                  let obj = metadataObjects.first as? AVMetadataMachineReadableCodeObject,
                  let str = obj.stringValue else { return }
            handled = true
            // Delegate is registered with `queue: .main`, so we're already on
            // the main thread — call directly (no @Sendable dispatch capture).
            onCode(str)
        }
    }

    final class ScannerVC: UIViewController {
        weak var coordinator: Coordinator?
        private let captureSession = AVCaptureSession()
        private var preview: AVCaptureVideoPreviewLayer?
        private let sessionQueue = DispatchQueue(label: "zk.qrscanner")

        override func viewDidLoad() {
            super.viewDidLoad()
            view.backgroundColor = .black
            guard let device = AVCaptureDevice.default(for: .video),
                  let input = try? AVCaptureDeviceInput(device: device),
                  captureSession.canAddInput(input) else { return }
            captureSession.addInput(input)
            let output = AVCaptureMetadataOutput()
            guard captureSession.canAddOutput(output) else { return }
            captureSession.addOutput(output)
            output.setMetadataObjectsDelegate(coordinator, queue: .main)
            output.metadataObjectTypes = [.qr]
            let layer = AVCaptureVideoPreviewLayer(session: captureSession)
            layer.videoGravity = .resizeAspectFill
            view.layer.addSublayer(layer)
            preview = layer
            sessionQueue.async { self.captureSession.startRunning() }
        }
        override func viewDidLayoutSubviews() {
            super.viewDidLayoutSubviews()
            preview?.frame = view.bounds
        }
        override func viewWillDisappear(_ animated: Bool) {
            super.viewWillDisappear(animated)
            sessionQueue.async { if self.captureSession.isRunning { self.captureSession.stopRunning() } }
        }
    }
}
