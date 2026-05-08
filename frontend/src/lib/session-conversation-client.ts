import type {
  AgentsUiConversationEvent,
  AgentsUiInterruptResponse,
  AgentsUiSendMessageRequest,
  AgentsUiSendMessageResponse,
  AgentsUiWorktreeConversationResponse,
} from "./types";
import type { SessionTarget } from "./types";
import {
  attachExternalConversation,
  attachScratchConversation,
  attachWorktreeConversation,
  connectExternalConversationStream,
  connectScratchConversationStream,
  connectWorktreeConversationStream,
  fetchExternalConversationHistory,
  fetchScratchConversationHistory,
  fetchWorktreeConversationHistory,
  interruptExternalConversation,
  interruptScratchConversation,
  interruptWorktreeConversation,
  sendExternalConversationMessage,
  sendScratchConversationMessage,
  sendWorktreeConversationMessage,
} from "./api";

export interface ConversationClient {
  attach(): Promise<AgentsUiWorktreeConversationResponse>;
  fetchHistory(): Promise<AgentsUiWorktreeConversationResponse>;
  sendMessage(body: AgentsUiSendMessageRequest): Promise<AgentsUiSendMessageResponse>;
  interrupt(): Promise<AgentsUiInterruptResponse>;
  connectStream(callbacks: {
    onEvent: (event: AgentsUiConversationEvent) => void;
    onError: (message: string) => void;
    onClose?: () => void;
  }): () => void;
}

export function makeConversationClient(target: SessionTarget): ConversationClient {
  switch (target.kind) {
    case "worktree":
      return {
        attach: () => attachWorktreeConversation(target.projectId, target.branch),
        fetchHistory: () => fetchWorktreeConversationHistory(target.projectId, target.branch),
        sendMessage: (body) => sendWorktreeConversationMessage(target.projectId, target.branch, body),
        interrupt: () => interruptWorktreeConversation(target.projectId, target.branch),
        connectStream: (callbacks) => connectWorktreeConversationStream(target.projectId, target.branch, callbacks),
      };
    case "scratch":
      return {
        attach: () => attachScratchConversation(target.projectId, target.scratchId),
        fetchHistory: () => fetchScratchConversationHistory(target.projectId, target.scratchId),
        sendMessage: (body) => sendScratchConversationMessage(target.projectId, target.scratchId, body),
        interrupt: () => interruptScratchConversation(target.projectId, target.scratchId),
        connectStream: (callbacks) => connectScratchConversationStream(target.projectId, target.scratchId, callbacks),
      };
    case "external":
      return {
        attach: () => attachExternalConversation(target.sessionName),
        fetchHistory: () => fetchExternalConversationHistory(target.sessionName),
        sendMessage: (body) => sendExternalConversationMessage(target.sessionName, body),
        interrupt: () => interruptExternalConversation(target.sessionName),
        connectStream: (callbacks) => connectExternalConversationStream(target.sessionName, callbacks),
      };
  }
}
