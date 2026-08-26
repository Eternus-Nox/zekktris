package com.zekktris.crypto

import android.content.Context
import android.content.SharedPreferences
import android.util.Base64
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey

/**
 * Keystore-backed storage for the per-DM derived E2EE keys (the iOS keychain
 * equivalent). Keys are the raw PBKDF2 output, base64, encrypted at rest by the
 * Android Keystore via EncryptedSharedPreferences. If the secure store can't be
 * created on a device, we fail closed (no persistence) — the user just re-enters
 * the password — rather than falling back to plaintext.
 */
class E2EEKeyStore(context: Context) {
    private val prefs: SharedPreferences? = runCatching {
        val master = MasterKey.Builder(context)
            .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
            .build()
        EncryptedSharedPreferences.create(
            context,
            "zk_e2ee_keys",
            master,
            EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
            EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM,
        )
    }.getOrNull()

    fun key(channelId: String): ByteArray? =
        prefs?.getString(channelId, null)?.let { runCatching { Base64.decode(it, Base64.NO_WRAP) }.getOrNull() }

    fun put(channelId: String, key: ByteArray) {
        prefs?.edit()?.putString(channelId, Base64.encodeToString(key, Base64.NO_WRAP))?.apply()
    }

    fun remove(channelId: String) {
        prefs?.edit()?.remove(channelId)?.apply()
    }

    fun clearAll() {
        prefs?.edit()?.clear()?.apply()
    }
}
