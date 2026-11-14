/**
 * Linked surfaces in the window shell (docs/notes/shell-model.md, "Linked surfaces"), as pure
 * functions: a thread's surfaces the menus list (its diff per checkout, its pull requests, its
 * terminal tabs), each marked when already open in the space; the row under a linked tab's
 * strip (live or dormant, and where its thread is); and the verb each menu item and the row run,
 * with its arguments. The components (components/shell/LinkedRow.tsx, ThreadSurfaceItems.tsx,
 * PanePlusMenu.tsx, components/thread/ThreadHeader.tsx) draw these and run them through
 * shell/linkedRun.ts. See docs/notes/shell-12-linked-tabs.md.
 */
import type { TerminalView } from "@/api/terminal";
import { isPanelLabels, THREAD_LABEL } from "@/lib/termlabel";
import type { LayoutState, TabEntry } from "@/stores/layout";
import { diffKey, prKey } from "./identity";

export { diffKey, prKey } from "./identity";

/** Every tab of a space, pane by pane in the panes' order of the slice. */
export function spaceTabs(s: Pick<LayoutState, "panes" | "tabs">, spaceId: string): TabEntry[] {
  return Object.values(s.panes)
    .filter((p) => p.spaceId === spaceId)
    .flatMap((p) => p.tabIds.flatMap((id) => (s.tabs[id] ? [s.tabs[id]] : [])));
}

/** One checkout of a thread: its project, the checkout's root, and the project's name. */
export interface Checkout {
  projectId: string;
  path: string;
  name: string;
}

export type ThreadSurfaceItem =
  /** The thread's diff of one checkout; `root` is passed when the thread has several. */
  | { kind: "diff"; key: string; label: string; projectId: string; root: string; openTab: string }
  | { kind: "pullrequest"; key: string; label: string; slug: string; number: number; openTab: string }
  /** One of the thread's terminal tabs in the space (always open: it is a tab); `label` is its stored name, the strip's is live. */
  | { kind: "terminal"; key: string; label: string; tabId: string; openTab: string };

/** What the Open ▸ submenu lists for a thread, in the menu's order. */
export interface ThreadSurfaces {
  diffs: ThreadSurfaceItem[];
  prs: ThreadSurfaceItem[];
  terminals: ThreadSurfaceItem[];
}

/**
 * A thread's surfaces for the Open ▸ submenu and the "+" menu's thread submenu: a diff per
 * checkout (named by its project when there are several), its linked pull requests (newest
 * first, as given), and its terminal tabs in the space. `tabs` are the space's; an item whose
 * tab is open there carries that tab's id (`openTab`), which the menu marks and focuses.
 */
export function threadSurfaces(thread: string, checkouts: readonly Checkout[], prs: readonly { slug: string; number: number }[], tabs: readonly TabEntry[]): ThreadSurfaces {
  const byKey = new Map<string, string>();
  for (const t of tabs) if (!byKey.has(t.key)) byKey.set(t.key, t.id);
  const several = checkouts.length > 1;
  const diffs: ThreadSurfaceItem[] = checkouts
    .filter((c) => c.path !== "")
    .map((c) => {
      const key = diffKey(thread, c.projectId, c.path);
      return { kind: "diff", key, label: several ? `Diff · ${c.name}` : "Diff", projectId: c.projectId, root: several ? c.path : "", openTab: byKey.get(key) ?? "" };
    });
  const seen = new Set<string>();
  const prItems: ThreadSurfaceItem[] = [];
  for (const p of prs) {
    const key = prKey(p.slug, p.number);
    if (seen.has(key)) continue;
    seen.add(key);
    prItems.push({ kind: "pullrequest", key, label: `PR #${String(p.number)}`, slug: p.slug, number: p.number, openTab: byKey.get(key) ?? "" });
  }
  const terminals: ThreadSurfaceItem[] = tabs.filter((t) => t.kind === "terminal" && t.thread === thread).map((t) => ({ kind: "terminal", key: t.key, label: t.name || t.title || "Terminal", tabId: t.id, openTab: t.id }));
  return { diffs, prs: prItems, terminals };
}

/**
 * What a menu item or the row does: run a verb (with a thread's context), focus an open tab, only
 * say something, or a terminal: a new one (a thread's, or with no thread a free one), or a running
 * one given a tab. Terminals go through PR 13's actions (shell/terminalActions.ts), the same verbs
 * as cmd+t, with the keyboard following into the new tab.
 */
export type LinkedAction =
  | { run: string; args: Record<string, string>; thread?: string }
  | { focus: string }
  | { say: string }
  | { terminal: "new"; thread: string; pane: string }
  | { terminal: "show"; id: string; pane: string };

/**
 * The action of one of a thread's surfaces. An open one is focused where it is (tab.focus keeps
 * a diff's chosen file and sides, which open_surface would replace); otherwise the item's
 * view.open verb, in `pane` when the pane's "+" menu chose it, else placed by the rules.
 */
