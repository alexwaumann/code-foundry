import { repoKey, terminalKey, worktreeKey, type Row } from "@/lib/tree";
import type { Selection } from "@/stores/ui";

/** Sidebar row key for a selection. */
export function selectionKey(sel: Selection): string | null {
  switch (sel.kind) {
    case "none":
      return null;
    case "terminal":
      return terminalKey(sel.id);
    case "repo":
      return repoKey(sel.repoId);
    case "worktree":
      return worktreeKey(sel.repoId, sel.path);
  }
}

export function rowSelection(row: Row): Selection | null {
  switch (row.kind) {
    case "terminal":
      return { kind: "terminal", id: row.terminalId };
    case "repo":
      return { kind: "repo", repoId: row.repoId };
    case "worktree":
      return { kind: "worktree", repoId: row.repoId, path: row.path };
    case "group":
      return null;
  }
}
