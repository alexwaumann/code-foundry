import { ArrowDownUp, Bot, Check, ChevronDown, ChevronRight, CircleCheck, CircleDashed, CircleDot, CircleMinus, CircleX, Clock, ExternalLink, FileCode2, FileDiff, MessageSquare, Tag, Users } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { CheckView, PullRequestCommentView, PullRequestDetailView, PullRequestLabelView, PullRequestReviewerView, ReviewThreadView } from "@/api/gh";
import { useNow } from "@/lib/clock";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { sectionOpenByDefault, toggleOrder, toggleSection, usePrPanelStore, type PrSection } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { ago, checkDuration, checkTone, commentCount, conversation, reviewerStatus, reviewVerb, threadLocation, type ConversationItem, type ReviewerStatus } from "./model";
import { ReviewerPicker } from "./ReviewerPicker";
import { toneText } from "./tones";

function useSectionOpen(tabKey: string, section: PrSection): boolean {
  return usePrPanelStore((s) => s.byTab[tabKey]?.open[section] ?? sectionOpenByDefault[section]);
}

/** A foldable section: "Title (n) ⌄" with optional controls on the right. */
function Section({ tabKey, section, title, count, extra, children, testId }: { tabKey: string; section: PrSection; title: string; count?: number; extra?: ReactNode; children: ReactNode; testId: string }) {
  const open = useSectionOpen(tabKey, section);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="px-4 py-2" data-testid={testId} data-open={open}>
      <div className="flex h-7 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="-ml-1 flex items-center gap-1 rounded px-1 text-[13px] font-medium text-muted-foreground outline-none hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
          onClick={() => {
            toggleSection(tabKey, section);
          }}
        >
          {title}
          {count !== undefined && <span className="tabular-nums">({count})</span>}
          <Chevron className="size-3.5" aria-hidden />
        </button>
        {extra && <div className="ml-auto flex items-center">{extra}</div>}
      </div>
      {open && <div className="pt-1.5">{children}</div>}
    </section>
  );
}

const reviewerIcon: Record<ReviewerStatus, { icon: typeof Check; cls: string } | null> = {
  approved: { icon: Check, cls: toneText.success },
  changes_requested: { icon: FileDiff, cls: toneText.failure },
  commented: { icon: MessageSquare, cls: "text-muted-foreground" },
  dismissed: { icon: CircleMinus, cls: "text-muted-foreground" },
  requested: { icon: Clock, cls: toneText.pending },
  none: null,
};

function Reviewer({ r }: { r: PullRequestReviewerView }) {
  const { status, label } = reviewerStatus(r);
  const icon = reviewerIcon[status];
  return (
    <span
      className={cn("inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-muted/40 pr-2 pl-0.5 text-xs", r.stale && "opacity-55")}
      title={label ? `${r.login}: ${label}` : r.login}
      data-testid="pr-reviewer"
      data-login={r.login}
      data-status={status}
      data-stale={r.stale}
    >
      <Avatar login={r.login} src={r.avatarUrl} size={18} />
      <span className="max-w-36 truncate">{r.login}</span>
      {r.isBot && <Bot className="size-3 text-muted-foreground" aria-label="bot" />}
      {icon && <icon.icon className={cn("size-3.5", icon.cls)} aria-label={label} />}
      {r.requested && r.state !== "" && <Clock className={cn("size-3", toneText.pending)} aria-hidden />}
    </span>
  );
}

function LabelChip({ l }: { l: PullRequestLabelView }) {
  const hex = /^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : "#888888";
  return (
    <span
      className="inline-flex h-6 items-center gap-1.5 rounded-full border px-2 text-xs"
      style={{ backgroundColor: `${hex}22`, borderColor: `${hex}66` }}
      data-testid="pr-label"
    >
      <span className="size-2 rounded-full" style={{ backgroundColor: hex }} aria-hidden />
      {l.name}
    </span>
  );
}

