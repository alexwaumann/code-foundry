import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import { it, trackTests } from "@/test/isolate";

vi.mock("@/api/command", async (orig) => ({ ...(await orig<typeof import("@/api/command")>()), ...(await import("@/test/daemonFakes")).commandFakes }));
vi.mock("@/api/gh", async (orig) => ({ ...(await orig<typeof import("@/api/gh")>()), ...(await import("@/test/prWorld")).prGhFakes }));
vi.mock("@/api/layout", async (orig) => (await import("@/test/fakeLayout")).fakeLayoutApi(await orig()));

const { invocationsOf, resetDaemon } = await import("@/test/daemonFakes");
const { prSummary, seedPrWorld, SLUG, VIEWER } = await import("@/test/prWorld");
const { PR_PAGE, prTabs, resetPrStores, settle } = await import("@/test/prPanelHarness");
const { ShellPanes } = await import("@/test/shellPanes");
const { layoutSettled } = await import("@/test/fakeLayout");
const { useSidebarDashboard } = await import("@/components/sidebar/useLinkedPrs");
const { applyGhEvent, usePollStore } = await import("@/stores/gh");
const { useUiStore } = await import("@/stores/ui");
const { PREFETCH_DWELL_MS, resetPrefetch } = await import("@/stores/prPrefetch");
const { PullRequestsPage } = await import("./PullRequestsPage");

/**
 * The Pull Requests page (docs/notes/prs-inbox-2-gui.md, prs-page-2-gui.md), with the sidebar's
 * dashboard watch, against the mock's dashboard (src/test/prWorld.ts). A gh event is
 * applied the way the stream applies it (applyGhEvent). e2e/prs.spec.ts keeps the list
 * keeping focus while a row opens in a tab, the charts under a real pointer, and
 * the cmd+shift+d chord and ShowView intent.
 */

let world: ReturnType<typeof seedPrWorld>;

// A test that times out under load must not run on into the next (src/test/isolate.ts).
trackTests();

beforeEach(async () => {
  resetDaemon();
  world = seedPrWorld();
  await resetPrStores({ kind: "none" });
  usePollStore.setState({ fetchedAtMs: null, lastError: "", known: false, projectsFetchedAtMs: null, projectsLastError: "" });
});

afterEach(() => {
  cleanup();
});

/** The sidebar's part (its dashboard watch), the page while it is selected, and the panes (the tabs rows open). */
function Harness() {
  useSidebarDashboard();
  const onPage = useUiStore((s) => s.selection.kind === "view" && s.selection.name === "pullrequests");
  return (
    <>
      {onPage && <PullRequestsPage />}
      <ShellPanes />
    </>
  );
}

const rows = (section: string) => [...screen.getByTestId("prs-list").querySelectorAll<HTMLElement>(`[data-nav-key^="${section}:"]`)];
const keys = (section: string) => rows(section).map((r) => r.dataset.navKey);
/** A grouped section's repository labels: name and count. */
const groups = (section: string) => [...screen.getByTestId(`prs-${section}`).querySelectorAll("[data-testid=prs-group]")].map((g) => g.textContent);
const textsIn = (els: HTMLElement[], testId: string) => els.flatMap((e) => [...e.querySelectorAll<HTMLElement>(`[data-testid="${testId}"]`)].map((x) => x.textContent));

/** Selects the page (a pane's "+" or the palette opens it). */
async function openPage() {
  render(<Harness />);
  await settle();
  act(() => {
    useUiStore.getState().select(PR_PAGE);
  });
  await settle();
}

/** A gh notification, as the stream applies it. */
function gh(ev: Parameters<typeof applyGhEvent>[0]) {
  act(() => {
    applyGhEvent(ev);
  });
}

