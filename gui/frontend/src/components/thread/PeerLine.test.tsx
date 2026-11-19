import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadItemView } from "@/api/thread";
import type { ThreadView } from "@/api/threads";
import { sentTime } from "@/lib/format";
import { peerTime } from "@/lib/peerLines";
import type { PeerRow } from "@/lib/threadTimeline";
import { openThreadFindItem, useThreadFindStore } from "@/stores/threadFind";
import { useThreadStore } from "@/stores/thread";
import { useThreadsStore } from "@/stores/threads";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

const { openThread } = vi.hoisted(() => ({ openThread: vi.fn() }));
vi.mock("@/stores/openThread", () => ({ openThread }));

const NOW = new Date("2026-11-19T15:00:00Z").getTime();
const M = 60_000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  const t = (id: string, name: string) => ({ id, name }) as ThreadView;
  useThreadsStore.setState({ byId: { P: t("P", "PR page redesign"), Q: t("Q", "Sidebar rail") } });
});

afterEach(() => {
  cleanup();
  openThread.mockClear();
  vi.useRealTimers();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
  useThreadFindStore.setState({ byThread: {} });
});

function show(node: React.ReactNode) {
  return render(<ThreadContext.Provider value={{ threadId: "L", cwd: "/w" }}>{node}</ThreadContext.Provider>).container;
}

const line = (o: Partial<PeerRow> = {}): PeerRow => ({ type: "peer", key: "p:u1:P", id: "P", words: "asked · waiting for a reply", tone: "warning", live: true, start: NOW - 26 * M, end: null, ...o });

describe("another thread's line", () => {
  it("live: the dot's tone, the name, the words and how long since the exchange began; it opens the thread", () => {
    const c = show(<TimelineRowView row={line()} />);
    const el = c.querySelector<HTMLElement>('[data-testid="thread-peer"]');
    expect(el?.tagName).toBe("BUTTON");
    expect(el?.querySelector(".dot")?.className).toContain("bg-cf-warning");
    expect(el?.querySelector('[data-testid="thread-peer-name"]')?.textContent).toBe("PR page redesign");
    expect(el?.querySelector('[data-testid="thread-peer-words"]')?.textContent).toBe("asked · waiting for a reply");
    expect(el?.querySelector('[data-testid="thread-peer-time"]')?.textContent).toBe("26m");
    expect(el?.dataset.live).toBe("true");
    if (el) fireEvent.click(el);
    expect(openThread).toHaveBeenCalledWith("P", { from: "L" });
  });

  it("frozen: the time it froze at, as message times read, and no live mark", () => {
    const at = NOW - 4 * M;
    const c = show(<TimelineRowView row={line({ live: false, end: at, words: "replied · then asked 1 question, answered", tone: "success" })} />);
    const el = c.querySelector<HTMLElement>('[data-testid="thread-peer"]');
    expect(el?.querySelector('[data-testid="thread-peer-time"]')?.textContent).toBe(sentTime(at));
    expect(el?.dataset.live).toBeUndefined();
  });

  it("a removed thread: plain text, not a link", () => {
    const c = show(<TimelineRowView row={line({ id: "Z" })} />);
    const el = c.querySelector<HTMLElement>('[data-testid="thread-peer"]');
    expect(el?.tagName).toBe("DIV");
    expect(el?.textContent).toContain("Removed thread");
  });

  it.each([
    { name: "live, minutes", row: { live: true, start: NOW - 3 * M, end: null }, want: "3m" },
    { name: "live, seconds", row: { live: true, start: NOW - 12_000, end: null }, want: "12s" },
    { name: "live, no start", row: { live: true, start: null, end: null }, want: "" },
    { name: "frozen", row: { live: false, start: NOW - 3 * M, end: NOW - M }, want: sentTime(NOW - M) },
  ])("peerTime: $name", ({ row, want }) => {
    expect(peerTime(row, NOW)).toBe(want);
  });
});

const base = { parentToolUseId: "", createdAtMs: NOW - 2 * M, updatedAtMs: NOW - 2 * M, streaming: false };
const message = (o: { wanted: boolean; text?: string }): ThreadItemView => ({
  ...base,
  id: "m1",
  ordinal: 1,
  kind: "user",
  text: o.text ?? "Did #798 change gutterReach's signature?\nThe rebase fails in shell/resize.test.ts.",
  attachments: [],
  composerText: "",
  from: { threadId: "P", relation: "other", reply: o.wanted ? "wanted" : "none" },
});

