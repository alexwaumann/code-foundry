import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ViewTabs } from "@/api/plugin";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { actOnElement, usePluginSurfacesStore } from "@/stores/pluginSurfaces";
import { useViewCtx } from "./context";
import { PillView } from "./parts";
import { fadeMask, overflowEdges, scrollLeftToShow } from "./scroll";

/**
 * A plugin's own tabs, styled like the pull request view's (not the panel's tab strip).
 * A click sends a `tab` act; the clicked tab reads as active until the plugin's next view
 * says which is. Drafts are kept per tab (stores/pluginSurfaces draftKeyOf). Tabs that do
 * not fit scroll: the hidden side fades and gets a chevron that scrolls it into view, and
 * the active tab is kept in view.
 */
export function ViewTabsBar({ tabs }: { tabs: ViewTabs }) {
  const { watchKey, inert } = useViewCtx();
  const switching = usePluginSurfacesStore((s) => tabs.items.find((t) => s.pending[watchKey]?.[t.key])?.key);
  const active = switching ?? tabs.active;
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const next = overflowEdges(el.scrollLeft, el.clientWidth, el.scrollWidth);
    setEdges((e) => (e.start === next.start && e.end === next.end ? e : next));
  }, []);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => {
      ro.disconnect();
    };
  }, [measure, tabs.items.length]);

  // The active tab stays in view (a plugin may switch tabs itself).
  useEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);
    if (!box || !el) return;
    const left = scrollLeftToShow(box.scrollLeft, box.clientWidth, el.offsetLeft - box.offsetLeft, el.offsetWidth);
    if (left !== box.scrollLeft) box.scrollLeft = left;
  }, [active]);

  const scrollBy = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.6), behavior: "smooth" });
  };

  return (
    <div className="flex h-11 min-w-0 items-center gap-0.5 border-b border-pane-border px-4 @max-[340px]:px-3" data-testid="plugin-tabs" data-overflow-start={edges.start || undefined} data-overflow-end={edges.end || undefined}>
      {edges.start && (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label="Earlier tabs" tabIndex={-1} onClick={() => { scrollBy(-1); }} data-testid="plugin-tabs-prev">
          <ChevronLeft aria-hidden />
        </Button>
      )}
      <div
        ref={ref}
        role="tablist"
        aria-label="Views"
        className="flex min-w-0 items-center gap-0.5 overflow-x-auto rounded-lg bg-muted/60 p-0.5 [scrollbar-width:none] dark:bg-muted/40 [&::-webkit-scrollbar]:hidden"
        style={{ maskImage: fadeMask(edges.start, edges.end), WebkitMaskImage: fadeMask(edges.start, edges.end) }}
        onScroll={measure}
      >
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
      {edges.end && (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label="More tabs" tabIndex={-1} onClick={() => { scrollBy(1); }} data-testid="plugin-tabs-next">
          <ChevronRight aria-hidden />
        </Button>
      )}
    </div>
  );
}
