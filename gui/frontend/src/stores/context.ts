import { useShallow } from "zustand/react/shallow";
import type { UiContextView } from "@/api/command";
import type { ThreadView } from "@/api/threads";
import { bandSortTimes, placeThread, type ListOptions, type ListThread, type WorktreeRef } from "@/lib/tree";
import { useProjectsStore, type ProjectsData } from "./projects";
import { getViewing, SUBAGENT_VIEW } from "./subagentView";
import { useThreadsStore, type ThreadsData } from "./threads";
import { inSidebar, type ThreadsById } from "@/lib/inSidebar";
import { isThreadGroup, threadGroup } from "@/lib/thread";
import { isNoProject } from "@/lib/threadRow";
import { PROJECT_LABEL, THREAD_LABEL, WORKTREE_LABEL } from "@/lib/termlabel";
import { quickTerminalOf } from "@/shell/quickTerminal";
import { useLayoutStore } from "./layout";
import { useTerminalsStore } from "./terminals";
import { keyboardElement, useUiStore, type Selection } from "./ui";

/** No thread, project, worktree or terminal: HOME's context (the composer on No project). */
export const emptyContext: UiContextView = {
  activeTerminalId: "",
  activeThreadId: "",
  activeProjectId: "",
  activeWorktreePath: "",
  activeView: "compose",
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

/**
 * Derives the UiContext the daemon sees from the current selection. A thread contributes
 * its place (project, worktree) and its workspace. The composer looks only at its project.
 * Actions on a worktree that is not selected (the Projects page) build their context with
 * worktreeContext / projectContext; the terminal the user is on is getUiContext's.
 */
export function deriveContext(sel: Selection, projects: ProjectsData, threads: ThreadsData = { byId: {}, order: [] }): UiContextView {
  switch (sel.kind) {
    // `none` shows HOME (App.tsx), whose context is emptyContext.
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
 * The terminal the user is on: the current space's focused tab when it shows a terminal, else
 * the quick terminal with the keyboard (keyboardElement: while the palette is open, the one that
 * had it when it opened). "" for none.
 */
export function activeTerminalId(): string {
  const s = useLayoutStore.getState();
  const pane = s.panes[s.spaces[s.currentSpaceId]?.focus ?? ""];
  const tab = pane ? s.tabs[pane.active] : undefined;
  if (tab?.kind === "terminal") return tab.params.terminal ?? "";
  const thread = keyboardElement()?.closest("[data-quick-terminal]")?.getAttribute("data-quick-terminal") ?? "";
  if (!thread) return "";
  const t = useTerminalsStore.getState();
  return quickTerminalOf(t.byId, t.order, thread)?.id ?? "";
}

/**
 * The window's context with the terminal the user is on (activeTerminalId): terminal commands act
 * on it. A shell of a worktree and no thread (a Projects page's) also brings its project and
 * worktree, so cmd+t starts another shell beside it.
 */
function withTerminal(ctx: UiContextView): UiContextView {
  const id = activeTerminalId();
  if (!id) return ctx;
  const labels = useTerminalsStore.getState().byId[id]?.labels ?? {};
  const project = labels[PROJECT_LABEL] ?? "";
  const worktree = labels[WORKTREE_LABEL] ?? "";
  if (!labels[THREAD_LABEL] && project && worktree) return { ...ctx, activeTerminalId: id, activeProjectId: project, activeWorktreePath: worktree };
  return { ...ctx, activeTerminalId: id };
}

/**
 * Current context, read imperatively (keybindings, invoke): the window's selection's with the
 * terminal the user is on, or an explicit selection's alone.
 */
export function getUiContext(sel?: Selection): UiContextView {
  if (sel !== undefined) return deriveContext(sel, useProjectsStore.getState(), useThreadsStore.getState());
  return withTerminal(deriveContext(useUiStore.getState().selection, useProjectsStore.getState(), useThreadsStore.getState()));
}

const SEP = "\u0001";

/**
 * One string per thread for the sidebar list: id + pin + group + archive time + snooze
 * end + hidden + its band's sort time (lib/tree.ts bandSortTimes: the status change for
 * attention and done, the last activity for idle). Name, model, a working thread's activity
 * and the status line's text don't rebuild the list; a question turning into a finished
 * turn, an idle thread starting work, a new prompt, archiving, snoozing, its creator
 * being removed (lib/inSidebar.ts) and their undoing do, since it moves. In the store's
 * order.
 */
export function useThreadListKeys(): string[] {
  return useThreadsStore(useShallow((s) => s.order.map((id) => encodeThreadListKey(id, s.byId[id], s.byId))));
}

/**
 * One thread's list key (useThreadListKeys); decodeThreadListKeys reads it back. `byId` is
 * the thread list the rule looks the creator up in (ThreadsData.byId).
 */
export function encodeThreadListKey(id: string, x: ThreadView | undefined, byId: ThreadsById): string {
  const ms = (v: number | null | undefined) => (v != null ? String(v) : "");
  const hidden = x !== undefined && !inSidebar(x, byId);
  const group = x ? threadGroup(x) : "idle";
  const times = x ? bandSortTimes({ ...x, group }) : { statusChangedAtMs: null, lastActivityAtMs: null };
  return [id, x?.pinned ? "1" : "", group, ms(x?.archivedAtMs), ms(x?.snoozedUntilMs), ms(x?.savedAtMs), hidden ? "1" : "", ms(times.statusChangedAtMs), ms(times.lastActivityAtMs)].join(SEP);
}

export function decodeThreadListKeys(keys: readonly string[]): ListThread[] {
  return keys.map((k) => {
    const [id = "", pinned = "", group = "", archived = "", snoozed = "", saved = "", hidden = "", statusChanged = "", lastActivity = ""] = k.split(SEP);
    return {
      id,
      pinned: pinned === "1",
      group: isThreadGroup(group) ? group : "idle",
      archivedAtMs: archived === "" ? null : Number(archived),
      snoozedUntilMs: snoozed === "" ? null : Number(snoozed),
      statusChangedAtMs: statusChanged === "" ? null : Number(statusChanged),
      lastActivityAtMs: lastActivity === "" ? null : Number(lastActivity),
      ...(saved === "" ? {} : { savedAtMs: Number(saved) }),
      ...(hidden === "1" ? { hidden: true } : {}),
    };
  });
}

/**
 * The sidebar list's threads read imperatively (cmd+1..9, cmd+shift+a): what its keys decode to
 * (encodeThreadListKey), so the keys walk the list in the order it is drawn.
 */
export function getListThreads(): ListThread[] {
  const s = useThreadsStore.getState();
  return decodeThreadListKeys(s.order.map((id) => encodeThreadListKey(id, s.byId[id], s.byId))).filter((t) => t.id in s.byId);
}

/** The sidebar list's display options read imperatively, so cmd+1..9 and cmd+shift+a see the rendered list. */
export function getListOptions(): ListOptions {
  const ui = useUiStore.getState();
  return {
    workingCollapsed: ui.workingCollapsed,
    snoozedCollapsed: ui.snoozedCollapsed,
    archivedCollapsed: ui.archivedCollapsed,
    openThreadId: ui.selection.kind === "thread" ? ui.selection.id : null,
  };
}
