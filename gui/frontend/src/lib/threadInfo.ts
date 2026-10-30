/**
 * The thread info card's row models (docs/notes/thread-info-card.md, design
 * docs/sketches/thread-info v14): which git state row shows, which action the action row
 * offers, what a pull request's lines say, and when the git buttons wait for the model.
 * Pure; the card's components select the inputs narrowly (components/threadinfo).
 */
import type { ActionPickView, ActionView } from "@/api/actions";
import type { PullRequestView } from "@/api/gh";
import type { GitStatusView } from "@/api/project";
import type { ThreadView } from "@/api/threads";
import { isWorkingThread } from "./thread";

/** The card's column, its right gutter included (ThreadInfoCard w-80). */
export const CARD_WIDTH = 320;
/** The conversation is never narrowed below this to make room for the card. */
export const CONVERSATION_MIN = 480;

/** Whether the card fits beside the conversation in a thread body this wide. */
export function cardFits(bodyWidth: number): boolean {
  return bodyWidth - CARD_WIDTH >= CONVERSATION_MIN;
}

/** The toggle's tooltip while the card is on but has no room. */
export const NO_ROOM_REASON = "Not enough room";

/** The git state row: at most one, in this priority (gitStateRow). */
export type GitStateRow =
  | { kind: "conflicts"; files: number }
  | { kind: "diverged"; ahead: number; behind: number }
  /** A git operation stopped in the checkout; step and total 0 when unknown (a merge). */
  | { kind: "operation"; operation: string; step: number; total: number }
  | { kind: "push"; ahead: number }
  | { kind: "pull"; behind: number }
  | { kind: "rebase"; base: string; behind: number };

/** Behind the base by this many commits, the card offers a rebase. */
export const REBASE_BEHIND = 10;

/**
 * The checkout's git state row: conflicts, then a diverged upstream, then an operation in
 * progress, then push (ahead only), pull (behind only), and a rebase onto the base once it
 * is REBASE_BEHIND commits behind; null when clean and in sync (or no status yet).
 */
export function gitStateRow(st: GitStatusView | null): GitStateRow | null {
  if (!st) return null;
  const conflicted = st.conflicted ?? 0;
  if (conflicted > 0) return { kind: "conflicts", files: conflicted };
  const upstream = st.upstream !== "";
  if (upstream && st.ahead > 0 && st.behind > 0) return { kind: "diverged", ahead: st.ahead, behind: st.behind };
  if (st.operation)
    return {
      kind: "operation",
      operation: st.operation,
      step: st.operationStep ?? 0,
      total: st.operationTotal ?? 0,
    };
  if (upstream && st.ahead > 0) return { kind: "push", ahead: st.ahead };
  if (upstream && st.behind > 0) return { kind: "pull", behind: st.behind };
  const baseBehind = st.baseBehind ?? 0;
  if (st.baseRef && baseBehind >= REBASE_BEHIND) return { kind: "rebase", base: st.baseRef, behind: baseBehind };
  return null;
}

const OPERATION_NAMES: Readonly<Record<string, string>> = {
  rebase: "Rebase",
  am: "Patch",
  merge: "Merge",
  "cherry-pick": "Cherry-pick",
  revert: "Revert",
  bisect: "Bisect",
};

/** "Rebase in progress", "Merge in progress"; the step ("3/7") is operationStep. */
export function operationLabel(operation: string): string {
  const name = OPERATION_NAMES[operation] ?? operation.charAt(0).toUpperCase() + operation.slice(1);
  return `${name} in progress`;
}

/** "3/7" while a rebase (or am) says where it is; "" otherwise. */
export function operationStep(step: number, total: number): string {
  return step > 0 && total > 0 ? `${String(step)}/${String(total)}` : "";
}

/** "1 commit", "3 commits". */
export function commits(n: number): string {
  return `${String(n)} ${n === 1 ? "commit" : "commits"}`;
}

/** "1 file", "3 files". */
export function files(n: number): string {
  return `${String(n)} ${n === 1 ? "file" : "files"}`;
}

/** The prompts the git state row's buttons send to the thread. */
export const RESOLVE_PROMPT = "Resolve the merge conflicts in this checkout, keep both sides' intent, run the project's checks, then report.";

