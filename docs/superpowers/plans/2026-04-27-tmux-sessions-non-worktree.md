# webmux Non-Worktree Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add two webmux features: (1) attach to existing tmux sessions started outside webmux, (2) create new "scratch" tmux sessions in the dashboard that aren't backed by a git worktree. Both appear as a separate sidebar section, attach into the existing browser terminal, and survive webmux restarts.

**Architecture:**
- Backend extends `BunTmuxGateway` with a `listAllSessions()` enumeration. A new pure service (`external-tmux-service`) classifies sessions as "external" (anything not webmux-managed) and a new stateful service (`scratch-session-service`) tracks `wm-scratch-*` named sessions. Both expose new ts-rest contract endpoints. The existing terminal WebSocket attach machinery is reused — a new WS data variant lets us bypass the worktree lookup and pass session names directly to `attach()`.
- Frontend adds a `SessionList` sidebar section under the existing `WorktreeList`, with a small `CreateScratchDialog`. The `Terminal` component gets a `kind: "worktree" | "external" | "scratch"` prop that picks the right WS path.
- CLI parity is added via a new `bin/src/session-commands.ts` exposing `webmux sessions` (list external+scratch), `webmux scratch <name>` (create scratch), `webmux attach <name>` (attach to any session by name).
- Scratch sessions persist by naming convention (`wm-scratch-<id>`) — on webmux startup, a scan rebuilds the in-memory map. No new on-disk schema.

**Tech Stack:**
- Backend: Bun, TypeScript strict, `@ts-rest/core`, Zod (via `packages/api-contract`)
- Frontend: Svelte 5 (runes), TypeScript strict, Tailwind, xterm.js, contract-typed client
- CLI: Bun, `@clack/prompts`
- Tests: `bun test` (backend, CLI, contract package)
- Tmux: `tmux` 3.x via shell

---

## Pre-Flight

- [ ] **Step 0: Branch + verify clean tree**

```bash
cd ~/projects/webmux
git status                                # confirm clean
git checkout -b feat/non-worktree-sessions
git rev-parse --abbrev-ref HEAD            # confirm new branch
```

Expected: working tree clean; on branch `feat/non-worktree-sessions`.

- [ ] **Step 0.5: Verify baseline tests pass**

```bash
bun install                                # in case deps drifted
bun run --cwd backend test 2>&1 | tail -10
bun test packages/api-contract/src 2>&1 | tail -10
bun test bin/src 2>&1 | tail -10
```

Expected: all suites pass. Investigate first if anything fails before adding features.

---

## File Structure

**New files (backend):**
- `backend/src/services/external-tmux-service.ts` — pure logic to classify external vs webmux-managed sessions
- `backend/src/services/scratch-session-service.ts` — stateful service: in-memory `Map<string, ScratchSessionMeta>`, create/list/remove/scan
- `backend/src/__tests__/external-tmux-service.test.ts`
- `backend/src/__tests__/scratch-session-service.test.ts`

**Modified files (backend):**
- `backend/src/adapters/tmux.ts` — add `listAllSessions()` method on `TmuxGateway` interface and `BunTmuxGateway` impl; add `getFirstWindowName(sessionName)`; export `SCRATCH_SESSION_PREFIX`
- `backend/src/domain/model.ts` — add `ExternalTmuxSession`, `ScratchSessionMeta`, `ScratchSessionSnapshot` types
- `backend/src/server.ts` — wire two new HTTP route groups + two new WS routes; extend WS data union; extend WS message handler
- `backend/src/runtime.ts` — instantiate `scratchSessionService` on startup, run scan
- `backend/src/__tests__/tmux-adapter.test.ts` — add tests for `listAllSessions` parser

**New files (api-contract):**
- (none — extend existing files)

**Modified files (api-contract):**
- `packages/api-contract/src/schemas.ts` — add Zod schemas: `ExternalTmuxSessionSchema`, `ExternalTmuxSessionListResponseSchema`, `ScratchSessionSnapshotSchema`, `ScratchSessionListResponseSchema`, `CreateScratchSessionRequestSchema`, `CreateScratchSessionResponseSchema`, `ScratchSessionNameParamsSchema`
- `packages/api-contract/src/contract.ts` — add `apiPaths` entries and contract entries for the four new endpoints

**New files (frontend):**
- `frontend/src/lib/SessionList.svelte` — sidebar component rendering external+scratch sessions
- `frontend/src/lib/CreateScratchDialog.svelte` — modal for naming a new scratch session and picking shell vs agent
- `frontend/src/lib/session-utils.ts` — pure helpers (sort, filter); unit-testable

**Modified files (frontend):**
- `frontend/src/lib/types.ts` — add `ExternalSession`, `ScratchSession`, `Selection` discriminated union
- `frontend/src/lib/api.ts` — add `fetchExternalSessions`, `fetchScratchSessions`, `createScratchSession`, `removeScratchSession`
- `frontend/src/lib/Terminal.svelte` — add `kind` prop with discriminated WS path
- `frontend/src/App.svelte` — render `SessionList`, manage `Selection` state, route `Terminal` invocation by kind

**New files (CLI):**
- `bin/src/session-commands.ts` — handlers for `sessions`, `scratch`, `attach`
- `bin/src/session-commands.test.ts`

**Modified files (CLI):**
- `bin/src/webmux.ts` — register the new subcommands and usage text

**Files NOT touched (verify in execution):**
- `services/reconciliation-service.ts`, `auto-pull-service.ts`, `pr-service.ts`, `linear-service.ts`, `lifecycle-service.ts`, `auto-name-service.ts`, `archive-service.ts` — these are worktree-scoped and must stay that way.

---

## Phase 1: Tmux Adapter — `listAllSessions`

### Task 1: Add `listAllSessions()` to `TmuxGateway`

**Files:**
- Modify: `backend/src/adapters/tmux.ts`
- Test: `backend/src/__tests__/tmux-adapter.test.ts`

- [ ] **Step 1.1: Write the failing parser test**

Append to `backend/src/__tests__/tmux-adapter.test.ts`:

```ts
import { parseSessionSummaries } from "../adapters/tmux";

test("parseSessionSummaries: parses three sessions including attached and grouped", () => {
  const raw = [
    "mcpsaa\t1\t1\t",
    "wm-webmux-test-f01fb94b\t2\t0\twm-webmux-test-f01fb94b",
    "wm-dash-3100-7\t2\t1\twm-webmux-test-f01fb94b",
  ].join("\n");

  const out = parseSessionSummaries(raw);
  expect(out).toEqual([
    { name: "mcpsaa", windowCount: 1, attached: true, group: null },
    { name: "wm-webmux-test-f01fb94b", windowCount: 2, attached: false, group: "wm-webmux-test-f01fb94b" },
    { name: "wm-dash-3100-7", windowCount: 2, attached: true, group: "wm-webmux-test-f01fb94b" },
  ]);
});

test("parseSessionSummaries: skips blank lines and malformed rows", () => {
  const raw = "\nfoo\t1\t0\t\n\n";
  const out = parseSessionSummaries(raw);
  expect(out).toEqual([{ name: "foo", windowCount: 1, attached: false, group: null }]);
});
```

- [ ] **Step 1.2: Run test to verify it fails**

```bash
bun run --cwd backend test tmux-adapter 2>&1 | tail -20
```

Expected: FAIL — `parseSessionSummaries is not exported`.

- [ ] **Step 1.3: Add `TmuxSessionSummary` type and parser**

In `backend/src/adapters/tmux.ts`, after `TmuxWindowSummary` (line 9):

```ts
export interface TmuxSessionSummary {
  name: string;
  windowCount: number;
  attached: boolean;
  group: string | null;
}
```

Add to `TmuxGateway` interface (after `listWindows()`):

```ts
  listAllSessions(): TmuxSessionSummary[];
  getFirstWindowName(sessionName: string): string | null;
```

Add the parser function before `BunTmuxGateway`:

