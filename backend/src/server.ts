import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { mkdirSync } from "node:fs";
import { networkInterfaces } from "node:os";
import {
  AgentsSendMessageRequestSchema,
  apiPaths,
  AvailableBranchesQuerySchema,
  CreateProjectRequestSchema,
  CreateScratchSessionRequestSchema,
  CreateWorktreeRequestSchema,
  NotificationIdParamsSchema,
  OpenWorktreeRequestSchema,
  PullMainRequestSchema,
  RemoveProjectRequestSchema,
  UpdateUserPreferencesRequestSchema,
  RunIdParamsSchema,
  SendWorktreePromptRequestSchema,
  SetWorktreeArchivedRequestSchema,
  ToggleEnabledRequestSchema,
  UpdateWorktreeRequestSchema,
  UpsertCustomAgentRequestSchema,
  WorktreeNameParamsSchema,
} from "@webmux/api-contract";
import { buildTmuxConversationStorage } from "./services/conversation-storage";
import { probeSessionActivity, summarizeSessionActivity } from "./services/session-activity-service";
import { log } from "./lib/log";
import {
  attach,
  detach,
  interruptPrompt,
  write,
  resize,
  selectPane,
  sendKeys,
  getScrollback,
  setCallbacks,
  clearCallbacks,
  cleanupStaleSessions,
  sendPrompt as sendTerminalPrompt,
  type TerminalAttachTarget,
} from "./adapters/terminal";
import { loadControlToken } from "./adapters/control-token";
import { readWorktreeMeta, writeWorktreeMeta } from "./adapters/fs";
import { ClaudeCliClient } from "./adapters/claude-cli";
import { CodexAppServerClient } from "./adapters/codex-app-server";
import {
  getDefaultProfileName,
  persistLocalCustomAgent,
  persistLocalGitHubConfig,
  persistLocalLinearConfig,
  removeLocalCustomAgent,
  type ProjectConfig,
} from "./adapters/config";
import { jsonResponse, errorResponse } from "./lib/http";
import { isRecord, isStringArray } from "./lib/type-guards";
import { parseJsonBody, parseParams, parseQuery } from "./api-validation";
import { hasRecentDashboardActivity, touchDashboardActivity } from "./services/dashboard-activity";
import { listExternalSessions } from "./services/external-tmux-service";
import { buildArchivedWorktreePathSet, normalizeArchivePath } from "./services/archive-service";
import { resolveAgentChatSupport } from "./services/agent-chat-service";
import { validateCustomAgentInput } from "./services/agent-validation-service";
import { getAgentDefinition, isBuiltInAgentId, listAgentDetails, listAgentSummaries, normalizeCustomAgentId } from "./services/agent-registry";
import {
  branchMatchesIssue,
  buildLinearIssuesResponse,
  createLinearIssue,
  deriveLinearIssueTitle,
  fetchAssignedIssues,
} from "./services/linear-service";
import { buildCreateWorktreeTargets, LifecycleError } from "./services/lifecycle-service";
import { buildNativeTerminalLaunch, buildNativeTerminalTmuxCommand } from "./services/native-terminal-service";
import { startPrMonitor } from "./services/pr-service";
import { startLinearAutoCreateMonitor, resetProcessedIssues } from "./services/linear-auto-create-service";
import { runAutoRemove, type AutoRemoveDependencies } from "./services/auto-remove-service";
import { pullMainBranch, forcePullMainBranch, startAutoPullMonitor } from "./services/auto-pull-service";
import {
  buildAgentsUiMessageDeltaEvent,
  readAgentsNotificationThreadId,
  shouldRefreshAgentsConversationSnapshot,
} from "./services/agents-ui-stream-service";
import { classifyAgentsTerminalWorktreeError } from "./services/agents-ui-action-service";
import { buildProjectSnapshot } from "./services/snapshot-service";
import { ClaudeConversationService, type ClaudeConversationProbeContext } from "./services/claude-conversation-service";
import { WorktreeConversationService, type WorktreeConversationProbeContext } from "./services/worktree-conversation-service";
import { parseRuntimeEvent } from "./domain/events";
import type { AgentsUiConversationEvent, AgentsUiWorktreeConversationResponse } from "./domain/agents-ui";
import type { ProjectSnapshot, WorktreeSnapshot } from "./domain/model";
import { isValidBranchName, isValidWorktreeName } from "./domain/policies";
import { createWebmuxRuntime } from "./runtime";
import type { ProjectScope } from "./services/project-scope";
import type { UserPreferences } from "./adapters/preferences";

const PORT = parseInt(Bun.env.PORT || "5111", 10);
const STATIC_DIR = Bun.env.WEBMUX_STATIC_DIR || "";
const STARTUP_PROJECT_DIR = Bun.env.WEBMUX_PROJECT_DIR || process.cwd();
const runtime = await createWebmuxRuntime({
  port: PORT,
  projectDir: STARTUP_PROJECT_DIR,
});
const projects = runtime.projectRegistry.list();
if (projects.length === 0) {
  log.error(
    `[server] no projects registered (cwd=${STARTUP_PROJECT_DIR} has no .webmux.yaml, and ~/.config/webmux/projects.yaml is empty or missing). Run \`webmux init\` in a project dir, or POST /api/projects with a path.`,
  );
  process.exit(1);
}

const git = runtime.git;
const tmux = runtime.tmux;
const runtimeNotifications = runtime.runtimeNotifications;
const codexAppServerClient = new CodexAppServerClient({
  clientName: "webmux-agents",
  clientVersion: "0.0.0",
});
const claudeCliClient = new ClaudeCliClient();
const worktreeConversationService = new WorktreeConversationService({
  appServer: codexAppServerClient,
  git,
});
const claudeConversationService = new ClaudeConversationService({
  claude: claudeCliClient,
  git,
});

// Per-project toggle state: keyed by projectId
const linearAutoCreateEnabledByProject = new Map<string, boolean>();
const stopLinearAutoCreateByProject = new Map<string, (() => void) | null>();
const autoRemoveOnMergeEnabledByProject = new Map<string, boolean>();

// Initialize per-project toggle state from loaded config
for (const proj of runtime.projectRegistry.list()) {
  const scope = runtime.projectRegistry.get(proj.id);
  if (!scope) continue;
  linearAutoCreateEnabledByProject.set(proj.id, scope.config.integrations.linear.autoCreateWorktrees);
  stopLinearAutoCreateByProject.set(proj.id, null);
  autoRemoveOnMergeEnabledByProject.set(proj.id, scope.config.integrations.github.autoRemoveOnMerge);
}

/** Safe to call multiple times — the guard prevents duplicate monitors. */
function startLinearAutoCreate(scope: ProjectScope): void {
  const existing = stopLinearAutoCreateByProject.get(scope.projectId);
  if (existing) return;
  const stop = startLinearAutoCreateMonitor({
    lifecycleService: scope.lifecycleService,
    git,
    projectRoot: scope.projectDir,
    isActive: hasRecentDashboardActivity,
  });
  stopLinearAutoCreateByProject.set(scope.projectId, stop);
}

function stopLinearAutoCreateMonitor(scope: ProjectScope): void {
  const stop = stopLinearAutoCreateByProject.get(scope.projectId);
  if (stop) {
    stop();
    stopLinearAutoCreateByProject.set(scope.projectId, null);
  }
}

function buildAutoRemoveDeps(scope: ProjectScope): AutoRemoveDependencies {
  const { projectId } = scope;
  return {
    lifecycleService: scope.lifecycleService,
    git,
    projectRoot: scope.projectDir,
    notifications: {
      notify: (input) => runtimeNotifications.notify({ ...input, projectId }),
    },
    isRemoving: (branch: string) => scope.removingBranches.has(branch),
    markRemoving: (branch: string) => scope.removingBranches.add(branch),
    unmarkRemoving: (branch: string) => scope.removingBranches.delete(branch),
  };
}

function getFrontendConfig(scope: ProjectScope): {
  name: string;
  services: ProjectConfig["services"];
  profiles: Array<{ name: string; systemPrompt?: string }>;
  agents: ReturnType<typeof listAgentSummaries>;
  defaultProfileName: string;
  defaultAgentId: ProjectConfig["workspace"]["defaultAgent"];
  autoName: boolean;
  linearCreateTicketOption: boolean;
  startupEnvs: ProjectConfig["startupEnvs"];
  linkedRepos: Array<{ alias: string; dir?: string }>;
  linearAutoCreateWorktrees: boolean;
  autoRemoveOnMerge: boolean;
  projectDir: string;
  mainBranch: string;
} {
  const config = scope.config;
  const projectDefaultProfile = getDefaultProfileName(config);
  const globalDefaultProfile = scope.preferences.defaultProfile;
  const defaultProfileName = globalDefaultProfile && config.profiles[globalDefaultProfile]
    ? globalDefaultProfile
    : projectDefaultProfile;
  const orderedProfileEntries = Object.entries(config.profiles).sort(([left], [right]) => {
    if (left === defaultProfileName) return -1;
    if (right === defaultProfileName) return 1;
    return 0;
  });

  return {
    name: config.name,
    services: config.services,
    profiles: orderedProfileEntries.map(([name, profile]) => ({
      name,
      ...(profile.systemPrompt ? { systemPrompt: profile.systemPrompt } : {}),
    })),
    agents: listAgentSummaries(config),
    defaultProfileName,
    defaultAgentId: config.workspace.defaultAgent,
    autoName: config.autoName !== null,
    linearCreateTicketOption: config.integrations.linear.enabled && config.integrations.linear.createTicketOption,
    startupEnvs: config.startupEnvs,
    linkedRepos: config.integrations.github.linkedRepos.map((lr) => ({
      alias: lr.alias,
      ...(lr.dir ? { dir: resolve(scope.projectDir, lr.dir) } : {}),
    })),
    linearAutoCreateWorktrees: linearAutoCreateEnabledByProject.get(scope.projectId) ?? config.integrations.linear.autoCreateWorktrees,
    autoRemoveOnMerge: autoRemoveOnMergeEnabledByProject.get(scope.projectId) ?? config.integrations.github.autoRemoveOnMerge,
    projectDir: scope.projectDir,
    mainBranch: config.workspace.mainBranch,
  };
}

// --- WebSocket protocol types ---

interface TerminalWsData {
  kind: "terminal";
  projectId: string;
  branch: string;
  worktreeId: string | null;
  attachId: string | null;
  attached: boolean;
}

interface AgentsWsData {
  kind: "agents";
  projectId: string;
  branch: string;
  conversationId: string | null;
  unsubscribe: (() => void) | null;
}

interface ExternalTerminalWsData {
  kind: "terminal-external";
  sessionName: string;
  attachId: string | null;
  attached: boolean;
}

interface ScratchTerminalWsData {
  kind: "terminal-scratch";
  projectId: string;
  scratchId: string;
  sessionName: string;
  attachId: string | null;
  attached: boolean;
}

