import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import type { ViewTab } from "@/api/plugin";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { PillView } from "./parts";
import { fadeMask, overflowEdges, scrollLeftToShow } from "./scroll";
import { tabElementId } from "./tabIds";

/** The strip's sizes: the view's tabs (md) and a tabs node's, one step smaller (sm). */
const sizes = {
  md: { list: "rounded-lg", tab: "h-6 gap-1.5 rounded-md px-2.5 text-body-sm @max-[340px]:px-2" },
  sm: { list: "rounded-md", tab: "h-5 gap-1 rounded-sm px-2 text-caption-sm" },
} as const;

/**
 * A plugin's tabs as a segmented strip (the pull request view's style): the active tab
 * raised on a muted track. Tabs that do not fit scroll: the hidden side fades and gets a
 * chevron that scrolls it into view, and the active tab is kept in view (again after the
 * chevrons come or go, unless the user scrolled the strip since). A tab is at most 16rem
 * (80% of the strip) wide, its label cut short with a tooltip. `onPick` gets a tab that is
 * not the active one. The view's tabs (ViewTabsBar) and a tabs node's (nodes/TabsNode, one
 * step smaller) share it.
 *
 * Keyboard (the WAI-ARIA tabs pattern, manual activation): one tab stop (roving tabIndex;
 * an explicit tabIndex also makes WebKit, which skips buttons on Tab by default, stop on
 * it), ArrowLeft/ArrowRight (wrapping), Home and End move focus, Enter and Space choose.
 * With `idBase` the tabs get ids (tabElementId) and `panelId` names the panel they control.
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
  idBase,
  panelId,
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
  idBase?: string;
  panelId?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ start: false, end: false });
  // The tab that holds the strip's one tab stop: the last one focused, else the active one.
  const [cursor, setCursor] = useState<string | null>(null);
  const stop = items.some((t) => t.key === cursor) ? cursor : items.some((t) => t.key === active) ? active : (items[0]?.key ?? null);
  // Whether the user scrolled the strip since the active tab was last brought into view (then it is left alone).
  const userScrolled = useRef(false);
  const ownScroll = useRef(false);
  // The labels and badges: a change of either can change the overflow without resizing the strip.
  const shape = items.map((t) => `${t.key}\u0000${t.label}\u0000${t.badge?.label ?? ""}`).join("\u0001");

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
  }, [measure, shape]);

  // A new active tab (the plugin may switch tabs itself) is brought into view.
  useLayoutEffect(() => {
    userScrolled.current = false;
  }, [active]);
  // It is kept there as the chevrons come or go (they take the tablist's width) or the labels change.
  useLayoutEffect(() => {
    const box = ref.current;
    const el = box?.querySelector<HTMLElement>(`[data-key="${CSS.escape(active)}"]`);
    if (!box || !el || userScrolled.current) return;
    // The tablist is the tabs' offsetParent (relative): offsetLeft is in its content, unzoomed.
    const left = scrollLeftToShow(box.scrollLeft, box.clientWidth, el.offsetLeft, el.offsetWidth);
    if (left === box.scrollLeft) return;
    const before = box.scrollLeft;
    box.scrollLeft = left;
    // Its scroll event is ours, not the user's (none comes when the value was clamped to the same).
    if (box.scrollLeft !== before) ownScroll.current = true;
  }, [active, edges.start, edges.end, shape]);

  const scrollBy = (dir: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    userScrolled.current = true;
    el.scrollBy({ left: dir * Math.max(80, el.clientWidth * 0.6), behavior: "smooth" });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const keys = items.map((t) => t.key);
    const at = keys.indexOf((e.target as HTMLElement).getAttribute("data-key") ?? "");
    if (at < 0) return;
    const to = e.key === "ArrowRight" ? (at + 1) % keys.length : e.key === "ArrowLeft" ? (at - 1 + keys.length) % keys.length : e.key === "Home" ? 0 : e.key === "End" ? keys.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    ref.current?.querySelector<HTMLElement>(`[role="tab"][data-key="${CSS.escape(keys[to] ?? "")}"]`)?.focus();
  };

  return (
    <div className={className} data-testid={testId} data-key={dataKey} data-overflow-start={edges.start || undefined} data-overflow-end={edges.end || undefined}>
      {edges.start && (
        <Button variant="ghost" size="icon-xs" className="text-cf-text-muted hover:text-cf-text" aria-label="Earlier tabs" tabIndex={-1} onClick={() => { scrollBy(-1); }} data-testid={`${testId}-prev`}>
          <ChevronLeft aria-hidden />
        </Button>
      )}
      <div
        ref={ref}
        role="tablist"
        aria-label={label}
        aria-orientation="horizontal"
        className={cn("relative flex min-w-0 items-center gap-0.5 overflow-x-auto bg-cf-surface-sunken/60 p-0.5 [scrollbar-width:none] dark:bg-cf-surface-sunken/40 [&::-webkit-scrollbar]:hidden", sizes[size].list)}
        style={{ maskImage: fadeMask(edges.start, edges.end), WebkitMaskImage: fadeMask(edges.start, edges.end) }}
        onScroll={() => {
          if (ownScroll.current) ownScroll.current = false;
          else userScrolled.current = true;
          measure();
        }}
        onKeyDown={onKeyDown}
      >
        {items.map((t) => {
          const on = t.key === active;
          return (
            <Tip key={t.key} label={t.label} whenTruncated>
              <button
                type="button"
                role="tab"
                id={idBase === undefined ? undefined : tabElementId(idBase, t.key)}
                aria-selected={on}
                aria-controls={on ? panelId : undefined}
                tabIndex={t.key === stop ? 0 : -1}
                disabled={inert}
                data-testid={tabTestId}
                data-key={t.key}
                className={cn(
                  "flex max-w-[min(16rem,80%)] shrink-0 items-center outline-none focus-visible:ring-1 focus-visible:ring-cf-focus disabled:opacity-60",
                  sizes[size].tab,
                  on ? "bg-cf-surface text-cf-text shadow-xs dark:bg-cf-control-hover" : "text-cf-text-muted hover:text-cf-text",
                )}
                onFocus={() => {
                  setCursor(t.key);
                }}
                onClick={() => {
                  if (!on) onPick(t.key);
                }}
              >
                <span className="min-w-0 truncate">{t.label}</span>
                <PillView pill={t.badge} />
              </button>
            </Tip>
          );
        })}
      </div>
      {edges.end && (
        <Button variant="ghost" size="icon-xs" className="text-cf-text-muted hover:text-cf-text" aria-label="More tabs" tabIndex={-1} onClick={() => { scrollBy(1); }} data-testid={`${testId}-next`}>
          <ChevronRight aria-hidden />
        </Button>
      )}
    </div>
  );
}
