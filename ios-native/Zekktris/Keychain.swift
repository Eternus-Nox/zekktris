import Foundation
import Security

/// Minimal Keychain wrapper for persisting the access token across launches.
/// Stored as a generic-password item scoped to the app's service id. We use
/// the Keychain (not UserDefaults) because the token is a credential.
struct KeychainStore {
    private let service = "com.zekktris.native"

    func set(_ value: String, for key: String) {
        let data = Data(value.utf8)
        let base: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        // Replace any existing item: delete then add keeps this idempotent.
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        SecItemAdd(add as CFDictionary, nil)
    }

    func get(_ key: String) -> String? {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitOne,
        ]
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else { return nil }
        return value
    }

    func delete(_ key: String) {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: key,
        ]
        SecItemDelete(query as CFDictionary)
    }

    /// All (account, value) pairs in this service whose account starts with
    /// `prefix`. Used to gather every stored E2EE key for a backup export.
    func allValues(prefix: String) -> [(account: String, value: String)] {
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecReturnAttributes as String: true,
            kSecReturnData as String: true,
            kSecMatchLimit as String: kSecMatchLimitAll,
        ]
        var items: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &items) == errSecSuccess,
              let arr = items as? [[String: Any]] else { return [] }
        var out: [(account: String, value: String)] = []
        for d in arr {
            guard let account = d[kSecAttrAccount as String] as? String, account.hasPrefix(prefix),
                  let data = d[kSecValueData as String] as? Data,
                  let value = String(data: data, encoding: .utf8) else { continue }
            out.append((account, value))
        }
        return out
    }
}
