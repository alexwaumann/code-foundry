import type { Tone } from "@/components/pr/model";
import { toneText } from "@/components/pr/tones";
import { prStateLook } from "@/components/prs/prState";
import { Tip } from "@/components/ui/tooltip";
import { threadKey } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { pullRequestKey } from "@/stores/gh";
import { showThreadInfo } from "@/stores/threadInfoOverlay";
import { showThreadView } from "@/stores/threadPanelIntent";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { linkedPrTag, linkedPrTagText, linkedPrTip } from "./linkedPrTag";
import { useLinkedPrFacts, useLinkKeys } from "./useLinkedPrs";

/** The chip's tint per tone; the text colour is the PR surfaces' (pr/tones `toneText`). */
const toneTint: Readonly<Record<Tone, string>> = {
  success: "bg-cf-success-surface hover:bg-cf-success/30",
  merged: "bg-cf-highlight-surface hover:bg-cf-highlight/30",
  draft: "bg-cf-text-muted/15 hover:bg-cf-text-muted/25",
  neutral: "bg-cf-text-muted/15 hover:bg-cf-text-muted/25",
  failure: "bg-cf-error-surface hover:bg-cf-error/30",
  pending: "bg-cf-warning-surface hover:bg-cf-warning/30",
};

/** Selects thread `id` (and puts the list's cursor on it) unless it is selected already, so its panel and card show. */
function selectThread(id: string): void {
  const ui = useUiStore.getState();
  if (ui.selection.kind === "thread" && ui.selection.id === id) return;
  ui.setCursor(threadKey(id));
  ui.select({ kind: "thread", id });
}

/**
 * Where a click on the tag goes: one pull request opens in the thread's PR panel tab
 * (view.panel.pr's ShowView, scoped to the thread: its repo slug comes from the thread's
 * link, `key` being its pullRequestKey); several show the thread info card, whose pull
 * request rows list them. Either way the thread is selected first, so what opened shows.
 */
function openLinked(id: string, key: string | null): void {
  selectThread(id);
  const link = key === null ? undefined : useThreadsStore.getState().byId[id]?.linkedPullRequests.find((l) => pullRequestKey(l.slug, l.number) === key);
  if (link) showThreadView("panel.pr", id, { slug: link.slug, number: String(link.number) });
  else showThreadInfo(id);
}

/**
 * The thread's linked pull requests, closed ones left out (linkedPrTag): one shows its
 * state icon and bare number in the state's colour, several "N PRs" in the worst state's;
 * nothing when none is left. The tooltip says what the tag hides (states, the one's title).
 */
export function LinkedPrsBadge({ id }: { id: string }) {
  const keys = useLinkKeys(id);
  const facts = useLinkedPrFacts(keys);
  const tag = linkedPrTag(facts);
  if (tag === null) return null;
  const look = tag.kind === "one" ? prStateLook(tag.state === "draft" ? "open" : tag.state, tag.state === "draft") : null;
  return (
    <Tip label={linkedPrTip(facts)} side="right" data-testid="row-linked-prs-tip">
      {/* The click stops here: the row's own click would also focus the prompt and open a flag's surface. */}
      <span
        className={cn("flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-caption-sm font-medium tabular-nums", toneText[tag.tone], toneTint[tag.tone])}
        data-testid="row-linked-prs"
        data-kind={tag.kind}
        data-state={tag.kind === "one" ? tag.state : undefined}
        data-tone={tag.tone}
        onClick={(e) => {
          e.stopPropagation();
          // The one counted pull request's key: facts and keys share their order.
          const one = tag.kind === "one" ? (keys[facts.findIndex((f) => f.state !== "closed")] ?? null) : null;
          openLinked(id, one);
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
        }}
      >
        {look && <look.icon className="size-3 shrink-0" aria-label={look.label} />}
        {linkedPrTagText(tag)}
      </span>
    </Tip>
  );
}
