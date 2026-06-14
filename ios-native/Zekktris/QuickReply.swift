import Foundation
import UserNotifications

/// Sends a reply typed from a notification — the "Reply" action, whether typed
/// on the iPhone keyboard or dictated/scribbled from a paired Apple Watch.
///
/// Deliberately self-contained: iOS may launch the app into the background just
/// to handle the reply, before the normal UI / `Session.bootstrap()` has run.
/// So this restores the access token straight from the Keychain and posts
/// through `APIClient` rather than relying on `AppStore` being set up. The sent
/// message arrives back via the gateway when the app is (or next becomes)
/// running, so there's no optimistic UI to manage here.
enum QuickReply {
    /// Post `text` to `channelId`. For an encrypted conversation the text is
    /// encrypted on-device first with the per-DM key from the Keychain. If that
    /// key isn't present (the conversation is locked on this device) we do NOT
    /// send plaintext into an encrypted channel — we surface a local
    /// notification asking the user to open the app instead.
    static func send(channelId: String, text: String, isE2EE: Bool) async {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }

        let api = APIClient.shared
        if api.token == nil {
            // Background launch: APIClient wasn't bootstrapped. Session persists
            // the access token under "accessToken"; APIClient refreshes it via
            // the /auth/refresh cookie on a 401, so a slightly stale token here
            // is fine.
            api.token = KeychainStore().get("accessToken")
        }
        guard api.token?.isEmpty == false else {
            await notify(channelId: channelId, "Open Zekktris to reply.")
            return
        }

        var wire = trimmed
        if isE2EE {
            guard let key = e2eeKey(forChannel: channelId) else {
                await notify(channelId: channelId, "Unlock this conversation in Zekktris to reply.")
                return
            }
            guard let enc = E2EE.encrypt(trimmed, key: key) else {
                await notify(channelId: channelId, "Couldn't encrypt your reply.")
                return
            }
            wire = enc
        }

        do {
            _ = try await api.sendMessage(
                channelId: channelId, content: wire, nonce: UUID().uuidString)
        } catch {
            await notify(channelId: channelId, "Couldn't send your reply — tap to open Zekktris.")
        }
    }

    /// Per-DM E2EE key by channel id, without needing the signed-in user id (a
    /// background launch may not have it). Tries the shared app-group keychain
    /// first, then the app's default group, matching the channel suffix of the
    /// `e2ee.<userId>.<channelId>` account. Mirrors the extension's lookup.
    private static func e2eeKey(forChannel channelId: String) -> Data? {
        let suffix = ".\(channelId)"
        for store in [KeychainStore(accessGroup: AppGroupConfig.identifier), KeychainStore()] {
            for (account, b64) in store.allValues(prefix: "e2ee.") where account.hasSuffix(suffix) {
                if let bytes = Data(base64Encoded: b64), bytes.count == E2EE.keyBytes {
                    return bytes
                }
            }
        }
        return nil
    }

    /// The notification reply field gives no success/failure feedback on its
    /// own, so on failure we post a local notification (tapping it opens the
    /// conversation via the normal channelId routing).
    private static func notify(channelId: String, _ body: String) async {
        let content = UNMutableNotificationContent()
        content.title = "Zekktris"
        content.body = body
        content.userInfo = ["channelId": channelId]
        let request = UNNotificationRequest(
            identifier: "reply-failed-\(channelId)", content: content, trigger: nil)
        try? await UNUserNotificationCenter.current().add(request)
    }
}
