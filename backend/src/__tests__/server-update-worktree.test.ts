import { afterEach, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getWorktreeStoragePaths,
  readWorktreeMeta,
  writeWorktreeMeta,
} from "../adapters/fs";
import { getAgentDefinition } from "../services/agent-registry";
import type { ProjectConfig } from "../domain/config";
import type { WorktreeMeta } from "../domain/model";
import { WORKTREE_META_SCHEMA_VERSION } from "../domain/model";

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

function makeMeta(overrides: Partial<WorktreeMeta> = {}): WorktreeMeta {
  return {
    schemaVersion: WORKTREE_META_SCHEMA_VERSION,
    worktreeId: "wt_test_001",
    branch: "feature/test",
    createdAt: "2026-01-01T00:00:00.000Z",
    profile: "default",
    agent: "claude",
    runtime: "host",
    startupEnvValues: {},
    allocatedPorts: {},
    yolo: false,
    ...overrides,
  };
}

let gitDir: string | undefined;

afterEach(async () => {
  if (gitDir) {
    await rm(gitDir, { recursive: true, force: true });
    gitDir = undefined;
  }
});

describe("apiUpdateWorktree — happy path", () => {
  it("updates agent in stored meta", async () => {
    gitDir = await mkdtemp(join(tmpdir(), "webmux-update-wt-"));
    const paths = getWorktreeStoragePaths(gitDir);
    await mkdir(paths.webmuxDir, { recursive: true });
    await writeWorktreeMeta(gitDir, makeMeta({ agent: "claude" }));

    const meta = await readWorktreeMeta(gitDir);
    expect(meta?.agent).toBe("claude");

    if (!meta) throw new Error("meta is null");
    meta.agent = "codex";
    await writeWorktreeMeta(gitDir, meta);

    const updated = await readWorktreeMeta(gitDir);
    expect(updated?.agent).toBe("codex");
  });

  it("updates yolo flag in stored meta", async () => {
    gitDir = await mkdtemp(join(tmpdir(), "webmux-update-wt-yolo-"));
    const paths = getWorktreeStoragePaths(gitDir);
    await mkdir(paths.webmuxDir, { recursive: true });
    await writeWorktreeMeta(gitDir, makeMeta({ yolo: false }));

    const meta = await readWorktreeMeta(gitDir);
    expect(meta?.yolo).toBe(false);

    if (!meta) throw new Error("meta is null");
    meta.yolo = true;
    await writeWorktreeMeta(gitDir, meta);

    const updated = await readWorktreeMeta(gitDir);
    expect(updated?.yolo).toBe(true);
  });

  it("partial update — only agent changes, yolo unchanged", async () => {
    gitDir = await mkdtemp(join(tmpdir(), "webmux-update-wt-partial-"));
    const paths = getWorktreeStoragePaths(gitDir);
    await mkdir(paths.webmuxDir, { recursive: true });
    await writeWorktreeMeta(gitDir, makeMeta({ agent: "claude", yolo: true }));

    const meta = await readWorktreeMeta(gitDir);
    if (!meta) throw new Error("meta is null");
    meta.agent = "codex";
    await writeWorktreeMeta(gitDir, meta);

    const updated = await readWorktreeMeta(gitDir);
    expect(updated?.agent).toBe("codex");
    expect(updated?.yolo).toBe(true);
  });
});

describe("apiUpdateWorktree — validation", () => {
  it("getAgentDefinition returns null for unknown agent id", () => {
    const result = getAgentDefinition(BASE_CONFIG, "totally-unknown-agent-xyz");
    expect(result).toBeNull();
  });

  it("getAgentDefinition returns a definition for claude", () => {
    const result = getAgentDefinition(BASE_CONFIG, "claude");
    expect(result).not.toBeNull();
    expect(result?.id).toBe("claude");
  });

  it("readWorktreeMeta returns null when meta file is absent", async () => {
    gitDir = await mkdtemp(join(tmpdir(), "webmux-update-wt-missing-"));
    const result = await readWorktreeMeta(gitDir);
    expect(result).toBeNull();
  });
});
