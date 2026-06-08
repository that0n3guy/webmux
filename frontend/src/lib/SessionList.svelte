<script lang="ts">
  import type { ExternalTmuxSession, ScratchSessionSnapshot, Selection } from "./types";
  import { sortByName } from "./session-utils";
  import ScratchRow from "./ScratchRow.svelte";
  import ExternalRow from "./ExternalRow.svelte";

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
          <ScratchRow
            {projectId}
            scratch={s}
            {selection}
            {onSelect}
            {onRemoveScratch}
          />
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
          <ExternalRow
            session={s}
            {selection}
            {onSelect}
          />
        {/each}
      </ul>
    {/if}
  {/if}
</section>
