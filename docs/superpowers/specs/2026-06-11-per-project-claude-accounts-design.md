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
  that updates `meta`, persists, and refreshes the scope's resolved config dir.

`ProjectInfo` in `@webmux/api-contract` gains `account?: string`.

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
through `quoteEnvValue` (`backend/src/adapters/fs.ts:28`), which wraps anything
containing `~`/`/` in single quotes. The pane sources the file via
`set -a; . runtime.env; set +a`, and a single-quoted `~` does **not** undergo tilde
expansion. Resolving to an absolute path in the backend avoids this entirely.

Lives in a shared lib module so both the resolver and any UI/CLI display logic can
import it. Backend-only at runtime (CLI reaches it through the API).

### Injection site

`backend/src/services/lifecycle-service.ts` `refreshManagedArtifactsFromMeta`
(~line 658) is the single place `runtime.env` is built:

```ts
const runtimeEnv = buildRuntimeEnvMap(input.meta, {
  WEBMUX_WORKTREE_PATH: input.worktreePath,
  ...(configDir ? { CLAUDE_CONFIG_DIR: configDir } : {}),
}, dotenvValues);
```

`configDir` is obtained from a new lifecycle dep `getClaudeConfigDir(): string | undefined`,
supplied by the project scope (the scope knows its `account` from the registry and
holds the current preferences snapshot, so it resolves via `resolveAccountConfigDir`).

The value lands in `runtime.env`, which is sourced by every pane in the worktree.
This is intentional and is still "Claude only" in effect: only the `claude` binary
reads `CLAUDE_CONFIG_DIR` (codex reads `CODEX_HOME`; shells ignore it), so a `claude`
launched by hand in a shell pane also picks up the right account. Injection is
therefore gated only on "project has an account assigned", not on
`meta.agent === "claude"`.

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
  (and absolute) in the built runtime env map; no account → absent.
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
