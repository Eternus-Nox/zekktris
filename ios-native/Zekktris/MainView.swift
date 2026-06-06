import SwiftUI
import UIKit
import PhotosUI
import CoreImage

/// The signed-in shell. Mirrors the web mobile layout: a persistent 72pt
/// server rail on the left, and a content column that shows the channel list
/// or drills into a channel's messages.
struct MainView: View {
    @EnvironmentObject private var store: AppStore

    var body: some View {
        HStack(spacing: 0) {
            // Web parity: rail = bg-0/85 over the abyss, with a border-line
            // divider on its trailing edge.
            ServerRailView()
                .frame(width: 72)
                .background(Theme.bg0.opacity(0.85))

            Rectangle()
                .fill(Theme.line)
                .frame(width: 1)

            VStack(spacing: 0) {
                if store.activeVoiceOrStageId != nil && !store.isViewingActiveCall
                    && store.outgoingCall == nil && store.incomingCall == nil {
                    MinimizedCallBar()
                }
                ZStack {
                    content
                        .id(routeKey)
                        .transition(.opacity)
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .animation(.easeInOut(duration: 0.2), value: routeKey)
            }
        }
        // The abyss nebula canvas sits behind every column (web mounts
        // `.abyss` once at the Shell root); columns above use translucent
        // fills so the auroras glow through.
        .background {
            ZStack {
                Theme.bg1
                AbyssBackground()
            }
            .ignoresSafeArea()
        }
        .overlay {
            if let call = store.incomingCall {
                IncomingCallView(call: call)
                    .transition(.opacity)
            } else if let out = store.outgoingCall {
                OutgoingCallView(channel: out.channel, callee: out.callee)
                    .transition(.opacity)
            }
        }
        .overlay {
            if store.amPendingOnboarding, let g = store.selectedGuild {
                OnboardingView(guild: g)
                    .transition(.opacity)
            }
        }
        .overlay(alignment: .top) {
            if let err = store.errorText {
                ErrorToast(message: err) { store.errorText = nil }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .animation(.easeInOut(duration: 0.2), value: store.errorText)
    }

    /// The view for the top of the navigation stack, or the root list.
    @ViewBuilder
    private var content: some View {
        if let route = store.stack.last {
            switch route {
            case .messages(let channel):
                MessageListView(channel: channel)
            case .threadList(let parent):
                ThreadListView(parent: parent)
            case .voice(let channel):
                if channel.isStage { StageChannelView(channel: channel) }
                else { VoiceChannelView(channel: channel) }
            }
        } else {
            switch store.railContent {
            case .mentions:
                MentionsView()
            case .saved:
                SavedView()
            case .normal:
                if store.inDMs {
                    DMListView()
                } else {
                    ChannelListView()
                }
            }
        }
    }

    /// Identity key so each pushed route renders a fresh view (firing onAppear,
    /// even when two consecutive routes are both message views).
    private var routeKey: String {
        if let route = store.stack.last {
            switch route {
            case .messages(let c): return "m-\(c.id)-\(store.stack.count)"
            case .threadList(let c): return "t-\(c.id)-\(store.stack.count)"
            case .voice(let c): return "v-\(c.id)-\(store.stack.count)"
            }
        }
        return {
            switch store.railContent {
            case .mentions: return "root-mentions"
            case .saved: return "root-saved"
            case .normal: return store.inDMs ? "root-dms" : "root-guild-\(store.selectedGuild?.id ?? "none")"
            }
        }()
    }
}

private enum RailSheet: Identifiable {
    case settings, discover, createServer, joinInvite, admin, family, quickSwitch, reorderServers
    var id: Int { hashValue }
}

/// Vertical rail of guild icons with a user menu at the bottom.
struct ServerRailView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var session: Session
    @State private var confirmLogout = false
    @State private var railSheet: RailSheet?
    @State private var renamingFolder: GuildFolder?
    @State private var renameText = ""

    var body: some View {
        VStack(spacing: 0) {
            ScrollView(showsIndicators: false) {
                VStack(spacing: 10) {
                    Button {
                        store.showDMs()
                    } label: {
                        RailTile(active: store.inDMs && store.railContent == .normal) {
                            Image(systemName: "bubble.left.and.bubble.right.fill")
                                .font(.system(size: 19))
                        }
                    }
                    .buttonStyle(.plain)

                    Button { store.showMentions() } label: {
                        RailTile(active: store.railContent == .mentions) {
                            Image(systemName: "at")
                                .font(.system(size: 19, weight: .semibold))
                        }
                    }
                    .buttonStyle(.plain)

                    Button { store.showSaved() } label: {
                        RailTile(active: store.railContent == .saved) {
                            Image(systemName: "bookmark.fill")
                                .font(.system(size: 17, weight: .semibold))
                        }
                    }
                    .buttonStyle(.plain)

                    Rectangle()
                        .fill(Theme.line)
                        .frame(width: 32, height: 1)

                    ForEach(railEntries) { entry in
                        switch entry {
                        case .guild(let guild):
                            guildButton(guild, inFolder: false)
                        case .folder(let folder, let guilds):
                            folderView(folder, guilds)
                        }
                    }

                    if store.loadingGuilds && store.guilds.isEmpty {
                        ProgressView().tint(Theme.accent).padding(.top, 12)
                    }

                    Rectangle()
                        .fill(Theme.line)
                        .frame(width: 32, height: 1)

                    RailIconButton(symbol: "safari") { railSheet = .discover }
                    RailIconButton(symbol: "plus") { railSheet = .createServer }
                    RailIconButton(symbol: "link") { railSheet = .joinInvite }
                }
                .padding(.vertical, 12)
            }

            Divider().overlay(Theme.line)

            VStack(spacing: 10) {
                if session.currentUser?.isAdmin == true {
                    RailIconButton(symbol: "lock.shield") { railSheet = .admin }
                }
                RailIconButton(symbol: "person.2.fill") { railSheet = .family }

                Menu {
                    Section(session.currentUser?.name ?? "Account") {
                        Button { railSheet = .settings } label: {
                            Label("Settings", systemImage: "gearshape")
                        }
                        Button(role: .destructive) {
                            session.logout()
                        } label: {
                            Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                        }
                    }
                } label: {
                    Avatar(
                        url: session.currentUser?.avatarUrl,
                        name: session.currentUser?.name ?? "?",
                        size: 48,
                        status: store.status(for: session.currentUser?.id, fallback: session.currentUser?.status),
                        ringColor: Theme.bg0,
                        squircle: true,
                        decoration: session.currentUser?.avatarDecoration
                    )
                    .frame(maxWidth: .infinity)
                }
            }
            .padding(.vertical, 12)
        }
        .sheet(item: $railSheet) { which in
            switch which {
            case .settings: SettingsView()
            case .discover: DiscoveryView()
            case .createServer: CreateServerSheet()
            case .joinInvite: JoinByInviteSheet()
            case .admin: AdminView()
            case .family: FamilyView()
            case .quickSwitch: QuickSwitcherView()
            case .reorderServers: ReorderServersView()
            }
        }
        .alert("Rename Folder", isPresented: Binding(get: { renamingFolder != nil }, set: { if !$0 { renamingFolder = nil } })) {
            TextField("Folder name", text: $renameText)
            Button("Cancel", role: .cancel) { renamingFolder = nil }
            Button("Save") {
                let trimmed = renameText.trimmingCharacters(in: .whitespaces)
                if let f = renamingFolder, !trimmed.isEmpty {
                    Task { await session.renameFolder(f.id, name: trimmed) }
                }
                renamingFolder = nil
            }
        }
    }

    // MARK: Rail entries (folders interleaved with standalone guilds)

    private enum RailEntry: Identifiable {
        case guild(Guild)
        case folder(GuildFolder, [Guild])
        var id: String {
            switch self {
            case .guild(let g): return "g_\(g.id)"
            case .folder(let f, _): return "f_\(f.id)"
            }
        }
    }
    private var railEntries: [RailEntry] {
        let folders = session.guildFolders
        let ordered = store.orderedGuilds
        let guildById = Dictionary(ordered.map { ($0.id, $0) }, uniquingKeysWith: { a, _ in a })
        var folderByGuild: [String: GuildFolder] = [:]
        for f in folders { for gid in f.guildIds { folderByGuild[gid] = f } }
        var emitted = Set<String>()
        var entries: [RailEntry] = []
        for g in ordered {
            if let folder = folderByGuild[g.id] {
                if emitted.contains(folder.id) { continue }
                emitted.insert(folder.id)
                let guilds = folder.guildIds.compactMap { guildById[$0] }
                if guilds.isEmpty { continue }
                entries.append(.folder(folder, guilds))
            } else {
                entries.append(.guild(g))
            }
        }
        return entries
    }
    private func folderColor(_ f: GuildFolder) -> Color {
        if let hex = f.color, hex.hasPrefix("#"), let v = UInt32(hex.dropFirst(), radix: 16) { return Color(hex: v) }
        return Theme.accent
    }

    @ViewBuilder
    private func guildButton(_ guild: Guild, inFolder: Bool) -> some View {
        let isSelected = !store.inDMs && store.railContent == .normal && guild.id == store.selectedGuild?.id
        Button {
            store.selectGuild(guild)
        } label: {
            GuildIcon(guild: guild, isSelected: isSelected)
                .frame(maxWidth: .infinity)
                .overlay(alignment: .leading) { RailPip(active: isSelected) }
        }
        .buttonStyle(.plain)
        .contextMenu {
            if inFolder {
                Button { Task { await session.removeGuildFromFolders(guild.id) } } label: {
                    Label("Remove from Folder", systemImage: "folder.badge.minus")
                }
            } else {
                if !session.guildFolders.isEmpty {
                    Menu {
                        ForEach(session.guildFolders) { f in
                            Button(f.name) { Task { await session.addGuild(guild.id, toFolder: f.id) } }
                        }
                    } label: { Label("Move to Folder", systemImage: "folder") }
                }
                Button { Task { await session.createFolder(with: guild.id) } } label: {
                    Label("New Folder", systemImage: "folder.badge.plus")
                }
            }
            Button { railSheet = .reorderServers } label: {
                Label("Reorder Servers", systemImage: "arrow.up.arrow.down")
            }
        }
    }

    @ViewBuilder
    private func folderView(_ f: GuildFolder, _ guilds: [Guild]) -> some View {
        let collapsed = store.collapsedFolders.contains(f.id)
        VStack(spacing: 8) {
            Button { store.toggleFolderCollapsed(f.id) } label: {
                ZStack {
                    RoundedRectangle(cornerRadius: 48 * Theme.squircleFraction, style: .continuous)
                        .fill(folderColor(f).opacity(0.22))
                        .frame(width: 48, height: 48)
                    if collapsed {
                        folderMiniGrid(guilds)
                    } else {
                        Image(systemName: "folder.fill")
                            .font(.system(size: 18)).foregroundColor(folderColor(f))
                    }
                }
                .frame(maxWidth: .infinity)
            }
            .buttonStyle(.plain)
            .contextMenu { folderContextMenu(f) }
            if !collapsed {
                ForEach(guilds) { g in guildButton(g, inFolder: true) }
            }
        }
    }

    private func folderMiniGrid(_ guilds: [Guild]) -> some View {
        let shown = Array(guilds.prefix(4))
        return LazyVGrid(columns: [GridItem(.fixed(15), spacing: 2), GridItem(.fixed(15), spacing: 2)], spacing: 2) {
            ForEach(shown) { g in GuildIcon(guild: g, isSelected: false, size: 15) }
        }
        .frame(width: 34, height: 34)
    }

    @ViewBuilder
    private func folderContextMenu(_ f: GuildFolder) -> some View {
        Button { renameText = f.name; renamingFolder = f } label: {
            Label("Rename Folder", systemImage: "pencil")
        }
        Button(role: .destructive) { Task { await session.deleteFolder(f.id) } } label: {
            Label("Delete Folder", systemImage: "trash")
        }
    }
}

/// Channel list for the selected guild.
struct ChannelListView: View {
    @EnvironmentObject private var store: AppStore
    @State private var showCreateChannel = false
    @State private var showGuildSettings = false
    @State private var showGuildInfo = false
    @State private var showReorderChannels = false
    @State private var editingChannel: Channel?
    @State private var deletingChannel: Channel?
    /// Category pre-selected for channel creation (per-category "+").
    @State private var createInCategory: Channel?

    var body: some View {
        VStack(spacing: 0) {
            // Guild banner (web: aspect 16:9, object-cover, border-b line).
            if let banner = assetURL(store.selectedGuild?.bannerUrl) {
                Color.clear
                    .aspectRatio(16.0 / 9.0, contentMode: .fit)
                    .background(Theme.bg3)
                    .overlay {
                        AsyncImage(url: banner) { phase in
                            if case .success(let image) = phase {
                                image.resizable().scaledToFill()
                            }
                        }
                    }
                    .clipped()
                    .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .bottom)
            }

            // Header (web: px-3 py-1.5, soft bottom border, name wraps,
            // chevron — the whole strip opens the server menu).
            HStack(alignment: .top, spacing: 4) {
                Button { showGuildInfo = true } label: {
                    HStack(alignment: .top, spacing: 6) {
                        Text(store.selectedGuild?.name ?? "Zekktris")
                            .font(.zkSans(14, weight: .semibold))
                            .foregroundColor(Theme.ink1)
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(Theme.ink2)
                            .padding(.top, 2)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if store.canManageChannels {
                    Menu {
                        Button { showCreateChannel = true } label: {
                            Label("Create Channel", systemImage: "plus")
                        }
                        Button { showReorderChannels = true } label: {
                            Label("Reorder Channels", systemImage: "arrow.up.arrow.down")
                        }
                    } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 15, weight: .semibold))
                            .foregroundColor(Theme.ink2)
                            .frame(width: 24, height: 24)
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 8)
            .overlay(Rectangle().fill(Theme.lineSoft).frame(height: 1), alignment: .bottom)

            if store.loadingChannels && store.channels.isEmpty {
                Spacer()
                ProgressView().tint(Theme.accent)
                Spacer()
            } else if store.channels.isEmpty {
                Spacer()
                Text(store.selectedGuild == nil ? "Select a server" : "No channels")
                    .font(.zkSans(14))
                    .foregroundColor(Theme.ink3)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 2) {
                        ForEach(uncategorizedChannels) { channelRow($0) }
                        ForEach(sortedCategories) { category in
                            categoryHeader(category)
                            if !store.collapsedCategories.contains(category.id) {
                                ForEach(channels(in: category)) { channelRow($0) }
                            }
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
                }
            }
        }
        // Web: channel column = bg-2/85 over the abyss.
        .background(Theme.bg2.opacity(0.85))
        .sheet(isPresented: $showCreateChannel, onDismiss: { createInCategory = nil }) {
            CreateChannelSheet(categories: sortedCategories, initialParentId: createInCategory?.id)
        }
        .sheet(isPresented: $showGuildSettings) {
            GuildSettingsView()
        }
        .sheet(isPresented: $showGuildInfo) {
            GuildInfoCard(onOpenSettings: {
                showGuildInfo = false
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.4) { showGuildSettings = true }
            })
        }
        .sheet(isPresented: $showReorderChannels) {
            ReorderChannelsView()
        }
        .sheet(item: $editingChannel) { ch in
            EditChannelSheet(channel: ch, categories: sortedCategories)
        }
        .confirmationDialog(
            "Delete #\(deletingChannel?.name ?? "channel")?",
            isPresented: Binding(get: { deletingChannel != nil }, set: { if !$0 { deletingChannel = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete", role: .destructive) {
                if let ch = deletingChannel { Task { await store.deleteChannel(ch) } }
                deletingChannel = nil
            }
            Button("Cancel", role: .cancel) { deletingChannel = nil }
        } message: {
            Text("This permanently deletes the channel and its messages.")
        }
    }

    // Channels sorted by position (id tiebreak), then grouped under their
    // category — mirrors the web's groupByCategory so the sidebar matches.
    private var sortedChannels: [Channel] {
        store.channels.sorted { a, b in
            let pa = a.position ?? 0, pb = b.position ?? 0
            return pa != pb ? pa < pb : a.id < b.id
        }
    }
    private var sortedCategories: [Channel] {
        sortedChannels.filter { $0.isCategory }
    }
    private var uncategorizedChannels: [Channel] {
        sortedChannels.filter { !$0.isCategory && !$0.isThread && $0.parentId == nil }
    }
    private func channels(in category: Channel) -> [Channel] {
        sortedChannels.filter { !$0.isCategory && !$0.isThread && $0.parentId == category.id }
    }

    private func categoryHeader(_ category: Channel) -> some View {
        // Web `.zk-cap` header: JetBrains Mono 10.5, uppercase, 0.14em
        // tracking, ink-3, with a collapse chevron; managers get gear/plus
        // affordances (always visible on touch, like the web's
        // [@media(hover:none)] rule).
        let collapsed = store.collapsedCategories.contains(category.id)
        return HStack(spacing: 4) {
            Button { store.toggleCategoryCollapsed(category.id) } label: {
                HStack(spacing: 4) {
                    Image(systemName: collapsed ? "chevron.right" : "chevron.down")
                        .font(.system(size: 9, weight: .semibold))
                    Text((category.name ?? "(unnamed)").uppercased())
                        .font(.zkMono(10.5))
                        .tracking(Theme.capTracking(10.5))
                        .lineLimit(1)
                }
                .foregroundColor(Theme.ink3)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            Spacer(minLength: 0)
            if store.canManageChannels {
                Button { editingChannel = category } label: {
                    Image(systemName: "gearshape")
                        .font(.system(size: 11))
                        .foregroundColor(Theme.ink3)
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
                Button {
                    createInCategory = category
                    showCreateChannel = true
                } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 12))
                        .foregroundColor(Theme.ink3)
                        .frame(width: 20, height: 20)
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.leading, 12)
        .padding(.trailing, 4)
        .padding(.top, 12)
        .padding(.bottom, 2)
        .contextMenu {
            if store.canManageChannels {
                Button { editingChannel = category } label: {
                    Label("Edit Category", systemImage: "pencil")
                }
                Button(role: .destructive) { deletingChannel = category } label: {
                    Label("Delete Category", systemImage: "trash")
                }
            }
        }
    }

    @ViewBuilder
    private func channelRow(_ channel: Channel) -> some View {
        Group {
            if channel.isText {
                Button { store.selectChannel(channel) } label: {
                    ChannelRowLabel(symbol: "number", iconTint: .accent,
                                    name: channel.name ?? "channel",
                                    restricted: channel.restricted == true,
                                    unread: store.isChannelUnread(channel),
                                    mentions: store.mentionCount(for: channel.id))
                }
                .buttonStyle(.plain)
            } else if channel.isForum {
                Button { store.openThreads(channel) } label: {
                    ChannelRowLabel(symbol: "list.bullet.rectangle", iconTint: .accent,
                                    name: channel.name ?? "forum",
                                    restricted: channel.restricted == true,
                                    unread: store.isChannelUnread(channel),
                                    mentions: store.mentionCount(for: channel.id))
                }
                .buttonStyle(.plain)
            } else if channel.isLink {
                Button {
                    if let url = channel.linkUrl.flatMap(URL.init(string:)) {
                        UIApplication.shared.open(url)
                    }
                } label: {
                    ChannelRowLabel(symbol: "arrow.up.right.square", iconTint: .accent,
                                    name: channel.name ?? "link",
                                    restricted: channel.restricted == true)
                }
                .buttonStyle(.plain)
            } else if channel.isStage {
                Button { store.openVoice(channel) } label: {
                    ChannelRowLabel(symbol: "dot.radiowaves.left.and.right", iconTint: .tertiary,
                                    name: channel.name ?? "stage",
                                    restricted: channel.restricted == true,
                                    trailingCount: store.voiceParticipants(in: channel.id).count)
                }
                .buttonStyle(.plain)
            } else if channel.isVoice {
                let participants = store.voiceParticipants(in: channel.id)
                VStack(alignment: .leading, spacing: 2) {
                    Button { store.openVoice(channel) } label: {
                        ChannelRowLabel(symbol: "speaker.wave.2.fill", iconTint: .accent,
                                        name: channel.name ?? "voice",
                                        restricted: channel.restricted == true,
                                        active: store.activeVoiceOrStageId == channel.id,
                                        trailingCount: participants.count)
                    }
                    .buttonStyle(.plain)
                    // Web parity: tiny live participant list nested under
                    // the row (ml-6, mt-0.5, space-y-0.5).
                    if !participants.isEmpty {
                        VStack(alignment: .leading, spacing: 2) {
                            ForEach(participants) { vs in
                                SidebarVoiceParticipant(state: vs)
                            }
                        }
                        .padding(.leading, 24)
                        .padding(.bottom, 4)
                    }
                }
            }
        }
        .contextMenu {
            if store.canManageChannels {
                Button { editingChannel = channel } label: {
                    Label("Edit Channel", systemImage: "pencil")
                }
                Button(role: .destructive) { deletingChannel = channel } label: {
                    Label("Delete Channel", systemImage: "trash")
                }
            }
        }
    }
}

/// One channel row, matching the web's ChannelRow exactly: 14pt label,
/// accent-tinted type icon with an optional corner padlock, ink-2 text
/// (ink-1 + medium when unread), trailing red-500 mention pill or a 6pt
/// ink-1 unread dot, and the `.row-active` treatment when active.
private struct ChannelRowLabel: View {
    enum IconTint { case accent, tertiary }
    let symbol: String
    var iconTint: IconTint = .accent
    let name: String
    var restricted: Bool = false
    var unread: Bool = false
    var active: Bool = false
    var mentions: Int = 0
    /// Voice/stage rows: participant count shown at the trailing edge.
    var trailingCount: Int = 0

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: symbol)
                .font(.system(size: 13))
                .foregroundColor(iconTint == .accent ? Theme.accent : Theme.ink3)
                .frame(width: 16)
                .overlay(alignment: .topTrailing) {
                    if restricted {
                        Image(systemName: "lock.fill")
                            .font(.system(size: 7, weight: .bold))
                            .foregroundColor(Theme.ink3)
                            .offset(x: 5, y: -4)
                    }
                }
            Text(name)
                .font(.zkSans(14, weight: unread ? .medium : .regular))
                .foregroundColor(unread || active ? Theme.ink1 : Theme.ink2)
                .lineLimit(1)
            Spacer(minLength: 0)
            if mentions > 0 {
                Text(mentions > 99 ? "99+" : "\(mentions)")
                    .font(.zkSans(10, weight: .bold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 4)
                    .frame(minWidth: 17, minHeight: 17)
                    .background(Theme.danger)
                    .clipShape(Capsule())
            } else if unread {
                Circle().fill(Theme.ink1).frame(width: 6, height: 6)
            } else if trailingCount > 0 {
                Text("\(trailingCount)")
                    .font(.zkSans(10))
                    .foregroundColor(Theme.ink3)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .contentShape(Rectangle())
        .rowActive(active)
    }
}

/// Tiny presence row nested under a voice channel in the sidebar (web's
/// VoiceParticipant): 18pt avatar, 13pt name, mute/deafen glyphs.
private struct SidebarVoiceParticipant: View {
    @EnvironmentObject private var store: AppStore
    let state: VoiceState

    var body: some View {
        let member = store.members[state.userId]
        let label = member?.nickname ?? member?.user.name ?? String(state.userId.suffix(5))
        HStack(spacing: 6) {
            Avatar(url: member?.user.avatarUrl, name: label, size: 18, toneId: state.userId)
            Text(label)
                .font(.zkSans(13))
                .foregroundColor(Theme.ink3)
                .lineLimit(1)
            if state.selfDeaf == true {
                Image(systemName: "speaker.slash.fill")
                    .font(.system(size: 9)).foregroundColor(Theme.ink4)
            } else if state.selfMute == true {
                Image(systemName: "mic.slash.fill")
                    .font(.system(size: 9)).foregroundColor(Theme.ink4)
            }
            Spacer(minLength: 0)
        }
        .padding(.vertical, 1)
    }
}

/// Web rail-tile treatment (HomeTile/MentionsTile/DiscoverTile): a 48pt
/// squircle that is bg-2 + ink-2 at rest, and an accent→accent-2 gradient
/// with bg-0 glyph + double glow when active. The active rail-pin renders
/// at the rail's left edge.
struct RailTile<Content: View>: View {
    let active: Bool
    @ViewBuilder var content: Content
    var size: CGFloat = 48

    init(active: Bool, size: CGFloat = 48, @ViewBuilder content: () -> Content) {
        self.active = active
        self.size = size
        self.content = content()
    }

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: size * Theme.squircleFraction, style: .continuous)
        ZStack {
            if active {
                LinearGradient(colors: [Theme.accent, Theme.accent2],
                               startPoint: .topLeading, endPoint: .bottomTrailing)
            } else {
                Theme.bg2
            }
            content
                .foregroundColor(active ? Theme.bg0 : Theme.ink2)
        }
        .frame(width: size, height: size)
        .clipShape(shape)
        .overlay(shape.strokeBorder(active ? Theme.accentGlow : Color.clear, lineWidth: 1))
        .shadow(color: active ? Theme.accentGlow : .clear, radius: 14, x: 0, y: 8)
        .frame(maxWidth: .infinity)
        .overlay(alignment: .leading) { RailPip(active: active) }
        .animation(.easeOut(duration: 0.15), value: active)
    }
}

/// The accent rail-pin that marks the active rail entry (web: 6×32pt,
/// rounded right edge, accent glow). Sits flush against the rail's left
/// edge — hidden entirely when inactive (hover nub is a no-op on touch).
struct RailPip: View {
    let active: Bool
    var body: some View {
        if active {
            UnevenRoundedRectangle(topLeadingRadius: 0, bottomLeadingRadius: 0,
                                   bottomTrailingRadius: 3, topTrailingRadius: 3)
                .fill(Theme.accent)
                .frame(width: 6, height: 32)
                .shadow(color: Theme.accentGlow, radius: 12)
        }
    }
}

/// List of the current user's direct-message conversations. Mirrors the web
/// DMList: quick-switcher rows (Friends / Your events / Saved / Scheduled)
/// above an uppercase "DIRECT MESSAGES" section of conversation rows.
struct DMListView: View {
    @EnvironmentObject private var store: AppStore
    @State private var showFriends = false
    @State private var showMyEvents = false
    @State private var showScheduled = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    quickRow("person.2.fill", "Friends") { showFriends = true }
                    quickRow("calendar", "Your events") { showMyEvents = true }
                    quickRow("bookmark", "Saved messages") { store.showSaved() }
                    quickRow("clock", "Scheduled messages") { showScheduled = true }

                    HStack {
                        Text("DIRECT MESSAGES")
                            .font(.zkSans(11, weight: .semibold))
                            .tracking(0.5)
                            .foregroundColor(Theme.ink3)
                        Spacer()
                        Button { showFriends = true } label: {
                            Image(systemName: "plus")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(Theme.ink3)
                                .frame(width: 24, height: 24)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 8)
                    .padding(.top, 12)
                    .padding(.bottom, 2)

                    if store.loadingDMs && store.dms.isEmpty {
                        ProgressView().tint(Theme.accent)
                            .frame(maxWidth: .infinity)
                            .padding(.top, 24)
                    } else if store.dms.isEmpty {
                        Text("No direct messages yet")
                            .font(.zkSans(13))
                            .foregroundColor(Theme.ink3)
                            .padding(.horizontal, 8)
                            .padding(.top, 8)
                    } else {
                        ForEach(store.dms) { dm in
                            Button { store.selectChannel(dm) } label: { DMRow(dm: dm) }
                                .buttonStyle(.plain)
                        }
                    }
                }
                .padding(.horizontal, 8)
                .padding(.vertical, 8)
            }
        }
        .background(Theme.bg2.opacity(0.85))
        .sheet(isPresented: $showFriends) {
            FriendsView()
        }
        .sheet(isPresented: $showMyEvents) {
            MyEventsView()
        }
        .sheet(isPresented: $showScheduled) {
            ScheduledMessagesSheet()
        }
        .sheet(item: $store.profileUser) { ProfileCardView(user: $0) }
        .fullScreenCover(item: $store.lightbox) { ImageLightboxView(url: $0.url) }
    }

    /// Web quick-switcher row: icon 16 ink-3 + 14pt ink-2 label.
    private func quickRow(_ symbol: String, _ label: String, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: symbol)
                    .font(.system(size: 14))
                    .foregroundColor(Theme.ink3)
                    .frame(width: 18)
                Text(label)
                    .font(.zkSans(14))
                    .foregroundColor(Theme.ink2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 8)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }
}

