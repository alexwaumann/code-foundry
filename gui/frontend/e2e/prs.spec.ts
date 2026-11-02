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
  // The sections, cards, filter, inbox zero, caps and the header's freshness:
  // src/components/prs/PullRequestsPage.test.tsx and pageModel.test.ts.
  test("page and inbox zero (screenshots)", async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    await expect(prRows(page, "merged")).toHaveCount(7);
    await shot(page, "prs-page");
    await mockPost("gh/inbox-zero");
    await expect(page.getByTestId("prs-review")).toHaveCount(0);
    await shot(page, "prs-inbox-zero");
  });

  test("the five cards sit in one row under the half-height charts, and wrap beside the side panel", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const cards = page.getByTestId("prs-cards").getByRole("button");
    await expect(cards).toHaveCount(5);
    const row = async () => {
      const boxes = await Promise.all((await cards.all()).map(async (c) => c.boundingBox()));
      const tops = new Set(boxes.map((b) => Math.round(b?.y ?? -1)));
      const widths = boxes.map((b) => b?.width ?? 0);
      return { tops: tops.size, spread: Math.max(...widths) - Math.min(...widths), minWidth: Math.min(...widths) };
    };
    const wide = await row();
    expect(wide.tops).toBe(1);
    expect(wide.spread).toBeLessThan(1.5);
    // The chart's plot is about half its old 170px.
    const chart = await page.getByTestId("activity-merged").locator("svg").boundingBox();
    expect(chart?.height).toBeLessThan(100);
    // The cards sit below both charts.
    const charts = await page.getByTestId("activity").boundingBox();
    const first = await cards.first().boundingBox();
    expect((first?.y ?? 0) >= (charts?.y ?? 0) + (charts?.height ?? 0)).toBe(true);
    await page.getByTestId("prs-list").press("ArrowDown");
    await page.getByTestId("prs-list").press("Enter");
    await expect(page.getByTestId("pr-surface")).toBeVisible();
    // A pull request open in the side panel narrows the page below 640px: three cards a row, none clipped.
    const narrow = await row();
    expect(narrow.tops).toBe(2);
    expect(narrow.minWidth).toBeGreaterThan(150);
    const box = await page.getByTestId("prs-cards").boundingBox();
    for (const c of await cards.all()) {
      const b = await c.boundingBox();
      expect((b?.x ?? 0) + (b?.width ?? 0)).toBeLessThanOrEqual((box?.x ?? 0) + (box?.width ?? 0) + 0.5);
    }
  });

  // Which columns fit which width: src/components/prs/columns.test.ts; the cells per column: PrRows.test.tsx.
  test("beside the side panel, the tables drop columns instead of running past their right edge", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    const table = (s: string) => page.getByTestId(`prs-${s}`).locator("[data-columns]");
    /** How far any cell of the section's table reaches past the table's right edge (px). */
    const overflow = (s: string) =>
      table(s).evaluate((t) => {
        const right = t.getBoundingClientRect().right;
        return Math.max(0, ...[...t.querySelectorAll("[data-nav-key] > .grid > *, .text-overline > *")].map((c) => c.getBoundingClientRect().right - right));
      });
    const sections = ["review", "reviewed", "authored", "else", "merged"];
    await expect(table("review")).toHaveAttribute("data-columns", "Repository,#,Author,Title,Why,Checks,Diff,Age");
    await page.getByTestId("prs-list").press("ArrowDown");
    await page.getByTestId("prs-list").press("Enter");
    await expect(page.getByTestId("pr-surface")).toBeVisible();
    // Narrower: Diff went first, and nothing overflows.
    await expect(table("review")).not.toHaveAttribute("data-columns", /Diff/);
    await expect(table("review")).toHaveAttribute("data-columns", /^Repository,#,.*Title,Why/);
    for (const s of sections) expect(await overflow(s)).toBeLessThanOrEqual(0.5);
  });

  test("a capped project list arrives over the gh stream with its footer", async ({ page }) => {
    await openApp(page);
    await page.getByTestId("nav-pullrequests").click();
    await expect(prRows(page, "merged")).toHaveCount(7);
    await expect(page.getByTestId("prs-cap")).toHaveCount(0);
    await mockPost("gh/project-merged-capped?shown=3&total=64");
    await expect(page.getByTestId("prs-merged").getByTestId("prs-cap")).toBeVisible();
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
