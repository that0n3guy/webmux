import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorktreeConversationPanel from "./WorktreeConversationPanel.svelte";
import type { AgentsUiConversationState, WorktreeInfo } from "./types";

function createWorktree(overrides: Partial<WorktreeInfo> = {}): WorktreeInfo {
  return {
    branch: "feature/mobile-chat",
    archived: false,
    agent: "waiting",
    mux: "✓",
    path: "/repo/__worktrees/feature/mobile-chat",
    dir: "/repo/__worktrees/feature/mobile-chat",
    dirty: false,
    unpushed: false,
    status: "idle",
    elapsed: "1m",
    profile: null,
    agentName: "claude",
    agentLabel: "Claude",
    services: [],
    paneCount: 1,
    prs: [],
    linearIssue: null,
    creating: false,
    creationPhase: null,
    ...overrides,
  };
}

function createConversation(overrides: Partial<AgentsUiConversationState> = {}): AgentsUiConversationState {
  return {
    provider: "claudeCode",
    conversationId: "session-1",
    cwd: "/repo/__worktrees/feature/mobile-chat",
    running: false,
    activeTurnId: null,
    messages: [],
    ...overrides,
  };
}

function renderPanel({
  worktree = createWorktree(),
  conversation = createConversation(),
  conversationError = null,
  isInterrupting = false,
}: {
  worktree?: WorktreeInfo;
  conversation?: AgentsUiConversationState | null;
  conversationError?: string | null;
  isInterrupting?: boolean;
} = {}) {
  const onInterrupt = vi.fn();

  render(WorktreeConversationPanel, {
    props: {
      worktree,
      conversation,
      conversationError,
      conversationLoading: false,
      composerText: "",
      isSending: false,
      isInterrupting,
      onAttach: vi.fn(),
      onComposerInput: vi.fn(),
      onInterrupt,
      onRefresh: vi.fn(),
      onSend: vi.fn(),
    },
  });

  return { onInterrupt };
}

describe("WorktreeConversationPanel", () => {
  afterEach(() => {
    cleanup();
  });

  it("shows an interrupt button in the normal running state", async () => {
    const { onInterrupt } = renderPanel({
      conversation: createConversation({
        running: true,
        activeTurnId: "turn-1",
      }),
    });

    const interruptButton = screen.getByRole("button", { name: "Interrupt" });
    expect(interruptButton).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Send" })).not.toBeInTheDocument();

    await fireEvent.click(interruptButton);
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });

  it("keeps the interrupt button inside the error banner when the conversation is running", () => {
    renderPanel({
      conversation: createConversation({
        running: true,
        activeTurnId: "turn-1",
      }),
      conversationError: "Conversation stream disconnected",
    });

    expect(screen.getByText("Conversation stream disconnected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Interrupt" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeInTheDocument();
  });

  it("shows only the send button when idle", () => {
    renderPanel();

    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Interrupt" })).not.toBeInTheDocument();
  });

  it("disables the interrupt button and shows Stopping... while isInterrupting is true", () => {
    renderPanel({
      conversation: createConversation({ running: true, activeTurnId: "turn-1" }),
      isInterrupting: true,
    });

    const interruptButton = screen.getByRole("button", { name: "Interrupt" });
    expect(interruptButton).toBeDisabled();
    expect(interruptButton).toHaveTextContent("Stopping...");
  });

  it("renders tool events as a single-line row with name and summary", () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "tool",
            id: "tool-1",
            turnId: "turn-1",
            name: "Read",
            summary: "frontend/src/lib/types.ts:1-50",
            status: "ok",
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText("▸ Read")).toBeInTheDocument();
    expect(screen.getByText("frontend/src/lib/types.ts:1-50")).toBeInTheDocument();
  });

  it("renders thinking events as a muted italic line", () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "thinking",
            id: "think-1",
            turnId: "turn-1",
            text: "I should analyze this carefully.",
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText("· I should analyze this carefully.")).toBeInTheDocument();
  });

  it("renders tool and thinking events between user and assistant bubbles", () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "user",
            id: "user-1",
            turnId: "turn-1",
            text: "Show me the file",
            status: "completed",
            createdAt: null,
          },
          {
            kind: "thinking",
            id: "think-1",
            turnId: "turn-1",
            text: "Reading the file now.",
            createdAt: null,
          },
          {
            kind: "tool",
            id: "tool-1",
            turnId: "turn-1",
            name: "Read",
            summary: "src/lib/foo.ts",
            status: "ok",
            createdAt: null,
          },
          {
            kind: "assistant",
            id: "asst-1",
            turnId: "turn-1",
            text: "Here it is.",
            status: "completed",
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText("Show me the file")).toBeInTheDocument();
    expect(screen.getByText("· Reading the file now.")).toBeInTheDocument();
    expect(screen.getByText("▸ Read")).toBeInTheDocument();
    expect(screen.getByText("Here it is.")).toBeInTheDocument();
  });
});
