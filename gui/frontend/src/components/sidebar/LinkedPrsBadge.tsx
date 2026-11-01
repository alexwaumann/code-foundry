import type { Tone } from "@/components/pr/model";
import { toneText } from "@/components/pr/tones";
import { prStateLook } from "@/components/prs/prState";
import { threadKey } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { showThreadView } from "@/stores/threadPanelIntent";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { linkedPrTag, linkedPrTagText } from "./linkedPrTag";
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
 * Where a click on the tag goes: every counted pull request opens in the thread's PR panel
 * tab (view.panel.pr's ShowView, scoped to the thread: the repo slug comes from the
 * thread's own link, `keys` being their pullRequestKeys), the shown one last so its tab is
 * the active one. The thread is selected first, so what opened shows. Each one's detail is
 * read once as well (a watch released at once; the entry stays): only the active tab reads
 * its own, and a closed one must leave the tag, as it did when the card read them all.
 */
function openLinked(id: string, keys: readonly string[]): void {
  selectThread(id);
  const links = useThreadsStore.getState().byId[id]?.linkedPullRequests ?? [];
  for (const key of keys) {
    const link = links.find((l) => pullRequestKey(l.slug, l.number) === key);
    if (!link) continue;
    pullRequestDetailResource.watch(key)();
    showThreadView("panel.pr", id, { slug: link.slug, number: String(link.number) });
  }
}

/**
 * The thread's linked pull requests, closed ones left out (linkedPrTag): one shows its
 * state icon and bare number in the state's colour; several show the worst state's icon and
 * colour and "+N", N all of them. No tooltip of its own, and the row's hover card stays shut
 * over it (data-quiet): a click is what it is for.
 */
export function LinkedPrsBadge({ id }: { id: string }) {
  const keys = useLinkKeys(id);
  const facts = useLinkedPrFacts(keys);
  const tag = linkedPrTag(facts);
  if (tag === null) return null;
  const look = prStateLook(tag.state === "draft" ? "open" : tag.state === "unknown" ? null : tag.state, tag.state === "draft");
  return (
    // The click stops here: the row's own click would also focus the prompt and open a flag's surface.
    <span
      className={cn("flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-caption-sm font-medium tabular-nums", toneText[tag.tone], toneTint[tag.tone])}
      data-testid="row-linked-prs"
      data-kind={tag.kind}
      data-state={tag.state}
      data-tone={tag.tone}
      data-quiet=""
      onClick={(e) => {
        e.stopPropagation();
        // The counted pull requests' keys (facts and keys share their order), the shown one last.
        const counted = keys.filter((_, i) => facts[i]?.state !== "closed");
        const lead = tag.kind === "one" ? tag.number : tag.lead;
        const shown = keys[facts.findIndex((f) => f.number === lead && f.state !== "closed")];
        openLinked(id, [...counted.filter((k) => k !== shown), ...(shown === undefined ? [] : [shown])]);
      }}
      onDoubleClick={(e) => {
        e.stopPropagation();
      }}
    >
      <look.icon className="size-3 shrink-0" aria-label={look.label} />
      {linkedPrTagText(tag)}
    </span>
  );
}
