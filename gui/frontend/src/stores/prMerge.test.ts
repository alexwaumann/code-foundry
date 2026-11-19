import { Code, ConnectError } from "@connectrpc/connect";
import type { PullRequestDetailView } from "@/api/gh";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
const listCommands = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand, listCommands }));

const getPullRequestDetail = vi.hoisted(() => vi.fn(() => new Promise(() => undefined)));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getPullRequestDetail }));

const notify = vi.hoisted(() => vi.fn());
vi.mock("@/lib/notify", () => ({ notify, notifyProgress: vi.fn(), dismissNotice: vi.fn() }));

const { pullRequestDetailResource, pullRequestKey } = await import("./gh");
const { mergePullRequest, usePrPanelStore } = await import("./prPanel");

const REF = { slug: "acme/repo", number: 142 };
const HEAD = "e2e0142e2e0142e2e0142e2e0142e2e0142e2e01";
const KEY = pullRequestKey(REF.slug, REF.number);

function deferred<T>() {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

beforeEach(() => {
  usePrPanelStore.setState({ merging: {} });
  pullRequestDetailResource.store.setState({ entries: {} });
});

const detail = (state: "open" | "merged") => ({ pullRequest: { state } }) as unknown as PullRequestDetailView;
const flush = () => new Promise((r) => setTimeout(r, 0));

afterEach(() => {
  vi.clearAllMocks();
});

describe("mergePullRequest", () => {
  it("runs pr.merge with the method, the branch choice and the head shown, busy until it answers, then toasts and re-reads", async () => {
    const answer = deferred<unknown>();
    invokeCommand.mockReturnValueOnce(answer.promise);
    const invalidate = vi.spyOn(pullRequestDetailResource, "invalidate");
    const run = mergePullRequest(REF, "squash", true, HEAD);
    // Busy with the method chosen: the button's words come from it.
    expect(usePrPanelStore.getState().merging[KEY]).toBe("squash");
    // A second click meanwhile sends nothing.
    await expect(mergePullRequest(REF, "merge", false, HEAD)).resolves.toBe(false);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    const [name, , args] = invokeCommand.mock.calls[0] as [string, unknown, Record<string, string>];
    expect(name).toBe("pr.merge");
    expect(args).toEqual({ "repo-slug": "acme/repo", number: "142", method: "squash", "delete-branch": "true", "head-sha": HEAD });

    answer.resolve({ message: "ignored", resultJson: JSON.stringify({ merged: true, sha: "abc", message: "Merged #142 (abc1234); deleted origin/feat/x", branchDeleted: true }) });
    await expect(run).resolves.toBe(true);
    expect(notify).toHaveBeenCalledWith({ level: "success", title: "Merged #142 (abc1234)", description: "deleted origin/feat/x" });
    expect(invalidate).toHaveBeenCalledWith(KEY);
    expect(usePrPanelStore.getState().merging[KEY]).toBeUndefined();
  });

  it("falls back to the command's message", async () => {
    invokeCommand.mockResolvedValueOnce({ message: "Merged #142 (abc1234)", resultJson: "" });
    await expect(mergePullRequest(REF, "rebase", false, HEAD)).resolves.toBe(true);
    expect(notify).toHaveBeenCalledWith({ level: "success", title: "Merged #142 (abc1234)" });
  });

  it("a refusal is toasted, not reported as merged, and the detail is read again", async () => {
    invokeCommand.mockRejectedValueOnce(new ConnectError("pull request #142 changed since it was shown (head 1111111, shown e2e0142); refresh and try again", Code.FailedPrecondition));
    const invalidate = vi.spyOn(pullRequestDetailResource, "invalidate");
    await expect(mergePullRequest(REF, "squash", true, HEAD)).resolves.toBe(false);
    expect(notify).not.toHaveBeenCalledWith(expect.objectContaining({ level: "success" }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ level: "error", title: "pr.merge failed", description: expect.stringContaining("changed since it was shown") as string }));
    expect(invalidate).toHaveBeenCalledWith(KEY);
    expect(usePrPanelStore.getState().merging[KEY]).toBeUndefined();
  });

  it("asked in the merge dialog: sent once, confirmed; busy until the detail shows it merged, a lagging read asked again", async () => {
    const reads: ReturnType<typeof deferred<PullRequestDetailView>>[] = [];
    getPullRequestDetail.mockImplementation(() => {
      const d = deferred<PullRequestDetailView>();
      reads.push(d);
      return d.promise;
    });
    const release = pullRequestDetailResource.watch(KEY);
    reads[0]?.resolve(detail("open"));
    await flush();
    const answer = deferred<unknown>();
    invokeCommand.mockReturnValueOnce(answer.promise);
    const run = mergePullRequest(REF, "rebase", false, HEAD, { asked: true });
    await flush();
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    expect(invokeCommand).toHaveBeenCalledWith("pr.merge", expect.anything(), { "repo-slug": "acme/repo", number: "142", method: "rebase", "delete-branch": "false", "head-sha": HEAD }, undefined, { confirmed: true });
    answer.resolve({ message: "", resultJson: JSON.stringify({ merged: true, sha: "abc", message: "Merged #142 (abc1234)" }) });
    await flush();
    // Read at once, not at the next poll.
    expect(reads).toHaveLength(2);
    expect(usePrPanelStore.getState().merging[KEY]).toBe("rebase");
    // A read that still says open (begun before GitHub had it) keeps it busy and asks again.
    reads[1]?.resolve(detail("open"));
    await flush();
    expect(reads).toHaveLength(3);
    expect(usePrPanelStore.getState().merging[KEY]).toBe("rebase");
    reads[2]?.resolve(detail("merged"));
    await expect(run).resolves.toBe(true);
    expect(usePrPanelStore.getState().merging[KEY]).toBeUndefined();
    release();
    getPullRequestDetail.mockReset();
    getPullRequestDetail.mockImplementation(() => new Promise(() => undefined));
  });

  it("a merge GitHub did not finish (queued) waits for the re-read only; a refusal frees at once", async () => {
    const reads: ReturnType<typeof deferred<PullRequestDetailView>>[] = [];
    getPullRequestDetail.mockImplementation(() => {
      const d = deferred<PullRequestDetailView>();
      reads.push(d);
      return d.promise;
    });
    const release = pullRequestDetailResource.watch(KEY);
    reads[0]?.resolve(detail("open"));
    await flush();
    invokeCommand.mockResolvedValueOnce({ message: "", resultJson: JSON.stringify({ merged: false, sha: "", message: "Queued #142" }) });
    const run = mergePullRequest(REF, "squash", false, HEAD, { asked: true });
    await flush();
    expect(usePrPanelStore.getState().merging[KEY]).toBe("squash");
    reads[1]?.resolve(detail("open"));
    await expect(run).resolves.toBe(true);
    expect(usePrPanelStore.getState().merging[KEY]).toBeUndefined();

    invokeCommand.mockRejectedValueOnce(new ConnectError("pull request #142 changed since it was shown", Code.FailedPrecondition));
    await expect(mergePullRequest(REF, "squash", false, HEAD, { asked: true })).resolves.toBe(false);
    expect(usePrPanelStore.getState().merging[KEY]).toBeUndefined();
    expect(reads).toHaveLength(3);
    release();
    getPullRequestDetail.mockReset();
    getPullRequestDetail.mockImplementation(() => new Promise(() => undefined));
  });
});