/// Pending scheduled messages (web /scheduled view): content preview, target
/// channel, fire time, cancel affordance.
struct ScheduledMessagesSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.scheduledMessages.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "clock")
                            .font(.system(size: 30, weight: .light))
                            .foregroundColor(Theme.ink3)
                        Text("No scheduled messages")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            ForEach(store.scheduledMessages) { sm in
                                scheduledRow(sm)
                            }
                        }
                        .padding(12)
                    }
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Scheduled").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadScheduled() }
        }
    }

    private func scheduledRow(_ sm: ScheduledMessage) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 6) {
                Image(systemName: "clock")
                    .font(.system(size: 11)).foregroundColor(Theme.accent)
                Text(scheduledTimeLabel(sm.scheduledFor))
                    .font(.zkSans(12, weight: .medium)).foregroundColor(Theme.ink2)
                Spacer()
                Button(role: .destructive) {
                    Task { await store.cancelScheduled(sm) }
                } label: {
                    Image(systemName: "trash")
                        .font(.system(size: 12)).foregroundColor(Theme.dangerSoft)
                }
            }
            Text(sm.content ?? "")
                .font(.zkSans(14)).foregroundColor(Theme.ink1)
                .lineLimit(3)
        }
        .padding(12)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: Theme.rMD, style: .continuous))
        .overlay(RoundedRectangle(cornerRadius: Theme.rMD).strokeBorder(Theme.line, lineWidth: 1))
    }

    private func scheduledTimeLabel(_ iso: String) -> String {
        guard let d = messageDate(iso) else { return iso }
        let f = DateFormatter()
        f.dateStyle = .medium; f.timeStyle = .short
        return f.string(from: d)
    }
}

private struct DMRow: View {
    @EnvironmentObject private var store: AppStore
    let dm: Channel

    var body: some View {
        let unread = store.isChannelUnread(dm)
        let mentions = store.mentionCount(for: dm.id)
        HStack(spacing: 10) {
            Avatar(
                url: dm.dmAvatarUser?.avatarUrl,
                name: dm.dmTitle,
                size: 36,
                status: store.status(for: dm.dmAvatarUser?.id, fallback: dm.dmAvatarUser?.status),
                ringColor: Theme.bg2
            )
            Text(dm.dmTitle)
                .font(.zkSans(15, weight: unread ? .semibold : .regular))
                .foregroundColor(unread ? Theme.ink1 : Theme.ink2)
                .lineLimit(1)
            Spacer(minLength: 0)
            if mentions > 0 {
                Text("\(min(mentions, 99))")
                    .font(.zkSans(11, weight: .bold))
                    .foregroundColor(.white)
                    .padding(.horizontal, 6)
                    .padding(.vertical, 1)
                    .background(Theme.danger)
                    .clipShape(Capsule())
            } else if unread {
                Circle().fill(Theme.ink1).frame(width: 7, height: 7)
            }
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 7)
        .contentShape(Rectangle())
    }
}

/// Friends sheet: add by username, accept incoming requests, and start a DM.
struct FriendsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var addStatus: String?
    @State private var adding = false

    private var friends: [Relationship] { store.relationships.filter { $0.type == "friend" } }
    private var incoming: [Relationship] { store.relationships.filter { $0.type == "incoming_request" } }
    private var outgoing: [Relationship] { store.relationships.filter { $0.type == "outgoing_request" } }
    private var blocked: [Relationship] { store.relationships.filter { $0.type == "blocked" } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    addFriendSection
                    if !incoming.isEmpty { requestsSection }
                    if !outgoing.isEmpty { pendingSection }
                    friendsSection
                    if !blocked.isEmpty { blockedSection }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Friends")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .task { await store.loadRelationships() }
        }
    }

    private var canAdd: Bool {
        !username.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var addFriendSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ADD A FRIEND")
                .font(.zkSans(11, weight: .bold))
                .foregroundColor(Theme.ink3)
            HStack(spacing: 8) {
                TextField("Username", text: $username)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .padding(.horizontal, 12)
                    .padding(.vertical, 10)
                    .background(Theme.bg3)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundColor(Theme.ink1)
                Button {
                    let name = username
                    adding = true
                    Task {
                        let err = await store.addFriend(username: name)
                        addStatus = err ?? "Request sent."
                        if err == nil { username = "" }
                        adding = false
                    }
                } label: {
                    Text("Add")
                        .font(.zkSans(14, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(canAdd ? Theme.accent : Theme.ink4)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(!canAdd || adding)
            }
            if let addStatus {
                Text(addStatus)
                    .font(.zkSans(12))
                    .foregroundColor(Theme.ink2)
            }
        }
    }

    private var requestsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("REQUESTS")
                .font(.zkSans(11, weight: .bold))
                .foregroundColor(Theme.ink3)
            ForEach(incoming) { rel in
                HStack(spacing: 10) {
                    Avatar(url: rel.user.avatarUrl, name: rel.user.name, size: 36)
                    Text(rel.user.name)
                        .font(.zkSans(15))
                        .foregroundColor(Theme.ink1)
                    Spacer()
                    Button { Task { await store.acceptFriend(rel.user) } } label: {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 24))
                            .foregroundColor(Theme.online)
                    }
                    Button { Task { await store.removeFriend(rel.user) } } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 24))
                            .foregroundColor(Theme.ink3)
                    }
                }
            }
        }
    }

    private var friendsSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("FRIENDS")
                .font(.zkSans(11, weight: .bold))
                .foregroundColor(Theme.ink3)
            if friends.isEmpty {
                Text("No friends yet")
                    .font(.zkSans(13))
                    .foregroundColor(Theme.ink3)
            } else {
                ForEach(friends) { rel in
                    Button {
                        Task {
                            if let ch = await store.startDM(with: rel.user) {
                                store.selectChannel(ch)
                                dismiss()
                            }
                        }
                    } label: {
                        HStack(spacing: 10) {
                            Avatar(url: rel.user.avatarUrl, name: rel.user.name, size: 36, status: store.presence[rel.user.id])
                            Text(rel.user.name)
                                .font(.zkSans(15))
                                .foregroundColor(Theme.ink1)
                            Spacer()
                            Image(systemName: "message.fill")
                                .font(.system(size: 14))
                                .foregroundColor(Theme.ink3)
                        }
                    }
                    .buttonStyle(.plain)
                    .contextMenu {
                        Button(role: .destructive) {
                            Task { await store.removeFriend(rel.user) }
                        } label: {
                            Label("Remove friend", systemImage: "person.badge.minus")
                        }
                        Button(role: .destructive) {
                            Task { await store.blockUser(rel.user) }
                        } label: {
                            Label("Block", systemImage: "hand.raised")
                        }
                    }
                }
            }
        }
    }

    private var pendingSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("PENDING")
                .font(.zkSans(11, weight: .bold))
                .foregroundColor(Theme.ink3)
            ForEach(outgoing) { rel in
                HStack(spacing: 10) {
                    Avatar(url: rel.user.avatarUrl, name: rel.user.name, size: 36)
                    Text(rel.user.name)
                        .font(.zkSans(15))
                        .foregroundColor(Theme.ink1)
                    Spacer()
                    Button { Task { await store.removeFriend(rel.user) } } label: {
                        Text("Cancel")
                            .font(.zkSans(13, weight: .medium))
                            .foregroundColor(Theme.ink2)
                    }
                }
            }
        }
    }

    private var blockedSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("BLOCKED")
                .font(.zkSans(11, weight: .bold))
                .foregroundColor(Theme.ink3)
            ForEach(blocked) { rel in
                HStack(spacing: 10) {
                    Avatar(url: rel.user.avatarUrl, name: rel.user.name, size: 36)
                    Text(rel.user.name)
                        .font(.zkSans(15))
                        .foregroundColor(Theme.ink2)
                    Spacer()
                    Button { Task { await store.unblockUser(rel.user) } } label: {
                        Text("Unblock")
                            .font(.zkSans(13, weight: .medium))
                            .foregroundColor(Theme.accent)
                    }
                }
            }
        }
    }
}

