import { ArrowLeft, ExternalLink, FileDiff, GitMerge, GitPullRequest, GitPullRequestClosed, GitPullRequestDraft } from "lucide-react";
import type { PullRequestDetailView } from "@/api/gh";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { Avatar } from "./Avatar";
import { headerAges, stateBadge } from "./model";
import { PrMenu } from "./PrMenu";
import { toneBadge, toneText } from "./tones";

const stateIcon: Record<string, typeof GitPullRequest> = { Open: GitPullRequest, Draft: GitPullRequestDraft, Merged: GitMerge, Closed: GitPullRequestClosed };

function StatePill({ d }: { d: PullRequestDetailView }) {
  const b = stateBadge(d.pullRequest);
  const Icon = stateIcon[b.label] ?? GitPullRequest;
  return (
    <span className={cn("inline-flex h-6 shrink-0 items-center gap-1 rounded-full border px-2 text-label", toneBadge[b.tone])} data-testid="pr-state" data-state={b.label.toLowerCase()}>
      <Icon className="size-3" aria-hidden />
      {b.label}
    </span>
  );
}

/**
 * The surface's header. Row one: the state pill, the repository and number (tinted by
 * state), then Open on GitHub and the ⋯ menu. Then the title, the author with the ages,
 * and base ← head with the diffstat at the right.
 */
export function PrHeader({ d, prRef, panelKey, onAsk }: { d: PullRequestDetailView; prRef: PrRef; panelKey: string; onAsk: () => void }) {
  const pr = d.pullRequest;
  const now = useNow(30_000);
  const b = stateBadge(pr);
  const url = pr.url || `https://github.com/${prRef.slug}/pull/${String(prRef.number)}`;
  return (
    <header className="flex min-w-0 flex-col gap-1.5 border-b border-cf-divider px-4 pt-2 pb-3 @max-[340px]:px-3" data-testid="pr-header">
      <div className="flex min-w-0 items-center gap-2">
        <StatePill d={d} />
        <Tip label={`${prRef.slug}#${String(prRef.number)}`} whenTruncated>
          <span className="min-w-0 truncate text-caption" data-testid="pr-repo">
            {prRef.slug} <span className={cn("font-medium", toneText[b.tone])}>#{prRef.number}</span>
          </span>
        </Tip>
        <span className="ml-auto flex shrink-0 items-center gap-0.5" data-testid="pr-actions">
          <Tip label="Open on GitHub">
            <button
              type="button"
              aria-label="Open on GitHub"
              data-testid="pr-open-github"
              className="flex size-7 items-center justify-center rounded-md text-cf-text-muted outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
              onClick={() => void openUrl(url)}
            >
              <ExternalLink className="size-4" aria-hidden />
            </button>
          </Tip>
          <PrMenu prRef={prRef} detail={d} panelKey={panelKey} onAsk={onAsk} />
        </span>
      </div>
      <h2 className="min-w-0 text-heading break-words select-text" data-testid="pr-title">
        {pr.title || `#${String(prRef.number)}`}
      </h2>
      <div className="flex min-w-0 items-center gap-1.5 text-body-sm">
        <Avatar login={pr.author} size={18} />
        <span className="min-w-0 shrink-0 truncate font-medium" data-testid="pr-author">
          {pr.author || "ghost"}
        </span>
        <Tip label={headerAges(d, now)} whenTruncated>
          <span className="min-w-0 truncate text-cf-text-muted" data-testid="pr-ages">
            · {headerAges(d, now)}
          </span>
        </Tip>
      </div>
      <div className="flex min-w-0 items-center gap-3 text-caption">
        <Tip label={`${pr.headRef} into ${pr.baseRef}`} whenTruncated align="start">
          <span className="flex min-w-0 items-center gap-1.5 font-mono" data-testid="pr-branches">
            <span className="max-w-[40%] min-w-0 shrink-0 truncate">{pr.baseRef}</span>
            <ArrowLeft className="size-3 shrink-0" aria-hidden />
            <span className="min-w-0 truncate">{pr.headRef}</span>
          </span>
        </Tip>
        <span className="ml-auto flex shrink-0 items-center gap-1.5 whitespace-nowrap tabular-nums" data-testid="pr-diffstat">
          <FileDiff className="size-3.5" aria-hidden />
          {pr.changedFiles} {pr.changedFiles === 1 ? "file" : "files"}
          <span className={toneText.success}>+{pr.additions.toLocaleString()}</span>
          <span className={toneText.failure}>−{pr.deletions.toLocaleString()}</span>
        </span>
      </div>
    </header>
  );
}
