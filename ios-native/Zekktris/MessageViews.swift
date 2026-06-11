import SwiftUI
import PhotosUI
import UIKit
import UniformTypeIdentifiers

/// A channel's message timeline plus the composer. Auto-scrolls to the newest
/// message and keeps the composer pinned above the keyboard.
struct MessageListView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var session: Session
    let channel: Channel

    @State private var draft = ""
    @FocusState private var composerFocused: Bool
    @State private var showEnableSheet = false
    @State private var showDmSettings = false
    @State private var pickerItem: PhotosPickerItem?
    @State private var showPhotoPicker = false
    @State private var pendingImage: PendingImage?
    @State private var showPollSheet = false
    @State private var showStickers = false
    @State private var showSchedule = false
    @State private var showEmojiPicker = false
    @StateObject private var recorder = VoiceRecorder()
    @State private var showSearch = false
    @State private var showPins = false
    @State private var lastTypingSent = Date.distantPast
    /// Tracks the newest message id so the auto-scroll fires only on appends
    /// (new/sent messages), not when older history is prepended.
    @State private var lastBottomId: String?
    /// Set shortly after the initial scroll-to-bottom so the load-older trigger
    /// can't fire during first layout (which would yank the user into history).
    @State private var didInitialScroll = false

    var body: some View {
        VStack(spacing: 0) {
            header

            if isLocked {
                UnlockPanel(channel: channel)
            } else {
                ScrollViewReader { proxy in
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 2) {
                            if store.loadingMessages && store.messages.isEmpty {
                                ProgressView().tint(Theme.accent)
                                    .frame(maxWidth: .infinity)
                                    .padding(.top, 24)
                            } else if store.messages.isEmpty {
                                emptyState
                            }

                            // Load-older trigger: when scrolled to the top and
                            // more history exists, page back in.
                            if store.hasMoreMessages && !store.messages.isEmpty {
                                ProgressView().tint(Theme.accent)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 8)
                                    .onAppear {
                                        guard didInitialScroll else { return }
                                        Task { await store.loadOlderMessages() }
                                    }
                            }

                            let receiptAnchors = dmReceiptAnchors()
                            ForEach(Array(store.messages.enumerated()), id: \.element.id) { index, message in
                                if shouldShowDateDivider(at: index) {
                                    DateDividerView(label: dateDividerLabel(message.createdAt))
                                }
                                if shouldShowUnreadDivider(at: index) {
                                    UnreadDividerView()
                                }
                                MessageRow(
                                    message: message,
                                    channel: channel,
                                    showHeader: showHeader(at: index),
                                    dmReceipt: dmReceipt(for: message, anchors: receiptAnchors)
                                )
                                .id(message.id)
                                .padding(.top, showHeader(at: index) ? 10 : 0)
                            }

                            Color.clear.frame(height: 1).id(bottomAnchor)
                        }
                        .padding(.horizontal, 16)
                        .padding(.vertical, 8)
                    }
                    .onChange(of: store.messages.count) { _ in
                        // Only auto-scroll to the bottom when the newest message
                        // changed (append/initial). Prepended history keeps its
                        // place via the anchor restore below.
                        let wasEmpty = (lastBottomId == nil)
                        let newest = store.messages.last?.id
                        if newest != lastBottomId {
                            lastBottomId = newest
                            if wasEmpty, let boundary = store.unreadBoundaryId,
                               let firstUnread = firstUnreadId(boundary) {
                                // Initial load with unread → land on the divider.
                                proxy.scrollTo(firstUnread, anchor: .top)
                            } else {
                                withAnimation(.easeOut(duration: 0.2)) {
                                    proxy.scrollTo(bottomAnchor, anchor: .bottom)
                                }
                            }
                        }
                    }
                    .onChange(of: store.pendingScrollAnchorId) { anchor in
                        // After an older page prepends, jump back to the message
                        // that was previously at the top so the view doesn't lurch.
                        guard let anchor else { return }
                        // Two-phase restore: once synchronously (limits the
                        // visible flash), then again on the next runloop turn
                        // AFTER the freshly-prepended LazyVStack rows have
                        // actually laid out — scrolling only in the same
                        // transaction that inserted them targets unmeasured
                        // rows and produced the exact lurch this exists to
                        // prevent.
                        withAnimation(.none) { proxy.scrollTo(anchor, anchor: .top) }
                        DispatchQueue.main.async {
                            withAnimation(.none) { proxy.scrollTo(anchor, anchor: .top) }
                            store.pendingScrollAnchorId = nil
                        }
                    }
                    .onAppear {
                        lastBottomId = store.messages.last?.id
                        proxy.scrollTo(bottomAnchor, anchor: .bottom)
                        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
                            didInitialScroll = true
                        }
                    }
                }
                .background(Theme.bg1.opacity(0.9))
            }
        }
        .background(Theme.bg1.opacity(0.9))
        .onAppear { store.openChannel(channel) }
        .safeAreaInset(edge: .bottom) {
            if !isLocked { composer }
        }
        .sheet(isPresented: $showEnableSheet) {
            EnableE2EESheet(channel: channel)
        }
        .sheet(isPresented: $showDmSettings) {
            DmSettingsSheet(channel: channel)
        }
    }

    /// 1:1 DM read receipts (web parity): "Read" anchors on the newest own
    /// message the recipient has viewed; "Sent"/"Delivered" anchors on the
    /// newest own message when it's still unread. Group DMs and guild
    /// channels render no receipts. Computed ONCE per render pass.
    private func dmReceiptAnchors() -> (latest: Message?, lastRead: Message?) {
        guard channel.type == "dm", let selfId = store.currentUserId else { return (nil, nil) }
        var latest: Message? = nil
        var lastRead: Message? = nil
        for m in store.messages where (m.authorId ?? m.author?.id) == selfId && m.sendState == nil {
            latest = m
            if m.viewedAt != nil { lastRead = m }
        }
        return (latest, lastRead)
    }

    private func dmReceipt(for message: Message, anchors: (latest: Message?, lastRead: Message?)) -> String? {
        // The receipt lives ONLY under the newest own message — the moment a
        // newer one is sent, any older "Read" status disappears with it.
        guard message.id == anchors.latest?.id else { return nil }
        if let viewedAt = message.viewedAt {
            return "Read \(shortTime(viewedAt))"
        }
        return message.deliveredAt != nil ? "Delivered" : "Sent"
    }

    /// Encrypted DM with no key on this device → show the unlock panel.
    private var isLocked: Bool {
        _ = store.e2eeUnlockVersion
        return channel.isE2EE && !store.hasE2EEKey(for: channel)
    }

    private let bottomAnchor = "bottom-anchor"

    // MARK: Header

    private var header: some View {
        HStack(spacing: 8) {
            // Wide layout keeps the sidebar visible; back only makes sense
            // for stacked drill-downs (e.g. a thread under a forum).
            if !store.isWideLayout || store.stack.count > 1 {
                Button {
                    store.clearChannel()
                } label: {
                    Image(systemName: "chevron.left")
                        .font(.system(size: 17, weight: .semibold))
                        .foregroundColor(Theme.ink2)
                }
            }

            if channel.isDM {
                Avatar(
                    url: channel.dmAvatarUser?.avatarUrl,
                    name: channel.dmTitle,
                    size: 28,
                    status: store.status(for: channel.dmAvatarUser?.id, fallback: channel.dmAvatarUser?.status),
                    ringColor: Theme.bg2,
                    toneId: channel.dmAvatarUser?.id
                )
                // E2EE badge: a small themed lock pinned to the top-right of
                // the profile picture (the only E2EE indicator in the header).
                .overlay(alignment: .topTrailing) {
                    if channel.isE2EE {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundColor(Theme.accent)
                            .frame(width: 13, height: 13)
                            .background(Theme.bg2)
                            .clipShape(Circle())
                            .overlay(Circle().strokeBorder(Theme.accent.opacity(0.45), lineWidth: 1))
                            .offset(x: 4, y: -4)
                    }
                }
                Text(channel.dmTitle)
                    .font(.zkSans(16, weight: .semibold))
                    .foregroundColor(Theme.ink1)
                    .lineLimit(1)
                if let streak = (store.dms.first(where: { $0.id == channel.id })?.streak ?? channel.streak),
                   streak > 0 {
                    StreakChip(days: streak)
                }
            } else {
                Image(systemName: "number")
                    .font(.system(size: 15))
                    .foregroundColor(Theme.ink3)

                Text(channel.name ?? "channel")
                    .font(.zkSans(16, weight: .semibold))
                    .foregroundColor(Theme.ink1)
                    .lineLimit(1)
            }

            Spacer()

            if !channel.isE2EE {
                Button { showSearch = true } label: {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 15))
                        .foregroundColor(Theme.ink3)
                }
                .padding(.trailing, 2)
            }

            Button { showPins = true } label: {
                Image(systemName: "pin.fill")
                    .font(.system(size: 13))
                    .foregroundColor(store.pins.isEmpty ? Theme.ink3 : Theme.accent)
            }
            .padding(.trailing, 2)

            if !channel.isDM {
                Button { store.showMembers = true } label: {
                    Image(systemName: "person.2.fill")
                        .font(.system(size: 14))
                        .foregroundColor(Theme.ink3)
                }
                .padding(.trailing, 2)
            }

            if channel.isText {
                EmptyView()
            }

            if channel.isDM {
                Button { store.openVoice(channel) } label: {
                    Image(systemName: "phone.fill")
                        .font(.system(size: 15))
                        .foregroundColor(Theme.ink3)
                }
                .padding(.trailing, 2)
                Button { showDmSettings = true } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 15))
                        .foregroundColor(Theme.ink3)
                }
                .padding(.trailing, 2)
            }

        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(Theme.bg2.opacity(0.85))
        .overlay(Rectangle().fill(Theme.lineSoft).frame(height: 1), alignment: .bottom)
        .sheet(isPresented: $showSearch) {
            SearchSheet(channel: channel)
        }
        .sheet(isPresented: $store.showMembers) {
            MemberListView()
        }
        .sheet(isPresented: $showPins) {
            PinPanelView(channel: channel)
        }
    }

    private var emptyState: some View {
        VStack(spacing: 6) {
            Image(systemName: "number")
                .font(.system(size: 32, weight: .light))
                .foregroundColor(Theme.ink3)
            Text(channel.isDM
                 ? "This is the start of your conversation with \(channel.dmTitle)"
                 : "This is the start of #\(channel.name ?? "channel")")
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.top, 40)
    }

    // MARK: Composer

    private var composer: some View {
        VStack(spacing: 8) {
            if let replying = store.replyingTo {
                HStack(spacing: 8) {
                    Image(systemName: "arrowshape.turn.up.left.fill")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.accent)
                    Text("Replying to")
                        .font(.zkSans(13))
                        .foregroundColor(Theme.ink3)
                    Text(replying.author?.name ?? "Unknown")
                        .font(.zkSans(13, weight: .semibold))
                        .foregroundColor(Theme.ink2)
                        .lineLimit(1)
                    Spacer()
                    Button { store.cancelReply() } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 18))
                            .foregroundColor(Theme.ink3)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 6)
                .background(Theme.bg3)
                .overlay(RoundedRectangle(cornerRadius: 6, style: .continuous).strokeBorder(Theme.line, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
            }
            if let typingText {
                HStack {
                    Text(typingText)
                        .font(.zkSans(11))
                        .italic()
                        .foregroundColor(Theme.ink3)
                    Spacer()
                }
                .padding(.horizontal, 4)
            }
            if let pending = pendingImage {
                HStack(spacing: 10) {
                    Image(uiImage: pending.uiImage)
                        .resizable()
                        .scaledToFill()
                        .frame(width: 52, height: 52)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    Text(pending.filename)
                        .font(.zkSans(12))
                        .foregroundColor(Theme.ink2)
                        .lineLimit(1)
                    Spacer()
                    Button {
                        pendingImage = nil
                        pickerItem = nil
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 20))
                            .foregroundColor(Theme.ink3)
                    }
                }
                .padding(.horizontal, 4)
            }

            if recorder.recording {
                VoiceRecorderBar(
                    recorder: recorder,
                    onSend: { url, dur, wf in
                        Task { await store.sendVoiceMessage(fileURL: url, duration: dur, waveform: wf) }
                    },
                    onCancel: {}
                )
            } else {
            HStack(alignment: .bottom, spacing: 8) {
                autocompleteBar

                // Web composer row: bg-2/60, rounded-lg, 1px line border,
                // accent glow ring while focused. Attach menu leads (the
                // web's paperclip), emoji opens the unified picker, send
                // trails.
                HStack(alignment: .center, spacing: 4) {
                    if channel.isE2EE {
                        // Encrypted DMs: photos only — the bytes are sealed
                        // with the same channel key as the messages.
                        Button { showPhotoPicker = true } label: {
                            Image(systemName: "paperclip")
                                .font(.system(size: 17))
                                .foregroundColor(Theme.ink2)
                                .frame(width: 28, height: 32)
                        }
                    } else {
                        Menu {
                            Button { showPhotoPicker = true } label: { Label("Photo", systemImage: "photo") }
                            Button { showPollSheet = true } label: { Label("Poll", systemImage: "chart.bar.xaxis") }
                            if store.selectedGuild != nil {
                                Button { showStickers = true } label: { Label("Sticker", systemImage: "face.smiling") }
                            }
                            Button { recorder.start() } label: { Label("Voice message", systemImage: "mic.fill") }
                            Button { showSchedule = true } label: { Label("Schedule message", systemImage: "clock") }
                        } label: {
                            Image(systemName: "paperclip")
                                .font(.system(size: 17))
                                .foregroundColor(Theme.ink2)
                                .frame(width: 28, height: 32)
                        }
                    }

                    TextField(composerPlaceholder, text: $draft, axis: .vertical)
                        .lineLimit(1...5)
                        .focused($composerFocused)
                        .foregroundColor(Theme.ink1)
                        .padding(.vertical, 6)

                    Button { showEmojiPicker = true } label: {
                        Image(systemName: "face.smiling")
                            .font(.system(size: 17))
                            .foregroundColor(Theme.ink2)
                            .frame(width: 28, height: 32)
                    }

                    Button(action: send) {
                        if store.uploading {
                            ProgressView().frame(width: 26, height: 26)
                        } else {
                            Image(systemName: "arrow.up.circle.fill")
                                .font(.system(size: 26))
                                .foregroundColor(canSend ? Theme.accent : Theme.ink4)
                        }
                    }
                    .disabled(!canSend || store.uploading)
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(Theme.bg2.opacity(0.6))
                .overlay(
                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                        .strokeBorder(composerFocused ? Theme.accentGlow : Theme.line, lineWidth: 1)
                )
                .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
                .shadow(color: composerFocused ? Theme.accentGlow : .clear, radius: 9)
            }
            }
        }
        .padding(.horizontal, 16)
        .padding(.top, 8)
        .padding(.bottom, 8)
        .background(Theme.bg1.opacity(0.9))
        .overlay(Rectangle().fill(Theme.lineSoft).frame(height: 1), alignment: .top)
        .sheet(isPresented: $showEmojiPicker) {
            EmojiPickerSheet { emoji in
                showEmojiPicker = false
                draft += draft.isEmpty || draft.hasSuffix(" ") ? emoji : " " + emoji
            }
        }
        .onChange(of: pickerItem) { newItem in
            loadPickedItem(newItem)
        }
        .onChange(of: draft) { newValue in
            // Return key sends (the multi-line field inserts a newline
            // instead of submitting — catch it, strip it, send). The
            // keyboard then dismisses inside send().
            if newValue.hasSuffix("\n") {
                draft = String(newValue.dropLast())
                if !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || pendingImage != nil {
                    send()
                }
                return
            }
            guard !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
            if Date().timeIntervalSince(lastTypingSent) > 3 {
                lastTypingSent = Date()
                store.triggerTyping()
            }
        }
        .onChange(of: store.replyingTo) { newValue in
            if newValue != nil { composerFocused = true }
        }
        .sheet(isPresented: $showPollSheet) {
            CreatePollSheet()
        }
        .sheet(isPresented: $showStickers) {
            EmojiStickerPicker(draft: $draft)
        }
        .sheet(isPresented: $showSchedule) {
            ScheduleSheet(draft: $draft)
        }
        .photosPicker(isPresented: $showPhotoPicker, selection: $pickerItem, matching: .images)
    }

    private var canSend: Bool {
        pendingImage != nil || !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var composerPlaceholder: String {
        channel.isDM ? "Message \(channel.dmTitle)" : "Message #\(channel.name ?? "")"
    }

    private var typingNames: [String] {
        let now = Date()
        return store.typing.filter { $0.value > now }.keys.compactMap { nameForUser($0) }
    }

    private var typingText: String? {
        let names = typingNames
        if names.isEmpty { return nil }
        if names.count == 1 { return "\(names[0]) is typing…" }
        if names.count == 2 { return "\(names[0]) and \(names[1]) are typing…" }
        return "Several people are typing…"
    }

    private func nameForUser(_ id: String) -> String {
        if let r = channel.recipients?.first(where: { $0.id == id }) { return r.name }
        if let a = store.messages.first(where: { ($0.author?.id ?? $0.authorId) == id })?.author {
            return a.name
        }
        return "Someone"
    }

    private func send() {
        // Sending dismisses the keyboard (mirrors iMessage/Discord).
        composerFocused = false
        if let pending = pendingImage {
            let caption = draft
            draft = ""
            pendingImage = nil
            pickerItem = nil
            Task {
                await store.sendImage(
                    data: pending.data,
                    filename: pending.filename,
                    contentType: pending.mime,
                    caption: caption
                )
            }
        } else {
            let content = applySlashTransform(draft).trimmingCharacters(in: .whitespacesAndNewlines)
            guard !content.isEmpty else { return }
            draft = ""
            Task { await store.send(content) }
        }
    }

    // MARK: Composer autocomplete (@mentions + :emoji:)

    /// The word currently being typed (everything after the last whitespace).
    /// Autocomplete keys off this; robust for the common case of typing at the
    /// end of the draft.
    private var trailingWord: String {
        if let idx = draft.lastIndex(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) {
            return String(draft[draft.index(after: idx)...])
        }
        return draft
    }
    private var mentionQuery: String? {
        let w = trailingWord
        guard w.hasPrefix("@") else { return nil }
        return String(w.dropFirst())
    }
    private var emojiQuery: String? {
        let w = trailingWord
        guard w.hasPrefix(":"), w.count >= 2, !w.dropFirst().contains(":") else { return nil }
        return String(w.dropFirst())
    }
    private var mentionMatches: [GuildMember] {
        guard let q = mentionQuery else { return [] }
        let ql = q.lowercased()
        let all = Array(store.members.values)
        let filtered = ql.isEmpty ? all : all.filter {
            (($0.nickname ?? "").lowercased().contains(ql))
            || $0.user.name.lowercased().contains(ql)
            || (($0.user.username ?? "").lowercased().contains(ql))
        }
        return Array(filtered.sorted { ($0.nickname ?? $0.user.name).lowercased() < ($1.nickname ?? $1.user.name).lowercased() }.prefix(6))
    }
    private var emojiMatches: [GuildEmoji] {
        guard let q = emojiQuery else { return [] }
        let ql = q.lowercased()
        return Array(store.guildEmojis.filter { $0.name.lowercased().contains(ql) }.prefix(8))
    }

    @ViewBuilder
    private var autocompleteBar: some View {
        if !mentionMatches.isEmpty {
            VStack(spacing: 0) {
                ForEach(mentionMatches) { m in mentionRow(m) }
            }
            .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.bottom, 6)
        } else if !emojiMatches.isEmpty {
            VStack(spacing: 0) {
                ForEach(emojiMatches) { e in emojiRow(e) }
            }
            .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.bottom, 6)
        } else if !slashMatches.isEmpty {
            VStack(spacing: 0) {
                ForEach(slashMatches) { c in slashRow(c) }
            }
            .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 12))
            .padding(.bottom, 6)
        }
    }

    private func mentionRow(_ m: GuildMember) -> some View {
        Button { applyMention(m) } label: {
            HStack(spacing: 8) {
                Avatar(url: m.user.avatarUrl, name: m.nickname ?? m.user.name, size: 24)
                Text(m.nickname ?? m.user.name)
                    .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                if let u = m.user.username {
                    Text("@\(u)").font(.zkSans(12)).foregroundColor(Theme.ink4)
                }
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle()).padding(.horizontal, 12).padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    private func emojiRow(_ e: GuildEmoji) -> some View {
        Button { applyEmoji(e) } label: {
            HStack(spacing: 8) {
                if let img = store.emojiImage(for: e) {
                    Image(uiImage: img).resizable().frame(width: 22, height: 22)
                } else {
                    Image(systemName: "face.smiling").font(.system(size: 16)).foregroundColor(Theme.ink3).frame(width: 22, height: 22)
                }
                Text(":\(e.name):").font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle()).padding(.horizontal, 12).padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    private func applyMention(_ m: GuildMember) {
        draft = String(draft.dropLast(trailingWord.count)) + "<@\(m.userId)> "
    }
    private func applyEmoji(_ e: GuildEmoji) {
        draft = String(draft.dropLast(trailingWord.count)) + ":\(e.name): "
    }

    // MARK: Slash commands (client-side text transforms)

    struct SlashCommand: Identifiable {
        let name: String, usage: String, description: String
        var id: String { name }
    }
    static let slashCommands: [SlashCommand] = [
        .init(name: "me", usage: "/me <action>", description: "Send an action — *you wave*"),
        .init(name: "shrug", usage: "/shrug [text]", description: "Append ¯\\_(ツ)_/¯"),
        .init(name: "tableflip", usage: "/tableflip [text]", description: "Append (╯°□°)╯︵ ┻━┻"),
        .init(name: "unflip", usage: "/unflip [text]", description: "Append ┬─┬ ノ( ゜-゜ノ)"),
        .init(name: "spoiler", usage: "/spoiler <text>", description: "Hide text behind a spoiler"),
    ]
    /// Active slash query: draft begins with "/" and the command name is still
    /// being typed (no whitespace yet).
    private var slashQuery: String? {
        guard draft.hasPrefix("/") else { return nil }
        let rest = String(draft.dropFirst())
        guard !rest.contains(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) else { return nil }
        return rest
    }
    private var slashMatches: [SlashCommand] {
        guard let q = slashQuery else { return [] }
        let ql = q.lowercased()
        return MessageListView.slashCommands.filter { ql.isEmpty || $0.name.hasPrefix(ql) }
    }
    private func slashRow(_ c: SlashCommand) -> some View {
        Button { draft = "/\(c.name) " } label: {
            HStack(spacing: 8) {
                Text(c.usage).font(.zkMono(13, weight: .semibold)).foregroundColor(Theme.ink1)
                Text(c.description).font(.zkSans(12)).foregroundColor(Theme.ink4).lineLimit(1)
                Spacer(minLength: 0)
            }
            .contentShape(Rectangle()).padding(.horizontal, 12).padding(.vertical, 8)
        }
        .buttonStyle(.plain)
    }

    /// Apply a built-in slash command to the outgoing text. Mirrors the web's
    /// transformSlashCommand: unknown commands pass through unchanged.
    private func applySlashTransform(_ input: String) -> String {
        guard input.hasPrefix("/") else { return input }
        let body = String(input.dropFirst())
        let name: String
        let arg: String
        if let sp = body.firstIndex(where: { $0 == " " || $0 == "\n" || $0 == "\t" }) {
            name = String(body[..<sp]).lowercased()
            arg = String(body[body.index(after: sp)...]).trimmingCharacters(in: .whitespacesAndNewlines)
        } else {
            name = body.lowercased()
            arg = ""
        }
        let shrug = "¯\\_(ツ)_/¯"
        let tableflip = "(╯°□°)╯︵ ┻━┻"
        let unflip = "┬─┬ ノ( ゜-゜ノ)"
        let speaker = session.currentUser?.name ?? "someone"
        switch name {
        case "me": return arg.isEmpty ? input : "*\(speaker) \(arg)*"
        case "shrug": return arg.isEmpty ? shrug : "\(arg) \(shrug)"
        case "tableflip": return arg.isEmpty ? tableflip : "\(arg) \(tableflip)"
        case "unflip": return arg.isEmpty ? unflip : "\(arg) \(unflip)"
        case "spoiler": return arg.isEmpty ? input : "||\(arg)||"
        default: return input
        }
    }

    private func loadPickedItem(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self),
                  let uiImage = UIImage(data: data) else { return }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            await MainActor.run {
                pendingImage = PendingImage(
                    data: data,
                    filename: "image.\(ext)",
                    mime: mime,
                    uiImage: uiImage
                )
            }
        }
    }

    // MARK: Grouping

    /// Show the author header row when this message starts a new author group
    /// (or sits just under a date divider).
    private func showHeader(at index: Int) -> Bool {
        if shouldShowDateDivider(at: index) { return true }
        guard index > 0 else { return true }
        let current = store.messages[index]
        let previous = store.messages[index - 1]
        return current.authorId != previous.authorId
    }

    /// Show a date divider above the first message and whenever the calendar
    /// day changes between consecutive messages.
    private func shouldShowDateDivider(at index: Int) -> Bool {
        guard index < store.messages.count else { return false }
        if index == 0 { return true }
        return isDifferentDay(store.messages[index - 1].createdAt, store.messages[index].createdAt)
    }

    /// Show the "New messages" divider before the first message newer than the
    /// frozen unread boundary captured when the channel was opened.
    private func shouldShowUnreadDivider(at index: Int) -> Bool {
        guard let boundary = store.unreadBoundaryId, index < store.messages.count else { return false }
        guard snowflakeGreater(store.messages[index].id, than: boundary) else { return false }
        if index == 0 { return true }
        return !snowflakeGreater(store.messages[index - 1].id, than: boundary)
    }

    /// Id of the first loaded message past the unread boundary (for scroll-to).
    private func firstUnreadId(_ boundary: String) -> String? {
        store.messages.first(where: { snowflakeGreater($0.id, than: boundary) })?.id
    }
}

/// A single message. With `showHeader`, renders avatar + name + time; grouped
/// A run of message content: either plain text (markdown-rendered) or a
/// resolved custom emoji to render inline.
private enum ContentSeg {
    case text(String)
    case emoji(GuildEmoji)
}

/// Centered date separator shown between messages on different calendar days.
struct DateDividerView: View {
    let label: String
    var body: some View {
        HStack(spacing: 12) {
            Rectangle().fill(Theme.line).frame(height: 1)
            Text(label.uppercased())
                .font(.zkSans(10, weight: .semibold))
                .tracking(0.8)
                .foregroundColor(Theme.ink3)
                .fixedSize()
            Rectangle().fill(Theme.line).frame(height: 1)
        }
        .padding(.vertical, 8)
    }
}

/// Red "New messages" separator marking where the user last left off.
struct UnreadDividerView: View {
    var body: some View {
        HStack(spacing: 8) {
            Rectangle().fill(Theme.danger).frame(height: 1)
            Text("New messages")
                .font(.zkSans(10, weight: .bold))
                .foregroundColor(Theme.danger)
                .fixedSize()
        }
        .padding(.vertical, 3)
    }
}

/// follow-ups render just the content indented to align under the name.
struct MessageRow: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.openURL) private var openURL
    let message: Message
    let channel: Channel
    let showHeader: Bool
    /// 1:1 DM read receipt rendered under this row ("Sent" / "Delivered" /
    /// "Read") — set only on the anchor messages, mirroring the web.
    var dmReceipt: String? = nil

    private let gutter: CGFloat = 52

    @State private var showEdit = false
    @State private var showDeleteConfirm = false
    @State private var showForward = false
    @State private var showReactionPicker = false
    @State private var editText = ""

    var body: some View {
        // Web parity: ONLY system_call renders as a quiet notice line.
        // Other system messages (system_join welcomes, pins, …) render
        // as a regular row — the joiner's avatar on the left, name, and
        // the welcome text, as if they sent it.
        if message.type == "system_call" {
            systemRow
        } else {
        rowContent
            .contextMenu { menuItems }
            .sheet(isPresented: $showEdit) {
                EditMessageSheet(message: message, initialText: editText)
            }
            .sheet(isPresented: $showForward) {
                ForwardSheet(message: message)
            }
            .sheet(isPresented: $showReactionPicker) {
                EmojiPickerSheet { emoji in
                    showReactionPicker = false
                    react(emoji)
                }
            }
            .confirmationDialog("Delete message?", isPresented: $showDeleteConfirm, titleVisibility: .visible) {
                Button("Delete", role: .destructive) {
                    Task { await store.deleteMessage(message) }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    /// Web parity: system_call renders "Missed call from X" (red) or
    /// "Call ended · 5m 23s" as a quiet notice line.
    @ViewBuilder
    private var systemRow: some View {
        HStack(spacing: 7) {
            let missed = message.metadata?.missed ?? false
            Image(systemName: missed ? "phone.arrow.down.left" : "phone")
                .font(.system(size: 11))
                .foregroundColor(missed ? Theme.dangerSoft.opacity(0.85) : Theme.ink3)
            Text(callSummary)
                .font(.zkSans(12))
                .foregroundColor(missed ? Theme.dangerSoft.opacity(0.9) : Theme.ink2)
            Text("·").foregroundColor(Theme.ink4)
            Text(shortTime(message.createdAt))
                .font(.zkSans(11))
                .foregroundColor(Theme.ink4)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 4)
        .padding(.leading, gutter)
    }

    private var callSummary: String {
        let missed = message.metadata?.missed ?? false
        let caller = message.author?.name ?? "Someone"
        if missed { return "Missed call from \(caller)" }
        let ms = message.metadata?.durationMs ?? 0
        let total = ms / 1000
        let label: String
        if total >= 3600 {
            label = "\(total / 3600)h \((total % 3600) / 60)m"
        } else if total >= 60 {
            label = "\(total / 60)m \(total % 60)s"
        } else {
            label = "\(total)s"
        }
        return "Call ended · \(label)"
    }

    static let quickEmoji = ["👍", "❤️", "😂", "🎉", "😮", "😢", "🙏", "🔥"]

    @ViewBuilder
    private var menuItems: some View {
        Menu {
            ForEach(MessageRow.quickEmoji, id: \.self) { e in
                Button(e) { react(e) }
            }
            Divider()
            Button { showReactionPicker = true } label: {
                Label("More…", systemImage: "plus.circle")
            }
        } label: {
            Label("Add reaction", systemImage: "face.smiling")
        }
        Button { store.setReply(message) } label: {
            Label("Reply", systemImage: "arrowshape.turn.up.left")
        }
        Button { Task { await store.togglePin(message) } } label: {
            Label(message.pinned == true ? "Unpin" : "Pin",
                  systemImage: message.pinned == true ? "pin.slash" : "pin")
        }
        Button { showForward = true } label: {
            Label("Forward", systemImage: "arrowshape.turn.up.right")
        }
        Button { Task { await store.toggleSave(message) } } label: {
            Label(store.isSaved(message.id) ? "Unsave" : "Save",
                  systemImage: store.isSaved(message.id) ? "bookmark.slash" : "bookmark")
        }
        // Only CONFIRMED own messages get Edit/Delete. An optimistic
        // placeholder (sendState "sending"/"failed") has a client-UUID id,
        // so editing/deleting it PATCHes /messages/<UUID> → 400 and the
        // edit is silently lost — which read as "I can't edit the message I
        // just sent." Failed rows have their own inline Retry/Delete.
        if isOwn && message.sendState == nil {
            Button { beginEdit() } label: {
                Label("Edit", systemImage: "pencil")
            }
            Button(role: .destructive) { showDeleteConfirm = true } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }

    private var isOwn: Bool {
        let authorId = message.authorId ?? message.author?.id
        return authorId != nil && authorId == store.currentUserId
    }

    private func beginEdit() {
        switch store.display(for: message, in: channel) {
        case .text(let t): editText = t
        default: editText = message.text
        }
        showEdit = true
    }

    private func react(_ emoji: String) {
        Task { await store.toggleReaction(message, emoji: emoji) }
    }

    @ViewBuilder
    private var replyPreview: some View {
        HStack(spacing: 6) {
            Image(systemName: "arrowshape.turn.up.left.fill")
                .font(.system(size: 10))
                .foregroundColor(Theme.ink3)
            if let replied = store.repliedMessage(for: message) {
                Avatar(url: replied.author?.avatarUrl, name: replied.author?.name ?? "?",
                       size: 16, ringColor: Theme.bg1)
                Text(replied.author?.name ?? "Unknown")
                    .font(.zkSans(12, weight: .semibold))
                    .foregroundColor(Theme.ink2)
                Text(replyPreviewText(replied))
                    .font(.zkSans(12))
                    .foregroundColor(Theme.ink3)
                    .lineLimit(1)
            } else {
                Text("Replying to a message")
                    .font(.zkSans(12))
                    .foregroundColor(Theme.ink3)
                    .italic()
            }
        }
        .padding(.bottom, 1)
    }

    private func replyPreviewText(_ m: Message) -> String {
        switch store.display(for: m, in: channel) {
        case .text(let t):
            if !t.isEmpty { return t }
            if m.sticker != nil { return "🏷️ Sticker" }
            if m.attachments?.contains(where: { $0.isVoiceMessage == true }) == true { return "🎤 Voice message" }
            if m.attachments?.isEmpty == false { return "📎 Attachment" }
            if m.poll != nil { return "📊 Poll" }
            return "Message"
        case .locked, .undecryptable:
            return "🔒 Encrypted message"
        }
    }

    /// Webhook persona (web parity): when set, the override name/avatar
    /// replace the author's user record everywhere in the row.
    private var isWebhook: Bool { message.webhookId != nil }
    private var displayName: String {
        if isWebhook { return message.authorOverrideName ?? message.author?.name ?? "Webhook" }
        return message.author?.name ?? "Unknown"
    }
    private var displayAvatarUrl: String? {
        if isWebhook { return message.authorOverrideAvatar ?? message.author?.avatarUrl }
        return message.author?.avatarUrl
    }

    private var rowContent: some View {
        HStack(alignment: .top, spacing: 0) {
            if showHeader {
                Avatar(
                    url: displayAvatarUrl,
                    name: displayName,
                    size: 40,
                    status: isWebhook ? nil : store.status(for: message.authorId, fallback: message.author?.status),
                    ringColor: Theme.bg1,
                    decoration: isWebhook ? nil : message.author?.avatarDecoration,
                    toneId: isWebhook ? message.webhookId : (message.authorId ?? message.author?.id)
                )
                .frame(width: gutter, alignment: .leading)
                .onTapGesture { if !isWebhook, let a = message.author { store.openProfile(a) } }
            } else {
                Color.clear.frame(width: gutter)
            }

            VStack(alignment: .leading, spacing: 4) {
                if message.replyToId != nil {
                    replyPreview
                }
                if showHeader {
                    HStack(alignment: .firstTextBaseline, spacing: 6) {
                        Text(displayName)
                            .font(.zkSans(15, weight: .medium))
                            .foregroundColor(isWebhook ? Theme.ink1 : (store.memberColor(message.authorId ?? message.author?.id ?? "") ?? Theme.ink1))
                            .onTapGesture { if !isWebhook, let a = message.author { store.openProfile(a) } }
                        if isWebhook {
                            Text("WEBHOOK")
                                .font(.zkSans(8.5, weight: .bold))
                                .tracking(0.5)
                                .foregroundColor(Theme.accent2)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(Theme.accent2.opacity(0.2))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        if message.author?.isBot == true {
                            Text("BOT")
                                .font(.zkSans(8.5, weight: .bold))
                                .tracking(0.5)
                                .foregroundColor(Theme.accent)
                                .padding(.horizontal, 5)
                                .padding(.vertical, 1.5)
                                .background(Theme.accent.opacity(0.2))
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                        Text(shortTime(message.createdAt))
                            .font(.zkSans(11))
                            .foregroundColor(Theme.ink3)
                        if message.editedAt != nil {
                            Text("(edited)")
                                .font(.zkSans(11))
                                .foregroundColor(Theme.ink3)
                        }
                    }
                }
                if let fwd = message.forwardedFrom {
                    forwardedBlock(fwd)
                }
                content
                stickerView
                pollView
                attachmentsView
                embedsView
                reactionsView
                sendStatusView
                if let dmReceipt {
                    Text(dmReceipt)
                        .font(.zkSans(10))
                        .foregroundColor(Theme.ink3)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                        .padding(.top, 1)
                }
            }
            Spacer(minLength: 0)
        }
        // Web parity: pinned rows carry a faint amber wash.
        .background(
            message.pinned == true
                ? Color(hex: 0xF59E0B).opacity(0.04)
                : Color.clear
        )
    }

    @ViewBuilder
    private var sendStatusView: some View {
        if message.sendState == "sending" {
            HStack(spacing: 5) {
                ProgressView().scaleEffect(0.6)
                Text("Sending…")
                    .font(.zkSans(11))
                    .foregroundColor(Theme.ink3)
            }
            .padding(.top, 2)
        } else if message.sendState == "failed" {
            HStack(spacing: 10) {
                HStack(spacing: 4) {
                    Image(systemName: "exclamationmark.circle.fill")
                        .font(.system(size: 11))
                    Text("Failed to send").font(.zkSans(11))
                }
                .foregroundColor(Theme.danger)
                Button("Retry") { Task { await store.retrySend(message.id) } }
                    .font(.zkSans(11, weight: .semibold))
                    .foregroundColor(Theme.accent)
                Button("Delete") { store.discardFailed(message.id) }
                    .font(.zkSans(11, weight: .semibold))
                    .foregroundColor(Theme.ink3)
            }
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private var content: some View {
        switch store.display(for: message, in: channel) {
        case .text(let t):
            if !t.isEmpty {
                if let jumbo = emojiOnly(t) {
                    HStack(spacing: 4) {
                        ForEach(Array(jumbo.enumerated()), id: \.offset) { _, e in
                            jumboEmoji(e)
                        }
                    }
                    .padding(.vertical, 2)
                } else {
                    VStack(alignment: .leading, spacing: 6) {
                        ForEach(Array(splitCodeBlocks(t).enumerated()), id: \.offset) { _, block in
                            blockView(block)
                        }
                    }
                }
            }
        case .locked:
            Label("Locked", systemImage: "lock.fill")
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
        case .undecryptable:
            Label("Couldn't decrypt", systemImage: "lock.slash")
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
        }
    }

    // ── Fenced code blocks ───────────────────────────────────────────────────
    // Mirrors the web's markdown pass 1: split ```fenced``` blocks out so they
    // render as monospace blocks while the rest goes through inline markdown.
    enum ContentBlock {
        case text(String)
        case code(String)
    }

    private func splitCodeBlocks(_ s: String) -> [ContentBlock] {
        guard s.contains("```") else { return [.text(s)] }
        let re = MessageRow.codeBlockRegex
        let ns = s as NSString
        let matches = re.matches(in: s, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return [.text(s)] }
        var blocks: [ContentBlock] = []
        var last = 0
        for m in matches {
            if m.range.location > last {
                let txt = ns.substring(with: NSRange(location: last, length: m.range.location - last))
                    .trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
                if !txt.isEmpty { blocks.append(.text(txt)) }
            }
            var code = ns.substring(with: m.range(at: 1))
            while code.hasSuffix("\n") { code.removeLast() }
            blocks.append(.code(code))
            last = m.range.location + m.range.length
        }
        if last < ns.length {
            let txt = ns.substring(with: NSRange(location: last, length: ns.length - last))
                .trimmingCharacters(in: CharacterSet(charactersIn: "\n"))
            if !txt.isEmpty { blocks.append(.text(txt)) }
        }
        return blocks
    }

    @ViewBuilder
    private func blockView(_ block: ContentBlock) -> some View {
        switch block {
        case .text(let tt):
            inlineText(tt)
                .font(.zkSans(15))
                .foregroundColor(Theme.ink1)
                .tint(Theme.accent)
                .fixedSize(horizontal: false, vertical: true)
        case .code(let cc):
            codeBlockView(cc)
        }
    }

    @ViewBuilder
    private func codeBlockView(_ code: String) -> some View {
        // Web `pre`: bg-bg-3, rounded-md, px-3 py-2, mono at 0.9em — no border.
        ScrollView(.horizontal, showsIndicators: false) {
            Text(code)
                .font(.zkMono(13.5))
                .foregroundColor(Theme.ink1)
                .textSelection(.enabled)
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
        }
        .background(Theme.bg3)
        .clipShape(RoundedRectangle(cornerRadius: 6))
    }

    // ── Custom emoji (`:name:`) inline rendering ────────────────────────────
    private static let emojiTokenRegex = try! NSRegularExpression(pattern: ":([a-z0-9_]{2,32}):")
    // Compiled once (was rebuilt on every row render): the fenced-code-block
    // splitter and the mention-token matcher. NSRegularExpression compilation
    // is the expensive part — matching against a short message body is cheap.
    private static let codeBlockRegex = try! NSRegularExpression(pattern: "```[^\\n]*\\n?([\\s\\S]*?)```")
    private static let mentionRegex = try! NSRegularExpression(pattern: "<@!?\\d+>|<@&\\d+>|<#\\d+>")

    private func parseSegments(_ s: String) -> [ContentSeg] {
        let map = store.emojiByName
        if map.isEmpty || !s.contains(":") { return [.text(s)] }
        let ns = s as NSString
        let matches = MessageRow.emojiTokenRegex.matches(in: s, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return [.text(s)] }
        var segs: [ContentSeg] = []
        var last = 0
        for m in matches {
            let name = ns.substring(with: m.range(at: 1))
            guard let emoji = map[name] else { continue }  // unresolved → stays literal text
            if m.range.location > last {
                segs.append(.text(ns.substring(with: NSRange(location: last, length: m.range.location - last))))
            }
            segs.append(.emoji(emoji))
            last = m.range.location + m.range.length
        }
        if last < ns.length {
            segs.append(.text(ns.substring(with: NSRange(location: last, length: ns.length - last))))
        }
        return segs.isEmpty ? [.text(s)] : segs
    }

    /// If the message is only resolvable emoji (1–12) and whitespace, return
    /// them for jumbo rendering; otherwise nil.
    private func emojiOnly(_ s: String) -> [GuildEmoji]? {
        let segs = parseSegments(s)
        var emojis: [GuildEmoji] = []
        for seg in segs {
            switch seg {
            case .emoji(let e): emojis.append(e)
            case .text(let t):
                if !t.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return nil }
            }
        }
        return (emojis.isEmpty || emojis.count > 12) ? nil : emojis
    }

    /// Resolve user/role/channel mention tokens (<@id>, <@!id>, <@&id>, <#id>)
    /// into readable, accent-colored labels; everything else is markdown-parsed.
    /// Mirrors the web markdown renderer's mention chips.
    private func richContent(_ s: String) -> AttributedString {
        guard s.contains("<@") || s.contains("<#") else { return markdownAttributed(s) }
        let re = MessageRow.mentionRegex
        let ns = s as NSString
        let matches = re.matches(in: s, range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return markdownAttributed(s) }
        var result = AttributedString("")
        var last = 0
        for m in matches {
            if m.range.location > last {
                result.append(markdownAttributed(ns.substring(with: NSRange(location: last, length: m.range.location - last))))
            }
            var chip = AttributedString(mentionLabel(ns.substring(with: m.range)))
            chip.foregroundColor = Theme.accentSoft
            chip.backgroundColor = Theme.accent.opacity(0.2)
            chip.font = .zkSans(15, weight: .medium)
            result.append(chip)
            last = m.range.location + m.range.length
        }
        if last < ns.length {
            result.append(markdownAttributed(ns.substring(with: NSRange(location: last, length: ns.length - last))))
        }
        return result
    }

    private func mentionLabel(_ token: String) -> String {
        let digits = token.filter { $0.isNumber }
        if token.hasPrefix("<#") {
            return "#\(store.channels.first(where: { $0.id == digits })?.name ?? "channel")"
        }
        if token.hasPrefix("<@&") {
            return "@\(store.roles.first(where: { $0.id == digits })?.name ?? "role")"
        }
        return "@\(store.memberName(digits) ?? "user")"
    }

    private func inlineText(_ s: String) -> Text {
        var result = Text("")
        for seg in parseSegments(s) {
            switch seg {
            case .text(let t):
                result = result + Text(richContent(t))
            case .emoji(let e):
                if let img = store.emojiImage(for: e) {
                    result = result + Text(Image(uiImage: img)).baselineOffset(-3)
                } else {
                    result = result + Text(":\(e.name):")
                }
            }
        }
        return result
    }

    private func jumboEmoji(_ e: GuildEmoji) -> some View {
        AsyncImage(url: assetURL(e.url)) { phase in
            switch phase {
            case .success(let image): image.resizable().scaledToFit()
            default: Text(":\(e.name):").font(.zkSans(14)).foregroundColor(Theme.ink3)
            }
        }
        .frame(width: 40, height: 40)
    }

    @ViewBuilder
    private var pollView: some View {
        if let poll = message.poll {
            PollCard(poll: poll) { option in
                Task { await store.togglePollVote(message: message, option: option) }
            }
        }
    }

    @ViewBuilder
    private var stickerView: some View {
        if let sticker = message.sticker, let url = assetURL(sticker.url) {
            AsyncImage(url: url) { phase in
                switch phase {
                case .success(let image):
                    image.resizable().scaledToFit()
                case .empty:
                    ProgressView().frame(width: 120, height: 120)
                default:
                    Text(":\(sticker.name):").font(.zkSans(13)).foregroundColor(Theme.ink3)
                }
            }
            .frame(width: 140, height: 140, alignment: .leading)
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private var embedsView: some View {
        if let embeds = message.embeds, !embeds.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(Array(embeds.enumerated()), id: \.offset) { _, e in
                    embedCard(e)
                }
            }
            .padding(.top, 2)
        }
    }

    @ViewBuilder
    private func embedCard(_ e: MessageEmbed) -> some View {
        if e.kind == "image", let img = assetURL(e.imageUrl) {
            // Pure image unfurl — just the picture.
            AsyncImage(url: img) { phase in
                if case .success(let image) = phase {
                    image.resizable().scaledToFit()
                        .onTapGesture { store.openLightbox(img) }
                }
            }
            .frame(maxWidth: 260, maxHeight: 260, alignment: .leading)
            .clipShape(RoundedRectangle(cornerRadius: 10))
        } else {
            HStack(alignment: .top, spacing: 10) {
                RoundedRectangle(cornerRadius: 2).fill(Theme.accent).frame(width: 3)
                VStack(alignment: .leading, spacing: 5) {
                    if let site = e.siteName, !site.isEmpty {
                        HStack(spacing: 5) {
                            if let fav = assetURL(e.faviconUrl) {
                                AsyncImage(url: fav) { img in img.resizable() } placeholder: { Color.clear }
                                    .frame(width: 14, height: 14).clipShape(RoundedRectangle(cornerRadius: 3))
                            }
                            Text(site).font(.zkSans(11)).foregroundColor(Theme.ink3).lineLimit(1)
                        }
                    }
                    if let title = e.title, !title.isEmpty {
                        Text(title).font(.zkSans(14, weight: .semibold))
                            .foregroundColor(Theme.accent).lineLimit(2)
                    }
                    if let desc = e.description, !desc.isEmpty {
                        Text(desc).font(.zkSans(13)).foregroundColor(Theme.ink2)
                            .lineLimit(4).fixedSize(horizontal: false, vertical: true)
                    }
                    if (e.title?.isEmpty ?? true) && (e.description?.isEmpty ?? true) {
                        Text(e.url).font(.zkSans(13)).foregroundColor(Theme.accent).lineLimit(1)
                    }
                    if let img = assetURL(e.imageUrl) {
                        AsyncImage(url: img) { phase in
                            if case .success(let image) = phase {
                                image.resizable().scaledToFit()
                                    .onTapGesture { store.openLightbox(img) }
                            }
                        }
                        .frame(maxWidth: 240, maxHeight: 160, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 8))
                    }
                }
            }
            .padding(10)
            .frame(maxWidth: 300, alignment: .leading)
            .background(Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 8))
            .contentShape(Rectangle())
            .onTapGesture { if let u = URL(string: e.url) { openURL(u) } }
        }
    }

    /// Snapshot of a forwarded message: an attribution line + the source
    /// content, in a left-bordered block. Mirrors ForwardedMessageBlock.
    private func forwardedBlock(_ fwd: ForwardSource) -> some View {
        let where_ = fwd.channel?.name.map { "#\($0)" } ?? "a channel"
        let who = fwd.author?.name ?? "Unknown"
        return HStack(alignment: .top, spacing: 8) {
            Rectangle().fill(Theme.line).frame(width: 3)
            VStack(alignment: .leading, spacing: 3) {
                HStack(spacing: 5) {
                    Image(systemName: "arrowshape.turn.up.right.fill")
                        .font(.system(size: 9)).foregroundColor(Theme.ink3)
                    Text("Forwarded from \(who) in \(where_)")
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink3)
                        .lineLimit(1)
                }
                if fwd.content.isEmpty {
                    Text("[unavailable]")
                        .font(.zkSans(14)).italic()
                        .foregroundColor(Theme.ink4)
                } else {
                    Text(fwd.content)
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink2)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(.vertical, 2)
    }

    @ViewBuilder
    private var attachmentsView: some View {
        if let attachments = message.attachments, !attachments.isEmpty {
            VStack(alignment: .leading, spacing: 6) {
                ForEach(attachments) { att in
                    if channel.isE2EE, att.filename?.hasSuffix(".zke") == true {
                        EncryptedAttachmentView(attachment: att, channel: channel)
                    } else if att.isVoiceMessage == true {
                        VoiceMessageView(attachment: att)
                    } else if att.isImage, let url = assetURL(att.url) {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().scaledToFit()
                                    .onTapGesture { store.openLightbox(url) }
                            case .empty:
                                ProgressView().frame(width: 140, height: 90)
                            default:
                                fileChip(att)
                            }
                        }
                        .frame(maxWidth: 240, maxHeight: 240, alignment: .leading)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        // Long-press → Save to Photos / Copy / Share. Loads the
                        // image bytes on demand via the native retrying loader.
                        .imageActions { await RetryingImage.load(url) }
                    } else {
                        fileChip(att)
                    }
                }
            }
            .padding(.top, 2)
        }
    }

    private func fileChip(_ att: Attachment) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "doc.fill").foregroundColor(Theme.ink3)
            VStack(alignment: .leading, spacing: 1) {
                Text(att.filename ?? "file")
                    .font(.zkSans(13, weight: .medium))
                    .foregroundColor(Theme.ink1)
                    .lineLimit(1)
                if let size = att.size {
                    Text(byteString(size))
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink3)
                }
            }
        }
        .padding(8)
        .background(Theme.bg3)
        .clipShape(RoundedRectangle(cornerRadius: 8))
    }

    @ViewBuilder
    private var reactionsView: some View {
        if let reactions = message.reactions, !reactions.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 4) {
                    ForEach(reactions, id: \.emoji) { r in
                        ReactionPill(reaction: r) { react(r.emoji) }
                    }
                    // Web parity: trailing "+" pill opens the emoji picker.
                    Button { showReactionPicker = true } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 10, weight: .semibold))
                            .foregroundColor(Theme.ink3)
                            .frame(width: 28, height: 24)
                            .background(Theme.bg2)
                            .overlay(RoundedRectangle(cornerRadius: 6).strokeBorder(Theme.line, lineWidth: 1))
                            .clipShape(RoundedRectangle(cornerRadius: 6))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.top, 2)
        }
    }
}

