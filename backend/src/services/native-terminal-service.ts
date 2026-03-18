import type { ManagedWorktreeRuntimeState, NativeTerminalTarget } from "../domain/model";

export type NativeTerminalTargetResult =
  | { ok: true; data: NativeTerminalTarget }
  | { ok: false; reason: "not_found" | "closed"; message: string };

export function buildNativeTerminalTarget(
  branch: string,
  state: ManagedWorktreeRuntimeState | null,
): NativeTerminalTargetResult {
  if (!state || !state.git.exists) {
    return {
      ok: false,
      reason: "not_found",
      message: `Worktree not found: ${branch}`,
    };
  }

  if (!state.session.exists || !state.session.sessionName) {
    return {
      ok: false,
      reason: "closed",
      message: `No open tmux window found for worktree: ${branch}`,
    };
  }

  return {
    ok: true,
    data: {
      worktreeId: state.worktreeId,
      branch: state.branch,
      path: state.path,
      ownerSessionName: state.session.sessionName,
      windowName: state.session.windowName,
      paneCount: state.session.paneCount,
    },
  };
}
