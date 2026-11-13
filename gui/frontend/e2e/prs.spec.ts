import { expect, test, type Page } from "@playwright/test";
import { emit, invocations, invokeAs, mockPost, resetMock } from "./fixtures";
import { layoutState, openShellApp, paneNode, paneOf, paletteRun, seedLayout, threadTab } from "./shell";
import { openPrsTab } from "./shell-pages";

/**
 * Phase 3a: the Pull Requests page, in its tab, against the mock daemon (mock/github.ts). Set
 * SHOTS=<dir> to save screenshots.
 */

const shots = process.env.SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (shots) await page.screenshot({ path: `${shots}/${name}.png` });
}

/** A section's rows by nav key (the reviewed card sits inside the review section). */
const prRows = (page: Page, section: string) => page.getByTestId("prs-list").locator(`[data-nav-key^="${section}:"]`);

test.beforeEach(async () => {
  await resetMock();
});

/** Sizes the window so the page's pane (the only one) is `width` wide. */
async function paneWidth(page: Page, width: number): Promise<void> {
  const pane = paneOf(page, "p-1");
  const now = Math.round((await pane.boundingBox())?.width ?? 0);
  const vp = page.viewportSize() ?? { width: 1280, height: 800 };
  await page.setViewportSize({ width: vp.width + width - now, height: vp.height });
  await expect.poll(async () => Math.round((await pane.boundingBox())?.width ?? 0)).toBe(width);
}

