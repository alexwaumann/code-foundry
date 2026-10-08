import type { CheckRollupView, PullRequestView, ReviewView } from "@/api/gh";

/** Compact age for tables: "now", "5m", "3h", "2d", "3w", "4mo", "2y"; "—" when unknown. */
export function shortAge(ms: number | null, now: number): string {
  if (ms === null) return "—";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${String(m)}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${String(h)}h`;
  const d = Math.floor(h / 24);
  if (d < 14) return `${String(d)}d`;
  if (d < 60) return `${String(Math.floor(d / 7))}w`;
  if (d < 365) return `${String(Math.floor(d / 30))}mo`;
  return `${String(Math.floor(d / 365))}y`;
}

/** "updated 8s ago" / "updated 3m ago"; "not fetched yet" when never. */
export function updatedAgo(ms: number | null, now: number): string {
  if (ms === null) return "not fetched yet";
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `updated ${String(s)}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `updated ${String(m)}m ago`;
  return `updated ${shortAge(ms, now)} ago`;
}

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

/** Display bucket and label for a check rollup: "✓ 12", "✗ 2/14", "● 3/14", "no checks". */
export function checksSummary(c: CheckRollupView): { tone: ChecksTone; label: string } {
  if (c.total === 0) return { tone: "none", label: "no checks" };
  if (c.failed > 0 || c.state === "failure" || c.state === "error") return { tone: "failure", label: `${String(c.failed)}/${String(c.total)} failing` };
  if (c.pending > 0 || c.state === "pending" || c.state === "expected") return { tone: "pending", label: `${String(c.pending)}/${String(c.total)} pending` };
  return { tone: "success", label: `${String(c.passed + c.skipped)}/${String(c.total)} passed` };
}

export function reviewLabel(r: ReviewView): string {
  switch (r) {
    case "approved":
      return "approved";
    case "changes_requested":
      return "changes requested";
    case "review_required":
      return "review required";
    default:
      return "—";
  }
}

/** "owner/name" -> "name" for narrow repo columns. */
export function repoName(slug: string): string {
  return slug.slice(slug.indexOf("/") + 1) || slug;
}

/** Stable nav key for a pull request in a section. */
export function prKey(section: string, p: Pick<PullRequestView, "repoSlug" | "number">): string {
  return `${section}:${p.repoSlug}#${String(p.number)}`;
}
