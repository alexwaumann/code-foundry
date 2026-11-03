import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";
import { ListThreadItemsResponseSchema, MessageOrigin, ThreadItemRole, type ListThreadItemsRequest } from "@/gen/codefoundry/v1/thread_pb";
import { SearchSpeaker, SearchThreadsResponseSchema } from "@/gen/codefoundry/v1/thread_search_pb";
import type { DaemonConnection } from "./endpoint";
import { codePointRanges, PROMPT_WINDOW, readHitItem, readLastReply, readPromptBefore, searchThreads, toSearchResultView, type PromptCache } from "./threadSearch";

describe("codePointRanges", () => {
  it("shifts every range after an astral character by one UTF-16 unit per character", () => {
    // "🔥 fix the 🐛 bug": code points fix=2..5, bug=12..15; UTF-16 fix=3..6, bug=14..17.
    const text = "🔥 fix the 🐛 bug";
    const r = codePointRanges(text, [
      { start: 2, end: 5 },
      { start: 12, end: 15 },
    ]);
    expect(r).toEqual([
      { start: 3, end: 6 },
      { start: 14, end: 17 },
    ]);
    expect(r.map((x) => text.slice(x.start, x.end))).toEqual(["fix", "bug"]);
  });

  it("covers a match that is itself an emoji, keeps BMP text as it is, clamps past the end and drops empty ranges", () => {
    expect(codePointRanges("a🐛b", [{ start: 1, end: 2 }])).toEqual([{ start: 1, end: 3 }]);
    expect(codePointRanges("héllo", [{ start: 1, end: 3 }])).toEqual([{ start: 1, end: 3 }]);
    expect(codePointRanges("abc", [{ start: 1, end: 9 }])).toEqual([{ start: 1, end: 3 }]);
    expect(codePointRanges("abc", [{ start: 2, end: 2 }])).toEqual([]);
  });
});

describe("toSearchResultView", () => {
  it("maps names, groups and hits, converting every range to UTF-16", () => {
    const res = create(SearchThreadsResponseSchema, {
      threads: [{ threadId: "s-1", name: "🚀 Ship login", ranges: [{ start: 2, end: 6 }], archived: true, lastActivityAt: timestampFromMs(1_000) }],
      groups: [
        {
          threadId: "s-2",
          threadName: "Fix login",
          archived: false,
          totalHits: 4,
          hits: [{ threadId: "s-2", itemId: "i-9", ordinal: 9n, speaker: SearchSpeaker.QUESTION, createdAt: timestampFromMs(2_000), snippet: "…🌟 login works", ranges: [{ start: 3, end: 8 }] }],
        },
      ],
      caseSensitive: true,
      namesOnly: false,
      totalHits: 4,
      totalThreads: 1,
      truncated: true,
    });
    const v = toSearchResultView("login", res);
    expect(v).toEqual({
      query: "login",
      threads: [{ threadId: "s-1", name: "🚀 Ship login", ranges: [{ start: 3, end: 7 }], archived: true, lastActivityMs: 1_000 }],
      groups: [
        {
          threadId: "s-2",
          threadName: "Fix login",
          archived: false,
          totalHits: 4,
          hits: [{ threadId: "s-2", itemId: "i-9", ordinal: 9, speaker: "question", createdAtMs: 2_000, snippet: "…🌟 login works", ranges: [{ start: 4, end: 9 }] }],
        },
      ],
      caseSensitive: true,
      namesOnly: false,
      totalHits: 4,
      totalThreads: 1,
      truncated: true,
    });
    expect(v.threads[0]?.name.slice(3, 7)).toBe("Ship");
    expect(v.groups[0]?.hits[0]?.snippet.slice(4, 9)).toBe("login");
  });
});

function fakeConn(items: (req: ListThreadItemsRequest) => unknown[]) {
  const listItems = vi.fn((req: ListThreadItemsRequest) => Promise.resolve(create(ListThreadItemsResponseSchema, { page: { threadId: req.threadId, items: items(req) as never } })));
  const search = vi.fn(() => Promise.resolve(create(SearchThreadsResponseSchema, {})));
  const conn = { client: () => Promise.resolve({ listItems, search }) } as unknown as DaemonConnection;
  return { conn, listItems, search };
}