function seed(it: ThreadItemView) {
  useThreadStore.setState({ logs: { L: { seq: 1, byId: { [it.id]: it }, order: [it.id], pending: [], mcp: null, commands: [], agents: [] } } });
}

describe("a message from another thread (From row)", () => {
  it.each([
    { name: "wants a reply: the tag", wanted: true, tag: "wants a reply" },
    { name: "no reply wanted: no tag", wanted: false, tag: null },
  ])("$name", ({ wanted, tag }) => {
    seed(message({ wanted }));
    const c = show(<TimelineRowView row={{ type: "user", key: "m1", id: "m1" }} />);
    expect(c.querySelector('[data-testid="thread-user"]')).toBeNull();
    const row = c.querySelector<HTMLElement>('[data-testid="thread-from"]');
    expect(row?.querySelector(".lead")?.textContent).toBe("From");
    expect(row?.querySelector('[data-testid="thread-from-name"]')?.textContent).toBe("PR page redesign");
    expect(row?.querySelector('[data-testid="thread-from-tag"]')?.textContent ?? null).toBe(tag);
    expect(row?.querySelector('[data-testid="thread-from-tag"]')?.className ?? "").toContain(tag ? "text-cf-warning-text" : "");
    expect(row?.querySelector('[data-testid="thread-from-summary"]')?.textContent).toBe("Did #798 change gutterReach's signature?");
    expect(row?.querySelector('[data-testid="thread-from-time"]')?.textContent).toBe(sentTime(NOW - 2 * M));
  });

  it("a click opens the whole message in place (searchable), another closes it; Enter does too", () => {
    seed(message({ wanted: true }));
    const c = show(<TimelineRowView row={{ type: "user", key: "m1", id: "m1" }} />);
    const lineEl = c.querySelector<HTMLElement>('[data-testid="thread-from-line"]');
    expect(c.querySelector('[data-testid="thread-from-body"]')).toBeNull();
    if (lineEl) fireEvent.click(lineEl);
    const body = c.querySelector<HTMLElement>('[data-testid="thread-from-body"]');
    expect(body?.textContent).toBe("Did #798 change gutterReach's signature?\nThe rebase fails in shell/resize.test.ts.");
    expect(body?.dataset.findItem).toBe("m1");
    expect(lineEl?.getAttribute("aria-expanded")).toBe("true");
    if (lineEl) fireEvent.click(lineEl);
    expect(c.querySelector('[data-testid="thread-from-body"]')).toBeNull();
    if (lineEl) fireEvent.keyDown(lineEl, { key: "Enter" });
    expect(c.querySelector('[data-testid="thread-from-body"]')).not.toBeNull();
  });

  it("the name opens that thread and does not toggle the row", () => {
    seed(message({ wanted: false }));
    const c = show(<TimelineRowView row={{ type: "user", key: "m1", id: "m1" }} />);
    const name = c.querySelector<HTMLElement>('[data-testid="thread-from-name"]');
    if (name) fireEvent.click(name);
    expect(openThread).toHaveBeenCalledWith("P", { from: "L" });
    expect(c.querySelector('[data-testid="thread-from-body"]')).toBeNull();
  });

  it("the find bar opens it for a match inside", () => {
    seed(message({ wanted: false }));
    useThreadFindStore.setState({ byThread: { L: { query: "rebase", current: null, opened: null } as never } });
    openThreadFindItem("L", "m1");
    const c = show(<TimelineRowView row={{ type: "user", key: "m1", id: "m1" }} />);
    expect(c.querySelector('[data-testid="thread-from-body"]')?.textContent).toContain("rebase");
  });

  it("a message from its lead or its worker stays a bubble", () => {
    seed({ ...message({ wanted: true }), from: { threadId: "P", relation: "lead", reply: "wanted" } } as ThreadItemView);
    const c = show(<TimelineRowView row={{ type: "user", key: "m1", id: "m1" }} />);
    expect(c.querySelector('[data-testid="thread-from"]')).toBeNull();
    expect(c.querySelector('[data-testid="thread-user"]')).not.toBeNull();
  });
});
