/**
 * A worker's question its lead passed up to the user (docs/notes/pass-up-question.md), for
 * the worker card's "passup" scenario (POST /__mock/workers?state=passup): s-wl-2 "Resize
 * across collapsed panes" asked its lead (`thread ask`), the lead ran `thread pass-up`, and
 * the question is the lead's ask in Needs you. The mock's thread.respond answers it as the
 * daemon does: the item on the lead resolves, the worker gets the answer as the lead's
 * message, and the lead gets a wake saying what the user answered, whose turn ends with only
 * "[nothing new]" (so the worker card shows nothing new).
 */
import { MessageOrigin, ThreadRelation, ReplyMark, ThreadRequestState } from "../src/gen/codefoundry/v1/thread_pb";

/** The worker that asked (mock/workerCard.ts WORKERS[1]), and what. */
export const PASSUP_WORKER = { id: "s-wl-2", name: "Resize across collapsed panes" } as const;
export const PASSUP_QUESTION = "Should the body of a collapsed pane also drag, or only the gutters?";
export const PASSUP_ASSUMING = "only the gutters";
export const PASSUP_REQUEST = "pu-mock-resize";

/** The question item's input: an ask carries no options, so the user answers in Other. */
export const PASSUP_INPUT = JSON.stringify({ questions: [{ question: PASSUP_QUESTION, header: "", multiSelect: false, options: [] }] });

/** The wake that tells the lead what the user answered (internal/store/thread/passup.go tellLeadLocked). */
export function answerWake(answers: Record<string, string>, skipped: boolean): { text: string; title: string; json: string } {
  const w = PASSUP_WORKER;
  const said = Object.values(answers).join("; ");
  const title = skipped
    ? `The user skipped the question you passed up from thread "${w.name}" (${w.id})`
    : `The user answered the question you passed up from thread "${w.name}" (${w.id}): ${said}`;
  const json = JSON.stringify({ kind: "answer", thread: w.id, name: w.name, question: PASSUP_QUESTION, ...(skipped ? { skipped: true } : { answers }), asked: "ask" }, null, 2);
  return { text: `[code-foundry wake] ${title}`, title, json };
}

/** The answer as the worker receives it: a message from its lead. */
export function workerAnswer(lead: string, answers: Record<string, string>): { case: "userMessage"; value: { text: string; attachments: string[]; sentByThreadId: string; senderRelation: ThreadRelation; reply: ReplyMark; origin: MessageOrigin } } {
  const text = `The user answered the question you asked (your lead passed it up to them):\n> ${Object.values(answers).join("; ")}`;
  return { case: "userMessage", value: { text, attachments: [], sentByThreadId: lead, senderRelation: ThreadRelation.LEAD, reply: ReplyMark.NONE, origin: MessageOrigin.USER } };
}

/** The question item on the lead, pending, as the daemon writes it (passup.go reservePassUp). */
export function passUpItem(): { case: "question"; value: { requestId: string; toolName: string; inputJson: string; state: ThreadRequestState; passedUp: { fromThreadId: string; fromName: string; threadAsk: boolean; assuming: string } } } {
  return {
    case: "question",
    value: { requestId: PASSUP_REQUEST, toolName: "AskUserQuestion", inputJson: PASSUP_INPUT, state: ThreadRequestState.PENDING,
      passedUp: { fromThreadId: PASSUP_WORKER.id, fromName: PASSUP_WORKER.name, threadAsk: true, assuming: PASSUP_ASSUMING } },
  };
}
