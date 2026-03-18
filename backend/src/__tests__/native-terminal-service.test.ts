import { describe, expect, it } from "bun:test";
import { ProjectRuntime } from "../services/project-runtime";
import { buildNativeTerminalTarget } from "../services/native-terminal-service";

describe("buildNativeTerminalTarget", () => {
  it("returns the native tmux attach target for an open worktree", () => {
    const runtime = new ProjectRuntime();
    runtime.upsertWorktree({
      worktreeId: "wt_search",
      branch: "feature/search",
      path: "/repo/__worktrees/feature-search",
      profile: "default",
      agentName: "claude",
      runtime: "host",
    });
    runtime.setSessionState("wt_search", {
      exists: true,
      sessionName: "wm-project-12345678",
      paneCount: 3,
    });

    const target = buildNativeTerminalTarget(
      "feature/search",
      runtime.getWorktreeByBranch("feature/search"),
    );

    expect(target).toEqual({
      ok: true,
      data: {
        worktreeId: "wt_search",
        branch: "feature/search",
        path: "/repo/__worktrees/feature-search",
        ownerSessionName: "wm-project-12345678",
        windowName: "wm-feature/search",
        paneCount: 3,
      },
    });
  });

  it("returns a not found error when the branch is unknown", () => {
    const target = buildNativeTerminalTarget("feature/missing", null);

    expect(target).toEqual({
      ok: false,
      reason: "not_found",
      message: "Worktree not found: feature/missing",
    });
  });

  it("returns a closed-session error when the worktree exists but has no tmux window", () => {
    const runtime = new ProjectRuntime();
    runtime.upsertWorktree({
      worktreeId: "wt_closed",
      branch: "feature/closed",
      path: "/repo/__worktrees/feature-closed",
      runtime: "host",
    });

    const target = buildNativeTerminalTarget(
      "feature/closed",
      runtime.getWorktreeByBranch("feature/closed"),
    );

    expect(target).toEqual({
      ok: false,
      reason: "closed",
      message: "No open tmux window found for worktree: feature/closed",
    });
  });
});
