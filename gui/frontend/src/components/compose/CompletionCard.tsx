import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
import { Kbd } from "@/components/ui/kbd";
import { projectHue } from "@/lib/compose";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { useReposStore } from "@/stores/repos";
import { useUiStore } from "@/stores/ui";
import type { Completion, CompletionGroup, CompletionItem } from "./useCompletion";

/** A row's muted detail, its emphasized ranges (a path's matched characters) in the foreground. */
function Detail({ item }: { item: CompletionItem }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of item.emphasis ?? []) {
    if (from > at) parts.push(item.detail.slice(at, from));
    parts.push(
      <b key={from} className="font-medium text-foreground" data-testid="completion-hit">
        {item.detail.slice(from, to)}
      </b>,
    );
    at = to;
  }
  parts.push(item.detail.slice(at));
  return <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{parts}</span>;
}

function ProjectHeading({ repoId }: { repoId: string }) {
  const name = useReposStore((s) => s.byId[repoId]?.name ?? repoId);
  return (
    <>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: `oklch(0.55 0.13 ${String(projectHue(name))})` }} />
      <span className="truncate">{name}</span>
    </>
  );
}

function Heading({ heading }: { heading: NonNullable<CompletionGroup["heading"]> }) {
  return (
    <div role="presentation" className="flex items-center gap-1.5 px-3 pt-2 pb-0.5 text-[11px] text-muted-foreground" data-testid="completion-group">
      {heading.kind === "project" ? <ProjectHeading repoId={heading.repoId} /> : <span>{heading.kind === "user" ? "User" : heading.text}</span>}
    </div>
  );
}

/** Layout px kept free between the card and the bottom of the visible area. */
const BOTTOM_MARGIN = 16;
/** A row's height (h-7) and the list's vertical padding (py-1), in layout px. */
const ROW = 28;
const LIST_PADDING = 8;
/** The list's own cap (max-h-[15.5rem]): about eight rows. */
const LIST_MAX = 248;
/** One row plus the list's padding and the card's border: the card never gets shorter. */
const MIN_HEIGHT = ROW + LIST_PADDING + 2;
/** Below this the hints footer hides, leaving the space to the rows (two rows and the footer). */
const HINTS_MIN_HEIGHT = 2 * ROW + LIST_PADDING + 2 + 29;

/** The nearest ancestor that scrolls vertically (the composer's section), or null. */
function scrollerOf(el: HTMLElement): HTMLElement | null {
  for (let p = el.parentElement; p; p = p.parentElement) {
    const { overflowY } = getComputedStyle(p);
    if (overflowY === "auto" || overflowY === "scroll") return p;
  }
  return null;
}

/**
 * Caps the card's height to the space between its top and the bottom of the visible area
 * (the scroller's box, the window), less a margin, and when that is less than the list's
 * own cap, the list to whole rows (no row cut by the hints). Rects are viewport px;
 * max-heights and offsetHeight are layout px, so the distance is divided by the page zoom.
 */
function fit(el: HTMLElement, scroller: HTMLElement | null, above: boolean): void {
  const r = el.getBoundingClientRect();
  // Above its anchor (a thread's composer at the pane's bottom), the room runs
  // from the top of the visible area down to the card's bottom.
  const top = above ? Math.max(0, scroller ? scroller.getBoundingClientRect().top : 0) : r.top;
  const bottom = above ? r.bottom : Math.min(window.innerHeight, scroller ? scroller.getBoundingClientRect().bottom : Infinity);
  const space = Math.max(Math.floor((bottom - top) / zoomFactor()) - BOTTOM_MARGIN, MIN_HEIGHT);
  el.toggleAttribute("data-short", space < HINTS_MIN_HEIGHT);
  el.style.maxHeight = `${String(space)}px`;
  const list = el.querySelector<HTMLElement>('[role="listbox"]');
  if (!list) return;
  // The list's room: the space less the card's other parts (hints, border).
  const room = space - (el.offsetHeight - list.offsetHeight);
  const rows = Math.max(1, Math.floor((room - LIST_PADDING) / ROW));
  list.style.maxHeight = room >= LIST_MAX ? "" : `${String(rows * ROW + LIST_PADDING)}px`;
}

/**
 * Refits the open card whenever the space under it or its content can change: the window
 * resizes, the zoom changes, the scroller scrolls, the card changes size (rows come and
 * go), or any ancestor up to the scroller changes size (a growing prompt moves the
 * centered composer, and the card with it).
 */
function useFitBelow(ref: RefObject<HTMLDivElement | null>, open: boolean, above: boolean): void {
  const zoom = useUiStore((s) => s.zoom);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const scroller = scrollerOf(el);
    const refit = () => {
      fit(el, scroller, above);
    };
    refit();
    const observer = new ResizeObserver(refit);
    observer.observe(el);
    for (let p = el.parentElement; p; p = p.parentElement) {
      observer.observe(p);
      if (p === scroller) break;
    }
    window.addEventListener("resize", refit);
    scroller?.addEventListener("scroll", refit, { passive: true });
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", refit);
      scroller?.removeEventListener("scroll", refit);
    };
  }, [ref, open, zoom, above]);
}

