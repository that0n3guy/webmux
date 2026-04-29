<script lang="ts">
  import { tick } from "svelte";
  import type { AgentsUiConversationState, SessionTarget, WorktreeInfo } from "./types";

  interface Props {
    worktree?: WorktreeInfo;
    target?: SessionTarget;
    conversation: AgentsUiConversationState | null;
    conversationError: string | null;
    conversationLoading: boolean;
    composerText: string;
    isSending: boolean;
    isInterrupting?: boolean;
    onAttach: () => void;
    onComposerInput: (value: string) => void;
    onInterrupt: () => void;
    onRefresh: () => void;
    onSend: () => void;
  }

  const {
    worktree,
    target,
    conversation,
    conversationError,
    conversationLoading,
    composerText,
    isSending,
    isInterrupting = false,
    onAttach,
    onComposerInput,
    onInterrupt,
    onRefresh,
    onSend,
  }: Props = $props();

  const agentLabel = $derived(
    worktree?.agentLabel
      ?? (worktree?.agentName === "claude" ? "Claude" : worktree?.agentName === "codex" ? "Codex" : "Agent"),
  );
  const supportsAgentChat = $derived(
    worktree
      ? worktree.agentName === "codex" || worktree.agentName === "claude"
      : target?.kind === "scratch" || target?.kind === "external",
  );
  const chatAvailable = $derived(
    worktree
      ? supportsAgentChat && worktree.mux === "✓"
      : supportsAgentChat,
  );
  const showInterrupt = $derived(chatAvailable && (conversation?.running ?? false));
  const canSend = $derived(
    chatAvailable
      && conversation !== null
      && !conversationLoading
      && composerText.trim().length > 0
      && !isSending
      && !(conversation?.running ?? false),
  );

  let transcriptViewport = $state<HTMLDivElement | null>(null);
  let isPinnedToBottom = $state(true);
  let lastConversationId = $state<string | null>(null);

  function handleTranscriptScroll(): void {
    if (!transcriptViewport) return;
    const distanceFromBottom = transcriptViewport.scrollHeight - transcriptViewport.scrollTop - transcriptViewport.clientHeight;
    isPinnedToBottom = distanceFromBottom < 64;
  }

  function handleComposerInput(event: Event): void {
    const target = event.currentTarget;
    if (!(target instanceof HTMLTextAreaElement)) return;
    onComposerInput(target.value);
  }

  function handleComposerKeydown(event: KeyboardEvent): void {
    if (event.key !== "Enter" || event.shiftKey) return;
    event.preventDefault();
    if (canSend) {
      onSend();
    }
  }

  async function scrollTranscriptToBottom(): Promise<void> {
    await tick();
    transcriptViewport?.scrollTo({
      top: transcriptViewport.scrollHeight,
      behavior: "auto",
    });
  }

  $effect(() => {
    const conversationId = conversation?.conversationId ?? null;
    const messageCount = conversation?.messages.length ?? 0;
    const lastMessageId = messageCount > 0 ? conversation?.messages[messageCount - 1]?.id ?? null : null;
    const lastMsg = messageCount > 0 ? conversation?.messages[messageCount - 1] ?? null : null;
    const lastMessageTextLength = lastMsg && "text" in lastMsg ? lastMsg.text.length : 0;
    if (!conversationId || !transcriptViewport) return;
    if (conversationId !== lastConversationId) {
      isPinnedToBottom = true;
      lastConversationId = conversationId;
    }
    if (!isPinnedToBottom) return;
    void scrollTranscriptToBottom();
    void conversationId;
    void messageCount;
    void lastMessageId;
    void lastMessageTextLength;
  });
</script>

