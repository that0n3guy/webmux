<script lang="ts">
  import type { CreateProjectRequest } from "@webmux/api-contract";
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";

  let {
    onClose,
    onCreate,
  }: {
    onClose: () => void;
    onCreate: (req: CreateProjectRequest) => Promise<void>;
  } = $props();

  let path = $state("");
  let displayName = $state("");
  let mainBranch = $state("main");
  let defaultAgent = $state("claude");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || path.trim() === "") return;
    busy = true;
    error = null;
    try {
      await onCreate({
        path: path.trim(),
        displayName: displayName.trim() || undefined,
        mainBranch: mainBranch.trim() || undefined,
        defaultAgent: defaultAgent.trim() || undefined,
      });
      onClose();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<BaseDialog onclose={onClose} className="md:max-w-[480px]">
  <form onsubmit={submit} class="flex flex-col gap-4">
    <h2 class="text-base">Add project</h2>

    <div>
      <label class="block text-xs text-muted mb-1.5" for="proj-path">Project path</label>
      <input
        id="proj-path"
        bind:value={path}
        required
        autocomplete="off"
        placeholder="/home/mercer/projects/foo"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
      />
      <p class="mt-1 text-[11px] text-muted">If the path already has a <code>.webmux.yaml</code>, it'll be read; the fields below are ignored.</p>
    </div>

    <div>
      <label class="block text-xs text-muted mb-1.5" for="proj-name">Display name (optional)</label>
      <input
        id="proj-name"
        bind:value={displayName}
        autocomplete="off"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent"
      />
    </div>

    <div class="flex gap-3">
      <div class="flex-1">
        <label class="block text-xs text-muted mb-1.5" for="proj-mainbranch">Main branch</label>
        <input
          id="proj-mainbranch"
          bind:value={mainBranch}
          class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent"
        />
      </div>
      <div class="flex-1">
        <label class="block text-xs text-muted mb-1.5" for="proj-agent">Default agent</label>
        <select
          id="proj-agent"
          bind:value={defaultAgent}
          class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent"
        >
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
      </div>
    </div>

    {#if error}
      <div class="text-[12px] text-red-400">{error}</div>
    {/if}

    <div class="flex gap-2 justify-end pt-2">
      <Btn variant="default" onclick={onClose} disabled={busy}>Cancel</Btn>
      <Btn variant="cta" type="submit" disabled={busy || path.trim() === ""}>
        {busy ? "Adding…" : "Add"}
      </Btn>
    </div>
  </form>
</BaseDialog>
