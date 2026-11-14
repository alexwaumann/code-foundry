import { toneText } from "@/components/pr/tones";
import { prStateLook } from "@/components/prs/prState";
import { threadKey } from "@/lib/tree";
import { cn } from "@/lib/utils";
import { pullRequestDetailResource, pullRequestKey } from "@/stores/gh";
import { usePrPrefetch } from "@/stores/prPrefetch";
import { openPullRequestInPanel } from "@/stores/prPanel";
import { useThreadsStore } from "@/stores/threads";
import { useUiStore } from "@/stores/ui";
import { linkedPrTag, linkedPrTagText } from "./linkedPrTag";
import { useLinkedPrFacts, useLinkKeys } from "./useLinkedPrs";

/** Selects thread `id` (and puts the list's cursor on it) unless it is selected already, so its panel and card show. */
function selectThread(id: string): void {
  const ui = useUiStore.getState();
  if (ui.selection.kind === "thread" && ui.selection.id === id) return;
  ui.setCursor(threadKey(id));
  ui.select({ kind: "thread", id });
}

/**
 * Where a click on the tag goes: every counted pull request opens in a tab linked to the
 * thread (the repo slug comes from the thread's own link, `keys` being their
 * pullRequestKeys), without the focus, the shown one last so its tab is the active one. The thread is selected first, so what opened shows. Each one's detail is
 * read once as well, the shown one first because the daemon answers in order (the entry
 * stays): only the active tab reads its own, and a closed one must leave the tag, as it did
 * when the card read them all.
 */
function openLinked(id: string, keys: readonly string[], shown: string | null): void {
  selectThread(id);
  const links = useThreadsStore.getState().byId[id]?.linkedPullRequests ?? [];
  const linkOf = (key: string) => links.find((l) => pullRequestKey(l.slug, l.number) === key);
  const rest = keys.filter((k) => k !== shown && linkOf(k));
  const lead = shown !== null && linkOf(shown) ? [shown] : [];
  for (const key of [...lead, ...rest]) void pullRequestDetailResource.readOnce(key);
  for (const key of [...rest, ...lead]) {
    const link = linkOf(key);
    if (link) openPullRequestInPanel({ slug: link.slug, number: link.number }, `thread:${id}`, { focus: false });
  }
}

/**
 * The thread's linked pull requests, closed ones left out (linkedPrTag): one shows its
 * state icon and bare number in the state's colour; several show the worst state's icon and
 * colour and "+N", N all of them. Text and icon carry the colour, with no background; an
 * underline on hover says it is clickable. No tooltip of its own: the row's hover card stays
 * open over it.
 */
export function LinkedPrsBadge({ id }: { id: string }) {
  const keys = useLinkKeys(id);
  const facts = useLinkedPrFacts(keys);
  const tag = linkedPrTag(facts);
  // The pull request the tag shows: the one a click lands on, so the one a hover warms.
  const lead = tag === null ? null : tag.kind === "one" ? tag.number : tag.lead;
  const shown = keys[facts.findIndex((f) => f.number === lead && f.state !== "closed")] ?? null;
  const warm = usePrPrefetch(shown);
  if (tag === null) return null;
  const look = prStateLook(tag.state === "draft" ? "open" : tag.state === "unknown" ? null : tag.state, tag.state === "draft");
  return (
    // The click stops here: the row's own click would also focus the prompt and open a flag's surface.
    <span
      className={cn("flex shrink-0 cursor-pointer items-center gap-0.5 text-caption-sm font-medium tabular-nums hover:underline", toneText[tag.tone])}
      data-testid="row-linked-prs"
      data-kind={tag.kind}
      data-state={tag.state}
      data-tone={tag.tone}
      {...warm}
      onClick={(e) => {
        e.stopPropagation();
        // The counted pull requests' keys: facts and keys share their order.
        openLinked(id, keys.filter((_, i) => facts[i]?.state !== "closed"), shown);
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