```ts
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
```

- [ ] **Step 1.4: Run test to verify it passes**

```bash
bun run --cwd backend test tmux-adapter 2>&1 | tail -20
```

Expected: PASS.

- [ ] **Step 1.5: Add the gateway methods**

In `backend/src/adapters/tmux.ts`, append to the `BunTmuxGateway` class (before the closing brace):

```ts
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
```

Also export the scratch prefix constant (to be reused by the service and frontend filter):

```ts
export const SCRATCH_SESSION_PREFIX = "wm-scratch-";
```

- [ ] **Step 1.6: Confirm full backend type-check still passes**

```bash
bun run --cwd backend test 2>&1 | tail -10
```

Expected: all tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add backend/src/adapters/tmux.ts backend/src/__tests__/tmux-adapter.test.ts
git commit -m "feat(tmux): add listAllSessions and parseSessionSummaries"
```

---

## Phase 2: Domain Model + External Tmux Service

### Task 2: Add `external-tmux-service` (pure classification)

**Files:**
- Create: `backend/src/services/external-tmux-service.ts`
- Create: `backend/src/__tests__/external-tmux-service.test.ts`
- Modify: `backend/src/domain/model.ts`

- [ ] **Step 2.1: Add `ExternalTmuxSession` type**

In `backend/src/domain/model.ts`, append at the end:

```ts
export interface ExternalTmuxSession {
  name: string;
  windowCount: number;
  attached: boolean;
}
```

- [ ] **Step 2.2: Write the failing classifier test**

Create `backend/src/__tests__/external-tmux-service.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { listExternalSessions } from "../services/external-tmux-service";
import type { TmuxSessionSummary } from "../adapters/tmux";

const sessions: TmuxSessionSummary[] = [
  { name: "mcpsaa",                    windowCount: 1, attached: true,  group: null },
  { name: "codex-review",              windowCount: 1, attached: false, group: null },
  { name: "wm-webmux-test-f01fb94b",   windowCount: 2, attached: false, group: "wm-webmux-test-f01fb94b" },
  { name: "wm-dash-3100-7",            windowCount: 2, attached: true,  group: "wm-webmux-test-f01fb94b" },
  { name: "wm-scratch-abc",            windowCount: 1, attached: false, group: null },
  { name: "wm-native-3100-1",          windowCount: 1, attached: false, group: null },
];

describe("listExternalSessions", () => {
  test("excludes wm-* prefixed sessions", () => {
    const result = listExternalSessions(sessions);
    expect(result.map((s) => s.name)).toEqual(["mcpsaa", "codex-review"]);
  });

  test("returns shape with name/windowCount/attached only", () => {
    const result = listExternalSessions(sessions);
    expect(result[0]).toEqual({ name: "mcpsaa", windowCount: 1, attached: true });
  });

  test("empty input returns empty array", () => {
    expect(listExternalSessions([])).toEqual([]);
  });
});
```

- [ ] **Step 2.3: Run test to verify it fails**

```bash
bun run --cwd backend test external-tmux-service 2>&1 | tail -20
```

Expected: FAIL — module not found.

- [ ] **Step 2.4: Implement the service**

Create `backend/src/services/external-tmux-service.ts`:

```ts
import type { TmuxSessionSummary } from "../adapters/tmux";
import type { ExternalTmuxSession } from "../domain/model";

const WEBMUX_SESSION_PREFIX = "wm-";

export function listExternalSessions(all: TmuxSessionSummary[]): ExternalTmuxSession[] {
  return all
    .filter((s) => !s.name.startsWith(WEBMUX_SESSION_PREFIX))
    .map((s) => ({ name: s.name, windowCount: s.windowCount, attached: s.attached }));
}
```

- [ ] **Step 2.5: Run test to verify it passes**

```bash
bun run --cwd backend test external-tmux-service 2>&1 | tail -10
```

Expected: PASS, all 3 cases.

- [ ] **Step 2.6: Commit**

```bash
git add backend/src/services/external-tmux-service.ts \
        backend/src/__tests__/external-tmux-service.test.ts \
        backend/src/domain/model.ts
git commit -m "feat(backend): add external-tmux-service classifier"
```

---

## Phase 3: Scratch Session Service

### Task 3: Add `scratch-session-service`

**Files:**
- Create: `backend/src/services/scratch-session-service.ts`
- Create: `backend/src/__tests__/scratch-session-service.test.ts`
- Modify: `backend/src/domain/model.ts`

- [ ] **Step 3.1: Add types**

In `backend/src/domain/model.ts`, after `ExternalTmuxSession`:

```ts
export type ScratchSessionKind = "shell" | "agent";

export interface ScratchSessionMeta {
  id: string;
  displayName: string;
  sessionName: string;        // tmux session name, e.g., "wm-scratch-abc123"
  kind: ScratchSessionKind;
  agentId: string | null;     // present when kind === "agent"
  cwd: string;
  createdAt: string;
}

export interface ScratchSessionSnapshot {
  id: string;
  displayName: string;
  sessionName: string;
  kind: ScratchSessionKind;
  agentId: string | null;
  cwd: string;
  createdAt: string;
  windowCount: number;
  attached: boolean;
}
```

- [ ] **Step 3.2: Write the failing test**

Create `backend/src/__tests__/scratch-session-service.test.ts`:

```ts
import { describe, expect, test, beforeEach, mock } from "bun:test";
import type { TmuxGateway, TmuxSessionSummary } from "../adapters/tmux";
import { createScratchSessionService } from "../services/scratch-session-service";

function makeFakeGateway(initial: TmuxSessionSummary[] = []): {
  gw: TmuxGateway;
  state: { sessions: TmuxSessionSummary[]; commands: string[] };
} {
  const state = { sessions: [...initial], commands: [] as string[] };
  const gw: TmuxGateway = {
    ensureServer: () => {},
    ensureSession: (name, cwd) => {
      state.commands.push(`ensureSession ${name} ${cwd}`);
      if (!state.sessions.find((s) => s.name === name)) {
        state.sessions.push({ name, windowCount: 1, attached: false, group: null });
      }
    },
    hasWindow: () => false,
    killWindow: () => {},
    createWindow: () => {},
    splitWindow: () => {},
    setWindowOption: () => {},
    runCommand: (target, cmd) => { state.commands.push(`runCommand ${target} ${cmd}`); },
    selectPane: () => {},
    listWindows: () => [],
    listAllSessions: () => state.sessions,
    getFirstWindowName: () => "0",
  };
  return { gw, state };
}

