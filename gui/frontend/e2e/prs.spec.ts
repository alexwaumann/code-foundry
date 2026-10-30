import { expect, test, type Page } from "@playwright/test";
import { CF, emit, invocations, mockPost, mockUrl, openApp, resetMock, row, selectWorktree } from "./fixtures";

/**
 * Phase 3a: the Pull Requests page, against the mock daemon (mock/github.ts); the
 * worktree overview is e2e/worktree-panel.spec.ts. Set SHOTS=<dir> to save screenshots.
 */

const CFW = `${CF}.worktrees`;
const shots = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

async function ghCalls(): Promise<Record<string, number>> {
  const res = await fetch(`${mockUrl}/__mock/gh/calls`);
  return (await res.json()) as Record<string, number>;
}

/** A section's rows by nav key (the reviewed card sits inside the review section). */
const prRows = (page: Page, section: string) => page.getByTestId("prs-list").locator(`[data-nav-key^="${section}:"]`);

test.beforeEach(async () => {
  await resetMock();
});

test.describe("Pull Requests page", () => {
  test("sidebar entry opens it: the review queue, your pull requests, merges, then the charts", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const pageEl = page.getByTestId("prs-page");
    await expect(pageEl).toBeVisible();
    await expect(page.getByTestId("nav-pullrequests")).toHaveAttribute("aria-current", "page");
    await expect(page.getByTestId("prs-viewer")).toHaveText("@alexwaumann");
    await expect(page.getByTestId("prs-updated")).toHaveText(/updated \d+s ago/);
    // Activity charts (mock: six months newest first, 16/2, 463/38, 210/17, 96/9, 0/0, 41/3).
    const merged = page.getByTestId("activity-merged");
    const commits = page.getByTestId("activity-commits");
    await expect(merged.getByTestId("activity-month")).toHaveCount(6);
    await expect(merged.getByTestId("activity-value")).toHaveText("38");
    await expect(commits.getByTestId("activity-value")).toHaveText("463");
    await expect(merged.locator('[data-testid="activity-marker"][data-partial]')).toHaveAttribute("data-value", "2");
    await expect(commits.locator('[data-testid="activity-marker"][data-partial]')).toHaveAttribute("data-value", "16");
    await expect(page.getByTestId("activity-tooltip")).toHaveCount(0);
    // The sections in page order, the charts last; no scope toggle.
    const order = await pageEl.locator('[data-testid^="prs-"]:is(section), [data-testid="activity-merged"]').evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(order).toEqual(["prs-review", "prs-authored", "prs-merged", "activity-merged"]);
    await expect(page.getByTestId("prs-scope")).toHaveCount(0);

    // Every repository: other-org/lib is not a registered project and is listed.
    // Needs your review, newest first: requested by name, a stale review, a team request.
    const needs = prRows(page, "review");
    await expect(needs).toHaveCount(3);
    await expect(page.getByTestId("prs-review").locator("h2")).toHaveText("Needs your review(3)");
    expect(await needs.evaluateAll((rows) => rows.map((r) => r.getAttribute("data-nav-key")))).toEqual([
      "review:alexwaumann/code-foundry#139",
      "review:alexwaumann/ghostty-playground#14",
      "review:other-org/lib#77",
    ]);
    await expect(needs.getByTestId("prs-why")).toHaveText(["Requested", "Re-review · new commits", "Requested · via team"]);
    await expect(needs.first()).toContainText("teammate-kim");
    // Reviewed by you: on the head, waiting on the author, with the verdict.
    const reviewed = prRows(page, "reviewed");
    await expect(page.getByTestId("prs-reviewed")).toContainText("Reviewed by you(2)· open, waiting on the author");
    await expect(reviewed).toHaveCount(2);
    await expect(reviewed.getByTestId("prs-verdict")).toHaveText(["You approved", "You requested changes"]);
    await expect(reviewed.first()).toContainText("#133");

    // Your open pull requests: the status pill, action needed first; comments + reviews.
    const authored = prRows(page, "authored");
    await expect(authored).toHaveCount(3);
    await expect(authored.getByTestId("prs-status")).toHaveText(["CI failing", "Ready to merge", "Awaiting review · 1"]);
    await expect(authored.first()).toContainText("#145");
    await expect(authored.first().locator("[data-checks]")).toHaveAttribute("data-checks", "failure");
    await expect(authored.nth(1)).toContainText("virtualized sidebar tree");
    await expect(authored.nth(1).getByTestId("prs-comments")).toHaveText("3");

    // Merged in the last 7 days, every repository.
    await expect(prRows(page, "merged")).toHaveCount(4);
    await shot(page, "prs-page");
  });

  test("the sidebar counts the pull requests that need review; inbox zero shows Ember", async ({ page }) => {
    await openApp(page);
    // The count is there before the page is opened: the sidebar holds the dashboard.
    const pill = page.getByTestId("nav-pullrequests-count");
    await expect(pill).toHaveText("3");
    await pill.hover();
    await expect(page.getByRole("tooltip")).toHaveText("3 pull requests need your review");
    await page.getByTestId("nav-pullrequests").click();
    await expect(prRows(page, "review")).toHaveCount(3);
    const reads = (await ghCalls()).GetDashboard ?? 0;

    // Nothing waits on the viewer: the card replaces the table, the reviewed rows stay.
    await mockPost("gh/inbox-zero");
    const zero = page.getByTestId("prs-inbox-zero");
    await expect(zero).toBeVisible();
    await expect(prRows(page, "review")).toHaveCount(0);
    await expect(zero).toContainText("Nothing waiting on you");
    await expect(zero.getByTestId("ember-flame")).toHaveAttribute("data-state", "idle");
    // #142 is approved and green: Ember suggests shipping it.
    await expect(page.getByTestId("prs-ember-line")).toHaveText("The forge is quiet. #142 is approved and green, want to ship it?");
    await expect(prRows(page, "reviewed")).toHaveCount(2);
    await expect(page.getByTestId("prs-review").locator("h2")).toHaveText("Needs your review(0)");
    await expect(pill).toHaveCount(0);
    // One read per change, shared by the page and the sidebar.
    expect((await ghCalls()).GetDashboard ?? 0).toBe(reads + 1);
    await shot(page, "prs-inbox-zero");
  });

  test("activity charts share the hovered month; one tooltip, in the card under the pointer", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const merged = page.getByTestId("activity-merged");
    const commits = page.getByTestId("activity-commits");
    const tip = page.getByTestId("activity-tooltip");
    // The tooltip's content and side are ActivityCharts.test.tsx's; here, a real pointer.
    await merged.getByTestId("activity-month").nth(3).hover();
    await expect(tip).toHaveCount(1);
    await expect(merged.getByTestId("activity-tooltip")).toBeVisible();
    await expect(commits.getByTestId("activity-crosshair")).toHaveCount(1);
    await expect(commits.getByTestId("activity-band")).toBeVisible();
    await shot(page, "prs-activity-hover");
    // The pointer moves to the other card: the tooltip follows it.
    await commits.getByTestId("activity-month").nth(1).hover();
    await expect(tip).toHaveCount(1);
    await expect(commits.getByTestId("activity-tooltip")).toBeVisible();
    await expect(merged.getByTestId("activity-crosshair")).toHaveCount(1);
    // Leaving clears both.
    await page.mouse.move(2, 2);
    await expect(tip).toHaveCount(0);
    await expect(page.getByTestId("activity-crosshair")).toHaveCount(0);
  });

  test("Enter and click open pull requests in the side panel; cmd+Enter and cmd+click on GitHub", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const list = page.getByTestId("prs-list");
    await expect(list).toBeFocused();
    // Keyboard order is page order: needs review, reviewed, authored, merged.
    await list.press("ArrowDown");
    await expect(prRows(page, "review").first()).toHaveAttribute("aria-selected", "true");
    for (let i = 0; i < 3; i++) await list.press("j");
    await expect(prRows(page, "reviewed").first()).toHaveAttribute("aria-selected", "true");
    for (let i = 0; i < 2; i++) await list.press("j");
    await expect(prRows(page, "authored").first()).toHaveAttribute("aria-selected", "true");
    await list.press("Enter");
    const tabs = page.getByTestId("panel-tabs").getByRole("tab");
    await expect(tabs).toHaveText(["#145"]);
    await expect(page.getByTestId("pr-title")).toHaveText("fix(terminal): resize race between attach and first output");
    // The list keeps focus, so the keyboard goes on: cmd+Enter opens the row on GitHub.
    await expect(list).toBeFocused();
    await list.press("Meta+Enter");
    await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").map((i) => i.args.url)).toEqual([
      "https://github.com/alexwaumann/code-foundry/pull/145",
    ]);
    // End jumps to the last row (merged section); a click opens any row in the panel.
    await list.press("End");
    await expect(prRows(page, "merged").last()).toHaveAttribute("aria-selected", "true");
    await prRows(page, "review").first().click();
    await expect(tabs).toHaveText(["#145", "#139"]);
    await expect(prRows(page, "review").first()).toHaveAttribute("aria-selected", "true");
    // cmd+click opens it on GitHub and adds no tab.
    await prRows(page, "review").first().click({ modifiers: ["Meta"] });
    await expect.poll(async () => (await invocations()).filter((i) => i.name === "view.open.url").length).toBe(2);
    const last = (await invocations()).filter((i) => i.name === "view.open.url").at(-1);
    expect(last?.args.url).toBe("https://github.com/alexwaumann/code-foundry/pull/139");
    await expect(tabs).toHaveCount(2);
  });

  test("cmd+shift+d runs view.pullrequests and the ShowView intent switches the page", async ({ page }) => {
    await openApp(page);
    await selectWorktree(page, "repo-cf", `${CFW}/feat-sidebar`);
    await expect(page.getByTestId("changes-surface")).toBeVisible();
    await page.keyboard.press("Meta+Shift+d");
    await expect(page.getByTestId("prs-page")).toBeVisible();
    expect((await invocations()).some((i) => i.name === "view.pullrequests")).toBe(true);

    // An intent from the CLI (UiService.Emit) does the same.
    await row(page, "s:s-1").click();
    await expect(page.getByTestId("prs-page")).toHaveCount(0);
    expect(await emit({ showView: { name: "pullrequests" } })).toBeGreaterThan(0);
    await expect(page.getByTestId("prs-page")).toBeVisible();
    // Unknown views are ignored.
    await emit({ showView: { name: "nope" } });
    await expect(page.getByTestId("prs-page")).toBeVisible();
  });

  test("gh events refresh the page; a failed poll shows stale and the error", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    await expect(prRows(page, "authored")).toHaveCount(3);
    const before = (await ghCalls()).GetDashboard ?? 0;
    await mockPost("gh/update");
    await expect(prRows(page, "authored")).toHaveCount(4);
    // #150 needs no action from its author yet: after #145 (CI failing).
    await expect(prRows(page, "authored").nth(1)).toContainText("#150");
    await expect(prRows(page, "authored").nth(1).getByTestId("prs-status")).toHaveText("No reviewers");
    expect((await ghCalls()).GetDashboard ?? 0).toBeGreaterThan(before);
    // A failed poll arrives as a polled event only: no re-read, the header turns red.
    const reads = (await ghCalls()).GetDashboard ?? 0;
    await mockPost("gh/stale");
    await expect(page.getByTestId("prs-updated")).toHaveAttribute("data-freshness", "error");
    await expect(page.getByTestId("prs-updated")).toContainText("updated 10m ago");
    // A poll that changed nothing freshens the header, still without a re-read.
    await mockPost("gh/poll");
    await expect(page.getByTestId("prs-updated")).toHaveAttribute("data-freshness", "fresh");
    await expect(page.getByTestId("prs-updated")).toContainText(/updated \d+s ago/);
    expect((await ghCalls()).GetDashboard ?? 0).toBe(reads);
  });
});
