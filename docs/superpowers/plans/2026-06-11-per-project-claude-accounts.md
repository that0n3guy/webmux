# Per-project Claude accounts — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user define named Claude accounts (name → config dir) once, assign one to each webmux project, and have that project's Claude agent launch — and its conversation history resolve — under that account's `CLAUDE_CONFIG_DIR`.

**Architecture:** Account definitions live in `~/.config/webmux/preferences.yaml` (`accounts` map). The project→account link lives in `~/.config/webmux/projects.yaml` (`account` field per entry). A pure resolver maps account name → absolute config dir. The project scope exposes the resolved dir via a getter; the lifecycle service injects it as `CLAUDE_CONFIG_DIR` into `runtime.env`, and the Claude conversation service uses the same dir to locate session `.jsonl` files. Full CRUD + assignment in both the web UI and CLI.

**Tech Stack:** Bun + TypeScript (strict, no `any`), ts-rest + zod contract, Svelte 5 runes frontend, `bun test`.

**Spec:** `docs/superpowers/specs/2026-06-11-per-project-claude-accounts-design.md`

---

## File structure

| File | Responsibility | Action |
|------|----------------|--------|
| `backend/src/adapters/preferences.ts` | `accounts` parse/apply/save | Modify |
| `backend/src/lib/account-config.ts` | pure resolver `resolveAccountConfigDir` + `expandHome` | Create |
| `packages/api-contract/src/schemas.ts` | account zod schema, `ProjectInfo.account`, `UpdateProjectRequest` | Modify |
| `packages/api-contract/src/contract.ts` | `updateProject` PATCH route | Modify |
| `backend/src/services/project-scope.ts` | thread `account`, expose `getClaudeConfigDir()` | Modify |
| `backend/src/services/lifecycle-service.ts` | inject `CLAUDE_CONFIG_DIR` at every `runtime.env` write | Modify |
| `backend/src/services/project-registry.ts` | `account` in meta/persist/load/buildInfo + `setAccount` | Modify |
| `backend/src/server.ts` | `PATCH /api/projects/:projectId` handler + route | Modify |
| `backend/src/adapters/claude-cli.ts` | account-aware session root | Modify |
| `backend/src/services/claude-conversation-service.ts` | thread `configDir` into session lookups | Modify |
| `frontend/src/lib/api.ts` | `updateProject` wrapper | Modify |
| `frontend/src/lib/SettingsDialog.svelte` | accounts CRUD (global tab) + account select (project tab) | Modify |
| `bin/src/account-commands.ts` | CLI `accounts` + `account` handlers | Create |
| `bin/src/webmux.ts` | dispatch + help for new commands | Modify |

---

## Task 1: Backend preferences — `accounts` field

**Files:**
- Modify: `backend/src/adapters/preferences.ts`
- Test: `backend/src/__tests__/preferences.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/__tests__/preferences.test.ts`:

```typescript
test("load() parses accounts and round-trips through save()", async () => {
  const yaml = `
schemaVersion: 1
accounts:
  personal:
    configDir: ~/.claude-personal
  work:
    configDir: /home/u/.claude-work
`.trim();
  writeFileSync(prefsPath, yaml);
  const gw = createUserPreferencesGateway({ path: prefsPath });
  const prefs = await gw.load();
  expect(prefs.accounts).toEqual({
    personal: { configDir: "~/.claude-personal" },
    work: { configDir: "/home/u/.claude-work" },
  });

  await gw.save(prefs);
  const reread = await createUserPreferencesGateway({ path: prefsPath }).load();
  expect(reread.accounts).toEqual(prefs.accounts);
});

test("load() drops malformed account entries", async () => {
  const yaml = `
schemaVersion: 1
accounts:
  good:
    configDir: ~/.claude-good
  bad:
    configDir: ""
  alsobad: "not-an-object"
`.trim();
  writeFileSync(prefsPath, yaml);
  const prefs = await createUserPreferencesGateway({ path: prefsPath }).load();
  expect(prefs.accounts).toEqual({ good: { configDir: "~/.claude-good" } });
});

test("applyPreferencesUpdate replaces accounts when provided", () => {
  const base = { schemaVersion: 1, accounts: { a: { configDir: "~/a" } } };
  const next = applyPreferencesUpdate(base, { accounts: { b: { configDir: "~/b" } } });
  expect(next.accounts).toEqual({ b: { configDir: "~/b" } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bun test src/__tests__/preferences.test.ts`
Expected: FAIL — `prefs.accounts` is `undefined` (type error or assertion failure).

- [ ] **Step 3: Implement in `backend/src/adapters/preferences.ts`**

Add the interface (near `UserPreferencesSidebar`, ~L16):

```typescript
export interface UserPreferencesAccount {
  configDir: string;
}
```

