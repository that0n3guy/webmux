import type {
  AgentId,
  BuiltInAgentId,
  ExternalTmuxSession,
  LinkedLinearIssue,
  PrEntry,
  ProjectInfo,
  ScratchSessionKind,
  ScratchSessionSnapshot,
  ServiceStatus,
  WorktreeCreationPhase,
} from "@webmux/api-contract";

export type {
  AgentsUiConversationEvent,
  AgentsUiConversationMessage,
  AgentsUiConversationMessageDeltaEvent,
  AgentsUiConversationMessageStatus,
  AgentsUiConversationState,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
  AgentCapabilities,
  AgentDetails,
  AgentId,
  AgentKind,
  BuiltInAgentId,
  AgentListResponse,
  AgentResponse,
  AgentSummary,
  ValidateCustomAgentResponse,
  AppConfig,
  AppNotification,
  AvailableBranch,
  AvailableBranchesQuery,
  BranchListResponse,
  CiCheck,
  CreateWorktreeRequest,
  CreateWorktreeResponse,
  LinearIssue,
  LinearIssueAvailability,
  LinearIssueLabel,
  LinearIssueState,
  LinearIssuesResponse,
  LinkedLinearIssue,
  LinkedRepoInfo,
  PrComment,
  PrEntry,
  ProfileConfig,
  ProjectSnapshot,
  ProjectWorktreeSnapshot,
  PullMainResult,
  ServiceConfig,
  UpsertCustomAgentRequest,
  ServiceStatus,
  SetWorktreeArchivedRequest,
  SetWorktreeArchivedResponse,
  UnpushedCommit,
  UpdateWorktreeRequest,
  WorktreeCreationPhase,
  WorktreeCreationState,
  WorktreeCreateMode,
  WorktreeDiffResponse,
  WorktreeListResponse,
} from "@webmux/api-contract";
export type { AgentsSendMessageRequest as AgentsUiSendMessageRequest } from "@webmux/api-contract";
export type { UpdateUserPreferencesRequest, UserPreferences, UserPreferencesAutoName } from "@webmux/api-contract";

export type { ExternalTmuxSession, ProjectInfo, ScratchSessionSnapshot, ScratchSessionKind };

export type Selection =
  | { kind: "worktree"; projectId: string; branch: string }
  | { kind: "scratch"; projectId: string; id: string; sessionName: string }
  | { kind: "external"; sessionName: string };

export type SessionTarget =
  | { kind: "worktree"; projectId: string; branch: string }
  | { kind: "scratch"; projectId: string; scratchId: string }
  | { kind: "external"; sessionName: string };

export interface FileUploadResult {
  files: Array<{ path: string }>;
}

export interface DiffDialogProps {
  branch: string;
  cursorUrl?: string | null;
  onclose: () => void;
}

export interface WorktreeInfo {
  branch: string;
  baseBranch?: string;
  archived: boolean;
  agent: string;
  mux: string;
  path: string;
  dir: string | null;
  dirty: boolean;
  unpushed: boolean;
  status: string;
  elapsed: string;
  profile: string | null;
  agentName: AgentId | null;
  agentLabel: string | null;
  services: ServiceStatus[];
  paneCount: number;
  prs: PrEntry[];
  linearIssue: LinkedLinearIssue | null;
  creating: boolean;
  creationPhase: WorktreeCreationPhase | null;
  yolo: boolean;
}

export interface WorktreeListRow {
  worktree: WorktreeInfo;
  depth: number;
}

export type ToastTone = "info" | "success" | "error";

export interface ToastInput {
  tone: ToastTone;
  message: string;
  detail?: string;
}

export interface UiToastItem extends ToastInput {
  id: string;
  source: "ui";
}

export interface NotificationToastItem extends ToastInput {
  id: string;
  source: "notification";
  notificationId: number;
  branch: string;
}

export type ToastItem = UiToastItem | NotificationToastItem;
