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
  projectId: string;
  idGenerator?: () => string;
  now?: () => string;
  getAgentLaunchCommand?: (agentId: string) => string | null;
}

function buildSnapshot(meta: ScratchSessionMeta, byName: Map<string, { windowCount: number; attached: boolean }>): ScratchSessionSnapshot {
  const summary = byName.get(meta.sessionName);
  return {
    ...meta,
    windowCount: summary?.windowCount ?? 0,
    attached: summary?.attached ?? false,
  };
}

export function createScratchSessionService(deps: Deps): ScratchSessionService {
  const idGen = deps.idGenerator ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());
  const metas = new Map<string, ScratchSessionMeta>();
  const projectPrefix = `${SCRATCH_SESSION_PREFIX}${deps.projectId}-`;

  return {
    // `create` is async because future scratch-with-agent variants will spawn and await an agent process.
    async create(input) {
      const id = idGen();
      const sessionName = `${projectPrefix}${id}`;
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
      deps.tmux.setSessionOption(sessionName, "@webmux-display-name", input.displayName);
      deps.tmux.setSessionOption(sessionName, "@webmux-kind", input.kind);
      deps.tmux.setSessionOption(sessionName, "@webmux-agent-id", input.agentId ?? "");
      deps.tmux.setSessionOption(sessionName, "@webmux-created-at", meta.createdAt);
      if (input.kind === "agent" && input.agentId && deps.getAgentLaunchCommand) {
        const cmd = deps.getAgentLaunchCommand(input.agentId);
        if (cmd) {
          deps.tmux.runCommand(sessionName, cmd);
        }
      }
      metas.set(id, meta);
      return meta;
    },
    list() {
      const live = deps.tmux.listAllSessions();
      const byName = new Map(live.map((s) => [s.name, { windowCount: s.windowCount, attached: s.attached }] as const));
      return [...metas.values()].map((m) => buildSnapshot(m, byName));
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
        if (!s.name.startsWith(projectPrefix)) continue;
        const id = s.name.slice(projectPrefix.length);
        if (metas.has(id)) continue;

        const persistedDisplayName = deps.tmux.getSessionOption(s.name, "@webmux-display-name");
        const persistedKind = deps.tmux.getSessionOption(s.name, "@webmux-kind");
        const persistedAgentId = deps.tmux.getSessionOption(s.name, "@webmux-agent-id");
        const persistedCreatedAt = deps.tmux.getSessionOption(s.name, "@webmux-created-at");

        const kind: ScratchSessionKind = persistedKind === "agent" ? "agent" : "shell";

        metas.set(id, {
          id,
          displayName: persistedDisplayName ?? id,
          sessionName: s.name,
          kind,
          agentId: persistedAgentId && persistedAgentId.length > 0 ? persistedAgentId : null,
          cwd: deps.cwd,
          createdAt: persistedCreatedAt ?? now(),
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
