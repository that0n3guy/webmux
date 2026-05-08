import { describe, expect, it } from "bun:test";
import { buildClaudeSessionFromText, encodeClaudeProjectDir } from "../adapters/claude-cli";

describe("claude-cli adapter", () => {
  it("encodes Claude project directories from cwd", () => {
    expect(encodeClaudeProjectDir("/tmp/worktrees/feature.one")).toBe("-tmp-worktrees-feature-one");
  });

  it("builds a transcript from Claude session jsonl text", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/session.jsonl",
      sessionId: "session-1",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-14T15:00:00.000Z",
          cwd: "/tmp/worktrees/claude-feature",
          gitBranch: "claude-feature",
          message: {
            role: "user",
            content: "Inspect the failing tests\n",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-thinking",
          timestamp: "2026-04-14T15:00:01.000Z",
          message: {
            role: "assistant",
            stop_reason: null,
            content: [{ type: "text", text: "Let me inspect that." }],
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-14T15:00:05.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [{ type: "text", text: "The failure comes from the stale snapshot." }],
          },
        }),
      ].join("\n"),
    });

    expect(session).toEqual({
      sessionId: "session-1",
      cwd: "/tmp/worktrees/claude-feature",
      path: "/tmp/session.jsonl",
      gitBranch: "claude-feature",
      createdAt: "2026-04-14T15:00:00.000Z",
      lastSeenAt: "2026-04-14T15:00:05.000Z",
      messages: [
        {
          id: "user-1",
          turnId: "user-1",
          kind: "user",
          text: "Inspect the failing tests",
          status: "completed",
          createdAt: "2026-04-14T15:00:00.000Z",
        },
        {
          id: "assistant-thinking",
          turnId: "user-1",
          kind: "assistant",
          text: "Let me inspect that.",
          status: "completed",
          createdAt: "2026-04-14T15:00:01.000Z",
        },
        {
          id: "assistant-1",
          turnId: "user-1",
          kind: "assistant",
          text: "The failure comes from the stale snapshot.",
          status: "completed",
          createdAt: "2026-04-14T15:00:05.000Z",
        },
      ],
    });
  });

  it("emits queued user messages from queue-operation enqueue records", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/q.jsonl",
      sessionId: "s1",
      text: [
        JSON.stringify({
          type: "user", uuid: "u1", timestamp: "2026-04-14T10:00:00.000Z",
          cwd: "/tmp/x", message: { role: "user", content: "do a 13 sec sleep" },
        }),
        JSON.stringify({
          type: "assistant", uuid: "a1", timestamp: "2026-04-14T10:00:02.000Z",
          message: {
            role: "assistant", stop_reason: "tool_use",
            content: [{ type: "tool_use", id: "tu1", name: "Bash", input: { command: "sleep 13" } }],
          },
        }),
        JSON.stringify({
          type: "queue-operation",
          timestamp: "2026-04-14T10:00:08.000Z",
          operation: "enqueue",
          content: "Here is a post while you sleep",
        }),
        JSON.stringify({
          type: "user", uuid: "u-tr", timestamp: "2026-04-14T10:00:15.000Z",
          message: {
            role: "user",
            content: [{ tool_use_id: "tu1", type: "tool_result", content: "(done)", is_error: false }],
          },
        }),
        JSON.stringify({
          type: "assistant", uuid: "a2", timestamp: "2026-04-14T10:00:16.000Z",
          message: {
            role: "assistant", stop_reason: "end_turn",
            content: [{ type: "text", text: "Done. Got the queued message." }],
          },
        }),
      ].join("\n"),
    });

    const userMessages = session.messages.filter((m) => m.kind === "user");
    expect(userMessages.map((m) => "text" in m ? m.text : "")).toEqual([
      "do a 13 sec sleep",
      "Here is a post while you sleep",
    ]);
    const queued = userMessages.find((m) => m.text === "Here is a post while you sleep");
    expect(queued?.id.startsWith("queued:")).toBe(true);
    expect(queued?.createdAt).toBe("2026-04-14T10:00:08.000Z");
  });

  it("emits tool and thinking events from content blocks", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/session.jsonl",
      sessionId: "session-tool",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-28T10:00:00.000Z",
          cwd: "/tmp/repo",
          message: {
            role: "user",
            content: "Show me the file contents\n",
          },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-1",
          timestamp: "2026-04-28T10:00:05.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [
              {
                type: "thinking",
                thinking: "I should read the file first.\nThen summarize.",
              },
              {
                type: "tool_use",
                id: "tool-use-1",
                name: "Read",
                input: {
                  file_path: "frontend/src/lib/types.ts",
                  start_line: 1,
                  end_line: 50,
                },
              },
              {
                type: "text",
                text: "Here are the file contents.",
              },
            ],
          },
        }),
      ].join("\n"),
    });

    expect(session.messages).toHaveLength(4);

    const [userMsg, thinkingMsg, toolMsg, assistantMsg] = session.messages;

    expect(userMsg).toEqual({
      kind: "user",
      id: "user-1",
      turnId: "user-1",
      text: "Show me the file contents",
      status: "completed",
      createdAt: "2026-04-28T10:00:00.000Z",
    });

    expect(thinkingMsg).toMatchObject({
      kind: "thinking",
      turnId: "user-1",
      text: "I should read the file first.",
      createdAt: "2026-04-28T10:00:05.000Z",
      details: "I should read the file first.\nThen summarize.",
    });

    expect(toolMsg).toEqual({
      kind: "tool",
      id: "tool-use-1",
      turnId: "user-1",
      toolUseId: "tool-use-1",
      name: "Read",
      summary: "frontend/src/lib/types.ts:1-50",
      status: "ok",
      createdAt: "2026-04-28T10:00:05.000Z",
      details: "File: frontend/src/lib/types.ts\n\nLines: 1-50",
    });

    expect(assistantMsg).toMatchObject({
      kind: "assistant",
      turnId: "user-1",
      text: "Here are the file contents.",
      status: "completed",
    });
  });

  it("populates details with full JSON input for tool events and full text for thinking events", () => {
    const session = buildClaudeSessionFromText({
      path: "/tmp/session.jsonl",
      sessionId: "session-details",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "user-1",
          timestamp: "2026-04-28T10:00:00.000Z",
          cwd: "/tmp/repo",
          message: { role: "user", content: "Think and act\n" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "assistant-details",
          timestamp: "2026-04-28T10:00:05.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [
              {
                type: "thinking",
                thinking: "Line one.\nLine two.\nLine three.",
              },
              {
                type: "tool_use",
                id: "tool-details-1",
                name: "Bash",
                input: { command: "bun test", timeout: 30 },
              },
            ],
          },
        }),
      ].join("\n"),
    });

    const thinkMsg = session.messages.find((m) => m.kind === "thinking");
    expect(thinkMsg).toMatchObject({
      kind: "thinking",
      text: "Line one.",
      details: "Line one.\nLine two.\nLine three.",
    });

    const toolMsg = session.messages.find((m) => m.kind === "tool");
    expect(toolMsg).toMatchObject({
      kind: "tool",
      name: "Bash",
      details: "Command: bun test\n\nTimeout: 30",
    });
  });

  it("formats tool summaries correctly for common tools", () => {
    const bashSession = buildClaudeSessionFromText({
      path: "/tmp/session.jsonl",
      sessionId: "session-bash",
      text: [
        JSON.stringify({
          type: "user",
          uuid: "u1",
          timestamp: "2026-04-28T10:00:00.000Z",
          cwd: "/tmp/repo",
          message: { role: "user", content: "Run the tests\n" },
        }),
        JSON.stringify({
          type: "assistant",
          uuid: "a1",
          timestamp: "2026-04-28T10:00:02.000Z",
          message: {
            role: "assistant",
            stop_reason: "end_turn",
            content: [
              {
                type: "tool_use",
                id: "tool-bash",
                name: "Bash",
                input: { command: "bun test packages/api-contract/src" },
              },
            ],
          },
        }),
      ].join("\n"),
    });

    const toolMsg = bashSession.messages.find((m) => m.kind === "tool");
    expect(toolMsg).toMatchObject({
      kind: "tool",
      name: "Bash",
      summary: "bun test packages/api-contract/src",
    });
  });
});
