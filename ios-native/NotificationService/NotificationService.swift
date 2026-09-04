import Intents
import UserNotifications

/// Enriches notifications on-device before they're shown (and forwarded to the
/// watch). Gated on `mutable-content: 1` from the server:
///
///  1. Poke (`pokeEmoji`) — render the emoji as a big centered image, attach it,
///     and drop the text, so the notification is just a large icon.
///  2. E2EE preview (`e2ee` + `channelId`) — decrypt the ciphertext with the
///     channel key from the shared app-group keychain and show the plaintext.
///  3. Image message (`imageUrl`) — download the photo and attach it, so the
///     notification shows the image instead of a "📷 Photo" placeholder alone.
///  4. Communication styling — rebuild the whole thing as an `INSendMessageIntent`
///     so iOS treats it as a message FROM A PERSON: the sender's face on the
///     lock screen, Siri announcing it through AirPods, and a spoken reply.
///
/// Order matters: 4 runs LAST because `updating(from:)` hands back a new,
/// immutable content object, so any body or attachment written after it is lost.
///
/// Fail-safe everywhere: if rendering/downloading/decryption/styling fails or
/// the 30-second budget expires, the server's original notification is
/// delivered unchanged. Plaintext is never logged or persisted.
final class NotificationService: UNNotificationServiceExtension {
    private var contentHandler: ((UNNotificationContent) -> Void)?
    private var bestAttempt: UNMutableNotificationContent?
    /// Set only once the communication styling has succeeded; delivered in
    /// preference to `bestAttempt`.
    private var styled: UNNotificationContent?
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

        // 1. Poke — render the emoji big + centered, drop the text. Deliberately
        // NOT styled as a communication: a poke has no message to announce, and
        // the whole point of its notification is the single large glyph.
        if let emoji = info["pokeEmoji"] as? String, !emoji.isEmpty {
            if let url = NotificationMedia.renderEmoji(emoji),
               let attachment = try? UNNotificationAttachment(identifier: "poke", url: url, options: nil) {
                best.attachments = [attachment]
            }
            best.body = ""
            contentHandler(best)
            return
        }

        // 2. E2EE preview — decrypt with the channel key, if we have it.
        if let wire = info["e2ee"] as? String,
           let channelId = info["channelId"] as? String,
           E2EE.isDecryptable(wire),
           let key = SharedKeychain.e2eeKey(forChannelId: channelId),
           let plaintext = E2EE.decrypt(wire, key: key) {
            best.body = plaintext
        }

        // 3. Image message — download the photo and attach it (async), then style.
        if let urlString = info["imageUrl"] as? String, let url = URL(string: urlString) {
            downloadTask = NotificationMedia.attachImage(from: url, to: best) { [weak self] in
                self?.applyCommunicationStyle(to: best, info: info)
            }
            return
        }

        applyCommunicationStyle(to: best, info: info)
    }

    /// Step 4 — hand off to `CommunicationNotification`, then deliver whatever
    /// came back. Its failure is not ours: an un-styled notification is still a
    /// perfectly good notification.
    private func applyCommunicationStyle(
        to content: UNMutableNotificationContent,
        info: [AnyHashable: Any]
    ) {
        downloadTask = CommunicationNotification.apply(to: content, userInfo: info) { [weak self] result in
            self?.styled = result
            self?.deliver()
        }
    }

    /// Deliver the best content we have, once (idempotent — clears the handler
    /// so a late completion after a timeout can't double-call).
    private func deliver() {
        guard let handler = contentHandler else { return }
        contentHandler = nil
        guard let content = styled ?? bestAttempt else { return }
        handler(content)
    }

    override func serviceExtensionTimeWillExpire() {
        // Out of time — cancel any in-flight download and hand back what we have.
        downloadTask?.cancel()
        deliver()
    }
}

// MARK: - Communication notifications

/// Turns a Zekktris push into an iOS **communication notification** — the
/// treatment Messages and WhatsApp get, which is what actually buys:
///
///   • the sender's face on the lock screen instead of the app icon,
///   • Siri **announcing the message through AirPods**, and taking a spoken
///     reply back — the thing this was built for,
///   • the conversation showing up in Focus "Allow notifications from people"
///     and in the share sheet's suggested-people row.
///
/// Requires the `com.apple.developer.usernotifications.communication`
/// entitlement on this extension AND the capability enabled on its App ID.
/// Without it `updating(from:)` throws, `apply` returns nil, and the
/// notification is delivered in its ordinary form — so a provisioning gap
/// degrades the feature instead of breaking notifications.
///
/// PRIVACY — read before loosening the gate. A notification whose title is NOT
/// already the sender's name is one the server deliberately made anonymous:
/// that is what an E2EE DM looks like for a recipient who turned message
/// previews off. Styling it would put on the lock screen exactly the identity
/// they opted out of showing. So the test below is "does this notification
/// already name the sender", which cannot leak by construction — rather than
/// trusting a server flag, which can be sent by mistake.
enum CommunicationNotification {
    /// Must match `ShareSuggestions.handleScheme` in the app target — the Share
    /// Extension parses handles with `ShareSuggestions.userId(fromHandle:)`, so
    /// a donation made here has to be readable there. (Duplicated rather than
    /// shared because that type is `@MainActor` and pulls in the app's
    /// networking; this extension compiles neither.)
    private static let handleScheme = "zekktris"

