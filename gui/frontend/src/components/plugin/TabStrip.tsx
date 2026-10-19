import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ViewTab } from "@/api/plugin";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { PillView } from "./parts";
import { fadeMask, overflowEdges, scrollLeftToShow } from "./scroll";

/** The strip's sizes: the view's tabs (md) and a tabs node's, one step smaller (sm). */
const sizes = {
  md: { list: "rounded-lg", tab: "h-6 gap-1.5 rounded-md px-2.5 text-body-sm @max-[340px]:px-2" },
  sm: { list: "rounded-md", tab: "h-5 gap-1 rounded-sm px-2 text-caption-sm" },
} as const;

/**
 * A plugin's tabs as a segmented strip (the pull request view's style): the active tab
 * raised on a muted track. Tabs that do not fit scroll: the hidden side fades and gets a
 * chevron that scrolls it into view, and the active tab is kept in view. `onPick` gets a
 * tab that is not the active one. The view's tabs (ViewTabsBar) and a tabs node's
 * (nodes/TabsNode, one step smaller) share it.
 */
export function TabStrip({
  items,
  active,
  onPick,
  inert,
  size,
  label,
  className,
  testId,
  tabTestId,
  dataKey,
}: {
  items: readonly ViewTab[];
  active: string;
  onPick: (key: string) => void;
  inert: boolean;
  size: keyof typeof sizes;
  label: string;
  className: string;
  testId: string;
  tabTestId: string;
  dataKey?: string;
}) {
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
  }, [measure, items.length]);

  // The active tab stays in view (a plugin may switch tabs itself).
  useEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);
    if (!box || !el) return;
    // The tablist is the tabs' offsetParent (relative): offsetLeft is in its content, unzoomed.
    const left = scrollLeftToShow(box.scrollLeft, box.clientWidth, el.offsetLeft, el.offsetWidth);
    if (left !== box.scrollLeft) box.scrollLeft = left;
  }, [active]);

  const scrollBy = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.6), behavior: "smooth" });
  };

  return (
    <div className={className} data-testid={testId} data-key={dataKey} data-overflow-start={edges.start || undefined} data-overflow-end={edges.end || undefined}>
      {edges.start && (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label="Earlier tabs" tabIndex={-1} onClick={() => { scrollBy(-1); }} data-testid={`${testId}-prev`}>
          <ChevronLeft aria-hidden />
        </Button>
      )}
      <div
        ref={ref}
        role="tablist"
        aria-label={label}
        className={cn("relative flex min-w-0 items-center gap-0.5 overflow-x-auto bg-muted/60 p-0.5 [scrollbar-width:none] dark:bg-muted/40 [&::-webkit-scrollbar]:hidden", sizes[size].list)}
        style={{ maskImage: fadeMask(edges.start, edges.end), WebkitMaskImage: fadeMask(edges.start, edges.end) }}
        onScroll={measure}
      >
        {items.map((t) => {
          const on = t.key === active;
          return (
            <button
              key={t.key}
              type="button"
              role="tab"
              aria-selected={on}
              disabled={inert}
              data-testid={tabTestId}
              data-key={t.key}
              className={cn(
                "flex shrink-0 items-center outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60",
                sizes[size].tab,
                on ? "bg-pane text-foreground shadow-xs dark:bg-accent" : "text-muted-foreground hover:text-foreground",
              )}
              onClick={() => {
                if (!on) onPick(t.key);
              }}
            >
              {t.label}
              <PillView pill={t.badge} />
            </button>
          );
        })}
      </div>
      {edges.end && (
        <Button variant="ghost" size="icon-xs" className="text-muted-foreground hover:text-foreground" aria-label="More tabs" tabIndex={-1} onClick={() => { scrollBy(1); }} data-testid={`${testId}-next`}>
          <ChevronRight aria-hidden />
        </Button>
      )}
    </div>
  );
}
