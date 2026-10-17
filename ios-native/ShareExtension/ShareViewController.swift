import UIKit
import Social
import Intents
import UniformTypeIdentifiers

/// Receives a share from another app and hands it to Zekktris.
///
/// Deliberately does NOT send anything itself. The extension has no session, no
/// network stack and no E2EE keys for the target channel; replicating any of
/// that here would mean a second, weaker copy of the send path. Instead it
/// stages the payload in the shared App Group, and the app picks it up the next
/// time it becomes active (AppStore.consumeStagedShare) and completes the send
/// with the user watching — the same "staged, never auto-sent" rule the
/// Android side follows.
///
/// It does not try to open the app. A share extension has no supported way to:
/// `NSExtensionContext.open(_:)` only works for Today and iMessage extensions,
/// and calling `UIApplication.open` through the responder chain is a private
/// workaround (its 3-argument selector can't even be called correctly through
/// `perform(_:with:with:)`). So it says where the share went and lets the user
/// switch to Zekktris.
///
/// The conversation comes from the donated `INSendMessageIntent`: when the user
/// taps a suggested person in the share sheet, iOS puts that intent on the
/// extension context, and its `conversationIdentifier` is the Zekktris channel
/// id we donated in `ShareSuggestions`.
final class ShareViewController: UIViewController {
    // Keep in step with AppGroupConfig.identifier and AppStore.consumeStagedShare.
    private let appGroup = "group.com.zekktris.native"
    private let stagedKey = "zk.share.staged.v1"
    private let inboxName = "SharedInbox"
    /// The composer's attachment cap (the server's MAX_FILES_PER_MESSAGE).
    private let maxFiles = 10

    private let statusLabel = UILabel()
    private let doneButton = UIButton(type: .system)

    override func viewDidLoad() {
        super.viewDidLoad()
        buildUI()
        Task { await handle() }
    }

    private func buildUI() {
        view.backgroundColor = .systemBackground
        statusLabel.text = "Preparing…"
        statusLabel.font = .preferredFont(forTextStyle: .body)
        statusLabel.textAlignment = .center
        statusLabel.numberOfLines = 0
        doneButton.setTitle("Done", for: .normal)
        doneButton.titleLabel?.font = .preferredFont(forTextStyle: .headline)
        doneButton.isEnabled = false
        doneButton.addAction(UIAction { [weak self] _ in
            self?.extensionContext?.completeRequest(returningItems: nil)
        }, for: .touchUpInside)

        let stack = UIStackView(arrangedSubviews: [statusLabel, doneButton])
        stack.axis = .vertical
        stack.spacing = 20
        stack.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(stack)
        NSLayoutConstraint.activate([
            stack.centerYAnchor.constraint(equalTo: view.safeAreaLayoutGuide.centerYAnchor),
            stack.leadingAnchor.constraint(equalTo: view.layoutMarginsGuide.leadingAnchor),
            stack.trailingAnchor.constraint(equalTo: view.layoutMarginsGuide.trailingAnchor),
        ])
    }

    private func handle() async {
        var text: String?
        var fileNames: [String] = []

        // The channel id, if the user picked a suggested conversation. Needs
        // IntentsSupported = [INSendMessageIntent] in this target's
        // NSExtensionAttributes, or iOS never sets the intent.
        let channelId = (extensionContext?.intent as? INSendMessageIntent)?.conversationIdentifier

        for item in (extensionContext?.inputItems as? [NSExtensionItem]) ?? [] {
            for provider in item.attachments ?? [] {
                if provider.hasItemConformingToTypeIdentifier(UTType.url.identifier),
                   let url = try? await provider.loadItem(forTypeIdentifier: UTType.url.identifier) as? URL,
                   !url.isFileURL {
                    text = [text, url.absoluteString].compactMap { $0 }.joined(separator: "\n")
                } else if provider.hasItemConformingToTypeIdentifier(UTType.plainText.identifier),
                          let s = try? await provider.loadItem(forTypeIdentifier: UTType.plainText.identifier) as? String {
                    text = [text, s].compactMap { $0 }.joined(separator: "\n")
                } else if fileNames.count < maxFiles, let name = await stageFile(from: provider) {
                    fileNames.append(name)
                }
            }
        }

        // Only after staging succeeds does this share replace an earlier one
        // the app hasn't picked up (same key), so only then are that one's
        // files dead weight. Never the whole inbox: files the app already took
        // into a share that is still waiting for its conversation live there too.
        let previous = stagedFiles()
        let staged = stage(channelId: channelId, text: text, files: fileNames)
        removeFromInbox(staged ? previous : fileNames)
        statusLabel.text = staged
            ? "Ready in Zekktris. Open Zekktris to finish sending — nothing is sent until you press send."
            : "Couldn't hand this to Zekktris. Open Zekktris and share from there."
        doneButton.isEnabled = true
    }