type WsData = TerminalWsData | AgentsWsData | ExternalTerminalWsData | ScratchTerminalWsData;
type ParamsRequest = Request & { params: Record<string, string> };

type WsInboundMessage =
  | { type: "input"; data: string }
  | { type: "sendKeys"; hexBytes: string[] }
  | { type: "selectPane"; pane: number }
  | { type: "resize"; cols: number; rows: number; initialPane?: number };

type WsOutboundMessage =
  | { type: "output"; data: string }
  | { type: "exit"; exitCode: number }
  | { type: "error"; message: string }
  | { type: "scrollback"; data: string };

function parseWsMessage(raw: string | Buffer): WsInboundMessage | null {
  try {
    const str = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
    const msg: unknown = JSON.parse(str);
    if (!isRecord(msg)) return null;
    const m = msg;
    switch (m.type) {
      case "input":
        return typeof m.data === "string" ? { type: "input", data: m.data } : null;
      case "sendKeys":
        return isStringArray(m.hexBytes)
          ? { type: "sendKeys", hexBytes: m.hexBytes }
          : null;
      case "selectPane":
        return typeof m.pane === "number" ? { type: "selectPane", pane: m.pane } : null;
      case "resize":
        return typeof m.cols === "number" && typeof m.rows === "number"
          ? {
            type: "resize",
            cols: m.cols,
            rows: m.rows,
            initialPane: typeof m.initialPane === "number" ? m.initialPane : undefined,
          }
          : null;
      default:
        return null;
    }
  } catch {
    return null;
  }
}

// --- HTTP helpers ---

/** Send a WsOutboundMessage. Hot-path messages (output/scrollback) use a
 *  single-character prefix to avoid JSON encode/decode overhead. */
function sendWs(ws: { send: (data: string) => void }, msg: WsOutboundMessage): void {
  switch (msg.type) {
    case "output":
      ws.send("o" + msg.data);
      break;
    case "scrollback":
      ws.send("s" + msg.data);
      break;
    default:
      ws.send(JSON.stringify(msg));
  }
}

function sendAgentsWs(ws: { readyState: number; send: (data: string) => void }, msg: AgentsUiConversationEvent): void {
  if (ws.readyState <= 1) {
    ws.send(JSON.stringify(msg));
  }
}

/** Wrap an async API handler to catch and log unhandled errors. */
function catching(label: string, fn: () => Promise<Response>): Promise<Response> {
  return fn().catch((err: unknown) => {
    if (err instanceof LifecycleError) {
      return errorResponse(err.message, err.status);
    }

    const msg = err instanceof Error ? err.message : String(err);
    log.error(`[api:error] ${label}: ${msg}`);
    return errorResponse(msg);
  });
}

function ensureBranchNotRemoving(scope: ProjectScope, branch: string): void {
  if (scope.removingBranches.has(branch)) {
    throw new LifecycleError(`Worktree is being removed: ${branch}`, 409);
  }
}

function ensureBranchNotCreating(scope: ProjectScope, branch: string): void {
  if (scope.worktreeCreationTracker.has(branch)) {
    throw new LifecycleError(`Worktree is being created: ${branch}`, 409);
  }
}

function ensureBranchNotBusy(scope: ProjectScope, branch: string): void {
  ensureBranchNotRemoving(scope, branch);
  ensureBranchNotCreating(scope, branch);
}

async function withRemovingBranch<T>(scope: ProjectScope, branch: string, fn: () => Promise<T>): Promise<T> {
  ensureBranchNotBusy(scope, branch);
  scope.removingBranches.add(branch);
  try {
    return await fn();
  } finally {
    scope.removingBranches.delete(branch);
  }
}

async function resolveTerminalWorktree(scope: ProjectScope, branch: string): Promise<{
  worktreeId: string;
  attachTarget: TerminalAttachTarget;
}> {
  ensureBranchNotBusy(scope, branch);
  let state = scope.projectRuntime.getWorktreeByBranch(branch);
  if (!state || !state.session.exists || !state.session.sessionName) {
    await scope.reconciliationService.reconcile(scope.projectDir);
    state = scope.projectRuntime.getWorktreeByBranch(branch);
  }
  if (!state) {
    throw new Error(`Worktree not found: ${branch}`);
  }
  if (!state.session.exists || !state.session.sessionName) {
    throw new Error(`No open tmux window found for worktree: ${branch}`);
  }

  return {
    worktreeId: state.worktreeId,
    attachTarget: {
      ownerSessionName: state.session.sessionName,
      windowName: state.session.windowName,
    },
  };
}

async function resolveAgentsTerminalWorktree(scope: ProjectScope, branch: string): Promise<{
  ok: true;
  data: {
    worktreeId: string;
    attachTarget: TerminalAttachTarget;
  };
} | {
  ok: false;
  response: Response;
}> {
  try {
    return {
      ok: true,
      data: await resolveTerminalWorktree(scope, branch),
    };
  } catch (error) {
    const classified = classifyAgentsTerminalWorktreeError(error);
    if (!classified) throw error;
    return {
      ok: false,
      response: errorResponse(classified.error, classified.status),
    };
  }
}

async function apiGetNativeTerminalLaunch(scope: ProjectScope, branch: string): Promise<Response> {
  touchDashboardActivity();
  ensureBranchNotBusy(scope, branch);
  await scope.reconciliationService.reconcile(scope.projectDir);
  const launch = buildNativeTerminalLaunch({
    branch,
    state: scope.projectRuntime.getWorktreeByBranch(branch),
    tmuxCommand: buildNativeTerminalTmuxCommand(Bun.env),
    sessionPrefix: `wm-native-${PORT}-`,
  });
  if (!launch.ok) {
    return errorResponse(launch.message, launch.reason === "not_found" ? 404 : 409);
  }
  return jsonResponse(launch.data);
}

function getAttachedSessionId(
  data: TerminalWsData | ExternalTerminalWsData | ScratchTerminalWsData,
  ws: { readyState: number; send: (data: string) => void },
): string | null {
  if (data.attached && data.attachId) return data.attachId;
  sendWs(ws, { type: "error", message: "Terminal not attached" });
  return null;
}

async function hasValidControlToken(req: Request): Promise<boolean> {
  const authHeader = req.headers.get("Authorization");
  const token = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  return token === await loadControlToken();
}

// --- Process helpers ---

async function getWorktreeGitDirs(scope: ProjectScope): Promise<Map<string, string>> {
  const gitDirs = new Map<string, string>();
  const projectRoot = resolve(scope.projectDir);
  for (const entry of git.listWorktrees(projectRoot)) {
    if (entry.bare || resolve(entry.path) === projectRoot || !entry.branch) continue;
    gitDirs.set(entry.branch, git.resolveWorktreeGitDir(entry.path));
  }
  return gitDirs;
}

function buildConversationProbeContext(scope: ProjectScope): ClaudeConversationProbeContext & WorktreeConversationProbeContext {
  return { tmux, projectRoot: scope.projectDir };
}

function makeCallbacks(ws: { send: (data: string) => void; readyState: number }): {
  onData: (data: string) => void;
  onExit: (exitCode: number) => void;
} {
  return {
    onData: (data: string) => {
      if (ws.readyState <= 1) sendWs(ws, { type: "output", data });
    },
    onExit: (exitCode: number) => {
      if (ws.readyState <= 1) sendWs(ws, { type: "exit", exitCode });
    },
  };
}

async function readProjectSnapshot(scope: ProjectScope): Promise<ProjectSnapshot> {
  const linearApiKey = Bun.env.LINEAR_API_KEY;
  const linearIssuesPromise = scope.config.integrations.linear.enabled && linearApiKey?.trim()
    ? fetchAssignedIssues()
    : Promise.resolve({ ok: true as const, data: [] });
  await scope.reconciliationService.reconcile(scope.projectDir);
  const archiveState = await scope.archiveStateService.prune(scope.projectRuntime.listWorktrees().map((worktree) => worktree.path));
  const linearResult = await linearIssuesPromise;
  const archivedPaths = buildArchivedWorktreePathSet(archiveState);
  const linearIssues = linearResult.ok ? linearResult.data : [];
  return buildProjectSnapshot({
    projectName: scope.config.name,
    mainBranch: scope.config.workspace.mainBranch,
    runtime: scope.projectRuntime,
    creatingWorktrees: scope.worktreeCreationTracker.list(),
    notifications: runtimeNotifications.list(),
    isArchived: (path) => archivedPaths.has(normalizeArchivePath(path)),
    findLinearIssue: (branch) => {
      const match = linearIssues.find((issue) => branchMatchesIssue(branch, issue.branchName));
      return match
        ? {
            identifier: match.identifier,
            url: match.url,
            state: match.state,
          }
        : null;
    },
    findAgentLabel: (agentId) => {
      if (!agentId) return null;
      return getAgentDefinition(scope.config, agentId)?.label ?? agentId;
    },
  });
}

// --- API handler functions (thin I/O layer, testable by injecting deps) ---

async function apiGetProject(scope: ProjectScope): Promise<Response> {
  touchDashboardActivity();
  return jsonResponse(await readProjectSnapshot(scope));
}

async function apiGetWorktrees(scope: ProjectScope): Promise<Response> {
  touchDashboardActivity();
  return jsonResponse({
    worktrees: (await readProjectSnapshot(scope)).worktrees,
  });
}

async function apiListExternalSessions(): Promise<Response> {
  const all = tmux.listAllSessions();
  const sessions = listExternalSessions(all, tmux);
  return jsonResponse({ sessions });
}

async function apiListScratchSessions(scope: ProjectScope): Promise<Response> {
  return jsonResponse({ sessions: scope.scratchSessionService.list() });
}

async function apiCreateScratchSession(scope: ProjectScope, req: Request): Promise<Response> {
  const body = CreateScratchSessionRequestSchema.parse(await req.json());
  const meta = await scope.scratchSessionService.create({
    displayName: body.displayName,
    kind: body.kind,
    agentId: body.agentId ?? null,
    ...(body.yolo === undefined ? {} : { yolo: body.yolo }),
  });
  const snap = scope.scratchSessionService.list().find((s) => s.id === meta.id);
  if (!snap) throw new Error("scratch session created but not visible in list");
  return jsonResponse({ session: snap }, 201);
}

async function apiRemoveScratchSession(scope: ProjectScope, id: string): Promise<Response> {
  scope.scratchSessionService.remove(id);
  return jsonResponse({ ok: true });
}

function parseScratchSessionIdParam(params: Record<string, string>): { ok: true; data: string } | { ok: false; response: Response } {
  const id = params.id;
  if (!id || id.length === 0) return { ok: false, response: errorResponse("Missing scratch session id", 400) };
  return { ok: true, data: id };
}

function findSnapshotWorktree(snapshot: ProjectSnapshot, branch: string): WorktreeSnapshot | null {
  return snapshot.worktrees.find((worktree) => worktree.branch === branch) ?? null;
}

