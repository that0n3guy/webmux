# Orphaned worktree windows — design

## Problem

When a git worktree disappears externally (deleted by `git worktree remove --force` from a shell, an agent's cleanup, a manual `rm -rf`, etc.) its webmux-managed tmux window often outlives the git registration. Today, the next reconciliation pass removes the runtime entry and the worktree vanishes from the sidebar. The "External tmux" section filters out `wm-`-prefixed sessions, so the still-running agent is hidden from the UI entirely. The only way to interact with it is `tmux attach` from a shell.

This was hit when an agent inside its own worktree ran:

```bash
cd /home/mercer/projects/ai-funnel && \
  git worktree remove --force .worktrees/plan/continued-1 && \
  git checkout plan/continued-1
```

The agent kept running in window `wm-ai-funnel-b4793dcb:wm-plan/continued-1`, committing happily into the (now main-checked-out) branch, with no UI surface to attach to it.

## Goal

Surface a tmux window stamped as a worktree (`@webmux-worktree-id` set) as a regular sidebar row even when its git worktree is gone, so the user can attach/chat with the agent. Allow removing the row to kill the tmux window. No git worktree resurrection (see "Out of scope").

## Non-goals

- Recreating the git worktree at the original path ("Adopt") — branch may be checked out elsewhere, agent's pane cwd is a deleted inode, meta.json + persisted runtime state are gone. Punt to a follow-up.
- Restoring `.git/worktrees/<wt>/webmux/meta.json` or `runtime-state.json` — both are gone with the worktree directory.
- Auto-killing orphaned windows. The whole point is to preserve them until the user decides.

## Detection

Single source of truth: a tmux window in the project's session (`buildProjectSessionName(projectRoot)`) whose `@webmux-worktree-id` option is set, and whose `worktreeId` is not present in the current `git worktree list`. The window naming convention (`wm-<branch>`) gives us the branch label; the stamped id gives us identity across renames.

In `ReconciliationService.runReconcile`:

1. After processing git worktrees and building `seenWorktreeIds` (today's flow), iterate tmux windows in the project session.
2. For each window with a stamped `@webmux-worktree-id` that's *not* in `seenWorktreeIds`:
   - **If a runtime entry with that worktreeId exists** (most common — webmux was running when the worktree got removed): set `orphaned: true` on it, add its id to `seenWorktreeIds` so the existing prune loop doesn't delete it.
   - **If no runtime entry exists** (cold start after restart): reconstruct a minimal entry from `windowName` (strip the `wm-` prefix to get branch), the stamped `worktreeId`, and window/pane summary. Lifecycle is set to `unknown`; git status fields are neutral.

Skip the worktree-window detection for `wm-scratch-*` sessions — scratch sessions live in their own sessions, not in the project session.

## Data model

`ManagedWorktreeRuntimeState` (`backend/src/services/project-runtime.ts`):

```ts
orphaned: boolean; // default false
```

`WorktreeSnapshot` (`packages/api-contract/src/schemas.ts` and the equivalent type used by the frontend):

```ts
orphaned: boolean;
```

`mapWorktreeSnapshot` propagates `orphaned`; when true, forces:

- `dirty: false`
- `aheadCount: 0`
- `unpushed: false`
- `services: []`
- `prs: []`
- `dir: state.git.cwd ?? "<deleted>"` — the deleted path; frontend renders it as muted/strikethrough

Lifecycle is preserved as-is (last known state). The activity probe doesn't apply (no worktree path to probe). The dot/checkmark in the sidebar is replaced by an "orphaned" badge.

## Backend lifecycle changes

`LifecycleService.removeWorktree(branch)` gets a new fast path before `resolveExistingWorktree`:

1. Check the runtime: is there a worktree with `branch === input` and `orphaned: true`?
2. If yes: `tmux killWindow(projectSession, buildWorktreeWindowName(branch))`. `runtime.removeWorktree(worktreeId)`. Reconcile. Return ok.
3. If no: fall through to today's `resolveExistingWorktree` path (which itself already handles detached HEAD via the May-08 fix).

No `git worktree remove`, no `git branch -D`, no preRemove hook (the cwd is deleted — running a hook against it would fail or worse).

The `mergeWorktree`, `setWorktreeArchived`, `openWorktree`, and `closeWorktree` endpoints should reject orphans with a clear 409 error: "Worktree's git registration is missing; nothing to merge/archive/open. Use Remove to kill the tmux window."

## API contract

No new endpoints. The existing `DELETE /api/projects/:projectId/worktrees/:name` route handles orphans transparently — the lifecycle service branches internally. The other worktree endpoints return 409 for orphans (see above).

`WorktreeSnapshot` gains `orphaned: boolean`. The schema bump in `@webmux/api-contract` is non-breaking (additive boolean field). Existing clients ignore unknown fields.

## Frontend changes

`frontend/src/lib/types.ts`:

- Add `orphaned: boolean` to `WorktreeSnapshot`.

`frontend/src/components/WorktreeSidebarItem.svelte` (or the equivalent row component):

- When `worktree.orphaned`, render an orange/amber badge after the branch name: `orphaned`. Tooltip on hover: *"Git worktree no longer exists, but its tmux window is still alive. Attach to the agent, or remove to kill the window."*
- Hide the lifecycle dot/checkmark (no reliable status reporting without a worktree path for hooks). Or render it greyed out — match whatever the existing "unknown lifecycle" treatment is.
- Hide the dirty / unpushed indicators.

`frontend/src/App.svelte`:

- `handleRemove` reads `worktree.orphaned` to swap the confirmation copy: *"This worktree's git registration is already gone. Removing it will kill the tmux window (the branch and its commits stay). Continue?"*
- Other actions (merge, archive, open) are disabled in the row context menu for orphans, with a tooltip explaining why.

The attach / chat flows are unchanged — the tmux window exists, so the WS attach path keeps working.

## Edge cases

- **Window renamed externally.** If a user renames `wm-foo` to `something-else`, the `@webmux-worktree-id` option survives but the branch label is wrong. The id-based match still works; we use the stamped id as authoritative identity and derive a display branch from the renamed window name (best-effort). Document this in the row tooltip.
- **Multiple orphan windows on the same branch.** Shouldn't happen (tmux window names within a session are unique), but if a race produces two stamped windows with different ids, we render both as separate rows.
- **Project session itself is gone.** Then there are no windows to read, no orphans to surface. Today's flow already handles this: `tmux.listWindows()` is wrapped in try/catch and returns `[]`.
- **Webmux restart while orphan exists.** Cold-start path in detection reconstructs the runtime entry from tmux data. Lifecycle is `unknown` until the user attaches or removes.

## Testing

Backend:

- `reconciliation-service.test.ts`: tmux window stamped with worktreeId, no matching git worktree → runtime entry stays with `orphaned: true`.
- `reconciliation-service.test.ts`: cold-start scenario — empty runtime, tmux window stamped → runtime entry reconstructed with `orphaned: true`.
- `lifecycle-service.test.ts`: `removeWorktree` against an orphan calls `tmux.killWindow` once, does not call `git.removeWorktree` or `git.deleteBranch`, removes runtime entry.
- `lifecycle-service.test.ts`: `mergeWorktree`/`setWorktreeArchived`/`openWorktree` against an orphan return a 409-style error.

Frontend:

- Snapshot test: an orphaned row renders the badge and disables status indicators.
- App-level test: clicking Remove on an orphan shows the kill-window confirmation copy.

## Future work (not in this spec)

- **Adopt orphan.** `git worktree add <path> <branch>` rebuilds the registration if `<path>` is free and the branch isn't checked out elsewhere. Needs UX for: branch-already-checked-out conflict resolution, agent pane reuse (the existing pane's cwd is a deleted inode — recreating the directory doesn't recover it; user would need to send `cd <new path>` or restart claude). Likely a "Recover worktree" dialog.
- **Persist orphan state across full webmux restart without a tmux session.** Out of scope — if both git registration and tmux are gone, there's nothing to surface.
