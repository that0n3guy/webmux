import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentId, CustomAgentConfig } from "../domain/config";
import { parseCustomAgent } from "./config";
import { isRecord } from "../lib/type-guards";
import { log } from "../lib/log";

const PREFERENCES_SCHEMA_VERSION = 1;

export interface UserPreferencesAutoName {
  model?: string;
  systemPrompt?: string;
}

export interface UserPreferencesSidebar {
  mode?: "projects" | "active";
  itemOrder?: string[];
}

export interface UserPreferencesAccount {
  configDir: string;
}

export interface UserPreferences {
  schemaVersion: number;
  defaultAgent?: AgentId;
  defaultProfile?: string;
  agents?: Record<AgentId, CustomAgentConfig>;
  accounts?: Record<string, UserPreferencesAccount>;
  autoName?: UserPreferencesAutoName;
  sidebar?: UserPreferencesSidebar;
}

export interface UserPreferencesGateway {
  load(): Promise<UserPreferences>;
  save(prefs: UserPreferences): Promise<void>;
  path(): string;
}

export interface CreateUserPreferencesGatewayOptions {
  path?: string;
}

const DEFAULT_PREFERENCES_PATH = join(Bun.env.HOME ?? "/tmp", ".config", "webmux", "preferences.yaml");

export function emptyUserPreferences(): UserPreferences {
  return { schemaVersion: PREFERENCES_SCHEMA_VERSION };
}

export function applyPreferencesUpdate(
  current: UserPreferences,
  update: Omit<UserPreferences, "schemaVersion">,
): UserPreferences {
  return {
    ...current,
    schemaVersion: PREFERENCES_SCHEMA_VERSION,
    ...(update.defaultAgent !== undefined ? { defaultAgent: update.defaultAgent } : {}),
    ...(update.defaultProfile !== undefined ? { defaultProfile: update.defaultProfile } : {}),
    ...(update.agents !== undefined ? { agents: update.agents } : {}),
    ...(update.accounts !== undefined ? { accounts: update.accounts } : {}),
    ...(update.autoName !== undefined ? { autoName: update.autoName } : {}),
    ...(update.sidebar !== undefined ? { sidebar: update.sidebar } : {}),
  };
}

function parsePreferencesAutoName(raw: unknown): UserPreferencesAutoName | undefined {
  if (!isRecord(raw)) return undefined;

  const model = typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : undefined;
  const systemPrompt = typeof raw.systemPrompt === "string" && raw.systemPrompt.trim()
    ? raw.systemPrompt.trim()
    : undefined;

  if (model === undefined && systemPrompt === undefined) return undefined;

  return {
    ...(model !== undefined ? { model } : {}),
    ...(systemPrompt !== undefined ? { systemPrompt } : {}),
  };
}

function parsePreferencesSidebar(raw: unknown): UserPreferencesSidebar | undefined {
  if (!isRecord(raw)) return undefined;

  let mode: "projects" | "active" | undefined;
  if (raw.mode === "projects" || raw.mode === "active") {
    mode = raw.mode;
  } else if (raw.mode !== undefined) {
    log.warn(`[preferences] dropping unknown sidebar.mode: ${String(raw.mode)}`);
  }

  let itemOrder: string[] | undefined;
  if (Array.isArray(raw.itemOrder) && raw.itemOrder.every((v) => typeof v === "string")) {
    const trimmed = (raw.itemOrder as string[]).map((v) => v.trim()).filter((v) => v.length > 0);
    if (trimmed.length > 0) {
      itemOrder = trimmed;
    }
  } else if (raw.itemOrder !== undefined) {
    log.warn("[preferences] dropping malformed sidebar.itemOrder (expected string array)");
  }

  if (mode === undefined && itemOrder === undefined) return undefined;

  return {
    ...(mode !== undefined ? { mode } : {}),
    ...(itemOrder !== undefined ? { itemOrder } : {}),
  };
}

