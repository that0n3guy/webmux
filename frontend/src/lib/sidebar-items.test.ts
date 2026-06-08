import { describe, expect, it } from "vitest";
import {
  applyReorder,
  buildSidebarItems,
  externalSidebarId,
  reconcileSidebarOrder,
  scratchSidebarId,
  splitSidebarItems,
  worktreeSidebarId,
} from "./sidebar-items";
import type { BuildSidebarItemsInput, SidebarItem } from "./sidebar-items";
import type { ExternalTmuxSession, ProjectInfo, ScratchSessionSnapshot } from "@webmux/api-contract";
import type { WorktreeInfo, WorktreeListRow } from "./types";

function makeProject(id: string, name = ""): ProjectInfo {
  return { id, path: `/projects/${id}`, name, addedAt: "2024-01-01T00:00:00Z", mainBranch: "main", defaultAgent: "claude" };
}

function makeWorktree(branch: string, mux = ""): WorktreeInfo {
  return {
    branch,
    archived: false,
    agent: "idle",
    mux,
    path: `/projects/${branch}`,
    dir: `/projects/${branch}`,
    dirty: false,
    unpushed: false,
    status: "idle",
    elapsed: "",
    profile: null,
    agentName: null,
    agentLabel: null,
    services: [],
    paneCount: 1,
    prs: [],
    linearIssue: null,
    creating: false,
    creationPhase: null,
    yolo: false,
    orphaned: false,
  };
}

function makeRow(branch: string, mux = "", depth = 0): WorktreeListRow {
  return { worktree: makeWorktree(branch, mux), depth };
}

function makeScratch(id: string): ScratchSessionSnapshot {
  return {
    id,
    displayName: id,
    sessionName: `scratch-${id}`,
    kind: "agent",
    agentId: "claude",
    cwd: "/tmp",
    createdAt: "2024-01-01T00:00:00Z",
    windowCount: 1,
    attached: false,
  };
}

function makeExternal(name: string): ExternalTmuxSession {
  return { name, windowCount: 1, attached: false };
}

function emptyInput(): BuildSidebarItemsInput {
  return { projects: [], rowsByProject: new Map(), scratchByProject: new Map(), externalSessions: [] };
}

describe("buildSidebarItems", () => {
  it("returns empty array for empty inputs", () => {
    expect(buildSidebarItems(emptyInput())).toEqual([]);
  });

  it("returns worktrees + scratch in order, with correct project label", () => {
    const proj = makeProject("p1", "My Project");
    const row1 = makeRow("feature/a");
    const row2 = makeRow("feature/b");
    const scratch = makeScratch("s1");

    const items = buildSidebarItems({
      projects: [proj],
      rowsByProject: new Map([["p1", [row1, row2]]]),
      scratchByProject: new Map([["p1", [scratch]]]),
      externalSessions: [],
    });

    expect(items).toHaveLength(3);
    expect(items[0].kind).toBe("worktree");
    expect(items[0].projectLabel).toBe("My Project");
    expect(items[1].kind).toBe("worktree");
    expect(items[2].kind).toBe("scratch");
    expect(items[2].active).toBe(true);
  });

  it("uses project.id as label when name is empty", () => {
    const proj = makeProject("p1", "");
    const row = makeRow("feature/a");
    const items = buildSidebarItems({
      projects: [proj],
      rowsByProject: new Map([["p1", [row]]]),
      scratchByProject: new Map(),
      externalSessions: [],
    });
    expect(items[0].projectLabel).toBe("p1");
  });

  it("worktree with mux='✓' is active; mux='' is inactive", () => {
    const proj = makeProject("p1", "P");
    const items = buildSidebarItems({
      projects: [proj],
      rowsByProject: new Map([["p1", [makeRow("a", "✓"), makeRow("b", "")]]]),
      scratchByProject: new Map(),
      externalSessions: [],
    });
    expect(items[0].active).toBe(true);
    expect(items[1].active).toBe(false);
  });

  it("external tmux sessions are always active", () => {
    const items = buildSidebarItems({
      ...emptyInput(),
      externalSessions: [makeExternal("tmux-session-1")],
    });
    expect(items).toHaveLength(1);
    expect(items[0].kind).toBe("external");
    expect(items[0].active).toBe(true);
    expect(items[0].projectId).toBeNull();
    expect(items[0].projectLabel).toBeNull();
  });

  it("places external sessions after all project items", () => {
    const proj = makeProject("p1", "P");
    const items = buildSidebarItems({
      projects: [proj],
      rowsByProject: new Map([["p1", [makeRow("a")]]]),
      scratchByProject: new Map(),
      externalSessions: [makeExternal("ext")],
    });
    expect(items[0].kind).toBe("worktree");
    expect(items[1].kind).toBe("external");
  });
});

