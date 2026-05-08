import { describe, expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";
import { createProjectScope } from "../services/project-scope";
import { BunTmuxGateway } from "../adapters/tmux";
import { BunGitGateway } from "../adapters/git";
import { BunDockerGateway } from "../adapters/docker";
import { BunPortProbe } from "../adapters/port-probe";
import { BunLifecycleHookRunner } from "../adapters/hooks";
import { AutoNameService } from "../services/auto-name-service";
import { NotificationService } from "../services/notification-service";

function fakeProjectDir(): string {
  const dir = mkdtempSync(`${tmpdir()}/wm-scope-`);
  writeFileSync(join(dir, ".webmux.yaml"), "name: scope-test\nworkspace:\n  mainBranch: main\n");
  // git init so adapters that resolve gitDir don't fail
  execSync(`git -C ${dir} init -q && git -C ${dir} commit --allow-empty -q -m init`, { stdio: "ignore" });
  return resolve(dir);
}

function buildGlobals() {
  return {
    git: new BunGitGateway(),
    tmux: new BunTmuxGateway(),
    docker: new BunDockerGateway(),
    portProbe: new BunPortProbe(),
    hooks: new BunLifecycleHookRunner(),
    autoName: new AutoNameService(),
    runtimeNotifications: new NotificationService(),
  };
}

describe("createProjectScope", () => {
  test("constructs a scope with all per-project services bound to the project dir", () => {
    const dir = fakeProjectDir();
    const scope = createProjectScope({ projectDir: dir, port: 9999, ...buildGlobals() });

    expect(scope.projectDir).toBe(dir);
    expect(scope.config.name).toBe("scope-test");
    expect(scope.scratchSessionService).toBeDefined();
    expect(scope.lifecycleService).toBeDefined();
    expect(scope.reconciliationService).toBeDefined();
    expect(scope.archiveStateService).toBeDefined();
    expect(scope.projectRuntime).toBeDefined();
    expect(scope.worktreeCreationTracker).toBeDefined();
    expect(scope.removingBranches).toBeInstanceOf(Set);
    expect(scope.projectId).toMatch(/^[0-9a-f]{8}$/);
  });

  test("dispose() runs without throwing on a fresh scope", () => {
    const dir = fakeProjectDir();
    const scope = createProjectScope({ projectDir: dir, port: 9999, ...buildGlobals() });
    expect(() => scope.dispose()).not.toThrow();
  });
});
