import { describe, expect, it } from "bun:test";
import { parseRuntimeEvent } from "../domain/events";
import { ProjectRuntime } from "../services/project-runtime";
import { resolveRuntimeEventScope } from "../services/runtime-event-routing";

describe("resolveRuntimeEventScope", () => {
  function makeScope(worktreeIds: string[]): { projectRuntime: ProjectRuntime } {
    const projectRuntime = new ProjectRuntime();
    for (const worktreeId of worktreeIds) {
      projectRuntime.upsertWorktree({
        worktreeId,
        branch: `branch-${worktreeId}`,
        path: `/tmp/${worktreeId}`,
      });
    }
    return { projectRuntime };
  }

  function makeRegistry(projects: Record<string, { projectRuntime: ProjectRuntime }>): {
    projectIds: string[];
    getScope: (id: string) => { projectRuntime: ProjectRuntime } | null;
  } {
    return {
      projectIds: Object.keys(projects),
      getScope: (id) => projects[id] ?? null,
    };
  }

  it("routes an event to the second project that owns the worktree when no projectId is given", () => {
    const first = makeScope(["wt-app"]);
    const second = makeScope(["wt-cli"]);
    const registry = makeRegistry({ "82973fcd": first, "6b68da92": second });

    const result = resolveRuntimeEventScope({
      explicitProjectId: null,
      worktreeId: "wt-cli",
      ...registry,
    });

    expect(result).toEqual({ ok: true, scope: second });
  });

  it("uses the explicit projectId when given", () => {
    const first = makeScope(["wt-app"]);
    const second = makeScope(["wt-cli"]);
    const registry = makeRegistry({ "82973fcd": first, "6b68da92": second });

    const result = resolveRuntimeEventScope({
      explicitProjectId: "6b68da92",
      worktreeId: "wt-cli",
      ...registry,
    });

    expect(result).toEqual({ ok: true, scope: second });
  });

  it("rejects an unknown explicit projectId", () => {
    const registry = makeRegistry({ "82973fcd": makeScope(["wt-app"]) });

    const result = resolveRuntimeEventScope({
      explicitProjectId: "deadbeef",
      worktreeId: "wt-app",
      ...registry,
    });

    expect(result).toEqual({ ok: false, message: "Project not found: deadbeef" });
  });

  it("falls back to the first project when no project owns the worktree", () => {
    const first = makeScope(["wt-app"]);
    const second = makeScope(["wt-cli"]);
    const registry = makeRegistry({ "82973fcd": first, "6b68da92": second });

    const result = resolveRuntimeEventScope({
      explicitProjectId: null,
      worktreeId: "wt-unknown",
      ...registry,
    });

    expect(result).toEqual({ ok: true, scope: first });
  });

  it("errors when no projects are registered", () => {
    const registry = makeRegistry({});

    const result = resolveRuntimeEventScope({
      explicitProjectId: null,
      worktreeId: "wt-app",
      ...registry,
    });

    expect(result).toEqual({ ok: false, message: "No project available" });
  });
});

describe("parseRuntimeEvent", () => {
  it("parses valid runtime events", () => {
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
    })).toEqual({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
    });
  });

  it("passes through the permission_prompt reason and drops unknown reasons", () => {
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
      reason: "permission_prompt",
    })).toEqual({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
      reason: "permission_prompt",
    });

    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
      reason: "coffee_break",
    })).toEqual({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
    });
  });

  it("rejects malformed runtime events", () => {
    expect(parseRuntimeEvent(null)).toBeNull();
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_started",
    })).toBeNull();
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "title_changed",
      title: "ignored",
    })).toBeNull();
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "closed",
    })).toBeNull();
    expect(parseRuntimeEvent({
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "runtime_error",
    })).toBeNull();
  });
});
