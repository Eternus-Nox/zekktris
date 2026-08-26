import UIKit
import Social
import Intents
import UniformTypeIdentifiers

/// Receives a share from another app and hands it to Zekktris.
///
/// Deliberately does NOT send anything itself. The extension has no session, no
/// network stack and no E2EE keys for the target channel; replicating any of
/// that here would mean a second, weaker copy of the send path. Instead it
/// stages the payload in the shared App Group and opens the app, which completes
/// the send with the user watching — the same "staged, never auto-sent" rule the
/// Android side follows.
///
/// The conversation comes from the donated `INSendMessageIntent`: when the user
/// taps a suggested person in the share sheet, iOS puts that intent on the
/// extension context, and its `conversationIdentifier` is the Zekktris channel
/// id we donated in `ShareSuggestions`.
final class ShareViewController: UIViewController {
    private let appGroup = "group.com.zekktris.native"
    private let stagedKey = "zk.share.staged.v1"

    override func viewDidLoad() {
        super.viewDidLoad()
        Task { await handle() }
    }

    private func handle() async {
        var text: String?
        var fileURLs: [String] = []

        // The channel id, if the user picked a suggested conversation.
        let channelId = (extensionContext?.intent as? INSendMessageIntent)?.conversationIdentifier

        for item in (extensionContext?.inputItems as? [NSExtensionItem]) ?? [] {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL {
                    text = [text, url.absoluteString].compactMap { $0 }.joined(separator: "\n")
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let s = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    text = [text, s].compactMap { $0 }.joined(separator: "\n")
                } else if provider.hasItemConformingToTypeIdentifier(UTType.item.identifier),
                          let url = try? await provider.loadItem(forTypeIdentifier: UTType.item.identifier) as? URL,
                          url.isFileURL {
                    // Copy into the shared container: the extension's sandbox for
                    // the original is gone the moment we complete.
                    if let copied = copyIntoAppGroup(url) { fileURLs.append(copied) }
                }
            }
        }

        stage(channelId: channelId, text: text, files: fileURLs)
        openHostApp()
        extensionContext?.completeRequest(returningItems: nil)
    }

    private func copyIntoAppGroup(_ src: URL) -> String? {
        guard let container = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: appGroup) else { return nil }
        let dir = container.appendingPathComponent("SharedInbox", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let dest = dir.appendingPathComponent(UUID().uuidString + "-" + src.lastPathComponent)
        do {
            try FileManager.default.copyItem(at: src, to: dest)
            return dest.lastPathComponent
        } catch {
            return nil
        }
    }

    private func stage(channelId: String?, text: String?, files: [String]) {
        guard let d = UserDefaults(suiteName: appGroup) else { return }
        d.set(["channelId": channelId as Any, "text": text as Any, "files": files,
               "at": Date().timeIntervalSince1970], forKey: stagedKey)
    }

    /// Open the container app. A share extension can't call UIApplication.shared,
    /// so walk the responder chain for something that can.
    private func openHostApp() {
        guard let url = URL(string: "zekktris://share") else { return }
        var responder: UIResponder? = self
        while let r = responder {
            if let app = r as? UIApplication {
                app.perform(#selector(UIApplication.open(_:options:completionHandler:)), with: url, with: [:])
                return
            }
            responder = r.next
        }
    }
}
