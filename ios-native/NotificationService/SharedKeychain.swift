import Foundation
import Security

/// Read-only keychain access for the Notification Service Extension.
///
/// The main app stores each per-DM E2EE key in the shared app-group keychain
/// under the account `e2ee.<userId>.<channelId>`, with the value being the
/// base64 of the 32-byte key. The extension doesn't know which user is signed
/// in, so it matches on the `.<channelId>` suffix — a DM channel id belongs to
/// exactly one local participant, so at most one item matches.
enum SharedKeychain {
    static func e2eeKey(forChannelId channelId: String) -> Data? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: AppGroupConfig.keychainService,
            kSecAttrAccessGroup as String: AppGroupConfig.identifier,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
              let arr = items as? [[String: Any]] else { return nil }
        let suffix = ".\(channelId)"
        for d in arr {
            guard let account = d[kSecAttrAccount as String] as? String,
                  account.hasPrefix("e2ee."), account.hasSuffix(suffix),
                  let data = d[kSecValueData as String] as? Data,
                  let b64 = String(data: data, encoding: .utf8),
                  let key = Data(base64Encoded: b64), key.count == E2EE.keyBytes
            else { continue }
            return key
        }
        return nil
    }
}
