import { describe, expect, test } from "bun:test";
import { listExternalSessions } from "../services/external-tmux-service";
import type { TmuxSessionSummary } from "../adapters/tmux";

const sessions: TmuxSessionSummary[] = [
  { name: "mcpsaa",                    windowCount: 1, attached: true,  group: null },
  { name: "codex-review",              windowCount: 1, attached: false, group: null },
  { name: "wm-webmux-test-f01fb94b",   windowCount: 2, attached: false, group: "wm-webmux-test-f01fb94b" },
  { name: "wm-dash-3100-7",            windowCount: 2, attached: true,  group: "wm-webmux-test-f01fb94b" },
  { name: "wm-scratch-abc",            windowCount: 1, attached: false, group: null },
  { name: "wm-native-3100-1",          windowCount: 1, attached: false, group: null },
];

describe("listExternalSessions", () => {
  test("excludes wm-* prefixed sessions", () => {
    const result = listExternalSessions(sessions);
    expect(result.map((s) => s.name)).toEqual(["mcpsaa", "codex-review"]);
  });

  test("returns shape with name/windowCount/attached only", () => {
    const result = listExternalSessions(sessions);
    expect(result[0]).toEqual({ name: "mcpsaa", windowCount: 1, attached: true });
  });

  test("empty input returns empty array", () => {
    expect(listExternalSessions([])).toEqual([]);
  });
});