describe("scratch-session-service", () => {
  test("create persists meta and ensures tmux session", async () => {
    const { gw, state } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
    });

    const meta = await svc.create({ displayName: "scratch one", kind: "shell", agentId: null });

    expect(meta).toEqual({
      id: "abc",
      displayName: "scratch one",
      sessionName: "wm-scratch-abc",
      kind: "shell",
      agentId: null,
      cwd: "/tmp",
      createdAt: "2026-04-27T15:00:00Z",
    });
    expect(state.commands).toContain("ensureSession wm-scratch-abc /tmp");
  });

  test("list returns snapshots merging meta with live tmux state", async () => {
    const { gw } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
    });
    await svc.create({ displayName: "a", kind: "shell", agentId: null });

    const snaps = svc.list();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({
      id: "abc",
      sessionName: "wm-scratch-abc",
      windowCount: 1,
      attached: false,
    });
  });

  test("scan rebuilds in-memory map from existing wm-scratch-* tmux sessions", async () => {
    const existing: TmuxSessionSummary[] = [
      { name: "wm-scratch-existing1", windowCount: 1, attached: false, group: null },
      { name: "mcpsaa",                windowCount: 1, attached: true,  group: null },
      { name: "wm-foo",                windowCount: 1, attached: false, group: null },
    ];
    const { gw } = makeFakeGateway(existing);
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "new",
      now: () => "2026-04-27T15:00:00Z",
    });

    svc.scan();

    const snaps = svc.list();
    expect(snaps).toHaveLength(1);
    expect(snaps[0]).toMatchObject({ id: "existing1", sessionName: "wm-scratch-existing1" });
  });

  test("remove kills tmux session and drops meta", async () => {
    const { gw, state } = makeFakeGateway();
    let killed: string | null = null;
    gw.killWindow = () => {};
    (gw as TmuxGateway & { killSession: (n: string) => void }).killSession = (n: string) => { killed = n; };
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
    });
    await svc.create({ displayName: "a", kind: "shell", agentId: null });

    svc.remove("abc");
    expect(svc.list()).toHaveLength(0);
    expect(killed).toBe("wm-scratch-abc");
  });

  test("getByName resolves a tmux session name to its meta", async () => {
    const { gw } = makeFakeGateway();
    const svc = createScratchSessionService({
      tmux: gw,
      cwd: "/tmp",
      idGenerator: () => "abc",
      now: () => "2026-04-27T15:00:00Z",
    });
    await svc.create({ displayName: "a", kind: "shell", agentId: null });
    expect(svc.getBySessionName("wm-scratch-abc")?.id).toBe("abc");
    expect(svc.getBySessionName("does-not-exist")).toBeNull();
  });
});
```

- [ ] **Step 3.3: Run test to verify it fails**

```bash
bun run --cwd backend test scratch-session-service 2>&1 | tail -20
```

Expected: FAIL (module not found).

- [ ] **Step 3.4: Add `killSession` to gateway interface**

In `backend/src/adapters/tmux.ts`, add to `TmuxGateway` interface:

```ts
  killSession(sessionName: string): void;
```

Add to `BunTmuxGateway` class:

```ts
  killSession(sessionName: string): void {
    const result = runTmux(["kill-session", "-t", sessionName]);
    if (result.exitCode !== 0 && !result.stderr.includes("can't find session") && !result.stderr.includes("no server running")) {
      throw new Error(`kill tmux session ${sessionName} failed: ${result.stderr}`);
    }
  }
```

- [ ] **Step 3.5: Implement `scratch-session-service`**

Create `backend/src/services/scratch-session-service.ts`:

```ts
import { randomUUID } from "node:crypto";
import { SCRATCH_SESSION_PREFIX, type TmuxGateway } from "../adapters/tmux";
import type { ScratchSessionKind, ScratchSessionMeta, ScratchSessionSnapshot } from "../domain/model";

export interface CreateScratchSessionInput {
  displayName: string;
  kind: ScratchSessionKind;
  agentId: string | null;
}

export interface ScratchSessionService {
  create(input: CreateScratchSessionInput): Promise<ScratchSessionMeta>;
  list(): ScratchSessionSnapshot[];
  remove(id: string): void;
  scan(): void;
  getBySessionName(sessionName: string): ScratchSessionMeta | null;
}

interface Deps {
  tmux: TmuxGateway;
  cwd: string;
  idGenerator?: () => string;
  now?: () => string;
}

export function createScratchSessionService(deps: Deps): ScratchSessionService {
  const idGen = deps.idGenerator ?? randomUUID;
  const now = deps.now ?? (() => new Date().toISOString());
  const metas = new Map<string, ScratchSessionMeta>();

  function buildSnapshot(meta: ScratchSessionMeta): ScratchSessionSnapshot {
    const summary = deps.tmux.listAllSessions().find((s) => s.name === meta.sessionName);
    return {
      ...meta,
      windowCount: summary?.windowCount ?? 0,
      attached: summary?.attached ?? false,
    };
  }

  return {
    async create(input) {
      const id = idGen();
      const sessionName = `${SCRATCH_SESSION_PREFIX}${id}`;
      const meta: ScratchSessionMeta = {
        id,
        displayName: input.displayName,
        sessionName,
        kind: input.kind,
        agentId: input.agentId,
        cwd: deps.cwd,
        createdAt: now(),
      };
      deps.tmux.ensureSession(sessionName, deps.cwd);
      metas.set(id, meta);
      return meta;
    },
    list() {
      return [...metas.values()].map(buildSnapshot);
    },
    remove(id) {
      const meta = metas.get(id);
      if (!meta) return;
      deps.tmux.killSession(meta.sessionName);
      metas.delete(id);
    },
    scan() {
      const live = deps.tmux.listAllSessions();
      for (const s of live) {
        if (!s.name.startsWith(SCRATCH_SESSION_PREFIX)) continue;
        const id = s.name.slice(SCRATCH_SESSION_PREFIX.length);
        if (metas.has(id)) continue;
        metas.set(id, {
          id,
          displayName: id,
          sessionName: s.name,
          kind: "shell",
          agentId: null,
          cwd: deps.cwd,
          createdAt: now(),
        });
      }
    },
    getBySessionName(sessionName) {
      for (const meta of metas.values()) {
        if (meta.sessionName === sessionName) return meta;
      }
      return null;
    },
  };
}
```

- [ ] **Step 3.6: Run tests to verify they pass**

```bash
bun run --cwd backend test scratch-session-service 2>&1 | tail -20
```

Expected: 5 PASS.

- [ ] **Step 3.7: Commit**

```bash
git add backend/src/services/scratch-session-service.ts \
        backend/src/__tests__/scratch-session-service.test.ts \
        backend/src/adapters/tmux.ts \
        backend/src/domain/model.ts
git commit -m "feat(backend): add scratch-session-service with persistence-by-naming"
```

---

## Phase 4: API Contract

### Task 4: Add Zod schemas + ts-rest contract

**Files:**
- Modify: `packages/api-contract/src/schemas.ts`
- Modify: `packages/api-contract/src/contract.ts`
- Test: `packages/api-contract/src/client.test.ts` (verify types compile)

- [ ] **Step 4.1: Add new schemas**

In `packages/api-contract/src/schemas.ts`, append (after existing schemas, before the type-export block at the bottom):

```ts
// ---------------------------------------------------------------------------
// Non-worktree sessions: external tmux + scratch
// ---------------------------------------------------------------------------

export const ExternalTmuxSessionSchema = z.object({
  name: z.string(),
  windowCount: z.number().int().nonnegative(),
  attached: z.boolean(),
});

export const ExternalTmuxSessionListResponseSchema = z.object({
  sessions: z.array(ExternalTmuxSessionSchema),
});

export const ScratchSessionKindSchema = z.enum(["shell", "agent"]);

export const ScratchSessionSnapshotSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  sessionName: z.string(),
  kind: ScratchSessionKindSchema,
  agentId: z.string().nullable(),
  cwd: z.string(),
  createdAt: z.string(),
  windowCount: z.number().int().nonnegative(),
  attached: z.boolean(),
});

export const ScratchSessionListResponseSchema = z.object({
  sessions: z.array(ScratchSessionSnapshotSchema),
});

export const CreateScratchSessionRequestSchema = z.object({
  displayName: z.string().min(1).max(80),
  kind: ScratchSessionKindSchema,
  agentId: z.string().nullable().optional(),
});

export const CreateScratchSessionResponseSchema = z.object({
  session: ScratchSessionSnapshotSchema,
});

export const ScratchSessionIdParamsSchema = z.object({ id: z.string().min(1) });
```

And add the matching `z.infer<>` type exports near the bottom of the file (where other type exports live):

```ts
export type ExternalTmuxSession = z.infer<typeof ExternalTmuxSessionSchema>;
export type ExternalTmuxSessionListResponse = z.infer<typeof ExternalTmuxSessionListResponseSchema>;
export type ScratchSessionKind = z.infer<typeof ScratchSessionKindSchema>;
export type ScratchSessionSnapshot = z.infer<typeof ScratchSessionSnapshotSchema>;
export type ScratchSessionListResponse = z.infer<typeof ScratchSessionListResponseSchema>;
export type CreateScratchSessionRequest = z.infer<typeof CreateScratchSessionRequestSchema>;
export type CreateScratchSessionResponse = z.infer<typeof CreateScratchSessionResponseSchema>;
```

- [ ] **Step 4.2: Add API paths + contract entries**

In `packages/api-contract/src/contract.ts`, add to the `apiPaths` object (before the closing `} as const`):

```ts
  fetchExternalSessions: "/api/external-sessions",
  fetchScratchSessions: "/api/scratch-sessions",
  createScratchSession: "/api/scratch-sessions",
  removeScratchSession: "/api/scratch-sessions/:id",
