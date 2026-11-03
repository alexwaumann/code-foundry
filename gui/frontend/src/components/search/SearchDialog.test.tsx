// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandView } from "@/api/command";
import type { ThreadItemView } from "@/api/thread";
import type { SearchResultView } from "@/api/threadSearch";
import { stubLayout, settle } from "@/test/composerWorld";

// jsdom lays nothing out, so TanStack Virtual would render no rows: this stand-in renders
// every row at its estimated size (the real one's window over the rows is e2e's).
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: (o: { count: number; estimateSize: (i: number) => number; getItemKey: (i: number) => string | number }) => {
    const items: { index: number; key: string | number; start: number; size: number; end: number }[] = [];
    let at = 0;
    for (let i = 0; i < o.count; i++) {
      const size = o.estimateSize(i);
      items.push({ index: i, key: o.getItemKey(i), start: at, size, end: at + size });
      at += size;
    }
    return { getVirtualItems: () => items, getTotalSize: () => at, measure: () => undefined, scrollToIndex: () => undefined };
  },
}));

const search = vi.fn<(query: string) => Promise<SearchResultView>>();
const hitItem = vi.fn<(threadId: string, itemId: string, ordinal: number) => Promise<ThreadItemView | null>>();
const promptBefore = vi.fn<(threadId: string, ordinal: number) => Promise<ThreadItemView | null>>();
const lastReply = vi.fn<(threadId: string) => Promise<ThreadItemView | null>>();
vi.mock("@/api/threadSearch", async (orig) => ({
  ...(await orig<typeof import("@/api/threadSearch")>()),
  searchThreads: (q: string) => search(q),
  readHitItem: (t: string, i: string, o: number) => hitItem(t, i, o),
  readPromptBefore: (t: string, o: number) => promptBefore(t, o),
  readLastReply: (t: string) => lastReply(t),
}));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));

const { handleKeyDown } = await import("@/keys/bindings");
const { useCommandsStore } = await import("@/stores/commands");
const { useThreadFindStore } = await import("@/stores/threadFind");
const { useUiStore } = await import("@/stores/ui");
const { resetDaemon } = await import("@/test/daemonFakes");
const { addThreads, seedWorld, thread } = await import("@/test/projectsWorld");
const { CommandPalette } = await import("@/components/palette/CommandPalette");
const { SEARCH_DEBOUNCE_MS, PREVIEW_DEBOUNCE_MS } = await import("./useSearch");

const SEARCH_OPEN: CommandView = { name: "search.open", title: "Search Threads", description: "", category: "View", args: [], keybindings: ["cmd+shift+f"], available: true };

const base = { parentToolUseId: "", createdAtMs: 0, updatedAtMs: 0, streaming: false } as const;
const userItem = (id: string, ordinal: number, text: string): ThreadItemView => ({ ...base, id, ordinal, kind: "user", text, attachments: [], composerText: "" });
const textItem = (id: string, ordinal: number, text: string): ThreadItemView => ({ ...base, id, ordinal, kind: "text", text });

function answer(query: string, over: Partial<SearchResultView> = {}): SearchResultView {
  return {
    query,
    threads: [{ threadId: "s-a", name: "Badge fingerprint", ranges: [{ start: 6, end: 17 }], archived: true, lastActivityMs: new Date(2026, 9, 19, 12).getTime() }],
    groups: [
      {
        threadId: "s-b",
        threadName: "Fix stale PR badge",
        archived: false,
        totalHits: 5,
        hits: [
          { threadId: "s-b", itemId: "u-1", ordinal: 1, speaker: "user", createdAtMs: 0, snippet: "keep the fingerprint", ranges: [{ start: 9, end: 20 }] },
          { threadId: "s-b", itemId: "t-4", ordinal: 4, speaker: "assistant", createdAtMs: 0, snippet: "…the fingerprint now", ranges: [{ start: 5, end: 16 }] },
        ],
      },
    ],
    caseSensitive: false,
    namesOnly: false,
    totalHits: 5,
    totalThreads: 1,
    truncated: false,
    ...over,
  };
}

