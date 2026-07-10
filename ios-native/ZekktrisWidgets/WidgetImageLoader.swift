import UIKit

/// Loads + caches DM avatars for the widget. Widgets run with a tight memory
/// budget and re-render often, so images are downscaled to a small square and
/// cached to the App-Group container — a reload reads the cached file instead
/// of re-fetching, and offline reloads still show the last avatar.
actor WidgetImageLoader {
    static let shared = WidgetImageLoader()
    private let maxDimension: CGFloat = 120

    func image(for urlString: String?) async -> UIImage? {
        guard let urlString, !urlString.isEmpty, let url = URL(string: urlString) else { return nil }

        if let cached = Self.cacheURL(for: urlString),
           let data = try? Data(contentsOf: cached),
           let img = UIImage(data: data) {
            return img
        }

        guard
            let (data, resp) = try? await URLSession.shared.data(from: url),
            let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let raw = UIImage(data: data)
        else { return nil }

        let scaled = raw.downscaled(toMax: maxDimension)
        if let cached = Self.cacheURL(for: urlString), let png = scaled.pngData() {
            try? png.write(to: cached, options: .atomic)
        }
        return scaled
    }

    /// Stable on-disk filename for a URL (Swift's String.hashValue is salted
    /// per launch, so use a deterministic djb2 hash instead).
    private static func cacheURL(for key: String) -> URL? {
        guard let base = FileManager.default
            .containerURL(forSecurityApplicationGroupIdentifier: AppGroupConfig.identifier) else { return nil }
        let dir = base.appendingPathComponent("widget-avatars", isDirectory: true)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        var h: UInt64 = 5381
        for b in key.utf8 { h = (h &* 33) &+ UInt64(b) }
        return dir.appendingPathComponent("\(String(h, radix: 16)).png")
    }
}

extension UIImage {
    /// Aspect-fit downscale so the longest side is at most `max` points.
    func downscaled(toMax max: CGFloat) -> UIImage {
        let longest = Swift.max(size.width, size.height)
        guard longest > max, longest > 0 else { return self }
        let scale = max / longest
        let target = CGSize(width: size.width * scale, height: size.height * scale)
        let renderer = UIGraphicsImageRenderer(size: target)
        return renderer.image { _ in draw(in: CGRect(origin: .zero, size: target)) }
    }
}
