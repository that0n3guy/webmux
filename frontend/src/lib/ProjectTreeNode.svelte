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
    onMenuNewWorktree,
    onMenuSettings,
    onMenuRemoveProject,
    onclose,
    onarchive,
    onmerge,
    onremove,
    onedit,
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
    onMenuNewWorktree: () => void;
    onMenuSettings: () => void;
    onMenuRemoveProject: () => void;
    onclose: (branch: string) => void;
    onarchive: (branch: string) => void;
    onmerge: (branch: string) => void;
    onremove: (branch: string) => void;
    onedit: (branch: string) => void;
  } = $props();

  let menuOpen = $state(false);
  let menuTriggerEl: HTMLButtonElement | null = $state(null);
  let menuTop = $state(0);
  let menuRight = $state(0);

  function handleMenuClick(e: MouseEvent): void {
    e.stopPropagation();
    if (!menuOpen && menuTriggerEl) {
      const rect = menuTriggerEl.getBoundingClientRect();
      menuTop = rect.bottom + 4;
      menuRight = window.innerWidth - rect.right;
    }
    menuOpen = !menuOpen;
  }

  function chooseNewWorktree(e: MouseEvent): void {
    e.stopPropagation();
    menuOpen = false;
    onMenuNewWorktree();
  }

  function chooseSettings(e: MouseEvent): void {
    e.stopPropagation();
    menuOpen = false;
    onMenuSettings();
  }

  function chooseRemove(e: MouseEvent): void {
    e.stopPropagation();
    menuOpen = false;
    onMenuRemoveProject();
  }

  $effect(() => {
    if (!menuOpen) return;
    function close(): void { menuOpen = false; }
    function onClickOutside(): void { menuOpen = false; }
    const timer = setTimeout(() => {
      window.addEventListener("click", onClickOutside, { once: true });
      document.addEventListener("scroll", close, { capture: true, once: true });
    }, 0);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("click", onClickOutside);
      document.removeEventListener("scroll", close, { capture: true } as EventListenerOptions);
    };
  });
</script>

<section class="border-b border-edge">
  <header class="flex items-center px-3 py-2 cursor-pointer hover:bg-hover select-none" onclick={onToggle}>
    <span class="mr-2 text-xs">{expanded ? "▾" : "▸"}</span>
    <span class="flex-1 truncate font-medium">{project.name}</span>
    <span class="text-xs text-muted ml-2">{rows.length}</span>
    <button bind:this={menuTriggerEl} class="ml-2 px-1 opacity-50 hover:opacity-100" aria-label="Project menu" onclick={handleMenuClick} type="button">⋯</button>
  </header>

  {#if menuOpen}
    <div
      class="fixed z-50 rounded-md border border-edge bg-sidebar shadow-md min-w-[180px]"
      style:top="{menuTop}px"
      style:right="{menuRight}px"
    >
      <button class="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-hover" onclick={chooseNewWorktree} type="button">New worktree</button>
      <button class="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-hover" onclick={chooseSettings} type="button">Settings…</button>
      <button class="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-hover text-red-400" onclick={chooseRemove} type="button">Remove project…</button>
    </div>
  {/if}

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
        {onedit}
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
