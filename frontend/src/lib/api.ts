import { AgentsUiConversationEventSchema, apiPaths, createApi } from "@webmux/api-contract";
import type { CreateProjectRequest, CreateScratchSessionRequest, OpenWorktreeRequest } from "@webmux/api-contract";
import type {
  AgentDetails,
  AgentResponse,
  AgentsUiConversationEvent,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageRequest,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
  AppNotification,
  ExternalTmuxSession,
  FileUploadResult,
  ProjectInfo,
  ProjectWorktreeSnapshot,
  ScratchSessionSnapshot,
  UpsertCustomAgentRequest,
  ValidateCustomAgentResponse,
  WorktreeInfo,
} from "./types";
import type { SessionTarget } from "./types";

export const api = createApi("");

function mapAgentStatus(status: string): string {
  switch (status) {
    case "creating":
    case "running":
    case "starting":
      return "working";
    case "idle":
      return "waiting";
    case "stopped":
      return "done";
    case "error":
      return "error";
    default:
      return "idle";
  }
}

function mapWorktree(snapshot: ProjectWorktreeSnapshot): WorktreeInfo {
  return {
    branch: snapshot.branch,
    ...(snapshot.baseBranch ? { baseBranch: snapshot.baseBranch } : {}),
    archived: snapshot.archived,
    agent: mapAgentStatus(snapshot.status),
    mux: snapshot.mux ? "✓" : "",
    path: snapshot.path,
    dir: snapshot.dir,
    dirty: snapshot.dirty,
    unpushed: snapshot.unpushed,
    status: snapshot.status,
    elapsed: snapshot.elapsed,
    profile: snapshot.profile,
    agentName: snapshot.agentName,
    agentLabel: snapshot.agentLabel,
    services: snapshot.services,
    paneCount: snapshot.paneCount,
    prs: snapshot.prs,
    linearIssue: snapshot.linearIssue,
    creating: snapshot.creation !== null,
    creationPhase: snapshot.creation?.phase ?? null,
    yolo: snapshot.yolo,
  };
}

export async function fetchWorktrees(projectId: string): Promise<WorktreeInfo[]> {
  const response = await api.fetchWorktrees({ params: { projectId } });
  return response.worktrees.map((worktree) => mapWorktree(worktree));
}

export function attachWorktreeConversation(projectId: string, branch: string): Promise<AgentsUiWorktreeConversationResponse> {
  return api.attachAgentsWorktreeConversation({
    params: { projectId, name: branch },
  });
}

export function fetchWorktreeConversationHistory(projectId: string, branch: string): Promise<AgentsUiWorktreeConversationResponse> {
  return api.fetchAgentsWorktreeConversationHistory({
    params: { projectId, name: branch },
  });
}

export function sendWorktreeConversationMessage(
  projectId: string,
  branch: string,
  body: AgentsUiSendMessageRequest,
): Promise<AgentsUiSendMessageResponse> {
  return api.sendAgentsWorktreeConversationMessage({
    params: { projectId, name: branch },
    body,
  });
}

export function interruptWorktreeConversation(projectId: string, branch: string): Promise<AgentsUiInterruptResponse> {
  return api.interruptAgentsWorktreeConversation({
    params: { projectId, name: branch },
  });
}

export function attachScratchConversation(projectId: string, scratchId: string): Promise<AgentsUiWorktreeConversationResponse> {
  return api.attachAgentsScratchConversation({
    params: { projectId, id: scratchId },
  });
}

export function fetchScratchConversationHistory(projectId: string, scratchId: string): Promise<AgentsUiWorktreeConversationResponse> {
  return api.fetchAgentsScratchConversationHistory({
    params: { projectId, id: scratchId },
  });
}

export function sendScratchConversationMessage(
  projectId: string,
  scratchId: string,
  body: AgentsUiSendMessageRequest,
): Promise<AgentsUiSendMessageResponse> {
  return api.sendAgentsScratchConversationMessage({
    params: { projectId, id: scratchId },
    body,
  });
}

export function interruptScratchConversation(projectId: string, scratchId: string): Promise<AgentsUiInterruptResponse> {
  return api.interruptAgentsScratchConversation({
    params: { projectId, id: scratchId },
  });
}

export function attachExternalConversation(name: string): Promise<AgentsUiWorktreeConversationResponse> {
  return api.attachAgentsExternalConversation({
    params: { name },
  });
}

export function fetchExternalConversationHistory(name: string): Promise<AgentsUiWorktreeConversationResponse> {
  return api.fetchAgentsExternalConversationHistory({
    params: { name },
  });
}

export function sendExternalConversationMessage(
  name: string,
  body: AgentsUiSendMessageRequest,
): Promise<AgentsUiSendMessageResponse> {
  return api.sendAgentsExternalConversationMessage({
    params: { name },
    body,
  });
}

export function interruptExternalConversation(name: string): Promise<AgentsUiInterruptResponse> {
  return api.interruptAgentsExternalConversation({
    params: { name },
  });
}

function withProjectAndWorktree(path: string, projectId: string, branch: string): string {
  return path.replace(":projectId", encodeURIComponent(projectId)).replace(":name", encodeURIComponent(branch));
}

export function connectWorktreeConversationStream(
  projectId: string,
  branch: string,
  callbacks: {
    onEvent: (event: AgentsUiConversationEvent) => void;
    onError: (message: string) => void;
    onClose?: () => void;
  },
): () => void {
  return openConversationStream(
    withProjectAndWorktree(apiPaths.streamAgentsWorktreeConversation, projectId, branch),
    callbacks,
  );
}

