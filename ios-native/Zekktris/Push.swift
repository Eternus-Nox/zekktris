import Foundation
import UIKit
import UserNotifications

/// Coordinates APNs registration. The device token arrives asynchronously via
/// the app delegate; we register it with the server once both the token and a
/// logged-in session are available (whichever comes last).
@MainActor
final class PushManager: ObservableObject {
    static let shared = PushManager()

    private(set) var apnsTokenHex: String?

    /// Ask for notification permission and, if granted, register for remote
    /// notifications. Safe to call repeatedly (the system prompt shows once).
    func requestAuthorizationAndRegister() {
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            guard granted else { return }
            DispatchQueue.main.async {
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Called by the app delegate when APNs hands us a token.
    func didRegister(tokenData: Data) {
        apnsTokenHex = tokenData.map { String(format: "%02x", $0) }.joined()
        registerWithServerIfPossible()
    }

    /// POST the token to the server if we have one and we're signed in.
    func registerWithServerIfPossible() {
        guard let token = apnsTokenHex, APIClient.shared.token != nil else { return }
        Task { await APIClient.shared.registerDeviceToken(token: token) }
    }

    /// Best-effort unregister on logout.
    func unregister() {
        guard let token = apnsTokenHex else { return }
        Task { await APIClient.shared.unregisterDeviceToken(token: token) }
    }
}

/// Minimal app delegate, bridged into the SwiftUI App via
/// `@UIApplicationDelegateAdaptor`, to receive the APNs token and do
/// one-time process setup.
final class AppDelegate: NSObject, UIApplicationDelegate {
    func application(
        _ application: UIApplication,
        didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil
    ) -> Bool {
        // AsyncImage (avatars, banners, attachments, emoji) loads through
        // URLSession.shared, whose default URLCache is tiny. A bigger cache
        // means scrollback and the member list stop re-fetching the same
        // avatars over and over.
        URLCache.shared = URLCache(
            memoryCapacity: 32 * 1024 * 1024,   // 32 MB
            diskCapacity: 256 * 1024 * 1024     // 256 MB
        )
        return true
    }

    func application(_ application: UIApplication,
                     didRegisterForRemoteNotificationsWithDeviceToken deviceToken: Data) {
        Task { @MainActor in PushManager.shared.didRegister(tokenData: deviceToken) }
    }

    func application(_ application: UIApplication,
                     didFailToRegisterForRemoteNotificationsWithError error: Error) {
        // No-op: push simply won't be available (e.g. no entitlement / simulator).
    }
}
