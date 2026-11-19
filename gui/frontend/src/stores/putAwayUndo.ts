/**
 * The Undo toast after this window put threads away (docs/notes/put-away-undo.md). A snooze (a
 * time, the default chord, Save for later) or an archive the user ran from this window, by any
 * path (a row's buttons, a menu, the bulk menu, a key, the palette, a drop on the Snoozed or
 * Archived header), shows one neutral toast in the window's bottom-left corner: what happened,
 * which threads, and Undo (cmd+z while it shows; Escape closes it, keys/bindings.ts). Every one
 * has the same id, so a newer put-away replaces the one showing, and its Undo undoes only that.
 *
 * It hears of the put-away through the command runner's watchers (stores/commands.ts
 * watchCommands): what reached runCommandForResult without a `caller`, so never a plugin's, a
 * page's, the CLI's, another window's or a thread's own put-away. A failure or a declined
 * confirmation shows nothing, and so do an unsnooze and an unarchive. Its toast replaces the
 * command's success toast.
 *
 * Undo runs thread.snooze --clear or thread.archive --archived false (with ids for several). A
 * woken thread's tab comes back where the snooze closed it (the daemon's layout, in place of the
 * New thread tab the snooze left when nothing was typed in it); an unarchived thread's tab is
 * opened again here, where it was. The thread whose tab had the focus gets it back.
 */
import { createElement } from "react";
import { AlarmClock, Archive, Bookmark } from "lucide-react";
import type { UiContextView } from "@/api/command";
import { applyLayoutOp } from "@/api/layout";
import { dismissNotice, notify } from "@/lib/notify";
import { snoozeUntilPhrase } from "@/lib/snooze";
import { focusTabNow, runLayoutCommand } from "@/shell/commands";
import { runCommandForResult, watchCommands } from "./commands";
import { useLayoutStore, type LayoutState, type TabEntry } from "./layout";
import { focusedTab } from "./selectionBridge";
import { useThreadsStore } from "./threads";
import { threadContext } from "./threadActions";

/** The one id every undo toast has: a newer one replaces the one showing. */
export const UNDO_TOAST_ID = "put-away-undo";
/** How long it shows (sonner pauses the timer while the pointer is over it). */
export const UNDO_MS = 5000;
/** The key that runs its Undo while it shows (keys/bindings.ts). */
export const UNDO_CHORD = "cmd+z";
/** How long Undo waits for a woken thread's tab to come back before it focuses it anyway. */
const BACK_MS = 2000;

export type PutAwayKind = "snooze" | "save" | "archive";

/** What a command puts away. */
export interface PutAwayAction {
  kind: PutAwayKind;
  ids: string[];
  /** A snooze's wake time (epoch ms); null when the command gave none this window can read. */
  untilMs: number | null;
}

/** Where a thread's tab was when it was put away: its pane and its place in the strip. */
export interface TabPlace {
  pane: string;
  index: number;
}

/** A put-away the toast can undo. */
export interface PutAway extends PutAwayAction {
  /** The threads' names then (a name, else the id), in the order given. */
  names: string[];
  /** The thread whose tab was the window's focused tab then; "" for none. */
  focused: string;
  /** Where each thread's tab was, for the threads that had one open. */
  places: Record<string, TabPlace>;
}

function idsOf(args: Readonly<Record<string, string>>, ctx: UiContextView): string[] {
  if (args.ids) return args.ids.split(",").map((s) => s.trim()).filter((s) => s !== "");
  const one = args.id || ctx.activeThreadId;
  return one ? [one] : [];
}

/**
 * What a command run with these args puts away, or null: anything that is not a snooze, a save
 * for later or an archive (an unsnooze, an unarchive, another command, an archive of a thread's
 * descendants). thread.archive without `archived` toggles one thread (archives it unless it is
 * archived now, `archivedNow`) and archives several.
 */
