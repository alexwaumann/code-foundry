/**
 * Window-level views that are not selections: the settings, usage and themes pages (each replaces
 * the content area; at most one is open) and the help overlay. Top-level pages that are selections (ui.ts `viewNames`,
 * the Pull Requests page) are routed to `select`. Opened by view.settings / view.help (their chords are
 * presented locally, see keys/bindings.ts) or by a UiIntent.ShowView from the daemon. The
 * window's own settings and usage keys and buttons toggle (toggleView); a ShowView only shows.
 */
import { toast } from "sonner";
import { create } from "zustand";
import { bottomKeyOf, bottomVisible, getBottom, toggleBottom } from "./bottomPanel";
import { linkedPrsTarget, openLinkedPrsSurface } from "./linkedPrsPanel";
import { expandPanel, getPanel, isSplit, splitPanel, startPanelPicking, togglePanel, unsplitPanel } from "./panel";
import { useUiStore, viewNames, type FocusRegion } from "./ui";
import { agentsPanelTarget, openAgentsSurface } from "./agentsPanel";
import { openMcpSurface } from "./mcpPanel";
import { parsePluginView, showPluginView } from "./pluginPanel";
import { leaveSubagent } from "./subagentView";
import { jumpToNeighbour } from "./threadNeighbours";
import { openThreadsSurface, threadsPanelTarget } from "./threadsPanel";
import { openUsageSurface } from "./usagePanel";
import { openWorkspaceSurface } from "./workspacePanel";
import { openWorktreeSurface } from "./worktreePanel";
import { resetThemePicker, setPickerSlot, useThemePickerStore, type ThemeSlot } from "./themePicker";

interface ViewsState {
  settingsOpen: boolean;
  /**
   * The settings page's current page (SettingPageView.id). Opening settings lands on
   * General; coming back from the Themes page keeps the page it was opened from.
   */
  settingsPage: string;
  /** The Usage page (view.usage, docs/notes/session-usage.md). Never open with settings. */
  usageOpen: boolean;
  /** The Themes page (theme.pick, docs/notes/theme-engine-4-picker.md). Never open with settings or usage. */
  themesOpen: boolean;
  helpOpen: boolean;
  /** The help overlay's tab. Opening it lands on the guide unless a caller asks for the shortcuts. */
  helpTab: HelpTab;
}

/** The help overlay's tabs: the getting started guide (docs/GETTING-STARTED.md) and the keyboard shortcuts. */
export type HelpTab = "guide" | "shortcuts";

/** The settings page opening on: General. */
export const SETTINGS_FIRST_PAGE = "general";

export const useViewsStore = create<ViewsState>()(() => ({
  settingsOpen: false,
  settingsPage: SETTINGS_FIRST_PAGE,
  usageOpen: false,
  themesOpen: false,
  helpOpen: false,
  helpTab: "guide",
}));

/**
 * A window-level page (settings or usage) covers the content area. It hides the side
 * panel, so the panel commands are no-ops meanwhile.
 */
export function selectPageOpen(s: ViewsState): boolean {
  return s.settingsOpen || s.usageOpen || s.themesOpen;
}

function pageOpen(): boolean {
  return selectPageOpen(useViewsStore.getState());
}

/** Whether the current selection's side panel is open and expanded over the content column. */
function sideExpanded(): boolean {
  const side = getPanel();
  return side.open && (side.expanded ?? false);
}

/** The key whose bottom panel is on screen now (bottomVisible, read imperatively), or null. */
export function visibleBottomKey(): string | null {
  const key = bottomKeyOf(useUiStore.getState().selection);
  return key !== null && bottomVisible(key, getBottom(key).open, pageOpen(), sideExpanded()) ? key : null;
}

/**
 * Whether a key's bottom panel would be on screen if it were open: no settings or usage
 * page is up and the side panel is not expanded over the content column.
 */
export function bottomCanShow(key: string): boolean {
  return bottomVisible(key, true, pageOpen(), sideExpanded());
}

/**
 * The window's own settings and usage keys and sidebar buttons (keys/bindings.ts): a
 * toggle, closing the page that is already open. The daemon's ShowView only shows
 * (showView), since "Show the Usage page" from the CLI or a thread must not close it.
 */
export function toggleView(name: "settings" | "usage"): boolean {
  const v = useViewsStore.getState();
  if (name === "settings" && v.settingsOpen) closeSettings();
  else if (name === "usage" && v.usageOpen) closeUsage();
  else return showView(name);
  return true;
}

/**
 * Shows a named view (UiIntent.ShowView.name). Returns false for an unknown name. Pages
 * only show: one already open stays (toggleView is the window's own toggle).
 */
