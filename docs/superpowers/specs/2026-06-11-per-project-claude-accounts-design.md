# Per-project Claude accounts

**Date:** 2026-06-11
**Status:** Approved (pending Codex spec review)

## Problem

A user has more than one Claude subscription (e.g. personal + work) and wants
different webmux projects to run the Claude CLI under different accounts, without
logging in and out. Claude Code reads the `CLAUDE_CONFIG_DIR` environment variable
at launch and stores all credentials/config/history under that directory
(default `~/.claude`). Pointing it at a different directory per account gives each
account isolated credentials and quota. This feature lets a user **associate a
named account with a project** so that project's Claude agent launches under the
right config dir automatically.

## Decisions (locked)

- **Account model:** named accounts in a global registry (not raw paths per project).
- **Account definitions live in** `~/.config/webmux/preferences.yaml` (one home index).
- **Project → account association lives in** `~/.config/webmux/projects.yaml` (one home index).
- **Agent scope:** Claude only. Inject `CLAUDE_CONFIG_DIR`. codex/custom agents unaffected.
- **Management surface:** full CRUD for the account list in **UI + CLI**, plus per-project
  assignment in both surfaces.

Both stores are single indexes in the user's home folder. No per-repo files are
introduced.

## Data model

### Account definitions — `preferences.yaml`

New `accounts` map on `UserPreferences`:

```yaml
accounts:
  personal: { configDir: ~/.claude-personal }
  work:     { configDir: ~/.claude-work }
```

```ts
export interface UserPreferencesAccount {
  configDir: string;
}
// UserPreferences gains:
//   accounts?: Record<string, UserPreferencesAccount>;
```

`backend/src/adapters/preferences.ts` changes:
- `UserPreferences` gains `accounts?`.
- `parsePreferencesAccounts(raw)`: for each entry require a non-empty string
  `configDir`; skip malformed entries with `log.warn` (mirrors `parsePreferencesAgents`).
- `applyPreferencesUpdate` merges `accounts` when present in the update.
- `buildSavePayload` writes `accounts` when non-empty.

### Project → account — `projects.yaml`

New optional `account?: string` on each registry entry:

```yaml
projects:
  - { id: abc, path: /home/.../webmux, name: webmux, account: work }
```

`backend/src/services/project-registry.ts` changes:
- `RegistryFileEntry` gains `account?: string`.
- `persist()` writes `account` when set.
- `load()` reads it into the in-memory `meta` map (alongside `name`).
- `buildInfo()` surfaces `account` onto `ProjectInfo`.
- New registry method `setAccount(projectId: string, account: string | null): void`
  that updates `meta`, persists, and pushes the new account onto the scope.

**Scope cannot currently reach the account.** `ProjectScopeDeps` holds a
preferences snapshot but no account, and registry `meta` today stores only
`addedAt`/`name` (project-scope.ts:23, project-registry.ts:62). So the registry
must thread `account` into the scope at construction and update it on `setAccount`.
Concretely: add a mutable `account` holder to the scope (mirroring how it already
holds a refreshable preferences snapshot, project-scope.ts:58/:129), set it from
`meta.account` when the scope is created/loaded, and have `setAccount` update both
the registry `meta` and the live scope holder.

`ProjectInfo` in `@webmux/api-contract` gains `account?: string`. The contract
schemas also need updating: `UserPreferencesSchema` gains `accounts`,
`ProjectInfoSchema` gains `account` (schemas.ts ~L541/:609), and a new
project-account PATCH route is added (contract.ts ~L51) — none of these exist yet.

## Resolution + injection

### Resolver (pure)

```ts
resolveAccountConfigDir(
  prefs: UserPreferences,
  accountName: string | undefined,
): string | undefined
```

- Returns `undefined` when `accountName` is falsy or not found in `prefs.accounts`
  (the latter also logs a warning — a project referencing a deleted account).
- Looks up `accounts[name].configDir`, then **expands a leading `~` or `$HOME` to an
  absolute path**.

