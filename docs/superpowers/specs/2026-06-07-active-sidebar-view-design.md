# Active Sidebar View — Design

**Status:** Revised after Codex review
**Author:** brainstorm session, 2026-06-07 (revised 2026-06-08)
**Owner:** Peter

## Summary

Add a second sidebar view to the webmux frontend — an "Active" view that shows a single flat, drag-reorderable list of every session-like item the user works with (worktrees, scratch sessions, external tmux), split into an Active bucket on top and a collapsible Inactive bucket below. The user flips between this new view and the existing project-grouped view via a toggle at the top of the sidebar. Their view choice and manual ordering persist server-side via `UserPreferences`, so they follow the user across browsers and machines.

The existing project-grouped view (`ProjectTree.svelte`) is unchanged and remains the default for new users.

## Motivation

> "I'd love a left menu that will display by active rather than display by project and expand to all. I'd also like to re-order them. I think that most of the time, I don't need to see the project expansion."

The current sidebar groups by project, requires expanding each project to see its worktrees, and shows everything in a fixed order. The user works across multiple projects daily but usually only cares about which item is *current*, not which project it lives in.

## Non-goals

- **CLI parity (explicit exception).** AGENTS.md normally requires every user-facing feature to work in both frontend and CLI. The CLI has no sidebar surface; view-mode and itemOrder are browser-side layout preferences with no meaningful CLI representation. Approved by Peter, 2026-06-08.
- **Auto-sorting by activity recency.** Rejected by user in favor of manual reordering.
- **Per-project sidebar order.** The order is global (across all projects), one list, one ordering.
- **Drag-and-drop libraries.** Native HTML5 drag-and-drop is sufficient.
- **Keyboard-driven reorder (deferred).** Initial release ships mouse/touch drag only. Up/down keyboard reorder controls are a follow-up; not blocking this spec. ARIA labels are added to drag handles but no keyboard reorder commands.
- **Touch reorder on mobile (deferred).** HTML5 DnD works on desktop; mobile touch DnD is brittle and not yet addressed.

## Prerequisite — preferences merge semantics (cross-cutting change)

Today `PUT /api/preferences` reconstructs the entire `UserPreferences` object from the request body (`backend/src/server.ts:1524`). Any caller (e.g. `SettingsDialog`) that omits a field would wipe it on save. Adding `sidebar` to the prefs object would compound this: a settings save would wipe the sidebar order, and a sidebar reorder would wipe the user's `defaultAgent`.

**Fix:** change `apiUpdatePreferences` to a top-level merge. The handler loads the current preferences, applies only the fields present in the request body, and writes the merged object. Existing callers benefit immediately — `SettingsDialog` can keep sending only the settings-dialog fields. Sidebar callers send only the sidebar fields.

Schema change: `UpdateUserPreferencesRequestSchema` already omits `schemaVersion` and makes every field optional, so no contract change is needed for the merge semantics — only the server handler logic. Update the existing `preferences-api.test.ts` to assert that a partial PUT preserves unspecified fields.

This change is independent of the sidebar feature but is a hard prerequisite. It ships as Step 0.

## High-level behavior

### Two view modes

- **Projects view** (existing, default): `ProjectTree.svelte`, project-grouped, expandable, no reordering.
- **Active view** (new): `ActiveSidebar.svelte`, one flat reorderable list, two buckets.

The toggle is owned by `App.svelte` (one canonical place). `App.svelte` always renders `SidebarModeToggle` at the top of the sidebar pane, then conditionally renders `ProjectTree` or `ActiveSidebar` below. Existing sidebar header controls (search box, "Show archived" checkbox at `App.svelte:1290-1312`) are preserved above the toggle in both modes — they continue to filter what each view renders. Filtering rules in the Active view mirror project view (search matches branch name and project label; "Show archived" hides archived worktrees).

The mode is persisted in `UserPreferences.sidebar.mode`.

### What the Active view shows

A single flat list that includes:

- Worktrees from every project (same set that `ProjectTree` shows — managed worktrees only).
- Scratch sessions from every project.
- External tmux sessions ("Unmanaged" group in current UI).

No project grouping. Each worktree and scratch row shows a small project-label chip next to the branch name. External tmux rows have no project label.

