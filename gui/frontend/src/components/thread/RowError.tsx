import { useEffect, useRef, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { ErrorBoundary, type FallbackProps } from "@/components/error/ErrorBoundary";
import { ErrorDetails } from "@/components/error/fallbacks";
import { rowItemIds } from "@/lib/rowItemIds";
import { useThreadStore } from "@/stores/thread";

/**
 * A row that threw while rendering: one line saying so, with its items' raw JSON behind
 * Details. It retries when one of its items changes (a running tool's result arriving may
 * complete what was partial).
 */
function RowFallback({ threadId, row, error, reset }: FallbackProps & { threadId: string; row: unknown }) {
  const ids = rowItemIds(row);
  const items = useThreadStore(useShallow((s) => ids.map((id) => s.logs[threadId]?.byId[id])));
  const first = useRef(items);
  useEffect(() => {
    if (items.some((it, i) => it !== first.current[i])) reset();
  }, [items, reset]);
  const found = items.filter((it) => it !== undefined);
  let raw: string;
  try {
    raw = JSON.stringify(found.length > 0 ? found : row, (_k, v: unknown) => (typeof v === "bigint" ? v.toString() : v), 2);
  } catch {
    raw = "";
  }
  return (
    <div className="flex flex-col gap-0.5 py-1 text-body-sm text-cf-text-muted" role="alert" data-testid="row-error">
      <div className="flex items-center gap-1.5">
        <TriangleAlert className="size-3.5 shrink-0 text-cf-error" aria-hidden />
        Could not render this item.
      </div>
      <ErrorDetails error={error} raw={raw} />
    </div>
  );
}

/** One timeline row behind its own error boundary: a broken row degrades alone. */
export function RowBoundary({ threadId, row, children }: { threadId: string; row: unknown; children: ReactNode }) {
  return (
    <ErrorBoundary label="timeline row" fallback={(p) => <RowFallback {...p} threadId={threadId} row={row} />}>
      {children}
    </ErrorBoundary>
  );
}
