<script lang="ts">
  import type { SidebarMode } from "./types";

  let {
    mode,
    onchange,
  }: {
    mode: SidebarMode;
    onchange: (next: SidebarMode) => void;
  } = $props();
</script>

<div class="inline-flex items-center gap-0 border border-edge rounded-md text-xs" role="group" aria-label="Sidebar view mode">
  <button
    type="button"
    class="px-2.5 py-1 cursor-pointer transition-colors rounded-l-[5px] {mode === 'projects' ? 'bg-active text-primary' : 'bg-transparent text-muted hover:bg-hover'}"
    aria-pressed={mode === "projects"}
    aria-label="Projects view"
    onclick={(_e: MouseEvent) => { if (mode !== "projects") onchange("projects"); }}
  >
    Projects
  </button>
  <button
    type="button"
    class="px-2.5 py-1 cursor-pointer transition-colors rounded-r-[5px] {mode === 'active' ? 'bg-active text-primary' : 'bg-transparent text-muted hover:bg-hover'}"
    aria-pressed={mode === "active"}
    aria-label="Active view"
    onclick={(_e: MouseEvent) => { if (mode !== "active") onchange("active"); }}
  >
    Active
  </button>
</div>
