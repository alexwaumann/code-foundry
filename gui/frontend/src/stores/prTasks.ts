/**
 * The readiness box's thread tasks (pr.task, internal/command/commands_prtask.go): hands
 * one of a pull request's issues to a thread, sent into it (--thread, mid-turn like any
 * send) or to a new thread on the head branch that the daemon starts and focuses. One run
 * per pull request and kind at a time; the row's button shows it (`running`).
 * docs/notes/pr-panel-tasks.md.
 */
import { toast } from "sonner";
import { create } from "zustand";
import type { TaskKind } from "@/components/pr/readiness";
import { prTaskArgs, type TaskTarget } from "@/components/pr/taskRouting";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { runCommandForResult } from "./commands";
import { pullRequestKey } from "./gh";
import { openStartedThread } from "./prThreads";
import { useUiStore } from "./ui";

interface PrTasksState {
  /** taskKey(ref, kind) → pr.task is in flight for it. */
  running: Readonly<Record<string, boolean>>;
}

export const usePrTasksStore = create<PrTasksState>()(() => ({ running: {} }));

export const taskKey = (ref: PrRef, kind: TaskKind): string => `${pullRequestKey(ref.slug, ref.number)}\u0000${kind}`;

/** The thread pr.task's result JSON names (PRTaskResult.threadId, empty when none) and whether the task was sent into it. */
export function parseTaskResult(resultJson: string): { threadId: string; sent: boolean } {
  try {
    const v = JSON.parse(resultJson) as { threadId?: unknown; sent?: unknown } | null;
    return { threadId: typeof v?.threadId === "string" ? v.threadId : "", sent: v?.sent === true };
  } catch {
    return { threadId: "", sent: false };
  }
}

/**
 * The toast's text: the daemon's message, without a send's "; <next>" (thread.send's
 * "wait with: code-foundry thread wait <id> --after N" or "you are subscribed …", for an
 * agent on the CLI, not for the window).
 */
export function taskToast(message: string, sent: boolean): string {
  // "Sent to <label> (#N); <next>": cut at the ordinal followed by one of the two hints,
  // so a thread name holding "(#N); " is kept.
  const m = sent ? /^(.*\(#\d+\)); (?:wait with:|you are subscribed)/s.exec(message) : null;
  return m?.[1] ?? message;
}

/**
 * Whether a result is the daemon's answer for a removed thread (removedWaitResult, exit
 * 1): no thread id and nothing sent. The task went nowhere.
 */
export const taskWentNowhere = (out: { threadId: string; sent: boolean }): boolean => out.threadId === "" && !out.sent;

const selectedThread = (): string | null => {
  const sel = useUiStore.getState().selection;
  return sel.kind === "thread" ? sel.id : null;
};

/**
 * Runs pr.task for kind into target. Resolves the thread's id, or null when it failed
 * (toasted by runCommandForResult with the daemon's error), went nowhere (the target
 * thread was removed: the daemon's message toasts as an error, without Open), or the same
 * task for this pull request is already running (a second press sends nothing). Otherwise
 * the daemon's message toasts with an Open action that selects the thread, unless that
 * thread is already selected (a send into this thread, or a new thread the daemon's
 * FocusThread has selected already).
 */
export async function runPrTask(ref: PrRef, kind: TaskKind, target: TaskTarget): Promise<string | null> {
  const key = taskKey(ref, kind);
  if (usePrTasksStore.getState().running[key]) return null;
  usePrTasksStore.setState((s) => ({ running: { ...s.running, [key]: true } }));
  try {
    const res = await runCommandForResult("pr.task", prTaskArgs(ref, kind, target), { quiet: true });
    if (!res) return null;
    const out = parseTaskResult(res.resultJson);
    if (taskWentNowhere(out)) {
      toast.error(res.message || "The thread was removed: nothing was sent");
      return null;
    }
    const id = out.threadId || (target.threadId ?? "");
    if (res.message) {
      const open = id !== "" && selectedThread() !== id;
      const action = {
        label: "Open",
        onClick: () => {
          openStartedThread(id);
        },
      };
      toast.success(taskToast(res.message, out.sent), open ? { action } : undefined);
    }
    return id;
  } finally {
    usePrTasksStore.setState((s) => {
      const { [key]: _done, ...rest } = s.running;
      return { running: rest };
    });
  }
}
