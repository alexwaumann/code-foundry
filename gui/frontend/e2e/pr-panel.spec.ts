import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, mockPost, openApp, resetMock, row } from "./fixtures";

/**
 * The Pull request surface in the side panel, against the mock daemon's fixtures
 * (mock/prDetail.ts): #145 open with failing checks, threads, labels and reviewers;
 * #138 merged and revertable; #131 closed; #140 read-only. Set SHOTS=<dir> to save
 * screenshots.
 */

const CFW = `${CF}.worktrees`;
const SLUG = "alexwaumann/code-foundry";
const shots = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

/** Screenshots are taken at 1400x900. */
async function shotViewport(page: Page): Promise<void> {
  if (shots) await page.setViewportSize({ width: 1400, height: 900 });
}

test.beforeEach(async ({ page }) => {
  await resetMock();
  // Record copies: the async Clipboard API needs a permission (Chromium) or a gesture (WebKit).
  await page.addInitScript(() => {
    const w = window as unknown as { __copied: string[] };
    w.__copied = [];
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: (t: string) => {
          w.__copied.push(t);
          return Promise.resolve();
        },
      },
    });
  });
});

const panel = (page: Page) => page.getByTestId("side-panel");
const tabs = (page: Page) => page.getByTestId("panel-tabs").getByRole("tab");
const prRow = (page: Page, section: string, number: number) => page.getByTestId(`prs-${section}`).locator("[data-nav-key]").filter({ hasText: `#${String(number)}` });

async function openPrPage(page: Page): Promise<void> {
  await openApp(page);
  await page.getByTestId("nav-pullrequests").click();
  await expect(page.getByTestId("prs-list")).toBeFocused();
}

/** Opens a pull request in the current selection's panel through the app's own store (for PRs on no dashboard). */
async function openPr(page: Page, number: number): Promise<void> {
  await page.evaluate(`import("/src/stores/prPanel.ts").then((m) => m.openPullRequestInPanel({ slug: "${SLUG}", number: ${String(number)} }))`);
}

/** Sets the side panel's width through the app's own ui store, and waits for it. */
async function setPanelWidth(page: Page, width: number): Promise<void> {
  await page.evaluate(`import("/src/stores/ui.ts").then((m) => m.useUiStore.getState().setPanelWidth(${String(width)}))`);
  await expect.poll(async () => (await panel(page).boundingBox())?.width).toBe(width);
}

/** How far an element's content overflows it horizontally (0 or less: it fits). */
function overflowX(page: Page, testId: string): Promise<number> {
  return page.getByTestId(testId).evaluate((el) => el.scrollWidth - el.clientWidth);
}

async function boxOf(page: Page, testId: string): Promise<{ x: number; y: number; width: number; height: number }> {
  const b = await page.getByTestId(testId).boundingBox();
  if (!b) throw new Error(`${testId} has no box`);
  return b;
}

/** Whether `inner` lies horizontally inside `outer` (1px slack for rounding). */
function inside(inner: { x: number; width: number }, outer: { x: number; width: number }): boolean {
  return inner.x >= outer.x - 1 && inner.x + inner.width <= outer.x + outer.width + 1;
}

function copied(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { __copied: string[] }).__copied);
}

