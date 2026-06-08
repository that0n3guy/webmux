<script lang="ts">
  import type { WorktreeListRow } from "./types";
  import WorktreeRow from "./WorktreeRow.svelte";

  let openMenuId = $state<string | null>(null);
  let menuTop = $state(0);
  let menuRight = $state(0);

  let {
    rows,
    selected,
    removing,
    initializing,
    archiving,
    notifiedBranches,
    emptyMessage = "No worktrees found.",
    onselect,
    onclose,
    onarchive,
    onmerge,
    onremove,
    onedit,
  }: {
    rows: WorktreeListRow[];
    selected: string | null;
    removing: Set<string>;
    initializing: Set<string>;
    archiving: Set<string>;
    notifiedBranches: Set<string>;
    emptyMessage?: string;
    onselect: (branch: string) => void;
    onclose: (branch: string) => void;
    onarchive: (branch: string) => void;
    onmerge: (branch: string) => void;
    onremove: (branch: string) => void;
    onedit: (branch: string) => void;
  } = $props();

  function handleToggleMenu(stableId: string, anchorEl: HTMLButtonElement): void {
    if (openMenuId === stableId) {
      openMenuId = null;
      return;
    }
    const rect = anchorEl.getBoundingClientRect();
    menuTop = rect.bottom + 4;
    menuRight = window.innerWidth - rect.right;
    openMenuId = stableId;
  }

  $effect(() => {
    if (!openMenuId) return;

    function handleDocumentClick(event: MouseEvent): void {
      const target = event.target;
      if (!(target instanceof HTMLElement) || !target.closest("[data-worktree-row-menu]")) {
        openMenuId = null;
      }
    }

    function handleEscape(event: KeyboardEvent): void {
      if (event.key === "Escape") {
        openMenuId = null;
      }
    }

    function handleScroll(): void {
      openMenuId = null;
    }

    document.addEventListener("click", handleDocumentClick);
    document.addEventListener("keydown", handleEscape);
    document.addEventListener("scroll", handleScroll, { capture: true });
    return () => {
      document.removeEventListener("click", handleDocumentClick);
      document.removeEventListener("keydown", handleEscape);
      document.removeEventListener("scroll", handleScroll, { capture: true } as EventListenerOptions);
    };
  });
</script>

<ul class="list-none overflow-y-auto flex-1 p-2">
  {#if rows.length === 0}
    <li class="px-3 py-4 text-xs text-muted text-center">{emptyMessage}</li>
  {/if}
  {#each rows as row (row.worktree.branch)}
    <WorktreeRow
      {row}
      {selected}
      {removing}
      {initializing}
      {archiving}
      {notifiedBranches}
      stableId={row.worktree.branch}
      isMenuOpen={openMenuId === row.worktree.branch}
      {menuTop}
      {menuRight}
      onselect={(branch) => { openMenuId = null; onselect(branch); }}
      {onclose}
      {onarchive}
      {onmerge}
      {onremove}
      {onedit}
      onToggleMenu={handleToggleMenu}
    />
  {/each}
</ul>
