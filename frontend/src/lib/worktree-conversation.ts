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

  const pendingFromPrev = prev.messages.filter((message) =>
    message.kind === "user"
      && message.id.startsWith("pending-user:")
      && !next.messages.some((m) => m.kind === "user" && m.turnId === message.turnId),
  );

  if (pendingFromPrev.length === 0) return next;

  return {
    ...next,
    messages: [...next.messages, ...pendingFromPrev],
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
