import { ReplyMark, ThreadRelation, type ThreadMessageSent, type UserMessageItem } from "@/gen/codefoundry/v1/thread_pb";
import { ms } from "./timestamp";

// Reply marks on thread-to-thread messages (docs/notes/thread-reply-mark.md): the view
// models a later change draws ("wants a reply" on an incoming message, "asked · waiting
// for a reply" / "replied" / "told · no reply needed" on the sender's side).

/** What one thread is to another. */
export type ThreadRelationView = "lead" | "worker" | "other";

/** A thread-to-thread message's reply mark. */
export type ReplyMarkView = "wanted" | "none";

/**
 * A message another thread sent with thread send: threadId sent it, relation is what that
 * thread is to the one that got it, reply its mark.
 */
export interface MessageFromView {
  threadId: string;
  relation: ThreadRelationView;
  reply: ReplyMarkView;
}

/**
 * The sender's record of a message it sent another thread (a note in its own timeline).
 * relation: what the receiver is to the sender. itemId: the message in the receiver's
 * timeline. repliedAtMs and replyItemId (the answer in this timeline) once a wanted reply
 * came; unanswered says why none came ("turn ended": it may still come; "archived",
 * "removed"), "" while waiting and once answered.
 */
export interface SentMessageView {
  toThreadId: string;
  toName: string;
  relation: ThreadRelationView;
  reply: ReplyMarkView;
  itemId: string;
  ordinal: number;
  repliedAtMs: number | null;
  replyItemId: string;
  unanswered: string;
}

const relations: Partial<Record<ThreadRelation, ThreadRelationView>> = {
  [ThreadRelation.LEAD]: "lead",
  [ThreadRelation.WORKER]: "worker",
  [ThreadRelation.OTHER]: "other",
};

const marks: Partial<Record<ReplyMark, ReplyMarkView>> = {
  [ReplyMark.WANTED]: "wanted",
  [ReplyMark.NONE]: "none",
};

/** A user message's sender when another thread sent it with a mark; undefined otherwise. */
export function toMessageFromView(m: UserMessageItem): MessageFromView | undefined {
  const relation = relations[m.senderRelation];
  const reply = marks[m.reply];
  if (!m.sentByThreadId || !relation || !reply) return undefined;
  return { threadId: m.sentByThreadId, relation, reply };
}

/** A note's sent-message record; undefined for a plain note. */
export function toSentMessageView(s: ThreadMessageSent | undefined): SentMessageView | undefined {
  if (!s) return undefined;
  return {
    toThreadId: s.toThreadId,
    toName: s.toName,
    relation: relations[s.relation] ?? "other",
    reply: marks[s.reply] ?? "none",
    itemId: s.itemId,
    ordinal: Number(s.ordinal),
    repliedAtMs: ms(s.repliedAt),
    replyItemId: s.replyItemId,
    unanswered: s.unanswered,
  };
}

/** The user item's from field, when it has one (spread into the view). */
export function fromOf(m: UserMessageItem): { from?: MessageFromView } {
  const from = toMessageFromView(m);
  return from ? { from } : {};
}

/** The note's sent field, when it has one (spread into the view). */
export function sentOf(s: ThreadMessageSent | undefined): { sent?: SentMessageView } {
  const sent = toSentMessageView(s);
  return sent ? { sent } : {};
}
