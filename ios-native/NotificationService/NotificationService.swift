import UserNotifications

/// Decrypts E2EE DM message previews on-device.
///
/// The server can't decrypt these (it holds only ciphertext), so for an E2EE
/// DM where the recipient opted into content previews it ships the ciphertext
/// (`e2ee`) + channel id (`channelId`) in the push, with `mutable-content: 1`.
/// This extension looks up the channel's key in the shared app-group keychain
/// and rewrites the notification body to the plaintext.
///
/// Fail-safe: if the key isn't on this device (conversation locked), the
/// payload carries no ciphertext, decryption fails, or the 30-second budget
/// expires, the original notification — the "Encrypted message" fallback the
/// server set — is delivered unchanged. The plaintext is never logged or
/// persisted; it lives only in the notification content.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?

    override func didReceive(
        _ request: UNNotificationRequest,
        withContentHandler contentHandler: @escaping (UNNotificationContent) -> Void
    ) {
        self.contentHandler = contentHandler
        let best = request.content.mutableCopy() as? UNMutableNotificationContent
        bestAttempt = best
        guard let best else {
            contentHandler(request.content)
            return
        }

        let info = request.content.userInfo
        guard let wire = info["e2ee"] as? String,
              let channelId = info["channelId"] as? String,
              E2EE.isDecryptable(wire),
              let key = SharedKeychain.e2eeKey(forChannelId: channelId),
              let plaintext = E2EE.decrypt(wire, key: key)
        else {
            // Nothing to decrypt, no key on this device, or it failed —
            // deliver the server's "Encrypted message" fallback as-is.
            contentHandler(best)
            return
        }

        best.body = plaintext
        contentHandler(best)
    }

    override func serviceExtensionTimeWillExpire() {
        // Out of time — hand back whatever we have (the unmodified fallback).
        if let handler = contentHandler, let best = bestAttempt {
            handler(best)
        }
    }
}