### The Active / Inactive split

Two buckets, rendered in this order:

1. **Active** — items with a live tmux window. Always expanded.
2. **Inactive** — closed/archived items. Collapsed by default; clicking the header toggles. Hidden entirely when empty. Collapse state is local (`localStorage`), not synced.

"Active" means:
- Worktrees: `mux === "✓"`. Includes orphaned worktrees.
- Scratch sessions: always active (they only exist when their tmux session exists).
- External tmux: always active by definition.

The split is **derived from current state**, not stored. Items move between buckets automatically as tmux state changes. The user's manual order is one global sequence; the bucket split just slices the same sequence in two.

### Manual reorder mechanics

- Each row has a dedicated drag handle on the left edge (grip icon, `aria-label="Drag to reorder"`). The whole row is *not* draggable — only the handle initiates drag. This avoids click/drag ambiguity with the row's primary click-to-select action.
- Native HTML5 drag-and-drop. No library.
- Dropping the dragged row on a target row reorders the global sequence so the dragged row sits immediately above the target.
- Dragging across the Active/Inactive boundary is allowed. The dragged row keeps its global position; bucket membership is recomputed from its current tmux state on the next render.
- On successful drop, debounced (~250ms) `PUT /api/preferences` with `{ sidebar: { mode, itemOrder } }` (both fields, always — never partial).

See "Race conditions and failure handling" for what happens when snapshots/saves overlap.

### Where new items appear

When a new worktree/scratch/external appears with an ID not in the saved `itemOrder`:

- It appears at the end of the rendered list, after all known-order items, in natural enumeration order (projects in registry order, then within-project natural order; external tmux last).
- **No automatic save** happens just because a new item appeared. The new item's position is purely derived until the next user-initiated reorder, at which point it gets saved into the order array.

This is a deliberately weaker guarantee than "pinned to end" — across restarts before any reorder, a new item's exact position may shift if another new item appeared. After any user drag, the full current order (including all newly-seen items) is saved.

### Cleanup of stale IDs

On every render, IDs in `itemOrder` that don't match any current item are filtered out. Stale IDs are silently dropped. The cleaned order is what the UI uses for rendering and what gets saved on the next reorder.

## Data model

### Stable item IDs

| Kind     | ID format                                    |
| -------- | -------------------------------------------- |
| worktree | `worktree:<projectId>:<branch>`              |
| scratch  | `scratch:<projectId>:<scratchId>`            |
| external | `external:<sessionName>`                     |

Branches/scratchIds aren't unique across projects — projectId is required for non-external kinds.

### api-contract package (Step 1 — must precede backend changes)

Preferences are validated through `@webmux/api-contract`. The contract must be updated first.

In `packages/api-contract/src/schemas.ts`:

- New `UserPreferencesSidebarSchema`:
  - `mode: z.enum(["projects", "active"]).optional()`
  - `itemOrder: z.array(z.string()).optional()`
- Extend `UserPreferencesSchema` with `sidebar: UserPreferencesSidebarSchema.optional()`.
- `UpdateUserPreferencesRequestSchema` already derives from `UserPreferencesSchema` via `omit({ schemaVersion: true })` — picks up `sidebar` automatically.
- Export `UserPreferencesSidebar` inferred type.

### Backend: `UserPreferences` adapter (Step 2)

`backend/src/adapters/preferences.ts`:

- Add `UserPreferencesSidebar` interface mirroring the contract type.
- Extend `UserPreferences` with optional `sidebar?: UserPreferencesSidebar`.
- Add `parsePreferencesSidebar(raw)` — guards mode against the enum, accepts only string arrays for itemOrder, drops anything malformed (warn + ignore — matches existing pattern).
- `buildSavePayload` writes the `sidebar` block only when at least one sub-field is set.

`backend/src/server.ts` `apiUpdatePreferences` (Step 0 refactor + Step 2 extension):

- Load current prefs first, then apply only fields present in `parsed.data`.
- New: pass through `sidebar` field unchanged when present.
- Schema version stays at `1` (additive, backward-compatible).

### Frontend types + helpers

`frontend/src/lib/types.ts`:

