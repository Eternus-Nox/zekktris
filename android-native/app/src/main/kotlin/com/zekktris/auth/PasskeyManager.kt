package com.zekktris.auth

import android.content.Context
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.CredentialManager
import androidx.credentials.GetCredentialRequest
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.NoCredentialException

/** The user dismissed the system passkey sheet. */
class PasskeyCancelled : Exception("Passkey cancelled")
/** No passkey is available on this device for an assertion. */
class PasskeyNoneAvailable : Exception("No passkey available")

/**
 * Drives the Android CredentialManager passkey (WebAuthn) ceremonies. The server
 * issues the WebAuthn options JSON (same format the browser gets); we hand it
 * straight to CredentialManager as its requestJson and return the response JSON
 * verbatim for the server to verify — mirroring the iOS PasskeyManager, but via
 * the platform Credential Manager instead of ASAuthorization.
 *
 * REQUIRES (owner setup): zekktris.com must publish /.well-known/assetlinks.json
 * listing this app's package (`com.zekktris.android`) + its signing-cert SHA-256,
 * or the platform refuses the ceremony with a security error. The [context]
 * MUST be an Activity so the system sheet can present.
 */
object PasskeyManager {

    /** Register a new passkey; returns the WebAuthn registration response JSON. */
    suspend fun register(context: Context, optionsJson: String): String {
        val cm = CredentialManager.create(context)
        try {
            val resp = cm.createCredential(context, CreatePublicKeyCredentialRequest(optionsJson))
            return (resp as CreatePublicKeyCredentialResponse).registrationResponseJson
        } catch (e: CreateCredentialCancellationException) {
            throw PasskeyCancelled()
        }
    }

    /** Assert an existing passkey; returns the WebAuthn authentication response JSON. */
    suspend fun authenticate(context: Context, optionsJson: String): String {
        val cm = CredentialManager.create(context)
        val req = GetCredentialRequest(listOf(GetPublicKeyCredentialOption(optionsJson)))
        try {
            val resp = cm.getCredential(context, req)
            val cred = resp.credential as? PublicKeyCredential
                ?: throw IllegalStateException("Unexpected credential type")
            return cred.authenticationResponseJson
        } catch (e: GetCredentialCancellationException) {
            throw PasskeyCancelled()
        } catch (e: NoCredentialException) {
            throw PasskeyNoneAvailable()
        }
    }
}
