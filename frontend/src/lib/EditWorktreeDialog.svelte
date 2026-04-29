<script lang="ts">
  import type { AgentSummary, WorktreeInfo } from "./types";
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";
  import Toggle from "./Toggle.svelte";

  let {
    worktree,
    agents,
    onsave,
    onclose,
  }: {
    worktree: WorktreeInfo;
    agents: AgentSummary[];
    onsave: (yolo: boolean, agent: string) => Promise<void>;
    onclose: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let selectedAgent = $state(worktree.agentName ?? "");
  // svelte-ignore state_referenced_locally
  let yolo = $state(worktree.yolo);
  let saving = $state(false);
  let error = $state<string | null>(null);

  let knownAgentIds = $derived(new Set(agents.map((a) => a.id)));
  let currentAgentIsUnknown = $derived(
    worktree.agentName !== null && !knownAgentIds.has(worktree.agentName),
  );

  async function handleSubmit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    saving = true;
    error = null;
    try {
      await onsave(yolo, selectedAgent);
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      saving = false;
    }
  }
</script>

<BaseDialog {onclose} className="md:max-w-[440px]">
  <form onsubmit={handleSubmit}>
    <h2 class="text-base mb-4">Edit Worktree</h2>
    <p class="text-[12px] text-muted mb-4 font-mono truncate">{worktree.branch}</p>

    <div class="mb-4">
      <label class="block text-xs text-muted mb-1.5" for="ew-agent">Agent</label>
      <select
        id="ew-agent"
        bind:value={selectedAgent}
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent"
      >
        {#if currentAgentIsUnknown && worktree.agentName}
          <option value={worktree.agentName} disabled>(unknown) {worktree.agentName}</option>
        {/if}
        {#each agents as agent (agent.id)}
          <option value={agent.id}>{agent.label}</option>
        {/each}
      </select>
    </div>

    <div class="mb-6 flex items-center justify-between gap-3 px-3 py-2 rounded-md border border-edge bg-surface">
      <div>
        <span class="text-[13px] text-primary">Skip permissions (yolo)</span>
        <p class="text-[11px] text-muted mt-0.5">
          Takes effect on next open. Launches with <code class="text-accent/80">--dangerously-skip-permissions</code> / <code class="text-accent/80">--yolo</code>.
        </p>
      </div>
      <Toggle bind:checked={yolo} aria-label="Skip permissions" />
    </div>

    {#if error}
      <div class="mb-3 text-[12px] text-red-400">{error}</div>
    {/if}

    <div class="flex justify-end gap-2">
      <Btn type="button" onclick={onclose}>Cancel</Btn>
      <Btn type="submit" variant="cta" disabled={saving}>
        {saving ? "Saving…" : "Save"}
      </Btn>
    </div>
  </form>
</BaseDialog>