```

Update the imports near the top to include the new schemas:

```ts
import {
  // ...existing imports...
  ExternalTmuxSessionListResponseSchema,
  ScratchSessionListResponseSchema,
  CreateScratchSessionRequestSchema,
  CreateScratchSessionResponseSchema,
  ScratchSessionIdParamsSchema,
} from "./schemas";
```

Add four entries to `apiContract` (place them after `dismissNotification`, before the closing object):

```ts
  fetchExternalSessions: {
    method: "GET",
    path: apiPaths.fetchExternalSessions,
    responses: {
      200: ExternalTmuxSessionListResponseSchema,
      500: ErrorResponseSchema,
    },
  },
  fetchScratchSessions: {
    method: "GET",
    path: apiPaths.fetchScratchSessions,
    responses: {
      200: ScratchSessionListResponseSchema,
      500: ErrorResponseSchema,
    },
  },
  createScratchSession: {
    method: "POST",
    path: apiPaths.createScratchSession,
    body: CreateScratchSessionRequestSchema,
    responses: {
      201: CreateScratchSessionResponseSchema,
      ...commonErrorResponses,
    },
  },
  removeScratchSession: {
    method: "DELETE",
    path: apiPaths.removeScratchSession,
    pathParams: ScratchSessionIdParamsSchema,
    body: c.noBody(),
    responses: {
      200: OkResponseSchema,
      ...commonErrorResponses,
    },
  },
```

- [ ] **Step 4.3: Verify contract package builds**

```bash
bun test packages/api-contract/src 2>&1 | tail -15
```

Expected: existing tests pass, no type errors.

- [ ] **Step 4.4: Commit**

```bash
git add packages/api-contract/src/schemas.ts packages/api-contract/src/contract.ts
git commit -m "feat(contract): add external + scratch session endpoints"
```

---

## Phase 5: Backend HTTP Routes

### Task 5: Wire HTTP handlers in `server.ts`

**Files:**
- Modify: `backend/src/server.ts`
- Modify: `backend/src/runtime.ts`

- [ ] **Step 5.1: Locate `runtime.ts` and identify the construction site**

```bash
grep -n "tmux\|listWindows\|gateway\|service" /home/mercer/projects/webmux/backend/src/runtime.ts | head -25
```

Goal: find where `BunTmuxGateway` is instantiated and the project services are wired up. The new `ScratchSessionService` is constructed there.

- [ ] **Step 5.2: Wire `scratchSessionService` into runtime**

In `backend/src/runtime.ts`, alongside other service wiring, add:

```ts
import { createScratchSessionService } from "./services/scratch-session-service";

// ...inside createWebmuxRuntime or equivalent factory:
const scratchSessionService = createScratchSessionService({
  tmux: tmuxGateway,
  cwd: projectDir,
});
scratchSessionService.scan();
```

Export it on the returned runtime object so `server.ts` can import it. The exact field name should follow the existing convention (e.g., `services.scratchSessions`).

- [ ] **Step 5.3: Add HTTP handlers in `server.ts`**

Near the other API handlers (search for `apiGetWorktrees` to find the section), add:

```ts
async function apiListExternalSessions(): Promise<Response> {
  const all = tmuxGateway.listAllSessions();
  const sessions = listExternalSessions(all);
  return jsonResponse({ sessions });
}

async function apiListScratchSessions(): Promise<Response> {
  return jsonResponse({ sessions: scratchSessionService.list() });
}

async function apiCreateScratchSession(req: Request): Promise<Response> {
  const body = CreateScratchSessionRequestSchema.parse(await req.json());
  const meta = await scratchSessionService.create({
    displayName: body.displayName,
    kind: body.kind,
    agentId: body.agentId ?? null,
  });
  const snap = scratchSessionService.list().find((s) => s.id === meta.id);
  if (!snap) throw new Error("scratch session created but not visible in list");
  return jsonResponse({ session: snap }, 201);
}

async function apiRemoveScratchSession(id: string): Promise<Response> {
  scratchSessionService.remove(id);
  return jsonResponse({ ok: true });
}

function parseScratchSessionIdParam(params: Record<string, string>): { ok: true; data: string } | { ok: false; response: Response } {
  const id = params.id;
  if (!id || id.length === 0) return { ok: false, response: errorResponse("Missing scratch session id", 400) };
  return { ok: true, data: id };
}
```

Make sure to add the imports at the top:

```ts
import {
  // ...existing schema imports...
  CreateScratchSessionRequestSchema,
} from "@webmux/api-contract";
import { listExternalSessions } from "./services/external-tmux-service";
```

And register the routes inside the `Bun.serve({ routes: { ... } })` block, alongside the other `[apiPaths.fetchWorktrees]` style entries:

```ts
    [apiPaths.fetchExternalSessions]: {
      GET: () => catching("GET /api/external-sessions", () => apiListExternalSessions()),
    },

    [apiPaths.fetchScratchSessions]: {
      GET: () => catching("GET /api/scratch-sessions", () => apiListScratchSessions()),
      POST: (req) => catching("POST /api/scratch-sessions", () => apiCreateScratchSession(req)),
    },

    [apiPaths.removeScratchSession]: {
      DELETE: (req) => {
        const parsed = parseScratchSessionIdParam(req.params);
        if (!parsed.ok) return parsed.response;
        return catching("DELETE /api/scratch-sessions/:id", () => apiRemoveScratchSession(parsed.data));
      },
    },
```

- [ ] **Step 5.4: Smoke-test build**

```bash
bun run build 2>&1 | tail -20
```

Expected: clean build, no TS errors.

- [ ] **Step 5.5: Smoke-test endpoints**

(Webmux is currently running in background; rebuild then restart it before testing — see Phase 8 verification. For an isolated dry run instead, use `bun run --cwd backend src/server.ts` on a different port.)

```bash
PORT=5199 bun run backend/src/server.ts &  # in a separate shell
SERVER_PID=$!
sleep 2
curl -sS http://localhost:5199/api/external-sessions | head
curl -sS http://localhost:5199/api/scratch-sessions
curl -sS -X POST http://localhost:5199/api/scratch-sessions \
  -H 'Content-Type: application/json' \
  -d '{"displayName":"smoke","kind":"shell"}'
kill $SERVER_PID
```

Expected: GET returns `{sessions:[...]}` (external lists `mcpsaa`, `codex-review`, etc.; scratch starts empty); POST returns 201 with the new scratch session; the second GET now lists it.

- [ ] **Step 5.6: Commit**

```bash
git add backend/src/server.ts backend/src/runtime.ts
git commit -m "feat(backend): HTTP routes for external + scratch sessions"
```

---

## Phase 6: WebSocket Attach for Non-Worktree Sessions

### Task 6: Extend WS data union and handler

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 6.1: Extend the `WsData` union**

In `backend/src/server.ts`, at the WebSocket protocol section (search `interface TerminalWsData`), add:

```ts
interface ExternalTerminalWsData {
  kind: "terminal-external";
  sessionName: string;
  attachId: string | null;
  attached: boolean;
}

interface ScratchTerminalWsData {
  kind: "terminal-scratch";
  scratchId: string;
  sessionName: string;
  attachId: string | null;
  attached: boolean;
}

