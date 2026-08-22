import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureAgentRuntimeArtifacts, resolveAgentCtlPath } from "../adapters/agent-runtime";
import { buildControlEnvMap, ensureWorktreeStorageDirs, writeControlEnv } from "../adapters/fs";

describe("ensureAgentRuntimeArtifacts", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("writes agent control helpers and Claude hook settings into worktree-owned paths", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "webmux-agent-runtime-gitdir-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "webmux-agent-runtime-worktree-"));
    tempDirs.push(gitDir, worktreePath);

    await ensureWorktreeStorageDirs(gitDir);
    const artifacts = await ensureAgentRuntimeArtifacts({
      gitDir,
      worktreePath,
    });

    expect(await Bun.file(artifacts.agentCtlPath).text()).toContain("webmux-agentctl");
    expect(await Bun.file(artifacts.agentCtlPath).text()).toContain("claude-user-prompt-submit");
    expect(await Bun.file(artifacts.agentCtlPath).text()).toContain("agent_status_changed");

    const settings = await Bun.file(artifacts.claudeSettingsPath).json() as {
      hooks?: {
        UserPromptSubmit?: Array<{ hooks?: Array<{ command?: string }> }>;
        Notification?: Array<{ matcher?: string; hooks?: Array<{ command?: string }> }>;
        Stop?: Array<{ hooks?: Array<{ command?: string }> }>;
        PostToolUse?: Array<{ hooks?: Array<{ command?: string }> }>;
      };
    };

    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain("webmux-agentctl");
    expect(settings.hooks?.UserPromptSubmit?.[0]?.hooks?.[0]?.command).toContain("claude-user-prompt-submit");
    expect(settings.hooks?.Notification?.[0]?.matcher).toBe("permission_prompt|elicitation_dialog");
    expect(settings.hooks?.Notification?.[0]?.hooks?.[0]?.command).toContain("status-changed --lifecycle idle");
    expect(settings.hooks?.Stop?.[0]?.hooks?.[0]?.command).toContain("agent-stopped");
    expect(settings.hooks?.PostToolUse?.[0]?.hooks?.[0]?.command).toContain("status-changed --lifecycle running");
    expect(settings.hooks?.PostToolUse?.[1]?.hooks?.[0]?.command).toContain("claude-post-tool-use");
  });

  it("maps codex agent-turn-complete notifications to agent_stopped runtime events", async () => {
    const gitDir = await mkdtemp(join(tmpdir(), "webmux-agent-runtime-gitdir-"));
    const worktreePath = await mkdtemp(join(tmpdir(), "webmux-agent-runtime-worktree-"));
    tempDirs.push(gitDir, worktreePath);

    await ensureWorktreeStorageDirs(gitDir);
    await ensureAgentRuntimeArtifacts({ gitDir, worktreePath });

    const received: Array<{ body: unknown; authorization: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch: async (req) => {
        received.push({ body: await req.json(), authorization: req.headers.get("Authorization") });
        return Response.json({ ok: true });
      },
    });

    try {
      await writeControlEnv(gitDir, buildControlEnvMap({
        controlUrl: `http://127.0.0.1:${server.port}/api/runtime/events`,
        controlToken: "test-token",
        worktreeId: "wt-1",
        branch: "feature/codex",
      }));

      const agentCtlPath = resolveAgentCtlPath(gitDir);
      const turnComplete = Bun.spawn([
        "python3",
        agentCtlPath,
        "codex-notify",
        JSON.stringify({ "type": "agent-turn-complete", "turn-id": "t1", "last-assistant-message": "done" }),
      ], { stdout: "pipe", stderr: "pipe" });
      expect(await turnComplete.exited).toBe(0);

      const otherType = Bun.spawn([
        "python3",
        agentCtlPath,
        "codex-notify",
        JSON.stringify({ "type": "something-else" }),
      ], { stdout: "pipe", stderr: "pipe" });
      expect(await otherType.exited).toBe(0);

      const noPayload = Bun.spawn(["python3", agentCtlPath, "codex-notify"], { stdout: "pipe", stderr: "pipe" });
      expect(await noPayload.exited).toBe(0);

      expect(received).toHaveLength(1);
      expect(received[0].body).toEqual({
        worktreeId: "wt-1",
        branch: "feature/codex",
        type: "agent_stopped",
      });
      expect(received[0].authorization).toBe("Bearer test-token");
    } finally {
      server.stop(true);
    }
  });
});