- Re-export `UserPreferencesSidebar` from the contract package (single source of truth).
- New `SidebarMode = "projects" | "active"`.
- New `SidebarItem` discriminated union with worktree/scratch/external variants (as described in the previous section).

Two pure helpers (new module `frontend/src/lib/sidebar-items.ts`), each independently testable:

1. `reconcileSidebarOrder(items: SidebarItem[], savedOrder: string[]): SidebarItem[]`
   - Returns the global order. Items present in `savedOrder` come first in saved order; unknown items appended in their natural enumeration order; stale IDs filtered out (filtering happens implicitly because each saved ID is looked up in the current item set).

2. `splitSidebarItems(ordered: SidebarItem[]): { active: SidebarItem[]; inactive: SidebarItem[] }`
   - Stable partition preserving relative order. Active first, inactive second.

3. `applyReorder(order: string[], draggedId: string, targetId: string): string[]`
   - Pure helper for drag-drop. Returns the new order with `draggedId` moved immediately above `targetId`. Idempotent if dragged === target.

## Components

### New

- `frontend/src/lib/ActiveSidebar.svelte` — flat list view. Owns drag-and-drop event state, the debounced save call, and the inactive-bucket collapse state. Does NOT own the mode toggle (App.svelte does).
- `frontend/src/lib/SidebarModeToggle.svelte` — two-pill button. Lives at the top of the sidebar in both views. Emits `onchange(mode)`.
- `frontend/src/lib/WorktreeRow.svelte` — extracted from `WorktreeList.svelte`. Props: row, selection state, optional `projectLabel`, busy flags, callback props for select/close/edit/archive/merge/remove, plus **menu state props** (`isMenuOpen: boolean`, `onToggleMenu(stableId, anchor)`, `menuTop`, `menuRight`) so the parent owns single-menu-open behavior.
- `frontend/src/lib/ScratchRow.svelte` — extracted from `SessionList.svelte`'s scratch row. Optional `projectLabel`.
- `frontend/src/lib/ExternalRow.svelte` — extracted from `SessionList.svelte`'s external row. No projectLabel.
- `frontend/src/lib/sidebar-items.ts` — pure helpers (above).

### Action-menu state ownership

Today `WorktreeList.svelte` owns `openMenuBranch: string | null` and document-level click/scroll listeners that close the menu (`WorktreeList.svelte:8-86`). After extraction:

