import type {
  AgentsUiConversationMessage,
  AgentsUiConversationMessageDeltaEvent,
  AgentsUiConversationState,
} from "./types";

function buildOptimisticUserMessage(turnId: string, text: string): AgentsUiConversationMessage {
  return {
    id: `pending-user:${turnId}`,
    turnId,
    kind: "user",
    text,
    status: "completed",
    createdAt: new Date().toISOString(),
  };
}

export function applyConversationMessageDelta(
  conversation: AgentsUiConversationState | null,
  event: AgentsUiConversationMessageDeltaEvent,
): AgentsUiConversationState | null {
  if (!conversation || conversation.conversationId !== event.conversationId) return conversation;

  const existingIndex = conversation.messages.findIndex((message) => message.id === event.itemId);
  if (existingIndex === -1) {
    return {
      ...conversation,
      running: true,
      activeTurnId: event.turnId,
      messages: [
        ...conversation.messages,
        {
          id: event.itemId,
          turnId: event.turnId,
          kind: "assistant",
          text: event.delta,
          status: "inProgress",
          createdAt: null,
        },
      ],
    };
  }

  return {
    ...conversation,
    running: true,
    activeTurnId: event.turnId,
    messages: conversation.messages.map((message, index) => {
      if (index !== existingIndex) return message;
      if (message.kind !== "user" && message.kind !== "assistant") return message;
      return {
        ...message,
        text: `${message.text}${event.delta}`,
        status: "inProgress" as const,
      };
    }),
  };
}

export function markConversationTurnStarted(
  conversation: AgentsUiConversationState | null,
  turnId: string,
  text: string,
): AgentsUiConversationState | null {
  if (!conversation) return conversation;

  const nextMessages = conversation.messages.some((message) => message.turnId === turnId && message.kind === "user")
    ? conversation.messages
    : [...conversation.messages, buildOptimisticUserMessage(turnId, text)];

  return {
    ...conversation,
    running: true,
    activeTurnId: turnId,
    messages: nextMessages,
  };
}

export function preservePendingUserMessages(
  prev: AgentsUiConversationState | null,
  next: AgentsUiConversationState,
): AgentsUiConversationState {
  if (!prev || prev.conversationId !== next.conversationId) return next;

  // The send endpoint assigns its own turnId (e.g. "tmux:<uuid>") which never matches
  // the agent's own turnId in the snapshot. Dedupe by text instead. Each snapshot user
  // message is consumed at most once so identical-text resends still work.
  const snapshotTextRemaining = new Map<string, number>();
  for (const message of next.messages) {
    if (message.kind !== "user") continue;
    snapshotTextRemaining.set(message.text, (snapshotTextRemaining.get(message.text) ?? 0) + 1);
  }

  const pendingFromPrev: AgentsUiConversationMessage[] = [];
  for (const message of prev.messages) {
    if (message.kind !== "user") continue;
    if (!message.id.startsWith("pending-user:")) continue;
    const remaining = snapshotTextRemaining.get(message.text) ?? 0;
    if (remaining > 0) {
      snapshotTextRemaining.set(message.text, remaining - 1);
      continue;
    }
    pendingFromPrev.push(message);
  }

  if (pendingFromPrev.length === 0) return next;

  return {
    ...next,
    messages: [...next.messages, ...pendingFromPrev],
  };
}

// ---------------------------------------------------------------------------
// Pending optimistic messages — sessionStorage persistence
//
// Optimistic user messages live only in component state, so component remount
// (worktree switch, view toggle, page reload) drops them. We persist the
// pending entries in sessionStorage keyed by a stable surface key so they
// survive remount until the agent's snapshot includes the real message.
// ---------------------------------------------------------------------------

function buildPendingStorageKey(surfaceKey: string): string {
  return `webmux:pendingChat:${surfaceKey}`;
}

export function loadPendingUserMessages(surfaceKey: string): AgentsUiConversationMessage[] {
  if (typeof sessionStorage === "undefined") return [];
  try {
    const raw = sessionStorage.getItem(buildPendingStorageKey(surfaceKey));
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((entry): entry is AgentsUiConversationMessage =>
      !!entry
        && typeof entry === "object"
        && "id" in entry
        && typeof (entry as { id: unknown }).id === "string"
        && (entry as { id: string }).id.startsWith("pending-user:"),
    );
  } catch {
    return [];
  }
}

export function savePendingUserMessages(
  surfaceKey: string,
  messages: AgentsUiConversationMessage[],
): void {
  if (typeof sessionStorage === "undefined") return;
  const pending = messages.filter((m) =>
    m.kind === "user" && m.id.startsWith("pending-user:"),
  );
  const storageKey = buildPendingStorageKey(surfaceKey);
  if (pending.length === 0) {
    sessionStorage.removeItem(storageKey);
    return;
  }
  try {
    sessionStorage.setItem(storageKey, JSON.stringify(pending));
  } catch {
    /* quota exceeded or unavailable — silent */
  }
}

export function applyPersistedPendingMessages(
  conversation: AgentsUiConversationState,
  persisted: AgentsUiConversationMessage[],
): AgentsUiConversationState {
  if (persisted.length === 0) return conversation;

  const snapshotTextRemaining = new Map<string, number>();
  for (const message of conversation.messages) {
    if (message.kind !== "user") continue;
    snapshotTextRemaining.set(message.text, (snapshotTextRemaining.get(message.text) ?? 0) + 1);
  }

  const toAppend: AgentsUiConversationMessage[] = [];
  for (const message of persisted) {
    const remaining = snapshotTextRemaining.get(message.text) ?? 0;
    if (remaining > 0) {
      snapshotTextRemaining.set(message.text, remaining - 1);
      continue;
    }
    toAppend.push(message);
  }

  if (toAppend.length === 0) return conversation;
  return {
    ...conversation,
    messages: [...conversation.messages, ...toAppend],
  };
}

export function buildConversationProgressSignature(conversation: AgentsUiConversationState | null): string | null {
  if (!conversation) return null;

  const lastMessage = conversation.messages[conversation.messages.length - 1] ?? null;
  const lastMessageStatus = lastMessage && "status" in lastMessage ? lastMessage.status : null;
  const lastMessageTextLength = lastMessage && "text" in lastMessage ? lastMessage.text.length : 0;
  return JSON.stringify({
    conversationId: conversation.conversationId,
    running: conversation.running,
    activeTurnId: conversation.activeTurnId,
    messageCount: conversation.messages.length,
    lastMessageId: lastMessage?.id ?? null,
    lastMessageStatus,
    lastMessageTextLength,
  });
}
