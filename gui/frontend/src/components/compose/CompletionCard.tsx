import { useEffect, type ReactNode } from "react";
import { projectHue } from "@/lib/compose";
import { cn } from "@/lib/utils";
import { useReposStore } from "@/stores/repos";
import type { Completion, CompletionGroup } from "./useCompletion";

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

/**
 * The completion card under the composer card: same surface as the card, full width.
 * Rows are text only (bold label, muted detail), grouped under project headings (a dot
 * in the project's hue) and "User"; the selected row has the accent background and a ⏎.
 * About eight rows show, the rest scroll. A mousedown keeps the focus in the prompt; a
 * click inserts the row. "No skills match" stands in for the rows when nothing matches.
 */
export function CompletionCard({ completion, label }: { completion: Completion; label: string }) {
  const { show, groups, selected, listId, optionId, emptyText, select, insert } = completion;
  const active = show === "list" ? optionId(selected) : "";
  useEffect(() => {
    if (active) document.getElementById(active)?.scrollIntoView({ block: "nearest" });
  }, [active]);
  if (show === "none") return null;
  let index = 0;
  return (
    <div
      className="mt-2 overflow-hidden rounded-2xl border border-border bg-card/85 text-sm shadow-sm backdrop-blur-xl"
      data-testid="completion-card"
      onMouseDown={(e) => {
        e.preventDefault();
      }}
    >
      {show === "empty" ? (
        <p className="px-3 py-2.5 text-[13px] text-muted-foreground" role="status" data-testid="completion-empty">
          {emptyText}
        </p>
      ) : (
        <div id={listId} role="listbox" aria-label={label} className="max-h-[17.5rem] overflow-y-auto py-1">
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
                    className={cn("mx-1 flex h-8 cursor-pointer items-center gap-2 rounded-md px-2", on && "bg-accent")}
                    onMouseMove={() => {
                      select(i);
                    }}
                    onClick={() => {
                      insert(i);
                    }}
                  >
                    <span className="shrink-0 font-medium text-foreground">{item.label}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{item.detail}</span>
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
      <div className={cn("flex items-center gap-3 border-t px-3 py-1.5 text-[11px] text-muted-foreground", show === "empty" && "hidden")} data-testid="completion-hints">
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
