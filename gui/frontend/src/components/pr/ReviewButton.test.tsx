import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView } from "@/api/gh";

vi.mock("@/stores/gh", async (orig) => ({ ...(await orig<typeof import("@/stores/gh")>()), useViewerLogin: () => "me" }));

const { usePrPanelStore } = await import("@/stores/prPanel");
const { pullRequestKey } = await import("@/stores/gh");
const { ReviewButton } = await import("./ReviewButton");

const REF = { slug: "acme/repo", number: 7 };
const KEY = pullRequestKey(REF.slug, REF.number);
const detail = { pullRequest: { state: "open", author: "kim" }, reviewers: [], viewerCanUpdate: true } as unknown as PullRequestDetailView;

afterEach(() => {
  cleanup();
  usePrPanelStore.setState({ reviewing: {} });
});

/** Radix opens a dropdown on pointerdown (left button, no ctrl). */
function press(el: HTMLElement): void {
  fireEvent.pointerDown(el, { button: 0, ctrlKey: false, pointerType: "mouse" });
}

describe("ReviewButton", () => {
  it("a review starting elsewhere shuts the open menu, and it stays shut once that review settles", () => {
    render(<ReviewButton prRef={REF} detail={detail} onChoose={vi.fn()} />);
    press(screen.getByTestId("pr-review-button"));
    expect(screen.queryByTestId("pr-review-menu")).not.toBeNull();
    act(() => {
      usePrPanelStore.setState({ reviewing: { [KEY]: true } });
    });
    expect(screen.queryByTestId("pr-review-menu")).toBeNull();
    act(() => {
      usePrPanelStore.setState({ reviewing: {} });
    });
    expect(screen.queryByTestId("pr-review-menu")).toBeNull();
    expect(screen.getByTestId("pr-review-button").getAttribute("aria-expanded")).toBe("false");
  });

  it("choosing a verdict hands it on and shuts the menu", () => {
    const onChoose = vi.fn();
    render(<ReviewButton prRef={REF} detail={detail} onChoose={onChoose} />);
    press(screen.getByTestId("pr-review-button"));
    fireEvent.click(screen.getByTestId("pr-review-comment"));
    expect(onChoose).toHaveBeenCalledExactlyOnceWith("comment");
    expect(screen.queryByTestId("pr-review-menu")).toBeNull();
  });
});
