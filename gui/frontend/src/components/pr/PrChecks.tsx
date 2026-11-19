import { ExternalLink } from "lucide-react";
import type { CheckView, PullRequestDetailView } from "@/api/gh";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { checkIcon, useChecksClock } from "./checkIcons";
import { checkMeta, checkTone } from "./model";
import { toneText } from "./tones";

function CheckRow({ c, now }: { c: CheckView; now: number }) {
  const tone = checkTone(c);
  const Icon = checkIcon[tone];
  // The name and description (the row has no room for the latter; without one, only when
  // the name is cut). On the item: a check without a URL is a disabled button (no pointer events).
  return (
    <Tip label={[c.name, c.description].filter(Boolean).join("\n")} whenTruncated={!c.description} align="start">
      <li>
        <button
          type="button"
          disabled={!c.url}
          className="group flex h-6 w-full items-center gap-2 rounded-md px-1.5 text-left text-body-sm outline-none enabled:hover:bg-cf-control-hover/60 focus-visible:ring-1 focus-visible:ring-cf-focus disabled:cursor-default"
          data-testid="pr-check"
          data-tone={tone}
          onClick={() => void openUrl(c.url)}
        >
          <Icon className={cn("size-3.5 shrink-0", toneText[tone], tone === "pending" && c.status === "in_progress" && "animate-pulse")} aria-label={tone} />
          <span className="min-w-0 truncate">{c.name}</span>
          {c.workflow && <span className="min-w-0 shrink truncate text-caption">{c.workflow}</span>}
          <span className="ml-auto shrink-0 text-caption tabular-nums" data-testid="pr-check-meta">
            {checkMeta(c, now)}
          </span>
          <ExternalLink className={cn("size-3 shrink-0 text-cf-text-muted opacity-0", c.url && "group-hover:opacity-100")} aria-hidden />
        </button>
      </li>
    </Tip>
  );
}

/**
 * Checks on the head commit, failed first; each opens its log and says "queued", how long it
 * has run (ticking) or how long it took. `checks`: only those (a failing or running card
 * folded); every check otherwise, with the note when not all were fetched.
 */
export function CheckList({ d, checks }: { d: PullRequestDetailView; checks?: readonly CheckView[] }) {
  const now = useChecksClock(d.checks);
  const shown = checks ?? d.checks;
  return (
    <>
      <ul className="-mx-1.5 flex flex-col" data-testid="pr-checks-list" data-all={checks === undefined || undefined}>
        {shown.map((c, i) => (
          <CheckRow key={`${c.workflow}/${c.name}/${String(i)}`} c={c} now={now} />
        ))}
      </ul>
      {checks === undefined && d.checksTruncated && (
        <p className="mt-1.5 text-caption" data-testid="pr-truncated">
          Not every check could be listed{d.lastError && !d.fetchFailed ? `: ${d.lastError}` : "."} The rest are on GitHub.
        </p>
      )}
    </>
  );
}
