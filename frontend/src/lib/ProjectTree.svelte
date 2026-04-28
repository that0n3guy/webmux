<script lang="ts">
  import type { ProjectInfo, Selection, WorktreeListRow, ScratchSessionSnapshot, ExternalTmuxSession } from "./types";
  import ProjectTreeNode from "./ProjectTreeNode.svelte";
  import SessionList from "./SessionList.svelte";

  const EXPANDED_KEY = "webmux.expandedProjects";
  function loadExpanded(): Set<string> {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  }
  function saveExpanded(s: Set<string>): void {
    try { localStorage.setItem(EXPANDED_KEY, JSON.stringify([...s])); } catch { /* ignore */ }
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
    onSelectWorktree,
    onSelectScratch,
    onSelectExternal,
    onCreateScratch,
    onRemoveScratch,
    onAddProject,
    onclose,
    onarchive,
    onmerge,
    onremove,
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
    onSelectWorktree: (projectId: string, branch: string) => void;
    onSelectScratch: (projectId: string, id: string, sessionName: string) => void;
    onSelectExternal: (name: string) => void;
    onCreateScratch: (projectId: string) => void;
    onRemoveScratch: (projectId: string, id: string, displayName: string) => void;
    onAddProject: () => void;
    onclose: (branch: string) => void;
    onarchive: (branch: string) => void;
    onmerge: (branch: string) => void;
    onremove: (branch: string) => void;
  } = $props();

  let expanded = $state(loadExpanded());

  function toggle(id: string): void {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id); else next.add(id);
    saveExpanded(next);
    expanded = next;
  }

  // Default-expand on first load if state is empty
  $effect(() => {
    if (expanded.size === 0 && projects.length > 0) {
      const next = new Set<string>(["__unmanaged__"]);
      for (const p of projects) next.add(p.id);
      saveExpanded(next);
      expanded = next;
    }
  });
</script>

<div class="flex flex-col">
  <section class="border-b border-edge">
    <header class="flex items-center px-3 py-2 cursor-pointer hover:bg-hover select-none" onclick={() => toggle("__unmanaged__")}>
      <span class="mr-2 text-xs">{expanded.has("__unmanaged__") ? "▾" : "▸"}</span>
      <span class="flex-1 truncate font-medium opacity-70">Unmanaged</span>
      <span class="text-xs text-muted ml-2">{externalSessions.length}</span>
    </header>
    {#if expanded.has("__unmanaged__")}
      <div class="pl-2">
        <SessionList
          mode="external-only"
          projectId={""}
          externalSessions={externalSessions}
          scratchSessions={[]}
          {selection}
          onSelect={(s) => { if (s.kind === "external") onSelectExternal(s.sessionName); }}
          onCreateScratch={() => {}}
          onRemoveScratch={() => {}}
        />
      </div>
    {/if}
  </section>

  {#each projects as project (project.id)}
    <ProjectTreeNode
      {project}
      expanded={expanded.has(project.id)}
      onToggle={() => toggle(project.id)}
      rows={rowsByProject.get(project.id) ?? []}
      scratchSessions={scratchByProject.get(project.id) ?? []}
      {selection}
      {selected}
      {removing}
      {initializing}
      {archiving}
      {notifiedBranches}
      onSelectWorktree={(branch) => onSelectWorktree(project.id, branch)}
      onSelectScratch={(id, sessionName) => onSelectScratch(project.id, id, sessionName)}
      onCreateScratch={() => onCreateScratch(project.id)}
      onRemoveScratch={(id, name) => onRemoveScratch(project.id, id, name)}
      {onclose}
      {onarchive}
      {onmerge}
      {onremove}
    />
  {/each}

  <button class="text-sm text-muted hover:text-primary px-3 py-2 text-left" onclick={onAddProject} type="button">
    + Add project
  </button>
</div>
