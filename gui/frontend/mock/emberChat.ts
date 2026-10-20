/**
 * Ember's chat in the mock (docs/notes/ember-3-gui.md): what the resident thread
 * s-resident-ember has said, matching the seeded board (mock/ember.ts). The user asked for
 * the 0.20 release notes and a wails bump; Ember planned (a run of work: the board, two
 * reads, two threads created, the board updated), replied with both task links, was woken
 * by the blocked wails worker, read it and said so, then took a follow-up as a subtask.
 * Three runs of work for the fold rows, three task links, one wake.
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

/** The wake the blocked wails worker sent (thread.new --notify). */
function wailsWake(at: Date): { title: string; json: string } {
  const payload = {
    kind: "thread",
    subscription_id: "sub-ember-wails",
    condition: "settled",
    fired_at: at.toISOString(),
    thread: {
      id: "s-ember-wails",
      name: "Bump wails to v3.1",
      state: "disconnected",
      status: "needs_attention",
      status_reason: "finished",
      project_id: "repo-cf",
      created_by: "s-resident-ember",
      labels: ["ember", "t-9c0d1e2f"],
      report: { status: "blocked", summary: "wails v3.1 needs Go 1.27; the toolchain here is 1.26", at: at.toISOString() },
    },
  };
  return { title: 'Thread "Bump wails to v3.1" (s-ember-wails) is idle: finished. Report: blocked — wails v3.1 needs Go 1.27; the toolchain here is 1.26.', json: JSON.stringify(payload, null, 2) };
}

export function scriptEmberChat(s: EmberChatScript, now = Date.now()): void {
  const ago = (min: number, sec = 0) => new Date(now - min * 60_000 + sec * 1000);
  const bash = (command: string, output: string, at: Date, secs = 2) => s.tool("Bash", { command }, { output }, { at, until: new Date(at.getTime() + secs * 1000) });
  const end = (at: Date, ms: number) =>
    s.it({ case: "turnEnd", value: { subtype: "success", durationMs: BigInt(ms), numTurns: 6, costUsd: 0.42, turnCostUsd: 0.18, stopReason: "end_turn", model: "claude-opus-4-8" } }, { at });

  // 1. The ask, the plan, the reply with both task links.
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
  bash('code-foundry ember task add "Add release notes for 0.20" --detail "Write docs/release-notes/0.20.md from the PRs merged since v0.19.1."', "t-1a2b3c4d", ago(90, 20));
  bash(
    'code-foundry thread new --project code-foundry --new-worktree --labels ember,t-1a2b3c4d --notify --brief "Write docs/release-notes/0.20.md from the PRs merged since v0.19.1" "Write the 0.20 release notes"',
    "created thread Release notes for 0.20 (s-ember-notes)",
    ago(90, 28),
    6,
  );
  bash("code-foundry ember task update t-1a2b3c4d --thread s-ember-notes --state doing", "t-1a2b3c4d doing", ago(90, 40));
  bash('code-foundry ember task add "Bump wails to v3.1"', "t-9c0d1e2f", ago(90, 46));
  bash(
    'code-foundry thread new --project code-foundry --new-worktree --labels ember,t-9c0d1e2f --notify --brief "Bump wails to v3.1 and fix what breaks" "Bump wails to v3.1"',
    "created thread Bump wails to v3.1 (s-ember-wails)",
    ago(90, 52),
    6,
  );
  bash("code-foundry ember task update t-9c0d1e2f --thread s-ember-wails --state doing", "t-9c0d1e2f doing", ago(89, 10));
  s.it(
    {
      case: "assistantText",
      value: {
        text: "On it. Two pieces, each in its own thread: the release notes on Opus 4.7 and the wails bump on Opus 4.8. They don't touch the same files, so they run side by side.\n\n[Add release notes for 0.20](cf-task://t-1a2b3c4d)\n[Bump wails to v3.1](cf-task://t-9c0d1e2f)\n\nI'll tell you when the notes are up, or sooner if either gets stuck.",
      },
    },
    { at: ago(89, 16) },
  );
  end(ago(89, 18), 78_000);

  // 2. The wails worker is blocked: a wake, a read, a short reply.
  const woke = ago(40);
  const wake = wailsWake(woke);
  s.it({ case: "userMessage", value: { text: `[code-foundry wake] ${wake.title}\n\`\`\`json\n${wake.json}\n\`\`\``, attachments: [], origin: MessageOrigin.WAKE, wakeTitle: wake.title, wakeJson: wake.json } }, { at: woke });
  bash("code-foundry thread read --id s-ember-wails --last 1", "Blocked: wails v3.1 requires go 1.27 (go.mod: go 1.26).", ago(40, 6), 3);
  bash("code-foundry ember board", "# Task board\n\n## Blocked\n\n- t-9c0d1e2f Bump wails to v3.1 …", ago(40, 12));
  s.it(
    {
      case: "assistantText",
      value: {
        text: "The wails bump is blocked: v3.1 needs Go 1.27 and the toolchain here is 1.26. I've left it on the board as blocked. Wait for the toolchain, or pin wails at 3.0 for now?\n\n[Bump wails to v3.1](cf-task://t-9c0d1e2f)",
      },
    },
    { at: ago(40, 40) },
  );
  end(ago(40, 41), 41_000);

  // 3. A follow-up, taken as a piece of the notes.
  s.it({ case: "userMessage", value: { text: "Leave wails for now. And link each release note to its PR.", attachments: [] } }, { at: ago(30) });
  bash('code-foundry ember task add "Link each note to its PR" --parent t-1a2b3c4d', "t-5e6f7a8b", ago(30, 8));
  s.it(
    {
      case: "assistantText",
      value: {
        text: "Added as a piece of the release notes. The notes thread picks it up once its draft is done, so the two don't fight over the same file.\n\n[Add release notes for 0.20](cf-task://t-1a2b3c4d)",
      },
    },
    { at: ago(30, 14) },
  );
  end(ago(30, 15), 15_000);
}
