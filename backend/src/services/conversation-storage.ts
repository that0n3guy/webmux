import { readWorktreeMeta, writeWorktreeMeta } from "../adapters/fs";
import type { TmuxGateway } from "../adapters/tmux";
import type {
  ClaudeWorktreeConversationMeta,
  CodexWorktreeConversationMeta,
  WorktreeConversationMeta,
  WorktreeConversationProvider,
} from "../domain/model";

export interface ConversationStorage {
  load(): Promise<WorktreeConversationMeta | null>;
  save(meta: WorktreeConversationMeta): Promise<void>;
}

// ── WorktreeConversationStorage ─────────────────────────────────────────────

export interface WorktreeConversationStorageDeps {
  gitDir: string;
  readMeta?: typeof readWorktreeMeta;
  writeMeta?: typeof writeWorktreeMeta;
}

export function buildWorktreeConversationStorage(
  deps: WorktreeConversationStorageDeps,
): ConversationStorage {
  const doRead = deps.readMeta ?? readWorktreeMeta;
  const doWrite = deps.writeMeta ?? writeWorktreeMeta;

  return {
    async load(): Promise<WorktreeConversationMeta | null> {
      const meta = await doRead(deps.gitDir);
      return meta?.conversation ?? null;
    },

    async save(conversation: WorktreeConversationMeta): Promise<void> {
      const meta = await doRead(deps.gitDir);
      if (!meta) return;
      await doWrite(deps.gitDir, { ...meta, conversation });
    },
  };
}

// ── TmuxConversationStorage ──────────────────────────────────────────────────

const TMUX_OPT_PROVIDER = "@webmux-conversation-provider";
const TMUX_OPT_ID = "@webmux-conversation-id";
const TMUX_OPT_CWD = "@webmux-conversation-cwd";
const TMUX_OPT_LAST_SEEN_AT = "@webmux-conversation-last-seen-at";
const TMUX_OPT_CLAUDE_SESSION_ID = "@webmux-conversation-claude-session-id";
const TMUX_OPT_CODEX_THREAD_ID = "@webmux-conversation-codex-thread-id";

export interface TmuxConversationStorageDeps {
  tmux: TmuxGateway;
  sessionName: string;
}

function isConversationProvider(value: string): value is WorktreeConversationProvider {
  return value === "claudeCode" || value === "codexAppServer";
}

function loadFromTmux(
  tmux: TmuxGateway,
  sessionName: string,
): WorktreeConversationMeta | null {
  const provider = tmux.getSessionOption(sessionName, TMUX_OPT_PROVIDER);
  const conversationId = tmux.getSessionOption(sessionName, TMUX_OPT_ID);
  const cwd = tmux.getSessionOption(sessionName, TMUX_OPT_CWD);
  const lastSeenAt = tmux.getSessionOption(sessionName, TMUX_OPT_LAST_SEEN_AT);

  if (!provider || !conversationId || !cwd || !lastSeenAt) return null;
  if (!isConversationProvider(provider)) return null;

  if (provider === "claudeCode") {
    const sessionId = tmux.getSessionOption(sessionName, TMUX_OPT_CLAUDE_SESSION_ID);
    if (!sessionId) return null;
    const meta: ClaudeWorktreeConversationMeta = {
      provider: "claudeCode",
      conversationId,
      sessionId,
      cwd,
      lastSeenAt,
    };
    return meta;
  }

  // codexAppServer
  const threadId = tmux.getSessionOption(sessionName, TMUX_OPT_CODEX_THREAD_ID);
  if (!threadId) return null;
  const meta: CodexWorktreeConversationMeta = {
    provider: "codexAppServer",
    conversationId,
    threadId,
    cwd,
    lastSeenAt,
  };
  return meta;
}

function saveToTmux(
  tmux: TmuxGateway,
  sessionName: string,
  meta: WorktreeConversationMeta,
): void {
  tmux.setSessionOption(sessionName, TMUX_OPT_PROVIDER, meta.provider);
  tmux.setSessionOption(sessionName, TMUX_OPT_ID, meta.conversationId);
  tmux.setSessionOption(sessionName, TMUX_OPT_CWD, meta.cwd);
  tmux.setSessionOption(sessionName, TMUX_OPT_LAST_SEEN_AT, meta.lastSeenAt);

  if (meta.provider === "claudeCode") {
    tmux.setSessionOption(sessionName, TMUX_OPT_CLAUDE_SESSION_ID, meta.sessionId);
  } else {
    tmux.setSessionOption(sessionName, TMUX_OPT_CODEX_THREAD_ID, meta.threadId);
  }
}

export function buildTmuxConversationStorage(
  deps: TmuxConversationStorageDeps,
): ConversationStorage {
  return {
    async load(): Promise<WorktreeConversationMeta | null> {
      return loadFromTmux(deps.tmux, deps.sessionName);
    },

    async save(meta: WorktreeConversationMeta): Promise<void> {
      saveToTmux(deps.tmux, deps.sessionName, meta);
    },
  };
}
