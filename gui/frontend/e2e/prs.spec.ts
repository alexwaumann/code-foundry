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

const prRows = (page: Page, section: string) => page.getByTestId(`prs-${section}`).locator("[data-nav-key]");

test.beforeEach(async () => {
  await resetMock();
});

test.describe("Pull Requests page", () => {
  test("sidebar entry opens it: activity charts, three sections filtered to registered repos", async ({ page }) => {
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
    // other-org/lib is not registered: filtered out of review and merged.
    await expect(prRows(page, "authored")).toHaveCount(3);
    await expect(prRows(page, "review")).toHaveCount(1);
    await expect(prRows(page, "merged")).toHaveCount(3);
    const first = prRows(page, "authored").first();
    await expect(first).toContainText("#142");
    await expect(first).toContainText("virtualized sidebar tree");
    await expect(first.locator("[data-checks]")).toHaveAttribute("data-checks", "success");
    await expect(first).toContainText("approved");
    await expect(prRows(page, "authored").nth(1).locator("[data-checks]")).toHaveAttribute("data-checks", "failure");
    await expect(prRows(page, "review").first()).toContainText("teammate-kim");
    await shot(page, "prs-page");

    // "A" shows every repository.
    await page.getByTestId("prs-list").press("a");
    await expect(page.getByTestId("prs-scope")).toHaveText("all repositories");
    await expect(prRows(page, "review")).toHaveCount(2);
    await expect(prRows(page, "merged")).toHaveCount(4);
  });

  test("activity charts share the hovered month; one tooltip, in the card under the pointer", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const merged = page.getByTestId("activity-merged");
    const commits = page.getByTestId("activity-commits");
    const tip = page.getByTestId("activity-tooltip");
    // Oldest first: index 3 of 6 is two months back (August in the mock's October).
    await merged.getByTestId("activity-month").nth(3).hover();
    await expect(tip).toHaveCount(1);
    await expect(merged.getByTestId("activity-tooltip")).toBeVisible();
    await expect(tip).toContainText("210");
    await expect(tip).toContainText("17");
    await expect(tip).toHaveAttribute("data-side", "left");
    await expect(commits.getByTestId("activity-crosshair")).toHaveCount(1);
    await expect(commits.getByTestId("activity-band")).toBeVisible();
    await shot(page, "prs-activity-hover");
    // The pointer moves to the other card: the tooltip follows it.
    await commits.getByTestId("activity-month").nth(1).hover();
    await expect(tip).toHaveCount(1);
    const now = new Date();
    const june = new Date(now.getFullYear(), now.getMonth() - 4, 1);
    await expect(commits.getByTestId("activity-tooltip")).toHaveAttribute("data-month", `${String(june.getFullYear())}-${String(june.getMonth() + 1).padStart(2, "0")}`);
    await expect(tip.locator('[data-series="commits"]')).toContainText("0");
    await expect(tip).toHaveAttribute("data-side", "right");
    await expect(merged.getByTestId("activity-crosshair")).toHaveCount(1);
    // The current month says so.
    await commits.getByTestId("activity-month").nth(5).hover();
    await expect(tip).toContainText("(so far)");
    await expect(tip).toContainText("16");
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
    await list.press("ArrowDown");
    await expect(prRows(page, "authored").first()).toHaveAttribute("aria-selected", "true");
    await list.press("j");
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
    await expect(page.getByTestId("worktree-surface")).toBeVisible();
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
    await expect(prRows(page, "authored").first()).toContainText("#150");
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
