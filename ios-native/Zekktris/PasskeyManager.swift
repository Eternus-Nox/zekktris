import AuthenticationServices
import UIKit

/// Errors surfaced from a passkey ceremony. `.cancelled` is the user dismissing
/// the system sheet — callers treat it as a no-op (no error toast).
enum PasskeyError: LocalizedError {
    case cancelled
    case unexpected
    var errorDescription: String? {
        switch self {
        case .cancelled: return nil
        case .unexpected: return "Passkey operation could not be completed."
        }
    }
}

extension Data {
    /// base64url (RFC 4648 §5) without padding — the WebAuthn wire encoding.
    var base64URLString: String {
        base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
    init?(base64URLEncoded s: String) {
        var b = s.replacingOccurrences(of: "-", with: "+").replacingOccurrences(of: "_", with: "/")
        while b.count % 4 != 0 { b += "=" }
        self.init(base64Encoded: b)
    }
}

/**
 * Drives the platform (iCloud Keychain) passkey ceremonies via
 * AuthenticationServices and translates the results into the WebAuthn JSON the
 * server (`@simplewebauthn`) expects. The relying-party id MUST match the
 * server's rpID (the web domain) AND the app's `webcredentials:` associated
 * domain, or the system sheet won't offer/save a credential.
 *
 * The ASAuthorizationController API is delegate-based; we bridge it to async
 * with a continuation and keep `self` alive for the ceremony's duration.
 */
@MainActor
final class PasskeyManager: NSObject {
    /// Must equal the server rpID (hostname of PUBLIC_URL) and the
    /// `webcredentials:` entry in the app's associated-domains entitlement.
    static let rpID = "zekktris.com"

    /// A human label stored with the credential (UIDevice gives "iPhone"/"iPad").
    static var currentDeviceName: String { UIDevice.current.model }

    private var continuation: CheckedContinuation<ASAuthorization, Error>?
    private var keepAlive: PasskeyManager?

    /// Run a registration ceremony; returns the RegistrationResponseJSON dict.
    func performRegistration(challenge: Data, userID: Data, userName: String) async throws -> [String: Any] {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: Self.rpID)
        let request = provider.createCredentialRegistrationRequest(
            challenge: challenge, name: userName, userID: userID,
        )
        let auth = try await run([request])
        guard
            let reg = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialRegistration,
            let attestation = reg.rawAttestationObject
        else { throw PasskeyError.unexpected }
        let inner: [String: Any] = [
            "clientDataJSON": reg.rawClientDataJSON.base64URLString,
            "attestationObject": attestation.base64URLString,
            "transports": ["internal"],
        ]
        return [
            "id": reg.credentialID.base64URLString,
            "rawId": reg.credentialID.base64URLString,
            "type": "public-key",
            "response": inner,
            "clientExtensionResults": [String: Any](),
        ]
    }

    /// Run an assertion (login) ceremony; returns the AuthenticationResponseJSON dict.
    func performAssertion(challenge: Data) async throws -> [String: Any] {
        let provider = ASAuthorizationPlatformPublicKeyCredentialProvider(relyingPartyIdentifier: Self.rpID)
        let request = provider.createCredentialAssertionRequest(challenge: challenge)
        let auth = try await run([request])
        guard let a = auth.credential as? ASAuthorizationPlatformPublicKeyCredentialAssertion else {
            throw PasskeyError.unexpected
        }
        var inner: [String: Any] = [
            "clientDataJSON": a.rawClientDataJSON.base64URLString,
            "authenticatorData": a.rawAuthenticatorData.base64URLString,
            "signature": a.signature.base64URLString,
        ]
        if let userHandle = a.userID { inner["userHandle"] = userHandle.base64URLString }
        return [
            "id": a.credentialID.base64URLString,
            "rawId": a.credentialID.base64URLString,
            "type": "public-key",
            "response": inner,
            "clientExtensionResults": [String: Any](),
        ]
    }

    private func run(_ requests: [ASAuthorizationRequest]) async throws -> ASAuthorization {
        keepAlive = self // ASAuthorizationController holds the delegate weakly.
        return try await withCheckedThrowingContinuation { cont in
            continuation = cont
            let controller = ASAuthorizationController(authorizationRequests: requests)
            controller.delegate = self
            controller.presentationContextProvider = self
            controller.performRequests()
        }
    }
}

extension PasskeyManager: ASAuthorizationControllerDelegate {
    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithAuthorization authorization: ASAuthorization,
    ) {
        let c = continuation
        continuation = nil
        keepAlive = nil
        c?.resume(returning: authorization)
    }

    func authorizationController(
        controller: ASAuthorizationController,
        didCompleteWithError error: Error,
    ) {
        let c = continuation
        continuation = nil
        keepAlive = nil
        if let e = error as? ASAuthorizationError, e.code == .canceled {
            c?.resume(throwing: PasskeyError.cancelled)
        } else {
            c?.resume(throwing: error)
        }
    }
}

extension PasskeyManager: ASAuthorizationControllerPresentationContextProviding {
    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        let scene = scenes.first { $0.activationState == .foregroundActive } ?? scenes.first
        return scene?.windows.first(where: { $0.isKeyWindow }) ?? scene?.windows.first ?? UIWindow()
    }
}