type WsData = TerminalWsData | AgentsWsData | ExternalTerminalWsData | ScratchTerminalWsData;
```

(Replace the existing `type WsData = TerminalWsData | AgentsWsData;` line with the four-variant version.)

- [ ] **Step 6.2: Add the new WS routes**

Near the existing `/ws/:worktree` route registration:

```ts
    "/ws/external/:sessionName": (req, server) => {
      const sessionName = decodeURIComponent(req.params.sessionName);
      return server.upgrade(req, {
        data: { kind: "terminal-external", sessionName, attachId: null, attached: false },
      })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    },

    "/ws/scratch/:id": (req, server) => {
      const id = decodeURIComponent(req.params.id);
      const meta = scratchSessionService.list().find((s) => s.id === id);
      if (!meta) return new Response("Scratch session not found", { status: 404 });
      return server.upgrade(req, {
        data: {
          kind: "terminal-scratch",
          scratchId: id,
          sessionName: meta.sessionName,
          attachId: null,
          attached: false,
        },
      })
        ? undefined
        : new Response("WebSocket upgrade failed", { status: 400 });
    },
```

- [ ] **Step 6.3: Update WS open handler**

Find the `open(ws)` handler (around `if (data.kind === "terminal")`). Update to:

```ts
    open(ws) {
      const data = ws.data;
      if (data.kind === "terminal" || data.kind === "terminal-external" || data.kind === "terminal-scratch") {
        const label =
          data.kind === "terminal" ? data.branch :
          data.kind === "terminal-external" ? data.sessionName :
          `scratch:${data.scratchId}`;
        log.debug(`[ws] open ${data.kind} target=${label}`);
        return;
      }

      log.debug(`[ws:agents] open branch=${data.branch}`);
      void openAgentsSocket(ws, data);
    },
```

- [ ] **Step 6.4: Update WS message handler — first-resize attach branch**

Locate the `case "resize":` block inside `message(ws, message)` (the `if (!data.attached)` branch that calls `resolveTerminalWorktree`). Replace the contents of that branch with a `kind` switch:

```ts
        case "resize":
          if (!data.attached) {
            data.attached = true;
            try {
              let attachTarget: TerminalAttachTarget;
              let attachIdPrefix: string;
              if (data.kind === "terminal") {
                const terminalWorktree = await resolveTerminalWorktree(data.branch);
                attachTarget = terminalWorktree.attachTarget;
                attachIdPrefix = terminalWorktree.worktreeId;
                data.worktreeId = terminalWorktree.worktreeId;
              } else if (data.kind === "terminal-external") {
                const windowName = tmuxGateway.getFirstWindowName(data.sessionName);
                if (!windowName) throw new Error(`tmux session not found: ${data.sessionName}`);
                attachTarget = { ownerSessionName: data.sessionName, windowName };
                attachIdPrefix = `external-${data.sessionName}`;
              } else {
                // terminal-scratch
                const windowName = tmuxGateway.getFirstWindowName(data.sessionName);
                if (!windowName) throw new Error(`scratch tmux session not found: ${data.sessionName}`);
                attachTarget = { ownerSessionName: data.sessionName, windowName };
                attachIdPrefix = `scratch-${data.scratchId}`;
              }

              const attachId = `${attachIdPrefix}:${randomUUID()}`;
              data.attachId = attachId;
              await attach(attachId, attachTarget, msg.cols, msg.rows, msg.initialPane);
              const { onData, onExit } = makeCallbacks(ws);
              setCallbacks(attachId, onData, onExit);
              const scrollback = getScrollback(attachId);
              log.debug(`[ws] attached kind=${data.kind} attachId=${attachId} scrollback=${scrollback.length} bytes`);
              if (scrollback.length > 0) {
                sendWs(ws, { type: "scrollback", data: scrollback });
              }
            } catch (err: unknown) {
              const errMsg = err instanceof Error ? err.message : String(err);
              data.attached = false;
              data.attachId = null;
              if (data.kind === "terminal") data.worktreeId = null;
              log.error(`[ws] attach failed kind=${data.kind}: ${errMsg}`);
              sendWs(ws, { type: "error", message: errMsg });
              ws.close(1011, errMsg.slice(0, 123));
            }
          } else {
            const attachId = getAttachedSessionId(data, ws);
            if (!attachId) return;
            await resize(attachId, msg.cols, msg.rows);
          }
          break;
```

Note: the `getAttachedSessionId(data, ws)` helper currently takes `TerminalWsData`; widen its signature to accept the union:

```ts
function getAttachedSessionId(
  data: TerminalWsData | ExternalTerminalWsData | ScratchTerminalWsData,
  ws: { readyState: number; send: (data: string) => void },
): string | null {
  if (data.attached && data.attachId) return data.attachId;
  sendWs(ws, { type: "error", message: "Terminal not attached" });
  return null;
}
```

Also widen the `agents` message-handler guard so the existing flow keeps working:

```ts
    async message(ws, message) {
      const data = ws.data;
      if (data.kind === "agents") {
        log.debug(`[ws:agents] ignoring inbound message branch=${data.branch}`);
        return;
      }
      // ...rest of handler stays, but every reference to `data.branch` outside `case "resize"` should be guarded
      // by `data.kind === "terminal"` since external/scratch don't have a branch field.
      // ...
    },
```

For the `selectPane` log line that currently reads `data.branch`, change to:

```ts
            log.debug(`[ws] selectPane pane=${msg.pane} kind=${data.kind} attachId=${attachId}`);
```

- [ ] **Step 6.5: Update WS close handler**

Replace the close handler's destructuring of `data.branch`:

```ts
    async close(ws, code, reason) {
      const data = ws.data;
      if (data.kind === "agents") {
        log.debug(`[ws:agents] close branch=${data.branch} code=${code} reason=${reason}`);
        data.unsubscribe?.();
        data.unsubscribe = null;
        return;
      }

      const label =
        data.kind === "terminal" ? `branch=${data.branch} worktreeId=${data.worktreeId}` :
        data.kind === "terminal-external" ? `external=${data.sessionName}` :
        `scratch=${data.scratchId} session=${data.sessionName}`;
      log.debug(`[ws] close ${label} code=${code} reason=${reason} attached=${data.attached} attachId=${data.attachId}`);

      if (data.attachId) {
        clearCallbacks(data.attachId);
        await detach(data.attachId);
      }
    },
```

- [ ] **Step 6.6: Build and watch for type errors**

```bash
bun run build 2>&1 | tail -25
```

Expected: clean build. Address any `data.kind` exhaustiveness errors by adding the missing branches.

- [ ] **Step 6.7: Smoke-test WS attach via curl + websocat (optional)**

If `websocat` is installed:

```bash
echo '{"type":"resize","cols":80,"rows":24}' | websocat -n1 ws://localhost:5199/ws/external/mcpsaa
```

Expected: the response includes a scrollback prefix `s...` or a `type:error` if the session doesn't exist. If `websocat` isn't available, defer to the in-browser test in Phase 8.

- [ ] **Step 6.8: Commit**

```bash
git add backend/src/server.ts
git commit -m "feat(backend): WS attach for external + scratch tmux sessions"
```

---

## Phase 7: Frontend

### Task 7: Add types + API client wrappers

**Files:**
- Modify: `frontend/src/lib/types.ts`
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 7.1: Add types**

In `frontend/src/lib/types.ts`, append (or place near the worktree types):

```ts
import type {
  ExternalTmuxSession,
  ScratchSessionSnapshot,
  ScratchSessionKind,
} from "@webmux/api-contract";

export type { ExternalTmuxSession, ScratchSessionSnapshot, ScratchSessionKind };

export type Selection =
  | { kind: "worktree"; branch: string }
  | { kind: "external"; sessionName: string }
  | { kind: "scratch"; id: string; sessionName: string };
```

- [ ] **Step 7.2: Add API wrappers**

In `frontend/src/lib/api.ts`, append:

```ts
import type { CreateScratchSessionRequest } from "@webmux/api-contract";

export async function fetchExternalSessions(): Promise<ExternalTmuxSession[]> {
  const r = await api.fetchExternalSessions();
  return r.sessions;
}

