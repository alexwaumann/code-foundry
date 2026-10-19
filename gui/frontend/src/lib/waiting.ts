/**
 * A thread waiting on its child threads (docs/notes/orch-waiting-status.md): it ended its
 * turn while threads it subscribed to still work, so the daemon will wake it and it needs
 * nothing from the user. The daemon says so with status "idle" and the reason "waiting on
 * 2 child threads" ("waiting" alone while only a wake to it is queued). It sorts with the
 * idle threads, never rings the bell or the dock, and its row says "Waiting". Pure.
 */
import type { ThreadView } from "@/api/threads";
import { threadBadge } from "./thread";

/** The thread list as read here (stores/threads ThreadsData). */
interface ThreadsData {
  byId: Readonly<Record<string, ThreadView>>;
  order: readonly string[];
}

/** Whether the thread is waiting on its child threads. */
export function isWaiting(s: Pick<ThreadView, "status" | "statusReason"> | undefined): boolean {
  if (s?.status !== "idle") return false;
  return s.statusReason === "waiting" || s.statusReason.startsWith("waiting on ");
}

/** How many threads the daemon says it waits on: 2 for "waiting on 2 child threads"; 0 for "waiting" alone. */
export function waitingCount(s: Pick<ThreadView, "status" | "statusReason">): number {
  if (!isWaiting(s)) return 0;
  const n = Number.parseInt(s.statusReason.slice("waiting on ".length), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** The tooltip's sentence: "Waiting on 2 child threads", "Waiting on 1 child thread", "Waiting on a wake". */
export function waitingText(n: number): string {
  if (n <= 0) return "Waiting on a wake";
  return n === 1 ? "Waiting on 1 child thread" : `Waiting on ${String(n)} child threads`;
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
