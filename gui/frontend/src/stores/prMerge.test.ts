import { Code, ConnectError } from "@connectrpc/connect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const invokeCommand = vi.hoisted(() => vi.fn());
const listCommands = vi.hoisted(() => vi.fn(() => Promise.resolve([])));
vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), invokeCommand, listCommands }));

const getPullRequestDetail = vi.hoisted(() => vi.fn(() => new Promise(() => undefined)));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), getPullRequestDetail }));

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock("sonner", () => ({ toast }));

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
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("mergePullRequest", () => {
  it("runs pr.merge with the method, the branch choice and the head shown, busy until it answers, then toasts and re-reads", async () => {
    const answer = deferred<unknown>();
    invokeCommand.mockReturnValueOnce(answer.promise);
    const invalidate = vi.spyOn(pullRequestDetailResource, "invalidate");
    const run = mergePullRequest(REF, "squash", true, HEAD);
    expect(usePrPanelStore.getState().merging[KEY]).toBe(true);
    // A second click meanwhile sends nothing.
    await expect(mergePullRequest(REF, "merge", false, HEAD)).resolves.toBe(false);
    expect(invokeCommand).toHaveBeenCalledTimes(1);
    const [name, , args] = invokeCommand.mock.calls[0] as [string, unknown, Record<string, string>];
    expect(name).toBe("pr.merge");
    expect(args).toEqual({ "repo-slug": "acme/repo", number: "142", method: "squash", "delete-branch": "true", "head-sha": HEAD });

    answer.resolve({ message: "ignored", resultJson: JSON.stringify({ merged: true, sha: "abc", message: "Merged #142 (abc1234); deleted origin/feat/x", branchDeleted: true }) });
    await expect(run).resolves.toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Merged #142 (abc1234)", { description: "deleted origin/feat/x" });
    expect(invalidate).toHaveBeenCalledWith(KEY);
    expect(usePrPanelStore.getState().merging[KEY]).toBeUndefined();
  });

  it("falls back to the command's message", async () => {
    invokeCommand.mockResolvedValueOnce({ message: "Merged #142 (abc1234)", resultJson: "" });
    await expect(mergePullRequest(REF, "rebase", false, HEAD)).resolves.toBe(true);
    expect(toast.success).toHaveBeenCalledWith("Merged #142 (abc1234)", undefined);
  });

  it("a refusal is toasted, not reported as merged, and the detail is read again", async () => {
    invokeCommand.mockRejectedValueOnce(new ConnectError("pull request #142 changed since it was shown (head 1111111, shown e2e0142); refresh and try again", Code.FailedPrecondition));
    const invalidate = vi.spyOn(pullRequestDetailResource, "invalidate");
    await expect(mergePullRequest(REF, "squash", true, HEAD)).resolves.toBe(false);
    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith("pr.merge failed", expect.objectContaining({ description: expect.stringContaining("changed since it was shown") as string }));
    expect(invalidate).toHaveBeenCalledWith(KEY);
    expect(usePrPanelStore.getState().merging[KEY]).toBeUndefined();
  });
});
