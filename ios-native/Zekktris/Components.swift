import SwiftUI
import UIKit
import Foundation

/// Circular user avatar that loads a remote image and falls back to the
/// initial letter on a tinted disc. Optionally shows a presence dot.
/// Image loader that actually retries. SwiftUI's AsyncImage parks in its
/// failure phase forever after one transient network error — which reads
/// as "assets randomly don't load" until the view happens to be rebuilt.
/// This loads through URLSession.shared (hitting the enlarged URLCache
/// from AppDelegate), retries with backoff, and re-attempts whenever the
/// view reappears or the URL changes.
/// Process-lifetime decoded-image cache keyed by the asset URL. CDN assets are
/// content-addressed (/cdn/<unique-id>/<file>), so a byte-identical URL always
/// means byte-identical pixels — keying on the URL makes "did it change?" a pure
/// string compare. This survives view recreation (navigating in/out of a
/// conversation destroys + rebuilds the server rail), unlike AsyncImage's
/// internal @State, so an already-seen icon/banner paints on the FIRST frame
/// instead of flashing Color.clear and re-decoding. A genuinely changed image
/// gets a new URL ⇒ new key ⇒ fresh load, so it never serves stale pixels.
/// Volatile (clears on cold launch); it only kills the in-session
/// navigate-out-and-back flicker, which is the reported symptom.
enum DecodedImageCache {
    static let shared: NSCache<NSURL, UIImage> = {
        let c = NSCache<NSURL, UIImage>()
        c.countLimit = 256
        // Also bound by decoded bytes so a big photo gallery can't balloon
        // memory (256 full-res images could be GBs). Eviction is whichever
        // limit hits first.
        c.totalCostLimit = 256 * 1024 * 1024 // 256 MB of decoded pixels
        return c
    }()

    /// Store with an approximate decoded-byte cost so totalCostLimit applies.
    static func store(_ image: UIImage, for url: URL) {
        let px = image.size.width * image.size.height * image.scale * image.scale
        shared.setObject(image, forKey: url as NSURL, cost: Int(px) * 4)
    }
}

/// Decoded UIImages for E2EE THUMBNAILS, keyed by attachmentId+maxPixels. The
/// byte LRU (AppStore.decryptedMedia) already avoids re-download + re-AES, but
/// the ImageIO decode re-ran on every LazyVStack recycle — flashing the lock
/// placeholder and burning CPU on scroll-back. Caching the decoded bitmap lets a
/// recycled E2EE-image row paint instantly with no re-decode (mirrors what
/// DecodedImageCache does for plain images; that cache is URL-keyed and can't be
/// used here because encrypted attachments have no stable decoded-URL).
/// SECURITY: this holds decrypted plaintext pixels, so it MUST be cleared on
/// relock / sign-out — AppStore.clearDecryptedMedia() calls clear().
enum EncryptedThumbCache {
    private static let cache: NSCache<NSString, UIImage> = {
        let c = NSCache<NSString, UIImage>()
        c.countLimit = 256
        c.totalCostLimit = 128 * 1024 * 1024 // 128 MB of decoded thumbnails
        return c
    }()
    private static func key(_ attId: String, _ maxPixels: Int) -> NSString {
        "\(attId):\(maxPixels)" as NSString
    }
    static func image(_ attId: String, _ maxPixels: Int) -> UIImage? {
        cache.object(forKey: key(attId, maxPixels))
    }
    static func store(_ image: UIImage, _ attId: String, _ maxPixels: Int) {
        let px = image.size.width * image.size.height * image.scale * image.scale
        cache.setObject(image, forKey: key(attId, maxPixels), cost: Int(px) * 4)
    }
    static func clear() { cache.removeAllObjects() }
}

struct RetryingImage: View {
    let url: URL
    @State private var image: UIImage?
    /// Which URL the current `image` belongs to. A recycled LazyVStack row
    /// rebinds this view to a different url, but `@State` survives the
    /// rebind — without this guard the `image == nil` check skipped the
    /// reload and the PREVIOUS row's image (someone else's avatar) stayed
    /// on screen permanently.
    @State private var loadedURL: URL?

    init(url: URL) {
        self.url = url
        // Seed synchronously from the decoded cache so a recreated view paints
        // an already-seen image on its first frame (no Color.clear flash).
        let cached = DecodedImageCache.shared.object(forKey: url as NSURL)
        _image = State(initialValue: cached)
        _loadedURL = State(initialValue: cached != nil ? url : nil)
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().scaledToFill()
            } else {
                Color.clear
            }
        }
        .task(id: url) {
            if loadedURL != url {
                // Rebind to a different url: drop the stale image, but adopt a
                // cached decode for the new url immediately if we have one.
                image = DecodedImageCache.shared.object(forKey: url as NSURL)
                loadedURL = url
            }
            if image == nil {
                let loaded = await Self.load(url)
                if let loaded { DecodedImageCache.store(loaded, for: url) }
                image = loaded
            }
        }
    }

    /// Fetch with up to 3 attempts (0.6s / 1.2s backoff between them).
    static func load(_ url: URL, attempts: Int = 3, maxPixels: CGFloat = 1024) async -> UIImage? {
        guard let data = await loadData(url, attempts: attempts) else { return nil }
        // Force-decode + downsample OFF the main actor so the bitmap is realized
        // before SwiftUI ever draws it — a bare UIImage(data:) defers the CGImage
        // decode to draw time on the main thread, dropping frames during scroll.
        // maxPixels 1024 ≥ every on-screen target (inline media ≤240pt, avatars
        // ≤40pt). The raw-bytes loadData path (Save-to-Photos / GIF frames) is
        // untouched. Mirrors the E2EE lightbox decode path.
        return await Task.detached(priority: .userInitiated) {
            ImageDownsampler.decode(data, maxPixels: maxPixels) ?? UIImage(data: data)
        }.value
    }

    /// Fetch the RAW image bytes (same retry/backoff as `load`), without
    /// decoding to a UIImage. Used for "Save to Photos" so the ORIGINAL file is
    /// written to the library verbatim — preserving format/quality and keeping
    /// animated GIFs animated (UIImage(data:) would flatten to one frame).
    static func loadData(_ url: URL, attempts: Int = 3) async -> Data? {
        var request = URLRequest(url: url)
        request.cachePolicy = .returnCacheDataElseLoad
        for attempt in 1...attempts {
            if Task.isCancelled { return nil }
            do {
                let (data, response) = try await URLSession.shared.data(for: request)
                if let http = response as? HTTPURLResponse,
                   !(200...299).contains(http.statusCode) {
                    throw URLError(.badServerResponse)
                }
                guard !data.isEmpty else { throw URLError(.cannotDecodeContentData) }
                return data
            } catch {
                guard attempt < attempts else { return nil }
                try? await Task.sleep(nanoseconds: UInt64(attempt) * 600_000_000)
            }
        }
        return nil
    }
}

