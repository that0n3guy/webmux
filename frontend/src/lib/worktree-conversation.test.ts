import { describe, expect, it } from "vitest";
import {
  applyConversationMessageDelta,
  buildConversationProgressSignature,
  markConversationTurnStarted,
  preservePendingUserMessages,
} from "./worktree-conversation";
import type { AgentsUiConversationState } from "./types";

function makeConversation(): AgentsUiConversationState {
  return {
    provider: "codexAppServer",
    conversationId: "thread-1",
    cwd: "/tmp/worktree",
    running: false,
    activeTurnId: null,
    messages: [
      {
        id: "user-1",
        turnId: "turn-1",
        kind: "user",
        text: "Inspect the diff",
        status: "completed",
        createdAt: "2026-04-15T10:00:00.000Z",
      },
    ],
  };
}

describe("worktree conversation helpers", () => {
  it("adds optimistic user messages when a turn starts", () => {
    expect(markConversationTurnStarted(makeConversation(), "turn-2", "Ship it")?.messages.at(-1)).toEqual({
      id: "pending-user:turn-2",
      turnId: "turn-2",
      kind: "user",
      text: "Ship it",
      status: "completed",
      createdAt: expect.any(String),
    });
  });

  it("appends assistant deltas to an in-progress message", () => {
    const started = applyConversationMessageDelta(makeConversation(), {
      type: "messageDelta",
      conversationId: "thread-1",
      turnId: "turn-2",
      itemId: "assistant-2",
      delta: "Looking",
    });

    const updated = applyConversationMessageDelta(started, {
      type: "messageDelta",
      conversationId: "thread-1",
      turnId: "turn-2",
      itemId: "assistant-2",
      delta: " good",
    });

    expect(updated?.messages.at(-1)).toEqual({
      id: "assistant-2",
      turnId: "turn-2",
      kind: "assistant",
      text: "Looking good",
      status: "inProgress",
      createdAt: null,
    });
    expect(updated?.running).toBe(true);
    expect(updated?.activeTurnId).toBe("turn-2");
  });

  it("preservePendingUserMessages keeps queued optimistic messages across snapshots", () => {
    const withPending = markConversationTurnStarted(makeConversation(), "turn-2", "queued msg");
    expect(withPending).not.toBeNull();
    if (!withPending) return;

    // Server snapshot doesn't yet contain turn-2 (claude is still on turn-1)
    const serverSnapshot = makeConversation();
    const merged = preservePendingUserMessages(withPending, serverSnapshot);

    expect(merged.messages.some((m) => m.id === "pending-user:turn-2")).toBe(true);
    expect(merged.messages).toHaveLength(2);
  });

  it("preservePendingUserMessages drops pending once snapshot has the real user message", () => {
    const withPending = markConversationTurnStarted(makeConversation(), "turn-2", "queued msg");
    if (!withPending) return;

    // Server snapshot now contains the real user message for turn-2
    const serverSnapshot: AgentsUiConversationState = {
      ...makeConversation(),
      messages: [
        ...makeConversation().messages,
        {
          id: "user-real",
          turnId: "turn-2",
          kind: "user",
          text: "queued msg",
          status: "completed",
          createdAt: "2026-04-15T10:01:00.000Z",
        },
      ],
    };

    const merged = preservePendingUserMessages(withPending, serverSnapshot);
    expect(merged.messages.filter((m) => m.id.startsWith("pending-user:"))).toHaveLength(0);
    expect(merged.messages).toHaveLength(2);
  });

  it("preservePendingUserMessages does NOT dedupe pending against an older same-text user message", () => {
    // History has two prior "again" messages from earlier in the session.
    const baseConv: AgentsUiConversationState = {
      provider: "codexAppServer",
      conversationId: "thread-1",
      cwd: "/tmp/worktree",
      running: false,
      activeTurnId: null,
      messages: [
        { id: "u1", turnId: "t1", kind: "user", text: "again", status: "completed", createdAt: "2026-04-15T10:00:00.000Z" },
        { id: "a1", turnId: "t1", kind: "assistant", text: "ok", status: "completed", createdAt: "2026-04-15T10:00:01.000Z" },
        { id: "u2", turnId: "t2", kind: "user", text: "again", status: "completed", createdAt: "2026-04-15T10:00:02.000Z" },
        { id: "a2", turnId: "t2", kind: "assistant", text: "ok", status: "completed", createdAt: "2026-04-15T10:00:03.000Z" },
      ],
    };
    // User queues another "again" — pending appended.
    const withPending = markConversationTurnStarted(baseConv, "tmux:new", "again");
    if (!withPending) return;

    // Snapshot polls back; agent hasn't yet picked up the queued message,
    // so snapshot is identical to the base history — only TWO real "again"s.
    const stillSnapshot = baseConv;
    const merged = preservePendingUserMessages(withPending, stillSnapshot);

    // Pending should still be there. The two old "again" messages are NOT
    // valid match targets for the new pending.
    expect(merged.messages.filter((m) => m.id.startsWith("pending-user:"))).toHaveLength(1);
    expect(merged.messages.filter((m) => m.kind === "user")).toHaveLength(3);
  });

  it("preservePendingUserMessages dedupes once snapshot adds a NEW same-text user message", () => {
    const baseConv: AgentsUiConversationState = {
      provider: "codexAppServer",
      conversationId: "thread-1",
      cwd: "/tmp/worktree",
      running: false,
      activeTurnId: null,
      messages: [
        { id: "u1", turnId: "t1", kind: "user", text: "again", status: "completed", createdAt: "2026-04-15T10:00:00.000Z" },
        { id: "a1", turnId: "t1", kind: "assistant", text: "ok", status: "completed", createdAt: "2026-04-15T10:00:01.000Z" },
      ],
    };
    const withPending = markConversationTurnStarted(baseConv, "tmux:new", "again");
    if (!withPending) return;

    // Snapshot now contains the queued message as a real third user message.
    const newerSnapshot: AgentsUiConversationState = {
      ...baseConv,
      messages: [
        ...baseConv.messages,
        { id: "u2", turnId: "t2", kind: "user", text: "again", status: "completed", createdAt: "2026-04-15T10:00:05.000Z" },
        { id: "a2", turnId: "t2", kind: "assistant", text: "ok again", status: "completed", createdAt: "2026-04-15T10:00:06.000Z" },
      ],
    };
    const merged = preservePendingUserMessages(withPending, newerSnapshot);

    // Pending consumed by the brand-new "again", not the older one.
    expect(merged.messages.filter((m) => m.id.startsWith("pending-user:"))).toHaveLength(0);
    expect(merged.messages.filter((m) => m.kind === "user" && m.text === "again")).toHaveLength(2);
  });

  it("preservePendingUserMessages dedupes by text when turnIds differ (tmux:* vs claude uuid)", () => {
    // Send endpoint assigns a tmux:<uuid> turnId; claude's jsonl uses its own uuid.
    const withPending = markConversationTurnStarted(makeConversation(), "tmux:abc", "Ship it");
    if (!withPending) return;

    const serverSnapshot: AgentsUiConversationState = {
      ...makeConversation(),
      messages: [
        ...makeConversation().messages,
        {
          id: "user-real",
          turnId: "claude-uuid-xyz", // different from optimistic turnId
          kind: "user",
          text: "Ship it",
          status: "completed",
          createdAt: "2026-04-15T10:01:00.000Z",
        },
      ],
    };

    const merged = preservePendingUserMessages(withPending, serverSnapshot);
    expect(merged.messages.filter((m) => m.id.startsWith("pending-user:"))).toHaveLength(0);
    expect(merged.messages.filter((m) => m.kind === "user" && m.text === "Ship it")).toHaveLength(1);
  });

  it("captures progress when the latest message grows", () => {
    const started = applyConversationMessageDelta(makeConversation(), {
      type: "messageDelta",
      conversationId: "thread-1",
      turnId: "turn-2",
      itemId: "assistant-2",
      delta: "Looking",
    });

    const updated = applyConversationMessageDelta(started, {
      type: "messageDelta",
      conversationId: "thread-1",
      turnId: "turn-2",
      itemId: "assistant-2",
      delta: " better",
    });

    expect(buildConversationProgressSignature(started)).not.toBe(buildConversationProgressSignature(updated));
  });
});
