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
