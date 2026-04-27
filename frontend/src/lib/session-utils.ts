import type { ExternalTmuxSession, ScratchSessionSnapshot } from "./types";

export function sortByName<T extends { name?: string; displayName?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const an = a.displayName ?? a.name ?? "";
    const bn = b.displayName ?? b.name ?? "";
    return an.localeCompare(bn);
  });
}

export function attachedBadge(s: ExternalTmuxSession | ScratchSessionSnapshot): string {
  return s.attached ? "● connected" : "○ idle";
}
