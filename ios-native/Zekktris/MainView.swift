import SwiftUI
import UIKit
import PhotosUI
import CoreImage
import UniformTypeIdentifiers

/// The signed-in shell. Mirrors the web mobile layout: a persistent 72pt
/// server rail on the left, and a content column that shows the channel list
/// or drills into a channel's messages.
struct MainView: View {
    @EnvironmentObject private var store: AppStore
    @EnvironmentObject private var session: Session
    @Environment(\.horizontalSizeClass) private var hSizeClass

    private var isWide: Bool { hSizeClass == .regular }

    // Interactive swipe-back (compact only). The live finger-tracking offset is
    // a @GestureState (`dragX`) so SwiftUI AUTO-RESETS it to 0 if the gesture is
    // cancelled (an incoming call, a system edge gesture, …) — that guarantees
    // the page can never be left stuck part-way off-screen with no onEnded to
    // clean up. The follow-through / snap-back animation after the finger lifts
    // is driven by `settleX` + `settling` (the gesture is over by then, so it
    // needs plain @State); both are always cleared by a scheduled completion.
    // `contentWidth` is the measured page width for the 66% threshold.
    @GestureState private var dragX: CGFloat = 0
    @State private var settleX: CGFloat = 0
    @State private var settling = false
    @State private var contentWidth: CGFloat = 0

    /// Horizontal offset of the conversation during a back-swipe: the live drag
    /// while the finger is down, then the settle animation after it lifts.
    private var backOffset: CGFloat { settling ? settleX : dragX }
    /// Whether a back-swipe is in progress (dragging or settling). Drives the
    /// reveal of the screen behind and suppresses the cross-fade.
    private var backActive: Bool { settling || dragX > 0 }

    var body: some View {
        shell
            // Root presenters. Environment objects are re-injected
            // explicitly: sheet/fullScreenCover content hosts have been
            // observed to lose inherited environment objects on Mac
            // (Designed for iPad) when the window resizes across size
            // classes — the source of the "No ObservableObject of type
            // AppStore found" crash.
            .sheet(item: $store.profileUser) { u in
                ProfileCardView(user: u)
                    .environmentObject(store)
                    .environmentObject(session)
                    .environmentObject(store.voice)
            }
            .fullScreenCover(item: $store.lightbox) { img in
                ImageLightboxView(item: img)
                    .environmentObject(store)
            }
            .fullScreenCover(item: compactRailPageBinding) { page in
                railPageHost(page)
            }
            .onAppear { store.isWideLayout = isWide }
            .onChange(of: hSizeClass) { newValue in
                store.isWideLayout = (newValue == .regular)
                // Expanding to wide with a deep stack: trim to the top route
                // so the detail pane shows a single screen.
                if newValue == .regular && store.stack.count > 1,
                   let top = store.stack.last {
                    store.stack = [top]
                }
                // Keep Mentions on the right presentation for the new size
                // class: wide fills via railPage; compact uses the in-rail
                // content view (never a back-button-less full-screen cover).
                if store.railPage == .mentions || store.railContent == .mentions {
                    if newValue == .regular {
                        store.railPage = .mentions; store.railContent = .normal
                    } else {
                        store.railPage = nil; store.railContent = .mentions
                    }
                }
            }
    }

    /// One shell for every width. The rail is shared between the compact
    /// and wide arrangements — switching layouts must NOT recreate it,
    /// because it hosts the rail sheets (Settings/Discover/Admin/Family…)
    /// and a branch swap mid-presentation detaches the sheet from the
    /// environment.
    private var shell: some View {
        HStack(spacing: 0) {
            // iPhone: a conversation takes the WHOLE screen — the rail only
            // shows at the root (channel/DM lists). The < button pops back.
            if isWide || store.stack.isEmpty {
                ServerRailView()
                    .frame(width: 72)
                    .background(Theme.bg0.opacity(0.85))

                Rectangle().fill(Theme.line).frame(width: 1)
            }

            if isWide, let page = store.railPage {
                // Full-page rail destination: takes the sidebar + detail
                // area while the server rail stays visible.
                railPageHost(page)
            } else {
            if isWide {
                // Sidebar column (web xl:w-60; roomier on Mac).
                Group {
                    if store.inDMs {
                        DMListView()
                    } else {
                        ChannelListView()
                    }
                }
                .frame(width: Self.sidebarWidth)

                Rectangle().fill(Theme.line).frame(width: 1)
            }

            VStack(spacing: 0) {
                if store.activeVoiceOrStageId != nil && !store.isViewingActiveCall
                    && store.outgoingCall == nil && store.incomingCall == nil {
                    MinimizedCallBar()
                }
                ZStack {
                    if isWide {
                        wideDetail
                            .id(routeKey)
                            .transition(.opacity)
                    } else {
                        compactNav
                    }
                }
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                // Cross-fade pushes/pops as before — but NOT during a back-swipe
                // (the slide drives the motion and a fade would fight it), and
                // NOT when landing on the root (stack empty). On compact the
                // server rail is a sibling that only exists at root; cross-fading
                // the outgoing full-width conversation while the rail is inserted
                // leaves a still-hit-testable fading view OVER the rail for ~0.2s,
                // eating its taps (the "rail unresponsive after going back" bug).
                // The < button, swipe-back, and any showDMs/showMentions/
                // selectGuild that returns to root all funnel through here.
                .animation(
                    (backActive || (store.stack.isEmpty && !isWide)) ? nil : .easeInOut(duration: 0.2),
                    value: routeKey
                )
            }
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

    /// Sidebar width: the web's 15rem (225pt), with extra room on Mac
    /// where windows are wide and information density is expected.
    static var sidebarWidth: CGFloat {
        ProcessInfo.processInfo.isiOSAppOnMac ? 264 : 225
    }

    /// Compact only: drive the full-screen cover from store.railPage, but
    /// never while the wide layout hosts the page inline.
    private var compactRailPageBinding: Binding<RailPage?> {
        Binding(
            get: { isWide ? nil : store.railPage },
            set: { store.railPage = $0 }
        )
    }

    /// Hosts a rail page with the `<` back behavior wired (sets
    /// store.railPage = nil) and environment objects re-injected.
    @ViewBuilder
    private func railPageHost(_ page: RailPage) -> some View {
        Group {
            switch page {
            case .settings: SettingsView()
            case .discover: DiscoveryView()
            case .createServer: CreateServerSheet()
            case .joinInvite: JoinByInviteSheet()
            case .admin: AdminView()
            case .family: FamilyView()
            case .mentions: MentionsView()
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg1.opacity(0.9))
        .environment(\.zkDismissPage, { store.railPage = nil })
        .environmentObject(store)
        .environmentObject(session)
        .environmentObject(store.voice)
    }

    /// Detail pane for the wide layout. Routed content wins (matching the
    /// compact `content` priority — a mention jump must show the message);
    /// Mentions/Saved render here when no route is active; placeholder
    /// otherwise.
    @ViewBuilder
    private var wideDetail: some View {
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
            case .mentions: MentionsView()
            case .saved: SavedView()
            case .normal: WideEmptyDetail()
            }
        }
    }

    /// Compact (phone) navigation with an interactive **swipe-back**: drag the
    /// conversation to the RIGHT and it follows your finger; release past 45%
    /// of the width and it follows through — sliding the rest of the way off
    /// and popping to the previous screen; release short of that (or push it
    /// back left) and it snaps back and stays. Only the message screens (text
    /// channels + DMs) opt in.
    @ViewBuilder
    private var compactNav: some View {
        ZStack {
            // The screen we'd return to, revealed behind the dragged page.
            // Mirror the REAL root layout — the 72pt server rail + the
            // channel/DM list — so the reveal looks identical to what the shell
            // renders once the pop completes (the server rail is hidden while a
            // conversation is open, so we re-create it here). Non-interactive
            // while the gesture is in flight. Only the root list (single-item
            // stack) is revealed; deeper stacks slide over the backdrop and pop
            // so a previous conversation's onAppear doesn't fire mid-drag.
            if backActive && belowRoute == nil {
                HStack(spacing: 0) {
                    ServerRailView()
                        .frame(width: 72)
                        .background(Theme.bg0.opacity(0.85))
                    Rectangle().fill(Theme.line).frame(width: 1)
                    rootContent
                }
                .allowsHitTesting(false)
            }
            page(for: store.stack.last)
                .id(routeKey)
                // No explicit .transition here: the parent ZStack's
                // .animation(value: routeKey) still cross-fades normal
                // push/pop. An explicit .transition(.opacity) made the
                // outgoing full-width conversation view linger one frame past
                // the swipe-back's disablesAnimations pop, covering the server
                // rail's tap region (rail "unresponsive" right after a swipe).
                .offset(x: backOffset)
        }
        .background(
            GeometryReader { geo in
                Color.clear
                    .onAppear { contentWidth = geo.size.width }
                    .onChange(of: geo.size.width) { contentWidth = $0 }
            }
        )
        .simultaneousGesture(backSwipeGesture)
        .simultaneousGesture(membersSwipeGesture)
    }

    /// Swipe LEFT (in a guild text channel) to bring up the members tab — the
    /// mirror of the right-swipe-back. A simple fling (the member list is a
    /// sheet, not a sliding panel, so there's nothing to track to the finger):
    /// a clearly-leftward, horizontally-dominant drag sets `showMembers`, which
    /// presents the same sheet the header's people button does. DM and voice
    /// screens have no member list, so it's gated to guild text routes.
    private var membersSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 24)
            .onEnded { value in
                // `!backActive` so a leftward fling during a back-swipe's
                // settle/pop window can't set showMembers as the page pops
                // (which would auto-open the sheet on the next channel).
                guard isGuildTextRoute(store.stack.last), !store.showMembers, !backActive
                else { return }
                if value.translation.width < -70,
                   abs(value.translation.width) > abs(value.translation.height) * 1.5 {
                    store.showMembers = true
                }
            }
    }

    /// True only for a guild (non-DM) text-channel message route — where a
    /// member list exists.
    private func isGuildTextRoute(_ route: Route?) -> Bool {
        if case .messages(let c) = route { return !c.isDM }
        return false
    }

    /// The interactive back-swipe. `simultaneousGesture` + a horizontal-
    /// dominance check let it coexist with the message list's vertical scroll
    /// without stealing it. The live offset lives in `@GestureState dragX`
    /// (auto-reset on cancel); `onEnded` hands off to the settle animation.
    private var backSwipeGesture: some Gesture {
        DragGesture(minimumDistance: 12)
            .updating($dragX) { value, state, _ in
                // Track only a rightward, horizontally-dominant drag on a
                // message screen; anything else leaves the offset at 0 so a
                // vertical scroll is untouched.
                guard isMessageRoute(store.stack.last),
                      value.translation.width > 0,
                      abs(value.translation.width) > abs(value.translation.height)
                else { return }
                state = value.translation.width
            }
            .onEnded { value in
                guard isMessageRoute(store.stack.last),
                      value.translation.width > 0,
                      abs(value.translation.width) > abs(value.translation.height)
                else { return }
                let width = contentWidth > 0 ? contentWidth : 393
                // Take over from the (now-resetting) live drag at the release
                // position, then animate to the target. `settling`/`settleX`
                // are always cleared by the scheduled completion below.
                settleX = value.translation.width
                settling = true
                if value.translation.width > width * 0.45 {
                    // Past the threshold: follow through — slide fully off,
                    // then pop (un-animated so the fade doesn't double up).
                    withAnimation(.easeOut(duration: 0.22)) { settleX = width }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
                        var txn = Transaction()
                        txn.disablesAnimations = true
                        withTransaction(txn) {
                            store.pop()
                            settling = false
                            settleX = 0
                        }
                    }
                } else {
                    // Short of the threshold (or pushed back left): snap back.
                    withAnimation(.easeOut(duration: 0.2)) { settleX = 0 }
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) { settling = false }
                }
            }
    }

    /// The view for a given stack route (or the root list when `nil`).
    @ViewBuilder
    private func page(for route: Route?) -> some View {
        if let route {
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
            rootContent
        }
    }

    /// The root list (no route pushed): mentions / saved / DMs / channels.
    @ViewBuilder
    private var rootContent: some View {
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

    /// The route directly beneath the top of the stack (the back target), or
    /// `nil` when the top sits on the root list.
    private var belowRoute: Route? {
        store.stack.count >= 2 ? store.stack[store.stack.count - 2] : nil
    }

    private func isMessageRoute(_ route: Route?) -> Bool {
        if case .messages = route { return true }
        return false
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

/// Placeholder for the wide layout's detail pane before any channel is
/// selected (web shows the first channel automatically; this covers empty
/// guilds and the brief load gap).
private struct WideEmptyDetail: View {
    var body: some View {
        VStack(spacing: 10) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 36, weight: .light))
                .foregroundColor(Theme.ink4)
            Text("Select a channel")
                .font(.zkSans(15, weight: .medium))
                .foregroundColor(Theme.ink3)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Theme.bg1.opacity(0.9))
    }
}

/// Full-page rail destinations (Discover / Create / Join / Admin / Family /
/// Settings). Hosted inline next to the rail on iPad/Mac, full screen on
/// iPhone — NOT sheets.
enum RailPage: String, Identifiable, CaseIterable {
    case settings, discover, createServer, joinInvite, admin, family, mentions
    var id: String { rawValue }
}

/// Closes the containing rail page (set by the page host). Pages' back
/// buttons call this when hosted inline; falls back to dismiss() when the
/// view is presented traditionally (e.g. iPhone full-screen cover).
private struct ZKDismissPageKey: EnvironmentKey {
    static let defaultValue: (() -> Void)? = nil
}
extension EnvironmentValues {
    var zkDismissPage: (() -> Void)? {
        get { self[ZKDismissPageKey.self] }
        set { self[ZKDismissPageKey.self] = newValue }
    }
}

/// `<` back affordance shared by every rail page — phone only. On iPad/Mac
/// the page sits inline beside the always-visible server rail, so the rail
/// (tap any destination, or the same icon again) is the way out.
struct PageBackButton: View {
    @Environment(\.zkDismissPage) private var closePage
    @Environment(\.dismiss) private var dismiss
    @Environment(\.horizontalSizeClass) private var hSizeClass

    var body: some View {
        if hSizeClass != .regular {
            Button {
                if let closePage { closePage() } else { dismiss() }
            } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 16, weight: .semibold))
                    .foregroundColor(Theme.ink2)
            }
            .accessibilityLabel("Back")
        }
    }
}

