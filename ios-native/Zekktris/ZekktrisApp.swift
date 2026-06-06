import SwiftUI

@main
struct ZekktrisApp: App {
    @UIApplicationDelegateAdaptor(AppDelegate.self) private var appDelegate
    @StateObject private var session = Session()
    @StateObject private var store = AppStore()

    var body: some Scene {
        WindowGroup {
            RootView()
                .environmentObject(session)
                .environmentObject(store)
                .environmentObject(store.voice)
                .preferredColorScheme(.dark)
                .tint(Theme.accent)
        }
    }
}

/// Top-level router: loading spinner → auth flow → main app. Starts and stops
/// the data/gateway layer in response to auth phase changes.
struct RootView: View {
    @EnvironmentObject private var session: Session
    @EnvironmentObject private var store: AppStore
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        ZStack {
            Theme.bg1.ignoresSafeArea()

            switch session.phase {
            case .loading:
                ProgressView()
                    .tint(Theme.accent)
            case .signedOut:
                AuthFlowView()
            case .signedIn:
                if session.locked {
                    LockView()
                } else {
                    MainView()
                }
            }
        }
        .task { await session.bootstrap() }
        .onChange(of: scenePhase) { newPhase in
            // Biometric lock is required once per cold launch (set in bootstrap),
            // not on every background — the session stays unlocked until the app
            // is fully closed. We only refresh the gateway when returning.
            if newPhase == .active {
                store.foregroundReconnect()
            }
        }
        .onChange(of: session.phase) { phase in
            switch phase {
            case .signedIn:
                if let token = session.token { store.start(token: token, user: session.currentUser) }
                PushManager.shared.requestAuthorizationAndRegister()
                PushManager.shared.registerWithServerIfPossible()
            case .signedOut:
                PushManager.shared.unregister()
                store.stop()
            case .loading:
                break
            }
        }
    }
}

/// Switches between sign-in and registration.
struct AuthFlowView: View {
    @State private var showRegister = false

    var body: some View {
        if showRegister {
            RegisterView(switchToLogin: { showRegister = false })
        } else {
            LoginView(switchToRegister: { showRegister = true })
        }
    }
}

/// Biometric lock screen shown over a signed-in session when Face ID /
/// Touch ID unlock is enabled. Prompts automatically on appear.
struct LockView: View {
    @EnvironmentObject private var session: Session

    var body: some View {
        ZStack {
            Theme.bg0.ignoresSafeArea()
            VStack(spacing: 22) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundColor(Theme.accent)
                Text("Zekktris is locked")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundColor(Theme.ink1)
                Button { Task { await session.unlock() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "faceid")
                        Text("Unlock with \(Biometrics.typeLabel)")
                            .font(.system(size: 15, weight: .semibold))
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(Theme.accent).clipShape(Capsule())
                }
            }
        }
        .task { await session.unlock() }
    }
}
