import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { expandTemplate, getDefaultProfileName, loadConfig, persistLocalCustomAgent, removeLocalCustomAgent } from "../adapters/config";
import type { UserPreferences } from "../adapters/preferences";

describe("expandTemplate", () => {
  it("replaces known placeholders", () => {
    expect(expandTemplate("Hello ${NAME}", { NAME: "world" })).toBe("Hello world");
  });

  it("leaves unknown placeholders as empty string", () => {
    expect(expandTemplate("Hello ${MISSING}", {})).toBe("Hello ");
  });

  it("replaces multiple placeholders in one string", () => {
    expect(expandTemplate("${A}-${B}", { A: "foo", B: "bar" })).toBe("foo-bar");
  });

  it("returns the string unchanged when there are no placeholders", () => {
    expect(expandTemplate("no placeholders", {})).toBe("no placeholders");
  });
});

describe("loadConfig", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it("loads the final .webmux.yaml shape into ProjectConfig", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.yaml"),
      [
        "name: Example",
        "workspace:",
        "  mainBranch: trunk",
        "  worktreeRoot: worktrees",
        "  defaultAgent: codex",
        "services:",
        "  - name: API",
        "    portEnv: API_PORT",
        "    portStart: 4100",
        "profiles:",
        "  default:",
        "    runtime: host",
        "    yolo: true",
        "    envPassthrough: [GITHUB_TOKEN]",
        "    panes:",
        "      - id: agent",
        "        kind: agent",
        "        focus: true",
        "  sandbox:",
        "    runtime: docker",
        "    yolo: false",
        "    image: webmux-sandbox",
        "    envPassthrough: [AWS_ACCESS_KEY_ID]",
        "    panes:",
        "      - id: agent",
        "        kind: agent",
        "        focus: true",
        "startupEnvs:",
        "  FEATURE_FLAG: true",
        "lifecycleHooks:",
        "  postCreate: scripts/post-create.sh",
        "  preRemove: scripts/pre-remove.sh",
        "auto_name:",
        "  provider: claude",
        "  system_prompt: Generate a branch name",
        "integrations:",
        "  github:",
        "    linkedRepos:",
        "      - repo: acme/linked",
        "        alias: linked",
        "  linear:",
        "    enabled: false",
        "    createTicketOption: true",
        "    teamId: team-123",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);

    expect(config.name).toBe("Example");
    expect(config.workspace.mainBranch).toBe("trunk");
    expect(config.workspace.worktreeRoot).toBe("worktrees");
    expect(config.workspace.defaultAgent).toBe("codex");
    expect(config.services).toEqual([{ name: "API", portEnv: "API_PORT", portStart: 4100 }]);
    expect(config.profiles.default.runtime).toBe("host");
    expect(config.profiles.default.yolo).toBe(true);
    expect(config.profiles.default.envPassthrough).toEqual(["GITHUB_TOKEN"]);
    expect(config.profiles.sandbox?.runtime).toBe("docker");
    expect(config.profiles.sandbox?.yolo).toBeUndefined();
    expect(config.profiles.sandbox?.image).toBe("webmux-sandbox");
    expect(config.startupEnvs).toEqual({ FEATURE_FLAG: true });
    expect(config.lifecycleHooks).toEqual({
      postCreate: "scripts/post-create.sh",
      preRemove: "scripts/pre-remove.sh",
    });
    expect(config.autoName).toEqual({
      provider: "claude",
      systemPrompt: "Generate a branch name",
    });
    expect(config.integrations.github.linkedRepos).toEqual([{ repo: "acme/linked", alias: "linked" }]);
    expect(config.integrations.linear.enabled).toBe(false);
    expect(config.integrations.linear.createTicketOption).toBe(true);
    expect(config.integrations.linear.teamId).toBe("team-123");
  });

  it("uses the first configured profile when no default profile exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.yaml"),
      [
        "profiles:",
        "  slim:",
        "    runtime: host",
        "    envPassthrough: []",
        "    panes:",
        "      - id: agent",
        "        kind: agent",
        "        focus: true",
        "  full:",
        "    runtime: host",
        "    envPassthrough: []",
        "    panes:",
        "      - id: agent",
        "        kind: agent",
        "        focus: true",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);

    expect(getDefaultProfileName(config)).toBe("slim");
  });

  it("preserves command pane workingDir values from config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.yaml"),
      [
        "profiles:",
        "  default:",
        "    runtime: host",
        "    envPassthrough: []",
        "    panes:",
        "      - id: app",
        "        kind: command",
        "        cwd: repo",
        "        workingDir: frontend",
        "        command: bun run dev",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);

    expect(config.profiles.default.panes).toEqual([
      {
        id: "app",
        kind: "command",
        cwd: "repo",
        workingDir: "frontend",
        command: "bun run dev",
      },
    ]);
  });

  it("defaults Linear ticket creation option to false", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.yaml"),
      [
        "integrations:",
        "  linear:",
        "    enabled: true",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);

    expect(config.integrations.linear.enabled).toBe(true);
    expect(config.integrations.linear.createTicketOption).toBe(false);
    expect(config.integrations.linear.teamId).toBeUndefined();
  });

  it("adds local profiles and appends local lifecycle hooks after project hooks", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.yaml"),
      [
        "profiles:",
        "  default:",
        "    runtime: host",
        "    envPassthrough: []",
        "    panes:",
        "      - id: agent",
        "        kind: agent",
        "        focus: true",
        "  shared:",
        "    runtime: host",
        "    envPassthrough: [GITHUB_TOKEN]",
        "    panes:",
        "      - id: agent",
        "        kind: agent",
        "        focus: true",
        "lifecycleHooks:",
        "  postCreate: scripts/project-post-create.sh",
        "  preRemove: scripts/project-pre-remove.sh",
        "",
      ].join("\n"),
    );

    await Bun.write(
      join(dir, ".webmux.local.yaml"),
      [
        "profiles:",
        "  shared:",
        "    runtime: docker",
        "    image: local-sandbox",
        "    envPassthrough: [AWS_ACCESS_KEY_ID]",
        "    panes:",
        "      - id: agent",
        "        kind: agent",
        "        focus: true",
        "  local:",
        "    runtime: host",
        "    envPassthrough: []",
        "    panes:",
        "      - id: local-agent",
        "        kind: agent",
        "        focus: true",
        "lifecycleHooks:",
        "  postCreate: scripts/local-post-create.sh",
        "  preRemove: scripts/local-pre-remove.sh",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);

    expect(Object.keys(config.profiles).sort()).toEqual(["default", "local", "shared"]);
    expect(config.profiles.default.runtime).toBe("host");
    expect(config.profiles.shared.runtime).toBe("docker");
    expect(config.profiles.shared.image).toBe("local-sandbox");
    expect(config.profiles.shared.envPassthrough).toEqual(["AWS_ACCESS_KEY_ID"]);
    expect(config.profiles.local.panes).toEqual([{ id: "local-agent", kind: "agent", focus: true }]);
    expect(config.lifecycleHooks).toEqual({
      postCreate: [
        "set -e",
        "scripts/project-post-create.sh",
        "scripts/local-post-create.sh",
      ].join("\n"),
      preRemove: [
        "set -e",
        "scripts/project-pre-remove.sh",
        "scripts/local-pre-remove.sh",
      ].join("\n"),
    });
  });

  it("loads local profiles without a project config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.local.yaml"),
      [
        "profiles:",
        "  local:",
        "    runtime: docker",
        "    image: local-image",
        "    envPassthrough: [OPENAI_API_KEY]",
        "    panes:",
        "      - id: local-agent",
        "        kind: agent",
        "        focus: true",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);

    expect(config.name).toBe(basename(dir));
    expect(Object.keys(config.profiles).sort()).toEqual(["default", "local"]);
    expect(config.profiles.local.runtime).toBe("docker");
    expect(config.profiles.local.image).toBe("local-image");
    expect(config.profiles.local.envPassthrough).toEqual(["OPENAI_API_KEY"]);
    expect(config.lifecycleHooks).toEqual({});

    config.profiles.default.envPassthrough.push("MUTATED");
    expect(loadConfig(dir).profiles.default.envPassthrough).toEqual([]);
  });

  it("loads custom agents from local yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.local.yaml"),
      [
        "agents:",
        "  gemini:",
        "    label: Gemini CLI",
        "    startCommand: gemini --project . --prompt \"${PROMPT}\"",
        "    resumeCommand: gemini resume --last",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);

    expect(config.agents).toEqual({
      gemini: {
        label: "Gemini CLI",
        startCommand: 'gemini --project . --prompt "${PROMPT}"',
        resumeCommand: "gemini resume --last",
      },
    });
  });

  it("persists and removes local custom agents", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await persistLocalCustomAgent(dir, "gemini", {
      label: "Gemini CLI",
      startCommand: 'gemini --project . --prompt "${PROMPT}"',
      resumeCommand: "gemini resume --last",
    });

    let config = loadConfig(dir);
    expect(config.agents).toEqual({
      gemini: {
        label: "Gemini CLI",
        startCommand: 'gemini --project . --prompt "${PROMPT}"',
        resumeCommand: "gemini resume --last",
      },
    });

    await removeLocalCustomAgent(dir, "gemini");

    config = loadConfig(dir);
    expect(config.agents).toEqual({});
  });

  it("overrides worktreeRoot from local yaml", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.yaml"),
      [
        "workspace:",
        "  worktreeRoot: ../worktrees",
        "",
      ].join("\n"),
    );

    await Bun.write(
      join(dir, ".webmux.local.yaml"),
      [
        "workspace:",
        "  worktreeRoot: /tmp/my-worktrees",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);

    expect(config.workspace.worktreeRoot).toBe("/tmp/my-worktrees");
    expect(config.workspace.mainBranch).toBe("main");
  });

  it("merges hook-only local overlays and fails fast before running the local hook", async () => {
    const dir = await mkdtemp(join(tmpdir(), "webmux-config-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });

    await Bun.write(
      join(dir, ".webmux.yaml"),
      [
        "lifecycleHooks:",
        "  postCreate: |",
        "    printf 'project-start\\n' >> trace.log",
        "    false",
        "    printf 'project-after-fail\\n' >> trace.log",
        "",
      ].join("\n"),
    );

    await Bun.write(
      join(dir, ".webmux.local.yaml"),
      [
        "lifecycleHooks:",
        "  postCreate: |",
        "    printf 'local-ran\\n' >> trace.log",
        "",
      ].join("\n"),
    );

    const config = loadConfig(dir);
    const command = config.lifecycleHooks.postCreate;

    expect(Object.keys(config.profiles)).toEqual(["default"]);
    expect(command).toBe([
      "set -e",
      "printf 'project-start\\n' >> trace.log\nfalse\nprintf 'project-after-fail\\n' >> trace.log",
      "printf 'local-ran\\n' >> trace.log",
    ].join("\n"));

    const result = Bun.spawnSync(["bash", "-c", command ?? ""], {
      cwd: dir,
      stdout: "pipe",
      stderr: "pipe",
    });

    expect(result.exitCode).toBe(1);
    expect(await Bun.file(join(dir, "trace.log")).text()).toBe("project-start\n");
  });
});

