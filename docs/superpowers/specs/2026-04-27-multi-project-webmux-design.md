# Multi-Project Webmux Design

**Date:** 2026-04-27
**Status:** Approved (brainstorm phase complete; ready for plan)
**Branch target:** `feat/multi-project` (new, off `main` after `feat/non-worktree-sessions` lands)

## Goal

Refactor webmux from a single-project process to a multi-project process. One running `webmux serve` exposes a project registry, a tree-shaped sidebar listing every registered project, and per-project state (config, agents, worktrees, scratch sessions, reconciliation, PR/CI/Linear sync) that runs in parallel for every registered project — not only the currently-viewed one.

The driving UX requirement: one URL (e.g. `paperclip.formup.cc`) shows all the user's dev work; clicking a project node expands its worktrees underneath; switching projects has no perceptible delay because every project's background work is already running.

## Non-Goals (deferred to follow-up plans)

- CLI parity for project management (`webmux project add|remove|list`).
- Drag-to-reorder projects in the sidebar.
- Per-project mobile-chat targeting (mobile chat stays scoped to the current claude/codex worktree selection; hidden for non-worktree selections).
- Migration helper for consolidating multiple existing single-project webmux instances into one multi-project instance.
- Per-project URL deep-linking persisted across reloads (will work via path-prefix URLs but no localStorage-scoped restore beyond what already exists).
- Backward compatibility with the single-project URL scheme. This is a personal fork; old `/api/worktrees` endpoints stop existing.

## Architecture

### Top-level abstraction: `ProjectScope`

A `ProjectScope` is the per-project bundle of state and services. Today's `WebmuxRuntime` is, in effect, a single-project ProjectScope; the refactor renames it and parameterises the constructor on `projectDir`.

Per-project members (move into `ProjectScope`):

- `projectDir`, `config: ProjectConfig` (loaded from `.webmux.yaml`)
- `archiveStateService: ArchiveStateService`
- `projectRuntime: ProjectRuntime` (in-memory worktree state)
- `worktreeCreationTracker: WorktreeCreationTracker`
- `reconciliationService: ReconciliationService`
- `lifecycleService: LifecycleService`
- `scratchSessionService: ScratchSessionService`
- `agentRegistry: AgentRegistry`
- `prService`, `linearService`, `autoPullService`, `autoNameService` (all today already inside `WebmuxRuntime` or constructed by `server.ts`; relocate)
- `removingBranches: Set<string>` (worktree-removal lock)

Globally shared (one per process):

- `BunTmuxGateway` (one tmux server)
- `BunDockerGateway`
- `BunPortProbe`
- `BunGitGateway`
- `BunLifecycleHookRunner`
- `RuntimeNotificationService` (single SSE stream; events tagged with optional `projectId`)
- `ProjectRegistry` (the new service that owns the `Map<projectId, ProjectScope>`)
- `loadControlToken`

`ProjectScope.dispose()` cancels any timers (auto-pull, PR sync, Linear sync, reconciliation interval), unsubscribes from notifications, and frees in-memory state. It does NOT kill tmux sessions — those are externally owned and survive scope disposal.

### Project ID

`projectId = sha1(resolveAbsolute(projectDir)).slice(0, 12)`. Stable across processes. Matches the suffix already used in `wm-<sanitisedBasename>-<sha1>` tmux session naming, so existing tmux sessions auto-pair to their project.

There is **no synthetic "global" project on the wire.** External-tmux endpoints (`/api/external-sessions`, `/ws/external/:name`) remain non-project-scoped. The "External tmux" tree node is a frontend rendering concept only — `ProjectTree` hardcodes it as the first node above the registry-derived nodes.

### `ProjectRegistry` (new)

A new service at `backend/src/services/project-registry.ts`. Owns:

- `scopes: Map<projectId, ProjectScope>` — the live, parallel-running set
- Persisted state at `~/.config/webmux/projects.yaml`:

