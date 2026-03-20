import SwiftUI

struct WorktreeDetailView: View {
    let worktree: WorktreeSnapshot?
    let isResolvingTerminal: Bool
    let terminalSession: TerminalSessionDescriptor?
    let terminalMessage: String?
    let onMergeWorktree: () -> Void
    let onRemoveWorktree: () -> Void
    let onOpenWorktree: () -> Void
    let onCloseWorktree: () -> Void

    var body: some View {
        Group {
            if let worktree {
                VStack(alignment: .leading, spacing: 18) {
                    WorktreeHeaderView(
                        worktree: worktree,
                        onMergeWorktree: onMergeWorktree,
                        onRemoveWorktree: onRemoveWorktree,
                        onOpenWorktree: onOpenWorktree,
                        onCloseWorktree: onCloseWorktree
                    )

                    TerminalPanelView(
                        isResolvingTerminal: isResolvingTerminal,
                        terminalSession: terminalSession,
                        terminalMessage: terminalMessage
                    )
                }
                .padding(24)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
            } else {
                ContentUnavailableView(
                    "No Worktree Selected",
                    systemImage: "sidebar.left",
                    description: Text("Choose a worktree from the sidebar.")
                )
            }
        }
    }
}

private struct WorktreeHeaderView: View {
    let worktree: WorktreeSnapshot
    let onMergeWorktree: () -> Void
    let onRemoveWorktree: () -> Void
    let onOpenWorktree: () -> Void
    let onCloseWorktree: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 16) {
                Text(verbatim: worktree.branch)
                    .font(.title3.weight(.semibold))
                    .lineLimit(1)

                Spacer(minLength: 0)

                HStack(spacing: 8) {
                    if worktree.mux {
                        Button("Close", action: onCloseWorktree)
                    } else {
                        Button("Open", action: onOpenWorktree)
                    }

                    Button("Merge", action: onMergeWorktree)
                    Button("Remove", role: .destructive, action: onRemoveWorktree)
                }
                .controlSize(.small)
            }

            if !worktree.prs.isEmpty || worktree.linearIssue != nil || !worktree.services.isEmpty {
                WrappingFlowLayout(spacing: 6, rowSpacing: 6) {
                    ForEach(worktree.prs, id: \.self) { pr in
                        PRBadgeView(pr: pr)
                    }

                    if let issue = worktree.linearIssue {
                        LinearBadgeView(issue: issue)
                    }

                    ForEach(worktree.services, id: \.self) { service in
                        ServiceBadgeView(service: service)
                    }
                }
            }
        }
        .padding(.bottom, 4)
    }
}

private struct TerminalPanelView: View {
    let isResolvingTerminal: Bool
    let terminalSession: TerminalSessionDescriptor?
    let terminalMessage: String?

    var body: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(nsColor: .windowBackgroundColor))

            if isResolvingTerminal {
                ProgressView("Attaching terminal…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let terminalSession {
                GhosttyTerminalContainer(session: terminalSession)
                    .id(terminalSession.id)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Terminal")
                        .font(.headline)
                    Text(verbatim: terminalMessage ?? "Select an open worktree to attach the terminal.")
                        .foregroundStyle(.secondary)
                }
                .padding(20)
            }
        }
        .overlay {
            RoundedRectangle(cornerRadius: 14)
                .stroke(Color.secondary.opacity(0.2), lineWidth: 1)
        }
    }
}
