import { useShallow } from "zustand/react/shallow";
import { Tip } from "@/components/ui/tooltip";
import { linkedRowOf, rowAction } from "@/shell/linked";
import { runLinked } from "@/shell/linkedRun";
import { shellSurfaceOf } from "@/shell/surfaces/registry";
import { useThreadName } from "@/shell/useThreadName";
import { cn } from "@/lib/utils";
import { useLayoutStore, type TabEntry } from "@/stores/layout";
import { ThreadDot } from "./ThreadDot";

/**
 * The quiet row under a linked tab's strip (docs/notes/shell-model.md, "Linked surfaces"):
 * "Diff of ● thread", the whole row the link back to the thread (shell/linked.ts rowAction).
 * Live while the thread is open in this space; dormant otherwise, drawn quieter, and naming
 * the space when the thread lives in another. The right end is the surface's own slot
 * (`linkedRowEnd`: a linked terminal's directory hint, PR 13). Nothing for an unlinked tab or a
 * thread's own.
 */
export function LinkedRow({ tab }: { tab: TabEntry }) {
  const row = useLayoutStore(useShallow((s) => linkedRowOf(s, tab)));
  const surface = shellSurfaceOf(tab.kind);
  const name = useThreadName(tab.thread);
  const spaceName = useLayoutStore((s) => (row?.elsewhere ? (s.spaces[row.elsewhere]?.name ?? row.elsewhere) : ""));
  if (!row) return null;
  const end = surface.linkedRowEnd?.(tab);
  return (
    <div
      className={cn("flex h-8 shrink-0 items-center gap-2 border-b border-cf-divider px-2 text-body-sm", row.live ? "text-cf-text" : "text-cf-text-muted")}
      data-testid="shell-linked-row"
      data-live={row.live || undefined}
      data-thread-id={row.thread}
    >
      <button
        type="button"
        className="flex h-6 min-w-0 flex-1 cursor-pointer items-center gap-1.5 rounded-md px-1.5 text-left outline-none hover:bg-cf-control-hover/50 focus-visible:ring-1 focus-visible:ring-cf-focus"
        data-testid="shell-linked-row-link"
        onClick={() => {
          void runLinked(rowAction(row, tab.paneId));
        }}
      >
        <span className="shrink-0 text-cf-text-muted">{surface.linkedNoun ?? tab.kind} of </span>
        <ThreadDot threadId={row.thread} className={cn(!row.live && "opacity-60")} />
        <Tip label={name} whenTruncated side="bottom">
          <span className={cn("min-w-0 truncate", row.live ? "font-medium" : "")} data-testid="shell-linked-row-name">
            {name}
          </span>
        </Tip>
        {row.elsewhere && (
          <span className="shrink-0 text-cf-text-muted" data-testid="shell-linked-row-space">
            · in {spaceName}
          </span>
        )}
      </button>
      {end != null && (
        <span className="flex min-w-0 shrink items-center" data-testid="shell-linked-row-end">
          {end}
        </span>
      )}
    </div>
  );
}
