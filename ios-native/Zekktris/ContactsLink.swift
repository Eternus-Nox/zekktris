import Contacts
import ContactsUI
import SwiftUI
import os.log

/// Console.app: subsystem `com.zekktris.native`, category `contacts`. Editing
/// someone's card is a write into another app's data, and every way it can fail
/// is invisible from the outside.
private let contactsLog = Logger(subsystem: "com.zekktris.native", category: "contacts")

/// Putting a Zekktris account onto someone's CONTACT CARD, as an
/// instant-message entry with the service "Zekktris".
///
/// WHY THIS EXISTS. Siri resolves "message Sam Rivera on Zekktris" through
/// Contacts, not through us: the card is the only thing that maps what you CALL
/// someone to an account. Without an entry there you have to say the display
/// name or username Zekktris knows them by, and "SRivera1337" is not a thing
/// anyone says out loud.
///
/// THE WRITE IS DONE BY iOS, NOT BY US — see AddToContactsSheet. An earlier
/// version picked a contact and wrote through CNContactStore, which has three
/// ways to fail silently on a real device: the card a picker returns is a
/// UNIFIED view (the merge of the same person across iCloud, Google, Exchange)
/// that is not always writable; iOS 18's limited-access grant does not cover a
/// card merely because it was picked; and the whole path needs a permission the
/// user can refuse. The system sheet has none of those problems — no permission
/// at all, the write lands on the right underlying card, and we are handed the
/// identifier only if the user actually saved.
enum ContactsLink {
    /// The service name written to the card, and what a user says after "on".
    /// Keep it the app's display name — the convention other messaging apps
    /// follow, and what Siri reads back.
    static let service = "Zekktris"

    enum Outcome: Equatable {
        case linked(contactName: String)
        case unlinked(contactName: String)
        case permissionDenied
        case failed(String)
    }

