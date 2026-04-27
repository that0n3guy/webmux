import type { TmuxSessionSummary } from "../adapters/tmux";
import type { ExternalTmuxSession } from "../domain/model";

const WEBMUX_SESSION_PREFIX = "wm-";

export function listExternalSessions(all: TmuxSessionSummary[]): ExternalTmuxSession[] {
  return all
    .filter((s) => !s.name.startsWith(WEBMUX_SESSION_PREFIX))
    .map((s) => ({ name: s.name, windowCount: s.windowCount, attached: s.attached }));
}