async function wait(ms: number): Promise<void> {
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
  await settle(10);
}

beforeEach(() => {
  stubLayout();
  resetDaemon();
  seedWorld();
  addThreads(thread("s-a", { name: "Badge fingerprint" }), thread("s-b", { name: "Fix stale PR badge" }));
  useCommandsStore.setState({ commands: [SEARCH_OPEN], loading: false, error: null, contextKey: "" });
  useThreadFindStore.setState({ byThread: {} });
  search.mockReset();
  search.mockImplementation((q) => Promise.resolve(answer(q)));
  hitItem.mockReset();
  hitItem.mockImplementation((_t, id, o) => Promise.resolve(id.startsWith("u") ? userItem(id, o, "Keep the fingerprint check-count based.") : textItem(id, o, "The **fingerprint** now has the head. A fingerprint each push.")));
  promptBefore.mockReset();
  promptBefore.mockResolvedValue(userItem("u-1", 1, "Keep the fingerprint check-count based."));
  lastReply.mockReset();
  lastReply.mockResolvedValue(textItem("t-9", 9, "Done: the badge refreshes."));
  render(<CommandPalette />);
});

afterEach(() => {
  cleanup();
  act(() => {
    useUiStore.getState().closePalette();
  });
});

async function openWithChord(): Promise<void> {
  act(() => {
    handleKeyDown(new KeyboardEvent("keydown", { key: "f", code: "KeyF", metaKey: true, shiftKey: true, bubbles: true }));
  });
  await settle(10);
}

const input = () => screen.getByTestId("search-input");
async function type(q: string): Promise<void> {
  fireEvent.change(input(), { target: { value: q } });
  await wait(SEARCH_DEBOUNCE_MS + 20);
}
const key = async (k: string) => {
  fireEvent.keyDown(input(), { key: k });
  await wait(PREVIEW_DEBOUNCE_MS + 20);
};
const selectedKey = () => {
  const el = document.querySelector('[data-testid="search-row"][data-selected]');
  return el ? `${el.getAttribute("data-kind") ?? ""}:${el.getAttribute("data-item") ?? el.getAttribute("data-thread") ?? ""}` : null;
};
/** Each row: its kind, then its parts' text split by "|", tinted matches in [brackets]. */
const rows = () =>
  Array.from(document.querySelectorAll('[data-testid="search-list"] > div > div')).map((wrapper) => {
    const r = wrapper.firstElementChild?.cloneNode(true) as Element;
    for (const m of Array.from(r.querySelectorAll("mark"))) m.replaceWith(`[${m.textContent}]`);
    const parts = r.children.length > 0 ? Array.from(r.children).map((c) => c.textContent) : [r.textContent];
    return `${r.getAttribute("data-kind") ?? "section"} ${parts.filter(Boolean).join("|")}`;
  });