describe("warming a row's detail", () => {
  const detailReads = () => [...world.reads.detail.entries()];
  const reads = (n: number) => [[`${SLUG}#${String(n)}`, 1]];
  const row = (n: number) => rows("authored").find((r) => r.dataset.navKey === `authored:${SLUG}#${String(n)}`) as HTMLElement;
  const dwell = async () => {
    await act(async () => {
      await new Promise((r) => setTimeout(r, PREFETCH_DWELL_MS + 30));
    });
    await settle();
  };

  beforeEach(() => {
    resetPrefetch();
  });

  it("a pointer resting on a row reads its detail; one passing over it does not; the click finds it read", async () => {
    await openPage();
    fireEvent.pointerEnter(row(145));
    fireEvent.pointerLeave(row(145));
    await dwell();
    expect(detailReads()).toEqual([]);
    fireEvent.pointerEnter(row(142));
    await dwell();
    expect(detailReads()).toEqual(reads(142));
    fireEvent.click(row(142));
    await settle();
    expect(screen.getByTestId("pr-surface").dataset.seeded).toBeUndefined();
  });

  it("the keyboard's cursor warms the row it rests on, not the ones it passes", async () => {
    await openPage();
    const list = screen.getByTestId("prs-list");
    for (let i = 0; i < 3; i++) fireEvent.keyDown(list, { key: "j" });
    await dwell();
    const at = list.querySelector<HTMLElement>('[aria-selected="true"]')?.dataset.navKey ?? "";
    expect(detailReads()).toEqual([[at.slice(at.indexOf(":") + 1), 1]]);
  });

  it("a row that unmounts under the pointer reads nothing", async () => {
    await openPage();
    fireEvent.pointerEnter(row(142));
    act(() => {
      useUiStore.setState({ selection: { kind: "none" } });
    });
    await dwell();
    expect(detailReads()).toEqual([]);
  });
});

describe("before the first poll", () => {
  const empty = () => ({ ...world.dashboard, reviewRequested: [], reviewed: [], authored: [], recentlyMerged: [], projectOpen: { ...world.dashboard.projectOpen, pullRequests: [] }, projectMerged: { ...world.dashboard.projectMerged, pullRequests: [] }, viewer: null, fetchedAtMs: null, projectsFetchedAtMs: null });
  const polled = (fetchedAtMs: number | null, lastError = "") => ({ kind: "polled" as const, fetchedAtMs, lastError, projectsFetchedAtMs: fetchedAtMs, projectsLastError: "" });
  const gh = async (ev: Parameters<typeof applyGhEvent>[0]) => {
    await act(async () => {
      applyGhEvent(ev);
      await Promise.resolve();
    });
    await settle(3);
  };

  it("shows the page's shape, not a claim that nothing is open, until a poll finds the rows", async () => {
    const warm = world.dashboard;
    world.dashboard = empty();
    await openPage();
    expect(screen.getByTestId("prs-loading").getAttribute("aria-busy")).toBe("true");
    expect(screen.queryByTestId("prs-empty")).toBeNull();
    expect(screen.queryByTestId("prs-updated")).toBeNull();

    world.dashboard = warm;
    await gh({ kind: "dashboard" });
    await gh(polled(warm.fetchedAtMs));
    expect(screen.queryByTestId("prs-loading")).toBeNull();
    expect(screen.getByTestId("prs-review")).toBeTruthy();
  });

  it("a first poll that found nothing ends the wait with no dashboard event", async () => {
    world.dashboard = empty();
    await openPage();
    await gh(polled(Date.now()));
    expect(screen.queryByTestId("prs-loading")).toBeNull();
    expect(screen.getByTestId("prs-empty")).toBeTruthy();
  });

  it("a first poll that failed says why, not that nothing is open", async () => {
    world.dashboard = empty();
    await openPage();
    await gh(polled(null, "github graphql: 502 Bad Gateway"));
    expect(screen.queryByTestId("prs-loading")).toBeNull();
    expect(screen.queryByTestId("prs-empty")).toBeNull();
    expect(screen.getByRole("status").textContent).toContain("Cannot load pull requests: github graphql: 502 Bad Gateway");
  });
});

