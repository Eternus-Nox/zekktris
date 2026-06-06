import SwiftUI

/// Lists the threads under a parent channel — forum posts for a forum channel,
/// or the threads spun off a text channel. Tapping a row opens that thread's
/// message timeline (a thread is itself a channel).
struct ThreadListView: View {
    @EnvironmentObject private var store: AppStore
    let parent: Channel
    @State private var showNewPost = false

    private var isForum: Bool { parent.isForum }

    var body: some View {
        VStack(spacing: 0) {
            header

            if store.loadingThreads && store.threadList.isEmpty {
                Spacer(); ProgressView().tint(Theme.accent); Spacer()
            } else if store.threadList.isEmpty {
                Spacer()
                VStack(spacing: 14) {
                    Text(isForum ? "No threads yet" : "No threads yet")
                        .font(.zkSans(14))
                        .foregroundColor(Theme.ink3)
                    if isForum {
                        Button { showNewPost = true } label: {
                            Label("New Thread", systemImage: "plus")
                                .font(.zkSans(14, weight: .semibold))
                                .foregroundColor(.white)
                                .padding(.horizontal, 16).padding(.vertical, 10)
                                .background(Theme.accent)
                                .clipShape(Capsule())
                        }
                    }
                }
                Spacer()
            } else {
                ScrollView {
                    LazyVStack(spacing: 2) {
                        ForEach(store.threadList) { thread in
                            Button { store.selectChannel(thread) } label: { ThreadRow(thread: thread) }
                                .buttonStyle(.plain)
                        }
                    }
                    .padding(.horizontal, 8)
                    .padding(.vertical, 8)
                }
            }
        }
        .background(Theme.bg2)
        .onAppear { Task { await store.loadThreads(parent) } }
        .sheet(isPresented: $showNewPost) { NewForumPostSheet(forum: parent) }
    }

    private var header: some View {
        HStack(spacing: 8) {
            Button { store.clearChannel() } label: {
                Image(systemName: "chevron.left")
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundColor(Theme.ink2)
            }
            Image(systemName: isForum ? "list.bullet.rectangle" : "text.bubble")
                .font(.system(size: 15))
                .foregroundColor(Theme.ink3)
            Text(parent.name ?? (isForum ? "forum" : "threads"))
                .font(.zkSans(16, weight: .semibold))
                .foregroundColor(Theme.ink1)
                .lineLimit(1)

            Spacer()

            if isForum {
                Button { showNewPost = true } label: {
                    Image(systemName: "plus")
                        .font(.system(size: 18, weight: .semibold))
                        .foregroundColor(Theme.accent)
                }
            }
        }
        .padding(.horizontal, 14)
        .frame(height: 48)
        .background(Theme.bg2)
        .overlay(Rectangle().fill(Theme.line).frame(height: 1), alignment: .bottom)
    }
}

private struct ThreadRow: View {
    @EnvironmentObject private var store: AppStore
    let thread: Channel

    var body: some View {
        let unread = store.isChannelUnread(thread)
        let mentions = store.mentionCount(for: thread.id)
        HStack(spacing: 10) {
            Image(systemName: thread.isArchived ? "archivebox" : "number")
                .font(.system(size: 14))
                .foregroundColor(unread ? Theme.ink1 : Theme.ink3)
                .frame(width: 18)
            VStack(alignment: .leading, spacing: 2) {
                Text(thread.name ?? "thread")
                    .font(.zkSans(15, weight: unread ? .semibold : .medium))
                    .foregroundColor(Theme.ink1)
                    .lineLimit(1)
                if thread.isArchived {
                    Text("Archived")
                        .font(.zkSans(11))
                        .foregroundColor(Theme.ink4)
                }
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
        .padding(.vertical, 9)
        .contentShape(Rectangle())
    }
}

/// Compose a new forum post (title + body). On success, opens the new post.
private struct NewForumPostSheet: View {
    @EnvironmentObject private var store: AppStore
    @Environment(\.dismiss) private var dismiss
    let forum: Channel
    @State private var title = ""
    @State private var content = ""
    @State private var busy = false

    private var canPost: Bool {
        !title.trimmingCharacters(in: .whitespaces).isEmpty
            && !content.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var body: some View {
        NavigationStack {
            ZStack {
                Theme.bg1.ignoresSafeArea()
                VStack(alignment: .leading, spacing: 14) {
                    TextField("Title", text: $title)
                        .foregroundColor(Theme.ink1)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 11)
                        .background(Theme.bg2)
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 10))

                    TextField("Write something…", text: $content, axis: .vertical)
                        .lineLimit(4...10)
                        .foregroundColor(Theme.ink1)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 11)
                        .background(Theme.bg2)
                        .overlay(RoundedRectangle(cornerRadius: 10).strokeBorder(Theme.line, lineWidth: 1))
                        .clipShape(RoundedRectangle(cornerRadius: 10))

                    if let err = store.errorText {
                        Text(err).font(.zkSans(13)).foregroundColor(Theme.danger)
                    }

                    Button(action: post) {
                        ZStack {
                            if busy { ProgressView().tint(.white) }
                            else { Text("Post").font(.zkSans(15, weight: .semibold)) }
                        }
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 13)
                        .foregroundColor(.white)
                        .background(canPost ? Theme.accent : Theme.accent.opacity(0.4))
                        .clipShape(RoundedRectangle(cornerRadius: 10))
                    }
                    .disabled(!canPost || busy)

                    Spacer()
                }
                .padding(20)
            }
            .navigationTitle("New Thread")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func post() {
        busy = true
        Task {
            let created = await store.createForumPost(in: forum, title: title, content: content)
            busy = false
            if let created {
                dismiss()
                store.push(.messages(created))
            }
        }
    }
}
