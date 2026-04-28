<script lang="ts">
  let {
    onNewWorktree,
    onNewAISession,
  }: {
    onNewWorktree: () => void;
    onNewAISession: () => void;
  } = $props();

  let open = $state(false);
  let containerEl: HTMLDivElement | null = $state(null);

  function toggle(e: MouseEvent): void {
    e.stopPropagation();
    open = !open;
  }

  function chooseWorktree(): void {
    open = false;
    onNewWorktree();
  }
  function chooseAISession(): void {
    open = false;
    onNewAISession();
  }

  $effect(() => {
    if (!open) return;
    function onClickOutside(e: MouseEvent): void {
      if (containerEl && !containerEl.contains(e.target as Node)) open = false;
    }
    const timer = setTimeout(() => window.addEventListener("click", onClickOutside), 0);
    return () => { clearTimeout(timer); window.removeEventListener("click", onClickOutside); };
  });
</script>

<div class="relative" bind:this={containerEl}>
  <button
    type="button"
    class="h-8 px-2 gap-1.5 rounded-md border border-edge bg-surface text-accent text-xs flex items-center justify-center cursor-pointer hover:bg-hover"
    onclick={toggle}
    title="New… (Cmd+K for worktree)"
  >
    <span class="text-lg leading-none">+</span> New
    <span class="ml-0.5 text-[10px] opacity-70">▾</span>
  </button>

  {#if open}
    <div class="absolute right-0 top-full mt-1 z-20 rounded-md border border-edge bg-sidebar shadow-md min-w-[200px]">
      <button class="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-hover" onclick={chooseWorktree} type="button">
        New worktree…
        <kbd class="ml-2 opacity-60 text-[10px]">Cmd+K</kbd>
      </button>
      <button class="block w-full text-left px-3 py-1.5 text-[13px] hover:bg-hover" onclick={chooseAISession} type="button">
        New AI session…
      </button>
    </div>
  {/if}
</div>
