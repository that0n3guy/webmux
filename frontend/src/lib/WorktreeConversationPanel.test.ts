import { cleanup, fireEvent, render, screen } from "@testing-library/svelte";
import { afterEach, describe, expect, it, vi } from "vitest";
import WorktreeConversationPanel from "./WorktreeConversationPanel.svelte";
import type { AgentsUiConversationState, WorktreeInfo } from "./types";
import { renderAssistantMarkdown } from "./markdown";

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

  it("tool row without details has no chevron and no expand affordance", () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "tool",
            id: "tool-no-details",
            turnId: "turn-1",
            name: "Read",
            summary: "src/foo.ts",
            status: "ok",
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.queryByText("▾")).not.toBeInTheDocument();
    expect(screen.queryByText("▴")).not.toBeInTheDocument();
  });

  it("thinking row without details has no chevron", () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "thinking",
            id: "think-no-details",
            turnId: "turn-1",
            text: "Plain thinking.",
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.queryByText("▾")).not.toBeInTheDocument();
    expect(screen.queryByText("▴")).not.toBeInTheDocument();
  });

  it("clicking a tool row with details toggles aria-expanded and shows the details block", async () => {
    const details = '{\n  "file_path": "src/lib/types.ts"\n}';
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "tool",
            id: "tool-with-details",
            turnId: "turn-1",
            name: "Read",
            summary: "src/lib/types.ts",
            status: "ok",
            createdAt: null,
            details,
          },
        ],
      }),
    });

    const toolButton = screen.getByRole("button", { name: /▸ Read/ });
    expect(toolButton).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("pre")).not.toBeInTheDocument();

    await fireEvent.click(toolButton);
    expect(toolButton).toHaveAttribute("aria-expanded", "true");
    const pre = document.querySelector("pre");
    expect(pre).toBeInTheDocument();
    expect(pre?.textContent).toBe(details);

    await fireEvent.click(toolButton);
    expect(toolButton).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("pre")).not.toBeInTheDocument();
  });

  it("clicking a thinking row with details toggles aria-expanded and shows the details block", async () => {
    const details = "First line.\nSecond line.\nThird line.";
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "thinking",
            id: "think-with-details",
            turnId: "turn-1",
            text: "First line.",
            createdAt: null,
            details,
          },
        ],
      }),
    });

    const thinkButton = screen.getByRole("button", { name: /· First line\./ });
    expect(thinkButton).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("pre")).not.toBeInTheDocument();

    await fireEvent.click(thinkButton);
    expect(thinkButton).toHaveAttribute("aria-expanded", "true");
    const pre = document.querySelector("pre");
    expect(pre).toBeInTheDocument();
    expect(pre?.textContent).toBe(details);

    await fireEvent.click(thinkButton);
    expect(thinkButton).toHaveAttribute("aria-expanded", "false");
    expect(document.querySelector("pre")).not.toBeInTheDocument();
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

describe("renderAssistantMarkdown", () => {
  it("renders bold markdown as <strong>", () => {
    const result = renderAssistantMarkdown("**bold text**");
    expect(result).toContain("<strong>bold text</strong>");
  });

  it("renders ## heading as <h2>", () => {
    const result = renderAssistantMarkdown("## My Heading");
    expect(result).toContain("<h2>My Heading</h2>");
  });

  it("renders inline code as <code>", () => {
    const result = renderAssistantMarkdown("use `foo()` here");
    expect(result).toContain("<code>foo()</code>");
  });

  it("renders links with target=_blank and rel=noreferrer noopener", () => {
    const result = renderAssistantMarkdown("[click](https://example.com)");
    expect(result).toContain('href="https://example.com"');
    expect(result).toContain('target="_blank"');
    expect(result).toContain('rel="noreferrer noopener"');
  });

  it("strips table tags (not in allowed list)", () => {
    const result = renderAssistantMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
    expect(result).not.toContain("<table");
  });

  it("strips script tags (XSS prevention)", () => {
    const result = renderAssistantMarkdown('<script>alert("xss")</script>plain text');
    expect(result).not.toContain("<script");
  });
});

describe("WorktreeConversationPanel markdown rendering", () => {
  afterEach(() => {
    cleanup();
  });

  it("user message with **bold** stays plain text", () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "user",
            id: "user-md",
            turnId: "turn-1",
            text: "**bold**",
            status: "completed",
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText("**bold**")).toBeInTheDocument();
    expect(document.querySelector("strong")).not.toBeInTheDocument();
  });

  it("tool summary stays plain text", () => {
    renderPanel({
      conversation: createConversation({
        messages: [
          {
            kind: "tool",
            id: "tool-md",
            turnId: "turn-1",
            name: "Bash",
            summary: "**not bold**",
            status: "ok",
            createdAt: null,
          },
        ],
      }),
    });

    expect(screen.getByText("**not bold**")).toBeInTheDocument();
    expect(document.querySelector("strong")).not.toBeInTheDocument();
  });
});
