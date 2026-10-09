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
import { VirtualStack } from "./VirtualStack";

/** Where an entry sits on the rail: the line runs from the first entry's icon to the last's. */
interface RailPos {
  first: boolean;
  last: boolean;
}

/**
 * One timeline row: a 32px rail cell (icon or avatar) and the text. Each row draws its
 * own piece of the vertical line, so the line starts at the first icon, stops at the last
 * one, and works when rows are virtualized.
 */
function Entry({ rail, children, kind, pos, onOpen, title }: { rail: ReactNode; children: ReactNode; kind: TimelineEntry["kind"]; pos: RailPos; onOpen?: () => void; title?: string }) {
  const body = (
    <>
      <span className="relative z-10 flex size-8 shrink-0 items-center justify-center rounded-full bg-pane">{rail}</span>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 pt-1">{children}</div>
    </>
  );
  const cls = "flex w-full items-start gap-3 rounded-md px-1 py-2 text-left";
  return (
    <div role="listitem" className="relative" data-testid="pr-timeline-entry" data-kind={kind}>
      {!(pos.first && pos.last) && (
        // 24px is the icon's centre (py-2 + half of size-8).
        <span className={cn("absolute left-[20px] w-px bg-foreground/20", pos.first ? "top-6" : "top-0", pos.last ? "h-6" : "bottom-0")} aria-hidden data-testid="pr-timeline-rail" />
      )}
      {onOpen ? (
        <button type="button" className={cn(cls, "outline-none hover:bg-accent/40 focus-visible:ring-1 focus-visible:ring-ring")} title={title} onClick={onOpen}>
          {body}
        </button>
      ) : (
        <div className={cls}>{body}</div>
      )}
    </div>
  );
}

function Meta({ children }: { children: ReactNode }) {
  return <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-xs text-muted-foreground">{children}</span>;
}

function Row({ e, slug, now, pos }: { e: TimelineEntry; slug: string; now: number; pos: RailPos }) {
  switch (e.kind) {
    case "merged":
      return (
        <Entry kind="merged" pos={pos} rail={<GitMerge className={cn("size-4", toneText.merged)} aria-hidden />}>
          <span className="text-[13px] font-medium">
            {e.actor && <span className="mr-1.5">{e.actor}</span>}Pull request merged
          </span>
          <Meta>{ago(e.atMs, now)}</Meta>
        </Entry>
      );
    case "closed":
      return (
        <Entry kind="closed" pos={pos} rail={<GitPullRequestClosed className={cn("size-4", toneText.failure)} aria-hidden />}>
          <span className="text-[13px] font-medium">Pull request closed</span>
          <Meta>{ago(e.atMs, now)}</Meta>
        </Entry>
      );
    case "opened":
      return (
        <Entry kind="opened" pos={pos} rail={<GitPullRequest className="size-4 text-muted-foreground" aria-hidden />}>
          <span className="text-[13px] font-medium">
            {e.actor && <span className="mr-1.5">{e.actor}</span>}Pull request opened
          </span>
          <Meta>{ago(e.atMs, now)}</Meta>
        </Entry>
      );
    case "commit": {
      const c = e.commit;
      return (
        <Entry
          kind="commit"
          pos={pos}
          // Only a GitHub login has an avatar; a bare git author name gets its initial.
          rail={<Avatar login={c.authorLogin} name={c.authorName} size={24} />}
          title={`${c.sha}\n${c.authorName || c.authorLogin}`}
          onOpen={() => void openUrl(`https://github.com/${slug}/commit/${c.sha}`)}
        >
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
        <Entry kind={e.kind} pos={pos} rail={<Avatar login={c.author} src={c.authorAvatarUrl} size={24} />}>
          {/* The verdict and age wrap under a long login instead of cutting it short. */}
          <span className="flex min-w-0 flex-wrap items-center gap-x-1.5 text-[13px]">
            <span className="max-w-full min-w-0 truncate font-medium" data-testid="pr-timeline-author">
              {c.author || "ghost"}
            </span>
            <span className={cn("whitespace-nowrap", e.kind === "review" ? tone : "text-muted-foreground")}>{verdict}</span>
            <span className="text-xs whitespace-nowrap text-muted-foreground">{ago(e.atMs, now)}</span>
          </span>
          {c.body && <Markdown className="line-clamp-4">{c.body}</Markdown>}
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
      <div role="list">
        <VirtualStack
          items={entries}
          itemKey={(e) => e.key}
          estimate={72}
          testId="pr-timeline-list"
          render={(e, i, n) => <Row e={e} slug={slug} now={now} pos={{ first: i === 0, last: i === n - 1 }} />}
        />
      </div>
      {d.commitCount > d.commits.length && (
        <p className="mt-2 text-xs text-muted-foreground" data-testid="pr-truncated">
          Showing the last {d.commits.length} of {d.commitCount} commits.
        </p>
      )}
    </div>
  );
}
