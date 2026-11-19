import { describe, expect, it } from "vitest";
import type { MessageInitShape } from "@bufbuild/protobuf";
import { ReplyMark, ThreadRelation, type ThreadItemSchema } from "../src/gen/codefoundry/v1/thread_pb";
import { answerReply, ASKED, scriptReplies } from "./replies";

type ItemInit = MessageInitShape<typeof ThreadItemSchema>;

function script(): ItemInit[] {
  const items: ItemInit[] = [];
  let n = 0;
  const add = (x: ItemInit) => (items.push(x), x);
  scriptReplies({
    cwd: "/w",
    it: (payload, over) => add({ id: `i${String(++n)}`, payload, ...over } as ItemInit),
    tool: (name, input, value) => add({ id: `t${String(++n)}`, payload: { case: "toolCall", value: { name, inputJson: JSON.stringify(input), ...value } } }),
  });
  return items;
}

function add(items: ItemInit[], x: ItemInit): ItemInit {
  items.push(x);
  return x;
}

const notes = (items: readonly ItemInit[]) => items.flatMap((x) => (x.payload?.case === "note" ? [x.payload.value] : []));

describe("mock reply marks", () => {
  it("the replies state has a told note, an open question and a message that wants an answer", () => {
    const items = script();
    expect(notes(items).map((n) => [n.text, n.sent?.reply])).toEqual([
      ['Told "Port renderer" (s-2) · no reply needed', ReplyMark.NONE],
      [`Asked "${ASKED.name}" (${ASKED.id}) · waiting for a reply`, ReplyMark.WANTED],
      ['Told "Fix flaky e2e" (s-3) · no reply needed', ReplyMark.NONE],
    ]);
    const incoming = items.find((x) => x.payload?.case === "userMessage" && x.payload.value.sentByThreadId);
    expect(incoming?.payload?.value).toMatchObject({ sentByThreadId: "s-3", senderRelation: ThreadRelation.OTHER, reply: ReplyMark.WANTED });
  });

  it("answering appends the other thread's message and says replied in place", () => {
    const items = script();
    let updated: ItemInit | undefined;
    const ok = answerReply(
      items,
      "",
      (payload) => add(items, { id: "ans", payload }),
      (x) => (updated = x),
    );
    expect(ok).toBe(true);
    expect(items.at(-1)?.payload?.value).toMatchObject({ sentByThreadId: ASKED.id, reply: ReplyMark.NONE });
    expect(updated?.payload?.value).toMatchObject({ text: `Asked "${ASKED.name}" (${ASKED.id}) · replied`, sent: { replyItemId: "ans" } });
    expect(updated?.payload?.case === "note" && updated.payload.value.sent?.repliedAt).toBeTruthy();
  });

  it("no answer says why; nothing open answers false", () => {
    const items = script();
    let updated: ItemInit | undefined;
    expect(answerReply(items, "archived", () => ({}), (x) => (updated = x))).toBe(true);
    expect(updated?.payload?.value).toMatchObject({ text: `Asked "${ASKED.name}" (${ASKED.id}) · no answer: it was archived`, sent: { unanswered: "archived" } });
    expect(answerReply(items.filter((x) => x.payload?.case !== "note"), "", () => ({}), () => undefined)).toBe(false);
  });
});
