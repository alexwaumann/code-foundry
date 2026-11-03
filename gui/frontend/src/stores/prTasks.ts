/**
 * The readiness box's thread tasks (pr.task, internal/command/commands_prtask.go): hands
 * one of a pull request's issues to a thread, sent into it (--thread, mid-turn like any
 * send) or to a new thread on the head branch that the daemon starts and focuses. One run
 * per pull request and kind at a time; the row's button shows it (`running`). A task sent
 * to a parent goes to the thread whose own link it is (the daemon's forward,
 * viaThreadId): "Sent to <owner> for this thread", with Open selecting the owner.
 * docs/notes/pr-panel-tasks.md, docs/notes/pr-task-forward.md.
 */
import { toast } from "sonner";
import { create } from "zustand";
import type { TaskKind } from "@/components/pr/readiness";
import { prTaskArgs, type TaskTarget } from "@/components/pr/taskRouting";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { runCommandForResult } from "./commands";
import { pullRequestKey } from "./gh";
import { openStartedThread } from "./prThreads";
import { useThreadsStore } from "./threads";
import { useUiStore } from "./ui";

interface PrTasksState {
  /** taskKey(ref, kind) → pr.task is in flight for it. */
  running: Readonly<Record<string, boolean>>;
}

export const usePrTasksStore = create<PrTasksState>()(() => ({ running: {} }));

export const taskKey = (ref: PrRef, kind: TaskKind): string => `${pullRequestKey(ref.slug, ref.number)}\u0000${kind}`;

/** What pr.task's result says: the thread the task went to (empty when none), whether it was sent into it, and the thread it was forwarded from (empty when none). */
export interface TaskResult {
  threadId: string;
  sent: boolean;
  viaThreadId: string;
}

/** pr.task's result JSON (PRTaskResult). */
export function parseTaskResult(resultJson: string): TaskResult {
  try {
    const v = JSON.parse(resultJson) as { threadId?: unknown; sent?: unknown; viaThreadId?: unknown } | null;
    const str = (x: unknown) => (typeof x === "string" ? x : "");
    return { threadId: str(v?.threadId), sent: v?.sent === true, viaThreadId: str(v?.viaThreadId) };
  } catch {
    return { threadId: "", sent: false, viaThreadId: "" };
  }
}

/**
 * A forwarded task's toast: "Sent to <owner> for this thread" when it was sent from the
 * selected thread, else "… for <sender>". Names as the threads store has them (the id
 * when unnamed or unknown).
 */
export function forwardToast(owner: string, via: string, selected: string | null): string {
  const byId = useThreadsStore.getState().byId;
  const name = (id: string) => byId[id]?.name.trim() || id;
  return `Sent to ${name(owner)} for ${via === selected ? "this thread" : name(via)}`;
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
export const taskWentNowhere = (out: Pick<TaskResult, "threadId" | "sent">): boolean => out.threadId === "" && !out.sent;

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
 * FocusThread has selected already). A forwarded task's toast names the owner and the
 * sender (forwardToast; "this thread" is the one selected when the task was run, not
 * when the answer came); Open selects the owner (a child thread opens like one picked in
 * the thread info card's lineage group).
 */
export async function runPrTask(ref: PrRef, kind: TaskKind, target: TaskTarget): Promise<string | null> {
  const key = taskKey(ref, kind);
  if (usePrTasksStore.getState().running[key]) return null;
  // The thread the button was pressed in: "for this thread" means it, whatever is
  // selected by the time the daemon answers.
  const pressedIn = selectedThread();
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
      const text = out.viaThreadId && id ? forwardToast(id, out.viaThreadId, pressedIn) : taskToast(res.message, out.sent);
      toast.success(text, open ? { action } : undefined);
    }
    return id;
  } finally {
    usePrTasksStore.setState((s) => {
      const { [key]: _done, ...rest } = s.running;
      return { running: rest };
    });
  }
}
