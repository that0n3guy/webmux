# Session Chat — extend in-app chat + status to scratch and external tmux sessions

**Date:** 2026-04-28
**Branch:** `feat/non-worktree-sessions` (current)
**Author:** main thread

## Goal

In-app chat surface (today: `MobileChatSurface` + the desktop conversation panel) currently works only for **managed worktrees**. Extend it so it works for:

- Scratch sessions (`kind=scratch`, e.g. "+ New ▾ → AI Session")
- External tmux sessions ("unmanaged" tmux sessions webmux discovers)

…provided the session is running a Claude or Codex agent. Custom agents are out of scope (no `inAppChat` capability).

While we're touching the agent-status plumbing for these sessions, also fix the secondary bug: scratch + external sidebar entries always show `"idle"`. After this work they should show real status (working / waiting / done / error).

## Non-goals

- Custom-agent chat (still terminal-only).
- New chat for `unmanaged worktrees` (git worktrees webmux didn't create). User clarified "unmanaged" = external tmux only.
- New conversation persistence layer. Conversation **mapping** (which thread/session-id this tmux session is attached to) lives in tmux session options. Conversation **content** still lives in the agent's own files (Claude Code session files, codex-app-server thread storage).

## Current architecture (read first)

- `backend/src/services/worktree-conversation-service.ts` — owns the chat protocol. Today it stores the attached thread/session id in `WorktreeMeta.conversation` (a JSON file under the worktree's git dir).
- `backend/src/services/claude-conversation-service.ts` — same, for Claude.
- `backend/src/server.ts` — routes `/api/projects/:projectId/agents/worktrees/:name/{attach,history,messages,interrupt}` and the WS `streamAgentsWorktreeConversation`.
- `frontend/src/lib/api.ts` — wraps the above as `attachWorktreeConversation`, `fetchWorktreeConversationHistory`, `sendWorktreeConversationMessage`, `interruptWorktreeConversation`, `connectWorktreeConversationStream`.
- `frontend/src/lib/MobileChatSurface.svelte` + `WorktreeConversationPanel.svelte` — the UI. They take a `worktree: WorktreeInfo` prop and call the worktree-keyed API.
- Status pipeline: `reconciliation-service.ts` reads `WorktreeMeta` per worktree, polls tmux/git, builds `agentName` and lifecycle. Agent lifecycle changes are reported via the **control channel**: agent processes call back to webmux via `WEBMUX_CONTROL_URL` + `WEBMUX_WORKTREE_ID` (set in the worktree's `runtime.env`). Scratch/external sessions don't have that control env, so no lifecycle events arrive → snapshot defaults `agent.lifecycle = "closed"` → frontend renders `"idle"`.
- Scratch persistence: `backend/src/services/scratch-session-service.ts` already uses tmux session options (`@webmux-display-name`, `@webmux-kind`, `@webmux-agent-id`, `@webmux-created-at`) — pattern we'll reuse for the conversation mapping.

## Approach

**Persistence anchor:** tmux session options on the target session.
- For scratch sessions: target tmux session = the scratch session itself (`wm-scratch-<projectId>-<id>`).
- For external sessions: target tmux session = the external session by name. We set the same options on it the first time the user opens the chat.
- Options: `@webmux-conversation-provider` (`claudeCode` | `codexAppServer`), `@webmux-conversation-id`, `@webmux-conversation-cwd`, `@webmux-conversation-last-seen-at`.

This mirrors how scratch metadata already survives webmux restarts. No new disk storage.

**Identifier abstraction:** introduce a `SessionTarget` discriminated union:
```ts
type SessionTarget =
  | { kind: "worktree"; projectId: string; branch: string }
  | { kind: "scratch"; projectId: string; scratchId: string }
  | { kind: "external"; sessionName: string };
```
The conversation service operates on `SessionTarget` rather than raw branch names. For `kind: worktree`, behavior + storage stay identical to today (still writes `WorktreeMeta.conversation`) — no migration. For `kind: scratch | external`, mapping is read/written via tmux session options.

**Status pipeline:** add a lightweight status detector for non-worktree sessions:
- Approach A — control env (proper): set `WEBMUX_CONTROL_URL` + a synthetic `WEBMUX_SESSION_ID` for scratch sessions at create time. Map control events to scratch session id when posted. Lifecycle gets reported just like worktrees. **Won't work for external** (we don't launch the agent there).
- Approach B — tmux pane heuristic (universal): poll `display-message -p '#{pane_current_command}'` per session. If the command is the agent binary (`claude`, `codex`), and `pane_dead == 0`, bucket as `running`. We can't tell working vs waiting without protocol-level info, so for now report `running` ↔ `idle` based on whether last output changed within N seconds.
- **Pick B for scope simplicity, accept that scratch/external get a coarser working/idle distinction than worktrees.** Worktrees keep their richer lifecycle pipeline.

**No `--agent-only` in this plan** (separate small task; user didn't confirm).

## Tasks

### Task 0a — Mobile chat: stop / interrupt button

`frontend/src/lib/MobileChatSurface.svelte` only has Send. The backend already exposes `interruptWorktreeConversation` (and the panel uses it on desktop). Add a stop affordance: when a turn is `inProgress`/`active`/`running`/`pending`/`queued`, replace (or sit next to) the Send button with a Stop button that calls `interruptWorktreeConversation`. Match the desktop behavior.

### Task 0b — Mobile chat: live refresh

User reports the mobile chat doesn't update unless they navigate away and back. Investigate first (polling skipped on mobile? stream not subscribed? `{#key}` reset suppressing reactivity?), then fix root cause. Add debug logging in MobileChatSurface to confirm whether `connectWorktreeConversationStream` is firing on mobile and whether `applyConversationMessageDelta` is hit on incoming events. Remove debug logging once root-caused.

### Task 1 — Backend: lift conversation service to `SessionTarget`

**Files:**
- `backend/src/services/worktree-conversation-service.ts` → add a `SessionTarget`-keyed entry path. Keep existing worktree-keyed entry points working unchanged for callers we don't migrate.
- `backend/src/domain/agents-ui.ts` (or wherever conversation types live) → introduce `SessionTarget` union.
- New helper module `backend/src/services/session-conversation-storage.ts`:
  - `loadConversationMeta(target: SessionTarget): Promise<WorktreeConversationMeta | null>` — for worktree, reads `WorktreeMeta.conversation`. For scratch/external, reads from tmux session options.
  - `saveConversationMeta(target: SessionTarget, meta: WorktreeConversationMeta): Promise<void>` — symmetrical.
- `backend/src/adapters/tmux.ts` — already has `getSessionOption` / `setSessionOption`. No new methods needed.

**Constraint:** existing worktree behavior must not change (storage stays inside `WorktreeMeta.conversation`).

**Tests:**
- `worktree-conversation-service` existing tests still pass.
- New unit tests for `session-conversation-storage` covering worktree / scratch / external paths and returning `null` when no mapping exists.

### Task 2 — Backend: scratch + external chat routes

**Files:**
- `packages/api-contract/src/contract.ts` + `schemas.ts`: add new route paths:
  - `attachAgentsScratchConversation: "/api/projects/:projectId/scratch-sessions/:id/agent/attach"` (POST)
  - `fetchAgentsScratchConversationHistory: "/api/projects/:projectId/scratch-sessions/:id/agent/history"` (GET)
  - `sendAgentsScratchConversationMessage: "/api/projects/:projectId/scratch-sessions/:id/agent/messages"` (POST)
  - `interruptAgentsScratchConversation: "/api/projects/:projectId/scratch-sessions/:id/agent/interrupt"` (POST)
  - `streamAgentsScratchConversation: "/ws/projects/:projectId/scratch-sessions/:id/agent"` (WS)
  - Same five with `external-sessions/:name` instead of `scratch-sessions/:id`. (External sessions are not project-scoped today; see existing `apiPaths.fetchExternalSessions` for the path style — keep them at `/api/external-sessions/:name/agent/...`.)
- `backend/src/server.ts`: route handlers wired to the lifted conversation service. Each handler resolves a `SessionTarget`, validates the agent kind is claude/codex (404 otherwise), and forwards.
- For scratch: resolve target via `scope.scratchSessionService.getById(id)`. Fail 404 if not found or not an agent kind.
- For external: validate the tmux session exists, has a known agent process (use the activity detector from Task 4 to identify the binary), 404 otherwise.

**Tests:** route-level tests for happy path and 404 on missing session / wrong agent kind.

### Task 3 — Frontend: generalize chat surface to `SessionTarget`

**Files:**
- `frontend/src/lib/api.ts`: add new wrappers `attachScratchConversation`, etc., mirroring the worktree set. Or — preferred — refactor existing wrappers to take a `SessionTarget` and dispatch internally to the right path. Prefer the discriminated union.
- `frontend/src/lib/MobileChatSurface.svelte`: change prop from `worktree: WorktreeInfo` to `target: SessionTarget`. The UI body stays the same; only the API calls switch.
- Same refactor for `WorktreeConversationPanel.svelte` (used in `Terminal.svelte`).
- `frontend/src/App.svelte`:
  - Update `supportsWorktreeChat` → `supportsSessionChat(target)`. Returns true for worktree+claude/codex, scratch+claude/codex (look up agent capabilities), external+claude/codex (need agentId from session probe — see Task 4).
  - Update `showMobileChat` derivation to consume `selection` directly (not just worktree).
  - Pass `selection` (mapped to a `SessionTarget`) into `MobileChatSurface`.

**Tests:** existing frontend tests still pass; add a smoke test for scratch chat rendering when on a scratch+claude session.

### Task 4 — Backend: activity probe (Stop button + status badge + status word)

**Goal:** A single tmux-pane probe that drives three things at once:
1. The Stop / Interrupt button on the chat surface (replaces the hard-coded `running: false` for Claude in `claude-conversation-service.ts:80`).
2. The sidebar status badge for scratch + external sessions (today: forever-idle).
3. A best-effort "status word" surfaced in the chat header (Claude's animated gerund — "Pondering", "Cogitating" — extracted from the pane tail when available, otherwise omitted).

**Files:**
- New `backend/src/services/session-activity-service.ts`:
  - `probeSessionActivity(sessionName, windowName?, paneIndex?): { agentBinary: "claude" | "codex" | null; lastOutputAt: string | null; recentTailLines: string[] }` — uses tmux `display-message` + `capture-pane -p -S -<N>` to capture the last N lines of the agent pane.
  - `computeRunning(probe, now, opts?: { thresholdMs?: number }): boolean` — true if `lastOutputAt` is within threshold (default 2500ms).
  - `extractStatusWord(tailLines): string | null` — best-effort: scan for the Claude `✻ <Gerund>…` pattern (the `✻` symbol is unique enough to anchor on). If no match, return null. Conservative: prefer null over wrong word.
- Extend `WorktreeSnapshot` and `ScratchSessionSnapshot` with `agentStatus: "running" | "idle"` and optional `statusWord: string | null` fields. Same for `ExternalTmuxSession`.
- `backend/src/services/snapshot-service.ts`: build worktree status from existing lifecycle, fall back to / augment with probe when lifecycle is `closed`/missing.
- `backend/src/services/claude-conversation-service.ts`: replace `running: false` with computed value from the probe (worktree's agent pane). Also surface `statusWord` if available, otherwise null.
- `backend/src/services/scratch-session-service.ts` `buildSnapshot`: include `agentStatus` and `statusWord`.
- Same for whatever surfaces external tmux sessions (snapshot-service or a peer).
- `packages/api-contract/src/schemas.ts`: extend the relevant snapshot schemas additively.

**Constraints:**
- Probe is **read-only** — never modifies tmux state.
- `extractStatusWord` is best-effort. If Claude updates its CLI animation, we just stop showing it. Don't over-engineer.
- Don't replace Codex's existing `thread.status.type === "active"` running detection — augment it (OR with probe result) so codex-app-server downtime doesn't kill the indicator.

**Tests:**
- `session-activity-service.test.ts`: unit tests for `computeRunning` thresholds, `extractStatusWord` happy + negative paths, and the probe shape against a mocked TmuxGateway.
- Extend `claude-conversation-service.test.ts` to verify `running` reflects probe output instead of being hard-coded.

### Task 7 — Backend + frontend: surface tool use / thinking inline

**Goal:** The mobile chat (and desktop panel) currently show only `user`/`assistant` text. Surface tool calls, thinking, and tool results as inline truncated one-liners so the UI mirrors what the user sees in xterm.

**Files:**
- Shared types in `packages/api-contract/src/schemas.ts` + frontend `types.ts`:
  - Extend `AgentsUiConversationMessage` to a discriminated union: existing `user` / `assistant` plus new kinds:
    - `{ kind: "tool"; id; turnId; name: string; summary: string; status: "running" | "ok" | "error"; createdAt }`
    - `{ kind: "thinking"; id; turnId; text: string; createdAt }`
- `backend/src/adapters/claude-cli.ts`: stop collapsing content to text only. Walk content blocks of each stored message; emit a `ClaudeCliConversationEvent` (rename `ClaudeCliConversationMessage`) for each meaningful block. Existing user/assistant text events keep their shape; new tool/thinking events surface the rest.
- `backend/src/services/claude-conversation-service.ts`: forward the new event kinds in the conversation messages array.
- `backend/src/services/worktree-conversation-service.ts`: same treatment for codex thread items — emit `tool_use` / `thinking` items as `tool` / `thinking` events instead of skipping them.
- Frontend `WorktreeConversationPanel.svelte` (and through it, `MobileChatSurface.svelte`):
  - Render `tool` events as a single-line row: `▸ <name>` + truncated summary (e.g. `▸ Read frontend/src/.../MobileChatSurface.svelte`). Status icon for ok/error/running.
  - Render `thinking` events as a single muted italic line, max 1 line truncated.
  - Optional: tap-to-expand for full payload (skip in v1; just truncate).
  - Visually distinct from user/assistant bubbles (smaller, no avatar, lower contrast).

**Constraints:**
- Backward compatibility: existing tests asserting message shape may need updates. Discriminated union — narrow on `kind` everywhere.
- The `summary` for a `tool` event is the implementer's call: prefer the most identifying field for the tool (file path for Read/Edit/Write, command for Bash, etc.). Truncate at 80 chars.

**Tests:**
- Backend: parser tests on a fixture session with tool_use + thinking blocks.
- Frontend: smoke test in MobileChatSurface that tool events render with their name + summary.

### Task 5 — Frontend: status badge for scratch + external entries

**Files:**
- `frontend/src/lib/SessionList.svelte` (where the sidebar renders these): map `agentStatus` to the same visual treatment used for worktrees (small dot + label).
- Confirm the existing `mapAgentStatus` helper in `api.ts` handles the new statuses; extend if needed.

**Tests:** visual smoke test in the existing test file if one covers SessionList; otherwise rely on type checks.

### Task 6 — Tests + verification

- Backend: ≥ existing 274 + new tests pass.
- Contract: add tests for new schemas (≥ 9 + new).
- Bin: unchanged (CLI doesn't grow here).
- Frontend: existing 66 + smoke tests pass.
- Manual: open a scratch agent session on mobile → see chat surface, not xterm. Sidebar shows "running" while agent is working, "idle" once it stops. Same for an attached external tmux session.

## Risk register

- **Conversation persistence in tmux options edge cases**: tmux server restart wipes options. Acceptable — same as scratch metadata today. Worktree path unchanged.
- **External session "agent kind" detection**: only reliable while the binary is the foreground process in the agent pane. If user has piped/wrapped, we may miss. Acceptable for v1; expose a manual "this session uses agent X" override later if needed.
- **API contract churn**: 10 new endpoints (5 scratch + 5 external). Keep schema changes in `schemas.ts` purely additive — don't rename existing worktree types.
- **Custom-agent silence**: if a scratch session is launched with a custom agent, it falls through to xterm (no chat). Sidebar status detector still works for it (binary recognition only matches claude/codex; custom is "idle" still). Document this and move on.

## Acceptance

- All four test suites green after the implementation.
- Mobile users on a scratch AI session see the chat surface (Claude or Codex), can send messages and interrupt.
- Sidebar items for scratch and external sessions show real status (running/idle) instead of forever-idle.
- No regressions in the existing worktree chat or status pipeline.
