import { useMemo, useRef, useState } from "react";
import type { UsageBucketView } from "@/api/threads";
import { Tip } from "@/components/ui/tooltip";
import { useNowSelect } from "@/lib/clock";
import { canonicalModelName } from "@/lib/models";
import { cacheMinutesLeft, cacheSuffix, cardUsd, contextPercent, foldUsd, USD_SHOWN } from "@/lib/threadInfo";
import { fmtShare, fmtTok, totalUsage, usageByModel } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { useModelChoices } from "@/stores/settings";
import { sameUsage, useThreadsStore } from "@/stores/threads";
import { Group, HOVER_CARD, Row } from "./Row";

const NONE: readonly UsageBucketView[] = [];

/**
 * Context: "Context", the warm cache's minutes beside it ("cached for 41m"), a bar that
 * fills the rest of the row, and the tokens of the window ("221K of 1M"); neither the bar
 * nor the tokens when the window is unknown. No click; the hover card gives the share of
 * the window and, warm, the cache's expiry and what re-reading the context costs after it.
 * An expired cache is the composer's ColdCacheNote to say: the row and the card say
 * nothing of it.
 */
function ContextRow({ threadId }: { threadId: string }) {
  const tokens = useThreadsStore((s) => s.byId[threadId]?.contextTokens ?? 0);
  const window = useThreadsStore((s) => s.byId[threadId]?.contextWindow ?? 0);
  const expires = useThreadsStore((s) => s.byId[threadId]?.cacheExpiresAtMs ?? null);
  const reread = useThreadsStore((s) => s.byId[threadId]?.contextRereadUsd ?? 0);
  // Re-renders when the minute count changes, not on every tick.
  const minutes = useNowSelect(15_000, (now) => cacheMinutesLeft(expires, now));
  const suffix = cacheSuffix(minutes);
  const pct = contextPercent(tokens, window);
  const warm = minutes !== null && minutes > 0;
  const card = (
    <div className={cn(HOVER_CARD, "flex flex-col gap-0.5")}>
      <div>{pct !== null ? `${String(pct)}% of context window used` : `${fmtTok(tokens)} tokens used`}</div>
      {warm && <div>Cache expires in {String(minutes)} min</div>}
      {warm && reread > 0 && <div>{cardUsd(reread)} to re-read it after that</div>}
    </div>
  );
  return (
    <Tip label={card} side="left">
      <Row
        hoverable
        meta={
          pct !== null && (
            <span className="text-cf-text-muted" data-testid="ti-context-tokens">
              {fmtTok(tokens)} of {fmtTok(window)}
            </span>
          )
        }
        testId="ti-context"
      >
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate" data-testid="ti-context-label">
            Context
            {suffix && (
              <>
                {" "}
                <span className="text-cf-text-muted" data-testid="ti-context-cache">
                  {suffix}
                </span>
              </>
            )}
          </span>
          {pct !== null && (
            <span className="h-1 min-w-6 flex-1 overflow-hidden rounded-full bg-cf-text/12" aria-hidden data-testid="ti-context-bar">
              <span className="block h-full bg-cf-text-muted" style={{ width: `${String(pct)}%` }} />
            </span>
          )}
        </span>
      </Row>
    </Tip>
  );
}

/** The thread's usage buckets, kept by identity while their content is the same (the Usage sheet's rule). */
function useUsage(threadId: string): readonly UsageBucketView[] {
  const last = useRef<readonly UsageBucketView[]>(NONE);
  return useThreadsStore((s) => {
    const next = s.byId[threadId]?.usage ?? NONE;
    if (!sameUsage(last.current, next)) last.current = next;
    return last.current;
  });
}

/**
 * Usage: the thread's cost, the Usage tab's total (lib/usage). The hover card splits it by
 * model; the fold gives each token kind's tokens and cost, their total, what the cache
 * reads saved against reading those tokens as input, then the requests.
 */
function UsageRow({ threadId }: { threadId: string }) {
  const usage = useUsage(threadId);
  const total = useMemo(() => totalUsage(usage), [usage]);
  const models = useMemo(() => usageByModel(usage), [usage]);
  const saved = useMemo(() => usage.reduce((s, b) => s + b.cacheSavingsUsd, 0), [usage]);
  const choices = useModelChoices();
  const [open, setOpen] = useState(false);
  const cost = total.allUnpriced ? "unpriced" : cardUsd(total.costUsd);
  const card =
    models.length > 0 ? (
      <div className={cn(HOVER_CARD, "grid w-56 grid-cols-[minmax(0,1fr)_auto_auto] gap-x-2 gap-y-0.5 whitespace-nowrap tabular-nums")}>
        <div className="col-span-3 font-medium">By model</div>
        {models.map((m) => (
          <div key={m.model} className="contents">
            <span className="truncate">{canonicalModelName(choices, m.model)}</span>
            <span className="text-right" data-testid="ti-usage-model-cost">
              {m.allUnpriced ? "—" : cardUsd(m.costUsd)}
            </span>
            <span className="w-11 text-right text-cf-text-muted" data-testid="ti-usage-model-share">
              {m.allUnpriced ? "—" : fmtShare(m.costUsd, total.costUsd)}
            </span>
          </div>
        ))}
      </div>
    ) : null;
  const kinds: [string, number, number][] = [
    ["Input", total.input, total.inputCostUsd],
    ["Output", total.output, total.outputCostUsd],
    ["Cache read", total.cacheRead, total.cacheReadCostUsd],
    ["Cache write", total.cacheWrite5m + total.cacheWrite1h, total.cacheWrite5mCostUsd + total.cacheWrite1hCostUsd],
  ];
  return (
    <>
      <Tip label={card} side="left">
        <Row
          chevron={open ? "open" : "closed"}
          onActivate={() => {
            setOpen((o) => !o);
          }}
          aria-expanded={open}
          meta={<span className="text-cf-text-muted">{cost}</span>}
          testId="ti-usage"
        >
          Usage
        </Row>
      </Tip>
      {open && (
        <div className="grid grid-cols-[1fr_auto_minmax(3rem,auto)] gap-x-2 gap-y-0.5 pt-0.5 pr-7 pb-1.5 pl-2 text-caption-sm tabular-nums" data-testid="ti-usage-detail">
          {kinds.map(([label, tokens, usd]) => (
            <div key={label} className="contents" data-testid="ti-usage-kind">
              <span>{label}</span>
              <span className="text-right text-cf-text">{fmtTok(tokens)}</span>
              <span className="text-right">{foldUsd(usd, total.allUnpriced)}</span>
            </div>
          ))}
          <div className="contents" data-testid="ti-usage-total">
            <span className="text-cf-text">Total</span>
            <span className="text-right text-cf-text">{fmtTok(total.tokens)}</span>
            <span className="text-right text-cf-text">{total.allUnpriced ? "—" : cardUsd(total.costUsd)}</span>
          </div>
          {saved >= USD_SHOWN && (
            <div className="contents" data-testid="ti-usage-saved">
              <span className="col-span-2">Saved by cache reads</span>
              <span className="text-right text-cf-success-text">{cardUsd(saved)}</span>
            </div>
          )}
          <span>Requests</span>
          <span className="text-right text-cf-text">{total.requests.toLocaleString("en-US")}</span>
          <span />
        </div>
      )}
    </>
  );
}

/** The last group: Context and Usage, always there. */
export function ContextGroup({ threadId }: { threadId: string }) {
  return (
    <Group testId="ti-context-group">
      <ContextRow threadId={threadId} />
      <UsageRow threadId={threadId} />
    </Group>
  );
}
