import { describe, expect, it } from "bun:test";
import { createApi } from "./client";
import {
  OpenWorktreeRequestSchema,
  ExternalSessionNameParamsSchema,
  ProjectScopedScratchIdParamsSchema,
} from "./schemas";
import { apiPaths } from "./contract";

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

describe("ExternalSessionNameParamsSchema", () => {
  it("accepts a valid session name", () => {
    expect(ExternalSessionNameParamsSchema.safeParse({ name: "my-session" }).success).toBe(true);
  });

  it("rejects an empty name", () => {
    expect(ExternalSessionNameParamsSchema.safeParse({ name: "" }).success).toBe(false);
  });

  it("rejects missing name", () => {
    expect(ExternalSessionNameParamsSchema.safeParse({}).success).toBe(false);
  });
});

describe("ProjectScopedScratchIdParamsSchema", () => {
  it("accepts valid projectId and scratch id", () => {
    expect(ProjectScopedScratchIdParamsSchema.safeParse({ projectId: "proj1", id: "scratch-abc" }).success).toBe(true);
  });

  it("rejects missing id", () => {
    expect(ProjectScopedScratchIdParamsSchema.safeParse({ projectId: "proj1" }).success).toBe(false);
  });

  it("rejects empty id", () => {
    expect(ProjectScopedScratchIdParamsSchema.safeParse({ projectId: "proj1", id: "" }).success).toBe(false);
  });
});

describe("apiPaths — scratch + external chat routes present", () => {
  it("has scratch chat paths", () => {
    expect(apiPaths.attachAgentsScratchConversation).toBe("/api/projects/:projectId/scratch-sessions/:id/agent/attach");
    expect(apiPaths.fetchAgentsScratchConversationHistory).toBe("/api/projects/:projectId/scratch-sessions/:id/agent/history");
    expect(apiPaths.sendAgentsScratchConversationMessage).toBe("/api/projects/:projectId/scratch-sessions/:id/agent/messages");
    expect(apiPaths.interruptAgentsScratchConversation).toBe("/api/projects/:projectId/scratch-sessions/:id/agent/interrupt");
    expect(apiPaths.streamAgentsScratchConversation).toBe("/ws/projects/:projectId/scratch-sessions/:id/agent");
  });

  it("has external chat paths", () => {
    expect(apiPaths.attachAgentsExternalConversation).toBe("/api/external-sessions/:name/agent/attach");
    expect(apiPaths.fetchAgentsExternalConversationHistory).toBe("/api/external-sessions/:name/agent/history");
    expect(apiPaths.sendAgentsExternalConversationMessage).toBe("/api/external-sessions/:name/agent/messages");
    expect(apiPaths.interruptAgentsExternalConversation).toBe("/api/external-sessions/:name/agent/interrupt");
    expect(apiPaths.streamAgentsExternalConversation).toBe("/ws/external-sessions/:name/agent");
  });
});
