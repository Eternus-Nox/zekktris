import Foundation
import UIKit
import UserNotifications

/// Cross-component notification routing (Push → AppStore). The store
/// subscribes; the notification delegate posts.
extension Notification.Name {
    /// object: [String: Any] with "channelId" (String) and "autojoin" (Bool).
    static let zkOpenChannel = Notification.Name("zk.push.openChannel")
    /// object: [String: Any] with "channelId" (String) and "action" ("accept"|"decline").
    static let zkCallAction = Notification.Name("zk.push.callAction")
}

/// Coordinates APNs registration. The device token arrives asynchronously via
/// the app delegate; we register it with the server once both the token and a
/// logged-in session are available (whichever comes last).
@MainActor
final class PushManager: ObservableObject {
    static let shared = PushManager()

    private(set) var apnsTokenHex: String?

    /// System notification permission, surfaced for the Settings panel.
    @Published private(set) var authStatus: UNAuthorizationStatus = .notDetermined
    /// Whether the device token was accepted by the server this session.
    @Published private(set) var registeredWithServer = false

    /// Re-read the system permission (call on appear/foreground).
    func refreshStatus() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            Task { @MainActor in self.authStatus = settings.authorizationStatus }
        }
    }

    /// Jump to this app's page in the system Settings (for re-enabling a
    /// denied permission — apps can't re-prompt once denied).
    func openSystemSettings() {
        if let url = URL(string: UIApplication.openSettingsURLString) {
            UIApplication.shared.open(url)
        }
    }

    /// Ask for notification permission and, if granted, register for remote
    /// notifications. Safe to call repeatedly (the system prompt shows once).
    func requestAuthorizationAndRegister() {
        registerCategories()
        UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) { granted, _ in
            Task { @MainActor in
                self.refreshStatus()
                guard granted else { return }
                UIApplication.shared.registerForRemoteNotifications()
            }
        }
    }

    /// Notification categories: the "call" category carries inline
    /// Answer/Decline buttons (matched against the server's action ids).
    private func registerCategories() {
        let answer = UNNotificationAction(
            identifier: "accept-call", title: "Answer", options: [.foreground])
        let decline = UNNotificationAction(
            identifier: "decline-call", title: "Decline", options: [.destructive])
        let call = UNNotificationCategory(
            identifier: "call", actions: [answer, decline],
            intentIdentifiers: [], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([call])
    }

    /// Called by the app delegate when APNs hands us a token.
    func didRegister(tokenData: Data) {
        apnsTokenHex = tokenData.map { String(format: "%02x", $0) }.joined()
        registerWithServerIfPossible()
    }

    /// POST the token to the server if we have one and we're signed in.
    func registerWithServerIfPossible() {
        guard let token = apnsTokenHex, APIClient.shared.token != nil else { return }
        Task {
            let ok = await APIClient.shared.registerDeviceToken(token: token)
            await MainActor.run { self.registeredWithServer = ok }
        }
    }

    /// Best-effort unregister on logout.
    func unregister() {
        guard let token = apnsTokenHex else { return }
        Task { await APIClient.shared.unregisterDeviceToken(token: token) }
    }
}

/// Handles delivered notifications: foreground presentation policy, taps
/// (deep-link to the channel), and the call category's Answer/Decline
/// actions. Talks to the store via NotificationCenter so it stays free of
/// app-state dependencies.
final class NotificationDelegate: NSObject, UNUserNotificationCenterDelegate {
    static let shared = NotificationDelegate()

    /// The channel the user is currently reading — set by the store so we
    /// can suppress banners for the conversation already on screen.
    var visibleChannelId: (() -> String?)?

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        willPresent notification: UNNotification,
        withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void
    ) {
        let info = notification.request.content.userInfo
        let kind = info["kind"] as? String
        let defaults = UserDefaults.standard
        if kind == "call" {
            // The gateway + CallKit handle ringing while the app runs; a
            // banner on top would double-ring. (The toggle below governs
            // the banner path used when CallKit declined to ring.)
            completionHandler([])
            return
        }
        // Settings → Notifications: in-app banner toggle for messages.
        if defaults.object(forKey: "zk.notifyMessages") != nil,
           !defaults.bool(forKey: "zk.notifyMessages") {
            completionHandler([])
            return
        }
        // Suppress the banner for the channel that's already open.
        if let cid = Self.channelId(from: info), cid == visibleChannelId?() {
            completionHandler([])
            return
        }
        completionHandler([.banner, .list, .sound])
    }

    func userNotificationCenter(
        _ center: UNUserNotificationCenter,
        didReceive response: UNNotificationResponse,
        withCompletionHandler completionHandler: @escaping () -> Void
    ) {
        let info = response.notification.request.content.userInfo
        let kind = info["kind"] as? String
        let channelId = Self.channelId(from: info)

        switch response.actionIdentifier {
        case "accept-call":
            if let channelId {
                NotificationCenter.default.post(
                    name: .zkCallAction, object: ["channelId": channelId, "action": "accept"])
            }
        case "decline-call":
            if let channelId {
                NotificationCenter.default.post(
                    name: .zkCallAction, object: ["channelId": channelId, "action": "decline"])
            }
        default:
            // Body tap: open the conversation (calls auto-join, matching
            // the web's ?autojoin=1 deeplink).
            if let channelId {
                NotificationCenter.default.post(
                    name: .zkOpenChannel,
                    object: ["channelId": channelId, "autojoin": kind == "call"])
            }
        }
        completionHandler()
    }

    /// Routing data: prefer the explicit channelId; fall back to the last
    /// path component of the deeplink url (`/channels/@me/123?autojoin=1`).
    static func channelId(from info: [AnyHashable: Any]) -> String? {
        if let cid = info["channelId"] as? String { return cid }
        guard let url = info["url"] as? String else { return nil }
        let path = url.split(separator: "?").first.map(String.init) ?? url
        let last = path.split(separator: "/").last.map(String.init)
        return (last?.allSatisfy { $0.isNumber } == true) ? last : nil
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
        UNUserNotificationCenter.current().delegate = NotificationDelegate.shared
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
