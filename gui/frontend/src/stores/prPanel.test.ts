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

const { pullRequestDetailResource, pullRequestKey } = await import("./gh");
const { makeTab, closePanelTab, openSurface, usePanelStore } = await import("./panel");
const { prTabKey, refreshPullRequest, requestingKey, reviewerCandidatesResource, revertPullRequest, setInnerTab, setReviewRequest, usePrPanelStore } = await import("./prPanel");

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

beforeEach(() => {
  usePrPanelStore.setState({ byTab: {}, refreshing: {}, requesting: {} });
  usePanelStore.setState({ byKey: {} });
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
  const candidates = (requested: boolean): ReviewerCandidatesView => ({ candidates: [{ id: "U_lee", kind: "user", login: "lee", name: "", avatarUrl: "", isRequested: requested }], truncated: false });

  it("keeps the row busy until the candidates are read again, and ignores a second click meanwhile", async () => {
    const ref = { slug: SLUG, number: 3 };
    const key = pullRequestKey(SLUG, 3);
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

    reread.resolve(candidates(true));
    await expect(first).resolves.toBe(true);
    expect(busy()).toBe(false);
    expect(reviewerCandidatesResource.store.getState().entries[key]?.data).toEqual(candidates(true));
    release();
  });

  it("a failed request is toasted, re-reads, and clears the spinner", async () => {
    const ref = { slug: SLUG, number: 4 };
    const key = pullRequestKey(SLUG, 4);
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
    release();
  });
});

describe("revertPullRequest", () => {
  it("a result without a number toasts the daemon's message and opens no tab", async () => {
    openSurface("session:a", makeTab("pullrequest", "#5", { slug: SLUG, number: "5" }));
    invokeCommand.mockResolvedValueOnce({ message: "Revert requested", resultJson: "{}" });
    await expect(revertPullRequest({ slug: SLUG, number: 5 }, "session:a")).resolves.toBeNull();
    expect(toast.success).toHaveBeenCalledWith("Revert requested");
    expect(usePanelStore.getState().byKey["session:a"]?.tabs.map((t) => t.title)).toEqual(["#5"]);
  });

  it("opens the new pull request as a tab of the same panel", async () => {
    openSurface("session:a", makeTab("pullrequest", "#5", { slug: SLUG, number: "5" }));
    invokeCommand.mockResolvedValueOnce({ message: "Opened #9", resultJson: JSON.stringify({ number: 9, url: "https://github.com/acme/repo/pull/9" }) });
    await expect(revertPullRequest({ slug: SLUG, number: 5 }, "session:a")).resolves.toEqual({ slug: SLUG, number: 9 });
    expect(usePanelStore.getState().byKey["session:a"]?.tabs.map((t) => t.title)).toEqual(["#5", "#9"]);
  });
});

describe("inner state per tab", () => {
  it("is dropped when its tab closes, and kept while another panel still has the tab", () => {
    const tab = makeTab("pullrequest", "#7", { slug: SLUG, number: "7" });
    openSurface("session:a", tab);
    openSurface("session:b", tab);
    setInnerTab(prTabKey("session:a", tab.id), "timeline");
    setInnerTab(prTabKey("session:b", tab.id), "timeline");

    closePanelTab("session:a", tab.id);
    expect(Object.keys(usePrPanelStore.getState().byTab)).toEqual([prTabKey("session:b", tab.id)]);

    // Reopened, it starts fresh.
    openSurface("session:a", tab);
    expect(usePrPanelStore.getState().byTab[prTabKey("session:a", tab.id)]).toBeUndefined();
  });
});