/// Cached, retrying image for inline message media. Shares DecodedImageCache +
/// RetryingImage.load, so a recycled LazyVStack row paints an already-decoded
/// image on the FIRST frame instead of re-fetching + re-decoding full-res on
/// every scroll-back (the reported "images load slowly / choppy scroll"). Unlike
/// RetryingImage (hardwired scaledToFill for avatars) the caller picks the
/// content mode + the loading / failed placeholders.
struct CachedImage<Placeholder: View, Failure: View>: View {
    let url: URL
    let contentMode: ContentMode
    @ViewBuilder let placeholder: () -> Placeholder
    @ViewBuilder let failure: () -> Failure
    @State private var image: UIImage?
    @State private var loadedURL: URL?
    @State private var failed = false

    init(
        url: URL,
        contentMode: ContentMode = .fit,
        @ViewBuilder placeholder: @escaping () -> Placeholder,
        @ViewBuilder failure: @escaping () -> Failure
    ) {
        self.url = url
        self.contentMode = contentMode
        self.placeholder = placeholder
        self.failure = failure
        let cached = DecodedImageCache.shared.object(forKey: url as NSURL)
        _image = State(initialValue: cached)
        _loadedURL = State(initialValue: cached != nil ? url : nil)
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image).resizable().aspectRatio(contentMode: contentMode)
            } else if failed {
                failure()
            } else {
                placeholder()
            }
        }
        .task(id: url) {
            if loadedURL != url {
                image = DecodedImageCache.shared.object(forKey: url as NSURL)
                loadedURL = url
                failed = false
            }
            if image == nil {
                if let loaded = await RetryingImage.load(url) {
                    DecodedImageCache.store(loaded, for: url)
                    image = loaded
                } else {
                    failed = true
                }
            }
        }
    }
}

/// Custom name-tag ("clan tag") pill — a short (≤4 char) label tinted by the
/// user's chosen color (falls back to the theme accent). Renders nothing
/// unless a label is set. Shown IN FRONT of the user's name everywhere it
/// appears (messages, member list, profile, DM list) — mirrors the web UserTag.
struct NameTag: View {
    let label: String?
    let color: String?
    /// The tag editor's own preview passes true so it stays visible even when
    /// the viewer has "Hide clan tags" on (you're editing this tag).
    let ignoreHidePref: Bool
    // Viewer-side declutter toggle (Settings › Appearance). Reads the same
    // UserDefaults key the Settings switch writes; @AppStorage re-renders every
    // pill the moment it flips.
    @AppStorage("zk.hideClanTags") private var hideClanTags = false

    init(label: String?, color: String?, ignoreHidePref: Bool = false) {
        let l = label?.trimmingCharacters(in: .whitespacesAndNewlines)
        self.label = (l?.isEmpty == false) ? l : nil
        self.color = color
        self.ignoreHidePref = ignoreHidePref
    }

    /// Convenience for any PublicUser.
    init(_ user: PublicUser) {
        self.init(label: user.tagLabel, color: user.tagColor)
    }

    var body: some View {
        if let label, !(hideClanTags && !ignoreHidePref) {
            let tint = color.flatMap { Color(hexString: $0) } ?? Theme.accent
            Text(label)
                .font(.zkSans(10, weight: .semibold))
                .foregroundColor(tint)
                // Symmetric padding — the label stays dead-center in the pill
                // at every size (per user direction: always centered).
                .padding(.horizontal, 5)
                .padding(.vertical, 2)
                .background(RoundedRectangle(cornerRadius: 5).fill(tint.opacity(0.14)))
                .overlay(RoundedRectangle(cornerRadius: 5).stroke(tint, lineWidth: 1))
                .fixedSize()
        }
    }
}

/// Perk tier title badge — Scout / Guardian / Legend. Mirrors the web
/// TierBadge pill (uppercase, tier-tinted). Renders nothing for nil/unknown.
struct TierBadge: View {
    let tier: String?

    static func meta(_ tier: String) -> (label: String, color: Color)? {
        switch tier {
        case "scout": return ("SCOUT", Color(hex: 0x3D9BFF))
        case "guardian": return ("GUARDIAN", Color(hex: 0x9D7BFF))
        case "legend": return ("LEGEND", Color(hex: 0xF4C95B))
        default: return nil
        }
    }

    var body: some View {
        if let tier, let meta = Self.meta(tier) {
            Text(meta.label)
                .font(.zkSans(8.5, weight: .bold))
                .tracking(0.5)
                .foregroundColor(meta.color)
                .padding(.horizontal, 5)
                .padding(.vertical, 1.5)
                .background(meta.color.opacity(0.18))
                .clipShape(RoundedRectangle(cornerRadius: 4))
        }
    }
}

