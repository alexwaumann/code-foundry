import { sessionKey, terminalKey, type Row } from "@/lib/tree";
import type { Selection } from "@/stores/ui";

/**
 * Sidebar row key for a selection. Only threads and terminals have rows; projects,
 * worktrees, composers and pages are reached elsewhere (the Projects page, the nav
 * entries above the list).
 */
export function selectionKey(sel: Selection): string | null {
  switch (sel.kind) {
    case "terminal":
      return terminalKey(sel.id);
    case "session":
      return sessionKey(sel.id);
    default:
      return null;
  }
}

export function rowSelection(row: Row): Selection | null {
  switch (row.kind) {
    case "terminal":
      return { kind: "terminal", id: row.terminalId };
    case "session":
      return { kind: "session", id: row.sessionId };
    case "header":
      return null;
  }
}
