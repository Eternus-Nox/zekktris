package com.zekktris.crypto

import android.util.Base64
import java.security.MessageDigest
import java.security.SecureRandom
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.GCMParameterSpec
import javax.crypto.spec.SecretKeySpec

/**
 * End-to-end encryption for DMs, ported to match `apps/web/src/lib/e2ee.ts` and
 * `ios-native/Zekktris/E2EE.swift` **byte-for-byte** so native, web, and iOS
 * users interoperate.
 *
 * Scheme (all values must match the other clients exactly):
 *   • Key:       PBKDF2-HMAC-SHA256(UTF8(password), salt, 250 000 iters) → 32 bytes
 *   • Salt:      16 random bytes, standard base64
 *   • Verifier:  base64( SHA-256( key ‖ UTF8("zkE2EE/verify-v2") ) )
 *   • PurgeProof: base64( SHA-256( key ‖ UTF8("zkE2EE/purge-v1") ) )
 *   • Cipher:    AES-256-GCM, 12-byte random IV, 16-byte tag
 *   • Wire:      "zkE2EE/3:" + base64( iv(12) ‖ ciphertext ‖ tag(16) )
 *   • Base64:    standard (RFC 4648) with padding
 *
 * PBKDF2 is implemented by hand (HMAC-SHA256 over the raw UTF-8 password bytes)
 * rather than via PBEKeySpec — the JCE's char[]→bytes conversion is not
 * guaranteed to be UTF-8 across devices, which would break cross-platform keys.
 */
object E2EE {
    private const val WIRE_V3 = "zkE2EE/3:"
    private const val WIRE_V2 = "zkE2EE/2:" // legacy XSalsa20 — recognized, not decryptable
    private const val WIRE_V1 = "zkE2EE/1:" // legacy per-user keypair — ditto
    private const val KEY_BYTES = 32
    private const val IV_BYTES = 12
    private const val TAG_BITS = 128
    private const val SALT_BYTES = 16
    private const val PBKDF2_ITERS = 250_000
    private const val VERIFIER_TAG = "zkE2EE/verify-v2"
    private const val PURGE_PROOF_TAG = "zkE2EE/purge-v1"

    private val rng = SecureRandom()

    /** Does this content look like an encrypted message? */
    fun isEncrypted(s: String): Boolean = s.startsWith(WIRE_V3) || s.startsWith(WIRE_V2) || s.startsWith(WIRE_V1)

    /** Only v3 is decryptable; legacy v2/v1 render as tombstones. */
    fun isDecryptable(s: String): Boolean = s.startsWith(WIRE_V3)

    // ── Key derivation ──────────────────────────────────────────────────────

    /** Fresh 16-byte PBKDF2 salt, standard base64. */
    fun generateSalt(): String {
        val b = ByteArray(SALT_BYTES).also { rng.nextBytes(it) }
        return Base64.encodeToString(b, Base64.NO_WRAP)
    }

    /** Derive the 32-byte shared key from a password + base64 salt (or null). */
    fun deriveKey(password: String, saltBase64: String): ByteArray? {
        val salt = runCatching { Base64.decode(saltBase64, Base64.DEFAULT) }.getOrNull() ?: return null
        return runCatching { pbkdf2(password.toByteArray(Charsets.UTF_8), salt, PBKDF2_ITERS, KEY_BYTES) }.getOrNull()
    }

