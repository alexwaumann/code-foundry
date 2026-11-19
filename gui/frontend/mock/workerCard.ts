/**
 * A lead with three workers (docs/notes/worker-card.md), for the worker card: the lead
 * s-wl-lead "Ship the three fixes" started W1..W3 in the user's turn, and each wake since
 * is a turn of its own, which the timeline reads as one card with the replies stacked
 * under it. POST /__mock/workers?state=… (World.addWorkerCard), and
 * POST /__mock/workers/step (World.stepWorkerCard): the working worker finishes now and
 * the lead's turn for it lands, so the card updates in place.
 *
 * States:
 * - live: W1 and W2 finished and merged (two replies under the card), W3 working; between
 *   them a turn with nothing for the user (W3 asked, the lead answered it and ended with
 *   only "[nothing new]").
 * - needs: as live, but W3 waits on the user's permission in its own thread.
 * - frozen: as live, then the user stepped in ("Hold the code block one…"): the first card
 *   froze and folded; W3 carried over into a new card under that turn, where it finished.
 * - passup: as live, but W2 still works: it asked whether the body of a collapsed pane drags
 *   too, and the lead passed the question up to the user (mock/passUp.ts), so the lead is in
 *   Needs you with it and W2's line reads "asks you" (docs/notes/pass-up-question.md).
 * - passup-working: as passup, but the lead works on after passing it up (its turn is still
 *   running: a reply streaming), so it is in Needs you and working
 *   (Thread.busy_under_pass_up); thread.interrupt stops it and leaves the question open.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { MessageOrigin, ToolCallStatus, type ThreadItemSchema } from "../src/gen/codefoundry/v1/thread_pb";
import { passUpItem, PASSUP_REQUEST } from "./passUp";

type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type Over = Partial<ItemInit> & { at?: Date; until?: Date };

export type WorkerCardState = "live" | "needs" | "frozen" | "passup" | "passup-working";
export const WORKER_CARD_STATES: readonly WorkerCardState[] = ["live", "needs", "frozen", "passup", "passup-working"];

/** The scenarios with W2's question passed up to the user. */
export const passedUp = (state: WorkerCardState): boolean => state === "passup" || state === "passup-working";

export const LEAD = "s-wl-lead";
/** The workers in spawn order: id, name. */
export const WORKERS = [
  { id: "s-wl-1", name: "PR row project name" },
  { id: "s-wl-2", name: "Resize across collapsed panes" },
  { id: "s-wl-3", name: "Code block header" },
] as const;

/** What the script needs from MockThreadLogs. */
export interface WorkerCardScript {
  it(payload: ItemInit["payload"], over?: Over): ItemInit;
  tool(name: string, input: object, value: { output?: string; status?: ToolCallStatus }, over?: Over): ItemInit;
}

/** A worker's state as World.addWorkerCard sets it: done (finished at `at`), working (since `at`), needs (a permission since `at`). */
export interface WorkerPlan {
  id: string;
  name: string;
  createdMin: number;
  state: "done" | "working" | "needs";
  atMin: number;
}

/** The user's first message was this many minutes ago. */
const START = 26;

/** The workers' states for a scenario. */
export function workerPlans(state: WorkerCardState): WorkerPlan[] {
  const [w1, w2, w3] = WORKERS;
  return [
    { ...w1, createdMin: START - 0.5, state: "done", atMin: 17 },
    { ...w2, createdMin: START - 0.5, state: passedUp(state) ? "working" : "done", atMin: passedUp(state) ? START - 0.5 : 11 },
    { ...w3, createdMin: START - 0.5, state: state === "frozen" ? "done" : state === "needs" ? "needs" : "working", atMin: state === "frozen" ? 2 : state === "needs" ? 1 : START - 0.5 },
  ];
}

const ago = (min: number) => new Date(Date.now() - min * 60_000);

