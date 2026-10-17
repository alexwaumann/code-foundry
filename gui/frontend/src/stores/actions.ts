/**
 * Actions and their runs, fed by the shared events stream's `action` source
 * (stores/events.ts): a snapshot on every (re)connect, then updated / removed /
 * run_updated / run_removed. run_finished changes nothing here; stores/actionActions.ts
 * reacts to it. Runs are what the daemon remembers (its newest 50 per project, never a
 * running one), without their output. See docs/notes/actions-2-gui.md.
 */
import { create } from "zustand";
import type { ActionEventView, ActionRunView, ActionView } from "@/api/actions";

export interface ActionsData {
  byId: Readonly<Record<string, ActionView>>;
  /** Each project's action ids in list order (position, then name). */
  byProject: Readonly<Record<string, readonly string[]>>;
  runs: Readonly<Record<string, ActionRunView>>;
}

interface ActionsState extends ActionsData {
  /** A snapshot has arrived. */
  loaded: boolean;
}

export const emptyActions: ActionsData = { byId: {}, byProject: {}, runs: {} };

const NONE: readonly string[] = [];

function projectOrder(byId: Readonly<Record<string, ActionView>>, projectId: string): string[] {
  return Object.values(byId)
    .filter((a) => a.projectId === projectId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((a) => a.id);
}

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((id, i) => id === b[i]);
}

/** byProject with `projectId`'s list recomputed; the same object when its order did not change. */
function withProject(prev: ActionsData["byProject"], byId: Readonly<Record<string, ActionView>>, projectId: string): ActionsData["byProject"] {
  const ids = projectOrder(byId, projectId);
  if (sameIds(prev[projectId], ids)) return prev;
  if (ids.length === 0) {
    const { [projectId]: _gone, ...rest } = prev;
    return rest;
  }
  return { ...prev, [projectId]: ids };
}

export function replaceActions(actions: readonly ActionView[], runs: readonly ActionRunView[]): ActionsData {
  const byId: Record<string, ActionView> = {};
  for (const a of actions) byId[a.id] = a;
  let byProject: ActionsData["byProject"] = {};
  for (const projectId of new Set(actions.map((a) => a.projectId))) byProject = withProject(byProject, byId, projectId);
  const runsById: Record<string, ActionRunView> = {};
  for (const r of runs) runsById[r.id] = r;
  return { byId, byProject, runs: runsById };
}

export function applyActionEvent(prev: ActionsData, ev: ActionEventView): ActionsData {
  switch (ev.kind) {
    case "snapshot":
      return replaceActions(ev.actions, ev.runs);
    case "updated": {
      const byId = { ...prev.byId, [ev.action.id]: ev.action };
      return { ...prev, byId, byProject: withProject(prev.byProject, byId, ev.action.projectId) };
    }
    case "removed": {
      const gone = prev.byId[ev.id];
      if (!gone) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      return { ...prev, byId, byProject: withProject(prev.byProject, byId, gone.projectId) };
    }
    case "runUpdated":
      return { ...prev, runs: { ...prev.runs, [ev.run.id]: ev.run } };
    case "runRemoved": {
      if (!(ev.id in prev.runs)) return prev;
      const { [ev.id]: _removed, ...runs } = prev.runs;
      return { ...prev, runs };
    }
    case "runFinished":
      return prev;
  }
}

export const useActionsStore = create<ActionsState>()(() => ({ ...emptyActions, loaded: false }));

/** A project's action ids in list order (a stable empty list for none). */
export function useProjectActionIds(projectId: string): readonly string[] {
  return useActionsStore((s) => s.byProject[projectId] ?? NONE);
}

/** One action (a new object only when it changes), or undefined. */
export function useAction(id: string): ActionView | undefined {
  return useActionsStore((s) => s.byId[id]);
}

/** One run (a new object only when it changes), or undefined (not known, or forgotten). */
export function useActionRun(runId: string): ActionRunView | undefined {
  return useActionsStore((s) => (runId ? s.runs[runId] : undefined));
}

/** A project's action ids right now (read imperatively). */
export function getProjectActionIds(projectId: string): readonly string[] {
  return useActionsStore.getState().byProject[projectId] ?? NONE;
}
