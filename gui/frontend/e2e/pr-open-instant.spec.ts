import { expect, test, type Page } from "@playwright/test";
import { mockPost, mockUrl, resetMock } from "./fixtures";
import { openPrsTab } from "./shell-pages";

/**
 * Opening a pull request with nothing cached (docs/notes/pr-open-instant.md): what only a real
 * pointer shows, the dwell over the Pull Requests page's rows under a moving or scrolling list.
 * The seeded view, the caps and the abort: src/components/pr/PullRequestSurface.seed.test.tsx
 * and src/stores/prPrefetch.test.ts. Set SHOTS=<dir> to save the seeded state's screenshots.
 */

const shots = process.env.SHOTS;

test.beforeEach(async () => {
  await resetMock();
});

/** Detail reads the mock has answered. */
async function detailReads(): Promise<number> {
  const res = await fetch(`${mockUrl}/__mock/gh/calls`);
  return ((await res.json()) as Record<string, number>).GetPullRequestDetail ?? 0;
}

/** Longer than the dwell, for what must not have started. */
const pastDwell = (page: Page) => page.waitForTimeout(350);

const rowsOf = (page: Page) => page.getByTestId("prs-list").locator("[data-nav-key]");

test("a pointer resting on a row reads its detail once; a sweep across the table reads at most the row it ends on", async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 900 });
  await openPrsTab(page);
  const before = await detailReads();

  const count = await rowsOf(page).count();
  const first = await rowsOf(page).first().boundingBox();
  const last = await rowsOf(page).nth(Math.min(count - 1, 9)).boundingBox();
  if (!first || !last) throw new Error("no rows on screen");
  await page.mouse.move(first.x + 200, first.y + 5);
  await page.mouse.move(last.x + 200, last.y + 5, { steps: 12 });
  await page.mouse.move(last.x + 200, 5); // off the table
  await pastDwell(page);
  expect((await detailReads()) - before).toBeLessThanOrEqual(1);

  const swept = await detailReads();
  await rowsOf(page).nth(2).hover();
  await expect.poll(detailReads).toBe(swept + 1);
  await page.mouse.move(first.x + 200, 5);
  await rowsOf(page).nth(2).hover();
  await pastDwell(page);
  expect(await detailReads()).toBe(swept + 1); // warm now
});

// Rows scrolling under a still pointer reading nothing: src/stores/prPrefetch.test.ts ("scrolling").

for (const scheme of ["dark", "light"] as const) {
  test(`seeded screenshots (${scheme})`, async ({ page }, info) => {
    test.skip(!shots || info.project.name !== "webkit", "SHOTS=<dir> with WebKit only");
    const suffix = scheme === "light" ? "-light" : "";
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1400, height: 900 });
    await openPrsTab(page);
    await mockPost("gh/pr-detail-delay?ms=4000");
    await page.getByTestId("prs-authored").locator("[data-nav-key]").filter({ hasText: "#145" }).click();
    // The row's tab opens behind the page in its pane (prs.spec.ts's shell gap): shown from its tab.
    await page.locator('[data-testid="shell-tab"][data-kind="pullrequest"] [role="tab"]').click();
    await expect(page.getByTestId("pr-seed-body")).toBeVisible();
    await page.screenshot({ path: `${shots ?? ""}/pr-seeded${suffix}.png` });
    await expect(page.getByTestId("pr-surface")).not.toHaveAttribute("data-seeded", "", { timeout: 8000 });
    await page.screenshot({ path: `${shots ?? ""}/pr-landed${suffix}.png` });
  });
}
