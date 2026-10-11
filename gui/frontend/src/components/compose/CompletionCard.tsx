import { useEffect, useLayoutEffect, useRef, type ReactNode, type RefObject } from "react";
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

function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="inline-block min-w-4 rounded border px-1 text-center font-sans text-[10px] leading-[15px] text-muted-foreground">{children}</kbd>;
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
      {heading.kind === "project" ? <ProjectHeading repoId={heading.repoId} /> : <span>User</span>}
    </div>
  );
}

/** Layout px kept free between the card and the bottom of the visible area. */
const BOTTOM_MARGIN = 16;
/** One row plus the list's padding and the card's border: the card never gets shorter. */
const MIN_HEIGHT = 28 + 8 + 2;
/** Below this the hints footer hides, leaving the space to the rows (two rows and the footer). */
const HINTS_MIN_HEIGHT = 2 * 28 + 8 + 2 + 29;

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
 * (the scroller's box, the window), less a margin. Rects are viewport px; the max-height
 * is layout px, so the distance is divided by the page zoom.
 */
function fit(el: HTMLElement, scroller: HTMLElement | null): void {
  const top = el.getBoundingClientRect().top;
  const bottom = Math.min(window.innerHeight, scroller ? scroller.getBoundingClientRect().bottom : Infinity);
  const space = Math.floor((bottom - top) / zoomFactor()) - BOTTOM_MARGIN;
  el.style.maxHeight = `${String(Math.max(space, MIN_HEIGHT))}px`;
  el.toggleAttribute("data-short", space < HINTS_MIN_HEIGHT);
}

/**
 * Refits the open card whenever the space under it can change: the window resizes, the
 * zoom changes, the scroller scrolls, or any ancestor up to the scroller changes size (a
 * growing prompt moves the centered composer, and the card with it).
 */
function useFitBelow(ref: RefObject<HTMLDivElement | null>, open: boolean): void {
  const zoom = useUiStore((s) => s.zoom);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!open || !el) return;
    const scroller = scrollerOf(el);
    const refit = () => {
      fit(el, scroller);
    };
    refit();
    const observer = new ResizeObserver(refit);
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
  }, [ref, open, zoom]);
}

/**
 * The completion card, anchored under the composer's worktree row and overlaid (out of
 * flow), so neither the composer card nor that row moves when it opens or closes. Its
 * parent must be positioned and as wide as the composer card. Same surface as the card,
 * full width; its height is capped to the space left below it in the window (fewer rows
 * when short, the hints footer dropped when very short), about eight rows at most, the
 * rest scroll. Rows are text only (bold label, muted detail), grouped under project
 * headings (a dot in the project's hue) and "User"; the selected row has the accent
 * background and a ⏎. A mousedown keeps the focus in the prompt; a click inserts the
 * row. "No skills match" stands in for the rows when nothing matches, "Searching…" while
 * a slow answer is awaited. A file row's name is monospace and its path has the matched
 * characters emphasized.
 */
export function CompletionCard({ completion }: { completion: Completion }) {
  const { show, label, groups, selected, listId, optionId, emptyText, select, insert } = completion;
  const cardRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const active = show === "list" ? optionId(selected) : "";
  useFitBelow(cardRef, show !== "none");
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
      className="group/completion absolute inset-x-0 top-full z-10 mt-2 flex flex-col overflow-hidden rounded-2xl border border-border bg-card/85 text-[13px] shadow-sm backdrop-blur-xl"
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
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>⏎</Kbd>
          <Kbd>⇥</Kbd> insert
        </span>
        <span className="flex items-center gap-1">
          <Kbd>esc</Kbd> dismiss
        </span>
      </div>
    </div>
  );
}
