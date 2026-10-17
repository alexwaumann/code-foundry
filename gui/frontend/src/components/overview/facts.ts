import type { PullRequestView } from "@/api/gh";
import type { GitStatusView } from "@/api/repo";
import type { SessionsData } from "@/stores/threads";
import type { TerminalsData } from "@/stores/terminals";

/**
 * The worktree panel's facts (WorktreeOverview): what each of the three cards, the git
 * operation strip and the pull request row says. Pure, so the branches are table tests.
 */

/** A fact's colour: success (green), warning (amber), destructive (red), muted. */
export type FactTone = "success" | "warning" | "destructive" | "muted";

/** One coloured piece of a card's value: "↑2" in green, then " to push" small. */
export interface FactPart {
  text: string;
  tone: FactTone;
  /** A word after the count ("to push", "changed"): the small caption size. */
  small?: boolean;
}

/** Ahead/behind as "↑N ↓M" parts (success/warning); only the non-zero ones. */
function arrows(ahead: number, behind: number): FactPart[] {
  const out: FactPart[] = [];
  if (ahead > 0) out.push({ text: `↑${String(ahead)}`, tone: "success" });
  if (behind > 0) out.push({ text: `${out.length > 0 ? " " : ""}↓${String(behind)}`, tone: "warning" });
  return out;
}

/**
 * The origin card: "↑N to push", "↑N ↓M", "↓M behind", "in sync"; "not pushed" (muted)
 * when the branch has no upstream.
 */
export function originFact(st: Pick<GitStatusView, "upstream" | "ahead" | "behind">): FactPart[] {
  if (!st.upstream) return [{ text: "not pushed", tone: "muted" }];
  if (st.ahead === 0 && st.behind === 0) return [{ text: "in sync", tone: "success" }];
  if (st.behind === 0) return [...arrows(st.ahead, 0), { text: " to push", tone: "muted", small: true }];
  if (st.ahead === 0) return [...arrows(0, st.behind), { text: " behind", tone: "muted", small: true }];
  return arrows(st.ahead, st.behind);
}

/** The base card: "↑N ↓M" (either alone when the other is zero); "even" (muted) when both are. */
export function baseFact(st: Pick<GitStatusView, "baseAhead" | "baseBehind">): FactPart[] {
  const parts = arrows(st.baseAhead ?? 0, st.baseBehind ?? 0);
  return parts.length > 0 ? parts : [{ text: "even", tone: "muted" }];
}

/**
 * The working tree card: "N unmerged" (destructive) while anything is conflicted, else
 * "N changed" (warning; staged + modified + untracked), else "clean" (success). A dirty
 * tree with no counted entries (git said dirty, nothing we count) is "changed".
 */
export function workingTreeFact(st: Pick<GitStatusView, "staged" | "modified" | "untracked" | "conflicted" | "dirty">): FactPart[] {
  const conflicted = st.conflicted ?? 0;
  if (conflicted > 0) return [{ text: String(conflicted), tone: "destructive" }, { text: " unmerged", tone: "destructive", small: true }];
  const n = st.staged + st.modified + st.untracked;
  if (n > 0) return [{ text: String(n), tone: "warning" }, { text: " changed", tone: "warning", small: true }];
  if (st.dirty) return [{ text: "changed", tone: "warning" }];
  return [{ text: "clean", tone: "success" }];
}

const OPERATION_LABEL: Record<string, string> = {
  rebase: "Rebase",
  am: "Applying patches",
  merge: "Merge",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  bisect: "Bisect",
};

/** The git operation strip, or null when nothing is in progress. */
export interface OperationStrip {
  /** "Rebase in progress". */
  title: string;
  /** "2 conflicts", "1 conflict"; "" when nothing is conflicted. */
  conflicts: string;
  /** "step 3/6"; "" when git does not record the steps. */
  step: string;
}

export function operationStrip(st: Pick<GitStatusView, "operation" | "operationStep" | "operationTotal" | "conflicted">): OperationStrip | null {
  const op = st.operation ?? "";
  if (!op) return null;
  const label = OPERATION_LABEL[op] ?? op.charAt(0).toUpperCase() + op.slice(1);
  const n = st.conflicted ?? 0;
  const step = st.operationStep ?? 0;
  const total = st.operationTotal ?? 0;
  return {
    title: `${label} in progress`,
    conflicts: n > 0 ? `${String(n)} ${n === 1 ? "conflict" : "conflicts"}` : "",
    step: step > 0 && total > 0 ? `step ${String(step)}/${String(total)}` : "",
  };
}

/**
 * A remote-tracking ref without its remote: "origin/main" → "main" when "origin" is one
 * of the project's remotes; anything else (a local base, "main") as it is.
 */
export function shortRef(ref: string, remotes: readonly string[]): string {
  const slash = ref.indexOf("/");
  if (slash > 0 && remotes.includes(ref.slice(0, slash))) return ref.slice(slash + 1);
  return ref;
}

/** The origin card's label: the upstream's remote, else origin (or the only remote). */
export function upstreamRemote(upstream: string, remotes: readonly string[]): string {
  const slash = upstream.indexOf("/");
  if (slash > 0) return upstream.slice(0, slash);
  return remotes.includes("origin") ? "origin" : (remotes[0] ?? "origin");
}

const newest = (a: PullRequestView, b: PullRequestView) => (b.createdAtMs ?? 0) - (a.createdAtMs ?? 0) || b.number - a.number;

/** The branch's pull request to show: the newest open one, else the newest. */
export function branchPullRequest(prs: readonly PullRequestView[]): PullRequestView | null {
  const open = prs.filter((p) => p.state === "open").sort(newest);
  return open[0] ?? [...prs].sort(newest)[0] ?? null;
}

/**
 * Threads in the worktree other than `self` (the selected thread the panel belongs to;
 * "" for none): unarchived threads whose worktree path is exactly `path`.
 */
export function otherThreads(sessions: SessionsData, path: string, self: string): number {
  let n = 0;
  for (const id of sessions.order) {
    const s = sessions.byId[id];
    if (s && id !== self && s.worktreePath === path && !s.archivedAtMs) n++;
  }
  return n;
}

/** Live terminals (bottom shells, top, actions) whose cwd is `path`; exited ones do not count. */
export function shellsIn(terminals: TerminalsData, path: string): number {
  let n = 0;
  for (const id of terminals.order) {
    const t = terminals.byId[id];
    if (t && t.cwd === path && t.state !== "exited") n++;
  }
  return n;
}
