/**
 * Ember's chat in the mock (docs/notes/ember-3-gui.md, ember-fixes-2-gui.md): what the
 * resident thread s-resident-ember has said, matching the seeded board (mock/ember.ts).
 *
 * 0. The user asked for the flaky test; Ember started a worker (`ember task start`) and
 *    linked the task by an older title; the worker's wake, a branch check (`git -C $W …`)
 *    and `ember task done --branch`, a reply.
 * 1. The 0.20 release notes and a wails bump: the board, two reads, a note between tool
 *    calls (folded into the run: only a turn's last text is the reply), two workers started
 *    in one Bash call (prompts in heredocs), a reply with both task links.
 * 2. A wake from the blocked wails worker, a read, a short reply.
 * 3. A follow-up taken as a piece of the notes, the change sent to the notes worker.
 * 4. A progress wake from the notes API lead that Ember only thought about, then replied to
 *    (its row says what woke it), with paths: an absolute one under the code-foundry
 *    checkout (a chip), a relative one and a git range (plain code).
 * 5. A timer with a note, a reply with no tool.
 *
 * Seven runs of work, seven task links, four wakes. POST /__mock/ember/restart adds a turn
 * the app's restart cuts (scriptEmberRestartCut) and the restart notice's wake after it
 * (scriptEmberRestartWake).
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { MessageOrigin, ToolCallStatus, type ThreadItemSchema } from "../src/gen/codefoundry/v1/thread_pb";

type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type Over = Partial<ItemInit> & { at?: Date; until?: Date };

/** What the script needs from MockThreadLogs. */
export interface EmberChatScript {
  it(payload: ItemInit["payload"], over?: Over): ItemInit;
  tool(name: string, input: object, value: { output?: string; status?: ToolCallStatus }, over?: Over): ItemInit;
}

const CF = "/Users/alex/projects/code-foundry";
/** The mock's code-foundry checkout (mock/world.ts), where the File tab finds README.md. */
const HOME_CF = "/Users/dev/src/code-foundry";

/** A thread wake (thread.new --notify, or ember task start's subscription). */
function threadWake(at: Date, o: { id: string; name: string; task: string; report: { status: string; summary: string }; title: string }): { title: string; json: string } {
  const payload = {
    kind: "thread",
    subscription_id: `sub-${o.id}`,
    condition: "settled",
    fired_at: at.toISOString(),
    thread: {
      id: o.id,
      name: o.name,
      state: "disconnected",
      status: "needs_attention",
      status_reason: "finished",
      project_id: "repo-cf",
      created_by: "s-resident-ember",
      labels: ["ember", o.task],
      report: { ...o.report, at: at.toISOString() },
    },
  };
  return { title: o.title, json: JSON.stringify(payload, null, 2) };
}

/** A timer of Ember's firing (thread subscribe --at, with its note). */
function timerWake(at: Date, note: string): { title: string; json: string } {
  const payload = { kind: "timer", subscription_id: "sub-ember-timer", condition: "fired", fired_at: at.toISOString(), due_at: at.toISOString(), at: at.toISOString(), note };
  return { title: `Timer sub-ember-timer fired (${note}).`, json: JSON.stringify(payload, null, 2) };
}

/** The wake message of a wake, as the daemon writes it. */
function wakeMessage(s: EmberChatScript, w: { title: string; json: string }, at: Date): void {
  s.it({ case: "userMessage", value: { text: `[code-foundry wake] ${w.title}\n\`\`\`json\n${w.json}\n\`\`\``, attachments: [], origin: MessageOrigin.WAKE, wakeTitle: w.title, wakeJson: w.json } }, { at });
}

