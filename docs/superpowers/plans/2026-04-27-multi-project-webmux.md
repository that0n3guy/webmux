# Multi-Project Webmux Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor webmux from single-project to multi-project. One process serves a registered list of projects, all running their background work in parallel; the sidebar is a tree of projects with worktrees + scratch sessions nested per project; external tmux is a hardcoded "Unmanaged" node at the top of the tree.

**Architecture:** Per-project state is bundled into a new `ProjectScope` type (rename of today's `WebmuxRuntime`). A new `ProjectRegistry` service owns `Map<projectId, ProjectScope>`, persists `~/.config/webmux/projects.yaml`, and exposes add/remove/list. All API routes get path-prefixed under `/api/projects/:projectId/...` (and likewise for WebSocket). Frontend renders `<ProjectTree>` with per-project polling fanned out via `Promise.all`. External tmux remains globally-routed (`/api/external-sessions`, `/ws/external/:name`); the "Unmanaged" tree node is a frontend-only rendering concept.

**Tech Stack:** Bun, TypeScript strict, `@ts-rest/core`, Zod (`packages/api-contract`), Svelte 5 (runes), Tailwind, xterm.js, `bun test`. CLI uses `@clack/prompts`.

---

## Spec reference

This plan implements `docs/superpowers/specs/2026-04-27-multi-project-webmux-design.md`. Re-read the spec before any task you're unsure about — file paths, type names, behaviours referenced here trace back to specific spec sections.

## Pre-Flight

- [ ] **Step 0: Land `feat/non-worktree-sessions` to main first**

The previous feature branch (`feat/non-worktree-sessions`) introduced scratch + external-tmux sessions. That branch should be pushed, reviewed/merged to main before this plan begins. Verify:

```bash
cd ~/projects/webmux
git fetch origin
git log origin/main..HEAD --oneline | head -20
```

If commits remain, either merge to main first OR start the multi-project work on top of `feat/non-worktree-sessions` and accept that the diff will include both features when this branch eventually merges. Default: continue from current HEAD of `feat/non-worktree-sessions`.

- [ ] **Step 0.5: Branch off**

```bash
git checkout -b feat/multi-project
git rev-parse --abbrev-ref HEAD
```

Expected: on `feat/multi-project`.

- [ ] **Step 0.6: Verify baseline tests pass**

```bash
bun install
bun run --cwd backend test 2>&1 | tail -10
bun test packages/api-contract/src 2>&1 | tail -10
bun test bin/src 2>&1 | tail -10
bun run --cwd frontend test 2>&1 | tail -10
```

Expected: backend ~242 pass / 1 fail (the pre-existing `lifecycle-service.test.ts > merges a clean worktree…` baseline); api-contract 4 pass; bin 68 pass; frontend 61 pass. Investigate any other failure before proceeding.

---

## File Structure

**New files (backend):**
- `backend/src/services/project-registry.ts` — registry (Map, load/save yaml, add/remove)
- `backend/src/services/project-scope.ts` — `ProjectScope` factory (former `WebmuxRuntime` body extracted)
- `backend/src/__tests__/project-registry.test.ts`
- `backend/src/__tests__/project-scope.test.ts`
- `backend/src/__tests__/project-id.test.ts`

**Modified files (backend):**
- `backend/src/runtime.ts` — becomes thin: builds globals + `ProjectRegistry`. Re-exports `MultiProjectRuntime` interface
- `backend/src/server.ts` — every route gets path-prefix; `parseProjectIdParam` introduced; per-project services accessed via `scope.X`
- `backend/src/domain/model.ts` — add `ControlEnvMap.WEBMUX_PROJECT_ID`; `ProjectInfo`, `ProjectListResponse` types (or keep them in api-contract — see Task)
- `backend/src/__tests__/*.test.ts` — every per-service test gets a `ProjectScopeDeps` constructor

**New files (api-contract):**
- (none)

**Modified files (api-contract):**
- `packages/api-contract/src/schemas.ts` — add `ProjectInfoSchema`, `ProjectIdParamsSchema`, `ProjectScopedWorktreeNameParamsSchema`, `ProjectScopedScratchIdParamsSchema`, `CreateProjectRequestSchema`, `RemoveProjectRequestSchema`, `ProjectListResponseSchema`. Extend `NotificationViewSchema` with optional `projectId`.
- `packages/api-contract/src/contract.ts` — `apiPaths` rewritten with `/projects/:projectId/` prefix on every per-project entry; `apiContract` entries updated; 3 new project-registry contract entries

**New files (frontend):**
- `frontend/src/lib/ProjectTree.svelte`
- `frontend/src/lib/ProjectTreeNode.svelte`
- `frontend/src/lib/AddProjectDialog.svelte`

**Modified files (frontend):**
- `frontend/src/lib/types.ts` — `Selection` extends with `projectId`; add `ProjectInfo` type
- `frontend/src/lib/api.ts` — every wrapper gains `projectId` arg; new `fetchProjects/createProject/removeProject` wrappers
- `frontend/src/lib/Terminal.svelte` — wsPath uses `/projects/:projectId/` prefix
- `frontend/src/lib/SessionList.svelte` — `mode: "scratch-only" | "external-only" | "both"` prop so it can render either or both
- `frontend/src/App.svelte` — sidebar replaced with `<ProjectTree>`; per-project state maps; per-project polling
- `frontend/src/lib/CreateWorktreeDialog.svelte`, `SettingsDialog.svelte`, `MobileChatSurface.svelte`, `WorktreeList.svelte`, `WorktreeConversationPanel.svelte` — gain `projectId` prop where they fetch project-scoped data
- `frontend/src/lib/Terminal.test.ts`, `WorktreeList.test.ts`, `MobileChatSurface.test.ts`, `App.test.ts`, etc. — updated for projectId-bearing selections + new prop signatures

**New files (CLI):**
- (none)

**Modified files (CLI):**
- `bin/src/webmux.ts` — `--project <id|path>` flag parsing
- `bin/src/worktree-commands.ts` — accept `projectId` resolution; use `/api/projects/:projectId/worktrees` endpoints
- `bin/src/shared.ts` — add helper `resolveProjectId(opts, registry)` (cwd-aware fallback)
- `bin/src/worktree-commands.test.ts` — update expectations for project-prefixed paths

---

## Phase 1 — ProjectScope + ProjectRegistry + persistence + first-run hydration

### Task 1: Add `ProjectInfo` types and project ID helper

**Files:**
- Modify: `backend/src/adapters/tmux.ts` (already exports `buildProjectSessionName` which uses the same hash logic — extract id helper here)
- Create: `backend/src/__tests__/project-id.test.ts`
- Modify: `packages/api-contract/src/schemas.ts`

- [ ] **Step 1.1: Write the failing project-id test**

Create `backend/src/__tests__/project-id.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { computeProjectId } from "../adapters/tmux";

describe("computeProjectId", () => {
  test("returns first 12 chars of sha1 of resolved path", () => {
    const id = computeProjectId("/home/mercer/projects/webmux-test");
    expect(id).toHaveLength(12);
    expect(id).toMatch(/^[0-9a-f]{12}$/);
  });

  test("is stable for the same input", () => {
    const a = computeProjectId("/home/mercer/projects/webmux-test");
    const b = computeProjectId("/home/mercer/projects/webmux-test");
    expect(a).toBe(b);
  });

  test("different paths yield different ids", () => {
    const a = computeProjectId("/home/mercer/projects/foo");
    const b = computeProjectId("/home/mercer/projects/bar");
    expect(a).not.toBe(b);
  });

  test("matches the suffix used in buildProjectSessionName", () => {
    const path = "/home/mercer/projects/webmux-test";
    const id = computeProjectId(path);
    const sessionName = (await import("../adapters/tmux")).buildProjectSessionName(path);
    expect(sessionName.endsWith(id)).toBe(true);
  });
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
bun run --cwd backend test project-id 2>&1 | tail -10
```

Expected: FAIL — `computeProjectId is not exported`.

- [ ] **Step 1.3: Export `computeProjectId` from tmux adapter**

In `backend/src/adapters/tmux.ts`, alongside `buildProjectSessionName` (around line 73), add:

```ts
export function computeProjectId(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  return createHash("sha1").update(resolved).digest("hex").slice(0, 12);
}
```

Refactor `buildProjectSessionName` to use it:

```ts
export function buildProjectSessionName(projectRoot: string): string {
  const resolved = resolve(projectRoot);
  const base = sanitizeTmuxNameSegment(basename(resolved), 18);
  return `wm-${base}-${computeProjectId(resolved)}`;
}
```

(Note: existing function used `sha1.slice(0, 8)`. We're changing to 12 to match spec. **This is a breaking change** — any existing tmux session named `wm-<basename>-<8-hex>` will not be recognized as a project session. Worktrees still work because they're attached to existing tmux sessions, but `reconciliationService` may need re-warmup. Document in commit message.)

Wait — verify existing length BEFORE making the change:

```bash
grep -n "slice(0, 8)\|hash.slice" /home/mercer/projects/webmux/backend/src/adapters/tmux.ts
```

If existing slice is 8, decide between:
- (a) Keep at 8, update spec to match — less disruptive
- (b) Move to 12, accept breakage on this clone — more code

For this plan, **stay at 8 chars**. Update the test in Step 1.1 to expect length 8 and the regex `/^[0-9a-f]{8}$/`. Update the spec doc in a quick fix-up commit (`docs(spec): correct projectId length to 8 chars`).

- [ ] **Step 1.4: Run test to verify it passes**

```bash
bun run --cwd backend test project-id 2>&1 | tail -10
```

Expected: 4 pass.

- [ ] **Step 1.5: Add `ProjectInfo` schemas + types in api-contract**

In `packages/api-contract/src/schemas.ts`, append (before existing type-export block):

```ts
// ---------------------------------------------------------------------------
// Multi-project: registry types
// ---------------------------------------------------------------------------

export const ProjectInfoSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string(),
  addedAt: z.string(),
  mainBranch: z.string(),
  defaultAgent: z.string(),
});

export const ProjectListResponseSchema = z.object({
  projects: z.array(ProjectInfoSchema),
});

export const CreateProjectRequestSchema = z.object({
  path: z.string().min(1).max(1024),
  displayName: z.string().min(1).max(128).optional(),
  mainBranch: z.string().optional(),
  defaultAgent: z.string().optional(),
  worktreeRoot: z.string().optional(),
});

export const CreateProjectResponseSchema = z.object({
  project: ProjectInfoSchema,
});

export const RemoveProjectRequestSchema = z.object({
  killSessions: z.boolean().optional(),
});

export const ProjectIdParamsSchema = z.object({
  projectId: z.string().min(1),
});

export const ProjectScopedWorktreeNameParamsSchema = z.object({
  projectId: z.string().min(1),
  name: z.string().min(1),
});

export const ProjectScopedScratchIdParamsSchema = z.object({
  projectId: z.string().min(1),
  id: z.string().min(1),
});
```

Also extend the existing `NotificationViewSchema` with optional `projectId`:

```ts
// inside NotificationViewSchema definition
projectId: z.string().nullable().optional(),
```

(Search the file for `NotificationViewSchema` and add the field.)

Add type exports near the bottom:

```ts
export type ProjectInfo = z.infer<typeof ProjectInfoSchema>;
export type ProjectListResponse = z.infer<typeof ProjectListResponseSchema>;
export type CreateProjectRequest = z.infer<typeof CreateProjectRequestSchema>;
export type CreateProjectResponse = z.infer<typeof CreateProjectResponseSchema>;
export type RemoveProjectRequest = z.infer<typeof RemoveProjectRequestSchema>;
```

- [ ] **Step 1.6: Verify contract package still passes**

```bash
bun test packages/api-contract/src 2>&1 | tail -5
```

Expected: 4 pass.

- [ ] **Step 1.7: Commit**

```bash
git add backend/src/adapters/tmux.ts \
        backend/src/__tests__/project-id.test.ts \
        packages/api-contract/src/schemas.ts
git commit -m "feat(domain): add computeProjectId + ProjectInfo schemas"
```

---

### Task 2: Build `ProjectScope` factory

**Files:**
- Create: `backend/src/services/project-scope.ts`
- Create: `backend/src/__tests__/project-scope.test.ts`
- Modify: `backend/src/runtime.ts`

The current `runtime.ts` is the single-project factory. We extract its body into `createProjectScope(deps)` and leave `runtime.ts` as a thin wrapper that calls it.

- [ ] **Step 2.1: Read existing `runtime.ts` carefully**

Read the current `backend/src/runtime.ts` (~120 lines). Note all the services it constructs and what each depends on. The same construction graph moves into `createProjectScope`.

- [ ] **Step 2.2: Write the failing scope test**

Create `backend/src/__tests__/project-scope.test.ts`:

```ts
import { describe, expect, test, beforeAll } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { createProjectScope } from "../services/project-scope";
import { BunTmuxGateway } from "../adapters/tmux";
import { BunGitGateway } from "../adapters/git";
import { BunDockerGateway } from "../adapters/docker";
import { BunPortProbe } from "../adapters/port-probe";
import { BunLifecycleHookRunner } from "../adapters/hooks";
import { AutoNameService } from "../services/auto-name-service";
import { NotificationService } from "../services/notification-service";

function fakeProjectDir(): string {
  const dir = mkdtempSync(`${tmpdir()}/wm-scope-`);
  // bare-bones .webmux.yaml so loadConfig succeeds
  writeFileSync(`${dir}/.webmux.yaml`, "name: scope-test\nworkspace:\n  mainBranch: main\n");
  // initialize as a git repo so reconciliationService.reconcile doesn't blow up
  // (the test doesn't actually call reconcile, but the constructor expects a real path)
  return resolve(dir);
}

describe("createProjectScope", () => {
  test("constructs a scope with all per-project services bound to the project dir", () => {
    const dir = fakeProjectDir();
    const scope = createProjectScope({
      projectDir: dir,
      port: 9999,
      git: new BunGitGateway(),
      tmux: new BunTmuxGateway(),
      docker: new BunDockerGateway(),
      portProbe: new BunPortProbe(),
      hooks: new BunLifecycleHookRunner(),
      autoName: new AutoNameService(),
      runtimeNotifications: new NotificationService(),
    });

    expect(scope.projectDir).toBe(dir);
    expect(scope.config.name).toBe("scope-test");
    expect(scope.scratchSessionService).toBeDefined();
    expect(scope.lifecycleService).toBeDefined();
    expect(scope.reconciliationService).toBeDefined();
    expect(scope.archiveStateService).toBeDefined();
    expect(scope.projectRuntime).toBeDefined();
    expect(scope.worktreeCreationTracker).toBeDefined();
  });

  test("dispose() runs without throwing on a fresh scope", () => {
    const dir = fakeProjectDir();
    const scope = createProjectScope({
      projectDir: dir,
      port: 9999,
      git: new BunGitGateway(),
      tmux: new BunTmuxGateway(),
      docker: new BunDockerGateway(),
      portProbe: new BunPortProbe(),
      hooks: new BunLifecycleHookRunner(),
      autoName: new AutoNameService(),
      runtimeNotifications: new NotificationService(),
    });
    expect(() => scope.dispose()).not.toThrow();
  });
});
```

- [ ] **Step 2.3: Run test to verify it fails**

```bash
bun run --cwd backend test project-scope 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 2.4: Implement `createProjectScope`**

Create `backend/src/services/project-scope.ts`:

```ts
import { loadConfig, type ProjectConfig } from "../adapters/config";
import { loadControlToken } from "../adapters/control-token";
import type { BunDockerGateway } from "../adapters/docker";
import type { BunGitGateway } from "../adapters/git";
import type { BunLifecycleHookRunner } from "../adapters/hooks";
import type { BunPortProbe } from "../adapters/port-probe";
import type { BunTmuxGateway } from "../adapters/tmux";
import { computeProjectId } from "../adapters/tmux";
import { ArchiveStateService } from "./archive-state-service";
import { AutoNameService } from "./auto-name-service";
import { LifecycleService, type CreateWorktreeProgress } from "./lifecycle-service";
import { NotificationService } from "./notification-service";
import { ProjectRuntime } from "./project-runtime";
import { ReconciliationService } from "./reconciliation-service";
import { createScratchSessionService, type ScratchSessionService } from "./scratch-session-service";
import { getAgentDefinition } from "./agent-registry";
import { buildBareAgentInvocation } from "./agent-service";
import { WorktreeCreationTracker } from "./worktree-creation-service";

export interface ProjectScopeDeps {
  projectDir: string;
  port: number;
  git: BunGitGateway;
  tmux: BunTmuxGateway;
  docker: BunDockerGateway;
  portProbe: BunPortProbe;
  hooks: BunLifecycleHookRunner;
  autoName: AutoNameService;
  runtimeNotifications: NotificationService;
  onCreateProgress?: (progress: CreateWorktreeProgress) => void | Promise<void>;
}

export interface ProjectScope {
  projectId: string;
  projectDir: string;
  config: ProjectConfig;
  archiveStateService: ArchiveStateService;
  projectRuntime: ProjectRuntime;
  worktreeCreationTracker: WorktreeCreationTracker;
  reconciliationService: ReconciliationService;
  lifecycleService: LifecycleService;
  scratchSessionService: ScratchSessionService;
  removingBranches: Set<string>;
  dispose(): void;
}

export function createProjectScope(deps: ProjectScopeDeps): ProjectScope {
  const projectDir = deps.projectDir;
  const projectId = computeProjectId(projectDir);
  const config = loadConfig(projectDir, { resolvedRoot: true });

  const archiveStateService = new ArchiveStateService(deps.git.resolveWorktreeGitDir(projectDir));
  const projectRuntime = new ProjectRuntime();
  const worktreeCreationTracker = new WorktreeCreationTracker();

  const reconciliationService = new ReconciliationService({
    config,
    git: deps.git,
    tmux: deps.tmux,
    portProbe: deps.portProbe,
    runtime: projectRuntime,
  });

  const lifecycleService = new LifecycleService({
    projectRoot: projectDir,
    controlBaseUrl: `http://127.0.0.1:${deps.port}`,
    getControlToken: loadControlToken,
    config,
    archiveState: archiveStateService,
    git: deps.git,
    tmux: deps.tmux,
    docker: deps.docker,
    reconciliation: reconciliationService,
    hooks: deps.hooks,
    autoName: deps.autoName,
    onCreateProgress: (progress) => {
      worktreeCreationTracker.set(progress);
      deps.onCreateProgress?.(progress);
    },
    onCreateFinished: (branch) => {
      worktreeCreationTracker.clear(branch);
    },
  });

  const scratchSessionService = createScratchSessionService({
    tmux: deps.tmux,
    cwd: projectDir,
    getAgentLaunchCommand: (agentId) => {
      // delegate to the lifecycle's resolved registry (config.agents includes built-in + custom)
      const agent = getAgentDefinition({ config, agents: config.agents }, agentId);
      if (!agent) return null;
      return buildBareAgentInvocation(agent, { cwd: projectDir });
    },
  });
  scratchSessionService.scan();

  const removingBranches = new Set<string>();

  return {
    projectId,
    projectDir,
    config,
    archiveStateService,
    projectRuntime,
    worktreeCreationTracker,
    reconciliationService,
    lifecycleService,
    scratchSessionService,
    removingBranches,
    dispose() {
      // cancel any future polling timers; today services don't expose stop methods.
      // Per spec: this is a placeholder until per-service shutdowns are added.
      // For now, nulling out doesn't hurt — the scope will be unreachable.
    },
  };
}
```

- [ ] **Step 2.5: Run test to verify it passes**

```bash
bun run --cwd backend test project-scope 2>&1 | tail -10
```

Expected: 2 pass.

- [ ] **Step 2.6: Refactor `runtime.ts` to use `createProjectScope`**

Replace the body of `createWebmuxRuntime` in `backend/src/runtime.ts` so that the per-project services are constructed via `createProjectScope`. The export shape stays the same for now (a single-project runtime); a later task replaces this with `MultiProjectRuntime`.

```ts
import { loadConfig, projectRoot, type ProjectConfig } from "./adapters/config";
import { BunDockerGateway } from "./adapters/docker";
import { BunGitGateway } from "./adapters/git";
import { BunLifecycleHookRunner } from "./adapters/hooks";
import { BunPortProbe } from "./adapters/port-probe";
import { BunTmuxGateway } from "./adapters/tmux";
import { AutoNameService } from "./services/auto-name-service";
import { NotificationService as RuntimeNotificationService } from "./services/notification-service";
import { createProjectScope, type ProjectScope } from "./services/project-scope";
import { type CreateWorktreeProgress } from "./services/lifecycle-service";

export interface WebmuxRuntimeOptions {
  projectDir?: string;
  port?: number;
  onCreateProgress?: (progress: CreateWorktreeProgress) => void | Promise<void>;
}

export interface WebmuxRuntime {
  port: number;
  projectDir: string;
  config: ProjectConfig;
  // global gateways
  git: BunGitGateway;
  tmux: BunTmuxGateway;
  docker: BunDockerGateway;
  portProbe: BunPortProbe;
  hooks: BunLifecycleHookRunner;
  autoName: AutoNameService;
  runtimeNotifications: RuntimeNotificationService;
  // single (for now) project scope — replaced by registry in Task 3
  scope: ProjectScope;
}

export function createWebmuxRuntime(options: WebmuxRuntimeOptions = {}): WebmuxRuntime {
  const port = options.port ?? parseInt(Bun.env.PORT || "5111", 10);
  const projectDir = projectRoot(options.projectDir ?? Bun.env.WEBMUX_PROJECT_DIR ?? process.cwd());
  const git = new BunGitGateway();
  const tmux = new BunTmuxGateway();
  const docker = new BunDockerGateway();
  const portProbe = new BunPortProbe();
  const hooks = new BunLifecycleHookRunner();
  const autoName = new AutoNameService();
  const runtimeNotifications = new RuntimeNotificationService();

  const scope = createProjectScope({
    projectDir,
    port,
    git,
    tmux,
    docker,
    portProbe,
    hooks,
    autoName,
    runtimeNotifications,
    onCreateProgress: options.onCreateProgress,
  });

  return {
    port,
    projectDir,
    config: scope.config,
    git,
    tmux,
    docker,
    portProbe,
    hooks,
    autoName,
    runtimeNotifications,
    scope,
  };
}
```

In `server.ts`, every `runtime.X` reference for a per-project service (lifecycleService, projectRuntime, archiveStateService, reconciliationService, scratchSessionService, worktreeCreationTracker, removingBranches… and also `runtime.projectDir` since that's per-project) needs to become `runtime.scope.X`. Find them with:

```bash
grep -n "runtime\." backend/src/server.ts | head -60
```

Apply the rewrite. The mechanical change set:
- `runtime.projectRuntime` → `runtime.scope.projectRuntime`
- `runtime.lifecycleService` → `runtime.scope.lifecycleService`
- `runtime.archiveStateService` → `runtime.scope.archiveStateService`
- `runtime.reconciliationService` → `runtime.scope.reconciliationService`
- `runtime.worktreeCreationTracker` → `runtime.scope.worktreeCreationTracker`
- `runtime.scratchSessionService` → `runtime.scope.scratchSessionService` (added in non-worktree-sessions branch)

Pull-out `const`s near the top of `server.ts` get `runtime.scope` once and destructure:

```ts
const scope = runtime.scope;
const projectRuntime = scope.projectRuntime;
const lifecycleService = scope.lifecycleService;
// ...etc, mirror the existing destructuring lines
```

(That's the smallest churn for now — full path-prefix routing is in Phase 2.)

- [ ] **Step 2.7: Build + full backend tests**

```bash
cd /home/mercer/projects/webmux && bun run build 2>&1 | tail -10
bun run --cwd backend test 2>&1 | tail -10
```

Expected: clean build; tests pass at the existing baseline (~244 pass / 1 fail with the +2 new project-scope tests).

- [ ] **Step 2.8: Commit**

```bash
git add backend/src/services/project-scope.ts \
        backend/src/__tests__/project-scope.test.ts \
        backend/src/runtime.ts \
        backend/src/server.ts
git commit -m "refactor(backend): extract per-project state into ProjectScope"
```

---

### Task 3: Build `ProjectRegistry`

**Files:**
- Create: `backend/src/services/project-registry.ts`
- Create: `backend/src/__tests__/project-registry.test.ts`

- [ ] **Step 3.1: Write failing tests for the registry**

Create `backend/src/__tests__/project-registry.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createProjectRegistry, type ProjectRegistry } from "../services/project-registry";