```yaml
schemaVersion: 1
projects:
  - id: 1a2b3c4d5e6f
    path: /home/mercer/projects/webmux-test
    addedAt: "2026-04-27T17:00:00Z"
  - id: 7890abcdef01
    path: /home/mercer/projects/solid/solidactions-work
    addedAt: "2026-04-27T18:30:00Z"
```

(`displayName` is intentionally absent — the project name lives in `.webmux.yaml.name` and is loaded from there.)

Public API:

- `load(): Promise<void>` — reads YAML, validates each path, constructs `ProjectScope` for each via `Promise.all`. Persisting failures (path no longer exists) log a warning and skip that entry.
- `add(input: { path: string; init?: ProjectInitInput }): Promise<ProjectScope>` — see Add Flow below.
- `remove(id: string, opts: { killSessions: boolean }): Promise<void>` — disposes scope; if `killSessions`, also runs `tmux kill-session -t wm-<projectHash>-*`.
- `list(): { id: string; path: string; addedAt: string }[]`.
- `get(id: string): ProjectScope | null`.

### `MultiProjectRuntime` (renamed from `WebmuxRuntime`)

Returned by `createWebmuxRuntime(options)`. Holds:

- The globals listed above
- `projectRegistry: ProjectRegistry`
- `port: number`

`server.ts` no longer pulls per-project services out of `runtime` directly. Instead it pulls globals from `runtime` and per-project services from `runtime.projectRegistry.get(projectId)` inside each handler.

### First-run hydration

In `createWebmuxRuntime` after `projectRegistry.load()`:

1. If the registry loaded ≥ 1 project → done.
2. Else if `cwd` has a `.webmux.yaml` → call `projectRegistry.add({ path: cwd })` and persist.
3. Else → registry remains empty. Frontend shows "Add Project" CTA.

## API Surface

All routes live under `/api/projects/:projectId/...` for per-project endpoints, plus a small set of global routes.

### Global (new)

| Method | Path | Body | Description |
|---|---|---|---|
| `GET`    | `/api/projects` | — | Lists registered projects: `{ projects: [{ id, path, name, addedAt, mainBranch, defaultAgent }] }`. No synthetic entries. |
| `POST`   | `/api/projects` | `CreateProjectRequest` | Adds a new project. See Add Flow. Returns 201 with the created `ProjectInfo`. |
| `DELETE` | `/api/projects/:id` | `RemoveProjectRequest` (`{ killSessions?: boolean }`) | Removes a project. 404 if not found. Default `killSessions` is `false`. |

### Global (existing, unchanged or extended)

| Method | Path | Notes |
|---|---|---|
| `GET` | `/api/config` | Returns the **multi-project** config: `{ projects: ProjectInfo[], globals: GlobalConfig }`. The old per-project config bundle is fetched per project. |
| `GET` | `/api/notifications/stream` (SSE) | Notification events extended with optional `projectId: string \| null`. |
| `GET` | `/api/external-sessions` | Unchanged — used for the synthetic `__global__` node. |
| `POST` | `/api/runtime/events` | Control-token events from agents. Already include their project context via `WEBMUX_PROJECT_ID` env we will add to `ControlEnvMap`. |

### Per-project (path-prefixed rewrite of every existing route)

Every existing path that contained `worktrees`, `scratch-sessions`, `agents`, etc. gets `/api/projects/:projectId/` prepended. Examples (non-exhaustive):

