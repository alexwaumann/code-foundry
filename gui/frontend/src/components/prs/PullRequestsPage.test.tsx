import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { prSummary, seedPrWorld, SLUG, VIEWER } = await import("@/test/prWorld");
const { prTabs, resetPrStores, settle } = await import("@/test/prPanelHarness");
const { SidePanel } = await import("@/components/panel/SidePanel");
const { useSidebarDashboard } = await import("@/components/sidebar/useLinkedPrs");
const { applyGhEvent, usePollStore } = await import("@/stores/gh");
const { useUiStore } = await import("@/stores/ui");
const { PullRequestsNav, PullRequestsPage } = await import("./PullRequestsPage");

/**
 * The Pull Requests page (docs/notes/prs-inbox-2-gui.md) and the sidebar's entry with its
 * needs-review count, against the mock's dashboard (src/test/prWorld.ts). A gh event is
 * applied the way the stream applies it (applyGhEvent). e2e/prs.spec.ts keeps the list
 * keeping focus while a row opens in the side panel, the charts under a real pointer, and
 * the cmd+shift+d chord and ShowView intent.
 */

let world: ReturnType<typeof seedPrWorld>;

beforeEach(() => {
  resetDaemon();
  world = seedPrWorld();
  resetPrStores({ kind: "none" });
  usePollStore.setState({ fetchedAtMs: null, lastError: "", known: false });
});

afterEach(() => {
  cleanup();
});

/** The sidebar's part (its dashboard watch and the entry), the page while it is selected, and the side panel. */
function Harness() {
  useSidebarDashboard();
  const onPage = useUiStore((s) => s.selection.kind === "view" && s.selection.name === "pullrequests");
  return (
    <>
      <PullRequestsNav />
      {onPage && <PullRequestsPage />}
      <SidePanel />
    </>
  );
}

const rows = (section: string) => [...screen.getByTestId("prs-list").querySelectorAll<HTMLElement>(`[data-nav-key^="${section}:"]`)];
const keys = (section: string) => rows(section).map((r) => r.dataset.navKey);
const textsIn = (els: HTMLElement[], testId: string) => els.flatMap((e) => [...e.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)].map((x) => x.textContent));

async function openPage() {
  render(<Harness />);
  await settle();
  fireEvent.click(screen.getByTestId("nav-pullrequests"));
  await settle();
}

/** A gh notification, as the stream applies it. */
function gh(ev: Parameters<typeof applyGhEvent>[0]) {
  act(() => {
    applyGhEvent(ev);
  });
}