export function fixPrompt(ahead: number, behind: number): string {
  return `This branch has diverged from its upstream (${String(ahead)} ahead, ${String(behind)} behind). Reconcile it safely (prefer rebase, never force-push without --force-with-lease), run the checks, then report.`;
}

export function rebasePrompt(base: string): string {
  return `Rebase this branch onto ${base}, resolve any conflicts, run the checks, then report.`;
}

/** Why Push, Pull and Rebase wait: the model may be changing the branch under them. */
export const MODEL_WORKING_REASON = "A model is still working on this branch.";

/** What decides whether the git buttons wait (gitButtonsBlocked). */
export interface GitBusyInput {
  /** The thread's Claude is working (its badge is busy). */
  working: boolean;
  /** Its subagent runs running now. */
  agentsRunning: number;
  /** Another thread's model is working in the same checkout (otherModelWorksIn). */
  collision: boolean;
}

/**
 * The reason Push, Pull and Rebase are disabled (not queued), or null when they may run:
 * this thread's Claude or any of its subagents is working, or another thread's model works in
 * the same checkout.
 */
export function gitButtonsBlocked(i: GitBusyInput): string | null {
  return i.working || i.agentsRunning > 0 || i.collision ? MODEL_WORKING_REASON : null;
}

/**
 * Whether a model other than `self`'s is working in the checkout at `path` now: another
 * thread whose cwd or recorded checkout it is, and whose Claude is mid-turn (its badge is
 * busy) or has subagents running. A thread whose process is up but idle at its prompt does
 * not count; an archived or snoozed one is stopped, so it never does.
 */
export function otherModelWorksIn(
  threads: { order: readonly string[]; byId: Readonly<Record<string, Pick<ThreadView, "state" | "status" | "agentsRunning" | "worktreePath" | "checkoutPaths">>> },
  self: string,
  path: string,
): boolean {
  if (!path) return false;
  return threads.order.some((id) => {
    if (id === self) return false;
    const t = threads.byId[id];
    if (!t || !(isWorkingThread(t) || t.agentsRunning > 0)) return false;
    return t.worktreePath === path || t.checkoutPaths.some((c) => c.path === path);
  });
}

/** One member project's pick (ActionService.LastRun for the thread), in the set's order. */
export interface MemberPick {
  projectId: string;
  pick: ActionPickView | null;
}

/** The action row: the action, and whether its project is named (it is not the cwd's). */
export interface ActionChoice {
  action: ActionView;
  showProject: boolean;
}

/**
 * The action the card's action row offers, over the thread's projects: the action last
 * run in this thread in any of them (the newest such run), else the cwd's project's pick
 * (its last run anywhere, else its first action), else the first member with one. Its
 * project is named on a second line only when it is not the cwd's. Null without actions.
 */
export function chooseAction(picks: readonly MemberPick[], cwdProjectId: string): ActionChoice | null {
  let best: ActionPickView | null = null;
  for (const m of picks) {
    const p = m.pick;
    if (p?.source !== "thread") continue;
    if (!best || (p.last?.startedAtMs ?? 0) > (best.last?.startedAtMs ?? 0)) best = p;
  }
  best ??= picks.find((m) => m.projectId === cwdProjectId)?.pick ?? null;
  best ??= picks.find((m) => m.pick !== null)?.pick ?? null;
  if (!best) return null;
  return {
    action: best.action,
    showProject: best.action.projectId !== cwdProjectId,
  };
}

/** A pull request row's state, by icon and colour only. */
export type PrRowState = "open" | "draft" | "merged";

/** The second line's status: an icon (none for draft and merged) and its word. */
export type PrCheck = {
  icon: "ok" | "failed" | "running" | null;
  word: string;
};

export interface PrRow {
  slug: string;
  number: number;
  url: string;
  title: string;
  state: PrRowState;
  check: PrCheck;
  /** The linked pull request this one is stacked on (its base is that one's head); null otherwise. */
  stackedOn: number | null;
  /** Its project's name when that is not the cwd's project; "" otherwise. */
  project: string;
}

