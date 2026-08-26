import SwiftUI
import PhotosUI
import UIKit
import UniformTypeIdentifiers
import AVKit
import AVFoundation
import ImageIO

/// Profanity mask for the parental "blur swear words" filter. When a supervised
/// child's effective restrictions have `filterProfanity` on, message bodies are
/// run through `mask`, which masks each whole-word profanity match to its first
/// letter + bullets (e.g. `fucking` → `f••••••`). The word set is ported from
/// the server's WATCH + BLOCKED presets; whole-word, case-insensitive, matching
/// the server's automod semantics. Client-side render only.
enum ProfanityFilter {
    // BLOCKED (slurs) + WATCH (general profanity + sexual/explicit).
    private static let words: [String] = [
        "nigger", "niggers", "nigga", "niggas", "chink", "chinks", "gook",
        "spic", "spics", "wetback", "wetbacks", "kike", "kikes", "beaner",
        "beaners", "raghead", "towelhead", "faggot", "faggots", "fag", "fags",
        "dyke", "dykes", "tranny", "trannies", "retard", "retards", "retarded",
        "fuck", "fucks", "fucked", "fucker", "fuckers", "fucking", "motherfucker",
        "motherfuckers", "motherfucking", "shit", "shits", "shitty", "bullshit",
        "shithead", "dumbass", "jackass", "asshole", "assholes", "arsehole",
        "bastard", "bastards", "bitch", "bitches", "bitchy", "son of a bitch",
        "goddamn", "goddammit", "piss off", "pissed off",
        "cock", "cocks", "cocksucker", "dick", "dicks", "dickhead", "pussy",
        "pussies", "cunt", "cunts", "twat", "wank", "wanker", "jerkoff",
        "jerk off", "blowjob", "blow job", "handjob", "hand job", "cum",
        "jizz", "tits", "titties", "boobs", "dildo", "porn", "porno",
        "pornography", "slut", "sluts", "slutty", "whore", "whores", "hoe",
        "hoes", "skank",
    ]

    // Longer phrases first so they win over their substrings.
    private static let regex: NSRegularExpression? = {
        let alt = words
            .sorted { $0.count > $1.count }
            .map { NSRegularExpression.escapedPattern(for: $0) }
            .joined(separator: "|")
        return try? NSRegularExpression(pattern: "\\b(\(alt))\\b", options: [.caseInsensitive])
    }()

    // Custom-emoji shortcodes (:name:) and mention/channel tokens (<…>) must NOT
    // be masked — rewriting their inner text (e.g. :cum: → :c••:) corrupts the
    // token so it no longer resolves. Skip any profanity match overlapping one.
    private static let protectedRegex = try? NSRegularExpression(pattern: ":[A-Za-z0-9_]+:|<[^>]+>")

    static func mask(_ text: String) -> String {
        guard !text.isEmpty, let re = regex else { return text }
        let ns = text as NSString
        let full = NSRange(location: 0, length: ns.length)
        let protectedRanges = protectedRegex?.matches(in: text, range: full).map { $0.range } ?? []
        let matches = re.matches(in: text, range: full).filter { m in
            !protectedRanges.contains { NSIntersectionRange($0, m.range).length > 0 }
        }
        guard !matches.isEmpty else { return text }
        var result = text
        // Masking is length-preserving (letter→letter/•, others unchanged), so
        // replacing back-to-front keeps every range valid.
        for m in matches.reversed() {
            guard let r = Range(m.range, in: result) else { continue }
            result.replaceSubrange(r, with: maskWord(ns.substring(with: m.range)))
        }
        return result
    }

    private static func maskWord(_ word: String) -> String {
        var seenFirst = false
        var out = ""
        for ch in word {
            if ch.isLetter || ch.isNumber {
                if seenFirst { out.append("•") } else { seenFirst = true; out.append(ch) }
            } else {
                out.append(ch)
            }
        }
        return out
    }
}

/// Decodes image bytes downsampled to a target pixel size via ImageIO, so the
/// full-resolution bitmap is never realized in memory. Pure + off-main-safe —
/// call it inside a detached task. Inline message images display at ≤240pt yet
/// the raw bytes are often ~1920px, so downsampling cuts decode time + memory
/// dramatically (the worst offender being multi-MB E2EE photos decoded on the
/// main thread). Falls back to a plain decode if thumbnailing fails.
enum ImageDownsampler {
    static func decode(_ data: Data, maxPixels: CGFloat) -> UIImage? {
        let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let src = CGImageSourceCreateWithData(data as CFData, srcOpts) else {
            return UIImage(data: data)
        }
        let opts: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceCreateThumbnailWithTransform: true, // honor EXIF orientation
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
        ]
        guard let cg = CGImageSourceCreateThumbnailAtIndex(src, 0, opts as CFDictionary) else {
            return UIImage(data: data)
        }
        return UIImage(cgImage: cg)
    }
}

/// Shrinks picked media BEFORE it is uploaded — and, critically, BEFORE it is
/// encrypted.
///
/// WHY THIS HAS TO LIVE ON THE CLIENT. The server has two compression
/// backstops, and an E2EE attachment is invisible to both by construction: the
/// WebP re-encode (`services/uploads.ts`, `encodeWebp(maxDim: 1920, quality:
/// 80)`) and the nightly sweep (`services/imageCompression.ts`) each gate on
/// `contentType` starting with `image/`, and every `.zke` blob is uploaded as
/// `application/octet-stream`. The server holds no channel key, so it could not
/// re-encode the bytes even if it wanted to. Measured on the live server before
/// this existed: a plain image averaged **84 KB** on disk while an E2EE image
/// averaged **~3,100 KB** — the same photos from the same people, 37x the
/// bytes, purely because of which path they took. 96% of all stored bytes were
/// `.zke`.
///
/// The contract deliberately matches the web client
/// (`apps/web/src/lib/compressImage.ts`: 1920px longest edge, quality ~0.8) so
/// every client puts the same thing on disk.
///
/// ORIENTATION. This is the one way a downscale can be actively worse than no
/// downscale, so it is handled twice over:
///  1. `ImageDownsampler.decode` passes `kCGImageSourceCreateThumbnailWith
///     Transform: true`, so ImageIO applies the EXIF orientation while
///     producing the reduced bitmap — the pixels come out upright and the
///     resulting `UIImage` is `.up`.
///  2. `encode` still calls `normalizedUp` before touching `.cgImage` (the
///     WebP path writes the CGImage directly and would otherwise drop a
///     rotation), and the reported pixel dimensions come from
///     `UIImage.size` / EXIF-aware `sourceDimensions`, which are transposed for
///     the 90-degree orientations (EXIF 5-8).
/// Nothing downstream re-applies an orientation tag, so an upright bitmap with
/// no tag is exactly right.
///
/// Everything here is pure and off-main-safe: call it from a detached task.
enum MediaPrep {
    /// Longest-edge bound for a MAIN image upload (web parity).
    static let imageMaxPixels: CGFloat = 1920
    /// Lossy quality for a main image upload (web parity: 0.82).
    static let imageQuality: CGFloat = 0.8
    /// Longest-edge bound for the inline preview. Unchanged from the previous
    /// behaviour, and equal to the server's own 480px thumbnails.
    static let thumbMaxPixels: CGFloat = 480
    /// Lossy quality for the inline preview. Unchanged.
    static let thumbQuality: CGFloat = 0.6
    /// Videos smaller than this skip the export: a transcode round-trip costs
    /// the user seconds and battery for a trivial saving.
    static let videoExportMinBytes = 5 * 1024 * 1024
    /// 720p. The two `video.mov.zke` blobs on the server averaged 44 MB each.
    static let videoExportPreset = AVAssetExportPreset1280x720

    /// One picked attachment on the way in.
    struct Input: Sendable {
        let data: Data
        let filename: String
        let contentType: String
    }

    /// One attachment on the way out. `data`/`filename`/`contentType` are what
    /// should actually be uploaded — they differ from the input whenever the
    /// re-encode was a win.
    struct Prepared: Sendable {
        var data: Data
        var filename: String
        var contentType: String
        /// Pixel dimensions OF THE BYTES IN `data` (EXIF-corrected). Sent as
        /// plaintext metadata so a recipient can reserve the layout slot for an
        /// E2EE image the server cannot measure.
        var width: Int?
        var height: Int?
        /// PLAINTEXT inline-preview bytes. The caller encrypts these in an E2EE
        /// conversation. nil means we could not decode the image at all — see
        /// the hard-fail in `AppStore.sendAttachments`.
        var thumbnail: Data?
        /// Declared-image input (drives the "a thumbnail is mandatory" rule).
        var isImage: Bool
        /// Original byte count, for the savings log.
        var originalBytes: Int
        /// A video whose 720p export was attempted and failed, so the ORIGINAL
        /// bytes are going up. Deliberately non-fatal: never block a send on a
        /// transcode.
        var videoExportFailed: Bool
    }

    /// Prepare a batch. Images are downscaled + re-encoded; videos are exported
    /// to 720p; anything else (a future arbitrary-file picker) passes through
    /// completely untouched.
    static func prepareAll(_ inputs: [Input]) async -> [Prepared] {
        var out: [Prepared] = []
        out.reserveCapacity(inputs.count)
        for input in inputs {
            if input.contentType.hasPrefix("video/") {
                out.append(await prepareVideo(input))
            } else if input.contentType.hasPrefix("image/") {
                out.append(prepareImage(input))
            } else {
                out.append(Prepared(
                    data: input.data, filename: input.filename,
                    contentType: input.contentType, width: nil, height: nil,
                    thumbnail: nil, isImage: false,
                    originalBytes: input.data.count, videoExportFailed: false))
            }
        }
        return out
    }

    // MARK: Images

    private static func prepareImage(_ input: Input) -> Prepared {
        var out = Prepared(
            data: input.data, filename: input.filename,
            contentType: input.contentType, width: nil, height: nil,
            thumbnail: nil, isImage: true,
            originalBytes: input.data.count, videoExportFailed: false)

        let srcOpts = [kCGImageSourceShouldCache: false] as CFDictionary
        guard let src = CGImageSourceCreateWithData(input.data as CFData, srcOpts) else {
            // Undecodable as an image. Leave the bytes alone and leave
            // `thumbnail` nil — the E2EE path treats that as fatal.
            return out
        }
        if let dims = sourceDimensions(src) {
            out.width = dims.width
            out.height = dims.height
        }

        // Every image gets a preview, including the ones we do not re-encode.
        if let small = ImageDownsampler.decode(input.data, maxPixels: thumbMaxPixels),
           let encoded = encode(small, quality: thumbQuality) {
            out.thumbnail = encoded.data
        }

        // Multi-frame sources (animated GIF / APNG / HEICS) must not be
        // re-encoded — ImageIO would hand back a single still and we would
        // silently destroy the animation. The still thumbnail above is fine.
        guard CGImageSourceGetCount(src) <= 1 else { return out }

        guard let full = ImageDownsampler.decode(input.data, maxPixels: imageMaxPixels),
              let encoded = encode(full, quality: imageQuality) else {
            return out
        }
        // Only take the re-encode when it is actually smaller. A modest,
        // already-compressed image can grow under a second lossy pass, and
        // paying quality for extra bytes is strictly worse than doing nothing.
        guard encoded.data.count < input.data.count else { return out }

        out.data = encoded.data
        out.contentType = encoded.mime
        let base = (input.filename as NSString).deletingPathExtension
        out.filename = (base.isEmpty ? "image" : base) + "." + encoded.ext
        // Dimensions must describe the bytes we are actually uploading.
        out.width = Int(full.size.width.rounded())
        out.height = Int(full.size.height.rounded())
        return out
    }

    /// EXIF-aware pixel dimensions read from the header, without decoding.
    /// Orientations 5-8 are the 90-degree rotations, where the displayed size
    /// is the transpose of the stored size.
    private static func sourceDimensions(_ src: CGImageSource) -> (width: Int, height: Int)? {
        guard let props = CGImageSourceCopyPropertiesAtIndex(src, 0, nil) as? [CFString: Any],
              let w = props[kCGImagePropertyPixelWidth] as? Int,
              let h = props[kCGImagePropertyPixelHeight] as? Int else { return nil }
        let orientation = (props[kCGImagePropertyOrientation] as? Int) ?? 1
        return (orientation >= 5 && orientation <= 8) ? (h, w) : (w, h)
    }

    /// Encode a (already downscaled) bitmap. Prefers WebP for web/Android/iOS
    /// parity and alpha support, but ImageIO only gained a WebP *encoder* on
    /// some OS versions, so availability is probed at runtime and JPEG (opaque)
    /// / PNG (has alpha) are the fallbacks. All three decode everywhere the app
    /// runs — unlike HEIC, which is why HEIC is deliberately not a target here.
    private static func encode(_ image: UIImage, quality: CGFloat) -> (data: Data, ext: String, mime: String)? {
        let upright = normalizedUp(image)
        if webpEncodingAvailable, let webp = webpData(upright, quality: quality) {
            return (webp, "webp", "image/webp")
        }
        if hasAlpha(upright), let png = upright.pngData() {
            return (png, "png", "image/png")
        }
        if let jpeg = upright.jpegData(compressionQuality: quality) {
            return (jpeg, "jpg", "image/jpeg")
        }
        return upright.pngData().map { ($0, "png", "image/png") }
    }

    /// Bake any residual EXIF rotation into the pixels. `ImageDownsampler`
    /// already does this on its fast path, but it falls back to a plain
    /// `UIImage(data:)` (orientation still pending) when thumbnailing fails —
    /// and the WebP encoder writes `.cgImage` straight out, which would ignore
    /// it and hand the recipient a sideways photo.
    private static func normalizedUp(_ image: UIImage) -> UIImage {
        guard image.imageOrientation != .up else { return image }
        let format = UIGraphicsImageRendererFormat.preferred()
        format.scale = 1
        format.opaque = !hasAlpha(image)
        // `image.size` is already the DISPLAY size (transposed for a 90-degree
        // orientation) and `draw(in:)` applies the transform, so this both
        // rotates the pixels and lands on the right canvas.
        return UIGraphicsImageRenderer(size: image.size, format: format).image { _ in
            image.draw(in: CGRect(origin: .zero, size: image.size))
        }
    }

    private static func hasAlpha(_ image: UIImage) -> Bool {
        guard let info = image.cgImage?.alphaInfo else { return false }
        switch info {
        case .none, .noneSkipFirst, .noneSkipLast: return false
        default: return true
        }
    }

    private static let webpEncodingAvailable: Bool = {
        let types = (CGImageDestinationCopyTypeIdentifiers() as NSArray) as? [String] ?? []
        return types.contains(UTType.webP.identifier)
    }()

    private static func webpData(_ image: UIImage, quality: CGFloat) -> Data? {
        guard let cg = image.cgImage else { return nil }
        let out = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(
            out, UTType.webP.identifier as CFString, 1, nil) else { return nil }
        let props: [CFString: Any] = [kCGImageDestinationLossyCompressionQuality: quality]
        CGImageDestinationAddImage(dest, cg, props as CFDictionary)
        guard CGImageDestinationFinalize(dest) else { return nil }
        return out as Data
    }

    // MARK: Video

    /// Export to 720p H.264/MP4 before upload. Any failure falls back to the
    /// ORIGINAL bytes and flags `videoExportFailed` — a send is never blocked on
    /// a transcode, because a video that will not export is still a video the
    /// user wants to send.
    ///
    /// `AVAssetExportSession` preserves the source's `preferredTransform`, so a
    /// portrait clip stays portrait; there is no rotation hazard on this path.
    private static func prepareVideo(_ input: Input) async -> Prepared {
        var out = Prepared(
            data: input.data, filename: input.filename,
            contentType: input.contentType, width: nil, height: nil,
            thumbnail: nil, isImage: false,
            originalBytes: input.data.count, videoExportFailed: false)
        guard input.data.count > videoExportMinBytes else { return out }

        let tmp = FileManager.default.temporaryDirectory
        let ext = (input.filename as NSString).pathExtension
        let inURL = tmp.appendingPathComponent("zk-src-\(UUID().uuidString).\(ext.isEmpty ? "mov" : ext)")
        let outURL = tmp.appendingPathComponent("zk-720-\(UUID().uuidString).mp4")
        defer {
            try? FileManager.default.removeItem(at: inURL)
            try? FileManager.default.removeItem(at: outURL)
        }
        // AVAsset needs a file URL; the picker only ever hands us bytes.
        do {
            try input.data.write(to: inURL, options: .atomic)
        } catch {
            out.videoExportFailed = true
            return out
        }
        let asset = AVURLAsset(url: inURL)
        guard let session = AVAssetExportSession(asset: asset, presetName: videoExportPreset) else {
            out.videoExportFailed = true
            return out
        }
        session.shouldOptimizeForNetworkUse = true
        guard await runExport(session, to: outURL),
              let exported = try? Data(contentsOf: outURL) else {
            out.videoExportFailed = true
            return out
        }
        // A short clip that is already small can come back bigger; keep whichever
        // is smaller. Not a failure — nothing went wrong, the export just did not
        // pay off.
        guard exported.count < input.data.count else { return out }

        let base = (input.filename as NSString).deletingPathExtension
        out.data = exported
        out.filename = (base.isEmpty ? "video" : base) + ".mp4"
        out.contentType = "video/mp4"
        return out
    }

    /// The iOS 17 floor still needs `exportAsynchronously` + `status`, both of
    /// which are deprecated as of iOS 18; marking this helper deprecated keeps
    /// the call sites quiet without pretending the API is gone. The completion
    /// handler is `NS_SWIFT_SENDABLE` while `AVAssetExportSession` is
    /// `NS_SWIFT_NONSENDABLE`, so the closure captures ONLY the continuation —
    /// the session is read back afterwards, outside the closure.
    @available(iOS, deprecated: 18.0, message: "Kept for the iOS 17 deployment floor.")
    private static func runExport(_ session: AVAssetExportSession, to url: URL) async -> Bool {
        session.outputURL = url
        session.outputFileType = .mp4
        await withCheckedContinuation { (cont: CheckedContinuation<Void, Never>) in
            session.exportAsynchronously { cont.resume() }
        }
        return session.status == .completed
    }
}

