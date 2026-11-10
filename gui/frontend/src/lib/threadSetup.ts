/**
 * A thread's setup as the GUI tells it (docs/notes/instant-threads-3-gui.md): what the
 * timeline shows under the first message, what the sidebar row says, and whether a thread
 * has a place to run yet. Pure, over Thread.setup; components/thread/SetupRow.tsx renders it.
 *
 * Always read from the latest setup: a step with nothing to do leaves the list, and a retry
 * puts steps back to pending, restarts the times and can change a generated branch.
 */
import type { ThreadSetupStepStatusView, ThreadSetupStepView, ThreadSetupView, ThreadView } from "@/api/threads";
import { shortAge } from "./thread";
import { formatDuration } from "./toolSummary";

/** How long a step runs before the checklist shows: a fast thread never flashes one. */
export const SETUP_REVEAL_MS = 300;

/** Setup.error of a thread the daemon lost during its setup (internal/store/thread/setup.go SetupRestarted). */
export const SETUP_RESTARTED = "Code Foundry restarted during setup";

/** What a setup a restart cut off says, in place of the step it was on: nothing went wrong there. */
const RESTARTED_TITLE = "Setup stopped when Code Foundry restarted";

/** What the row has shown of the thread's setup (stores/thread setupShown): line keys. */
export type SetupShown = ReadonlySet<string>;

/** Nothing shown yet. */
export const NOTHING_SHOWN: SetupShown = new Set();

/** The turn-fold key of the setup's fold line (stores/thread setTurnFolded): forgotten on leaving the thread, so it is folded on every visit. */
export const SETUP_FOLD_KEY = "setup";

/** A setup that ran and ended without Claude, or still runs: the thread cannot take most things yet. */
export function setupUnfinished(s: ThreadSetupView | null | undefined): boolean {
  return s != null && s.phase !== "done";
}

/** A setup running with its creator waiting on it: it takes no messages and no cancel, and its failure takes the thread. */
export function setupWaitedFor(s: ThreadSetupView | null | undefined): boolean {
  return s?.phase === "running" && !s.background;
}

/**
 * The thread has no cwd yet: its worktrees are being made, or a setup that did not finish
 * never got that far (the daemon's Thread.unplaced). A placement that landed before a later
 * step failed has one, and works like any stopped thread's.
 */
export function isUnplaced(t: Pick<ThreadView, "setup" | "worktreePath"> | undefined): boolean {
  return t !== undefined && setupUnfinished(t.setup) && t.worktreePath === "";
}

/** A setup with something to tell: more than starting Claude. Only a thread making nothing has just that step. */
export function hasSetupWork(s: ThreadSetupView): boolean {
  return s.steps.some((st) => st.kind !== "start");
}

/**
 * When the checklist shows, epoch ms; null while no step has earned it. The first moment
 * a step has been running SETUP_REVEAL_MS, so steps that ended sooner never count, or the
 * end of a step that warned, which always shows. It may be ahead of now: a running step
 * reaches it unless it ends first. Times can change under it: a retry puts steps back, and a
 * late snapshot says a running step ended before its 300ms were up. So what has been on
 * screen is kept apart (SetupShown), and a line once shown stays whatever this says.
 */
export function setupRevealAt(s: ThreadSetupView): number | null {
  let at: number | null = null;
  for (const st of s.steps) {
    if (st.startedAtMs === null) continue;
    const bar = st.startedAtMs + SETUP_REVEAL_MS;
    const ended = st.endedAtMs;
    let t: number | null = null;
    if (ended === null || ended >= bar) t = bar;
    else if (st.status === "warning") t = ended;
    if (t !== null && (at === null || t < at)) at = t;
  }
  return at;
}

/**
 * What the row model needs of a setup (lib/threadTimeline buildRows): "" no row, and the
 * turn's own header as if there were no setup; "running" a row with the live header held
 * back; "done" a fold line; "stopped" a row and no header for the turn that never ran.
 * A setup that only starts Claude has nothing to tell while it runs or once done: "Working"
 * says it. One that took no time either, so a fast thread has no fold line. `shown`: the
 * row has shown its checklist, which stays through the run whatever the times say now.
 */
export type SetupRowPhase = "" | "running" | "done" | "stopped";

