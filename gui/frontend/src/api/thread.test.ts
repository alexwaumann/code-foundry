import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { ThreadEventSchema, ThreadItemDelta_Field, ThreadItemSchema, ThreadRequestState, ToolCallStatus } from "@/gen/codefoundry/v1/thread_pb";
import { toThreadEventView, toThreadItemView } from "./thread";

describe("toThreadItemView", () => {
  it("maps every payload kind", () => {
    const base = { id: "i", ordinal: 7n, parentToolUseId: "p", createdAt: timestampFromMs(1000), updatedAt: timestampFromMs(2000), streaming: true };
    const v = (payload: object) => toThreadItemView(create(ThreadItemSchema, { ...base, payload } as never));
    expect(v({ case: "userMessage", value: { text: "hi", attachments: ["/a.png"], composerText: "![a.png](cf-attachment://0) hi" } })).toEqual({
      id: "i",
      ordinal: 7,
      parentToolUseId: "p",
      createdAtMs: 1000,
      updatedAtMs: 2000,
      streaming: true,
      kind: "user",
      text: "hi",
      attachments: ["/a.png"],
      composerText: "![a.png](cf-attachment://0) hi",
    });
    expect(v({ case: "toolCall", value: { toolUseId: "t", name: "Bash", inputJson: "{}", status: ToolCallStatus.ERROR, output: "x", isError: true, resultJson: "" } })).toMatchObject({
      kind: "tool",
      status: "error",
      isError: true,
    });
    expect(v({ case: "question", value: { requestId: "r", state: ThreadRequestState.PENDING, answers: { Q: "A" } } })).toMatchObject({ kind: "question", request: { requestId: "r", state: "pending", answers: { Q: "A" } } });
    expect(v({ case: "turnEnd", value: { subtype: "success", durationMs: 1234n, costUsd: 0.5, inputTokens: 3n, errors: ["e"] } })).toMatchObject({ kind: "turnEnd", durationMs: 1234, costUsd: 0.5, inputTokens: 3, errors: ["e"] });
    expect(v({ case: "compaction", value: { trigger: "manual", preTokens: 10n, postTokens: 2n } })).toMatchObject({ kind: "compaction", preTokens: 10, postTokens: 2 });
    expect(v({ case: "note", value: { text: "Forked from base" } })).toMatchObject({ kind: "note", text: "Forked from base" });
    expect(v({ case: undefined })).toBeNull();
  });
});

describe("toThreadEventView", () => {
  it("maps snapshots, deltas and the pending snapshot; drops unknown fields", () => {
    const snap = toThreadEventView(create(ThreadEventSchema, { event: { case: "snapshot", value: { threadId: "s", seq: 9n, items: [{ id: "a", payload: { case: "assistantText", value: { text: "x" } } }], pending: [{ requestId: "r", itemId: "perm-r", toolName: "Bash", summary: "Bash ls" }] } } }));
    expect(snap).toMatchObject({ kind: "snapshot", seq: 9, items: [{ id: "a", kind: "text", text: "x" }], pending: [{ requestId: "r" }] });
    const delta = (field: ThreadItemDelta_Field) => toThreadEventView(create(ThreadEventSchema, { event: { case: "delta", value: { threadId: "s", seq: 10n, itemId: "a", field, text: "y" } } }));
    expect(delta(ThreadItemDelta_Field.TEXT)).toMatchObject({ kind: "delta", field: "text", seq: 10 });
    expect(delta(ThreadItemDelta_Field.INPUT)).toMatchObject({ field: "input" });
    expect(delta(ThreadItemDelta_Field.UNSPECIFIED)).toBeNull();
    expect(toThreadEventView(create(ThreadEventSchema, { event: { case: "pendingSnapshot", value: { threads: [{ threadId: "s", seq: 3n, pending: [] }] } } }))).toEqual({
      kind: "pendingSnapshot",
      threads: [{ sessionId: "s", seq: 3, pending: [] }],
    });
  });
});
