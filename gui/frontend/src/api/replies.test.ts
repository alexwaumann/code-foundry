import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ReplyMark, ThreadItemSchema, ThreadRelation } from "@/gen/codefoundry/v1/thread_pb";
import { toThreadItemView } from "./thread";

// Reply marks reach the view models (docs/notes/thread-reply-mark.md).
describe("toThreadItemView: reply marks", () => {
  const v = (payload: object) => toThreadItemView(create(ThreadItemSchema, { id: "i", ordinal: 3n, payload } as never));

  it("a message another thread sent says who, what it is to this thread, and its mark", () => {
    const from = (senderRelation: ThreadRelation, reply: ReplyMark) =>
      v({ case: "userMessage", value: { text: "Which port?", sentByThreadId: "s-a", senderRelation, reply } });
    expect(from(ThreadRelation.OTHER, ReplyMark.WANTED)).toMatchObject({ kind: "user", from: { threadId: "s-a", relation: "other", reply: "wanted" } });
    expect(from(ThreadRelation.LEAD, ReplyMark.NONE)).toMatchObject({ from: { relation: "lead", reply: "none" } });
    expect(from(ThreadRelation.WORKER, ReplyMark.WANTED)).toMatchObject({ from: { relation: "worker", reply: "wanted" } });
  });

  it("the user's message, a wake and a created thread's first prompt have no from", () => {
    expect(v({ case: "userMessage", value: { text: "hi" } })).not.toHaveProperty("from");
    expect(v({ case: "userMessage", value: { text: "the task", sentByThreadId: "s-lead" } })).not.toHaveProperty("from");
  });

  it("a note recording a sent message carries it, waiting or answered", () => {
    expect(
      v({
        case: "note",
        value: {
          text: 'Asked "Docs" (s-b) · waiting for a reply',
          sent: { toThreadId: "s-b", toName: "Docs", relation: ThreadRelation.OTHER, reply: ReplyMark.WANTED, itemId: "u-1", ordinal: 4n },
        },
      }),
    ).toMatchObject({
      kind: "note",
      sent: { toThreadId: "s-b", toName: "Docs", relation: "other", reply: "wanted", itemId: "u-1", ordinal: 4, repliedAtMs: null, replyItemId: "", unanswered: "" },
    });
    expect(
      v({
        case: "note",
        value: { text: "Asked · replied", sent: { toThreadId: "s-b", reply: ReplyMark.WANTED, repliedAt: timestampFromMs(5000), replyItemId: "u-9" } },
      }),
    ).toMatchObject({ sent: { repliedAtMs: 5000, replyItemId: "u-9" } });
    expect(v({ case: "note", value: { text: "Told", sent: { toThreadId: "s-b", relation: ThreadRelation.LEAD, reply: ReplyMark.NONE } } })).toMatchObject({
      sent: { relation: "lead", reply: "none" },
    });
    expect(v({ case: "note", value: { text: "Forked from base" } })).not.toHaveProperty("sent");
  });
});
