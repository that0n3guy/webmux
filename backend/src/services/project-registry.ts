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

interface RegistryFileEntry {
  id: string;
  path: string;
  addedAt: string;
}

interface RegistryFile {
  schemaVersion: number;
  projects: RegistryFileEntry[];
}

export interface ProjectRegistryDeps {
  registryPath?: string;
  port: number;
  git: BunGitGateway;
  tmux: BunTmuxGateway;
  docker: BunDockerGateway;
  portProbe: BunPortProbe;
  hooks: BunLifecycleHookRunner;
  autoName: AutoNameService;
  runtimeNotifications: NotificationService;
}

export interface AddProjectInput {
  path: string;
  displayName?: string;
  mainBranch?: string;
  defaultAgent?: string;
  worktreeRoot?: string;
}

export interface ProjectRegistry {
  load(): Promise<void>;
  add(input: AddProjectInput): Promise<ProjectInfo>;
  remove(id: string, opts: { killSessions: boolean }): Promise<void>;
  list(): ProjectInfo[];
  get(id: string): ProjectScope | null;
}

const DEFAULT_REGISTRY_PATH = join(Bun.env.HOME ?? "/tmp", ".config", "webmux", "projects.yaml");

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

  function ensureGitRepo(projectDir: string): void {
    if (existsSync(join(projectDir, ".git"))) return;
    const initResult = Bun.spawnSync(["git", "-C", projectDir, "init", "-q"], { stdout: "pipe", stderr: "pipe" });
    if (initResult.exitCode !== 0) {
      throw new Error(`git init failed for ${projectDir}: ${new TextDecoder().decode(initResult.stderr).trim()}`);
    }
    // Create an empty initial commit so the repo has HEAD; webmux's worktree flows
    // require at least one commit on the main branch.
    const commitResult = Bun.spawnSync(
      ["git", "-C", projectDir, "commit", "--allow-empty", "-q", "-m", "initial commit (auto-created by webmux)"],
      {
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...Bun.env,
          GIT_AUTHOR_NAME: Bun.env.GIT_AUTHOR_NAME ?? "webmux",
          GIT_AUTHOR_EMAIL: Bun.env.GIT_AUTHOR_EMAIL ?? "webmux@localhost",
          GIT_COMMITTER_NAME: Bun.env.GIT_COMMITTER_NAME ?? "webmux",
          GIT_COMMITTER_EMAIL: Bun.env.GIT_COMMITTER_EMAIL ?? "webmux@localhost",
        },
      }
    );
    if (commitResult.exitCode !== 0) {
      throw new Error(`git commit (initial) failed for ${projectDir}: ${new TextDecoder().decode(commitResult.stderr).trim()}`);
    }
  }

  function ensureWebmuxYaml(projectDir: string, init: AddProjectInput): void {
    const yamlPath = join(projectDir, ".webmux.yaml");
    if (existsSync(yamlPath)) return;
    const body: Record<string, unknown> = {
      name: init.displayName ?? projectDir.split("/").pop() ?? "project",
      workspace: {
        mainBranch: init.mainBranch ?? "main",
        defaultAgent: init.defaultAgent ?? "claude",
        worktreeRoot: init.worktreeRoot ?? "__worktrees",
      },
    };
    writeFileSync(yamlPath, stringifyYaml(body));
  }

  return {
    async load(): Promise<void> {
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

      if (!parsed || typeof parsed !== "object") return;
      const maybeProjects = (parsed as { projects?: unknown }).projects;
      if (!Array.isArray(maybeProjects)) return;

      for (const raw of maybeProjects) {
        if (!raw || typeof raw !== "object") {
          log.warn(`[project-registry] skipping malformed entry: ${JSON.stringify(raw)}`);
          continue;
        }
        const entry = raw as { id?: unknown; path?: unknown; addedAt?: unknown };
        if (typeof entry.id !== "string" || typeof entry.path !== "string" || typeof entry.addedAt !== "string") {
          log.warn(`[project-registry] skipping malformed entry: missing string fields`);
          continue;
        }
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

    async add(input: AddProjectInput): Promise<ProjectInfo> {
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
      ensureGitRepo(absPath);
      const scope = constructScope(absPath);
      scopes.set(scope.projectId, scope);
      meta.set(scope.projectId, { addedAt: new Date().toISOString() });
      persist();
      return buildInfo(scope);
    },

    async remove(id: string, opts: { killSessions: boolean }): Promise<void> {
      const scope = scopes.get(id);
      if (!scope) throw new Error(`Project not found: ${id}`);

      const scratchToKill = opts.killSessions
        ? scope.scratchSessionService.list().map((s) => s.sessionName)
        : [];

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

    list(): ProjectInfo[] {
      return [...scopes.values()].map(buildInfo);
    },

    get(id: string): ProjectScope | null {
      return scopes.get(id) ?? null;
    },
  };
}
