import { useShallow } from "zustand/react/shallow";
import type { UiContextView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { placeThread, type ListOptions, type ListThread, type TreeProject, type WorktreeRef } from "@/lib/tree";
import { PROJECT_LABEL, WORKTREE_LABEL } from "@/lib/termlabel";
import { focusedBottomShell, ownerKeyOf, PROJECTS_KEY, useBottomStore } from "./bottomPanel";
import { useProjectsStore, type ProjectsData } from "./projects";
import { getViewing, SUBAGENT_VIEW } from "./subagentView";
import { useThreadsStore, type ThreadsData } from "./threads";
import { inSidebar } from "@/lib/inSidebar";
import { isThreadGroup, threadGroup } from "@/lib/thread";
import { isNoProject } from "@/lib/threadRow";
import { useTerminalsStore } from "./terminals";
import { useUiStore, type Selection } from "./ui";

export const emptyContext: UiContextView = {
  activeTerminalId: "",
  activeThreadId: "",
  activeProjectId: "",
  activeWorktreePath: "",
  activeView: "dashboard",
  activeWorkspaceId: "",
};

function allWorktrees(projects: ProjectsData): WorktreeRef[] {
  return projects.order.flatMap((id) => projects.byId[id]?.worktrees.map((w) => ({ projectId: id, path: w.path })) ?? []);
}

/** The context of an action on one worktree (the Projects page's rows): no selection involved. */
export function worktreeContext(projectId: string, path: string): UiContextView {
  return { ...emptyContext, activeProjectId: projectId, activeWorktreePath: path, activeView: "projects" };
}

/** The context of an action on one project (the Projects page's rows). */
export function projectContext(projectId: string): UiContextView {
  return { ...emptyContext, activeProjectId: projectId, activeView: "projects" };
}

/** A terminal as the command context needs it: its id and owner labels. */
export interface ContextShell {
  id: string;
  labels: Readonly<Record<string, string>>;
}

/**
 * The worktree a Projects-page shell belongs to (its project and worktree labels); null for
 * any other terminal. Both the Projects page's "+" (bottomActions paneContext) and the
 * command context with the keyboard in that shell use it.
 */
export function projectsShellPlace(t: ContextShell | undefined): WorktreeRef | null {
  if (!t || ownerKeyOf(t) !== PROJECTS_KEY) return null;
  const projectId = t.labels[PROJECT_LABEL] ?? "";
  const path = t.labels[WORKTREE_LABEL] ?? "";
  return projectId && path ? { projectId, path } : null;
}

/**
 * Derives the UiContext the daemon sees from the current selection. A thread contributes
 * its place (project, worktree) and its workspace; a thread has no terminal of its own, so
 * activeTerminalId comes only from a focused bottom panel shell (focusedShell). The
 * composer looks only at its project. Actions on a worktree that is not
 * selected (the Projects page) build their context with
 * worktreeContext / projectContext.
 */
export function deriveContext(sel: Selection, projects: ProjectsData, threads: ThreadsData = { byId: {}, order: [] }, focusedShell?: ContextShell): UiContextView {
  const ctx = deriveSelectionContext(sel, projects, threads);
  if (!focusedShell) return ctx;
  // The keyboard is in a bottom panel shell (focusedBottomShell): terminal commands act on
  // it. On the Projects page, which carries no worktree, the shell's worktree is the
  // context too, so cmd+t (terminal.new) starts another shell beside it.
  const place = projectsShellPlace(focusedShell);
  return place
    ? { ...ctx, activeTerminalId: focusedShell.id, activeProjectId: place.projectId, activeWorktreePath: place.path }
    : { ...ctx, activeTerminalId: focusedShell.id };
}

function deriveSelectionContext(sel: Selection, projects: ProjectsData, threads: ThreadsData): UiContextView {
  switch (sel.kind) {
    case "none":
      return emptyContext;
    case "thread": {
      const s = threads.byId[sel.id];
      const place = s ? placeThread(s, allWorktrees(projects)) : null;
      // A thread without a project runs in home, which is no worktree: no project or
      // worktree in its context, so project-scoped commands (and thread.new without
      // no-project, which would refuse home) are not offered.
      const home = s !== undefined && isNoProject(s, projects);
      return {
        ...emptyContext,
        activeThreadId: sel.id,
        activeProjectId: place?.projectId ?? s?.projectId ?? "",
        activeWorktreePath: place?.path ?? (home ? "" : (s?.worktreePath ?? "")),
        // Showing one of its subagents (stores/subagentView.ts): thread.agent.up and its
        // Escape are offered there only.
        activeView: getViewing()?.threadId === sel.id ? SUBAGENT_VIEW : "thread",
        activeWorkspaceId: s?.workspaceId ?? "",
      };
    }
    // The composer has no worktree yet (it may make one): only the project, which is
    // what thread.new needs to be available. A composer without a project has no project
    // either (the daemon offers thread.new in the compose view for it).
    case "compose":
      return { ...emptyContext, activeProjectId: sel.projectId, activeView: "compose", activeWorkspaceId: sel.workspaceId ?? "" };
    case "view":
      return { ...emptyContext, activeView: sel.name };
  }
}

export function contextKey(c: UiContextView): string {
  return [c.activeView, c.activeTerminalId, c.activeThreadId, c.activeProjectId, c.activeWorktreePath, c.activeWorkspaceId].join("\u0000");
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
  return deriveContext(sel ?? ui.selection, useProjectsStore.getState(), useThreadsStore.getState(), shell);
}

const SEP = "\u0001";

/** One string per project: id + worktree paths. Shallow-stable across unrelated updates. */
export function useProjectStructureKeys(): string[] {
  return useProjectsStore(useShallow((s) => s.order.map((id) => [id, ...(s.byId[id]?.worktrees.map((w) => w.path) ?? [])].join(SEP))));
}

export function decodeProjectKeys(keys: readonly string[]): TreeProject[] {
  return keys.map((k) => {
    const [id = "", ...worktreePaths] = k.split(SEP);
    return { id, worktreePaths };
  });
}

/**
 * One string per thread for the sidebar list: id + pin + group + archive time + snooze
 * end + hidden (name, model, a different dialog and the status line's text don't rebuild
 * the list; a question turning into a finished turn, an idle thread starting work,
 * archiving, snoozing, showing or hiding it and their undoing does, since it moves). In
 * the store's order. `showCreated` is threads.show_created_threads
 * (useShowCreatedThreads): flipping it rebuilds the list.
 */
export function useThreadListKeys(showCreated: boolean): string[] {
  return useThreadsStore(useShallow((s) => s.order.map((id) => encodeThreadListKey(id, s.byId[id], showCreated))));
}

/** One thread's list key (useThreadListKeys); decodeThreadListKeys reads it back. */
export function encodeThreadListKey(id: string, x: ThreadView | undefined, showCreated: boolean): string {
  const ms = (v: number | null | undefined) => (v != null ? String(v) : "");
  const hidden = x !== undefined && !inSidebar(x, showCreated);
  return [id, x?.pinned ? "1" : "", x ? threadGroup(x) : "idle", ms(x?.archivedAtMs), ms(x?.snoozedUntilMs), hidden ? "1" : ""].join(SEP);
}

export function decodeThreadListKeys(keys: readonly string[]): ListThread[] {
  return keys.map((k) => {
    const [id = "", pinned = "", group = "", archived = "", snoozed = "", hidden = ""] = k.split(SEP);
    return {
      id,
      pinned: pinned === "1",
      group: isThreadGroup(group) ? group : "idle",
      archivedAtMs: archived === "" ? null : Number(archived),
      snoozedUntilMs: snoozed === "" ? null : Number(snoozed),
      ...(hidden === "1" ? { hidden: true } : {}),
    };
  });
}

/** The sidebar list's threads read imperatively (cmd+1..9, cmd+shift+a); `showCreated` as for useThreadListKeys. */
export function getListThreads(showCreated: boolean): ListThread[] {
  const s = useThreadsStore.getState();
  return s.order.flatMap((id) => {
    const x = s.byId[id];
    if (!x) return [];
    const t: ListThread = { id, pinned: x.pinned, group: threadGroup(x), archivedAtMs: x.archivedAtMs, snoozedUntilMs: x.snoozedUntilMs };
    return [inSidebar(x, showCreated) ? t : { ...t, hidden: true }];
  });
}

/** The sidebar list's display options read imperatively, so cmd+1..9 and cmd+shift+a see the rendered list. */
export function getListOptions(): ListOptions {
  const ui = useUiStore.getState();
  return { workingCollapsed: ui.workingCollapsed, snoozedCollapsed: ui.snoozedCollapsed, archivedCollapsed: ui.archivedCollapsed };
}