- `/api/projects/:projectId/worktrees` (list/create) — was `/api/worktrees`
- `/api/projects/:projectId/worktrees/:name` (delete) — was `/api/worktrees/:name`
- `/api/projects/:projectId/worktrees/:name/open|close|merge|archive|send|diff`
- `/api/projects/:projectId/scratch-sessions` (list/create), `/api/projects/:projectId/scratch-sessions/:id` (delete)
- `/api/projects/:projectId/agents`, `/api/projects/:projectId/agents/:id`
- `/api/projects/:projectId/agents/validate`
- `/api/projects/:projectId/agents/worktrees/:name/(attach|history|messages|interrupt)`
- `/api/projects/:projectId/branches`, `/api/projects/:projectId/base-branches`
- `/api/projects/:projectId/project` (project snapshot — was `/api/project`)
- `/api/projects/:projectId/linear/issues`, `/api/projects/:projectId/linear/auto-create`
- `/api/projects/:projectId/github/auto-remove-on-merge`
- `/api/projects/:projectId/pull-main`
- `/api/projects/:projectId/ci-logs/:runId`
- `/api/projects/:projectId/notifications/:id/dismiss`

### WebSocket routes

| Path (new) | Replaces |
|---|---|
| `/ws/projects/:projectId/:worktree` | `/ws/:worktree` |
| `/ws/projects/:projectId/scratch/:id` | `/ws/scratch/:id` |
| `/ws/projects/:projectId/agents/worktrees/:name` | `/ws/agents/worktrees/:name` |
| `/ws/external/:sessionName` (unchanged) | `/ws/external/:sessionName` |

### Backend resolution helper

A new helper `parseProjectIdParam(params)` mirroring the existing `parseWorktreeNameParam` pattern:

```ts
function parseProjectIdParam(params: Record<string, string>):
  | { ok: true; data: { id: string; scope: ProjectScope } }
  | { ok: false; response: Response }
```

Handlers call it first; on error they return the 4xx response (404 for unknown id, 400 for missing/empty).

### Add Flow (`POST /api/projects`)

Request body (`CreateProjectRequest`):

```ts
{
  path: string;                         // absolute or ~ -prefixed
  // optional init fields, used only if .webmux.yaml is missing
  displayName?: string;
  mainBranch?: string;                  // default "main"
  defaultAgent?: string;                // default "claude"
  worktreeRoot?: string;                // default "__worktrees"
  services?: { name: string; portStart: number; portStep?: number }[];
}
```

Server logic:

1. Resolve `path` via `~`/relative-to-`process.cwd()`. If it doesn't exist on disk → 400.
2. If `path` is already in the registry (by `projectId`) → 409.
3. Compute `projectId = sha1(absolutePath).slice(0, 12)`.
4. If `path/.webmux.yaml` exists → load it (idempotent — DO NOT overwrite); ignore body's init fields.
5. Else → write `path/.webmux.yaml` from the body's init fields filled with defaults.
6. Construct `ProjectScope`. Run `reconciliationService.reconcile(...)` once before returning.
7. Persist registry to `~/.config/webmux/projects.yaml`.
8. Return 201 `{ project: ProjectInfo }`.

### Remove Flow (`DELETE /api/projects/:id`)

Request body: `{ killSessions?: boolean }` (default false).

1. If not found → 404.
2. If `killSessions`: capture the scratch session list from `scope.scratchSessionService.list()` BEFORE disposing, then kill:
   - The project session — name matches `wm-<sanitisedBasename>-<projectId>` (existing `buildProjectSessionName` convention).
   - Each scratch session captured above.
   Do NOT touch `wm-dash-*` grouped sessions — those are per-port + counter (not project-scoped); `cleanupStaleSessions` handles them on next process boot.
3. Call `scope.dispose()`.
4. Persist registry without that entry.
5. Return 200.
5. Persist registry without that entry.
6. Return 200.

## Frontend

### Component tree

```
App.svelte
└── (sidebar)
    ├── TopBar (existing)
    ├── ProjectTree.svelte                       (new — orchestrator)
    │   ├── ProjectTreeNode (synthetic __global__)
    │   │   └── SessionList { onlyExternal: true }   (existing, slight prop addition)
    │   ├── ProjectTreeNode (each registered project)
    │   │   ├── WorktreeList                          (existing — unchanged interface, gains projectId via prop)
    │   │   └── SessionList { onlyScratch: true }
    │   └── (button) "+ Add project"
    └── (terminal pane)
        └── Terminal { selection }                 (existing — Selection now carries projectId)

App.svelte
└── (modals)
    ├── AddProjectDialog.svelte                  (new)
    ├── ConfirmDialog (existing) for project removal
    └── …existing dialogs unchanged
```