/** A thread wake from one worker, as the daemon writes it (internal/store/thread/subscriptions_fire.go). */
export function workerWake(w: { id: string; name: string }, at: Date, status: { status: string; reason: string }, lastMessage: string): { title: string; json: string } {
  const payload = {
    kind: "thread",
    subscription_id: `sub-${w.id}`,
    condition: "settled",
    fired_at: at.toISOString(),
    thread: { id: w.id, name: w.name, state: "connected", status: status.status, status_reason: status.reason, project_id: "repo-cf", created_by: LEAD, labels: [], last_message: lastMessage },
  };
  const said = status.reason === "finished" ? "is idle: finished." : `needs attention: ${status.reason}.`;
  return { title: `Thread "${w.name}" (${w.id}) ${said}`, json: JSON.stringify(payload, null, 2) };
}

/** A worker's `thread ask`. */
function askWake(w: { id: string; name: string }, at: Date, question: string, assuming = "only the header"): { title: string; json: string } {
  const payload = { kind: "ask", thread: w.id, name: w.name, question, assuming, asked_at: at.toISOString() };
  return { title: `Thread "${w.name}" (${w.id}) asks you something and keeps working: ${question}`, json: JSON.stringify(payload, null, 2) };
}

export function wakeItem(w: { title: string; json: string }): ItemInit["payload"] {
  return { case: "userMessage", value: { text: `[code-foundry wake] ${w.title}`, attachments: [], origin: MessageOrigin.WAKE, wakeTitle: w.title, wakeJson: w.json } };
}

const FINISHED = { status: "needs_attention", reason: "finished" };

/** A turn end `secs` long at `at`. */
function end(s: WorkerCardScript, at: Date, secs: number, cost: number): void {
  s.it({ case: "turnEnd", value: { subtype: "success", durationMs: BigInt(secs * 1000), numTurns: 3, costUsd: cost, turnCostUsd: cost, model: "claude-sonnet-5-5", stopReason: "end_turn" } }, { at });
}