export function setupRowPhase(s: ThreadSetupView | null | undefined, shown = false): SetupRowPhase {
  if (!s) return "";
  switch (s.phase) {
    case "failed":
    case "cancelled":
      return "stopped";
    case "running":
      return hasSetupWork(s) || shown ? "running" : "";
    case "done":
      return shown || (hasSetupWork(s) && setupRevealAt(s) !== null) ? "done" : "";
  }
}

/** A step a restart cut off: it failed, but nothing is wrong with what it was doing. */
function restartedStep(st: Pick<ThreadSetupStepView, "status" | "error">): boolean {
  return st.status === "failed" && st.error === SETUP_RESTARTED;
}

/** A line's words: what comes before and after the part in mono ("Fetched", "origin/main", ""). */
export interface SetupLabel {
  before: string;
  code: string;
  after: string;
}

/** One line of the checklist: a step, or with several projects one project's. */
export interface SetupLine {
  key: string;
  status: ThreadSetupStepStatusView;
  /** The project's name before the words; "" on a single project's lines and the name and Claude lines. */
  project: string;
  label: SetupLabel;
  startedAtMs: number | null;
  endedAtMs: number | null;
  /** Git's text in the box under a failed line; "" for none. */
  error: string;
}

function words(before: string): SetupLabel {
  return { before, code: "", after: "" };
}

/** The label with `ref` in mono after `word`; a fetch whose ref is not known yet says so plainly. */
function fetchWords(word: string, ref: string): SetupLabel {
  return ref ? { before: `${word} `, code: ref, after: "" } : words(`${word} the base`);
}

/** " from 2h ago": how old the ref's tip was when the fetch failed. */
function refAge(st: ThreadSetupStepView, nowMs: number): string {
  if (st.refAtMs === null) return "";
  const from = st.endedAtMs ?? nowMs;
  return from - st.refAtMs < 60_000 ? " from under a minute ago" : ` from ${shortAge(st.refAtMs, from)} ago`;
}

function warningWords(st: ThreadSetupStepView, nowMs: number): SetupLabel {
  const what = st.warning || "Could not fetch";
  // No time means no such ref on disk: nothing it is using.
  return st.refAtMs !== null && st.ref ? { before: `${what}, using `, code: st.ref, after: refAge(st, nowMs) } : words(what);
}

/** A step's words, in the tense its status has. */
function stepWords(st: ThreadSetupStepView, nowMs: number): SetupLabel {
  const failed = st.status === "failed";
  if (restartedStep(st)) return words(RESTARTED_TITLE);
  const done = st.status === "done";
  switch (st.kind) {
    case "name":
      if (failed) return words("Could not name the branch");
      if (done) return st.branch ? { before: st.existing ? "Using the branch " : "Named the branch ", code: st.branch, after: "" } : words("Named the branch");
      return words("Naming the branch");
    case "fetch":
      if (st.status === "warning") return warningWords(st, nowMs);
      return fetchWords(failed ? "Could not fetch" : done ? "Fetched" : "Fetching", st.ref);
    case "worktree":
      return words(failed ? "Could not create the worktree" : done ? "Created the worktree" : "Creating the worktree");
    case "start":
      return words(failed ? "Could not start Claude" : done ? "Started Claude" : "Starting Claude");
  }
}

function stepLine(st: ThreadSetupStepView, nowMs: number, project = ""): SetupLine {
  return {
    key: `${st.kind}:${st.projectId}`,
    status: st.status,
    project,
    label: stepWords(st, nowMs),
    startedAtMs: st.startedAtMs,
    endedAtMs: st.endedAtMs,
    // The line itself says a restart stopped it.
    error: st.status === "failed" && !restartedStep(st) ? st.error : "",
  };
}

/**
 * One project's line of a setup with several (its fetch and worktree steps), in what it is
 * doing now: a failed step as it ended, a fetch or worktree under way, "Worktree ready".
 * A fetch that ended with the worktree still to come reads as that worktree under way: it
 * is waiting on the branch's name at most, and a spinner that turned back into a dim circle
 * would look like going backwards. A fetch that warned keeps a line of its own, so the
 * warning does not leave with the fetch.
 */