    /// Write the entry onto a card ourselves.
    ///
    /// MEASURED, not assumed: a probe app on the simulator confirmed iOS keeps
    /// a custom `service` ("Zekktris") through both a create-with-entry and an
    /// add-to-existing save, and reads it straight back. So this path works —
    /// the earlier failures were a denied permission and an alert that was
    /// swallowed while the picker dismissed, not the framework refusing the
    /// custom service.
    ///
    /// Requires authorization. When that isn't available the caller falls back
    /// to AddToContactsSheet, which needs none.
    static func link(username: String, userId: String, toContactWithId contactId: String) -> Outcome {
        let store = CNContactStore()
        let keys: [CNKeyDescriptor] = [
            CNContactInstantMessageAddressesKey as CNKeyDescriptor,
            CNContactFormatter.descriptorForRequiredKeys(for: .fullName),
        ]
        do {
            let contact = try store.unifiedContact(withIdentifier: contactId, keysToFetch: keys)
            let name = CNContactFormatter.string(from: contact, style: .fullName) ?? "that contact"
            guard let unified = contact.mutableCopy() as? CNMutableContact else {
                return .failed("Couldn't edit that contact.")
            }
            addEntry(to: unified, username: username)
            do {
                let save = CNSaveRequest()
                save.update(unified)
                try store.execute(save)
            } catch {
                // The merged view of a person across several accounts is not
                // always writable; the record behind it is.
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
            // entry, and "saved" while Contacts shows nothing is the worst
            // possible answer.
            let after = try? store.unifiedContact(withIdentifier: contactId, keysToFetch: keys)
            let present = after?.instantMessageAddresses.contains {
                $0.value.service.caseInsensitiveCompare(service) == .orderedSame
                    && $0.value.username == username
            } ?? false
            guard present else {
                contactsLog.error("save succeeded but the entry is not on the card")
                return .failed(
                    "Contacts accepted the change but didn't keep it. Add it by hand: the card › Edit › instant message › service \"Zekktris\", username \(username).",
                )
            }
            ContactLinks.set(contactId: contactId, contactName: name, forUserId: userId)
            return .linked(contactName: name)
        } catch {
            contactsLog.error("contact write failed: \(error.localizedDescription, privacy: .public)")
            return .failed(error.localizedDescription)
        }
    }

    /// Replace any earlier Zekktris entry for this account, then add this one,
    /// so re-linking can't stack duplicates on one card.
    private static func addEntry(to contact: CNMutableContact, username: String) {
        contact.instantMessageAddresses = contact.instantMessageAddresses.filter {
            $0.value.service.caseInsensitiveCompare(service) != .orderedSame
                || $0.value.username != username
        }
        contact.instantMessageAddresses.append(
            CNLabeledValue(
                label: CNLabelOther,
                value: CNInstantMessageAddress(username: username, service: service),
            ),
        )
    }

    /// Remember which card an account was saved onto. Siri matches a card to a
    /// conversation through `INPerson.contactIdentifier`, so this is what the
    /// donation and the Siri extension stamp onto their recipients.
    static func remember(userId: String, contactId: String, contactName: String?) {
        ContactLinks.set(contactId: contactId, contactName: contactName, forUserId: userId)
    }

    /// Take the Zekktris entry back off a card and forget the link.
    ///
    /// Unlike adding, removing genuinely needs write access — there is no
    /// system sheet for "delete this one field". The stored mapping is cleared
    /// either way, including when the card is gone: leaving it behind would
    /// keep stamping a contact identifier onto donations for a card that no
    /// longer claims the account.
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
                // The unified view is not always writable; the real card behind
                // it is.
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
                "Unlinked here, but the card couldn't be edited — remove the \"Zekktris\" instant message entry in Contacts by hand.",
            )
        }
    }

    /// Drop only OUR entry for this account. A second Zekktris handle on the
    /// same card (another account) is left alone.
    private static func removeEntry(from contact: CNMutableContact, username: String) {
        contact.instantMessageAddresses = contact.instantMessageAddresses.filter {
            !($0.value.service.caseInsensitiveCompare(service) == .orderedSame
                && $0.value.username == username)
        }
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

    /// Write access, needed only for UNLINKING. iOS 18's limited grant counts:
    /// it covers the cards the user has let this app see, which is where an
    /// existing link lives.
    static func requestAccess() async -> Bool {
        let status = CNContactStore.authorizationStatus(for: .contacts)
        switch status {
        case .authorized, .limited:
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
}

/// The system contact picker. Choosing a card needs no permission — the picker
/// runs out of process — but WRITING to it does, which is why the caller only
/// reaches this after `requestAccess()` succeeds.
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

/// The system's own "Add to Contacts" sheet, pre-filled with the Zekktris
/// handle — the same flow as tapping a phone number on a web page. iOS offers
/// "Create New Contact" or "Add to Existing Contact" and performs the write
/// itself, so the app needs no Contacts access at all.
struct AddToContactsSheet: UIViewControllerRepresentable {
    /// The Zekktris username, written as the instant-message handle.
    let username: String
    /// A starting point for a NEW card only; adding to an existing one ignores it.
    let suggestedName: String
    /// The saved card's identifier and name, or nils if the user backed out.
    var onDone: (String?, String?) -> Void

    func makeUIViewController(context: Context) -> UINavigationController {
        let draft = CNMutableContact()
        draft.givenName = suggestedName
        draft.instantMessageAddresses = [
            CNLabeledValue(
                label: CNLabelOther,
                value: CNInstantMessageAddress(username: username, service: ContactsLink.service),
            ),
        ]
        let controller = CNContactViewController(forUnknownContact: draft)
        controller.contactStore = CNContactStore()
        controller.delegate = context.coordinator
        controller.allowsActions = true
        controller.allowsEditing = true
        controller.navigationItem.leftBarButtonItem = UIBarButtonItem(
            barButtonSystemItem: .cancel,
            target: context.coordinator,
            action: #selector(Coordinator.cancel),
        )
        return UINavigationController(rootViewController: controller)
    }

    func updateUIViewController(_ controller: UINavigationController, context: Context) {}

    func makeCoordinator() -> Coordinator { Coordinator(self) }

    final class Coordinator: NSObject, CNContactViewControllerDelegate {
        private let parent: AddToContactsSheet
        init(_ parent: AddToContactsSheet) { self.parent = parent }

        @objc func cancel() { parent.onDone(nil, nil) }

        /// `contact` is nil when they cancelled, and the saved card — new or
        /// existing — when they didn't.
        func contactViewController(
            _ viewController: CNContactViewController, didCompleteWith contact: CNContact?,
        ) {
            let name = contact.flatMap { CNContactFormatter.string(from: $0, style: .fullName) }
            parent.onDone(contact?.identifier, name)
        }
    }
}
