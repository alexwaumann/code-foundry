import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView, ReviewerCandidatesView } from "@/api/gh";

const invokeCommand = vi.hoisted(() => vi.fn());
const listCommands = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand, listCommands }));

const getPullRequestDetail = vi.hoisted(() => vi.fn());
const listReviewerCandidates = vi.hoisted(() => vi.fn());
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getPullRequestDetail, listReviewerCandidates }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { pullRequestDetailResource, pullRequestKey } = await import("./gh");
const { applyLayoutOp } = await import("@/api/layout");
const { layoutSettled, resetFakeLayout, threadSeed } = await import("@/test/fakeLayout");
const { makeTab, openTab, tabPlace } = await import("@/shell/host");
const { useLayoutStore } = await import("./layout");
const { openPullRequestLink } = await import("@/components/pr/prLinks");
const { clearConfirmedRequests, openPullRequestInPanel, refreshPullRequest, requestingKey, reviewerCandidatesKey, reviewerCandidatesResource, revertPullRequest, reviewArgs, setAutoMerge, setInnerTab, setReviewRequest, submitReview, usePrPanelStore } = await import("./prPanel");

const SLUG = "acme/repo";
const view = (body: string, lastError = "") => ({ body, lastError }) as PullRequestDetailView;
const entry = (key: string) => pullRequestDetailResource.store.getState().entries[key];

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(async () => {
  usePrPanelStore.setState({ byTab: {}, refreshing: {}, requesting: {}, confirmed: {}, reviewing: {}, changing: {}, reverting: {}, mergeMethods: {} });
  await resetFakeLayout(threadSeed("a"));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("refreshPullRequest", () => {
  it("runs pr.refresh quietly and writes its detail into the resource without a second read", async () => {
    const ref = { slug: SLUG, number: 1 };
    const key = pullRequestKey(SLUG, 1);
    getPullRequestDetail.mockResolvedValue(view("cached"));
    const release = pullRequestDetailResource.watch(key);
    await vi.waitFor(() => {
      expect(entry(key)?.data?.body).toBe("cached");
    });
    // The daemon's result: protojson of PullRequestDetail.
    const fresh = { pullRequest: { repoSlug: SLUG, number: 1, title: "t" }, body: "fresh", fetchedAt: "2026-10-09T10:00:00Z" };
    invokeCommand.mockResolvedValueOnce({ message: "Refreshed #1: t", resultJson: JSON.stringify(fresh) });

    await expect(refreshPullRequest(ref)).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith("pr.refresh", expect.anything(), { "repo-slug": SLUG, number: "1" });
    expect(entry(key)).toMatchObject({ data: { body: "fresh", lastError: "", fetchedAtMs: Date.parse("2026-10-09T10:00:00Z") }, error: null, loading: false });
    expect(getPullRequestDetail).toHaveBeenCalledTimes(1); // the watch's first read only
    expect(toast.success).not.toHaveBeenCalled();
    expect(usePrPanelStore.getState().refreshing).toEqual({});
    release();
  });

  it("a failed pr.refresh is toasted and shown over the copy, which keeps its lastError", async () => {
    const ref = { slug: SLUG, number: 2 };
    const key = pullRequestKey(SLUG, 2);
    getPullRequestDetail.mockResolvedValue(view("v1", "earlier failure"));
    const release = pullRequestDetailResource.watch(key);
    await vi.waitFor(() => {
      expect(entry(key)?.data?.body).toBe("v1");
    });
    invokeCommand.mockRejectedValueOnce(new ConnectError("refresh #2 failed, the cached copy is unchanged: boom", Code.Unavailable));

    await expect(refreshPullRequest(ref)).resolves.toBe(false);
    expect(toast.error).toHaveBeenCalledWith("pr.refresh failed", { description: expect.stringContaining("boom") as unknown });
    expect(entry(key)).toMatchObject({ data: { body: "v1", lastError: "earlier failure" }, error: expect.stringContaining("boom") as unknown, loading: false });
    expect(getPullRequestDetail).toHaveBeenCalledTimes(1);
    expect(usePrPanelStore.getState().refreshing).toEqual({});
    release();
  });
});

describe("setReviewRequest", () => {
  const candidates = (requested: boolean): ReviewerCandidatesView => ({ candidates: [{ id: "U_lee", kind: "user", login: "lee", name: "", avatarUrl: "", isRequested: requested }] });

  it("keeps the row busy until the candidates are read again, and ignores a second click meanwhile", async () => {
    const ref = { slug: SLUG, number: 3 };
    // The open picker shows a search: that is the key re-read.
    const key = reviewerCandidatesKey(ref, "le");
    getPullRequestDetail.mockResolvedValue(view("d"));
    listReviewerCandidates.mockResolvedValueOnce(candidates(false));
    const release = reviewerCandidatesResource.watch(key);
    await vi.waitFor(() => {
      expect(reviewerCandidatesResource.store.getState().entries[key]?.data).toEqual(candidates(false));
    });
    const reread = deferred<ReviewerCandidatesView>();
    listReviewerCandidates.mockReturnValueOnce(reread.promise);
    invokeCommand.mockResolvedValueOnce({ message: "Requested a review from lee on #3", resultJson: "{}" });

    const first = setReviewRequest(ref, "lee", "user", true);
    const busy = () => usePrPanelStore.getState().requesting[requestingKey(ref, "lee")] ?? false;
    await vi.waitFor(() => {
      expect(listReviewerCandidates).toHaveBeenCalledTimes(2);
    });
    expect(busy()).toBe(true);
    // A second click before the re-read lands sends nothing.
    await expect(setReviewRequest(ref, "lee", "user", true)).resolves.toBe(false);
    expect(invokeCommand).toHaveBeenCalledTimes(1);

    expect(listReviewerCandidates).toHaveBeenLastCalledWith(SLUG, 3, "le", undefined, expect.any(AbortSignal));
    reread.resolve(candidates(true));
    await expect(first).resolves.toBe(true);
    expect(busy()).toBe(false);
    expect(reviewerCandidatesResource.store.getState().entries[key]?.data).toEqual(candidates(true));
    release();
  });

  it("confirms a request as soon as the daemon does, keeps it over a re-read that lags, and forgets it when the picker closes", async () => {
    const ref = { slug: SLUG, number: 5 };
    const key = reviewerCandidatesKey(ref, "jane doe");
    listReviewerCandidates.mockResolvedValueOnce(candidates(false));
    const release = reviewerCandidatesResource.watch(key);
    await vi.waitFor(() => {
      expect(reviewerCandidatesResource.store.getState().entries[key]?.data).toBeTruthy();
    });
    const reread = deferred<ReviewerCandidatesView>();
    listReviewerCandidates.mockReturnValueOnce(reread.promise);
    invokeCommand.mockResolvedValueOnce({ message: "Requested a review from lee on #5", resultJson: "{}" });
    const confirmed = () => usePrPanelStore.getState().confirmed[requestingKey(ref, "lee")];

    const p = setReviewRequest(ref, "lee", "user", true);
    expect(confirmed()).toBeUndefined(); // the spinner while the command runs
    await vi.waitFor(() => {
      expect(confirmed()).toBe(true); // the check during the re-read
    });
    reread.resolve(candidates(false)); // GitHub's read lags the write
    await expect(p).resolves.toBe(true);
    expect(confirmed()).toBe(true);

    clearConfirmedRequests(ref);
    expect(confirmed()).toBeUndefined();
    release();
  });

  it("a failed request is toasted, re-reads, and clears the spinner", async () => {
    const ref = { slug: SLUG, number: 4 };
    const key = reviewerCandidatesKey(ref, "");
    listReviewerCandidates.mockResolvedValue(candidates(false));
    const release = reviewerCandidatesResource.watch(key);
    await vi.waitFor(() => {
      expect(reviewerCandidatesResource.store.getState().entries[key]?.data).toBeTruthy();
    });
    let fail!: (err: unknown) => void;
    invokeCommand.mockReturnValueOnce(
      new Promise((_resolve, reject) => {
        fail = reject;
      }),
    );
    const busy = () => usePrPanelStore.getState().requesting[requestingKey(ref, "lee")] ?? false;

    const p = setReviewRequest(ref, "lee", "user", true);
    expect(busy()).toBe(true); // the row's spinner while the request runs
    fail(new ConnectError("Review cannot be requested from pull request author.", Code.FailedPrecondition));
    await expect(p).resolves.toBe(false);
    expect(toast.error).toHaveBeenCalledWith("pr.review.request failed", { description: expect.stringContaining("cannot be requested") as unknown });
    expect(listReviewerCandidates).toHaveBeenCalledTimes(2);
    expect(busy()).toBe(false);
    expect(usePrPanelStore.getState().confirmed[requestingKey(ref, "lee")]).toBeUndefined(); // nothing to confirm
    release();
  });
});

describe("submitReview", () => {
  it("runs pr.review with the trimmed body and stays busy until the detail is read again; a second submit meanwhile sends nothing", async () => {
    const ref = { slug: SLUG, number: 5 };
    const key = pullRequestKey(SLUG, 5);
    getPullRequestDetail.mockResolvedValueOnce(view("before"));
    const release = pullRequestDetailResource.watch(key);
    await vi.waitFor(() => {
      expect(entry(key)?.data?.body).toBe("before");
    });
    const reread = deferred<PullRequestDetailView>();
    getPullRequestDetail.mockReturnValueOnce(reread.promise);
    invokeCommand.mockResolvedValueOnce({ message: "Approved #5", resultJson: "{}" });
    const busy = () => usePrPanelStore.getState().reviewing[key] ?? false;

    const first = submitReview(ref, "approve", "  LGTM \n");
    expect(busy()).toBe(true);
    await vi.waitFor(() => {
      expect(getPullRequestDetail).toHaveBeenCalledTimes(2);
    });
    await expect(submitReview(ref, "approve", "again")).resolves.toBe(false);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith("pr.review", expect.anything(), { "repo-slug": SLUG, number: "5", verdict: "approve", body: "LGTM" });
    expect(busy()).toBe(true);
    reread.resolve(view("after"));
    await expect(first).resolves.toBe(true);
    expect(busy()).toBe(false);
    expect(entry(key)?.data?.body).toBe("after");
    expect(toast.success).toHaveBeenCalledWith("Approved #5");
    release();
  });

  it("an empty approval sends no body; a refusal is toasted with GitHub's message, re-reads, and frees the composer without waiting for that read", async () => {
    const ref = { slug: SLUG, number: 6 };
    const key = pullRequestKey(SLUG, 6);
    getPullRequestDetail.mockResolvedValueOnce(view("d"));
    const release = pullRequestDetailResource.watch(key);
    await vi.waitFor(() => {
      expect(entry(key)?.data?.body).toBe("d");
    });
    const reread = deferred<PullRequestDetailView>();
    getPullRequestDetail.mockReturnValueOnce(reread.promise);
    invokeCommand.mockRejectedValueOnce(new ConnectError("failed precondition: Review Can not approve your own pull request", Code.FailedPrecondition));

    await expect(submitReview(ref, "approve", "   ")).resolves.toBe(false);
    expect(invokeCommand).toHaveBeenCalledWith("pr.review", expect.anything(), { "repo-slug": SLUG, number: "6", verdict: "approve" });
    expect(toast.error).toHaveBeenCalledWith("pr.review failed", { description: expect.stringContaining("Can not approve your own") as unknown });
    expect(getPullRequestDetail).toHaveBeenCalledTimes(2);
    // The re-read is still in flight; the busy flag is already gone.
    expect(entry(key)?.loading).toBe(true);
    expect(usePrPanelStore.getState().reviewing).toEqual({});
    reread.resolve(view("d2"));
    await vi.waitFor(() => {
      expect(entry(key)?.data?.body).toBe("d2");
    });
    release();
  });

  it("reviewArgs trims the body and leaves an empty one out", () => {
    expect(reviewArgs({ slug: "o/r", number: 7 }, "request-changes", "  Fix it\n")).toEqual({ "repo-slug": "o/r", number: "7", verdict: "request-changes", body: "Fix it" });
    expect(reviewArgs({ slug: "o/r", number: 7 }, "approve", " \n")).toEqual({ "repo-slug": "o/r", number: "7", verdict: "approve" });
  });
});

describe("setAutoMerge", () => {
  it("the method becomes the repository's default only once pr.auto-merge succeeds", async () => {
    const ref = { slug: "Acme/Repo", number: 5 };
    getPullRequestDetail.mockResolvedValue(view("d"));
    invokeCommand.mockRejectedValueOnce(new ConnectError("failed precondition: the head moved", Code.FailedPrecondition));
    await expect(setAutoMerge(ref, "rebase", "abc")).resolves.toBe(false);
    expect(invokeCommand).toHaveBeenCalledWith("pr.auto-merge", expect.anything(), { "repo-slug": "Acme/Repo", number: "5", method: "rebase", "head-sha": "abc" });
    expect(usePrPanelStore.getState().mergeMethods).toEqual({});

    invokeCommand.mockResolvedValueOnce({ message: "Auto-merge on for #5", resultJson: "{}" });
    await expect(setAutoMerge(ref, "rebase", "abc")).resolves.toBe(true);
    expect(usePrPanelStore.getState().mergeMethods).toEqual({ "acme/repo": "rebase" });

    // Cancel auto-merge changes no default.
    invokeCommand.mockResolvedValueOnce({ message: "Auto-merge off for #5", resultJson: "{}" });
    await expect(setAutoMerge(ref, null, "")).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenLastCalledWith("pr.auto-merge", expect.anything(), { "repo-slug": "Acme/Repo", number: "5", off: "true" });
    expect(usePrPanelStore.getState().mergeMethods).toEqual({ "acme/repo": "rebase" });
    getPullRequestDetail.mockReset();
  });
});

/** Opens a pull request in thread a's tabs and waits for the layout to have it. */
async function openIn(ref: { slug: string; number: number }, target = "thread:a"): Promise<void> {
  openPullRequestInPanel(ref, target);
  await layoutSettled();
}

describe("one tab for a pull request, however its slug is spelled", () => {
  const tabs = () => tabPlace("thread:a").tabs;
  /** #5's one tab. (Which spelling it keeps: the skipped test below.) */
  const shown = () => {
    const open = tabs().filter((t) => t.params.number === "5");
    expect(open).toHaveLength(1);
    return open[0]?.id;
  };

  it("the tab keeps the slug it was opened with, and another spelling focuses its pane", async () => {
    await openIn({ slug: "Acme/Repo", number: 5 });
    await openIn({ slug: "acme/repo", number: 6 });
    const held = tabs().find((t) => t.params.number === "5")?.id ?? "";
    await applyLayoutOp({ op: "move_tab", tab: held, pane: useLayoutStore.getState().tabs[held]?.paneId ?? "", edge: "bottom" });
    await layoutSettled();
    await openIn({ slug: "acme/repo", number: 5 });
    expect(tabs().find((t) => t.id === held)?.params.slug).toBe("Acme/Repo");
    const place = tabPlace("thread:a");
    expect(place.focused).toBe(place.groups.findIndex((g) => g.tabs.some((t) => t.id === held)));
  });

  it.each([
    ["a mixed-case tab, then lower case", "Acme/Repo", "acme/repo"],
    ["a lower-case tab, then mixed case", "acme/repo", "Acme/Repo"],
    ["two other spellings", "ACME/repo", "acme/REPO"],
  ])("%s: it switches to the first", async (_name, first, second) => {
    await openIn({ slug: first, number: 5 });
    await openIn({ slug: "acme/repo", number: 6 });
    await openIn({ slug: second, number: 5 });
    expect(tabs()).toHaveLength(2);
    expect(tabPlace("thread:a").groups[0]?.active?.id).toBe(shown());
  });

  it("a link in another case lands on the tab", async () => {
    await openIn({ slug: "Acme/Repo", number: 5 });
    expect(openPullRequestLink("thread:a")("https://github.com/acme/repo/pull/5")).toBe(true);
    await layoutSettled();
    expect(tabs()).toHaveLength(1);
    shown();
  });

  it("with the tab in another pane, opening it again switches to that pane's tab", async () => {
    await openIn({ slug: "acme/repo", number: 5 });
    await openIn({ slug: "acme/repo", number: 6 });
    const held = tabs().find((t) => t.params.number === "5")?.id ?? "";
    // #5 to a pane of its own, below; #6 shows.
    await applyLayoutOp({ op: "move_tab", tab: held, pane: useLayoutStore.getState().tabs[held]?.paneId ?? "", edge: "bottom" });
    await applyLayoutOp({ op: "focus_tab", tab: tabs().find((t) => t.params.number === "6")?.id ?? "" });
    await layoutSettled();
    expect(tabPlace("thread:a").groups).toHaveLength(2);
    await openIn({ slug: "acme/repo", number: 5 });
    const place = tabPlace("thread:a");
    const at = place.groups.findIndex((g) => g.tabs.some((t) => t.id === held));
    expect(place.groups[at]?.tabs).toHaveLength(1);
    expect(place.groups[at]?.active?.id).toBe(shown());
    expect(place.focused).toBe(at);
  });

  it("a revert whose new pull request is open already switches to its tab", async () => {
    await openIn({ slug: "Acme/Repo", number: 5 });
    invokeCommand.mockResolvedValueOnce({ message: "Opened #5", resultJson: JSON.stringify({ number: 5, url: "https://github.com/acme/repo/pull/5" }) });
    await revertPullRequest({ slug: "acme/repo", number: 3 }, "thread:a");
    await layoutSettled();
    expect(tabs()).toHaveLength(1);
    shown();
  });
});

describe("revertPullRequest", () => {
  it("a result without a number toasts the daemon's message and opens no tab", async () => {
    openTab("thread:a", makeTab("pullrequest", "#5", { slug: SLUG, number: "5" }));
    await layoutSettled();
    invokeCommand.mockResolvedValueOnce({ message: "Revert requested", resultJson: "{}" });
    await expect(revertPullRequest({ slug: SLUG, number: 5 }, "thread:a")).resolves.toBeNull();
    await layoutSettled();
    expect(toast.success).toHaveBeenCalledWith("Revert requested");
    expect(tabPlace("thread:a").tabs.map((t) => t.title)).toEqual(["#5"]);
  });

  it("opens the new pull request as a tab of the same thread", async () => {
    openTab("thread:a", makeTab("pullrequest", "#5", { slug: SLUG, number: "5" }));
    await layoutSettled();
    invokeCommand.mockResolvedValueOnce({ message: "Opened #9", resultJson: JSON.stringify({ number: 9, url: "https://github.com/acme/repo/pull/9" }) });
    await expect(revertPullRequest({ slug: SLUG, number: 5 }, "thread:a")).resolves.toEqual({ slug: SLUG, number: 9 });
    await layoutSettled();
    expect(tabPlace("thread:a").tabs.map((t) => t.title)).toEqual(["#5", "#9"]);
  });
});

describe("inner state per tab", () => {
  it("is dropped when its tab closes, and kept for a tab still open", async () => {
    await openIn({ slug: SLUG, number: 7 });
    await openIn({ slug: SLUG, number: 8 });
    const [seven, eight] = tabPlace("thread:a").tabs.map((t) => t.id);
    setInnerTab(seven ?? "", "activity");
    setInnerTab(eight ?? "", "activity");

    await applyLayoutOp({ op: "close_tab", tab: seven ?? "" });
    await layoutSettled();
    expect(Object.keys(usePrPanelStore.getState().byTab)).toEqual([eight]);

    // Reopened, it starts fresh.
    await openIn({ slug: SLUG, number: 7 });
    const again = tabPlace("thread:a").tabs.find((t) => t.params.number === "7")?.id ?? "";
    expect(usePrPanelStore.getState().byTab[again]).toBeUndefined();
  });

  it("is kept for an unlinked tab (a page's) across a change of the layout", async () => {
    await openIn({ slug: SLUG, number: 7 }, "view:pullrequests");
    const page = Object.values(useLayoutStore.getState().tabs).find((t) => t.kind === "pullrequest" && !t.thread)?.id ?? "";
    expect(page).not.toBe("");
    setInnerTab(page, "code");
    await openIn({ slug: SLUG, number: 8 });
    expect(usePrPanelStore.getState().byTab[page]?.inner).toBe("code");
  });
});
