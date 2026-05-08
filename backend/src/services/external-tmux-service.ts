import { type TmuxGateway, type TmuxSessionSummary, WEBMUX_SESSION_PREFIX } from "../adapters/tmux";
import type { ExternalTmuxSession } from "../domain/model";
import { probeSessionActivity, summarizeSessionActivity } from "./session-activity-service";

export function listExternalSessions(
  all: TmuxSessionSummary[],
  tmux?: TmuxGateway,
  now?: () => Date,
): ExternalTmuxSession[] {
  const nowFn = now ?? (() => new Date());
  return all
    .filter((s) => !s.name.startsWith(WEBMUX_SESSION_PREFIX))
    .map((s): ExternalTmuxSession => {
      const base: ExternalTmuxSession = { name: s.name, windowCount: s.windowCount, attached: s.attached };
      if (!tmux) return base;
      try {
        const windowName = tmux.getFirstWindowName(s.name);
        if (!windowName) return base;
        const target = `${s.name}:${windowName}.0`;
        const probe = probeSessionActivity(tmux, target, undefined, nowFn);
        const { running, statusWord } = summarizeSessionActivity(probe, nowFn);
        return { ...base, agentStatus: running ? "running" : "idle", statusWord };
      } catch {
        return base;
      }
    });
}