/// Instance-staff display name. Staff (admin/moderator) are marked NOT by a
/// label but by an animated shimmer sweeping across their display name in a
/// color THEY chose (`staffColor`), which OVERRIDES any guild role color.
/// Regular members — and staff who haven't turned it on — render as plain
/// `Text` in `color` (the role/member color, else the fallback). Drop-in for
/// the old StaffBadge: callers render the name through this instead of a badge.
struct StaffName: View {
    let text: String
    /// #rrggbb shimmer color, or nil to render plainly. Pre-gated to staff.
    let staffColor: String?
    /// Optional soft glow layered on the shimmer (only when staffColor is set).
    var glow: Bool = false
    var color: Color = Theme.ink1
    var font: Font = .zkSans(15, weight: .medium)
    var lineLimit: Int? = 1

    /// Direct init — pass a `#rrggbb` to shimmer, or nil for plain. Used by the
    /// settings live-preview (where the color is always present).
    init(text: String, staffColor: String?, glow: Bool = false, color: Color = Theme.ink1,
         font: Font = .zkSans(15, weight: .medium), lineLimit: Int? = 1) {
        self.text = text
        self.staffColor = staffColor
        self.glow = glow
        self.color = color
        self.font = font
        self.lineLimit = lineLimit
    }

    /// Convenience: gate the shimmer on the user actually being staff with a
    /// color set. Pass `nil` to force plain (e.g. webhook / server author).
    init(_ user: PublicUser?, text: String, color: Color = Theme.ink1,
         font: Font = .zkSans(15, weight: .medium), lineLimit: Int? = 1) {
        self.text = text
        if let u = user, u.isAdmin == true || u.isModerator == true,
           let c = u.staffColor, !c.isEmpty {
            self.staffColor = c
            self.glow = u.staffGlow == true
        } else {
            self.staffColor = nil
            self.glow = false
        }
        self.color = color
        self.font = font
        self.lineLimit = lineLimit
    }

    var body: some View {
        if let hex = staffColor, let base = Color(hexString: hex) {
            ShimmerText(text: text, base: base, glow: glow, font: font, lineLimit: lineLimit)
        } else {
            Text(text).font(font).foregroundColor(color).lineLimit(lineLimit)
        }
    }
}

/// The animated part of `StaffName`: base-colored glyphs with a soft highlight
/// band sweeping left→right on a loop, the whole thing masked to the text so
/// only the letters shimmer. Mirrors the web `.zk-staff-shimmer` gradient.
private struct ShimmerText: View {
    let text: String
    let base: Color
    var glow: Bool = false
    let font: Font
    let lineLimit: Int?
    @State private var phase: CGFloat = -1

    var body: some View {
        Text(text)
            .font(font)
            .lineLimit(lineLimit)
            .foregroundColor(base)
            .overlay(
                GeometryReader { geo in
                    LinearGradient(
                        gradient: Gradient(stops: [
                            .init(color: .clear, location: 0.0),
                            .init(color: Color.white.opacity(0.75), location: 0.5),
                            .init(color: .clear, location: 1.0),
                        ]),
                        startPoint: .leading, endPoint: .trailing
                    )
                    .frame(width: max(geo.size.width, 1) * 0.55)
                    .offset(x: phase * max(geo.size.width, 1) * 1.7)
                    .allowsHitTesting(false)
                }
            )
            .mask(Text(text).font(font).lineLimit(lineLimit))
            // Optional slight glow: a soft shadow of the glyph shapes in the
            // staff color, layered for a fuller halo (mirrors the web glow).
            .shadow(color: glow ? base.opacity(0.9) : .clear, radius: glow ? 3 : 0)
            .shadow(color: glow ? base.opacity(0.5) : .clear, radius: glow ? 7 : 0)
            .onAppear {
                withAnimation(.linear(duration: 2.4).repeatForever(autoreverses: false)) {
                    phase = 1
                }
            }
    }
}

extension Color {
    /// "#RRGGBB" for persisting a name-tag color to the server.
    var tagHexString: String {
        var r: CGFloat = 0, g: CGFloat = 0, b: CGFloat = 0, a: CGFloat = 0
        UIColor(self).getRed(&r, green: &g, blue: &b, alpha: &a)
        return String(format: "#%02X%02X%02X",
                      Int((r * 255).rounded()), Int((g * 255).rounded()), Int((b * 255).rounded()))
    }
}

struct Avatar: View {
    let url: String?
    let name: String
    var size: CGFloat = 40
    /// When set, draws a presence dot in the bottom-trailing corner.
    var status: String? = nil
    /// Background color the dot's ring blends into (match the surface).
    var ringColor: Color = Theme.bg2
    /// When true, clips to a rounded square (for the server rail) instead of
    /// a circle. Defaults to a circle everywhere else.
    var squircle: Bool = false
    /// Cosmetic ring/glow decoration id (see Avatar.decorations); nil/"none" = none.
    var decoration: String? = nil
    /// Stable id used for the deterministic fallback tone (web hashes the
    /// user/guild id). When nil, the name is hashed instead.
    var toneId: String? = nil

    var body: some View {
        Group {
            if let resolved = assetURL(url) {
                // Placeholder underneath; the retrying loader fades the
                // real image in over it (AsyncImage parked forever in its
                // failure phase after one transient blip — "assets
                // randomly don't load").
                placeholder.overlay { RetryingImage(url: resolved) }
            } else {
                placeholder
            }
        }
        .frame(width: size, height: size)
        .clipShape(squircle ? AnyShape(RoundedRectangle(cornerRadius: size * Theme.squircleFraction, style: .continuous)) : AnyShape(Circle()))
        .overlay { decorationOverlay }
        .overlay(alignment: .bottomTrailing) {
            if let status {
                PresenceDot(status: status, ring: ringColor)
                    .frame(width: max(10, size * 0.3), height: max(10, size * 0.3))
                    .offset(x: 1, y: 1)
            }
        }
    }

    @ViewBuilder
    private var decorationOverlay: some View {
        if let deco = decoration, deco != "none", !deco.isEmpty {
            if squircle {
                decoStroke(RoundedRectangle(cornerRadius: size * Theme.squircleFraction, style: .continuous), deco)
            } else {
                decoStroke(Circle(), deco)
            }
        }
    }