### Selection model extension

`frontend/src/lib/types.ts`:

```ts
export type Selection =
  | { kind: "worktree"; projectId: string; branch: string }
  | { kind: "scratch";  projectId: string; id: string; sessionName: string }
  | { kind: "external"; sessionName: string };  // implicitly under __global__
```

`Terminal.svelte` `wsPath` derivation extends to include `/projects/:projectId/` prefix for worktree/scratch.

### `ProjectTree.svelte`

Renders project nodes with state:

- `expanded: Set<string>` (persisted to `localStorage["webmux.expandedProjects"]`)
- `selection: Selection | null` (passed in, lifted from App.svelte)
- Each node: chevron + project name + worktree count + project menu (⋯)
- Drag-to-reorder is out of scope — order = registry insertion order

Project menu items (per non-`__global__` project):
- "New worktree" → opens existing CreateWorktreeDialog, pre-scoped to this project
- "Settings…" → opens existing SettingsDialog, pre-scoped to this project (config, agents)
- "Remove project…" → opens ConfirmDialog with two options:
  - "Unregister and keep tmux sessions running" (default)
  - "Unregister and kill all tmux sessions for this project"

### `AddProjectDialog.svelte`

Fields: path (text), display name (optional, will fall back to `basename(path)`), main branch (default "main"), default agent (dropdown of built-in + any custom agents we know about — default "claude").

Submit: POST `/api/projects`, on success the new project is added to the tree and auto-expanded; selection becomes the new project's root (no worktree selected yet).

If the path already has a `.webmux.yaml`, the form's main-branch/default-agent fields are visually marked "(will be ignored — config exists)" and the request body still sends them, but the server discards them per Add Flow step 4.

### Polling

Today's per-project poll structure (`fetchWorktrees`, every 5s) becomes:

```ts
async function refreshAll() {
  const allProjectIds = projects.map(p => p.id); // excluding __global__
  const [worktreesByProject, scratchByProject, external] = await Promise.all([
    Promise.all(allProjectIds.map(id => fetchWorktrees(id).then(ws => [id, ws] as const))),
    Promise.all(allProjectIds.map(id => fetchScratchSessions(id).then(ss => [id, ss] as const))),
    fetchExternalSessions(),
  ]);
  // update reactive state per project
}
```

`worktrees` becomes `Map<projectId, WorktreeInfo[]>`; `scratchSessions` becomes `Map<projectId, ScratchSessionSnapshot[]>`. `App.svelte` plumbs the right list into each `ProjectTreeNode`.

### lib/api.ts

Every wrapper gains a `projectId: string` first argument:

```ts
export async function fetchWorktrees(projectId: string): Promise<WorktreeInfo[]>;
export async function fetchScratchSessions(projectId: string): Promise<ScratchSessionSnapshot[]>;
export async function createScratchSession(projectId: string, body: …): Promise<…>;
// etc.
```

Plus the new project-registry wrappers:

```ts
export async function fetchProjects(): Promise<ProjectInfo[]>;
export async function createProject(body: CreateProjectRequest): Promise<ProjectInfo>;
export async function removeProject(id: string, killSessions: boolean): Promise<void>;
```

## Notifications

`RuntimeNotificationService` events gain a nullable `projectId`. The SSE stream remains a single connection. Notifications for project A continue arriving while the user is viewing project B; the toast surface continues to render them. A future enhancement (out of scope) would let the user filter notifications by project.

## Settings dialog

Today's `SettingsDialog.svelte` covers global theming + per-project agent management. The agent management section becomes per-project. Open the dialog from a project node's menu; it loads that project's agent registry. The theme / display section stays global (already in localStorage).

A simple "Project" tab vs "Global" tab split is sufficient.

## Migration & Tests

