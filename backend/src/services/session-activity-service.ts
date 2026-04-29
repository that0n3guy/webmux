import type { TmuxGateway } from "../adapters/tmux";

export interface SessionActivityProbe {
  agentBinary: "claude" | "codex" | null;
  lastActivityAt: string | null;
  recentTailLines: string[];
}

export interface SessionActivitySummary {
  running: boolean;
  statusWord: string | null;
}

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[mGKHFABCDJSTsu]|\x1b\][^\x07]*\x07|\x1b[=>]/g;

function stripAnsi(line: string): string {
  return line.replace(ANSI_ESCAPE_RE, "");
}

interface CacheEntry {
  hash: number;
  lastChangedAt: Date;
}

const activityCache = new Map<string, CacheEntry>();

function hashLines(lines: string[]): number {
  return Bun.hash(lines.join("\n")) as number;
}

export function clearActivityCache(): void {
  activityCache.clear();
}

export function probeSessionActivity(
  tmux: TmuxGateway,
  target: string,
  opts?: { tailLines?: number },
  now: () => Date = () => new Date(),
): SessionActivityProbe {
  const tailLines = opts?.tailLines ?? 50;
  const recentTailLines = tmux.capturePane(target, tailLines);
  const hash = hashLines(recentTailLines);
  const currentNow = now();

  const cached = activityCache.get(target);
  if (!cached) {
    activityCache.set(target, { hash, lastChangedAt: currentNow });
    return {
      agentBinary: null,
      lastActivityAt: currentNow.toISOString(),
      recentTailLines,
    };
  }

  if (hash !== cached.hash) {
    cached.hash = hash;
    cached.lastChangedAt = currentNow;
  }

  return {
    agentBinary: null,
    lastActivityAt: cached.lastChangedAt.toISOString(),
    recentTailLines,
  };
}

export function computeRunning(
  probe: SessionActivityProbe,
  now: () => Date,
  opts?: { thresholdMs?: number },
): boolean {
  if (probe.lastActivityAt === null) return false;
  const threshold = opts?.thresholdMs ?? 7000;
  const activityTime = new Date(probe.lastActivityAt).getTime();
  const nowTime = now().getTime();
  return nowTime - activityTime <= threshold;
}

const STATUS_WORD_RE = /[✻✶]\s+([A-Z][a-z]+)[…\.]/u;

export function extractStatusWord(tailLines: string[]): string | null {
  for (let i = tailLines.length - 1; i >= 0; i -= 1) {
    const line = tailLines[i];
    if (line === undefined) continue;
    const stripped = stripAnsi(line);
    const match = STATUS_WORD_RE.exec(stripped);
    if (match) {
      const word = match[1];
      if (word && word.length > 0) return word;
    }
  }
  return null;
}

export function summarizeSessionActivity(
  probe: SessionActivityProbe,
  now: () => Date,
  opts?: { thresholdMs?: number },
): SessionActivitySummary {
  return {
    running: computeRunning(probe, now, opts),
    statusWord: extractStatusWord(probe.recentTailLines),
  };
}