test("a row on the Pull Requests page opens #145: header, labels, reviewers, failing checks", async ({ page }) => {
  await openPrPage(page);
  await expect(panel(page)).toHaveCount(0);
  await prRow(page, "authored", 145).click();
  await expect(tabs(page)).toHaveText(["#145"]);
  const s = page.getByTestId("pr-surface");
  await expect(s).toBeVisible();
  await expect(page.getByTestId("pr-repo-link")).toHaveText(`${SLUG}#145`);
  await expect(page.getByTestId("pr-title")).toHaveText("fix(terminal): resize race between attach and first output");
  await expect(page.getByTestId("pr-author")).toHaveText("alexwaumann");
  await expect(page.getByTestId("pr-updated")).toHaveText("updated 5h ago");
  await expect(page.getByTestId("pr-branches")).toHaveText(/main\s*fix\/resize/);
  await expect(page.getByTestId("pr-diffstat")).toContainText("3 files");
  await expect(page.getByTestId("pr-diffstat")).toContainText("+1,450");
  await expect(page.getByTestId("pr-state")).toHaveText("Draft");
  await expect(page.getByTestId("pr-checks-summary")).toHaveText("2 failing");
  await expect(page.getByTestId("pr-checks-summary")).toHaveAttribute("data-tone", "failure");

  await expect(page.getByTestId("pr-label")).toHaveText(["bug", "terminal"]);
  const reviewers = page.getByTestId("pr-reviewer");
  await expect(reviewers).toHaveCount(4);
  await expect(reviewers.first()).toHaveAttribute("data-login", "teammate-kim");
  await expect(reviewers.first()).toHaveAttribute("data-status", "changes_requested");
  await expect(reviewers.first()).toHaveAttribute("data-stale", "true");
  await expect(page.getByTestId("pr-reviewers")).toContainText("and more on GitHub");

  // Description renders markdown (a heading and a task list).
  await expect(page.getByTestId("pr-description").getByRole("heading", { name: "Test plan" })).toBeVisible();
  await expect(page.getByTestId("pr-description").locator('input[type="checkbox"]')).toHaveCount(2);

  // Every check, failed first, with their status.
  const checks = page.getByTestId("pr-check");
  await expect(checks).toHaveCount(7);
  await expect(checks.nth(0)).toContainText("test (macos-15)");
  await expect(checks.nth(0)).toHaveAttribute("data-tone", "failure");
  await expect(checks.nth(1)).toHaveAttribute("data-tone", "failure");
  await expect(checks.filter({ hasText: "e2e (chromium)" })).toHaveAttribute("data-tone", "pending");
  await expect(checks.filter({ hasText: "release-notes" })).toHaveAttribute("data-tone", "skipped");
  // A check opens its log through view.open.url.
  await checks.nth(0).click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").at(-1)?.args.url).toBe("https://github.com/alexwaumann/code-foundry/actions/runs/1/job/11");

  // Comments: newest first; threads grouped with their location and badges.
  await expect(page.getByTestId("pr-comments")).toContainText("Comments(9)");
  const threads = page.getByTestId("pr-thread");
  await expect(threads).toHaveCount(3);
  await expect(page.getByTestId("pr-thread-location").first()).toHaveText("internal/store/terminal/actor.go:214");
  await expect(threads.filter({ hasText: "terminal.go:40" })).toHaveAttribute("data-outdated", "true");
  await expect(threads.filter({ hasText: "terminal.go:40" })).toContainText("Resolved");
  const first = page.getByTestId("pr-comments-list").locator(":scope > *").first();
  await expect(first).toContainText("requested changes");
  await page.getByTestId("pr-comment-order").click();
  await expect(page.getByTestId("pr-comment-order")).toHaveText("Oldest first");
  // Oldest first: the outdated thread from 8 hours ago, then the bot's review.
  await expect(page.getByTestId("pr-comments-list").locator(":scope > *").first()).toContainText("Why remove the size check?");
  await expect(page.getByTestId("pr-comments-list").locator(":scope > *").nth(1)).toContainText("Walkthrough");
  await page.getByTestId("pr-comment-order").click();
  await shot(page, "chunk3-summary");

  // The header link opens the pull request on GitHub.
  await page.getByTestId("pr-repo-link").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").at(-1)?.args.url).toBe(`https://github.com/${SLUG}/pull/145`);
});

test("Timeline lists the end state, commits, comments and reviews; inner tabs stay per panel tab", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await page.getByTestId("pr-tab-timeline").click();
  const entries = page.getByTestId("pr-timeline-entry");
  // 4 commits, 3 issue comments, 2 reviews, opened.
  await expect(entries).toHaveCount(10);
  await expect(entries.first()).toHaveAttribute("data-kind", "commit");
  await expect(entries.first()).toContainText("fix(terminal): replay resize after snapshot");
  await expect(entries.first()).toContainText("8d4b3f6");
  await expect(entries.nth(1)).toHaveAttribute("data-kind", "review");
  await expect(entries.nth(1)).toContainText("teammate-kim");
  await expect(entries.nth(1)).toContainText("requested changes");
  await expect(entries.last()).toHaveAttribute("data-kind", "opened");
  // The bar counts timeline entries (not the header's comments, which include thread replies) and commits.
  await expect(page.getByTestId("pr-timeline-counts")).toHaveText(/10 entries\s*·\s*4/);
  // At the default 420px width the counts and the order toggle (its icon) sit side by
  // side: the counts' text fits their box, and that box ends before the toggle.
  expect(await overflowX(page, "pr-timeline-counts")).toBeLessThanOrEqual(0);
  const counts = await boxOf(page, "pr-timeline-counts");
  expect(counts.x + counts.width).toBeLessThanOrEqual((await boxOf(page, "pr-timeline-order")).x);
  // The rail stops at the last entry's icon.
  const lastBox = await entries.last().boundingBox();
  const railBox = await entries.last().getByTestId("pr-timeline-rail").boundingBox();
  expect(railBox && lastBox && railBox.y + railBox.height).toBeLessThanOrEqual((lastBox?.y ?? 0) + 25);
  await shot(page, "chunk3-timeline");
  await page.getByTestId("pr-timeline-order").click();
  await expect(entries.first()).toHaveAttribute("data-kind", "opened");
  // A commit opens on GitHub.
  await entries.filter({ hasText: "8d4b3f6" }).click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").at(-1)?.args.url).toMatch(/\/commit\/8d4b3f6/);

  // Another tab starts on Summary; coming back finds Timeline still selected.
  await prRow(page, "merged", 138).click();
  await expect(tabs(page)).toHaveText(["#145", "#138"]);
  await expect(page.getByTestId("pr-tab-summary")).toHaveAttribute("aria-selected", "true");
  // Merged: the timeline starts with the merge.
  await page.getByTestId("pr-tab-timeline").click();
  await expect(entries.first()).toHaveAttribute("data-kind", "merged");
  await page.getByTestId("pr-tab-summary").click();
  await tabs(page).first().click();
  await expect(page.getByTestId("pr-tab-timeline")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("pr-timeline")).toHaveAttribute("data-order", "oldest");
  await expect(page.getByTestId("pr-tab-code")).toBeDisabled();
});

