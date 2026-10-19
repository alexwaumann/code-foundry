import type { ViewTabs } from "@/api/plugin";
import { actOnElement, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useViewCtx } from "./context";
import { TabStrip } from "./TabStrip";

/**
 * A plugin's own tabs, styled like the pull request view's (not the panel's tab strip).
 * A click sends a `tab` act; the clicked tab reads as active while its act is pending,
 * then the plugin's view says which is. Drafts are kept per tab (stores/pluginSurfaces
 * draftKeyOf). Tabs that do not fit scroll (TabStrip).
 */
export function ViewTabsBar({ tabs }: { tabs: ViewTabs }) {
  const { watchKey, inert } = useViewCtx();
  const switching = usePluginSurfacesStore((s) => tabs.items.find((t) => s.pending[watchKey]?.[t.key])?.key);
  return (
    <TabStrip
      items={tabs.items}
      active={switching ?? tabs.active}
      onPick={(key) => void actOnElement(watchKey, key)}
      inert={inert}
      size="md"
      label="Views"
      className="flex h-11 min-w-0 items-center gap-0.5 border-b border-pane-border px-4 @max-[340px]:px-3"
      testId="plugin-tabs"
      tabTestId="plugin-tab"
    />
  );
}
