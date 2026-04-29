import { readWorktreeMeta, writeWorktreeMeta } from "../adapters/fs";
import type {
  ClaudeCliConversationMessage,
  ClaudeCliGateway,
  ClaudeCliSession,
} from "../adapters/claude-cli";
import { buildProjectSessionName, buildWorktreeWindowName, type TmuxGateway } from "../adapters/tmux";
import type {
  AgentsUiConversationMessage,
  AgentsUiConversationState,
  AgentsUiWorktreeConversationResponse,
} from "../domain/agents-ui";
import type {
  ClaudeWorktreeConversationMeta,
  WorktreeConversationMeta,
  WorktreeMeta,
  WorktreeSnapshot,
} from "../domain/model";
import { log } from "../lib/log";
import { buildAgentsUiWorktreeSummary } from "./agents-ui-service";
import { buildWorktreeConversationStorage, type ConversationStorage } from "./conversation-storage";
import { probeSessionActivity, extractStatusWord } from "./session-activity-service";
import { err, ok, type WorktreeConversationResult } from "./worktree-conversation-result";

export interface ClaudeConversationProbeContext {
  tmux: TmuxGateway;
  projectRoot: string;
}

export interface ClaudeConversationServiceDependencies {
  claude: Pick<ClaudeCliGateway, "listSessions" | "readSession" | "getSessionMtime">;
  git: {
    resolveWorktreeGitDir(cwd: string): string;
  };
  now?: () => Date;
  readMeta?: (gitDir: string) => Promise<WorktreeMeta | null>;
  writeMeta?: (gitDir: string, meta: WorktreeMeta) => Promise<void>;
}

interface ResolvedClaudeConversation {
  conversationMeta: ClaudeWorktreeConversationMeta | null;
  session: ClaudeCliSession | null;
}

function isClaudeWorktree(worktree: WorktreeSnapshot): boolean {
  return worktree.agentName === "claude";
}

function isClaudeConversationMeta(meta: WorktreeConversationMeta | null | undefined): meta is ClaudeWorktreeConversationMeta {
  return meta?.provider === "claudeCode";
}

function buildPendingConversationId(worktree: WorktreeSnapshot): string {
  return `claude-pending:${worktree.path}`;
}

function buildClaudeConversationMeta(sessionId: string, cwd: string, now: Date): ClaudeWorktreeConversationMeta {
  return {
    provider: "claudeCode",
    conversationId: sessionId,
    sessionId,
    cwd,
    lastSeenAt: now.toISOString(),
  };
}

function sameConversationMeta(left: WorktreeConversationMeta | null | undefined, right: ClaudeWorktreeConversationMeta): boolean {
  return left?.provider === right.provider
    && left.conversationId === right.conversationId
    && left.cwd === right.cwd;
}

function normalizeSessionMessages(messages: ClaudeCliConversationMessage[]): AgentsUiConversationMessage[] {
  return messages.map((message) => ({
    ...message,
    status: "completed",
  }));
}

function buildConversationState(
  worktree: WorktreeSnapshot,
  session: ClaudeCliSession | null,
  running: boolean,
  statusWord: string | null,
): AgentsUiConversationState {
  return {
    provider: "claudeCode",
    conversationId: session?.sessionId ?? buildPendingConversationId(worktree),
    cwd: worktree.path,
    running,
    activeTurnId: null,
    messages: normalizeSessionMessages(session?.messages ?? []),
    statusWord,
  };
}

function toWorktreeConversationResponse(
  worktree: WorktreeSnapshot,
  conversationMeta: ClaudeWorktreeConversationMeta | null,
  session: ClaudeCliSession | null,
  running: boolean,
  statusWord: string | null,
): AgentsUiWorktreeConversationResponse {
  return {
    worktree: buildAgentsUiWorktreeSummary(worktree, conversationMeta),
    conversation: buildConversationState(worktree, session, running, statusWord),
  };
}

export class ClaudeConversationService {
  private readonly now: () => Date;
  private readonly readMeta;
  private readonly writeMeta;

  constructor(private readonly deps: ClaudeConversationServiceDependencies) {
    this.now = deps.now ?? (() => new Date());
    this.readMeta = deps.readMeta ?? readWorktreeMeta;
    this.writeMeta = deps.writeMeta ?? writeWorktreeMeta;
  }

