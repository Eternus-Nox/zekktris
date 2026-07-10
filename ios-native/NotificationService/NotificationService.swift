import UserNotifications

/// Enriches notifications on-device before they're shown (and forwarded to the
/// watch). Three jobs, all gated on `mutable-content: 1` from the server:
///
///  1. Poke (`pokeEmoji`) — render the emoji as a big centered image, attach it,
///     and drop the text, so the notification is just a large icon.
///  2. Image message (`imageUrl`) — download the photo and attach it, so the
///     notification shows the image instead of a "📷 Photo" placeholder alone.
///  3. E2EE preview (`e2ee` + `channelId`) — decrypt the ciphertext with the
///     channel key from the shared app-group keychain and show the plaintext.
///
/// Fail-safe everywhere: if rendering/downloading/decryption fails or the
/// 30-second budget expires, the server's original notification is delivered
/// unchanged. Plaintext is never logged or persisted.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    private var downloadTask: URLSessionDataTask?

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

        // 1. Poke — render the emoji big + centered, drop the text.
        if let emoji = info["pokeEmoji"] as? String, !emoji.isEmpty {
            if let url = NotificationMedia.renderEmoji(emoji),
               let attachment = try? UNNotificationAttachment(identifier: "poke", url: url, options: nil) {
                best.attachments = [attachment]
            }
            best.body = ""
            contentHandler(best)
            return
        }

        // 2. Image message — download the photo and attach it (async).
        if let urlString = info["imageUrl"] as? String, let url = URL(string: urlString) {
            downloadTask = NotificationMedia.attachImage(from: url, to: best) { [weak self] in
                self?.deliver()
            }
            return
        }

        // 3. E2EE preview — decrypt with the channel key, if we have it.
        if let wire = info["e2ee"] as? String,
           let channelId = info["channelId"] as? String,
           E2EE.isDecryptable(wire),
           let key = SharedKeychain.e2eeKey(forChannelId: channelId),
           let plaintext = E2EE.decrypt(wire, key: key) {
            best.body = plaintext
        }
        contentHandler(best)
    }

    /// Deliver the best attempt once (idempotent — clears the handler so a late
    /// download completion after a timeout can't double-call).
    private func deliver() {
        guard let handler = contentHandler, let best = bestAttempt else { return }
        contentHandler = nil
        handler(best)
    }

    override func serviceExtensionTimeWillExpire() {
        // Out of time — cancel any in-flight download and hand back what we have.
        downloadTask?.cancel()
        deliver()
    }
}
