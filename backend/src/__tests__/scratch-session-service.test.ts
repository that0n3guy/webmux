import { describe, expect, test } from "bun:test";
import type { TmuxGateway, TmuxSessionSummary } from "../adapters/tmux";
import { createScratchSessionService } from "../services/scratch-session-service";

function makeFakeGateway(initial: TmuxSessionSummary[] = []): {
  gw: TmuxGateway;
  state: { sessions: TmuxSessionSummary[]; commands: string[]; killed: string[] };
} {
  const state = { sessions: [...initial], commands: [] as string[], killed: [] as string[] };
  const gw: TmuxGateway = {
    ensureServer: () => {},
    ensureSession: (name, cwd) => {
      state.commands.push(`ensureSession ${name} ${cwd}`);
      if (!state.sessions.find((s) => s.name === name)) {
        state.sessions.push({ name, windowCount: 1, attached: false, group: null });
      }
    },
    hasWindow: () => false,
    killWindow: () => {},
    killSession: (name) => {
      state.killed.push(name);
      state.sessions = state.sessions.filter((s) => s.name !== name);
    },
    createWindow: () => {},
    splitWindow: () => {},
    setWindowOption: () => {},
    runCommand: (target, cmd) => { state.commands.push(`runCommand ${target} ${cmd}`); },
    selectPane: () => {},
    listWindows: () => [],
    listAllSessions: () => state.sessions,
    getFirstWindowName: () => "0",
  };
  return { gw, state };
}

describe("scratch-session-service", () => {
  test("create persists meta and ensures tmux session", async () => {
    const { gw, state } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
    });

    const meta = await svc.create({ displayName: "scratch one", kind: "shell", agentId: null });

    expect(meta).toEqual({
      id: "abc",
      displayName: "scratch one",
      sessionName: "wm-scratch-abc",
      kind: "shell",
      agentId: null,
      cwd: "/tmp",
      createdAt: "2026-04-27T15:00:00Z",
    });
    expect(state.commands).toContain("ensureSession wm-scratch-abc /tmp");
  });

  test("list returns snapshots merging meta with live tmux state", async () => {
    const { gw } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
    });
    await svc.create({ displayName: "a", kind: "shell", agentId: null });

    const snaps = svc.list();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      id: "abc",
      sessionName: "wm-scratch-abc",
      windowCount: 1,
      attached: false,
    });
  });

  test("scan rebuilds in-memory map from existing wm-scratch-* tmux sessions", async () => {
    const existing: TmuxSessionSummary[] = [
      { name: "wm-scratch-existing1", windowCount: 1, attached: false, group: null },
      { name: "mcpsaa",                windowCount: 1, attached: true,  group: null },
      { name: "wm-foo",                windowCount: 1, attached: false, group: null },
    ];
    const { gw } = makeFakeGateway(existing);
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "new",
      now: () => "2026-04-27T15:00:00Z",
    });

    svc.scan();

    const snaps = svc.list();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ id: "existing1", sessionName: "wm-scratch-existing1" });
  });

  test("remove kills tmux session and drops meta", async () => {
    const { gw, state } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
    });
    await svc.create({ displayName: "a", kind: "shell", agentId: null });

    svc.remove("abc");
    expect(svc.list()).toHaveLength(0);
    expect(state.killed).toContain("wm-scratch-abc");
  });

  test("getByName resolves a tmux session name to its meta", async () => {
    const { gw } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
    });
    await svc.create({ displayName: "a", kind: "shell", agentId: null });
    expect(svc.getBySessionName("wm-scratch-abc")?.id).toBe("abc");
    expect(svc.getBySessionName("does-not-exist")).toBeNull();
  });

  test("create with kind=agent runs the agent launch command", async () => {
    const { gw, state } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
      getAgentLaunchCommand: (agentId) => agentId === "claude" ? "claude --bare" : null,
    });

    await svc.create({ displayName: "agent-one", kind: "agent", agentId: "claude" });

    expect(state.commands.some((c) => c === "runCommand wm-scratch-abc claude --bare")).toBe(true);
  });

  test("create with kind=shell does NOT run an agent launch command", async () => {
    const { gw, state } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "xyz",
      now: () => "2026-04-27T15:00:00Z",
      getAgentLaunchCommand: () => "should-not-run",
    });

    await svc.create({ displayName: "shell-one", kind: "shell", agentId: null });

    expect(state.commands.some((c) => c.startsWith("runCommand"))).toBe(false);
  });
});