/** The lead's log for a scenario. */
export function scriptLead(s: WorkerCardScript, state: WorkerCardState): void {
  const [w1, w2, w3] = WORKERS;
  const bash = (command: string, output: string, at: Date) => s.tool("Bash", { command }, { output }, { at, until: new Date(at.getTime() + 1500) });
  const sec = (min: number, plus: number) => new Date(ago(min).getTime() + plus * 1000);

  // The user's turn: three workers made.
  s.it({ case: "userMessage", value: { text: "Get the workers going on the three fixes: the PR row's project name, resizing across collapsed panes, and the code block header.", attachments: [] } }, { at: ago(START) });
  for (const [i, w] of WORKERS.entries()) {
    bash(`code-foundry thread new --notify --name "${w.name}" --prompt "…"`, `created thread ${w.name} (${w.id})`, sec(START, 20 + i * 4));
  }
  s.it({ case: "assistantText", value: { text: "Three workers are running, one per fix. I'll review and merge each as it reports." } }, { at: sec(START, 40) });
  end(s, sec(START, 41), 41, 0.42);

  // W1 finished: merged.
  s.it(wakeItem(workerWake(w1, ago(17), FINISHED, "Opened #797: the PR row shows the project's name.")), { at: ago(17) });
  bash("gh pr view 797 --json reviews,statusCheckRollup", '{"statusCheckRollup":[{"state":"SUCCESS"}]}', sec(17, 6));
  bash("gh pr merge 797 --merge", "✓ Merged pull request #797", sec(17, 20));
  s.it({ case: "assistantText", value: { text: "#797 is merged: the PR row shows the project's name." } }, { at: sec(17, 30) });
  end(s, sec(17, 31), 31, 0.18);

  // W3 asked; the lead answered it: nothing for the user.
  s.it(wakeItem(askWake(w3, ago(14), "Should the header show the language too, or only the file name?")), { at: ago(14) });
  bash(`code-foundry thread send --id ${w3.id} "Only the file name; the language is in the gutter."`, `sent to thread ${w3.id}`, sec(14, 5));
  // Claude Code asks again after a turn with no visible text: the daemon's marker (lib/workerRuns NOTHING_NEW).
  s.it({ case: "assistantText", value: { text: "[nothing new]" } }, { at: sec(14, 8) });
  end(s, sec(14, 9), 9, 0.04);

  if (passedUp(state)) {
    // W2 asked; the lead could not say what the user wants, so it passed the question up and works on.
    s.it(wakeItem(askWake(w2, ago(3), "Should the body of a collapsed pane also drag, or only the gutters?", "only the gutters")), { at: ago(3) });
    bash(`code-foundry thread pass-up ${w2.id}`, `passed thread ${w2.name} (${w2.id})'s question up to the user; keep working.`, sec(3, 6));
    // The daemon writes the question into the running turn, after the tool call that passed it up.
    s.it(passUpItem(), { id: `q-${PASSUP_REQUEST}`, at: sec(3, 7) });
    if (state === "passup-working") {
      // It works on: W3's PR is ready, so it checks it while the user decides, and is replying now
      // (POST /__mock/thread/delta?id=s-wl-lead streams more of it).
      s.it({ case: "assistantText", value: { text: "While you decide on the collapsed panes, I'll check the code block PR." } }, { at: sec(3, 12) });
      bash("gh pr checks 801", "All checks were successful", sec(1, 0));
      s.it({ case: "assistantText", value: { text: "#801's checks pass. Reading its diff" } }, { at: sec(0, -5), streaming: true });
      return;
    }
    s.it({ case: "assistantText", value: { text: "[nothing new]" } }, { at: sec(3, 9) });
    end(s, sec(3, 10), 10, 0.04);
    return;
  }

  // W2 finished: merged.
  s.it(wakeItem(workerWake(w2, ago(11), FINISHED, "Opened #798: every gutter in the run drags.")), { at: ago(11) });
  bash("gh pr merge 798 --merge", "✓ Merged pull request #798", sec(11, 18));
  s.it({ case: "assistantText", value: { text: "#798 is merged: every gutter between collapsed panes drags now." } }, { at: sec(11, 25) });
  end(s, sec(11, 26), 26, 0.21);

  if (state === "needs") {
    s.it(wakeItem(workerWake(w3, ago(1), { status: "needs_attention", reason: "permission: Bash rm -rf dist" }, "")), { at: ago(1) });
    s.it({ case: "assistantText", value: { text: "The code block worker wants to run `rm -rf dist` in its checkout: that is yours to allow, in its thread." } }, { at: sec(1, 8) });
    end(s, sec(1, 9), 9, 0.05);
    return;
  }
  if (state !== "frozen") return;

  // The user steps in: the card freezes; W3 carries over.
  s.it({ case: "userMessage", value: { text: "Hold the code block one, I want to look at it before it merges.", attachments: [] } }, { at: ago(5) });
  s.it({ case: "assistantText", value: { text: "Understood: I won't merge the code block PR until you say so." } }, { at: sec(5, 6) });
  end(s, sec(5, 7), 7, 0.03);
  s.it(wakeItem(workerWake(w3, ago(2), FINISHED, "Opened #801: the header shows the file name.")), { at: ago(2) });
  bash("gh pr checks 801", "All checks were successful", sec(2, 10));
  s.it({ case: "assistantText", value: { text: "#801 is ready and waiting for you: its checks pass and I have not merged it." } }, { at: sec(2, 20) });
  end(s, sec(2, 21), 21, 0.09);
}

/** The step after "live": W3 finished now and the lead's turn for it (World.stepWorkerCard). */
export function scriptStep(s: WorkerCardScript): void {
  const w3 = WORKERS[2];
  const now = Date.now();
  s.it(wakeItem(workerWake(w3, new Date(now), FINISHED, "Opened #801: the header shows the file name.")), { at: new Date(now) });
  s.tool("Bash", { command: "gh pr merge 801 --merge" }, { output: "✓ Merged pull request #801" }, { at: new Date(now + 1000), until: new Date(now + 2000) });
  s.it({ case: "assistantText", value: { text: "#801 is merged. All three fixes are in: #797, #798 and #801." } }, { at: new Date(now + 3000) });
  end(s, new Date(now + 4000), 4, 0.07);
}