export function showView(name: string): boolean {
  switch (name) {
    case "settings":
      // Already open: stays on the page it shows.
      if (!useViewsStore.getState().settingsOpen) {
        useViewsStore.setState({ settingsOpen: true, settingsPage: SETTINGS_FIRST_PAGE, usageOpen: false, themesOpen: false, helpOpen: false });
      }
      return true;
    case "usage":
      useViewsStore.setState({ usageOpen: true, settingsOpen: false, themesOpen: false, helpOpen: false });
      return true;
    case "themes":
    case "themes.dark":
    case "themes.light":
      // theme.pick: opens (not a toggle; Esc and × close it), or moves the open page to
      // the slot asked for. Opened from a Settings row, closing goes back to Settings.
      openThemes(name === "themes" ? undefined : name === "themes.dark" ? "dark" : "light");
      return true;
    case "help":
      openHelp();
      return true;
    case "panel.toggle":
      // view.panel.toggle: an action on the current selection's side panel, not a page.
      togglePanelCommand();
      return true;
    case "panel.expand":
      // view.panel.expand: like panel.toggle, an action on the current selection's panel.
      expandPanelCommand();
      return true;
    case "panel.new-tab":
      // view.panel.new-tab: the surface list in the current selection's panel (its "+").
      newPanelTabCommand();
      return true;
    case "panel.split":
      // view.panel.split: splits or joins the current selection's panel's tab groups.
      splitPanelCommand();
      return true;
    case "panel.workspace":
      // view.panel.workspace: the workspace surface in the current workspace thread's panel.
      workspacePanelCommand();
      return true;
    case "panel.linked-prs":
      // view.panel.linked-prs: the Linked PRs surface in the current thread's panel.
      linkedPrsPanelCommand();
      return true;
    case "panel.usage":
      // view.panel.usage: the Usage surface in the current thread's panel.
      usagePanelCommand();
      return true;
    case "panel.mcp":
      // view.panel.mcp: the MCP surface in the current thread's panel.
      mcpPanelCommand();
      return true;
    case "panel.agents":
      // view.panel.agents: the Agents surface in the current thread's panel.
      agentsPanelCommand();
      return true;
    case "panel.threads":
      // view.panel.threads: the Threads surface (lineage) in the current thread's panel.
      threadsPanelCommand();
      return true;
    case "panel.worktree":
      // view.panel.worktree: the thread's own worktree in the current thread's panel.
      worktreePanelCommand();
      return true;
    case "bottom.toggle":
      // view.bottom.toggle: the current selection's bottom terminal panel.
      toggleBottomCommand();
      return true;
    case "agent.up":
      // thread.agent.up from the CLI: out of the subagent view, back to its thread.
      leaveSubagent();
      return true;
    case "back":
      // view.back: the selection before this one in the window's history.
      historyCommand(-1);
      return true;
    case "forward":
      // view.forward: the selection after this one, after going back.
      historyCommand(1);
      return true;
    case "thread.previous":
      // thread.previous: the thread above the current one in the sidebar, wrapping.
      jumpToNeighbour(-1);
      return true;
    case "thread.next":
      // thread.next: the thread below the current one in the sidebar, wrapping.
      jumpToNeighbour(1);
      return true;
    default:
      // A plugin surface's show command (stores/pluginPanel.ts): a page would hide the panel.
      if (parsePluginView(name)) {
        useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
        return showPluginView(name);
      }
      // Top-level pages (the Pull Requests page) are selections. Closing settings and
      // usage here too covers re-selecting the page that is already selected.
      if (!viewNames.includes(name)) return false;
      useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
      useUiStore.getState().select({ kind: "view", name });
      return true;
  }
}

/**
 * view.back (-1) and view.forward (1): steps through the window's selection history
 * (stores/ui.ts back/forward). The settings, usage and themes pages are not selections, so
 * not history entries: back with one of them up closes it like its Esc or × (the Themes
 * page opened from Settings goes back to Settings), revealing what was on screen before
 * it, and does not step. Stepping to another selection closes such a page anyway
 * (startViewSync). Returns whether anything changed.
 */
export function historyCommand(by: 1 | -1): boolean {
  if (by === -1) {
    const v = useViewsStore.getState();
    const close = v.themesOpen ? closeThemes : v.settingsOpen ? closeSettings : v.usageOpen ? closeUsage : null;
    if (close) {
      close();
      return true;
    }
  }
  const ui = useUiStore.getState();
  return by === -1 ? ui.back() : ui.forward();
}