private func byteString(_ bytes: Int) -> String {
    let kb = 1024.0
    let mb = kb * 1024
    let b = Double(bytes)
    if b >= mb { return String(format: "%.1f MB", b / mb) }
    if b >= kb { return String(format: "%.0f KB", b / kb) }
    return "\(bytes) B"
}

struct ReactionPill: View {
    @EnvironmentObject private var store: AppStore
    let reaction: ReactionAggregate
    let onTap: () -> Void

    var body: some View {
        Button(action: onTap) {
            HStack(spacing: 4) {
                glyph
                Text("\(reaction.count)")
                    .font(.zkSans(11))
                    .foregroundColor(Theme.ink2)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .background(reaction.me ? Theme.accent.opacity(0.2) : Theme.bg2)
            .overlay(
                RoundedRectangle(cornerRadius: 6)
                    .strokeBorder(reaction.me ? Theme.accent.opacity(0.6) : Theme.line, lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 6))
        }
        .buttonStyle(.plain)
    }

    /// Unicode reactions render as text; `:name:` custom reactions resolve
    /// against the guild emoji index (web ReactionGlyph parity).
    @ViewBuilder
    private var glyph: some View {
        if reaction.emoji.hasPrefix(":") && reaction.emoji.hasSuffix(":"),
           let e = store.emojiByName[String(reaction.emoji.dropFirst().dropLast())],
           let img = store.emojiImage(for: e) {
            Image(uiImage: img)
                .resizable()
                .scaledToFit()
                .frame(width: 18, height: 18)
        } else {
            Text(reaction.emoji)
                .font(.zkSans(13))
                .frame(height: 18)
        }
    }
}

/// Shown in place of the timeline when an encrypted DM has no local key.
/// Collects the shared password, verifies it, and unlocks the conversation.
private struct UnlockPanel: View {
    @EnvironmentObject private var store: AppStore
    let channel: Channel
    @State private var password = ""
    @State private var showRestore = false
    @State private var restoreNote: String?
    @FocusState private var focused: Bool

