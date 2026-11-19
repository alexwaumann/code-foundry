import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const openPullRequestDiff = vi.hoisted(() => vi.fn(() => true));
vi.mock("@/stores/prDiffPanel", () => ({ openPullRequestDiff }));

const { DiffButton } = await import("./DiffButton");

/**
 * The inner tab row's Diff button on its own. jsdom evaluates no container query, so the
 * widths are the classes that hide each part; e2e/pr-panel.spec.ts measures them.
 */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

const ref = { slug: "acme/app", number: 7 };

describe("DiffButton", () => {
  it("reads Diff, the files and the lines; the files go under 480px of surface, the lines under 360px", () => {
    render(<DiffButton prRef={ref} target="view:pullrequests" stat={{ files: 3, added: 1420, deleted: 5 }} />);
    expect(screen.getByTestId("pr-diff-button").textContent).toBe("Diff3 files+1,420 −5");
    expect(screen.getByTestId("pr-diff-button-files").className).toContain("@max-[480px]:hidden");
    expect(screen.getByTestId("pr-diff-button-lines").className).toContain("@max-[360px]:hidden");
    // The lines in the success and failure tones.
    const [added, deleted] = [...screen.getByTestId("pr-diff-button-lines").children];
    expect(added?.className).toBe("text-cf-success-text");
    expect(deleted?.className).toBe("text-cf-error-text");
  });

  it("one file is a file; no counts before the detail has them", () => {
    const { rerender } = render(<DiffButton prRef={ref} target="" stat={{ files: 1, added: 2, deleted: 0 }} />);
    expect(screen.getByTestId("pr-diff-button-files").textContent).toBe("1 file");
    rerender(<DiffButton prRef={ref} target="" stat={null} />);
    expect(screen.getByTestId("pr-diff-button").textContent).toBe("Diff");
  });

  it("opens the diff tab for its pull request in the surface's target (the window's when it has none)", () => {
    const { rerender } = render(<DiffButton prRef={ref} target="thread:s-1" stat={null} />);
    fireEvent.click(screen.getByTestId("pr-diff-button"));
    rerender(<DiffButton prRef={ref} target="" stat={null} />);
    fireEvent.click(screen.getByTestId("pr-diff-button"));
    expect(openPullRequestDiff.mock.calls).toEqual([
      [ref, "thread:s-1"],
      [ref, "current"],
    ]);
  });
});
