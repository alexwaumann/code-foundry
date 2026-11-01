/**
 * A thread waiting on its child threads (docs/notes/orch-waiting-status.md): it ended its
 * turn while threads it subscribed to still work, so the daemon will wake it and it needs
 * nothing from the user. The daemon says so with status "idle" and the reason "waiting on
 * 2 child threads" (with " and 1 subagent", " and 1 shell" when its own background work
 * keeps it too; "waiting" alone while only a wake to it is queued). It sorts under the
 * sidebar's Working footer (lib/thread threadGroup; docs/notes/sidebar-waiting-under-working.md),
 * never counts in the window title or the dock, and its row says "Waiting". Pure.
 */
import type { ThreadView } from "@/api/threads";
import { isWaiting, threadBadge } from "./thread";

/** The thread list as read here (stores/threads ThreadsData). */
interface ThreadsData {
  byId: Readonly<Record<string, ThreadView>>;
  order: readonly string[];
}

/** Whether the thread is waiting on its child threads (lib/thread, where threadGroup needs it). */
export { isWaiting };

/**
 * What the daemon says the thread waits on, from its reason "waiting on " + the non-zero
 * parts joined by " and ", in this order: "N child thread(s)", "N subagent(s)", "N
 * shell(s)" ("waiting on 2 child threads and 1 subagent"). "waiting" alone (a queued
 * wake) and any other reason read all zero; an unknown part is skipped.
 */
export interface WaitingParts {
  children: number;
  subagents: number;
  shells: number;
}

const PART = /^(\d+) (child threads?|subagents?|shells?)$/;

/** The reason's parts (WaitingParts); all zero for "waiting" alone or any other reason. */
export function waitingParts(reason: string): WaitingParts {
  const out: WaitingParts = { children: 0, subagents: 0, shells: 0 };
  if (!reason.startsWith("waiting on ")) return out;
  for (const part of reason.slice("waiting on ".length).split(" and ")) {
    const m = PART.exec(part.trim());
    if (!m) continue;
    const n = Number.parseInt(m[1] ?? "", 10);
    const what = m[2] ?? "";
    if (what.startsWith("child")) out.children = n;
    else if (what.startsWith("subagent")) out.subagents = n;
    else out.shells = n;
  }
  return out;
}

/** How many child threads the daemon says it waits on: 2 for "waiting on 2 child threads (and …)"; 0 when it names none. */
export function waitingCount(s: Pick<ThreadView, "status" | "statusReason">): number {
  return isWaiting(s) ? waitingParts(s.statusReason).children : 0;
}

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * The tooltip's sentence: "Waiting on 2 child threads and 1 subagent", "Waiting on 1
 * shell"; "Waiting on a wake" when no part is set (the bare "waiting").
 */
export function waitingText(p: WaitingParts): string {
  const parts = [
    p.children > 0 ? count(p.children, "child thread", "child threads") : "",
    p.subagents > 0 ? count(p.subagents, "subagent", "subagents") : "",
    p.shells > 0 ? count(p.shells, "shell", "shells") : "",
  ].filter(Boolean);
  return parts.length === 0 ? "Waiting on a wake" : `Waiting on ${parts.join(" and ")}`;
}

/** The tooltip lists this many names, then "+N more". */
export const WAITING_NAMES_CAP = 5;

/**
 * The names of the thread's children that keep it waiting, in spawn order: those working
 * (threadBadge busy) or themselves waiting, not archived. The daemon counts the targets of
 * its subscriptions, which the GUI does not see; an agent subscribes to the threads it
 * creates (`--notify`), so its busy children are the ones it waits on. The first `cap`
 * names, and how many more there are.
 */
export function waitingOnNames(data: ThreadsData, id: string, cap = WAITING_NAMES_CAP): { names: string[]; more: number } {
  const busy = data.order.filter((x) => {
    const t = data.byId[x];
    return x !== id && t?.createdBy === id && t.archivedAtMs === null && (threadBadge(t) === "busy" || isWaiting(t));
  });
  const names = busy.slice(0, cap).map((x) => data.byId[x]?.name || x);
  return { names, more: Math.max(0, busy.length - cap) };
}