test("the reviewer picker lists people with access and toggles requests through pr.review.request", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await page.getByTestId("pr-add-reviewer").click();
  const picker = page.getByTestId("pr-reviewer-picker");
  await expect(picker).toBeVisible();
  await expect(page.getByTestId("pr-reviewer-search")).toBeFocused();
  await expect(page.getByTestId("pr-reviewer-search")).toHaveAttribute("placeholder", "Search people with access");
  const cands = page.getByTestId("pr-reviewer-candidate");
  // Requested first (with a check), then by login.
  await expect(cands).toHaveCount(5);
  await expect(cands.evaluateAll((els) => els.map((e) => [e.getAttribute("data-login"), e.getAttribute("data-requested")]))).resolves.toEqual([
    ["acme/core", "true"],
    ["teammate-ana", "true"],
    ["teammate-kim", "true"],
    ["teammate-lee", "false"],
    ["teammate-max", "false"],
  ]);
  await shot(page, "chunk3-reviewers");

  // Typing filters; choosing someone requests a review.
  await page.getByTestId("pr-reviewer-search").fill("lee");
  await expect(cands).toHaveCount(1);
  await cands.first().click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "pr.review.request").map((i) => i.args)).toEqual([
    { "repo-slug": SLUG, number: "145", login: "teammate-lee", kind: "user", requested: "true" },
  ]);
  // The candidates and the detail are read again.
  await expect(cands.filter({ hasText: "teammate-lee" })).toHaveAttribute("data-requested", "true");
  await expect(page.getByTestId("pr-reviewer").filter({ hasText: "teammate-lee" })).toHaveAttribute("data-status", "requested");

  // Choosing a requested team withdraws it.
  await page.getByTestId("pr-reviewer-search").fill("");
  await cands.filter({ hasText: "acme/core" }).click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "pr.review.request").at(-1)?.args).toEqual({
    "repo-slug": SLUG,
    number: "145",
    login: "acme/core",
    kind: "team",
    requested: "false",
  });
  await expect(page.getByTestId("pr-reviewer").filter({ hasText: "acme/core" })).toHaveCount(0);

  // Escape closes the picker; the panel keeps its tab.
  await page.keyboard.press("Escape");
  await expect(picker).toHaveCount(0);
  await expect(tabs(page)).toHaveText(["#145"]);
});

test("menu: Refresh, the session actions, Open on GitHub, Copy link; shift+cmd+c copies too", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await page.getByTestId("pr-menu-button").click();
  const menu = page.getByTestId("pr-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([/^Refresh/, /^Ask a question/, /^Explain this PR/, /^Fix findings in a thread/, /^Open on GitHub/, /^Copy link⇧⌘C$/]);
  for (const id of ["pr-menu-ask", "pr-menu-explain", "pr-menu-fix"]) {
    await expect(page.getByTestId(id)).not.toHaveAttribute("data-disabled");
    await expect(page.getByTestId(id)).not.toHaveAttribute("title");
  }
  await expect(page.getByTestId("pr-menu-ask")).toContainText("Starts a thread that knows which pull request you mean.");
  await expect(page.getByTestId("pr-menu-explain")).toContainText("A walk through the diff and what to read closely.");
  // No revert for an open pull request.
  await expect(page.getByTestId("pr-menu-revert")).toHaveCount(0);
  await expect(page.getByTestId("pr-menu-refresh-hint")).toHaveText(/^Updated \d+s ago$/);

  // Refresh runs pr.refresh and stays open with the new time.
  await page.getByTestId("pr-menu-refresh").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "pr.refresh").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145" }]);
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("pr-menu-refresh-hint")).toHaveText(/^Updated [0-5]s ago$/);
  // Quiet: the menu reports it, no toast.
  await expect(page.getByText(/^Refreshed #145/)).toHaveCount(0);

  await page.getByTestId("pr-menu-copy").click();
  await expect(menu).toHaveCount(0);
  await expect.poll(() => copied(page)).toEqual([`https://github.com/${SLUG}/pull/145`]);
  await expect(page.getByText("Link copied")).toBeVisible();

  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-open").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").at(-1)?.args.url).toBe(`https://github.com/${SLUG}/pull/145`);

  // The chord works while the panel has focus.
  await page.getByTestId("pr-title").click();
  await page.keyboard.press("Meta+Shift+c");
  await expect.poll(() => copied(page)).toHaveLength(2);
});

