import { loadConfig, type ProjectConfig } from "../adapters/config";
import { loadControlToken } from "../adapters/control-token";
import type { BunDockerGateway } from "../adapters/docker";
import type { BunGitGateway } from "../adapters/git";
import type { BunLifecycleHookRunner } from "../adapters/hooks";
import type { UserPreferences } from "../adapters/preferences";
import type { BunPortProbe } from "../adapters/port-probe";
import type { BunTmuxGateway } from "../adapters/tmux";
import { computeProjectId } from "../adapters/tmux";
import { writeWorktreeRuntimeState } from "../adapters/fs";
import { ArchiveStateService } from "./archive-state-service";
import { type AutoNameService } from "./auto-name-service";
import { LifecycleService, type CreateWorktreeProgress } from "./lifecycle-service";
import { type NotificationService } from "./notification-service";
import { ProjectRuntime } from "./project-runtime";
import { ReconciliationService } from "./reconciliation-service";
import { createRuntimeStatePersistence } from "./runtime-state-persistence";
import { createScratchSessionService, type ScratchSessionService } from "./scratch-session-service";
import { getAgentDefinition } from "./agent-registry";
import { buildBareAgentInvocation } from "./agent-service";
import { WorktreeCreationTracker } from "./worktree-creation-service";

export interface ProjectScopeDeps {
  projectDir: string;
  port: number;
  git: BunGitGateway;
  tmux: BunTmuxGateway;
  docker: BunDockerGateway;
  portProbe: BunPortProbe;
  hooks: BunLifecycleHookRunner;
  autoName: AutoNameService;
  runtimeNotifications: NotificationService;
  preferences?: UserPreferences;
  onCreateProgress?: (progress: CreateWorktreeProgress) => void | Promise<void>;
}

export interface ProjectScope {
  projectId: string;
  projectDir: string;
  config: ProjectConfig;
  archiveStateService: ArchiveStateService;
  projectRuntime: ProjectRuntime;
  worktreeCreationTracker: WorktreeCreationTracker;
  reconciliationService: ReconciliationService;
  lifecycleService: LifecycleService;
  scratchSessionService: ScratchSessionService;
  removingBranches: Set<string>;
  refreshConfig(preferences: UserPreferences): void;
  dispose(): void;
}

export function createProjectScope(deps: ProjectScopeDeps): ProjectScope {
  const projectDir = deps.projectDir;
  const projectId = computeProjectId(projectDir);
  const config = loadConfig(projectDir, { resolvedRoot: true, preferences: deps.preferences });

  const archiveStateService = new ArchiveStateService(deps.git.resolveWorktreeGitDir(projectDir));
  const runtimeStatePersistence = createRuntimeStatePersistence({
    writeRuntimeState: writeWorktreeRuntimeState,
  });
  const projectRuntime = new ProjectRuntime({
    persistRuntimeState: (worktreeId, gitDir, state) => {
      runtimeStatePersistence.schedule(worktreeId, gitDir, state);
    },
  });
  const worktreeCreationTracker = new WorktreeCreationTracker();

  const reconciliationService = new ReconciliationService({
    config,
    git: deps.git,
    tmux: deps.tmux,
    portProbe: deps.portProbe,
    runtime: projectRuntime,
  });

  const lifecycleService = new LifecycleService({
    projectRoot: projectDir,
    controlBaseUrl: `http://127.0.0.1:${deps.port}`,
    getControlToken: loadControlToken,
    config,
    archiveState: archiveStateService,
    git: deps.git,
    tmux: deps.tmux,
    docker: deps.docker,
    reconciliation: reconciliationService,
    hooks: deps.hooks,
    autoName: deps.autoName,
    onCreateProgress: (progress) => {
      worktreeCreationTracker.set(progress);
      deps.onCreateProgress?.(progress);
    },
    onCreateFinished: (branch) => {
      worktreeCreationTracker.clear(branch);
    },
  });

  const scratchSessionService = createScratchSessionService({
    tmux: deps.tmux,
    cwd: projectDir,
    projectId,
    getAgentLaunchCommand: (agentId, opts) => {
      const agent = getAgentDefinition(config, agentId);
      if (!agent) return null;
      return buildBareAgentInvocation(agent, { cwd: projectDir, yolo: opts.yolo });
    },
  });
  scratchSessionService.scan();

  const removingBranches = new Set<string>();

  return {
    projectId,
    projectDir,
    config,
    archiveStateService,
    projectRuntime,
    worktreeCreationTracker,
    reconciliationService,
    lifecycleService,
    scratchSessionService,
    removingBranches,
    refreshConfig(preferences: UserPreferences): void {
      const next = loadConfig(projectDir, { resolvedRoot: true, preferences });
      config.name = next.name;
      config.workspace = next.workspace;
      config.profiles = next.profiles;
      config.agents = next.agents;
      config.services = next.services;
      config.startupEnvs = next.startupEnvs;
      config.integrations = next.integrations;
      config.lifecycleHooks = next.lifecycleHooks;
      config.autoName = next.autoName;
    },
    dispose() {
      // Per spec MP-2: dispose is a placeholder until per-service shutdowns are added.
      // Today's services don't expose stop methods. Scope becoming unreachable suffices.
    },
  };
}
