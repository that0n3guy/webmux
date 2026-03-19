import Foundation

enum CreateWorktreeMode: String, CaseIterable, Identifiable, Codable {
    case new
    case existing

    var id: String { rawValue }
}

struct ProjectSnapshot: Decodable {
    struct Project: Decodable {
        let name: String
        let mainBranch: String
    }

    let project: Project
    let worktrees: [WorktreeSnapshot]
}

struct WorktreeSnapshot: Decodable, Identifiable, Hashable {
    let branch: String
    let path: String
    let dir: String
    let profile: String?
    let agentName: String?
    let mux: Bool
    let dirty: Bool
    let unpushed: Bool
    let paneCount: Int
    let status: String
    let elapsed: String
    let creation: WorktreeCreationState?

    var id: String { branch }
}

struct WorktreeCreationState: Decodable, Hashable {
    let phase: String
}

struct NativeTerminalLaunch: Decodable, Hashable {
    let worktreeId: String
    let branch: String
    let path: String
    let shellCommand: String
}

struct CreateWorktreeRequest: Encodable {
    let mode: CreateWorktreeMode
    let branch: String?
}

struct CreateWorktreeResponse: Decodable {
    let branch: String
}

struct APIErrorPayload: Decodable {
    let error: String
}
