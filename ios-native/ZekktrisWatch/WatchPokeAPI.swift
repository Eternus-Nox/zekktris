import Foundation

/// One DM message rendered on the watch's Messages screen.
struct WatchMessage: Identifiable {
    let id: String
    let author: String
    let content: String
}

/// Minimal API caller for the watch — POSTs with the bearer token synced from
/// the phone. No refresh/retry: if the token has expired the call just fails
/// (the phone re-syncs a fresh token on its next foreground).
enum WatchPokeAPI {
    static func poke(baseURL: String, token: String, channelId: String, pokeType: String) async -> Bool {
        await post(baseURL: baseURL, token: token, path: "/channels/\(channelId)/poke",
                   body: ["pokeType": pokeType])
    }

    /// Send a text message to a DM straight from the wrist (dictation/scribble).
    static func sendMessage(baseURL: String, token: String, channelId: String, content: String) async -> Bool {
        await post(baseURL: baseURL, token: token, path: "/channels/\(channelId)/messages",
                   body: ["content": content])
    }

    /// Fetch the most recent messages in a DM so they can be READ on the wrist.
    /// Returns nil on any failure (network / expired token); the caller shows an
    /// error state. Parsed loosely (JSONSerialization) so the watch never has to
    /// mirror the full Message DTO. Server returns newest-first; we keep that
    /// order so the latest message sits at the top for a quick glance.
    static func fetchMessages(baseURL: String, token: String, channelId: String) async -> [WatchMessage]? {
        guard let url = URL(string: "\(baseURL)/channels/\(channelId)/messages?limit=20") else { return nil }
        var req = URLRequest(url: url)
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        guard
            let (data, resp) = try? await URLSession.shared.data(for: req),
            let http = resp as? HTTPURLResponse, (200..<300).contains(http.statusCode),
            let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let arr = obj["messages"] as? [[String: Any]]
        else { return nil }
        return arr.compactMap { m in
            guard let id = m["id"] as? String else { return nil }
            let content = (m["content"] as? String) ?? ""
            if content.isEmpty { return nil } // skip attachment-only / system rows
            let author = m["author"] as? [String: Any]
            let name = (author?["displayName"] as? String)
                ?? (author?["username"] as? String)
                ?? "Unknown"
            return WatchMessage(id: id, author: name, content: content)
        }
    }

    private static func post(baseURL: String, token: String, path: String, body: [String: Any]) async -> Bool {
        guard let url = URL(string: "\(baseURL)\(path)") else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard
            let (_, resp) = try? await URLSession.shared.data(for: req),
            let http = resp as? HTTPURLResponse,
            (200..<300).contains(http.statusCode)
        else { return false }
        return true
    }
}
