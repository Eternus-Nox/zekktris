import Foundation
import CryptoKit

/// Watch-side E2EE — a byte-for-byte port of the phone's `E2EE` text path
/// (ios-native/Zekktris/E2EE.swift), so a message the watch encrypts decrypts
/// on phone/web and vice-versa. The watch only does the symmetric AES-GCM part:
/// the 32-byte channel key is derived on the phone (PBKDF2) and relayed to the
/// watch, so no key derivation (and no CommonCrypto) is needed here.
///
///   Wire: "zkE2EE/3:" + base64( iv(12) ‖ ciphertext ‖ tag(16) ), AES-256-GCM.
enum WatchE2EE {
    static let wirePrefixV3 = "zkE2EE/3:"
    static let keyBytes = 32
    static let ivBytes = 12
    static let tagBytes = 16

    /// True if the content is any E2EE wire format (v1/v2 legacy or v3).
    static func isEncrypted(_ s: String) -> Bool {
        s.hasPrefix(wirePrefixV3) || s.hasPrefix("zkE2EE/2:") || s.hasPrefix("zkE2EE/1:")
    }

    static func encrypt(_ plaintext: String, key: Data) -> String? {
        guard key.count == keyBytes else { return nil }
        do {
            let symKey = SymmetricKey(data: key)
            let nonce = AES.GCM.Nonce()
            let sealed = try AES.GCM.seal(Data(plaintext.utf8), using: symKey, nonce: nonce)
            var combined = Data(nonce)
            combined.append(sealed.ciphertext)
            combined.append(sealed.tag)
            return wirePrefixV3 + combined.base64EncodedString()
        } catch {
            return nil
        }
    }

    static func decrypt(_ wire: String, key: Data) -> String? {
        guard key.count == keyBytes, wire.hasPrefix(wirePrefixV3) else { return nil }
        let b64 = String(wire.dropFirst(wirePrefixV3.count))
        guard let combined = Data(base64Encoded: b64),
              combined.count >= ivBytes + tagBytes else { return nil }
        let iv = Data(combined.prefix(ivBytes))
        let rest = combined.dropFirst(ivBytes) // ciphertext ‖ tag
        let tag = Data(rest.suffix(tagBytes))
        let ciphertext = Data(rest.dropLast(tagBytes))
        do {
            let symKey = SymmetricKey(data: key)
            let nonce = try AES.GCM.Nonce(data: iv)
            let box = try AES.GCM.SealedBox(nonce: nonce, ciphertext: ciphertext, tag: tag)
            let pt = try AES.GCM.open(box, using: symKey)
            return String(data: pt, encoding: .utf8)
        } catch {
            return nil
        }
    }
}

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
    /// When `e2eeKey` is set the content is encrypted with the channel key
    /// FIRST — so an E2EE DM never receives plaintext. If encryption fails we
    /// abort (return false) rather than leak plaintext to the server.
    static func sendMessage(baseURL: String, token: String, channelId: String, content: String, e2ee: Bool, e2eeKey: Data?) async -> Bool {
        var payload = content
        if e2ee {
            // E2EE DM: encrypt or REFUSE. Never POST plaintext to an encrypted
            // channel — if the phone hasn't relayed a usable key, fail the send.
            guard let key = e2eeKey, let enc = WatchE2EE.encrypt(content, key: key) else { return false }
            payload = enc
        }
        return await post(baseURL: baseURL, token: token, path: "/channels/\(channelId)/messages",
                          body: ["content": payload])
    }

    /// Fetch the most recent messages in a DM so they can be READ on the wrist.
    /// When `e2eeKey` is set, encrypted content is decrypted for display (an
    /// undecryptable row shows a lock placeholder). Returns nil on any failure
    /// (network / expired token). Server returns newest-first; we keep that
    /// order so the latest message sits at the top for a quick glance.
    static func fetchMessages(baseURL: String, token: String, channelId: String, e2eeKey: Data?) async -> [WatchMessage]? {
        guard let url = URL(string: "\(baseURL)/channels/\(channelId)/messages?limit=20") else { return nil }
        var req = URLRequest(url: url)
        req.timeoutInterval = 8 // don't hang the wrist on a wedged network
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        // A read is idempotent, so retry once on a transient network miss (a
        // dropped Bluetooth hop off the phone is the common cause of a wrist
        // "couldn't load"). We do NOT retry a real HTTP error (e.g. 401/403) —
        // only a thrown/transport failure.
        var arr: [[String: Any]]?
        for attempt in 0..<2 {
            if let (data, resp) = try? await URLSession.shared.data(for: req),
               let http = resp as? HTTPURLResponse {
                guard (200..<300).contains(http.statusCode) else { return nil }
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
                arr = obj?["messages"] as? [[String: Any]]
                break
            }
            if attempt == 0 { try? await Task.sleep(nanoseconds: 400_000_000) }
        }
        guard let arr else { return nil }
        return arr.compactMap { m in
            guard let id = m["id"] as? String else { return nil }
            var content = (m["content"] as? String) ?? ""
            if content.isEmpty { return nil } // skip attachment-only / system rows
            if WatchE2EE.isEncrypted(content) {
                // Decrypt with the relayed key; if we have no key or it fails,
                // show a lock placeholder rather than raw ciphertext.
                content = e2eeKey.flatMap { WatchE2EE.decrypt(content, key: $0) } ?? "🔒 (encrypted)"
            }
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
        req.timeoutInterval = 8 // don't hang the wrist on a wedged network
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
