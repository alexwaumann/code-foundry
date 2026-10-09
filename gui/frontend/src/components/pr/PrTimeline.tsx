import { useMemo, type ReactNode } from "react";
import { GitMerge, GitPullRequest, GitPullRequestClosed } from "lucide-react";
import type { PullRequestDetailView } from "@/api/gh";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { usePrPanelStore } from "@/stores/prPanel";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { ago, reviewVerb, timeline, type TimelineEntry } from "./model";
import { toneText } from "./tones";

/** One timeline row: a 32px rail cell (icon or avatar, over the line) and the text. */
function Entry({ rail, children, kind, onOpen, title }: { rail: ReactNode; children: ReactNode; kind: TimelineEntry["kind"]; onOpen?: () => void; title?: string }) {
  const body = (
    <>
      <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-pane">{rail}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">{children}</div>
    </>
  );
  const cls = "flex w-full items-start gap-3 rounded-md px-1 py-2 text-left";
  return (
    <li data-testid="pr-timeline-entry" data-kind={kind}>
      {onOpen ? (
        <button type="button" className={cn(cls, "outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring")} title={title} onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </li>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">{children}</span>;
}

function Row({ e, slug, now }: { e: TimelineEntry; slug: string; now: number }) {
  switch (e.kind) {
    case "merged":
      return (
        <Entry kind="merged" rail={<GitMerge className={cn("size-4", toneText.merged)} aria-hidden />}>
          <span className="text-[13px] font-medium">
            {e.actor && <span className="mr-1.5">{e.actor}</span>}Pull request merged
          </span>
          <Meta>{ago(e.atMs, now)}</Meta>
        </Entry>
      );
    case "closed":
      return (
        <Entry kind="closed" rail={<GitPullRequestClosed className={cn("size-4", toneText.failure)} aria-hidden />}>
          <span className="text-[13px] font-medium">Pull request closed</span>
          <Meta>{ago(e.atMs, now)}</Meta>
        </Entry>
      );
    case "opened":
      return (
        <Entry kind="opened" rail={<GitPullRequest className="size-4 text-muted-foreground" aria-hidden />}>
          <span className="text-[13px] font-medium">
            {e.actor && <span className="mr-1.5">{e.actor}</span>}Pull request opened
          </span>
          <Meta>{ago(e.atMs, now)}</Meta>
        </Entry>
      );
    case "commit": {
      const c = e.commit;
      return (
        <Entry kind="commit" rail={<Avatar login={c.authorLogin || c.authorName} size={24} />} title={`${c.sha}\n${c.authorName || c.authorLogin}`} onOpen={() => void openUrl(`https://github.com/${slug}/commit/${c.sha}`)}>
          <span className="truncate text-[13px] font-medium">{c.headline}</span>
          <Meta>
            <span className="font-mono">{c.shortSha}</span>
            <span>{ago(e.atMs, now)}</span>
          </Meta>
        </Entry>
      );
    }
    case "comment":
    case "review": {
      const c = e.comment;
      const verdict = e.kind === "review" ? reviewVerb(c.reviewState) : "commented";
      const tone = c.reviewState === "approved" ? toneText.success : c.reviewState === "changes_requested" ? toneText.failure : "text-muted-foreground";
      return (
        <Entry kind={e.kind} rail={<Avatar login={c.author} src={c.authorAvatarUrl} size={24} />}>
          <span className="flex min-w-0 items-center gap-1.5 text-[13px]">
            <span className="truncate font-medium">{c.author || "ghost"}</span>
            <span className={cn("shrink-0", e.kind === "review" ? tone : "text-muted-foreground")}>{verdict}</span>
            <span className="shrink-0 text-xs text-muted-foreground">{ago(e.atMs, now)}</span>
          </span>
          {c.body && <Markdown className="line-clamp-4 text-muted-foreground">{c.body}</Markdown>}
        </Entry>
      );
    }
  }
}

/** Timeline: merged/closed, opened, commits, comments and reviews on a vertical line (T3 Code's). */
export function PrTimeline({ d, tabKey }: { d: PullRequestDetailView; tabKey: string }) {
  const order = usePrPanelStore((s) => s.byTab[tabKey]?.timelineOrder ?? "newest");
  const entries = useMemo(() => timeline(d, order), [d, order]);
  const now = useNow(30_000);
  const slug = d.pullRequest.repoSlug;
  return (
    <div className="px-4 py-3" data-testid="pr-timeline" data-order={order}>
      <ol className="relative">
        <span className="absolute top-4 bottom-4 left-[20px] w-px bg-foreground/20" aria-hidden />
        {entries.map((e) => (
          <Row key={e.key} e={e} slug={slug} now={now} />
        ))}
      </ol>
      {d.commitCount > d.commits.length && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="pr-truncated">
          Showing the last {d.commits.length} of {d.commitCount} commits.
        </p>
      )}
    </div>
  );
}
