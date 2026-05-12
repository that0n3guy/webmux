import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProjectConfig } from "../domain/config";
import type { GitGateway, GitWorktreeEntry, GitWorktreeStatus, TryGitCommandResult, UnpushedCommit } from "../adapters/git";
import type { PortProbe } from "../adapters/port-probe";
import type { TmuxGateway, TmuxWindowSummary } from "../adapters/tmux";
import { buildProjectSessionName, buildWorktreeWindowName } from "../adapters/tmux";
import { writeWorktreeMeta, writeWorktreePrs, writeWorktreeRuntimeState } from "../adapters/fs";
import { ProjectRuntime } from "../services/project-runtime";
import { ReconciliationService } from "../services/reconciliation-service";

interface Deferred {
  promise: Promise<void>;
  resolve: () => void;
}

class FakeGitGateway implements GitGateway {
  constructor(
    private readonly worktrees: GitWorktreeEntry[],
    private readonly gitDirs: Map<string, string>,
    private readonly statuses: Map<string, GitWorktreeStatus>,
  ) {}

  resolveRepoRoot(dir: string): string | null {
    return dir;
  }

  resolveWorktreeRoot(cwd: string): string {
    return cwd;
  }

  resolveWorktreeGitDir(cwd: string): string {
    const gitDir = this.gitDirs.get(cwd);
    if (!gitDir) throw new Error(`Missing git dir for ${cwd}`);
    return gitDir;
  }

  listWorktrees(): GitWorktreeEntry[] {
    return this.worktrees;
  }

  listLocalBranches(): string[] {
    return [];
  }

  listRemoteBranches(): string[] {
    return [];
  }

  readWorktreeStatus(cwd: string): GitWorktreeStatus {
    return this.statuses.get(cwd) ?? { dirty: false, aheadCount: 0, currentCommit: null };
  }

  readStatus(): string {
    return "";
  }

  createWorktree(): void {
    throw new Error("not implemented");
  }

  removeWorktree(): void {
    throw new Error("not implemented");
  }

  deleteBranch(): void {
    throw new Error("not implemented");
  }

  mergeBranch(): void {
    throw new Error("not implemented");
  }

  currentBranch(): string {
    return "main";
  }

  readDiff(): string {
    return "";
  }

  listUnpushedCommits(): UnpushedCommit[] {
    return [];
  }

  fetchBranch(_repoRoot: string, _remote: string, _branch: string): TryGitCommandResult {
    return { ok: true, stdout: "" };
  }

  fastForwardMerge(_repoRoot: string, _ref: string): TryGitCommandResult {
    return { ok: true, stdout: "" };
  }

  hardReset(_repoRoot: string, _ref: string): TryGitCommandResult {
    return { ok: true, stdout: "" };
  }
}

class FakeTmuxGateway implements TmuxGateway {
  constructor(private readonly windows: TmuxWindowSummary[]) {}
  setWindowOptionCalls: Array<{ session: string; window: string; option: string; value: string }> = [];
  renameWindowCalls: Array<{ session: string; from: string; to: string }> = [];

  ensureServer(): void {
    throw new Error("not implemented");
  }

  ensureSession(): void {
    throw new Error("not implemented");
  }

  hasWindow(): boolean {
    throw new Error("not implemented");
  }

  killWindow(): void {
    throw new Error("not implemented");
  }

  createWindow(): void {
    throw new Error("not implemented");
  }

  splitWindow(): void {
    throw new Error("not implemented");
  }

  setWindowOption(session: string, window: string, option: string, value: string): void {
    this.setWindowOptionCalls.push({ session, window, option, value });
  }

  renameWindow(session: string, from: string, to: string): void {
    this.renameWindowCalls.push({ session, from, to });
  }

  runCommand(): void {
    throw new Error("not implemented");
  }

  selectPane(): void {
    throw new Error("not implemented");
  }

  listWindows(): TmuxWindowSummary[] {
    return this.windows;
  }

  capturePane(_target: string, _lines: number): string[] {
    return [];
  }

