// @vitest-environment jsdom
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CheckView, PullRequestDetailView } from "@/api/gh";
import { CheckList } from "./PrChecks";

const NOW = new Date(2026, 10, 18, 12, 0, 0).getTime();
const M = 60_000;

const check = (name: string, o: Partial<CheckView>): CheckView => ({
  name,
  workflow: "CI",
  status: "completed",
  conclusion: "success",
  url: "",
  description: "",
  startedAtMs: NOW - 5 * M,
  completedAtMs: NOW - 3 * M,
  ...o,
});

const detail = (checks: CheckView[], truncated = false) => ({ checks, checksTruncated: truncated, lastError: "", fetchFailed: false }) as unknown as PullRequestDetailView;

const metas = () => screen.getAllByTestId("pr-check-meta").map((m) => m.textContent);

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("CheckList", () => {
  it("each row says queued while queued, its elapsed time while running (ticking), and how long it took once done", () => {
    vi.useFakeTimers({ now: NOW });
    const checks = [
      check("release-notes", { status: "queued", conclusion: "", startedAtMs: null, completedAtMs: null }),
      check("e2e (webkit)", { status: "in_progress", conclusion: "", startedAtMs: NOW - 6 * M - 40_000, completedAtMs: null }),
      check("lint", { startedAtMs: NOW - 2 * M, completedAtMs: NOW - M - 12_000 }),
    ];
    render(<CheckList d={detail(checks)} />);
    expect(metas()).toEqual(["queued", "6m 40s", "48s"]);
    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(metas()).toEqual(["queued", "6m 43s", "48s"]);
  });

  it("only the checks given (a folded card), without the truncation note; every check with it otherwise", () => {
    const all = [check("a", { conclusion: "failure" }), check("b", {})];
    const { rerender } = render(<CheckList d={detail(all, true)} checks={[all[0] as CheckView]} />);
    expect(screen.getAllByTestId("pr-check").map((c) => c.textContent)).toEqual([expect.stringContaining("a") as string]);
    expect(screen.queryByTestId("pr-truncated")).toBeNull();
    rerender(<CheckList d={detail(all, true)} />);
    expect(screen.getAllByTestId("pr-check")).toHaveLength(2);
    expect(screen.getByTestId("pr-truncated")).toBeTruthy();
  });
});