    var body: some View {
        VStack(spacing: 16) {
            Spacer()
            Image(systemName: "lock.fill")
                .font(.system(size: 40))
                .foregroundColor(Theme.accent)
            Text("End-to-end encrypted")
                .font(.zkSans(18, weight: .semibold))
                .foregroundColor(Theme.ink1)
            Text("Enter the shared password to read and send messages here.")
                .font(.zkSans(14))
                .foregroundColor(Theme.ink3)
                .multilineTextAlignment(.center)
                .padding(.horizontal, 32)

            SecureField("Password", text: $password)
                .textContentType(.password)
                .focused($focused)
                .submitLabel(.go)
                .onSubmit(unlock)
                .foregroundColor(Theme.ink1)
                .padding(.horizontal, 12)
                .padding(.vertical, 11)
                .background(Theme.bg2)
                .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 32)

            if let err = store.e2eeError {
                Text(err)
                    .font(.zkSans(13))
                    .foregroundColor(Theme.danger)
            }

            Button(action: unlock) {
                Text("Unlock")
                    .font(.zkSans(15, weight: .semibold))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 13)
                    .foregroundColor(.white)
                    .background(password.isEmpty ? Theme.accent.opacity(0.4) : Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .disabled(password.isEmpty)
            .padding(.horizontal, 32)

            Button { showRestore = true } label: {
                Text("Or restore from a backup file")
                    .font(.zkSans(13, weight: .medium))
                    .foregroundColor(Theme.accent)
            }
            .padding(.top, 2)

            if let restoreNote {
                Text(restoreNote)
                    .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    .multilineTextAlignment(.center).padding(.horizontal, 32)
            }

            Spacer()
            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg1)
        .onAppear { focused = true }
        .fileImporter(
            isPresented: $showRestore,
            allowedContentTypes: [.json],
            allowsMultipleSelection: false
        ) { result in restore(result) }
    }