/// Remaining quick utility sheets on the rail (not full pages).
private enum RailSheet: Identifiable {
    case quickSwitch, reorderServers
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
    /// Web parity (body.zk-keyboard-open hides .zk-rail-actions): the
    /// bottom action cluster ducks out while the keyboard is up.
    @State private var keyboardVisible = false
    /// Parental controls entry is opt-in (Settings → Features).
    @AppStorage("zk.showFamily") private var showFamilyButton = false

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
                        RailTile(active: store.railContent == .mentions || store.railPage == .mentions) {
                            Image(systemName: "at")
                                .font(.system(size: 19, weight: .semibold))
                        }
                    }
                    .buttonStyle(.plain)

                    // Saved messages intentionally has no rail tile — it
                    // lives in the home quick-switcher (Friends / Your
                    // events / Saved / Scheduled), like the web app.

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

                    RailIconButton(symbol: "safari", active: store.railPage == .discover) {
                        store.toggleRailPage(.discover)
                    }
                    RailIconButton(symbol: "plus", active: store.railPage == .createServer) {
                        store.toggleRailPage(.createServer)
                    }
                    RailIconButton(symbol: "link", active: store.railPage == .joinInvite) {
                        store.toggleRailPage(.joinInvite)
                    }
                }
                .padding(.vertical, 12)
            }

            Divider().overlay(Theme.line)

            if !keyboardVisible {
            VStack(spacing: 10) {
                if session.currentUser?.isAdmin == true {
                    RailIconButton(symbol: "lock.shield", active: store.railPage == .admin) {
                        store.toggleRailPage(.admin)
                    }
                }
                if showFamilyButton {
                    RailIconButton(symbol: "person.2.fill", active: store.railPage == .family) {
                        store.toggleRailPage(.family)
                    }
                }

                Button { store.toggleRailPage(.settings) } label: {
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
                    .overlay(alignment: .leading) { RailPip(active: store.railPage == .settings) }
                }
                .buttonStyle(.plain)
            }
            .padding(.vertical, 12)
            }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            withAnimation(.easeOut(duration: 0.18)) { keyboardVisible = true }
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            withAnimation(.easeOut(duration: 0.18)) { keyboardVisible = false }
        }
        .sheet(item: $railSheet) { which in
            Group {
                switch which {
                case .quickSwitch: QuickSwitcherView()
                case .reorderServers: ReorderServersView()
                }
            }
            // Re-inject explicitly: sheet hosts can lose inherited
            // environment objects on Mac when the window crosses size
            // classes (the AppStore-not-found crash).
            .environmentObject(store)
            .environmentObject(session)
            .environmentObject(store.voice)
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
    // Forwarded into the GuildSettings sheet (and its nested Members sheet) so
    // they keep env objects on "Designed for iPad on Mac".
    @EnvironmentObject private var session: Session
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
            // Guild banner — one shared 250pt height across server header,
            // server settings, profile settings, and profile view.
            if let banner = assetURL(store.selectedGuild?.bannerUrl) {
                Color.clear
                    .frame(height: 250)
                    .frame(maxWidth: .infinity)
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
            HStack(alignment: .center, spacing: 4) {
                Button { showGuildInfo = true } label: {
                    HStack(alignment: .center, spacing: 6) {
                        Text(store.selectedGuild?.name ?? "Zekktris")
                            .font(.zkSans(14, weight: .semibold))
                            .foregroundColor(Theme.ink1)
                            .lineLimit(1)
                            .minimumScaleFactor(0.65)
                            .truncationMode(.tail)
                        Image(systemName: "chevron.down")
                            .font(.system(size: 13, weight: .semibold))
                            .foregroundColor(Theme.ink2)
                        Spacer(minLength: 0)
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
            // Re-inject env objects so the nested Members/Roles sheets (and the
            // resize-driven sheet re-presentation on "Designed for iPad on Mac")
            // keep store/session/voice instead of trapping the @EnvironmentObject.
            GuildSettingsView()
                .environmentObject(store)
                .environmentObject(session)
                .environmentObject(store.voice)
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
    let content: Content
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
    @State private var showSavedSheet = false
    @State private var showScheduled = false
    @State private var showDMSearch = false

    var body: some View {
        VStack(spacing: 0) {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 2) {
                    quickRow("person.2.fill", "Friends") { showFriends = true }
                    quickRow("calendar", "Your events") { showMyEvents = true }
                    quickRow("bookmark", "Saved messages") { showSavedSheet = true }
                    quickRow("clock", "Scheduled messages") { showScheduled = true }
                    quickRow("magnifyingglass", "Search messages") { showDMSearch = true }

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
        .sheet(isPresented: $showSavedSheet) {
            SavedView()
        }
        .sheet(isPresented: $showScheduled) {
            ScheduledMessagesSheet()
        }
        .sheet(isPresented: $showDMSearch) {
            DMSearchSheet()
        }
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
                ringColor: Theme.bg2,
                toneId: dm.dmAvatarUser?.id
            )
            // Encrypted conversation: themed lock pinned to the avatar's
            // top-right, matching the message-view header.
            .overlay(alignment: .topTrailing) {
                if dm.isE2EE {
                    Image(systemName: "lock.fill")
                        .font(.system(size: 7, weight: .bold))
                        .foregroundColor(Theme.accent)
                        .frame(width: 13, height: 13)
                        .background(Theme.bg2)
                        .clipShape(Circle())
                        .overlay(Circle().strokeBorder(Theme.accent.opacity(0.45), lineWidth: 1))
                        .offset(x: 3, y: -3)
                }
            }
            Text(dm.dmTitle)
                .font(.zkSans(15, weight: unread ? .semibold : .regular))
                .foregroundColor(unread ? Theme.ink1 : Theme.ink2)
                .lineLimit(1)
            if let streak = dm.streak, streak > 0 {
                StreakChip(days: streak)
            }
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
                ToolbarItem(placement: .navigationBarLeading) { PageBackButton() }
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

/// Auto-clear choices for a custom status — mirrors the web "Clear after"
/// dropdown. `.keep` is the initial selection when an expiry already exists
/// (so a text/emoji-only edit doesn't silently wipe it) and is NOT offered as
/// a pickable menu option.
enum CustomStatusExpiryChoice: Hashable {
    case keep, off, m30, h1, h4, today, week

    /// Options shown in the menu (excludes `.keep`, which is only a start state).
    static let menuCases: [CustomStatusExpiryChoice] = [.off, .m30, .h1, .h4, .today, .week]

    var label: String {
        switch self {
        case .keep: return "Keep current"
        case .off: return "Don't clear"
        case .m30: return "30 minutes"
        case .h1: return "1 hour"
        case .h4: return "4 hours"
        case .today: return "Today"
        case .week: return "This week"
        }
    }

    /// Map to the Session save semantics, computing a concrete instant for the
    /// duration choices (matches web's computeExpiresAt).
    func resolved(now: Date = Date()) -> Session.CustomStatusExpiry {
        switch self {
        case .keep: return .keep
        case .off: return .clear
        case .m30: return .at(now.addingTimeInterval(30 * 60))
        case .h1: return .at(now.addingTimeInterval(60 * 60))
        case .h4: return .at(now.addingTimeInterval(4 * 60 * 60))
        case .today: return .at(customStatusNextLocalMidnight(after: now))
        case .week: return .at(customStatusEndOfWeekMidnight(after: now))
        }
    }
}

/// Start of tomorrow in the local calendar (= local midnight tonight).
func customStatusNextLocalMidnight(after now: Date) -> Date {
    let cal = Calendar.current
    return cal.date(byAdding: .day, value: 1, to: cal.startOfDay(for: now))
        ?? now.addingTimeInterval(86_400)
}

/// Next Sunday-midnight (start of the upcoming Monday) — mirrors the web
/// "This week" computation (tomorrow-midnight + days-until-Sunday-midnight).
func customStatusEndOfWeekMidnight(after now: Date) -> Date {
    let cal = Calendar.current
    let tomorrowMidnight = customStatusNextLocalMidnight(after: now)
    let jsDay = (cal.component(.weekday, from: now) - 1) % 7 // 0=Sun..6=Sat
    let daysUntilSundayMidnight = jsDay == 0 ? 7 : 7 - jsDay
    return cal.date(byAdding: .day, value: daysUntilSundayMidnight, to: tomorrowMidnight)
        ?? tomorrowMidnight
}

/// True if `iso` parses to an instant still in the future.
func customStatusHasFutureExpiry(_ iso: String?, now: Date = Date()) -> Bool {
    guard let iso, !iso.isEmpty else { return false }
    let fmt = ISO8601DateFormatter()
    fmt.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
    if let d = fmt.date(from: iso) { return d > now }
    fmt.formatOptions = [.withInternetDateTime]
    if let d = fmt.date(from: iso) { return d > now }
    return false
}

/// Settings / profile sheet: status, display name, custom status, account.
struct SettingsView: View {
    @EnvironmentObject private var session: Session
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var displayName = ""
    @State private var bio = ""
    @State private var bioStatus: String?
    @State private var customStatus = ""
    @State private var customStatusEmoji = ""
    @State private var customStatusExpiry: CustomStatusExpiryChoice = .keep
    @State private var showStatusEmojiPicker = false
    @State private var nameStatus: String?
    @State private var showChangePassword = false
    @State private var showChangeUsername = false
    @State private var showChangeEmail = false
    @State private var showSessions = false
    @State private var showTwoFactor = false
    @State private var showAchievements = false
    // Mic input test (record-and-discard meter; never sent). Reuses the
    // voice-message recorder's live metering — no new audio infra.
    @StateObject private var micTest = VoiceRecorder()
    @State private var faceIDOn = false
    // Local mirror for the achievements-visibility toggle, same pattern as
    // faceIDOn / displayName / customStatus above. Binding a Toggle directly
    // to session.currentUser made the knob snap back to its old position on
    // tap (the async setter returns before currentUser updates), so it read
    // as "won't turn on." The mirror updates optimistically and reconciles
    // with the server result.
    @State private var achievementsPublicOn = false
    @State private var bioProbe: Biometrics.Probe?
    @State private var avatarPickerItem: PhotosPickerItem?
    @State private var bannerPickerItem: PhotosPickerItem?
    @State private var imageUploading = false
    @AppStorage("zk.showFamily") private var showFamilyButton = false
    @AppStorage("zk.notifyMessages") private var notifyMessages = true
    @AppStorage("zk.notifyCalls") private var notifyCalls = true
    @AppStorage("zk.cameraQuality") private var cameraQuality = "high"
    @ObservedObject private var push = PushManager.shared
    @Environment(\.zkDismissPage) private var zkDismissPage

    private let statuses: [(String, String, Color)] = [
        ("Online", "online", Theme.online),
        ("Idle", "idle", Theme.idle),
        ("Do Not Disturb", "dnd", Theme.dnd),
        ("Invisible", "invisible", Theme.offline),
    ]

    /// Top-level grouping for the Settings screen so the ~12 sections aren't
    /// one long scroll. The profile header stays pinned above the tabs.
    private enum SettingsTab: String, CaseIterable, Identifiable {
        case profile = "Profile"
        case preferences = "Preferences"
        case account = "Account"
        var id: String { rawValue }
    }
    @State private var settingsTab: SettingsTab = .profile

    var body: some View {
        NavigationStack {
            ScrollView {
                LazyVStack(alignment: .leading, spacing: 22) {
                    // Profile frame is always visible — it anchors the screen
                    // and shows your avatar (with its decoration), banner, and
                    // name regardless of which tab is active.
                    profileHeader

                    Picker("Settings section", selection: $settingsTab) {
                        ForEach(SettingsTab.allCases) { tab in
                            Text(tab.rawValue).tag(tab)
                        }
                    }
                    .pickerStyle(.segmented)

                    switch settingsTab {
                    case .profile:
                        statusSection
                        displayNameSection
                        bioSection
                        customStatusSection
                        decorationSection
                        achievementsSection
                    case .preferences:
                        appearanceSection
                        notificationsSection
                        micTestSection
                        cameraSection
                        featuresSection
                    case .account:
                        securitySection
                        accountSection
                        logoutSection
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Settings")
            .navigationBarTitleDisplayMode(.inline)
            .onDisappear { micTest.cancel() } // never leave the mic open
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) { PageBackButton() }
            }
            .onAppear {
                displayName = session.currentUser?.displayName ?? ""
                bio = session.currentUser?.bio ?? ""
                customStatus = session.currentUser?.customStatus ?? ""
                customStatusEmoji = session.currentUser?.customStatusEmoji ?? ""
                // If a future auto-clear is already set, default to "keep" so a
                // text/emoji edit doesn't silently wipe it (mirrors web).
                customStatusExpiry =
                    customStatusHasFutureExpiry(session.currentUser?.customStatusExpiresAt) ? .keep : .off
                faceIDOn = session.faceIDEnabled
                achievementsPublicOn = session.currentUser?.achievementsPublic ?? false
            }
            // Keep the mirror in sync if currentUser is refreshed (e.g. the
            // background getMe on foreground) while Settings is open.
            .onChange(of: session.currentUser?.achievementsPublic) { newValue in
                achievementsPublicOn = newValue ?? false
            }
        }
    }

    private var profileHeader: some View {
        VStack(alignment: .leading, spacing: 0) {
            // Profile banner — tap (or the camera chip) to change.
            ZStack(alignment: .bottomTrailing) {
                Group {
                    if let banner = assetURL(session.currentUser?.bannerUrl) {
                        AsyncImage(url: banner) { phase in
                            if case .success(let image) = phase {
                                image.resizable().scaledToFill()
                            } else { Theme.bg3 }
                        }
                    } else {
                        LinearGradient(colors: [Theme.accent.opacity(0.35), Theme.accent2.opacity(0.25)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                    }
                }
                .frame(height: 250)
                .frame(maxWidth: .infinity)
                .clipped()

                PhotosPicker(selection: $bannerPickerItem, matching: .images) {
                    Image(systemName: "camera.fill")
                        .font(.system(size: 11, weight: .semibold))
                        .foregroundColor(Theme.ink1)
                        .frame(width: 26, height: 26)
                        .background(Color.black.opacity(0.55))
                        .clipShape(Circle())
                }
                .padding(8)
            }
            // Edge to edge: cancel the Settings content's 16pt horizontal inset
            // so the banner spans the full screen width (square, no rounding).
            .padding(.horizontal, -16)

            let user = session.currentUser
            // Mirrors the profile card: avatar halfway over the banner's
            // bottom edge, name + username to its right.
            HStack(alignment: .top, spacing: 12) {
                Avatar(
                    url: user?.avatarUrl,
                    name: user?.name ?? "?",
                    size: 76,
                    // Live presence — currentUser.status is a snapshot from
                    // launch (often 'offline' because getMe ran before the
                    // gateway identified). The presence map has the truth.
                    status: store.status(for: user?.id, fallback: user?.status),
                    // Show the selected avatar decoration here too — the
                    // header is the user's own profile frame, so the frame
                    // they pick below should be reflected.
                    decoration: user?.avatarDecoration,
                    toneId: user?.id
                )
                .padding(.top, -38)
                VStack(alignment: .leading, spacing: 2) {
                    Text(session.currentUser?.name ?? "You")
                        .font(.zkSans(18, weight: .semibold))
                        .foregroundColor(Theme.ink1)
                    if let username = session.currentUser?.username {
                        Text("@\(username)")
                            .font(.zkSans(13))
                            .foregroundColor(Theme.ink3)
                    }
                    PhotosPicker(selection: $avatarPickerItem, matching: .images) {
                        HStack(spacing: 5) {
                            Image(systemName: "photo.badge.plus")
                                .font(.system(size: 11, weight: .semibold))
                            Text("Upload Picture")
                                .font(.zkSans(12, weight: .semibold))
                        }
                        .foregroundColor(Theme.accent)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Theme.accent.opacity(0.12))
                        .clipShape(Capsule())
                    }
                    .buttonStyle(.plain)
                    .padding(.top, 4)
                }
                .padding(.top, 6)
                Spacer()
                if imageUploading { ProgressView().tint(Theme.accent) }
            }
            .padding(.leading, 6)
        }
        .onChange(of: avatarPickerItem) { item in uploadProfileImage(item, kind: "avatar") }
        .onChange(of: bannerPickerItem) { item in uploadProfileImage(item, kind: "banner") }
    }

    /// Load the picked photo and push it to the matching profile endpoint.
    private func uploadProfileImage(_ item: PhotosPickerItem?, kind: String) {
        guard let item else { return }
        imageUploading = true
        Task {
            defer { imageUploading = false; avatarPickerItem = nil; bannerPickerItem = nil }
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            let err = kind == "banner"
                ? await session.uploadBanner(filename: "banner.\(ext)", contentType: mime, data: data)
                : await session.uploadAvatar(filename: "avatar.\(ext)", contentType: mime, data: data)
            if let err { store.errorText = err }
        }
    }

    // Entry point to the full achievements gallery (earned + locked). The
    // gallery sheet loads the owner's complete catalog.
    private var achievementsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("ACHIEVEMENTS")
            Button { showAchievements = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "rosette").font(.system(size: 15)).foregroundColor(Theme.accent).frame(width: 22)
                    VStack(alignment: .leading, spacing: 1) {
                        Text("View Achievements")
                            .font(.zkSans(15)).foregroundColor(Theme.ink1)
                        Text("See what you've collected and what's left to earn.")
                            .font(.zkSans(11)).foregroundColor(Theme.ink4)
                    }
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
                }
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)
        }
        .sheet(isPresented: $showAchievements) { AchievementsGallerySheet() }
    }

    /// The status to show as selected. When the account has no status set
    /// (nil/empty — e.g. a fresh account, or the launch snapshot before the
    /// gateway identifies), default to "online" so a status is always
    /// selected rather than leaving every row unchecked.
    private var effectiveStatus: String {
        let s = session.currentUser?.status ?? ""
        // "offline" is never a deliberate choice (it's the stale pre-connect
        // snapshot) — show Online selected, matching the in-app presence.
        return (s.isEmpty || s == "offline") ? "online" : s
    }

    private var statusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("STATUS")
            ForEach(statuses, id: \.1) { label, value, color in
                Button {
                    // Surrender auto-idle control so the manual pick sticks
                    // (a manual "idle" must not be auto-bounced to "online").
                    store.noteManualStatusChange()
                    Task { await session.setStatus(value) }
                } label: {
                    HStack(spacing: 10) {
                        Circle().fill(color).frame(width: 10, height: 10)
                        Text(label).font(.zkSans(15)).foregroundColor(Theme.ink1)
                        Spacer()
                        if effectiveStatus == value {
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

    private var bioSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("ABOUT ME")
            TextField("A short blurb about yourself", text: $bio, axis: .vertical)
                .lineLimit(3...6)
                .padding(12)
                .background(Theme.bg2)
                .clipShape(RoundedRectangle(cornerRadius: 10))
                .foregroundColor(Theme.ink1)
                .onChange(of: bio) { newValue in
                    // Hard cap mirrors the server's BIO_MAX_LENGTH (200) —
                    // the web editor uses the same limit. A higher cap here
                    // just invited 400s on Save for 201–500-char bios.
                    if newValue.count > 200 { bio = String(newValue.prefix(200)) }
                }
            HStack {
                Text("\(bio.count)/200").font(.zkSans(11)).foregroundColor(Theme.ink3)
                Spacer()
                Button {
                    let b = bio
                    Task { bioStatus = await session.updateBio(b) ?? "Saved." }
                } label: {
                    Text("Save")
                        .font(.zkSans(14, weight: .semibold))
                        .foregroundColor(.white)
                        .padding(.horizontal, 14)
                        .padding(.vertical, 10)
                        .background(Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
            if let bioStatus {
                Text(bioStatus).font(.zkSans(12)).foregroundColor(Theme.ink2)
            }
        }
    }

    private var customStatusSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("CUSTOM STATUS")
            HStack(spacing: 8) {
                // Opens the same emoji picker used for reactions instead
                // of a free-text field (typing an emoji by hand was the
                // only way before).
                Button {
                    showStatusEmojiPicker = true
                } label: {
                    Text(customStatusEmoji.isEmpty ? "🙂" : customStatusEmoji)
                        .font(.system(size: 20))
                        .opacity(customStatusEmoji.isEmpty ? 0.45 : 1)
                        .frame(width: 48)
                        .padding(.vertical, 10)
                        .background(Theme.bg2)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain)
                .sheet(isPresented: $showStatusEmojiPicker) {
                    EmojiPickerSheet { emoji in
                        customStatusEmoji = emoji
                        showStatusEmojiPicker = false
                    }
                }
                TextField("What's happening?", text: $customStatus)
                    .padding(12)
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 10))
                    .foregroundColor(Theme.ink1)
                Button {
                    let s = customStatus
                    let e = customStatusEmoji
                    let exp = customStatusExpiry.resolved()
                    Task { await session.setCustomStatus(s, emoji: e, expiry: exp) }
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
            // Auto-clear duration. Matches the web "Clear after" dropdown.
            Text("CLEAR AFTER").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            Menu {
                ForEach(CustomStatusExpiryChoice.menuCases, id: \.self) { choice in
                    Button(choice.label) { customStatusExpiry = choice }
                }
            } label: {
                HStack {
                    Text(customStatusExpiry.label).foregroundColor(Theme.ink1)
                    Spacer()
                    Image(systemName: "chevron.up.chevron.down")
                        .font(.system(size: 12)).foregroundColor(Theme.ink3)
                }
                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            if !customStatus.isEmpty || !customStatusEmoji.isEmpty {
                Button {
                    customStatus = ""
                    customStatusEmoji = ""
                    customStatusExpiry = .off
                    // Clearing the status also clears any auto-clear timer.
                    Task { await session.setCustomStatus(nil, emoji: nil, expiry: .clear) }
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
            // Two condensed rows (scrolls horizontally when the width can't
            // fit all six columns).
            ScrollView(.horizontal, showsIndicators: false) {
                LazyHGrid(rows: [GridItem(.fixed(86), spacing: 8), GridItem(.fixed(86), spacing: 8)], spacing: 8) {
                    ForEach(ZKThemes) { opt in
                        themeCard(opt)
                    }
                }
                .padding(.vertical, 2)
            }
        }
    }

    private func themeCard(_ opt: ThemeOption) -> some View {
        let pal = ThemePalette.palette(for: opt.id)
        let selected = store.themeId == opt.id
        return Button { store.setTheme(opt.id) } label: {
            VStack(spacing: 6) {
                ZStack {
                    Circle().fill(pal.bg0).frame(width: 30, height: 30)
                        .overlay(Circle().stroke(Theme.line, lineWidth: 1))
                    HStack(spacing: -5) {
                        Circle().fill(pal.accent).frame(width: 13, height: 13)
                        Circle().fill(pal.accent2).frame(width: 13, height: 13)
                    }
                    if selected {
                        Image(systemName: "checkmark.circle.fill")
                            .font(.system(size: 13))
                            .foregroundColor(Theme.accent)
                            .background(Circle().fill(Theme.bg1))
                            .offset(x: 11, y: -11)
                    }
                }
                Text(opt.label)
                    .font(.zkSans(10, weight: .medium))
                    .foregroundColor(selected ? Theme.ink1 : Theme.ink3)
                    .lineLimit(1)
            }
            .frame(width: 84, height: 78)
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
            // Wrapping grid — never runs off the trailing edge.
            LazyVGrid(columns: [GridItem(.adaptive(minimum: 72), spacing: 8)], spacing: 8) {
                ForEach(Avatar.decorations, id: \.id) { d in
                    Button { Task { await session.setAvatarDecoration(d.id) } } label: {
                        VStack(spacing: 5) {
                            Avatar(url: session.currentUser?.avatarUrl, name: session.currentUser?.name ?? "?", size: 46, decoration: d.id)
                            Text(d.label).font(.zkSans(10)).foregroundColor(Theme.ink3).lineLimit(1)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 8)
                        .background((session.currentUser?.avatarDecoration ?? "none") == d.id ? Theme.bg3 : Theme.bg2.opacity(0.5))
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }
                    .buttonStyle(.plain)
                }
            }
        }
    }

    /// Log Out lives at the very bottom of Settings.
    private var logoutSection: some View {
        Button(role: .destructive) {
            (zkDismissPage ?? {})()
            session.logout()
        } label: {
            Label("Log Out", systemImage: "rectangle.portrait.and.arrow.right")
                .font(.zkSans(15, weight: .semibold))
                .foregroundColor(Theme.danger)
                .frame(maxWidth: .infinity)
                .padding(.vertical, 13)
                .background(Theme.danger.opacity(0.1))
                .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        }
        .buttonStyle(.plain)
        .padding(.top, 8)
    }

    private var notificationsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("NOTIFICATIONS")

            // Permission status + the action that actually fixes it.
            HStack(spacing: 10) {
                Image(systemName: permissionIcon)
                    .font(.system(size: 15))
                    .foregroundColor(permissionColor)
                    .frame(width: 22)
                VStack(alignment: .leading, spacing: 1) {
                    Text(permissionLabel)
                        .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                    Text(push.registeredWithServer
                         ? "This device is registered for pushes."
                         : push.serverPushUnavailable
                           ? "The server doesn't have push notifications set up."
                           : "Device not registered with the server yet.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
                Spacer()
                switch push.authStatus {
                case .notDetermined:
                    Button("Enable") { push.requestAuthorizationAndRegister() }
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.accent)
                case .denied:
                    Button("Open Settings") { push.openSystemSettings() }
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.accent)
                default:
                    if !push.registeredWithServer {
                        Button("Retry") { push.registerWithServerIfPossible(force: true) }
                            .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.accent)
                    }
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))

            Toggle(isOn: $notifyMessages) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Messages & mentions")
                        .font(.zkSans(15)).foregroundColor(Theme.ink1)
                    Text("Direct messages and @mentions.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
            }
            .tint(Theme.accent)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))

            Toggle(isOn: $notifyCalls) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Incoming calls")
                        .font(.zkSans(15)).foregroundColor(Theme.ink1)
                    Text("Ring for 1-on-1 calls.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
            }
            .tint(Theme.accent)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))

            Text("Sound, lock-screen style, and badges are controlled in iOS Settings → Notifications → Zekktris.")
                .font(.zkSans(11)).foregroundColor(Theme.ink4)
        }
        .onAppear { push.refreshStatus() }
    }

    private var permissionLabel: String {
        switch push.authStatus {
        case .authorized, .provisional, .ephemeral: return "Notifications enabled"
        case .denied: return "Notifications are off in iOS Settings"
        default: return "Notifications not set up"
        }
    }
    private var permissionIcon: String {
        switch push.authStatus {
        case .authorized, .provisional, .ephemeral: return "bell.badge.fill"
        case .denied: return "bell.slash.fill"
        default: return "bell"
        }
    }
    private var permissionColor: Color {
        switch push.authStatus {
        case .authorized, .provisional, .ephemeral: return Theme.success
        case .denied: return Theme.dangerSoft
        default: return Theme.ink3
        }
    }

    // Mic input test. Mirrors web's MicLevelMeter (voice settings): a live
    // level indicator so the user can confirm their mic picks up sound,
    // independent of any call. Reuses VoiceRecorder's AVAudioRecorder
    // metering and the WaveformBars view from the voice-message composer; the
    // recording is discarded (cancel) and never sent. Mic permission is
    // already declared for voice/voice-messages, so nothing new is needed.
    private var micTestInActiveCall: Bool { store.activeVoiceOrStageId != nil }
    private var micTestLevel: CGFloat { micTest.levels.last ?? 0 }

    private var micTestSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("MICROPHONE")
            VStack(alignment: .leading, spacing: 10) {
                if micTestInActiveCall {
                    HStack(spacing: 8) {
                        Image(systemName: "mic.slash").font(.system(size: 14)).foregroundColor(Theme.ink3)
                        Text("Your mic is in use by an active call.")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    }
                } else {
                    Text("Test your mic — the meter moves when it picks up sound. Nothing is recorded or sent.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)

                    // Instantaneous level bar (follows current RMS, like web's
                    // horizontal meter).
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.bg3)
                            Capsule().fill(Theme.accent)
                                .frame(width: max(0, min(1, micTestLevel)) * geo.size.width)
                                .animation(.linear(duration: 0.05), value: micTestLevel)
                        }
                    }
                    .frame(height: 8)

                    // Recent-history bars — the same visual the voice-message
                    // recorder uses, so the meter feels native.
                    WaveformBars(
                        levels: micTest.levels.isEmpty ? [0.04] : micTest.levels,
                        progress: 0,
                        activeColor: Theme.accent2,
                        inactiveColor: Theme.accent2
                    )
                    .frame(height: 28)
                    .opacity(micTest.recording ? 1 : 0.4)

                    Button {
                        if micTest.recording { micTest.cancel() } else { micTest.start() }
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: micTest.recording ? "stop.fill" : "mic.fill")
                                .font(.system(size: 14))
                            Text(micTest.recording ? "Stop Test" : "Test Microphone")
                                .font(.zkSans(15, weight: .semibold))
                        }
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity).padding(.vertical, 11)
                        .background(micTest.recording ? Theme.danger : Theme.accent)
                        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(12)
            .background(Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private var cameraSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("CAMERA")
            VStack(alignment: .leading, spacing: 10) {
                Picker("Quality", selection: $cameraQuality) {
                    ForEach(CameraQuality.allCases) { q in
                        Text(q.shortLabel).tag(q.rawValue)
                    }
                }
                .pickerStyle(.segmented)
                Text((CameraQuality(rawValue: cameraQuality) ?? .high).detail)
                    .font(.zkSans(12)).foregroundColor(Theme.ink3)
                Text("Video uses hardware H.264. Changes apply the next time you turn your camera on.")
                    .font(.zkSans(11)).foregroundColor(Theme.ink4)
            }
            .padding(12)
            .background(Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }

    private var featuresSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("FEATURES")
            Toggle(isOn: $showFamilyButton) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Parental controls")
                        .font(.zkSans(15)).foregroundColor(Theme.ink1)
                    Text("Show the Family button on the server rail.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
            }
            .tint(Theme.accent)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))

            // Persists through the same durable path as every other profile
            // setting: PATCH /users/@me writes it back to currentUser, which is
            // re-hydrated from GET /users/@me on every launch. (Previously this
            // read its state from the /achievements endpoint, whose shelf
            // computation could fail and report public:false even when the
            // column was true — making the toggle appear not to persist.)
            Toggle(isOn: Binding(
                get: { achievementsPublicOn },
                set: { newValue in
                    achievementsPublicOn = newValue // optimistic — reflect the tap immediately
                    Task {
                        await session.setAchievementsPublic(newValue)
                        // Reconcile with the server's persisted value; reverts
                        // the knob if the write failed.
                        achievementsPublicOn = session.currentUser?.achievementsPublic ?? false
                    }
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Public achievements")
                        .font(.zkSans(15)).foregroundColor(Theme.ink1)
                    Text("Let others see your achievements on your profile. Off keeps them private to you.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
            }
            .tint(Theme.accent)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
        }
    }

    private var securitySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("SECURITY")
            // bioProbe resolves off-main in .task — probing LocalAuthentication
            // inline here blocked the main thread and froze Settings open.
            if let probe = bioProbe {
                if probe.available {
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
                            Text("Unlock with \(probe.label)")
                                .font(.zkSans(15)).foregroundColor(Theme.ink1)
                            Text("Require \(probe.label) when opening Zekktris")
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
            } else {
                HStack(spacing: 8) {
                    ProgressView().scaleEffect(0.8)
                    Text("Checking biometric availability…")
                        .font(.zkSans(13)).foregroundColor(Theme.ink4)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 12).padding(.vertical, 10)
                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .task { bioProbe = await Biometrics.resolve() }
    }

    private var accountSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionTitle("ACCOUNT")
            accountRow(label: "Username", value: session.currentUser?.username.map { "@\($0)" } ?? "—",
                       changeAction: { showChangeUsername = true })
            accountRow(label: "Email", value: session.currentUser?.email ?? "—",
                       changeAction: { showChangeEmail = true })
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

            Button { showSessions = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "lock.shield").font(.system(size: 14)).foregroundColor(Theme.ink3).frame(width: 20)
                    Text("Active Sessions").font(.system(size: 15)).foregroundColor(Theme.ink1)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
                }
                .padding(.horizontal, 12).padding(.vertical, 12)
                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)

            Button { showTwoFactor = true } label: {
                HStack(spacing: 10) {
                    Image(systemName: "lock.rotation").font(.system(size: 14)).foregroundColor(Theme.ink3).frame(width: 20)
                    Text("Two-Factor Authentication").font(.system(size: 15)).foregroundColor(Theme.ink1)
                    Spacer()
                    Image(systemName: "chevron.right").font(.system(size: 12)).foregroundColor(Theme.ink4)
                }
                .padding(.horizontal, 12).padding(.vertical, 12)
                .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
            }
            .buttonStyle(.plain)

        }
        .sheet(isPresented: $showChangePassword) { ChangePasswordSheet() }
        .sheet(isPresented: $showChangeUsername) { ChangeUsernameSheet() }
        .sheet(isPresented: $showChangeEmail) { ChangeEmailSheet() }
        .sheet(isPresented: $showSessions) { SessionsSheet() }
        .sheet(isPresented: $showTwoFactor) { TwoFactorSheet() }
    }

    private func accountRow(label: String, value: String, copyable: Bool = false, mono: Bool = false,
                            changeAction: (() -> Void)? = nil) -> some View {
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
            if let changeAction {
                Button(action: changeAction) {
                    Text("Change")
                        .font(.zkSans(12, weight: .semibold))
                        .foregroundColor(Theme.accent)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(Theme.accent.opacity(0.12))
                        .clipShape(Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
    }

    private func sectionTitle(_ t: String) -> some View {
        Text(t).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
    }
}

/// Lists the user's active auth sessions (GET /users/@me/sessions) with a
/// per-session revoke action (DELETE /users/@me/sessions/:id). The current
/// session is flagged and can't be revoked from here — matching the server,
/// which keeps the caller's own session and only lets you drop others.
struct SessionsSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var revoking: Set<String> = []

    var body: some View {
        NavigationStack {
            Group {
                if store.sessionsLoading && store.sessions.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if store.sessions.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "lock.shield")
                            .font(.system(size: 30, weight: .light))
                            .foregroundColor(Theme.ink3)
                        Text("No active sessions")
                            .font(.zkSans(14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        LazyVStack(alignment: .leading, spacing: 8) {
                            // Current session first, then most-recently-active.
                            ForEach(sortedSessions) { s in
                                sessionRow(s)
                            }
                        }
                        .padding(12)
                    }
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Active Sessions").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await store.loadSessions() }
            .refreshable { await store.loadSessions() }
        }
    }

    private var sortedSessions: [UserSession] {
        // Current session first, then most-recently-active. ISO-8601 strings
        // sort chronologically as plain text, so a > b ⇒ a is more recent.
        store.sessions.sorted { a, b in
            if a.current != b.current { return a.current }
            return a.lastUsedAt > b.lastUsedAt
        }
    }

    private func sessionRow(_ s: UserSession) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: deviceIcon(s.userAgent))
                .font(.system(size: 16)).foregroundColor(Theme.accent).frame(width: 22)
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(deviceLabel(s.userAgent))
                        .font(.zkSans(14, weight: .semibold)).foregroundColor(Theme.ink1)
                        .lineLimit(1)
                    if s.current {
                        Text("THIS DEVICE")
                            .font(.zkSans(9, weight: .bold)).foregroundColor(Theme.accent)
                            .padding(.horizontal, 6).padding(.vertical, 2)
                            .background(Theme.accent.opacity(0.15))
                            .clipShape(Capsule())
                    }
                }
                if let ip = s.ipAddress, !ip.isEmpty {
                    Text(ip).font(.zkMono(11)).foregroundColor(Theme.ink3)
                }
                Text("Last active \(relativeLabel(s.lastUsedAt))")
                    .font(.zkSans(11)).foregroundColor(Theme.ink3)
            }
            Spacer(minLength: 8)
            if !s.current {
                if revoking.contains(s.id) {
                    ProgressView().scaleEffect(0.8).frame(width: 28, height: 28)
                } else {
                    Button(role: .destructive) {
                        revoking.insert(s.id)
                        Task {
                            await store.revokeSession(s)
                            revoking.remove(s.id)
                        }
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 16)).foregroundColor(Theme.dangerSoft)
                    }
                    .buttonStyle(.plain)
                }
            }
        }
        .padding(12)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: Theme.rMD, style: .continuous))
    }

    // ── Display helpers (best-effort parse of the User-Agent) ───────────────

    private func relativeLabel(_ iso: String) -> String {
        guard let d = messageDate(iso) else { return "unknown" }
        return Self.relFormatter.localizedString(for: d, relativeTo: Date())
    }

    private static let relFormatter: RelativeDateTimeFormatter = {
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .full
        return f
    }()

    private func deviceLabel(_ ua: String?) -> String {
        guard let ua = ua, !ua.isEmpty else { return "Unknown device" }
        if ua.contains("Zekktris") { return "Zekktris (iOS app)" }
        // Ordered most-specific-first: Chrome UAs also contain "Safari", Edge
        // contains "Chrome", etc., so a dictionary's arbitrary order would
        // mislabel. Check the distinctive token first.
        let browser = [("Edg", "Edge"), ("OPR", "Opera"), ("Firefox", "Firefox"),
                       ("Chrome", "Chrome"), ("Safari", "Safari")]
            .first { ua.contains($0.0) }?.1
        let os = [("iPhone", "iPhone"), ("iPad", "iPad"), ("Mac OS X", "macOS"),
                  ("Macintosh", "macOS"), ("Windows", "Windows"),
                  ("Android", "Android"), ("Linux", "Linux")]
            .first { ua.contains($0.0) }?.1
        switch (browser, os) {
        case let (b?, o?): return "\(b) on \(o)"
        case let (b?, nil): return b
        case let (nil, o?): return o
        default: return String(ua.prefix(40))
        }
    }

    private func deviceIcon(_ ua: String?) -> String {
        guard let ua = ua else { return "globe" }
        if ua.contains("Zekktris") || ua.contains("iPhone") { return "iphone" }
        if ua.contains("iPad") { return "ipad" }
        if ua.contains("Macintosh") || ua.contains("Mac OS X") || ua.contains("Windows") || ua.contains("Linux") {
            return "laptopcomputer"
        }
        if ua.contains("Android") { return "candybarphone" }
        return "globe"
    }
}

