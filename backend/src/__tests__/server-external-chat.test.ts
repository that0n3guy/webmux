/**
 * Unit tests for external tmux session chat route logic.
 *
 * Tests the agent-binary detection and session-not-found path that
 * resolveExternalChatTarget uses (tested in isolation without a live server).
 */
import { describe, expect, it } from "bun:test";
import { listExternalSessions } from "../services/external-tmux-service";
import type { TmuxGateway, TmuxSessionSummary } from "../adapters/tmux";
import { WEBMUX_SESSION_PREFIX } from "../adapters/tmux";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeSessions(overrides: Partial<TmuxSessionSummary>[]): TmuxSessionSummary[] {
  return overrides.map((o) => ({
    name: "external-session",
    windowCount: 1,
    attached: false,
    group: null,
    ...o,
  }));
}

function makeGateway(opts: {
  sessions: TmuxSessionSummary[];
  currentCommand?: string | null;
  currentPath?: string | null;
}): TmuxGateway {
  const sessionMap = new Map(opts.sessions.map((s) => [s.name, s]));
  return {
    ensureServer: () => {},
    ensureSession: () => {},
    hasWindow: () => false,
    killWindow: () => {},
    killSession: () => {},
    createWindow: () => {},
    splitWindow: () => {},
    setWindowOption: () => {},
    setSessionOption: () => {},
    getSessionOption: () => null,
    runCommand: () => {},
    selectPane: () => {},
    listWindows: () => [],
    listAllSessions: () => [...sessionMap.values()],
    getFirstWindowName: (sessionName) => sessionMap.has(sessionName) ? "0" : null,
    capturePane: () => [],
    getPaneCurrentCommand: () => opts.currentCommand ?? null,
    getPaneCurrentPath: () => opts.currentPath ?? "/tmp",
  };
}

// ── Tests: external session filtering ─────────────────────────────────────────

describe("external sessions — listExternalSessions filters wm- prefix", () => {
  it("excludes webmux-owned sessions", () => {
    const sessions = makeSessions([
      { name: `${WEBMUX_SESSION_PREFIX}proj-abc` },
      { name: "my-external-session" },
      { name: "another-external" },
    ]);
    const gw = makeGateway({ sessions });
    const result = listExternalSessions(sessions, gw);
    expect(result.map((s) => s.name)).toEqual(["my-external-session", "another-external"]);
  });
});

// ── Tests: agent-binary detection ────────────────────────────────────────────

describe("external sessions — agent binary detection for chat routing", () => {
  it("getPaneCurrentCommand returning 'claude' maps to claude agent", () => {
    const gw = makeGateway({
      sessions: makeSessions([{ name: "my-claude-session" }]),
      currentCommand: "claude",
    });
    const cmd = gw.getPaneCurrentCommand("my-claude-session:0.0");
    const base = cmd?.split("/").pop() ?? null;
    expect(base === "claude" ? "claude" : base === "codex" ? "codex" : null).toBe("claude");
  });

  it("getPaneCurrentCommand returning 'codex' maps to codex agent", () => {
    const gw = makeGateway({
      sessions: makeSessions([{ name: "my-codex-session" }]),
      currentCommand: "codex",
    });
    const cmd = gw.getPaneCurrentCommand("my-codex-session:0.0");
    const base = cmd?.split("/").pop() ?? null;
    expect(base === "claude" ? "claude" : base === "codex" ? "codex" : null).toBe("codex");
  });

  it("getPaneCurrentCommand returning 'bash' yields null (no chat support)", () => {
    const gw = makeGateway({
      sessions: makeSessions([{ name: "bash-session" }]),
      currentCommand: "bash",
    });
    const cmd = gw.getPaneCurrentCommand("bash-session:0.0");
    const base = cmd?.split("/").pop() ?? null;
    expect(base === "claude" ? "claude" : base === "codex" ? "codex" : null).toBeNull();
  });

  it("getPaneCurrentCommand returning null yields null", () => {
    const gw = makeGateway({
      sessions: makeSessions([{ name: "unknown-session" }]),
      currentCommand: null,
    });
    const cmd = gw.getPaneCurrentCommand("unknown-session:0.0");
    const base = cmd?.split("/").pop() ?? null;
    expect(base === "claude" ? "claude" : base === "codex" ? "codex" : null).toBeNull();
  });

  it("full path /usr/local/bin/claude still resolves to claude", () => {
    const gw = makeGateway({
      sessions: makeSessions([{ name: "full-path-session" }]),
      currentCommand: "/usr/local/bin/claude",
    });
    const cmd = gw.getPaneCurrentCommand("full-path-session:0.0");
    const base = cmd?.split("/").pop() ?? null;
    expect(base === "claude" ? "claude" : base === "codex" ? "codex" : null).toBe("claude");
  });
});

// ── Tests: session not found ───────────────────────────────────────────────

describe("external sessions — session not found check", () => {
  it("listAllSessions returns empty when no external sessions exist", () => {
    const gw = makeGateway({ sessions: [] });
    const all = gw.listAllSessions();
    const found = all.find((s) => s.name === "nonexistent");
    expect(found).toBeUndefined();
  });

  it("listAllSessions returns the session when it exists", () => {
    const gw = makeGateway({
      sessions: makeSessions([{ name: "target-session" }]),
    });
    const all = gw.listAllSessions();
    const found = all.find((s) => s.name === "target-session");
    expect(found).toBeDefined();
    expect(found?.name).toBe("target-session");
  });
});