### Files touched (high-level)

- **Backend**:
  - `backend/src/runtime.ts` — completely refactored. Splits into `MultiProjectRuntime` + `ProjectScope` factories.
  - `backend/src/services/project-registry.ts` (new)
  - `backend/src/__tests__/project-registry.test.ts` (new)
  - `backend/src/services/lifecycle-service.ts`, `reconciliation-service.ts`, `auto-pull-service.ts`, `pr-service.ts`, `linear-service.ts`, `agent-service.ts`, `agent-registry.ts`, `scratch-session-service.ts`, `archive-state-service.ts`, `worktree-creation-service.ts` — constructors now take their dependencies from a single `ProjectScopeDeps` argument.
  - `backend/src/server.ts` — every route handler updated. `parseProjectIdParam` introduced. Per-project services accessed via `scope.X`. Global services accessed via `runtime.X`. The terminal WebSocket dispatch updated to resolve `projectId` first.
  - `backend/src/domain/model.ts` — add `ControlEnvMap.WEBMUX_PROJECT_ID`.

- **Contract package**:
  - `packages/api-contract/src/schemas.ts` — add `ProjectInfoSchema`, `ProjectIdParamsSchema`, `ProjectScopedNameParamsSchema`, `ProjectScopedScratchIdParamsSchema`, `CreateProjectRequestSchema`, `RemoveProjectRequestSchema`, `ProjectListResponseSchema`. Extend `NotificationViewSchema` with optional `projectId`.
  - `packages/api-contract/src/contract.ts` — `apiPaths` rewritten with the prefix; `apiContract` entries updated. Add 3 new project-registry contract entries.

- **Frontend**:
  - `frontend/src/App.svelte` — Selection model extension. Replaces sidebar with `<ProjectTree>`. Per-project polling. Modal/menu plumbing.
  - `frontend/src/lib/ProjectTree.svelte` (new), `ProjectTreeNode.svelte` (new), `AddProjectDialog.svelte` (new)
  - `frontend/src/lib/Terminal.svelte` — `wsPath` derivation includes `projectId`
  - `frontend/src/lib/api.ts` — projectId-arg refactor across every wrapper
  - `frontend/src/lib/types.ts` — Selection union update; add `ProjectInfo` type
  - `frontend/src/lib/SessionList.svelte` — `mode: "scratch-only" | "external-only"` prop so it can render either or both subsections
  - `frontend/src/lib/CreateWorktreeDialog.svelte`, `SettingsDialog.svelte`, `MobileChatSurface.svelte`, `WorktreeList.svelte`, `WorktreeConversationPanel.svelte` — gain `projectId` prop where they fetch project-scoped data

### Backward compatibility

None. The single-project URL scheme is removed. The CLI's commands continue to work but transparently target the registry's first-registered project (or fail clearly if the registry is empty).

`bin/src/worktree-commands.ts` updated to take an optional `--project <id|path>` flag. Resolution order:

1. `--project <id|path>` flag → use that.
2. Else if `cwd` is inside (or equals) any registered project's path → use that project. (Walks up from `cwd` checking each registered path.)
3. Else if registry has exactly 1 project → use it.
4. Else → error with the registered-project list and a hint to pass `--project`.

This matches user intuition: `cd ~/projects/foo && webmux list` shows foo's worktrees regardless of how many other projects are registered.

### Testing strategy

- **Unit (backend)**: `project-registry.test.ts` (add/remove/persist/load/missing-path-warning), `project-scope.test.ts` (construct/dispose preserves tmux), `parse-project-id-param.test.ts`. All existing per-service tests adjusted to take a `ProjectScopeDeps` constructor arg.
- **Unit (contract)**: existing schemas tests pass through; new schemas covered.
- **Integration (server)**: at least one end-to-end test covering POST `/api/projects`, GET `/api/projects/:id/worktrees`, DELETE `/api/projects/:id`.
- **Frontend**: `ProjectTree.test.ts` rendering both `__global__` + a real project. `AddProjectDialog.test.ts` form validation. Existing `Terminal.test.ts` cases updated for projectId-bearing selections.
- **Browser regression**: register two real projects (e.g., `~/projects/webmux-test` + `~/projects/solid/solidactions-work`); verify both projects' worktrees + agent statuses render in parallel; switching between them is instant; remove one (with kill-sessions) and verify tmux is cleaned.

