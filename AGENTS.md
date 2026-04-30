## Implementing a new feature

Follow these steps in order. Do not skip ahead.

### 1. Understand the scope

Read the relevant CLAUDE.md before writing any code:

- **Backend work** → [`backend/CLAUDE.md`](backend/CLAUDE.md) — Bun APIs, REST/WebSocket conventions, module structure.
- **Frontend work** → [`frontend/CLAUDE.md`](frontend/CLAUDE.md) — Svelte 5 runes, component patterns, styling rules.
- **Full-stack feature** → Read both. Start with the backend.

### 2. Types first, code second

1. Define the data types/interfaces that the feature needs.
   - Backend types go in the relevant module file.
   - Frontend shared types go in `frontend/src/lib/types.ts` (types and interfaces only — no runtime logic).
2. Define the API contract — endpoint path, request body, response shape — before implementing either side.
3. On the frontend, add the typed fetch call to `frontend/src/lib/api.ts` before building UI.

### 3. Parity across all surfaces

Every user-facing feature must work in **both the frontend and the CLI**. When adding a new option, mode, or capability:

- Add it to the API/backend first.
- Wire it into the frontend UI.
- Wire it into the CLI (`bin/src/worktree-commands.ts`) — update parsing, help text, and the runtime handler.
- Add tests for both surfaces.

Do not ship a feature that only works from one surface.

### 4. Build incrementally

- **Backend**: implement the handler, delegate logic to pure testable functions, wire it into `server.ts` routing.
- **Frontend**: build the component with mock data first, then connect the real API.
- Test each layer independently before integrating.

### 5. DRY — no exceptions

- If a UI pattern already exists in another component, extract it into a shared component immediately. Do not copy-paste.
- If a helper function is needed in more than one file, put it in a shared `lib/` utility. Never duplicate logic across files.
- Check existing components and utilities before creating new ones.

### 6. Keep it minimal

- Only implement what was asked for. No speculative features, no extra configurability, no "while I'm here" refactors.
- Don't add comments, docstrings, or type annotations to code you didn't change.
- Don't add error handling for scenarios that can't happen. Trust internal code and framework guarantees.

## Project-specific gotchas (learned the hard way)

### Persisted state lives next to git meta

- `WorktreeMeta` (`.git/worktrees/<branch>/webmux/meta.json`) — agent, profile, yolo, conversation-id mapping. Read via `readWorktreeMeta`, written via `writeWorktreeMeta`.
- `WorktreeRuntimeStatePersisted` (`.git/worktrees/<branch>/webmux/runtime-state.json`) — agent lifecycle, lastEventAt, lastError. Survives webmux restarts. Reconciliation reads it on startup; `ProjectRuntime` writes via the debounced `runtime-state-persistence` service. **Don't add new persisted state to in-memory only — it'll silently reset on every restart.**

### fetchConfig is per-project

Frontend must call `api.fetchConfig({ query: { projectId: currentProjectId } })`. The legacy unscoped form returns the *first* project's config and causes "Unknown profile: default" errors when the user switches projects. The App.svelte effect refetches on `currentProjectId` change.

### Worktree status comes from control-channel events, not the activity probe

For **worktrees**, `state.agent.lifecycle` is updated by `agent_status_changed` and `agent_stopped` events that the agent CLI hooks POST to `/api/runtime/events`. Hook commands are wired in `backend/src/adapters/agent-runtime.ts`. The activity probe is **only** for scratch + external sessions (no hooks available there). Don't replace the lifecycle pipeline with the probe.

### External tmux sessions are never chat-eligible

External (unmanaged) tmux sessions surfaced under "External tmux" are always shell-launched by definition. `supportsSessionChat` must return `false` for `selection.kind === "external"`. Don't try to detect `pane_current_command === "claude"` and promote them.

### Discriminated unions, narrow on `kind`

`AgentsUiConversationMessage` is a discriminated union: `kind: "user" | "assistant" | "tool" | "thinking"`. Don't reach for `role` — that field is gone. When adding new event types, extend the union and update both backend parsers (`claude-cli.ts`, `worktree-conversation-service.ts`) and the frontend renderer (`WorktreeConversationPanel.svelte`).

### Claude session parser walks every assistant record

`backend/src/adapters/claude-cli.ts` `buildClaudeSessionFromText` walks **all** `type: "assistant"` records, not just `stop_reason: "end_turn"`. Tool-use blocks live on intermediate records with `stop_reason: "tool_use"`. If you filter for `end_turn` only, tool/thinking events get silently dropped.