Add `accounts` to `UserPreferences` (~L21):

```typescript
export interface UserPreferences {
  schemaVersion: number;
  defaultAgent?: AgentId;
  defaultProfile?: string;
  agents?: Record<AgentId, CustomAgentConfig>;
  accounts?: Record<string, UserPreferencesAccount>;
  autoName?: UserPreferencesAutoName;
  sidebar?: UserPreferencesSidebar;
}
```

Add a parser (mirror `parsePreferencesAgents`):

```typescript
function parsePreferencesAccounts(raw: unknown): Record<string, UserPreferencesAccount> | undefined {
  if (!isRecord(raw)) return undefined;

  const result: Record<string, UserPreferencesAccount> = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!name.trim()) continue;
    if (!isRecord(value) || typeof value.configDir !== "string" || !value.configDir.trim()) {
      log.warn(`[preferences] skipping malformed account entry: ${name}`);
      continue;
    }
    result[name.trim()] = { configDir: value.configDir.trim() };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}
```

In `applyPreferencesUpdate` add (after the `agents` line, ~L55):

```typescript
    ...(update.accounts !== undefined ? { accounts: update.accounts } : {}),
```

In `parsePreferences` add (after `const agents = ...`, ~L137):

```typescript
  const accounts = parsePreferencesAccounts(raw.accounts);
```

and include it in the return object (after `agents`):

```typescript
    ...(accounts !== undefined ? { accounts } : {}),
```

In `buildSavePayload` add (after the `agents` block, ~L162):

```typescript
  if (prefs.accounts !== undefined && Object.keys(prefs.accounts).length > 0) {
    payload.accounts = prefs.accounts;
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bun test src/__tests__/preferences.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/adapters/preferences.ts backend/src/__tests__/preferences.test.ts
git commit -m "feat(prefs): parse + persist accounts map"
```

---

## Task 2: Account config-dir resolver (pure)

**Files:**
- Create: `backend/src/lib/account-config.ts`
- Test: `backend/src/__tests__/account-config.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/account-config.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { expandHome, resolveAccountConfigDir } from "../lib/account-config";
import type { UserPreferences } from "../adapters/preferences";

const HOME = Bun.env.HOME ?? "/home/test";

describe("expandHome", () => {
  test("expands leading ~ and $HOME to absolute", () => {
    expect(expandHome("~/.claude-work")).toBe(`${HOME}/.claude-work`);
    expect(expandHome("~")).toBe(HOME);
    expect(expandHome("$HOME/.claude")).toBe(`${HOME}/.claude`);
  });
  test("leaves absolute paths untouched", () => {
    expect(expandHome("/srv/.claude")).toBe("/srv/.claude");
  });
});

describe("resolveAccountConfigDir", () => {
  const prefs: UserPreferences = {
    schemaVersion: 1,
    accounts: { work: { configDir: "~/.claude-work" } },
  };
  test("returns absolute dir for a known account", () => {
    expect(resolveAccountConfigDir(prefs, "work")).toBe(`${HOME}/.claude-work`);
  });
  test("returns undefined for no account name", () => {
    expect(resolveAccountConfigDir(prefs, undefined)).toBeUndefined();
  });
  test("returns undefined for an unknown account", () => {
    expect(resolveAccountConfigDir(prefs, "ghost")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bun test src/__tests__/account-config.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `backend/src/lib/account-config.ts`**

```typescript
import type { UserPreferences } from "../adapters/preferences";
import { log } from "./log";

export function expandHome(path: string): string {
  const home = Bun.env.HOME;
  if (!home) return path;
  if (path === "~") return home;
  if (path.startsWith("~/")) return home + path.slice(1);
  if (path === "$HOME") return home;
  if (path.startsWith("$HOME/")) return home + path.slice("$HOME".length);
  return path;
}

