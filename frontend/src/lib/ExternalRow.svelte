<script lang="ts">
  import type { ExternalTmuxSession, Selection } from "./types";
  import { attachedBadge } from "./session-utils";
  import AgentStatusIcon from "./AgentStatusIcon.svelte";

  function agentSessionStatus(s: { agentStatus?: "running" | "idle" }): "working" | "done" | null {
    if (s.agentStatus === "running") return "working";
    if (s.agentStatus === "idle") return "done";
    return null;
  }

  let {
    session,
    selection,
    onSelect,
  }: {
    session: ExternalTmuxSession;
    selection: Selection | null;
    onSelect: (sel: Selection) => void;
  } = $props();

  const isSelected = $derived(selection?.kind === "external" && selection.sessionName === session.name);
  const status = $derived(agentSessionStatus(session));
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<li
  class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-hover"
  class:bg-hover={isSelected}
  onclick={() => onSelect({ kind: "external", sessionName: session.name })}
>
  <span class="flex-1 truncate">{session.name}</span>
  {#if status}
    <span class="shrink-0 ml-2"><AgentStatusIcon status={status} size={14} /></span>
    {#if session.statusWord}
      <span class="text-[10px] opacity-60 ml-1 truncate max-w-[80px]">{session.statusWord}</span>
    {/if}
  {:else}
    <span class="text-xs opacity-60 ml-2">{attachedBadge(session)}</span>
  {/if}
</li>