### Activity probe uses content-diff, not pane_last_activity

`tmux display-message -F '#{pane_last_activity}'` returns empty unless `monitor-activity` is enabled per-window — webmux doesn't enable that. The probe (`session-activity-service.ts`) caches a hash of `capture-pane` output and detects activity by diff. If you add new probe consumers, use the existing `summarizeSessionActivity` — don't reinvent.

### Polling settles only on `running=false` stable

`MobileChatSurface.svelte`'s refresh polling only stops once `running` flips to false for `REFRESH_POLL_SETTLE_TICKS` consecutive ticks. Don't add a settle path that fires while `running=true` — Claude has natural >3s silent pauses mid-turn.

### Default profile is agent-only

`DEFAULT_PANES` in `backend/src/adapters/config.ts` is just `[{ id: "agent", kind: "agent", focus: true }]` — no shell pane. Users override with `panes:` in their `.webmux.yaml` if they want one. Don't reintroduce the shell pane to the default.

### Yolo persistence

`WorktreeMeta.yolo` is the source of truth. `openWorktree` reads it; the create/edit dialogs write it. Surfaced as a chip on the sidebar row + topbar via `WorktreeSnapshot.yolo`. Don't introduce a parallel transient yolo flag — store on meta or pass per-call (like `--yolo` on `webmux open`).

### Claude session files rotate — always pick newest

A Claude `.jsonl` session in `~/.claude/projects/<encoded-cwd>/` is **not stable for a given cwd**. After `/quit` + resume (or some other CLI events), Claude writes to a new `<sessionId>.jsonl` even though the cwd is the same. `claude-conversation-service.ts` always picks `listSessions(cwd)[0]` (newest by `lastSeenAt`) and updates `meta.conversation.sessionId` if it rotated. Don't trust a saved sessionId without checking it's still the most recent — or you'll diverge from xterm reality.

### Ctrl-C interrupt doesn't fire Claude lifecycle hooks

The agent CLI hooks only fire on `UserPromptSubmit`, `PostToolUse`, `Stop`, and `Notification`. A `Ctrl-C` interrupt cancels Claude's operation but doesn't trigger any of these — so `state.agent.lifecycle` stays at whatever it was (usually `"running"`) forever. The interrupt API handler in `server.ts` must manually emit `applyEvent({ type: "agent_status_changed", lifecycle: "stopped", ... })` after sending Ctrl-C so the snapshot reflects reality.

### TmuxGateway stub obligation

Adding a method to the `TmuxGateway` interface requires updating **all** `FakeTmuxGateway` test classes — they live in several test files (`session-activity-service.test.ts`, `claude-conversation-service.test.ts`, `worktree-conversation-service.test.ts`, `lifecycle-service.test.ts`, `reconciliation-service.test.ts`, `worktree-storage.test.ts`, etc.). Search `class FakeTmuxGateway` and add a minimal stub. The TS compile error is loud but easy to miss if you only run a single test file.

### Auto-created `.webmux.yaml` should be gitignored by users

`ensureWebmuxYaml` writes `.webmux.yaml` when a project is added via "+ Project". This file is **personal config** (project name + display preferences), not committed config. Users who don't add it to `.gitignore` lose their config when reverting branches. The README documents this; future "+ Project" flows could append to `.gitignore` automatically (not done yet).

### `{@const}` placement in Svelte 5

`{@const}` cannot sit directly inside a `<li>`, `<tr>`, or other plain element — only inside `{#if}`, `{#each}`, `{#snippet}`, `{:else}`, etc. If you need a derived value scoped to a list item, either inline the function call at the use site or wrap with `{#if true}` (last resort).

## Debugging

When you are uncertain about the root cause of an issue, **add extensive debug logging before guessing at a fix**. This is mandatory, not optional.

### The rule

If you are not 100% sure where a bug comes from, do not propose a speculative fix. Instead:

1. **Add `console.log` / `console.debug` statements** at every relevant point in the code path — function entry/exit, variable values, branch decisions, API request/response payloads, WebSocket message contents.
2. **Log enough context** to pinpoint the problem: timestamps, identifiers (worktree name, session id), the actual values vs. what you expected.
3. **Run the code** with the logging in place and read the output.
4. **Only then** propose a fix based on what the logs reveal.
5. **Remove the debug logging** after the fix is confirmed.