- Menu state lives in the **parent** (`WorktreeList` for projects view, `ActiveSidebar` for active view), keyed by **stable sidebar ID** rather than branch (branches aren't unique across projects in active view).
- `WorktreeRow` receives `isMenuOpen` + `onToggleMenu(stableId, anchorEl)` as props and emits the toggle. The fixed-positioning math (`getBoundingClientRect`, top/right) lives in the parent.
- This way the same row component works in both contexts; only the keying changes.

### Modified

- `frontend/src/lib/WorktreeList.svelte` — internals replaced with `WorktreeRow` instances. Keeps its branch-keyed menu state for the existing call site (projects view); behavior unchanged. ~120 lines of inline row markup deleted.
- `frontend/src/lib/SessionList.svelte` — internals replaced with `ScratchRow` + `ExternalRow`. Behavior unchanged.
- `frontend/src/App.svelte` — adds preferences plumbing (next section).
- `frontend/src/lib/types.ts` — adds `SidebarItem`, `SidebarMode`, re-exports `UserPreferencesSidebar`.
- `frontend/src/lib/api.ts` — no new endpoint; the existing preferences round-trip carries the new field once typed.

## App.svelte preferences plumbing (newly required)

`App.svelte` currently does NOT fetch/own preferences — they're loaded inside `SettingsDialog.svelte:90` for its own use only. This feature needs App-level prefs state.

New behavior in `App.svelte`:

- On mount, call `fetchPreferences()` once. Result populates two new `$state` vars:
  - `sidebarMode: SidebarMode` (default `"projects"` if prefs absent or `sidebar.mode` undefined)
  - `itemOrder: string[]` (default `[]`)
- A `saveSidebarPreference(next: { mode, itemOrder })` helper PUTs `{ sidebar: next }` to `/api/preferences`. Debounced via a single timer (250ms). Updates local state optimistically. On error: revert local state to the last-known-good value and show an error toast via the existing toast mechanism.
- Toggle handler: updates `sidebarMode` immediately and triggers a save with current `itemOrder`.
- Drag-drop handler: updates `itemOrder` immediately via `applyReorder` and triggers a save with current `sidebarMode`.
- After `SettingsDialog` saves prefs through its own path, App.svelte does not need to refetch — `SettingsDialog` updates only its own fields, and with merge semantics in place, App's sidebar state is unaffected. (If we later add a global prefs-refresh signal, we can subscribe to it; not needed now.)

## Cross-project selection in Active view (must-fix)

Today selection is `currentProjectId` + `selectedBranch` (`App.svelte:477-482`), and worktree action callbacks use `currentProjectId!` (`App.svelte:801, 971`). Clicking a row in Active view from a non-current project must:

1. Set `currentProjectId = row.projectId` first.
2. Then perform the select/action.

`ProjectTree.svelte` already provides this pattern via `onSelectWorktree(projectId, branch)` which carries projectId explicitly. Active view callbacks follow the same shape:

- `onSelectWorktree(projectId, branch)` — App.svelte handler must set `currentProjectId` before applying the selection (look at how `App.svelte` currently handles cross-project selection from `ProjectTree`; reuse that path).
- Similarly for `onSelectScratch(projectId, id, sessionName)` and `onSelectExternal(sessionName)`.
- Action callbacks (close/edit/archive/merge/remove) emitted from a row include projectId so the App-level handler can rebind `currentProjectId` before calling the API. Add `projectId` to each callback signature where it isn't already present.

Test: in Active view with two projects, click a worktree from the non-current project — `currentProjectId` should switch, the worktree should be selected, and an action invoked from its menu should hit the correct project's API endpoint.

## Race conditions and failure handling

- **Snapshot poll arriving mid-drag.** `App.svelte` polls snapshot every ~5s (`App.svelte:1162`). During an active drag (between `dragstart` and `dragend`), the Active view does not re-shuffle items. It accepts new items (appending to the end) and removes stale items, but the relative order of currently-rendered items is locked until drag ends. Implementation: a `$state` flag `dragging: boolean` set on dragstart/dragend; rendering ignores order recomputation while it's true.
- **Stale save responses.** Each save call has a monotonically increasing token (a number incremented per call). On response, if the token isn't the latest, the response is ignored. This handles the case where two debounced saves resolve out of order.
- **Repeated save failures.** On a save error, revert local state to the last server-confirmed value and show one toast. We do not auto-retry; the next user reorder will retry. If three consecutive saves fail, log a warning and stop accepting reorders for 10s (back-pressure).
- **Two browsers open at once.** Last write wins. We do not attempt to merge concurrent orders across tabs/browsers.

## Edge cases

- **Worktree removed from disk.** Its ID is filtered from `itemOrder` on next render; surrounding items collapse to fill the gap.
- **Orphaned worktree.** Tmux still alive → Active bucket. Existing "orphaned" badge from `WorktreeRow` is visible.
- **Archived worktree.** Closed by definition → Inactive bucket. Hidden when "Show archived" is unchecked.
- **External tmux disappears.** ID filtered out.
- **Empty `itemOrder` and zero inactive items.** Active bucket shows empty-state copy ("No active sessions"); Inactive section header doesn't render.
- **All items inactive (no active ones).** Active bucket shows empty-state copy; Inactive expanded by default in this case (clearer than a fully-collapsed sidebar).
- **Search filter hides items mid-drag.** Drop targets are computed against visible items only. Dropping near the bottom places the item immediately after the last visible item in the global order.
- **User toggles to Active view for the first time (empty itemOrder).** Items render in natural enumeration order. First drag saves the order.

## Data flow

```
                       /api/preferences GET
                                 │
                                 ▼
                  App.svelte: sidebarMode, itemOrder
                                 │
                          ┌──────┴──────┐
                          ▼             ▼
                    SidebarModeToggle   (active mode?)
                                        │
                          ┌─────────────┴─────────────┐
                          ▼                            ▼
                    ProjectTree                   ActiveSidebar
                                                       │
                                          buildSidebarItems(snapshot)
                                                       │
                                       reconcileSidebarOrder(items, itemOrder)
                                                       │
                                              splitSidebarItems(ordered)
                                                       │
                                    render Active bucket / Inactive bucket
                                                       │
   ┌───────────────────────────────────────────────────┤
   ▼                                                   ▼
drag drop event                              user clicks row / action menu
   │                                                   │
applyReorder(order, dragged, target)         onSelectWorktree(projectId, branch)
   │                                          (App switches currentProjectId)
update App.itemOrder + saveSidebarPreference (debounced PUT)
   │
   ▼
PUT /api/preferences { sidebar: { mode, itemOrder } }
   │
   ▼
server merges with stored prefs, writes file
```

## Testing

### api-contract
- Schema round-trip for new sidebar fields.
- Backward compat: prefs without `sidebar` parse cleanly.

### Backend
- `preferences.test.ts`: parse round-trip for the new `sidebar` block — including unknown `mode` value (drop), malformed `itemOrder` (drop), empty defaults.
- `preferences-api.test.ts`:
  - New test: partial PUT preserves unspecified existing fields (proves merge semantics).
  - New test: PUT `{ sidebar }` doesn't disturb `defaultAgent`/`autoName`.
  - New test: PUT `{ defaultAgent }` after a sidebar set doesn't wipe sidebar.

### Frontend pure functions
- `reconcileSidebarOrder`:
  - All items in `savedOrder`: output matches saved order.
  - Unknown saved IDs: filtered out.
  - New items: appended at end in natural enumeration order.
  - Empty `savedOrder`: output is just natural enumeration.
- `splitSidebarItems`:
  - Active items first, inactive second, relative order preserved.
  - All-active or all-inactive cases.
- `applyReorder`:
  - Drag to top / drag to bottom / drag past self / dragged === target (no-op).

### Frontend components
- `SidebarModeToggle.svelte`: click fires `onchange` with opposite mode.
- `ActiveSidebar.svelte`:
  - Renders both buckets correctly given mock items.
  - Inactive collapse toggles open/close.
  - Drag-drop fires the `onreorder` callback with the new ID array.
  - Cross-project select fires with correct `projectId`.

### Regression
- Existing `WorktreeList.test.ts` still passes after the `WorktreeRow` extraction (visual output unchanged).
- Smoke test: switch mode → drag a few items → hard-refresh → order persisted. Then `systemctl --user restart webmux.service` → still persisted.

## Implementation order (revised)

0. **Refactor `apiUpdatePreferences` to top-level merge.** Add `preferences-api.test.ts` cases for partial-PUT preservation. Ships independently; unblocks safe addition of `sidebar`.
1. **api-contract schema.** Add `UserPreferencesSidebarSchema`, extend `UserPreferencesSchema`, export types.
2. **Backend adapter.** Extend `UserPreferences`, add `parsePreferencesSidebar`, update `buildSavePayload`. `preferences.test.ts` round-trip.
3. **App.svelte preferences plumbing.** Add `fetchPreferences` on mount, `sidebarMode` + `itemOrder` state, `saveSidebarPreference` helper with debounce + error revert. No UI changes yet — just owning the state.
4. **Pure helpers.** `sidebar-items.ts` with `buildSidebarItems`, `reconcileSidebarOrder`, `splitSidebarItems`, `applyReorder`. Full unit test coverage.
5. **Row extraction.** `WorktreeRow`, `ScratchRow`, `ExternalRow`. Update `WorktreeList` and `SessionList` to delegate. Confirm existing tests pass.
6. **`SidebarModeToggle.svelte`.** Mount in `App.svelte` above the conditional view render. Toggle persists immediately.
7. **`ActiveSidebar.svelte` (no DnD yet).** Renders both buckets, project chip on rows, inactive collapse, cross-project selection wiring. Mock saved order; verify rendering.
8. **DnD + save wiring.** Drag handle on each row, drop handlers, optimistic state update, debounced save, snapshot-mid-drag lock, stale-response guard, error revert.
9. **Smoke test + cleanup.** Manual end-to-end test. Remove any debug logging.

Each step is independently mergeable. Steps 0, 1, 2 can land before any UI work begins.
