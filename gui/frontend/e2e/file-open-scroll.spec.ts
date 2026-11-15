import { expect, test, type Page } from "@playwright/test";
import { CF, openApp, resetMock } from "./fixtures";
import { openThread } from "./shell";

/**
 * Where a long file (the library's virtualizer) opens (docs/notes/file-tab-large-file-scroll.md).
 * Each test is a fresh page, so the JSON grammar is not loaded yet: the file's first render waits
 * for the highlighter, the case that opened it at its end. docs/huge.json is the mock's 1.1 MB
 * fixture over the 1 MiB read cap, so it shows as source under the "Showing the first 1 MiB"
 * notice. Every check polls until the rows are drawn: nothing is timed.
 */

const file = (page: Page) => page.getByTestId("file-tab");

async function openHuge(page: Page, line?: number): Promise<void> {
  await openApp(page);
  await openThread(page, "s-1");
  const target = JSON.stringify({ project: "repo-cf", base: CF, path: "docs/huge.json", ...(line ? { line } : {}) });
  await page.evaluate(`__cfModule("/src/stores/filePanel.ts").then((m) => m.openFileInPanel("current", ${target}))`);
  await expect(file(page).getByTestId("file-truncated")).toBeVisible();
  await expect(file(page).getByTestId("file-code")).toHaveAttribute("data-virtual", "");
}

/** The first line on screen, where `at`'s row starts (a fraction of the scroller's height), and scrollTop; nulls before rows are drawn. */
async function view(page: Page, at?: number): Promise<{ first: number | null; at: number | null; top: number }> {
  return file(page)
    .getByTestId("file-code")
    .evaluate((box, at) => {
      const sc = box.firstElementChild as HTMLElement;
      const s = sc.getBoundingClientRect();
      const rows = [...(sc.querySelector("diffs-container")?.shadowRoot?.querySelectorAll<HTMLElement>("[data-line]:not([data-column-number])") ?? [])].map((r) => ({ n: Number(r.dataset.line), r: r.getBoundingClientRect() }));
      const shown = rows.filter(({ r }) => r.height > 0 && r.bottom > s.top + 1 && r.top < s.bottom - 1);
      const target = rows.find((r) => r.n === at && r.r.height > 0);
      return {
        first: shown.length ? Math.min(...shown.map((x) => x.n)) : null,
        at: target ? Math.round(((target.r.top - s.top) / s.height) * 100) / 100 : null,
        top: sc.scrollTop,
      };
    }, at);
}

test.beforeEach(async () => {
  await resetMock();
});

test("a long file opened with no line opens at its top, and a Refresh keeps the reader's place", async ({ page }) => {
  await openHuge(page);
  await expect.poll(async () => (await view(page)).first).toBe(1);
  expect((await view(page)).top).toBe(0);

  await file(page)
    .getByTestId("file-code")
    .evaluate((box) => {
      (box.firstElementChild as HTMLElement).scrollTop = 400_000;
    });
  await expect.poll(async () => (await view(page)).first).toBeGreaterThan(1000);
  const before = (await view(page)).first;
  await file(page).getByTestId("file-refresh").click();
  await expect.poll(async () => (await view(page)).first).toBe(before);
});

test("a long file opened at a line far down opens with that line a third down", async ({ page }) => {
  await openHuge(page, 30_000);
  await expect.poll(async () => (await view(page, 30_000)).at).toBeGreaterThan(0.2);
  expect((await view(page, 30_000)).at).toBeLessThan(0.45);
});
