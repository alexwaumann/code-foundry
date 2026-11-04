import { ArrowDownUp, ChevronDown, ChevronRight, ExternalLink, FileCode2 } from "lucide-react";
import { useMemo, type ReactNode } from "react";
import type { PullRequestCommentView, PullRequestDetailView, PullRequestLabelView, PullRequestReviewerView, ReviewThreadView } from "@/api/gh";
import { Tip } from "@/components/ui/tooltip";
import { useNow } from "@/lib/clock";
import { FOLD_PX, FoldToggle, useTallerThan } from "@/lib/fold";
import { cn } from "@/lib/utils";
import { openUrl } from "@/stores/gh";
import { sectionOpenByDefault, toggleOrder, toggleSection, usePrPanelStore, type PrSection } from "@/stores/prPanel";
import type { PrRef } from "@/surfaces/pullrequestTarget";
import { Avatar } from "./Avatar";
import { Markdown } from "./Markdown";
import { usePanelMarkdownExtras } from "./prLinks";
import { ago, commentCount, conversation, reviewerStatus, reviewVerb, threadLocation, type ConversationItem, type ReviewerStatus } from "./model";
import { ReviewerPicker } from "./ReviewerPicker";
import { toneText } from "./tones";
import { VirtualStack } from "./VirtualStack";

function useSectionOpen(tabKey: string, section: PrSection): boolean {
  return usePrPanelStore((s) => s.byTab[tabKey]?.open[section] ?? sectionOpenByDefault[section]);
}

