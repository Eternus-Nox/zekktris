import Contacts
import ContactsUI
import SwiftUI
import os.log

/// Console.app: subsystem `com.zekktris.native`, category `contacts`. Adding to
/// a card is a write into someone else's app, and every way it can fail is
/// invisible from the outside.
private let contactsLog = Logger(subsystem: "com.zekktris.native", category: "contacts")

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
        case unlinked(contactName: String)
        case permissionDenied
        case failed(String)
    }

    /// Take the Zekktris entry back off a card and forget the link.
    ///
    /// The stored mapping is cleared even when the card can't be written —
    /// including when it no longer exists. Leaving it behind would keep
    /// stamping a contact identifier onto donations for a card that no longer
    /// claims this account, which is worse than a stale entry in Contacts the
    /// user can see and delete.
    static func unlink(username: String, userId: String, fromContactWithId contactId: String) -> Outcome {
        let store = CNContactStore()
        let keys: [CNKeyDescriptor] = [
            CNContactInstantMessageAddressesKey as CNKeyDescriptor,
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        ]
        defer { ContactLinks.clear(userId: userId) }
        do {
            let contact = try store.unifiedContact(withIdentifier: contactId, keysToFetch: keys)
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? "that contact"
            guard let unified = contact.mutableCopy() as? CNMutableContact else {
                return .failed("Couldn't edit that contact.")
            }
            removeEntry(from: unified, username: username)
            do {
                let save = CNSaveRequest()
                save.update(unified)
                try store.execute(save)
            } catch {
                contactsLog.error(
                    "unified unlink failed, trying the backing card: \(error.localizedDescription, privacy: .public)",
                )
                guard let backing = try backingContact(id: contactId, store: store, keys: keys) else {
                    throw error
                }
                removeEntry(from: backing, username: username)
                let retry = CNSaveRequest()
                retry.update(backing)
                try store.execute(retry)
            }
            return .unlinked(contactName: name)
        } catch {
            contactsLog.error("contact unlink failed: \(error.localizedDescription, privacy: .public)")
            return .failed(
                "Removed the link, but couldn't edit the card — delete the \"Zekktris\" instant message entry there by hand.",
            )
        }
    }

    /// Drop only OUR entry for this account. Another Zekktris handle on the
    /// same card (a second account) is left alone.
    private static func removeEntry(from contact: CNMutableContact, username: String) {
        contact.instantMessageAddresses = contact.instantMessageAddresses.filter {
            !($0.value.service.caseInsensitiveCompare(service) == .orderedSame
                && $0.value.username == username)
        }
    }

    /// Replace any earlier Zekktris entry on this card, then add this one, so
    /// re-linking can't stack duplicate handles on one person.
    private static func addEntry(to contact: CNMutableContact, username: String) {
        contact.instantMessageAddresses = contact.instantMessageAddresses.filter {
            $0.value.service.caseInsensitiveCompare(service) != .orderedSame
        }
        contact.instantMessageAddresses.append(
            CNLabeledValue(
                label: CNLabelOther,
                value: CNInstantMessageAddress(username: username, service: service),
            ),
        )
    }

    /// The actual stored card behind a unified one. `unifyResults = false` is
    /// the whole point: it returns the per-account records rather than the
    /// merged view, and those are writable.
    private static func backingContact(
        id: String, store: CNContactStore, keys: [CNKeyDescriptor],
    ) throws -> CNMutableContact? {
        let request = CNContactFetchRequest(keysToFetch: keys)
        request.predicate = CNContact.predicateForContacts(withIdentifiers: [id])
        request.unifyResults = false
        var found: CNContact?
        try store.enumerateContacts(with: request) { contact, stop in
            found = contact
            stop.pointee = true
        }
        return found?.mutableCopy() as? CNMutableContact
    }

    /// Ask for write access. Returns false when the user says no (or has said
    /// no before — iOS does not re-prompt).
    static func requestAccess() async -> Bool {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        switch status {
        case .authorized:
            return true
        // iOS 18 added a LIMITED grant: the app sees only cards the user has
        // picked. That is exactly this flow — they pick the card themselves —
        // so it is a working state, not a denial. Treating it as denied sent
        // people to Settings for a permission they had already given.
        case .limited:
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
            guard let unified = contact.mutableCopy() as? CNMutableContact else {
                return .failed("Couldn't edit that contact.")
            }
            addEntry(to: unified, username: username)
            do {
                let save = CNSaveRequest()
                save.update(unified)
                try store.execute(save)
            } catch {
                // The picker hands back a UNIFIED card — the merged view of the
                // same person across iCloud, Google, Exchange and so on. That
                // view is not always writable, and this is the failure people
                // actually hit. Fall back to the real card behind it.
                contactsLog.error(
                    "unified save failed, trying the backing card: \(error.localizedDescription, privacy: .public)",
                )
                guard let backing = try backingContact(id: contactId, store: store, keys: keys) else {
                    throw error
                }
                addEntry(to: backing, username: username)
                let retry = CNSaveRequest()
                retry.update(backing)
                try store.execute(retry)
            }
            // Read it back. A save can be accepted and still not produce the
            // entry the user is looking for — a unified card spanning several
            // accounts is the usual reason — and "we saved it" while Contacts
            // shows nothing is the worst possible answer.
            let after = try? store.unifiedContact(withIdentifier: contactId, keysToFetch: keys)
            let present = after?.instantMessageAddresses.contains {
                $0.value.service.caseInsensitiveCompare(service) == .orderedSame
                    && $0.value.username == username
            } ?? false
            guard present else {
                contactsLog.error("save reported success but the entry is not on the card")
                return .failed(
                    "Contacts accepted the change but didn't keep it. This usually means the card is linked across several accounts — open Sam's card in Contacts, tap Edit, and add an Instant Message entry with service \"Zekktris\" and username \(username).",
                )
            }
            // The entry on the card is only half of it. Siri matches a card to a
            // conversation through INPerson.contactIdentifier, so remember which
            // card this account belongs to and stamp it on every donation and
            // every recipient the Siri extension resolves.
            ContactLinks.set(contactId: contactId, forUserId: userId)
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? "that contact"
            return .linked(contactName: name)
        } catch {
            contactsLog.error("contact write failed: \(error.localizedDescription, privacy: .public)")
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
