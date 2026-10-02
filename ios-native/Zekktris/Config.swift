import Foundation

/// Central configuration for the native client.
///
/// The web client talks to a same-origin `/api/v1` and `wss://…/gateway`; the
/// native app has no "origin", so it keeps the server's address here. It
/// defaults to zekktris.com, and anyone running their own Zekktris server can
/// point the app at it from the sign-in screen (ServerPickerSheet). The choice
/// lives in the App Group's UserDefaults so the widgets, Siri intents and the
/// share extension talk to the same server as the app; the watch gets it from
/// the phone over WatchConnectivity (WatchSync).
enum Config {
    /// The hosted server every install starts on.
    static let defaultOrigin = "https://zekktris.com"

    private static let originKey = "zk.serverOrigin"
    private static var shared: UserDefaults? { UserDefaults(suiteName: AppGroupConfig.identifier) }

    /// "scheme://host[:port]" with no trailing slash.
    static var serverOrigin: String {
        if let saved = shared?.string(forKey: originKey), !saved.isEmpty { return saved }
        return defaultOrigin
    }

    /// Point the app at another server (nil = back to zekktris.com). Only
    /// change it while signed out — a session token belongs to one server.
    static func setServerOrigin(_ origin: String?) {
        if let origin, origin != defaultOrigin {
            shared?.set(origin, forKey: originKey)
        } else {
            shared?.removeObject(forKey: originKey)
        }
    }

    static var isDefaultServer: Bool { serverOrigin == defaultOrigin }

    /// Host (and port, when it isn't the scheme's default) for display.
    static var serverDisplayName: String {
        guard let c = URLComponents(string: serverOrigin), let host = c.host else { return serverOrigin }
        if let port = c.port { return "\(host):\(port)" }
        return host
    }

    /// REST base URL, including `/api/v1` and NO trailing slash — every path
    /// passed to `APIClient` begins with a leading `/` (e.g. `/auth/login`).
    static var apiBaseURL: String { serverOrigin + "/api/v1" }

    /// Realtime gateway WebSocket URL (wss for https servers, ws for http).
    static var gatewayURL: URL {
        let ws = serverOrigin.hasPrefix("http://")
            ? "ws://" + serverOrigin.dropFirst("http://".count)
            : "wss://" + serverOrigin.dropFirst("https://".count)
        return URL(string: ws + "/gateway")!
    }

    /// Origin that serves uploaded assets and the web pages (terms, invites).
    /// Avatars / icons come back from the API as relative `/cdn/<id>/<file>`
    /// paths; we prefix this to load them.
    static var assetOrigin: String { serverOrigin }

    /// Turn what someone typed ("chat.example.com", "203.0.113.5",
    /// "https://chat.example.com:8443/", "http://192.168.1.20:5550") into an
    /// origin. No scheme → https. Returns nil for anything that isn't a
    /// plain http(s) host.
    static func normalizeOrigin(_ input: String) -> String? {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if !text.contains("://") { text = "https://" + text }
        guard var c = URLComponents(string: text),
              let scheme = c.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let host = c.host, !host.isEmpty else { return nil }
        c.scheme = scheme
        c.host = host.lowercased()
        c.path = ""
        c.query = nil
        c.fragment = nil
        c.user = nil
        c.password = nil
        return c.string
    }
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
