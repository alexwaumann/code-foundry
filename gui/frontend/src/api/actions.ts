/**
 * Actions: per-project command lines run in a thread's (or a worktree's) bottom panel
 * (docs/notes/actions-1-daemon.md, actions-2-gui.md). View models for ActionService's
 * messages and the EventService action source; generated types stay inside src/api.
 */
import { timestampMs } from "@bufbuild/protobuf/wkt";
import {
  ActionIcon,
  ActionRunMode,
  ActionRunState,
  ActionRunTrigger,
  ActionService,
  type Action,
  type ActionEvent,
  type ActionRun,
  type ActionRunFinished,
} from "@/gen/codefoundry/v1/action_pb";
import { daemon, type DaemonConnection } from "./endpoint";

/** The six icons, in the editor's order; the names action.add/edit's --icon takes. */
export const ACTION_ICONS = ["play", "test", "lint", "configure", "build", "debug"] as const;
export type ActionIconName = (typeof ACTION_ICONS)[number];

export interface ActionView {
  /** "a-" + 12 hex digits. */
  id: string;
  repoId: string;
  name: string;
  command: string;
  icon: ActionIconName;
  /** Runs open as a terminal in the bottom panel (the GUI always runs them there). */
  inTerminal: boolean;
  /** Runs (in the background) when a new thread creates its worktree in the project. */
  onWorktreeCreate: boolean;
  /** 0-based order within the project. */
  position: number;
}

export type ActionRunModeView = "terminal" | "background" | "unknown";
export type ActionRunTriggerView = "user" | "worktree-create" | "unknown";

export interface ActionRunView {
  /** "r-" + 12 hex digits. */
  id: string;
  actionId: string;
  /** The action's name and command when the run started. */
  actionName: string;
  command: string;
  repoId: string;
  /** The owning thread; "" for a worktree's run. */
  sessionId: string;
  worktreePath: string;
  mode: ActionRunModeView;
  /** The terminal of a terminal run; "" otherwise. */
  terminalId: string;
  running: boolean;
  /** Valid once it is not running: 128+signal when a signal ended it, -1 when its terminal went first. */
  exitCode: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
  trigger: ActionRunTriggerView;
}

/** A run ended (once per run, after its last run_updated): what a toast needs. */
export interface ActionRunFinishedView {
  runId: string;
  actionId: string;
  actionName: string;
  repoId: string;
  sessionId: string;
  exitCode: number;
  mode: ActionRunModeView;
  trigger: ActionRunTriggerView;
  terminalId: string;
}

export type ActionEventView =
  | { kind: "snapshot"; actions: ActionView[]; runs: ActionRunView[] }
  | { kind: "updated"; action: ActionView }
  | { kind: "removed"; id: string }
  | { kind: "runUpdated"; run: ActionRunView }
  | { kind: "runRemoved"; id: string }
  | { kind: "runFinished"; finished: ActionRunFinishedView };

const iconNames: Record<ActionIcon, ActionIconName> = {
  [ActionIcon.UNSPECIFIED]: "play",
  [ActionIcon.PLAY]: "play",
  [ActionIcon.TEST]: "test",
  [ActionIcon.LINT]: "lint",
  [ActionIcon.CONFIGURE]: "configure",
  [ActionIcon.BUILD]: "build",
  [ActionIcon.DEBUG]: "debug",
};

const modeNames: Record<ActionRunMode, ActionRunModeView> = {
  [ActionRunMode.UNSPECIFIED]: "unknown",
  [ActionRunMode.TERMINAL]: "terminal",
  [ActionRunMode.BACKGROUND]: "background",
};

const triggerNames: Record<ActionRunTrigger, ActionRunTriggerView> = {
  [ActionRunTrigger.UNSPECIFIED]: "unknown",
  [ActionRunTrigger.USER]: "user",
  [ActionRunTrigger.WORKTREE_CREATE]: "worktree-create",
};

export function toActionView(a: Action): ActionView {
  return {
    id: a.id,
    repoId: a.repoId,
    name: a.name,
    command: a.command,
    icon: iconNames[a.icon],
    inTerminal: a.inTerminal,
    onWorktreeCreate: a.onWorktreeCreate,
    position: a.position,
  };
}

export function toActionRunView(r: ActionRun): ActionRunView {
  return {
    id: r.id,
    actionId: r.actionId,
    actionName: r.actionName,
    command: r.command,
    repoId: r.repoId,
    sessionId: r.threadId,
    worktreePath: r.worktreePath,
    mode: modeNames[r.mode],
    terminalId: r.terminalId,
    running: r.state === ActionRunState.RUNNING,
    exitCode: r.exitCode,
    startedAtMs: r.startedAt ? timestampMs(r.startedAt) : null,
    finishedAtMs: r.finishedAt ? timestampMs(r.finishedAt) : null,
    trigger: triggerNames[r.trigger],
  };
}

export function toActionRunFinishedView(f: ActionRunFinished): ActionRunFinishedView {
  return {
    runId: f.runId,
    actionId: f.actionId,
    actionName: f.actionName,
    repoId: f.repoId,
    sessionId: f.threadId,
    exitCode: f.exitCode,
    mode: modeNames[f.mode],
    trigger: triggerNames[f.trigger],
    terminalId: f.terminalId,
  };
}

export function toActionEventView(ev: ActionEvent): ActionEventView | null {
  const e = ev.event;
  switch (e.case) {
    case "snapshot":
      return { kind: "snapshot", actions: e.value.actions.map(toActionView), runs: e.value.runs.map(toActionRunView) };
    case "updated":
      return { kind: "updated", action: toActionView(e.value) };
    case "removedId":
      return { kind: "removed", id: e.value };
    case "runUpdated":
      return { kind: "runUpdated", run: toActionRunView(e.value) };
    case "runRemovedId":
      return { kind: "runRemoved", id: e.value };
    case "runFinished":
      return { kind: "runFinished", finished: toActionRunFinishedView(e.value) };
    default:
      return null;
  }
}

/** A run with its captured output (a background run's last 64 KiB). */
export interface ActionRunOutputView {
  run: ActionRunView;
  output: string;
  /** The output began earlier than what `output` holds. */
  truncated: boolean;
}

/** ActionService.GetRun: one run with its output so far (a read; runs start through action.run). */
export async function getActionRun(runId: string, conn: DaemonConnection = daemon, signal?: AbortSignal): Promise<ActionRunOutputView | null> {
  const c = await conn.client(ActionService);
  const res = await c.getRun({ runId }, { signal });
  if (!res.run) return null;
  return { run: toActionRunView(res.run), output: res.run.output, truncated: res.run.outputTruncated };
}

/**
 * The run in action.run's result JSON (the ActionRun, protojson): its id and terminal,
 * or null when the JSON holds no run.
 */
export function runFromResult(resultJson: string): { id: string; terminalId: string } | null {
  if (!resultJson) return null;
  try {
    const v = JSON.parse(resultJson) as { id?: unknown; terminalId?: unknown };
    if (typeof v.id !== "string" || !v.id) return null;
    return { id: v.id, terminalId: typeof v.terminalId === "string" ? v.terminalId : "" };
  } catch {
    return null;
  }
}