export async function fetchScratchSessions(): Promise<ScratchSessionSnapshot[]> {
  const r = await api.fetchScratchSessions();
  return r.sessions;
}

export async function createScratchSession(body: CreateScratchSessionRequest): Promise<ScratchSessionSnapshot> {
  const r = await api.createScratchSession({ body });
  return r.session;
}

export async function removeScratchSession(id: string): Promise<void> {
  await api.removeScratchSession({ params: { id } });
}
```

(Make sure `ExternalTmuxSession` and `ScratchSessionSnapshot` are imported at the top.)

- [ ] **Step 7.3: Build + commit**

```bash
bun run --cwd frontend check 2>&1 | tail -15   # if there's a typecheck script; otherwise rely on `bun run build`
git add frontend/src/lib/types.ts frontend/src/lib/api.ts
git commit -m "feat(frontend): types + api wrappers for external/scratch sessions"
```

### Task 8: Extend `Terminal.svelte` with `kind` prop

**Files:**
- Modify: `frontend/src/lib/Terminal.svelte`

- [ ] **Step 8.1: Identify current props**

Read the top of `Terminal.svelte` to find the `$props<{...}>()` block. The current `worktree: string` prop is used to build the WS path at line ~264.

- [ ] **Step 8.2: Add `kind` prop with discriminated WS path**

Replace the `worktree` prop and the URL construction:

```svelte
let {
  selection,
  // ...other existing props...
} = $props<{
  selection: import("./types").Selection;
  // ...other existing props with their types...
}>();