function projectLines(steps: readonly ThreadSetupStepView[], running: boolean, nowMs: number): SetupLine[] {
  const fetch = steps.find((st) => st.kind === "fetch");
  const worktree = steps.find((st) => st.kind === "worktree");
  const name = (fetch ?? worktree)?.projectName || (fetch ?? worktree)?.projectId || "";
  const out: SetupLine[] = [];
  if (fetch?.status === "warning") out.push({ ...stepLine(fetch, nowMs, name), key: `warning:${fetch.projectId}` });
  const failed = steps.find((st) => st.status === "failed");
  if (failed) return [...out, { ...stepLine(failed, nowMs, name), key: `project:${failed.projectId}` }];
  const key = `project:${fetch?.projectId ?? worktree?.projectId ?? ""}`;
  if (worktree?.status === "done") {
    const first = fetch?.status === "done" ? fetch : worktree;
    return [...out, { ...stepLine(worktree, nowMs, name), key, label: words("Worktree ready"), startedAtMs: first.startedAtMs }];
  }
  if (fetch?.status === "running") return [...out, { ...stepLine(fetch, nowMs, name), key }];
  if (worktree?.status === "running") return [...out, { ...stepLine(worktree, nowMs, name), key }];
  const fetched = fetch?.status === "done" || fetch?.status === "warning";
  if (worktree && (fetched || !fetch)) return [...out, { ...stepLine(worktree, nowMs, name), key, status: running && fetched ? "running" : "pending" }];
  return fetch ? [...out, { ...stepLine(fetch, nowMs, name), key }] : out;
}

/** The projects with steps, each with its steps, in worktree order: a fetch that leaves the list moves nothing. */
function byProject(steps: readonly ThreadSetupStepView[]): ThreadSetupStepView[][] {
  const seen = new Map<string, ThreadSetupStepView[]>();
  const place = (st: ThreadSetupStepView) => {
    const list = seen.get(st.projectId);
    if (list) list.push(st);
    else seen.set(st.projectId, [st]);
  };
  for (const st of steps) if (st.kind === "worktree") place(st);
  for (const st of steps) if (st.kind === "fetch") place(st);
  return [...seen.values()];
}

/**
 * Every line of the setup, top to bottom: one per step, or with several projects the name
 * line, one per project, the Claude line.
 */
export function setupLines(s: ThreadSetupView, nowMs: number): SetupLine[] {
  const projects = byProject(s.steps);
  if (projects.length < 2) return s.steps.map((st) => stepLine(st, nowMs));
  const running = s.phase === "running";
  const single = (kind: "name" | "start") => s.steps.filter((st) => st.kind === kind).map((st) => stepLine(st, nowMs));
  return [...single("name"), ...projects.flatMap((steps) => projectLines(steps, running, nowMs)), ...single("start")];
}

/** A line's time at the right: how long it took, or has run in whole seconds; "" while it has not started. */
export function setupLineTime(l: Pick<SetupLine, "status" | "startedAtMs" | "endedAtMs">, nowMs: number): string {
  if (l.startedAtMs === null) return "";
  if (l.endedAtMs !== null) return formatDuration(l.endedAtMs - l.startedAtMs);
  return l.status === "running" ? wholeSeconds(nowMs - l.startedAtMs) : "";
}

/** A running time as the turn's live header has it: "3s", "1m 02s". */
function wholeSeconds(ms: number): string {
  return formatDuration(Math.max(0, ms)).replace(/\.\ds$/, "s") || "0s";
}

/** A line's words as plain text. */
export function setupLabelText(l: SetupLabel): string {
  return `${l.before}${l.code}${l.after}`;
}

/** The one phrase a done setup's fold line keeps of its warnings, so a stale base is not hidden; "" for none. */
export function setupFoldWarning(s: ThreadSetupView, nowMs: number): string {
  const warned = s.steps.filter((st) => st.status === "warning");
  const only = warned[0];
  if (!only) return "";
  if (warned.length > 1) {
    // A project with no such ref on disk is on no old base: it started from what it has.
    const old = warned.every((st) => st.refAtMs !== null && st.ref);
    return `${String(warned.length)} projects ${old ? "on an old base" : "could not fetch"}`;
  }
  const w = warningWords(only, nowMs);
  if (w.code) return `using ${w.code}${w.after}`;
  return w.before.charAt(0).toLowerCase() + w.before.slice(1);
}