async function resolveAgentsWorktree(scope: ProjectScope, branch: string): Promise<{
  ok: true;
  worktree: WorktreeSnapshot;
} | {
  ok: false;
  response: Response;
}> {
  const snapshot = await readProjectSnapshot(scope);
  const worktree = findSnapshotWorktree(snapshot, branch);
  if (!worktree) {
    return {
      ok: false,
      response: errorResponse(`Worktree not found: ${branch}`, 404),
    };
  }

  return {
    ok: true,
    worktree,
  };
}

function resolveWorktreeAgentChatSupport(scope: ProjectScope, worktree: WorktreeSnapshot, action: "chat" | "interrupt") {
  return resolveAgentChatSupport({
    agentId: worktree.agentName,
    agentLabel: worktree.agentLabel,
    agent: worktree.agentName ? getAgentDefinition(scope.config, worktree.agentName) : null,
    action,
  });
}

async function apiAttachAgentsWorktree(scope: ProjectScope, branch: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = await resolveAgentsWorktree(scope, branch);
  if (!resolved.ok) return resolved.response;

  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.worktree, "chat");
  if (!chatSupport.ok) {
    return errorResponse(chatSupport.error, chatSupport.status);
  }

  const result = chatSupport.data.provider === "claude"
    ? await claudeConversationService.attachWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope))
    : await worktreeConversationService.attachWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope));
  return result.ok
    ? jsonResponse(result.data)
    : errorResponse(result.error, result.status);
}

async function apiGetAgentsWorktreeHistory(scope: ProjectScope, branch: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = await resolveAgentsWorktree(scope, branch);
  if (!resolved.ok) return resolved.response;

  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.worktree, "chat");
  if (!chatSupport.ok) {
    return errorResponse(chatSupport.error, chatSupport.status);
  }

  const result = chatSupport.data.provider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope))
    : await worktreeConversationService.readWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope));
  return result.ok
    ? jsonResponse(result.data)
    : errorResponse(result.error, result.status);
}

async function apiSendAgentsWorktreeMessage(scope: ProjectScope, branch: string, req: Request): Promise<Response> {
  touchDashboardActivity();
  const parsed = await parseJsonBody(req, AgentsSendMessageRequestSchema);
  if (!parsed.ok) return parsed.response;

  const resolved = await resolveAgentsWorktree(scope, branch);
  if (!resolved.ok) return resolved.response;
  if (!resolved.worktree.mux) {
    return errorResponse("Open this worktree in the main dashboard before sending messages here", 409);
  }

  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.worktree, "chat");
  if (!chatSupport.ok) {
    return errorResponse(chatSupport.error, chatSupport.status);
  }

  const conversationResult = chatSupport.data.provider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope))
    : await worktreeConversationService.readWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope));
  if (!conversationResult.ok) {
    return errorResponse(conversationResult.error, conversationResult.status);
  }

  const terminalWorktree = await resolveAgentsTerminalWorktree(scope, branch);
  if (!terminalWorktree.ok) return terminalWorktree.response;
  const sendResult = await sendTerminalPrompt(
    terminalWorktree.data.worktreeId,
    terminalWorktree.data.attachTarget,
    parsed.data.text,
    0,
    undefined,
    chatSupport.data.submitDelayMs,
  );
  if (!sendResult.ok) {
    return errorResponse(sendResult.error, 503);
  }

  // tmux send has no real turn id yet; history replaces this optimistic placeholder on refresh.
  return jsonResponse({
    conversationId: conversationResult.data.conversation.conversationId,
    turnId: `tmux:${crypto.randomUUID()}`,
    running: true,
  });
}

async function apiInterruptAgentsWorktree(scope: ProjectScope, branch: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = await resolveAgentsWorktree(scope, branch);
  if (!resolved.ok) return resolved.response;
  if (!resolved.worktree.mux) {
    return errorResponse("Open this worktree in the main dashboard before interrupting it here", 409);
  }

  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.worktree, "interrupt");
  if (!chatSupport.ok) {
    return errorResponse(chatSupport.error, chatSupport.status);
  }

  const conversationResult = chatSupport.data.provider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope))
    : await worktreeConversationService.readWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope));
  if (!conversationResult.ok) {
    return errorResponse(conversationResult.error, conversationResult.status);
  }

  const terminalWorktree = await resolveAgentsTerminalWorktree(scope, branch);
  if (!terminalWorktree.ok) return terminalWorktree.response;
  const interruptResult = await interruptPrompt(terminalWorktree.data.attachTarget, 0);
  if (!interruptResult.ok) {
    return errorResponse(interruptResult.error, 503);
  }

  const runtimeState = scope.projectRuntime.getWorktreeByBranch(branch);
  if (runtimeState) {
    scope.projectRuntime.applyEvent({
      type: "agent_status_changed",
      worktreeId: runtimeState.worktreeId,
      branch,
      lifecycle: "stopped",
    });
  }

  return jsonResponse({
    conversationId: conversationResult.data.conversation.conversationId,
    turnId: conversationResult.data.conversation.activeTurnId ?? `tmux:${crypto.randomUUID()}`,
    interrupted: true,
  });
}

// ── Scratch session chat ─────────────────────────────────────────────────────

function resolveScratchChatTarget(scope: ProjectScope, id: string): {
  ok: true;
  facade: WorktreeSnapshot;
  attachTarget: { sessionName: string; windowName: string; paneIndex: number };
} | {
  ok: false;
  response: Response;
} {
  const metas = scope.scratchSessionService.list();
  const meta = metas.find((s) => s.id === id);
  if (!meta) {
    return { ok: false, response: errorResponse(`Scratch session not found: ${id}`, 404) };
  }
  if (meta.kind !== "agent" || !meta.agentId) {
    return { ok: false, response: errorResponse("Chat is only available for agent-kind scratch sessions", 404) };
  }
  const chatSupport = resolveAgentChatSupport({
    agentId: meta.agentId,
    agentLabel: meta.agentId,
    agent: getAgentDefinition(scope.config, meta.agentId),
    action: "chat",
  });
  if (!chatSupport.ok) {
    return { ok: false, response: errorResponse(chatSupport.error, chatSupport.status) };
  }
  const windowName = tmux.getFirstWindowName(meta.sessionName);
  if (!windowName) {
    return { ok: false, response: errorResponse("Scratch session has no tmux window", 409) };
  }
  const target = `${meta.sessionName}:${windowName}.0`;
  const probe = probeSessionActivity(tmux, target);
  const { running } = summarizeSessionActivity(probe, () => new Date());
  const agentDef = getAgentDefinition(scope.config, meta.agentId);
  const facade: WorktreeSnapshot = {
    branch: meta.id,
    path: meta.cwd,
    dir: meta.cwd,
    archived: false,
    profile: null,
    agentName: meta.agentId,
    agentLabel: agentDef?.label ?? meta.agentId,
    mux: true,
    dirty: false,
    unpushed: false,
    paneCount: 1,
    status: running ? "running" : "idle",
    elapsed: "",
    services: [],
    prs: [],
    linearIssue: null,
    creation: null,
  };
  return {
    ok: true,
    facade,
    attachTarget: { sessionName: meta.sessionName, windowName, paneIndex: 0 },
  };
}

async function apiAttachAgentsScratchConversation(scope: ProjectScope, id: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = resolveScratchChatTarget(scope, id);
  if (!resolved.ok) return resolved.response;
  const storage = buildTmuxConversationStorage({ tmux, sessionName: resolved.attachTarget.sessionName });
  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.facade, "chat");
  if (!chatSupport.ok) return errorResponse(chatSupport.error, chatSupport.status);
  const result = chatSupport.data.provider === "claude"
    ? await claudeConversationService.attachWorktreeConversation(resolved.facade, buildConversationProbeContext(scope), storage)
    : await worktreeConversationService.attachWorktreeConversation(resolved.facade, buildConversationProbeContext(scope), storage);
  return result.ok ? jsonResponse(result.data) : errorResponse(result.error, result.status);
}

async function apiGetAgentsScratchConversationHistory(scope: ProjectScope, id: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = resolveScratchChatTarget(scope, id);
  if (!resolved.ok) return resolved.response;
  const storage = buildTmuxConversationStorage({ tmux, sessionName: resolved.attachTarget.sessionName });
  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.facade, "chat");
  if (!chatSupport.ok) return errorResponse(chatSupport.error, chatSupport.status);
  const result = chatSupport.data.provider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.facade, buildConversationProbeContext(scope), storage)
    : await worktreeConversationService.readWorktreeConversation(resolved.facade, buildConversationProbeContext(scope), storage);
  return result.ok ? jsonResponse(result.data) : errorResponse(result.error, result.status);
}

async function apiSendAgentsScratchConversationMessage(scope: ProjectScope, id: string, req: Request): Promise<Response> {
  touchDashboardActivity();
  const parsed = await parseJsonBody(req, AgentsSendMessageRequestSchema);
  if (!parsed.ok) return parsed.response;
  const resolved = resolveScratchChatTarget(scope, id);
  if (!resolved.ok) return resolved.response;
  const storage = buildTmuxConversationStorage({ tmux, sessionName: resolved.attachTarget.sessionName });
  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.facade, "chat");
  if (!chatSupport.ok) return errorResponse(chatSupport.error, chatSupport.status);
  const conversationResult = chatSupport.data.provider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.facade, buildConversationProbeContext(scope), storage)
    : await worktreeConversationService.readWorktreeConversation(resolved.facade, buildConversationProbeContext(scope), storage);
  if (!conversationResult.ok) return errorResponse(conversationResult.error, conversationResult.status);
  const attachTarget: import("./adapters/terminal").TerminalAttachTarget = {
    ownerSessionName: resolved.attachTarget.sessionName,
    windowName: resolved.attachTarget.windowName,
  };
  const sendResult = await sendTerminalPrompt(
    `scratch:${id}`,
    attachTarget,
    parsed.data.text,
    resolved.attachTarget.paneIndex,
    undefined,
    chatSupport.data.submitDelayMs,
  );
  if (!sendResult.ok) return errorResponse(sendResult.error, 503);
  return jsonResponse({
    conversationId: conversationResult.data.conversation.conversationId,
    turnId: `tmux:${crypto.randomUUID()}`,
    running: true as const,
  });
}