    private func unlock() {
        guard !password.isEmpty else { return }
        Task {
            if await store.unlockE2EE(channel, password: password) { password = "" }
        }
    }

    private func restore(_ result: Result<[URL], Error>) {
        guard case .success(let urls) = result, let url = urls.first else {
            if case .failure(let e) = result { restoreNote = e.localizedDescription }
            return
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            restoreNote = "Couldn't read that file."; return
        }
        guard let restored = store.importE2EEKeysJSON(data) else {
            restoreNote = "That file isn't a valid Zekktris keys backup."; return
        }
        // Success: if this DM's key arrived the panel disappears on its own
        // (showUnlockPanel re-evaluates via e2eeUnlockVersion).
        restoreNote = "Restored \(restored.count) key\(restored.count == 1 ? "" : "s")."
    }
}

/// Sheet for turning on E2EE for a DM by choosing a shared password.
private struct EnableE2EESheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    @State private var password = ""
    @State private var confirm = ""
    @State private var busy = false

    private var canEnable: Bool { password.count >= 4 && password == confirm }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg1.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 16) {
                    Text("Pick a shared password and share it with the other person out-of-band. The server never sees it — they enter the same password to read these messages.")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink2)

                    secureField("Password", text: $password)
                    secureField("Confirm password", text: $confirm)

                    if !confirm.isEmpty && confirm != password {
                        Text("Passwords don't match")
                            .font(.zkSans(12))
                            .foregroundColor(Theme.danger)
                    }
                    if let err = store.e2eeError {
                        Text(err)
                            .font(.zkSans(13))
                            .foregroundColor(Theme.danger)
                    }

                    Button(action: enable) {
                        ZStack {
                            if busy { ProgressView().tint(.white) }
                            else { Text("Enable encryption").font(.zkSans(15, weight: .semibold)) }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .foregroundColor(.white)
                        .background(canEnable ? Theme.accent : Theme.accent.opacity(0.4))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .disabled(!canEnable || busy)

                    Text("Note: enabling encryption is permanent until disabled, and existing plaintext history stays readable. New messages from both sides are encrypted.")
                        .font(.zkSans(12))
                        .foregroundColor(Theme.ink3)

                    Spacer()
                }
                .padding(20)
            }
            .navigationTitle("Encrypt DM")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func secureField(_ title: String, text: Binding<String>) -> some View {
        SecureField(title, text: text)
            .textContentType(.newPassword)
            .foregroundColor(Theme.ink1)
            .padding(.horizontal, 12)
            .padding(.vertical, 11)
            .background(Theme.bg2)
            .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func enable() {
        busy = true
        Task {
            let ok = await store.enableE2EE(channel, password: password)
            busy = false
            if ok { dismiss() }
        }
    }
}