**Why absolute-path expansion is required:** `renderEnvFile` runs every value
through `quoteEnvValue` (`backend/src/adapters/fs.ts:28`). A leading `~` is **not**
in `SAFE_ENV_VALUE_RE`, so `~/.claude-work` gets single-quoted (note: `/` *is* safe,
so a fully-absolute path is written unquoted). The pane sources the file via
`set -a; . runtime.env; set +a`, and a single-quoted `~` does **not** undergo tilde
expansion. Resolving to an absolute path in the backend sidesteps the quoting, so
the env file always holds a literal usable path.

Lives in a shared lib module so both the resolver and any UI/CLI display logic can
import it. Backend-only at runtime (CLI reaches it through the API).

### Injection site

`backend/src/services/lifecycle-service.ts` `refreshManagedArtifactsFromMeta`
(~line 658) is the primary place `runtime.env` is built:

```ts
const runtimeEnv = buildRuntimeEnvMap(input.meta, {
  WEBMUX_WORKTREE_PATH: input.worktreePath,
  ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
}, dotenvValues);
```

`configDir` is obtained from a new lifecycle dep `getClaudeConfigDir(): string | undefined`.
It cannot come "from the meta" — the scope resolves it from its **account** (threaded
in from the registry, see Data model) plus its live preferences snapshot, via
`resolveAccountConfigDir`. Because it's a getter (not a stored value), the
`PUT /api/preferences` refresh loop that already re-pushes preferences to every scope
(server.ts ~L1525-1534) makes a changed `configDir` take effect on the next launch
with no extra wiring.

**Cover every `runtime.env` write site, not just the managed one.** Adoption of an
unmanaged worktree goes through `openWorktree` → `initializeUnmanagedWorktree` →
`initializeManagedWorktree`, which writes runtime env with only `WEBMUX_WORKTREE_PATH`
as the extra (lifecycle-service.ts ~L249/:623/:631). The second `buildRuntimeEnvMap`
callsite (~L940) is likewise in scope. To avoid a missed path, fold the
`CLAUDE_CONFIG_DIR` extra into a single helper that every `buildRuntimeEnvMap` caller
in this service uses, rather than patching one callsite.

The value lands in `runtime.env`, which is sourced by every pane in the worktree.
This is intentional and is still "Claude only" in effect: only the `claude` binary
reads `CLAUDE_CONFIG_DIR` (codex reads `CODEX_HOME`; shells ignore it), so a `claude`
launched by hand in a shell pane also picks up the right account. Injection is
therefore gated only on "project has an account assigned", not on
`meta.agent === "claude"`.

## Conversation history must be account-aware (required for the feature to work)

Launching under a different `CLAUDE_CONFIG_DIR` is only half the feature. Claude
writes its session `.jsonl` files under `<CLAUDE_CONFIG_DIR>/projects/<encoded-cwd>/`,
but webmux's session discovery hard-codes the **default** dir:

- `backend/src/adapters/claude-cli.ts:177` — `readClaudeProjectsRoot()` returns
  `join(home, ".claude", "projects")`, used by `findClaudeSessionPath` /
  `listSessions` / `readSession` / `getSessionMtime`.
- `backend/src/services/claude-conversation-service.ts:247` — `listSessions(cwd)` is
  called with only the worktree cwd.

If left as-is, a project using a non-default account would launch Claude correctly
but show an **empty chat-history panel** (webmux reads `~/.claude/projects` while
Claude wrote to `~/.claude-work/projects`). So the session-resolution path must also
be account-aware:

- `readClaudeProjectsRoot` (and the `ClaudeCliGateway` session methods that call it)
  take an optional `configDir` and resolve `<configDir>/projects` when present, else
  fall back to `$HOME/.claude/projects`.
