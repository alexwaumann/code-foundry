import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { PullRequestDetailView } from "@/api/gh";
import { answerConfirm, requestConfirm, useConfirmStore } from "./confirm";
import { pullRequestDetailResource, pullRequestKey, VIEWER_KEY, viewerResource } from "./gh";
import { usePrPanelStore } from "./prPanel";
import { closeReviewDialog, openReviewDialog, reviewDialogShows, useReviewDialogStore } from "./reviewDialog";

const REF = { slug: "acme/repo", number: 7 };
const KEY = pullRequestKey(REF.slug, REF.number);

function detail(over: { state?: string; write?: boolean; requested?: string } = {}): PullRequestDetailView {
  return {
    pullRequest: { state: over.state ?? "open", author: "kim", number: REF.number, title: "A change" },
    reviewers: over.requested ? [{ login: over.requested, isTeam: false, state: "", requested: true }] : [],
    viewerCanUpdate: over.write ?? true,
  } as unknown as PullRequestDetailView;
}

function setDetail(d: PullRequestDetailView | null): void {
  pullRequestDetailResource.store.setState({ entries: d ? { [KEY]: { data: d, error: null, loading: false } } : {} });
}

function setViewer(login: string): void {
  viewerResource.store.setState({ entries: { [VIEWER_KEY]: { data: { login, name: "", url: "" }, error: null, loading: false } } });
}

const isOpen = () => useReviewDialogStore.getState().open !== null;

beforeEach(() => {
  setDetail(detail());
  setViewer("me");
  usePrPanelStore.setState({ reviewing: {} });
  useReviewDialogStore.setState({ open: null, drafts: {} });
  useConfirmStore.setState({ pending: null });
});

afterEach(() => {
  answerConfirm(false);
  setDetail(null);
  viewerResource.store.setState({ entries: {} });
});

describe("reviewDialogShows", () => {
  it.each([
    { name: "open, the viewer can write", d: detail(), viewer: "me", busy: false, shows: true },
    { name: "open, the viewer's review requested", d: detail({ write: false, requested: "Me" }), viewer: "me", busy: false, shows: true },
    { name: "open, read access and not asked", d: detail({ write: false }), viewer: "me", busy: false, shows: false },
    { name: "merged", d: detail({ state: "merged" }), viewer: "me", busy: false, shows: false },
    { name: "no detail", d: null, viewer: "me", busy: false, shows: false },
    { name: "a review being sent", d: detail(), viewer: "me", busy: true, shows: false },
  ])("$name: $shows", ({ d, viewer, busy, shows }) => {
    expect(reviewDialogShows(d, viewer, busy)).toBe(shows);
  });
});

describe("the review dialog's open flag", () => {
  const merged = () => {
    setDetail(detail({ state: "merged" }));
  };
  const gone = () => {
    setDetail(null);
  };
  const back = () => {
    setDetail(detail());
  };
  const sending = () => {
    usePrPanelStore.setState({ reviewing: { [KEY]: "approve" } });
  };
  const sent = () => {
    usePrPanelStore.setState({ reviewing: {} });
  };
  const someoneElse = () => {
    setViewer("someone");
  };
  const meAgain = () => {
    setViewer("me");
  };
  const askedOnly = () => {
    setDetail(detail({ write: false, requested: "me" }));
  };
  it.each([
    { name: "the pull request merged", change: merged, restore: back, before: undefined },
    { name: "its detail gone", change: gone, restore: back, before: undefined },
    { name: "a review of it being sent", change: sending, restore: sent, before: undefined },
    { name: "the viewer no longer asked", change: someoneElse, restore: meAgain, before: askedOnly },
  ])("shuts where it lands: $name; and stays shut when it comes back", ({ change, restore, before }) => {
    before?.();
    openReviewDialog(REF, "comment");
    expect(isOpen()).toBe(true);
    change();
    expect(isOpen()).toBe(false);
    restore();
    expect(isOpen()).toBe(false);
  });

  it("stays open through a change that keeps it showable", () => {
    openReviewDialog(REF, "approve");
    setDetail(detail({ requested: "me" }));
    usePrPanelStore.setState({ reviewing: { [pullRequestKey(REF.slug, 8)]: "comment" } });
    expect(isOpen()).toBe(true);
  });

  it("does not open when it cannot show; keeps the draft's text when it does", () => {
    setDetail(detail({ state: "closed" }));
    openReviewDialog(REF, "approve");
    expect(isOpen()).toBe(false);
    setDetail(detail());
    openReviewDialog(REF, "approve");
    expect(useReviewDialogStore.getState().drafts[KEY]).toEqual({ verdict: "approve", text: "" });
    closeReviewDialog();
    expect(isOpen()).toBe(false);
  });

  it("a page's guarded question waits while it is open and shows the moment it shuts, with no view rendered", () => {
    openReviewDialog(REF, "comment");
    void requestConfirm({ title: "A page asks", message: "", confirmLabel: "Go", guarded: true });
    expect(useConfirmStore.getState().pending).toBeNull();
    setDetail(detail({ state: "merged" }));
    expect(useConfirmStore.getState().pending?.title).toBe("A page asks");
  });
});
