import { type TmuxSessionSummary, WEBMUX_SESSION_PREFIX } from "../adapters/tmux";
import type { ExternalTmuxSession } from "../domain/model";

export function listExternalSessions(all: TmuxSessionSummary[]): ExternalTmuxSession[] {
  return all
    .filter((s) => !s.name.startsWith(WEBMUX_SESSION_PREFIX))
    .map((s) => ({ name: s.name, windowCount: s.windowCount, attached: s.attached }));
}
