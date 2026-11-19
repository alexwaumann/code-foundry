import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ThreadView } from "@/api/threads";
import { TILT_MS } from "@/lib/arrivals";
import { note, noteEvent } from "@/test/notificationFakes";
import { thread } from "@/test/projectsWorld";
import { noteNotificationArrivals, resetArrivals, startArrivals, useArrivalsStore, useTilt } from "./arrivals";
import { useThreadsStore } from "./threads";

/**
 * The arrivals store (docs/notes/arrival-tilt.md): what it notes from the threads and the
 * notification events, that it forgets them after TILT_MS, and that an icon's tilt carries on
 * across a re-mount and a re-render instead of starting over.
 */

const ask = (id: string, reason = "permission: Bash") => thread(id, { status: "attention", statusReason: reason });

/** The threads store as the events stream sets it: a replaced list bumps the epoch. */
function replace(...ts: ThreadView[]): void {
  useThreadsStore.setState((s) => ({ byId: Object.fromEntries(ts.map((t) => [t.id, t])), order: ts.map((t) => t.id), loaded: true, epoch: s.epoch + 1 }));
}
function update(t: ThreadView): void {
  useThreadsStore.setState((s) => ({ byId: { ...s.byId, [t.id]: t }, order: s.order.includes(t.id) ? s.order : [...s.order, t.id] }));
}

let now = 10_000;
const clock = () => now;
let stop: () => void = () => undefined;

beforeEach(() => {
  vi.useFakeTimers();
  now = 10_000;
  resetArrivals();
  useThreadsStore.setState({ byId: {}, order: [], loaded: false, epoch: 0 });
  stop = startArrivals(clock);
});

afterEach(() => {
  stop();
  cleanup();
  vi.useRealTimers();
});

const threads = () => useArrivalsStore.getState().threads;

describe("startArrivals", () => {
  it("the list the app loads with is the baseline: a thread already asking does not tilt", () => {
    replace(ask("a"), thread("b"));
    expect(threads()).toEqual({});
  });

  it("notes a thread that starts asking, once, at the time it did", () => {
    replace(thread("a"));
    now = 12_000;
    update(ask("a"));
    expect(threads()).toEqual({ a: 12_000 });
    now = 12_100;
    update(ask("a", "question: Which?"));
    expect(threads()).toEqual({ a: 12_000 });
  });

  it("notes a new thread that comes in asking", () => {
    replace();
    update(ask("n"));
    expect(Object.keys(threads())).toEqual(["n"]);
  });

  it("a reconnect's list is a baseline: what started asking while away does not tilt", () => {
    replace(thread("a"));
    replace(ask("a"));
    expect(threads()).toEqual({});
  });

  it("forgets an arrival after TILT_MS; leaving and asking again is a new one", () => {
    replace(thread("a"));
    update(ask("a"));
    now += TILT_MS;
    vi.advanceTimersByTime(TILT_MS);
    expect(threads()).toEqual({});
    update(thread("a", { status: "busy" }));
    now += 5000;
    update(ask("a"));
    expect(threads()).toEqual({ a: now });
  });
});

describe("noteNotificationArrivals", () => {
  it("tilts the bell for a shown arrival, not for a connect's snapshot or an update", () => {
    noteNotificationArrivals(noteEvent([note("n-1")]), clock);
    noteNotificationArrivals(noteEvent([note("n-1")], [], ["n-1"]), clock);
    expect(useArrivalsStore.getState().bell).toBeNull();
    noteNotificationArrivals(noteEvent([note("n-1"), note("n-2")], ["n-2"]), clock);
    expect(useArrivalsStore.getState().bell).toBe(now);
    now += TILT_MS;
    vi.advanceTimersByTime(TILT_MS);
    expect(useArrivalsStore.getState().bell).toBeNull();
  });
});

/** An icon as the three places draw one: the tilt's class and its ref callback. */
function Icon({ at }: { at: number | null }) {
  const { className, place } = useTilt(at, null, clock);
  return <svg data-testid="icon" className={className} ref={place} />;
}

describe("useTilt", () => {
  it("nothing without an arrival", () => {
    const { container } = render(<Icon at={null} />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("class")).toBeNull();
    expect(svg.style.animationDelay).toBe("");
  });

  it("an icon there as it arrives tilts from the start", () => {
    const { container, rerender } = render(<Icon at={null} />);
    rerender(<Icon at={now} />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("class")).toBe("animate-arrival-tilt");
    expect(svg.style.animationDelay).toBe("0ms");
  });

  it("a re-render does not move the tilt; a re-mount carries on where it is", () => {
    const at = now;
    const { container, rerender, unmount } = render(<Icon at={at} />);
    now += 500;
    rerender(<Icon at={at} />);
    expect((container.querySelector("svg") as SVGElement).style.animationDelay).toBe("0ms");
    unmount();
    // A virtualized row scrolled back, or the rail swapped for the expanded list, 600ms in.
    now += 100;
    const again = render(<Icon at={at} />);
    expect((again.container.querySelector("svg") as SVGElement).style.animationDelay).toBe("-600ms");
  });

  it("the tilt's class goes when the arrival is forgotten", () => {
    const { container, rerender } = render(<Icon at={now} />);
    rerender(<Icon at={null} />);
    const svg = container.querySelector("svg") as SVGElement;
    expect(svg.getAttribute("class")).toBeNull();
    expect(svg.style.animationDelay).toBe("");
  });

  it("its ref callback stays the same across re-renders of one arrival, so React does not set the delay again", () => {
    const { result, rerender } = renderHook(({ at }) => useTilt(at, null, clock), { initialProps: { at: 1 as number | null } });
    const first = result.current.place;
    rerender({ at: 1 });
    expect(result.current.place).toBe(first);
    act(() => {
      rerender({ at: 2 });
    });
    expect(result.current.place).not.toBe(first);
  });
});
