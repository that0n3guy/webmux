import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import type { PaneSplit } from "../domain/config";

export interface TmuxWindowSummary {
  sessionName: string;
  windowName: string;
  paneCount: number;
}

export interface TmuxSessionSummary {
  name: string;
  windowCount: number;
  attached: boolean;
  group: string | null;
}

export interface TmuxGateway {
  ensureServer(): void;
  ensureSession(sessionName: string, cwd: string): void;
  hasWindow(sessionName: string, windowName: string): boolean;
  killWindow(sessionName: string, windowName: string): void;
  killSession(sessionName: string): void;
  createWindow(opts: {
    sessionName: string;
    windowName: string;
    cwd: string;
    command?: string;
  }): void;
  splitWindow(opts: {
    target: string;
    split: PaneSplit;
    sizePct?: number;
    cwd: string;
    command?: string;
  }): void;
  setWindowOption(sessionName: string, windowName: string, option: string, value: string): void;
  runCommand(target: string, command: string): void;
  selectPane(target: string): void;
  listWindows(): TmuxWindowSummary[];
  listAllSessions(): TmuxSessionSummary[];
  getFirstWindowName(sessionName: string): string | null;
}

function runTmux(args: string[]): { stdout: string; stderr: string; exitCode: number } {
  const result = Bun.spawnSync(["tmux", ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  return {
    stdout: new TextDecoder().decode(result.stdout).trim(),
    stderr: new TextDecoder().decode(result.stderr).trim(),
    exitCode: result.exitCode,
  };
}

function assertTmuxOk(args: string[], action: string): string {
  const result = runTmux(args);
  if (result.exitCode !== 0) {
    throw new Error(`${action} failed: ${result.stderr || `tmux ${args.join(" ")} exit ${result.exitCode}`}`);
  }
  return result.stdout;
}

function isIgnorableKillWindowError(stderr: string): boolean {
  return stderr.includes("can't find window")
    || stderr.includes("can't find session")
    || stderr.includes("no server running")
    || (stderr.includes("error connecting to") && stderr.includes("No such file or directory"));
}

export function sanitizeTmuxNameSegment(value: string, maxLength = 24): string {
  const sanitized = value
    .toLowerCase()
    .replace(/[^a-z0-9_.-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  const trimmed = sanitized.slice(0, maxLength);
  return trimmed || "x";
}

export function buildProjectSessionName(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  const base = sanitizeTmuxNameSegment(basename(resolved), 18);
  const hash = createHash("sha1").update(resolved).digest("hex").slice(0, 8);
  return `wm-${base}-${hash}`;
}

export function buildWorktreeWindowName(branch: string): string {
  return `wm-${branch}`;
}

export function parseWindowSummaries(output: string): TmuxWindowSummary[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [sessionName = "", windowName = "", paneCountRaw = "0"] = line.split("\t");
      return {
        sessionName,
        windowName,
        paneCount: parseInt(paneCountRaw, 10) || 0,
      };
    })
    .filter((entry) => entry.sessionName.length > 0 && entry.windowName.length > 0);
}

export const WEBMUX_SESSION_PREFIX = "wm-";
export const SCRATCH_SESSION_PREFIX = "wm-scratch-";

export function parseSessionSummaries(output: string): TmuxSessionSummary[] {
  return output
    .split("\n")
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .map((line) => {
      const [name = "", windowCountRaw = "0", attachedRaw = "0", group = ""] = line.split("\t");
      return {
        name,
        windowCount: parseInt(windowCountRaw, 10) || 0,
        attached: attachedRaw === "1",
        group: group.length > 0 ? group : null,
      };
    })
    .filter((entry) => entry.name.length > 0);
}

export class BunTmuxGateway implements TmuxGateway {
  ensureServer(): void {
    assertTmuxOk(["start-server"], "tmux start-server");
  }

  ensureSession(sessionName: string, cwd: string): void {
    const check = runTmux(["has-session", "-t", sessionName]);
    if (check.exitCode !== 0) {
      assertTmuxOk(
        ["new-session", "-d", "-s", sessionName, "-c", cwd, ";", "set-option", "-t", sessionName, "destroy-unattached", "off"],
        `create tmux session ${sessionName}`,
      );
      return;
    }

    assertTmuxOk(
      ["set-option", "-t", sessionName, "destroy-unattached", "off"],
      `set destroy-unattached off for ${sessionName}`,
    );
  }

  hasWindow(sessionName: string, windowName: string): boolean {
    const result = runTmux(["list-windows", "-t", sessionName, "-F", "#{window_name}"]);
    if (result.exitCode !== 0) return false;
    return result.stdout.split("\n").some((line) => line.trim() === windowName);
  }

  killWindow(sessionName: string, windowName: string): void {
    const result = runTmux(["kill-window", "-t", `${sessionName}:${windowName}`]);
    if (result.exitCode !== 0 && !isIgnorableKillWindowError(result.stderr)) {
      throw new Error(`kill tmux window ${sessionName}:${windowName} failed: ${result.stderr}`);
    }
  }

  killSession(sessionName: string): void {
    const result = runTmux(["kill-session", "-t", sessionName]);
    if (result.exitCode !== 0 && !result.stderr.includes("can't find session") && !result.stderr.includes("no server running")) {
      throw new Error(`kill tmux session ${sessionName} failed: ${result.stderr}`);
    }
  }

  createWindow(opts: {
    sessionName: string;
    windowName: string;
    cwd: string;
    command?: string;
  }): void {
    const args = ["new-window", "-d", "-t", opts.sessionName, "-n", opts.windowName, "-c", opts.cwd];
    if (opts.command) args.push(opts.command);
    assertTmuxOk(args, `create tmux window ${opts.sessionName}:${opts.windowName}`);
  }

  splitWindow(opts: {
    target: string;
    split: PaneSplit;
    sizePct?: number;
    cwd: string;
    command?: string;
  }): void {
    const args = ["split-window", "-t", opts.target, opts.split === "right" ? "-h" : "-v", "-c", opts.cwd];
    if (opts.sizePct !== undefined) args.push("-l", `${opts.sizePct}%`);
    if (opts.command) args.push(opts.command);
    assertTmuxOk(args, `split tmux window at ${opts.target}`);
  }

  setWindowOption(sessionName: string, windowName: string, option: string, value: string): void {
    assertTmuxOk(
      ["set-window-option", "-t", `${sessionName}:${windowName}`, option, value],
      `set tmux option ${option} on ${sessionName}:${windowName}`,
    );
  }

  runCommand(target: string, command: string): void {
    assertTmuxOk(["send-keys", "-t", target, "-l", "--", command], `send tmux command to ${target}`);
    assertTmuxOk(["send-keys", "-t", target, "C-m"], `submit tmux command on ${target}`);
  }

  selectPane(target: string): void {
    assertTmuxOk(["select-pane", "-t", target], `select tmux pane ${target}`);
  }

  listWindows(): TmuxWindowSummary[] {
    const output = assertTmuxOk(
      ["list-windows", "-a", "-F", "#{session_name}\t#{window_name}\t#{window_panes}"],
      "list tmux windows",
    );
    return parseWindowSummaries(output);
  }

  listAllSessions(): TmuxSessionSummary[] {
    const result = runTmux([
      "list-sessions",
      "-F",
      "#{session_name}\t#{session_windows}\t#{session_attached}\t#{session_group}",
    ]);
    if (result.exitCode !== 0) {
      // No tmux server → no sessions, not an error.
      if (result.stderr.includes("no server running")) return [];
      throw new Error(`list tmux sessions failed: ${result.stderr}`);
    }
    return parseSessionSummaries(result.stdout);
  }

  getFirstWindowName(sessionName: string): string | null {
    const result = runTmux(["list-windows", "-t", sessionName, "-F", "#{window_name}"]);
    if (result.exitCode !== 0) return null;
    const first = result.stdout.split("\n")[0]?.trim();
    return first && first.length > 0 ? first : null;
  }
}
