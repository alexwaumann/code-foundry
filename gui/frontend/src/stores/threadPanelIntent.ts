/**
 * Panel actions scoped to one thread: a UiIntent.ShowView with a thread id, which the
 * view.panel.* verbs send when the model in a thread runs them
 * (docs/notes/control-1-thread-scoped-views.md, control-5-fixes.md). Each applies to
 * that thread's panel entry (`thread:<id>`, stores/panel.ts) and never changes the
 * window's selection: with the thread selected the change shows at once, otherwise it is
 * there when the user opens the thread.
 *
 * Unlike the window's own panel commands (stores/views.ts), they never take keyboard
 * focus (the user may be typing in another thread's prompt), never toast (a "No linked
 * PRs yet" about a thread the user is not looking at would puzzle them; the action is
 * just a no-op), and apply while the settings or usage page is up, since what they change
 * is the thread's panel, not the screen.
 *
 * The item actions (panel.file, panel.diff, panel.pr) open what their params name; the
 * daemon checked it exists first (internal/command/commands_view_items.go).
 */
import type { DiffScopeView } from "@/api/fileDiff";
import { openAgentsSurface } from "./agentsPanel";
import { openDiffInPanel, openFileInPanel } from "./filePanel";
import { openLinkedPrsSurface } from "./linkedPrsPanel";
import { openMcpSurface } from "./mcpPanel";
import { expandPanel, getPanel, isSplit, keyOf, splitPanel, startPanelPicking, togglePanel, unsplitPanel } from "./panel";
import { openPullRequestInPanel } from "./prPanel";
import { useThreadsStore } from "./threads";
import { openThreadsSurface } from "./threadsPanel";
import type { Selection } from "./ui";
import { openUsageSurface } from "./usagePanel";
import { openWorkspaceSurface } from "./workspacePanel";
import { openWorktreeSurface } from "./worktreePanel";

/** A ShowView's params: what an item action opens. */
type Params = Readonly<Record<string, string>>;

/** One panel action on a thread's panel `key` (its selection is `sel`); false when it did nothing. */
type ThreadPanelAction = (sel: Selection, key: string, params: Params) => boolean;

/** Opens a surface's tab with `open` (null: the thread cannot show it) and shows the panel, without focus. */
function surface(open: (sel: Selection) => string | null): ThreadPanelAction {
  return (sel) => {
    const key = open(sel);
    if (key === null) return false;
    togglePanel(key, true, { focus: false });
    return true;
  };
}

/** Opens an item's tab with `open` (false: the params name none) and shows the panel, without focus. */
function item(open: (key: string, params: Params) => boolean): ThreadPanelAction {
  return (_sel, key, params) => {
    if (!open(key, params)) return false;
    togglePanel(key, true, { focus: false });
    return true;
  };
}

/** A positive whole number from a param, else undefined. */
function positive(v: string | undefined): number | undefined {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : undefined;
}

/** The panel actions by ShowView name: the view.panel.* verbs' (internal/command/commands_view.go). */
const actions: Readonly<Record<string, ThreadPanelAction>> = {
  "panel.toggle": (_sel, key) => {
    togglePanel(key, undefined, { focus: false });
    return true;
  },
  // Like expandPanelCommand: a hidden panel is shown expanded, a shown one flips.
  "panel.expand": (_sel, key) => {
    expandPanel(key, getPanel(key).open ? undefined : true);
    return true;
  },
  "panel.new-tab": (_sel, key) => startPanelPicking(key, { focus: false }),
  // Like splitPanelCommand: a shown split panel joins, anything else is shown split.
  "panel.split": (_sel, key) => {
    const e = getPanel(key);
    if (e.open && isSplit(e)) unsplitPanel(key);
    else splitPanel(key, { focus: false });
    return true;
  },
  "panel.workspace": surface(openWorkspaceSurface),
  "panel.worktree": surface(openWorktreeSurface),
  "panel.linked-prs": surface(openLinkedPrsSurface),
  "panel.usage": surface(openUsageSurface),
  "panel.mcp": surface(openMcpSurface),
  "panel.agents": surface(openAgentsSurface),
  "panel.threads": surface(openThreadsSurface),
  // view.panel.file: params path (absolute), line, project and base.
  "panel.file": item((key, p) => {
    if (!p.path) return false;
    const line = positive(p.line);
    return openFileInPanel(key, { project: p.project ?? "", base: p.base ?? "", path: p.path, ...(line === undefined ? {} : { line }) });
  }),
  // view.panel.diff: params project, worktree, path (worktree-relative) and scope.
  "panel.diff": item((key, p) => {
    if (!p.project || !p.worktree || !p.path) return false;
    const scope: DiffScopeView = p.scope === "branch" ? "branch" : "working";
    return openDiffInPanel(key, { project: p.project, worktree: p.worktree, path: p.path, oldPath: "", scope });
  }),
  // view.panel.pr: params slug and number.
  "panel.pr": item((key, p) => {
    const number = positive(p.number);
    if (!p.slug?.includes("/") || number === undefined) return false;
    return openPullRequestInPanel({ slug: p.slug, number }, key);
  }),
};

/**
 * Applies a thread-scoped ShowView: the panel action `name` on thread `threadId`'s panel,
 * the window's selection untouched. False (and nothing changes) for a name that is no
 * panel action, a thread the window does not know, a surface the thread cannot show, or
 * item params that name nothing.
 */
export function showThreadView(name: string, threadId: string, params: Params = {}): boolean {
  const act = actions[name];
  if (act === undefined || !(threadId in useThreadsStore.getState().byId)) return false;
  const sel: Selection = { kind: "thread", id: threadId };
  const key = keyOf(sel);
  return key !== null && act(sel, key, params);
}