/**
 * The completion card, anchored under the composer's worktree row and overlaid (out of
 * flow), so neither the composer card nor that row moves when it opens or closes. Its
 * parent must be positioned and as wide as the composer card. Same surface as the card,
 * full width; its height is capped to the space left below it in the window (fewer rows
 * when short, the hints footer dropped when very short), about eight rows at most, the
 * rest scroll. Rows are text only (bold label, a command's argument hint dimmer, muted
 * detail), grouped under project headings (a dot in the project's hue), "User", and a
 * running thread's "Skills" and "Claude Code"; the selected row has the accent
 * background and a ⏎. A mousedown keeps the focus in the prompt; a click inserts the
 * row. "No skills match" stands in for the rows when nothing matches, "Searching…" while
 * a slow answer is awaited. A file row's name is monospace and its path has the matched
 * characters emphasized.
 */
export function CompletionCard({ completion, above = false }: { completion: Completion; /** Hang over the anchor instead of under it. */ above?: boolean }) {
  const { show, label, groups, selected, listId, optionId, emptyText, select, insert } = completion;
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const active = show === "list" ? optionId(selected) : "";
  useFitBelow(cardRef, show !== "none", above);
  // Brings the selected row into view by scrolling the list only (scrollIntoView could
  // scroll the composer's section too). Rects are viewport px, scrollTop layout px; whole
  // px up, since the list's height is fractional under zoom and clientHeight is rounded.
  useEffect(() => {
    const list = listRef.current;
    const option = active ? document.getElementById(active) : null;
    if (!list || !option) return;
    const o = option.getBoundingClientRect();
    const l = list.getBoundingClientRect();
    const zoom = zoomFactor();
    if (o.top < l.top) list.scrollTop -= Math.ceil((l.top - o.top) / zoom);
    else if (o.bottom > l.bottom) list.scrollTop += Math.ceil((o.bottom - l.bottom) / zoom);
  }, [active]);
  if (show === "none") return null;
  let index = 0;
  return (
    <div
      ref={cardRef}
      className={cn(
        "group/completion absolute inset-x-0 z-10 flex flex-col overflow-hidden rounded-2xl border border-border bg-card/85 text-[13px] shadow-sm backdrop-blur-xl",
        above ? "bottom-full mb-2" : "top-full mt-2",
      )}
      data-testid="completion-card"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      {show !== "list" ? (
        <p className="shrink-0 px-3 py-2.5 text-[13px] text-muted-foreground" role="status" data-testid={show === "searching" ? "completion-searching" : "completion-empty"}>
          {emptyText}
        </p>
      ) : (
        <div ref={listRef} id={listId} role="listbox" aria-label={label} className="max-h-[15.5rem] min-h-0 overflow-y-auto py-1">
          {groups.map((g) => (
            <div key={g.key} role="group" aria-label={g.heading ? undefined : label}>
              {g.heading && <Heading heading={g.heading} />}
              {g.items.map((item) => {
                const i = index++;
                const on = i === selected;
                return (
                  <div
                    key={item.key}
                    id={optionId(i)}
                    role="option"
                    aria-selected={on}
                    data-testid="completion-item"
                    data-selected={on || undefined}
                    className={cn("mx-1 flex h-7 cursor-pointer items-center gap-2 rounded-md px-2", on && "bg-accent")}
                    onMouseMove={() => {
                      select(i);
                    }}
                    onClick={() => {
                      insert(i);
                    }}
                  >
                    <span className={cn("shrink-0 font-medium text-foreground", item.mono && "font-mono")} data-testid="completion-label">
                      {item.label}
                    </span>
                    {item.hint && (
                      <span className="max-w-[40%] shrink-0 truncate text-xs text-muted-foreground/70" data-testid="completion-hint">
                        {item.hint}
                      </span>
                    )}
                    <Detail item={item} />
                    {on && (
                      <span aria-hidden className="shrink-0 text-xs text-muted-foreground">
                        ⏎
                      </span>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      )}
      <div
        className={cn("flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground group-data-[short]/completion:hidden", show !== "list" && "hidden")} data-testid="completion-hints">
        <span className="flex items-center gap-1">
          <Kbd size="sm">↑</Kbd>
          <Kbd size="sm">↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd size="sm">⏎</Kbd>
          <Kbd size="sm">⇥</Kbd> insert
        </span>
        <span className="flex items-center gap-1">
          <Kbd size="sm">esc</Kbd> dismiss
        </span>
      </div>
    </div>
  );
}
