/**
 * Two lead threads talking (docs/notes/other-thread-lines.md), both sides: the sender
 * s-pl-a "Ship the release" told s-pl-c "Sidebar rail" something and asked s-pl-b "PR page
 * redesign" something; B's side shows A's messages as From rows and its own answers as
 * lines. POST /__mock/peers?state=… (World.addPeerLines) and POST /__mock/peers/step
 * (World.stepPeerLines: B's answer lands in A now, the line changes in place).
 *
 * States (each includes the one before):
 * - waiting: A's user turn told C and asked B; A waits. B works on the question.
 * - replied: B answered (a turn in A whose reply stacks under the line); B's line "answered".
 * - asked-back: B then asked A something, A answered (a second stacked reply; A's line
 *   "replied · then asked 1 question, answered"); B's own turn for it.
 * - workers: as waiting, but A also started a worker in its turn: the card, then the lines.
 * - frozen: as asked-back, then the user's next message in A froze both lines; A told B
 *   #798 is merged in the new run (a new line), which B's line counts ("then sent 1
 *   message"); then C told B something: a From row with no tag.
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ReplyMark, ThreadRelation, ToolCallStatus, type ThreadItemSchema, type ThreadMessageSentSchema } from "../src/gen/codefoundry/v1/thread_pb";

type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type SentInit = MessageInitShape<typeof ThreadMessageSentSchema>;
type Over = Partial<ItemInit> & { at?: Date; until?: Date };

export type PeerLinesState = "waiting" | "replied" | "asked-back" | "workers" | "frozen";
export const PEER_LINES_STATES: readonly PeerLinesState[] = ["waiting", "replied", "asked-back", "workers", "frozen"];

export const A = { id: "s-pl-a", name: "Ship the release" };
export const B = { id: "s-pl-b", name: "PR page redesign" };
export const C = { id: "s-pl-c", name: "Sidebar rail" };
export const W = { id: "s-pl-w", name: "Bump the changelog" };

/** The ids of the items the step updates or answers. */
export const ASK_NOTE = "pl-a-ask";
export const ANSWER = "pl-a-m1";

/** What the script needs from MockThreadLogs (as mock/workerCard's). */
export interface PeerScript {
  it(payload: ItemInit["payload"], over?: Over): ItemInit;
  tool(name: string, input: object, value: { output?: string; status?: ToolCallStatus }, over?: Over): ItemInit;
}

const ago = (min: number, now = Date.now()) => new Date(now - min * 60_000);
const quoted = (t: { id: string; name: string }) => `"${t.name}" (${t.id})`;
const rank = (s: PeerLinesState) => ({ waiting: 0, workers: 0, replied: 1, "asked-back": 2, frozen: 3 })[s];

function end(s: PeerScript, at: Date, secs: number): void {
  s.it({ case: "turnEnd", value: { subtype: "success", durationMs: BigInt(secs * 1000), numTurns: 2, costUsd: 0.03, turnCostUsd: 0.03, model: "claude-sonnet-5-5", stopReason: "end_turn" } }, { at });
}

/** A message `from` sent `to` (with its mark), as the receiver has it. */
function message(text: string, from: { id: string }, wanted: boolean): ItemInit["payload"] {
  return { case: "userMessage", value: { text, attachments: [], sentByThreadId: from.id, senderRelation: ThreadRelation.OTHER, reply: wanted ? ReplyMark.WANTED : ReplyMark.NONE } };
}

/** The sender's note for a message (internal/store/thread/replies.go sentText), with what became of it. */
export function sentNote(to: { id: string; name: string }, wanted: boolean, replyItemId = "", repliedAt?: Date): ItemInit["payload"] {
  const sent: SentInit = { toThreadId: to.id, toName: to.name, relation: ThreadRelation.OTHER, reply: wanted ? ReplyMark.WANTED : ReplyMark.NONE, itemId: `${to.id}-u`, ordinal: 1n };
  if (replyItemId) Object.assign(sent, { replyItemId, repliedAt: timestampFromDate(repliedAt ?? new Date()) });
  const text = wanted ? `Asked ${quoted(to)} · ${replyItemId ? "replied" : "waiting for a reply"}` : `Told ${quoted(to)} · no reply needed`;
  return { case: "note", value: { text, createdBy: "", sent } };
}

