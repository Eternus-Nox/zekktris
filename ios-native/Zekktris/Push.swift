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

    /// Notification categories (matched against the server's `category`):
    ///  • "call"    — inline Answer/Decline buttons.
    ///  • "message" — an inline **Reply** text field. On iPhone this opens the
    ///    keyboard right on the notification; on a paired Apple Watch the same
    ///    action automatically offers dictation / scribble / canned replies —
    ///    no watchOS app needed. The typed reply is handled in `didReceive`.
    ///
    /// Registered at app LAUNCH (AppDelegate.didFinishLaunchingWithOptions), not
    /// just at sign-in: a push can be delivered/presented on a cold launch
    /// before the sign-in flow runs, and if the category isn't registered yet
    /// iOS shows the notification with no actions (only "Dismiss"). Idempotent.
    func registerCategories() {
        let answer = UNNotificationAction(
            identifier: "accept-call", title: "Answer", options: [.foreground])
        let decline = UNNotificationAction(
            identifier: "decline-call", title: "Decline", options: [.destructive])
        let call = UNNotificationCategory(
            identifier: "call", actions: [answer, decline],
            intentIdentifiers: [], options: [])
        let reply = UNTextInputNotificationAction(
            identifier: "reply", title: "Reply", options: [],
            textInputButtonTitle: "Send", textInputPlaceholder: "Message")
        let message = UNNotificationCategory(
            identifier: "message", actions: [reply],
            // Tells Siri this category is a message conversation, which is what
            // lets a spoken "reply" after an AirPods announcement land on the
            // Reply action above. Pairs with the communication styling the
            // Notification Service Extension applies (see
            // NotificationService.swift); without both, Siri reads the message
            // out but can't take an answer.
            intentIdentifiers: ["INSendMessageIntent"], options: [])
        UNUserNotificationCenter.current().setNotificationCategories([call, message])
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
    /// The POST result is now CHECKED: a silent failure here is how the
    /// account ends up with zero voip rows server-side (= incoming calls
    /// stop ringing CallKit until a luckier foreground). One delayed retry
    /// covers the cold-launch races (radio waking, token refresh in flight);
    /// beyond that the next foreground re-asserts anyway.
    func registerWithServerIfPossible() {
        guard let token = voipTokenHex, APIClient.shared.token != nil else { return }
        Task {
            let first = await APIClient.shared.registerDeviceToken(token: token, platform: "ios_voip")
            // .serverUnconfigured = the server SAID push isn't set up — a
            // retry can't change that; the next foreground re-asserts anyway.
            guard first == .failed else { return }
            try? await Task.sleep(nanoseconds: 5_000_000_000)
            // Re-read the CURRENT token — PushKit may have rotated it while
            // we slept, and the session may have signed out.
            guard let fresh = self.voipTokenHex, APIClient.shared.token != nil else { return }
            let second = await APIClient.shared.registerDeviceToken(token: fresh, platform: "ios_voip")
            if second == .failed {
                print("[zk] voip token registration failed twice — CallKit may not ring until next foreground")
            }
        }
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
                // ALWAYS report the real incoming call. (We previously tried to
                // suppress a duplicate CallKit ring when an in-app overlay was
                // already showing or we were already in the channel, by
                // reporting a throwaway placeholder instead — but stale
                // voiceChannelId/incomingCall state could make that suppress a
                // REAL call, so the phone never rang. A possible double-ring in
                // the foreground is the lesser evil than a missed call; CallKit's
                // reportIncoming is idempotent per channel, so a true duplicate
                // for the same channel no-ops anyway.)
                CallManager.shared.reportIncoming(channelId: channelId, callerName: callerName)
                // Connect the gateway so the caller's HANGUP arrives as a normal
                // event while the CallKit ring is active (iOS grants background
                // runtime for an active call). This dismisses the ring when the
                // caller cancels — the gateway WS is otherwise iOS-suspended in
                // the background, so the server's cancel event never reaches us.
                // Best-effort and AFTER the synchronous reportIncoming above, so
                // Apple's reportNewIncomingCall-before-return rule is honored.
                // The token is keychain-readable while locked (AfterFirstUnlock).
                if let token = KeychainStore().get("accessToken"), !token.isEmpty {
                    APIClient.shared.token = token
                    AppStore.shared?.ensureGatewayConnected(token: token, user: nil)
                }
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

        // Achievement-unlock notifications have no channel to open — tapping
        // just brings the app forward.
        if kind == "achievement" {
            completionHandler()
            return
        }

        // Inline reply (notification "Reply" field — iPhone keyboard or Apple
        // Watch). Sending is async, so we hold the completion handler until the
        // post finishes. Done in a self-contained sender (QuickReply) because
        // iOS may launch the app into the background just for this, before the
        // normal UI/session bootstrap has run.
        if response.actionIdentifier == "reply",
           let channelId,
           let textResponse = response as? UNTextInputNotificationResponse {
            let text = textResponse.userText
            let isE2EE = (info["isE2EE"] as? Bool)
                ?? (info["isE2EE"] as? NSNumber)?.boolValue ?? false
            // `@MainActor` is REQUIRED, not cosmetic: UNUserNotificationCenter's
            // completionHandler must be invoked on the main thread — UIKit runs
            // snapshot/state-restoration work inside it
            // (_updateSnapshotAndStateRestorationWithAction: →
            // _performBlockAfterCATransactionCommitSynchronizes:) which asserts
            // main-thread. NotificationDelegate is NOT actor-isolated, so a plain
            // `Task {}` resumed on the cooperative pool after the `await` and
            // called the handler off-main → NSAssertionHandler → abort(). That was
            // the "crashes when I reopen it from suspended" crash (SIGABRT).
            Task { @MainActor in
                await QuickReply.send(channelId: channelId, text: text, isE2EE: isE2EE)
                completionHandler()
            }
            return
        }

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
            // Body tap: open the conversation AND deep-link to the specific
            // message this notification is for (scroll to it; in a guild the
            // composer prefills a reply to its author). Calls auto-join, matching
            // the web's ?autojoin=1 deeplink.
            if let channelId {
                var payload: [String: Any] = ["channelId": channelId, "autojoin": kind == "call"]
                if let messageId = info["messageId"] as? String { payload["messageId"] = messageId }
                NotificationCenter.default.post(name: .zkOpenChannel, object: payload)
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
        // Register notification categories NOW, before any push can be
        // presented — otherwise a cold-launch notification renders with no
        // inline actions (the Reply field for messages, Answer/Decline for
        // calls). Re-registered at sign-in too; idempotent.
        PushManager.shared.registerCategories()
        // VoIP (PushKit) — full CallKit ringing with the app closed.
        VoipPushHandler.shared.start()
        // AsyncImage + RetryingImage (avatars, banners, attachments, emoji) all
        // load through URLSession.shared / URLCache.shared. The server marks CDN
        // images `Cache-Control: public, max-age=1yr, immutable`, so this disk
        // cache persists them across launches (no re-fetch). A bigger DISK tier
        // means banners + attachments don't evict avatars and recent images
        // survive longer; memory is volatile (resets each cold launch) so only
        // the disk tier provides cross-launch persistence.
        // NOTE: this only helps if whatever serves /cdn in production (e.g. Caddy
        // serving the files directly, bypassing the API's /cdn route) ALSO sends
        // those cache headers — otherwise responses aren't stored and images
        // reload every launch regardless of this cache size.
        URLCache.shared = URLCache(
            memoryCapacity: 32 * 1024 * 1024,    // 32 MB
            diskCapacity: 512 * 1024 * 1024      // 512 MB (cross-launch persistence)
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