/// Settings / profile sheet: status, display name, custom status, account.
struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var displayName = ""
    @State private var customStatus = ""
    @State private var customStatusEmoji = ""
    @State private var nameStatus: String?
    @State private var showChangePassword = false
    @State private var faceIDOn = false

    private let statuses: [(String, String, Color)] = [
        ("Online", "online", Theme.online),
        ("Idle", "idle", Theme.idle),
        ("Do Not Disturb", "dnd", Theme.dnd),
        ("Invisible", "invisible", Theme.offline),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    profileHeader
                    statusSection
                    displayNameSection
                    customStatusSection
                    decorationSection
                    appearanceSection
                    securitySection
                    accountSection
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Done") { dismiss() }
                }
            }
            .onAppear {
                displayName = session.currentUser?.displayName ?? ""
                customStatus = session.currentUser?.customStatus ?? ""
                customStatusEmoji = session.currentUser?.customStatusEmoji ?? ""
                faceIDOn = session.faceIDEnabled
            }
        }
    }

    private var profileHeader: some View {
        HStack(spacing: 12) {
            Avatar(
                url: session.currentUser?.avatarUrl,
                name: session.currentUser?.name ?? "?",
                size: 56,
                status: session.currentUser?.status
            )
            VStack(alignment: .leading, spacing: 2) {
                Text(session.currentUser?.name ?? "You")
                    .font(.zkSans(18, weight: .semibold))
                    .foregroundColor(Theme.ink1)
                if let username = session.currentUser?.username {
                    Text("@\(username)")
                        .font(.zkSans(13))
                        .foregroundColor(Theme.ink3)
                }
            }
            Spacer()
        }
    }

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("STATUS")
            ForEach(statuses, id: \.1) { label, value, color in
                Button { Task { await session.setStatus(value) } } label: {
                    HStack(spacing: 10) {
                        Circle().fill(color).frame(width: 10, height: 10)
                        Text(label).font(.zkSans(15)).foregroundColor(Theme.ink1)
                        Spacer()
                        if session.currentUser?.status == value {
                            Image(systemName: "checkmark")
                                .font(.system(size: 13, weight: .semibold))
                                .foregroundColor(Theme.accent)
                        }
                    }
                    .padding(.vertical, 8)
                    .padding(.horizontal, 12)
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var displayNameSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("DISPLAY NAME")
            HStack(spacing: 8) {
                TextField("Display name", text: $displayName)
                    .padding(12)
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundColor(Theme.ink1)
                Button {
                    let n = displayName
                    Task { nameStatus = await session.updateDisplayName(n) ?? "Saved." }
                } label: {
                    Text("Save")
                        .font(.zkSans(14, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(displayName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let nameStatus {
                Text(nameStatus).font(.zkSans(12)).foregroundColor(Theme.ink2)
            }
        }
    }

    private var customStatusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("CUSTOM STATUS")
            HStack(spacing: 8) {
                TextField("🙂", text: $customStatusEmoji)
                    .multilineTextAlignment(.center)
                    .frame(width: 48)
                    .padding(12)
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundColor(Theme.ink1)
                TextField("What's happening?", text: $customStatus)
                    .padding(12)
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundColor(Theme.ink1)
                Button {
                    let s = customStatus
                    let e = customStatusEmoji
                    Task { await session.setCustomStatus(s, emoji: e) }
                } label: {
                    Text("Set")
                        .font(.zkSans(14, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            if !customStatus.isEmpty || !customStatusEmoji.isEmpty {
                Button {
                    customStatus = ""
                    customStatusEmoji = ""
                    Task { await session.setCustomStatus(nil, emoji: nil) }
                } label: {
                    Text("Clear status")
                        .font(.zkSans(13))
                        .foregroundColor(Theme.ink3)
                }
            }
        }
    }

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("APPEARANCE")
            ForEach(ZKThemes) { opt in
                themeRow(opt)
            }
        }
    }

    private func themeRow(_ opt: ThemeOption) -> some View {
        let pal = ThemePalette.palette(for: opt.id)
        let selected = store.themeId == opt.id
        return Button { store.setTheme(opt.id) } label: {
            HStack(spacing: 11) {
                ZStack {
                    Circle().fill(pal.bg0).frame(width: 30, height: 30)
                        .overlay(Circle().stroke(Theme.line, lineWidth: 1))
                    HStack(spacing: -5) {
                        Circle().fill(pal.accent).frame(width: 13, height: 13)
                        Circle().fill(pal.accent2).frame(width: 13, height: 13)
                    }
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(opt.label).font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                    Text(opt.group).font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark.circle.fill")
                        .font(.system(size: 18)).foregroundColor(Theme.accent)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .background(selected ? Theme.bg3 : Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 10))
            .overlay(
                RoundedRectangle(cornerRadius: 10)
                    .stroke(selected ? Theme.accent.opacity(0.5) : Color.clear, lineWidth: 1)
            )
        }
        .buttonStyle(.plain)
    }

    private var decorationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("AVATAR DECORATION")
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 10) {
                    ForEach(Avatar.decorations, id: \.id) { d in
                        Button { Task { await session.setAvatarDecoration(d.id) } } label: {
                            VStack(spacing: 5) {
                                Avatar(url: session.currentUser?.avatarUrl, name: session.currentUser?.name ?? "?", size: 46, decoration: d.id)
                                Text(d.label).font(.zkSans(10)).foregroundColor(Theme.ink3).lineLimit(1)
                            }
                            .padding(8)
                            .background((session.currentUser?.avatarDecoration ?? "none") == d.id ? Theme.bg3 : Color.clear)
                            .clipShape(RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private var securitySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("SECURITY")
            if Biometrics.available {
                Toggle(isOn: Binding(
                    get: { faceIDOn },
                    set: { newValue in
                        Task {
                            _ = await session.setFaceID(newValue)
                            faceIDOn = session.faceIDEnabled
                        }
                    }
                )) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Unlock with \(Biometrics.typeLabel)")
                            .font(.zkSans(15)).foregroundColor(Theme.ink1)
                        Text("Require \(Biometrics.typeLabel) when opening Zekktris")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    }
                }
                .tint(Theme.accent)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            } else {
                Text("Biometric unlock isn't available on this device.")
                    .font(.zkSans(13)).foregroundColor(Theme.ink4)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, 12).padding(.vertical, 10)
                    .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("ACCOUNT")
            accountRow(label: "Username", value: session.currentUser?.username.map { "@\($0)" } ?? "—")
            accountRow(label: "Email", value: session.currentUser?.email ?? "—")
            accountRow(label: "User ID", value: session.currentUser?.id ?? "—", copyable: true, mono: true)

            Button { showChangePassword = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "key.fill").font(.system(size: 14)).foregroundColor(Theme.ink3).frame(width: 20)
                    Text("Change Password").font(.system(size: 15)).foregroundColor(Theme.ink1)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
                }
                .padding(.horizontal, 12).padding(.vertical, 12)
                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)

            Button(role: .destructive) {
                dismiss()
                session.logout()
            } label: {
                Label("Log out", systemImage: "rectangle.portrait.and.arrow.right")
                    .font(.zkSans(15, weight: .medium))
                    .foregroundColor(Theme.danger)
            }
            .padding(.top, 4)
        }
        .sheet(isPresented: $showChangePassword) { ChangePasswordSheet() }
    }

    private func accountRow(label: String, value: String, copyable: Bool = false, mono: Bool = false) -> some View {
        HStack(spacing: 8) {
            Text(label).font(.zkSans(13)).foregroundColor(Theme.ink4)
            Spacer()
            Text(value)
                .font(mono ? .zkMono(13, weight: .medium) : .zkSans(13, weight: .medium))
                .foregroundColor(Theme.ink2)
                .lineLimit(1).truncationMode(.middle)
            if copyable {
                Button { UIPasteboard.general.string = value } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundColor(Theme.ink3)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func sectionTitle(_ t: String) -> some View {
        Text(t).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
    }
}

/// Recent @-mentions inbox (newest first). Tapping navigates best-effort.
struct MentionsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.loadingMentions && store.mentions.isEmpty {
                    ProgressView().tint(Theme.accent)
                } else if store.mentions.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "at")
                            .font(.system(size: 30))
                            .foregroundColor(Theme.ink3)
                        Text("No mentions")
                            .font(.zkSans(14))
                            .foregroundColor(Theme.ink3)
                    }
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 0) {
                            ForEach(store.mentions) { m in
                                Button {
                                    store.openMention(m)
                                } label: {
                                    MentionRow(mention: m)
                                }
                                .buttonStyle(.plain)
                                Divider().overlay(Theme.line)
                            }
                        }
                        .padding(.horizontal, 12)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background {
                // Opaque base -> abyss nebula -> 90% column wash (web bg-1/90).
                ZStack { Theme.bg1; AbyssBackground(); Theme.bg1.opacity(0.9) }.ignoresSafeArea()
            }
            .navigationTitle("Mentions")
            .navigationBarTitleDisplayMode(.inline)
            .task { await store.loadMentions() }
        }
    }
}

private struct MentionRow: View {
    let mention: Mention

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Text(mention.author?.name ?? "Unknown")
                    .font(.zkSans(13, weight: .semibold))
                    .foregroundColor(Theme.ink2)
                if let channelName = mention.channelName {
                    Text("#\(channelName)")
                        .font(.zkSans(12))
                        .foregroundColor(Theme.ink3)
                }
                Spacer()
                Text(shortTime(mention.createdAt))
                    .font(.zkSans(11))
                    .foregroundColor(Theme.ink3)
            }
            Text(mention.text.isEmpty ? "(no text)" : mention.text)
                .font(.zkSans(14))
                .foregroundColor(Theme.ink1)
                .lineLimit(3)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 10)
    }
}

// MARK: Rail icon button (Discover / Create / Join)

private struct RailIconButton: View {
    let symbol: String
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            RailTile(active: false) {
                Image(systemName: symbol)
                    .font(.system(size: 19, weight: .semibold))
            }
        }
        .buttonStyle(.plain)
    }
}

// MARK: Create server

struct CreateServerSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var serverDescription = ""
    @State private var busy = false

    private var canCreate: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Give your server a name. You can change it later.")
                        .font(.zkSans(14)).foregroundColor(Theme.ink3)
                    field("SERVER NAME") { TextField("My cool server", text: $name) }
                    field("DESCRIPTION (OPTIONAL)") {
                        TextField("What's it about?", text: $serverDescription, axis: .vertical).lineLimit(2...4)
                    }
                    Button {
                        busy = true
                        Task {
                            await store.createServer(name: name, description: serverDescription)
                            busy = false
                            dismiss()
                        }
                    } label: {
                        Text(busy ? "Creating…" : "Create Server")
                            .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 13)
                            .background(canCreate ? Theme.accent : Theme.bg3)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .disabled(!canCreate || busy)
                }
                .padding(20)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Create a Server").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }

    @ViewBuilder
    private func field<Content: View>(_ label: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(label).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            content()
                .textFieldStyle(.plain).foregroundColor(Theme.ink1).padding(12)
                .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
    }
}

// MARK: Join by invite

struct JoinByInviteSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var code = ""
    @State private var busy = false

    private var canJoin: Bool { !code.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Enter an invite code or link to join an existing server.")
                        .font(.zkSans(14)).foregroundColor(Theme.ink3)
                    VStack(alignment: .leading, spacing: 6) {
                        Text("INVITE CODE OR LINK")
                            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        TextField("abc123", text: $code)
                            .textFieldStyle(.plain).autocorrectionDisabled()
                            .textInputAutocapitalization(.never).foregroundColor(Theme.ink1).padding(12)
                            .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    Button {
                        busy = true
                        Task { await store.joinByInvite(code: code); busy = false; dismiss() }
                    } label: {
                        Text(busy ? "Joining…" : "Join Server")
                            .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 13)
                            .background(canJoin ? Theme.accent : Theme.bg3)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .disabled(!canJoin || busy)
                }
                .padding(20)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Join a Server").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
        }
    }
}

// MARK: Discover servers

struct DiscoveryView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.loadingDiscoverable && store.discoverable.isEmpty {
                    ProgressView().tint(Theme.accent)
                } else if store.discoverable.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "globe").font(.system(size: 30)).foregroundColor(Theme.ink3)
                        Text("No public servers found").font(.system(size: 14)).foregroundColor(Theme.ink3)
                    }
                } else {
                    ScrollView {
                        LazyVStack(spacing: 10) {
                            ForEach(store.discoverable) { DiscoverRow(guild: $0) }
                        }
                        .padding(16)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Discover").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadDiscoverable() }
        }
    }
}

private struct DiscoverRow: View {
    @EnvironmentObject private var store: AppStore
    let guild: DiscoverableGuild

