/**
 * Window-level views that are not selections: the settings and themes sheet (one modal
 * over the window showing Settings or Themes, docs/notes/settings-sheet.md), the usage
 * sheet (docs/notes/usage-sheet.md; at most one of the three is open) and the help
 * overlay. None replaces the content area: the window stays laid out under them.
 * Opened by view.settings / view.help (their chords are presented
 * locally, see keys/bindings.ts) or by a UiIntent.ShowView from the daemon. The
 * window's own settings and usage keys and buttons toggle (toggleView); a ShowView only shows.
 */
import { toast } from "sonner";
import { create } from "zustand";
import { useUiStore } from "./ui";
import { parsePluginView, showPluginView } from "./pluginPanel";
import { leaveSubagent } from "./subagentView";
import { jumpToNeighbour } from "./threadNeighbours";
import { toggleThreadInfo } from "./threadInfoOverlay";
import { presentPromptHistory } from "./historyComposers";
import { presentFileFinder } from "./fileFinder";
import { presentSearch } from "./threadSearch";
import { presentFileFind } from "./fileFind";
import { presentTerminalFind } from "@/stores/terminalFind";
import { presentThreadFind } from "./threadFind";
import { presentDictationHold, presentDictationToggle } from "./dictation";
import { openAddProject } from "./addProject";
import { openMovePicker } from "./movePicker";
import { isActingWindow } from "./windowFocus";
import { previewTheme, resetThemePicker, setPickerQuery, setPickerSlot, useThemePickerStore, whenTheme, type ThemeSlot } from "./themePicker";
import { afterLeavingEditor, editorBack, editorDirty, leaveEditor, startEditing, stopEditing, syncFromDisk, useThemeEditorStore } from "./themeEditor";
import { themeById } from "@/themes";
import { canStepFocus, stepFocus, useFocusHistoryStore } from "./focusHistory";
import { useLayoutStore } from "./layout";
import { shellDrawn, useShellViewStore } from "./shellView";
import { presentFullscreen } from "@/shell/fullscreen";

