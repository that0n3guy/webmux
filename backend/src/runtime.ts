import { existsSync } from "node:fs";
import { join } from "node:path";
import { projectRoot } from "./adapters/config";
import { BunDockerGateway } from "./adapters/docker";
import { BunGitGateway } from "./adapters/git";
import { BunLifecycleHookRunner } from "./adapters/hooks";
import { BunPortProbe } from "./adapters/port-probe";
import { BunTmuxGateway } from "./adapters/tmux";
import { AutoNameService } from "./services/auto-name-service";
import { NotificationService as RuntimeNotificationService } from "./services/notification-service";
import { createProjectRegistry, type ProjectRegistry } from "./services/project-registry";
import { log } from "./lib/log";

export interface WebmuxRuntimeOptions {
  projectDir?: string;
  port?: number;
}

export interface MultiProjectRuntime {
  port: number;
  git: BunGitGateway;
  tmux: BunTmuxGateway;
  docker: BunDockerGateway;
  portProbe: BunPortProbe;
  hooks: BunLifecycleHookRunner;
  autoName: AutoNameService;
  runtimeNotifications: RuntimeNotificationService;
  projectRegistry: ProjectRegistry;
}

// Backward-compat alias used by older imports (e.g., `import type { WebmuxRuntime }`).
export type WebmuxRuntime = MultiProjectRuntime;

export async function createWebmuxRuntime(options: WebmuxRuntimeOptions = {}): Promise<MultiProjectRuntime> {
  const port = options.port ?? parseInt(Bun.env.PORT || "5111", 10);
  const cwdHint = projectRoot(options.projectDir ?? Bun.env.WEBMUX_PROJECT_DIR ?? process.cwd());

  const git = new BunGitGateway();
  const tmux = new BunTmuxGateway();
  const docker = new BunDockerGateway();
  const portProbe = new BunPortProbe();
  const hooks = new BunLifecycleHookRunner();
  const autoName = new AutoNameService();
  const runtimeNotifications = new RuntimeNotificationService();

  const projectRegistry = createProjectRegistry({
    port,
    git,
    tmux,
    docker,
    portProbe,
    hooks,
    autoName,
    runtimeNotifications,
  });
  await projectRegistry.load();

  // First-run hydration: if registry is empty AND cwd has .webmux.yaml, auto-register cwd.
  if (projectRegistry.list().length === 0 && existsSync(join(cwdHint, ".webmux.yaml"))) {
    try {
      await projectRegistry.add({ path: cwdHint });
    } catch (err) {
      log.warn(`[runtime] first-run auto-add failed: ${err instanceof Error ? err.message : err}`);
    }
  }

  return {
    port,
    git,
    tmux,
    docker,
    portProbe,
    hooks,
    autoName,
    runtimeNotifications,
    projectRegistry,
  };
}
