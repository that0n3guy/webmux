import type { AgentLifecycle, CreatingWorktreeState, PrEntry, ProjectSnapshot, WorktreeSnapshot } from "../domain/model";
import type { RuntimeNotification } from "./notification-service";
import { ProjectRuntime } from "./project-runtime";

export type AgentActivityProbe = (
  state: ReturnType<ProjectRuntime["listWorktrees"]>[number],
) => { running: boolean } | null;

function formatElapsedSince(startedAt: string | null, now: () => Date): string {
  if (!startedAt) return "";
  const startedMs = Date.parse(startedAt);
  if (Number.isNaN(startedMs)) return "";

  const diffMs = Math.max(0, now().getTime() - startedMs);
  const diffMinutes = Math.floor(diffMs / 60_000);

  if (diffMinutes < 1) return "0m";
  if (diffMinutes < 60) return `${diffMinutes}m`;

  const diffHours = Math.floor(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h`;

  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}

function clonePrEntry(pr: PrEntry): PrEntry {
  return {
    ...pr,
    ciChecks: pr.ciChecks.map((check) => ({ ...check })),
    comments: pr.comments.map((comment) => ({ ...comment })),
  };
}

function mapCreationSnapshot(creating: CreatingWorktreeState | null): WorktreeSnapshot["creation"] {
  return creating
    ? {
        phase: creating.phase,
      }
    : null;
}

function resolveStatus(
  state: ReturnType<ProjectRuntime["listWorktrees"]>[number],
  creating: CreatingWorktreeState | null,
  probeAgentActivity?: AgentActivityProbe,
): AgentLifecycle | "creating" {
  if (creating) return "creating";
  if (state.orphaned || !state.session.exists || state.agentName === "claude") {
    return state.agent.lifecycle;
  }
  // Claude is the only agent wired into the lifecycle hook pipeline
  // (backend/src/adapters/agent-runtime.ts). For codex and custom agents we
  // fall back to the same activity probe used for scratch + external sessions.
  const probe = probeAgentActivity?.(state) ?? null;
  if (!probe) return state.agent.lifecycle;
  return probe.running ? "running" : "idle";
}

function mapWorktreeSnapshot(
  state: ReturnType<ProjectRuntime["listWorktrees"]>[number],
  now: () => Date,
  creating: CreatingWorktreeState | null,
  isArchived: (path: string) => boolean,
  findLinearIssue?: (branch: string) => WorktreeSnapshot["linearIssue"],
  findAgentLabel?: (agentId: string | null) => string | null,
  probeAgentActivity?: AgentActivityProbe,
): WorktreeSnapshot {
  return {
    branch: state.branch,
    ...(state.baseBranch ? { baseBranch: state.baseBranch } : {}),
    path: state.path,
    dir: state.path,
    archived: isArchived(state.path),
    profile: state.profile,
    agentName: state.agentName,
    agentLabel: findAgentLabel ? findAgentLabel(state.agentName) : state.agentName,
    mux: state.session.exists,
    dirty: state.orphaned ? false : state.git.dirty,
    unpushed: state.orphaned ? false : state.git.aheadCount > 0,
    paneCount: state.session.paneCount,
    status: resolveStatus(state, creating, probeAgentActivity),
    elapsed: formatElapsedSince(state.agent.lastStartedAt, now),
    services: state.orphaned ? [] : state.services.map((service) => ({ ...service })),
    prs: state.orphaned ? [] : state.prs.map((pr) => clonePrEntry(pr)),
    linearIssue: findLinearIssue ? findLinearIssue(state.branch) : null,
    creation: mapCreationSnapshot(creating),
    yolo: state.yolo,
    orphaned: state.orphaned,
  };
}

function mapCreatingWorktreeSnapshot(
  creating: CreatingWorktreeState,
  isArchived: (path: string) => boolean,
  findLinearIssue?: (branch: string) => WorktreeSnapshot["linearIssue"],
  findAgentLabel?: (agentId: string | null) => string | null,
): WorktreeSnapshot {
  return {
    branch: creating.branch,
    ...(creating.baseBranch ? { baseBranch: creating.baseBranch } : {}),
    path: creating.path,
    dir: creating.path,
    archived: isArchived(creating.path),
    profile: creating.profile,
    agentName: creating.agentName,
    agentLabel: findAgentLabel ? findAgentLabel(creating.agentName) : creating.agentName,
    mux: false,
    dirty: false,
    unpushed: false,
    paneCount: 0,
    status: "creating",
    elapsed: "",
    services: [],
    prs: [],
    linearIssue: findLinearIssue ? findLinearIssue(creating.branch) : null,
    creation: mapCreationSnapshot(creating),
    yolo: creating.yolo,
    orphaned: false,
  };
}

interface BuildWorktreeSnapshotsInput {
  runtime: ProjectRuntime;
  creatingWorktrees?: CreatingWorktreeState[];
  isArchived?: (path: string) => boolean;
  findLinearIssue?: (branch: string) => WorktreeSnapshot["linearIssue"];
  findAgentLabel?: (agentId: string | null) => string | null;
  probeAgentActivity?: AgentActivityProbe;
  now?: () => Date;
}

export function buildWorktreeSnapshots(input: BuildWorktreeSnapshotsInput): WorktreeSnapshot[] {
  const now = input.now ?? (() => new Date());
  const isArchived = input.isArchived ?? (() => false);
  const creatingWorktrees = input.creatingWorktrees ?? [];
  const creatingByBranch = new Map(creatingWorktrees.map((worktree) => [worktree.branch, worktree]));
  const runtimeWorktrees = input.runtime.listWorktrees();
  const runtimeBranches = new Set(runtimeWorktrees.map((worktree) => worktree.branch));
  const worktrees = runtimeWorktrees.map((state) =>
    mapWorktreeSnapshot(
      state,
      now,
      creatingByBranch.get(state.branch) ?? null,
      isArchived,
      input.findLinearIssue,
      input.findAgentLabel,
      input.probeAgentActivity,
    ),
  );

  for (const creating of creatingWorktrees) {
    if (!runtimeBranches.has(creating.branch)) {
      worktrees.push(mapCreatingWorktreeSnapshot(creating, isArchived, input.findLinearIssue, input.findAgentLabel));
    }
  }

  worktrees.sort((left, right) => left.branch.localeCompare(right.branch));

  return worktrees;
}

export function buildProjectSnapshot(input: BuildWorktreeSnapshotsInput & {
  projectName: string;
  mainBranch: string;
  notifications: RuntimeNotification[];
}): ProjectSnapshot {
  return {
    project: {
      name: input.projectName,
      mainBranch: input.mainBranch,
    },
    worktrees: buildWorktreeSnapshots(input),
    notifications: input.notifications.map((notification) => ({ ...notification })),
  };
}
