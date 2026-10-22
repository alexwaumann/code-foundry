/**
 * Panel actions scoped to one thread: a UiIntent.ShowView with a thread id, which the
 * view.panel.* verbs send when the model in a thread runs them
 * (docs/notes/control-1-thread-scoped-views.md). Each applies to that thread's panel
 * entry (`thread:<id>`, stores/panel.ts) and never changes the window's selection: with
 * the thread selected the change shows at once, otherwise it is there when the user
 * opens the thread.
 *
 * Unlike the window's own panel commands (stores/views.ts), they never take keyboard
 * focus (the user may be typing in another thread's prompt), never toast (a "No linked
 * PRs yet" about a thread the user is not looking at would puzzle them; the action is
 * just a no-op), and apply while the settings or usage page is up, since what they change
 * is the thread's panel, not the screen.
 */
import { openAgentsSurface } from "./agentsPanel";
import { openLinkedPrsSurface } from "./linkedPrsPanel";
import { openMcpSurface } from "./mcpPanel";
import { expandPanel, getPanel, isSplit, keyOf, splitPanel, startPanelPicking, togglePanel, unsplitPanel } from "./panel";
import { useThreadsStore } from "./threads";
import { openThreadsSurface } from "./threadsPanel";
import type { Selection } from "./ui";
import { openUsageSurface } from "./usagePanel";
import { openWorkspaceSurface } from "./workspacePanel";
import { openWorktreeSurface } from "./worktreePanel";

/** One panel action on a thread's panel `key` (its selection is `sel`); false when it did nothing. */
type ThreadPanelAction = (sel: Selection, key: string) => boolean;

/** Opens a surface's tab with `open` (null: the thread cannot show it) and shows the panel, without focus. */
function surface(open: (sel: Selection) => string | null): ThreadPanelAction {
  return (sel) => {
    const key = open(sel);
    if (key === null) return false;
    togglePanel(key, true, { focus: false });
    return true;
  };
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
};

/**
 * Applies a thread-scoped ShowView: the panel action `name` on thread `threadId`'s panel,
 * the window's selection untouched. False (and nothing changes) for a name that is no
 * panel action, a thread the window does not know, or a surface the thread cannot show.
 */
export function showThreadView(name: string, threadId: string): boolean {
  const act = actions[name];
  if (act === undefined || !(threadId in useThreadsStore.getState().byId)) return false;
  const sel: Selection = { kind: "thread", id: threadId };
  const key = keyOf(sel);
  return key !== null && act(sel, key);
}
