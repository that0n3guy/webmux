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

Single source of truth: a tmux window in the project's session (`buildProjectSessionName(projectRoot)`) whose `@webmux-worktree-id` option is set, and whose `worktreeId` is not present in the current `git worktree list`. The stamped id is authoritative identity; the window's current `windowName` is what we use for kill/attach (it may have drifted from `wm-<branch>`).

In `ReconciliationService.runReconcile`:

1. After processing git worktrees and building `seenWorktreeIds` (today's flow), iterate tmux windows in the project session.
2. For each window with a stamped `@webmux-worktree-id` that's *not* in `seenWorktreeIds`:
   - **If a runtime entry with that worktreeId exists** (the common warm-state case — webmux was running when the worktree got removed): set `orphaned: true` on it, add its id to `seenWorktreeIds` so the existing prune loop doesn't delete it. Leave lifecycle, branch, agentName, profile, path untouched — last-known values are more informative than reconstructed ones.
   - **If no runtime entry exists** (cold start after restart): reconstruct a minimal entry. `worktreeId` from the stamp. `branch` from the window name with the `wm-` prefix stripped (best-effort label — may be wrong if the window was renamed). `path` from `pane_current_path` (will include `(deleted)` suffix from tmux when the directory is gone). `profile: null`, `agentName: null`, `baseBranch: null`. Lifecycle: `"closed"` — we don't know if the agent is alive without poking the pane, and "closed" is the type-safe default that won't render a misleading green dot.

Skip the worktree-window detection for `wm-scratch-*` sessions — scratch sessions live in their own sessions, not the project session.

## Data model

`ManagedWorktreeRuntimeState` (`backend/src/domain/model.ts`):

```ts
orphaned: boolean; // default false on every new state
```

`ProjectWorktreeSnapshotSchema` (`packages/api-contract/src/schemas.ts`):

```ts
orphaned: z.boolean(),
```

`WorktreeInfo` (`frontend/src/lib/types.ts`):

```ts
orphaned: boolean;
```

`mapWorktree` (`frontend/src/lib/api.ts`) forwards the field. `buildWorktreeSnapshots` (`backend/src/services/snapshot-service.ts`) reads it from runtime state; when true, forces:

- `dirty: false`
- `unpushed: false`
- `services: []`
- `prs: []`
- `path`: keep the runtime `state.path` as-is (may include a `(deleted)` suffix when sourced from tmux pane_current_path)
- `dir`: leave as today's `basename(path)` computation; if the path has a `(deleted)` suffix it'll be visible there too

Lifecycle is preserved as-is (last known state for warm orphans; `"closed"` for cold-start). The activity probe is skipped for orphans (no worktree path). The sidebar row replaces the lifecycle dot/checkmark with an "orphaned" badge.

## Backend lifecycle changes

`LifecycleService.removeWorktree(branch)` gets a new fast path before `resolveExistingWorktree`:

1. Check the runtime: is there a worktree with `branch === input` and `orphaned: true`?
2. If yes:
   - Resolve the live tmux window by stamp id: iterate `tmux.listWindows()` in `buildProjectSessionName(projectRoot)`, find the one whose `WEBMUX_WORKTREE_ID_OPTION` equals `state.worktreeId`, take its actual `windowName` (which may have drifted from `wm-<branch>` if renamed).
   - `tmux.killWindow(projectSession, actualWindowName)`. If no stamped window is found, treat as already-gone and continue.
   - `runtime.removeWorktree(worktreeId)`.
   - Reconcile. Return ok.
3. If no: fall through to today's `resolveExistingWorktree` path (which already handles detached HEAD via the May-08 fix).

No `git worktree remove`, no `git branch -D`, no preRemove hook (the cwd is deleted — running a hook against it would fail or run in the wrong directory).

`mergeWorktree`, `setWorktreeArchived`, `openWorktree`, and `closeWorktree` should reject orphans with a clear 409 error before resolving: *"Worktree's git registration is missing; nothing to merge/archive/open. Use Remove to kill the tmux window."* Implement the orphan check as a single helper `findOrphanedRuntime(branch)` returning the runtime entry or null.

## API contract

No new endpoints. The existing `DELETE /api/projects/:projectId/worktrees/:name` route handles orphans transparently — the lifecycle service branches internally. The other worktree endpoints return 409 for orphans (see above).

`WorktreeSnapshot` gains `orphaned: boolean`. The schema bump in `@webmux/api-contract` is non-breaking (additive boolean field). Existing clients ignore unknown fields.

## Frontend changes

`frontend/src/lib/types.ts`: add `orphaned: boolean` to `WorktreeInfo`.

`frontend/src/lib/api.ts`: `mapWorktree` forwards `snapshot.orphaned` → `info.orphaned`.

Row component (whichever renders the sidebar entry — likely `WorktreeList.svelte` or an extracted item component):

- When `worktree.orphaned`, render an amber/orange badge after the branch name: `orphaned`. Tooltip: *"Git worktree no longer exists, but its tmux window is still alive. Attach to the agent, or remove to kill the window."*
- Hide the lifecycle dot/checkmark and the dirty/unpushed indicators (no reliable signal without a worktree path).

`frontend/src/App.svelte`:

- `handleRemove` reads `worktree.orphaned` to swap the confirmation copy: *"This worktree's git registration is already gone. Removing it will kill the tmux window (the branch and its commits stay). Continue?"*
- Disable Merge / Archive / Open-in-editor / Open-worktree for orphans (greyed with tooltip).
- **Chat is disabled for orphans in v1.** The chat path (`worktreeConversationService.attachWorktreeConversation`) calls `git.resolveWorktreeGitDir(worktree.path)` which fails when `.git/worktrees/<wt>/` was deleted with the worktree (as `git worktree remove --force` does). Threading orphan fallbacks through every chat code path is out of scope for v1.
- **Terminal attach stays enabled for orphans.** The WS `terminal-worktree` path uses tmux session/window only; it doesn't need a live worktree directory. This is the primary recovery affordance — the user can attach to the still-running agent and decide what to do.

## Attach + chat path resilience

Verified call sites that assume a live worktree directory:

- `backend/src/services/worktree-conversation-service.ts:288` — `this.deps.git.resolveWorktreeGitDir(worktreePath)` for conversation persistence. Disable chat for orphans at the API boundary: `apiSendAgentsWorktreeMessage` and the WS `agents/worktrees/:name` attach should return 409 when the resolved runtime entry is orphaned.
- `backend/src/server.ts:462` — `git.resolveWorktreeGitDir(entry.path)` walks live git worktrees only, so orphans naturally don't appear there.
- `backend/src/server.ts:2123` — `terminal-launch` is fine for orphans (just needs `session.windowName`).
- `backend/src/server.ts:2354` — `attachIdPrefix = terminalWorktree.worktreeId` is fine; the WS terminal attach uses tmux only.

Add an explicit orphan guard in the WS `agents/worktrees/:name` and `agents/worktrees/:name/messages` handlers; everything else is naturally safe.

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
