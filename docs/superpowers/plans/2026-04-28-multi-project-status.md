# Multi-Project Webmux — Status & Open Items

**Last updated:** 2026-04-28
**Branch:** `feat/non-worktree-sessions`
**Fork:** `https://github.com/that0n3guy/webmux` (remote `fork`)
**Latest commit:** `d3e1421`

## Where we are

The full plan in `2026-04-27-multi-project-webmux.md` (MP-1 through MP-19) is **shipped**. On top of that, ~10 follow-up fixes from live UX testing are also shipped. webmux is running as a **systemd user service** with `loginctl enable-linger` so it survives reboots.

### Test suites — all green
- backend: 274 / 0
- frontend: 66 / 0
- contract: 9 / 0
- bin: 78 / 0

### Service state
- Unit file: `~/.config/systemd/user/webmux.service`
- Listening on `:3100`, auto-restart on crash
- `WorkingDirectory=%h` (`$HOME`) — multi-project doesn't need a project-specific cwd; project list lives in `~/.config/webmux/projects.yaml`
- Cloudflare Tunnel route `paperclip.formup.cc → :3100` (via the permanent named tunnel) unchanged

### Operations
```bash
systemctl --user status webmux
systemctl --user restart webmux       # after rebuilds
journalctl --user -u webmux -f
# upgrade flow:
cd ~/projects/webmux && bun run build && systemctl --user restart webmux
```

## Commits since main (37 total)

The branch carries TWO features:
1. **Non-worktree sessions** (scratch + external tmux) — MP-0..13 of the prior plan
2. **Multi-project refactor** — MP-1..19 of this plan + UX polish

Both pushed to the fork. If shipping upstream, consider splitting into two PRs.

## UX polish shipped post-plan

- `e7b533d` — scratch session metadata persists via tmux user options (`@webmux-display-name`, `@webmux-kind`, `@webmux-agent-id`, `@webmux-created-at`)
- `7e4e4a6` — worktree row action menu uses `position: fixed` to escape sidebar scroll-clip
- `5ecc497` — `Btn` defaults `type="button"` so Enter doesn't trigger Cancel
- `4685f39` — `commonErrorResponses` includes 422 (git op failures)
- `d655502` — `git init` auto-runs on project add (non-git folders supported)
- `2efb1b7` — scratch sessions scoped per-project (`wm-scratch-<projectId>-<uuid>`); CreateWorktreeDialog surfaces backend errors
- `9db4d2e` — top sidebar header has `+ Project` and `+ New ▾` (Worktree | AI Session)
- `a4de393` — CreateScratchDialog has project selector when 2+ projects; project ⋯ menu uses fixed positioning
- `3aed114` — sidebar/window title simplified to plain "webmux"
- `f2af3b8` — Cmd+V / Ctrl+V / Ctrl+Shift+V block xterm's `\x16` emission and let browser native paste deliver text once
- `d3e1421` — `webmux serve` allows startup without cwd `.webmux.yaml` if the user-global registry has projects

## Open follow-ups (not shipped, may come up next)

### Real but deferred

- **"Open Worktree With Override" shipped** — strict boolean conflict guard, agentOverride+resume launch mode test, and updated test counts (backend 274, frontend 66, contract 9, bin 78).

1. **Per-project agent registry in CreateScratchDialog** — when user changes the project selector inside the AI Session dialog, `agentChoices` doesn't refetch. Currently uses the startup project's agent list. Low impact unless agents differ across projects, but the user may hit it.
2. **Project-aware notifications filtering** — `AppNotification` carries `projectId` (Phase 6) but the frontend doesn't filter the toast surface by current project. Notifications from inactive projects appear in the global toast stream.
3. **`fetchConfig` is single-project compat** — the `/api/config` endpoint serves the first registered project's config bundle. Fine for backwards-compat but doesn't reflect multi-project. Eventually want per-project config fetching.
4. **`/api/runtime/events`** — control-token events from in-worktree agents currently fall back to the first project if the event body lacks `projectId`. The lifecycle hooks should include `projectId` in events.
5. **Cross-project sidebar search** — the existing search bar still scopes to `currentProjectId`. Searching across all projects' worktrees would need a small rework of `rowsByProject`.
6. **Polling load** — `refreshAll` fans out 5s polls per project. With 3+ projects this is noticeable bandwidth/CPU. Mitigations: pause when document.hidden, longer interval for inactive projects.
7. **Adopt orphan worktrees** — if an agent runs `git worktree add` directly (bypassing webmux's API), the worktree is invisible to the dashboard. An "adopt" button or auto-discovery would surface them.
8. **CLI parity for project management** — `webmux project add|remove|list` doesn't exist yet. Project mgmt is dashboard-only. Plan calls this out as out-of-scope for the multi-project plan; would be a small follow-on.
9. **Project removal** — `ProjectScope.dispose()` is a placeholder no-op. Per-service shutdown (cancel polls, unsubscribe notifications) would be cleaner. Today, scope dropping relies on GC and the next process restart cleans up stale state.
10. **File browser for AddProjectDialog** — user explicitly skipped this. If they ever want to revisit: needs a backend `GET /api/fs/list?path=...` endpoint plus a small breadcrumb UI in the dialog.

### Documentation / spec drift

- `docs/superpowers/specs/2026-04-27-multi-project-webmux-design.md` got patched mid-execution with two corrections:
  - projectId length: 8 chars (not 12) to match existing tmux session naming
  - removed all references to `__global__` synthetic project (frontend-only concept; never on the wire)
- The plan doc `2026-04-27-multi-project-webmux.md` is faithful to what shipped. The status here supersedes it for follow-up tasks.

## Known limitations

1. **Existing `wm-scratch-<uuid>` sessions from before the per-project naming fix** are orphaned — no project's `scan()` adopts them. The user can clean up via `tmux kill-session` manually.
2. **Backend tests' baseline lifecycle test** (`LifecycleService > merges a clean worktree into main…`) was flaky in earlier runs but passes consistently now. If it fails on a fresh clone, ignore — it's a pre-existing baseline issue unrelated to this work.
3. **`bin/src/worktree-commands.ts` defaults the project to cwd-equivalent** — uses `createProjectScope` directly instead of going through the registry. If the user calls `webmux list` from a directory not registered, the CLI will see only that one cwd-derived project. Fine for typical workflows but doesn't reflect the registry. Future: add `--project <id|path>` flag with cwd-aware fallback (per spec section "CLI fallback").

## Where to resume

If a fresh session needs to pick up:

1. Read `docs/superpowers/specs/2026-04-27-multi-project-webmux-design.md` for the current architecture
2. Read this status doc for what's shipped and what's open
3. Use `git log fork/feat/non-worktree-sessions` for full commit history
4. Most likely next ask from the user: one of the deferred items above, or a new UX bug from continued usage

---

If the user opens a fresh session: webmux is **running, persistent, on the fork's `feat/non-worktree-sessions` branch at `d3e1421`**. The dashboard is at `paperclip.formup.cc`.