/// A channel's message timeline plus the composer. Auto-scrolls to the newest
/// message and keeps the composer pinned above the keyboard.
struct MessageListView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var session: Session
    let channel: Channel

    @State private var draft = ""
    // Plain @State (not @FocusState) because the composer is now a UITextView
    // representable (ComposerTextView) that bridges focus through this binding
    // — see its Coordinator. Image paste needs the UITextView; @FocusState
    // only binds to native SwiftUI fields.
    @State private var composerFocused = false
    @State private var showEnableSheet = false
    @State private var showDmSettings = false
    @State private var showPokePopover = false
    @State private var pokeHistory: [PokeHistoryEntry] = []
    @State private var pokeHistoryLoading = false
    @State private var pickerItems: [PhotosPickerItem] = []
    @State private var showPhotoPicker = false
    @State private var showCamera = false
    @State private var pendingAttachments: [PendingAttachment] = []
    @State private var showPollSheet = false
    @State private var showStickers = false
    @State private var showSchedule = false
    @State private var showEmojiPicker = false
    @StateObject private var recorder = VoiceRecorder()
    @State private var showSearch = false
    @State private var showPins = false
    @State private var lastTypingSent = Date.distantPast
    /// The channel whose initial landing has already been performed.
    ///
    /// THE LANDING IS KEYED ON CHANNEL IDENTITY, not on `store.messages.count`.
    /// The count-keyed trigger this replaces could not fire on the case that
    /// matters most: re-opening a conversation you have already visited this
    /// session seeds 50 rows from the message cache and then *replaces* them
    /// with a fresh 50-row latest window, so the count goes 50 → 50 even when
    /// the tail changed. `onChange(of:count)` never ran, the initial landing
    /// never happened, and a freshly-created ScrollView renders at offset 0 —
    /// the OLDEST of the loaded 50. Web keys the same reset on channel
    /// identity (`apps/web/src/app/MessageView.tsx`, `channelId !==
    /// prevChannelRef.current`).
    @State private var landedChannelId: String?
    /// Where THIS open landed. Re-applied while the settle window is active so
    /// late-sizing content (embeds, photos, E2EE decrypts) and the cache →
    /// server row swap can't leave the chosen row off screen. `nil` once a
    /// jump anchor owns the position.
    @State private var landing: Landing?
    /// Set shortly after the initial scroll-to-bottom so the load-older trigger
    /// can't fire during first layout (which would yank the user into history).
    @State private var didInitialScroll = false
    /// True for a short settle window after opening a channel. While set, the
    /// list re-pins to the bottom whenever its content GROWS — webhook embeds,
    /// async-loading photos/attachments, and E2EE messages all finish sizing
    /// AFTER the initial scroll, pushing the newest content below the fold. The
    /// window is bounded so it can't fight a user who scrolls up later.
    @State private var stickToBottomOnGrow = false
    /// Near-bottom gate for the incoming-message auto-scroll (web parity).
    /// ScrollViewReader exposes no scroll offset, so nearness is tracked by the
    /// bottom sentinel row's onAppear/onDisappear: while the sentinel is inside
    /// the lazy render window we're "near the bottom" and incoming messages may
    /// pull the list down; once the user scrolls up into history the sentinel
    /// disappears and incoming messages must NOT yank them (the unread divider
    /// already handles catch-up). The user's OWN sends always scroll.
    @State private var isNearBottom = true
    /// Live geometry backing `isNearBottom` (see SentinelOffsetKey).
    @State private var sentinelOffset: CGFloat = .greatestFiniteMagnitude
    @State private var viewportHeight: CGFloat = 0

    /// Reports the message list's laid-out content height, so a late growth
    /// (image load / embed render / E2EE decrypt) can re-pin us to the bottom
    /// during the open settle window.
    private struct ContentHeightKey: PreferenceKey {
        static var defaultValue: CGFloat = 0
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
    }

    /// Distance from the top of the scroll VIEWPORT to the top of the bottom
    /// sentinel, in the scroll view's own coordinate space. Shrinks toward the
    /// viewport height as you approach the bottom of the list.
    ///
    /// This replaces `onAppear`/`onDisappear` on the sentinel as the driver of
    /// `isNearBottom`. Those are unreliable here: the sentinel is a 1pt
    /// `Color.clear` inside a `LazyVStack`, and a lazy stack keeps a prefetch
    /// buffer around the visible window — so the sentinel can stay "appeared"
    /// while scrolled well off-screen and `onDisappear` simply never fires.
    /// With `isNearBottom` initialised to `true`, that left the gate stuck open
    /// forever: the jump-to-newest button never rendered, and it never
    /// recovered. Geometry is continuous and can't get wedged.
    private struct SentinelOffsetKey: PreferenceKey {
        static var defaultValue: CGFloat = .greatestFiniteMagnitude
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
    }

    /// Height of the scroll viewport (not the content).
    private struct ViewportHeightKey: PreferenceKey {
        static var defaultValue: CGFloat = 0
        static func reduce(value: inout CGFloat, nextValue: () -> CGFloat) { value = nextValue() }
    }

    /// Coordinate space the sentinel offset is measured in.
    private var chatScrollSpace: String { "chatScroll-\(channel.id)" }

    /// How close the sentinel must get to the bottom of the viewport to count
    /// as "at the bottom". One row-ish of slack so a half-row overhang doesn't
    /// flip the gate.
    private static let nearBottomSlop: CGFloat = 24

    /// The single expression of "where does this open land". Everything that
    /// positions the list on open goes through it, so there is exactly one
    /// target and it can be re-applied verbatim while the open settles.
    private enum Landing: Equatable {
        /// The newest message: DMs always, and any channel with nothing unread.
        case bottom
        /// A guild channel with unread history lands on the "New messages"
        /// divider. Carries the FROZEN BOUNDARY id, not the target row: the row
        /// is re-resolved at every apply (see `unreadLandingId`), because the
        /// cache-seeded rows this landing was chosen against get replaced by the
        /// fresh latest window a moment later — and `scrollTo` a row that is no
        /// longer in the list is a silent no-op.
        case unread(String)
    }

    /// What the message list looks like from the landing logic's point of
    /// view. Observing (count, newest id) rather than count alone is the whole
    /// point: a cached re-open swaps 50 rows for a different 50 rows, and a
    /// count-only key is blind to it.
    private struct ListKey: Equatable {
        let count: Int
        let lastId: String?
    }

    /// How far back from the newest message the unread-divider landing may
    /// put you — roughly a screenful of rows.
    private static let unreadLandingMaxRowsBack = 15

    var body: some View {
        VStack(spacing: 0) {
            header

            if isLocked {
                UnlockPanel(channel: channel)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            if store.loadingMessages && store.messages.isEmpty {
                                ProgressView().tint(Theme.accent)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 24)
                            } else if store.messages.isEmpty {
                                emptyState
                            }

                            // Load-older trigger: when scrolled to the top and
                            // more history exists, page back in.
                            if store.hasMoreMessages && !store.messages.isEmpty {
                                ProgressView().tint(Theme.accent)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 8)
                                    .onAppear {
                                        guard didInitialScroll else { return }
                                        Task { await store.loadOlderMessages() }
                                    }
                            }

                            let receiptAnchors = dmReceiptAnchors()
                            ForEach(Array(store.messages.enumerated()), id: \.element.id) { index, message in
                                if shouldShowDateDivider(at: index) {
                                    DateDividerView(label: dateDividerLabel(message.createdAt))
                                }
                                if shouldShowUnreadDivider(at: index) {
                                    UnreadDividerView()
                                }
                                let header = showHeader(at: index)
                                // .equatable() lets SwiftUI skip a row whose
                                // MessageRowData is unchanged — so per-row edits
                                // and presence/typing churn no longer re-render
                                // every visible row (O5).
                                MessageRow(store: store, data: rowData(for: message, showHeader: header, anchors: receiptAnchors))
                                    .equatable()
                                    .id(message.id)
                                    .padding(.top, header ? 10 : 0)
                                    .onAppear {
                                        // Prefetch the next older page BEFORE the user reaches
                                        // the very top, so scrollback feels instant. Fires when
                                        // a row within ~10 of the oldest loaded message appears;
                                        // loadOlderMessages is re-entrancy-guarded + dedup-safe.
                                        if didInitialScroll, store.hasMoreMessages, index <= 10 {
                                            Task { await store.loadOlderMessages() }
                                        }
                                    }
                            }

                            // Bottom sentinel: scroll target AND the near-bottom
                            // tracker (see isNearBottom above).
                            //
                            // onAppear/onDisappear used to drive `isNearBottom`
                            // from here. They can't be trusted for a 1pt
                            // `Color.clear` in a LazyVStack (see
                            // SentinelOffsetKey), so the flag is now derived
                            // from this view's measured offset instead. onAppear
                            // is kept ONLY as an optimistic open — the geometry
                            // reading corrects it either way on the next frame.
                            Color.clear.frame(height: 1)
                                .onAppear { isNearBottom = true }
                                .id(bottomAnchor)
                                .background(GeometryReader { sp in
                                    Color.clear.preference(
                                        key: SentinelOffsetKey.self,
                                        value: sp.frame(in: .named(chatScrollSpace)).minY,
                                    )
                                })
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                        .background(GeometryReader { gp in
                            Color.clear.preference(key: ContentHeightKey.self, value: gp.size.height)
                        })
                    }
                    // A conversation is read from the bottom up. Without this,
                    // content shorter than the viewport renders TOP-aligned —
                    // a three-message DM sits at the top of the screen with a
                    // large gap above the composer, and no `scrollTo` can fix
                    // it because there is nothing to scroll. It also means a
                    // freshly-created ScrollView starts at the newest row
                    // rather than at offset 0 (the oldest of the loaded 50),
                    // which is the floor under every landing below.
                    .defaultScrollAnchor(.bottom)
                    // Named space the bottom sentinel measures itself against,
                    // plus the viewport height to compare it to. Both feed the
                    // near-bottom gate below.
                    .coordinateSpace(name: chatScrollSpace)
                    .background(GeometryReader { vp in
                        Color.clear.preference(key: ViewportHeightKey.self, value: vp.size.height)
                    })
                    .onPreferenceChange(ViewportHeightKey.self) { h in
                        viewportHeight = h
                        recomputeNearBottom()
                    }
                    .onPreferenceChange(SentinelOffsetKey.self) { y in
                        sentinelOffset = y
                        recomputeNearBottom()
                    }
                    .onPreferenceChange(ContentHeightKey.self) { _ in
                        // Late-sizing content (webhook embeds, photos/attachments
                        // loading, E2EE text decrypting) grows the rows AFTER the
                        // landing, pushing the chosen row off screen. While the
                        // open settle window is active, re-apply THE SAME landing
                        // on each growth.
                        //
                        // This used to bail out for a guild channel with unread
                        // (`channel.isDM || store.unreadBoundaryId == nil`), which
                        // — together with the count-keyed trigger that never fired
                        // on a cached re-open — meant such a channel performed
                        // ZERO scrolls and opened 50 messages up. Re-applying the
                        // landing is correct for the divider case too, because the
                        // divider IS the chosen position.
                        guard stickToBottomOnGrow, store.pendingScrollAnchorId == nil else { return }
                        applyLanding(proxy)
                    }
                    .onChange(of: ListKey(count: store.messages.count,
                                         lastId: store.messages.last?.id)) { old, new in
                        // 1. This open hasn't landed yet — a cold open, where the
                        //    rows arrive after onAppear. Land now.
                        if landedChannelId != channel.id {
                            landInitial(proxy)
                            return
                        }
                        // An APPEND grows the list AND moves the tail. Requiring
                        // both is what keeps a PREPEND (older page paged in:
                        // count grows, newest id unchanged) from being followed
                        // to the bottom — that case is owned by the anchor
                        // restore below.
                        let appended = new.count > old.count && new.lastId != old.lastId
                        let ownSend = appended
                            && store.messages.last?.authorId != nil
                            && store.messages.last?.authorId == store.currentUserId
                        // 2. The user's own send always lands on what they just
                        //    sent, and it ENDS a divider landing — they've engaged
                        //    with the bottom of the conversation.
                        if ownSend {
                            landing = .bottom
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(bottomAnchor, anchor: .bottom)
                            }
                            return
                        }
                        // 3. Still inside the open settle window. The cache-seeded
                        //    rows were just REPLACED by the fresh latest window —
                        //    often the same count with a different tail, which the
                        //    old count-only key could not see at all — so the
                        //    current offset is meaningless. Re-apply the landing
                        //    rather than treating the swap as an append. (Yields
                        //    to a jump/prepend anchor, which owns the position —
                        //    same guard the height-growth re-pin uses.)
                        if stickToBottomOnGrow, store.pendingScrollAnchorId == nil {
                            applyLanding(proxy)
                            return
                        }
                        // 4. Steady state: follow an APPEND only while the user is
                        //    near the bottom. If they've scrolled up to read
                        //    history, do NOTHING — an incoming message must not
                        //    yank them down (the unread divider handles catch-up),
                        //    and a deletion (count shrink) never scrolls.
                        if appended, isNearBottom {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(bottomAnchor, anchor: .bottom)
                            }
                        }
                    }
                    .onChange(of: store.pendingScrollAnchorId) { _, anchor in
                        // After an older page prepends, jump back to the message
                        // that was previously at the top so the view doesn't lurch.
                        guard let anchor else { return }
                        // Anchored jumps (deep links, prepend restores) land
                        // mid-history — close the near-bottom gate so an incoming
                        // message can't yank the user off the anchor. If the
                        // anchor is in fact near the bottom, the sentinel's
                        // onAppear reopens the gate on the same layout pass.
                        isNearBottom = false
                        // The anchor now owns the position: retire this open's
                        // landing so the settle window can't drag the user back
                        // off the message they jumped to once the anchor clears.
                        landing = nil
                        landedChannelId = channel.id
                        // Two-phase restore: once synchronously (limits the
                        // visible flash), then again on the next runloop turn
                        // AFTER the freshly-prepended LazyVStack rows have
                        // actually laid out — scrolling only in the same
                        // transaction that inserted them targets unmeasured
                        // rows and produced the exact lurch this exists to
                        // prevent.
                        withAnimation(.none) { proxy.scrollTo(anchor, anchor: .top) }
                        DispatchQueue.main.async {
                            withAnimation(.none) { proxy.scrollTo(anchor, anchor: .top) }
                            store.pendingScrollAnchorId = nil
                        }
                    }
                    .onAppear {
                        // A fresh open: nothing has landed for this channel yet.
                        // (Both hosts key the page on the route — MainView
                        // `.id(routeKey)` — so this fires once per channel open.)
                        landedChannelId = nil
                        landing = nil
                        // A fresh open lands at, or a screenful above, the bottom,
                        // so start the gate open; the sentinel's onDisappear closes
                        // it as soon as the user scrolls up into history.
                        isNearBottom = true
                        // Re-apply the landing as late-sizing content settles
                        // (see stickToBottomOnGrow + the height preference above).
                        stickToBottomOnGrow = true
                        // Rows are usually ALREADY present here: openChannel seeds
                        // them synchronously from the message cache. Land on the
                        // next runloop turn, once that seed has happened and the
                        // LazyVStack has laid the rows out. If the cache was empty
                        // this is a no-op and the ListKey change above lands it.
                        DispatchQueue.main.async { landInitial(proxy) }
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                            didInitialScroll = true
                        }
                        // Close the stick-to-bottom window. Long enough to cover
                        // an embed/E2EE decrypt and a typical photo load, short
                        // enough not to fight deliberate scrolling.
                        DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
                            stickToBottomOnGrow = false
                        }
                    }
                    .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
                        // The keyboard grows the bottom safe area, shrinking the
                        // ScrollView from the bottom; SwiftUI keeps the old offset,
                        // hiding the newest messages behind the keyboard. Re-pin to
                        // the bottom so the latest stays visible above it. Skip
                        // while replying to a (possibly scrolled-up) message — the
                        // "Replying to" bar keeps the user in place by design.
                        guard composerFocused, store.replyingTo == nil else { return }
                        DispatchQueue.main.async {
                            withAnimation(.easeOut(duration: 0.2)) {
                                proxy.scrollTo(bottomAnchor, anchor: .bottom)
                            }
                        }
                    }
                    // Jump-to-newest, pinned to the bottom-right of the message
                    // list. LAST in the chain on purpose: an overlay's content
                    // contributes preferences to whatever sits ABOVE it, so
                    // adding it here keeps it out of the ContentHeightKey
                    // reduction the landing logic reads.
                    //
                    // Anchoring it to the ScrollView (rather than to the
                    // composer's safeAreaInset) is what makes it track the
                    // composer for free: a reply bar, attachment chips or the
                    // keyboard all grow the bottom inset, the list shrinks, and
                    // the button rides up with it — no height measurement.
                    .overlay(alignment: .bottomTrailing) {
                        // REUSES the near-bottom gate the incoming-message
                        // auto-scroll already owns (`isNearBottom`, driven by the
                        // bottom sentinel) instead of adding a second threshold
                        // that could disagree with it: "new messages won't pull
                        // the list down" and "show the jump button" are the same
                        // state, and they must never be true separately.
                        //
                        // A plain `if` — no opacity fade, no `.transition`. At
                        // the bottom the button must be ABSENT from the
                        // hierarchy, not invisible: a faded-out/transitioning
                        // view can linger as a hit-test region, and this one
                        // hovers 2pt above the send button.
                        if !isNearBottom {
                            jumpToLatestButton(proxy)
                        }
                    }
                }
                .background(Theme.bg1.opacity(0.9))
            }
        }
        .background(Theme.bg1.opacity(0.9))
        .onAppear { store.openChannel(channel) }
        // Swipe-back is handled at the navigation container (MainView.compactNav)
        // so the page can follow the finger and reveal the screen behind it.
        // `spacing: 0` is load-bearing, not tidying. Without it SwiftUI
        // inserts its DEFAULT 8pt between the ScrollView and the inset, so
        // the list's bottom edge stops 8pt short of the composer's top
        // hairline — dead band nobody drew, and it silently turned the
        // jump-to-newest button's 2pt gap into a measured 10pt.
        .safeAreaInset(edge: .bottom, spacing: 0) {
            if !isLocked { composer }
        }
        .sheet(isPresented: $showEnableSheet) {
            EnableE2EESheet(channel: channel)
        }
        .sheet(isPresented: $showDmSettings) {
            DmSettingsSheet(channel: channel)
        }
    }

    // MARK: Open landing

    /// Choose and perform this channel's initial landing — ONCE per open,
    /// keyed on channel identity.
    ///
    /// Safe to call from every trigger; the `landedChannelId` guard makes the
    /// extra calls free. That is what lets one routine cover both a
    /// cache-seeded open (rows already resident at `onAppear`) and a cold open
    /// (rows arrive later, via the ListKey change) without either path needing
    /// its own speculative scroll.
    private func landInitial(_ proxy: ScrollViewProxy) {
        guard landedChannelId != channel.id else { return }
        // A deep link / jump anchor owns the position. Mark the open as landed
        // so nothing later fights it, and leave `landing` nil so the settle
        // window is a no-op.
        if store.pendingScrollAnchorId != nil {
            landedChannelId = channel.id
            landing = nil
            return
        }
        // Nothing to land on yet — a later trigger will call back.
        guard !store.messages.isEmpty else { return }

        landedChannelId = channel.id
        if !channel.isDM, let boundary = store.unreadBoundaryId,
           unreadLandingId(boundary) != nil {
            // Guild channels with unread → land on the divider. DMs always land
            // at the very bottom (iMessage-style: the newest message is what you
            // want to see on open).
            //
            // Landing mid-history: close the near-bottom gate (the sentinel never
            // appeared, so its onDisappear can't) — if the divider is in fact
            // close to the bottom the sentinel's onAppear reopens it.
            isNearBottom = false
            landing = .unread(boundary)
        } else {
            landing = .bottom
        }
        applyLanding(proxy)
    }

    /// Re-apply this open's chosen landing. No-op before a landing has been
    /// chosen, and after a jump anchor has taken ownership of the position.
    private func applyLanding(_ proxy: ScrollViewProxy) {
        switch landing {
        case .bottom:
            // No animation: animating here reads as the view "scrolling down to"
            // the newest message on every open, which is what we don't want.
            proxy.scrollTo(bottomAnchor, anchor: .bottom)
        case .unread(let boundary):
            // Re-resolved against the CURRENT rows every time — see Landing.
            if let target = unreadLandingId(boundary) {
                proxy.scrollTo(target, anchor: .top)
            }
        case nil:
            break
        }
    }

    /// "You are scrolled up" → tap to come back to the newest message.
    ///
    /// Deliberately distinct from web's bottom-CENTRE "New messages" pill,
    /// which reports that new messages ARRIVED. This one reports only where
    /// you are, so it lives at the trailing edge and the two never collide.
    ///
    /// Geometry (iOS is the design source of truth here — web and Android
    /// mirror these numbers): a 36pt disc, `Theme.bg2` fill with the same 1pt
    /// `Theme.line` border the composer box uses, inside a 44pt tap target.
    /// The target grows UP and LEFT only (`alignment: .bottomTrailing`), so
    /// the disc — not the padding — is what sits on the trailing inset and
    /// 2pt above the composer's top hairline. That is what keeps the
    /// touchable area off the send button, which the disc is centred over.
    /// Single writer for `isNearBottom`, from measured geometry.
    ///
    /// The sentinel sits at the very end of the content, so its top edge in the
    /// scroll's coordinate space is at `viewportHeight` exactly when the list is
    /// scrolled fully down. Anything meaningfully below that means there is
    /// still content underneath → show the jump button.
    ///
    /// Guarded on `viewportHeight > 0` so the first frame (before the viewport
    /// has been measured) can't briefly declare "not near bottom" and flash the
    /// button on open.
    private func recomputeNearBottom() {
        guard viewportHeight > 0, sentinelOffset != .greatestFiniteMagnitude else { return }
        let near = sentinelOffset <= viewportHeight + Self.nearBottomSlop
        if near != isNearBottom { isNearBottom = near }
    }

    /// What a tap does. Extracted so the high-priority gesture and the
    /// accessibility action invoke exactly the same thing.
    private func jumpToLatest(_ proxy: ScrollViewProxy) {
        // Tapping is engagement with the bottom of the conversation, the
        // same as sending: retire a "New messages" divider landing so the
        // open settle window can't drag the user back up to it.
        landing = .bottom
        withAnimation(.easeOut(duration: 0.2)) {
            proxy.scrollTo(bottomAnchor, anchor: .bottom)
        }
        // `isNearBottom` is NOT set here. The sentinel's measured offset owns
        // it and updates as the list settles; writing it from two places is how
        // the gate and the button drift apart.
    }

    private func jumpToLatestButton(_ proxy: ScrollViewProxy) -> some View {
        // NOT a `Button`. A Button's tap is an ordinary gesture, so while the
        // list is still decelerating UIKit spends the first tap stopping the
        // scroll and the press is swallowed — you have to wait for the list to
        // settle, then tap again. A `.highPriorityGesture` tap wins that race,
        // so the button works mid-flick, scrolling up or down.
        //
        // Accessibility is restored explicitly below (a plain view carries
        // none of Button's semantics for free).
        Group {
            Image(systemName: "chevron.down")
                .font(.system(size: 15, weight: .semibold))
                .foregroundColor(Theme.ink2)
                .frame(width: 36, height: 36)
                .background(Theme.bg2)
                .clipShape(Circle())
                .overlay(Circle().strokeBorder(Theme.line, lineWidth: 1))
                // Lifts the disc off whatever message row is behind it; the
                // fill is opaque for the same reason (bg2, not bg2/0.6 as in
                // the composer box, which has the bar behind it).
                .shadow(color: .black.opacity(0.35), radius: 6, y: 2)
                // 44pt minimum tap target, same idiom as the header back
                // button.
                .frame(width: 44, height: 44, alignment: .bottomTrailing)
                .contentShape(Rectangle())
        }
        // Beats the scroll view's own gesture, so a tap lands while the list is
        // still decelerating instead of being spent stopping it.
        .highPriorityGesture(TapGesture().onEnded { jumpToLatest(proxy) })
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel("Jump to newest messages")
        .accessibilityAction { jumpToLatest(proxy) }
        // CONCENTRIC WITH THE SEND BUTTON, matching Android and web. The send
        // button's centre sits 39.5pt in from the trailing edge: 16 (the
        // composer's .padding(.horizontal, 16)) + 8 (the input row's
        // .padding(.horizontal, 8)) + 15.5 (half the 31pt layout width of
        // `arrow.up.circle.fill` at .system(size: 26) — an SF Symbol's box is
        // ~1.2x its point size, measured 31.0 on device). Subtract this disc's
        // 18pt radius → 21.5. Flush with the composer BOX's edge would be 16,
        // which lands the disc 5.5pt right of the send button and reads as a
        // misalignment rather than a decision.
        .padding(.trailing, 21.5)
        // The 2pt gap. Measured from the ScrollView's bottom edge, which IS
        // the composer's top hairline — the composer is a bottom safeAreaInset
        // on the page, so it shortens the list rather than covering it. True
        // only because that inset is declared `spacing: 0`; with SwiftUI's
        // default spacing this reads 10pt on device.
        .padding(.bottom, 2)
    }

    /// 1:1 DM read receipts (web parity): "Read" anchors on the newest own
    /// message the recipient has viewed; "Sent"/"Delivered" anchors on the
    /// newest own message when it's still unread. Group DMs and guild
    /// channels render no receipts. Computed ONCE per render pass.
    private func dmReceiptAnchors() -> (latest: Message?, lastRead: Message?) {
        guard channel.type == "dm", let selfId = store.currentUserId else { return (nil, nil) }
        var latest: Message? = nil
        var lastRead: Message? = nil
        for m in store.messages
        where (m.authorId ?? m.author?.id) == selfId
            && m.sendState == nil
            && m.metadata?.kind != "streak_warning" {
            // ^ the streak-expiry notice is authored by a participant but is a
            //   system-style row — it must not become the read-receipt anchor.
            latest = m
            if m.viewedAt != nil { lastRead = m }
        }
        return (latest, lastRead)
    }

    private func dmReceipt(for message: Message, anchors: (latest: Message?, lastRead: Message?)) -> String? {
        // The receipt lives ONLY under the newest own message — the moment a
        // newer one is sent, any older "Read" status disappears with it.
        guard message.id == anchors.latest?.id else { return nil }
        if let viewedAt = message.viewedAt {
            return "Read \(shortTime(viewedAt))"
        }
        return message.deliveredAt != nil ? "Delivered" : "Sent"
    }

    /// Build a row's Equatable snapshot by resolving, ONCE here in the
    /// (observing) parent, every store-derived value the row would otherwise
    /// read off the store directly. MessageRow then holds a non-observing plain
    /// store ref, so a store mutation re-renders THIS view, recomputes each
    /// visible row's data, and only rows whose data actually changed re-render
    /// (the rest are skipped by .equatable()). Runs lazily per realized row
    /// inside the LazyVStack's ForEach.
    private func rowData(for message: Message,
                         showHeader: Bool,
                         anchors: (latest: Message?, lastRead: Message?)) -> MessageRowData {
        let replied = message.replyToId != nil ? store.repliedMessage(for: message) : nil
        // Parental control: bake the swear-word mask into the display snapshot
        // (body + reply preview) so it's captured in MessageRowData — the row's
        // Equatable gate then re-renders when the flag flips (parent toggles /
        // family loads at cold start) and the reply-quote is masked too. One
        // source of truth; no render-time mask needed downstream.
        let maskProfane = store.family?.restrictions?.filterProfanity == true
        func masked(_ d: AppStore.MessageDisplay) -> AppStore.MessageDisplay {
            if maskProfane, case .text(let s) = d { return .text(ProfanityFilter.mask(s)) }
            return d
        }
        return MessageRowData(
            message: message,
            channel: channel,
            showHeader: showHeader,
            dmReceipt: dmReceipt(for: message, anchors: anchors),
            currentUserId: store.currentUserId,
            authorStatus: store.status(for: message.authorId),
            // Role colors are guild-scoped: a DM / group-DM has no guild, so a
            // name there must never inherit the role color from whatever server
            // was open last (the store's members/roles aren't cleared on the
            // hop into DMs). Gate on the channel type, which is unambiguous
            // regardless of navigation state.
            authorColorRGB: channel.isDM ? nil : store.memberColorRGB(message.authorId ?? message.author?.id ?? ""),
            display: masked(store.display(for: message, in: channel)),
            repliedMessage: replied,
            repliedDisplay: replied.map { masked(store.display(for: $0, in: channel)) },
            localEmbeds: store.localEmbeds(for: message.id) ?? [],
            isSaved: store.isSaved(message.id),
            emojiCatalogVersion: store.emojiCatalogVersion,
            mentionContextVersion: store.mentionContextVersion,
            e2eeUnlockVersion: store.e2eeUnlockVersion
        )
    }

    /// Encrypted DM with no key on this device → show the unlock panel.
    private var isLocked: Bool {
        _ = store.e2eeUnlockVersion
        return channel.isE2EE && !store.hasE2EEKey(for: channel)
    }

    private let bottomAnchor = "bottom-anchor"

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            // Wide layout keeps the sidebar visible; back only makes sense
            // for stacked drill-downs (e.g. a thread under a forum).
            if !store.isWideLayout || store.stack.count > 1 {
                Button {
                    store.clearChannel()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 20, weight: .semibold))
                        .foregroundColor(Theme.ink2)
                        .padding(.leading, 14)
                        .frame(width: 44, height: 44, alignment: .leading)
                        .contentShape(Rectangle())
                }
            }

            if channel.isDM {
                Avatar(
                    url: channel.dmAvatarUser?.avatarUrl,
                    name: store.dmDisplayTitle(channel),
                    size: 28,
                    status: store.status(for: channel.dmAvatarUser?.id),
                    ringColor: Theme.bg2,
                    toneId: channel.dmAvatarUser?.id
                )
                // E2EE badge: a small themed lock pinned to the top-right of
                // the profile picture (the only E2EE indicator in the header).
                .overlay(alignment: .topTrailing) {
                    if channel.isE2EE {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundColor(Theme.accent)
                            .frame(width: 13, height: 13)
                            .background(Theme.bg2)
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(Theme.accent.opacity(0.45), lineWidth: 1))
                            .offset(x: 4, y: -4)
                    }
                }
                // Tapping the name opens the peer's profile — the SAME
                // full-screen profile card every other surface opens
                // (store.openProfile → the presenter in MainView). 1:1 DMs
                // only: a group DM's title isn't one person.
                if channel.type == "dm", let peer = channel.dmAvatarUser {
                    Button { store.openProfile(peer) } label: {
                        Text(store.dmDisplayTitle(channel))
                            .font(.zkSans(16, weight: .semibold))
                            .foregroundColor(Theme.ink1)
                            .lineLimit(1)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens their profile")
                } else {
                    Text(store.dmDisplayTitle(channel))
                        .font(.zkSans(16, weight: .semibold))
                        .foregroundColor(Theme.ink1)
                        .lineLimit(1)
                }
                if let streak = (store.dms.first(where: { $0.id == channel.id })?.streak ?? channel.streak),
                   streak > 0 {
                    StreakChip(days: streak)
                }
            } else {
                Image(systemName: "number")
                    .font(.system(size: 15))
                    .foregroundColor(Theme.ink3)

                Text(channel.name ?? "channel")
                    .font(.zkSans(16, weight: .semibold))
                    .foregroundColor(Theme.ink1)
                    .lineLimit(1)
            }

            Spacer()

            if !channel.isE2EE {
                Button { showSearch = true } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 15))
                        .foregroundColor(Theme.ink3)
                }
                .padding(.trailing, 2)
            }

            // Pins are hidden in DMs (pinning 403s there anyway, and saved
            // messages cover the "keep this" need); kept in guild channels.
            if !channel.isDM {
                Button { showPins = true } label: {
                    Image(systemName: "pin.fill")
                        .font(.system(size: 13))
                        .foregroundColor(store.pins.isEmpty ? Theme.ink3 : Theme.accent)
                }
                .padding(.trailing, 2)
            }

            if !channel.isDM {
                Button { store.showMembers = true } label: {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: 14))
                        .foregroundColor(Theme.ink3)
                }
                .padding(.trailing, 2)
            }

            if channel.isText {
                EmptyView()
            }

            if channel.isDM {
                Button { store.openVoice(channel) } label: {
                    Image(systemName: "phone.fill")
                        .font(.system(size: 15))
                        .foregroundColor(Theme.ink3)
                }
                .padding(.trailing, 2)
                // Poke / nudge — 1:1 DMs only. Opens a popover showing recent
                // pokes received from this person (max 6) + the variant palette
                // (poke/heart/wave/like/fire); each sends that nudge.
                if channel.type == "dm" {
                    Button {
                        showPokePopover = true
                        pokeHistoryLoading = true
                        Task {
                            pokeHistory = await store.pokeHistory(channel)
                            pokeHistoryLoading = false
                        }
                    } label: {
                        Image(systemName: "hand.point.right.fill")
                            .font(.system(size: 15))
                            .foregroundColor(Theme.ink3)
                    }
                    .padding(.trailing, 2)
                    // A small bottom sheet (no popover arrow pointing at the
                    // icon). Compact fixed height; the poke palette is centered.
                    .sheet(isPresented: $showPokePopover) {
                        PokePopover(history: pokeHistory, loading: pokeHistoryLoading) { v in
                            showPokePopover = false
                            Task { await store.poke(channel, variant: v) }
                        }
                        .presentationDetents([.height(260)])
                        .presentationDragIndicator(.visible)
                        .presentationBackground(Theme.bg2)
                    }
                }
                Button { showDmSettings = true } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 15))
                        .foregroundColor(Theme.ink3)
                }
                .padding(.trailing, 2)
            }

        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(Theme.bg2.opacity(0.85))
        .overlay(Rectangle().fill(Theme.lineSoft).frame(height: 1), alignment: .bottom)
        .sheet(isPresented: $showSearch) {
            SearchSheet(channel: channel)
        }
        // The members pop-up is hosted ONCE at the shell root (MainView), driven
        // by store.showMembers — the people icon below just sets the flag. One
        // sheet now serves the channel list, text channels, and threads, so it's
        // no longer presented per-MessageListView (which would double-present).
        .sheet(isPresented: $showPins) {
            PinPanelView(channel: channel)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "number")
                .font(.system(size: 32, weight: .light))
                .foregroundColor(Theme.ink3)
            Text(channel.isDM
                 ? "This is the start of your conversation with \(channel.dmTitle)"
                 : "This is the start of #\(channel.name ?? "channel")")
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 8) {
            if let replying = store.replyingTo {
                HStack(spacing: 8) {
                    Image(systemName: "arrowshape.turn.up.left.fill")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.accent)
                    Text("Replying to")
                        .font(.zkSans(13))
                        .foregroundColor(Theme.ink3)
                    Text(replying.author?.name ?? "Unknown")
                        .font(.zkSans(13, weight: .semibold))
                        .foregroundColor(Theme.ink2)
                        .lineLimit(1)
                    Spacer()
                    Button { store.cancelReply() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundColor(Theme.ink3)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Theme.bg3)
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            if let typingText {
                HStack {
                    Text(typingText)
                        .font(.zkSans(11))
                        .italic()
                        .foregroundColor(Theme.ink3)
                    Spacer()
                }
                .padding(.horizontal, 4)
            }
            if !pendingAttachments.isEmpty {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        ForEach(pendingAttachments) { att in
                            ZStack(alignment: .topTrailing) {
                                if let preview = att.preview {
                                    Image(uiImage: preview)
                                        .resizable()
                                        .scaledToFill()
                                        .frame(width: 56, height: 56)
                                        .clipShape(RoundedRectangle(cornerRadius: 8))
                                } else {
                                    // Video / non-image: icon placeholder (we
                                    // don't decode a video frame for the chip).
                                    ZStack {
                                        RoundedRectangle(cornerRadius: 8).fill(Theme.bg3)
                                        Image(systemName: att.isVideo ? "video.fill" : "doc.fill")
                                            .font(.system(size: 18))
                                            .foregroundColor(Theme.ink2)
                                    }
                                    .frame(width: 56, height: 56)
                                }
                                Button {
                                    pendingAttachments.removeAll { $0.id == att.id }
                                } label: {
                                    Image(systemName: "xmark.circle.fill")
                                        .font(.system(size: 18))
                                        .symbolRenderingMode(.palette)
                                        .foregroundStyle(.white, .black.opacity(0.55))
                                }
                                .offset(x: 6, y: -6)
                            }
                            .frame(width: 56, height: 56)
                        }
                    }
                    .padding(.horizontal, 4)
                    .padding(.vertical, 2)
                }
            }

            if recorder.recording || recorder.recordingComplete {
                VoiceRecorderBar(
                    recorder: recorder,
                    onSend: { url, dur, wf in
                        Task { await store.sendVoiceMessage(fileURL: url, duration: dur, waveform: wf) }
                    },
                    onCancel: {}
                )
            } else {
            HStack(alignment: .bottom, spacing: 8) {
                autocompleteBar

                // Web composer row: bg-2/60, rounded-lg, 1px line border,
                // accent glow ring while focused. Attach menu leads (the
                // web's paperclip), emoji opens the unified picker, send
                // trails.
                HStack(alignment: .center, spacing: 4) {
                    // One shared attach menu. Encrypted DMs get the same
                    // options (photo/video, voice, schedule) — each is sealed
                    // with the channel key — EXCEPT polls, which can't be E2EE
                    // (the server must read options + tally votes).
                    Menu {
                        Button { showPhotoPicker = true } label: {
                            Label("Photo or video", systemImage: "photo")
                        }
                        // Live camera capture (hidden on Simulator / camera-less
                        // devices). Sends through the same attachment path.
                        if UIImagePickerController.isSourceTypeAvailable(.camera) {
                            Button { showCamera = true } label: {
                                Label("Take photo", systemImage: "camera")
                            }
                        }
                        // (Pasting an image is now done straight from the iOS
                        // keyboard — the composer field intercepts an image
                        // paste and attaches it. No menu button needed.)
                        if !channel.isE2EE {
                            Button { showPollSheet = true } label: { Label("Poll", systemImage: "chart.bar.xaxis") }
                        }
                        if store.selectedGuild != nil {
                            Button { showStickers = true } label: { Label("Sticker", systemImage: "face.smiling") }
                        }
                        Button { recorder.start() } label: { Label("Voice message", systemImage: "mic.fill") }
                        Button { showSchedule = true } label: { Label("Schedule message", systemImage: "clock") }
                    } label: {
                        Image(systemName: "paperclip")
                            .font(.system(size: 17))
                            .foregroundColor(Theme.ink2)
                            .frame(width: 28, height: 32)
                    }

                    ComposerTextView(
                        text: $draft,
                        placeholder: composerPlaceholder,
                        isFocused: $composerFocused,
                        onPasteImages: { addPastedImages($0) }
                    )

                    Button { showEmojiPicker = true } label: {
                        Image(systemName: "face.smiling")
                            .font(.system(size: 17))
                            .foregroundColor(Theme.ink2)
                            .frame(width: 28, height: 32)
                    }

                    Button(action: send) {
                        if store.uploading {
                            ProgressView().frame(width: 26, height: 26)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 26))
                                .foregroundColor(canSend ? Theme.accent : Theme.ink4)
                        }
                    }
                    .disabled(!canSend || store.uploading)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Theme.bg2.opacity(0.6))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(composerFocused ? Theme.accentGlow : Theme.line, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .shadow(color: composerFocused ? Theme.accentGlow : .clear, radius: 9)
            }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 8)
        // Opaque (not .opacity(0.9)): the attach Menu applies a system dim to
        // the nebula behind the composer, and a translucent bar let that dim
        // bleed through → the bar appeared to change color when the menu opened
        // with the keyboard up. Opaque keeps it stable; visually ~identical at
        // rest since the composer sits at the bottom over little nebula.
        .background(Theme.bg1)
        .overlay(Rectangle().fill(Theme.lineSoft).frame(height: 1), alignment: .top)
        .sheet(isPresented: $showEmojiPicker) {
            EmojiPickerSheet { emoji in
                showEmojiPicker = false
                draft += draft.isEmpty || draft.hasSuffix(" ") ? emoji : " " + emoji
            }
        }
        .onChange(of: pickerItems) { _, newItems in
            loadPickedItems(newItems)
        }
        .onChange(of: draft) { _, newValue in
            // Return key sends (the multi-line field inserts a newline
            // instead of submitting — catch it, strip it, send). The
            // keyboard then dismisses inside send().
            if newValue.hasSuffix("\n") {
                draft = String(newValue.dropLast())
                if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || !pendingAttachments.isEmpty {
                    send()
                }
                return
            }
            guard !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            if Date().timeIntervalSince(lastTypingSent) > 3 {
                lastTypingSent = Date()
                store.triggerTyping()
            }
        }
        .onChange(of: store.replyingTo) { _, newValue in
            if newValue != nil { composerFocused = true }
        }
        .sheet(isPresented: $showPollSheet) {
            CreatePollSheet()
        }
        .sheet(isPresented: $showStickers) {
            EmojiStickerPicker(draft: $draft)
        }
        .sheet(isPresented: $showSchedule) {
            ScheduleSheet(draft: $draft)
        }
        .photosPicker(
            isPresented: $showPhotoPicker,
            selection: $pickerItems,
            maxSelectionCount: 10,
            // Photos + videos everywhere — E2EE videos are encrypted on send
            // and decrypted for playback like any other attachment.
            matching: .any(of: [.images, .videos])
        )
        .fullScreenCover(isPresented: $showCamera) {
            CameraPicker { image in
                showCamera = false
                guard pendingAttachments.count < 10,
                      let data = image.jpegData(compressionQuality: 0.85) else { return }
                pendingAttachments.append(PendingAttachment(
                    data: data, filename: "photo.jpg", mime: "image/jpeg",
                    isVideo: false, preview: image))
            } onCancel: {
                showCamera = false
            }
            .ignoresSafeArea()
        }
    }

    private var canSend: Bool {
        !pendingAttachments.isEmpty || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var composerPlaceholder: String {
        channel.isDM ? "Message \(channel.dmTitle)" : "Message #\(channel.name ?? "")"
    }

    private var typingNames: [String] {
        let now = Date()
        return store.typing.filter { $0.value > now }.keys.compactMap { nameForUser($0) }
    }

    private var typingText: String? {
        let names = typingNames
        if names.isEmpty { return nil }
        if names.count == 1 { return "\(names[0]) is typing…" }
        if names.count == 2 { return "\(names[0]) and \(names[1]) are typing…" }
        return "Several people are typing…"
    }

    private func nameForUser(_ id: String) -> String {
        if let r = channel.recipients?.first(where: { $0.id == id }) { return r.name }
        if let a = store.messages.first(where: { ($0.author?.id ?? $0.authorId) == id })?.author {
            return a.name
        }
        return "Someone"
    }

    private func send() {
        // Sending dismisses the keyboard (mirrors iMessage/Discord).
        composerFocused = false
        if !pendingAttachments.isEmpty {
            // All picked photos/videos go out as ONE message (the server
            // accepts up to 10 attachments per message). Clear the composer
            // optimistically for responsiveness, but keep a copy so a failed
            // upload restores the picks instead of silently losing them.
            let saved = pendingAttachments
            let caption = draft
            draft = ""
            pendingAttachments = []
            pickerItems = []
            Task {
                let ok = await store.sendAttachments(
                    saved.map { (data: $0.data, filename: $0.filename, contentType: $0.mime) },
                    caption: caption
                )
                if !ok {
                    await MainActor.run {
                        pendingAttachments = saved
                        if draft.isEmpty { draft = caption }
                    }
                }
            }
        } else {
            let content = applySlashTransform(draft).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty else { return }
            draft = ""
            Task { await store.send(content, in: channel) }
        }
    }

    // MARK: Composer autocomplete (@mentions + :emoji:)

    /// The word currently being typed (everything after the last whitespace).
    /// Autocomplete keys off this; robust for the common case of typing at the
    /// end of the draft.
    private var trailingWord: String {
        if let idx = draft.lastIndex(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) {
            return String(draft[draft.index(after: idx)...])
        }
        return draft
    }
    private var mentionQuery: String? {
        let w = trailingWord
        guard w.hasPrefix("@") else { return nil }
        return String(w.dropFirst())
    }
    private var emojiQuery: String? {
        let w = trailingWord
        guard w.hasPrefix(":"), w.count >= 2, !w.dropFirst().contains(":") else { return nil }
        return String(w.dropFirst())
    }
    private var mentionMatches: [GuildMember] {
        guard let q = mentionQuery else { return [] }
        let ql = q.lowercased()
        // Lowercase each member's fields ONCE — this runs on every keystroke and
        // the old code re-lowercased up to 5× per member (3 in filter, 2 in sort).
        let prepared = store.members.values.map { m -> (member: GuildMember, sortKey: String, hay: [String]) in
            (
                m,
                m.user.name.lowercased(),
                [m.user.name.lowercased(), (m.user.username ?? "").lowercased()]
            )
        }
        let filtered = ql.isEmpty ? prepared : prepared.filter { $0.hay.contains { $0.contains(ql) } }
        return Array(filtered.sorted { $0.sortKey < $1.sortKey }.prefix(6).map { $0.member })
    }
    /// @everyone / @here suggestions — guild channels only (DMs have no audience
    /// to mass-mention). The server enforces the Mention-Everyone permission on
    /// send, so a member without it gets a clear error rather than a silent drop.
    private var mentionLiterals: [String] {
        guard channel.guildId != nil, let q = mentionQuery else { return [] }
        let ql = q.lowercased()
        return ["everyone", "here"].filter { ql.isEmpty || $0.hasPrefix(ql) }
    }
    private var emojiMatches: [GuildEmoji] {
        guard let q = emojiQuery else { return [] }
        let ql = q.lowercased()
        // lazy → only lowercase names until 8 matches are found, instead of
        // lowercasing all 50+ emoji on every keystroke.
        return Array(store.guildEmojis.lazy.filter { $0.name.lowercased().contains(ql) }.prefix(8))
    }

    @ViewBuilder
    private var autocompleteBar: some View {
        if !mentionMatches.isEmpty || !mentionLiterals.isEmpty {
            VStack(spacing: 0) {
                ForEach(mentionLiterals, id: \.self) { lit in literalMentionRow(lit) }
                ForEach(mentionMatches) { m in mentionRow(m) }
            }
            .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.bottom, 6)
        } else if !emojiMatches.isEmpty {
            VStack(spacing: 0) {
                ForEach(emojiMatches) { e in emojiRow(e) }
            }
            .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.bottom, 6)
        } else if !slashMatches.isEmpty {
            VStack(spacing: 0) {
                ForEach(slashMatches) { c in slashRow(c) }
            }
            .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.bottom, 6)
        }
    }

    private func mentionRow(_ m: GuildMember) -> some View {
        Button { applyMention(m) } label: {
            HStack(spacing: 8) {
                Avatar(url: m.user.avatarUrl, name: m.user.name, size: 24)
                Text(m.user.name)
                    .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                if let u = m.user.username {
                    Text("@\(u)").font(.zkSans(12)).foregroundColor(Theme.ink4)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle()).padding(.horizontal, 12).padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    private func emojiRow(_ e: GuildEmoji) -> some View {
        Button { applyEmoji(e) } label: {
            HStack(spacing: 8) {
                if let img = store.emojiImage(for: e) {
                    Image(uiImage: img).resizable().frame(width: 22, height: 22)
                } else {
                    Image(systemName: "face.smiling").font(.system(size: 16)).foregroundColor(Theme.ink3).frame(width: 22, height: 22)
                }
                Text(":\(e.name):").font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle()).padding(.horizontal, 12).padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    private func applyMention(_ m: GuildMember) {
        draft = String(draft.dropLast(trailingWord.count)) + "<@\(m.userId)> "
    }
    private func applyLiteralMention(_ literal: String) {
        draft = String(draft.dropLast(trailingWord.count)) + "@\(literal) "
    }
    private func literalMentionRow(_ literal: String) -> some View {
        Button { applyLiteralMention(literal) } label: {
            HStack(spacing: 8) {
                Image(systemName: "at")
                    .font(.system(size: 13, weight: .bold)).foregroundColor(Theme.accent)
                    .frame(width: 24, height: 24)
                    .background(Theme.accent.opacity(0.15)).clipShape(Circle())
                Text("@\(literal)").font(.zkSans(14, weight: .semibold)).foregroundColor(Theme.ink1)
                Text(literal == "everyone" ? "Notify everyone in this channel" : "Notify those online")
                    .font(.zkSans(12)).foregroundColor(Theme.ink4)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle()).padding(.horizontal, 12).padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }
    private func applyEmoji(_ e: GuildEmoji) {
        draft = String(draft.dropLast(trailingWord.count)) + ":\(e.name): "
    }

    // MARK: Slash commands (client-side text transforms)

    struct SlashCommand: Identifiable {
        let name: String, usage: String, description: String
        var id: String { name }
    }
    static let slashCommands: [SlashCommand] = [
        .init(name: "me", usage: "/me <action>", description: "Send an action — *you wave*"),
        .init(name: "shrug", usage: "/shrug [text]", description: "Append ¯\\_(ツ)_/¯"),
        .init(name: "tableflip", usage: "/tableflip [text]", description: "Append (╯°□°)╯︵ ┻━┻"),
        .init(name: "unflip", usage: "/unflip [text]", description: "Append ┬─┬ ノ( ゜-゜ノ)"),
        .init(name: "spoiler", usage: "/spoiler <text>", description: "Hide text behind a spoiler"),
    ]
    /// Active slash query: draft begins with "/" and the command name is still
    /// being typed (no whitespace yet).
    private var slashQuery: String? {
        guard draft.hasPrefix("/") else { return nil }
        let rest = String(draft.dropFirst())
        guard !rest.contains(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) else { return nil }
        return rest
    }
    private var slashMatches: [SlashCommand] {
        guard let q = slashQuery else { return [] }
        let ql = q.lowercased()
        return MessageListView.slashCommands.filter { ql.isEmpty || $0.name.hasPrefix(ql) }
    }
    private func slashRow(_ c: SlashCommand) -> some View {
        Button { draft = "/\(c.name) " } label: {
            HStack(spacing: 8) {
                Text(c.usage).font(.zkMono(13, weight: .semibold)).foregroundColor(Theme.ink1)
                Text(c.description).font(.zkSans(12)).foregroundColor(Theme.ink4).lineLimit(1)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle()).padding(.horizontal, 12).padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    /// Apply a built-in slash command to the outgoing text. Mirrors the web's
    /// transformSlashCommand: unknown commands pass through unchanged.
    private func applySlashTransform(_ input: String) -> String {
        guard input.hasPrefix("/") else { return input }
        let body = String(input.dropFirst())
        let name: String
        let arg: String
        if let sp = body.firstIndex(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) {
            name = String(body[..<sp]).lowercased()
            arg = String(body[body.index(after: sp)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            name = body.lowercased()
            arg = ""
        }
        let shrug = "¯\\_(ツ)_/¯"
        let tableflip = "(╯°□°)╯︵ ┻━┻"
        let unflip = "┬─┬ ノ( ゜-゜ノ)"
        let speaker = session.currentUser?.name ?? "someone"
        switch name {
        case "me": return arg.isEmpty ? input : "*\(speaker) \(arg)*"
        case "shrug": return arg.isEmpty ? shrug : "\(arg) \(shrug)"
        case "tableflip": return arg.isEmpty ? tableflip : "\(arg) \(tableflip)"
        case "unflip": return arg.isEmpty ? unflip : "\(arg) \(unflip)"
        case "spoiler": return arg.isEmpty ? input : "||\(arg)||"
        default: return input
        }
    }

    /// Add image(s) as pending attachments (same path as a picked photo).
    /// Called when the user pastes image(s) into the composer via the iOS
    /// keyboard (see ComposerTextView). Respects the 10-attachment cap.
    private func addPastedImages(_ images: [UIImage]) {
        for img in images {
            guard pendingAttachments.count < 10,
                  let data = img.jpegData(compressionQuality: 0.85) else { break }
            pendingAttachments.append(PendingAttachment(
                data: data, filename: "pasted.jpg", mime: "image/jpeg",
                isVideo: false, preview: img))
        }
    }

    private func loadPickedItems(_ items: [PhotosPickerItem]) {
        guard !items.isEmpty else { return }
        Task {
            var loaded: [PendingAttachment] = []
            for item in items {
                guard let data = try? await item.loadTransferable(type: Data.self) else { continue }
                let type = item.supportedContentTypes.first
                let isVideo = type?.conforms(to: .movie) ?? false
                let ext = type?.preferredFilenameExtension ?? (isVideo ? "mov" : "jpg")
                let mime = type?.preferredMIMEType ?? (isVideo ? "video/quicktime" : "image/jpeg")
                // Images get a thumbnail preview; videos use an icon (decoding
                // a frame is expensive and not worth it for a 56pt chip). Skip
                // anything that's neither a decodable image nor a video.
                let preview = isVideo ? nil : UIImage(data: data)
                if !isVideo && preview == nil { continue }
                loaded.append(PendingAttachment(
                    data: data,
                    filename: isVideo ? "video.\(ext)" : "image.\(ext)",
                    mime: mime,
                    isVideo: isVideo,
                    preview: preview
                ))
            }
            let toAdd = loaded
            await MainActor.run {
                // Cap at the server's MAX_FILES_PER_MESSAGE (10).
                let room = max(0, 10 - pendingAttachments.count)
                if room > 0 { pendingAttachments.append(contentsOf: toAdd.prefix(room)) }
                // Reset the selection so re-picking the same asset re-fires
                // onChange (and the empty value is ignored by the guard above).
                pickerItems = []
            }
        }
    }

    // MARK: Grouping

    /// Show the author header row when this message starts a new author group
    /// (or sits just under a date divider).
    /// Re-show the author header (avatar + name) at least this often within an
    /// uninterrupted run from the same sender, so a long run (person, bot, or
    /// webhook) doesn't lose its label and you don't have to scroll up to see
    /// who's talking.
    private let headerEveryNInRun = 6

    /// A system/server NOTICE — a streak warning or a call summary — renders as
    /// a centered line with NO avatar (see streakWarningRow / systemRow), so it
    /// breaks the author grouping: the next real message must re-show its header
    /// and a same-author run can't be "continued" across one.
    private func isNoticeRow(_ m: Message) -> Bool {
        m.metadata?.kind == "streak_warning" || m.metadata?.kind == "poke" || m.type == "system_call"
    }

    private func showHeader(at index: Int) -> Bool {
        // The ForEach iterates an enumerated snapshot, so a lazily-rendered row
        // can call this with a stale index after `messages` shrank (e.g. a
        // channel switch clears it) — guard the live array before subscripting.
        guard index < store.messages.count else { return false }
        if shouldShowDateDivider(at: index) { return true }
        guard index > 0 else { return true }
        let current = store.messages[index]
        let previous = store.messages[index - 1]
        // A notice (streak/call) just above broke the visual run, so re-show the
        // author header even if the notice was posted under the SAME authorId
        // (streak warnings are authored by a participant) — that's the "show the
        // profile picture again after a server message" case.
        if isNoticeRow(previous) { return true }
        if current.authorId != previous.authorId { return true }
        // Break the group on a time gap: a message sent a minute or more after
        // the previous one re-shows the avatar + name + timestamp, so separate
        // exchanges don't read as one clump. (Same-author grouping previously
        // had NO time bound — messages hours apart on the same day merged.)
        if let dp = messageDate(previous.createdAt),
           let dc = messageDate(current.createdAt),
           dc.timeIntervalSince(dp) >= 60 { return true }
        // A message YOU sent that someone else has reacted to re-shows your
        // avatar once it's "settled" — already seen, or older than 5 minutes —
        // so a reacted message is clearly attributed. Gated on settled so a
        // just-sent message in an active run doesn't reflow the instant a
        // reaction lands.
        if reactedOwnSettled(current) { return true }
        // Same-author continuation: count how far back this uninterrupted run
        // goes (stopping at a date divider OR a notice — both break the run; a
        // divider already forces a header), and re-show the header on every Nth
        // message of the run. Cheap: only the handful of LazyVStack-visible rows
        // call this, and it's integer compares.
        var runLength = 1
        var i = index
        while i > 0,
              store.messages[i - 1].authorId == current.authorId,
              !shouldShowDateDivider(at: i),
              !isNoticeRow(store.messages[i - 1]) {
            runLength += 1
            i -= 1
        }
        return runLength % headerEveryNInRun == 1
    }

    /// True for one of YOUR OWN messages that another person has reacted to and
    /// that has "settled": been seen (DM read receipt) OR is older than 5
    /// minutes. Used to re-show the author header/avatar on an otherwise-grouped
    /// reacted message so the reaction is clearly attributed to it.
    private func reactedOwnSettled(_ m: Message) -> Bool {
        guard let me = store.currentUserId, m.authorId == me else { return false }
        // A reaction from someone other than me (my own counts as 1 when `me`).
        let othersReacted = (m.reactions ?? []).contains { $0.count > ($0.me ? 1 : 0) }
        guard othersReacted else { return false }
        if m.viewedAt != nil { return true }                          // seen
        if let d = messageDate(m.createdAt),
           Date().timeIntervalSince(d) > 300 { return true }          // >5 min old
        return false
    }

    /// Show a date divider above the first message and whenever the calendar
    /// day changes between consecutive messages.
    private func shouldShowDateDivider(at index: Int) -> Bool {
        guard index < store.messages.count else { return false }
        if index == 0 { return true }
        return isDifferentDay(store.messages[index - 1].createdAt, store.messages[index].createdAt)
    }

    /// Show the "New messages" divider before the first message newer than the
    /// frozen unread boundary captured when the channel was opened.
    private func shouldShowUnreadDivider(at index: Int) -> Bool {
        guard let boundary = store.unreadBoundaryId, index < store.messages.count else { return false }
        guard snowflakeGreater(store.messages[index].id, than: boundary) else { return false }
        if index == 0 { return true }
        return !snowflakeGreater(store.messages[index - 1].id, than: boundary)
    }

    /// The row a guild channel with unread history lands on: the first loaded
    /// message past the frozen unread boundary, CLAMPED so the landing can
    /// never sit further back than `unreadLandingMaxRowsBack` rows from the
    /// newest.
    ///
    /// Unclamped (the previous `firstUnreadId`), a channel whose unread count
    /// meets or exceeds the 50-message window — or whose read state was synced
    /// stale from another device — makes EVERY loaded message newer than the
    /// boundary, so the target resolves to `store.messages.first` and the open
    /// lands on the OLDEST loaded row. That is the "way too far up" in the bug
    /// report, and it is self-reinforcing: sitting at the top with
    /// `hasMoreMessages` true means the first flick pages in another 50.
    ///
    /// The divider-landing policy itself is deliberate and matches web — only
    /// the distance is capped.
    private func unreadLandingId(_ boundary: String) -> String? {
        guard let first = store.messages.firstIndex(where: {
            snowflakeGreater($0.id, than: boundary)
        }) else { return nil }
        let clamped = max(first, store.messages.count - Self.unreadLandingMaxRowsBack)
        guard clamped >= 0, clamped < store.messages.count else { return nil }
        return store.messages[clamped].id
    }
}

/// A single message. With `showHeader`, renders avatar + name + time; grouped
/// A run of message content: either plain text (markdown-rendered) or a
/// resolved custom emoji to render inline.
private enum ContentSeg {
    case text(String)
    case emoji(GuildEmoji)
}

/// Centered date separator shown between messages on different calendar days.
struct DateDividerView: View {
    let label: String
    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Theme.line).frame(height: 1)
            Text(label.uppercased())
                .font(.zkSans(10, weight: .semibold))
                .tracking(0.8)
                .foregroundColor(Theme.ink3)
                .fixedSize()
            Rectangle().fill(Theme.line).frame(height: 1)
        }
        .padding(.vertical, 8)
    }
}

/// Red "New messages" separator marking where the user last left off.
struct UnreadDividerView: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Theme.danger).frame(height: 1)
            Text("New messages")
                .font(.zkSans(10, weight: .bold))
                .foregroundColor(Theme.danger)
                .fixedSize()
        }
        .padding(.vertical, 3)
    }
}

/// Immutable per-row snapshot computed once by MessageListView so MessageRow
/// can be `Equatable` and SKIP re-rendering when unrelated store churn fires
/// (a presence/typing burst, a reaction on another row, a sibling message
/// edit). It captures every value the row reads off the store that can change
/// INDEPENDENTLY of the message itself — so == over this struct is a complete
/// "did anything this row shows change?" test. Per-message mutable state
/// (reactions, pinned, editedAt, sendState, attachments, poll, embeds) lives
/// inside `message`, which is compared whole. The three version Ints stand in
/// for the rarely-changing name/emoji maps the row resolves at render time
/// through MessageRow's non-observing plain `store` ref.
struct MessageRowData: Equatable {
    var message: Message
    var channel: Channel
    var showHeader: Bool
    /// 1:1 DM read receipt ("Sent"/"Delivered"/"Read"); set only on the anchor
    /// messages, mirroring the web.
    var dmReceipt: String?
    var currentUserId: String?
    /// Resolved author presence ("online"/"idle"/…) — precomputed so presence
    /// churn that doesn't change THIS author's status is a no-op for the row.
    var authorStatus: String
    /// Author name color as raw RGB (nil = none); see AppStore.memberColorRGB.
    var authorColorRGB: Int?
    /// Decrypted/locked content state (drives the body text vs lock label).
    var display: AppStore.MessageDisplay
    /// The message this one replies to (for the reply preview), if loaded.
    var repliedMessage: Message?
    /// Display state of `repliedMessage` (so the preview text needs no second
    /// store call at render).
    var repliedDisplay: AppStore.MessageDisplay?
    /// Client-resolved embeds for an E2EE message (server can't unfurl it).
    var localEmbeds: [MessageEmbed]
    /// Save/Unsave menu label state.
    var isSaved: Bool
    var emojiCatalogVersion: Int
    var mentionContextVersion: Int
    var e2eeUnlockVersion: Int
}

/// follow-ups render just the content indented to align under the name.
struct MessageRow: View, Equatable {
    /// Plain (NON-observing) store reference: used only to INVOKE actions and
    /// for pure render-time lookups (emoji/mention maps). Holding it as a plain
    /// `let` — not @EnvironmentObject — means store mutations do NOT invalidate
    /// this row; only a change to `data` (compared in ==) re-renders it.
    let store: AppStore
    let data: MessageRowData
    @Environment(\.openURL) private var openURL

    // Convenience accessors so the body reads exactly as before.
    private var message: Message { data.message }
    private var channel: Channel { data.channel }
    private var showHeader: Bool { data.showHeader }
    private var dmReceipt: String? { data.dmReceipt }

    /// Equality over the value snapshot only — never the store (same singleton
    /// for every row) and never closures (the row stores none; menu/sheet
    /// actions call `store` directly). `.equatable()` at the ForEach site makes
    /// SwiftUI consult this before re-running the body.
    static func == (lhs: MessageRow, rhs: MessageRow) -> Bool { lhs.data == rhs.data }

    private let gutter: CGFloat = 52

    @State private var showEdit = false
    @State private var showDeleteConfirm = false
    @State private var showForward = false
    @State private var showReactionPicker = false
    @State private var editText = ""
    @State private var videoToPlay: VideoItem?
    // Share-sheet item for a single image's "Share…" action, now hosted in the
    // row's own context menu (see singleSavableImage / menuItems) instead of a
    // nested .imageActions menu that used to swallow the reaction menu.
    @State private var imageShareItem: ImageShareItem?

    var body: some View {
        // Web parity: ONLY system_call renders as a quiet notice line.
        // Other system messages (system_join welcomes, pins, …) render
        // as a regular row — the joiner's avatar on the left, name, and
        // the welcome text, as if they sent it.
        if message.metadata?.kind == "streak_warning" {
            streakWarningRow
        } else if message.metadata?.kind == "poke" {
            pokeRow
        } else if message.type == "system_call" {
            systemRow
        } else {
        rowContent
            .contextMenu { menuItems }
            .sheet(isPresented: $showEdit) {
                EditMessageSheet(message: message, text: $editText)
            }
            .sheet(isPresented: $showForward) {
                ForwardSheet(message: message)
            }
            .sheet(isPresented: $showReactionPicker) {
                EmojiPickerSheet { emoji in
                    showReactionPicker = false
                    react(emoji)
                }
            }
            .confirmationDialog("Delete message?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task { await store.deleteMessage(message) }
                }
                Button("Cancel", role: .cancel) {}
            }
            .fullScreenCover(item: $videoToPlay) { item in
                VideoLightboxView(url: item.url)
            }
            .sheet(item: $imageShareItem) { ActivityItemsView(items: [$0.image]) }
        }
    }

    /// Web parity: system_call renders "Missed call from X" (red) or
    /// "Call ended · 5m 23s" as a quiet notice line.
    @ViewBuilder
    private var systemRow: some View {
        HStack(spacing: 7) {
            let missed = message.metadata?.missed ?? false
            // Red "missed" styling only when the viewer actually missed a call —
            // i.e. they're the callee. The caller's own unanswered call ("No
            // answer") reads as a quiet, neutral notice, not an alert.
            let alert = missed && message.metadata?.initiatorId != data.currentUserId
            Image(systemName: alert ? "phone.arrow.down.left" : "phone")
                .font(.system(size: 11))
                .foregroundColor(alert ? Theme.dangerSoft.opacity(0.85) : Theme.ink3)
            Text(callSummary)
                .font(.zkSans(12))
                .foregroundColor(alert ? Theme.dangerSoft.opacity(0.9) : Theme.ink2)
            Text("·").foregroundColor(Theme.ink4)
            Text(shortTime(message.createdAt))
                .font(.zkSans(11))
                .foregroundColor(Theme.ink4)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .padding(.leading, gutter)
    }

    /// "Your streak ends soon" warning — a quiet centered notice (not a bubble
    /// from the author), mirroring the system_call notice style. Content comes
    /// straight from the server message, which already leads with a 🔥 emoji —
    /// so no separate (blue, accent-tinted) flame icon here.
    private var streakWarningRow: some View {
        HStack(spacing: 0) {
            Spacer(minLength: 0)
            Text(message.text)
                .font(.zkSans(12))
                .foregroundColor(Theme.ink2)
                .multilineTextAlignment(.center)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .padding(.horizontal, gutter)
    }

    /// A poke / nudge — a centered notice ("👉 Alice poked you", or "👉 You
    /// poked them" on your own). The recipient's device also buzzes on arrival
    /// (AppStore MESSAGE_CREATE handler).
    private var pokeRow: some View {
        let variant = PokeVariant(rawValue: message.metadata?.pokeType ?? "poke") ?? .poke
        let isMine = message.metadata?.initiatorId == data.currentUserId
        let text = isMine
            ? "You \(variant.sentVerb)"
            : "\(message.author?.name ?? "Someone") \(variant.verb)"
        return HStack(spacing: 6) {
            Spacer(minLength: 0)
            Text(variant.emoji).font(.system(size: 15))
            Text(text).font(.zkSans(12)).foregroundColor(Theme.ink2)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 5)
        .padding(.horizontal, gutter)
    }

    private var callSummary: String {
        let missed = message.metadata?.missed ?? false
        let caller = message.author?.name ?? "Someone"
        if missed {
            // The caller (initiator) shouldn't read "Missed call from <self>".
            // For them an unanswered call is simply "No answer"; the callee
            // still sees "Missed call from <caller>".
            if message.metadata?.initiatorId == data.currentUserId { return "No answer" }
            return "Missed call from \(caller)"
        }
        let ms = message.metadata?.durationMs ?? 0
        let total = ms / 1000
        let label: String
        if total >= 3600 {
            label = "\(total / 3600)h \((total % 3600) / 60)m"
        } else if total >= 60 {
            label = "\(total / 60)m \(total % 60)s"
        } else {
            label = "\(total)s"
        }
        return "Call ended · \(label)"
    }

    static let quickEmoji = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥"]

    @ViewBuilder
    private var menuItems: some View {
        Menu {
            ForEach(MessageRow.quickEmoji, id: \.self) { e in
                Button(e) { react(e) }
            }
            Divider()
            Button { showReactionPicker = true } label: {
                Label("More…", systemImage: "plus.circle")
            }
        } label: {
            Label("Add reaction", systemImage: "face.smiling")
        }
        Button { store.setReply(message) } label: {
            Label("Reply", systemImage: "arrowshape.turn.up.left")
        }
        Button { Task { await store.togglePin(message) } } label: {
            Label(message.pinned == true ? "Unpin" : "Pin",
                  systemImage: message.pinned == true ? "pin.slash" : "pin")
        }
        Button { showForward = true } label: {
            Label("Forward", systemImage: "arrowshape.turn.up.right")
        }
        Button { Task { await store.toggleSave(message) } } label: {
            Label(data.isSaved ? "Unsave" : "Save",
                  systemImage: data.isSaved ? "bookmark.slash" : "bookmark")
        }
        // Only CONFIRMED own messages get Edit/Delete. An optimistic
        // placeholder (sendState "sending"/"failed") has a client-UUID id,
        // so editing/deleting it PATCHes /messages/<UUID> → 400 and the
        // edit is silently lost — which read as "I can't edit the message I
        // just sent." Failed rows have their own inline Retry/Delete.
        if isOwn && message.sendState == nil && withinMutateWindow {
            Button { beginEdit() } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button(role: .destructive) { showDeleteConfirm = true } label: {
                Label("Delete", systemImage: "trash")
            }
        }
        // Image actions live in THIS row menu (not a nested .imageActions
        // context menu on the photo) so that long-pressing a single photo still
        // reaches "Add reaction" above. Only shown when the message's sole media
        // is an image (plain OR E2EE); the provider decrypts on demand.
        if let img = singleSavableImage {
            Divider()
            Button {
                Task { if let i = await loadSingleImage(img) { _ = await PhotoSaver.save(i) } }
            } label: { Label("Save to Photos", systemImage: "square.and.arrow.down") }
            Button {
                Task { if let i = await loadSingleImage(img) { await MainActor.run { UIPasteboard.general.image = i } } }
            } label: { Label("Copy Image", systemImage: "doc.on.doc") }
            Button {
                Task { if let i = await loadSingleImage(img) { await MainActor.run { imageShareItem = ImageShareItem(image: i) } } }
            } label: { Label("Share…", systemImage: "square.and.arrow.up") }
        }
    }

    /// The message's sole image attachment (plain or E2EE), when there's exactly
    /// one media attachment and it's an image — i.e. the `singleMedia` case.
    /// Drives the image actions folded into `menuItems`. nil for text-only,
    /// single-video, multi-media (grid), and file/voice messages.
    private var singleSavableImage: Attachment? {
        guard let attachments = message.attachments else { return nil }
        let media = attachments.filter { att in
            att.isVoiceMessage != true &&
            (isEncrypted(att) ? encryptedInnerIsImage(att) : (att.isImage || att.isVideo))
        }
        guard media.count == 1, let only = media.first, isGridImage(only) else { return nil }
        // Save/Copy/Share all resolve the FULL-SIZE bytes; once retention has
        // aged the original out there are none to resolve, so the actions drop
        // out of the menu rather than failing silently on a dead URL.
        guard !only.blobExpired else { return nil }
        return only
    }

    /// Resolve the full-resolution UIImage for a single image attachment —
    /// decrypting E2EE bytes off the main actor, or loading the plain URL.
    private func loadSingleImage(_ att: Attachment) async -> UIImage? {
        // Belt-and-braces: the menu already hides these actions for an expired
        // original (singleSavableImage), and neither branch below has anything
        // to fetch once the full-size object is gone.
        guard !att.blobExpired else { return nil }
        if isEncrypted(att) {
            guard let data = await store.decryptedAttachmentData(att, in: channel) else { return nil }
            return await Task.detached(priority: .userInitiated) { UIImage(data: data) }.value
        }
        guard let url = assetURL(att.url) else { return nil }
        return await RetryingImage.load(url)
    }

    private var isOwn: Bool {
        let authorId = message.authorId ?? message.author?.id
        return authorId != nil && authorId == data.currentUserId
    }

    /// Authors can edit/delete their own message only within a minute of
    /// posting (matches the server). After that the menu hides both actions.
    /// Re-evaluated each time the menu opens, so it locks once the minute is up.
    private var withinMutateWindow: Bool {
        guard let d = messageDate(message.createdAt) else { return true }
        return Date().timeIntervalSince(d) <= 60
    }

    private func beginEdit() {
        switch data.display {
        case .text(let t): editText = t
        default: editText = message.text
        }
        showEdit = true
    }

    private func react(_ emoji: String) {
        Task { await store.toggleReaction(message, emoji: emoji) }
    }

    @ViewBuilder
    private var replyPreview: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 10))
                .foregroundColor(Theme.ink3)
            if let replied = data.repliedMessage {
                Avatar(url: replied.author?.avatarUrl, name: replied.author?.name ?? "?",
                       size: 16, ringColor: Theme.bg1)
                Text(replied.author?.name ?? "Unknown")
                    .font(.zkSans(12, weight: .semibold))
                    .foregroundColor(Theme.ink2)
                Text(replyPreviewText(replied, display: data.repliedDisplay ?? .text(replied.text)))
                    .font(.zkSans(12))
                    .foregroundColor(Theme.ink3)
                    .lineLimit(1)
            } else {
                Text("Replying to a message")
                    .font(.zkSans(12))
                    .foregroundColor(Theme.ink3)
                    .italic()
            }
        }
        .padding(.bottom, 1)
    }

    private func replyPreviewText(_ m: Message, display: AppStore.MessageDisplay) -> String {
        switch display {
        case .text(let t):
            // `t` (from repliedDisplay) is already profanity-masked upstream in
            // rowData when the viewer is a supervised child with the filter on.
            if !t.isEmpty { return t }
            if m.sticker != nil { return "🏷️ Sticker" }
            if m.attachments?.contains(where: { $0.isVoiceMessage == true }) == true { return "🎤 Voice message" }
            if m.attachments?.isEmpty == false { return "📎 Attachment" }
            if m.poll != nil { return "📊 Poll" }
            return "Message"
        case .locked, .undecryptable:
            return "🔒 Encrypted message"
        }
    }

    /// Webhook persona (web parity): when set, the override name/avatar
    /// replace the author's user record everywhere in the row.
    private var isWebhook: Bool { message.webhookId != nil }
    /// A "member joined" welcome (system_join) is authored in the data by the
    /// joining user, but reads as the SERVER welcoming the newcomer — so we
    /// swap the author identity to the guild's name + icon (the welcome body
    /// still @-mentions the newcomer). Also suppresses the joiner's profile
    /// tap, role color, clan tag, decoration, and BOT badge on this row.
    private var isServerAuthor: Bool { message.type == "system_join" }
    private var systemJoinGuild: Guild? {
        guard isServerAuthor else { return nil }
        if let gid = data.channel.guildId {
            return store.guilds.first(where: { $0.id == gid }) ?? store.selectedGuild
        }
        return store.selectedGuild
    }
    private var displayName: String {
        if let g = systemJoinGuild { return g.name }
        if isWebhook { return message.authorOverrideName ?? message.author?.name ?? "Webhook" }
        // In a DM, the peer's messages show the viewer's personal nickname.
        if data.channel.isDM, let nick = store.dmNickname(message.author?.id) { return nick }
        return message.author?.name ?? "Unknown"
    }
    private var displayAvatarUrl: String? {
        if let g = systemJoinGuild { return g.iconUrl }
        if isWebhook { return message.authorOverrideAvatar ?? message.author?.avatarUrl }
        return message.author?.avatarUrl
    }

    private var rowContent: some View {
        HStack(alignment: .top, spacing: 0) {
            if showHeader {
                Avatar(
                    url: displayAvatarUrl,
                    name: displayName,
                    size: 40,
                    status: (isWebhook || isServerAuthor) ? nil : data.authorStatus,
                    ringColor: Theme.bg1,
                    decoration: (isWebhook || isServerAuthor) ? nil : message.author?.avatarDecoration,
                    toneId: isServerAuthor
                        ? systemJoinGuild?.id
                        : (isWebhook ? message.webhookId : (message.authorId ?? message.author?.id))
                )
                .frame(width: gutter, alignment: .leading)
                .onTapGesture { if !isWebhook, !isServerAuthor, let a = message.author { store.openProfile(a) } }
            } else {
                Color.clear.frame(width: gutter)
            }

            VStack(alignment: .leading, spacing: 4) {
                if message.replyToId != nil {
                    replyPreview
                }
                if showHeader {
                    HStack(alignment: .center, spacing: 4) {
                        if !isWebhook, !isServerAuthor, let a = message.author { NameTag(a) }
                        StaffName((isWebhook || isServerAuthor) ? nil : message.author,
                                  text: displayName,
                                  color: (isWebhook || isServerAuthor) ? Theme.ink1 : (data.authorColorRGB.map { store.color(fromRGB: $0) } ?? Theme.ink1),
                                  font: .zkSans(15, weight: .medium))
                            .onTapGesture { if !isWebhook, !isServerAuthor, let a = message.author { store.openProfile(a) } }
                        if isWebhook {
                            Text("WEBHOOK")
                                .font(.zkSans(8.5, weight: .bold))
                                .tracking(0.5)
                                .foregroundColor(Theme.accent2)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(Theme.accent2.opacity(0.2))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        if message.author?.isBot == true && !isServerAuthor {
                            Text("BOT")
                                .font(.zkSans(8.5, weight: .bold))
                                .tracking(0.5)
                                .foregroundColor(Theme.accent)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(Theme.accent.opacity(0.2))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        Text(shortTime(message.createdAt))
                            .font(.zkSans(11))
                            .foregroundColor(Theme.ink3)
                        if message.editedAt != nil {
                            Text("(edited)")
                                .font(.zkSans(11))
                                .foregroundColor(Theme.ink3)
                        }
                    }
                }
                if let fwd = message.forwardedFrom {
                    forwardedBlock(fwd)
                }
                content
                stickerView
                pollView
                attachmentsView
                embedsView
                reactionsView
                sendStatusView
                if let dmReceipt {
                    Text(dmReceipt)
                        .font(.zkSans(10))
                        .foregroundColor(Theme.ink3)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.top, 1)
                }
            }
            Spacer(minLength: 0)
        }
        // Web parity: pinned rows carry a faint amber wash.
        .background(
            message.pinned == true
                ? Color(hex: 0xF59E0B).opacity(0.04)
                : Color.clear
        )
    }

    @ViewBuilder
    private var sendStatusView: some View {
        if message.sendState == "sending" {
            HStack(spacing: 5) {
                ProgressView().scaleEffect(0.6)
                Text("Sending…")
                    .font(.zkSans(11))
                    .foregroundColor(Theme.ink3)
            }
            .padding(.top, 2)
        } else if message.sendState == "failed" {
            HStack(spacing: 10) {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 11))
                    Text("Failed to send").font(.zkSans(11))
                }
                .foregroundColor(Theme.danger)
                Button("Retry") { Task { await store.retrySend(message.id) } }
                    .font(.zkSans(11, weight: .semibold))
                    .foregroundColor(Theme.accent)
                Button("Delete") { store.discardFailed(message.id) }
                    .font(.zkSans(11, weight: .semibold))
                    .foregroundColor(Theme.ink3)
            }
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch data.display {
        case .text(let t):
            // `t` is already profanity-masked upstream in rowData when the viewer
            // is a supervised child with the filter on (baked into the display
            // snapshot so the row's Equatable gate re-renders on toggle).
            if !t.isEmpty {
                if let jumbo = emojiOnly(t) {
                    HStack(spacing: 4) {
                        ForEach(Array(jumbo.enumerated()), id: \.offset) { _, e in
                            jumboEmoji(e)
                        }
                    }
                    .padding(.vertical, 2)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(splitCodeBlocks(t).enumerated()), id: \.offset) { _, block in
                            blockView(block)
                        }
                    }
                }
            }
        case .locked:
            Label("Locked", systemImage: "lock.fill")
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
        case .undecryptable:
            Label("Couldn't decrypt", systemImage: "lock.slash")
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
        }
    }

    // ── Fenced code blocks ───────────────────────────────────────────────────
    // Mirrors the web's markdown pass 1: split ```fenced``` blocks out so they
    // render as monospace blocks while the rest goes through inline markdown.
    enum ContentBlock {
        case text(String)
        case code(String)
    }

    private func splitCodeBlocks(_ s: String) -> [ContentBlock] {
        guard s.contains("```") else { return [.text(s)] }
        let re = MessageRow.codeBlockRegex
        let ns = s as NSString
        let matches = re.matches(in: s, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return [.text(s)] }
        var blocks: [ContentBlock] = []
        var last = 0
        for m in matches {
            if m.range.location > last {
                let txt = ns.substring(with: NSRange(location: last, length: m.range.location - last))
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
                if !txt.isEmpty { blocks.append(.text(txt)) }
            }
            var code = ns.substring(with: m.range(at: 1))
            while code.hasSuffix("\n") { code.removeLast() }
            blocks.append(.code(code))
            last = m.range.location + m.range.length
        }
        if last < ns.length {
            let txt = ns.substring(with: NSRange(location: last, length: ns.length - last))
                .trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
            if !txt.isEmpty { blocks.append(.text(txt)) }
        }
        return blocks
    }

    @ViewBuilder
    private func blockView(_ block: ContentBlock) -> some View {
        switch block {
        case .text(let tt):
            inlineText(tt)
                .font(.zkSans(15))
                .foregroundColor(Theme.ink1)
                .tint(Theme.accent)
                .fixedSize(horizontal: false, vertical: true)
                .environment(\.openURL, mentionOpenURL())
        case .code(let cc):
            codeBlockView(cc)
        }
    }

    @ViewBuilder
    private func codeBlockView(_ code: String) -> some View {
        // Web `pre`: bg-bg-3, rounded-md, px-3 py-2, mono at 0.9em — no border.
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.zkMono(13.5))
                .foregroundColor(Theme.ink1)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        .background(Theme.bg3)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // ── Custom emoji (`:name:`) inline rendering ────────────────────────────
    private static let emojiTokenRegex = try! NSRegularExpression(pattern: ":([a-z0-9_]{2,32}):")
    // Compiled once (was rebuilt on every row render): the fenced-code-block
    // splitter and the mention-token matcher. NSRegularExpression compilation
    // is the expensive part — matching against a short message body is cheap.
    private static let codeBlockRegex = try! NSRegularExpression(pattern: "```[^\\n]*\\n?([\\s\\S]*?)```")
    private static let mentionRegex = try! NSRegularExpression(pattern: "<@!?\\d+>|<@&\\d+>|<#\\d+>|@everyone\\b|@here\\b")

    private func parseSegments(_ s: String) -> [ContentSeg] {
        let map = store.emojiByName
        if map.isEmpty || !s.contains(":") { return [.text(s)] }
        let ns = s as NSString
        let matches = MessageRow.emojiTokenRegex.matches(in: s, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return [.text(s)] }
        var segs: [ContentSeg] = []
        var last = 0
        for m in matches {
            let name = ns.substring(with: m.range(at: 1))
            guard let emoji = map[name] else { continue }  // unresolved → stays literal text
            if m.range.location > last {
                segs.append(.text(ns.substring(with: NSRange(location: last, length: m.range.location - last))))
            }
            segs.append(.emoji(emoji))
            last = m.range.location + m.range.length
        }
        if last < ns.length {
            segs.append(.text(ns.substring(with: NSRange(location: last, length: ns.length - last))))
        }
        return segs.isEmpty ? [.text(s)] : segs
    }

    /// If the message is only resolvable emoji (1–12) and whitespace, return
    /// them for jumbo rendering; otherwise nil.
    private func emojiOnly(_ s: String) -> [GuildEmoji]? {
        let segs = parseSegments(s)
        var emojis: [GuildEmoji] = []
        for seg in segs {
            switch seg {
            case .emoji(let e): emojis.append(e)
            case .text(let t):
                if !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
            }
        }
        return (emojis.isEmpty || emojis.count > 12) ? nil : emojis
    }

    /// Resolve user/role/channel mention tokens (<@id>, <@!id>, <@&id>, <#id>)
    /// into readable, accent-colored labels; everything else is markdown-parsed.
    /// Mirrors the web markdown renderer's mention chips.
    private func richContent(_ s: String) -> AttributedString {
        guard s.contains("<@") || s.contains("<#") || s.contains("@everyone") || s.contains("@here")
        else { return markdownAttributed(s) }
        let re = MessageRow.mentionRegex
        let ns = s as NSString
        let matches = re.matches(in: s, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return markdownAttributed(s) }
        var result = AttributedString("")
        var last = 0
        for m in matches {
            if m.range.location > last {
                result.append(markdownAttributed(ns.substring(with: NSRange(location: last, length: m.range.location - last))))
            }
            let token = ns.substring(with: m.range)
            var chip = AttributedString(mentionLabel(token))
            chip.foregroundColor = Theme.accentSoft
            chip.backgroundColor = Theme.accent.opacity(0.2)
            chip.font = .zkSans(15, weight: .medium)
            // A USER mention (<@id> / <@!id>, NOT a role <@&id>, channel <#id>,
            // or @everyone/@here) becomes a tappable link → opens the profile.
            // Routed through a zk://user/<id> link intercepted by the openURL
            // handler on each richContent render site.
            if token.hasPrefix("<@"), !token.hasPrefix("<@&") {
                let uid = token.filter { $0.isNumber }
                if !uid.isEmpty { chip.link = URL(string: "zk://user/\(uid)") }
            }
            result.append(chip)
            last = m.range.location + m.range.length
        }
        if last < ns.length {
            result.append(markdownAttributed(ns.substring(with: NSRange(location: last, length: ns.length - last))))
        }
        return result
    }

    /// openURL handler for richContent: routes a tapped user-mention chip
    /// (zk://user/<id>) to that user's profile; every other URL (markdown/http
    /// links, embed link taps) falls through to the system unchanged.
    private func mentionOpenURL() -> OpenURLAction {
        OpenURLAction { url in
            if url.scheme == "zk", url.host == "user" {
                store.openProfile(byId: url.lastPathComponent)
                return .handled
            }
            return .systemAction
        }
    }

    private func mentionLabel(_ token: String) -> String {
        if token == "@everyone" || token == "@here" { return token }
        let digits = token.filter { $0.isNumber }
        if token.hasPrefix("<#") {
            return "#\(store.channelById[digits]?.name ?? "channel")"
        }
        if token.hasPrefix("<@&") {
            return "@\(store.roleById[digits]?.name ?? "role")"
        }
        // User mention. memberName covers guild members; in a DM that map is
        // empty, so fall back to the DM recipients and this message's author so
        // the name resolves instead of showing the literal "@user".
        if let name = store.memberName(digits) { return "@\(name)" }
        if let r = channel.recipients?.first(where: { $0.id == digits }) { return "@\(r.name)" }
        if let a = message.author, a.id == digits { return "@\(a.name)" }
        return "@user"
    }

    private func inlineText(_ s: String) -> Text {
        var result = Text("")
        for seg in parseSegments(s) {
            switch seg {
            case .text(let t):
                result = result + Text(richContent(t))
            case .emoji(let e):
                if let img = store.emojiImage(for: e) {
                    result = result + Text(Image(uiImage: img)).baselineOffset(-3)
                } else {
                    result = result + Text(":\(e.name):")
                }
            }
        }
        return result
    }

    @ViewBuilder
    private func jumboEmoji(_ e: GuildEmoji) -> some View {
        // CachedImage seeds decoded pixels from DecodedImageCache on the first
        // frame, so a recycled row paints instantly instead of re-downloading +
        // re-decoding on every scroll-back (AsyncImage caches nothing across
        // view recreations).
        if let url = assetURL(e.url) {
            CachedImage(url: url, contentMode: .fit) {
                Text(":\(e.name):").font(.zkSans(14)).foregroundColor(Theme.ink3)
            } failure: {
                Text(":\(e.name):").font(.zkSans(14)).foregroundColor(Theme.ink3)
            }
            .frame(width: 40, height: 40)
        } else {
            Text(":\(e.name):").font(.zkSans(14)).foregroundColor(Theme.ink3)
        }
    }

    @ViewBuilder
    private var pollView: some View {
        if let poll = message.poll {
            PollCard(poll: poll) { option in
                Task { await store.togglePollVote(message: message, option: option) }
            }
        }
    }

    @ViewBuilder
    private var stickerView: some View {
        if let sticker = message.sticker, let url = assetURL(sticker.url) {
            CachedImage(url: url, contentMode: .fit) {
                ProgressView().frame(width: 120, height: 120)
            } failure: {
                Text(":\(sticker.name):").font(.zkSans(13)).foregroundColor(Theme.ink3)
            }
            .frame(width: 140, height: 140, alignment: .leading)
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private var embedsView: some View {
        // Server-resolved embeds when present; otherwise the client-resolved
        // ones for an E2EE message (the server can't unfurl ciphertext, so it
        // sent embeds: [] and we unfurled locally after decrypting).
        let serverEmbeds = message.embeds ?? []
        let embeds = serverEmbeds.isEmpty ? data.localEmbeds : serverEmbeds
        if !embeds.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(embeds.enumerated()), id: \.offset) { _, e in
                    embedCard(e)
                }
            }
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private func embedCard(_ e: MessageEmbed) -> some View {
        if e.kind == "rich" {
            richEmbedCard(e)
        } else if e.kind == "image", let img = assetURL(e.imageUrl) {
            // Pure image unfurl. CachedImage (decoded cache + off-main downsample)
            // so a scroll-back doesn't re-decode full-res on the main thread; a
            // reserved box so it doesn't reflow the row when it loads.
            CachedImage(url: img, contentMode: .fit) { Color.clear } failure: { Color.clear }
                .frame(maxWidth: 260, minHeight: 146, maxHeight: 146, alignment: .leading)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .onTapGesture { store.openLightbox(img) }
        } else {
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(Theme.accent).frame(width: 3)
                VStack(alignment: .leading, spacing: 5) {
                    if let site = e.siteName, !site.isEmpty {
                        HStack(spacing: 5) {
                            if let fav = assetURL(e.faviconUrl) {
                                CachedImage(url: fav, contentMode: .fill) { Color.clear } failure: { Color.clear }
                                    .frame(width: 14, height: 14).clipShape(RoundedRectangle(cornerRadius: 3))
                            }
                            Text(site).font(.zkSans(11)).foregroundColor(Theme.ink3).lineLimit(1)
                        }
                    }
                    if let title = e.title, !title.isEmpty {
                        Text(title).font(.zkSans(14, weight: .semibold))
                            .foregroundColor(Theme.accent).lineLimit(2)
                    }
                    if let desc = e.description, !desc.isEmpty {
                        Text(desc).font(.zkSans(13)).foregroundColor(Theme.ink2)
                            .lineLimit(4).fixedSize(horizontal: false, vertical: true)
                    }
                    if (e.title?.isEmpty ?? true) && (e.description?.isEmpty ?? true) {
                        Text(e.url).font(.zkSans(13)).foregroundColor(Theme.accent).lineLimit(1)
                    }
                    if let img = assetURL(e.imageUrl) {
                        CachedImage(url: img, contentMode: .fit) { Color.clear } failure: { Color.clear }
                            .frame(maxWidth: 240, minHeight: 135, maxHeight: 135, alignment: .leading)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                            .onTapGesture { store.openLightbox(img) }
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: 300, alignment: .leading)
            .background(Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
            .onTapGesture { if let u = URL(string: e.url) { openURL(u) } }
        }
    }

    /// Rich (Discord-style) webhook embed: accent bar, author, title/desc,
    /// name/value fields, image, thumbnail, footer + timestamp. Mirrors the web
    /// RichEmbedCard.
    @ViewBuilder
    private func richEmbedCard(_ e: MessageEmbed) -> some View {
        HStack(alignment: .top, spacing: 0) {
            RoundedRectangle(cornerRadius: 2).fill(embedAccent(e.color)).frame(width: 3)
            VStack(alignment: .leading, spacing: 6) {
                if let author = e.authorName, !author.isEmpty {
                    HStack(spacing: 6) {
                        if let icon = assetURL(e.authorIconUrl) {
                            CachedImage(url: icon, contentMode: .fill) { Color.clear } failure: { Color.clear }
                                .frame(width: 18, height: 18).clipShape(Circle())
                        }
                        Text(author).font(.zkSans(12, weight: .semibold))
                            .foregroundColor(Theme.ink2).lineLimit(1)
                    }
                }
                if let title = e.title, !title.isEmpty {
                    Text(title).font(.zkSans(14, weight: .semibold))
                        .foregroundColor(e.url.isEmpty ? Theme.ink1 : Theme.accent)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let desc = e.description, !desc.isEmpty {
                    // Discord renders markdown (bold/italic/code/links) in embed
                    // descriptions — route through the same renderer as message
                    // bodies instead of plain Text.
                    Text(richContent(desc)).font(.zkSans(13)).foregroundColor(Theme.ink2)
                        .environment(\.openURL, mentionOpenURL())
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let fields = e.fields, !fields.isEmpty {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(fields.enumerated()), id: \.offset) { _, f in
                            VStack(alignment: .leading, spacing: 1) {
                                Text(f.name).font(.zkSans(12, weight: .semibold)).foregroundColor(Theme.ink1)
                                Text(richContent(f.value)).font(.zkSans(13)).foregroundColor(Theme.ink2)
                                    .environment(\.openURL, mentionOpenURL())
                                    .fixedSize(horizontal: false, vertical: true)
                            }
                        }
                    }
                }
                if let img = assetURL(e.imageUrl) {
                    CachedImage(url: img, contentMode: .fit) { Color.clear } failure: { Color.clear }
                        .frame(maxWidth: 280, minHeight: 158, maxHeight: 158, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                        .onTapGesture { store.openLightbox(img) }
                }
                let footer = embedFooter(e)
                if !footer.isEmpty {
                    HStack(spacing: 6) {
                        if let icon = assetURL(e.footerIconUrl) {
                            CachedImage(url: icon, contentMode: .fill) { Color.clear } failure: { Color.clear }
                                .frame(width: 16, height: 16).clipShape(Circle())
                        }
                        Text(footer).font(.zkSans(11)).foregroundColor(Theme.ink3).lineLimit(2)
                    }
                }
            }
            .padding(10)
            if let thumb = assetURL(e.thumbnailUrl) {
                CachedImage(url: thumb, contentMode: .fill) { Color.clear } failure: { Color.clear }
                    .frame(width: 64, height: 64)
                    .clipShape(RoundedRectangle(cornerRadius: 6))
                    .padding([.top, .trailing], 10)
            }
        }
        .frame(maxWidth: 340, alignment: .leading)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .contentShape(Rectangle())
        .onTapGesture {
            // http(s) only — the server scheme-validates webhook embed urls, but
            // guard here too so a non-web scheme can't trigger an unintended
            // deep link from untrusted embed input.
            if let u = URL(string: e.url), u.scheme == "http" || u.scheme == "https" {
                openURL(u)
            }
        }
    }

    /// Accent colour from a Discord sRGB int; falls back to the theme accent.
    private func embedAccent(_ color: Int?) -> Color {
        guard let c = color else { return Theme.accent }
        return Color(
            red: Double((c >> 16) & 0xff) / 255,
            green: Double((c >> 8) & 0xff) / 255,
            blue: Double(c & 0xff) / 255)
    }

    /// Footer line: footer text joined with a short formatted timestamp.
    private func embedFooter(_ e: MessageEmbed) -> String {
        var parts: [String] = []
        if let f = e.footerText, !f.isEmpty { parts.append(f) }
        if let ts = e.timestamp, !ts.isEmpty, let d = ISO8601DateFormatter().date(from: ts) {
            let fmt = DateFormatter()
            fmt.dateFormat = "MMM d, h:mm a"
            parts.append(fmt.string(from: d))
        }
        return parts.joined(separator: " • ")
    }

    /// Snapshot of a forwarded message: an attribution line + the source
    /// content, in a left-bordered block. Mirrors ForwardedMessageBlock.
    private func forwardedBlock(_ fwd: ForwardSource) -> some View {
        let where_ = fwd.channel?.name.map { "#\($0)" } ?? "a channel"
        let who = fwd.author?.name ?? "Unknown"
        return HStack(alignment: .top, spacing: 8) {
            Rectangle().fill(Theme.line).frame(width: 3)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Image(systemName: "arrowshape.turn.up.right.fill")
                        .font(.system(size: 9)).foregroundColor(Theme.ink3)
                    Text("Forwarded from \(who) in \(where_)")
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink3)
                        .lineLimit(1)
                }
                if fwd.content.isEmpty {
                    Text("[unavailable]")
                        .font(.zkSans(14)).italic()
                        .foregroundColor(Theme.ink4)
                } else {
                    Text(fwd.content)
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 2)
    }

    /// Is this an E2EE (.zke) attachment in this (encrypted) channel?
    private func isEncrypted(_ att: Attachment) -> Bool {
        channel.isE2EE && (att.filename?.hasSuffix(".zke") == true)
    }

    /// For an encrypted attachment, does its INNER filename look like an image?
    private func encryptedInnerIsImage(_ att: Attachment) -> Bool {
        guard let n = att.filename, n.hasSuffix(".zke") else { return false }
        let ext = (String(n.dropLast(4)) as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff"].contains(ext)
    }

    /// Is this a groupable photo (plain image OR encrypted image)?
    private func isGridImage(_ att: Attachment) -> Bool {
        isEncrypted(att) ? encryptedInnerIsImage(att) : att.isImage
    }

    @ViewBuilder
    private var attachmentsView: some View {
        if let attachments = message.attachments, !attachments.isEmpty {
            // Voice first (own decrypting view), then a GRID of photos/videos —
            // including ENCRYPTED photos — so 2+ group into a tidy 2-col grid
            // instead of a messy stack. Encrypted videos/files (and plain
            // files) render individually after.
            // Partition in ONE pass (was 4 filters + a Set) — order preserved
            // within each bucket. Voice first; then groupable media (plain
            // image/video, or encrypted image); then everything else (encrypted
            // video/file decrypts in EncryptedAttachmentView, plus plain files).
            // Wrapped in a closure since a @ViewBuilder can't host imperative
            // statements directly.
            let (voice, media, leftover): ([Attachment], [Attachment], [Attachment]) = {
                var v: [Attachment] = []
                var m: [Attachment] = []
                var l: [Attachment] = []
                for att in attachments {
                    if att.isVoiceMessage == true {
                        v.append(att)
                    } else if isEncrypted(att) ? encryptedInnerIsImage(att) : (att.isImage || att.isVideo) {
                        m.append(att)
                    } else {
                        l.append(att)
                    }
                }
                return (v, m, l)
            }()
            VStack(alignment: .leading, spacing: 6) {
                ForEach(voice) { VoiceMessageView(store: store, attachment: $0, channel: channel) }
                if media.count >= 2 {
                    mediaGrid(media)
                } else {
                    ForEach(media) { singleMedia($0) }
                }
                ForEach(leftover) { att in
                    if isEncrypted(att) {
                        EncryptedAttachmentView(store: store, attachment: att, channel: channel, e2eeUnlockVersion: data.e2eeUnlockVersion)
                    } else {
                        fileChip(att)
                    }
                }
            }
            .padding(.top, 2)
        }
    }

    /// A single photo/video when a message has just one media attachment.
    @ViewBuilder
    private func singleMedia(_ att: Attachment) -> some View {
        if isEncrypted(att) {
            EncryptedAttachmentView(store: store, attachment: att, channel: channel, e2eeUnlockVersion: data.e2eeUnlockVersion)
        } else if att.isImage, let inlineURL = inlineAttachmentURL(att) {
            // Reserve the image's final on-screen size UP FRONT from its known
            // width/height so loading doesn't reflow the row (and the bottom).
            let dim = imageDisplaySize(att)
            // Inline shows the small server thumbnail when present; the tap opens
            // the full image (full `url`) — unless retention has aged the
            // original out, in which case the thumbnail IS all that's left, so
            // the tap is inert and a small badge says why.
            CachedImage(url: inlineURL, contentMode: .fit) {
                if dim != nil {
                    Rectangle().fill(Theme.bg3).overlay(ProgressView().tint(Theme.accent))
                } else {
                    ProgressView().frame(width: 140, height: 90)
                }
            } failure: {
                fileChip(att)
            }
            .onTapGesture {
                guard !att.blobExpired, let full = assetURL(att.url) else { return }
                store.openLightbox(full)
            }
            .frame(width: dim?.width, height: dim?.height)
            .frame(maxWidth: 240, maxHeight: 240, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(alignment: .bottomLeading) {
                if att.blobExpired { ExpiredOriginalBadge() }
            }
            // Long-press → the message row's context menu (Add reaction, Reply,
            // …, plus Save/Copy/Share for this photo). NOT a nested .imageActions
            // menu here — that used to swallow the reaction menu on single photos.
        } else if att.isVideo {
            // Expired video: no playable original left, so the chip renders
            // inert rather than opening a dead URL into a stuck player.
            videoChip(att, url: att.blobExpired ? nil : assetURL(att.url))
        } else {
            fileChip(att)
        }
    }

    /// 2-column grid for a message with 2+ photos/videos, plus a Save-all
    /// affordance. Tapping a photo opens the swipeable lightbox across all the
    /// message's photos; tapping a video opens the full-screen player.
    @ViewBuilder
    private func mediaGrid(_ media: [Attachment]) -> some View {
        // Images for the paged lightbox = plain images AND encrypted images —
        // MINUS any whose original has expired, since the lightbox is a
        // full-size view and those bytes are gone. They still render inline
        // from their thumbnail; they just aren't openable.
        let images = media.filter { isGridImage($0) && !$0.blobExpired }
        // Same for "Save all": only what can still be fetched at full size.
        let savable = media.filter { !$0.blobExpired }
        let cols = [GridItem(.flexible(), spacing: 4), GridItem(.flexible(), spacing: 4)]
        VStack(alignment: .leading, spacing: 6) {
            LazyVGrid(columns: cols, spacing: 4) {
                ForEach(media) { att in gridCell(att, images: images) }
            }
            .frame(maxWidth: 260)
            if !savable.isEmpty {
                SaveAllButton(store: store, media: savable, channel: channel)
            }
        }
    }

    @ViewBuilder
    private func gridCell(_ att: Attachment, images: [Attachment]) -> some View {
        if isEncrypted(att) {
            // Encrypted photo: decrypting square thumbnail. Tap → paged
            // lightbox across the message's photos (plain + decrypted E2EE) —
            // but not once the original expired: the lightbox is full-size and
            // that ciphertext is gone (the encrypted thumbnail survives).
            EncryptedThumb(store: store, attachment: att, channel: channel, e2eeUnlockVersion: data.e2eeUnlockVersion) {
                guard !att.blobExpired else { return }
                Task { await store.openImageLightbox(images: images, tapped: att.id, in: channel) }
            }
            .overlay(alignment: .bottomLeading) {
                if att.blobExpired { ExpiredOriginalBadge() }
            }
        } else if att.isImage, let inlineURL = inlineAttachmentURL(att) {
            // Inline grid cell shows the small server thumbnail when present;
            // the tap opens the full image via openImageLightbox — inert once
            // the original expired (the thumbnail is all that's left).
            Rectangle()
                .fill(Theme.bg3)
                .aspectRatio(1, contentMode: .fit)
                .overlay(
                    CachedImage(url: inlineURL, contentMode: .fill) {
                        ProgressView().tint(Theme.accent)
                    } failure: {
                        Image(systemName: "photo").foregroundColor(Theme.ink3)
                    }
                )
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(alignment: .bottomLeading) {
                    if att.blobExpired { ExpiredOriginalBadge() }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard !att.blobExpired else { return }
                    Task { await store.openImageLightbox(images: images, tapped: att.id, in: channel) }
                }
        } else if att.isVideo {
            let playURL = att.blobExpired ? nil : assetURL(att.url)
            Rectangle()
                .fill(Color.black)
                .aspectRatio(1, contentMode: .fit)
                .overlay(
                    // No play glyph once the original is gone — there is
                    // nothing left to play.
                    Group {
                        if playURL != nil {
                            Image(systemName: "play.circle.fill")
                                .font(.system(size: 30))
                                .foregroundColor(.white.opacity(0.9))
                        } else {
                            Image(systemName: "clock")
                                .font(.system(size: 22))
                                .foregroundColor(.white.opacity(0.75))
                        }
                    }
                )
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(alignment: .bottomLeading) {
                    if att.blobExpired { ExpiredOriginalBadge() }
                }
                .contentShape(Rectangle())
                .onTapGesture {
                    guard let playURL else { return }
                    videoToPlay = VideoItem(url: playURL)
                }
        } else {
            fileChip(att)
        }
    }

    /// The on-screen size a message image will occupy, derived from its known
    /// pixel dimensions fit into the 240×240 bound (the same box the loaded
    /// image lands in). Returned so the placeholder can reserve EXACTLY that
    /// space and the image loads in without reflowing the row. nil when the
    /// dimensions are unknown (e.g. encrypted attachments) — caller falls back
    /// to the flexible layout.
    private func imageDisplaySize(_ att: Attachment) -> CGSize? {
        guard let w = att.width, let h = att.height, w > 0, h > 0 else { return nil }
        let bound: CGFloat = 240
        let scale = min(bound / CGFloat(w), bound / CGFloat(h))
        return CGSize(width: CGFloat(w) * scale, height: CGFloat(h) * scale)
    }

    private func fileChip(_ att: Attachment) -> some View {
        HStack(spacing: 8) {
            Image(systemName: att.blobExpired ? "clock" : "doc.fill").foregroundColor(Theme.ink3)
            VStack(alignment: .leading, spacing: 1) {
                Text(att.filename ?? "file")
                    .font(.zkSans(13, weight: .medium))
                    .foregroundColor(Theme.ink1)
                    .lineLimit(1)
                if let sub = chipSubtitle(att) {
                    Text(sub)
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink3)
                }
            }
        }
        .padding(8)
        .background(Theme.bg3)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    /// Tappable video attachment chip → opens the full-screen player. `url` is
    /// nil once retention aged the original out — the chip then renders inert
    /// (no play glyph, no tap) instead of handing a dead URL to AVPlayer, which
    /// would sit on a spinner forever.
    private func videoChip(_ att: Attachment, url: URL?) -> some View {
        Button {
            if let url { videoToPlay = VideoItem(url: url) }
        } label: {
            HStack(spacing: 8) {
                ZStack {
                    RoundedRectangle(cornerRadius: 6).fill(Theme.bg1)
                        .frame(width: 40, height: 40)
                    Image(systemName: url == nil ? "clock" : "play.fill")
                        .font(.system(size: 15))
                        .foregroundColor(url == nil ? Theme.ink3 : Theme.accent)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(att.filename ?? "video")
                        .font(.zkSans(13, weight: .medium))
                        .foregroundColor(Theme.ink1)
                        .lineLimit(1)
                    if let sub = chipSubtitle(att) {
                        Text(sub)
                            .font(.zkSans(11))
                            .foregroundColor(Theme.ink3)
                    }
                }
                Spacer(minLength: 0)
            }
            .padding(8)
            .frame(maxWidth: 240, alignment: .leading)
            .background(Theme.bg3)
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(url == nil)
    }

    @ViewBuilder
    private var reactionsView: some View {
        if let reactions = message.reactions, !reactions.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(reactions, id: \.emoji) { r in
                        ReactionPill(store: store, reaction: r) { react(r.emoji) }
                    }
                    // Web parity: trailing "+" pill opens the emoji picker.
                    Button { showReactionPicker = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(Theme.ink3)
                            .frame(width: 28, height: 24)
                            .background(Theme.bg2)
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.line, lineWidth: 1))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 2)
        }
    }
}

private func byteString(_ bytes: Int) -> String {
    let kb = 1024.0
    let mb = kb * 1024
    let b = Double(bytes)
    if b >= mb { return String(format: "%.1f MB", b / mb) }
    if b >= kb { return String(format: "%.0f KB", b / kb) }
    return "\(bytes) B"
}

// MARK: - Expired originals (attachment blob retention)
//
// Media retention ages out the FULL-SIZE object of old attachments and stamps
// `blobExpiredAt`. It is OFF unless an operator turns it on: the server's
// ATTACHMENT_RETENTION_DAYS defaults to 0 (disabled) and, once set,
// ATTACHMENT_RETENTION_DRY_RUN defaults to true (log-only), with
// docker-compose.yml pinning both to those defaults. So on a stock deployment
// nothing ever expires — but the client must still handle it, because any
// instance may enable it. The message, its text, the attachment
// row (filename/size/dimensions) and the small thumbnail all survive — only the
// original bytes are gone, and `url` is deliberately still populated (it is
// non-optional in every shipped client), so it now points at a dead path.
// Everything that would fetch the full size — inline fallback, lightbox, video
// player, Save/Copy/Share, gallery, E2EE decrypt — must gate on `blobExpired`,
// never on a missing url.

/// The URL to render INLINE for a plain (non-E2EE) image: the small server
/// thumbnail when there is one, else the original — but never the original once
/// it has expired, since that path no longer resolves. nil ⇒ nothing renderable
/// (an expired attachment with no thumbnail, which retention doesn't produce);
/// callers fall back to the file chip.
private func inlineAttachmentURL(_ att: Attachment) -> URL? {
    if let thumb = att.thumbnailUrl.flatMap({ assetURL($0) }) { return thumb }
    return att.blobExpired ? nil : assetURL(att.url)
}

/// Secondary line under a file/video chip: the size, plus the expired note once
/// the server has dropped the original.
private func chipSubtitle(_ att: Attachment) -> String? {
    let size = att.size.map { byteString($0) }
    guard att.blobExpired else { return size }
    return size.map { "\($0) · original expired" } ?? "Original expired"
}

/// Calm corner marker for a photo/video whose full-size original the server no
/// longer stores. Sits over the surviving thumbnail — deliberately small and
/// unobtrusive (the picture is still there; only the original went).
private struct ExpiredOriginalBadge: View {
    var body: some View {
        HStack(spacing: 3) {
            Image(systemName: "clock")
                .font(.system(size: 9, weight: .semibold))
            Text("Original expired")
                .font(.zkSans(10, weight: .medium))
        }
        .foregroundColor(.white.opacity(0.92))
        .padding(.horizontal, 6)
        .padding(.vertical, 3)
        .background(Color.black.opacity(0.45))
        .clipShape(Capsule())
        .padding(6)
        // Decorative only — never steal the tap/long-press from the photo.
        .allowsHitTesting(false)
    }
}

struct ReactionPill: View {
    // Plain (non-observing) ref — only used for emoji-glyph lookups at render.
    // The parent row's emojiCatalogVersion (in its ==) re-renders the row, and
    // thus its pills, when the custom-emoji catalog/images change.
    let store: AppStore
    let reaction: ReactionAggregate
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 4) {
                glyph
                Text("\(reaction.count)")
                    .font(.zkSans(11))
                    .foregroundColor(Theme.ink2)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(reaction.me ? Theme.accent.opacity(0.2) : Theme.bg2)
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(reaction.me ? Theme.accent.opacity(0.6) : Theme.line, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    /// Unicode reactions render as text; `:name:` custom reactions resolve
    /// against the guild emoji index (web ReactionGlyph parity).
    @ViewBuilder
    private var glyph: some View {
        if reaction.emoji.hasPrefix(":") && reaction.emoji.hasSuffix(":"),
           let e = store.emojiByName[String(reaction.emoji.dropFirst().dropLast())],
           let img = store.emojiImage(for: e) {
            Image(uiImage: img)
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 18)
        } else {
            Text(reaction.emoji)
                .font(.zkSans(13))
                .frame(height: 18)
        }
    }
}

/// Shown in place of the timeline when an encrypted DM has no local key.
/// Collects the shared password, verifies it, and unlocks the conversation.
private struct UnlockPanel: View {
    @EnvironmentObject private var store: AppStore
    let channel: Channel
    @State private var password = ""
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "lock.fill")
                .font(.system(size: 40))
                .foregroundColor(Theme.accent)
            Text("End-to-end encrypted")
                .font(.zkSans(18, weight: .semibold))
                .foregroundColor(Theme.ink1)
            Text("Enter the shared password to read and send messages here.")
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            SecureField("Password", text: $password)
                .textContentType(.password)
                .focused($focused)
                .submitLabel(.go)
                .onSubmit(unlock)
                .foregroundColor(Theme.ink1)
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(Theme.bg2)
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 32)

            if let err = store.e2eeError {
                Text(err)
                    .font(.zkSans(13))
                    .foregroundColor(Theme.danger)
            }

            Button(action: unlock) {
                Text("Unlock")
                    .font(.zkSans(15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundColor(.white)
                    .background(password.isEmpty ? Theme.accent.opacity(0.4) : Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .disabled(password.isEmpty)
            .padding(.horizontal, 32)

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg1)
        .onAppear { focused = true }
    }

    private func unlock() {
        guard !password.isEmpty else { return }
        Task {
            if await store.unlockE2EE(channel, password: password) { password = "" }
        }
    }
}

/// Sheet for turning on E2EE for a DM by choosing a shared password.
private struct EnableE2EESheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    @State private var password = ""
    @State private var confirm = ""
    @State private var busy = false

    private var canEnable: Bool { password.count >= 4 && password == confirm }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg1.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    Text("Pick a shared password and share it with the other person out-of-band. The server never sees it — they enter the same password to read these messages.")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink2)

                    secureField("Password", text: $password)
                    secureField("Confirm password", text: $confirm)

                    if !confirm.isEmpty && confirm != password {
                        Text("Passwords don't match")
                            .font(.zkSans(12))
                            .foregroundColor(Theme.danger)
                    }
                    if let err = store.e2eeError {
                        Text(err)
                            .font(.zkSans(13))
                            .foregroundColor(Theme.danger)
                    }

                    Button(action: enable) {
                        ZStack {
                            if busy { ProgressView().tint(.white) }
                            else { Text("Enable encryption").font(.zkSans(15, weight: .semibold)) }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .foregroundColor(.white)
                        .background(canEnable ? Theme.accent : Theme.accent.opacity(0.4))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .disabled(!canEnable || busy)

                    Text("Note: enabling encryption is permanent until disabled, and existing plaintext history stays readable. New messages from both sides are encrypted.")
                        .font(.zkSans(12))
                        .foregroundColor(Theme.ink3)

                    Spacer()
                }
                .padding(20)
            }
            .navigationTitle("Encrypt DM")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func secureField(_ title: String, text: Binding<String>) -> some View {
        SecureField(title, text: text)
            .textContentType(.newPassword)
            .foregroundColor(Theme.ink1)
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(Theme.bg2)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func enable() {
        busy = true
        Task {
            let ok = await store.enableE2EE(channel, password: password)
            busy = false
            if ok { dismiss() }
        }
    }
}

/// A picked-but-not-yet-sent attachment held by the composer. `preview` is
/// a thumbnail for images; nil for video (the chip shows a film icon
/// instead of decoding a frame).
private struct PendingAttachment: Identifiable {
    let id = UUID()
    let data: Data
    let filename: String
    let mime: String
    let isVideo: Bool
    let preview: UIImage?
}

/// UITextView subclass that accepts pasted images. SwiftUI's `TextField`
/// can't intercept an image paste from the keyboard's edit menu — a copied
/// image is silently dropped. This enables the "Paste" item whenever the
/// pasteboard holds an image and routes those images to a handler (which adds
/// them as pending attachments), so pasting works straight from the keyboard
/// instead of a separate menu button.
private final class ImagePasteTextView: UITextView {
    var onPasteImages: (([UIImage]) -> Void)?

    override func canPerformAction(_ action: Selector, withSender sender: Any?) -> Bool {
        if action == #selector(paste(_:)), UIPasteboard.general.hasImages {
            return true
        }
        return super.canPerformAction(action, withSender: sender)
    }

    override func paste(_ sender: Any?) {
        // Prefer images: if the clipboard holds image(s), hand them off and
        // stop — don't also dump a file path / alt text into the field. Plain
        // text (no image) falls through to the normal text paste.
        if UIPasteboard.general.hasImages,
           let images = UIPasteboard.general.images, !images.isEmpty {
            onPasteImages?(images)
            return
        }
        super.paste(sender)
    }
}

