import type { ViewTabs } from "@/api/plugin";
import { cn } from "@/lib/utils";
import { actOnElement, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useViewCtx } from "./context";
import { PillView } from "./parts";

/**
 * A plugin's own tabs, styled like the pull request view's (not the panel's tab strip).
 * A click sends a `tab` act; the clicked tab reads as active until the plugin's next view
 * says which is. Drafts are kept per tab (stores/pluginSurfaces draftKeyOf).
 */
export function ViewTabsBar({ tabs }: { tabs: ViewTabs }) {
  const { watchKey, inert } = useViewCtx();
  const switching = usePluginSurfacesStore((s) => tabs.items.find((t) => s.pending[watchKey]?.[t.key])?.key);
  const active = switching ?? tabs.active;
  return (
    <div className="flex h-11 min-w-0 items-center border-b border-pane-border px-4 @max-[340px]:px-3" data-testid="plugin-tabs">
      <div role="tablist" aria-label="Views" className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/60 p-0.5 [scrollbar-width:none] dark:bg-muted/40">
        {tabs.items.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              disabled={inert}
              data-testid="plugin-tab"
              data-key={t.key}
              className={cn(
                "flex h-6 shrink-0 items-center gap-1.5 rounded-md px-2.5 text-body-sm outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60 @max-[340px]:px-2",
                on ? "bg-pane text-foreground shadow-xs dark:bg-accent" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                if (!on) void actOnElement(watchKey, t.key);
              }}
            >
              {t.label}
              <PillView pill={t.badge} />
            </button>
          );
        })}
      </div>
    </div>
  );
}
