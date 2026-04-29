/**
 * Compile-time + unit tests for scratch session chat routes.
 *
 * We test the handler logic (resolveScratchChatTarget) by exercising the
 * underlying service logic; full HTTP-level integration tests would require
 * spinning up the Bun server which is out of scope here.
 */
import { describe, expect, it } from "bun:test";
import type { TmuxGateway } from "../adapters/tmux";
import { createScratchSessionService } from "../services/scratch-session-service";
import { resolveAgentChatSupport } from "../services/agent-chat-service";
import { getAgentDefinition } from "../services/agent-registry";
import type { ProjectConfig } from "../domain/config";

// ── Minimal project config ───────────────────────────────────────────────────

const BASE_CONFIG: ProjectConfig = {
  name: "Test Project",
  workspace: {
    mainBranch: "main",
    worktreeRoot: "__worktrees",
    defaultAgent: "claude",
    autoPull: { enabled: false, intervalSeconds: 300 },
  },
  profiles: {},
  agents: {},
  services: [],
  startupEnvs: {},
  integrations: {
    github: { linkedRepos: [], autoRemoveOnMerge: false },
    linear: { enabled: false, autoCreateWorktrees: false, createTicketOption: false },
  },
  lifecycleHooks: {},
  autoName: null,
};

// ── Fake TmuxGateway ─────────────────────────────────────────────────────────

function makeFakeGateway(): TmuxGateway {
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
    listAllSessions: () => [],
    getFirstWindowName: () => "0",
    capturePane: () => [],
    getPaneCurrentCommand: () => null,
    getPaneCurrentPath: () => null,
  };
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe("scratch chat — agent-kind session with claude", () => {
  it("resolveAgentChatSupport returns claude provider for claude agent", () => {
    const agentDef = getAgentDefinition(BASE_CONFIG, "claude");
    const result = resolveAgentChatSupport({
      agentId: "claude",
      agentLabel: "Claude",
      agent: agentDef,
      action: "chat",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.provider).toBe("claude");
    expect(result.data.submitDelayMs).toBe(0);
  });

  it("resolveAgentChatSupport returns codex provider for codex agent", () => {
    const agentDef = getAgentDefinition(BASE_CONFIG, "codex");
    const result = resolveAgentChatSupport({
      agentId: "codex",
      agentLabel: "Codex",
      agent: agentDef,
      action: "chat",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.provider).toBe("codex");
    expect(result.data.submitDelayMs).toBe(200);
  });
});

describe("scratch chat — 404 on unknown session id", () => {
  it("scratch session list returns empty when no sessions created", () => {
    const gw = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      projectId: "projA",
    });
    const metas = svc.list();
    const meta = metas.find((s) => s.id === "nonexistent");
    expect(meta).toBeUndefined();
  });
});

describe("scratch chat — 404 on non-agent session", () => {
  it("shell-kind scratch sessions fail the agent-kind check", async () => {
    const gw = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      projectId: "projA",
      idGenerator: () => "shell-id",
    });
    await svc.create({ displayName: "shell scratch", kind: "shell", agentId: null });
    const metas = svc.list();
    const meta = metas.find((s) => s.id === "shell-id");
    expect(meta).toBeDefined();
    // shell sessions have kind==="shell", not "agent"
    expect(meta?.kind).toBe("shell");
    // chat requires kind==="agent" AND agentId in ("claude","codex")
    const agentId = meta?.kind === "agent" ? meta.agentId : null;
    expect(agentId).toBeNull();
  });
});

describe("scratch chat — 404 on non-AI agent", () => {
  it("resolveAgentChatSupport returns not-ok for unknown custom agent", () => {
    const result = resolveAgentChatSupport({
      agentId: "custom-agent-xyz",
      agentLabel: "Custom XYZ",
      agent: null,
      action: "chat",
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(404);
  });
});

describe("scratch chat — agent session created with claude", () => {
  it("creates agent session and reports kind=agent with agentId=claude", async () => {
    const gw = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      projectId: "projA",
      idGenerator: () => "claude-scratch",
    });
    const meta = await svc.create({ displayName: "claude session", kind: "agent", agentId: "claude" });
    expect(meta.kind).toBe("agent");
    expect(meta.agentId).toBe("claude");
    expect(meta.sessionName).toBe("wm-scratch-projA-claude-scratch");

    // simulate resolveScratchChatTarget logic
    const metas = svc.list();
    const found = metas.find((s) => s.id === "claude-scratch");
    expect(found).toBeDefined();
    expect(found?.kind).toBe("agent");
    expect(found?.agentId).toBe("claude");

    const agentDef = getAgentDefinition(BASE_CONFIG, found?.agentId ?? "");
    const chatResult = resolveAgentChatSupport({
      agentId: found?.agentId ?? null,
      agentLabel: found?.agentId ?? null,
      agent: agentDef,
      action: "chat",
    });
    expect(chatResult.ok).toBe(true);
    if (!chatResult.ok) return;
    expect(chatResult.data.provider).toBe("claude");
  });
});
