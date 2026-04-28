import { describe, expect, it } from "bun:test";
import { createApi } from "./client";
import { OpenWorktreeRequestSchema } from "./schemas";

function success(body: unknown): { status: number; body: unknown; headers: Headers } {
  return {
    status: 200,
    body,
    headers: new Headers(),
  };
}

describe("createApi", () => {
  it("encodes slash-containing path params before ts-rest interpolates them", async () => {
    const paths: string[] = [];
    const api = createApi("https://example.com", {
      api: async ({ path }) => {
        paths.push(path);
        return success({ ok: true });
      },
    });

    await api.sendWorktreePrompt({
      params: { projectId: "proj1", name: "feature/search" },
      body: { text: "Fix the failing tests" },
    });

    expect(paths).toEqual(["https://example.com/api/projects/proj1/worktrees/feature%2Fsearch/send"]);
  });

  it("preserves numeric path params for notification and CI routes", async () => {
    const paths: string[] = [];
    const api = createApi("https://example.com", {
      api: async ({ path }) => {
        paths.push(path);
        if (path.endsWith("/dismiss")) {
          return success({ ok: true });
        }
        return success({ logs: "" });
      },
    });

    await api.dismissNotification({ params: { projectId: "proj1", id: 42 } });
    await api.fetchCiLogs({ params: { projectId: "proj1", runId: 317 } });

    expect(paths).toEqual([
      "https://example.com/api/projects/proj1/notifications/42/dismiss",
      "https://example.com/api/projects/proj1/ci-logs/317",
    ]);
  });

  it("throws API error messages from json error bodies", async () => {
    const api = createApi("https://example.com", {
      api: async () => ({
        status: 404,
        body: { error: "Not found" },
        headers: new Headers(),
      }),
    });

    await expect(api.dismissNotification({ params: { projectId: "proj1", id: 7 } })).rejects.toThrow("Not found");
  });

  it("throws API error messages from stringified json error bodies", async () => {
    const api = createApi("https://example.com", {
      api: async () => ({
        status: 502,
        body: JSON.stringify({ error: "Gateway unavailable" }),
        headers: new Headers(),
      }),
    });

    await expect(api.fetchCiLogs({ params: { projectId: "proj1", runId: 99 } })).rejects.toThrow("Gateway unavailable");
  });
});

describe("OpenWorktreeRequestSchema", () => {
  it("accepts an empty object (no overrides)", () => {
    expect(OpenWorktreeRequestSchema.safeParse({}).success).toBe(true);
  });

  it("accepts agentOverride only", () => {
    expect(OpenWorktreeRequestSchema.safeParse({ agentOverride: "gemini" }).success).toBe(true);
  });

  it("accepts shellOnly only", () => {
    expect(OpenWorktreeRequestSchema.safeParse({ shellOnly: true }).success).toBe(true);
  });

  it("accepts both agentOverride and shellOnly", () => {
    expect(OpenWorktreeRequestSchema.safeParse({ agentOverride: "gemini", shellOnly: true }).success).toBe(true);
  });

  it("rejects an empty agentOverride string", () => {
    expect(OpenWorktreeRequestSchema.safeParse({ agentOverride: "" }).success).toBe(false);
  });
});
