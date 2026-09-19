import Intents

/// Siri on the Apple Watch: "send a message to <name> on Zekktris", raised
/// from the wrist, sent from the wrist.
///
/// The watch needs its OWN Intents extension — Siri on watchOS doesn't hand
/// the request to the phone's. Its `IntentsSupported` must be a subset of the
/// iPhone extension's (both are just INSendMessageIntent).
///
/// PROVISIONING — like the iPhone extension, this carries
/// `com.apple.developer.siri`, so SiriKit has to be enabled for
/// `com.zekktris.native.watchkitapp` and `com.zekktris.native.watchkitapp.intents`
/// in the Apple Developer portal, or signing fails.
final class IntentHandler: INExtension {
    override func handler(for intent: INIntent) -> Any {
        if intent is INSendMessageIntent { return WatchSendMessageIntentHandler() }
        return self
    }
}
