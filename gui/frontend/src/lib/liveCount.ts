/**
 * The sidebar row's live count (docs/notes/sidebar-live-count.md): the work a thread has
 * running beside its own turn, as one number, whatever started it. Background subagent
 * runs still running (Thread.background_agents_running: the thread's own, spawn depth 1;
 * a foreground run is the busy tool on line 3, not counted) plus its child threads that
 * are live (lineage state working or attention: a waiting child is working, lib/lineage
 * lineageStatus). Children are every thread it created (lib/lineage childIds), hidden ones
 * too, as the thread info card lists them; archived and snoozed ones are not live. The
 * row's Bot badge and the card's "Lineage · N running" read this one number. Pure.
 *
 * Not for restart or archive cut-offs: those read the daemon's own background counts
 * (lib/thread restartCutsOff), since children survive a restart and subagents do not.
 */
import type { ThreadView } from "@/api/threads";
import { lineageStatus, type LineageData } from "./lineage";
import { childRowState } from "./threadInfo";

/** Whether a child thread counts as live: a lineage row that is working or needs the user. */
export function isLiveChild(t: ThreadView | undefined): boolean {
  const state = childRowState(lineageStatus(t));
  return state === "working" || state === "attention";
}

/**
 * Each creator's children in spawn order (lib/lineage childIds for every thread at once),
 * built once per thread list: every sidebar row's selector runs on every list change, and
 * a scan of the list per row would be quadratic. Keyed on the list's own objects (the
 * store replaces them on change).
 */
let memo: { byId: LineageData["byId"]; order: LineageData["order"]; index: ReadonlyMap<string, readonly string[]> } | null = null;

function childIndex(data: LineageData): ReadonlyMap<string, readonly string[]> {
  if (memo?.byId === data.byId && memo.order === data.order) return memo.index;
  const index = new Map<string, string[]>();
  for (const id of data.order) {
    const by = data.byId[id]?.createdBy;
    if (!by || by === id) continue;
    const kids = index.get(by);
    if (kids) kids.push(id);
    else index.set(by, [id]);
  }
  memo = { byId: data.byId, order: data.order, index };
  return index;
}

/** How many of the thread's child threads are live (isLiveChild). */
export function liveChildCount(data: LineageData, id: string): number {
  if (!id) return 0;
  return (childIndex(data).get(id) ?? []).filter((c) => isLiveChild(data.byId[c])).length;
}

/** The thread's live count: background subagents running plus live child threads; 0 for an unknown thread. */
export function liveCount(data: LineageData, id: string): number {
  const t = data.byId[id];
  if (!t) return 0;
  return t.backgroundAgentsRunning + liveChildCount(data, id);
}
