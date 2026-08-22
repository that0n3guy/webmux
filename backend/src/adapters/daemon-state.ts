import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { isRecord } from "../lib/type-guards";

export interface DaemonState {
  port: number;
  pid: number;
  startedAt: string;
}

const DEFAULT_DAEMON_STATE_PATH = `${Bun.env.HOME ?? "/root"}/.config/webmux/daemon.json`;

export async function writeDaemonState(state: DaemonState, path = DEFAULT_DAEMON_STATE_PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(state, null, 2) + "\n");
}

export async function readDaemonState(path = DEFAULT_DAEMON_STATE_PATH): Promise<DaemonState | null> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch {
    return null;
  }

  if (!isRecord(raw)) return null;
  const { port, pid, startedAt } = raw;
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) return null;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
  if (typeof startedAt !== "string") return null;
  return { port, pid, startedAt };
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return isRecord(error) && error.code === "EPERM";
  }
}

/** Port of the running webmux daemon, or null when no daemon-written state exists or its process is gone. */
export async function readLiveDaemonPort(path = DEFAULT_DAEMON_STATE_PATH): Promise<number | null> {
  const state = await readDaemonState(path);
  if (!state || !isPidAlive(state.pid)) return null;
  return state.port;
}