    /// Copy one shared file into the App Group and return its name there. The
    /// extension's access to the original ends the moment we complete. Photos
    /// and screenshots often arrive as an image object or raw data rather than
    /// a file URL, so those are written out too.
    private func stageFile(from provider: NSItemProvider) async -> String? {
        let type: UTType = provider.hasItemConformingToTypeIdentifier(UTType.image.identifier) ? .image : .item
        guard let item = try? await provider.loadItem(forTypeIdentifier: type.identifier) else { return nil }
        if let url = item as? URL, url.isFileURL { return copyIntoAppGroup(url) }
        if let image = item as? UIImage, let data = image.jpegData(compressionQuality: 0.85) {
            return writeIntoAppGroup(data, filename: "image.jpg")
        }
        if let data = item as? Data {
            let ext = provider.registeredTypeIdentifiers.lazy
                .compactMap { UTType($0)?.preferredFilenameExtension }.first ?? "bin"
            return writeIntoAppGroup(data, filename: "file.\(ext)")
        }
        return nil
    }

    private var inboxURL: URL? {
        FileManager.default.containerURL(forSecurityApplicationGroupIdentifier: appGroup)?
            .appendingPathComponent(inboxName, isDirectory: true)
    }

    /// Files of the payload currently staged and not yet consumed by the app.
    private func stagedFiles() -> [String] {
        let raw = UserDefaults(suiteName: appGroup)?.dictionary(forKey: stagedKey)
        return (raw?["files"] as? [String]) ?? []
    }

    private func removeFromInbox(_ names: [String]) {
        guard let dir = inboxURL else { return }
        for name in names where !name.contains("/") {
            try? FileManager.default.removeItem(at: dir.appendingPathComponent(name))
        }
    }

    /// Destination for one file. The UUID prefix keeps two shared files with
    /// the same name apart; the app strips it again for the attachment name.
    private func inboxDestination(for filename: String) -> URL? {
        guard let dir = inboxURL else { return nil }
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appendingPathComponent(UUID().uuidString + "-" + filename)
    }

    private func copyIntoAppGroup(_ src: URL) -> String? {
        guard let dest = inboxDestination(for: src.lastPathComponent) else { return nil }
        do {
            try FileManager.default.copyItem(at: src, to: dest)
            // The copy keeps the original's dates; stamp it now so the app's
            // day-old sweep (AppStore.sweepSharedInbox) can't take it for a leftover.
            try? FileManager.default.setAttributes([.modificationDate: Date()], ofItemAtPath: dest.path)
            return dest.lastPathComponent
        } catch {
            return nil
        }
    }

    private func writeIntoAppGroup(_ data: Data, filename: String) -> String? {
        guard let dest = inboxDestination(for: filename) else { return nil }
        do {
            try data.write(to: dest)
            return dest.lastPathComponent
        } catch {
            return nil
        }
    }

    /// Stage the payload for the app. Only property-list values may go into
    /// UserDefaults, so absent fields are left out rather than stored as nil.
    /// False when the App Group isn't available (not provisioned) — the app
    /// could never see the payload — or there was nothing to stage.
    private func stage(channelId: String?, text: String?, files: [String]) -> Bool {
        guard inboxURL != nil, let d = UserDefaults(suiteName: appGroup) else { return false }
        guard text?.isEmpty == false || !files.isEmpty else { return false }
        var payload: [String: Any] = ["files": files, "at": Date().timeIntervalSince1970]
        if let channelId, !channelId.isEmpty { payload["channelId"] = channelId }
        if let text, !text.isEmpty { payload["text"] = text }
        d.set(payload, forKey: stagedKey)
        return true
    }
}