export function surfaceAction(thread: string, item: ThreadSurfaceItem, pane = ""): LinkedAction {
  if (item.openTab) return { focus: item.openTab };
  const at: Record<string, string> = pane ? { pane } : {};
  switch (item.kind) {
    case "diff":
      return { run: "view.open.diff", args: { thread, ...(item.root ? { path: item.root } : {}), ...at } };
    case "pullrequest":
      return { run: "view.open.pr", args: { number: String(item.number), thread, ...at } };
    case "terminal":
      return { focus: item.tabId };
  }
}

/** "New terminal tab" for a thread: cmd+t's terminal.new with the thread as its context, in `pane` or placed by the rules. */
export function newTerminalAction(thread: string, pane = ""): LinkedAction {
  return { terminal: "new", thread, pane };
}

/** The terminals the layout's tabs show, in any space. */
export function tabbedTerminalIds(tabs: Readonly<Record<string, TabEntry>>): string[] {
  return Object.values(tabs).flatMap((t) => (t.kind === "terminal" && t.params.terminal ? [t.params.terminal] : []));
}

/** A running terminal with no tab, given one in the "+" menu's pane (ui.focus.terminal --pane). */
export function showTerminalAction(id: string, pane: string): LinkedAction {
  return { terminal: "show", id, pane };
}

/**
 * The running terminals that have no tab anywhere and belong to no thread: a shell, an action run
 * or a setup the classic window's bottom panel started for a checkout, or a free shell whose tab
 * went with a layout reset. A thread's terminals are not listed (its quick terminal, and the tabs
 * its close put away, come back with the thread); nor are plugins' own. In the terminals' order.
 */
export function untabbedTerminals(terminals: Readonly<Record<string, TerminalView>>, order: readonly string[], tabbedIds: readonly string[]): TerminalView[] {
  const tabbed = new Set(tabbedIds);
  return order.flatMap((id) => {
    const t = terminals[id];
    return t && t.state === "running" && !tabbed.has(id) && !t.labels[THREAD_LABEL] && isPanelLabels(t.labels) ? [t] : [];
  });
}

/** The "+" menu's general items. */
export type PlusItem = "new-thread" | "terminal" | "prs" | "projects";

/** A general item of the "+" menu: it opens in that pane. The terminal is a free one (cmd+t's with no thread: in the home folder, linked to nothing). */
export function plusAction(item: PlusItem, pane: string): LinkedAction {
  switch (item) {
    case "new-thread":
      return { run: "composer.new", args: { pane } };
    case "terminal":
      return { terminal: "new", thread: "", pane };
    case "prs":
      return { run: "view.pullrequests", args: { pane } };
    case "projects":
      return { run: "view.projects", args: { pane } };
  }
}

/** The row under a linked tab's strip: its thread and how the link stands. */
export interface LinkedRowState {
  thread: string;
  /** The thread's tab in this space; "" when it is not open here. */
  threadTab: string;
  /** Live while the thread is open in the tab's space; dormant otherwise (drawn quieter). */
  live: boolean;
  /** The space the thread lives in when that is not the tab's; "" otherwise. */
  elsewhere: string;
}

/** The row of a tab linked to a thread; null for a thread's own tab or an unlinked one. */
export function linkedRowOf(s: Pick<LayoutState, "panes" | "tabs" | "threads" | "defaultSpaceId">, tab: Pick<TabEntry, "kind" | "thread" | "paneId">): LinkedRowState | null {
  if (!tab.thread || tab.kind === "thread") return null;
  const spaceId = s.panes[tab.paneId]?.spaceId ?? "";
  const threadTab = spaceTabs(s, spaceId).find((t) => t.kind === "thread" && t.thread === tab.thread)?.id ?? "";
  const home = s.threads[tab.thread]?.spaceId ?? s.defaultSpaceId;
  return { thread: tab.thread, threadTab, live: threadTab !== "", elsewhere: home !== spaceId ? home : "" };
}

/**
 * The row's link: to the thread's tab when it is open in this space; else, when the thread
 * lives here, its tab opens by the thread-tab rule (the focused pane, which the press on the
 * row just made this one); a thread living in another space is shown there: its tab opens or is
 * focused in its own space, and the window switches to it (thread.open --focus).
 */
export function rowAction(row: LinkedRowState, pane: string): LinkedAction {
  if (row.threadTab) return { focus: row.threadTab };
  if (row.elsewhere) return { run: "thread.open", args: { id: row.thread, focus: "true" } };
  return { run: "thread.open", args: { id: row.thread, pane, focus: "true" } };
}

/** The spaces a thread can move to, in the top bar's order, its own marked `here` (Move to space ▸). */
export function spaceChoices(s: Pick<LayoutState, "spaceOrder" | "spaces" | "threads" | "defaultSpaceId">, thread: string): { id: string; name: string; here: boolean }[] {
  const home = s.threads[thread]?.spaceId ?? s.defaultSpaceId;
  return s.spaceOrder.map((id) => ({ id, name: s.spaces[id]?.name ?? id, here: id === home }));
}

/** Move to space ▸ <space>: thread.space.move, which takes the thread's linked tabs along. */
export function moveToSpaceAction(thread: string, space: string): LinkedAction {
  return { run: "thread.space.move", args: { id: thread, space } };
}

/** The header menu's Close: thread.close, the thread's tab out of its space (never an archive). */
export function closeThreadAction(thread: string): LinkedAction {
  return { run: "thread.close", args: { id: thread } };
}
