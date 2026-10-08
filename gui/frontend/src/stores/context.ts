import { useShallow } from "zustand/react/shallow";
import type { UiContextView } from "@/api/command";
import { placeTerminal, WORKTREE_LABEL, type PlaceableTerminal, type TreeRepo, type WorktreeRef } from "@/lib/tree";
import { useReposStore, type ReposData } from "./repos";
import { useTerminalsStore, type TerminalsData } from "./terminals";
import { useUiStore, type Selection } from "./ui";

export const emptyContext: UiContextView = {
  activeTerminalId: "",
  activeSessionId: "",
  activeRepoId: "",
  activeWorktreePath: "",
  activeView: "dashboard",
};

function allWorktrees(repos: ReposData): WorktreeRef[] {
  return repos.order.flatMap((id) => repos.byId[id]?.worktrees.map((w) => ({ repoId: id, path: w.path })) ?? []);
}

/**
 * Derives the UiContext the daemon sees from the current selection. A terminal's
 * repo/worktree come from the same placement the sidebar uses. Selecting a repo row
 * counts as looking at its main worktree.
 */
export function deriveContext(sel: Selection, terminals: TerminalsData, repos: ReposData): UiContextView {
  switch (sel.kind) {
    case "none":
      return emptyContext;
    case "terminal": {
      const t = terminals.byId[sel.id];
      const place = t ? placeTerminal({ cwd: t.cwd, worktreeLabel: t.labels[WORKTREE_LABEL] ?? "" }, allWorktrees(repos)) : null;
      return {
        ...emptyContext,
        activeTerminalId: sel.id,
        activeSessionId: t?.labels.session ?? "",
        activeRepoId: place?.repoId ?? "",
        activeWorktreePath: place?.path ?? "",
        activeView: "terminal",
      };
    }
    case "repo": {
      const repo = repos.byId[sel.repoId];
      const main = repo?.worktrees.find((w) => w.isMain)?.path ?? repo?.path ?? "";
      return { ...emptyContext, activeRepoId: sel.repoId, activeWorktreePath: main, activeView: "repo" };
    }
    case "worktree":
      return { ...emptyContext, activeRepoId: sel.repoId, activeWorktreePath: sel.path, activeView: "worktree" };
  }
}

export function contextKey(c: UiContextView): string {
  return [c.activeView, c.activeTerminalId, c.activeSessionId, c.activeRepoId, c.activeWorktreePath].join("\u0000");
}

/** Current context, read imperatively (keybindings, invoke). */
export function getUiContext(): UiContextView {
  return deriveContext(useUiStore.getState().selection, useTerminalsStore.getState(), useReposStore.getState());
}

const SEP = "\u0001";

/** One string per repo: id + worktree paths. Shallow-stable across unrelated updates. */
export function useRepoStructureKeys(): string[] {
  return useReposStore(useShallow((s) => s.order.map((id) => [id, ...(s.byId[id]?.worktrees.map((w) => w.path) ?? [])].join(SEP))));
}

/** One string per terminal: id + the inputs that decide where it sits in the tree. */
export function useTerminalPlacementKeys(): string[] {
  return useTerminalsStore(
    useShallow((s) =>
      s.order.map((id) => {
        const t = s.byId[id];
        return [id, t?.cwd ?? "", t?.labels[WORKTREE_LABEL] ?? ""].join(SEP);
      }),
    ),
  );
}

export function decodeRepoKeys(keys: readonly string[]): TreeRepo[] {
  return keys.map((k) => {
    const [id = "", ...worktreePaths] = k.split(SEP);
    return { id, worktreePaths };
  });
}

export function decodeTerminalKeys(keys: readonly string[]): PlaceableTerminal[] {
  return keys.map((k) => {
    const [id = "", cwd = "", worktreeLabel = ""] = k.split(SEP);
    return { id, cwd, worktreeLabel };
  });
}

/** Tree inputs read imperatively (cmd+1..9). */
export function getTreeInputs(): { repos: TreeRepo[]; terminals: PlaceableTerminal[] } {
  const r = useReposStore.getState();
  const t = useTerminalsStore.getState();
  return {
    repos: r.order.map((id) => ({ id, worktreePaths: r.byId[id]?.worktrees.map((w) => w.path) ?? [] })),
    terminals: t.order.map((id) => {
      const term = t.byId[id];
      return { id, cwd: term?.cwd ?? "", worktreeLabel: term?.labels[WORKTREE_LABEL] ?? "" };
    }),
  };
}