/** A linked pull request as the card reads it: the link and its cached detail (null until loaded). */
export interface PrInput {
  slug: string;
  number: number;
  url: string;
  pr: PullRequestView | null;
}

/** The status on a pull request row's second line (prCheck). */
export function prCheck(pr: Pick<PullRequestView, "state" | "draft" | "checks" | "review" | "reviewRequests">): PrCheck {
  if (pr.state === "merged") return { icon: null, word: "merged" };
  if (pr.draft) return { icon: null, word: "draft" };
  const c = pr.checks.state;
  if (c === "failure" || c === "error") return { icon: "failed", word: "checks failing" };
  if (c === "pending" || c === "expected") return { icon: "running", word: "checks running" };
  const ok = c === "success" ? "ok" : null;
  // The review in the PR tab's words (prs/format reviewLabel); "review requested" only while someone is asked.
  if (pr.review === "approved") return { icon: ok, word: "approved" };
  if (pr.review === "changes_requested") return { icon: ok, word: "changes requested" };
  if (pr.reviewRequests.length > 0) return { icon: ok, word: "review requested" };
  if (pr.review === "review_required") return { icon: ok, word: "review required" };
  return { icon: ok, word: "no review" };
}

const STATE_ORDER: Readonly<Record<PrRowState, number>> = {
  open: 0,
  draft: 0,
  merged: 1,
};

/**
 * The card's pull request rows: one per linked pull request, never a closed one (nor one
 * whose detail has not loaded: its state is unknown). Grouped by project, the cwd's
 * first, then the set's order (other repositories last); in a project open and draft ones
 * before merged ones, newest number first. `projects` maps a lower-case GitHub slug to the
 * member's id and name.
 */
export function prRows(
  inputs: readonly PrInput[],
  projects: ReadonlyMap<string, { id: string; name: string }>,
  memberOrder: readonly string[],
  cwdProjectId: string,
): PrRow[] {
  const known = inputs.filter((i): i is PrInput & { pr: PullRequestView } => i.pr !== null && (i.pr.state === "open" || i.pr.state === "merged"));
  const rank = (slug: string): number => {
    const p = projects.get(slug.toLowerCase());
    if (!p) return memberOrder.length + 1;
    return p.id === cwdProjectId ? -1 : memberOrder.indexOf(p.id);
  };
  const rows = known.map((i): PrRow & { rank: number } => {
    const pr = i.pr;
    const state: PrRowState = pr.state === "merged" ? "merged" : pr.draft ? "draft" : "open";
    const base =
      pr.state === "open"
        ? known.find(
            (o) => o !== i && o.slug.toLowerCase() === i.slug.toLowerCase() && o.pr.state === "open" && o.pr.headRef !== "" && o.pr.headRef === pr.baseRef,
          )
        : undefined;
    const p = projects.get(i.slug.toLowerCase());
    return {
      slug: i.slug,
      number: i.number,
      url: i.url,
      title: pr.title,
      state,
      check: prCheck(pr),
      stackedOn: base ? base.number : null,
      project: p && p.id !== cwdProjectId ? p.name : p ? "" : i.slug,
      rank: rank(i.slug),
    };
  });
  rows.sort((a, b) => a.rank - b.rank || STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.number - a.number);
  return rows.map(({ rank: _rank, ...r }) => r);
}

/** "+N" after the cwd's name: the set's other projects, when no named workspace names them. */
export function moreProjects(setSize: number, named: boolean): string {
  return !named && setSize > 1 ? `+${String(setSize - 1)}` : "";
}

/** Whole minutes until the prompt cache expires (rounded up; 0 or less once expired); null before the first result. */
export function cacheMinutesLeft(expiresAtMs: number | null, now: number): number | null {
  return expiresAtMs === null ? null : Math.ceil((expiresAtMs - now) / 60_000);
}

/** The context row's muted suffix: "cache 41m" while the prompt cache is warm, "cache expired" after, "" before the first result. */
export function cacheSuffix(minutesLeft: number | null): string {
  if (minutesLeft === null) return "";
  return minutesLeft <= 0 ? "cache expired" : `cache ${String(minutesLeft)}m`;
}