test.describe("Pull Requests page", () => {
  // A list past RowList's limit, under the sections above it: the keyboard's row is not mounted
  // and not in the window, so the list and the page around it both have to move.
  test("End and Home bring a virtualized list's cursor row into view", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockPost("gh/many-prs?count=150");
    await openPrsTab(page);
    const listBox = page.getByTestId("prs-list");
    await expect(listBox.locator('[data-virtual="true"]').first()).toBeVisible();
    const inView = () =>
      page.evaluate(() => {
        const row = document.querySelector('[aria-selected="true"][data-nav-key]');
        if (!row) return false;
        const r = row.getBoundingClientRect();
        for (let p = row.parentElement; p; p = p.parentElement) {
          if (!/auto|scroll/.test(getComputedStyle(p).overflowY)) continue;
          const b = p.getBoundingClientRect();
          if (r.top < b.top - 1 || r.bottom > b.bottom + 1) return false;
        }
        return r.top >= 0 && r.bottom <= innerHeight;
      });
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("[aria-activedescendant], [data-testid=\"prs-list\"]")?.focus();
    });
    await page.keyboard.press("End");
    await expect(page.locator('[aria-selected="true"][data-nav-key]')).toHaveCount(1);
    await expect.poll(inView).toBe(true);
    await page.keyboard.press("Home");
    await expect.poll(inView).toBe(true);
    // The window's own place is the list's parent, and the row is that far in: not left where End put it.
    await expect.poll(() => page.locator('[aria-selected="true"][data-nav-key]').evaluate((e) => e.getAttribute("data-nav-key"))).toMatch(/^review:/);
  });

  // The sections, cards, filter, inbox zero, caps and the header's freshness:
  // src/components/prs/PullRequestsPage.test.tsx and pageModel.test.ts.
  test("page and inbox zero (screenshots)", async ({ page }) => {
    test.skip(!shots, "SHOTS=<dir> only: the screenshots are all it adds");
    await openPrsTab(page);
    await expect(prRows(page, "merged")).toHaveCount(7);
    await shot(page, "prs-page");
    await mockPost("gh/inbox-zero");
    await expect(page.getByTestId("prs-review")).toHaveCount(0);
    await shot(page, "prs-inbox-zero");
  });

  test("the five cards sit in one row under the half-height charts, and wrap beside the side panel", async ({ page }) => {
    await openPrsTab(page);
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
    // In a pane below 640px (as beside a pull request's pane): three cards a row, none clipped.
    await paneWidth(page, 600);
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
    await openPrsTab(page);
    const table = (s: string) => page.getByTestId(`prs-${s}`).locator("[data-columns]");
    /** How far any cell of the section's table reaches past the table's right edge (px). */
    const overflow = (s: string) =>
      table(s).evaluate((t) => {
        const right = t.getBoundingClientRect().right;
        return Math.max(0, ...[...t.querySelectorAll("[data-nav-key] > .grid > *, .text-overline > *")].map((c) => c.getBoundingClientRect().right - right));
      });
    const sections = ["review", "reviewed", "authored", "else", "merged"];
    await expect(table("review")).toHaveAttribute("data-columns", "Repository,#,Author,Title,Why,Checks,Diff,Age");
    // In a narrower pane (as beside a pull request's pane): Diff went first, and nothing overflows.
    await paneWidth(page, 600);
    await expect(table("review")).not.toHaveAttribute("data-columns", /Diff/);
    await expect(table("review")).toHaveAttribute("data-columns", /^Repository,#,.*Title,Why/);
    for (const s of sections) expect(await overflow(s)).toBeLessThanOrEqual(0.5);
  });

  test("a capped project list arrives over the gh stream with its footer", async ({ page }) => {
    await openPrsTab(page);
    await expect(prRows(page, "merged")).toHaveCount(7);
    await expect(page.getByTestId("prs-cap")).toHaveCount(0);
    await mockPost("gh/project-merged-capped?shown=3&total=64");
    await expect(page.getByTestId("prs-merged").getByTestId("prs-cap")).toBeVisible();
  });

  test("activity charts share the hovered month; one tooltip, in the card under the pointer", async ({ page }) => {
    await openPrsTab(page);
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

  // Keyboard order, Enter and click opening a pull request, cmd+Enter and cmd+click on GitHub: src/components/prs/PullRequestsPage.test.tsx.
  test("Enter on a row opens its pull request in the page's pane, shown", async ({ page }) => {
    await openPrsTab(page);
    const list = page.getByTestId("prs-list");
    await expect(list).toBeFocused();
    await list.press("ArrowDown");
    await list.press("Enter");
    await expect(page.locator('[data-testid="shell-tab"][data-kind="pullrequest"]')).toHaveText("#139");
    await expect(page.getByTestId("pr-surface")).toBeVisible();
  });

  // cmd+shift+d is the thread's diff in the shell (shell-model.md, Keys); Show Pull Requests has no
  // chord: the palette and a pane's + open the page (+: src/components/shell/linkedTabs.test.tsx).
  test("the palette runs view.pullrequests, and the CLI's opens the page's tab too", async ({ page }) => {
    await seedLayout(paneNode("p-1", [threadTab("s-1")]), "p-1");
    await openShellApp(page);
    await expect(page.locator('[data-testid="thread-pane"][data-thread-id="s-1"]')).toBeVisible();
    await paletteRun(page, "Show Pull Requests", "view.pullrequests");
    await expect(page.getByTestId("prs-page")).toBeVisible();
    expect((await invocations()).some((i) => i.name === "view.pullrequests")).toBe(true);

    // The CLI's (the user's, outside a thread) does the same through the layout alone: the space's
    // one Pull Requests tab, shown (docs/notes/shell-22-retire-verbs.md).
    await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').click();
    await expect(page.getByTestId("prs-page")).toHaveCount(0);
    expect((await invokeAs("", "view.pullrequests")).ok).toBe(true);
    await expect(page.getByTestId("prs-page")).toBeVisible();
    const kinds = async () => {
      const root = (await layoutState()).spaces[0]?.root;
      return root?.t === "pane" ? root.tabs.map((t) => String(t.kind)) : [];
    };
    await expect.poll(kinds).toEqual(["thread", "prs"]);
    // A ShowView of the page (an older daemon's) is no view any more: ignored.
    await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').click();
    await emit({ showView: { name: "pullrequests" } });
    await emit({ showView: { name: "nope" } });
    await expect(page.locator('[data-testid="thread-pane"][data-thread-id="s-1"]')).toBeVisible();
  });

  // "gh events refresh the page; a failed poll shows stale and the error": src/components/prs/PullRequestsPage.test.tsx.
});
