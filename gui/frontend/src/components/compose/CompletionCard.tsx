import { useEffect, useRef, type ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";
import { projectHue } from "@/lib/compose";
import { cn } from "@/lib/utils";
import { zoomFactor } from "@/lib/zoom";
import { useProjectsStore } from "@/stores/projects";
import type { Completion, CompletionGroup, CompletionItem } from "./useCompletion";
import { useFitBelow } from "./useFitBelow";

/** A row's muted detail, its emphasized ranges (a path's matched characters) in the foreground. */
function Detail({ item }: { item: CompletionItem }) {
  const parts: ReactNode[] = [];
  let at = 0;
  for (const [from, to] of item.emphasis ?? []) {
    if (from > at) parts.push(item.detail.slice(at, from));
    parts.push(
      <b key={from} className="font-medium text-cf-text" data-testid="completion-hit">
        {item.detail.slice(from, to)}
      </b>,
    );
    at = to;
  }
  parts.push(item.detail.slice(at));
  return <span className="min-w-0 flex-1 truncate text-caption">{parts}</span>;
}

function ProjectHeading({ projectId }: { projectId: string }) {
  const name = useProjectsStore((s) => s.byId[projectId]?.name ?? projectId);
  return (
    <>
      <span aria-hidden className="size-1.5 shrink-0 rounded-full" style={{ backgroundColor: `oklch(0.55 0.13 ${String(projectHue(name))})` }} />
      <span className="truncate">{name}</span>
    </>
  );
}

function Heading({ heading }: { heading: NonNullable<CompletionGroup["heading"]> }) {
  return (
    <div role="presentation" className="flex items-center gap-1.5 px-3 pt-2 pb-0.5 text-caption-sm" data-testid="completion-group">
      {heading.kind === "project" ? <ProjectHeading projectId={heading.projectId} /> : <span>{heading.kind === "user" ? "User" : heading.text}</span>}
    </div>
  );
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
        "group/completion absolute inset-x-0 z-10 flex flex-col overflow-hidden rounded-lg border border-cf-border bg-cf-surface-raised/85 text-body-sm shadow-sm backdrop-blur-xl",
        above ? "bottom-full mb-2" : "top-full mt-2",
      )}
      data-testid="completion-card"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      {show !== "list" ? (
        <p className="shrink-0 px-3 py-2.5 text-caption" role="status" data-testid={show === "searching" ? "completion-searching" : "completion-empty"}>
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
                    className={cn("mx-1 flex h-7 cursor-pointer items-center gap-2 rounded-md px-2", on && "bg-cf-control-hover")}
                    onMouseMove={() => {
                      select(i);
                    }}
                    onClick={() => {
                      insert(i);
                    }}
                  >
                    <span className={cn("shrink-0 font-medium text-cf-text", item.mono && "font-mono")} data-testid="completion-label">
                      {item.label}
                    </span>
                    {item.hint && (
                      <span className="max-w-[40%] shrink-0 truncate text-caption text-cf-text-muted/70" data-testid="completion-hint">
                        {item.hint}
                      </span>
                    )}
                    <Detail item={item} />
                    {on && (
                      <span aria-hidden className="shrink-0 text-caption">
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
        className={cn("flex shrink-0 items-center gap-3 border-t px-3 py-1.5 text-caption-sm group-data-[short]/completion:hidden", show !== "list" && "hidden")} data-testid="completion-hints">
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