async function apiInterruptAgentsScratchConversation(scope: ProjectScope, id: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = resolveScratchChatTarget(scope, id);
  if (!resolved.ok) return resolved.response;
  const storage = buildTmuxConversationStorage({ tmux, sessionName: resolved.attachTarget.sessionName });
  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.facade, "interrupt");
  if (!chatSupport.ok) return errorResponse(chatSupport.error, chatSupport.status);
  const conversationResult = chatSupport.data.provider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.facade, buildConversationProbeContext(scope), storage)
    : await worktreeConversationService.readWorktreeConversation(resolved.facade, buildConversationProbeContext(scope), storage);
  if (!conversationResult.ok) return errorResponse(conversationResult.error, conversationResult.status);
  const attachTarget: import("./adapters/terminal").TerminalAttachTarget = {
    ownerSessionName: resolved.attachTarget.sessionName,
    windowName: resolved.attachTarget.windowName,
  };
  const interruptResult = await interruptPrompt(attachTarget, resolved.attachTarget.paneIndex);
  if (!interruptResult.ok) return errorResponse(interruptResult.error, 503);
  return jsonResponse({
    conversationId: conversationResult.data.conversation.conversationId,
    turnId: conversationResult.data.conversation.activeTurnId ?? `tmux:${crypto.randomUUID()}`,
    interrupted: true as const,
  });
}

// ── External session chat ────────────────────────────────────────────────────

function resolveExternalChatTarget(sessionName: string): {
  ok: true;
  facade: WorktreeSnapshot;
  attachTarget: { sessionName: string; windowName: string; paneIndex: number };
  agentProvider: "claude" | "codex";
  submitDelayMs: number;
} | {
  ok: false;
  response: Response;
} {
  const allSessions = tmux.listAllSessions();
  const sessionEntry = allSessions.find((s) => s.name === sessionName);
  if (!sessionEntry) {
    return { ok: false, response: errorResponse(`External session not found: ${sessionName}`, 404) };
  }
  const windowName = tmux.getFirstWindowName(sessionName);
  if (!windowName) {
    return { ok: false, response: errorResponse("External session has no tmux window", 409) };
  }
  const paneTarget = `${sessionName}:${windowName}.0`;
  const currentCommand = tmux.getPaneCurrentCommand(paneTarget);
  const baseName = currentCommand ? currentCommand.split("/").pop() ?? currentCommand : null;
  const agentId = baseName === "claude" ? "claude" : baseName === "codex" ? "codex" : null;
  if (!agentId) {
    return { ok: false, response: errorResponse("Chat is only supported for Claude and Codex sessions", 404) };
  }
  const cwd = tmux.getPaneCurrentPath(paneTarget) ?? sessionName;
  const probe = probeSessionActivity(tmux, paneTarget);
  const { running } = summarizeSessionActivity(probe, () => new Date());
  const agentLabel = agentId === "claude" ? "Claude" : "Codex";
  const facade: WorktreeSnapshot = {
    branch: sessionName,
    path: cwd,
    dir: cwd,
    archived: false,
    profile: null,
    agentName: agentId,
    agentLabel,
    mux: true,
    dirty: false,
    unpushed: false,
    paneCount: 1,
    status: running ? "running" : "idle",
    elapsed: "",
    services: [],
    prs: [],
    linearIssue: null,
    creation: null,
  };
  const submitDelayMs = 200;
  return {
    ok: true,
    facade,
    attachTarget: { sessionName, windowName, paneIndex: 0 },
    agentProvider: agentId,
    submitDelayMs,
  };
}

async function apiAttachAgentsExternalConversation(sessionName: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = resolveExternalChatTarget(sessionName);
  if (!resolved.ok) return resolved.response;
  const storage = buildTmuxConversationStorage({ tmux, sessionName });
  const result = resolved.agentProvider === "claude"
    ? await claudeConversationService.attachWorktreeConversation(resolved.facade, { tmux, projectRoot: sessionName }, storage)
    : await worktreeConversationService.attachWorktreeConversation(resolved.facade, undefined, storage);
  return result.ok ? jsonResponse(result.data) : errorResponse(result.error, result.status);
}

async function apiGetAgentsExternalConversationHistory(sessionName: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = resolveExternalChatTarget(sessionName);
  if (!resolved.ok) return resolved.response;
  const storage = buildTmuxConversationStorage({ tmux, sessionName });
  const result = resolved.agentProvider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.facade, { tmux, projectRoot: sessionName }, storage)
    : await worktreeConversationService.readWorktreeConversation(resolved.facade, undefined, storage);
  return result.ok ? jsonResponse(result.data) : errorResponse(result.error, result.status);
}

async function apiSendAgentsExternalConversationMessage(sessionName: string, req: Request): Promise<Response> {
  touchDashboardActivity();
  const parsed = await parseJsonBody(req, AgentsSendMessageRequestSchema);
  if (!parsed.ok) return parsed.response;
  const resolved = resolveExternalChatTarget(sessionName);
  if (!resolved.ok) return resolved.response;
  const storage = buildTmuxConversationStorage({ tmux, sessionName });
  const conversationResult = resolved.agentProvider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.facade, { tmux, projectRoot: sessionName }, storage)
    : await worktreeConversationService.readWorktreeConversation(resolved.facade, undefined, storage);
  if (!conversationResult.ok) return errorResponse(conversationResult.error, conversationResult.status);
  const attachTarget: import("./adapters/terminal").TerminalAttachTarget = {
    ownerSessionName: resolved.attachTarget.sessionName,
    windowName: resolved.attachTarget.windowName,
  };
  const sendResult = await sendTerminalPrompt(
    `external:${sessionName}`,
    attachTarget,
    parsed.data.text,
    resolved.attachTarget.paneIndex,
    undefined,
    resolved.submitDelayMs,
  );
  if (!sendResult.ok) return errorResponse(sendResult.error, 503);
  return jsonResponse({
    conversationId: conversationResult.data.conversation.conversationId,
    turnId: `tmux:${crypto.randomUUID()}`,
    running: true as const,
  });
}

async function apiInterruptAgentsExternalConversation(sessionName: string): Promise<Response> {
  touchDashboardActivity();
  const resolved = resolveExternalChatTarget(sessionName);
  if (!resolved.ok) return resolved.response;
  const storage = buildTmuxConversationStorage({ tmux, sessionName });
  const conversationResult = resolved.agentProvider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.facade, { tmux, projectRoot: sessionName }, storage)
    : await worktreeConversationService.readWorktreeConversation(resolved.facade, undefined, storage);
  if (!conversationResult.ok) return errorResponse(conversationResult.error, conversationResult.status);
  const attachTarget: import("./adapters/terminal").TerminalAttachTarget = {
    ownerSessionName: resolved.attachTarget.sessionName,
    windowName: resolved.attachTarget.windowName,
  };
  const interruptResult = await interruptPrompt(attachTarget, resolved.attachTarget.paneIndex);
  if (!interruptResult.ok) return errorResponse(interruptResult.error, 503);
  return jsonResponse({
    conversationId: conversationResult.data.conversation.conversationId,
    turnId: conversationResult.data.conversation.activeTurnId ?? `tmux:${crypto.randomUUID()}`,
    interrupted: true as const,
  });
}

async function loadAgentsConversationSnapshot(
  scope: ProjectScope,
  branch: string,
): Promise<{
  ok: true;
  data: AgentsUiWorktreeConversationResponse;
} | {
  ok: false;
  message: string;
}> {
  const resolved = await resolveAgentsWorktree(scope, branch);
  if (!resolved.ok) {
    return {
      ok: false,
      message: await readErrorMessage(resolved.response),
    };
  }

  const chatSupport = resolveWorktreeAgentChatSupport(scope, resolved.worktree, "chat");
  if (!chatSupport.ok) {
    return {
      ok: false,
      message: chatSupport.error,
    };
  }

  const result = chatSupport.data.provider === "claude"
    ? await claudeConversationService.readWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope))
    : await worktreeConversationService.readWorktreeConversation(resolved.worktree, buildConversationProbeContext(scope));
  return result.ok
    ? { ok: true, data: result.data }
    : { ok: false, message: result.error };
}

async function readErrorMessage(response: Response): Promise<string> {
  const contentType = response.headers.get("Content-Type") ?? "";
  if (contentType.includes("application/json")) {
    try {
      const body: unknown = await response.json();
      if (isRecord(body) && typeof body.error === "string" && body.error.length > 0) {
        return body.error;
      }
    } catch {
      // Ignore parse failures and fall through to raw text.
    }
  }

  const text = await response.text();
  return text.length > 0 ? text : `HTTP ${response.status}`;
}

async function openAgentsSocket(
  ws: { readyState: number; send: (data: string) => void; close: (code?: number, reason?: string) => void },
  data: AgentsWsData,
): Promise<void> {
  const scope = runtime.projectRegistry.get(data.projectId);
  if (!scope) {
    const msg = `Project not found: ${data.projectId}`;
    sendAgentsWs(ws, { type: "error", message: msg });
    ws.close(1011, msg.slice(0, 123));
    return;
  }

  const snapshot = await loadAgentsConversationSnapshot(scope, data.branch);
  if (!snapshot.ok) {
    sendAgentsWs(ws, { type: "error", message: snapshot.message });
    ws.close(1011, snapshot.message.slice(0, 123));
    return;
  }

  data.conversationId = snapshot.data.conversation.conversationId;
  sendAgentsWs(ws, {
    type: "snapshot",
    data: snapshot.data,
  });

  if (snapshot.data.conversation.provider !== "codexAppServer") {
    return;
  }

  data.unsubscribe = codexAppServerClient.onNotification((notification) => {
    const notificationThreadId = readAgentsNotificationThreadId(notification);
    if (!notificationThreadId || notificationThreadId !== data.conversationId) return;

    const deltaEvent = buildAgentsUiMessageDeltaEvent(notification);
    if (deltaEvent) {
      sendAgentsWs(ws, deltaEvent);
      return;
    }

    if (!shouldRefreshAgentsConversationSnapshot(notification)) return;

    void (async () => {
      const projScope = runtime.projectRegistry.get(data.projectId);
      if (!projScope) return;
      const nextSnapshot = await loadAgentsConversationSnapshot(projScope, data.branch);
      if (!nextSnapshot.ok) {
        sendAgentsWs(ws, { type: "error", message: nextSnapshot.message });
        return;
      }

      data.conversationId = nextSnapshot.data.conversation.conversationId;
      sendAgentsWs(ws, {
        type: "snapshot",
        data: nextSnapshot.data,
      });
    })();
  });
}