    @ViewBuilder
    private func decoStroke<S: InsettableShape>(_ shape: S, _ deco: String) -> some View {
        if let cols = Avatar.decoGradient(deco) {
            shape.strokeBorder(AngularGradient(colors: cols, center: .center), lineWidth: max(2, size * 0.05))
        } else if let c = Avatar.decoColor(deco) {
            shape.strokeBorder(c, lineWidth: max(2, size * 0.05))
                .shadow(color: deco == "ring" ? .clear : c.opacity(0.6), radius: deco == "ring" ? 0 : size * 0.12)
        }
    }

    static let decorations: [(id: String, label: String)] = [
        ("none", "None"), ("ring", "Accent"), ("glow", "Accent glow"), ("gold", "Gold"),
        ("rose", "Rose"), ("violet", "Violet"), ("lime", "Lime"),
        ("aurora", "Aurora"), ("sunset", "Sunset"), ("emerald", "Emerald"),
        ("crimson", "Crimson"), ("ocean", "Ocean"),
    ]
    static func decoColor(_ id: String) -> Color? {
        switch id {
        case "ring", "glow": return Theme.accent
        case "gold": return Color(hex: 0xF4C95B)
        case "rose": return Color(hex: 0xEC5FB5)
        case "violet": return Color(hex: 0x9D7BFF)
        case "lime": return Color(hex: 0x7EE787)
        case "crimson": return Color(hex: 0xFF4D4D)
        default: return nil
        }
    }
    static func decoGradient(_ id: String) -> [Color]? {
        switch id {
        case "aurora": return [Color(hex: 0x3DD7EC), Color(hex: 0x9D7BFF), Color(hex: 0xEC5FB5), Color(hex: 0x3DD7EC)]
        case "sunset": return [Color(hex: 0xFFD13D), Color(hex: 0xEC5FB5), Color(hex: 0x9D7BFF), Color(hex: 0xFFD13D)]
        case "emerald": return [Color(hex: 0x7EE787), Color(hex: 0x3DD7EC), Color(hex: 0x7EE787)]
        case "ocean": return [Color(hex: 0x3D9BFF), Color(hex: 0x3DD8C0), Color(hex: 0x4FDD8F), Color(hex: 0x3D9BFF)]
        default: return nil
        }
    }

    private var placeholder: some View {
        // Web parity (lib/avatar.ts): deterministic FNV-1a tone keyed by
        // the same id string the web hashes, plus two-word initials. The
        // id used on web is the user/guild id; fall back to the name when
        // no id is available so old call sites still render something.
        let tone = avatarTone(toneId ?? name)
        return ZStack {
            tone.bg
            Text(avatarInitials(name))
                .font(.zkSans(size * 0.36, weight: .semibold))
                .foregroundColor(tone.fg)
                .lineLimit(1)
                .frame(width: size, height: size, alignment: .center)
        }
    }
}

// ── Deterministic avatar tones (port of web lib/avatar.ts) ──────────────────
// Same FNV-1a 32-bit hash over the id, same 8-color palette (Tailwind
// rose-700…pink-700 with their -50 text pairs), so a given user renders the
// identical fallback color on web and iOS.
struct AvatarTone { let bg: Color; let fg: Color }

private let avatarPalette: [AvatarTone] = [
    AvatarTone(bg: Color(hex: 0xBE123C), fg: Color(hex: 0xFFF1F2)), // rose-700 / rose-50
    AvatarTone(bg: Color(hex: 0xD97706), fg: Color(hex: 0xFFFBEB)), // amber-600 / amber-50
    AvatarTone(bg: Color(hex: 0x047857), fg: Color(hex: 0xECFDF5)), // emerald-700 / emerald-50
    AvatarTone(bg: Color(hex: 0x0F766E), fg: Color(hex: 0xF0FDFA)), // teal-700 / teal-50
    AvatarTone(bg: Color(hex: 0x0369A1), fg: Color(hex: 0xF0F9FF)), // sky-700 / sky-50
    AvatarTone(bg: Color(hex: 0x4338CA), fg: Color(hex: 0xEEF2FF)), // indigo-700 / indigo-50
    AvatarTone(bg: Color(hex: 0x7E22CE), fg: Color(hex: 0xFAF5FF)), // purple-700 / purple-50
    AvatarTone(bg: Color(hex: 0xBE185D), fg: Color(hex: 0xFDF2F8)), // pink-700 / pink-50
]

/// FNV-1a 32-bit over UTF-16 code units — byte-for-byte the web's hash
/// (charCodeAt ^ then Math.imul by the FNV prime), including the
/// Math.abs(Int32) behavior via `magnitude`.
func avatarTone(_ id: String?) -> AvatarTone {
    guard let id, !id.isEmpty else { return avatarPalette[0] }
    var hash = Int32(bitPattern: 0x811c9dc5)
    for u in id.utf16 {
        hash ^= Int32(u)
        hash = hash &* Int32(bitPattern: 0x01000193)
    }
    return avatarPalette[Int(hash.magnitude) % avatarPalette.count]
}

/// Two-word initials, matching web `avatarInitials` ("My Cool Server" → "MC",
/// empty → "?").
func avatarInitials(_ name: String?) -> String {
    guard let name else { return "?" }
    let letters = name.split(whereSeparator: { $0.isWhitespace })
        .prefix(2)
        .compactMap { $0.first.map { String($0).uppercased() } }
        .joined()
    return letters.isEmpty ? "?" : letters
}

