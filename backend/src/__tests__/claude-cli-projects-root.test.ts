import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveClaudeProjectsRoot } from "../adapters/claude-cli";

const HOME = Bun.env.HOME ?? "/home/test";

describe("resolveClaudeProjectsRoot", () => {
  test("uses account configDir/projects when given", () => {
    expect(resolveClaudeProjectsRoot("/home/u/.claude-work")).toBe(
      join("/home/u/.claude-work", "projects"),
    );
  });
  test("falls back to $HOME/.claude/projects", () => {
    expect(resolveClaudeProjectsRoot(undefined)).toBe(join(HOME, ".claude", "projects"));
  });
});
