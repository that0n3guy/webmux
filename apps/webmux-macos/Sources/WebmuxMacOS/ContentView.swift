import SwiftUI

struct ContentView: View {
    @ObservedObject var connectionsStore: ConnectionsStore
    @ObservedObject var store: WorktreeStore

    @State private var editingConnection: ConnectionProfile?
    @State private var connectionPendingRemoval: ConnectionProfile?

    var body: some View {
        Group {
            if connectionsStore.connections.isEmpty {
                emptyStateView
            } else {
                NavigationSplitView {
                    List(selection: $store.selectedBranch) {
                        ForEach(store.worktrees) { worktree in
                            VStack(alignment: .leading, spacing: 4) {
                                Text(verbatim: worktree.branch)
                                    .font(.headline)

                                HStack(spacing: 8) {
                                    Text(verbatim: worktree.mux ? "open" : "closed")
                                    Text(verbatim: worktree.status)
                                    if let profile = worktree.profile {
                                        Text(verbatim: profile)
                                    }
                                }
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            }
                            .padding(.vertical, 4)
                            .tag(worktree.branch)
                        }
                    }
                    .navigationTitle(selectedConnectionName)
                } detail: {
                    detailView
                }
            }
        }
        .toolbar {
            ToolbarItemGroup {
                if !connectionsStore.connections.isEmpty {
                    Picker("Project", selection: $connectionsStore.selectedConnectionID) {
                        ForEach(connectionsStore.connections) { connection in
                            Text(verbatim: connection.selectorLabel)
                                .tag(Optional(connection.id))
                        }
                    }
                    .labelsHidden()
                    .frame(width: 240)
                }

                Button {
                    connectionsStore.addSheetPresented = true
                } label: {
                    Label("Add Project", systemImage: "server.rack")
                }

                if !connectionsStore.connections.isEmpty {
                    Button {
                        editingConnection = connectionsStore.selectedConnection
                    } label: {
                        Label("Edit Project", systemImage: "pencil")
                    }
                    .disabled(connectionsStore.selectedConnection == nil)

                    Button(role: .destructive) {
                        connectionPendingRemoval = connectionsStore.selectedConnection
                    } label: {
                        Label("Remove Project", systemImage: "trash")
                    }
                    .disabled(connectionsStore.selectedConnection == nil)

                    Button {
                        store.createSheetPresented = true
                    } label: {
                        Label("Create Worktree", systemImage: "plus")
                    }
                    .disabled(connectionsStore.selectedConnection == nil)

                    Button {
                        Task {
                            await store.reload()
                        }
                    } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .disabled(store.isLoading || store.isConnecting || connectionsStore.selectedConnection == nil)
                }
            }
        }
        .overlay {
            if store.isConnecting {
                ProgressView("Connecting to webmux backend…")
                    .padding(20)
                    .background(.regularMaterial)
                    .clipShape(RoundedRectangle(cornerRadius: 12))
            }
        }
        .sheet(isPresented: $store.createSheetPresented) {
            CreateWorktreeSheet { mode, branch in
                await store.createWorktree(mode: mode, branch: branch)
            }
        }
        .sheet(isPresented: $connectionsStore.addSheetPresented) {
            AddConnectionSheet(connectionsStore: connectionsStore)
        }
        .sheet(item: $editingConnection) { connection in
            AddConnectionSheet(
                connectionsStore: connectionsStore,
                editingConnection: connection
            )
        }
        .alert("webmux", isPresented: alertPresented) {
            Button("OK", role: .cancel) {
                store.alertMessage = nil
            }
        } message: {
            Text(verbatim: store.alertMessage ?? "")
        }
        .confirmationDialog(
            "Remove Project?",
            isPresented: connectionRemovalPresented
        ) {
            Button("Remove", role: .destructive) {
                if let connectionPendingRemoval {
                    connectionsStore.removeConnection(connectionPendingRemoval)
                    self.connectionPendingRemoval = nil
                }
            }
        } message: {
            Text(verbatim: "This will remove the saved connection for \(connectionPendingRemoval?.name ?? "this project").")
        }
    }

    private var selectedConnectionName: String {
        connectionsStore.selectedConnection?.name ?? store.project?.name ?? "webmux"
    }

    private var emptyStateView: some View {
        ContentUnavailableView {
            Label("No Projects Added", systemImage: "server.rack")
        } description: {
            Text("Add a webmux server to load worktrees and attach terminals.")
        } actions: {
            Button("Add Project") {
                connectionsStore.addSheetPresented = true
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        if let worktree = store.selectedWorktree {
            VStack(alignment: .leading, spacing: 20) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(verbatim: worktree.branch)
                        .font(.largeTitle.weight(.semibold))

                    Text(verbatim: worktree.path)
                        .font(.callout)
                        .foregroundStyle(.secondary)

                    HStack(spacing: 12) {
                        Label {
                            Text(verbatim: worktree.mux ? "Open" : "Closed")
                        } icon: {
                            Image(systemName: worktree.mux ? "bolt.horizontal.circle.fill" : "pause.circle")
                        }
                        Label {
                            Text(verbatim: worktree.status)
                        } icon: {
                            Image(systemName: "terminal")
                        }
                        Label {
                            Text(verbatim: "\(worktree.paneCount) panes")
                        } icon: {
                            Image(systemName: "square.split.2x1")
                        }
                    }
                    .font(.callout)
                }

                HStack(spacing: 12) {
                    Button("Open Worktree") {
                        Task {
                            await store.openSelectedWorktree()
                        }
                    }
                    .disabled(worktree.mux)

                    Button("Close Worktree") {
                        Task {
                            await store.closeSelectedWorktree()
                        }
                    }
                    .disabled(!worktree.mux)
                }

                terminalPanel
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

    private var alertPresented: Binding<Bool> {
        Binding(
            get: { store.alertMessage != nil },
            set: { newValue in
                if !newValue {
                    store.alertMessage = nil
                }
            }
        )
    }

    private var connectionRemovalPresented: Binding<Bool> {
        Binding(
            get: { connectionPendingRemoval != nil },
            set: { newValue in
                if !newValue {
                    connectionPendingRemoval = nil
                }
            }
        )
    }

    @ViewBuilder
    private var terminalPanel: some View {
        ZStack(alignment: .topLeading) {
            RoundedRectangle(cornerRadius: 14)
                .fill(Color(nsColor: .windowBackgroundColor))

            if store.isResolvingTerminal {
                ProgressView("Attaching terminal…")
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else if let terminalSession = store.terminalSession {
                GhosttyTerminalContainer(session: terminalSession)
                    .id(terminalSession.id)
                    .clipShape(RoundedRectangle(cornerRadius: 14))
            } else {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Terminal")
                        .font(.headline)
                    Text(verbatim: store.terminalMessage ?? "Select an open worktree to attach the terminal.")
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
