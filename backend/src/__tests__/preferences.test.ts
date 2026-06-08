import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUserPreferencesGateway,
  emptyUserPreferences,
  applyPreferencesUpdate,
  type UserPreferences,
} from "../adapters/preferences";

let workdir: string;
let prefsPath: string;

beforeEach(() => {
  workdir = mkdtempSync(`${tmpdir()}/wm-prefs-`);
  prefsPath = join(workdir, "prefs.yaml");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

describe("UserPreferencesGateway", () => {
  test("load() on missing file returns empty preferences", async () => {
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();
    expect(prefs).toEqual({ schemaVersion: 1 });
  });

  test("load() on empty file returns empty preferences", async () => {
    writeFileSync(prefsPath, "");
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();
    expect(prefs).toEqual({ schemaVersion: 1 });
  });

  test("load() on whitespace-only file returns empty preferences", async () => {
    writeFileSync(prefsPath, "   \n  \n");
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();
    expect(prefs).toEqual({ schemaVersion: 1 });
  });

  test("load() on unparseable yaml returns empty preferences without throwing", async () => {
    writeFileSync(prefsPath, "{ this is: [not valid yaml: at all");
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();
    expect(prefs).toEqual({ schemaVersion: 1 });
  });

  test("load() on valid file with all fields round-trips correctly", async () => {
    const yaml = `
schemaVersion: 1
defaultAgent: my-agent
agents:
  my-agent:
    label: My Agent
    startCommand: my-agent start
    resumeCommand: my-agent resume
autoName:
  model: claude-3-5-sonnet
  systemPrompt: Name this branch concisely
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.schemaVersion).toBe(1);
    expect(prefs.defaultAgent).toBe("my-agent");
    expect(prefs.agents?.["my-agent"]).toEqual({
      label: "My Agent",
      startCommand: "my-agent start",
      resumeCommand: "my-agent resume",
    });
    expect(prefs.autoName).toEqual({
      model: "claude-3-5-sonnet",
      systemPrompt: "Name this branch concisely",
    });
  });

  test("load() skips malformed agent entries and keeps valid ones", async () => {
    const yaml = `
schemaVersion: 1
agents:
  good-agent:
    label: Good Agent
    startCommand: good start
  bad-agent:
    label: Bad Agent
  another-bad:
    startCommand: no label here
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.agents).toBeDefined();
    expect(Object.keys(prefs.agents!)).toEqual(["good-agent"]);
    expect(prefs.agents!["good-agent"]).toEqual({
      label: "Good Agent",
      startCommand: "good start",
    });
  });

  test("save() then load() round-trips full preferences", async () => {
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const input: UserPreferences = {
      schemaVersion: 1,
      defaultAgent: "codex",
      agents: {
        "codex": {
          label: "Codex",
          startCommand: "codex start",
          resumeCommand: "codex resume",
        },
      },
      autoName: {
        model: "gpt-4o",
        systemPrompt: "Short and descriptive",
      },
    };

    await gw.save(input);
    const loaded = await gw.load();

    expect(loaded).toEqual(input);
  });

  test("save() creates parent directory if it doesn't exist", async () => {
    const deepPath = join(workdir, "nested", "deep", "prefs.yaml");
    const gw = createUserPreferencesGateway({ path: deepPath });
    await gw.save(emptyUserPreferences());
    expect(existsSync(deepPath)).toBe(true);
  });

  test("save() omits empty agents and empty autoName", async () => {
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const input: UserPreferences = {
      schemaVersion: 1,
      defaultAgent: "claude",
      agents: {},
      autoName: {} as UserPreferences["autoName"],
    };

    await gw.save(input);
    const loaded = await gw.load();

    expect(loaded.agents).toBeUndefined();
    expect(loaded.autoName).toBeUndefined();
    expect(loaded.defaultAgent).toBe("claude");
  });

  test("save() of emptyUserPreferences() writes only schemaVersion", async () => {
    const gw = createUserPreferencesGateway({ path: prefsPath });
    await gw.save(emptyUserPreferences());
    const loaded = await gw.load();

    expect(loaded).toEqual({ schemaVersion: 1 });
    expect(loaded.defaultAgent).toBeUndefined();
    expect(loaded.agents).toBeUndefined();
    expect(loaded.autoName).toBeUndefined();
  });

  test("path() returns the resolved file path", () => {
    const gw = createUserPreferencesGateway({ path: prefsPath });
    expect(gw.path()).toBe(prefsPath);
  });

  test("load() with no-provider autoName still parses model and systemPrompt", async () => {
    const yaml = `
schemaVersion: 1
autoName:
  model: claude-opus-4
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.autoName).toEqual({ model: "claude-opus-4" });
  });

  test("load() omits autoName when both model and systemPrompt are absent", async () => {
    const yaml = `
schemaVersion: 1
autoName:
  irrelevantKey: value
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.autoName).toBeUndefined();
  });

  test("load() omits agents field entirely when all entries are malformed", async () => {
    const yaml = `
schemaVersion: 1
agents:
  bad1:
    label: Missing startCommand
  bad2:
    startCommand: Missing label
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.agents).toBeUndefined();
  });

  test("load() tolerates non-record top-level value (e.g. a plain string)", async () => {
    writeFileSync(prefsPath, "just a string\n");
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();
    expect(prefs).toEqual({ schemaVersion: 1 });
  });

  test("load() parses a valid sidebar block round-trip", async () => {
    const yaml = `
schemaVersion: 1
sidebar:
  mode: active
  itemOrder:
    - worktree:proj1:main
    - scratch:proj1:abc
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.sidebar).toEqual({
      mode: "active",
      itemOrder: ["worktree:proj1:main", "scratch:proj1:abc"],
    });
  });

  test("load() drops unknown sidebar.mode but keeps valid itemOrder", async () => {
    const yaml = `
schemaVersion: 1
sidebar:
  mode: weird
  itemOrder:
    - external:my-session
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.sidebar).toBeDefined();
    expect(prefs.sidebar!.mode).toBeUndefined();
    expect(prefs.sidebar!.itemOrder).toEqual(["external:my-session"]);
  });

  test("load() drops non-array sidebar.itemOrder but keeps valid mode", async () => {
    const yaml = `
schemaVersion: 1
sidebar:
  mode: projects
  itemOrder: not-an-array
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.sidebar).toBeDefined();
    expect(prefs.sidebar!.mode).toBe("projects");
    expect(prefs.sidebar!.itemOrder).toBeUndefined();
  });

  test("load() omits sidebar entirely when sidebar value is not a record", async () => {
    const yaml = `
schemaVersion: 1
sidebar: wrong
`.trim();
    writeFileSync(prefsPath, yaml);
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const prefs = await gw.load();

    expect(prefs.sidebar).toBeUndefined();
  });

  test("save() then load() round-trips preferences with sidebar set", async () => {
    const gw = createUserPreferencesGateway({ path: prefsPath });
    const input: UserPreferences = {
      schemaVersion: 1,
      defaultAgent: "claude",
      sidebar: {
        mode: "active",
        itemOrder: ["worktree:p1:feat", "external:tmux1"],
      },
    };

    await gw.save(input);
    const loaded = await gw.load();

    expect(loaded).toEqual(input);
  });
});

