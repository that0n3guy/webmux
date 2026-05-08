# Open Worktree With Override (transient agent / shell-only)

**Date:** 2026-04-28
**Branch:** `feat/non-worktree-sessions`
**Author:** main thread

## Goal

When opening an existing worktree, allow the user to choose:
1. A different agent for this session (transient — `meta.agent` is unchanged; next default-open reverts to persisted agent).
2. "Shell only" — open the tmux session with no agent pane, just the shell pane(s).

## Non-goals

- Persistently changing `meta.agent` (sticky override).
- Switching agents inside an already-open session.
- Adding new agents not already configured for the project.

## Behavior contract

- Default `Open Session` button: unchanged. Uses `meta.agent`.
- New affordance: "Open with…" — selector listing all configured agents for the project plus "Shell only".
- On the backend, `POST /api/projects/:projectId/worktrees/:name/open` gains an optional body `{ agentOverride?: string; shellOnly?: boolean }`.
  - If `shellOnly: true`, the tmux layout is built without the agent pane (only the shell pane is launched).
  - Else if `agentOverride` is set, `getAgentDefinition(scope.config, agentOverride)` is resolved; 404 if not found; 400 if `shellOnly` and `agentOverride` are both set.
  - Else: existing behavior (use `meta.agent`).
- `meta.agent` and the persisted yolo flag are **not** mutated.
- Yolo behavior: keep using `meta.yolo ?? profile.yolo`. Override does not change yolo handling.
- CLI `webmux open <branch>` gains `--agent <id>` and `--shell-only` flags.

## Files to touch

### Task 1 — Contract & lifecycle plumbing
- `packages/api-contract/src/schemas.ts`
  - Add `OpenWorktreeRequestSchema = z.object({ agentOverride: AgentIdSchema.optional(), shellOnly: z.boolean().optional() })`. Export type `OpenWorktreeRequest`.
- `packages/api-contract/src/contract.ts`
  - Change `openWorktree.body` from `c.noBody()` to `OpenWorktreeRequestSchema`. The body is still optional in practice (frontend sends `{}` when no override) — schema accepts an empty object.
- `backend/src/services/lifecycle-service.ts`
  - `openWorktree(branch: string)` becomes `openWorktree(branch: string, opts?: { agentOverride?: AgentId; shellOnly?: boolean }): Promise<{ branch; worktreeId }>`.
  - Inside `openWorktree`, when resolving the agent: if `opts?.agentOverride` is set, call `this.resolveAgentDefinition(opts.agentOverride)` and use that instead of `initialized.meta.agent`.
  - When calling `materializeRuntimeSession`, pass new `shellOnly` flag (see Task 2).
  - Validation: if both `agentOverride` and `shellOnly` are set, throw `LifecycleError("Cannot combine --agent and --shell-only", 400)`.
- `backend/src/server.ts`
  - `apiOpenWorktree(scope, name, req)`: parse body via `OpenWorktreeRequestSchema`, forward `agentOverride` / `shellOnly` to lifecycle service.
  - Wire body parsing in the route at `apiPaths.openWorktree`.

### Task 2 — Shell-only layout support
- `backend/src/services/lifecycle-service.ts`
  - `materializeRuntimeSession` and `buildSessionLayout` accept `shellOnly?: boolean`.
  - When `shellOnly` is true, build a layout that only includes the shell pane, no agent pane.
  - Look at `planSessionLayout` (in `session-service.ts`) — likely accepts a panes config; need to filter agent pane or pass empty agent command. Investigate and pick the cleanest approach. **Constraint:** do not change `planSessionLayout`'s public shape unless necessary; prefer building a shell-only `paneCommands` payload (e.g., omit `agent` from the panes config used for layout).
  - **Important:** `planSessionLayout` signature uses `input.profile.panes` to determine pane layout. Inspect how the agent pane is identified; you may need to pass a modified `panes` array that excludes the agent pane when `shellOnly` is true.