function Row({ icon: Icon, label, children, testId }: { icon: typeof Users; label: string; children: ReactNode; testId: string }) {
  return (
    <div className="flex min-h-7 items-start gap-3" data-testid={testId}>
      <span className="flex h-7 w-24 shrink-0 items-center gap-2 text-[13px] text-muted-foreground">
        <Icon className="size-4" aria-hidden />
        {label}
      </span>
      <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

const checkIcon = { success: CircleCheck, failure: CircleX, pending: CircleDot, skipped: CircleDashed } as const;

function CheckRow({ c, now }: { c: CheckView; now: number }) {
  const tone = checkTone(c);
  const Icon = checkIcon[tone];
  const duration = checkDuration(c, now);
  return (
    <li>
      <button
        type="button"
        disabled={!c.url}
        className="group flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-left text-[13px] outline-none enabled:hover:bg-accent/60 focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-default"
        title={[c.name, c.description, c.url].filter(Boolean).join("\n")}
        data-testid="pr-check"
        data-tone={tone}
        onClick={() => void openUrl(c.url)}
      >
        <Icon className={cn("size-3.5 shrink-0", toneText[tone], tone === "pending" && c.status === "in_progress" && "animate-pulse")} aria-label={tone} />
        <span className="min-w-0 truncate">{c.name}</span>
        {c.workflow && <span className="min-w-0 shrink truncate text-xs text-muted-foreground">{c.workflow}</span>}
        <span className="ml-auto shrink-0 text-xs text-muted-foreground tabular-nums">{duration || (tone === "pending" ? c.status.replace("_", " ") : "")}</span>
        <ExternalLink className={cn("size-3 shrink-0 text-muted-foreground opacity-0", c.url && "group-hover:opacity-100")} aria-hidden />
      </button>
    </li>
  );
}

function Checks({ d }: { d: PullRequestDetailView }) {
  const now = useNow(1000);
  if (d.checks.length === 0) return <p className="text-[13px] text-muted-foreground">No checks on the head commit.</p>;
  return (
    <>
      <ul className="-mx-1.5 flex flex-col" data-testid="pr-checks-list">
        {d.checks.map((c, i) => (
          <CheckRow key={`${c.workflow}/${c.name}/${String(i)}`} c={c} now={now} />
        ))}
      </ul>
      {d.checksTruncated && <Notice>Not every check could be listed{d.lastError ? `: ${d.lastError}` : "."} The rest are on GitHub.</Notice>}
    </>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 text-xs text-muted-foreground" data-testid="pr-truncated">
      {children}
    </p>
  );
}

function CommentHeader({ c, now, verb }: { c: PullRequestCommentView; now: number; verb?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5 text-xs">
      <Avatar login={c.author} src={c.authorAvatarUrl} size={20} />
      <span className="truncate font-medium text-foreground">{c.author || "ghost"}</span>
      {c.authorIsBot && <span className="rounded border px-1 text-[10px] text-muted-foreground">bot</span>}
      {verb}
      <span className="shrink-0 text-muted-foreground" title={c.createdAtMs === null ? undefined : new Date(c.createdAtMs).toLocaleString()}>
        {ago(c.createdAtMs, now)}
      </span>
      {c.url && (
        <button
          type="button"
          className="ml-auto flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0 outline-none group-hover:opacity-100 hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-ring"
          aria-label="Open on GitHub"
          title="Open on GitHub"
          onClick={() => void openUrl(c.url)}
        >
          <ExternalLink className="size-3" aria-hidden />
        </button>
      )}
    </div>
  );
}

const verdictTone = { approved: toneText.success, changes_requested: toneText.failure } as Partial<Record<string, string>>;

function Comment({ c, now }: { c: PullRequestCommentView; now: number }) {
  const verb =
    c.kind === "review" ? (
      <span className={cn("shrink-0", verdictTone[c.reviewState] ?? "text-muted-foreground")} data-testid="pr-review-verdict">
        {reviewVerb(c.reviewState)}
      </span>
    ) : null;
  return (
    <article className="group flex flex-col gap-1.5 py-2" data-testid="pr-comment" data-kind={c.kind}>
      <CommentHeader c={c} now={now} verb={verb} />
      {c.path && <span className="pl-[26px] font-mono text-xs text-muted-foreground">{c.path}</span>}
      {c.body ? <Markdown className="pl-[26px]">{c.body}</Markdown> : <p className="pl-[26px] text-xs text-muted-foreground italic">No comment.</p>}
    </article>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone: "success" | "pending" | "neutral" }) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 text-[10px] leading-4",
        tone === "success" && "border-emerald-600/30 text-emerald-700 dark:border-emerald-400/30 dark:text-emerald-400",
        tone === "pending" && "border-amber-600/30 text-amber-700 dark:border-amber-300/30 dark:text-amber-300",
        tone === "neutral" && "border-border text-muted-foreground",
      )}
    >
      {children}
    </span>
  );
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function Thread({ t, now }: { t: ReviewThreadView; now: number }) {
  return (
    <article className={cn("my-1.5 rounded-lg border border-border", t.isResolved && "opacity-75")} data-testid="pr-thread" data-resolved={t.isResolved} data-outdated={t.isOutdated}>
      <header className="flex items-center gap-2 border-b border-border px-2.5 py-1.5 text-xs">
        <FileCode2 className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
        {/* The directory gives way first, so the file and line stay readable. */}
        <span className="flex min-w-0 font-mono" title={threadLocation(t)} data-testid="pr-thread-location">
          <span className="min-w-0 truncate text-muted-foreground">{dirOf(t.path)}</span>
          <span className="shrink-0">{threadLocation({ path: baseOf(t.path), line: t.line })}</span>
        </span>
        <span className="ml-auto flex shrink-0 gap-1">
          {t.isOutdated && <Badge tone="pending">Outdated</Badge>}
          {t.isResolved ? <Badge tone="success">Resolved</Badge> : <Badge tone="neutral">Unresolved</Badge>}
        </span>
      </header>
      <div className="flex flex-col divide-y divide-border px-2.5">
        {t.comments.map((c) => (
          <div key={c.id} className="group flex flex-col gap-1.5 py-2" data-testid="pr-thread-comment">
            <CommentHeader c={c} now={now} />
            {c.body && <Markdown className="pl-[26px]">{c.body}</Markdown>}
          </div>
        ))}
        {t.commentsTruncated && <p className="py-1.5 text-xs text-muted-foreground">More replies on GitHub.</p>}
      </div>
    </article>
  );
}

