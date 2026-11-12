/**
 * The surfaces the side panel had, as shell tabs: a file, a diff, a pull request, MCP, the
 * gallery, Ember's board and plugin surfaces draw the same body (surfaces/registry.ts), given
 * the layout tab as a seam tab (shell/host.ts). Two layout kinds have other names in the panel:
 * `file` is `files` and `ember.board` is `ember`.
 */
import { Puzzle } from "lucide-react";
import { panelKindOf, seamTab } from "@/shell/kinds";
import { surfaceOf } from "@/surfaces/registry";
import type { SurfaceSpec } from "@/surfaces/types";
import type { ShellSurface } from "./types";

export { layoutKindOf, panelKindOf, seamTab } from "@/shell/kinds";

/** A shell surface drawing a panel surface's body. */
export function panelSurface(kind: string, spec: SurfaceSpec | undefined): ShellSurface {
  return {
    kind,
    icon: spec?.icon ?? Puzzle,
    useTitle: (tab) => tab.name || tab.title || spec?.title || kind,
    render: (tab) => (spec ? spec.render(seamTab(tab, spec.title)) : null),
  };
}

/** The panel surfaces the shell lists by kind; plugin kinds are looked up as they come. */
export const panelSurfaces: readonly ShellSurface[] = ["file", "diff", "pullrequest", "mcp", "gallery", "ember.board"].map((k) => panelSurface(k, surfaceOf(panelKindOf(k))));

/** A plugin kind's surface (`plugin.<plugin>.<surface>`). */
export function pluginShellSurface(kind: string): ShellSurface {
  return panelSurface(kind, surfaceOf(kind));
}
