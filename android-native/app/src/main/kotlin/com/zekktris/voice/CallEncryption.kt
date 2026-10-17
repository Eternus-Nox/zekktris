package com.zekktris.voice

import io.livekit.android.e2ee.BaseKeyProvider
import io.livekit.android.e2ee.E2EEOptions
import livekit.org.webrtc.FrameCryptorKeyDerivationAlgorithm

/**
 * LiveKit media end-to-end encryption for 1:1 calls in an E2EE DM.
 *
 * All three clients key LiveKit's frame encryption with the SAME string: the
 * base64 (RFC 4648, padded) of the DM's 32-byte message key. The web client
 * feeds it to `ExternalE2EEKeyProvider.setKey(<string>)` (apps/web/src/lib/
 * e2ee.ts getCallKeyString) and iOS to `BaseKeyProvider(isSharedKey: true,
 * sharedKey:)` (ios-native/Zekktris/Voice.swift). Both run the UTF-8 bytes of
 * that string through PBKDF2-SHA-256 with the salt "LKFrameEncryptionKey" to get
 * the AES-GCM media key — so this provider has to match them option for option
 * or the call carries no decodable audio/video:
 *  - shared-key mode (one key for every participant),
 *  - PBKDF2 key derivation (not HKDF),
 *  - ratchet salt "LKFrameEncryptionKey" (the SDK default, as on web/iOS),
 *  - ratchet window 0 — web and iOS never auto-ratchet in shared-key mode; the
 *    Android SDK's default of 16 would, on any undecryptable frame, try keys
 *    nobody else derives,
 *  - failure tolerance -1, key ring 16 and AES-GCM as on web/iOS, plus iOS's
 *    "LK-ROCKS" unencrypted-frame magic bytes — all SDK defaults here.
 */
internal object CallEncryption {

    /** E2EE options for a call keyed by [sharedKeyBase64]. Must be built AFTER
     *  `LiveKit.create` (the key provider is a native libwebrtc object, and the
     *  room's construction is what loads that library) and set on the Room
     *  before `connect`. Throws if libwebrtc refuses the key, so the caller can
     *  fail the call instead of connecting unencrypted. */
    fun options(sharedKeyBase64: String): E2EEOptions {
        val provider = BaseKeyProvider(
            ratchetWindowSize = 0,
            enableSharedKey = true,
            keyDerivationAlgorithm = FrameCryptorKeyDerivationAlgorithm.PBKDF2,
        )
        check(provider.setSharedKey(sharedKeyBase64)) { "LiveKit rejected the call key" }
        return E2EEOptions(keyProvider = provider)
    }
}
