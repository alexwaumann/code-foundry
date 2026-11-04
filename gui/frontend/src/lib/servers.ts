/**
 * The thread info card's server rows (docs/notes/server-rollup.md): one flat list of what
 * listens on a port for a thread and the threads below it. A source is a background shell
 * (Thread.background_shells) or a running action run (ActionRun.ports), and belongs to its
 * owner, the thread it runs for. Pure; stores/servers.ts selects the inputs narrowly.
 */
import type { ActionRunView } from "@/api/actions";
import type { BackgroundShellView } from "@/api/threads";
import { subtreeIds, type LineageData } from "./lineage";

/** One thing that listens on ports, whichever kind. */
export interface ServerSource {
  /** Unique in the list: "shell:<owner>:<task>" or "run:<id>". */
  key: string;
  /** The thread it runs for. */
  ownerId: string;
  ports: readonly number[];
  command: string;
  startedAtMs: number | null;
  /** A shell's task id; "" for an action run. */
  taskId: string;
  /** A shell's description; "" for an action run. */
  description: string;
  /** An action run's id and action name; "" for a shell. */
  runId: string;
  actionName: string;
  /** A terminal run's terminal; "" for a shell or a background run. */
  terminalId: string;
}

/** The threads a card rolls up, itself first: its subtree, less the archived (their shells and runs are stopped). */
export function rollupThreadIds(data: LineageData, threadId: string): string[] {
  return subtreeIds(data, threadId).filter((id) => {
    const t = data.byId[id];
    return t !== undefined && t.archivedAtMs === null;
  });
}

export function shellSource(ownerId: string, shell: BackgroundShellView): ServerSource {
  return {
    key: `shell:${ownerId}:${shell.taskId}`,
    ownerId,
    ports: shell.ports,
    command: shell.command,
    startedAtMs: shell.startedAtMs,
    taskId: shell.taskId,
    description: shell.description,
    runId: "",
    actionName: "",
    terminalId: "",
  };
}

export function runSource(run: ActionRunView): ServerSource {
  return {
    key: `run:${run.id}`,
    ownerId: run.threadId,
    ports: run.ports,
    command: run.command,
    startedAtMs: run.startedAtMs,
    taskId: "",
    description: "",
    runId: run.id,
    actionName: run.actionName,
    terminalId: run.terminalId,
  };
}

/** Which source keeps a port two of them report: a run with a terminal (its row opens it), then any run, then a shell. */
function rank(s: ServerSource): number {
  return s.terminalId ? 0 : s.runId ? 1 : 2;
}

/**
 * The rows: thread by thread in `threadIds`' order, each thread's shells, then its runs, the
 * oldest run first. A port is listed once, on the source rank prefers (the first in the list
 * among equals), since `localhost:<port>` is the same place whoever reports it; a source left
 * without a port has no row. Its row comes back if the source that kept the port goes.
 */
export function serverRows(threadIds: readonly string[], shells: readonly ServerSource[], runs: readonly ServerSource[]): ServerSource[] {
  const started = (s: ServerSource) => s.startedAtMs ?? Number.MAX_SAFE_INTEGER;
  const byOwner = (list: readonly ServerSource[], id: string) => list.filter((s) => s.ownerId === id);
  const all = threadIds.flatMap((id) => [...byOwner(shells, id), ...byOwner(runs, id).sort((a, b) => started(a) - started(b) || a.runId.localeCompare(b.runId))]);
  const claimed = new Set<number>();
  const kept = new Map<string, number[]>();
  for (const s of [...all].sort((a, b) => rank(a) - rank(b))) {
    const free = [...new Set(s.ports)].filter((p) => !claimed.has(p));
    for (const p of free) claimed.add(p);
    kept.set(s.key, free);
  }
  return all.flatMap((s) => {
    const ports = kept.get(s.key) ?? [];
    return ports.length > 0 ? [{ ...s, ports }] : [];
  });
}

/** "Dev action"; a name that already says so is left as it is. */
function actionWords(name: string): string {
  return /\baction$/i.test(name) ? name : `${name} action`;
}

/**
 * Where a row's server comes from, its line 2's middle: the action and the thread below this
 * one that owns it, either or both ("Dev action · Serve the web preview"). `ownerName` is ""
 * for this thread's own. "" for this thread's own shell.
 */
export function serverSourceWords(actionName: string, ownerName: string): string {
  return [actionName ? actionWords(actionName) : "", ownerName].filter(Boolean).join(" · ");
}
