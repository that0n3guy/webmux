import { describe, expect, it } from "bun:test";
import type { TmuxGateway } from "../adapters/tmux";
import type { WorktreeConversationMeta, WorktreeMeta } from "../domain/model";
import {
  buildTmuxConversationStorage,
  buildWorktreeConversationStorage,
} from "../services/conversation-storage";

// ── Fake TmuxGateway ─────────────────────────────────────────────────────────

class FakeTmuxGateway implements TmuxGateway {
  private readonly options = new Map<string, Map<string, string>>();

  ensureServer(): void {}
  ensureSession(_sessionName: string, _cwd: string): void {}
  hasWindow(_sessionName: string, _windowName: string): boolean { return false; }
  killWindow(_sessionName: string, _windowName: string): void {}
  killSession(_sessionName: string): void {}
  createWindow(_opts: Parameters<TmuxGateway["createWindow"]>[0]): void {}
  splitWindow(_opts: Parameters<TmuxGateway["splitWindow"]>[0]): void {}
  setWindowOption(_sessionName: string, _windowName: string, _option: string, _value: string): void {}
  runCommand(_target: string, _command: string): void {}
  selectPane(_target: string): void {}
  listWindows(): ReturnType<TmuxGateway["listWindows"]> { return []; }
  listAllSessions(): ReturnType<TmuxGateway["listAllSessions"]> { return []; }
  getFirstWindowName(_sessionName: string): string | null { return null; }
  capturePane(_target: string, _lines: number): string[] { return []; }

  setSessionOption(sessionName: string, optionName: string, value: string): void {
    let session = this.options.get(sessionName);
    if (!session) {
      session = new Map();
      this.options.set(sessionName, session);
    }
    session.set(optionName, value);
  }

  getSessionOption(sessionName: string, optionName: string): string | null {
    return this.options.get(sessionName)?.get(optionName) ?? null;
  }
}

// ── buildWorktreeConversationStorage ─────────────────────────────────────────

function makeBaseMeta(): WorktreeMeta {
  return {
    schemaVersion: 1,
    worktreeId: "wt-test",
    branch: "test-branch",
    createdAt: "2026-04-28T10:00:00.000Z",
    profile: "default",
    agent: "claude",
    runtime: "host",
    startupEnvValues: {},
    allocatedPorts: {},
  };
}

