<script lang="ts">
  let { prNumber, prStatus, prUrl, clickable = false }: {
    prNumber: number;
    prStatus: string | null;
    prUrl: string | null;
    clickable?: boolean;
  } = $props();

  function badgeColor(status: string | null): string {
    if (status === "merged") return "bg-[#8b5cf6]/20 text-[#a78bfa]";
    if (status === "closed") return "bg-danger/20 text-danger";
    if (status === "open") return "bg-success/20 text-success";
    return "bg-muted/20 text-muted";
  }
</script>

{#if clickable && prUrl}
  <a
    href={prUrl}
    target="_blank"
    rel="noopener"
    class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full no-underline hover:opacity-80 {badgeColor(prStatus)}"
  >PR #{prNumber}</a>
{:else}
  <span class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded-full {badgeColor(prStatus)}">PR #{prNumber}</span>
{/if}
