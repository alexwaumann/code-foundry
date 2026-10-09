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

/**
 * Runs the command for kind. Resolves the new session's id (an empty string when the
 * result names none), or null when it failed (toasted by runCommandForResult), the
 * question is blank, or the same command for this pull request is already running.
 * pr.fix.findings shows a "Preparing worktree" toast while it runs, as it may fetch and
 * create a worktree.
 */
export async function startPrSession(kind: PrSessionKind, ref: PrRef, question = ""): Promise<string | null> {
  const args = prSessionArgs(kind, ref, question);
  if (kind === "ask" && !args.question) return null;
  const busy = startingKey(ref, kind);
  if (usePrSessionsStore.getState().starting[busy]) return null;
  usePrSessionsStore.setState((s) => ({ starting: { ...s.starting, [busy]: true } }));
  const preparing = kind === "fix" ? toast.loading(`Preparing worktree for #${String(ref.number)}…`) : undefined;
  try {
    const res = await runCommandForResult(PR_SESSION_COMMANDS[kind], args);
    if (!res) return null;
    return parseSessionResult(res.resultJson) ?? "";
  } finally {
    if (preparing !== undefined) toast.dismiss(preparing);
    usePrSessionsStore.setState((s) => {
      const { [busy]: _done, ...rest } = s.starting;
      return { starting: rest };
    });
  }
}