/** A thread send from a thread's Bash, and its note. */
function send(s: PeerScript, to: { id: string; name: string }, wanted: boolean, text: string, at: Date, note: { id?: string; replyItemId?: string; repliedAt?: Date } = {}): void {
  s.tool("Bash", { command: `code-foundry thread send --id ${to.id} --reply ${wanted ? "wanted" : "none"} "${text}"` }, { output: `sent to thread ${to.id}` }, { at, until: new Date(at.getTime() + 800) });
  s.it(sentNote(to, wanted, note.replyItemId ?? "", note.repliedAt), { at: new Date(at.getTime() + 1000), ...(note.id ? { id: note.id } : {}) });
}

const ASK_TEXT = "Does your branch still touch shell/resize.ts? #798 changes it.";
const ANSWER_TEXT = "No: my branch dropped its resize.ts change last week, so #798 does not need to wait for me.";
const BACK_TEXT = "Did #798 change gutterReach's signature? My rebase fails in shell/resize.test.ts.";
const BACK_ANSWER = "Yes: gutterReach now takes the pair of panes, not an index. Pass both neighbours.";
const MERGED = "#798 is merged; rebase on main when you're ready.";

/** A's log (the sender). */
export function scriptSender(s: PeerScript, state: PeerLinesState): void {
  const n = rank(state);
  s.it({ case: "userMessage", value: { text: "Tell the sidebar thread to rebase after #798, and ask the PR page thread whether its branch still touches resize.ts.", attachments: [] } }, { at: ago(26) });
  if (state === "workers") {
    s.tool("Bash", { command: `code-foundry thread new --notify --name "${W.name}" --prompt "…"` }, { output: `created thread ${W.name} (${W.id})` }, { at: ago(25.9) });
  }
  send(s, C, false, "Rebase after #798 merges: it moves the gutter helpers.", ago(25.8));
  send(s, B, true, ASK_TEXT, ago(25.7), n >= 1 ? { id: ASK_NOTE, replyItemId: ANSWER, repliedAt: ago(22) } : { id: ASK_NOTE });
  s.it({ case: "assistantText", value: { text: "Told the sidebar thread to rebase after #798, and asked the PR page thread whether its branch still touches resize.ts." } }, { at: ago(25.6) });
  end(s, ago(25.5), 30);
  if (n < 1) return;

  s.it(message(ANSWER_TEXT, B, false), { at: ago(22), id: ANSWER });
  s.it({ case: "assistantText", value: { text: "The PR page thread says it no longer touches resize.ts, so #798 can merge without waiting on it." } }, { at: ago(21.9) });
  end(s, ago(21.8), 8);
  if (n < 2) return;

  s.it(message(BACK_TEXT, B, true), { at: ago(15) });
  s.tool("Bash", { command: "git show 798 -- internal/shell/resize.go | head -40" }, { output: "func gutterReach(a, b *Pane) int {" }, { at: ago(14.9), until: ago(14.8) });
  send(s, B, false, BACK_ANSWER, ago(14.7));
  s.it({ case: "assistantText", value: { text: "It asked whether #798 changed gutterReach; I told it what changed and where." } }, { at: ago(14.6) });
  end(s, ago(14.5), 30);
  if (n < 3) return;

  s.it({ case: "userMessage", value: { text: "Thanks. Merge #798 then.", attachments: [] } }, { at: ago(4) });
  s.tool("Bash", { command: "gh pr merge 798 --merge" }, { output: "✓ Merged pull request #798" }, { at: ago(3.9), until: ago(3.8) });
  send(s, B, false, MERGED, ago(3.5));
  s.it({ case: "assistantText", value: { text: "#798 is merged, and I told the PR page thread so it can rebase." } }, { at: ago(3.4) });
  end(s, ago(3.3), 40);
}

