import { describe, expect, it } from "bun:test";
import { NotificationService } from "../services/notification-service";

async function readChunk(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const chunk = await reader.read();
  expect(chunk.done).toBe(false);
  return new TextDecoder().decode(chunk.value);
}

describe("NotificationService", () => {
  it("creates notifications only for user-visible runtime events", () => {
    const notifications = new NotificationService();

    const started = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_status_changed", lifecycle: "running" },
    );
    const stopped = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_stopped" },
    );

    expect(started).toBeNull();
    expect(stopped?.type).toBe("agent_stopped");
    expect(notifications.list()).toHaveLength(1);
  });

  it("emits agent_needs_attention for idle via permission_prompt but not for ordinary idles", () => {
    const notifications = new NotificationService();

    const wedged = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_status_changed", lifecycle: "idle", reason: "permission_prompt" },
    );
    const ordinaryIdle = notifications.recordEvent(
      { worktreeId: "wt_other", branch: "feature/other", type: "agent_status_changed", lifecycle: "idle" },
    );

    expect(wedged?.type).toBe("agent_needs_attention");
    expect(wedged?.message).toContain("feature/search");
    expect(wedged?.message).toContain("permission prompt");
    expect(ordinaryIdle).toBeNull();
    expect(notifications.list()).toHaveLength(1);
  });

  it("debounces repeated agent_needs_attention per branch until the window expires", async () => {
    const notifications = new NotificationService(50, 30_000, 20);
    const event = {
      worktreeId: "wt_search",
      branch: "feature/search",
      type: "agent_status_changed",
      lifecycle: "idle",
      reason: "permission_prompt",
    } as const;

    expect(notifications.recordEvent(event, "proj_a")?.type).toBe("agent_needs_attention");
    expect(notifications.recordEvent(event, "proj_a")).toBeNull();
    expect(notifications.recordEvent(
      { ...event, worktreeId: "wt_other", branch: "feature/other" },
      "proj_a",
    )?.type).toBe("agent_needs_attention");

    await Bun.sleep(25);
    expect(notifications.recordEvent(event, "proj_a")?.type).toBe("agent_needs_attention");
  });

  it("stores pr_opened and runtime_error notifications with details", () => {
    const notifications = new NotificationService();

    const pr = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "pr_opened", url: "https://github.com/org/repo/pull/123" },
    );
    const error = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "runtime_error", message: "agent crashed" },
    );

    expect(pr?.url).toBe("https://github.com/org/repo/pull/123");
    expect(error?.message).toContain("agent crashed");
    expect(notifications.list()).toHaveLength(2);
  });

  it("persists projectId on notify when provided", () => {
    const notifications = new NotificationService();

    const tagged = notifications.notify({
      branch: "feature/search",
      type: "agent_stopped",
      message: "Agent stopped",
      projectId: "proj_abc",
    });
    const untagged = notifications.notify({
      branch: "feature/other",
      type: "agent_stopped",
      message: "Agent stopped",
    });

    expect(tagged.projectId).toBe("proj_abc");
    expect(untagged.projectId).toBeUndefined();
  });

  it("threads projectId through recordEvent", () => {
    const notifications = new NotificationService();

    const result = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_stopped" },
      "proj_xyz",
    );

    expect(result?.projectId).toBe("proj_xyz");
  });

  it("dismisses notifications by id", () => {
    const notifications = new NotificationService();
    const item = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_stopped" },
    );

    expect(item).not.toBeNull();
    expect(notifications.dismiss(item!.id)).toBe(true);
    expect(notifications.list()).toHaveLength(0);
  });

  it("streams initial notifications and broadcasts live updates", async () => {
    const notifications = new NotificationService();
    const initial = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "agent_stopped" },
    );

    const response = notifications.stream();
    const reader = response.body!.getReader();

    const initialChunk = await readChunk(reader);
    expect(initialChunk).toContain("event: initial");
    expect(initialChunk).toContain(`\"id\":${initial!.id}`);

    const liveChunkPromise = readChunk(reader);
    const live = notifications.recordEvent(
      { worktreeId: "wt_search", branch: "feature/search", type: "pr_opened", url: "https://github.com/org/repo/pull/123" },
    );
    const liveChunk = await liveChunkPromise;
    expect(liveChunk).toContain("event: notification");
    expect(liveChunk).toContain(`\"id\":${live!.id}`);

    const dismissChunkPromise = readChunk(reader);
    expect(notifications.dismiss(live!.id)).toBe(true);
    const dismissChunk = await dismissChunkPromise;
    expect(dismissChunk).toContain("event: dismiss");
    expect(dismissChunk).toContain(`\"id\":${live!.id}`);

    await reader.cancel();
  });

  it("emits SSE keepalive comments so idle connections stay open", async () => {
    const notifications = new NotificationService(50, 10);

    const response = notifications.stream();
    const reader = response.body!.getReader();

    const keepaliveChunk = await readChunk(reader);
    expect(keepaliveChunk).toBe(": keepalive\n\n");

    await reader.cancel();
  });
});