// ---------------------------------------------------------------------------
// applyPreferencesUpdate — sidebar field
// ---------------------------------------------------------------------------

describe("applyPreferencesUpdate sidebar semantics", () => {
  test("setting only sidebar preserves existing defaultAgent and autoName", () => {
    const current: UserPreferences = {
      schemaVersion: 1,
      defaultAgent: "codex",
      autoName: { model: "claude-opus-4" },
    };
    const result = applyPreferencesUpdate(current, {
      sidebar: { mode: "active", itemOrder: ["worktree:p1:main"] },
    });
    expect(result.defaultAgent).toBe("codex");
    expect(result.autoName).toEqual({ model: "claude-opus-4" });
    expect(result.sidebar).toEqual({ mode: "active", itemOrder: ["worktree:p1:main"] });
  });

  test("setting only defaultAgent after sidebar was set preserves sidebar", () => {
    const current: UserPreferences = {
      schemaVersion: 1,
      sidebar: { mode: "active", itemOrder: ["worktree:p1:main"] },
    };
    const result = applyPreferencesUpdate(current, { defaultAgent: "claude" });
    expect(result.defaultAgent).toBe("claude");
    expect(result.sidebar).toEqual({ mode: "active", itemOrder: ["worktree:p1:main"] });
  });
});