  private probeStatusWord(
    worktree: WorktreeSnapshot,
    probe?: ClaudeConversationProbeContext,
  ): string | null {
    if (!probe) return null;
    try {
      const sessionName = buildProjectSessionName(probe.projectRoot);
      const windowName = buildWorktreeWindowName(worktree.branch);
      const paneTarget = `${sessionName}:${windowName}.0`;
      const activity = probeSessionActivity(probe.tmux, paneTarget, undefined, this.now);
      return extractStatusWord(activity.recentTailLines);
    } catch {
      return null;
    }
  }

  async attachWorktreeConversation(
    worktree: WorktreeSnapshot,
    probe?: ClaudeConversationProbeContext,
    storage?: ConversationStorage,
  ): Promise<WorktreeConversationResult<AgentsUiWorktreeConversationResponse>> {
    return await this.withResolvedConversation(worktree, storage, async (resolved) => {
      const running = worktree.status === "running" || worktree.status === "starting";
      const statusWord = this.probeStatusWord(worktree, probe);
      return ok(toWorktreeConversationResponse(worktree, resolved.conversationMeta, resolved.session, running, statusWord));
    });
  }

  async readWorktreeConversation(
    worktree: WorktreeSnapshot,
    probe?: ClaudeConversationProbeContext,
    storage?: ConversationStorage,
  ): Promise<WorktreeConversationResult<AgentsUiWorktreeConversationResponse>> {
    return await this.withResolvedConversation(worktree, storage, async (resolved) => {
      const running = worktree.status === "running" || worktree.status === "starting";
      const statusWord = this.probeStatusWord(worktree, probe);
      return ok(toWorktreeConversationResponse(worktree, resolved.conversationMeta, resolved.session, running, statusWord));
    });
  }

  private buildDefaultStorage(worktreePath: string): ConversationStorage {
    const gitDir = this.deps.git.resolveWorktreeGitDir(worktreePath);
    return buildWorktreeConversationStorage({
      gitDir,
      readMeta: this.readMeta,
      writeMeta: this.writeMeta,
    });
  }

  private async withResolvedConversation<T>(
    worktree: WorktreeSnapshot,
    storage: ConversationStorage | undefined,
    fn: (resolved: ResolvedClaudeConversation) => Promise<WorktreeConversationResult<T>>,
  ): Promise<WorktreeConversationResult<T>> {
    if (!isClaudeWorktree(worktree)) {
      return err(409, "Worktree chat is only available for Claude worktrees");
    }

    try {
      const effectiveStorage = storage ?? this.buildDefaultStorage(worktree.path);
      const resolved = await this.resolveConversation(worktree, effectiveStorage);
      if (!resolved.ok) return resolved;
      return await fn(resolved.data);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return err(502, message);
    }
  }

  private async resolveConversation(
    worktree: WorktreeSnapshot,
    storage: ConversationStorage,
  ): Promise<WorktreeConversationResult<ResolvedClaudeConversation>> {
    const saved = await storage.load();

    const session = await this.resolveSession(saved, worktree.path);
    const conversationMeta = session
      ? await this.persistConversationMeta(storage, worktree.path, session.sessionId)
      : null;

    return ok({
      conversationMeta,
      session,
    });
  }

  private async resolveSession(
    saved: WorktreeConversationMeta | null,
    cwd: string,
  ): Promise<ClaudeCliSession | null> {
    const savedSessionId = isClaudeConversationMeta(saved) ? saved.sessionId : null;
    if (savedSessionId) {
      const savedSession = await this.deps.claude.readSession(savedSessionId, cwd);
      if (savedSession) return savedSession;
      log.warn(`[agents] saved Claude session missing, rediscovering cwd=${cwd} sessionId=${savedSessionId}`);
    }

    const discovered = (await this.deps.claude.listSessions(cwd))[0] ?? null;
    if (!discovered) return null;
    return await this.deps.claude.readSession(discovered.sessionId, cwd);
  }

  private async persistConversationMeta(
    storage: ConversationStorage,
    cwd: string,
    sessionId: string,
  ): Promise<ClaudeWorktreeConversationMeta> {
    const nextConversation = buildClaudeConversationMeta(sessionId, cwd, this.now());
    const existing = await storage.load();
    if (!sameConversationMeta(existing, nextConversation)) {
      await storage.save(nextConversation);
    }
    return nextConversation;
  }
}