export function putAwayOf(name: string, args: Readonly<Record<string, string>>, ctx: UiContextView, archivedNow: (id: string) => boolean = isArchived): PutAwayAction | null {
  if (args["descendants-of"]) return null;
  const ids = idsOf(args, ctx);
  const first = ids[0];
  if (first === undefined) return null;
  if (name === "thread.archive") {
    const archiving = args.archived === undefined || args.archived === "" ? ids.length > 1 || !archivedNow(first) : args.archived !== "false";
    return archiving ? { kind: "archive", ids, untilMs: null } : null;
  }
  if (name !== "thread.snooze" || args.clear === "true") return null;
  if (args.save === "true") return { kind: "save", ids, untilMs: null };
  const until = args.until ? Date.parse(args.until) : Number.NaN;
  return { kind: "snooze", ids, untilMs: Number.isFinite(until) ? until : null };
}

function isArchived(id: string): boolean {
  return (useThreadsStore.getState().byId[id]?.archivedAtMs ?? null) !== null;
}

/** "Snoozed until tomorrow, 9:00 AM", "Saved 3 threads for later", "Archived". */
export function undoTitle(p: PutAwayAction, now: number): string {
  const n = p.ids.length;
  const many = n > 1 ? ` ${String(n)} threads` : "";
  switch (p.kind) {
    case "archive":
      return `Archived${many}`;
    case "save":
      return `Saved${many} for later`;
    case "snooze":
      return p.untilMs === null ? `Snoozed${many}` : `Snoozed${many} until ${snoozeUntilPhrase(p.untilMs, now)}`;
  }
}

/** The thread's name; for several, the first two and how many more ("a, b and 3 more"). */
export function undoDescription(names: readonly string[]): string {
  const [a = "", b = "", ...rest] = names;
  if (names.length <= 1) return a;
  if (names.length === 2) return `${a} and ${b}`;
  return `${a}, ${b} and ${String(rest.length)} more`;
}

const ICONS = { snooze: AlarmClock, save: Bookmark, archive: Archive } as const;

/** The put-away the toast showing would undo; null while none shows. */
let showing: PutAway | null = null;

/** Whether an undo toast shows (keys/bindings.ts gives it cmd+z and Escape then). */
export function undoShowing(): boolean {
  return showing !== null;
}

/** Shows the undo toast for p, in place of one showing. */
export function showUndo(p: PutAway, now = Date.now()): void {
  showing = p;
  notify({
    level: "neutral",
    id: UNDO_TOAST_ID,
    position: "bottom-left",
    icon: createElement(ICONS[p.kind]),
    title: undoTitle(p, now),
    description: createElement("span", { className: "block truncate", "data-undo-names": "" }, undoDescription(p.names)),
    action: {
      label: "Undo",
      chord: UNDO_CHORD,
      onClick: () => {
        runUndo();
      },
    },
    closable: true,
    duration: UNDO_MS,
    onClose: () => {
      if (showing === p) showing = null;
    },
  });
}

/** Runs the showing toast's Undo and closes it; false when none shows. */
export function runUndo(): boolean {
  const p = showing;
  if (!p) return false;
  showing = null;
  dismissNotice(UNDO_TOAST_ID);
  void undo(p);
  return true;
}

/** Closes the showing undo toast; false when none shows. */
export function dismissUndo(): boolean {
  if (!showing) return false;
  showing = null;
  dismissNotice(UNDO_TOAST_ID);
  return true;
}

/** A thread command on ids (`id` for one, `ids` for several), quiet: what it undoes shows. */
async function onIds(name: string, args: Record<string, string>, ids: readonly string[]): Promise<boolean> {
  const first = ids[0] ?? "";
  const all = ids.length > 1 ? { ...args, ids: ids.join(",") } : { ...args, id: first };
  return (await runCommandForResult(name, all, { ctx: threadContext(first), quiet: true })) !== null;
}

