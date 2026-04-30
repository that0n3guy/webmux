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
    vi.mocked(fetchPreferences).mockResolvedValue(createPreferences());
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
    vi.mocked(fetchPreferences).mockResolvedValue(createPreferences({ defaultAgent: "codex" }));
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
    vi.mocked(fetchPreferences).mockResolvedValue(createPreferences({
      agents: {
        "gemini-cli": {
          label: "Gemini CLI",
          startCommand: 'gemini --prompt "${PROMPT}"',
        },
      },
    }));
    renderDialog();
    await screen.findByText("Gemini CLI");
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
    vi.mocked(updatePreferences).mockResolvedValue(updatedPrefs);
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
});
