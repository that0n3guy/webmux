import { projectRoot, type ProjectConfig } from "./adapters/config";
import { BunDockerGateway } from "./adapters/docker";
import { BunGitGateway } from "./adapters/git";
import { BunLifecycleHookRunner } from "./adapters/hooks";
import { BunPortProbe } from "./adapters/port-probe";
import { BunTmuxGateway } from "./adapters/tmux";
import { AutoNameService } from "./services/auto-name-service";
import { NotificationService as RuntimeNotificationService } from "./services/notification-service";
import { createProjectScope, type ProjectScope } from "./services/project-scope";
import { type CreateWorktreeProgress } from "./services/lifecycle-service";

export interface WebmuxRuntimeOptions {
  projectDir?: string;
  port?: number;
  onCreateProgress?: (progress: CreateWorktreeProgress) => void | Promise<void>;
}

export interface WebmuxRuntime {
  port: number;
  projectDir: string;
  config: ProjectConfig;
  git: BunGitGateway;
  tmux: BunTmuxGateway;
  docker: BunDockerGateway;
  portProbe: BunPortProbe;
  hooks: BunLifecycleHookRunner;
  autoName: AutoNameService;
  runtimeNotifications: RuntimeNotificationService;
  scope: ProjectScope;
}

export function createWebmuxRuntime(options: WebmuxRuntimeOptions = {}): WebmuxRuntime {
  const port = options.port ?? parseInt(Bun.env.PORT || "5111", 10);
  const projectDir = projectRoot(options.projectDir ?? Bun.env.WEBMUX_PROJECT_DIR ?? process.cwd());

  const git = new BunGitGateway();
  const tmux = new BunTmuxGateway();
  const docker = new BunDockerGateway();
  const portProbe = new BunPortProbe();
  const hooks = new BunLifecycleHookRunner();
  const autoName = new AutoNameService();
  const runtimeNotifications = new RuntimeNotificationService();

  const scope = createProjectScope({
    projectDir,
    port,
    git,
    tmux,
    docker,
    portProbe,
    hooks,
    autoName,
    runtimeNotifications,
    onCreateProgress: options.onCreateProgress,
  });

  return {
    port,
    projectDir,
    config: scope.config,
    git,
    tmux,
    docker,
    portProbe,
    hooks,
    autoName,
    runtimeNotifications,
    scope,
  };
}
