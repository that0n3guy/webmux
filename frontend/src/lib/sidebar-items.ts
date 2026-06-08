import type { ExternalTmuxSession, ProjectInfo, ScratchSessionSnapshot } from "@webmux/api-contract";
import type { WorktreeListRow } from "./types";

export type SidebarItem =
  | { kind: "worktree"; id: string; projectId: string; projectLabel: string; active: boolean; row: WorktreeListRow }
  | { kind: "scratch"; id: string; projectId: string; projectLabel: string; active: boolean; scratch: ScratchSessionSnapshot }
  | { kind: "external"; id: string; projectId: null; projectLabel: null; active: boolean; session: ExternalTmuxSession };

export function worktreeSidebarId(projectId: string, branch: string): string {
  return `worktree:${projectId}:${branch}`;
}

export function scratchSidebarId(projectId: string, scratchId: string): string {
  return `scratch:${projectId}:${scratchId}`;
}

export function externalSidebarId(sessionName: string): string {
  return `external:${sessionName}`;
}

export interface BuildSidebarItemsInput {
  projects: ProjectInfo[];
  rowsByProject: Map<string, WorktreeListRow[]>;
  scratchByProject: Map<string, ScratchSessionSnapshot[]>;
  externalSessions: ExternalTmuxSession[];
}

export function buildSidebarItems(input: BuildSidebarItemsInput): SidebarItem[] {
  const items: SidebarItem[] = [];

  for (const project of input.projects) {
    const label = project.name || project.id;
    const rows = input.rowsByProject.get(project.id) ?? [];
    for (const row of rows) {
      items.push({
        kind: "worktree",
        id: worktreeSidebarId(project.id, row.worktree.branch),
        projectId: project.id,
        projectLabel: label,
        active: row.worktree.mux === "✓",
        row,
      });
    }
    const scratches = input.scratchByProject.get(project.id) ?? [];
    for (const scratch of scratches) {
      items.push({
        kind: "scratch",
        id: scratchSidebarId(project.id, scratch.id),
        projectId: project.id,
        projectLabel: label,
        active: true,
        scratch,
      });
    }
  }

  for (const session of input.externalSessions) {
    items.push({
      kind: "external",
      id: externalSidebarId(session.name),
      projectId: null,
      projectLabel: null,
      active: true,
      session,
    });
  }

  return items;
}

export function reconcileSidebarOrder(items: SidebarItem[], savedOrder: string[]): SidebarItem[] {
  const byId = new Map<string, SidebarItem>(items.map((item) => [item.id, item]));
  const result: SidebarItem[] = [];
  const placed = new Set<string>();

  for (const id of savedOrder) {
    const item = byId.get(id);
    if (item) {
      result.push(item);
      placed.add(id);
    }
  }

  for (const item of items) {
    if (!placed.has(item.id)) {
      result.push(item);
    }
  }

  return result;
}

export function splitSidebarItems(ordered: SidebarItem[]): { active: SidebarItem[]; inactive: SidebarItem[] } {
  const active: SidebarItem[] = [];
  const inactive: SidebarItem[] = [];
  for (const item of ordered) {
    if (item.active) {
      active.push(item);
    } else {
      inactive.push(item);
    }
  }
  return { active, inactive };
}

export function applyReorder(order: string[], draggedId: string, targetId: string): string[] {
  if (draggedId === targetId) return order;
  if (!order.includes(targetId)) return order;

  const without = order.filter((id) => id !== draggedId);
  const targetIdx = without.indexOf(targetId);
  without.splice(targetIdx, 0, draggedId);
  return without;
}
