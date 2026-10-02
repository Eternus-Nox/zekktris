import SwiftUI

/// Admin → Users → an account. One page per account, replacing the row's "…"
/// menu of nested actions (web parity: AdminAccountPage.tsx).
///
/// Who sees what (user-decided 2026-09-27; the server enforces all of it, this
/// only avoids offering what the caller can't do):
///   admins      account info, edit username / email / DOB, send password
///               reset, role, membership, mute, ban, sign out, delete, notes,
///               contacts
///   moderators  mute, ban, sign out, DOB unlock, notes — no account info and
///               no contacts, and nothing at all on another staff account.
///
/// Every action calls the API directly and reports inline, because this is a
/// sheet: the app's global error banner sits underneath it and would never be
/// seen. The admin list is patched as actions land so it's right on return.
///
/// Contacts load only when asked for — viewing them writes a staff audit row,
/// so merely opening the page mustn't.
struct AdminAccountView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    let userId: String

    @State private var account: AdminAccount?
    @State private var notes: [StaffNote]?
    @State private var noteDraft = ""
    @State private var contacts: AdminAccountContacts?
    @State private var loadingContacts = false
    @State private var busy = false
    @State private var banner: (text: String, isError: Bool)?

    @State private var editingUsername = false
    @State private var editingEmail = false
    @State private var editingDob = false
    @State private var draft = ""
    @State private var dobDraft = Date()
    @State private var confirmReset = false
    @State private var confirmDelete = false
    @State private var pickMute = false
    @State private var pickBan = false
    @State private var pickRole = false

    /// The live list row — the header and a moderator's whole view read this.
    private var user: AdminUser? { store.adminUsers.first { $0.id == userId } }
    private var selfIsAdmin: Bool { session.currentUser?.isAdmin == true }
    private var isSelf: Bool { session.currentUser?.id == userId }
    private func canModerate(_ u: AdminUser) -> Bool { selfIsAdmin || !u.isStaff }

    var body: some View {
        NavigationStack {
            Group {
                if let u = user {
                    content(u)
                } else {
                    // The row is gone (deleted from this page) — nothing left to show.
                    Color.clear.onAppear { dismiss() }
                }
            }
            .background(Theme.bg1)
            .navigationTitle(user.map { "@\($0.username)" } ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundColor(Theme.ink2)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close")
                }
            }
        }
        .task { await load() }
    }

    // MARK: Layout

    @ViewBuilder
    private func content(_ u: AdminUser) -> some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 12) {
                if let banner {
                    Text(banner.text)
                        .font(.zkSans(13, weight: .medium))
                        .foregroundColor(banner.isError ? Theme.danger : Theme.online)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(10)
                        .background((banner.isError ? Theme.danger : Theme.online).opacity(0.12))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                header(u)
                if selfIsAdmin { accountSection(u) }
                if !isSelf && canModerate(u) { moderationSection(u) }
                if !canModerate(u) {
                    Text("Moderators can't act on staff accounts.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                }
                if canModerate(u) { notesSection(u) }
                if selfIsAdmin { contactsSection(u) }
            }
            .padding(16)
        }
        .disabled(busy)
        .alert("Change username", isPresented: $editingUsername) {
            TextField("username", text: $draft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            Button("Save") { Task { await saveUsername(u) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Doesn't use up their own username-change allowance.")
        }
        .alert("Change email", isPresented: $editingEmail) {
            TextField("email", text: $draft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.emailAddress)
            Button("Save") { Task { await saveEmail(u) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("The new address is treated as verified, and the old address is told it changed.")
        }
        .sheet(isPresented: $editingDob) { dobSheet(u) }
        .confirmationDialog("Send a password reset?", isPresented: $confirmReset, titleVisibility: .visible) {
            Button("Send reset link") { Task { await sendReset(u) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Emails @\(u.username) the standard reset link and signs them out of every device. You never see the link or choose the password.")
        }
        .confirmationDialog("Mute @\(u.username)", isPresented: $pickMute, titleVisibility: .visible) {
            ForEach([("1h", "1 hour"), ("1d", "1 day"), ("1w", "1 week"), ("perm", "Permanent")], id: \.0) { d in
                Button(d.1) { Task { await mute(u, d.0) } }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("They can still sign in and read, but can't send messages or DMs, react, or talk in voice.")
        }
        .confirmationDialog("Ban @\(u.username)", isPresented: $pickBan, titleVisibility: .visible) {
            ForEach([("1m", "1 month"), ("3m", "3 months"), ("6m", "6 months")], id: \.0) { d in
                Button(d.1) { Task { await ban(u, d.0) } }
            }
            Button("Permanent", role: .destructive) { Task { await ban(u, "perm") } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Bans revoke sessions and evict from all voice until lifted.")
        }
        .confirmationDialog("Instance role", isPresented: $pickRole, titleVisibility: .visible) {
            if !u.isAdmin { Button("Administrator") { Task { await setRole(u, "administrator") } } }
            if !u.isModerator { Button("Moderator") { Task { await setRole(u, "moderator") } } }
            if u.isStaff { Button("Remove role", role: .destructive) { Task { await setRole(u, "none") } } }
            Button("Cancel", role: .cancel) {}
        }
        .confirmationDialog("Delete account?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete @\(u.username)", role: .destructive) { Task { await deleteAccount(u) } }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("Permanently deletes @\(u.username)'s account and data. This can't be undone.")
        }
    }

    private func header(_ u: AdminUser) -> some View {
        HStack(spacing: 12) {
            Avatar(url: u.avatarUrl, name: u.name, size: 52, ringColor: Theme.bg2)
            VStack(alignment: .leading, spacing: 4) {
                Text(u.name).font(.zkSans(17, weight: .semibold)).foregroundColor(Theme.ink1).lineLimit(1)
                Text("@\(u.username)").font(.zkSans(13)).foregroundColor(Theme.ink3).lineLimit(1)
                // Wraps under the name on a narrow phone instead of truncating.
                FlowBadges(badges: badges(u))
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func badges(_ u: AdminUser) -> [(String, Color)] {
        var out: [(String, Color)] = []
        if u.isAdmin { out.append(("ADMINISTRATOR", Theme.accent)) }
        if u.isModerator { out.append(("MODERATOR", Color(hex: 0x38BDF8))) }
        if u.isBanned {
            out.append((u.bannedUntil.flatMap(AdminDates.parse).map { "BANNED · UNTIL \(shortDate($0))" } ?? "BANNED", Theme.danger))
        }
        if u.isMuted {
            out.append((u.mutedUntil.flatMap(AdminDates.parse).map { "MUTED · UNTIL \(shortDateTime($0))" } ?? "MUTED", Color(hex: 0xF59E0B)))
        }
        if let tier = u.subscriptionTier, let m = TierBadge.meta(tier) { out.append((m.label.uppercased(), m.color)) }
        return out
    }

    @ViewBuilder
    private func accountSection(_ u: AdminUser) -> some View {
        card("Account") {
            if let a = account {
                infoRow("Username", "@\(a.username)") { draft = a.username; editingUsername = true }
                infoRow("Email", a.email, note: a.emailVerified ? "verified" : "unverified",
                        noteColor: a.emailVerified ? Theme.online : Color(hex: 0xF59E0B)) {
                    draft = a.email; editingEmail = true
                }
                infoRow("Date of birth", a.dateOfBirth.map(formatDob) ?? "Not on record",
                        note: [a.isMinor ? "minor" : nil, a.dobLocked ? "locked" : "self-change open"]
                            .compactMap { $0 }.joined(separator: " · ")) {
                    dobDraft = a.dateOfBirth.flatMap(parseDob) ?? Calendar.current.date(byAdding: .year, value: -18, to: Date())!
                    editingDob = true
                }
                infoRow("Joined", AdminDates.parse(a.createdAt).map(shortDate) ?? "—")
                infoRow("Last online", a.lastSeenAt.flatMap(AdminDates.parse).map(shortDateTime) ?? "—")
                infoRow("Two-factor", a.twoFactorEnabled ? "On" : "Off")
                infoRow("Signed-in devices", "\(a.activeSessions)")
                infoRow("Servers / friends", "\(a.guildCount) / \(a.friendCount)")
                infoRow("Perk tier", a.subscriptionTier.map { tier in
                    "\(tier) · " + (a.subscriptionExpiresAt.flatMap(AdminDates.parse).map { "until \(shortDate($0))" } ?? "forever")
                } ?? "None")
                HStack(spacing: 8) {
                    if !isSelf {
                        actionButton("Send password reset", "key") { confirmReset = true }
                    }
                    actionButton("Allow one DOB change", "calendar.badge.clock") { Task { await unlockDob(u) } }
                }
                .padding(.top, 4)
            } else {
                ProgressView().tint(Theme.accent).frame(maxWidth: .infinity)
            }
        }
    }

    @ViewBuilder
    private func moderationSection(_ u: AdminUser) -> some View {
        card("Moderation") {
            WrapButtons {
                if u.isMuted {
                    actionButton("Unmute", "speaker.wave.2") { Task { await unmute(u) } }
                } else {
                    actionButton("Mute", "mic.slash") { pickMute = true }
                }
                if u.isBanned {
                    actionButton("Unban", "checkmark.circle") { Task { await unban(u) } }
                } else {
                    actionButton("Ban", "nosign", danger: true) { pickBan = true }
                }
                if !u.isBanned {
                    actionButton("Sign out everywhere", "rectangle.portrait.and.arrow.right") { Task { await signOut(u) } }
                }
                if !selfIsAdmin {
                    actionButton("Allow one DOB change", "calendar.badge.clock") { Task { await unlockDob(u) } }
                }
                if selfIsAdmin {
                    actionButton("Role", "shield") { pickRole = true }
                    Menu {
                        ForEach([("scout", "Scout"), ("guardian", "Guardian"), ("legend", "Legend")], id: \.0) { tier in
                            Menu(tier.1) {
                                ForEach([("1m", "1 month"), ("3m", "3 months"), ("6m", "6 months"), ("forever", "Forever")], id: \.0) { d in
                                    Button(d.1) { Task { await gift(u, tier.0, d.0) } }
                                }
                            }
                        }
                        if u.subscriptionTier != nil {
                            Button(role: .destructive) { Task { await removeMembership(u) } } label: {
                                Label("Remove tier", systemImage: "xmark.circle")
                            }
                        }
                    } label: {
                        buttonLabel("Perk tier", "star", danger: false)
                    }
                    actionButton("Delete account", "trash", danger: true) { confirmDelete = true }
                }
            }
        }
    }

    @ViewBuilder
    private func notesSection(_ u: AdminUser) -> some View {
        card("Staff notes") {
            Text("Only staff can see these. The account never does.")
                .font(.zkSans(11)).foregroundColor(Theme.ink3)
            HStack(alignment: .top, spacing: 8) {
                TextField("Add a note…", text: $noteDraft, axis: .vertical)
                    .lineLimit(1...5)
                    .font(.zkSans(14)).foregroundColor(Theme.ink1)
                    .padding(8).background(Theme.bg1)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                Button { Task { await addNote(u) } } label: {
                    Text("Add").font(.zkSans(13, weight: .semibold))
                        .foregroundColor(.white).padding(.horizontal, 12).padding(.vertical, 9)
                        .background(noteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty ? Theme.accent.opacity(0.4) : Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .disabled(noteDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let notes {
                if notes.isEmpty {
                    Text("No notes yet.").font(.zkSans(13)).foregroundColor(Theme.ink3)
                }
                ForEach(notes) { n in
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(spacing: 6) {
                            Text(n.author.map { "@\($0.username)" } ?? "former staff")
                            Text("·")
                            Text(AdminDates.parse(n.createdAt).map(shortDateTime) ?? "")
                            Spacer()
                            if selfIsAdmin || n.author?.id == session.currentUser?.id {
                                Button { Task { await deleteNote(u, n) } } label: {
                                    Image(systemName: "trash").font(.system(size: 12)).foregroundColor(Theme.ink3)
                                        .frame(width: 32, height: 28).contentShape(Rectangle())
                                }
                                .accessibilityLabel("Delete note")
                            }
                        }
                        .font(.zkSans(11)).foregroundColor(Theme.ink3)
                        Text(n.body).font(.zkSans(14)).foregroundColor(Theme.ink1)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(10)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg1)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
            } else {
                ProgressView().tint(Theme.accent).frame(maxWidth: .infinity)
            }
        }
    }

    @ViewBuilder
    private func contactsSection(_ u: AdminUser) -> some View {
        card("Contacts") {
            if let c = contacts {
                contactGroup("Friends", "person.2", c.friends)
                contactGroup("Friend requests received", "tray.and.arrow.down", c.incomingRequests)
                contactGroup("Friend requests sent", "paperplane", c.outgoingRequests)
                contactGroup("Blocked", "nosign", c.blocked)
                contactGroup("Direct messages with", "bubble.left.and.bubble.right", c.dmPartners)
                Text("Names only — message content is never shown.")
                    .font(.zkSans(11)).foregroundColor(Theme.ink3)
            } else if loadingContacts {
                ProgressView().tint(Theme.accent).frame(maxWidth: .infinity)
            } else {
                actionButton("Show contacts", "person.2") { Task { await loadContacts(u) } }
                Text("Viewing contacts is recorded in the staff log.")
                    .font(.zkSans(11)).foregroundColor(Theme.ink3)
            }
        }
    }

    private func contactGroup(_ title: String, _ icon: String, _ people: [AdminContactPerson]) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Label("\(title) (\(people.count))", systemImage: icon)
                .font(.zkSans(12, weight: .semibold)).foregroundColor(Theme.ink2)
            if people.isEmpty {
                Text("None").font(.zkSans(12)).foregroundColor(Theme.ink3).padding(.leading, 22)
            }
            ForEach(people) { p in
                HStack(spacing: 8) {
                    Avatar(url: p.avatarUrl, name: p.name, size: 26, ringColor: Theme.bg1)
                    VStack(alignment: .leading, spacing: 0) {
                        Text(p.name).font(.zkSans(13)).foregroundColor(Theme.ink1).lineLimit(1)
                        Text("@\(p.username) · since \(AdminDates.parse(p.since).map(shortDate) ?? "")")
                            .font(.zkSans(11)).foregroundColor(Theme.ink3).lineLimit(1)
                    }
                    Spacer(minLength: 0)
                }
            }
        }
    }

    private func dobSheet(_ u: AdminUser) -> some View {
        NavigationStack {
            VStack(spacing: 12) {
                DatePicker("Date of birth", selection: $dobDraft,
                           in: ...(Calendar.current.date(byAdding: .year, value: -13, to: Date()) ?? Date()),
                           displayedComponents: .date)
                    .datePickerStyle(.wheel)
                    .labelsHidden()
                Text("Must be 13 or older. An age under 18 turns on minor supervision for the account.")
                    .font(.zkSans(12)).foregroundColor(Theme.ink3).multilineTextAlignment(.center)
                Spacer()
            }
            .padding(16)
            .background(Theme.bg1)
            .navigationTitle("Date of birth")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { editingDob = false } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundColor(Theme.ink2)
                            .frame(width: 44, height: 44)
                            .contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close")
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await saveDob(u) } }.foregroundColor(Theme.accent)
                }
            }
        }
        .presentationDetents([.medium])
    }

    // MARK: Building blocks

    private func card<C: View>(_ title: String, @ViewBuilder _ body: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title.uppercased()).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            body()
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func infoRow(_ label: String, _ value: String, note: String? = nil,
                         noteColor: Color = Theme.ink3, edit: (() -> Void)? = nil) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label).font(.zkSans(13)).foregroundColor(Theme.ink3).frame(width: 118, alignment: .leading)
            VStack(alignment: .leading, spacing: 1) {
                Text(value).font(.zkSans(14)).foregroundColor(Theme.ink1)
                    .fixedSize(horizontal: false, vertical: true)
                if let note, !note.isEmpty { Text(note).font(.zkSans(11)).foregroundColor(noteColor) }
            }
            Spacer(minLength: 0)
            if let edit {
                Button(action: edit) {
                    Image(systemName: "pencil").font(.system(size: 13)).foregroundColor(Theme.ink3)
                        .frame(width: 32, height: 28).contentShape(Rectangle())
                }
                .accessibilityLabel("Edit \(label.lowercased())")
            }
        }
    }

    private func actionButton(_ title: String, _ icon: String, danger: Bool = false,
                              _ action: @escaping () -> Void) -> some View {
        Button(action: action) { buttonLabel(title, icon, danger: danger) }
            .buttonStyle(.plain)
    }

    private func buttonLabel(_ title: String, _ icon: String, danger: Bool) -> some View {
        Label(title, systemImage: icon)
            .font(.zkSans(13, weight: .medium))
            .foregroundColor(danger ? Theme.danger : Theme.ink1)
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(danger ? Theme.danger.opacity(0.12) : Theme.bg3)
            .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    private func shortDate(_ d: Date) -> String { d.formatted(date: .abbreviated, time: .omitted) }
    private func shortDateTime(_ d: Date) -> String { d.formatted(date: .abbreviated, time: .shortened) }
    private func parseDob(_ s: String) -> Date? {
        let f = DateFormatter(); f.dateFormat = "yyyy-MM-dd"; f.timeZone = TimeZone(identifier: "UTC")
        return f.date(from: s)
    }
    private func formatDob(_ s: String) -> String {
        guard let d = parseDob(s) else { return s }
        let f = DateFormatter(); f.dateStyle = .long; f.timeZone = TimeZone(identifier: "UTC")
        return f.string(from: d)
    }

    // MARK: Actions

    private func show(_ text: String, error: Bool = false) {
        banner = (text, error)
        Task {
            try? await Task.sleep(nanoseconds: 3_500_000_000)
            if banner?.text == text { banner = nil }
        }
    }

    /// Run one API action with the page disabled, reporting failure inline.
    private func run(_ success: String?, _ work: () async throws -> Void) async {
        busy = true
        defer { busy = false }
        do {
            try await work()
            if let success { show(success) }
            await reloadAccount()
        } catch {
            show((error as? APIError)?.message ?? error.localizedDescription, error: true)
        }
    }

    private func load() async {
        await reloadAccount()
        if let u = user, canModerate(u) {
            notes = (try? await store.api.adminListNotes(userId: userId)) ?? []
        }
    }

    private func reloadAccount() async {
        guard selfIsAdmin else { return }
        if let a = try? await store.api.adminGetAccount(userId: userId) { account = a }
    }

    private func saveUsername(_ u: AdminUser) async {
        let name = draft.trimmingCharacters(in: .whitespaces).lowercased()
        await run("Username changed to @\(name)") {
            try await store.api.adminSetUsername(userId: u.id, username: name)
            store.patchAdminUser(u.id) { $0.username = name }
        }
    }

    private func saveEmail(_ u: AdminUser) async {
        let email = draft.trimmingCharacters(in: .whitespaces).lowercased()
        await run("Email changed — the old address was notified") {
            try await store.api.adminSetEmail(userId: u.id, email: email)
            store.patchAdminUser(u.id) { $0.email = email }
        }
    }

    private func saveDob(_ u: AdminUser) async {
        // The wheel works in local time; take the local calendar day the admin picked.
        let comps = Calendar.current.dateComponents([.year, .month, .day], from: dobDraft)
        let dob = String(format: "%04d-%02d-%02d", comps.year ?? 0, comps.month ?? 0, comps.day ?? 0)
        editingDob = false
        await run("Date of birth updated") {
            try await store.api.adminSetDateOfBirth(userId: u.id, dateOfBirth: dob)
            store.patchAdminUser(u.id) { $0.dateOfBirth = dob }
        }
    }

    private func sendReset(_ u: AdminUser) async {
        await run("Reset link sent and all sessions signed out") {
            try await store.api.adminSendPasswordReset(userId: u.id)
        }
    }

    private func unlockDob(_ u: AdminUser) async {
        await run("@\(u.username) can change their date of birth once more") {
            try await store.api.adminResetDobLock(userId: u.id)
        }
    }

    private func mute(_ u: AdminUser, _ duration: String) async {
        await run("Muted @\(u.username)") {
            try await store.api.adminMuteUser(userId: u.id, duration: duration)
            let secs: Double? = ["1h": 3600, "1d": 86_400, "1w": 604_800][duration]
            let iso = ISO8601DateFormatter()
            store.patchAdminUser(u.id) {
                $0.mutedAt = iso.string(from: Date())
                $0.mutedUntil = secs.map { iso.string(from: Date().addingTimeInterval($0)) }
            }
        }
    }

    private func unmute(_ u: AdminUser) async {
        await run("Unmuted @\(u.username)") {
            try await store.api.adminUnmuteUser(userId: u.id)
            store.patchAdminUser(u.id) { $0.mutedAt = nil; $0.mutedUntil = nil }
        }
    }

    private func ban(_ u: AdminUser, _ duration: String) async {
        await run("Banned @\(u.username)") {
            try await store.api.adminBanUser(userId: u.id, duration: duration)
            let months = ["1m": 1, "3m": 3, "6m": 6][duration]
            let iso = ISO8601DateFormatter()
            store.patchAdminUser(u.id) {
                $0.bannedAt = iso.string(from: Date())
                $0.bannedUntil = months.map { iso.string(from: Date().addingTimeInterval(Double($0) * 30 * 86_400)) }
            }
        }
    }

    private func unban(_ u: AdminUser) async {
        await run("Unbanned @\(u.username)") {
            try await store.api.adminUnbanUser(userId: u.id)
            store.patchAdminUser(u.id) { $0.bannedAt = nil; $0.bannedUntil = nil }
        }
    }

    private func signOut(_ u: AdminUser) async {
        await run("Signed @\(u.username) out of all devices") {
            try await store.api.adminLogoutUser(userId: u.id)
        }
    }

    private func setRole(_ u: AdminUser, _ role: String) async {
        await run("Role updated") {
            try await store.api.adminSetRole(userId: u.id, role: role)
            store.patchAdminUser(u.id) {
                $0.isAdmin = role == "administrator"
                $0.isModerator = role == "moderator"
            }
        }
    }

    private func gift(_ u: AdminUser, _ tier: String, _ duration: String) async {
        await run("Gave the \(tier) tier") {
            try await store.api.adminGiftSubscription(userId: u.id, tier: tier, duration: duration)
            store.patchAdminUser(u.id) { $0.subscriptionTier = tier }
        }
    }

    private func removeMembership(_ u: AdminUser) async {
        await run("Perk tier removed") {
            try await store.api.adminRemoveSubscription(userId: u.id)
            store.patchAdminUser(u.id) { $0.subscriptionTier = nil }
        }
    }

    private func deleteAccount(_ u: AdminUser) async {
        busy = true
        defer { busy = false }
        do {
            try await store.api.adminDeleteUser(userId: u.id)
            // Removing the row makes `user` nil, which dismisses the page.
            store.adminUsers.removeAll { $0.id == u.id }
        } catch {
            show((error as? APIError)?.message ?? error.localizedDescription, error: true)
        }
    }

    private func addNote(_ u: AdminUser) async {
        let body = noteDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !body.isEmpty else { return }
        await run(nil) {
            try await store.api.adminAddNote(userId: u.id, body: body)
            noteDraft = ""
            notes = try await store.api.adminListNotes(userId: u.id)
        }
    }

    private func deleteNote(_ u: AdminUser, _ n: StaffNote) async {
        await run(nil) {
            try await store.api.adminDeleteNote(userId: u.id, noteId: n.id)
            notes?.removeAll { $0.id == n.id }
        }
    }

    private func loadContacts(_ u: AdminUser) async {
        loadingContacts = true
        defer { loadingContacts = false }
        do {
            contacts = try await store.api.adminGetAccountContacts(userId: u.id)
        } catch {
            show((error as? APIError)?.message ?? "Couldn't load contacts.", error: true)
        }
    }
}

/// Badges that wrap onto extra lines instead of truncating on a narrow phone.
private struct FlowBadges: View {
    let badges: [(String, Color)]
    var body: some View {
        WrapButtons(spacing: 4) {
            ForEach(Array(badges.enumerated()), id: \.offset) { _, b in
                Text(b.0).font(.zkSans(9, weight: .bold))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(b.1.opacity(0.2)).foregroundColor(b.1)
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            }
        }
    }
}

/// A left-aligned flow layout: children fill a line, then wrap. Used for the
/// moderation buttons and the header badges, which vary in number and would
/// otherwise overflow a phone-width card.
private struct WrapButtons: Layout {
    var spacing: CGFloat = 8

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let width = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, lineHeight: CGFloat = 0, maxX: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > 0, x + s.width > width { x = 0; y += lineHeight + spacing; lineHeight = 0 }
            x += s.width + spacing
            maxX = max(maxX, x - spacing)
            lineHeight = max(lineHeight, s.height)
        }
        return CGSize(width: min(maxX, width), height: y + lineHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        var x = bounds.minX, y = bounds.minY, lineHeight: CGFloat = 0
        for v in subviews {
            let s = v.sizeThatFits(.unspecified)
            if x > bounds.minX, x + s.width > bounds.maxX { x = bounds.minX; y += lineHeight + spacing; lineHeight = 0 }
            v.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(s))
            x += s.width + spacing
            lineHeight = max(lineHeight, s.height)
        }
    }
}