/** The commands Undo runs, in order, for a put-away: what the tests read. */
export function undoCommands(p: PutAwayAction): { name: string; args: Record<string, string> } {
  return p.kind === "archive" ? { name: "thread.archive", args: { archived: "false" } } : { name: "thread.snooze", args: { clear: "true" } };
}

async function undo(p: PutAway): Promise<void> {
  const { name, args } = undoCommands(p);
  if (!(await onIds(name, args, p.ids))) return;
  if (p.kind === "archive") {
    for (const id of p.ids) await reopen(id, p.places[id], p.focused === id);
    return;
  }
  if (p.focused) await focusWhenBack(p.focused);
}

function threadTab(s: LayoutState, id: string): TabEntry | undefined {
  return Object.values(s.tabs).find((t) => t.kind === "thread" && t.thread === id);
}

/**
 * Opens an unarchived thread's tab where it was: in place of the New thread tab the archive left
 * in its pane, while nothing was typed in it; else in its pane at its old place; else where a
 * thread's tab opens. A thread whose tab was not open stays closed, as an unarchive leaves it.
 */
async function reopen(id: string, at: TabPlace | undefined, focus: boolean): Promise<void> {
  if (!at) return;
  const s = useLayoutStore.getState();
  const pane = s.panes[at.pane];
  const there = pane ? s.tabs[pane.tabIds[at.index] ?? ""] : undefined;
  const flag: Record<string, string> = focus ? { focus: "true" } : {};
  try {
    if (there?.kind === "compose" && !there.params.draft) {
      await applyLayoutOp({ op: "open_thread", thread: id, compose: there.id, focus });
      return;
    }
    // Refused quietly (the pane moved to another space with its tabs): it falls back below.
    if (pane && (await runCommandForResult("thread.open", { id, pane: pane.id, index: String(at.index), ...flag }, { quiet: true, expected: () => true }))) return;
  } catch {
    // The composer went meanwhile: it opens where a thread's tab opens.
  }
  await runLayoutCommand("thread.open", { id, ...flag });
}

/** Focuses a woken thread's tab once the daemon has put it back (or, after a while, opens it). */
async function focusWhenBack(id: string): Promise<void> {
  const tab = await new Promise<TabEntry | undefined>((resolve) => {
    const now = threadTab(useLayoutStore.getState(), id);
    if (now) {
      resolve(now);
      return;
    }
    const done = (t: TabEntry | undefined) => {
      clearTimeout(timer);
      unsub();
      resolve(t);
    };
    const timer = setTimeout(() => {
      done(undefined);
    }, BACK_MS);
    const unsub = useLayoutStore.subscribe((s) => {
      const t = threadTab(s, id);
      if (t) done(t);
    });
  });
  if (tab) await focusTabNow(tab.id);
  else await runLayoutCommand("thread.open", { id, focus: "true" });
}

/** What the window shows of the threads a command is about to put away. */
function snapshot(a: PutAwayAction): PutAway {
  const byId = useThreadsStore.getState().byId;
  const s = useLayoutStore.getState();
  const front = s.loaded ? focusedTab(s) : null;
  const places: Record<string, TabPlace> = {};
  for (const id of a.ids) {
    const tab = s.loaded ? threadTab(s, id) : undefined;
    const pane = tab ? s.panes[tab.paneId] : undefined;
    if (tab && pane) places[id] = { pane: pane.id, index: pane.tabIds.indexOf(tab.id) };
  }
  return {
    ...a,
    names: a.ids.map((id) => byId[id]?.name || id),
    focused: front?.kind === "thread" && a.ids.includes(front.thread) ? front.thread : "",
    places,
  };
}

/** Starts showing the undo toast after this window's put-aways; returns the stop. */
export function startPutAwayUndo(): () => void {
  return watchCommands((name, args, ctx) => {
    const a = putAwayOf(name, args, ctx);
    if (!a) return null;
    const p = snapshot(a);
    return () => {
      showUndo(p);
      return true;
    };
  });
}
