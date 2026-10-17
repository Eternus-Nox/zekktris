import XCTest
import Foundation

// Note: this is a host-less logic-test target that compiles `E2EE.swift`
// directly (see project.yml › targets › ZekktrisTests), so it needs no
// `@testable import Zekktris` and does NOT link LiveKit — it stays fast and
// dependency-free. `E2EE` is visible because it's in this test module.

/// E2EE 1:1 call-key interop contract (native side).
///
/// A 1:1 DM call keys LiveKit's media E2EE from the DM's shared key. `Voice.connect`
/// passes `e2eeKey.base64EncodedString()` as the shared-key STRING to
/// `BaseKeyProvider(isSharedKey:true, sharedKey:)`, which runs it through
/// libwebrtc's PBKDF2. The web client feeds the IDENTICAL base64 string to
/// `ExternalE2EEKeyProvider.setKey(<string>)` (also PBKDF2). For all four call
/// directions to decrypt, both platforms must:
///   1. derive the same 32-byte DM key from the same (password, salt), and
///   2. hand LiveKit the same base64 string of those bytes.
///
/// These golden vectors are shared with the web test
/// (apps/web/test/e2eeCallKey.test.ts) and were computed independently with
/// Node's crypto. If either side's derivation/encoding drifts, this fails loudly.
final class E2EECallKeyTests: XCTestCase {
    private let password = "correct horse battery staple"
    private let saltB64 = "BwcHBwcHBwcHBwcHBwcHBw=="   // 16 bytes of 0x07
    private let keyB64 = "YimdlwXN5XtC7BY6H+EsKc8JTSMycfv9Cl2dBSNg2wo="
    private let verifierB64 = "FagWYpIz64/IzDGxoQ/uBvRKIrzc+VthN0p/st8h790="
    // base64( SHA-256( key ‖ "zkE2EE/purge-v1" ) ) — same vector as
    // apps/web/test/e2eePurgeProof.test.ts.
    private let purgeProofB64 = "rH+DBSWbET5wJGN0x8XwSqpgiPhCc4wJtxgKv+fbaQI="

    func testDerivesDMKeyToGoldenVector() throws {
        let key = try XCTUnwrap(E2EE.deriveKey(password: password, saltBase64: saltB64))
        XCTAssertEqual(key.count, 32)
        XCTAssertEqual(key.base64EncodedString(), keyB64)
    }

    func testVerifierMatchesGoldenVector() throws {
        let key = try XCTUnwrap(E2EE.deriveKey(password: password, saltBase64: saltB64))
        XCTAssertEqual(E2EE.verifier(forKey: key), verifierB64)
    }

    /// The purge proof gates the server-side purge on disable; it must match
    /// the web client byte for byte or a DM enabled on one platform could
    /// never be turned off from the other.
    func testPurgeProofMatchesGoldenVector() throws {
        let key = try XCTUnwrap(Data(base64Encoded: keyB64))
        XCTAssertEqual(E2EE.purgeProof(forKey: key), purgeProofB64)
        XCTAssertNotEqual(E2EE.purgeProof(forKey: key), E2EE.verifier(forKey: key))
    }

    /// The exact string `Voice.connect` feeds LiveKit's shared-key provider is
    /// `e2eeKey.base64EncodedString()`. Assert it equals the cross-platform
    /// vector — i.e. byte-for-byte what the web client passes to setKey().
    func testCallKeyStringMatchesWebContract() throws {
        let key = try XCTUnwrap(E2EE.deriveKey(password: password, saltBase64: saltB64))
        let liveKitSharedKeyString = key.base64EncodedString()
        XCTAssertEqual(liveKitSharedKeyString, keyB64)
    }

    /// A round-trip sanity check on the message cipher too (unchanged by this
    /// fix, but cheap insurance that the shared key works end to end).
    func testEncryptDecryptRoundTrip() throws {
        let key = try XCTUnwrap(E2EE.deriveKey(password: password, saltBase64: saltB64))
        let wire = try XCTUnwrap(E2EE.encrypt("hello cross-client", key: key))
        XCTAssertTrue(wire.hasPrefix(E2EE.wirePrefixV3))
        XCTAssertEqual(E2EE.decrypt(wire, key: key), "hello cross-client")
    }
}