/// Ambient deep-space backdrop, porting the web's `.abyss` canvas: four
/// blurred plasma auroras anchored near the corners plus a sparse starfield.
/// Mount once behind the shell; every column above it uses a translucent
/// fill (bg-0/85, bg-2/85, bg-1/90) so the nebula glows through exactly
/// like the web's backdrop-blur columns.
struct AbyssBackground: View {
    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width, h = geo.size.height
            ZStack {
                aurora(Theme.auroraViolet, rx: 0.60, ry: 0.50, at: CGPoint(x: 0.12, y: 0.08), in: geo.size)
                aurora(Theme.auroraCyan, rx: 0.50, ry: 0.40, at: CGPoint(x: 0.92, y: 0.14), in: geo.size)
                aurora(Theme.auroraMagenta, rx: 0.40, ry: 0.30, at: CGPoint(x: 0.78, y: 0.92), in: geo.size)
                aurora(Theme.auroraTeal, rx: 0.35, ry: 0.28, at: CGPoint(x: 0.18, y: 0.86), in: geo.size)

                // Starfield (positions + alphas from the web's ::after dots).
                ForEach(Array(Self.stars.enumerated()), id: \.offset) { _, star in
                    Circle()
                        .fill(Theme.starlight.opacity(star.alpha))
                        .frame(width: 2, height: 2)
                        .position(x: star.x * w, y: star.y * h)
                }
            }
            // Flatten the blurred gradients into one offscreen texture so the
            // 40pt blur is paid once, not on every compositor pass.
            .drawingGroup()
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }

    private static let stars: [(x: CGFloat, y: CGFloat, alpha: Double)] = [
        (0.24, 0.30, 0.6), (0.80, 0.12, 0.5), (0.62, 0.78, 0.4),
        (0.14, 0.70, 0.5), (0.92, 0.56, 0.4), (0.46, 0.22, 0.3),
    ]

    /// One blurred aurora blob. CSS radial-gradient radii are % of the box
    /// dimensions; we model the ellipse as a scaled circle so the radial
    /// gradient stays smooth, then blur generously like the web (40px).
    private func aurora(_ color: Color, rx: CGFloat, ry: CGFloat, at unit: CGPoint, in size: CGSize) -> some View {
        let rW = size.width * rx
        let rH = size.height * ry
        return Ellipse()
            .fill(
                EllipticalGradient(
                    colors: [color, .clear],
                    center: .center,
                    startRadiusFraction: 0,
                    endRadiusFraction: 0.5
                )
            )
            .frame(width: rW * 2, height: rH * 2)
            .position(x: unit.x * size.width, y: unit.y * size.height)
            .blur(radius: 40)
    }
}

/// Small status indicator dot with a ring that blends into its background.
struct PresenceDot: View {
    let status: String
    var ring: Color = Theme.bg2
    var body: some View {
        Circle()
            .fill(presenceColor(status))
            .overlay(Circle().strokeBorder(ring, lineWidth: 2))
    }
}

func presenceColor(_ status: String) -> Color {
    // Web parity (ProfileCard.tsx): emerald-500 / amber-500 / red-500 / ink-3.
    switch status {
    case "online": return Theme.online
    case "idle": return Theme.idle
    case "dnd": return Theme.dnd
    default: return Theme.offline // offline / invisible / unknown
    }
}

/// Squircle guild icon for the server rail, matching the web GuildTile:
///   - With an icon image: bg-2 tile; when active, a 1px accent-glow ring
///     plus a soft outer glow.
///   - Without an icon: deterministic tone tile (same FNV-1a hash as web)
///     at 90% opacity; when active, an accent→accent-2 gradient with the
///     initials in bg-0.
struct GuildIcon: View {
    let guild: Guild
    let isSelected: Bool
    var size: CGFloat = 48

    private var radius: CGFloat { size * Theme.squircleFraction }
    private var shape: RoundedRectangle { RoundedRectangle(cornerRadius: radius, style: .continuous) }

    var body: some View {
        Group {
            if let resolved = assetURL(guild.iconUrl) {
                // RetryingImage (not AsyncImage): its decoded-image cache keeps
                // the rail icon from flashing/re-fetching when the rail is
                // destroyed + rebuilt on navigating in/out of a conversation.
                RetryingImage(url: resolved)
                    .frame(width: size, height: size)
                    .background(Theme.bg2)
            } else if isSelected {
                LinearGradient(colors: [Theme.accent, Theme.accent2],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
                    .frame(width: size, height: size)
                    .overlay(initials(color: Theme.bg0))
            } else {
                let tone = avatarTone(guild.id)
                tone.bg.opacity(0.9)
                    .frame(width: size, height: size)
                    .overlay(initials(color: tone.fg))
            }
        }
        .clipShape(shape)
        .overlay(shape.strokeBorder(isSelected ? Theme.accentGlow : Color.clear, lineWidth: 1))
        .shadow(color: isSelected ? Theme.accentGlow : .clear, radius: 14, x: 0, y: 8)
        .animation(.easeOut(duration: 0.15), value: isSelected)
    }

    private func initials(color: Color) -> some View {
        Text(guildInitials(guild.name))
            .font(.zkSans(size * 0.34, weight: .semibold))
            .foregroundColor(color)
    }
}

/// First letters of up to the first two words of a name (e.g. "My Cool
/// Server" → "MC"), used for icon placeholders.
func guildInitials(_ name: String) -> String {
    let words = name.split(separator: " ").prefix(2)
    let letters = words.compactMap { $0.first }.map(String.init)
    return letters.joined().uppercased()
}

private let isoFormatter: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private let isoFormatterNoFraction: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime]
    return f
}()

private let timeFormatter: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "h:mm a"
    return f
}()

/// Parse an ISO timestamp from the API into a short local time string.
/// Returns "" if the value can't be parsed.
func shortTime(_ iso: String) -> String {
    guard let date = messageDate(iso) else { return "" }
    return timeFormatter.string(from: date)
}

private let dateDividerFormatter: DateFormatter = {
    let f = DateFormatter(); f.dateStyle = .long; f.timeStyle = .none; return f
}()

/// Memoized ISO→Date cache. Message timestamps are immutable and the SAME
/// string is parsed many times — per-row header/divider checks, the same-author
/// run walk, the timestamp label, and again for every row after a scrollback
/// prepend. ISO8601DateFormatter parsing is among the slowest Foundation calls,
/// so caching it removes the dominant client cost of loading older messages.
/// Accessed only from the main-thread message-list UI; bounded so a long session
/// can't grow it without limit.
private var messageDateCache: [String: Date] = [:]

