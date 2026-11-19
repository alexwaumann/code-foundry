/**
 * Reply marks in the mock daemon (docs/notes/thread-reply-mark.md): the fields a later GUI
 * change draws. The "replies" scripted state (POST /__mock/thread?state=replies) is a
 * thread that told one thread something (no reply wanted), asked another (waiting for a
 * reply), and got a message from a third that wants its answer, which it gave.
 *
 *   POST /__mock/thread/reply?id=s-r1                       the open question is answered: the
 *        answer arrives as that thread's message, and the note says replied (in place)
 *   POST /__mock/thread/reply?id=s-r1&unanswered=turn%20ended|archived|removed   no answer came
 */
import type { MessageInitShape } from "@bufbuild/protobuf";
import { timestampFromDate } from "@bufbuild/protobuf/wkt";
import { ReplyMark, ThreadRelation, type ThreadItemSchema, type ThreadMessageSentSchema } from "../src/gen/codefoundry/v1/thread_pb";
import type { AgentsScript } from "./agents";

type ItemInit = MessageInitShape<typeof ThreadItemSchema>;
type SentInit = MessageInitShape<typeof ThreadMessageSentSchema>;

/** The threads the script talks to: real mock threads, so their names resolve. */
export const TOLD = { id: "s-2", name: "Port renderer" };
export const ASKED = { id: "s-1", name: "Refactor sidebar tree" };
export const ASKING = { id: "s-3", name: "Fix flaky e2e" };

const quoted = (t: { id: string; name: string }) => `"${t.name}" (${t.id})`;

/** The "replies" state's conversation, idle at its prompt with one question open. */
export function scriptReplies(s: AgentsScript, now = Date.now()): void {
  const ago = (sec: number) => new Date(now - sec * 1000);
  s.it({ case: "userMessage", value: { text: "Tell the renderer thread the theme API moved to lib/themes, and ask the sidebar thread which tree API it ended up on.", attachments: [] } }, { at: ago(300) });
  s.tool(
    "Bash",
    { command: `code-foundry thread send --id ${TOLD.id} --reply none "FYI: the theme API moved to lib/themes; update your imports when you next touch them."` },
    { output: `sent to thread ${TOLD.id} (#14). Delivered, no reply expected. You will not hear back, not even a confirmation, unless that thread needs something from you.` },
    { at: ago(290) },
  );
  s.it(
    { case: "note", value: { text: `Told ${quoted(TOLD)} · no reply needed`, sent: { toThreadId: TOLD.id, toName: TOLD.name, relation: ThreadRelation.OTHER, reply: ReplyMark.NONE, itemId: `${TOLD.id}-u14`, ordinal: 14n } } },
    { at: ago(289) },
  );
  s.tool(
    "Bash",
    { command: `code-foundry thread send --id ${ASKED.id} --reply wanted "Which tree API does the sidebar use now: the old TreeView or the new useTree hook?"` },
    { output: `sent to thread ${ASKED.id} (#22). Delivered. You will be woken when it answers; do not poll it.` },
    { at: ago(285) },
  );
  s.it(
    {
      case: "note",
      value: {
        text: `Asked ${quoted(ASKED)} · waiting for a reply`,
        sent: { toThreadId: ASKED.id, toName: ASKED.name, relation: ThreadRelation.OTHER, reply: ReplyMark.WANTED, itemId: `${ASKED.id}-u22`, ordinal: 22n },
      },
    },
    { at: ago(284) },
  );
  s.it({ case: "assistantText", value: { text: "Told the renderer thread about the move, and asked the sidebar thread which tree API it uses; I'll pass its answer on when it comes." } }, { at: ago(282) });
  s.it({ case: "turnEnd", value: { subtype: "success", durationMs: 18_000n, numTurns: 3, costUsd: 0.04, turnCostUsd: 0.04, model: "claude-opus-4-8", stopReason: "end_turn" } }, { at: ago(281) });
  // A message from another thread that wants its answer, and the answer it got.
  s.it(
    {
      case: "userMessage",
      value: { text: "Is the theme API move merged yet? I need to know before I rebase.", attachments: [], sentByThreadId: ASKING.id, senderRelation: ThreadRelation.OTHER, reply: ReplyMark.WANTED },
    },
    { at: ago(120) },
  );
  s.tool(
    "Bash",
    { command: `code-foundry thread send --id ${ASKING.id} --reply none "Not yet: PR 812 is waiting on review. Rebase on main once it merges."` },
    { output: `sent to thread ${ASKING.id} (#9). Delivered, no reply expected. You will not hear back, not even a confirmation, unless that thread needs something from you.` },
    { at: ago(110) },
  );
  s.it(
    { case: "note", value: { text: `Told ${quoted(ASKING)} · no reply needed`, sent: { toThreadId: ASKING.id, toName: ASKING.name, relation: ThreadRelation.OTHER, reply: ReplyMark.NONE, itemId: `${ASKING.id}-u9`, ordinal: 9n } } },
    { at: ago(109) },
  );
  s.it({ case: "assistantText", value: { text: "Answered the e2e thread: the move is not merged yet." } }, { at: ago(108) });
  s.it({ case: "turnEnd", value: { subtype: "success", durationMs: 12_000n, numTurns: 2, costUsd: 0.02, turnCostUsd: 0.02, model: "claude-opus-4-8", stopReason: "end_turn" } }, { at: ago(107) });
}

/**
 * The open question's end: answered (the answer, the thread's message, is made with
 * `message` and appended; the note says replied) or, with unanswered, why none came. The
 * note is updated in place, as the daemon does. False when no question is open.
 */
export function answerReply(
  items: readonly ItemInit[],
  unanswered: string,
  message: (payload: ItemInit["payload"]) => ItemInit,
  update: (it: ItemInit) => void,
): boolean {
  const note = [...items].reverse().find((x) => x.payload?.case === "note" && x.payload.value.sent?.reply === ReplyMark.WANTED && !x.payload.value.sent.repliedAt);
  if (note?.payload?.case !== "note" || !note.payload.value.sent) return false;
  const sent = note.payload.value.sent;
  const who = `"${sent.toName ?? ""}" (${sent.toThreadId ?? ""})`;
  const base = { toThreadId: sent.toThreadId, toName: sent.toName, relation: sent.relation, reply: sent.reply, itemId: sent.itemId, ordinal: sent.ordinal };
  let next: SentInit = { ...base, unanswered };
  let text = unanswered === "turn ended" ? `Asked ${who} · no answer yet: it ended its turn` : `Asked ${who} · no answer: it was ${unanswered}`;
  if (!unanswered) {
    const answer = message({
      case: "userMessage",
      value: { text: "It uses the new useTree hook; TreeView is gone.", attachments: [], sentByThreadId: sent.toThreadId, senderRelation: ThreadRelation.OTHER, reply: ReplyMark.NONE },
    });
    next = { ...base, repliedAt: timestampFromDate(new Date()), replyItemId: answer.id ?? "" };
    text = `Asked ${who} · replied`;
  }
  update({ ...note, updatedAt: timestampFromDate(new Date()), payload: { case: "note", value: { text, createdBy: note.payload.value.createdBy ?? "", sent: next } } } as ItemInit);
  return true;
}
