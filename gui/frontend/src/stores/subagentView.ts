/**
 * The read-only subagent view's window state: which of the selected thread's own subagent
 * runs (spawn depth 1) the content pane shows instead of the thread's timeline. The
 * selection stays the thread (its sidebar row, its Watch, its side panel), so this is
 * extra UI state, `{ threadId, runId }`, dropped when the selection leaves the thread and
 * when the run leaves the thread's list (or turns out to be a nested one).
 *
 * Opened through thread.agent.open (stores/subagentActions.ts: the Agent rows' Open, the
 * strip's names, the Agents tab's rows; the daemon answers with UiIntent.ShowAgentRun,
 * which reaches every window like the CLI's), left through thread.agent.up (Escape, the
 * header's back button and crumb, the plate's Back; this window's own, presented locally
 * like view.panel.toggle, the CLI's through ShowView "agent.up").
 *
 * No command imports here: the command context (stores/context.ts) reads this store.
 */
import { create } from "zustand";
import { useShallow } from "zustand/react/shallow";
import { runItems } from "@/lib/subagentView";
import { timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "./thread";
import { useUiStore } from "./ui";

/** The active view the command context carries while a subagent shows (command.ViewSubagent). */
export const SUBAGENT_VIEW = "thread.agent";

export interface SubagentViewing {
  threadId: string;
  runId: string;
}

interface SubagentViewState {
  viewing: SubagentViewing | null;
  /** Incremented when a run opens, so the view takes the keyboard (Escape goes back up). */
  focusSeq: number;
}

export const useSubagentViewStore = create<SubagentViewState>()(() => ({ viewing: null, focusSeq: 0 }));

/** What this window shows, read imperatively (the command context, Escape). */
export function getViewing(): SubagentViewing | null {
  return useSubagentViewStore.getState().viewing;
}

/** The run the content pane shows for this thread, "" for the thread itself (narrow: a string). */
export function useViewingRun(threadId: string): string {
  return useSubagentViewStore((s) => (s.viewing?.threadId === threadId ? s.viewing.runId : ""));
}

/** Whether this run of this thread is the one on screen (the Agents tab's "viewing" row). */
export function useIsViewing(threadId: string, runId: string): boolean {
  return useSubagentViewStore((s) => s.viewing?.threadId === threadId && s.viewing.runId === runId);
}

/**
 * The run the content pane shows for this thread, "" for the thread itself: the viewing
 * state, while the thread's log (once it is here) still has the run as one of its own.
 */
export function useShownRun(threadId: string): string {
  const runId = useViewingRun(threadId);
  const ok = useThreadStore((s) => {
    const log = s.logs[threadId];
    if (!runId || !log) return true;
    const run = log.agents.find((r) => r.id === runId);
    return run !== undefined && run.spawnDepth <= 1;
  });
  return ok ? runId : "";
}

/**
 * The structural keys (lib/threadTimeline timelineKey) of a run's own items, the ones
 * whose parent is its Agent call (lib/subagentView runItems), in order. Shallow: text
 * deltas and the run's progress do not change it, a new item or a status change does.
 */
export function useRunTimelineKeys(threadId: string, toolUseId: string): string[] {
  return useThreadStore(
    useShallow((s) => {
      const log = s.logs[threadId];
      if (!log || !toolUseId) return NO_KEYS;
      const items = log.order.flatMap((id) => (log.byId[id] ? [log.byId[id]] : []));
      return runItems(items, toolUseId).map((it) => timelineKey(structOf(it)));
    }),
  );
}

const NO_KEYS: string[] = [];

/**
 * Shows a run of a thread (UiIntent.ShowAgentRun): selects the thread when another is
 * selected, then shows the run in its place. A run the thread's log does not have, or
 * that is not one of the thread's own, is refused (there is nothing to show for it).
 */
export function showAgentRun(threadId: string, runId: string): boolean {
  const log = useThreadStore.getState().logs[threadId];
  const run = log?.agents.find((r) => r.id === runId);
  // Before the thread's log is here (another thread was selected) the run is taken on
  // trust: the daemon checked it, and the log's arrival drops it if it is not there.
  if (log && (!run || run.spawnDepth > 1)) return false;
  const ui = useUiStore.getState();
  if (ui.selection.kind !== "thread" || ui.selection.id !== threadId) ui.select({ kind: "thread", id: threadId });
  useSubagentViewStore.setState((s) => ({ viewing: { threadId, runId }, focusSeq: s.focusSeq + 1 }));
  return true;
}

/**
 * thread.agent.up in this window: back to the parent thread, its prompt taking the
 * keyboard. False when no subagent shows.
 */
export function leaveSubagent(): boolean {
  if (getViewing() === null) return false;
  useSubagentViewStore.setState({ viewing: null });
  useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
  return true;
}

// Switching threads (or to a page) drops the view: it belongs to its thread.
useUiStore.subscribe((s, prev) => {
  if (s.selection === prev.selection) return;
  const v = getViewing();
  if (v && (s.selection.kind !== "thread" || s.selection.id !== v.threadId)) useSubagentViewStore.setState({ viewing: null });
});

// The run leaving the thread's list (once the list is there) drops the view, as does a
// run that turns out to be another run's (spawn depth 2 and up).
useThreadStore.subscribe((s, prev) => {
  const v = getViewing();
  if (!v || s.logs === prev.logs) return;
  const log = s.logs[v.threadId];
  if (!log) return;
  const run = log.agents.find((r) => r.id === v.runId);
  if (!run || run.spawnDepth > 1) useSubagentViewStore.setState({ viewing: null });
});
