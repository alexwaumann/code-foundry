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

/** The thread pr.task's result JSON names (PRTaskResult.threadId); null when none. */
export function parseTaskResult(resultJson: string): string | null {
  try {
    const v = JSON.parse(resultJson) as { threadId?: unknown } | null;
    return typeof v?.threadId === "string" && v.threadId !== "" ? v.threadId : null;
  } catch {
    return null;
  }
}

const selectedThread = (): string | null => {
  const sel = useUiStore.getState().selection;
  return sel.kind === "thread" ? sel.id : null;
};

/**
 * Runs pr.task for kind into target. Resolves the thread's id (an empty string when the
 * result names none), or null when it failed (toasted by runCommandForResult with the
 * daemon's error) or the same task for this pull request is already running (a second
 * press sends nothing). The daemon's message toasts; it has an Open action that selects
 * the thread unless that thread is already selected (a send into this thread, or a new
 * thread the daemon's FocusThread has selected already).
 */
export async function runPrTask(ref: PrRef, kind: TaskKind, target: TaskTarget): Promise<string | null> {
  const key = taskKey(ref, kind);
  if (usePrTasksStore.getState().running[key]) return null;
  usePrTasksStore.setState((s) => ({ running: { ...s.running, [key]: true } }));
  try {
    const res = await runCommandForResult("pr.task", prTaskArgs(ref, kind, target), { quiet: true });
    if (!res) return null;
    const id = parseTaskResult(res.resultJson) ?? target.threadId ?? "";
    if (res.message) {
      const open = id !== "" && selectedThread() !== id;
      toast.success(res.message, open ? { action: { label: "Open", onClick: () => openStartedThread(id) } } : undefined);
    }
    return id;
  } finally {
    usePrTasksStore.setState((s) => {
      const { [key]: _done, ...rest } = s.running;
      return { running: rest };
    });
  }
}
