import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView, PrStateView } from "@/api/gh";

const invokeCommand = vi.hoisted(() => vi.fn());
const listCommands = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand, listCommands }));

const getPullRequestDetail = vi.hoisted(() => vi.fn());
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getPullRequestDetail }));

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice: vi.fn() }));

const copyText = vi.hoisted(() => vi.fn());
vi.mock("@/lib/clipboard", () => ({ copyText }));

const { pullRequestDetailResource, pullRequestKey } = await import("./gh");
const { canClosePullRequest, canReopenPullRequest, closePullRequest, copyPullRequestBranch, reopenPullRequest, usePrCloseStore } = await import("./prClose");

const SLUG = "acme/repo";
const entry = (key: string) => pullRequestDetailResource.store.getState().entries[key];
const detail = (state: PrStateView, opts: { draft?: boolean; canClose?: boolean; canReopen?: boolean } = {}) =>
  ({
    pullRequest: { state, draft: opts.draft ?? false },
    viewerCanClose: opts.canClose ?? false,
    viewerCanReopen: opts.canReopen ?? false,
  }) as PullRequestDetailView;

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  usePrCloseStore.setState({ closing: {} });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("canClosePullRequest / canReopenPullRequest", () => {
  it.each([
    ["open, may close", detail("open", { canClose: true }), true, false],
    ["a draft, may close", detail("open", { draft: true, canClose: true }), true, false],
    ["open, may not close", detail("open"), false, false],
    ["closed, may reopen", detail("closed", { canClose: true, canReopen: true }), false, true],
    ["closed, may not reopen", detail("closed", { canClose: true }), false, false],
    // GitHub reports viewerCanClose on a merged pull request too.
    ["merged", detail("merged", { canClose: true, canReopen: true }), false, false],
    ["unknown state", detail("unknown", { canClose: true, canReopen: true }), false, false],
  ])("%s", (_name, d, close, reopen) => {
    expect(canClosePullRequest(d)).toBe(close);
    expect(canReopenPullRequest(d)).toBe(reopen);
  });
});

describe("closePullRequest / reopenPullRequest", () => {
  it("runs pr.close and stays busy until the detail is read again; a second call meanwhile sends nothing", async () => {
    const ref = { slug: SLUG, number: 5 };
    const key = pullRequestKey(SLUG, 5);
    getPullRequestDetail.mockResolvedValueOnce(detail("open", { canClose: true }));
    const release = pullRequestDetailResource.watch(key);
    await vi.waitFor(() => {
      expect(entry(key)?.data?.pullRequest.state).toBe("open");
    });
    const reread = deferred<PullRequestDetailView>();
    getPullRequestDetail.mockReturnValueOnce(reread.promise);
    invokeCommand.mockResolvedValueOnce({ message: "Closed #5", resultJson: "{}" });
    const busy = () => usePrCloseStore.getState().closing[key] ?? null;

    const first = closePullRequest(ref);
    expect(busy()).toBe("close");
    await vi.waitFor(() => {
      expect(getPullRequestDetail).toHaveBeenCalledTimes(2);
    });
    await expect(reopenPullRequest(ref)).resolves.toBe(false);
    await expect(closePullRequest(ref)).resolves.toBe(false);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith("pr.close", expect.anything(), { "repo-slug": SLUG, number: "5" });
    expect(busy()).toBe("close");
    reread.resolve(detail("closed", { canClose: true, canReopen: true }));
    await expect(first).resolves.toBe(true);
    expect(busy()).toBeNull();
    expect(entry(key)?.data?.pullRequest.state).toBe("closed");
    // From the menu: the daemon's message is toasted.
    expect(notify).toHaveBeenCalledWith({ level: "success", title: "Closed #5" });
    release();
  });

  it("runs pr.reopen, quietly when the control shows the change", async () => {
    invokeCommand.mockResolvedValueOnce({ message: "Reopened #6", resultJson: "{}" });
    await expect(reopenPullRequest({ slug: SLUG, number: 6 }, { inView: true })).resolves.toBe(true);
    expect(invokeCommand).toHaveBeenCalledWith("pr.reopen", expect.anything(), { "repo-slug": SLUG, number: "6" });
    expect(notify).not.toHaveBeenCalled();
    expect(usePrCloseStore.getState().closing).toEqual({});
  });

  it("a refusal is toasted with the daemon's message, re-reads, and frees the flag without waiting for that read", async () => {
    const ref = { slug: SLUG, number: 7 };
    const key = pullRequestKey(SLUG, 7);
    getPullRequestDetail.mockResolvedValueOnce(detail("merged"));
    const release = pullRequestDetailResource.watch(key);
    await vi.waitFor(() => {
      expect(entry(key)?.data?.pullRequest.state).toBe("merged");
    });
    const reread = deferred<PullRequestDetailView>();
    getPullRequestDetail.mockReturnValueOnce(reread.promise);
    invokeCommand.mockRejectedValueOnce(new ConnectError("failed precondition: pull request #7 is merged; a merged pull request cannot be reopened", Code.FailedPrecondition));

    await expect(reopenPullRequest(ref)).resolves.toBe(false);
    expect(notify).toHaveBeenCalledWith({ level: "error", title: "pr.reopen failed", description: expect.stringContaining("cannot be reopened") as unknown });
    expect(getPullRequestDetail).toHaveBeenCalledTimes(2);
    expect(entry(key)?.loading).toBe(true);
    expect(usePrCloseStore.getState().closing).toEqual({});
    reread.resolve(detail("merged"));
    await vi.waitFor(() => {
      expect(entry(key)?.loading).toBe(false);
    });
    release();
  });
});

describe("copyPullRequestBranch", () => {
  it("copies the branch name and says so", async () => {
    copyText.mockResolvedValueOnce(undefined);
    await copyPullRequestBranch("feat/pr-close-reopen");
    expect(copyText).toHaveBeenCalledWith("feat/pr-close-reopen");
    expect(notify).toHaveBeenCalledWith({ level: "success", title: "Branch name copied", description: "feat/pr-close-reopen" });
  });

  it("a failed copy is toasted", async () => {
    copyText.mockRejectedValueOnce(new Error("denied"));
    await copyPullRequestBranch("main");
    expect(notify).toHaveBeenCalledWith({ level: "error", title: "Copy failed" });
  });
});
