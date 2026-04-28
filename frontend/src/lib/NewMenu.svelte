<script lang="ts">
  let {
    onNewWorktree,
    onNewAISession,
  }: {
    onNewWorktree: () => void;
    onNewAISession: () => void;
  } = $props();

  let open = $state(false);
  let triggerEl: HTMLButtonElement | null = $state(null);
  let menuTop = $state(0);
  let menuRight = $state(0);

  function toggle(e: MouseEvent): void {
    e.stopPropagation();
    if (!open && triggerEl) {
      const rect = triggerEl.getBoundingClientRect();
      menuTop = rect.bottom + 4;
      menuRight = window.innerWidth - rect.right;
    }
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
    function close(): void { open = false; }
    function onClickOutside(): void { open = false; }
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

<div>
  <button
    bind:this={triggerEl}
    type="button"
    class="h-8 px-2 gap-1.5 rounded-md border border-edge bg-surface text-accent text-xs flex items-center justify-center cursor-pointer hover:bg-hover"
    onclick={toggle}
    title="New… (Cmd+K for worktree)"
  >
    <span class="text-lg leading-none">+</span> New
    <span class="ml-0.5 text-[10px] opacity-70">▾</span>
  </button>

  {#if open}
    <div
      class="fixed z-50 rounded-md border border-edge bg-sidebar shadow-md min-w-[200px]"
      style:top="{menuTop}px"
      style:right="{menuRight}px"
    >
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