/// TOTP two-factor enrollment + management. Mirrors web's TwoFactorSection
/// (SettingsView.tsx): status row, enroll (QR + secret + 6-digit confirm →
/// one-time recovery codes), and disable (current code or recovery code).
/// Same endpoints web uses (GET/POST /users/@me/totp[/begin|confirm|disable]).
struct TwoFactorSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss

    @State private var status: TwoFactorStatus?
    @State private var loading = true
    @State private var setup: TwoFactorSecret?
    @State private var code = ""
    @State private var submitting = false
    @State private var recoveryCodes: [String]?
    @State private var disabling = false
    @State private var disableCode = ""
    @State private var errorText: String?

    private let cols = [GridItem(.flexible()), GridItem(.flexible())]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    if loading && status == nil {
                        ProgressView().tint(Theme.accent)
                            .frame(maxWidth: .infinity).padding(.vertical, 40)
                    } else if let status {
                        statusCard(status)
                        if let setup { enrollCard(setup) }
                        if let recoveryCodes { recoveryCard(recoveryCodes) }
                        if disabling { disableCard }
                        if let errorText {
                            Text(errorText).font(.zkSans(13)).foregroundColor(Theme.danger)
                        }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Two-Factor Authentication").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await load() }
        }
    }

    // MARK: Cards

    private func statusCard(_ s: TwoFactorStatus) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 3) {
                    Text(s.enabled ? "Enabled" : "Not enabled")
                        .font(.zkSans(15, weight: .semibold)).foregroundColor(Theme.ink1)
                    Text(s.enabled
                         ? "Account protected by an authenticator app. \(s.recoveryRemaining) recovery \(s.recoveryRemaining == 1 ? "code" : "codes") remaining."
                         : "Add a second factor using an authenticator app like 1Password, Authy, or Google Authenticator.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3).fixedSize(horizontal: false, vertical: true)
                }
                Spacer(minLength: 8)
                if !s.enabled && setup == nil {
                    Button("Set Up") { Task { await beginSetup() } }
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
                } else if s.enabled && !disabling {
                    Button("Disable") { disabling = true; errorText = nil }
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.dangerSoft)
                        .padding(.horizontal, 12).padding(.vertical, 8)
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.danger.opacity(0.4), lineWidth: 1))
                }
            }
        }
        .padding(12)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func enrollCard(_ s: TwoFactorSecret) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Scan with your authenticator")
                .font(.zkSans(14, weight: .semibold)).foregroundColor(Theme.ink1)
            if let qr = qrCodeImage(s.otpauthUri) {
                Image(uiImage: qr)
                    .interpolation(.none).resizable().scaledToFit()
                    .frame(width: 200, height: 200)
                    .padding(8).background(Color.white)
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .frame(maxWidth: .infinity)
            }
            Text("Can't scan? Paste this secret into your authenticator:")
                .font(.zkSans(12)).foregroundColor(Theme.ink3)
            Button { UIPasteboard.general.string = s.secret } label: {
                HStack {
                    Text(s.secret).font(.zkMono(12)).foregroundColor(Theme.ink2)
                        .multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                    Spacer()
                    Image(systemName: "doc.on.doc").font(.system(size: 12)).foregroundColor(Theme.ink3)
                }
                .padding(.horizontal, 10).padding(.vertical, 9)
                .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 8))
            }
            .buttonStyle(.plain)

            Text("ENTER THE 6-DIGIT CODE FROM YOUR APP")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            TextField("123456", text: $code)
                .keyboardType(.numberPad).textContentType(.oneTimeCode)
                .font(.zkMono(18)).multilineTextAlignment(.center)
                .foregroundColor(Theme.ink1).padding(.vertical, 11)
                .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 10))
                .onChange(of: code) { newValue in
                    code = String(newValue.filter(\.isNumber).prefix(6))
                }
            HStack {
                Spacer()
                Button("Cancel") { setup = nil; code = ""; errorText = nil }
                    .font(.zkSans(14)).foregroundColor(Theme.ink2)
                Button { Task { await confirmSetup() } } label: {
                    Text(submitting ? "Verifying…" : "Verify & Enable")
                        .font(.zkSans(14, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(code.count == 6 ? Theme.accent : Theme.bg3)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(submitting || code.count != 6)
            }
        }
        .padding(12)
        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private func recoveryCard(_ codes: [String]) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(.system(size: 13)).foregroundColor(Theme.idle)
                Text("Save these recovery codes now. Each works once if you lose access to your authenticator. They won't be shown again.")
                    .font(.zkSans(12)).foregroundColor(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            }
            LazyVGrid(columns: cols, spacing: 6) {
                ForEach(codes, id: \.self) { c in
                    Text(c).font(.zkMono(13)).foregroundColor(Theme.ink1)
                        .frame(maxWidth: .infinity).padding(.vertical, 7)
                        .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 8))
                }
            }
            HStack {
                Spacer()
                Button("Copy All") { UIPasteboard.general.string = codes.joined(separator: "\n") }
                    .font(.zkSans(13)).foregroundColor(Theme.ink2)
                Button("I've Saved Them") { recoveryCodes = nil }
                    .font(.zkSans(13, weight: .semibold)).foregroundColor(.white)
                    .padding(.horizontal, 12).padding(.vertical, 7)
                    .background(Theme.accent).clipShape(RoundedRectangle(cornerRadius: 10))
            }
        }
        .padding(12)
        .background(Theme.idle.opacity(0.08))
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.idle.opacity(0.35), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    private var disableCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Enter a current 6-digit code or one of your recovery codes to disable two-factor authentication.")
                .font(.zkSans(12)).foregroundColor(Theme.ink2).fixedSize(horizontal: false, vertical: true)
            TextField("123456 or recovery code", text: $disableCode)
                .autocorrectionDisabled().textInputAutocapitalization(.never)
                .font(.zkMono(15)).foregroundColor(Theme.ink1).padding(.vertical, 11).padding(.horizontal, 12)
                .background(Theme.bg1).clipShape(RoundedRectangle(cornerRadius: 10))
            HStack {
                Spacer()
                Button("Cancel") { disabling = false; disableCode = ""; errorText = nil }
                    .font(.zkSans(14)).foregroundColor(Theme.ink2)
                Button { Task { await confirmDisable() } } label: {
                    Text(submitting ? "Disabling…" : "Disable 2FA")
                        .font(.zkSans(14, weight: .semibold)).foregroundColor(.white)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(disableCode.trimmingCharacters(in: .whitespaces).isEmpty ? Theme.bg3 : Theme.danger)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .disabled(submitting || disableCode.trimmingCharacters(in: .whitespaces).isEmpty)
            }
        }
        .padding(12)
        .background(Theme.bg2)
        .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(Theme.danger.opacity(0.3), lineWidth: 1))
        .clipShape(RoundedRectangle(cornerRadius: 12))
    }

    // MARK: Actions

    private func load() async {
        loading = true
        defer { loading = false }
        status = try? await store.api.twoFactorStatus()
        if status == nil { status = TwoFactorStatus(enabled: false, verifiedAt: nil, recoveryRemaining: 0) }
    }

    private func beginSetup() async {
        errorText = nil
        do { setup = try await store.api.beginTwoFactor(); code = "" }
        catch { errorText = (error as? APIError)?.message ?? "Failed to start enrollment." }
    }

    private func confirmSetup() async {
        guard !submitting, code.count == 6 else { return }
        submitting = true
        defer { submitting = false }
        do {
            let r = try await store.api.confirmTwoFactor(code: code)
            recoveryCodes = r.recoveryCodes
            setup = nil; code = ""; errorText = nil
            await load()
        } catch {
            errorText = (error as? APIError)?.message ?? "Invalid code."
        }
    }

    private func confirmDisable() async {
        let c = disableCode.trimmingCharacters(in: .whitespaces)
        guard !submitting, !c.isEmpty else { return }
        submitting = true
        defer { submitting = false }
        do {
            try await store.api.disableTwoFactor(code: c)
            disabling = false; disableCode = ""; errorText = nil
            await load()
        } catch {
            errorText = (error as? APIError)?.message ?? "Invalid code."
        }
    }
}