/// Composer text input backed by `ImagePasteTextView`. Mirrors the prior
/// SwiftUI `TextField`: vertical auto-grow (1...maxLines, then it scrolls),
/// a placeholder, a focus binding bridged to `@FocusState`-style state, and
/// Theme styling. Exists so image paste can be intercepted (see above).
private struct ComposerTextView: UIViewRepresentable {
    @Binding var text: String
    let placeholder: String
    @Binding var isFocused: Bool
    var maxLines: Int = 5
    let onPasteImages: ([UIImage]) -> Void

    func makeUIView(context: Context) -> ImagePasteTextView {
        let tv = ImagePasteTextView()
        tv.delegate = context.coordinator
        tv.onPasteImages = onPasteImages
        tv.font = UIFont.preferredFont(forTextStyle: .body)
        tv.textColor = UIColor(Theme.ink1)
        tv.tintColor = UIColor(Theme.accent)
        tv.backgroundColor = .clear
        tv.isScrollEnabled = true
        tv.textContainerInset = UIEdgeInsets(top: 6, left: 0, bottom: 6, right: 0)
        tv.textContainer.lineFragmentPadding = 0
        tv.text = text

        let placeholderLabel = UILabel()
        placeholderLabel.text = placeholder
        placeholderLabel.font = tv.font
        placeholderLabel.textColor = UIColor(Theme.ink3)
        placeholderLabel.numberOfLines = 1
        placeholderLabel.translatesAutoresizingMaskIntoConstraints = false
        tv.addSubview(placeholderLabel)
        NSLayoutConstraint.activate([
            placeholderLabel.leadingAnchor.constraint(equalTo: tv.leadingAnchor),
            placeholderLabel.topAnchor.constraint(equalTo: tv.topAnchor, constant: 6),
            placeholderLabel.trailingAnchor.constraint(lessThanOrEqualTo: tv.trailingAnchor),
        ])
        placeholderLabel.isHidden = !text.isEmpty
        context.coordinator.placeholderLabel = placeholderLabel
        return tv
    }

