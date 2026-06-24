import Foundation

/// Minimal poke caller for the watch — POST /channels/:id/poke with the bearer
/// token synced from the phone. No refresh/retry: if the token has expired the
/// poke just fails (the phone re-syncs a fresh token on its next foreground).
enum WatchPokeAPI {
    static func poke(baseURL: String, token: String, channelId: String, pokeType: String) async -> Bool {
        guard let url = URL(string: "\(baseURL)/channels/\(channelId)/poke") else { return false }
        var req = URLRequest(url: url)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        req.httpBody = try? JSONSerialization.data(withJSONObject: ["pokeType": pokeType])
        guard
            let (_, resp) = try? await URLSession.shared.data(for: req),
            let http = resp as? HTTPURLResponse,
            (200..<300).contains(http.statusCode)
        else { return false }
        return true
    }
}