/// Change the account username (server: 90-day cooldown, requires the
/// current password).
struct ChangeUsernameSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var username = ""
    @State private var password = ""
    @State private var error: String?
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    VStack(alignment: .leading, spacing: 6) {
                        Text("NEW USERNAME").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        HStack(spacing: 6) {
                            Text("@").foregroundColor(Theme.ink3)
                            TextField("username", text: $username)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .foregroundColor(Theme.ink1)
                        }
                        .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    VStack(alignment: .leading, spacing: 6) {
                        Text("CURRENT PASSWORD").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        SecureField("Password", text: $password)
                            .foregroundColor(Theme.ink1)
                            .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    Text("Usernames can be changed once every 90 days.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    if let error {
                        Text(error).font(.zkSans(13)).foregroundColor(Theme.dangerSoft)
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Change Username").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { submit() }
                        .disabled(busy || username.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                }
            }
        }
    }

    private func submit() {
        busy = true; error = nil
        Task {
            let result = await session.changeUsername(
                username.trimmingCharacters(in: .whitespaces), currentPassword: password)
            busy = false
            if let result { error = result } else { dismiss() }
        }
    }
}

/// Request an email change (server mails a verification link to the NEW
/// address; the address switches only after it's confirmed).
struct ChangeEmailSheet: View {
    @EnvironmentObject private var session: Session
    @Environment(\.dismiss) private var dismiss
    @State private var email = ""
    @State private var password = ""
    @State private var error: String?
    @State private var sent = false
    @State private var busy = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    if sent {
                        VStack(spacing: 10) {
                            Image(systemName: "envelope.badge")
                                .font(.system(size: 34)).foregroundColor(Theme.accent)
                            Text("Check your inbox")
                                .font(.zkSans(17, weight: .semibold)).foregroundColor(Theme.ink1)
                            Text("We sent a verification link to \(email). Your email updates once you confirm it there.")
                                .font(.zkSans(13)).foregroundColor(Theme.ink3)
                                .multilineTextAlignment(.center)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.top, 28)
                    } else {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("NEW EMAIL").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            TextField("new@email.com", text: $email)
                                .keyboardType(.emailAddress)
                                .textInputAutocapitalization(.never)
                                .autocorrectionDisabled()
                                .foregroundColor(Theme.ink1)
                                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        VStack(alignment: .leading, spacing: 6) {
                            Text("CURRENT PASSWORD").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            SecureField("Password", text: $password)
                                .foregroundColor(Theme.ink1)
                                .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                        Text("We'll email a verification link to the new address — it only takes effect once confirmed.")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)
                        if let error {
                            Text(error).font(.zkSans(13)).foregroundColor(Theme.dangerSoft)
                        }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Change Email").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button(sent ? "Done" : "Cancel") { dismiss() } }
                if !sent {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Send Link") { submit() }
                            .disabled(busy || email.trimmingCharacters(in: .whitespaces).isEmpty || password.isEmpty)
                    }
                }
            }
        }
    }

    private func submit() {
        busy = true; error = nil
        Task {
            let result = await session.requestEmailChange(
                email.trimmingCharacters(in: .whitespaces), currentPassword: password)
            busy = false
            if let result { error = result } else { sent = true }
        }
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
            // Back affordance for the compact full-screen-cover presentation
            // (matches every other rail-page host). Self-hides on wide, where
            // Mentions fills the detail pane and is exited via the rail.
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { PageBackButton() } }
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
    var active: Bool = false
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            RailTile(active: active) {
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
    // Optional server picture + banner (uploaded to the new guild after create).
    @State private var iconItem: PhotosPickerItem?
    @State private var bannerItem: PhotosPickerItem?
    @State private var iconData: Data?
    @State private var bannerData: Data?
    @State private var iconExt = "jpg"
    @State private var iconMime = "image/jpeg"
    @State private var bannerExt = "jpg"
    @State private var bannerMime = "image/jpeg"
    // Import-from-file flow (template or backup — same on-disk JSON format).
    @State private var showImporter = false
    @State private var importing = false
    @State private var importError: String?

    private var canCreate: Bool { !name.trimmingCharacters(in: .whitespaces).isEmpty }
    private var anyBusy: Bool { busy || importing }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    Text("Give your server a name. You can change it later.")
                        .font(.zkSans(14)).foregroundColor(Theme.ink3)
                    serverImagePickers
                    field("SERVER NAME") { TextField("My cool server", text: $name) }
                    field("DESCRIPTION (OPTIONAL)") {
                        TextField("What's it about?", text: $serverDescription, axis: .vertical).lineLimit(2...4)
                    }
                    Button {
                        busy = true
                        Task {
                            let icon = iconData.map { (data: $0, ext: iconExt, mime: iconMime) }
                            let banner = bannerData.map { (data: $0, ext: bannerExt, mime: bannerMime) }
                            await store.createServer(name: name, description: serverDescription,
                                                     icon: icon, banner: banner)
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
                    .disabled(!canCreate || anyBusy)

                    importSection
                }
                .padding(20)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Create a Server").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { PageBackButton() } }
            .fileImporter(
                isPresented: $showImporter,
                allowedContentTypes: [.json],
                allowsMultipleSelection: false
            ) { result in onImportFile(result) }
        }
    }

    /// Optional server picture + banner. A banner strip with the round server
    /// picture overhanging its bottom-left — mirrors the profile header. Both
    /// optional; tapping either opens the photo picker.
    private var serverImagePickers: some View {
        ZStack(alignment: .bottomLeading) {
            PhotosPicker(selection: $bannerItem, matching: .images) {
                Group {
                    if let bannerData, let ui = UIImage(data: bannerData) {
                        Image(uiImage: ui).resizable().scaledToFill()
                    } else {
                        LinearGradient(colors: [Theme.accent.opacity(0.35), Theme.accent2.opacity(0.25)],
                                       startPoint: .topLeading, endPoint: .bottomTrailing)
                            .overlay {
                                Label("Add banner", systemImage: "photo")
                                    .font(.zkSans(12, weight: .semibold)).foregroundColor(Theme.ink2)
                            }
                    }
                }
                .frame(height: 110).frame(maxWidth: .infinity).clipped()
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .buttonStyle(.plain)

            PhotosPicker(selection: $iconItem, matching: .images) {
                ZStack {
                    if let iconData, let ui = UIImage(data: iconData) {
                        Image(uiImage: ui).resizable().scaledToFill()
                    } else {
                        Theme.bg3.overlay {
                            Image(systemName: "camera.fill")
                                .font(.system(size: 16)).foregroundColor(Theme.ink2)
                        }
                    }
                }
                .frame(width: 64, height: 64).clipShape(Circle())
                .overlay(Circle().stroke(Theme.bg1, lineWidth: 4))
            }
            .buttonStyle(.plain)
            .offset(x: 12, y: 20)
        }
        .padding(.bottom, 20)
        .onChange(of: iconItem) { item in loadServerImage(item, isIcon: true) }
        .onChange(of: bannerItem) { item in loadServerImage(item, isIcon: false) }
    }

    private func loadServerImage(_ item: PhotosPickerItem?, isIcon: Bool) {
        guard let item else { return }
        Task {
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            let t = item.supportedContentTypes.first
            let ext = t?.preferredFilenameExtension ?? "jpg"
            let mime = t?.preferredMIMEType ?? "image/jpeg"
            if isIcon { iconData = data; iconExt = ext; iconMime = mime }
            else { bannerData = data; bannerExt = ext; bannerMime = mime }
        }
    }

    // Import a template/backup file → POST /guilds/import. Mirrors web's
    // create-server import: the name typed above (if any) overrides the file's
    // stored name; both template and backup files share this one JSON format.
    @ViewBuilder
    private var importSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Rectangle().fill(Theme.bg3).frame(height: 1)
                Text("OR").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink4)
                Rectangle().fill(Theme.bg3).frame(height: 1)
            }
            .padding(.vertical, 4)

            Text("Import a template or backup file (.json). Uses the file's name unless you typed one above.")
                .font(.zkSans(13)).foregroundColor(Theme.ink3)

            Button {
                importError = nil
                showImporter = true
            } label: {
                HStack(spacing: 8) {
                    if importing {
                        ProgressView().scaleEffect(0.85)
                    } else {
                        Image(systemName: "square.and.arrow.down").font(.system(size: 15))
                    }
                    Text(importing ? "Importing…" : "Import from a file")
                        .font(.zkSans(15, weight: .semibold))
                }
                .foregroundColor(Theme.ink1)
                .frame(maxWidth: .infinity).padding(.vertical, 13)
                .background(Theme.bg2)
                .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous).stroke(Theme.bg3, lineWidth: 1))
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .disabled(anyBusy)

            if let importError {
                Text(importError).font(.zkSans(13)).foregroundColor(Theme.danger)
            }
        }
    }

    private func onImportFile(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            importError = error.localizedDescription
        case .success(let urls):
            guard let url = urls.first else { return }
            importing = true
            importError = nil
            Task {
                defer { importing = false }
                // Files picked from iCloud Drive / the Files app live outside
                // the sandbox — must hold a security-scoped resource to read.
                let scoped = url.startAccessingSecurityScopedResource()
                defer { if scoped { url.stopAccessingSecurityScopedResource() } }
                let data: Data
                do {
                    data = try Data(contentsOf: url)
                } catch {
                    importError = "Couldn't read that file"
                    return
                }
                guard (try? JSONSerialization.jsonObject(with: data)) != nil else {
                    importError = "That file isn't valid JSON"
                    return
                }
                let typed = name.trimmingCharacters(in: .whitespaces)
                if let err = await store.importServer(backup: data, name: typed.isEmpty ? nil : typed) {
                    importError = err
                } else {
                    dismiss()
                }
            }
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
    @State private var preview: InvitePreview?
    @State private var previewing = false
    @State private var joining = false
    @State private var error: String?

    private var canPreview: Bool { !code.trimmingCharacters(in: .whitespaces).isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 18) {
                    if let preview {
                        previewCard(preview)
                    } else {
                        codeEntry
                    }
                    if let error {
                        Text(error).font(.zkSans(13)).foregroundColor(Theme.danger)
                    }
                }
                .padding(20)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Join a Server").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { PageBackButton() } }
        }
    }

    // Step 1 — enter a code/link, then preview the server before committing.
    private var codeEntry: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text("Enter an invite code or link to see the server before you join.")
                .font(.zkSans(14)).foregroundColor(Theme.ink3)
            VStack(alignment: .leading, spacing: 6) {
                Text("INVITE CODE OR LINK")
                    .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                TextField("abc123", text: $code)
                    .textFieldStyle(.plain).autocorrectionDisabled()
                    .textInputAutocapitalization(.never).foregroundColor(Theme.ink1).padding(12)
                    .background(Theme.bg3).clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .onSubmit { lookUp() }
            }
            Button { lookUp() } label: {
                Text(previewing ? "Looking up…" : "Preview Invite")
                    .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(canPreview ? Theme.accent : Theme.bg3)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            .disabled(!canPreview || previewing)
        }
    }

    // Step 2 — the server preview (banner, icon, name, description, member
    // count) with the actual Join action. Mirrors web's InvitePage.
    private func previewCard(_ p: InvitePreview) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if let banner = p.guild.bannerUrl, let url = assetURL(banner) {
                RetryingImage(url: url)
                    .frame(maxWidth: .infinity).frame(height: 140)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
            }
            HStack(spacing: 12) {
                Avatar(url: p.guild.iconUrl, name: p.guild.name, size: 56, squircle: true, toneId: p.guild.id)
                VStack(alignment: .leading, spacing: 2) {
                    Text("YOU'VE BEEN INVITED TO JOIN")
                        .font(.zkSans(10, weight: .bold)).foregroundColor(Theme.ink3)
                    Text(p.guild.name)
                        .font(.zkSans(18, weight: .semibold)).foregroundColor(Theme.ink1)
                        .lineLimit(2)
                }
            }
            if let desc = p.guild.description, !desc.isEmpty {
                Text(desc).font(.zkSans(14)).foregroundColor(Theme.ink2)
                    .lineLimit(3).fixedSize(horizontal: false, vertical: true)
            }
            HStack(spacing: 6) {
                Circle().fill(Theme.online).frame(width: 8, height: 8)
                Text("\(p.guild.memberCount.formatted()) \(p.guild.memberCount == 1 ? "member" : "members")")
                    .font(.zkSans(12)).foregroundColor(Theme.ink3)
            }

            Button { join(p) } label: {
                Text(joining ? "Joining…" : "Join \(p.guild.name)")
                    .font(.zkSans(15, weight: .semibold)).foregroundColor(.white)
                    .frame(maxWidth: .infinity).padding(.vertical, 13)
                    .background(Theme.accent)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .lineLimit(1)
            }
            .disabled(joining)

            Button { preview = nil; error = nil } label: {
                Text("Use a different code")
                    .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    .frame(maxWidth: .infinity)
            }
            .disabled(joining)
        }
    }

    private func lookUp() {
        guard canPreview, !previewing else { return }
        previewing = true; error = nil
        Task {
            if let p = await store.previewInvite(code) {
                preview = p
            } else {
                error = store.errorText ?? "Couldn't find that invite."
            }
            previewing = false
        }
    }

    private func join(_ p: InvitePreview) {
        guard !joining else { return }
        joining = true; error = nil
        Task {
            let ok = await store.joinByInvite(code: p.code)
            joining = false
            if ok { dismiss() } else { error = store.errorText ?? "Couldn't join. The invite may have expired." }
        }
    }
}

// MARK: Discover servers

