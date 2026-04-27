<script lang="ts">
  import type { CreateScratchSessionRequest } from "@webmux/api-contract";

  let {
    open,
    agentChoices,
    onClose,
    onCreate,
  }: {
    open: boolean;
    agentChoices: { id: string; label: string }[];
    onClose: () => void;
    onCreate: (req: CreateScratchSessionRequest) => Promise<void>;
  } = $props();

  let displayName = $state("");
  let kind = $state<"shell" | "agent">("shell");
  let agentId = $state<string>(agentChoices[0]?.id ?? "");
  let busy = $state(false);
  let error = $state<string | null>(null);

  let dialogEl: HTMLDialogElement | null = $state(null);

  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await onCreate({
        displayName: displayName.trim(),
        kind,
        agentId: kind === "agent" ? agentId : undefined,
      });
      displayName = "";
      onClose();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialogEl} class="rounded-md p-4 bg-[var(--color-bg-2)] text-[var(--color-fg)]">
  <form onsubmit={submit} class="flex flex-col gap-3 min-w-[320px]">
    <h2 class="text-lg font-semibold">New scratch session</h2>

    <label class="flex flex-col gap-1">
      Name
      <input bind:value={displayName} required class="border rounded px-2 py-1" />
    </label>

    <fieldset class="flex gap-3">
      <label><input type="radio" bind:group={kind} value="shell" /> Shell</label>
      <label><input type="radio" bind:group={kind} value="agent" /> Agent</label>
    </fieldset>

    {#if kind === "agent"}
      <label class="flex flex-col gap-1">
        Agent
        <select bind:value={agentId} class="border rounded px-2 py-1">
          {#each agentChoices as a (a.id)}
            <option value={a.id}>{a.label}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if error}
      <div class="text-red-500 text-sm">{error}</div>
    {/if}

    <div class="flex gap-2 justify-end">
      <button type="button" onclick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" disabled={busy || displayName.trim() === ""}>Create</button>
    </div>
  </form>
</dialog>
