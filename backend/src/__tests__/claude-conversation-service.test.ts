import { describe, expect, it } from "bun:test";
import type {
  ClaudeCliGateway,
  ClaudeCliSession,
  ClaudeCliSessionSummary,
} from "../adapters/claude-cli";
import type { TmuxGateway } from "../adapters/tmux";
import type { WorktreeMeta, WorktreeSnapshot } from "../domain/model";
import { ClaudeConversationService } from "../services/claude-conversation-service";

class FakeGitGateway {
  resolveWorktreeGitDir(cwd: string): string {
    return `${cwd}/.git`;
  }
}

class FakeClaudeCliGateway implements Pick<ClaudeCliGateway, "listSessions" | "readSession" | "getSessionMtime"> {
  readonly calls: string[] = [];
  readonly sessions = new Map<string, ClaudeCliSession>();
  listedSessions: ClaudeCliSessionSummary[] = [];
  sessionMtimes = new Map<string, Date>();

  async listSessions(cwd: string): Promise<ClaudeCliSessionSummary[]> {
    this.calls.push(`listSessions:${cwd}`);
    return this.listedSessions.map((session) => ({ ...session }));
  }

  async readSession(sessionId: string, cwd: string): Promise<ClaudeCliSession | null> {
    this.calls.push(`readSession:${sessionId}:${cwd}`);
    return structuredClone(this.sessions.get(sessionId) ?? null);
  }

  async getSessionMtime(sessionId: string, _cwd: string): Promise<Date | null> {
    return this.sessionMtimes.get(sessionId) ?? null;
  }
}

function makeMeta(): WorktreeMeta {
  return {
    schemaVersion: 1,
    worktreeId: "wt-claude",
    branch: "claude-feature",
    createdAt: "2026-04-14T10:00:00.000Z",
    profile: "default",
    agent: "claude",
    runtime: "host",
    startupEnvValues: {},
    allocatedPorts: {},
  };
}

function makeWorktree(): WorktreeSnapshot {
  return {
    branch: "claude-feature",
    path: "/tmp/worktrees/claude-feature",
    dir: "claude-feature",
    archived: false,
    profile: "default",
    agentName: "claude",
    agentLabel: "Claude",
    mux: true,
    dirty: false,
    unpushed: false,
    paneCount: 1,
    status: "idle",
    elapsed: "1m",
    services: [],
    prs: [],
    linearIssue: null,
    creation: null,
  };
}

function makeSession(input: {
  sessionId: string;
  cwd: string;
  messages: ClaudeCliSession["messages"];
}): ClaudeCliSession {
  return {
    sessionId: input.sessionId,
    cwd: input.cwd,
    path: `${input.cwd}/${input.sessionId}.jsonl`,
    gitBranch: "claude-feature",
    createdAt: "2026-04-14T10:00:00.000Z",
    lastSeenAt: "2026-04-14T10:05:00.000Z",
    messages: input.messages,
  };
}

describe("ClaudeConversationService", () => {
  it("discovers the newest Claude session and persists it into metadata", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    const worktree = makeWorktree();
    const gitDir = `${worktree.path}/.git`;
    metaStore.set(gitDir, makeMeta());

    const session = makeSession({
      sessionId: "session-existing",
      cwd: worktree.path,
      messages: [
        {
          id: "user-1",
          turnId: "user-1",
          role: "user",
          text: "Inspect the diff",
          createdAt: "2026-04-14T10:01:00.000Z",
        },
        {
          id: "assistant-1",
          turnId: "user-1",
          role: "assistant",
          text: "The diff is clean.",
          createdAt: "2026-04-14T10:02:00.000Z",
        },
      ],
    });

    const claude = new FakeClaudeCliGateway();
    claude.listedSessions = [{
      sessionId: session.sessionId,
      cwd: worktree.path,
      path: session.path,
      lastSeenAt: "2026-04-14T10:05:00.000Z",
    }];
    claude.sessions.set(session.sessionId, structuredClone(session));

    const service = new ClaudeConversationService({
      claude,
      git: new FakeGitGateway(),
      now: () => new Date("2026-04-14T12:00:00.000Z"),
      readMeta: async (path) => structuredClone(metaStore.get(path) ?? null),
      writeMeta: async (path, meta) => {
        metaStore.set(path, structuredClone(meta));
      },
    });

    const result = await service.attachWorktreeConversation(worktree);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.conversation.provider).toBe("claudeCode");
    expect(result.data.conversation.conversationId).toBe("session-existing");
    expect(result.data.conversation.running).toBe(false);
    expect(result.data.conversation.messages).toHaveLength(2);
    expect(metaStore.get(gitDir)?.conversation).toEqual({
      provider: "claudeCode",
      conversationId: "session-existing",
      sessionId: "session-existing",
      cwd: worktree.path,
      lastSeenAt: "2026-04-14T12:00:00.000Z",
    });
  });
});