export function resolveAccountConfigDir(
  prefs: UserPreferences,
  accountName: string | undefined,
): string | undefined {
  if (!accountName) return undefined;
  const account = prefs.accounts?.[accountName];
  if (!account) {
    log.warn(`[accounts] project references unknown account: ${accountName}`);
    return undefined;
  }
  return expandHome(account.configDir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bun test src/__tests__/account-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/lib/account-config.ts backend/src/__tests__/account-config.test.ts
git commit -m "feat(accounts): pure account config-dir resolver"
```

---

## Task 3: API contract — schemas + PATCH route

**Files:**
- Modify: `packages/api-contract/src/schemas.ts`
- Modify: `packages/api-contract/src/contract.ts`

- [ ] **Step 1: Add schemas in `packages/api-contract/src/schemas.ts`**

Add account schema near `UserPreferencesSidebarSchema` (~L607):

```typescript
export const UserPreferencesAccountSchema = z.object({
  configDir: z.string().min(1),
});
```

Add `accounts` to `UserPreferencesSchema` (after the `agents` field, ~L617):

```typescript
  accounts: z.record(z.string(), UserPreferencesAccountSchema).optional(),
```

Add `account` to `ProjectInfoSchema` (~L541):

```typescript
export const ProjectInfoSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  name: z.string(),
  addedAt: z.string().datetime(),
  mainBranch: z.string(),
  defaultAgent: z.string(),
  account: z.string().optional(),
});
```

Add the update request/response near the project schemas (search `CreateProjectResponseSchema` and add after it):

```typescript
export const UpdateProjectRequestSchema = z.object({
  account: z.string().nullable(),
});
export const UpdateProjectResponseSchema = z.object({
  project: ProjectInfoSchema,
});
```

Add type exports near the other project type exports (~L701):

```typescript
export type UpdateProjectRequest = z.infer<typeof UpdateProjectRequestSchema>;
export type UpdateProjectResponse = z.infer<typeof UpdateProjectResponseSchema>;
```

- [ ] **Step 2: Add the route in `packages/api-contract/src/contract.ts`**

Add a path to `apiPaths` (near `removeProject`, ~L58):

```typescript
  updateProject: "/api/projects/:projectId",
```

Import the new schemas at the top of the contract (add to the existing schema import block):

```typescript
  UpdateProjectRequestSchema,
  UpdateProjectResponseSchema,
```

Add the route after `removeProject` (~L174). Note PATCH so it coexists with GET/POST/DELETE on the same path:

```typescript
  updateProject: {
    method: "PATCH",
    path: apiPaths.updateProject,
    pathParams: ProjectIdParamsSchema,
    body: UpdateProjectRequestSchema,
    responses: {
      200: UpdateProjectResponseSchema,
      ...commonErrorResponses,
    },
  },
```

- [ ] **Step 3: Typecheck the contract**

Run: `cd packages/api-contract && bunx tsc --noEmit`
Expected: no errors. (If `ProjectIdParamsSchema` / `commonErrorResponses` names differ, match the ones already used by `removeProject` in the same file.)

- [ ] **Step 4: Commit**

```bash
git add packages/api-contract/src
git commit -m "feat(contract): account fields + PATCH /api/projects/:id"
```

---

## Task 4: Scope exposes config dir + lifecycle injection

**Files:**
- Modify: `backend/src/services/project-scope.ts`
- Modify: `backend/src/services/lifecycle-service.ts`
- Test: `backend/src/__tests__/lifecycle-account-env.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/lifecycle-account-env.test.ts`. This unit-tests the env helper in isolation (no tmux), so add an exported pure helper rather than reaching through the whole service:

```typescript
import { describe, expect, test } from "bun:test";
import { withClaudeConfigDir } from "../services/lifecycle-service";