interface ViewsState {
  settingsOpen: boolean;
  /**
   * The settings page's current page (SettingPageView.id). Opening settings lands on
   * General; coming back from the Themes page keeps the page it was opened from.
   */
  settingsPage: string;
  /**
   * The Usage page (view.usage, docs/notes/session-usage.md), shown in its own sheet
   * (docs/notes/usage-sheet.md). Never open with settings or themes.
   */
  usageOpen: boolean;
  /**
   * The Themes page (theme.pick, docs/notes/theme-engine-4-picker.md), shown in the
   * settings sheet in place of Settings. Never open with settings or usage.
   */
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

/** The settings and themes sheet is up (showing Settings or Themes). */
export function selectSheetOpen(s: ViewsState): boolean {
  return s.settingsOpen || s.themesOpen;
}

/** Settings, Themes or Usage is up: none of them is a selection. */
export function selectAnyViewOpen(s: ViewsState): boolean {
  return selectSheetOpen(s) || s.usageOpen;
}

function anyViewOpen(): boolean {
  return selectAnyViewOpen(useViewsStore.getState());
}

/**
 * The window's own settings and usage keys and sidebar buttons (keys/bindings.ts): a
 * toggle, closing the page that is already open (for settings, the sheet, whether it
 * shows Settings or Themes). The daemon's ShowView only shows (showView), since "Show
 * the Usage page" from the CLI or a thread must not close it.
 */
export function toggleView(name: "settings" | "usage"): boolean {
  const v = useViewsStore.getState();
  if (name === "settings" && selectSheetOpen(v)) closeSheet();
  else if (name === "usage" && v.usageOpen) closeUsage();
  else return showView(name);
  return true;
}

/**
 * Shows a named view (UiIntent.ShowView.name). Returns false for an unknown name. Pages
 * only show: one already open stays (toggleView is the window's own toggle). `params`
 * pick the page: view.projects --project or --workspace (that one's page on Projects).
 */
export function showView(name: string, params?: Readonly<Record<string, string>>): boolean {
  // theme.edit: the Themes page in edit mode on one of the user's themes.
  if (name.startsWith(THEME_EDIT_VIEW)) {
    void openThemeEditor(name.slice(THEME_EDIT_VIEW.length));
    return true;
  }
  // view.settings --page: the settings page on that page (the daemon checked the id).
  if (name.startsWith(SETTINGS_PAGE_VIEW)) {
    openSettingsPage(name.slice(SETTINGS_PAGE_VIEW.length));
    return true;
  }
  switch (name) {
    case "settings":
      // Already open: stays on the page it shows.
      if (!useViewsStore.getState().settingsOpen) {
        setPages({ settingsOpen: true, settingsPage: SETTINGS_FIRST_PAGE, usageOpen: false, themesOpen: false, helpOpen: false });
      }
      return true;
    case "usage":
      setPages({ usageOpen: true, settingsOpen: false, themesOpen: false, helpOpen: false });
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
    case "thread-info":
      // view.thread-info: the focused thread's info card, kept per thread (thread.info; its overlay on a narrow pane).
      toggleThreadInfo();
      return true;
    case "pane.fullscreen":
      // pane.fullscreen: the shell window's full screen pane (shell/fullscreen.ts); the classic window has none.
      return !shellDrawn() || presentFullscreen(params);
    case "composer.history":
      // composer.history: the focused composer's Previous prompts, else the palette's.
      return presentPromptHistory();
    case "file.find":
      // file.find: the palette's file finder over the selected thread (nothing on a page).
      return presentFileFinder();
    case "thread.find":
      // thread.find: the find bar of the thread in the content pane (nothing on a page).
      return presentThreadFind("open");
    case "thread.find.next":
      return presentThreadFind("next");
    case "thread.find.previous":
      return presentThreadFind("previous");
    case "terminal.find":
      // terminal.find: the find bar of the terminal with the keyboard, else of the one on screen.
      return presentTerminalFind("open");
    case "terminal.find.next":
      return presentTerminalFind("next");
    case "terminal.find.previous":
      return presentTerminalFind("previous");
    case "file.search":
      // file.search: the find bar of the File tab with the keyboard, else of the one on screen.
      return presentFileFind("open");
    case "file.search.next":
      return presentFileFind("next");
    case "file.search.previous":
      return presentFileFind("previous");
    case "search.open":
      // search.open: the palette's Find dialog over every thread, whatever the window shows,
      // on the agent search in `id` when it names one.
      return presentSearch(params?.id);
    case "project.add":
      // project.add without a folder from the CLI or a page: the Add Project dialog, which
      // leaves the window where it is once the project is added (a page asked for it).
      openAddProject("local", { stay: true });
      return true;
    case "thread.move": {
      // thread.move.open from the CLI: the move picker under that thread's crumb (the window
      // selects it), in one window only: the focused one, else the last focused (stores/windowFocus).
      const id = params?.id ?? "";
      void isActingWindow().then((acts) => {
        if (acts) openMovePicker(id);
      });
      return true;
    }
    case "dictation.toggle":
      // dictation.toggle from the CLI: the focused composer's dictation, else the content pane's.
      return presentDictationToggle();
    case "dictation.hold":
      // The host's hold key, with Code Foundry in front and a composer to take it.
      return presentDictationHold(params?.phase);
    case "dictation.allow":
      // For the host, which follows the intents too: a grant is asked for by the process that needs it.
      return true;
    default:
      // A plugin surface's show command (stores/pluginPanel.ts): a sheet would cover the panel.
      if (parsePluginView(name)) {
        if (!editingThemes()) {
          useViewsStore.setState({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false });
          return showPluginView(name);
        }
        setPages({ settingsOpen: false, usageOpen: false, themesOpen: false, helpOpen: false }, () => void showPluginView(name));
        return true;
      }
      // The Pull Requests and Projects pages are tabs: view.pullrequests and view.projects open
      // them in the layout and send nothing (docs/notes/shell-22-retire-verbs.md).
      return false;
  }
}

/**
 * view.back (-1) and view.forward (1): steps through the window's selection history
 * (stores/ui.ts back/forward). The settings, usage and themes pages are not selections, so
 * not history entries: back with one of them up closes it like its Esc or × (the Themes
 * page opened from Settings goes back to Settings), revealing what was on screen before
 * it, and does not step. Stepping to another selection closes such a page anyway
 * (startViewSync). Returns whether anything changed. It steps through the window's focus
 * history (stores/focusHistory.ts): what was focused, across panes and spaces.
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
  const can = canStepFocus(useFocusHistoryStore.getState(), useLayoutStore.getState(), by);
  if (can) void stepFocus(by);
  return can;
}

/** Asks the selected thread's prompt for the keyboard; nothing when no thread is selected. */
function requestPromptFocus(): void {
  if (useUiStore.getState().selection.kind === "thread") useUiStore.setState((s) => ({ promptFocusSeq: s.promptFocusSeq + 1 }));
}

/** Opens the settings page on one of its pages (SettingPageView.id), over any other window page. */
export function openSettingsPage(page: string): void {
  setPages({ settingsOpen: true, settingsPage: page, usageOpen: false, themesOpen: false, helpOpen: false });
}

/** The Themes page is open with unsaved edits in its editor. */
function editingThemes(): boolean {
  return useViewsStore.getState().themesOpen && editorDirty();
}

/**
 * Sets the page flags, then runs `after`. When that closes the Themes page while its editor
 * has unsaved edits, the confirm dialog asks first; on Cancel nothing changes (and `stay` runs).
 */
function setPages(next: Partial<ViewsState>, after?: () => void, stay?: () => void): void {
  const apply = () => {
    useViewsStore.setState(next);
    after?.();
  };
  if (next.themesOpen === false && editingThemes()) afterLeavingEditor(apply, stay);
  else apply();
}

/** ShowView "themes.edit.<id>" (theme.edit). */
export const THEME_EDIT_VIEW = "themes.edit.";

/** ShowView "settings.<page id>" (view.settings --page). */
export const SETTINGS_PAGE_VIEW = "settings.";

/**
 * theme.edit: opens the Themes page on the theme's scheme with the editor on it (after
 * the confirm when another theme has unsaved edits). Waits for a theme just copied
 * (Customise) to arrive. False when the id is not one of the user's themes.
 */
export async function openThemeEditor(id: string): Promise<boolean> {
  if (!(await whenTheme(id))) return false;
  const t = themeById.get(id);
  if (!t?.user) {
    toast.error("Cannot edit that theme", { description: `${t?.name ?? id} is not one of your themes. Customise copies it first.` });
    return false;
  }
  const editing = useThemeEditorStore.getState().id;
  if (editing !== id && !(await leaveEditor())) return false;
  const views = useViewsStore.getState();
  if (!views.themesOpen) {
    resetThemePicker(t.scheme, views.settingsOpen ? "settings" : null);
    setPages({ themesOpen: true, settingsOpen: false, usageOpen: false, helpOpen: false });
  } else setPickerSlot(t.scheme);
  setPickerQuery("");
  previewTheme(id);
  // The theme already open: a clean editor takes the file as it is now (a save since), a dirty one says it changed.
  if (editing !== id) startEditing(id);
  else syncFromDisk();
  return true;
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
    // Another slot lists the other scheme's themes: the editor (on one theme) closes first.
    if (slot && slot !== useThemePickerStore.getState().slot) afterLeavingEditor(() => { setPickerSlot(slot); });
    return;
  }
  resetThemePicker(slot, from ?? (views.settingsOpen ? "settings" : null));
  useViewsStore.setState({ themesOpen: true, settingsOpen: false, usageOpen: false, helpOpen: false });
}