    func updateUIView(_ uiView: ImagePasteTextView, context: Context) {
        if uiView.text != text { uiView.text = text }
        uiView.onPasteImages = onPasteImages
        context.coordinator.placeholderLabel?.text = placeholder
        context.coordinator.placeholderLabel?.isHidden = !uiView.text.isEmpty
        // Focus bridge — defer to the next runloop so we never mutate the
        // responder chain mid-layout. Idempotent via the isFirstResponder guard.
        let wantFocus = isFocused
        DispatchQueue.main.async {
            if wantFocus, !uiView.isFirstResponder {
                uiView.becomeFirstResponder()
            } else if !wantFocus, uiView.isFirstResponder {
                uiView.resignFirstResponder()
            }
        }
    }

    func sizeThatFits(_ proposal: ProposedViewSize, uiView: ImagePasteTextView, context: Context) -> CGSize? {
        let line = uiView.font?.lineHeight ?? 18
        let inset = uiView.textContainerInset.top + uiView.textContainerInset.bottom
        let minH = ceil(line + inset)
        let maxH = ceil(line * CGFloat(maxLines) + inset)
        let width = proposal.width ?? uiView.bounds.width
        // Width not resolved yet (degenerate first pass): reserve a single
        // line so the bar never collapses to zero height before re-measure.
        guard width > 0 else { return CGSize(width: width, height: minH) }
        let fitting = uiView.sizeThatFits(CGSize(width: width, height: .greatestFiniteMagnitude))
        return CGSize(width: width, height: min(max(fitting.height, minH), maxH))
    }

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UITextViewDelegate {
        private let parent: ComposerTextView
        weak var placeholderLabel: UILabel?

        init(_ parent: ComposerTextView) { self.parent = parent }

        func textViewDidChange(_ textView: UITextView) {
            // Mutating the bound text re-evaluates the owning SwiftUI view,
            // which re-runs sizeThatFits below — that's what drives the
            // 1...maxLines auto-grow as the user types.
            parent.text = textView.text
            placeholderLabel?.isHidden = !textView.text.isEmpty
        }

        func textViewDidBeginEditing(_ textView: UITextView) {
            if !parent.isFocused {
                DispatchQueue.main.async { self.parent.isFocused = true }
            }
        }

        func textViewDidEndEditing(_ textView: UITextView) {
            if parent.isFocused {
                DispatchQueue.main.async { self.parent.isFocused = false }
            }
        }
    }
}