{#snippet interruptButton()}
  <button
    type="button"
    aria-label="Interrupt"
    class="rounded-md border border-danger px-3 py-1.5 text-xs font-medium text-danger hover:bg-danger/10 disabled:cursor-not-allowed disabled:opacity-50"
    onclick={onInterrupt}
    disabled={isInterrupting}
  >
    {isInterrupting ? "Stopping..." : "Interrupt"}
  </button>
{/snippet}

{#if !supportsAgentChat}
  <div class="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted">
    Chat is not available for this session yet.
  </div>
{:else if !chatAvailable}
  <div class="flex flex-1 items-center justify-center px-6 text-center text-sm text-muted">
    Open this worktree first to use chat.
  </div>
{:else}
  <section class="flex min-h-0 flex-1 flex-col overflow-hidden bg-surface">
    {#if conversationError}
      <div class="mx-4 mt-4 rounded-md border border-danger/40 bg-danger/10 px-4 py-3 text-sm text-primary">
        <div>{conversationError}</div>
        <div class="mt-3 flex items-center gap-2">
          <button
            type="button"
            class="rounded-md border border-edge bg-surface px-3 py-1.5 text-xs font-medium text-primary hover:bg-hover"
            onclick={conversation ? onRefresh : onAttach}
            disabled={conversationLoading || isSending}
          >
            {conversation ? "Reconnect" : "Attach"}
          </button>
          {#if showInterrupt}
            {@render interruptButton()}
          {/if}
        </div>
      </div>
    {/if}

    <div class="flex min-h-0 flex-1 flex-col px-4 pt-4">
      <div class="mb-3 flex items-center justify-between gap-3 text-[11px] uppercase tracking-[0.12em] text-muted">
        <div>{conversation?.running ? "Turn in progress" : "Ready"}</div>
        <div>{conversationLoading && !conversation ? `Connecting to ${agentLabel}` : agentLabel}</div>
      </div>

      <div bind:this={transcriptViewport} onscroll={handleTranscriptScroll} class="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto overflow-x-hidden pb-4 pr-1">
        {#if conversationLoading && !conversation}
          <div class="rounded-md border border-edge bg-topbar px-4 py-5 text-sm text-muted">
            Connecting to the {agentLabel} session...
          </div>
        {:else if !conversation || conversation.messages.length === 0}
          <div class="rounded-md border border-edge bg-topbar px-4 py-5 text-sm text-muted">
            No messages yet. Send the first prompt to start this chat.
          </div>
        {:else}
          {#each conversation.messages as message (message.id)}
            {#if message.kind === "user"}
              <div class="max-w-[88%] min-w-0 self-end rounded-2xl bg-accent px-4 py-3 text-sm text-white">
                <div class="whitespace-pre-wrap break-words">{message.text}</div>
              </div>
            {:else if message.kind === "assistant"}
              <div class="max-w-[88%] min-w-0 self-start rounded-2xl border border-edge bg-topbar px-4 py-3 text-sm text-primary">
                <div class="whitespace-pre-wrap break-words">{message.text}</div>
                {#if message.status === "inProgress"}
                  <div class="mt-2 text-[10px] uppercase tracking-[0.12em] text-muted">
                    typing
                  </div>
                {/if}
              </div>
            {:else if message.kind === "tool"}
              <div class="flex min-w-0 items-center gap-1.5 self-start px-1 text-xs text-muted">
                {#if message.status === "running"}
                  <span class="inline-block h-3 w-3 animate-spin rounded-full border border-muted border-t-transparent"></span>
                {:else if message.status === "error"}
                  <span class="text-danger">✗</span>
                {:else}
                  <span class="text-success">✓</span>
                {/if}
                <span class="shrink-0 font-medium">▸ {message.name}</span>
                <span class="truncate overflow-hidden whitespace-nowrap text-ellipsis opacity-70">{message.summary}</span>
              </div>
            {:else if message.kind === "thinking"}
              <div class="min-w-0 self-start px-1 text-xs italic text-muted opacity-60">
                <span class="truncate overflow-hidden whitespace-nowrap text-ellipsis">· {message.text}</span>
              </div>
            {/if}
          {/each}
        {/if}
      </div>
    </div>

    <div
      class="border-t border-edge bg-topbar px-4 pb-4 pt-3"
      style="padding-bottom: max(1rem, env(safe-area-inset-bottom, 0px));"
    >
      <textarea
        id="conversation-composer"
        aria-label="Message"
        class="block min-h-[7rem] w-full max-w-full rounded-md border border-edge bg-surface px-3 py-2 text-sm text-primary outline-none transition focus:border-accent"
        placeholder="ask anything"
        value={composerText}
        oninput={handleComposerInput}
        onkeydown={handleComposerKeydown}
        disabled={isSending}
      ></textarea>

      <div class="mt-3 flex items-center justify-between gap-3">
        <div class="text-[11px] text-muted">
          {conversation?.running ? "Wait for the current turn to finish" : "Enter to send, Shift+Enter for newline"}
        </div>

        {#if showInterrupt && !conversationError}
          {@render interruptButton()}
        {:else}
          <button
            type="button"
            class="rounded-md border border-accent bg-accent px-4 py-2 text-sm font-medium text-white transition disabled:cursor-not-allowed disabled:border-edge disabled:bg-edge disabled:text-muted"
            onclick={onSend}
            disabled={!canSend}
          >
            {isSending ? "Sending..." : "Send"}
          </button>
        {/if}
      </div>
    </div>
  </section>
{/if}