/// Parse an ISO timestamp (fractional or plain) into a Date, or nil. Memoized.
func messageDate(_ iso: String) -> Date? {
    if let cached = messageDateCache[iso] { return cached }
    guard let d = isoFormatter.date(from: iso) ?? isoFormatterNoFraction.date(from: iso) else {
        return nil
    }
    // Raised from 8000 so realistic sessions never flush — a flush discards the
    // visible working set and forces re-parsing the hottest timestamps through
    // the slow ISO8601DateFormatter. Entries are immutable String→Date (~40B),
    // so even 50k ≈ ~2MB. Pure memoization: raising the cap changes nothing
    // observable.
    if messageDateCache.count > 50_000 { messageDateCache.removeAll(keepingCapacity: true) }
    messageDateCache[iso] = d
    return d
}

/// Compact "how long ago" phrase for an ISO timestamp — "just now", "5m ago",
/// "3h ago", "2d ago", "4w ago", "1y ago". Callers prefix the wording
/// ("Active 5m ago", "Last online 3d ago"), which is why the "ago" lives here:
/// the sub-minute case has no unit to hang it off. Returns nil when the string
/// doesn't parse. Reuses the memoized `messageDate` parser above rather than
/// spinning up another ISO8601DateFormatter.
func shortAgo(_ iso: String, now: Date = Date()) -> String? {
    guard let d = messageDate(iso) else { return nil }
    // Clock skew (or a stamp written a beat in the future) reads as "just now"
    // rather than a nonsense negative.
    let secs = max(0, now.timeIntervalSince(d))
    if secs < 60 { return "just now" }
    let mins = Int(secs / 60)
    if mins < 60 { return "\(mins)m ago" }
    let hours = mins / 60
    if hours < 24 { return "\(hours)h ago" }
    let days = hours / 24
    if days < 7 { return "\(days)d ago" }
    let weeks = days / 7
    if weeks < 52 { return "\(weeks)w ago" }
    return "\(max(1, days / 365))y ago"
}

/// "Today" / "Yesterday" / "January 5, 2026" label for a message date divider.
func dateDividerLabel(_ iso: String) -> String {
    guard let date = messageDate(iso) else { return "" }
    let cal = Calendar.current
    if cal.isDateInToday(date) { return "Today" }
    if cal.isDateInYesterday(date) { return "Yesterday" }
    return dateDividerFormatter.string(from: date)
}

/// True if two ISO timestamps fall on different calendar days.
func isDifferentDay(_ a: String, _ b: String) -> Bool {
    guard let da = messageDate(a), let db = messageDate(b) else { return false }
    return !Calendar.current.isDate(da, inSameDayAs: db)
}

/// Numeric snowflake comparison (ids are monotonic numeric strings).
func snowflakeGreater(_ a: String, than b: String) -> Bool {
    if let ai = UInt64(a), let bi = UInt64(b) { return ai > bi }
    if a.count != b.count { return a.count > b.count }
    return a > b
}

// ── Speaking indicator (web .zk-alien-pulse, themed) ────────────────────────
// Three concentric rings expand outward and fade on a 1.4s ease-out cycle —
// the web's multi-layer sonar ripple. Colors follow the ACTIVE THEME's
// accent trio (accent / accent-2 / accent-3), so Sunset pulses orange,
// Forest pulses blue/green, etc. On the default theme this resolves to the
// same cyan→violet→magenta the web ships.
struct AlienPulse: ViewModifier {
    let active: Bool
    @State private var animating = false

    func body(content: Content) -> some View {
        content
            .overlay {
                // Kept ALWAYS mounted and gated by opacity so the indicator
                // eases in/out when `active` flips instead of popping (web F6
                // parity). The rings keep cycling underneath; the opacity gate
                // hides them when not speaking. Never hit-testable, so the
                // animated overlay can't swallow taps mid-transition.
                ZStack {
                    pulseRing(Theme.accent, alpha: 0.55, spread: 5)
                    pulseRing(Theme.accent2, alpha: 0.40, spread: 10)
                    pulseRing(Theme.accent3, alpha: 0.25, spread: 16)
                    // Resting edge so the avatar reads "live" between pulses.
                    Circle().strokeBorder(Theme.accent.opacity(0.7), lineWidth: 2)
                }
                .opacity(active ? 1 : 0)
                .animation(.easeInOut(duration: 0.35), value: active)
                .allowsHitTesting(false)
                .onAppear { animating = true }
            }
    }

    @ViewBuilder
    private func pulseRing(_ color: Color, alpha: Double, spread: CGFloat) -> some View {
        GeometryReader { geo in
            let d = min(geo.size.width, geo.size.height)
            Circle()
                .stroke(color.opacity(animating ? 0 : alpha), lineWidth: 2.5)
                .scaleEffect(animating ? (d + spread * 2) / d : 1)
                .animation(
                    .easeOut(duration: 1.4).repeatForever(autoreverses: false),
                    value: animating
                )
        }
    }
}

extension View {
    /// Web `.zk-alien-pulse`: apply to circular avatars while speaking.
    func alienPulse(_ active: Bool) -> some View {
        modifier(AlienPulse(active: active))
    }
}

// ── Emoji picker (web EmojiPicker parity: recent / unicode categories /
//    server emoji, with name search) ──────────────────────────────────────────

