/**
 * The mock daemon's actions (mock/actions.ts) as view models, and fakes for the commands
 * that run and stop them, for component tests. code-foundry (repo-cf) has Dev, Test, Check,
 * Build, Install deps and Debug daemon; every other project has none. Pair with
 * src/test/daemonFakes.ts (the invocations) and src/test/projectsWorld.ts (the projects).
 *
 * A run's terminal arrives the way the daemon sends it, as a terminal event through
 * stores/events.ts (so the bottom panel opens on it), and leaves the same way.
 */
import { act } from "@testing-library/react";
import type { ActionIconName, ActionRunView, ActionView } from "@/api/actions";
import type { TerminalView } from "@/api/terminal";
import { dispatchEvent } from "@/stores/events";
import { useActionsStore } from "@/stores/actions";
import { useTerminalsStore } from "@/stores/terminals";
import { daemon } from "./daemonFakes";

export const ACTION_IDS = { dev: "a-dev000000000", test: "a-test00000000", check: "a-check0000000", build: "a-build0000000", install: "a-install00000", debug: "a-debug0000000" };
export const ACTION_NAMES = ["Dev", "Test", "Check", "Build", "Install deps", "Debug daemon"];

const seeds: [string, string, string, ActionIconName, boolean][] = [
  [ACTION_IDS.dev, "Dev", "pnpm dev", "play", false],
  [ACTION_IDS.test, "Test", "go test ./...", "test", false],
  [ACTION_IDS.check, "Check", "make check", "lint", false],
  [ACTION_IDS.build, "Build", "make build", "build", false],
  [ACTION_IDS.install, "Install deps", "pnpm install", "configure", true],
  [ACTION_IDS.debug, "Debug daemon", "make dev", "debug", false],
];

export function action(id: string, projectId: string, name: string, command: string, icon: ActionIconName = "play", o: Partial<ActionView> = {}): ActionView {
  return { id, projectId, name, command, icon, inTerminal: true, onWorktreeCreate: false, position: 0, ...o };
}

/** The mock's actions on code-foundry, no runs. */
export function seedActions(): void {
  const list = seeds.map(([id, name, command, icon, onCreate], i) => action(id, "repo-cf", name, command, icon, { onWorktreeCreate: onCreate, position: i }));
  act(() => {
    useActionsStore.setState({ byId: Object.fromEntries(list.map((a) => [a.id, a])), byProject: { "repo-cf": list.map((a) => a.id) }, runs: {}, loaded: true });
  });
}

/** Who a run is for: a thread, or a worktree of a project (the Projects page's runs). */
export type RunOwner = { threadId: string; projectId: string; worktree: string } | { threadId?: undefined; projectId: string; worktree: string };

let seq = 0;

/** The terminal of an action run, labelled as the daemon labels it. */
export function actionTerminal(id: string, a: ActionView, runId: string, owner: RunOwner, o: Partial<TerminalView> = {}): TerminalView {
  const labels: Record<string, string> = { kind: "action", project: owner.projectId, worktree: owner.worktree, action: a.id, "action.name": a.name, "action.run": runId };
  if (owner.threadId) labels.thread = owner.threadId;
  return { id, argv: ["/bin/zsh", "-lc", a.command], cwd: owner.worktree, cols: 80, rows: 24, title: "", state: "running", exitCode: 0, startedAtMs: Date.now(), exitedAtMs: null, altScreen: false, labels, ...o };
}

/** A terminal event, as the daemon sends one (stores/events.ts opens or hides panels). */
export function terminalUpdated(t: TerminalView): void {
  act(() => {
    dispatchEvent({ source: "terminal", event: { kind: "updated", terminal: t } });
  });
}

export function terminalRemoved(id: string): void {
  act(() => {
    dispatchEvent({ source: "terminal", event: { kind: "removed", id } });
  });
}

/** The terminal's process exited with `code` (the tab stays until it is closed). */
export function terminalExited(id: string, code: number, at = Date.now()): void {
  const t = useTerminalsStore.getState().byId[id];
  if (t) terminalUpdated({ ...t, state: "exited", exitCode: code, exitedAtMs: at });
}

/** The run of an action, as the action source's run_updated carries it. */
export function actionRun(id: string, a: ActionView, owner: RunOwner, terminalId: string, o: Partial<ActionRunView> = {}): ActionRunView {
  return { id, actionId: a.id, actionName: a.name, command: a.command, projectId: owner.projectId, threadId: owner.threadId ?? "", worktreePath: owner.worktree, mode: "terminal", terminalId, running: true, exitCode: 0, startedAtMs: Date.now(), finishedAtMs: null, trigger: "user", ...o };
}

/**
 * The daemon's action.run, terminal.kill and terminal.close: a run starts a terminal in its
 * owner's worktree (`worktreeOf` maps a thread to it) and answers with the run; a kill exits
 * it with 129 (SIGHUP), or `killCode`; a close removes it. Returns the ids of the runs'
 * terminals in order.
 */
export function fakeActionCommands(worktreeOf: (threadId: string) => { projectId: string; worktree: string }, o: { killCode?: number; killExits?: boolean } = {}): string[] {
  const started: string[] = [];
  daemon.handlers.set("action.run", (inv) => {
    const a = useActionsStore.getState().byId[inv.args.action ?? ""];
    if (!a) throw new Error(`no action ${inv.args.action ?? ""}`);
    const threadId = inv.context.activeThreadId;
    const owner: RunOwner = threadId ? { threadId, ...worktreeOf(threadId) } : { projectId: inv.context.activeProjectId, worktree: inv.context.activeWorktreePath };
    const n = String(++seq);
    const terminalId = `t-run-${n}`;
    const runId = `r-${n}`;
    act(() => {
      useActionsStore.setState((s) => ({ runs: { ...s.runs, [runId]: actionRun(runId, a, owner, terminalId) } }));
    });
    terminalUpdated(actionTerminal(terminalId, a, runId, owner));
    started.push(terminalId);
    return { message: "", resultJson: JSON.stringify({ id: runId, terminalId }) };
  });
  daemon.handlers.set("terminal.kill", (inv) => {
    if (o.killExits !== false) terminalExited(inv.args.id ?? "", o.killCode ?? 129);
    return { message: "", resultJson: "" };
  });
  daemon.handlers.set("terminal.close", (inv) => {
    terminalRemoved(inv.args.id ?? "");
    return { message: "", resultJson: "" };
  });
  return started;
}
