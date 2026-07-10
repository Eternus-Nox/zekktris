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