describe("the Find dialog", () => {
  it("opens from cmd+shift+f anywhere, wide, its field focused, with the empty hint", async () => {
    act(() => {
      useUiStore.getState().select({ kind: "page", name: "pullrequests" } as never);
    });
    await openWithChord();
    expect(useUiStore.getState().palette.page).toBe("search");
    expect(screen.getByTestId("search-dialog")).toBeTruthy();
    expect(document.activeElement).toBe(input());
    expect(screen.getByTestId("search-empty").textContent).toMatch(/Search every thread's name and messages/);
    expect(document.querySelector('[data-slot="dialog-content"]')?.className).toMatch(/w-\[min\(1000px/);
    expect(search).not.toHaveBeenCalled();
  });

  it("lists names then messages grouped by thread, matches tinted, the first row selected and previewed", async () => {
    await openWithChord();
    await type("fingerprint");
    expect(search).toHaveBeenCalledTimes(1);
    expect(rows()).toEqual([
      "section Threads",
      "name Badge [fingerprint]|code-foundry · archived|Oct 19",
      "section Messages · 5 in 1 thread",
      "group Fix stale PR badge|code-foundry|5",
      "hit You|keep the [fingerprint]",
      "hit Claude|…the [fingerprint] now",
      "more 3 more",
    ]);
    expect(selectedKey()).toBe("name:s-a");
    await wait(PREVIEW_DEBOUNCE_MS + 20);
    expect(lastReply).toHaveBeenCalledWith("s-a");
    expect(screen.getByTestId("search-preview-speaker").textContent).toBe("Latest from Claude");
    expect(screen.queryByTestId("search-preview-caption")).toBeNull();
  });

  it("drops a late answer to an older query", async () => {
    await openWithChord();
    let late: (v: SearchResultView) => void = () => undefined;
    search.mockImplementationOnce(() => new Promise((r) => (late = r)));
    await type("finger");
    await type("fingerprint");
    act(() => {
      late(answer("finger", { threads: [], groups: [] }));
    });
    await settle(10);
    expect(rows()[0]).toBe("section Threads");
    expect(selectedKey()).toBe("name:s-a");
  });

  it("arrows move through names and hits; a Claude hit previews under the prompt before it, with a count", async () => {
    await openWithChord();
    await type("fingerprint");
    await key("ArrowDown");
    expect(selectedKey()).toBe("hit:u-1");
    expect(hitItem).toHaveBeenLastCalledWith("s-b", "u-1", 1);
    expect(promptBefore).not.toHaveBeenCalled();
    expect(screen.getByTestId("search-preview-speaker").textContent).toBe("You");
    expect(screen.getByTestId("search-preview-caption").textContent).toBe("1 match of “fingerprint” · opening keeps it in the thread's find bar");
    await key("ArrowDown");
    expect(selectedKey()).toBe("hit:t-4");
    expect(promptBefore).toHaveBeenCalledWith("s-b", 4);
    expect(screen.getByTestId("search-preview-prompt").textContent).toContain("Keep the fingerprint");
    expect(screen.getByTestId("search-preview-text").textContent).toContain("now has the head");
    expect(screen.getByTestId("search-preview-caption").textContent).toMatch(/^2 matches of “fingerprint”/);
    expect(screen.getByTestId("search-preview-crumb").textContent).toContain("Fix stale PR badge");
    // Wraps to the first name; Up goes back.
    await key("ArrowDown");
    expect(selectedKey()).toBe("name:s-a");
    await key("ArrowUp");
    expect(selectedKey()).toBe("hit:t-4");
    // A row visited before is not read again.
    const reads = hitItem.mock.calls.length;
    await key("ArrowUp");
    expect(hitItem.mock.calls.length).toBe(reads);
  });

  it("Enter on a hit selects its thread, closes, and hands the query and message to the thread's find bar", async () => {
    await openWithChord();
    await type("stale fingerprint");
    await key("ArrowDown");
    await key("ArrowDown");
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle(10);
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-b" });
    // Several terms: the longest goes to the bar, which takes the first match in the message.
    expect(useThreadFindStore.getState().byThread["s-b"]).toMatchObject({ query: "fingerprint", aim: { kind: "item", itemId: "t-4" } });
  });

  it("the caption counts only the word the find bar takes over, though the paint covers every word", async () => {
    await openWithChord();
    await type("head fingerprint");
    await key("ArrowDown");
    await key("ArrowDown");
    expect(selectedKey()).toBe("hit:t-4");
    // "head" occurs once, "fingerprint" twice: the bar counts "fingerprint" only.
    expect(screen.getByTestId("search-preview-caption").textContent).toBe("2 matches of “fingerprint” · opening keeps it in the thread's find bar");
  });

  it("a click while a newer query is out opens the row with the query its rows answer, and the preview keeps that query", async () => {
    await openWithChord();
    await type("fingerprint");
    await key("ArrowDown");
    expect(screen.getByTestId("search-preview-caption").textContent).toMatch(/^1 match of “fingerprint”/);
    search.mockImplementation(() => new Promise(() => undefined));
    await type("fingerprintzzz");
    // The answer to "fingerprint" stays on screen; the preview does not repaint with the typed text.
    expect(selectedKey()).toBe("hit:u-1");
    expect(screen.getByTestId("search-preview-caption").textContent).toMatch(/^1 match of “fingerprint”/);
    fireEvent.click(document.querySelector('[data-kind="hit"][data-item="u-1"]')?.parentElement as Element);
    await settle(10);
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(useThreadFindStore.getState().byThread["s-b"]).toMatchObject({ query: "fingerprint", aim: { kind: "item", itemId: "u-1" } });
  });

  it("an input method's Enter (WebKit: keyCode 229 after compositionend) opens nothing", async () => {
    await openWithChord();
    await type("fingerprint");
    fireEvent.keyDown(input(), { key: "Enter", keyCode: 229 });
    await settle(10);
    expect(useUiStore.getState().palette.open).toBe(true);
    // An input method's arrow keys stay with it too.
    fireEvent.keyDown(input(), { key: "ArrowDown", keyCode: 229 });
    expect(selectedKey()).toBe("name:s-a");
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle(10);
    expect(useUiStore.getState().palette.open).toBe(false);
  });

  it("Enter on a thread name opens the thread with its prompt focused; no find bar", async () => {
    await openWithChord();
    await type("fingerprint");
    const before = useUiStore.getState().promptFocusSeq;
    fireEvent.keyDown(input(), { key: "Enter" });
    await settle(10);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-a" });
    expect(useUiStore.getState().promptFocusSeq).toBe(before + 1);
    expect(useThreadFindStore.getState().byThread["s-a"]).toBeUndefined();
  });

  it("a click on a thread's header under Messages opens it with its find bar from the top", async () => {
    await openWithChord();
    await type("fingerprint");
    fireEvent.click(document.querySelector('[data-kind="group"]')?.parentElement as Element);
    await settle(10);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-b" });
    expect(useThreadFindStore.getState().byThread["s-b"]).toMatchObject({ query: "fingerprint", aim: { kind: "view" } });
  });

  it("Enter before the typed query's answer waits for it and opens its first row", async () => {
    await openWithChord();
    fireEvent.change(input(), { target: { value: "fingerprint" } });
    fireEvent.keyDown(input(), { key: "Enter" });
    expect(useUiStore.getState().palette.open).toBe(true);
    await wait(SEARCH_DEBOUNCE_MS + 20);
    expect(useUiStore.getState().palette.open).toBe(false);
    expect(useUiStore.getState().selection).toEqual({ kind: "thread", id: "s-a" });
  });

  it("shows Aa only for a case-sensitive answer, a note for names only, and a hint when nothing matches", async () => {
    await openWithChord();
    search.mockImplementation((q) => Promise.resolve(answer(q, { caseSensitive: true })));
    await type("Fingerprint");
    expect(screen.getByTestId("search-case").textContent).toBe("Aa");
    search.mockImplementation((q) => Promise.resolve(answer(q, { groups: [], namesOnly: true, totalHits: 0, totalThreads: 0 })));
    await type("fi");
    expect(screen.queryByTestId("search-case")).toBeNull();
    expect(screen.getByTestId("search-note").textContent).toBe("Messages need a word of three letters or more.");
    search.mockImplementation((q) => Promise.resolve(answer(q, { threads: [], groups: [], totalHits: 0, totalThreads: 0 })));
    await type("zzqx");
    expect(screen.getByTestId("search-empty").textContent).toBe("No threads or messages match “zzqx”.");
  });
});
