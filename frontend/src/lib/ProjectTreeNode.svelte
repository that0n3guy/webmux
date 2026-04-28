<script lang="ts">
  import type { ProjectInfo, Selection, ScratchSessionSnapshot, WorktreeListRow } from "./types";
  import WorktreeList from "./WorktreeList.svelte";
  import SessionList from "./SessionList.svelte";

  let {
    project,
    expanded,
    onToggle,
    rows,
    scratchSessions,
    selection,
    selected,
    removing,
    initializing,
    archiving,
    notifiedBranches,
    onSelectWorktree,
    onSelectScratch,
    onCreateScratch,
    onRemoveScratch,
    onclose,
    onarchive,
    onmerge,
    onremove,
  }: {
    project: ProjectInfo;
    expanded: boolean;
    onToggle: () => void;
    rows: WorktreeListRow[];
    scratchSessions: ScratchSessionSnapshot[];
    selection: Selection | null;
    selected: string | null;
    removing: Set<string>;
    initializing: Set<string>;
    archiving: Set<string>;
    notifiedBranches: Set<string>;
    onSelectWorktree: (branch: string) => void;
    onSelectScratch: (id: string, sessionName: string) => void;
    onCreateScratch: () => void;
    onRemoveScratch: (id: string, displayName: string) => void;
    onclose: (branch: string) => void;
    onarchive: (branch: string) => void;
    onmerge: (branch: string) => void;
    onremove: (branch: string) => void;
  } = $props();
</script>

<section class="border-b border-edge">
  <header class="flex items-center px-3 py-2 cursor-pointer hover:bg-hover select-none" onclick={onToggle}>
    <span class="mr-2 text-xs">{expanded ? "▾" : "▸"}</span>
    <span class="flex-1 truncate font-medium">{project.name}</span>
    <span class="text-xs text-muted ml-2">{rows.length}</span>
  </header>

  {#if expanded}
    <div class="pl-2">
      <WorktreeList
        {rows}
        {selected}
        {removing}
        {initializing}
        {archiving}
        {notifiedBranches}
        onselect={onSelectWorktree}
        {onclose}
        {onarchive}
        {onmerge}
        {onremove}
      />
      <SessionList
        mode="scratch-only"
        projectId={project.id}
        externalSessions={[]}
        {scratchSessions}
        {selection}
        onSelect={(s) => { if (s.kind === "scratch") onSelectScratch(s.id, s.sessionName); }}
        {onCreateScratch}
        {onRemoveScratch}
      />
    </div>
  {/if}
</section>
