/**
 * The selection bridge (docs/notes/shell-11-pane-grid.md): with the window shell on, the window has
 * no single selection of its own; the focused tab is what it shows. So that the many readers of
 * `useUiStore.selection` (the command context, the sidebar's selected row, the window title, the
 * composer's send) keep working, this writes the selection from the current space's focused tab,
 * and takes `ui.select(...)` to the layout: a thread opens (or focuses) its tab, a page or the
 * composer opens its tab. See docs/notes/shell-11-pane-grid.md.
 *
 * The selection of each tab kind:
 * - a thread's tab: the thread; a tab linked to a thread (a diff, a file, the board): that thread;
 * - Pull Requests: the `pullrequests` page; Projects: the Projects page its params name;
 * - the composer: the compose selection its params say (project, workspace, like; none: home);
 * - an unlinked tab of another kind: none;
 * - a space with no pane: home (the empty space shows the composer).
 */
import { applyLayoutOp } from "@/api/layout";
import { afterRev, focusTabNow, runLayoutCommand } from "@/shell/commands";
import { emberThreadOf } from "./ember";
import { useLayoutStore, type LayoutState, type TabEntry } from "./layout";
import { requestPaneFocus } from "./shellView";
import { useThreadsStore } from "./threads";
import { HOME, mirrorSelection, sameSelection, setSelectRoute, useUiStore, type SelectOptions, type Selection } from "./ui";
import { useWorkspacesStore } from "./workspaces";
import { EMBER_VIEW } from "@/surfaces/emberTarget";

type ComposeSelection = Extract<Selection, { kind: "compose" }>;

/** What a compose tab's params need from the stores: a like thread's project, a workspace's first member. */
export interface ComposeLookups {
  likeProject: string;
  firstMember: string;
}

/** The compose selection a composer tab's params (`project`, `workspace`, `like`) stand for. */
export function composeSelectionOf(params: Readonly<Record<string, string>>, look: ComposeLookups): ComposeSelection {
  if (params.like) return { kind: "compose", projectId: look.likeProject, likeThreadId: params.like };
  if (params.workspace) return { kind: "compose", projectId: look.firstMember, workspaceId: params.workspace };
  if (params.project) return { kind: "compose", projectId: params.project };
  return HOME;
}

/** A compose selection's tab params: the inverse of composeSelectionOf. */
export function composeParamsOf(sel: Selection): Record<string, string> {
  if (sel.kind !== "compose") return {};
  if (sel.likeThreadId) return { like: sel.likeThreadId };
  if (sel.workspaceId) return { workspace: sel.workspaceId };
  if (sel.noProject || !sel.projectId) return {};
  return { project: sel.projectId };
}

/** The Projects page a Projects tab's params name. */
function projectsSelectionOf(params: Readonly<Record<string, string>>): Selection {
  if (params.project) return { kind: "view", name: "projects", projectId: params.project };
  if (params.workspace) return { kind: "view", name: "projects", workspaceId: params.workspace };
  return { kind: "view", name: "projects" };
}

/** The selection a focused tab stands for; null (no tab) is the empty space: home. */
export function selectionOfTab(tab: TabEntry | null, look: (tab: TabEntry) => ComposeLookups = defaultLookups): Selection {
  if (!tab) return HOME;
  if (tab.kind === "thread") return { kind: "thread", id: tab.thread };
  if (tab.thread) return { kind: "thread", id: tab.thread };
  if (tab.kind === "prs") return { kind: "view", name: "pullrequests" };
  if (tab.kind === "projects") return projectsSelectionOf(tab.params);
  if (tab.kind === "compose") return composeSelectionOf(tab.params, look(tab));
  return { kind: "none" };
}

function defaultLookups(tab: TabEntry): ComposeLookups {
  const like = tab.params.like;
  const ws = tab.params.workspace;
  return {
    likeProject: like ? (useThreadsStore.getState().byId[like]?.projectId ?? "") : "",
    firstMember: ws ? (useWorkspacesStore.getState().byId[ws]?.members[0]?.projectId ?? "") : "",
  };
}

/** The current space's focused tab: its focused pane's active tab; null when the space has no pane. */
export function focusedTab(s: Pick<LayoutState, "currentSpaceId" | "spaces" | "panes" | "tabs">): TabEntry | null {
  const space = s.spaces[s.currentSpaceId];
  const pane = space ? s.panes[space.focus] : undefined;
  return (pane && s.tabs[pane.active]) ?? null;
}

/** A tab of a kind in the current space (the first in layout order of the panes' strips). */
function tabOfKind(s: LayoutState, kind: string, match: (t: TabEntry) => boolean = () => true): TabEntry | null {
  for (const pane of Object.values(s.panes)) {
    if (pane.spaceId !== s.currentSpaceId) continue;
    for (const id of pane.tabIds) {
      const t = s.tabs[id];
      if (t?.kind === kind && match(t)) return t;
    }
  }
  return null;
}

