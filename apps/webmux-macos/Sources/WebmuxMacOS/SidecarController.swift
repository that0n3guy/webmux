import Foundation

actor SidecarController {
    private let environment: AppEnvironment.EnvironmentValues
    private let client: BackendClient
    private var process: Process?

    init(environment: AppEnvironment.EnvironmentValues, client: BackendClient) {
        self.environment = environment
        self.client = client
    }

    func ensureRunning() async throws {
        if await client.healthcheck() {
            return
        }

        if process == nil {
            try launch()
        }

        try await waitUntilHealthy()
    }

    func stop() {
        process?.terminate()
        process = nil
    }

    private func launch() throws {
        let process = Process()
        let outputPipe = Pipe()
        let errorPipe = Pipe()
        let isolatedTmuxWrapper = environment.repoRoot
            .appending(path: "scripts")
            .appending(path: "run-with-isolated-tmux.sh")
        let serverEntryPoint = environment.repoRoot
            .appending(path: "backend")
            .appending(path: "src")
            .appending(path: "server.ts")
        let launchArguments = environment.useIsolatedTmux
            ? ["bash", isolatedTmuxWrapper.path, "bun", serverEntryPoint.path]
            : ["bun", serverEntryPoint.path]

        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = launchArguments
        process.currentDirectoryURL = environment.repoRoot
        var childEnvironment = ProcessInfo.processInfo.environment.merging([
            "PORT": "\(environment.backendPort)",
            "WEBMUX_PROJECT_DIR": environment.projectRoot.path,
        ]) { _, newValue in newValue }
        if let isolatedTmuxSocketName = environment.isolatedTmuxSocketName {
            childEnvironment["WEBMUX_ISOLATED_TMUX_SOCKET_NAME"] = isolatedTmuxSocketName
        }
        process.environment = childEnvironment
        process.standardOutput = outputPipe
        process.standardError = errorPipe
        process.terminationHandler = { [weak self] terminatedProcess in
            Task {
                await self?.handleTermination(process: terminatedProcess)
            }
        }

        forward(pipe: outputPipe, prefix: "backend")
        forward(pipe: errorPipe, prefix: "backend")

        try process.run()
        self.process = process
    }

    private func waitUntilHealthy() async throws {
        for _ in 0..<50 {
            if await client.healthcheck() {
                return
            }

            try await Task.sleep(for: .milliseconds(200))
        }

        throw SidecarError.startTimedOut
    }

    private func handleTermination(process terminatedProcess: Process) {
        if process === terminatedProcess {
            process = nil
        }
    }

    private func forward(pipe: Pipe, prefix: String) {
        pipe.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty, let string = String(data: data, encoding: .utf8) else {
                handle.readabilityHandler = nil
                return
            }

            for line in string.split(whereSeparator: \.isNewline) {
                print("[\(prefix)] \(line)")
            }
        }
    }
}

enum SidecarError: LocalizedError {
    case startTimedOut

    var errorDescription: String? {
        switch self {
        case .startTimedOut:
            return "Timed out waiting for the Bun backend sidecar to start."
        }
    }
}
