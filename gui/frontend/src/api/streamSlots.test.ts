import { describe, expect, it, vi } from "vitest";
import { runStream } from "./stream";
import { claimStreamSlot, MAX_OPEN_STREAMS, resettleStreamSlots, useStreamSlotsStore, type StreamPriority } from "./streamSlots";

const tick = () => new Promise((r) => setTimeout(r, 0));

describe("claimStreamSlot", () => {
  it("grants at once while there is room and makes the sixth wait", async () => {
    const tickets = Array.from({ length: MAX_OPEN_STREAMS }, (_, i) => claimStreamSlot(`s${String(i)}`, "core"));
    expect(tickets.every((t) => t.granted())).toBe(true);
    const sixth = claimStreamSlot("sixth", "core");
    expect(sixth.granted()).toBe(false);
    expect(useStreamSlotsStore.getState()).toEqual({ open: MAX_OPEN_STREAMS, waiting: ["sixth"] });
    tickets[0]?.release();
    await expect(sixth.ready).resolves.toBe(true);
    expect(sixth.granted()).toBe(true);
    expect(useStreamSlotsStore.getState()).toEqual({ open: MAX_OPEN_STREAMS, waiting: [] });
  });

  it("serves waiting core claims before inline ones, each in arrival order", () => {
    const held = Array.from({ length: MAX_OPEN_STREAMS }, (_, i) => claimStreamSlot(`c${String(i)}`, "core"));
    claimStreamSlot("inline-a", "inline");
    claimStreamSlot("core-b", "core");
    claimStreamSlot("inline-c", "inline");
    expect(useStreamSlotsStore.getState().waiting).toEqual(["core-b", "inline-a", "inline-c"]);
    held[0]?.release();
    expect(useStreamSlotsStore.getState().waiting).toEqual(["inline-a", "inline-c"]);
  });

  it("lets a core claim take the newest inline holder's slot", () => {
    const preempted: string[] = [];
    for (let i = 0; i < MAX_OPEN_STREAMS - 2; i++) claimStreamSlot(`c${String(i)}`, "core");
    const old = claimStreamSlot("inline-old", "inline", () => preempted.push("inline-old"));
    const recent = claimStreamSlot("inline-new", "inline", () => preempted.push("inline-new"));
    const core = claimStreamSlot("bottom-shell", "core");
    expect(core.granted()).toBe(true);
    expect(preempted).toEqual(["inline-new"]);
    expect(recent.granted()).toBe(false);
    expect(old.granted()).toBe(true);
    expect(useStreamSlotsStore.getState().open).toBe(MAX_OPEN_STREAMS);
  });

  it("never preempts a core holder: a core claim beyond the cap waits", () => {
    for (let i = 0; i < MAX_OPEN_STREAMS; i++) claimStreamSlot(`c${String(i)}`, "core");
    const extra = claimStreamSlot("extra", "core");
    expect(extra.granted()).toBe(false);
    expect(useStreamSlotsStore.getState().waiting).toEqual(["extra"]);
  });

  it("re-reads priorities: a waiting inline claim that became core moves ahead", () => {
    for (let i = 0; i < MAX_OPEN_STREAMS; i++) claimStreamSlot(`c${String(i)}`, "core");
    claimStreamSlot("inline-a", "inline");
    let prio: StreamPriority = "inline";
    claimStreamSlot("shared", () => prio);
    expect(useStreamSlotsStore.getState().waiting).toEqual(["inline-a", "shared"]);
    prio = "core";
    resettleStreamSlots();
    expect(useStreamSlotsStore.getState().waiting).toEqual(["shared", "inline-a"]);
  });

  it("stops waiting on release (harmless twice)", async () => {
    for (let i = 0; i < MAX_OPEN_STREAMS; i++) claimStreamSlot(`c${String(i)}`, "core");
    const w = claimStreamSlot("w", "inline");
    w.release();
    w.release();
    await expect(w.ready).resolves.toBe(false);
    expect(useStreamSlotsStore.getState().waiting).toEqual([]);
  });
});

/** A stream that stays open until aborted; counts opens. */
function hanging() {
  const opened: string[] = [];
  const open = (label: string) =>
    async function* (signal: AbortSignal): AsyncGenerator<number> {
      opened.push(label);
      yield 1;
      await new Promise<void>((r) => {
        signal.addEventListener("abort", () => {
          r();
        });
      });
    };
  return { opened, open };
}

describe("runStream with slots", () => {
  it("never opens more than MAX_OPEN_STREAMS at once; the next opens when one stops", async () => {
    const h = hanging();
    const stops = Array.from({ length: MAX_OPEN_STREAMS + 1 }, (_, i) => runStream({ open: h.open(`s${String(i)}`), onEvent: vi.fn(), slot: { label: `s${String(i)}`, priority: "core" } }));
    await tick();
    expect(h.opened).toHaveLength(MAX_OPEN_STREAMS);
    expect(useStreamSlotsStore.getState().waiting).toEqual([`s${String(MAX_OPEN_STREAMS)}`]);
    stops[0]?.();
    await tick();
    expect(h.opened).toEqual(Array.from({ length: MAX_OPEN_STREAMS + 1 }, (_, i) => `s${String(i)}`));
    for (const s of stops) s();
    await tick();
    expect(useStreamSlotsStore.getState()).toEqual({ open: 0, waiting: [] });
  });

  it("a core stream preempts an inline one, which reopens once there is room again", async () => {
    const h = hanging();
    const stops = Array.from({ length: MAX_OPEN_STREAMS - 1 }, (_, i) => runStream({ open: h.open(`c${String(i)}`), onEvent: vi.fn() }));
    const statuses: string[] = [];
    const stopInline = runStream({ open: h.open("inline"), onEvent: vi.fn(), slot: { label: "inline", priority: "inline" }, onStatus: (s) => statuses.push(s) });
    await tick();
    expect(h.opened).toContain("inline");
    const stopCore = runStream({ open: h.open("core"), onEvent: vi.fn() });
    await tick();
    expect(h.opened.at(-1)).toBe("core");
    expect(useStreamSlotsStore.getState().waiting).toEqual(["inline"]);
    // Preempted, it waits as "connecting", not as an error.
    expect(statuses.at(-1)).toBe("connecting");
    stopCore();
    await tick();
    expect(h.opened.filter((l) => l === "inline")).toHaveLength(2);
    stopInline();
    for (const s of stops) s();
  });
});
