import { create } from "@bufbuild/protobuf";
import { timestampFromMs } from "@bufbuild/protobuf/wkt";
import { describe, expect, it, vi } from "vitest";
import { ListThreadItemsResponseSchema, ThreadItemRole, type ListThreadItemsRequest } from "@/gen/codefoundry/v1/thread_pb";
import { SearchSpeaker, SearchThreadsResponseSchema } from "@/gen/codefoundry/v1/thread_search_pb";
import type { DaemonConnection } from "./endpoint";
import { codePointRanges, readHitItem, readLastReply, readPromptBefore, searchThreads, toSearchResultView } from "./threadSearch";

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

  it("readPromptBefore takes the thread's own last user message before the ordinal", async () => {
    const { conn, listItems } = fakeConn(() => [user("u-1", 1, "first"), user("u-sub", 4, "a subagent's", "toolu_1"), user("u-3", 3, "second"), user("u-9", 9, "later")]);
    expect((await readPromptBefore("s-1", 7, conn))?.id).toBe("u-3");
    expect(listItems.mock.calls[0]?.[0].query?.role).toBe(ThreadItemRole.USER);
    expect(await readPromptBefore("s-1", 1, conn)).toBeNull();
  });

  it("readLastReply skips a subagent's text", async () => {
    const { conn } = fakeConn(() => [reply("a-1", 1, "mine"), reply("a-2", 2, "the subagent's", "toolu_1")]);
    expect((await readLastReply("s-1", conn))?.id).toBe("a-1");
  });
});
