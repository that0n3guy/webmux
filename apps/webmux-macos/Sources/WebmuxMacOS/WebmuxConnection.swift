import Foundation

@MainActor
protocol WebmuxConnection {
    var profile: ConnectionProfile { get }
    var client: BackendClient { get }

    func start() async throws
    func stop() async
    func makeTerminalSession(for launch: NativeTerminalLaunch) -> TerminalSessionDescriptor
}

final class LocalWebmuxConnection: WebmuxConnection {
    let profile: ConnectionProfile
    let client: BackendClient

    init(profile: ConnectionProfile, client: BackendClient) {
        self.profile = profile
        self.client = client
    }

    func start() async throws {
        guard await client.healthcheck() else {
            throw WebmuxConnectionError.backendUnavailable(profile.apiBaseURL)
        }
    }

    func stop() async {
    }

    func makeTerminalSession(for launch: NativeTerminalLaunch) -> TerminalSessionDescriptor {
        TerminalCommandFactory.makeSession(
            for: launch,
            profile: profile,
            workingDirectory: launch.path
        )
    }
}

final class RemoteWebmuxConnection: WebmuxConnection {
    let profile: ConnectionProfile
    let client: BackendClient

    private let workingDirectory: String

    init(
        profile: ConnectionProfile,
        client: BackendClient,
        workingDirectory: String = FileManager.default.homeDirectoryForCurrentUser.path
    ) {
        self.profile = profile
        self.client = client
        self.workingDirectory = workingDirectory
    }

    func start() async throws {
        guard await client.healthcheck() else {
            throw WebmuxConnectionError.backendUnavailable(profile.apiBaseURL)
        }
    }

    func stop() async {
    }

    func makeTerminalSession(for launch: NativeTerminalLaunch) -> TerminalSessionDescriptor {
        TerminalCommandFactory.makeSession(
            for: launch,
            profile: profile,
            workingDirectory: workingDirectory
        )
    }
}

enum WebmuxConnectionFactory {
    @MainActor
    static func make(profile: ConnectionProfile) -> any WebmuxConnection {
        let client = BackendClient(baseURL: profile.apiBaseURL)
        switch profile.mode {
        case .local:
            return LocalWebmuxConnection(profile: profile, client: client)
        case .remote:
            return RemoteWebmuxConnection(profile: profile, client: client)
        }
    }
}

enum WebmuxConnectionError: LocalizedError {
    case backendUnavailable(URL)

    var errorDescription: String? {
        switch self {
        case .backendUnavailable(let baseURL):
            return "Could not reach webmux backend at \(baseURL.absoluteString)."
        }
    }
}