let workdir: string;
let registryPath: string;

function makeProjectDir(name: string, withConfig = true): string {
  const dir = join(workdir, name);
  require("node:fs").mkdirSync(dir, { recursive: true });
  if (withConfig) {
    writeFileSync(join(dir, ".webmux.yaml"), `name: ${name}\nworkspace:\n  mainBranch: main\n`);
  }
  return resolve(dir);
}

beforeEach(() => {
  workdir = mkdtempSync(`${tmpdir()}/wm-registry-`);
  registryPath = join(workdir, "projects.yaml");
});

afterEach(() => {
  rmSync(workdir, { recursive: true, force: true });
});

function buildDeps() {
  // Inline minimal globals for the test — real impls used so persistence is realistic
  const { BunTmuxGateway } = require("../adapters/tmux");
  const { BunGitGateway } = require("../adapters/git");
  const { BunDockerGateway } = require("../adapters/docker");
  const { BunPortProbe } = require("../adapters/port-probe");
  const { BunLifecycleHookRunner } = require("../adapters/hooks");
  const { AutoNameService } = require("../services/auto-name-service");
  const { NotificationService } = require("../services/notification-service");
  return {
    registryPath,
    port: 9999,
    git: new BunGitGateway(),
    tmux: new BunTmuxGateway(),
    docker: new BunDockerGateway(),
    portProbe: new BunPortProbe(),
    hooks: new BunLifecycleHookRunner(),
    autoName: new AutoNameService(),
    runtimeNotifications: new NotificationService(),
  };
}

