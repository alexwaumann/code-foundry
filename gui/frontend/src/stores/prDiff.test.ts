import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDiffView } from "@/api/prDiff";

// The daemon's diff: whatever head the test says it was computed for.
const daemon = vi.hoisted(() => ({ head: "", reads: 0 }));
vi.mock("@/api/prDiff", async (orig) => ({
  ...(await orig<typeof import("@/api/prDiff")>()),
  getPullRequestDiff: () => {
    daemon.reads++;
    return Promise.resolve<PullRequestDiffView>({ diff: "", headSha: daemon.head, truncated: false, fetchedAtMs: 0 });
  },
}));

const { pullRequestDetailResource } = await import("./gh");
const { pullRequestDiffResource, warmPullRequestDiff, DIFF_WARM_AFTER_MS } = await import("./prDiff");

const KEY = "acme/repo#5";

/** The detail's head as the detail resource holds it (only the head matters here). */
function detailHead(head: string): void {
  const data = { pullRequest: { headSha: head } } as unknown as NonNullable<ReturnType<typeof pullRequestDetailResource.store.getState>["entries"][string]["data"]>;
  pullRequestDetailResource.store.setState((s) => ({ entries: { ...s.entries, [KEY]: { data, error: null, loading: false } } }));
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const diffHead = () => pullRequestDiffResource.store.getState().entries[KEY]?.data?.headSha;

let stops: (() => void)[] = [];

beforeEach(() => {
  daemon.head = "";
  daemon.reads = 0;
  pullRequestDetailResource.store.setState({ entries: {} });
  pullRequestDiffResource.store.setState({ entries: {} });
});

afterEach(() => {
  for (const s of stops) s();
  stops = [];
  vi.useRealTimers();
});

describe("a watched diff follows its detail's head", () => {
  it("reads again once per new head, not when the daemon answers with the same old one", async () => {
    detailHead("a");
    daemon.head = "a";
    stops.push(pullRequestDiffResource.watch(KEY));
    await flush();
    expect(daemon.reads).toBe(1);

    // A push: the detail moves on, the daemon's diff has not yet.
    detailHead("b");
    await flush();
    expect(daemon.reads).toBe(2);
    await flush();
    expect(daemon.reads).toBe(2);

    daemon.head = "b";
    detailHead("c");
    await flush();
    expect(daemon.reads).toBe(3);
    expect(diffHead()).toBe("b");
  });

  it("a diff read before the detail had a head is read again once it has one", async () => {
    stops.push(pullRequestDiffResource.watch(KEY));
    await flush();
    expect(daemon.reads).toBe(1);
    daemon.head = "a";
    detailHead("a");
    await flush();
    expect(daemon.reads).toBe(2);
    expect(diffHead()).toBe("a");
  });

  it("a diff nobody watches is left alone, and its next watch still re-reads a stale answer", async () => {
    detailHead("a");
    daemon.head = "a";
    const stop = pullRequestDiffResource.watch(KEY);
    await flush();
    stop();
    detailHead("b");
    await flush();
    expect(daemon.reads).toBe(1);

    // The tab opens: its first read is answered for the old head, and the head is asked for once.
    stops.push(pullRequestDiffResource.watch(KEY));
    await flush();
    await flush();
    expect(daemon.reads).toBe(3);
  });

  it("a warmed diff (the pull request's page, no diff tab) follows the head too", async () => {
    vi.useFakeTimers();
    detailHead("a");
    daemon.head = "old";
    stops.push(warmPullRequestDiff(KEY));
    await vi.advanceTimersByTimeAsync(DIFF_WARM_AFTER_MS);
    expect(daemon.reads).toBe(2);
    daemon.head = "a";
    detailHead("b");
    await vi.advanceTimersByTimeAsync(0);
    expect(daemon.reads).toBe(3);
  });
});