/**
 * view.panel.toggle for the current selection. A no-op while the settings or usage page is up: it
 * hides the panel, so a toggle there would flip state the user cannot see.
 *
 * Focus: toggling on focuses the panel. Hiding the panel while it has focus hands focus
 * to the content pane (a thread's prompt, or the page's focus root). With the palette open
 * (the command was picked there), focus is the palette's, so the palette's return target
 * is what moves: to the panel when it opens, off it when it hides.
 */
export function togglePanelCommand(): boolean {
  if (pageOpen()) return getPanel().open;
  const ui = useUiStore.getState();
  const inPalette = ui.palette.open;
  const from: FocusRegion = inPalette ? ui.palette.returnTo : ui.focus;
  const open = togglePanel("current", undefined, { focus: !inPalette });
  if (inPalette) {
    const returnTo: FocusRegion = open ? "panel" : from === "panel" ? "content" : from;
    useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo } }));
  } else if (!open && from === "panel") {
    ui.focusContent();
  }
  return open;
}

/**
 * view.bottom.toggle for the current selection (a thread or the Projects page; other
 * selections have no bottom panel and it does nothing). A no-op while the settings or
 * usage page is up, or while the side panel fills the content area: both hide the bottom
 * panel, so a toggle there would flip state the user cannot see.
 *
 * Focus works like view.panel.toggle: showing focuses the panel (its active terminal, else
 * the panel), hiding it while it has focus hands focus to the content pane, and with the
 * palette open its return target moves instead.
 *
 * This is the plain toggle, which the CLI's ShowView reaches in every window. This
 * window's own cmd+j, header button and palette go through toggleBottomFromHere
 * (stores/bottomActions.ts), which starts a shell when the panel would open empty.
 */
export function toggleBottomCommand(): boolean {
  const ui = useUiStore.getState();
  const key = bottomKeyOf(ui.selection);
  if (key === null) return false;
  // Whether it could show if open: otherwise a toggle flips state nobody sees.
  if (!bottomCanShow(key)) return getBottom().open;
  const inPalette = ui.palette.open;
  const from: FocusRegion = inPalette ? ui.palette.returnTo : ui.focus;
  const open = toggleBottom("current", undefined, { focus: !inPalette });
  if (inPalette) {
    const returnTo: FocusRegion = open ? "bottom" : from === "bottom" ? "content" : from;
    useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo } }));
  } else if (!open && from === "bottom") {
    ui.focusContent();
  }
  return open;
}

/**
 * view.panel.expand for the current selection: flips its panel between the split and the
 * full width of the content area. A hidden panel is shown expanded. A no-op while the
 * settings or usage page is up (it hides the panel) and with nothing selected.
 *
 * Focus stays where it was, unless it was in the content pane, which expanding hides:
 * then it moves to the panel. With the palette open, its return target moves instead.
 * Restoring the split leaves focus alone (in the panel, typically).
 */
export function expandPanelCommand(): boolean {
  if (pageOpen()) {
    const e = getPanel();
    return e.open && (e.expanded ?? false);
  }
  const ui = useUiStore.getState();
  const inPalette = ui.palette.open;
  const from: FocusRegion = inPalette ? ui.palette.returnTo : ui.focus;
  // Expanding hides the content column, the bottom panel with it.
  const fromContent = from === "content" || from === "bottom";
  const expanded = expandPanel("current", getPanel().open ? undefined : true, { focus: fromContent && !inPalette });
  if (inPalette && expanded && fromContent) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return expanded;
}

/**
 * view.panel.new-tab for the current selection (the "+" after the panel's tabs): shows
 * its panel if hidden, with the surface list ("Open a surface") instead of the active
 * tab (stores/panel.ts startPicking). No tab is added until a surface is picked; Escape
 * goes back. A panel without tabs shows the list anyway, so it is only shown. A no-op
 * while the settings or usage page is up and with nothing selected. In a split panel it
 * picks in the focused group; a group's own "+" focuses that group before it runs.
 *
 * Focus moves to the panel, like toggling it on, so Escape and the surface letters work
 * at once; with the palette open, its return target moves there instead.
 */
export function newPanelTabCommand(): boolean {
  if (pageOpen()) return false;
  const inPalette = useUiStore.getState().palette.open;
  if (!startPanelPicking("current", { focus: !inPalette })) return false;
  if (inPalette) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return true;
}