/**
 * Leaves the Themes page (its × and Escape), dropping its preview and its editor; back to
 * Settings when it came from there, else the sheet closes. With unsaved edits the confirm
 * dialog asks first.
 */
export function closeThemes(): void {
  if (editorDirty()) {
    afterLeavingEditor(closeThemes);
    return;
  }
  stopEditing();
  const back = useThemePickerStore.getState().returnTo === "settings";
  resetThemePicker(undefined, null);
  useViewsStore.setState({ themesOpen: false, settingsOpen: back });
  if (!back) requestPromptFocus();
}

/**
 * The "Settings" crumb in the Themes page's header: back to the settings page it came
 * from, or, when Themes was opened on its own (theme.pick, theme.edit), to Settings →
 * Appearance, the page that leads to Themes. With unsaved edits the confirm dialog asks
 * first (setPages).
 */
export function themesToSettings(): void {
  if (useThemePickerStore.getState().returnTo === "settings") {
    closeThemes();
    return;
  }
  openSettingsPage("appearance");
}

/**
 * Escape in the settings sheet on the Themes page: back from a colour's view in the
 * editor, then out of the editor (asking first when it has changes), then the page
 * closes (closeThemes: back to Settings when it came from there).
 */
export function themesEscape(): void {
  if (editorBack()) return;
  if (useThemeEditorStore.getState().id !== null) void leaveEditor();
  else closeThemes();
}

/**
 * Closes the sheet whatever it shows (a click on its backdrop, the settings toggle):
 * Themes does not go back to Settings first. With unsaved edits in the Themes editor the
 * confirm dialog asks first.
 */
export function closeSheet(): void {
  const v = useViewsStore.getState();
  if (!v.themesOpen) {
    if (v.settingsOpen) closeSettings();
    return;
  }
  if (editorDirty()) {
    afterLeavingEditor(closeSheet);
    return;
  }
  stopEditing();
  resetThemePicker(undefined, null);
  useViewsStore.setState({ themesOpen: false, settingsOpen: false });
  requestPromptFocus();
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
 * to it: Help > Getting Started, Help > Keyboard Shortcuts and Help.
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

/** Selecting something (a sidebar chord, the palette, the CLI) closes the settings or usage sheet. */
export function startViewSync(): () => void {
  let restoring = false;
  const unsubUi = useUiStore.subscribe((s, prev) => {
    if (restoring || s.selection === prev.selection || !anyViewOpen()) return;
    // Cancel in the Themes editor's confirm: the page and its edits stay, and so does what was selected under it.
    const back = () => {
      restoring = true;
      useUiStore.setState({ selection: prev.selection });
      restoring = false;
    };
    setPages({ settingsOpen: false, usageOpen: false, themesOpen: false }, undefined, back);
  });
  // However the Themes page closes, its editor goes with it.
  const unsubViews = useViewsStore.subscribe((s, prev) => {
    if (prev.themesOpen && !s.themesOpen) stopEditing();
  });
  // A terminal this window started or showed asks for the keyboard, which it cannot get under a
  // sheet over the window: the sheet closes, as selecting something does.
  const unsubPane = useShellViewStore.subscribe((s, prev) => {
    if (s.overSheetsSeq !== prev.overSheetsSeq && anyViewOpen()) setPages({ settingsOpen: false, usageOpen: false, themesOpen: false });
  });
  return () => {
    unsubUi();
    unsubViews();
    unsubPane();
  };
}