describe("withClaudeConfigDir", () => {
  const base = { WEBMUX_WORKTREE_PATH: "/wt" };
  test("adds CLAUDE_CONFIG_DIR when a dir is resolved", () => {
    expect(withClaudeConfigDir(base, "/home/u/.claude-work")).toEqual({
      WEBMUX_WORKTREE_PATH: "/wt",
      CLAUDE_CONFIG_DIR: "/home/u/.claude-work",
    });
  });
  test("leaves env untouched when no dir", () => {
    expect(withClaudeConfigDir(base, undefined)).toEqual(base);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bun test src/__tests__/lifecycle-account-env.test.ts`
Expected: FAIL — `withClaudeConfigDir` not exported.

- [ ] **Step 3: Implement in `backend/src/services/lifecycle-service.ts`**

Add the exported helper near the top of the file (module scope, after imports):

```typescript
export function withClaudeConfigDir(
  env: Record<string, string>,
  configDir: string | undefined,
): Record<string, string> {
  return configDir ? { ...env, CLAUDE_CONFIG_DIR: configDir } : env;
}
```

Add `getClaudeConfigDir` to `LifecycleServiceDependencies` (~L120):

```typescript
  getClaudeConfigDir?: () => string | undefined;
```

Use it at the `refreshManagedArtifactsFromMeta` runtime-env build (~L658):

```typescript
    const runtimeEnv = buildRuntimeEnvMap(input.meta, withClaudeConfigDir({
      WEBMUX_WORKTREE_PATH: input.worktreePath,
    }, this.deps.getClaudeConfigDir?.()), dotenvValues);
```

And at the lifecycle-hook env build (~L940):

```typescript
    env: buildRuntimeEnvMap(input.meta, withClaudeConfigDir({
      WEBMUX_WORKTREE_PATH: input.worktreePath,
    }, this.deps.getClaudeConfigDir?.()), dotenvValues),
```

- [ ] **Step 4: Thread account + getter through `backend/src/services/project-scope.ts`**

Add `account` to `ProjectScopeDeps` (~L23):

```typescript
  account?: string;
```

Add a mutable account holder next to the preferences holder (~L56):

```typescript
  const accountHolder: { current: string | undefined } = { current: deps.account };
```

Add a resolver getter (import at top: `import { resolveAccountConfigDir } from "../lib/account-config";`). Define near the holders:

```typescript
  function getClaudeConfigDir(): string | undefined {
    return resolveAccountConfigDir(preferencesHolder.current, accountHolder.current);
  }
```

Pass it into the `LifecycleService` deps (~L79, add to the object):

```typescript
    getClaudeConfigDir,
```

Add `account` setter + `getClaudeConfigDir` to the `ProjectScope` interface (~L37) and the returned object:

Interface additions:

```typescript
  setAccount(account: string | null): void;
  getClaudeConfigDir(): string | undefined;
```

Returned-object additions:

```typescript
    setAccount(account: string | null): void {
      accountHolder.current = account ?? undefined;
    },
    getClaudeConfigDir,
```

- [ ] **Step 5: Run test + typecheck**

Run: `cd backend && bun test src/__tests__/lifecycle-account-env.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/lifecycle-service.ts backend/src/services/project-scope.ts backend/src/__tests__/lifecycle-account-env.test.ts
git commit -m "feat(lifecycle): inject CLAUDE_CONFIG_DIR from project account"
```

---

## Task 5: Registry — persist/load account + setAccount

**Files:**
- Modify: `backend/src/services/project-registry.ts`
- Test: `backend/src/__tests__/project-registry.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `backend/src/__tests__/project-registry.test.ts`:

```typescript
test("setAccount persists account and surfaces it on ProjectInfo", async () => {
  const reg = createProjectRegistry(buildDeps());
  await reg.load();
  const dir = makeProjectDir("alpha");
  const info = await reg.add({ path: dir });

  const updated = reg.setAccount(info.id, "work");
  expect(updated.account).toBe("work");
  expect(reg.list()[0]?.account).toBe("work");
  expect(readFileSync(registryPath, "utf-8")).toContain("account: work");

  const reg2 = createProjectRegistry(buildDeps());
  await reg2.load();
  expect(reg2.list()[0]?.account).toBe("work");

  const cleared = reg.setAccount(info.id, null);
  expect(cleared.account).toBeUndefined();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bun test src/__tests__/project-registry.test.ts`
Expected: FAIL — `setAccount` not a function.

- [ ] **Step 3: Implement in `backend/src/services/project-registry.ts`**

Extend `RegistryFileEntry` (~L18):

```typescript
interface RegistryFileEntry {
  id: string;
  path: string;
  addedAt: string;
  name?: string;
  account?: string;
}
```

Extend the in-memory meta map type — change every `meta` declaration/usage to carry `account`. The map is declared `const meta = new Map<string, { addedAt: string; name?: string }>();`; change to:

```typescript
  const meta = new Map<string, { addedAt: string; name?: string; account?: string }>();
```

In `buildInfo` (~L65) surface it:

```typescript
    return {
      id: scope.projectId,
      path: scope.projectDir,
      name: registryName ?? fallbackName,
      addedAt: m?.addedAt ?? new Date().toISOString(),
      mainBranch: scope.config.workspace?.mainBranch ?? "main",
      defaultAgent: scope.config.workspace?.defaultAgent ?? "claude",
      ...(m?.account !== undefined ? { account: m.account } : {}),
    };
```

In `persist()` (~L84) write account:

```typescript
        if (m?.name !== undefined) entry.name = m.name;
        if (m?.account !== undefined) entry.account = m.account;
```

In `load()` read it (~L177): change the destructure and the `meta.set` call:

```typescript
    const entry = raw as { id?: unknown; path?: unknown; addedAt?: unknown; name?: unknown; account?: unknown };
    // ...
    const registryName = typeof entry.name === "string" ? entry.name : undefined;
    const registryAccount = typeof entry.account === "string" ? entry.account : undefined;
    try {
      const scope = constructScope(entry.path, preferences, registryAccount);
      scopes.set(scope.projectId, scope);
      meta.set(scope.projectId, { addedAt: entry.addedAt, name: registryName, account: registryAccount });
    } catch (err) { /* unchanged */ }
```

Update `constructScope` to accept + pass account (~L96):

```typescript
  function constructScope(projectDir: string, preferences: UserPreferences, account?: string): ProjectScope {
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
      preferences,
      account,
    });
  }
```

`add()` calls `constructScope(absPath, preferences)` — leave as is (no account on create).

Add `setAccount` to the `ProjectRegistry` interface (~L48):

```typescript
  setAccount(id: string, account: string | null): ProjectInfo;
```

Implement it in the returned object (near `get`/`list`):

```typescript
    setAccount(id: string, account: string | null): ProjectInfo {
      const scope = scopes.get(id);
      if (!scope) throw new Error(`Unknown project: ${id}`);
      const m = meta.get(id) ?? { addedAt: new Date().toISOString() };
      meta.set(id, { ...m, account: account ?? undefined });
      scope.setAccount(account);
      persist();
      return buildInfo(scope);
    },
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd backend && bun test src/__tests__/project-registry.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/project-registry.ts backend/src/__tests__/project-registry.test.ts
git commit -m "feat(registry): persist project account + setAccount"
```

---

## Task 6: Server — PATCH /api/projects/:projectId

**Files:**
- Modify: `backend/src/server.ts`

- [ ] **Step 1: Add the handler**

Near `apiCreateProject` (~L1781) add:

```typescript
async function apiUpdateProject(req: Request, projectId: string): Promise<Response> {
  const parsed = await parseJsonBody(req, UpdateProjectRequestSchema);
  if (!parsed.ok) return parsed.response;
  const project = runtime.projectRegistry.setAccount(projectId, parsed.data.account);
  return jsonResponse({ project });
}
```

Import `UpdateProjectRequestSchema` from `@webmux/api-contract` (add to the existing import block alongside `CreateProjectRequestSchema`).

- [ ] **Step 2: Wire the route**

The path `/api/projects/:projectId` (`apiPaths.removeProject` / `apiPaths.updateProject`) already has a route object with `DELETE`. Find that route block and add a `PATCH` method to the SAME object so they share the path. It looks like:

```typescript
    [apiPaths.removeProject]: {
      DELETE: (req) => catching("DELETE /api/projects/:id", () => apiRemoveProject(req, /* projectId extraction */)),
      PATCH: (req) => catching("PATCH /api/projects/:id", () => apiUpdateProject(req, /* same projectId extraction */)),
    },
```

Use the EXACT same `projectId` extraction the neighbouring `DELETE`/branches handlers use (Bun route param access — match the existing style in this file; do not invent a new one).

- [ ] **Step 3: Typecheck + smoke test**

Run: `cd backend && bunx tsc --noEmit && bun test`
Expected: no type errors; existing suite still green.

- [ ] **Step 4: Commit**

```bash
git add backend/src/server.ts
git commit -m "feat(api): PATCH /api/projects/:id sets account"
```

---

## Task 7: Account-aware Claude session discovery

**Files:**
- Modify: `backend/src/adapters/claude-cli.ts`
- Modify: `backend/src/services/claude-conversation-service.ts`
- Test: `backend/src/__tests__/claude-cli-projects-root.test.ts`

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/claude-cli-projects-root.test.ts`:

```typescript
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { resolveClaudeProjectsRoot } from "../adapters/claude-cli";

const HOME = Bun.env.HOME ?? "/home/test";

describe("resolveClaudeProjectsRoot", () => {
  test("uses account configDir/projects when given", () => {
    expect(resolveClaudeProjectsRoot("/home/u/.claude-work")).toBe(
      join("/home/u/.claude-work", "projects"),
    );
  });
  test("falls back to $HOME/.claude/projects", () => {
    expect(resolveClaudeProjectsRoot(undefined)).toBe(join(HOME, ".claude", "projects"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd backend && bun test src/__tests__/claude-cli-projects-root.test.ts`
Expected: FAIL — `resolveClaudeProjectsRoot` not exported.

- [ ] **Step 3: Implement in `backend/src/adapters/claude-cli.ts`**

Replace `readClaudeProjectsRoot` (~L171) with an exported account-aware version:

```typescript
export function resolveClaudeProjectsRoot(configDir?: string): string {
  if (configDir) return join(configDir, "projects");
  const home = Bun.env.HOME;
  if (!home) {
    throw new Error("HOME is required to resolve Claude sessions");
  }
  return join(home, ".claude", "projects");
}
```

Thread `configDir` through the gateway. Update the interface (~L69):

```typescript
export interface ClaudeCliGateway {
  listSessions(cwd: string, configDir?: string): Promise<ClaudeCliSessionSummary[]>;
  readSession(sessionId: string, cwd: string, configDir?: string): Promise<ClaudeCliSession | null>;
  getSessionMtime(sessionId: string, cwd: string, configDir?: string): Promise<Date | null>;
  sendMessage(/* unchanged */): ClaudeCliRunHandle;
}
```

Update `findClaudeSessionPath` (~L191) to accept + use `configDir`:

```typescript
async function findClaudeSessionPath(sessionId: string, cwd: string, configDir?: string): Promise<string | null> {
  const projectsRoot = resolveClaudeProjectsRoot(configDir);
  // ...rest unchanged (it already uses `projectsRoot`)...
}
```

Update the three methods to resolve with `configDir` and forward it:

```typescript
  async listSessions(cwd: string, configDir?: string): Promise<ClaudeCliSessionSummary[]> {
    const projectsRoot = resolveClaudeProjectsRoot(configDir);
    // ...rest unchanged...
  }

  async readSession(sessionId: string, cwd: string, configDir?: string): Promise<ClaudeCliSession | null> {
    const filePath = await findClaudeSessionPath(sessionId, cwd, configDir);
    if (!filePath) return null;
    return await this.readSessionFile(filePath);
  }

  async getSessionMtime(sessionId: string, cwd: string, configDir?: string): Promise<Date | null> {
    const filePath = await findClaudeSessionPath(sessionId, cwd, configDir);
    if (!filePath) return null;
    const info = await stat(filePath).catch(() => null);
    return info ? info.mtime : null;
  }
```

- [ ] **Step 4: Thread `configDir` through `claude-conversation-service.ts`**

Add a getter dep to `ClaudeConversationServiceDependencies` (~L30):

```typescript
  getClaudeConfigDir?: () => string | undefined;
```

In `resolveSession` (~L242) resolve once and pass to both calls:

```typescript
    const configDir = this.deps.getClaudeConfigDir?.();
    const all = await this.deps.claude.listSessions(cwd, configDir);
    // ...
    if (newest) {
      return await this.deps.claude.readSession(newest.sessionId, cwd, configDir);
    }
```

(Any other `getSessionMtime`/`readSession`/`listSessions` callsites in this file get the same `configDir` argument.)

- [ ] **Step 5: Wire the getter where the conversation service is constructed**

Find where `ClaudeConversationService` (or its deps) is built for a scope — it is constructed inside `project-scope.ts` (or `project-runtime`). Pass `getClaudeConfigDir` (the same function defined in Task 4):

```typescript
    getClaudeConfigDir,
```

If the conversation service is built inside `ProjectRuntime` rather than directly in the scope, thread `getClaudeConfigDir` from scope → runtime construction (the scope already builds `projectRuntime` in Task 4's file). Match the existing dependency-passing style.

- [ ] **Step 6: Run tests + typecheck**

Run: `cd backend && bun test && bunx tsc --noEmit`
Expected: PASS, no type errors. (Search for any remaining `readClaudeProjectsRoot` references and any 2-arg `listSessions`/`readSession`/`getSessionMtime` calls in tests; update call signatures if a test stub implements the gateway.)

- [ ] **Step 7: Commit**

```bash
git add backend/src/adapters/claude-cli.ts backend/src/services/claude-conversation-service.ts backend/src/services/project-scope.ts backend/src/__tests__/claude-cli-projects-root.test.ts
git commit -m "feat(conversation): resolve Claude sessions under account config dir"
```

---

## Task 8: Frontend API wrapper

**Files:**
- Modify: `frontend/src/lib/api.ts`

- [ ] **Step 1: Add the wrapper**

Add `UpdateProjectRequest` to the type import from `@webmux/api-contract` (~L2). Add after `removeProject` (~L341):

```typescript
export async function updateProject(id: string, body: UpdateProjectRequest): Promise<ProjectInfo> {
  const r = await api.updateProject({ params: { projectId: id }, body });
  return r.project;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd frontend && bunx tsc --noEmit` (or the project's `bun run check`)
Expected: no errors. `prefs.accounts` is already typed via the contract `UserPreferences`.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/lib/api.ts
git commit -m "feat(frontend): updateProject api wrapper"
```

---

## Task 9: Settings UI — accounts CRUD + per-project select

**Files:**
- Modify: `frontend/src/lib/SettingsDialog.svelte`

This component already has `projectId`, a `"global" | "project"` tab split, an agents CRUD block in the global tab, and per-project toggles in the project tab that call `api.setAutoRemoveOnMerge({ params: { projectId }, body })`. Mirror those exact patterns.

- [ ] **Step 1: Global tab — accounts list/add/remove**

Below the "Custom agents" block (~after L471), add an "Accounts" block that mirrors it. Derived list:

```typescript
let accountEntries = $derived(prefs?.accounts ? Object.entries(prefs.accounts) : []);
```

Add `$state` for an inline add form (`newAccountName`, `newAccountDir`). On add/remove, build the next `accounts` object and call `updatePreferences(buildUpdateBody(...))` — reuse whatever `buildUpdateBody` includes; ensure `accounts` is part of the PUT body (extend `buildUpdateBody` to carry `accounts: prefs.accounts`). Markup mirrors the agents `{#each}` list with name + `configDir` (mono) and a Delete button; an "Add account" row has two inputs (Name, Config dir e.g. `~/.claude-work`) and a save button. Validate non-empty name + dir before save.

- [ ] **Step 2: Project tab — account `<select>`**

In the project tab (near the other per-project controls, ~L348 where `defaultAgent` select lives), add:

```svelte
<div class="mb-4">
  <label class="block text-xs text-muted mb-1.5" for="proj-account">Claude account</label>
  <select id="proj-account" bind:value={selectedAccount} onchange={saveAccount}
    class="w-full px-2.5 py-1.5 rounded-md border border-edge bg-surface text-primary text-[13px] outline-none focus:border-accent">
    <option value="">(default ~/.claude)</option>
    {#each accountEntries as [name] (name)}
      <option value={name}>{name}</option>
    {/each}
    {#if currentAccountIsUnknown}
      <option value={currentAccount} disabled>(unknown) {currentAccount}</option>
    {/if}
  </select>
</div>
```

State + handler (mirror the auto-remove toggle's autosave pattern):

```typescript
let selectedAccount = $state<string>("");
// initialize from the current project's ProjectInfo.account when the dialog opens
let currentAccount = $derived(/* the project's account from props/fetched ProjectInfo */ "");
let currentAccountIsUnknown = $derived(
  !!currentAccount && !accountEntries.some(([n]) => n === currentAccount),
);

async function saveAccount(): Promise<void> {
  await updateProject(projectId, { account: selectedAccount || null });
  // refetch projects so sidebar + dialog reflect the new account
}
```

Import `updateProject` from `./api`. Obtain the project's current `account`: SettingsDialog is opened with `projectId`; read the matching `ProjectInfo` from the projects list the parent already holds (pass it in as a prop if not present, following how `projectId` is passed), or fetch it. Use the value to seed `selectedAccount` on open.

- [ ] **Step 3: Verify with the Svelte MCP autofixer**

Run the `mcp__svelte__svelte-autofixer` on the edited component and resolve any reported issues. Then run `cd frontend && bun run check` (or `bunx tsc --noEmit`).
Expected: clean.

- [ ] **Step 4: Manual sanity (optional but recommended)**

Start the app, open a project's Settings, add an account in Global, assign it in Project, confirm no console errors. (Full functional verify happens in the final task.)

- [ ] **Step 5: Commit**

```bash
git add frontend/src/lib/SettingsDialog.svelte
git commit -m "feat(frontend): manage Claude accounts + assign per project"
```

---

## Task 10: CLI — `accounts` + `account`

**Files:**
- Create: `bin/src/account-commands.ts`
- Modify: `bin/src/webmux.ts`
- Test: `bin/src/__tests__/account-commands.test.ts` (match where bin tests live; if none, place beside other bin tests)

CLI is cwd-scoped like the other project commands. Surfaces:
- `webmux accounts list` — print global accounts (name → configDir)
- `webmux accounts add <name> --dir <path>` — add to preferences
- `webmux accounts rm <name>` — remove from preferences
- `webmux account <name>` / `webmux account --clear` — set/clear the **current project's** account (project resolved from cwd via `computeProjectId`)

All hit the backend over HTTP using `createApi(\`http://localhost:${port}\`)`, exactly like the `send` handler.

- [ ] **Step 1: Write the failing test**

Create `bin/src/__tests__/account-commands.test.ts` testing arg parsing purely:

```typescript
import { describe, expect, test } from "bun:test";
import { parseAccountsAddArgs, parseAccountSetArgs } from "../account-commands";

describe("parseAccountsAddArgs", () => {
  test("parses name + --dir", () => {
    expect(parseAccountsAddArgs(["work", "--dir", "~/.claude-work"]))
      .toEqual({ name: "work", dir: "~/.claude-work" });
  });
  test("supports --dir=", () => {
    expect(parseAccountsAddArgs(["work", "--dir=~/.claude-work"]))
      .toEqual({ name: "work", dir: "~/.claude-work" });
  });
  test("returns null on --help", () => {
    expect(parseAccountsAddArgs(["--help"])).toBeNull();
  });
});

describe("parseAccountSetArgs", () => {
  test("parses a name", () => {
    expect(parseAccountSetArgs(["work"])).toEqual({ account: "work" });
  });
  test("--clear means null", () => {
    expect(parseAccountSetArgs(["--clear"])).toEqual({ account: null });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd bin && bun test src/__tests__/account-commands.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create `bin/src/account-commands.ts`**

Implement the parsers (mirror `readOptionValue` / `parseOpenCommandArgs` from `worktree-commands.ts`) and a `runAccountCommand` handler that:
- `accounts list`: `const { preferences } = await api.fetchPreferences(); print each name → configDir`.
- `accounts add`: `const { preferences } = await api.fetchPreferences(); api.updatePreferences({ body: { ...stripSchemaVersion(preferences), accounts: { ...preferences.accounts, [name]: { configDir: dir } } } })`.
- `accounts rm`: same, deleting the key.
- `account <name|--clear>`: `const projectId = computeProjectId(resolve(projectDir)); api.updateProject({ params: { projectId }, body: { account } })`.

Use the same connection-error wrapping the `send` handler uses ("Could not connect to webmux server on port ${port}. Is it running?"). Exported parser signatures:

```typescript
export function parseAccountsAddArgs(args: string[]): { name: string; dir: string } | null;
export function parseAccountSetArgs(args: string[]): { account: string | null } | null;
export async function runAccountCommand(context: {
  command: "accounts" | "account";
  args: string[];
  projectDir: string;
  port: number;
}): Promise<number>;
```

Note: `updatePreferences` body type omits `schemaVersion`; build the body from the loaded preferences minus `schemaVersion` plus the new `accounts`.

- [ ] **Step 4: Wire dispatch + help in `bin/src/webmux.ts`**

Add `"accounts"` and `"account"` to the `RootCommand` union and `isRootCommand`. After the worktree-command dispatch block (~L298), add:

```typescript
if (parsed.command === "accounts" || parsed.command === "account") {
  const { runAccountCommand } = await import("./account-commands.ts");
  const exitCode = await runAccountCommand({
    command: parsed.command,
    args: parsed.commandArgs,
    projectDir: process.cwd(),
    port: parsed.port,
  });
  process.exit(exitCode);
}
```

Add help text lines for the new commands wherever the usage/help string is built.

- [ ] **Step 5: Run tests + typecheck**

Run: `cd bin && bun test src/__tests__/account-commands.test.ts && bunx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 6: Commit**

```bash
git add bin/src/account-commands.ts bin/src/webmux.ts bin/src/__tests__/account-commands.test.ts
git commit -m "feat(cli): accounts management + per-project account assignment"
```

---

## Task 11: AGENTS.md gotcha + full verification

**Files:**
- Modify: `AGENTS.md`

- [ ] **Step 1: Document the gotcha**

Add a short subsection under "Project-specific gotchas":

```markdown
### Claude accounts are per-project via CLAUDE_CONFIG_DIR

Named accounts live in `preferences.yaml` (`accounts: { <name>: { configDir } }`); a
project picks one via `account:` in `projects.yaml`. The resolved (tilde-expanded,
absolute) dir is injected as `CLAUDE_CONFIG_DIR` into `runtime.env` and is ALSO used
to locate session `.jsonl` files (`resolveClaudeProjectsRoot(configDir)` in
`claude-cli.ts`). If you add a new place that launches Claude or reads Claude sessions,
thread `scope.getClaudeConfigDir()` through it — otherwise that surface silently uses
the default `~/.claude`.
```

- [ ] **Step 2: Full verification**

Run from repo root:

```bash
cd backend && bunx tsc --noEmit && bun test && cd ..
cd packages/api-contract && bunx tsc --noEmit && cd ../..
cd frontend && bun run check && cd ..
cd bin && bunx tsc --noEmit && bun test && cd ..
```

Expected: all green. Fix anything red before proceeding.

- [ ] **Step 3: Functional verification (use the `verify` skill)**

Restart webmux (`systemctl --user restart webmux.service` after `bun run build` from the deploy checkout, per the project's deploy note — or run the dev server), then:
1. Global Settings → add account `work` → `~/.claude-work`.
2. A project's Settings → Project tab → set account to `work`.
3. Open a worktree in that project; confirm the agent pane's `runtime.env` contains `CLAUDE_CONFIG_DIR=/abs/.claude-work` and the Claude session is created there.
4. Confirm the conversation panel populates (proves session discovery reads the account dir).

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md
git commit -m "docs(agents): note per-project Claude account gotcha"
```

---

## Self-review notes

- **Spec coverage:** accounts model (T1), resolver+tilde (T2), contract/types (T3), injection at all runtime.env sites (T4), registry persistence + setAccount (T5), PATCH endpoint (T6), account-aware session discovery — the high-severity Codex finding (T7), frontend api + CRUD + assignment (T8/T9), CLI parity (T10), gotcha + verification (T11). All spec sections map to a task.
- **Type consistency:** `getClaudeConfigDir()` is defined once in T4 (project-scope) and consumed in T4 (lifecycle) and T7 (conversation service). `setAccount` signature matches across ProjectScope (`(account: string | null)`) and ProjectRegistry (`(id, account: string | null): ProjectInfo`). `UpdateProjectRequest = { account: string | null }` is identical in contract (T3), server (T6), frontend (T8), CLI (T10).
- **Ordering:** backend-first per AGENTS.md; contract (T3) precedes server/frontend/CLI consumers; T7 lists the scope file again because its getter (defined T4) is wired into the conversation service there.