/** A foldable section: "Title (n) ⌄" with optional controls on the right. */
function Section({ tabKey, section, title, count, extra, children, testId }: { tabKey: string; section: PrSection; title: string; count?: number; extra?: ReactNode; children: ReactNode; testId: string }) {
  const open = useSectionOpen(tabKey, section);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <section className="px-4 py-2 @max-[340px]:px-3" data-testid={testId} data-open={open}>
      <div className="flex h-7 items-center gap-2">
        <button
          type="button"
          aria-expanded={open}
          className="-ml-1 flex items-center gap-1 rounded-sm px-1 text-label text-cf-text-muted outline-none hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
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

/** The ring round a reviewer's avatar: approved, changes requested, or still pending. */
const reviewerRing: Partial<Record<ReviewerStatus, string>> = {
  approved: "ring-cf-success",
  changes_requested: "ring-cf-error",
  requested: "ring-cf-warning",
};

/** A reviewer's avatar, ringed by outcome; the tooltip names them and their review (hidden: only the face shows). */
function Reviewer({ r }: { r: PullRequestReviewerView }) {
  const { status, label } = reviewerStatus(r);
  // A re-requested reviewer is pending again, whatever they said before.
  const ring = r.requested ? reviewerRing.requested : reviewerRing[status];
  return (
    <Tip label={[r.login, r.isBot ? "bot" : "", label].filter(Boolean).join(" · ")}>
      <span
        className={cn("inline-flex rounded-full ring-[1.5px] ring-offset-1 ring-offset-cf-surface", ring ?? "ring-transparent", r.stale && "opacity-70")}
        data-testid="pr-reviewer"
        data-login={r.login}
        data-status={status}
        data-stale={r.stale}
        aria-label={[r.login, label].filter(Boolean).join(": ")}
        role="img"
      >
        <Avatar login={r.login} src={r.avatarUrl} size={20} />
      </span>
    </Tip>
  );
}

/** "Reviewers  [faces] +": the label beside the values. */
function Field({ label, children, testId }: { label: string; children: ReactNode; testId: string }) {
  return (
    <div className="flex min-h-7 min-w-0 items-start gap-3" data-testid={testId}>
      <span className="flex h-7 w-16 shrink-0 items-center text-caption text-cf-text-muted">{label}</span>
      <div className="flex min-h-7 min-w-0 flex-1 flex-wrap items-center gap-1.5">{children}</div>
    </div>
  );
}

/** A label chip in the label's own colour (GitHub's hex). */
function Label({ l }: { l: PullRequestLabelView }) {
  const color = /^[0-9a-f]{6}$/i.test(l.color) ? `#${l.color}` : undefined;
  return (
    <span
      className="inline-flex h-5 max-w-full min-w-0 items-center rounded-full border border-cf-border px-2 text-caption"
      style={color ? { borderColor: `color-mix(in srgb, ${color} 55%, transparent)`, color: `color-mix(in srgb, ${color} 70%, var(--cf-text))` } : undefined}
      data-testid="pr-label"
    >
      <span className="truncate">{l.name}</span>
    </span>
  );
}

/**
 * The description: shown whole when short; otherwise cut at FOLD_PX with a
 * fade and a centred Show all, which shows it whole in place (Show less folds it again).
 * Kept per panel tab.
 */
function Description({ d, tabKey }: { d: PullRequestDetailView; tabKey: string }) {
  const extras = usePanelMarkdownExtras();
  const full = useSectionOpen(tabKey, "fullDescription");
  const [ref, taller] = useTallerThan(FOLD_PX);
  const folded = taller && !full;
  if (!d.body.trim()) return <p className="text-caption italic">No description provided.</p>;
  return (
    <div className="flex flex-col">
      <div className={cn("relative", folded && "overflow-hidden")} style={folded ? { maxHeight: FOLD_PX } : undefined} data-testid="pr-description-body" data-folded={folded}>
        <div ref={ref} data-testid="pr-description-content">
          <Markdown extras={extras}>{d.body}</Markdown>
        </div>
        {folded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-linear-to-b from-transparent to-cf-surface" aria-hidden />}
      </div>
      {taller && (
        <div className={cn("relative flex justify-center", folded ? "-mt-3" : "mt-1.5")}>
          <FoldToggle
            folded={folded}
            label="Show all"
            testId="pr-description-toggle"
            onClick={() => {
              toggleSection(tabKey, "fullDescription");
            }}
          />
        </div>
      )}
    </div>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return (
    <p className="mt-1.5 text-caption" data-testid="pr-truncated">
      {children}
    </p>
  );
}

function CommentHeader({ c, now, verb }: { c: PullRequestCommentView; now: number; verb?: ReactNode }) {
  return (
    <div className="flex min-w-0 items-start gap-1.5 text-body-sm">
      <Avatar login={c.author} src={c.authorAvatarUrl} size={20} />
      {/* The verb and age wrap under a long login instead of cutting it short. */}
      <span className="flex min-h-5 min-w-0 flex-1 flex-wrap items-center gap-x-1.5">
        <span className="max-w-full min-w-0 truncate font-medium text-cf-text" data-testid="pr-comment-author">
          {c.author || "ghost"}
        </span>
        {c.authorIsBot && <span className="rounded-sm border px-1 text-caption-sm">bot</span>}
        {verb}
        <Tip label={c.createdAtMs === null ? null : new Date(c.createdAtMs).toLocaleString()}>
          <span className="whitespace-nowrap text-cf-text-muted">{ago(c.createdAtMs, now)}</span>
        </Tip>
      </span>
      {c.url && (
        <Tip label="Open on GitHub">
          <button
            type="button"
            className="ml-auto flex size-5 shrink-0 items-center justify-center rounded-sm text-cf-text-muted opacity-0 outline-none group-hover:opacity-100 hover:bg-cf-control-hover hover:text-cf-text focus-visible:opacity-100 focus-visible:ring-1 focus-visible:ring-cf-focus"
            aria-label="Open on GitHub"
            onClick={() => void openUrl(c.url)}
          >
            <ExternalLink className="size-3" aria-hidden />
          </button>
        </Tip>
      )}
    </div>
  );
}

const verdictTone = { approved: toneText.success, changes_requested: toneText.failure } as Partial<Record<string, string>>;

function Comment({ c, now }: { c: PullRequestCommentView; now: number }) {
  const extras = usePanelMarkdownExtras();
  const verb =
    c.kind === "review" ? (
      <span className={cn("whitespace-nowrap", verdictTone[c.reviewState] ?? "text-cf-text-muted")} data-testid="pr-review-verdict">
        {reviewVerb(c.reviewState)}
      </span>
    ) : null;
  return (
    <article className="group flex flex-col gap-1.5 py-2" data-testid="pr-comment" data-kind={c.kind}>
      <CommentHeader c={c} now={now} verb={verb} />
      {c.path && <span className="pl-[26px] text-caption font-mono">{c.path}</span>}
      {c.body ? <Markdown className="pl-[26px]" extras={extras}>{c.body}</Markdown> : <p className="pl-[26px] text-caption italic">No comment.</p>}
    </article>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone: "success" | "pending" | "neutral" }) {
  return (
    <span
      className={cn(
        "rounded-full border px-1.5 text-caption-sm",
        tone === "success" && "border-cf-success/30 text-cf-success-text",
        tone === "pending" && "border-cf-warning/30 text-cf-warning-text",
        tone === "neutral" && "border-cf-border text-cf-text-muted",
      )}
    >
      {children}
    </span>
  );
}

const dirOf = (path: string): string => path.slice(0, path.lastIndexOf("/") + 1);
const baseOf = (path: string): string => path.slice(path.lastIndexOf("/") + 1);

function Thread({ t, now }: { t: ReviewThreadView; now: number }) {
  const extras = usePanelMarkdownExtras();
  return (
    <article className={cn("my-1.5 rounded-lg border border-cf-border", t.isResolved && "opacity-75")} data-testid="pr-thread" data-resolved={t.isResolved} data-outdated={t.isOutdated}>
      <header className="flex items-center gap-2 border-b border-cf-border px-2.5 py-1.5 text-body-sm">
        <FileCode2 className="size-3.5 shrink-0 text-cf-text-muted" aria-hidden />
        {/* The directory gives way first, so the file and line stay readable. */}
        <Tip label={threadLocation(t)} whenTruncated align="start">
          <span className="flex min-w-0 font-mono" data-testid="pr-thread-location">
            <span className="min-w-0 truncate text-cf-text-muted">{dirOf(t.path)}</span>
            <span className="shrink-0">{threadLocation({ path: baseOf(t.path), line: t.line })}</span>
          </span>
        </Tip>
        <span className="ml-auto flex shrink-0 gap-1">
          {t.isOutdated && <Badge tone="pending">Outdated</Badge>}
          {t.isResolved ? <Badge tone="success">Resolved</Badge> : <Badge tone="neutral">Unresolved</Badge>}
        </span>
      </header>
      <div className="flex flex-col divide-y divide-cf-border px-2.5">
        {t.comments.map((c) => (
          <div key={c.id} className="group flex flex-col gap-1.5 py-2" data-testid="pr-thread-comment">
            <CommentHeader c={c} now={now} />
            {c.body && <Markdown className="pl-[26px]" extras={extras}>{c.body}</Markdown>}
          </div>
        ))}
        {t.commentsTruncated && <p className="py-1.5 text-caption">More replies on GitHub.</p>}
      </div>
    </article>
  );
}

function Conversation({ items }: { items: ConversationItem[] }) {
  const now = useNow(30_000);
  if (items.length === 0) return <p className="text-caption">No comments yet.</p>;
  return (
    <VirtualStack
      items={items}
      itemKey={(it) => it.key}
      estimate={96}
      className="flex flex-col"
      testId="pr-comments-list"
      render={(it) => (it.kind === "thread" ? <Thread t={it.thread} now={now} /> : <Comment c={it.comment} now={now} />)}
    />
  );
}

/** "Newest first" / "Oldest first". `compact` keeps only the icon below 480px, and the label moves to a tooltip. */
function OrderToggle({ tabKey, which, compact = false }: { tabKey: string; which: "commentOrder" | "timelineOrder"; compact?: boolean }) {
  const order = usePrPanelStore((s) => s.byTab[tabKey]?.[which] ?? "newest");
  const label = order === "newest" ? "Newest first" : "Oldest first";
  return (
    <Tip label={label} whenTruncated>
      <button
        type="button"
        className="flex h-6 shrink-0 items-center gap-1 rounded-sm px-1.5 text-caption whitespace-nowrap outline-none hover:bg-cf-control-hover hover:text-cf-text focus-visible:ring-1 focus-visible:ring-cf-focus"
        data-testid={which === "commentOrder" ? "pr-comment-order" : "pr-timeline-order"}
        data-order={order}
        onClick={() => {
          toggleOrder(tabKey, which);
        }}
      >
        <ArrowDownUp className="size-3" aria-hidden />
        <span className={compact ? "@max-[480px]:sr-only" : undefined}>{label}</span>
      </button>
    </Tip>
  );
}

export { OrderToggle };

/**
 * Overview: reviewers (open pull requests: faces ringed by outcome, and the picker),
 * labels, the description (faded out when long), and the conversation. The checks live
 * in the readiness box above the tabs.
 */
export function PrOverview({ d, prRef, tabKey }: { d: PullRequestDetailView; prRef: PrRef; tabKey: string }) {
  const order = usePrPanelStore((s) => s.byTab[tabKey]?.commentOrder ?? "newest");
  const items = useMemo(() => conversation(d, order), [d, order]);
  const open = d.pullRequest.state === "open";
  return (
    <div className="flex flex-col pb-6" data-testid="pr-overview">
      {(open || d.labels.length > 0) && (
        <div className="flex flex-col gap-0.5 px-4 pt-3 pb-1 @max-[340px]:px-3">
          {open && (
            <Field label="Reviewers" testId="pr-reviewers">
              {d.reviewers.length === 0 && <span className="text-caption">None</span>}
              {d.reviewers.map((r) => (
                <Reviewer key={r.login} r={r} />
              ))}
              {d.reviewersTruncated && (
                <span className="text-caption" data-testid="pr-truncated">
                  and more on GitHub
                </span>
              )}
              <ReviewerPicker prRef={prRef} canUpdate={d.viewerCanUpdate} />
            </Field>
          )}
          {d.labels.length > 0 && (
            <Field label="Labels" testId="pr-labels">
              {d.labels.map((l) => (
                <Label key={l.name} l={l} />
              ))}
              {d.labelsTruncated && <span className="text-caption">and more on GitHub</span>}
            </Field>
          )}
        </div>
      )}
      <Section tabKey={tabKey} section="description" title="Description" testId="pr-description">
        <Description d={d} tabKey={tabKey} />
      </Section>
      <Section tabKey={tabKey} section="comments" title="Comments" count={commentCount(d)} extra={<OrderToggle tabKey={tabKey} which="commentOrder" />} testId="pr-comments">
        <Conversation items={items} />
        {(d.commentsTruncated || d.reviewThreadsTruncated) && (
          <Notice>
            Older {d.commentsTruncated && d.reviewThreadsTruncated ? "comments and threads" : d.commentsTruncated ? "comments" : "threads"} are only on{" "}
            <button type="button" className="underline underline-offset-2 hover:text-cf-text" onClick={() => void openUrl(d.pullRequest.url)}>
              GitHub
            </button>
            .
          </Notice>
        )}
      </Section>
    </div>
  );
}