let wsPath = $derived(
  selection.kind === "worktree" ? `/ws/${encodeURIComponent(selection.branch)}` :
  selection.kind === "external" ? `/ws/external/${encodeURIComponent(selection.sessionName)}` :
  `/ws/scratch/${encodeURIComponent(selection.id)}`
);
```

And update the WS construction to use `wsPath`:

```ts
const nextWs = new WebSocket(`${protocol}//${location.host}${wsPath}`);
```

Update any internal references to `worktree` (e.g., logging, key calculation) to use `selection`. The component's `{#key selection.kind === "worktree" ? selection.branch : selection.kind === "external" ? selection.sessionName : selection.id}` ensures it remounts cleanly when selection changes.

- [ ] **Step 8.3: Build + verify caller updates needed**

```bash
bun run build 2>&1 | tail -20
```

Expect: errors in `App.svelte` and any other Terminal callers (since the prop name changed). Note them — they're addressed in Task 10.

- [ ] **Step 8.4: Commit (as part of integration; defer until Task 10 passes)**

(Hold off on commit until App.svelte compiles cleanly — see Task 10.)

### Task 9: Add `SessionList.svelte` and `CreateScratchDialog.svelte`

**Files:**
- Create: `frontend/src/lib/SessionList.svelte`
- Create: `frontend/src/lib/CreateScratchDialog.svelte`
- Create: `frontend/src/lib/session-utils.ts`

- [ ] **Step 9.1: Add pure utilities**

Create `frontend/src/lib/session-utils.ts`:

```ts
import type { ExternalTmuxSession, ScratchSessionSnapshot } from "./types";

export function sortByName<T extends { name?: string; displayName?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const an = a.displayName ?? a.name ?? "";
    const bn = b.displayName ?? b.name ?? "";
    return an.localeCompare(bn);
  });
}

export function attachedBadge(s: ExternalTmuxSession | ScratchSessionSnapshot): string {
  return s.attached ? "● connected" : "○ idle";
}
```

- [ ] **Step 9.2: Create `CreateScratchDialog.svelte`**

```svelte
<script lang="ts">
  import type { CreateScratchSessionRequest } from "@webmux/api-contract";

  let {
    open,
    agentChoices,
    onClose,
    onCreate,
  } = $props<{
    open: boolean;
    agentChoices: { id: string; label: string }[];
    onClose: () => void;
    onCreate: (req: CreateScratchSessionRequest) => Promise<void>;
  }>();

  let displayName = $state("");
  let kind = $state<"shell" | "agent">("shell");
  let agentId = $state<string>(agentChoices[0]?.id ?? "");
  let busy = $state(false);
  let error = $state<string | null>(null);

  let dialogEl: HTMLDialogElement | null = $state(null);

  $effect(() => {
    if (!dialogEl) return;
    if (open && !dialogEl.open) dialogEl.showModal();
    if (!open && dialogEl.open) dialogEl.close();
  });

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    busy = true;
    error = null;
    try {
      await onCreate({
        displayName: displayName.trim(),
        kind,
        agentId: kind === "agent" ? agentId : null,
      });
      displayName = "";
      onClose();
    } catch (err: unknown) {
      error = err instanceof Error ? err.message : String(err);
    } finally {
      busy = false;
    }
  }
</script>

<dialog bind:this={dialogEl} class="rounded-md p-4 bg-[var(--color-bg-2)] text-[var(--color-fg)]">
  <form onsubmit={submit} class="flex flex-col gap-3 min-w-[320px]">
    <h2 class="text-lg font-semibold">New scratch session</h2>

    <label class="flex flex-col gap-1">
      Name
      <input bind:value={displayName} required class="border rounded px-2 py-1" />
    </label>

    <fieldset class="flex gap-3">
      <label><input type="radio" bind:group={kind} value="shell" /> Shell</label>
      <label><input type="radio" bind:group={kind} value="agent" /> Agent</label>
    </fieldset>

    {#if kind === "agent"}
      <label class="flex flex-col gap-1">
        Agent
        <select bind:value={agentId} class="border rounded px-2 py-1">
          {#each agentChoices as a (a.id)}
            <option value={a.id}>{a.label}</option>
          {/each}
        </select>
      </label>
    {/if}

    {#if error}
      <div class="text-red-500 text-sm">{error}</div>
    {/if}

    <div class="flex gap-2 justify-end">
      <button type="button" onclick={onClose} disabled={busy}>Cancel</button>
      <button type="submit" disabled={busy || displayName.trim() === ""}>Create</button>
    </div>
  </form>
</dialog>
```

- [ ] **Step 9.3: Create `SessionList.svelte`**

```svelte
<script lang="ts">
  import type { ExternalTmuxSession, ScratchSessionSnapshot, Selection } from "./types";
  import { sortByName, attachedBadge } from "./session-utils";

  let {
    externalSessions,
    scratchSessions,
    selection,
    onSelect,
    onCreateScratch,
    onRemoveScratch,
  } = $props<{
    externalSessions: ExternalTmuxSession[];
    scratchSessions: ScratchSessionSnapshot[];
    selection: Selection | null;
    onSelect: (sel: Selection) => void;
    onCreateScratch: () => void;
    onRemoveScratch: (id: string) => void;
  }>();

  let externalSorted = $derived(sortByName(externalSessions));
  let scratchSorted = $derived(sortByName(scratchSessions));

  function isExternalSelected(name: string): boolean {
    return selection?.kind === "external" && selection.sessionName === name;
  }
  function isScratchSelected(id: string): boolean {
    return selection?.kind === "scratch" && selection.id === id;
  }
</script>

<section class="flex flex-col text-sm">
  <header class="flex items-center justify-between px-3 py-1.5">
    <h3 class="uppercase tracking-wider text-xs opacity-70">Scratch sessions</h3>
    <button class="text-lg leading-none" aria-label="New scratch session" onclick={onCreateScratch}>+</button>
  </header>

  {#if scratchSorted.length === 0}
    <p class="px-3 py-1.5 opacity-50">No scratch sessions</p>
  {:else}
    <ul>
      {#each scratchSorted as s (s.id)}
        <li
          class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-[var(--color-bg-3)]"
          class:bg-[var(--color-bg-3)]={isScratchSelected(s.id)}
          onclick={() => onSelect({ kind: "scratch", id: s.id, sessionName: s.sessionName })}
        >
          <span class="flex-1 truncate">{s.displayName}</span>
          <span class="text-xs opacity-60 ml-2">{attachedBadge(s)}</span>
          <button
            type="button"
            class="ml-2 opacity-50 hover:opacity-100"
            aria-label="Remove scratch session"
            onclick={(e) => { e.stopPropagation(); onRemoveScratch(s.id); }}
          >×</button>
        </li>
      {/each}
    </ul>
  {/if}

  <header class="flex items-center px-3 py-1.5 mt-2">
    <h3 class="uppercase tracking-wider text-xs opacity-70">External tmux</h3>
  </header>

  {#if externalSorted.length === 0}
    <p class="px-3 py-1.5 opacity-50">No external sessions</p>
  {:else}
    <ul>
      {#each externalSorted as s (s.name)}
        <li
          class="flex items-center justify-between px-3 py-1.5 cursor-pointer hover:bg-[var(--color-bg-3)]"
          class:bg-[var(--color-bg-3)]={isExternalSelected(s.name)}
          onclick={() => onSelect({ kind: "external", sessionName: s.name })}
        >
          <span class="flex-1 truncate">{s.name}</span>
          <span class="text-xs opacity-60 ml-2">{attachedBadge(s)}</span>
        </li>
      {/each}
    </ul>
  {/if}
</section>
```

- [ ] **Step 9.4: Build and verify components compile**

```bash
bun run build 2>&1 | tail -20
```

Expect: errors only in `App.svelte` (since we haven't wired the new components in yet). The new component files should compile cleanly.

### Task 10: Wire into `App.svelte`

**Files:**
- Modify: `frontend/src/App.svelte`

- [ ] **Step 10.1: Add new state, fetchers, and handlers**

In the `<script>` section of `App.svelte`, after the existing worktree state:

```ts
import SessionList from "./lib/SessionList.svelte";
import CreateScratchDialog from "./lib/CreateScratchDialog.svelte";
import type { Selection } from "./lib/types";
import {
  fetchExternalSessions,
  fetchScratchSessions,
  createScratchSession,
  removeScratchSession,
} from "./lib/api";

let externalSessions = $state<ExternalTmuxSession[]>([]);
let scratchSessions = $state<ScratchSessionSnapshot[]>([]);
let selection = $state<Selection | null>(
  selectedBranch ? { kind: "worktree", branch: selectedBranch } : null
);
let showCreateScratchDialog = $state(false);

async function refreshSessions() {
  const [ext, scr] = await Promise.all([fetchExternalSessions(), fetchScratchSessions()]);
  externalSessions = ext;
  scratchSessions = scr;
}

async function handleCreateScratch(req: import("@webmux/api-contract").CreateScratchSessionRequest) {
  const session = await createScratchSession(req);
  scratchSessions = [...scratchSessions, session];
  selection = { kind: "scratch", id: session.id, sessionName: session.sessionName };
}

async function handleRemoveScratch(id: string) {
  await removeScratchSession(id);
  scratchSessions = scratchSessions.filter((s) => s.id !== id);
  if (selection?.kind === "scratch" && selection.id === id) {
    selection = null;
  }
}

function handleSelectionChange(next: Selection) {
  selection = next;
  if (next.kind === "worktree") {
    selectedBranch = next.branch;
    saveSelectedWorktree(next.branch);
  } else {
    selectedBranch = null;
    saveSelectedWorktree(null);
  }
}
```

- [ ] **Step 10.2: Refresh sessions on mount and poll**

In the existing `onMount` block, add:

```ts
void refreshSessions();
const sessionsPollHandle = setInterval(() => { void refreshSessions(); }, 5000);
return () => clearInterval(sessionsPollHandle);
```

- [ ] **Step 10.3: Render `SessionList` in the sidebar**

Find where `<WorktreeList ... />` is rendered. Below it (still in the sidebar container), add:

```svelte
<SessionList
  externalSessions={externalSessions}
  scratchSessions={scratchSessions}
  selection={selection}
  onSelect={handleSelectionChange}
  onCreateScratch={() => { showCreateScratchDialog = true; }}
  onRemoveScratch={handleRemoveScratch}
/>

<CreateScratchDialog
  open={showCreateScratchDialog}
  agentChoices={config.agents.map((a) => ({ id: a.id, label: a.id }))}
  onClose={() => { showCreateScratchDialog = false; }}
  onCreate={handleCreateScratch}
/>
```

When a worktree is selected from `WorktreeList`, also update `selection`:

```svelte
<WorktreeList
  ...
  onSelect={(branch) => handleSelectionChange({ kind: "worktree", branch })}
/>
```

(Adjust to match the actual existing prop name on `WorktreeList`. Search for the existing `onSelect`-equivalent prop to confirm.)

- [ ] **Step 10.4: Pass `selection` to `Terminal`**

Find where `<Terminal worktree={selectedBranch} ... />` is rendered. Replace with:

```svelte
{#if selection}
  <Terminal selection={selection} ... />
{/if}
```

The other Terminal props remain unchanged.

- [ ] **Step 10.5: Build and confirm clean compile**

```bash
bun run build 2>&1 | tail -25
```

Expected: clean build. Address any remaining type errors in `App.svelte` related to the `worktree`→`selection` prop change.

- [ ] **Step 10.6: Commit Tasks 8–10 together (the API breakage forces them to land as one)**

```bash
git add frontend/src/lib/Terminal.svelte \
        frontend/src/lib/SessionList.svelte \
        frontend/src/lib/CreateScratchDialog.svelte \
        frontend/src/lib/session-utils.ts \
        frontend/src/App.svelte
git commit -m "feat(frontend): SessionList sidebar + scratch dialog + Terminal selection prop"
```

---

## Phase 8: First End-to-End Verification

### Task 11: Restart webmux and smoke-test in browser

**Files:** none (verification only)

- [ ] **Step 11.1: Stop the running webmux**

```bash
ss -ltnp 2>/dev/null | grep ':3100'         # find pid
PID=$(ss -ltnp 2>/dev/null | grep ':3100' | grep -oP 'pid=\K[0-9]+' | head -1)
kill "$PID"
sleep 2
ss -ltn 2>/dev/null | grep ':3100' || echo "stopped"
```

Expected: ":3100 free".

- [ ] **Step 11.2: Restart webmux from source**

```bash
cd ~/projects/webmux-test
nohup webmux serve --port 3100 >/tmp/webmux-serve.log 2>&1 &
sleep 3
curl -sS -o /dev/null -w "local: %{http_code}\n" http://localhost:3100/
```

Expected: `local: 200`. Tmux session for the existing worktree (`wm-webmux-test-f01fb94b`) should reattach automatically.

- [ ] **Step 11.3: Browser checks**

In the browser at `https://paperclip.formup.cc`:

1. Reload. Existing worktree should still be in sidebar with terminal alive.
2. New "Scratch sessions" section visible with "+" button and "No scratch sessions" placeholder.
3. New "External tmux" section lists `mcpsaa`, `codex-review` (whatever non-`wm-*` sessions exist).
4. Click `mcpsaa` → terminal connects, shows current pane content.
5. Click "+" in Scratch section → dialog opens. Type "test", pick "Shell", Create. Terminal opens connected to new session. Type `echo hello` to confirm shell.
6. Reload page → scratch session still listed and reattaches with scrollback.
7. Click "×" on scratch row → it disappears; tmux session is gone (`tmux ls` from another shell to confirm).

If any check fails, debug per `AGENTS.md` (add console.log/console.debug, run again). Do not commit speculative fixes.

- [ ] **Step 11.4: If all checks pass, commit a tag for ease of rollback**

```bash
git tag wip-feature-b-passes
```

---

## Phase 9: CLI Parity

### Task 12: Add `bin/src/session-commands.ts` + register in `webmux.ts`

**Files:**
- Create: `bin/src/session-commands.ts`
- Create: `bin/src/session-commands.test.ts`
- Modify: `bin/src/webmux.ts`

- [ ] **Step 12.1: Skim existing CLI patterns**

Read `bin/src/worktree-commands.ts` lines 1–80 to understand the dispatch and the `createApi("")` pattern. CLI commands hit the running webmux server via `createApi("http://localhost:<port>")`.

- [ ] **Step 12.2: Implement `session-commands.ts`**

```ts
import { createApi } from "@webmux/api-contract";
import * as p from "@clack/prompts";

export type SessionSubcommand = "sessions" | "scratch" | "attach";

export function getSessionUsage(command: SessionSubcommand): string {
  switch (command) {
    case "sessions": return "Usage: webmux sessions [--port N]\n  List external tmux sessions and webmux scratch sessions.";
    case "scratch":  return "Usage: webmux scratch <name> [--agent <id>] [--port N]\n  Create a new scratch session.";
    case "attach":   return "Usage: webmux attach <session-name> [--port N]\n  Print the URL to attach to a session in the dashboard.";
  }
}

interface RunArgs {
  port: number;
  command: SessionSubcommand;
  args: string[];
  stdout: (s: string) => void;
}

export async function runSessionCommand({ port, command, args, stdout }: RunArgs): Promise<number> {
  const api = createApi(`http://localhost:${port}`);

  if (command === "sessions") {
    const [ext, scr] = await Promise.all([api.fetchExternalSessions(), api.fetchScratchSessions()]);
    stdout("External tmux sessions:");
    for (const s of ext.sessions) stdout(`  ${s.name}\t${s.windowCount}w\t${s.attached ? "attached" : "idle"}`);
    stdout("");
    stdout("Scratch sessions:");
    for (const s of scr.sessions) stdout(`  ${s.id}\t${s.displayName}\t${s.kind}\t${s.attached ? "attached" : "idle"}`);
    return 0;
  }

  if (command === "scratch") {
    const name = args[0];
    if (!name) { stdout(getSessionUsage("scratch")); return 2; }
    const agentIdx = args.indexOf("--agent");
    const agentId = agentIdx >= 0 ? args[agentIdx + 1] ?? null : null;
    const r = await api.createScratchSession({
      body: { displayName: name, kind: agentId ? "agent" : "shell", agentId },
    });
    stdout(`Created scratch session ${r.session.id} (${r.session.sessionName})`);
    return 0;
  }

  if (command === "attach") {
    const name = args[0];
    if (!name) { stdout(getSessionUsage("attach")); return 2; }
    const ext = await api.fetchExternalSessions();
    const scr = await api.fetchScratchSessions();
    const isExternal = ext.sessions.some((s) => s.name === name);
    const scratch = scr.sessions.find((s) => s.displayName === name || s.id === name || s.sessionName === name);
    if (isExternal) {
      stdout(`Open the dashboard and pick "${name}" under External tmux.`);
      return 0;
    }
    if (scratch) {
      stdout(`Open the dashboard and pick scratch "${scratch.displayName}".`);
      return 0;
    }
    stdout(`No external or scratch session named "${name}" found.`);
    return 1;
  }

  stdout(getSessionUsage(command));
  return 2;
}
```

- [ ] **Step 12.3: Add a small test**

Create `bin/src/session-commands.test.ts`:

```ts
import { test, expect } from "bun:test";
import { getSessionUsage } from "./session-commands";

test("usage strings exist for all subcommands", () => {
  expect(getSessionUsage("sessions")).toContain("webmux sessions");
  expect(getSessionUsage("scratch")).toContain("webmux scratch");
  expect(getSessionUsage("attach")).toContain("webmux attach");
});
```

```bash
bun test bin/src/session-commands 2>&1 | tail -10
```

Expected: PASS.

- [ ] **Step 12.4: Register subcommands in `bin/src/webmux.ts`**

Add `"sessions" | "scratch" | "attach"` to the `RootCommand` type. Update `isRootCommand` to include them. Update `usage()` to add three lines:

```
  webmux sessions     List external tmux + scratch sessions
  webmux scratch      Create a new scratch session
  webmux attach       Print attach hint for a session by name
```

In the dispatch (search for the section that calls into `worktree-commands`), add a new branch:

```ts
if (parsed.command === "sessions" || parsed.command === "scratch" || parsed.command === "attach") {
  const { runSessionCommand } = await import("./session-commands");
  const code = await runSessionCommand({
    port: parsed.port,
    command: parsed.command,
    args: parsed.commandArgs,
    stdout: console.log,
  });
  process.exit(code);
}
```

- [ ] **Step 12.5: Build CLI and smoke-test against the running webmux**

```bash
bun run build 2>&1 | tail -10
webmux sessions --port 3100
webmux scratch from-cli --port 3100
webmux sessions --port 3100   # should show the new entry
```

Expected: list output; create succeeds; second list shows the new session.

- [ ] **Step 12.6: Commit**

```bash
git add bin/src/session-commands.ts bin/src/session-commands.test.ts bin/src/webmux.ts
git commit -m "feat(cli): sessions/scratch/attach subcommands"
```

---

## Phase 10: Final Verification + Push

### Task 13: Full test suite + browser regression

- [ ] **Step 13.1: Run all suites**

```bash
bun run --cwd backend test 2>&1 | tail -10
bun test packages/api-contract/src 2>&1 | tail -10
bun test bin/src 2>&1 | tail -10
bun run --cwd frontend test 2>&1 | tail -10   # if this script exists
```

Expected: all green. Investigate any regressions.

- [ ] **Step 13.2: Browser regression — worktree flow**

1. Reload `paperclip.formup.cc`.
2. Existing worktree terminal works.
3. `Cmd+K` create-worktree dialog still opens and creates worktrees correctly.
4. PR/CI/Linear/Services badges still render on worktrees.

- [ ] **Step 13.3: Browser regression — webmux restart preserves both kinds**

1. Note the open scratch session and an external session you've attached to.
2. Restart webmux (kill+relaunch).
3. Reload page. Both still listed; reattaching shows scrollback intact.

- [ ] **Step 13.4: Push the branch**

```bash
git push -u origin feat/non-worktree-sessions
```

(If the user wants to upstream this, follow up with a PR using the existing PR template; if it's a personal fork, they can stop here.)

- [ ] **Step 13.5: Tag the release**

```bash
git tag feat/non-worktree-sessions-v1
git push origin feat/non-worktree-sessions-v1
```

---

## Self-Review Notes

- Spec coverage: Feature B (attach external) covered by Tasks 1, 2, 4, 5, 6, 7, 8, 9, 10, 11. Feature A (scratch session) covered by Tasks 3, 4, 5, 6, 7, 9, 10, 11, 12.
- CLI parity: Task 12 covers `sessions`, `scratch`, `attach`.
- No placeholders: every step has either exact code or an exact command.
- Type consistency: `Selection` discriminator keys (`kind`, `branch|sessionName|id`) used consistently across types.ts, SessionList.svelte, App.svelte, Terminal.svelte. Backend `WsData` variants use parallel discriminators (`terminal | terminal-external | terminal-scratch`).
- WS attach widening: confirmed `getAttachedSessionId` signature update is included.
- Persistence: scratch sessions survive restart via `wm-scratch-*` naming convention rebuilt by `scan()` (Task 3 Step 3.5). Verified in Step 13.3.

## Known Out-of-Scope (for follow-up plans)

- **Mobile chat UI** (the simplified chat-only view) is not extended to scratch agents. The chat surface is claude/codex-worktree-only by design. Adding it for scratch-agent sessions is a separate plan.
- **Sandbox/Docker profile support** for scratch sessions: not implemented; scratch always uses host runtime.
- **Service health / port allocation**: scratch sessions don't get auto-allocated service ports.
- **Auto-name** of scratch session names via LLM: skipped — user types the name.
- **Sharing/collaboration**: scratch sessions are per-project, not shared across `webmux serve` instances.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-27-tmux-sessions-non-worktree.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
