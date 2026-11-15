/**
 * Threads about a pull request, from the PR surface's menu: pr.ask, pr.explain and
 * pr.fix.findings (internal/command/commands_prthread.go). Each starts a thread
 * with a prompt about the pull request. The daemon picks the worktree (ask and explain
 * prefer the caller's active worktree, which getUiContext already sends, so no worktree
 * arg is passed; fix.findings may fetch and create one) and focuses the new thread with
 * a FocusThread intent, as thread.new does (stores/intents.ts selects it). Model and
 * effort come from the settings defaults. The originating selection's panel keeps its
 * PR tab; the new thread's panel is left as it is.
 */
import { notify, notifyProgress, dismissNotice, type NoticeId } from "@/lib/notify";
import { create } from "zustand";
import { parseThreadResult } from "@/api/gh";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { runCommandForResult } from "./commands";
import { pullRequestKey } from "./gh";
import { useUiStore } from "./ui";

export type PrThreadKind = "ask" | "explain" | "fix";

export const PR_THREAD_COMMANDS: Readonly<Record<PrThreadKind, string>> = {
  ask: "pr.ask",
  explain: "pr.explain",
  fix: "pr.fix.findings",
};

interface PrThreadsState {
  /** startingKey(ref, kind) → that command is in flight. */
  starting: Readonly<Record<string, boolean>>;
}

export const usePrThreadsStore = create<PrThreadsState>()(() => ({ starting: {} }));

export const startingKey = (ref: PrRef, kind: PrThreadKind): string => `${pullRequestKey(ref.slug, ref.number)}\u0000${kind}`;

/** The command's args: the pull request, and pr.ask's question (trimmed). */
export function prThreadArgs(kind: PrThreadKind, ref: PrRef, question = ""): Record<string, string> {
  const args: Record<string, string> = { "repo-slug": ref.slug, number: String(ref.number) };
  if (kind === "ask") args.question = question.trim();
  return args;
}

/** How long pr.fix.findings runs before its "Preparing worktree" toast shows. */
export const PREPARING_TOAST_DELAY_MS = 200;

/**
 * Shows "Preparing worktree for #N…" if the command is still running after
 * PREPARING_TOAST_DELAY_MS (a quick answer, such as the fork error, shows no flash), and
 * returns its dismissal. Sonner adds a toast on a setTimeout(0) but removes it on an
 * animation frame, so a dismissal that runs before the add leaves the toast up for good;
 * the dismissal therefore waits for a timeout queued after the add's.
 */
function preparingToast(ref: PrRef): () => void {
  let id: NoticeId | undefined;
  const timer = setTimeout(() => {
    id = notifyProgress({ title: `Preparing worktree for #${String(ref.number)}…` });
  }, PREPARING_TOAST_DELAY_MS);
  return () => {
    clearTimeout(timer);
    if (id === undefined) return;
    const shown = id;
    setTimeout(() => {
      dismissNotice(shown);
    }, 0);
  };
}

/**
 * The "Started thread …" toast's Open action: selects the new thread (with prompt
 * focus, as FocusThread does) unless it is selected already. The daemon's FocusThread
 * normally gets there first; this covers a stream that missed it.
 */
export function openStartedThread(id: string): void {
  const ui = useUiStore.getState();
  if (ui.selection.kind === "thread" && ui.selection.id === id) return;
  ui.select({ kind: "thread", id }, { focusPrompt: true });
}

/**
 * How long a started thread's toast waits for the daemon's FocusThread to select the thread
 * (it travels on the event stream, apart from the command's answer, and may wait for the
 * thread to reach the list).
 */
export const FOCUS_GRACE_MS = 1000;

/** The wait unlessSelected uses; a component test with no FocusThread sets it to 0. */
export const focusGrace = { ms: FOCUS_GRACE_MS };

/**
 * Calls `show` unless thread `id` is, or within FOCUS_GRACE_MS becomes, the selected one
 * (docs/notes/toast-success-rule.md: the thread on screen is the result). A selection that
 * moves elsewhere first shows it at once. An empty id (the result named no thread) shows it.
 */
export function unlessSelected(id: string, show: () => void, graceMs = focusGrace.ms): void {
  const selected = () => {
    const sel = useUiStore.getState().selection;
    return sel.kind === "thread" && sel.id === id;
  };
  if (id === "") {
    show();
    return;
  }
  if (selected()) return;
  let done = false;
  const finish = (shown: boolean) => {
    if (done) return;
    done = true;
    stop();
    clearTimeout(timer);
    if (shown) show();
  };
  const stop = useUiStore.subscribe((s, prev) => {
    if (s.selection !== prev.selection) finish(!selected());
  });
  const timer = setTimeout(() => {
    finish(!selected());
  }, graceMs);
}

/**
 * Runs the command for kind. Resolves the new thread's id (an empty string when the
 * result names none), or null when it failed (toasted by runCommandForResult), the
 * question is blank, or the same command for this pull request is already running.
 * pr.fix.findings shows a "Preparing worktree" toast while it runs (preparingToast), as it
 * may fetch and create a worktree. "Thread started" with Open (openStartedThread) shows only
 * when the new thread did not become the selected one (unlessSelected): the daemon's
 * FocusThread normally selects it, and the thread on screen is the result.
 */
export async function startPrThread(kind: PrThreadKind, ref: PrRef, question = ""): Promise<string | null> {
  const args = prThreadArgs(kind, ref, question);
  if (kind === "ask" && !args.question) return null;
  const busy = startingKey(ref, kind);
  if (usePrThreadsStore.getState().starting[busy]) return null;
  usePrThreadsStore.setState((s) => ({ starting: { ...s.starting, [busy]: true } }));
  const preparing = kind === "fix" ? preparingToast(ref) : undefined;
  try {
    const res = await runCommandForResult(PR_THREAD_COMMANDS[kind], args, { quiet: true });
    if (!res) return null;
    const id = parseThreadResult(res.resultJson) ?? "";
    if (res.message) {
      const message = res.message;
      const open = () => {
        openStartedThread(id);
      };
      unlessSelected(id, () => {
        notify({ level: "success", title: "Thread started", description: message, ...(id ? { action: { label: "Open", onClick: open } } : {}) });
      });
    }
    return id;
  } finally {
    preparing?.();
    usePrThreadsStore.setState((s) => {
      const { [busy]: _done, ...rest } = s.starting;
      return { starting: rest };
    });
  }
}