struct DiscoveryView: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    @State private var query = ""
    @State private var category: String?
    @State private var searchTask: Task<Void, Never>?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                // Search + category filters.
                HStack(spacing: 6) {
                    Image(systemName: "magnifyingglass")
                        .font(.system(size: 13)).foregroundColor(Theme.ink3)
                    TextField("Search servers", text: $query)
                        .foregroundColor(Theme.ink1)
                        .autocorrectionDisabled()
                        .onChange(of: query) { _ in debouncedReload() }
                }
                .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                .padding(.horizontal, 16).padding(.top, 10)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 6) {
                        categoryChip(nil, label: "All")
                        ForEach(ZKDiscoveryCategories, id: \.self) { c in
                            categoryChip(c, label: c)
                        }
                    }
                    .padding(.horizontal, 16)
                }
                .padding(.vertical, 8)

                Group {
                    if store.loadingDiscoverable && store.discoverable.isEmpty {
                        ProgressView().tint(Theme.accent)
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else if store.discoverable.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "globe").font(.system(size: 30)).foregroundColor(Theme.ink3)
                            Text("No public servers found").font(.zkSans(14)).foregroundColor(Theme.ink3)
                        }
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                    } else {
                        ScrollView {
                            LazyVStack(spacing: 10) {
                                ForEach(store.discoverable) { DiscoverRow(guild: $0) }
                            }
                            .padding(16)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Discover").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { PageBackButton() } }
            .task { await store.loadDiscoverable(q: query, category: category) }
        }
    }

    private func categoryChip(_ value: String?, label: String) -> some View {
        let selected = category == value
        return Button {
            category = value
            Task { await store.loadDiscoverable(q: query, category: category) }
        } label: {
            Text(label)
                .font(.zkSans(12, weight: selected ? .semibold : .regular))
                .foregroundColor(selected ? Theme.bg0 : Theme.ink2)
                .padding(.horizontal, 11).padding(.vertical, 6)
                .background(selected ? Theme.accent : Theme.bg2)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    /// 300ms debounce on typing, matching the web's search fields.
    private func debouncedReload() {
        searchTask?.cancel()
        searchTask = Task {
            try? await Task.sleep(nanoseconds: 300_000_000)
            guard !Task.isCancelled else { return }
            await store.loadDiscoverable(q: query, category: category)
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
    @State private var observingGuild: AdminGuild?
    @State private var deleteCandidate: AdminUser?
    // Operational metrics + voice diagnostic (Overview tab).
    @State private var metrics: InstanceMetrics?
    @State private var voiceDiag: LivekitDiagnostic?
    @State private var voiceTesting = false
    @State private var voiceError: String?

    var body: some View {
        NavigationStack {
            VStack(spacing: 0) {
                Picker("", selection: $tab) {
                    Text("Overview").tag(0)
                    Text("Users").tag(1)
                    Text("Servers").tag(2)
                    Text("Storage").tag(3)
                    Text("Security").tag(4)
                }
                .pickerStyle(.segmented)
                .padding(12)

                if tab == 0 { overview }
                else if tab == 1 { users }
                else if tab == 2 { guilds }
                else if tab == 3 { storage }
                else { AdminSecurityTab() }
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
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { PageBackButton() } }
            .sheet(isPresented: $showStorageItems) { StorageItemsView() }
            .sheet(item: $observingGuild) { g in AdminObserveView(guild: g) }
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

                    // Operational / runtime metrics.
                    if let m = metrics {
                        adminSubheader("OPERATIONAL")
                        statRow("Gateway connections", "\(m.gateway.connections)", detail: "\(m.gateway.onlineUsers) online")
                        statRow("In voice", "\(m.voice.participants)", detail: "\(m.voice.rooms) " + (m.voice.rooms == 1 ? "room" : "rooms"))
                        statRow("Scheduled", "\(m.scheduledMessages.pending)", detail: "\(m.scheduledMessages.due) due")
                        statRow("Uptime", fmtUptime(m.process.uptimeSeconds), detail: "worker \(m.process.workerId)")
                        statRow("Database", m.db.ok ? "Healthy" : "Down", detail: "\(m.db.latencyMs)ms")
                        statRow("Redis", redisLabel(m.redis), detail: m.redis.configured ? "bus + blacklist" : "in-memory")
                    }

                    // Voice / LiveKit diagnostic (run on demand).
                    voiceDiagnosticSection
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
        .task { await loadMetrics() }
    }

    private func adminSubheader(_ t: String) -> some View {
        Text(t)
            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.top, 6)
    }

    private func fmtUptime(_ s: Int) -> String {
        if s < 60 { return "\(s)s" }
        let d = s / 86400, h = (s % 86400) / 3600, m = (s % 3600) / 60
        if d > 0 { return "\(d)d \(h)h" }
        if h > 0 { return "\(h)h \(m)m" }
        return "\(m)m"
    }

    private func redisLabel(_ r: InstanceMetrics.Redis) -> String {
        if !r.configured { return "Not configured" }
        return r.healthy == true ? "Healthy" : "Unreachable"
    }

    @ViewBuilder
    private var voiceDiagnosticSection: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                adminSubheader("VOICE / LIVEKIT")
                Spacer()
                Button {
                    Task { await runVoiceDiagnostic() }
                } label: {
                    Text(voiceTesting ? "Testing…" : (voiceDiag != nil ? "Re-run" : "Test voice"))
                        .font(.zkSans(12, weight: .semibold)).foregroundColor(Theme.accent)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(Theme.accent.opacity(0.12)).clipShape(Capsule())
                }
                .buttonStyle(.plain)
                .disabled(voiceTesting)
            }
            if let e = voiceError {
                Text(e).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
            }
            if let d = voiceDiag {
                HStack(spacing: 8) {
                    Text(diagLabel(d))
                        .font(.zkSans(11, weight: .bold)).foregroundColor(diagTint(d))
                        .padding(.horizontal, 8).padding(.vertical, 3)
                        .background(diagTint(d).opacity(0.15)).clipShape(Capsule())
                    if let ws = d.wsUrl {
                        Text(ws).font(.zkMono(10)).foregroundColor(Theme.ink4).lineLimit(1)
                    }
                }
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(d.checks) { c in checkRow(c) }
                }
            } else if !voiceTesting {
                Text("Tests LiveKit end-to-end: keys, the client URL, token minting, and whether the server can reach the SFU. The #1 self-host failure is the API not reaching LiveKit, or media (UDP 7882) not open to clients.")
                    .font(.zkSans(11)).foregroundColor(Theme.ink4)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(12)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }

    private func checkRow(_ c: LivekitCheck) -> some View {
        HStack(alignment: .top, spacing: 8) {
            Image(systemName: checkIcon(c.status))
                .font(.system(size: 12)).foregroundColor(checkColor(c.status)).frame(width: 16)
            VStack(alignment: .leading, spacing: 1) {
                Text(c.label).font(.zkSans(12, weight: .semibold)).foregroundColor(Theme.ink1)
                Text(c.detail).font(.zkSans(11)).foregroundColor(Theme.ink3)
            }
            Spacer(minLength: 0)
        }
    }
    private func checkIcon(_ s: String) -> String {
        switch s {
        case "pass": return "checkmark.circle.fill"
        case "fail": return "xmark.circle.fill"
        case "warn": return "exclamationmark.triangle.fill"
        default: return "circle"
        }
    }
    private func checkColor(_ s: String) -> Color {
        switch s {
        case "pass": return Theme.success
        case "fail": return Theme.danger
        case "warn": return Theme.plasmaAmber
        default: return Theme.ink3
        }
    }
    private func diagTint(_ d: LivekitDiagnostic) -> Color {
        d.ok ? Theme.success : (d.configured ? Theme.danger : Theme.plasmaAmber)
    }
    private func diagLabel(_ d: LivekitDiagnostic) -> String {
        d.ok ? "Voice OK" : (d.configured ? "Problem found" : "Not configured")
    }

    private func loadMetrics() async {
        metrics = try? await APIClient.shared.adminMetrics()
    }
    private func runVoiceDiagnostic() async {
        guard !voiceTesting else { return }
        voiceTesting = true
        voiceError = nil
        do { voiceDiag = try await APIClient.shared.adminVoiceDiagnostic() }
        catch { voiceError = (error as? APIError)?.message ?? error.localizedDescription }
        voiceTesting = false
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
        .confirmationDialog(
            "Delete account?",
            isPresented: Binding(
                get: { deleteCandidate != nil },
                set: { if !$0 { deleteCandidate = nil } }
            ),
            titleVisibility: .visible,
            presenting: deleteCandidate
        ) { u in
            Button("Delete @\(u.username)", role: .destructive) {
                Task { await store.adminDeleteUser(u) }
            }
            Button("Cancel", role: .cancel) {}
        } message: { u in
            Text("Permanently deletes @\(u.username)'s account and data. This can't be undone.")
        }
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
                Button(role: .destructive) { deleteCandidate = u } label: {
                    Label("Delete Account", systemImage: "trash")
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
            Avatar(url: g.iconUrl, name: g.name, size: 36, ringColor: Theme.bg1, toneId: g.id)
            VStack(alignment: .leading, spacing: 1) {
                HStack(spacing: 6) {
                    Text(g.name).font(.zkSans(15, weight: .medium)).foregroundColor(Theme.ink1).lineLimit(1)
                    if g.discoverable == true { badge("PUBLIC", Theme.accent2) }
                }
                Text("\(g.memberCount ?? 0) members").font(.zkSans(12)).foregroundColor(Theme.ink3)
            }
            Spacer()
            // Ghost-mode review without joining (web Observe parity).
            Button { observingGuild = g } label: {
                Image(systemName: "eye").font(.system(size: 14)).foregroundColor(Theme.accent).frame(width: 32, height: 32)
            }
            .buttonStyle(.plain)
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
            .toolbar { ToolbarItem(placement: .navigationBarLeading) { PageBackButton() } }
            .task { await store.loadFamily() }
            .fullScreenCover(item: $managingChild) { ChildControlsView(child: $0) }
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

                            ChildGuildsSection(child: child)
                                .padding(.top, 10)

                            ChildFriendsSection(child: child)
                                .padding(.top, 10)

                            ChildDMsSection(child: child)
                                .padding(.top, 10)

                            ChildWatchWordsSection(child: child)
                                .padding(.top, 10)

                            ChildFlagsSection(child: child)
                                .padding(.top, 10)
                        }
                        .padding(16)
                    }
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle(child.name).navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button { dismiss() } label: {
                        Image(systemName: "chevron.left")
                            .font(.system(size: 16, weight: .semibold))
                            .foregroundColor(Theme.ink2)
                    }
                }
            }
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
    // Forwarded to the MemberListView sheet below (sheet hosts don't inherit
    // env objects on "Designed for iPad on Mac").
    @EnvironmentObject private var session: Session
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
    @State private var showAuditLog = false
    @State private var showReports = false
    @State private var confirmDelete = false
    @State private var confirmLeave = false
    @State private var guildIconItem: PhotosPickerItem?
    @State private var guildBannerItem: PhotosPickerItem?
    @State private var guildImageUploading = false
    @State private var discoverable = false
    @State private var discoveryCategory: String?
    @State private var discoveryBusy = false

    private var isOwner: Bool { store.isGuildOwner }
    private var isAdmin: Bool { store.canManageGuild }
    /// Holds any moderation permission (mirrors the web Reports tab's modOnly
    /// gate). ADMINISTRATOR/owner short-circuits to all bits in myPermissions.
    private var isMod: Bool {
        isAdmin
            || store.iHavePermission(Permissions.MANAGE_MESSAGES)
            || store.iHavePermission(Permissions.KICK_MEMBERS)
            || store.iHavePermission(Permissions.BAN_MEMBERS)
            || store.iHavePermission(Permissions.MODERATE_MEMBERS)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    overviewSection
                    getRolesSection
                    if isAdmin { discoverySection }
                    if isAdmin { managementSection }
                    // Moderation — Reports (any mod permission) and Audit Log
                    // (VIEW_AUDIT_LOG), each gated independently so a moderator
                    // without full Manage Server still sees what they're allowed
                    // to. ADMINISTRATOR/owner holds all these bits.
                    if isMod || store.iHavePermission(Permissions.VIEW_AUDIT_LOG) { moderationSection }
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
                discoverable = store.selectedGuild?.discoverable ?? false
                discoveryCategory = store.selectedGuild?.discoveryCategory
            }
            .sheet(isPresented: $showRoles) { RolesListView() }
            .sheet(isPresented: $showMembers) {
                MemberListView()
                    .environmentObject(store)
                    .environmentObject(session)
                    .environmentObject(store.voice)
            }
            .sheet(isPresented: $showInvite) { CreateInviteSheet() }
            .sheet(isPresented: $showGetRoles) { BrowseRolesView() }
            .sheet(isPresented: $showEvents) { EventsView() }
            .sheet(isPresented: $showReactionRoles) { ReactionRolesView() }
            .sheet(isPresented: $showEmojiMgr) { EmojiManagerView() }
            .sheet(isPresented: $showStickerMgr) { StickerManagerView() }
            .sheet(isPresented: $showAuditLog) {
                GuildAuditLogView(guildId: store.selectedGuild?.id ?? "")
            }
            .sheet(isPresented: $showReports) {
                GuildReportsView(guildId: store.selectedGuild?.id ?? "")
            }
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

    /// Load the picked photo and push it as the guild icon or banner.
    private func uploadGuildImage(_ item: PhotosPickerItem?, kind: String) {
        guard let item else { return }
        guildImageUploading = true
        Task {
            defer { guildImageUploading = false; guildIconItem = nil; guildBannerItem = nil }
            guard let data = try? await item.loadTransferable(type: Data.self) else { return }
            let type = item.supportedContentTypes.first
            let ext = type?.preferredFilenameExtension ?? "jpg"
            let mime = type?.preferredMIMEType ?? "image/jpeg"
            if let err = await store.uploadGuildImage(
                kind: kind, filename: "\(kind).\(ext)", contentType: mime, data: data) {
                saveError = err
            }
        }
    }

    /// Discovery opt-in: list the server in the public directory with an
    /// optional category tag.
    private var discoverySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("DISCOVERY")
            Toggle(isOn: Binding(
                get: { discoverable },
                set: { newValue in
                    discoverable = newValue
                    saveDiscovery()
                }
            )) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Show in Discovery")
                        .font(.zkSans(15)).foregroundColor(Theme.ink1)
                    Text("Anyone can find and join this server from the Discover menu.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }
            }
            .tint(Theme.accent)
            .disabled(discoveryBusy)
            .padding(.horizontal, 12).padding(.vertical, 10)
            .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))

            if discoverable {
                Menu {
                    Button("None") { discoveryCategory = nil; saveDiscovery() }
                    ForEach(ZKDiscoveryCategories, id: \.self) { c in
                        Button(c) { discoveryCategory = c; saveDiscovery() }
                    }
                } label: {
                    HStack {
                        Text("Category")
                            .font(.zkSans(14)).foregroundColor(Theme.ink2)
                        Spacer()
                        Text(discoveryCategory ?? "None")
                            .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                        Image(systemName: "chevron.up.chevron.down")
                            .font(.system(size: 11)).foregroundColor(Theme.ink3)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 11)
                    .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                }
            }
        }
    }

    private func saveDiscovery() {
        discoveryBusy = true
        Task {
            if let err = await store.setGuildDiscovery(
                discoverable: discoverable,
                description: guildDescription.isEmpty ? nil : guildDescription,
                category: discoveryCategory) {
                saveError = err
                // Revert the optimistic toggle on failure.
                discoverable = store.selectedGuild?.discoverable ?? false
            }
            discoveryBusy = false
        }
    }

    private var overviewSection: some View {
        VStack(alignment: .leading, spacing: 12) {
            sectionHeader("OVERVIEW")
            if isAdmin {
                // Server banner — shown in the channel sidebar; tap to change.
                ZStack(alignment: .bottomTrailing) {
                    Group {
                        if let banner = assetURL(store.selectedGuild?.bannerUrl) {
                            AsyncImage(url: banner) { phase in
                                if case .success(let image) = phase {
                                    image.resizable().scaledToFill()
                                } else { Theme.bg3 }
                            }
                        } else {
                            LinearGradient(colors: [Theme.accent.opacity(0.3), Theme.accent2.opacity(0.2)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                        }
                    }
                    // One shared banner height (250) across server settings,
                    // profile settings, profile view, and the server header.
                    .frame(height: 250)
                    .frame(maxWidth: .infinity)
                    .clipped()

                    PhotosPicker(selection: $guildBannerItem, matching: .images) {
                        Image(systemName: "camera.fill")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundColor(Theme.ink1)
                            .frame(width: 26, height: 26)
                            .background(Color.black.opacity(0.55))
                            .clipShape(Circle())
                    }
                    .padding(8)
                }
                // Edge to edge: cancel the settings content's 16pt inset.
                .padding(.horizontal, -16)
            }
            let guild = store.selectedGuild
            HStack(spacing: 12) {
                Group {
                    if isAdmin {
                        PhotosPicker(selection: $guildIconItem, matching: .images) {
                            Avatar(url: guild?.iconUrl, name: name.isEmpty ? "S" : name,
                                   size: 56, ringColor: Theme.bg1, toneId: guild?.id)
                                .overlay(alignment: .bottomTrailing) {
                                    Image(systemName: "camera.fill")
                                        .font(.system(size: 8, weight: .bold))
                                        .foregroundColor(Theme.ink1)
                                        .frame(width: 17, height: 17)
                                        .background(Color.black.opacity(0.65))
                                        .clipShape(Circle())
                                }
                        }
                        .buttonStyle(.plain)
                    } else {
                        Avatar(url: store.selectedGuild?.iconUrl, name: name.isEmpty ? "S" : name,
                               size: 56, ringColor: Theme.bg1, toneId: store.selectedGuild?.id)
                    }
                }
                VStack(alignment: .leading, spacing: 4) {
                    Text("Server Name").font(.zkSans(11, weight: .semibold)).foregroundColor(Theme.ink4)
                    TextField("Server name", text: $name)
                        .foregroundColor(Theme.ink1)
                        .disabled(!isAdmin)
                        .padding(10).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                }
                if guildImageUploading { ProgressView().tint(Theme.accent) }
            }
            .onChange(of: guildIconItem) { item in uploadGuildImage(item, kind: "icon") }
            .onChange(of: guildBannerItem) { item in uploadGuildImage(item, kind: "banner") }
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

    private var moderationSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            sectionHeader("MODERATION")
            if isMod {
                settingsRow("Reports", icon: "flag.fill") { showReports = true }
            }
            if store.iHavePermission(Permissions.VIEW_AUDIT_LOG) {
                settingsRow("Audit Log", icon: "list.bullet.rectangle") { showAuditLog = true }
            }
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

    // The override currently being edited (role or member). nil = none open.
    @State private var selectedId: String?
    @State private var selectedType: String = "role"
    @State private var allowBits: UInt64 = 0
    @State private var denyBits: UInt64 = 0
    @State private var saving = false
    @State private var error: String?

    private var roles: [Role] { store.roles.sorted { $0.position > $1.position } }
    private var overrides: [PermissionOverride] { store.channelOverrides }
    /// Roles that don't already have an override on this channel (add menu).
    private var addableRoles: [Role] {
        roles.filter { r in !overrides.contains { $0.targetType == "role" && $0.targetId == r.id } }
    }
    private var thisLabel: String {
        channel.isCategory ? "this category" : "#\(channel.name ?? "this channel")"
    }

    private func overrideName(_ ov: PermissionOverride) -> String {
        if ov.targetType == "role" {
            return roles.first(where: { $0.id == ov.targetId })?.name ?? "(deleted role)"
        }
        return store.memberName(ov.targetId) ?? "User \(ov.targetId.suffix(4))"
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    // ── Existing overrides (the roles/members added here) ──
                    Text("OVERRIDES").font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                    if overrides.isEmpty {
                        Text("No overrides yet. Add a role below to allow or deny its permissions for \(thisLabel). Without an override, a role uses its server-wide permissions.")
                            .font(.zkSans(13)).foregroundColor(Theme.ink3)
                    } else {
                        VStack(spacing: 0) {
                            ForEach(overrides) { ov in overrideRow(ov) }
                        }
                        .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    }

                    // ── Add a role override ──
                    if !addableRoles.isEmpty {
                        Menu {
                            ForEach(addableRoles) { r in Button(r.name) { selectNew(r.id) } }
                        } label: {
                            HStack(spacing: 8) {
                                Image(systemName: "plus.circle.fill").font(.system(size: 15)).foregroundColor(Theme.accent)
                                Text("Add role override").font(.zkSans(14, weight: .medium)).foregroundColor(Theme.accent)
                                Spacer()
                            }
                            .padding(12).background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                        }
                    }

                    // ── Editor for the selected override ──
                    if let sel = selectedId {
                        Rectangle().fill(Theme.line).frame(height: 1).padding(.vertical, 2)
                        Text(editorTitle(sel)).font(.zkSans(14, weight: .bold)).foregroundColor(Theme.ink1)
                        Text("Allow or Deny takes precedence over the \(selectedType == "role" ? "role's" : "member's") server-wide permissions; leave Inherit (—) to keep them.")
                            .font(.zkSans(12)).foregroundColor(Theme.ink3)
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
            .task {
                await store.loadChannelOverrides(channel.id)
                if store.roles.isEmpty, let g = store.selectedGuild { await store.loadRoles(g) }
            }
        }
    }

    private func overrideRow(_ ov: PermissionOverride) -> some View {
        let isSel = selectedId == ov.targetId && selectedType == ov.targetType
        let isRole = ov.targetType == "role"
        return HStack(spacing: 10) {
            Text(isRole ? "ROLE" : "USER")
                .font(.zkSans(9, weight: .bold))
                .foregroundColor(isRole ? Theme.accent : Theme.online)
                .padding(.horizontal, 6).padding(.vertical, 2)
                .background((isRole ? Theme.accent : Theme.online).opacity(0.15))
                .clipShape(Capsule())
            Text(overrideName(ov)).font(.zkSans(14)).foregroundColor(Theme.ink1).lineLimit(1)
            Spacer(minLength: 8)
            if isSel { Image(systemName: "pencil").font(.system(size: 11)).foregroundColor(Theme.ink3) }
            Button { remove(ov) } label: {
                Image(systemName: "trash").font(.system(size: 13)).foregroundColor(Theme.danger)
                    .frame(width: 30, height: 30)
            }.buttonStyle(.plain)
        }
        .padding(.leading, 12)
        .background(isSel ? Theme.bg3 : Color.clear)
        .contentShape(Rectangle())
        .onTapGesture { selectExisting(ov) }
        .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .bottom)
    }

    private func editorTitle(_ id: String) -> String {
        if selectedType == "role" { return roles.first(where: { $0.id == id })?.name ?? "Role override" }
        return store.memberName(id) ?? "Member override"
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
    /// Open an existing override for editing (loads its allow/deny bits).
    private func selectExisting(_ ov: PermissionOverride) {
        selectedId = ov.targetId
        selectedType = ov.targetType
        allowBits = Permissions.parse(ov.allow)
        denyBits = Permissions.parse(ov.deny)
        error = nil
    }
    /// Start a fresh (all-inherit) role override.
    private func selectNew(_ roleId: String) {
        selectedId = roleId
        selectedType = "role"
        allowBits = 0
        denyBits = 0
        error = nil
    }
    private func save() {
        guard let id = selectedId else { return }
        saving = true; error = nil
        let type = selectedType
        Task {
            let err = await store.saveChannelOverride(
                channelId: channel.id, targetId: id, type: type, allow: allowBits, deny: denyBits)
            saving = false
            if let err { error = err }
        }
    }
    private func remove(_ ov: PermissionOverride) {
        Task {
            let err = await store.deleteChannelOverride(
                channelId: channel.id, targetId: ov.targetId, type: ov.targetType)
            if let err { error = err; return }
            // Close the editor if we just removed the override it was showing.
            if selectedId == ov.targetId && selectedType == ov.targetType { selectedId = nil }
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
            ZStack {
                // Full-bleed theme background so it spans edge to edge (no grey
                // bars on the sides behind the scroll content).
                Theme.bg1.ignoresSafeArea()
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
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(16)
                }
            }
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
    @State private var previewing: StorageItem?

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
                                Button { previewing = item } label: { storageRow(item) }
                                    .buttonStyle(.plain)
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
            .sheet(item: $previewing) { StorageItemPreview(item: $0) }
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

// ═══════════════════════════════════════════════════════════════════════════
// Admin observe ("ghost mode") — read-only review of any guild on the
// instance WITHOUT joining it, mirroring the web AdminPanel's Observe view.
// Deliberately self-contained: local state + APIClient.shared, no
// environment objects.
// ═══════════════════════════════════════════════════════════════════════════

struct AdminObserveView: View {
    let guild: AdminGuild
    @Environment(\.dismiss) private var dismiss
    @State private var peek: PeekGuildResult?
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if let error {
                    VStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle")
                            .font(.system(size: 28)).foregroundColor(Theme.dangerSoft)
                        Text(error).font(.zkSans(13)).foregroundColor(Theme.ink3)
                            .multilineTextAlignment(.center).padding(.horizontal, 24)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if let peek {
                    channelList(peek)
                } else {
                    ProgressView().tint(Theme.accent)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Observing: \(guild.name)")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .navigationDestination(for: Channel.self) { ch in
                ObservedChannelView(channel: ch)
            }
            .task {
                do { peek = try await APIClient.shared.adminPeekGuild(guildId: guild.id) }
                catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
            }
        }
    }

    private func channelList(_ peek: PeekGuildResult) -> some View {
        let sorted = peek.channels.sorted { ($0.position ?? 0) < ($1.position ?? 0) }
        let categories = sorted.filter { $0.isCategory }
        let root = sorted.filter { !$0.isCategory && $0.parentId == nil }
        return ScrollView {
            LazyVStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 8) {
                    Image(systemName: "eye")
                        .font(.system(size: 12)).foregroundColor(Theme.accent)
                    Text("Read-only ghost mode — you are not a member and nothing is marked read.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Theme.accent.opacity(0.08))
                .clipShape(RoundedRectangle(cornerRadius: 8))
                .padding(.bottom, 8)

                ForEach(root) { observedRow($0) }
                ForEach(categories) { cat in
                    Text((cat.name ?? "").uppercased())
                        .font(.zkMono(10.5))
                        .tracking(Theme.capTracking(10.5))
                        .foregroundColor(Theme.ink3)
                        .padding(.top, 12).padding(.bottom, 2).padding(.leading, 4)
                    ForEach(sorted.filter { $0.parentId == cat.id && !$0.isCategory }) { observedRow($0) }
                }
            }
            .padding(12)
        }
    }

    @ViewBuilder
    private func observedRow(_ ch: Channel) -> some View {
        let label = HStack(spacing: 8) {
            Image(systemName: ch.isVoice ? "speaker.wave.2.fill" : (ch.isForum ? "list.bullet.rectangle" : "number"))
                .font(.system(size: 13))
                .foregroundColor(Theme.accent)
                .frame(width: 16)
            Text(ch.name ?? "channel")
                .font(.zkSans(14)).foregroundColor(Theme.ink2)
                .lineLimit(1)
            Spacer(minLength: 0)
            if ch.isText || ch.isForum {
                Image(systemName: "chevron.right")
                    .font(.system(size: 10, weight: .semibold)).foregroundColor(Theme.ink4)
            }
        }
        .padding(.horizontal, 8).padding(.vertical, 6)
        .contentShape(Rectangle())

        if ch.isText || ch.isForum {
            NavigationLink(value: ch) { label }.buttonStyle(.plain)
        } else {
            label
        }
    }
}

/// Read-only message timeline for one observed channel.
struct ObservedChannelView: View {
    let channel: Channel
    @State private var messages: [PeekMessage] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        PeekMessageList(messages: messages, loading: loading, error: error,
                        emptyText: "No messages in #\(channel.name ?? "channel").")
            .navigationTitle("#\(channel.name ?? "channel")")
            .navigationBarTitleDisplayMode(.inline)
            .background(Theme.bg1.ignoresSafeArea())
            .task {
                do { messages = try await APIClient.shared.adminPeekMessages(channelId: channel.id) }
                catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
                loading = false
            }
    }
}

/// Shared slim read-only message list used by admin observe and parental
/// DM oversight (renders PeekMessage DTOs: author, time, content,
/// attachments as names, deleted label).
struct PeekMessageList: View {
    let messages: [PeekMessage]
    let loading: Bool
    let error: String?
    var emptyText: String = "No messages."

    var body: some View {
        Group {
            if loading {
                ProgressView().tint(Theme.accent)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let error {
                Text(error).font(.zkSans(13)).foregroundColor(Theme.dangerSoft)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .multilineTextAlignment(.center).padding(24)
            } else if messages.isEmpty {
                Text(emptyText).font(.zkSans(13)).foregroundColor(Theme.ink3)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 12) {
                        // API returns newest-first; show oldest-first.
                        ForEach(messages.reversed()) { m in
                            peekRow(m)
                        }
                    }
                    .padding(14)
                }
            }
        }
    }

    private func peekRow(_ m: PeekMessage) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Avatar(url: m.authorAvatarUrl, name: m.authorName, size: 34, toneId: m.authorId)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(m.authorName)
                        .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1)
                    Text(shortTime(m.createdAt))
                        .font(.zkSans(11)).foregroundColor(Theme.ink3)
                    if m.deleted == true {
                        Text("DELETED")
                            .font(.zkSans(8.5, weight: .bold)).tracking(0.5)
                            .foregroundColor(Theme.dangerSoft)
                            .padding(.horizontal, 5).padding(.vertical, 1.5)
                            .background(Theme.danger.opacity(0.15))
                            .clipShape(RoundedRectangle(cornerRadius: 4))
                    }
                }
                if let content = m.content, !content.isEmpty {
                    Text(content)
                        .font(.zkSans(14))
                        .foregroundColor(m.deleted == true ? Theme.ink3 : Theme.ink1)
                        .strikethrough(m.deleted == true, color: Theme.ink4)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let atts = m.attachments, !atts.isEmpty {
                    ForEach(atts) { at in
                        if at.contentType?.hasPrefix("image/") == true, let url = assetURL(at.url) {
                            // Inline image preview, like the real chat view.
                            AsyncImage(url: url) { phase in
                                if case .success(let image) = phase {
                                    image.resizable().scaledToFit()
                                } else {
                                    Rectangle().fill(Theme.bg2)
                                        .overlay(ProgressView().tint(Theme.accent))
                                }
                            }
                            .frame(maxWidth: 220, maxHeight: 220, alignment: .leading)
                            .clipShape(RoundedRectangle(cornerRadius: 8))
                        } else {
                            HStack(spacing: 5) {
                                Image(systemName: "paperclip").font(.system(size: 10))
                                Text(at.filename ?? "attachment").font(.zkSans(12)).lineLimit(1)
                            }
                            .foregroundColor(Theme.accent)
                        }
                    }
                }
                if let reacts = m.reactions, !reacts.isEmpty {
                    HStack(spacing: 4) {
                        ForEach(reacts, id: \.emoji) { r in
                            Text("\(r.emoji) \(r.count)")
                                .font(.zkSans(11)).foregroundColor(Theme.ink2)
                                .padding(.horizontal, 6).padding(.vertical, 2)
                                .background(Theme.bg2)
                                .clipShape(RoundedRectangle(cornerRadius: 6))
                        }
                    }
                }
            }
            Spacer(minLength: 0)
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Parental oversight — the child's servers (with block/unblock) and their
// 1:1 DM conversations (read-only; child-deleted messages stay visible,
// labelled). Self-contained like the observe views.
// ═══════════════════════════════════════════════════════════════════════════

struct ChildGuildsSection: View {
    let child: FamilyUser
    @State private var guilds: [ChildGuild] = []
    @State private var loading = true
    @State private var busyGuildId: String?
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(child.name.uppercased())'S SERVERS")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            if loading {
                ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 10)
            } else if guilds.isEmpty {
                Text("Not a member of any servers.")
                    .font(.zkSans(13)).foregroundColor(Theme.ink3)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(guilds.enumerated()), id: \.element.id) { i, g in
                        guildRow(g)
                        if i < guilds.count - 1 { Divider().overlay(Theme.line) }
                    }
                }
                .background(Theme.bg2)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                Text("Blocking hides the server and prevents rejoining until unblocked.")
                    .font(.zkSans(12)).foregroundColor(Theme.ink4)
            }
            if let error {
                Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
            }
        }
        .task { await load() }
    }

    private func load() async {
        do { guilds = try await APIClient.shared.familyChildGuilds(childId: child.id) }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
        loading = false
    }

    private func guildRow(_ g: ChildGuild) -> some View {
        HStack(spacing: 10) {
            Avatar(url: g.iconUrl, name: g.name, size: 32, ringColor: Theme.bg2, toneId: g.id)
            VStack(alignment: .leading, spacing: 1) {
                Text(g.name).font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1).lineLimit(1)
                if g.blocked {
                    Text("Blocked").font(.zkSans(11)).foregroundColor(Theme.dangerSoft)
                }
            }
            Spacer()
            Button {
                toggle(g)
            } label: {
                if busyGuildId == g.id {
                    ProgressView().scaleEffect(0.7).frame(width: 64)
                } else {
                    Text(g.blocked ? "Unblock" : "Block")
                        .font(.zkSans(12, weight: .semibold))
                        .foregroundColor(g.blocked ? Theme.ink2 : Theme.dangerSoft)
                        .padding(.horizontal, 10).padding(.vertical, 5)
                        .background(g.blocked ? Theme.bg3 : Theme.danger.opacity(0.15))
                        .clipShape(Capsule())
                }
            }
            .buttonStyle(.plain)
            .disabled(busyGuildId != nil)
        }
        .padding(.horizontal, 12).padding(.vertical, 8)
    }

    private func toggle(_ g: ChildGuild) {
        busyGuildId = g.id
        Task {
            do {
                try await APIClient.shared.familySetGuildBlocked(childId: child.id, guildId: g.id, blocked: !g.blocked)
                if let i = guilds.firstIndex(where: { $0.id == g.id }) { guilds[i].blocked.toggle() }
            } catch {
                self.error = (error as? APIError)?.message ?? error.localizedDescription
            }
            busyGuildId = nil
        }
    }
}

