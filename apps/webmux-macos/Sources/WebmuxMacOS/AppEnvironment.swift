import Foundation

enum AppEnvironment {
    static let shared = EnvironmentValues()

    struct EnvironmentValues {
        let repoRoot: URL
        let projectRoot: URL
        let backendPort: Int
        let useIsolatedTmux: Bool
        let isolatedTmuxSocketName: String?
        let ghosttyResourcesDir: URL?
        let ghosttyTerminfoDir: URL?

        init(processInfo: ProcessInfo = .processInfo) {
            let environment = processInfo.environment
            let sourceFile = URL(fileURLWithPath: #filePath)
            let fallbackRoot = sourceFile
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
                .deletingLastPathComponent()
            let detectedRoot = Self.findRepoRoot(startingAt: sourceFile.deletingLastPathComponent()) ?? fallbackRoot
            repoRoot = URL(fileURLWithPath: environment["WEBMUX_NATIVE_REPO_ROOT"] ?? detectedRoot.path)
            projectRoot = URL(fileURLWithPath: environment["WEBMUX_NATIVE_PROJECT_DIR"] ?? repoRoot.path)
            backendPort = Int(environment["WEBMUX_NATIVE_PORT"] ?? "") ?? 6121
            useIsolatedTmux = (environment["WEBMUX_NATIVE_TMUX_MODE"] ?? "isolated") != "live"
            isolatedTmuxSocketName = useIsolatedTmux
                ? environment["WEBMUX_ISOLATED_TMUX_SOCKET_NAME"] ?? Self.defaultIsolatedTmuxSocketName(
                    projectRoot: projectRoot,
                    backendPort: backendPort
                )
                : nil
            ghosttyResourcesDir = Self.findGhosttyResourcesDir(environment: environment, repoRoot: repoRoot)
            ghosttyTerminfoDir = Self.findGhosttyTerminfoDir(ghosttyResourcesDir: ghosttyResourcesDir)
        }

        var backendBaseURL: URL {
            URL(string: "http://127.0.0.1:\(backendPort)")!
        }

        var tmuxCommandPrefix: String {
            Self.tmuxCommandPrefix(
                useIsolatedTmux: useIsolatedTmux,
                isolatedTmuxSocketName: isolatedTmuxSocketName
            )
        }

        private static func tmuxCommandPrefix(
            useIsolatedTmux: Bool,
            isolatedTmuxSocketName: String?
        ) -> String {
            guard useIsolatedTmux,
                  let isolatedTmuxSocketName else {
                return "tmux"
            }

            return "tmux -L \(ShellQuoter.quote(isolatedTmuxSocketName))"
        }

        private static func findRepoRoot(startingAt url: URL) -> URL? {
            var current = url
            let fileManager = FileManager.default

            while current.path != "/" {
                if fileManager.fileExists(atPath: current.appending(path: ".git").path) {
                    return current
                }

                current.deleteLastPathComponent()
            }

            return nil
        }

        private static func findGhosttyResourcesDir(
            environment: [String: String],
            repoRoot: URL
        ) -> URL? {
            let fileManager = FileManager.default

            if let override = environment["WEBMUX_NATIVE_GHOSTTY_RESOURCES_DIR"] ?? environment["GHOSTTY_RESOURCES_DIR"] {
                let url = URL(fileURLWithPath: override)
                if fileManager.fileExists(atPath: url.path) {
                    return url
                }
            }

            let bundledResources = repoRoot
                .appending(path: "apps")
                .appending(path: "webmux-macos")
                .appending(path: "ThirdParty")
                .appending(path: "GhosttyResources")
                .appending(path: "share")
                .appending(path: "ghostty")
            if fileManager.fileExists(atPath: bundledResources.path) {
                return bundledResources
            }

            return nil
        }

        private static func findGhosttyTerminfoDir(ghosttyResourcesDir: URL?) -> URL? {
            guard let ghosttyResourcesDir else { return nil }

            let terminfoDir = ghosttyResourcesDir
                .deletingLastPathComponent()
                .appending(path: "terminfo")
            guard FileManager.default.fileExists(atPath: terminfoDir.path) else {
                return nil
            }

            return terminfoDir
        }

        private static func defaultIsolatedTmuxSocketName(
            projectRoot: URL,
            backendPort: Int
        ) -> String {
            let basename = projectRoot.lastPathComponent
                .lowercased()
                .replacingOccurrences(of: #"[^a-z0-9_-]+"#, with: "-", options: .regularExpression)
                .trimmingCharacters(in: CharacterSet(charactersIn: "-"))
            let prefix = basename.isEmpty ? "webmux" : String(basename.prefix(24))
            return "webmux-native-\(prefix)-\(backendPort)"
        }
    }
}
