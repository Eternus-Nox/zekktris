import SwiftUI
import UIKit
import SafariServices
import AVFoundation

/// The canonical hosted legal-doc URLs. Single source of truth is the web app
/// (zekktris.com/terms, /privacy) so the text never drifts between platforms.
enum LegalURL {
    static let terms = URL(string: "https://zekktris.com/terms")!
    static let privacy = URL(string: "https://zekktris.com/privacy")!
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

    @State private var email = ""
    @State private var password = ""
    @State private var code = ""
    @State private var showForgot = false
    @State private var passkeyBusy = false
    @State private var showQuickLoginRedeem = false
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

                    Button { showQuickLoginRedeem = true } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "qrcode.viewfinder").font(.system(size: 15))
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

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 24)
            .frame(maxWidth: 440)
            .frame(maxWidth: .infinity)
        }
        .background {
            ZStack { Theme.bg1; AbyssBackground() }.ignoresSafeArea()
        }
        .sheet(isPresented: $showForgot) { ForgotPasswordView() }
        .sheet(isPresented: $showQuickLoginRedeem) { QuickLoginRedeemSheet() }
    }

    private func submit() {
        guard canSubmit else { return }
        focus = nil
        let twoFactor = session.needs2FA ? code.trimmingCharacters(in: .whitespaces) : nil
        Task { await session.login(email: email, password: password, code: twoFactor) }
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

    @State private var email = ""
    @State private var username = ""
    @State private var displayName = ""
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

                Spacer(minLength: 0)
            }
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
                dateOfBirth: dobString
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

// MARK: - Quick login (log in on another device)

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
