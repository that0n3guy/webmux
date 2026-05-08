import { describe, expect, it } from "bun:test";
import type { AgentRuntimeState } from "../domain/model";
import { ProjectRuntime } from "../services/project-runtime";

describe("ProjectRuntime", () => {
  it("creates a default runtime state when upserting a new worktree", () => {
    const runtime = new ProjectRuntime();
    const state = runtime.upsertWorktree({
      worktreeId: "wt_search",
      branch: "feature/search",
      baseBranch: "main",
      path: "/repo/__worktrees/feature-search",
      profile: "default",
      agentName: "claude",
      runtime: "host",
    });

    expect(state.worktreeId).toBe("wt_search");
    expect(state.branch).toBe("feature/search");
    expect(state.baseBranch).toBe("main");
    expect(state.profile).toBe("default");
    expect(state.agentName).toBe("claude");
    expect(state.session.windowName).toBe("wm-feature/search");
    expect(state.agent.lifecycle).toBe("closed");
    expect(state.prs).toEqual([]);
  });

  it("applies runtime events to an existing worktree", () => {
    const runtime = new ProjectRuntime();
    runtime.upsertWorktree({
      worktreeId: "wt_search",
      branch: "feature/search",
      path: "/repo/__worktrees/feature-search",
      runtime: "host",
    });

    runtime.applyEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_status_changed", lifecycle: "running" },
      () => new Date("2026-03-06T10:01:00.000Z"),
    );
    runtime.applyEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_status_changed", lifecycle: "idle" },
      () => new Date("2026-03-06T10:02:00.000Z"),
    );
    runtime.applyEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_status_changed", lifecycle: "running" },
      () => new Date("2026-03-06T10:03:00.000Z"),
    );

    const state = runtime.getWorktree("wt_search");
    expect(state?.agent.lifecycle).toBe("running");
    expect(state?.agent.lastStartedAt).toBe("2026-03-06T10:01:00.000Z");
    expect(state?.agent.lastEventAt).toBe("2026-03-06T10:03:00.000Z");
  });

  it("tracks runtime errors and service/session updates", () => {
    const runtime = new ProjectRuntime();
    runtime.upsertWorktree({
      worktreeId: "wt_search",
      branch: "feature/search",
      path: "/repo/__worktrees/feature-search",
      runtime: "docker",
    });

    runtime.setSessionState("wt_search", {
      exists: true,
      sessionName: "wm-project-12345678",
      paneCount: 2,
    });
    runtime.setServices("wt_search", [
      { name: "frontend", port: 3010, running: true, url: "http://127.0.0.1:3010" },
    ]);
    runtime.setPrs("wt_search", [
      {
        repo: "org/repo",
        number: 77,
        state: "open",
        url: "https://github.com/org/repo/pull/77",
        updatedAt: "2026-03-06T10:01:30.000Z",
        ciStatus: "success",
        ciChecks: [],
        comments: [],
      },
    ]);
    runtime.applyEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "runtime_error", message: "agent crashed" },
      () => new Date("2026-03-06T10:02:00.000Z"),
    );

    const state = runtime.getWorktree("wt_search");
    expect(state?.session.exists).toBe(true);
    expect(state?.session.paneCount).toBe(2);
    expect(state?.services[0]?.running).toBe(true);
    expect(state?.prs[0]?.number).toBe(77);
    expect(state?.agent.lifecycle).toBe("error");
    expect(state?.agent.lastError).toBe("agent crashed");
  });

  it("calls persistRuntimeState when agent events fire", () => {
    const persisted: Array<{ worktreeId: string; gitDir: string; lifecycle: string }> = [];

    const runtime = new ProjectRuntime({
      persistRuntimeState: (worktreeId, gitDir, state) => {
        persisted.push({ worktreeId, gitDir, lifecycle: state.lifecycle });
      },
    });

    runtime.upsertWorktree({
      worktreeId: "wt_persist",
      branch: "feature/persist",
      path: "/repo/__worktrees/feature-persist",
      runtime: "host",
      gitDir: "/git/dirs/feature-persist",
    });

    runtime.applyEvent(
      { worktreeId: "wt_persist", branch: "feature/persist", type: "agent_status_changed", lifecycle: "running" },
      () => new Date("2026-04-28T10:00:00.000Z"),
    );
    runtime.applyEvent(
      { worktreeId: "wt_persist", branch: "feature/persist", type: "agent_stopped" },
      () => new Date("2026-04-28T10:01:00.000Z"),
    );

    expect(persisted).toHaveLength(2);
    expect(persisted[0]?.gitDir).toBe("/git/dirs/feature-persist");
    expect(persisted[0]?.lifecycle).toBe("running");
    expect(persisted[1]?.lifecycle).toBe("stopped");
  });

  it("does not call persistRuntimeState when no gitDir is registered", () => {
    const persisted: unknown[] = [];

    const runtime = new ProjectRuntime({
      persistRuntimeState: () => { persisted.push(true); },
    });

    runtime.upsertWorktree({
      worktreeId: "wt_nogitdir",
      branch: "feature/no-gitdir",
      path: "/repo/__worktrees/no-gitdir",
      runtime: "host",
    });

    runtime.applyEvent(
      { worktreeId: "wt_nogitdir", branch: "feature/no-gitdir", type: "agent_status_changed", lifecycle: "idle" },
    );

    expect(persisted).toHaveLength(0);
  });

  it("seeds agent state from persistedAgent when creating a new worktree", () => {
    const runtime = new ProjectRuntime();
    const persistedAgent: AgentRuntimeState = {
      runtime: "host",
      lifecycle: "stopped",
      lastStartedAt: "2026-04-28T09:00:00.000Z",
      lastEventAt: "2026-04-28T09:30:00.000Z",
      lastError: null,
    };

    const state = runtime.upsertWorktree({
      worktreeId: "wt_seeded",
      branch: "feature/seeded",
      path: "/repo/__worktrees/feature-seeded",
      runtime: "host",
      persistedAgent,
    });

    expect(state.agent.lifecycle).toBe("stopped");
    expect(state.agent.lastStartedAt).toBe("2026-04-28T09:00:00.000Z");
    expect(state.agent.lastEventAt).toBe("2026-04-28T09:30:00.000Z");
    expect(state.agent.lastError).toBeNull();
  });

  it("does not overwrite in-memory agent state on subsequent upsertWorktree calls", () => {
    const runtime = new ProjectRuntime();

    runtime.upsertWorktree({
      worktreeId: "wt_existing",
      branch: "feature/existing",
      path: "/repo/__worktrees/feature-existing",
      runtime: "host",
    });

    runtime.applyEvent(
      { worktreeId: "wt_existing", branch: "feature/existing", type: "agent_status_changed", lifecycle: "running" },
    );

    const persistedAgent: AgentRuntimeState = {
      runtime: "host",
      lifecycle: "stopped",
      lastStartedAt: null,
      lastEventAt: null,
      lastError: null,
    };

    runtime.upsertWorktree({
      worktreeId: "wt_existing",
      branch: "feature/existing",
      path: "/repo/__worktrees/feature-existing",
      runtime: "host",
      persistedAgent,
    });

    expect(runtime.getWorktree("wt_existing")?.agent.lifecycle).toBe("running");
  });

  it("keeps branch lookups as a secondary index", () => {
    const runtime = new ProjectRuntime();
    runtime.upsertWorktree({
      worktreeId: "wt_search",
      branch: "feature/search",
      path: "/repo/__worktrees/feature-search",
      runtime: "host",
    });

    runtime.setGitState("wt_search", { branch: "feature/search-v2" });

    expect(runtime.getWorktreeByBranch("feature/search")).toBeNull();
    expect(runtime.getWorktreeByBranch("feature/search-v2")?.worktreeId).toBe("wt_search");
  });
});