/**
 * view.panel.split for the current selection: splits its panel into two tab groups
 * (stores/panel.ts split: the active tab moves into the new second group; with a single
 * tab the new group starts on its surface list), or joins a split panel's groups back
 * into one (unsplit). A hidden panel is shown, split: a hidden split panel just shows,
 * since joining groups the user cannot see would be a surprise. A panel without tabs has
 * nothing to split (it is only shown). A no-op while the settings or usage page is up and
 * with nothing selected. Returns whether the panel is split afterwards.
 *
 * Focus: splitting moves it to the panel (the new group is the focused one), like
 * view.panel.new-tab; with the palette open, its return target moves there instead.
 * Joining keeps focus in the panel when it was there (the second group's strip is gone).
 */
export function splitPanelCommand(): boolean {
  if (pageOpen()) return false;
  const ui = useUiStore.getState();
  const inPalette = ui.palette.open;
  const e = getPanel();
  if (e.open && isSplit(e)) {
    unsplitPanel("current");
    if (!inPalette && ui.focus === "panel") useUiStore.setState((s) => ({ panelFocusSeq: s.panelFocusSeq + 1 }));
    return false;
  }
  const split = splitPanel("current", { focus: !inPalette });
  if (inPalette && getPanel().open) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return split;
}

/**
 * view.panel.workspace for the current selection: opens (or activates) the workspace
 * surface's tab in the selected workspace thread's panel and shows the panel. A no-op
 * while the settings or usage page is up and when the selection is no workspace thread (a window
 * reached through the CLI's ShowView may have anything selected).
 *
 * Focus moves to the panel, like toggling it on; with the palette open, its return target
 * moves there instead.
 */
export function workspacePanelCommand(): boolean {
  if (pageOpen()) return false;
  const key = openWorkspaceSurface();
  if (key === null) return false;
  const inPalette = useUiStore.getState().palette.open;
  togglePanel(key, true, { focus: !inPalette });
  if (inPalette) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return true;
}

/**
 * view.panel.worktree for the current selection: opens (or activates) the worktree tab of
 * the selected thread's own worktree in its panel and shows the panel,
 * like view.panel.workspace. A no-op while the settings or usage page is up and when the selection
 * is not in a registered worktree (a page, a composer, a thread whose cwd is elsewhere).
 *
 * Focus moves to the panel; with the palette open, its return target moves there instead.
 */
export function worktreePanelCommand(): boolean {
  if (pageOpen()) return false;
  const key = openWorktreeSurface();
  if (key === null) return false;
  const inPalette = useUiStore.getState().palette.open;
  togglePanel(key, true, { focus: !inPalette });
  if (inPalette) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return true;
}

/**
 * view.panel.linked-prs for the current selection: opens (or activates) the Linked PRs tab
 * in the selected thread's panel and shows the panel, like view.panel.workspace. A thread
 * without linked pull requests gets a brief "No linked PRs yet" toast instead. A no-op
 * while the settings or usage page is up and when the selection is no thread.
 *
 * Focus moves to the panel; with the palette open, its return target moves there instead.
 */
export function linkedPrsPanelCommand(): boolean {
  if (pageOpen()) return false;
  const target = linkedPrsTarget();
  if (target !== "linked") {
    if (target === "none") toast("No linked PRs yet", { description: "Pull requests this thread creates or mentions show up here." });
    return false;
  }
  const key = openLinkedPrsSurface();
  if (key === null) return false;
  const inPalette = useUiStore.getState().palette.open;
  togglePanel(key, true, { focus: !inPalette });
  if (inPalette) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return true;
}

/**
 * view.panel.usage for the current selection: opens (or activates) the Usage tab in the
 * selected thread's panel and shows the panel, like view.panel.workspace. A thread
 * without usage opens it too (the surface says "No usage yet"). A no-op while the
 * settings or usage page is up and when the selection is no thread.
 *
 * Focus moves to the panel; with the palette open, its return target moves there instead.
 */
export function usagePanelCommand(): boolean {
  if (pageOpen()) return false;
  const key = openUsageSurface();
  if (key === null) return false;
  const inPalette = useUiStore.getState().palette.open;
  togglePanel(key, true, { focus: !inPalette });
  if (inPalette) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return true;
}

/**
 * view.panel.mcp for the current selection: opens (or activates) the MCP tab in the
 * selected thread's panel and shows the panel, like view.panel.usage. A no-op
 * while the settings or usage page is up and when no thread is selected.
 *
 * Focus moves to the panel; with the palette open, its return target moves there instead.
 */
export function mcpPanelCommand(): boolean {
  if (pageOpen()) return false;
  const key = openMcpSurface();
  if (key === null) return false;
  const inPalette = useUiStore.getState().palette.open;
  togglePanel(key, true, { focus: !inPalette });
  if (inPalette) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return true;
}