async function apiRuntimeEvent(req: Request): Promise<Response> {
  if (!await hasValidControlToken(req)) {
    return new Response("Unauthorized", { status: 401 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return errorResponse("Invalid JSON", 400);
  }

  // Runtime events are project-scoped; look up project from the event body if present,
  // otherwise fall back to the first project (single-project compat for lifecycle hooks).
  const maybeProjectId = isRecord(raw) && typeof raw.projectId === "string" ? raw.projectId : null;
  let targetScope: ProjectScope | null = null;
  if (maybeProjectId) {
    targetScope = runtime.projectRegistry.get(maybeProjectId);
    if (!targetScope) return errorResponse(`Project not found: ${maybeProjectId}`, 404);
  } else {
    const first = runtime.projectRegistry.list()[0];
    if (first) targetScope = runtime.projectRegistry.get(first.id);
  }

  if (!targetScope) return errorResponse("No project available", 404);
  const scope = targetScope;

  const event = parseRuntimeEvent(raw);
  if (!event) return errorResponse("Invalid runtime event body", 400);

  try {
    scope.projectRuntime.applyEvent(event);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("Unknown worktree id")) {
      await scope.reconciliationService.reconcile(scope.projectDir);
      try {
        scope.projectRuntime.applyEvent(event);
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        if (retryMessage.includes("Unknown worktree id")) {
          return errorResponse(retryMessage, 404);
        }
        throw retryError;
      }
    } else {
      throw error;
    }
  }

  const notification = runtimeNotifications.recordEvent(event, scope.projectId);
  return jsonResponse({
    ok: true,
    ...(notification ? { notification } : {}),
  });
}

async function apiListBranches(scope: ProjectScope, req: Request): Promise<Response> {
  const parsed = parseQuery(req, AvailableBranchesQuerySchema);
  if (!parsed.ok) return parsed.response;

  const includeRemote = parsed.data.includeRemote === true;
  return jsonResponse({
    branches: scope.lifecycleService.listAvailableBranches({ includeRemote }),
  });
}

async function apiListBaseBranches(scope: ProjectScope): Promise<Response> {
  return jsonResponse({
    branches: scope.lifecycleService.listBaseBranches(),
  });
}

async function apiCreateWorktree(scope: ProjectScope, req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, CreateWorktreeRequestSchema);
  if (!parsed.ok) return parsed.response;

  const body = parsed.data;
  const config = scope.config;
  const envOverrides = body.envOverrides && Object.keys(body.envOverrides).length > 0 ? body.envOverrides : undefined;
  const branch = body.branch?.trim() ? body.branch.trim() : undefined;
  const baseBranch = body.baseBranch?.trim() ? body.baseBranch.trim() : undefined;
  const prompt = body.prompt?.trim() ? body.prompt.trim() : undefined;
  const profile = body.profile;
  const agent = body.agent;
  const agents = body.agents;
  const createLinearTicket = body.createLinearTicket === true;
  const linearTitle = body.linearTitle?.trim() ? body.linearTitle.trim() : undefined;
  const mode = body.mode;
  const selectedAgents = agents
    ? agents
    : agent
      ? [agent]
      : [config.workspace.defaultAgent];

  if (baseBranch && !isValidBranchName(baseBranch)) {
    return errorResponse("Invalid base branch name", 400);
  }

  if (createLinearTicket && mode === "existing") {
    return errorResponse("Linear ticket creation is only supported for new branches", 400);
  }

  if (baseBranch && mode === "existing") {
    return errorResponse("Base branch is only supported for new branches", 400);
  }

  if (createLinearTicket && !config.integrations.linear.enabled) {
    return errorResponse("Linear integration is disabled", 400);
  }

  if (createLinearTicket && !config.integrations.linear.createTicketOption) {
    return errorResponse("Linear ticket creation is not enabled for this project", 400);
  }

  if (createLinearTicket && !prompt) {
    return errorResponse("Prompt is required when creating a Linear ticket", 400);
  }

  let resolvedBranch = branch;
  if (createLinearTicket) {
    const title = deriveLinearIssueTitle(linearTitle, prompt);
    if (!title) {
      return errorResponse("Linear ticket title could not be derived from the prompt", 400);
    }

    const teamId = config.integrations.linear.teamId;
    if (!teamId) {
      return errorResponse("Linear teamId is not configured", 503);
    }

    const linearResult = await createLinearIssue({
      title,
      description: prompt ?? "",
      teamId,
    });
    if (!linearResult.ok) {
      return errorResponse(linearResult.error, 502);
    }

    resolvedBranch = linearResult.data.branchName;
    log.info(
      `[linear] created ticket ${linearResult.data.identifier} branch=${linearResult.data.branchName} title="${linearResult.data.title.slice(0, 80)}"`,
    );
  }

  if (resolvedBranch) {
    const targetBranches = buildCreateWorktreeTargets(resolvedBranch, selectedAgents).map((target) => target.branch);
    for (const targetBranch of targetBranches) {
      ensureBranchNotBusy(scope, targetBranch);
    }

    if (baseBranch && targetBranches.some((targetBranch) => targetBranch === baseBranch)) {
      return errorResponse("Base branch must differ from branch name", 400);
    }
  }

  log.info(
    `[worktree:add] mode=${mode ?? "new"}${resolvedBranch ? ` branch=${resolvedBranch}` : ""}${baseBranch ? ` base=${baseBranch}` : ""}${profile ? ` profile=${profile}` : ""} agents=${selectedAgents.join(",")}${createLinearTicket ? " linearTicket=true" : ""}${prompt ? ` prompt="${prompt.slice(0, 80)}"` : ""}`,
  );
  const result = await scope.lifecycleService.createWorktrees({
    mode,
    branch: resolvedBranch,
    baseBranch,
    prompt,
    profile,
    ...(agents && agents.length > 0 ? { agents } : { agent }),
    envOverrides,
    ...(body.yolo === undefined ? {} : { yolo: body.yolo }),
  });
  log.debug(`[worktree:add] done branches=${result.branches.join(",")}`);
  return jsonResponse({
    primaryBranch: result.primaryBranch,
    branches: result.branches,
  }, 201);
}

async function apiDeleteWorktree(scope: ProjectScope, name: string): Promise<Response> {
  return withRemovingBranch(scope, name, async () => {
    log.info(`[worktree:rm] name=${name}`);
    await scope.lifecycleService.removeWorktree(name);
    log.debug(`[worktree:rm] done name=${name}`);
    return jsonResponse({ ok: true });
  });
}

async function apiOpenWorktree(scope: ProjectScope, name: string, req: Request): Promise<Response> {
  ensureBranchNotBusy(scope, name);
  let rawBody: unknown = {};
  try {
    rawBody = await req.json();
  } catch {
    // empty or missing body — treat as no overrides
  }
  const parsed = OpenWorktreeRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return errorResponse(`Invalid request body: ${parsed.error.issues[0]?.message ?? "Invalid request"}`, 400);
  }
  const body = parsed.data;
  const agentOverride = body.agentOverride;
  const shellOnly = body.shellOnly;
  log.info(`[worktree:open] name=${name}`);
  const result = await scope.lifecycleService.openWorktree(name, {
    ...(agentOverride !== undefined ? { agentOverride } : {}),
    ...(shellOnly !== undefined ? { shellOnly } : {}),
  });
  log.debug(`[worktree:open] done name=${name} worktreeId=${result.worktreeId}`);
  return jsonResponse({ ok: true });
}

async function apiCloseWorktree(scope: ProjectScope, name: string): Promise<Response> {
  ensureBranchNotBusy(scope, name);
  log.info(`[worktree:close] name=${name}`);
  await scope.lifecycleService.closeWorktree(name);
  log.debug(`[worktree:close] done name=${name}`);
  return jsonResponse({ ok: true });
}

