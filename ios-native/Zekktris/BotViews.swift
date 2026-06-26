import SwiftUI

/// Bot account management (mirrors the web Settings → Bots section).
///
/// Lets the owner:
///   - Create a bot (username + display name)
///   - See the bot token ONCE on create / regenerate (copy-to-clipboard)
///   - List bots they own
///   - Add a bot to one of their servers (requires MANAGE_GUILD there)
///   - Configure an event callback URL (signing secret shown once)
///   - Regenerate a bot's token (invalidates the old one)
///   - Delete a bot
///
/// The token/secret are shown exactly once in a dismissible violet callout
/// with a copy button and a "you won't see this again" warning, mirroring how
/// GitHub / Discord present freshly-minted secrets. Slash-command management
/// is deferred (web-only for now).
struct BotsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var bots: [Bot]? = nil
    @State private var loading = true
    @State private var errorText: String?

    // The just-issued token to show once.
    @State private var freshToken: (botId: String, token: String)?

    // Create-form state.
    @State private var creating = false
    @State private var newUsername = ""
    @State private var newDisplayName = ""
    @State private var createBusy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 14) {
                    header

                    if let freshToken {
                        secretCallout(
                            title: "Copy your bot token now",
                            blurb: "This is the only time the token is shown. Store it somewhere safe — if you lose it you'll need to regenerate.",
                            value: freshToken.token,
                            onDismiss: { self.freshToken = nil }
                        )
                    }

                    if creating { createForm }

                    if loading {
                        ProgressView()
                            .frame(maxWidth: .infinity, minHeight: 120)
                    } else if let bots, bots.isEmpty {
                        emptyState
                    } else if let bots {
                        ForEach(bots) { bot in
                            BotCard(
                                bot: bot,
                                ownedGuilds: ownedGuilds,
                                onToken: { freshToken = (bot.id, $0) },
                                onDeleted: { removeBot(bot.id) },
                                onEventUrl: { updateEventUrl(bot.id, $0) }
                            )
                        }
                    }

                    if let errorText {
                        Text(errorText)
                            .font(.zkSans(12))
                            .foregroundColor(Theme.dangerSoft)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Bots")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 20, weight: .semibold))
                            .foregroundColor(Theme.ink2)
                            .frame(width: 44, height: 44).contentShape(Rectangle())
                    }
                    .accessibilityLabel("Close")
                }
                ToolbarItem(placement: .primaryAction) {
                    if !creating {
                        Button { withAnimation { creating = true } } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 16, weight: .semibold))
                        }
                        .accessibilityLabel("New bot")
                    }
                }
            }
            .task { await load() }
        }
    }

    // MARK: - Pieces

    private var header: some View {
        Text("Bot accounts authenticate with a token and act through the API. Create one, copy its token, and add it to your servers.")
            .font(.zkSans(13))
            .foregroundColor(Theme.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var emptyState: some View {
        VStack(spacing: 8) {
            Image(systemName: "cpu")
                .font(.system(size: 30, weight: .light))
                .foregroundColor(Theme.ink3)
            Text("You haven't created any bots yet.")
                .font(.zkSans(14)).foregroundColor(Theme.ink3)
        }
        .frame(maxWidth: .infinity, minHeight: 140)
    }

    private var createForm: some View {
        VStack(alignment: .leading, spacing: 12) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Username (handle)").font(.zkSans(12)).foregroundColor(Theme.ink3)
                TextField("my-cool-bot", text: $newUsername)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.zkSans(15)).foregroundColor(Theme.ink1)
                    .padding(.horizontal, 10).padding(.vertical, 9)
                    .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Display name").font(.zkSans(12)).foregroundColor(Theme.ink3)
                TextField("My Cool Bot", text: $newDisplayName)
                    .font(.zkSans(15)).foregroundColor(Theme.ink1)
                    .padding(.horizontal, 10).padding(.vertical, 9)
                    .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 8))
                    .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
            }
            HStack(spacing: 10) {
                Spacer()
                Button("Cancel") {
                    withAnimation { creating = false }
                    newUsername = ""; newDisplayName = ""
                }
                .font(.zkSans(14)).foregroundColor(Theme.ink2)
                .buttonStyle(.plain)

                Button {
                    Task { await create() }
                } label: {
                    Text(createBusy ? "Creating…" : "Create bot")
                        .font(.zkSans(14, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 8)
                        .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
                .disabled(createBusy)
                .opacity(createBusy ? 0.5 : 1)
            }
        }
        .padding(14)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
    }

    /// Violet one-time-secret callout (token or signing secret).
    @ViewBuilder
    private func secretCallout(title: String, blurb: String, value: String, onDismiss: @escaping () -> Void) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.zkSans(14, weight: .semibold)).foregroundColor(Theme.accent)
            Text(blurb).font(.zkSans(12)).foregroundColor(Theme.ink3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text(value)
                    .font(.zkMono(12)).foregroundColor(Theme.ink1)
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8).padding(.vertical, 7)
                    .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 6))
                Button { UIPasteboard.general.string = value } label: {
                    Text("Copy").font(.zkSans(12, weight: .semibold)).foregroundColor(Theme.ink1)
                        .padding(.horizontal, 10).padding(.vertical, 7)
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            Button("Dismiss", action: onDismiss)
                .font(.zkSans(12)).foregroundColor(Theme.ink3)
                .buttonStyle(.plain)
        }
        .padding(12)
        .background(Theme.accent.opacity(0.10))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(RoundedRectangle(cornerRadius: 10).stroke(Theme.accent.opacity(0.4), lineWidth: 1))
    }

    // MARK: - Data

    /// Servers the user owns — the only ones we can assume MANAGE_GUILD in.
    /// (The server still enforces the precise check; this just keeps the
    /// picker from listing servers the add would bounce on.)
    private var ownedGuilds: [Guild] {
        store.guilds.filter { $0.ownerId != nil && $0.ownerId == store.currentUserId }
    }

    private func load() async {
        loading = true
        do { bots = try await store.api.listBots() }
        catch { bots = []; errorText = friendly(error) }
        loading = false
    }

    private func create() async {
        let username = newUsername.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let displayName = newDisplayName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !username.isEmpty, !displayName.isEmpty else {
            errorText = "Username and display name are required"; return
        }
        createBusy = true; errorText = nil
        do {
            let r = try await store.api.createBot(username: username, displayName: displayName)
            bots = (bots ?? []) + [r.bot]
            freshToken = (r.bot.id, r.token)
            newUsername = ""; newDisplayName = ""
            withAnimation { creating = false }
        } catch { errorText = friendly(error) }
        createBusy = false
    }

    private func removeBot(_ id: String) {
        bots = (bots ?? []).filter { $0.id != id }
        if freshToken?.botId == id { freshToken = nil }
    }

    private func updateEventUrl(_ id: String, _ url: String?) {
        bots = (bots ?? []).map { b in
            var b = b
            if b.id == id { b.botEventUrl = url }
            return b
        }
    }

    private func friendly(_ error: Error) -> String {
        (error as? APIError)?.message ?? "Something went wrong"
    }
}

