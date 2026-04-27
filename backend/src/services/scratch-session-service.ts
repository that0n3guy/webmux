import { randomUUID } from "node:crypto";
import { SCRATCH_SESSION_PREFIX, type TmuxGateway } from "../adapters/tmux";
import type { ScratchSessionKind, ScratchSessionMeta, ScratchSessionSnapshot } from "../domain/model";

export interface CreateScratchSessionInput {
  displayName: string;
  kind: ScratchSessionKind;
  agentId: string | null;
}

export interface ScratchSessionService {
  create(input: CreateScratchSessionInput): Promise<ScratchSessionMeta>;
  list(): ScratchSessionSnapshot[];
  remove(id: string): void;
  scan(): void;
  getBySessionName(sessionName: string): ScratchSessionMeta | null;
}

interface Deps {
  tmux: TmuxGateway;
  cwd: string;
  idGenerator?: () => string;
  now?: () => string;
}

export function createScratchSessionService(deps: Deps): ScratchSessionService {
  const idGen = deps.idGenerator ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());
  const metas = new Map<string, ScratchSessionMeta>();

  function buildSnapshot(meta: ScratchSessionMeta): ScratchSessionSnapshot {
    const summary = deps.tmux.listAllSessions().find((s) => s.name === meta.sessionName);
    return {
      ...meta,
      windowCount: summary?.windowCount ?? 0,
      attached: summary?.attached ?? false,
    };
  }

  return {
    async create(input) {
      const id = idGen();
      const sessionName = `${SCRATCH_SESSION_PREFIX}${id}`;
      const meta: ScratchSessionMeta = {
        id,
        displayName: input.displayName,
        sessionName,
        kind: input.kind,
        agentId: input.agentId,
        cwd: deps.cwd,
        createdAt: now(),
      };
      deps.tmux.ensureSession(sessionName, deps.cwd);
      metas.set(id, meta);
      return meta;
    },
    list() {
      return [...metas.values()].map(buildSnapshot);
    },
    remove(id) {
      const meta = metas.get(id);
      if (!meta) return;
      deps.tmux.killSession(meta.sessionName);
      metas.delete(id);
    },
    scan() {
      const live = deps.tmux.listAllSessions();
      for (const s of live) {
        if (!s.name.startsWith(SCRATCH_SESSION_PREFIX)) continue;
        const id = s.name.slice(SCRATCH_SESSION_PREFIX.length);
        if (metas.has(id)) continue;
        metas.set(id, {
          id,
          displayName: id,
          sessionName: s.name,
          kind: "shell",
          agentId: null,
          cwd: deps.cwd,
          createdAt: now(),
        });
      }
    },
    getBySessionName(sessionName) {
      for (const meta of metas.values()) {
        if (meta.sessionName === sessionName) return meta;
      }
      return null;
    },
  };
}
