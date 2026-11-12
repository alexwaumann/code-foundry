/**
 * Tab kinds between the layout and the side panel's surfaces. Two layout kinds have other names
 * in the panel: `file` is `files` and `ember.board` is `ember`. Pure, with no surface imports, so
 * the host seam (shell/host.ts) can use it without a cycle through the surface registry.
 */
import type { Tab } from "./host";
import type { TabEntry } from "@/stores/layout";

const PANEL_KINDS: Readonly<Record<string, string>> = { file: "files", "ember.board": "ember" };
const LAYOUT_KINDS: Readonly<Record<string, string>> = Object.fromEntries(Object.entries(PANEL_KINDS).map(([a, b]) => [b, a]));

/** The side panel's kind for a layout kind. */
export function panelKindOf(kind: string): string {
  return PANEL_KINDS[kind] ?? kind;
}

/** The layout's kind for a side panel kind. */
export function layoutKindOf(kind: string): string {
  return LAYOUT_KINDS[kind] ?? kind;
}

/** A layout tab as the side panel's surfaces read it. */
export function seamTab(tab: Pick<TabEntry, "id" | "kind" | "title" | "name" | "params">, fallbackTitle = ""): Tab {
  return { id: tab.id, kind: panelKindOf(tab.kind), title: tab.name || tab.title || fallbackTitle, params: tab.params };
}
