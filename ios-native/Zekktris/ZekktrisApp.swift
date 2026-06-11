import SwiftUI
import UIKit

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
                // Web parity: body text defaults to Space Grotesk at the
                // 15px base the web sets via `html { font-size: 15px }`.
                // Explicit .font modifiers still override per-view.
                .environment(\.font, .zkSans(15))
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

            // App-wide, observe-only touch/scroll detection → keeps auto-
            // presence "online" while actively reading/scrolling. Non-
            // interactive itself; installs window-level recognizers.
            WindowInteractionInstaller { [weak store] in
                store?.noteInteraction(evaluate: false)
            }
            .allowsHitTesting(false)
            .frame(width: 0, height: 0)

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
            // Feed foreground/background into the auto-presence state machine
            // (foreground+activity → online; background → offline via disconnect).
            store.setAppActive(newPhase == .active)
        }
        .onChange(of: session.phase) { phase in
            switch phase {
            case .signedIn:
                if let token = session.token { store.start(token: token, user: session.currentUser) }
                // Auto-presence: reuse Session.setStatus to push the effective
                // status, and read the chosen status from the live user.
                store.autoStatusPush = { [weak session] status in await session?.setStatus(status) }
                store.currentChosenStatus = { [weak session] in session?.currentUser?.status ?? "online" }
                PushManager.shared.requestAuthorizationAndRegister()
                PushManager.shared.registerWithServerIfPossible()
                VoipPushHandler.shared.registerWithServerIfPossible()
            case .signedOut:
                // Push-token unregister now happens inside Session.logout()
                // BEFORE session revocation (so the DELETEs are still
                // authenticated and the server stops ringing this device).
                store.stop()
            case .loading:
                break
            }
        }
    }
}

/// App-wide, observe-only interaction detector for auto-presence. Installs a
/// tap + pan recognizer on the key window so ANY touch or scroll resets the
/// idle clock — without ever consuming or blocking the app's own gestures.
///
/// Non-interference: both recognizers use `cancelsTouchesInView = false` and a
/// delegate that returns `true` for `shouldRecognizeSimultaneouslyWith` (and
/// receives every touch), so they recognize ALONGSIDE buttons / scroll views /
/// text fields and never call `require(toFail:)` on anything. They only fire a
/// callback; the underlying views still get every touch unchanged.
///
/// Performance: the callback is the cheap path (timestamp-only); pan fires many
/// times per scroll, so we never re-evaluate/PATCH here.
final class InteractionWatcher: NSObject, UIGestureRecognizerDelegate {
    static let shared = InteractionWatcher()
    private var installed = false
    private var onInteraction: (@MainActor () -> Void)?

    @MainActor
    func install(in window: UIWindow, onInteraction: @escaping @MainActor () -> Void) {
        guard !installed else { return }
        installed = true
        self.onInteraction = onInteraction
        let tap = UITapGestureRecognizer(target: self, action: #selector(noted))
        let pan = UIPanGestureRecognizer(target: self, action: #selector(noted))
        for recognizer in [tap, pan] as [UIGestureRecognizer] {
            recognizer.cancelsTouchesInView = false
            recognizer.delaysTouchesBegan = false
            recognizer.delaysTouchesEnded = false
            recognizer.delegate = self
            window.addGestureRecognizer(recognizer)
        }
    }

    @objc private func noted() {
        // Gesture-recognizer actions are delivered on the main thread, so we're
        // already on the main actor — call the @MainActor callback synchronously.
        MainActor.assumeIsolated { onInteraction?() }
    }

    // Observe-only: never block (or be blocked by) the app's own recognizers,
    // and receive touches everywhere (controls, scroll views, text fields).
    func gestureRecognizer(
        _ g: UIGestureRecognizer,
        shouldRecognizeSimultaneouslyWith other: UIGestureRecognizer
    ) -> Bool { true }
    func gestureRecognizer(_ g: UIGestureRecognizer, shouldReceive touch: UITouch) -> Bool { true }
}

/// Zero-size, non-interactive bridge that locates the host UIWindow and installs
/// the InteractionWatcher once. Lives in the SwiftUI tree; never intercepts.
struct WindowInteractionInstaller: UIViewRepresentable {
    let onInteraction: @MainActor () -> Void

    func makeUIView(context: Context) -> ProbeView { ProbeView(onInteraction: onInteraction) }
    func updateUIView(_ uiView: ProbeView, context: Context) {}

    /// Non-interactive probe: installs the watcher the moment it gains a window
    /// (`didMoveToWindow` is the reliable attach hook). install() is idempotent.
    final class ProbeView: UIView {
        private let onInteraction: @MainActor () -> Void
        init(onInteraction: @escaping @MainActor () -> Void) {
            self.onInteraction = onInteraction
            super.init(frame: .zero)
            isUserInteractionEnabled = false // never participates in hit-testing
            backgroundColor = .clear
        }
        @available(*, unavailable) required init?(coder: NSCoder) { fatalError() }
        override func didMoveToWindow() {
            super.didMoveToWindow()
            if let window {
                InteractionWatcher.shared.install(in: window, onInteraction: onInteraction)
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
    @State private var bioLabel = "Face ID"

    var body: some View {
        ZStack {
            Theme.bg0.ignoresSafeArea()
            VStack(spacing: 22) {
                Image(systemName: "lock.fill")
                    .font(.system(size: 44))
                    .foregroundColor(Theme.accent)
                Text("Zekktris is locked")
                    .font(.zkSans(18, weight: .semibold))
                    .foregroundColor(Theme.ink1)
                Button { Task { await session.unlock() } } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "faceid")
                        Text("Unlock with \(bioLabel)")
                            .font(.zkSans(15, weight: .semibold))
                    }
                    .foregroundColor(.white)
                    .padding(.horizontal, 20).padding(.vertical, 12)
                    .background(Theme.accent).clipShape(Capsule())
                }
            }
        }
        .task {
            bioLabel = (await Biometrics.resolve()).label
            await session.unlock()
        }
    }
}
