import { useShallow } from "zustand/react/shallow";
import type { UiContextView } from "@/api/command";
import { placeSession, type ListOptions, type ListSession, type TreeRepo, type WorktreeRef } from "@/lib/tree";
import { REPO_LABEL, WORKTREE_LABEL } from "@/lib/termlabel";
import { focusedBottomShell, ownerKeyOf, PROJECTS_KEY, useBottomStore } from "./bottomPanel";
import { useReposStore, type ReposData } from "./repos";
import { useSessionsStore, type SessionsData } from "./sessions";
import { isThreadGroup, threadGroup } from "@/lib/session";
import { useTerminalsStore } from "./terminals";
import { useUiStore, type Selection } from "./ui";

export const emptyContext: UiContextView = {
  activeTerminalId: "",
  activeSessionId: "",
  activeRepoId: "",
  activeWorktreePath: "",
  activeView: "dashboard",
  activeWorkspaceId: "",
  activeSessionRendered: false,
};

function allWorktrees(repos: ReposData): WorktreeRef[] {
  return repos.order.flatMap((id) => repos.byId[id]?.worktrees.map((w) => ({ repoId: id, path: w.path })) ?? []);
}

/** The context of an action on one worktree (the Projects page's rows, the panel's worktree tab): no selection involved. */
export function worktreeContext(repoId: string, path: string): UiContextView {
  return { ...emptyContext, activeRepoId: repoId, activeWorktreePath: path, activeView: "projects" };
}

/** The context of an action on one project (the Projects page's rows). */
export function repoContext(repoId: string): UiContextView {
  return { ...emptyContext, activeRepoId: repoId, activeView: "projects" };
}

/** A terminal as the command context needs it: its id and owner labels. */
export interface ContextShell {
  id: string;
  labels: Readonly<Record<string, string>>;
}

/**
 * The worktree a Projects-page shell belongs to (its repo and worktree labels); null for
 * any other terminal. Both the Projects page's "+" (bottomActions paneContext) and the
 * command context with the keyboard in that shell use it.
 */
export function projectsShellPlace(t: ContextShell | undefined): WorktreeRef | null {
  if (!t || ownerKeyOf(t) !== PROJECTS_KEY) return null;
  const repoId = t.labels[REPO_LABEL] ?? "";
  const path = t.labels[WORKTREE_LABEL] ?? "";
  return repoId && path ? { repoId, path } : null;
}

/**
 * Derives the UiContext the daemon sees from the current selection. A session contributes
 * its place (repo, worktree) and its attached terminal (if any), so terminal.* commands
 * apply to it. The composer looks only at its repo. Actions on a worktree that is not
 * selected (the Projects page, the panel's worktree tab) build their context with
 * worktreeContext / repoContext.
 */
export function deriveContext(sel: Selection, repos: ReposData, sessions: SessionsData = { byId: {}, order: [] }, focusedShell?: ContextShell): UiContextView {
  const ctx = deriveSelectionContext(sel, repos, sessions);
  if (!focusedShell) return ctx;
  // The keyboard is in a bottom panel shell (focusedBottomShell): terminal commands act on
  // it. On the Projects page, which carries no worktree, the shell's worktree is the
  // context too, so cmd+t (terminal.new) starts another shell beside it.
  const place = projectsShellPlace(focusedShell);
  return place
    ? { ...ctx, activeTerminalId: focusedShell.id, activeRepoId: place.repoId, activeWorktreePath: place.path }
    : { ...ctx, activeTerminalId: focusedShell.id };
}

function deriveSelectionContext(sel: Selection, repos: ReposData, sessions: SessionsData): UiContextView {
  switch (sel.kind) {
    case "none":
      return emptyContext;
    case "session": {
      const s = sessions.byId[sel.id];
      const place = s ? placeSession(s, allWorktrees(repos)) : null;
      return {
        ...emptyContext,
        activeSessionId: sel.id,
        activeTerminalId: s?.terminalId ?? "",
        activeRepoId: place?.repoId ?? s?.repoId ?? "",
        activeWorktreePath: place?.path ?? s?.worktreePath ?? "",
        activeView: "session",
        activeWorkspaceId: s?.workspaceId ?? "",
        activeSessionRendered: s?.render === "rendered",
      };
    }
    // The composer has no worktree yet (it may make one): only the repo, which is
    // what session.new needs to be available.
    case "compose":
      return { ...emptyContext, activeRepoId: sel.repoId, activeView: "compose", activeWorkspaceId: sel.workspaceId ?? "" };
    case "view":
      return { ...emptyContext, activeView: sel.name };
  }
}

export function contextKey(c: UiContextView): string {
  return [c.activeView, c.activeTerminalId, c.activeSessionId, c.activeRepoId, c.activeWorktreePath, c.activeWorkspaceId, c.activeSessionRendered ? "r" : ""].join("\u0000");
}

/**
 * Current context, read imperatively (keybindings, invoke). For the window's own
 * selection (no `sel`), a bottom panel shell with the keyboard (or the palette's return)
 * is the active terminal (and, on the Projects page, its worktree the active one). An explicit selection gets that selection's context only.
 */
export function getUiContext(sel?: Selection): UiContextView {
  const ui = useUiStore.getState();
  const terminals = useTerminalsStore.getState();
  const focused = sel === undefined ? focusedBottomShell(ui, terminals, useBottomStore.getState().byKey) : "";
  const shell = focused ? (terminals.byId[focused] ?? { id: focused, labels: {} }) : undefined;
  return deriveContext(sel ?? ui.selection, useReposStore.getState(), useSessionsStore.getState(), shell);
}

const SEP = "\u0001";

/** One string per repo: id + worktree paths. Shallow-stable across unrelated updates. */
export function useRepoStructureKeys(): string[] {
  return useReposStore(useShallow((s) => s.order.map((id) => [id, ...(s.byId[id]?.worktrees.map((w) => w.path) ?? [])].join(SEP))));
}

export function decodeRepoKeys(keys: readonly string[]): TreeRepo[] {
  return keys.map((k) => {
    const [id = "", ...worktreePaths] = k.split(SEP);
    return { id, worktreePaths };
  });
}

/**
 * One string per session for the sidebar list: id + pin + group (name, model, a different
 * dialog and the status line's text don't rebuild the list; a question turning into a
 * finished turn, or an idle thread starting work, does, since it moves). In the store's
 * order.
 */
export function useSessionListKeys(): string[] {
  return useSessionsStore(
    useShallow((s) =>
      s.order.map((id) => {
        const x = s.byId[id];
        return [id, x?.pinned ? "1" : "", x ? threadGroup(x) : "idle"].join(SEP);
      }),
    ),
  );
}

export function decodeSessionListKeys(keys: readonly string[]): ListSession[] {
  return keys.map((k) => {
    const [id = "", pinned = "", group = ""] = k.split(SEP);
    return { id, pinned: pinned === "1", group: isThreadGroup(group) ? group : "idle" };
  });
}

/** The sidebar list's threads read imperatively (cmd+1..9, cmd+shift+a). */
export function getListSessions(): ListSession[] {
  const s = useSessionsStore.getState();
  return s.order.flatMap((id) => {
    const x = s.byId[id];
    return x ? [{ id, pinned: x.pinned, group: threadGroup(x) }] : [];
  });
}

/** The sidebar list's display options read imperatively, so cmd+1..9 and cmd+shift+a see the rendered list. */
export function getListOptions(): ListOptions {
  return { workingCollapsed: useUiStore.getState().workingCollapsed };
}
