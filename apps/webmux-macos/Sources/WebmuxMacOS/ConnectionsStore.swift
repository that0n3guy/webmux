import Foundation

@MainActor
final class ConnectionsStore: ObservableObject {
    @Published private(set) var connections: [ConnectionProfile]
    @Published var selectedConnectionID: String? {
        didSet {
            persistSelectedConnectionID()
        }
    }
    @Published var addSheetPresented = false

    private let userDefaults: UserDefaults

    init(userDefaults: UserDefaults = .standard) {
        self.userDefaults = userDefaults

        if let data = userDefaults.data(forKey: Self.connectionsKey),
           let decoded = try? JSONDecoder().decode([ConnectionProfile].self, from: data) {
            connections = decoded
        } else {
            connections = []
        }

        let storedSelection = userDefaults.string(forKey: Self.selectedConnectionIDKey)
        if let storedSelection,
           connections.contains(where: { $0.id == storedSelection }) {
            selectedConnectionID = storedSelection
        } else {
            selectedConnectionID = connections.first?.id
        }
    }

    var selectedConnection: ConnectionProfile? {
        guard let selectedConnectionID else { return nil }
        return connections.first(where: { $0.id == selectedConnectionID })
    }

    func addConnection(from draft: ConnectionDraft) async throws -> ConnectionProfile {
        let resolved = try resolve(draft: draft)
        try ensureNoDuplicate(for: resolved)

        let snapshot = try await BackendClient(baseURL: resolved.apiBaseURL).fetchProject()
        let profile = ConnectionProfile(
            id: UUID().uuidString,
            name: snapshot.project.name,
            mode: resolved.mode,
            apiBaseURL: resolved.apiBaseURL,
            ssh: resolved.ssh
        )

        connections.append(profile)
        persistConnections()
        selectedConnectionID = profile.id
        return profile
    }

    func updateConnection(_ connection: ConnectionProfile, from draft: ConnectionDraft) async throws -> ConnectionProfile {
        let resolved = try resolve(draft: draft)
        try ensureNoDuplicate(for: resolved, excluding: connection.id)

        let snapshot = try await BackendClient(baseURL: resolved.apiBaseURL).fetchProject()
        let updated = ConnectionProfile(
            id: connection.id,
            name: snapshot.project.name,
            mode: resolved.mode,
            apiBaseURL: resolved.apiBaseURL,
            ssh: resolved.ssh
        )

        guard let index = connections.firstIndex(where: { $0.id == connection.id }) else {
            throw ConnectionStoreError.connectionNotFound
        }

        connections[index] = updated
        persistConnections()
        if selectedConnectionID == connection.id {
            selectedConnectionID = updated.id
        }
        return updated
    }

    func removeConnection(_ connection: ConnectionProfile) {
        guard let index = connections.firstIndex(where: { $0.id == connection.id }) else {
            return
        }

        connections.remove(at: index)

        if selectedConnectionID == connection.id {
            let replacement = connections.indices.contains(index) ? connections[index] : connections.last
            selectedConnectionID = replacement?.id
        }

        persistConnections()
    }

    private func resolve(draft: ConnectionDraft) throws -> ResolvedConnectionDraft {
        let rawURL = draft.apiBaseURL.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rawURL.isEmpty else {
            throw ConnectionStoreError.missingServerURL
        }

        guard var components = URLComponents(string: rawURL),
              let scheme = components.scheme?.lowercased(),
              ["http", "https"].contains(scheme),
              let host = components.host?.lowercased() else {
            throw ConnectionStoreError.invalidServerURL(rawURL)
        }

        if components.path == "/" {
            components.path = ""
        }

        guard let apiBaseURL = components.url else {
            throw ConnectionStoreError.invalidServerURL(rawURL)
        }

        switch draft.mode {
        case .local:
            guard Self.isLoopbackHost(host) else {
                throw ConnectionStoreError.localConnectionRequiresLoopbackHost
            }

            return ResolvedConnectionDraft(
                mode: .local,
                apiBaseURL: apiBaseURL,
                ssh: nil
            )
        case .remote:
            let sshHost = nonEmpty(draft.sshHost)?.lowercased() ?? host
            let sshUser = nonEmpty(draft.sshUser) ?? NSUserName()
            let sshPort = try resolveSSHPort(from: draft.sshPort)
            return ResolvedConnectionDraft(
                mode: .remote,
                apiBaseURL: apiBaseURL,
                ssh: SSHConnectionConfig(host: sshHost, user: sshUser, port: sshPort)
            )
        }
    }

    private func ensureNoDuplicate(
        for draft: ResolvedConnectionDraft,
        excluding excludedID: String? = nil
    ) throws {
        let alreadyExists = connections.contains { connection in
            guard connection.id != excludedID else { return false }
            return connection.mode == draft.mode &&
                connection.apiBaseURL.absoluteString == draft.apiBaseURL.absoluteString &&
                connection.ssh == draft.ssh
        }

        if alreadyExists {
            throw ConnectionStoreError.duplicateConnection
        }
    }

    private func resolveSSHPort(from rawValue: String) throws -> Int {
        let trimmed = rawValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return 22 }
        guard let port = Int(trimmed),
              (1...65535).contains(port) else {
            throw ConnectionStoreError.invalidSSHPort(rawValue)
        }

        return port
    }

    private func persistConnections() {
        guard let data = try? JSONEncoder().encode(connections) else { return }
        userDefaults.set(data, forKey: Self.connectionsKey)
    }

    private func persistSelectedConnectionID() {
        userDefaults.set(selectedConnectionID, forKey: Self.selectedConnectionIDKey)
    }

    private func nonEmpty(_ value: String) -> String? {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func isLoopbackHost(_ host: String) -> Bool {
        switch host {
        case "localhost", "127.0.0.1", "::1", "0.0.0.0":
            return true
        default:
            return false
        }
    }

    private struct ResolvedConnectionDraft {
        let mode: ConnectionMode
        let apiBaseURL: URL
        let ssh: SSHConnectionConfig?
    }

    private static let connectionsKey = "webmux.macos.savedConnections"
    private static let selectedConnectionIDKey = "webmux.macos.selectedConnectionID"
}

enum ConnectionStoreError: LocalizedError {
    case missingServerURL
    case invalidServerURL(String)
    case localConnectionRequiresLoopbackHost
    case invalidSSHPort(String)
    case duplicateConnection
    case connectionNotFound

    var errorDescription: String? {
        switch self {
        case .missingServerURL:
            return "Enter a webmux server URL."
        case .invalidServerURL(let value):
            return "The server URL is invalid: \(value)"
        case .localConnectionRequiresLoopbackHost:
            return "Local connections must use a loopback server URL such as http://127.0.0.1:5111."
        case .invalidSSHPort(let value):
            return "The SSH port is invalid: \(value)"
        case .duplicateConnection:
            return "That project connection has already been added."
        case .connectionNotFound:
            return "That project connection could not be found."
        }
    }
}
