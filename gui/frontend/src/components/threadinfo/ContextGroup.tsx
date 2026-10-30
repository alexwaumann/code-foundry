import { useMemo, useRef, useState } from "react";
import type { UsageBucketView } from "@/api/threads";
import { Tip } from "@/components/ui/tooltip";
import { useNowSelect } from "@/lib/clock";
import { canonicalModelName } from "@/lib/models";
import { cacheMinutesLeft, cacheSuffix, contextPercent } from "@/lib/threadInfo";
import { fmtShare, fmtTok, fmtUsd, totalUsage, usageByModel } from "@/lib/usage";
import { cn } from "@/lib/utils";
import { useModelChoices } from "@/stores/settings";
import { sameUsage, useThreadsStore } from "@/stores/threads";
import { Group, HOVER_CARD, Row } from "./Row";

const NONE: readonly UsageBucketView[] = [];

/**
 * Context: how full the context window is (a 56px bar and the percentage; neither when the
 * window is unknown) and how long the prompt cache stays warm. No click; the hover card
 * gives the tokens and the cache.
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
      <div>{window > 0 ? `${fmtTok(tokens)} of ${fmtTok(window)} tokens used` : `${fmtTok(tokens)} tokens used`}</div>
      {warm && <div>{fmtTok(tokens)} cached</div>}
      <div>
        {expires === null
          ? "No prompt cache yet"
          : warm
            ? `Cache expires in ${String(minutes)} min`
            : `Cache expired${reread > 0 ? `: the next message re-reads it for ${fmtUsd(reread)}` : ""}`}
      </div>
    </div>
  );
  return (
    <Tip label={card} side="left">
      <Row
        hoverable
        meta={
          pct !== null && (
            <>
              <span className="inline-block h-1 w-14 overflow-hidden rounded-full bg-cf-border" aria-hidden>
                <span className="block h-full bg-cf-text-muted" style={{ width: `${String(pct)}%` }} />
              </span>
              <span data-testid="ti-context-pct">{pct}%</span>
            </>
          )
        }
        testId="ti-context"
      >
        Context
        {suffix && <span className="text-cf-text-muted"> · {suffix}</span>}
      </Row>
    </Tip>
  );
}

/** The thread's usage buckets, kept by identity while their content is the same (UsageSurface's rule). */
function useUsage(threadId: string): readonly UsageBucketView[] {
  const last = useRef<readonly UsageBucketView[]>(NONE);
  return useThreadsStore((s) => {
    const next = s.byId[threadId]?.usage ?? NONE;
    if (!sameUsage(last.current, next)) last.current = next;
    return last.current;
  });
}

/**
 * Usage: the thread's cost and tokens, the Usage tab's totals (lib/usage). The hover card
 * splits the cost by model; the fold gives each token kind's tokens and cost, then the
 * requests.
 */
function UsageRow({ threadId }: { threadId: string }) {
  const usage = useUsage(threadId);
  const total = useMemo(() => totalUsage(usage), [usage]);
  const models = useMemo(() => usageByModel(usage), [usage]);
  const choices = useModelChoices();
  const [open, setOpen] = useState(false);
  const cost = total.allUnpriced ? "unpriced" : fmtUsd(total.costUsd);
  const card =
    models.length > 0 ? (
      <div className={cn(HOVER_CARD, "flex w-56 flex-col gap-0.5")}>
        <div className="font-medium">By model</div>
        {models.map((m) => (
          <div key={m.model} className="flex gap-2 tabular-nums">
            <span className="min-w-0 flex-1 truncate">{canonicalModelName(choices, m.model)}</span>
            <span>{m.allUnpriced ? "—" : fmtUsd(m.costUsd)}</span>
            <span className="w-11 text-right text-cf-text-muted">{m.allUnpriced ? "—" : fmtShare(m.costUsd, total.costUsd)}</span>
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
          testId="ti-usage"
        >
          Usage
          <span className="text-cf-text-muted">
            {" · "}
            {cost} · {fmtTok(total.tokens)} tokens
          </span>
        </Row>
      </Tip>
      {open && (
        <div className="grid grid-cols-[1fr_auto_minmax(3rem,auto)] gap-x-2 gap-y-0.5 pt-0.5 pr-7 pb-1.5 pl-2 text-caption-sm tabular-nums" data-testid="ti-usage-detail">
          {kinds.map(([label, tokens, usd]) => (
            <div key={label} className="contents" data-testid="ti-usage-kind">
              <span>{label}</span>
              <span className="text-right text-cf-text">{fmtTok(tokens)}</span>
              <span className="text-right">{total.allUnpriced ? "—" : fmtUsd(usd)}</span>
            </div>
          ))}
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
