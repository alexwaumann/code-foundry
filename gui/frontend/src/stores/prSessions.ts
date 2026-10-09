/**
 * Sessions about a pull request, from the PR surface's menu: pr.ask, pr.explain and
 * pr.fix.findings (internal/command/commands_prsession.go). Each starts a Claude session
 * with a prompt about the pull request. The daemon picks the worktree (ask and explain
 * prefer the caller's active worktree, which getUiContext already sends, so no worktree
 * arg is passed; fix.findings may fetch and create one) and focuses the new session with
 * a FocusSession intent, as session.new does (stores/intents.ts selects it). Model and
 * effort come from the settings defaults. The originating selection's panel keeps its
 * PR tab; the new session's panel is left as it is.
 */
import { toast } from "sonner";
import { create } from "zustand";
import { parseSessionResult } from "@/api/gh";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { runCommandForResult } from "./commands";
import { pullRequestKey } from "./gh";
import { useUiStore } from "./ui";

export type PrSessionKind = "ask" | "explain" | "fix";

export const PR_SESSION_COMMANDS: Readonly<Record<PrSessionKind, string>> = {
  ask: "pr.ask",
  explain: "pr.explain",
  fix: "pr.fix.findings",
};

interface PrSessionsState {
  /** startingKey(ref, kind) → that command is in flight. */
  starting: Readonly<Record<string, boolean>>;
}

export const usePrSessionsStore = create<PrSessionsState>()(() => ({ starting: {} }));

export const startingKey = (ref: PrRef, kind: PrSessionKind): string => `${pullRequestKey(ref.slug, ref.number)}\u0000${kind}`;

/** The command's args: the pull request, and pr.ask's question (trimmed). */
export function prSessionArgs(kind: PrSessionKind, ref: PrRef, question = ""): Record<string, string> {
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
  let id: string | number | undefined;
  const timer = setTimeout(() => {
    id = toast.loading(`Preparing worktree for #${String(ref.number)}…`);
  }, PREPARING_TOAST_DELAY_MS);
  return () => {
    clearTimeout(timer);
    if (id === undefined) return;
    const shown = id;
    setTimeout(() => toast.dismiss(shown), 0);
  };
}

/**
 * The "Started session …" toast's Open action: selects the new session (with terminal
 * focus, as FocusSession does) unless it is selected already. The daemon's FocusSession
 * normally gets there first; this covers a stream that missed it.
 */
export function openStartedSession(id: string): void {
  const ui = useUiStore.getState();
  if (ui.selection.kind === "session" && ui.selection.id === id) return;
  ui.select({ kind: "session", id }, { focusTerminal: true });
}

/**
 * Runs the command for kind. Resolves the new session's id (an empty string when the
 * result names none), or null when it failed (toasted by runCommandForResult), the
 * question is blank, or the same command for this pull request is already running.
 * pr.fix.findings shows a "Preparing worktree" toast while it runs (preparingToast), as it
 * may fetch and create a worktree. The success toast has an Open action
 * (openStartedSession) when the result names the session.
 */
export async function startPrSession(kind: PrSessionKind, ref: PrRef, question = ""): Promise<string | null> {
  const args = prSessionArgs(kind, ref, question);
  if (kind === "ask" && !args.question) return null;
  const busy = startingKey(ref, kind);
  if (usePrSessionsStore.getState().starting[busy]) return null;
  usePrSessionsStore.setState((s) => ({ starting: { ...s.starting, [busy]: true } }));
  const preparing = kind === "fix" ? preparingToast(ref) : undefined;
  try {
    const res = await runCommandForResult(PR_SESSION_COMMANDS[kind], args, { quiet: true });
    if (!res) return null;
    const id = parseSessionResult(res.resultJson) ?? "";
    if (res.message) {
      const open = () => {
        openStartedSession(id);
      };
      toast.success(res.message, id ? { action: { label: "Open", onClick: open } } : undefined);
    }
    return id;
  } finally {
    preparing?.();
    usePrSessionsStore.setState((s) => {
      const { [busy]: _done, ...rest } = s.starting;
      return { starting: rest };
    });
  }
}