describe("the Pull Requests page", () => {
  it("the sidebar entry opens it: the review queue, your pull requests, merges, then the charts", async () => {
    await openPage();
    const page = screen.getByTestId("prs-page");
    expect(screen.getByTestId("nav-pullrequests").getAttribute("aria-current")).toBe("page");
    expect(screen.getByTestId("prs-viewer").textContent).toBe("@alexwaumann");
    expect(screen.getByTestId("prs-updated").textContent).toMatch(/updated \d+s ago/);
    // Activity charts: six months newest first (16/2, 463/38, 210/17, 96/9, 0/0, 41/3).
    const merged = within(screen.getByTestId("activity-merged"));
    const commits = within(screen.getByTestId("activity-commits"));
    expect(merged.getAllByTestId("activity-month")).toHaveLength(6);
    expect(merged.getByTestId("activity-value").textContent).toBe("38");
    expect(commits.getByTestId("activity-value").textContent).toBe("463");
    expect(screen.getByTestId("activity-merged").querySelector('[data-testid="activity-marker"][data-partial]')?.getAttribute("data-value")).toBe("2");
    expect(screen.getByTestId("activity-commits").querySelector('[data-testid="activity-marker"][data-partial]')?.getAttribute("data-value")).toBe("16");
    expect(screen.queryByTestId("activity-tooltip")).toBeNull();
    // The sections in page order, the charts last; no scope toggle.
    expect([...page.querySelectorAll('section[data-testid^="prs-"], [data-testid="activity-merged"]')].map((e) => e.getAttribute("data-testid"))).toEqual(["prs-review", "prs-authored", "prs-merged", "activity-merged"]);
    expect(screen.queryByTestId("prs-scope")).toBeNull();

    // Every repository (other-org/lib is no registered project). Needs your review, newest
    // first: requested by name, a stale review, a team request.
    expect(screen.getByTestId("prs-review").querySelector("h2")?.textContent).toBe("Needs your review(3)");
    expect(keys("review")).toEqual(["review:alexwaumann/code-foundry#139", "review:alexwaumann/ghostty-playground#14", "review:other-org/lib#77"]);
    expect(textsIn(rows("review"), "prs-why")).toEqual(["Requested", "Re-review · new commits", "Requested · via team"]);
    expect(rows("review")[0]?.textContent).toContain("teammate-kim");
    // Reviewed by you: on the head, waiting on the author, with the verdict.
    expect(screen.getByTestId("prs-reviewed").textContent).toContain("Reviewed by you(2)· open, waiting on the author");
    expect(rows("reviewed")).toHaveLength(2);
    expect(textsIn(rows("reviewed"), "prs-verdict")).toEqual(["You approved", "You requested changes"]);
    expect(rows("reviewed")[0]?.textContent).toContain("#133");

    // Your open pull requests: the status pill, action needed first; comments + reviews.
    const authored = rows("authored");
    expect(authored).toHaveLength(3);
    expect(textsIn(authored, "prs-status")).toEqual(["CI failing", "Ready to merge", "Awaiting review · 1"]);
    expect(authored[0]?.textContent).toContain("#145");
    expect(authored[0]?.querySelector("[data-checks]")?.getAttribute("data-checks")).toBe("failure");
    expect(authored[1]?.textContent).toContain("virtualized sidebar tree");
    expect(textsIn([authored[1] as HTMLElement], "prs-comments")).toEqual(["3"]);

    // Merged in the last 7 days, every repository.
    expect(rows("merged")).toHaveLength(4);
  });

  it("the sidebar counts the pull requests that need review before the page opens; inbox zero shows Ember; one read per change, shared", async () => {
    render(<Harness />);
    await settle();
    const pill = () => screen.queryByTestId("nav-pullrequests-count");
    expect(pill()?.textContent).toBe("3");
    fireEvent.pointerMove(pill() as HTMLElement, { pointerType: "mouse" });
    await vi.waitFor(() => {
      expect(screen.queryByRole("tooltip")?.textContent).toBe("3 pull requests need your review");
    });
    fireEvent.click(screen.getByTestId("nav-pullrequests"));
    await settle();
    expect(rows("review")).toHaveLength(3);
    const reads = world.reads.dashboard;

    // Nothing waits on the viewer (the mock's inbox-zero): the card replaces the table, the reviewed rows stay.
    const d = world.dashboard;
    const fresh = (p: (typeof d.reviewed)[number]) => p.latestReviews.every((r) => r.author !== VIEWER || r.commitSha === p.headSha);
    world.dashboard = { ...d, reviewRequested: [], reviewed: d.reviewed.filter(fresh), fetchedAtMs: Date.now() };
    gh({ kind: "dashboard" });
    await settle();
    const zero = screen.getByTestId("prs-inbox-zero");
    expect(rows("review")).toHaveLength(0);
    expect(zero.textContent).toContain("Nothing waiting on you");
    expect(within(zero).getByTestId("ember-flame").dataset.state).toBe("idle");
    // #142 is approved and green: Ember suggests shipping it.
    expect(screen.getByTestId("prs-ember-line").textContent).toBe("The forge is quiet. #142 is approved and green, want to ship it?");
    expect(rows("reviewed")).toHaveLength(2);
    expect(screen.getByTestId("prs-review").querySelector("h2")?.textContent).toBe("Needs your review(0)");
    expect(pill()).toBeNull();
    // One read per change, shared by the page and the sidebar.
    expect(world.reads.dashboard).toBe(reads + 1);
  });

  it("Enter and click open pull requests in the side panel; cmd+Enter and cmd+click open them on GitHub; keyboard order is page order", async () => {
    await openPage();
    const list = screen.getByTestId("prs-list");
    const selected = (section: string, i: number) => rows(section).at(i)?.getAttribute("aria-selected");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selected("review", 0)).toBe("true");
    for (let i = 0; i < 3; i++) fireEvent.keyDown(list, { key: "j" });
    expect(selected("reviewed", 0)).toBe("true");
    for (let i = 0; i < 2; i++) fireEvent.keyDown(list, { key: "j" });
    expect(selected("authored", 0)).toBe("true");
    fireEvent.keyDown(list, { key: "Enter" });
    await settle();
    expect(prTabs()).toEqual(["#145"]);
    expect(screen.getByTestId("pr-title").textContent).toBe("fix(terminal): resize race between attach and first output");
    fireEvent.keyDown(list, { key: "Enter", metaKey: true });
    await settle();
    expect(invocationsOf("view.open.url").map((i) => i.args.url)).toEqual([`https://github.com/${SLUG}/pull/145`]);
    // End jumps to the last row (merged section); a click opens any row in the panel.
    fireEvent.keyDown(list, { key: "End" });
    expect(selected("merged", -1)).toBe("true");
    fireEvent.click(rows("review")[0] as HTMLElement);
    await settle();
    expect(prTabs()).toEqual(["#145", "#139"]);
    expect(selected("review", 0)).toBe("true");
    // cmd+click opens it on GitHub and adds no tab.
    fireEvent.click(rows("review")[0] as HTMLElement, { metaKey: true });
    await settle();
    expect(invocationsOf("view.open.url").map((i) => i.args.url)).toEqual([`https://github.com/${SLUG}/pull/145`, `https://github.com/${SLUG}/pull/139`]);
    expect(prTabs()).toHaveLength(2);
  });

  it("gh events refresh the page; a failed poll shows stale and the error without a re-read", async () => {
    await openPage();
    expect(rows("authored")).toHaveLength(3);
    const before = world.reads.dashboard;
    // A poll found a new pull request (the mock's gh/update): the dashboard event, then the poll's.
    const pr = prSummary(Date.now(), SLUG, 150, "feat(gui): Pull Requests page", { headRef: "phase3a", checks: { state: "pending", total: 8, passed: 3, failed: 0, pending: 5, skipped: 0 }, ageMs: 0 });
    world.dashboard = { ...world.dashboard, authored: [pr, ...world.dashboard.authored], fetchedAtMs: Date.now() };
    gh({ kind: "dashboard" });
    gh({ kind: "polled", fetchedAtMs: world.dashboard.fetchedAtMs, lastError: "" });
    await settle();
    expect(rows("authored")).toHaveLength(4);
    // #150 needs no action from its author yet: after #145 (CI failing).
    expect(rows("authored")[1]?.textContent).toContain("#150");
    expect(textsIn([rows("authored")[1] as HTMLElement], "prs-status")).toEqual(["No reviewers"]);
    expect(world.reads.dashboard).toBeGreaterThan(before);

    // A failed poll arrives as a polled event only: no re-read, the header turns red.
    const reads = world.reads.dashboard;
    gh({ kind: "polled", fetchedAtMs: Date.now() - 10 * 60_000 - 5_000, lastError: "github rate limit (secondary): paused" });
    expect(screen.getByTestId("prs-updated").dataset.freshness).toBe("error");
    expect(screen.getByTestId("prs-updated").textContent).toContain("updated 10m ago");
    // A poll that changed nothing freshens the header, still without a re-read.
    gh({ kind: "polled", fetchedAtMs: Date.now(), lastError: "" });
    expect(screen.getByTestId("prs-updated").dataset.freshness).toBe("fresh");
    expect(screen.getByTestId("prs-updated").textContent).toMatch(/updated \d+s ago/);
    await settle();
    expect(world.reads.dashboard).toBe(reads);
  });
});
