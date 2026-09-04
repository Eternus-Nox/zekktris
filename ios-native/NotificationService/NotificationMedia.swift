import CryptoKit
import ImageIO
import UIKit
import UserNotifications

/// Builds notification attachments on-device: a big centered emoji image for a
/// poke, and the downloaded photo for an image message. Used by the Notification
/// Service Extension so the lock-screen / watch notification shows the icon or
/// photo large instead of a tiny inline glyph or "<attachment>" text.
enum NotificationMedia {
    /// Render an emoji as a large centered PNG (transparent background) for a
    /// poke notification.
    static func renderEmoji(_ emoji: String) -> URL? {
        let side: CGFloat = 256
        let renderer = UIGraphicsImageRenderer(size: CGSize(width: side, height: side))
        let image = renderer.image { _ in
            let font = UIFont.systemFont(ofSize: side * 0.62)
            let attrs: [NSAttributedString.Key: Any] = [.font: font]
            let str = emoji as NSString
            let textSize = str.size(withAttributes: attrs)
            str.draw(
                at: CGPoint(x: (side - textSize.width) / 2, y: (side - textSize.height) / 2),
                withAttributes: attrs
            )
        }
        return write(image, name: "poke", jpeg: false)
    }

    /// Download an image, decode it (UIImage handles WebP, which the server
    /// compresses non-E2EE photos to and which UNNotificationAttachment rejects
    /// raw), downscale, re-encode to JPEG, and attach it to `content`. Calls
    /// `completion` on the calling thread when done (success or not). Returns the
    /// task so the caller can cancel it on timeout.
    static func attachImage(
        from url: URL,
        to content: UNMutableNotificationContent,
        completion: @escaping () -> Void
    ) -> URLSessionDataTask {
        let task = URLSession.shared.dataTask(with: url) { data, _, _ in
            defer { completion() }
            guard let data, let raw = UIImage(data: data) else { return }
            let scaled = raw.downscaled(toMax: 1024)
            guard let fileURL = write(scaled, name: "img", jpeg: true) else { return }
            if let attachment = try? UNNotificationAttachment(identifier: "image", url: fileURL, options: nil) {
                content.attachments = [attachment]
            }
        }
        task.resume()
        return task
    }

    private static func write(_ image: UIImage, name: String, jpeg: Bool) -> URL? {
        let data = jpeg ? image.jpegData(compressionQuality: 0.85) : image.pngData()
        guard let data else { return nil }
        let ext = jpeg ? "jpg" : "png"
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("\(name)-\(UUID().uuidString).\(ext)")
        do { try data.write(to: url); return url } catch { return nil }
    }
}

private extension UIImage {
    /// Aspect-fit downscale so the longest side is at most `max` points.
    func downscaled(toMax max: CGFloat) -> UIImage {
        let longest = Swift.max(size.width, size.height)
        guard longest > max, longest > 0 else { return self }
        let scale = max / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        return UIGraphicsImageRenderer(size: target).image { _ in
            draw(in: CGRect(origin: .zero, size: target))
        }
    }
}

// MARK: - Sender avatars (communication notifications)

extension NotificationMedia {
    /// The sender's avatar, as JPEG bytes small enough to hand to `INImage` —
    /// this is the face that ends up on the lock screen (and in the Siri
    /// announcement) for a communication notification.
    ///
    /// Cached on disk in the shared app group, because the extension is a fresh
    /// short-lived process for every single notification: an in-memory cache
    /// would never hit, and messages arrive in bursts from the same handful of
    /// people. Avatar URLs are content-addressed `/cdn/` paths, so a changed
    /// avatar is a different key and a cache hit can never be stale pixels.
    ///
    /// Calls `completion` on the calling thread when done, `nil` if anything
    /// went wrong — which only costs a monogram instead of a face. Returns the
    /// task (nil on a cache hit) so the caller can cancel it on timeout.
    static func avatarData(
        from url: URL,
        completion: @escaping (Data?) -> Void
    ) -> URLSessionDataTask? {
        if let cached = cachedAvatar(for: url) {
            completion(cached)
            return nil
        }
        let task = URLSession.shared.dataTask(with: url) { data, _, _ in
            // Thumbnail via ImageIO rather than a full UIImage decode: the
            // extension has a hard ~24 MB ceiling and is already spending it on
            // the message photo, so the avatar must never decode full-size.
            guard let data, let small = thumbnail(data, maxPixels: 128) else {
                completion(nil)
                return
            }
            storeAvatar(small, for: url)
            completion(small)
        }
        task.resume()
        return task
    }

    private static func thumbnail(_ data: Data, maxPixels: Int) -> Data? {
        guard let source = CGImageSourceCreateWithData(data as CFData, nil) else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(source, 0, options as CFDictionary) else {
            return nil
        }
        return UIImage(cgImage: cg).jpegData(compressionQuality: 0.8)
    }

    /// `<app group>/Library/Caches/SenderAvatars`. In the group container so the
    /// cache survives the extension process and is shared with any future
    /// caller; under Caches so the system can reclaim it under disk pressure.
    private static func avatarCacheDirectory() -> URL? {
        guard let container = FileManager.default.containerURL(
            forSecurityApplicationGroupIdentifier: AppGroupConfig.identifier)
        else { return nil }
        let dir = container
            .appendingPathComponent("Library/Caches/SenderAvatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir
    }

    private static func avatarCacheFile(for url: URL) -> URL? {
        guard let dir = avatarCacheDirectory() else { return nil }
        let digest = SHA256.hash(data: Data(url.absoluteString.utf8))
        return dir.appendingPathComponent(digest.map { String(format: "%02x", $0) }.joined() + ".jpg")
    }

    private static func cachedAvatar(for url: URL) -> Data? {
        guard let file = avatarCacheFile(for: url) else { return nil }
        return try? Data(contentsOf: file)
    }

    private static func storeAvatar(_ data: Data, for url: URL) {
        guard let file = avatarCacheFile(for: url), let dir = avatarCacheDirectory() else { return }
        // Bounded the same blunt way the app's donation cache is: past the cap,
        // drop the lot rather than carry LRU bookkeeping into an extension that
        // has milliseconds to spare. These are a few KB each; the worst case is
        // one re-fetch per sender.
        let existing = (try? FileManager.default.contentsOfDirectory(
            at: dir, includingPropertiesForKeys: nil)) ?? []
        if existing.count >= 64 {
            for file in existing { try? FileManager.default.removeItem(at: file) }
        }
        try? data.write(to: file, options: .atomic)
    }
}