struct ChildDMsSection: View {
    let child: FamilyUser
    @State private var dms: [ChildDM] = []
    @State private var loading = true
    @State private var error: String?
    @State private var selected: ChildDM?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(child.name.uppercased())'S DIRECT MESSAGES")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            if loading {
                ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 10)
            } else if dms.isEmpty {
                Text("No direct messages.")
                    .font(.zkSans(13)).foregroundColor(Theme.ink3)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(dms.enumerated()), id: \.element.id) { i, dm in
                        Button { selected = dm } label: {
                            HStack(spacing: 10) {
                                Avatar(url: dm.recipient?.avatarUrl, name: dm.recipient?.name ?? "?",
                                       size: 32, ringColor: Theme.bg2, toneId: dm.recipient?.id)
                                Text(dm.recipient?.name ?? "Unknown")
                                    .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1).lineLimit(1)
                                Spacer()
                                Image(systemName: "chevron.right")
                                    .font(.system(size: 11, weight: .semibold)).foregroundColor(Theme.ink4)
                            }
                            .padding(.horizontal, 12).padding(.vertical, 8)
                            .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        if i < dms.count - 1 { Divider().overlay(Theme.line) }
                    }
                }
                .background(Theme.bg2)
                .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                Text("Conversations are read-only. Messages \(child.name) deleted stay visible here, labelled.")
                    .font(.zkSans(12)).foregroundColor(Theme.ink4)
            }
            if let error {
                Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
            }
        }
        .task {
            do { dms = try await APIClient.shared.familyChildDMs(childId: child.id) }
            catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
            loading = false
        }
        .sheet(item: $selected) { dm in
            ChildDMMessagesView(child: child, dm: dm)
        }
    }
}

/// Watch-words management for one child. Mirrors web's FamilySettings
/// watch-words tab: add (single or comma-separated — server splits), remove
/// via chip ×. Case-insensitive matching is handled server-side.
struct ChildWatchWordsSection: View {
    let child: FamilyUser
    @State private var words: [String] = []
    @State private var loading = true
    @State private var newWord = ""
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("WATCH WORDS")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            Text("Messages \(child.name) sends or receives containing one of these words get flagged for you to review. Matching is case-insensitive. Add several at once separated by commas.")
                .font(.zkSans(12)).foregroundColor(Theme.ink3)

            HStack(spacing: 8) {
                TextField("e.g. address, phone number", text: $newWord)
                    .textFieldStyle(.plain).autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
                    .foregroundColor(Theme.ink1).padding(.horizontal, 12).padding(.vertical, 9)
                    .background(Theme.bg2).clipShape(RoundedRectangle(cornerRadius: 10))
                    .onSubmit { add() }
                Button { add() } label: {
                    Text("Add").font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.ink1)
                        .padding(.horizontal, 14).padding(.vertical, 9)
                        .background(canAdd ? Theme.accent.opacity(0.18) : Theme.bg3)
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(canAdd ? Theme.accent.opacity(0.4) : .clear, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                }
                .buttonStyle(.plain).disabled(!canAdd || busy)
            }

            if loading {
                ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 8)
            } else if words.isEmpty {
                Text("No watch words yet.").font(.zkSans(13)).foregroundColor(Theme.ink3)
            } else {
                FlowChips(words: words) { remove($0) }
            }
            if let error {
                Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
            }
        }
        .task { await load() }
    }

    private var canAdd: Bool { !newWord.trimmingCharacters(in: .whitespaces).isEmpty }

    private func load() async {
        do { words = try await APIClient.shared.familyWatchWords(childId: child.id) }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
        loading = false
    }

    private func add() {
        let raw = newWord.trimmingCharacters(in: .whitespaces)
        guard !raw.isEmpty, !busy else { return }
        busy = true; error = nil
        Task {
            do { words = try await APIClient.shared.familyAddWatchWord(childId: child.id, word: raw); newWord = "" }
            catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
            busy = false
        }
    }

    private func remove(_ word: String) {
        busy = true; error = nil
        Task {
            do { words = try await APIClient.shared.familyRemoveWatchWord(childId: child.id, word: word) }
            catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
            busy = false
        }
    }
}

/// Wrapping chip layout for watch words (SwiftUI has no native flow layout
/// pre-iOS-16 Layout; this greedily wraps rows by measured width).
private struct FlowChips: View {
    let words: [String]
    let onRemove: (String) -> Void

    var body: some View {
        // Simple wrapping via a width-reading ZStack of rows.
        FlowLayout(spacing: 6) {
            ForEach(words, id: \.self) { w in
                HStack(spacing: 4) {
                    Text(w).font(.zkSans(13)).foregroundColor(Theme.ink1)
                    Button { onRemove(w) } label: {
                        Image(systemName: "xmark").font(.system(size: 9, weight: .bold)).foregroundColor(Theme.ink3)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.leading, 10).padding(.trailing, 7).padding(.vertical, 6)
                .background(Theme.bg2)
                .overlay(Capsule().strokeBorder(Theme.line, lineWidth: 1))
                .clipShape(Capsule())
            }
        }
    }
}

/// Minimal flow layout (iOS 16 Layout) — wraps subviews to the next row when
/// they overflow the available width.
private struct FlowLayout: Layout {
    var spacing: CGFloat = 6

    func sizeThatFits(proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) -> CGSize {
        let maxWidth = proposal.width ?? .infinity
        var x: CGFloat = 0, y: CGFloat = 0, rowHeight: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > maxWidth, x > 0 { x = 0; y += rowHeight + spacing; rowHeight = 0 }
            x += sz.width + spacing
            rowHeight = max(rowHeight, sz.height)
        }
        return CGSize(width: maxWidth == .infinity ? x : maxWidth, height: y + rowHeight)
    }

    func placeSubviews(in bounds: CGRect, proposal: ProposedViewSize, subviews: Subviews, cache: inout ()) {
        let maxWidth = bounds.width
        var x: CGFloat = bounds.minX, y: CGFloat = bounds.minY, rowHeight: CGFloat = 0
        for s in subviews {
            let sz = s.sizeThatFits(.unspecified)
            if x + sz.width > bounds.minX + maxWidth, x > bounds.minX { x = bounds.minX; y += rowHeight + spacing; rowHeight = 0 }
            s.place(at: CGPoint(x: x, y: y), proposal: ProposedViewSize(sz))
            x += sz.width + spacing
            rowHeight = max(rowHeight, sz.height)
        }
    }
}

/// Flagged-messages feed for one child. Mirrors web's FamilySettings flags
/// tab: matched-word chip, sent/received label, timestamp, snippet; unreviewed
/// rows are amber, tapping marks the flag reviewed.
struct ChildFlagsSection: View {
    let child: FamilyUser
    @State private var flags: [FamilyFlag] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("FLAGGED MESSAGES")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            if loading {
                ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 8)
            } else if flags.isEmpty {
                Text("No flagged messages.").font(.zkSans(13)).foregroundColor(Theme.ink3)
            } else {
                VStack(spacing: 6) {
                    ForEach(flags) { f in flagRow(f) }
                }
            }
            if let error {
                Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
            }
        }
        .task { await load() }
    }

    private func flagRow(_ f: FamilyFlag) -> some View {
        Button { markReviewed(f) } label: {
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text(f.matchedWord)
                        .font(.zkSans(11, weight: .semibold)).foregroundColor(Theme.idle)
                        .padding(.horizontal, 6).padding(.vertical, 2)
                        .background(Theme.idle.opacity(0.15)).clipShape(Capsule())
                    Text(f.byChild ? "\(child.name) sent" : "received")
                        .font(.zkSans(11)).foregroundColor(Theme.ink3)
                    Spacer()
                    Text(shortTime(f.createdAt)).font(.zkMono(10)).foregroundColor(Theme.ink4)
                }
                if let snippet = f.snippet, !snippet.isEmpty {
                    Text(snippet).font(.zkSans(13)).foregroundColor(Theme.ink1)
                        .lineLimit(2).multilineTextAlignment(.leading)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            .padding(.horizontal, 12).padding(.vertical, 9)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(f.reviewed ? Theme.bg2 : Theme.idle.opacity(0.10))
            .overlay(RoundedRectangle(cornerRadius: 12).strokeBorder(f.reviewed ? Theme.line : Theme.idle.opacity(0.30), lineWidth: 1))
            .clipShape(RoundedRectangle(cornerRadius: 12))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func load() async {
        do { flags = try await APIClient.shared.familyChildFlags(childId: child.id) }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
        loading = false
    }

    private func markReviewed(_ f: FamilyFlag) {
        guard !f.reviewed else { return }
        // Match web: reviewing clears the flag from the alert list (the server
        // marks it reviewed, so it won't return on refresh either).
        flags.removeAll { $0.id == f.id }
        Task { try? await APIClient.shared.familyMarkFlagReviewed(id: f.id) }
    }
}

/// Read-only view of one supervised DM conversation.
struct ChildDMMessagesView: View {
    let child: FamilyUser
    let dm: ChildDM
    @Environment(\.dismiss) private var dismiss
    @State private var messages: [PeekMessage] = []
    @State private var loading = true
    @State private var error: String?

    var body: some View {
        NavigationStack {
            PeekMessageList(messages: messages, loading: loading, error: error,
                            emptyText: "No messages in this conversation.")
                .background(Theme.bg1.ignoresSafeArea())
                .navigationTitle("\(child.name) & \(dm.recipient?.name ?? "Unknown")")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
                .task {
                    do { messages = try await APIClient.shared.familyChildDMMessages(childId: child.id, channelId: dm.id) }
                    catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
                    loading = false
                }
        }
    }
}

/// The supervised child's friends and blocked users: observe profiles and
/// block/unblock on the child's behalf.
struct ChildFriendsSection: View {
    let child: FamilyUser
    @State private var relationships: [ChildRelationship] = []
    @State private var loading = true
    @State private var error: String?
    @State private var viewing: ChildRelationship?

    private var friends: [ChildRelationship] { relationships.filter { $0.type == "friend" } }
    private var blocked: [ChildRelationship] { relationships.filter { $0.type == "blocked" } }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("\(child.name.uppercased())'S FRIENDS")
                .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            if loading {
                ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.vertical, 10)
            } else if friends.isEmpty && blocked.isEmpty {
                Text("No friends yet.")
                    .font(.zkSans(13)).foregroundColor(Theme.ink3)
            } else {
                if !friends.isEmpty {
                    card(friends)
                }
                if !blocked.isEmpty {
                    Text("BLOCKED")
                        .font(.zkSans(10, weight: .bold)).foregroundColor(Theme.ink4)
                        .padding(.top, 4)
                    card(blocked)
                }
                Text("Tap a person to view their profile, or block them on \(child.name)'s behalf.")
                    .font(.zkSans(12)).foregroundColor(Theme.ink4)
            }
            if let error {
                Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
            }
        }
        .task { await load() }
        .sheet(item: $viewing) { rel in
            ChildFriendProfileSheet(child: child, relationship: rel) {
                Task { await load() }
            }
        }
    }

    private func load() async {
        do { relationships = try await APIClient.shared.familyChildFriends(childId: child.id) }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
        loading = false
    }

    private func card(_ rows: [ChildRelationship]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { i, rel in
                Button { viewing = rel } label: {
                    HStack(spacing: 10) {
                        Avatar(url: rel.user.avatarUrl, name: rel.user.name, size: 32,
                               ringColor: Theme.bg2, toneId: rel.user.id)
                        VStack(alignment: .leading, spacing: 1) {
                            Text(rel.user.name)
                                .font(.zkSans(14, weight: .medium)).foregroundColor(Theme.ink1).lineLimit(1)
                            if let u = rel.user.username {
                                Text("@\(u)").font(.zkSans(11)).foregroundColor(Theme.ink3)
                            }
                        }
                        Spacer()
                        if rel.type == "blocked" {
                            Text("Blocked").font(.zkSans(11)).foregroundColor(Theme.dangerSoft)
                        }
                        Image(systemName: "chevron.right")
                            .font(.system(size: 11, weight: .semibold)).foregroundColor(Theme.ink4)
                    }
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if i < rows.count - 1 { Divider().overlay(Theme.line) }
            }
        }
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

/// Read-only profile of one of the child's contacts, with the parent-side
/// block/unblock action.
struct ChildFriendProfileSheet: View {
    let child: FamilyUser
    let relationship: ChildRelationship
    var onChange: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var busy = false
    @State private var error: String?

    private var isBlocked: Bool { relationship.type == "blocked" }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    Avatar(url: relationship.user.avatarUrl, name: relationship.user.name,
                           size: 84, ringColor: Theme.bg1, toneId: relationship.user.id)
                        .padding(.top, 18)
                    VStack(spacing: 3) {
                        Text(relationship.user.name)
                            .font(.zkSans(20, weight: .semibold)).foregroundColor(Theme.ink1)
                        if let u = relationship.user.username {
                            Text("@\(u)").font(.zkSans(13)).foregroundColor(Theme.ink3)
                        }
                        if let status = relationship.user.customStatus, !status.isEmpty {
                            Text(status).font(.zkSans(13)).foregroundColor(Theme.ink2)
                                .padding(.top, 4)
                        }
                    }
                    HStack(spacing: 6) {
                        Image(systemName: isBlocked ? "hand.raised.fill" : "person.2.fill")
                            .font(.system(size: 11))
                        Text(isBlocked
                             ? "Blocked for \(child.name)"
                             : "Friends with \(child.name)")
                            .font(.zkSans(12, weight: .medium))
                    }
                    .foregroundColor(isBlocked ? Theme.dangerSoft : Theme.ink2)
                    .padding(.horizontal, 10).padding(.vertical, 5)
                    .background(Theme.bg2).clipShape(Capsule())

                    Button {
                        toggleBlock()
                    } label: {
                        Group {
                            if busy {
                                ProgressView().tint(.white)
                            } else {
                                Text(isBlocked ? "Unblock for \(child.name)" : "Block for \(child.name)")
                                    .font(.zkSans(14, weight: .semibold))
                            }
                        }
                        .foregroundColor(.white)
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 12)
                        .background(isBlocked ? Theme.bg3 : Theme.danger)
                        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    }
                    .disabled(busy)
                    .padding(.top, 8)

                    if !isBlocked {
                        Text("Blocking removes the friendship and prevents messages and calls between them.")
                            .font(.zkSans(12)).foregroundColor(Theme.ink4)
                            .multilineTextAlignment(.center)
                    }
                    if let error {
                        Text(error).font(.zkSans(13)).foregroundColor(Theme.dangerSoft)
                    }
                }
                .padding(20)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Profile").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func toggleBlock() {
        busy = true; error = nil
        Task {
            do {
                try await APIClient.shared.familySetUserBlocked(
                    childId: child.id, userId: relationship.user.id, blocked: !isBlocked)
                onChange()
                dismiss()
            } catch {
                self.error = (error as? APIError)?.message ?? error.localizedDescription
            }
            busy = false
        }
    }
}