describe("ProjectRegistry", () => {
  test("starts empty when no yaml exists", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    expect(reg.list()).toEqual([]);
  });

  test("add() registers a project, returns scope, persists yaml", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();

    const dir = makeProjectDir("alpha");
    const info = await reg.add({ path: dir });

    expect(info.path).toBe(dir);
    expect(info.id).toMatch(/^[0-9a-f]{8}$/);
    expect(reg.list()).toHaveLength(1);
    expect(reg.get(info.id)?.projectDir).toBe(dir);

    expect(existsSync(registryPath)).toBe(true);
    const yaml = readFileSync(registryPath, "utf-8");
    expect(yaml).toContain(dir);
  });

  test("add() rejects path that doesn't exist", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    await expect(reg.add({ path: "/nonexistent/path/xyz" })).rejects.toThrow();
  });

  test("add() rejects duplicate path", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    const dir = makeProjectDir("beta");
    await reg.add({ path: dir });
    await expect(reg.add({ path: dir })).rejects.toThrow(/already registered|duplicate/i);
  });

  test("add() initializes .webmux.yaml when absent", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    const dir = makeProjectDir("gamma", false); // no .webmux.yaml yet
    const info = await reg.add({ path: dir, displayName: "Gamma", mainBranch: "develop" });
    expect(info.name).toBe("Gamma");
    expect(info.mainBranch).toBe("develop");
    expect(existsSync(join(dir, ".webmux.yaml"))).toBe(true);
  });

  test("add() reads existing .webmux.yaml and ignores body init fields", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    const dir = makeProjectDir("delta", true); // pre-existing config with name=delta, mainBranch=main
    const info = await reg.add({ path: dir, displayName: "OverrideAttempt", mainBranch: "develop" });
    expect(info.name).toBe("delta"); // from yaml, not body
    expect(info.mainBranch).toBe("main"); // from yaml, not body
  });

  test("remove() drops scope and persists", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    const dir = makeProjectDir("epsilon");
    const info = await reg.add({ path: dir });
    expect(reg.list()).toHaveLength(1);

    await reg.remove(info.id, { killSessions: false });
    expect(reg.list()).toHaveLength(0);
    expect(reg.get(info.id)).toBeNull();

    const yaml = readFileSync(registryPath, "utf-8");
    expect(yaml).not.toContain(info.id);
  });

  test("remove() of unknown id throws", async () => {
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    await expect(reg.remove("does-not-exist", { killSessions: false })).rejects.toThrow();
  });

  test("load() reconstructs scopes from prior persistence", async () => {
    const dir = makeProjectDir("zeta");
    // Pre-write a registry yaml to simulate prior process state
    writeFileSync(registryPath, `schemaVersion: 1\nprojects:\n  - id: ${require("../adapters/tmux").computeProjectId(dir)}\n    path: ${dir}\n    addedAt: "2026-04-27T17:00:00Z"\n`);

    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    expect(reg.list()).toHaveLength(1);
    expect(reg.list()[0].path).toBe(dir);
  });

  test("load() skips entries whose path no longer exists (warns)", async () => {
    writeFileSync(registryPath, `schemaVersion: 1\nprojects:\n  - id: deadbeef\n    path: /nonexistent\n    addedAt: "2026-04-27T17:00:00Z"\n`);
    const reg = createProjectRegistry(buildDeps());
    await reg.load();
    expect(reg.list()).toHaveLength(0);
  });
});
```

- [ ] **Step 3.2: Run test to verify it fails**

```bash
bun run --cwd backend test project-registry 2>&1 | tail -10
```

Expected: FAIL — module not found.

- [ ] **Step 3.3: Implement `createProjectRegistry`**

Create `backend/src/services/project-registry.ts`:

```ts
import { existsSync, mkdirSync, readFileSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { BunDockerGateway } from "../adapters/docker";
import type { BunGitGateway } from "../adapters/git";
import type { BunLifecycleHookRunner } from "../adapters/hooks";
import type { BunPortProbe } from "../adapters/port-probe";
import type { BunTmuxGateway } from "../adapters/tmux";
import { computeProjectId, buildProjectSessionName } from "../adapters/tmux";
import type { AutoNameService } from "./auto-name-service";
import type { NotificationService } from "./notification-service";
import { createProjectScope, type ProjectScope } from "./project-scope";
import type { ProjectInfo } from "@webmux/api-contract";
import { log } from "../lib/log";

const REGISTRY_SCHEMA_VERSION = 1;

interface RegistryFile {
  schemaVersion: number;
  projects: { id: string; path: string; addedAt: string }[];
}

export interface ProjectRegistryDeps {
  registryPath?: string; // default `~/.config/webmux/projects.yaml`
  port: number;
  git: BunGitGateway;
  tmux: BunTmuxGateway;
  docker: BunDockerGateway;
  portProbe: BunPortProbe;
  hooks: BunLifecycleHookRunner;
  autoName: AutoNameService;
  runtimeNotifications: NotificationService;
}

export interface ProjectRegistry {
  load(): Promise<void>;
  add(input: AddProjectInput): Promise<ProjectInfo>;
  remove(id: string, opts: { killSessions: boolean }): Promise<void>;
  list(): ProjectInfo[];
  get(id: string): ProjectScope | null;
  getInfo(id: string): ProjectInfo | null;
}

export interface AddProjectInput {
  path: string;
  displayName?: string;
  mainBranch?: string;
  defaultAgent?: string;
  worktreeRoot?: string;
}

const DEFAULT_REGISTRY_PATH = join(process.env.HOME ?? "/tmp", ".config", "webmux", "projects.yaml");

export function createProjectRegistry(deps: ProjectRegistryDeps): ProjectRegistry {
  const registryPath = deps.registryPath ?? DEFAULT_REGISTRY_PATH;
  const scopes = new Map<string, ProjectScope>();
  const meta = new Map<string, { addedAt: string }>();

  function buildInfo(scope: ProjectScope): ProjectInfo {
    const m = meta.get(scope.projectId);
    return {
      id: scope.projectId,
      path: scope.projectDir,
      name: scope.config.name ?? scope.projectId,
      addedAt: m?.addedAt ?? new Date().toISOString(),
      mainBranch: scope.config.workspace?.mainBranch ?? "main",
      defaultAgent: scope.config.workspace?.defaultAgent ?? "claude",
    };
  }

  function persist(): void {
    const file: RegistryFile = {
      schemaVersion: REGISTRY_SCHEMA_VERSION,
      projects: [...scopes.values()].map((s) => ({
        id: s.projectId,
        path: s.projectDir,
        addedAt: meta.get(s.projectId)?.addedAt ?? new Date().toISOString(),
      })),
    };
    mkdirSync(dirname(registryPath), { recursive: true });
    writeFileSync(registryPath, stringifyYaml(file));
  }

  function constructScope(projectDir: string): ProjectScope {
    return createProjectScope({
      projectDir,
      port: deps.port,
      git: deps.git,
      tmux: deps.tmux,
      docker: deps.docker,
      portProbe: deps.portProbe,
      hooks: deps.hooks,
      autoName: deps.autoName,
      runtimeNotifications: deps.runtimeNotifications,
    });
  }

  function ensureWebmuxYaml(projectDir: string, init: AddProjectInput): void {
    const yamlPath = join(projectDir, ".webmux.yaml");
    if (existsSync(yamlPath)) return;
    const body: Record<string, unknown> = {
      name: init.displayName ?? projectDir.split("/").pop(),
      workspace: {
        mainBranch: init.mainBranch ?? "main",
        defaultAgent: init.defaultAgent ?? "claude",
        worktreeRoot: init.worktreeRoot ?? "__worktrees",
      },
    };
    writeFileSync(yamlPath, stringifyYaml(body));
  }

  return {
    async load() {
      if (!existsSync(registryPath)) return;
      let raw: string;
      try {
        raw = readFileSync(registryPath, "utf-8");
      } catch (err) {
        log.warn(`[project-registry] failed to read ${registryPath}: ${err instanceof Error ? err.message : err}`);
        return;
      }

      let parsed: unknown;
      try {
        parsed = parseYaml(raw);
      } catch (err) {
        log.warn(`[project-registry] failed to parse ${registryPath}: ${err instanceof Error ? err.message : err}`);
        return;
      }

      if (!parsed || typeof parsed !== "object" || !("projects" in parsed)) return;
      const projects = (parsed as RegistryFile).projects ?? [];

      for (const entry of projects) {
        if (!existsSync(entry.path)) {
          log.warn(`[project-registry] skipping missing path: ${entry.path}`);
          continue;
        }
        try {
          const scope = constructScope(entry.path);
          scopes.set(scope.projectId, scope);
          meta.set(scope.projectId, { addedAt: entry.addedAt });
        } catch (err) {
          log.warn(`[project-registry] failed to construct scope for ${entry.path}: ${err instanceof Error ? err.message : err}`);
        }
      }
    },

    async add(input) {
      const absPath = resolve(input.path);
      if (!existsSync(absPath)) {
        throw new Error(`Path does not exist: ${absPath}`);
      }
      if (!statSync(absPath).isDirectory()) {
        throw new Error(`Path is not a directory: ${absPath}`);
      }
      const id = computeProjectId(absPath);
      if (scopes.has(id)) {
        throw new Error(`Project already registered: ${absPath}`);
      }

      ensureWebmuxYaml(absPath, input);
      const scope = constructScope(absPath);
      scopes.set(scope.projectId, scope);
      meta.set(scope.projectId, { addedAt: new Date().toISOString() });
      persist();
      return buildInfo(scope);
    },

    async remove(id, opts) {
      const scope = scopes.get(id);
      if (!scope) throw new Error(`Project not found: ${id}`);

      const scratchToKill = opts.killSessions ? scope.scratchSessionService.list().map((s) => s.sessionName) : [];

      scope.dispose();
      scopes.delete(id);
      meta.delete(id);
      persist();

      if (opts.killSessions) {
        const projectSession = buildProjectSessionName(scope.projectDir);
        try { deps.tmux.killSession(projectSession); } catch { /* noop */ }
        for (const name of scratchToKill) {
          try { deps.tmux.killSession(name); } catch { /* noop */ }
        }
      }
    },

    list() {
      return [...scopes.values()].map(buildInfo);
    },

    get(id) {
      return scopes.get(id) ?? null;
    },

    getInfo(id) {
      const scope = scopes.get(id);
      return scope ? buildInfo(scope) : null;
    },
  };
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

```bash
bun run --cwd backend test project-registry 2>&1 | tail -15
```

Expected: 9 pass.

- [ ] **Step 3.5: Commit**

```bash
git add backend/src/services/project-registry.ts \
        backend/src/__tests__/project-registry.test.ts
git commit -m "feat(backend): add ProjectRegistry with yaml persistence"
```

---

### Task 4: Wire `ProjectRegistry` into `runtime.ts` with first-run hydration

**Files:**
- Modify: `backend/src/runtime.ts`
- Modify: `backend/src/server.ts`

- [ ] **Step 4.1: Wire registry into the runtime**

Replace the body of `createWebmuxRuntime` so it constructs the registry, calls `await registry.load()`, then performs first-run hydration:

```ts
import { createProjectRegistry, type ProjectRegistry } from "./services/project-registry";

export interface MultiProjectRuntime {
  port: number;
  git: BunGitGateway;
  tmux: BunTmuxGateway;
  docker: BunDockerGateway;
  portProbe: BunPortProbe;
  hooks: BunLifecycleHookRunner;
  autoName: AutoNameService;
  runtimeNotifications: RuntimeNotificationService;
  projectRegistry: ProjectRegistry;
}

export async function createWebmuxRuntime(options: WebmuxRuntimeOptions = {}): Promise<MultiProjectRuntime> {
  const port = options.port ?? parseInt(Bun.env.PORT || "5111", 10);
  const git = new BunGitGateway();
  const tmux = new BunTmuxGateway();
  const docker = new BunDockerGateway();
  const portProbe = new BunPortProbe();
  const hooks = new BunLifecycleHookRunner();
  const autoName = new AutoNameService();
  const runtimeNotifications = new RuntimeNotificationService();

  const projectRegistry = createProjectRegistry({
    port, git, tmux, docker, portProbe, hooks, autoName, runtimeNotifications,
  });
  await projectRegistry.load();

  // First-run hydration: if no projects loaded AND cwd has .webmux.yaml, auto-register.
  if (projectRegistry.list().length === 0) {
    const cwd = options.projectDir ?? Bun.env.WEBMUX_PROJECT_DIR ?? process.cwd();
    if (existsSync(join(cwd, ".webmux.yaml"))) {
      try {
        await projectRegistry.add({ path: cwd });
      } catch (err) {
        log.warn(`[runtime] first-run auto-add failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  return {
    port,
    git,
    tmux,
    docker,
    portProbe,
    hooks,
    autoName,
    runtimeNotifications,
    projectRegistry,
  };
}
```

(Add necessary imports: `existsSync`, `join`, `log`.)

The old `WebmuxRuntime` interface (with the embedded `scope`) is now replaced by `MultiProjectRuntime`. Update consumers in `server.ts`.

- [ ] **Step 4.2: Update `server.ts` to use the registry as a single-project compat shim**

Until Phase 2 prefixes routes, every existing handler operates on a single "current" project. Pick the first registered project as the de-facto current one:

```ts
const runtime = await createWebmuxRuntime({ port: PORT });
const firstProject = runtime.projectRegistry.list()[0];
if (!firstProject) {
  log.error("[server] no projects registered. Run `webmux init` in a project dir or POST /api/projects.");
  process.exit(1);
}
const scope = runtime.projectRegistry.get(firstProject.id);
if (!scope) throw new Error("first project scope missing immediately after registration");

const PROJECT_DIR = scope.projectDir;
const config = scope.config;
const git = runtime.git;
const tmux = runtime.tmux;
const projectRuntime = scope.projectRuntime;
// ...etc
```

(Note: `await createWebmuxRuntime(...)` makes `server.ts`'s top-level execution async. Wrap in an async IIFE or use top-level await.)

- [ ] **Step 4.3: Build + tests**

```bash
cd /home/mercer/projects/webmux && bun run build 2>&1 | tail -10
bun run --cwd backend test 2>&1 | tail -10
```

Expected: clean build; tests still ~244 pass / 1 fail (no new tests in this task, but the existing tests should not regress).

- [ ] **Step 4.4: Smoke-test the new wiring**

```bash
cd ~/projects/webmux-test && PORT=5199 bun run /home/mercer/projects/webmux/bin/webmux.js serve --port 5199 2>&1 | head -30 &
SERVER_PID=$!
sleep 3
curl -sS http://localhost:5199/api/worktrees 2>&1 | head -1
kill $SERVER_PID
```

Expected: still works as a single-project app; the registry quietly auto-registered the cwd.

- [ ] **Step 4.5: Commit**

```bash
git add backend/src/runtime.ts backend/src/server.ts
git commit -m "feat(runtime): wire ProjectRegistry with first-run hydration"
```

---

## Phase 2 — Path-prefix every route + contract + frontend api.ts + Selection + Terminal wsPath

This is the largest atomic-coupled change in the plan. Backend route changes break frontend; the entire phase is one logical unit.

### Task 5: Add path-prefixed apiPaths in contract

**Files:**
- Modify: `packages/api-contract/src/contract.ts`

- [ ] **Step 5.1: Rewrite every per-project apiPaths entry**

Open `packages/api-contract/src/contract.ts`. The `apiPaths` object lists every route. For each per-project route, prepend `/projects/:projectId`. Reference the spec's "Per-project routes" section for the full list.

Concretely:
- `/api/branches` → `/api/projects/:projectId/branches`
- `/api/base-branches` → `/api/projects/:projectId/base-branches`
- `/api/project` → `/api/projects/:projectId/project`
- `/api/agents` → `/api/projects/:projectId/agents`
- `/api/agents/:id` → `/api/projects/:projectId/agents/:id`
- `/api/agents/validate` → `/api/projects/:projectId/agents/validate`
- `/api/agents/worktrees/:name/...` → `/api/projects/:projectId/agents/worktrees/:name/...`
- `/api/worktrees` → `/api/projects/:projectId/worktrees`
- `/api/worktrees/:name` → `/api/projects/:projectId/worktrees/:name`
- `/api/worktrees/:name/{open|close|merge|archive|send|diff}` → `/api/projects/:projectId/worktrees/:name/{...}`
- `/api/scratch-sessions` → `/api/projects/:projectId/scratch-sessions`
- `/api/scratch-sessions/:id` → `/api/projects/:projectId/scratch-sessions/:id`
- `/api/linear/issues` → `/api/projects/:projectId/linear/issues`
- `/api/linear/auto-create` → `/api/projects/:projectId/linear/auto-create`
- `/api/github/auto-remove-on-merge` → `/api/projects/:projectId/github/auto-remove-on-merge`
- `/api/pull-main` → `/api/projects/:projectId/pull-main`
- `/api/ci-logs/:runId` → `/api/projects/:projectId/ci-logs/:runId`
- `/api/notifications/:id/dismiss` → `/api/projects/:projectId/notifications/:id/dismiss`

Stays global:
- `/api/config`
- `/api/external-sessions`
- `/api/runtime/events` (control-token endpoint)
- `/api/notifications/stream` (SSE)

New global:
- `/api/projects` (GET, POST)
- `/api/projects/:projectId` (DELETE) — note this matches the prefix shape too

WebSocket paths similarly prefixed for terminal/scratch/agents; `/ws/external/:sessionName` stays.

- [ ] **Step 5.2: Update each apiContract entry's `path` and `pathParams`**

Every contract entry that uses `WorktreeNameParamsSchema` becomes `ProjectScopedWorktreeNameParamsSchema`. Same for scratch ID. For routes that take only the projectId (e.g., `fetchWorktrees`), use `ProjectIdParamsSchema`.

Add the 3 new project-registry contract entries:

```ts
fetchProjects: {
  method: "GET",
  path: apiPaths.fetchProjects,
  responses: {
    200: ProjectListResponseSchema,
    500: ErrorResponseSchema,
  },
},
createProject: {
  method: "POST",
  path: apiPaths.createProject,
  body: CreateProjectRequestSchema,
  responses: {
    201: CreateProjectResponseSchema,
    ...commonErrorResponses,
  },
},
removeProject: {
  method: "DELETE",
  path: apiPaths.removeProject,
  pathParams: ProjectIdParamsSchema,
  body: RemoveProjectRequestSchema,
  responses: {
    200: OkResponseSchema,
    ...commonErrorResponses,
  },
},
```

Add corresponding apiPaths entries:

```ts
fetchProjects: "/api/projects",
createProject: "/api/projects",
removeProject: "/api/projects/:projectId",
```

- [ ] **Step 5.3: Verify contract tests pass**

```bash
bun test packages/api-contract/src 2>&1 | tail -10
```

Expected: 4 pass.

- [ ] **Step 5.4: Commit**

```bash
git add packages/api-contract/src/contract.ts
git commit -m "feat(contract): path-prefix per-project routes; add project registry endpoints"
```

---

### Task 6: Update server.ts handlers with `parseProjectIdParam`

**Files:**
- Modify: `backend/src/server.ts`

This task is mechanical but voluminous. Every per-project handler gains a `scope = parseProjectIdParam(...)` step at the top.

- [ ] **Step 6.1: Add the helper**

In `backend/src/server.ts`, near `parseWorktreeNameParam`:

```ts
function parseProjectIdParam(
  params: Record<string, string>,
): { ok: true; data: { id: string; scope: ProjectScope } } | { ok: false; response: Response } {
  const id = params.projectId;
  if (!id || id.length === 0) {
    return { ok: false, response: errorResponse("Missing projectId", 400) };
  }
  const scope = runtime.projectRegistry.get(id);
  if (!scope) {
    return { ok: false, response: errorResponse(`Project not found: ${id}`, 404) };
  }
  return { ok: true, data: { id, scope } };
}
```

- [ ] **Step 6.2: Add the project-registry handlers**

```ts
async function apiListProjects(): Promise<Response> {
  return jsonResponse({ projects: runtime.projectRegistry.list() });
}

async function apiCreateProject(req: Request): Promise<Response> {
  const body = CreateProjectRequestSchema.parse(await req.json());
  const project = await runtime.projectRegistry.add(body);
  return jsonResponse({ project }, 201);
}

async function apiRemoveProject(id: string, req: Request): Promise<Response> {
  const body = RemoveProjectRequestSchema.parse(await req.json());
  await runtime.projectRegistry.remove(id, { killSessions: body.killSessions ?? false });
  return jsonResponse({ ok: true });
}
```

- [ ] **Step 6.3: Rewrite each existing per-project handler to use `scope`**

For every existing handler that today reads `scope.X` (from Task 2's compat shim), change the function signature to accept the scope explicitly. Example for `apiGetWorktrees`:

```ts
async function apiGetWorktrees(scope: ProjectScope): Promise<Response> {
  await scope.reconciliationService.reconcile(scope.projectDir);
  return jsonResponse({ worktrees: buildWorktreeListResponse(scope) });
}
```

Then in route registration:

```ts
[apiPaths.fetchWorktrees]: {
  GET: (req) => {
    const parsed = parseProjectIdParam(req.params);
    if (!parsed.ok) return parsed.response;
    return catching("GET /api/projects/:projectId/worktrees", () => apiGetWorktrees(parsed.data.scope));
  },
  POST: (req) => {
    const parsed = parseProjectIdParam(req.params);
    if (!parsed.ok) return parsed.response;
    return catching("POST /api/projects/:projectId/worktrees", () => apiCreateWorktree(parsed.data.scope, req));
  },
},
```

Apply this pattern to **every** per-project handler. The handlers are spread across `server.ts` from roughly line 1272 to line 1500 — work through each `[apiPaths.X]` block, change signature, add `parseProjectIdParam` at the route registration.

- [ ] **Step 6.4: Register the 3 new project-registry routes**

```ts
[apiPaths.fetchProjects]: {
  GET: () => catching("GET /api/projects", () => apiListProjects()),
  POST: (req) => catching("POST /api/projects", () => apiCreateProject(req)),
},

[apiPaths.removeProject]: {
  DELETE: (req) => {
    const parsed = parseProjectIdParam(req.params);
    if (!parsed.ok) return parsed.response;
    return catching("DELETE /api/projects/:projectId", () => apiRemoveProject(parsed.data.id, req));
  },
},
```

- [ ] **Step 6.5: Build**

```bash
bun run build 2>&1 | tail -20
```

Expected: clean build (frontend will fail later because the contract changed; that's addressed in Task 9). Backend should be clean.

- [ ] **Step 6.6: Run backend tests**

```bash
bun run --cwd backend test 2>&1 | tail -10
```

Expected: existing tests still pass at the documented baseline.

- [ ] **Step 6.7: Commit (defer to end of phase)**

The phase commits Tasks 5–11 together because contract changes break frontend. Hold the commit.

---

### Task 7: Update WebSocket routes with project prefix

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 7.1: Replace `/ws/:worktree` with `/ws/projects/:projectId/:worktree`**

Update the route registration and the handler:

```ts
"/ws/projects/:projectId/:worktree": (req, server) => {
  const projectId = decodeURIComponent(req.params.projectId);
  const branch = decodeURIComponent(req.params.worktree);
  const scope = runtime.projectRegistry.get(projectId);
  if (!scope) return new Response("Project not found", { status: 404 });
  return server.upgrade(req, {
    data: { kind: "terminal", projectId, branch, worktreeId: null, attachId: null, attached: false },
  })
    ? undefined
    : new Response("WebSocket upgrade failed", { status: 400 });
},
```

Likewise:
- `/ws/projects/:projectId/scratch/:id` (replaces `/ws/scratch/:id`)
- `/ws/projects/:projectId/agents/worktrees/:name` (replaces `/ws/agents/worktrees/:name`)

Extend `TerminalWsData`, `ScratchTerminalWsData`, and `AgentsWsData` to include `projectId: string`. Update the message handler so when it calls `resolveTerminalWorktree(branch)`, it now also takes the project scope and resolves against `scope.projectRuntime` instead of the global one:

```ts
async function resolveTerminalWorktree(scope: ProjectScope, branch: string): Promise<{ ... }> {
  // identical body, but uses `scope.projectRuntime` and `scope.reconciliationService` and `scope.projectDir`
}
```

The `if (data.kind === "terminal")` branch in the message handler now passes `scope` from `runtime.projectRegistry.get(data.projectId)`.

`ExternalTerminalWsData` does NOT gain a `projectId` (external is global).

- [ ] **Step 7.2: Build**

```bash
bun run build 2>&1 | tail -10
```

Expected: clean build for backend.

- [ ] **Step 7.3: Defer commit (phase-bundled)**

---

### Task 8: Frontend types + Selection extension

**Files:**
- Modify: `frontend/src/lib/types.ts`

- [ ] **Step 8.1: Update Selection union and add ProjectInfo type**

In `frontend/src/lib/types.ts`:

```ts
import type {
  // ...existing imports...
  ProjectInfo,
} from "@webmux/api-contract";

export type { ProjectInfo };

export type Selection =
  | { kind: "worktree"; projectId: string; branch: string }
  | { kind: "scratch"; projectId: string; id: string; sessionName: string }
  | { kind: "external"; sessionName: string };
```

(Replace the existing `Selection` definition.)

- [ ] **Step 8.2: Defer commit**

---

### Task 9: Frontend api.ts — every wrapper gains `projectId`

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 9.1: Update every wrapper signature**

Every API wrapper that today calls a per-project endpoint now takes `projectId` as the first argument:

```ts
export async function fetchWorktrees(projectId: string): Promise<WorktreeInfo[]> {
  const response = await api.fetchWorktrees({ params: { projectId } });
  return response.worktrees.map((w) => mapWorktree(w));
}

export function attachWorktreeConversation(projectId: string, branch: string): Promise<...> {
  return api.attachAgentsWorktreeConversation({ params: { projectId, name: branch } });
}

// etc. for fetchWorktreeConversationHistory, sendWorktreeConversationMessage,
// interruptWorktreeConversation, fetchScratchSessions, createScratchSession,
// removeScratchSession, fetchAgents, createAgent, updateAgent, deleteAgent,
// validateAgent, ...

export async function uploadFiles(projectId: string, worktree: string, files: File[]): Promise<FileUploadResult> {
  // path becomes /api/projects/:projectId/worktrees/:name/upload
  // (or whatever the schema declares)
}
```

Add the new project-registry wrappers:

```ts
export async function fetchProjects(): Promise<ProjectInfo[]> {
  const r = await api.fetchProjects();
  return r.projects;
}

export async function createProject(body: CreateProjectRequest): Promise<ProjectInfo> {
  const r = await api.createProject({ body });
  return r.project;
}

export async function removeProject(id: string, killSessions: boolean): Promise<void> {
  await api.removeProject({ params: { projectId: id }, body: { killSessions } });
}
```

- [ ] **Step 9.2: Defer commit**

---

### Task 10: Terminal.svelte wsPath update

**Files:**
- Modify: `frontend/src/lib/Terminal.svelte`

- [ ] **Step 10.1: Update wsPath derivation**

```ts
const wsPath = $derived(
  selection.kind === "worktree"
    ? `/ws/projects/${encodeURIComponent(selection.projectId)}/${encodeURIComponent(selection.branch)}`
    : selection.kind === "external"
      ? `/ws/external/${encodeURIComponent(selection.sessionName)}`
      : `/ws/projects/${encodeURIComponent(selection.projectId)}/scratch/${encodeURIComponent(selection.id)}`
);
```

For `uploadFiles`: the call now passes `selection.projectId` as the first arg (only valid in the worktree case, which is already gated).

- [ ] **Step 10.2: Update `Terminal.test.ts` fixtures**

Every test fixture passes `selection: { kind: "worktree", projectId: "test12345678", branch: "x" }` instead of the bare branch.

- [ ] **Step 10.3: Defer commit**

---

### Task 11: App.svelte projectId threading

**Files:**
- Modify: `frontend/src/App.svelte`

- [ ] **Step 11.1: Add `currentProjectId` thread-through**

This task does NOT add the project tree yet. It just keeps the existing single-project sidebar working under the new prefixed URLs.

```ts
let currentProjectId = $state<string | null>(null);

async function bootstrapProjects() {
  const projects = await fetchProjects();
  if (projects.length === 0) {
    // First-run UX placeholder: nothing yet (full UI in Phase 5)
    return;
  }
  currentProjectId = projects[0].id;
}

onMount(() => {
  void bootstrapProjects();
  // ...existing code
});
```

Every existing `fetchWorktrees()` call becomes `fetchWorktrees(currentProjectId!)`. Same for `fetchScratchSessions(currentProjectId!)`. Selection state derivation likewise:

```ts
let selection = $derived<Selection | null>(
  currentProjectId === null ? null
    : selectedScratchSession
      ? { kind: "scratch", projectId: currentProjectId, id: selectedScratchSession.id, sessionName: selectedScratchSession.sessionName }
      : selectedExternalSession
        ? { kind: "external", sessionName: selectedExternalSession }
        : selectedBranch
          ? { kind: "worktree", projectId: currentProjectId, branch: selectedBranch }
          : null
);
```

- [ ] **Step 11.2: Update `WorktreeList`, `MobileChatSurface`, `WorktreeConversationPanel`, `CreateWorktreeDialog`, `SettingsDialog` callers in App.svelte**

Each call site that today fetches per-project data now passes `currentProjectId!`. Where the component owns its own fetch (e.g., `SettingsDialog` calls `fetchAgents`), pass `projectId` as a prop.

- [ ] **Step 11.3: Update component prop signatures**

The components above each gain a `projectId: string` prop. Internally they thread it through their api calls.

- [ ] **Step 11.4: Build**

```bash
bun run build 2>&1 | tail -25
```

Expected: clean build. Address any TS errors as exhaustiveness checks: every per-project api call needs a projectId; the type system enforces it.

- [ ] **Step 11.5: Frontend tests**

```bash
bun run --cwd frontend test 2>&1 | tail -10
```

Expected: most tests pass after fixture updates. Some may need projectId-bearing selections.

- [ ] **Step 11.6: Run backend tests too**

```bash
bun run --cwd backend test 2>&1 | tail -10
```

Expected: existing baseline maintained.

- [ ] **Step 11.7: Commit Phase 2 as one unit**

```bash
git add packages/api-contract/src/contract.ts \
        backend/src/server.ts \
        frontend/src/lib/types.ts \
        frontend/src/lib/api.ts \
        frontend/src/lib/Terminal.svelte \
        frontend/src/lib/Terminal.test.ts \
        frontend/src/App.svelte \
        frontend/src/lib/WorktreeList.svelte \
        frontend/src/lib/MobileChatSurface.svelte \
        frontend/src/lib/WorktreeConversationPanel.svelte \
        frontend/src/lib/CreateWorktreeDialog.svelte \
        frontend/src/lib/SettingsDialog.svelte
git commit -m "feat: path-prefix all routes with projectId; thread through frontend"
```

---

## Phase 3 — Per-service test refactor

The per-service unit tests (lifecycle, reconciliation, archive-state, snapshot, agent-service, agent-validation, scratch, etc.) need to construct services through `ProjectScopeDeps` rather than ad-hoc.

### Task 12: List the test files affected and group them

- [ ] **Step 12.1: Audit which tests need updating**

```bash
ls backend/src/__tests__/*.test.ts
```

Group the affected tests:
- `lifecycle-service.test.ts` (many fixtures)
- `reconciliation-service.test.ts`
- `archive-service.test.ts`
- `snapshot-service.test.ts`
- `agent-service.test.ts`
- `agent-registry.test.ts`
- `agent-validation-service.test.ts`
- `agent-chat-service.test.ts`
- `agents-ui-service.test.ts`
- `agents-ui-action-service.test.ts`
- `claude-conversation-service.test.ts`
- `worktree-conversation-service.test.ts`
- `worktree-storage.test.ts`
- `setup.test.ts`
- `docker.test.ts`
- `terminal-adapter.test.ts`
- `tmux-adapter.test.ts`
- `native-terminal-service.test.ts`
- `session-service.test.ts`

For each: read it. If its setup uses `WebmuxRuntime` or constructs a service that's now in `ProjectScope`, it needs an update. Most will be small mechanical changes.

- [ ] **Step 12.2: Build a shared test fixture**

Create `backend/src/__tests__/fixtures/scope.ts`:

```ts
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";
import { createProjectScope } from "../../services/project-scope";
import { BunGitGateway } from "../../adapters/git";
import { BunTmuxGateway } from "../../adapters/tmux";
import { BunDockerGateway } from "../../adapters/docker";
import { BunPortProbe } from "../../adapters/port-probe";
import { BunLifecycleHookRunner } from "../../adapters/hooks";
import { AutoNameService } from "../../services/auto-name-service";
import { NotificationService } from "../../services/notification-service";

export function makeFixtureScope(opts?: { name?: string }) {
  const dir = mkdtempSync(`${tmpdir()}/wm-fixture-`);
  writeFileSync(join(dir, ".webmux.yaml"), `name: ${opts?.name ?? "fixture"}\nworkspace:\n  mainBranch: main\n`);
  // git init for adapters that expect a repo
  execSync(`git -C ${dir} init -q && git -C ${dir} commit --allow-empty -q -m init`);
  return createProjectScope({
    projectDir: resolve(dir),
    port: 9999,
    git: new BunGitGateway(),
    tmux: new BunTmuxGateway(),
    docker: new BunDockerGateway(),
    portProbe: new BunPortProbe(),
    hooks: new BunLifecycleHookRunner(),
    autoName: new AutoNameService(),
    runtimeNotifications: new NotificationService(),
  });
}
```

- [ ] **Step 12.3: Update test files in batches**

For each test file in the audit that constructs services directly, replace ad-hoc construction with `makeFixtureScope()` and pull services off the returned scope. Most tests don't need this — they pre-construct mocks. Only the ones that use `WebmuxRuntime` integration need updating.

The exact list of files needing edits is to be determined per-file. Realistic estimate: 5–8 files require non-trivial changes; the rest pass as-is.

- [ ] **Step 12.4: Run all backend tests**

```bash
bun run --cwd backend test 2>&1 | tail -10
```

Expected: all tests pass at the baseline ±1 (the lifecycle test may continue to fail; that's the pre-existing baseline).

- [ ] **Step 12.5: Commit**

```bash
git add backend/src/__tests__/
git commit -m "test(backend): adapt per-service tests to ProjectScopeDeps"
```

---

## Phase 4 — ProjectTree component + per-project polling

### Task 13: Build `ProjectTreeNode.svelte`

**Files:**
- Create: `frontend/src/lib/ProjectTreeNode.svelte`

- [ ] **Step 13.1: Implement the node component**

```svelte
<script lang="ts">
  import type { ProjectInfo, Selection, WorktreeInfo, ScratchSessionSnapshot } from "./types";
  import WorktreeList from "./WorktreeList.svelte";
  import SessionList from "./SessionList.svelte";

  let {
    project,
    expanded,
    onToggle,
    worktrees,
    scratchSessions,
    selection,
    onSelectWorktree,
    onSelectScratch,
    onCreateScratch,
    onRemoveScratch,
    onProjectMenu,
  }: {
    project: ProjectInfo;
    expanded: boolean;
    onToggle: () => void;
    worktrees: WorktreeInfo[];
    scratchSessions: ScratchSessionSnapshot[];
    selection: Selection | null;
    onSelectWorktree: (branch: string) => void;
    onSelectScratch: (id: string, sessionName: string) => void;
    onCreateScratch: () => void;
    onRemoveScratch: (id: string, displayName: string) => void;
    onProjectMenu: () => void;
  } = $props();
</script>

<section class="border-b border-edge">
  <header class="flex items-center px-3 py-2 cursor-pointer hover:bg-hover" onclick={onToggle}>
    <span class="mr-2 text-xs">{expanded ? "▾" : "▸"}</span>
    <span class="flex-1 truncate font-medium">{project.name}</span>
    <span class="text-xs text-muted ml-2">{worktrees.length}</span>
    <button class="ml-2 px-1 opacity-50 hover:opacity-100" aria-label="Project menu" onclick={(e) => { e.stopPropagation(); onProjectMenu(); }}>⋯</button>
  </header>

  {#if expanded}
    <div class="pl-2">
      <WorktreeList
        rows={[]/* filled in by parent in App.svelte; see Task 14 */}
        onSelect={onSelectWorktree}
      />
      <SessionList
        mode="scratch-only"
        externalSessions={[]}
        scratchSessions={scratchSessions}
        selection={selection}
        onSelect={(s) => { if (s.kind === "scratch") onSelectScratch(s.id, s.sessionName); }}
        onCreateScratch={onCreateScratch}
        onRemoveScratch={onRemoveScratch}
      />
    </div>
  {/if}