class FakeProbeGateway {
  lastActivityAt: string | null = null;
  capturedLines: string[] = [];

  capturePane(_target: string, _lines: number): string[] {
    return this.capturedLines;
  }

  getPaneLastActivity(_target: string): { lastActivityAt: string | null } {
    return { lastActivityAt: this.lastActivityAt };
  }

  ensureServer(): void {}
  ensureSession(): void {}
  hasWindow(): boolean { return false; }
  killWindow(): void {}
  killSession(): void {}
  createWindow(): void {}
  splitWindow(): void {}
  setWindowOption(): void {}
  setSessionOption(): void {}
  getSessionOption(): string | null { return null; }
  runCommand(): void {}
  selectPane(): void {}
  listWindows() { return []; }
  listAllSessions() { return []; }
  getFirstWindowName(): string | null { return null; }
}

describe("ClaudeConversationService — probe-driven running", () => {
  it("reports running=true when the probe reports recent activity", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    const worktree = makeWorktree();
    const gitDir = `${worktree.path}/.git`;
    metaStore.set(gitDir, makeMeta());

    const session = makeSession({
      sessionId: "session-probe",
      cwd: worktree.path,
      messages: [],
    });

    const claude = new FakeClaudeCliGateway();
    claude.listedSessions = [{
      sessionId: session.sessionId,
      cwd: worktree.path,
      path: session.path,
      lastSeenAt: "2026-04-14T10:05:00.000Z",
    }];
    claude.sessions.set(session.sessionId, structuredClone(session));

    const now = new Date("2026-04-14T12:00:00.000Z");
    const probeGateway = new FakeProbeGateway();
    probeGateway.lastActivityAt = new Date(now.getTime() - 500).toISOString();

    const service = new ClaudeConversationService({
      claude,
      git: new FakeGitGateway(),
      now: () => now,
      readMeta: async (path) => structuredClone(metaStore.get(path) ?? null),
      writeMeta: async (path, meta) => { metaStore.set(path, structuredClone(meta)); },
    });

    const result = await service.attachWorktreeConversation(worktree, {
      tmux: probeGateway as unknown as TmuxGateway,
      projectRoot: "/tmp/worktrees/claude-feature",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversation.running).toBe(true);
  });

  it("reports running=false when the probe reports stale activity", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    const worktree = makeWorktree();
    const gitDir = `${worktree.path}/.git`;
    metaStore.set(gitDir, makeMeta());

    const session = makeSession({
      sessionId: "session-stale",
      cwd: worktree.path,
      messages: [],
    });

    const claude = new FakeClaudeCliGateway();
    claude.listedSessions = [{
      sessionId: session.sessionId,
      cwd: worktree.path,
      path: session.path,
      lastSeenAt: "2026-04-14T10:05:00.000Z",
    }];
    claude.sessions.set(session.sessionId, structuredClone(session));

    const now = new Date("2026-04-14T12:00:00.000Z");
    const probeGateway = new FakeProbeGateway();
    probeGateway.lastActivityAt = new Date(now.getTime() - 10000).toISOString();

    const service = new ClaudeConversationService({
      claude,
      git: new FakeGitGateway(),
      now: () => now,
      readMeta: async (path) => structuredClone(metaStore.get(path) ?? null),
      writeMeta: async (path, meta) => { metaStore.set(path, structuredClone(meta)); },
    });

    const result = await service.attachWorktreeConversation(worktree, {
      tmux: probeGateway as unknown as TmuxGateway,
      projectRoot: "/tmp/worktrees/claude-feature",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversation.running).toBe(false);
  });

  it("reports running=false when no probe context is provided", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    const worktree = makeWorktree();
    const gitDir = `${worktree.path}/.git`;
    metaStore.set(gitDir, makeMeta());

    const session = makeSession({
      sessionId: "session-noprobe",
      cwd: worktree.path,
      messages: [],
    });

    const claude = new FakeClaudeCliGateway();
    claude.listedSessions = [{
      sessionId: session.sessionId,
      cwd: worktree.path,
      path: session.path,
      lastSeenAt: "2026-04-14T10:05:00.000Z",
    }];
    claude.sessions.set(session.sessionId, structuredClone(session));

    const service = new ClaudeConversationService({
      claude,
      git: new FakeGitGateway(),
      now: () => new Date("2026-04-14T12:00:00.000Z"),
      readMeta: async (path) => structuredClone(metaStore.get(path) ?? null),
      writeMeta: async (path, meta) => { metaStore.set(path, structuredClone(meta)); },
    });

    const result = await service.attachWorktreeConversation(worktree);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversation.running).toBe(false);
  });
});

