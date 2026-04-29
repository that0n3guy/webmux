import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppConfig, AppNotification, LinearIssuesResponse, WorktreeInfo } from "./lib/types";

vi.mock("./lib/api", () => ({
  api: {
    closeWorktree: vi.fn(),
    createWorktree: vi.fn(),
    dismissNotification: vi.fn(),
    fetchAvailableBranches: vi.fn(),
    fetchBaseBranches: vi.fn(),
    fetchCiLogs: vi.fn(),
    fetchConfig: vi.fn(),
    fetchWorktreeDiff: vi.fn(),
    fetchLinearIssues: vi.fn(),
    mergeWorktree: vi.fn(),
    pullMain: vi.fn(),
    removeWorktree: vi.fn(),
    setWorktreeArchived: vi.fn(),
    sendWorktreePrompt: vi.fn(),
  },
  fetchAgents: vi.fn(),
  fetchWorktrees: vi.fn(),
  fetchProjects: vi.fn(),
  fetchExternalSessions: vi.fn(),
  fetchScratchSessions: vi.fn(),
  subscribeNotifications: vi.fn(),
  openWorktree: vi.fn(),
  createScratchSession: vi.fn(),
  removeScratchSession: vi.fn(),
  createProject: vi.fn(),
  removeProject: vi.fn(),
  updateWorktree: vi.fn(),
  attachScratchConversation: vi.fn(),
  fetchScratchConversationHistory: vi.fn(),
  sendScratchConversationMessage: vi.fn(),
  interruptScratchConversation: vi.fn(),
  connectScratchConversationStream: vi.fn(),
}));

import App from "./App.svelte";
import { api, fetchAgents, fetchWorktrees, fetchProjects, fetchExternalSessions, fetchScratchSessions, subscribeNotifications, openWorktree, updateWorktree, attachScratchConversation, connectScratchConversationStream } from "./lib/api";
import type { ProjectInfo, ScratchSessionSnapshot } from "./lib/types";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

class MockNotification {
  static permission: NotificationPermission = "denied";

  static requestPermission = vi.fn(async () => "denied" as const);

  constructor(_title: string, _options?: NotificationOptions) {}
}

const originalMatchMedia = window.matchMedia;
const originalNotification = globalThis.Notification;
const originalDialogShowModal = HTMLDialogElement.prototype.showModal;
const originalDialogClose = HTMLDialogElement.prototype.close;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createProject(overrides: Partial<ProjectInfo> = {}): ProjectInfo {
  return {
    id: "test-project-1",
    name: "repo",
    path: "/repo",
    addedAt: "2026-01-01T00:00:00.000Z",
    mainBranch: "main",
    defaultAgent: "claude",
    ...overrides,
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: "repo",
    services: [],
    startupEnvs: {},
    profiles: [{ name: "default" }],
    agents: [
      {
        id: "claude",
        label: "Claude",
        kind: "builtin",
        capabilities: {
          terminal: true,
          inAppChat: true,
          conversationHistory: true,
          interrupt: true,
          resume: true,
        },
      },
      {
        id: "codex",
        label: "Codex",
        kind: "builtin",
        capabilities: {
          terminal: true,
          inAppChat: true,
          conversationHistory: true,
          interrupt: true,
          resume: true,
        },
      },
    ],
    defaultProfileName: "default",
    defaultAgentId: "claude",
    autoName: false,
    linearCreateTicketOption: false,
    linkedRepos: [],
    linearAutoCreateWorktrees: false,
    autoRemoveOnMerge: false,
    projectDir: "/repo",
    mainBranch: "main",
    ...overrides,
  };
}

function createWorktree(
  branch: string,
  overrides: Partial<WorktreeInfo> = {},
): WorktreeInfo {
  return {
    branch,
    archived: false,
    agent: "waiting",
    mux: "",
    path: `/repo/__worktrees/${branch}`,
    dir: `/repo/__worktrees/${branch}`,
    dirty: false,
    unpushed: false,
    status: "idle",
    elapsed: "1m",
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
    ...overrides,
  };
}

function createLinearIssuesResponse(
  overrides: Partial<LinearIssuesResponse> = {},
): LinearIssuesResponse {
  return {
    availability: "ready",
    issues: [],
    ...overrides,
  };
}

