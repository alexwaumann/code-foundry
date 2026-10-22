import { useMemo, useRef, type CSSProperties } from "react";
import type { UsageBucketView } from "@/api/threads";
import { Tip } from "@/components/ui/tooltip";
import { fmtRequests, fmtShare, fmtTok, fmtUsd, modelColorVars, SWATCH_BG, TOKEN_KINDS, totalUsage, usageByModel, type ModelUsage } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { sameUsage, useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";

const NONE: readonly UsageBucketView[] = [];

/**
 * The thread this panel belongs to: the selected thread; "" otherwise (the panel always
 * shows the current selection's panel).
 */
function useThreadId(): string {
  return useUiStore((s) => (s.selection.kind === "thread" ? s.selection.id : ""));
}

/**
 * The thread's usage buckets. Every thread update carries a new array, so the previous
 * one is kept while its content is the same: status changes do not re-render the surface.
 */
function useUsage(threadId: string): readonly UsageBucketView[] {
  const last = useRef<readonly UsageBucketView[]>(NONE);
  return useThreadsStore((s) => {
    const next = s.byId[threadId]?.usage ?? NONE;
    if (!sameUsage(last.current, next)) last.current = next;
    return last.current;
  });
}

/** "unpriced": the model has no known rate (its cost is a dash). */
function UnpricedTag() {
  return (
    <span className="ml-1.5 inline-block rounded-sm border border-cf-border px-[5px] py-px align-[1px] text-caption-sm leading-none" data-testid="usage-unpriced">
      unpriced
    </span>
  );
}

function ModelRow({ row, total }: { row: ModelUsage; total: number }) {
  const noCost = row.allUnpriced;
  return (
    <div className="flex items-center gap-2.5 border-b border-cf-border py-2 last:border-b-0" data-testid="usage-model" data-model={row.model}>
      <span className={cn("size-2 shrink-0", SWATCH_BG)} style={modelColorVars(row.model) as CSSProperties} data-testid="usage-swatch" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center">
          <Tip label={row.model} whenTruncated>
            <span className="min-w-0 truncate text-body-sm font-mono" data-testid="usage-model-name">
              {row.model}
            </span>
          </Tip>
          {row.unpriced && <UnpricedTag />}
        </div>
        <div className="mt-0.5 text-caption-sm tabular-nums" data-testid="usage-model-meta">
          {fmtTok(row.tokens)} tokens · {fmtRequests(row.requests)}
        </div>
      </div>
      <div className="shrink-0 text-right tabular-nums">
        <div className={cn("text-body-sm", noCost && "text-cf-text-muted")} data-testid="usage-model-cost">
          {noCost ? "—" : fmtUsd(row.costUsd)}
        </div>
        <div className="mt-0.5 text-caption-sm" data-testid="usage-model-share">
          {noCost ? "—" : fmtShare(row.costUsd, total)}
        </div>
      </div>
    </div>
  );
}

/**
 * The side panel's Usage surface (docs/sketches/session-usage/DESIGN.md, thread view):
 * the selected thread's cost at Claude API rates, its tokens and requests, then per model
 * (swatch, id, tokens and requests; cost and share of cost) and per token kind (tokens
 * and cost). A model without a known rate is tagged "unpriced" and costs "—"; the totals
 * then exclude it (a lower bound).
 */
export function UsageSurface() {
  const threadId = useThreadId();
  const known = useThreadsStore((s) => threadId !== "" && s.byId[threadId] !== undefined);
  const usage = useUsage(threadId);
  const total = useMemo(() => totalUsage(usage), [usage]);
  const models = useMemo(() => usageByModel(usage), [usage]);

  if (!known) {
    return (
      <p className="px-4 py-3 text-body text-cf-text-muted" data-testid="usage-missing">
        Select a thread to see its usage.
      </p>
    );
  }
  if (total.requests === 0 && total.tokens === 0) {
    return (
      <div className="px-4 pt-5 pb-8" data-testid="usage-surface" data-thread={threadId}>
        <p className="text-body text-cf-text-muted" data-testid="usage-empty">
          No usage yet. Tokens and cost show up here after the thread's first request.
        </p>
      </div>
    );
  }
  const noCost = total.allUnpriced;
  return (
    // @container: tightens the padding when the panel is narrow (down to 280px).
    <div className="@container px-4 pt-5 pb-8 @max-[340px]:px-3" data-testid="usage-surface" data-thread={threadId}>
      <div className={cn("text-display-sm", noCost && "text-cf-text-muted")} data-testid="usage-cost">
        {noCost ? "—" : fmtUsd(total.costUsd)}
      </div>
      <div className="mt-2 text-caption" data-testid="usage-summary">
        <b className="font-medium text-cf-text tabular-nums">{fmtTok(total.tokens)}</b> tokens · <b className="font-medium text-cf-text tabular-nums">{total.requests.toLocaleString("en-US")}</b>{" "}
        {total.requests === 1 ? "request" : "requests"}
      </div>

      <h3 className="mt-[26px] mb-1 text-subheading">By model</h3>
      <div data-testid="usage-models">
        {models.map((m) => (
          <ModelRow key={m.model} row={m} total={total.costUsd} />
        ))}
      </div>

      <h3 className="mt-[26px] mb-1 text-subheading">Tokens</h3>
      <div className="mt-2 grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1.5 text-body-sm" data-testid="usage-tokens">
        <div className="border-b border-cf-border pb-1 text-caption-sm">Bucket</div>
        <div className="border-b border-cf-border pb-1 text-right text-caption-sm">Tokens</div>
        <div className="border-b border-cf-border pb-1 text-right text-caption-sm">Cost</div>
        {TOKEN_KINDS.map((k) => (
          <div key={k.kind} className="contents" data-testid="usage-kind" data-kind={k.kind}>
            <div>{k.label}</div>
            <div className="text-right tabular-nums" data-testid="usage-kind-tokens">
              {fmtTok(total[k.kind])}
            </div>
            <div className="text-right text-cf-text-muted tabular-nums" data-testid="usage-kind-cost">
              {noCost ? "—" : fmtUsd(total[k.cost])}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
