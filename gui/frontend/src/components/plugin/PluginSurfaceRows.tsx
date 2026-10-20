import { useSyncExternalStore } from "react";
import { Puzzle } from "lucide-react";
import { SurfaceRow } from "@/components/panel/SurfaceRow";
import { Tip } from "@/components/ui/tooltip";
import { useCommandsStore } from "@/stores/commands";
import { allSurfaces, usePluginsStore } from "@/stores/plugins";
import { pluginSurfaceSpec, showAvailability } from "@/surfaces/plugin";
import type { SurfaceContext } from "@/surfaces/registry";
import type { GroupIndex } from "@/stores/panel";
import type { Selection } from "@/stores/ui";

function subscribe(onChange: () => void): () => void {
  const a = usePluginsStore.subscribe(onChange);
  const b = useCommandsStore.subscribe(onChange);
  return () => {
    a();
    b();
  };
}

/** The available plugin surfaces as one string (kind and plugin name per row), so unrelated updates do not re-render. */
function useAvailableSurfaces(sel: Selection): string {
  return useSyncExternalStore(subscribe, () =>
    allSurfaces()
      .filter((m) => showAvailability(m, sel) === "enabled")
      .map((m) => `${m.kind}\u0000${m.pluginDisplayName}`)
      .join("\u0001"),
  );
}

/**
 * The plugin surfaces this panel can open, after the built-in ones behind a divider
 * (docs/sketches/plugins, "list"): a puzzle mark where a hotkey would be, its tooltip
 * naming the plugin. Only available ones are listed; with none, nothing (no divider).
 * They open in `group` (the group whose list this is).
 */
export function PluginSurfaceRows({ ctx, group }: { ctx: SurfaceContext; group?: GroupIndex }) {
  const kinds = useAvailableSurfaces(ctx.selection);
  const rows = kinds ? kinds.split("\u0001").map((r) => r.split("\u0000") as [string, string]) : [];
  if (rows.length === 0) return null;
  return (
    <ul className="mt-2 flex flex-col gap-0.5 border-t border-border pt-2" data-testid="panel-plugin-surfaces">
      {rows.map(([kind, plugin]) => {
        const spec = pluginSurfaceSpec(kind);
        if (!spec) return null;
        return (
          <SurfaceRow
            key={kind}
            spec={spec}
            ctx={ctx}
            group={group}
            trailing={
              <Tip label={`From the ${plugin} plugin`}>
                <span className="inline-flex shrink-0 text-muted-foreground" data-testid="plugin-mark">
                  <Puzzle className="size-3.5" aria-label={`Plugin ${plugin}`} />
                </span>
              </Tip>
            }
          />
        );
      })}
    </ul>
  );
}
