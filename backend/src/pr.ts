import { upsertEnvLocal } from "./env";

export interface PrEntry {
  repo: string;
  number: number;
  state: string;
  url: string;
  ciChecks: string;
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

/** Infer the current repo's short name via `gh repo view`. */
function getCurrentRepoName(): string {
  const result = Bun.spawnSync(
    ["gh", "repo", "view", "--json", "name", "-q", ".name"],
    { stdout: "pipe", stderr: "pipe" }
  );
  if (result.exitCode !== 0) return "unknown";
  return new TextDecoder().decode(result.stdout).trim() || "unknown";
}

/** Fetch all PRs from a repo via gh CLI. Returns a map of branch name → PrEntry[]. */
export function fetchAllPrs(repo?: string): Map<string, PrEntry> {
  const args = ["gh", "pr", "list", "--state", "all", "--json", "number,headRefName,state,statusCheckRollup,url", "--limit", "100"];
  if (repo) args.push("--repo", repo);

  const result = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });

  const prs = new Map<string, PrEntry>();
  if (result.exitCode !== 0) {
    const stderr = new TextDecoder().decode(result.stderr).trim();
    const label = repo ?? "current";
    console.error(`[pr] gh pr list failed for ${label}: ${stderr}`);
    return prs;
  }

  // Derive short repo name: last segment of slug, or infer current
  const repoName = repo ? repo.split("/").pop()! : getCurrentRepoName();

  try {
    const entries: GhPrEntry[] = JSON.parse(new TextDecoder().decode(result.stdout));
    for (const entry of entries) {
      // If multiple PRs for same branch in same repo, the first (most recent) wins
      if (prs.has(entry.headRefName)) continue;
      prs.set(entry.headRefName, {
        repo: repoName,
        number: entry.number,
        state: entry.state.toLowerCase(),
        url: entry.url,
        ciChecks: summarizeChecks(entry.statusCheckRollup),
      });
    }
  } catch (err) {
    const label = repo ?? "current";
    console.error(`[pr] failed to parse gh output for ${label}: ${err}`);
  }

  return prs;
}

/** Sync PR status to .env.local for all worktrees that have PRs. */
export function syncPrStatus(
  getWorktreePaths: () => Map<string, string>,
  linkedRepos: string[],
): void {
  // Fetch PRs from current repo + each linked repo
  const allRepoResults: Map<string, PrEntry>[] = [fetchAllPrs()];
  for (const slug of linkedRepos) {
    allRepoResults.push(fetchAllPrs(slug));
  }

  // Group by branch → PrEntry[]
  const branchPrs = new Map<string, PrEntry[]>();
  for (const repoPrs of allRepoResults) {
    for (const [branch, entry] of repoPrs) {
      const existing = branchPrs.get(branch) ?? [];
      existing.push(entry);
      branchPrs.set(branch, existing);
    }
  }

  if (branchPrs.size === 0) return;

  const wtPaths = getWorktreePaths();
  const seen = new Set<string>();

  for (const [branch, entries] of branchPrs) {
    const wtDir = wtPaths.get(branch);
    if (!wtDir || seen.has(wtDir)) continue;
    seen.add(wtDir);

    upsertEnvLocal(wtDir, "PR_DATA", JSON.stringify(entries));
  }

  console.log(`[pr] synced ${seen.size} worktree(s) with PR data from ${allRepoResults.length} repo(s)`);
}

/** Start periodic PR status sync. Returns cleanup function. */
export function startPrMonitor(
  getWorktreePaths: () => Map<string, string>,
  linkedRepos: string[],
  intervalMs: number = 15_000,
): () => void {
  // Run once immediately
  syncPrStatus(getWorktreePaths, linkedRepos);

  const timer = setInterval(() => {
    syncPrStatus(getWorktreePaths, linkedRepos);
  }, intervalMs);

  return (): void => {
    clearInterval(timer);
  };
}
