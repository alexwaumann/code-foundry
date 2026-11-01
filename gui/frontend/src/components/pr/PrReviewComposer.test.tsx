import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const submitReview = vi.hoisted(() => vi.fn());
vi.mock("@/stores/prPanel", async (orig) => ({ ...(await orig<typeof import("@/stores/prPanel")>()), submitReview }));
vi.mock("@/api/dictation", async (orig) => ({ ...(await orig<typeof import("@/api/dictation")>()), ...(await import("@/test/dictation")).fakeDictationApi }));

const { usePrPanelStore } = await import("@/stores/prPanel");
const { pullRequestKey } = await import("@/stores/gh");
const { PrReviewComposer } = await import("./PrReviewComposer");
const { PrAskComposer } = await import("./PrAskComposer");
const { REVIEW_ELSEWHERE_HINT, REVIEW_KEYS_HINT } = await import("./review");
const { fakeDictation, dictationSnap } = await import("@/test/dictation");
const { useSettingsStore } = await import("@/stores/settings");
const { resetDictationForTests, useDictationStore } = await import("@/stores/dictation");

const REF = { slug: "acme/repo", number: 7 };
const KEY = pullRequestKey(REF.slug, REF.number);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  usePrPanelStore.setState({ reviewing: {} });
});

describe("PrReviewComposer", () => {
  const input = () => screen.getByTestId("pr-review-input");

  it("cmd+Enter submits the verdict and text, closes on success and hands focus to the panel; Enter alone does not", async () => {
    submitReview.mockResolvedValueOnce(true);
    const onClose = vi.fn();
    render(
      <aside data-region="panel" tabIndex={-1} data-testid="panel">
        <PrReviewComposer prRef={REF} verdict="request-changes" focusRequest={1} onClose={onClose} />
      </aside>,
    );
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input());
    });
    fireEvent.change(input(), { target: { value: "Rename it" } });
    expect(fireEvent.keyDown(input(), { key: "Enter" })).toBe(true); // a newline
    expect(submitReview).not.toHaveBeenCalled();
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    expect(submitReview).toHaveBeenCalledWith(REF, "request-changes", "Rename it");
    await vi.waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(document.activeElement).toBe(screen.getByTestId("panel"));
  });

  it("a failed submit keeps the composer and its text", async () => {
    submitReview.mockResolvedValueOnce(false);
    const onClose = vi.fn();
    render(<PrReviewComposer prRef={REF} verdict="comment" focusRequest={1} onClose={onClose} />);
    fireEvent.change(input(), { target: { value: "Nice" } });
    fireEvent.click(screen.getByTestId("pr-review-submit"));
    await vi.waitFor(() => {
      expect(submitReview).toHaveBeenCalledTimes(1);
    });
    await vi.waitFor(() => {
      expect(input()).toHaveProperty("readOnly", false);
    });
    expect(onClose).not.toHaveBeenCalled();
    expect(input()).toHaveProperty("value", "Nice");
  });

  it("while another surface submits a review of the pull request: the elsewhere hint as a status, the spinner, nothing sent; the text stays editable", () => {
    usePrPanelStore.setState({ reviewing: { [KEY]: true } });
    const onClose = vi.fn();
    render(<PrReviewComposer prRef={REF} verdict="approve" focusRequest={1} onClose={onClose} />);
    const hint = screen.getByTestId("pr-review-hint");
    expect(hint.textContent).toBe(REVIEW_ELSEWHERE_HINT);
    expect(hint.getAttribute("role")).toBe("status");
    expect(screen.getByTestId("pr-review-submit").getAttribute("aria-busy")).toBe("true");
    expect(screen.getByTestId("pr-review-submit")).toHaveProperty("disabled", true);
    expect(input()).toHaveProperty("readOnly", false);
    fireEvent.change(input(), { target: { value: "LGTM" } });
    fireEvent.keyDown(input(), { key: "Enter", metaKey: true });
    expect(submitReview).not.toHaveBeenCalled();
    act(() => {
      usePrPanelStore.setState({ reviewing: {} });
    });
    expect(screen.getByTestId("pr-review-hint").textContent).toBe(REVIEW_KEYS_HINT);
    expect(screen.getByTestId("pr-review-submit")).toHaveProperty("disabled", false);
    fireEvent.click(screen.getByTestId("pr-review-cancel"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe("two panels with a composer each", () => {
  it.each([
    ["review", "pr-review-input", "pr-review-hint"],
    ["ask", "pr-ask-input", "pr-ask-hint"],
  ] as const)("%s: element ids are unique and each label and hint point at their own field", (kind, inputId, hintId) => {
    const one = () => (kind === "review" ? <PrReviewComposer prRef={REF} verdict="comment" focusRequest={1} onClose={vi.fn()} /> : <PrAskComposer prRef={REF} focusRequest={1} onClose={vi.fn()} />);
    render(
      <>
        {one()}
        {one()}
      </>,
    );
    const inputs = screen.getAllByTestId(inputId);
    const hints = screen.getAllByTestId(hintId);
    expect(new Set(inputs.map((i) => i.id)).size).toBe(2);
    inputs.forEach((el, i) => {
      expect(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.closest("section")).toBe(el.closest("section"));
      expect(el.getAttribute("aria-describedby")).toBe(hints[i]?.id);
    });
  });
});

describe("the review composer's mic", () => {
  afterEach(() => {
    resetDictationForTests();
    fakeDictation.reset();
    useSettingsStore.setState({ snapshot: null });
  });

  it("a phrase lands in its text after a space; Escape stops dictating before it cancels", async () => {
    useSettingsStore.setState({ snapshot: { values: { "dictation.enabled": "true" }, path: "", revision: 1, loadError: "", issues: [], restartPending: [] } });
    const snap = dictationSnap();
    fakeDictation.publish(snap);
    const onClose = vi.fn();
    render(<PrReviewComposer prRef={REF} verdict="comment" focusRequest={1} onClose={onClose} />);
    await vi.waitFor(() => {
      expect(useDictationStore.getState().snapshot).toBe(snap);
    });
    const input = screen.getByTestId("pr-review-input");
    const composer = screen.getByTestId("pr-review-composer");
    await vi.waitFor(() => {
      expect(document.activeElement).toBe(input);
    });
    fireEvent.change(input, { target: { value: "Read it." } });
    fireEvent.click(within(composer).getByTestId("dictation-mic"));
    await within(composer).findByTestId("dictation-pill");
    act(() => {
      fakeDictation.phrase("Looks good to me.");
    });
    await vi.waitFor(() => {
      expect(input).toHaveProperty("value", "Read it. Looks good to me.");
    });
    fireEvent.keyDown(input, { key: "Escape" });
    await within(composer).findByTestId("dictation-mic");
    expect(fakeDictation.calls.at(-1)).toMatch(/^stop dict-\d+ false$/);
    // The composer stays: the first Escape only stopped dictating.
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
