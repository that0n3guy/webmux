<script lang="ts">
  import type { CreateScratchSessionRequest } from "@webmux/api-contract";
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";

  let {
    projectName,
    agentChoices,
    onClose,
    onCreate,
  }: {
    projectName: string;
    agentChoices: { id: string; label: string }[];
    onClose: () => void;
    onCreate: (req: CreateScratchSessionRequest) => Promise<void>;
  } = $props();

  let displayName = $state("");
  let kind = $state<"shell" | "agent">("shell");
  let agentId = $state<string>(agentChoices[0]?.id ?? "");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || displayName.trim() === "") return;
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

<BaseDialog onclose={onClose} className="md:max-w-[420px]">
  <form onsubmit={submit} class="flex flex-col gap-4">
    <div>
      <h2 class="text-base">New scratch session</h2>
      <p class="text-[12px] text-muted mt-0.5">in <span class="text-primary font-medium">{projectName}</span></p>
    </div>

    <div>
      <label class="block text-xs text-muted mb-1.5" for="scratch-name">Name</label>
      <input
        id="scratch-name"
        bind:value={displayName}
        required
        autocomplete="off"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
        placeholder="my-scratch"
      />
    </div>

    <fieldset class="flex flex-col gap-2 text-[13px]">
      <legend class="text-xs text-muted mb-1.5">Type</legend>
      <label class="flex items-center gap-2">
        <input type="radio" bind:group={kind} value="shell" /> Shell
      </label>
      <label class="flex items-center gap-2">
        <input type="radio" bind:group={kind} value="agent" disabled={agentChoices.length === 0} /> Agent
      </label>
    </fieldset>

    {#if kind === "agent"}
      <div>
        <label class="block text-xs text-muted mb-1.5" for="scratch-agent">Agent</label>
        <select
          id="scratch-agent"
          bind:value={agentId}
          class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent"
        >
          {#each agentChoices as a (a.id)}
            <option value={a.id}>{a.label}</option>
          {/each}
        </select>
      </div>
    {/if}

    {#if error}
      <div class="text-[12px] text-red-400">{error}</div>
    {/if}

    <div class="flex gap-2 justify-end pt-2">
      <Btn variant="ghost" onclick={onClose} disabled={busy}>Cancel</Btn>
      <Btn variant="primary" type="submit" disabled={busy || displayName.trim() === ""}>
        {busy ? "Creating…" : "Create"}
      </Btn>
    </div>
  </form>
</BaseDialog>
