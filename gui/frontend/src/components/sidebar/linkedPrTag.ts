/**
 * The sidebar's linked-PRs tag (docs/notes/sidebar-pr-tag.md, docs/notes/sidebar-pr-tag-plus.md):
 * which of a thread's linked pull requests it counts, what it shows (one PR's state and
 * number; several as "+N" in the worst one's state) and in which tone. Pure: LinkedPrsBadge feeds it what the GitHub resources already hold.
 */
import type { PullRequestView } from "@/api/gh";
import { stateBadge, type Tone } from "@/components/pr/model";
import { pullRequestKey } from "@/stores/gh";

/** A linked pull request's state; "unknown" while the GUI has not read it (no poll yet, no gh). */
export type LinkedPrState = "open" | "draft" | "merged" | "closed" | "unknown";

/** One linked pull request as the tag reads it. `title` is "" when unknown. */
export interface LinkedPrFact {
  number: number;
  state: LinkedPrState;
  title: string;
}

export type LinkedPrTag =
  /** One counted pull request: its state icon and bare number. */
  | { kind: "one"; number: number; state: Exclude<LinkedPrState, "closed">; tone: Tone }
  /**
   * Two or more: the worst state's icon and tone and "+N", `count` being all of them
   * ("+3"). `lead` is the first (newest) counted pull request in that state: the one a
   * click leaves active.
   */
  | { kind: "many"; lead: number; state: Exclude<LinkedPrState, "closed">; count: number; tone: Tone };

/** The state of a read pull request (draft is an open one); "unknown" for none. */
export function linkedPrState(pr: Pick<PullRequestView, "state" | "draft"> | null): LinkedPrState {
  if (pr === null) return "unknown";
  if (pr.state === "open") return pr.draft ? "draft" : "open";
  return pr.state;
}

/** The PR surface header's tone for a state (pr/model `stateBadge`); unknown is neutral. */
export function linkedPrTone(state: LinkedPrState): Tone {
  if (state === "draft") return stateBadge({ state: "open", draft: true }).tone;
  return stateBadge({ state, draft: false }).tone;
}

/** The fresher of two reads of one pull request by updatedAtMs; a tie or an unknown time keeps `a`. */
export function fresher<T extends Pick<PullRequestView, "updatedAtMs">>(a: T | null, b: T | null): T | null {
  if (a === null) return b;
  if (b === null) return a;
  return (b.updatedAtMs ?? -Infinity) > (a.updatedAtMs ?? -Infinity) ? b : a;
}

/**
 * The pull request with `key` (pullRequestKey) in the lists, the first list that has it
 * winning; null when none does. A poll's partial entry (only its fingerprint known) does
 * not count, as in the composer's pool (lib/tagCandidates `prPool`).
 */
export function findLinkedPr(lists: readonly (readonly PullRequestView[])[], key: string): PullRequestView | null {
  for (const list of lists) {
    for (const pr of list) {
      if (!pr.partial && pullRequestKey(pr.repoSlug, pr.number) === key) return pr;
    }
  }
  return null;
}

export type Counted = LinkedPrFact & { state: Exclude<LinkedPrState, "closed"> };

/** The pull requests the tag counts: all but the closed ones. */
function counted(prs: readonly LinkedPrFact[]): Counted[] {
  return prs.filter((p): p is Counted => p.state !== "closed");
}

/**
 * The tag for a thread's linked pull requests. Closed ones are left out: they neither
 * count nor show, and a thread whose links are all closed gets no tag (null). One left
 * shows as itself; two or more as "+N" (N all of them) with the icon and tone of the worst
 * state among them: any draft, then any open, then merged when all are; unknown ones
 * count, and with merged ones only the worst is unknown (neutral).
 */
export function linkedPrTag(prs: readonly LinkedPrFact[]): LinkedPrTag | null {
  const shown = counted(prs);
  const [first] = shown;
  if (first === undefined) return null;
  if (shown.length === 1) return { kind: "one", number: first.number, state: first.state, tone: linkedPrTone(first.state) };
  const has = (s: LinkedPrState) => shown.some((p) => p.state === s);
  const worst: Exclude<LinkedPrState, "closed"> = has("draft") ? "draft" : has("open") ? "open" : shown.every((p) => p.state === "merged") ? "merged" : "unknown";
  const lead = shown.find((p) => p.state === worst) ?? first;
  return { kind: "many", lead: lead.number, state: worst, count: shown.length, tone: linkedPrTone(worst) };
}

/** The tag's text: the bare number for one ("142"), "+N" for several ("+3"). */
export function linkedPrTagText(tag: LinkedPrTag): string {
  return tag.kind === "one" ? String(tag.number) : `+${String(tag.count)}`;
}

/** The thread card lists at most this many pull requests, then "+N more". */
export const LINKED_PR_TIP_CAP = 5;

/**
 * The thread card's linked pull requests (docs/notes/sidebar-thread-card.md): the ones the
 * tag counts (closed left out), in the given order, at most LINKED_PR_TIP_CAP, and how many
 * more there are. No rows: the card shows no section.
 */
export function linkedPrCardRows(prs: readonly LinkedPrFact[]): { rows: Counted[]; more: number } {
  const shown = counted(prs);
  return { rows: shown.slice(0, LINKED_PR_TIP_CAP), more: Math.max(0, shown.length - LINKED_PR_TIP_CAP) };
}
