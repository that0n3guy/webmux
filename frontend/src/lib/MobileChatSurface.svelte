<script lang="ts">
  import { onMount } from "svelte";
  import {
    applyConversationMessageDelta,
    buildConversationProgressSignature,
    markConversationTurnStarted,
  } from "./worktree-conversation";
  import { makeConversationClient } from "./session-conversation-client";
  import type {
    AgentsUiConversationEvent,
    AgentsUiConversationState,
    AgentsUiWorktreeConversationResponse,
    SessionTarget,
    WorktreeInfo,
  } from "./types";
  import WorktreeConversationPanel from "./WorktreeConversationPanel.svelte";

  interface Props {
    projectId: string;
    worktree?: WorktreeInfo;
    target?: SessionTarget;
  }

  const { projectId, worktree, target }: Props = $props();

  const resolvedTarget = $derived<SessionTarget>(
    target ?? (worktree ? { kind: "worktree", projectId, branch: worktree.branch } : { kind: "worktree", projectId, branch: "" }),
  );

  const client = $derived(makeConversationClient(resolvedTarget));

  let conversation = $state<AgentsUiConversationState | null>(null);
  let conversationError = $state<string | null>(null);
  let conversationLoading = $state(false);
  let composerText = $state("");
  let isSending = $state(false);
  let isInterrupting = $state(false);
  let refreshPollingState = $state<{
    token: number;
    baselineSignature: string | null;
    lastSignature: string | null;
    sawProgress: boolean;
    unchangedTicks: number;
  } | null>(null);
  let streamConnection: {
    conversationId: string;
    disconnect: () => void;
  } | null = null;
  let nextRefreshPollingToken = 1;

  const REFRESH_POLL_INTERVAL_MS = 1000;
  const REFRESH_POLL_SETTLE_TICKS = 3;

  function closeConversationStream(): void {
    streamConnection?.disconnect();
    streamConnection = null;
  }

  function supportsStreaming(nextConversation: AgentsUiConversationState | null): boolean {
    return nextConversation?.provider === "codexAppServer";
  }

  function hasActiveConversationStream(conversationId: string): boolean {
    return streamConnection?.conversationId === conversationId;
  }

  function applyConversationResponse(response: AgentsUiWorktreeConversationResponse): void {
    conversation = response.conversation;
    conversationError = null;
    syncConversationStream();
  }

  function handleConversationStreamFailure(conversationId: string, message: string): void {
    if (!hasActiveConversationStream(conversationId) || !streamConnection) return;
    const currentConnection = streamConnection;
    streamConnection = null;
    currentConnection.disconnect();
    conversationError = message;
  }

  function handleConversationStreamEvent(conversationId: string, event: AgentsUiConversationEvent): void {
    if (!hasActiveConversationStream(conversationId)) return;

    switch (event.type) {
      case "snapshot":
        applyConversationResponse(event.data);
        break;
      case "messageDelta":
        conversation = applyConversationMessageDelta(conversation, event);
        break;
      case "error":
        conversationError = event.message;
        break;
    }
  }

  function syncConversationStream(): void {
    if (!supportsStreaming(conversation)) {
      closeConversationStream();
      return;
    }

    const conversationId = conversation?.conversationId ?? null;
    if (!conversationId) {
      closeConversationStream();
      return;
    }

    if (hasActiveConversationStream(conversationId)) {
      return;
    }

    closeConversationStream();
    const disconnect = client.connectStream({
      onEvent: (event) => {
        handleConversationStreamEvent(conversationId, event);
      },
      onError: (message) => {
        handleConversationStreamFailure(conversationId, message);
      },
      onClose: () => {
        handleConversationStreamFailure(conversationId, "Conversation stream disconnected");
      },
    });
    streamConnection = { conversationId, disconnect };
  }

  function requestConversation(mode: "attach" | "history"): Promise<AgentsUiWorktreeConversationResponse> {
    return mode === "attach" ? client.attach() : client.fetchHistory();
  }

  async function loadConversation(mode: "attach" | "history"): Promise<void> {
    conversationLoading = true;
    conversationError = null;

    try {
      const response = await requestConversation(mode);
      applyConversationResponse(response);
      if (mode === "attach" && response.conversation.running) {
        startRefreshPolling(response.conversation);
      }
    } catch (error) {
      conversationError = error instanceof Error ? error.message : String(error);
    } finally {
      conversationLoading = false;
    }
  }

  function startRefreshPolling(
    baselineConversation: AgentsUiConversationState | null = conversation,
  ): void {
    const baselineSignature = buildConversationProgressSignature(baselineConversation);
    refreshPollingState = {
      token: nextRefreshPollingToken,
      baselineSignature,
      lastSignature: baselineSignature,
      sawProgress: false,
      unchangedTicks: 0,
    };
    nextRefreshPollingToken += 1;
  }

  function updateRefreshPollingState(
    token: number,
    nextConversation: AgentsUiConversationState,
  ): void {
    const currentState = refreshPollingState;
    if (!currentState || currentState.token !== token) return;

    const nextSignature = buildConversationProgressSignature(nextConversation);
    const sawProgress = currentState.sawProgress || nextSignature !== currentState.baselineSignature;
    const unchangedTicks = nextSignature === currentState.lastSignature
      ? currentState.unchangedTicks + 1
      : 0;

    if (sawProgress && unchangedTicks >= REFRESH_POLL_SETTLE_TICKS) {
      refreshPollingState = null;
      return;
    }

    refreshPollingState = {
      ...currentState,
      lastSignature: nextSignature,
      sawProgress,
      unchangedTicks,
    };
  }

  async function sendSelectedConversationMessage(): Promise<void> {
    if (!conversation) return;
    const baselineConversation = conversation;
    const text = composerText.trim();
    if (text.length === 0) return;

    isSending = true;
    conversationError = null;
    try {
      const response = await client.sendMessage({ text });
      composerText = "";
      if (conversation.conversationId !== response.conversationId) {
        conversation = {
          ...conversation,
          conversationId: response.conversationId,
        };
      }
      conversation = markConversationTurnStarted(conversation, response.turnId, text);
      syncConversationStream();
      startRefreshPolling(baselineConversation);
    } catch (error) {
      conversationError = error instanceof Error ? error.message : String(error);
    } finally {
      isSending = false;
    }
  }

  async function interruptSelectedConversation(): Promise<void> {
    if (isInterrupting) return;
    const baselineConversation = conversation;
    isInterrupting = true;
    conversationError = null;
    try {
      await client.interrupt();
      startRefreshPolling(baselineConversation);
    } catch (error) {
      conversationError = error instanceof Error ? error.message : String(error);
    } finally {
      isInterrupting = false;
    }
  }

  onMount(() => {
    void loadConversation("attach");
    return () => {
      closeConversationStream();
    };
  });

  $effect(() => {
    const pollingState = refreshPollingState;
    if (!pollingState) return;

    const token = pollingState.token;
    let requestInFlight = false;

    // Codex websocket deltas help when app-server notifications arrive, but tmux-sent turns can
    // still miss them, so history polling stays active until the conversation snapshot settles.
    const interval = window.setInterval(() => {
      if (!refreshPollingState || refreshPollingState.token !== token || requestInFlight) return;
      requestInFlight = true;
      void (async () => {
        try {
          const response = await requestConversation("history");
          applyConversationResponse(response);
          updateRefreshPollingState(token, response.conversation);
        } catch (error) {
          conversationError = error instanceof Error ? error.message : String(error);
        } finally {
          requestInFlight = false;
        }
      })();
    }, REFRESH_POLL_INTERVAL_MS);

    return () => {
      window.clearInterval(interval);
    };
  });
</script>

<WorktreeConversationPanel
  {worktree}
  target={resolvedTarget}
  {conversation}
  {conversationError}
  {conversationLoading}
  {composerText}
  {isSending}
  {isInterrupting}
  onAttach={() => void loadConversation("attach")}
  onComposerInput={(value) => {
    composerText = value;
  }}
  onInterrupt={() => void interruptSelectedConversation()}
  onRefresh={() => void loadConversation("history")}
  onSend={() => void sendSelectedConversationMessage()}
/>