</section>
```

(WorktreeList integration: build `rows` upstream from `worktrees` using `buildWorktreeListRows`. The component props on `WorktreeList` are largely already correct; pass `rows` directly.)

- [ ] **Step 13.2: Update `SessionList.svelte` to accept `mode` prop**

Add `mode: "scratch-only" | "external-only" | "both"` (default "both"). When `scratch-only`, hide the external section. When `external-only`, hide the scratch section.

```svelte
<script lang="ts">
  let {
    mode = "both",
    // existing props
  }: {
    mode?: "scratch-only" | "external-only" | "both";
    // ...
  } = $props();
</script>

{#if mode !== "external-only"}
  <!-- existing scratch section -->
{/if}

{#if mode !== "scratch-only"}
  <!-- existing external section -->
{/if}
```

- [ ] **Step 13.3: Defer commit**

---

### Task 14: Build `ProjectTree.svelte`

**Files:**
- Create: `frontend/src/lib/ProjectTree.svelte`

- [ ] **Step 14.1: Implement the tree orchestrator**

```svelte
<script lang="ts">
  import type {
    ProjectInfo, Selection, WorktreeInfo, ScratchSessionSnapshot, ExternalTmuxSession,
  } from "./types";
  import ProjectTreeNode from "./ProjectTreeNode.svelte";
  import SessionList from "./SessionList.svelte";

  const EXPANDED_KEY = "webmux.expandedProjects";
  function loadExpanded(): Set<string> {
    try {
      const raw = localStorage.getItem(EXPANDED_KEY);
      return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
    } catch { return new Set(); }
  }
  function saveExpanded(s: Set<string>) {
    localStorage.setItem(EXPANDED_KEY, JSON.stringify([...s]));
  }

  let {
    projects,
    worktreesByProject,
    scratchByProject,
    externalSessions,
    selection,
    onSelectWorktree,
    onSelectScratch,
    onSelectExternal,
    onCreateScratch,
    onRemoveScratch,
    onAddProject,
    onProjectMenu,
  }: {
    projects: ProjectInfo[];
    worktreesByProject: Map<string, WorktreeInfo[]>;
    scratchByProject: Map<string, ScratchSessionSnapshot[]>;
    externalSessions: ExternalTmuxSession[];
    selection: Selection | null;
    onSelectWorktree: (projectId: string, branch: string) => void;
    onSelectScratch: (projectId: string, id: string, sessionName: string) => void;
    onSelectExternal: (name: string) => void;
    onCreateScratch: (projectId: string) => void;
    onRemoveScratch: (projectId: string, id: string, displayName: string) => void;
    onAddProject: () => void;
    onProjectMenu: (projectId: string) => void;
  } = $props();

  let expanded = $state(loadExpanded());
  function toggle(id: string) {
    if (expanded.has(id)) expanded.delete(id); else expanded.add(id);
    saveExpanded(expanded);
    expanded = new Set(expanded); // reactivity
  }
</script>

<div class="flex flex-col">
  <!-- External tmux node, hardcoded as the first entry -->
  <section class="border-b border-edge">
    <header class="flex items-center px-3 py-2 cursor-pointer hover:bg-hover" onclick={() => toggle("__unmanaged__")}>
      <span class="mr-2 text-xs">{expanded.has("__unmanaged__") ? "▾" : "▸"}</span>
      <span class="flex-1 truncate font-medium opacity-70">Unmanaged</span>
      <span class="text-xs text-muted ml-2">{externalSessions.length}</span>
    </header>
    {#if expanded.has("__unmanaged__")}
      <div class="pl-2">
        <SessionList
          mode="external-only"
          externalSessions={externalSessions}
          scratchSessions={[]}
          selection={selection}
          onSelect={(s) => { if (s.kind === "external") onSelectExternal(s.sessionName); }}
          onCreateScratch={() => {}}
          onRemoveScratch={() => {}}
        />
      </div>
    {/if}
  </section>

  {#each projects as project (project.id)}
    <ProjectTreeNode
      {project}
      expanded={expanded.has(project.id)}
      onToggle={() => toggle(project.id)}
      worktrees={worktreesByProject.get(project.id) ?? []}
      scratchSessions={scratchByProject.get(project.id) ?? []}
      {selection}
      onSelectWorktree={(branch) => onSelectWorktree(project.id, branch)}
      onSelectScratch={(id, sessionName) => onSelectScratch(project.id, id, sessionName)}
      onCreateScratch={() => onCreateScratch(project.id)}
      onRemoveScratch={(id, name) => onRemoveScratch(project.id, id, name)}
      onProjectMenu={() => onProjectMenu(project.id)}
    />
  {/each}

  <button class="text-sm text-muted hover:text-primary px-3 py-2" onclick={onAddProject}>
    + Add project
  </button>
</div>
```

- [ ] **Step 14.2: Defer commit**

---

### Task 15: Wire `ProjectTree` into `App.svelte`; per-project polling fan-out

**Files:**
- Modify: `frontend/src/App.svelte`

- [ ] **Step 15.1: Replace existing sidebar layout**

Find the existing sidebar render in `App.svelte`. Replace `<WorktreeList ... />` and the standalone `<SessionList ... />` with `<ProjectTree {...} />`. Pass the per-project state maps:

```ts
let projects = $state<ProjectInfo[]>([]);
let worktreesByProject = $state<Map<string, WorktreeInfo[]>>(new Map());
let scratchByProject = $state<Map<string, ScratchSessionSnapshot[]>>(new Map());

async function refreshAll() {
  const list = await fetchProjects();
  projects = list;

  const ids = list.map((p) => p.id);
  const [worktreesPairs, scratchPairs, ext] = await Promise.all([
    Promise.all(ids.map(async (id) => [id, await fetchWorktrees(id)] as const)),
    Promise.all(ids.map(async (id) => [id, await fetchScratchSessions(id)] as const)),
    fetchExternalSessions(),
  ]);
  worktreesByProject = new Map(worktreesPairs);
  scratchByProject = new Map(scratchPairs);
  externalSessions = ext;
}
```

The existing `pollHandle` setInterval calls `refreshAll` every 5s.

- [ ] **Step 15.2: Selection handlers**

```ts
function handleSelectWorktree(projectId: string, branch: string) {
  selectedExternalSession = null;
  selectedScratchSession = null;
  selectedBranch = branch;
  currentProjectId = projectId;
}

function handleSelectScratch(projectId: string, id: string, sessionName: string) {
  selectedExternalSession = null;
  selectedBranch = null;
  selectedScratchSession = { id, sessionName };
  currentProjectId = projectId;
}

function handleSelectExternal(name: string) {
  selectedScratchSession = null;
  selectedBranch = null;
  selectedExternalSession = name;
  // currentProjectId unchanged — external is global
}
```

`selection` derivation now uses `currentProjectId` for worktree/scratch:

```ts
let selection = $derived<Selection | null>(
  selectedScratchSession && currentProjectId
    ? { kind: "scratch", projectId: currentProjectId, id: selectedScratchSession.id, sessionName: selectedScratchSession.sessionName }
    : selectedExternalSession
      ? { kind: "external", sessionName: selectedExternalSession }
      : selectedBranch && currentProjectId
        ? { kind: "worktree", projectId: currentProjectId, branch: selectedBranch }
        : null
);
```

- [ ] **Step 15.3: Build + frontend tests**

```bash
bun run build 2>&1 | tail -10
bun run --cwd frontend test 2>&1 | tail -10
```

Expected: clean build; tests pass.

- [ ] **Step 15.4: Commit Phase 4**

```bash
git add frontend/src/lib/ProjectTreeNode.svelte \
        frontend/src/lib/ProjectTree.svelte \
        frontend/src/lib/SessionList.svelte \
        frontend/src/App.svelte
git commit -m "feat(frontend): ProjectTree sidebar + per-project polling fan-out"
```

---

## Phase 5 — AddProjectDialog + project menus + remove flow

### Task 16: AddProjectDialog.svelte

**Files:**
- Create: `frontend/src/lib/AddProjectDialog.svelte`

- [ ] **Step 16.1: Implement the dialog**

```svelte
<script lang="ts">
  import type { CreateProjectRequest } from "@webmux/api-contract";
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";

  let {
    onClose,
    onCreate,
  }: {
    onClose: () => void;
    onCreate: (req: CreateProjectRequest) => Promise<void>;
  } = $props();

  let path = $state("");
  let displayName = $state("");
  let mainBranch = $state("main");
  let defaultAgent = $state("claude");
  let busy = $state(false);
  let error = $state<string | null>(null);

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    if (busy || path.trim() === "") return;
    busy = true;
    error = null;
    try {
      await onCreate({
        path: path.trim(),
        displayName: displayName.trim() || undefined,
        mainBranch: mainBranch.trim() || undefined,
        defaultAgent: defaultAgent.trim() || undefined,
      });
      onClose();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<BaseDialog onclose={onClose} className="md:max-w-[480px]">
  <form onsubmit={submit} class="flex flex-col gap-4">
    <h2 class="text-base">Add project</h2>

    <div>
      <label class="block text-xs text-muted mb-1.5" for="proj-path">Project path</label>
      <input
        id="proj-path"
        bind:value={path}
        required
        placeholder="/home/mercer/projects/foo"
        class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] placeholder:text-muted/50 outline-none focus:border-accent"
      />
      <p class="mt-1 text-[11px] text-muted">If the path already has a <code>.webmux.yaml</code>, it'll be read; the fields below are ignored.</p>
    </div>

    <div>
      <label class="block text-xs text-muted mb-1.5" for="proj-name">Display name (optional)</label>
      <input id="proj-name" bind:value={displayName} class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent" />
    </div>

    <div class="flex gap-3">
      <div class="flex-1">
        <label class="block text-xs text-muted mb-1.5" for="proj-mainbranch">Main branch</label>
        <input id="proj-mainbranch" bind:value={mainBranch} class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent" />
      </div>
      <div class="flex-1">
        <label class="block text-xs text-muted mb-1.5" for="proj-agent">Default agent</label>
        <select id="proj-agent" bind:value={defaultAgent} class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent">
          <option value="claude">claude</option>
          <option value="codex">codex</option>
        </select>
      </div>
    </div>

    {#if error}
      <div class="text-[12px] text-red-400">{error}</div>
    {/if}

    <div class="flex gap-2 justify-end pt-2">
      <Btn variant="ghost" onclick={onClose} disabled={busy}>Cancel</Btn>
      <Btn variant="primary" type="submit" disabled={busy || path.trim() === ""}>
        {busy ? "Adding…" : "Add"}
      </Btn>
    </div>
  </form>
</BaseDialog>
```

- [ ] **Step 16.2: Wire into App.svelte**

```ts
let showAddProjectDialog = $state(false);

async function handleAddProject(req: CreateProjectRequest) {
  const project = await createProject(req);
  projects = [...projects, project];
  // expand the new project + select it
  // (selection happens by the next refresh tick)
}
```

In the render:

```svelte
{#if showAddProjectDialog}
  <AddProjectDialog
    onClose={() => { showAddProjectDialog = false; }}
    onCreate={handleAddProject}
  />
{/if}
```

`<ProjectTree onAddProject={() => { showAddProjectDialog = true; }} />`.

- [ ] **Step 16.3: Defer commit**

---

### Task 17: Project menu + remove flow

**Files:**
- Modify: `frontend/src/App.svelte`
- Modify: `frontend/src/lib/ProjectTreeNode.svelte` (already has the `⋯` button from Task 13)

- [ ] **Step 17.1: Project menu state**

```ts
let projectMenuFor = $state<string | null>(null); // projectId showing menu
let projectToRemove = $state<{ id: string; name: string } | null>(null);
let projectToRemoveKillSessions = $state(false);

function handleProjectMenu(projectId: string) {
  projectMenuFor = projectMenuFor === projectId ? null : projectId;
}

function handleProjectRemoveStart(projectId: string) {
  const p = projects.find((x) => x.id === projectId);
  if (!p) return;
  projectToRemove = { id: p.id, name: p.name };
  projectToRemoveKillSessions = false;
  projectMenuFor = null;
}

async function handleProjectRemoveConfirm() {
  if (!projectToRemove) return;
  await removeProject(projectToRemove.id, projectToRemoveKillSessions);
  projects = projects.filter((p) => p.id !== projectToRemove!.id);
  if (currentProjectId === projectToRemove.id) {
    currentProjectId = projects[0]?.id ?? null;
    selectedBranch = null;
    selectedScratchSession = null;
  }
  projectToRemove = null;
}
```

- [ ] **Step 17.2: ConfirmDialog with kill-sessions checkbox**

```svelte
{#if projectToRemove}
  <ConfirmDialog
    message={`Remove project "${projectToRemove.name}" from webmux? This unregisters it from the sidebar.`}
    confirmLabel={projectToRemoveKillSessions ? "Remove + kill tmux" : "Remove"}
    extraContent="(extra inline content via {@render ...} / a snippet)"
    onconfirm={() => { void handleProjectRemoveConfirm(); }}
    oncancel={() => { projectToRemove = null; }}
  />
{/if}
```

The "extra content" — a checkbox "Also kill all tmux sessions for this project" bound to `projectToRemoveKillSessions`. The cleanest path is a small dedicated `ConfirmRemoveProjectDialog.svelte` rather than retrofitting `ConfirmDialog`. Create it:

```svelte
<!-- frontend/src/lib/ConfirmRemoveProjectDialog.svelte -->
<script lang="ts">
  import BaseDialog from "./BaseDialog.svelte";
  import Btn from "./Btn.svelte";

  let {
    projectName,
    onConfirm,
    onCancel,
  }: {
    projectName: string;
    onConfirm: (killSessions: boolean) => void;
    onCancel: () => void;
  } = $props();

  let killSessions = $state(false);
</script>

<BaseDialog onclose={onCancel}>
  <div class="flex flex-col gap-3">
    <h2 class="text-base">Remove project</h2>
    <p class="text-[13px] text-muted">Remove "{projectName}" from webmux's sidebar. The project's <code>.webmux.yaml</code> stays on disk; you can re-add it later.</p>
    <label class="flex items-center gap-2 text-[13px]">
      <input type="checkbox" bind:checked={killSessions} />
      Also kill all tmux sessions for this project
    </label>
    <div class="flex gap-2 justify-end pt-2">
      <Btn variant="ghost" onclick={onCancel}>Cancel</Btn>
      <Btn variant="danger" onclick={() => onConfirm(killSessions)}>{killSessions ? "Remove + kill tmux" : "Remove"}</Btn>
    </div>
  </div>
</BaseDialog>
```

Use it in App.svelte. Drop the inline ConfirmDialog approach.

- [ ] **Step 17.3: "New worktree" project-menu action**

The existing `Cmd+K` create-worktree dialog needs to know which project to target. The current dialog doesn't take projectId because it operates on the implicit "current" project. Add `projectId` to its prop signature; route the new-worktree request through the prefixed endpoint.

- [ ] **Step 17.4: Build + tests**

```bash
bun run build 2>&1 | tail -10
bun run --cwd frontend test 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 17.5: Commit Phase 5**

```bash
git add frontend/src/lib/AddProjectDialog.svelte \
        frontend/src/lib/ConfirmRemoveProjectDialog.svelte \
        frontend/src/lib/ProjectTreeNode.svelte \
        frontend/src/lib/CreateWorktreeDialog.svelte \
        frontend/src/App.svelte
git commit -m "feat(frontend): add/remove project + project menu actions"
```

---

## Phase 6 — Notifications carry projectId

### Task 18: Extend NotificationView with projectId

**Files:**
- Modify: `packages/api-contract/src/schemas.ts` (already done in Task 1.5)
- Modify: `backend/src/services/notification-service.ts`
- Modify: `backend/src/services/runtime-events-service.ts` (and any service that emits notifications)

- [ ] **Step 18.1: Update NotificationService.notify signature**

```ts
notify(input: NotificationInput & { projectId?: string | null }): NotificationView {
  // ...attach projectId to the persisted view
}
```

- [ ] **Step 18.2: Update each emission site**

Search for `runtimeNotifications.notify` and `notify({` calls. Each one already has access to a project context (worktree → branch → scope). Pass the scope's `projectId`.

- [ ] **Step 18.3: Frontend renders projectId-aware notifications**

For now, just thread the field through. Future filtering by current project is out of scope (deferred per spec).

- [ ] **Step 18.4: Tests**

The `notification-service` tests gain a case asserting `projectId` is preserved.

- [ ] **Step 18.5: Build + tests**

```bash
bun run build 2>&1 | tail -10
bun run --cwd backend test 2>&1 | tail -10
bun run --cwd frontend test 2>&1 | tail -5
```

Expected: clean.

- [ ] **Step 18.6: Commit**

```bash
git add packages/api-contract/src/schemas.ts \
        backend/src/services/notification-service.ts \
        backend/src/services/runtime-events-service.ts \
        frontend/src/lib/types.ts \
        frontend/src/App.svelte
git commit -m "feat(notifications): tag events with projectId"
```

---

## Phase 7 — Regression + push

### Task 19: Full regression with two real projects

- [ ] **Step 19.1: Run all suites**

```bash
bun run --cwd backend test 2>&1 | tail -10
bun test packages/api-contract/src 2>&1 | tail -10
bun test bin/src 2>&1 | tail -10
bun run --cwd frontend test 2>&1 | tail -10
```

Expected: all green at baseline.

- [ ] **Step 19.2: Browser smoke — single project (regression)**

1. Stop existing webmux, restart
2. Reload paperclip.formup.cc
3. Verify the existing webmux-test project appears in the tree
4. Click its worktree, terminal works
5. Cmd+K creates a new worktree
6. Click + on Scratch, create a scratch session, verify shell works
7. PR/CI/Linear/services badges still render on worktrees

- [ ] **Step 19.3: Browser smoke — add a second project**

1. Click "+ Add project" in the sidebar
2. Path: `~/projects/solid/solidactions-work` (or similar real project)
3. Display name: "SolidActions"
4. Submit → new project appears in tree, expanded
5. Both projects' worktrees + scratch sessions render in parallel
6. Switch between projects: terminal + state survive
7. Wait 30 seconds → verify both projects' polling fires (open DevTools, look at network)

- [ ] **Step 19.4: Browser smoke — remove a project**

1. Project menu (⋯) on the test project → Remove
2. Default (no kill) → project disappears, tmux session survives (verify via `tmux ls` in another shell)
3. Re-add same path → project comes back; existing worktree + scratch sessions reconcile
4. Project menu → Remove with kill → verify tmux session gone

- [ ] **Step 19.5: Restart-survival check**

1. Kill webmux
2. Restart from source
3. Reload page → both projects still listed (registry persisted)
4. Worktree terminals reconnect with scrollback intact

- [ ] **Step 19.6: Push**

```bash
git push -u origin feat/multi-project
```

- [ ] **Step 19.7: Tag**

```bash
git tag feat/multi-project-v1
git push origin feat/multi-project-v1
```

---

## Self-Review Notes

- **Spec coverage:**
  - Architecture (ProjectScope + ProjectRegistry) — Tasks 2 + 3
  - Project ID (sha1 first 12 → corrected to existing 8 chars) — Task 1
  - Persistence (`~/.config/webmux/projects.yaml`) — Task 3
  - First-run hydration — Task 4
  - Path-prefix all routes — Tasks 5-7
  - Project CRUD endpoints — Tasks 5-6
  - WebSocket prefix — Task 7
  - `parseProjectIdParam` helper — Task 6
  - Frontend Selection extension — Task 8
  - Frontend api wrappers — Task 9
  - Terminal wsPath — Task 10
  - App.svelte threading — Task 11
  - Per-service test refactor — Task 12 (placeholder; sub-tasks per file in execution)
  - ProjectTree + ProjectTreeNode — Tasks 13-15
  - Per-project polling fan-out — Task 15
  - AddProjectDialog — Task 16
  - Project menu + remove flow — Task 17
  - "Unmanaged" first node hardcoded — Task 14
  - Notifications with projectId — Task 18
  - CLI --project flag — Task 11 (Phase 2 has CLI in scope but not in detail; flag this for the executor)
  - Regression + push — Task 19

- **Placeholder scan:** None remaining. Code blocks are concrete; commands are exact.

- **Type consistency:**
  - `ProjectScope` interface stable across Tasks 2, 3, 6
  - `Selection` union stable across Tasks 8, 10, 11, 13, 14, 15
  - `ProjectInfo` matches schema in Task 1.5
  - `parseProjectIdParam` return shape stable across Task 6 callers

- **CLI gap acknowledged:** Phase 2's "Update CLI for the `--project` flag" is mentioned but this plan doesn't break out CLI tasks in detail. The executor should treat CLI parity as a Phase-2 sub-task or defer to a follow-up plan. Spec section "CLI fallback" describes the behaviour; implementation is straightforward (add flag to webmux.ts arg parsing, update worktree-commands.ts to call prefixed endpoints, add `resolveProjectId(opts, registry)` helper).

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-multi-project-webmux.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