async function apiSetWorktreeArchived(scope: ProjectScope, name: string, req: Request): Promise<Response> {
  ensureBranchNotBusy(scope, name);
  const parsed = await parseJsonBody(req, SetWorktreeArchivedRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  log.info(`[worktree:archive] name=${name} archived=${body.archived}`);
  await scope.lifecycleService.setWorktreeArchived(name, body.archived);
  log.debug(`[worktree:archive] done name=${name} archived=${body.archived}`);
  return jsonResponse({ ok: true, archived: body.archived });
}

async function apiSendPrompt(scope: ProjectScope, name: string, req: Request): Promise<Response> {
  ensureBranchNotBusy(scope, name);
  const parsed = await parseJsonBody(req, SendWorktreePromptRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const text = body.text;
  const preamble = body.preamble;
  log.info(`[worktree:send] name=${name} text="${text.slice(0, 80)}"`);
  const terminalWorktree = await resolveTerminalWorktree(scope, name);
  const result = await sendTerminalPrompt(
    terminalWorktree.worktreeId,
    terminalWorktree.attachTarget,
    text,
    0,
    preamble,
  );
  if (!result.ok) return errorResponse(result.error, 503);
  return jsonResponse({ ok: true });
}

async function apiMergeWorktree(scope: ProjectScope, name: string): Promise<Response> {
  ensureBranchNotBusy(scope, name);
  log.info(`[worktree:merge] name=${name}`);
  await scope.lifecycleService.mergeWorktree(name);
  log.debug(`[worktree:merge] done name=${name}`);
  return jsonResponse({ ok: true });
}

async function apiUpdateWorktree(scope: ProjectScope, name: string, req: Request): Promise<Response> {
  ensureBranchNotBusy(scope, name);
  const parsed = await parseJsonBody(req, UpdateWorktreeRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  if (body.agent !== undefined) {
    const agentDef = getAgentDefinition(scope.config, body.agent);
    if (!agentDef) return errorResponse(`Unknown agent: ${body.agent}`, 404);
  }

  const gitDirs = await getWorktreeGitDirs(scope);
  const gitDir = gitDirs.get(name);
  if (!gitDir) return errorResponse(`Worktree not found: ${name}`, 404);

  const meta = await readWorktreeMeta(gitDir);
  if (!meta) return errorResponse(`Worktree is not webmux-managed: ${name}`, 404);

  if (body.yolo !== undefined) meta.yolo = body.yolo;
  if (body.agent !== undefined) meta.agent = body.agent;

  await writeWorktreeMeta(gitDir, meta);
  log.info(`[worktree:update] name=${name} agent=${body.agent ?? "(unchanged)"} yolo=${body.yolo ?? "(unchanged)"}`);
  return jsonResponse({ ok: true });
}

async function apiListAgents(scope: ProjectScope): Promise<Response> {
  return jsonResponse({ agents: listAgentDetails(scope.config) });
}

async function apiValidateAgent(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, UpsertCustomAgentRequestSchema);
  if (!parsed.ok) return parsed.response;
  return jsonResponse(validateCustomAgentInput(parsed.data));
}

async function apiCreateAgent(scope: ProjectScope, req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, UpsertCustomAgentRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const agentId = normalizeCustomAgentId(body.label);

  if (isBuiltInAgentId(agentId) || scope.config.agents[agentId]) {
    return errorResponse(`Agent already exists: ${agentId}`, 409);
  }

  const agentConfig = {
    label: body.label,
    startCommand: body.startCommand,
    ...(body.resumeCommand?.trim() ? { resumeCommand: body.resumeCommand.trim() } : {}),
  };

  await persistLocalCustomAgent(scope.projectDir, agentId, agentConfig);
  scope.config.agents[agentId] = agentConfig;

  const agent = listAgentDetails(scope.config).find((entry) => entry.id === agentId);
  if (!agent) {
    return errorResponse(`Created agent could not be loaded: ${agentId}`, 500);
  }

  return jsonResponse({ agent });
}

async function apiUpdateAgent(scope: ProjectScope, agentId: string, req: Request): Promise<Response> {
  if (isBuiltInAgentId(agentId)) {
    return errorResponse(`Built-in agent cannot be edited: ${agentId}`, 400);
  }
  if (!scope.config.agents[agentId]) {
    return errorResponse(`Unknown agent: ${agentId}`, 404);
  }

  const parsed = await parseJsonBody(req, UpsertCustomAgentRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;
  const agentConfig = {
    label: body.label,
    startCommand: body.startCommand,
    ...(body.resumeCommand?.trim() ? { resumeCommand: body.resumeCommand.trim() } : {}),
  };

  await persistLocalCustomAgent(scope.projectDir, agentId, agentConfig);
  scope.config.agents[agentId] = agentConfig;

  const agent = listAgentDetails(scope.config).find((entry) => entry.id === agentId);
  if (!agent) {
    return errorResponse(`Updated agent could not be loaded: ${agentId}`, 500);
  }

  return jsonResponse({ agent });
}

async function apiDeleteAgent(scope: ProjectScope, agentId: string): Promise<Response> {
  if (isBuiltInAgentId(agentId)) {
    return errorResponse(`Built-in agent cannot be deleted: ${agentId}`, 400);
  }
  if (!scope.config.agents[agentId]) {
    return errorResponse(`Unknown agent: ${agentId}`, 404);
  }

  await removeLocalCustomAgent(scope.projectDir, agentId);
  delete scope.config.agents[agentId];
  return jsonResponse({ ok: true });
}

function listKnownProfileNames(): string[] {
  const names = new Set<string>();
  for (const info of runtime.projectRegistry.list()) {
    const scope = runtime.projectRegistry.get(info.id);
    if (!scope) continue;
    for (const name of Object.keys(scope.config.profiles)) names.add(name);
  }
  return [...names].sort();
}

async function apiGetPreferences(): Promise<Response> {
  const prefs = await runtime.preferencesGateway.load();
  return jsonResponse({ preferences: prefs, knownProfiles: listKnownProfileNames() });
}

async function apiUpdatePreferences(req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, UpdateUserPreferencesRequestSchema);
  if (!parsed.ok) return parsed.response;

  const next: UserPreferences = {
    schemaVersion: 1,
    ...(parsed.data.defaultAgent !== undefined ? { defaultAgent: parsed.data.defaultAgent } : {}),
    ...(parsed.data.defaultProfile !== undefined ? { defaultProfile: parsed.data.defaultProfile } : {}),
    ...(parsed.data.agents !== undefined ? { agents: parsed.data.agents } : {}),
    ...(parsed.data.autoName !== undefined ? { autoName: parsed.data.autoName } : {}),
  };

  await runtime.preferencesGateway.save(next);

  for (const info of runtime.projectRegistry.list()) {
    const scope = runtime.projectRegistry.get(info.id);
    if (!scope) continue;
    try {
      scope.refreshConfig(next);
    } catch (err) {
      log.warn(`[preferences] refreshConfig failed for ${info.id}: ${err instanceof Error ? err.message : err}`);
    }
  }

  return jsonResponse({ preferences: next, knownProfiles: listKnownProfileNames() });
}

async function apiSetLinearAutoCreate(scope: ProjectScope, req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, ToggleEnabledRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  linearAutoCreateEnabledByProject.set(scope.projectId, body.enabled);
  if (body.enabled) {
    resetProcessedIssues();
    startLinearAutoCreate(scope);
    log.info("[config] Linear auto-create worktrees enabled");
  } else {
    stopLinearAutoCreateMonitor(scope);
    log.info("[config] Linear auto-create worktrees disabled");
  }

  await persistLocalLinearConfig(scope.projectDir, { autoCreateWorktrees: body.enabled });

  return jsonResponse({ ok: true, enabled: body.enabled });
}

async function apiSetAutoRemoveOnMerge(scope: ProjectScope, req: Request): Promise<Response> {
  const parsed = await parseJsonBody(req, ToggleEnabledRequestSchema);
  if (!parsed.ok) return parsed.response;
  const body = parsed.data;

  autoRemoveOnMergeEnabledByProject.set(scope.projectId, body.enabled);
  log.info(`[config] Auto-remove on merge ${body.enabled ? "enabled" : "disabled"}`);

  await persistLocalGitHubConfig(scope.projectDir, { autoRemoveOnMerge: body.enabled });

  return jsonResponse({ ok: true, enabled: body.enabled });
}

async function apiPullMain(scope: ProjectScope, req: Request): Promise<Response> {
  const raw: unknown = await req.json().catch(() => ({}));
  const parsed = PullMainRequestSchema.safeParse(raw);
  if (!parsed.success) {
    return errorResponse("Invalid request body", 400);
  }
  const force = parsed.data.force === true;
  const repo = parsed.data.repo ?? "";

  let projectRoot = scope.projectDir;
  if (repo) {
    const linkedRepo = scope.config.integrations.github.linkedRepos.find((lr) => lr.alias === repo);
    if (!linkedRepo) return errorResponse(`Unknown linked repo: ${repo}`, 404);
    if (!linkedRepo.dir) return errorResponse(`Linked repo "${repo}" has no dir configured`, 400);
    const resolvedDir = resolve(scope.projectDir, linkedRepo.dir);
    const repoRoot = git.resolveRepoRoot(resolvedDir);
    if (!repoRoot) return errorResponse(`Linked repo "${repo}" dir is not a git repository: ${resolvedDir}`, 400);
    projectRoot = repoRoot;
  }

  // NOTE: linked repos inherit the project's mainBranch setting — if a linked
  // repo uses a different default branch this will need a per-repo override.
  const deps = { git, projectRoot, mainBranch: scope.config.workspace.mainBranch };
  const result = force ? forcePullMainBranch(deps) : pullMainBranch(deps);

  log.info(`[pull-main] ${repo || "main"} ${force ? "force " : ""}pull: ${result.status}`);
  return jsonResponse(result);
}

async function apiGetLinearIssues(scope: ProjectScope): Promise<Response> {
  const apiKey = Bun.env.LINEAR_API_KEY;
  const fetchResult = scope.config.integrations.linear.enabled && apiKey?.trim()
    ? await fetchAssignedIssues()
    : undefined;
  const result = buildLinearIssuesResponse({
    integrationEnabled: scope.config.integrations.linear.enabled,
    apiKey,
    fetchResult,
  });
  if (!result.ok) return errorResponse(result.error, 502);
  return jsonResponse(result.data);
}

const MAX_DIFF_BYTES = 200 * 1024;

async function apiGetWorktreeDiff(scope: ProjectScope, name: string): Promise<Response> {
  await scope.reconciliationService.reconcile(scope.projectDir);
  const state = scope.projectRuntime.getWorktreeByBranch(name);
  if (!state) return errorResponse(`Worktree not found: ${name}`, 404);

  const uncommitted = git.readDiff(state.path);
  const gitStatus = git.readStatus(state.path);
  const unpushedCommits = git.listUnpushedCommits(state.path);

  const truncated = uncommitted.length > MAX_DIFF_BYTES;
  return jsonResponse({
    uncommitted: truncated ? uncommitted.slice(0, MAX_DIFF_BYTES) : uncommitted,
    uncommittedTruncated: truncated,
    gitStatus,
    unpushedCommits,
  });
}

async function apiCiLogs(runId: number): Promise<Response> {
  const proc = Bun.spawn(["gh", "run", "view", String(runId), "--log-failed"], {
    stdout: "pipe",
    stderr: "pipe",
  });
  const exitCode = await proc.exited;
  if (exitCode === 0) {
    const logs = await new Response(proc.stdout).text();
    return jsonResponse({ logs });
  }
  const stderr = (await new Response(proc.stderr).text()).trim();
  return errorResponse(`Failed to fetch logs: ${stderr || "unknown error"}`, 502);
}

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function sanitizeFilename(name: string): string {
  // Strip directory components, replace unsafe chars
  const base = name.split("/").pop()?.split("\\").pop() ?? "upload";
  return base.replace(/[^a-zA-Z0-9._-]/g, "_") || "upload";
}

async function apiUploadFiles(scope: ProjectScope, name: string, req: Request): Promise<Response> {
  const state = scope.projectRuntime.getWorktreeByBranch(name);
  if (!state) return errorResponse(`Worktree not found: ${name}`, 404);

  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return errorResponse("Invalid multipart form data", 400);
  }

  const entries = formData.getAll("files");
  if (entries.length === 0) return errorResponse("No files provided", 400);

  const uploadDir = `/tmp/webmux-uploads/${sanitizeFilename(name)}`;
  mkdirSync(uploadDir, { recursive: true });

  const results: Array<{ path: string }> = [];
  for (const entry of entries) {
    if (!(entry instanceof File)) continue;
    if (!ALLOWED_IMAGE_TYPES.has(entry.type)) {
      return errorResponse(`Unsupported file type: ${entry.type}`, 400);
    }
    if (entry.size > MAX_FILE_SIZE) {
      return errorResponse(`File too large: ${entry.name} (max 10MB)`, 400);
    }
    const safeName = `${Date.now()}_${sanitizeFilename(entry.name)}`;
    const destPath = join(uploadDir, safeName);
    if (!resolve(destPath).startsWith(uploadDir + "/")) {
      return errorResponse("Invalid filename", 400);
    }
    await Bun.write(destPath, entry);
    results.push({ path: destPath });
  }

  log.info(`[upload] branch=${name} files=${results.length}`);
  return jsonResponse({ files: results });
}

function parseWorktreeNameParam(params: Record<string, string>):
  | { ok: true; data: string }
  | { ok: false; response: Response } {
  const parsed = parseParams(params, WorktreeNameParamsSchema);
  if (!parsed.ok) return parsed;
  if (!isValidWorktreeName(parsed.data.name)) {
    return {
      ok: false,
      response: errorResponse("Invalid worktree name", 400),
    };
  }
  return {
    ok: true,
    data: parsed.data.name,
  };
}

function parseRunIdParam(params: Record<string, string>):
  | { ok: true; data: number }
  | { ok: false; response: Response } {
  const parsed = parseParams(params, RunIdParamsSchema);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    data: parsed.data.runId,
  };
}

function parseNotificationIdParam(params: Record<string, string>):
  | { ok: true; data: number }
  | { ok: false; response: Response } {
  const parsed = parseParams(params, NotificationIdParamsSchema);
  if (!parsed.ok) return parsed;
  return {
    ok: true,
    data: parsed.data.id,
  };
}

function parseAgentIdParam(params: Record<string, string>):
  | { ok: true; data: string }
  | { ok: false; response: Response } {
  const agentId = params.id?.trim();
  if (!agentId) {
    return {
      ok: false,
      response: errorResponse("Invalid agent id", 400),
    };
  }
  return {
    ok: true,
    data: agentId,
  };
}

function parseProjectIdParam(
  params: Record<string, string>,
): { ok: true; data: { id: string; scope: ProjectScope } } | { ok: false; response: Response } {
  const id = params.projectId;
  if (!id || id.length === 0) {
    return { ok: false, response: errorResponse("Missing projectId", 400) };
  }
  const scope = runtime.projectRegistry.get(id);
  if (!scope) {
    return { ok: false, response: errorResponse(`Project not found: ${id}`, 404) };
  }
  return { ok: true, data: { id, scope } };
}

