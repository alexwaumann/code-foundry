import { afterEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView } from "@/api/gh";

const getPullRequestDetail = vi.hoisted(() => vi.fn());
vi.mock("@/api/gh", async (orig) => ({
  ...(await orig<typeof import("@/api/gh")>()),
  getPullRequestDetail,
}));
const { applyGhEvent, PULL_REQUEST_DETAIL_KEEPALIVE_MS, pullRequestDetailResource, pullRequestKey, refreshPullRequestDetail } = await import("./gh");

const view = (body: string, lastError = "") => ({ body, lastError }) as PullRequestDetailView;
const entry = (key: string) => pullRequestDetailResource.store.getState().entries[key];

afterEach(() => {
  vi.useRealTimers();
  getPullRequestDetail.mockReset();
});

describe("pull request detail resource", () => {
  it("keys by lower-case slug and number, and re-reads only the announced pull request", async () => {
    getPullRequestDetail.mockImplementation((slug: string, number: number) => Promise.resolve(view(`${slug}#${String(number)}`)));
    expect(pullRequestKey("Acme/Repo", 7)).toBe("acme/repo#7");

    const release = pullRequestDetailResource.watch(pullRequestKey("acme/repo", 7));
    const other = pullRequestDetailResource.watch(pullRequestKey("acme/repo", 8));
    await vi.waitFor(() => {
      expect(entry("acme/repo#7")?.data?.body).toBe("acme/repo#7");
    });
    expect(getPullRequestDetail).toHaveBeenCalledWith("acme/repo", 7, false, undefined, expect.anything());
    getPullRequestDetail.mockClear();

    applyGhEvent({ kind: "pullRequestDetail", repoSlug: "acme/repo", number: 7 });
    await vi.waitFor(() => {
      expect(getPullRequestDetail).toHaveBeenCalledTimes(1);
    });
    expect(getPullRequestDetail.mock.calls[0]?.slice(0, 3)).toEqual(["acme/repo", 7, false]);
    release();
    other();
  });

  it("refresh writes the daemon's answer into the resource without a second read", async () => {
    const key = pullRequestKey("acme/repo", 9);
    getPullRequestDetail.mockResolvedValue(view("cached"));
    const release = pullRequestDetailResource.watch(key);
    await vi.waitFor(() => {
      expect(entry(key)?.data?.body).toBe("cached");
    });
    getPullRequestDetail.mockClear();

    getPullRequestDetail.mockResolvedValueOnce(view("fresh"));
    await refreshPullRequestDetail("acme/repo", 9);
    expect(getPullRequestDetail.mock.calls.map((c): unknown[] => (c as unknown[]).slice(0, 3))).toEqual([["acme/repo", 9, true]]);
    expect(entry(key)).toMatchObject({ data: { body: "fresh", lastError: "" }, error: null, loading: false });
    release();
  });

  it("refresh keeps the cached copy's lastError, and records an RPC error", async () => {
    const key = pullRequestKey("acme/repo", 10);
    getPullRequestDetail.mockResolvedValue(view("v1"));
    const release = pullRequestDetailResource.watch(key);
    await vi.waitFor(() => {
      expect(entry(key)?.data?.body).toBe("v1");
    });

    // GitHub failed: the daemon answers with its cached copy and the error.
    getPullRequestDetail.mockResolvedValueOnce(view("v1", "cannot reach github"));
    await refreshPullRequestDetail("acme/repo", 10);
    expect(entry(key)).toMatchObject({ data: { body: "v1", lastError: "cannot reach github" }, error: null });

    // The RPC itself failed: the entry shows the error over the data, and the caller hears it.
    getPullRequestDetail.mockRejectedValueOnce(new Error("rate limited"));
    await expect(refreshPullRequestDetail("acme/repo", 10)).rejects.toThrow("rate limited");
    expect(entry(key)).toMatchObject({ data: { body: "v1" }, error: "rate limited", loading: false });
    release();
  });

  it("re-reads an open detail every poll interval, so a PR outside the poll does not go stale", async () => {
    vi.useFakeTimers();
    getPullRequestDetail.mockResolvedValue(view("x"));
    expect(PULL_REQUEST_DETAIL_KEEPALIVE_MS).toBe(60_000);
    const release = pullRequestDetailResource.watch(pullRequestKey("acme/repo", 11));
    await vi.advanceTimersByTimeAsync(0);
    expect(getPullRequestDetail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(PULL_REQUEST_DETAIL_KEEPALIVE_MS);
    expect(getPullRequestDetail).toHaveBeenCalledTimes(2);
    expect(getPullRequestDetail.mock.calls[1]?.slice(0, 3)).toEqual(["acme/repo", 11, false]);
    release();
    await vi.advanceTimersByTimeAsync(3 * PULL_REQUEST_DETAIL_KEEPALIVE_MS);
    expect(getPullRequestDetail).toHaveBeenCalledTimes(2);
  });
});
