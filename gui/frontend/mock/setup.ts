/**
 * Thread.setup for the mock (docs/notes/instant-threads-3-gui.md): POST
 * /__mock/thread/setup?id=…&state=… puts a thread where the daemon's setup would have it.
 * Each state is a script: the steps, relative to now, and what the row reads then. Adding
 * one is adding an entry to SETUP_SCRIPTS; World.scriptSetup applies it.
 *
 * The composer's side (docs/notes/instant-threads-4-composer.md): POST
 * /__mock/thread-setup?state=… makes the next thread.new with background-setup stop in that
 * state, and thread.setup.retry, .cancel and .discard (World's next to scriptSetup) move a
 * thread on as the daemon would. thread.send holds a message while a setup has not finished.
 * A setup with no state scripted ends before the thread is seen, as a fast one does.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ThreadSetupPhase, ThreadSetupStepKind, ThreadSetupStepStatus, ThreadState, ThreadStatus, type ThreadSetupSchema, type ThreadSetupStepSchema } from "../src/gen/codefoundry/v1/thread_lifecycle_pb";
import { CommandError } from "./errors";

type SetupInit = MessageInitShape<typeof ThreadSetupSchema>;
type StepInit = MessageInitShape<typeof ThreadSetupStepSchema>;

/** The branch the scripts name. */
export const SETUP_BRANCH = "cf/fix-stale-pr-badge";
/** Git's text of the failed scripts. */
export const SETUP_GIT_ERROR = "fatal: cannot lock ref 'refs/heads/cf/fix-stale-pr-badge': 'refs/heads/cf' exists; cannot create 'refs/heads/cf/fix-stale-pr-badge'";
/** The first message of a thread put in a setup. */
export const SETUP_PROMPT = "The PR badge in the sidebar stays green after a force-push. Fix it and keep the fingerprint check-count based.";

const { NAME, FETCH, WORKTREE, START } = ThreadSetupStepKind;
const { PENDING, RUNNING, DONE, WARNING, FAILED } = ThreadSetupStepStatus;

/** A message a setup holds, as thread.send and thread.new take it (DiscardThreadSetupResponse's first and queued). */
export interface SetupMessage {
  text: string;
  attachments: string[];
  composerText: string;
}

/** What a setup keeps to undo a send: the composer's snapshot and the messages, on the mock's thread. */
export interface SetupHold {
  draftJson: string;
  first: SetupMessage | null;
  queued: SetupMessage[];
}

/** A step as a script writes it: started and ended are ms before now, unset when it has not. */
type ScriptStep = Omit<StepInit, "startedAt" | "endedAt" | "refAt"> & { started?: number; ended?: number; refAgo?: number };

interface SetupScript {
  phase: ThreadSetupPhase;
  /** Ms before now the setup started, and ended. */
  started: number;
  ended?: number;
  steps: ScriptStep[];
  error?: string;
  /** Whether a worktree landed: the thread has its cwd again (a setup done, or failed after placing). */
  placed?: boolean;
}

const cf = { projectId: "repo-cf", projectName: "code-foundry" };
const gp = { projectId: "repo-gp", projectName: "ghostty-playground" };
const dot = { projectId: "repo-dot", projectName: "dotfiles" };
const REF = "origin/main";

const named = { kind: NAME, branch: SETUP_BRANCH, status: DONE, started: 3000, ended: 1800 };
const allDone: ScriptStep[] = [
  { kind: NAME, branch: SETUP_BRANCH, status: DONE, started: 6800, ended: 5600 },
  { kind: FETCH, ...cf, ref: REF, status: DONE, started: 6800, ended: 3400 },
  { kind: WORKTREE, ...cf, branch: SETUP_BRANCH, ref: REF, status: DONE, started: 3400, ended: 1000 },
  { kind: START, status: DONE, started: 1000, ended: 0 },
];

