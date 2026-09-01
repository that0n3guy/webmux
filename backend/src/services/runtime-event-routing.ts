import type { ProjectRuntime } from "./project-runtime";

export interface RuntimeEventScopeCandidate {
  projectRuntime: Pick<ProjectRuntime, "getWorktree">;
}

export type ResolveRuntimeEventScopeResult<T extends RuntimeEventScopeCandidate> =
  | { ok: true; scope: T }
  | { ok: false; message: string };

/**
 * Pick the project scope a runtime event belongs to. Events carry a projectId
 * when posted by an agentctl with WEBMUX_PROJECT_ID in control.env; older
 * control.env files omit it, so fall back to finding the project that owns the
 * event's worktreeId. The first-project fallback exists only for events whose
 * worktree is not registered in any runtime yet.
 */
export function resolveRuntimeEventScope<T extends RuntimeEventScopeCandidate>(input: {
  explicitProjectId: string | null;
  worktreeId: string;
  projectIds: string[];
  getScope: (id: string) => T | null;
}): ResolveRuntimeEventScopeResult<T> {
  if (input.explicitProjectId) {
    const scope = input.getScope(input.explicitProjectId);
    return scope
      ? { ok: true, scope }
      : { ok: false, message: `Project not found: ${input.explicitProjectId}` };
  }

  for (const id of input.projectIds) {
    const scope = input.getScope(id);
    if (scope?.projectRuntime.getWorktree(input.worktreeId)) {
      return { ok: true, scope };
    }
  }

  const firstId = input.projectIds[0];
  const first = firstId ? input.getScope(firstId) : null;
  return first
    ? { ok: true, scope: first }
    : { ok: false, message: "No project available" };
}
