import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createUserPreferencesGateway,
  emptyUserPreferences,
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
});