function Conversation({ items }: { items: ConversationItem[] }) {
  const now = useNow(30_000);
  if (items.length === 0) return <p className="text-[13px] text-muted-foreground">No comments yet.</p>;
  return (
    <div className="flex flex-col" data-testid="pr-comments-list">
      {items.map((it) => (it.kind === "thread" ? <Thread key={it.key} t={it.thread} now={now} /> : <Comment key={it.key} c={it.comment} now={now} />))}
    </div>
  );
}

function OrderToggle({ tabKey, which }: { tabKey: string; which: "commentOrder" | "timelineOrder" }) {
  const order = usePrPanelStore((s) => s.byTab[tabKey]?.[which] ?? "newest");
  return (
    <button
      type="button"
      className="flex h-6 shrink-0 items-center gap-1 rounded px-1.5 text-xs whitespace-nowrap text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-1 focus-visible:ring-ring"
      data-testid={which === "commentOrder" ? "pr-comment-order" : "pr-timeline-order"}
      data-order={order}
      onClick={() => {
        toggleOrder(tabKey, which);
      }}
    >
      <ArrowDownUp className="size-3" aria-hidden />
      {order === "newest" ? "Newest first" : "Oldest first"}
    </button>
  );
}

export { OrderToggle };

/** Summary: reviewers, labels, description, checks, and the conversation. */
export function PrSummary({ d, prRef, tabKey }: { d: PullRequestDetailView; prRef: PrRef; tabKey: string }) {
  const order = usePrPanelStore((s) => s.byTab[tabKey]?.commentOrder ?? "newest");
  const items = useMemo(() => conversation(d, order), [d, order]);
  return (
    <div className="flex flex-col pb-6" data-testid="pr-summary">
      <div className="flex flex-col gap-1 px-4 pt-3 pb-2">
        <Row icon={Users} label="Reviewers" testId="pr-reviewers">
          {d.reviewers.length === 0 && <span className="text-[13px] text-muted-foreground">None</span>}
          {d.reviewers.map((r) => (
            <Reviewer key={r.login} r={r} />
          ))}
          {d.reviewersTruncated && <span className="text-xs text-muted-foreground" data-testid="pr-truncated">and more on GitHub</span>}
          <ReviewerPicker prRef={prRef} canUpdate={d.viewerCanUpdate} />
        </Row>
        <Row icon={Tag} label="Labels" testId="pr-labels">
          {d.labels.length === 0 ? (
            <span className="text-[13px] text-muted-foreground">None</span>
          ) : (
            d.labels.map((l) => <LabelChip key={l.name} l={l} />)
          )}
          {d.labelsTruncated && <span className="text-xs text-muted-foreground" data-testid="pr-truncated">and more on GitHub</span>}
        </Row>
      </div>
      <Section tabKey={tabKey} section="description" title="Description" testId="pr-description">
        {d.body.trim() ? <Markdown>{d.body}</Markdown> : <p className="text-[13px] text-muted-foreground italic">No description provided.</p>}
      </Section>
      <Section tabKey={tabKey} section="checks" title="Checks" count={d.checks.length} testId="pr-checks">
        <Checks d={d} />
      </Section>
      <Section tabKey={tabKey} section="comments" title="Comments" count={commentCount(d)} extra={<OrderToggle tabKey={tabKey} which="commentOrder" />} testId="pr-comments">
        <Conversation items={items} />
        {(d.commentsTruncated || d.reviewThreadsTruncated) && (
          <Notice>
            Older {d.commentsTruncated && d.reviewThreadsTruncated ? "comments and threads" : d.commentsTruncated ? "comments" : "threads"} are only on{" "}
            <button type="button" className="underline underline-offset-2 hover:text-foreground" onClick={() => void openUrl(d.pullRequest.url)}>
              GitHub
            </button>
            .
          </Notice>
        )}
      </Section>
    </div>
  );
}
