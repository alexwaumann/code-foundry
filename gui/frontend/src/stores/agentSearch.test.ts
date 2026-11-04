import { afterEach, describe, expect, it, vi } from "vitest";
import type { AgentHitView } from "@/api/search";
import type { ThreadItemView } from "@/api/thread";
import { useCiteStore } from "./cite";
import { useSearchDialogStore } from "./searchDialog";
import { useThreadStore } from "./thread";
import { promotedThreadId, revealHit } from "./agentSearch";

const hit = (over: Partial<AgentHitView> = {}): AgentHitView => ({
  n: 1,
  threadId: "s-a",
  threadName: "A",
  archived: false,
  itemId: "i-1",
  ordinal: 3,
  speaker: "assistant",
  itemAtMs: null,
  quote: "the quote",
  why: "",
  opened: false,
  ...over,
});
const item = (id: string): ThreadItemView => ({ id, ordinal: 3, kind: "text", text: "the quote", parentToolUseId: "", createdAtMs: 0, updatedAtMs: 0, streaming: false });
const loadLog = (threadId: string, id: string) => {
  useThreadStore.setState((s) => ({ logs: { ...s.logs, [threadId]: { seq: 1, byId: { [id]: item(id) }, order: [id], pending: [], mcp: null, commands: [], agents: [] } } }));
};

afterEach(() => {
  useThreadStore.setState({ logs: {}, expanded: {} });
  useCiteStore.setState({ flash: null });
  vi.useRealTimers();
});

describe("revealHit", () => {
  it("waits for the thread's log to have the item, then asks the cite layer to reveal and hold the mark", async () => {
    const p = revealHit(hit(), 1000);
    expect(useCiteStore.getState().flash).toBeNull();
    loadLog("s-a", "i-1");
    await expect(p).resolves.toBe(true);
    expect(useCiteStore.getState().flash).toMatchObject({ threadId: "s-a", hold: true, cite: { threadId: "s-a", itemId: "i-1", text: "the quote", start: -1, end: -1, prefix: "", suffix: "" } });
  });

  it("a question's row is expanded first: its answers hold the text", async () => {
    loadLog("s-a", "i-q");
    await revealHit(hit({ itemId: "i-q", speaker: "question" }), 1000);
    expect(useThreadStore.getState().expanded["s-a"]?.["i-q"]).toBe(true);
  });

  it("an item that never arrives reveals nothing", async () => {
    vi.useFakeTimers();
    const p = revealHit(hit({ itemId: "i-gone" }), 500);
    vi.advanceTimersByTime(600);
    await expect(p).resolves.toBe(false);
    expect(useCiteStore.getState().flash).toBeNull();
  });
});

describe("promotedThreadId", () => {
  it.each([
    ['{"threadId":"s-1"}', "s-1"],
    ['{"thread_id":"s-2"}', "s-2"],
    ["", ""],
    ["not json", ""],
    ['{"threadId":3}', ""],
  ])("%s", (json, want) => {
    expect(promotedThreadId(json)).toBe(want);
  });
});

describe("the remembered mode", () => {
  it("reads back only a known mode (another build's or a damaged value falls back to Agent search)", () => {
    const merge = useSearchDialogStore.persist.getOptions().merge;
    const cur = { mode: "agent" as const, session: null, pending: null, target: null, targetSeq: 0 };
    expect(merge?.({ mode: "find" }, cur)).toMatchObject({ mode: "find" });
    expect(merge?.({ mode: "ask" }, cur)).toMatchObject({ mode: "agent" });
    expect(merge?.(null, cur)).toMatchObject({ mode: "agent" });
  });
});
