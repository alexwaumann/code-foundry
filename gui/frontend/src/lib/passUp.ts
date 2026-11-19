/**
 * A worker's question its lead passed up to the user (docs/notes/pass-up-question.md): to the
 * user it is the lead's question, so it sits where the lead's own do (Needs you, the hover card,
 * the popup, the docked card), with the worker's name in the title and one line saying it was
 * passed up. Pure.
 */
import type { PassedUpView } from "@/api/thread";
import type { WorkerNow } from "@/lib/workerRuns";

/** The card's title: "<worker> has a question" where the lead's own say "Claude has a question". */
export function askTitle(asker: string | null, count: number): string {
  const who = asker ?? "Claude";
  return count > 1 ? `${who} has ${String(count)} questions` : `${who} has a question`;
}

/** The line under a passed-up question's title: who passed it up and, for a thread ask, what the worker assumes until answered. */
export function passedUpLine(p: Pick<PassedUpView, "threadAsk" | "assuming"> | undefined): string {
  const assuming = p?.threadAsk ? p.assuming.replace(/\s+/g, " ").trim().replace(/\.$/, "") : "";
  return assuming ? `Passed up by this thread. Until you answer, it assumes: ${assuming}.` : "Passed up by this thread.";
}

/** The worker's name for a title: its name now, else the one it had when passed up, else its id. */
export function askerName(threadId: string, nameNow: string | undefined, passedName: string | undefined): string {
  return nameNow || passedName || threadId;
}

/**
 * The worker card's workers with each one whose question this lead passed up (`passed`, ids
 * with "\n" between, stores/thread usePassedUpFrom) reading "asks you" while it is open; an
 * archived one stays archived. The same map when nothing changes.
 */
export function withPassedUp(workers: ReadonlyMap<string, WorkerNow>, passed: string): ReadonlyMap<string, WorkerNow> {
  if (passed === "") return workers;
  let out: Map<string, WorkerNow> | null = null;
  for (const id of passed.split("\n")) {
    const w = workers.get(id);
    if (!w || w.state === "asks" || w.state === "archived") continue;
    out ??= new Map(workers);
    out.set(id, { ...w, state: "asks" });
  }
  return out ?? workers;
}