test("#138 (merged) offers Revert: it confirms, runs pr.revert and opens the new pull request as a tab", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "merged", 138).click();
  await expect(page.getByTestId("pr-state")).toHaveText("Merged");
  await expect(page.getByTestId("pr-checks-summary")).toHaveText("All checks passed");
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu-revert")).toBeVisible();
  await shot(page, "chunk3-menu");
  await page.getByTestId("pr-menu-revert").click();
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText("This opens a new pull request that reverses the changes merged by #138.");
  await page.getByTestId("confirm-ok").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "pr.revert").map((i) => [i.args.number, Boolean(i.confirmed)])).toEqual([
    ["138", false],
    ["138", true],
  ]);
  await expect(tabs(page)).toHaveText(["#138", "#151"]);
  await expect(page.getByTestId("pr-title")).toHaveText('Revert "chore(gh): pace requests through one worker"');
  await expect(page.getByText("Opened #151 to revert #138")).toBeVisible();
});

test("declining the revert's confirmation sends nothing", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "merged", 138).click();
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-revert").click();
  await page.getByTestId("confirm-cancel").click();
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  expect((await invocations()).filter((i) => i.name === "pr.revert" && i.confirmed)).toEqual([]);
  await expect(tabs(page)).toHaveText(["#138"]);
});

test("#140 (read access) explains the picker and has no revert; #131 is closed; unknown numbers say not found", async ({ page }) => {
  await openPrPage(page);
  await openPr(page, 140);
  await expect(tabs(page)).toHaveText(["#140"]);
  await expect(page.getByTestId("pr-author")).toHaveText("outside-contrib");
  await page.getByTestId("pr-add-reviewer").click();
  await expect(page.getByTestId("pr-reviewer-readonly")).toHaveText("Asking someone to review needs write access on this repository.");
  await expect(page.getByTestId("pr-reviewer-candidate")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-reviewer-picker")).toHaveCount(0);

  await openPr(page, 131);
  await expect(page.getByTestId("pr-state")).toHaveText("Closed");
  await expect(page.getByTestId("pr-labels")).toContainText("None");
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu-open")).toBeVisible();
  await expect(page.getByTestId("pr-menu-revert")).toHaveCount(0);
  await page.keyboard.press("Escape");
  await page.getByTestId("pr-tab-timeline").click();
  await expect(page.getByTestId("pr-timeline-entry").first()).toHaveAttribute("data-kind", "closed");

  await openPr(page, 9999);
  await expect(page.getByTestId("pr-not-found")).toContainText("Pull request not found");
});

test("closing the last tab hides the panel; cmd+w closes the active one", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await prRow(page, "authored", 142).click();
  await expect(tabs(page)).toHaveText(["#145", "#142"]);
  await page.getByTestId("pr-title").click();
  await page.keyboard.press("Meta+w");
  await expect(tabs(page)).toHaveText(["#145"]);
  await page.getByRole("button", { name: "Close #145" }).click();
  await expect(panel(page)).toHaveCount(0);
});

test("panel state is per selection; a session or worktree on a PR branch enables the surface", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 142).click();
  await expect(tabs(page)).toHaveText(["#142"]);

  // A session on main: its panel is its own, and main has no pull request.
  await row(page, "s:s-1").click();
  await expect(panel(page)).toHaveCount(0);
  await page.keyboard.press("Meta+Shift+e");
  await expect(page.getByTestId("panel-empty")).toBeVisible();
  await expect(page.locator('[data-surface="pullrequest"]')).toHaveAttribute("data-availability", "disabled");

  // A session on fix/resize: the surface is enabled once its branch PRs load; P opens #145.
  await row(page, "s:s-3").click();
  await page.getByTestId("panel-toggle").first().click();
  const pr = page.locator('[data-surface="pullrequest"][data-availability]');
  await expect(pr).toHaveAttribute("data-availability", "enabled");
  await panel(page).focus();
  await page.keyboard.press("p");
  await expect(tabs(page)).toHaveText(["#145"]);
  await expect(page.getByTestId("pr-title")).toContainText("resize race");

  // The worktree overview: its branch PR row opens in that selection's panel.
  await row(page, `w:repo-cf::${CFW}/feat-sidebar`).click();
  await expect(page.getByTestId("overview-page")).toBeVisible();
  await page.locator('[data-nav-key="b:142"]').click();
  await expect(tabs(page)).toHaveText(["#142"]);
  await expect(page.getByTestId("pr-title")).toContainText("virtualized sidebar tree");

  // Back on the Pull Requests page, its panel is as it was.
  await page.getByTestId("nav-pullrequests").click();
  await expect(tabs(page)).toHaveText(["#142"]);
  await expect(page.getByTestId("pr-tab-summary")).toHaveAttribute("aria-selected", "true");
});