function openConversationStream(
  wsPath: string,
  callbacks: {
    onEvent: (event: AgentsUiConversationEvent) => void;
    onError: (message: string) => void;
    onClose?: () => void;
  },
): () => void {
  const socket = new WebSocket(
    `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}${wsPath}`,
  );
  let closedByClient = false;

  socket.addEventListener("message", (event) => {
    if (typeof event.data !== "string") return;
    try {
      callbacks.onEvent(AgentsUiConversationEventSchema.parse(JSON.parse(event.data)));
    } catch {
      callbacks.onError("Received malformed conversation stream data");
    }
  });

  socket.addEventListener("error", () => {
    callbacks.onError("Conversation stream connection failed");
  });

  socket.addEventListener("close", () => {
    if (!closedByClient) {
      callbacks.onClose?.();
    }
  });

  return () => {
    closedByClient = true;
    socket.close();
  };
}

export function connectScratchConversationStream(
  projectId: string,
  scratchId: string,
  callbacks: {
    onEvent: (event: AgentsUiConversationEvent) => void;
    onError: (message: string) => void;
    onClose?: () => void;
  },
): () => void {
  const wsPath = apiPaths.streamAgentsScratchConversation
    .replace(":projectId", encodeURIComponent(projectId))
    .replace(":id", encodeURIComponent(scratchId));
  return openConversationStream(wsPath, callbacks);
}

export function connectExternalConversationStream(
  sessionName: string,
  callbacks: {
    onEvent: (event: AgentsUiConversationEvent) => void;
    onError: (message: string) => void;
    onClose?: () => void;
  },
): () => void {
  const wsPath = apiPaths.streamAgentsExternalConversation
    .replace(":name", encodeURIComponent(sessionName));
  return openConversationStream(wsPath, callbacks);
}

export function fetchAgents(projectId: string): Promise<AgentDetails[]> {
  return api.fetchAgents({ params: { projectId } }).then((response) => response.agents);
}

export function createAgent(projectId: string, body: UpsertCustomAgentRequest): Promise<AgentResponse> {
  return api.createAgent({ params: { projectId }, body });
}

export function updateAgent(projectId: string, id: string, body: UpsertCustomAgentRequest): Promise<AgentResponse> {
  return api.updateAgent({ params: { projectId, id }, body });
}

export function deleteAgent(projectId: string, id: string): Promise<void> {
  return api.deleteAgent({ params: { projectId, id } }).then(() => undefined);
}

export function validateAgent(projectId: string, body: UpsertCustomAgentRequest): Promise<ValidateCustomAgentResponse> {
  return api.validateAgent({ params: { projectId }, body });
}

export function subscribeNotifications(
  onNotification: (n: AppNotification) => void,
  onDismiss: (id: number) => void,
  onInitial?: (n: AppNotification) => void,
): () => void {
  const es = new EventSource("/api/notifications/stream");

  es.addEventListener("initial", (e: MessageEvent) => {
    try {
      const n = JSON.parse(e.data as string) as AppNotification;
      onInitial?.(n);
    } catch { /* ignore malformed SSE data */ }
  });

  es.addEventListener("notification", (e: MessageEvent) => {
    try {
      const n = JSON.parse(e.data as string) as AppNotification;
      onNotification(n);
    } catch { /* ignore malformed SSE data */ }
  });

  es.addEventListener("dismiss", (e: MessageEvent) => {
    try {
      const { id } = JSON.parse(e.data as string) as { id: number };
      onDismiss(id);
    } catch { /* ignore malformed SSE data */ }
  });

  return () => es.close();
}

export async function uploadFiles(projectId: string, worktree: string, files: File[]): Promise<FileUploadResult> {
  const form = new FormData();
  for (const file of files) {
    form.append("files", file);
  }
  const res = await fetch(`/api/projects/${encodeURIComponent(projectId)}/worktrees/${encodeURIComponent(worktree)}/upload`, {
    method: "POST",
    body: form,
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data as FileUploadResult;
}

export async function fetchExternalSessions(): Promise<ExternalTmuxSession[]> {
  const r = await api.fetchExternalSessions();
  return r.sessions;
}

export async function fetchScratchSessions(projectId: string): Promise<ScratchSessionSnapshot[]> {
  const r = await api.fetchScratchSessions({ params: { projectId } });
  return r.sessions;
}

export async function createScratchSession(projectId: string, body: CreateScratchSessionRequest): Promise<ScratchSessionSnapshot> {
  const r = await api.createScratchSession({ params: { projectId }, body });
  return r.session;
}

export async function removeScratchSession(projectId: string, id: string): Promise<void> {
  await api.removeScratchSession({ params: { projectId, id } });
}

export async function fetchProjects(): Promise<ProjectInfo[]> {
  const r = await api.fetchProjects();
  return r.projects;
}

export async function createProject(body: CreateProjectRequest): Promise<ProjectInfo> {
  const r = await api.createProject({ body });
  return r.project;
}

export async function removeProject(id: string, killSessions: boolean): Promise<void> {
  await api.removeProject({ params: { projectId: id }, body: { killSessions } });
}

export async function openWorktree(projectId: string, name: string, body: OpenWorktreeRequest = {}): Promise<void> {
  await api.openWorktree({ params: { projectId, name }, body });
}
