import { expect, test, type Page } from "@playwright/test";
import { mockPost, openApp, openStreams, resetMock } from "./fixtures";

// The sidebar's search row (docs/notes/search-sidebar-row.md), only the flow across the
// dialog and the daemon's event stream, and that the row holds no stream of its own. Its
// states, words and which command a click runs are vitest
// (components/search/SearchNav.test.tsx, SearchTarget.test.tsx, lib/searchActivity.test.ts).

test.beforeEach(async () => {
  await resetMock();
  await mockPost("thread?state=idle");
  await mockPost("search?stepMs=120&hits=2");
});

const navRow = (page: Page) => page.getByTestId("nav-search");
const dialog = (page: Page) => page.getByTestId("search-dialog");

/** Starts a search in the dialog and closes it behind the run. */
async function searchAndClose(page: Page, question: string): Promise<void> {
  await page.keyboard.press("Meta+Shift+F");
  await page.keyboard.type(question);
  await page.keyboard.press("Enter");
  await expect(dialog(page).getByTestId("agent-results")).toHaveAttribute("data-status", "running");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
}

test("a search left behind the closed dialog: Searching…, then its results; a click jumps back in and the row goes", async ({ page }) => {
  await openApp(page);
  await expect(navRow(page)).toHaveCount(0);
  const before = await openStreams();
  await searchAndClose(page, "where did we decide the badge fix?");
  await expect(navRow(page)).toHaveAttribute("data-state", "running");
  await expect(navRow(page)).toHaveAttribute("data-state", "results");
  await expect(page.getByTestId("nav-search-count")).toHaveText("2");
  // WatchRecent and Watch went with the dialog; the row rides the event stream.
  expect((await openStreams())["SearchService/WatchRecent"] ?? 0).toBe(0);
  expect((await openStreams())["SearchService/Watch"] ?? 0).toBe(0);
  expect((await openStreams())["EventService/Watch"]).toBe(before["EventService/Watch"]);

  await navRow(page).click();
  await expect(dialog(page).getByTestId("agent-results")).toHaveAttribute("data-status", "done");
  await expect(page.getByTestId("search-input")).toHaveValue("where did we decide the badge fix?");
  await expect(navRow(page)).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toBeHidden();
  await expect(navRow(page)).toHaveCount(0);
});

test("a run a daemon restart lost does not stay Searching…", async ({ page }) => {
  await mockPost("search?stepMs=5000");
  await openApp(page);
  await searchAndClose(page, "lost to a restart");
  await expect(navRow(page)).toHaveAttribute("data-state", "running");
  await mockPost("daemon/restart");
  await expect(navRow(page)).toHaveAttribute("data-state", "failed");
  await expect(navRow(page)).toHaveText("Search failed");
});

/** SHOTS=<dir>: the row's states in the sidebar, in both schemes, for the PR. */
for (const scheme of ["dark", "light"] as const) {
  test(`shots ${scheme}`, async ({ page }) => {
    const dir = process.env.SHOTS;
    test.skip(!dir, "SHOTS=<dir> only");
    test.setTimeout(60_000);
    await page.emulateMedia({ colorScheme: scheme });
    await page.setViewportSize({ width: 1280, height: 800 });
    await mockPost("search?stepMs=500&hits=8");
    await openApp(page);
    const shot = (name: string) => page.screenshot({ path: `${dir ?? ""}/search-row-${name}-${scheme}.png` });
    await searchAndClose(page, "which threads talked about the PR badge fix");
    await expect(navRow(page)).toHaveAttribute("data-state", "running");
    await shot("running");
    await expect(navRow(page)).toHaveAttribute("data-state", "results", { timeout: 20_000 });
    await page.mouse.move(640, 700);
    await shot("results");
    await navRow(page).click();
    await expect(dialog(page).getByTestId("agent-results")).toHaveAttribute("data-status", "done");
    // The dialog's fade.
    await page.waitForTimeout(400);
    await shot("opened");
    await page.keyboard.press("Escape");
    await mockPost("search?stepMs=60&hits=0");
    await page.keyboard.press("Meta+Shift+F");
    await page.keyboard.press("Meta+Backspace");
    await page.keyboard.type("nothing answers this");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(navRow(page)).toHaveAttribute("data-state", "none");
    await page.mouse.move(640, 700);
    await shot("none");
    await navRow(page).click();
    await expect(dialog(page)).toBeVisible();
    await page.keyboard.press("Escape");
    await mockPost("search?stepMs=60&fail=1&hits=8");
    await page.keyboard.press("Meta+Shift+F");
    await page.keyboard.press("Meta+Backspace");
    await page.keyboard.type("this run fails");
    await page.keyboard.press("Enter");
    await page.keyboard.press("Escape");
    await expect(navRow(page)).toHaveAttribute("data-state", "failed");
    await page.mouse.move(640, 700);
    await shot("failed");
  });
}