const user = (id: string, ordinal: number, text: string, parentToolUseId = "") => ({ id, ordinal: BigInt(ordinal), parentToolUseId, payload: { case: "userMessage", value: { text, attachments: [] } } });
const reply = (id: string, ordinal: number, text: string, parentToolUseId = "") => ({ id, ordinal: BigInt(ordinal), parentToolUseId, payload: { case: "assistantText", value: { text } } });

describe("reading for the preview", () => {
  it("searchThreads asks for three hits per thread", async () => {
    const { conn, search } = fakeConn(() => []);
    await searchThreads("login", {}, conn);
    expect(search).toHaveBeenCalledWith({ query: "login", limit: 0, perThread: 3 }, { signal: undefined });
  });

  it("readHitItem reads one item from ordinal - 1 and checks its id", async () => {
    const { conn, listItems } = fakeConn(() => [reply("i-7", 7, "the answer")]);
    expect((await readHitItem("s-1", "i-7", 7, conn))?.id).toBe("i-7");
    expect(listItems).toHaveBeenCalledWith({ threadId: "s-1", query: { since: "6", last: 1, role: ThreadItemRole.UNSPECIFIED } });
    expect(await readHitItem("s-1", "i-other", 7, conn)).toBeNull();
  });

  it("readPromptBefore reads the items just before the hit first, any role, and takes the thread's own last user message", async () => {
    const wake = { ...user("w-66", 66, "[code-foundry wake] done"), payload: { case: "userMessage", value: { text: "x", attachments: [], origin: MessageOrigin.WAKE } } };
    const { conn, listItems } = fakeConn(() => [user("u-63", 63, "second"), user("u-sub", 64, "a subagent's", "toolu_1"), reply("a-65", 65, "step"), wake, user("u-69", 69, "later")]);
    expect((await readPromptBefore("s-1", 68, new Map(), conn))?.id).toBe("u-63");
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listItems).toHaveBeenCalledWith({ threadId: "s-1", query: { since: String(68 - PROMPT_WINDOW - 1), last: PROMPT_WINDOW, role: ThreadItemRole.UNSPECIFIED } });
  });

  it("readPromptBefore near the thread's start: a window from the start, no second read when it has none", async () => {
    const { conn, listItems } = fakeConn(() => [reply("a-1", 1, "hello")]);
    expect(await readPromptBefore("s-1", 2, new Map(), conn)).toBeNull();
    expect(listItems).toHaveBeenCalledTimes(1);
    expect(listItems.mock.calls[0]?.[0].query).toMatchObject({ since: "0", last: PROMPT_WINDOW });
  });

  it("readPromptBefore falls back to the thread's user messages once per thread when the window has none", async () => {
    const { conn, listItems } = fakeConn((req) =>
      req.query?.role === ThreadItemRole.USER ? [user("u-1", 1, "first"), user("u-3", 3, "second"), user("u-900", 900, "later")] : [reply("a-850", 850, "a long turn")],
    );
    const cache: PromptCache = new Map();
    expect((await readPromptBefore("s-1", 860, cache, conn))?.id).toBe("u-3");
    expect((await readPromptBefore("s-1", 870, cache, conn))?.id).toBe("u-3");
    expect((await readPromptBefore("s-1", 1000, cache, conn))?.id).toBe("u-900");
    // Three windows; the user messages read once for the thread.
    const roles = listItems.mock.calls.map((c) => c[0].query?.role);
    expect(roles.filter((r) => r === ThreadItemRole.USER)).toHaveLength(1);
    expect(roles.filter((r) => r === ThreadItemRole.UNSPECIFIED)).toHaveLength(3);
  });

  it("readLastReply skips a subagent's text", async () => {
    const { conn } = fakeConn(() => [reply("a-1", 1, "mine"), reply("a-2", 2, "the subagent's", "toolu_1")]);
    expect((await readLastReply("s-1", conn))?.id).toBe("a-1");
  });
});