describe("buildWorktreeConversationStorage", () => {
  it("load returns null when no conversation exists in meta", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    metaStore.set("/test/.git", makeBaseMeta());

    const storage = buildWorktreeConversationStorage({
      gitDir: "/test/.git",
      readMeta: async (dir) => metaStore.get(dir) ?? null,
      writeMeta: async (dir, meta) => { metaStore.set(dir, meta); },
    });

    const result = await storage.load();
    expect(result).toBeNull();
  });

  it("load returns null when meta file is missing", async () => {
    const storage = buildWorktreeConversationStorage({
      gitDir: "/nonexistent/.git",
      readMeta: async () => null,
      writeMeta: async () => {},
    });

    const result = await storage.load();
    expect(result).toBeNull();
  });

  it("load returns conversation from WorktreeMeta", async () => {
    const conversation: WorktreeConversationMeta = {
      provider: "claudeCode",
      conversationId: "session-abc",
      sessionId: "session-abc",
      cwd: "/tmp/my-worktree",
      lastSeenAt: "2026-04-28T11:00:00.000Z",
    };

    const metaStore = new Map<string, WorktreeMeta>();
    metaStore.set("/test/.git", { ...makeBaseMeta(), conversation });

    const storage = buildWorktreeConversationStorage({
      gitDir: "/test/.git",
      readMeta: async (dir) => metaStore.get(dir) ?? null,
      writeMeta: async (dir, meta) => { metaStore.set(dir, meta); },
    });

    const result = await storage.load();
    expect(result).toEqual(conversation);
  });

  it("save round-trips a ClaudeCode conversation through WorktreeMeta", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    metaStore.set("/test/.git", makeBaseMeta());

    const storage = buildWorktreeConversationStorage({
      gitDir: "/test/.git",
      readMeta: async (dir) => metaStore.get(dir) ?? null,
      writeMeta: async (dir, meta) => { metaStore.set(dir, meta); },
    });

    const conversation: WorktreeConversationMeta = {
      provider: "claudeCode",
      conversationId: "session-xyz",
      sessionId: "session-xyz",
      cwd: "/tmp/my-worktree",
      lastSeenAt: "2026-04-28T12:00:00.000Z",
    };

    await storage.save(conversation);
    const loaded = await storage.load();

    expect(loaded).toEqual(conversation);
  });

  it("save round-trips a CodexAppServer conversation through WorktreeMeta", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    metaStore.set("/test/.git", makeBaseMeta());

    const storage = buildWorktreeConversationStorage({
      gitDir: "/test/.git",
      readMeta: async (dir) => metaStore.get(dir) ?? null,
      writeMeta: async (dir, meta) => { metaStore.set(dir, meta); },
    });

    const conversation: WorktreeConversationMeta = {
      provider: "codexAppServer",
      conversationId: "thread-123",
      threadId: "thread-123",
      cwd: "/tmp/codex-worktree",
      lastSeenAt: "2026-04-28T13:00:00.000Z",
    };

    await storage.save(conversation);
    const loaded = await storage.load();

    expect(loaded).toEqual(conversation);
  });

  it("save preserves the rest of WorktreeMeta when writing conversation", async () => {
    const originalMeta = makeBaseMeta();
    const metaStore = new Map<string, WorktreeMeta>();
    metaStore.set("/test/.git", originalMeta);

    const storage = buildWorktreeConversationStorage({
      gitDir: "/test/.git",
      readMeta: async (dir) => metaStore.get(dir) ?? null,
      writeMeta: async (dir, meta) => { metaStore.set(dir, meta); },
    });

    const conversation: WorktreeConversationMeta = {
      provider: "claudeCode",
      conversationId: "session-new",
      sessionId: "session-new",
      cwd: "/tmp/my-worktree",
      lastSeenAt: "2026-04-28T12:00:00.000Z",
    };

    await storage.save(conversation);

    const saved = metaStore.get("/test/.git");
    expect(saved?.worktreeId).toBe(originalMeta.worktreeId);
    expect(saved?.branch).toBe(originalMeta.branch);
    expect(saved?.profile).toBe(originalMeta.profile);
    expect(saved?.conversation).toEqual(conversation);
  });

  it("save does nothing when meta is missing", async () => {
    const writeCalls: string[] = [];

    const storage = buildWorktreeConversationStorage({
      gitDir: "/missing/.git",
      readMeta: async () => null,
      writeMeta: async (dir) => { writeCalls.push(dir); },
    });

    const conversation: WorktreeConversationMeta = {
      provider: "claudeCode",
      conversationId: "session-x",
      sessionId: "session-x",
      cwd: "/tmp",
      lastSeenAt: "2026-04-28T00:00:00.000Z",
    };

    await storage.save(conversation);
    expect(writeCalls).toHaveLength(0);
  });
});

// ── buildTmuxConversationStorage ──────────────────────────────────────────────

