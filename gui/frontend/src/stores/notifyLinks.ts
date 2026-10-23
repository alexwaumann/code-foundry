/**
 * Where a daemon notification's button leads (UiIntent.Notify.link, docs/notes/memory-page.md):
 * "<kind>:<target>". A registry, not a switch: a new kind is one entry. A link this window
 * does not know gets no button.
 */
import { editSavedTheme, undoTheme } from "./themeCards";
import { openSettingsPage, useViewsStore } from "./views";

const kinds: Readonly<Record<string, (target: string) => void>> = {
  // "settings:memory": that Settings page.
  settings: (page) => {
    openSettingsPage(page);
  },
  // "theme-edit:<id>": the Themes page's editor on that theme (a thread applied it).
  "theme-edit": (id) => {
    void editSavedTheme(id);
  },
  // "theme-set:<scheme>:<id>": that slot back on that theme (the toast's Undo).
  "theme-set": (target) => {
    const [scheme, id] = target.split(":", 2);
    if ((scheme === "dark" || scheme === "light") && id) void undoTheme(scheme, id);
  },
};

/**
 * Whether this window shows a page (UiIntent.Notify.unless_showing): a toast about a change
 * that page already shows is skipped there. A registry; a page it does not know never is.
 */
const pages: Readonly<Record<string, () => boolean>> = {
  themes: () => useViewsStore.getState().themesOpen,
};

export function showingPage(page: string): boolean {
  return pages[page]?.() ?? false;
}

/** What clicking the link does; null for a link this window does not know (or an empty target). */
export function notifyLinkAction(link: string): (() => void) | null {
  const at = link.indexOf(":");
  if (at <= 0) return null;
  const open = kinds[link.slice(0, at)];
  const target = link.slice(at + 1);
  if (!open || !target) return null;
  return () => {
    open(target);
  };
}
