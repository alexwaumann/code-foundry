import type { CheckRollupView, PullRequestView } from "@/api/gh";
import type { AgeUnits } from "@/lib/duration";

/** The tables' ages, minutes to years: "5m ago", "3h ago", "2d ago", "3w ago", "4mo ago", "2y ago". */
export const PR_AGE: AgeUnits = { minutes: true, hours: true, days: true, weeks: true, months: true, years: true };

/** A table cell's age: "now", "5m", "3h", "2d", "3w", "4mo", "2y". */
export const PR_CELL_AGE: AgeUnits = { ...PR_AGE, ago: false };

/** A poll's freshness: "updated 8s ago", "updated 3m ago", "updated 2d ago". */
export const FETCH_AGE: AgeUnits = { ...PR_AGE, seconds: true };

/** Freshness of a polled value: "fresh", "stale" past `staleAfterMs`, "error" with an error. */
export type Freshness = "fresh" | "stale" | "error" | "never";

export function freshness(fetchedAtMs: number | null, lastError: string, now: number, staleAfterMs: number): Freshness {
  if (lastError) return "error";
  if (fetchedAtMs === null) return "never";
  return now - fetchedAtMs > staleAfterMs ? "stale" : "fresh";
}

/** "2026-10" -> "October" (with the year when it is not `now`'s year). */
export function monthName(month: string, now: number): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) return "—";
  const d = new Date(Number(m[1]), Number(m[2]) - 1, 1);
  const name = d.toLocaleString("en-US", { month: "long" });
  return d.getFullYear() === new Date(now).getFullYear() ? name : `${name} ${String(d.getFullYear())}`;
}

export type ChecksTone = "success" | "failure" | "pending" | "none";

/**
 * Display bucket and label for a check rollup: "12/12 passed", "2/14 failing", "4/13 pending",
 * "no checks"; just "failing" when the rollup fails without a failed check (a commit status).
 */
export function checksSummary(c: CheckRollupView): { tone: ChecksTone; label: string } {
  if (c.total === 0) return { tone: "none", label: "no checks" };
  if (c.failed > 0) return { tone: "failure", label: `${String(c.failed)}/${String(c.total)} failing` };
  if (c.state === "failure" || c.state === "error") return { tone: "failure", label: "failing" };
  if (c.pending > 0 || c.state === "pending" || c.state === "expected") return { tone: "pending", label: `${String(c.pending)}/${String(c.total)} pending` };
  return { tone: "success", label: `${String(c.passed + c.skipped)}/${String(c.total)} passed` };
}

/** "owner/name" -> "name" for narrow repo columns. */
export function repoName(slug: string): string {
  return slug.slice(slug.indexOf("/") + 1) || slug;
}

/** Stable nav key for a pull request in a section. */
export function prKey(section: string, p: Pick<PullRequestView, "repoSlug" | "number">): string {
  return `${section}:${p.repoSlug}#${String(p.number)}`;
}
