import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryView, ThreadItemView } from "@/api/thread";
import { TooltipProvider } from "@/components/ui/tooltip";
import { sentTime } from "@/lib/format";
import { buildRows, buildTurns, decodeTimelineKey, timelineKey } from "@/lib/threadTimeline";
import { structOf, useThreadStore } from "@/stores/thread";
import { ThreadContext } from "./context";
import { TimelineRowView } from "./rows";

// A steered turn's rows (docs/notes/steer-segments.md): a header per stretch with its
// length, the gutter's total, and a message's caption by what became of it.

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  useThreadStore.setState({ logs: {}, expanded: {}, folds: {} });
});

const T0 = 1_700_000_000_000;
const base = { parentToolUseId: "", createdAtMs: T0, updatedAtMs: T0, streaming: false };

const user = (id: string, ordinal: number, over: { at?: number; delivery?: DeliveryView; readAtMs?: number; placedAfter?: number } = {}): ThreadItemView => ({
  ...base,
  id,
  ordinal,
  kind: "user",
  text: `message ${id}`,
  attachments: [],
  composerText: "",
  createdAtMs: over.at ?? T0,
  ...(over.delivery ? { delivery: over.delivery } : {}),
  ...(over.readAtMs !== undefined ? { readAtMs: over.readAtMs } : {}),
  ...(over.placedAfter ? { placedAfter: over.placedAfter } : {}),
});
const bash = (id: string, ordinal: number): ThreadItemView => ({
  ...base,
  id,
  ordinal,
  kind: "tool",
  toolUseId: id,
  name: "Bash",
  inputJson: `{"command":"run ${id}"}`,
  status: "done",
  output: "",
  isError: false,
  resultJson: "",
});
const text = (id: string, ordinal: number): ThreadItemView => ({ ...base, id, ordinal, kind: "text", text: `text ${id}` });
const turnEnd = (ordinal: number, durationMs: number, over: Partial<Extract<ThreadItemView, { kind: "turnEnd" }>> = {}): ThreadItemView => ({
  ...base,
  // It arrives when the turn ends, on the daemon's clock; Claude's duration_ms runs a little short of it.
  createdAtMs: T0 + durationMs + 400,
  id: "e",
  ordinal,
  kind: "turnEnd",
  subtype: "success",
  isError: false,
  interrupted: false,
  stopReason: "",
  terminalReason: "",
  durationMs,
  numTurns: 1,
  costUsd: 0.5,
  turnCostUsd: 0.62,
  model: "",
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  errors: [],
  ...over,
});

function show(items: ThreadItemView[], working = false) {
  const byId = Object.fromEntries(items.map((it) => [it.id, it]));
  useThreadStore.setState({ logs: { s: { seq: 1, byId, order: items.map((it) => it.id), pending: [], mcp: null, commands: [], agents: [] } } });
  const rows = buildRows(buildTurns(items.map((it) => decodeTimelineKey(timelineKey(structOf(it))))), { fold: () => undefined, working });
  return render(
    <TooltipProvider delayDuration={0}>
      <ThreadContext.Provider value={{ threadId: "s", cwd: "/w" }}>
        {rows.map((r) => (
          <TimelineRowView key={r.key} row={r} />
        ))}
      </ThreadContext.Provider>
    </TooltipProvider>,
  ).container;
}

const headers = (c: HTMLElement) => [...c.querySelectorAll('[data-testid="thread-turn-header"]')].map((h) => h.textContent);
const caption = (c: HTMLElement, i = 0) => c.querySelectorAll('[data-testid="thread-steer-caption"]')[i]?.textContent ?? "";
const time = (ms: number) => sentTime(ms);

// The prompt at T0; s1 read 3m 10s in, s2 read 5m 51s in; the turn took 9m 08s.
const S1 = T0 + 190_000;
const S2 = T0 + 351_000;
const steered = (over: Partial<Extract<ThreadItemView, { kind: "turnEnd" }>> = {}): ThreadItemView[] => [
  user("u1", 1),
  bash("A", 2),
  user("s1", 3, { at: T0 + 120_000, delivery: "read", readAtMs: S1 }),
  bash("B", 4),
  user("s2", 5, { at: T0 + 300_000, delivery: "read", readAtMs: S2 }),
  bash("C", 6),
  text("a", 7),
  turnEnd(8, 548_000, over),
];

