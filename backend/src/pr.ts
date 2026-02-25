import { upsertEnvLocal } from "./env";

export interface PrInfo {
  number: number;
  state: string;
  checksStatus: string;
  url: string;
}

interface GhPrEntry {
  number: number;
  headRefName: string;
  state: string;
  statusCheckRollup: Array<{ conclusion: string; status: string }>;
  url: string;
}

/** Summarize CI check status from statusCheckRollup array. */
function summarizeChecks(checks: Array<{ conclusion: string; status: string }>): string {
  if (!checks || checks.length === 0) return "none";
  const allDone = checks.every((c) => c.status === "COMPLETED");
  if (!allDone) return "pending";
  const allPass = checks.every((c) => c.conclusion === "SUCCESS" || c.conclusion === "NEUTRAL" || c.conclusion === "SKIPPED");
  return allPass ? "success" : "failed";
}

/** Fetch all PRs from the current repo via gh CLI. Returns a map of branch name → PrInfo. */
export function fetchAllPrs(): Map<string, PrInfo> {
  const result = Bun.spawnSync(
    ["gh", "pr", "list", "--state", "all", "--json", "number,headRefName,state,statusCheckRollup,url", "--limit", "100"],
    { stdout: "pipe", stderr: "pipe" }
  );

  const prs = new Map<string, PrInfo>();
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    console.error(`[pr] gh pr list failed: ${stderr}`);
    return prs;
  }

  try {
    const entries: GhPrEntry[] = JSON.parse(new TextDecoder().decode(result.stdout));
    for (const entry of entries) {
      // If multiple PRs for same branch, the first (most recent) wins
      if (prs.has(entry.headRefName)) continue;
      prs.set(entry.headRefName, {
        number: entry.number,
        state: entry.state.toLowerCase(),
        checksStatus: summarizeChecks(entry.statusCheckRollup),
        url: entry.url,
      });
    }
  } catch (err) {
    console.error(`[pr] failed to parse gh output: ${err}`);
  }

  return prs;
}

/** Sync PR status to .env.local for all worktrees that have PRs. */
export function syncPrStatus(getWorktreePaths: () => Map<string, string>): void {
  const prs = fetchAllPrs();
  if (prs.size === 0) return;

  const wtPaths = getWorktreePaths();
  const seen = new Set<string>();

  for (const [branch, prInfo] of prs) {
    const wtDir = wtPaths.get(branch);
    if (!wtDir || seen.has(wtDir)) continue;
    seen.add(wtDir);

    upsertEnvLocal(wtDir, "PR_NUMBER", String(prInfo.number));
    upsertEnvLocal(wtDir, "PR_STATUS", prInfo.state);
    upsertEnvLocal(wtDir, "PR_URL", prInfo.url);
    upsertEnvLocal(wtDir, "CI_CHECKS", prInfo.checksStatus);
  }

  console.log(`[pr] synced ${seen.size} worktree(s) with PR data`);
}

/** Start periodic PR status sync. Returns cleanup function. */
export function startPrMonitor(
  getWorktreePaths: () => Map<string, string>,
  intervalMs: number = 15_000
): () => void {
  // Run once immediately
  syncPrStatus(getWorktreePaths);

  const timer = setInterval(() => {
    syncPrStatus(getWorktreePaths);
  }, intervalMs);

  return (): void => {
    clearInterval(timer);
  };
}