/// Wrapper so a video URL can drive a `.fullScreenCover(item:)`.
private struct VideoItem: Identifiable {
    let id = UUID()
    let url: URL
}

/// Full-screen player shown when a video attachment is tapped.
private struct VideoLightboxView: View {
    let url: URL
    @Environment(\.dismiss) private var dismiss
    @State private var player: AVPlayer?

    var body: some View {
        ZStack(alignment: .topTrailing) {
            Color.black.ignoresSafeArea()
            if let player {
                VideoPlayer(player: player).ignoresSafeArea()
            }
            Button { dismiss() } label: {
                Image(systemName: "xmark")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(.white)
                    .padding(10)
                    .background(Circle().fill(.black.opacity(0.5)))
            }
            .padding()
        }
        .onAppear {
            let p = AVPlayer(url: url)
            player = p
            p.play()
        }
        .onDisappear {
            player?.pause()
            player = nil
        }
    }
}

/// Sheet for editing one of the current user's messages.
struct EditMessageSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let message: Message
    // Bound to the parent row's @State editText, which beginEdit() fills with
    // the message's current (E2EE-decrypted) content right before presenting —
    // so the field is pre-filled, and re-edits aren't stale (a re-seeded private
    // @State was ignored when SwiftUI reused the sheet's view identity).
    @Binding var text: String

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(3...10)
                    .padding(12)
                    .background(Theme.bg3)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundColor(Theme.ink1)
                Spacer()
            }
            .padding(16)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Edit message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let newText = text
                        dismiss()
                        Task { await store.editMessage(message, newContent: newText) }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

/// A poll attached to a message: question, tappable options with live tallies.
struct PollCard: View {
    let poll: Poll
    let onVote: (PollOption) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(poll.question)
                .font(.zkSans(15, weight: .semibold))
                .foregroundColor(Theme.ink1)
            ForEach(poll.options.sorted { $0.position < $1.position }) { option in
                PollOptionRow(option: option, poll: poll) { onVote(option) }
            }
            HStack(spacing: 5) {
                Text("\(poll.totalVoters) vote\(poll.totalVoters == 1 ? "" : "s")")
                if poll.multipleChoice { Text("· Multiple choice") }
                if !poll.isOpen { Text("· Closed") }
            }
            .font(.zkSans(11))
            .foregroundColor(Theme.ink3)
        }
        .padding(12)
        .frame(maxWidth: 320, alignment: .leading)
        .background(Theme.bg2)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.top, 2)
    }
}

private struct PollOptionRow: View {
    let option: PollOption
    let poll: Poll
    let onTap: () -> Void

    private var fraction: Double {
        poll.totalVoters > 0 ? Double(option.voteCount) / Double(poll.totalVoters) : 0
    }
    private var voted: Bool { poll.myVotes.contains(option.id) }

    var body: some View {
        Button(action: onTap) {
            ZStack(alignment: .leading) {
                GeometryReader { geo in
                    RoundedRectangle(cornerRadius: 8)
                        .fill(voted ? Theme.accent.opacity(0.28) : Theme.bg3)
                        .frame(width: max(6, geo.size.width * fraction))
                }
                HStack(spacing: 6) {
                    if voted {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundColor(Theme.accent)
                    }
                    Text(option.text)
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink1)
                        .lineLimit(2)
                    Spacer()
                    Text("\(option.voteCount)")
                        .font(.zkSans(12, weight: .medium))
                        .foregroundColor(Theme.ink2)
                }
                .padding(.horizontal, 10)
            }
            .frame(height: 36)
            .background(Theme.bg3.opacity(0.4))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(!poll.isOpen)
    }
}

