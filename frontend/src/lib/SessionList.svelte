<script lang="ts">
  import type { ExternalTmuxSession, ScratchSessionSnapshot, Selection } from "./types";
  import { sortByName, attachedBadge } from "./session-utils";

  let {
    mode = "both",
    projectId,
    externalSessions,
    scratchSessions,
    selection,
    onSelect,
    onCreateScratch,
    onRemoveScratch,
  }: {
    mode?: "scratch-only" | "external-only" | "both";
    projectId: string;
    externalSessions: ExternalTmuxSession[];
    scratchSessions: ScratchSessionSnapshot[];
    selection: Selection | null;
    onSelect: (sel: Selection) => void;
    onCreateScratch: () => void;
    onRemoveScratch: (id: string, displayName: string) => void;
  } = $props();

  let externalSorted = $derived(sortByName(externalSessions));
  let scratchSorted = $derived(sortByName(scratchSessions));

  function isExternalSelected(name: string): boolean {
    return selection?.kind === "external" && selection.sessionName === name;
  }
  function isScratchSelected(id: string): boolean {
    return selection?.kind === "scratch" && selection.id === id;
  }
</script>

<section class="flex flex-col text-sm">
  {#if mode !== "external-only"}
    <header class="flex items-center justify-between px-3 py-1.5">
      <h3 class="uppercase tracking-wider text-xs opacity-70">Scratch sessions</h3>
      <button class="text-lg leading-none" aria-label="New scratch session" onclick={onCreateScratch}>+</button>
    </header>

    {#if scratchSorted.length === 0}
      <p class="px-3 py-1.5 opacity-50">No scratch sessions</p>
    {:else}
      <ul>
        {#each scratchSorted as s (s.id)}
          <li
            class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-hover"
            class:bg-hover={isScratchSelected(s.id)}
            onclick={() => onSelect({ kind: "scratch", projectId, id: s.id, sessionName: s.sessionName })}
          >
            <span class="flex-1 truncate">{s.displayName}</span>
            <span class="text-xs opacity-60 ml-2">{attachedBadge(s)}</span>
            <button
              type="button"
              class="ml-2 opacity-50 hover:opacity-100"
              aria-label="Remove scratch session"
              onclick={(e) => { e.stopPropagation(); onRemoveScratch(s.id, s.displayName); }}
            >×</button>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}

  {#if mode !== "scratch-only"}
    <header class="flex items-center px-3 py-1.5 mt-2">
      <h3 class="uppercase tracking-wider text-xs opacity-70">External tmux</h3>
    </header>

    {#if externalSorted.length === 0}
      <p class="px-3 py-1.5 opacity-50">No external sessions</p>
    {:else}
      <ul>
        {#each externalSorted as s (s.name)}
          <li
            class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-hover"
            class:bg-hover={isExternalSelected(s.name)}
            onclick={() => onSelect({ kind: "external", sessionName: s.name })}
          >
            <span class="flex-1 truncate">{s.name}</span>
            <span class="text-xs opacity-60 ml-2">{attachedBadge(s)}</span>
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>
