import { expect, test, type Page } from "@playwright/test";
import { CF, mockPost, openApp, resetMock } from "./fixtures";
import { openThread } from "./shell";

/**
 * The log preview (docs/notes/file-previews-6-logs.md). Parsing, the layout of a row, the
 * filter and which kind a file is are vitest's (src/components/files/previews/); this file
 * keeps what only a browser shows: where the list is scrolled when it opens and after a
 * re-read, and the SHOTS-gated screenshots. SHOTS=<dir> saves them.
 */

const file = (page: Page) => page.getByTestId("file-tab");
const rows = (page: Page) => file(page).getByTestId("file-log-rows");
const MiB = 1024 * 1024;

/** Opens a File tab beside the thread the way a path chip does (stores/filePanel.ts). */
async function openFile(page: Page, path: string): Promise<void> {
  await page.locator('[data-testid="shell-tab"][data-kind="thread"] [role="tab"]').click();
  const target = JSON.stringify({ project: "repo-cf", base: CF, path });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  await expect(file(page)).toHaveAttribute("data-path", `${CF}/${path}`);
}

/** How far the rows are from their bottom, px. */
const fromBottom = (page: Page) => rows(page).evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);

/** The text of the row at the top of the box. */
const topRow = (page: Page) =>
  rows(page).evaluate((el) => {
    const top = el.getBoundingClientRect().top;
    const hit = [...el.querySelectorAll<HTMLElement>('[data-testid="file-log-row"]')].find((r) => r.getBoundingClientRect().bottom > top + 1);
    return hit?.textContent ?? "";
  });

test.beforeEach(async () => {
  await resetMock();
});

test("a log opens at its bottom, stays there when the file grows, and otherwise keeps the line being read", async ({ page }) => {
  await mockPost(`fs/log?bytes=${String(3 * MiB)}`);
  await openApp(page);
  await openThread(page, "s-1");
  await openFile(page, "logs/big.log");
  await expect(file(page).getByTestId("file-truncated-start")).toContainText("Showing the last 1 MiB of 3.0 MB");
  await expect(rows(page).getByTestId("file-log-row").last()).toContainText("· the end");
  expect(await fromBottom(page)).toBeLessThanOrEqual(2);

  // At the bottom: the file grows, Refresh, and the new end shows.
  await mockPost(`fs/log?bytes=${String(3 * MiB + 4096)}`);
  const before = await rows(page).getByTestId("file-log-row").last().textContent();
  await file(page).getByTestId("file-refresh").click();
  await expect(rows(page).getByTestId("file-log-row").last()).not.toHaveText(before ?? "");
  await expect(rows(page).getByTestId("file-log-row").last()).toContainText("· the end");
  expect(await fromBottom(page)).toBeLessThanOrEqual(2);

  // Scrolled up: the file grows (the tail moves on), and the same line stays on top.
  await rows(page).evaluate((el) => {
    el.scrollTop = el.scrollHeight / 2;
  });
  await expect.poll(() => topRow(page)).toMatch(/line \d+/);
  const reading = (/line \d+/.exec(await topRow(page)) ?? [""])[0];
  await mockPost(`fs/log?bytes=${String(3 * MiB + 64 * 1024)}`);
  await file(page).getByTestId("file-refresh").click();
  await expect(file(page).getByTestId("file-meta")).toContainText("3.1 MB · Log");
  await expect.poll(async () => (/line \d+/.exec(await topRow(page)) ?? [""])[0]).toBe(reading);
  expect(await fromBottom(page)).toBeGreaterThan(100);
});

const shots = process.env.SHOTS;

test("log preview screenshots", async ({ page }) => {
  test.skip(!shots, "SHOTS not set");
  await mockPost(`fs/log?bytes=${String(38 * MiB)}`);
  await page.setViewportSize({ width: 1400, height: 900 });
  await openApp(page);
  await openThread(page, "s-1");
  const shot = async (name: string) => {
    for (const scheme of ["dark", "light"] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await page.waitForTimeout(250);
      await page
        .getByTestId("shell-pane")
        .filter({ has: file(page) })
        .screenshot({ path: `${shots ?? ""}/${name}-${scheme}.png` });
    }
  };
  await openFile(page, "logs/daemon.log");
  await expect(rows(page).getByTestId("file-log-row").first()).toBeVisible();
  await shot("log");
  await file(page).getByTestId("file-log-filter-error").click();
  await expect(rows(page).getByTestId("file-log-row")).toHaveCount(5);
  await shot("log-error");
  await openFile(page, "logs/test-run.txt");
  await expect(rows(page).getByTestId("file-log-row").last()).toContainText("Duration");
  await shot("ansi");
  await openFile(page, "logs/big.log");
  await expect(file(page).getByTestId("file-truncated-start")).toBeVisible();
  await expect(rows(page).getByTestId("file-log-row").last()).toContainText("· the end");
  await shot("log-tail");
});
