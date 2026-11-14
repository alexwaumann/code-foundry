/**
 * The panel surfaces (once the side panel's), as shell tabs: a file, a diff, a pull request, MCP, the
 * gallery, Ember's board and plugin surfaces draw the same body (surfaces/registry.ts), given
 * the layout tab as a seam tab (shell/host.ts). Two layout kinds have other names in the panel:
 * `file` is `files` and `ember.board` is `ember`.
 */
import { createElement } from "react";
import { Puzzle } from "lucide-react";
import { PanelKeyContext } from "@/shell/panelKeyContext";
import { panelKindOf, seamTab } from "@/shell/kinds";
import { surfaceOf } from "@/surfaces/registry";
import type { SurfaceSpec } from "@/surfaces/types";
import type { TabEntry } from "@/stores/layout";
import type { ShellSurface } from "./types";

export { layoutKindOf, panelKindOf, seamTab } from "@/shell/kinds";

/** The panel key a linked tab's body acts for: its thread's ("" for an unlinked tab). */
export function panelKeyOfTab(tab: Pick<TabEntry, "thread">): string {
  return tab.thread ? `thread:${tab.thread}` : "";
}

/** A shell surface drawing a panel surface's body. */
export function panelSurface(kind: string, spec: SurfaceSpec | undefined): ShellSurface {
  const title = spec?.title ?? "";
  const useUnsaved = spec?.useUnsaved;
  const beforeClose = spec?.beforeClose;
  const onKey = spec?.onKey;
  return {
    kind,
    icon: spec?.icon ?? Puzzle,
    useTitle: (tab) => tab.name || tab.title || spec?.title || kind,
    // A linked tab's body acts for its thread as it did in that thread's side panel (a File tab's
    // page bridge, the MCP tab's state, a pull request's links): the panel key is the thread's.
    // It sits in a box like the old side panel's: it scrolls (overflow auto, the scroll root long lists
    // virtualize against, components/pr/VirtualStack, and plugin nodes count as on screen in), and
    // a press inside it takes the keyboard (the pane's focus root), so the surface's own keys
    // (SurfaceSpec.onKey, dispatched by the pane) reach it.
    render: (tab) =>
      spec
        ? createElement(
            "div",
            {
              className: "flex min-h-0 flex-1 flex-col overflow-auto outline-none",
              tabIndex: -1,
              "data-scroll-root": "",
              "data-focus-root": "",
              "data-testid": "shell-surface-scroll",
            },
            createElement(PanelKeyContext, { value: panelKeyOfTab(tab) }, spec.render(seamTab(tab, spec.title))),
          )
        : null,
    linkedNoun: spec?.title ?? kind,
    // Unsaved work and the question before a close, as the side panel had them (a File tab editing).
    ...(useUnsaved ? { useUnsaved: (tab: TabEntry) => useUnsaved(panelKeyOfTab(tab), seamTab(tab, title)) } : {}),
    ...(onKey ? { onKey: (chord: string, tab: TabEntry) => onKey(chord, seamTab(tab, title)) } : {}),
    ...(beforeClose ? { beforeClose: (tab: TabEntry) => beforeClose(panelKeyOfTab(tab), seamTab(tab, title)) } : {}),
  };
}

/** The panel surfaces the shell lists by kind; plugin kinds are looked up as they come. */
export const panelSurfaces: readonly ShellSurface[] = ["file", "diff", "pullrequest", "mcp", "gallery", "ember.board"].map((k) => panelSurface(k, surfaceOf(panelKindOf(k))));

/** A plugin kind's surface (`plugin.<plugin>.<surface>`). */
export function pluginShellSurface(kind: string): ShellSurface {
  return panelSurface(kind, surfaceOf(kind));
}
