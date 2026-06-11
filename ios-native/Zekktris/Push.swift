import Foundation
import UIKit
import UserNotifications
import PushKit

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
    /// Server said 503 — APNs keys missing there. Latched for the session so
    /// we stop re-POSTing a token the server can't use, and Settings can say
    /// why pushes are off.
    @Published private(set) var serverPushUnavailable = false

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

    /// Called by the app delegate when APNs hands us a token. Forces the
    /// server POST even if a 503 was latched earlier — a fresh token is
    /// exactly when the server may have gained its APNs config.
    func didRegister(tokenData: Data) {
        apnsTokenHex = tokenData.map { String(format: "%02x", $0) }.joined()
        registerWithServerIfPossible(force: true)
    }

    /// POST the token to the server if we have one and we're signed in.
    /// No-op after the server has said "APNs not configured" (503) — that
    /// can't change without a server restart, so retrying just spams logs.
    func registerWithServerIfPossible(force: Bool = false) {
        guard let token = apnsTokenHex, APIClient.shared.token != nil else { return }
        guard force || (!serverPushUnavailable && !registeredWithServer) else { return }
        Task {
            let result = await APIClient.shared.registerDeviceToken(token: token)
            await MainActor.run {
                self.registeredWithServer = result == .ok
                self.serverPushUnavailable = result == .serverUnconfigured
            }
        }
    }

    /// Best-effort unregister on logout.
    func unregister() {
        guard let token = apnsTokenHex else { return }
        Task { await APIClient.shared.unregisterDeviceToken(token: token) }
    }
}

/// PushKit VoIP handler — receives call pushes even when the app is closed
/// or force-quit (iOS relaunches us in the background). Apple REQUIRES
/// reporting a CallKit incoming call before the completion handler runs;
/// failing to do so gets the app killed and future voip pushes dropped.
/// The CallKit answer/decline then flow through CallManager's existing
/// onAnswer/onEnd wiring, which the booting AppStore installs.
final class VoipPushHandler: NSObject, PKPushRegistryDelegate {
    static let shared = VoipPushHandler()
    private var registry: PKPushRegistry?
    private(set) var voipTokenHex: String?

    /// Call once at launch (idempotent).
    func start() {
        guard registry == nil else { return }
        let r = PKPushRegistry(queue: .main)
        r.delegate = self
        r.desiredPushTypes = [.voIP]
        registry = r
    }

    /// Re-POST the voip token after sign-in (token may have arrived first).
    func registerWithServerIfPossible() {
        guard let token = voipTokenHex, APIClient.shared.token != nil else { return }
        Task { _ = await APIClient.shared.registerDeviceToken(token: token, platform: "ios_voip") }
    }

    /// Best-effort unregister on logout — without this the server keeps
    /// sending VoIP rings to a signed-out (or account-switched) device, so
    /// every call to the OLD account rings this phone full-screen with a
    /// dead-end answer. See Session.logout for the auth-ordered call.
    func unregister() {
        guard let token = voipTokenHex else { return }
        Task { await APIClient.shared.unregisterDeviceToken(token: token) }
    }

    func pushRegistry(_ registry: PKPushRegistry, didUpdate pushCredentials: PKPushCredentials, for type: PKPushType) {
        guard type == .voIP else { return }
        voipTokenHex = pushCredentials.token.map { String(format: "%02x", $0) }.joined()
        registerWithServerIfPossible()
    }

    func pushRegistry(_ registry: PKPushRegistry, didInvalidatePushTokenFor type: PKPushType) {
        voipTokenHex = nil
    }

    func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        guard type == .voIP else { completion(); return }
        let dict = payload.dictionaryPayload
        let channelId = (dict["channelId"] as? String) ?? ""
        let callerName = (dict["callerName"] as? String) ?? "Incoming call"
        // Apple REQUIRES the incoming call be reported to CallKit BEFORE this
        // method returns. Deferring it (the old `Task { @MainActor in … }`)
        // runs reportNewIncomingCall a run-loop turn too late, so iOS kills
        // the app and stops delivering future VoIP pushes. PKPushRegistry was
        // created with `queue: .main` (see start()), so this delegate callback
        // already runs on the main thread / main actor — assumeIsolated lets us
        // call the @MainActor CallManager synchronously, with no Task hop.
        // (reportIncoming is idempotent per channel, so a duplicate in-app
        // ring from the booting store can't double-ring.)
        MainActor.assumeIsolated {
            if channelId.isEmpty {
                // Malformed push (our server always includes channelId). Apple
                // still requires we report a call before returning, but a
                // call with no channel is unanswerable and the server can't
                // cancel it (its cancel events are keyed by channelId) — so
                // report a placeholder and immediately end it rather than
                // leave an uncancellable ghost ringing on the lock screen.
                let placeholder = UUID().uuidString
                CallManager.shared.reportIncoming(channelId: placeholder, callerName: callerName)
                CallManager.shared.callEnded(channelId: placeholder, remoteEnded: true)
            } else {
                CallManager.shared.reportIncoming(channelId: channelId, callerName: callerName)
            }
        }
        completion()
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
        // VoIP (PushKit) — full CallKit ringing with the app closed.
        VoipPushHandler.shared.start()
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
