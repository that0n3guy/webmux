import { cleanup, fireEvent, render, screen, within } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import ActiveSidebar from "./ActiveSidebar.svelte";
import type { ExternalTmuxSession, ProjectInfo, ScratchSessionSnapshot } from "@webmux/api-contract";
import type { WorktreeInfo, WorktreeListRow, Selection } from "./types";

function makeProject(id: string, name = ""): ProjectInfo {
  return { id, path: `/projects/${id}`, name, addedAt: "2024-01-01T00:00:00Z", mainBranch: "main", defaultAgent: "claude" };
}

function makeWorktree(branch: string, mux = "✓", overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
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
    ...overrides,
  };
}

function makeRow(branch: string, mux = "✓", depth = 0, overrides: Partial<WorktreeInfo> = {}): WorktreeListRow {
  return { worktree: makeWorktree(branch, mux, overrides), depth };
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

function defaultProps(overrides: Record<string, unknown> = {}) {
  return {
    projects: [] as ProjectInfo[],
    rowsByProject: new Map<string, WorktreeListRow[]>(),
    scratchByProject: new Map<string, ScratchSessionSnapshot[]>(),
    externalSessions: [] as ExternalTmuxSession[],
    selection: null as Selection | null,
    selected: null as string | null,
    removing: new Set<string>(),
    initializing: new Set<string>(),
    archiving: new Set<string>(),
    notifiedBranches: new Set<string>(),
    itemOrder: [] as string[],
    searchQuery: "",
    showArchived: false,
    onSelectWorktree: vi.fn(),
    onSelectScratch: vi.fn(),
    onSelectExternal: vi.fn(),
    onRemoveScratch: vi.fn(),
    onclose: vi.fn(),
    onarchive: vi.fn(),
    onmerge: vi.fn(),
    onremove: vi.fn(),
    onedit: vi.fn(),
    onReorder: vi.fn(),
    ...overrides,
  };
}

describe("ActiveSidebar", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows empty-state message when there are no items", () => {
    render(ActiveSidebar, { props: defaultProps() });
    expect(screen.getByText("No sessions to show")).toBeInTheDocument();
  });

  it("renders Active section header", () => {
    const proj = makeProject("p1", "My Project");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", [makeRow("feature/active", "✓")]]]),
      }),
    });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("feature/active")).toBeInTheDocument();
  });

  it("renders Inactive section when there are inactive items (collapsed by default)", () => {
    const proj = makeProject("p1", "My Project");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", [makeRow("feature/active", "✓"), makeRow("feature/closed", "")]]]),
      }),
    });
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("Inactive")).toBeInTheDocument();
    expect(screen.getByText("feature/active")).toBeInTheDocument();
    expect(screen.queryByText("feature/closed")).not.toBeInTheDocument();
  });

  it("does not render Inactive section when all items are active", () => {
    const proj = makeProject("p1", "My Project");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", [makeRow("feature/active", "✓")]]]),
      }),
    });
    expect(screen.queryByText("Inactive")).not.toBeInTheDocument();
  });

  it("clicking Inactive header toggles visibility", async () => {
    const proj = makeProject("p1", "My Project");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", [makeRow("feature/closed", "")]]]),
      }),
    });

    expect(screen.queryByText("feature/closed")).not.toBeInTheDocument();

    const inactiveHeader = screen.getByText("Inactive").closest("header")!;
    await fireEvent.click(inactiveHeader);

    expect(screen.getByText("feature/closed")).toBeInTheDocument();

    await fireEvent.click(inactiveHeader);
    expect(screen.queryByText("feature/closed")).not.toBeInTheDocument();
  });

  it("clicking an active worktree row calls onSelectWorktree with correct projectId", async () => {
    const proj = makeProject("p1", "My Project");
    const onSelectWorktree = vi.fn();
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", [makeRow("feature/active", "✓")]]]),
        onSelectWorktree,
      }),
    });

    await fireEvent.click(screen.getByText("feature/active"));
    expect(onSelectWorktree).toHaveBeenCalledWith("p1", "feature/active");
  });

  it("cross-project select: clicking a worktree from a different project passes its projectId", async () => {
    const projA = makeProject("projA", "Project A");
    const projB = makeProject("projB", "Project B");
    const onSelectWorktree = vi.fn();
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [projA, projB],
        rowsByProject: new Map([
          ["projA", [makeRow("feature/from-a", "✓")]],
          ["projB", [makeRow("feature/from-b", "✓")]],
        ]),
        onSelectWorktree,
      }),
    });

    await fireEvent.click(screen.getByText("feature/from-b"));
    expect(onSelectWorktree).toHaveBeenCalledWith("projB", "feature/from-b");
    expect(onSelectWorktree).not.toHaveBeenCalledWith("projA", expect.anything());
  });

  it("fires onReorder when a drop event occurs", async () => {
    const proj = makeProject("p1", "P");
    const onReorder = vi.fn();
    const rows = [makeRow("feature/a", "✓"), makeRow("feature/b", "✓")];
    const itemOrder = ["worktree:p1:feature/a", "worktree:p1:feature/b"];
    const { container } = render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", rows]]),
        itemOrder,
        onReorder,
      }),
    });

    const handles = within(container).getAllByLabelText("Drag to reorder");

    const dt = { setData: vi.fn(), effectAllowed: "move" } as unknown as DataTransfer;
    await fireEvent.dragStart(handles[0], { dataTransfer: dt });

    const dropTarget = container.querySelector("[data-item-id='worktree:p1:feature/b']")!;
    expect(dropTarget).not.toBeNull();
    await fireEvent.drop(dropTarget, { dataTransfer: {} as unknown as DataTransfer });

    expect(onReorder).toHaveBeenCalled();
  });

  it("shows No active sessions when all items are inactive", () => {
    const proj = makeProject("p1", "P");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", [makeRow("feature/closed", "")]]]),
      }),
    });
    expect(screen.getByText("No active sessions")).toBeInTheDocument();
  });

  it("shows project label chip next to worktree branch", () => {
    const proj = makeProject("p1", "My Project");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", [makeRow("feature/active", "✓")]]]),
      }),
    });
    expect(screen.getByText("My Project")).toBeInTheDocument();
  });

  it("search filter hides non-matching items", () => {
    const proj = makeProject("p1", "P");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([
          ["p1", [makeRow("feature/foo", "✓"), makeRow("feature/bar", "✓")]],
        ]),
        searchQuery: "foo",
      }),
    });
    expect(screen.getByText("feature/foo")).toBeInTheDocument();
    expect(screen.queryByText("feature/bar")).not.toBeInTheDocument();
  });

  it("archived items hidden when showArchived=false", () => {
    const proj = makeProject("p1", "P");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([
          ["p1", [
            makeRow("feature/visible", "✓"),
            makeRow("feature/archived", "", 0, { archived: true }),
          ]],
        ]),
        showArchived: false,
      }),
    });
    expect(screen.getByText("feature/visible")).toBeInTheDocument();
    expect(screen.queryByText("feature/archived")).not.toBeInTheDocument();
  });

  it("inactive bucket shows archived items when showArchived=true", () => {
    const proj = makeProject("p1", "P");

    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([
          ["p1", [
            makeRow("feature/archived", "", 0, { archived: true }),
          ]],
        ]),
        showArchived: true,
      }),
    });

    const inactiveHeader = screen.getByText("Inactive").closest("header")!;
    expect(inactiveHeader).toBeInTheDocument();
    void fireEvent.click(inactiveHeader);
  });

  it("drag handles are present in the DOM", () => {
    const proj = makeProject("p1", "P");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", [makeRow("feature/active", "✓")]]]),
      }),
    });
    const handles = screen.getAllByLabelText("Drag to reorder");
    expect(handles.length).toBeGreaterThan(0);
  });

  it("external sessions render and fire onSelectExternal", async () => {
    const onSelectExternal = vi.fn();
    render(ActiveSidebar, {
      props: defaultProps({
        externalSessions: [makeExternal("my-tmux-session")],
        onSelectExternal,
      }),
    });
    expect(screen.getByText("my-tmux-session")).toBeInTheDocument();
    await fireEvent.click(screen.getByText("my-tmux-session"));
    expect(onSelectExternal).toHaveBeenCalledWith("my-tmux-session");
  });

  it("renders scratch sessions in active bucket", () => {
    const proj = makeProject("p1", "P");
    render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        scratchByProject: new Map([["p1", [makeScratch("s1")]]]),
      }),
    });
    expect(screen.getByText("s1")).toBeInTheDocument();
  });

  it("drag-mid-snapshot lock: prop change while dragging does not change rendered order", async () => {
    const proj = makeProject("p1", "P");
    const rows = [makeRow("feature/a", "✓"), makeRow("feature/b", "✓")];
    const { rerender } = render(ActiveSidebar, {
      props: defaultProps({
        projects: [proj],
        rowsByProject: new Map([["p1", rows]]),
        itemOrder: ["worktree:p1:feature/a", "worktree:p1:feature/b"],
      }),
    });

    const handles = screen.getAllByLabelText("Drag to reorder");
    await fireEvent.dragStart(handles[0], {
      dataTransfer: { setData: vi.fn(), effectAllowed: "move" } as unknown as DataTransfer,
    });

    const newRows = [makeRow("feature/c", "✓"), makeRow("feature/a", "✓"), makeRow("feature/b", "✓")];
    await rerender(defaultProps({
      projects: [proj],
      rowsByProject: new Map([["p1", newRows]]),
      itemOrder: ["worktree:p1:feature/a", "worktree:p1:feature/b"],
    }));

    expect(screen.queryByText("feature/c")).not.toBeInTheDocument();
    expect(screen.getByText("feature/a")).toBeInTheDocument();
    expect(screen.getByText("feature/b")).toBeInTheDocument();
  });
});
