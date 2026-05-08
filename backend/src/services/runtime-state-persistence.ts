import type { AgentRuntimeState, WorktreeRuntimeStatePersisted } from "../domain/model";
import { WORKTREE_RUNTIME_STATE_VERSION } from "../domain/model";

export interface RuntimeStatePersistence {
  schedule(worktreeId: string, gitDir: string, state: AgentRuntimeState): void;
  flush(): Promise<void>;
}

interface PendingWrite {
  gitDir: string;
  state: AgentRuntimeState;
  timer: ReturnType<typeof setTimeout>;
}

function toPersistedState(state: AgentRuntimeState): WorktreeRuntimeStatePersisted {
  return {
    schemaVersion: WORKTREE_RUNTIME_STATE_VERSION,
    lifecycle: state.lifecycle,
    lastStartedAt: state.lastStartedAt,
    lastEventAt: state.lastEventAt,
    lastError: state.lastError,
  };
}

export function createRuntimeStatePersistence(deps: {
  writeRuntimeState?: (gitDir: string, state: WorktreeRuntimeStatePersisted) => Promise<void>;
  debounceMs?: number;
}): RuntimeStatePersistence {
  const writeRuntimeState = deps.writeRuntimeState;
  const debounceMs = deps.debounceMs ?? 500;
  const pending = new Map<string, PendingWrite>();
  const inFlight = new Map<string, Promise<void>>();

  function doWrite(worktreeId: string, gitDir: string, state: AgentRuntimeState): Promise<void> {
    if (!writeRuntimeState) return Promise.resolve();
    const persisted = toPersistedState(state);
    const write = writeRuntimeState(gitDir, persisted).catch((err: unknown) => {
      console.warn(`[runtime-state] Failed to persist state for worktree ${worktreeId}:`, err);
    }).finally(() => {
      if (inFlight.get(worktreeId) === write) {
        inFlight.delete(worktreeId);
      }
    });
    inFlight.set(worktreeId, write);
    return write;
  }

  return {
    schedule(worktreeId: string, gitDir: string, state: AgentRuntimeState): void {
      const existing = pending.get(worktreeId);
      if (existing) {
        clearTimeout(existing.timer);
      }
      const timer = setTimeout(() => {
        pending.delete(worktreeId);
        doWrite(worktreeId, gitDir, state);
      }, debounceMs);
      pending.set(worktreeId, { gitDir, state, timer });
    },

    async flush(): Promise<void> {
      const flushPromises: Promise<void>[] = [];
      for (const [worktreeId, entry] of pending) {
        clearTimeout(entry.timer);
        pending.delete(worktreeId);
        flushPromises.push(doWrite(worktreeId, entry.gitDir, entry.state));
      }
      await Promise.all([...flushPromises, ...inFlight.values()]);
    },
  };
}