function createAppNotification(
  overrides: Partial<AppNotification> = {},
): AppNotification {
  return {
    id: 1,
    branch: "feature/toast",
    type: "runtime_error",
    message: "Notification text",
    url: "https://example.com/notifications/1",
    timestamp: Date.UTC(2026, 3, 9, 11, 30, 0),
    ...overrides,
  };
}

function setupBrowserMocks(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: MockNotification,
  });
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement): void {
    this.open = true;
  });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement): void {
    this.open = false;
  });
}

function restoreBrowserMocks(): void {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  Object.defineProperty(globalThis, "Notification", {
    configurable: true,
    writable: true,
    value: originalNotification,
  });
  HTMLDialogElement.prototype.showModal = originalDialogShowModal;
  HTMLDialogElement.prototype.close = originalDialogClose;
}

async function openNewWorktreeDialog(): Promise<void> {
  await fireEvent.click(screen.getByTitle("New… (Cmd+K for worktree)"));
  await fireEvent.click(await screen.findByText("New worktree…"));
}

async function openCreateDialogAndSubmit(branch: string): Promise<void> {
  await openNewWorktreeDialog();
  await screen.findByText("New Worktree");
  await fireEvent.input(screen.getByLabelText(/Branch name/i), {
    target: { value: branch },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Create" }));
}

async function openCreateDialogWithBaseAndSubmit(branch: string, baseBranch: string): Promise<void> {
  await openNewWorktreeDialog();
  await screen.findByText("New Worktree");
  await fireEvent.input(screen.getByLabelText(/Branch name/i), {
    target: { value: branch },
  });
  await fireEvent.click(screen.getByRole("button", { name: "Base branch" }));
  await fireEvent.click(await screen.findByRole("button", { name: baseBranch }));
  await fireEvent.click(screen.getByRole("button", { name: "Create" }));
}

describe("App create selection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    localStorage.clear();
    setupBrowserMocks();

    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig());
    vi.mocked(fetchAgents).mockResolvedValue([
      {
        id: "claude",
        label: "Claude",
        kind: "builtin",
        capabilities: {
          terminal: true,
          inAppChat: true,
          conversationHistory: true,
          interrupt: true,
          resume: true,
        },
        startCommand: null,
        resumeCommand: null,
      },
      {
        id: "codex",
        label: "Codex",
        kind: "builtin",
        capabilities: {
          terminal: true,
          inAppChat: true,
          conversationHistory: true,
          interrupt: true,
          resume: true,
        },
        startCommand: null,
        resumeCommand: null,
      },
    ]);
    vi.mocked(fetchProjects).mockResolvedValue([createProject()]);
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(fetchExternalSessions).mockResolvedValue([]);
    vi.mocked(fetchScratchSessions).mockResolvedValue([]);
    vi.mocked(api.fetchAvailableBranches).mockResolvedValue({ branches: [] });
    vi.mocked(api.fetchBaseBranches).mockResolvedValue({ branches: [] });
    vi.mocked(api.fetchLinearIssues).mockResolvedValue(createLinearIssuesResponse());
    vi.mocked(api.fetchWorktreeDiff).mockResolvedValue({
      uncommitted: "",
      uncommittedTruncated: false,
      gitStatus: "",
      unpushedCommits: [],
    });
    vi.mocked(subscribeNotifications).mockReturnValue(() => {});
    vi.mocked(openWorktree).mockResolvedValue(undefined);
    vi.mocked(updateWorktree).mockResolvedValue(undefined);
    vi.mocked(api.closeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.removeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.setWorktreeArchived).mockResolvedValue({ ok: true, archived: true });
    vi.mocked(api.mergeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.pullMain).mockResolvedValue({ status: "updated" });
    vi.mocked(api.dismissNotification).mockResolvedValue({ ok: true });
    vi.mocked(api.fetchCiLogs).mockResolvedValue({ logs: "" });
    vi.mocked(api.sendWorktreePrompt).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    restoreBrowserMocks();
  });

  it("keeps the current selection when a new worktree is created from an existing selection", async () => {
    const existingWorktree = createWorktree("main");
    const creatingWorktree = createWorktree("feature/new", {
      creating: true,
      creationPhase: "creating_worktree",
    });
    const newWorktree = createWorktree("feature/new");
    const createResult = deferred<{ primaryBranch: string; branches: string[] }>();

    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([existingWorktree])
      .mockResolvedValueOnce([existingWorktree, creatingWorktree])
      .mockResolvedValueOnce([existingWorktree, newWorktree])
      .mockResolvedValue([existingWorktree, newWorktree]);
    vi.mocked(api.createWorktree).mockReturnValueOnce(createResult.promise);

    render(App);

    await screen.findByTitle("main");

    await openCreateDialogAndSubmit("feature/new");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /^feature\/new\b/i })).toBeInTheDocument();
    });
    expect(screen.getByTitle("main")).toBeInTheDocument();
    expect(screen.queryByTitle("feature/new")).not.toBeInTheDocument();

    createResult.resolve({ primaryBranch: "feature/new", branches: ["feature/new"] });

    await waitFor(() => {
      expect(fetchWorktrees).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByTitle("main")).toBeInTheDocument();
    expect(screen.queryByTitle("feature/new")).not.toBeInTheDocument();
  });

  it("selects the new worktree when nothing was selected before creation", async () => {
    const creatingWorktree = createWorktree("feature/new", {
      creating: true,
      creationPhase: "creating_worktree",
    });
    const newWorktree = createWorktree("feature/new");
    const createResult = deferred<{ primaryBranch: string; branches: string[] }>();

    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([creatingWorktree])
      .mockResolvedValueOnce([newWorktree])
      .mockResolvedValue([newWorktree]);
    vi.mocked(api.createWorktree).mockReturnValueOnce(createResult.promise);

    render(App);

    await screen.findByText("Select a worktree");

    await openCreateDialogAndSubmit("feature/new");
    createResult.resolve({ primaryBranch: "feature/new", branches: ["feature/new"] });

    await waitFor(() => {
      expect(fetchWorktrees).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByTitle("feature/new")).toBeInTheDocument();
  });

  it("shows an error toast when worktree creation fails", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.createWorktree).mockRejectedValueOnce(new Error("branch exists"));

    render(App);

    await screen.findByText("Select a worktree");
    await openCreateDialogAndSubmit("feature/new");

    const toast = await screen.findByRole("alert");
    expect(toast).toHaveTextContent("Failed to create: branch exists");
  });

  it("dismisses notification toasts through the notification API", async () => {
    let onNotification: ((notification: AppNotification) => void) | undefined;

    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(subscribeNotifications).mockImplementation((handleNotification) => {
      onNotification = handleNotification;
      return () => {};
    });

    render(App);

    await screen.findByText("Select a worktree");
    onNotification?.(createAppNotification({ id: 42, message: "Background error" }));

    const toast = await screen.findByRole("alert");
    const dismissButton = Array.from(toast.querySelectorAll("button")).find(
      (button) => button.textContent === "\u00d7",
    );

    expect(dismissButton).toBeDefined();
    await fireEvent.click(dismissButton!);

    expect(api.dismissNotification).toHaveBeenCalledWith({ params: { projectId: "test-project-1", id: 42 } });
  });

  it("shows a success toast when pulling main succeeds", async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig({
      projectDir: "/repo",
      mainBranch: "main",
    }));
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.pullMain).mockResolvedValueOnce({ status: "updated" });

    render(App);

    await screen.findByText("Select a worktree");
    await screen.findByText("main");
    await fireEvent.click(screen.getByRole("button", { name: "Pull" }));
    await fireEvent.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Pull" }));

    expect(api.pullMain).toHaveBeenCalledWith({ params: { projectId: "test-project-1" }, body: {} });
    expect(await screen.findByRole("alert")).toHaveTextContent('Pulled latest "main" from remote');
  });

  it("selects the primary paired worktree when Both is created without a prior selection", async () => {
    const creatingClaude = createWorktree("claude-feature/new", {
      creating: true,
      creationPhase: "creating_worktree",
    });
    const creatingCodex = createWorktree("codex-feature/new", {
      creating: true,
      creationPhase: "creating_worktree",
    });
    const createdClaude = createWorktree("claude-feature/new");
    const createdCodex = createWorktree("codex-feature/new");
    const createResult = deferred<{ primaryBranch: string; branches: string[] }>();

    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([creatingClaude, creatingCodex])
      .mockResolvedValueOnce([createdClaude, createdCodex])
      .mockResolvedValue([createdClaude, createdCodex]);
    vi.mocked(api.createWorktree).mockReturnValueOnce(createResult.promise);

    render(App);

    await screen.findByText("Select a worktree");

    await openNewWorktreeDialog();
    await screen.findByText("New Worktree");
    await fireEvent.click(screen.getByRole("switch", { name: /enable multiple agent selection/i }));
    await fireEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
    await fireEvent.input(screen.getByLabelText(/Branch name/i), {
      target: { value: "feature/new" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));

    createResult.resolve({
      primaryBranch: "claude-feature/new",
      branches: ["claude-feature/new", "codex-feature/new"],
    });

    await waitFor(() => {
      expect(fetchWorktrees).toHaveBeenCalledTimes(3);
    });
    expect(screen.getByTitle("claude-feature/new")).toBeInTheDocument();
  });

  it("hides archived worktrees until the archived toggle is enabled", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree("feature/active"),
      createWorktree("feature/archived", { archived: true }),
    ]);

    render(App);

    await screen.findByRole("button", { name: /^feature\/active\b/i });
    expect(screen.queryByRole("button", { name: /feature\/archived/i })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole("switch", { name: /show archived worktrees/i }));

    expect(
      await screen.findByRole("button", { name: /^feature\/archived\b/i }),
    ).toBeInTheDocument();
  });

  it("keeps the current selection while filtering the worktree list", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree("main"),
      createWorktree("feature/alpha"),
      createWorktree("feature/beta"),
    ]);

    render(App);

    const searchInput = await screen.findByRole("searchbox", { name: /search worktrees/i });
    await screen.findByTitle("main");

    await fireEvent.focus(searchInput);
    await fireEvent.input(searchInput, { target: { value: "feature" } });

    expect(screen.getByTitle("main")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^main\b/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^feature\/alpha\b/i })).toBeInTheDocument();
  });

  it("clears the worktree search from the trailing clear button", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree("feature/alpha"),
      createWorktree("feature/beta"),
    ]);

    render(App);

    const searchInput = await screen.findByRole("searchbox", { name: /search worktrees/i });
    await fireEvent.input(searchInput, { target: { value: "alpha" } });
    expect(searchInput).toHaveValue("alpha");

    await fireEvent.click(screen.getByRole("button", { name: /clear worktree search/i }));

    expect(searchInput).toHaveValue("");
  });

  it("archives the selected worktree through the API", async () => {
    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([createWorktree("feature/active")])
      .mockResolvedValueOnce([createWorktree("feature/active", { archived: true })])
      .mockResolvedValue([createWorktree("feature/active", { archived: true })]);

    render(App);

    await screen.findByTitle("feature/active");
    await fireEvent.click(screen.getByRole("button", { name: "Archive" }));

    await waitFor(() => {
      expect(api.setWorktreeArchived).toHaveBeenCalledWith({
        params: { projectId: "test-project-1", name: "feature/active" },
        body: { archived: true },
      });
    });
  });

  it("shows a setup message in the Linear panel when LINEAR_API_KEY is missing", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchLinearIssues).mockResolvedValue(
      createLinearIssuesResponse({ availability: "missing_api_key" }),
    );

    render(App);

    const toggle = await screen.findByRole("button", { name: /linear/i });
    expect(toggle).toBeInTheDocument();

    await fireEvent.click(toggle);

    expect(
      await screen.findByText((_, element) =>
        element?.textContent === "Set LINEAR_API_KEY to show your assigned Linear issues here.",
      ),
    ).toBeInTheDocument();
  });

  it("shows an empty-state message in the Linear panel when Linear is ready but has no issues", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchLinearIssues).mockResolvedValue(
      createLinearIssuesResponse({ availability: "ready", issues: [] }),
    );

    render(App);

    const toggle = await screen.findByRole("button", { name: /linear/i });
    expect(toggle).toBeInTheDocument();

    await fireEvent.click(toggle);

    expect(
      await screen.findByText("No assigned Linear issues right now."),
    ).toBeInTheDocument();
  });

  it("hides the Linear ticket option when disabled in config", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);

    render(App);

    await openNewWorktreeDialog();
    await screen.findByText("New Worktree");

    expect(screen.queryByRole("switch", { name: /create linear ticket/i })).not.toBeInTheDocument();
  });

  it("submits Linear ticket creation when the option is enabled", async () => {
    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig({
      linearCreateTicketOption: true,
    }));
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.createWorktree).mockResolvedValue({
      primaryBranch: "eng-123-new-flow",
      branches: ["eng-123-new-flow"],
    });

    render(App);

    await openNewWorktreeDialog();
    await screen.findByText("New Worktree");

    const linearToggle = screen.getByRole("switch", { name: /create linear ticket/i });
    await fireEvent.click(linearToggle);

    const createButton = screen.getByRole("button", { name: "Create" });
    expect(createButton).toBeDisabled();
    expect(screen.getByLabelText(/Branch name/i)).toBeDisabled();

    await fireEvent.input(screen.getByLabelText(/Prompt/i), {
      target: { value: "Implement the new flow" },
    });
    await fireEvent.input(screen.getByLabelText(/Linear ticket title/i), {
      target: { value: "Ship Linear-backed worktree creation" },
    });
    await waitFor(() => {
      expect(createButton).not.toBeDisabled();
    });
    await fireEvent.click(createButton);

    await waitFor(() => {
      expect(api.createWorktree).toHaveBeenCalledWith({
        params: { projectId: "test-project-1" },
        body: {
          mode: "new",
          profile: "default",
          agents: ["claude"],
          prompt: "Implement the new flow",
          createLinearTicket: true,
          linearTitle: "Ship Linear-backed worktree creation",
          yolo: true,
        },
      });
    });
  });

  it("shows prefixed branch previews when multiple agents are selected", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);

    render(App);

    await openNewWorktreeDialog();
    await screen.findByText("New Worktree");

    await fireEvent.click(screen.getByRole("switch", { name: /enable multiple agent selection/i }));
    await fireEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
    await fireEvent.input(screen.getByLabelText(/Branch name/i), {
      target: { value: "feature/new" },
    });

    expect(screen.getByText("claude-feature/new")).toBeInTheDocument();
    expect(screen.getByText("codex-feature/new")).toBeInTheDocument();
  });

  it("submits multi-agent worktree creation when multiple agents are selected", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.createWorktree).mockResolvedValue({
      primaryBranch: "claude-feature/new",
      branches: ["claude-feature/new", "codex-feature/new"],
    });

    render(App);

    await openNewWorktreeDialog();
    await screen.findByText("New Worktree");

    await fireEvent.click(screen.getByRole("switch", { name: /enable multiple agent selection/i }));
    await fireEvent.click(screen.getByRole("checkbox", { name: "Codex" }));
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Use existing branch" })).not.toBeInTheDocument();
    });

    await fireEvent.input(screen.getByLabelText(/Branch name/i), {
      target: { value: "feature/new" },
    });
    await fireEvent.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      expect(api.createWorktree).toHaveBeenCalledWith({
        params: { projectId: "test-project-1" },
        body: {
          mode: "new",
          branch: "feature/new",
          profile: "default",
          agents: ["claude", "codex"],
          yolo: true,
        },
      });
    });
  });

  it("submits an explicit base branch when provided", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchBaseBranches).mockResolvedValue({ branches: [{ name: "release/base" }] });
    vi.mocked(api.createWorktree).mockResolvedValue({
      primaryBranch: "feature/from-release",
      branches: ["feature/from-release"],
    });

    render(App);

    await openCreateDialogWithBaseAndSubmit("feature/from-release", "release/base");

    await waitFor(() => {
      expect(api.createWorktree).toHaveBeenCalledWith({
        params: { projectId: "test-project-1" },
        body: {
          mode: "new",
          branch: "feature/from-release",
          baseBranch: "release/base",
          profile: "default",
          agents: ["claude"],
          yolo: true,
        },
      });
    });
  });

  it("caches branch lists across dialog openings and only fetches each mode once", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchAvailableBranches)
      .mockResolvedValueOnce({ branches: [{ name: "feature/local-only" }] })
      .mockResolvedValueOnce({ branches: [{ name: "feature/local-only" }, { name: "feature/remote-only" }] });
    vi.mocked(api.fetchBaseBranches).mockResolvedValue({ branches: [{ name: "main" }] });

    render(App);

    await openNewWorktreeDialog();
    await screen.findByText("New Worktree");

    await waitFor(() => {
      expect(api.fetchAvailableBranches).toHaveBeenCalledTimes(1);
      expect(api.fetchAvailableBranches).toHaveBeenCalledWith({ params: { projectId: "test-project-1" }, query: { includeRemote: false } });
      expect(api.fetchBaseBranches).toHaveBeenCalledTimes(1);
    });

    await fireEvent.click(screen.getByRole("button", { name: "Use existing branch" }));
    await fireEvent.click(await screen.findByRole("switch", { name: /include remote branches/i }));

    await waitFor(() => {
      expect(api.fetchAvailableBranches).toHaveBeenCalledTimes(2);
      expect(api.fetchAvailableBranches).toHaveBeenLastCalledWith({ params: { projectId: "test-project-1" }, query: { includeRemote: true } });
    });

    await fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await openNewWorktreeDialog();
    await screen.findByText("New Worktree");

    await waitFor(() => {
      expect(api.fetchAvailableBranches).toHaveBeenCalledTimes(2);
      expect(api.fetchBaseBranches).toHaveBeenCalledTimes(1);
    });

    await fireEvent.click(screen.getByRole("button", { name: "Use existing branch" }));
    await fireEvent.click(await screen.findByRole("switch", { name: /include remote branches/i }));

    await waitFor(() => {
      expect(api.fetchAvailableBranches).toHaveBeenCalledTimes(2);
      expect(api.fetchBaseBranches).toHaveBeenCalledTimes(1);
    });
  });

  it("keeps the current branch list visible while remote branches are loading", async () => {
    const remoteBranches = deferred<Array<{ name: string }>>();

    vi.mocked(fetchWorktrees).mockResolvedValue([]);
    vi.mocked(api.fetchAvailableBranches)
      .mockResolvedValueOnce({ branches: [{ name: "feature/local-only" }] })
      .mockReturnValueOnce(remoteBranches.promise.then((branches) => ({ branches })));

    render(App);

    await openNewWorktreeDialog();
    await screen.findByText("New Worktree");
    await fireEvent.click(screen.getByRole("button", { name: "Use existing branch" }));

    expect(await screen.findByRole("button", { name: "feature/local-only" })).toBeInTheDocument();

    await fireEvent.click(await screen.findByRole("switch", { name: /include remote branches/i }));

    expect(screen.getByRole("button", { name: "feature/local-only" })).toBeInTheDocument();
    expect(screen.getByText("Updating...")).toBeInTheDocument();

    remoteBranches.resolve([{ name: "feature/local-only" }, { name: "feature/remote-only" }]);

    expect(await screen.findByRole("button", { name: "feature/remote-only" })).toBeInTheDocument();
  });

  it("plain Open Session calls openWorktree with no overrides", async () => {
    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([createWorktree("feature/test")])
      .mockResolvedValue([createWorktree("feature/test")]);

    render(App);

    await screen.findByRole("button", { name: /^feature\/test\b/i });
    await fireEvent.click(screen.getByRole("button", { name: /^feature\/test\b/i }));

    await screen.findByRole("button", { name: "Open Session" });
    await fireEvent.click(screen.getByRole("button", { name: "Open Session" }));

    await waitFor(() => {
      expect(openWorktree).toHaveBeenCalledWith("test-project-1", "feature/test");
    });
  });

  it("clicking the caret opens a menu with configured agents and Shell only", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([createWorktree("feature/test")]);

    render(App);

    await screen.findByRole("button", { name: /^feature\/test\b/i });
    await fireEvent.click(screen.getByRole("button", { name: /^feature\/test\b/i }));

    await screen.findByRole("button", { name: "Open Session" });
    await fireEvent.click(screen.getByRole("button", { name: "Open with options" }));

    expect(await screen.findByRole("menuitem", { name: /Claude/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: /Codex/ })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Shell only" })).toBeInTheDocument();
  });

  it("clicking an alternate agent calls openWorktree with agentOverride", async () => {
    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([createWorktree("feature/test", { agentName: "claude" })])
      .mockResolvedValue([createWorktree("feature/test", { agentName: "claude" })]);

    render(App);

    await screen.findByRole("button", { name: /^feature\/test\b/i });
    await fireEvent.click(screen.getByRole("button", { name: /^feature\/test\b/i }));

    await screen.findByRole("button", { name: "Open Session" });
    await fireEvent.click(screen.getByRole("button", { name: "Open with options" }));

    const codexItem = await screen.findByRole("menuitem", { name: /Codex/ });
    await fireEvent.click(codexItem);

    await waitFor(() => {
      expect(openWorktree).toHaveBeenCalledWith("test-project-1", "feature/test", { agentOverride: "codex" });
    });
  });

  it("clicking Shell only calls openWorktree with shellOnly: true", async () => {
    vi.mocked(fetchWorktrees)
      .mockResolvedValueOnce([createWorktree("feature/test")])
      .mockResolvedValue([createWorktree("feature/test")]);

    render(App);

    await screen.findByRole("button", { name: /^feature\/test\b/i });
    await fireEvent.click(screen.getByRole("button", { name: /^feature\/test\b/i }));

    await screen.findByRole("button", { name: "Open Session" });
    await fireEvent.click(screen.getByRole("button", { name: "Open with options" }));

    const shellOnlyItem = await screen.findByRole("menuitem", { name: "Shell only" });
    await fireEvent.click(shellOnlyItem);

    await waitFor(() => {
      expect(openWorktree).toHaveBeenCalledWith("test-project-1", "feature/test", { shellOnly: true });
    });
  });

  it("the default-agent entry in the open-with menu is disabled", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([createWorktree("feature/test", { agentName: "claude" })]);

    render(App);

    await screen.findByRole("button", { name: /^feature\/test\b/i });
    await fireEvent.click(screen.getByRole("button", { name: /^feature\/test\b/i }));

    await screen.findByRole("button", { name: "Open Session" });
    await fireEvent.click(screen.getByRole("button", { name: "Open with options" }));

    const claudeItem = await screen.findByRole("menuitem", { name: /Claude.*\(default\)/ });
    expect(claudeItem).toBeDisabled();

    const codexItem = screen.getByRole("menuitem", { name: /Codex/ });
    expect(codexItem).not.toBeDisabled();
  });

  it("shows the chat/terminal view toggle on mobile when a scratch+claude session is selected", async () => {
    Object.defineProperty(window, "matchMedia", {
      configurable: true,
      writable: true,
      value: vi.fn().mockImplementation((query: string) => ({
        matches: query === "(max-width: 768px)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      })),
    });

    const scratchSession: ScratchSessionSnapshot = {
      id: "scratch-1",
      sessionName: "wm-scratch-test-project-1-scratch-1",
      displayName: "My AI Session",
      kind: "agent",
      agentId: "claude",
      cwd: "/tmp",
      createdAt: "2026-04-28T12:00:00.000Z",
      windowCount: 1,
      attached: false,
    };

    vi.mocked(fetchScratchSessions).mockResolvedValue([scratchSession]);
    vi.mocked(connectScratchConversationStream).mockReturnValue(() => {});
    vi.mocked(attachScratchConversation).mockResolvedValue({
      worktree: {
        branch: "",
        path: "",
        archived: false,
        dirty: false,
        unpushed: false,
        status: "idle",
        services: [],
        prs: [],
        creating: false,
        creationPhase: null,
        agentName: "claude",
        agentLabel: "Claude",
        profile: null,
        mux: false,
        conversation: null,
      },
      conversation: {
        provider: "claudeCode",
        conversationId: "session-1",
        cwd: "/tmp",
        running: false,
        activeTurnId: null,
        messages: [],
      },
    });

    render(App);

    await screen.findByText("My AI Session");
    await fireEvent.click(screen.getByText("My AI Session"));

    await waitFor(() => {
      expect(
        screen.queryByTitle("Switch to chat") ?? screen.queryByTitle("Switch to terminal"),
      ).toBeTruthy();
    });
  });
});

describe("EditWorktreeDialog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cleanup();
    localStorage.clear();
    setupBrowserMocks();

    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig());
    vi.mocked(fetchAgents).mockResolvedValue([
      {
        id: "claude",
        label: "Claude",
        kind: "builtin",
        capabilities: { terminal: true, inAppChat: true, conversationHistory: true, interrupt: true, resume: true },
        startCommand: null,
        resumeCommand: null,
      },
      {
        id: "codex",
        label: "Codex",
        kind: "builtin",
        capabilities: { terminal: true, inAppChat: true, conversationHistory: true, interrupt: true, resume: true },
        startCommand: null,
        resumeCommand: null,
      },
    ]);
    vi.mocked(fetchProjects).mockResolvedValue([createProject()]);
    vi.mocked(fetchWorktrees).mockResolvedValue([createWorktree("feature/foo", { agentName: "claude", agentLabel: "Claude", yolo: false })]);
    vi.mocked(fetchExternalSessions).mockResolvedValue([]);
    vi.mocked(fetchScratchSessions).mockResolvedValue([]);
    vi.mocked(api.fetchAvailableBranches).mockResolvedValue({ branches: [] });
    vi.mocked(api.fetchBaseBranches).mockResolvedValue({ branches: [] });
    vi.mocked(api.fetchLinearIssues).mockResolvedValue(createLinearIssuesResponse());
    vi.mocked(subscribeNotifications).mockReturnValue(() => {});
    vi.mocked(openWorktree).mockResolvedValue(undefined);
    vi.mocked(updateWorktree).mockResolvedValue(undefined);
    vi.mocked(api.closeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.removeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.setWorktreeArchived).mockResolvedValue({ ok: true, archived: true });
    vi.mocked(api.mergeWorktree).mockResolvedValue({ ok: true });
    vi.mocked(api.pullMain).mockResolvedValue({ status: "updated" });
    vi.mocked(api.dismissNotification).mockResolvedValue({ ok: true });
  });

  afterEach(() => {
    cleanup();
    restoreBrowserMocks();
  });

  async function openEditDialog(): Promise<void> {
    await screen.findByRole("button", { name: /^feature\/foo\b/i });
    const row = screen.getByRole("button", { name: /^feature\/foo\b/i });
    const actionsBtn = row.parentElement?.querySelector("[aria-label^='Actions for']") as HTMLButtonElement | null;
    if (!actionsBtn) throw new Error("Actions button not found");
    await fireEvent.click(actionsBtn);
    await fireEvent.click(await screen.findByText("Edit…"));
  }

  it("opens Edit dialog and shows current agent and yolo state", async () => {
    render(App);
    await openEditDialog();
    await screen.findByText("Edit Worktree");
    const select = screen.getByLabelText("Agent") as HTMLSelectElement;
    expect(select.value).toBe("claude");
    const yoloToggle = screen.getByRole("switch", { name: /skip permissions/i });
    expect(yoloToggle).toHaveAttribute("aria-checked", "false");
  });

  it("calls updateWorktree with correct args on save", async () => {
    render(App);
    await openEditDialog();
    await screen.findByText("Edit Worktree");
    const yoloToggle = screen.getByRole("switch", { name: /skip permissions/i });
    await fireEvent.click(yoloToggle);
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(vi.mocked(updateWorktree)).toHaveBeenCalledWith(
        "test-project-1",
        "feature/foo",
        expect.objectContaining({ yolo: true, agent: "claude" }),
      );
    });
  });

  it("closes dialog and does not call close+open when worktree is not open (mux='') on save", async () => {
    render(App);
    await openEditDialog();
    await screen.findByText("Edit Worktree");
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(vi.mocked(updateWorktree)).toHaveBeenCalled();
    });
    expect(vi.mocked(api.closeWorktree)).not.toHaveBeenCalled();
    expect(vi.mocked(openWorktree)).not.toHaveBeenCalled();
  });

  it("closes and reopens worktree when it is currently open (mux='✓') on save", async () => {
    vi.mocked(fetchWorktrees).mockResolvedValue([
      createWorktree("feature/foo", { agentName: "claude", agentLabel: "Claude", yolo: false, mux: "✓" }),
    ]);
    render(App);
    await screen.findByRole("button", { name: /^feature\/foo\b/i });
    const row = screen.getByRole("button", { name: /^feature\/foo\b/i });
    const actionsBtn = row.parentElement?.querySelector("[aria-label^='Actions for']") as HTMLButtonElement | null;
    if (!actionsBtn) throw new Error("Actions button not found");
    await fireEvent.click(actionsBtn);
    await fireEvent.click(await screen.findByText("Edit…"));
    await screen.findByText("Edit Worktree");
    await fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(vi.mocked(updateWorktree)).toHaveBeenCalled();
      expect(vi.mocked(api.closeWorktree)).toHaveBeenCalledWith(
        expect.objectContaining({ params: { projectId: "test-project-1", name: "feature/foo" } }),
      );
      expect(vi.mocked(openWorktree)).toHaveBeenCalledWith("test-project-1", "feature/foo");
    });
  });
});