/** What the setup's timeline row shows now. */
export type SetupView =
  | { kind: "none" }
  /** Running: the live line, its elapsed time and the lines that earned their place. */
  | { kind: "live"; elapsed: string; lines: SetupLine[] }
  /** Failed: no live line, the rows as they ended. */
  | { kind: "failed"; lines: SetupLine[] }
  /** Cancelled: one quiet line. */
  | { kind: "cancelled"; label: string }
  /** Done: the fold line, its warning and what it opens to. */
  | { kind: "done"; label: string; warning: string; lines: SetupLine[] };

/** How long a setup that ended took, in ms; null when it does not know. */
function setupTookMs(s: ThreadSetupView): number | null {
  return s.startedAtMs !== null && s.endedAtMs !== null ? s.endedAtMs - s.startedAtMs : null;
}

/** The setup's own error as a line, where no step says why it failed; before the steps that never ran. */
function withSetupError(s: ThreadSetupView, lines: readonly SetupLine[]): SetupLine[] {
  if (lines.some((l) => l.status === "failed")) return [...lines];
  const restarted = s.error === SETUP_RESTARTED;
  const why: SetupLine = {
    key: "setup-error",
    status: "failed",
    project: "",
    label: words(restarted ? RESTARTED_TITLE : "Setup failed"),
    startedAtMs: null,
    endedAtMs: null,
    error: restarted ? "" : s.error,
  };
  const at = lines.findIndex((l) => l.status === "pending");
  return at < 0 ? [...lines, why] : [...lines.slice(0, at), why, ...lines.slice(at)];
}

/**
 * What the row shows now. `shown` are the lines it has shown of this thread's setup: they
 * stay, and once it has shown any the checklist does, through a retry or a late snapshot.
 */
export function setupView(s: ThreadSetupView | null | undefined, nowMs: number, shown: SetupShown = NOTHING_SHOWN): SetupView {
  if (!s) return { kind: "none" };
  const seen = shown.size > 0;
  switch (s.phase) {
    case "failed":
      return { kind: "failed", lines: withSetupError(s, setupLines(s, nowMs)) };
    case "cancelled": {
      const ms = setupTookMs(s);
      // Whole seconds, but for a cancel inside the first one, which "0s" would misstate.
      const took = ms === null ? "" : ms < 1000 ? formatDuration(ms) : wholeSeconds(ms);
      return { kind: "cancelled", label: took ? `Setup cancelled after ${took}` : "Setup cancelled" };
    }
    case "done": {
      if (setupRowPhase(s, seen) !== "done") return { kind: "none" };
      const took = formatDuration(setupTookMs(s) ?? 0);
      return { kind: "done", label: took ? `Set up in ${took}` : "Set up", warning: setupFoldWarning(s, nowMs), lines: setupLines(s, nowMs) };
    }
    case "running": {
      const at = setupRevealAt(s);
      if (!seen && (!hasSetupWork(s) || at === null || at > nowMs)) return { kind: "none" };
      const lines = setupLines(s, nowMs).filter((l) => l.endedAtMs === null || (at !== null && l.endedAtMs >= at) || l.status === "warning" || shown.has(l.key));
      return { kind: "live", elapsed: s.startedAtMs === null ? "" : wholeSeconds(nowMs - s.startedAtMs), lines };
    }
  }
}

/** The step a running setup is on, for the sidebar row's third line ("Fetching origin/main"); "" when nothing is left. */
export function setupCurrentStep(s: ThreadSetupView): string {
  const st = s.steps.find((x) => x.status === "running") ?? s.steps.find((x) => x.status === "pending");
  return st ? setupLabelText(stepWords({ ...st, status: "running" }, 0)) : "";
}

/** Why a setup failed, in a line: its first failed step's ("Could not create the worktree"), else the first line of its error. */
export function setupFailure(s: ThreadSetupView): string {
  const st = s.steps.find((x) => x.status === "failed");
  if (st) return setupLabelText(stepWords(st, 0));
  return s.error === SETUP_RESTARTED ? RESTARTED_TITLE : (s.error.split("\n")[0] ?? "");
}

/** The composer's note on a setup that did not finish (components/thread/SetupNote.tsx); null otherwise, and while one runs. */
export function setupNoteLine(s: ThreadSetupView | null | undefined): string | null {
  if (s?.phase === "cancelled") return "Setup cancelled, so your message was not sent.";
  if (s?.phase === "failed") return `${setupFailure(s) || "Setup failed"}, so your message was not sent.`;
  return null;
}
