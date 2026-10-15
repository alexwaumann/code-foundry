/**
 * Actions and their runs, fed by the shared events stream's `action` source
 * (stores/events.ts): a snapshot on every (re)connect, then updated / removed /
 * run_updated / run_removed. run_finished changes nothing here; stores/actionToasts.ts
 * reacts to it. Runs are what the daemon remembers (its newest 50 per project, never a
 * running one), without their output. See docs/notes/actions-2-gui.md.
 */
import { create } from "zustand";
import type { ActionEventView, ActionRunView, ActionView } from "@/api/actions";

export interface ActionsData {
  byId: Readonly<Record<string, ActionView>>;
  /** Each project's action ids in list order (position, then name). */
  byRepo: Readonly<Record<string, readonly string[]>>;
  runs: Readonly<Record<string, ActionRunView>>;
}

interface ActionsState extends ActionsData {
  /** A snapshot has arrived. */
  loaded: boolean;
}

export const emptyActions: ActionsData = { byId: {}, byRepo: {}, runs: {} };

const NONE: readonly string[] = [];

function repoOrder(byId: Readonly<Record<string, ActionView>>, repoId: string): string[] {
  return Object.values(byId)
    .filter((a) => a.repoId === repoId)
    .sort((a, b) => a.position - b.position || a.name.localeCompare(b.name) || a.id.localeCompare(b.id))
    .map((a) => a.id);
}

function sameIds(a: readonly string[] | undefined, b: readonly string[]): boolean {
  return a !== undefined && a.length === b.length && a.every((id, i) => id === b[i]);
}

/** byRepo with `repoId`'s list recomputed; the same object when its order did not change. */
function withRepo(prev: ActionsData["byRepo"], byId: Readonly<Record<string, ActionView>>, repoId: string): ActionsData["byRepo"] {
  const ids = repoOrder(byId, repoId);
  if (sameIds(prev[repoId], ids)) return prev;
  if (ids.length === 0) {
    const { [repoId]: _gone, ...rest } = prev;
    return rest;
  }
  return { ...prev, [repoId]: ids };
}

export function replaceActions(actions: readonly ActionView[], runs: readonly ActionRunView[]): ActionsData {
  const byId: Record<string, ActionView> = {};
  for (const a of actions) byId[a.id] = a;
  let byRepo: ActionsData["byRepo"] = {};
  for (const repoId of new Set(actions.map((a) => a.repoId))) byRepo = withRepo(byRepo, byId, repoId);
  const runsById: Record<string, ActionRunView> = {};
  for (const r of runs) runsById[r.id] = r;
  return { byId, byRepo, runs: runsById };
}

export function applyActionEvent(prev: ActionsData, ev: ActionEventView): ActionsData {
  switch (ev.kind) {
    case "snapshot":
      return replaceActions(ev.actions, ev.runs);
    case "updated": {
      const byId = { ...prev.byId, [ev.action.id]: ev.action };
      return { ...prev, byId, byRepo: withRepo(prev.byRepo, byId, ev.action.repoId) };
    }
    case "removed": {
      const gone = prev.byId[ev.id];
      if (!gone) return prev;
      const { [ev.id]: _removed, ...byId } = prev.byId;
      return { ...prev, byId, byRepo: withRepo(prev.byRepo, byId, gone.repoId) };
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
export function useRepoActionIds(repoId: string): readonly string[] {
  return useActionsStore((s) => s.byRepo[repoId] ?? NONE);
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
export function getRepoActionIds(repoId: string): readonly string[] {
  return useActionsStore.getState().byRepo[repoId] ?? NONE;
}
