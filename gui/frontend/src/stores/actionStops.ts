/**
 * Action terminals the user pressed Stop on (GUI-only state; the daemon does not record
 * who killed a terminal). The status line reads "Stopping…" until the run exits, then
 * "Stopped" for a 129 (SIGHUP) or 137 (SIGKILL after the daemon's grace period) exit,
 * rather than a red "Exited with code N". See docs/notes/actions-2-gui.md.
 */
import { create } from "zustand";
import { useTerminalsStore } from "./terminals";

interface ActionStopsState {
  byId: Readonly<Record<string, true>>;
}

export const useActionStopsStore = create<ActionStopsState>(() => ({ byId: {} }));

/** Stop was pressed on `terminalId`. Ids of terminals that are gone are dropped meanwhile. */
export function markStopRequested(terminalId: string): void {
  const terms = useTerminalsStore.getState().byId;
  useActionStopsStore.setState((s) => {
    const byId: Record<string, true> = { [terminalId]: true };
    for (const id of Object.keys(s.byId)) if (id in terms) byId[id] = true;
    return { byId };
  });
}

/** The Stop did not go through (terminal.kill failed on a running terminal): back to Running. */
export function clearStopRequested(terminalId: string): void {
  useActionStopsStore.setState((s) => {
    if (!(terminalId in s.byId)) return s;
    const { [terminalId]: _gone, ...byId } = s.byId;
    return { byId };
  });
}

/** Whether Stop was pressed on `terminalId` (a primitive, for a narrow selector). */
export function useStopRequested(terminalId: string): boolean {
  return useActionStopsStore((s) => terminalId in s.byId);
}
