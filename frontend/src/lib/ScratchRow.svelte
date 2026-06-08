<script lang="ts">
  import type { ScratchSessionSnapshot, Selection } from "./types";
  import { attachedBadge } from "./session-utils";
  import AgentStatusIcon from "./AgentStatusIcon.svelte";

  function agentSessionStatus(s: { agentStatus?: "running" | "idle" }): "working" | "done" | null {
    if (s.agentStatus === "running") return "working";
    if (s.agentStatus === "idle") return "done";
    return null;
  }

  let {
    projectId,
    scratch,
    selection,
    projectLabel = null,
    onSelect,
    onRemoveScratch,
  }: {
    projectId: string;
    scratch: ScratchSessionSnapshot;
    selection: Selection | null;
    projectLabel?: string | null;
    onSelect: (sel: Selection) => void;
    onRemoveScratch: (id: string, displayName: string) => void;
  } = $props();

  const isSelected = $derived(selection?.kind === "scratch" && selection.id === scratch.id);
  const status = $derived(agentSessionStatus(scratch));
</script>

<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
<!-- svelte-ignore a11y_click_events_have_key_events -->
<li
  class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-hover"
  class:bg-hover={isSelected}
  onclick={() => onSelect({ kind: "scratch", projectId, id: scratch.id, sessionName: scratch.sessionName })}
>
  <span class="flex-1 truncate">
    {scratch.displayName}
    {#if projectLabel}
      <span class="ml-1 text-[10px] px-1.5 py-0.5 rounded border border-edge text-muted">{projectLabel}</span>
    {/if}
  </span>
  {#if status}
    <span class="shrink-0 ml-2"><AgentStatusIcon status={status} size={14} /></span>
    {#if scratch.statusWord}
      <span class="text-[10px] opacity-60 ml-1 truncate max-w-[80px]">{scratch.statusWord}</span>
    {/if}
  {:else}
    <span class="text-xs opacity-60 ml-2">{attachedBadge(scratch)}</span>
  {/if}
  <button
    type="button"
    class="ml-2 opacity-50 hover:opacity-100"
    aria-label="Remove scratch session"
    onclick={(e) => { e.stopPropagation(); onRemoveScratch(scratch.id, scratch.displayName); }}
  >×</button>
</li>
