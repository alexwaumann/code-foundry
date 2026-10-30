import { CircleCheck, CircleDashed, CircleDot, CircleX } from "lucide-react";
import type { CheckRollupView, PrStateView } from "@/api/gh";
import { prStateText, toneText } from "@/components/pr/tones";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { checksSummary, freshness, shortAge, updatedAgo } from "./format";
import { prStateLook } from "./prState";

export function ChecksBadge({ checks, compact = false }: { checks: CheckRollupView; compact?: boolean }) {
  const { tone, label } = checksSummary(checks);
  const Icon = tone === "success" ? CircleCheck : tone === "failure" ? CircleX : tone === "pending" ? CircleDot : CircleDashed;
  // Compact shows the icon alone: the label is its tooltip.
  return (
    <Tip label={compact ? label : null}>
      <span className={cn("inline-flex items-center gap-1 text-body-sm tabular-nums", toneText[tone === "none" ? "neutral" : tone])} role={compact ? "img" : undefined} aria-label={compact ? label : undefined} data-checks={tone}>
        <Icon className="size-3.5 shrink-0" aria-hidden />
        {!compact && <span className="truncate">{label}</span>}
      </span>
    </Tip>
  );
}

export function PrStateIcon({ state, draft }: { state: PrStateView; draft: boolean }) {
  const look = prStateLook(state, draft);
  const Icon = look.icon;
  return <Icon className={cn("size-3.5 shrink-0", prStateText[look.tone])} aria-label={look.label} />;
}

/** Relative age that refreshes every 30s. */
export function Age({ ms, className }: { ms: number | null; className?: string }) {
  const now = useNow(30_000);
  return (
    <Tip label={ms === null ? null : new Date(ms).toLocaleString()}>
      <span className={cn("text-caption tabular-nums", className)}>{shortAge(ms, now)}</span>
    </Tip>
  );
}

/** "updated 8s ago", amber when stale, red with the error when the last poll failed. */
export function Freshness({ fetchedAtMs, lastError, staleAfterMs, testId }: { fetchedAtMs: number | null; lastError: string; staleAfterMs: number; testId?: string }) {
  const now = useNow(1000);
  const f = freshness(fetchedAtMs, lastError, now, staleAfterMs);
  const cls = f === "error" ? toneText.failure : f === "stale" ? toneText.pending : toneText.neutral;
  const text = updatedAgo(fetchedAtMs, now) + (f === "stale" ? " · stale" : "");
  return (
    <Tip label={lastError}>
      <span className={cn("text-caption tabular-nums", cls)} data-testid={testId} data-freshness={f}>
        {text}
        {f === "error" && " · last poll failed"}
      </span>
    </Tip>
  );
}

export function SectionTitle({ children, count, extra }: { children: React.ReactNode; count?: number; extra?: React.ReactNode }) {
  return (
    <h2 className="mb-1.5 flex items-baseline gap-2 text-heading">
      <span>{children}</span>
      {count !== undefined && <span className="text-caption tabular-nums">({count})</span>}
      {extra && <span className="ml-auto text-body-sm">{extra}</span>}
    </h2>
  );
}
