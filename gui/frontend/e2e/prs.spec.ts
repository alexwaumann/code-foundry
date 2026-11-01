import { expect, test, type Page } from "@playwright/test";
import { CF, emit, invocations, mockPost, openApp, resetMock, row, selectWorktree } from "./fixtures";

/**
 * Phase 3a: the Pull Requests page, against the mock daemon (mock/github.ts); the
 * worktree overview is e2e/worktree-panel.spec.ts. Set SHOTS=<dir> to save screenshots.
 */

const CFW = `${CF}.worktrees`;
const shots = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

/** A section's rows by nav key (the reviewed card sits inside the review section). */
const prRows = (page: Page, section: string) => page.getByTestId("prs-list").locator(`[data-nav-key^="${section}:"]`);

test.beforeEach(async () => {
  await resetMock();
});

test.describe("Pull Requests page", () => {
  // "sidebar entry opens it: the review queue, your pull requests, merges, then the charts" and "the
  // sidebar counts the pull requests that need review; inbox zero shows Ember": src/components/prs/PullRequestsPage.test.tsx.
  test("page and inbox zero (screenshots)", async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    await expect(prRows(page, "merged")).toHaveCount(4);
    await shot(page, "prs-page");
    await mockPost("gh/inbox-zero");
    await expect(page.getByTestId("prs-inbox-zero")).toBeVisible();
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

  // Keyboard order, Enter and click into the side panel, cmd+Enter and cmd+click on GitHub: src/components/prs/PullRequestsPage.test.tsx.
  test("the list keeps focus while Enter opens a row in the side panel", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const list = page.getByTestId("prs-list");
    await expect(list).toBeFocused();
    await list.press("ArrowDown");
    await list.press("Enter");
    await expect(page.getByTestId("panel-tabs").getByRole("tab")).toHaveText(["#139"]);
    await expect(page.getByTestId("pr-surface")).toBeVisible();
    await expect(list).toBeFocused();
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

  // "gh events refresh the page; a failed poll shows stale and the error": src/components/prs/PullRequestsPage.test.tsx.
});