/**
 * view.panel.agents for the current selection: opens (or activates) the Agents tab in the
 * selected thread's panel and shows the panel, like view.panel.mcp. A thread without
 * subagent runs (the surface is hidden) gets a brief "No agents yet" toast instead, like
 * view.panel.linked-prs. A no-op while the settings or usage page is up and when no
 * thread is selected.
 *
 * Focus moves to the panel; with the palette open, its return target moves there instead.
 */
export function agentsPanelCommand(): boolean {
  if (pageOpen()) return false;
  const target = agentsPanelTarget();
  if (target !== "agents") {
    if (target === "none") toast("No agents yet", { description: "Claude's subagents (the Agent tool) show here as they run." });
    return false;
  }
  const key = openAgentsSurface();
  if (key === null) return false;
  const inPalette = useUiStore.getState().palette.open;
  togglePanel(key, true, { focus: !inPalette });
  if (inPalette) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return true;
}

/**
 * view.panel.threads for the current selection: opens (or activates) the Threads tab in
 * the selected thread's panel and shows the panel, like view.panel.agents. A thread
 * without lineage (no creator, siblings or children: the surface is hidden) gets a brief
 * "No related threads" toast instead. A no-op while the settings or usage page is up and
 * when no thread is selected.
 *
 * Focus moves to the panel; with the palette open, its return target moves there instead.
 */
export function threadsPanelCommand(): boolean {
  if (pageOpen()) return false;
  const target = threadsPanelTarget();
  if (target !== "related") {
    if (target === "none") toast("No related threads", { description: "Threads an agent here creates (code-foundry thread new) show up here." });
    return false;
  }
  const key = openThreadsSurface();
  if (key === null) return false;
  const inPalette = useUiStore.getState().palette.open;
  togglePanel(key, true, { focus: !inPalette });
  if (inPalette) useUiStore.setState((s) => ({ palette: { ...s.palette, returnTo: "panel" } }));
  return true;
}

/** Asks the selected thread's prompt for the keyboard; nothing when no thread is selected. */
function requestPromptFocus(): void {
  if (useUiStore.getState().selection.kind === "thread") useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
}

/** Shows a page of the open settings page (its left nav). */
export function setSettingsPage(page: string): void {
  useViewsStore.setState({ settingsPage: page });
}

export function closeSettings(): void {
  useViewsStore.setState({ settingsOpen: false });
  // Back to what was selected; a thread's prompt takes focus again.
  requestPromptFocus();
}

/**
 * Opens the Themes page editing `slot` (the slot in use when omitted), with no preview.
 * `from: "settings"` (the Choose… buttons in Settings → Appearance) makes closing it go
 * back to the settings page. On a page already open, only the slot changes.
 */
export function openThemes(slot?: ThemeSlot, from?: "settings"): void {
  const views = useViewsStore.getState();
  if (views.themesOpen) {
    if (slot) setPickerSlot(slot);
    return;
  }
  resetThemePicker(slot, from ?? (views.settingsOpen ? "settings" : null));
  useViewsStore.setState({ themesOpen: true, settingsOpen: false, usageOpen: false, helpOpen: false });
}

/** Leaves the Themes page, dropping its preview; back to Settings when it came from there. */
export function closeThemes(): void {
  const back = useThemePickerStore.getState().returnTo === "settings";
  resetThemePicker(undefined, null);
  useViewsStore.setState({ themesOpen: false, settingsOpen: back });
  if (!back) requestPromptFocus();
}

export function closeUsage(): void {
  useViewsStore.setState({ usageOpen: false });
  // Like closeSettings: back to the selection, whose prompt takes focus again.
  requestPromptFocus();
}

/** view.help (cmd+/): closes the help overlay, or opens it on the guide. */
export function toggleHelp(): void {
  if (useViewsStore.getState().helpOpen) setHelpOpen(false);
  else openHelp();
}

/**
 * Opens the help overlay on a tab (the guide by default), or switches the open overlay
 * to it: Help > Getting Started, Help > Keyboard Shortcuts and Help, and the start page's
 * Keyboard Shortcuts link.
 */
export function openHelp(tab: HelpTab = "guide"): void {
  useViewsStore.setState({ helpOpen: true, helpTab: tab });
}

export function setHelpOpen(open: boolean): void {
  useViewsStore.setState({ helpOpen: open });
}

export function setHelpTab(tab: HelpTab): void {
  useViewsStore.setState({ helpTab: tab });
}

/** Selecting something in the sidebar leaves the settings or usage page. */
export function startViewSync(): () => void {
  return useUiStore.subscribe((s, prev) => {
    if (s.selection !== prev.selection && pageOpen()) useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false });
  });
}
