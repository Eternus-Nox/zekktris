import Foundation

/// Configuration shared between the main app and the Notification Service
/// Extension. The two processes don't share memory, but they DO share the
/// app-group keychain — that's how the extension reads the per-DM E2EE keys it
/// needs to decrypt message previews on-device.
///
/// IMPORTANT — provisioning: `identifier` must be registered as an **App
/// Group** in the Apple Developer account and enabled (Xcode → Signing &
/// Capabilities → App Groups) on BOTH the `Zekktris` app target and the
/// `NotificationService` extension target. If it isn't, the shared-keychain
/// reads/writes fail with `errSecMissingEntitlement`, the app transparently
/// falls back to its private keychain group (so messaging still works), and
/// encrypted notifications simply show the "Encrypted message" fallback
/// instead of the decrypted text.
enum AppGroupConfig {
    /// The shared App Group, used here as a keychain access group (valid on
    /// iOS). Change this in lockstep with the entitlements in `project.yml`.
    static let identifier = "group.com.zekktris.native"

    /// Keychain service id every credential/key is stored under. Shared so the
    /// app's `KeychainStore` and the extension's `SharedKeychain` agree.
    static let keychainService = "com.zekktris.native"
}