enum EmojiCatalog {
    /// Compact unicode catalog: (glyph, searchable name). Ordered into the
    /// same category groups the web picker uses.
    static let categories: [(name: String, symbol: String, emoji: [(String, String)])] = [
        ("Smileys", "face.smiling", [
            ("😀","grinning"),("😃","smiley"),("😄","smile"),("😁","grin"),("😆","laughing"),("😅","sweat smile"),
            ("😂","joy"),("🤣","rofl"),("🙂","slight smile"),("😉","wink"),("😊","blush"),("😇","innocent"),
            ("🥰","hearts face"),("😍","heart eyes"),("🤩","star struck"),("😘","kiss"),("😋","yum"),("😜","winking tongue"),
            ("🤪","zany"),("🤔","thinking"),("🤨","raised eyebrow"),("😐","neutral"),("😏","smirk"),("🙄","eye roll"),
            ("😬","grimace"),("😴","sleeping"),("🤒","sick"),("🤯","mind blown"),("😎","sunglasses"),("🥳","party face"),
            ("😢","cry"),("😭","sob"),("😡","rage"),("🤬","cursing"),("😱","scream"),("😳","flushed"),
            ("🥺","pleading"),("😈","smiling imp"),("💀","skull"),("👻","ghost"),("🤖","robot"),("💩","poop"),
        ]),
        ("People", "hand.raised", [
            ("👍","thumbs up"),("👎","thumbs down"),("👌","ok hand"),("✌️","victory"),("🤞","crossed fingers"),
            ("🤘","rock on"),("🤙","call me"),("👈","point left"),("👉","point right"),("👆","point up"),
            ("👇","point down"),("✋","raised hand"),("🖐️","hand splayed"),("👋","wave"),("🤝","handshake"),
            ("🙏","pray thanks"),("👏","clap"),("🙌","raised hands"),("💪","muscle flex"),("🫶","heart hands"),
            ("🤷","shrug"),("🤦","facepalm"),("🧠","brain"),("👀","eyes"),("👑","crown"),("🫡","salute"),
        ]),
        ("Nature", "leaf", [
            ("🐶","dog"),("🐱","cat"),("🐭","mouse"),("🐹","hamster"),("🐰","rabbit"),("🦊","fox"),
            ("🐻","bear"),("🐼","panda"),("🐨","koala"),("🐯","tiger"),("🦁","lion"),("🐸","frog"),
            ("🐵","monkey"),("🐔","chicken"),("🐧","penguin"),("🦄","unicorn"),("🐝","bee"),("🦋","butterfly"),
            ("🌵","cactus"),("🌲","evergreen"),("🌹","rose"),("🌻","sunflower"),("🍀","clover luck"),("🍄","mushroom"),
            ("🌙","moon"),("⭐","star"),("🌈","rainbow"),("⚡","zap lightning"),("🔥","fire"),("❄️","snowflake"),
            ("💧","droplet"),("🌊","wave water"),
        ]),
        ("Food", "fork.knife", [
            ("🍎","apple"),("🍌","banana"),("🍉","watermelon"),("🍇","grapes"),("🍓","strawberry"),("🍒","cherries"),
            ("🍑","peach"),("🥭","mango"),("🍍","pineapple"),("🥑","avocado"),("🍔","burger"),("🍟","fries"),
            ("🍕","pizza"),("🌭","hotdog"),("🌮","taco"),("🌯","burrito"),("🍜","ramen noodles"),("🍣","sushi"),
            ("🍩","donut"),("🍪","cookie"),("🎂","birthday cake"),("🍰","cake"),("🍫","chocolate"),("🍿","popcorn"),
            ("☕","coffee"),("🍺","beer"),("🍷","wine"),("🥤","cup straw"),
        ]),
        ("Travel", "car", [
            ("🚗","car"),("🚕","taxi"),("🚌","bus"),("🏎️","race car"),("🚓","police car"),("🚑","ambulance"),
            ("🚒","fire engine"),("🚲","bike"),("🏍️","motorcycle"),("✈️","airplane"),("🚀","rocket"),("🛸","ufo"),
            ("🚁","helicopter"),("⛵","sailboat"),("🚢","ship"),("🗽","statue liberty"),("🗼","tokyo tower"),("🏰","castle"),
            ("🏝️","desert island"),("⛰️","mountain"),("🏠","house"),("🌋","volcano"),
        ]),
        ("Activity", "gamecontroller", [
            ("⚽","soccer"),("🏀","basketball"),("🏈","football"),("⚾","baseball"),("🎾","tennis"),("🏐","volleyball"),
            ("🎱","8ball"),("🏓","ping pong"),("🥊","boxing"),("⛳","golf"),("🎣","fishing"),("🎽","running"),
            ("🛹","skateboard"),("🎿","ski"),("🏆","trophy"),("🥇","gold medal"),("🎯","dart target"),("🎮","video game"),
            ("🕹️","joystick"),("🎲","dice"),("♟️","chess"),("🎰","slot machine"),("🎳","bowling"),("🎤","microphone sing"),
            ("🎧","headphones"),("🎸","guitar"),("🎹","piano"),("🥁","drum"),("🎨","art palette"),("🎬","clapper movie"),
        ]),
        ("Objects", "lightbulb", [
            ("⌚","watch"),("📱","phone"),("💻","laptop"),("⌨️","keyboard"),("🖥️","desktop"),("🖨️","printer"),
            ("📷","camera"),("🎥","movie camera"),("🔍","magnifier search"),("💡","bulb idea"),("🔦","flashlight"),("📚","books"),
            ("📝","memo note"),("✏️","pencil"),("📌","pushpin"),("📎","paperclip"),("🔒","lock"),("🔑","key"),
            ("🔨","hammer"),("🛠️","tools"),("⚙️","gear"),("🧲","magnet"),("💣","bomb"),("🧪","test tube"),
            ("💊","pill"),("💰","money bag"),("💎","gem diamond"),("📦","package"),("🎁","gift"),("🎈","balloon"),
            ("🎉","party popper tada"),("🎊","confetti"),
        ]),
        ("Symbols", "heart", [
            ("❤️","red heart"),("🧡","orange heart"),("💛","yellow heart"),("💚","green heart"),("💙","blue heart"),
            ("💜","purple heart"),("🖤","black heart"),("🤍","white heart"),("💔","broken heart"),("💕","two hearts"),
            ("💖","sparkling heart"),("💯","hundred"),("💢","anger"),("💥","collision boom"),("💫","dizzy"),("💦","sweat drops"),
            ("✨","sparkles"),("❗","exclamation"),("❓","question"),("✅","check mark"),("❌","cross mark"),("⚠️","warning"),
            ("🚫","prohibited"),("♻️","recycle"),("🔞","18 plus"),("🆒","cool"),("🆕","new"),("🆓","free"),
        ]),
        ("Flags", "flag", [
            ("🏁","checkered flag"),("🚩","triangular flag"),("🏴‍☠️","pirate flag"),("🏳️","white flag"),
            ("🏳️‍🌈","rainbow flag"),("🇺🇸","usa"),("🇬🇧","uk"),("🇨🇦","canada"),("🇦🇺","australia"),("🇩🇪","germany"),
            ("🇫🇷","france"),("🇪🇸","spain"),("🇮🇹","italy"),("🇯🇵","japan"),("🇰🇷","korea"),("🇧🇷","brazil"),
            ("🇲🇽","mexico"),("🇮🇳","india"),
        ]),
    ]

