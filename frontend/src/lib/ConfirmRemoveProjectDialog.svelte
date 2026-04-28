<script lang="ts">
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";

  let {
    projectName,
    onConfirm,
    onCancel,
  }: {
    projectName: string;
    onConfirm: (killSessions: boolean) => void;
    onCancel: () => void;
  } = $props();

  let killSessions = $state(false);
  let busy = $state(false);

  function handleConfirm(): void {
    if (busy) return;
    busy = true;
    onConfirm(killSessions);
  }
</script>

<BaseDialog onclose={onCancel}>
  <div class="flex flex-col gap-3">
    <h2 class="text-base">Remove project</h2>
    <p class="text-[13px] text-muted">
      Remove "{projectName}" from webmux's sidebar. The project's <code>.webmux.yaml</code> stays on disk; you can re-add it later.
    </p>
    <label class="flex items-center gap-2 text-[13px]">
      <input type="checkbox" bind:checked={killSessions} disabled={busy} />
      Also kill all tmux sessions for this project
    </label>
    <div class="flex gap-2 justify-end pt-2">
      <Btn variant="default" onclick={onCancel} disabled={busy}>Cancel</Btn>
      <Btn variant="danger" onclick={handleConfirm} disabled={busy}>
        {busy ? "Removing…" : (killSessions ? "Remove + kill tmux" : "Remove")}
      </Btn>
    </div>
  </div>
</BaseDialog>
