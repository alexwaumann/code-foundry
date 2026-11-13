import { act, cleanup, fireEvent, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PullRequestDetailView, PullRequestView } from "@/api/gh";

/**
 * The Pull request surface while a detail with nothing cached is on its way
 * (docs/notes/pr-open-instant.md). Detail reads wait at a gate here, as a daemon's would at
 * GitHub; the rest of the world is src/test/prWorld.ts. seed.test.ts has which rows a dashboard
 * row can fill; this is what the surface does with them, and when the Code tab's diff is read.
 */

const gate = vi.hoisted(() => ({
  closed: false,
  waiting: new Map<number, () => void>(),
  aborted: [] as number[],
}));
const getPullRequestDiff = vi.hoisted(() => vi.fn());

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => {
  const { prGhFakes } = await import("@/test/prWorld");
  return {
    ...(await orig<typeof import("@/api/gh")>()),
    ...prGhFakes,
    getPullRequestDetail: (slug: string, number: number, _refresh: boolean, _conn: unknown, signal?: AbortSignal) =>
      new Promise((resolve, reject) => {
        const answer = () => {
          prGhFakes.getPullRequestDetail(slug, number).then(resolve, reject);
        };
        if (!gate.closed) {
          answer();
          return;
        }
        gate.waiting.set(number, answer);
        signal?.addEventListener("abort", () => {
          gate.waiting.delete(number);
          gate.aborted.push(number);
          reject(new DOMException("aborted", "AbortError"));
        });
      }),
  };
});
vi.mock("@/api/prDiff", async (orig) => ({ ...(await orig<typeof import("@/api/prDiff")>()), getPullRequestDiff }));
vi.mock("@pierre/diffs/react", () => ({ CodeView: () => <div data-testid="code-view-stub" /> }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { resetDaemon } = await import("@/test/daemonFakes");
const { seedPrWorld, SLUG } = await import("@/test/prWorld");
const { openPr, renderPrPanel, resetPrStores, selectPrTab, settle, texts } = await import("@/test/prPanelHarness");
const { applyGhEvent, DASHBOARD_KEY, dashboardResource, branchKey, branchPullRequestsResource, pullRequestDetailResource, pullRequestKey, usePollStore } = await import("@/stores/gh");
const { DIFF_WARM_AFTER_MS, pullRequestDiffResource } = await import("@/stores/prDiff");

let world: ReturnType<typeof seedPrWorld>;

beforeEach(async () => {
  resetDaemon();
  world = seedPrWorld();
  await resetPrStores();
  pullRequestDiffResource.store.setState({ entries: {} });
  branchPullRequestsResource.store.setState({ entries: {} });
  usePollStore.setState({ lastError: "" });
  gate.closed = true;
  gate.waiting.clear();
  gate.aborted = [];
  dashboardResource.set(DASHBOARD_KEY, { data: world.dashboard });
  getPullRequestDiff.mockImplementation((_slug: string, number: number) => Promise.resolve({ diff: "", headSha: world.detail(number)?.pullRequest.headSha ?? "", truncated: false, fetchedAtMs: null }));
});

afterEach(async () => {
  cleanup(); // releases the surface's watches
  await settle();
  vi.useRealTimers();
  vi.clearAllMocks();
});

const byTestId = (id: string) => screen.getByTestId(id);
const queryTestId = (id: string) => screen.queryByTestId(id);
const rows = () => screen.getAllByTestId("pr-ready-row").map((r) => r.dataset.row);

/** Lets number's held read answer. */
async function land(number: number): Promise<void> {
  gate.waiting.get(number)?.();
  gate.waiting.delete(number);
  await settle(3);
}

/** A dashboard with its authored list changed, as a poll lands it. */
function setAuthored(change: (authored: PullRequestView[]) => PullRequestView[]): void {
  act(() => {
    dashboardResource.set(DASHBOARD_KEY, { data: { ...world.dashboard, authored: change(world.dashboard.authored) } });
  });
}

const mapRow = (number: number, o: Partial<PullRequestView>) => (authored: PullRequestView[]) => authored.map((p) => (p.number === number ? { ...p, ...o } : p));

/** Nothing that acts on the pull request is on screen. */
function expectNoActions(): void {
  for (const id of ["pr-merge-button", "pr-auto-merge-button", "pr-review-button", "pr-cancel-auto-merge", "pr-ready-for-review", "pr-revert", "pr-menu-button", "pr-approve-workflow"]) expect(queryTestId(id)).toBeNull();
  expect(byTestId("pr-readiness").querySelectorAll("button")).toHaveLength(0);
}

describe("seeded from the dashboard's row", () => {
  it("#142: the header and the rows at once, bars for the verdict, the controls and the body, nothing to press; the detail lands in the same surface", async () => {
    renderPrPanel();
    await openPr(142);
    const surface = byTestId("pr-surface");
    expect(surface.dataset.seeded).toBe("");
    expect(queryTestId("pr-loading")).toBeNull();
    expect(byTestId("pr-title").textContent).toBe("feat(gui): virtualized sidebar tree with thread rows");
    expect(byTestId("pr-state").textContent).toBe("Open");
    expect(byTestId("pr-author").textContent).toBe("alexwaumann");
    expect(byTestId("pr-branches").textContent).toMatch(/main\s*feat\/sidebar/);
    expect(byTestId("pr-diffstat").textContent).toContain("+");
    expect(byTestId("pr-ages").textContent).toMatch(/^· opened .* · updated /);
    expect(rows()).toEqual(["checks", "review", "mergeable"]);
    expect(texts("pr-ready-title")[0]).toBe("All 31 checks passed · 2 skipped");
    expect(byTestId("pr-ready-headline").textContent).toBe("");
    expect(byTestId("pr-ready-pending")).toBeTruthy();
    expect(byTestId("pr-ready-footer-pending")).toBeTruthy();
    expect(byTestId("pr-seed-body").getAttribute("aria-busy")).toBe("true");
    expect(byTestId("pr-menu-pending")).toBeTruthy();
    expectNoActions();
    // Open on GitHub needs no detail: it is a link.
    expect(byTestId("pr-open-github")).toBeTruthy();

    await land(142);
    expect(byTestId("pr-surface")).toBe(surface);
    expect(surface.dataset.seeded).toBeUndefined();
    expect(byTestId("pr-ready-headline").textContent).toBe("Ready to merge");
    expect(byTestId("pr-merge-button")).toBeTruthy();
    expect(byTestId("pr-menu-button")).toBeTruthy();
    expect(queryTestId("pr-seed-body")).toBeNull();
    expect(queryTestId("pr-ready-pending")).toBeNull();
  });

  it("a row on a branch list on screen seeds too; a pull request with no row keeps the skeleton; so does a partial one", async () => {
    const branchRow = { ...(world.dashboard.authored[0] as PullRequestView), number: 901, title: "On a branch list" };
    world.details.set(pullRequestKey(SLUG, 901), { ...(world.detail(142) as PullRequestDetailView), pullRequest: branchRow });
    branchPullRequestsResource.set(branchKey(SLUG, "b"), { data: { pullRequests: [branchRow], fetchedAtMs: null, lastError: "" } });
    setAuthored((a) => [...a, { ...branchRow, number: 902, title: "", partial: true }]);
    renderPrPanel();
    await openPr(901);
    expect(byTestId("pr-title").textContent).toBe("On a branch list");
    await openPr(903);
    expect(byTestId("pr-loading")).toBeTruthy();
    expect(queryTestId("pr-surface")).toBeNull();
    await openPr(902);
    expect(byTestId("pr-loading")).toBeTruthy();
  });

  it("a draft: its row without Ready for review until the detail says who may", async () => {
    renderPrPanel();
    await openPr(145);
    expect(byTestId("pr-state").textContent).toBe("Draft");
    expect(rows()[0]).toBe("draft");
    expect(texts("pr-ready-title")[1]).toBe("2 checks failing · 2 running · 2 passed · 1 skipped");
    expectNoActions();
    await land(145);
    expect(byTestId("pr-ready-for-review")).toBeTruthy();
    // The names the rollup could not give.
    expect(texts("pr-ready-check")).toHaveLength(2);
  });

  it("merged: settled, so the headline shows; Revert and the commit wait for the detail", async () => {
    renderPrPanel();
    await openPr(138);
    expect(byTestId("pr-state").textContent).toBe("Merged");
    expect(byTestId("pr-ready-headline").textContent).toBe("Merged");
    expect(texts("pr-ready-title")).toEqual(["Merged into main 1d ago"]);
    expect(queryTestId("pr-ready-footer-pending")).toBeNull();
    expectNoActions();
    await land(138);
    expect(texts("pr-ready-title")).toEqual(["Merged into main by alexwaumann 1d ago"]);
    expect(byTestId("pr-revert")).toBeTruthy();
  });

  it("closed: settled too, with no invented closing time", async () => {
    setAuthored((a) => [...a, { ...(a[0] as PullRequestView), number: 131, title: "Gave up", state: "closed", mergeable: null, mergeState: "" }]);
    renderPrPanel();
    await openPr(131);
    expect(byTestId("pr-state").textContent).toBe("Closed");
    expect(byTestId("pr-ready-headline").textContent).toBe("Closed without merging");
    expect(byTestId("pr-ages").textContent).toMatch(/^· opened [^·]*$/);
    expect(queryTestId("pr-ready-footer-pending")).toBeNull();
  });

  it("a row that differs from the detail gives way whole: nothing of it stays, not even once the list moves again", async () => {
    setAuthored(mapRow(142, { title: "An older title", state: "open", review: "changes_requested", checks: { state: "failure", total: 1, passed: 0, failed: 1, pending: 0, skipped: 0 } }));
    renderPrPanel();
    await openPr(142);
    expect(byTestId("pr-title").textContent).toBe("An older title");
    expect(rows()).toContain("checks");
    expect(texts("pr-ready-title")[0]).toBe("1 check failing");
    await land(142);
    expect(byTestId("pr-title").textContent).toBe("feat(gui): virtualized sidebar tree with thread rows");
    expect(byTestId("pr-ready-headline").textContent).toBe("Ready to merge");
    expect(texts("pr-ready-title").join()).not.toContain("failing");
    setAuthored(mapRow(142, { title: "Older still" }));
    await settle();
    expect(byTestId("pr-title").textContent).toBe("feat(gui): virtualized sidebar tree with thread rows");
  });

  it("a row open on the dashboard, merged on GitHub: the state changes when the detail lands, with the actions it allows", async () => {
    setAuthored(mapRow(138, { state: "open", mergedAtMs: null }));
    world.dashboard.recentlyMerged = [];
    setAuthored((a) => [...a, { ...(a[0] as PullRequestView), number: 138, title: "chore(gh): pace requests through one worker", state: "open", mergedAtMs: null }]);
    act(() => {
      dashboardResource.set(DASHBOARD_KEY, { data: { ...(dashboardResource.store.getState().entries[DASHBOARD_KEY]?.data ?? world.dashboard), recentlyMerged: [] } });
    });
    renderPrPanel();
    await openPr(138);
    expect(byTestId("pr-state").textContent).toBe("Open");
    expect(byTestId("pr-ready-footer-pending")).toBeTruthy();
    await land(138);
    expect(byTestId("pr-state").textContent).toBe("Merged");
    expect(queryTestId("pr-ready-footer-pending")).toBeNull();
    expect(queryTestId("pr-merge-button")).toBeNull();
  });

  it("a row that leaves the list during the wait stays on screen; the detail then takes over", async () => {
    renderPrPanel();
    await openPr(142);
    setAuthored((a) => a.filter((p) => p.number !== 142));
    await settle();
    expect(queryTestId("pr-loading")).toBeNull();
    expect(byTestId("pr-title").textContent).toBe("feat(gui): virtualized sidebar tree with thread rows");
    await land(142);
    expect(byTestId("pr-ready-headline").textContent).toBe("Ready to merge");
  });

  it("the tabs work while it waits: the choice holds, the box goes compact on Code, and the bars stay", async () => {
    renderPrPanel();
    await openPr(142);
    fireEvent.click(byTestId("pr-tab-activity"));
    expect(byTestId("pr-tab-activity").getAttribute("aria-selected")).toBe("true");
    expect(byTestId("pr-seed-body")).toBeTruthy();
    expect(queryTestId("pr-timeline-counts")).toBeNull();
    fireEvent.click(byTestId("pr-tab-code"));
    expect(byTestId("pr-readiness").dataset.compact).toBe("true");
    expect(queryTestId("pr-ready-row")).toBeNull();
    expect(byTestId("pr-seed-body")).toBeTruthy();
    expect(getPullRequestDiff).not.toHaveBeenCalled(); // no head to read it for yet
    await land(142);
    expect(byTestId("pr-tab-code").getAttribute("aria-selected")).toBe("true");
    expect(byTestId("pr-code")).toBeTruthy();
  });
});

describe("the detail failing after a seed", () => {
  it("keeps what the row said and says why: no bars left running, no actions; a later read that works takes over", async () => {
    world.readErrors.set(pullRequestKey(SLUG, 142), new Error("paused until 12:00:00: rate limit"));
    renderPrPanel();
    await openPr(142);
    await land(142);
    expect(byTestId("pr-title").textContent).toBe("feat(gui): virtualized sidebar tree with thread rows");
    expect(byTestId("pr-seed-error").textContent).toContain("paused until 12:00:00: rate limit");
    expect(queryTestId("pr-error")).toBeNull();
    expect(queryTestId("pr-seed-body")).toBeNull();
    expect(queryTestId("pr-ready-pending")).toBeNull();
    expect(queryTestId("pr-ready-footer-pending")).toBeNull();
    expect(byTestId("pr-ready-headline").textContent).toBe("Readiness unknown");
    expectNoActions();

    world.readErrors.clear();
    gate.closed = false;
    await act(async () => {
      applyGhEvent({ kind: "pullRequestDetail", repoSlug: SLUG, number: 142 });
      await Promise.resolve();
    });
    await settle(3);
    expect(queryTestId("pr-seed-error")).toBeNull();
    expect(byTestId("pr-merge-button")).toBeTruthy();
  });

  it("not found beats the row: it is gone, or this account cannot see it", async () => {
    world.details.delete(pullRequestKey(SLUG, 142));
    renderPrPanel();
    await openPr(142);
    expect(byTestId("pr-title")).toBeTruthy();
    await land(142);
    expect(byTestId("pr-not-found")).toBeTruthy();
    expect(queryTestId("pr-surface")).toBeNull();
  });

  it("with no row, the error page as before", async () => {
    world.readErrors.set(pullRequestKey(SLUG, 903), new Error("paused until 12:00:00: rate limit"));
    renderPrPanel();
    await openPr(903);
    await land(903);
    expect(byTestId("pr-error").textContent).toContain("rate limit");
  });
});

describe("switching between pull requests", () => {
  it("no stale paint: each tab shows its own row, and the read left behind is aborted and lands nowhere", async () => {
    renderPrPanel();
    await openPr(142);
    await openPr(145);
    expect(byTestId("pr-surface").dataset.pr).toBe(`${SLUG}#145`);
    expect(byTestId("pr-title").textContent).toBe("fix(terminal): resize race between attach and first output");
    expect(gate.aborted).toEqual([142]);
    await land(145);
    expect(byTestId("pr-ready-headline").textContent).toContain("Not ready to merge");
    expect(pullRequestDetailResource.store.getState().entries[pullRequestKey(SLUG, 142)]).toMatchObject({ data: null, loading: false, error: null });
  });

  it("back on the first, it reads again and the seed shows meanwhile", async () => {
    renderPrPanel();
    await openPr(142);
    await openPr(145);
    await selectPrTab("#142");
    await settle();
    expect(byTestId("pr-title").textContent).toBe("feat(gui): virtualized sidebar tree with thread rows");
    expect(byTestId("pr-surface").dataset.seeded).toBe("");
    await land(142);
    expect(byTestId("pr-ready-headline").textContent).toBe("Ready to merge");
  });
});

describe("the Code tab's diff", () => {
  const reads = () => getPullRequestDiff.mock.calls.length;
  const wait = async (ms = DIFF_WARM_AFTER_MS) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  it("is read once the detail has landed, behind it; the tab finds it and reads nothing more", async () => {
    renderPrPanel();
    await openPr(142);
    await wait();
    expect(reads()).toBe(0);
    await land(142);
    expect(reads()).toBe(0);
    await wait();
    expect(reads()).toBe(1);
    await settle();
    fireEvent.click(byTestId("pr-tab-code"));
    await settle();
    fireEvent.click(byTestId("pr-tab-overview"));
    await settle();
    await wait();
    expect(pullRequestDiffResource.store.getState().entries[pullRequestKey(SLUG, 142)]?.data?.headSha).toBe(world.detail(142)?.pullRequest.headSha);
    expect(reads()).toBe(2); // the tab's own read: the daemon's memory, not GitHub
  });

  it("waits while a detail read is in flight: someone is waiting for that", async () => {
    renderPrPanel();
    await openPr(142);
    await land(142);
    gate.closed = true;
    const release = pullRequestDetailResource.watch(pullRequestKey(SLUG, 145));
    await wait(DIFF_WARM_AFTER_MS * 3);
    expect(reads()).toBe(0);
    await land(145);
    await wait();
    expect(reads()).toBe(1);
    release();
  });

  it("only for what is on screen: leaving before it starts reads nothing", async () => {
    renderPrPanel();
    await openPr(142);
    await land(142);
    await openPr(145);
    await wait(DIFF_WARM_AFTER_MS * 2);
    expect(reads()).toBe(0);
  });

  it("not behind a copy being refreshed, whose head may be about to go, nor after a failed fetch or while the poll fails", async () => {
    gate.closed = false;
    world.update(142, (d) => ({ ...d, refreshing: true }));
    world.update(145, (d) => ({ ...d, fetchFailed: true, lastError: "boom" }));
    renderPrPanel();
    await openPr(142);
    await wait(DIFF_WARM_AFTER_MS * 2);
    expect(reads()).toBe(0);
    world.update(142, (d) => ({ ...d, refreshing: false }));
    await act(async () => {
      applyGhEvent({ kind: "pullRequestDetail", repoSlug: SLUG, number: 142 });
      await Promise.resolve();
    });
    await settle(3);
    await wait();
    expect(reads()).toBe(1);

    await openPr(145);
    await wait(DIFF_WARM_AFTER_MS * 2);
    expect(reads()).toBe(1);

    usePollStore.setState({ lastError: "paused until 12:00:00: rate limit" });
    await openPr(139);
    await wait(DIFF_WARM_AFTER_MS * 2);
    expect(reads()).toBe(1);
  });

  it("a diff that failed is not read again until the tab asks; one already read for this head is not read at all", async () => {
    gate.closed = false;
    getPullRequestDiff.mockImplementationOnce(() => Promise.reject(new Error("too large: 300 files")));
    renderPrPanel();
    await openPr(142);
    await wait();
    expect(reads()).toBe(1);
    await openPr(146);
    await wait();
    expect(reads()).toBe(2);
    await selectPrTab("#142");
    await settle();
    await wait(DIFF_WARM_AFTER_MS * 2);
    expect(reads()).toBe(2);
    await selectPrTab("#146");
    await settle();
    await wait(DIFF_WARM_AFTER_MS * 2);
    expect(reads()).toBe(2);
  });

  it("a read still running when the pull request leaves the screen is aborted", async () => {
    gate.closed = false;
    const signals: AbortSignal[] = [];
    getPullRequestDiff.mockImplementationOnce((_s: string, _n: number, _r: boolean, _c: unknown, signal: AbortSignal) => {
      signals.push(signal);
      return new Promise(() => undefined);
    });
    renderPrPanel();
    await openPr(142);
    await wait();
    expect(signals[0]?.aborted).toBe(false);
    await openPr(145);
    expect(signals[0]?.aborted).toBe(true);
  });
});