/** B's log (the receiver). In "waiting" its turn for A's question still runs. */
export function scriptReceiver(s: PeerScript, state: PeerLinesState): void {
  const n = rank(state);
  s.it({ case: "userMessage", value: { text: "Redesign the PR page header: status first, details in Overview.", attachments: [] } }, { at: ago(60) });
  s.it({ case: "assistantText", value: { text: "The header now leads with the PR's status; the details moved to the Overview tab." } }, { at: ago(50) });
  end(s, ago(49.9), 600);

  s.it(message(ASK_TEXT, A, true), { at: ago(25.6) });
  s.tool("Bash", { command: "git log --oneline -- internal/shell/resize.go" }, { output: "a1b2c3d revert: drop the resize tweak" }, { at: ago(25.5), until: ago(25.4) });
  if (n < 1) return;
  send(s, A, false, ANSWER_TEXT, ago(22.1));
  s.it({ case: "assistantText", value: { text: "No: my branch dropped its resize.ts change last week. I told the release thread." } }, { at: ago(22) });
  end(s, ago(21.9), 220);
  if (n < 2) return;

  s.it({ case: "userMessage", value: { text: "Ask the release thread whether #798 changed gutterReach's signature: the rebase fails in resize.test.ts.", attachments: [] } }, { at: ago(15.2) });
  send(s, A, true, BACK_TEXT, ago(15.1), { replyItemId: "pl-b-m2", repliedAt: ago(14.7) });
  s.it({ case: "assistantText", value: { text: "Asked the release thread about gutterReach; I'll fix the test when it answers." } }, { at: ago(15) });
  end(s, ago(14.95), 12);
  s.it(message(BACK_ANSWER, A, false), { at: ago(14.7), id: "pl-b-m2" });
  s.it({ case: "assistantText", value: { text: "gutterReach now takes the pair of panes; I updated the call in resize.test.ts and the suite passes." } }, { at: ago(13) });
  end(s, ago(12.9), 100);
  if (n < 3) return;

  // A's news inside the exchange (the line says "then sent 1 message"); C's message opens a turn of its own (a From row, no tag).
  s.it(message(MERGED, A, false), { at: ago(3.5) });
  s.it({ case: "assistantText", value: { text: "Rebased on main: the branch is clean on top of #798." } }, { at: ago(2) });
  end(s, ago(1.9), 90);
  s.it(message("FYI: the sidebar rail lands today, so the PR page's left edge moves 8px in.", C, false), { at: ago(1.5) });
  s.it({ case: "assistantText", value: { text: "Noted: the header's grid already follows the pane's edge, so nothing to change here." } }, { at: ago(1.2) });
  end(s, ago(1.1), 18);
}

/**
 * The step after "waiting", now: B answers. In A the note says replied (in place, as the
 * daemon updates it), B's message arrives and A's turn for it ends with a reply; in B the
 * answer is sent and its turn ends.
 */
export function stepSender(s: PeerScript, update: (id: string, f: (it: ItemInit) => ItemInit) => void): void {
  const now = Date.now();
  update(ASK_NOTE, (it) => ({ ...it, updatedAt: timestampFromDate(new Date(now)), payload: sentNote(B, true, ANSWER, new Date(now)) }) as ItemInit);
  s.it(message(ANSWER_TEXT, B, false), { at: new Date(now), id: ANSWER });
  s.it({ case: "assistantText", value: { text: "The PR page thread says it no longer touches resize.ts, so #798 can merge without waiting on it." } }, { at: new Date(now + 1000) });
  end(s, new Date(now + 2000), 2);
}

export function stepReceiver(s: PeerScript): void {
  const now = Date.now();
  send(s, A, false, ANSWER_TEXT, new Date(now - 1500));
  s.it({ case: "assistantText", value: { text: "No: my branch dropped its resize.ts change last week. I told the release thread." } }, { at: new Date(now) });
  end(s, new Date(now + 500), 300);
}