## Implementation phasing

The plan will sequence as 7 phases. **Each phase commits a working, building app** — but two of the merges below are forced by tight coupling (contract changes affect both backend and frontend simultaneously).

1. **Phase 1 — Scope + Registry + persistence + first-run hydration** *(merges old phases 1+2)*. ProjectScope renamed/extracted; ProjectRegistry built; `~/.config/webmux/projects.yaml` read+write; cwd auto-register if `.webmux.yaml` present. Routes still single-project at this point — the registry exposes its first project as the de-facto "current" one.

2. **Phase 2 — Path-prefix every route + contract + frontend api.ts + Selection extension + Terminal wsPath** *(merges old phases 3+4; MUST land as one logical change)*. Backend handlers gain `parseProjectIdParam`; contract paths rewritten; frontend api wrappers gain `projectId` arg; Selection includes `projectId`; Terminal.svelte wsPath uses prefixed path. CLI gains `--project` flag with cwd-aware default. Sidebar still renders one project visually — just plumbed through `projectId`.

3. **Phase 3 — Per-service test refactor**. The existing per-service unit tests (lifecycle, reconciliation, archive-state, snapshot, agent-service, agent-validation, scratch, etc.) are migrated to take a `ProjectScopeDeps` constructor argument. This is **mostly mechanical but voluminous (~20 test files)** — sub-tasked accordingly in the plan.

4. **Phase 4 — ProjectTree component + per-project polling**. Replace sidebar layout with `<ProjectTree>` + `<ProjectTreeNode>`. Polling fans out via `Promise.all`. App still single-project in practice (registry has 1 entry until next phase).

5. **Phase 5 — AddProjectDialog + project menus + remove flow**. Genuinely multi-project UI. POST/DELETE `/api/projects` consumed. Project menu (new worktree, settings, remove with kill-sessions option). External-tmux node hardcoded as the first tree entry.

6. **Phase 6 — Notifications carry projectId**. SSE event shape extended; toasts render with project context.

7. **Phase 7 — Regression + push**. Browser test with two real projects (e.g., webmux-test + solidactions-work). Tmux survival across project removes verified. Branch pushed. Spec doc + plan doc remain in branch history.

Phases 1–3 leave a single-project app that speaks the new URL/contract shape (foundation only). Phase 4+ introduces the new UI. Phase 5 unlocks the multi-project UX the user actually wants.

## Cross-cutting concerns

- **`ControlEnvMap.WEBMUX_BRANCH` for scratch sessions.** Today the type is required `string`. Scratch sessions don't have a branch. Set `WEBMUX_BRANCH=""` (empty string) for scratch contexts to avoid widening the type. The notification/event handler should treat empty-string branch as "no branch" (and ignore branch-keyed lookups).
- **Cross-project port collisions.** Two projects can both declare `services` starting at the same `portStart`. The existing `BunPortProbe` already finds the next free port, so services self-allocate without collision. No spec change required.
- **Polling load with N projects.** With 5 projects polling every 5s, that's 5× the worktree fetches + 5× the scratch fetches + per-project PR/Linear pulls. Mitigation candidates (out of scope for this spec): pause polling when document.hidden; backoff for inactive projects; longer interval. Track as a follow-up.
- **`wm-dash-*` grouped sessions.** Per-port + counter, not project-scoped. The existing `cleanupStaleSessions` handles them on next process boot. Project-remove with `killSessions=true` does **not** touch them.

## Open Questions

None at design time. Implementation surprises will be flagged via DONE_WITH_CONCERNS during subagent dispatch.
