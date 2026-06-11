import { describe, expect, test } from "bun:test";
import { expandHome, resolveAccountConfigDir } from "../lib/account-config";
import type { UserPreferences } from "../adapters/preferences";

const HOME = Bun.env.HOME ?? "/home/test";

describe("expandHome", () => {
  test("expands leading ~ and $HOME to absolute", () => {
    expect(expandHome("~/.claude-work")).toBe(`${HOME}/.claude-work`);
    expect(expandHome("~")).toBe(HOME);
    expect(expandHome("$HOME/.claude")).toBe(`${HOME}/.claude`);
  });
  test("leaves absolute paths untouched", () => {
    expect(expandHome("/srv/.claude")).toBe("/srv/.claude");
  });
});

describe("resolveAccountConfigDir", () => {
  const prefs: UserPreferences = {
    schemaVersion: 1,
    accounts: { work: { configDir: "~/.claude-work" } },
  };
  test("returns absolute dir for a known account", () => {
    expect(resolveAccountConfigDir(prefs, "work")).toBe(`${HOME}/.claude-work`);
  });
  test("returns undefined for no account name", () => {
    expect(resolveAccountConfigDir(prefs, undefined)).toBeUndefined();
  });
  test("returns undefined for an unknown account", () => {
    expect(resolveAccountConfigDir(prefs, "ghost")).toBeUndefined();
  });
});
