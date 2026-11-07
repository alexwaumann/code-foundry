/**
 * Panel actions scoped to one thread: a UiIntent.ShowView with a thread id, which the
 * view.panel.* verbs send when the model in a thread runs them
 * (docs/notes/control-1-thread-scoped-views.md, control-5-fixes.md). Each applies to
 * that thread's panel entry (`thread:<id>`, stores/panel.ts) and never changes the
 * window's selection: with the thread selected the change shows at once, otherwise it is
 * there when the user opens the thread.
 *
 * Unlike the window's own panel commands (stores/views.ts), they never take keyboard
 * focus (the user may be typing in another thread's prompt), never toast (about a thread
 * the user is not looking at it would puzzle them; the action is just a no-op), and apply
 * under a sheet (Settings, Themes, Usage), since what they change is the thread's panel,
 * not the screen.
 *
 * The item actions (panel.file, panel.diff, panel.pr, panel.gallery) open what their params
 * name; the daemon checked it exists first (internal/command/commands_view_items.go). The one thing
 * here that may take the keyboard is a request to edit a file with --focus: the daemon
 * sends focus=1 only then, and only because the user asked to be taken there. Without it, a
 * request that would replace the editor the user is typing in joins the strip behind it.
 */
import { COMMITTED_HEAD, DEFAULT_BASE, DEFAULT_HEAD, diffOfTab, diffTab, sourceOfParam } from "@/surfaces/diffTarget";
import { fileTab, type FileTarget } from "@/surfaces/fileTarget";
import { galleryTab } from "@/surfaces/galleryTarget";
import { openBrowserSurface } from "./browser";
import { editorHasKeyboard, fileEditKey, focusEditorLine } from "./fileEdit";
import { openDiffInPanel, openFileInPanel } from "./filePanel";
import { openMcpSurface } from "./mcpPanel";
import { allTabs, expandPanel, getPanel, isSplit, keyOf, openSurface, splitPanel, startPanelPicking, togglePanel, unsplitPanel } from "./panel";
import { openPullRequestInPanel } from "./prPanel";
import { useThreadsStore } from "./threads";
import type { Selection } from "./ui";

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

let asks = 0;

/** A new request's id, kept in its tab across a reload. */
function nextAskId(): string {
  asks += 1;
  return `${Date.now().toString(36)}-${String(asks)}`;
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
  "panel.mcp": surface(openMcpSurface),
  // view.panel.browser: param url, already past the daemon's address rule.
  "panel.browser": (sel, _key, p) => surface((s) => openBrowserSurface(s, p.url ?? ""))(sel, _key, p),
  // view.panel.file: params path (absolute), line, project and base; view.panel.page adds
  // page=1 and its title (the tab is the thread's page, surfaces/fileTarget.ts); --edit adds
  // edit=1 and thread (who asked), with note and focus when they apply.
  "panel.file": item((key, p) => {
    if (!p.path) return false;
    const line = positive(p.line);
    const file: FileTarget = {
      project: p.project ?? "",
      base: p.base ?? "",
      path: p.path,
      ...(line === undefined ? {} : { line }),
      ...(p.page === "1" ? { page: { title: p.title ?? "" } } : {}),
      ...(p.edit === "1" ? { edit: true, ask: { id: nextAskId(), thread: p.thread ?? "", note: p.note ?? "" } } : {}),
    };
    const tabId = fileTab(file).id;
    const behind = p.edit === "1" && p.focus !== "1" && editorHasKeyboard(key, tabId);
    if (!openFileInPanel(key, file, { behind })) return false;
    if (p.focus === "1") focusEditorLine(fileEditKey(key, tabId), line);
    return true;
  }),
  // view.panel.diff: params project and worktree, then what the call set (commands_view_diff.go).
  // The checkout's own tab is the user's: a call without `thread` only picks its file, and what
  // they compare, filter and fold stays. The daemon gives a call that names a side a tab of its
  // own; an older one, until it restarts, sends scope and no thread, which stays a file pick here.
  // A thread's own tab (thread) is the call's.
  "panel.diff": item((key, p) => {
    if (!p.project || !p.worktree) return false;
    const fromScope = p.scope === "branch" ? COMMITTED_HEAD : DEFAULT_HEAD;
    const shown = diffOfTab({ params: p });
    if (!shown) return false;
    const asked = {
      ...shown,
      base: sourceOfParam(p.base, DEFAULT_BASE),
      head: sourceOfParam(p.head, fromScope),
      own: p.own === "1" || p.scope !== undefined,
    };
    const fresh = diffTab(asked);
    const open = allTabs(getPanel(key)).find((t) => t.id === fresh.id);
    const was = open && !p.thread ? diffOfTab(open) : null;
    // The file was found in the sides the tab came from, not in a commit the user was looking at.
    const back = was?.commit && asked.file ? { base: was.commit.base, head: was.commit.head, commit: undefined } : {};
    if (open && was) return openDiffInPanel(key, { ...was, ...back, own: asked.own, ...(asked.file ? { file: asked.file, oldPath: asked.oldPath } : {}) }, open.title);
    return openDiffInPanel(key, asked);
  }),
  // view.panel.pr: params slug and number.
  "panel.pr": item((key, p) => {
    const number = positive(p.number);
    if (!p.slug?.includes("/") || number === undefined) return false;
    return openPullRequestInPanel({ slug: p.slug, number }, key);
  }),
  // view.panel.gallery: params title, images (JSON), project and base. The same title is the same tab.
  "panel.gallery": item((key, p) => {
    const tab = galleryTab(p);
    return tab !== null && openSurface(key, tab);
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