describe("the Pull Requests page", () => {
  it("charts, the five cards, then every section with rows", async () => {
    await openPage();
    const page = screen.getByTestId("prs-page");
    expect(screen.getByTestId("prs-viewer").textContent).toBe("@alexwaumann");
    expect(screen.getByTestId("prs-updated").textContent).toMatch(/updated \d+s ago/);
    // The charts on top (ActivityCharts.test.tsx has their labels), the cards, then the sections in order; no scope toggle.
    expect([...page.querySelectorAll('[data-testid="activity-merged"], [data-testid="prs-cards"], section[data-testid^="prs-"]')].map((e) => e.getAttribute("data-testid"))).toEqual([
      "activity-merged",
      "prs-cards",
      "prs-review",
      "prs-reviewed",
      "prs-authored",
      "prs-else",
      "prs-merged",
    ]);
    expect(screen.queryByTestId("prs-scope")).toBeNull();
    // The cards (their wording is pageModel.test.ts's).
    const card = (s: string) => screen.getByTestId(`prs-card-${s}`);
    expect(["review", "reviewed", "authored", "else", "merged"].map((s) => within(card(s)).getByTestId("prs-card-count").textContent)).toEqual(["3", "2", "3", "5", "7"]);
    expect(within(card("review")).getByTestId("prs-card-count").className).toContain("text-cf-warning-text");
    expect(card("merged").textContent).toBe("Merged · 7 days74 involving you · 3 more");

    // Every table has a header row, with Diff before Age (Merged); the grouped tables have no Repository column.
    const head = (s: string) => [...(screen.getByTestId(`prs-${s}`).querySelector(".text-overline")?.children ?? [])].map((h) => h.textContent);
    expect(head("review")).toEqual(["Repository", "#", "Author", "Title", "Why", "Checks", "Diff", "Age"]);
    expect(head("reviewed")).toEqual(["Repository", "#", "Author", "Title", "Your review", "Checks", "Diff", "Age"]);
    expect(head("authored")).toEqual(["Repository", "#", "Title", "Status", "Checks", "Comments", "Diff", "Age"]);
    expect(head("else")).toEqual(["#", "Author", "Title", "Status", "Checks", "Diff", "Age"]);
    expect(head("merged")).toEqual(["#", "Author", "Title", "Diff", "Merged"]);

    // Needs your review, newest first: requested by name, a stale review, a team request (other-org/lib is no project).
    expect(screen.getByTestId("prs-review").querySelector("h2")?.textContent).toBe("Needs your review(3)");
    expect(keys("review")).toEqual(["review:alexwaumann/code-foundry#139", "review:alexwaumann/ghostty-playground#14", "review:other-org/lib#77"]);
    expect(textsIn(rows("review"), "prs-why")).toEqual(["Requested", "Re-review · new commits", "Requested · via team"]);
    expect(rows("review")[0]?.textContent).toContain("teammate-kim");
    expect(textsIn(rows("review"), "prs-diff")).toEqual(["+1,390−139", "+140−14", "+770−77"]);
    // Reviewed by you: its own section now, quiet rows with the verdict.
    expect(screen.getByTestId("prs-reviewed").querySelector("h2")?.textContent).toBe("Reviewed by you(2)open, waiting on the author");
    expect(textsIn(rows("reviewed"), "prs-verdict")).toEqual(["You approved", "You requested changes"]);
    expect(rows("reviewed")[0]?.className).toContain("opacity-60");

    // Your open pull requests: the status pill, action needed first; comments + reviews.
    const authored = rows("authored");
    expect(textsIn(authored, "prs-status")).toEqual(["CI failing", "Ready to merge", "Awaiting review · 1"]);
    expect(authored[0]?.textContent).toContain("#145");
    expect(authored[0]?.querySelector("[data-checks]")?.getAttribute("data-checks")).toBe("failure");
    expect(textsIn([authored[1] as HTMLElement], "prs-comments")).toEqual(["3"]);

    // Everything else open in the projects: others' pull requests, with the author and a status, under a label per repository.
    expect(screen.getByTestId("prs-else").querySelector("h2")?.textContent).toBe("Everything else open in your projects(5)not yours, not waiting on you · updated in the last month");
    expect(keys("else").map((k) => k?.split("/")[1])).toEqual(["code-foundry#148", "code-foundry#149", "code-foundry#144", "ghostty-playground#16", "ghostty-playground#15"]);
    expect(groups("else")).toEqual(["code-foundry3", "ghostty-playground2"]);
    expect(textsIn(rows("else"), "prs-status")).toEqual(["Awaiting review · 2", "Draft", "Blocked", "Approved", "No reviewers"]);
    expect(textsIn(rows("else"), "prs-diff")[0]).toBe("+412−58");

    // Merged: the viewer's and the projects', grouped by repository (newest first), newest merge first inside; the projects' only are dimmed.
    expect(groups("merged")).toEqual(["code-foundry4", "lib1", "ghostty-playground2"]);
    expect(screen.getByTestId("prs-merged").querySelector("h2")?.textContent).toBe("Merged in the last 7 days(7)4 involving you · 3 more in your projects");
    expect(rows("merged").map((r) => [r.dataset.navKey?.split("#")[1], r.className.includes("opacity-60")])).toEqual([
      ["138", false],
      ["137", true],
      ["136", false],
      ["135", true],
      ["70", false],
      ["11", true],
      ["10", false],
    ]);
    expect(screen.queryByTestId("prs-cap")).toBeNull();
    expect(screen.queryByTestId("prs-empty")).toBeNull();
  });

  it("at inbox zero the section hides, its card says so; one read per change, shared with the sidebar's watch", async () => {
    await openPage();
    expect(rows("review")).toHaveLength(3);
    const reads = world.reads.dashboard;

    // Nothing waits on the viewer (the mock's inbox-zero): the section is gone, the card is muted and disabled.
    const d = world.dashboard;
    const fresh = (p: (typeof d.reviewed)[number]) => p.latestReviews.every((r) => r.author !== VIEWER || r.commitSha === p.headSha);
    world.dashboard = { ...d, reviewRequested: [], reviewed: d.reviewed.filter(fresh), fetchedAtMs: Date.now() };
    gh({ kind: "dashboard" });
    await settle();
    expect(screen.queryByTestId("prs-review")).toBeNull();
    const card = screen.getByTestId("prs-card-review") as HTMLButtonElement;
    expect(card.disabled).toBe(true);
    expect(card.textContent).toBe("Needs your review0nothing waiting on you");
    expect(rows("reviewed")).toHaveLength(2);
    // One read per change, shared by the page and the sidebar.
    expect(world.reads.dashboard).toBe(reads + 1);

    // Every list empty: one quiet line.
    world.dashboard = { ...world.dashboard, reviewed: [], authored: [], recentlyMerged: [], projectOpen: { ...d.projectOpen, pullRequests: [], totalCount: 0 }, projectMerged: { ...d.projectMerged, pullRequests: [], totalCount: 0 } };
    gh({ kind: "dashboard" });
    await settle();
    expect(screen.queryAllByRole("option")).toHaveLength(0);
    expect(screen.getByTestId("prs-empty").textContent).toBe("No open pull requests, and nothing merged this week.");
    expect([...screen.getByTestId("prs-cards").querySelectorAll("button")].every((b) => b.disabled)).toBe(true);
  });

  it("a card shows only its section; a second click or Escape shows them all; the keyboard follows; it clears when the section empties", async () => {
    await openPage();
    const list = screen.getByTestId("prs-list");
    const sections = () => [...screen.getByTestId("prs-page").querySelectorAll("section[data-testid^='prs-']")].map((e) => e.getAttribute("data-testid"));
    const card = (s: string) => screen.getByTestId(`prs-card-${s}`);
    fireEvent.click(card("else"));
    expect(sections()).toEqual(["prs-else"]);
    expect(card("else").getAttribute("aria-pressed")).toBe("true");
    expect(card("else").className).toContain("ring-1");
    expect(card("review").className).toContain("opacity-50");
    expect(document.activeElement).toBe(list);
    // The keyboard walks the shown rows only.
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(rows("else")[0]?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "End" });
    expect(rows("else").at(-1)?.getAttribute("aria-selected")).toBe("true");
    // A second click shows everything again.
    fireEvent.click(card("else"));
    expect(sections()).toEqual(["prs-review", "prs-reviewed", "prs-authored", "prs-else", "prs-merged"]);
    expect(card("review").className).not.toContain("opacity-50");
    // Another card, then Escape.
    fireEvent.click(card("merged"));
    expect(sections()).toEqual(["prs-merged"]);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(sections()).toHaveLength(5);
    expect(card("merged").getAttribute("aria-pressed")).toBe("false");
    // Escape on a card (outside the list) works too, and puts the keyboard back on the list.
    fireEvent.click(card("authored"));
    fireEvent.keyDown(card("authored"), { key: "Escape" });
    expect(sections()).toHaveLength(5);
    expect(document.activeElement).toBe(list);

    // An open tooltip takes the first Escape (Radix prevents its default); the second clears the filter.
    fireEvent.click(card("review"));
    const repo = rows("review")[0]?.querySelector("span") as HTMLElement;
    fireEvent.pointerMove(repo, { pointerType: "mouse" });
    await vi.waitFor(() => {
      expect(screen.queryByRole("tooltip")?.textContent).toBe(SLUG);
    });
    fireEvent.keyDown(list, { key: "Escape" });
    await vi.waitFor(() => {
      expect(screen.queryByRole("tooltip")).toBeNull();
    });
    expect(sections()).toEqual(["prs-review"]);
    fireEvent.keyDown(list, { key: "Escape" });
    expect(sections()).toHaveLength(5);

    // The filtered section empties after a poll: the filter goes, and does not come back when it refills.
    fireEvent.click(card("reviewed"));
    expect(sections()).toEqual(["prs-reviewed"]);
    const d = world.dashboard;
    world.dashboard = { ...d, reviewed: [], fetchedAtMs: Date.now() };
    gh({ kind: "dashboard" });
    await settle();
    expect(sections()).toEqual(["prs-review", "prs-authored", "prs-else", "prs-merged"]);
    expect((card("reviewed") as HTMLButtonElement).disabled).toBe(true);
    world.dashboard = d;
    gh({ kind: "dashboard" });
    await settle();
    expect(sections()).toHaveLength(5);
  });

  it("a capped project list ends with the count shown and the search on GitHub; the cards use GitHub's totals", async () => {
    const d = world.dashboard;
    world.dashboard = { ...d, projectOpen: { ...d.projectOpen, totalCount: 116 }, projectMerged: { ...d.projectMerged, pullRequests: d.projectMerged.pullRequests.slice(0, 3), totalCount: 64 } };
    await openPage();
    const cap = (s: string) => within(screen.getByTestId(`prs-${s}`)).getByTestId("prs-cap");
    expect(cap("else").textContent).toBe("Showing 5 of 116·See all on GitHub");
    // The union's rows (the viewer's 4 and #137) of the title's 65.
    expect(rows("merged")).toHaveLength(5);
    expect(cap("merged").textContent).toBe("Showing 5 of 65·See all on GitHub");
    expect(within(screen.getByTestId("prs-card-else")).getByTestId("prs-card-count").textContent).toBe("116");
    // 4 the viewer's; #137 shown, and 61 beyond the cap less #10, the viewer's own among them.
    expect(within(screen.getByTestId("prs-card-merged")).getByTestId("prs-card-count").textContent).toBe("65");
    expect(screen.getByTestId("prs-merged").querySelector("h2")?.textContent).toBe("Merged in the last 7 days(65)4 involving you · 61 more in your projects");
    fireEvent.click(within(cap("merged")).getByTestId("prs-cap-link"));
    await settle();
    expect(invocationsOf("view.open.url").map((i) => i.args.url)).toEqual([d.projectMerged.searchUrl]);
    // The footers are options of the list, after their section's rows: the keyboard reaches them; Enter opens the search.
    const list = screen.getByTestId("prs-list");
    const options = within(list).getAllByRole("option");
    expect(options.at(-1)?.dataset.navKey).toBe("cap:merged");
    expect(options[options.indexOf(rows("else").at(-1) as HTMLElement) + 1]?.dataset.navKey).toBe("cap:else");
    fireEvent.keyDown(list, { key: "End" });
    expect(options.at(-1)?.getAttribute("aria-selected")).toBe("true");
    fireEvent.keyDown(list, { key: "Enter" });
    await settle();
    expect(invocationsOf("view.open.url").map((i) => i.args.url)).toEqual([d.projectMerged.searchUrl, d.projectMerged.searchUrl]);
    // Nothing but options is interactive inside the list: the cards are outside it.
    expect(within(list).queryAllByRole("button")).toHaveLength(0);
    expect(list.contains(screen.getByTestId("prs-cards"))).toBe(false);
  });

  it("Enter and click open pull requests as tabs; cmd+Enter and cmd+click open them on GitHub; keyboard order is page order", async () => {
    await openPage();
    const list = screen.getByTestId("prs-list");
    const selected = (section: string, i: number) => rows(section).at(i)?.getAttribute("aria-selected");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    expect(selected("review", 0)).toBe("true");
    for (let i = 0; i < 3; i++) fireEvent.keyDown(list, { key: "j" });
    expect(selected("reviewed", 0)).toBe("true");
    for (let i = 0; i < 2; i++) fireEvent.keyDown(list, { key: "j" });
    expect(selected("authored", 0)).toBe("true");
    await act(async () => {
      fireEvent.keyDown(list, { key: "Enter" });
      await layoutSettled();
    });
    await settle();
    expect(prTabs()).toEqual(["#145"]);
    expect(screen.getByTestId("pr-title").textContent).toBe("fix(terminal): resize race between attach and first output");
    fireEvent.keyDown(list, { key: "Enter", metaKey: true });
    await settle();
    expect(invocationsOf("view.open.url").map((i) => i.args.url)).toEqual([`https://github.com/${SLUG}/pull/145`]);
    // End jumps to the last row (merged section); a click opens any row as a tab.
    fireEvent.keyDown(list, { key: "End" });
    expect(selected("merged", -1)).toBe("true");
    await act(async () => {
      fireEvent.click(rows("review")[0] as HTMLElement);
      await layoutSettled();
    });
    await settle();
    expect(prTabs()).toEqual(["#145", "#139"]);
    expect(selected("review", 0)).toBe("true");
    // cmd+click opens it on GitHub and adds no tab.
    await act(async () => {
      fireEvent.click(rows("review")[0] as HTMLElement, { metaKey: true });
      await layoutSettled();
    });
    await settle();
    expect(invocationsOf("view.open.url").map((i) => i.args.url)).toEqual([`https://github.com/${SLUG}/pull/145`, `https://github.com/${SLUG}/pull/139`]);
    expect(prTabs()).toHaveLength(2);
  });

  it("a click on a row shows its pull request", async () => {
    await openPage();
    await act(async () => {
      fireEvent.click(rows("authored")[0] as HTMLElement);
      await layoutSettled();
    });
    await settle();
    await act(async () => {
      fireEvent.click(rows("review")[0] as HTMLElement);
      await layoutSettled();
    });
    await settle();
    expect(prTabs()).toEqual(["#145", "#139"]);
    expect(screen.getByTestId("pr-repo").textContent).toBe(`${SLUG} #139`);
  });

  it("the header shows the older of the two fetches, and either's error", async () => {
    const now = Date.now();
    world.dashboard = { ...world.dashboard, fetchedAtMs: now - 5_000, projectsFetchedAtMs: now - 3 * 60_000 };
    await openPage();
    const updated = () => screen.getByTestId("prs-updated");
    expect(updated().textContent).toBe("updated 3m ago");
    // A poll: the dashboard fresh, the project lists' fetch older still.
    gh({ kind: "polled", fetchedAtMs: now, lastError: "", projectsFetchedAtMs: now - 7 * 60_000, projectsLastError: "" });
    expect(updated().textContent).toBe("updated 7m ago · stale");
    expect(updated().dataset.freshness).toBe("stale");
    // The project searches failed: their error shows.
    gh({ kind: "polled", fetchedAtMs: now, lastError: "", projectsFetchedAtMs: now - 60_000, projectsLastError: "search timed out" });
    expect(updated().dataset.freshness).toBe("error");
    expect(updated().textContent).toBe("updated 1m ago · last poll failed");
  });

  it("gh events refresh the page; a failed poll shows stale and the error without a re-read", async () => {
    await openPage();
    expect(rows("authored")).toHaveLength(3);
    const before = world.reads.dashboard;
    // A poll found a new pull request (the mock's gh/update): the dashboard event, then the poll's.
    const pr = prSummary(Date.now(), SLUG, 150, "feat(gui): Pull Requests page", { headRef: "phase3a", checks: { state: "pending", total: 8, passed: 3, failed: 0, pending: 5, skipped: 0 }, ageMs: 0 });
    world.dashboard = { ...world.dashboard, authored: [pr, ...world.dashboard.authored], fetchedAtMs: Date.now() };
    gh({ kind: "dashboard" });
    gh({ kind: "polled", fetchedAtMs: world.dashboard.fetchedAtMs, lastError: "", projectsFetchedAtMs: null, projectsLastError: "" });
    await settle();
    expect(rows("authored")).toHaveLength(4);
    // #150 needs no action from its author yet: after #145 (CI failing).
    expect(rows("authored")[1]?.textContent).toContain("#150");
    expect(textsIn([rows("authored")[1] as HTMLElement], "prs-status")).toEqual(["No reviewers"]);
    expect(world.reads.dashboard).toBeGreaterThan(before);

    // A failed poll arrives as a polled event only: no re-read, the header turns red.
    const reads = world.reads.dashboard;
    gh({ kind: "polled", fetchedAtMs: Date.now() - 10 * 60_000 - 5_000, lastError: "github rate limit (secondary): paused", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(screen.getByTestId("prs-updated").dataset.freshness).toBe("error");
    expect(screen.getByTestId("prs-updated").textContent).toContain("updated 10m ago");
    // A poll that changed nothing freshens the header, still without a re-read.
    gh({ kind: "polled", fetchedAtMs: Date.now(), lastError: "", projectsFetchedAtMs: null, projectsLastError: "" });
    expect(screen.getByTestId("prs-updated").dataset.freshness).toBe("fresh");
    expect(screen.getByTestId("prs-updated").textContent).toMatch(/updated \d+s ago/);
    await settle();
    expect(world.reads.dashboard).toBe(reads);
  });
});