    var body: some View {
        HStack(spacing: 12) {
            Avatar(url: guild.iconUrl, name: guild.name, size: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(guild.name)
                    .font(.zkSans(15, weight: .semibold)).foregroundColor(Theme.ink1).lineLimit(1)
                let sub = guild.discoveryDescription ?? guild.description
                if let sub, !sub.isEmpty {
                    Text(sub).font(.zkSans(12)).foregroundColor(Theme.ink3).lineLimit(2)
                }
                if let count = guild.memberCount {
                    Text("\(count) members").font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
            }
            Spacer(minLength: 8)
            if store.guilds.contains(where: { $0.id == guild.id }) {
                Text("Joined")
                    .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.ink3)
                    .padding(.horizontal, 14).padding(.vertical, 7)
                    .background(Theme.bg3).clipShape(Capsule())
            } else {
                Button { Task { await store.joinDiscoverable(guild) } } label: {
                    Text("Join")
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 7)
                        .background(Theme.accent).clipShape(Capsule())
                }
            }
        }
        .padding(12)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: Admin (instance)

struct AdminView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var tab = 0
    @State private var search = ""
    @State private var bannedOnly = false
    @State private var guildSearch = ""
    @State private var showStorageItems = false
    @State private var deletingGuild: AdminGuild?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $tab) {
                    Text("Overview").tag(0)
                    Text("Users").tag(1)
                    Text("Servers").tag(2)
                    Text("Storage").tag(3)
                }
                .pickerStyle(.segmented)
                .padding(12)

                if tab == 0 { overview }
                else if tab == 1 { users }
                else if tab == 2 { guilds }
                else { storage }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .onChange(of: tab) { newTab in
                if newTab == 1 && store.adminUsers.isEmpty {
                    Task { await store.loadAdminUsers(q: search, bannedOnly: bannedOnly) }
                } else if newTab == 2 && store.adminGuilds.isEmpty {
                    Task { await store.loadAdminGuilds(q: guildSearch) }
                }
            }
            .navigationTitle("Admin Instance").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showStorageItems) { StorageItemsView() }
            .task { await store.loadAdminStats() }
        }
    }

    private var overview: some View {
        ScrollView {
            if store.loadingAdminStats && store.adminStats == nil {
                ProgressView().tint(Theme.accent).padding(.top, 40)
            } else if let s = store.adminStats {
                VStack(spacing: 12) {
                    statRow("Users", "\(s.users.total)", detail: "\(s.users.banned) banned")
                    statRow("Servers", "\(s.guilds)", detail: nil)
                    statRow("Channels", "\(s.channels)", detail: nil)
                    statRow("Messages", "\(s.messages.total)", detail: "\(s.messages.last24h) in last 24h")
                    statRow("Active sessions", "\(s.activeSessions)", detail: nil)
                }
                .padding(16)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "lock.shield").font(.system(size: 30)).foregroundColor(Theme.ink3)
                    Text("Instance stats unavailable").font(.system(size: 14)).foregroundColor(Theme.ink3)
                    Text("Requires an instance-admin account.").font(.zkSans(12)).foregroundColor(Theme.ink4)
                }
                .padding(.top, 40)
            }
        }
    }

    private var users: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundColor(Theme.ink3)
                    TextField("Search users", text: $search)
                        .foregroundColor(Theme.ink1)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .onSubmit { Task { await store.loadAdminUsers(q: search, bannedOnly: bannedOnly) } }
                }
                .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                Button {
                    bannedOnly.toggle()
                    Task { await store.loadAdminUsers(q: search, bannedOnly: bannedOnly) }
                } label: {
                    Image(systemName: "person.crop.circle.badge.xmark")
                        .font(.system(size: 15))
                        .foregroundColor(bannedOnly ? Theme.danger : Theme.ink3)
                        .padding(10).background(bannedOnly ? Theme.danger.opacity(0.15) : Theme.bg2)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            .padding(.horizontal, 12).padding(.bottom, 8)

            if store.loadingAdminUsers && store.adminUsers.isEmpty {
                Spacer(); ProgressView().tint(Theme.accent); Spacer()
            } else if store.adminUsers.isEmpty {
                Spacer()
                Text("No users found.").font(.zkSans(14)).foregroundColor(Theme.ink3)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(store.adminUsers) { u in
                            userRow(u)
                            Rectangle().fill(Theme.line).frame(height: 1)
                        }
                    }
                }
            }
        }
        .task { if store.adminUsers.isEmpty { await store.loadAdminUsers(q: "", bannedOnly: false) } }
    }

    private func userRow(_ u: AdminUser) -> some View {
        HStack(spacing: 10) {
            Avatar(url: u.avatarUrl, name: u.name, size: 36, ringColor: Theme.bg1)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(u.name).font(.zkSans(15, weight: .medium)).foregroundColor(Theme.ink1).lineLimit(1)
                    if u.isAdmin { badge("ADMIN", Theme.accent) }
                    if u.isBanned { badge("BANNED", Theme.danger) }
                }
                Text("@\(u.username)").font(.zkSans(12)).foregroundColor(Theme.ink3).lineLimit(1)
            }
            Spacer()
            Menu {
                if u.isBanned {
                    Button { Task { await store.adminUnban(u) } } label: { Label("Unban", systemImage: "checkmark.circle") }
                } else {
                    Button(role: .destructive) { Task { await store.adminBan(u) } } label: { Label("Ban", systemImage: "nosign") }
                }
                Button { Task { await store.adminToggleAdmin(u) } } label: {
                    Label(u.isAdmin ? "Remove Admin" : "Make Admin", systemImage: "shield")
                }
                Button { Task { await store.adminLogout(u) } } label: {
                    Label("Force Logout", systemImage: "rectangle.portrait.and.arrow.right")
                }
            } label: {
                Image(systemName: "ellipsis").font(.system(size: 16)).foregroundColor(Theme.ink3).frame(width: 32, height: 32)
            }
        }
        .padding(.horizontal, 16).padding(.vertical, 9)
    }

    private func badge(_ t: String, _ c: Color) -> some View {
        Text(t).font(.zkSans(9, weight: .bold))
            .padding(.horizontal, 4).padding(.vertical, 1)
            .background(c.opacity(0.2)).foregroundColor(c)
            .clipShape(RoundedRectangle(cornerRadius: 3))
    }

    private var guilds: some View {
        VStack(spacing: 0) {
            HStack(spacing: 6) {
                Image(systemName: "magnifyingglass").font(.system(size: 13)).foregroundColor(Theme.ink3)
                TextField("Search servers", text: $guildSearch)
                    .foregroundColor(Theme.ink1)
                    .autocorrectionDisabled()
                    .onSubmit { Task { await store.loadAdminGuilds(q: guildSearch) } }
            }
            .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            .padding(.horizontal, 12).padding(.bottom, 8)

            if store.loadingAdminGuilds && store.adminGuilds.isEmpty {
                Spacer(); ProgressView().tint(Theme.accent); Spacer()
            } else if store.adminGuilds.isEmpty {
                Spacer()
                Text("No servers found.").font(.zkSans(14)).foregroundColor(Theme.ink3)
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 0) {
                        ForEach(store.adminGuilds) { g in
                            guildRow(g)
                            Rectangle().fill(Theme.line).frame(height: 1)
                        }
                    }
                }
            }
        }
        .task { if store.adminGuilds.isEmpty { await store.loadAdminGuilds(q: "") } }
        .confirmationDialog(
            "Delete this server?",
            isPresented: Binding(get: { deletingGuild != nil }, set: { if !$0 { deletingGuild = nil } }),
            titleVisibility: .visible
        ) {
            Button("Delete Server", role: .destructive) {
                if let g = deletingGuild { Task { await store.adminDeleteGuild(g) } }
                deletingGuild = nil
            }
            Button("Cancel", role: .cancel) { deletingGuild = nil }
        } message: {
            Text("This force-deletes \(deletingGuild?.name ?? "the server") and all of its data.")
        }
    }

    private func guildRow(_ g: AdminGuild) -> some View {
        HStack(spacing: 10) {
            Avatar(url: g.iconUrl, name: g.name, size: 36, ringColor: Theme.bg1)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(g.name).font(.zkSans(15, weight: .medium)).foregroundColor(Theme.ink1).lineLimit(1)
                    if g.discoverable == true { badge("PUBLIC", Theme.accent2) }
                }
                Text("\(g.memberCount ?? 0) members").font(.zkSans(12)).foregroundColor(Theme.ink3)
            }
            Spacer()
            Button(role: .destructive) { deletingGuild = g } label: {
                Image(systemName: "trash").font(.system(size: 14)).foregroundColor(Theme.danger).frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
        }
        .padding(.horizontal, 16).padding(.vertical, 9)
    }

    private var storage: some View {
        ScrollView {
            if store.loadingAdminStorage && store.adminStorage == nil {
                ProgressView().tint(Theme.accent).padding(.top, 40)
            } else if let s = store.adminStorage {
                VStack(spacing: 12) {
                    statRow("On-disk total", byteStr(s.onDisk.totalBytes), detail: "\(s.onDisk.totalCount) files")
                    statRow("Unused", byteStr(s.onDisk.unusedBytes), detail: "\(s.onDisk.unusedCount) files")
                    statRow("Attachments", byteStr(s.attachments.totalBytes ?? 0), detail: "\(s.attachments.count) files")
                    statRow("Avatars", "\(s.avatars.count)", detail: nil)
                    statRow("Banners", "\(s.banners.count)", detail: nil)
                    statRow("Emojis", "\(s.emojis.count)", detail: nil)
                    statRow("Stickers", "\(s.stickers.count)", detail: nil)
                    if let r = store.storageGcResult {
                        Text(r).font(.zkSans(12)).foregroundColor(Theme.online)
                    }
                    Button { Task { await store.runStorageGc() } } label: {
                        Text("Run garbage collection")
                            .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                            .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .padding(.top, 4)
                    Button { showStorageItems = true } label: {
                        Text("Browse files")
                            .font(.zkSans(15, weight: .semibold)).foregroundColor(Theme.ink1)
                            .frame(maxWidth: .infinity).padding(.vertical, 11)
                            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                }
                .padding(16)
            } else {
                VStack(spacing: 8) {
                    Image(systemName: "internaldrive").font(.system(size: 30)).foregroundColor(Theme.ink3)
                    Text("Storage stats unavailable").font(.system(size: 14)).foregroundColor(Theme.ink3)
                }
                .padding(.top, 40)
            }
        }
        .task { if store.adminStorage == nil { await store.loadAdminStorage() } }
    }

    private func byteStr(_ bytes: Int) -> String {
        let b = Double(bytes)
        if b >= 1_073_741_824 { return String(format: "%.1f GB", b / 1_073_741_824) }
        if b >= 1_048_576 { return String(format: "%.1f MB", b / 1_048_576) }
        if b >= 1024 { return String(format: "%.0f KB", b / 1024) }
        return "\(bytes) B"
    }

    private func statRow(_ label: String, _ value: String, detail: String?) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 2) {
                Text(label).font(.zkSans(13)).foregroundColor(Theme.ink3)
                if let detail { Text(detail).font(.zkSans(11)).foregroundColor(Theme.ink4) }
            }
            Spacer()
            Text(value).font(.zkSans(22, weight: .bold)).foregroundColor(Theme.ink1)
        }
        .padding(16)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

// MARK: Parental controls (family)

struct FamilyView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var childUsername = ""
    @State private var managingChild: FamilyUser?

    private enum RowAction { case accept, remove }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 20) {
                    if store.loadingFamily && store.family == nil {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 30)
                    } else {
                        if let r = store.family?.restrictions { restrictionsCard(r) }
                        linkChildSection
                        if let f = store.family {
                            if !f.incomingRequests.isEmpty {
                                section("REQUESTS TO ACCEPT", users: f.incomingRequests, action: .accept)
                            }
                            if !f.supervisedBy.isEmpty {
                                section("SUPERVISED BY", users: f.supervisedBy, action: .remove)
                            }
                            if !f.children.isEmpty {
                                section("CHILDREN YOU SUPERVISE", users: f.children, action: .remove,
                                        manage: { managingChild = $0 })
                            }
                            if !f.outgoingRequests.isEmpty {
                                section("PENDING REQUESTS", users: f.outgoingRequests, action: .remove)
                            }
                        }
                    }
                }
                .padding(16)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Parental Controls").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadFamily() }
            .sheet(item: $managingChild) { ChildControlsView(child: $0) }
        }
    }

    private var linkChildSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("SUPERVISE A CHILD ACCOUNT")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            HStack(spacing: 8) {
                TextField("child's username", text: $childUsername)
                    .textFieldStyle(.plain).autocorrectionDisabled().textInputAutocapitalization(.never)
                    .foregroundColor(Theme.ink1).padding(10)
                    .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                Button {
                    Task { await store.familyRequestLink(username: childUsername); childUsername = "" }
                } label: {
                    Text("Request")
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                }
                .disabled(childUsername.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
    }

    private func section(_ title: String, users: [FamilyUser], action: RowAction,
                         manage: ((FamilyUser) -> Void)? = nil) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            ForEach(users) { u in
                HStack(spacing: 10) {
                    Avatar(url: u.avatarUrl, name: u.name, size: 36)
                    Text(u.name).font(.zkSans(15)).foregroundColor(Theme.ink1)
                    Spacer()
                    if action == .accept {
                        Button { Task { await store.familyAccept(u) } } label: {
                            Text("Accept").font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.online)
                        }
                        Button { Task { await store.familyRemove(u) } } label: {
                            Image(systemName: "xmark").font(.system(size: 13)).foregroundColor(Theme.ink3)
                        }
                    } else {
                        Button { Task { await store.familyRemove(u) } } label: {
                            Text("Remove").font(.zkSans(13)).foregroundColor(Theme.danger)
                        }
                    }
                    if manage != nil {
                        Image(systemName: "chevron.right")
                            .font(.system(size: 12, weight: .semibold)).foregroundColor(Theme.ink4)
                    }
                }
                .contentShape(Rectangle())
                .onTapGesture { manage?(u) }
            }
        }
    }

    private func restrictionsCard(_ r: ChildRestrictions) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("YOUR ACCOUNT IS SUPERVISED")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.accent3)
            VStack(alignment: .leading, spacing: 4) {
                restriction("Add friends", r.canAddFriends)
                restriction("Remove friends", r.canRemoveFriends)
                restriction("Voice", r.allowVoice)
                restriction("Video", r.allowVideo)
                restriction("Streaming", r.allowStream)
                restriction("Create servers", r.allowCreateGuild)
            }
            .padding(14)
            .background(Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private func restriction(_ label: String, _ allowed: Bool) -> some View {
        HStack {
            Image(systemName: allowed ? "checkmark.circle.fill" : "xmark.circle.fill")
                .font(.system(size: 13)).foregroundColor(allowed ? Theme.online : Theme.ink4)
            Text(label).font(.zkSans(13)).foregroundColor(Theme.ink2)
            Spacer()
        }
    }
}

/// A parent's controls for one supervised child — toggles each restriction
/// and PATCHes it immediately. Mirrors the web child-restrictions panel.
struct ChildControlsView: View {
    let child: FamilyUser
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            Group {
                if store.childRestrictions[child.id] == nil {
                    ProgressView().tint(Theme.accent)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        VStack(spacing: 10) {
                            Text("WHAT \(child.name.uppercased()) CAN DO")
                                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                            VStack(spacing: 0) {
                                toggleRow("Add friends", \.canAddFriends)
                                rowDivider
                                toggleRow("Remove friends", \.canRemoveFriends)
                                rowDivider
                                toggleRow("Join voice channels", \.allowVoice)
                                rowDivider
                                toggleRow("Use video", \.allowVideo)
                                rowDivider
                                toggleRow("Stream", \.allowStream)
                                rowDivider
                                toggleRow("Create servers", \.allowCreateGuild)
                            }
                            .background(Theme.bg2)
                            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))

                            Text("Changes apply to \(child.name)'s account immediately.")
                                .font(.zkSans(12)).foregroundColor(Theme.ink3)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .padding(16)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(child.name).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadChildRestrictions(child.id) }
        }
    }

    private var rowDivider: some View {
        Rectangle().fill(Theme.line).frame(height: 1).padding(.leading, 14)
    }

    private func toggleRow(_ label: String, _ kp: WritableKeyPath<ChildRestrictions, Bool>) -> some View {
        HStack {
            Text(label).font(.zkSans(15)).foregroundColor(Theme.ink1)
            Spacer()
            Toggle("", isOn: binding(kp)).labelsHidden().tint(Theme.accent)
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
    }

    private func binding(_ kp: WritableKeyPath<ChildRestrictions, Bool>) -> Binding<Bool> {
        Binding(
            get: { store.childRestrictions[child.id]?[keyPath: kp] ?? false },
            set: { newVal in
                guard var r = store.childRestrictions[child.id] else { return }
                r[keyPath: kp] = newVal
                Task { await store.setChildRestrictions(child.id, r) }
            }
        )
    }
}

// MARK: - Channel management sheets

/// Create a channel or category. Mirrors the web ChannelCreateModal:
/// type picker, Discord-style name normalization, optional parent category,
/// and a link URL for guild_link channels.
struct CreateChannelSheet: View {
    let categories: [Channel]
    /// When set, pre-scopes the new channel to this category (web's
    /// per-category "+" affordance).
    var initialParentId: String? = nil
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var type = "guild_text"
    @State private var parentId: String?
    @State private var linkUrl = ""
    @State private var error: String?
    @State private var busy = false

    private let types: [(String, String, String)] = [
        ("guild_text", "Text", "number"),
        ("guild_voice", "Voice", "speaker.wave.2.fill"),
        ("guild_stage", "Stage", "person.wave.2.fill"),
        ("guild_forum", "Forum", "list.bullet.rectangle"),
        ("guild_link", "Link", "link"),
        ("guild_category", "Category", "folder"),
    ]
    private var isCategory: Bool { type == "guild_category" }
    private var isLink: Bool { type == "guild_link" }

    private var normalizedName: String {
        if isCategory { return name.trimmingCharacters(in: .whitespacesAndNewlines) }
        return name.lowercased()
            .trimmingCharacters(in: .whitespaces)
            .replacingOccurrences(of: " ", with: "-")
    }
    private var canCreate: Bool {
        !normalizedName.isEmpty &&
        (!isLink || !linkUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("CHANNEL TYPE").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 8) {
                            ForEach(types, id: \.0) { t in
                                Button { type = t.0 } label: {
                                    HStack(spacing: 8) {
                                        Image(systemName: t.2).font(.system(size: 14))
                                        Text(t.1).font(.system(size: 14, weight: .medium))
                                        Spacer()
                                    }
                                    .padding(.horizontal, 12).padding(.vertical, 10)
                                    .background(type == t.0 ? Theme.accent.opacity(0.2) : Theme.bg2)
                                    .foregroundColor(type == t.0 ? Theme.accent : Theme.ink2)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                                    .overlay(RoundedRectangle(cornerRadius: 10)
                                        .strokeBorder(type == t.0 ? Theme.accent : Color.clear, lineWidth: 1))
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    VStack(alignment: .leading, spacing: 6) {
                        Text(isCategory ? "CATEGORY NAME" : "CHANNEL NAME")
                            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        HStack(spacing: 6) {
                            if !isCategory { Text("#").foregroundColor(Theme.ink3) }
                            TextField(isCategory ? "New Category" : "new-channel", text: $name)
                                .foregroundColor(Theme.ink1)
                                .autocorrectionDisabled()
                        }
                        .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    if isLink {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("LINK URL").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            TextField("https://…", text: $linkUrl)
                                .foregroundColor(Theme.ink1)
                                .autocorrectionDisabled()
                                .textInputAutocapitalization(.never)
                                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }

                    if !isCategory && !categories.isEmpty {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("CATEGORY").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            Menu {
                                Button("None") { parentId = nil }
                                ForEach(categories) { c in
                                    Button(c.name ?? "Category") { parentId = c.id }
                                }
                            } label: {
                                HStack {
                                    Text(parentId.flatMap { id in categories.first(where: { $0.id == id })?.name } ?? "None")
                                        .foregroundColor(Theme.ink1)
                                    Spacer()
                                    Image(systemName: "chevron.up.chevron.down")
                                        .font(.system(size: 12)).foregroundColor(Theme.ink3)
                                }
                                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                        }
                    }

                    if let error {
                        Text(error).font(.zkSans(13)).foregroundColor(Theme.danger)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Create Channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Create") { create() }.disabled(!canCreate || busy)
                }
            }
            .onAppear { if parentId == nil { parentId = initialParentId } }
        }
    }

    private func create() {
        busy = true; error = nil
        Task {
            let err = await store.createChannel(
                type: type, name: normalizedName,
                parentId: isCategory ? nil : parentId,
                topic: nil,
                linkUrl: isLink ? linkUrl.trimmingCharacters(in: .whitespacesAndNewlines) : nil
            )
            busy = false
            if let err { error = err } else { dismiss() }
        }
    }
}

/// Edit a channel/category: rename, topic, and move between categories.
struct EditChannelSheet: View {
    let channel: Channel
    let categories: [Channel]
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var topic = ""
    @State private var parentId: String?
    @State private var slowmode = 0
    @State private var showWebhooks = false
    @State private var showPermissions = false
    @State private var error: String?
    @State private var busy = false

    private let slowModes: [(String, Int)] = [
        ("Off", 0), ("5s", 5), ("10s", 10), ("15s", 15), ("30s", 30),
        ("1 min", 60), ("5 min", 300), ("15 min", 900), ("1 hour", 3600), ("6 hours", 21600)
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("NAME").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        TextField("name", text: $name)
                            .foregroundColor(Theme.ink1).autocorrectionDisabled()
                            .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    if !channel.isCategory {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("TOPIC").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            TextField("Channel topic", text: $topic, axis: .vertical)
                                .lineLimit(1...4)
                                .foregroundColor(Theme.ink1)
                                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        if !categories.isEmpty {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("CATEGORY").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                                Menu {
                                    Button("None") { parentId = nil }
                                    ForEach(categories) { c in
                                        Button(c.name ?? "Category") { parentId = c.id }
                                    }
                                } label: {
                                    HStack {
                                        Text(parentId.flatMap { id in categories.first(where: { $0.id == id })?.name } ?? "None")
                                            .foregroundColor(Theme.ink1)
                                        Spacer()
                                        Image(systemName: "chevron.up.chevron.down")
                                            .font(.system(size: 12)).foregroundColor(Theme.ink3)
                                    }
                                    .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                                }
                            }
                        }
                        if channel.isText {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("SLOWMODE").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                                Menu {
                                    ForEach(slowModes, id: \.1) { opt in
                                        Button(opt.0) { slowmode = opt.1 }
                                    }
                                } label: {
                                    HStack {
                                        Text(slowModes.first(where: { $0.1 == slowmode })?.0 ?? "Off")
                                            .foregroundColor(Theme.ink1)
                                        Spacer()
                                        Image(systemName: "chevron.up.chevron.down")
                                            .font(.system(size: 12)).foregroundColor(Theme.ink3)
                                    }
                                    .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                                }
                            }
                        }
                        if channel.isText && store.canManageWebhooks {
                            Button { showWebhooks = true } label: {
                                HStack(spacing: 10) {
                                    Image(systemName: "link").font(.system(size: 14)).foregroundColor(Theme.ink3).frame(width: 20)
                                    Text("Webhooks").font(.system(size: 15)).foregroundColor(Theme.ink1)
                                    Spacer()
                                    Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
                                }
                                .padding(.horizontal, 12).padding(.vertical, 12)
                                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                        }
                    }
                    if store.canManageRoles {
                        Button { showPermissions = true } label: {
                            HStack(spacing: 10) {
                                Image(systemName: "lock.shield").font(.system(size: 14)).foregroundColor(Theme.ink3).frame(width: 20)
                                Text("Permissions").font(.system(size: 15)).foregroundColor(Theme.ink1)
                                Spacer()
                                Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 12)
                            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .buttonStyle(.plain)
                    }
                    if let error {
                        Text(error).font(.zkSans(13)).foregroundColor(Theme.danger)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(channel.isCategory ? "Edit Category" : "Edit Channel")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                }
            }
            .onAppear {
                name = channel.name ?? ""
                topic = channel.topic ?? ""
                parentId = channel.parentId
                slowmode = channel.rateLimitPerUser ?? 0
            }
            .sheet(isPresented: $showWebhooks) {
                ChannelWebhooksView(channel: channel)
            }
            .sheet(isPresented: $showPermissions) {
                ChannelPermissionsView(channel: channel)
            }
        }
    }