test("light scheme", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await expect(page.getByTestId("pr-checks-summary")).toHaveText("2 failing");
  await shot(page, "chunk3-light-summary");
});

test("a failed Refresh is reported, and the copy stays", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await expect(page.getByTestId("pr-title")).toContainText("resize race");
  await mockPost("gh/pr-fail?command=pr.refresh");
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-refresh").click();
  await expect(page.getByText("Refresh Pull Request failed")).toBeVisible();
  await expect(page.getByTestId("pr-refresh-error")).toContainText("502 Bad Gateway");
  await expect(page.getByTestId("pr-menu-refresh-hint")).toHaveText(/^Updated \d+s ago$/);
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-title")).toContainText("resize race");
  await expect(page.getByTestId("pr-check")).toHaveCount(7);
});

test("closing a tab drops its inner state: reopened, it starts on Summary", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await page.getByTestId("pr-tab-timeline").click();
  await page.getByTestId("pr-timeline-order").click();
  await expect(page.getByTestId("pr-timeline")).toHaveAttribute("data-order", "oldest");
  await page.getByRole("button", { name: "Close #145" }).click();
  await expect(panel(page)).toHaveCount(0);
  await prRow(page, "authored", 145).click();
  await expect(page.getByTestId("pr-tab-summary")).toHaveAttribute("aria-selected", "true");
  await page.getByTestId("pr-tab-timeline").click();
  await expect(page.getByTestId("pr-timeline")).toHaveAttribute("data-order", "newest");
});

test("at 280px nothing overflows: header, inner tab bar, logins, popups; the active tab is revealed", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await setPanelWidth(page, 280);
  await expect(page.getByTestId("pr-surface")).toBeVisible();

  // Summary: the headline keeps its icon and number inside the bar.
  expect(await overflowX(page, "pr-header")).toBeLessThanOrEqual(0);
  expect(await overflowX(page, "pr-inner-bar")).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("pr-checks-summary")).toHaveText("2 failing");
  expect(inside(await boxOf(page, "pr-checks-summary"), await boxOf(page, "pr-inner-bar"))).toBe(true);
  // The repo link has its own row; the diffstat wraps under the branches.
  expect(inside(await boxOf(page, "pr-diffstat"), await boxOf(page, "pr-header"))).toBe(true);
  expect(inside(await boxOf(page, "pr-reviewers"), await boxOf(page, "side-panel"))).toBe(true);
  // Comment authors are not cut before their verdict.
  const cutComments = await page.getByTestId("pr-comment-author").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(cutComments).toEqual([]);

  // Timeline: the counts give way; the order toggle stays reachable.
  await page.getByTestId("pr-tab-timeline").click();
  expect(await overflowX(page, "pr-inner-bar")).toBeLessThanOrEqual(0);
  await expect(page.getByTestId("pr-timeline-counts")).toBeHidden();
  expect(inside(await boxOf(page, "pr-timeline-order"), await boxOf(page, "pr-inner-bar"))).toBe(true);
  const cut = await page.getByTestId("pr-timeline-author").evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth).map((e) => e.textContent));
  expect(cut).toEqual([]);
  await page.getByTestId("pr-timeline-order").click();
  await expect(page.getByTestId("pr-timeline")).toHaveAttribute("data-order", "oldest");

  // Popups stay inside the panel.
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  expect(inside(await boxOf(page, "pr-menu"), await boxOf(page, "side-panel"))).toBe(true);
  await page.keyboard.press("Escape");
  await page.getByTestId("pr-tab-summary").click();
  await page.getByTestId("pr-add-reviewer").click();
  await expect(page.getByTestId("pr-reviewer-picker")).toBeVisible();
  expect(inside(await boxOf(page, "pr-reviewer-picker"), await boxOf(page, "side-panel"))).toBe(true);
  await page.keyboard.press("Escape");

  // Many tabs: each new one scrolls into view in the strip.
  for (const [section, n] of [["authored", 142], ["authored", 12], ["review", 139], ["merged", 138], ["merged", 136], ["merged", 10]] as const) {
    await prRow(page, section, n).click();
    await expect(tabs(page).last()).toHaveAttribute("aria-selected", "true");
    const strip = await boxOf(page, "panel-tabs");
    const active = await page.getByTestId("panel-tabs").locator(`[data-tab-id]:has([aria-selected="true"])`).boundingBox();
    expect(active && inside(active, strip)).toBe(true);
  }
  expect(await page.getByTestId("panel-tabs").evaluate((el) => el.scrollWidth > el.clientWidth)).toBe(true);
});