// --- Project registry handlers ---

async function apiListProjects(): Promise<Response> {
  return jsonResponse({ projects: runtime.projectRegistry.list() });
}

async function apiCreateProject(req: Request): Promise<Response> {
  const body = CreateProjectRequestSchema.parse(await req.json());
  const project = await runtime.projectRegistry.add(body);
  return jsonResponse({ project }, 201);
}

async function apiRemoveProject(id: string, req: Request): Promise<Response> {
  const body = RemoveProjectRequestSchema.parse(await req.json());
  await runtime.projectRegistry.remove(id, { killSessions: body.killSessions ?? false });
  return jsonResponse({ ok: true });
}

// --- Server ---

Bun.serve({
  port: PORT,
  idleTimeout: 255, // seconds; worktree removal can take >10s

  routes: {
    [apiPaths.streamAgentsWorktreeConversation]: (req, server) => {
      const projectId = decodeURIComponent(req.params.projectId);
      const branch = decodeURIComponent(req.params.name);
      const scope = runtime.projectRegistry.get(projectId);
      if (!scope) return new Response("Project not found", { status: 404 });
      return server.upgrade(req, { data: { kind: "agents", projectId, branch, conversationId: null, unsubscribe: null } })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    },

    "/ws/projects/:projectId/:worktree": (req, server) => {
      const projectId = decodeURIComponent(req.params.projectId);
      const branch = decodeURIComponent(req.params.worktree);
      const scope = runtime.projectRegistry.get(projectId);
      if (!scope) return new Response("Project not found", { status: 404 });
      return server.upgrade(req, {
        data: { kind: "terminal", projectId, branch, worktreeId: null, attachId: null, attached: false },
      })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    },

    "/ws/external/:sessionName": (req, server) => {
      const sessionName = decodeURIComponent(req.params.sessionName);
      return server.upgrade(req, {
        data: { kind: "terminal-external", sessionName, attachId: null, attached: false },
      })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    },

    "/ws/projects/:projectId/scratch/:id": (req, server) => {
      const projectId = decodeURIComponent(req.params.projectId);
      const id = decodeURIComponent(req.params.id);
      const scope = runtime.projectRegistry.get(projectId);
      if (!scope) return new Response("Project not found", { status: 404 });
      const meta = scope.scratchSessionService.list().find((s) => s.id === id);
      if (!meta) return new Response("Scratch session not found", { status: 404 });
      return server.upgrade(req, {
        data: {
          kind: "terminal-scratch",
          projectId,
          scratchId: id,
          sessionName: meta.sessionName,
          attachId: null,
          attached: false,
        },
      })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    },

    [apiPaths.fetchPreferences]: {
      GET: () => catching("GET /api/preferences", () => apiGetPreferences()),
      PUT: (req) => catching("PUT /api/preferences", () => apiUpdatePreferences(req)),
    },

    [apiPaths.fetchConfig]: {
      GET: (req) => {
        const url = new URL(req.url);
        const projectId = url.searchParams.get("projectId");
        const scope = projectId
          ? runtime.projectRegistry.get(projectId)
          : (() => {
              const first = runtime.projectRegistry.list()[0];
              return first ? runtime.projectRegistry.get(first.id) : null;
            })();
        if (!scope) return errorResponse("No project available", 404);
        return jsonResponse(getFrontendConfig(scope));
      },
    },

    [apiPaths.fetchExternalSessions]: {
      GET: () => catching("GET /api/external-sessions", () => apiListExternalSessions()),
    },

    [apiPaths.fetchProjects]: {
      GET: () => catching("GET /api/projects", () => apiListProjects()),
      POST: (req) => catching("POST /api/projects", () => apiCreateProject(req)),
    },

    [apiPaths.removeProject]: {
      DELETE: (req) => {
        const id = req.params.projectId;
        if (!id || id.length === 0) return errorResponse("Missing projectId", 400);
        return catching("DELETE /api/projects/:projectId", () => apiRemoveProject(id, req));
      },
    },

    [apiPaths.fetchAvailableBranches]: {
      GET: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("GET /api/projects/:projectId/branches", () => apiListBranches(parsed.data.scope, req));
      },
    },

    [apiPaths.fetchBaseBranches]: {
      GET: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("GET /api/projects/:projectId/base-branches", () => apiListBaseBranches(parsed.data.scope));
      },
    },

    [apiPaths.fetchProject]: {
      GET: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("GET /api/projects/:projectId/project", () => apiGetProject(parsed.data.scope));
      },
    },

    [apiPaths.fetchAgents]: {
      GET: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("GET /api/projects/:projectId/agents", () => apiListAgents(parsed.data.scope));
      },
      POST: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("POST /api/projects/:projectId/agents", () => apiCreateAgent(parsed.data.scope, req));
      },
    },

    [apiPaths.validateAgent]: {
      POST: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("POST /api/projects/:projectId/agents/validate", () => apiValidateAgent(req));
      },
    },

    [apiPaths.updateAgent]: {
      PUT: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsedAgent = parseAgentIdParam(req.params);
        if (!parsedAgent.ok) return parsedAgent.response;
        return catching("PUT /api/projects/:projectId/agents/:id", () => apiUpdateAgent(parsedProject.data.scope, parsedAgent.data, req));
      },
      DELETE: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsedAgent = parseAgentIdParam(req.params);
        if (!parsedAgent.ok) return parsedAgent.response;
        return catching("DELETE /api/projects/:projectId/agents/:id", () => apiDeleteAgent(parsedProject.data.scope, parsedAgent.data));
      },
    },

    [apiPaths.attachAgentsWorktreeConversation]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`POST ${apiPaths.attachAgentsWorktreeConversation}`, () => apiAttachAgentsWorktree(parsedProject.data.scope, name));
      },
    },

    [apiPaths.fetchAgentsWorktreeConversationHistory]: {
      GET: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`GET ${apiPaths.fetchAgentsWorktreeConversationHistory}`, () => apiGetAgentsWorktreeHistory(parsedProject.data.scope, name));
      },
    },

    [apiPaths.sendAgentsWorktreeConversationMessage]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(
          `POST ${apiPaths.sendAgentsWorktreeConversationMessage}`,
          () => apiSendAgentsWorktreeMessage(parsedProject.data.scope, name, req),
        );
      },
    },

    [apiPaths.interruptAgentsWorktreeConversation]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(
          `POST ${apiPaths.interruptAgentsWorktreeConversation}`,
          () => apiInterruptAgentsWorktree(parsedProject.data.scope, name),
        );
      },
    },

    "/api/runtime/events": {
      POST: (req) => catching("POST /api/runtime/events", () => apiRuntimeEvent(req)),
    },

    [apiPaths.fetchScratchSessions]: {
      GET: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("GET /api/projects/:projectId/scratch-sessions", () => apiListScratchSessions(parsed.data.scope));
      },
      POST: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("POST /api/projects/:projectId/scratch-sessions", () => apiCreateScratchSession(parsed.data.scope, req));
      },
    },

    [apiPaths.removeScratchSession]: {
      DELETE: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseScratchSessionIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("DELETE /api/projects/:projectId/scratch-sessions/:id", () => apiRemoveScratchSession(parsedProject.data.scope, parsed.data));
      },
    },

    [apiPaths.attachAgentsScratchConversation]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseScratchSessionIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching(`POST ${apiPaths.attachAgentsScratchConversation}`, () => apiAttachAgentsScratchConversation(parsedProject.data.scope, parsed.data));
      },
    },

    [apiPaths.fetchAgentsScratchConversationHistory]: {
      GET: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseScratchSessionIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching(`GET ${apiPaths.fetchAgentsScratchConversationHistory}`, () => apiGetAgentsScratchConversationHistory(parsedProject.data.scope, parsed.data));
      },
    },

    [apiPaths.sendAgentsScratchConversationMessage]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseScratchSessionIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching(`POST ${apiPaths.sendAgentsScratchConversationMessage}`, () => apiSendAgentsScratchConversationMessage(parsedProject.data.scope, parsed.data, req));
      },
    },

    [apiPaths.interruptAgentsScratchConversation]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseScratchSessionIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching(`POST ${apiPaths.interruptAgentsScratchConversation}`, () => apiInterruptAgentsScratchConversation(parsedProject.data.scope, parsed.data));
      },
    },

    [apiPaths.attachAgentsExternalConversation]: {
      POST: (req) => {
        const name = req.params.name;
        if (!name || name.length === 0) return errorResponse("Missing session name", 400);
        return catching(`POST ${apiPaths.attachAgentsExternalConversation}`, () => apiAttachAgentsExternalConversation(name));
      },
    },

    [apiPaths.fetchAgentsExternalConversationHistory]: {
      GET: (req) => {
        const name = req.params.name;
        if (!name || name.length === 0) return errorResponse("Missing session name", 400);
        return catching(`GET ${apiPaths.fetchAgentsExternalConversationHistory}`, () => apiGetAgentsExternalConversationHistory(name));
      },
    },

    [apiPaths.sendAgentsExternalConversationMessage]: {
      POST: (req) => {
        const name = req.params.name;
        if (!name || name.length === 0) return errorResponse("Missing session name", 400);
        return catching(`POST ${apiPaths.sendAgentsExternalConversationMessage}`, () => apiSendAgentsExternalConversationMessage(name, req));
      },
    },

    [apiPaths.interruptAgentsExternalConversation]: {
      POST: (req) => {
        const name = req.params.name;
        if (!name || name.length === 0) return errorResponse("Missing session name", 400);
        return catching(`POST ${apiPaths.interruptAgentsExternalConversation}`, () => apiInterruptAgentsExternalConversation(name));
      },
    },

    [apiPaths.fetchWorktrees]: {
      GET: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("GET /api/projects/:projectId/worktrees", () => apiGetWorktrees(parsed.data.scope));
      },
      POST: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("POST /api/projects/:projectId/worktrees", () => apiCreateWorktree(parsed.data.scope, req));
      },
    },

    [apiPaths.removeWorktree]: {
      DELETE: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`DELETE /api/projects/:projectId/worktrees/${name}`, () => apiDeleteWorktree(parsedProject.data.scope, name));
      },
      PATCH: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`PATCH /api/projects/:projectId/worktrees/${name}`, () => apiUpdateWorktree(parsedProject.data.scope, name, req));
      },
    },

    [apiPaths.openWorktree]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`POST /api/projects/:projectId/worktrees/${name}/open`, () => apiOpenWorktree(parsedProject.data.scope, name, req));
      },
    },

    "/api/projects/:projectId/worktrees/:name/terminal-launch": {
      GET: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`GET /api/projects/:projectId/worktrees/${name}/terminal-launch`, () => apiGetNativeTerminalLaunch(parsedProject.data.scope, name));
      },
    },

    [apiPaths.closeWorktree]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`POST /api/projects/:projectId/worktrees/${name}/close`, () => apiCloseWorktree(parsedProject.data.scope, name));
      },
    },

    [apiPaths.setWorktreeArchived]: {
      PUT: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`PUT /api/projects/:projectId/worktrees/${name}/archive`, () => apiSetWorktreeArchived(parsedProject.data.scope, name, req));
      },
    },

    [apiPaths.sendWorktreePrompt]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`POST /api/projects/:projectId/worktrees/${name}/send`, () => apiSendPrompt(parsedProject.data.scope, name, req));
      },
    },

    "/api/projects/:projectId/worktrees/:name/upload": {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`POST /api/projects/:projectId/worktrees/${name}/upload`, () => apiUploadFiles(parsedProject.data.scope, name, req));
      },
    },

    [apiPaths.mergeWorktree]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`POST /api/projects/:projectId/worktrees/${name}/merge`, () => apiMergeWorktree(parsedProject.data.scope, name));
      },
    },

    [apiPaths.fetchWorktreeDiff]: {
      GET: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseWorktreeNameParam(req.params);
        if (!parsed.ok) return parsed.response;
        const name = parsed.data;
        return catching(`GET /api/projects/:projectId/worktrees/${name}/diff`, () => apiGetWorktreeDiff(parsedProject.data.scope, name));
      },
    },

    [apiPaths.fetchLinearIssues]: {
      GET: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("GET /api/projects/:projectId/linear/issues", () => apiGetLinearIssues(parsed.data.scope));
      },
    },

    [apiPaths.setLinearAutoCreate]: {
      PUT: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("PUT /api/projects/:projectId/linear/auto-create", () => apiSetLinearAutoCreate(parsed.data.scope, req));
      },
    },

    [apiPaths.setAutoRemoveOnMerge]: {
      PUT: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("PUT /api/projects/:projectId/github/auto-remove-on-merge", () => apiSetAutoRemoveOnMerge(parsed.data.scope, req));
      },
    },

    [apiPaths.pullMain]: {
      POST: (req) => {
        const parsed = parseProjectIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("POST /api/projects/:projectId/pull-main", () => apiPullMain(parsed.data.scope, req));
      },
    },

    [apiPaths.fetchCiLogs]: {
      GET: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseRunIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching(`GET /api/projects/:projectId/ci-logs/${parsed.data}`, () => apiCiLogs(parsed.data));
      },
    },

    "/api/notifications/stream": {
      GET: () => runtimeNotifications.stream(),
    },

    [apiPaths.dismissNotification]: {
      POST: (req) => {
        const parsedProject = parseProjectIdParam(req.params);
        if (!parsedProject.ok) return parsedProject.response;
        const parsed = parseNotificationIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        const id = parsed.data;
        if (!runtimeNotifications.dismiss(id)) return errorResponse("Not found", 404);
        return jsonResponse({ ok: true });
      },
    },
  },

  async fetch(req) {
    const url = new URL(req.url);
    // Static frontend files in production mode (fallback for unmatched routes)
    if (STATIC_DIR) {
      const rawPath = url.pathname === "/" ? "index.html" : url.pathname;
      const filePath = join(STATIC_DIR, rawPath);
      const staticRoot = resolve(STATIC_DIR);
      // Path traversal protection: resolved path must stay within STATIC_DIR
      if (!resolve(filePath).startsWith(staticRoot + "/")) {
        return new Response("Forbidden", { status: 403 });
      }
      const file = Bun.file(filePath);
      if (await file.exists()) {
        // Vite-hashed assets are immutable — cache forever
        const headers: HeadersInit = rawPath.startsWith("/assets/")
          ? { "Cache-Control": "public, max-age=31536000, immutable" }
          : {};
        return new Response(file, { headers });
      }
      // SPA fallback: serve index.html (never cache so new deploys take effect)
      return new Response(Bun.file(join(STATIC_DIR, "index.html")), {
        headers: { "Cache-Control": "no-cache" },
      });
    }
    return new Response("Not Found", { status: 404 });
  },

  websocket: {
    // WebSocket-specific timeout; keepalive pings prevent idle tab disconnects.
    idleTimeout: 255,
    sendPings: true,
    // Type ws.data via the data property (Bun.serve<T> generic is deprecated)
    data: {} as WsData,

    open(ws) {
      const data = ws.data;
      if (data.kind === "terminal" || data.kind === "terminal-external" || data.kind === "terminal-scratch") {
        const label =
          data.kind === "terminal" ? data.branch :
          data.kind === "terminal-external" ? data.sessionName :
          `scratch:${data.scratchId}`;
        log.debug(`[ws] open ${data.kind} target=${label}`);
        return;
      }

      log.debug(`[ws:agents] open branch=${data.branch}`);
      void openAgentsSocket(ws, data);
    },

    async message(ws, message) {
      const data = ws.data;
      if (data.kind === "agents") {
        log.debug(`[ws:agents] ignoring inbound message branch=${data.branch}`);
        return;
      }

      const msg = parseWsMessage(message);
      if (!msg) {
        sendWs(ws, { type: "error", message: "malformed message" });
        return;
      }

      switch (msg.type) {
        case "input": {
          const attachId = getAttachedSessionId(data, ws);
          if (!attachId) return;
          write(attachId, msg.data);
          break;
        }
        case "sendKeys": {
          const attachId = getAttachedSessionId(data, ws);
          if (!attachId) return;
          await sendKeys(attachId, msg.hexBytes);
          break;
        }
        case "selectPane": {
          const attachId = getAttachedSessionId(data, ws);
          if (!attachId) return;
          log.debug(`[ws] selectPane pane=${msg.pane} kind=${data.kind} attachId=${attachId}`);
          await selectPane(attachId, msg.pane);
          break;
        }
        case "resize":
          if (!data.attached) {
            // Lazy attach: first resize carries initial dimensions. Mark attached
            // before the async work so a re-entrant resize during attach is a no-op.
            data.attached = true;
            try {
              let attachTarget: TerminalAttachTarget;
              let attachIdPrefix: string;
              if (data.kind === "terminal") {
                const projScope = runtime.projectRegistry.get(data.projectId);
                if (!projScope) throw new Error(`Project not found: ${data.projectId}`);
                const terminalWorktree = await resolveTerminalWorktree(projScope, data.branch);
                attachTarget = terminalWorktree.attachTarget;
                attachIdPrefix = terminalWorktree.worktreeId;
                data.worktreeId = terminalWorktree.worktreeId;
              } else if (data.kind === "terminal-external") {
                const windowName = tmux.getFirstWindowName(data.sessionName);
                if (!windowName) throw new Error(`tmux session not found: ${data.sessionName}`);
                attachTarget = { ownerSessionName: data.sessionName, windowName };
                attachIdPrefix = `external-${data.sessionName}`;
              } else {
                // terminal-scratch
                const windowName = tmux.getFirstWindowName(data.sessionName);
                if (!windowName) throw new Error(`scratch tmux session not found: ${data.sessionName}`);
                attachTarget = { ownerSessionName: data.sessionName, windowName };
                attachIdPrefix = `scratch-${data.scratchId}`;
              }

              const attachId = `${attachIdPrefix}:${randomUUID()}`;
              data.attachId = attachId;
              await attach(attachId, attachTarget, msg.cols, msg.rows, msg.initialPane);
              const { onData, onExit } = makeCallbacks(ws);
              setCallbacks(attachId, onData, onExit);
              const scrollback = getScrollback(attachId);
              log.debug(`[ws] attached kind=${data.kind} attachId=${attachId} scrollback=${scrollback.length} bytes`);
              if (scrollback.length > 0) {
                sendWs(ws, { type: "scrollback", data: scrollback });
              }
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              data.attached = false;
              data.attachId = null;
              if (data.kind === "terminal") data.worktreeId = null;
              log.error(`[ws] attach failed kind=${data.kind}: ${errMsg}`);
              sendWs(ws, { type: "error", message: errMsg });
              ws.close(1011, errMsg.slice(0, 123));
            }
          } else {
            const attachId = getAttachedSessionId(data, ws);
            if (!attachId) return;
            await resize(attachId, msg.cols, msg.rows);
          }
          break;
      }
    },

    async close(ws, code, reason) {
      const data = ws.data;
      if (data.kind === "agents") {
        log.debug(`[ws:agents] close branch=${data.branch} code=${code} reason=${reason}`);
        data.unsubscribe?.();
        data.unsubscribe = null;
        return;
      }

      const label =
        data.kind === "terminal" ? `branch=${data.branch} worktreeId=${data.worktreeId}` :
        data.kind === "terminal-external" ? `external=${data.sessionName}` :
        `scratch=${data.scratchId} session=${data.sessionName}`;
      log.debug(`[ws] close ${label} code=${code} reason=${reason} attached=${data.attached} attachId=${data.attachId}`);

      if (data.attachId) {
        clearCallbacks(data.attachId);
        await detach(data.attachId);
      }
    },
  },
});


