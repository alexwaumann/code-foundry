import { describe, expect, it } from "vitest";
import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { MessageOrigin, ThreadEventSchema, ThreadItemDelta_Field, ThreadItemSchema, ThreadRequestState, ToolCallStatus } from "@/gen/codefoundry/v1/thread_pb";
import { ListPromptsResponseSchema, PromptScope, type ListPromptsRequest } from "@/gen/codefoundry/v1/thread_prompts_pb";
import type { DaemonConnection } from "./endpoint";
import { listPrompts, toThreadEventView, toThreadItemView } from "./thread";
import { themeById } from "@/themes";

describe("toThreadItemView: theme cards", () => {
  const nord = themeById.get("nord");
  if (!nord) throw new Error("no nord");
  const t = nord.base.terminal;
  const file = {
    id: "nord-warmer",
    name: "Nord, warmer",
    scheme: "dark",
    from: "nord",
    createdBy: "s-1",
    base: { ...nord.base, link: "", terminal: { foreground: t.foreground, cursor: "", cursorText: "", selection: "", ansi: [...t.ansi] } },
    overrides: { "--cf-sidebar-row-selected": "#3b4252" },
  };
  const v = (theme: object | undefined, applied: boolean, previous: string) =>
    toThreadItemView(create(ThreadItemSchema, { id: "c", ordinal: 3n, payload: { case: "theme", value: { theme, applied, previous } } } as never));

  it("maps the file as saved, applied and the Undo target", () => {
    const got = v(file, true, "github-dark");
    expect(got).toMatchObject({ kind: "theme", applied: true, previous: "github-dark" });
    if (got?.kind !== "theme") throw new Error("not a theme item");
    expect(got.theme).toMatchObject({ id: "nord-warmer", name: "Nord, warmer", scheme: "dark", from: "nord", createdBy: "s-1", overrides: { "--cf-sidebar-row-selected": "#3b4252" } });
    expect(got.theme?.base.canvas).toBe(nord.base.canvas);
  });

  it("a file the GUI's rules refuse is null (the card is not drawn)", () => {
    expect(v({ ...file, overrides: { "--cf-icon": "#ffffff" } }, false, "")).toMatchObject({ kind: "theme", theme: null, applied: false, previous: "" });
    expect(v(undefined, false, "")).toMatchObject({ kind: "theme", theme: null });
  });
});

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
    expect(v({ case: "userMessage", value: { text: "hi", origin: MessageOrigin.USER } })).not.toHaveProperty("wake");
    expect(v({ case: "userMessage", value: { text: "[code-foundry wake] T", origin: MessageOrigin.WAKE, wakeTitle: "T", wakeJson: "{}" } })).toMatchObject({
      kind: "user",
      text: "[code-foundry wake] T",
      wake: { title: "T", json: "{}" },
    });
    expect(v({ case: "toolCall", value: { toolUseId: "t", name: "Bash", inputJson: "{}", status: ToolCallStatus.ERROR, output: "x", isError: true, resultJson: "" } })).toMatchObject({
      kind: "tool",
      status: "error",
      isError: true,
    });
    expect(v({ case: "question", value: { requestId: "r", state: ThreadRequestState.PENDING, answers: { Q: "A" } } })).toMatchObject({ kind: "question", request: { requestId: "r", state: "pending", answers: { Q: "A" } } });
    expect(v({ case: "turnEnd", value: { subtype: "success", durationMs: 1234n, costUsd: 0.5, inputTokens: 3n, errors: ["e"] } })).toMatchObject({ kind: "turnEnd", durationMs: 1234, costUsd: 0.5, inputTokens: 3, errors: ["e"] });
    expect(v({ case: "compaction", value: { trigger: "manual", preTokens: 10n, postTokens: 2n } })).toMatchObject({ kind: "compaction", preTokens: 10, postTokens: 2 });
    expect(v({ case: "note", value: { text: "Forked from base" } })).toMatchObject({ kind: "note", text: "Forked from base", createdBy: "" });
    expect(v({ case: "note", value: { text: "Created by P", createdBy: "s-p" } })).toMatchObject({ kind: "note", text: "Created by P", createdBy: "s-p" });
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
      threads: [{ threadId: "s", seq: 3, pending: [] }],
    });
  });
});

describe("listPrompts", () => {
  it("sends the scope and maps the prompts to view models", async () => {
    const sent: Partial<ListPromptsRequest>[] = [];
    const client = {
      listPrompts: (req: Partial<ListPromptsRequest>) => {
        sent.push(req);
        return Promise.resolve(
          create(ListPromptsResponseSchema, {
            prompts: [
              { threadId: "s-3", threadName: "Fix resize race", itemId: "u1", text: "see src/a.ts", composerText: "see [a.ts](cf-file://r/src/a.ts)", sentAt: timestampFromMs(1_800_000_000_000) },
              { threadId: "s-4", itemId: "u2", text: "retry" },
            ],
          }),
        );
      },
    };
    const conn = { client: () => Promise.resolve(client) } as unknown as DaemonConnection;
    const got = await listPrompts({ scope: "project", projectIds: ["repo-cf"], query: "a" }, conn);
    expect(sent).toEqual([{ scope: PromptScope.PROJECT, threadId: "", projectIds: ["repo-cf"], query: "a", limit: 0 }]);
    expect(got).toEqual([
      { threadId: "s-3", threadName: "Fix resize race", itemId: "u1", text: "see src/a.ts", composerText: "see [a.ts](cf-file://r/src/a.ts)", sentAt: new Date(1_800_000_000_000) },
      { threadId: "s-4", threadName: "", itemId: "u2", text: "retry", composerText: "", sentAt: new Date(0) },
    ]);
  });
});
