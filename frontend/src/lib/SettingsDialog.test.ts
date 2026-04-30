import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import SettingsDialog from "./SettingsDialog.svelte";
import type { AgentSummary, AppConfig, UserPreferences } from "./types";

vi.mock("./api", () => ({
  api: {
    fetchConfig: vi.fn(),
    setAutoRemoveOnMerge: vi.fn(),
    setLinearAutoCreate: vi.fn(),
  },
  fetchPreferences: vi.fn(),
  updatePreferences: vi.fn(),
}));

import { api, fetchPreferences, updatePreferences } from "./api";

const originalDialogShowModal = HTMLDialogElement.prototype.showModal;
const originalDialogClose = HTMLDialogElement.prototype.close;

function createPreferences(overrides: Partial<UserPreferences> = {}): UserPreferences {
  return {
    schemaVersion: 1,
    ...overrides,
  };
}

function payload(prefs: UserPreferences = createPreferences(), knownProfiles: string[] = []) {
  return { preferences: prefs, knownProfiles };
}

function createAgentSummary(overrides: Partial<AgentSummary> = {}): AgentSummary {
  return {
    id: "gemini",
    label: "Gemini CLI",
    kind: "custom",
    capabilities: {
      terminal: true,
      inAppChat: false,
      conversationHistory: false,
      interrupt: false,
      resume: true,
    },
    ...overrides,
  };
}

function createConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    name: "repo",
    services: [],
    profiles: [{ name: "default" }],
    agents: [],
    defaultProfileName: "default",
    defaultAgentId: "claude",
    autoName: false,
    linearCreateTicketOption: false,
    startupEnvs: {},
    linkedRepos: [],
    linearAutoCreateWorktrees: false,
    autoRemoveOnMerge: false,
    projectDir: "/repo",
    mainBranch: "main",
    ...overrides,
  };
}

function renderDialog() {
  return render(SettingsDialog, {
    projectId: "test-project-1",
    currentTheme: "github-dark",
    linearAutoCreate: false,
    autoRemoveOnMerge: false,
    onthemechange: vi.fn(),
    onlinearautocreatechange: vi.fn(),
    onautoremovechange: vi.fn(),
    onagentschange: vi.fn(),
    onsave: vi.fn(),
    onclose: vi.fn(),
  });
}

