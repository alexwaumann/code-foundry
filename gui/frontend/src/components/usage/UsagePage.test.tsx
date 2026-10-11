import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionView, UsageBucketView } from "@/api/session";
import { useSessionsStore } from "@/stores/sessions";
import { useUiStore } from "@/stores/ui";
import { useViewsStore } from "@/stores/views";
import { UsagePage } from "./UsagePage";

function bucket(over: Partial<UsageBucketView>): UsageBucketView {
  return { model: "claude-opus-5-5", tier: "", speed: "", day: "2026-10-10", requests: 1, input: 0, output: 0, cacheRead: 0, cacheWrite5m: 0, cacheWrite1h: 0, costUsd: 0, unpriced: false, ...over };
}

function setUsage(threads: Record<string, UsageBucketView[]>, retired: UsageBucketView[] = []): void {
  const byId: Record<string, SessionView> = {};
  for (const [id, usage] of Object.entries(threads)) byId[id] = { id, usage } as SessionView;
  useSessionsStore.setState({ byId, order: Object.keys(threads), retiredUsage: retired });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-10T15:00:00Z"));
  useUiStore.setState({ usageRange: 30, terminalFocusSeq: 0 });
  useViewsStore.setState({ settingsOpen: false, usageOpen: true, helpOpen: false });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

const rows = () => screen.queryAllByTestId("usage-model-row").map((r) => r.getAttribute("data-model"));

describe("UsagePage", () => {
  it("shows the total, the summary line, the table with an unpriced row and the bucket strip", () => {
    setUsage(
      {
        a: [bucket({ requests: 3, input: 1_000, cacheRead: 1_000_000, output: 2_000, costUsd: 4.5 }), bucket({ model: "claude-opus-5", unpriced: true, requests: 2, cacheRead: 28_400_000, day: "2026-10-09" })],
        b: [bucket({ model: "claude-haiku-5-5", requests: 1_200, cacheRead: 3_000, costUsd: 0.5 })],
        idle: [],
      },
      [bucket({ model: "claude-fable-5-1", requests: 1, cacheWrite1h: 500, costUsd: 5, day: "2026-10-01" })],
    );
    render(<UsagePage />);
    expect(screen.getByTestId("usage-total").textContent).toBe("$10.00");
    expect(screen.getByTestId("usage-summary").textContent).toBe("29.41M tokens · 1,206 requests · 2 threads");
    expect(rows()).toEqual(["claude-fable-5-1", "claude-opus-5-5", "claude-haiku-5-5", "claude-opus-5"]);
    const unpriced = screen.getAllByTestId("usage-model-row")[3];
    if (!unpriced) throw new Error("no unpriced row");
    expect(within(unpriced).getByTestId("usage-unpriced").textContent).toBe("unpriced");
    expect(within(unpriced).getAllByRole("cell").map((c) => c.textContent)).toEqual(["claude-opus-5unpriced", "2", "28.40M", "—", "—"]);
    const opus = screen.getAllByTestId("usage-model-row")[1];
    expect(opus && within(opus).getAllByRole("cell").map((c) => c.textContent)).toEqual(["claude-opus-5-5", "3", "1.00M", "$4.50", "45.0%"]);
    expect(screen.getByTestId("usage-buckets").textContent).toBe("Input1.0KCache read29.40MCache write · 5m0Cache write · 1h500Output2.0K");
  });

  it("folds models without a slot into Other on the chart and legend, but lists them by id", () => {
    setUsage({ a: [bucket({ model: "claude-opus-4-8", cacheRead: 10, costUsd: 1 }), bucket({ model: "claude-opus-5", cacheRead: 5, unpriced: true }), bucket({ cacheRead: 1, costUsd: 1 })] });
    render(<UsagePage />);
    const legend = screen.getByTestId("usage-legend");
    expect([...legend.querySelectorAll("[data-series]")].map((e) => e.textContent)).toEqual(["claude-opus-5-5", "Other"]);
    const today = screen.getByTestId("usage-chart").querySelector('g[data-day="2026-10-10"]');
    expect([...(today?.querySelectorAll("path[data-series]") ?? [])].map((p) => p.getAttribute("data-series"))).toEqual(["claude-opus-5-5", "other"]);
    expect(rows()).toEqual(["claude-opus-4-8", "claude-opus-5-5", "claude-opus-5"]);
  });

  it("has one day slot per day of the range, and the range control filters and persists", () => {
    setUsage({ a: [bucket({ costUsd: 1, cacheRead: 1 }), bucket({ costUsd: 2, cacheRead: 1, day: "2026-10-04" }), bucket({ costUsd: 4, cacheRead: 1, day: "2026-08-01" })] });
    render(<UsagePage />);
    expect(screen.getAllByTestId("usage-day")).toHaveLength(30);
    expect(screen.getByTestId("usage-total").textContent).toBe("$3.00");
    expect(screen.getByTestId("usage-range-30").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("usage-range-90"));
    expect(useUiStore.getState().usageRange).toBe(90);
    expect(screen.getAllByTestId("usage-day")).toHaveLength(90);
    expect(screen.getByTestId("usage-total").textContent).toBe("$7.00");
    fireEvent.click(screen.getByTestId("usage-range-1"));
    expect(screen.getByTestId("usage-total").textContent).toBe("$1.00");
    expect(screen.getByTestId("usage-summary").textContent).toBe("1 token · 1 request · 1 thread");
  });

  it("says so when the range has no usage", () => {
    setUsage({ a: [bucket({ day: "2026-01-01", costUsd: 3, cacheRead: 9 })] });
    render(<UsagePage />);
    expect(screen.getByTestId("usage-empty").textContent).toBe("No usage in this range");
    expect(screen.getByTestId("usage-total").textContent).toBe("$0.00");
    expect(screen.queryByTestId("usage-chart")).toBeNull();
    expect(screen.queryByTestId("usage-models")).toBeNull();
  });

  it("switches the chart between tokens and cost, and shows a day's tooltip", () => {
    setUsage({ a: [bucket({ cacheRead: 2_000_000, costUsd: 1.25 }), bucket({ model: "claude-fable-5-1", cacheRead: 1_000_000, costUsd: 3 })] });
    render(<UsagePage />);
    expect(screen.getByTestId("usage-chart").getAttribute("data-mode")).toBe("tokens");
    const day = screen.getAllByTestId("usage-day").at(-1);
    if (!day) throw new Error("no day");
    fireEvent.mouseMove(day, { clientX: 10, clientY: 10 });
    expect(screen.getByTestId("usage-tooltip").textContent).toBe("Oct 10claude-opus-5-52.00Mclaude-fable-5-11.00MTotal3.00M");
    fireEvent.click(screen.getByTestId("usage-mode-cost"));
    expect(screen.getByTestId("usage-chart").getAttribute("data-mode")).toBe("cost");
    expect(screen.getByTestId("usage-tooltip").textContent).toBe("Oct 10claude-opus-5-5$1.25claude-fable-5-1$3.00Total$4.25");
    fireEvent.mouseLeave(day);
    expect(screen.queryByTestId("usage-tooltip")).toBeNull();
  });

  it("closes with the × and with Escape", () => {
    setUsage({});
    render(<UsagePage />);
    fireEvent.click(screen.getByTestId("usage-close"));
    expect(useViewsStore.getState().usageOpen).toBe(false);
    act(() => {
      useViewsStore.setState({ usageOpen: true });
    });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(useViewsStore.getState().usageOpen).toBe(false);
  });
});
