import SwiftUI
import UIKit

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
                    .frame(width: 64, height: 64)
                ZSigil()
                    .fill(LinearGradient(
                        colors: [Theme.accent, Theme.accent2, Theme.accent3],
                        startPoint: .topLeading, endPoint: .bottomTrailing
                    ))
                    .frame(width: 42, height: 42)
            }
            Text("Zekktris")
                .font(.zkSans(26, weight: .bold))
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
    @State private var showForgot = false
    @FocusState private var focus: Field?
    private enum Field { case email, password }

    private var canSubmit: Bool { !email.isEmpty && !password.isEmpty }

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
                        submitLabel: .go, onSubmit: submit
                    )
                    .focused($focus, equals: .password)
                }

                HStack {
                    Spacer()
                    Button("Forgot password?") { showForgot = true }
                        .font(.zkSans(13))
                        .foregroundColor(Theme.accent)
                }

                if let error = session.authError {
                    Text(error)
                        .font(.zkSans(13))
                        .foregroundColor(Theme.danger)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }

                PrimaryButton(title: "Sign in", busy: session.busy, enabled: canSubmit, action: submit)

                Button(action: switchToRegister) {
                    Text("Need an account? ")
                        .foregroundColor(Theme.ink3)
                    + Text("Register").foregroundColor(Theme.accent)
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
        .sheet(isPresented: $showForgot) { ForgotPasswordView() }
    }

    private func submit() {
        guard canSubmit else { return }
        focus = nil
        Task { await session.login(email: email, password: password) }
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
    @FocusState private var focus: Field?
    private enum Field { case email, username, displayName, password, repeatPassword }

    private var strength: Int { passwordStrength(password) }
    private var mismatch: Bool { !repeatPassword.isEmpty && repeatPassword != password }
    private var canSubmit: Bool {
        !email.isEmpty && !username.isEmpty && !displayName.isEmpty
            && password.count >= 8 && password == repeatPassword
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
    }

    private func submit() {
        guard canSubmit else { return }
        focus = nil
        Task {
            await session.register(
                email: email, username: username, displayName: displayName, password: password
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
