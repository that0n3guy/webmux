import type { AgentId } from "./config";
import type {
  PrEntry,
  ServiceRuntimeState,
  WorktreeConversationProvider,
  WorktreeConversationMeta,
  WorktreeCreationPhase,
} from "./model";

export interface AgentsUiWorktreeSummary {
  branch: string;
  baseBranch?: string;
  path: string;
  archived: boolean;
  profile: string | null;
  agentName: AgentId | null;
  agentLabel: string | null;
  mux: boolean;
  status: string;
  dirty: boolean;
  unpushed: boolean;
  services: ServiceRuntimeState[];
  prs: PrEntry[];
  creating: boolean;
  creationPhase: WorktreeCreationPhase | null;
  conversation: WorktreeConversationMeta | null;
}

export type AgentsUiConversationMessageStatus = "completed" | "inProgress";

export type AgentsUiConversationMessage =
  | {
      kind: "user";
      id: string;
      turnId: string;
      text: string;
      status: AgentsUiConversationMessageStatus;
      createdAt: string | null;
    }
  | {
      kind: "assistant";
      id: string;
      turnId: string;
      text: string;
      status: AgentsUiConversationMessageStatus;
      createdAt: string | null;
    }
  | {
      kind: "tool";
      id: string;
      turnId: string;
      name: string;
      summary: string;
      status: "running" | "ok" | "error";
      createdAt: string | null;
    }
  | {
      kind: "thinking";
      id: string;
      turnId: string;
      text: string;
      createdAt: string | null;
    };

export interface AgentsUiConversationState {
  provider: WorktreeConversationProvider;
  conversationId: string;
  cwd: string;
  running: boolean;
  activeTurnId: string | null;
  messages: AgentsUiConversationMessage[];
  statusWord?: string | null;
}

export interface AgentsUiWorktreeConversationResponse {
  worktree: AgentsUiWorktreeSummary;
  conversation: AgentsUiConversationState;
}

export interface AgentsUiSendMessageRequest {
  text: string;
}

export interface AgentsUiSendMessageResponse {
  conversationId: string;
  turnId: string;
  running: true;
}

export interface AgentsUiInterruptResponse {
  conversationId: string;
  turnId: string;
  interrupted: true;
}

export interface AgentsUiConversationSnapshotEvent {
  type: "snapshot";
  data: AgentsUiWorktreeConversationResponse;
}

export interface AgentsUiConversationMessageDeltaEvent {
  type: "messageDelta";
  conversationId: string;
  turnId: string;
  itemId: string;
  delta: string;
}

export interface AgentsUiConversationErrorEvent {
  type: "error";
  message: string;
}

export type AgentsUiConversationEvent =
  | AgentsUiConversationSnapshotEvent
  | AgentsUiConversationMessageDeltaEvent
  | AgentsUiConversationErrorEvent;
