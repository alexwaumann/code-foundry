import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView } from "@/api/gh";

const viewer = vi.hoisted(() => ({ login: "me" }));
vi.mock("@/stores/gh", async (orig) => ({ ...(await orig<typeof import("@/stores/gh")>()), useViewerLogin: () => viewer.login }));

const { usePrPanelStore } = await import("@/stores/prPanel");
const { pullRequestDetailResource, pullRequestKey, VIEWER_KEY, viewerResource } = await import("@/stores/gh");
const { setReviewDraft, useReviewDialogStore } = await import("@/stores/reviewDialog");
const { PrDiffReviewButton, ReviewButton } = await import("./ReviewButton");

const REF = { slug: "acme/repo", number: 7 };
const KEY = pullRequestKey(REF.slug, REF.number);

function detail(over: { author?: string; state?: string; reviewers?: { login: string; state?: string; requested?: boolean }[]; write?: boolean } = {}): PullRequestDetailView {
  return {
    pullRequest: { state: over.state ?? "open", author: over.author ?? "kim", number: REF.number, title: "A change" },
    reviewers: (over.reviewers ?? []).map((r) => ({ isTeam: false, state: "", requested: false, ...r })),
    viewerCanUpdate: over.write ?? true,
  } as unknown as PullRequestDetailView;
}

/** The detail the button shows, also in its store: the dialog opens only for what the stores say it can show. */
function shown(d: PullRequestDetailView): PullRequestDetailView {
  pullRequestDetailResource.store.setState({ entries: { [KEY]: { data: d, error: null, loading: false } } });
  return d;
}

beforeEach(() => {
  // The stores' viewer (stores/reviewDialog.ts reads it), the same as the mocked hook's.
  viewerResource.store.setState({ entries: { [VIEWER_KEY]: { data: { login: viewer.login, name: "", url: "" }, error: null, loading: false } } });
});

afterEach(() => {
  cleanup();
  viewer.login = "me";
  usePrPanelStore.setState({ reviewing: {} });
  useReviewDialogStore.setState({ open: null, drafts: {} });
  pullRequestDetailResource.store.setState({ entries: {} });
  viewerResource.store.setState({ entries: {} });
});

const opened = () => {
  const s = useReviewDialogStore.getState();
  return s.open ? { ref: s.open, verdict: s.drafts[KEY]?.verdict, text: s.drafts[KEY]?.text } : null;
};

describe("ReviewButton", () => {
  it("Review, no chevron and no menu: pressing it opens the review dialog on Approve (someone else's pull request)", () => {
    render(<ReviewButton prRef={REF} detail={shown(detail())} />);
    const b = screen.getByTestId("pr-review-button");
    expect(b.textContent).toBe("Review");
    expect(b.getAttribute("aria-haspopup")).toBe("dialog");
    expect(b.dataset.primary).toBeUndefined();
    expect(b.querySelectorAll("svg")).toHaveLength(1); // the eye, no chevron
    fireEvent.click(b);
    expect(opened()).toEqual({ ref: REF, verdict: "approve", text: "" });
  });

  it("on the viewer's own pull request it opens on Comment", () => {
    render(<ReviewButton prRef={REF} detail={shown(detail({ author: "Me" }))} />);
    fireEvent.click(screen.getByTestId("pr-review-button"));
    expect(opened()?.verdict).toBe("comment");
  });

  it("primary (the viewer's review is requested) is the primary button saying Review, even after a review", () => {
    render(<ReviewButton prRef={REF} detail={shown(detail({ reviewers: [{ login: "me", state: "approved", requested: true }] }))} primary />);
    const b = screen.getByTestId("pr-review-button");
    expect(b.dataset.primary).toBe("true");
    expect(b.textContent).toBe("Review");
  });

  it.each([
    ["approved", "You approved", "approve"],
    ["changes_requested", "You requested changes", "request-changes"],
    ["commented", "You commented", "comment"],
  ] as const)("once the viewer has %s: the chip says %s and reopens the dialog on %s", (state, label, verdict) => {
    render(<ReviewButton prRef={REF} detail={shown(detail({ reviewers: [{ login: "ME", state }] }))} />);
    expect(screen.queryByTestId("pr-review-button")).toBeNull();
    const chip = screen.getByTestId("pr-your-review");
    expect(chip.textContent).toBe(label);
    expect(chip.dataset.review).toBe(state);
    fireEvent.click(chip);
    expect(opened()?.verdict).toBe(verdict);
  });

  it("an unsent draft (a failed submit, a cancel) reopens with its verdict and text", () => {
    setReviewDraft(REF, { verdict: "request-changes", text: "Rename the flag." });
    render(<ReviewButton prRef={REF} detail={shown(detail({ reviewers: [{ login: "me", state: "approved" }] }))} />);
    fireEvent.click(screen.getByTestId("pr-your-review"));
    expect(opened()).toEqual({ ref: REF, verdict: "request-changes", text: "Rename the flag." });
  });

  it.each([
    ["approve", "Approving…"],
    ["request-changes", "Requesting changes…"],
    ["comment", "Commenting…"],
  ] as const)("while a %s review is submitted: busy saying %s, and it opens nothing", (verdict, words) => {
    render(<ReviewButton prRef={REF} detail={shown(detail({ reviewers: [{ login: "me", state: "commented" }] }))} />);
    act(() => {
      usePrPanelStore.setState({ reviewing: { [KEY]: verdict } });
    });
    const b = screen.getByTestId("pr-your-review");
    expect(b.textContent).toBe(words);
    expect(b.getAttribute("aria-busy")).toBe("true");
    expect(b.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(b);
    expect(opened()).toBeNull();
    act(() => {
      usePrPanelStore.setState({ reviewing: {} });
    });
    expect(b.textContent).toBe("You commented");
  });

  it.each([
    ["merged", detail({ state: "merged" })],
    ["closed", detail({ state: "closed" })],
    ["read access, not asked", detail({ write: false })],
  ])("%s: no button", (_name, d) => {
    const { container } = render(<ReviewButton prRef={REF} detail={d} />);
    expect(container.innerHTML).toBe("");
  });
});

describe("PrDiffReviewButton (the Diff tab's bar)", () => {
  it("nothing until the detail is here; then the small Review, primary when the viewer is asked, opening the dialog for that pull request", () => {
    render(<PrDiffReviewButton prRef={REF} />);
    expect(screen.queryByTestId("pr-review-button")).toBeNull();
    act(() => {
      pullRequestDetailResource.store.setState({ entries: { [KEY]: { data: detail({ write: false, reviewers: [{ login: "me", requested: true }] }), error: null, loading: false } } });
    });
    const b = screen.getByTestId("pr-review-button");
    expect(b.dataset.size).toBe("sm");
    expect(b.dataset.primary).toBe("true");
    fireEvent.click(b);
    expect(opened()).toEqual({ ref: REF, verdict: "approve", text: "" });
  });

  it("a plain Review where nobody asked the viewer", () => {
    pullRequestDetailResource.store.setState({ entries: { [KEY]: { data: detail(), error: null, loading: false } } });
    render(<PrDiffReviewButton prRef={REF} />);
    expect(screen.getByTestId("pr-review-button").dataset.primary).toBeUndefined();
  });
});