  killSession(): void { throw new Error("not implemented"); }
  setSessionOption(): void { throw new Error("not implemented"); }
  getSessionOption(): string | null { throw new Error("not implemented"); }
  listAllSessions(): ReturnType<TmuxGateway["listAllSessions"]> { throw new Error("not implemented"); }
  getFirstWindowName(): string | null { throw new Error("not implemented"); }
  getPaneCurrentCommand(): string | null { return null; }
  getPaneCurrentPath(): string | null { return null; }
}

class FakePortProbe implements PortProbe {
  readonly calls: number[] = [];

  constructor(
    private readonly listening = new Set<number>(),
    private readonly onProbe?: (port: number) => Promise<void> | void,
  ) {}

  async isListening(port: number): Promise<boolean> {
    this.calls.push(port);
    await this.onProbe?.(port);
    return this.listening.has(port);
  }
}

function deferred(): Deferred {
  let resolve!: () => void;
  return {
    promise: new Promise<void>((res) => {
      resolve = res;
    }),
    resolve,
  };
}

const TEST_CONFIG: ProjectConfig = {
  name: "Project",
  workspace: {
    mainBranch: "main",
    worktreeRoot: "__worktrees",
    defaultAgent: "claude",
    autoPull: { enabled: false, intervalSeconds: 300 },
  },
  profiles: {
    default: {
      runtime: "host",
      envPassthrough: [],
      panes: [],
    },
  },
  agents: {},
  services: [
    {
      name: "frontend",
      portEnv: "FRONTEND_PORT",
      urlTemplate: "http://127.0.0.1:${FRONTEND_PORT}",
    },
  ],
  startupEnvs: {},
  integrations: {
    github: { linkedRepos: [], autoRemoveOnMerge: false },
    linear: { enabled: true, autoCreateWorktrees: false, createTicketOption: false },
  },
  lifecycleHooks: {},
  autoName: null,
};