describe("SettingsDialog", () => {
  beforeEach(() => {
    HTMLDialogElement.prototype.showModal = function showModal() {
      this.setAttribute("open", "");
    };
    HTMLDialogElement.prototype.close = function close() {
      this.removeAttribute("open");
    };
    vi.mocked(fetchPreferences).mockResolvedValue(payload());
    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig());
  });

  afterEach(() => {
    HTMLDialogElement.prototype.showModal = originalDialogShowModal;
    HTMLDialogElement.prototype.close = originalDialogClose;
    cleanup();
    vi.clearAllMocks();
  });

  it("renders Global tab by default", async () => {
    renderDialog();
    const globalTab = await screen.findByRole("tab", { name: "Global" });
    expect(globalTab).toHaveAttribute("aria-selected", "true");
    const projectTab = screen.getByRole("tab", { name: "Project" });
    expect(projectTab).toHaveAttribute("aria-selected", "false");
  });

  it("shows default agent dropdown on Global tab after loading prefs", async () => {
    vi.mocked(fetchPreferences).mockResolvedValue(payload(createPreferences({ defaultAgent: "codex" })));
    renderDialog();
    const select = await screen.findByLabelText("Default agent") as HTMLSelectElement;
    expect(select).toBeInTheDocument();
    expect(select.value).toBe("codex");
  });

  it("shows empty state for custom agents when none configured", async () => {
    renderDialog();
    await screen.findByText("No custom agents setup");
  });

  it("shows custom agents from preferences", async () => {
    vi.mocked(fetchPreferences).mockResolvedValue(payload(createPreferences({
      agents: {
        "gemini-cli": {
          label: "Gemini CLI",
          startCommand: 'gemini --prompt "${PROMPT}"',
        },
      },
    })));
    renderDialog();
    await screen.findAllByText("Gemini CLI");
    expect(screen.getByText('gemini --prompt "${PROMPT}"')).toBeInTheDocument();
  });

  it("switches to Project tab on click", async () => {
    renderDialog();
    await screen.findByRole("tab", { name: "Global" });
    await fireEvent.click(screen.getByRole("tab", { name: "Project" }));
    expect(screen.getByRole("tab", { name: "Project" })).toHaveAttribute("aria-selected", "true");
    expect(screen.getByText("Auto-create worktrees")).toBeInTheDocument();
    expect(screen.getByText("Auto-remove on merge")).toBeInTheDocument();
  });

  it("calls updatePreferences and refreshes agents on Save in Global tab", async () => {
    const onagentschange = vi.fn();
    const updatedPrefs = createPreferences({ defaultAgent: "claude" });
    vi.mocked(updatePreferences).mockResolvedValue(payload(updatedPrefs));
    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig({ agents: [createAgentSummary()] }));

    render(SettingsDialog, {
      projectId: "test-project-1",
      currentTheme: "github-dark",
      linearAutoCreate: false,
      autoRemoveOnMerge: false,
      onthemechange: vi.fn(),
      onlinearautocreatechange: vi.fn(),
      onautoremovechange: vi.fn(),
      onagentschange,
      onsave: vi.fn(),
      onclose: vi.fn(),
    });

    await screen.findByRole("tab", { name: "Global" });
    await fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);

    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalled();
    });
    await waitFor(() => {
      expect(api.fetchConfig).toHaveBeenCalledWith({ query: { projectId: "test-project-1" } });
    });
    await waitFor(() => {
      expect(onagentschange).toHaveBeenCalledWith([createAgentSummary()]);
    });
  });

  // -------------------------------------------------------------------------
  // Error states
  // -------------------------------------------------------------------------

  it("displays prefsError when fetchPreferences rejects", async () => {
    vi.mocked(fetchPreferences).mockRejectedValue(new Error("Network failure loading prefs"));

    renderDialog();

    await waitFor(() => {
      expect(screen.getByText("Network failure loading prefs")).toBeInTheDocument();
    });
  });

  it("displays prefsError when updatePreferences rejects and dialog stays open", async () => {
    vi.mocked(updatePreferences).mockRejectedValue(new Error("Save failed unexpectedly"));

    renderDialog();
    await screen.findByRole("tab", { name: "Global" });

    await fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);

    await waitFor(() => {
      expect(screen.getByText("Save failed unexpectedly")).toBeInTheDocument();
    });
    // Dialog stays open — the Global tab is still visible
    expect(screen.getByRole("tab", { name: "Global" })).toBeInTheDocument();
  });

  // -------------------------------------------------------------------------
  // fetchConfig is called with per-project projectId after Global Save
  // -------------------------------------------------------------------------

  it("calls fetchConfig with the correct projectId query after a successful Global Save", async () => {
    vi.mocked(updatePreferences).mockResolvedValue(payload());
    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig());

    render(SettingsDialog, {
      projectId: "my-special-project",
      currentTheme: "github-dark",
      linearAutoCreate: false,
      autoRemoveOnMerge: false,
      onthemechange: vi.fn(),
      onlinearautocreatechange: vi.fn(),
      onautoremovechange: vi.fn(),
      onagentschange: vi.fn(),
      onsave: vi.fn(),
      onclose: vi.fn(),
    });

    await screen.findByRole("tab", { name: "Global" });
    await fireEvent.click(screen.getAllByRole("button", { name: "Save" }).at(-1)!);

    await waitFor(() => {
      expect(api.fetchConfig).toHaveBeenCalledWith({ query: { projectId: "my-special-project" } });
    });
  });

  // -------------------------------------------------------------------------
  // Add agent flow via Global tab
  // -------------------------------------------------------------------------

  it("calls updatePreferences with the new agent after completing the Add agent flow", async () => {
    const savedPrefs = createPreferences({
      agents: { "my-agent": { label: "My Agent", startCommand: "my-agent run" } },
    });
    vi.mocked(updatePreferences).mockResolvedValue(payload(savedPrefs));
    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig());

    renderDialog();
    await screen.findByText("No custom agents setup");

    await fireEvent.click(screen.getByRole("button", { name: "Add agent" }));

    // AgentEditorDialog is now open — fill in the fields
    const labelInput = await screen.findByLabelText("Agent name");
    const startInput = screen.getByLabelText("Start command");

    await fireEvent.input(labelInput, { target: { value: "My Agent" } });
    await fireEvent.input(startInput, { target: { value: "my-agent run" } });

    // Click the Save button inside the editor dialog
    const saveButtons = screen.getAllByRole("button", { name: "Save" });
    await fireEvent.click(saveButtons[saveButtons.length - 1]);

    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalled();
    });

    const callArg = vi.mocked(updatePreferences).mock.calls[0][0];
    expect(callArg.agents).toBeDefined();
    // The agent id is derived from the label ("My Agent" → "my-agent")
    expect(callArg.agents?.["my-agent"]).toEqual({
      label: "My Agent",
      startCommand: "my-agent run",
    });
  });

  // -------------------------------------------------------------------------
  // Delete agent flow via Global tab
  // -------------------------------------------------------------------------

  it("calls updatePreferences without the deleted agent after the Delete flow", async () => {
    vi.mocked(fetchPreferences).mockResolvedValue(payload(createPreferences({
      agents: {
        "gemini-cli": { label: "Gemini CLI", startCommand: 'gemini --prompt "${PROMPT}"' },
      },
    })));
    const afterDeletePrefs = createPreferences({ agents: {} });
    vi.mocked(updatePreferences).mockResolvedValue(payload(afterDeletePrefs));
    vi.mocked(api.fetchConfig).mockResolvedValue(createConfig());

    renderDialog();
    // Wait for the agent row to appear (findAllByText because it also appears in the option)
    await screen.findAllByText("Gemini CLI");

    // Click Delete for the agent
    await fireEvent.click(screen.getByRole("button", { name: "Delete" }));

    // ConfirmDialog appears — click the confirm button (labelled "Remove" by default)
    const removeBtn = await screen.findByRole("button", { name: "Remove" });
    await fireEvent.click(removeBtn);

    await waitFor(() => {
      expect(updatePreferences).toHaveBeenCalled();
    });

    const callArg = vi.mocked(updatePreferences).mock.calls[0][0];
    // agents should be empty or undefined — the deleted agent must not be present
    const agentIds = Object.keys(callArg.agents ?? {});
    expect(agentIds).not.toContain("gemini-cli");
  });
});