/// A picked-but-not-yet-sent image held by the composer.
private struct PendingImage {
    let data: Data
    let filename: String
    let mime: String
    let uiImage: UIImage
}

/// Sheet for editing one of the current user's messages.
struct EditMessageSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let message: Message
    @State private var text: String

    init(message: Message, initialText: String) {
        self.message = message
        _text = State(initialValue: initialText)
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                TextField("Message", text: $text, axis: .vertical)
                    .lineLimit(3...10)
                    .padding(12)
                    .background(Theme.bg3)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundColor(Theme.ink1)
                Spacer()
            }
            .padding(16)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Edit message")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") {
                        let newText = text
                        dismiss()
                        Task { await store.editMessage(message, newContent: newText) }
                    }
                    .disabled(text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
            }
        }
    }
}

/// A poll attached to a message: question, tappable options with live tallies.
struct PollCard: View {
    let poll: Poll
    let onVote: (PollOption) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(poll.question)
                .font(.zkSans(15, weight: .semibold))
                .foregroundColor(Theme.ink1)
            ForEach(poll.options.sorted { $0.position < $1.position }) { option in
                PollOptionRow(option: option, poll: poll) { onVote(option) }
            }
            HStack(spacing: 5) {
                Text("\(poll.totalVoters) vote\(poll.totalVoters == 1 ? "" : "s")")
                if poll.multipleChoice { Text("· Multiple choice") }
                if !poll.isOpen { Text("· Closed") }
            }
            .font(.zkSans(11))
            .foregroundColor(Theme.ink3)
        }
        .padding(12)
        .frame(maxWidth: 320, alignment: .leading)
        .background(Theme.bg2)
        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .padding(.top, 2)
    }
}

private struct PollOptionRow: View {
    let option: PollOption
    let poll: Poll
    let onTap: () -> Void

    private var fraction: Double {
        poll.totalVoters > 0 ? Double(option.voteCount) / Double(poll.totalVoters) : 0
    }
    private var voted: Bool { poll.myVotes.contains(option.id) }

    var body: some View {
        Button(action: onTap) {
            ZStack(alignment: .leading) {
                GeometryReader { geo in
                    RoundedRectangle(cornerRadius: 8)
                        .fill(voted ? Theme.accent.opacity(0.28) : Theme.bg3)
                        .frame(width: max(6, geo.size.width * fraction))
                }
                HStack(spacing: 6) {
                    if voted {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundColor(Theme.accent)
                    }
                    Text(option.text)
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink1)
                        .lineLimit(2)
                    Spacer()
                    Text("\(option.voteCount)")
                        .font(.zkSans(12, weight: .medium))
                        .foregroundColor(Theme.ink2)
                }
                .padding(.horizontal, 10)
            }
            .frame(height: 36)
            .background(Theme.bg3.opacity(0.4))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(!poll.isOpen)
    }
}

/// Sheet for composing a new poll (question, options, choice mode, duration).
struct CreatePollSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var question = ""
    @State private var options: [String] = ["", ""]
    @State private var multipleChoice = false
    @State private var durationHours = 24

    private let durations: [(String, Int)] = [
        ("1 hour", 1), ("6 hours", 6), ("1 day", 24), ("3 days", 72), ("1 week", 168),
    ]

    private var trimmedOptions: [String] {
        options.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
    }
    private var canCreate: Bool {
        !question.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && trimmedOptions.count >= 2
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    section("QUESTION") {
                        TextField("Ask something…", text: $question, axis: .vertical)
                            .lineLimit(1...3)
                            .padding(12)
                            .background(Theme.bg3)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                            .foregroundColor(Theme.ink1)
                    }

                    section("OPTIONS") {
                        VStack(spacing: 8) {
                            ForEach(options.indices, id: \.self) { i in
                                HStack(spacing: 8) {
                                    TextField("Option \(i + 1)", text: $options[i])
                                        .padding(12)
                                        .background(Theme.bg3)
                                        .clipShape(RoundedRectangle(cornerRadius: 10))
                                        .foregroundColor(Theme.ink1)
                                    if options.count > 2 {
                                        Button { options.remove(at: i) } label: {
                                            Image(systemName: "minus.circle.fill")
                                                .font(.system(size: 20))
                                                .foregroundColor(Theme.ink3)
                                        }
                                    }
                                }
                            }
                            if options.count < 10 {
                                Button { options.append("") } label: {
                                    Label("Add option", systemImage: "plus.circle")
                                        .font(.zkSans(14))
                                        .foregroundColor(Theme.accent)
                                }
                                .frame(maxWidth: .infinity, alignment: .leading)
                            }
                        }
                    }

                    Toggle("Allow multiple answers", isOn: $multipleChoice)
                        .font(.zkSans(15))
                        .foregroundColor(Theme.ink1)
                        .tint(Theme.accent)

                    section("DURATION") {
                        Picker("Duration", selection: $durationHours) {
                            ForEach(durations, id: \.1) { label, hours in
                                Text(label).tag(hours)
                            }
                        }
                        .pickerStyle(.segmented)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("New Poll")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") {
                        let q = question
                        let opts = trimmedOptions
                        let multi = multipleChoice
                        let hours = durationHours
                        dismiss()
                        Task { await store.sendPoll(question: q, options: opts, multipleChoice: multi, durationHours: hours) }
                    }
                    .disabled(!canCreate)
                }
            }
        }
    }

    @ViewBuilder
    private func section(_ title: String, @ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title)
                .font(.zkSans(11, weight: .bold))
                .foregroundColor(Theme.ink3)
            content()
        }
    }
}

/// In-channel full-text message search.
struct SearchSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    @State private var query = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundColor(Theme.ink3)
                    TextField("Search this \(channel.isDM ? "conversation" : "channel")", text: $query)
                        .foregroundColor(Theme.ink1)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await store.searchMessages(query) } }
                    if !query.isEmpty {
                        Button { query = ""; store.clearSearch() } label: {
                            Image(systemName: "xmark.circle.fill").foregroundColor(Theme.ink3)
                        }
                    }
                }
                .padding(12)
                .background(Theme.bg3)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(16)

                if store.searching {
                    Spacer(); ProgressView().tint(Theme.accent); Spacer()
                } else if store.searchResults.isEmpty {
                    Spacer()
                    Text(query.isEmpty ? "Type to search messages" : "No matches")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink3)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.searchResults) { msg in
                                SearchResultRow(message: msg)
                                Divider().overlay(Theme.line)
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Search")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { store.clearSearch(); dismiss() }
                }
            }
        }
    }
}

private struct SearchResultRow: View {
    let message: Message

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(message.author?.name ?? "Unknown")
                    .font(.zkSans(13, weight: .semibold))
                    .foregroundColor(Theme.ink2)
                Text(shortTime(message.createdAt))
                    .font(.zkSans(11))
                    .foregroundColor(Theme.ink3)
            }
            Text(previewText)
                .font(.zkSans(14))
                .foregroundColor(Theme.ink1)
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
    }

    private var previewText: String {
        if !message.text.isEmpty { return message.text }
        if message.poll != nil { return "📊 Poll" }
        if message.attachments?.isEmpty == false { return "📎 Attachment" }
        return "(no text)"
    }
}

/// Cross-DM search — searches every direct-message conversation at once,
/// mirroring the web "Search all DMs" panel. Reuses the same server full-text
/// search as the per-channel SearchSheet, via /users/@me/dms/search. Styled to
/// match SearchSheet (same field, states, and result rows); the only
/// difference is results span conversations and tapping one opens its DM.
struct DMSearchSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").foregroundColor(Theme.ink3)
                    TextField("Search all DMs", text: $query)
                        .foregroundColor(Theme.ink1)
                        .submitLabel(.search)
                        .autocorrectionDisabled()
                        .onSubmit { Task { await store.searchDMs(query) } }
                    if !query.isEmpty {
                        Button { query = ""; store.clearDMSearch() } label: {
                            Image(systemName: "xmark.circle.fill").foregroundColor(Theme.ink3)
                        }
                    }
                }
                .padding(12)
                .background(Theme.bg3)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(16)

                if store.dmSearching {
                    Spacer(); ProgressView().tint(Theme.accent); Spacer()
                } else if store.dmSearchResults.isEmpty {
                    Spacer()
                    Text(query.isEmpty ? "Search across every direct message" : "No matches")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink3)
                    Spacer()
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.dmSearchResults) { msg in
                                DMSearchResultRow(message: msg) { dismiss() }
                                Divider().overlay(Theme.line)
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Search DMs")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { store.clearDMSearch(); dismiss() }
                }
            }
            .onDisappear { store.clearDMSearch() }
        }
    }
}

/// A cross-DM search result row. Like the per-channel SearchResultRow but
/// tappable: opens the DM the matched message belongs to.
private struct DMSearchResultRow: View {
    let message: Message
    let onOpen: () -> Void
    @EnvironmentObject private var store: AppStore

