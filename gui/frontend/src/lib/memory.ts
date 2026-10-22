/**
 * Settings › Memory's words (docs/notes/memory-page.md): when an entry was remembered and
 * which thread did it. Pure; the store's selectors (stores/memory.ts) feed them.
 */
import type { MemoryLeftOut, MemoryOriginView } from "@/api/memory";
import type { ThreadView } from "@/api/threads";

/**
 * Who remembered an entry, resolved by the thread's id (docs/notes/lineage-by-id.md): its
 * current name while it is in the thread list (archived ones are), else the name it had
 * when it remembered the entry, else its id. `user`: the user's terminal, the GUI or an
 * imported line.
 */
export type MemoryBy =
  | { kind: "user" }
  | { kind: "thread"; id: string; name: string; state: "live" | "archived" | "removed" };

export function memoryBy(origin: MemoryOriginView, thread: Pick<ThreadView, "name" | "archivedAtMs"> | undefined): MemoryBy {
  if (origin.kind === "user") return origin;
  const id = origin.threadId;
  if (!thread) return { kind: "thread", id, name: origin.threadName || id, state: "removed" };
  return { kind: "thread", id, name: thread.name || id, state: thread.archivedAtMs === null ? "live" : "archived" };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayStart(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/**
 * When, after "Remembered": "just now", "5 min ago", "today", "yesterday", "3 days ago",
 * then "on Oct 14" ("on Oct 14, 2025" in another year). Calendar days are local. A time in
 * the future reads "just now". "" when unknown (a file added by hand).
 */
export function rememberedWhen(ms: number | null, now: number): string {
  if (ms === null) return "";
  const minutes = Math.floor((now - ms) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const days = Math.round((dayStart(now) - dayStart(ms)) / 86_400_000);
  if (days <= 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 7) return `${String(days)} days ago`;
  const d = new Date(ms);
  const day = `${MONTHS[d.getMonth()] ?? ""} ${String(d.getDate())}`;
  return d.getFullYear() === new Date(now).getFullYear() ? `on ${day}` : `on ${day}, ${String(d.getFullYear())}`;
}

/**
 * Why threads do not get an entry, as its row says it (memory show's reasons): only an
 * import or a hand edit leaves one too long or past the caps. "" when they do.
 */
export function leftOutReason(leftOut: MemoryLeftOut, caps: { maxEntries: number; maxBytes: number; maxEntryChars: number }): string {
  switch (leftOut) {
    case "too_long":
      return `Not given to threads: longer than ${String(caps.maxEntryChars)} characters. Forget it and say it shorter.`;
    case "entries":
      return `Not given to threads: past the ${String(caps.maxEntries)}-entry limit.`;
    case "bytes":
      return `Not given to threads: past the ${String(Math.round(caps.maxBytes / 1024))} KiB limit.`;
    case "":
      return "";
  }
}