    /// Style `content` as a message from a person. Calls `completion` with the
    /// new content, or nil to keep the original. Returns the avatar download
    /// task (nil when cached or not needed) so it can be cancelled on timeout.
    @discardableResult
    static func apply(
        to content: UNMutableNotificationContent,
        userInfo info: [AnyHashable: Any],
        completion: @escaping (UNNotificationContent?) -> Void
    ) -> URLSessionDataTask? {
        guard let senderName = info["authorName"] as? String, !senderName.isEmpty,
              let channelId = info["channelId"] as? String, !channelId.isEmpty,
              // THE GATE. See the privacy note above.
              content.title == senderName
        else {
            completion(nil)
            return nil
        }

        let senderId = info["authorId"] as? String
        let groupName = info["groupName"] as? String

        guard let avatarURL = (info["senderAvatar"] as? String).flatMap(URL.init(string:)) else {
            // No avatar — still worth styling. iOS draws the sender's initials,
            // and the announcement and spoken reply work exactly the same.
            style(content, senderName: senderName, senderId: senderId,
                  channelId: channelId, groupName: groupName, avatar: nil,
                  completion: completion)
            return nil
        }

        return NotificationMedia.avatarData(from: avatarURL) { data in
            style(content, senderName: senderName, senderId: senderId,
                  channelId: channelId, groupName: groupName,
                  avatar: data.map(INImage.init(imageData:)),
                  completion: completion)
        }
    }

    private static func style(
        _ content: UNMutableNotificationContent,
        senderName: String,
        senderId: String?,
        channelId: String,
        groupName: String?,
        avatar: INImage?,
        completion: @escaping (UNNotificationContent?) -> Void
    ) {
        // `zekktris:<userId>` so a sender survives a display-name change and can
        // never be mistaken for a phone number or an email address. Falling back
        // to the name only matters for a payload without an author id.
        let handleValue = senderId.map { "\(handleScheme):\($0)" } ?? senderName
        let sender = INPerson(
            personHandle: INPersonHandle(value: handleValue, type: .unknown),
            nameComponents: nil,
            displayName: senderName,
            image: avatar,
            contactIdentifier: nil,
            customIdentifier: senderId,
            isMe: false,
            suggestionType: .instantMessageAddress
        )

        let intent = INSendMessageIntent(
            // `recipients` is us, and iOS infers that for an incoming message.
            recipients: nil,
            outgoingMessageType: .outgoingMessageText,
            // CONTENT IS DELIBERATELY NIL, matching `ShareSuggestions`: we
            // donate who the conversation is with, never a word of what was
            // said, so an E2EE message we just decrypted on-device does not
            // leak into the system index.
            content: nil,
            // Present for a group DM or a guild channel; a 1:1 names itself
            // through its sender.
            speakableGroupName: groupName.map { INSpeakableString(spokenPhrase: $0) },
            conversationIdentifier: channelId,
            serviceName: "Zekktris",
            sender: sender,
            attachments: nil
        )
        if let avatar {
            intent.setImage(avatar, forParameterNamed: \INSendMessageIntent.sender)
            if groupName != nil {
                intent.setImage(avatar, forParameterNamed: \INSendMessageIntent.speakableGroupName)
            }
        }

        let interaction = INInteraction(intent: intent, response: nil)
        interaction.direction = .incoming
        // One live incoming interaction per conversation — a new message
        // replaces the previous rather than piling rows into the system index.
        // Distinct from the app's outgoing `zk.dm.<id>` donations so the two
        // never clobber each other.
        interaction.identifier = "zk.in.\(channelId)"
        // Same group identifier the app's donations use, so
        // `ShareSuggestions.deleteConversation(_:)` — block, close DM, remote
        // CHANNEL_DELETE — revokes these too, and `deleteAll()` on sign-out
        // takes them with everything else. (Extensions donate on behalf of the
        // containing app, so the app's deletes reach these.)
        //
        // Note this path can't consult `ShareSuggestions`' own latch: a
        // different process, with no session and no supervision state. It
        // doesn't need to. Sign-out unregisters the APNs token, so no push
        // reaches a signed-out phone and this code never runs; and in the
        // failure case where a token does linger, a donated name is the least
        // of it — the message preview itself is already on that lock screen.
        interaction.groupIdentifier = channelId

        // The donation is what authorizes `updating(from:)`, so it has to land
        // first — hence the completion rather than a fire-and-forget donate.
        interaction.donate { error in
            guard error == nil else {
                completion(nil)
                return
            }
            // Lets the user allow or silence this one conversation inside a
            // Focus, and lets iOS collapse the thread properly.
            content.filterCriteria = channelId
            completion(try? content.updating(from: intent))
        }
    }
}
