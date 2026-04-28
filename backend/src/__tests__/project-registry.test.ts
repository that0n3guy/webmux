import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createProjectRegistry, type ProjectRegistry } from "../services/project-registry";
import { computeProjectId } from "../adapters/tmux";

let workdir: string;
let registryPath: string;

function makeProjectDir(name: string, withConfig = true): string {
  const dir = join(workdir, name);
  mkdirSync(dir, { recursive: true });
  if (withConfig) {
    writeFileSync(join(dir, ".webmux.yaml"), `name: ${name}\nworkspace:\n  mainBranch: main\n`);
  }
  // git init so adapters that resolve gitDir don't fail
  execSync(`git -C ${dir} init -q && git -C ${dir} commit --allow-empty -q -m init`, { stdio: "ignore" });
  return resolve(dir);
}

beforeEach(() => {
  workdir = mkdtempSync(`${tmpdir()}/wm-registry-`);
  registryPath = join(workdir, "projects.yaml");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function buildDeps() {
  const { BunTmuxGateway } = require("../adapters/tmux");
  const { BunGitGateway } = require("../adapters/git");
  const { BunDockerGateway } = require("../adapters/docker");
  const { BunPortProbe } = require("../adapters/port-probe");
  const { BunLifecycleHookRunner } = require("../adapters/hooks");
  const { AutoNameService } = require("../services/auto-name-service");
  const { NotificationService } = require("../services/notification-service");
  return {
    registryPath,
    port: 9999,
    git: new BunGitGateway(),
    tmux: new BunTmuxGateway(),
    docker: new BunDockerGateway(),
    portProbe: new BunPortProbe(),
    hooks: new BunLifecycleHookRunner(),
    autoName: new AutoNameService(),
    runtimeNotifications: new NotificationService(),
  };
}

describe("ProjectRegistry", () => {
  test("starts empty when no yaml exists", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    expect(reg.list()).toEqual([]);
  });

  test("add() registers a project, returns ProjectInfo, persists yaml", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();

    const dir = makeProjectDir("alpha");
    const info = await reg.add({ path: dir });

    expect(info.path).toBe(dir);
    expect(info.id).toMatch(/^[0-9a-f]{8}$/);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get(info.id)?.projectDir).toBe(dir);

    expect(existsSync(registryPath)).toBe(true);
    const yaml = readFileSync(registryPath, "utf-8");
    expect(yaml).toContain(dir);
  });

  test("add() rejects path that doesn't exist", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    await expect(reg.add({ path: "/nonexistent/path/xyz" })).rejects.toThrow();
  });

  test("add() rejects duplicate path", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    const dir = makeProjectDir("beta");
    await reg.add({ path: dir });
    await expect(reg.add({ path: dir })).rejects.toThrow(/already registered|duplicate/i);
  });

  test("add() initializes .webmux.yaml when absent", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    const dir = makeProjectDir("gamma", false);
    const info = await reg.add({ path: dir, displayName: "Gamma", mainBranch: "develop" });
    expect(info.name).toBe("Gamma");
    expect(info.mainBranch).toBe("develop");
    expect(existsSync(join(dir, ".webmux.yaml"))).toBe(true);
  });

  test("add() reads existing .webmux.yaml and ignores body init fields", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    const dir = makeProjectDir("delta", true);
    const info = await reg.add({ path: dir, displayName: "OverrideAttempt", mainBranch: "develop" });
    expect(info.name).toBe("delta");
    expect(info.mainBranch).toBe("main");
  });

  test("remove() drops scope and persists", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    const dir = makeProjectDir("epsilon");
    const info = await reg.add({ path: dir });
    expect(reg.list()).toHaveLength(1);

    await reg.remove(info.id, { killSessions: false });
    expect(reg.list()).toHaveLength(0);
    expect(reg.get(info.id)).toBeNull();

    const yaml = readFileSync(registryPath, "utf-8");
    expect(yaml).not.toContain(info.id);
  });

  test("remove() of unknown id throws", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    await expect(reg.remove("does-not-exist", { killSessions: false })).rejects.toThrow();
  });

  test("load() reconstructs scopes from prior persistence", async () => {
    const dir = makeProjectDir("zeta");
    const id = computeProjectId(dir);
    writeFileSync(registryPath, `schemaVersion: 1\nprojects:\n  - id: ${id}\n    path: ${dir}\n    addedAt: "2026-04-27T17:00:00Z"\n`);

    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0].path).toBe(dir);
  });

  test("load() skips entries whose path no longer exists", async () => {
    writeFileSync(registryPath, `schemaVersion: 1\nprojects:\n  - id: deadbeef\n    path: /nonexistent\n    addedAt: "2026-04-27T17:00:00Z"\n`);
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    expect(reg.list()).toHaveLength(0);
  });

  test("load() tolerates corrupted yaml without crashing", async () => {
    // Malformed yaml content
    writeFileSync(registryPath, "this is not valid yaml: : :\nprojects: not-an-array");
    const reg = createProjectRegistry(buildDeps());
    await expect(reg.load()).resolves.toBeUndefined();
    expect(reg.list()).toEqual([]);
  });

  test("load() tolerates entries with missing string fields", async () => {
    writeFileSync(registryPath, `schemaVersion: 1\nprojects:\n  - {}\n  - id: 12345678\n  - {id: "abc", path: 42, addedAt: "x"}\n`);
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    expect(reg.list()).toEqual([]);
  });
});
