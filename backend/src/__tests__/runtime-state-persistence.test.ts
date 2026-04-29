import { describe, expect, it } from "bun:test";
import type { AgentRuntimeState, WorktreeRuntimeStatePersisted } from "../domain/model";
import { createRuntimeStatePersistence } from "../services/runtime-state-persistence";

function makeAgentState(lifecycle: AgentRuntimeState["lifecycle"] = "idle"): AgentRuntimeState {
  return {
    runtime: "host",
    lifecycle,
    lastStartedAt: "2026-04-28T10:00:00.000Z",
    lastEventAt: "2026-04-28T10:01:00.000Z",
    lastError: null,
  };
}

describe("createRuntimeStatePersistence", () => {
  it("calls writeRuntimeState after debounce delay", async () => {
    const written: Array<{ gitDir: string; state: WorktreeRuntimeStatePersisted }> = [];

    const persistence = createRuntimeStatePersistence({
      writeRuntimeState: async (gitDir, state) => {
        written.push({ gitDir, state });
      },
      debounceMs: 10,
    });

    persistence.schedule("wt_1", "/git/wt_1", makeAgentState("idle"));
    await Bun.sleep(50);

    expect(written).toHaveLength(1);
    expect(written[0]?.gitDir).toBe("/git/wt_1");
    expect(written[0]?.state.lifecycle).toBe("idle");
    expect(written[0]?.state.schemaVersion).toBe(1);
  });

  it("collapses multiple schedule calls into one write", async () => {
    const written: WorktreeRuntimeStatePersisted[] = [];

    const persistence = createRuntimeStatePersistence({
      writeRuntimeState: async (_gitDir, state) => {
        written.push(state);
      },
      debounceMs: 30,
    });

    persistence.schedule("wt_1", "/git/wt_1", makeAgentState("running"));
    persistence.schedule("wt_1", "/git/wt_1", makeAgentState("idle"));
    persistence.schedule("wt_1", "/git/wt_1", makeAgentState("stopped"));

    await Bun.sleep(80);

    expect(written).toHaveLength(1);
    expect(written[0]?.lifecycle).toBe("stopped");
  });

  it("flush writes all pending immediately without waiting for debounce", async () => {
    const written: WorktreeRuntimeStatePersisted[] = [];

    const persistence = createRuntimeStatePersistence({
      writeRuntimeState: async (_gitDir, state) => {
        written.push(state);
      },
      debounceMs: 5000,
    });

    persistence.schedule("wt_1", "/git/wt_1", makeAgentState("running"));
    persistence.schedule("wt_2", "/git/wt_2", makeAgentState("idle"));

    await persistence.flush();

    expect(written).toHaveLength(2);
  });

  it("flush awaits in-flight writes", async () => {
    let resolveWrite!: () => void;
    const writeStarted = new Promise<void>((res) => {
      resolveWrite = res;
    });
    let writeResolved = false;

    const persistence = createRuntimeStatePersistence({
      writeRuntimeState: async (_gitDir, _state) => {
        writeStarted.then(() => {});
        resolveWrite();
        await Bun.sleep(20);
        writeResolved = true;
      },
      debounceMs: 5,
    });

    persistence.schedule("wt_1", "/git/wt_1", makeAgentState("stopped"));

    await writeStarted;
    await persistence.flush();
    expect(writeResolved).toBe(true);
  });

  it("write errors do not crash — warns and continues", async () => {
    let warnCalled = false;
    const originalWarn = console.warn;
    console.warn = () => { warnCalled = true; };

    try {
      const persistence = createRuntimeStatePersistence({
        writeRuntimeState: async () => {
          throw new Error("disk full");
        },
        debounceMs: 5,
      });

      persistence.schedule("wt_1", "/git/wt_1", makeAgentState("stopped"));
      await persistence.flush();

      expect(warnCalled).toBe(true);
    } finally {
      console.warn = originalWarn;
    }
  });

  it("no-op when writeRuntimeState is not provided", async () => {
    const persistence = createRuntimeStatePersistence({ debounceMs: 5 });
    persistence.schedule("wt_1", "/git/wt_1", makeAgentState("running"));
    await persistence.flush();
  });

  it("persists correct schema fields", async () => {
    const written: WorktreeRuntimeStatePersisted[] = [];

    const persistence = createRuntimeStatePersistence({
      writeRuntimeState: async (_gitDir, state) => {
        written.push(state);
      },
      debounceMs: 5,
    });

    const agent: AgentRuntimeState = {
      runtime: "host",
      lifecycle: "error",
      lastStartedAt: "2026-04-28T09:00:00.000Z",
      lastEventAt: "2026-04-28T09:05:00.000Z",
      lastError: "crashed",
    };

    persistence.schedule("wt_1", "/git/wt_1", agent);
    await persistence.flush();

    expect(written[0]).toEqual({
      schemaVersion: 1,
      lifecycle: "error",
      lastStartedAt: "2026-04-28T09:00:00.000Z",
      lastEventAt: "2026-04-28T09:05:00.000Z",
      lastError: "crashed",
    });
  });
});