describe("ClaudeConversationService — jsonl mtime fallback", () => {
  function makeSessionAndClaude(sessionId: string, worktree: ReturnType<typeof makeWorktree>) {
    const session = makeSession({ sessionId, cwd: worktree.path, messages: [] });
    const claude = new FakeClaudeCliGateway();
    claude.listedSessions = [{
      sessionId: session.sessionId,
      cwd: worktree.path,
      path: session.path,
      lastSeenAt: "2026-04-14T10:05:00.000Z",
    }];
    claude.sessions.set(session.sessionId, structuredClone(session));
    return { session, claude };
  }

  it("reports running=true when pane is stale but jsonl mtime is recent", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    const worktree = makeWorktree();
    metaStore.set(`${worktree.path}/.git`, makeMeta());

    const now = new Date("2026-04-14T12:00:00.000Z");
    const { session, claude } = makeSessionAndClaude("session-mtime-recent", worktree);
    claude.sessionMtimes.set(session.sessionId, new Date(now.getTime() - 5000));

    const probeGateway = new FakeProbeGateway();
    probeGateway.lastActivityAt = new Date(now.getTime() - 20000).toISOString();

    const service = new ClaudeConversationService({
      claude,
      git: new FakeGitGateway(),
      now: () => now,
      readMeta: async (path) => structuredClone(metaStore.get(path) ?? null),
      writeMeta: async (path, meta) => { metaStore.set(path, structuredClone(meta)); },
    });

    const result = await service.attachWorktreeConversation(worktree, {
      tmux: probeGateway as unknown as TmuxGateway,
      projectRoot: "/tmp/worktrees/claude-feature",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversation.running).toBe(true);
  });

  it("reports running=false when pane is stale and jsonl mtime is also stale", async () => {
    const metaStore = new Map<string, WorktreeMeta>();
    const worktree = makeWorktree();
    metaStore.set(`${worktree.path}/.git`, makeMeta());

    const now = new Date("2026-04-14T12:00:00.000Z");
    const { session, claude } = makeSessionAndClaude("session-mtime-stale", worktree);
    claude.sessionMtimes.set(session.sessionId, new Date(now.getTime() - 30000));

    const probeGateway = new FakeProbeGateway();
    probeGateway.lastActivityAt = new Date(now.getTime() - 20000).toISOString();

    const service = new ClaudeConversationService({
      claude,
      git: new FakeGitGateway(),
      now: () => now,
      readMeta: async (path) => structuredClone(metaStore.get(path) ?? null),
      writeMeta: async (path, meta) => { metaStore.set(path, structuredClone(meta)); },
    });

    const result = await service.attachWorktreeConversation(worktree, {
      tmux: probeGateway as unknown as TmuxGateway,
      projectRoot: "/tmp/worktrees/claude-feature",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.conversation.running).toBe(false);
  });
});