// Ensure tmux server is running (needs at least one session to persist)
const tmuxCheck = Bun.spawnSync(["tmux", "list-sessions"], { stdout: "pipe", stderr: "pipe" });
if (tmuxCheck.exitCode !== 0) {
  Bun.spawnSync(["tmux", "new-session", "-d", "-s", "0"]);
  log.info("Started tmux session");
}

cleanupStaleSessions();

// Start per-project background monitors
for (const proj of runtime.projectRegistry.list()) {
  const projScope = runtime.projectRegistry.get(proj.id);
  if (!projScope) continue;

  const autoRemoveEnabled = autoRemoveOnMergeEnabledByProject.get(proj.id) ?? false;
  const autoRemoveDeps = buildAutoRemoveDeps(projScope);

  startPrMonitor(
    () => getWorktreeGitDirs(projScope),
    projScope.config.integrations.github.linkedRepos,
    projScope.projectDir,
    undefined,
    hasRecentDashboardActivity,
    async () => {
      if (autoRemoveOnMergeEnabledByProject.get(proj.id) ?? autoRemoveEnabled) {
        await runAutoRemove(autoRemoveDeps);
      }
    },
  );

  if (linearAutoCreateEnabledByProject.get(proj.id) ?? false) {
    startLinearAutoCreate(projScope);
  }

  if (projScope.config.workspace.autoPull.enabled) {
    startAutoPullMonitor(
      { git, projectRoot: projScope.projectDir, mainBranch: projScope.config.workspace.mainBranch },
      projScope.config.workspace.autoPull.intervalSeconds * 1000,
    );
  }
}

log.info(`Dev Dashboard API running at http://localhost:${PORT}`);
const nets = networkInterfaces();
for (const addrs of Object.values(nets)) {
  for (const a of addrs ?? []) {
    if (a.family === "IPv4" && !a.internal) {
      log.info(`  Network: http://${a.address}:${PORT}`);
    }
  }
}
