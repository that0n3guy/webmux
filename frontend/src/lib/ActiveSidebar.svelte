<script lang="ts">
  import type { ExternalTmuxSession, ProjectInfo, ScratchSessionSnapshot, Selection } from "./types";
  import type { WorktreeListRow } from "./types";
  import WorktreeRow from "./WorktreeRow.svelte";
  import ScratchRow from "./ScratchRow.svelte";
  import ExternalRow from "./ExternalRow.svelte";
  import {
    buildSidebarItems,
    reconcileSidebarOrder,
    splitSidebarItems,
    applyReorder,
    worktreeSidebarId,
  } from "./sidebar-items";
  import type { SidebarItem } from "./sidebar-items";
  import { searchMatch } from "./utils";

  const INACTIVE_COLLAPSED_KEY = "webmux.sidebar.activeView.inactiveCollapsed";

  function loadInactiveCollapsed(): boolean {
    try {
      const stored = localStorage.getItem(INACTIVE_COLLAPSED_KEY);
      return stored === null ? true : stored === "true";
    } catch {
      return true;
    }
  }

  function saveInactiveCollapsed(v: boolean): void {
    try {
      localStorage.setItem(INACTIVE_COLLAPSED_KEY, String(v));
    } catch {
      // ignore
    }
  }

  let {
    projects,
    rowsByProject,
    scratchByProject,
    externalSessions,
    selection,
    selected,
    removing,
    initializing,
    archiving,
    notifiedBranches,
    itemOrder,
    searchQuery,
    showArchived,
    onSelectWorktree,
    onSelectScratch,
    onSelectExternal,
    onRemoveScratch,
    onclose,
    onarchive,
    onmerge,
    onremove,
    onedit,
    onReorder,
  }: {
    projects: ProjectInfo[];
    rowsByProject: Map<string, WorktreeListRow[]>;
    scratchByProject: Map<string, ScratchSessionSnapshot[]>;
    externalSessions: ExternalTmuxSession[];
    selection: Selection | null;
    selected: string | null;
    removing: Set<string>;
    initializing: Set<string>;
    archiving: Set<string>;
    notifiedBranches: Set<string>;
    itemOrder: string[];
    searchQuery: string;
    showArchived: boolean;
    onSelectWorktree: (projectId: string, branch: string) => void;
    onSelectScratch: (projectId: string, id: string, sessionName: string) => void;
    onSelectExternal: (sessionName: string) => void;
    onRemoveScratch: (projectId: string, id: string, displayName: string) => void;
    onclose: (projectId: string, branch: string) => void;
    onarchive: (projectId: string, branch: string) => void;
    onmerge: (projectId: string, branch: string) => void;
    onremove: (projectId: string, branch: string) => void;
    onedit: (projectId: string, branch: string) => void;
    onReorder: (nextItemOrder: string[]) => void;
  } = $props();

  let openMenuId = $state<string | null>(null);
  let menuTop = $state(0);
  let menuRight = $state(0);
  let inactiveCollapsed = $state(loadInactiveCollapsed());
  let dragging = $state(false);
  let dragSourceId = $state<string | null>(null);
  let dragTargetId = $state<string | null>(null);
  let frozenItems = $state<SidebarItem[] | null>(null);

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
      if (event.key === "Escape") openMenuId = null;
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

  function filterItems(items: SidebarItem[], query: string, showArch: boolean): SidebarItem[] {
    const trimmed = query.trim().toLowerCase();
    return items.filter((item) => {
      if (item.kind === "worktree") {
        if (!showArch && item.row.worktree.archived) return false;
        if (!trimmed) return true;
        return searchMatch(trimmed, item.row.worktree.branch) || searchMatch(trimmed, item.projectLabel);
      }
      if (item.kind === "scratch") {
        if (!trimmed) return true;
        return searchMatch(trimmed, item.scratch.displayName) || searchMatch(trimmed, item.projectLabel);
      }
      if (!trimmed) return true;
      return searchMatch(trimmed, item.session.name);
    });
  }

  let allItems = $derived(
    buildSidebarItems({ projects, rowsByProject, scratchByProject, externalSessions }),
  );

  let filtered = $derived(filterItems(allItems, searchQuery, showArchived));

  let orderedItems = $derived(reconcileSidebarOrder(filtered, itemOrder));

  let renderedItems = $derived(dragging && frozenItems !== null ? frozenItems : orderedItems);

  let currentOrder = $derived(renderedItems.map((item) => item.id));

  let { active, inactive } = $derived(splitSidebarItems(renderedItems));

  function handleDragStart(event: DragEvent, stableId: string): void {
    frozenItems = orderedItems.slice();
    dragging = true;
    dragSourceId = stableId;
    if (event.dataTransfer) {
      event.dataTransfer.setData("text/plain", stableId);
      event.dataTransfer.effectAllowed = "move";
    }
  }

  function handleDragOver(event: DragEvent, stableId: string): void {
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    dragTargetId = stableId;
  }

  function handleDrop(event: DragEvent, stableId: string): void {
    event.preventDefault();
    const src = dragSourceId;
    if (src && src !== stableId) {
      const next = applyReorder(currentOrder, src, stableId);
      onReorder(next);
    }
    dragSourceId = null;
    dragTargetId = null;
  }

  function handleDragEnd(): void {
    dragging = false;
    dragSourceId = null;
    dragTargetId = null;
    frozenItems = null;
  }