/// Sheet for composing a new poll (question, options, choice mode, duration).
struct CreatePollSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var question = ""
    @State private var options: [String] = ["", ""]
    @State private var multipleChoice = false
    @State private var durationHours = 24

    private let durations: [(String, Int)] = [
        ("1 hour", 1), ("6 hours", 6), ("1 day", 24), ("3 days", 72), ("1 week", 168),
    ]

    private var trimmedOptions: [String] {
        options.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
    private var canCreate: Bool {
        !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && trimmedOptions.count >= 2
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    section("QUESTION") {
                        TextField("Ask something…", text: $question, axis: .vertical)
                            .lineLimit(1...3)
                            .padding(12)
                            .background(Theme.bg3)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .foregroundColor(Theme.ink1)
                    }

                    section("OPTIONS") {
                        VStack(spacing: 8) {
                            ForEach(options.indices, id: \.self) { i in
                                HStack(spacing: 8) {
                                    TextField("Option \(i + 1)", text: $options[i])
                                        .padding(12)
                                        .background(Theme.bg3)
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                        .foregroundColor(Theme.ink1)
                                    if options.count > 2 {
                                        Button { options.remove(at: i) } label: {
                                            Image(systemName: "minus.circle.fill")
                                                .font(.system(size: 20))
                                                .foregroundColor(Theme.ink3)
                                        }
                                    }
                                }
                            }
                            if options.count < 10 {
                                Button { options.append("") } label: {
                                    Label("Add option", systemImage: "plus.circle")
                                        .font(.zkSans(14))
                                        .foregroundColor(Theme.accent)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }

                    Toggle("Allow multiple answers", isOn: $multipleChoice)
                        .font(.zkSans(15))
                        .foregroundColor(Theme.ink1)
                        .tint(Theme.accent)

                    section("DURATION") {
                        Picker("Duration", selection: $durationHours) {
                            ForEach(durations, id: \.1) { label, hours in
                                Text(label).tag(hours)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("New Poll")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        let q = question
                        let opts = trimmedOptions
                        let multi = multipleChoice
                        let hours = durationHours
                        dismiss()
                        Task { await store.sendPoll(question: q, options: opts, multipleChoice: multi, durationHours: hours) }
                    }
                    .disabled(!canCreate)
                }
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.zkSans(11, weight: .bold))
                .foregroundColor(Theme.ink3)
            content()
        }
    }
}

/// In-channel full-text message search.
struct SearchSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    @State private var query = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundColor(Theme.ink3)
                    TextField("Search this \(channel.isDM ? "conversation" : "channel")", text: $query)
                        .foregroundColor(Theme.ink1)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await store.searchMessages(query) } }
                    if !query.isEmpty {
                        Button { query = ""; store.clearSearch() } label: {
                            Image(systemName: "xmark.circle.fill").foregroundColor(Theme.ink3)
                        }
                    }
                }
                .padding(12)
                .background(Theme.bg3)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(16)

                if store.searching {
                    Spacer(); ProgressView().tint(Theme.accent); Spacer()
                } else if store.searchResults.isEmpty {
                    Spacer()
                    Text(query.isEmpty ? "Type to search messages" : "No matches")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink3)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.searchResults) { msg in
                                SearchResultRow(message: msg)
                                Divider().overlay(Theme.line)
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { store.clearSearch(); dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Close")
                }
            }
        }
    }
}

private struct SearchResultRow: View {
    let message: Message

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(message.author?.name ?? "Unknown")
                    .font(.zkSans(13, weight: .semibold))
                    .foregroundColor(Theme.ink2)
                Text(shortTime(message.createdAt))
                    .font(.zkSans(11))
                    .foregroundColor(Theme.ink3)
            }
            Text(previewText)
                .font(.zkSans(14))
                .foregroundColor(Theme.ink1)
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
    }

    private var previewText: String {
        if !message.text.isEmpty { return message.text }
        if message.poll != nil { return "📊 Poll" }
        if message.attachments?.isEmpty == false { return "📎 Attachment" }
        return "(no text)"
    }
}

/// Cross-DM search — searches every direct-message conversation at once,
/// mirroring the web "Search all DMs" panel. Reuses the same server full-text
/// search as the per-channel SearchSheet, via /users/@me/dms/search. Styled to
/// match SearchSheet (same field, states, and result rows); the only
/// difference is results span conversations and tapping one opens its DM.
struct DMSearchSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundColor(Theme.ink3)
                    TextField("Search all DMs", text: $query)
                        .foregroundColor(Theme.ink1)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await store.searchDMs(query) } }
                    if !query.isEmpty {
                        Button { query = ""; store.clearDMSearch() } label: {
                            Image(systemName: "xmark.circle.fill").foregroundColor(Theme.ink3)
                        }
                    }
                }
                .padding(12)
                .background(Theme.bg3)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(16)

                if store.dmSearching {
                    Spacer(); ProgressView().tint(Theme.accent); Spacer()
                } else if store.dmSearchResults.isEmpty {
                    Spacer()
                    Text(query.isEmpty ? "Search across every direct message" : "No matches")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink3)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.dmSearchResults) { msg in
                                DMSearchResultRow(message: msg) { dismiss() }
                                Divider().overlay(Theme.line)
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Search DMs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { store.clearDMSearch(); dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Close")
                }
            }
            .onDisappear { store.clearDMSearch() }
        }
    }
}

/// A cross-DM search result row. Like the per-channel SearchResultRow but
/// tappable: opens the DM the matched message belongs to.
private struct DMSearchResultRow: View {
    let message: Message
    let onOpen: () -> Void
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Button {
            if let dm = store.dms.first(where: { $0.id == message.channelId }) {
                store.selectChannel(dm)
                onOpen()
            }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(message.author?.name ?? "Unknown")
                        .font(.zkSans(13, weight: .semibold))
                        .foregroundColor(Theme.ink2)
                    Text(shortTime(message.createdAt))
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink3)
                }
                Text(previewText)
                    .font(.zkSans(14))
                    .foregroundColor(Theme.ink1)
                    .lineLimit(3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }

    private var previewText: String {
        if !message.text.isEmpty { return message.text }
        if message.poll != nil { return "📊 Poll" }
        if message.attachments?.isEmpty == false { return "📎 Attachment" }
        return "(no text)"
    }
}

/// Box so AttributedString (a value type) can live in NSCache, which needs
/// class instances.
private final class AttributedStringBox {
    let value: AttributedString
    init(_ value: AttributedString) { self.value = value }
}

/// Pure-function memo for `markdownAttributed`. The markdown parse below is the
/// single most expensive step in a message row's body, and the row re-evaluates
/// its body on every list republish — including reaction / read-receipt edits
/// that don't touch the text. Because the output depends ONLY on the input
/// string (no store / resolution state), caching by string is a strict
/// memoization: identical input always yields the identical AttributedString,
/// so a re-render that doesn't change the text reuses the parse instead of
/// redoing it. NSCache is thread-safe and self-evicts under memory pressure;
/// the count cap bounds it for the long-lived case.
private let markdownCache: NSCache<NSString, AttributedStringBox> = {
    let cache = NSCache<NSString, AttributedStringBox>()
    cache.countLimit = 2000
    return cache
}()

/// Render a chat message body as inline markdown — bold, italic, `code`,
/// ~~strikethrough~~, and [links](url) — while preserving newlines and runs of
/// whitespace. Falls back to the raw string if it can't be parsed as markdown.
///
/// Result is memoized by the input string (see `markdownCache`): a pure
/// function of `string`, so the cache never changes the rendered output.
func markdownAttributed(_ string: String) -> AttributedString {
    let key = string as NSString
    if let cached = markdownCache.object(forKey: key) {
        return cached.value
    }
    let options = AttributedString.MarkdownParsingOptions(
        allowsExtendedAttributes: true,
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible
    )
    let result: AttributedString
    if let attributed = try? AttributedString(markdown: string, options: options) {
        result = attributed
    } else {
        result = AttributedString(string)
    }
    markdownCache.setObject(AttributedStringBox(result), forKey: key)
    return result
}

// MARK: - Profile card

/// Floating profile shown when tapping a user anywhere (message author,
/// member list, voice tile). Mirrors the web ProfileCard: avatar, name,
/// @username, presence, and relationship-aware actions.
/// Sizing for the profile card sheet. On "Designed for iPad on Mac" a `.sheet`
/// renders as a form-sheet that does NOT grow to the `.large` detent, so the
/// content under the avatar was squeezed into a small scrolling strip. There we
/// give the card an explicit generous size so it fits without an inner scroll
/// bar; on iPhone/iPad it opens at 75% of the screen (so it reads as a card,
/// not a full takeover) and can still be dragged up to full height. The
/// `selection` binding pins the INITIAL detent to 0.75 (a detent Set is
/// unordered, so order alone wouldn't guarantee where it opens).
private struct ProfileCardPresentation: ViewModifier {
    @State private var detent: PresentationDetent = .fraction(0.75)
    func body(content: Content) -> some View {
        if ProcessInfo.processInfo.isiOSAppOnMac {
            content.frame(minWidth: 600, idealWidth: 620, minHeight: 880, idealHeight: 920)
        } else {
            content.presentationDetents([.fraction(0.75), .large], selection: $detent)
        }
    }
}

/// A rounded message bubble whose LEFT edge bulges out into a tail — drawn as
/// ONE continuous outline (rounded rect + tail in a single path), so the stroke
/// has no seam and it reads as a single message box. `tailCenterY` (fraction
/// down the body) places the tail; `tailTipDY` slides the tip up/down — positive
/// points down-and-left (SW) at the avatar, negative up-and-left (NW).
private struct SpeechBubbleLeft: Shape {
    var cornerRadius: CGFloat = 9
    var tailWidth: CGFloat = 8   // how far the tail protrudes left of the body
    var tailHeight: CGFloat = 8  // vertical span of the tail base
    var tailCenterY: CGFloat = 0.5
    var tailTipDY: CGFloat = 0   // tip vertical offset; positive = points SW

    func path(in rect: CGRect) -> Path {
        let r = min(cornerRadius, rect.height / 2 - 1, (rect.width - tailWidth) / 2 - 1)
        let minX = rect.minX + tailWidth   // body's left edge (tail protrudes left of this)
        let maxX = rect.maxX
        let minY = rect.minY
        let maxY = rect.maxY
        // Tail base, clamped onto the straight part of the left edge.
        let minCY = minY + r + tailHeight / 2
        let maxCY = maxY - r - tailHeight / 2
        let cy = min(max(minY + (maxY - minY) * tailCenterY, minCY), max(minCY, maxCY))

        var p = Path()
        p.move(to: CGPoint(x: minX + r, y: minY))                                   // top edge
        p.addLine(to: CGPoint(x: maxX - r, y: minY))
        p.addQuadCurve(to: CGPoint(x: maxX, y: minY + r), control: CGPoint(x: maxX, y: minY)) // TR
        p.addLine(to: CGPoint(x: maxX, y: maxY - r))                                // right edge
        p.addQuadCurve(to: CGPoint(x: maxX - r, y: maxY), control: CGPoint(x: maxX, y: maxY)) // BR
        p.addLine(to: CGPoint(x: minX + r, y: maxY))                                // bottom edge
        p.addQuadCurve(to: CGPoint(x: minX, y: maxY - r), control: CGPoint(x: minX, y: maxY)) // BL
        p.addLine(to: CGPoint(x: minX, y: cy + tailHeight / 2))                     // down to tail base
        p.addLine(to: CGPoint(x: rect.minX, y: cy + tailTipDY))                     // out to the tail tip
        p.addLine(to: CGPoint(x: minX, y: cy - tailHeight / 2))                     // back to the edge
        p.addLine(to: CGPoint(x: minX, y: minY + r))                               // up the left edge
        p.addQuadCurve(to: CGPoint(x: minX + r, y: minY), control: CGPoint(x: minX, y: minY)) // TL
        p.closeSubpath()
        return p
    }
}

/// Report form — the reporter must BOTH pick a reason AND describe what
/// happened (both required). Files to the current server's moderation queue.
struct ReportUserSheet: View {
    let user: PublicUser
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var reason: ReportReason?
    @State private var details = ""
    @State private var submitting = false

    private var canSubmit: Bool {
        reason != nil
            && !details.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !submitting
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    Text("Reports go to this server's moderators. Choose a reason and describe what happened.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)

                    Text("REASON").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    VStack(spacing: 0) {
                        ForEach(ReportReason.allCases) { r in
                            Button { reason = r } label: {
                                HStack {
                                    Text(r.label).font(.zkSans(15)).foregroundColor(Theme.ink1)
                                    Spacer()
                                    Image(systemName: reason == r ? "largecircle.fill.circle" : "circle")
                                        .foregroundColor(reason == r ? Theme.accent : Theme.ink4)
                                }
                                .contentShape(Rectangle())
                                .padding(.horizontal, 12).padding(.vertical, 11)
                            }
                            .buttonStyle(.plain)
                            if r != ReportReason.allCases.last { Divider().overlay(Theme.line) }
                        }
                    }
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                    Text("WHAT HAPPENED?").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    TextField("Describe why you're reporting this user…", text: $details, axis: .vertical)
                        .lineLimit(3...6)
                        .foregroundColor(Theme.ink1)
                        .padding(12).background(Theme.bg2)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                        .onChange(of: details) { _, v in if v.count > 1000 { details = String(v.prefix(1000)) } }
                    Text("\(details.count)/1000").font(.zkSans(11)).foregroundColor(Theme.ink4)

                    Button { submit() } label: {
                        Text(submitting ? "Submitting…" : "Submit Report")
                            .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 13)
                            .background(canSubmit ? Theme.danger : Theme.bg3)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                    .disabled(!canSubmit)
                }
                .padding(18)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Report User").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func submit() {
        guard let reason, canSubmit else { return }
        submitting = true
        Task {
            await store.reportUser(user.id, reason: reason.rawValue,
                                   details: details.trimmingCharacters(in: .whitespacesAndNewlines))
            dismiss()
        }
    }
}

struct ProfileCardView: View {
    let user: PublicUser
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var session: Session
    /// Full profile lazily fetched from GET /users/:id when the card opens —
    /// supplies canMessage (Message/Call gate) plus bio/banner that list-derived
    /// users don't carry. Mirrors the web card's fullProfile fallback.
    @State private var fetched: PublicUser?
    @State private var showReport = false
    @State private var showNicknameEditor = false
    @State private var nicknameDraft = ""
    @State private var nicknameError: String?

    private var isSelf: Bool { user.id == session.currentUser?.id }
    private var relType: String? { store.relationshipType(with: user.id) }
    private var liveStatus: String { store.status(for: user.id) }
    /// Banner height — a single fixed height shared across the profile view,
    /// profile settings, server settings, and the server header banner.
    private var bannerHeight: CGFloat { 250 }
    private var profileBio: String? { user.bio ?? fetched?.bio }
    private var profileBanner: String? { user.bannerUrl ?? fetched?.bannerUrl }
    /// Show the Message/Call pair only when the viewer may reach this user —
    /// mirrors web (`rel !== 'blocked' && (canMessage || rel === 'friend')`).
    private var canShowContact: Bool {
        relType != "blocked" && ((fetched?.canMessage ?? user.canMessage) == true || relType == "friend")
    }

    var body: some View {
        VStack(spacing: 0) {
            // Custom status floats IN the banner (bottom-left, to the right of
            // the avatar) so it never pushes the display name down; its tail
            // points left at the avatar — like the picture is speaking.
            ZStack(alignment: .bottomLeading) {
                Group {
                    if let bannerURL = assetURL(profileBanner) {
                        AsyncImage(url: bannerURL) { phase in
                            if let img = phase.image {
                                img.resizable().aspectRatio(contentMode: .fill)
                            } else {
                                LinearGradient(
                                    colors: [Theme.accent.opacity(0.55), Theme.accent2.opacity(0.45)],
                                    startPoint: .leading, endPoint: .trailing
                                )
                            }
                        }
                    } else {
                        LinearGradient(
                            colors: [Theme.accent.opacity(0.55), Theme.accent2.opacity(0.45)],
                            startPoint: .leading, endPoint: .trailing
                        )
                    }
                }
                .frame(height: bannerHeight)
                .frame(maxWidth: .infinity)
                .clipped()

                customStatusBubble
                    .padding(.leading, 92)
                    .padding(.bottom, 10)
            }

            // Avatar straddles the banner's bottom edge — half over the
            // banner, half below — with name + username to its right.
            // Outside the ScrollView so the overhang isn't clipped.
            HStack(alignment: .top, spacing: 12) {
                Avatar(url: user.avatarUrl, name: user.name, size: 76,
                       status: liveStatus, ringColor: Theme.bg1, decoration: user.avatarDecoration)
                    .padding(.top, -38)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 5) {
                        NameTag(user)
                        StaffName(fetched ?? user,
                                  text: user.displayName ?? user.username ?? "Unknown",
                                  color: store.memberColor(user.id) ?? Theme.ink1,
                                  font: .zkSans(21, weight: .bold))
                        if user.isBot == true {
                            Text("BOT")
                                .font(.zkSans(10, weight: .bold))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.accent.opacity(0.2))
                                .foregroundColor(Theme.accent)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        // Supporter tier title — ships on the full-profile
                        // fetch (nil when opted out or not a member).
                        TierBadge(tier: fetched?.subscriptionTier ?? user.subscriptionTier)
                    }
                    if let uname = user.username {
                        Text("@\(uname)")
                            .font(.zkSans(14))
                            .foregroundColor(Theme.ink3)
                    }
                }
                .padding(.top, 6)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)

            ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                // Bio first…
                if let bio = profileBio, !bio.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("ABOUT ME")
                            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        Text(bio)
                            .font(.zkSans(14)).foregroundColor(Theme.ink2)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                // …then EARNED achievements only (the Settings gallery shows all).
                AchievementsSection(userId: user.id, earnedOnly: true)

                // Message / Call / friend actions — only for OTHER users. Your
                // own card just shows your profile (no "this is you" filler).
                if !isSelf {
                    Rectangle().fill(Theme.line).frame(height: 1)
                    actions
                }

                if store.canManageRoles && !store.roles.isEmpty && store.members[user.id] != nil {
                    rolesSection
                }

