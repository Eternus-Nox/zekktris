import AppIntents
import ExtensionFoundation

/// The process Siri on the watch runs "message Sam on Zekktris" in.
///
/// WHY AN EXTENSION. The send intent first lived in the watch APP. Siri found
/// it — matched the phrase, resolved the person, asked "What do you want to
/// say?" — and then answered "You'll need a watch app for that" at the moment
/// it had to run `perform()`. watchOS will not launch a watch app in the
/// background to perform an App Intent for Siri; an App Intents EXTENSION is
/// the process it runs them in. The Poke complication already proved this
/// shape on this watch: its intent runs inside the widget extension.
///
/// Everything Siri needs is here — the intent, the person entity and its
/// query, and the App Shortcuts phrases — because the system reads them from
/// the extension's own metadata. It shares the App Group with the watch app
/// (DM list, token, per-DM E2EE keys), exactly as ZekktrisWatchIntents and the
/// widget extension do.
@main
struct ZekktrisWatchAppIntentsExtension: AppIntentsExtension {}