describe("loadConfig with user-global preferences", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function makeGitDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "webmux-prefs-"));
    tempDirs.push(dir);
    Bun.spawnSync(["git", "init"], { cwd: dir });
    return dir;
  }

  it("no prefs option behaves identically to before (case 1)", async () => {
    const dir = await makeGitDir();
    await Bun.write(join(dir, ".webmux.yaml"), "name: Test\nworkspace:\n  defaultAgent: codex\n");
    const config = loadConfig(dir);
    expect(config.workspace.defaultAgent).toBe("codex");
    expect(config.agents).toEqual({});
    expect(config.autoName).toBeNull();
  });

  it("preferences.defaultAgent: codex applies when yaml omits defaultAgent (case 2)", async () => {
    const dir = await makeGitDir();
    await Bun.write(join(dir, ".webmux.yaml"), "name: Test\n");
    const prefs: UserPreferences = { schemaVersion: 1, defaultAgent: "codex" };
    const config = loadConfig(dir, { preferences: prefs });
    expect(config.workspace.defaultAgent).toBe("codex");
  });

  it("project yaml defaultAgent wins over preferences (case 3)", async () => {
    const dir = await makeGitDir();
    await Bun.write(join(dir, ".webmux.yaml"), "name: Test\nworkspace:\n  defaultAgent: claude\n");
    const prefs: UserPreferences = { schemaVersion: 1, defaultAgent: "codex" };
    const config = loadConfig(dir, { preferences: prefs });
    expect(config.workspace.defaultAgent).toBe("claude");
  });

  it("preferences.agents appear when yaml has no agents (case 4)", async () => {
    const dir = await makeGitDir();
    await Bun.write(join(dir, ".webmux.yaml"), "name: Test\n");
    const prefs: UserPreferences = {
      schemaVersion: 1,
      agents: { gemini: { label: "Gemini Global", startCommand: "gemini start" } },
    };
    const config = loadConfig(dir, { preferences: prefs });
    expect(config.agents.gemini).toEqual({ label: "Gemini Global", startCommand: "gemini start" });
  });

  it("local overlay agents override global agents by id (case 5)", async () => {
    const dir = await makeGitDir();
    await Bun.write(join(dir, ".webmux.yaml"), "name: Test\n");
    await Bun.write(
      join(dir, ".webmux.local.yaml"),
      [
        "agents:",
        "  gemini:",
        "    label: Gemini Local",
        "    startCommand: gemini local",
        "",
      ].join("\n"),
    );
    const prefs: UserPreferences = {
      schemaVersion: 1,
      agents: { gemini: { label: "Gemini Global", startCommand: "gemini global" } },
    };
    const config = loadConfig(dir, { preferences: prefs });
    expect(config.agents.gemini?.label).toBe("Gemini Local");
  });

  it("preferences.autoName applies when yaml has no auto_name (case 6)", async () => {
    const dir = await makeGitDir();
    await Bun.write(join(dir, ".webmux.yaml"), "name: Test\n");
    const prefs: UserPreferences = { schemaVersion: 1, autoName: { model: "claude-3-haiku" } };
    const config = loadConfig(dir, { preferences: prefs });
    expect(config.autoName).toEqual({ provider: "claude", model: "claude-3-haiku" });
  });

  it("project yaml auto_name model wins over preferences model (case 7)", async () => {
    const dir = await makeGitDir();
    await Bun.write(
      join(dir, ".webmux.yaml"),
      "name: Test\nauto_name:\n  provider: claude\n  model: project-model\n",
    );
    const prefs: UserPreferences = { schemaVersion: 1, autoName: { model: "global-model" } };
    const config = loadConfig(dir, { preferences: prefs });
    expect(config.autoName?.model).toBe("project-model");
  });

  it("field-level merge: project model wins, global systemPrompt fills gap (case 8)", async () => {
    const dir = await makeGitDir();
    await Bun.write(
      join(dir, ".webmux.yaml"),
      "name: Test\nauto_name:\n  provider: claude\n  model: project-model\n",
    );
    const prefs: UserPreferences = { schemaVersion: 1, autoName: { systemPrompt: "global-prompt" } };
    const config = loadConfig(dir, { preferences: prefs });
    expect(config.autoName?.model).toBe("project-model");
    expect(config.autoName?.systemPrompt).toBe("global-prompt");
  });
});