    /** base64( SHA-256( key ‖ "zkE2EE/verify-v2" ) ) — proves the password without leaking the key. */
    fun verifier(key: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(key)
        md.update(VERIFIER_TAG.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(md.digest(), Base64.NO_WRAP)
    }

    /**
     * base64( SHA-256( key ‖ "zkE2EE/purge-v1" ) ) — [verifier] with its own tag.
     * Sent on enable (the server keeps only its hash) and on disable; unlike the
     * verifier the server never hands it out, so only a key holder can purge the
     * history. Golden vector (shared with apps/web/test/e2eePurgeProof.test.ts and
     * ios-native/ZekktrisTests): key YimdlwXN5XtC7BY6H+EsKc8JTSMycfv9Cl2dBSNg2wo=
     * → rH+DBSWbET5wJGN0x8XwSqpgiPhCc4wJtxgKv+fbaQI=
     */
    fun purgeProof(key: ByteArray): String {
        val md = MessageDigest.getInstance("SHA-256")
        md.update(key)
        md.update(PURGE_PROOF_TAG.toByteArray(Charsets.UTF_8))
        return Base64.encodeToString(md.digest(), Base64.NO_WRAP)
    }

    // ── Encrypt / decrypt ───────────────────────────────────────────────────

    /** Encrypt plaintext → wire string, or null on failure. */
    fun encrypt(plaintext: String, key: ByteArray): String? {
        if (key.size != KEY_BYTES) return null
        return runCatching {
            val iv = ByteArray(IV_BYTES).also { rng.nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            // Java GCM doFinal returns ciphertext ‖ tag — prepend the IV.
            val ctTag = cipher.doFinal(plaintext.toByteArray(Charsets.UTF_8))
            WIRE_V3 + Base64.encodeToString(iv + ctTag, Base64.NO_WRAP)
        }.getOrNull()
    }

    /** Decrypt a wire string → plaintext, or null (wrong key / tampered / legacy). */
    fun decrypt(wire: String, key: ByteArray): String? {
        if (key.size != KEY_BYTES || !wire.startsWith(WIRE_V3)) return null
        return runCatching {
            val combined = Base64.decode(wire.substring(WIRE_V3.length), Base64.DEFAULT)
            if (combined.size < IV_BYTES + TAG_BITS / 8) return null
            val iv = combined.copyOfRange(0, IV_BYTES)
            val ctTag = combined.copyOfRange(IV_BYTES, combined.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            String(cipher.doFinal(ctTag), Charsets.UTF_8)
        }.getOrNull()
    }

    // ── Attachment bytes (cross-platform wire: iv(12) ‖ ciphertext ‖ tag(16)) ─

    /**
     * Encrypt raw attachment bytes with the channel key. Output layout matches
     * iOS `E2EE.encryptData` and web `encryptBytesForDm` exactly:
     * iv(12) ‖ ciphertext ‖ tag(16) — unwrapped binary, no base64, no prefix.
     * The uploaded filename gets a ".zke" suffix wrapping the inner name.
     */
    fun encryptBytes(plaintext: ByteArray, key: ByteArray): ByteArray? {
        if (key.size != KEY_BYTES) return null
        return runCatching {
            val iv = ByteArray(IV_BYTES).also { rng.nextBytes(it) }
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.ENCRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            // Java GCM doFinal returns ciphertext ‖ tag — prepend the IV.
            iv + cipher.doFinal(plaintext)
        }.getOrNull()
    }

    /** Decrypt attachment bytes produced by [encryptBytes] (or the iOS/web
     *  equivalents). Null on wrong key / tampering / malformed blob. */
    fun decryptBytes(blob: ByteArray, key: ByteArray): ByteArray? {
        if (key.size != KEY_BYTES || blob.size <= IV_BYTES + TAG_BITS / 8) return null
        return runCatching {
            val iv = blob.copyOfRange(0, IV_BYTES)
            val ctTag = blob.copyOfRange(IV_BYTES, blob.size)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, SecretKeySpec(key, "AES"), GCMParameterSpec(TAG_BITS, iv))
            cipher.doFinal(ctTag)
        }.getOrNull()
    }

    // ── PBKDF2-HMAC-SHA256 (manual, UTF-8 password) ─────────────────────────

    private fun pbkdf2(password: ByteArray, salt: ByteArray, iterations: Int, dkLen: Int): ByteArray {
        val mac = Mac.getInstance("HmacSHA256")
        mac.init(SecretKeySpec(password, "HmacSHA256"))
        val hLen = mac.macLength
        val numBlocks = (dkLen + hLen - 1) / hLen
        val dk = ByteArray(dkLen)
        var offset = 0
        for (block in 1..numBlocks) {
            // U1 = HMAC(P, salt ‖ INT_32_BE(block))
            mac.update(salt)
            var u = mac.doFinal(byteArrayOf((block ushr 24).toByte(), (block ushr 16).toByte(), (block ushr 8).toByte(), block.toByte()))
            val t = u.copyOf()
            for (i in 1 until iterations) {
                u = mac.doFinal(u) // U_{i+1} = HMAC(P, U_i)
                for (j in t.indices) t[j] = (t[j].toInt() xor u[j].toInt()).toByte()
            }
            val cnt = minOf(hLen, dkLen - offset)
            System.arraycopy(t, 0, dk, offset, cnt)
            offset += cnt
        }
        return dk
    }
}