test("long conversations and timelines are virtualized in the panel's scroll", async ({ page }) => {
  for (let i = 1; i <= 45; i++) await mockPost(`gh/pr-comment?number=145&body=${encodeURIComponent(`Note ${String(i)}`)}`);
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  const list = page.getByTestId("pr-comments-list");
  await expect(list).toHaveAttribute("data-virtual", "true");
  await expect(page.getByTestId("pr-comments")).toContainText("Comments(54)");
  expect(await page.getByTestId("pr-comment").count()).toBeLessThan(50);
  // Scrolled to the end, the oldest item (the outdated thread) is mounted and visible.
  const body = page.getByTestId("panel-body");
  await expect
    .poll(async () => {
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      return page.getByText("Why remove the size check?").isVisible();
    })
    .toBe(true);

  await body.evaluate((el) => {
    el.scrollTop = 0;
  });
  await page.getByTestId("pr-tab-timeline").click();
  await expect(page.getByTestId("pr-timeline-list")).toHaveAttribute("data-virtual", "true");
  await expect
    .poll(async () => {
      await body.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
      });
      return page.locator('[data-testid="pr-timeline-entry"][data-kind="opened"]').isVisible();
    })
    .toBe(true);
});

// ---- Sessions about a pull request (pr.ask, pr.explain, pr.fix.findings) ----

const selectedSession = (page: Page) => page.locator('[data-row-kind="session"][aria-selected="true"]');

async function sessionInvocations(name: string): Promise<{ args: Record<string, string>; worktree: string | undefined }[]> {
  return (await invocations()).filter((i) => i.name === name).map((i) => ({ args: i.args, worktree: i.context?.activeWorktreePath }));
}

