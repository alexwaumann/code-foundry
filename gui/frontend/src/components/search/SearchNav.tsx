import { Loader2, Sparkle } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { startCommandNamed } from "@/keys/bindings";
import { searchRow } from "@/lib/searchActivity";
import { cn } from "@/lib/utils";
import { useSearchActivityStore } from "@/stores/searchActivity";
import { useUiStore } from "@/stores/ui";

/**
 * The sidebar's search row, after Projects (docs/notes/search-sidebar-row.md): an agent
 * search goes on behind a closed dialog, and this says that it runs, then that it has
 * finished and is unseen. It is there only with something to say, and never while the
 * dialog is open. A click runs search.open on that search, which shows it and so marks it
 * seen; another unseen search then takes the row.
 */
export function SearchNav() {
  const dialogOpen = useUiStore((s) => s.palette.open && s.palette.page === "search");
  const row = useSearchActivityStore(useShallow((s) => searchRow(s.activity)));
  if (dialogOpen || !row) return null;
  return (
    <button
      type="button"
      className="mt-0.5 flex h-7 items-center gap-2 rounded-md px-2 text-left text-body-sm text-cf-sidebar-foreground hover:bg-cf-sidebar-row-hover"
      data-testid="nav-search"
      data-state={row.kind}
      onClick={() => {
        startCommandNamed("search.open", { id: row.id });
      }}
    >
      <Sparkle className="size-4 shrink-0 text-cf-icon-muted" aria-hidden />
      <span className={cn("truncate", row.kind === "failed" && "text-cf-error-text")}>{row.label}</span>
      {row.kind === "running" && <Loader2 className="ml-auto size-3.5 shrink-0 animate-spin text-cf-icon-muted" aria-hidden data-testid="nav-search-spinner" />}
      {row.count > 0 && (
        <span
          className="ml-auto inline-flex h-[18px] min-w-[18px] shrink-0 items-center justify-center rounded-full bg-cf-warning-surface px-1.5 text-caption-sm font-semibold tabular-nums text-cf-warning-text"
          data-testid="nav-search-count"
        >
          {row.count}
        </span>
      )}
    </button>
  );
}
