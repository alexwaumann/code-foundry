/**
 * The shell's surfaces by kind (docs/notes/shell-11-pane-grid.md). A kind is listed here once; the
 * pane, its strip and the selection bridge look a tab's surface up and never switch on its kind.
 * A plugin kind (`plugin.<plugin>.<surface>`) falls through to the plugin surface; a kind this
 * build does not know (a newer daemon's) draws a quiet placeholder rather than failing.
 * `kinds.test.ts` compares the kinds with internal/layout/testdata/kinds.json.
 */
import { CircleHelp } from "lucide-react";
import { isPluginKind } from "@/surfaces/plugin";
import { composeSurface } from "./compose";
import { prsSurface, projectsSurface } from "./pages";
import { panelSurfaces, pluginShellSurface } from "./panel";
import { terminalSurface } from "./terminal";
import { threadSurface } from "./thread";
import type { ShellSurface } from "./types";

export type { ShellSurface } from "./types";

export const shellSurfaces: readonly ShellSurface[] = [threadSurface, composeSurface, prsSurface, projectsSurface, terminalSurface, ...panelSurfaces];

const byKind = new Map(shellSurfaces.map((s) => [s.kind, s]));
const plugins = new Map<string, ShellSurface>();

/** What a tab of a kind this build does not know shows. */
function unknownSurface(kind: string): ShellSurface {
  return {
    kind,
    icon: CircleHelp,
    useTitle: (tab) => tab.name || tab.title || kind,
    render: () => (
      <p className="m-auto p-6 text-center text-body text-cf-text-muted" data-testid="shell-unknown-surface">
        This build cannot show a “{kind}” tab.
      </p>
    ),
  };
}

/** The surface of a tab kind. */
export function shellSurfaceOf(kind: string): ShellSurface {
  const listed = byKind.get(kind);
  if (listed) return listed;
  let s = plugins.get(kind);
  if (!s) {
    s = isPluginKind(kind) ? pluginShellSurface(kind) : unknownSurface(kind);
    plugins.set(kind, s);
  }
  return s;
}
