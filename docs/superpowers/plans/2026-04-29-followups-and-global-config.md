# webmux follow-ups + global vs per-project config migration

**Date:** 2026-04-29
**Branch:** `feat/non-worktree-sessions`
**HEAD:** `24b2b1a`
**Commits since main:** 92 (51 since `636b7d1` start of this work batch)

## What just shipped (sessions of 2026-04-28 → 2026-04-29)

A long thread of mobile-chat work + multi-project polish:

- **Open-with override**: per-launch agent override + shell-only on `webmux open` and the dashboard.
- **Yolo toggle + persistence**: create dialog toggle, persisted on `WorktreeMeta.yolo`, surfaced as a chip on sidebar + topbar, edit-worktree dialog.
- **Edit worktree dialog**: agent + yolo override on existing worktrees, close-and-reopen flow.
- **Mobile chat surface improvements**: stop/interrupt button, sticky scroll, polling fix for Claude pauses, jsonl mtime fallback for running flag, view toggle (xterm ↔ chat) on **both** mobile and desktop, persisted in localStorage.
- **Inline tool/thinking events**: Claude `tool_use` and `thinking` blocks rendered as one-liners with tap-to-expand; per-tool readable details (Bash/Read/Edit/Write/Grep formatting).
- **Markdown rendering**: assistant bubbles via `marked` + DOMPurify, headings sized for chat.
- **Composer**: 1→6 line auto-grow on mobile; Enter=submit on desktop chat surface, newline on touch.
- **Send + Interrupt simultaneously**: queue follow-ups while agent is working.
- **Scratch session chat**: full backend + frontend wiring (storage in tmux session options).
- **External tmux**: confirmed never chat-eligible — always shell-launched. Status badge from activity probe (content-diff cache, since `pane_last_activity` is unreliable).
- **Worktree status persistence**: `runtime-state.json` per worktree survives webmux restarts.
- **Per-project config refetch**: `fetchConfig?projectId=` so profiles/agents stay in sync when switching projects.
- **Default profile**: agent-only (no shell pane).
- **Sidebar polish**: thin scrollbar, scrollable when overflowing, project name defaults to dir basename.
- **TopBar**: Close/Archive/Merge/Remove consolidated into an Actions ▾ dropdown.
- **Status icons for scratch + external** in the sidebar (running/idle from probe).
- **Claude session rotation**: always pick newest `.jsonl` by mtime; meta auto-corrects on rotation.
- **Interrupt → lifecycle stopped**: backend manually emits `agent_status_changed` so the Stop button doesn't get stuck.
- **AGENTS.md**: 14 project-specific gotchas documented for future Claude.
- **README**: mobile chat features + status legend.

All committed and pushed to `fork/feat/non-worktree-sessions`.

## Remaining follow-up: global vs per-project config

webmux moved from single-project (started inside a repo, one `.webmux.yaml`) to multi-project (started anywhere, registry of projects each with their own yaml). Most config stayed per-project. Some of it makes more sense as **user-global** today.

### Audit

| Setting | Currently | Should be | Why |
|---|---|---|---|
| `profiles` (panes, runtime) | per-project | per-project ✅ | Different projects need different dev-server panes. Keep. |
| `services` (port allocation) | per-project | per-project ✅ | Per-project port pools. Keep. |
| `lifecycleHooks` | per-project | per-project ✅ | Project-specific scripts. Keep. |
| `linkedRepos` | per-project | per-project ✅ | Per-project. Keep. |
| `integrations.linear` | per-project | per-project ✅ | Different teams per project. Keep. |
| `integrations.github.autoRemoveOnMerge` | per-project | per-project ✅ | Behavior preference per-project is fine. |
| `workspace.mainBranch` / `worktreeRoot` | per-project | per-project ✅ | Project-specific. Keep. |
| Custom **agents** | per-project | **user-global** | A user defines `gemini` once with their command; same definition applies everywhere. Today: per-project means re-defining for each project. |
| `auto_name.model` | per-project | **user-global** | User wants consistent branch-name auto-generation across all projects, using one API key. |
| `auto_name.system_prompt` | per-project | user-global with per-project override | Default style is global; some projects want a different naming convention. |
| `workspace.defaultAgent` | per-project | **user-global default + per-project override** | "Always claude unless project says otherwise." |
| Default profile name | per-project | per-project ✅ | A project's first profile is project-specific. Keep. |
| Theme + UI prefs (`mobileViewOverride`, sidebar width, scratch defaults) | localStorage | localStorage ✅ | Already user-global. Keep. |
| **Auto-creating `.webmux.yaml` on "+ Project"** | per-project | drop or move to global | This is what bit the user — the auto-yaml gets clobbered by branch reverts because users don't gitignore it. The minimum project name + workspace defaults could live in the registry instead. |