export const SETUP_SCRIPTS: Readonly<Record<string, SetupScript>> = {
  // The name done, the fetch running: A-loading.
  running: {
    phase: ThreadSetupPhase.RUNNING,
    started: 3000,
    steps: [named, { kind: FETCH, ...cf, ref: REF, status: RUNNING, started: 3000 }, { kind: WORKTREE, ...cf, status: PENDING }, { kind: START, status: PENDING }],
  },
  // Just started: nothing shows until a step has run 300ms.
  fresh: {
    phase: ThreadSetupPhase.RUNNING,
    started: 0,
    steps: [{ kind: NAME, status: RUNNING, started: 0 }, { kind: FETCH, ...cf, ref: REF, status: RUNNING, started: 0 }, { kind: WORKTREE, ...cf, status: PENDING }, { kind: START, status: PENDING }],
  },
  // The fetch could not reach origin; the setup goes on: A-warn.
  warn: {
    phase: ThreadSetupPhase.RUNNING,
    started: 21_000,
    steps: [
      { kind: NAME, branch: SETUP_BRANCH, status: DONE, started: 21_000, ended: 19_800 },
      { kind: FETCH, ...cf, ref: REF, status: WARNING, started: 21_000, ended: 1000, warning: "Could not reach origin", error: "fatal: unable to access origin", refAgo: 2 * 3_600_000 + 60_000 },
      { kind: WORKTREE, ...cf, branch: SETUP_BRANCH, status: RUNNING, started: 1000 },
      { kind: START, status: PENDING },
    ],
  },
  // Three projects, each on its own step: A-multi.
  multi: {
    phase: ThreadSetupPhase.RUNNING,
    started: 4000,
    steps: [
      { kind: NAME, branch: SETUP_BRANCH, status: DONE, started: 4000, ended: 2800 },
      { kind: FETCH, ...gp, ref: REF, status: DONE, started: 4000, ended: 2800 },
      { kind: FETCH, ...cf, ref: REF, status: DONE, started: 4000, ended: 1000 },
      { kind: FETCH, ...dot, ref: REF, status: RUNNING, started: 4000 },
      { kind: WORKTREE, ...gp, branch: SETUP_BRANCH, ref: REF, status: DONE, started: 2800, ended: 1900 },
      { kind: WORKTREE, ...cf, branch: SETUP_BRANCH, status: RUNNING, started: 1000 },
      { kind: WORKTREE, ...dot, branch: SETUP_BRANCH, status: PENDING },
      { kind: START, status: PENDING },
    ],
  },
  // The worktree step failed: A-failed.
  failed: {
    phase: ThreadSetupPhase.FAILED,
    started: 5000,
    ended: 0,
    error: SETUP_GIT_ERROR,
    steps: [
      { kind: NAME, branch: SETUP_BRANCH, status: DONE, started: 5000, ended: 3800 },
      { kind: FETCH, ...cf, ref: REF, status: DONE, started: 3800, ended: 400 },
      { kind: WORKTREE, ...cf, branch: SETUP_BRANCH, status: FAILED, started: 300, ended: 0, error: SETUP_GIT_ERROR },
      { kind: START, status: PENDING },
    ],
  },
  // The user stopped it after 4s: A-cancelled. What was under way is pending again.
  cancelled: {
    phase: ThreadSetupPhase.CANCELLED,
    started: 4000,
    ended: 0,
    steps: [{ ...named, started: 4000, ended: 2800 }, { kind: FETCH, ...cf, ref: REF, status: PENDING }, { kind: WORKTREE, ...cf, status: PENDING }, { kind: START, status: PENDING }],
  },
  // Spawn's commit: Claude runs in the worktree. A-done.
  done: { phase: ThreadSetupPhase.DONE, started: 6800, ended: 0, steps: allDone, placed: true },
  // Done with a stale base: the fold line keeps saying so.
  "done-warn": {
    phase: ThreadSetupPhase.DONE,
    started: 6800,
    ended: 0,
    placed: true,
    steps: allDone.map((st) =>
      st.kind === FETCH ? { ...st, status: WARNING, warning: "Could not reach origin", error: "fatal: unable to access origin", refAgo: 2 * 3_600_000 + 60_000 } : st,
    ),
  },
  // Nothing to make: only Claude's start, which shows nothing and leaves no fold line.
  "start-only": { phase: ThreadSetupPhase.DONE, started: 400, ended: 0, steps: [{ kind: START, status: DONE, started: 400, ended: 0 }], placed: true },
};

/** A script as Thread.setup, its times taken from `now`. */
export function setupMessage(script: SetupScript, now: Date): SetupInit {
  const at = (field: string, ago: number | undefined) => (ago === undefined ? {} : { [field]: timestampFromDate(new Date(now.getTime() - ago)) });
  return {
    phase: script.phase,
    ...at("startedAt", script.started),
    ...at("endedAt", script.ended),
    error: script.error ?? "",
    background: true,
    steps: script.steps.map(({ started, ended, refAgo, ...st }) => ({ ...st, ...at("startedAt", started), ...at("endedAt", ended), ...at("refAt", refAgo) }) as StepInit),
  };
}

/** The script of a state; POST /__mock/thread/setup's refusal otherwise. */
export function setupScript(state: string): SetupScript {
  const script = SETUP_SCRIPTS[state];
  if (!script) throw new CommandError("invalid", `state must be one of ${Object.keys(SETUP_SCRIPTS).join(", ")}`);
  return script;
}

/** A setup that failed or was cancelled: what Try again and Edit act on. */
export function isSetupStopped(phase: ThreadSetupPhase | undefined): boolean {
  return phase === ThreadSetupPhase.FAILED || phase === ThreadSetupPhase.CANCELLED;
}

/** Where the row stands in a phase, as the daemon leaves it (internal/store/thread/setup.go). */
export function setupRowState(phase: ThreadSetupPhase): { state: ThreadState; status: ThreadStatus; reason: string } {
  switch (phase) {
    case ThreadSetupPhase.FAILED:
      return { state: ThreadState.DISCONNECTED, status: ThreadStatus.ERROR, reason: "setup failed" };
    case ThreadSetupPhase.CANCELLED:
      return { state: ThreadState.DISCONNECTED, status: ThreadStatus.IDLE, reason: "setup cancelled" };
    case ThreadSetupPhase.DONE:
      return { state: ThreadState.CONNECTED, status: ThreadStatus.BUSY, reason: "working" };
    default:
      return { state: ThreadState.STARTING, status: ThreadStatus.BUSY, reason: "setting up" };
  }
}