    static let recentKey = "zk.recentEmoji"
    static func recents() -> [String] {
        UserDefaults.standard.stringArray(forKey: recentKey) ?? []
    }
    static func pushRecent(_ emoji: String) {
        var r = recents()
        r.removeAll { $0 == emoji }
        r.insert(emoji, at: 0)
        if r.count > 24 { r = Array(r.prefix(24)) }
        UserDefaults.standard.set(r, forKey: recentKey)
    }
}

/// Unified emoji picker sheet (web EmojiPicker parity): search across
/// unicode + server emoji, a Recently Used row, unicode category sections,
/// and the guild's custom emoji. Calls back with either a literal unicode
/// glyph or a `:name:` token for custom emoji.
struct EmojiPickerSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let onPick: (String) -> Void

    @State private var query = ""
    private let cols = [GridItem(.adaptive(minimum: 44), spacing: 6)]

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    if query.trimmingCharacters(in: .whitespaces).isEmpty {
                        if !EmojiCatalog.recents().isEmpty {
                            section("RECENTLY USED") {
                                grid(EmojiCatalog.recents().map { ($0, "") })
                            }
                        }
                        if !store.guildEmojis.isEmpty {
                            section("SERVER") { customGrid(store.guildEmojis) }
                        }
                        ForEach(EmojiCatalog.categories, id: \.name) { cat in
                            section(cat.name.uppercased()) { grid(cat.emoji) }
                        }
                    } else {
                        let q = query.lowercased()
                        let unicodeHits = EmojiCatalog.categories.flatMap(\.emoji)
                            .filter { $0.1.contains(q) }
                        let customHits = store.guildEmojis.filter { $0.name.lowercased().contains(q) }
                        if unicodeHits.isEmpty && customHits.isEmpty {
                            Text("No emoji found")
                                .font(.zkSans(13)).foregroundColor(Theme.ink3)
                                .frame(maxWidth: .infinity).padding(.top, 24)
                        }
                        if !customHits.isEmpty { section("SERVER") { customGrid(customHits) } }
                        if !unicodeHits.isEmpty { section("EMOJI") { grid(unicodeHits) } }
                    }
                }
                .padding(12)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .searchable(text: $query, placement: .navigationBarDrawer(displayMode: .always), prompt: "Search emoji")
            .navigationTitle("Add Reaction")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Close") } }
            .task { await store.loadEmojis() }
        }
    }

    private func section(_ title: String, @ViewBuilder content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title)
                .font(.zkMono(10.5))
                .tracking(Theme.capTracking(10.5))
                .foregroundColor(Theme.ink3)
            content()
        }
    }

    private func grid(_ items: [(String, String)]) -> some View {
        LazyVGrid(columns: cols, spacing: 6) {
            ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                Button {
                    EmojiCatalog.pushRecent(item.0)
                    onPick(item.0)
                } label: {
                    Text(item.0)
                        .font(.system(size: 28))
                        .frame(width: 44, height: 44)
                        .background(Theme.bg2)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func customGrid(_ emojis: [GuildEmoji]) -> some View {
        LazyVGrid(columns: cols, spacing: 6) {
            ForEach(emojis) { e in
                Button {
                    onPick(":\(e.name):")
                } label: {
                    Group {
                        if let img = store.emojiImage(for: e) {
                            Image(uiImage: img).resizable().scaledToFit()
                        } else {
                            AsyncImage(url: assetURL(e.url)) { phase in
                                if case .success(let image) = phase {
                                    image.resizable().scaledToFit()
                                } else {
                                    Text(":\(e.name):").font(.zkSans(9)).foregroundColor(Theme.ink3)
                                }
                            }
                        }
                    }
                    .padding(8)
                    .frame(width: 44, height: 44)
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
        }
    }
}

// ── Password strength (approximate port of the web meter) ───────────────────
func passwordStrength(_ pw: String) -> Int {
    if pw.isEmpty { return 0 }
    var score = 0
    if pw.count >= 8 { score += 1 }
    if pw.count >= 12 { score += 1 }
    let hasUpper = pw.range(of: "[A-Z]", options: .regularExpression) != nil
    let hasLower = pw.range(of: "[a-z]", options: .regularExpression) != nil
    if hasUpper && hasLower { score += 1 }
    if pw.range(of: "[0-9]", options: .regularExpression) != nil { score += 1 }
    if pw.range(of: "[^A-Za-z0-9]", options: .regularExpression) != nil { score += 1 }
    return min(4, score)
}

func passwordStrengthLabel(_ score: Int) -> String {
    ["", "Weak", "Fair", "Good", "Strong"][max(0, min(4, score))]
}

func passwordStrengthColor(_ score: Int) -> Color {
    switch score {
    case 0: return Theme.ink4
    case 1: return Theme.danger
    case 2: return Theme.accent3
    case 3: return Theme.accent2
    default: return Theme.accent
    }
}