</script>

{#snippet dragHandle(stableId: string)}
  <div
    draggable={true}
    class="cursor-grab active:cursor-grabbing text-muted hover:text-primary px-1.5 self-stretch flex items-center shrink-0"
    aria-label="Drag to reorder"
    role="button"
    tabindex={-1}
    ondragstart={(e: DragEvent) => handleDragStart(e, stableId)}
    ondragend={handleDragEnd}
  >
    <svg width="10" height="14" viewBox="0 0 10 14" fill="currentColor" aria-hidden="true">
      <circle cx="2" cy="2" r="1.5" />
      <circle cx="8" cy="2" r="1.5" />
      <circle cx="2" cy="7" r="1.5" />
      <circle cx="8" cy="7" r="1.5" />
      <circle cx="2" cy="12" r="1.5" />
      <circle cx="8" cy="12" r="1.5" />
    </svg>
  </div>
{/snippet}

{#snippet itemRow(item: SidebarItem)}
  <div
    class="flex items-stretch {dragTargetId === item.id && dragSourceId !== item.id ? 'border-t-2 border-accent' : ''}"
    data-item-id={item.id}
    ondragover={(e: DragEvent) => handleDragOver(e, item.id)}
    ondrop={(e: DragEvent) => handleDrop(e, item.id)}
  >
    {@render dragHandle(item.id)}
    {#if item.kind === "worktree"}
      <div class="flex-1 min-w-0">
        <WorktreeRow
          row={item.row}
          {selected}
          {removing}
          {initializing}
          {archiving}
          {notifiedBranches}
          projectLabel={item.projectLabel}
          stableId={worktreeSidebarId(item.projectId, item.row.worktree.branch)}
          isMenuOpen={openMenuId === worktreeSidebarId(item.projectId, item.row.worktree.branch)}
          {menuTop}
          {menuRight}
          onselect={(branch) => { openMenuId = null; onSelectWorktree(item.projectId, branch); }}
          onclose={(branch) => onclose(item.projectId, branch)}
          onarchive={(branch) => onarchive(item.projectId, branch)}
          onmerge={(branch) => onmerge(item.projectId, branch)}
          onremove={(branch) => onremove(item.projectId, branch)}
          onedit={(branch) => onedit(item.projectId, branch)}
          onToggleMenu={handleToggleMenu}
        />
      </div>
    {:else if item.kind === "scratch"}
      <ul class="flex-1 min-w-0 list-none">
        <ScratchRow
          projectId={item.projectId}
          scratch={item.scratch}
          {selection}
          projectLabel={item.projectLabel}
          onSelect={(sel) => {
            if (sel.kind === "scratch") onSelectScratch(item.projectId, sel.id, sel.sessionName);
          }}
          onRemoveScratch={(id, displayName) => onRemoveScratch(item.projectId, id, displayName)}
        />
      </ul>
    {:else}
      <ul class="flex-1 min-w-0 list-none">
        <ExternalRow
          session={item.session}
          {selection}
          onSelect={(sel) => {
            if (sel.kind === "external") onSelectExternal(sel.sessionName);
          }}
        />
      </ul>
    {/if}
  </div>
{/snippet}

<div class="flex flex-col flex-1 min-h-0 overflow-y-auto thin-scrollbar">
  {#if active.length === 0 && inactive.length === 0}
    <div class="px-3 py-4 text-xs text-muted text-center">No sessions to show</div>
  {:else}
    <section>
      <header class="text-xs uppercase tracking-wider text-muted px-3 py-2">Active</header>
      {#if active.length === 0}
        <div class="px-3 py-2 text-xs text-muted">No active sessions</div>
      {:else}
        {#each active as item (item.id)}
          {@render itemRow(item)}
        {/each}
      {/if}
    </section>

    {#if inactive.length > 0}
      <section>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <!-- svelte-ignore a11y_click_events_have_key_events -->
        <header
          class="flex items-center text-xs uppercase tracking-wider text-muted px-3 py-2 cursor-pointer hover:bg-hover select-none"
          onclick={() => {
            inactiveCollapsed = !inactiveCollapsed;
            saveInactiveCollapsed(inactiveCollapsed);
          }}
        >
          <span class="mr-1">{inactiveCollapsed ? "▸" : "▾"}</span>
          <span class="flex-1">Inactive</span>
          <span class="ml-2">{inactive.length}</span>
        </header>
        {#if !inactiveCollapsed}
          {#each inactive as item (item.id)}
            {@render itemRow(item)}
          {/each}
        {/if}
      </section>
    {/if}
  {/if}
</div>