describe("ReconciliationService", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("reconciles managed worktrees into the runtime and removes stale entries", async () => {
    const repoRoot = "/repo/project";
    const managedPath = "/repo/project/__worktrees/feature-search";
    const managedGitDir = await mkdtemp(join(tmpdir(), "webmux-reconcile-managed-"));
    tempDirs.push(managedGitDir);

    await writeWorktreeMeta(managedGitDir, {
      schemaVersion: 1,
      worktreeId: "wt_feature",
      branch: "feature/search",
      baseBranch: "main",
      createdAt: "2026-03-06T00:00:00.000Z",
      profile: "default",
      agent: "claude",
      runtime: "host",
      startupEnvValues: {},
      allocatedPorts: { FRONTEND_PORT: 3010 },
      yolo: true,
    });
    await writeWorktreePrs(managedGitDir, [
      {
        repo: "org/repo",
        number: 77,
        state: "open",
        url: "https://github.com/org/repo/pull/77",
        updatedAt: "2026-03-06T00:05:00.000Z",
        ciStatus: "success",
        ciChecks: [],
        comments: [],
      },
    ]);

    const runtime = new ProjectRuntime();
    runtime.upsertWorktree({
      worktreeId: "wt_stale",
      branch: "feature/stale",
      path: "/repo/project/__worktrees/feature-stale",
      runtime: "host",
    });

    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
        { path: managedPath, branch: "feature/search", head: "bbb222", detached: false, bare: false },
      ],
      new Map([[managedPath, managedGitDir]]),
      new Map([[managedPath, { dirty: true, aheadCount: 2, currentCommit: "bbb222" }]]),
    );
    const tmux = new FakeTmuxGateway([
      {
        sessionName: buildProjectSessionName(repoRoot),
        windowName: buildWorktreeWindowName("feature/search"),
        paneCount: 3,
      },
    ]);

    const service = new ReconciliationService({
      config: TEST_CONFIG,
      git,
      tmux,
      portProbe: new FakePortProbe(new Set([3010])),
      runtime,
    });

    await service.reconcile(repoRoot);

    const state = runtime.getWorktree("wt_feature");
    expect(state).not.toBeNull();
    expect(state?.branch).toBe("feature/search");
    expect(state?.baseBranch).toBe("main");
    expect(state?.profile).toBe("default");
    expect(state?.git.dirty).toBe(true);
    expect(state?.git.aheadCount).toBe(2);
    expect(state?.git.currentCommit).toBe("bbb222");
    expect(state?.session.exists).toBe(true);
    expect(state?.session.paneCount).toBe(3);
    expect(state?.services).toEqual([
      {
        name: "frontend",
        port: 3010,
        running: true,
        url: "http://127.0.0.1:3010",
      },
    ]);
    expect(state?.prs).toEqual([
      {
        repo: "org/repo",
        number: 77,
        state: "open",
        url: "https://github.com/org/repo/pull/77",
        updatedAt: "2026-03-06T00:05:00.000Z",
        ciStatus: "success",
        ciChecks: [],
        comments: [],
      },
    ]);
    expect(state?.yolo).toBe(true);
    expect(runtime.getWorktree("wt_stale")).toBeNull();
  });

  it("recovers tmux window after branch rename via cwd fallback, then stamps + renames it", async () => {
    const repoRoot = "/repo/project";
    const managedPath = "/repo/project/__worktrees/oauth/pica-migration";
    const managedGitDir = await mkdtemp(join(tmpdir(), "webmux-reconcile-rename-"));
    tempDirs.push(managedGitDir);

    await writeWorktreeMeta(managedGitDir, {
      schemaVersion: 1,
      worktreeId: "wt_pica",
      branch: "oauth/pica-migration",
      baseBranch: "main",
      createdAt: "2026-04-30T00:00:00.000Z",
      profile: "default",
      agent: "claude",
      runtime: "host",
      startupEnvValues: {},
      allocatedPorts: {},
      yolo: false,
    });

    const runtime = new ProjectRuntime();
    const sessionName = buildProjectSessionName(repoRoot);
    const oldWindowName = buildWorktreeWindowName("oauth/pica-migration");

    // git now reports the worktree on the renamed branch
    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
        { path: managedPath, branch: "docs/pica-pickup-cleanup", head: "bbb222", detached: false, bare: false },
      ],
      new Map([[managedPath, managedGitDir]]),
      new Map([[managedPath, { dirty: false, aheadCount: 0, currentCommit: "bbb222" }]]),
    );

    // tmux still has the OLD window name, no stamp, but its pane is in the worktree path.
    const tmux = new FakeTmuxGateway([
      {
        sessionName,
        windowName: oldWindowName,
        paneCount: 1,
        paneCurrentPath: managedPath,
        webmuxWorktreeId: null,
      },
    ]);

    const service = new ReconciliationService({
      config: TEST_CONFIG,
      git,
      tmux,
      portProbe: new FakePortProbe(new Set()),
      runtime,
    });

    await service.reconcile(repoRoot);

    const state = runtime.getWorktree("wt_pica");
    expect(state).not.toBeNull();
    expect(state?.branch).toBe("docs/pica-pickup-cleanup");
    // the agent should NOT look invisible — session.exists must be true
    expect(state?.session.exists).toBe(true);

    // window should now be stamped and renamed to match the current branch
    expect(tmux.setWindowOptionCalls).toContainEqual({
      session: sessionName,
      window: oldWindowName,
      option: "@webmux-worktree-id",
      value: "wt_pica",
    });
    expect(tmux.renameWindowCalls).toContainEqual({
      session: sessionName,
      from: oldWindowName,
      to: buildWorktreeWindowName("docs/pica-pickup-cleanup"),
    });
  });

  it("renames a stamped window when the branch shifts again (no re-stamp)", async () => {
    const repoRoot = "/repo/project";
    const managedPath = "/repo/project/__worktrees/oauth/pica-migration";
    const managedGitDir = await mkdtemp(join(tmpdir(), "webmux-reconcile-restamp-"));
    tempDirs.push(managedGitDir);

    await writeWorktreeMeta(managedGitDir, {
      schemaVersion: 1,
      worktreeId: "wt_pica",
      branch: "docs/pica-pickup-cleanup",
      baseBranch: "main",
      createdAt: "2026-04-30T00:00:00.000Z",
      profile: "default",
      agent: "claude",
      runtime: "host",
      startupEnvValues: {},
      allocatedPorts: {},
      yolo: false,
    });

    const runtime = new ProjectRuntime();
    const sessionName = buildProjectSessionName(repoRoot);

    // git now reports a NEW branch (a second rename happened inside the worktree)
    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
        { path: managedPath, branch: "tests/pica-tranche", head: "ccc333", detached: false, bare: false },
      ],
      new Map([[managedPath, managedGitDir]]),
      new Map([[managedPath, { dirty: false, aheadCount: 0, currentCommit: "ccc333" }]]),
    );

    // window is already stamped with worktreeId from a prior reconciliation, but
    // its name still reflects the previous branch (it's been through one rename
    // already). The sidebar's per-branch link points at the CURRENT branch name,
    // so the window must follow.
    const tmux = new FakeTmuxGateway([
      {
        sessionName,
        windowName: buildWorktreeWindowName("docs/pica-pickup-cleanup"),
        paneCount: 1,
        paneCurrentPath: managedPath,
        webmuxWorktreeId: "wt_pica",
      },
    ]);

    const service = new ReconciliationService({
      config: TEST_CONFIG,
      git,
      tmux,
      portProbe: new FakePortProbe(new Set()),
      runtime,
    });

    await service.reconcile(repoRoot);

    const state = runtime.getWorktree("wt_pica");
    expect(state?.session.exists).toBe(true);
    // already stamped — must not re-stamp
    expect(tmux.setWindowOptionCalls).toEqual([]);
    // but must rename the window to follow the current branch
    expect(tmux.renameWindowCalls).toContainEqual({
      session: sessionName,
      from: buildWorktreeWindowName("docs/pica-pickup-cleanup"),
      to: buildWorktreeWindowName("tests/pica-tranche"),
    });
  });

  it("matches stamped windows directly even when the name and branch disagree", async () => {
    const repoRoot = "/repo/project";
    const managedPath = "/repo/project/__worktrees/feat";
    const managedGitDir = await mkdtemp(join(tmpdir(), "webmux-reconcile-stamped-"));
    tempDirs.push(managedGitDir);

    await writeWorktreeMeta(managedGitDir, {
      schemaVersion: 1,
      worktreeId: "wt_feat",
      branch: "feat/old",
      baseBranch: "main",
      createdAt: "2026-04-30T00:00:00.000Z",
      profile: "default",
      agent: "claude",
      runtime: "host",
      startupEnvValues: {},
      allocatedPorts: {},
      yolo: false,
    });

    const runtime = new ProjectRuntime();
    const sessionName = buildProjectSessionName(repoRoot);

    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
        { path: managedPath, branch: "feat/new", head: "bbb222", detached: false, bare: false },
      ],
      new Map([[managedPath, managedGitDir]]),
      new Map([[managedPath, { dirty: false, aheadCount: 0, currentCommit: "bbb222" }]]),
    );

    // window is stamped with worktreeId — name/path don't matter for lookup
    const tmux = new FakeTmuxGateway([
      {
        sessionName,
        windowName: "wm-feat/old",
        paneCount: 1,
        paneCurrentPath: null,
        webmuxWorktreeId: "wt_feat",
      },
    ]);

    const service = new ReconciliationService({
      config: TEST_CONFIG,
      git,
      tmux,
      portProbe: new FakePortProbe(new Set()),
      runtime,
    });

    await service.reconcile(repoRoot);
    const state = runtime.getWorktree("wt_feat");
    expect(state?.session.exists).toBe(true);
    // already stamped — reconciliation should not re-stamp it (idempotency)
    expect(tmux.setWindowOptionCalls).toEqual([]);
  });

  it("creates synthetic ids for unmanaged worktrees", async () => {
    const repoRoot = "/repo/project";
    const unmanagedPath = "/repo/project/__worktrees/unmanaged";

    const runtime = new ProjectRuntime();
    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
        { path: unmanagedPath, branch: "feature/unmanaged", head: "ccc333", detached: false, bare: false },
      ],
      new Map([[unmanagedPath, unmanagedPath]]),
      new Map([[unmanagedPath, { dirty: false, aheadCount: 0, currentCommit: "ccc333" }]]),
    );
    const tmux = new FakeTmuxGateway([]);

    const service = new ReconciliationService({
      config: TEST_CONFIG,
      git,
      tmux,
      portProbe: new FakePortProbe(),
      runtime,
    });

    await service.reconcile(repoRoot);

    const state = runtime.getWorktreeByBranch("feature/unmanaged");
    expect(state).not.toBeNull();
    expect(state?.worktreeId.startsWith("unmanaged:")).toBe(true);
    expect(state?.profile).toBeNull();
    expect(state?.agentName).toBeNull();
    expect(state?.yolo).toBe(false);
    expect(state?.services).toEqual([]);
  });

  it("marks an existing runtime entry as orphaned when git drops it but the stamped tmux window survives", async () => {
    const repoRoot = "/repo/project";
    const orphanPath = "/repo/project/__worktrees/plan/continued-1";

    const runtime = new ProjectRuntime();
    runtime.upsertWorktree({
      worktreeId: "wt_orphan",
      branch: "plan/continued-1",
      path: orphanPath,
      profile: "default",
      agentName: "claude",
      runtime: "host",
    });

    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
      ],
      new Map(),
      new Map(),
    );
    const tmux = new FakeTmuxGateway([
      {
        sessionName: buildProjectSessionName(repoRoot),
        windowName: buildWorktreeWindowName("plan/continued-1"),
        paneCount: 1,
        paneCurrentPath: `${orphanPath} (deleted)`,
        webmuxWorktreeId: "wt_orphan",
      },
    ]);

    const service = new ReconciliationService({
      config: TEST_CONFIG,
      git,
      tmux,
      portProbe: new FakePortProbe(),
      runtime,
    });

    await service.reconcile(repoRoot);

    const state = runtime.getWorktree("wt_orphan");
    expect(state).not.toBeNull();
    expect(state?.orphaned).toBe(true);
    expect(state?.branch).toBe("plan/continued-1");
    expect(state?.profile).toBe("default");
  });

  it("reconstructs a runtime entry from a stamped tmux window with no prior state (cold start)", async () => {
    const repoRoot = "/repo/project";
    const orphanPath = "/repo/project/__worktrees/plan/continued-1";

    const runtime = new ProjectRuntime();

    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
      ],
      new Map(),
      new Map(),
    );
    const tmux = new FakeTmuxGateway([
      {
        sessionName: buildProjectSessionName(repoRoot),
        windowName: "wm-plan/continued-1",
        paneCount: 1,
        paneCurrentPath: `${orphanPath} (deleted)`,
        webmuxWorktreeId: "wt_cold_orphan",
      },
    ]);

    const service = new ReconciliationService({
      config: TEST_CONFIG,
      git,
      tmux,
      portProbe: new FakePortProbe(),
      runtime,
    });

    await service.reconcile(repoRoot);

    const state = runtime.getWorktree("wt_cold_orphan");
    expect(state).not.toBeNull();
    expect(state?.orphaned).toBe(true);
    expect(state?.branch).toBe("plan/continued-1");
    expect(state?.agent.lifecycle).toBe("closed");
    expect(state?.session.windowName).toBe("wm-plan/continued-1");
  });

  it("coalesces concurrent reconcile calls and skips fresh repeats", async () => {
    const repoRoot = "/repo/project";
    const managedPath = "/repo/project/__worktrees/feature-fresh";
    const managedGitDir = await mkdtemp(join(tmpdir(), "webmux-reconcile-fresh-"));
    tempDirs.push(managedGitDir);

    await writeWorktreeMeta(managedGitDir, {
      schemaVersion: 1,
      worktreeId: "wt_fresh",
      branch: "feature/fresh",
      createdAt: "2026-03-06T00:00:00.000Z",
      profile: "default",
      agent: "claude",
      runtime: "host",
      startupEnvValues: {},
      allocatedPorts: { FRONTEND_PORT: 3010 },
    });

    let probeCount = 0;
    const firstProbeReached = deferred();
    const firstProbeRelease = deferred();
    const secondProbeReached = deferred();
    const secondProbeRelease = deferred();
    let nowMs = 10_000;
    const portProbe = new FakePortProbe(new Set([3010]), async () => {
      probeCount += 1;
      if (probeCount === 1) {
        firstProbeReached.resolve();
        await firstProbeRelease.promise;
        return;
      }
      if (probeCount === 2) {
        secondProbeReached.resolve();
        await secondProbeRelease.promise;
        return;
      }
      throw new Error(`unexpected port probe ${probeCount}`);
    });
    const runtime = new ProjectRuntime();
    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
        { path: managedPath, branch: "feature/fresh", head: "bbb222", detached: false, bare: false },
      ],
      new Map([[managedPath, managedGitDir]]),
      new Map([[managedPath, { dirty: false, aheadCount: 0, currentCommit: "bbb222" }]]),
    );
    const service = new ReconciliationService(
      {
        config: TEST_CONFIG,
        git,
        tmux: new FakeTmuxGateway([]),
        portProbe,
        runtime,
      },
      {
        freshnessMs: 1000,
        now: () => nowMs,
      },
    );

    const first = service.reconcile(repoRoot);
    const second = service.reconcile(repoRoot);
    await firstProbeReached.promise;

    expect(portProbe.calls).toEqual([3010]);
    firstProbeRelease.resolve();
    await Promise.all([first, second]);
    expect(portProbe.calls).toEqual([3010]);

    await service.reconcile(repoRoot);
    expect(portProbe.calls).toEqual([3010]);

    nowMs += 1001;
    const third = service.reconcile(repoRoot);
    await secondProbeReached.promise;
    expect(portProbe.calls).toEqual([3010, 3010]);
    secondProbeRelease.resolve();
    await third;
  });

  it("seeds lifecycle from runtime-state.json when worktree is first seen", async () => {
    const repoRoot = "/repo/project";
    const managedPath = "/repo/project/__worktrees/feature-seeded";
    const managedGitDir = await mkdtemp(join(tmpdir(), "webmux-reconcile-seeded-"));
    tempDirs.push(managedGitDir);

    await writeWorktreeMeta(managedGitDir, {
      schemaVersion: 1,
      worktreeId: "wt_seeded",
      branch: "feature/seeded",
      baseBranch: "main",
      createdAt: "2026-04-28T00:00:00.000Z",
      profile: "default",
      agent: "claude",
      runtime: "host",
      startupEnvValues: {},
      allocatedPorts: {},
    });

    await writeWorktreeRuntimeState(managedGitDir, {
      schemaVersion: 1,
      lifecycle: "stopped",
      lastStartedAt: "2026-04-28T09:00:00.000Z",
      lastEventAt: "2026-04-28T09:30:00.000Z",
      lastError: null,
    });

    const runtime = new ProjectRuntime();
    const git = new FakeGitGateway(
      [
        { path: repoRoot, branch: "main", head: "aaa111", detached: false, bare: false },
        { path: managedPath, branch: "feature/seeded", head: "bbb222", detached: false, bare: false },
      ],
      new Map([[managedPath, managedGitDir]]),
      new Map([[managedPath, { dirty: false, aheadCount: 0, currentCommit: "bbb222" }]]),
    );

    const service = new ReconciliationService({
      config: TEST_CONFIG,
      git,
      tmux: new FakeTmuxGateway([]),
      portProbe: new FakePortProbe(),
      runtime,
    });

    await service.reconcile(repoRoot);

    const state = runtime.getWorktree("wt_seeded");
    expect(state?.agent.lifecycle).toBe("stopped");
    expect(state?.agent.lastStartedAt).toBe("2026-04-28T09:00:00.000Z");
    expect(state?.agent.lastEventAt).toBe("2026-04-28T09:30:00.000Z");
  });
});
