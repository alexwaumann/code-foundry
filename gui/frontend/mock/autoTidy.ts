/**
 * Auto-tidy in the mock daemon (internal/daemon/auto_tidy.go, docs/notes/auto-tidy.md): idle
 * threads saved for later and saved threads archived, each after the settings
 * threads.auto_save_after and threads.auto_archive_after (both off by default). The mock has no
 * wall-clock pass of its own; POST /__mock/auto-tidy runs one, as if `days` more days had passed.
 * The rules are the daemon's, simplified to the mock's thread (thread.AutoSaveDue, AutoArchiveDue).
 */
import { ThreadState, ThreadStatus } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import type { MockNotificationAction, PostInput } from "./notifications";

const DAY = 86_400_000;

/** What the settings' values stand for (settings.TidyAfter); 0 for off. */
export function tidyAfterMs(value: string): number {
  const m = /^(\d+)(d|w|mo)$/.exec(value);
  if (!m) return 0;
  const n = Number(m[1]);
  return n * (m[2] === "d" ? DAY : m[2] === "w" ? 7 * DAY : 30 * DAY);
}

/** The thread facts the rules read. */
export interface TidyThread {
  id: string;
  name: string;
  state: ThreadState;
  status: ThreadStatus;
  statusReason: string;
  pinned: boolean;
  archivedAt: Date | null;
  snoozedUntil: Date | null;
  savedAt: Date | null;
  /** Snoozed until an event (a save waiting on something): never archived by auto-tidy. */
  snoozeEvent: unknown;
  lastActivityAt: Date;
  /** When it last came back from Snoozed or Archived; the idle clock starts no earlier. */
  returnedAt: Date | null;
  owner: string;
  resident: string;
  /** The sidebar rule: no creator, or one that is gone. */
  inSidebar: boolean;
  /** Its setup still runs or failed. */
  settingUp: boolean;
}

/** The daemon's TidyRefusal, as a yes/no: the user's own thread, at rest at its prompt. */
function mayTidy(t: TidyThread): boolean {
  return (
    !t.resident &&
    !t.owner &&
    t.inSidebar &&
    !t.settingUp &&
    (t.state === ThreadState.CONNECTED || t.state === ThreadState.DISCONNECTED) &&
    t.status === ThreadStatus.IDLE &&
    !t.statusReason.startsWith("waiting")
  );
}

/** One pass: the ids to save (idle since before nowMs - saveMs) and to archive (saved since before nowMs - archiveMs); 0 turns a step off. */
export function tidyPlan(threads: readonly TidyThread[], named: ReadonlySet<string>, nowMs: number, saveMs: number, archiveMs: number): { save: string[]; archive: string[] } {
  const save: string[] = [];
  const archive: string[] = [];
  for (const t of threads) {
    if (named.has(t.id) || t.archivedAt !== null || t.pinned || !mayTidy(t)) continue;
    const idleSince = Math.max(t.lastActivityAt.getTime(), t.returnedAt?.getTime() ?? 0);
    if (saveMs > 0 && t.snoozedUntil === null && t.savedAt === null && idleSince < nowMs - saveMs) save.push(t.id);
    else if (archiveMs > 0 && t.snoozedUntil === null && !t.snoozeEvent && t.savedAt !== null && t.savedAt.getTime() < nowMs - archiveMs) archive.push(t.id);
  }
  return { save, archive };
}

/** "A, B and C", "A, B, C and 2 more" (the daemon's tidyNames). */
export function tidyNames(names: readonly string[]): string {
  const shown = names.slice(0, 3);
  const rest = names.length - shown.length;
  if (rest > 0) return `${shown.join(", ")} and ${String(rest)} more`;
  if (shown.length === 1) return shown[0] ?? "";
  return `${shown.slice(0, -1).join(", ")} and ${shown[shown.length - 1] ?? ""}`;
}

const openSettings: MockNotificationAction = { label: "Open settings", kind: "command", arg: "view.settings", args: { page: "general" }, resolves: true };

/** The card for one pass's saves ("auto-saved") or archives ("auto-archived"), as the daemon words it. */
export function tidyCard(kind: "saved" | "archived", names: readonly string[]): PostInput & { source: string; key: string } {
  const n = names.length;
  const title =
    kind === "saved"
      ? `${String(n)} ${n === 1 ? "idle thread was" : "idle threads were"} saved for later`
      : `${String(n)} ${n === 1 ? "saved thread was" : "saved threads were"} archived`;
  return {
    source: "threads",
    key: kind === "saved" ? "auto-saved" : "auto-archived",
    level: "info",
    title,
    body: `${kind === "saved" ? "Under Snoozed" : "Under Archived"}: ${tidyNames(names)}.`,
    actions: [openSettings],
  };
}
