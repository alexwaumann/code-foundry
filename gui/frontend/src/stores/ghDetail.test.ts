import { describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView } from "@/api/gh";

const getPullRequestDetail = vi.hoisted(() => vi.fn());
vi.mock("@/api/gh", async (orig) => ({
  ...(await orig<typeof import("@/api/gh")>()),
  getPullRequestDetail,
}));
const { applyGhEvent, pullRequestDetailResource, pullRequestKey, refreshPullRequestDetail } = await import("./gh");

describe("pull request detail resource", () => {
  it("keys by lower-case slug and number, and re-reads only the announced pull request", async () => {
    getPullRequestDetail.mockImplementation((slug: string, number: number) => Promise.resolve({ body: `${slug}#${String(number)}` } as PullRequestDetailView));
    expect(pullRequestKey("Acme/Repo", 7)).toBe("acme/repo#7");

    const release = pullRequestDetailResource.watch(pullRequestKey("acme/repo", 7));
    const other = pullRequestDetailResource.watch(pullRequestKey("acme/repo", 8));
    await vi.waitFor(() => {
      expect(pullRequestDetailResource.store.getState().entries["acme/repo#7"]?.data?.body).toBe("acme/repo#7");
    });
    expect(getPullRequestDetail).toHaveBeenCalledWith("acme/repo", 7, false, undefined, expect.anything());
    getPullRequestDetail.mockClear();

    applyGhEvent({ kind: "pullRequestDetail", repoSlug: "acme/repo", number: 7 });
    await vi.waitFor(() => {
      expect(getPullRequestDetail).toHaveBeenCalledTimes(1);
    });
    expect(getPullRequestDetail.mock.calls[0]?.slice(0, 3)).toEqual(["acme/repo", 7, false]);

    // Refresh asks the daemon to fetch from GitHub, then re-reads the (now fresh) cache.
    getPullRequestDetail.mockClear();
    await refreshPullRequestDetail("acme/repo", 8);
    await vi.waitFor(() => {
      expect(getPullRequestDetail).toHaveBeenCalledTimes(2);
    });
    expect(getPullRequestDetail.mock.calls.map((c): unknown[] => (c as unknown[]).slice(0, 3))).toEqual([
      ["acme/repo", 8, true],
      ["acme/repo", 8, false],
    ]);
    release();
    other();
  });
});
