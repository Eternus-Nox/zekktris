import Intents

/// Siri, Messaging domain: "send a message to <name> on Zekktris".
///
/// WHY AN EXTENSION AND NOT AN IN-APP INTENT. The Messaging domain
/// (`INSendMessageIntent`) is handled out of process — Siri asks this extension
/// to resolve the recipient and send, without ever launching the app. That is
/// also why it needs its own copy of the credentials: it reads the token and
/// the recent conversations the app publishes to the App Group, exactly as the
/// widget does.
///
/// PROVISIONING — this target carries `com.apple.developer.siri`, which is a
/// self-serve capability: enable **SiriKit** for the `com.zekktris.native` App
/// ID in the Apple Developer portal (and it also has to be on the extension's
/// own App ID, `com.zekktris.native.intents`). Without it the build fails to
/// sign the same way the communication-notifications entitlement did — see the
/// note on the app target in project.yml.
final class IntentHandler: INExtension {
    override func handler(for intent: INIntent) -> Any {
        if intent is INSendMessageIntent { return SendMessageIntentHandler() }
        return self
    }
}