/** How full the context is, 0-100, rounded; null when the window is unknown. */
export function contextPercent(tokens: number, window: number): number | null {
  if (!(window > 0)) return null;
  return Math.min(100, Math.round((tokens / window) * 100));
}

/** The MCP row's figures from the servers' statuses; null when there is none. */
export interface McpCounts {
  total: number;
  connected: number;
  failed: number;
  needsLogin: number;
}

export function mcpCounts(statuses: readonly string[]): McpCounts | null {
  if (statuses.length === 0) return null;
  return {
    total: statuses.length,
    connected: statuses.filter((s) => s === "connected").length,
    failed: statuses.filter((s) => s === "failed").length,
    needsLogin: statuses.filter((s) => s === "needs-auth").length,
  };
}

/** A lineage row's state: a running or waiting row, or a finished one under Previous agents. */
export type LineageRowState = "working" | "attention" | "done" | "failed";

/** The parent row's word for the creator's state. */
export function parentWord(state: LineageRowState): string {
  return state === "working" ? "Working" : state === "attention" ? "Needs you" : "Done";
}

/** A lineage row's state in words (its hover card). */
export const lineageStateWords: Readonly<Record<LineageRowState, string>> = {
  working: "Working",
  attention: "Needs you",
  done: "Done",
  failed: "Failed",
};

/** A shell's runtime from its command's first word (after any VAR=value): node, python or go; "" for any other. */
export function shellRuntime(command: string): string {
  const words = command.trim().split(/\s+/);
  const first = words.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) ?? "";
  const name = first.slice(first.lastIndexOf("/") + 1);
  if (["node", "npm", "npx", "pnpm", "yarn"].includes(name)) return "node";
  if (/^python(\d+(\.\d+)?)?$/.test(name)) return "python";
  if (name === "go") return "go";
  return "";
}

/** A port as the card shows it and the browser opens it: every listening address is localhost to the user. */
export function serverAddress(port: number): string {
  return `localhost:${String(port)}`;
}

/** "1 shell", "3 shells"; under server rows "1 more shell", "3 more shells". */
export function shellCount(n: number, more = false): string {
  return `${String(n)} ${more ? "more " : ""}${n === 1 ? "shell" : "shells"}`;
}

/** A subagent run or a child thread as the lineage group lists it; both look the same. */
export interface LineageRow {
  kind: "agent" | "thread";
  id: string;
  name: string;
  state: LineageRowState;
  /** The hover card's type: the subagent's type, or the child's branch. */
  type: string;
  model: string;
  effort: string;
  startedAtMs: number | null;
  /** When it finished (a finished row); null while it runs or when unknown. */
  endedAtMs: number | null;
  /** A finished subagent's running time as Claude counts it; 0 when unknown. */
  durationMs: number;
}

/** A child thread's row state from its lineage status (lib/lineage lineageStatus). */
export function childRowState(status: string): LineageRowState {
  if (status === "working") return "working";
  if (status === "input") return "attention";
  if (status === "error") return "failed";
  return "done";
}

/** A subagent run's row state. */
export function agentRowState(status: string): LineageRowState {
  return status === "running" ? "working" : status === "failed" ? "failed" : "done";
}

/**
 * The lineage group's rows: the running and waiting ones (newest first), and the
 * finished ones under "Previous agents" (newest first).
 */
export function splitLineage(rows: readonly LineageRow[]): {
  live: LineageRow[];
  previous: LineageRow[];
} {
  const newest = (a: LineageRow, b: LineageRow) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0);
  return {
    live: rows.filter((r) => r.state === "working" || r.state === "attention").sort(newest),
    previous: rows.filter((r) => r.state === "done" || r.state === "failed").sort(newest),
  };
}

/** How long a row ran: to now while live, else its duration (or start to end); null when unknown. */
export function lineageElapsedMs(r: Pick<LineageRow, "state" | "startedAtMs" | "endedAtMs" | "durationMs">, now: number): number | null {
  if (r.state === "working" || r.state === "attention") return r.startedAtMs === null ? null : Math.max(0, now - r.startedAtMs);
  if (r.durationMs > 0) return r.durationMs;
  return r.startedAtMs !== null && r.endedAtMs !== null ? Math.max(0, r.endedAtMs - r.startedAtMs) : null;
}
