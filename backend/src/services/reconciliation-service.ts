import { basename, resolve } from "node:path";
import { expandTemplate } from "../adapters/config";
import type { GitGateway, GitWorktreeEntry } from "../adapters/git";
import type { PortProbe } from "../adapters/port-probe";
import { buildProjectSessionName, buildWorktreeWindowName, WEBMUX_WORKTREE_ID_OPTION, type TmuxGateway, type TmuxWindowSummary } from "../adapters/tmux";
import { buildRuntimeEnvMap, readWorktreeMeta, readWorktreePrs, readWorktreeRuntimeState } from "../adapters/fs";
import type { AgentId, ProjectConfig } from "../domain/config";
import type { AgentRuntimeState, PrEntry, ServiceRuntimeState } from "../domain/model";
import { mapWithConcurrency } from "../lib/async";
import { ProjectRuntime } from "./project-runtime";

function makeUnmanagedWorktreeId(path: string): string {
  return `unmanaged:${resolve(path)}`;
}

function isValidPort(port: number | null): port is number {
  return port !== null && Number.isInteger(port) && port >= 1 && port <= 65535;
}

async function buildServiceStates(
  deps: Pick<ReconciliationServiceDependencies, "config" | "portProbe">,
  input: {
    allocatedPorts: Record<string, number>;
    startupEnvValues: Record<string, string>;
    worktreeId: string;
    branch: string;
    profile: string;
    agent: AgentId;
    runtime: "host" | "docker";
  },
): Promise<ServiceRuntimeState[]> {
  const runtimeEnv = buildRuntimeEnvMap({
    schemaVersion: 1,
    worktreeId: input.worktreeId,
    branch: input.branch,
    createdAt: "",
    profile: input.profile,
    agent: input.agent,
    runtime: input.runtime,
    startupEnvValues: input.startupEnvValues,
    allocatedPorts: input.allocatedPorts,
  });

  return Promise.all(deps.config.services.map(async (service) => {
    const port = input.allocatedPorts[service.portEnv] ?? null;
    const running = isValidPort(port)
      ? await deps.portProbe.isListening(port)
      : false;
    return {
      name: service.name,
      port,
      running,
      url: port !== null && service.urlTemplate
        ? expandTemplate(service.urlTemplate, runtimeEnv)
        : null,
    };
  }));
}

function findWindow(
  windows: TmuxWindowSummary[],
  sessionName: string,
  branch: string,
  worktreeId: string,
  worktreePath: string,
): { window: TmuxWindowSummary; matchedBy: "stamp" | "name" | "path" } | null {
  // 1) stamped lookup — durable identity (set on creation or recovered before).
  const stamped = windows.find((w) =>
    w.sessionName === sessionName && w.webmuxWorktreeId === worktreeId
  );
  if (stamped) return { window: stamped, matchedBy: "stamp" };

  // 2) legacy name-based lookup. Stable while the branch hasn't been renamed.
  const expectedName = buildWorktreeWindowName(branch);
  const named = windows.find((w) =>
    w.sessionName === sessionName && w.windowName === expectedName
  );
  if (named) return { window: named, matchedBy: "name" };

  // 3) cwd-based recovery — handles `git switch -b` / `git branch -m` inside a
  // worktree where the window name is now stale but the pane is still alive in
  // the worktree directory.
  const targetPath = resolve(worktreePath);
  const byPath = windows.find((w) =>
    w.sessionName === sessionName
    && typeof w.paneCurrentPath === "string"
    && resolve(w.paneCurrentPath) === targetPath
  );
  if (byPath) return { window: byPath, matchedBy: "path" };

  return null;
}

function resolveBranch(entry: GitWorktreeEntry, metaBranch: string | null): string {
  const fallback = basename(entry.path);
  return entry.branch ?? metaBranch ?? (fallback.length > 0 ? fallback : "unknown");
}

export interface ReconciliationServiceDependencies {
  config: ProjectConfig;
  git: GitGateway;
  tmux: TmuxGateway;
  portProbe: PortProbe;
  runtime: ProjectRuntime;
}

export interface ReconciliationServiceOptions {
  freshnessMs?: number;
  now?: () => number;
  concurrency?: number;
}

export interface ReconcileOptions {
  force?: boolean;
}

interface ReconciledWorktreeState {
  worktreeId: string;
  gitDir: string;
  branch: string;
  baseBranch: string | null;
  path: string;
  profile: string | null;
  agentName: AgentId | null;
  yolo: boolean;
  runtime: "host" | "docker";
  git: {
    dirty: boolean;
    aheadCount: number;
    currentCommit: string | null;
  };
  session: {
    exists: boolean;
    sessionName: string | null;
    paneCount: number;
  };
  services: ServiceRuntimeState[];
  prs: PrEntry[];
  persistedAgent: AgentRuntimeState | null;
}

export class ReconciliationService {
  private readonly freshnessMs: number;
  private readonly now: () => number;
  private readonly concurrency: number;
  private inFlight: Promise<void> | null = null;
  private lastReconciledAt = 0;

  constructor(
    private readonly deps: ReconciliationServiceDependencies,
    options: ReconciliationServiceOptions = {},
  ) {
    this.freshnessMs = options.freshnessMs ?? 500;
    this.now = options.now ?? Date.now;
    this.concurrency = options.concurrency ?? 4;
  }