### Task 3 — Frontend: open-with selector
- `frontend/src/lib/api.ts`
  - `openWorktree` already accepts a body (since contract changed). Update wrapper to allow optional `body: { agentOverride?; shellOnly? }`. Default to `{}` for current callers.
- `frontend/src/App.svelte`
  - Add state for "open with menu open" near the existing `openSelectedWorktree` function.
  - New function `openSelectedWorktreeWith(opts: { agentOverride?: string; shellOnly?: boolean })`. Mirror `openSelectedWorktree` but pass body.
  - In the main pane where `Open Session` button lives (~line 1403–1414): convert to a split button:
    - Left: `Open Session` (unchanged) — calls `openSelectedWorktree()`.
    - Right: caret (▾) — toggles a small popover/menu with options:
      - Each agent in `config.agents` (label + id) → calls `openSelectedWorktreeWith({ agentOverride: agent.id })`. Disable/grey the entry that matches `selectedWorktree.agentName` since it's the same as the default open.
      - Divider.
      - "Shell only" → calls `openSelectedWorktreeWith({ shellOnly: true })`.
    - Close menu on outside click and on selection.
  - Match existing visual patterns — there's already a "+ New ▾" pattern in the sidebar (see `df53dfb`). Reuse the styling vocabulary (small caret button, fixed-position menu) for parity.

### Task 4 — CLI parity
- `bin/src/worktree-commands.ts`
  - `webmux open <branch>` accepts `--agent <id>` and `--shell-only`.
  - Update `getWorktreeCommandUsage("open")` help text.
  - Update `parseBranchCommandArgs`: it currently allows only positional branch + `--help`. Either add option parsing here for the open subcommand specifically, or introduce a new `parseOpenCommandArgs` that returns `{ branch, agentOverride?, shellOnly? }`.
  - Forward the parsed options to `runtime.lifecycleService.openWorktree(branch, opts)`.

### Task 5 — Tests
- backend: `lifecycle-service.test.ts` — add tests for openWorktree with agentOverride (resolves a different agent), shellOnly (no agent pane in layout), and the 400 when both set.
- contract: `contract.test.ts` (or wherever) — verify schema accepts `{}`, `{ agentOverride: "claude" }`, `{ shellOnly: true }`, rejects `{ agentOverride: "" }`.
- bin: `worktree-commands.test.ts` — parse `webmux open foo --agent codex --shell-only` (should error), `--agent codex` (passes through), `--shell-only` (passes through).
- frontend: a small smoke test that the menu renders both an agent override and "Shell only" entry, and clicking calls `api.openWorktree` with the expected body. Update existing `openWorktree` mocks if needed.

## Testing strategy per task

Each task should follow TDD (write the failing test first when feasible, then implement) and run the full suite for its layer before declaring done:
- Task 1: `bun run --cwd backend test`
- Task 2: backend tests, especially `lifecycle-service.test.ts`
- Task 3: `bun run --cwd frontend test`
- Task 4: `bun test bin/src`
- Task 5: covered above.

## Acceptance

- `bun test` passes across all four suites (backend / frontend / contract / bin).
- Manual: from the dashboard, select an open worktree with Claude as default agent. Click "Open with… → Codex" — Codex launches in the existing tmux session window. Close session, click the plain "Open Session" — Claude resumes (default behavior preserved). Click "Open with… → Shell only" — only the shell pane is created, no agent.
- `webmux open feature/x --agent codex` and `webmux open feature/x --shell-only` work from the CLI; help text shows the flags.

## Risks

- `planSessionLayout` may be tightly coupled to a specific pane shape. If shell-only is hard to express with the current API, the implementer should escalate (BLOCKED with notes) rather than refactor `planSessionLayout` ad-hoc.
- The split-button menu needs to coexist with the existing dialog z-index stacking. Use the same fixed-position pattern as the worktree row action menu.