    var body: some View {
        Button {
            if let dm = store.dms.first(where: { $0.id == message.channelId }) {
                store.selectChannel(dm)
                onOpen()
            }
        } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(message.author?.name ?? "Unknown")
                        .font(.zkSans(13, weight: .semibold))
                        .foregroundColor(Theme.ink2)
                    Text(shortTime(message.createdAt))
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink3)
                }
                Text(previewText)
                    .font(.zkSans(14))
                    .foregroundColor(Theme.ink1)
                    .lineLimit(3)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 10)
        }
        .buttonStyle(.plain)
    }

    private var previewText: String {
        if !message.text.isEmpty { return message.text }
        if message.poll != nil { return "📊 Poll" }
        if message.attachments?.isEmpty == false { return "📎 Attachment" }
        return "(no text)"
    }
}

/// Box so AttributedString (a value type) can live in NSCache, which needs
/// class instances.
private final class AttributedStringBox {
    let value: AttributedString
    init(_ value: AttributedString) { self.value = value }
}

/// Pure-function memo for `markdownAttributed`. The markdown parse below is the
/// single most expensive step in a message row's body, and the row re-evaluates
/// its body on every list republish — including reaction / read-receipt edits
/// that don't touch the text. Because the output depends ONLY on the input
/// string (no store / resolution state), caching by string is a strict
/// memoization: identical input always yields the identical AttributedString,
/// so a re-render that doesn't change the text reuses the parse instead of
/// redoing it. NSCache is thread-safe and self-evicts under memory pressure;
/// the count cap bounds it for the long-lived case.
private let markdownCache: NSCache<NSString, AttributedStringBox> = {
    let cache = NSCache<NSString, AttributedStringBox>()
    cache.countLimit = 2000
    return cache
}()

/// Render a chat message body as inline markdown — bold, italic, `code`,
/// ~~strikethrough~~, and [links](url) — while preserving newlines and runs of
/// whitespace. Falls back to the raw string if it can't be parsed as markdown.
///
/// Result is memoized by the input string (see `markdownCache`): a pure
/// function of `string`, so the cache never changes the rendered output.
func markdownAttributed(_ string: String) -> AttributedString {
    let key = string as NSString
    if let cached = markdownCache.object(forKey: key) {
        return cached.value
    }
    let options = AttributedString.MarkdownParsingOptions(
        allowsExtendedAttributes: true,
        interpretedSyntax: .inlineOnlyPreservingWhitespace,
        failurePolicy: .returnPartiallyParsedIfPossible
    )
    let result: AttributedString
    if let attributed = try? AttributedString(markdown: string, options: options) {
        result = attributed
    } else {
        result = AttributedString(string)
    }
    markdownCache.setObject(AttributedStringBox(result), forKey: key)
    return result
}

// MARK: - Profile card

/// Floating profile shown when tapping a user anywhere (message author,
/// member list, voice tile). Mirrors the web ProfileCard: avatar, name,
/// @username, presence, and relationship-aware actions.
struct ProfileCardView: View {
    let user: PublicUser
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var session: Session

    private var isSelf: Bool { user.id == session.currentUser?.id }
    private var relType: String? { store.relationshipType(with: user.id) }
    private var liveStatus: String { store.status(for: user.id, fallback: user.status) }

    var body: some View {
        VStack(spacing: 0) {
            Group {
                if let bannerURL = assetURL(user.bannerUrl) {
                    AsyncImage(url: bannerURL) { phase in
                        if let img = phase.image {
                            img.resizable().aspectRatio(contentMode: .fill)
                        } else {
                            LinearGradient(
                                colors: [Theme.accent.opacity(0.55), Theme.accent2.opacity(0.45)],
                                startPoint: .leading, endPoint: .trailing
                            )
                        }
                    }
                } else {
                    LinearGradient(
                        colors: [Theme.accent.opacity(0.55), Theme.accent2.opacity(0.45)],
                        startPoint: .leading, endPoint: .trailing
                    )
                }
            }
            .frame(height: 240)
            .frame(maxWidth: .infinity)
            .clipped()

            // Avatar straddles the banner's bottom edge — half over the
            // banner, half below — with name + username to its right.
            // Outside the ScrollView so the overhang isn't clipped.
            HStack(alignment: .top, spacing: 12) {
                Avatar(url: user.avatarUrl, name: user.name, size: 76,
                       status: liveStatus, ringColor: Theme.bg1, decoration: user.avatarDecoration)
                    .padding(.top, -38)

                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 8) {
                        Text(user.displayName ?? user.username ?? "Unknown")
                            .font(.zkSans(21, weight: .bold))
                            .foregroundColor(store.memberColor(user.id) ?? Theme.ink1)
                        if user.isBot == true {
                            Text("BOT")
                                .font(.zkSans(10, weight: .bold))
                                .padding(.horizontal, 5).padding(.vertical, 1)
                                .background(Theme.accent.opacity(0.2))
                                .foregroundColor(Theme.accent)
                                .clipShape(RoundedRectangle(cornerRadius: 4))
                        }
                    }
                    if let uname = user.username {
                        Text("@\(uname)")
                            .font(.zkSans(14))
                            .foregroundColor(Theme.ink3)
                    }
                }
                .padding(.top, 6)

                Spacer(minLength: 0)
            }
            .padding(.horizontal, 18)

            ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                // Online/offline is already shown by the status dot on the
                // avatar above; the separate dot + text row was redundant.
                AchievementsSection(userId: isSelf ? nil : user.id)

                if (user.customStatus?.isEmpty == false) || (user.customStatusEmoji?.isEmpty == false) {
                    HStack(spacing: 6) {
                        if let e = user.customStatusEmoji, !e.isEmpty {
                            Text(e).font(.zkSans(15))
                        }
                        if let cs = user.customStatus, !cs.isEmpty {
                            Text(cs).font(.zkSans(14)).foregroundColor(Theme.ink2)
                        }
                    }
                }

                Rectangle().fill(Theme.line).frame(height: 1)

                if isSelf {
                    Text("This is you.")
                        .font(.zkSans(13))
                        .foregroundColor(Theme.ink3)
                } else {
                    actions
                }

                if store.canManageRoles && !store.roles.isEmpty && store.members[user.id] != nil {
                    rolesSection
                }

                Spacer(minLength: 0)
            }
            .padding(18)
            }
        }
        .background(Theme.bg1)
        .presentationDetents([.medium, .large])
    }

    @ViewBuilder
    private var actions: some View {
        VStack(spacing: 10) {
            HStack(spacing: 10) {
                Button { message() } label: {
                    Label("Message", systemImage: "bubble.left.fill")
                        .font(.zkSans(15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Theme.accent)
                        .foregroundColor(.white)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }

                Button { call() } label: {
                    Label("Call", systemImage: "phone.fill")
                        .font(.zkSans(15, weight: .semibold))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 11)
                        .background(Theme.bg3)
                        .foregroundColor(Theme.ink1)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
            }

            friendButton

            Button { toggleBlock() } label: {
                Label(relType == "blocked" ? "Unblock" : "Block",
                      systemImage: relType == "blocked" ? "hand.raised.slash" : "nosign")
                    .font(.zkSans(15, weight: .medium))
                    .frame(maxWidth: .infinity)
                    .padding(.vertical, 11)
                    .background(Theme.bg3)
                    .foregroundColor(Theme.danger)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
            }
        }
    }

    @ViewBuilder
    private var friendButton: some View {
        switch relType {
        case .some("outgoing_request"):
            secondaryButton("Friend Request Sent", icon: "clock", disabled: true) {}
        case .some("incoming_request"):
            secondaryButton("Accept Friend Request", icon: "person.badge.plus") {
                Task { await store.acceptFriend(user) }
            }
        case .some("friend"):
            secondaryButton("Remove Friend", icon: "person.badge.minus") {
                Task { await store.removeFriend(user) }
            }
        case .some("blocked"):
            EmptyView()
        default:
            secondaryButton("Add Friend", icon: "person.badge.plus") {
                Task { _ = await store.addFriend(username: user.username ?? user.name) }
            }
        }
    }

    private func secondaryButton(_ title: String, icon: String,
                                 disabled: Bool = false,
                                 _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Label(title, systemImage: icon)
                .font(.zkSans(15, weight: .medium))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 11)
                .background(Theme.bg3)
                .foregroundColor(disabled ? Theme.ink3 : Theme.ink1)
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .disabled(disabled)
    }

    private func message() {
        Task {
            guard let ch = await store.startDM(with: user) else { return }
            store.profileUser = nil
            store.showMembers = false
            store.push(.messages(ch))
        }
    }

    private func call() {
        Task {
            guard let ch = await store.startDM(with: user) else { return }
            store.profileUser = nil
            store.showMembers = false
            store.openVoice(ch)
        }
    }

    private var assignableRoles: [Role] {
        store.roles
            .filter { $0.id != store.selectedGuild?.id }
            .sorted { $0.position > $1.position }
    }

    @ViewBuilder
    private var rolesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ROLES").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            ForEach(assignableRoles) { role in
                Button {
                    Task { await store.toggleMemberRole(user.id, role: role) }
                } label: {
                    HStack(spacing: 8) {
                        Circle().fill(store.roleColor(role) ?? Theme.ink4).frame(width: 12, height: 12)
                        Text(role.name).font(.zkSans(14)).foregroundColor(Theme.ink1)
                        Spacer()
                        Image(systemName: store.memberHasRole(user.id, role.id) ? "checkmark.circle.fill" : "circle")
                            .foregroundColor(store.memberHasRole(user.id, role.id) ? Theme.accent : Theme.ink4)
                    }
                    .padding(.vertical, 6)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func toggleBlock() {
        Task {
            if relType == "blocked" { await store.unblockUser(user) }
            else { await store.blockUser(user) }
        }
    }
}

// MARK: - Member list