/// Preview for one stored file (admin Files browser): images render
/// inline (served from /cdn/<id>/<filename>); other formats show a
/// metadata card.
struct StorageItemPreview: View {
    let item: StorageItem
    @Environment(\.dismiss) private var dismiss

    private var fileURL: URL? {
        guard let name = item.filename,
              let encoded = name.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed)
        else { return nil }
        return assetURL("/cdn/\(item.id)/\(encoded)")
    }
    private var isImage: Bool {
        let f = (item.format ?? (item.filename as NSString?)?.pathExtension ?? "").lowercased()
        return ["png", "jpg", "jpeg", "gif", "webp", "heic", "bmp"].contains(f)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 14) {
                    if isImage, let url = fileURL {
                        AsyncImage(url: url) { phase in
                            switch phase {
                            case .success(let image):
                                image.resizable().scaledToFit()
                            case .failure:
                                VStack(spacing: 6) {
                                    Image(systemName: "eye.slash")
                                        .font(.system(size: 26)).foregroundColor(Theme.ink4)
                                    Text("Couldn't load preview")
                                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                                }
                                .frame(height: 180)
                            default:
                                ProgressView().tint(Theme.accent).frame(height: 180)
                            }
                        }
                        .frame(maxWidth: .infinity)
                        .background(Theme.bg0)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    } else {
                        VStack(spacing: 8) {
                            Image(systemName: "doc")
                                .font(.system(size: 40, weight: .light)).foregroundColor(Theme.ink3)
                            Text("No inline preview for this format")
                                .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 36)
                        .background(Theme.bg2)
                        .clipShape(RoundedRectangle(cornerRadius: 12))
                    }

                    VStack(spacing: 0) {
                        metaRow("Filename", item.filename ?? "(unnamed)")
                        Divider().overlay(Theme.line)
                        metaRow("Category", item.category.capitalized)
                        Divider().overlay(Theme.line)
                        metaRow("Size", storageByteString(item.sizeBytes))
                        if let f = item.format {
                            Divider().overlay(Theme.line)
                            metaRow("Format", f.uppercased())
                        }
                        Divider().overlay(Theme.line)
                        metaRow("Referenced", item.referenced ? "Yes" : "No (orphaned)")
                        if item.compressed == true {
                            Divider().overlay(Theme.line)
                            metaRow("Compressed", "Yes")
                        }
                    }
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                .padding(14)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Preview").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
        }
    }

    private func metaRow(_ label: String, _ value: String) -> some View {
        HStack {
            Text(label).font(.zkSans(13)).foregroundColor(Theme.ink4)
            Spacer()
            Text(value).font(.zkSans(13, weight: .medium)).foregroundColor(Theme.ink1)
                .lineLimit(1).truncationMode(.middle)
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
    }
}


/// Shared byte formatter for the storage browser.
func storageByteString(_ bytes: Int) -> String {
    let kb = 1024.0, mb = kb * 1024, gb = mb * 1024
    let b = Double(bytes)
    if b >= gb { return String(format: "%.2f GB", b / gb) }
    if b >= mb { return String(format: "%.1f MB", b / mb) }
    if b >= kb { return String(format: "%.0f KB", b / kb) }
    return "\(bytes) B"
}

// ═══════════════════════════════════════════════════════════════════════════
// Messaging streaks — flame chip (DM rows + DM headers).
// ═══════════════════════════════════════════════════════════════════════════

/// Little number-in-a-box with a flame behind it. Shows for live streaks
/// (both sides messaged daily); works in E2EE DMs since only timestamps
/// are counted.
struct StreakChip: View {
    let days: Int
    var body: some View {
        HStack(spacing: 2) {
            Image(systemName: "flame.fill")
                .font(.system(size: 9, weight: .bold))
                .foregroundColor(Theme.plasmaAmber)
            Text("\(min(days, 10_000))")
                .font(.zkMono(10, weight: .semibold))
                .foregroundColor(Theme.ink1)
        }
        .padding(.horizontal, 6)
        .padding(.vertical, 2.5)
        .background(Theme.plasmaAmber.opacity(0.16))
        .clipShape(RoundedRectangle(cornerRadius: 6, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 6, style: .continuous)
                .strokeBorder(Theme.plasmaAmber.opacity(0.4), lineWidth: 1)
        )
        .accessibilityLabel("\(days) day messaging streak")
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Guild Reports — moderation triage queue (gated on the mod permissions).
// Mirrors the web Reports tab: reporter → target, reason, and the preserved
// message snapshot; Dismiss / Resolve / Resolve-and-delete / Resolve-and-ban;
// status + type filters; an open count. Styled like the security event log.
// ═══════════════════════════════════════════════════════════════════════════

struct GuildReportsView: View {
    let guildId: String
    @Environment(\.dismiss) private var dismiss

    @State private var reports: [Report] = []
    @State private var openCount = 0
    @State private var loading = true
    @State private var loadingMore = false
    @State private var reachedEnd = false
    @State private var error: String?
    @State private var statusFilter = "open"   // open | resolved | dismissed | all
    @State private var typeFilter: String?     // nil = all, "message", "user"
    /// Id of the report currently being acted on (disables the action row).
    @State private var busyId: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let error {
                        Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
                    }
                    if openCount > 0 {
                        Text("\(openCount) open")
                            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.danger)
                            .padding(.horizontal, 8).padding(.vertical, 3)
                            .background(Theme.danger.opacity(0.15))
                            .clipShape(Capsule())
                    }

                    // Status filter.
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            filterChip("Open", selected: statusFilter == "open") { setStatus("open") }
                            filterChip("Resolved", selected: statusFilter == "resolved") { setStatus("resolved") }
                            filterChip("Dismissed", selected: statusFilter == "dismissed") { setStatus("dismissed") }
                            filterChip("All", selected: statusFilter == "all") { setStatus("all") }
                        }
                    }
                    // Type filter.
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            filterChip("All types", selected: typeFilter == nil) { setType(nil) }
                            filterChip("Messages", selected: typeFilter == "message") { setType("message") }
                            filterChip("Users", selected: typeFilter == "user") { setType("user") }
                        }
                    }

                    if loading && reports.isEmpty {
                        ProgressView().tint(Theme.accent)
                            .frame(maxWidth: .infinity).padding(.top, 24)
                    } else if reports.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "flag.slash")
                                .font(.system(size: 28, weight: .light)).foregroundColor(Theme.ink3)
                            Text("No reports here.")
                                .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 24)
                    } else {
                        VStack(spacing: 8) {
                            ForEach(reports) { reportRow($0) }
                        }
                        if !reachedEnd {
                            Button {
                                Task { await loadMore() }
                            } label: {
                                Text(loadingMore ? "Loading…" : "Load more")
                                    .font(.zkSans(13)).foregroundColor(Theme.ink2)
                                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                                    .background(Theme.bg2)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                            .disabled(loadingMore)
                        }
                    }
                }
                .padding(12)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Reports").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await reload() }
        }
    }

    private func setStatus(_ v: String) { statusFilter = v; Task { await reload() } }
    private func setType(_ v: String?) { typeFilter = v; Task { await reload() } }

    private func filterChip(_ label: String, selected: Bool, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(label)
                .font(.zkSans(12, weight: selected ? .semibold : .regular))
                .foregroundColor(selected ? Theme.bg0 : Theme.ink2)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(selected ? Theme.accent : Theme.bg2)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func reportRow(_ r: Report) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 4) {
                Text(r.reporterName)
                    .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.ink1).lineLimit(1)
                Text("reported").font(.zkSans(12)).foregroundColor(Theme.ink3)
                Text(r.targetName)
                    .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.ink1).lineLimit(1)
                Spacer(minLength: 6)
                Text(shortTime(r.createdAt)).font(.zkSans(10)).foregroundColor(Theme.ink4)
            }
            HStack(spacing: 6) {
                Text(r.reasonLabel)
                    .font(.zkSans(10, weight: .semibold)).foregroundColor(Theme.ink2)
                    .padding(.horizontal, 6).padding(.vertical, 2)
                    .background(Theme.bg0.opacity(0.5)).clipShape(Capsule())
                Text("· \(r.targetType)").font(.zkSans(11)).foregroundColor(Theme.ink3)
                if r.status != "open" {
                    Text(r.status.capitalized)
                        .font(.zkSans(10))
                        .foregroundColor(r.status == "resolved" ? Theme.success : Theme.ink3)
                }
            }
            if let details = r.details, !details.isEmpty {
                Text(details).font(.zkSans(12)).foregroundColor(Theme.ink2)
            }
            if r.targetType == "message", let snap = r.messageContent, !snap.isEmpty {
                Text(snap)
                    .font(.zkMono(11)).foregroundColor(Theme.ink3).lineLimit(4)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg0.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
            if r.status == "open" {
                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 8) {
                        actionButton("Dismiss", tint: Theme.ink2, bg: Theme.bg3) { act(r, "dismiss", "none") }
                        actionButton("Resolve", tint: Theme.ink1, bg: Theme.bg3) { act(r, "resolve", "none") }
                        if r.targetType == "message" && r.messageId != nil {
                            actionButton("Resolve & delete", tint: Theme.plasmaAmber,
                                         bg: Theme.plasmaAmber.opacity(0.15)) { act(r, "resolve", "delete_message") }
                        }
                        if r.targetUser != nil {
                            actionButton("Resolve & ban", tint: Theme.danger,
                                         bg: Theme.danger.opacity(0.15)) { act(r, "resolve", "ban") }
                        }
                    }
                }
            }
        }
        .padding(10)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func actionButton(_ title: String, tint: Color, bg: Color, _ action: @escaping () -> Void) -> some View {
        Button(action: action) {
            Text(title)
                .font(.zkSans(11, weight: .semibold)).foregroundColor(tint)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(bg).clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .buttonStyle(.plain)
        .disabled(busyId != nil)
    }

    // ── Data ──
    private func reload() async {
        loading = true
        error = nil
        do {
            let w = try await APIClient.shared.listReports(
                guildId: guildId, status: statusFilter, targetType: typeFilter, before: nil)
            reports = w.reports
            openCount = w.openCount
            reachedEnd = w.reports.count < 50
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
        loading = false
    }

    private func loadMore() async {
        guard !loadingMore, !reachedEnd, let last = reports.last else { return }
        loadingMore = true
        do {
            let w = try await APIClient.shared.listReports(
                guildId: guildId, status: statusFilter, targetType: typeFilter, before: last.id)
            reports.append(contentsOf: w.reports)
            openCount = w.openCount
            reachedEnd = w.reports.count < 50
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
        loadingMore = false
    }

    private func act(_ r: Report, _ action: String, _ moderation: String) {
        guard busyId == nil else { return }
        busyId = r.id
        Task {
            do {
                let updated = try await APIClient.shared.handleReport(
                    guildId: guildId, reportId: r.id, action: action, note: nil, moderation: moderation)
                let newStatus = action == "resolve" ? "resolved" : "dismissed"
                // Drop it from the view when the current filter no longer
                // matches its new status (the common "open" case); else patch.
                if statusFilter == "open" || (statusFilter != "all" && statusFilter != newStatus) {
                    reports.removeAll { $0.id == r.id }
                } else if let i = reports.firstIndex(where: { $0.id == r.id }) {
                    reports[i] = updated
                }
                if r.status == "open" { openCount = max(0, openCount - 1) }
            } catch {
                self.error = (error as? APIError)?.message ?? error.localizedDescription
            }
            busyId = nil
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Guild Audit Log — read-only moderation trail (gated on VIEW_AUDIT_LOG).
// Mirrors the web AuditLogTab: who did what, when, to whom; action + actor
// filters; keyset pagination via `before`. Styled like the security event log.
// ═══════════════════════════════════════════════════════════════════════════

struct GuildAuditLogView: View {
    let guildId: String
    @Environment(\.dismiss) private var dismiss

    @State private var entries: [AuditEntry] = []
    @State private var loading = true
    @State private var loadingMore = false
    @State private var reachedEnd = false
    @State private var error: String?
    /// Action-name prefix filter; nil = all.
    @State private var actionFilter: String?
    /// Filter to a single moderator (tapped from a row).
    @State private var actorFilterId: String?
    @State private var actorFilterName: String = ""

    private struct ActionOption: Identifiable {
        let id: String
        let prefix: String?
        let label: String
    }
    private let actionOptions: [ActionOption] = [
        .init(id: "all", prefix: nil, label: "All"),
        .init(id: "member", prefix: "member", label: "Members"),
        .init(id: "role", prefix: "role", label: "Roles"),
        .init(id: "channel", prefix: "channel", label: "Channels"),
        .init(id: "ban", prefix: "ban", label: "Bans"),
        .init(id: "automod", prefix: "automod", label: "AutoMod"),
    ]

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 12) {
                    if let error {
                        Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
                    }

                    // Action-prefix filter chips.
                    ScrollView(.horizontal, showsIndicators: false) {
                        HStack(spacing: 6) {
                            ForEach(actionOptions) { opt in
                                actionChip(opt.prefix, opt.label)
                            }
                        }
                    }

                    // Active actor filter (set by tapping a moderator).
                    if actorFilterId != nil {
                        HStack(spacing: 6) {
                            Text("By \(actorFilterName)")
                                .font(.zkSans(11, weight: .semibold)).foregroundColor(Theme.accent)
                            Button {
                                actorFilterId = nil
                                actorFilterName = ""
                                Task { await reload() }
                            } label: {
                                Image(systemName: "xmark.circle.fill")
                                    .font(.system(size: 12)).foregroundColor(Theme.accent)
                            }
                            .buttonStyle(.plain)
                        }
                        .padding(.horizontal, 8).padding(.vertical, 4)
                        .background(Theme.accent.opacity(0.12))
                        .clipShape(Capsule())
                    }

                    if loading && entries.isEmpty {
                        ProgressView().tint(Theme.accent)
                            .frame(maxWidth: .infinity).padding(.top, 24)
                    } else if entries.isEmpty {
                        VStack(spacing: 8) {
                            Image(systemName: "list.bullet.rectangle")
                                .font(.system(size: 28, weight: .light)).foregroundColor(Theme.ink3)
                            Text(emptyMessage)
                                .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        }
                        .frame(maxWidth: .infinity).padding(.vertical, 24)
                    } else {
                        VStack(spacing: 8) {
                            ForEach(entries) { entryRow($0) }
                        }
                        if !reachedEnd {
                            Button {
                                Task { await loadMore() }
                            } label: {
                                Text(loadingMore ? "Loading…" : "Load older entries")
                                    .font(.zkSans(13)).foregroundColor(Theme.ink2)
                                    .frame(maxWidth: .infinity).padding(.vertical, 10)
                                    .background(Theme.bg2)
                                    .clipShape(RoundedRectangle(cornerRadius: 10))
                            }
                            .buttonStyle(.plain)
                            .disabled(loadingMore)
                        }
                    }
                }
                .padding(12)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Audit Log").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task { await reload() }
        }
    }

    private var emptyMessage: String {
        (actionFilter != nil || actorFilterId != nil)
            ? "No entries match this filter."
            : "Nothing logged yet."
    }

    private func actionChip(_ prefix: String?, _ label: String) -> some View {
        let selected = actionFilter == prefix
        return Button {
            actionFilter = prefix
            Task { await reload() }
        } label: {
            Text(label)
                .font(.zkSans(12, weight: selected ? .semibold : .regular))
                .foregroundColor(selected ? Theme.bg0 : Theme.ink2)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(selected ? Theme.accent : Theme.bg2)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func entryRow(_ ev: AuditEntry) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Avatar(url: ev.actor?.avatarUrl, name: ev.actorName, size: 24)
                Button {
                    if let actor = ev.actor {
                        actorFilterId = actor.id
                        actorFilterName = actor.name
                        Task { await reload() }
                    }
                } label: {
                    Text(ev.actorName)
                        .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.ink1)
                        .lineLimit(1)
                }
                .buttonStyle(.plain)
                .disabled(ev.actor == nil)
                Spacer(minLength: 6)
                Text(shortTime(ev.createdAt))
                    .font(.zkSans(10)).foregroundColor(Theme.ink4)
            }
            HStack(spacing: 6) {
                Text(ev.action).font(.zkMono(11)).foregroundColor(Theme.accent)
                Text("· \(ev.targetType)").font(.zkSans(11)).foregroundColor(Theme.ink3)
            }
            if let reason = ev.reason, !reason.isEmpty {
                Text(reason).font(.zkSans(12)).foregroundColor(Theme.ink2)
            }
            if let changes = ev.changesText {
                Text(changes)
                    .font(.zkMono(10)).foregroundColor(Theme.ink3)
                    .lineLimit(6)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg0.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(10)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // ── Data ──
    private func reload() async {
        loading = true
        error = nil
        do {
            let r = try await APIClient.shared.auditLog(
                guildId: guildId, before: nil, actionPrefix: actionFilter, actorId: actorFilterId)
            entries = r
            reachedEnd = r.count < 50
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
        loading = false
    }

    private func loadMore() async {
        guard !loadingMore, !reachedEnd, let last = entries.last else { return }
        loadingMore = true
        do {
            let r = try await APIClient.shared.auditLog(
                guildId: guildId, before: last.id, actionPrefix: actionFilter, actorId: actorFilterId)
            entries.append(contentsOf: r)
            reachedEnd = r.count < 50
        } catch {
            self.error = (error as? APIError)?.message ?? error.localizedDescription
        }
        loadingMore = false
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Admin → Security: event log, banned words, spam throttle config.
// ═══════════════════════════════════════════════════════════════════════════

struct AdminSecurityTab: View {
    @State private var events: [SecurityEvent] = []
    @State private var words: [String] = []
    @State private var config: SecurityConfig?
    @State private var newWord = ""
    @State private var kindFilter: String?
    @State private var loading = true
    @State private var showPreset = false
    @State private var error: String?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if let error {
                    Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
                }

                // ── Spam throttle ──
                sectionLabel("SPAM PROTECTION")
                if let cfg = config {
                    VStack(spacing: 0) {
                        toggleRow("Rate-limit spammers", isOn: cfg.spamEnabled) { v in
                            patchConfig(["spamEnabled": v])
                        }
                        Divider().overlay(Theme.line)
                        stepperRow("Trigger", value: cfg.spamMaxMessages,
                                   detail: "msgs / \(cfg.spamWindowSeconds)s",
                                   range: 2...100) { v in patchConfig(["spamMaxMessages": v]) }
                        Divider().overlay(Theme.line)
                        stepperRow("Cooldown", value: cfg.spamCooldownSeconds / 60,
                                   detail: "minutes at 1 msg/min",
                                   range: 1...1440) { v in patchConfig(["spamCooldownSeconds": v * 60]) }
                    }
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    Text("After the trigger, the user can only send one message per minute until the cooldown ends. Encrypted conversations are never metered or inspected.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                }

                // ── Banned words ──
                sectionLabel("BANNED WORDS")
                if let cfg = config {
                    VStack(spacing: 0) {
                        toggleRow("Block banned words", isOn: cfg.wordFilterEnabled) { v in
                            patchConfig(["wordFilterEnabled": v])
                        }
                    }
                    .background(Theme.bg2)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                }
                HStack(spacing: 8) {
                    TextField("add a word…", text: $newWord)
                        .autocorrectionDisabled()
                        .textInputAutocapitalization(.never)
                        .foregroundColor(Theme.ink1)
                        .padding(10).background(Theme.bg2)
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                        .onSubmit { addWord() }
                    Button { addWord() } label: {
                        Image(systemName: "plus")
                            .font(.system(size: 14, weight: .semibold))
                            .foregroundColor(.white)
                            .frame(width: 38, height: 38)
                            .background(Theme.accent)
                            .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .disabled(newWord.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                Button {
                    showPreset = true
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "text.badge.plus")
                            .font(.system(size: 12, weight: .semibold))
                        Text("Common wordlist…")
                            .font(.zkSans(13, weight: .semibold))
                    }
                    .foregroundColor(Theme.accent)
                    .padding(.horizontal, 12).padding(.vertical, 8)
                    .background(Theme.accent.opacity(0.12))
                    .clipShape(Capsule())
                }
                .buttonStyle(.plain)
                Text("Browse a standard profanity + slur list and add words individually, or add all at once.")
                    .font(.zkSans(11)).foregroundColor(Theme.ink4)
                if words.isEmpty {
                    Text("No banned words yet. Messages containing a banned word are rejected and reported here.")
                        .font(.zkSans(11)).foregroundColor(Theme.ink4)
                } else {
                    FlowWords(words: words) { w in removeWord(w) }
                }

                // ── Event log ──
                sectionLabel("SECURITY LOG")
                HStack(spacing: 6) {
                    filterChip(nil, label: "All")
                    filterChip("spam_limited", label: "Spam")
                    filterChip("banned_word", label: "Banned words")
                }
                if loading && events.isEmpty {
                    ProgressView().tint(Theme.accent).frame(maxWidth: .infinity).padding(.top, 16)
                } else if events.isEmpty {
                    Text("Nothing logged. That's a good sign.")
                        .font(.zkSans(13)).foregroundColor(Theme.ink3)
                        .frame(maxWidth: .infinity).padding(.vertical, 16)
                } else {
                    VStack(spacing: 8) {
                        ForEach(events) { ev in eventRow(ev) }
                    }
                }
            }
            .padding(.horizontal, 12)
            .padding(.bottom, 16)
        }
        .task { await reload() }
        .sheet(isPresented: $showPreset) {
            PresetWordsSheet(words: $words)
        }
    }

    private func sectionLabel(_ t: String) -> some View {
        Text(t).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
    }

    private func toggleRow(_ label: String, isOn: Bool, set: @escaping (Bool) -> Void) -> some View {
        Toggle(isOn: Binding(get: { isOn }, set: set)) {
            Text(label).font(.zkSans(14)).foregroundColor(Theme.ink1)
        }
        .tint(Theme.accent)
        .padding(.horizontal, 12).padding(.vertical, 9)
    }

    private func stepperRow(_ label: String, value: Int, detail: String,
                            range: ClosedRange<Int>, set: @escaping (Int) -> Void) -> some View {
        HStack {
            VStack(alignment: .leading, spacing: 1) {
                Text(label).font(.zkSans(14)).foregroundColor(Theme.ink1)
                Text(detail).font(.zkSans(10)).foregroundColor(Theme.ink4)
            }
            Spacer()
            Text("\(value)")
                .font(.zkMono(14, weight: .semibold)).foregroundColor(Theme.accent)
            Stepper("", value: Binding(get: { value }, set: { set($0.clamped(to: range)) }), in: range)
                .labelsHidden()
        }
        .padding(.horizontal, 12).padding(.vertical, 7)
    }

    private func filterChip(_ value: String?, label: String) -> some View {
        let selected = kindFilter == value
        return Button {
            kindFilter = value
            Task { await loadEvents() }
        } label: {
            Text(label)
                .font(.zkSans(12, weight: selected ? .semibold : .regular))
                .foregroundColor(selected ? Theme.bg0 : Theme.ink2)
                .padding(.horizontal, 10).padding(.vertical, 5)
                .background(selected ? Theme.accent : Theme.bg2)
                .clipShape(Capsule())
        }
        .buttonStyle(.plain)
    }

    private func eventRow(_ ev: SecurityEvent) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                Image(systemName: ev.kind == "banned_word" ? "exclamationmark.bubble.fill" : "speedometer")
                    .font(.system(size: 11))
                    .foregroundColor(ev.kind == "banned_word" ? Theme.dangerSoft : Theme.plasmaAmber)
                Text(ev.actorName)
                    .font(.zkSans(13, weight: .semibold)).foregroundColor(Theme.ink1)
                Spacer()
                Text(shortTime(ev.createdAt))
                    .font(.zkSans(10)).foregroundColor(Theme.ink4)
            }
            Text(ev.detail)
                .font(.zkSans(12)).foregroundColor(Theme.ink2)
            if let snapshot = ev.contentSnapshot, !snapshot.isEmpty {
                Text(snapshot)
                    .font(.zkMono(11))
                    .foregroundColor(Theme.ink3)
                    .lineLimit(3)
                    .padding(6)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .background(Theme.bg0.opacity(0.6))
                    .clipShape(RoundedRectangle(cornerRadius: 6))
            }
        }
        .padding(10)
        .background(Theme.bg2)
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    // ── Data ──
    private func reload() async {
        loading = true
        async let e: () = loadEvents()
        async let w: () = loadWords()
        async let c: () = loadConfig()
        _ = await (e, w, c)
        loading = false
    }
    private func loadEvents() async {
        do { events = try await APIClient.shared.adminSecurityEvents(kind: kindFilter) }
        catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
    }
    private func loadWords() async {
        words = (try? await APIClient.shared.adminSecurityWords()) ?? words
    }
    private func loadConfig() async {
        config = (try? await APIClient.shared.adminSecurityConfig()) ?? config
    }
    private func patchConfig(_ patch: [String: Any]) {
        Task {
            if let updated = try? await APIClient.shared.adminPatchSecurityConfig(patch) {
                config = updated
            }
        }
    }
    private func addWord() {
        let word = newWord.trimmingCharacters(in: .whitespaces)
        guard !word.isEmpty else { return }
        newWord = ""
        Task {
            if let updated = try? await APIClient.shared.adminAddSecurityWord(word) { words = updated }
        }
    }
    private func removeWord(_ word: String) {
        Task {
            if let updated = try? await APIClient.shared.adminRemoveSecurityWord(word) { words = updated }
        }
    }
}

/// Browser for the server's common moderation wordlist: tap a word to ban
/// it on this instance, or "Add all". Already-banned words show a check.
private struct PresetWordsSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var words: [String]
    @State private var preset: [String] = []
    @State private var loading = true
    @State private var addingAll = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Tap a word to ban it on this instance. Checked words are already banned.")
                        .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    if let error {
                        Text(error).font(.zkSans(12)).foregroundColor(Theme.dangerSoft)
                    }
                    if loading {
                        ProgressView().tint(Theme.accent)
                            .frame(maxWidth: .infinity).padding(.top, 40)
                    } else {
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 116), spacing: 6)], spacing: 6) {
                            ForEach(preset, id: \.self) { w in
                                presetPill(w)
                            }
                        }
                    }
                }
                .padding(16)
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Common wordlist")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .navigationBarLeading) {
                    Button("Done") { dismiss() }
                        .font(.zkSans(15)).foregroundColor(Theme.accent)
                }
                ToolbarItem(placement: .navigationBarTrailing) {
                    Button { addAll() } label: {
                        if addingAll {
                            ProgressView().tint(Theme.accent)
                        } else {
                            Text("Add all")
                                .font(.zkSans(15, weight: .semibold))
                                .foregroundColor(Theme.accent)
                        }
                    }
                    .disabled(addingAll || loading || preset.allSatisfy { words.contains($0) })
                }
            }
            .task {
                do { preset = try await APIClient.shared.adminSecurityWordPreset() }
                catch { self.error = (error as? APIError)?.message ?? error.localizedDescription }
                loading = false
            }
        }
    }

    @ViewBuilder
    private func presetPill(_ w: String) -> some View {
        let added = words.contains(w)
        Button {
            guard !added else { return }
            add(w)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: added ? "checkmark" : "plus")
                    .font(.system(size: 10, weight: .bold))
                    .foregroundColor(added ? Theme.success : Theme.accent)
                Text(w)
                    .font(.zkMono(12))
                    .foregroundColor(added ? Theme.ink4 : Theme.ink1)
                    .lineLimit(1)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 9).padding(.vertical, 7)
            .background(Theme.bg2.opacity(added ? 0.55 : 1))
            .overlay(
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .stroke(added ? Theme.line : Theme.accent.opacity(0.35), lineWidth: 1)
            )
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
        }
        .buttonStyle(.plain)
        .disabled(added)
    }

    private func add(_ w: String) {
        Task {
            if let updated = try? await APIClient.shared.adminAddSecurityWord(w) { words = updated }
        }
    }
    private func addAll() {
        addingAll = true
        Task {
            defer { addingAll = false }
            if let updated = try? await APIClient.shared.adminLoadSecurityWordPreset() { words = updated }
        }
    }
}