    private func save() {
        busy = true; error = nil
        let finalName = channel.isCategory
            ? name.trimmingCharacters(in: .whitespacesAndNewlines)
            : name.lowercased().trimmingCharacters(in: .whitespaces).replacingOccurrences(of: " ", with: "-")
        Task {
            let err = await store.editChannel(channel, name: finalName, topic: topic, parentId: parentId, rateLimitPerUser: channel.isCategory ? nil : slowmode)
            busy = false
            if let err { error = err } else { dismiss() }
        }
    }
}

// MARK: - Roles management

/// Lists the guild's roles (highest first), with create/edit/delete.
/// @everyone is hidden for now (its permissions land with the perms batch).
struct RolesListView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var editingRole: Role?
    @State private var creatingRole = false

    private var displayRoles: [Role] {
        store.roles
            .filter { $0.id != store.selectedGuild?.id }
            .sorted { $0.position > $1.position }
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 0) {
                    if displayRoles.isEmpty {
                        Text("No roles yet. Tap + to create one.")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    }
                    ForEach(displayRoles) { role in
                        Button { editingRole = role } label: { roleRow(role) }
                            .buttonStyle(.plain)
                        Rectangle().fill(Theme.line).frame(height: 1)
                    }
                }
                .padding(.vertical, 4)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Roles")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button { creatingRole = true } label: { Image(systemName: "plus") }
                }
            }
            .sheet(isPresented: $creatingRole) { RoleEditSheet(role: nil) }
            .sheet(item: $editingRole) { RoleEditSheet(role: $0) }
        }
    }

    private func roleRow(_ role: Role) -> some View {
        HStack(spacing: 10) {
            Circle().fill(store.roleColor(role) ?? Theme.ink4).frame(width: 14, height: 14)
            Text(role.name)
                .font(.zkSans(15, weight: .medium))
                .foregroundColor(store.roleColor(role) ?? Theme.ink1)
            if role.hoist {
                Image(systemName: "rectangle.split.1x2")
                    .font(.system(size: 10)).foregroundColor(Theme.ink3)
            }
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
        }
        .padding(.horizontal, 16).padding(.vertical, 11)
        .contentShape(Rectangle())
    }
}

/// Create or edit a role: name, color (preset palette), hoist, mentionable.
struct RoleEditSheet: View {
    let role: Role?
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var colorRGB = 0
    @State private var hoist = false
    @State private var mentionable = false
    @State private var selfAssignable = false
    @State private var permBits: UInt64 = 0
    @State private var error: String?
    @State private var busy = false

    private let palette: [Int] = [
        0x000000,
        0x1ABC9C, 0x2ECC71, 0x3498DB, 0x9B59B6, 0xE91E63,
        0xF1C40F, 0xE67E22, 0xE74C3C, 0x95A5A6, 0x607D8B,
        0x11806A, 0x1F8B4C, 0x206694, 0x71368A, 0xAD1457,
        0x3DD7EC, 0x9D7BFF, 0xEC5FB5, 0xFF5C5C,
    ]
    private var isEdit: Bool { role != nil }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("ROLE NAME").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        TextField("new role", text: $name)
                            .foregroundColor(Theme.ink1)
                            .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        Text("COLOR").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 6), spacing: 10) {
                            ForEach(palette, id: \.self) { c in
                                Button { colorRGB = c } label: {
                                    ZStack {
                                        Circle()
                                            .fill(c == 0 ? Theme.bg3 : Color(hex: UInt32(c)))
                                            .frame(width: 34, height: 34)
                                        if c == 0 {
                                            Image(systemName: "nosign").font(.system(size: 12)).foregroundColor(Theme.ink3)
                                        }
                                        if colorRGB == c {
                                            Circle().strokeBorder(Color.white, lineWidth: 2).frame(width: 38, height: 38)
                                        }
                                    }
                                    .frame(height: 40)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }

                    Toggle(isOn: $hoist) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text("Display separately").font(.zkSans(15)).foregroundColor(Theme.ink1)
                            Text("Show members with this role in their own sidebar group")
                                .font(.zkSans(12)).foregroundColor(Theme.ink3)
                        }
                    }.tint(Theme.accent)

                    Toggle(isOn: $mentionable) {
                        Text("Allow anyone to @mention this role")
                            .font(.zkSans(15)).foregroundColor(Theme.ink1)
                    }.tint(Theme.accent)

                    if isEdit {
                        Toggle(isOn: $selfAssignable) {
                            VStack(alignment: .leading, spacing: 2) {
                                Text("Self-assignable").font(.zkSans(15)).foregroundColor(Theme.ink1)
                                Text("Let members claim this role themselves from Get Roles")
                                    .font(.zkSans(12)).foregroundColor(Theme.ink3)
                            }
                        }.tint(Theme.accent)
                    }

                    VStack(alignment: .leading, spacing: 4) {
                        Text("PERMISSIONS").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        ForEach(Permissions.groupOrder, id: \.self) { group in
                            Text(group.uppercased())
                                .font(.zkSans(11, weight: .semibold))
                                .foregroundColor(Theme.ink4)
                                .padding(.top, 10)
                            ForEach(Permissions.all.filter { $0.group == group }) { p in
                                Toggle(isOn: permBinding(p.bit)) {
                                    Text(p.label).font(.zkSans(14)).foregroundColor(Theme.ink1)
                                }
                                .tint(Theme.accent)
                                .padding(.vertical, 1)
                            }
                        }
                    }

                    if isEdit, let r = role {
                        Button(role: .destructive) {
                            Task { await store.deleteRole(r); dismiss() }
                        } label: {
                            Label("Delete Role", systemImage: "trash")
                                .font(.zkSans(15, weight: .medium))
                                .foregroundColor(Theme.danger)
                        }
                        .padding(.top, 4)
                    }

                    if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(isEdit ? "Edit Role" : "Create Role")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { save() }
                        .disabled(name.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || busy)
                }
            }
            .onAppear {
                if let r = role {
                    name = r.name; colorRGB = r.color; hoist = r.hoist
                    mentionable = r.mentionable ?? false
                    selfAssignable = r.selfAssignable ?? false
                    permBits = Permissions.parse(r.permissions)
                }
            }
        }
    }

    private func permBinding(_ bit: Int) -> Binding<Bool> {
        Binding(
            get: { Permissions.has(permBits, bit) },
            set: { on in
                if on { permBits |= Permissions.mask(bit) }
                else { permBits &= ~Permissions.mask(bit) }
            }
        )
    }

    private func save() {
        busy = true; error = nil
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let err: String?
            if let r = role {
                err = await store.editRole(r, name: n, color: colorRGB, hoist: hoist, mentionable: mentionable, selfAssignable: selfAssignable, permissions: Permissions.serialize(permBits))
            } else {
                err = await store.createRole(name: n, color: colorRGB, hoist: hoist, mentionable: mentionable, permissions: Permissions.serialize(permBits))
            }
            busy = false
            if let err { error = err } else { dismiss() }
        }
    }
}

// MARK: - Guild (server) settings

/// Server settings, mirroring the web GuildSettingsModal's core tabs:
/// Overview (name/description), Roles, Members, Invites, and a Danger
/// zone. Overview is read-only for non-managers; everyone can leave.
struct GuildSettingsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var name = ""
    @State private var guildDescription = ""
    @State private var guildRules = ""
    @State private var saveError: String?
    @State private var saving = false

    @State private var showRoles = false
    @State private var showMembers = false
    @State private var showInvite = false
    @State private var showGetRoles = false
    @State private var showEvents = false
    @State private var showReactionRoles = false
    @State private var showEmojiMgr = false
    @State private var showStickerMgr = false
    @State private var confirmDelete = false
    @State private var confirmLeave = false

    private var isOwner: Bool { store.isGuildOwner }
    private var isAdmin: Bool { store.canManageGuild }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    overviewSection
                    getRolesSection
                    if isAdmin { managementSection }
                    dangerSection
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Server Settings")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .onAppear {
                name = store.selectedGuild?.name ?? ""
                guildDescription = store.selectedGuild?.description ?? ""
                guildRules = store.selectedGuild?.rulesContent ?? ""
            }
            .sheet(isPresented: $showRoles) { RolesListView() }
            .sheet(isPresented: $showMembers) { MemberListView() }
            .sheet(isPresented: $showInvite) { CreateInviteSheet() }
            .sheet(isPresented: $showGetRoles) { BrowseRolesView() }
            .sheet(isPresented: $showEvents) { EventsView() }
            .sheet(isPresented: $showReactionRoles) { ReactionRolesView() }
            .sheet(isPresented: $showEmojiMgr) { EmojiManagerView() }
            .sheet(isPresented: $showStickerMgr) { StickerManagerView() }
            .confirmationDialog("Delete this server?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete Server", role: .destructive) {
                    Task { await store.deleteSelectedGuild(); dismiss() }
                }
                Button("Cancel", role: .cancel) {}
            } message: { Text("This permanently deletes the server, its channels, and all messages.") }
            .confirmationDialog("Leave this server?", isPresented: $confirmLeave, titleVisibility: .visible) {
                Button("Leave Server", role: .destructive) {
                    Task { await store.leaveSelectedGuild(); dismiss() }
                }
                Button("Cancel", role: .cancel) {}
            }
        }
    }

    private func sectionHeader(_ t: String) -> some View {
        Text(t).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
    }

    private var overviewSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("OVERVIEW")
            HStack(spacing: 12) {
                Avatar(url: store.selectedGuild?.iconUrl, name: name.isEmpty ? "S" : name, size: 56, ringColor: Theme.bg1)
                VStack(alignment: .leading, spacing: 4) {
                    Text("Server Name").font(.zkSans(11, weight: .semibold)).foregroundColor(Theme.ink4)
                    TextField("Server name", text: $name)
                        .foregroundColor(Theme.ink1)
                        .disabled(!isAdmin)
                        .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            VStack(alignment: .leading, spacing: 4) {
                Text("Description").font(.zkSans(11, weight: .semibold)).foregroundColor(Theme.ink4)
                TextField("What's this server about?", text: $guildDescription, axis: .vertical)
                    .lineLimit(2...5)
                    .foregroundColor(Theme.ink1)
                    .disabled(!isAdmin)
                    .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            if isAdmin {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Rules").font(.zkSans(11, weight: .semibold)).foregroundColor(Theme.ink4)
                    TextField("New members must agree before participating (leave blank for none)", text: $guildRules, axis: .vertical)
                        .lineLimit(3...8)
                        .foregroundColor(Theme.ink1)
                        .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            if isAdmin {
                Button { save() } label: {
                    Text(saving ? "Saving…" : "Save Changes")
                        .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(saving || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let saveError { Text(saveError).font(.zkSans(13)).foregroundColor(Theme.danger) }
        }
    }

    private var managementSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("MANAGEMENT")
            settingsRow("Roles", icon: "shield.lefthalf.filled") { showRoles = true }
            settingsRow("Reaction Roles", icon: "wand.and.stars") { showReactionRoles = true }
            if store.canManageEmojis {
                settingsRow("Emoji", icon: "face.smiling") { showEmojiMgr = true }
                settingsRow("Stickers", icon: "rectangle.stack.fill") { showStickerMgr = true }
            }
            settingsRow("Members", icon: "person.2.fill") { showMembers = true }
            settingsRow("Create Invite", icon: "person.badge.plus") { showInvite = true }
        }
    }

    private var getRolesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("COMMUNITY")
            settingsRow("Events", icon: "calendar") { showEvents = true }
            settingsRow("Get Roles", icon: "checkmark.seal.fill") { showGetRoles = true }
        }
    }

    private var dangerSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("DANGER ZONE")
            if isOwner {
                Button(role: .destructive) { confirmDelete = true } label: {
                    settingsRowLabel("Delete Server", icon: "trash", tint: Theme.danger)
                }
                .buttonStyle(.plain)
            } else {
                Button(role: .destructive) { confirmLeave = true } label: {
                    settingsRowLabel("Leave Server", icon: "rectangle.portrait.and.arrow.right", tint: Theme.danger)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private func settingsRow(_ title: String, icon: String, _ action: @escaping () -> Void) -> some View {
        Button(action: action) { settingsRowLabel(title, icon: icon, tint: Theme.ink1) }
            .buttonStyle(.plain)
    }
    private func settingsRowLabel(_ title: String, icon: String, tint: Color) -> some View {
        HStack(spacing: 12) {
            Image(systemName: icon).font(.system(size: 15)).foregroundColor(tint == Theme.danger ? Theme.danger : Theme.ink3).frame(width: 22)
            Text(title).font(.system(size: 15)).foregroundColor(tint)
            Spacer()
            Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
        }
        .padding(.horizontal, 12).padding(.vertical, 12)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func save() {
        saving = true; saveError = nil
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let err = await store.editGuild(name: n, description: guildDescription, rulesContent: isAdmin ? guildRules : nil)
            saving = false
            if let err { saveError = err }
        }
    }
}

/// Generate a server invite for a chosen channel, with copyable code.
struct CreateInviteSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var channelId: String?
    @State private var maxUsesText = ""
    @State private var ttlIndex = 2
    @State private var createdCode: String?
    @State private var error: String?
    @State private var busy = false

    private let ttlOptions: [(String, Int?)] = [
        ("30 minutes", 1800), ("1 hour", 3600), ("6 hours", 21600),
        ("1 day", 86400), ("7 days", 604800), ("Never", nil)
    ]
    private var textChannels: [Channel] { store.channels.filter { $0.isText } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if let code = createdCode {
                        VStack(alignment: .leading, spacing: 8) {
                            Text("INVITE CODE").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            HStack {
                                Text(code)
                                    .font(.zkMono(20, weight: .bold))
                                    .foregroundColor(Theme.ink1)
                                Spacer()
                                Button { UIPasteboard.general.string = code } label: {
                                    Image(systemName: "doc.on.doc").font(.system(size: 16)).foregroundColor(Theme.accent)
                                }
                            }
                            .padding(14).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                            Button { UIPasteboard.general.string = "https://zekktris.com/invite/\(code)" } label: {
                                Text("Copy invite link").font(.zkSans(14, weight: .medium)).foregroundColor(Theme.accent)
                            }
                            if let qr = qrCodeImage("https://zekktris.com/invite/\(code)") {
                                Image(uiImage: qr)
                                    .interpolation(.none)
                                    .resizable()
                                    .frame(width: 180, height: 180)
                                    .padding(10)
                                    .background(Color.white)
                                    .clipShape(RoundedRectangle(cornerRadius: 12))
                                    .frame(maxWidth: .infinity)
                                Text("Scan to join").font(.zkSans(12)).foregroundColor(Theme.ink4)
                                    .frame(maxWidth: .infinity)
                            }
                        }
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("CHANNEL").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            Menu {
                                ForEach(textChannels) { c in
                                    Button("#\(c.name ?? "channel")") { channelId = c.id }
                                }
                            } label: {
                                HStack {
                                    Text("#\(textChannels.first(where: { $0.id == channelId })?.name ?? (textChannels.first?.name ?? "channel"))")
                                        .foregroundColor(Theme.ink1)
                                    Spacer()
                                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundColor(Theme.ink3)
                                }
                                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("EXPIRE AFTER").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            Menu {
                                ForEach(Array(ttlOptions.enumerated()), id: \.offset) { idx, opt in
                                    Button(opt.0) { ttlIndex = idx }
                                }
                            } label: {
                                HStack {
                                    Text(ttlOptions[ttlIndex].0).foregroundColor(Theme.ink1)
                                    Spacer()
                                    Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundColor(Theme.ink3)
                                }
                                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("MAX USES (blank = unlimited)").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            TextField("Unlimited", text: $maxUsesText)
                                .keyboardType(.numberPad)
                                .foregroundColor(Theme.ink1)
                                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }
                    if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Invite People")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                if createdCode == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Create") { create() }.disabled(busy || effectiveChannelId == nil)
                    }
                }
            }
            .onAppear { if channelId == nil { channelId = textChannels.first?.id } }
        }
    }

    private var effectiveChannelId: String? { channelId ?? textChannels.first?.id }

    private func create() {
        guard let cid = effectiveChannelId,
              let channel = textChannels.first(where: { $0.id == cid }) else { return }
        busy = true; error = nil
        let maxUses = Int(maxUsesText.trimmingCharacters(in: .whitespaces))
        let ttl = ttlOptions[ttlIndex].1
        Task {
            if let inv = await store.createInvite(channel: channel, maxUses: maxUses, ttlSeconds: ttl) {
                createdCode = inv.code
            } else {
                error = "Couldn't create invite."
            }
            busy = false
        }
    }
}