### Proposed structure

Keep `.webmux.yaml` for genuinely per-project config:
- `name`, `workspace`, `services`, `profiles`, `lifecycleHooks`, `linkedRepos`, `integrations`, `startupEnvs`

New file `~/.config/webmux/preferences.yaml` for user-global config:
```yaml
schemaVersion: 1
defaultAgent: claude
agents:
  gemini:
    label: Gemini
    startCommand: "gemini --resume ${WEBMUX_AGENT_PROMPT:-}"
    resumeCommand: "gemini --resume"
  custom:
    label: My Custom Agent
    startCommand: "..."
auto_name:
  model: claude-3-5-haiku-latest
  system_prompt: >
    Generate a concise git branch name...
```

Per-project yaml can override any user-global field. Resolution order: user-global → project yaml → local overlay.

The **auto-create `.webmux.yaml` on "+ Project"** step would change to:
- Store the project's display name in the registry (`projects.yaml`) — currently registry only has `id`/`path`/`addedAt`.
- Skip writing `.webmux.yaml` automatically. The user adds one only if they actually need project-specific overrides.
- Remove the `name` fallback weirdness (currently `basename` fallback because no yaml = no name).

## Tasks

### Task 1 — Project name in registry

- Extend `~/.config/webmux/projects.yaml` schema with optional `name` field per project.
- "+ Project" dialog writes the user's chosen name to the registry, **not** to a yaml file.
- `getFrontendConfig` reads `name` from registry first, falls back to project yaml's `name`, then to dir basename.
- Stop calling `ensureWebmuxYaml` on project add.
- Migration: existing `projects.yaml` entries without `name` continue to work (fall back as before).

### Task 2 — User-global preferences file

- New adapter `backend/src/adapters/preferences.ts` reads/writes `~/.config/webmux/preferences.yaml`.
- Shape:
  ```ts
  interface UserPreferences {
    schemaVersion: number;
    defaultAgent?: AgentId;
    agents?: Record<AgentId, CustomAgentConfig>;
    autoName?: { model?: string; systemPrompt?: string };
  }
  ```
- File created lazily on first write.

### Task 3 — Merge user-global into project config at load time

- `loadConfig` (in `adapters/config.ts`) gains a third layer: user-global preferences merged before project yaml + local overlay.
- For `agents`: merge user-global agents + project-level agents (project takes precedence by id).
- For `defaultAgent`: project yaml > user-global > "claude" hardcoded fallback.
- For `auto_name`: same precedence.

### Task 4 — Frontend: settings dialog for user-global prefs

- The existing Settings dialog (gear icon) already manages "agents" per-project. Restructure to two sections:
  - **Global** (per-user): default agent, auto-name model, custom agents available everywhere.
  - **Project** (per-project): linkedRepos, integrations toggles, anything genuinely scoped to current project.
- New API endpoints `GET/PUT /api/preferences` (no projectId scope).

### Task 5 — Migration helper

- On first load after this change, if a project yaml has `agents` defined, offer a one-time migration prompt: "Move these agents to your global preferences?"
- Or: silently merge them (agents in yaml continue to work, global ones layer on top).

### Task 6 — Tests

- Backend: load order (global → project → local) round-trips correctly. Project overrides win.
- Frontend: settings dialog reads from both surfaces; saves to the right one.
- Migration: existing project yaml with agents still works without changes.

## Risks / open questions

- **Multi-user systems**: if two unix users share a webmux service (unlikely for now), per-user config doesn't make sense. Path forward: per-service config, but that's overkill — assume single-user.
- **`defaultAgent` ambiguity**: if the user-global default is `claude` and a project sets `codex`, what does the create-worktree dialog show? Probably the project's choice; user-global is the fallback for projects that don't set one.
- **Custom agents with `${WORKTREE_PATH}` etc**: those template vars are project-runtime values. They work the same regardless of where the agent definition lives — global agents would still get substitution at launch time.
- **Settings dialog UX**: today the gear opens per-project settings. Adding a "global" tab adds complexity. Could just have separate buttons in the topbar.

## Estimate

5-7 implementer tasks, 1-2 days. Mostly mechanical: schema additions, adapter, merge logic, frontend dialog restructure, tests.

## What to do first if resuming

1. Read this doc.
2. Read AGENTS.md "Project-specific gotchas" section — covers the tribal knowledge from this branch.
3. Read `docs/superpowers/plans/2026-04-28-multi-project-status.md` for the broader multi-project state.
4. Decide whether to ship Task 1 (registry name) standalone first — it's the smallest and fixes the SAA-yaml-clobber bug definitively.
5. Then bundle Tasks 2-4 together since they form one user-facing feature (global preferences).
