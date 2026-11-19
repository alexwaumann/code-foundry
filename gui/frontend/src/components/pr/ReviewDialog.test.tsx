import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView } from "@/api/gh";

const viewer = vi.hoisted(() => ({ login: "me" }));
const submitReview = vi.hoisted(() => vi.fn());
vi.mock("@/stores/gh", async (orig) => ({ ...(await orig<typeof import("@/stores/gh")>()), useViewerLogin: () => viewer.login }));
vi.mock("@/stores/prPanel", async (orig) => ({ ...(await orig<typeof import("@/stores/prPanel")>()), submitReview }));
vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));

const { usePrPanelStore } = await import("@/stores/prPanel");
const { pullRequestDetailResource, pullRequestKey } = await import("@/stores/gh");
const { openReviewDialog, useReviewDialogStore } = await import("@/stores/reviewDialog");
const { requestConfirm, useConfirmStore } = await import("@/stores/confirm");
const { ReviewDialog } = await import("./ReviewDialog");
const { fakeDictation, dictationSnap } = await import("@/test/dictation");
const { useSettingsStore } = await import("@/stores/settings");
const { resetDictationForTests, useDictationStore } = await import("@/stores/dictation");

const REF = { slug: "acme/repo", number: 7 };
const KEY = pullRequestKey(REF.slug, REF.number);

function detail(author = "kim", state = "open"): PullRequestDetailView {
  return {
    pullRequest: { state, author, number: 7, title: "feat(gui): virtualized sidebar tree with thread rows" },
    reviewers: [],
    viewerCanUpdate: true,
  } as unknown as PullRequestDetailView;
}

function setDetail(d: PullRequestDetailView | null): void {
  pullRequestDetailResource.store.setState({ entries: d ? { [KEY]: { data: d, error: null, loading: false } } : {} });
}

beforeEach(() => {
  setDetail(detail());
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  viewer.login = "me";
  usePrPanelStore.setState({ reviewing: {} });
  useReviewDialogStore.setState({ open: null, drafts: {} });
  useConfirmStore.setState({ pending: null });
  setDetail(null);
});

const dialog = () => screen.queryByTestId("pr-review-dialog");
const input = () => screen.getByTestId<HTMLTextAreaElement>("pr-review-dialog-input");
const confirm = () => screen.getByTestId<HTMLButtonElement>("pr-review-dialog-confirm");
const segment = (v: string) => screen.getByTestId(`pr-review-dialog-${v}`);

function show(verdict: "approve" | "request-changes" | "comment"): void {
  render(<ReviewDialog />);
  act(() => {
    openReviewDialog(REF, verdict);
  });
}