                Spacer(minLength: 0)
            }
            .padding(18)
            }
        }
        .background(Theme.bg1)
        .modifier(ProfileCardPresentation())
        .task(id: user.id) {
            // Refresh relationships so the friend button reflects the CURRENT
            // status — the in-memory list is only loaded on the DMs/friends
            // screen, so opening a guild member's card cold otherwise showed
            // "Add Friend" for someone you're already friends with (web fetches
            // relationships on card-open for the same reason).
            if !isSelf { await store.loadRelationships() }
            // Full profile for canMessage + bio/banner the list user may omit
            // (mirrors web's on-open fetch). On failure it stays nil → non-friends
            // see no contact buttons, same as web's fetch-fail behavior.
            fetched = try? await APIClient.shared.getUserProfile(userId: user.id)
        }
        .sheet(isPresented: $showReport) {
            ReportUserSheet(user: user).environmentObject(store)
        }
        .sheet(isPresented: $showNicknameEditor) {
            NavigationStack {
                VStack(alignment: .leading, spacing: 14) {
                    Text("A nickname only you see, shown in place of \(user.name)'s name in direct messages.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        .fixedSize(horizontal: false, vertical: true)
                    TextField("Nickname", text: $nicknameDraft)
                        .textInputAutocapitalization(.words)
                        .font(.zkSans(16)).foregroundColor(Theme.ink1)
                        .padding(.horizontal, 12).padding(.vertical, 10)
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.line, lineWidth: 1))
                        .onChange(of: nicknameDraft) { _, v in
                            if v.count > 32 { nicknameDraft = String(v.prefix(32)) }
                        }
                    if let nicknameError {
                        Text(nicknameError).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
                    }
                    HStack(spacing: 10) {
                        Button {
                            Task {
                                if let err = await store.setDmNickname(userId: user.id, to: nicknameDraft) {
                                    nicknameError = err
                                } else {
                                    showNicknameEditor = false
                                }
                            }
                        } label: {
                            Text("Save").font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                                .frame(maxWidth: .infinity).padding(.vertical, 11)
                                .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        if store.dmNickname(user.id) != nil {
                            Button {
                                Task {
                                    _ = await store.setDmNickname(userId: user.id, to: nil)
                                    showNicknameEditor = false
                                }
                            } label: {
                                Text("Remove").font(.zkSans(15, weight: .medium)).foregroundColor(Theme.danger)
                                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                                    .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                        }
                    }
                    Spacer()
                }
                .padding(18)
                .background(Theme.bg1.ignoresSafeArea())
                .navigationTitle("Nickname")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { showNicknameEditor = false }
                    }
                }
            }
            .presentationDetents([.height(260)])
        }
    }

    /// Custom status as a speech bubble floating in the banner (to the right of
    /// the avatar), its tail on the LEFT edge pointing back at the avatar — like
    /// the picture is saying it. Empty / expired → nothing.
    @ViewBuilder
    private var customStatusBubble: some View {
        let emoji = user.customStatusEmoji?.trimmingCharacters(in: .whitespaces) ?? ""
        let text = user.customStatus?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // Treat a past expiry as cleared, like web's formatCustomStatus — the
        // server leaves expired statuses on the row for the client to hide.
        let exp = user.customStatusExpiresAt
        let expired = (exp?.isEmpty == false) && !customStatusHasFutureExpiry(exp)
        if !expired, !emoji.isEmpty || !text.isEmpty {
            let shape = SpeechBubbleLeft(tailTipDY: 8) // points SW (down-left) toward the avatar
            HStack(spacing: 5) {
                if !emoji.isEmpty { Text(emoji).font(.zkSans(13)) }
                if !text.isEmpty {
                    Text(text)
                        .font(.zkSans(12, weight: .medium)).foregroundColor(Theme.ink1)
                        .lineLimit(2)
                }
            }
            .padding(.leading, 11 + 8) // extra leading room for the 8pt left tail
            .padding(.trailing, 11)
            .padding(.vertical, 6)
            .background(shape.fill(Theme.bg3))
            .overlay(shape.stroke(Theme.line, lineWidth: 1))
            .shadow(color: .black.opacity(0.28), radius: 5, x: 0, y: 2)
        }
    }

    @ViewBuilder
    private var actions: some View {
        VStack(spacing: 10) {
            // Message + Call only when the viewer can reach this user (gated
            // like web — see canShowContact).
            if canShowContact {
                HStack(spacing: 10) {
                    Button { message() } label: {
                        Label("Message", systemImage: "bubble.left.fill")
                            .font(.zkSans(15, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Theme.accent)
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }

                    Button { call() } label: {
                        Label("Call", systemImage: "phone.fill")
                            .font(.zkSans(15, weight: .semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 11)
                            .background(Theme.accent)
                            .foregroundColor(.white)
                            .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                }
            }

            friendButton

            // Personal DM nickname — a label only you see, shown in direct
            // messages. Available for any other (non-bot) user.
            if !isSelf && user.isBot != true {
                secondaryButton(
                    store.dmNickname(user.id) != nil ? "Edit Nickname" : "Set Nickname",
                    icon: "pencil"
                ) {
                    nicknameDraft = store.dmNickname(user.id) ?? ""
                    nicknameError = nil
                    showNicknameEditor = true
                }
            }

            Button { toggleBlock() } label: {
                Label(relType == "blocked" ? "Unblock" : "Block",
                      systemImage: relType == "blocked" ? "hand.raised.slash" : "nosign")
                    .font(.zkSans(15, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Theme.bg3)
                    .foregroundColor(Theme.danger)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }

            // Report — only for a member of the CURRENT server (not DMs/friends).
            // Opens a form to pick a reason + describe what happened.
            if store.members[user.id] != nil && relType != "friend" {
                Button { showReport = true } label: {
                    Label("Report User", systemImage: "flag")
                        .font(.zkSans(15, weight: .medium))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Theme.bg3)
                        .foregroundColor(Theme.danger)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .buttonStyle(.plain)
            }
        }
    }

    @ViewBuilder
    private var friendButton: some View {
        switch relType {
        case .some("outgoing_request"):
            secondaryButton("Cancel Friend Request", icon: "xmark") {
                Task { await store.removeFriend(user) }
            }
        case .some("incoming_request"):
            secondaryButton("Accept Friend Request", icon: "person.badge.plus") {
                Task { await store.acceptFriend(user) }
            }
        case .some("friend"):
            secondaryButton("Remove Friend", icon: "person.badge.minus") {
                Task { await store.removeFriend(user) }
            }
        case .some("blocked"):
            EmptyView()
        default:
            secondaryButton("Add Friend", icon: "person.badge.plus") {
                Task { _ = await store.addFriend(username: user.username ?? user.name) }
            }
        }
    }

    private func secondaryButton(_ title: String, icon: String,
                                 disabled: Bool = false,
                                 _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.zkSans(15, weight: .medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(Theme.bg3)
                .foregroundColor(disabled ? Theme.ink3 : Theme.ink1)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .disabled(disabled)
    }

    private func message() {
        Task {
            guard let ch = await store.startDM(with: user) else { return }
            store.profileUser = nil
            store.showMembers = false
            store.push(.messages(ch))
        }
    }

    private func call() {
        Task {
            guard let ch = await store.startDM(with: user) else { return }
            store.profileUser = nil
            store.showMembers = false
            store.openVoice(ch)
        }
    }

    private var assignableRoles: [Role] {
        store.roles
            .filter { $0.id != store.selectedGuild?.id }
            .sorted { $0.position > $1.position }
    }

    @ViewBuilder
    private var rolesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ROLES").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            ForEach(assignableRoles) { role in
                Button {
                    Task { await store.toggleMemberRole(user.id, role: role) }
                } label: {
                    HStack(spacing: 8) {
                        Circle().fill(store.roleColor(role) ?? Theme.ink4).frame(width: 12, height: 12)
                        Text(role.name).font(.zkSans(14)).foregroundColor(Theme.ink1)
                        Spacer()
                        Image(systemName: store.memberHasRole(user.id, role.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundColor(store.memberHasRole(user.id, role.id) ? Theme.accent : Theme.ink4)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func toggleBlock() {
        Task {
            if relType == "blocked" { await store.unblockUser(user) }
            else { await store.blockUser(user) }
        }
    }
}

// MARK: - Member list

/// Guild member roster (flat, sorted by display name). Tapping a member
/// opens their ProfileCard. Role-hoisted sections are deferred until
/// roles are modeled.
struct MemberListView: View {
    @EnvironmentObject private var store: AppStore
    // Held so it can be forwarded to the ProfileCardView sheet below — on
    // "Designed for iPad on Mac", SwiftUI's sheet presentation host does not
    // inherit environment objects, so they must be re-injected explicitly.
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var selectedProfile: PublicUser?
    @State private var reportTarget: PublicUser?

    private struct MemberSection: Identifiable {
        let id: String
        let label: String
        let color: Color?
        var members: [GuildMember]
    }

    /// Memoized sections + the input stamp they were computed from. The view
    /// body re-evaluates on EVERY AppStore publish (presence churn included),
    /// but the sections only actually change when members/roles change
    /// (mentionContextVersion) or presence flushes (presenceVersion). Recompute
    /// only when that stamp moves — otherwise reuse the cached sort.
    @State private var cachedSections: [MemberSection] = []
    @State private var sectionsStamp: Int = -1

    private var sectionsInputStamp: Int {
        // Combine the two cheap monotonic counters into one key.
        store.mentionContextVersion &* 0x9E3779B1 &+ store.presenceVersion
    }

    private func refreshSectionsIfNeeded() {
        let stamp = sectionsInputStamp
        guard stamp != sectionsStamp else { return }
        sectionsStamp = stamp
        cachedSections = computeSections()
    }

    /// Discord-style hoisted sections (matches the web MemberList): one
    /// section per hoisted role, members under their highest hoisted role,
    /// an "Online" bucket for the rest, and a separate "Offline" bucket.
    private func computeSections() -> [MemberSection] {
        let allMembers = Array(store.members.values)
        let hoisted = store.roles.filter { $0.hoist }.sorted { $0.position < $1.position }
        var roleIdx: [String: Int] = [:]
        for (i, r) in hoisted.enumerated() { roleIdx[r.id] = i }

        var buckets: [MemberSection] = hoisted.map {
            MemberSection(id: "role:\($0.id)", label: $0.name, color: store.roleColor($0), members: [])
        }
        var online = MemberSection(id: "online", label: "Online", color: nil, members: [])
        var offline = MemberSection(id: "offline", label: "Offline", color: nil, members: [])

        for m in allMembers {
            let st = store.status(for: m.userId)
            if st == "offline" || st == "invisible" { offline.members.append(m); continue }
            var bestIdx = -1
            for rid in (m.roleIds ?? []) {
                if let idx = roleIdx[rid], bestIdx == -1 || idx < bestIdx { bestIdx = idx }
            }
            if bestIdx == -1 { online.members.append(m) } else { buckets[bestIdx].members.append(m) }
        }

        func byName(_ a: GuildMember, _ b: GuildMember) -> Bool {
            a.user.name.localizedCaseInsensitiveCompare(b.user.name) == .orderedAscending
        }
        for i in buckets.indices { buckets[i].members.sort(by: byName) }
        online.members.sort(by: byName)
        offline.members.sort(by: byName)

        var out = buckets.filter { !$0.members.isEmpty }
        if !online.members.isEmpty { out.append(online) }
        if !offline.members.isEmpty { out.append(offline) }
        return out
    }

    var body: some View {
        NavigationStack {
            Group {
                if store.members.isEmpty {
                    VStack(spacing: 10) {
                        ProgressView().tint(Theme.accent)
                        Text("Loading members…")
                            .font(.zkSans(13))
                            .foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(cachedSections) { section in
                                sectionHeader(section)
                                ForEach(section.members) { m in
                                    Button { selectedProfile = m.user } label: {
                                        memberRow(m)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1)
            // Recompute the hoisted sections only when their real inputs move
            // (members/roles or a presence flush), not on every AppStore publish.
            .onAppear { refreshSectionsIfNeeded() }
            .onChange(of: sectionsInputStamp) { _, _ in refreshSectionsIfNeeded() }
            .navigationTitle("Members — \(store.members.count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    // Every presentation is now a sheet (channel list, text
                    // channel, thread, wide, guild-settings): a leading "<"
                    // closes it. dismiss() handles the sheet; clearing
                    // showMembers covers the store-driven presentations.
                    Button { dismiss(); store.showMembers = false } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 18, weight: .semibold))
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close members")
                }
            }
        }
        .fullScreenCover(item: $selectedProfile) { u in
            // Profile is its own full-screen PAGE with the standard "<" back
            // chevron (matches the profileUser presenter in MainView). Re-inject
            // env objects for the Mac cover host (ProfileCardView reads both).
            NavigationStack {
                ProfileCardView(user: u)
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button { selectedProfile = nil } label: {
                                Image(systemName: "chevron.left")
                                    .font(.system(size: 20, weight: .semibold))
                                    .foregroundColor(Theme.ink2)
                                    .frame(width: 44, height: 44)
                                    .contentShape(Rectangle())
                            }
                            .accessibilityLabel("Back")
                        }
                    }
            }
            .environmentObject(store)
            .environmentObject(session)
            .environmentObject(store.voice)
        }
        .sheet(item: $reportTarget) { u in
            ReportUserSheet(user: u).environmentObject(store)
        }
    }

    private func sectionHeader(_ s: MemberSection) -> some View {
        Text("\(s.label.uppercased()) — \(s.members.count)")
            .font(.zkSans(11, weight: .semibold))
            .foregroundColor(s.color ?? Theme.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 4)
    }

    private func memberRow(_ m: GuildMember) -> some View {
        HStack(spacing: 10) {
            Avatar(url: m.user.avatarUrl, name: m.user.name, size: 32,
                   status: store.status(for: m.userId),
                   ringColor: Theme.bg1, decoration: m.user.avatarDecoration)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 4) {
                    NameTag(m.user)
                    StaffName(m.user,
                              text: m.user.name,
                              color: store.memberColor(m.userId) ?? Theme.ink1,
                              font: .zkSans(15, weight: .medium))
                }
            }
            Spacer()
            if m.user.isBot == true {
                Text("BOT")
                    .font(.zkSans(9, weight: .bold))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Theme.accent.opacity(0.2))
                    .foregroundColor(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .contextMenu {
            Button { store.openProfile(m.user) } label: {
                Label("View Profile", systemImage: "person.crop.circle")
            }
            if m.userId != store.currentUserId {
                // Report another member (this is a guild member list — a server
                // context). Not offered for friends. Opens a form to pick a
                // reason + describe what happened; surfaces to mods in guild
                // settings → Reports.
                if store.relationshipType(with: m.userId) != "friend" {
                    Button { reportTarget = m.user } label: {
                        Label("Report User", systemImage: "flag")
                    }
                }
                if store.canModerateMembers {
                    Menu {
                        Button { Task { await store.timeoutMember(m.userId, minutes: 5) } } label: { Text("5 minutes") }
                        Button { Task { await store.timeoutMember(m.userId, minutes: 60) } } label: { Text("1 hour") }
                        Button { Task { await store.timeoutMember(m.userId, minutes: 1440) } } label: { Text("1 day") }
                        Button { Task { await store.timeoutMember(m.userId, minutes: 10080) } } label: { Text("1 week") }
                        Divider()
                        Button { Task { await store.timeoutMember(m.userId, minutes: 0) } } label: { Text("Remove timeout") }
                    } label: { Label("Timeout", systemImage: "clock") }
                }
                if store.canKickMembers {
                    Button(role: .destructive) { Task { await store.kickMember(m.userId) } } label: {
                        Label("Kick", systemImage: "person.fill.xmark")
                    }
                }
                if store.canBanMembers {
                    Button(role: .destructive) { Task { await store.banMember(m.userId) } } label: {
                        Label("Ban", systemImage: "hammer.fill")
                    }
                }
            }
        }
    }
}

// MARK: - Pin panel

/// Lists a channel's pinned messages (newest first). Each row can be
/// unpinned in place. Mirrors the web PinPanel.
struct PinPanelView: View {
    let channel: Channel
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.loadingPins && store.pins.isEmpty {
                    VStack(spacing: 10) {
                        ProgressView().tint(Theme.accent)
                        Text("Loading pins…")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if store.pins.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "pin")
                            .font(.system(size: 30, weight: .light))
                            .foregroundColor(Theme.ink3)
                        Text("No pinned messages yet")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.pins) { m in
                                pinRow(m)
                                Rectangle().fill(Theme.line).frame(height: 1)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1)
            .navigationTitle("Pinned Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Close")
                }
            }
        }
    }

    private func pinRow(_ m: Message) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(url: m.author?.avatarUrl, name: m.author?.name ?? "?",
                   size: 32, ringColor: Theme.bg1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(m.author?.name ?? "Unknown")
                        .font(.zkSans(14, weight: .semibold))
                        .foregroundColor(Theme.ink1)
                    Text(shortTime(m.createdAt))
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink3)
                }
                Text(pinText(m))
                    .font(.zkSans(14))
                    .foregroundColor(Theme.ink2)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Button { Task { await store.togglePin(m) } } label: {
                Image(systemName: "pin.slash")
                    .font(.system(size: 14))
                    .foregroundColor(Theme.ink3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func pinText(_ m: Message) -> String {
        switch store.display(for: m, in: channel) {
        case .text(let t):
            if !t.isEmpty { return t }
            if m.sticker != nil { return "🏷️ Sticker" }
            if m.attachments?.contains(where: { $0.isVoiceMessage == true }) == true { return "🎤 Voice message" }
            if m.attachments?.isEmpty == false { return "📎 Attachment" }
            if m.poll != nil { return "📊 Poll" }
            return "Message"
        case .locked, .undecryptable:
            return "🔒 Encrypted message"
        }
    }
}

// MARK: - Image lightbox

/// Full-screen image viewer: pinch to zoom, drag to pan when zoomed,
/// double-tap to toggle zoom, tap ✕ to close. Mirrors the web ImageLightbox.
struct ImageLightboxView: View {
    let item: LightboxImage
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var index: Int
    @State private var savedFlash = false

    init(item: LightboxImage) {
        self.item = item
        _index = State(initialValue: item.startIndex)
    }

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // Paged: swipe left/right between a message's images. Each page
            // owns its own zoom/pan state (LightboxPage) so zoom doesn't leak
            // across swipes.
            TabView(selection: $index) {
                ForEach(Array(item.items.enumerated()), id: \.offset) { i, it in
                    LightboxPage(item: it).tag(i)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .never))
            .ignoresSafeArea()

            // Left/right paging arrows for a multi-image group (web parity:
            // the web lightbox has ‹ › + arrow keys). Swipe still works — these
            // are just the explicit affordance. Dimmed + disabled at the ends.
            if item.items.count > 1 {
                HStack {
                    navButton("chevron.left") {
                        withAnimation { index = max(0, index - 1) }
                    }
                    .opacity(index > 0 ? 1 : 0.3)
                    .disabled(index == 0)
                    Spacer()
                    navButton("chevron.right") {
                        withAnimation { index = min(item.items.count - 1, index + 1) }
                    }
                    .opacity(index < item.items.count - 1 ? 1 : 0.3)
                    .disabled(index == item.items.count - 1)
                }
                .padding(.horizontal, 12)
            }

            VStack {
                HStack {
                    if item.items.count > 1 {
                        Text("\(index + 1) / \(item.items.count)")
                            .font(.zkSans(13, weight: .medium))
                            .foregroundColor(.white)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 6)
                            .background(Color.white.opacity(0.18))
                            .clipShape(Capsule())
                    }
                    Spacer()
                    // Save the current image to Photos (decrypted bytes for an
                    // E2EE item — never the ciphertext).
                    Button { saveCurrent() } label: {
                        Image(systemName: savedFlash ? "checkmark" : "square.and.arrow.down")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(10)
                            .background(Color.white.opacity(0.18))
                            .clipShape(Circle())
                    }
                    .disabled(savedFlash)
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(10)
                            .background(Color.white.opacity(0.18))
                            .clipShape(Circle())
                    }
                }
                Spacer()
            }
            .padding(16)
        }
    }

    /// Save the currently-shown image to the Photos library. Uses the in-memory
    /// UIImage when present (decrypted E2EE pages already hold it); otherwise
    /// loads the plain image by URL. Briefly flips the icon to a checkmark.
    private func saveCurrent() {
        guard index >= 0, index < item.items.count else { return }
        let it = item.items[index]
        Task {
            let ok: Bool
            if let img = it.image {
                // Decrypted E2EE page already in memory.
                ok = await PhotoSaver.save(img)
            } else if let (att, channel) = it.encrypted,
                      let data = await store.decryptedAttachmentData(att, in: channel) {
                // Lazy E2EE page — decrypt the full blob and save those bytes
                // (never the ciphertext). The session cache makes this cheap if
                // the page already decrypted for display.
                ok = await PhotoSaver.save(data: data)
            } else if let url = it.url, let data = await RetryingImage.loadData(url) {
                // Plain image — save the ORIGINAL bytes (preserves format/quality).
                ok = await PhotoSaver.save(data: data)
            } else {
                ok = false
            }
            guard ok else { return }
            savedFlash = true
            try? await Task.sleep(nanoseconds: 1_200_000_000)
            savedFlash = false
        }
    }

    /// A circular translucent paging arrow, matching the close button's style.
    private func navButton(_ system: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: system)
                .font(.system(size: 20, weight: .semibold))
                .foregroundColor(.white)
                .padding(12)
                .background(Color.white.opacity(0.18))
                .clipShape(Circle())
        }
    }
}

/// One zoom/pannable page in the lightbox.
private struct LightboxPage: View {
    let item: LightboxItem
    @EnvironmentObject private var store: AppStore
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero
    // Full-res image decrypted on-appear for a LAZY encrypted item (gallery
    // lightbox). Only the visible/adjacent pages of the paged TabView build,
    // so only those decrypt — not the whole loaded photo set.
    @State private var resolved: UIImage?
    /// The decrypt or the decode failed. Without this, the encrypted branch spun
    /// a `ProgressView` FOREVER on failure — `resolved` never becomes non-nil.
    @State private var decryptFailed = false

    var body: some View {
        // E2EE images arrive as a LAZY encrypted reference, decrypted on-appear;
        // plain attachments load by URL. Both get the same zoom/pan.
        if item.encrypted != nil {
            // `resolved` (full-res) wins once decoded. `item.image` is the
            // already-decrypted inline THUMBNAIL: shown instantly so the viewer is
            // never blank, and it remains the fallback if the full decrypt fails.
            Group {
                if let image = resolved ?? item.image {
                    zoomable(Image(uiImage: image).resizable().scaledToFit())
                } else if decryptFailed {
                    Image(systemName: "lock.trianglebadge.exclamationmark")
                        .font(.system(size: 28))
                        .foregroundColor(.white)
                } else {
                    ProgressView().tint(.white)
                }
            }
            .task {
                guard resolved == nil, let (att, channel) = item.encrypted else { return }
                // Prefer the full blob (lightbox is full-resolution); decode
                // OFF the main actor with a generous cap so zoom stays sharp
                // while a bare main-thread UIImage(data:) on a multi-MB JPEG
                // never blocks the swipe. Mirrors GalleryThumb's on-appear.
                guard let data = await store.decryptedAttachmentData(att, in: channel) else {
                    decryptFailed = true
                    return
                }
                let decoded = await Task.detached(priority: .userInitiated) {
                    ImageDownsampler.decode(data, maxPixels: 2048)
                }.value
                if let decoded { resolved = decoded } else { decryptFailed = true }
            }
        } else if let image = item.image {
            zoomable(Image(uiImage: image).resizable().scaledToFit())
        } else if let url = item.url {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    zoomable(image.resizable().scaledToFit())
                case .empty:
                    ProgressView().tint(.white)
                default:
                    Image(systemName: "exclamationmark.triangle")
                        .font(.system(size: 28))
                        .foregroundColor(.white)
                }
            }
        }
    }

    /// Pinch-zoom, drag-pan (only when zoomed), and double-tap-to-toggle.
    @ViewBuilder
    private func zoomable<V: View>(_ content: V) -> some View {
        // Pinch + double-tap are always available. Pinch is a two-finger
        // gesture and double-tap is a tap, so neither competes with the
        // parent TabView's one-finger horizontal page swipe.
        let base = content
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnificationGesture()
                    .onChanged { value in scale = max(1, lastScale * value) }
                    .onEnded { _ in
                        lastScale = scale
                        if scale <= 1 {
                            withAnimation { offset = .zero; lastOffset = .zero }
                        }
                    }
            )
            .onTapGesture(count: 2) {
                withAnimation {
                    if scale > 1 {
                        scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero
                    } else {
                        scale = 2.5; lastScale = 2.5
                    }
                }
            }

        // Pan is a one-finger DragGesture, which DOES compete with the paging
        // TabView. Attach it ONLY while zoomed in — at scale 1 there's nothing
        // to pan, and leaving it attached made SwiftUI's gesture arbitration
        // give the inner drag priority over the TabView, swallowing the
        // left/right swipe-to-page entirely (an always-on `.simultaneousGesture`
        // still claims the touch even when its handler early-returns). Removing
        // it at rest lets the TabView own the horizontal drag, so swipe pages
        // between images — matching the ‹ › buttons.
        if scale > 1 {
            base.simultaneousGesture(
                DragGesture()
                    .onChanged { value in
                        offset = CGSize(
                            width: lastOffset.width + value.translation.width,
                            height: lastOffset.height + value.translation.height
                        )
                    }
                    .onEnded { _ in lastOffset = offset }
            )
        } else {
            base
        }
    }
}

/// Decrypting square thumbnail for an encrypted photo in the media grid.
private struct EncryptedThumb: View {
    let store: AppStore
    let attachment: Attachment
    let channel: Channel
    /// Fed from the row's MessageRowData so the decrypt task re-runs on E2EE
    /// unlock without this view observing the store.
    let e2eeUnlockVersion: Int
    let onTap: () -> Void
    @State private var image: UIImage?

    var body: some View {
        Rectangle()
            .fill(Theme.bg3)
            .aspectRatio(1, contentMode: .fit)
            .overlay(
                Group {
                    if let image {
                        Image(uiImage: image).resizable().scaledToFill()
                    } else {
                        Image(systemName: "lock.doc")
                            .font(.system(size: 18))
                            .foregroundColor(Theme.accent)
                    }
                }
            )
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
            .onTapGesture { if image != nil { onTap() } }
            .task(id: e2eeUnlockVersion) {
                guard image == nil else { return }
                // Decoded-thumb cache: on scroll-back paint instantly, skipping
                // both the byte fetch and the ImageIO re-decode.
                if let cached = EncryptedThumbCache.image(attachment.id, 400) { image = cached; return }
                // Prefer the small encrypted thumbnail (tiny download + decrypt);
                // fall back to the full blob for old messages without one — but
                // never once retention expired that blob (the fetch would 404
                // and the decrypt fail; the thumbnail is kept forever).
                var data = await store.decryptedThumbnailData(attachment, in: channel)
                if data == nil, !attachment.blobExpired {
                    data = await store.decryptedAttachmentData(attachment, in: channel)
                }
                if let data {
                    let decoded = await Task.detached(priority: .userInitiated) {
                        ImageDownsampler.decode(data, maxPixels: 400)
                    }.value
                    if let decoded { EncryptedThumbCache.store(decoded, attachment.id, 400) }
                    image = decoded
                }
            }
    }
}

/// "Save all to Photos" for a multi-media message. Keeps its own status so it
/// gives feedback (Saving… → Saved N) without app-wide toast plumbing.
private struct SaveAllButton: View {
    let store: AppStore
    let media: [Attachment]
    let channel: Channel
    @State private var label = "Save all to Photos"
    @State private var busy = false

    var body: some View {
        Button {
            guard !busy else { return }
            busy = true
            label = "Saving…"
            Task {
                let n = await store.saveMediaToPhotos(media, in: channel)
                await MainActor.run {
                    label = n > 0 ? "Saved \(n) to Photos" : "Couldn't save"
                    busy = false
                }
            }
        } label: {
            Label(label, systemImage: "square.and.arrow.down")
                .font(.zkSans(12, weight: .medium))
                .foregroundColor(Theme.accent)
                .padding(.vertical, 2)
        }
        .buttonStyle(.plain)
        .disabled(busy)
    }
}

// MARK: - Forward sheet

/// Pick a destination to forward a message to (current server's text
/// channels + your DMs). Mirrors the web ForwardModal.
struct ForwardSheet: View {
    let message: Message
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    private var textChannels: [Channel] {
        store.channels.filter { $0.isText }.sorted { ($0.position ?? 0) < ($1.position ?? 0) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !textChannels.isEmpty {
                        sectionLabel(store.selectedGuild?.name ?? "Server")
                        ForEach(textChannels) { ch in
                            targetRow(symbol: "number", name: ch.name ?? "channel") {
                                Task { await store.forwardMessage(message, to: ch); dismiss() }
                            }
                        }
                    }
                    if !store.dms.isEmpty {
                        sectionLabel("Direct Messages")
                        ForEach(store.dms) { dm in
                            targetRow(symbol: "at", name: dm.dmTitle) {
                                Task { await store.forwardMessage(message, to: dm); dismiss() }
                            }
                        }
                    }
                    if textChannels.isEmpty && store.dms.isEmpty {
                        Text("No channels to forward to.")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding(.vertical, 6)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Forward to…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func sectionLabel(_ t: String) -> some View {
        Text(t.uppercased())
            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
    }
    private func targetRow(symbol: String, name: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 14)).foregroundColor(Theme.ink3).frame(width: 18)
                Text(name).font(.system(size: 15)).foregroundColor(Theme.ink1).lineLimit(1)
                Spacer()
                Image(systemName: "arrowshape.turn.up.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
            }
            .padding(.horizontal, 16).padding(.vertical, 10).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Saved messages

/// Your bookmarked messages, newest first. Mirrors the web SavedView.
struct SavedView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.loadingSaved && store.saved.isEmpty {
                    VStack(spacing: 10) {
                        ProgressView().tint(Theme.accent)
                        Text("Loading…").font(.zkSans(13)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if store.saved.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "bookmark")
                            .font(.system(size: 30, weight: .light)).foregroundColor(Theme.ink3)
                        Text("No saved messages").font(.zkSans(14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.saved) { item in
                                savedRow(item)
                                Rectangle().fill(Theme.line).frame(height: 1)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                // Opaque base -> abyss nebula -> 90% column wash (web bg-1/90).
                ZStack { Theme.bg1; AbyssBackground(); Theme.bg1.opacity(0.9) }.ignoresSafeArea()
            }
            .navigationTitle("Saved Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { PageBackButton() }
            }
        }
        .task { await store.loadSaved() }
    }

    private func savedRow(_ item: SavedMessageItem) -> some View {
        let m = item.message
        return HStack(alignment: .top, spacing: 10) {
            Avatar(url: m.author?.avatarUrl, name: m.author?.name ?? "?", size: 32, ringColor: Theme.bg1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(m.author?.name ?? "Unknown")
                        .font(.zkSans(14, weight: .semibold)).foregroundColor(Theme.ink1)
                    if let cn = item.channel?.name {
                        Text("#\(cn)").font(.zkSans(11)).foregroundColor(Theme.ink3).lineLimit(1)
                    }
                    Text(shortTime(m.createdAt)).font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
                Text(savedText(m))
                    .font(.zkSans(14)).foregroundColor(Theme.ink2)
                    .lineLimit(5).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Button { Task { await store.toggleSave(m) } } label: {
                Image(systemName: "bookmark.slash").font(.system(size: 14)).foregroundColor(Theme.ink3)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private func savedText(_ m: Message) -> String {
        if E2EE.isEncrypted(m.text) { return "🔒 Encrypted message" }
        if m.text.isEmpty {
            if m.sticker != nil { return "🏷️ Sticker" }
            if m.attachments?.contains(where: { $0.isVoiceMessage == true }) == true { return "🎤 Voice message" }
            if m.attachments?.isEmpty == false { return "📎 Attachment" }
            if m.poll != nil { return "📊 Poll" }
            if let fwd = m.forwardedFrom { return "↪︎ \(fwd.content)" }
            return "Message"
        }
        return m.text
    }
}

// MARK: - Emoji + sticker picker

/// A two-tab picker: custom emoji (inserts `:name:` into the draft) and
/// stickers (sends immediately). Mirrors the web emoji/sticker picker.
struct EmojiStickerPicker: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Binding var draft: String
    @State private var tab = 0
    private let cols = [GridItem(.adaptive(minimum: 64), spacing: 10)]
    private let stickerCols = [GridItem(.adaptive(minimum: 84), spacing: 10)]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $tab) {
                    Text("Emoji").tag(0)
                    Text("Stickers").tag(1)
                }
                .pickerStyle(.segmented)
                .padding(12)

                if tab == 0 { emojiGrid } else { stickerGrid }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(tab == 0 ? "Emoji" : "Stickers").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Close") } }
            .task { await store.loadEmojis(); await store.loadStickers() }
        }
    }

    private var emojiGrid: some View {
        ScrollView {
            if store.guildEmojis.isEmpty {
                emptyState("face.dashed", "No custom emoji in this server.")
            } else {
                LazyVGrid(columns: cols, spacing: 10) {
                    ForEach(store.guildEmojis) { e in
                        Button {
                            draft += draft.isEmpty || draft.hasSuffix(" ") ? ":\(e.name):" : " :\(e.name):"
                        } label: {
                            AsyncImage(url: assetURL(e.url)) { phase in
                                switch phase {
                                case .success(let image): image.resizable().scaledToFit()
                                case .empty: ProgressView()
                                default: Image(systemName: "photo").foregroundColor(Theme.ink3)
                                }
                            }
                            .frame(width: 40, height: 40)
                            .frame(width: 56, height: 56)
                            .background(Theme.bg2)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
        }
    }

    private var stickerGrid: some View {
        ScrollView {
            if store.guildStickers.isEmpty {
                emptyState("face.dashed", "No stickers in this server.")
            } else {
                LazyVGrid(columns: stickerCols, spacing: 10) {
                    ForEach(store.guildStickers) { s in
                        Button {
                            Task { await store.sendSticker(s) }
                            dismiss()
                        } label: {
                            VStack(spacing: 4) {
                                AsyncImage(url: assetURL(s.url)) { phase in
                                    switch phase {
                                    case .success(let image): image.resizable().scaledToFit()
                                    case .empty: ProgressView()
                                    default: Image(systemName: "photo").foregroundColor(Theme.ink3)
                                    }
                                }
                                .frame(width: 72, height: 72)
                                Text(s.name).font(.zkSans(10)).foregroundColor(Theme.ink3).lineLimit(1)
                            }
                            .frame(width: 84, height: 96)
                            .background(Theme.bg2)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
        }
    }

    private func emptyState(_ icon: String, _ text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 30)).foregroundColor(Theme.ink3)
            Text(text).font(.system(size: 14)).foregroundColor(Theme.ink3)
        }
        .frame(maxWidth: .infinity).padding(.top, 50)
    }
}

// MARK: - Schedule message

/// Schedule the current draft for future delivery, and manage the pending
/// queue. Mirrors the web SchedulePickerModal + ScheduledMessagesView.
struct ScheduleSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Binding var draft: String

    @State private var date = Date().addingTimeInterval(3600)
    @State private var busy = false
    @State private var error: String?

    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if trimmedDraft.isEmpty {
                        Text("Type a message in the composer first, then schedule it for later.")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("SCHEDULE MESSAGE").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            Text(draft)
                                .font(.zkSans(14)).foregroundColor(Theme.ink1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                            DatePicker("Send at", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                                .foregroundColor(Theme.ink1).tint(Theme.accent)
                            Button { schedule() } label: {
                                Text(busy ? "Scheduling…" : "Schedule")
                                    .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                                    .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .disabled(busy)
                            if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
                        }
                    }

                    Divider().overlay(Theme.line)

                    Text("PENDING").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if store.loadingScheduled && store.scheduledMessages.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 8)
                    } else if store.scheduledMessages.isEmpty {
                        Text("No scheduled messages.").font(.zkSans(13)).foregroundColor(Theme.ink4)
                    } else {
                        ForEach(store.scheduledMessages) { sm in scheduledRow(sm) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Scheduled").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Close") } }
            .task { await store.loadScheduled() }
        }
    }

    private func scheduledRow(_ sm: ScheduledMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(store.scheduledDisplayContent(sm)).font(.zkSans(14)).foregroundColor(Theme.ink1).lineLimit(3)
                Text(Self.whenText(sm.scheduledFor)).font(.zkSans(11)).foregroundColor(Theme.accent)
                if let err = sm.lastError, !err.isEmpty {
                    Text("Failed: \(err)").font(.zkSans(11)).foregroundColor(Theme.danger).lineLimit(1)
                }
            }
            Spacer()
            Button(role: .destructive) { Task { await store.cancelScheduled(sm) } } label: {
                Image(systemName: "trash").font(.system(size: 13)).foregroundColor(Theme.danger)
            }
            .buttonStyle(.plain)
        }
        .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func schedule() {
        busy = true; error = nil
        let content = trimmedDraft
        Task {
            let err = await store.scheduleMessage(content: content, at: date)
            busy = false
            if let err { error = err } else { draft = "" }
        }
    }

    private static let parseFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let parsePlain = ISO8601DateFormatter()
    private static let display: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; return f
    }()

    static func whenText(_ iso: String) -> String {
        let date = parseFractional.date(from: iso) ?? parsePlain.date(from: iso)
        guard let date else { return iso }
        return display.string(from: date)
    }
}

// MARK: - DM settings

/// Per-DM auto-delete TTL + close. Mirrors the web DmSettingsPanel. The
/// TTL is a property of the conversation (affects both recipients) and
/// counts from when the OTHER person reads the message.
struct DmSettingsSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    @State private var showEnableE2EE = false
    @State private var confirmDisableE2EE = false

    private let options: [(String, Int?)] = [
        ("Off", nil), ("30 seconds", 30), ("1 minute", 60), ("2 minutes", 120)
    ]

    /// Live channel state (E2EE flips arrive via CHANNEL_UPDATE).
    private var liveChannel: Channel {
        store.dms.first(where: { $0.id == channel.id }) ?? channel
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    // Order (top→bottom): Shared media, Notifications, Read
                    // receipts, Auto-delete, End-to-end encryption, Close DM.
                    Text("SHARED MEDIA")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    NavigationLink {
                        MediaGalleryView(channel: liveChannel)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "photo.on.rectangle.angled")
                                .font(.system(size: 13)).foregroundColor(Theme.accent)
                            Text("Photos & Files")
                                .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                            Spacer()
                            Image(systemName: "chevron.right")
                                .font(.system(size: 11, weight: .semibold)).foregroundColor(Theme.ink3)
                        }
                        .padding(12)
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)

                    Divider().overlay(Theme.line)