/// One bot row with inline actions (add-to-server picker, events editor,
/// regenerate, delete) that swap in place — mirroring the web card.
private struct BotCard: View {
    let bot: Bot
    let ownedGuilds: [Guild]
    /// Surfaces a freshly-issued token (regenerate) to the parent's callout.
    let onToken: (String) -> Void
    let onDeleted: () -> Void
    /// Reports a saved/cleared event URL back to the parent's list.
    let onEventUrl: (String?) -> Void

    @EnvironmentObject private var store: AppStore

    private enum Mode { case actions, addServer, events }
    @State private var mode: Mode = .actions
    @State private var eventUrlDraft = ""
    @State private var freshSecret: String?
    @State private var busy = false
    @State private var errorText: String?
    @State private var confirmingDelete = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            // Identity row.
            HStack(spacing: 10) {
                Avatar(url: bot.avatarUrl, name: bot.name, size: 36, toneId: bot.id)
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(bot.name).font(.zkSans(15, weight: .semibold))
                            .foregroundColor(Theme.ink1).lineLimit(1)
                        Text("BOT").font(.zkSans(9, weight: .bold)).foregroundColor(Theme.accent)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.accent.opacity(0.18)).clipShape(Capsule())
                    }
                    if let u = bot.username {
                        Text("@\(u)").font(.zkSans(12)).foregroundColor(Theme.ink3).lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
            }

            switch mode {
            case .actions: actionButtons
            case .addServer: addServerPicker
            case .events: eventsEditor
            }

            if let freshSecret {
                signingSecretCallout(freshSecret)
            }

            if let errorText {
                Text(errorText).font(.zkSans(11)).foregroundColor(Theme.dangerSoft)
            }
        }
        .padding(14)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
        .overlay(RoundedRectangle(cornerRadius: 12).stroke(Theme.line, lineWidth: 1))
    }

    // MARK: action chips

    private var actionButtons: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                chip("Add to server", "plus.circle") { mode = .addServer }
                chip(bot.botEventUrl != nil ? "Events: on" : "Events", "bolt.horizontal") {
                    eventUrlDraft = bot.botEventUrl ?? ""
                    mode = .events
                }
            }
            HStack(spacing: 8) {
                chip("Regenerate token", "arrow.triangle.2.circlepath") {
                    Task { await regenerate() }
                }
                if confirmingDelete {
                    Button { Task { await delete() } } label: {
                        chipLabel(busy ? "Deleting…" : "Confirm delete", "trash.fill", danger: true)
                    }
                    .buttonStyle(.plain).disabled(busy)
                    Button("Cancel") { confirmingDelete = false }
                        .font(.zkSans(12)).foregroundColor(Theme.ink3).buttonStyle(.plain)
                } else {
                    Button { confirmingDelete = true } label: {
                        chipLabel("Delete", "trash", danger: true)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    private var addServerPicker: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Add to which server?").font(.zkSans(12)).foregroundColor(Theme.ink3)
                .padding(.bottom, 2)
            if ownedGuilds.isEmpty {
                Text("You don't own any servers.").font(.zkSans(12)).foregroundColor(Theme.ink3)
            } else {
                ForEach(ownedGuilds) { g in
                    Button { Task { await addToGuild(g.id) } } label: {
                        HStack(spacing: 8) {
                            Text(g.name).font(.zkSans(14)).foregroundColor(Theme.ink1).lineLimit(1)
                            Spacer()
                            Image(systemName: "plus").font(.system(size: 12)).foregroundColor(Theme.ink3)
                        }
                        .padding(.horizontal, 10).padding(.vertical, 9)
                        .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                    .buttonStyle(.plain).disabled(busy)
                }
            }
            Button("Cancel") { mode = .actions }
                .font(.zkSans(12)).foregroundColor(Theme.ink3).buttonStyle(.plain).padding(.top, 2)
        }
        .padding(10)
        .background(Theme.bg1.opacity(0.5)).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var eventsEditor: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Event callback URL (HTTPS). The server POSTs a signed message.create event here for channels this bot can see. Leave blank to disable.")
                .font(.zkSans(11)).foregroundColor(Theme.ink3)
                .fixedSize(horizontal: false, vertical: true)
            TextField("https://my-bot.example.com/events", text: $eventUrlDraft)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .keyboardType(.URL)
                .font(.zkSans(14)).foregroundColor(Theme.ink1)
                .padding(.horizontal, 10).padding(.vertical, 9)
                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 8))
                .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.line, lineWidth: 1))
            HStack(spacing: 10) {
                Spacer()
                Button("Cancel") { mode = .actions }
                    .font(.zkSans(13)).foregroundColor(Theme.ink2).buttonStyle(.plain)
                Button { Task { await saveEventUrl() } } label: {
                    Text(busy ? "Saving…" : "Save")
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 12).padding(.vertical, 7)
                        .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain).disabled(busy)
            }
        }
        .padding(10)
        .background(Theme.bg1.opacity(0.5)).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    @ViewBuilder
    private func signingSecretCallout(_ secret: String) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Signing secret (shown once)")
                .font(.zkSans(12, weight: .semibold)).foregroundColor(Theme.accent)
            Text("Verify the X-Zekktris-Signature header: it's sha256(secret + \".\" + rawBody) as hex.")
                .font(.zkSans(11)).foregroundColor(Theme.ink3)
                .fixedSize(horizontal: false, vertical: true)
            HStack(spacing: 8) {
                Text(secret).font(.zkMono(11)).foregroundColor(Theme.ink1)
                    .lineLimit(1).truncationMode(.middle)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 8).padding(.vertical, 6)
                    .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 6))
                Button { UIPasteboard.general.string = secret } label: {
                    Text("Copy").font(.zkSans(11, weight: .semibold)).foregroundColor(Theme.ink1)
                        .padding(.horizontal, 9).padding(.vertical, 6)
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 6))
                        .overlay(RoundedRectangle(cornerRadius: 6).stroke(Theme.line, lineWidth: 1))
                }
                .buttonStyle(.plain)
            }
            Button("Dismiss") { freshSecret = nil }
                .font(.zkSans(11)).foregroundColor(Theme.ink3).buttonStyle(.plain)
        }
        .padding(10)
        .background(Theme.accent.opacity(0.10)).clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(Theme.accent.opacity(0.4), lineWidth: 1))
    }

    // MARK: chip helpers

    private func chip(_ title: String, _ icon: String, action: @escaping () -> Void) -> some View {
        Button(action: action) { chipLabel(title, icon) }
            .buttonStyle(.plain).disabled(busy)
    }

    private func chipLabel(_ title: String, _ icon: String, danger: Bool = false) -> some View {
        HStack(spacing: 5) {
            Image(systemName: icon).font(.system(size: 11))
            Text(title).font(.zkSans(12, weight: .medium))
        }
        .foregroundColor(danger ? Theme.dangerSoft : Theme.ink1)
        .padding(.horizontal, 10).padding(.vertical, 7)
        .background(danger ? Theme.danger.opacity(0.12) : Theme.bg1)
        .clipShape(RoundedRectangle(cornerRadius: 8))
        .overlay(RoundedRectangle(cornerRadius: 8).stroke(danger ? Theme.danger.opacity(0.3) : Theme.line, lineWidth: 1))
    }

    // MARK: actions

    private func regenerate() async {
        busy = true; errorText = nil
        do { onToken(try await store.api.regenerateBotToken(botId: bot.id)) }
        catch { errorText = friendly(error) }
        busy = false
    }

    private func delete() async {
        busy = true; errorText = nil
        do { try await store.api.deleteBot(botId: bot.id); onDeleted() }
        catch { errorText = friendly(error); busy = false }
    }

    private func addToGuild(_ guildId: String) async {
        busy = true; errorText = nil
        do { try await store.api.addBotToGuild(guildId: guildId, botId: bot.id); mode = .actions }
        catch { errorText = friendly(error) }
        busy = false
    }

    private func saveEventUrl() async {
        let url = eventUrlDraft.trimmingCharacters(in: .whitespacesAndNewlines)
        busy = true; errorText = nil
        do {
            let r = try await store.api.setBotEventConfig(botId: bot.id, url: url.isEmpty ? nil : url)
            onEventUrl(r.eventUrl)
            if let s = r.secret { freshSecret = s }
            mode = .actions
        } catch { errorText = friendly(error) }
        busy = false
    }

    private func friendly(_ error: Error) -> String {
        (error as? APIError)?.message ?? "Something went wrong"
    }
}