describe("a turn split at its steers", () => {
  it("heads each stretch with its length: Worked for, then Continued for; the gutter says the whole", () => {
    const c = show(steered());
    expect(headers(c)).toEqual(["Worked for 3m 10s", "Continued for 2m 41s", "Continued for 3m 17s"]);
    expect(c.querySelector('[data-testid="thread-turn-gutter"] .info')?.textContent).toBe(`9m 8s total·3 steps·$0.62·${time(T0 + 548_400)}`);
  });

  it("an interrupted or failed turn says so on its last stretch, in red", () => {
    const c = show(steered({ interrupted: true, isError: true, subtype: "error_during_execution" }));
    expect(headers(c)).toEqual(["Worked for 3m 10s", "Continued for 2m 41s", "Interrupted after 3m 17s"]);
    expect(c.querySelectorAll('[data-testid="thread-turn-header"]')[2]?.querySelector(".t-red")).not.toBeNull();
  });

  it("each header folds only its stretch", () => {
    const c = show(steered());
    expect(c.textContent).not.toContain("run B");
    fireEvent.click(c.querySelectorAll('[data-testid="thread-turn-header"]')[1]?.querySelector("button") as HTMLElement);
    expect(useThreadStore.getState().folds.s).toEqual({ "u1>s1": false });
  });

  it("captions a read steer with how far into the turn Claude read it, then the time it was sent", () => {
    const c = show(steered());
    expect(caption(c, 0)).toBe(`steered·+3m 10s·${time(T0 + 120_000)}`);
    expect(caption(c, 1)).toBe(`steered·+5m 51s·${time(T0 + 300_000)}`);
  });

  it("live: the stretches before the read steer are settled; the last header counts its own steps and the time since the steer was read", () => {
    vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
    vi.setSystemTime(S1 + 42_000);
    const c = show([user("u1", 1), bash("A", 2), bash("A2", 3), user("s1", 4, { at: T0 + 120_000, delivery: "read", readAtMs: S1 }), bash("B", 5)], true);
    expect(headers(c)).toEqual(["Worked for 3m 10s", "Working·1 step·42s"]);
    expect(c.querySelectorAll('[data-testid="thread-working"]')).toHaveLength(1);
  });
});

describe("a message's caption by what became of it", () => {
  it("queued: the smaller dotted bubble, dimmed, captioned queued and its time; what it means in the tooltip", async () => {
    const c = show([user("u1", 1), bash("A", 2), user("s1", 3, { at: T0 + 60_000, delivery: "queued" })], true);
    const steer = c.querySelector('[data-testid="thread-steer"]');
    expect(steer?.querySelector(".bubble")?.className).toContain("queued");
    expect(caption(c)).toBe(`queued·${time(T0 + 60_000)}`);
    fireEvent.focus(screen.getByTestId("thread-queued"));
    expect((await screen.findByRole("tooltip")).textContent).toContain("Read by Claude at its next tool call");
  });

  it("never read: the queued look, captioned not sent in the warning tone, with why in the tooltip", async () => {
    const c = show([user("u1", 1), bash("A", 2), user("s1", 3, { at: T0 + 60_000, delivery: "unsent", placedAfter: 2 })]);
    const steer = c.querySelector('[data-testid="thread-steer"]');
    expect(steer?.getAttribute("data-delivery")).toBe("unsent");
    expect(steer?.querySelector(".bubble")?.className).toContain("queued");
    expect(caption(c)).toBe(`not sent·${time(T0 + 60_000)}`);
    expect(screen.getByTestId("thread-unsent").className).toContain("text-cf-warning-text");
    fireEvent.focus(screen.getByTestId("thread-unsent"));
    expect((await screen.findByRole("tooltip")).textContent).toContain("Claude stopped before it read this message");
    // It split nothing: no header (the turn never ended), the work still shows.
    expect(headers(c)).toEqual([]);
  });

  it("read, from before read times were kept: steered and the time, and the turn is not split", () => {
    const c = show([user("u1", 1), bash("A", 2), user("s1", 3, { at: T0 + 60_000, delivery: "read" }), text("a", 4), turnEnd(5, 120_000)]);
    expect(caption(c)).toBe(`steered·${time(T0 + 60_000)}`);
    expect(headers(c)).toEqual(["Worked for 2m"]);
    expect(c.querySelector('[data-testid="thread-turn-gutter"] .info')?.textContent).not.toContain("total");
  });

  it("too late: queued under the finished turn it is the small queued bubble; read, it is the next turn's full-size prompt with just its time", () => {
    const waiting = show([user("u1", 1), text("a", 2), turnEnd(3, 2_000), user("q", 4, { at: T0 + 2_500, delivery: "queued" })], true);
    const q = waiting.querySelector('[data-testid="thread-user"][data-delivery="queued"]');
    expect(q?.classList.contains("small")).toBe(true);
    expect(q?.classList.contains("steer")).toBe(false);
    expect(headers(waiting)).toEqual(["Worked for 2.0s"]);
    cleanup();
    const started = show([user("u1", 1), text("a", 2), turnEnd(3, 2_000), user("q", 4, { at: T0 + 2_500, delivery: "read", readAtMs: T0 + 2_600, placedAfter: 3 })], true);
    const p = started.querySelectorAll('[data-testid="thread-user"]')[1];
    expect(p?.classList.contains("small")).toBe(false);
    expect(p?.querySelector(".when")?.textContent).toBe(time(T0 + 2_500));
    expect(started.querySelectorAll('[data-testid="thread-working"]')).toHaveLength(1);
  });
});
