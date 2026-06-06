import Foundation

/// Central configuration for the native client.
///
/// These point at the same production deployment the web app uses. The web
/// client talks to a same-origin `/api/v1` and `wss://…/gateway`; since the
/// native app has no "origin", we hard-code the absolute host here. Change
/// these (e.g. to a localhost dev server) when pointing the app elsewhere.
enum Config {
    /// REST base URL, including `/api/v1` and NO trailing slash — every path
    /// passed to `APIClient` begins with a leading `/` (e.g. `/auth/login`).
    static let apiBaseURL = "https://zekktris.com/api/v1"

    /// Realtime gateway WebSocket URL.
    static let gatewayURL = URL(string: "wss://zekktris.com/gateway")!

    /// Origin that serves uploaded assets. Avatars / icons come back from the
    /// API as relative `/cdn/<id>/<file>` paths; we prefix this to load them.
    static let assetOrigin = "https://zekktris.com"
}

/// Resolve an asset path (which may be absolute or a relative `/cdn/...`)
/// into a fully-qualified URL the image loader can fetch.
func assetURL(_ path: String?) -> URL? {
    guard let path, !path.isEmpty else { return nil }
    if path.hasPrefix("http://") || path.hasPrefix("https://") {
        return URL(string: path)
    }
    return URL(string: Config.assetOrigin + path)
}
