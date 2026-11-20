import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { answerConfirm, requestConfirm, useConfirmStore } from "./confirm";
import { pullRequestKey } from "./gh";
import { closeMergeDialog, openMergeDialog, useMergeDialogStore } from "./mergeDialog";
import { usePrPanelStore } from "./prPanel";

const A = { slug: "acme/repo", number: 7 };
const B = { slug: "acme/repo", number: 8 };
const keyOf = (r: typeof A) => pullRequestKey(r.slug, r.number);

beforeEach(() => {
  usePrPanelStore.setState({ merging: {} });
  useMergeDialogStore.setState({ open: null });
  useConfirmStore.setState({ pending: null });
});

afterEach(() => {
  answerConfirm(false);
});

describe("the merge dialog's open flag", () => {
  it.each([
    { name: "a merge starting on its pull request shuts it", merging: { [keyOf(A)]: "squash" as const }, open: false },
    { name: "a merge on another pull request leaves it", merging: { [keyOf(B)]: "squash" as const }, open: true },
    { name: "an unrelated change in the panel's store leaves it", merging: {}, open: true },
  ])("$name", ({ merging, open }) => {
    openMergeDialog("b1", A);
    usePrPanelStore.setState({ merging });
    expect(useMergeDialogStore.getState().open !== null).toBe(open);
    // Shut means gone: the merge ending (a refusal) does not bring it back.
    usePrPanelStore.setState({ merging: {} });
    expect(useMergeDialogStore.getState().open !== null).toBe(open);
  });

  it("does not open while a merge runs on its pull request; does for another", () => {
    usePrPanelStore.setState({ merging: { [keyOf(A)]: "rebase" } });
    openMergeDialog("b1", A);
    expect(useMergeDialogStore.getState().open).toBeNull();
    openMergeDialog("b1", B);
    expect(useMergeDialogStore.getState().open).toEqual({ button: "b1", pr: keyOf(B) });
  });

  it("closes only its own button's dialog", () => {
    openMergeDialog("b1", A);
    closeMergeDialog("b2");
    expect(useMergeDialogStore.getState().open?.button).toBe("b1");
    closeMergeDialog("b1");
    expect(useMergeDialogStore.getState().open).toBeNull();
  });

  it("a page's guarded question waits while it is open and shows the moment a merge shuts it, with no view rendered", () => {
    openMergeDialog("b1", A);
    void requestConfirm({ title: "A page asks", message: "", confirmLabel: "Go", guarded: true });
    expect(useConfirmStore.getState().pending).toBeNull();
    usePrPanelStore.setState({ merging: { [keyOf(A)]: "merge" } });
    expect(useConfirmStore.getState().pending?.title).toBe("A page asks");
  });
});