// MARK: - Change password

struct ChangePasswordSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var current = ""
    @State private var newPass = ""
    @State private var confirm = ""
    @State private var error: String?
    @State private var busy = false
    @State private var done = false

    private var canSubmit: Bool {
        !current.isEmpty && newPass.count >= 8 && newPass == confirm
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    field("Current password", text: $current)
                    field("New password", text: $newPass)
                    field("Confirm new password", text: $confirm)
                    if !newPass.isEmpty && newPass.count < 8 {
                        Text("Must be at least 8 characters.")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    }
                    if !confirm.isEmpty && newPass != confirm {
                        Text("Passwords don't match.")
                            .font(.zkSans(12)).foregroundColor(Theme.danger)
                    }
                    if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
                    if done { Text("Password updated.").font(.zkSans(13)).foregroundColor(Theme.online) }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Change Password")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Update") { submit() }.disabled(!canSubmit || busy)
                }
            }
        }
    }

    private func field(_ title: String, text: Binding<String>) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title.uppercased()).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            SecureField(title, text: text)
                .foregroundColor(Theme.ink1)
                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private func submit() {
        busy = true; error = nil; done = false
        Task {
            let err = await session.changePassword(current: current, new: newPass)
            busy = false
            if let err { error = err }
            else { done = true; current = ""; newPass = ""; confirm = "" }
        }
    }
}

// MARK: - Channel webhooks

/// Manage a text channel's incoming webhooks: list, create (name → returns
/// a secret URL), copy, and delete. Mirrors the web ChannelWebhooksTab.
struct ChannelWebhooksView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel

    @State private var newName = ""
    @State private var creating = false
    @State private var deleting: Webhook?

    private func url(_ wh: Webhook) -> String {
        "\(Config.assetOrigin)/api/webhooks/\(wh.id)/\(wh.token)"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("NEW WEBHOOK").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        HStack(spacing: 8) {
                            TextField("Name (e.g. GitHub)", text: $newName)
                                .foregroundColor(Theme.ink1)
                                .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                            Button { create() } label: {
                                Text("Create").font(.zkSans(14, weight: .semibold)).foregroundColor(.white)
                                    .padding(.horizontal, 14).padding(.vertical, 10)
                                    .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .disabled(creating || newName.trimmingCharacters(in: .whitespaces).isEmpty)
                        }
                    }

                    if store.loadingWebhooks && store.channelWebhooks.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 20)
                    } else if store.channelWebhooks.isEmpty {
                        Text("No webhooks yet. Create one to post messages into #\(channel.name ?? "channel") from external services.")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    } else {
                        VStack(spacing: 8) {
                            ForEach(store.channelWebhooks) { wh in webhookRow(wh) }
                        }
                    }
                    Text("Anyone with a webhook URL can post to this channel. Treat it like a password.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Webhooks").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadWebhooks(channel.id) }
            .confirmationDialog(
                "Delete webhook?",
                isPresented: Binding(get: { deleting != nil }, set: { if !$0 { deleting = nil } }),
                titleVisibility: .visible
            ) {
                Button("Delete", role: .destructive) {
                    if let wh = deleting { Task { await store.deleteWebhook(wh) } }
                    deleting = nil
                }
                Button("Cancel", role: .cancel) { deleting = nil }
            }
        }
    }

    private func webhookRow(_ wh: Webhook) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Image(systemName: "link.circle.fill").font(.system(size: 18)).foregroundColor(Theme.accent)
                Text(wh.name).font(.system(size: 15, weight: .medium)).foregroundColor(Theme.ink1).lineLimit(1)
                Spacer()
                Button(role: .destructive) { deleting = wh } label: {
                    Image(systemName: "trash").font(.system(size: 13)).foregroundColor(Theme.danger)
                }
                .buttonStyle(.plain)
            }
            HStack(spacing: 6) {
                Text(url(wh))
                    .font(.zkMono(11))
                    .foregroundColor(Theme.ink3)
                    .lineLimit(1).truncationMode(.middle)
                Spacer()
                Button { UIPasteboard.general.string = url(wh) } label: {
                    Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundColor(Theme.accent)
                }
            }
            .padding(8).background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func create() {
        creating = true
        let name = newName.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            _ = await store.createWebhook(channelId: channel.id, name: name)
            creating = false
            newName = ""
        }
    }
}

// MARK: - Channel permission overrides

private enum ChannelPermTri { case allow, inherit, deny }

/// Per-channel permission overrides: pick a role, then set each permission
/// to Allow / Inherit / Deny. Mirrors the web ChannelPermissionsTab. The
/// allow + deny bitfields layer on top of the role's server-wide perms.
struct ChannelPermissionsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let channel: Channel

    @State private var selectedRoleId: String?
    @State private var allowBits: UInt64 = 0
    @State private var denyBits: UInt64 = 0
    @State private var saving = false
    @State private var error: String?

    private var roles: [Role] { store.roles.sorted { $0.position > $1.position } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("ROLE").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        Menu {
                            ForEach(roles) { r in Button(r.name) { selectRole(r) } }
                        } label: {
                            HStack {
                                Text(roles.first(where: { $0.id == selectedRoleId })?.name ?? "Select a role")
                                    .foregroundColor(selectedRoleId == nil ? Theme.ink3 : Theme.ink1)
                                Spacer()
                                Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundColor(Theme.ink3)
                            }
                            .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }

                    if selectedRoleId == nil {
                        Text("Pick a role to override its permissions for #\(channel.name ?? "this channel"). Allow or deny here takes precedence over the role's server-wide permissions.")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    } else {
                        ForEach(Permissions.groupOrder, id: \.self) { group in
                            permGroup(group)
                        }
                        Button { save() } label: {
                            Text(saving ? "Saving…" : "Save Overrides")
                                .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                                .frame(maxWidth: .infinity).padding(.vertical, 11)
                                .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        .disabled(saving)
                        .padding(.top, 6)
                        if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Permissions").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadChannelOverrides(channel.id) }
        }
    }

    @ViewBuilder
    private func permGroup(_ group: String) -> some View {
        let perms = Permissions.all.filter { $0.group == group }
        if !perms.isEmpty {
            Text(group.uppercased())
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                .padding(.top, 4)
            ForEach(perms) { p in permRow(p) }
        }
    }

    private func permRow(_ p: PermissionDef) -> some View {
        let state = triState(p.bit)
        return HStack(spacing: 8) {
            Text(p.label).font(.zkSans(14)).foregroundColor(Theme.ink1)
            Spacer()
            HStack(spacing: 4) {
                triButton("xmark", active: state == .deny, color: Theme.danger) { setState(p.bit, .deny) }
                triButton("minus", active: state == .inherit, color: Theme.ink3) { setState(p.bit, .inherit) }
                triButton("checkmark", active: state == .allow, color: Theme.online) { setState(p.bit, .allow) }
            }
        }
        .padding(.vertical, 5)
    }

    private func triButton(_ symbol: String, active: Bool, color: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Image(systemName: symbol)
                .font(.system(size: 12, weight: .bold))
                .foregroundColor(active ? .white : Theme.ink3)
                .frame(width: 32, height: 26)
                .background(active ? color : Theme.bg3)
                .clipShape(RoundedRectangle(cornerRadius: 7))
        }
        .buttonStyle(.plain)
    }

    private func triState(_ bit: Int) -> ChannelPermTri {
        if Permissions.has(allowBits, bit) { return .allow }
        if Permissions.has(denyBits, bit) { return .deny }
        return .inherit
    }
    private func setState(_ bit: Int, _ s: ChannelPermTri) {
        switch s {
        case .allow:
            allowBits |= Permissions.mask(bit); denyBits &= ~Permissions.mask(bit)
        case .deny:
            allowBits &= ~Permissions.mask(bit); denyBits |= Permissions.mask(bit)
        case .inherit:
            allowBits &= ~Permissions.mask(bit); denyBits &= ~Permissions.mask(bit)
        }
    }
    private func selectRole(_ r: Role) {
        selectedRoleId = r.id
        if let ov = store.channelOverrides.first(where: { $0.targetId == r.id }) {
            allowBits = Permissions.parse(ov.allow)
            denyBits = Permissions.parse(ov.deny)
        } else {
            allowBits = 0; denyBits = 0
        }
    }
    private func save() {
        guard let rid = selectedRoleId else { return }
        saving = true; error = nil
        Task {
            let err = await store.saveChannelOverride(channelId: channel.id, targetId: rid, allow: allowBits, deny: denyBits)
            saving = false
            if let err { error = err }
        }
    }
}

// MARK: - Get Roles (self-assignable)

/// Member-facing role browser: claim or drop any role an admin flagged
/// self-assignable. Mirrors the web BrowseRolesModal.
struct BrowseRolesView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Claim roles to customize your access and how you appear in this server.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    if store.loadingSelfRoles && store.selfAssignableRoles.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 20)
                    } else if store.selfAssignableRoles.isEmpty {
                        Text("No roles are available to claim right now.")
                            .font(.zkSans(13)).foregroundColor(Theme.ink4).padding(.top, 8)
                    } else {
                        ForEach(store.selfAssignableRoles) { role in roleRow(role) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Get Roles").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadSelfAssignableRoles() }
        }
    }

    private func roleRow(_ role: Role) -> some View {
        let have = store.currentUserId.map { store.memberHasRole($0, role.id) } ?? false
        let dot = role.color == 0 ? Theme.ink3 : Color(hex: UInt32(role.color))
        return Button {
            Task { await store.toggleSelfRole(role) }
        } label: {
            HStack(spacing: 12) {
                Circle().fill(dot).frame(width: 12, height: 12)
                Text(role.name).font(.zkSans(15)).foregroundColor(Theme.ink1)
                Spacer()
                Image(systemName: have ? "checkmark.circle.fill" : "circle")
                    .font(.system(size: 18))
                    .foregroundColor(have ? Theme.accent : Theme.ink4)
            }
            .padding(.horizontal, 12).padding(.vertical, 12)
            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Reaction roles (admin)

/// Admin config: map (message + emoji) → role, so reacting grants the role.
/// Mirrors the web ReactionRolesTab.
struct ReactionRolesView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var messageId = ""
    @State private var emoji = ""
    @State private var channelId: String?
    @State private var roleId: String?
    @State private var busy = false
    @State private var error: String?

    private var textChannels: [Channel] { store.channels.filter { $0.isText } }
    private var roles: [Role] { store.roles.sorted { $0.position > $1.position } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    addForm
                    Divider().overlay(Theme.line)
                    Text("MAPPINGS").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if store.loadingReactionRoles && store.reactionRoles.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 8)
                    } else if store.reactionRoles.isEmpty {
                        Text("No reaction roles yet.").font(.zkSans(13)).foregroundColor(Theme.ink4)
                    } else {
                        ForEach(store.reactionRoles) { m in mappingRow(m) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Reaction Roles").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task {
                await store.loadReactionRoles()
                if store.roles.isEmpty, let g = store.selectedGuild { await store.loadRoles(g) }
            }
        }
    }

    private var addForm: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("ADD MAPPING").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            TextField("Message ID", text: $messageId)
                .keyboardType(.numbersAndPunctuation)
                .autocorrectionDisabled(true)
                .foregroundColor(Theme.ink1)
                .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            Menu {
                ForEach(textChannels) { c in Button("#\(c.name ?? "channel")") { channelId = c.id } }
            } label: {
                pickerLabel(text: textChannels.first(where: { $0.id == channelId }).map { "#\($0.name ?? "channel")" } ?? "Channel")
            }
            TextField("Emoji (😀 or :name:)", text: $emoji)
                .autocorrectionDisabled(true)
                .foregroundColor(Theme.ink1)
                .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            Menu {
                ForEach(roles) { r in Button(r.name) { roleId = r.id } }
            } label: {
                pickerLabel(text: roles.first(where: { $0.id == roleId })?.name ?? "Role")
            }
            Button { add() } label: {
                Text(busy ? "Adding…" : "Add Reaction Role")
                    .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 11)
                    .background(canAdd ? Theme.accent : Theme.ink4)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .disabled(!canAdd || busy)
            if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
        }
    }

    private func pickerLabel(text: String) -> some View {
        HStack {
            Text(text).foregroundColor(text == "Channel" || text == "Role" ? Theme.ink3 : Theme.ink1)
            Spacer()
            Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundColor(Theme.ink3)
        }
        .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func mappingRow(_ m: ReactionRoleMapping) -> some View {
        let roleName = store.roles.first(where: { $0.id == m.roleId })?.name ?? "role"
        let chanName = store.channels.first(where: { $0.id == m.channelId })?.name ?? "channel"
        return HStack(spacing: 10) {
            Text(m.emoji).font(.zkSans(20))
            VStack(alignment: .leading, spacing: 2) {
                Text("@\(roleName)").font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                Text("#\(chanName) · msg \(m.messageId)").font(.zkSans(11)).foregroundColor(Theme.ink3).lineLimit(1)
            }
            Spacer()
            Button(role: .destructive) { Task { await store.deleteReactionRole(m) } } label: {
                Image(systemName: "trash").font(.system(size: 13)).foregroundColor(Theme.danger)
            }
            .buttonStyle(.plain)
        }
        .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private var canAdd: Bool {
        !messageId.trimmingCharacters(in: .whitespaces).isEmpty
            && !emoji.trimmingCharacters(in: .whitespaces).isEmpty
            && channelId != nil && roleId != nil
    }
    private func add() {
        guard let cid = channelId, let rid = roleId else { return }
        busy = true; error = nil
        let mid = messageId.trimmingCharacters(in: .whitespacesAndNewlines)
        let em = emoji.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let err = await store.addReactionRole(messageId: mid, channelId: cid, emoji: em, roleId: rid)
            busy = false
            if let err { error = err } else { messageId = ""; emoji = ""; roleId = nil }
        }
    }
}

// MARK: - Emoji manager (admin)

/// Upload, view, and delete the server's custom emoji. Mirrors the emoji
/// management in the web GuildSettings. Gated on MANAGE_EMOJIS.
struct EmojiManagerView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var pickerItem: PhotosPickerItem?
    @State private var pendingData: Data?
    @State private var pendingFilename = "emoji.png"
    @State private var pendingMime = "image/png"
    @State private var pendingPreview: UIImage?
    @State private var name = ""
    @State private var busy = false
    @State private var error: String?

    private var canUpload: Bool {
        pendingData != nil && name.trimmingCharacters(in: .whitespaces).count >= 2
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    uploadSection
                    Divider().overlay(Theme.line)
                    Text("EMOJI · \(store.guildEmojis.count)")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if store.guildEmojis.isEmpty {
                        Text("No custom emoji yet.").font(.zkSans(13)).foregroundColor(Theme.ink4)
                    } else {
                        ForEach(store.guildEmojis) { e in emojiRow(e) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Emoji").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadEmojis() }
            .onChange(of: pickerItem) { item in loadPicked(item) }
        }
    }

    private var uploadSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ADD EMOJI").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            HStack(spacing: 12) {
                if let img = pendingPreview {
                    Image(uiImage: img).resizable().scaledToFit().frame(width: 44, height: 44)
                        .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 8))
                } else {
                    PhotosPicker(selection: $pickerItem, matching: .images) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 8).fill(Theme.bg3).frame(width: 44, height: 44)
                            Image(systemName: "photo.badge.plus").font(.system(size: 16)).foregroundColor(Theme.ink3)
                        }
                    }
                }
                TextField("name", text: $name)
                    .autocorrectionDisabled(true).textInputAutocapitalization(.never)
                    .foregroundColor(Theme.ink1)
                    .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            if pendingPreview != nil {
                Button { upload() } label: {
                    Text(busy ? "Uploading…" : "Upload Emoji")
                        .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(canUpload ? Theme.accent : Theme.ink4).clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(!canUpload || busy)
                Button("Choose a different image") { resetPending() }
                    .font(.zkSans(13)).foregroundColor(Theme.accent)
            }
            Text("PNG, GIF, or WebP · under 512 KB · name uses lowercase letters, numbers, underscores")
                .font(.zkSans(11)).foregroundColor(Theme.ink4)
            if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
        }
    }

    private func emojiRow(_ e: GuildEmoji) -> some View {
        HStack(spacing: 12) {
            AsyncImage(url: assetURL(e.url)) { phase in
                if let img = phase.image { img.resizable().scaledToFit() } else { Color.clear }
            }
            .frame(width: 28, height: 28)
            Text(":\(e.name):").font(.zkSans(14)).foregroundColor(Theme.ink1)
            Spacer()
            Button(role: .destructive) { Task { await store.deleteEmoji(e) } } label: {
                Image(systemName: "trash").font(.system(size: 13)).foregroundColor(Theme.danger)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 6)
    }

    private func loadPicked(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "png"
            let mime = type?.preferredMIMEType ?? "image/png"
            let img = UIImage(data: data)
            await MainActor.run {
                pendingData = data; pendingFilename = "emoji.\(ext)"; pendingMime = mime; pendingPreview = img
            }
        }
    }
    private func resetPending() { pendingData = nil; pendingPreview = nil; pickerItem = nil }
    private func upload() {
        guard let data = pendingData else { return }
        busy = true; error = nil
        let clean = name.lowercased().replacingOccurrences(of: "[^a-z0-9_]", with: "_", options: .regularExpression)
        Task {
            let err = await store.uploadEmoji(name: clean, filename: pendingFilename, contentType: pendingMime, data: data)
            busy = false
            if let err { error = err } else { name = ""; resetPending() }
        }
    }
}

