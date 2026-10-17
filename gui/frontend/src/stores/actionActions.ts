/**
 * What the GUI does with actions, always through the registry so the palette and the CLI
 * stay the one surface: action.run (a thread's header menu, a Projects row's menu, Rerun),
 * action.add / action.edit / action.remove (the editor), terminal.kill (Stop) and
 * terminal.close (closing a finished run's tab, Rerun). Plus the toast for a failed
 * worktree-create run. See docs/notes/actions-2-gui.md.
 */
import { toast } from "sonner";
import { runFromResult, type ActionRunFinishedView } from "@/api/actions";
import { invokeCommand, type UiContextView } from "@/api/command";
import { errorMessage } from "@/api/stream";
import { addArgs, editArgs, refusalText, type ActionDraft } from "@/lib/actions";
import { ACTION_LABEL, REPO_LABEL, THREAD_LABEL, WORKTREE_LABEL } from "@/lib/termlabel";
import { useActionsStore } from "./actions";
import { openActionRunOutput } from "./actionDialog";
import { clearStopRequested, markStopRequested } from "./actionStops";
import { closeBottomTerminal, revealShell, showOwnTerminal } from "./bottomActions";
import { refreshCommands, runCommandForResult, useCommandsStore } from "./commands";
import { getUiContext, repoContext, worktreeContext } from "./context";
import { useThreadsStore } from "./threads";
import { useTerminalsStore } from "./terminals";
import { useUiStore } from "./ui";

/** Who a run belongs to: a thread (its bottom panel) or a worktree (the Projects page's panel). */
export type ActionOwner = { kind: "thread"; threadId: string } | { kind: "worktree"; repoId: string; path: string };

/** The command context a run for `owner` is started in (action.run takes its owner from it). */
export function ownerContext(owner: ActionOwner): UiContextView {
  return owner.kind === "thread" ? getUiContext({ kind: "thread", id: owner.threadId }) : worktreeContext(owner.repoId, owner.path);
}

/**
 * action.run for `owner`, always in a terminal (--terminal: the GUI shows every run as a
 * tab; an action an agent made a background one still opens here). The new tab opens in
 * the owner's panel, active, and takes the keyboard when that panel is on screen. Quiet:
 * the tab is the feedback (a failure toasts). Resolves to the run's terminal id, or null.
 */
export async function runAction(actionId: string, owner: ActionOwner): Promise<string | null> {
  const res = await runCommandForResult("action.run", { action: actionId, terminal: "true" }, { ctx: ownerContext(owner), quiet: true });
  const run = res === null ? null : runFromResult(res.resultJson);
  if (!run?.terminalId) return null;
  showOwnTerminal(run.terminalId);
  return run.terminalId;
}

/** The owner an action run's terminal belongs to, from its labels; null when it is not one. */
export function ownerOfTerminal(labels: Readonly<Record<string, string>>): ActionOwner | null {
  const thread = labels[THREAD_LABEL];
  if (thread) return { kind: "thread", threadId: thread };
  const repoId = labels[REPO_LABEL] ?? "";
  const path = labels[WORKTREE_LABEL] ?? "";
  return repoId && path ? { kind: "worktree", repoId, path } : null;
}

/**
 * Stop: terminal.kill for a running action's terminal. The tab reads "Stopping…" until the
 * run exits (SIGHUP, then SIGKILL after the daemon's grace period when the command ignores
 * it), then "Stopped" with Rerun; the tab stays. The button is the confirmation, so the
 * command runs confirmed. A kill that fails on a running terminal goes back to Running.
 */
export async function stopActionRun(terminalId: string): Promise<void> {
  const ctx: UiContextView = { ...getUiContext(), activeTerminalId: terminalId };
  markStopRequested(terminalId);
  try {
    await invokeCommand("terminal.kill", ctx, { id: terminalId }, undefined, { confirmed: true });
  } catch (err) {
    if (useTerminalsStore.getState().byId[terminalId]?.state === "exited") return;
    clearStopRequested(terminalId);
    const title = useCommandsStore.getState().commands.find((c) => c.name === "terminal.kill")?.title ?? "Kill Terminal";
    toast.error(`${title} failed`, { description: errorMessage(err) });
  } finally {
    void refreshCommands();
  }
}

