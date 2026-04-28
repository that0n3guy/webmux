import { describe, expect, test } from "bun:test";
import { computeProjectId, buildProjectSessionName } from "../adapters/tmux";

describe("computeProjectId", () => {
  test("returns first 8 chars of sha1 of resolved path", () => {
    const id = computeProjectId("/home/mercer/projects/webmux-test");
    expect(id).toHaveLength(8);
    expect(id).toMatch(/^[0-9a-f]{8}$/);
  });

  test("is stable for the same input", () => {
    const a = computeProjectId("/home/mercer/projects/webmux-test");
    const b = computeProjectId("/home/mercer/projects/webmux-test");
    expect(a).toBe(b);
  });

  test("different paths yield different ids", () => {
    const a = computeProjectId("/home/mercer/projects/foo");
    const b = computeProjectId("/home/mercer/projects/bar");
    expect(a).not.toBe(b);
  });

  test("matches the suffix used in buildProjectSessionName", () => {
    const path = "/home/mercer/projects/webmux-test";
    const id = computeProjectId(path);
    const sessionName = buildProjectSessionName(path);
    expect(sessionName.endsWith(id)).toBe(true);
  });
});