// MARK: - Sticker manager (admin)

/// Upload, view, and delete the server's stickers. Mirrors the sticker
/// management in the web GuildSettings. Gated on MANAGE_EMOJIS.
struct StickerManagerView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var pickerItem: PhotosPickerItem?
    @State private var pendingData: Data?
    @State private var pendingFilename = "sticker.png"
    @State private var pendingMime = "image/png"
    @State private var pendingPreview: UIImage?
    @State private var name = ""
    @State private var stickerDescription = ""
    @State private var busy = false
    @State private var error: String?

    private var canUpload: Bool {
        pendingData != nil && name.trimmingCharacters(in: .whitespaces).count >= 2
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    uploadSection
                    Divider().overlay(Theme.line)
                    Text("STICKERS · \(store.guildStickers.count)")
                        .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if store.guildStickers.isEmpty {
                        Text("No stickers yet.").font(.zkSans(13)).foregroundColor(Theme.ink4)
                    } else {
                        ForEach(store.guildStickers) { s in stickerRow(s) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Stickers").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadStickers() }
            .onChange(of: pickerItem) { item in loadPicked(item) }
        }
    }

    private var uploadSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("ADD STICKER").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            HStack(spacing: 12) {
                if let img = pendingPreview {
                    Image(uiImage: img).resizable().scaledToFit().frame(width: 56, height: 56)
                        .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 10))
                } else {
                    PhotosPicker(selection: $pickerItem, matching: .images) {
                        ZStack {
                            RoundedRectangle(cornerRadius: 10).fill(Theme.bg3).frame(width: 56, height: 56)
                            Image(systemName: "photo.badge.plus").font(.system(size: 18)).foregroundColor(Theme.ink3)
                        }
                    }
                }
                VStack(spacing: 8) {
                    TextField("name", text: $name)
                        .autocorrectionDisabled(true)
                        .foregroundColor(Theme.ink1)
                        .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    TextField("description (optional)", text: $stickerDescription)
                        .foregroundColor(Theme.ink1)
                        .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            if pendingPreview != nil {
                Button { upload() } label: {
                    Text(busy ? "Uploading…" : "Upload Sticker")
                        .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(canUpload ? Theme.accent : Theme.ink4).clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(!canUpload || busy)
                Button("Choose a different image") { resetPending() }
                    .font(.zkSans(13)).foregroundColor(Theme.accent)
            }
            Text("PNG, APNG, GIF, or WebP · under 512 KB")
                .font(.zkSans(11)).foregroundColor(Theme.ink4)
            if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
        }
    }

    private func stickerRow(_ s: Sticker) -> some View {
        HStack(spacing: 12) {
            AsyncImage(url: assetURL(s.url)) { phase in
                if let img = phase.image { img.resizable().scaledToFit() } else { Color.clear }
            }
            .frame(width: 44, height: 44)
            VStack(alignment: .leading, spacing: 2) {
                Text(s.name).font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                if let d = s.description, !d.isEmpty {
                    Text(d).font(.zkSans(11)).foregroundColor(Theme.ink3).lineLimit(1)
                }
            }
            Spacer()
            Button(role: .destructive) { Task { await store.deleteSticker(s) } } label: {
                Image(systemName: "trash").font(.system(size: 13)).foregroundColor(Theme.danger)
            }
            .buttonStyle(.plain)
        }
        .padding(.vertical, 6)
    }

    private func loadPicked(_ item: PhotosPickerItem?) {
        guard let item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "png"
            let mime = type?.preferredMIMEType ?? "image/png"
            let img = UIImage(data: data)
            await MainActor.run {
                pendingData = data; pendingFilename = "sticker.\(ext)"; pendingMime = mime; pendingPreview = img
            }
        }
    }
    private func resetPending() { pendingData = nil; pendingPreview = nil; pickerItem = nil }
    private func upload() {
        guard let data = pendingData else { return }
        busy = true; error = nil
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let d = stickerDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        Task {
            let err = await store.uploadSticker(name: n, description: d.isEmpty ? nil : d, filename: pendingFilename, contentType: pendingMime, data: data)
            busy = false
            if let err { error = err } else { name = ""; stickerDescription = ""; resetPending() }
        }
    }
}

// MARK: - Scheduled events

/// Member-facing event list with RSVP, plus admin create/edit/cancel/delete.
/// Mirrors the web events surface. Viewing + RSVP open to all members;
/// create/edit gated on MANAGE_EVENTS.
struct EventsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var showCreate = false
    @State private var editingEvent: ScheduledEvent?
    @State private var attendeesEvent: ScheduledEvent?
    @State private var showMyEvents = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if store.loadingEvents && store.events.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 24)
                    } else if store.events.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "calendar").font(.system(size: 30)).foregroundColor(Theme.ink4)
                            Text("No events scheduled.").font(.system(size: 14)).foregroundColor(Theme.ink3)
                        }
                        .frame(maxWidth: .infinity).padding(.top, 30)
                    } else {
                        ForEach(store.events) { ev in eventCard(ev) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Events").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } }
                ToolbarItem(placement: .principal) {
                    Button { showMyEvents = true } label: {
                        Label("My Events", systemImage: "calendar.badge.clock").font(.zkSans(13))
                    }
                }
                if store.canManageEvents {
                    ToolbarItem(placement: .confirmationAction) {
                        Button { showCreate = true } label: { Image(systemName: "plus") }
                    }
                }
            }
            .task { await store.loadEvents() }
            .sheet(isPresented: $showCreate) { EventEditSheet(event: nil) }
            .sheet(item: $editingEvent) { ev in EventEditSheet(event: ev) }
            .sheet(item: $attendeesEvent) { ev in EventAttendeesView(event: ev) }
            .sheet(isPresented: $showMyEvents) { MyEventsView() }
        }
    }

    private func eventCard(_ ev: ScheduledEvent) -> some View {
        let canRsvp = ev.status == "scheduled" || ev.status == "active"
        return VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(ev.name).font(.zkSans(16, weight: .semibold)).foregroundColor(Theme.ink1)
                    Text(Self.whenText(ev)).font(.zkSans(12)).foregroundColor(Theme.accent)
                }
                Spacer()
                if ev.status != "scheduled" { statusBadge(ev.status) }
                if store.canManageEvents { adminMenu(ev) }
            }
            HStack(spacing: 6) {
                Image(systemName: ev.locationKind == "voice_channel" ? "speaker.wave.2.fill" : "mappin.and.ellipse")
                    .font(.system(size: 11)).foregroundColor(Theme.ink3)
                Text(locationText(ev)).font(.zkSans(12)).foregroundColor(Theme.ink2).lineLimit(1)
            }
            if let d = ev.description, !d.isEmpty {
                Text(d).font(.zkSans(13)).foregroundColor(Theme.ink2).lineLimit(4)
            }
            if let c = ev.rsvpCounts {
                Button { attendeesEvent = ev } label: {
                    HStack(spacing: 4) {
                        Text("\(c.going) going · \(c.maybe) maybe · \(c.declined) declined")
                            .font(.zkSans(11)).foregroundColor(Theme.ink3)
                        Image(systemName: "chevron.right").font(.system(size: 9)).foregroundColor(Theme.ink4)
                    }
                }
                .buttonStyle(.plain)
            }
            if canRsvp {
                HStack(spacing: 8) {
                    rsvpButton(ev, "going", "Going")
                    rsvpButton(ev, "maybe", "Maybe")
                    rsvpButton(ev, "declined", "Can't go")
                }
            }
        }
        .padding(14)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func statusBadge(_ status: String) -> some View {
        let (label, color): (String, Color) = {
            switch status {
            case "active": return ("Live", Theme.online)
            case "completed": return ("Ended", Theme.ink4)
            case "canceled": return ("Canceled", Theme.danger)
            default: return (status, Theme.ink4)
            }
        }()
        return Text(label.uppercased())
            .font(.zkSans(9, weight: .bold)).foregroundColor(.white)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(color).clipShape(Capsule())
    }

    private func adminMenu(_ ev: ScheduledEvent) -> some View {
        Menu {
            Button { editingEvent = ev } label: { Label("Edit", systemImage: "pencil") }
            if ev.status == "scheduled" || ev.status == "active" {
                Button { Task { await store.cancelEvent(ev) } } label: { Label("Cancel Event", systemImage: "xmark.circle") }
            }
            Button(role: .destructive) { Task { await store.deleteEvent(ev) } } label: { Label("Delete", systemImage: "trash") }
        } label: {
            Image(systemName: "ellipsis").font(.system(size: 15)).foregroundColor(Theme.ink3).padding(.leading, 6)
        }
    }

    private func rsvpButton(_ ev: ScheduledEvent, _ status: String, _ label: String) -> some View {
        let active = ev.myRsvp == status
        return Button { Task { await store.rsvpEvent(ev, status: status) } } label: {
            Text(label)
                .font(.zkSans(12, weight: .semibold))
                .foregroundColor(active ? .white : Theme.ink2)
                .frame(maxWidth: .infinity).padding(.vertical, 8)
                .background(active ? Theme.accent : Theme.bg3)
                .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
    }

    private func locationText(_ ev: ScheduledEvent) -> String {
        if ev.locationKind == "voice_channel" {
            let name = store.channels.first(where: { $0.id == ev.locationChannelId })?.name ?? "voice channel"
            return name
        }
        return ev.locationText ?? "External"
    }

    private static let parseFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter(); f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]; return f
    }()
    private static let parsePlain = ISO8601DateFormatter()
    private static let display: DateFormatter = {
        let f = DateFormatter(); f.dateStyle = .medium; f.timeStyle = .short; return f
    }()
    static func parseDate(_ iso: String?) -> Date? {
        guard let iso else { return nil }
        return parseFractional.date(from: iso) ?? parsePlain.date(from: iso)
    }
    static func whenText(_ ev: ScheduledEvent) -> String {
        guard let start = parseDate(ev.startAt) else { return ev.startAt }
        var s = display.string(from: start)
        if let endIso = ev.endAt, let end = parseDate(endIso) {
            let t = DateFormatter(); t.timeStyle = .short
            s += " – \(t.string(from: end))"
        }
        return s
    }
}

/// Create or edit a scheduled event. Mirrors the web event form.
struct EventEditSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let event: ScheduledEvent?

    @State private var name = ""
    @State private var eventDescription = ""
    @State private var startAt = Date().addingTimeInterval(3600)
    @State private var hasEnd = false
    @State private var endAt = Date().addingTimeInterval(7200)
    @State private var locationKind = "voice_channel"
    @State private var channelId: String?
    @State private var locationText = ""
    @State private var busy = false
    @State private var error: String?

    private var isEdit: Bool { event != nil }
    private var voiceChannels: [Channel] { store.channels.filter { $0.isVoice } }
    private var canSave: Bool {
        !name.trimmingCharacters(in: .whitespaces).isEmpty
            && (locationKind == "external" ? !locationText.trimmingCharacters(in: .whitespaces).isEmpty : channelId != nil)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    field("NAME") {
                        TextField("Event name", text: $name)
                            .foregroundColor(Theme.ink1)
                            .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    field("DESCRIPTION") {
                        TextField("What's happening?", text: $eventDescription, axis: .vertical)
                            .lineLimit(2...5).foregroundColor(Theme.ink1)
                            .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    field("STARTS") {
                        DatePicker("", selection: $startAt, displayedComponents: [.date, .hourAndMinute])
                            .labelsHidden().tint(Theme.accent).foregroundColor(Theme.ink1)
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Toggle(isOn: $hasEnd) {
                            Text("Set end time").font(.zkSans(14)).foregroundColor(Theme.ink1)
                        }.tint(Theme.accent)
                        if hasEnd {
                            DatePicker("", selection: $endAt, displayedComponents: [.date, .hourAndMinute])
                                .labelsHidden().tint(Theme.accent)
                        }
                    }
                    field("LOCATION") {
                        Picker("", selection: $locationKind) {
                            Text("Voice Channel").tag("voice_channel")
                            Text("External").tag("external")
                        }
                        .pickerStyle(.segmented)
                    }
                    if locationKind == "voice_channel" {
                        Menu {
                            ForEach(voiceChannels) { c in Button(c.name ?? "voice") { channelId = c.id } }
                        } label: {
                            HStack {
                                Text(voiceChannels.first(where: { $0.id == channelId })?.name ?? "Select a channel")
                                    .foregroundColor(channelId == nil ? Theme.ink3 : Theme.ink1)
                                Spacer()
                                Image(systemName: "chevron.up.chevron.down").font(.system(size: 12)).foregroundColor(Theme.ink3)
                            }
                            .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    } else {
                        TextField("Location or link", text: $locationText)
                            .foregroundColor(Theme.ink1)
                            .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    if let error { Text(error).font(.zkSans(13)).foregroundColor(Theme.danger) }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(isEdit ? "Edit Event" : "New Event").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button(isEdit ? "Save" : "Create") { save() }.disabled(!canSave || busy)
                }
            }
            .onAppear { hydrate() }
        }
    }

    private func field<Content: View>(_ title: String, @ViewBuilder _ content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            content()
        }
    }

    private func hydrate() {
        guard let ev = event else { return }
        name = ev.name
        eventDescription = ev.description ?? ""
        if let s = EventsView.parseDate(ev.startAt) { startAt = s }
        if let e = EventsView.parseDate(ev.endAt) { endAt = e; hasEnd = true }
        locationKind = ev.locationKind
        channelId = ev.locationChannelId
        locationText = ev.locationText ?? ""
    }

    private func save() {
        busy = true; error = nil
        let n = name.trimmingCharacters(in: .whitespacesAndNewlines)
        let d = eventDescription.trimmingCharacters(in: .whitespacesAndNewlines)
        let loc = locationText.trimmingCharacters(in: .whitespacesAndNewlines)
        let end = hasEnd ? endAt : nil
        Task {
            let err: String?
            if let ev = event {
                err = await store.updateEvent(ev, name: n, description: d, startAt: startAt, endAt: end, locationKind: locationKind, channelId: channelId, locationText: loc)
            } else {
                err = await store.createEvent(name: n, description: d, startAt: startAt, endAt: end, locationKind: locationKind, channelId: channelId, locationText: loc)
            }
            busy = false
            if let err { error = err } else { dismiss() }
        }
    }
}

// MARK: - Quick switcher