- `claude-conversation-service.ts` threads the same resolved `configDir` (obtained the
  same way as the launch path — from the scope's account + preferences) into those
  calls. This keeps the AGENTS.md "always pick newest session for the cwd" behavior;
  it only changes **which root** is scanned.

The resolved-configDir value is the same one used for injection, so it should be
exposed once on the scope and consumed by both the lifecycle (launch) and the
conversation service (history).

## API contract

- `GET /api/preferences` — include `accounts` in the returned payload.
- `PUT /api/preferences` — accept `accounts` in the partial update. The existing
  post-PUT loop that calls `scope.refreshConfig(prefs)` on every project scope must
  also re-resolve `getClaudeConfigDir()`, so a changed `configDir` takes effect for
  subsequent agent launches (per the AGENTS.md three-layer-merge refresh note).
- `GET /api/projects` — `ProjectInfo` carries `account`.
- **New** `PATCH /api/projects/:id` with body `{ account: string | null }` →
  calls `registry.setAccount`. Returns the updated `ProjectInfo`.

## Frontend

- `frontend/src/lib/api.ts`:
  - `accounts` rides along on the existing preferences fetch/update calls (extend
    the typed shapes).
  - Add `setProjectAccount(projectId: string, account: string | null)` → `PATCH`.
- **Settings → Accounts** panel: add / list / remove accounts (name + configDir).
  Reuse existing settings-section patterns; do not copy-paste — extract a shared
  row/list component if one already exists for the agents list.
- **Project settings**: an Account `<select>` populated from the accounts list, with
  a "(none)" option to clear. A project whose `account` references a name not in the
  accounts list is shown as invalid (e.g. flagged option), not silently blank.

## CLI parity

`bin/src/worktree-commands.ts` (+ top-level command dispatch / help):

```
webmux accounts add <name> --dir <path>
webmux accounts list
webmux accounts rm <name>
webmux project account <project> <name|--clear>
```

All hit the backend HTTP API (same transport as existing CLI commands). Update
argument parsing, help text, and the runtime handlers. `accounts list` prints
name → configDir; `project account` resolves the project the same way other
project-scoped CLI commands do.

## Tests

- **Resolver:** leading `~` and `$HOME` expand to absolute; unknown account →
  `undefined`; empty `configDir` rejected upstream so never reaches resolver.
- **Preferences parse:** valid `accounts`; malformed entries (missing/empty
  `configDir`, non-object) skipped with warning; round-trip through
  `buildSavePayload`.
- **Registry:** persist/load `account`; `setAccount` updates + persists;
  `PATCH /api/projects/:id` handler.
- **Injection:** worktree whose project has an account → `CLAUDE_CONFIG_DIR` present
  (and absolute) in the built runtime env map; no account → absent. Cover both the
  managed-create path and the unmanaged-adoption path.
- **Session discovery:** `readClaudeProjectsRoot(configDir)` returns
  `<configDir>/projects` when given a dir, `$HOME/.claude/projects` when not; the
  conversation service scans the account's projects root when the project has an
  account.
- **CLI:** parsing + handler for each new command (mock the API boundary with typed
  stubs).

## Deliberate scope calls (YAGNI)

- Account dir is injected whenever a project has one assigned — not gated on the
  agent being claude, since `CLAUDE_CONFIG_DIR` is inert for other agents.
- No validation that `configDir` exists on disk — Claude creates it on first run.
- No migration — every new field is optional; existing files load unchanged.
- codex (`CODEX_HOME`) is explicitly out of scope; can be added later by extending
  the account model with a per-agent env-var mapping.

## Non-obvious gotchas honored

- Tilde resolved to absolute before it reaches `renderEnvFile`/`quoteEnvValue`.
- Both new pieces of state persist to disk (preferences.yaml, projects.yaml) — not
  in-memory only.
- The `PUT /api/preferences` refresh loop re-resolves the config dir for all scopes.
- No `TmuxGateway` interface method is added, so the FakeTmuxGateway stub fan-out
  does not apply.
- **Session discovery is account-aware** — launching under a non-default
  `CLAUDE_CONFIG_DIR` without updating `readClaudeProjectsRoot` would silently break
  the chat-history panel. Both the launch path and the conversation service consume
  the same resolved configDir.
- The project **scope** doesn't currently know its account; the registry threads it in
  and updates it on `setAccount` (it is not derivable from `WorktreeMeta`).
