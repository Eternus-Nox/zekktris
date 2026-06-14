import Foundation
import Security

/// Minimal Keychain wrapper for persisting credentials and E2EE keys across
/// launches. Stored as generic-password items scoped to the app's service id.
/// We use the Keychain (not UserDefaults) because these are secrets.
///
/// `accessGroup` is optional: pass the shared App Group identifier
/// (`AppGroupConfig.identifier`) to store items where the Notification Service
/// Extension can also read them (used for E2EE message-preview decryption).
/// Leave it nil for items that only the app needs (the default group), which
/// keeps their existing storage location unchanged across an update.
struct KeychainStore {
    private let service = AppGroupConfig.keychainService
    private let accessGroup: String?

    init(accessGroup: String? = nil) {
        self.accessGroup = accessGroup
    }

    /// Common attributes for every query/item. Includes the access group only
    /// when one was configured, so the default-group store behaves exactly as
    /// before (items land in the app's primary access group).
    private func base(account: String? = nil) -> [String: Any] {
        var q: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
        ]
        if let account { q[kSecAttrAccount as String] = account }
        if let accessGroup { q[kSecAttrAccessGroup as String] = accessGroup }
        return q
    }

    /// Store (replacing any existing item). Returns the `SecItemAdd` status so
    /// callers can detect a missing-entitlement failure (e.g. the App Group
    /// isn't provisioned yet) and fall back.
    @discardableResult
    func set(_ value: String, for key: String) -> OSStatus {
        let data = Data(value.utf8)
        let base = base(account: key)
        // Replace any existing item: delete then add keeps this idempotent.
        SecItemDelete(base as CFDictionary)
        var add = base
        add[kSecValueData as String] = data
        add[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlock
        return SecItemAdd(add as CFDictionary, nil)
    }

    func get(_ key: String) -> String? {
        var query = base(account: key)
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var item: CFTypeRef?
        guard SecItemCopyMatching(query as CFDictionary, &item) == errSecSuccess,
              let data = item as? Data,
              let value = String(data: data, encoding: .utf8)
        else { return nil }
        return value
    }

    func delete(_ key: String) {
        SecItemDelete(base(account: key) as CFDictionary)
    }

    /// All (account, value) pairs in this service whose account starts with
    /// `prefix`. Used to gather every stored E2EE key for a backup export.
    func allValues(prefix: String) -> [(account: String, value: String)] {
        var query = base()
        query[kSecReturnAttributes as String] = true
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitAll
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