/// Jump-anywhere switcher: fuzzy-filter across servers, channels (all
/// guilds), and DMs, then navigate. Mirrors the web QuickSwitcher.
struct QuickSwitcherView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @FocusState private var searchFocused: Bool

    private var q: String { query.trimmingCharacters(in: .whitespaces).lowercased() }

    private var guildMatches: [Guild] {
        store.guilds.filter { q.isEmpty || $0.name.lowercased().contains(q) }
    }
    private var channelMatches: [Channel] {
        store.switcherChannels.filter { ch in
            if ch.isCategory { return false }
            if q.isEmpty { return true }
            let name = (ch.name ?? "").lowercased()
            let gname = store.guilds.first(where: { $0.id == ch.guildId })?.name.lowercased() ?? ""
            return name.contains(q) || gname.contains(q)
        }
    }
    private var dmMatches: [Channel] {
        store.dms.filter { q.isEmpty || $0.dmTitle.lowercased().contains(q) }
    }

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass").font(.system(size: 14)).foregroundColor(Theme.ink3)
                    TextField("Search servers, channels, DMs", text: $query)
                        .focused($searchFocused)
                        .autocorrectionDisabled(true)
                        .foregroundColor(Theme.ink1)
                }
                .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 16).padding(.top, 8).padding(.bottom, 4)

                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        if store.loadingSwitcher && store.switcherChannels.isEmpty {
                            ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 16)
                        }
                        if !guildMatches.isEmpty {
                            section("SERVERS") { ForEach(guildMatches) { g in guildRow(g) } }
                        }
                        if !channelMatches.isEmpty {
                            section("CHANNELS") { ForEach(Array(channelMatches.prefix(60))) { c in channelRow(c) } }
                        }
                        if !dmMatches.isEmpty {
                            section("DIRECT MESSAGES") { ForEach(dmMatches) { d in dmRow(d) } }
                        }
                        if guildMatches.isEmpty && channelMatches.isEmpty && dmMatches.isEmpty && !store.loadingSwitcher {
                            Text("No matches.").font(.zkSans(13)).foregroundColor(Theme.ink4).padding(.top, 8)
                        }
                    }
                    .padding(16)
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Jump to…").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } } }
            .task { await store.loadSwitcherChannels() }
            .onAppear {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { searchFocused = true }
            }
        }
    }

    private func section<C: View>(_ title: String, @ViewBuilder _ content: () -> C) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            content()
        }
    }

    private func guildRow(_ g: Guild) -> some View {
        Button { store.jumpToGuild(g); dismiss() } label: {
            HStack(spacing: 10) {
                GuildIcon(guild: g, isSelected: false, size: 30)
                Text(g.name).font(.zkSans(15)).foregroundColor(Theme.ink1)
                Spacer()
            }
            .contentShape(Rectangle())
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }
    private func channelRow(_ c: Channel) -> some View {
        let gname = store.guilds.first(where: { $0.id == c.guildId })?.name ?? ""
        return Button { store.jumpToChannel(c); dismiss() } label: {
            HStack(spacing: 10) {
                Image(systemName: channelSymbol(c)).font(.system(size: 14)).foregroundColor(Theme.ink3).frame(width: 24)
                Text(c.name ?? "channel").font(.system(size: 15)).foregroundColor(Theme.ink1).lineLimit(1)
                Spacer()
                Text(gname).font(.zkSans(11)).foregroundColor(Theme.ink4).lineLimit(1)
            }
            .contentShape(Rectangle())
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }
    private func dmRow(_ d: Channel) -> some View {
        Button { store.jumpToDM(d); dismiss() } label: {
            HStack(spacing: 10) {
                Avatar(url: d.dmAvatarUser?.avatarUrl, name: d.dmTitle, size: 26, ringColor: Theme.bg1)
                Text(d.dmTitle).font(.zkSans(15)).foregroundColor(Theme.ink1).lineLimit(1)
                Spacer()
            }
            .contentShape(Rectangle())
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }
    private func channelSymbol(_ c: Channel) -> String {
        if c.isVoice { return "speaker.wave.2.fill" }
        if c.isForum { return "list.bullet.rectangle" }
        return "number"
    }
}

// MARK: - Event attendees

/// Who's RSVP'd to an event, in Going / Maybe / Declined tabs. Mirrors the
/// web EventAttendeesModal. Opened from an event's RSVP-count row.
struct EventAttendeesView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let event: ScheduledEvent
    @State private var status = "going"

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $status) {
                    Text("Going").tag("going")
                    Text("Maybe").tag("maybe")
                    Text("Declined").tag("declined")
                }
                .pickerStyle(.segmented)
                .padding(16)
                ScrollView {
                    VStack(alignment: .leading, spacing: 8) {
                        if store.loadingAttendees {
                            ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 16)
                        } else if store.eventAttendees.isEmpty {
                            Text("No one here yet.").font(.zkSans(13)).foregroundColor(Theme.ink4).padding(.top, 8)
                        } else {
                            ForEach(store.eventAttendees) { a in attendeeRow(a) }
                        }
                    }
                    .padding(.horizontal, 16)
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(event.name).navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task(id: status) { await store.loadEventAttendees(event, status: status) }
        }
    }

    private func attendeeRow(_ a: EventRsvp) -> some View {
        Button { store.openProfile(a.user); dismiss() } label: {
            HStack(spacing: 10) {
                Avatar(url: a.user.avatarUrl, name: a.user.name, size: 32, status: store.presence[a.user.id])
                Text(a.user.name).font(.zkSans(15)).foregroundColor(Theme.ink1)
                Spacer()
            }
            .contentShape(Rectangle())
            .padding(.vertical, 4)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - My events (cross-guild)

/// Personal agenda: every upcoming event across all servers the user has
/// RSVP'd going/maybe to. Mirrors the web MyEventsModal.
struct MyEventsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if store.loadingMyEvents && store.myEvents.isEmpty {
                        ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 24)
                    } else if store.myEvents.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "calendar").font(.system(size: 30)).foregroundColor(Theme.ink4)
                            Text("Nothing on your agenda.").font(.system(size: 14)).foregroundColor(Theme.ink3)
                        }
                        .frame(maxWidth: .infinity).padding(.top, 30)
                    } else {
                        ForEach(store.myEvents) { me in myEventRow(me) }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("My Events").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadMyEvents() }
        }
    }

    private func myEventRow(_ me: MyEvent) -> some View {
        let ev = me.event
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 8) {
                Avatar(url: me.guildIconUrl, name: me.guildName ?? "S", size: 22, squircle: true)
                Text(me.guildName ?? "Server").font(.zkSans(11)).foregroundColor(Theme.ink3)
                Spacer()
                if let my = ev.myRsvp { rsvpTag(my) }
            }
            Text(ev.name).font(.zkSans(15, weight: .semibold)).foregroundColor(Theme.ink1)
            Text(EventsView.whenText(ev)).font(.zkSans(12)).foregroundColor(Theme.accent)
            if ev.locationKind == "external", let t = ev.locationText, !t.isEmpty {
                Text(t).font(.zkSans(12)).foregroundColor(Theme.ink2).lineLimit(1)
            }
        }
        .padding(14).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func rsvpTag(_ s: String) -> some View {
        Text(s.capitalized)
            .font(.zkSans(10, weight: .bold)).foregroundColor(Theme.accent)
            .padding(.horizontal, 7).padding(.vertical, 3)
            .background(Theme.accent.opacity(0.15)).clipShape(Capsule())
    }
}

// MARK: - Onboarding gate

/// Full-screen rules-acknowledgement gate shown when our membership in the
/// active guild is still pending. Mirrors the web OnboardingModal: no close
/// button — you either agree or leave the server.
struct OnboardingView: View {
    @EnvironmentObject private var store: AppStore
    let guild: Guild
    @State private var busy = false

    private var rules: String {
        let r = guild.rulesContent ?? ""
        return r.isEmpty ? "Be respectful, follow the community guidelines, and have fun." : r
    }

    var body: some View {
        ZStack {
            Theme.bg0.opacity(0.98).ignoresSafeArea()
            VStack(spacing: 0) {
                VStack(spacing: 6) {
                    GuildIcon(guild: guild, isSelected: false, size: 56)
                    Text("Welcome to \(guild.name)")
                        .font(.zkSans(20, weight: .bold)).foregroundColor(Theme.ink1)
                        .multilineTextAlignment(.center)
                    Text("Please review the rules to continue")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                }
                .padding(.top, 44).padding(.bottom, 16).padding(.horizontal, 24)

                ScrollView {
                    Text(rules)
                        .font(.zkSans(14)).foregroundColor(Theme.ink2)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(16)
                }
                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                .padding(.horizontal, 16)

                VStack(spacing: 10) {
                    Button { agree() } label: {
                        Text(busy ? "…" : "I Agree")
                            .font(.zkSans(16, weight: .semibold)).foregroundColor(.white)
                            .frame(maxWidth: .infinity).padding(.vertical, 13)
                            .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .disabled(busy)
                    Button(role: .destructive) { Task { await store.leaveSelectedGuild() } } label: {
                        Text("Leave Server").font(.zkSans(14)).foregroundColor(Theme.danger)
                    }
                }
                .padding(16)
            }
        }
    }

    private func agree() {
        busy = true
        Task { await store.acknowledgeOnboarding(); busy = false }
    }
}

// MARK: - Admin per-file storage browser

/// Paginated file-by-file storage listing for instance admins. Sort by
/// size or recency, see which files are unused, and delete or re-compress
/// individual files to reclaim disk.
struct StorageItemsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("Sort", selection: Binding(
                    get: { store.storageSort },
                    set: { v in Task { await store.setStorageSort(v) } }
                )) {
                    Text("Largest").tag("size")
                    Text("Recent").tag("recent")
                }
                .pickerStyle(.segmented)
                .padding(12)

                ScrollView {
                    LazyVStack(spacing: 8) {
                        if store.loadingStorageItems && store.storageItems.isEmpty {
                            ProgressView().tint(Theme.accent).padding(.top, 40)
                        } else if store.storageItems.isEmpty {
                            Text("No files.").font(.zkSans(14)).foregroundColor(Theme.ink3).padding(.top, 40)
                        } else {
                            ForEach(store.storageItems) { item in
                                storageRow(item)
                            }
                            if store.storageHasMore {
                                Button { Task { await store.loadStorageItems(reset: false) } } label: {
                                    Text(store.loadingStorageItems ? "Loading…" : "Load more")
                                        .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.accent)
                                        .frame(maxWidth: .infinity).padding(.vertical, 10)
                                }
                                .disabled(store.loadingStorageItems)
                            }
                        }
                    }
                    .padding(.horizontal, 12).padding(.bottom, 12)
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Files").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { if store.storageItems.isEmpty { await store.loadStorageItems(reset: true) } }
        }
    }

    @ViewBuilder
    private func storageRow(_ item: StorageItem) -> some View {
        HStack(spacing: 10) {
            Image(systemName: icon(item))
                .font(.system(size: 16)).foregroundColor(Theme.ink3).frame(width: 24)
            VStack(alignment: .leading, spacing: 2) {
                Text(item.filename ?? "(unnamed)")
                    .font(.zkSans(14)).foregroundColor(Theme.ink1).lineLimit(1)
                HStack(spacing: 6) {
                    Text(item.category).font(.zkSans(11)).foregroundColor(Theme.ink4)
                    Text(bytes(item.sizeBytes)).font(.zkSans(11)).foregroundColor(Theme.ink3)
                    if !item.referenced {
                        Text("UNUSED").font(.zkSans(9, weight: .bold)).foregroundColor(Theme.danger)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.danger.opacity(0.15)).clipShape(Capsule())
                    }
                }
            }
            Spacer()
            if item.compressed == false {
                Button { Task { await store.compressStorageItem(item) } } label: {
                    Image(systemName: "arrow.down.right.and.arrow.up.left")
                        .font(.system(size: 14)).foregroundColor(Theme.ink3)
                }
            }
            Button(role: .destructive) { Task { await store.deleteStorageItem(item) } } label: {
                Image(systemName: "trash").font(.system(size: 14)).foregroundColor(Theme.danger)
            }
        }
        .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func icon(_ item: StorageItem) -> String {
        switch item.category {
        case "avatars", "banners": return "person.crop.square.fill"
        case "emojis", "stickers": return "face.smiling.fill"
        default: return "doc.fill"
        }
    }
    private func bytes(_ b: Int) -> String {
        if b >= 1_048_576 { return String(format: "%.1f MB", Double(b) / 1_048_576) }
        if b >= 1024 { return String(format: "%.0f KB", Double(b) / 1024) }
        return "\(b) B"
    }
}

// MARK: - Guild info card

/// Lightweight server-info popover shown when tapping the guild header.
/// Surfaces the server's identity plus quick actions (invite, settings,
/// leave) without dropping the user straight into the full settings sheet.
struct GuildInfoCard: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let onOpenSettings: () -> Void
    @State private var showInvite = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 12) {
                    if let g = store.selectedGuild {
                        GuildIcon(guild: g, isSelected: false, size: 64)
                        Text(g.name)
                            .font(.zkSans(20, weight: .bold)).foregroundColor(Theme.ink1)
                            .multilineTextAlignment(.center)
                        if let d = g.description, !d.isEmpty {
                            Text(d)
                                .font(.zkSans(14)).foregroundColor(Theme.ink2)
                                .multilineTextAlignment(.center)
                        }
                        Text("\(store.members.count) member\(store.members.count == 1 ? "" : "s")")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)

                        VStack(spacing: 0) {
                            infoButton("Invite People", icon: "person.badge.plus") { showInvite = true }
                            Divider().overlay(Theme.line)
                            infoButton("Server Settings", icon: "gearshape") { onOpenSettings() }
                            if !store.isGuildOwner {
                                Divider().overlay(Theme.line)
                                infoButton("Leave Server", icon: "rectangle.portrait.and.arrow.right", destructive: true) {
                                    Task { await store.leaveSelectedGuild(); dismiss() }
                                }
                            }
                        }
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
                        .padding(.top, 6)
                    } else {
                        Text("No server selected").font(.zkSans(14)).foregroundColor(Theme.ink3).padding(.top, 40)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Server Info").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .sheet(isPresented: $showInvite) { CreateInviteSheet() }
        }
    }

    @ViewBuilder
    private func infoButton(_ title: String, icon: String, destructive: Bool = false, action: @escaping () -> Void) -> some View {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: icon)
                    .font(.system(size: 15)).foregroundColor(destructive ? Theme.danger : Theme.ink2).frame(width: 22)
                Text(title)
                    .font(.zkSans(15)).foregroundColor(destructive ? Theme.danger : Theme.ink1)
                Spacer()
            }
            .contentShape(Rectangle()).padding(.horizontal, 14).padding(.vertical, 12)
        }
        .buttonStyle(.plain)
    }
}

// MARK: - Global error toast

/// Transient error banner pinned to the top. Surfaces store.errorText —
/// which 70+ failed operations set but, until now, nothing displayed.
/// Auto-dismisses after a few seconds; restarts its timer per message.
struct ErrorToast: View {
    let message: String
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .font(.system(size: 14)).foregroundColor(.white)
            Text(message)
                .font(.zkSans(13, weight: .medium)).foregroundColor(.white)
                .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            Button { dismiss() } label: {
                Image(systemName: "xmark").font(.system(size: 12, weight: .bold)).foregroundColor(.white.opacity(0.85))
            }
        }
        .padding(.horizontal, 14).padding(.vertical, 11)
        .background(Theme.danger).clipShape(RoundedRectangle(cornerRadius: 12))
        .shadow(color: .black.opacity(0.25), radius: 8, y: 3)
        .padding(.horizontal, 16).padding(.top, 6)
        .task(id: message) {
            try? await Task.sleep(nanoseconds: 4_500_000_000)
            dismiss()
        }
    }
}

// MARK: - Reorder servers

/// Drag-to-reorder the guild rail via a native List in edit mode. Order is
/// per-device (UserDefaults), matching the web's localStorage approach.
struct ReorderServersView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var items: [Guild] = []

    var body: some View {
        NavigationStack {
            Group {
                if items.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "square.stack.3d.up").font(.system(size: 30)).foregroundColor(Theme.ink3)
                        Text("No servers to reorder").font(.system(size: 14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        ForEach(items) { g in
                            HStack(spacing: 10) {
                                GuildIcon(guild: g, isSelected: false, size: 32)
                                Text(g.name).font(.zkSans(15)).foregroundColor(Theme.ink1).lineLimit(1)
                            }
                            .listRowBackground(Theme.bg2)
                        }
                        .onMove { from, to in
                            items.move(fromOffsets: from, toOffset: to)
                            store.setGuildOrder(items.map { $0.id })
                        }
                    }
                    .listStyle(.plain)
                    .environment(\.editMode, .constant(.active))
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Reorder Servers").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .onAppear { items = store.orderedGuilds }
        }
    }
}

// MARK: - Reorder channels

/// Drag-to-reorder channels within each group (uncategorized + per category)
/// via a native List in edit mode. Server-backed (reorderChannels positions
/// endpoint), so the new order syncs to every client. Re-parenting a channel
/// into a different category still uses the channel-edit "Category" field.
struct ReorderChannelsView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var groups: [ChannelGroup] = []

    struct ChannelGroup: Identifiable {
        let id: String          // "" = uncategorized, else category id
        let title: String
        var channels: [Channel]
        let parentId: String?   // nil = uncategorized
    }

    var body: some View {
        NavigationStack {
            Group {
                if groups.allSatisfy({ $0.channels.isEmpty }) {
                    VStack(spacing: 8) {
                        Image(systemName: "number").font(.system(size: 30)).foregroundColor(Theme.ink3)
                        Text("No channels to reorder").font(.system(size: 14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    List {
                        ForEach(groups.indices, id: \.self) { i in
                            if !groups[i].channels.isEmpty {
                                Section(groups[i].title) {
                                    ForEach(groups[i].channels) { ch in row(ch) }
                                        .onMove { from, to in
                                            groups[i].channels.move(fromOffsets: from, toOffset: to)
                                            let g = groups[i]
                                            Task { await store.reorderChannels(g.channels, parentId: g.parentId) }
                                        }
                                }
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .environment(\.editMode, .constant(.active))
                    .scrollContentBackground(.hidden)
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Reorder Channels").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .onAppear { buildGroups() }
        }
    }

    private func buildGroups() {
        let all = store.channels.sorted { ($0.position ?? 0, $0.id) < ($1.position ?? 0, $1.id) }
        var result: [ChannelGroup] = []
        let uncat = all.filter { !$0.isCategory && !$0.isThread && $0.parentId == nil }
        result.append(ChannelGroup(id: "", title: "UNCATEGORIZED", channels: uncat, parentId: nil))
        for cat in all.filter({ $0.isCategory }) {
            let kids = all.filter { !$0.isCategory && !$0.isThread && $0.parentId == cat.id }
            result.append(ChannelGroup(id: cat.id, title: (cat.name ?? "Category").uppercased(), channels: kids, parentId: cat.id))
        }
        groups = result
    }

    private func row(_ ch: Channel) -> some View {
        HStack(spacing: 8) {
            Image(systemName: channelIcon(ch)).font(.system(size: 13)).foregroundColor(Theme.ink3).frame(width: 18)
            Text(ch.name ?? "channel").font(.system(size: 15)).foregroundColor(Theme.ink1).lineLimit(1)
        }
        .listRowBackground(Theme.bg2)
    }
    private func channelIcon(_ c: Channel) -> String {
        if c.isVoice { return "speaker.wave.2.fill" }
        if c.isForum { return "list.bullet.rectangle" }
        return "number"
    }
}

/// Generate a crisp QR code image for a string (e.g. an invite URL) via
/// CoreImage. Returns nil if generation fails.
func qrCodeImage(_ string: String) -> UIImage? {
    let data = Data(string.utf8)
    guard let filter = CIFilter(name: "CIQRCodeGenerator") else { return nil }
    filter.setValue(data, forKey: "inputMessage")
    filter.setValue("M", forKey: "inputCorrectionLevel")
    guard let output = filter.outputImage else { return nil }
    let scaled = output.transformed(by: CGAffineTransform(scaleX: 10, y: 10))
    let context = CIContext()
    guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
    return UIImage(cgImage: cg)
}