function parsePreferencesAgents(raw: unknown): Record<AgentId, CustomAgentConfig> | undefined {
  if (!isRecord(raw)) return undefined;

  const result: Record<AgentId, CustomAgentConfig> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (!id.trim()) continue;
    const parsed = parseCustomAgent(value);
    if (parsed) {
      result[id.trim()] = parsed;
    } else {
      log.warn(`[preferences] skipping malformed agent entry: ${id}`);
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

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

function parsePreferences(raw: unknown): UserPreferences {
  if (!isRecord(raw)) return emptyUserPreferences();

  const schemaVersion = typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
    ? raw.schemaVersion
    : PREFERENCES_SCHEMA_VERSION;

  const defaultAgent = typeof raw.defaultAgent === "string" && raw.defaultAgent.trim()
    ? raw.defaultAgent.trim()
    : undefined;

  const defaultProfile = typeof raw.defaultProfile === "string" && raw.defaultProfile.trim()
    ? raw.defaultProfile.trim()
    : undefined;

  const agents = parsePreferencesAgents(raw.agents);
  const accounts = parsePreferencesAccounts(raw.accounts);
  const autoName = parsePreferencesAutoName(raw.autoName);
  const sidebar = parsePreferencesSidebar(raw.sidebar);

  return {
    schemaVersion,
    ...(defaultAgent !== undefined ? { defaultAgent } : {}),
    ...(defaultProfile !== undefined ? { defaultProfile } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(accounts !== undefined ? { accounts } : {}),
    ...(autoName !== undefined ? { autoName } : {}),
    ...(sidebar !== undefined ? { sidebar } : {}),
  };
}

function buildSavePayload(prefs: UserPreferences): Record<string, unknown> {
  const payload: Record<string, unknown> = { schemaVersion: prefs.schemaVersion };

  if (prefs.defaultAgent !== undefined) {
    payload.defaultAgent = prefs.defaultAgent;
  }

  if (prefs.defaultProfile !== undefined) {
    payload.defaultProfile = prefs.defaultProfile;
  }

  if (prefs.agents !== undefined && Object.keys(prefs.agents).length > 0) {
    payload.agents = prefs.agents;
  }

  if (prefs.accounts !== undefined && Object.keys(prefs.accounts).length > 0) {
    payload.accounts = prefs.accounts;
  }

  if (prefs.autoName !== undefined) {
    const { model, systemPrompt } = prefs.autoName;
    if (model !== undefined || systemPrompt !== undefined) {
      payload.autoName = {
        ...(model !== undefined ? { model } : {}),
        ...(systemPrompt !== undefined ? { systemPrompt } : {}),
      };
    }
  }

  if (prefs.sidebar !== undefined) {
    const { mode, itemOrder } = prefs.sidebar;
    if (mode !== undefined || itemOrder !== undefined) {
      payload.sidebar = {
        ...(mode !== undefined ? { mode } : {}),
        ...(itemOrder !== undefined ? { itemOrder } : {}),
      };
    }
  }

  return payload;
}

export function createUserPreferencesGateway(
  opts: CreateUserPreferencesGatewayOptions = {},
): UserPreferencesGateway {
  const filePath = opts.path ?? DEFAULT_PREFERENCES_PATH;

  return {
    async load(): Promise<UserPreferences> {
      const file = Bun.file(filePath);
      const exists = await file.exists();
      if (!exists) return emptyUserPreferences();

      let text: string;
      try {
        text = await file.text();
      } catch (err) {
        log.warn(`[preferences] failed to read ${filePath}: ${err instanceof Error ? err.message : err}`);
        return emptyUserPreferences();
      }

      if (!text.trim()) return emptyUserPreferences();

      let parsed: unknown;
      try {
        parsed = parseYaml(text);
      } catch (err) {
        log.warn(`[preferences] failed to parse ${filePath}: ${err instanceof Error ? err.message : err}`);
        return emptyUserPreferences();
      }

      return parsePreferences(parsed);
    },

    async save(prefs: UserPreferences): Promise<void> {
      await mkdir(dirname(filePath), { recursive: true });
      const payload = buildSavePayload(prefs);
      await Bun.write(filePath, stringifyYaml(payload));
    },

    path(): string {
      return filePath;
    },
  };
}
