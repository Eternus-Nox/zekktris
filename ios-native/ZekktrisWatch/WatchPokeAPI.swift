import Foundation

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
