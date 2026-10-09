import { expect, test, type Page } from "@playwright/test";
import { CF, invocations, openApp, resetMock, row } from "./fixtures";

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

test("menu: Refresh, Open on GitHub, Copy link, the coming-next slots; shift+cmd+c copies too", async ({ page }) => {
  await openPrPage(page);
  await prRow(page, "authored", 145).click();
  await page.getByTestId("pr-menu-button").click();
  const menu = page.getByTestId("pr-menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem")).toHaveText([/^Refresh/, /^Ask a question/, /^Explain this PR/, /^Fix findings in a thread/, /^Open on GitHub/, /^Copy link⇧⌘C$/]);
  for (const id of ["pr-menu-ask", "pr-menu-explain", "pr-menu-fix"]) {
    await expect(page.getByTestId(id)).toHaveAttribute("data-disabled", "");
    await expect(page.getByTestId(id)).toHaveAttribute("title", "Coming next");
  }
  // No revert for an open pull request.
  await expect(page.getByTestId("pr-menu-revert")).toHaveCount(0);
  await expect(page.getByTestId("pr-menu-refresh-hint")).toHaveText(/^Updated \d+s ago$/);

  // Refresh runs pr.refresh and stays open with the new time.
  await page.getByTestId("pr-menu-refresh").click();
  await expect.poll(async () => (await invocations()).filter((i) => i.name === "pr.refresh").map((i) => i.args)).toEqual([{ "repo-slug": SLUG, number: "145" }]);
  await expect(menu).toBeVisible();
  await expect(page.getByTestId("pr-menu-refresh-hint")).toHaveText(/^Updated [0-5]s ago$/);

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
