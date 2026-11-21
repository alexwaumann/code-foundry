import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ROW_STAGGER_MS, SHIMMER_PERIOD_MS, shimmerPhase } from "@/lib/shimmer";
import { Shimmer } from "./Shimmer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("shimmerPhase", () => {
  it.each([
    { name: "at the page clock's start", kind: "head" as const, now: 0, offset: 0, want: "-0ms" },
    { name: "a header mid-sweep", kind: "head" as const, now: 2500, offset: 0, want: "-500ms" },
    { name: "a row mid-sweep", kind: "row" as const, now: 2500, offset: 0, want: "-100ms" },
    { name: "a row a stagger behind", kind: "row" as const, now: 2500, offset: ROW_STAGGER_MS, want: `-${String(2500 - ROW_STAGGER_MS)}ms` },
    { name: "an offset past the page time wraps into the period", kind: "row" as const, now: 100, offset: 3 * ROW_STAGGER_MS, want: `-${String(100 - 3 * ROW_STAGGER_MS + SHIMMER_PERIOD_MS.row)}ms` },
  ])("$name", ({ kind, now, offset, want }) => {
    expect(shimmerPhase(kind, now, offset)).toBe(want);
  });
});

describe("Shimmer", () => {
  it("keeps the page clock's phase when it mounts again, and its kind's period", () => {
    const now = vi.spyOn(performance, "now").mockReturnValue(1300);
    const first = render(<Shimmer kind="row">Running ls</Shimmer>).container.querySelector<HTMLElement>(".shimmer");
    expect(first?.style.animationDelay).toBe("-1300ms");
    expect(first?.style.animationDuration).toBe(`${String(SHIMMER_PERIOD_MS.row)}ms`);
    expect(first?.getAttribute("data-shimmer")).toBe("row");
    cleanup();
    // 1.5 s later it mounts again, 1.5 s further on: where a never-unmounted one would be.
    now.mockReturnValue(2800);
    const again = render(<Shimmer kind="row">Running ls</Shimmer>).container.querySelector<HTMLElement>(".shimmer");
    expect(again?.style.animationDelay).toBe("-400ms");
  });

  it("a header's by default", () => {
    const el = render(<Shimmer>Working</Shimmer>).container.querySelector<HTMLElement>(".shimmer");
    expect(el?.getAttribute("data-shimmer")).toBe("head");
    expect(el?.style.animationDuration).toBe(`${String(SHIMMER_PERIOD_MS.head)}ms`);
    expect(el?.textContent).toBe("Working");
  });
});
