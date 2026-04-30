import { mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { AgentId, CustomAgentConfig } from "../domain/config";
import { parseCustomAgent, parseCustomAgents } from "./config";
import { log } from "../lib/log";

const PREFERENCES_SCHEMA_VERSION = 1;

export interface UserPreferencesAutoName {
  model?: string;
  systemPrompt?: string;
}

export interface UserPreferences {
  schemaVersion: number;
  defaultAgent?: AgentId;
  agents?: Record<AgentId, CustomAgentConfig>;
  autoName?: UserPreferencesAutoName;
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
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

function parsePreferences(raw: unknown): UserPreferences {
  if (!isRecord(raw)) return emptyUserPreferences();

  const schemaVersion = typeof raw.schemaVersion === "number" && Number.isFinite(raw.schemaVersion)
    ? raw.schemaVersion
    : PREFERENCES_SCHEMA_VERSION;

  const defaultAgent = typeof raw.defaultAgent === "string" && raw.defaultAgent.trim()
    ? raw.defaultAgent.trim()
    : undefined;

  const agents = parsePreferencesAgents(raw.agents);
  const autoName = parsePreferencesAutoName(raw.autoName);

  return {
    schemaVersion,
    ...(defaultAgent !== undefined ? { defaultAgent } : {}),
    ...(agents !== undefined ? { agents } : {}),
    ...(autoName !== undefined ? { autoName } : {}),
  };
}

function buildSavePayload(prefs: UserPreferences): Record<string, unknown> {
  const payload: Record<string, unknown> = { schemaVersion: prefs.schemaVersion };

  if (prefs.defaultAgent !== undefined) {
    payload.defaultAgent = prefs.defaultAgent;
  }

  if (prefs.agents !== undefined && Object.keys(prefs.agents).length > 0) {
    payload.agents = prefs.agents;
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
      mkdirSync(dirname(filePath), { recursive: true });
      const payload = buildSavePayload(prefs);
      await Bun.write(filePath, stringifyYaml(payload));
    },

    path(): string {
      return filePath;
    },
  };
}