  async reconcile(repoRoot: string, options: ReconcileOptions = {}): Promise<void> {
    if (this.inFlight) {
      return await this.inFlight;
    }

    if (!options.force && this.now() - this.lastReconciledAt < this.freshnessMs) {
      return;
    }

    const normalizedRepoRoot = resolve(repoRoot);
    const reconcilePromise = this.runReconcile(normalizedRepoRoot).then(() => {
      this.lastReconciledAt = this.now();
    });
    this.inFlight = reconcilePromise.finally(() => {
      this.inFlight = null;
    });
    return await this.inFlight;
  }

  private async runReconcile(normalizedRepoRoot: string): Promise<void> {
    const worktrees = this.deps.git.listWorktrees(normalizedRepoRoot);
    const sessionName = buildProjectSessionName(normalizedRepoRoot);

    let windows: TmuxWindowSummary[] = [];
    try {
      windows = this.deps.tmux.listWindows();
    } catch {
      windows = [];
    }

    const seenWorktreeIds = new Set<string>();

    const candidateEntries = worktrees.filter((entry) =>
      !entry.bare && resolve(entry.path) !== normalizedRepoRoot
    );
    const reconciledStates = await mapWithConcurrency(candidateEntries, this.concurrency, async (entry) => {
      const gitDir = this.deps.git.resolveWorktreeGitDir(entry.path);
      const [meta, persistedRuntime] = await Promise.all([
        readWorktreeMeta(gitDir),
        readWorktreeRuntimeState(gitDir),
      ]);
      const branch = resolveBranch(entry, meta?.branch ?? null);
      const worktreeId = meta?.worktreeId ?? makeUnmanagedWorktreeId(entry.path);
      const gitStatus = this.deps.git.readWorktreeStatus(entry.path);
      const match = findWindow(windows, sessionName, branch, worktreeId, entry.path);
      const window = match?.window ?? null;
      if (match && match.matchedBy !== "stamp") {
        // Recovered an unstamped window (legacy or cwd-fallback). Stamp it now
        // and rename to the current branch so future reconciles use the stable
        // identity path.
        try {
          this.deps.tmux.setWindowOption(
            match.window.sessionName,
            match.window.windowName,
            WEBMUX_WORKTREE_ID_OPTION,
            worktreeId,
          );
          // Update in-memory summary so subsequent code in this tick sees the stamp.
          match.window.webmuxWorktreeId = worktreeId;

          const expectedName = buildWorktreeWindowName(branch);
          if (match.window.windowName !== expectedName && this.deps.tmux.renameWindow) {
            this.deps.tmux.renameWindow(match.window.sessionName, match.window.windowName, expectedName);
            match.window.windowName = expectedName;
          }
        } catch {
          // Stamping is best-effort; failure here just means we'll try again next tick.
        }
      }

      const persistedAgent: AgentRuntimeState | null = persistedRuntime
        ? {
            runtime: meta?.runtime ?? "host",
            lifecycle: persistedRuntime.lifecycle,
            lastStartedAt: persistedRuntime.lastStartedAt,
            lastEventAt: persistedRuntime.lastEventAt,
            lastError: persistedRuntime.lastError,
          }
        : null;

      return {
        worktreeId,
        gitDir,
        branch,
        baseBranch: meta?.baseBranch ?? null,
        path: entry.path,
        profile: meta?.profile ?? null,
        agentName: meta?.agent ?? null,
        yolo: meta?.yolo === true,
        runtime: meta?.runtime ?? "host",
        git: {
          dirty: gitStatus.dirty,
          aheadCount: gitStatus.aheadCount,
          currentCommit: gitStatus.currentCommit,
        },
        session: {
          exists: window !== null,
          sessionName: window?.sessionName ?? null,
          paneCount: window?.paneCount ?? 0,
        },
        services: meta
          ? await buildServiceStates(this.deps, {
              allocatedPorts: meta.allocatedPorts,
              startupEnvValues: meta.startupEnvValues,
              worktreeId: meta.worktreeId,
              branch,
              profile: meta.profile,
              agent: meta.agent,
              runtime: meta.runtime,
            })
          : [],
        prs: await readWorktreePrs(gitDir),
        persistedAgent,
      } satisfies ReconciledWorktreeState;
    });

    for (const state of reconciledStates) {
      seenWorktreeIds.add(state.worktreeId);

      this.deps.runtime.upsertWorktree({
        worktreeId: state.worktreeId,
        branch: state.branch,
        baseBranch: state.baseBranch,
        path: state.path,
        profile: state.profile,
        agentName: state.agentName,
        yolo: state.yolo,
        runtime: state.runtime,
        gitDir: state.gitDir,
        persistedAgent: state.persistedAgent,
      });

      this.deps.runtime.setGitState(state.worktreeId, {
        exists: true,
        branch: state.branch,
        dirty: state.git.dirty,
        aheadCount: state.git.aheadCount,
        currentCommit: state.git.currentCommit,
      });

      this.deps.runtime.setSessionState(state.worktreeId, {
        exists: state.session.exists,
        sessionName: state.session.sessionName,
        paneCount: state.session.paneCount,
      });

      this.deps.runtime.setServices(state.worktreeId, state.services);
      this.deps.runtime.setPrs(state.worktreeId, state.prs);
    }

    for (const state of this.deps.runtime.listWorktrees()) {
      if (!seenWorktreeIds.has(state.worktreeId)) {
        this.deps.runtime.removeWorktree(state.worktreeId);
      }
    }
  }
}
