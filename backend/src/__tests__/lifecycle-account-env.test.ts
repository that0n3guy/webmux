import { describe, expect, test } from "bun:test";
import { withClaudeConfigDir } from "../services/lifecycle-service";

describe("withClaudeConfigDir", () => {
  const base = { WEBMUX_WORKTREE_PATH: "/wt" };
  test("adds CLAUDE_CONFIG_DIR when a dir is resolved", () => {
    expect(withClaudeConfigDir(base, "/home/u/.claude-work")).toEqual({
      WEBMUX_WORKTREE_PATH: "/wt",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-work",
    });
  });
  test("leaves env untouched when no dir", () => {
    expect(withClaudeConfigDir(base, undefined)).toEqual(base);
  });
});