function helpers(s: EmberChatScript) {
  const bash = (command: string, output: string, at: Date, secs = 2) => s.tool("Bash", { command }, { output }, { at, until: new Date(at.getTime() + secs * 1000) });
  const end = (at: Date, ms: number) =>
    s.it({ case: "turnEnd", value: { subtype: "success", durationMs: BigInt(ms), numTurns: 6, costUsd: 0.42, turnCostUsd: 0.18, stopReason: "end_turn", model: "claude-opus-4-8" } }, { at });
  const text = (t: string, at: Date) => s.it({ case: "assistantText", value: { text: t } }, { at });
  return { bash, end, text };
}

export function scriptEmberChat(s: EmberChatScript, now = Date.now()): void {
  const ago = (min: number, sec = 0) => new Date(now - min * 60_000 + sec * 1000);
  const { bash, end, text } = helpers(s);

  // 0. The flaky test: a worker started, its wake, a branch check, the task closed with its branch.
  s.it({ case: "userMessage", value: { text: "TestSendSpawnFailure fails about one run in five under -race. Fix it.", attachments: [] } }, { at: ago(125) });
  bash(
    "code-foundry ember task start \"Fix the flaky TestSendSpawnFailure\" --project code-foundry --prompt - <<'EOF'\nMake TestSendSpawnFailure pass reliably under -race; find why it is flaky first.\nRun `go test -race -count=20 ./internal/store/thread/` before you report; never skip it.\nEOF",
    "t-3a4b5c6d doing: thread Fix flaky TestSendSpawnFailure (s-ember-flaky)",
    ago(125, 6),
    5,
  );
  // The link's text is the title Ember first gave the task; the board's is newer.
  text("Started a worker on it. It finds the cause before it changes anything.\n\n[Fix flaky TestSendSpawnFailure](cf-task://t-3a4b5c6d)", ago(125, 14));
  end(ago(125, 15), 15_000);
  const flakyAt = ago(121);
  wakeMessage(
    s,
    threadWake(flakyAt, {
      id: "s-ember-flaky",
      name: "Fix flaky TestSendSpawnFailure",
      task: "t-3a4b5c6d",
      report: { status: "done", summary: "Raised the spawn timeout to 5s under -race; PR #251 merged" },
      title: 'Thread "Fix flaky TestSendSpawnFailure" (s-ember-flaky) is idle: finished. Report: done — Raised the spawn timeout to 5s under -race; PR #251 merged.',
    }),
    flakyAt,
  );
  bash(
    `W=${HOME_CF}/.worktrees/spawn-timeout-race; git -C $W log --oneline -3 origin/cf/spawn-timeout-race; git -C $W diff origin/main...origin/cf/spawn-timeout-race --stat`,
    "a1b2c3d thread: 5s spawn timeout under -race\n internal/store/thread/stream_test.go | 4 ++--",
    ago(121, 5),
    3,
  );
  bash('code-foundry ember task done t-3a4b5c6d "Raised the spawn timeout to 5s under -race; PR #251 merged" --branch cf/spawn-timeout-race', "t-3a4b5c6d done", ago(121, 12));
  text(
    "The flaky test is fixed: the spawn timeout was too short under -race and is 5s there now. Twenty runs in a row pass on the branch, and PR #251 is merged.\n\n[Fix the flaky TestSendSpawnFailure](cf-task://t-3a4b5c6d)",
    ago(121, 20),
  );
  end(ago(121, 21), 21_000);

  // 1. The ask, the plan, two workers started in one call, the reply with both task links.
  s.it(
    {
      case: "userMessage",
      value: {
        text: "Write the release notes for 0.20 from the PRs merged since v0.19.1, and bump wails to v3.1 in its own thread.",
        attachments: [],
      },
    },
    { at: ago(90) },
  );
  bash("code-foundry ember board", "# Task board\n\nNothing in progress.", ago(90, 4));
  s.tool("Read", { file_path: `${CF}/docs/PLAN.md` }, { output: "# Plan\n…" }, { at: ago(90, 9), until: ago(90, 10) });
  s.tool("Read", { file_path: `${CF}/go.mod` }, { output: "module github.com/alexwaumann/code-foundry\n\ngo 1.26\n…" }, { at: ago(90, 12), until: ago(90, 13) });
  // Text between tool calls: work, folded into the run (only the turn's last text is the reply).
  text("The notes only touch docs/ and the bump only go.mod and the GUI, so both can start now.", ago(90, 15));
  bash(
    [
      "code-foundry ember task start \"Add release notes for 0.20\" --project code-foundry --model claude-opus-4-7[1m] --prompt - <<'EOF'",
      "Write docs/release-notes/0.20.md from the PRs merged since v0.19.1; one line per PR, grouped by area.",
      "EOF",
      "code-foundry ember task start \"Bump wails to v3.1\" --project code-foundry --model claude-opus-4-8[1m] --prompt - <<'EOF'",
      "Bump wails to v3.1 and fix what breaks; `make check` must pass with no new lint errors.",
      "EOF",
    ].join("\n"),
    "t-1a2b3c4d doing: thread Release notes for 0.20 (s-ember-notes)\nt-9c0d1e2f doing: thread Bump wails to v3.1 (s-ember-wails)",
    ago(90, 20),
    12,
  );
  text(
    "On it. Two pieces, each in its own thread: the release notes on Opus 4.7 and the wails bump on Opus 4.8. They don't touch the same files, so they run side by side.\n\n[Add release notes for 0.20](cf-task://t-1a2b3c4d)\n[Bump wails to v3.1](cf-task://t-9c0d1e2f)\n\nI'll tell you when the notes are up, or sooner if either gets stuck.",
    ago(89, 16),
  );
  end(ago(89, 18), 78_000);

  // 2. The wails worker is blocked: a wake, a read, a short reply.
  const woke = ago(40);
  wakeMessage(
    s,
    threadWake(woke, {
      id: "s-ember-wails",
      name: "Bump wails to v3.1",
      task: "t-9c0d1e2f",
      report: { status: "blocked", summary: "wails v3.1 needs Go 1.27; the toolchain here is 1.26" },
      title: 'Thread "Bump wails to v3.1" (s-ember-wails) is idle: finished. Report: blocked — wails v3.1 needs Go 1.27; the toolchain here is 1.26.',
    }),
    woke,
  );
  bash("code-foundry thread read --id s-ember-wails --last 1", "Blocked: wails v3.1 requires go 1.27 (go.mod: go 1.26).", ago(40, 6), 3);
  bash("code-foundry ember board", "# Task board\n\n## Blocked\n\n- t-9c0d1e2f Bump wails to v3.1 …", ago(40, 12));
  text(
    "The wails bump is blocked: v3.1 needs Go 1.27 and the toolchain here is 1.26. I've left it on the board as blocked. Wait for the toolchain, or pin wails at 3.0 for now?\n\n[Bump wails to v3.1](cf-task://t-9c0d1e2f)",
    ago(40, 40),
  );
  end(ago(40, 41), 41_000);

  // 3. A follow-up, taken as a piece of the notes and sent to the notes worker.
  s.it({ case: "userMessage", value: { text: "Leave wails for now. And link each release note to its PR.", attachments: [] } }, { at: ago(30) });
  bash('code-foundry ember task add "Link each note to its PR" --parent t-1a2b3c4d', "t-5e6f7a8b", ago(30, 8));
  bash("code-foundry thread send --id s-ember-notes - <<'EOF'\nOnce the draft is done, link each note to its PR (#N); keep one line per PR.\nEOF", "sent", ago(30, 10));
  text(
    "Added as a piece of the release notes. The notes thread picks it up once its draft is done, so the two don't fight over the same file.\n\n[Add release notes for 0.20](cf-task://t-1a2b3c4d)",
    ago(30, 14),
  );
  end(ago(30, 15), 15_000);

  // 4. The notes API lead reports progress: Ember only thinks, then says where things are.
  const leadAt = ago(3);
  const leadTitle = 'Thread "Lead: notes API input validation" (s-ember-lead) reported progress: Schema done; handlers in two threads.';
  s.it({ case: "userMessage", value: { text: `[code-foundry wake] ${leadTitle}`, attachments: [], origin: MessageOrigin.WAKE, wakeTitle: leadTitle, wakeJson: "{}" } }, { at: leadAt });
  s.it({ case: "thinking", value: { text: "Progress only; nothing to do but tell the user where it stands." } }, { at: ago(3, 2), until: ago(3, 6) });
  text(
    `The notes API team is under way: the schema is in, and two threads are on the handlers. The schema thread documented it in \`${HOME_CF}/README.md\` (each worktree's \`README.md\`); I'll compare \`main..cf/notes-validation\` once they report.\n\n[Validate notes API input](cf-task://t-4c5d6e7f)`,
    ago(3, 8),
  );
  end(ago(3, 9), 9_000);

  // 5. A timer Ember set, with its note: a reply and no tool.
  const timerAt = ago(1);
  wakeMessage(s, timerWake(timerAt, "check the notes draft"), timerAt);
  s.it({ case: "thinking", value: { text: "The notes worker is still drafting; say so." } }, { at: ago(1, 1), until: ago(1, 3) });
  text("Your check on the release notes: the worker is still drafting. I'll tell you when it reports.", ago(1, 4));
  end(ago(1, 5), 5_000);
}

