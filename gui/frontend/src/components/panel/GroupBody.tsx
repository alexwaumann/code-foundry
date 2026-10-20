import { useMemo } from "react";
import { PluginSurfaceRows } from "@/components/plugin/PluginSurfaceRows";
import { activeTab, usePanelStore, type GroupIndex } from "@/stores/panel";
import { useUiStore } from "@/stores/ui";
import { surfaceOf, surfaces, type SurfaceContext } from "@/surfaces/registry";
import { bodyDomId, tabDomId } from "./actions";
import { SurfaceRow } from "./SurfaceRow";

/**
 * No tabs yet, or picking (the "+" was clicked): the surfaces this selection can open,
 * with their hotkeys (as in T3 Code). Picking one opens it in this group (or activates
 * its open tab, in whichever group holds it). It scrolls when a stacked group is short.
 */
function EmptyState({ panelKey, group }: { panelKey: string; group: GroupIndex }) {
  const selection = useUiStore((s) => s.selection);
  const ctx = useMemo<SurfaceContext>(() => ({ selection, panelKey }), [selection, panelKey]);
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-auto p-6" data-surface-list data-testid="panel-empty">
      <div className="m-auto w-full max-w-64">
        <h2 className="mb-3 text-center text-subheading">Open a surface</h2>
        <ul className="flex flex-col gap-0.5">
          {surfaces.map((spec) => (
            <SurfaceRow key={spec.kind} spec={spec} ctx={ctx} group={group} />
          ))}
        </ul>
        <PluginSurfaceRows ctx={ctx} group={group} />
      </div>
    </div>
  );
}

/** A group's body: its active tab's surface, or the surface list while it has none (picking, or no tabs). */
export function GroupBody({ panelKey, group }: { panelKey: string; group: GroupIndex }) {
  const active = usePanelStore((s) => {
    const e = s.byKey[panelKey];
    return e ? activeTab(e, group) : null;
  });
  if (!active) return <EmptyState panelKey={panelKey} group={group} />;
  const spec = surfaceOf(active.kind);
  return (
    // Keyed by tab: switching tabs of the same kind must not reuse the other tab's state.
    <div
      key={active.id}
      id={bodyDomId(group)}
      role="tabpanel"
      aria-labelledby={tabDomId(active.id)}
      className="flex min-h-0 flex-1 flex-col overflow-auto"
      // Long surface lists virtualize against this scroll box (components/pr/VirtualStack).
      data-scroll-root
      data-testid="panel-body"
      data-surface={active.kind}
      data-tab-id={active.id}
    >
      {spec ? spec.render(active) : null}
    </div>
  );
}