test("Explain this PR runs pr.explain, selects the new session, and the PR tab stays on the Pull Requests page", async ({ page }) => {
  await shotViewport(page);
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await mockPost("gh/pr-delay?ms=600");
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  // Let the menu's fade-in finish before the screenshot.
  await page.getByTestId("pr-menu").evaluate((el) => Promise.all(el.getAnimations({ subtree: true }).map((a) => a.finished)));
  await shot(page, "chunk4-menu");

  await page.getByTestId("pr-menu-explain").click();
  // The menu stays open with a spinner until the session has started.
  await expect(page.getByTestId("pr-menu-explain")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  // No worktree, model or effort args: the daemon picks them.
  await expect.poll(() => sessionInvocations("pr.explain")).toEqual([{ args: { "repo-slug": SLUG, number: "145" }, worktree: "" }]);
  // The daemon's FocusSession selects the new session; its own panel is untouched.
  await expect(selectedSession(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  await expect(page.getByText(/^Started session s-new-\d+ for PR #145$/)).toBeVisible();
  await expect(panel(page)).toHaveCount(0);
  await expect(page.getByText("Preparing worktree for #145…")).toHaveCount(0);

  // Back on the Pull Requests page, its panel still shows #145 (menu closed).
  await page.getByTestId("nav-pullrequests").click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await expect(page.getByTestId("pr-title")).toContainText("resize race");
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
});

test("Ask a question: a composer under the header; Escape cancels, Enter sends pr.ask with the question", async ({ page }) => {
  await shotViewport(page);
  // From a session on main: ask uses its worktree through the context, not a worktree arg.
  await openApp(page);
  await row(page, "s:s-1").click();
  await openPr(page, 145);
  await expect(tabs(page)).toHaveText(["#145"]);

  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-ask").click();
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
  const input = page.getByTestId("pr-ask-input");
  await expect(input).toBeFocused();
  await expect(input).toHaveAttribute("placeholder", "Ask about this pull request…");
  await input.pressSequentially("never mind");
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-ask")).toHaveCount(0);
  // Escape stays in the composer (the panel keeps its tab, the panel has focus).
  await expect(tabs(page)).toHaveText(["#145"]);
  await expect.poll(() => page.evaluate(() => document.activeElement?.closest("[data-region]")?.getAttribute("data-region"))).toBe("panel");

  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-ask").click();
  await expect(input).toBeFocused();
  await expect(input).toHaveValue(""); // a fresh composer
  await input.pressSequentially("Why does attach race the first output?");
  await page.keyboard.press("Shift+Enter");
  await input.pressSequentially("And is the fix covered by a test?");
  await expect(input).toHaveValue("Why does attach race the first output?\nAnd is the fix covered by a test?");
  expect(await sessionInvocations("pr.ask")).toEqual([]);
  await shot(page, "chunk4-ask");
  await page.keyboard.press("Enter");

  await expect
    .poll(() => sessionInvocations("pr.ask"))
    .toEqual([{ args: { "repo-slug": SLUG, number: "145", question: "Why does attach race the first output?\nAnd is the fix covered by a test?" }, worktree: CF }]);
  await expect(selectedSession(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  await expect(panel(page)).toHaveCount(0);

  // The originating session's panel keeps #145; the composer is gone.
  await row(page, "s:s-1").click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await expect(page.getByTestId("pr-ask")).toHaveCount(0);
});

test("Fix findings: a failure toasts the daemon's hint; a retry prepares the worktree and selects the session", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await mockPost("gh/pr-fail?command=pr.fix.findings");
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-fix").click();
  await expect(page.getByText("Fix Pull Request Findings failed")).toBeVisible();
  await expect(page.getByText(/gh pr checkout 145/)).toBeVisible();
  // A quick answer leaves no "Preparing" toast behind.
  await expect(page.getByText("Preparing worktree for #145…")).toHaveCount(0);
  // Nothing was selected; the menu stays open for a retry.
  await expect(selectedSession(page)).toHaveCount(0);
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  await expect(page.getByTestId("pr-menu-fix")).not.toHaveAttribute("aria-busy");

  await mockPost("gh/pr-delay?ms=800");
  await page.getByTestId("pr-menu-fix").click();
  await expect(page.getByTestId("pr-menu-fix")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByText("Preparing worktree for #145…")).toBeVisible();
  await expect(selectedSession(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  await expect(page.getByText("Preparing worktree for #145…")).toHaveCount(0);
  expect(await sessionInvocations("pr.fix.findings")).toEqual([
    { args: { "repo-slug": SLUG, number: "145" }, worktree: "" },
    { args: { "repo-slug": SLUG, number: "145" }, worktree: "" },
  ]);
  await page.getByTestId("nav-pullrequests").click();
  await expect(tabs(page)).toHaveText(["#145"]);
});

const askInput = (page: Page) => page.getByTestId("pr-ask-input");

async function openAsk(page: Page): Promise<void> {
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-ask").click();
  await expect(askInput(page)).toBeFocused();
}

test("Ask from the Pull Requests page sends no worktree; while it starts, Cancel is disabled and Escape does nothing", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await mockPost("gh/pr-delay?ms=800");
  await openAsk(page);
  await expect(page.getByTestId("pr-ask-hint")).toHaveText("⏎ send · ⇧⏎ newline");
  await askInput(page).pressSequentially("What changed?");
  await page.keyboard.press("Enter");

  await expect(page.getByTestId("pr-ask-hint")).toHaveText("Starting a session…");
  await expect(page.getByTestId("pr-ask-send")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("pr-ask-cancel")).toBeDisabled();
  await expect(askInput(page)).toHaveJSProperty("readOnly", true);
  // Escape neither closes the composer nor reaches the panel: the session starts anyway.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-ask")).toBeVisible();
  await expect(tabs(page)).toHaveText(["#145"]);

  await expect(selectedSession(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  // From the Pull Requests page there is no active worktree: the daemon picks one.
  expect(await sessionInvocations("pr.ask")).toEqual([{ args: { "repo-slug": SLUG, number: "145", question: "What changed?" }, worktree: "" }]);
  await page.getByTestId("nav-pullrequests").click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await expect(page.getByTestId("pr-ask")).toHaveCount(0);
});

test("a failed pr.ask is toasted and keeps the question for a retry", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await mockPost("gh/pr-fail?command=pr.ask");
  await openAsk(page);
  await askInput(page).pressSequentially("Is the retry bounded?");
  await page.keyboard.press("Enter");

  await expect(page.getByText("Ask About Pull Request failed")).toBeVisible();
  await expect(page.getByText("read #145: github graphql: 502 Bad Gateway")).toBeVisible();
  await expect(selectedSession(page)).toHaveCount(0);
  await expect(page.getByTestId("pr-ask")).toBeVisible();
  await expect(askInput(page)).toHaveValue("Is the retry bounded?");
  await expect(askInput(page)).toHaveJSProperty("readOnly", false);
  await expect(page.getByTestId("pr-ask-hint")).toHaveText("⏎ send · ⇧⏎ newline");
  await expect(page.getByTestId("pr-ask-cancel")).toBeEnabled();

  // The retry goes through.
  await page.getByTestId("pr-ask-send").click();
  await expect(selectedSession(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  expect((await sessionInvocations("pr.ask")).map((i) => i.args.question)).toEqual(["Is the retry bounded?", "Is the retry bounded?"]);
});

test("choosing Ask again with the composer open focuses it; the menu reopened right after Ask stays open", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await openAsk(page);
  await askInput(page).pressSequentially("draft");
  // Focus leaves the composer.
  await page.getByTestId("pr-title").click();
  await expect(askInput(page)).not.toBeFocused();

  await openAsk(page);
  await expect(askInput(page)).toHaveValue("draft");
  // And it stays there once the menu's close has run.
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
  await expect(askInput(page)).toBeFocused();

  // Reopened while the menu is still fading out from choosing Ask: it stays open.
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-ask").click();
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  await page.waitForTimeout(500);
  await expect(page.getByTestId("pr-menu")).toBeVisible();
  await expect(page.getByTestId("pr-menu")).toHaveAttribute("data-state", "open");
  // A later close returns focus to the menu button, as usual.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
  await expect(page.getByTestId("pr-menu-button")).toBeFocused();
  await expect(askInput(page)).toHaveValue("draft");
  // The ⋯ button still closes an open menu.
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toHaveAttribute("data-state", "open");
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu")).toHaveCount(0);
});

test("a pull request's running sessions show on every surface that shows it", async ({ page }) => {
  // Ask from session s-1's panel, then look at #145 on the Pull Requests page meanwhile.
  await openApp(page);
  await row(page, "s:s-1").click();
  await openPr(page, 145);
  await mockPost("gh/pr-delay?ms=2000");
  await openAsk(page);
  await askInput(page).pressSequentially("From s-1");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pr-ask-send")).toHaveAttribute("aria-busy", "true");

  await page.getByTestId("nav-pullrequests").click();
  await prRow(page, "authored", 145).click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await openAsk(page);
  await expect(page.getByTestId("pr-ask-hint")).toHaveText("Already starting a thread for this pull request");
  await expect(page.getByTestId("pr-ask-send")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("pr-ask-send")).toBeDisabled();
  await askInput(page).pressSequentially("From the page");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("pr-ask-hint")).toHaveText("Already starting a thread for this pull request");
  await expect(askInput(page)).toHaveValue("From the page");

  // s-1's question starts its session; this one was never sent.
  await expect(selectedSession(page)).toHaveAttribute("data-row-key", /^s:s-new-\d+$/);
  expect(await sessionInvocations("pr.ask")).toEqual([{ args: { "repo-slug": SLUG, number: "145", question: "From s-1" }, worktree: CF }]);

  // Explain from the Pull Requests page; s-1's menu shows it running and disabled.
  await page.getByTestId("nav-pullrequests").click();
  await page.getByTestId("pr-menu-button").click();
  await page.getByTestId("pr-menu-explain").click();
  await expect(page.getByTestId("pr-menu-explain")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("pr-menu-explain")).toHaveAttribute("aria-disabled", "true");
  await row(page, "s:s-1").click();
  await expect(tabs(page)).toHaveText(["#145"]);
  await page.getByTestId("pr-menu-button").click();
  await expect(page.getByTestId("pr-menu-explain")).toHaveAttribute("aria-busy", "true");
  await expect(page.getByTestId("pr-menu-explain")).toHaveAttribute("aria-disabled", "true");
  await expect(page.getByTestId("pr-menu-fix")).not.toHaveAttribute("aria-disabled");
  // aria-disabled keeps it focusable; a select sends nothing (Playwright will not click it unforced).
  await page.getByTestId("pr-menu-explain").click({ force: true });
  await expect(selectedSession(page)).not.toHaveAttribute("data-row-key", /^s:s-1$/);
  await expect(page.getByText(/^Started session s-new-\d+ for PR #145$/)).toHaveCount(2);
  expect(await sessionInvocations("pr.explain")).toHaveLength(1);
});

test("at 280px the composer's hint fits and its field grows to six rows, then scrolls", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await setPanelWidth(page, 280);
  await openAsk(page);
  expect(await overflowX(page, "pr-ask")).toBeLessThanOrEqual(0);
  expect(await page.getByTestId("pr-ask-hint").evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(inside(await boxOf(page, "pr-ask-send"), await boxOf(page, "side-panel"))).toBe(true);

  const size = () =>
    askInput(page).evaluate((el) => ({ height: el.clientHeight, scroll: el.scrollHeight, line: parseFloat(getComputedStyle(el).lineHeight) }));
  const three = await size();
  await askInput(page).fill("one\ntwo");
  expect((await size()).height).toBe(three.height);
  await askInput(page).fill("1\n2\n3\n4\n5");
  const five = await size();
  expect(five.height).toBeGreaterThan(three.height);
  expect(five.scroll).toBeLessThanOrEqual(five.height);
  await askInput(page).fill(Array.from({ length: 12 }, (_, i) => `line ${String(i + 1)}`).join("\n"));
  const many = await size();
  // Six rows plus the padding, then it scrolls.
  expect(Math.abs(many.height - (6 * many.line + 16))).toBeLessThanOrEqual(2);
  expect(many.scroll).toBeGreaterThan(many.height);
  await askInput(page).fill("short");
  expect((await size()).height).toBe(three.height);
});