/**
 * The app's restart cuts a turn of Ember's (POST /__mock/ember/restart?step=cut): the user
 * asked for more, Ember ran a command, and the daemon's shutdown ended the tool ("Interrupted:
 * the daemon stopped.") and the turn (process_ended, interrupted), as stream.go does.
 */
export function scriptEmberRestartCut(s: EmberChatScript, now = Date.now()): void {
  const at = (sec: number) => new Date(now - 30_000 + sec * 1000);
  s.it({ case: "userMessage", value: { text: "Actually, pin wails at 3.0 for now, on its own branch.", attachments: [] } }, { at: at(0) });
  s.it({ case: "thinking", value: { text: "A new piece: start a worker for the pin." } }, { at: at(2), until: at(4) });
  s.tool(
    "Bash",
    { command: "code-foundry ember task start \"Pin wails at 3.0\" --project code-foundry --prompt - <<'EOF'\nPin wails at v3.0.x in go.mod; make check must pass.\nEOF" },
    { output: "Interrupted: the daemon stopped.", status: ToolCallStatus.ERROR },
    { at: at(5), until: at(9) },
  );
  s.it({ case: "turnEnd", value: { subtype: "process_ended", interrupted: true, durationMs: BigInt(9_000) } }, { at: at(9) });
}

/** The restart notice wakes Ember (its own turn was cut) and it picks the request up (POST /__mock/ember/restart?step=wake). */
export function scriptEmberRestartWake(s: EmberChatScript, now = Date.now()): void {
  const at = (sec: number) => new Date(now - 10_000 + sec * 1000);
  const { bash, end, text } = helpers(s);
  const restarted = at(0);
  const title = "The app restarted; your own turn was interrupted. Its session resumes now.";
  const json = JSON.stringify({ kind: "restart", restarted_at: restarted.toISOString(), interrupted: [], subscriptions: 0, own_turn_interrupted: true }, null, 2);
  wakeMessage(s, { title, json }, restarted);
  bash("code-foundry ember board", "# Task board\n\n## Blocked\n\n- t-9c0d1e2f Bump wails to v3.1 …", at(2));
  bash(
    "code-foundry ember task start \"Pin wails at 3.0\" --project code-foundry --prompt - <<'EOF'\nPin wails at v3.0.x in go.mod; make check must pass.\nEOF",
    "t-6f7a8b9c doing: thread Pin wails at 3.0 (s-ember-pin)",
    at(4),
    4,
  );
  text("Picked up after the restart: a worker is pinning wails at 3.0 on its own branch.\n\n[Bump wails to v3.1](cf-task://t-9c0d1e2f)", at(9));
  end(at(10), 10_000);
}
