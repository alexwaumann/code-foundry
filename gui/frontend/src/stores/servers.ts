/**
 * The thread info card's server rows (lib/servers, docs/notes/server-rollup.md): narrow
 * selectors over the thread list and the action runs, and what a row's click and its two
 * buttons do. Everything a row runs is a registry command (view.open.url, thread.shell.stop,
 * terminal.kill, action.stop, ui.focus.terminal).
 */
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import { rollupThreadIds, runSource, serverRows, shellSource, type ServerSource } from "@/lib/servers";
import { serverAddress } from "@/lib/threadInfo";
import { stopActionRun, stopBackgroundRun } from "./actionActions";
import { useActionsStore } from "./actions";
import { showTerminal } from "@/shell/terminalActions";
import { useTerminalsStore } from "./terminals";
import { openUrl } from "./gh";
import { stopShell } from "./threadActions";
import { useThreadsStore } from "./threads";

const decode = (s: string) => JSON.parse(s) as ServerSource;

/**
 * The card's server rows, its thread's and everything below it. Each list is encoded so an
 * update that leaves the servers alone (a status, a turn, a run without ports) re-renders
 * nothing; the walk reads lib/lineage childIndex, so it costs the subtree, not the thread list.
 */
export function useServerRows(threadId: string): readonly ServerSource[] {
  const ids = useThreadsStore(useShallow((s) => rollupThreadIds(s, threadId)));
  const shells = useThreadsStore(
    useShallow((s) =>
      ids.flatMap((id) => (s.byId[id]?.backgroundShells ?? []).filter((b) => b.ports.length > 0).map((b) => JSON.stringify(shellSource(id, b)))),
    ),
  );
  const runs = useActionsStore(
    useShallow((s) =>
      Object.values(s.runs)
        .filter((r) => r.running && r.ports.length > 0 && ids.includes(r.threadId))
        .map((r) => JSON.stringify(runSource(r))),
    ),
  );
  return useMemo(() => serverRows(ids, shells.map(decode), runs.map(decode)), [ids, shells, runs]);
}

/** Opens the server's first port in the browser. */
export function openServerInBrowser(s: ServerSource): void {
  void openUrl(`http://${serverAddress(s.ports[0] ?? 0)}`);
}

/**
 * A row's click on a thread's card: a server with a terminal shows its tab, focused (opened by
 * the placement rules when it has none), whoever owns it; any other opens the browser.
 */
export function openServer(s: ServerSource): void {
  if (s.terminalId && s.terminalId in useTerminalsStore.getState().byId) {
    void showTerminal(s.terminalId);
    return;
  }
  openServerInBrowser(s);
}

/**
 * Stops what serves the row: a shell through its owner, a run through its action stop. True
 * when the stop went through; the row leaves once the shell or run ends. That says nothing
 * of the port: a child that left the process group outlives the stop (docs/notes/action-run-ports.md).
 */
export function stopServer(s: ServerSource): Promise<boolean> {
  if (s.taskId) return stopShell(s.ownerId, s.taskId);
  return s.terminalId ? stopActionRun(s.terminalId) : stopBackgroundRun(s.runId);
}
