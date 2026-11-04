/**
 * What a thread waits on, as the waiting strip above the composer says it
 * (docs/notes/waiting-strip.md): its wake subscriptions, its background shells and its
 * background subagents, everything that will wake it without the user. Pure.
 */
import type { BackgroundShellView, ThreadView } from "@/api/threads";
import type { WakeKind, WakeSubscriptionView } from "@/api/wakes";
import { statusLine, statusText } from "./statusLine";
import { waitingParts, waitingText } from "./waiting";

/** How many of each the strip counts. */
export interface WaitCounts {
  threads: number;
  pullRequests: number;
  actionRuns: number;
  sources: number;
  timers: number;
  shells: number;
  subagents: number;
}

/** The rows' order: the order the sentence names them in. */
const KIND_ORDER: readonly WakeKind[] = ["thread", "pullRequest", "actionRun", "plugin", "timer"];

/** The list in the strip's order: by kind, then as the daemon lists them (creation). */
export function orderWakes(wakes: readonly WakeSubscriptionView[]): WakeSubscriptionView[] {
  return KIND_ORDER.flatMap((k) => wakes.filter((w) => w.kind === k));
}

/** The distinct targets of `wakes` of kind `k`: two subscriptions to one pull request are one pull request. */
function targets(wakes: readonly WakeSubscriptionView[], k: WakeKind): number {
  return new Set(wakes.filter((w) => w.kind === k).map((w) => w.targetId)).size;
}

export function waitCounts(wakes: readonly WakeSubscriptionView[], shells: number, subagents: number): WaitCounts {
  return {
    threads: targets(wakes, "thread"),
    pullRequests: targets(wakes, "pullRequest"),
    actionRuns: targets(wakes, "actionRun"),
    sources: targets(wakes, "plugin"),
    timers: targets(wakes, "timer"),
    shells,
    subagents,
  };
}

const nouns: readonly (readonly [keyof WaitCounts, string, string])[] = [
  ["threads", "thread", "threads"],
  ["pullRequests", "PR", "PRs"],
  ["actionRuns", "action run", "action runs"],
  ["sources", "plugin source", "plugin sources"],
  ["timers", "timer", "timers"],
  ["shells", "shell", "shells"],
  ["subagents", "subagent", "subagents"],
];

/** "Waiting on 2 threads, 1 PR, 1 timer, 1 shell and 1 subagent". */
export function waitSentence(c: WaitCounts): string {
  const parts = nouns.filter(([k]) => c[k] > 0).map(([k, one, many]) => `${String(c[k])} ${c[k] === 1 ? one : many}`);
  const last = parts.pop();
  return parts.length === 0 ? `Waiting on ${last ?? "nothing"}` : `Waiting on ${parts.join(", ")} and ${last ?? ""}`;
}

/** A row's name: a timer's reason when it has one, else the target's name, else its id. */
export function wakeName(w: Pick<WakeSubscriptionView, "kind" | "note" | "targetName" | "targetId">): string {
  if (w.kind === "timer" && w.note) return w.note;
  return w.targetName || w.targetId;
}

/**
 * What a row's tooltip adds: the reason it was asked for, which the row does not show. A
 * timer's reason is its name, so its tooltip is the schedule. "" for none.
 */
export function wakeTip(w: Pick<WakeSubscriptionView, "kind" | "note" | "targetName">): string {
  return w.kind === "timer" && w.note ? w.targetName : w.note;
}

/** A row's status: the daemon's words, without "open · ", which is what a pull request under watch is. */
export function wakeStatus(w: Pick<WakeSubscriptionView, "kind" | "targetStatus">): string {
  return w.kind === "pullRequest" ? w.targetStatus.replace(/^open · /, "") : w.targetStatus;
}

/** What tells two subscriptions to one target apart: their conditions; "" when the target has only this one. */
export function wakeCondition(wakes: readonly WakeSubscriptionView[], w: WakeSubscriptionView): string {
  return wakes.some((o) => o.id !== w.id && o.kind === w.kind && o.targetId === w.targetId) ? w.condition : "";
}

/**
 * A thread target's live status, in the sidebar's words: "Working · Bash make check",
 * "Waiting on 1 subagent", "Finished", "Idle". Undefined thread: the caller has the
 * daemon's words.
 */
export function threadTargetStatus(t: ThreadView | undefined, now: number): string | undefined {
  if (!t) return undefined;
  const line = statusLine(t);
  switch (line.kind) {
    case "place":
      return "Idle";
    case "working":
      return t.busyTool ? `Working · ${t.busyTool}` : "Working";
    case "waiting":
      return waitingText(waitingParts(t.statusReason));
    case "finished":
      return "Finished";
    default:
      return statusText(line, now);
  }
}

/** A shell's row name: its command's first line, else its description. */
export function shellName(sh: Pick<BackgroundShellView, "command" | "description">): string {
  const nl = sh.command.indexOf("\n");
  const first = nl < 0 ? sh.command : `${sh.command.slice(0, nl)} …`;
  return first || sh.description;
}

/** `next`, or `prev` when it says the same: an unchanged list keeps its identity, so nothing re-renders. */
export function shareWakes(prev: readonly WakeSubscriptionView[], next: readonly WakeSubscriptionView[]): readonly WakeSubscriptionView[] {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