                    Text("NOTIFICATIONS")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    notificationPreviewToggle
                    Text(notifPreviewFootnote)
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)

                    Divider().overlay(Theme.line)

                    Text("READ RECEIPTS")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    readReceiptsToggle

                    Divider().overlay(Theme.line)

                    Text("AUTO-DELETE MESSAGES")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if store.loadingDmSettings {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 12)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(options.indices, id: \.self) { i in
                                ttlRow(options[i])
                                if i < options.count - 1 { Divider().overlay(Theme.line) }
                            }
                        }
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    Text("When on, each message disappears this long after the other person reads it. This applies to both of you.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)

                    Divider().overlay(Theme.line)

                    Text("END-TO-END ENCRYPTION")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if liveChannel.isE2EE {
                        HStack(spacing: 8) {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 13))
                                .foregroundColor(Theme.accent)
                            Text("Enabled")
                                .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                            Spacer()
                            Button("Turn Off…", role: .destructive) { confirmDisableE2EE = true }
                                .font(.zkSans(13, weight: .semibold))
                                .foregroundColor(Theme.dangerSoft)
                        }
                        .padding(12)
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                        Text("Messages are encrypted with your shared password. Turning this off permanently deletes the encrypted history for both of you.")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    } else {
                        Button { showEnableE2EE = true } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "lock.open")
                                    .font(.system(size: 13))
                                    .foregroundColor(Theme.accent)
                                Text("Turn On End-to-End Encryption")
                                    .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .semibold)).foregroundColor(Theme.ink3)
                            }
                            .padding(12)
                            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        Text("Encrypts this conversation with a password you both share. Only devices that know it can read messages.")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    }

                    Divider().overlay(Theme.line)

                    Button(role: .destructive) {
                        Task { await store.closeDM(channel); dismiss() }
                    } label: {
                        Label("Close DM", systemImage: "xmark.circle")
                            .font(.zkSans(15)).foregroundColor(Theme.danger)
                    }
                    Text("Removes this conversation from your list. The other person keeps their copy.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(channel.dmTitle).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button { dismiss() } label: { Image(systemName: "chevron.left").font(.system(size: 20, weight: .semibold)).foregroundColor(Theme.ink2).frame(width: 44, height: 44).contentShape(Rectangle()) }.accessibilityLabel("Close") } }
            .task { await store.loadDmSettings(channel.id) }
            .sheet(isPresented: $showEnableE2EE) {
                EnableE2EESheet(channel: liveChannel)
            }
            .confirmationDialog(
                "Turn off encryption?",
                isPresented: $confirmDisableE2EE,
                titleVisibility: .visible
            ) {
                Button("Turn Off & Delete History", role: .destructive) {
                    Task { await store.disableE2EE(liveChannel) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("All encrypted messages in this conversation are permanently deleted for both of you.")
            }
        }
    }

    // Per-user notification-preview preference (mirrors web's
    // NotificationPreviewToggle). Default depends on encryption: plaintext DMs
    // preview the message; E2EE DMs hide it unless the user opts in.
    private var notifPreviewEffective: Bool {
        store.dmNotifShowContent ?? !liveChannel.isE2EE
    }
    private var notifPreviewFootnote: String {
        liveChannel.isE2EE
            ? "When on, push notifications reveal the decrypted message and sender. When off, you only see that you have new messages — your encrypted content stays hidden on the lock screen."
            : "When on, push notifications show a preview of the message. When off, you only see that you have new messages."
    }
    @ViewBuilder
    private var notificationPreviewToggle: some View {
        Toggle(isOn: Binding(
            get: { notifPreviewEffective },
            set: { newValue in
                // Reflect the tap IMMEDIATELY (synchronously) so SwiftUI's
                // re-read of `get` sees the new value — otherwise the knob
                // snapped back to off because the update only happened inside
                // the async Task. The Task then persists and reverts on failure.
                let prev = store.dmNotifShowContent
                store.dmNotifShowContent = newValue
                Task { await store.persistDmNotifShowContent(channel.id, newValue, fallback: prev) }
            }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Show message in notifications")
                    .font(.zkSans(15)).foregroundColor(Theme.ink1)
                Text(liveChannel.isE2EE
                    ? "Reveals decrypted message text in push notifications."
                    : "Previews message text in push notifications.")
                    .font(.zkSans(11)).foregroundColor(Theme.ink4)
            }
        }
        .tint(Theme.accent)
        .disabled(store.loadingDmSettings)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // Per-USER read-receipts preference (mirrors web's ReadReceiptsToggle).
    // Scope is the whole account, not just this DM. nil = server default `true`.
    private var readReceiptsToggle: some View {
        Toggle(isOn: Binding(
            get: { store.currentUser?.dmReadReceiptsEnabled ?? true },
            set: { newValue in
                let prev = store.currentUser?.dmReadReceiptsEnabled
                store.currentUser?.dmReadReceiptsEnabled = newValue
                Task { await store.persistDmReadReceiptsEnabled(newValue, fallback: prev) }
            }
        )) {
            VStack(alignment: .leading, spacing: 2) {
                Text("Send read receipts")
                    .font(.zkSans(15)).foregroundColor(Theme.ink1)
                Text("Let people you DM see Delivered and Read on their messages. When off, you won't see receipts on messages sent to you either.")
                    .font(.zkSans(11)).foregroundColor(Theme.ink4)
            }
        }
        .tint(Theme.accent)
        .disabled(store.currentUser == nil)
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    // Key backup / restore was removed — the shared conversation password is
    // the single unlock path (the per-DM key is re-derivable from it), so a
    // key file is redundant. See UnlockPanel.unlock() / store.unlockE2EE.

    private func ttlRow(_ opt: (String, Int?)) -> some View {
        Button { Task { await store.setDmTtl(channel.id, opt.1) } } label: {
            HStack {
                Text(opt.0).font(.zkSans(15)).foregroundColor(Theme.ink1)
                Spacer()
                if store.dmTtl == opt.1 {
                    Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.accent)
                }
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12).padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}

/// Live camera capture for the composer — wraps UIImagePickerController(.camera).
/// The captured photo is handed back as a UIImage; the composer turns it into a
/// JPEG PendingAttachment and sends it through the normal attachment path (so
/// E2EE encryption + upload work unchanged, in DMs and channels alike).
private struct CameraPicker: UIViewControllerRepresentable {
    let onCapture: (UIImage) -> Void
    let onCancel: () -> Void

    func makeUIViewController(context: Context) -> UIImagePickerController {
        let picker = UIImagePickerController()
        picker.sourceType = .camera
        picker.cameraCaptureMode = .photo
        picker.mediaTypes = ["public.image"]
        picker.delegate = context.coordinator
        return picker
    }
    func updateUIViewController(_ controller: UIImagePickerController, context: Context) {}
    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, UIImagePickerControllerDelegate, UINavigationControllerDelegate {
        let parent: CameraPicker
        init(_ parent: CameraPicker) { self.parent = parent }
        func imagePickerController(_ picker: UIImagePickerController,
                                   didFinishPickingMediaWithInfo info: [UIImagePickerController.InfoKey: Any]) {
            if let image = info[.originalImage] as? UIImage {
                parent.onCapture(image)
            } else {
                parent.onCancel()
            }
        }
        func imagePickerControllerDidCancel(_ picker: UIImagePickerController) {
            parent.onCancel()
        }
    }
}

// MARK: - Image long-press actions (save / copy / share)

/// Share-sheet host for an arbitrary set of activity items (e.g. a UIImage).
private struct ActivityItemsView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Identifiable wrapper so a UIImage can drive `.sheet(item:)`.
private struct ImageShareItem: Identifiable {
    let id = UUID()
    let image: UIImage
}

// The per-image long-press menu (Save to Photos / Copy / Share) that used to
// live here as an `.imageActions` ViewModifier was removed: as a nested
// .contextMenu on the photo it swallowed the message row's reaction menu, so
// single-photo messages couldn't be reacted to. Those actions now live in the
// row's own context menu (MessageRow.menuItems, gated on singleSavableImage),
// which decrypts E2EE bytes on demand via loadSingleImage — so the saved /
// shared / copied bytes are still the DECRYPTED image (no plaintext URL).

/// Downloads an encrypted (.zke) attachment, decrypts it with the DM's
/// channel key, and renders the result — images inline (tap to zoom via a
/// temporary file is skipped; encrypted images stay in-memory), anything
/// else as a sealed-file chip. Shows a lock placeholder until the key is
/// unlocked on this device.
struct EncryptedAttachmentView: View {
    let store: AppStore
    let attachment: Attachment
    let channel: Channel
    /// Fed from the row's MessageRowData so the decrypt task re-runs on E2EE
    /// unlock without this view observing the store.
    let e2eeUnlockVersion: Int
    @State private var image: UIImage?
    @State private var videoURL: URL?
    @State private var playingVideo: VideoItem?
    @State private var failed = false
    @State private var loading = true

    /// Original name without the .zke wire suffix.
    private var displayName: String {
        let n = attachment.filename ?? "file"
        return n.hasSuffix(".zke") ? String(n.dropLast(4)) : n
    }

    private var isVideo: Bool {
        let ext = (displayName as NSString).pathExtension.lowercased()
        return ["mp4", "mov", "m4v", "qt", "webm", "avi", "mkv"].contains(ext)
    }

    /// Slot to reserve from the (plaintext) image dims so the row doesn't reflow
    /// when the encrypted image decrypts. nil for videos / unknown dims (old
    /// messages) → falls back to the unreserved layout.
    private var reservedSize: CGSize? {
        guard !isVideo, let w = attachment.width, let h = attachment.height, w > 0, h > 0 else { return nil }
        let bound: CGFloat = 240
        let s = min(bound / CGFloat(w), bound / CGFloat(h))
        return CGSize(width: CGFloat(w) * s, height: CGFloat(h) * s)
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable().scaledToFit()
                    .frame(maxWidth: 240, maxHeight: 240, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    // Tap → full-screen preview of the DECRYPTED image (no plaintext
                    // URL). Presents IMMEDIATELY with a LAZY encrypted reference —
                    // the lightbox page decrypts + downsamples the full image
                    // on-appear (same as the multi-photo path; the decrypt cache
                    // makes repeat opens instant). This used to `await` the full
                    // decrypt BEFORE presenting, so the first tap looked dead for a
                    // beat and an impatient second tap queued a SECOND open, which
                    // stacked/re-presented the viewer ("tap again → opens multiple,
                    // still there after exiting one").
                    .onTapGesture {
                        // Once retention has expired the original there is no
                        // full-size view to open — the lightbox would download +
                        // decrypt a blob that no longer exists. Inert, exactly
                        // like the plain-image path; the badge says why.
                        guard !attachment.blobExpired else { return }
                        // Carry the inline thumbnail as an instant placeholder AND a
                        // decrypt-failure fallback; the page swaps in the full-res
                        // decode on-appear.
                        store.openLightbox(
                            items: [LightboxItem(image: image, encrypted: (attachment, channel))],
                            startIndex: 0)
                    }
                    .overlay(alignment: .bottomLeading) {
                        if attachment.blobExpired { ExpiredOriginalBadge() }
                    }
                    // Per-image E2EE lock badge removed — the lock by the DM
                    // header already signals the whole conversation is encrypted.
                    // Long-press actions (Add reaction + Save/Copy/Share the
                    // decrypted bytes) come from the message row's context menu
                    // (see singleSavableImage / loadSingleImage) — NOT a nested
                    // .imageActions menu, which used to swallow the reaction menu
                    // on single photos.
            } else if let videoURL {
                // Decrypted video → tappable chip → full-screen player. The
                // bytes were written to a temp file (AVPlayer needs a URL).
                Button { playingVideo = VideoItem(url: videoURL) } label: {
                    HStack(spacing: 8) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 6).fill(Theme.bg1)
                                .frame(width: 40, height: 40)
                            Image(systemName: "play.fill")
                                .font(.system(size: 15))
                                .foregroundColor(Theme.accent)
                        }
                        VStack(alignment: .leading, spacing: 1) {
                            Text(displayName)
                                .font(.zkSans(13, weight: .medium))
                                .foregroundColor(Theme.ink1)
                                .lineLimit(1)
                            if let size = attachment.size {
                                Text(byteString(size))
                                    .font(.zkSans(11))
                                    .foregroundColor(Theme.ink3)
                            }
                        }
                        Spacer(minLength: 0)
                    }
                    .padding(8)
                    .frame(maxWidth: 240, alignment: .leading)
                    .background(Theme.bg3)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            } else {
                HStack(spacing: 8) {
                    Image(systemName: failed ? "lock.slash" : (attachment.blobExpired ? "clock" : "lock.doc"))
                        .foregroundColor(failed ? Theme.dangerSoft
                                         : (attachment.blobExpired ? Theme.ink3 : Theme.accent))
                    VStack(alignment: .leading, spacing: 1) {
                        Text(displayName)
                            .font(.zkSans(13, weight: .medium))
                            .foregroundColor(Theme.ink1)
                            .lineLimit(1)
                        // An expired original is not a decrypt failure — say so
                        // plainly instead of implying the key is bad. A real
                        // decrypt failure still wins, since that's the actionable
                        // one (unlock the conversation).
                        Text(failed
                             ? "Couldn't decrypt"
                             : (attachment.blobExpired
                                ? (chipSubtitle(attachment) ?? "Original expired")
                                : (loading ? "Decrypting…" : "Encrypted file")))
                            .font(.zkSans(11))
                            .foregroundColor(failed ? Theme.dangerSoft : Theme.ink3)
                    }
                    if loading && !failed && !attachment.blobExpired { ProgressView().scaleEffect(0.7) }
                }
                .padding(8)
                .background(Theme.bg3)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        // Reserve the image's slot up front (when dims are known) so the row
        // doesn't jump when the encrypted image decrypts. No-op for videos /
        // old messages without dims.
        .frame(width: reservedSize?.width, height: reservedSize?.height, alignment: .leading)
        .fullScreenCover(item: $playingVideo) { VideoLightboxView(url: $0.url) }
        .onDisappear {
            // Decrypted video is written to a temp file (iOS doesn't auto-purge
            // NSTemporaryDirectory); remove it when the row goes away.
            if let videoURL { try? FileManager.default.removeItem(at: videoURL) }
        }
        .task(id: e2eeUnlockVersion) {
            // e2eeUnlockVersion bumps on ANY CHANNEL_UPDATE for the open channel,
            // not just key changes — don't redo the decrypt/decode (or re-write
            // the video temp file) once this row has already resolved. A not-yet-
            // resolved row (incl. a previously-failed one) still retries, so a
            // real unlock recovers.
            guard image == nil, videoURL == nil else { return }
            loading = true
            failed = false
            if isVideo {
                // Encrypted video has no thumbnail, so an expired original means
                // there is nothing left to decrypt: stop at the chip (which reads
                // "original expired") instead of downloading a dead blob and
                // reporting it as a decrypt failure.
                guard !attachment.blobExpired else {
                    loading = false
                    return
                }
                // Video has no thumbnail — decrypt the full blob to a temp file.
                guard let data = await store.decryptedAttachmentData(attachment, in: channel) else {
                    loading = false
                    failed = true
                    return
                }
                let ext = (displayName as NSString).pathExtension.lowercased()
                let tmp = FileManager.default.temporaryDirectory
                    .appendingPathComponent(UUID().uuidString + "." + (ext.isEmpty ? "mp4" : ext))
                if (try? data.write(to: tmp)) != nil {
                    videoURL = tmp
                    loading = false
                } else {
                    loading = false
                    failed = true
                }
            } else {
                // Inline image. Decoded-thumb cache: on scroll-back paint
                // instantly, skipping the byte fetch + ImageIO re-decode.
                if let cached = EncryptedThumbCache.image(attachment.id, 720) {
                    image = cached
                    loading = false
                    return
                }
                // Decrypt the small thumbnail (tiny download + decrypt); fall back
                // to the full blob for old messages — but never once retention
                // expired that blob. Decode off-main. The lightbox / Save decrypt
                // the FULL image on tap (also gated on blobExpired).
                var data = await store.decryptedThumbnailData(attachment, in: channel)
                if data == nil, !attachment.blobExpired {
                    data = await store.decryptedAttachmentData(attachment, in: channel)
                }
                guard let data else {
                    loading = false
                    failed = true
                    return
                }
                let decoded = await Task.detached(priority: .userInitiated) {
                    ImageDownsampler.decode(data, maxPixels: 720)
                }.value
                if let decoded { EncryptedThumbCache.store(decoded, attachment.id, 720) }
                image = decoded
                loading = false
                failed = (image == nil && !data.isEmpty) ? false : failed
            }
        }
    }
}

// MARK: - Shared media gallery

/// All photos & documents shared in a DM / channel, in two tabs. Reads
/// GET /channels/:id/attachments (newest-first, paginated) and buckets
/// client-side, so encrypted (.zke) attachments are classified by their inner
/// filename and decrypted for display. Photos open in the lightbox.
struct MediaGalleryView: View {
    let channel: Channel
    @EnvironmentObject private var store: AppStore
    private enum Tab: String, CaseIterable { case media = "Photos", files = "Files" }
    @State private var tab: Tab = .media
    @State private var items: [Attachment] = []
    @State private var loading = false
    @State private var hasMore = true
    @State private var lightbox: LightboxImage?

    private func realName(_ a: Attachment) -> String {
        let n = a.filename ?? ""
        return n.hasSuffix(".zke") ? String(n.dropLast(4)) : n
    }
    private func isImage(_ a: Attachment) -> Bool {
        if a.isImage { return true }
        let ext = (realName(a) as NSString).pathExtension.lowercased()
        return ["png", "jpg", "jpeg", "gif", "webp", "heic", "heif", "bmp", "tiff"].contains(ext)
    }
    private var media: [Attachment] { items.filter { isImage($0) && $0.isVoiceMessage != true } }
    private var files: [Attachment] { items.filter { !isImage($0) && $0.isVoiceMessage != true } }
    private var current: [Attachment] { tab == .media ? media : files }

    private let cols = [GridItem(.adaptive(minimum: 108), spacing: 3)]

    var body: some View {
        VStack(spacing: 0) {
            Picker("", selection: $tab) {
                ForEach(Tab.allCases, id: \.self) { Text($0.rawValue).tag($0) }
            }
            .pickerStyle(.segmented)
            .padding(12)

            ScrollView {
                if tab == .media {
                    LazyVGrid(columns: cols, spacing: 3) {
                        ForEach(media) { att in
                            GalleryThumb(attachment: att, channel: channel,
                                         onOpen: { tappedId in openGalleryLightbox(tapped: tappedId) })
                        }
                    }
                    .padding(.horizontal, 3)
                } else {
                    LazyVStack(spacing: 0) {
                        ForEach(files) { a in
                            GalleryFileRow(attachment: a, displayName: realName(a))
                            Divider().overlay(Theme.line).padding(.leading, 52)
                        }
                    }
                }

                if loading {
                    ProgressView().tint(Theme.accent).padding(.vertical, 18)
                } else if hasMore && !items.isEmpty {
                    // Bottom sentinel: paginates the underlying stream (both tabs
                    // re-filter as `items` grows).
                    Color.clear.frame(height: 1)
                        .onAppear { Task { await loadMore() } }
                } else if current.isEmpty {
                    Text(tab == .media ? "No photos shared yet." : "No files shared yet.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        .frame(maxWidth: .infinity).padding(.vertical, 44)
                }
            }
        }
        .background(Theme.bg1.ignoresSafeArea())
        .navigationTitle("Shared Media").navigationBarTitleDisplayMode(.inline)
        .task { if items.isEmpty { await loadMore() } }
        // Present the lightbox from WITHIN the gallery (which lives inside the
        // DM-settings sheet) so a tapped photo pops OVER it. The app-root
        // store.lightbox cover sits behind the sheet and wouldn't appear until
        // the sheet was closed.
        .fullScreenCover(item: $lightbox) { ImageLightboxView(item: $0).environmentObject(store) }
    }

    private func loadMore() async {
        guard !loading, hasMore else { return }
        loading = true
        defer { loading = false }
        do {
            let page = try await APIClient.shared.channelAttachments(channelId: channel.id, before: items.last?.id)
            let seen = Set(items.map { $0.id })
            items.append(contentsOf: page.filter { !seen.contains($0.id) })
            hasMore = page.count >= 60
        } catch {
            hasMore = false
        }
    }

    /// Build a paged lightbox across the WHOLE loaded photo set (so swiping
    /// left/right scrolls through every shared photo, not just the tapped one),
    /// opening on the tapped image. Mirrors AppStore.openImageLightbox but
    /// targets this view's own cover (the app-root cover sits behind the
    /// settings sheet this gallery lives in). Plain images stay lazy via their
    /// URL; encrypted images decrypt through the session media cache (visible
    /// thumbs are already cached from their on-appear decrypt).
    private func openGalleryLightbox(tapped: String) {
        var lbItems: [LightboxItem] = []
        var start = 0
        for att in media {
            let it: LightboxItem?
            if att.blobExpired {
                // Retention aged the full-size object out; the lightbox is a
                // full-size view, so this photo isn't in the pageable set (it
                // still shows as a thumbnail in the grid, badged). Tapping one
                // does nothing rather than paging to a dead URL.
                it = nil
            } else if att.filename?.hasSuffix(".zke") == true {
                // Carry a LAZY encrypted reference — the visible LightboxPage
                // decrypts + downsamples on-appear. This loops over the whole
                // loaded set (potentially hundreds); eagerly downloading +
                // decrypting each full-res blob here froze the UI for seconds
                // on tap. The paged TabView only builds the current/adjacent
                // pages, so only those images decrypt; the rest resolve as the
                // user swipes.
                it = LightboxItem(encrypted: (att, channel))
            } else if let url = assetURL(att.url) {
                it = LightboxItem(url: url)
            } else {
                it = nil
            }
            if let it {
                if att.id == tapped { start = lbItems.count }
                lbItems.append(it)
            }
        }
        guard !lbItems.isEmpty else { return }
        lightbox = LightboxImage(items: lbItems, startIndex: start)
    }
}

/// One square photo cell — plain (RetryingImage) or E2EE (decrypted in-place).
private struct GalleryThumb: View {
    let attachment: Attachment
    let channel: Channel
    /// Reports the tapped attachment id so the gallery can open a paged
    /// lightbox across the whole photo set (not just this one image).
    let onOpen: (String) -> Void
    @EnvironmentObject private var store: AppStore
    @State private var decrypted: UIImage?
    @State private var tried = false
    private var isEncrypted: Bool { attachment.filename?.hasSuffix(".zke") == true }

    var body: some View {
        Color.clear
            .aspectRatio(1, contentMode: .fit)
            .overlay {
                if isEncrypted {
                    if let img = decrypted {
                        Image(uiImage: img).resizable().scaledToFill()
                    } else {
                        ZStack {
                            Theme.bg3
                            Image(systemName: tried ? "lock.slash" : "lock.fill")
                                .foregroundColor(Theme.ink3)
                        }
                    }
                } else if let url = inlineAttachmentURL(attachment) {
                    // Thumbnail first (it's a 108pt cell), and NEVER the
                    // original once retention expired it.
                    RetryingImage(url: url)
                }
            }
            .clipped()
            .overlay(alignment: .bottomLeading) {
                if attachment.blobExpired { ExpiredOriginalBadge() }
            }
            .contentShape(Rectangle())
            // An expired photo has no full-size view to open — the grid
            // thumbnail is the whole of what survives.
            .onTapGesture { if !attachment.blobExpired { onOpen(attachment.id) } }
            .task(id: store.e2eeUnlockVersion) {
                guard isEncrypted, decrypted == nil else { return }
                // Decoded-thumb cache (shared with the inline thumb at 400px):
                // scroll-back paints instantly with no re-decode.
                if let cached = EncryptedThumbCache.image(attachment.id, 400) {
                    decrypted = cached
                    tried = true
                    return
                }
                // Prefer the small thumbnail, then decode OFF the main actor with
                // downsampling — a bare UIImage(data:) on the full blob here
                // decoded multi-megapixel JPEGs on the main thread, hitching the
                // gallery grid. Mirrors the inline EncryptedThumb path.
                var data = await store.decryptedThumbnailData(attachment, in: channel)
                if data == nil, !attachment.blobExpired {
                    data = await store.decryptedAttachmentData(attachment, in: channel)
                }
                if let data {
                    let decoded = await Task.detached(priority: .userInitiated) {
                        ImageDownsampler.decode(data, maxPixels: 400)
                    }.value
                    if let decoded { EncryptedThumbCache.store(decoded, attachment.id, 400) }
                    decrypted = decoded
                }
                tried = true
            }
    }
}

/// One document row in the Files tab. Plain files open via the system; encrypted
/// files show their name (decrypt-to-open is a future add).
private struct GalleryFileRow: View {
    let attachment: Attachment
    let displayName: String
    @Environment(\.openURL) private var openURL
    private var isEncrypted: Bool { attachment.filename?.hasSuffix(".zke") == true }

    var body: some View {
        // Retention aged the file's bytes out: no download affordance and no
        // tap — the row stays as a record of what was shared.
        let expired = attachment.blobExpired
        HStack(spacing: 12) {
            Image(systemName: expired ? "clock" : (isEncrypted ? "lock.doc.fill" : "doc.fill"))
                .foregroundColor(expired ? Theme.ink3 : Theme.accent).frame(width: 28)
            VStack(alignment: .leading, spacing: 1) {
                Text(displayName).font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1).lineLimit(1)
                if let sub = chipSubtitle(attachment) {
                    Text(sub).font(.zkSans(11)).foregroundColor(Theme.ink3)
                }
            }
            Spacer()
            if !isEncrypted && !expired { Image(systemName: "arrow.down.circle").foregroundColor(Theme.ink3) }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .contentShape(Rectangle())
        .onTapGesture {
            if !isEncrypted, !expired, let url = assetURL(attachment.url) { openURL(url) }
        }
    }
}

// MARK: - Poke history popover

/// Compact relative time for the poke-history rows ("just now", "2m", "3h", "5d").
/// The server emits fractional-second ISO timestamps, so parse with millis.
private let pokeIsoParser: ISO8601DateFormatter = {
    let f = ISO8601DateFormatter()
    f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    return f
}()

private func pokeAgo(_ iso: String) -> String {
    guard let then = pokeIsoParser.date(from: iso) else { return "" }
    let s = max(0, Int(Date().timeIntervalSince(then)))
    if s < 45 { return "just now" }
    if s < 3600 { return "\(s / 60)m" }
    if s < 86400 { return "\(s / 3600)h" }
    return "\(s / 86400)d"
}

/// Poke button popover: recent pokes received on this DM (max 6) above the
/// poke palette. Kept simple/dependency-free so it renders reliably inside the
/// header popover.
private struct PokePopover: View {
    let history: [PokeHistoryEntry]
    let loading: Bool
    let onPoke: (PokeVariant) -> Void

    var body: some View {
        VStack(spacing: 12) {
            // "RECENT POKES" header + list (secondary). Scrolls if there are
            // several so it never pushes the palette off the compact sheet.
            VStack(alignment: .leading, spacing: 8) {
                Text("RECENT POKES")
                    .font(.zkSans(10, weight: .bold)).tracking(0.5)
                    .foregroundColor(Theme.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if loading {
                    Text("Loading…").font(.zkSans(13)).foregroundColor(Theme.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else if history.isEmpty {
                    Text("No pokes yet — say hi below.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        .frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            ForEach(history) { p in
                                HStack(spacing: 6) {
                                    Text(p.variant.emoji).font(.system(size: 15))
                                    Text(p.initiatorName)
                                        .font(.zkSans(13, weight: .medium)).foregroundColor(Theme.ink1)
                                        .lineLimit(1)
                                    Text(p.variant.verb).font(.zkSans(13)).foregroundColor(Theme.ink2)
                                    Spacer(minLength: 8)
                                    Text(pokeAgo(p.createdAt)).font(.zkSans(11)).foregroundColor(Theme.ink3)
                                }
                            }
                        }
                    }
                    .frame(maxHeight: 120)
                }
            }

            Divider().overlay(Theme.line)

            // Poke palette — CENTERED. `maxWidth: .infinity` centers the packed
            // button row within the full-width sheet.
            HStack(spacing: 10) {
                ForEach(PokeVariant.allCases) { v in
                    Button { onPoke(v) } label: {
                        Text(v.emoji).font(.system(size: 24)).frame(width: 40, height: 40)
                    }
                    .buttonStyle(.plain)
                }
            }
            .frame(maxWidth: .infinity)
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .top)
        .background(Theme.bg2)
    }
}
