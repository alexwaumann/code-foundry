/**
 * Tab kinds between the layout and the panel surfaces (src/surfaces). Two layout kinds have other names
 * in the panel: `file` is `files` and `ember.board` is `ember`. Pure, with no surface imports, so
 * the host seam (shell/host.ts) can use it without a cycle through the surface registry.
 */
import type { Tab } from "./host";
import type { TabEntry } from "@/stores/layout";

const PANEL_KINDS: Readonly<Record<string, string>> = { file: "files", "ember.board": "ember" };
const LAYOUT_KINDS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PANEL_KINDS).map(([a, b]) => [b, a]));

/** The panel surface's kind for a layout kind. */
export function panelKindOf(kind: string): string {
  return PANEL_KINDS[kind] ?? kind;
}

/** The layout's kind for a panel surface kind. */
export function layoutKindOf(kind: string): string {
  return LAYOUT_KINDS[kind] ?? kind;
}

/**
 * A layout tab as the panel surfaces read it. A File tab keeps the id the old side panel gave
 * it, its path alone (shell/tabs.ts tabId, surfaces/fileTarget.ts fileTab): its edit session,
 * a thread's request and the unsaved dot address it by that id, and the host finds a layout tab by
 * it too (hostShell.ts findShellTab). Every other kind is known by its layout id.
 */
export function seamTab(tab: Pick<TabEntry, "id" | "kind" | "title" | "name" | "params">, fallbackTitle = ""): Tab {
  const kind = panelKindOf(tab.kind);
  const id = kind === "files" && tab.params.path ? `files?path=${encodeURIComponent(tab.params.path)}` : tab.id;
  return { id, kind, title: tab.name || tab.title || fallbackTitle, params: tab.params };
}
