import Contacts
import ContactsUI
import SwiftUI

/// Putting a Zekktris account onto someone's CONTACT CARD, as an
/// instant-message entry with the service "Zekktris".
///
/// WHY THIS EXISTS. Siri resolves "message Mom on Zekktris" through Contacts,
/// not through us: the contact card is the only place that maps what you CALL
/// someone to an account. Without it you have to say the display name or
/// username Zekktris knows them by, which is usually not what you call them —
/// and a username like "alexjmorgan94" is not a thing anyone says out loud.
///
/// With the entry in place, iOS hands our Siri extension the IM username as the
/// person handle (and the contact's real name as the display name), and
/// SiriDirectory matches on the handle — see SendMessageIntentHandler.
///
/// Writing to Contacts needs `NSContactsUsageDescription` and the user's
/// permission. Picking a contact does NOT: CNContactPickerViewController runs
/// out of process, so nothing is read until they choose someone.
enum ContactsLink {
    /// The service name written to the card, and what a user says after "on".
    /// Keep it the app's display name — that is the convention other messaging
    /// apps follow and what Siri reads back.
    static let service = "Zekktris"

    enum Outcome: Equatable {
        case linked(contactName: String)
        case permissionDenied
        case failed(String)
    }

    /// Ask for write access. Returns false when the user says no (or has said
    /// no before — iOS does not re-prompt).
    static func requestAccess() async -> Bool {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        switch status {
        case .authorized:
            return true
        case .notDetermined:
            return await withCheckedContinuation { continuation in
                CNContactStore().requestAccess(for: .contacts) { granted, _ in
                    continuation.resume(returning: granted)
                }
            }
        default:
            return false
        }
    }

    /// Add the Zekktris instant-message entry to a contact, replacing any
    /// earlier one for the same service so repeated linking can't stack up
    /// duplicate handles on one card.
    static func link(username: String, userId: String, toContactWithId contactId: String) -> Outcome {
        let store = CNContactStore()
        // The formatted name is assembled from several fields, so it comes
        // from the formatter's own descriptor rather than a single key.
        let keys: [CNKeyDescriptor] = [
            CNContactInstantMessageAddressesKey as CNKeyDescriptor,
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        ]
        do {
            // Re-fetch: the contact handed back by the picker carries only the
            // keys the picker asked for, and mutating a partially-fetched
            // contact throws.
            let contact = try store.unifiedContact(withIdentifier: contactId, keysToFetch: keys)
            guard let mutable = contact.mutableCopy() as? CNMutableContact else {
                return .failed("Couldn't edit that contact.")
            }
            mutable.instantMessageAddresses = mutable.instantMessageAddresses.filter {
                $0.value.service.caseInsensitiveCompare(service) != .orderedSame
            }
            mutable.instantMessageAddresses.append(
                CNLabeledValue(
                    label: CNLabelOther,
                    value: CNInstantMessageAddress(username: username, service: service),
                ),
            )
            let save = CNSaveRequest()
            save.update(mutable)
            try store.execute(save)
            // The entry on the card is only half of it. Siri matches a card to a
            // conversation through INPerson.contactIdentifier, so remember which
            // card this account belongs to and stamp it on every donation and
            // every recipient the Siri extension resolves.
            ContactLinks.set(contactId: contactId, forUserId: userId)
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? "that contact"
            return .linked(contactName: name)
        } catch {
            return .failed(error.localizedDescription)
        }
    }
}

/// The system contact picker, as a SwiftUI sheet. Deliberately thin: it hands
/// back the identifier and ContactsLink does the writing.
struct ContactPickerSheet: UIViewControllerRepresentable {
    var onPick: (String) -> Void
    var onCancel: () -> Void

    func makeUIViewController(context: Context) -> CNContactPickerViewController {
        let picker = CNContactPickerViewController()
        picker.delegate = context.coordinator
        return picker
    }

    func updateUIViewController(_ picker: CNContactPickerViewController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, CNContactPickerDelegate {
        private let parent: ContactPickerSheet
        init(_ parent: ContactPickerSheet) { self.parent = parent }

        func contactPicker(_ picker: CNContactPickerViewController, didSelect contact: CNContact) {
            parent.onPick(contact.identifier)
        }

        func contactPickerDidCancel(_ picker: CNContactPickerViewController) {
            parent.onCancel()
        }
    }
}
