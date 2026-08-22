import { afterEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDaemonState, readLiveDaemonPort, writeDaemonState } from "../adapters/daemon-state";

describe("daemon-state", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  async function statePath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "webmux-daemon-state-"));
    tempDirs.push(dir);
    return join(dir, "config", "daemon.json");
  }

  it("round-trips daemon state through the state file", async () => {
    const path = await statePath();
    const state = { port: 3100, pid: process.pid, startedAt: "2026-08-22T00:00:00.000Z" };

    await writeDaemonState(state, path);

    expect(await readDaemonState(path)).toEqual(state);
  });

  it("returns null for a missing or malformed state file", async () => {
    const path = await statePath();

    expect(await readDaemonState(path)).toBeNull();

    await Bun.write(path, "not json");
    expect(await readDaemonState(path)).toBeNull();

    await Bun.write(path, JSON.stringify({ port: "3100", pid: process.pid, startedAt: "x" }));
    expect(await readDaemonState(path)).toBeNull();

    await Bun.write(path, JSON.stringify({ port: 3100, pid: process.pid }));
    expect(await readDaemonState(path)).toBeNull();
  });

  it("reports the daemon port only while the recorded pid is alive", async () => {
    const path = await statePath();

    await writeDaemonState({ port: 3100, pid: process.pid, startedAt: "2026-08-22T00:00:00.000Z" }, path);
    expect(await readLiveDaemonPort(path)).toBe(3100);

    const shortLived = Bun.spawn(["true"]);
    await shortLived.exited;
    await writeDaemonState({ port: 3100, pid: shortLived.pid, startedAt: "2026-08-22T00:00:00.000Z" }, path);
    expect(await readLiveDaemonPort(path)).toBeNull();
  });

  it("returns null without a state file", async () => {
    const path = await statePath();
    expect(await readLiveDaemonPort(path)).toBeNull();
  });
});