/// Guild member roster (flat, sorted by display name). Tapping a member
/// opens their ProfileCard. Role-hoisted sections are deferred until
/// roles are modeled.
struct MemberListView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var selectedProfile: PublicUser?

    private struct MemberSection: Identifiable {
        let id: String
        let label: String
        let color: Color?
        var members: [GuildMember]
    }

    /// Discord-style hoisted sections (matches the web MemberList): one
    /// section per hoisted role, members under their highest hoisted role,
    /// an "Online" bucket for the rest, and a separate "Offline" bucket.
    private var sections: [MemberSection] {
        let allMembers = Array(store.members.values)
        let hoisted = store.roles.filter { $0.hoist }.sorted { $0.position < $1.position }
        var roleIdx: [String: Int] = [:]
        for (i, r) in hoisted.enumerated() { roleIdx[r.id] = i }

        var buckets: [MemberSection] = hoisted.map {
            MemberSection(id: "role:\($0.id)", label: $0.name, color: store.roleColor($0), members: [])
        }
        var online = MemberSection(id: "online", label: "Online", color: nil, members: [])
        var offline = MemberSection(id: "offline", label: "Offline", color: nil, members: [])

        for m in allMembers {
            let st = store.status(for: m.userId, fallback: m.user.status)
            if st == "offline" || st == "invisible" { offline.members.append(m); continue }
            var bestIdx = -1
            for rid in (m.roleIds ?? []) {
                if let idx = roleIdx[rid], bestIdx == -1 || idx < bestIdx { bestIdx = idx }
            }
            if bestIdx == -1 { online.members.append(m) } else { buckets[bestIdx].members.append(m) }
        }

        func byName(_ a: GuildMember, _ b: GuildMember) -> Bool {
            (a.nickname ?? a.user.name).localizedCaseInsensitiveCompare(b.nickname ?? b.user.name) == .orderedAscending
        }
        for i in buckets.indices { buckets[i].members.sort(by: byName) }
        online.members.sort(by: byName)
        offline.members.sort(by: byName)

        var out = buckets.filter { !$0.members.isEmpty }
        if !online.members.isEmpty { out.append(online) }
        if !offline.members.isEmpty { out.append(offline) }
        return out
    }

    var body: some View {
        NavigationStack {
            Group {
                if store.members.isEmpty {
                    VStack(spacing: 10) {
                        ProgressView().tint(Theme.accent)
                        Text("Loading members…")
                            .font(.zkSans(13))
                            .foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(sections) { section in
                                sectionHeader(section)
                                ForEach(section.members) { m in
                                    Button { selectedProfile = m.user } label: {
                                        memberRow(m)
                                    }
                                    .buttonStyle(.plain)
                                }
                            }
                        }
                        .padding(.vertical, 6)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1)
            .navigationTitle("Members — \(store.members.count)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .sheet(item: $selectedProfile) { ProfileCardView(user: $0) }
    }

    private func sectionHeader(_ s: MemberSection) -> some View {
        Text("\(s.label.uppercased()) — \(s.members.count)")
            .font(.zkSans(11, weight: .semibold))
            .foregroundColor(s.color ?? Theme.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16)
            .padding(.top, 14)
            .padding(.bottom, 4)
    }

    private func memberRow(_ m: GuildMember) -> some View {
        HStack(spacing: 10) {
            Avatar(url: m.user.avatarUrl, name: m.nickname ?? m.user.name, size: 32,
                   status: store.status(for: m.userId, fallback: m.user.status),
                   ringColor: Theme.bg1, decoration: m.user.avatarDecoration)
            VStack(alignment: .leading, spacing: 1) {
                Text(m.nickname ?? m.user.name)
                    .font(.zkSans(15, weight: .medium))
                    .foregroundColor(store.memberColor(m.userId) ?? Theme.ink1)
                    .lineLimit(1)
                if m.nickname != nil {
                    Text(m.user.name)
                        .font(.zkSans(12))
                        .foregroundColor(Theme.ink3)
                        .lineLimit(1)
                }
            }
            Spacer()
            if m.user.isBot == true {
                Text("BOT")
                    .font(.zkSans(9, weight: .bold))
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Theme.accent.opacity(0.2))
                    .foregroundColor(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 3))
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .contextMenu {
            Button { store.openProfile(m.user) } label: {
                Label("View Profile", systemImage: "person.crop.circle")
            }
            if m.userId != store.currentUserId {
                if store.canModerateMembers {
                    Menu {
                        Button { Task { await store.timeoutMember(m.userId, minutes: 5) } } label: { Text("5 minutes") }
                        Button { Task { await store.timeoutMember(m.userId, minutes: 60) } } label: { Text("1 hour") }
                        Button { Task { await store.timeoutMember(m.userId, minutes: 1440) } } label: { Text("1 day") }
                        Button { Task { await store.timeoutMember(m.userId, minutes: 10080) } } label: { Text("1 week") }
                        Divider()
                        Button { Task { await store.timeoutMember(m.userId, minutes: 0) } } label: { Text("Remove timeout") }
                    } label: { Label("Timeout", systemImage: "clock") }
                }
                if store.canKickMembers {
                    Button(role: .destructive) { Task { await store.kickMember(m.userId) } } label: {
                        Label("Kick", systemImage: "person.fill.xmark")
                    }
                }
                if store.canBanMembers {
                    Button(role: .destructive) { Task { await store.banMember(m.userId) } } label: {
                        Label("Ban", systemImage: "hammer.fill")
                    }
                }
            }
        }
    }
}

// MARK: - Pin panel

/// Lists a channel's pinned messages (newest first). Each row can be
/// unpinned in place. Mirrors the web PinPanel.
struct PinPanelView: View {
    let channel: Channel
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.loadingPins && store.pins.isEmpty {
                    VStack(spacing: 10) {
                        ProgressView().tint(Theme.accent)
                        Text("Loading pins…")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if store.pins.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "pin")
                            .font(.system(size: 30, weight: .light))
                            .foregroundColor(Theme.ink3)
                        Text("No pinned messages yet")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.pins) { m in
                                pinRow(m)
                                Rectangle().fill(Theme.line).frame(height: 1)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1)
            .navigationTitle("Pinned Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }

    private func pinRow(_ m: Message) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(url: m.author?.avatarUrl, name: m.author?.name ?? "?",
                   size: 32, ringColor: Theme.bg1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(m.author?.name ?? "Unknown")
                        .font(.zkSans(14, weight: .semibold))
                        .foregroundColor(Theme.ink1)
                    Text(shortTime(m.createdAt))
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink3)
                }
                Text(pinText(m))
                    .font(.zkSans(14))
                    .foregroundColor(Theme.ink2)
                    .lineLimit(4)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Button { Task { await store.togglePin(m) } } label: {
                Image(systemName: "pin.slash")
                    .font(.system(size: 14))
                    .foregroundColor(Theme.ink3)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
    }

    private func pinText(_ m: Message) -> String {
        switch store.display(for: m, in: channel) {
        case .text(let t):
            if !t.isEmpty { return t }
            if m.sticker != nil { return "🏷️ Sticker" }
            if m.attachments?.contains(where: { $0.isVoiceMessage == true }) == true { return "🎤 Voice message" }
            if m.attachments?.isEmpty == false { return "📎 Attachment" }
            if m.poll != nil { return "📊 Poll" }
            return "Message"
        case .locked, .undecryptable:
            return "🔒 Encrypted message"
        }
    }
}

// MARK: - Image lightbox

/// Full-screen image viewer: pinch to zoom, drag to pan when zoomed,
/// double-tap to toggle zoom, tap ✕ to close. Mirrors the web ImageLightbox.
struct ImageLightboxView: View {
    let item: LightboxImage
    @Environment(\.dismiss) private var dismiss
    @State private var scale: CGFloat = 1
    @State private var lastScale: CGFloat = 1
    @State private var offset: CGSize = .zero
    @State private var lastOffset: CGSize = .zero

    var body: some View {
        ZStack {
            Color.black.ignoresSafeArea()

            // E2EE images arrive as an in-memory UIImage (no plaintext URL);
            // plain attachments load by URL. Both get the same zoom/pan.
            if let image = item.image {
                zoomable(Image(uiImage: image).resizable().scaledToFit())
            } else if let url = item.url {
                AsyncImage(url: url) { phase in
                    switch phase {
                    case .success(let image):
                        zoomable(image.resizable().scaledToFit())
                    case .empty:
                        ProgressView().tint(.white)
                    default:
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 28))
                            .foregroundColor(.white)
                    }
                }
            }

            VStack {
                HStack {
                    Spacer()
                    Button { dismiss() } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 17, weight: .semibold))
                            .foregroundColor(.white)
                            .padding(10)
                            .background(Color.white.opacity(0.18))
                            .clipShape(Circle())
                    }
                }
                Spacer()
            }
            .padding(16)
        }
    }

    /// Apply pinch-zoom, drag-pan (when zoomed), and double-tap-to-toggle to
    /// the supplied image view. Shared by the URL and in-memory paths.
    @ViewBuilder
    private func zoomable<V: View>(_ content: V) -> some View {
        content
            .scaleEffect(scale)
            .offset(offset)
            .gesture(
                MagnificationGesture()
                    .onChanged { value in scale = max(1, lastScale * value) }
                    .onEnded { _ in
                        lastScale = scale
                        if scale <= 1 {
                            withAnimation { offset = .zero; lastOffset = .zero }
                        }
                    }
            )
            .simultaneousGesture(
                DragGesture()
                    .onChanged { value in
                        guard scale > 1 else { return }
                        offset = CGSize(
                            width: lastOffset.width + value.translation.width,
                            height: lastOffset.height + value.translation.height
                        )
                    }
                    .onEnded { _ in lastOffset = offset }
            )
            .onTapGesture(count: 2) {
                withAnimation {
                    if scale > 1 {
                        scale = 1; lastScale = 1; offset = .zero; lastOffset = .zero
                    } else {
                        scale = 2.5; lastScale = 2.5
                    }
                }
            }
    }
}

// MARK: - Forward sheet

/// Pick a destination to forward a message to (current server's text
/// channels + your DMs). Mirrors the web ForwardModal.
struct ForwardSheet: View {
    let message: Message
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    private var textChannels: [Channel] {
        store.channels.filter { $0.isText }.sorted { ($0.position ?? 0) < ($1.position ?? 0) }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if !textChannels.isEmpty {
                        sectionLabel(store.selectedGuild?.name ?? "Server")
                        ForEach(textChannels) { ch in
                            targetRow(symbol: "number", name: ch.name ?? "channel") {
                                Task { await store.forwardMessage(message, to: ch); dismiss() }
                            }
                        }
                    }
                    if !store.dms.isEmpty {
                        sectionLabel("Direct Messages")
                        ForEach(store.dms) { dm in
                            targetRow(symbol: "at", name: dm.dmTitle) {
                                Task { await store.forwardMessage(message, to: dm); dismiss() }
                            }
                        }
                    }
                    if textChannels.isEmpty && store.dms.isEmpty {
                        Text("No channels to forward to.")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                }
                .padding(.vertical, 6)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Forward to…")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    private func sectionLabel(_ t: String) -> some View {
        Text(t.uppercased())
            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 16).padding(.top, 12).padding(.bottom, 4)
    }
    private func targetRow(symbol: String, name: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol).font(.system(size: 14)).foregroundColor(Theme.ink3).frame(width: 18)
                Text(name).font(.system(size: 15)).foregroundColor(Theme.ink1).lineLimit(1)
                Spacer()
                Image(systemName: "arrowshape.turn.up.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
            }
            .padding(.horizontal, 16).padding(.vertical, 10).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Saved messages

/// Your bookmarked messages, newest first. Mirrors the web SavedView.
struct SavedView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.loadingSaved && store.saved.isEmpty {
                    VStack(spacing: 10) {
                        ProgressView().tint(Theme.accent)
                        Text("Loading…").font(.zkSans(13)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if store.saved.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "bookmark")
                            .font(.system(size: 30, weight: .light)).foregroundColor(Theme.ink3)
                        Text("No saved messages").font(.zkSans(14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.saved) { item in
                                savedRow(item)
                                Rectangle().fill(Theme.line).frame(height: 1)
                            }
                        }
                        .padding(.vertical, 4)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                // Opaque base -> abyss nebula -> 90% column wash (web bg-1/90).
                ZStack { Theme.bg1; AbyssBackground(); Theme.bg1.opacity(0.9) }.ignoresSafeArea()
            }
            .navigationTitle("Saved Messages")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { PageBackButton() }
            }
        }
        .task { await store.loadSaved() }
    }

    private func savedRow(_ item: SavedMessageItem) -> some View {
        let m = item.message
        return HStack(alignment: .top, spacing: 10) {
            Avatar(url: m.author?.avatarUrl, name: m.author?.name ?? "?", size: 32, ringColor: Theme.bg1)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(m.author?.name ?? "Unknown")
                        .font(.zkSans(14, weight: .semibold)).foregroundColor(Theme.ink1)
                    if let cn = item.channel?.name {
                        Text("#\(cn)").font(.zkSans(11)).foregroundColor(Theme.ink3).lineLimit(1)
                    }
                    Text(shortTime(m.createdAt)).font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
                Text(savedText(m))
                    .font(.zkSans(14)).foregroundColor(Theme.ink2)
                    .lineLimit(5).fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 6)
            Button { Task { await store.toggleSave(m) } } label: {
                Image(systemName: "bookmark.slash").font(.system(size: 14)).foregroundColor(Theme.ink3)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 10)
    }

    private func savedText(_ m: Message) -> String {
        if E2EE.isEncrypted(m.text) { return "🔒 Encrypted message" }
        if m.text.isEmpty {
            if m.sticker != nil { return "🏷️ Sticker" }
            if m.attachments?.contains(where: { $0.isVoiceMessage == true }) == true { return "🎤 Voice message" }
            if m.attachments?.isEmpty == false { return "📎 Attachment" }
            if m.poll != nil { return "📊 Poll" }
            if let fwd = m.forwardedFrom { return "↪︎ \(fwd.content)" }
            return "Message"
        }
        return m.text
    }
}

// MARK: - Emoji + sticker picker

