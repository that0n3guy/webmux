import { describe, expect, it } from "bun:test";
import type { TmuxGateway } from "../adapters/tmux";
import {
  computeRunning,
  extractStatusWord,
  probeSessionActivity,
} from "../services/session-activity-service";

class FakeTmuxGateway {
  readonly capturePaneCalls: Array<{ target: string; lines: number }> = [];
  readonly lastActivityCalls: string[] = [];
  capturedLines: string[] = [];
  lastActivityAt: string | null = null;

  capturePane(target: string, lines: number): string[] {
    this.capturePaneCalls.push({ target, lines });
    return this.capturedLines;
  }

  getPaneLastActivity(target: string): { lastActivityAt: string | null } {
    this.lastActivityCalls.push(target);
    return { lastActivityAt: this.lastActivityAt };
  }

  // Unused TmuxGateway stubs
  ensureServer(): void {}
  ensureSession(): void {}
  hasWindow(): boolean { return false; }
  killWindow(): void {}
  killSession(): void {}
  createWindow(): void {}
  splitWindow(): void {}
  setWindowOption(): void {}
  setSessionOption(): void {}
  getSessionOption(): string | null { return null; }
  runCommand(): void {}
  selectPane(): void {}
  listWindows() { return []; }
  listAllSessions() { return []; }
  getFirstWindowName(): string | null { return null; }
}

describe("computeRunning", () => {
  const now = new Date("2026-04-28T10:00:00.000Z");

  it("returns true when lastActivityAt is within the default threshold (2500ms)", () => {
    const probe = {
      agentBinary: null as null,
      lastActivityAt: new Date(now.getTime() - 1000).toISOString(),
      recentTailLines: [],
    };
    expect(computeRunning(probe, () => now)).toBe(true);
  });

  it("returns false when lastActivityAt is beyond the default threshold", () => {
    const probe = {
      agentBinary: null as null,
      lastActivityAt: new Date(now.getTime() - 3000).toISOString(),
      recentTailLines: [],
    };
    expect(computeRunning(probe, () => now)).toBe(false);
  });

  it("returns false when lastActivityAt is null", () => {
    const probe = {
      agentBinary: null as null,
      lastActivityAt: null,
      recentTailLines: [],
    };
    expect(computeRunning(probe, () => now)).toBe(false);
  });

  it("respects a custom threshold", () => {
    const probe = {
      agentBinary: null as null,
      lastActivityAt: new Date(now.getTime() - 5000).toISOString(),
      recentTailLines: [],
    };
    expect(computeRunning(probe, () => now, { thresholdMs: 6000 })).toBe(true);
    expect(computeRunning(probe, () => now, { thresholdMs: 4000 })).toBe(false);
  });

  it("returns true exactly at the threshold boundary", () => {
    const probe = {
      agentBinary: null as null,
      lastActivityAt: new Date(now.getTime() - 2500).toISOString(),
      recentTailLines: [],
    };
    expect(computeRunning(probe, () => now)).toBe(true);
  });
});

describe("extractStatusWord", () => {
  it("extracts gerund from ✻ pattern with ellipsis", () => {
    expect(extractStatusWord(["✻ Pondering…"])).toBe("Pondering");
  });

  it("extracts gerund from ✶ pattern with dots", () => {
    expect(extractStatusWord(["✶ Cogitating..."])).toBe("Cogitating");
  });

  it("returns the last match when multiple lines match", () => {
    expect(extractStatusWord(["✻ Thinking…", "✶ Analyzing…"])).toBe("Analyzing");
  });

  it("returns null for unrelated lines", () => {
    expect(extractStatusWord(["some random output", "another line"])).toBeNull();
  });

  it("returns null for empty input", () => {
    expect(extractStatusWord([])).toBeNull();
  });

  it("strips ANSI escape codes before matching", () => {
    expect(extractStatusWord(["\x1b[32m✻ Pondering…\x1b[0m"])).toBe("Pondering");
  });

  it("returns null for lines that start with lowercase (not a gerund pattern)", () => {
    expect(extractStatusWord(["✻ working…"])).toBeNull();
  });
});

describe("probeSessionActivity", () => {
  it("calls capturePane and getPaneLastActivity with the right target", () => {
    const fake = new FakeTmuxGateway();
    fake.lastActivityAt = "2026-04-28T10:00:00.000Z";
    fake.capturedLines = ["line1", "line2"];

    const result = probeSessionActivity(fake as unknown as TmuxGateway, "my-session:window.0");

    expect(fake.capturePaneCalls).toHaveLength(1);
    expect(fake.capturePaneCalls[0]).toMatchObject({ target: "my-session:window.0" });
    expect(fake.lastActivityCalls).toEqual(["my-session:window.0"]);
    expect(result.lastActivityAt).toBe("2026-04-28T10:00:00.000Z");
    expect(result.recentTailLines).toEqual(["line1", "line2"]);
    expect(result.agentBinary).toBeNull();
  });

  it("respects custom tailLines option", () => {
    const fake = new FakeTmuxGateway();
    probeSessionActivity(fake as unknown as TmuxGateway, "target.0", { tailLines: 25 });
    expect(fake.capturePaneCalls[0]?.lines).toBe(25);
  });

  it("uses default tailLines of 50", () => {
    const fake = new FakeTmuxGateway();
    probeSessionActivity(fake as unknown as TmuxGateway, "target.0");
    expect(fake.capturePaneCalls[0]?.lines).toBe(50);
  });
});