function sameParams(a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean {
  const ka = Object.keys(a).filter((k) => a[k] !== "");
  const kb = Object.keys(b).filter((k) => b[k] !== "");
  return ka.length === kb.length && ka.every((k) => a[k] === b[k]);
}

/** What routing a selection does to the layout: pure, so the bridge's tests read it. */
export type RouteAction =
  /** Nothing to change: the focused tab already shows it. */
  | { kind: "stay" }
  /** A layout verb: thread.open, composer.new. */
  | { kind: "command"; name: string; args: Record<string, string>; params?: Record<string, string> }
  /** Focus an open tab (and set its params when they differ). */
  | { kind: "focus"; tab: string; params?: Record<string, string> }
  /** Set the focused tab's params (the Projects tab moving between its pages). */
  | { kind: "params"; tab: string; params: Record<string, string> }
  /** Open a page's tab in the focused pane (view.open.* arrives with PR 7). */
  | { kind: "open"; tabKind: string; params: Record<string, string> }
  /** Not the shell's: leave the selection to the store. */
  | { kind: "none" };

/** How a selection reaches the layout. */
export function planRoute(sel: Selection, s: LayoutState, opts: SelectOptions = {}, emberThread = ""): RouteAction {
  const focused = focusedTab(s);
  switch (sel.kind) {
    case "thread":
      if (focused?.kind === "thread" && focused.thread === sel.id) return { kind: "stay" };
      return { kind: "command", name: "thread.open", args: { id: sel.id, focus: "true" } };
    case "view": {
      if (sel.name === EMBER_VIEW) return emberThread ? planRoute({ kind: "thread", id: emberThread }, s, opts) : { kind: "none" };
      if (sel.name === "pullrequests") {
        if (focused?.kind === "prs") return { kind: "stay" };
        const open = tabOfKind(s, "prs");
        return open ? { kind: "focus", tab: open.id } : { kind: "open", tabKind: "prs", params: {} };
      }
      if (sel.name === "projects") {
        const params: Record<string, string> = sel.projectId ? { project: sel.projectId } : sel.workspaceId ? { workspace: sel.workspaceId } : {};
        if (focused?.kind === "projects") return sameParams(focused.params, params) ? { kind: "stay" } : { kind: "params", tab: focused.id, params };
        const open = tabOfKind(s, "projects");
        if (open) return sameParams(open.params, params) ? { kind: "focus", tab: open.id } : { kind: "focus", tab: open.id, params };
        return { kind: "open", tabKind: "projects", params };
      }
      return { kind: "none" };
    }
    case "none":
    case "compose": {
      const params = composeParamsOf(sel.kind === "none" ? HOME : sel);
      // The empty space shows the home composer without a tab.
      if (!focused && Object.keys(params).length === 0) return { kind: "stay" };
      if (focused?.kind === "compose" && sameParams(focused.params, params)) return { kind: "stay" };
      return { kind: "command", name: "composer.new", args: { ...params, focus: "true" }, params };
    }
  }
}

/** Selections in flight: while one runs, the bridge does not mirror the layout's focus over it. */
let routing = 0;

/** Writes the selection from the focused tab (unless a routed selection is still running). */
function mirror(opts: { focusPrompt?: boolean } = {}): void {
  if (routing > 0) return;
  const s = useLayoutStore.getState();
  if (!s.loaded) return;
  const next = selectionOfTab(focusedTab(s));
  if (!sameSelection(useUiStore.getState().selection, next) || opts.focusPrompt) mirrorSelection(next, opts);
}

/** Runs a route; the rev of the commit that opened a tab, when it was a command that did (null otherwise). */
async function run(action: RouteAction): Promise<number | null> {
  switch (action.kind) {
    case "stay":
    case "none":
      return null;
    case "command": {
      const res = await runLayoutCommand(action.name, action.args);
      // New thread focuses the space's empty composer: it now starts from what was picked.
      if (res?.tab && action.params) await applyLayoutOp({ op: "set_tab_params", tab: res.tab, params: action.params });
      return res?.rev ?? null;
    }
    case "focus":
      await focusTabNow(action.tab);
      if (action.params) await applyLayoutOp({ op: "set_tab_params", tab: action.tab, params: action.params });
      return null;
    case "params":
      await applyLayoutOp({ op: "set_tab_params", tab: action.tab, params: action.params });
      return null;
    case "open":
      await applyLayoutOp({ op: "open_surface", tab: { kind: action.tabKind, params: action.params }, focus: true });
      return null;
  }
}

/**
 * Takes a select() to the layout. The selection is set at once (the reader sees what was asked
 * for), the layout follows, and then the selection is mirrored from it again (a refused open puts
 * back what the window shows).
 */
export function routeSelect(sel: Selection, opts: SelectOptions): boolean {
  const s = useLayoutStore.getState();
  if (!s.loaded) return false;
  const action = planRoute(sel, s, opts, emberThreadOf(useThreadsStore.getState()));
  if (action.kind === "none") return false;
  mirrorSelection(sel, { focusPrompt: opts.focusPrompt });
  if (action.kind === "stay") return true;
  routing++;
  void run(action)
    .then(async (rev) => {
      // The prompt asked for (a sidebar click) is the new tab's: it takes the keyboard once its
      // pane draws it. Asked for at once, it reached the tab that was still showing.
      if (!opts.focusPrompt || rev === null) return;
      await afterRev(rev);
      const s = useLayoutStore.getState();
      const pane = s.spaces[s.currentSpaceId]?.focus ?? "";
      if (pane) requestPaneFocus(pane);
    })
    .catch(() => {
      // A refusal was toasted by the command; the selection goes back to the layout's.
    })
    .finally(() => {
      routing--;
      mirror();
    });
  return true;
}

/**
 * Starts the bridge (the shell draws the window): select() goes through the layout, and the
 * selection follows the current space's focused tab. Returns the stop.
 */
export function startSelectionBridge(): () => void {
  setSelectRoute(routeSelect);
  const unsub = useLayoutStore.subscribe((s, prev) => {
    if (s.currentSpaceId === prev.currentSpaceId && s.spaces === prev.spaces && s.panes === prev.panes && s.tabs === prev.tabs && s.loaded === prev.loaded) return;
    mirror();
  });
  // A thread selected before the shell first drew (a sidebar click or a thread.focus while the
  // first-load import ran) opens now, as it would have; otherwise the selection follows the layout.
  const early = useUiStore.getState().selection;
  if (early.kind !== "thread" || !routeSelect(early, { focusPrompt: true })) mirror();
  return () => {
    unsub();
    setSelectRoute(null);
  };
}