describe("reconcileSidebarOrder", () => {
  function makeItems(ids: string[]): SidebarItem[] {
    return ids.map((id) => ({
      kind: "external" as const,
      id,
      projectId: null,
      projectLabel: null,
      active: true,
      session: makeExternal(id),
    }));
  }

  it("returns items in saved order when all present", () => {
    const items = makeItems(["a", "b", "c"]);
    const result = reconcileSidebarOrder(items, ["c", "a", "b"]);
    expect(result.map((x) => x.id)).toEqual(["c", "a", "b"]);
  });

  it("drops stale IDs from savedOrder silently", () => {
    const items = makeItems(["a", "b"]);
    const result = reconcileSidebarOrder(items, ["a", "stale1", "b", "stale2"]);
    expect(result.map((x) => x.id)).toEqual(["a", "b"]);
  });

  it("appends new items not in savedOrder in natural enumeration order", () => {
    const items = makeItems(["a", "b", "c"]);
    const result = reconcileSidebarOrder(items, ["b"]);
    expect(result.map((x) => x.id)).toEqual(["b", "a", "c"]);
  });

  it("with empty savedOrder returns natural enumeration order", () => {
    const items = makeItems(["a", "b", "c"]);
    const result = reconcileSidebarOrder(items, []);
    expect(result.map((x) => x.id)).toEqual(["a", "b", "c"]);
  });
});

describe("splitSidebarItems", () => {
  function item(id: string, active: boolean): SidebarItem {
    return { kind: "external", id, projectId: null, projectLabel: null, active, session: makeExternal(id) };
  }

  it("splits active and inactive, preserving relative order", () => {
    const items = [item("a", true), item("b", false), item("c", true), item("d", false)];
    const { active, inactive } = splitSidebarItems(items);
    expect(active.map((x) => x.id)).toEqual(["a", "c"]);
    expect(inactive.map((x) => x.id)).toEqual(["b", "d"]);
  });

  it("returns empty inactive bucket when all active", () => {
    const items = [item("a", true), item("b", true)];
    const { active, inactive } = splitSidebarItems(items);
    expect(active).toHaveLength(2);
    expect(inactive).toHaveLength(0);
  });

  it("returns empty active bucket when all inactive", () => {
    const items = [item("a", false), item("b", false)];
    const { active, inactive } = splitSidebarItems(items);
    expect(active).toHaveLength(0);
    expect(inactive).toHaveLength(2);
  });
});

describe("applyReorder", () => {
  it("moves item from middle to top", () => {
    expect(applyReorder(["a", "b", "c"], "c", "a")).toEqual(["c", "a", "b"]);
  });

  it("moves item from middle to bottom position (before last)", () => {
    expect(applyReorder(["a", "b", "c"], "a", "c")).toEqual(["b", "a", "c"]);
  });

  it("drag past self by one position — no duplicate", () => {
    const result = applyReorder(["a", "b", "c"], "b", "c");
    expect(result).toEqual(["a", "b", "c"]);
    expect(new Set(result).size).toBe(result.length);
  });

  it("dragged === target returns unchanged order", () => {
    expect(applyReorder(["a", "b", "c"], "b", "b")).toEqual(["a", "b", "c"]);
  });

  it("targetId not in order returns order unchanged", () => {
    expect(applyReorder(["a", "b", "c"], "a", "z")).toEqual(["a", "b", "c"]);
  });

  it("draggedId not in order, targetId in order — inserts before target", () => {
    const result = applyReorder(["a", "b", "c"], "x", "b");
    expect(result).toEqual(["a", "x", "b", "c"]);
  });
});

describe("stable ID helpers", () => {
  it("worktreeSidebarId produces expected format", () => {
    expect(worktreeSidebarId("proj1", "feature/foo")).toBe("worktree:proj1:feature/foo");
  });

  it("scratchSidebarId produces expected format", () => {
    expect(scratchSidebarId("proj1", "scratch-abc")).toBe("scratch:proj1:scratch-abc");
  });

  it("externalSidebarId produces expected format", () => {
    expect(externalSidebarId("my-session")).toBe("external:my-session");
  });
});