/** Tabs whose Rerun is in flight: the button stays until the old tab closes, so a double click must not run twice. */
const rerunning = new Set<string>();

/**
 * Rerun: the same action again for the same owner (a terminal runs one process, so there
 * is no restart in place), then the old tab closes. Run first: if the run fails (the action
 * was deleted meanwhile), the old tab and its output stay. The new tab is active. A second
 * Rerun of the same tab while one is in flight does nothing.
 */
export async function rerunAction(terminalId: string): Promise<string | null> {
  const t = useTerminalsStore.getState().byId[terminalId];
  const actionId = t?.labels[ACTION_LABEL] ?? "";
  const owner = t ? ownerOfTerminal(t.labels) : null;
  if (!actionId || owner === null || rerunning.has(terminalId)) return null;
  rerunning.add(terminalId);
  try {
    const id = await runAction(actionId, owner);
    if (id !== null) await closeBottomTerminal(terminalId);
    return id;
  } finally {
    rerunning.delete(terminalId);
  }
}

/**
 * Save in the editor: action.add for a new action of `repoId`, action.edit (changed
 * fields only) for an existing one. Resolves to null on success (also when nothing
 * changed) or the daemon's refusal, which the editor shows in place (no toast).
 */
export async function saveAction(target: { repoId: string; actionId?: string }, draft: ActionDraft): Promise<string | null> {
  let args: Record<string, string> | null;
  let name: string;
  if (target.actionId === undefined) {
    name = "action.add";
    args = addArgs(target.repoId, draft);
  } else {
    const a = useActionsStore.getState().byId[target.actionId];
    if (!a) return "This action was deleted meanwhile.";
    name = "action.edit";
    args = editArgs(a, draft);
    if (args === null) return null;
  }
  const failed = { message: "Could not save the action." };
  const res = await runCommandForResult(name, args, {
    ctx: repoContext(target.repoId),
    quiet: true,
    onError: (m) => {
      failed.message = refusalText(m);
    },
    expected: () => true,
  });
  return res === null ? failed.message : null;
}

/** Delete in the editor: action.remove. Resolves to null, or the daemon's refusal. */
export async function deleteAction(actionId: string, repoId: string): Promise<string | null> {
  const failed = { message: "Could not delete the action." };
  const res = await runCommandForResult("action.remove", { action: actionId, repo: repoId }, {
    ctx: repoContext(repoId),
    quiet: true,
    onError: (m) => {
      failed.message = refusalText(m);
    },
    expected: () => true,
  });
  return res === null ? failed.message : null;
}

/** The failed setup run's toast text. */
export function setupFailedMessage(f: Pick<ActionRunFinishedView, "actionName" | "exitCode">): string {
  return `Setup action ${f.actionName} failed (exit ${String(f.exitCode)})`;
}

/**
 * A failed worktree-create run's Open: select its thread, then its tab when the run had a
 * terminal, else (the daemon runs setup in the background) its captured output.
 */
export function openFailedRun(f: Pick<ActionRunFinishedView, "runId" | "threadId" | "terminalId" | "actionName">): void {
  if (f.terminalId && revealShell(f.terminalId)) return;
  if (f.threadId && f.threadId in useThreadsStore.getState().byId) useUiStore.getState().select({ kind: "thread", id: f.threadId });
  openActionRunOutput(f.runId, f.actionName);
}

/**
 * run_finished (stores/events.ts): a worktree-create action that exited non-zero toasts
 * "Setup action X failed (exit N)" with Open. Other runs finish quietly (their tab shows it).
 * The toast stays until dismissed (× or Open), like a failed git op's: setup runs in the
 * background with no tab, so it is the only sign the run failed.
 */
export function onActionRunFinished(f: ActionRunFinishedView): void {
  if (f.trigger !== "worktree-create" || f.exitCode === 0) return;
  toast.error(setupFailedMessage(f), {
    id: `action-run-${f.runId}`,
    duration: Infinity,
    closeButton: true,
    action: {
      label: "Open",
      onClick: () => {
        openFailedRun(f);
      },
    },
  });
}
