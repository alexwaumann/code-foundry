import type { Tone } from "@/components/pr/model";
import { toneText } from "@/components/pr/tones";
import { prStateLook } from "@/components/prs/prState";
import { Tip } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { showThreadInfo } from "@/stores/threadInfoOverlay";
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
      {/* A click shows the thread info card, whose pull request rows list these, and goes on
          to the row, which selects the thread (and so shows the card beside it). */}
      <span
        className={cn("flex shrink-0 cursor-pointer items-center gap-0.5 rounded-sm px-1 text-caption-sm font-medium tabular-nums", toneText[tag.tone], toneTint[tag.tone])}
        data-testid="row-linked-prs"
        data-kind={tag.kind}
        data-state={tag.kind === "one" ? tag.state : undefined}
        data-tone={tag.tone}
        onClick={() => {
          showThreadInfo(id);
        }}
      >
        {look && <look.icon className="size-3 shrink-0" aria-label={look.label} />}
        {linkedPrTagText(tag)}
      </span>
    </Tip>
  );
}