private extension Int {
    func clamped(to range: ClosedRange<Int>) -> Int {
        Swift.min(Swift.max(self, range.lowerBound), range.upperBound)
    }
}

/// Simple wrapping word-pill list with delete affordances.
private struct FlowWords: View {
    let words: [String]
    let onDelete: (String) -> Void
    var body: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 110), spacing: 6)], spacing: 6) {
            ForEach(words, id: \.self) { w in
                HStack(spacing: 4) {
                    Text(w)
                        .font(.zkMono(12)).foregroundColor(Theme.ink1)
                        .lineLimit(1)
                    Spacer(minLength: 0)
                    Button { onDelete(w) } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 9, weight: .bold))
                            .foregroundColor(Theme.ink3)
                    }
                    .buttonStyle(.plain)
                }
                .padding(.horizontal, 9).padding(.vertical, 6)
                .background(Theme.bg2)
                .clipShape(RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}

// ═══════════════════════════════════════════════════════════════════════════
// Achievements — badge grid for profiles.
// ═══════════════════════════════════════════════════════════════════════════

struct AchievementsSection: View {
    /// The VIEWED user's id (always — including the signed-in user). Routing
    /// self through GET /users/<id>/achievements returns the owner their full
    /// shelf, and a STABLE id avoids the `.task` re-keying that left the own
    /// profile card blank when `isSelf ? nil : user.id` flipped as currentUser
    /// resolved.
    let userId: String
    /// Profile cards show only EARNED badges; the Settings gallery shows all.
    var earnedOnly: Bool = false
    @State private var achievements: [Achievement] = []
    @State private var loaded = false
    @State private var loadError: String?

    private var earned: [Achievement] { achievements.filter { $0.isEarned } }
    private var locked: [Achievement] { achievements.filter { !$0.isEarned } }

    var body: some View {
        Group {
            if !earned.isEmpty || (!earnedOnly && !locked.isEmpty) {
                VStack(alignment: .leading, spacing: 8) {
                    if !earned.isEmpty {
                        Text("ACHIEVEMENTS")
                            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 8)], spacing: 8) {
                            ForEach(earned) { AchievementBadge(achievement: $0) }
                        }
                    }
                    // In-progress badges only outside earnedOnly (Settings gallery).
                    if !earnedOnly && !locked.isEmpty {
                        Text("IN PROGRESS")
                            .font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
                            .padding(.top, earned.isEmpty ? 0 : 4)
                        LazyVGrid(columns: [GridItem(.adaptive(minimum: 92), spacing: 8)], spacing: 8) {
                            ForEach(locked) { AchievementBadge(achievement: $0) }
                        }
                    }
                }
            } else if !loaded {
                // A SIZED placeholder before data loads — without it this branch
                // is a zero-size EmptyView, the enclosing Group collapses inside
                // the profile ScrollView, and .task(id:) never reliably attaches,
                // leaving the card blank even for users who DO have badges. The
                // Settings gallery works precisely because it renders a sized
                // ProgressView here.
                HStack { Spacer(); ProgressView().tint(Theme.accent); Spacer() }
                    .padding(.vertical, 14)
            } else if let loadError {
                Text("Achievements couldn’t load — \(loadError)")
                    .font(.zkSans(11)).foregroundColor(Theme.dangerSoft)
            } else {
                // Loaded with nothing to show (earnedOnly card, none unlocked):
                // an explicit empty state rather than a blank gap.
                Text(earnedOnly ? "No achievements unlocked yet." : "No achievements yet.")
                    .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.vertical, 2)
            }
        }
        .task(id: userId) {
            loadError = nil
            do {
                achievements = try await APIClient.shared.userAchievements(userId: userId)
            } catch {
                achievements = []
                loadError = (error as? APIError).map { "HTTP \($0.status): \($0.message)" }
                    ?? error.localizedDescription
            }
            loaded = true
        }
    }
}

struct AchievementBadge: View {
    let achievement: Achievement

    private var symbol: String { achievement.sfSymbol }

    var body: some View {
        let earned = achievement.isEarned
        VStack(spacing: 5) {
            ZStack {
                Circle()
                    .fill(earned
                          ? LinearGradient(colors: [Theme.accent.opacity(0.35), Theme.accent2.opacity(0.25)],
                                           startPoint: .topLeading, endPoint: .bottomTrailing)
                          : LinearGradient(colors: [Theme.bg3, Theme.bg3],
                                           startPoint: .topLeading, endPoint: .bottomTrailing))
                    .frame(width: 40, height: 40)
                Image(systemName: earned ? symbol : "lock.fill")
                    .font(.system(size: 16))
                    .foregroundColor(earned ? Theme.accent : Theme.ink4)
                if earned {
                    Text(achievement.marker)
                        .font(.zkMono(8, weight: .bold))
                        .foregroundColor(Theme.bg0)
                        .padding(.horizontal, 4).padding(.vertical, 1)
                        .background(Theme.accent)
                        .clipShape(Capsule())
                        .offset(x: 13, y: 14)
                }
            }
            Text(achievement.name)
                .font(.zkSans(10, weight: .medium))
                .foregroundColor(earned ? Theme.ink2 : Theme.ink4)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
            if !earned, let goal = achievement.goal {
                Text("\(min(achievement.value, goal))/\(goal)")
                    .font(.zkMono(8, weight: .semibold))
                    .foregroundColor(Theme.ink4)
                    .padding(.horizontal, 4).padding(.vertical, 1)
                    .background(Theme.bg3)
                    .clipShape(Capsule())
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 8)
        .background(Theme.bg2.opacity(earned ? 1 : 0.55))
        .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
        .help("\(achievement.description)")
    }
}

/// Full achievements gallery (Settings → Achievements). Shows the COMPLETE
/// catalog — earned and not-yet-earned — with names, descriptions, and
/// progress, so the user can see what's collected and what's left. Reads the
/// owner's full shelf from GET /users/@me/achievements (locked entries carry
/// live progress, which the server only returns to the owner).
struct AchievementsGallerySheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var achievements: [Achievement] = []
    @State private var loaded = false

    private var earned: [Achievement] { achievements.filter { $0.isEarned } }
    private var locked: [Achievement] { achievements.filter { !$0.isEarned } }

    var body: some View {
        NavigationStack {
            Group {
                if !loaded && achievements.isEmpty {
                    ProgressView().tint(Theme.accent)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else if achievements.isEmpty {
                    VStack(spacing: 8) {
                        Image(systemName: "rosette").font(.system(size: 30, weight: .light)).foregroundColor(Theme.ink3)
                        Text("No achievements yet").font(.zkSans(14)).foregroundColor(Theme.ink3)
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                } else {
                    ScrollView {
                        VStack(alignment: .leading, spacing: 14) {
                            Text("\(earned.count) of \(achievements.count) earned")
                                .font(.zkSans(12, weight: .medium)).foregroundColor(Theme.ink3)
                            if !earned.isEmpty {
                                group("EARNED", earned)
                            }
                            if !locked.isEmpty {
                                group("IN PROGRESS", locked)
                            }
                        }
                        .padding(16)
                    }
                }
            }
            .background(Theme.bg1.ignoresSafeArea())
            .navigationTitle("Achievements").navigationBarTitleDisplayMode(.inline)
            .toolbar { ToolbarItem(placement: .cancellationAction) { Button("Done") { dismiss() } } }
            .task {
                achievements = (try? await APIClient.shared.myAchievements())?.achievements ?? []
                loaded = true
            }
        }
    }

    private func group(_ title: String, _ items: [Achievement]) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(title).font(.zkSans(11, weight: .bold)).foregroundColor(Theme.ink3)
            VStack(spacing: 0) {
                ForEach(Array(items.enumerated()), id: \.element.id) { i, a in
                    AchievementGalleryRow(achievement: a)
                    if i < items.count - 1 { Divider().overlay(Theme.line).padding(.leading, 56) }
                }
            }
            .background(Theme.bg2)
            .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        }
    }
}

/// One row in the achievements gallery: icon, name, description, and either an
/// earned check (with marker) or a value/goal progress bar for locked entries.
struct AchievementGalleryRow: View {
    let achievement: Achievement

    var body: some View {
        let earned = achievement.isEarned
        HStack(alignment: .top, spacing: 12) {
            ZStack {
                Circle()
                    .fill(earned
                          ? AnyShapeStyle(LinearGradient(colors: [Theme.accent.opacity(0.35), Theme.accent2.opacity(0.25)],
                                                         startPoint: .topLeading, endPoint: .bottomTrailing))
                          : AnyShapeStyle(Theme.bg3))
                    .frame(width: 40, height: 40)
                Image(systemName: earned ? achievement.sfSymbol : "lock.fill")
                    .font(.system(size: 16))
                    .foregroundColor(earned ? Theme.accent : Theme.ink4)
            }
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    Text(achievement.name)
                        .font(.zkSans(14, weight: .semibold))
                        .foregroundColor(earned ? Theme.ink1 : Theme.ink3)
                    if earned, !achievement.marker.isEmpty {
                        Text(achievement.marker)
                            .font(.zkMono(9, weight: .bold)).foregroundColor(Theme.bg0)
                            .padding(.horizontal, 5).padding(.vertical, 1)
                            .background(Theme.accent).clipShape(Capsule())
                    }
                    Spacer(minLength: 4)
                    if earned {
                        Image(systemName: "checkmark.seal.fill")
                            .font(.system(size: 14)).foregroundColor(Theme.accent)
                    }
                }
                Text(achievement.description)
                    .font(.zkSans(12)).foregroundColor(Theme.ink3)
                    .fixedSize(horizontal: false, vertical: true)
                if !earned, let goal = achievement.goal, goal > 0 {
                    let frac = min(1, Double(achievement.value) / Double(goal))
                    GeometryReader { geo in
                        ZStack(alignment: .leading) {
                            Capsule().fill(Theme.bg3).frame(height: 5)
                            Capsule().fill(Theme.accent.opacity(0.7))
                                .frame(width: max(0, frac) * geo.size.width, height: 5)
                        }
                    }
                    .frame(height: 5)
                    Text("\(min(achievement.value, goal))/\(goal)")
                        .font(.zkMono(10, weight: .semibold)).foregroundColor(Theme.ink4)
                }
            }
        }
        .padding(.horizontal, 12).padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
