import SwiftUI

struct AddConnectionSheet: View {
    @Environment(\.dismiss) private var dismiss

    @ObservedObject var connectionsStore: ConnectionsStore
    let editingConnection: ConnectionProfile?

    @State private var draft: ConnectionDraft
    @State private var errorMessage: String?
    @State private var isSubmitting = false

    init(
        connectionsStore: ConnectionsStore,
        editingConnection: ConnectionProfile? = nil
    ) {
        self.connectionsStore = connectionsStore
        self.editingConnection = editingConnection
        _draft = State(initialValue: editingConnection.map(ConnectionDraft.init(connection:)) ?? ConnectionDraft())
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            Text(editingConnection == nil ? "Add Project" : "Edit Project")
                .font(.title2.weight(.semibold))

            Form {
                TextField("Server URL", text: $draft.apiBaseURL)

                Picker("Connection Type", selection: $draft.mode) {
                    ForEach(ConnectionMode.allCases) { mode in
                        Text(mode.title).tag(mode)
                    }
                }
                .pickerStyle(.segmented)

                if draft.mode == .remote {
                    TextField("SSH Host", text: $draft.sshHost)
                    TextField("SSH User", text: $draft.sshUser)
                    TextField("SSH Port", text: $draft.sshPort)
                }
            }
            .formStyle(.grouped)

            Text(verbatim: helperText)
                .font(.callout)
                .foregroundStyle(.secondary)

            if let errorMessage {
                Text(verbatim: errorMessage)
                    .foregroundStyle(.red)
                    .font(.callout)
            }

            HStack {
                Spacer()

                Button("Cancel", role: .cancel) {
                    dismiss()
                }

                Button(submitButtonTitle) {
                    Task {
                        await submit()
                    }
                }
                .keyboardShortcut(.defaultAction)
                .disabled(isSubmitting || draft.apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(24)
        .frame(width: 460)
    }

    private var helperText: String {
        switch draft.mode {
        case .local:
            return "Local connections must use a loopback server URL such as http://127.0.0.1:5111. The terminal will run on this Mac."
        case .remote:
            return "Remote connections attach the terminal over SSH. If SSH Host is empty, the server URL host will be used."
        }
    }

    private var submitButtonTitle: String {
        if isSubmitting {
            return editingConnection == nil ? "Connecting..." : "Saving..."
        }

        return editingConnection == nil ? "Test and Add Project" : "Test and Save Project"
    }

    private func submit() async {
        errorMessage = nil
        isSubmitting = true
        defer { isSubmitting = false }

        do {
            if let editingConnection {
                _ = try await connectionsStore.updateConnection(editingConnection, from: draft)
            } else {
                _ = try await connectionsStore.addConnection(from: draft)
            }
            dismiss()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}
