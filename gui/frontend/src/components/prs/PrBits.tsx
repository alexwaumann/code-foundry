import { CircleCheck, CircleDashed, CircleDot, CircleX } from "lucide-react";
import type { CheckRollupView, PrStateView, ReviewView } from "@/api/gh";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { checksSummary, freshness, reviewLabel, shortAge, updatedAgo } from "./format";
import { prStateLook, type PrStateTone } from "./prState";

const toneClass = {
  success: "text-emerald-400",
  failure: "text-red-400",
  pending: "text-amber-300",
  none: "text-muted-foreground",
} as const;

export function ChecksBadge({ checks, compact = false }: { checks: CheckRollupView; compact?: boolean }) {
  const { tone, label } = checksSummary(checks);
  const Icon = tone === "success" ? CircleCheck : tone === "failure" ? CircleX : tone === "pending" ? CircleDot : CircleDashed;
  return (
    <span className={cn("inline-flex items-center gap-1 tabular-nums", toneClass[tone])} title={label} data-checks={tone}>
      <Icon className="size-3.5 shrink-0" aria-hidden />
      {!compact && <span className="truncate text-xs">{label}</span>}
    </span>
  );
}

const reviewClass: Record<NonNullable<ReviewView> | "none", string> = {
  approved: "text-emerald-400",
  changes_requested: "text-red-400",
  review_required: "text-amber-300",
  none: "text-muted-foreground",
};

export function ReviewBadge({ review }: { review: ReviewView }) {
  return <span className={cn("truncate text-xs", reviewClass[review ?? "none"])}>{reviewLabel(review)}</span>;
}

/** The PR lists' state colours (the dark-first 400s). */
const stateIconClass: Record<PrStateTone, string> = {
  emerald: "text-emerald-400",
  violet: "text-violet-400",
  red: "text-red-400",
  muted: "text-muted-foreground",
};

export function PrStateIcon({ state, draft }: { state: PrStateView; draft: boolean }) {
  const look = prStateLook(state, draft);
  const Icon = look.icon;
  return <Icon className={cn("size-3.5 shrink-0", stateIconClass[look.tone])} aria-label={look.label} />;
}

/** Relative age that refreshes every 30s. */
export function Age({ ms, className }: { ms: number | null; className?: string }) {
  const now = useNow(30_000);
  return (
    <span className={cn("text-xs text-muted-foreground tabular-nums", className)} title={ms === null ? undefined : new Date(ms).toLocaleString()}>
      {shortAge(ms, now)}
    </span>
  );
}

/** "updated 8s ago", amber when stale, red with the error when the last poll failed. */
export function Freshness({ fetchedAtMs, lastError, staleAfterMs, testId }: { fetchedAtMs: number | null; lastError: string; staleAfterMs: number; testId?: string }) {
  const now = useNow(1000);
  const f = freshness(fetchedAtMs, lastError, now, staleAfterMs);
  const cls = f === "error" ? "text-red-400" : f === "stale" ? "text-amber-300" : "text-muted-foreground";
  const text = updatedAgo(fetchedAtMs, now) + (f === "stale" ? " · stale" : "");
  return (
    <span className={cn("text-xs tabular-nums", cls)} title={lastError || undefined} data-testid={testId} data-freshness={f}>
      {text}
      {f === "error" && " · last poll failed"}
    </span>
  );
}

export function SectionTitle({ children, count, extra }: { children: React.ReactNode; count?: number; extra?: React.ReactNode }) {
  return (
    <h2 className="mb-1.5 flex items-baseline gap-2 text-sm font-semibold">
      <span>{children}</span>
      {count !== undefined && <span className="text-xs font-normal text-muted-foreground tabular-nums">({count})</span>}
      {extra && <span className="ml-auto text-xs font-normal">{extra}</span>}
    </h2>
  );
}