describe("buildTmuxConversationStorage", () => {
  it("load returns null when no options exist", async () => {
    const tmux = new FakeTmuxGateway();
    const storage = buildTmuxConversationStorage({ tmux, sessionName: "test-session" });

    const result = await storage.load();
    expect(result).toBeNull();
  });

  it("load returns null when required options are partially missing", async () => {
    const tmux = new FakeTmuxGateway();
    tmux.setSessionOption("test-session", "@webmux-conversation-provider", "claudeCode");
    tmux.setSessionOption("test-session", "@webmux-conversation-id", "session-abc");
    // cwd and lastSeenAt missing

    const storage = buildTmuxConversationStorage({ tmux, sessionName: "test-session" });
    const result = await storage.load();
    expect(result).toBeNull();
  });

  it("load returns null when provider-specific field is missing (claudeCode)", async () => {
    const tmux = new FakeTmuxGateway();
    tmux.setSessionOption("test-session", "@webmux-conversation-provider", "claudeCode");
    tmux.setSessionOption("test-session", "@webmux-conversation-id", "session-abc");
    tmux.setSessionOption("test-session", "@webmux-conversation-cwd", "/tmp/worktree");
    tmux.setSessionOption("test-session", "@webmux-conversation-last-seen-at", "2026-04-28T11:00:00.000Z");
    // claude session id is missing

    const storage = buildTmuxConversationStorage({ tmux, sessionName: "test-session" });
    const result = await storage.load();
    expect(result).toBeNull();
  });

  it("load returns null when provider-specific field is missing (codexAppServer)", async () => {
    const tmux = new FakeTmuxGateway();
    tmux.setSessionOption("test-session", "@webmux-conversation-provider", "codexAppServer");
    tmux.setSessionOption("test-session", "@webmux-conversation-id", "thread-abc");
    tmux.setSessionOption("test-session", "@webmux-conversation-cwd", "/tmp/worktree");
    tmux.setSessionOption("test-session", "@webmux-conversation-last-seen-at", "2026-04-28T11:00:00.000Z");
    // thread id is missing

    const storage = buildTmuxConversationStorage({ tmux, sessionName: "test-session" });
    const result = await storage.load();
    expect(result).toBeNull();
  });

  it("save and load round-trips a ClaudeCode conversation through tmux options", async () => {
    const tmux = new FakeTmuxGateway();
    const storage = buildTmuxConversationStorage({ tmux, sessionName: "wm-scratch-session" });

    const conversation: WorktreeConversationMeta = {
      provider: "claudeCode",
      conversationId: "session-xyz",
      sessionId: "session-xyz",
      cwd: "/home/user/project",
      lastSeenAt: "2026-04-28T12:00:00.000Z",
    };

    await storage.save(conversation);
    const loaded = await storage.load();

    expect(loaded).toEqual(conversation);
  });

  it("save and load round-trips a CodexAppServer conversation through tmux options", async () => {
    const tmux = new FakeTmuxGateway();
    const storage = buildTmuxConversationStorage({ tmux, sessionName: "wm-scratch-codex" });

    const conversation: WorktreeConversationMeta = {
      provider: "codexAppServer",
      conversationId: "thread-456",
      threadId: "thread-456",
      cwd: "/home/user/codex-project",
      lastSeenAt: "2026-04-28T13:00:00.000Z",
    };

    await storage.save(conversation);
    const loaded = await storage.load();

    expect(loaded).toEqual(conversation);
  });

  it("save sets all expected tmux options for claudeCode", async () => {
    const tmux = new FakeTmuxGateway();
    const storage = buildTmuxConversationStorage({ tmux, sessionName: "my-session" });

    const conversation: WorktreeConversationMeta = {
      provider: "claudeCode",
      conversationId: "session-111",
      sessionId: "session-111",
      cwd: "/workspace",
      lastSeenAt: "2026-04-28T09:00:00.000Z",
    };

    await storage.save(conversation);

    expect(tmux.getSessionOption("my-session", "@webmux-conversation-provider")).toBe("claudeCode");
    expect(tmux.getSessionOption("my-session", "@webmux-conversation-id")).toBe("session-111");
    expect(tmux.getSessionOption("my-session", "@webmux-conversation-cwd")).toBe("/workspace");
    expect(tmux.getSessionOption("my-session", "@webmux-conversation-last-seen-at")).toBe("2026-04-28T09:00:00.000Z");
    expect(tmux.getSessionOption("my-session", "@webmux-conversation-claude-session-id")).toBe("session-111");
  });

  it("save sets all expected tmux options for codexAppServer", async () => {
    const tmux = new FakeTmuxGateway();
    const storage = buildTmuxConversationStorage({ tmux, sessionName: "my-session" });

    const conversation: WorktreeConversationMeta = {
      provider: "codexAppServer",
      conversationId: "thread-222",
      threadId: "thread-222",
      cwd: "/workspace",
      lastSeenAt: "2026-04-28T09:00:00.000Z",
    };

    await storage.save(conversation);

    expect(tmux.getSessionOption("my-session", "@webmux-conversation-provider")).toBe("codexAppServer");
    expect(tmux.getSessionOption("my-session", "@webmux-conversation-id")).toBe("thread-222");
    expect(tmux.getSessionOption("my-session", "@webmux-conversation-cwd")).toBe("/workspace");
    expect(tmux.getSessionOption("my-session", "@webmux-conversation-last-seen-at")).toBe("2026-04-28T09:00:00.000Z");
    expect(tmux.getSessionOption("my-session", "@webmux-conversation-codex-thread-id")).toBe("thread-222");
  });

  it("load returns null for an unknown provider value", async () => {
    const tmux = new FakeTmuxGateway();
    tmux.setSessionOption("test-session", "@webmux-conversation-provider", "unknownProvider");
    tmux.setSessionOption("test-session", "@webmux-conversation-id", "id-abc");
    tmux.setSessionOption("test-session", "@webmux-conversation-cwd", "/tmp");
    tmux.setSessionOption("test-session", "@webmux-conversation-last-seen-at", "2026-04-28T11:00:00.000Z");

    const storage = buildTmuxConversationStorage({ tmux, sessionName: "test-session" });
    const result = await storage.load();
    expect(result).toBeNull();
  });
});
