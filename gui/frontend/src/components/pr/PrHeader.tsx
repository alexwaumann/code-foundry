import { ArrowLeft } from "lucide-react";
import type { ReactNode } from "react";
import type { PullRequestDetailView } from "@/api/gh";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import type { StatusTone } from "./readiness";
import { RepoRef } from "./RepoRef";

type HeaderDetail = Pick<PullRequestDetailView, "pullRequest">;

/** The header's wash: the state's tone, strongest at the top. None for a draft (neutral). */
const headerWash: Record<StatusTone, string> = {
  success: "bg-linear-to-b from-cf-success/11 to-cf-success/4",
  warning: "bg-linear-to-b from-cf-warning/11 to-cf-warning/4",
  merged: "bg-linear-to-b from-cf-highlight/11 to-cf-highlight/4",
  failure: "bg-linear-to-b from-cf-error/11 to-cf-error/4",
  neutral: "",
};

/**
 * The surface's header, the same on every inner tab, one block: a quiet top line with
 * owner/repo #number at the left and `menu` (the ⋯ menu) at its right end; the title; a
 * quiet mono line, base ← head, whose head branch gives way; then `status` (HeaderStatus:
 * the state in words and the buttons), with no divider between them. The whole header
 * carries a wash of the state's `tone`. The surface marks itself `data-short` when its pane
 * is under 480px tall, and the header tightens.
 */
export function PrHeader({ d, prRef, menu, tone, status }: { d: HeaderDetail; prRef: PrRef; menu: ReactNode; tone: StatusTone; status: ReactNode }) {
  const pr = d.pullRequest;
  const repo = `${prRef.slug} #${String(prRef.number)}`;
  return (
    <header className={cn("flex min-w-0 flex-col border-b border-cf-divider", headerWash[tone])} data-testid="pr-header" data-tone={tone} data-state={pr.state === "open" && pr.draft ? "draft" : pr.state}>
      <div className="flex min-w-0 flex-col pt-1.5 pr-3 pb-2.5 pl-4 group-data-short/pr:pt-0.5 group-data-short/pr:pb-1.5">
        {/* The ⋯ button sets this line's height; the text sits in its middle, so the title needs no gap above it. */}
        <div className="flex min-w-0 items-center gap-2 text-caption text-cf-text-muted" data-testid="pr-top-line">
          <Tip label={repo} whenTruncated>
            <span className="min-w-0 truncate" data-testid="pr-repo">
              <RepoRef slug={prRef.slug} number={prRef.number} />
            </span>
          </Tip>
          <span className="ml-auto flex shrink-0 items-center" data-testid="pr-actions">
            {menu}
          </span>
        </div>
        <h2 className="min-w-0 text-heading break-words select-text" data-testid="pr-title">
          {pr.title || `#${String(prRef.number)}`}
        </h2>
        <Tip label={`${pr.baseRef} ← ${pr.headRef}`} whenTruncated align="start">
          <span className="mt-0.5 flex min-w-0 items-center gap-1 font-mono text-caption text-cf-text-muted" data-testid="pr-branches">
            <span className="max-w-[40%] min-w-0 shrink-0 truncate">{pr.baseRef}</span>
            <ArrowLeft className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{pr.headRef}</span>
          </span>
        </Tip>
        <div className="mt-2 group-data-short/pr:mt-1" data-testid="pr-status-section">
          {status}
        </div>
      </div>
    </header>
  );
}