/// A two-tab picker: custom emoji (inserts `:name:` into the draft) and
/// stickers (sends immediately). Mirrors the web emoji/sticker picker.
struct EmojiStickerPicker: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Binding var draft: String
    @State private var tab = 0
    private let cols = [GridItem(.adaptive(minimum: 64), spacing: 10)]
    private let stickerCols = [GridItem(.adaptive(minimum: 84), spacing: 10)]

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $tab) {
                    Text("Emoji").tag(0)
                    Text("Stickers").tag(1)
                }
                .pickerStyle(.segmented)
                .padding(12)

                if tab == 0 { emojiGrid } else { stickerGrid }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(tab == 0 ? "Emoji" : "Stickers").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadEmojis(); await store.loadStickers() }
        }
    }

    private var emojiGrid: some View {
        ScrollView {
            if store.guildEmojis.isEmpty {
                emptyState("face.dashed", "No custom emoji in this server.")
            } else {
                LazyVGrid(columns: cols, spacing: 10) {
                    ForEach(store.guildEmojis) { e in
                        Button {
                            draft += draft.isEmpty || draft.hasSuffix(" ") ? ":\(e.name):" : " :\(e.name):"
                        } label: {
                            AsyncImage(url: assetURL(e.url)) { phase in
                                switch phase {
                                case .success(let image): image.resizable().scaledToFit()
                                case .empty: ProgressView()
                                default: Image(systemName: "photo").foregroundColor(Theme.ink3)
                                }
                            }
                            .frame(width: 40, height: 40)
                            .frame(width: 56, height: 56)
                            .background(Theme.bg2)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
        }
    }

    private var stickerGrid: some View {
        ScrollView {
            if store.guildStickers.isEmpty {
                emptyState("face.dashed", "No stickers in this server.")
            } else {
                LazyVGrid(columns: stickerCols, spacing: 10) {
                    ForEach(store.guildStickers) { s in
                        Button {
                            Task { await store.sendSticker(s) }
                            dismiss()
                        } label: {
                            VStack(spacing: 4) {
                                AsyncImage(url: assetURL(s.url)) { phase in
                                    switch phase {
                                    case .success(let image): image.resizable().scaledToFit()
                                    case .empty: ProgressView()
                                    default: Image(systemName: "photo").foregroundColor(Theme.ink3)
                                    }
                                }
                                .frame(width: 72, height: 72)
                                Text(s.name).font(.zkSans(10)).foregroundColor(Theme.ink3).lineLimit(1)
                            }
                            .frame(width: 84, height: 96)
                            .background(Theme.bg2)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(16)
            }
        }
    }

    private func emptyState(_ icon: String, _ text: String) -> some View {
        VStack(spacing: 8) {
            Image(systemName: icon).font(.system(size: 30)).foregroundColor(Theme.ink3)
            Text(text).font(.system(size: 14)).foregroundColor(Theme.ink3)
        }
        .frame(maxWidth: .infinity).padding(.top, 50)
    }
}

// MARK: - Schedule message

/// Schedule the current draft for future delivery, and manage the pending
/// queue. Mirrors the web SchedulePickerModal + ScheduledMessagesView.
struct ScheduleSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @Binding var draft: String

    @State private var date = Date().addingTimeInterval(3600)
    @State private var busy = false
    @State private var error: String?

    private var trimmedDraft: String { draft.trimmingCharacters(in: .whitespacesAndNewlines) }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if trimmedDraft.isEmpty {
                        Text("Type a message in the composer first, then schedule it for later.")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    } else {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("SCHEDULE MESSAGE").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            Text(draft)
                                .font(.zkSans(14)).foregroundColor(Theme.ink1)
                                .frame(maxWidth: .infinity, alignment: .leading)
                                .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                            DatePicker("Send at", selection: $date, in: Date()..., displayedComponents: [.date, .hourAndMinute])
                                .foregroundColor(Theme.ink1).tint(Theme.accent)
                            Button { schedule() } label: {
                                Text(busy ? "Scheduling…" : "Schedule")
                                    .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                                    .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .disabled(busy)
                            if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
                        }
                    }

                    Divider().overlay(Theme.line)

                    Text("PENDING").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if store.loadingScheduled && store.scheduledMessages.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 8)
                    } else if store.scheduledMessages.isEmpty {
                        Text("No scheduled messages.").font(.zkSans(13)).foregroundColor(Theme.ink4)
                    } else {
                        ForEach(store.scheduledMessages) { sm in scheduledRow(sm) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Scheduled").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadScheduled() }
        }
    }

    private func scheduledRow(_ sm: ScheduledMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            VStack(alignment: .leading, spacing: 3) {
                Text(sm.content ?? "").font(.zkSans(14)).foregroundColor(Theme.ink1).lineLimit(3)
                Text(Self.whenText(sm.scheduledFor)).font(.zkSans(11)).foregroundColor(Theme.accent)
                if let err = sm.lastError, !err.isEmpty {
                    Text("Failed: \(err)").font(.zkSans(11)).foregroundColor(Theme.danger).lineLimit(1)
                }
            }
            Spacer()
            Button(role: .destructive) { Task { await store.cancelScheduled(sm) } } label: {
                Image(systemName: "trash").font(.system(size: 13)).foregroundColor(Theme.danger)
            }
            .buttonStyle(.plain)
        }
        .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func schedule() {
        busy = true; error = nil
        let content = trimmedDraft
        Task {
            let err = await store.scheduleMessage(content: content, at: date)
            busy = false
            if let err { error = err } else { draft = "" }
        }
    }

    private static let parseFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let parsePlain = ISO8601DateFormatter()
    private static let display: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; return f
    }()

    static func whenText(_ iso: String) -> String {
        let date = parseFractional.date(from: iso) ?? parsePlain.date(from: iso)
        guard let date else { return iso }
        return display.string(from: date)
    }
}

// MARK: - DM settings

/// Per-DM auto-delete TTL + close. Mirrors the web DmSettingsPanel. The
/// TTL is a property of the conversation (affects both recipients) and
/// counts from when the OTHER person reads the message.
struct DmSettingsSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel
    @State private var showEnableE2EE = false
    @State private var confirmDisableE2EE = false
    // E2EE key backup / restore (cross-client with web).
    @State private var shareFile: ShareFile?
    @State private var showRestore = false
    @State private var confirmRestore = false
    @State private var keyNote: String?

    private let options: [(String, Int?)] = [
        ("Off", nil), ("30 seconds", 30), ("1 minute", 60), ("2 minutes", 120)
    ]

    /// Live channel state (E2EE flips arrive via CHANNEL_UPDATE).
    private var liveChannel: Channel {
        store.dms.first(where: { $0.id == channel.id }) ?? channel
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("END-TO-END ENCRYPTION")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if liveChannel.isE2EE {
                        HStack(spacing: 8) {
                            Image(systemName: "lock.fill")
                                .font(.system(size: 13))
                                .foregroundColor(Theme.accent)
                            Text("Enabled")
                                .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                            Spacer()
                            Button("Turn Off…", role: .destructive) { confirmDisableE2EE = true }
                                .font(.zkSans(13, weight: .semibold))
                                .foregroundColor(Theme.dangerSoft)
                        }
                        .padding(12)
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                        Text("Messages are encrypted with your shared password. Turning this off permanently deletes the encrypted history for both of you.")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)

                        keyBackupSection
                    } else {
                        Button { showEnableE2EE = true } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "lock.open")
                                    .font(.system(size: 13))
                                    .foregroundColor(Theme.accent)
                                Text("Turn On End-to-End Encryption")
                                    .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .semibold)).foregroundColor(Theme.ink3)
                            }
                            .padding(12)
                            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        Text("Encrypts this conversation with a password you both share. Only devices that know it can read messages.")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    }

                    Divider().overlay(Theme.line)

                    Text("AUTO-DELETE MESSAGES")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if store.loadingDmSettings {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 12)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(options.indices, id: \.self) { i in
                                ttlRow(options[i])
                                if i < options.count - 1 { Divider().overlay(Theme.line) }
                            }
                        }
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    Text("When on, each message disappears this long after the other person reads it. This applies to both of you.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)

                    Divider().overlay(Theme.line)

                    Button(role: .destructive) {
                        Task { await store.closeDM(channel); dismiss() }
                    } label: {
                        Label("Close DM", systemImage: "xmark.circle")
                            .font(.zkSans(15)).foregroundColor(Theme.danger)
                    }
                    Text("Removes this conversation from your list. The other person keeps their copy.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(channel.dmTitle).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadDmSettings(channel.id) }
            .sheet(isPresented: $showEnableE2EE) {
                EnableE2EESheet(channel: liveChannel)
            }
            .confirmationDialog(
                "Turn off encryption?",
                isPresented: $confirmDisableE2EE,
                titleVisibility: .visible
            ) {
                Button("Turn Off & Delete History", role: .destructive) {
                    Task { await store.disableE2EE(liveChannel) }
                }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("All encrypted messages in this conversation are permanently deleted for both of you.")
            }
            .sheet(item: $shareFile) { ActivityView(url: $0.url) }
            .fileImporter(
                isPresented: $showRestore,
                allowedContentTypes: [.json],
                allowsMultipleSelection: false
            ) { result in onRestore(result) }
            .confirmationDialog(
                "Restore keys from a backup?",
                isPresented: $confirmRestore,
                titleVisibility: .visible
            ) {
                Button("Choose File…") { showRestore = true }
                Button("Cancel", role: .cancel) {}
            } message: {
                Text("Importing keys will replace any matching keys on this device.")
            }
        }
    }

    // Key backup/restore — mirrors web's DmSettingsPanel "Download keys" /
    // "Import from backup" affordances. The backup bundles ALL of this
    // device's DM keys into one cross-client file (see E2EE.encodeKeyBackup).
    @ViewBuilder
    private var keyBackupSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Your keys are stored only on this device. Back them up so you can keep reading messages on another device.")
                .font(.zkSans(12)).foregroundColor(Theme.ink3)
            HStack(spacing: 10) {
                Button { backupKeys() } label: {
                    Label("Back up keys", systemImage: "square.and.arrow.up")
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                Button { confirmRestore = true } label: {
                    Label("Restore keys", systemImage: "square.and.arrow.down")
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.ink1)
                        .padding(.horizontal, 12).padding(.vertical, 9)
                        .background(Theme.bg2)
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
            }
            Text("Anyone with this file can read your encrypted messages.")
                .font(.zkSans(11)).italic().foregroundColor(Theme.ink4)
            if let keyNote {
                Text(keyNote).font(.zkSans(12)).foregroundColor(Theme.ink3)
            }
        }
    }

    private func backupKeys() {
        keyNote = nil
        guard let data = store.exportE2EEKeysJSON() else {
            keyNote = "No encryption keys on this device yet."; return
        }
        let stamp = ISO8601DateFormatter().string(from: Date()).prefix(10)
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("zekktris-e2ee-keys-\(stamp).json")
        do {
            try data.write(to: url, options: .atomic)
            shareFile = ShareFile(url: url)
        } catch {
            keyNote = "Couldn't prepare the backup file."
        }
    }

    private func onRestore(_ result: Result<[URL], Error>) {
        keyNote = nil
        guard case .success(let urls) = result, let url = urls.first else {
            if case .failure(let e) = result { keyNote = e.localizedDescription }
            return
        }
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }
        guard let data = try? Data(contentsOf: url) else {
            keyNote = "Couldn't read that file."; return
        }
        guard let restored = store.importE2EEKeysJSON(data) else {
            keyNote = "That file isn't a valid Zekktris keys backup."; return
        }
        keyNote = "Restored \(restored.count) key\(restored.count == 1 ? "" : "s")."
    }

    private func ttlRow(_ opt: (String, Int?)) -> some View {
        Button { Task { await store.setDmTtl(channel.id, opt.1) } } label: {
            HStack {
                Text(opt.0).font(.zkSans(15)).foregroundColor(Theme.ink1)
                Spacer()
                if store.dmTtl == opt.1 {
                    Image(systemName: "checkmark").font(.system(size: 14, weight: .semibold)).foregroundColor(Theme.accent)
                }
            }
            .contentShape(Rectangle())
            .padding(.horizontal, 12).padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}

/// Identifiable wrapper so a temp file URL can drive `.sheet(item:)`.
private struct ShareFile: Identifiable {
    let id = UUID()
    let url: URL
}

/// Thin bridge to the iOS share sheet (UIActivityViewController) for exporting
/// a file — used by the E2EE key backup. No new file needed; UIKit is already
/// imported here.
private struct ActivityView: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: [url], applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

// MARK: - Image long-press actions (save / copy / share)

/// Share-sheet host for an arbitrary set of activity items (e.g. a UIImage).
private struct ActivityItemsView: UIViewControllerRepresentable {
    let items: [Any]
    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

/// Identifiable wrapper so a UIImage can drive `.sheet(item:)`.
private struct ImageShareItem: Identifiable {
    let id = UUID()
    let image: UIImage
}

/// Long-press context menu (Save to Photos / Copy / Share) for an image. The
/// `provider` yields the UIImage on demand — for plain attachments it loads
/// from the URL; for E2EE images it returns the already-decrypted UIImage, so
/// the saved/shared/copied bytes are the DECRYPTED image and E2EE is never
/// bypassed (no plaintext URL is exposed). Save-to-Photos uses
/// UIImageWriteToSavedPhotosAlbum (NSPhotoLibraryAddUsageDescription is set).
private struct ImageActionsModifier: ViewModifier {
    let provider: () async -> UIImage?
    @State private var shareItem: ImageShareItem?

    func body(content: Content) -> some View {
        content
            .contextMenu {
                Button {
                    withImage { UIImageWriteToSavedPhotosAlbum($0, nil, nil, nil) }
                } label: { Label("Save to Photos", systemImage: "square.and.arrow.down") }
                Button {
                    withImage { UIPasteboard.general.image = $0 }
                } label: { Label("Copy Image", systemImage: "doc.on.doc") }
                Button {
                    withImage { shareItem = ImageShareItem(image: $0) }
                } label: { Label("Share…", systemImage: "square.and.arrow.up") }
            }
            .sheet(item: $shareItem) { ActivityItemsView(items: [$0.image]) }
    }

    /// Resolve the image (async) then run `action` on the main actor.
    private func withImage(_ action: @escaping (UIImage) -> Void) {
        Task {
            if let img = await provider() {
                await MainActor.run { action(img) }
            }
        }
    }
}

extension View {
    /// Attach the image long-press actions menu. `provider` supplies the
    /// UIImage to act on (decrypted, for E2EE).
    func imageActions(_ provider: @escaping () async -> UIImage?) -> some View {
        modifier(ImageActionsModifier(provider: provider))
    }
}

/// Downloads an encrypted (.zke) attachment, decrypts it with the DM's
/// channel key, and renders the result — images inline (tap to zoom via a
/// temporary file is skipped; encrypted images stay in-memory), anything
/// else as a sealed-file chip. Shows a lock placeholder until the key is
/// unlocked on this device.
struct EncryptedAttachmentView: View {
    let attachment: Attachment
    let channel: Channel
    @EnvironmentObject private var store: AppStore
    @State private var image: UIImage?
    @State private var failed = false
    @State private var loading = true

    /// Original name without the .zke wire suffix.
    private var displayName: String {
        let n = attachment.filename ?? "file"
        return n.hasSuffix(".zke") ? String(n.dropLast(4)) : n
    }

    var body: some View {
        Group {
            if let image {
                Image(uiImage: image)
                    .resizable().scaledToFit()
                    .frame(maxWidth: 240, maxHeight: 240, alignment: .leading)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    // Tap → full-screen preview of the DECRYPTED image (no
                    // plaintext URL). Long-press → Save/Copy/Share the decrypted
                    // bytes — E2EE is preserved end to end.
                    .onTapGesture { store.openLightbox(image: image) }
                    .imageActions { image }
                    // Per-image E2EE lock badge removed — the lock by the DM
                    // header already signals the whole conversation is encrypted.
            } else {
                HStack(spacing: 8) {
                    Image(systemName: failed ? "lock.slash" : "lock.doc")
                        .foregroundColor(failed ? Theme.dangerSoft : Theme.accent)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(displayName)
                            .font(.zkSans(13, weight: .medium))
                            .foregroundColor(Theme.ink1)
                            .lineLimit(1)
                        Text(failed
                             ? "Couldn't decrypt"
                             : (loading ? "Decrypting…" : "Encrypted file"))
                            .font(.zkSans(11))
                            .foregroundColor(failed ? Theme.dangerSoft : Theme.ink3)
                    }
                    if loading && !failed { ProgressView().scaleEffect(0.7) }
                }
                .padding(8)
                .background(Theme.bg3)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
        .task(id: store.e2eeUnlockVersion) {
            loading = true
            failed = false
            guard let data = await store.decryptedAttachmentData(attachment, in: channel) else {
                loading = false
                failed = true
                return
            }
            image = UIImage(data: data)
            loading = false
            failed = (image == nil && !data.isEmpty) ? false : failed
        }
    }
}