describe("ReviewDialog", () => {
  it("someone else's pull request: Review over owner/repo #N and its title, Comment | Approve | Request changes all on, no line about the author", () => {
    show("approve");
    expect(screen.getByTestId("pr-review-dialog-title").textContent).toBe("Review");
    // The page header's form; the number left the title.
    expect(screen.getByTestId("pr-review-dialog-repo").textContent).toBe("acme/repo #7");
    expect(screen.getByTestId("pr-review-dialog-pr-title").textContent).toBe("feat(gui): virtualized sidebar tree with thread rows");
    const radios = within(screen.getByRole("radiogroup", { name: "Verdict" })).getAllByRole("radio");
    expect(radios.map((r) => [r.textContent, r.getAttribute("aria-checked"), r.hasAttribute("disabled")])).toEqual([
      ["Comment", "false", false],
      ["Approve", "true", false],
      ["Request changes", "false", false],
    ]);
    expect(screen.queryByTestId("pr-review-dialog-own")).toBeNull();
  });

  it("the viewer's own pull request: Approve and Request changes are off, and one line says why", () => {
    setDetail(detail("ME"));
    show("comment");
    expect(segment("approve").hasAttribute("disabled")).toBe(true);
    expect(segment("request-changes").hasAttribute("disabled")).toBe(true);
    expect(segment("comment").getAttribute("aria-checked")).toBe("true");
    expect(screen.getByTestId("pr-review-dialog-own").textContent).toBe("You can’t approve or request changes on your own pull request.");
  });

  it.each([
    ["approve", "Optional comment", "Approve", "bg-cf-success", "bg-cf-success-surface"],
    ["request-changes", "What needs to change before this merges?", "Request changes", "text-cf-error-text", "bg-cf-error-surface"],
    ["comment", "Leave a comment", "Submit comment", "bg-primary", "bg-cf-surface-sunken"],
  ] as const)("%s: the placeholder, the confirm's words and tone, the badge's tone; never a destructive button", (verdict, placeholder, words, confirmTone, badgeTone) => {
    show(verdict);
    expect(dialog()?.dataset.verdict).toBe(verdict);
    expect(input().placeholder).toBe(placeholder);
    expect(confirm().textContent).toBe(words);
    expect(confirm().className).toContain(confirmTone);
    expect(confirm().className).not.toContain("bg-destructive");
    expect(confirm().dataset.variant).toBe("default");
    expect(screen.getByTestId("pr-review-dialog-badge").className).toContain(badgeTone);
  });

  it("switching the verdict keeps the text and changes the confirm", () => {
    show("approve");
    fireEvent.change(input(), { target: { value: "Rename the flag." } });
    fireEvent.click(segment("request-changes"));
    expect(dialog()?.dataset.verdict).toBe("request-changes");
    expect(input().value).toBe("Rename the flag.");
    expect(confirm().textContent).toBe("Request changes");
  });

  it("Request changes and Comment wait for text (blank counts as none), by button and by cmd+Enter; Approve does not", () => {
    show("request-changes");
    expect(confirm().disabled).toBe(true);
    expect(screen.getByTestId("pr-review-dialog-hint").textContent).toBe("Say what should change");
    fireEvent.change(input(), { target: { value: "   " } });
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    expect(submitReview).not.toHaveBeenCalled();
    expect(confirm().disabled).toBe(true);
    fireEvent.click(segment("comment"));
    expect(screen.getByTestId("pr-review-dialog-hint").textContent).toBe("Write a comment");
    fireEvent.click(segment("approve"));
    expect(confirm().disabled).toBe(false);
    expect(screen.getByTestId("pr-review-dialog-hint").textContent).toBe("⌘⏎ submit · esc cancel");
  });

  it("cmd+Enter (not Enter) submits: the dialog shuts and pr.review runs with the verdict and text; a posted review clears the draft", async () => {
    submitReview.mockResolvedValueOnce(true);
    show("request-changes");
    fireEvent.change(input(), { target: { value: "Rename it" } });
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(true); // a newline
    expect(submitReview).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    await vi.waitFor(() => {
      expect(submitReview).toHaveBeenCalledExactlyOnceWith(REF, "request-changes", "Rename it");
    });
    expect(dialog()).toBeNull();
    expect(useReviewDialogStore.getState().open).toBeNull();
    await vi.waitFor(() => {
      expect(useReviewDialogStore.getState().drafts[KEY]).toBeUndefined();
    });
  });

  it("a failed submit loses nothing: reopened, the verdict and text are there", async () => {
    submitReview.mockResolvedValueOnce(false);
    show("comment");
    fireEvent.change(input(), { target: { value: "Nice" } });
    fireEvent.click(confirm());
    await vi.waitFor(() => {
      expect(submitReview).toHaveBeenCalledExactlyOnceWith(REF, "comment", "Nice");
    });
    expect(dialog()).toBeNull();
    await act(async () => {
      await Promise.resolve();
    });
    expect(useReviewDialogStore.getState().drafts[KEY]).toEqual({ verdict: "comment", text: "Nice" });
    act(() => {
      openReviewDialog(REF, "comment");
    });
    expect(input().value).toBe("Nice");
  });

  it("Escape and Cancel shut it without sending, keeping the text", () => {
    show("comment");
    fireEvent.change(input(), { target: { value: "Half a thought" } });
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(dialog()).toBeNull();
    act(() => {
      openReviewDialog(REF, "comment");
    });
    expect(input().value).toBe("Half a thought");
    fireEvent.click(screen.getByTestId("pr-review-dialog-cancel"));
    expect(dialog()).toBeNull();
    expect(submitReview).not.toHaveBeenCalled();
  });

  it("shuts by itself when the pull request stops taking reviews (merged meanwhile), and while a review of it runs", () => {
    show("comment");
    expect(dialog()).not.toBeNull();
    act(() => {
      setDetail(detail("kim", "merged"));
    });
    expect(dialog()).toBeNull();
    expect(useReviewDialogStore.getState().open).toBeNull();
    act(() => {
      setDetail(detail());
      usePrPanelStore.setState({ reviewing: { [KEY]: "approve" } });
      openReviewDialog(REF, "comment");
    });
    expect(dialog()).toBeNull();
  });

  it("a guarded question waits while it is open, and shows once it shuts", async () => {
    show("comment");
    let answered: boolean | null = null;
    void requestConfirm({ title: "Run it?", message: "", confirmLabel: "Run", guarded: true }).then((v) => {
      answered = v;
    });
    expect(useConfirmStore.getState().pending).toBeNull();
    fireEvent.click(screen.getByTestId("pr-review-dialog-cancel"));
    expect(useConfirmStore.getState().pending?.title).toBe("Run it?");
    act(() => {
      useConfirmStore.getState().pending?.resolve(false);
    });
    await vi.waitFor(() => {
      expect(answered).toBe(false);
    });
  });
});

describe("the review dialog's mic", () => {
  afterEach(() => {
    resetDictationForTests();
    fakeDictation.reset();
    useSettingsStore.setState({ snapshot: null });
  });

  it("a phrase lands in its text after a space; Escape stops dictating before it cancels", async () => {
    useSettingsStore.setState({ snapshot: { values: { "dictation.enabled": "true" }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
    const snap = dictationSnap();
    fakeDictation.publish(snap);
    show("comment");
    await vi.waitFor(() => {
      expect(useDictationStore.getState().snapshot).toBe(snap);
    });
    const box = screen.getByTestId("pr-review-dialog");
    fireEvent.change(input(), { target: { value: "Read it." } });
    fireEvent.click(within(box).getByTestId("dictation-mic"));
    await within(box).findByTestId("dictation-pill");
    act(() => {
      fakeDictation.phrase("Looks good to me.");
    });
    await vi.waitFor(() => {
      expect(input().value).toBe("Read it. Looks good to me.");
    });
    fireEvent.keyDown(input(), { key: "Escape" });
    await within(box).findByTestId("dictation-mic");
    expect(fakeDictation.calls.at(-1)).toMatch(/^stop dict-\d+ false$/);
    // Still open: the first Escape only stopped dictating.
    expect(dialog()).not.toBeNull();
    fireEvent.keyDown(input(), { key: "Escape" });
    expect(dialog()).toBeNull();
  });
});
