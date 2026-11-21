import { expect, test, type Page } from "@playwright/test";
import { CF, openApp, resetMock, threadsOpenAsTabs } from "./fixtures";
import { openThread } from "./shell";

/**
 * The CSV, JSON and JSON Lines previews (docs/notes/file-previews-3-tables.md). Parsing,
 * sorting, the tree's keys, the meta and Copy contents are vitest's (previews/data/*.test.ts,
 * previews/DataPreviews.test.tsx); this file keeps what only a browser shows: rows
 * virtualized over a 1 MiB file, the sticky header and gutter while scrolling both ways, and
 * the SHOTS-gated screenshots. SHOTS=<dir> saves them.
 */

const file = (page: Page) => page.getByTestId("file-tab");

/** Opens a File tab beside the thread the way a path chip does (stores/filePanel.ts). */
async function openFile(page: Page, path: string): Promise<void> {
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').click();
  const target = JSON.stringify({ project: "repo-cf", base: CF, path });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/${path}`);
}

test.beforeEach(async () => {
  await resetMock();
  // A spec about thread tabs: a reset is a new home, on Panes.
  await threadsOpenAsTabs();
});

test("a 1 MiB CSV mounts a screenful of rows; the header and the gutter stay put while it scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1000, height: 800 });
  await openApp(page);
  await openThread(page, "s-1");
  await openFile(page, "exports/big.csv");
  const grid = file(page).getByTestId("file-table");
  await expect(grid).toHaveAttribute("data-rows", "20800");
  await expect(file(page).getByTestId("file-meta")).toHaveText("20,800 rows · 7 columns · 1012 KB · CSV");
  expect(await grid.getByTestId("grid-row").count()).toBeLessThan(80);

  const header = grid.getByTestId("grid-header").first();
  const headerTop = (await header.boundingBox())?.y;
  await grid.evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
    el.scrollLeft = 200;
  });
  // The rows near the middle are mounted, the first ones are not.
  await expect(grid.locator("[role=rowheader]", { hasText: /^10400$/ })).toBeVisible();
  await expect(grid.locator("[role=rowheader]", { hasText: /^1$/ })).toHaveCount(0);
  expect((await header.boundingBox())?.y).toBe(headerTop);
  const gridLeft = (await grid.boundingBox())?.x ?? 0;
  const gutter = grid.locator("[role=rowheader]", { hasText: /^10400$/ });
  expect(Math.round(((await gutter.boundingBox())?.x ?? 0) - gridLeft)).toBe(0);
});

const shots = process.env.SHOTS;

test("data preview screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp(page);
  await openThread(page, "s-1");
  const shot = async (name: string) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page.getByTestId("shell-pane").filter({ has: file(page) }).screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await openFile(page, "exports/customers.csv");
  await expect(file(page).getByTestId("grid-row").first()).toBeVisible();
  await shot("csv");
  const mrr = file(page).getByTestId("grid-header").filter({ hasText: "mrr" });
  await mrr.getByRole("button").click();
  await mrr.getByRole("button").click();
  await expect(mrr).toHaveAttribute("aria-sort", "descending");
  await shot("csv-sorted");
  await openFile(page, "gui/frontend/package.json");
  await expect(file(page).getByTestId("file-json-tree")).toBeVisible();
  await shot("json");
  await openFile(page, "docs/broken.json");
  await expect(file(page).getByTestId("file-json-invalid")).toBeVisible();
  await shot("json-invalid");
  await openFile(page, "evals/run-07/results.jsonl");
  await file(page).getByTestId("grid-row").nth(2).locator(".cf-grid-line").click();
  await expect(file(page).getByTestId("jsonl-record-tree")).toBeVisible();
  await shot("jsonl-expanded");
  await openFile(page, "evals/run-07/mixed.jsonl");
  await expect(file(page).getByTestId("grid-row").first()).toBeVisible();
  await shot("jsonl-mixed");
  await openFile(page, "exports/edges.csv");
  await expect(file(page).getByTestId("grid-row").first()).toBeVisible();
  await shot("csv-edges");
});
